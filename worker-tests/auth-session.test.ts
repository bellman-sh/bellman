/**
 * AuthDO's session methods, in real workerd. src/oauth/store.ts imports
 * cloudflare:workers, so the Node program cannot load it; the object is reached
 * here the way the Worker reaches it, through a stub.
 *
 * AuthStorage has no conformance suite the way BellmanStore does, and two
 * hand-written implementations of one interface are exactly where behaviour
 * drifts. So each store-level test in tests/panel-session.test.ts has a twin
 * here, against the real object, and a change to one is a change to the other.
 * Its tests of the pure functions (sessionDead, replannedAt) have none: the
 * object calls the first rather than copying it, which the boundary twins below
 * hold it to, and never sees the second. The sweep exists only in the object and
 * is covered only here, and some tests here read storage, which the in-memory
 * store does not expose.
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

/**
 * A fixed instant in the past. putSession sweeps with the object's own clock, so
 * a session built from this is long dead by the time the sweep looks at it, and a
 * second put on the same object would remove the first. The tests that use it
 * therefore put once per object; the sweep tests build theirs from Date.now().
 */
const T0 = 1_700_000_000_000;

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

  // The skip is a decision not to write, which the record a touch returns cannot
  // show: a touch that stored the new time and handed back the stale record would
  // pass every assertion made through its return value. This reads what is
  // stored.
  it("does not write last_used_at while it is fresh", async () => {
    const o = auth("s-skip-storage");
    await o.putSession("sid", panelSession());

    await o.touchSession("sid", T0 + SESSION_TOUCH_MS); // exactly the threshold: a skip

    expect((await storedSession("s-skip-storage", "sid"))?.last_used_at).toBe(T0);
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
  // ends dead. A touchSession that yielded to the event loop between deciding to
  // write and writing would let the delete in between, and its write would
  // bring the record back. The same assertion Task 1 makes of MemoryAuthStore.
  it("is not undone by a sign-out sent alongside a touch", async () => {
    const o = auth("s-touch-inflight");
    await o.putSession("sid", panelSession());
    const now = T0 + SESSION_TOUCH_MS + 1; // stale enough that the touch writes

    await Promise.all([o.touchSession("sid", now), o.deleteSession("sid")]);

    expect(await storedIds("s-touch-inflight")).toEqual([]);
  });
});

describe("AuthDO session sweep", () => {
  const HOUR = 60 * 60 * 1000;

  /**
   * Put a live session, then a dead one, then a third whose put runs the last
   * sweep, and return the ids stored afterwards.
   *
   * putSession sweeps before it writes, so a session put last is never looked at
   * by its own call. A live session put after the dead one would be stored
   * because of the order it was written in, whatever the sweep did, and the
   * assertion would hold for a sweep that deleted everything. So the live one
   * goes first and is present for two sweeps, and what is asserted is the whole
   * set that survives, not only that the dead one is gone.
   *
   * The live session is an hour short of both limits, idle for 23 of its 24
   * hours and an hour from its ceiling. That is close enough that a sweep with a
   * shorter idle bound, or a clock running ahead, would take it, and far enough
   * that this test's own clock cannot.
   *
   * The result is read with storedIds: touchSession drops a dead session itself
   * when it reads one, so it cannot show what the sweep left behind.
   */
  async function sweptIds(name: string, now: number, dead: Partial<PanelSession>) {
    const o = auth(name);
    await o.putSession("a-live", panelSession({
      created_at: now + HOUR - SESSION_TTL_MS,
      last_used_at: now - 23 * HOUR,
      expires_at: now + HOUR,
    }));
    await o.putSession("b-dead", panelSession(dead));
    await o.putSession("c-trigger", panelSession({
      created_at: now, last_used_at: now, replanned_at: now,
      expires_at: now + SESSION_TTL_MS,
    }));
    return storedIds(name);
  }

  /**
   * The sweep's predicate has to be sessionDead rather than #purge's expires_at
   * test: a session can die of idleness with its ceiling a week away, and the
   * expires_at form would leave it stored for the full seven days.
   */
  it("sweeps a session that died of idleness, not only one past its ceiling, and keeps the live ones", async () => {
    const now = Date.now();
    const ids = await sweptIds("s-sweep-idle", now, {
      created_at: now - 2 * SESSION_IDLE_MS,
      last_used_at: now - 2 * SESSION_IDLE_MS,
      expires_at: now + SESSION_TTL_MS,
    });

    expect(ids).toEqual(["sess:a-live", "sess:c-trigger"]);
  });

  // The other clause. Just used, so it is not idle; only the ceiling kills it.
  it("sweeps a session past its ceiling, although it was just used, and keeps the live ones", async () => {
    const now = Date.now();
    const ids = await sweptIds("s-sweep-ceiling", now, {
      created_at: now - SESSION_TTL_MS - 1_000,
      last_used_at: now,
      expires_at: now - 1,
    });

    expect(ids).toEqual(["sess:a-live", "sess:c-trigger"]);
  });
});

describe("AuthDO replanSession", () => {
  it("merges the identity, plan source and time into the stored record, and nothing else", async () => {
    const o = auth("s-replan");
    await o.putSession("sid", panelSession());

    await o.replanSession("sid", REPLANNED, "grant", T0 + 5);

    expect(await o.touchSession("sid", T0 + 5)).toEqual(
      panelSession({ identity: REPLANNED, plan_source: "grant", replanned_at: T0 + 5 })
    );
  });

  // The race this method exists for: a request touches the session, spends a
  // while re-resolving its plan, and writes the result back, and the human signs
  // out in between. An upsert would recreate the session they just ended.
  //
  // Storage is read before the touch, which would clear away what it was meant
  // to find. The touch is there too, as the behaviour that matters, but it
  // cannot catch an upsert on its own: the record that would be written holds
  // only the three merged fields, which sessionDead reads as dead.
  it("leaves a session dead when the sign-out landed between the touch and the replan", async () => {
    const o = auth("s-replan-delete");
    await o.putSession("sid", panelSession());
    await o.touchSession("sid", T0);
    await o.deleteSession("sid");

    await o.replanSession("sid", REPLANNED, "grant", T0 + 1);

    expect(await storedIds("s-replan-delete")).toEqual([]);
    expect(await o.touchSession("sid", T0 + 1)).toBeUndefined();
  });

  // The input gate is what keeps a sign-out from landing between this method's
  // read and its write. Sent together, the delete is delivered either before the
  // call or after it, and either way the session ends dead. A replanSession that
  // yielded to the event loop between its read and its write would let the
  // delete in between, and its write would bring the record back.
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

    await o.replanSession("sid", REPLANNED, "grant", mine);

    expect(await o.touchSession("sid", theirs + SESSION_IDLE_MS)).toBeDefined();
  });
});
