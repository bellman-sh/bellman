import { describe, it, expect, vi } from "vitest";
import { MemoryStore, type GrantDelete, type GrantWrite } from "../src/store.js";
import { MemoryBillingStore } from "../src/billing/ledger.js";
import {
  PURCHASE, canPurchaseAs, grantKeyForUser, orgForUser, purchaseGrant, reconcilePurchase,
  type PurchaseGrantStore,
} from "../src/billing/grants.js";

/**
 * A store that records what billing asks of it and answers with a fixed outcome.
 *
 * The audit entry a request becomes is the store's rule, pinned in
 * grant-audit.test.ts and the store contract. What billing owns is the request:
 * which guarded write, guarded on which source, on whose behalf and with what to
 * say. Reading that back from an audit log would test the rule as well, and
 * would pass or fail on changes to it that billing has nothing to do with.
 */
function spyStore(answer: { put?: GrantWrite; del?: GrantDelete } = {}) {
  const calls: unknown[][] = [];
  const store: PurchaseGrantStore = {
    async putGrantIfSource(grant, expectedSource, audit) {
      calls.push(["put", grant.key, grant.plan, expectedSource, audit]);
      return answer.put ?? { outcome: "written" };
    },
    async deleteGrantIfSource(key, expectedSource, audit) {
      calls.push(["delete", key, expectedSource, audit]);
      return answer.del ?? { outcome: "deleted" };
    },
    async activatePurchasedOrg(orgId, ownerUserId, seats, audit) {
      calls.push(["activate", orgId, ownerUserId, seats, audit]);
      return "created";
    },
    async deactivateOrg(orgId, audit) {
      calls.push(["deactivate", orgId, audit]);
      return "updated";
    },
  };
  return { store, calls };
}

describe("the key a purchase is filed under", () => {
  /**
   * userId is defined as `u_<provider>_<subject>`, so the identity key can be
   * recovered from it. That is the whole reason billing can write grants at all.
   */
  it("recovers the identity key from a provider-derived user id", () => {
    expect(grantKeyForUser("u_github_4242")).toBe("github:4242");
    expect(grantKeyForUser("u_google_109876543210987654321"))
      .toBe("google:109876543210987654321");
  });

  /**
   * An operator grant may name any user id it likes. Those identify an account
   * but not an upstream human, so there is no key to file a purchase under —
   * and guessing one would attach somebody's payment to a stranger.
   */
  it("declines a user id that names no upstream human", () => {
    for (const id of ["u_jesse", "u_github_mcfearsome", "github:4242", "", "u_slack_1"]) {
      expect(grantKeyForUser(id), id).toBeNull();
    }
  });
});

describe("whether a purchase can be applied at all", () => {
  /**
   * The org grammar caps at 64 characters. `org_u_google_` is 13, so a subject
   * long enough to push past that produces a team grant the store refuses —
   * and the buyer pays and keeps the free plan, with nothing saying why.
   */
  it("refuses a user id whose org would be too long to store", () => {
    const fits = `u_google_${"1".repeat(51)}`;
    const overflows = `u_google_${"1".repeat(52)}`;

    expect(orgForUser(fits)).toHaveLength(64);
    expect(canPurchaseAs(fits)).toBe(true);
    expect(canPurchaseAs(overflows)).toBe(false);
  });

  /** Real subjects are nowhere near it — Google's are 21 digits. */
  it("accepts the ids providers actually hand out", () => {
    expect(canPurchaseAs("u_github_4242")).toBe(true);
    expect(canPurchaseAs("u_google_109876543210987654321")).toBe(true);
  });

  /**
   * A weaker question than isLinkableUserId, which only asks whether the id
   * can travel through Stripe. `u_jesse` can, and still has no key to file a
   * purchase against.
   */
  it("refuses an operator-named id that could still reach Stripe", () => {
    expect(canPurchaseAs("u_jesse")).toBe(false);
  });
});

describe("the grant a paid plan becomes", () => {
  it("gives a team buyer an org of their own and makes them its admin", () => {
    const grant = purchaseGrant("github:4242", "team", "u_github_4242");

    expect(grant).toMatchObject({
      plan: "team", role: "admin", orgId: "org_u_github_4242",
      source: PURCHASE, grantedBy: "stripe", expiresAt: null,
    });
  });

  it("leaves a pro buyer org-less", () => {
    expect(purchaseGrant("github:4242", "pro", "u_github_4242"))
      .toMatchObject({ plan: "pro", role: "member", orgId: null });
  });
});

describe("reconciling what Stripe says with what is stored", () => {
  const user = "u_github_4242";
  const sub = (plan: string, status = "active") => ({ plan: plan as "pro", status, eventAt: 1 });

  it("writes the grant when a subscription starts paying", async () => {
    const billing = new MemoryBillingStore();
    const plans = new MemoryStore();
    await billing.linkCustomer("cus_A", user);
    await billing.recordSubscription("cus_A", "sub_1", sub("pro"));

    expect(await reconcilePurchase(user, billing, plans)).toBe("written");
    expect(await plans.getGrant("github:4242")).toMatchObject({ plan: "pro", source: PURCHASE });
  });

  it("removes it when the subscription stops paying", async () => {
    const billing = new MemoryBillingStore();
    const plans = new MemoryStore();
    await billing.linkCustomer("cus_A", user);
    await billing.recordSubscription("cus_A", "sub_1", sub("pro"));
    await reconcilePurchase(user, billing, plans);

    await billing.recordSubscription("cus_A", "sub_1", { ...sub("pro", "canceled"), eventAt: 2 });

    expect(await reconcilePurchase(user, billing, plans)).toBe("deleted");
    expect(await plans.getGrant("github:4242")).toBeUndefined();
  });

  /**
   * A lapsing subscription is not a reason to revoke a plan somebody was
   * comped. Billing reports the clash and leaves the hand grant standing.
   */
  it("will not disturb a grant an operator wrote by hand", async () => {
    const billing = new MemoryBillingStore();
    const plans = new MemoryStore();
    await plans.putGrant({
      key: "github:4242", plan: "team", role: "admin", orgId: "org_comped",
      source: "operator", grantedAt: Date.now(), grantedBy: "u_admin", expiresAt: null,
    });
    await billing.linkCustomer("cus_A", user);
    await billing.recordSubscription("cus_A", "sub_1", sub("pro"));

    expect(await reconcilePurchase(user, billing, plans)).toBe("conflict");
    expect(await plans.getGrant("github:4242")).toMatchObject({ plan: "team", source: "operator" });
  });

  /**
   * A purchase is a plan change like any other, and the org stream says so: who
   * made it, and for a revocation, why. What else an entry holds is the store's
   * rule, pinned where the rule is.
   */
  it("writes the plan change to the org audit log", async () => {
    const billing = new MemoryBillingStore();
    const plans = new MemoryStore();
    await billing.linkCustomer("cus_A", user);
    await billing.recordSubscription("cus_A", "sub_1", { plan: "team", status: "active", eventAt: 1 });
    await reconcilePurchase(user, billing, plans);

    const granted = await plans.auditForOrg("org_u_github_4242", 10);
    expect(granted.map((e) => e.action)).toEqual(["org_created", "plan_granted"]);
    expect(granted[1]).toMatchObject({
      action: "plan_granted", actorUserId: "stripe",
      detail: { key: "github:4242", plan: "team", stripe_customer: "cus_A" },
    });

    await billing.recordSubscription("cus_A", "sub_1", { plan: "team", status: "canceled", eventAt: 2 });
    await reconcilePurchase(user, billing, plans);

    // The revocation, then the org going inactive: the org is marked after the grant goes (orgs spec, D4).
    const after = await plans.auditForOrg("org_u_github_4242", 10);
    expect(after.map((e) => [e.actorUserId, e.action]))
      .toEqual([["stripe", "org_created"], ["stripe", "plan_granted"], ["stripe", "plan_revoked"], ["stripe", "org_updated"]]);
    expect(after[2]).toMatchObject({ detail: { reason: "subscription no longer paying" } });
    expect(after[3]).toMatchObject({ detail: { active: false, reason: "subscription no longer paying" } });
  });

  /**
   * The store records the change, so billing's part is the request: who is
   * acting, and what the store cannot see for itself. A write names the customer
   * that paid. Compared whole, so a detail billing was never meant to send fails
   * it as surely as a missing one.
   */
  it("tells the store who is acting, and which customer paid, on a write", async () => {
    const billing = new MemoryBillingStore();
    await billing.linkCustomer("cus_A", user);
    await billing.recordSubscription("cus_A", "sub_1", sub("team"));
    const { store, calls } = spyStore();

    expect(await reconcilePurchase(user, billing, store)).toBe("written");

    // The org first, with the seats a state recorded before seats reads as (one), then the grant.
    expect(calls).toEqual([
      ["activate", "org_u_github_4242", "u_github_4242", 1,
        { actorUserId: "stripe", detail: { stripe_customer: "cus_A" } }],
      ["put", "github:4242", "team", PURCHASE,
        { actorUserId: "stripe", detail: { stripe_customer: "cus_A" } }],
    ]);
  });

  /** A revocation has no customer to name, and gives the reason instead. */
  it("tells the store who is acting, and why, on a revocation", async () => {
    const billing = new MemoryBillingStore();
    await billing.linkCustomer("cus_A", user);
    await billing.recordSubscription("cus_A", "sub_1", sub("pro", "canceled"));
    const { store, calls } = spyStore();

    expect(await reconcilePurchase(user, billing, store)).toBe("deleted");

    expect(calls).toEqual([
      ["delete", "github:4242", PURCHASE,
        { actorUserId: "stripe", detail: { reason: "subscription no longer paying" } }],
      ["deactivate", "org_u_github_4242",
        { actorUserId: "stripe", detail: { reason: "subscription no longer paying" } }],
    ]);
  });

  /**
   * Stripe delivers the same event twice, and delivers events for changes that
   * do not move the plan. An audit stream full of lines saying nothing happened
   * is one nobody reads.
   */
  it("does not audit a redelivered event that changes nothing", async () => {
    const billing = new MemoryBillingStore();
    const plans = new MemoryStore();
    await billing.linkCustomer("cus_A", user);
    await billing.recordSubscription("cus_A", "sub_1", { plan: "team", status: "active", eventAt: 1 });

    await reconcilePurchase(user, billing, plans);
    await reconcilePurchase(user, billing, plans);
    await reconcilePurchase(user, billing, plans);

    expect((await plans.auditForOrg("org_u_github_4242", 10)).map((e) => e.action)).toEqual(["org_created", "plan_granted"]);
  });

  /**
   * Losing team while keeping pro re-homes the grant rather than deleting it,
   * so the org being left is the only one that would otherwise hear nothing
   * about losing its admin.
   */
  it("tells the org a plan moved out of, not only the one it moved to", async () => {
    const billing = new MemoryBillingStore();
    const plans = new MemoryStore();
    await billing.linkCustomer("cus_A", user);
    await billing.recordSubscription("cus_A", "sub_team", { plan: "team", status: "active", eventAt: 1 });
    await billing.recordSubscription("cus_A", "sub_pro", { plan: "pro", status: "active", eventAt: 1 });
    await reconcilePurchase(user, billing, plans);

    // Team lapses; the pro subscription carries on, so the grant is re-homed
    // from org_u_github_4242 to no org at all rather than removed.
    await billing.recordSubscription("cus_A", "sub_team", { plan: "team", status: "canceled", eventAt: 2 });
    expect(await reconcilePurchase(user, billing, plans)).toBe("written");

    expect(await plans.getGrant("github:4242")).toMatchObject({ plan: "pro", orgId: null });
    // Nobody pays for the org's seats any more, so it goes inactive after the grant leaves it (orgs spec, D4).
    expect((await plans.auditForOrg("org_u_github_4242", 10)).map((e) => e.action))
      .toEqual(["org_created", "plan_granted", "plan_revoked", "org_updated"]);
    expect(await plans.getOrg("org_u_github_4242")).toMatchObject({ active: false });
  });

  it("activates the org with the seats it paid for before writing the grant", async () => {
    const billing = new MemoryBillingStore();
    await billing.linkCustomer("cus_A", user);
    await billing.recordSubscription("cus_A", "sub_1", { plan: "team", status: "active", eventAt: 1, seats: 4 });
    const { store, calls } = spyStore();

    expect(await reconcilePurchase(user, billing, store)).toBe("written");
    expect(calls).toEqual([
      ["activate", "org_u_github_4242", "u_github_4242", 4, { actorUserId: "stripe", detail: { stripe_customer: "cus_A" } }],
      ["put", "github:4242", "team", PURCHASE, { actorUserId: "stripe", detail: { stripe_customer: "cus_A" } }],
    ]);
  });

  it("deactivates the org after the grant goes, when nothing pays", async () => {
    const billing = new MemoryBillingStore();
    await billing.linkCustomer("cus_A", user);
    await billing.recordSubscription("cus_A", "sub_1", { plan: "team", status: "canceled", eventAt: 1 });
    const { store, calls } = spyStore();

    expect(await reconcilePurchase(user, billing, store)).toBe("deleted");
    expect(calls).toEqual([
      ["delete", "github:4242", PURCHASE, { actorUserId: "stripe", detail: { reason: "subscription no longer paying" } }],
      ["deactivate", "org_u_github_4242", { actorUserId: "stripe", detail: { reason: "subscription no longer paying" } }],
    ]);
  });

  it("deactivates the org for a plan that scopes none, and never activates one", async () => {
    const billing = new MemoryBillingStore();
    await billing.linkCustomer("cus_A", user);
    await billing.recordSubscription("cus_A", "sub_1", { plan: "pro", status: "active", eventAt: 1, seats: 2 });
    const { store, calls } = spyStore();

    expect(await reconcilePurchase(user, billing, store)).toBe("written");
    expect(calls.map((c) => c[0])).toEqual(["put", "deactivate"]);
  });

  it("leaves an org the operator created alone, and says so, when its owner's purchase lapses", async () => {
    const billing = new MemoryBillingStore();
    const plans = new MemoryStore();
    const org = {
      orgId: "org_u_github_4242", name: "Comped", ownerUserId: user, seats: 10, source: "operator" as const,
      active: true, createdAt: 1, requireSso: false, domains: [],
    };
    await plans.createOrg(org, { key: "github:4242", plan: "team", role: "admin", orgId: org.orgId, source: "operator", grantedAt: 1, grantedBy: "u_op", expiresAt: null }, { actorUserId: "u_op" });
    await billing.linkCustomer("cus_A", user);
    await billing.recordSubscription("cus_A", "sub_1", { plan: "team", status: "canceled", eventAt: 1 });
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});

    // The owner's grant is the operator's too, so billing leaves both and reports the clash.
    expect(await reconcilePurchase(user, billing, plans)).toBe("conflict");
    expect(await plans.getOrg(org.orgId)).toMatchObject({ seats: 10, active: true });
    expect(await plans.getGrant("github:4242")).toMatchObject({ source: "operator", plan: "team" });
    expect(logged.mock.calls.flat().join(" ")).toContain("org_u_github_4242");
    logged.mockRestore();
  });

  it("creates the record a team purchase pays for, with its seats and its owner", async () => {
    const billing = new MemoryBillingStore();
    const plans = new MemoryStore();
    await billing.linkCustomer("cus_A", user);
    await billing.recordSubscription("cus_A", "sub_1", { plan: "team", status: "active", eventAt: 1, seats: 4 });

    await reconcilePurchase(user, billing, plans);
    expect(await plans.getOrg("org_u_github_4242")).toMatchObject({
      name: "org_u_github_4242", ownerUserId: user, seats: 4, source: "purchase", active: true,
    });
    expect(await plans.countOrgMembers("org_u_github_4242")).toBe(1);
  });

  /**
   * An id can have nothing to file a purchase against in two ways: no upstream
   * key to file it under, or a key whose org would be too long for the store.
   * Both are turned away before the store is asked for anything, even for a user
   * who is paying, because the grant could not be applied after the money was
   * taken.
   */
  it("does nothing for a user id no purchase can be filed against", async () => {
    const overflows = `u_google_${"1".repeat(52)}`;
    for (const id of ["u_jesse", overflows]) {
      const billing = new MemoryBillingStore();
      await billing.linkCustomer("cus_A", id);
      await billing.recordSubscription("cus_A", "sub_1", sub("team"));
      const { store, calls } = spyStore();

      expect(await reconcilePurchase(id, billing, store), id).toBe("unkeyable");
      expect(calls, id).toEqual([]);
    }
  });

  it("says nothing was there when a user has never paid", async () => {
    expect(await reconcilePurchase(user, new MemoryBillingStore(), new MemoryStore()))
      .toBe("missing");
  });
});
