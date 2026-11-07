import { describe, expect, it } from "vitest";
import { planOf, signedInPlan } from "../src/oauth/routes.js";
import { MemoryStore } from "../src/storage/memory-store.js";
import { DEFAULT_POLICY, type Identity, type Org, type PlanGrant } from "../src/types.js";
import { ssoUserId } from "../src/oauth/providers.js";

const grant = (key: string, plan: PlanGrant["plan"], source = "operator", orgId: string | null = null): PlanGrant =>
  ({ key, plan, role: orgId ? "member" : "member", orgId, source, grantedAt: 0, grantedBy: "test", expiresAt: null });

const org = (orgId: string, over: Partial<Org> = {}): Org => ({
  orgId, name: orgId, ownerUserId: "u_github_1", seats: 3, source: "purchase", active: true, createdAt: 1,
  requireSso: false, domains: [], policy: DEFAULT_POLICY, ...over,
});

const KEYS = JSON.stringify({ qk_a: { userId: "u_jesse", orgId: null, plan: "team", role: "admin", label: "jesse" } });

describe("planOf", () => {
  it("takes the key table first, then an override, then a grant, then free", async () => {
    const plans = new MemoryStore();
    await plans.putGrant(grant("github:4242", "max"));
    const overrides: Record<string, Identity> = { "github:7": { userId: "u_x", orgId: null, plan: "pro", role: "member", label: "x" } };
    const deps = { plans, overrides, keys: KEYS };
    expect(await planOf("u_jesse", deps)).toEqual({ plan: "team", via: "keyed", grantSource: null, grantOrgId: null });
    expect(await planOf("u_github_7", deps)).toEqual({ plan: "pro", via: "override", grantSource: null, grantOrgId: null });
    expect(await planOf("u_github_4242", deps)).toEqual({ plan: "max", via: "grant", grantSource: "operator", grantOrgId: null });
    expect(await planOf("u_github_99", deps)).toEqual({ plan: "free", via: "default", grantSource: null, grantOrgId: null });
  });

  it("falls through the key table for a user it does not name, and never reads the dev keys", async () => {
    const plans = new MemoryStore();
    await plans.putGrant(grant("github:4242", "pro"));
    expect(await planOf("u_github_4242", { plans, keys: KEYS })).toMatchObject({ plan: "pro", via: "grant" });
    // With no key table, an id only the dev keys name resolves free: keyedPlan is never handed undefined.
    expect(await planOf("u_jesse", { plans, keys: undefined })).toMatchObject({ plan: "free", via: "default" });
  });

  it("applies the org's standing and honourPurchases unless raw", async () => {
    const plans = new MemoryStore();
    const by = { actorUserId: "u_op" };
    await plans.createOrg(org("org_gone", { active: false }), grant("github:1", "team", "purchase", "org_gone"), by);
    await plans.putGrant(grant("google:77", "max", "purchase"));

    expect(await planOf("u_github_1", { plans })).toMatchObject({ plan: "free", via: "grant" });
    expect(await planOf("u_google_77", { plans, honourPurchases: false })).toMatchObject({ plan: "free", via: "default" });

    expect(await planOf("u_github_1", { plans }, { raw: true }))
      .toEqual({ plan: "team", via: "grant", grantSource: "purchase", grantOrgId: "org_gone" });
    expect(await planOf("u_google_77", { plans, honourPurchases: false }, { raw: true }))
      .toEqual({ plan: "max", via: "grant", grantSource: "purchase", grantOrgId: null });
  });

  it("reads an SSO user through the key its id encodes", async () => {
    const plans = new MemoryStore();
    const by = { actorUserId: "u_op" };
    await plans.createOrg(org("org_acme", { source: "operator" }), grant("github:1", "team", "operator", "org_acme"), by);
    await plans.putGrantIfOwned(
      { key: "sso:org_acme:00u1abc", plan: "team", role: "member", orgId: "org_acme", source: "sso", grantedAt: 1, grantedBy: "sso", expiresAt: null },
      "org_acme", by,
    );
    expect(await planOf(ssoUserId("org_acme", "00u1abc"), { plans }))
      .toEqual({ plan: "team", via: "grant", grantSource: "sso", grantOrgId: "org_acme" });
  });

  it("leaves signedInPlan answering as before", async () => {
    const plans = new MemoryStore();
    await plans.putGrant(grant("github:4242", "max"));
    expect(await signedInPlan("u_github_4242", { plans })).toBe("max");
    expect(await signedInPlan("u_jesse", { plans })).toBeNull();
  });
});
