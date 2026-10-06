/**
 * AuthDO's session methods, in real workerd. src/oauth/store.ts imports
 * cloudflare:workers, so the Node program cannot load it; the object is reached
 * here the way the Worker reaches it, through a stub.
 *
 * AuthStorage has no conformance suite the way BellmanStore does, and two
 * hand-written implementations of one interface are exactly where behaviour
 * drifts. So each store-level test in tests/panel-session.test.ts has a twin
 * here, against the real object, and a change to one is a change to the other.
 * Its tests of the pure functions (sessionDead, replannedAt) have none. The
 * object calls sessionDead from two places, touchSession and the sweep, rather
 * than copying it. The twins below hold touchSession's call to that only as far
 * as they reach: both limits, and a NaN last_used_at. A copy written as the
 * negation of the two limits would pass them without sessionDead's finiteness
 * guards, because NaN fails closed in that form; Infinity and the other
 * non-finite values are pinned on the function itself, in Node. Nothing holds the
 * sweep's call at its limits: its tests keep an hour of margin and never sit on
 * one, so a sweep that re-inlined the predicate with exclusive limits, or in the
 * negation form, would pass them. The sweep exists only in the object and is
 * covered only here, and some tests here read storage or count writes, which the
 * in-memory store does not expose.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AuthDO } from "../src/oauth/store.js";
import {
  SESSION_IDLE_MS, SESSION_TOUCH_MS, SESSION_TTL_MS, type PanelSession,
} from "../src/oauth/storage.js";
import type { Identity } from "../src/types.js";

const IDENTITY: Identity = {
  userId: "u_github_4242", orgId: null, plan: "free", role: "member",
  label: "jesse@example.dev",
};
const REPLANNED: Identity = { ...IDENTITY, plan: "pro" };
/** Someone else, for the sessions a method has no business touching. */
const OTHER: Identity = { ...IDENTITY, userId: "u_github_9999", label: "sam@example.dev" };

/**
 * A fixed instant in the past. putSession sweeps with the object's own clock, so
 * a session built from this is long dead by the time the sweep looks at it, and a
 * second put on the same object would remove the first. The tests that use it
 * therefore put once per object; the tests that need several sessions build
 * theirs from Date.now().
 */
const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

const panelSession = (over: Partial<PanelSession> = {}): PanelSession => ({
  identity: IDENTITY, plan_source: "default", identity_keys: ["github:4242"],
  created_at: T0, last_used_at: T0, replanned_at: T0,
  expires_at: T0 + SESSION_TTL_MS, ...over,
});

/** A fresh AuthDO per test, so one test's sessions are not another's. */
const auth = (name: string) => env.AUTH.get(env.AUTH.idFromName(name));

/**
 * Which session ids an object has stored, read from inside it. For what
 * touchSession cannot show: it drops a dead session itself when it reads one, so
 * a record that should not be there still comes back undefined, and an assertion
 * made through it passes whether or not the record was ever stored. Read this
 * before touching, or the touch will have cleaned up what it was meant to find.
 */
const storedIds = (name: string) =>
  runInDurableObject(auth(name), async (_i: AuthDO, ctx) => [
    ...(await ctx.storage.list({ prefix: "sess:" })).keys(),
  ]);

/** The record an object holds under an id, read from inside it. */
const storedSession = (name: string, id: string) =>
  runInDurableObject(auth(name), async (_i: AuthDO, ctx) =>
    ctx.storage.get<PanelSession>(`sess:${id}`));

describe("AuthDO sessions", () => {
  it("stores and returns a session", async () => {
    const o = auth("s-store");
    await o.putSession("sid", panelSession());

    expect((await o.touchSession("sid", T0))?.identity.userId).toBe("u_github_4242");
  });

  it("returns undefined for an unknown id", async () => {
    expect(await auth("s-unknown").touchSession("sid", T0)).toBeUndefined();
  });

  it("refuses a session past its ceiling", async () => {
    const o = auth("s-ceiling");
    const now = T0 + SESSION_TTL_MS + 1;
    await o.putSession("sid", panelSession({ last_used_at: now }));

    expect(await o.touchSession("sid", now)).toBeUndefined();
  });

  it("refuses a session idle past the window", async () => {
    const o = auth("s-idle");
    await o.putSession("sid", panelSession());

    expect(await o.touchSession("sid", T0 + SESSION_IDLE_MS + 1)).toBeUndefined();
  });

  // The limits of sessionDead, asked of the object. The Node suite pins them on
  // the function itself; these pin that the object asks it, and does not carry a
  // copy that disagrees with it at exactly the limit.
  it("is alive exactly at the idle boundary", async () => {
    const o = auth("s-idle-boundary");
    await o.putSession("sid", panelSession());

    expect(await o.touchSession("sid", T0 + SESSION_IDLE_MS)).toBeDefined();
  });

  // Pins the ceiling as inclusive: dead strictly past expires_at, not at it.
  // last_used_at is moved up to the ceiling so the idle clause is false and the
  // ceiling comparison is the only thing deciding; left at T0 the session would
  // already be idle by then.
  it("is alive exactly at the ceiling", async () => {
    const o = auth("s-ceiling-boundary");
    await o.putSession("sid", panelSession({ last_used_at: T0 + SESSION_TTL_MS }));

    expect(await o.touchSession("sid", T0 + SESSION_TTL_MS)).toBeDefined();
  });

  // The order touchSession keeps: the dead check ahead of the touch check. A NaN
  // last_used_at fails the touch comparison, so a record holding one would read
  // as not due and be served unless it is refused first. It also holds the object
  // to sessionDead's refusal of a time that is not a finite number.
  it("refuses a record whose last_used_at is NaN", async () => {
    const o = auth("s-nan");
    await o.putSession("sid", panelSession({ last_used_at: NaN }));

    expect(await o.touchSession("sid", T0)).toBeUndefined();
  });

  it("drops a dead session, so a clock moving back cannot revive it", async () => {
    const o = auth("s-terminal");
    await o.putSession("sid", panelSession());
    await o.touchSession("sid", T0 + SESSION_IDLE_MS + 1);

    expect(await o.touchSession("sid", T0)).toBeUndefined();
  });

  it("deleteSession makes the next touch a miss, and is idempotent", async () => {
    const o = auth("s-delete");
    await o.putSession("sid", panelSession());
    await o.deleteSession("sid");
    await o.deleteSession("sid");

    expect(await o.touchSession("sid", T0)).toBeUndefined();
  });

  it("skips the write while last_used_at is fresh", async () => {
    const o = auth("s-skip");
    await o.putSession("sid", panelSession());

    expect((await o.touchSession("sid", T0 + SESSION_TOUCH_MS - 1))?.last_used_at).toBe(T0);
  });

  // Pins the threshold at exactly SESSION_TOUCH_MS: a value that stale is still
  // fresh enough to skip, which is the boundary two copies of the comparison
  // could disagree on.
  it("skips the write at exactly SESSION_TOUCH_MS", async () => {
    const o = auth("s-threshold");
    await o.putSession("sid", panelSession());

    expect((await o.touchSession("sid", T0 + SESSION_TOUCH_MS))?.last_used_at).toBe(T0);
  });

  // The skip is a decision not to write, and only a count of the writes can see
  // it. The record a touch returns cannot: one that stored the new time and handed
  // back the stale record passes every assertion made through its return value.
  // Nor can the stored value, because a write of the record already there leaves
  // it unchanged. So this counts the puts the object makes inside it: through
  // storage.put, and through the txn handed to a storage.transaction closure, which
  // is where touchSession writes. A counter that saw only the first would read zero
  // for a write made through a transaction. The second touch is the positive
  // control that says so: it is one past the threshold and must count exactly one
  // write, which shows the counter sees real ones. It counts puts and nothing else:
  // a skip path that wrote some other way would not be counted.
  it("does not put while last_used_at is fresh, and does once it is stale", async () => {
    const o = auth("s-put-count");
    await o.putSession("sid", panelSession());

    const [skipped, stale] = await runInDurableObject(o, async (instance: AuthDO, ctx) => {
      type Call = (...a: unknown[]) => Promise<unknown>;
      const storage = ctx.storage as unknown as { put: Call; transaction: Call };
      const real = storage.put.bind(storage);
      const open = storage.transaction.bind(storage);
      let puts = 0;
      storage.put = (...a: unknown[]) => { puts++; return real(...a); };
      storage.transaction = (closure: unknown, ...rest: unknown[]) =>
        open((txn: object) => (closure as (txn: object) => Promise<unknown>)(new Proxy(txn, {
          get(target, prop) {
            const member = Reflect.get(target, prop, target) as unknown;
            if (typeof member !== "function") return member;
            const bound = (member as Call).bind(target);
            return prop === "put" ? (...a: unknown[]) => { puts++; return bound(...a); } : bound;
          },
        })), ...rest);
      try {
        await instance.touchSession("sid", T0 + SESSION_TOUCH_MS); // exactly the threshold: a skip
        const afterSkip = puts;
        await instance.touchSession("sid", T0 + SESSION_TOUCH_MS + 1); // one past it: a write
        return [afterSkip, puts - afterSkip];
      } finally {
        delete (storage as { put?: unknown }).put;
        delete (storage as { transaction?: unknown }).transaction;
      }
    });

    expect(skipped).toBe(0);
    expect(stale).toBe(1);
  });

  it("writes last_used_at once it is stale", async () => {
    const o = auth("s-write");
    await o.putSession("sid", panelSession());
    const now = T0 + SESSION_TOUCH_MS + 1;

    expect((await o.touchSession("sid", now))?.last_used_at).toBe(now);
  });

  // Touched again less than SESSION_TOUCH_MS after the value just written, so
  // only a stored write can produce `now`. Asked again at the same instant, an
  // object that returned the write without keeping it would answer identically:
  // stale again, so it writes again.
  it("persists the last_used_at it writes", async () => {
    const o = auth("s-persist");
    await o.putSession("sid", panelSession());
    const now = T0 + SESSION_TOUCH_MS + 1;
    await o.touchSession("sid", now);

    expect((await o.touchSession("sid", now + SESSION_TOUCH_MS - 1))?.last_used_at).toBe(now);
  });

  /** The same assertion Task 1 makes of MemoryAuthStore. Both or neither. */
  it("does not expire a session used continuously past the idle window", async () => {
    const o = auth("s-continuous");
    await o.putSession("sid", panelSession());

    const step = 30 * 60 * 1000;
    for (let now = T0; now < T0 + 3 * SESSION_IDLE_MS; now += step) {
      expect(await o.touchSession("sid", now), `dead at +${now - T0}ms`).toBeDefined();
    }
  });

  // The bound SESSION_TOUCH_MS's comment states, written out as 23 hours rather
  // than as SESSION_IDLE_MS minus SESSION_TOUCH_MS, so that changing either
  // constant fails the two tests below and the comment is rewritten with it. It
  // is measured from the worst case: the last request skipped the write, so
  // last_used_at lags it by exactly the threshold. A request that had written
  // would buy up to an hour more.
  const GUARANTEED_GAP = 23 * 60 * 60 * 1000;

  it("survives a gap of SESSION_IDLE_MS minus SESSION_TOUCH_MS after a skipped write", async () => {
    const o = auth("s-bound-survives");
    await o.putSession("sid", panelSession());
    // Stale by exactly the threshold, which is the most a skipped write leaves.
    const skipped = T0 + SESSION_TOUCH_MS;
    await o.touchSession("sid", skipped);

    expect(await o.touchSession("sid", skipped + GUARANTEED_GAP)).toBeDefined();
  });

  it("dies one millisecond past SESSION_IDLE_MS minus SESSION_TOUCH_MS after a skipped write", async () => {
    const o = auth("s-bound-dies");
    await o.putSession("sid", panelSession());
    const skipped = T0 + SESSION_TOUCH_MS;
    await o.touchSession("sid", skipped);

    expect(await o.touchSession("sid", skipped + GUARANTEED_GAP + 1)).toBeUndefined();
  });

  // The window touchSession is one call to close. Sent together, a sign-out is
  // delivered either before the touch or after it, and either way the session
  // ends dead. That is the plain race, and it cannot tell a transaction from the
  // input gate: while every await between the read and the write is storage, the
  // gate serialises the two and this passes without one. worker-tests/
  // auth-race.test.ts holds the touch open between its read and its write, which
  // can. The same assertion Task 1 makes of MemoryAuthStore.
  it("is not undone by a sign-out sent alongside a touch", async () => {
    const o = auth("s-touch-inflight");
    await o.putSession("sid", panelSession());
    const now = T0 + SESSION_TOUCH_MS + 1; // stale enough that the touch writes

    await Promise.all([o.touchSession("sid", now), o.deleteSession("sid")]);

    expect(await storedIds("s-touch-inflight")).toEqual([]);
  });
});

/**
 * AuthDO is one object holding every session on the deployment, so a method that
 * wrote to the wrong record, or to all of them, would be the worst failure it can
 * have, and it passes any test that gives the object a single session. "The
 * session I named changed" has a second producer, "every session changed".
 *
 * So each test here keeps a second session the method has no business touching,
 * and asserts it survives unchanged. A storage method's tests need one of these.
 * The sessions are built from Date.now() and not T0, because the second put
 * sweeps and a T0 session is dead by the object's own clock.
 */
describe("AuthDO: a method touches only the session it names", () => {
  it("deleteSession ends only the session it names", async () => {
    const o = auth("s-delete-only");
    const now = Date.now();
    const live = panelSession({
      created_at: now, last_used_at: now, replanned_at: now, expires_at: now + SESSION_TTL_MS,
    });
    await o.putSession("one", live);
    await o.putSession("two", live);

    await o.deleteSession("one");

    expect(await storedIds("s-delete-only")).toEqual(["sess:two"]);
    // Survives means unchanged, not only still there.
    expect(await storedSession("s-delete-only", "two")).toEqual(live);
  });

  it("touchSession and replanSession change only the session they name", async () => {
    const name = "s-isolation";
    const o = auth(name);
    const now = Date.now();
    const mine = panelSession({
      created_at: now - 2 * HOUR, last_used_at: now - 2 * HOUR, replanned_at: now - 2 * HOUR,
      expires_at: now + SESSION_TTL_MS,
    });
    const yours = { ...mine, identity: OTHER, identity_keys: ["github:9999"] };
    await o.putSession("mine", mine);
    await o.putSession("yours", yours);

    // Two hours stale, so this touch writes.
    expect((await o.touchSession("mine", now))?.identity.userId).toBe("u_github_4242");
    expect(await o.replanSession("mine", REPLANNED, "grant", now)).toBe(true);

    expect(await storedSession(name, "yours")).toEqual(yours);
    // And each id answers with its own record.
    expect((await o.touchSession("yours", now))?.identity.userId).toBe("u_github_9999");
    // Alternating, with nothing due and nothing written between, which is what
    // gives away an object that answers from the last record it served. The reads
    // above are not enough: a cache like that is cleared by every write, and each
    // of them follows one.
    expect((await o.touchSession("mine", now + 1))?.identity.userId).toBe("u_github_4242");
    expect((await o.touchSession("yours", now + 1))?.identity.userId).toBe("u_github_9999");
    expect((await o.touchSession("mine", now + 1))?.identity.userId).toBe("u_github_4242");
  });

  // The branch every returning browser with an expired cookie runs, and the one
  // destructive path in touchSession. AuthDO also holds the registered clients,
  // the refresh tokens and the billing ledger, so a drop that removed more than
  // the one session would take them too.
  it("dropping a dead session removes that one and leaves the others", async () => {
    const name = "s-dead-drop";
    const o = auth(name);
    const now = Date.now();
    const yours = panelSession({
      created_at: now, last_used_at: now, replanned_at: now, expires_at: now + SESSION_TTL_MS,
    });
    await o.putSession("yours", yours);
    // Idle for two days, so dead by the object's own clock. Put second, so the
    // sweep inside this put runs over `yours` alone and leaves this one stored.
    await o.putSession("dead", panelSession({
      created_at: now - 48 * HOUR, last_used_at: now - 48 * HOUR, expires_at: now + SESSION_TTL_MS,
    }));
    expect(await storedIds(name)).toEqual(["sess:dead", "sess:yours"]); // precondition

    expect(await o.touchSession("dead", now)).toBeUndefined();

    expect(await storedIds(name)).toEqual(["sess:yours"]);
    // Survives means unchanged, not only still there.
    expect(await storedSession(name, "yours")).toEqual(yours);
  });
});

describe("AuthDO session sweep", () => {
  /** The live session the sweep must leave alone, as it is put. */
  const liveRecord = (now: number) => panelSession({
    created_at: now + HOUR - SESSION_TTL_MS,
    last_used_at: now - 23 * HOUR,
    expires_at: now + HOUR,
  });

  /**
   * Put a live session, then a dead one, then a third whose put runs the last
   * sweep, and return the ids stored afterwards and the live session as stored.
   *
   * putSession sweeps before it writes, so a session put last is never looked at
   * by its own call. A live session put after the dead one would be stored
   * because of the order it was written in, whatever the sweep did, and the
   * assertion would hold for a sweep that deleted everything. So the live one
   * goes first and is present for two sweeps, and what is asserted is the whole
   * set that survives, not only that the dead one is gone.
   *
   * Survives means unchanged, not only still there: the live session's stored
   * content is returned too, to be compared with the record that was put. A sweep
   * that rewrote every live session with a refreshed last_used_at would leave its
   * key and defeat the idle timeout, and a set of ids cannot see it.
   *
   * The live session is an hour short of both limits, idle for 23 of its 24
   * hours and an hour from its ceiling. That is close enough that a sweep with a
   * shorter idle bound, or a clock running ahead, would take it, and far enough
   * that this test's own clock cannot.
   *
   * The result is read with storedIds: touchSession drops a dead session itself
   * when it reads one, so it cannot show what the sweep left behind.
   */
  async function swept(name: string, now: number, dead: Partial<PanelSession>) {
    const o = auth(name);
    await o.putSession("a-live", liveRecord(now));
    await o.putSession("b-dead", panelSession(dead));
    await o.putSession("c-trigger", panelSession({
      created_at: now, last_used_at: now, replanned_at: now,
      expires_at: now + SESSION_TTL_MS,
    }));
    return { ids: await storedIds(name), live: await storedSession(name, "a-live") };
  }

  /**
   * The sweep's predicate has to be sessionDead rather than #purge's expires_at
   * test: a session can die of idleness with its ceiling a week away, and the
   * expires_at form would leave it stored for the full seven days.
   */
  it("sweeps a session that died of idleness, not only one past its ceiling, and keeps the live ones", async () => {
    const now = Date.now();
    const { ids, live } = await swept("s-sweep-idle", now, {
      created_at: now - 2 * SESSION_IDLE_MS,
      last_used_at: now - 2 * SESSION_IDLE_MS,
      expires_at: now + SESSION_TTL_MS,
    });

    expect(ids).toEqual(["sess:a-live", "sess:c-trigger"]);
    expect(live).toEqual(liveRecord(now));
  });

  // The other clause. Just used, so it is not idle; only the ceiling kills it.
  it("sweeps a session past its ceiling, although it was just used, and keeps the live ones", async () => {
    const now = Date.now();
    const { ids, live } = await swept("s-sweep-ceiling", now, {
      created_at: now - SESSION_TTL_MS - 1_000,
      last_used_at: now,
      expires_at: now - 1,
    });

    expect(ids).toEqual(["sess:a-live", "sess:c-trigger"]);
    expect(live).toEqual(liveRecord(now));
  });
});

describe("AuthDO replanSession", () => {
  it("merges the identity, plan source and time into the stored record, and nothing else", async () => {
    const o = auth("s-replan");
    await o.putSession("sid", panelSession());

    const merged = await o.replanSession("sid", REPLANNED, "grant", T0 + 5);

    expect(merged).toBe(true);
    expect(await o.touchSession("sid", T0 + 5)).toEqual(
      panelSession({ identity: REPLANNED, plan_source: "grant", replanned_at: T0 + 5 })
    );
  });

  // The race this method exists for: a request touches the session, spends a
  // while re-resolving its plan, and writes the result back, and the human signs
  // out in between. An upsert would recreate the session they just ended.
  //
  // The answer and the stored ids are each enough to see a missing absence
  // guard. Storage is read before the touch, which would clear away what it was
  // meant to find, and the touch is there for the behaviour that matters: on its
  // own it cannot catch an upsert, because the record that would be written holds
  // only the three merged fields, which sessionDead reads as dead.
  it("leaves a session dead when the sign-out landed between the touch and the replan", async () => {
    const o = auth("s-replan-delete");
    await o.putSession("sid", panelSession());
    await o.touchSession("sid", T0);
    await o.deleteSession("sid");

    const merged = await o.replanSession("sid", REPLANNED, "grant", T0 + 1);

    expect(merged).toBe(false);
    expect(await storedIds("s-replan-delete")).toEqual([]);
    expect(await o.touchSession("sid", T0 + 1)).toBeUndefined();
  });

  // A sign-out must not land between this method's read and its write. Sent
  // together, the delete is delivered either before the call or after it, and
  // either way the session ends dead. As for touchSession, that is the plain race
  // and it cannot tell a transaction from the input gate; worker-tests/
  // auth-race.test.ts holds the replan open between its read and its write.
  it("is not undone by a sign-out sent alongside it", async () => {
    const o = auth("s-replan-inflight");
    await o.putSession("sid", panelSession());

    await Promise.all([
      o.replanSession("sid", REPLANNED, "grant", T0 + 1),
      o.deleteSession("sid"),
    ]);

    expect(await storedIds("s-replan-inflight")).toEqual([]);
  });

  // Another request touches the session between this one's touch and its
  // write-back, and the session has to stay as alive as that request left it.
  // Checked at the far end of the idle window that touch bought: a replan that
  // pulled last_used_at back to this request's time would be dead by then.
  it("keeps a last_used_at that another request bumped in the meantime", async () => {
    const o = auth("s-replan-keeps");
    await o.putSession("sid", panelSession());
    const mine = T0 + SESSION_TOUCH_MS + 1;
    await o.touchSession("sid", mine); // this request: stale enough to write
    const theirs = mine + SESSION_TOUCH_MS + 1;
    await o.touchSession("sid", theirs); // another request, later

    const merged = await o.replanSession("sid", REPLANNED, "grant", mine);

    expect(merged).toBe(true);
    expect(await o.touchSession("sid", theirs + SESSION_IDLE_MS)).toBeDefined();
  });
});
