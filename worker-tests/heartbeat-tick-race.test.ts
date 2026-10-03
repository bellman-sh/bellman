/**
 * The tick reads the session in the transaction it writes it back in, so a write
 * that lands while the tick is in flight is not reverted.
 *
 * `#tickIfDue` writes a whole session record — the roster, `frozenAt` and all — in
 * order to advance `lastTickAt` in the same put as the event. While the record it
 * wrote came from a read made OUTSIDE its write (by `alarm()`, before several
 * awaits), every field in it was a value from before the gap, so anything that
 * committed in the gap was written away by a handler that never read it. A freeze
 * is the worst of them: the room reopens, and the next tick names members silent
 * who were not allowed to answer. A member's own `lastReportAt` stamp is the most
 * likely, because that is what a reply writes, and losing it keeps the member
 * named silent for having answered.
 *
 * These tests are `session-close-join-race.test.ts` applied to the tick, and they
 * work the same way: HOLD the tick between its read of the session and its write,
 * with a timer await standing in for whatever a later edit might put there, and
 * let a real call try to overtake it. The hold is the point. The contract suite
 * cannot do this job, and neither can a test that races the two without choosing
 * where they land: the input gate makes the plain shape atomic whenever every
 * await between the read and the write is storage, so a regression would show up
 * as a rare flake rather than as its cause. These fail every time.
 *
 * The tick's read is the FIRST read of the session in each shape, which is what
 * lets one hold serve both: `nameTheTick` replaces `driver.dueNow` with one that
 * reads no storage, so nothing reads the record before the handler does.
 */
import { describe, it, expect, afterEach } from "vitest";
import { env, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { DurableObjectStore, type SessionDO } from "../src/store-do.js";
import { member, roomManifest, session } from "../tests/helpers/fixtures.js";

const ROOM = "qs_tick_race";
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait for a condition, or fail the test instead of hanging it. */
async function until(condition: () => boolean, what: string, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}`);
    await sleep(2);
  }
}

/** Whether `promise` settles within `ms`; false means it is still waiting. */
const settlesWithin = (promise: Promise<unknown>, ms: number) =>
  Promise.race([promise.then(() => true, () => true), sleep(ms).then(() => false)]);

interface Hold {
  held: boolean;
  released: boolean;
  release(): void;
}

const holds: Hold[] = [];
const undo: (() => void)[] = [];
const inFlight: Promise<unknown>[] = [];

/**
 * Remember a call a test starts and may not get to await, so that a test failing
 * between releasing a hold and awaiting its call does not have the object torn
 * down underneath it, and report that instead of its own failure.
 */
function track<T>(promise: Promise<T>): Promise<T> {
  inFlight.push(promise.then(() => undefined, () => undefined));
  return promise;
}

function newHold(): Hold {
  const hold: Hold = { held: false, released: false, release: () => { hold.released = true; } };
  holds.push(hold);
  return hold;
}

/**
 * Hold the first read of the session, after it has returned and before whatever
 * called it writes: the gap in which what it read can go stale.
 *
 * It patches the class's prototype and undoes it afterwards, because a Durable
 * Object answers RPC from its prototype and an override set on the instance is
 * never called. The wait polls a timer rather than awaiting a promise made by the
 * test, because the object is waiting on something only another request can change.
 */
async function holdFirstReadOfTheSession(hold: Hold): Promise<void> {
  const stub = env.SESSION.get(env.SESSION.idFromName(ROOM));
  await runInDurableObject<SessionDO, void>(stub, (instance) => {
    const proto = Object.getPrototypeOf(instance) as {
      stored: (...args: unknown[]) => Promise<unknown>;
    };
    const read = proto.stored;
    let first = true;
    proto.stored = async function (this: SessionDO, ...args: unknown[]) {
      const record = await read.apply(this, args);
      if (first) {
        first = false;
        hold.held = true;
        await until(() => hold.released, "the hold to be released", 15_000);
      }
      return record;
    };
    undo.push(() => { proto.stored = read; });
  });
}

/**
 * Make the alarm name the tick without reading the session, so the handler's own
 * read is the first one and the hold above lands on it.
 */
const nameTheTick = (i: SessionDO) => {
  (i as unknown as { driver: { dueNow(): Promise<string[]> } }).driver.dueNow =
    async () => ["heartbeat"];
};

afterEach(async () => {
  for (const hold of holds.splice(0)) hold.release();
  await Promise.race([Promise.allSettled(inFlight.splice(0)), sleep(2_000)]);
  for (const restore of undo.splice(0)) restore();
  await reset();
  await abortAllDurableObjects();
});

/**
 * A room owing a tick: the member that answers joined two cadences ago and has
 * reported nothing, so `dueMembers` names it and the handler reaches its write.
 * Raw rows for `lastTickAt`, because this is a state a room reaches by waiting.
 */
async function dueRoom(): Promise<DurableObjectStore> {
  const store = new DurableObjectStore(env as never);
  const ago = Date.now() - 2 * FIVE_MIN;
  await store.createSession(
    session({
      id: ROOM,
      manifest,
      joinCodes: {},
      members: [member({ memberId: "m_lead", roomRole: "lead", label: "lead@a", joinedAt: ago })],
    }),
  );
  const stub = env.SESSION.get(env.SESSION.idFromName(ROOM));
  await runInDurableObject(stub, async (_i: SessionDO, ctx) => {
    const s = await ctx.storage.get<Record<string, unknown>>("session");
    await ctx.storage.put("session", { ...s, lastTickAt: ago });
  });
  return store;
}

/** Fire the alarm with the tick named, so the handler runs whatever the clock says. */
const fireTheTick = () =>
  runInDurableObject(env.SESSION.get(env.SESSION.idFromName(ROOM)), async (i: SessionDO) => {
    nameTheTick(i);
    await i.alarm();
  });

describe("a write that lands while the tick is in flight", () => {
  /**
   * **The one this is for.** A freeze landing while the tick is in flight must
   * survive it. Reverted, the room is open again with nobody having thawed it, and
   * the tick that follows names every member silent for an interval none of them
   * was allowed to answer in — the false silent D10 exists to prevent, reached by
   * losing a write rather than by mismeasuring one.
   */
  it("does not let the tick revert a freeze", async () => {
    const store = await dueRoom();
    const hold = newHold();
    await holdFirstReadOfTheSession(hold);

    const ticking = track(fireTheTick()); // reads the room, then is held
    await until(() => hold.held, "the tick to be held");

    const frozenAt = Date.now();
    const freezing = track(store.freezeSession(ROOM, frozenAt));
    // Not asserted: whether the freeze waits its turn or finishes first. What
    // matters is that it has had its chance to, before the tick is allowed to write.
    await settlesWithin(freezing, 300);
    hold.release();
    await Promise.all([ticking, freezing]);

    const after = (await store.getSession(ROOM))!;
    expect(
      after.frozenAt,
      "the freeze committed and the tick wrote a record that predates it",
    ).not.toBe(null);
  });

  /**
   * The same loss, through the write a member actually makes. `bellman_send
   * type="progress"` stamps `lastReportAt`, and a tick that writes it away leaves
   * the member named silent for having answered — which is the report the whole
   * feature is asking for.
   */
  it("does not let the tick revert a member's report", async () => {
    const store = await dueRoom();
    const hold = newHold();
    await holdFirstReadOfTheSession(hold);

    const ticking = track(fireTheTick());
    await until(() => hold.held, "the tick to be held");

    const reportedAt = Date.now();
    const reporting = track(store.updateMember(ROOM, "m_lead", { lastReportAt: reportedAt }));
    await settlesWithin(reporting, 300);
    hold.release();
    await Promise.all([ticking, reporting]);

    const after = (await store.getSession(ROOM))!;
    const lead = after.members.find((m) => m.memberId === "m_lead")!;
    expect(
      lead.lastReportAt,
      "the report committed and the tick wrote a roster that predates it",
    ).toBe(reportedAt);
  });
});
