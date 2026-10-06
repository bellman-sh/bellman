/**
 * An expiry is one commit (#124): the room closing, the registry removals its codes owe,
 * and the `session_expired` event that says so.
 *
 * It used to be two. The close and the removals committed, and the event took its cursor
 * in a transaction of its own. An interruption between them left a room closed with
 * nothing recording why, and nothing ever wrote the event afterwards: the retry, whether
 * it is the next read or the alarm, finds the room already closed and has nothing left
 * to expire. A poll waiting on the room's last word never got it.
 *
 * The interruption here is a write that throws, which is what the isolate going away
 * leaves behind: whatever had committed stays, whatever had not never lands. In the code as
 * it stands the expiry's transaction makes exactly one write: a single put carrying the
 * session, the event, the cursor and the registry's rows. `enqueue` only reads and arms the
 * alarm, and `nextCursor` only reads, so there is no second write for anything to land
 * between. The drain that follows the commit is the outbox's, and is not part of it.
 *
 * The cases are keyed on the rows a write carries, once on the event's and once on the
 * session's. Today both land on that one put, so both stand for the same interruption. They
 * are two because they are what a split would pull apart, in either order. With the event
 * second, which is how it used to be, the write that carries it lands after the close, so
 * the room is closed with no event. With the event first, the write that carries the session
 * lands second, so the event is stored and the room is not closed. Each order fails the
 * cases keyed on the write that lands second and passes the ones keyed on the write that
 * lands first, and a single put passes them all.
 *
 * Both ways into an expiry run every case, since a read that finds the room lapsed and
 * the TTL alarm reach `#expireIfDue` separately and a room is expired by whichever
 * comes first.
 */
import { it, expect, afterEach } from "vitest";
import {
  env, reset, runInDurableObject, abortAllDurableObjects,
} from "cloudflare:test";
import { DurableObjectStore, type SessionDO } from "../src/store-do.js";
import { JOIN_CODE_TTL } from "../src/store.js";
import { session } from "../tests/helpers/fixtures.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

const A = "BELL-AAAA-01";
const B = "BELL-BBBB-02";
const live = () => Date.now() + JOIN_CODE_TTL;

const sessionStub = (id: string) => env.SESSION.get(env.SESSION.idFromName(id));
const registry = () => env.REGISTRY.get(env.REGISTRY.idFromName("registry"));

/** What the registry's index holds for each code: the session it names, or undefined. */
const indexed = (...codes: string[]) =>
  Promise.all(codes.map((code) => registry().lookupJoinCode(code)));

/** Every row the object holds, so "nothing changed" means nothing at all. */
const everything = (id: string) =>
  runInDurableObject(sessionStub(id), async (_i: SessionDO, ctx) =>
    Object.fromEntries(await ctx.storage.list()));

const cursorOf = (id: string) =>
  runInDurableObject(sessionStub(id), (_i: SessionDO, ctx) => ctx.storage.get<number>("cursor"));

/** When the object's one alarm is set for, or null when nothing is scheduled. */
const armedAlarm = (id: string) =>
  runInDurableObject(sessionStub(id), (_i: SessionDO, ctx) => ctx.storage.getAlarm());

/**
 * Move the alarm to a time no write here would choose, so a write that armed one shows
 * as a different time. A rolled-back write arms nothing, and leaves this where it was.
 */
const parkAlarm = async (id: string) => {
  const at = Date.now() + 3_600_000;
  await runInDurableObject(sessionStub(id), (_i: SessionDO, ctx) => ctx.storage.setAlarm(at));
  return at;
};

/**
 * A room with one message in it, a live code for each of two roles in the registry, and
 * its TTL already behind it. The message makes the expiry's cursor 2 rather than 1, so a
 * stale cursor shows as an event overwritten and not as a coincidence. The codes make
 * the expiry owe the registry two removals. The room stays open: only `#expireIfDue`
 * closes it, and that is what is under test.
 */
const lapsedRoom = async (store: DurableObjectStore, id: string) => {
  await store.createSession(session({
    id,
    joinCodes: { peer_b: { code: A, expiresAt: live() }, peer_a: { code: B, expiresAt: live() } },
  }));
  await store.appendEvent(id, {
    type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse",
    fromLabel: "jesse", payload: { text: "before" }, refId: null,
  });
  await runInDurableObject(sessionStub(id), async (_i: SessionDO, ctx) => {
    const stored = await ctx.storage.get<Record<string, unknown>>("session");
    await ctx.storage.put("session", { ...stored, expiresAt: Date.now() - 1 });
  });
};

/**
 * Make any write that carries a row under `prefix` throw while `outage.on` is set, wherever
 * it is made: through the object's storage or through a transaction opened on it, and in
 * either of `put`'s shapes. `hits` counts the writes refused, so a test can tell the hook
 * sat on the write it names. The state is an object the test holds, so the interruption
 * can be over by the time the retry runs. It lives on the instance that serves the room,
 * and the abort in afterEach discards it.
 */
const interruptWritesTo = (id: string, prefix: string, outage: { on: boolean; hits: number }) =>
  runInDurableObject(sessionStub(id), async (_i: SessionDO, ctx) => {
    type Call = (...args: unknown[]) => Promise<unknown>;
    const carries = (arg: unknown) =>
      typeof arg === "string"
        ? arg.startsWith(prefix)
        : typeof arg === "object" && arg !== null && Object.keys(arg).some((k) => k.startsWith(prefix));
    const wrap = (store: DurableObjectStorage | DurableObjectTransaction) => {
      const write = (store as unknown as { put: Call }).put.bind(store);
      Object.defineProperty(store, "put", {
        configurable: true,
        value: (...args: unknown[]) => {
          if (outage.on && carries(args[0])) {
            outage.hits++;
            throw new Error("interrupted");
          }
          return write(...args);
        },
      });
    };
    const storage = ctx.storage;
    wrap(storage);
    const open = (storage as unknown as { transaction: Call }).transaction.bind(storage);
    Object.defineProperty(storage, "transaction", {
      configurable: true,
      value: (closure: (txn: DurableObjectTransaction) => Promise<unknown>) =>
        open((txn: DurableObjectTransaction) => {
          wrap(txn);
          return closure(txn);
        }),
    });
  });

/** The two ways a lapsed room gets expired. */
const WAYS = [
  { way: "a read that finds the room lapsed", expire: (store: DurableObjectStore, id: string) => store.getSession(id) },
  {
    way: "the TTL alarm",
    expire: (_store: DurableObjectStore, id: string) =>
      runInDurableObject(sessionStub(id), (instance: SessionDO) => instance.alarm()),
  },
];
/** The rows an interruption is keyed on. One put carries both today; see the header. */
const WRITES = [
  { write: "a write carrying the event row", prefix: "e:" },
  { write: "a write carrying the session row", prefix: "session" },
];
const CASES = WAYS.flatMap((way) => WRITES.map((write) => ({ ...way, ...write })));

/**
 * The close, the registry removals and the event are all there or none of it is. The
 * alarm the removals arm goes back with them (it commits and rolls back with the
 * transaction), so it is read too: a room left with an alarm armed for rows that were
 * never written would wake for nothing.
 */
it.each(CASES)(
  "$way leaves the room exactly as it was when $write is interrupted",
  async ({ expire, prefix }) => {
    const store = new DurableObjectStore(env as never);
    const id = "qs_expiry_atomic";
    await lapsedRoom(store, id);
    const parked = await parkAlarm(id);
    const before = await everything(id);
    const outage = { on: true, hits: 0 };
    await interruptWritesTo(id, prefix, outage);

    await expect(expire(store, id)).rejects.toThrow(/interrupted/);

    // The write the hook refuses was made. Without it the rest proves nothing.
    expect(outage.hits).toBeGreaterThan(0);
    expect(await everything(id)).toEqual(before);
    expect(await armedAlarm(id)).toBe(parked);
    expect(await indexed(A, B)).toEqual([id, id]);
  }
);

/**
 * What the split cost in the end, and the reason atomicity is worth having here: the
 * retry has to finish the job. Left closed with no event, the room reads as expired
 * forever and nothing writes the event. Left as it was, the next read or the alarm
 * expires it whole, with the event numbered after the room's own history.
 */
it.each(CASES)(
  "$way finishes the expiry, event included, once $write stops being interrupted",
  async ({ expire, prefix, write }) => {
    const store = new DurableObjectStore(env as never);
    const id = "qs_expiry_retry";
    await lapsedRoom(store, id);
    const outage = { on: true, hits: 0 };
    await interruptWritesTo(id, prefix, outage);
    await expect(expire(store, id)).rejects.toThrow(/interrupted/);
    expect(outage.hits, `control: the interruption landed on ${write}`).toBeGreaterThan(0);
    outage.on = false;

    await expire(store, id);

    expect((await store.getSession(id))?.closed).toBe(true);
    const events = await store.eventsAfter(id, 0);
    expect(events.map((e) => [e.cursor, e.type])).toEqual([[1, "message"], [2, "session_expired"]]);
    expect(await cursorOf(id)).toBe(2);
    expect(await indexed(A, B)).toEqual([undefined, undefined]);
  }
);
