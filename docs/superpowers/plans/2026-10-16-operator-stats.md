# Operator Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The operator reads the account count and the free/paid split from the dash, at `GET /operator/stats`, without any operator authority reaching the tenant session cookie.

**Architecture:**
- A leaf module `src/http/stats.ts` on the panel surface, modelled on `src/http/handles.ts`: the same caller, the panel's CORS, the same preflight, and `undefined` for every other path. Gated on the `operators` set `BELLMAN_OPERATORS` already names.
- `/admin/*` is not touched. Its two routes write, and their refusal of browser sessions stands.
- The response interface holds only numbers and a boolean, so a row cannot be expressed in it.
- Two PRs, in two repos: bellman (Part 1, Tasks 1-2) and dash (Part 2, Tasks 3-4).

**Tech Stack:** TypeScript, Cloudflare Workers and Durable Objects, vitest. The dash is React 19 with TanStack Router and Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-16-operator-stats-design.md` (approved 2026-10-16).

## Global Constraints

- **Route:** `GET /operator/stats`. Not `/api/operator/stats`, not `/admin/stats`.
- **Response:** `{ accounts, free, paid, paidCapped }` and nothing else. No `userId`, `orgId`, email, label or join code, ever.
- **Refusals:** 401 `unauthorized` unsigned; 403 `not_available` for a non-operator, and its description names no secret and no mechanism; 405 on any method but GET; 500 `internal` on a store failure.
- **The gate:** `deps.operators?.has(who.identity.userId)`. Absent or empty set admits nobody.
- **Store methods:** every `BellmanStore` method is async. No new ones here — `countUsers` and `listGrants` both exist and are both already covered by the store contract.
- **`listGrants` takes no second argument.** `listGrants(limit, null)` filters to grants with no org; `undefined` is what asks for every org's.
- **Writing:** a room holds many members. Never "two sessions" or "the other session". No phrase from `~/.claude/projects/-Users-mcfearsome-src-github-com-bellman-sh-bellman/memory/banned-phrases.md` — in particular not "structural", "structurally", "load-bearing", or the "worth noting / knowing / saying / stating" family, in code, comments, commits, PRs or docs.
- **The dash compiles with `erasableSyntaxOnly`.** No constructor parameter properties.

## Review Focus

Five conditions the spec implies that no task's own tests would otherwise reach. Each has a test added to the task that owns the code.

1. **A lapsed grant must not count as paid.** `listGrants` drops expired grants in both stores ("an expired grant is not a grant"), so `paid` is already right — and a test here pins it, because this route is where a wrong number gets believed. Task 1.
2. **A grant whose plan is `free` must not count as paid.** `Plan` admits `free`, so counting grants rather than paid grants would overcount. Task 1.
3. **`/operator/stats/` with a trailing slash must answer, not 404.** The path is normalized before the comparison; without it a trailing slash falls through to the OAuth router. Task 1.
4. **An operator holding a bearer token gets the same answer as one holding a cookie.** This route does not read `who.via`, unlike `/admin/*`. That is intended, and untested it is an accident. Task 1.
5. **A store that rejects must answer 500, not throw out of the handler.** An unhandled rejection in a Worker is a 1101, which tells a customer more than a 500 does. Task 1.

## Rulings on the spec

- **R1. `paidCapped` is `grants.length === MAX_GRANTS_COUNTED`, not `paid === MAX_GRANTS_COUNTED`.** Spec D8 says the latter. `paid` excludes free grants, so with 1000 grants of which ten are free, `paid` is 990 and the bound was still reached. What the flag reports is that the scan hit its limit, which is `grants.length`. *Cost if wrong:* the flag stays false while the numbers are short.
- **R2. The operator check runs before the method check.** So a non-operator sending POST gets 403, not 405. A 405 would confirm the route exists to someone who may not know. Spec D5 gives the order as method-then-nothing; this fixes the order. *Cost if wrong:* a customer learns a route name.
- **R3. No nav entry in the dash. The page is reached by URL.** Spec D10 says a 403 hides the nav entry, which would need the shell to probe `/operator/stats` on every signed-in page load — a request every customer pays for so one person sees a link. There is one operator and a bookmark costs nothing. `NAV` in `src/components/layout/app-shell.tsx` is untouched. *Cost if wrong:* the operator types a URL.
- **R4. The loader answers `null` for a 403 rather than throwing to the error component.** `orSignIn` already turns a 401 into a sign-in redirect and rethrows the rest, which would put the route's error screen in front of a customer who guessed the URL. `null` lets the page render its own refusal. *Cost if wrong:* a customer sees an error page instead of a sentence.

---

## Task 1: The stats route module

**Files:**
- Create: `src/http/stats.ts`
- Test: `tests/stats.test.ts`

**Interfaces:**
- Consumes: `allowedOrigin`, `preflightResponse` from `src/oauth/browser.js`; `json`, `problem`, `methodNotAllowed`, `RoomRouteDeps`, `RoomCaller` from `src/http/rooms.js`; `BellmanStore.countUsers()`, `BellmanStore.listGrants(limit, orgId?)`.
- Produces: `statsRoutes(request: Request, deps: StatsRouteDeps): Promise<Response | undefined>`, `StatsRouteDeps`, `PlatformStats`, `MAX_GRANTS_COUNTED`. Task 2 wires `statsRoutes`.

- [ ] **Step 1: Write the failing test file**

Create `tests/stats.test.ts`:

```ts
/**
 * The operator's platform stats (operator stats spec D1), driven as both servers
 * drive the route modules: a Request in, a Response out, over a MemoryStore.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resolveIdentity } from "../src/auth.js";
import type { RoomCaller } from "../src/http/rooms.js";
import { MAX_GRANTS_COUNTED, statsRoutes, type StatsRouteDeps } from "../src/http/stats.js";
import { MemoryStore } from "../src/store.js";
import type { PlanGrant } from "../src/types.js";
import { DEV_KEY } from "./helpers/harness.js";

const ISSUER = "https://mcp.example.test";
const PANEL = "https://dash.example.test";

let store: MemoryStore;
let deps: StatsRouteDeps;

/** Bearer: a dev key. Cookie: the dev key as the cookie's value. The preset routes' tests use the same. */
const caller = async (request: Request): Promise<RoomCaller | null> => {
  const bearer = resolveIdentity(request.headers.get("authorization") ?? undefined);
  if (bearer) return { identity: bearer, via: "bearer" };
  const cookie = /bellman_session=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  const identity = cookie ? resolveIdentity(`Bearer ${cookie}`) : null;
  return identity ? { identity, via: "cookie" } : null;
};

beforeEach(() => {
  store = new MemoryStore();
  // u_jesse is DEV_KEY.jesse's userId; u_peer is DEV_KEY.peer's.
  deps = { store, caller, panelOrigins: [PANEL], operators: new Set(["u_jesse"]) };
});

interface CallOptions { method?: string; cookie?: string; origin?: string }

function call(key: string | null, path = "/operator/stats", over: CallOptions = {}) {
  const headers: Record<string, string> = {};
  if (key) headers.authorization = `Bearer ${key}`;
  if (over.cookie) headers.cookie = `__Host-bellman_session=${over.cookie}`;
  if (over.origin) headers.origin = over.origin;
  return statsRoutes(new Request(`${ISSUER}${path}`, { method: over.method ?? "GET", headers }), deps);
}

const bodyOf = async (res: Response | undefined) => (await res!.json()) as Record<string, unknown>;

const grant = (over: Partial<PlanGrant> = {}): PlanGrant => ({
  key: "github:4242",
  plan: "pro",
  role: "member",
  orgId: null,
  source: "purchase",
  grantedAt: Date.now(),
  grantedBy: "u_jesse",
  expiresAt: null,
  ...over,
});

describe("GET /operator/stats", () => {
  it("carries on for any other path", async () => {
    expect(await call(DEV_KEY.jesse, "/operator")).toBeUndefined();
    expect(await call(DEV_KEY.jesse, "/operator/stats/extra")).toBeUndefined();
    expect(await call(DEV_KEY.jesse, "/rooms")).toBeUndefined();
  });

  // Review focus 3.
  it("answers a trailing slash", async () => {
    expect((await call(DEV_KEY.jesse, "/operator/stats/"))!.status).toBe(200);
  });

  it("refuses a caller it cannot identify", async () => {
    const res = await call(null);
    expect(res!.status).toBe(401);
    expect(await bodyOf(res)).toMatchObject({ error: "unauthorized" });
  });

  it("refuses a signed-in caller the operators set does not name, and names no mechanism", async () => {
    const res = await call(DEV_KEY.peer);
    expect(res!.status).toBe(403);
    const body = await bodyOf(res);
    expect(body).toMatchObject({ error: "not_available" });
    expect(JSON.stringify(body)).not.toMatch(/BELLMAN_OPERATORS|operator/i);
  });

  it("admits nobody when the operators set is absent or empty", async () => {
    deps = { ...deps, operators: undefined };
    expect((await call(DEV_KEY.jesse))!.status).toBe(403);
    deps = { ...deps, operators: new Set() };
    expect((await call(DEV_KEY.jesse))!.status).toBe(403);
  });

  // Ruling R2.
  it("refuses a non-operator before it reports the method", async () => {
    expect((await call(DEV_KEY.peer, "/operator/stats", { method: "POST" }))!.status).toBe(403);
  });

  it("answers 405 to an operator sending anything but GET", async () => {
    const res = await call(DEV_KEY.jesse, "/operator/stats", { method: "POST" });
    expect(res!.status).toBe(405);
    expect(res!.headers.get("allow")).toBe("GET");
  });

  it("answers the preflight for the panel's origin without a credential", async () => {
    const res = await call(null, "/operator/stats", { method: "OPTIONS", origin: PANEL });
    expect(res!.status).toBe(204);
    expect(res!.headers.get("access-control-allow-origin")).toBe(PANEL);
  });

  it("counts nobody on an empty store", async () => {
    expect(await bodyOf(await call(DEV_KEY.jesse))).toEqual({
      accounts: 0, free: 0, paid: 0, paidCapped: false,
    });
  });

  it("counts accounts, and reads free as the ones no grant covers", async () => {
    await store.recordSignIn("u_a", Date.now());
    await store.recordSignIn("u_b", Date.now());
    await store.recordSignIn("u_c", Date.now());
    await store.putGrant(grant({ key: "github:1", plan: "pro" }));
    await store.putGrant(grant({ key: "github:2", plan: "team" }));

    expect(await bodyOf(await call(DEV_KEY.jesse))).toEqual({
      accounts: 3, free: 1, paid: 2, paidCapped: false,
    });
  });

  // Review focus 2.
  it("does not count a grant whose plan is free as paid", async () => {
    await store.recordSignIn("u_a", Date.now());
    await store.putGrant(grant({ key: "github:1", plan: "free" }));

    expect(await bodyOf(await call(DEV_KEY.jesse))).toMatchObject({ accounts: 1, free: 1, paid: 0 });
  });

  // Review focus 1.
  it("does not count a lapsed grant as paid", async () => {
    await store.recordSignIn("u_a", Date.now());
    await store.putGrant(grant({ key: "github:1", plan: "pro", expiresAt: Date.now() - 1 }));

    expect(await bodyOf(await call(DEV_KEY.jesse))).toMatchObject({ accounts: 1, free: 1, paid: 0 });
  });

  it("floors free at zero rather than reporting a negative count of people", async () => {
    // A grant for a key that has never signed in: paid exceeds accounts.
    await store.putGrant(grant({ key: "github:1", plan: "pro" }));

    expect(await bodyOf(await call(DEV_KEY.jesse))).toMatchObject({ accounts: 0, free: 0, paid: 1 });
  });

  // Ruling R1.
  it("says so when the grant scan reached its bound", async () => {
    for (let i = 0; i < MAX_GRANTS_COUNTED; i += 1) {
      await store.putGrant(grant({ key: `github:${i}` }));
    }
    expect(await bodyOf(await call(DEV_KEY.jesse))).toMatchObject({
      paid: MAX_GRANTS_COUNTED, paidCapped: true,
    });
  });

  // Review focus 4.
  it("answers a bearer-token operator as it answers a cookie one", async () => {
    await store.recordSignIn("u_a", Date.now());
    const byBearer = await bodyOf(await call(DEV_KEY.jesse));
    const byCookie = await bodyOf(await call(null, "/operator/stats", { cookie: DEV_KEY.jesse }));
    expect(byCookie).toEqual(byBearer);
  });

  // Spec D6: the guard that fails if the response type is widened to carry a row.
  it("answers scalars only", async () => {
    await store.recordSignIn("u_a", Date.now());
    const body = await bodyOf(await call(DEV_KEY.jesse));
    for (const [field, value] of Object.entries(body)) {
      expect(typeof value, field).toMatch(/^(number|boolean)$/);
    }
  });

  // Review focus 5.
  it("answers 500 when the store fails, rather than throwing out of the handler", async () => {
    // Assigned on the instance, not spread into a literal: `{ ...store }` copies
    // own properties only, so listGrants would go missing and the 500 would come
    // from the wrong cause.
    const failing = new MemoryStore();
    failing.countUsers = () => Promise.reject(new Error("registry unreachable"));
    deps = { ...deps, store: failing };
    const res = await call(DEV_KEY.jesse);
    expect(res!.status).toBe(500);
    expect(await bodyOf(res)).toMatchObject({ error: "internal" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/stats.test.ts`
Expected: FAIL — `Failed to resolve import "../src/http/stats.js"`.

- [ ] **Step 3: Write the module**

Create `src/http/stats.ts`:

```ts
/**
 * The operator's platform stats (operator stats spec D1): three numbers and a
 * flag, at `/operator/stats`. On the handle routes' rules — the same caller,
 * CORS for the panel's origins, the same preflight — and with no CSRF check,
 * because there is no write here (D5).
 *
 * The one route on this surface not scoped to the caller's own account, and the
 * one gated on `operators` (D2). A route that writes belongs on `/admin/*`
 * behind a bearer token, whose refusal of browser sessions this does not touch.
 */
import { allowedOrigin, preflightResponse } from "../oauth/browser.js";
import { json, methodNotAllowed, problem, type RoomRouteDeps } from "./rooms.js";

export type StatsRouteDeps = Pick<RoomRouteDeps, "store" | "caller" | "panelOrigins"> & {
  /** The user ids BELLMAN_OPERATORS names. Absent or empty admits nobody. */
  operators?: ReadonlySet<string>;
};

/**
 * Scalars only, by type (#259, spec D6).
 *
 * A userId, an email, an orgId, a label or a join code added here is a compile
 * error rather than something a reviewer has to catch. The endpoint was asked
 * for on the condition that it cannot return a row, and this interface is that
 * condition written down.
 */
export interface PlatformStats {
  accounts: number;
  free: number;
  paid: number;
  paidCapped: boolean;
}

// ponytail: 1000 grants, not tuned. One grant per paying key; at three paid
// accounts this is years of headroom. paidCapped is what says when it is not.
export const MAX_GRANTS_COUNTED = 1000;

const PATH = "/operator/stats";

/** `undefined` for any other path, so the server carries on. */
export async function statsRoutes(request: Request, deps: StatsRouteDeps): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (path !== PATH) return undefined;
  const origin = allowedOrigin(request, deps.panelOrigins);
  // Before the caller is read: a browser sends no credential on a preflight.
  if (request.method === "OPTIONS") return preflightResponse(origin);
  try {
    const who = await deps.caller(request);
    if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
    /**
     * Names no mechanism, unlike the refusals on /admin/*, which say "limited to
     * the user ids BELLMAN_OPERATORS lists" and are read only by someone already
     * holding a bearer token. Any signed-in customer can try this URL (D4).
     *
     * Ahead of the method check on purpose (ruling R2): a 405 would confirm the
     * route to someone who may not know it is there.
     */
    if (!deps.operators?.has(who.identity.userId)) {
      return problem(403, "not_available", "this account has no platform stats", origin);
    }
    if (request.method !== "GET") return methodNotAllowed("GET", origin);

    // No second argument: listGrants(limit, null) filters to the grants with no
    // org, and undefined is what asks for every org's. Both stores drop a
    // lapsed grant before the bound is applied, so neither fills the window.
    const [accounts, grants] = await Promise.all([
      deps.store.countUsers(),
      deps.store.listGrants(MAX_GRANTS_COUNTED),
    ]);
    const paid = grants.filter((g) => g.plan !== "free").length;
    const stats: PlatformStats = {
      accounts,
      // Floored: a grant for a key that has never signed in makes this
      // negative, and a negative count of people is worse than a floor.
      free: Math.max(0, accounts - paid),
      paid,
      // The scan's bound, not the paid count (ruling R1): free grants come out
      // of `paid`, so `paid` can sit below the limit on a scan that reached it.
      paidCapped: grants.length === MAX_GRANTS_COUNTED,
    };
    return json(200, stats, origin);
  } catch (err) {
    console.error(`${request.method} ${path} failed:`, err);
    return problem(500, "internal", "the request failed on the server", origin);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/stats.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/http/stats.ts tests/stats.test.ts
git commit -m "Read the platform's account count at /operator/stats"
```

---

## Task 2: Wire the route into the Worker

**Files:**
- Modify: `src/worker.ts` — the import block at the top, and the dispatch chain beside the `/account/handle` block
- Modify: `src/app.ts` — the import block, and beside the `/account/handle` mount

**Interfaces:**
- Consumes: `statsRoutes`, `StatsRouteDeps` from Task 1.
- Produces: nothing a later task reads. Task 3 calls the deployed route over HTTP.

- [ ] **Step 1: Add the Worker dispatch**

In `src/worker.ts`, add to the import block beside the other route modules:

```ts
import { statsRoutes } from "./http/stats.js";
```

Then, immediately after the `/account/handle` block and before `if (oauth) {`:

```ts
    // The operator's platform stats (operator stats spec D1). On the room routes'
    // rules and the same guard, and gated on the operators set, which is why it
    // takes `operators`, `overrides` and `honourPurchases` where the others take
    // only `panelOrigins`. All three are required keys: a mount that omits one is a
    // compile error, because a forgotten dep would otherwise undercount `paid`.
    if (url.pathname === "/operator/stats" || url.pathname === "/operator/stats/") {
      const blocked = unconfigured(env, oauth);
      if (blocked) return blocked;
      const handled = await statsRoutes(request, {
        store,
        caller: (req) => roomCaller(req, env, oauth),
        panelOrigins: oauth?.panelOrigins ?? [],
        operators: oauth?.operators,
        overrides: oauth?.overrides,
        honourPurchases: oauth?.honourPurchases,
        operators: oauth?.operators,
      });
      if (handled) return handled;
    }
```

- [ ] **Step 2: Add the local server mount**

In `src/app.ts`, add to the import block:

```ts
import { statsRoutes } from "./http/stats.js";
```

Then beside the other `app.use` mounts, after the `/account/handle` line:

```ts
  // No operators locally: `npm start` serves the dev identities, and an operator
  // gate that admitted one of them would make the local server the loose one.
  app.use("/operator/stats", serve((request) => statsRoutes(request, {
    store, caller, panelOrigins: [],
    operators: undefined,
    // The local server reads neither secret, so these are its true values rather
    // than undefined, which the route would otherwise read as billing being on.
    overrides: {},
    honourPurchases: false,
  })));
```

- [ ] **Step 3: Typecheck both targets**

Run: `npm run typecheck && npm run typecheck:worker`
Expected: no output, exit 0 from both.

- [ ] **Step 4: Verify the Worker still bundles**

Run: `npx wrangler deploy --dry-run --outdir /tmp/stats-dry-run`
Expected: ends with `--dry-run: exiting now.` and no error.

- [ ] **Step 5: Run the whole suite**

Run: `npm test && npm run test:worker`
Expected: PASS, with the counts at or above the pre-change numbers. `drain()` lines in the worker output are pre-existing noise, not failures.

- [ ] **Step 6: Commit and open the bellman PR**

```bash
git add src/worker.ts src/app.ts
git commit -m "Serve /operator/stats from the Worker and the local server"
git push -u origin HEAD
gh pr create --fill
```

The PR body must say: `BELLMAN_OPERATORS` has to list the user id as the identity carries it, and an operator override in `BELLMAN_USERS` can rewrite that (spec D3). Check it against a real sign-in on first deploy — a mismatch reads as 403 with no hint why.

---

## Task 3: The dash's API call

**Files:**
- Modify: `/Users/mcfearsome/src/github.com/bellman-sh/dash/src/lib/api.ts` — append beside the other reads
- Test: `/Users/mcfearsome/src/github.com/bellman-sh/dash/src/lib/api.test.ts` if one exists; otherwise the coverage is Task 4's page test

All paths in Tasks 3 and 4 are in the **dash** repo, on its own branch and its own PR.

**Interfaces:**
- Consumes: `request`, `ApiError` (both already in `src/lib/api.ts`); the route from Task 2.
- Produces: `getPlatformStats(): Promise<PlatformStats | null>` and the `PlatformStats` interface. Task 4's loader calls it.

- [ ] **Step 1: Add the call**

Append to `src/lib/api.ts`:

```ts
/** Mirrors `GET /operator/stats` (operator stats spec D6): scalars only, never a row. */
export interface PlatformStats {
  accounts: number
  free: number
  paid: number
  /** The grant scan reached its bound, so `paid` is a floor and `free` a ceiling. */
  paidCapped: boolean
}

/**
 * The platform's counts, or `null` on an account that is not an operator's.
 *
 * A 403 is the answer for every account but one, not a failure to report
 * (ruling R4): thrown, it would put the route's error screen in front of a
 * customer who guessed the URL.
 */
export const getPlatformStats = (): Promise<PlatformStats | null> =>
  request<PlatformStats>("/operator/stats")
    .then((r) => r.body)
    .catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 403) return null
      throw err
    })
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: `tsc -b` passes and vite builds.

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "Read the platform stats through the API client"
```

---

## Task 4: The dash's stats page

**Files:**
- Create: `/Users/mcfearsome/src/github.com/bellman-sh/dash/src/routes/stats.tsx`
- Create: `/Users/mcfearsome/src/github.com/bellman-sh/dash/src/routes/stats.test.tsx`
- Modify: `/Users/mcfearsome/src/github.com/bellman-sh/dash/src/router.tsx` — a new route and one line in `shellRoute.addChildren`

`src/components/layout/app-shell.tsx` is **not** modified: there is no nav entry (ruling R3).

**Interfaces:**
- Consumes: `getPlatformStats`, `PlatformStats` from Task 3; `Page` from `@/components/layout/app-shell`; `orSignIn` from `@/lib/session`; `shellRoute` from `@/router`.
- Produces: `Stats` (the route component), `StatsPanel` (presentational, takes `data`), and `statsRoute`.

- [ ] **Step 1: Write the failing page test**

Create `src/routes/stats.test.tsx`. It renders the presentational component
with props, the way `src/routes/public-handle.test.tsx` renders `HandleRooms` —
no router mock, because the route component is the only part that touches the
router:

```tsx
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { StatsPanel } from "@/routes/stats"

describe("the platform stats panel", () => {
  it("shows the counts", () => {
    render(<StatsPanel data={{ accounts: 41, free: 38, paid: 3, paidCapped: false }} />)

    expect(screen.getByRole("heading", { name: "Platform stats" })).toBeInTheDocument()
    expect(screen.getByText("41")).toBeInTheDocument()
    expect(screen.getByText("38")).toBeInTheDocument()
    expect(screen.getByText("3")).toBeInTheDocument()
  })

  it("marks a paid count as a floor when the grant scan reached its bound", () => {
    render(<StatsPanel data={{ accounts: 41, free: 38, paid: 3, paidCapped: true }} />)

    expect(screen.getByText("3+")).toBeInTheDocument()
    expect(screen.queryByText("3")).not.toBeInTheDocument()
  })

  it("refuses without an error screen on an account that is not an operator's", () => {
    render(<StatsPanel data={null} />)

    expect(screen.getByText(/not available on this account/i)).toBeInTheDocument()
    expect(screen.queryByText("41")).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/routes/stats.test.tsx`
Expected: FAIL — cannot resolve `./stats`.

- [ ] **Step 3: Write the page**

Create `src/routes/stats.tsx`. Two exports, as `public-handle.tsx` has: the
route component reads the loader, and the panel takes its data as a prop so a
test can render it without a router.

```tsx
import { Page } from "@/components/layout/app-shell"
import type { PlatformStats } from "@/lib/api"
import { statsRoute } from "@/router"

/**
 * The operator's platform counts. Reached by URL, with no nav entry (plan
 * ruling R3): hiding one would mean every signed-in page load probing the
 * endpoint so that one person sees a link.
 */
export function Stats() {
  return <StatsPanel data={statsRoute.useLoaderData()} />
}

/** `null` is the answer on every account but the operator's, not a failure. */
export function StatsPanel({ data }: { data: PlatformStats | null }) {
  if (!data) {
    return (
      <Page title="Platform stats" description="Accounts across every org.">
        <div className="rounded-xl border border-border p-8 text-center text-sm text-muted-foreground">
          Not available on this account.
        </div>
      </Page>
    )
  }

  return (
    <Page title="Platform stats" description="Accounts across every org.">
      <dl className="grid gap-4 sm:grid-cols-3">
        <Count label="Accounts" value={String(data.accounts)} />
        <Count label="Free" value={String(data.free)} />
        {/* A capped scan makes paid a floor and free a ceiling, so paid is not stated flat. */}
        <Count label="Paid" value={data.paidCapped ? `${data.paid}+` : String(data.paid)} />
      </dl>
    </Page>
  )
}

function Count({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border p-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-3xl font-medium tabular-nums">{value}</dd>
    </div>
  )
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/routes/stats.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 5: Add the route**

In `src/router.tsx`, add `getPlatformStats` to the existing `@/lib/api` import, then add beside the other shell routes:

```tsx
export const statsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/stats",
  component: lazyRouteComponent(() => import("@/routes/stats"), "Stats"),
  loader: ({ location }) => orSignIn(location.href, getPlatformStats),
})
```

And add `statsRoute,` to the `shellRoute.addChildren([...])` list, after `presetEditRoute`.

- [ ] **Step 6: Run lint, the suite and the build**

Run: `npm run lint && npm test && npm run build`
Expected: PASS throughout. The build is `tsc -b && vite build`, so it typechecks the new route too.

- [ ] **Step 7: Commit and open the dash PR**

```bash
git add src/routes/stats.tsx src/routes/stats.test.tsx src/router.tsx
git commit -m "Show the platform's account counts at /stats"
git push -u origin HEAD
gh pr create --fill
```

---

## After both PRs merge

- [ ] Set the secret: `wrangler secret put BELLMAN_OPERATORS` in the bellman repo, with the user id as a real sign-in carries it (spec D3).
- [ ] Load `https://dash.bellman.sh/stats` and confirm the counts render.
- [ ] Sign in as a non-operator, or clear the secret, and confirm the page reads "Not available on this account" rather than an error screen.
- [ ] Edit #259 to this design: the route is `/operator/stats`, the refusal is 403, and `roomsThisMonth` and `roomsActive` are out of scope.
- [ ] Close the dash's operator stats panel issue, or retitle it to what shipped.
