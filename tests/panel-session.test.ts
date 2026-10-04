import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthConfig } from "../src/oauth/routes.js";
import { ACCESS_TOKEN_TTL_SECONDS, signJwt } from "../src/oauth/tokens.js";
import {
  BYSTANDER, COOKIE, IDENTITY as PANEL_IDENTITY, ISSUER, PANEL, RESOURCE,
  fakeFetch, panelConfig, routeWith, seedBystander, seedSession, withCookie,
} from "./helpers/panel.js";
import {
  MemoryAuthStore, SESSION_IDLE_MS, SESSION_TOUCH_MS, SESSION_TTL_MS,
  replannedAt, sessionDead, type AuthStorage, type PanelSession,
} from "../src/oauth/storage.js";
import type { Identity } from "../src/types.js";

// The identities are frozen. MemoryAuthStore keeps the objects it is given, so a
// method that changed a nested identity in place would change a shared constant,
// and with it every expectation built from the same constant: the stored record
// and its expectation would still be one object, and would still agree. A write
// to a frozen object throws, in a module, where on an unfrozen one it passes.
const IDENTITY: Identity = Object.freeze({
  userId: "u_github_4242",
  orgId: null,
  plan: "free",
  role: "member",
  label: "jesse@example.dev",
});
const REPLANNED: Identity = Object.freeze({ ...IDENTITY, plan: "pro" });
/** Someone else, for the sessions a method has no business touching. */
const OTHER: Identity = Object.freeze({
  ...IDENTITY, userId: "u_github_9999", label: "sam@example.dev",
});

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

  // Fails closed: a time that is not a finite number reads as dead, whether it
  // sits in the record or is the clock. NaN fails every comparison and infinity
  // passes them in the wrong direction, so a predicate that only asked whether
  // a limit had been passed would call such a session alive forever. That is
  // all it checks: a time that is finite but wrong still reads alive.
  it("is dead when expires_at is NaN", () => {
    expect(sessionDead(panelSession({ expires_at: NaN }), T0)).toBe(true);
  });

  it("is dead when last_used_at is NaN", () => {
    expect(sessionDead(panelSession({ last_used_at: NaN }), T0)).toBe(true);
  });

  it("is dead when now is NaN", () => {
    expect(sessionDead(panelSession(), NaN)).toBe(true);
  });

  it("is dead when expires_at is Infinity", () => {
    expect(sessionDead(panelSession({ expires_at: Infinity }), T0)).toBe(true);
  });

  it("is dead when last_used_at is Infinity", () => {
    expect(sessionDead(panelSession({ last_used_at: Infinity }), T0)).toBe(true);
  });

  it("is dead when now is -Infinity", () => {
    expect(sessionDead(panelSession(), -Infinity)).toBe(true);
  });

  // Pins that the finiteness check is the strict one. A numeric string is what a
  // coercing isFinite lets through, and what a comparison alone gets most wrong:
  // "1700000000000" + SESSION_IDLE_MS concatenates instead of adding, so the idle
  // clause would never fire. Three idle windows in is past the idle limit and
  // inside the ceiling, so only that clause can end it.
  it("is dead when last_used_at is a numeric string", () => {
    const s = panelSession({ last_used_at: String(T0) as unknown as number });

    expect(sessionDead(s, T0 + 3 * SESSION_IDLE_MS)).toBe(true);
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
  // last_used_at fails the touch comparison, so a record holding one would read
  // as not due and be served unless it is refused first.
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

// Typed through AuthStorage, not the class. MemoryAuthStore and the AuthStore
// facade both satisfy the interface while carrying methods it does not declare,
// so a declaration left out of AuthStorage fails nothing until the first caller
// that holds an AuthStorage. These tests are that caller, and they call every
// session method, which makes `npm run typecheck` the place a missing one is
// found.
const fresh = (): AuthStorage => new MemoryAuthStore();

describe("replanSession", () => {
  it("merges the identity, plan source and time into the stored record, and nothing else", async () => {
    const store = fresh();
    await store.putSession("sid", panelSession());

    const merged = await store.replanSession("sid", REPLANNED, "grant", T0 + 5);

    expect(merged).toBe(true);
    expect(await store.touchSession("sid", T0 + 5)).toEqual(
      panelSession({ identity: REPLANNED, plan_source: "grant", replanned_at: T0 + 5 })
    );
  });

  // The race this method exists for: a request touches the session, spends a
  // while re-resolving its plan, and writes the result back, and the human signs
  // out in between. An upsert would recreate the session they just ended.
  //
  // The answer is what pins the absence guard in this store. Without the guard it
  // would write a record holding only the three merged fields and answer true,
  // and the touch below would still find nothing, because sessionDead reads that
  // record as dead. The workerd twin also reads storage.
  it("leaves a session dead when the sign-out landed between the touch and the replan", async () => {
    const store = fresh();
    await store.putSession("sid", panelSession());
    await store.touchSession("sid", T0);
    await store.deleteSession("sid");

    const merged = await store.replanSession("sid", REPLANNED, "grant", T0 + 1);

    expect(merged).toBe(false);
    expect(await store.touchSession("sid", T0 + 1)).toBeUndefined();
  });

  // The same constraint one level down, as for touchSession: a sign-out that
  // lands while the call is in flight must stay a sign-out. A replan that
  // yielded between its read and its write would be overtaken by the delete and
  // then write the record back.
  it("is not undone by a sign-out that lands mid-replan", async () => {
    const store = fresh();
    await store.putSession("sid", panelSession());

    const replanning = store.replanSession("sid", REPLANNED, "grant", T0 + 1);
    await store.deleteSession("sid");
    await replanning;

    expect(await store.touchSession("sid", T0 + 1)).toBeUndefined();
  });

  // Another request touches the session between this one's touch and its
  // write-back, and the session has to stay as alive as that request left it.
  // Checked at the far end of the idle window that touch bought: a replan that
  // pulled last_used_at back to this request's time would be dead by then.
  it("keeps a last_used_at that another request bumped in the meantime", async () => {
    const store = fresh();
    await store.putSession("sid", panelSession());
    const mine = T0 + SESSION_TOUCH_MS + 1;
    await store.touchSession("sid", mine); // this request: stale enough to write
    const theirs = mine + SESSION_TOUCH_MS + 1;
    await store.touchSession("sid", theirs); // another request, later

    const merged = await store.replanSession("sid", REPLANNED, "grant", mine);

    expect(merged).toBe(true);
    expect(await store.touchSession("sid", theirs + SESSION_IDLE_MS)).toBeDefined();
  });
});

// The store holds every session on the deployment, so a method that wrote to the
// wrong record, or to all of them, passes any test that gives it a single
// session: "the session I named changed" has a second producer, "every session
// changed". So each test here keeps a second session the method has no business
// touching, and asserts it survives unchanged. A storage method's tests need one.
describe("a method touches only the session it names", () => {
  // Built anew for each comparison and not kept in a variable. This store keeps
  // the object it is given, so a method that changed a session in place would
  // change the variable too, and a comparison against it would still pass.
  // Rebuilding the top level is not enough when what leaks is nested: the
  // identity inside is the frozen OTHER, shared by the stored record and by every
  // expectation, so a bleed that changed it in place throws instead of changing
  // both together.
  const yours = () => panelSession({ identity: OTHER, identity_keys: ["github:9999"] });

  it("deleteSession ends only the session it names", async () => {
    const store = fresh();
    await store.putSession("one", panelSession());
    await store.putSession("two", panelSession());

    await store.deleteSession("one");

    expect(await store.touchSession("one", T0)).toBeUndefined();
    // Survives means unchanged, not only still there.
    expect(await store.touchSession("two", T0)).toEqual(panelSession());
  });

  it("touchSession and replanSession change only the session they name", async () => {
    const store = fresh();
    await store.putSession("mine", panelSession());
    await store.putSession("yours", yours());

    const later = T0 + SESSION_TOUCH_MS + 1; // stale, so this touch writes
    await store.touchSession("mine", later);
    expect(await store.replanSession("mine", REPLANNED, "grant", later)).toBe(true);

    // Not due at T0, so this hands back what is stored.
    expect(await store.touchSession("yours", T0)).toEqual(yours());
    // Alternating, with nothing due and nothing written between, which is what
    // gives away a store that answers from the last record it served. The reads
    // above are not enough: a cache like that is cleared by every write, and each
    // of them follows one.
    expect((await store.touchSession("mine", T0))?.identity.userId).toBe(IDENTITY.userId);
    expect((await store.touchSession("yours", T0))?.identity.userId).toBe(OTHER.userId);
    expect((await store.touchSession("mine", T0))?.identity.userId).toBe(IDENTITY.userId);
  });

  it("dropping a dead session removes that one and leaves the others", async () => {
    const store = fresh();
    await store.putSession("yours", yours());
    await store.putSession("dead", panelSession({
      created_at: T0 - 2 * SESSION_IDLE_MS, last_used_at: T0 - 2 * SESSION_IDLE_MS,
    }));

    expect(await store.touchSession("dead", T0)).toBeUndefined();

    expect(await store.touchSession("yours", T0)).toEqual(yours());
  });
});


// --------------------------------------------------------------------------
// Task 6: caller's cookie branch, through the real routes.
// --------------------------------------------------------------------------

let cfg: OAuthConfig;
let route: (request: Request) => Promise<Response>;

beforeEach(() => {
  cfg = panelConfig();
  route = routeWith(cfg);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("caller, over a cookie", () => {
  it("resolves /account from a session cookie", async () => {
    const sid = await seedSession(cfg);

    const res = await route(withCookie("/account", sid, {
      headers: { accept: "application/json", origin: PANEL },
    }));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.user_id).toBe("u_github_4242");
  });

  it("refuses /account with an unknown cookie", async () => {
    expect((await route(withCookie("/account", "no-such-session"))).status).toBe(401);
  });

  it("refuses /account with a dead cookie, and drops that one only", async () => {
    const sid = await seedSession(cfg, "dead", {
      last_used_at: Date.now() - SESSION_IDLE_MS - 1,
    });
    const yours = await seedBystander(cfg);

    expect((await route(withCookie("/account", sid))).status).toBe(401);

    // The drop is an error-path cleanup. Someone else, signed in, still answers
    // as themselves after it.
    const res = await route(withCookie("/account", yours, {
      headers: { accept: "application/json" },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user_id: BYSTANDER.userId, plan: BYSTANDER.plan });
  });

  // The touch writes when last_used_at is stale, and a cookie is a key. With
  // someone else signed in, each cookie has to answer with its own record, read
  // alternately with nothing written between the reads: a route that answers from
  // the last record it served gives itself away on the second.
  it("answers each cookie with its own record, after a touch that wrote", async () => {
    const mine = await seedSession(cfg, "mine", {
      last_used_at: Date.now() - 2 * 60 * 60 * 1000, // stale enough that the touch writes
    });
    const yours = await seedBystander(cfg);
    const who = async (id: string) =>
      (await route(withCookie("/account", id, { headers: { accept: "application/json" } }))).json();

    expect(await who(mine)).toMatchObject({ user_id: PANEL_IDENTITY.userId, plan: "free" });
    expect(await who(yours)).toMatchObject({ user_id: BYSTANDER.userId, plan: "pro" });
    expect(await who(mine)).toMatchObject({ user_id: PANEL_IDENTITY.userId, plan: "free" });
  });

  it("refuses a cookie outright when no panel origin is configured", async () => {
    cfg.panelOrigins = [];
    const sid = await seedSession(cfg);

    expect((await route(withCookie("/account", sid))).status).toBe(401);
  });

  it("prefers a bearer token when both are present", async () => {
    const sid = await seedSession(cfg, "cookie-sid", {
      identity: { ...PANEL_IDENTITY, userId: "u_from_cookie", label: "cookie" },
    });
    const token = await signJwt(
      { iss: ISSUER, sub: "u_from_bearer", aud: RESOURCE,
        bellman: { ...PANEL_IDENTITY, userId: "u_from_bearer", label: "bearer" },
        plan_source: "default" },
      cfg.secret, ACCESS_TOKEN_TTL_SECONDS
    );

    const res = await route(withCookie("/account", sid, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
    }));

    expect(((await res.json()) as { user_id: string }).user_id).toBe("u_from_bearer");
  });
});

describe("the cookie's plan is re-resolved on the token's bound", () => {
  it("keeps serving the stored plan while the window is open", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const sid = await seedSession(cfg, "fresh-plan", {
      identity: { ...PANEL_IDENTITY, plan: "pro" }, plan_source: "grant", replanned_at: now,
    });
    // No grant in the store: a re-resolve would drop this to free.

    vi.setSystemTime(now + ACCESS_TOKEN_TTL_SECONDS * 1000 - 1_000);
    const res = await route(withCookie("/account", sid, {
      headers: { accept: "application/json" },
    }));

    expect(((await res.json()) as { plan: string }).plan).toBe("pro");
  });

  it("drops a revoked grant once the window closes, for that session only", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const sid = await seedSession(cfg, "stale-plan", {
      identity: { ...PANEL_IDENTITY, plan: "pro" }, plan_source: "grant", replanned_at: now,
    });

    vi.setSystemTime(now + ACCESS_TOKEN_TTL_SECONDS * 1000 + 1_000);
    // Someone else, whose plan is fresh at this instant, so nothing re-resolves
    // it. Seeded after the clock moves for that reason.
    const yours = await seedBystander(cfg);
    const res = await route(withCookie("/account", sid, {
      headers: { accept: "application/json" },
    }));

    expect(((await res.json()) as { plan: string }).plan).toBe("free");
    // The write-back landed on the session that was re-resolved and on no other.
    // The bystander's plan is "pro", not the "free" it was re-resolved to, so a
    // write-back that reached them would show.
    const other = await route(withCookie("/account", yours, {
      headers: { accept: "application/json" },
    }));
    expect(await other.json()).toMatchObject({ user_id: BYSTANDER.userId, plan: "pro" });
  });

  // The sign-out lands while the plan is being re-resolved. replanOnRefresh awaits
  // the grant lookup, so deleting the session from inside that lookup puts the
  // sign-out between the touch and the write-back, which is the gap replanSession
  // exists for. The request is refused and the session stays gone.
  it("refuses the request, and the session stays gone, when it ended during the re-resolve", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const sid = await seedSession(cfg, "ended-mid-resolve", {
      identity: { ...PANEL_IDENTITY, plan: "pro" }, plan_source: "grant", replanned_at: now,
    });
    vi.setSystemTime(now + ACCESS_TOKEN_TTL_SECONDS * 1000 + 1_000); // stale: this request re-resolves
    const realGetGrant = cfg.plans!.getGrant.bind(cfg.plans);
    cfg.plans!.getGrant = async (key: string) => {
      await cfg.store.deleteSession(sid); // the human signs out while the lookup is in flight
      return realGetGrant(key);
    };
    const ask = () => route(withCookie("/account", sid, { headers: { accept: "application/json" } }));

    expect((await ask()).status).toBe(401);
    // A write-back that recreated the session would answer the next request.
    expect((await ask()).status).toBe(401);
  });

  // A write-back that FAILS says nothing about whether the session is still there:
  // the request is served, with the plan it re-resolved. The route logs the
  // failure, so a "could not store" line in the test output is expected.
  it("still serves the request when the write-back itself fails", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const sid = await seedSession(cfg, "write-fails", {
      identity: { ...PANEL_IDENTITY, plan: "pro" }, plan_source: "grant", replanned_at: now,
    });
    vi.setSystemTime(now + ACCESS_TOKEN_TTL_SECONDS * 1000 + 1_000);
    cfg.store.replanSession = () => Promise.reject(new Error("auth store unreachable"));

    const res = await route(withCookie("/account", sid, { headers: { accept: "application/json" } }));

    expect(res.status).toBe(200);
    expect(((await res.json()) as { plan: string }).plan).toBe("free");
  });

  // Review Focus 5 — a record whose replanned_at is absent or non-finite.
  it("re-resolves immediately when replanned_at is absent", async () => {
    const now = Date.now();
    // Deliberately missing replanned_at, to stand in for a malformed record:
    // nothing writes a session without it. `now - undefined` is NaN, and every
    // comparison with NaN is false — so one plausible phrasing of the staleness
    // test reads "fresh" forever and the plan never re-resolves, for the
    // session's whole life.
    await cfg.store.putSession("malformed", {
      identity: { ...PANEL_IDENTITY, plan: "pro" }, plan_source: "grant",
      identity_keys: ["github:4242"], created_at: now, last_used_at: now,
      expires_at: now + SESSION_TTL_MS,
    } as unknown as PanelSession);

    const res = await route(withCookie("/account", "malformed", {
      headers: { accept: "application/json" },
    }));

    expect(((await res.json()) as { plan: string }).plan).toBe("free");
  });
});


// ---- Task 7: /auth/signin and the session callback ----

describe("signing in to the panel", () => {
  /**
   * Walk /auth/signin → provider hand-off → callback, and return the callback
   * response. The hand-off is asserted on the way: it takes its own list of
   * audiences, apart from the callback's, so a response stepped over here would
   * let a hand-off that refused SESSION_AUDIENCE return a 400 nobody reads, and
   * the callback below would still pass.
   */
  async function signIn(returnTo?: string) {
    const query = returnTo === undefined ? "" : `?return_to=${encodeURIComponent(returnTo)}`;
    const chooser = await route(new Request(`${ISSUER}/auth/signin${query}`));
    const req = decodeURIComponent(
      /href="\/authorize\/github\?req=([^"]+)"/.exec(await chooser.text())![1]
    );
    const handoff = await route(new Request(`${ISSUER}/authorize/github?req=${encodeURIComponent(req)}`));
    expect(handoff.status).toBe(302);
    expect(handoff.headers.get("location")).toContain("github.com/login/oauth/authorize");
    return route(new Request(
      `${ISSUER}/callback/github?code=upstream-code&state=${encodeURIComponent(req)}`
    ));
  }

  it("offers the configured providers", async () => {
    const page = await (await route(new Request(`${ISSUER}/auth/signin`))).text();

    expect(page).toContain("/authorize/github?req=");
  });

  it("sets the session cookie on the way back", async () => {
    const res = await signIn(`${PANEL}/rooms`);
    const header = res.headers.get("set-cookie") ?? "";

    expect(res.status).toBe(302);
    expect(header).toContain(`${COOKIE}=`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
    expect(header).not.toContain("Domain");
  });

  it("does not hand the callback URL on in a Referer", async () => {
    // That URL holds the provider's authorization code.
    expect((await signIn(PANEL)).headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("redirects to the requested destination on the panel", async () => {
    expect((await signIn(`${PANEL}/rooms`)).headers.get("location")).toBe(`${PANEL}/rooms`);
  });

  it("the cookie it set actually works", async () => {
    const res = await signIn(PANEL);
    const id = /__Host-bellman_session=([^;]+)/.exec(res.headers.get("set-cookie")!)![1];

    const account = await route(withCookie("/account", id, {
      headers: { accept: "application/json" },
    }));

    expect(account.status).toBe(200);
    expect(((await account.json()) as { user_id: string }).user_id).toBe("u_github_4242");
  });

  // The rule's "creates" case. Sign-in mints a session id, and an id minted once
  // and reused would hand the second human the first's session, or the first
  // cookie the second's. Two humans sign in to one store, with the ids asserted
  // different and each cookie answering as its own, read alternately.
  it("gives each sign-in its own session, and each cookie answers as its own human", async () => {
    const idOf = (res: Response) =>
      /__Host-bellman_session=([^;]+)/.exec(res.headers.get("set-cookie")!)![1];
    const first = idOf(await signIn(PANEL));
    // GitHub answers as someone else for the second sign-in.
    cfg.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === "https://api.github.com/user"
        ? Response.json({ id: 9999, login: "sam", email: null })
        : fakeFetch(input, init)) as typeof fetch;
    const second = idOf(await signIn(PANEL));

    expect(second).not.toBe(first);
    const who = async (id: string) =>
      ((await (await route(withCookie("/account", id, {
        headers: { accept: "application/json" },
      }))).json()) as { user_id: string }).user_id;
    expect(await who(first)).toBe("u_github_4242");
    expect(await who(second)).toBe("u_github_9999");
    expect(await who(first)).toBe("u_github_4242");
  });

  it("falls back to the panel origin when return_to is absent", async () => {
    expect((await signIn()).headers.get("location")).toBe(PANEL);
  });

  // Review Focus 2 — return_to that is not an absolute http(s) URL on the panel.
  it("ignores a return_to on a foreign origin", async () => {
    expect((await signIn("https://evil.example/steal")).headers.get("location")).toBe(PANEL);
  });

  it("ignores a return_to that merely prefixes the panel origin", async () => {
    expect((await signIn(`${PANEL}.evil.example/steal`)).headers.get("location")).toBe(PANEL);
  });

  it("ignores a javascript: return_to rather than redirecting to it", async () => {
    const location = (await signIn("javascript:alert(document.cookie)")).headers.get("location");

    expect(location).toBe(PANEL);
    expect(location).not.toContain("javascript:");
  });

  it("ignores a relative return_to rather than throwing", async () => {
    expect((await signIn("/rooms")).headers.get("location")).toBe(PANEL);
  });

  it("ignores a protocol-relative return_to", async () => {
    expect((await signIn("//evil.example/steal")).headers.get("location")).toBe(PANEL);
  });

  it("refuses to start a sign-in with no panel configured", async () => {
    cfg.panelOrigins = [];

    expect((await route(new Request(`${ISSUER}/auth/signin`))).status).toBe(503);
  });
});


// ---- Task 8: /auth/session and /auth/signout ----

describe("/auth/session", () => {
  it("returns the identity for a live cookie", async () => {
    const sid = await seedSession(cfg);

    const res = await route(withCookie("/auth/session", sid));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toEqual({
      user_id: "u_github_4242",
      label: "jesse@example.dev",
      plan: "free",
      role: "member",
      org_id: null,
    });
  });

  it("is 401 with no cookie", async () => {
    expect((await route(new Request(`${ISSUER}/auth/session`))).status).toBe(401);
  });

  it("sends no WWW-Authenticate, which a browser cannot act on", async () => {
    const res = await route(new Request(`${ISSUER}/auth/session`));

    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  /**
   * It is the panel's boot call, made on every load. /account additionally
   * computes entitlements and counts this month's creates, which is a round
   * trip to the registry object; deciding whether to render the app does not
   * need either. Asserted against a store that throws, so "cheaper" is a
   * property rather than an intention.
   */
  it("does not reach countCreatesThisMonth", async () => {
    const sid = await seedSession(cfg);
    cfg.plans = {
      ...cfg.plans!,
      countCreatesThisMonth: () => Promise.reject(new Error("must not be called")),
    } as typeof cfg.plans;

    expect((await route(withCookie("/auth/session", sid))).status).toBe(200);
  });

  it("is 401 once the session is dead, and drops that one only", async () => {
    const sid = await seedSession(cfg, "expired", {
      last_used_at: Date.now() - SESSION_IDLE_MS - 1,
    });
    const yours = await seedBystander(cfg);

    expect((await route(withCookie("/auth/session", sid))).status).toBe(401);

    // The drop is an error-path cleanup. Someone else, signed in, still answers
    // as themselves after it.
    const res = await route(withCookie("/auth/session", yours));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user_id: string }).user_id).toBe(BYSTANDER.userId);
  });

  // Cookies are keys. Two humans read alternately, with nothing written between
  // the reads: a route that answers from the last record it served gives itself
  // away on the second, which one session cannot show.
  it("answers each cookie with its own identity", async () => {
    const mine = await seedSession(cfg, "mine");
    const yours = await seedBystander(cfg);
    const userOf = async (id: string) =>
      ((await (await route(withCookie("/auth/session", id))).json()) as { user_id: string }).user_id;

    expect(await userOf(mine)).toBe(PANEL_IDENTITY.userId);
    expect(await userOf(yours)).toBe(BYSTANDER.userId);
    expect(await userOf(mine)).toBe(PANEL_IDENTITY.userId);
  });
});

describe("/auth/signout", () => {
  const signout = (id: string | undefined) =>
    route(new Request(`${ISSUER}/auth/signout`, {
      method: "POST",
      headers: {
        origin: PANEL,
        ...(id === undefined ? {} : { cookie: `${COOKIE}=${id}` }),
      },
    }));

  it("invalidates the session server-side, and only that one", async () => {
    const mine = await seedSession(cfg, "mine");
    const yours = await seedBystander(cfg, "yours");
    const read = async (id: string) => {
      const res = await route(withCookie("/auth/session", id));
      return {
        status: res.status,
        user: res.status === 200 ? ((await res.json()) as { user_id: string }).user_id : null,
      };
    };

    // Alternating, with nothing written between: a route that answers from the
    // last record it served gives itself away on the second read. These come
    // before the sign-out, which is a write and would clear such a cache.
    expect(await read(mine)).toEqual({ status: 200, user: PANEL_IDENTITY.userId });
    expect(await read(yours)).toEqual({ status: 200, user: BYSTANDER.userId });
    expect(await read(mine)).toEqual({ status: 200, user: PANEL_IDENTITY.userId });

    expect((await signout(mine)).status).toBe(204);

    expect(await read(mine)).toEqual({ status: 401, user: null });
    // Another browser, signed in as someone else, stays signed in as them. A test
    // with a single session to end passes a sign-out that ends every session.
    expect(await read(yours)).toEqual({ status: 200, user: BYSTANDER.userId });
  });

  it("clears the cookie with every attribute that set it", async () => {
    const header = (await signout(await seedSession(cfg))).headers.get("set-cookie") ?? "";

    expect(header).toContain(`${COOKIE}=`);
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("Path=/");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
  });

  it("is idempotent", async () => {
    const sid = await seedSession(cfg);
    await signout(sid);

    expect((await signout(sid)).status).toBe(204);
  });

  it("succeeds and still clears with no cookie at all", async () => {
    const res = await signout(undefined);

    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  // The request carries a cookie on purpose. SameSite=Lax sends the cookie on a
  // top-level GET navigation, so a link someone follows would sign the human out if
  // GET did, and a 405 sent after the delete would be cosmetic. With no cookie
  // there is nothing to delete, and the test passes either way.
  it("refuses anything but POST, and the session survives", async () => {
    const sid = await seedSession(cfg);

    const res = await route(withCookie("/auth/signout", sid, { method: "GET" }));

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect((await route(withCookie("/auth/session", sid))).status).toBe(200);
  });
});
