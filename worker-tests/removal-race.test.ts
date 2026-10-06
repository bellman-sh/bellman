/**
 * What `removeMember` was built to close, held open in workerd, and the queue it leaves
 * behind, read from storage instead of inferred from what got delivered.
 *
 * tests/helpers/store-contract.ts proves what the operation does, in both stores. This
 * file proves the windows it exists to close, in the runtime where they exist, and it
 * does so without the two accidents that suite leans on.
 *
 * THE WINDOWS (#117, #118). A removal decides from the room it read, and the decision
 * goes stale if another call lands between that read and the write. The input gate keeps
 * that from happening whenever every await between the two is storage, so racing two
 * calls with Promise.all cannot show the difference. With the "already out" check moved
 * back in front of the transaction, a hundred plain races on workerd 1.20260926.1 (the
 * version worker-tests/package.json pins) produced no second departure: the gate
 * serialised the calls, and the code that is wrong in the one case it does not cover
 * passed. What the transaction adds is that it also holds across an await on anything
 * else, and the first two cases here are that difference made by hand, the way
 * session-close-join-race.test.ts makes it. Each HOLDS the first call just after it has
 * read the room, with a timer standing in for whatever a later edit might put there (a
 * fetch, a call to another object), and lets a second call try to overtake it. Read
 * and decided outside the transaction, the second call gets in and both answer as if
 * they were first. Inside it, the second waits.
 *
 * THE QUEUE. The contract suite can only see "queued nothing" by looking for a delivered
 * audit row, and in the Workers program that is visible at all because the suite pins the
 * clock to 2026-03-15, which makes the outbox's five-second grace alarm overdue the
 * moment it is armed. This program has no fake clock, so a row a call queued wrongly
 * sits in `ob:` for OUTBOX_GRACE_MS where any read here can see it. And `ob_seq` counts
 * every row the object has ever been given, delivered or not, so it needs no luck with
 * timing at all. The cases read both, plus every row the object holds where "wrote
 * nothing" is the claim.
 *
 * THE OWED DELIVERY. A departure and its audit row commit together, so a delivery that
 * cannot happen yet cannot unmake the departure. The last case takes the audit stream
 * down for real and shows that: the removal answers, the row stays queued, and the alarm
 * finishes it once the stream is back.
 *
 * The room is built from tests/helpers/fixtures.ts, as the other worker tests build
 * theirs. Two of its defaults are a trap for a case about a door. `session()` plants
 * its live code on the manifest's default role, `peer_b`, and `member()` seats `peer_a`.
 * So this room plants nothing, a case that wants a door plants one for the role its
 * request names (`DOOR`), and the plant is checked live before the call. A case that
 * named some other role would have no door in play and could not fail.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  env, reset, runInDurableObject, runDurableObjectAlarm, abortAllDurableObjects,
} from "cloudflare:test";
import { DurableObjectStore, type AuditDO, type SessionDO } from "../src/store-do.js";
import {
  OUTBOX_GRACE_MS, OUTBOX_HANDLER, OUTBOX_PREFIX, OUTBOX_SEQ, dueKey, type OutboxRow,
} from "../src/outbox.js";
import type { EventBody, RemovalRequest } from "../src/store.js";
import type { AuditEntry, EventType, JoinCodeRecord, Session } from "../src/types.js";
import { member, session } from "../tests/helpers/fixtures.js";

/** The seat `m_peer` holds, and the role every request here names when it shuts a door. */
const DOOR = "peer_b";

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
 * Remember a call a test starts and may not get to await, so that a test that fails
 * between releasing a hold and awaiting its call does not have the object torn down
 * underneath it, and report that instead of its own failure.
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

const stub = (id: string) => env.SESSION.get(env.SESSION.idFromName(id));

/**
 * Hold the first read of the session, after it has returned and before whatever called
 * it writes: the gap in which what it read can go stale. In production that is any
 * await someone later puts between the decision and the write.
 *
 * It patches the class's prototype and undoes it afterwards: a Durable Object answers
 * RPC from its prototype, so an override set on the instance is never called. The wait
 * polls a timer rather than awaiting a promise made by the test, because the object is
 * waiting on something only another request can change.
 */
async function holdFirstReadOfTheSession(id: string, hold: Hold): Promise<void> {
  await runInDurableObject<SessionDO, void>(stub(id), (instance) => {
    const proto = Object.getPrototypeOf(instance) as { stored: (...args: unknown[]) => Promise<unknown> };
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
 * Take the audit stream down, from the inside: while `how.down` is set, every
 * transaction `AuditDO.append` opens is refused. The state is an object the test holds,
 * so it can change its mind, and the hook lives on that instance, which the abort in
 * afterEach discards. Reads (`recent`) do not open a transaction and keep working.
 */
const auditDown = (how: { down: boolean }) =>
  runInDurableObject(env.AUDIT.get(env.AUDIT.idFromName("org_codenerd")), async (_i: AuditDO, ctx) => {
    type Call = (...args: unknown[]) => Promise<unknown>;
    const open = (ctx.storage as unknown as { transaction: Call }).transaction.bind(ctx.storage);
    Object.defineProperty(ctx.storage, "transaction", {
      configurable: true,
      value: async (...args: unknown[]) => {
        if (how.down) throw new Error("audit stream down");
        return open(...args);
      },
    });
  });

// Storage is not isolated between tests in this pool (worker-tests/README.md), and every
// case here files audit rows under org_codenerd, so the audit counts would carry over.
afterEach(async () => {
  for (const hold of holds.splice(0)) hold.release();
  await Promise.race([Promise.allSettled(inFlight.splice(0)), sleep(2_000)]);
  for (const restore of undo.splice(0)) restore();
  await reset();
  await abortAllDurableObjects();
});

const store = () => new DurableObjectStore(env as never);

/** The creator and `m_peer`, in an open room that holds no code. */
async function room(id: string, over: Partial<Session> = {}): Promise<DurableObjectStore> {
  const s = store();
  await s.createSession(session({
    id,
    joinCodes: {},
    members: [
      member({ memberId: "m_creator" }),
      member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", roomRole: DOOR }),
    ],
    ...over,
  }));
  return s;
}

/** A code that stays live for the whole case. */
const liveDoor = (code: string): JoinCodeRecord => ({ code, expiresAt: Date.now() + 900_000 });

/** Plant `record` for `DOOR` through the production path, and check it is live. */
async function plantDoor(s: DurableObjectStore, id: string, record: JoinCodeRecord): Promise<void> {
  expect((await s.setJoinCode(id, DOOR, record.code, record.expiresAt, { replaceLive: true, now: Date.now() })).ok, "control: the door was planted")
    .toBe(true);
  expect(await s.getSessionByJoinCode(record.code), "control: the door is live before the call")
    .toBeDefined();
}

const body = (type: EventType, memberId: string): EventBody => ({
  type, fromMemberId: memberId, fromUserId: "u_peer",
  fromLabel: "peer@codenerd", payload: {}, refId: null,
});

const entry = (id: string, action: string, orgId: string | null = "org_codenerd"): AuditEntry => ({
  at: Date.now(), orgId, sessionId: id, actorUserId: "u_jesse", action, detail: {},
});

/** `m_peer` leaving on their own: allowed from a frozen room, with a row for the departure. */
const leave = (id: string, over: Partial<RemovalRequest> = {}): RemovalRequest => ({
  now: Date.now(), frozen: "allow", cut: false,
  event: body("member_left", "m_peer"), audit: [entry(id, "member_left")],
  ...over,
});

/** The creator evicting `m_peer` and shutting `DOOR` behind them, with a row for each. */
const eviction = (id: string, over: Partial<RemovalRequest> = {}): RemovalRequest => ({
  now: Date.now(), frozen: "refuse", cut: true, byUserId: "u_jesse",
  event: body("member_evicted", "system"),
  retire: { role: DOOR, event: body("invite_revoked", "system"), audit: [entry(id, "invite_revoked")] },
  audit: [entry(id, "member_evicted")],
  ...over,
});

/** What the object's outbox holds: the rows waiting, and how many it has ever been given. */
const outbox = (id: string) =>
  runInDurableObject(stub(id), async (_i: SessionDO, ctx) => ({
    queued: [...(await ctx.storage.list<OutboxRow>({ prefix: OUTBOX_PREFIX })).values()],
    issued: ((await ctx.storage.get<number>(OUTBOX_SEQ)) ?? -1) + 1,
  }));

/** Every row the object holds, so "nothing changed" means nothing at all. */
const everything = (id: string) =>
  runInDurableObject(stub(id), async (_i: SessionDO, ctx) =>
    Object.fromEntries(await ctx.storage.list()));

/** When the object's one alarm is set for, or null when nothing is scheduled. */
const armedAlarm = (id: string) =>
  runInDurableObject(stub(id), (_i: SessionDO, ctx) => ctx.storage.getAlarm());

describe("removeMember, with a second call let in while the first is held", () => {
  it("records one departure, one event and one audit row when two calls race on one handle", async () => {
    // #117. The first call reads the room and is held. The second is then let try to
    // pass it. Whichever order the transaction settles them in, one of them is first and
    // the other finds the member already out; both answering "removed" is the bug.
    const ID = "qs_race_leave";
    const s = await room(ID);
    const hold = newHold();
    await holdFirstReadOfTheSession(ID, hold);

    const first = track(s.removeMember(ID, "m_peer", leave(ID)));
    await until(() => hold.held, "the first leave to be held");
    const second = track(s.removeMember(ID, "m_peer", leave(ID)));
    // Not asserted: whether the second waits its turn or finishes first. What matters is
    // that it has had its chance to, before the first is allowed to write.
    await settlesWithin(second, 300);
    hold.release();
    const [a, b] = await Promise.all([first, second]);

    const events = (await s.eventsAfter(ID, 0)).map((e) => e.type);
    const rows = (await s.auditForOrg("org_codenerd", 10)).map((r) => r.action);
    const where = `the calls answered removed=${a.removed} and removed=${b.removed}; `
      + `the room holds ${JSON.stringify(events)} and the audit stream ${JSON.stringify(rows)}`;
    expect([a.removed, b.removed].filter(Boolean), `exactly one call records the departure: ${where}`)
      .toHaveLength(1);
    expect(events, where).toEqual(["member_left"]);
    // The half of #117 an idempotency key on the event could not have closed: a
    // departure said twice is two audit rows as well, each with an intent id of its own.
    expect(rows, where).toEqual(["member_left"]);
  });

  it("never completes a removal in a room a freeze has already reached", async () => {
    // #118. A freeze dispatched while an eviction is held after reading an unfrozen room.
    // Either order is allowed, and the room must say which one happened: the eviction
    // went first, from a room that was not yet frozen, or the freeze did and the
    // eviction is refused. A removal that completes after the freeze landed is the bug,
    // and the end state alone cannot show it (member out, event written, room frozen
    // reads the same either way), so whether the freeze got in is read, not assumed.
    const ID = "qs_race_freeze";
    const s = await room(ID);
    const hold = newHold();
    await holdFirstReadOfTheSession(ID, hold);

    const removal = track(s.removeMember(ID, "m_peer", eviction(ID, { retire: undefined, audit: [] })));
    await until(() => hold.held, "the eviction to be held");
    const freeze = track(s.freezeSession(ID, Date.now()));
    const frozeFirst = await settlesWithin(freeze, 300);
    hold.release();
    const [outcome] = await Promise.all([removal, freeze]);

    const after = (await s.getSession(ID))!;
    const peer = after.members.find((m) => m.memberId === "m_peer")!;
    const events = (await s.eventsAfter(ID, 0)).map((e) => e.type);
    const where = `the freeze ${frozeFirst ? "landed while the eviction was held" : "waited for the eviction"}; `
      + `the eviction answered ${JSON.stringify(outcome)}, the member is ${peer.leftAt === null ? "still in" : "out"} `
      + `and the room holds ${JSON.stringify(events)}`;
    expect(after.frozenAt, `the freeze is not lost: ${where}`).not.toBeNull();
    if (frozeFirst) {
      // The branch a regression lands in. With the transaction in place the freeze cannot
      // get in while the eviction is held, so only the other branch runs.
      expect(outcome, where).toEqual({ refused: "frozen", removed: false, codeRetired: null });
      expect(peer.leftAt, where).toBeNull();
      expect(events, where).toEqual([]);
    } else {
      expect(outcome, where).toEqual({ refused: null, removed: true, codeRetired: null });
      expect(peer.leftAt, where).not.toBeNull();
      expect(events, where).toEqual(["member_evicted"]);
    }
  });
});

describe("removeMember's queue, read from storage", () => {
  it("queues and writes nothing when a freeze refuses it, with a door live and rows in the request", async () => {
    const ID = "qs_refused_frozen";
    const s = await room(ID);
    const door = liveDoor("BELL-LIVE-01");
    await plantDoor(s, ID, door);
    await s.freezeSession(ID, Date.now());
    const queued = await outbox(ID);
    expect(queued.queued, "control: planting the door left nothing waiting").toEqual([]);
    const held = await everything(ID);

    const outcome = await s.removeMember(ID, "m_peer", eviction(ID));

    expect(outcome).toEqual({ refused: "frozen", removed: false, codeRetired: null });
    expect(await outbox(ID), "no row queued, and none ever given out").toEqual(queued);
    // The record as planted, code and expiry: a store that kept the entry and expired
    // it, or swapped the code, would still have a code in that slot.
    expect((await s.getSession(ID))!.joinCodes[DOOR], "the door is untouched").toEqual(door);
    expect(await everything(ID), "the object holds exactly what it held").toEqual(held);
  });

  it("queues and writes nothing for a member who is already out, behind no live door", async () => {
    const ID = "qs_already_out";
    const s = await room(ID);
    expect((await s.removeMember(ID, "m_peer", leave(ID))).removed, "control: the first call removes")
      .toBe(true);
    const queued = await outbox(ID);
    expect(queued.queued, "control: the first call's row was delivered").toEqual([]);
    expect(queued.issued, "control: and was queued, so a queue that works shows here").toBe(1);
    const held = await everything(ID);

    // An eviction of someone already gone: it carries a row for the departure and a
    // door to retire, and the room has neither a departure to say nor a code to shut.
    const again = await s.removeMember(ID, "m_peer", eviction(ID));

    expect(again).toEqual({ refused: null, removed: false, codeRetired: null });
    expect(await outbox(ID), "no row queued, and none ever given out").toEqual(queued);
    expect(await everything(ID), "the object holds exactly what it held").toEqual(held);
  });

  it("drains the queue on the door-only path, and queues no org-less row", async () => {
    // A member already out whose seat's code is still live. It writes an event and
    // queues rows WITHOUT recording a departure, and it is the one path nothing else
    // pins the delivery on: the contract suite sees the audit row only because its
    // pinned clock makes the grace alarm overdue at once, so a missing deliverNow()
    // here would go unnoticed there.
    const ID = "qs_door_only";
    const s = await room(ID);
    const door = liveDoor("BELL-DOOR-01");
    await plantDoor(s, ID, door);
    await s.removeMember(ID, "m_peer", leave(ID, { audit: [] }));
    const before = await outbox(ID);
    expect(before.queued, "control: nothing is waiting before the call").toEqual([]);

    const outcome = await s.removeMember(ID, "m_peer", eviction(ID, {
      retire: {
        role: DOOR,
        event: body("invite_revoked", "system"),
        audit: [
          entry(ID, "invite_revoked"),
          // Org-less: the producer must drop it before it is ever queued.
          entry(ID, "invite_revoked", null),
        ],
      },
    }));

    // The departure is not restated, but the door that was still open is shut.
    expect(outcome).toEqual({ refused: null, removed: false, codeRetired: DOOR });
    const after = await outbox(ID);
    expect(after.queued, "drained inline, not left for the alarm").toEqual([]);
    // The door's drop and the one row that has an org. The delivery guard would also
    // drop an org-less row, and the audit stream shows one row either way, so the count
    // of rows queued is what tells a producer that filtered from one that did not.
    expect(after.issued - before.issued, "rows queued by the call").toBe(2);
    expect((await s.auditForOrg("org_codenerd", 10)).map((r) => r.action)).toEqual(["invite_revoked"]);
    expect((await s.eventsAfter(ID, 0)).map((e) => e.type)).toEqual(["member_left", "invite_revoked"]);
    expect((await s.getSession(ID))!.joinCodes[DOOR]).toBeUndefined();
  });

  it("retires no door on its way to refusing a member it does not know", async () => {
    // The door is planted FIRST and deliberately. With no live record for the role the
    // request names, `retiring` is null in every store, correct or broken, nothing is
    // queued, and the checks below cannot fail: green for a reason that has nothing to
    // do with what they claim.
    const ID = "qs_unknown_member";
    const s = await room(ID);
    const door = liveDoor("BELL-GHOST-01");
    await plantDoor(s, ID, door);
    const queued = await outbox(ID);
    expect(queued.queued, "control: planting the door left nothing waiting").toEqual([]);
    const held = await everything(ID);

    const outcome = await s.removeMember(ID, "m_ghost", eviction(ID));

    expect(outcome).toEqual({ refused: "not_found", removed: false, codeRetired: null });
    expect((await s.getSession(ID))!.joinCodes[DOOR], "the door is untouched").toEqual(door);
    expect(await outbox(ID), "no row queued, and none ever given out").toEqual(queued);
    expect(await everything(ID), "the object holds exactly what it held").toEqual(held);
  });

  it("queues nothing into a room that does not exist", async () => {
    // The unknown-ROOM refusal has no deterministic control anywhere else. In the
    // contract suite it is caught in workerd only by an audit read that races the
    // delivering alarm, and that read goes vacuous if the pinned clock, the grace
    // period or the alarm's speed ever changes. A store that queues before it looks the
    // room up queues into the object the name resolves to, so that is what is read.
    const ID = "qs_never_created";

    const outcome = await store().removeMember(ID, "m_peer", eviction(ID));

    expect(outcome).toEqual({ refused: "not_found", removed: false, codeRetired: null });
    expect(await everything(ID), "nothing at all was written into the object this names").toEqual({});
    expect(await armedAlarm(ID), "and no alarm was armed in it").toBeNull();
  });
});

describe("removeMember when the audit stream cannot take the row", () => {
  it("keeps the departure and the queued row, and the alarm finishes the delivery", async () => {
    // The row is queued in the removal's own transaction, so a delivery that has not
    // happened yet cannot unmake the departure, and nothing but the alarm is needed to
    // finish it. Without the outage this would be a case that cannot tell a queued row
    // from one delivered inline.
    const ID = "qs_audit_owed";
    const s = await room(ID);
    const stream = { down: true };
    await auditDown(stream);

    const outcome = await s.removeMember(ID, "m_peer", leave(ID));

    expect(outcome, "the removal answers, though its audit row could not be delivered")
      .toEqual({ refused: null, removed: true, codeRetired: null });
    const after = (await s.getSession(ID))!;
    expect(after.members.find((m) => m.memberId === "m_peer")!.leftAt).not.toBeNull();
    expect((await s.eventsAfter(ID, 0)).map((e) => e.type)).toEqual(["member_left"]);
    // Tried once and refused, and still queued: the attempt count is how this knows the
    // delivery was made and failed, and not that it never ran.
    expect((await outbox(ID)).queued).toMatchObject([{ kind: "audit", attempts: 1 }]);
    expect(await s.auditForOrg("org_codenerd", 10), "nothing delivered yet").toEqual([]);
    // A retry is scheduled for the queue, and not only the room's expiry hours away.
    const alarm = await armedAlarm(ID);
    expect(alarm, "an alarm is armed").not.toBeNull();
    expect(alarm!, "armed for the retry").toBeLessThan(Date.now() + OUTBOX_GRACE_MS);

    // The stream comes back and the time the retry was set for arrives. The backoff is
    // the driver's; this only lets it elapse.
    stream.down = false;
    await runInDurableObject(stub(ID), (_i: SessionDO, ctx) =>
      ctx.storage.put({ [dueKey(OUTBOX_HANDLER)]: Date.now() - 1 }));
    expect(await runDurableObjectAlarm(stub(ID))).toBe(true);

    expect((await s.auditForOrg("org_codenerd", 10)).map((r) => r.action)).toEqual(["member_left"]);
    expect((await outbox(ID)).queued).toEqual([]);
  });
});
