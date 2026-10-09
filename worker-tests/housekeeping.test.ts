/**
 * The housekeeping handler, which only a real Durable Object can fire (#66). The rules it runs
 * are unit-tested in tests/housekeeping.test.ts; this file is about the alarm: that it is armed
 * for the soonest moment something is due, that a firing writes one proposal per due key and
 * remembers it, and that nothing is written into a room that cannot answer.
 *
 * `Date` is the only thing faked, as in purge.test.ts: the room reads it, and no timer is faked
 * so no RPC waits on one. The alarm is run when asked (`instance.alarm()`), the pool's own firing
 * being a race for an alarm armed in the real past.
 */
import { it, expect, vi, afterEach } from "vitest";
import { env, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { DurableObjectStore, type SessionDO } from "../src/store-do.js";
import { ABANDONED_AFTER_MS, abandonedAt } from "../src/presence.js";
import { publicEvent } from "../src/public-event.js";
import type { RoomManifest, Session, SessionEvent } from "../src/types.js";
import { member, roomManifest, session } from "../tests/helpers/fixtures.js";

afterEach(async () => {
  vi.useRealTimers();
  await reset();
  await abortAllDurableObjects();
});

const MIN = 60_000;
const HOUR = 60 * MIN;

type Thresholds = NonNullable<RoomManifest["housekeeping"]>;

/** Move `Date`, which the room reads, and nothing else. */
const setClock = (at: number) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
};

const stubOf = (id: string) => env.SESSION.get(env.SESSION.idFromName(id));
/** The object's one alarm, or null when none is scheduled. */
const armed = (id: string) => runInDurableObject(stubOf(id), (_i: SessionDO, ctx) => ctx.storage.getAlarm());
/** The handler, run when asked. */
const fire = (id: string) => runInDurableObject(stubOf(id), (instance: SessionDO) => instance.alarm());
/**
 * Name the handler whatever the room's state says, as the alarm would if the list of what is due
 * had been computed before a freeze or a close landed. A room the rules do not evaluate derives no
 * housekeeping time, so the ordinary path never reaches the handler's own checks: this is the one
 * way to put them on trial.
 */
const fireNamed = (id: string) =>
  runInDurableObject(stubOf(id), async (i: SessionDO) => {
    (i as unknown as { driver: { dueNow(): Promise<string[]> } }).driver.dueNow = async () => ["housekeep"];
    await i.alarm();
  });

const rows = (id: string) =>
  runInDurableObject(stubOf(id), async (_i: SessionDO, ctx) => ({
    session: await ctx.storage.get<Session>("session"),
    events: [...(await ctx.storage.list<SessionEvent>({ prefix: "e:" })).values()],
  }));
const proposals = async (id: string) => (await rows(id)).events.filter((e) => e.type === "housekeeping");

/** A room that declared housekeeping: a thresholds object, with every finding off unless a case turns it on. */
const room = (id: string, at: number, hk: Partial<Thresholds> = {}, over: Partial<Session> = {}) =>
  session({
    id,
    joinCodes: {},
    manifest: roomManifest({
      housekeeping: { quietAfterMs: 5 * MIN, answerWithinMs: null, idleAfterMs: null, repeatAfterMs: null, ...hk },
    }),
    members: [member({ memberId: "m_a", userId: "u_a", label: "a@x", joinedAt: at, lastSeenAt: at, lastSentAt: at })],
    ...over,
  });
const peerB = (at: number) =>
  member({ memberId: "m_b", userId: "u_b", label: "b@x", roomRole: "peer_b", joinedAt: at, lastSeenAt: at, lastSentAt: at });

const request = (by = "m_a") => ({
  type: "action_request" as const, fromMemberId: by, fromUserId: `u_${by.slice(2)}`, fromLabel: `${by.slice(2)}@x`,
  payload: { ask: "deploy" }, refId: null,
});
const answer = (cursor: number, by = "m_b") => ({
  type: "action_response" as const, fromMemberId: by, fromUserId: `u_${by.slice(2)}`, fromLabel: `${by.slice(2)}@x`,
  payload: { approved: true }, refId: String(cursor),
});
const message = (by = "m_a") => ({
  type: "message" as const, fromMemberId: by, fromUserId: `u_${by.slice(2)}`, fromLabel: `${by.slice(2)}@x`,
  payload: { text: "hi" }, refId: null,
});

// ---------------------------------------------------------------------------
// The firing
// ---------------------------------------------------------------------------

it("arms for the soonest threshold, writes one proposal when it passes, and arms a window after the raise", async () => {
  const T0 = Date.now();
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_quiet", T0));
  expect(await armed("qs_quiet"), "armed at the member's last send plus quiet_after").toBe(T0 + 5 * MIN);

  setClock(T0 + 5 * MIN);
  await fire("qs_quiet");

  const [event, ...rest] = await proposals("qs_quiet");
  expect(rest, "one proposal").toEqual([]);
  expect(event).toMatchObject({
    type: "housekeeping", fromMemberId: "system", fromUserId: "system", fromLabel: "bellman", refId: null,
    at: T0 + 5 * MIN,
    payload: { finding: "member_quiet", about: { member_id: "m_a" }, since: T0 + 5 * MIN, repeat: 1 },
  });
  expect(await armed("qs_quiet"), "armed a window after the raise").toBe(T0 + 10 * MIN);
});

it("is quiet until the next window, and raises again at the end of it, counting up", async () => {
  const T0 = Date.now();
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_window", T0));
  setClock(T0 + 5 * MIN);
  await fire("qs_window");
  expect(await proposals("qs_window")).toHaveLength(1);

  // A second run before the window ends writes nothing. It is the record of what was raised that
  // holds it back: the member is as quiet as ever, and without the record the same finding is due
  // again. Named, because the ordinary path would not even dispatch the handler, the alarm having
  // armed past this moment.
  setClock(T0 + 5 * MIN + 1_000);
  await fireNamed("qs_window");
  expect(await proposals("qs_window"), "a second run writes nothing").toHaveLength(1);

  // And at the end of the window it is raised again, counting up.
  setClock(T0 + 10 * MIN);
  await fire("qs_window");
  const all = await proposals("qs_window");
  expect(all.map((e) => (e.payload as { repeat: number }).repeat)).toEqual([1, 2]);
  expect(all[1].payload).toMatchObject({ since: T0 + 5 * MIN });
});

// A firing the alarm made early, which is what a member sending between the arming and the firing
// produces (an append re-arms nothing on that hot path), finds nothing due and nothing to forget.
// It writes nothing at all, not even the record unchanged.
it("writes nothing, not even the record, when nothing is due and nothing is to be forgotten", async () => {
  const T0 = Date.now();
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_early", T0));

  const puts = await runInDurableObject(stubOf("qs_early"), async (i: SessionDO, ctx) => {
    let n = 0;
    const real = ctx.storage.transaction.bind(ctx.storage);
    Object.defineProperty(ctx.storage, "transaction", {
      configurable: true,
      value: (closure: (txn: DurableObjectTransaction) => Promise<unknown>) =>
        real((txn) => {
          const put = txn.put.bind(txn) as (...a: unknown[]) => Promise<void>;
          (txn as unknown as { put: unknown }).put = (...a: unknown[]) => { n++; return put(...a); };
          return closure(txn);
        }),
    });
    (i as unknown as { driver: { dueNow(): Promise<string[]> } }).driver.dueNow = async () => ["housekeep"];
    await i.alarm();
    return n;
  });

  expect(puts).toBe(0);
  expect(await proposals("qs_early")).toEqual([]);
});

it("writes the proposals and what it remembers in one commit", async () => {
  const T0 = Date.now();
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_one_commit", T0));

  setClock(T0 + 5 * MIN);
  await fire("qs_one_commit");

  const after = await rows("qs_one_commit");
  const [event] = after.events;
  expect(after.session!.raised).toEqual({ "member_quiet:m_a": { at: T0 + 5 * MIN, repeat: 1, since: T0 + 5 * MIN } });
  // The cursor row ends at the event written, or the next append takes its cursor and overwrites it.
  const cursor = await runInDurableObject(stubOf("qs_one_commit"), (_i: SessionDO, ctx) => ctx.storage.get<number>("cursor"));
  expect(cursor).toBe(event.cursor);
});

it("writes one proposal per due key in one firing, with consecutive cursors", async () => {
  const T0 = Date.now();
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_many", T0, { quietAfterMs: 5 * MIN, answerWithinMs: 10 * MIN, idleAfterMs: 20 * MIN }, {
    members: [
      member({ memberId: "m_a", userId: "u_a", label: "a@x", joinedAt: T0, lastSeenAt: T0, lastSentAt: T0 }),
      peerB(T0),
    ],
  }));
  setClock(T0);
  const asked = (await store.appendEvent("qs_many", request("m_a")))!;

  setClock(T0 + 30 * MIN);
  await fire("qs_many");

  const sent = await proposals("qs_many");
  expect(sent.map((e) => (e.payload as { finding: string; about?: unknown }).finding)).toEqual([
    "member_quiet", "member_quiet", "request_unanswered", "room_idle",
  ]);
  expect(sent.map((e) => e.cursor)).toEqual([asked.cursor + 1, asked.cursor + 2, asked.cursor + 3, asked.cursor + 4]);
  expect(sent.every((e) => (e.payload as { repeat: number }).repeat === 1)).toBe(true);
});

// ---------------------------------------------------------------------------
// A room that cannot answer
// ---------------------------------------------------------------------------

// Review Focus 2. Deriving a time for a room with nobody in it would arm the alarm for a room that is
// about to close, and nothing in it could answer a finding.
it("derives no time for a room every member has left, and writes nothing if the handler is named", async () => {
  const T0 = Date.now();
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_empty", T0, {}, {
    members: [member({ memberId: "m_a", joinedAt: T0, lastSeenAt: T0, lastSentAt: T0, leftAt: T0 + 1 })],
  }));
  expect(await armed("qs_empty"), "no housekeeping time, and nobody to abandon the room").toBeNull();

  setClock(T0 + 3 * HOUR);
  await fireNamed("qs_empty");
  expect(await proposals("qs_empty")).toEqual([]);
});

// `reArm()` never clears an alarm, so the one armed while the member was in the room stays, fires into
// an empty room, finds nothing, and arms nothing after it. The other half of the same focus.
it("lets an alarm armed before the last member left fire into nothing, and arms nothing after it", async () => {
  const T0 = Date.now();
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_left", T0));
  expect(await armed("qs_left")).toBe(T0 + 5 * MIN);

  await store.removeMember("qs_left", "m_a", {
    now: T0 + 1_000, frozen: "allow", cut: false, audit: [],
    event: { type: "member_left", fromMemberId: "m_a", fromUserId: "u_a", fromLabel: "a@x", payload: {}, refId: null },
  });
  expect((await rows("qs_left")).session!.members[0].leftAt).toBe(T0 + 1_000);

  setClock(T0 + 5 * MIN);
  await fire("qs_left");
  await fireNamed("qs_left");

  expect(await proposals("qs_left")).toEqual([]);
  expect(abandonedAt((await rows("qs_left")).session!), "and the room owes no abandonment time either").toBeNull();
});

// The tick's Review Focus 1, for the same reason: this handler writes through `#writeEvent`, which
// bypasses `appendEvent`'s frozen refusal, so what stands between a proposal and a frozen room is the
// rules' gate (`anchors`), which the handler asks and does not copy. The handler is named, because a
// room the rules do not evaluate derives no housekeeping time and the ordinary path never reaches it.
it("writes no proposal into a frozen room, however long it has been quiet", async () => {
  const T0 = Date.now();
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_frozen", T0));
  await store.freezeSession("qs_frozen", T0 + MIN);

  setClock(T0 + 3 * HOUR);
  await fireNamed("qs_frozen");

  expect(await proposals("qs_frozen")).toEqual([]);
});

it("writes no proposal, and does not throw, for a room that declared no housekeeping", async () => {
  const T0 = Date.now();
  const store = new DurableObjectStore(env as never);
  await store.createSession(session({
    id: "qs_undeclared", joinCodes: {}, manifest: roomManifest(),
    members: [member({ memberId: "m_a", joinedAt: T0, lastSeenAt: T0, lastSentAt: T0 })],
  }));

  setClock(T0 + 3 * HOUR);
  await fireNamed("qs_undeclared");

  expect(await proposals("qs_undeclared")).toEqual([]);
  expect(await armed("qs_undeclared"), "and the room derives no housekeeping time").not.toBe(T0 + 5 * MIN);
});

it("writes no proposal into a closed room", async () => {
  const T0 = Date.now();
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_closed", T0));
  await store.closeSession("qs_closed");

  setClock(T0 + 3 * HOUR);
  await fireNamed("qs_closed");

  expect(await proposals("qs_closed")).toEqual([]);
});

// The abandoned handler closes the room in the same firing, and runs first only by the alphabet. The
// handler reads its own precondition, as the tick's does, so a room every member has left unseen for
// the whole window is refused whatever order the names come in.
it("writes no proposal into an abandoned room, however the handlers are ordered", async () => {
  const T0 = Date.now();
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_abandoned", T0));

  setClock(T0 + ABANDONED_AFTER_MS + HOUR);
  await fireNamed("qs_abandoned");

  expect(await proposals("qs_abandoned")).toEqual([]);
});

// R9, which replaces the plan's Review Focus 3. While the room was frozen nobody could send and no request
// could be answered, so a finding computed across the freeze would name a condition the room imposed. A
// thaw restarts every clock: nothing is due until the thaw plus each threshold, then one proposal per key,
// each the first.
it("restarts every clock at a thaw: nothing is due until the thaw plus each threshold, then one proposal per key at repeat 1", async () => {
  const T0 = Date.now();
  const store = new DurableObjectStore(env as never);
  setClock(T0);
  await store.createSession(room("qs_thaw", T0, { quietAfterMs: 5 * MIN, answerWithinMs: 10 * MIN, idleAfterMs: 20 * MIN }));
  const asked = (await store.appendEvent("qs_thaw", request("m_a")))!;

  setClock(T0 + 3 * HOUR);
  await store.freezeSession("qs_thaw", T0 + 3 * HOUR);
  setClock(T0 + 10 * HOUR);
  await store.freezeSession("qs_thaw", null);
  const thawedAt = T0 + 10 * HOUR;
  expect((await rows("qs_thaw")).session!.thawedAt).toBe(thawedAt);

  expect(await armed("qs_thaw"), "the shortest threshold, from the thaw").toBe(thawedAt + 5 * MIN);
  setClock(thawedAt + 5 * MIN - 1);
  await fire("qs_thaw");
  expect(await proposals("qs_thaw"), "ten hours of silence the freeze imposed is not held against anyone").toEqual([]);

  setClock(thawedAt + 20 * MIN);
  await fire("qs_thaw");
  const sent = await proposals("qs_thaw");
  expect(sent.map((e) => e.payload)).toEqual([
    { finding: "member_quiet", about: { member_id: "m_a" }, since: thawedAt + 5 * MIN, repeat: 1 },
    { finding: "request_unanswered", about: { cursor: asked.cursor }, since: thawedAt + 10 * MIN, repeat: 1 },
    { finding: "room_idle", since: thawedAt + 20 * MIN, repeat: 1 },
  ]);
});

// ---------------------------------------------------------------------------
// Requests, and the alarm following them
// ---------------------------------------------------------------------------

it("names an unanswered request at its time, and forgets it once it is answered", async () => {
  const T0 = Date.now();
  const store = new DurableObjectStore(env as never);
  setClock(T0);
  await store.createSession(room("qs_request", T0, { quietAfterMs: null, answerWithinMs: 5 * MIN }, { members: [
    member({ memberId: "m_a", userId: "u_a", label: "a@x", joinedAt: T0, lastSeenAt: T0, lastSentAt: T0 }),
    peerB(T0),
  ] }));
  const asked = (await store.appendEvent("qs_request", request("m_a")))!;
  expect(await armed("qs_request"), "armed for the request, by the append").toBe(asked.at + 5 * MIN);

  setClock(asked.at + 5 * MIN);
  await fire("qs_request");
  const [proposal] = await proposals("qs_request");
  expect(proposal.payload).toEqual({
    finding: "request_unanswered", about: { cursor: asked.cursor }, since: asked.at + 5 * MIN, repeat: 1,
  });

  // An answer closes it. The record keeps the raise until a firing sees its condition gone, and the
  // next one forgets it without saying anything.
  await store.appendEvent("qs_request", answer(asked.cursor));
  expect((await rows("qs_request")).session!.raised).toHaveProperty([`request_unanswered:${asked.cursor}`]);
  setClock(asked.at + 6 * MIN);
  await fireNamed("qs_request");

  const after = await rows("qs_request");
  expect(after.session!.raised).toEqual({});
  expect(after.events.filter((e) => e.type === "housekeeping"), "and says nothing more about it").toHaveLength(1);
});

// R6. A request is the one append that can bring the soonest due time forward: it adds an anchor that may
// fall before the alarm already armed. Every other append only moves a deadline later, and an alarm that is
// early at worst corrects itself.
it("re-arms when an action_request lands in a room that declares answer_within", async () => {
  const T0 = Date.now();
  const store = new DurableObjectStore(env as never);
  setClock(T0);
  await store.createSession(room("qs_r6", T0, { quietAfterMs: HOUR, answerWithinMs: 5 * MIN }));
  expect(await armed("qs_r6"), "armed at the quiet time").toBe(T0 + HOUR);

  setClock(T0 + 10_000);
  const asked = (await store.appendEvent("qs_r6", request("m_a")))!;

  expect(await armed("qs_r6"), "moved to the request's time plus answer_within").toBe(asked.at + 5 * MIN);
});

it("re-arms on a keyed action_request too, and not on its replay", async () => {
  const T0 = Date.now();
  const store = new DurableObjectStore(env as never);
  setClock(T0);
  await store.createSession(room("qs_r6_once", T0, { quietAfterMs: HOUR, answerWithinMs: 5 * MIN }));

  setClock(T0 + 10_000);
  const first = await store.appendEventOnce("qs_r6_once", request("m_a"), "ask-1");
  if (first.outcome !== "appended") throw new Error(`send said ${first.outcome}`);
  expect(await armed("qs_r6_once")).toBe(first.event.at + 5 * MIN);

  // The replay changes nothing the alarm reads, so it asks for no re-arm.
  const reArms = await runInDurableObject(stubOf("qs_r6_once"), async (i: SessionDO) => {
    let n = 0;
    const driver = (i as unknown as { driver: { reArm(): Promise<void> } }).driver;
    const real = driver.reArm.bind(driver);
    driver.reArm = async () => { n++; await real(); };
    await i.appendEventOnce(request("m_a"), "ask-1");
    return n;
  });
  expect(reArms).toBe(0);
});

it("does not re-arm for any other append, nor for a request in a room that declares no answer_within", async () => {
  const T0 = Date.now();
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_r6_with", T0, { quietAfterMs: HOUR, answerWithinMs: 5 * MIN }));
  await store.createSession(room("qs_r6_without", T0, { quietAfterMs: HOUR, answerWithinMs: null }));

  const count = (id: string, e: ReturnType<typeof message> | ReturnType<typeof request>) =>
    runInDurableObject(stubOf(id), async (i: SessionDO) => {
      let n = 0;
      const driver = (i as unknown as { driver: { reArm(): Promise<void> } }).driver;
      const real = driver.reArm.bind(driver);
      driver.reArm = async () => { n++; await real(); };
      await i.appendEvent(e);
      return n;
    });

  expect(await count("qs_r6_with", message()), "a message only moves a deadline later").toBe(0);
  expect(await count("qs_r6_without", request()), "no answer_within, no anchor for it").toBe(0);
  expect(await count("qs_r6_with", request()), "the one append that brings the soonest forward").toBe(1);
});

// ---------------------------------------------------------------------------
// A read brings back an alarm the runtime gave up on (R7)
// ---------------------------------------------------------------------------

// A throwing alarm() is retried by the runtime a few times and then left, with nothing armed. #65 made the
// read of a closed room point the alarm back at its sweep or purge; this is the class, so a housekeeping
// time or a tick the runtime gave up on comes back with the next read as well.
it("re-arms the alarm when a read finds housekeeping due with nothing armed, and leaves the work to the alarm", async () => {
  const T0 = Date.now();
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_given_up", T0));
  await runInDurableObject(stubOf("qs_given_up"), (_i: SessionDO, ctx) => ctx.storage.deleteAlarm());
  expect(await armed("qs_given_up"), "the runtime gave up on it").toBeNull();
  setClock(T0 + 10 * MIN);

  expect(await store.getSession("qs_given_up")).toMatchObject({ id: "qs_given_up", closed: false });

  expect(await armed("qs_given_up"), "armed again, at the time that was due").toBe(T0 + 5 * MIN);
  expect(await proposals("qs_given_up"), "and the read wrote nothing").toEqual([]);
  await fire("qs_given_up");
  expect(await proposals("qs_given_up")).toHaveLength(1);
});

it("re-arms for a tick the runtime gave up on in the same way", async () => {
  const T0 = Date.now();
  const store = new DurableObjectStore(env as never);
  const lead = member({ memberId: "m_lead", roomRole: "lead", joinedAt: T0, lastSeenAt: T0 });
  await store.createSession(session({
    id: "qs_tick_given_up",
    joinCodes: {},
    manifest: roomManifest({
      roles: {
        lead: { can: ["send"], description: null, reports: true },
        observer: { can: [], description: null, reports: false },
      },
      defaultRole: "observer",
      creatorRole: "lead",
      heartbeatOnMs: 5 * MIN,
    }),
    members: [lead],
  }));
  await runInDurableObject(stubOf("qs_tick_given_up"), (_i: SessionDO, ctx) => ctx.storage.deleteAlarm());
  setClock(T0 + 10 * MIN);

  await store.getSession("qs_tick_given_up");

  expect(await armed("qs_tick_given_up"), "armed again, at the tick that was due").toBe(T0 + 5 * MIN);
});

it("arms nothing for a read of a room whose next time is still ahead", async () => {
  const T0 = Date.now();
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_ahead", T0));
  await runInDurableObject(stubOf("qs_ahead"), (_i: SessionDO, ctx) => ctx.storage.deleteAlarm());
  setClock(T0 + 5 * MIN - 1);

  await store.getSession("qs_ahead");

  expect(await armed("qs_ahead")).toBeNull();
});

// ---------------------------------------------------------------------------
// The alarm
// ---------------------------------------------------------------------------

it("stores no due row for it, so a rollback strands nothing", async () => {
  const T0 = Date.now();
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_derived", T0));
  const due = await runInDurableObject(stubOf("qs_derived"), async (_i: SessionDO, ctx) => [
    ...(await ctx.storage.list({ prefix: "due:" })).keys(),
  ]);
  expect(due).toEqual([]);
});

// The runtime says nothing of which object it gave up on. The line alarm() writes before it rethrows is the
// one record of the room and the handler, and the rethrow is what lets the runtime retry. It is also the
// proof the handler sits inside that try, beside the others.
it("names the room and the handler in the log when it throws, still throws, and raises on the retry", async () => {
  const T0 = Date.now();
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_logged", T0));
  await runInDurableObject(stubOf("qs_logged"), (_i: SessionDO, ctx) => {
    const real = ctx.storage.transaction.bind(ctx.storage);
    let refused = false;
    Object.defineProperty(ctx.storage, "transaction", {
      configurable: true,
      value: (...args: Parameters<typeof real>) => {
        if (!refused) { refused = true; throw new Error("storage is unavailable"); }
        return real(...args);
      },
    });
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});

  try {
    setClock(T0 + 5 * MIN);
    await expect(fire("qs_logged"), "the alarm still throws, for the runtime to retry").rejects.toThrow("storage is unavailable");
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/"housekeep".*qs_logged/),
      expect.objectContaining({ message: "storage is unavailable" }),
    );
    expect(await proposals("qs_logged"), "nothing was said by the attempt that failed").toEqual([]);

    await fire("qs_logged");

    expect(await proposals("qs_logged")).toHaveLength(1);
  } finally {
    log.mockRestore();
  }
});

// ---------------------------------------------------------------------------
// On the wire
// ---------------------------------------------------------------------------

// Identifiers and the server's numbers, never prose, so there is nothing in it a reader has to distrust.
// `publicEvent` never wraps (the poll wraps every event at the tool boundary, the tick's included), and
// it adds no `ambient` flag, because a proposal interrupts.
it("is projected as any event is, carrying its payload as written and no ambient flag", async () => {
  const T0 = Date.now();
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_wire", T0));
  setClock(T0 + 5 * MIN);
  await fire("qs_wire");

  const [stored] = await proposals("qs_wire");
  const shown = publicEvent(stored);

  expect(shown).toEqual({
    cursor: stored.cursor,
    type: "housekeeping",
    from: { member_id: "system", label: "bellman" },
    payload: { finding: "member_quiet", about: { member_id: "m_a" }, since: T0 + 5 * MIN, repeat: 1 },
    ref_id: null,
    at: new Date(T0 + 5 * MIN).toISOString(),
  });
  expect(shown).not.toHaveProperty("ambient");
  expect(shown).not.toHaveProperty("fromUserId");
});
