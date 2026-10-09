import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { ENTITLEMENTS, entitlementsFor, keyedPlan, resolveIdentity } from "../src/auth.js";
import type { Identity, Plan } from "../src/types.js";

const ORIGINAL_KEYS = process.env.BELLMAN_KEYS;

// Hermetic: dev-key cases assume BELLMAN_KEYS is unset, which is no longer
// merely the default but required. A developer with it exported in their
// shell would otherwise see confusing failures.
beforeEach(() => {
  delete process.env.BELLMAN_KEYS;
});

afterEach(() => {
  if (ORIGINAL_KEYS === undefined) delete process.env.BELLMAN_KEYS;
  else process.env.BELLMAN_KEYS = ORIGINAL_KEYS;
});

describe("resolveIdentity", () => {
  const OTHER: Identity = {
    userId: "u_other", orgId: null, plan: "free", role: "member", label: "other",
  };

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

  /**
   * The deploy gate. `qk_dev_jesse` is team plan + admin role and is published
   * in the README, so it must stop resolving the moment real keys exist.
   */
  it("takes dev keys out of play entirely once BELLMAN_KEYS is set", () => {
    process.env.BELLMAN_KEYS = JSON.stringify({ qk_other: OTHER });

    expect(resolveIdentity("Bearer qk_dev_jesse")).toBeNull();
    expect(resolveIdentity("Bearer qk_dev_peer")).toBeNull();
    expect(resolveIdentity("Bearer qk_dev_outsider")).toBeNull();
    expect(resolveIdentity("Bearer qk_other")?.userId).toBe("u_other");
  });

  it("fails closed when BELLMAN_KEYS is malformed", () => {
    process.env.BELLMAN_KEYS = "{ not json";

    expect(resolveIdentity("Bearer qk_dev_jesse")).toBeNull();
    expect(resolveIdentity("Bearer qk_other")).toBeNull();
  });

  /**
   * Both tables are plain objects, and a plain object answers for every name
   * on Object.prototype. A bearer of `constructor` once resolved to the Object
   * function: non-null, so it passed as an identity whose every field was
   * undefined, on the dev table and on a configured key map alike.
   */
  it("refuses a bearer that names an inherited property, on the dev table", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(resolveIdentity(`Bearer ${name}`), name).toBeNull();
    }
  });

  it("refuses a bearer that names an inherited property, on a configured key map", () => {
    process.env.BELLMAN_KEYS = JSON.stringify({ qk_other: OTHER });
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(resolveIdentity(`Bearer ${name}`), name).toBeNull();
    }
    expect(resolveIdentity("Bearer qk_other")?.userId).toBe("u_other");
  });

  /**
   * A key map is operator-written JSON. A value that is not an identity (a
   * string, a partial object, an unknown plan or role) must not become a
   * caller with undefined fields that every later check reads as unrestricted.
   */
  it("refuses a configured key whose value is not a whole identity", () => {
    const cases: Record<string, unknown> = {
      qk_string: "u_x",
      qk_partial: { userId: "u_x" },
      qk_plan: { ...OTHER, plan: "enterprise" },
      qk_role: { ...OTHER, role: "owner" },
      qk_null: null,
    };
    process.env.BELLMAN_KEYS = JSON.stringify({ ...cases, qk_other: OTHER });
    for (const key of Object.keys(cases)) {
      expect(resolveIdentity(`Bearer ${key}`), key).toBeNull();
    }
    expect(resolveIdentity("Bearer qk_other")?.userId).toBe("u_other");
  });
});

describe("plan entitlements", () => {
  const plans: Plan[] = ["free", "pro", "max", "team"];

  it("gates swarm mode to the paid plans", () => {
    expect(ENTITLEMENTS.free.modes).toEqual(["pair"]);
    expect(ENTITLEMENTS.pro.modes).toContain("swarm");
    expect(ENTITLEMENTS.max.modes).toContain("swarm");
    expect(ENTITLEMENTS.team.modes).toContain("swarm");
  });

  /** max sells creates between pro and team; nothing else steps. */
  it("raises quotas monotonically by plan", () => {
    expect(ENTITLEMENTS.free.monthlyCreates).toBeLessThan(ENTITLEMENTS.pro.monthlyCreates);
    expect(ENTITLEMENTS.pro.monthlyCreates).toBeLessThan(ENTITLEMENTS.max.monthlyCreates);
    expect(ENTITLEMENTS.max.monthlyCreates).toBeLessThan(ENTITLEMENTS.team.monthlyCreates);
    expect(ENTITLEMENTS.free.blobBytesPerRoom).toBe(50 * 1024 * 1024);
    expect(ENTITLEMENTS.pro.blobBytesPerRoom).toBe(500 * 1024 * 1024);
    expect(ENTITLEMENTS.max.blobBytesPerRoom).toBe(5 * 1024 * 1024 * 1024);
    expect(ENTITLEMENTS.team.blobBytesPerRoom).toBe(5 * 1024 * 1024 * 1024);
  });

  /** How long a closed room is kept (#65, D1): a week, a year, and until someone deletes it. */
  it("keeps a closed room for a window that grows by plan, and for ever on max and team", () => {
    expect(ENTITLEMENTS.free.retainAfterCloseMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(ENTITLEMENTS.pro.retainAfterCloseMs).toBe(365 * 24 * 60 * 60 * 1000);
    expect(ENTITLEMENTS.max.retainAfterCloseMs).toBeNull();
    expect(ENTITLEMENTS.team.retainAfterCloseMs).toBeNull();
  });

  /**
   * Max is coming soon (#45, #18). With no room lifetime and no member cap, it
   * differs from pro by creates, the blob ceiling, how long a closed room is kept
   * (#65) and the hosted seat (#188); landing another facet is a deliberate edit
   * to this line.
   */
  it("gives max creates, the blob ceiling, the retention window and the hosted seat over pro, and nothing else", () => {
    const {
      monthlyCreates: mc, blobBytesPerRoom: mb, retainAfterCloseMs: mk,
      hostedRooms: mh, hostUnitsPerRoom: mu, ...maxRest
    } = ENTITLEMENTS.max;
    const {
      monthlyCreates: pc, blobBytesPerRoom: pb, retainAfterCloseMs: pk,
      hostedRooms: ph, hostUnitsPerRoom: pu, ...proRest
    } = ENTITLEMENTS.pro;
    expect(maxRest).toEqual(proRest);
    expect([mc, pc]).toEqual([2000, 500]);
    expect([mb, pb]).toEqual([5 * 1024 * 1024 * 1024, 500 * 1024 * 1024]);
    expect(mk).toBeNull();
    expect(pk).toBe(365 * 24 * 60 * 60 * 1000);
    expect([mh, ph]).toEqual([3, 0]);
    expect([mu, pu]).toEqual([3000, 0]);
  });

  it("gives the hosted seat to max and team only", () => {
    expect(ENTITLEMENTS.free.hostedRooms).toBe(0);
    expect(ENTITLEMENTS.pro.hostedRooms).toBe(0);
    expect(ENTITLEMENTS.team.hostedRooms).toBe(5);
    expect(ENTITLEMENTS.team.hostUnitsPerRoom).toBe(3000);
  });

  /** The reason a company with several people creating rooms still buys team. */
  it("reserves org scoping and audit for the team plan", () => {
    expect(ENTITLEMENTS.free.orgScoping).toBe(false);
    expect(ENTITLEMENTS.pro.orgScoping).toBe(false);
    expect(ENTITLEMENTS.max.orgScoping).toBe(false);
    expect(ENTITLEMENTS.team.orgScoping).toBe(true);

    expect(ENTITLEMENTS.free.audit).toBe(false);
    expect(ENTITLEMENTS.pro.audit).toBe(false);
    expect(ENTITLEMENTS.max.audit).toBe(false);
    expect(ENTITLEMENTS.team.audit).toBe(true);
  });

  /** Billing ranks plans in this order (src/billing/ledger.ts), so the order is part of the contract. */
  it("declares plans cheapest first", () => {
    expect(Object.keys(ENTITLEMENTS)).toEqual(["free", "pro", "max", "team"]);
  });

  /**
   * INVARIANT 1: entitlements gate session CREATION only. A join-side field
   * appearing here would mean being invited into a room had started to depend
   * on what you pay — this test is the tripwire. `blobBytesPerRoom` (#183)
   * bounds what a room stores, and `retainAfterCloseMs` (#65) how long a closed
   * room is kept; `hostedRooms` and `hostUnitsPerRoom` (#188) bound how many
   * hosted rooms a person holds open and what each spends. None says who may join it.
   */
  it("describes creation limits only — no join-side gating exists", () => {
    const creationOnlyFields = [
      "modes", "monthlyCreates", "orgScoping", "audit", "blobBytesPerRoom", "retainAfterCloseMs",
      "hostedRooms", "hostUnitsPerRoom",
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

/**
 * A hosted room's creator is known by user id alone, and at each month turn its seat reads
 * the plan that creator holds then (I7). A key-table user's plan is the table's.
 */
describe("keyedPlan", () => {
  it("gives the plan a key table names a user with, the higher of two, and null for a user it does not name", () => {
    const table = JSON.stringify({
      qk_a1: { userId: "u_a", orgId: null, plan: "pro", role: "member", label: "a" },
      qk_a2: { userId: "u_a", orgId: null, plan: "max", role: "member", label: "a" },
      qk_b: { userId: "u_b", orgId: null, plan: "free", role: "member", label: "b" },
      qk_junk: "not an identity",
    });
    expect(keyedPlan("u_a", table)).toBe("max");
    expect(keyedPlan("u_b", table)).toBe("free");
    expect(keyedPlan("u_nobody", table)).toBeNull();
    expect(keyedPlan("u_a", "{not json")).toBeNull();
  });

  it("reads the table resolveIdentity reads when given none, and no table when given null", () => {
    expect(keyedPlan("u_jesse")).toBe("team");
    expect(keyedPlan("u_jesse", null)).toBeNull();
  });
});
