/**
 * A room closes when nobody is left in it, and a join into a closed room is refused.
 * Each is a read of the session followed by a write of it, and the guarantee that a
 * room is never closed with a member in it, nor a member seated in a room that is
 * over, holds only if a close and a join cannot both read the same record and then
 * both write.
 *
 * What keeps them apart is a transaction in each, and a transaction is not the only
 * thing that would. The input gate holds other calls off while a storage operation
 * is outstanding, so a read and then a put with nothing but storage awaits between
 * them is atomic without one. It does not hold them off across an await on anything
 * else, the one case Cloudflare's documentation says it does not cover, and a
 * transaction does. These tests are that difference, made by hand. Each HOLDS one
 * call between its read and its write, with a timer await standing in for whatever a
 * later edit might put there (a fetch, a call to another object), and lets the other
 * call try to overtake it. On a plain read and then a put the other call gets in,
 * both answer success and the record is wrong: a closed room whose joiner is gone, or
 * an open one holding a joiner the close never saw. In a transaction the other call
 * waits for its turn.
 *
 * The contract suite races the same pair (`lets exactly one of a close and a join win
 * when started together`) and cannot do this job. It does not choose where the calls
 * land, so a regression to the plain shape would fail it in about 1% of rounds under
 * this pool and never in real workerd, which reads as a flake and not as its cause.
 * These fail every time.
 *
 * Both directions are needed, and neither is redundant. Held in its transaction, an
 * operation keeps the other out whatever shape the other has. So a join left on the
 * plain shape passes the first test, where the held close keeps it waiting, and it is
 * the second, where that join is the one held, that fails for it. A close left on the
 * plain shape is the reverse.
 *
 * Both ways of joining are held: seatMember, the production join, and addMember, the
 * unconditional append, which makes the same refusals and which no tool calls.
 */
import { describe, it, expect, afterEach } from "vitest";
import { env, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { DurableObjectStore, type SessionDO } from "../src/store-do.js";
import { member, session } from "../tests/helpers/fixtures.js";

const ROOM = "qs_close_join";
const LATE = () => member({ memberId: "m_late", userId: "u_peer", roomRole: "peer_b" });

/** The two ways into a room, each answering whether the member was seated. */
const JOINS = [
  {
    name: "seatMember",
    join: async (store: DurableObjectStore) =>
      (await store.seatMember(ROOM, LATE(), 0, Date.now())).refused === null,
  },
  {
    name: "addMember",
    join: (store: DurableObjectStore) => store.addMember(ROOM, LATE()),
  },
];

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
async function holdFirstReadOfTheSession(hold: Hold): Promise<void> {
  const stub = env.SESSION.get(env.SESSION.idFromName(ROOM));
  await runInDurableObject<SessionDO, void>(stub, (instance) => {
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

afterEach(async () => {
  for (const hold of holds.splice(0)) hold.release();
  await Promise.race([Promise.allSettled(inFlight.splice(0)), sleep(2_000)]);
  for (const restore of undo.splice(0)) restore();
  await reset();
  await abortAllDurableObjects();
});

/** An empty room that is still open: the creator has left and nobody has closed it. */
async function emptyRoom(): Promise<DurableObjectStore> {
  const store = new DurableObjectStore(env as never);
  await store.createSession(session({ id: ROOM, members: [member({ leftAt: Date.now() })] }));
  return store;
}

/**
 * Exactly one of the two won, and the record says so. Both succeeding is the room the
 * whole pair exists to prevent, closed with a member in it or a member seated and then
 * written away by the close that had not seen them.
 */
async function expectExactlyOneWon(store: DurableObjectStore, closed: boolean, seated: boolean): Promise<void> {
  const after = (await store.getSession(ROOM))!;
  const inRoom = after.members.some((m) => m.memberId === "m_late");
  const where = `close answered ${closed}, join answered ${seated}; the record says closed=${after.closed} and the joiner is ${inRoom ? "in" : "not in"} the room`;
  expect(closed, `one of them has to give way: ${where}`).not.toBe(seated);
  expect(after.closed, where).toBe(closed);
  expect(inRoom, where).toBe(seated);
}

describe.each(JOINS)("a close and $name, one held between its read and its write", ({ join }) => {
  it("does not let a join overtake a close that has read an empty room", async () => {
    const store = await emptyRoom();
    const hold = newHold();
    await holdFirstReadOfTheSession(hold);

    const close = track(store.closeSessionIfEmpty(ROOM)); // reads "nobody in it", then is held
    await until(() => hold.held, "the close to be held");
    const joined = track(join(store));
    // Not asserted: whether the join waits its turn or finishes first. What matters is
    // that it has had its chance to, before the close is allowed to write.
    await settlesWithin(joined, 300);
    hold.release();
    const [closed, seated] = await Promise.all([close, joined]);

    await expectExactlyOneWon(store, closed, seated);
  });

  it("does not let a close overtake a join that has read an open room", async () => {
    const store = await emptyRoom();
    const hold = newHold();
    await holdFirstReadOfTheSession(hold);

    const joined = track(join(store)); // reads "open", then is held
    await until(() => hold.held, "the join to be held");
    const close = track(store.closeSessionIfEmpty(ROOM));
    await settlesWithin(close, 300);
    hold.release();
    const [seated, closed] = await Promise.all([joined, close]);

    await expectExactlyOneWon(store, closed, seated);
  });
});
