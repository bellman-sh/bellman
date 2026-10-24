/**
 * The Worker mounts the operator's stats over the real registry (operator stats spec D1). The route's rules are
 * pinned in tests/stats.test.ts; this is the wiring. The route requires its three config keys, so a mount cannot
 * forget one. The value is what the type cannot check. A wrong `operators` fails here in either direction: a mount
 * that refuses the listed user fails the 200 assertions, and one that admits the caller when it should not (another
 * id listed, no list, no OAuth) fails the 403 assertions. A wrong `overrides` or `honourPurchases` gives a wrong
 * `paid` and no error, so the count is read through each of them here, set the only way the Worker takes them: its env.
 */
import { afterEach, describe, expect, it } from "vitest";
import { env, reset, abortAllDurableObjects } from "cloudflare:test";
import worker from "../src/worker.js";
import { DurableObjectStore } from "../src/store-do.js";

const ORIGIN = "https://mcp.example.test";
// The key map's identity (vitest.config.ts) is u_jesse, the id BELLMAN_OPERATORS names below.
const KEY = "qk_ws_test";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
type WorkerEnv = Parameters<typeof worker.fetch>[1];
// The token secret, with the AUTH binding this env has, makes the Worker build its OAuth config.
// It reads the operators, the overrides and honourPurchases from there.
const envWith = (over: Record<string, string | undefined>) =>
  ({ ...env, BELLMAN_TOKEN_SECRET: "test-signing-secret", ...over }) as unknown as WorkerEnv;
const getStats = (on: WorkerEnv, path = "/operator/stats", init: RequestInit = { headers: { authorization: `Bearer ${KEY}` } }) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, init), on, ctx);

const STRIPE = { STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_API_KEY: "rk_test" };
// github:2 is comped to pro by BELLMAN_USERS, with no grant behind it.
const COMPED = JSON.stringify({
  "github:2": { userId: "u_github_2", orgId: null, plan: "pro", role: "member", label: "comped@example.dev" },
});

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

/** Three accounts. github:1 holds a purchase grant for pro, github:2 is comped by BELLMAN_USERS, github:3 has neither. */
async function seed() {
  const registry = new DurableObjectStore(env as never);
  for (const id of ["u_github_1", "u_github_2", "u_github_3"]) await registry.recordSignIn(id, Date.now());
  await registry.putGrant({
    key: "github:1", plan: "pro", role: "member", orgId: null,
    source: "purchase", grantedAt: Date.now(), grantedBy: "u_stripe", expiresAt: null,
  });
}

describe("the operator stats through the Worker", () => {
  // Sign-in resolves github:2 to pro by BELLMAN_USERS whatever applyPlans says, and github:1 to pro only
  // while applyPlans is true: BELLMAN_BILLING on with both Stripe secrets set.
  it.each([
    { billing: "on, with its Stripe secrets", vars: { BELLMAN_BILLING: "on", ...STRIPE }, paid: 2 },
    { billing: "shadow", vars: { BELLMAN_BILLING: "shadow", ...STRIPE }, paid: 1 },
    { billing: "off", vars: { BELLMAN_BILLING: "off" }, paid: 1 },
    { billing: "unset", vars: {}, paid: 1 },
    // billingSettings turns `on` back to off unless both Stripe secrets are set, and this row sets
    // neither. Sign-in honours no purchase then, and the count follows it.
    { billing: "on, without its Stripe secrets", vars: { BELLMAN_BILLING: "on" }, paid: 1 },
  ])("counts a purchase grant and a comped account as sign-in would, with billing $billing", async ({ vars, paid }) => {
    await seed();
    const res = await getStats(envWith({ BELLMAN_OPERATORS: "u_jesse", BELLMAN_USERS: COMPED, ...vars }));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ accounts: 3, free: 3 - paid, paid, paidCapped: false });
  });

  it("answers the user id BELLMAN_OPERATORS names, with or without the slash, and refuses everyone else", async () => {
    await seed();
    const operator = envWith({ BELLMAN_OPERATORS: "u_jesse" });
    expect((await getStats(operator)).status).toBe(200);
    expect((await getStats(operator, "/operator/stats/")).status).toBe(200);
    expect((await getStats(operator, "/operator/stats", {})).status).toBe(401);
    expect((await getStats(envWith({ BELLMAN_OPERATORS: "u_someone_else" }))).status).toBe(403);
    expect((await getStats(envWith({}))).status).toBe(403);
    // The list is read through the OAuth config, so a deploy with no OAuth has no operators, whatever the secret says.
    expect((await getStats(envWith({ BELLMAN_TOKEN_SECRET: undefined, BELLMAN_OPERATORS: "u_jesse" }))).status).toBe(403);
  });

  // The stats page's accounts pane, wired through the Worker to the registry: the Durable Objects list, not a stub.
  it("answers /operator/accounts on the same gate, listing the registry's sign-in records", async () => {
    await seed();
    // A created room's index row, under the same `us:` prefix as the records (#377): it is not an account.
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName("registry")) as unknown as { indexSession(u: string, s: string): Promise<void> };
    await registry.indexSession("u_github_1", "qs_by_one");
    const operator = envWith({ BELLMAN_OPERATORS: "u_jesse" });
    const res = await getStats(operator, "/operator/accounts");
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json() as { total: number; accounts: { user_id: string }[] };
    expect([body.total, body.accounts.length]).toEqual([3, 3]);
    expect((await getStats(operator, "/operator/accounts", {})).status).toBe(401);
    expect((await getStats(envWith({ BELLMAN_OPERATORS: "u_someone_else" }), "/operator/accounts")).status).toBe(403);
  });
});
