/**
 * The operator's platform stats (operator stats spec D1), driven as both servers
 * drive the route modules: a Request in, a Response out, over a MemoryStore.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resolveIdentity } from "../src/auth.js";
import type { RoomCaller } from "../src/http/rooms.js";
import { MAX_GRANTS_COUNTED, statsRoutes, type StatsRouteDeps } from "../src/http/stats.js";
import { MemoryStore } from "../src/store.js";
import type { Identity, PlanGrant } from "../src/types.js";
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

/** A BELLMAN_USERS entry as parseOverrides hands it over: an identity, filed under an identity key. */
const identity = (over: Partial<Identity> = {}): Identity => ({
  userId: "u_github_1",
  orgId: null,
  plan: "pro",
  role: "member",
  label: "someone@github",
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

  // A browser hands the panel an answer, or a refusal, only if the response names its
  // origin. A row for each response the route gives besides the preflight, which has
  // its own test above; a new response gets a row.
  it.each([
    { status: 200, key: DEV_KEY.jesse }, // an operator
    { status: 401, key: null }, // no credential
    { status: 403, key: DEV_KEY.peer }, // signed in, not an operator
    { status: 405, key: DEV_KEY.jesse, method: "POST" }, // an operator, anything but GET
    { status: 500, key: DEV_KEY.jesse, storeFails: true }, // an operator, the store down
  ])("carries the panel's origin on a $status", async ({ status, key, method, storeFails }) => {
    if (storeFails) {
      // Assigned on the instance, for the reason the 500 test below gives.
      const failing = new MemoryStore();
      failing.countUsers = () => Promise.reject(new Error("registry unreachable"));
      deps = { ...deps, store: failing };
    }
    const res = await call(key, "/operator/stats", { method, origin: PANEL });
    expect(res!.status).toBe(status);
    expect(res!.headers.get("access-control-allow-origin")).toBe(PANEL);
  });

  it("counts nobody on an empty store", async () => {
    expect(await bodyOf(await call(DEV_KEY.jesse))).toEqual({
      accounts: 0, free: 0, paid: 0, paidCapped: false,
    });
  });

  it("counts accounts, and reads free as the ones no paid plan covers", async () => {
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

  // BELLMAN_USERS comps an account with no grant behind it, and free must not count it.
  it("counts an override with a paid plan as paid when no grant covers it", async () => {
    await store.recordSignIn("u_a", Date.now());
    await store.recordSignIn("u_b", Date.now());
    deps = { ...deps, overrides: { "github:1": identity({ plan: "team" }) } };

    expect(await bodyOf(await call(DEV_KEY.jesse))).toEqual({
      accounts: 2, free: 1, paid: 1, paidCapped: false,
    });
  });

  it("counts a key held by both an override and a grant once", async () => {
    await store.recordSignIn("u_a", Date.now());
    await store.recordSignIn("u_b", Date.now());
    await store.putGrant(grant({ key: "github:1", plan: "pro" }));
    deps = { ...deps, overrides: { "github:1": identity({ plan: "team" }) } };

    expect(await bodyOf(await call(DEV_KEY.jesse))).toEqual({
      accounts: 2, free: 1, paid: 1, paidCapped: false,
    });
  });

  // Sign-in resolves a key's override before its grant (decidePlan), whatever either says.
  it("lets a free override outrank a paid grant on the same key", async () => {
    await store.recordSignIn("u_a", Date.now());
    await store.putGrant(grant({ key: "github:1", plan: "pro" }));
    deps = { ...deps, overrides: { "github:1": identity({ plan: "free" }) } };

    expect(await bodyOf(await call(DEV_KEY.jesse))).toMatchObject({ accounts: 1, free: 1, paid: 0 });
  });

  // parseOverrides casts its JSON without checking it, so a value need not be an identity.
  it("neither fails on nor counts an override that is not an identity with a plan", async () => {
    await store.recordSignIn("u_a", Date.now());
    const malformed = { "github:1": null, "github:2": {}, "github:3": "pro" };
    deps = { ...deps, overrides: malformed as unknown as Record<string, Identity> };

    const res = await call(DEV_KEY.jesse);
    expect(res!.status).toBe(200);
    expect(await bodyOf(res)).toMatchObject({ accounts: 1, free: 1, paid: 0 });
  });

  // listGrants(limit, null) keeps only the grants with no org, and a team seat has one.
  it("counts a grant that belongs to an org", async () => {
    await store.putGrant(grant({ key: "github:1", plan: "team", orgId: "org_x" }));

    expect(await bodyOf(await call(DEV_KEY.jesse))).toMatchObject({ paid: 1 });
  });

  // Ruling R1: the flag is the scan's bound, not the paid count. A free grant in the
  // window keeps `paid` one under the limit on a scan that still reached it.
  it("says so when the grant scan reached its bound, though a free grant keeps paid under it", async () => {
    for (let i = 0; i < MAX_GRANTS_COUNTED - 1; i += 1) {
      await store.putGrant(grant({ key: `github:${i}` }));
    }
    await store.putGrant(grant({ key: "github:free", plan: "free" }));

    expect(await bodyOf(await call(DEV_KEY.jesse))).toMatchObject({
      paid: MAX_GRANTS_COUNTED - 1, paidCapped: true,
    });
  });

  // The flag is the grant scan's. An override set is a parsed secret, with no bound to reach.
  it("leaves paidCapped to the grant scan, however many overrides there are", async () => {
    const overrides: Record<string, Identity> = {};
    for (let i = 0; i < MAX_GRANTS_COUNTED; i += 1) overrides[`github:${i}`] = identity();
    deps = { ...deps, overrides };

    expect(await bodyOf(await call(DEV_KEY.jesse))).toMatchObject({
      paid: MAX_GRANTS_COUNTED, paidCapped: false,
    });
  });

  // Review focus 4.
  it("answers a bearer-token operator as it answers a cookie one", async () => {
    await store.recordSignIn("u_a", Date.now());
    const byBearer = await bodyOf(await call(DEV_KEY.jesse));
    const byCookie = await bodyOf(await call(null, "/operator/stats", { cookie: DEV_KEY.jesse }));
    // Two identical refusals would be equal too, so pin that the answer is the real one.
    expect(byBearer).toMatchObject({ accounts: 1 });
    expect(byCookie).toEqual(byBearer);
  });

  // Spec D6: the guard that fails if the response type is widened to carry a row.
  it("answers scalars only", async () => {
    await store.recordSignIn("u_a", Date.now());
    // A row for a leak to carry: spread into the body it puts strings there, where
    // an empty store would spread nothing. It carries an org because a leak that adds
    // the org id only when there is one fires on nothing else.
    await store.putGrant(grant({ orgId: "org_x" }));
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
