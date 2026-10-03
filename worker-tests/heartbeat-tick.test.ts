/**
 * The heartbeat tick, which only a real Durable Object can fire. The pure rules
 * it runs are unit-tested in tests/heartbeat.test.ts; this file is about the
 * alarm: that it fires, that it advances its own clock, and that it writes
 * nothing into a room that cannot answer.
 */
import { it, expect, afterEach } from "vitest";
import { env, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { DurableObjectStore, type SessionDO } from "../src/store-do.js";
import { member, roomManifest, session } from "../tests/helpers/fixtures.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

const FIVE_MIN = 300_000;

const manifest = roomManifest({
  roles: {
    lead: { can: ["send"], description: null, reports: true },
    observer: { can: [], description: null, reports: false },
  },
  defaultRole: "observer",
  creatorRole: "lead",
  heartbeatOnMs: FIVE_MIN,
});

const room = (id: string, over = {}) =>
  session({
    id,
    manifest,
    joinCodes: {},
    members: [member({ memberId: "m_lead", roomRole: "lead", label: "lead@a" })],
    ...over,
  });

const rows = (stub: DurableObjectStub) =>
  runInDurableObject(stub, async (_i: SessionDO, ctx) => ({
    session: await ctx.storage.get<{ lastTickAt?: number; frozenAt: number | null }>("session"),
    events: [...(await ctx.storage.list<{ type: string; payload: unknown; fromMemberId: string }>(
      { prefix: "e:" },
    )).values()],
  }));

/**
 * Make the tick due: the last firing, and the moment `m_lead` joined, a full
 * cadence ago, with no report since. Raw rows, because this is a state a room
 * reaches by waiting and no call produces it. `dueMembers` reads member report
 * times and not `lastTickAt`, so moving the clock alone leaves nobody to ask.
 */
const ageRoom = (stub: DurableObjectStub) =>
  runInDurableObject(stub, async (_i: SessionDO, ctx) => {
    const s = await ctx.storage.get<{ members: { joinedAt: number }[] }>("session");
    const ago = Date.now() - FIVE_MIN;
    await ctx.storage.put("session", {
      ...s,
      lastTickAt: ago,
      members: s!.members.map((m) => ({ ...m, joinedAt: ago })),
    });
  });

/**
 * Make the alarm name the tick whatever the room's state says, as it would if the
 * list of what is due had been computed before a freeze or a close landed. A
 * frozen or closed room derives no tick (nextTickAt is null for both), so the
 * ordinary path never reaches #tickIfDue's guard at all. This is the one way to
 * put the guard on trial.
 */
const nameTheTick = (i: SessionDO) => {
  (i as unknown as { driver: { dueNow(): Promise<string[]> } }).driver.dueNow =
    async () => ["heartbeat"];
};

/**
 * Review Focus 1. #tickIfDue mirrors #expireIfDue, which calls #writeEvent
 * DIRECTLY and so bypasses appendEvent's frozen guard. A naive copy writes a
 * tick into a frozen room and names members silent who cannot report out of it.
 * A freeze must cost nobody their standing.
 */
it("writes no tick into a frozen room", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_frozen"));
  await store.freezeSession("qs_frozen", Date.now());

  const stub = env.SESSION.get(env.SESSION.idFromName("qs_frozen"));
  await runInDurableObject(stub, (i: SessionDO) => i.alarm());

  const after = await rows(stub);
  expect(after.events.filter((e) => e.type === "heartbeat")).toEqual([]);
});

it("appends a tick from the server, never from a member", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_tick"));

  const stub = env.SESSION.get(env.SESSION.idFromName("qs_tick"));
  // A member that joined a full cadence ago and has reported nothing.
  await ageRoom(stub);
  await runInDurableObject(stub, (i: SessionDO) => i.alarm());

  const after = await rows(stub);
  const tick = after.events.find((e) => e.type === "heartbeat")!;
  expect(tick.fromMemberId).toBe("system");
  expect(tick.payload).toMatchObject({
    cadence_seconds: 300,
    members: [{ member_id: "m_lead", silent: false }],
  });
});

it("advances lastTickAt on every firing, so the alarm cannot spin", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_spin"));
  const stub = env.SESSION.get(env.SESSION.idFromName("qs_spin"));

  await runInDurableObject(stub, async (_i: SessionDO, ctx) => {
    const s = await ctx.storage.get<Record<string, unknown>>("session");
    await ctx.storage.put("session", { ...s, lastTickAt: Date.now() - 10 * FIVE_MIN });
  });
  await runInDurableObject(stub, (i: SessionDO) => i.alarm());

  const after = await rows(stub);
  expect(after.session!.lastTickAt).toBeGreaterThan(Date.now() - 1_000);
  // The next armed time is in the future, so no second firing is owed.
  await runInDurableObject(stub, async (_i: SessionDO, ctx) => {
    expect(await ctx.storage.getAlarm()).toBeGreaterThan(Date.now());
  });
});

it("writes no tick when nobody is due, but still re-arms", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_quiet", {
    members: [member({ memberId: "m_lead", roomRole: "lead", lastReportAt: Date.now() })],
  }));
  const stub = env.SESSION.get(env.SESSION.idFromName("qs_quiet"));
  // The tick is DUE, so the alarm reaches #tickIfDue; the one member reported just
  // now, so nobody owes an answer. Without this the alarm finds nothing due, never
  // dispatches the handler, and the assertions below pass on a branch not taken.
  await runInDurableObject(stub, async (_i: SessionDO, ctx) => {
    const s = await ctx.storage.get<Record<string, unknown>>("session");
    await ctx.storage.put("session", { ...s, lastTickAt: Date.now() - 10 * FIVE_MIN });
  });
  await runInDurableObject(stub, (i: SessionDO) => i.alarm());

  const after = await rows(stub);
  expect(after.events.filter((e) => e.type === "heartbeat")).toEqual([]);
  await runInDurableObject(stub, async (_i: SessionDO, ctx) => {
    expect(await ctx.storage.getAlarm()).toBeGreaterThan(Date.now());
  });
});

it("arms nothing for a room whose roles ask for no reports", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(session({ id: "qs_none", joinCodes: {} }));
  await runInDurableObject(
    env.SESSION.get(env.SESSION.idFromName("qs_none")),
    async (_i: SessionDO, ctx) => {
      // Only the TTL, which is the session's expiry and not a tick.
      const s = await ctx.storage.get<{ expiresAt: number }>("session");
      expect(await ctx.storage.getAlarm()).toBe(s!.expiresAt);
    },
  );
});

/**
 * The rollback property. The due time is DERIVED, so a build that does not know
 * the name does not compute it either — unlike a stored `due:` row, which an
 * older build never consumes and whose closing reArm() fires the alarm back to
 * back for good.
 */
it("stores no due row for the tick, so a rollback strands nothing", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_rollback"));
  const stub = env.SESSION.get(env.SESSION.idFromName("qs_rollback"));
  // A firing that writes a tick, so a row stored on the way through would exist to be found.
  await ageRoom(stub);
  await runInDurableObject(stub, (i: SessionDO) => i.alarm());

  await runInDurableObject(stub, async (_i: SessionDO, ctx) => {
    const due = [...(await ctx.storage.list({ prefix: "due:" })).keys()];
    expect(due).not.toContain("due:heartbeat");
  });
});

/**
 * The guard on trial. "writes no tick into a frozen room" above takes the ordinary
 * path, where nextTickAt already refuses a frozen room and the alarm never
 * dispatches the tick, so it passes whether or not #tickIfDue checks for itself.
 * Here the alarm is TOLD the tick is due and the member genuinely is, so the only
 * thing between this room and a tick is the guard.
 */
it("writes no tick into a frozen room even when the alarm names it", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_frozen_named"));
  const stub = env.SESSION.get(env.SESSION.idFromName("qs_frozen_named"));
  await ageRoom(stub);
  await store.freezeSession("qs_frozen_named", Date.now());

  await runInDurableObject(stub, async (i: SessionDO) => {
    nameTheTick(i);
    await i.alarm();
  });

  const after = await rows(stub);
  expect(after.events.filter((e) => e.type === "heartbeat")).toEqual([]);
});

it("writes no tick into a closed room even when the alarm names it", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_closed_named"));
  const stub = env.SESSION.get(env.SESSION.idFromName("qs_closed_named"));
  await ageRoom(stub);
  await store.closeSession("qs_closed_named");

  await runInDurableObject(stub, async (i: SessionDO) => {
    nameTheTick(i);
    await i.alarm();
  });

  const after = await rows(stub);
  expect(after.events.filter((e) => e.type === "heartbeat")).toEqual([]);
});

/**
 * The other half of "advances on every firing". The nobody-due path is covered
 * above; this is the firing that writes. The tick, the cursor and the clock go in
 * one put, so a second firing finds the next time in the future and asks nobody
 * again — a second tick here would mean the clock did not move with the first.
 */
it("advances lastTickAt on a firing that writes a tick, so the next one is quiet", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_clock"));
  const stub = env.SESSION.get(env.SESSION.idFromName("qs_clock"));
  await ageRoom(stub);

  // The member reports nothing between the two firings.
  await runInDurableObject(stub, (i: SessionDO) => i.alarm());
  await runInDurableObject(stub, (i: SessionDO) => i.alarm());

  const after = await rows(stub);
  expect(after.events.filter((e) => e.type === "heartbeat")).toHaveLength(1);
  expect(after.session!.lastTickAt).toBeGreaterThan(Date.now() - 1_000);
  await runInDurableObject(stub, async (_i: SessionDO, ctx) => {
    expect(await ctx.storage.getAlarm()).toBeGreaterThan(Date.now());
  });
});

/**
 * Delivery is the existing one: #wake resolves held polls and sockets, and the
 * bridge does the rest. A tick that was stored and never woken anyone would reach
 * a heads-down member only on its next poll, which is the case it exists for.
 */
it("wakes a held poll with the tick", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_wake"));
  const stub = env.SESSION.get(env.SESSION.idFromName("qs_wake"));
  await ageRoom(stub);

  const waiting = store.waitForEvents("qs_wake", 0, 5_000);
  // Fire only once the poll is HELD. A tick that landed first would be read as
  // history by the poll and this would pass without #wake doing anything.
  const held = () =>
    runInDurableObject(stub, (i: SessionDO) => (i as unknown as { waiters: unknown[] }).waiters.length);
  for (let n = 0; n < 100 && (await held()) === 0; n++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(await held()).toBe(1);

  await runInDurableObject(stub, (i: SessionDO) => i.alarm());

  const woken = await waiting;
  expect(woken).toHaveLength(1);
  expect(woken[0]).toMatchObject({ type: "heartbeat", fromMemberId: "system" });
});
