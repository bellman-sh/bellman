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
import { env, SELF, reset, abortAllDurableObjects, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { R2BlobStore } from "../src/blobs-r2.js";
import { OUTBOX_HANDLER, OUTBOX_SEQ, dueKey, outboxKey } from "../src/outbox.js";
import { ABANDONED_AFTER_MS } from "../src/presence.js";
import { DurableObjectStore, type RegistryDO, type SessionDO } from "../src/store-do.js";
import type { Session, SurfaceItem } from "../src/types.js";
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

/**
 * A room with a 60 s window and no join code, so a close queues nothing and arms nothing of its own. Its
 * sweep has already run: these cases are about the purge, and an unswept room owes the close-time sweep
 * as well, which the pool fires by itself the moment the room closes and which leaves the objects a case
 * puts in the bucket for the purge to find. The sweep's own cases say `blobsSwept: false`.
 */
const room = (id: string, over: Partial<Session> = {}) =>
  session({ id, joinCodes: {}, retainAfterCloseMs: WINDOW, blobsSwept: true, ...over });

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
  expect(await registryRows("qs_window"), "the registry lists it before: joined, org's, created").toEqual(
    ["um:u_jesse:qs_window", "uo:org_codenerd:qs_window", "us:u_jesse:qs_window"],
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

  expect(await store.schedulePurge("qs_legacy", Date.now(), "u_jesse")).toMatchObject({ ok: true });
  await runAlarm("qs_legacy");

  expect(await rowCount("qs_legacy")).toBe(0);
  expect(await store.getSession("qs_legacy")).toBeUndefined();
});

it("answers open for a room that has not closed, and arms and queues nothing", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_open"));
  const before = { alarm: await armedAlarm("qs_open"), rows: await rowCount("qs_open") };

  expect(await store.schedulePurge("qs_open", Date.now(), "u_jesse")).toEqual({ ok: false, reason: "open" });

  expect({ alarm: await armedAlarm("qs_open"), rows: await rowCount("qs_open") }).toEqual(before);
});

it("arms the purge at the time a delete asked for, files who asked, and purges then", async () => {
  const store = new DurableObjectStore(env as never);
  const { closedAt } = await closedRoom("qs_asked", { retainAfterCloseMs: null });
  // A close never clears an alarm: this one is the abandonment time the room had, months off, and it will
  // fire once and find nothing. A room kept until deleted is given no purge time.
  expect(await armedAlarm("qs_asked")).toBeGreaterThan(Date.now() + 80 * 24 * HOUR);
  const at = Date.now() + HOUR;

  expect(await store.schedulePurge("qs_asked", at, "u_jesse")).toEqual({ ok: true, purgeAt: at });

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

// A throwing alarm() is retried by the runtime a few times and then left, with nothing armed. A closed
// room past its window that nothing re-arms would sit there for good, so the one read every reader goes
// through points the alarm at the purge again when it finds the room in that state. The read does not
// run the purge: the alarm does, as it does for every other window.
it("re-arms the alarm when a read finds a closed room past its window with nothing armed, and leaves the purge to the alarm", async () => {
  const { store, closedAt } = await closedRoom("qs_given_up");
  await runInDurableObject(stubOf("qs_given_up"), (_i: SessionDO, ctx) => ctx.storage.deleteAlarm());
  expect(await armedAlarm("qs_given_up"), "the runtime gave up on it").toBeNull();
  setClock(closedAt + WINDOW);

  expect(await store.getSession("qs_given_up"), "read once, the room is served as any closed room is").toMatchObject({ closed: true });

  expect(await armedAlarm("qs_given_up"), "armed again, at the purge").toBe(closedAt + WINDOW);
  expect(await rowCount("qs_given_up"), "and the read purged nothing").toBeGreaterThan(0);
  await runAlarm("qs_given_up");
  expect(await rowCount("qs_given_up")).toBe(0);
});

it("arms nothing for a read of a closed room that is inside its window, or kept, or from before the window", async () => {
  const store = new DurableObjectStore(env as never);
  const inside = await closedRoom("qs_inside");
  await closedRoom("qs_kept_read", { retainAfterCloseMs: null });
  await store.createSession(room("qs_old_read", { closed: true, closedAt: null, retainAfterCloseMs: null }));
  for (const id of ["qs_inside", "qs_kept_read", "qs_old_read"]) {
    await runInDurableObject(stubOf(id), (_i: SessionDO, ctx) => ctx.storage.deleteAlarm());
  }
  setClock(inside.closedAt + WINDOW - 1); // the last millisecond inside the window

  for (const id of ["qs_inside", "qs_kept_read", "qs_old_read"]) {
    expect(await store.getSession(id), id).toMatchObject({ closed: true });
    expect(await armedAlarm(id), id).toBeNull();
  }
});

// ---------------------------------------------------------------------------
// What a purge owes the watchers of the room (#65, review M3)
// ---------------------------------------------------------------------------

const after = (ms: number) => new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), ms));
/** How many long polls the room object is holding. */
const waitersOf = (id: string) =>
  runInDurableObject(stubOf(id), (instance: SessionDO) => (instance as unknown as { waiters: unknown[] }).waiters.length);

// MemoryStore settles a poll that is waiting on a purged room with nothing. This object has to do the same, or the
// poll waits out its own timer on a room that is gone.
it("settles a poll that is waiting on the room when it is purged, and does not leave it to its own timer", async () => {
  const { store, closedAt } = await closedRoom("qs_polling");
  const cursor = (await runInDurableObject(stubOf("qs_polling"), (_i: SessionDO, ctx) => ctx.storage.get<number>("cursor"))) ?? 0;
  const waiting = store.waitForEvents("qs_polling", cursor, 120_000);
  waiting.catch(() => undefined); // a poll the object is aborted under is not what this case reports
  await vi.waitFor(async () => expect(await waitersOf("qs_polling"), "the poll is registered").toBe(1), { timeout: 2_000 });

  setClock(closedAt + WINDOW);
  await runAlarm("qs_polling");

  expect(await Promise.race([waiting, after(2_000)]), "settled with the purge, and not at its own timer").toEqual([]);
});

// A socket is the room's future, and a purged room has none. Left alone it stays attached to an empty object until its
// client gives up on it. The close is the ordinary 1000: nothing in the bridge's client reads a close code as "room gone"
// (src/room-socket.ts reconnects after any close and learns the room's state from the upgrade's answer or its poll), so the
// reason is for the developer reading the client's close event.
it("closes the sockets attached to the room when it is purged", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_socket"));
  const upgraded = await SELF.fetch("https://bellman.test/ws?session=qs_socket&cursor=0", {
    headers: { upgrade: "websocket", authorization: "Bearer qk_ws_test" },
  });
  expect(upgraded.status, "the upgrade is accepted while the room is open").toBe(101);
  const ws = upgraded.webSocket!;
  ws.accept();
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason })));
  await store.closeSession("qs_socket");
  const closedAt = (await store.getSession("qs_socket"))!.closedAt!;

  setClock(closedAt + WINDOW);
  await runAlarm("qs_socket");

  expect(await Promise.race([closed, after(2_000)])).toEqual({ code: 1000, reason: "room purged" });
});

// ---------------------------------------------------------------------------
// The sweep of unnamed objects at close (#65, D3)
// ---------------------------------------------------------------------------

/** The `appendEvent` a surface write makes for a `file` item naming `blobId`: the event and the row it commits with. */
function nameBlob(store: DurableObjectStore, roomId: string, blobId: string, bytes: number) {
  const item: SurfaceItem = {
    key: `file_${blobId}`, kind: "file", title: null, body: null, ends: null, placement: null,
    blob: { id: blobId, bytes, type: "text/plain", name: `${blobId}.txt` },
  };
  return store.appendEvent(
    roomId,
    { type: "surface", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: item, refId: null },
    { surface: { key: item.key, item } },
  );
}

/**
 * Swap a room's env for one whose bucket counts its listings and records its deletes, over the real
 * bucket: a listing is how the sweep looks, and a delete of one key is the sweep's where a delete of an
 * array of keys is the purge's (`R2BlobStore.delete` and `deleteAll`).
 */
async function watchBucket(id: string) {
  const seen = { lists: 0, deletes: [] as unknown[] };
  await runInDurableObject(stubOf(id), (instance: SessionDO) => {
    const holder = instance as unknown as { env: { BLOBS: R2Bucket } };
    const real = holder.env.BLOBS;
    const spy = {
      list: (...args: Parameters<R2Bucket["list"]>) => { seen.lists++; return real.list(...args); },
      delete: (...args: Parameters<R2Bucket["delete"]>) => { seen.deletes.push(args[0]); return real.delete(...args); },
    };
    holder.env = Object.create(holder.env, { BLOBS: { value: spy } });
  });
  return seen;
}

// Due the moment a room closes, so the pool fires it by itself and the case waits for it: nothing here
// runs the handler, which makes this the path production takes.
it("sweeps the objects no item names when a room closes, credits their bytes, and does not look again", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_swept", { blobsSwept: false }));
  await putObject("qs_swept", "b_named", 10);
  await putObject("qs_swept", "b_orphan", 30);
  await putObject("qs_swept", "b_other", 5);
  await store.chargeBlobBytes("qs_swept", 45);
  await nameBlob(store, "qs_swept", "b_named", 10);
  const seen = await watchBucket("qs_swept");

  await store.closeSession("qs_swept");
  const closedAt = (await store.getSession("qs_swept"))!.closedAt!;
  await vi.waitFor(async () => expect((await store.getSession("qs_swept"))!.blobsSwept).toBe(true), { timeout: 3_000 });

  expect((await blobs().list("qs_swept")).map((object) => object.id), "the named one is kept").toEqual(["b_named"]);
  expect((await store.getSession("qs_swept"))!.blobBytes, "and the room is credited the rest").toBe(10);
  await vi.waitFor(async () => expect(await armedAlarm("qs_swept"), "then only the purge is owed").toBe(closedAt + WINDOW), { timeout: 2_000 });

  const listed = seen.lists;
  await runAlarm("qs_swept");
  expect(seen.lists, "a second alarm has nothing to look at").toBe(listed);
  expect((await store.getSession("qs_swept"))!.blobBytes).toBe(10);
});

// A room closed with a window of nothing owes both at the same instant. The purge deletes every object
// and the record, so a sweep before it is work thrown away, and a sweep after it has no room to read: the
// purge wins. alarm() runs the names in the order the alphabet gives and "purge" sorts before "sweep", but
// a handler reads what it needs for itself rather than lean on that (see alarm()), so the order is turned
// round here, which is what a rename would do.
it("skips the sweep when the purge is due as well, and the purge deletes the objects in one batch", async () => {
  const store = new DurableObjectStore(env as never);
  // Closed an hour from now by its own record, so no alarm of the pool's can fire before the clock moves.
  const closedAt = Date.now() + HOUR;
  await store.createSession(room("qs_both", { closed: true, closedAt, retainAfterCloseMs: 0, blobsSwept: false }));
  await putObject("qs_both", "b_orphan", 3);
  const seen = await watchBucket("qs_both");
  await runInDurableObject(stubOf("qs_both"), (instance: SessionDO) => {
    const driver = (instance as unknown as { driver: { dueNow(now?: number): Promise<string[]> } }).driver;
    const real = driver.dueNow.bind(driver);
    driver.dueNow = async (now) => (await real(now)).sort().reverse();
  });

  setClock(closedAt);
  await runAlarm("qs_both");

  expect(await store.getSession("qs_both")).toBeUndefined();
  expect(await blobs().list("qs_both")).toEqual([]);
  expect(
    seen.deletes.map((keys) => Array.isArray(keys)),
    "one batch delete, the purge's, and none of a single object, which is the sweep's",
  ).toEqual([true]);
});

// Two firings of the sweep that list the same objects both free the same bytes. The room is credited
// for them once, by whichever commits first.
it("credits the freed bytes once when two sweeps overlap", async () => {
  const store = new DurableObjectStore(env as never);
  const closedAt = Date.now() + HOUR; // out of the pool's reach until the clock moves
  await store.createSession(room("qs_overlap", { closed: true, closedAt, retainAfterCloseMs: null, blobsSwept: false }));
  await runInDurableObject(stubOf("qs_overlap"), async (_i: SessionDO, ctx) => {
    await ctx.storage.put("session", { ...(await ctx.storage.get<object>("session")), blobBytes: 45 });
  });
  await putObject("qs_overlap", "b_orphan", 30);
  await putObject("qs_overlap", "b_other", 5);

  setClock(closedAt);
  await Promise.all([runAlarm("qs_overlap"), runAlarm("qs_overlap")]);

  expect((await store.getSession("qs_overlap"))!.blobBytes).toBe(10);
  expect(await blobs().list("qs_overlap")).toEqual([]);
});

// ---------------------------------------------------------------------------
// A dropped alarm, and what the runtime does not say about it (#65, review I1 and M7 i)
// ---------------------------------------------------------------------------

/** Swap a room's env for one whose bucket refuses its next `refusals` deletes and lists the real one (see the purge case above). */
async function refuseDeletes(id: string, refusals: number) {
  await runInDurableObject(stubOf(id), (instance: SessionDO) => {
    const holder = instance as unknown as { env: { BLOBS: R2Bucket } };
    const real = holder.env.BLOBS;
    const flaky = {
      list: (...args: Parameters<R2Bucket["list"]>) => real.list(...args),
      delete: async (...args: Parameters<R2Bucket["delete"]>) => {
        if (refusals-- > 0) throw new Error("R2 is unavailable");
        return real.delete(...args);
      },
    };
    holder.env = Object.create(holder.env, { BLOBS: { value: flaky } });
  });
}

// A throwing alarm() is retried a few times and then left, with nothing armed. A room kept until deleted owes the sweep
// and nothing else, so no purge is ever due to bring a read back to it: the read that finds the sweep due re-arms for it
// as it does for the purge, and leaves the sweep to the alarm. A room with a window owes the purge as well, later, and
// the read re-arms for the earlier of the two: the sweep.
it.each([
  ["a kept room's", "qs_sweep_lost_kept", null],
  ["a room's whose window has not run out", "qs_sweep_lost_window", WINDOW],
])("re-arms the alarm when a read finds %s sweep due with nothing armed, and leaves the sweep to the alarm", async (_name, id, window) => {
  const store = new DurableObjectStore(env as never);
  // Closed an hour from now by its own record, so no alarm of the pool's can fire before the clock moves.
  const closedAt = Date.now() + HOUR;
  await store.createSession(room(id, { closed: true, closedAt, retainAfterCloseMs: window, blobsSwept: false }));
  await putObject(id, "b_orphan", 30);
  await runInDurableObject(stubOf(id), (_i: SessionDO, ctx) => ctx.storage.deleteAlarm());
  expect(await armedAlarm(id), "the runtime gave up on it").toBeNull();
  setClock(closedAt);

  expect(await store.getSession(id), "read once, the room is served as any closed room is").toMatchObject({ closed: true });

  expect(await armedAlarm(id), "armed again, at the sweep").toBe(closedAt);
  expect(await blobs().list(id), "and the read swept nothing").toHaveLength(1);
  await runAlarm(id);
  expect(await blobs().list(id)).toEqual([]);
  expect((await store.getSession(id))!.blobsSwept).toBe(true);
});

// "A delete that fails throws before the record is touched, so `blobsSwept` stays false and the next firing starts
// again" (#sweep). The sweep that failed is not recorded as done, and the one after it does the whole of it.
it("leaves blobsSwept false when a delete of the sweep throws, and the next firing starts the sweep again", async () => {
  const store = new DurableObjectStore(env as never);
  const closedAt = Date.now() + HOUR;
  await store.createSession(room("qs_sweep_flaky", { closed: true, closedAt, retainAfterCloseMs: null, blobsSwept: false }));
  await runInDurableObject(stubOf("qs_sweep_flaky"), async (_i: SessionDO, ctx) => {
    await ctx.storage.put("session", { ...(await ctx.storage.get<object>("session")), blobBytes: 45 });
  });
  await putObject("qs_sweep_flaky", "b_orphan", 30);
  await putObject("qs_sweep_flaky", "b_other", 5);
  await refuseDeletes("qs_sweep_flaky", 1);
  const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

  try {
    setClock(closedAt);
    await expect(runAlarm("qs_sweep_flaky")).rejects.toThrow("R2 is unavailable");
    expect(await store.getSession("qs_sweep_flaky"), "nothing is recorded as done").toMatchObject({ blobsSwept: false, blobBytes: 45 });
    expect(await blobs().list("qs_sweep_flaky"), "and nothing was removed").toHaveLength(2);

    await runAlarm("qs_sweep_flaky");

    expect(await store.getSession("qs_sweep_flaky")).toMatchObject({ blobsSwept: true, blobBytes: 10 });
    expect(await blobs().list("qs_sweep_flaky")).toEqual([]);
  } finally {
    quiet.mockRestore();
  }
});

// The runtime says nothing of which object it gave up on. The line alarm() writes before it rethrows is the one record
// of the room and the handler, and the rethrow is what lets the runtime retry.
it("names the room and the handler in the log when a handler throws, and still throws", async () => {
  const store = new DurableObjectStore(env as never);
  const closedAt = Date.now() + HOUR;
  await store.createSession(room("qs_logged", { closed: true, closedAt, retainAfterCloseMs: null, blobsSwept: false }));
  await putObject("qs_logged", "b_orphan", 3);
  await refuseDeletes("qs_logged", 1);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});

  try {
    setClock(closedAt);
    await expect(runAlarm("qs_logged"), "the alarm still throws, for the runtime to retry").rejects.toThrow("R2 is unavailable");
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/"sweep".*qs_logged/),
      expect.objectContaining({ message: "R2 is unavailable" }),
    );
  } finally {
    log.mockRestore();
  }
  expect(await store.getSession("qs_logged")).toMatchObject({ blobsSwept: false });
});
