import { describe, it, expect, afterEach } from "vitest";
import { ENTITLEMENTS, entitlementsFor, resolveIdentity } from "../src/auth.js";
import type { Identity, Plan } from "../src/types.js";

const ORIGINAL_KEYS = process.env.BELLMAN_KEYS;

afterEach(() => {
  if (ORIGINAL_KEYS === undefined) delete process.env.BELLMAN_KEYS;
  else process.env.BELLMAN_KEYS = ORIGINAL_KEYS;
});

describe("resolveIdentity", () => {
  it("rejects a missing header", () => {
    expect(resolveIdentity(undefined)).toBeNull();
  });

  it("rejects an unknown key", () => {
    expect(resolveIdentity("Bearer qk_not_a_real_key")).toBeNull();
  });

  it("resolves each dev key to its identity", () => {
    expect(resolveIdentity("Bearer qk_dev_jesse")).toMatchObject({
      userId: "u_jesse", orgId: "org_codenerd", plan: "team", role: "admin",
    });
    expect(resolveIdentity("Bearer qk_dev_peer")).toMatchObject({
      userId: "u_peer", orgId: "org_codenerd", plan: "free", role: "member",
    });
    expect(resolveIdentity("Bearer qk_dev_outsider")).toMatchObject({
      userId: "u_outsider", orgId: null, plan: "free", role: "member",
    });
  });

  it("accepts the scheme in any case, with or without it, and trims whitespace", () => {
    for (const header of [
      "Bearer qk_dev_jesse",
      "bearer qk_dev_jesse",
      "BEARER qk_dev_jesse",
      "qk_dev_jesse",
      "Bearer   qk_dev_jesse   ",
    ]) {
      expect(resolveIdentity(header)?.userId, header).toBe("u_jesse");
    }
  });

  it("prefers BELLMAN_KEYS over the dev key table", () => {
    const injected: Identity = {
      userId: "u_prod", orgId: "org_real", plan: "pro", role: "member", label: "prod",
    };
    process.env.BELLMAN_KEYS = JSON.stringify({ qk_dev_jesse: injected });
    expect(resolveIdentity("Bearer qk_dev_jesse")).toMatchObject({ userId: "u_prod" });
  });

  it("falls back to dev keys when BELLMAN_KEYS misses or is malformed", () => {
    process.env.BELLMAN_KEYS = JSON.stringify({ qk_other: { userId: "u_other" } });
    expect(resolveIdentity("Bearer qk_dev_jesse")?.userId).toBe("u_jesse");

    process.env.BELLMAN_KEYS = "{ not json";
    expect(resolveIdentity("Bearer qk_dev_jesse")?.userId).toBe("u_jesse");
  });
});

describe("plan entitlements", () => {
  const plans: Plan[] = ["free", "pro", "team"];

  it("gates swarm mode to pro and team", () => {
    expect(ENTITLEMENTS.free.modes).toEqual(["pair"]);
    expect(ENTITLEMENTS.pro.modes).toContain("swarm");
    expect(ENTITLEMENTS.team.modes).toContain("swarm");
  });

  it("raises member ceilings, TTLs and quotas monotonically by plan", () => {
    expect(ENTITLEMENTS.free.maxMembers).toBeLessThan(ENTITLEMENTS.pro.maxMembers);
    expect(ENTITLEMENTS.pro.maxMembers).toBeLessThan(ENTITLEMENTS.team.maxMembers);
    expect(ENTITLEMENTS.free.sessionTtlMs).toBeLessThan(ENTITLEMENTS.pro.sessionTtlMs);
    expect(ENTITLEMENTS.pro.sessionTtlMs).toBeLessThan(ENTITLEMENTS.team.sessionTtlMs);
    expect(ENTITLEMENTS.free.monthlyCreates).toBeLessThan(ENTITLEMENTS.pro.monthlyCreates);
    expect(ENTITLEMENTS.pro.monthlyCreates).toBeLessThan(ENTITLEMENTS.team.monthlyCreates);
  });

  it("reserves org scoping and audit for the team plan", () => {
    expect(ENTITLEMENTS.free.orgScoping).toBe(false);
    expect(ENTITLEMENTS.pro.orgScoping).toBe(false);
    expect(ENTITLEMENTS.team.orgScoping).toBe(true);

    expect(ENTITLEMENTS.free.audit).toBe(false);
    expect(ENTITLEMENTS.pro.audit).toBe(false);
    expect(ENTITLEMENTS.team.audit).toBe(true);
  });

  /**
   * INVARIANT 1: entitlements gate session CREATION only. If a join-side field
   * ever appears here, joining has stopped being free and the viral loop is
   * broken — this test is the tripwire.
   */
  it("describes creation limits only — no join-side gating exists", () => {
    const creationOnlyFields = [
      "modes", "maxMembers", "sessionTtlMs", "monthlyCreates", "orgScoping", "audit",
    ].sort();

    for (const plan of plans) {
      expect(Object.keys(ENTITLEMENTS[plan]).sort()).toEqual(creationOnlyFields);
    }
  });

  it("entitlementsFor maps an identity to its plan's entitlements", () => {
    for (const plan of plans) {
      const identity: Identity = {
        userId: "u", orgId: null, plan, role: "member", label: "l",
      };
      expect(entitlementsFor(identity)).toBe(ENTITLEMENTS[plan]);
    }
  });
});
