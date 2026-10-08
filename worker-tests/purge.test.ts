/**
 * The purge of a closed room (#65) on the real objects: a derived alarm on the room's own object that
 * deletes the bytes, tells the registry and the audit log, and only then empties the room.
 *
 * The clock is the harness here. This pool fires a due alarm by itself, so the cases keep every alarm
 * they depend on in the real future and move only `Date`, which the room reads, past it; then they run
 * the handler when asked, the way alarms.test.ts does. The one case that drives the pool's own alarm
 * (`runDurableObjectAlarm`) is the first, for the end-to-end path.
 */
import { it, expect, vi, afterEach } from "vitest";
import { env, reset, abortAllDurableObjects, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { R2BlobStore } from "../src/blobs-r2.js";
import { OUTBOX_HANDLER, OUTBOX_SEQ, dueKey, outboxKey } from "../src/outbox.js";
import { ABANDONED_AFTER_MS } from "../src/presence.js";
import { DurableObjectStore, type RegistryDO, type SessionDO } from "../src/store-do.js";
import type { Session } from "../src/types.js";
import { member, session } from "../tests/helpers/fixtures.js";

afterEach(async () => {
  vi.useRealTimers();
  await reset();
  await abortAllDurableObjects();
});

const WINDOW = 60_000;
const HOUR = 60 * 60 * 1000;

const stubOf = (id: string) => env.SESSION.get(env.SESSION.idFromName(id));
const registry = () => env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
const auditOf = (org: string) => env.AUDIT.get(env.AUDIT.idFromName(org));
const blobs = () => new R2BlobStore((env as unknown as { BLOBS: R2Bucket }).BLOBS);
const meta = (bytes: number) => ({ bytes, type: "text/plain", name: "a.txt", by: "m_creator", at: 1_700_000_000_000 });
const putObject = (room: string, id: string, bytes = 3) =>
  blobs().put(room, id, new Uint8Array(bytes).buffer as ArrayBuffer, meta(bytes));

/** A room with a 60 s window and no join code, so a close queues nothing and arms nothing of its own. */
const room = (id: string, over: Partial<Session> = {}) =>
  session({ id, joinCodes: {}, retainAfterCloseMs: WINDOW, ...over });

/** The object's one alarm, or null when none is scheduled. */
const armedAlarm = (id: string) => runInDurableObject(stubOf(id), (_i: SessionDO, ctx) => ctx.storage.getAlarm());
/** How many rows the object holds. */
const rowCount = (id: string) =>
  runInDurableObject(stubOf(id), async (_i: SessionDO, ctx) => (await ctx.storage.list()).size);
/** The handler, run when asked. The runtime's own firing is the first case's. */
const runAlarm = (id: string) => runInDurableObject(stubOf(id), (instance: SessionDO) => instance.alarm());
/** Every key the registry holds that names this room: the creator and joined indexes. */
const registryRows = (id: string) =>
  runInDurableObject(registry(), async (_i: RegistryDO, ctx) =>
    [...(await ctx.storage.list()).keys()].filter((key) => key.endsWith(`:${id}`)));
/** What an org's stream holds for this room. */
const filed = async (org: string, id: string) =>
  (await auditOf(org).recent(100)).filter((entry) => entry.sessionId === id);
/** Move `Date`, which the room reads, and nothing else: no timer is faked, so no RPC waits on one. */
const setClock = (at: number) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
};

/** A room created and closed, with its close time as the record carries it. */
async function closedRoom(id: string, over: Partial<Session> = {}) {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room(id, over));
  await store.closeSession(id);
  return { store, closedAt: (await store.getSession(id))!.closedAt! };
}

it("purges a closed room when its window has run out, and a second alarm finds nothing to do", async () => {
  const { store, closedAt } = await closedRoom("qs_window");
  await putObject("qs_window", "b_one");
  expect(await armedAlarm("qs_window"), "the purge is armed from the close").toBe(closedAt + WINDOW);
  expect(await registryRows("qs_window"), "the registry lists it before").toEqual(
    ["um:u_jesse:qs_window", "us:u_jesse:qs_window"],
  );

  setClock(closedAt + WINDOW); // the window's last millisecond is the first that purges
  expect(await runDurableObjectAlarm(stubOf("qs_window"))).toBe(true);

  expect(await rowCount("qs_window"), "the object holds nothing").toBe(0);
  expect(await armedAlarm("qs_window"), "and nothing is armed").toBeNull();
  expect(await registryRows("qs_window")).toEqual([]);
  expect(await blobs().list("qs_window")).toEqual([]);
  expect(await filed("org_codenerd", "qs_window")).toMatchObject([{ action: "room_purged", actorUserId: "system" }]);
  expect(await store.getSession("qs_window")).toBeUndefined();

  await runAlarm("qs_window");
  expect(await rowCount("qs_window")).toBe(0);
  expect(await armedAlarm("qs_window")).toBeNull();
  expect(await filed("org_codenerd", "qs_window"), "one entry, not two").toHaveLength(1);
});

// An alarm that is armed when the purge runs is not the one consumed by running it: an outbox backstop,
// or a window that was asked past. Called on the instance the alarm is not consumed, so this is the case
// where something has to leave the object quiet. On this runtime that is `deleteAll()` itself, measured,
// and the purge's `deleteAlarm()` is redundant: removing it leaves this green. What the case pins is the
// outcome, that a purged room arms nothing, which an alarm armed after the wipe would break.
it("clears an alarm that is still armed when it empties the object", async () => {
  const { closedAt } = await closedRoom("qs_armed");
  await runInDurableObject(stubOf("qs_armed"), (_i: SessionDO, ctx) => ctx.storage.setAlarm(closedAt + HOUR));

  setClock(closedAt + WINDOW);
  await runAlarm("qs_armed");

  expect(await rowCount("qs_armed")).toBe(0);
  expect(await armedAlarm("qs_armed")).toBeNull();
});

// Review Focus 1. The bytes are the one step that can be refused for a reason outside this object, and
// they go first: a refusal stops everything after it, so the record is still there with its objects, and
// the next wake does the whole thing again. Nothing may empty the record while objects remain.
//
// The seam is the instance's env, swapped for one whose bucket refuses its first delete. TypeScript's
// `private` is a compile-time check and a field is not on the RPC surface, so nothing in the production
// class exists for the purpose. The list is the real one: the objects are really there.
it("keeps the record while an object is left in the bucket, and purges from the start on the next wake", async () => {
  const { store, closedAt } = await closedRoom("qs_flaky");
  for (const id of ["b_one", "b_two", "b_three"]) await putObject("qs_flaky", id);
  let refusals = 1;
  await runInDurableObject(stubOf("qs_flaky"), (instance: SessionDO) => {
    const real = (instance as unknown as { env: { BLOBS: R2Bucket } }).env.BLOBS;
    const flaky = {
      list: (...args: Parameters<R2Bucket["list"]>) => real.list(...args),
      delete: async (...args: Parameters<R2Bucket["delete"]>) => {
        if (refusals-- > 0) throw new Error("R2 is unavailable");
        return real.delete(...args);
      },
    };
    (instance as unknown as { env: unknown }).env = Object.create(
      (instance as unknown as { env: object }).env, { BLOBS: { value: flaky } },
    );
  });

  setClock(closedAt + WINDOW);
  await expect(runDurableObjectAlarm(stubOf("qs_flaky"))).rejects.toThrow("R2 is unavailable");

  expect(await store.getSession("qs_flaky"), "the record survives").toMatchObject({ id: "qs_flaky", closed: true });
  expect(await blobs().list("qs_flaky"), "with every object it names").toHaveLength(3);
  expect(await registryRows("qs_flaky"), "and in the registry").not.toEqual([]);
  expect(await filed("org_codenerd", "qs_flaky"), "and no entry says it is gone").toEqual([]);

  await runAlarm("qs_flaky");

  expect(await rowCount("qs_flaky")).toBe(0);
  expect(await blobs().list("qs_flaky")).toEqual([]);
  expect(await registryRows("qs_flaky")).toEqual([]);
  expect(await filed("org_codenerd", "qs_flaky")).toHaveLength(1);
});

// The entry is filed before the object empties and the object empties after, so a purge can die in
// between. Its retry files the entry again, and the intent id it carries is what makes that one entry:
// the audit stream is a different object, and nothing about the purge empties it.
it("files one entry for an org when a purge dies after filing it and is run again", async () => {
  const { closedAt } = await closedRoom("qs_retry");
  await runInDurableObject(stubOf("qs_retry"), (_i: SessionDO, ctx) => {
    const real = ctx.storage.deleteAll.bind(ctx.storage);
    let refused = false;
    Object.defineProperty(ctx.storage, "deleteAll", {
      configurable: true,
      value: async () => {
        if (!refused) { refused = true; throw new Error("storage is unavailable"); }
        return real();
      },
    });
  });

  setClock(closedAt + WINDOW);
  await expect(runAlarm("qs_retry")).rejects.toThrow("storage is unavailable");
  expect(await filed("org_codenerd", "qs_retry"), "filed once already").toHaveLength(1);

  await runAlarm("qs_retry");

  expect(await rowCount("qs_retry")).toBe(0);
  expect(await filed("org_codenerd", "qs_retry"), "and once after the retry").toHaveLength(1);
});

// Review Focus 5. A row written before the window existed is closed and carries none of the new
// fields. It is kept: no alarm is armed for it, nothing is purged however long it sits, it still answers
// a read, and a delete is what reaches it.
it("keeps a row closed before the window existed, and lets a delete reach it", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_legacy", { retainAfterCloseMs: null }));
  await runInDurableObject(stubOf("qs_legacy"), async (_i: SessionDO, ctx) => {
    const { closedAt, retainAfterCloseMs, purgeAt, blobsSwept, ...legacy } =
      (await ctx.storage.get<Record<string, unknown>>("session"))!;
    expect([closedAt, retainAfterCloseMs, purgeAt, blobsSwept], "the fixture row had all four").not.toContain(undefined);
    await ctx.storage.put("session", { ...legacy, closed: true });
    await ctx.storage.deleteAlarm();
  });

  setClock(Date.now() + 365 * 24 * HOUR);
  await runAlarm("qs_legacy");

  expect(await armedAlarm("qs_legacy"), "nothing is armed after a re-arm").toBeNull();
  expect(await store.getSession("qs_legacy")).toMatchObject({
    closed: true, closedAt: null, retainAfterCloseMs: null, purgeAt: null, blobsSwept: false,
  });

  expect(await store.schedulePurge("qs_legacy", Date.now(), "u_jesse")).toBe("scheduled");
  await runAlarm("qs_legacy");

  expect(await rowCount("qs_legacy")).toBe(0);
  expect(await store.getSession("qs_legacy")).toBeUndefined();
});

it("answers open for a room that has not closed, and arms and queues nothing", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_open"));
  const before = { alarm: await armedAlarm("qs_open"), rows: await rowCount("qs_open") };

  expect(await store.schedulePurge("qs_open", Date.now(), "u_jesse")).toBe("open");

  expect({ alarm: await armedAlarm("qs_open"), rows: await rowCount("qs_open") }).toEqual(before);
});

it("arms the purge at the time a delete asked for, files who asked, and purges then", async () => {
  const store = new DurableObjectStore(env as never);
  const { closedAt } = await closedRoom("qs_asked", { retainAfterCloseMs: null });
  // A close never clears an alarm: this one is the abandonment time the room had, months off, and it will
  // fire once and find nothing. A room kept until deleted is given no purge time.
  expect(await armedAlarm("qs_asked")).toBeGreaterThan(Date.now() + 80 * 24 * HOUR);
  const at = Date.now() + HOUR;

  expect(await store.schedulePurge("qs_asked", at, "u_jesse")).toBe("scheduled");

  await vi.waitFor(async () => expect(await armedAlarm("qs_asked")).toBe(at), { timeout: 2_000 });
  expect(await store.getSession("qs_asked"), "an hour out, the room is still there").toBeDefined();
  expect(await filed("org_codenerd", "qs_asked")).toMatchObject([{ action: "room_deleted", actorUserId: "u_jesse" }]);

  setClock(Math.max(at, closedAt));
  await runAlarm("qs_asked");

  expect(await rowCount("qs_asked")).toBe(0);
  expect((await filed("org_codenerd", "qs_asked")).map((entry) => entry.action)).toEqual(["room_deleted", "room_purged"]);
});

// The purge is armed from the close. Nothing else re-arms a room whose close queued nothing: a code to
// retire and an audit row for an org are what queue, and a room with neither leaves the alarm pointing
// where it did, which for an active member is the abandonment time 90 days out.
it("arms the purge at the close, when the close queues nothing of its own", async () => {
  const store = new DurableObjectStore(env as never);

  await store.createSession(room("qs_by_close"));
  expect(await armedAlarm("qs_by_close"), "armed at the abandonment time before").toBeGreaterThan(Date.now() + 80 * 24 * HOUR);
  await store.closeSession("qs_by_close");
  expect(await armedAlarm("qs_by_close")).toBe((await store.getSession("qs_by_close"))!.closedAt! + WINDOW);

  // A member who left and has no org: nobody to audit, no code, and no alarm armed at all before.
  await store.createSession(room("qs_by_empty", { members: [member({ leftAt: Date.now(), orgId: null })] }));
  expect(await armedAlarm("qs_by_empty")).toBeNull();
  expect(await store.closeSessionIfEmpty("qs_by_empty")).toBe(true);
  expect(await armedAlarm("qs_by_empty")).toBe((await store.getSession("qs_by_empty"))!.closedAt! + WINDOW);
});

it("arms the purge when a read finds the room abandoned and closes it", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_lazy"));
  // 90 days and a millisecond on: the alarm for it is months off, so this read is what closes the room.
  setClock(Date.now() + ABANDONED_AFTER_MS + 1);

  const closed = (await store.getSession("qs_lazy"))!;

  expect(closed.closed).toBe(true);
  expect(await armedAlarm("qs_lazy")).toBe(closed.closedAt! + WINDOW);
});

// What the outbox owes is queued in the storage the purge empties. A row that has not been delivered
// when the purge falls due goes first, and one that will not deliver holds the purge back; the entry for
// a delete, or a removal, would otherwise be emptied with the rest.
const seedOutbox = (id: string, row: { id: string; kind: string; payload: unknown }) =>
  runInDurableObject(stubOf(id), (_i: SessionDO, ctx) =>
    ctx.storage.put<unknown>({
      [outboxKey(0)]: { ...row, attempts: 0 },
      [OUTBOX_SEQ]: 0,
      // Not due when the purge is, so only the purge's own look at the queue can deliver it.
      [dueKey(OUTBOX_HANDLER)]: Date.now() + 24 * HOUR,
    }));

it("delivers what the outbox still owes before it empties the object", async () => {
  const { closedAt } = await closedRoom("qs_owed");
  await seedOutbox("qs_owed", {
    id: "owed-1", kind: "audit",
    payload: { at: 1, orgId: "org_codenerd", sessionId: "qs_owed", actorUserId: "u_jesse", action: "member_left", detail: {} },
  });

  setClock(closedAt + WINDOW);
  await runAlarm("qs_owed");

  expect(await rowCount("qs_owed")).toBe(0);
  expect((await filed("org_codenerd", "qs_owed")).map((entry) => entry.action).sort()).toEqual(["member_left", "room_purged"]);
});

it("holds the purge back while a queued row will not deliver, and purges once it is gone", async () => {
  const store = new DurableObjectStore(env as never);
  const { closedAt } = await closedRoom("qs_stuck");
  await seedOutbox("qs_stuck", { id: "stuck-1", kind: "mystery", payload: {} });

  setClock(closedAt + WINDOW);
  await expect(runAlarm("qs_stuck")).rejects.toThrow(/outbox still holds rows/);
  expect(await store.getSession("qs_stuck"), "the room is kept, with what it owes").toMatchObject({ closed: true });

  await runInDurableObject(stubOf("qs_stuck"), (_i: SessionDO, ctx) => ctx.storage.delete(outboxKey(0)));
  await runAlarm("qs_stuck");

  expect(await rowCount("qs_stuck")).toBe(0);
});
