import { describe, expect, it } from "vitest";
import {
  MemoryAuthStore, SESSION_IDLE_MS, SESSION_TOUCH_MS, SESSION_TTL_MS,
  replannedAt, sessionDead, type PanelSession,
} from "../src/oauth/storage.js";
import type { Identity } from "../src/types.js";

const IDENTITY: Identity = {
  userId: "u_github_4242",
  orgId: null,
  plan: "free",
  role: "member",
  label: "jesse@example.dev",
};

const T0 = 1_700_000_000_000;

function panelSession(over: Partial<PanelSession> = {}): PanelSession {
  return {
    identity: IDENTITY,
    plan_source: "default",
    identity_keys: ["github:4242"],
    created_at: T0,
    last_used_at: T0,
    replanned_at: T0,
    expires_at: T0 + SESSION_TTL_MS,
    ...over,
  };
}

describe("sessionDead", () => {
  it("is alive when fresh", () => {
    expect(sessionDead(panelSession(), T0)).toBe(false);
  });

  it("is dead past the ceiling, even if just used", () => {
    const s = panelSession({ last_used_at: T0 + SESSION_TTL_MS + 1 });
    expect(sessionDead(s, T0 + SESSION_TTL_MS + 1)).toBe(true);
  });

  it("is dead when idle past the window, with the ceiling still ahead", () => {
    const now = T0 + SESSION_IDLE_MS + 1;
    expect(now).toBeLessThan(panelSession().expires_at);
    expect(sessionDead(panelSession(), now)).toBe(true);
  });

  it("is alive exactly at the idle boundary", () => {
    expect(sessionDead(panelSession(), T0 + SESSION_IDLE_MS)).toBe(false);
  });

  // Pins the ceiling as inclusive: dead strictly past expires_at, not at it.
  // last_used_at is moved up to the ceiling so the idle clause is false and the
  // ceiling comparison is the only thing deciding; left at T0 the session would
  // already be idle by then.
  it("is alive exactly at the ceiling", () => {
    const s = panelSession({ last_used_at: T0 + SESSION_TTL_MS });
    expect(sessionDead(s, T0 + SESSION_TTL_MS)).toBe(false);
  });

  // Fails closed: a record whose time is corrupt reads as dead. NaN fails every
  // comparison, so a predicate that asked whether a limit had been passed would
  // call such a session alive forever.
  it("is dead when expires_at is NaN", () => {
    expect(sessionDead(panelSession({ expires_at: NaN }), T0)).toBe(true);
  });

  it("is dead when last_used_at is NaN", () => {
    expect(sessionDead(panelSession({ last_used_at: NaN }), T0)).toBe(true);
  });

  it("is dead when now is NaN", () => {
    expect(sessionDead(panelSession(), NaN)).toBe(true);
  });
});

describe("replannedAt", () => {
  it("returns the timestamp when it is a finite number", () => {
    expect(replannedAt(panelSession({ replanned_at: T0 + 5 }))).toBe(T0 + 5);
  });

  // Zero is the answer that fails closed: it makes the plan as stale as it can
  // be, so the next request re-resolves it. The test is finiteness and not type,
  // because typeof admits NaN and the infinities, which break a subtraction
  // followed by a comparison whichever way the comparison is phrased.
  it.each([
    ["missing", undefined],
    ["a string", "123"],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
  ])("reads %s as never", (_label, value) => {
    expect(replannedAt(panelSession({ replanned_at: value as unknown as number }))).toBe(0);
  });
});

describe("MemoryAuthStore sessions", () => {
  it("stores and returns a session", async () => {
    const store = new MemoryAuthStore();
    await store.putSession("sid", panelSession());

    expect((await store.touchSession("sid", T0))?.identity.userId).toBe("u_github_4242");
  });

  it("returns undefined for an unknown id", async () => {
    expect(await new MemoryAuthStore().touchSession("nope", T0)).toBeUndefined();
  });

  it("refuses a session past its ceiling", async () => {
    const store = new MemoryAuthStore();
    const now = T0 + SESSION_TTL_MS + 1;
    await store.putSession("sid", panelSession({ last_used_at: now }));

    expect(await store.touchSession("sid", now)).toBeUndefined();
  });

  it("refuses a session idle past the window", async () => {
    const store = new MemoryAuthStore();
    await store.putSession("sid", panelSession());

    expect(await store.touchSession("sid", T0 + SESSION_IDLE_MS + 1)).toBeUndefined();
  });

  // The order touchSession keeps: the dead check ahead of the touch check. A NaN
  // last_used_at fails the touch comparison, so a corrupt record would read as
  // not due and be served unless it is refused first.
  it("refuses a record whose last_used_at is NaN", async () => {
    const store = new MemoryAuthStore();
    await store.putSession("sid", panelSession({ last_used_at: NaN }));

    expect(await store.touchSession("sid", T0)).toBeUndefined();
  });

  it("drops a dead session rather than leaving it to a sweep", async () => {
    const store = new MemoryAuthStore();
    await store.putSession("sid", panelSession());
    await store.touchSession("sid", T0 + SESSION_IDLE_MS + 1);

    // Dead is terminal: moving the clock back must not revive it.
    expect(await store.touchSession("sid", T0)).toBeUndefined();
  });

  it("deleteSession makes the next touch a miss", async () => {
    const store = new MemoryAuthStore();
    await store.putSession("sid", panelSession());
    await store.deleteSession("sid");

    expect(await store.touchSession("sid", T0)).toBeUndefined();
  });

  it("deleteSession is idempotent", async () => {
    const store = new MemoryAuthStore();
    await expect(store.deleteSession("never-existed")).resolves.toBeUndefined();
  });

  // The constraint touchSession is written around: a sign-out that lands while a
  // touch is in flight has to stay a sign-out. A touch that yielded between its
  // read and its write would be overtaken by the delete and then write the
  // record back, resurrecting a session its owner had ended.
  it("is not undone by a sign-out that lands mid-touch", async () => {
    const store = new MemoryAuthStore();
    await store.putSession("sid", panelSession());
    const now = T0 + SESSION_TOUCH_MS + 1; // stale enough that the touch writes

    const touching = store.touchSession("sid", now);
    await store.deleteSession("sid");
    await touching;

    expect(await store.touchSession("sid", now + 1)).toBeUndefined();
  });

  it("skips the write while last_used_at is fresher than SESSION_TOUCH_MS", async () => {
    const store = new MemoryAuthStore();
    await store.putSession("sid", panelSession());

    const touched = await store.touchSession("sid", T0 + SESSION_TOUCH_MS - 1);

    expect(touched?.last_used_at).toBe(T0);
  });

  // Pins the touch threshold at <=, not <: a value exactly SESSION_TOUCH_MS
  // stale is still fresh enough to skip the write.
  it("skips the write at exactly SESSION_TOUCH_MS", async () => {
    const store = new MemoryAuthStore();
    await store.putSession("sid", panelSession());

    const touched = await store.touchSession("sid", T0 + SESSION_TOUCH_MS);

    expect(touched?.last_used_at).toBe(T0);
  });

  it("writes last_used_at once it is staler than SESSION_TOUCH_MS", async () => {
    const store = new MemoryAuthStore();
    await store.putSession("sid", panelSession());
    const now = T0 + SESSION_TOUCH_MS + 1;

    expect((await store.touchSession("sid", now))?.last_used_at).toBe(now);
  });

  // Touched again less than SESSION_TOUCH_MS after the value just written, so
  // only a stored write can produce `now`. Asked again at the same instant, a
  // store that returned the write without keeping it would answer identically:
  // stale again, so it writes again.
  it("persists the last_used_at it writes", async () => {
    const store = new MemoryAuthStore();
    await store.putSession("sid", panelSession());
    const now = T0 + SESSION_TOUCH_MS + 1;
    await store.touchSession("sid", now);

    const later = await store.touchSession("sid", now + SESSION_TOUCH_MS - 1);

    expect(later?.last_used_at).toBe(now);
  });

  /**
   * Pins that skipping the write does not accumulate. Written only hourly,
   * last_used_at could in principle fall further and further behind a session
   * in constant use; it does not, because any request more than
   * SESSION_TOUCH_MS after the stored value writes it back.
   *
   * It does not pin the margin. Its 30-minute gaps sit far inside the real
   * bound, SESSION_IDLE_MS minus SESSION_TOUCH_MS (23 hours), so it passes for
   * every touch interval below the idle window and fails only once the interval
   * reaches it. The two tests after this one pin the bound itself.
   */
  it("does not expire a session used continuously for longer than the idle window", async () => {
    const store = new MemoryAuthStore();
    await store.putSession("sid", panelSession());

    // A request every 30 minutes for three days.
    const step = 30 * 60 * 1000;
    for (let now = T0; now < T0 + 3 * SESSION_IDLE_MS; now += step) {
      expect(await store.touchSession("sid", now), `dead at +${now - T0}ms`).toBeDefined();
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
    const store = new MemoryAuthStore();
    await store.putSession("sid", panelSession());
    // Stale by exactly the threshold, which is the most a skipped write leaves.
    const skipped = T0 + SESSION_TOUCH_MS;
    await store.touchSession("sid", skipped);

    expect(await store.touchSession("sid", skipped + GUARANTEED_GAP)).toBeDefined();
  });

  it("dies one millisecond past SESSION_IDLE_MS minus SESSION_TOUCH_MS after a skipped write", async () => {
    const store = new MemoryAuthStore();
    await store.putSession("sid", panelSession());
    const skipped = T0 + SESSION_TOUCH_MS;
    await store.touchSession("sid", skipped);

    expect(await store.touchSession("sid", skipped + GUARANTEED_GAP + 1)).toBeUndefined();
  });
});
