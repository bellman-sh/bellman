/**
 * An append reads the room's cursor, numbers its event with it, and writes the event
 * back under that number. The guarantee that every event keeps a cursor of its own holds
 * only if the read of `cursor` and the write that advances it are one unit. Two appends
 * that read the same cursor write the same `e:` key, one event overwrites the other, and
 * the cursors stay contiguous, so nothing downstream can tell (#120). With a key it is
 * worse: both calls report `appended`, and the idempotency this method exists for is gone.
 *
 * What keeps them apart is a transaction in each append, and a transaction is not the
 * only thing that would. The input gate holds other calls off while a storage operation
 * is outstanding, so a read and then a put with nothing but storage awaits between them
 * is atomic without one. It does not hold them off across an await on anything else, the
 * one case Cloudflare's documentation says it does not cover, and a transaction does.
 * These tests are that difference, made by hand. Each HOLDS the first call just after it
 * has read the cursor, with a timer await standing in for whatever a later edit might
 * put there (a fetch, a call to another object), and lets a second call try to overtake
 * it. On a plain read and then a put the second call takes the same cursor and one event
 * is lost. In a transaction it waits for its turn.
 *
 * The contract suite races appendEventOnce the same way (`appends once when two calls
 * with the same key race`) and cannot do this job. It does not choose where the calls
 * land, so a regression to the plain shape would fail it in about 1% of rounds under
 * this pool, which reads as a flake and not as its cause. These fail every time.
 *
 * The expiry event in `#expireIfDue` takes its cursor the same way, and nextCursor and
 * #writeEvent take the transaction so no caller can do it any other way. It is not held
 * here: reaching it needs the clock past a room's expiry while a call is parked.
 */
import { describe, it, expect, afterEach } from "vitest";
import { env, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { DurableObjectStore, type SessionDO } from "../src/store-do.js";
import { session } from "../tests/helpers/fixtures.js";

const ROOM = "qs_append_race";

const message = (text: string) => ({
  type: "message" as const, fromMemberId: "m_creator", fromUserId: "u_jesse",
  fromLabel: "jesse", payload: { text }, refId: null,
});
const textOf = (event: { payload: unknown }) => (event.payload as { text: string }).text;

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
 * Hold the first read of the cursor, after it has returned and before whatever called it
 * writes: the gap in which what it read can go stale. In production that is any await
 * someone later puts between the read and the write.
 *
 * It patches the class's prototype and undoes it afterwards: a Durable Object answers
 * RPC from its prototype, so an override set on the instance is never called. The wait
 * polls a timer rather than awaiting a promise made by the test, because the object is
 * waiting on something only another request can change.
 */
async function holdFirstReadOfTheCursor(hold: Hold): Promise<void> {
  const stub = env.SESSION.get(env.SESSION.idFromName(ROOM));
  await runInDurableObject<SessionDO, void>(stub, (instance) => {
    const proto = Object.getPrototypeOf(instance) as { nextCursor: (...args: unknown[]) => Promise<number> };
    const read = proto.nextCursor;
    let first = true;
    proto.nextCursor = async function (this: SessionDO, ...args: unknown[]) {
      const cursor = await read.apply(this, args);
      if (first) {
        first = false;
        hold.held = true;
        await until(() => hold.released, "the hold to be released", 15_000);
      }
      return cursor;
    };
    undo.push(() => { proto.nextCursor = read; });
  });
}

afterEach(async () => {
  for (const hold of holds.splice(0)) hold.release();
  await Promise.race([Promise.allSettled(inFlight.splice(0)), sleep(2_000)]);
  for (const restore of undo.splice(0)) restore();
  await reset();
  await abortAllDurableObjects();
});

/** An open room with nothing in it yet, so the first event takes cursor 1. */
async function openRoom(): Promise<DurableObjectStore> {
  const store = new DurableObjectStore(env as never);
  await store.createSession(session({ id: ROOM }));
  return store;
}

/**
 * Two ways to append two different events. The keyed one needs two keys: with one key the
 * second call would find the first's record and replay it, which hides a stale cursor.
 */
const DIFFERENT = [
  {
    name: "appendEvent",
    append: (store: DurableObjectStore, text: string, n: number) =>
      store.appendEvent(ROOM, message(text)),
  },
  {
    name: "appendEventOnce with two keys",
    append: (store: DurableObjectStore, text: string, n: number) =>
      store.appendEventOnce(ROOM, message(text), `send-000${n}`),
  },
];

describe("two appends, the first held between its read of the cursor and its write", () => {
  it.each(DIFFERENT)("$name gives two different events two cursors and keeps both", async ({ append }) => {
    const store = await openRoom();
    const hold = newHold();
    await holdFirstReadOfTheCursor(hold);

    const first = track(append(store, "first", 1)); // reads its cursor, then is held
    await until(() => hold.held, "the first append to be held");
    const second = track(append(store, "second", 2));
    // Not asserted: whether the second waits its turn or finishes first. What matters is
    // that it has had its chance to, before the first is allowed to write.
    await settlesWithin(second, 300);
    hold.release();
    await Promise.all([first, second]);

    const kept = await store.eventsAfter(ROOM, 0);
    const where = `the room holds ${JSON.stringify(kept.map((ev) => [ev.cursor, textOf(ev)]))}`;
    expect(kept.map(textOf).sort(), `an event was lost: ${where}`).toEqual(["first", "second"]);
    expect(new Set(kept.map((ev) => ev.cursor)).size, `two events share a cursor: ${where}`).toBe(2);
  });

  it("appends once and replays once when two calls with the same key are held apart", async () => {
    const store = await openRoom();
    const hold = newHold();
    await holdFirstReadOfTheCursor(hold);

    const first = track(store.appendEventOnce(ROOM, message("once"), "send-0001"));
    await until(() => hold.held, "the first append to be held");
    const second = track(store.appendEventOnce(ROOM, message("once"), "send-0001"));
    await settlesWithin(second, 300);
    hold.release();
    const [a, b] = await Promise.all([first, second]);

    const kept = await store.eventsAfter(ROOM, 0);
    const where = `the calls answered ${a.outcome} and ${b.outcome}; the room holds ${kept.length} event(s)`;
    expect([a.outcome, b.outcome].sort(), where).toEqual(["appended", "replayed"]);
    expect(kept, where).toHaveLength(1);
  });
});
