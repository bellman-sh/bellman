/**
 * AuthDO's session methods, in real workerd. src/oauth/store.ts imports
 * cloudflare:workers, so the Node program cannot load it; the object is reached
 * here the way the Worker reaches it, through a stub.
 *
 * AuthStorage has no conformance suite the way BellmanStore does, and two
 * hand-written implementations of one interface are exactly where behaviour
 * drifts. So most of this file repeats, against the real object, what
 * tests/panel-session.test.ts asserts of MemoryAuthStore, and a change to one is
 * a change to the other. The sweep has no in-memory counterpart and is covered
 * only here.
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
  /**
   * Store `dead`, then a live session. putSession sweeps before it writes, so
   * the second put is the one that runs the sweep over the first. The result is
   * read with storedIds: a session the sweep left behind still comes back
   * undefined from touchSession, which drops it on read.
   */
  async function putDeadThenLive(name: string, now: number, dead: Partial<PanelSession>) {
    const o = auth(name);
    await o.putSession("dead", panelSession(dead));
    await o.putSession("live", panelSession({
      created_at: now, last_used_at: now, replanned_at: now,
      expires_at: now + SESSION_TTL_MS,
    }));
  }

  /**
   * The sweep's predicate has to be sessionDead rather than #purge's expires_at
   * test: a session can die of idleness with its ceiling a week away, and the
   * expires_at form would leave it stored for the full seven days.
   */
  it("sweeps a session that died of idleness, not only one past its ceiling", async () => {
    const now = Date.now();
    await putDeadThenLive("s-sweep-idle", now, {
      created_at: now - 2 * SESSION_IDLE_MS,
      last_used_at: now - 2 * SESSION_IDLE_MS,
      expires_at: now + SESSION_TTL_MS,
    });

    expect(await storedIds("s-sweep-idle")).toEqual(["sess:live"]);
  });

  // The other clause. Just used, so it is not idle; only the ceiling kills it.
  it("sweeps a session past its ceiling, although it was just used", async () => {
    const now = Date.now();
    await putDeadThenLive("s-sweep-ceiling", now, {
      created_at: now - SESSION_TTL_MS - 1_000,
      last_used_at: now,
      expires_at: now - 1,
    });

    expect(await storedIds("s-sweep-ceiling")).toEqual(["sess:live"]);
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
