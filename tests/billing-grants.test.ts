import { describe, it, expect } from "vitest";
import { MemoryStore } from "../src/store.js";
import { MemoryBillingStore } from "../src/billing/ledger.js";
import {
  PURCHASE, canPurchaseAs, grantKeyForUser, orgForUser, purchaseGrant, reconcilePurchase,
} from "../src/billing/grants.js";

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

  /** A purchase is a plan change like any other, and the org stream says so. */
  it("writes the plan change to the org audit log", async () => {
    const billing = new MemoryBillingStore();
    const plans = new MemoryStore();
    await billing.linkCustomer("cus_A", user);
    await billing.recordSubscription("cus_A", "sub_1", { plan: "team", status: "active", eventAt: 1 });
    await reconcilePurchase(user, billing, plans);

    const granted = await plans.auditForOrg("org_u_github_4242", 10);
    expect(granted).toHaveLength(1);
    expect(granted[0]).toMatchObject({
      action: "plan_granted", actorUserId: "stripe",
      detail: { key: "github:4242", plan: "team", stripe_customer: "cus_A" },
    });

    await billing.recordSubscription("cus_A", "sub_1", { plan: "team", status: "canceled", eventAt: 2 });
    await reconcilePurchase(user, billing, plans);

    const after = await plans.auditForOrg("org_u_github_4242", 10);
    expect(after.map((e) => e.action)).toEqual(["plan_granted", "plan_revoked"]);
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

    expect(await plans.auditForOrg("org_u_github_4242", 10)).toHaveLength(1);
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
    expect((await plans.auditForOrg("org_u_github_4242", 10)).map((e) => e.action))
      .toEqual(["plan_granted", "plan_revoked"]);
  });

  /** A pro purchase has no org, so there is no org stream to write to. */
  it("does not invent an org to audit a plan that has none", async () => {
    const billing = new MemoryBillingStore();
    const plans = new MemoryStore();
    await billing.linkCustomer("cus_A", user);
    await billing.recordSubscription("cus_A", "sub_1", { plan: "pro", status: "active", eventAt: 1 });

    expect(await reconcilePurchase(user, billing, plans)).toBe("written");
    expect(await plans.auditForOrg("org_u_github_4242", 10)).toEqual([]);
  });

  it("does nothing for a user id no purchase can be filed against", async () => {
    expect(await reconcilePurchase("u_jesse", new MemoryBillingStore(), new MemoryStore()))
      .toBe("unkeyable");
  });

  it("says nothing was there when a user has never paid", async () => {
    expect(await reconcilePurchase(user, new MemoryBillingStore(), new MemoryStore()))
      .toBe("missing");
  });
});
