# A Browser Session for Dash — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `dash.bellman.sh` authenticate to the Bellman Worker with an `HttpOnly` cookie it can never read, resolving through the same `caller` seam a bearer token does.

**Architecture:** The cookie carries 32 random bytes; the identity lives in a `PanelSession` record in `AuthDO`, so sign-out is a delete rather than a hope. `caller` in `src/oauth/routes.ts` gains a cookie branch that re-resolves the plan through the existing `replanOnRefresh` on the same 10-minute bound `/mcp` uses, so nothing downstream of `caller` learns how the request authenticated. The panel is cross-origin, so the Worker gains a CORS allowlist; `SameSite=Lax` plus an `Origin` check on cookie-authenticated mutations is the whole CSRF story.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects, Web Crypto, vitest (Node program) and `@cloudflare/vitest-pool-workers` (the `worker-tests/` program).

**Spec:** `docs/superpowers/specs/2026-10-02-dash-browser-session-design.md`

## Global Constraints

- **Every `AuthStorage` method is async**, including ones `MemoryAuthStore` answers instantly. A Durable Objects implementation is RPC; a synchronous signature would be implementable only in memory.
- **Nothing importing `cloudflare:workers` can be imported by a vitest test.** `src/oauth/store.ts`, `src/worker.ts` and `src/store-do.ts` are excluded from the Node build. Shapes and pure logic go in `src/oauth/storage.ts`, which stays importable from plain Node.
- **`npm run verify` before every commit.** It is `typecheck && typecheck:worker && build && test && test:worker`.
- **Read and register in the same turn** — no `await` between a read and the write that depends on it, in any method that must be atomic.
- **A room holds many members, not two.** Never write "the other session" or "two sessions" in code, comments, commits or docs. Say *members*, *the room*, or *peers*.
- **`main` moves only through merges.** Work stays on `mcfearsome/a-browser-session-for-dash-the-panel-signs-in-wi` and lands by PR.
- **No new MCP tool, so `extension/manifest.json` is untouched.** If a task finds itself editing it, that task has gone out of scope.
- **Cite code by symbol, not by line number.** Line numbers in comments and docs rot within a commit.

## Review Focus

Five input classes the spec implies and no happy-path task exercises, most likely to bite first. Each one's test is assigned to the task that owns the code.

1. **A malformed or duplicated `Cookie` header.** `Cookie: __Host-bellman_session` with no `=`, a value with surrounding whitespace, or the same name appearing twice because a sibling subdomain tossed one in. A naive `split(";").find()` mishandles all three, and a throw here 500s every panel request. → **Task 4**
2. **`return_to` that is not an absolute http(s) URL.** `javascript:alert(1)` parses fine and has origin `"null"`; a relative `/rooms` throws from `new URL`. Both must land on the configured fallback — not throw, not redirect. → **Task 7**
3. **`panelOrigins` unset or empty.** A deploy that forgot `BELLMAN_PANEL_ORIGINS`. It must fail **closed** — no browser auth at all — rather than treating an absent allowlist as "allow anything". → **Task 5**
4. **`Origin: null`.** Browsers send the literal string `"null"` from sandboxed iframes and some redirect chains. It must never match an allowlist entry, and must not be mistaken for an absent header on the CSRF path. → **Task 5**
5. **A session record written before `replanned_at` existed.** `now - undefined` is `NaN`, and every comparison against `NaN` is `false`, so the plan would never re-resolve — silently, for the session's whole life. Absent must read as `0`, forcing a re-resolve on the next request. This is the hazard `storedIdentityKeys` already exists to catch. → **Task 6**

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/oauth/cookies.ts` | Cookie name, serialization and parsing. No knowledge of sessions or routes. |
| `src/oauth/browser.ts` | The browser-safety layer: origin allowlist, CORS headers, preflight, the CSRF rule, the config parser. No knowledge of cookies or storage. |
| `tests/helpers/panel.ts` | The shared panel config and session seeding, so two test files do not each build one. |
| `tests/panel-session.test.ts` | The flow, lifetime and revocation, through the real `handleOAuth`. |
| `tests/browser-safety.test.ts` | Cookies, CORS and CSRF — as units, then through the real routes. |
| `worker-tests/auth-session.test.ts` | The three session methods against the real `AuthDO` in `workerd`. |

**Modified**

| File | Change |
|---|---|
| `src/oauth/storage.ts` | `PanelSession`, the lifetime constants, `sessionDead`, `replannedAt`, three `AuthStorage` methods, their `MemoryAuthStore` implementations. |
| `src/oauth/store.ts` | The same three methods on `AuthDO`, the `AuthStore` facade, and a session sweep keyed on `sessionDead`. |
| `src/oauth/routes.ts` | `verifyState`, `SESSION_AUDIENCE`, `finishSession`, `/auth/*` routes, `caller`'s cookie branch, CORS and CSRF wiring, `/admin/*` refusing cookies. |
| `src/worker.ts` | `BELLMAN_PANEL_ORIGINS` on `WorkerEnv`, `panelOrigins` into `oauthConfig`. |
| `wrangler.toml` | `BELLMAN_PANEL_ORIGINS` as a var, with the reasoning. |
| `docs/ARCHITECTURE.md` | The cookie session in the trust-boundaries material. |

Three new source files rather than growing `routes.ts`, which is already 997 lines. `cookies.ts` and `browser.ts` have no dependency on each other and none on storage, so both are unit-testable without a `Request` round trip through `handleOAuth`.

---

### Task 1: The session record, its predicate, and the in-memory store

**Files:**
- Modify: `src/oauth/storage.ts` (add alongside `RefreshToken` and `hasLapsed`)
- Test: `tests/panel-session.test.ts` (create)

**Interfaces:**
- Consumes: `Identity` from `src/types.js`; the existing `AuthStorage` interface and `MemoryAuthStore` class.
- Produces:
  - `SESSION_TTL_MS: number`, `SESSION_IDLE_MS: number`, `SESSION_TOUCH_MS: number`
  - `interface PanelSession { identity: Identity; plan_source: string; identity_keys: string[]; created_at: number; last_used_at: number; replanned_at: number; expires_at: number }`
  - `sessionDead(s: Pick<PanelSession, "last_used_at" | "expires_at">, now: number): boolean`
  - `replannedAt(s: PanelSession): number`
  - On `AuthStorage`: `putSession(id: string, value: PanelSession): Promise<void>`, `touchSession(id: string, now: number): Promise<PanelSession | undefined>`, `deleteSession(id: string): Promise<void>`

- [ ] **Step 1: Write the failing test for `sessionDead`**

Create `tests/panel-session.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  MemoryAuthStore, SESSION_IDLE_MS, SESSION_TOUCH_MS, SESSION_TTL_MS,
  sessionDead, type PanelSession,
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
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/panel-session.test.ts`
Expected: FAIL — `sessionDead` is not exported from `src/oauth/storage.js`.

- [ ] **Step 3: Add the shape, the constants and the predicate**

Append to `src/oauth/storage.ts`, after `RefreshToken`:

```ts
/**
 * A browser session for the control panel.
 *
 * Opaque rather than signed, because `POST /auth/signout` has to invalidate.
 * Access tokens are signed and unrevocable, and a 10-minute lifetime is what
 * makes that acceptable on /mcp; a page rendering billing and provider keys
 * does not get the same deal.
 */
export interface PanelSession {
  identity: Identity;
  /** Where the plan came from, for /account. Same field the token path carries. */
  plan_source: string;
  /** Upstream keys this human resolves under, so the plan can be re-resolved. */
  identity_keys: string[];
  created_at: number;
  last_used_at: number;
  /** When the plan was last re-resolved. See replannedAt for absent. */
  replanned_at: number;
  expires_at: number;
}

/** The hard ceiling. Deliberately well short of REFRESH_TOKEN_TTL_MS. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a session survives without being used. */
export const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
/**
 * How stale last_used_at gets before touchSession writes it back.
 *
 * The skip has a cost, and this constant bounds it. Idle time is measured from
 * last_used_at, which lags the last real request by up to this much, so a
 * session that goes quiet dies between SESSION_IDLE_MS minus this (23 hours)
 * and SESSION_IDLE_MS after its last request, depending on whether that request
 * happened to write. Skipping is never more permissive than writing on every
 * request: it can only end a quiet session early, never keep one alive longer.
 *
 * What a session can rely on is the difference, not the ratio. As long as no
 * gap between its requests exceeds SESSION_IDLE_MS minus SESSION_TOUCH_MS, it
 * cannot die of idleness, and every hour added here comes straight off that
 * guarantee. A ratio is the wrong way to judge a new value: twelve hours is
 * still "half the window" and would leave a guarantee of only twelve.
 */
export const SESSION_TOUCH_MS = 60 * 60 * 1000;

/**
 * Whether a session has ended — past its ceiling, or idle too long.
 *
 * One predicate for the same reason hasLapsed is one: a read and a sweep that
 * each decide separately will eventually disagree, and the shape that bug takes
 * is a session still usable because no purge has run yet.
 */
export function sessionDead(
  s: Pick<PanelSession, "last_used_at" | "expires_at">,
  now: number
): boolean {
  return now > s.expires_at || now > s.last_used_at + SESSION_IDLE_MS;
}

/**
 * When this session's plan was last re-resolved, treating absent as never.
 *
 * A record written before this field existed has none, and `now - undefined` is
 * NaN — which fails every comparison, so a staleness check can read as "not
 * stale" and the plan would never be re-resolved again for the life of the
 * session. A revoked grant would hold, silently. Zero forces a re-resolve on
 * the next request, which is the safe direction. Same hazard
 * storedIdentityKeys exists for on the refresh path.
 */
export function replannedAt(s: PanelSession): number {
  return typeof s.replanned_at === "number" ? s.replanned_at : 0;
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/panel-session.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Prove the predicate's idle half can fail**

Temporarily change `sessionDead` to `return now > s.expires_at;` and re-run.
Expected: "is dead when idle past the window, with the ceiling still ahead" FAILS, and
it is the only one that can. "is alive exactly at the idle boundary" expects `false`
and still gets it with the idle clause removed, so it guards the direction of the
comparison and not the clause. Restore the full predicate, then change the idle
comparison from `>` to `>=` and re-run: that test FAILS. Restore and confirm PASS again.

A predicate whose second clause has never been observed to matter has not been tested.

- [ ] **Step 6: Write the failing tests for the three store methods**

Append to `tests/panel-session.test.ts`:

```ts
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

  it("skips the write while last_used_at is fresher than SESSION_TOUCH_MS", async () => {
    const store = new MemoryAuthStore();
    await store.putSession("sid", panelSession());

    const touched = await store.touchSession("sid", T0 + SESSION_TOUCH_MS - 1);

    expect(touched?.last_used_at).toBe(T0);
  });

  it("writes last_used_at once it is staler than SESSION_TOUCH_MS", async () => {
    const store = new MemoryAuthStore();
    await store.putSession("sid", panelSession());
    const now = T0 + SESSION_TOUCH_MS + 1;

    expect((await store.touchSession("sid", now))?.last_used_at).toBe(now);
    // And it persisted, rather than only being returned.
    expect((await store.touchSession("sid", now))?.last_used_at).toBe(now);
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
   * reaches it.
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
});
```

- [ ] **Step 7: Run them and confirm they fail**

Run: `npx vitest run tests/panel-session.test.ts`
Expected: FAIL — `store.putSession is not a function`.

- [ ] **Step 8: Declare the three methods on `AuthStorage`**

Add to the `AuthStorage` interface in `src/oauth/storage.ts`, after `takeRefresh`:

```ts
  /** Create a browser session. */
  putSession(id: string, value: PanelSession): Promise<void>;
  /**
   * Read a session, test it, and bump last_used_at — as ONE operation.
   *
   * Not a get and a put from the caller. The caller is the Worker and the
   * record is in a Durable Object, so two calls have a window between them;
   * this is the same reason admitRegistration is one method. Implementations
   * must not yield between the read and the write.
   *
   * Undefined for an unknown session and for a dead one, and a dead one is
   * dropped rather than left for a sweep — so a clock that moves backwards
   * cannot revive it.
   */
  touchSession(id: string, now: number): Promise<PanelSession | undefined>;
  /** Sign out. Idempotent: an unknown id is not an error. */
  deleteSession(id: string): Promise<void>;
```

- [ ] **Step 9: Implement them on `MemoryAuthStore`**

Add the field beside the other maps in `MemoryAuthStore`:

```ts
  private sessions = new Map<string, PanelSession>();
```

And the methods, after `takeRefresh`:

```ts
  async putSession(id: string, value: PanelSession): Promise<void> {
    this.sessions.set(id, value);
  }

  /**
   * Synchronous throughout, like admitRegistration and for the same reason: an
   * await between the read and the write is the window this method exists to
   * close.
   */
  async touchSession(id: string, now: number): Promise<PanelSession | undefined> {
    const stored = this.sessions.get(id);
    if (!stored) return undefined;
    if (sessionDead(stored, now)) {
      this.sessions.delete(id);
      return undefined;
    }
    // Skipped while the stored value is fresh enough. See SESSION_TOUCH_MS:
    // a panel that polls would otherwise write on every single request.
    if (now - stored.last_used_at <= SESSION_TOUCH_MS) return stored;
    const touched: PanelSession = { ...stored, last_used_at: now };
    this.sessions.set(id, touched);
    return touched;
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }
```

- [ ] **Step 10: Run the whole file and confirm it passes**

Run: `npx vitest run tests/panel-session.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 11: Prove the continuous-use test can fail**

Temporarily change the skip in `touchSession` to never write:

```ts
    if (true) return stored;
```

Re-run. Expected: "does not expire a session used continuously…" FAILS with `dead at +88200000ms`, and "writes last_used_at once it is staler…" FAILS. Restore.

The loop steps in whole 30-minute increments, so `+86400000` is exactly the idle boundary and still alive; 24.5 hours is the first step past the window.

- [ ] **Step 12: Verify and commit**

```bash
npm run verify
git add src/oauth/storage.ts tests/panel-session.test.ts
git commit -m "feat(oauth): a PanelSession record, its liveness predicate, and the in-memory store

The cookie for dash is an opaque id over a stored record rather than a
signed token, because sign-out has to invalidate rather than clear the
browser's copy and hope. tokens.ts already says short TTLs are the only
mitigation an unrevocable token gets, and that is not a deal a page
rendering billing should take.

sessionDead is one predicate over both the ceiling and the idle window,
for the reason hasLapsed is one: two call sites that each decide will
eventually disagree, and that bug looks like a session still usable
because no purge has run.

touchSession skips the write while last_used_at is fresher than
SESSION_TOUCH_MS, so a polling panel does not write on every request.
The skip costs a quiet session up to that long of its idle window, so what
a session can rely on is SESSION_IDLE_MS minus SESSION_TOUCH_MS, not the
ratio of the two. A test that drives three days of continuous use pins that
the skip does not accumulate.

replannedAt reads an absent field as 0. now - undefined is NaN, every
comparison against NaN is false, and a staleness check can therefore
read 'not stale' forever: the plan would never be re-resolved and a
revoked grant would hold for the session's whole life."
```

---

### Task 2: The same three methods on `AuthDO`, with a sweep

**Files:**
- Modify: `src/oauth/store.ts` (`AuthDO`, `AuthStore`)
- Test: `worker-tests/auth-session.test.ts` (create)

**Interfaces:**
- Consumes: `PanelSession`, `sessionDead`, `SESSION_TOUCH_MS` from Task 1; the existing `sweepPage`, `SweepStorage` and `PURGE_BATCH`.
- Produces: `putSession`, `touchSession`, `deleteSession` on both `AuthDO` and the `AuthStore` facade, with behavior identical to `MemoryAuthStore`.

- [ ] **Step 1: Read how an existing worker test reaches `AuthDO`**

Run: `cat worker-tests/reconcile-race.test.ts && cat worker-tests/wrangler.toml`

This is the only program that can exercise the real object: anything importing `cloudflare:workers` cannot be imported by a vitest test in the Node program. Match this file's import style and its `wrangler.toml` bindings exactly — in particular how it obtains an `AuthDO` stub and whether `AUTH` is already bound.

- [ ] **Step 2: Write the failing conformance test**

Create `worker-tests/auth-session.test.ts`. Mirror the import and binding style the previous step showed; the assertions are the point:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  SESSION_IDLE_MS, SESSION_TOUCH_MS, SESSION_TTL_MS, type PanelSession,
} from "../src/oauth/storage.js";
import type { Identity } from "../src/types.js";

const IDENTITY: Identity = {
  userId: "u_github_4242", orgId: null, plan: "free", role: "member",
  label: "jesse@example.dev",
};
const T0 = 1_700_000_000_000;

const panelSession = (over: Partial<PanelSession> = {}): PanelSession => ({
  identity: IDENTITY, plan_source: "default", identity_keys: ["github:4242"],
  created_at: T0, last_used_at: T0, replanned_at: T0,
  expires_at: T0 + SESSION_TTL_MS, ...over,
});

/** A fresh AuthDO per test, so one test's sessions are not another's. */
const auth = (name: string) => env.AUTH.get(env.AUTH.idFromName(name));

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

  it("writes last_used_at once it is stale, and it persists", async () => {
    const o = auth("s-write");
    await o.putSession("sid", panelSession());
    const now = T0 + SESSION_TOUCH_MS + 1;

    expect((await o.touchSession("sid", now))?.last_used_at).toBe(now);
    expect((await o.touchSession("sid", now))?.last_used_at).toBe(now);
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

  /**
   * The sweep, which the conformance assertions above do not reach. Its
   * predicate has to be sessionDead rather than #purge's expires_at test: a
   * session can die of idleness with its ceiling a week away, and the
   * expires_at form would leave it stored for the full seven days.
   */
  it("sweeps a session that died of idleness, not only one past its ceiling", async () => {
    const o = auth("s-sweep");
    const now = Date.now();
    await o.putSession("stale", panelSession({
      created_at: now - 2 * SESSION_IDLE_MS,
      last_used_at: now - 2 * SESSION_IDLE_MS,
      expires_at: now + SESSION_TTL_MS,
    }));

    // putSession sweeps before it writes, so a second put runs the sweep.
    await o.putSession("fresh", panelSession({
      created_at: now, last_used_at: now, replanned_at: now,
      expires_at: now + SESSION_TTL_MS,
    }));

    expect(await o.touchSession("stale", now)).toBeUndefined();
    expect(await o.touchSession("fresh", now)).toBeDefined();
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `npm run test:worker`
Expected: FAIL — `o.putSession is not a function`.

- [ ] **Step 4: Implement the three methods on `AuthDO`**

Add the prefix beside `CODE`, `REFRESH`, `CLIENT`, `REG` in `src/oauth/store.ts`:

```ts
const SESSION = "sess:";
```

Add the methods after `takeRefresh`:

```ts
  async putSession(id: string, value: PanelSession): Promise<void> {
    // Cleanup first, like putRefresh: the sweep lists, writes a cursor and
    // deletes, so it can fail, and a failure after the write would reject this
    // call with the session already stored and no cookie handed out.
    await this.#purgeSessions();
    await this.ctx.storage.put(`${SESSION}${id}`, value);
  }

  /**
   * One RPC, awaiting nothing but storage — which is what makes it atomic. The
   * input gate holds other events off for the duration, so a concurrent request
   * for the same session cannot read the pre-touch value and write over this
   * one. Splitting it into a get and a put from the Worker is the window this
   * exists to close, the same way admitRegistration does.
   */
  async touchSession(id: string, now: number): Promise<PanelSession | undefined> {
    const key = `${SESSION}${id}`;
    const stored = await this.ctx.storage.get<PanelSession>(key);
    if (!stored) return undefined;
    if (sessionDead(stored, now)) {
      // Dropped here rather than left to the sweep, so a dead session is
      // terminal the moment it is first read as dead.
      await this.ctx.storage.delete(key);
      return undefined;
    }
    if (now - stored.last_used_at <= SESSION_TOUCH_MS) return stored;
    const touched: PanelSession = { ...stored, last_used_at: now };
    await this.ctx.storage.put(key, touched);
    return touched;
  }

  async deleteSession(id: string): Promise<void> {
    await this.ctx.storage.delete(`${SESSION}${id}`);
  }

  /**
   * Sessions that were abandoned rather than signed out of.
   *
   * Its own sweep rather than #purge, because #purge decides on expires_at and
   * a session can die of idleness with its ceiling still ahead — so reusing it
   * would leave idle sessions stored for up to the full seven days.
   *
   * `#private`; see #clientCount.
   */
  async #purgeSessions(): Promise<void> {
    const now = Date.now();
    await sweepPage<PanelSession>(
      this.sweepStorage, SESSION, `cursor:${SESSION}`, PURGE_BATCH,
      (value) => (sessionDead(value, now) ? { action: "delete" } : { action: "keep" })
    );
  }
```

Extend the import at the top of the file to bring in what these use:

```ts
import {
  CLIENT_CAP, CLIENT_COUNT_KEY, PURGE_BACKOFF_MS, PURGE_IDLE_KEY,
  REGISTRATIONS_PER_HOUR, REGISTRATION_WINDOW_MS, SESSION_TOUCH_MS,
  clientCount, hasLapsed, purgeDue, sessionDead, sweepPage,
  type Admission, type AuthCode, type AuthStorage, type CounterStorage,
  type PanelSession, type Reclaimed, type RefreshToken, type RegisteredClient,
  type SweepStorage,
} from "./storage.js";
```

- [ ] **Step 5: Implement the facade on `AuthStore`**

Add after `takeRefresh` in `AuthStore`:

```ts
  putSession(id: string, value: PanelSession): Promise<void> {
    return this.object.putSession(id, value);
  }
  touchSession(id: string, now: number): Promise<PanelSession | undefined> {
    return this.object.touchSession(id, now);
  }
  deleteSession(id: string): Promise<void> {
    return this.object.deleteSession(id);
  }
```

And add `PanelSession` to the re-export at the bottom of the file:

```ts
export type {
  AuthCode, AuthStorage, PanelSession, RefreshToken, RegisteredClient,
} from "./storage.js";
```

- [ ] **Step 6: Run the worker tests and confirm they pass**

Run: `npm run test:worker`
Expected: PASS, 10 new tests, and every pre-existing worker test still green.

- [ ] **Step 7: Prove the sweep predicate matters**

Temporarily change `#purgeSessions`'s decide function to the `expires_at` form `#purge` uses:

```ts
      (value) => (value.expires_at < now ? { action: "delete" } : { action: "keep" })
```

Re-run `npm run test:worker`.
Expected: "sweeps a session that died of idleness…" FAILS — `stale` is still readable, because its ceiling is a week away. The other nine still pass, which is the point: the sweep is not covered by them. Restore `sessionDead`.

- [ ] **Step 8: Verify and commit**

```bash
npm run verify
git add src/oauth/store.ts worker-tests/auth-session.test.ts
git commit -m "feat(oauth): session storage on AuthDO, with its own sweep

The three methods from the in-memory store, against the real object, in
the workerd program — because AuthStorage has no conformance suite the
way BellmanStore does, and two hand-written implementations of the same
interface are exactly where behaviour drifts.

touchSession is one RPC awaiting nothing but storage. The input gate
then covers the read and the write together, which is the window a get
and a put from the Worker would leave open.

The session sweep decides on sessionDead rather than reusing #purge's
expires_at test. A session can die of idleness with its ceiling still a
week away, so the expires_at form would leave idle records stored for
the full seven days — and the conformance assertions do not notice,
which is why the sweep has one of its own."
```

---

### Task 3: `verifyState` — one helper for three audiences

**Files:**
- Modify: `src/oauth/routes.ts` (`/authorize/:provider` and `/callback/:provider` branches)
- Test: `tests/oauth-flow.test.ts` (extend; it is also the regression net)

**Interfaces:**
- Consumes: `verifyJwt`, `Claims` from `./tokens.js`; the existing `STATE_AUDIENCE` and `UPGRADE_AUDIENCE`.
- Produces: `verifyState(token: string, config: Pick<OAuthConfig, "issuer" | "secret">, audiences: readonly string[]): Promise<{ claims: Claims; audience: string } | null>`

A pure refactor. No behavior changes, so the existing suite is most of the test.

- [ ] **Step 1: Record the baseline**

Run: `npx vitest run tests/oauth-flow.test.ts`
Expected: PASS. Write down the test count — it must be that number plus one at the end.

- [ ] **Step 2: Add the test that a list makes easy to break**

In `tests/oauth-flow.test.ts`, add `paymentLinks` to the `beforeEach` config:

```ts
    paymentLinks: { pro_monthly: "https://buy.stripe.com/test_link" },
```

And add this test to the `describe` covering the provider hand-off:

```ts
  it("accepts an upgrade state at the provider hand-off, not only an authorize state", async () => {
    // Both audiences reach /authorize/:provider. A helper that checks only
    // audiences[0] passes every other test in this file while losing this.
    const chooser = await call("/upgrade/pro_monthly");
    const req = decodeURIComponent(
      /href="\/authorize\/github\?req=([^"]+)"/.exec(await chooser.text())![1]
    );

    const handoff = await call(`/authorize/github?req=${encodeURIComponent(req)}`);

    expect(handoff.status).toBe(302);
    expect(handoff.headers.get("location")).toContain("github.com/login/oauth/authorize");
  });
```

- [ ] **Step 3: Run it and confirm it passes against the current code**

Run: `npx vitest run tests/oauth-flow.test.ts`
Expected: PASS. It documents behavior that already works, so the refactor cannot silently drop it.

- [ ] **Step 4: Add `verifyState`**

Add to `src/oauth/routes.ts`, above `handleOAuth`:

```ts
/**
 * Verify a signed state blob against any of several audiences, and say which
 * one matched.
 *
 * Three audiences now reach /authorize/:provider — connecting a client, signing
 * in to pay, and signing in to the panel — and the callback dispatches on which
 * one it was. Written as a chain of `??` over verifyJwt this was two calls deep
 * and readable; at three it is not, and the callback was re-verifying to find
 * out which audience it had.
 */
async function verifyState(
  token: string,
  config: Pick<OAuthConfig, "issuer" | "secret">,
  audiences: readonly string[]
): Promise<{ claims: Claims; audience: string } | null> {
  for (const audience of audiences) {
    const claims = await verifyJwt(token, config.secret, { issuer: config.issuer, audience });
    if (claims) return { claims, audience };
  }
  return null;
}
```

Add `type Claims` to the `./tokens.js` import:

```ts
import {
  ACCESS_TOKEN_TTL_SECONDS, AUTH_CODE_TTL_MS, REFRESH_TOKEN_TTL_MS, STATE_TTL_SECONDS,
  canonicalResource, randomId, signJwt, verifyJwt, verifyPkce, type Claims,
} from "./tokens.js";
```

- [ ] **Step 5: Use it at the provider hand-off**

In the `/authorize/:provider` branch of `handleOAuth`, replace the two-call fallback with:

```ts
    const req = url.searchParams.get("req") ?? "";
    // Every audience reaches the same hand-off; only the callback needs to tell
    // them apart.
    const state = await verifyState(req, config, [STATE_AUDIENCE, UPGRADE_AUDIENCE]);
    if (!state) return html(`<h1>This sign-in link expired</h1><p>Start the connection again.</p>`, 400);
```

- [ ] **Step 6: Use it at the callback**

In the `/callback/:provider` branch, replace the nested verify with a single dispatch:

```ts
    const stateToken = url.searchParams.get("state") ?? "";
    const state = await verifyState(stateToken, config, [STATE_AUDIENCE, UPGRADE_AUDIENCE]);
    if (!state) {
      return html(`<h1>This sign-in link expired</h1><p>Start the connection again.</p>`, 400);
    }
    if (state.audience === UPGRADE_AUDIENCE) {
      // An upgrade came back through the same callback; it ends at Stripe
      // rather than at an authorization code.
      return finishUpgrade(url, name, creds, state.claims.bellman as unknown as UpgradeRequest, config);
    }
    const pending = state.claims.bellman as unknown as AuthorizeRequest;
```

- [ ] **Step 7: Run the whole suite and confirm no change**

Run: `npm test`
Expected: PASS, with the Step 1 count plus one.

- [ ] **Step 8: Prove the audience list is really iterated**

Temporarily change `verifyState` to check only the first audience:

```ts
  const audience = audiences[0];
  const claims = await verifyJwt(token, config.secret, { issuer: config.issuer, audience });
  return claims ? { claims, audience } : null;
```

Re-run `npx vitest run tests/oauth-flow.test.ts`. Expected: the Step 2 test FAILS. Restore the loop.

- [ ] **Step 9: Verify and commit**

```bash
npm run verify
git add src/oauth/routes.ts tests/oauth-flow.test.ts
git commit -m "refactor(oauth): one verifyState for every state audience

Two audiences reached /authorize/:provider as a chain of ?? over
verifyJwt, and the callback re-verified to find out which one it had. A
third audience is about to arrive for the panel's cookie session, and at
three the chain stops being readable.

verifyState takes a list and returns the audience that matched, so the
callback dispatches on the answer rather than asking twice.

No behaviour change. The existing flow suite is the net, plus one test
pinning the thing a list makes easy to break: that an upgrade state is
still accepted at the hand-off, which a helper checking only
audiences[0] would pass every other test in the file while losing."
```

---

### Task 4: Cookie serialization and parsing

**Files:**
- Create: `src/oauth/cookies.ts`
- Test: `tests/browser-safety.test.ts` (create)

**Interfaces:**
- Consumes: nothing. A leaf module, deliberately.
- Produces:
  - `sessionCookieName(secure: boolean): string`
  - `serializeSessionCookie(id: string, secure: boolean, maxAgeSeconds: number): string`
  - `clearedSessionCookie(secure: boolean): string`
  - `readSessionCookie(request: Request, secure: boolean): string | undefined`

- [ ] **Step 1: Write the failing tests**

Create `tests/browser-safety.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  clearedSessionCookie, readSessionCookie, serializeSessionCookie, sessionCookieName,
} from "../src/oauth/cookies.js";

const HOST = "__Host-bellman_session";
const cookied = (header: string) =>
  new Request("https://mcp.example.test/auth/session", { headers: { cookie: header } });

describe("the session cookie", () => {
  it("uses the __Host- prefix when secure", () => {
    expect(sessionCookieName(true)).toBe(HOST);
  });

  it("drops the prefix when not secure, because __Host- requires Secure", () => {
    expect(sessionCookieName(false)).toBe("bellman_session");
  });

  it("serializes with every attribute the design requires", () => {
    const header = serializeSessionCookie("abc123", true, 604_800);

    expect(header).toContain(`${HOST}=abc123`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
    expect(header).toContain("Max-Age=604800");
  });

  it("never sets Domain — the cookie is host-only", () => {
    expect(serializeSessionCookie("abc123", true, 604_800)).not.toContain("Domain");
  });

  it("omits Secure over http so wrangler dev works", () => {
    const header = serializeSessionCookie("abc123", false, 604_800);

    expect(header).toContain("bellman_session=abc123");
    expect(header).not.toContain("Secure");
  });

  it("clears with Max-Age=0 and otherwise identical attributes", () => {
    const cleared = clearedSessionCookie(true);

    expect(cleared).toContain(`${HOST}=`);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("Path=/");
    expect(cleared).toContain("SameSite=Lax");
    expect(cleared).toContain("HttpOnly");
  });
});

describe("reading the session cookie", () => {
  it("finds it as the only cookie", () => {
    expect(readSessionCookie(cookied(`${HOST}=abc123`), true)).toBe("abc123");
  });

  it("finds it among others, whitespace and all", () => {
    const req = cookied(`_ga=GA1.2.3;  ${HOST}=abc123 ; theme=dark`);
    expect(readSessionCookie(req, true)).toBe("abc123");
  });

  it("returns undefined with no cookie header at all", () => {
    const req = new Request("https://mcp.example.test/auth/session");
    expect(readSessionCookie(req, true)).toBeUndefined();
  });

  it("returns undefined when the name is absent", () => {
    expect(readSessionCookie(cookied("theme=dark"), true)).toBeUndefined();
  });

  // Review Focus 1 — malformed and duplicated headers.
  it("survives a bare name with no equals sign", () => {
    expect(readSessionCookie(cookied(HOST), true)).toBeUndefined();
  });

  it("survives an empty value", () => {
    expect(readSessionCookie(cookied(`${HOST}=`), true)).toBeUndefined();
  });

  it("survives a header that is only separators", () => {
    expect(readSessionCookie(cookied(";;  ;"), true)).toBeUndefined();
  });

  it("does not match a name that merely ends with the cookie name", () => {
    expect(readSessionCookie(cookied(`evil-${HOST}=tossed`), true)).toBeUndefined();
  });

  /**
   * Cookie tossing. __Host- stops a sibling subdomain setting this name at all,
   * so a duplicate means something is wrong rather than something is ambiguous.
   * Refusing both is the only answer that is not attacker-selectable: RFC 6265
   * does not make the order deterministic, so "first wins" lets the attacker
   * choose by setting a Path.
   */
  it("refuses outright when the name appears twice", () => {
    expect(readSessionCookie(cookied(`${HOST}=mine; ${HOST}=tossed`), true)).toBeUndefined();
  });

  it("reads the unprefixed name in insecure mode and ignores the prefixed one", () => {
    const req = cookied(`${HOST}=prod; bellman_session=dev`);
    expect(readSessionCookie(req, false)).toBe("dev");
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run tests/browser-safety.test.ts`
Expected: FAIL — cannot resolve `../src/oauth/cookies.js`.

- [ ] **Step 3: Write `src/oauth/cookies.ts`**

```ts
/**
 * The control panel's session cookie: its name, its attributes, and how to read
 * one back off a request.
 *
 * A leaf module on purpose. It knows nothing about sessions, storage or routes,
 * so every attribute and every parsing edge is testable without a Request going
 * through handleOAuth.
 */

/**
 * The cookie's name, and why it has two.
 *
 * `__Host-` is a browser-enforced contract, not decoration: a cookie with that
 * prefix is accepted only if it is Secure, has Path=/, and has NO Domain. The
 * third clause is the one that matters here. The panel's cookie is host-only to
 * mcp.bellman.sh by our own choice — but without the prefix, anything running on
 * a sibling subdomain of bellman.sh (the marketing site, say, via XSS) can set
 * `Domain=.bellman.sh` with this same name, and the browser will send both. RFC
 * 6265 does not make the order deterministic, so which one the server reads
 * first becomes attacker-selectable. The prefix means the sibling's write is
 * rejected by the browser and never reaches us.
 *
 * It requires Secure, so it cannot be used over http. `wrangler dev` on
 * localhost therefore gets the unprefixed name — a development-only fallback,
 * and the only place the protection is absent.
 */
export function sessionCookieName(secure: boolean): string {
  return secure ? "__Host-bellman_session" : "bellman_session";
}

/**
 * `Path=/` because /auth/session and /account share no prefix, and #49's /api/*
 * will not either. Required by __Host- in any case.
 */
const BASE_ATTRIBUTES = ["HttpOnly", "SameSite=Lax", "Path=/"];

function attributes(secure: boolean): string[] {
  return secure ? [...BASE_ATTRIBUTES, "Secure"] : [...BASE_ATTRIBUTES];
}

/** No Domain attribute, ever. See sessionCookieName. */
export function serializeSessionCookie(
  id: string,
  secure: boolean,
  maxAgeSeconds: number
): string {
  return [`${sessionCookieName(secure)}=${id}`, ...attributes(secure), `Max-Age=${maxAgeSeconds}`]
    .join("; ");
}

/**
 * The clearing header.
 *
 * Every attribute identical to the one that set it, because a Set-Cookie that
 * differs in Path or Domain does not overwrite — it adds a second cookie, and
 * the session stays live while appearing to have been signed out of.
 */
export function clearedSessionCookie(secure: boolean): string {
  return serializeSessionCookie("", secure, 0);
}

/**
 * The session id from a request's Cookie header, or undefined.
 *
 * Hand-parsed rather than `split(";").find(…)`, because that form gets three
 * things wrong: it matches a name that merely ends with ours, it treats a bare
 * name with no `=` as a match with an undefined value, and it silently picks one
 * of two cookies with the same name.
 *
 * A duplicate name is refused outright rather than resolved. __Host- stops a
 * sibling subdomain from setting this name, so seeing it twice is not an
 * ambiguity to break sensibly — it is a signal that something set it that should
 * not have been able to. Picking either one hands the choice to whoever tossed
 * the second, since cookie order is not specified. Refusing costs one sign-in.
 */
export function readSessionCookie(request: Request, secure: boolean): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  const name = sessionCookieName(secure);

  let found: string | undefined;
  for (const part of header.split(";")) {
    const equals = part.indexOf("=");
    // No '=' at all is not a cookie; "=x" has no name.
    if (equals <= 0) continue;
    if (part.slice(0, equals).trim() !== name) continue;
    // Seen twice. See the note above: refuse, do not choose.
    if (found !== undefined) return undefined;
    found = part.slice(equals + 1).trim();
  }
  return found ? found : undefined;
}
```

- [ ] **Step 4: Run them and confirm they pass**

Run: `npx vitest run tests/browser-safety.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Prove the duplicate and suffix guards matter**

Temporarily replace the loop in `readSessionCookie` with the naive form:

```ts
  const hit = header.split(";").find((p) => p.trim().startsWith(name));
  return hit?.split("=")[1]?.trim() || undefined;
```

Re-run. Expected: "refuses outright when the name appears twice", "does not match a name that merely ends with the cookie name" and "survives a bare name with no equals sign" all FAIL. Restore.

- [ ] **Step 6: Verify and commit**

```bash
npm run verify
git add src/oauth/cookies.ts tests/browser-safety.test.ts
git commit -m "feat(oauth): the panel session cookie, named __Host- and parsed by hand

The design calls for a host-only cookie with no Domain, which our own
code honours. __Host- makes the browser enforce it instead: a cookie
with that prefix is accepted only when it is Secure, has Path=/ and has
no Domain, so a sibling subdomain of bellman.sh cannot set this name at
all. Without it, an XSS on the marketing site can set
Domain=.bellman.sh and the browser sends both copies in an order RFC
6265 leaves unspecified — which makes the one we read attacker-
selectable. The prefix requires Secure, so http://localhost gets the
unprefixed name and is the one place the protection is absent.

Parsing is hand-rolled because split(';').find(startsWith) gets three
things wrong: it matches evil-__Host-bellman_session, it treats a bare
name with no '=' as a match, and it quietly picks one of two cookies
with the same name. A duplicate is refused rather than resolved —
choosing either hands the choice to whoever set the second."
```

---

### Task 5: The origin allowlist, CORS, the CSRF rule, and the config parser

**Files:**
- Create: `src/oauth/browser.ts`
- Modify: `src/oauth/routes.ts` (`OAuthConfig` gains `panelOrigins`)
- Test: `tests/browser-safety.test.ts` (extend)

**Interfaces:**
- Consumes: nothing beyond `Request`/`Response`. A second leaf module.
- Produces:
  - `allowedOrigin(request: Request, panelOrigins: readonly string[] | undefined): string | undefined`
  - `corsHeaders(origin: string | undefined): Record<string, string>`
  - `preflightResponse(origin: string | undefined): Response`
  - `csrfRefusal(request: Request, via: "bearer" | "cookie", origin: string | undefined): Response | undefined`
  - `parsePanelOrigins(raw: string | undefined): string[]`
- On `OAuthConfig`: `panelOrigins?: string[]`

- [ ] **Step 1: Write the failing tests**

Append to `tests/browser-safety.test.ts`:

```ts
import {
  allowedOrigin, corsHeaders, csrfRefusal, parsePanelOrigins, preflightResponse,
} from "../src/oauth/browser.js";

const PANEL = "https://dash.example.test";
const ORIGINS = [PANEL];

const from = (origin: string | undefined, method = "GET") =>
  new Request("https://mcp.example.test/auth/session", {
    method,
    headers: origin === undefined ? {} : { origin },
  });

describe("the origin allowlist", () => {
  it("admits a configured origin", () => {
    expect(allowedOrigin(from(PANEL), ORIGINS)).toBe(PANEL);
  });

  it("refuses an origin that is not configured", () => {
    expect(allowedOrigin(from("https://evil.example"), ORIGINS)).toBeUndefined();
  });

  it("refuses an origin that merely starts with a configured one", () => {
    expect(allowedOrigin(from(`${PANEL}.evil.example`), ORIGINS)).toBeUndefined();
  });

  it("refuses a different scheme on the same host", () => {
    expect(allowedOrigin(from("http://dash.example.test"), ORIGINS)).toBeUndefined();
  });

  it("returns undefined when no Origin was sent", () => {
    expect(allowedOrigin(from(undefined), ORIGINS)).toBeUndefined();
  });

  // Review Focus 4 — the literal string "null".
  it('refuses the literal origin "null"', () => {
    expect(allowedOrigin(from("null"), ORIGINS)).toBeUndefined();
  });

  it('refuses "null" even if someone puts it in the allowlist', () => {
    expect(allowedOrigin(from("null"), ["null", PANEL])).toBeUndefined();
  });

  // Review Focus 3 — a deploy that forgot the var must fail closed.
  it("admits nothing when the allowlist is undefined", () => {
    expect(allowedOrigin(from(PANEL), undefined)).toBeUndefined();
  });

  it("admits nothing when the allowlist is empty", () => {
    expect(allowedOrigin(from(PANEL), [])).toBeUndefined();
  });
});

describe("CORS headers", () => {
  it("echoes the allowlisted origin and allows credentials", () => {
    const headers = corsHeaders(PANEL);

    expect(headers["access-control-allow-origin"]).toBe(PANEL);
    expect(headers["access-control-allow-credentials"]).toBe("true");
  });

  it("never answers with a wildcard", () => {
    expect(Object.values(corsHeaders(PANEL))).not.toContain("*");
  });

  it("always varies on Origin, so a cache cannot cross-serve", () => {
    expect(corsHeaders(PANEL).vary).toBe("Origin");
  });

  it("emits no allow-origin at all for an origin that is not allowlisted", () => {
    const headers = corsHeaders(undefined);

    expect(headers["access-control-allow-origin"]).toBeUndefined();
    expect(headers["access-control-allow-credentials"]).toBeUndefined();
    // Vary still, or a cached no-CORS response is served to the panel.
    expect(headers.vary).toBe("Origin");
  });
});

describe("preflight", () => {
  it("answers 204 with methods, headers and a max age", async () => {
    const res = preflightResponse(PANEL);

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(PANEL);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain("content-type");
    expect(Number(res.headers.get("access-control-max-age"))).toBeGreaterThan(0);
    expect(await res.text()).toBe("");
  });

  it("answers 204 with no CORS grant for a stranger", () => {
    const res = preflightResponse(undefined);

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("the CSRF rule", () => {
  it("lets a cookie GET through without an Origin", () => {
    expect(csrfRefusal(from(undefined, "GET"), "cookie", undefined)).toBeUndefined();
  });

  it("lets a cookie HEAD through", () => {
    expect(csrfRefusal(from(undefined, "HEAD"), "cookie", undefined)).toBeUndefined();
  });

  it("refuses a cookie POST with no Origin", () => {
    expect(csrfRefusal(from(undefined, "POST"), "cookie", undefined)?.status).toBe(403);
  });

  it("refuses a cookie POST from an origin off the list", () => {
    expect(csrfRefusal(from("https://evil.example", "POST"), "cookie", undefined)?.status).toBe(403);
  });

  it("lets a cookie POST from the panel through", () => {
    expect(csrfRefusal(from(PANEL, "POST"), "cookie", PANEL)).toBeUndefined();
  });

  it("refuses a cookie DELETE with no Origin, not only POST", () => {
    expect(csrfRefusal(from(undefined, "DELETE"), "cookie", undefined)?.status).toBe(403);
  });

  // The exemption, asserted rather than left to ordering.
  it("lets a bearer POST through with no Origin at all", () => {
    expect(csrfRefusal(from(undefined, "POST"), "bearer", undefined)).toBeUndefined();
  });

  it("lets a bearer POST through from an origin off the list", () => {
    expect(csrfRefusal(from("https://evil.example", "POST"), "bearer", undefined)).toBeUndefined();
  });
});

describe("parsing BELLMAN_PANEL_ORIGINS", () => {
  it("reads one origin", () => {
    expect(parsePanelOrigins("https://dash.bellman.sh")).toEqual(["https://dash.bellman.sh"]);
  });

  it("reads several, comma-separated, and trims them", () => {
    expect(parsePanelOrigins("https://dash.bellman.sh, https://dash.staging.bellman.sh"))
      .toEqual(["https://dash.bellman.sh", "https://dash.staging.bellman.sh"]);
  });

  it("is empty when the var is unset", () => {
    expect(parsePanelOrigins(undefined)).toEqual([]);
  });

  it("is empty for an empty or whitespace-only var", () => {
    expect(parsePanelOrigins("")).toEqual([]);
    expect(parsePanelOrigins("   ")).toEqual([]);
  });

  it("drops entries that are not absolute http(s) origins", () => {
    expect(parsePanelOrigins("https://ok.example, not-a-url, javascript:x, /relative"))
      .toEqual(["https://ok.example"]);
  });

  it("normalises a trailing slash away", () => {
    // The Origin header never carries a path or a trailing slash, so an entry
    // that does would match nothing and the panel would silently fail to sign in.
    expect(parsePanelOrigins("https://dash.bellman.sh/")).toEqual(["https://dash.bellman.sh"]);
  });

  it("reduces an entry with a path to its origin", () => {
    expect(parsePanelOrigins("https://dash.bellman.sh/panel")).toEqual(["https://dash.bellman.sh"]);
  });

  it("de-duplicates", () => {
    expect(parsePanelOrigins("https://a.example, https://a.example/")).toEqual(["https://a.example"]);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run tests/browser-safety.test.ts`
Expected: FAIL — cannot resolve `../src/oauth/browser.js`.

- [ ] **Step 3: Write `src/oauth/browser.ts`**

```ts
/**
 * What makes it safe for a browser to hold a Bellman session.
 *
 * Two jobs, both keyed on one allowlist: which origins may be granted CORS, and
 * which origins may perform a cookie-authenticated mutation. A second leaf
 * module beside cookies.ts, so neither needs the other and both are unit
 * testable.
 *
 * The config parser lives here rather than in src/worker.ts, because that file
 * imports cloudflare:workers and so cannot be reached from a vitest test.
 */

/** A preflight result is cacheable for a day; the allowlist changes by deploy. */
const PREFLIGHT_MAX_AGE_SECONDS = 86_400;

/** The methods the panel uses. Explicit rather than echoing the request. */
const ALLOWED_METHODS = "GET, POST, DELETE, OPTIONS";

/**
 * The request's Origin, if the allowlist admits it. Undefined otherwise, which
 * is also the answer when no Origin was sent.
 *
 * Exact string equality against the configured list. Not a prefix test: a
 * startsWith against "https://dash.bellman.sh" admits
 * "https://dash.bellman.sh.attacker.example". Not a hostname test either, or
 * http would pass where only https is configured.
 *
 * An absent or empty allowlist admits nothing. A deploy that forgot
 * BELLMAN_PANEL_ORIGINS gets no browser authentication at all, which is a
 * visibly broken panel; the alternative reading — no list means no restriction —
 * is a silently open one.
 *
 * The literal string "null" is refused unconditionally, including if it somehow
 * appears in the allowlist. Browsers send it as the Origin from sandboxed
 * iframes, from some redirect chains, and from `file:` documents. It is not an
 * origin, it is the absence of one, and it is shared by every caller that has
 * none.
 */
export function allowedOrigin(
  request: Request,
  panelOrigins: readonly string[] | undefined
): string | undefined {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return undefined;
  if (!panelOrigins || panelOrigins.length === 0) return undefined;
  return panelOrigins.includes(origin) ? origin : undefined;
}

/**
 * CORS headers for a response, given the already-validated origin.
 *
 * `origin` is the output of allowedOrigin, never a raw header — echoing an
 * unvalidated Origin is the CORS hole that looks like an allowlist.
 *
 * Vary: Origin goes on every response, including those with no grant. Without
 * it a cache can hand one origin's Access-Control-Allow-Origin to another, in
 * either direction: a cached grant served to a stranger, or a cached refusal
 * served to the panel.
 *
 * No wildcard anywhere. A wildcard with credentials is rejected by browsers, so
 * it would not even work.
 */
export function corsHeaders(origin: string | undefined): Record<string, string> {
  if (!origin) return { vary: "Origin" };
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    vary: "Origin",
  };
}

/**
 * The answer to a preflight. 204 either way — a stranger's preflight simply
 * carries no grant, and the browser blocks the real request itself. Answering
 * 403 would tell a caller whether it is on the list.
 */
export function preflightResponse(origin: string | undefined): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(origin),
      ...(origin
        ? {
            "access-control-allow-methods": ALLOWED_METHODS,
            "access-control-allow-headers": "content-type",
            "access-control-max-age": String(PREFLIGHT_MAX_AGE_SECONDS),
          }
        : {}),
    },
  });
}

/** Methods that change nothing, so they need no CSRF defence. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * A 403 when a cookie-authenticated mutation cannot prove where it came from,
 * or undefined to let the request proceed.
 *
 * The whole CSRF story, and it is a header check rather than a token because
 * the header already answers the question. Browsers send Origin on every
 * cross-origin request and on every POST, so a cookie-authenticated mutation
 * without one is not a browser we have any reason to serve.
 *
 * SameSite=Lax is not sufficient on its own, which is why this exists: SameSite
 * is evaluated on the registrable domain, so bellman.sh is same-site with
 * mcp.bellman.sh. An XSS on the marketing site could otherwise POST here with
 * the session cookie attached, and Lax would allow it.
 *
 * Bearer callers are exempt entirely. curl sends no Origin and needs none, and
 * a browser cannot attach a bearer token cross-site without JavaScript that
 * already holds the token — at which point CSRF is not the problem.
 */
export function csrfRefusal(
  request: Request,
  via: "bearer" | "cookie",
  origin: string | undefined
): Response | undefined {
  if (via === "bearer") return undefined;
  if (SAFE_METHODS.has(request.method)) return undefined;
  if (origin) return undefined;
  return Response.json(
    {
      error: "invalid_request",
      error_description:
        "a cookie-authenticated write must carry an Origin header from the control panel",
    },
    { status: 403, headers: { "cache-control": "no-store" } }
  );
}

/**
 * The panel origins from BELLMAN_PANEL_ORIGINS — comma-separated, trimmed, and
 * reduced to bare origins.
 *
 * Normalised rather than taken literally, because allowedOrigin compares against
 * the Origin header by exact string equality and that header never carries a path
 * or a trailing slash. An entry of "https://dash.bellman.sh/" would therefore
 * match nothing, and the symptom is a panel that cannot sign in with no error
 * anywhere saying why.
 *
 * Entries that are not absolute http(s) URLs are dropped with a log line. A typo
 * should cost one origin, not the whole allowlist — and an unparseable entry left
 * in place would throw from inside allowedOrigin on every request.
 */
export function parsePanelOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  const origins: string[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      console.error(`BELLMAN_PANEL_ORIGINS: ignoring "${trimmed}" — not an absolute URL`);
      continue;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      console.error(`BELLMAN_PANEL_ORIGINS: ignoring "${trimmed}" — only http and https`);
      continue;
    }
    if (!origins.includes(parsed.origin)) origins.push(parsed.origin);
  }
  return origins;
}
```

- [ ] **Step 4: Add `panelOrigins` to `OAuthConfig`**

In `src/oauth/routes.ts`, inside `OAuthConfig`, after `overrides`:

```ts
  /**
   * Origins the control panel is served from, e.g. ["https://dash.bellman.sh"].
   *
   * Absent or empty means no browser may hold a session: see allowedOrigin.
   * Browser authentication is a capability this list grants, not a default the
   * list restricts.
   */
  panelOrigins?: string[];
```

- [ ] **Step 5: Run them and confirm they pass**

Run: `npx vitest run tests/browser-safety.test.ts`
Expected: PASS — 17 from Task 4 plus 34 here.

- [ ] **Step 6: Prove the three guards that a plausible implementation drops**

Run each, confirm the named test fails, then restore:

1. Fail-open allowlist — `if (!panelOrigins) return origin;`
   Expected: "admits nothing when the allowlist is undefined" FAILS.
2. Prefix match — `panelOrigins.some((o) => origin.startsWith(o))`
   Expected: "refuses an origin that merely starts with a configured one" FAILS.
3. `"null"` permitted — drop the `origin === "null"` clause.
   Expected: 'refuses "null" even if someone puts it in the allowlist' FAILS.

- [ ] **Step 7: Verify and commit**

```bash
npm run verify
git add src/oauth/browser.ts src/oauth/routes.ts tests/browser-safety.test.ts
git commit -m "feat(oauth): the origin allowlist, CORS, and the CSRF rule

One allowlist answers both questions: which origins get CORS, and which
may perform a cookie-authenticated write.

Exact string equality, because a startsWith against
https://dash.bellman.sh admits https://dash.bellman.sh.attacker.example,
and a hostname test would let http pass where only https is configured.

An absent or empty allowlist admits nothing. A deploy that forgot
BELLMAN_PANEL_ORIGINS gets a visibly broken panel; reading an absent
list as 'no restriction' gets a silently open one.

The literal origin 'null' is refused unconditionally, including if it
appears in the allowlist. Browsers send it from sandboxed iframes and
file: documents — it is the absence of an origin, shared by everyone who
has none.

CSRF is an Origin check rather than a token, because the header already
answers the question, and SameSite=Lax does not: SameSite is evaluated
on the registrable domain, so an XSS on bellman.sh is same-site with
mcp.bellman.sh and Lax would let it POST with the cookie attached.
Bearer callers are exempt, and that exemption has its own tests rather
than resting on the order of the checks.

parsePanelOrigins normalises each entry to a bare origin, because the
Origin header carries no path and no trailing slash — an entry that does
would match nothing, and the symptom is a panel that cannot sign in with
nothing anywhere saying why."
```

---

### Task 6: `caller` learns to read a cookie

**Files:**
- Modify: `src/oauth/routes.ts` (`caller`)
- Create: `tests/helpers/panel.ts`
- Test: `tests/panel-session.test.ts` (extend)

**Interfaces:**
- Consumes: `readSessionCookie` (Task 4); `touchSession`, `replannedAt`, `PanelSession`, `SESSION_TTL_MS` (Task 1); the existing `replanOnRefresh` and `ACCESS_TOKEN_TTL_SECONDS`.
- Produces: `caller(request, config)` returning `{ identity: Identity; planSource: string; via: "bearer" | "cookie" } | null`, and a module-private `sessionCaller`. Plus the shared test helpers below.

- [ ] **Step 1: Create the shared test helpers**

Two test files need the same config and seeding, so it goes in one place. Create `tests/helpers/panel.ts`:

```ts
import { MemoryAuthStore, SESSION_TTL_MS, type PanelSession } from "../../src/oauth/storage.js";
import { MemoryStore } from "../../src/store.js";
import { handleOAuth, type OAuthConfig } from "../../src/oauth/routes.js";
import type { Identity } from "../../src/types.js";

export const ISSUER = "https://mcp.example.test";
export const RESOURCE = "https://mcp.example.test/mcp";
export const PANEL = "https://dash.example.test";
export const COOKIE = "__Host-bellman_session";

export const IDENTITY: Identity = {
  userId: "u_github_4242", orgId: null, plan: "free", role: "member",
  label: "jesse@example.dev",
};

/** GitHub stubbed at the fetch boundary; everything else is the real thing. */
export const fakeFetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.startsWith("https://github.com/login/oauth/access_token")) {
    return Response.json({ access_token: "gh_upstream_token" });
  }
  if (url === "https://api.github.com/user") {
    return Response.json({ id: 4242, login: "mcfearsome", email: null });
  }
  if (url === "https://api.github.com/user/emails") {
    return Response.json([{ email: "jesse@example.dev", primary: true, verified: true }]);
  }
  return new Response("unexpected upstream call", { status: 500 });
}) as typeof fetch;

export function panelConfig(over: Partial<OAuthConfig> = {}): OAuthConfig {
  return {
    issuer: ISSUER,
    resource: RESOURCE,
    secret: "test-signing-secret",
    store: new MemoryAuthStore(),
    credentials: { github: { clientId: "gh-id", clientSecret: "gh-secret" } },
    overrides: {},
    panelOrigins: [PANEL],
    plans: new MemoryStore(),
    fetchImpl: fakeFetch,
    ...over,
  };
}

/** handleOAuth, asserting it handled the path. */
export const routeWith = (config: OAuthConfig) => async (request: Request) =>
  (await handleOAuth(request, config))!;

/** A live session in the store. Returns its id. */
export async function seedSession(
  config: OAuthConfig,
  id = "sid",
  over: Partial<PanelSession> = {}
): Promise<string> {
  const now = Date.now();
  await config.store.putSession(id, {
    identity: IDENTITY, plan_source: "default", identity_keys: ["github:4242"],
    created_at: now, last_used_at: now, replanned_at: now,
    expires_at: now + SESSION_TTL_MS, ...over,
  });
  return id;
}

/** A request carrying a session cookie. */
export const withCookie = (path: string, id: string, init: RequestInit = {}) =>
  new Request(`${ISSUER}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie: `${COOKIE}=${id}` },
  });
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/panel-session.test.ts`, with these imports at the top of the file:

```ts
import { afterEach, beforeEach, vi } from "vitest";
import type { OAuthConfig } from "../src/oauth/routes.js";
import { ACCESS_TOKEN_TTL_SECONDS, signJwt } from "../src/oauth/tokens.js";
import {
  COOKIE, IDENTITY as PANEL_IDENTITY, ISSUER, PANEL, RESOURCE,
  panelConfig, routeWith, seedSession, withCookie,
} from "./helpers/panel.js";
```

```ts
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

  it("refuses /account with a dead cookie", async () => {
    const sid = await seedSession(cfg, "dead", {
      last_used_at: Date.now() - SESSION_IDLE_MS - 1,
    });

    expect((await route(withCookie("/account", sid))).status).toBe(401);
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

  it("drops a revoked grant once the window closes", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const sid = await seedSession(cfg, "stale-plan", {
      identity: { ...PANEL_IDENTITY, plan: "pro" }, plan_source: "grant", replanned_at: now,
    });

    vi.setSystemTime(now + ACCESS_TOKEN_TTL_SECONDS * 1000 + 1_000);
    const res = await route(withCookie("/account", sid, {
      headers: { accept: "application/json" },
    }));

    expect(((await res.json()) as { plan: string }).plan).toBe("free");
  });

  // Review Focus 5 — a record written before replanned_at existed.
  it("re-resolves immediately when replanned_at is absent", async () => {
    const now = Date.now();
    // Deliberately missing replanned_at, the way a record from before the field
    // would be. `now - undefined` is NaN, and every comparison with NaN is
    // false — so one plausible phrasing of the staleness test reads "fresh"
    // forever and the plan never re-resolves, for the session's whole life.
    await cfg.store.putSession("legacy", {
      identity: { ...PANEL_IDENTITY, plan: "pro" }, plan_source: "grant",
      identity_keys: ["github:4242"], created_at: now, last_used_at: now,
      expires_at: now + SESSION_TTL_MS,
    } as unknown as PanelSession);

    const res = await route(withCookie("/account", "legacy", {
      headers: { accept: "application/json" },
    }));

    expect(((await res.json()) as { plan: string }).plan).toBe("free");
  });
});
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `npx vitest run tests/panel-session.test.ts`
Expected: FAIL — `/account` answers 401 for every cookie request; `caller` does not read cookies.

- [ ] **Step 4: Rewrite `caller`**

Replace `caller` in `src/oauth/routes.ts`:

```ts
/**
 * Who is calling, and how.
 *
 * Bearer first, then a session cookie. `via` is the only thing a consumer
 * learns beyond the identity, and only the CSRF check and /admin read it —
 * everything else sees an Identity and cannot tell the two apart, which is what
 * keeps the authorization rules in one place.
 */
async function caller(
  request: Request,
  config: OAuthConfig
): Promise<{ identity: Identity; planSource: string; via: "bearer" | "cookie" } | null> {
  const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (bearer) {
    const claims = await verifyJwt(bearer, config.secret, {
      issuer: config.issuer,
      audience: config.resource,
    });
    if (!claims) return null;
    return {
      identity: claims.bellman,
      planSource: String((claims as Record<string, unknown>).plan_source ?? "default"),
      via: "bearer",
    };
  }
  return sessionCaller(request, config);
}

/**
 * The cookie half, including re-resolving the plan.
 *
 * The record holds the identity captured at sign-in, and a session lives seven
 * days — so without re-resolution a grant revoked on day one would keep
 * applying for six more. replanOnRefresh is the function for it: it is the one
 * that already re-derives a plan from stored keys rather than a provider
 * profile, and its rules carry over intact, including that it consults only
 * immutableKeys so an address that has changed hands since sign-in cannot
 * resolve a stranger's plan onto this session.
 *
 * The bound is ACCESS_TOKEN_TTL_SECONDS deliberately: the same staleness a
 * bearer token already has on /mcp. One number for the system rather than two,
 * and a revoked grant cannot outlive on the panel what it outlives on the tool
 * surface.
 */
async function sessionCaller(
  request: Request,
  config: OAuthConfig
): Promise<{ identity: Identity; planSource: string; via: "cookie" } | null> {
  // The allowlist is what grants browser authentication at all. Without this a
  // deploy that forgot BELLMAN_PANEL_ORIGINS would still accept cookies while
  // serving no CORS — a session usable by anything that is not a browser.
  if (!config.panelOrigins?.length) return null;

  const secure = new URL(config.issuer).protocol === "https:";
  const id = readSessionCookie(request, secure);
  if (!id) return null;

  const now = Date.now();
  const stored = await config.store.touchSession(id, now);
  if (!stored) return null;

  if (now - replannedAt(stored) <= ACCESS_TOKEN_TTL_SECONDS * 1000) {
    return { identity: stored.identity, planSource: stored.plan_source, via: "cookie" };
  }

  const current = await replanOnRefresh(stored.identity, stored.identity_keys, config);
  // Written back so the next request inside the window is served from the
  // record rather than re-resolving again. Best effort: a failed write costs a
  // repeated re-resolution, not a wrong answer, and must not cost the human
  // their session.
  await config.store
    .putSession(id, {
      ...stored,
      identity: current.identity,
      plan_source: current.source,
      replanned_at: now,
    })
    .catch((err) => console.error("could not store a re-resolved panel session:", err));
  return { identity: current.identity, planSource: current.source, via: "cookie" };
}
```

Add the import:

```ts
import { readSessionCookie } from "./cookies.js";
```

and extend the `./storage.js` import:

```ts
import {
  SESSION_TTL_MS, UNUSED_CLIENT_TTL_MS, replannedAt,
  type AuthStorage, type PanelSession,
} from "./storage.js";
```

- [ ] **Step 5: Run them and confirm they pass**

Run: `npx vitest run tests/panel-session.test.ts`
Expected: PASS.

- [ ] **Step 6: Prove the `replannedAt` guard matters**

The hazard is real in one of the two plausible phrasings, which is why the guard is a named function rather than an inline expression. Try both.

First, the `<=` form with the raw field:

```ts
  if (now - stored.replanned_at <= ACCESS_TOKEN_TTL_SECONDS * 1000) {
```

`NaN <= x` is `false`, so this takes the re-resolve branch and the test passes by accident.

Now the `>` form a different author would equally plausibly write:

```ts
  if (now - stored.replanned_at > ACCESS_TOKEN_TTL_SECONDS * 1000) {
    // …re-resolve…
  }
  return { identity: stored.identity, planSource: stored.plan_source, via: "cookie" };
```

`NaN > x` is also `false`, so this skips the re-resolve and serves `pro` forever.
Expected: "re-resolves immediately when replanned_at is absent" FAILS here.

Restore `replannedAt`, which is correct under either phrasing.

- [ ] **Step 7: Prove the bearer branch still wins**

Temporarily move the cookie branch above the bearer branch. Re-run.
Expected: "prefers a bearer token when both are present" FAILS. Restore.

- [ ] **Step 8: Verify and commit**

```bash
npm run verify
git add src/oauth/routes.ts tests/panel-session.test.ts tests/helpers/panel.ts
git commit -m "feat(oauth): caller resolves a session cookie, not only a bearer token

Bearer first, cookie second, and 'via' is the only new fact a consumer
learns. Only the CSRF check and /admin read it: everything else sees an
Identity and cannot tell how the request authenticated, which keeps the
authorization rules in one place rather than two.

The stored identity is re-resolved through replanOnRefresh once it is
staler than ACCESS_TOKEN_TTL_SECONDS. A session lives seven days, so
without it a grant revoked on day one would keep applying for six more.
The bound is the token's deliberately — one staleness number for the
system, and a revoked grant cannot outlive on the panel what it
outlives on /mcp.

replannedAt reads an absent field as 0 rather than comparing against
undefined. Both plausible phrasings of that comparison make NaN mean
'not stale' in at least one direction, and the version that does serves
a revoked plan for the session's whole life.

An absent panelOrigins refuses cookies outright. A deploy that forgot
the var gets a panel that cannot sign in, rather than a session usable
by anything that is not a browser."
```

---

### Task 7: Signing in — `/auth/signin` and the session callback

**Files:**
- Modify: `src/oauth/routes.ts` (`SESSION_AUDIENCE`, `panelDestination`, `finishSession`, the `/auth/signin` route, the callback's third branch)
- Test: `tests/panel-session.test.ts` (extend)

**Interfaces:**
- Consumes: `verifyState` (Task 3), `serializeSessionCookie` (Task 4), `putSession` and `SESSION_TTL_MS` (Task 1), the existing `resolvePlan`, `randomId`, `signJwt`, `PROVIDERS`, `STATE_TTL_SECONDS`.
- Produces: `GET /auth/signin?return_to=…`; a `SESSION_AUDIENCE` branch on `/callback/:provider`; a module-private `panelDestination(returnTo, panelOrigins)` and `interface SessionRequest { return_to: string }`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/panel-session.test.ts`:

```ts
describe("signing in to the panel", () => {
  /** Walk /auth/signin → provider → callback, and return the callback response. */
  async function signIn(returnTo?: string) {
    const query = returnTo === undefined ? "" : `?return_to=${encodeURIComponent(returnTo)}`;
    const chooser = await route(new Request(`${ISSUER}/auth/signin${query}`));
    const req = decodeURIComponent(
      /href="\/authorize\/github\?req=([^"]+)"/.exec(await chooser.text())![1]
    );
    await route(new Request(`${ISSUER}/authorize/github?req=${encodeURIComponent(req)}`));
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
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run tests/panel-session.test.ts`
Expected: FAIL — `/auth/signin` is unhandled, so `handleOAuth` returns undefined and `route`'s non-null assertion throws.

- [ ] **Step 3: Add the audience and the destination validator**

In `src/oauth/routes.ts`, beside `STATE_AUDIENCE` and `UPGRADE_AUDIENCE`:

```ts
const SESSION_AUDIENCE = "bellman:session-state";
```

And, next to `paymentLink`:

```ts
/** Carried through the provider round trip when signing in to the panel. */
interface SessionRequest {
  return_to: string;
}

/**
 * Where to send a freshly-authenticated browser.
 *
 * The open redirect. `returnTo` reaches us inside a signed state, so it cannot
 * have been altered mid-flow — but it was supplied by whoever started the flow,
 * and that is not necessarily the person finishing it. So it is validated here
 * too, on exact origin equality against the panel allowlist.
 *
 * Exact equality, not a prefix test: startsWith("https://dash.bellman.sh")
 * admits "https://dash.bellman.sh.attacker.example".
 *
 * Parsing is not validation. `new URL("javascript:alert(1)")` succeeds, and its
 * origin is the string "null" — so the origin comparison is what refuses it,
 * not the parse. A relative path throws instead. Both land on the fallback.
 *
 * Anything unusable falls back to the first configured panel origin rather than
 * erroring: a sign-in that completed should end somewhere the human can use.
 */
function panelDestination(returnTo: string | undefined, panelOrigins: string[]): string {
  const fallback = panelOrigins[0];
  if (!returnTo) return fallback;
  let parsed: URL;
  try {
    parsed = new URL(returnTo);
  } catch {
    return fallback;
  }
  return panelOrigins.includes(parsed.origin) ? parsed.toString() : fallback;
}
```

- [ ] **Step 4: Add the `/auth/signin` route**

In `handleOAuth`, after the `/upgrade/<link>` branch:

```ts
  // -------------------------------------------------------- /auth/signin
  // The panel's sign-in. Same provider hand-off as /authorize and /upgrade;
  // what differs is only where it ends — a cookie rather than an authorization
  // code or a Stripe redirect.
  if (method === "GET" && path === "/auth/signin") {
    const panels = config.panelOrigins ?? [];
    if (panels.length === 0) {
      return html(
        `<h1>No control panel configured</h1>` +
          `<p>This Bellman server has no panel origin set, so it cannot start a browser session.</p>`,
        503
      );
    }
    const available = (Object.keys(PROVIDERS) as ProviderName[]).filter((name) => config.credentials[name]);
    if (available.length === 0) {
      return html(`<h1>No sign-in configured</h1><p>This Bellman server has no identity provider set up.</p>`, 503);
    }
    // Validated now as well as on the way out. Sealing an unusable destination
    // into a signed blob and discovering it after the provider round trip is a
    // worse error message for the same outcome.
    const pending: SessionRequest = {
      return_to: panelDestination(url.searchParams.get("return_to") ?? undefined, panels),
    };
    const stateToken = await signJwt(
      { iss: config.issuer, sub: "session", aud: SESSION_AUDIENCE, bellman: pending as never },
      config.secret,
      STATE_TTL_SECONDS
    );
    const buttons = available
      .map((name) => `<a class="btn" href="/authorize/${name}?req=${encodeURIComponent(stateToken)}">Continue with ${PROVIDERS[name].displayName}</a>`)
      .join("");
    return html(
      `<h1>Sign in to Bellman</h1>` +
        `<p>Use the account your rooms belong to.</p>` +
        buttons
    );
  }
```

- [ ] **Step 5: Admit the new audience at the hand-off and the callback**

In the `/authorize/:provider` branch:

```ts
    const state = await verifyState(req, config, [STATE_AUDIENCE, UPGRADE_AUDIENCE, SESSION_AUDIENCE]);
```

In the `/callback/:provider` branch, the same list, and a third dispatch arm before the `AuthorizeRequest` cast:

```ts
    const state = await verifyState(stateToken, config, [STATE_AUDIENCE, UPGRADE_AUDIENCE, SESSION_AUDIENCE]);
    if (!state) {
      return html(`<h1>This sign-in link expired</h1><p>Start the connection again.</p>`, 400);
    }
    if (state.audience === UPGRADE_AUDIENCE) {
      return finishUpgrade(url, name, creds, state.claims.bellman as unknown as UpgradeRequest, config);
    }
    if (state.audience === SESSION_AUDIENCE) {
      return finishSession(url, name, creds, state.claims.bellman as unknown as SessionRequest, config);
    }
    const pending = state.claims.bellman as unknown as AuthorizeRequest;
```

- [ ] **Step 6: Write `finishSession`**

Add beside `finishUpgrade`:

```ts
/**
 * Complete a panel sign-in: mint a session, set the cookie, send the browser on.
 *
 * The record carries identity_keys so the plan can be re-resolved later, the
 * same way a refresh token does — see sessionCaller.
 */
async function finishSession(
  url: URL,
  name: ProviderName,
  creds: ProviderCredentials,
  pending: SessionRequest,
  config: OAuthConfig
): Promise<Response> {
  const panels = config.panelOrigins ?? [];
  if (panels.length === 0) {
    return html(`<h1>No control panel configured</h1><p>Nothing was signed in.</p>`, 503);
  }
  const code = url.searchParams.get("code");
  if (!code) {
    return html(`<h1>Sign-in did not complete</h1><p>No authorization code came back. Start again.</p>`, 400);
  }

  let resolved: Awaited<ReturnType<typeof resolvePlan>>;
  try {
    const profile = await PROVIDERS[name].exchange(
      creds, code, `${config.issuer}/callback/${name}`, config.fetchImpl
    );
    resolved = await resolvePlan(profile, config);
  } catch (err) {
    console.error(`${name} sign-in for the panel failed:`, err);
    return html(`<h1>Sign-in failed</h1><p>Start again from the control panel.</p>`, 502);
  }

  const now = Date.now();
  const id = randomId();
  await config.store.putSession(id, {
    identity: resolved.identity,
    plan_source: resolved.source,
    identity_keys: resolved.keys,
    created_at: now,
    last_used_at: now,
    replanned_at: now,
    expires_at: now + SESSION_TTL_MS,
  });

  const secure = new URL(config.issuer).protocol === "https:";
  return new Response(null, {
    status: 302,
    headers: {
      location: panelDestination(pending.return_to, panels),
      "set-cookie": serializeSessionCookie(id, secure, Math.floor(SESSION_TTL_MS / 1000)),
      "cache-control": "no-store",
      // This response's own URL holds the provider's authorization code, and it
      // must not be handed on to the panel in a Referer.
      "referrer-policy": "no-referrer",
    },
  });
}
```

Extend the cookies import:

```ts
import { readSessionCookie, serializeSessionCookie } from "./cookies.js";
```

- [ ] **Step 7: Run them and confirm they pass**

Run: `npx vitest run tests/panel-session.test.ts`
Expected: PASS.

- [ ] **Step 8: Prove the `return_to` validator matters**

Temporarily change `panelDestination`'s final line to the prefix form:

```ts
  return panelOrigins.some((o) => returnTo.startsWith(o)) ? returnTo : fallback;
```

Re-run. Expected: "ignores a return_to that merely prefixes the panel origin" FAILS — the browser is sent to `https://dash.example.test.evil.example/steal`. Restore.

Then remove the `try`/`catch` and re-run. Expected: "ignores a relative return_to rather than throwing" FAILS with a `TypeError`. Restore.

- [ ] **Step 9: Verify and commit**

```bash
npm run verify
git add src/oauth/routes.ts tests/panel-session.test.ts
git commit -m "feat(oauth): /auth/signin, and a session branch on the provider callback

The panel's sign-in reuses /callback/:provider rather than adding
/auth/callback. A new redirect URI would have to be registered in the
GitHub and Google consoles — configuration outside this repo, invisible
to CI, and easy to miss on a fresh deploy. The callback already
demultiplexes on the state's audience, which is how /upgrade was added,
so a third audience costs no provider configuration at all.

return_to is the open redirect. It travels inside the signed state so it
cannot be altered mid-flow, and it is validated again on the way out on
exact origin equality. Exact, because startsWith against
https://dash.bellman.sh admits https://dash.bellman.sh.attacker.example.

Parsing is not validation: new URL('javascript:alert(1)') succeeds and
its origin is the string 'null', so the origin comparison is what
refuses it; a relative path throws instead. Both land on the fallback,
because a sign-in that completed should end somewhere usable.

The callback response carries referrer-policy: no-referrer. Its own URL
holds the provider's authorization code, and it must not be handed on."
```

---

### Task 8: `/auth/session` and `/auth/signout`

**Files:**
- Modify: `src/oauth/routes.ts`
- Test: `tests/panel-session.test.ts` (extend)

**Interfaces:**
- Consumes: `caller` (Task 6), `clearedSessionCookie` and `readSessionCookie` (Task 4), `deleteSession` (Task 1), `allowedOrigin`/`corsHeaders`/`csrfRefusal` (Task 5).
- Produces: `GET /auth/session` returning `{ user_id, label, plan, role, org_id }`; `POST /auth/signout` returning 204.

- [ ] **Step 1: Write the failing tests**

Append to `tests/panel-session.test.ts`:

```ts
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

  it("is 401 once the session is dead", async () => {
    const sid = await seedSession(cfg, "expired", {
      last_used_at: Date.now() - SESSION_IDLE_MS - 1,
    });

    expect((await route(withCookie("/auth/session", sid))).status).toBe(401);
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

  it("invalidates the session server-side", async () => {
    const sid = await seedSession(cfg);

    expect((await signout(sid)).status).toBe(204);
    expect((await route(withCookie("/auth/session", sid))).status).toBe(401);
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

  it("refuses anything but POST", async () => {
    const res = await route(new Request(`${ISSUER}/auth/signout`, { method: "GET" }));

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run tests/panel-session.test.ts`
Expected: FAIL — both paths are unhandled.

- [ ] **Step 3: Add `/auth/session`**

In `handleOAuth`, after the `/auth/signin` branch:

```ts
  // ------------------------------------------------------- /auth/session
  // What the panel calls on boot: who am I, or 401.
  if (method === "GET" && path === "/auth/session") {
    const origin = allowedOrigin(request, config.panelOrigins);
    const who = await caller(request, config);
    if (!who) {
      // No WWW-Authenticate. It exists to tell an OAuth client where discovery
      // starts (RFC 9728), and a browser cannot act on it — the panel's answer
      // to a 401 is to show a link to /auth/signin.
      return json({ error: "not_signed_in" }, 401, corsHeaders(origin));
    }
    const { identity } = who;
    // The identity and nothing that costs a second store read. /account adds
    // entitlements and this month's usage, which is a round trip to the
    // registry; the panel's render-or-sign-in decision needs neither.
    return json(
      {
        user_id: identity.userId,
        label: identity.label,
        plan: identity.plan,
        role: identity.role,
        org_id: identity.orgId,
      },
      200,
      corsHeaders(origin)
    );
  }
```

- [ ] **Step 4: Add `/auth/signout`**

```ts
  // ------------------------------------------------------- /auth/signout
  if (path === "/auth/signout") {
    const origin = allowedOrigin(request, config.panelOrigins);
    if (method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "POST", ...corsHeaders(origin) },
      });
    }
    const refusal = csrfRefusal(request, "cookie", origin);
    if (refusal) return refusal;

    const secure = new URL(config.issuer).protocol === "https:";
    const id = readSessionCookie(request, secure);
    // Best effort, and deliberately not conditional on the record existing.
    // Signing out must never fail: the recourse when it does is to leave the
    // session open, which is the opposite of what was asked for.
    if (id) {
      await config.store
        .deleteSession(id)
        .catch((err) => console.error("could not delete a panel session:", err));
    }
    return new Response(null, {
      status: 204,
      headers: {
        "set-cookie": clearedSessionCookie(secure),
        "cache-control": "no-store",
        ...corsHeaders(origin),
      },
    });
  }
```

Extend the imports:

```ts
import { clearedSessionCookie, readSessionCookie, serializeSessionCookie } from "./cookies.js";
import { allowedOrigin, corsHeaders, csrfRefusal, preflightResponse } from "./browser.js";
```

- [ ] **Step 5: Run them and confirm they pass**

Run: `npx vitest run tests/panel-session.test.ts`
Expected: PASS.

- [ ] **Step 6: Prove sign-out really is server-side**

Temporarily drop the `deleteSession` call, leaving only the clearing header. Re-run.
Expected: "invalidates the session server-side" FAILS — the second `/auth/session` is 200, because clearing the browser's copy did nothing to the record. Restore.

This is the distinction that chose a stored session over a signed one; it gets an assertion rather than a paragraph.

- [ ] **Step 7: Verify and commit**

```bash
npm run verify
git add src/oauth/routes.ts tests/panel-session.test.ts
git commit -m "feat(oauth): /auth/session and /auth/signout

/auth/session returns the identity and nothing that costs a second store
read. It is the panel's boot call, made on every load; /account adds
entitlements and a count of this month's creates, which is a round trip
to the registry, and deciding whether to render the app or a sign-in
button needs neither. Pinned by a test that hands it a store which
throws from countCreatesThisMonth.

Its 401 carries no WWW-Authenticate. That header tells an OAuth client
where discovery starts, and a browser cannot act on it.

/auth/signout deletes the record and then clears the cookie with every
attribute that set it — a Set-Cookie differing in Path does not
overwrite, it adds a second cookie, and the session stays live while
appearing to have been signed out of. It is idempotent and succeeds with
no cookie at all, because the recourse for a failed sign-out is to leave
the session open.

That the delete is server-side has its own test: dropping it leaves the
next /auth/session answering 200. It is the whole reason the cookie is a
stored id rather than a signed token."
```

---

### Task 9: Wiring the browser layer into the routes, and keeping cookies out of `/admin`

**Files:**
- Modify: `src/oauth/routes.ts` (`handleOAuth` preflight, `/account`, `/admin/grants`)
- Test: `tests/browser-safety.test.ts` (extend with route-level tests)

**Interfaces:**
- Consumes: everything from Tasks 4–8, plus `tests/helpers/panel.ts` from Task 6.
- Produces: `OPTIONS` handling on the panel paths; `/account` answering a browser with CORS; `/admin/grants` refusing cookie callers.

- [ ] **Step 1: Write the failing tests**

Append to `tests/browser-safety.test.ts`:

```ts
import { beforeEach } from "vitest";
import { handleOAuth, type OAuthConfig } from "../src/oauth/routes.js";
import { ACCESS_TOKEN_TTL_SECONDS, signJwt } from "../src/oauth/tokens.js";
import {
  COOKIE, IDENTITY, ISSUER, PANEL as PANEL_ORIGIN, panelConfig, routeWith, seedSession,
} from "./helpers/panel.js";

describe("CORS through the real routes", () => {
  let cfg: OAuthConfig;
  let route: (r: Request) => Promise<Response>;

  beforeEach(() => {
    cfg = panelConfig();
    route = routeWith(cfg);
  });

  it("answers a preflight on /auth/session", async () => {
    const res = await route(new Request(`${ISSUER}/auth/session`, {
      method: "OPTIONS",
      headers: { origin: PANEL_ORIGIN, "access-control-request-method": "GET" },
    }));

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(PANEL_ORIGIN);
    expect(res.headers.get("vary")).toBe("Origin");
  });

  it("answers a preflight on /auth/signout", async () => {
    const res = await route(new Request(`${ISSUER}/auth/signout`, {
      method: "OPTIONS",
      headers: { origin: PANEL_ORIGIN, "access-control-request-method": "POST" },
    }));

    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("answers a preflight on /account", async () => {
    const res = await route(new Request(`${ISSUER}/account`, {
      method: "OPTIONS",
      headers: { origin: PANEL_ORIGIN, "access-control-request-method": "GET" },
    }));

    expect(res.headers.get("access-control-allow-origin")).toBe(PANEL_ORIGIN);
  });

  it("grants no CORS to a stranger's preflight", async () => {
    const res = await route(new Request(`${ISSUER}/auth/session`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    }));

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("puts CORS on a real /account response", async () => {
    const sid = await seedSession(cfg);
    const res = await route(new Request(`${ISSUER}/account`, {
      headers: { accept: "application/json", origin: PANEL_ORIGIN, cookie: `${COOKIE}=${sid}` },
    }));

    expect(res.headers.get("access-control-allow-origin")).toBe(PANEL_ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("vary")).toBe("Origin");
  });

  it("does not answer a preflight on /mcp — MCP clients are not browsers", async () => {
    const res = await handleOAuth(
      new Request(`${ISSUER}/mcp`, { method: "OPTIONS", headers: { origin: PANEL_ORIGIN } }),
      cfg
    );

    expect(res).toBeUndefined();
  });
});

describe("/admin stays bearer-only", () => {
  let cfg: OAuthConfig;
  let route: (r: Request) => Promise<Response>;

  /** A team admin the operator granted — the only identity that may write grants. */
  const OPERATOR_ADMIN = {
    ...IDENTITY, orgId: "acme", plan: "team" as const, role: "admin" as const,
  };

  const grantBody = JSON.stringify({
    key: "github:999", plan: "pro", role: "member", orgId: "acme",
  });

  beforeEach(() => {
    cfg = panelConfig();
    route = routeWith(cfg);
  });

  it("refuses a cookie-authenticated read of the grant list", async () => {
    const sid = await seedSession(cfg, "admin-sid", {
      identity: OPERATOR_ADMIN, plan_source: "operator",
    });

    const res = await route(new Request(`${ISSUER}/admin/grants`, {
      headers: { cookie: `${COOKIE}=${sid}`, origin: PANEL_ORIGIN },
    }));

    expect(res.status).toBe(401);
  });

  it("refuses a cookie-authenticated grant write", async () => {
    const sid = await seedSession(cfg, "admin-sid", {
      identity: OPERATOR_ADMIN, plan_source: "operator",
    });

    const res = await route(new Request(`${ISSUER}/admin/grants`, {
      method: "POST",
      headers: {
        cookie: `${COOKIE}=${sid}`, origin: PANEL_ORIGIN, "content-type": "application/json",
      },
      body: grantBody,
    }));

    expect(res.status).toBe(401);
  });

  /**
   * The same identity over a bearer token still works. Without this the two
   * tests above would pass for a trivially wrong reason — /admin/grants broken
   * for everyone.
   */
  it("still accepts the identical identity over a bearer token", async () => {
    const token = await signJwt(
      { iss: ISSUER, sub: OPERATOR_ADMIN.userId, aud: cfg.resource,
        bellman: OPERATOR_ADMIN, plan_source: "operator" },
      cfg.secret, ACCESS_TOKEN_TTL_SECONDS
    );

    const res = await route(new Request(`${ISSUER}/admin/grants`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: grantBody,
    }));

    expect(res.status).toBe(201);
  });

  it("grants no CORS on /admin, so a browser cannot even read the refusal", async () => {
    const res = await route(new Request(`${ISSUER}/admin/grants`, {
      headers: { origin: PANEL_ORIGIN },
    }));

    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("CSRF through the real routes", () => {
  let cfg: OAuthConfig;
  let route: (r: Request) => Promise<Response>;

  beforeEach(() => {
    cfg = panelConfig();
    route = routeWith(cfg);
  });

  it("refuses a cookie POST to /auth/signout with no Origin, and the session survives", async () => {
    const sid = await seedSession(cfg);

    const res = await route(new Request(`${ISSUER}/auth/signout`, {
      method: "POST",
      headers: { cookie: `${COOKIE}=${sid}` },
    }));

    expect(res.status).toBe(403);
    expect((await route(new Request(`${ISSUER}/auth/session`, {
      headers: { cookie: `${COOKIE}=${sid}` },
    }))).status).toBe(200);
  });

  it("refuses a cookie POST from an origin off the list", async () => {
    const sid = await seedSession(cfg);

    const res = await route(new Request(`${ISSUER}/auth/signout`, {
      method: "POST",
      headers: { cookie: `${COOKIE}=${sid}`, origin: "https://evil.example" },
    }));

    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run tests/browser-safety.test.ts`
Expected: FAIL — no `OPTIONS` handling; `/admin/grants` accepts a cookie; `/account` carries no CORS.

- [ ] **Step 3: Add preflight handling**

At the top of `handleOAuth`, after `method` is computed:

```ts
  /**
   * The paths the panel reaches with fetch, and the only ones that get CORS.
   *
   * Not /mcp: MCP clients are not browsers, and a CORS surface there invites a
   * browser to try. Not /admin: see the branch below. Not /auth/signin or
   * /callback/:provider, which are navigations and never subject to the
   * same-origin policy.
   */
  const browserPath = path === "/auth/session" || path === "/auth/signout" || path === "/account";

  if (method === "OPTIONS" && browserPath) {
    return preflightResponse(allowedOrigin(request, config.panelOrigins));
  }
```

- [ ] **Step 4: Put CORS on `/account`**

In the `/account` branch, take the origin once and add it to both exits:

```ts
  if (method === "GET" && path === "/account") {
    const origin = allowedOrigin(request, config.panelOrigins);
    const who = await caller(request, config);
    if (!who) {
      return new Response("Sign in to see your account.", {
        status: 401,
        headers: {
          ...unauthorizedHeaders(config),
          "content-type": "text/plain",
          ...corsHeaders(origin),
        },
      });
    }
```

and at the JSON exit:

```ts
    if ((request.headers.get("accept") ?? "").includes("application/json")) {
      return json(account, 200, corsHeaders(origin));
    }
```

`unauthorizedHeaders` stays on `/account`'s 401: it is reached by bearer clients too, and RFC 9728 discovery is what one of those needs. `/auth/session` is the browser-only endpoint, and that is where the header is omitted.

- [ ] **Step 5: Refuse cookies on `/admin/*`**

At the top of the `/admin/grants` branch, right after `caller`:

```ts
  if (path === "/admin/grants") {
    const who = await caller(request, config);
    if (!who) return oauthError("invalid_token", "sign in first", 401);
    /**
     * Bearer only, and deliberately not a role check.
     *
     * The writes below gate on planSource === "operator", so a cookie that
     * carried it would be an operator bit on the customer session — the thing
     * #61 rules out, even though the endpoint is itself org-scoped. Operator
     * authority derives from deploy access, and converting "can deploy" into
     * "holds a session cookie" is a strictly weaker credential for the one
     * account whose compromise is every customer's problem rather than one
     * customer's.
     *
     * No CORS either, so a browser cannot read this refusal — there is nothing
     * here for the panel to do with it. When #53-#58 build the org-admin UI,
     * that is the point to design a cookie-reachable admin surface on purpose.
     */
    if (who.via === "cookie") {
      return oauthError(
        "invalid_token",
        "this endpoint requires a bearer token, not a browser session",
        401
      );
    }
    const { identity } = who;
```

- [ ] **Step 6: Run everything and confirm it passes**

Run: `npm test`
Expected: PASS, every file.

- [ ] **Step 7: Prove the `/admin` refusal is not vacuous**

Temporarily remove the `who.via === "cookie"` guard. Re-run.
Expected: both "refuses a cookie-authenticated…" tests FAIL, with 201 and 200. Restore, and confirm the bearer test still passes — that pairing is what distinguishes "cookies refused" from "endpoint broken".

- [ ] **Step 8: Verify and commit**

```bash
npm run verify
git add src/oauth/routes.ts tests/browser-safety.test.ts
git commit -m "feat(oauth): CORS on the panel's three endpoints, and no cookies on /admin

Preflight and CORS go on /auth/session, /auth/signout and /account — the
three the panel reaches with fetch. Not /mcp, because MCP clients are
not browsers and a CORS surface there invites one to try. Not
/auth/signin or /callback/:provider, which are navigations and never
subject to the same-origin policy.

/admin/grants refuses a cookie outright rather than checking a role. Its
writes gate on planSource === 'operator', so a cookie carrying that
would be an operator bit on the customer session — what #61 rules out,
org-scoped endpoint or not. Operator authority derives from deploy
access, and turning 'can deploy' into 'holds a session cookie' weakens
the one credential whose compromise is every customer's problem rather
than one customer's.

It carries no CORS either, so a browser cannot read the refusal. There
is nothing there for the panel to do with it yet.

The refusal is tested against the identical identity over a bearer
token, which is what tells 'cookies refused' apart from 'endpoint
broken'."
```

---

### Task 10: Worker wiring, the config var, and the architecture note

**Files:**
- Modify: `src/worker.ts` (`WorkerEnv`, `oauthConfig`)
- Modify: `wrangler.toml`
- Modify: `docs/ARCHITECTURE.md`

**Interfaces:**
- Consumes: `parsePanelOrigins` (Task 5), `panelOrigins` on `OAuthConfig` (Task 5).
- Produces: `BELLMAN_PANEL_ORIGINS?: string` on `WorkerEnv`.

`parsePanelOrigins` is already written and tested in Task 5, deliberately: `src/worker.ts` imports `cloudflare:workers` and cannot be reached from a vitest test, so the logic lives where it can be.

- [ ] **Step 1: Add the var to `WorkerEnv`**

In `src/worker.ts`, after `BELLMAN_USERS`:

```ts
  /**
   * Comma-separated origins the control panel is served from, e.g.
   * "https://dash.bellman.sh". Unset means no browser may hold a session —
   * browser authentication is a capability this grants, not a default it
   * restricts.
   */
  BELLMAN_PANEL_ORIGINS?: string;
```

- [ ] **Step 2: Pass it into `oauthConfig`**

In the object `oauthConfig` returns, after `overrides`:

```ts
    panelOrigins: parsePanelOrigins(env.BELLMAN_PANEL_ORIGINS),
```

With the import:

```ts
import { parsePanelOrigins } from "./oauth/browser.js";
```

- [ ] **Step 3: Typecheck both programs**

Run: `npm run typecheck && npm run typecheck:worker`
Expected: both clean. The Worker program compiles all of `src`, so a `panelOrigins` type mismatch surfaces here rather than at deploy.

- [ ] **Step 4: Add the var to `wrangler.toml`**

In the existing `[vars]` block:

```toml
# Where the control panel is served from. Comma-separated; bare origins, no
# trailing slash. A var rather than a secret: it is not sensitive, and changing
# which origins may hold a browser session should be a reviewed commit.
#
# Unset means no browser may sign in at all. That is the fail-closed direction —
# an empty allowlist read as "no restriction" would accept a session cookie
# from anywhere.
BELLMAN_PANEL_ORIGINS = "https://dash.bellman.sh"
```

- [ ] **Step 5: Document it in the architecture**

Add to `docs/ARCHITECTURE.md`, in the trust-boundaries material alongside the existing peer-content entry:

```markdown
- **The control panel holds a cookie, not a token** — `dash.bellman.sh` renders
  billing and provider keys, so a token in web storage there would turn any XSS
  into account takeover. The panel authenticates with an `HttpOnly` cookie it
  cannot read: 32 random bytes over a `PanelSession` record in `AuthDO`, so
  `POST /auth/signout` invalidates rather than clearing the browser's copy. The
  cookie is `__Host-`-prefixed, which makes the browser enforce host-only
  scoping — a sibling subdomain of `bellman.sh` cannot set that name, so it
  cannot toss a session cookie at the API. It resolves through the same `caller`
  seam a bearer token does, and the stored plan is re-resolved on the access
  token's own staleness bound, so a revoked grant cannot outlive on the panel
  what it outlives on `/mcp`.

  **The cookie carries tenant-scoped identity only.** `Identity` has no operator
  field, and `role: "admin"` is admin of an org. `/admin/*` refuses a cookie
  outright rather than checking a role, because its writes gate on
  `planSource === "operator"` — operator authority derives from deploy access, a
  Worker secret, and a browser session is a strictly weaker credential for the
  one account whose compromise is every customer's problem.

  **CSRF is an `Origin` check, not a token.** `SameSite=Lax` blocks cross-site
  forgery, but SameSite is evaluated on the registrable domain — so `bellman.sh`
  is same-site with `mcp.bellman.sh`, and an XSS on the marketing site would
  otherwise POST here with the cookie attached. Every cookie-authenticated
  mutation must carry an allowlisted `Origin`; bearer callers are exempt.
```

- [ ] **Step 6: Verify and commit**

```bash
npm run verify
git add src/worker.ts wrangler.toml docs/ARCHITECTURE.md
git commit -m "feat(worker): BELLMAN_PANEL_ORIGINS, and the cookie session in ARCHITECTURE

A var rather than a secret: it is not sensitive, and changing which
origins may hold a browser session should be a reviewed commit, the same
argument wrangler.toml already makes for BELLMAN_BILLING.

Unset means no browser may sign in at all, which is the fail-closed
direction — an empty allowlist read as 'no restriction' would accept a
session cookie from anywhere.

The parser itself lives in src/oauth/browser.ts, where a vitest test can
reach it: src/worker.ts imports cloudflare:workers and is excluded from
the Node build."
```

---

### Task 11: The acceptance walk-through

**Files:**
- Test: `tests/panel-session.test.ts` (extend)
- Modify: `docs/superpowers/specs/2026-10-02-dash-browser-session-design.md` (tick the acceptance boxes)

**Interfaces:**
- Consumes: everything. No new production code — if this task needs any, an earlier task is incomplete.

One test that walks the whole thing in the order a human meets it. The unit tests prove each piece; this proves they compose.

- [ ] **Step 1: Write the walk-through**

```ts
describe("the whole panel session, end to end", () => {
  it("signs in, reads the account, signs out, and is then refused", async () => {
    // 1. The panel boots with nothing. 401, no WWW-Authenticate, CORS present.
    const cold = await route(new Request(`${ISSUER}/auth/session`, {
      headers: { origin: PANEL },
    }));
    expect(cold.status).toBe(401);
    expect(cold.headers.get("www-authenticate")).toBeNull();
    expect(cold.headers.get("access-control-allow-origin")).toBe(PANEL);

    // 2. The human signs in through GitHub.
    const chooser = await route(new Request(
      `${ISSUER}/auth/signin?return_to=${encodeURIComponent(`${PANEL}/rooms`)}`
    ));
    const req = decodeURIComponent(
      /href="\/authorize\/github\?req=([^"]+)"/.exec(await chooser.text())![1]
    );
    await route(new Request(`${ISSUER}/authorize/github?req=${encodeURIComponent(req)}`));
    const back = await route(new Request(
      `${ISSUER}/callback/github?code=upstream-code&state=${encodeURIComponent(req)}`
    ));

    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe(`${PANEL}/rooms`);
    const sid = /__Host-bellman_session=([^;]+)/.exec(back.headers.get("set-cookie")!)![1];

    // 3. The panel's boot call now answers.
    const session = await route(withCookie("/auth/session", sid, {
      headers: { origin: PANEL },
    }));
    expect(session.status).toBe(200);
    expect(((await session.json()) as { user_id: string }).user_id).toBe("u_github_4242");

    // 4. And so does the account screen, with CORS and the full body.
    const account = await route(withCookie("/account", sid, {
      headers: { origin: PANEL, accept: "application/json" },
    }));
    expect(account.status).toBe(200);
    const body = (await account.json()) as Record<string, unknown>;
    expect(body.plan).toBe("free");
    expect(body.entitlements).toBeDefined();
    expect(account.headers.get("access-control-allow-credentials")).toBe("true");

    // 5. /admin is not reachable with it, whatever the identity says.
    const admin = await route(withCookie("/admin/grants", sid, {
      headers: { origin: PANEL },
    }));
    expect(admin.status).toBe(401);

    // 6. A write with no Origin is refused, and the session survives it.
    const forged = await route(new Request(`${ISSUER}/auth/signout`, {
      method: "POST", headers: { cookie: `${COOKIE}=${sid}` },
    }));
    expect(forged.status).toBe(403);
    expect((await route(withCookie("/auth/session", sid))).status).toBe(200);

    // 7. Signing out from the panel works, and is final.
    const out = await route(new Request(`${ISSUER}/auth/signout`, {
      method: "POST", headers: { cookie: `${COOKIE}=${sid}`, origin: PANEL },
    }));
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");

    expect((await route(withCookie("/auth/session", sid, {
      headers: { origin: PANEL },
    }))).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the whole verification**

Run: `npm run verify`
Expected: PASS, both programs.

- [ ] **Step 3: Tick the acceptance boxes in the spec**

Open `docs/superpowers/specs/2026-10-02-dash-browser-session-design.md` and tick each box in its Acceptance section, naming the test that covers it beside each. Any box without a test is a gap — add the test to the task that owns the code, not here, and come back.

- [ ] **Step 4: Commit**

```bash
npm run verify
git add tests/panel-session.test.ts docs/superpowers/specs/2026-10-02-dash-browser-session-design.md
git commit -m "test(oauth): the panel session end to end

Seven steps in the order a human meets them: a cold boot refused, a
GitHub sign-in, the boot call answering, the account screen with CORS,
/admin still refused, a forged write refused with the session intact,
and a sign-out that is final.

The unit tests prove each piece. This is the one that would notice if
they stopped composing — a cookie whose attributes are right but which
the parser cannot read back, a CORS header on the 401 but not the 200.

Acceptance boxes in the spec ticked against the tests that cover them."
```

- [ ] **Step 5: Open the pull request**

```bash
git push -u origin mcfearsome/a-browser-session-for-dash-the-panel-signs-in-wi
gh pr create --title "A browser session for dash: the panel signs in with a cookie" --body "$(cat <<'BODY'
Closes #48. Carries #61's two acceptance criteria.

Design: `docs/superpowers/specs/2026-10-02-dash-browser-session-design.md`
Plan: `docs/superpowers/plans/2026-10-02-dash-browser-session.md`

`dash.bellman.sh` renders billing and provider keys, so it cannot hold a
bearer token: one in web storage turns any XSS into account takeover. It
now authenticates with an `HttpOnly` cookie it never sees.

## What this adds

- `GET /auth/signin` → the provider hand-off, reusing `/callback/:provider`
  via a third state audience, so no new redirect URI has to be registered
  with GitHub or Google.
- `GET /auth/session` → the identity, or 401. The panel's boot call; it
  deliberately costs no second store read.
- `POST /auth/signout` → deletes the record, then clears the cookie.
- CORS on those two plus `/account`, with an explicit allowlist from
  `BELLMAN_PANEL_ORIGINS`.
- An `Origin` check on every cookie-authenticated mutation.

## The decisions worth reviewing

**The cookie is an opaque id over a record in `AuthDO`, not a signed
token.** A signed cookie is less code and cannot be revoked; `tokens.ts`
already says short TTLs are the only mitigation an unrevocable token
gets, and that is not a deal a page showing billing should take.

**It is `__Host-`-prefixed.** The design called for host-only with no
`Domain`, which our code honours. The prefix makes the *browser* enforce
it, which additionally stops a sibling subdomain of `bellman.sh` setting
this name and tossing a cookie at the API — RFC 6265 leaves the order of
two same-named cookies unspecified, so without it the one we read is
attacker-selectable. It requires `Secure`, so `http://localhost` gets the
unprefixed name and is the one place the protection is absent.

**`/admin/*` refuses a cookie outright** rather than checking a role. Its
writes gate on `planSource === "operator"`, so a cookie carrying that
would be an operator bit on the customer session — what #61 rules out,
org-scoped endpoint or not. Tested against the identical identity over a
bearer token, which is what tells "cookies refused" apart from "endpoint
broken".

**Plan staleness is bounded by `ACCESS_TOKEN_TTL_SECONDS`**, the same ten
minutes `/mcp` already has, so a revoked grant cannot outlive on the panel
what it outlives on the tool surface.

**Peer content and the trust boundaries around it are untouched.** Nothing
here changes how peer content crosses or how it is escaped.

## Not in this PR

The `/api/*` surface is #49. The `dash` repo is untouched. Audited
operator reads need #58's tamper evidence.

No new MCP tool, so `extension/manifest.json` is unchanged.
BODY
)"
```

---

## Self-Review

**1. Spec coverage.** Each section of the spec against a task:

| Spec section | Task |
|---|---|
| Decision 1 — same-site, cross-origin; host-only cookie | 4 (cookie), 5 (CORS), 10 (var) |
| Decision 2 — opaque id over a stored record | 1, 2 |
| Decision 3 — 7-day ceiling, 24-hour idle | 1, 2 |
| Decision 4 — `/admin/*` bearer-only | 9 |
| `PanelSession`, `sessionDead`, `replannedAt` | 1 |
| Three `AuthStorage` methods; `touchSession` atomicity; the write skip | 1, 2 |
| The session sweep on `sessionDead` | 2 |
| `caller` gains `via`; re-resolution on the token's bound | 6 |
| What a session cannot carry | 6 (structural), 9 (asserted) |
| Routes; reusing `/callback/:provider` | 7 |
| `verifyState` | 3 |
| `return_to` validation | 7 |
| `/auth/session` response shape; no `WWW-Authenticate`; no second store read | 8 |
| `POST /auth/signout`, idempotent | 8 |
| CORS rules — never `*`, `Vary: Origin`, fail-closed, the three paths | 5, 9 |
| CSRF rule and the bearer exemption | 5, 9 |
| Cookie attributes | 4, 7 |
| Testing — all 12 numbered assertions in the spec | 1, 2, 4–9, 11 |
| `AuthStorage` has no conformance suite → `worker-tests/` | 2 |
| Out of scope, incl. `extension/manifest.json` | Global Constraints; Task 11's PR body |

No gaps. One addition beyond the spec — the `__Host-` prefix — stated in Task 4's commit and the PR body as a refinement rather than slipped in.

**2. Placeholder scan.** No `TBD`, no "add appropriate error handling", no "similar to Task N", no code step without code. Task 2 Step 1 is a deliberate read-first step; it names the exact command and what to take from its output.

**3. Type consistency.** Checked every name and arity across the tasks that define and call it: `sessionDead(s, now)`, `replannedAt(s)`, `putSession(id, value)`, `touchSession(id, now)`, `deleteSession(id)`, `sessionCookieName(secure)`, `serializeSessionCookie(id, secure, maxAgeSeconds)`, `clearedSessionCookie(secure)`, `readSessionCookie(request, secure)`, `allowedOrigin(request, panelOrigins)`, `corsHeaders(origin)`, `preflightResponse(origin)`, `csrfRefusal(request, via, origin)`, `parsePanelOrigins(raw)`, `panelDestination(returnTo, panelOrigins)`, `verifyState(token, config, audiences)`. `via` is `"bearer" | "cookie"` at every mention. `parsePanelOrigins` is defined in Task 5 and consumed in Task 10, not defined twice.

**4. Review Focus coverage.** All five have a test in the owning task, and each has a break-it step proving the assertion can fail: malformed/duplicated cookie (Task 4, Steps 1 and 5), non-URL `return_to` (Task 7, Steps 1 and 8), absent allowlist (Task 5, Steps 1 and 6), `Origin: null` (Task 5, Steps 1 and 6), absent `replanned_at` (Task 6, Steps 2 and 6). Task 6 Step 6 is the one that needs two attempts, because only one of the two plausible phrasings of that comparison is wrong — which is recorded in the step rather than left for the implementer to discover.
