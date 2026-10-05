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

/**
 * A room where the tick is DUE and yet nobody owes an answer, which is the state
 * both tests below are about.
 *
 * It takes `nameTheTick`, and that is a statement about the scheduling rule rather
 * than a convenience. Every time `nextTickAt` arms for is a moment somebody is due
 * at — see `askAt` in heartbeat.ts — so the two cannot be reached together by
 * moving stored state alone. What reaches it in production is a member REPORTING
 * between the arming and the firing: `updateMember` does not re-arm on that path,
 * so the alarm keeps the earlier time and arrives to find the answer already in.
 * Telling the alarm the tick is due is that, made deterministic.
 *
 * Forcing `lastTickAt` into the past used to do the job, and silently stopped: a
 * member whose report is newer than the last tick is simply not due, however long
 * ago that tick was, so the alarm found nothing due and never dispatched the
 * handler at all.
 */
const quietButDue = async (id: string) => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room(id, {
    members: [member({ memberId: "m_lead", roomRole: "lead", lastReportAt: Date.now() })],
  }));
  return env.SESSION.get(env.SESSION.idFromName(id));
};

const fireNamedTick = (stub: DurableObjectStub) =>
  runInDurableObject(stub, async (i: SessionDO) => {
    nameTheTick(i);
    await i.alarm();
  });

it("advances lastTickAt on every firing, so the alarm cannot spin", async () => {
  const stub = await quietButDue("qs_spin");
  await fireNamedTick(stub);

  const after = await rows(stub);
  expect(after.session!.lastTickAt).toBeGreaterThan(Date.now() - 1_000);
  // The next armed time is in the future, so no second firing is owed.
  await runInDurableObject(stub, async (_i: SessionDO, ctx) => {
    expect(await ctx.storage.getAlarm()).toBeGreaterThan(Date.now());
  });
});

it("writes no tick when nobody is due, but still re-arms", async () => {
  const stub = await quietButDue("qs_quiet");
  await fireNamedTick(stub);

  const after = await rows(stub);
  // The premise, asserted rather than assumed: the clock moved, so the handler ran
  // and "no tick" is its decision. Without this the two assertions below are also
  // satisfied by a firing that never dispatched the branch they are about.
  expect(after.session!.lastTickAt).toBeGreaterThan(Date.now() - 1_000);
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
 * Push `expiresAt` into the past, as a room does by outliving its TTL between two
 * firings. Raw rows, and the room stays OPEN: `#expireIfDue` is what closes it,
 * and this is the state the alarm finds before it has.
 */
const lapseRoom = (stub: DurableObjectStub, expiresAt: number) =>
  runInDurableObject(stub, async (_i: SessionDO, ctx) => {
    const s = await ctx.storage.get<Record<string, unknown>>("session");
    await ctx.storage.put("session", { ...s, expiresAt });
  });

/**
 * The expired room, and the only one of the three guards the ORDINARY path
 * reaches — no `nameTheTick` here, because nothing has to be told anything.
 *
 * `derivedDue` refuses a tick to a frozen or closed room, so those two guards are
 * on trial only when the alarm is told. An expired room is different: it is not
 * closed until `#expireIfDue` closes it, so `derivedDue` hands back BOTH names,
 * `dueNames` sorts them, and "heartbeat" sorts before "ttl". A firing delayed past
 * `expiresAt` therefore ran the tick first — appending and waking every watcher on
 * a room the very next iteration of that same loop closed. Members cannot answer
 * an expired room: every send into it is refused.
 */
it("writes no tick into a room past its TTL, which the alarm closes in the same firing", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_lapsed"));
  const stub = env.SESSION.get(env.SESSION.idFromName("qs_lapsed"));
  await ageRoom(stub);
  await lapseRoom(stub, Date.now() - 1_000);

  await runInDurableObject(stub, (i: SessionDO) => i.alarm());

  const after = await rows(stub);
  expect(after.events.filter((e) => e.type === "heartbeat")).toEqual([]);
  // The control for the line above, and the reason it is worth asserting: the
  // firing DID reach both handlers, so "no tick" is the guard's decision rather
  // than an alarm that never dispatched. A tick and an expiry in one log is the
  // room this test is about.
  expect(after.events.filter((e) => e.type === "session_expired")).toHaveLength(1);
});

/**
 * A room whose TTL is still ahead of it ticks as it always did, which is what says
 * the guard above refuses the lapsed room and not every room with a TTL. "appends
 * a tick from the server" is the same reading on the default expiry; this one puts
 * the expiry close enough to be the thing under test.
 *
 * The `>` / `>=` boundary itself is NOT pinned here, deliberately. `#expireIfDue`
 * acts only once `now` is past `expiresAt` and this guard matches it, but `alarm()`
 * reads its own clock, so no test outside the object can hold `now` equal to
 * `expiresAt` — and an assertion that cannot be made to fail for its own reason is
 * worth less than the comment saying why.
 */
it("still ticks a room whose expiry is ahead of it", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_before_expiry"));
  const stub = env.SESSION.get(env.SESSION.idFromName("qs_before_expiry"));
  await ageRoom(stub);
  await lapseRoom(stub, Date.now() + 30_000);

  await runInDurableObject(stub, (i: SessionDO) => i.alarm());

  const after = await rows(stub);
  expect(after.events.filter((e) => e.type === "heartbeat")).toHaveLength(1);
  expect(after.events.filter((e) => e.type === "session_expired")).toEqual([]);
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

// ---------------------------------------------------------------------------
// Arming. The tick is DERIVED, so nothing re-arms it on its own: while
// nextTickAt is null nothing is scheduled, and no alarm is left to notice the
// state that made it non-null. Every roster change that can flip that answer
// therefore has to re-arm after its write commits.
// ---------------------------------------------------------------------------

/**
 * The room shape the spec's own architecture diagram authors, and the one every
 * room using this feature has: no preset sets `reports: true`, so the manifest is
 * authored, and the role that answers is a JOINER'S seat rather than the
 * creator's.
 */
const joinerReports = roomManifest({
  roles: {
    coordinator: { can: ["send", "invite"], description: null, reports: false },
    helper: { can: ["send"], description: null, reports: true },
  },
  defaultRole: "helper",
  creatorRole: "coordinator",
  heartbeatOnMs: FIVE_MIN,
});

/**
 * `joinCodes: {}` on purpose. A code would be queued for retirement when the seat
 * fills the room, and `enqueue` arms the alarm for that queue, sooner than the TTL,
 * which is all these assertions compare the alarm with. That is how a `pair` room
 * masks a missing arming. A room with no code to retire queues nothing, so nothing
 * arms the alarm as a side effect and the arming has to be the seating's own.
 */
const swarm = (id: string, over = {}) =>
  session({
    id,
    manifest: joinerReports,
    joinCodes: {},
    members: [member({ memberId: "m_coord", roomRole: "coordinator", label: "coord@a" })],
    ...over,
  });

const helper = (memberId: string) =>
  member({ memberId, userId: "u_helper", roomRole: "helper", label: `${memberId}@b` });

const alarmAndExpiry = (stub: DurableObjectStub) =>
  runInDurableObject(stub, async (_i: SessionDO, ctx) => ({
    alarm: await ctx.storage.getAlarm(),
    expiresAt: (await ctx.storage.get<{ expiresAt: number }>("session"))!.expiresAt,
  }));

/**
 * **The regression test for this feature's headline behaviour.** Without the
 * arming, a room whose creator does not report never ticks at all: createSession
 * arms the TTL only, no later join arms the tick, and the next thing to touch the
 * alarm is the TTL firing, which closes the room.
 */
it("arms the tick when the member who answers it is seated", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(swarm("qs_seat_arms"));
  const stub = env.SESSION.get(env.SESSION.idFromName("qs_seat_arms"));

  // Nobody reports yet, so nextTickAt is null and only the TTL is armed.
  const before = await alarmAndExpiry(stub);
  expect(before.alarm).toBe(before.expiresAt);

  const seated = await store.seatMember("qs_seat_arms", helper("m_helper"), 0, Date.now());
  expect(seated.refused).toBe(null);

  // A cadence is minutes; the TTL is hours. The tick is now the sooner of the two.
  const after = await alarmAndExpiry(stub);
  expect(after.alarm).toBeLessThan(after.expiresAt);
  expect(after.alarm).toBeGreaterThan(Date.now());
});

/** addMember is the other way onto the roster — the creator's own seat, and #66's. */
it("arms the tick when a reporting member is added", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(swarm("qs_add_arms"));
  const stub = env.SESSION.get(env.SESSION.idFromName("qs_add_arms"));

  const before = await alarmAndExpiry(stub);
  expect(before.alarm).toBe(before.expiresAt);

  expect(await store.addMember("qs_add_arms", helper("m_added"))).toBe(true);

  const after = await alarmAndExpiry(stub);
  expect(after.alarm).toBeLessThan(after.expiresAt);
});

/**
 * **Finding 1, end to end through the real alarm.** The mixed roster: one member
 * reported a second ago, one has never answered. The overdue member forces a tick
 * now, and the question is what that firing leaves armed for the prompt member.
 *
 * Anchored on `lastTickAt` alone, this firing moved the clock past the prompt
 * member's deadline without asking it, and the next ask went to the fixed boundary
 * one whole cadence later — so the member was asked nearly two cadences after its
 * report in a room that declared one. The per-member rule keeps that deadline, so
 * the time left armed here is STRICTLY SOONER than a cadence from the firing.
 *
 * Read off `getAlarm()`, which is what `reArm()` actually wrote, so the unit rule
 * and the arming it drives are both on trial rather than just the former.
 */
it("leaves a prompt member's own deadline armed after an overdue member forced a tick", async () => {
  const store = new DurableObjectStore(env as never);
  const reportedAt = Date.now() - 1_000;
  await store.createSession(room("qs_mixed", {
    members: [
      member({ memberId: "m_prompt", roomRole: "lead", label: "prompt@a", lastReportAt: reportedAt }),
      member({
        memberId: "m_overdue", roomRole: "lead", label: "overdue@b",
        joinedAt: Date.now() - 20 * FIVE_MIN,
      }),
    ],
  }));
  const stub = env.SESSION.get(env.SESSION.idFromName("qs_mixed"));
  // The last tick was a cadence ago, so the overdue member's floor has come round.
  await runInDurableObject(stub, async (_i: SessionDO, ctx) => {
    const s = await ctx.storage.get<Record<string, unknown>>("session");
    await ctx.storage.put("session", { ...s, lastTickAt: Date.now() - FIVE_MIN });
  });

  const firedAt = Date.now();
  await runInDurableObject(stub, (i: SessionDO) => i.alarm());

  // The premise: a tick was written, and it was the overdue member that forced it.
  // The snapshot lists every seat the room asks rather than only the due ones (see
  // snapshotOf), so who was DUE is read off the silences — one member a second
  // behind, one twenty cadences behind.
  const after = await rows(stub);
  const tick = after.events.find((e) => e.type === "heartbeat");
  expect(tick, "no tick was written, so nothing below is about this firing").toBeDefined();
  const silences = Object.fromEntries(
    (tick!.payload as { members: { member_id: string; silent_for_seconds: number }[] })
      .members.map((r) => [r.member_id, r.silent_for_seconds]),
  );
  expect(silences.m_prompt).toBeLessThan(300);
  expect(silences.m_overdue).toBeGreaterThan(300);

  // **The line this test exists for.** One cadence after the REPORT, which is a
  // second before one cadence after this firing — not the boundary a whole cadence
  // further out.
  const armed = await alarmAndExpiry(stub);
  expect(armed.alarm).toBeLessThan(firedAt + FIVE_MIN);
  expect(armed.alarm).toBeGreaterThanOrEqual(reportedAt + FIVE_MIN);
});

/**
 * A thaw. nextTickAt refuses a frozen room, so a freeze leaves nothing armed for
 * the tick, and clearing frozenAt is the only thing that can put it back.
 *
 * The firing between the freeze and the thaw is setup, and it is here so that the
 * premise below holds either way. A freeze does not disarm anything by itself —
 * the alarm stays pointed at the tick time it already held — so it takes a firing,
 * refused by #tickIfDue and re-armed to the TTL alone, to reach the state this
 * starts from. freezeSession re-arms directly now and would reach it without the
 * firing, but then the premise, not the conclusion, would be what failed before
 * the fix, and a test should fail on the line it is about.
 */
it("arms the tick again when a frozen room is thawed", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_thaw"));
  const stub = env.SESSION.get(env.SESSION.idFromName("qs_thaw"));

  await store.freezeSession("qs_thaw", Date.now());
  await runInDurableObject(stub, (i: SessionDO) => i.alarm());
  const frozen = await alarmAndExpiry(stub);
  expect(frozen.alarm).toBe(frozen.expiresAt);

  await store.freezeSession("qs_thaw", null);

  const thawed = await alarmAndExpiry(stub);
  expect(thawed.alarm).toBeLessThan(thawed.expiresAt);
});

/**
 * The chain, end to end under real alarms: a room is created, the member that
 * answers is seated, the armed tick fires at the cadence, and the reply that
 * `progress` writes — a `lastReportAt` stamp — quietens the next one. Nothing
 * drove the feature this far before, which is why both the arming and the
 * refused reply shipped.
 */
it("arms, fires, and goes quiet once the seated member reports", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(swarm("qs_chain"));
  const stub = env.SESSION.get(env.SESSION.idFromName("qs_chain"));
  await store.seatMember("qs_chain", helper("m_helper"), 0, Date.now());

  // The tick is armed, and for the cadence rather than the TTL.
  const armed = await alarmAndExpiry(stub);
  expect(armed.alarm).toBeLessThan(armed.expiresAt);

  // Wait out one cadence, then let the armed alarm fire.
  await ageRoom(stub);
  await runInDurableObject(stub, (i: SessionDO) => i.alarm());

  const ticked = await rows(stub);
  const tick = ticked.events.find((e) => e.type === "heartbeat")!;
  expect(tick.fromMemberId).toBe("system");
  expect(tick.payload).toMatchObject({
    cadence_seconds: 300,
    // Only the seat the room asks. The coordinator reports nothing and is not listed.
    members: [{ member_id: "m_helper" }],
  });

  // The reply, as bellman_send type=progress writes it.
  await store.updateMember("qs_chain", "m_helper", { lastReportAt: Date.now() });
  // Make the NEXT tick due, so the alarm reaches #tickIfDue and the quiet is the
  // handler's decision rather than a firing that never happened.
  await runInDurableObject(stub, async (_i: SessionDO, ctx) => {
    const s = await ctx.storage.get<Record<string, unknown>>("session");
    await ctx.storage.put("session", { ...s, lastTickAt: Date.now() - FIVE_MIN });
  });
  await runInDurableObject(stub, (i: SessionDO) => i.alarm());

  const after = await rows(stub);
  expect(after.events.filter((e) => e.type === "heartbeat")).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Spec D10. "A member cannot report its way out of a frozen room, so none may
// be named silent in one. A freeze must cost nobody their standing."
// ---------------------------------------------------------------------------

/**
 * Age the room by `cadences`, as waiting that long with nobody reporting would.
 * Raw rows: no call produces this state, and `lastReportAt` is left unset so
 * `lastReport` falls back to `joinedAt`, which is the shape a member that has
 * never answered actually has.
 */
const ageBy = (stub: DurableObjectStub, cadences: number) =>
  runInDurableObject(stub, async (_i: SessionDO, ctx) => {
    const s = await ctx.storage.get<{ members: { joinedAt: number }[] }>("session");
    const ago = Date.now() - cadences * FIVE_MIN;
    await ctx.storage.put("session", {
      ...s,
      lastTickAt: ago,
      members: s!.members.map((m) => ({ ...m, joinedAt: ago })),
    });
  });

/** Who every tick in the log named silent, across all of them. */
const namedSilent = async (stub: DurableObjectStub) => {
  const after = await rows(stub);
  return after.events
    .filter((e) => e.type === "heartbeat")
    .flatMap((e) => (e.payload as { members: { member_id: string; silent: boolean }[] }).members)
    .filter((row) => row.silent)
    .map((row) => row.member_id);
};

/**
 * `#tickIfDue` honours D10's letter — no tick is written while the room is frozen
 * — but `silent_for_seconds` was measured from a stamp the freeze itself stopped
 * anybody from moving. A room frozen for an hour on a 5m cadence produced, on its
 * first tick after the thaw, `silent: true` for EVERY member: a measurement of the
 * freeze rather than of anyone's behaviour. That is the false silent D10 exists to
 * prevent, and #66's scribe acts on a member named quiet.
 */
/**
 * Let one cadence pass after a thaw with nobody reporting: the credited
 * `lastReportAt` and the clock move back together, which is what waiting looks
 * like from inside the record.
 *
 * The thaw's credit is what makes this necessary. Crediting every asked seat at
 * the thaw leaves nobody due, so the room is NOT owed a tick the moment it thaws
 * — a cadence has to pass before anyone is asked, which is the whole point of the
 * credit. Without this, the firing below finds nobody due and writes no tick, and
 * "nobody was named silent" is satisfied by a log with no ticks in it.
 */
const waitOneCadenceAfterTheThaw = (stub: DurableObjectStub) =>
  runInDurableObject(stub, async (_i: SessionDO, ctx) => {
    const s = await ctx.storage.get<{
      members: { lastReportAt?: number }[];
      lastTickAt?: number;
    }>("session");
    await ctx.storage.put("session", {
      ...s,
      lastTickAt: (s!.lastTickAt ?? Date.now()) - FIVE_MIN,
      members: s!.members.map((m) => ({
        ...m,
        lastReportAt: m.lastReportAt === undefined ? undefined : m.lastReportAt - FIVE_MIN,
      })),
    });
  });

it("names nobody silent on the first tick after a thaw", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_thaw_silent"));
  const stub = env.SESSION.get(env.SESSION.idFromName("qs_thaw_silent"));

  await store.freezeSession("qs_thaw_silent", Date.now());
  // The outage: well past the two cadences that make a member silent.
  await ageBy(stub, 12);
  await store.freezeSession("qs_thaw_silent", null);
  // One cadence of the thawed room, so the member is due and the tick asks it.
  await waitOneCadenceAfterTheThaw(stub);

  await runInDurableObject(stub, (i: SessionDO) => i.alarm());

  // The premise, asserted rather than assumed: a tick WAS written and it named
  // this member. Otherwise the line below reads an empty log and says nothing —
  // and that is what it did, because a thawed room owes no tick until a cadence
  // has passed in it.
  const after = await rows(stub);
  const tick = after.events.find((e) => e.type === "heartbeat");
  expect(tick, "no tick was written, so the silence below is not a measurement").toBeDefined();
  expect((tick!.payload as { members: { member_id: string }[] }).members.map((r) => r.member_id))
    .toEqual(["m_lead"]);

  // Twelve cadences of freeze and one of waiting, and the member is named but not
  // silent: the credit means only the one cadence it could have answered in counts.
  expect(await namedSilent(stub)).toEqual([]);
});

/**
 * The control for the case above, and it is the reason that one is worth running:
 * without it, "nobody was named silent" would also be satisfied by a tick that
 * never fires or a `silent` flag that is never set. Identical ageing, no freeze —
 * so this member HAS had twelve cadences to report in and has not.
 */
it("still names a member silent when no freeze explains the gap", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_genuine_silence"));
  const stub = env.SESSION.get(env.SESSION.idFromName("qs_genuine_silence"));

  await ageBy(stub, 12);
  await runInDurableObject(stub, (i: SessionDO) => i.alarm());

  expect(await namedSilent(stub)).toEqual(["m_lead"]);
});

/**
 * What the thaw buys: a full cadence before anyone is asked again. The stamp is
 * the whole mechanism, and this is the direct reading of it — the alarm is armed a
 * cadence out from the THAW rather than at a boundary dated from the outage, so
 * the room spends no wake and asks nobody until that cadence has run.
 *
 * Read off the armed time rather than by firing. Under the per-member rule the
 * credit leaves nobody due, so nothing is armed in the past and there is no firing
 * to inspect; a test that fired anyway would be reading a handler the alarm never
 * dispatched. The second half tells the alarm the tick is due, which is the only
 * way to put the handler's own decision on trial from here.
 */
it("gives a thawed room a fresh cadence before it asks again", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_thaw_fresh"));
  const stub = env.SESSION.get(env.SESSION.idFromName("qs_thaw_fresh"));

  await store.freezeSession("qs_thaw_fresh", Date.now());
  await ageBy(stub, 12);
  const thawedAt = Date.now();
  await store.freezeSession("qs_thaw_fresh", null);

  // A cadence out from the thaw, not from the twelve that went before it, and
  // sooner than the TTL — so it is the tick that is armed and not the expiry.
  const armed = await alarmAndExpiry(stub);
  expect(armed.alarm).toBeGreaterThanOrEqual(thawedAt + FIVE_MIN - 2_000);
  expect(armed.alarm).toBeLessThan(armed.expiresAt);

  // And asked now, the handler says nobody owes an answer yet.
  await fireNamedTick(stub);
  const after = await rows(stub);
  expect(after.events.filter((e) => e.type === "heartbeat")).toEqual([]);
  expect(after.session!.lastTickAt).toBeGreaterThan(Date.now() - 1_000);
});
