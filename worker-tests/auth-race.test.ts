/**
 * AuthDO's three guarded read-then-writes, held open in workerd: `admitRegistration` (the
 * per-address window and the client cap), `touchSession` and `replanSession`. Each reads a
 * record, decides from it and writes, and what it promises holds only if no other call can
 * read the same record and then write: two registrations that both find the last slot free
 * and both take it, or a touch that reads a session just before a sign-out and writes it
 * back just after, so the person who signed out is signed in again (#125 asked whether the
 * registration cap can be passed this way).
 *
 * What keeps them apart is a transaction in each, and a transaction is not the only thing
 * that would. The input gate holds other calls off while a storage operation is outstanding,
 * so a read and then a put with nothing but storage awaited between them is atomic without
 * one, and these methods were written that way. It does not hold them off across an await on
 * anything else, the one case Cloudflare's documentation says it does not cover, and a
 * transaction does. These tests are that difference, made by hand, the way
 * session-append-race.test.ts makes it for a room's cursor. Each HOLDS the first call just
 * after it has read the record its decision turns on, with a timer await standing in for
 * whatever a later edit might put there (a fetch, a call to another object), and lets a
 * second call try to overtake it. On a plain read and then a put the second call gets in,
 * and the first writes from what it read before. In a transaction the second waits for its
 * turn.
 *
 * Dispatching the two calls together with Promise.all cannot do this job. It does not choose
 * where they land, and under the input gate the plain shape passes it: the `sent alongside`
 * cases in auth-session.test.ts passed on it. These fail every time.
 *
 * The method under test is always the one held. Held in its transaction, a call keeps every
 * other call out whatever shape that call has, so holding the interfering call instead
 * would pass for a method under test left on the plain shape.
 */
import { describe, it, expect, afterEach } from "vitest";
import { env, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import type { AuthDO } from "../src/oauth/store.js";
import {
  CLIENT_CAP, CLIENT_COUNT_KEY, REGISTRATIONS_PER_HOUR, SESSION_TOUCH_MS, SESSION_TTL_MS,
  type PanelSession, type RegisteredClient,
} from "../src/oauth/storage.js";
import type { Identity } from "../src/types.js";

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

afterEach(async () => {
  for (const hold of holds.splice(0)) hold.release();
  await Promise.race([Promise.allSettled(inFlight.splice(0)), sleep(2_000)]);
  await reset();
  await abortAllDurableObjects();
});

/** One object per test, so no test starts from another's rows. */
const auth = (name: string) => env.AUTH.get(env.AUTH.idFromName(name));

/**
 * Hold the first read of `key` in the object `name`, after it has returned and before
 * whatever called it writes: the gap in which what it read can go stale. In production that
 * is any await someone later puts between the decision and the write.
 *
 * A method reads through one of two handles, and the hold has to see both. One that reads
 * and then puts reads through `storage.get`. One that is a transaction reads through the
 * `txn` handed to its closure, which `storage.get` never sees, so `storage.transaction` is
 * patched to hand it a txn whose `get` holds the same way. The first read of `key` through
 * either waits, and only that one. A hold that reached neither would never fire, and every
 * case goes on to wait for it (`until(() => hold.held)`), so a setup that holds nothing
 * fails there instead of passing for the wrong reason.
 *
 * The patch is on the object's storage, which is not an RPC target, so it works on the
 * instance. The abort in afterEach discards the instance. The wait polls a timer rather than
 * awaiting a promise made by the test, because the object is waiting on something only
 * another request can change.
 */
async function holdFirstReadOf(name: string, key: string, hold: Hold): Promise<void> {
  await runInDurableObject<AuthDO, void>(auth(name), (_instance, ctx) => {
    type Call = (...args: unknown[]) => Promise<unknown>;
    const storage = ctx.storage as unknown as { get: Call; transaction: Call };
    let first = true;

    /** `get`, answering as it did, but parked after the first read of `key`. */
    const holding = (get: Call): Call => async (...args) => {
      const value = await get(...args);
      if (first && args[0] === key) {
        first = false;
        hold.held = true;
        await until(() => hold.released, "the hold to be released", 15_000);
      }
      return value;
    };
    const holdingTxn = (txn: object) => new Proxy(txn, {
      get(target, prop) {
        const member = Reflect.get(target, prop, target) as unknown;
        if (typeof member !== "function") return member;
        const bound = (member as Call).bind(target);
        return prop === "get" ? holding(bound) : bound;
      },
    });

    const get = storage.get.bind(storage);
    const transaction = storage.transaction.bind(storage);
    Object.defineProperty(ctx.storage, "get", { configurable: true, value: holding(get) });
    Object.defineProperty(ctx.storage, "transaction", {
      configurable: true,
      value: (closure: (txn: object) => Promise<unknown>, ...rest: unknown[]) =>
        transaction((txn: object) => closure(holdingTxn(txn)), ...rest),
    });
  });
}

/** Rows written straight into an object's storage as setup, before any hold is installed. */
const seed = (name: string, rows: Record<string, unknown>) =>
  runInDurableObject<AuthDO, void>(auth(name), async (_instance, ctx) => { await ctx.storage.put(rows); });

/** The keys an object holds under `prefix`, read by listing, which no hold looks at. */
const keysUnder = (name: string, prefix: string) =>
  runInDurableObject<AuthDO, string[]>(auth(name), async (_instance, ctx) =>
    [...(await ctx.storage.list({ prefix })).keys()]);

describe("admitRegistration, the first call held between its read and its write", () => {
  const NOW = Date.now();

  /** Permanent, so nothing here lapses and the purge has nothing to take. */
  const client = (id: string): RegisteredClient => ({
    client_id: id, redirect_uris: [], created_at: 1, expires_at: null,
  });
  const admit = async (name: string, id: string, ip: string | null) =>
    auth(name).admitRegistration(client(id), ip, NOW);

  it("admits exactly one of two registrations when one slot is left under the cap", async () => {
    // The object has counted: its counter says one short of the cap. Nothing else about it
    // matters, and the rows themselves are not needed to put it there.
    const name = "race-cap";
    await seed(name, { [CLIENT_COUNT_KEY]: CLIENT_CAP - 1 });
    const hold = newHold();
    await holdFirstReadOf(name, CLIENT_COUNT_KEY, hold);

    const first = track(admit(name, "c_first", null)); // reads the count, then is held
    await until(() => hold.held, "the first registration to be held");
    const second = track(admit(name, "c_second", null));
    // Not asserted: whether the second waits its turn or finishes first. What matters is
    // that it has had its chance to, before the first is allowed to write.
    await settlesWithin(second, 300);
    hold.release();
    const outcomes = await Promise.all([first, second]);

    const clients = await keysUnder(name, "client:");
    const where = `the calls answered ${outcomes.join(" and ")}; the object stores `
      + `${clients.length} client(s) against a cap of ${CLIENT_CAP}`;
    expect([...outcomes].sort(), where).toEqual(["full", "ok"]);
    expect(clients, where).toHaveLength(1);
    expect(await auth(name).countClients(), where).toBe(CLIENT_CAP);
  });

  it("admits exactly one of two registrations from one address when one is left in its window", async () => {
    // The address has used all but one of its allowance, inside the hour. The count of
    // clients is left unseeded, as on any object that has not met the cap.
    const name = "race-window";
    const ip = "203.0.113.9";
    const used = Array.from({ length: REGISTRATIONS_PER_HOUR - 1 }, (_, i) => NOW - 60_000 - i);
    await seed(name, { [`reg:${ip}`]: used });
    const hold = newHold();
    await holdFirstReadOf(name, `reg:${ip}`, hold);

    const first = track(admit(name, "c_first", ip)); // reads the address's bucket, then is held
    await until(() => hold.held, "the first registration to be held");
    const second = track(admit(name, "c_second", ip));
    await settlesWithin(second, 300);
    hold.release();
    const outcomes = await Promise.all([first, second]);

    const clients = await keysUnder(name, "client:");
    const where = `the calls answered ${outcomes.join(" and ")}; the object stores `
      + `${clients.length} client(s) for an address allowed ${REGISTRATIONS_PER_HOUR} an hour `
      + `that had used ${used.length}`;
    expect([...outcomes].sort(), where).toEqual(["ok", "rate_limited"]);
    expect(clients, where).toHaveLength(1);
  });
});

describe("a session method, the first call held between its read and its write", () => {
  const T0 = 1_700_000_000_000;
  const IDENTITY: Identity = {
    userId: "u_github_4242", orgId: null, plan: "free", role: "member", label: "jesse@example.dev",
  };
  const REPLANNED: Identity = { ...IDENTITY, plan: "pro" };

  /** Idle since T0, so a touch a little later than the touch interval has a write to make. */
  const panelSession = (): PanelSession => ({
    identity: IDENTITY, plan_source: "default", identity_keys: ["github:4242"],
    created_at: T0, last_used_at: T0, replanned_at: T0, expires_at: T0 + SESSION_TTL_MS,
  });
  const STALE = T0 + SESSION_TOUCH_MS + 1;

  const touch = async (name: string, now: number) => auth(name).touchSession("sid", now);
  const replan = async (name: string, now: number) =>
    auth(name).replanSession("sid", REPLANNED, "grant", now);
  const storedSession = (name: string) =>
    runInDurableObject<AuthDO, PanelSession | undefined>(auth(name), (_instance, ctx) =>
      ctx.storage.get<PanelSession>("sess:sid"));

  /** A stored session, checked, with the first read of it held. */
  async function heldSession(name: string): Promise<Hold> {
    await auth(name).putSession("sid", panelSession());
    expect(await keysUnder(name, "sess:"), "control: the session is stored").toEqual(["sess:sid"]);
    const hold = newHold();
    await holdFirstReadOf(name, "sess:sid", hold);
    return hold;
  }

  describe("touchSession", () => {
    it("does not let an earlier touch write over a later one", async () => {
      const name = "race-touch-touch";
      const hold = await heldSession(name);
      const later = STALE + SESSION_TOUCH_MS + 1;

      const first = track(touch(name, STALE)); // reads the session, then is held
      await until(() => hold.held, "the first touch to be held");
      const second = track(touch(name, later));
      await settlesWithin(second, 300);
      hold.release();
      await Promise.all([first, second]);

      expect(
        (await storedSession(name))?.last_used_at,
        `the later touch (${later}) was written over by the earlier one (${STALE})`
      ).toBe(later);
    });

    it("leaves a session signed out while the touch was held signed out", async () => {
      const name = "race-touch-signout";
      const hold = await heldSession(name);

      const first = track(touch(name, STALE)); // reads a live session, then is held
      await until(() => hold.held, "the touch to be held");
      const second = track(auth(name).deleteSession("sid"));
      await settlesWithin(second, 300);
      hold.release();
      await Promise.all([first, second]);

      expect(await keysUnder(name, "sess:"), "the session was signed out and is stored again")
        .toEqual([]);
    });
  });

  describe("replanSession", () => {
    it("leaves a session signed out while the replan was held signed out", async () => {
      const name = "race-replan-signout";
      const hold = await heldSession(name);

      const first = track(replan(name, T0 + 5)); // reads a live session, then is held
      await until(() => hold.held, "the replan to be held");
      const second = track(auth(name).deleteSession("sid"));
      await settlesWithin(second, 300);
      hold.release();
      await Promise.all([first, second]);

      expect(await keysUnder(name, "sess:"), "the session was signed out and is stored again")
        .toEqual([]);
    });

    it("keeps a touch that landed while the replan was held", async () => {
      const name = "race-replan-touch";
      const hold = await heldSession(name);

      const first = track(replan(name, T0 + 5)); // reads the record as it is now, then is held
      await until(() => hold.held, "the replan to be held");
      const second = track(touch(name, STALE)); // stale enough to write last_used_at
      await settlesWithin(second, 300);
      hold.release();
      await Promise.all([first, second]);

      const stored = await storedSession(name);
      expect(stored?.last_used_at, `the touch (${STALE}) was reverted to what the replan read (${T0})`)
        .toBe(STALE);
      // Neither write may have cost the other: the replan's merge is there too.
      expect(stored?.identity, "the replan's identity was lost").toEqual(REPLANNED);
      expect(stored?.plan_source).toBe("grant");
    });
  });
});
