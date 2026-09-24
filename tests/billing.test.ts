import { beforeEach, describe, expect, it } from "vitest";
import { MemoryBillingStore, withPaidPlan } from "../src/billing/ledger.js";
import {
  handleStripeWebhook, parsePaymentLinks, planForPrice, verifyStripeSignature,
} from "../src/billing/stripe.js";
import { billingMode, billingSettings } from "../src/billing/config.js";
import type { Identity } from "../src/types.js";

/**
 * The Stripe webhook, from signed bytes to the plan a user ends up with.
 * Signatures are computed here the way Stripe computes them, so nothing
 * touches the network.
 */

const SECRET = "whsec_test_secret";
const NOW = 1_790_000_000; // seconds

async function sign(payload: string, secret = SECRET, t = NOW): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`)));
  return `t=${t},v1=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

let billing: MemoryBillingStore;
let seq = 0;

beforeEach(() => {
  billing = new MemoryBillingStore();
});

async function deliver(type: string, object: Record<string, unknown>, created = NOW, header?: string) {
  const payload = JSON.stringify({ id: `evt_${++seq}`, type, created, data: { object } });
  const request = new Request("https://mcp.example.test/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": header ?? (await sign(payload)) },
    body: payload,
  });
  return handleStripeWebhook(request, { secret: SECRET, billing, now: () => NOW * 1000 });
}

const checkout = (customer: string, userId: string | null) =>
  deliver("checkout.session.completed", { object: "checkout.session", mode: "subscription", customer, client_reference_id: userId });

const subscription = (
  type: "created" | "updated" | "deleted",
  opts: { id?: string; customer?: string; status?: string; lookup?: string; created?: number } = {}
) =>
  deliver(
    `customer.subscription.${type}`,
    {
      id: opts.id ?? "sub_1",
      object: "subscription",
      customer: opts.customer ?? "cus_A",
      status: opts.status ?? "active",
      items: { data: [{ price: { lookup_key: opts.lookup ?? "pro_monthly", metadata: {} } }] },
    },
    opts.created ?? NOW
  );

describe("signature verification", () => {
  it("accepts what Stripe signed", async () => {
    expect(await verifyStripeSignature("{}", await sign("{}"), SECRET, NOW)).toBe(true);
  });

  it("refuses a changed body, the wrong secret, a stale timestamp, and no header", async () => {
    expect(await verifyStripeSignature('{"a":1}', await sign("{}"), SECRET, NOW)).toBe(false);
    expect(await verifyStripeSignature("{}", await sign("{}", "whsec_other"), SECRET, NOW)).toBe(false);
    expect(await verifyStripeSignature("{}", await sign("{}", SECRET, NOW - 301), SECRET, NOW)).toBe(false);
    expect(await verifyStripeSignature("{}", null, SECRET, NOW)).toBe(false);
    expect(await verifyStripeSignature("{}", "t=1", SECRET, NOW)).toBe(false);
  });

  it("accepts any one matching v1 while a secret is being rolled", async () => {
    const good = await sign("{}");
    const header = `${good.split(",")[0]},v1=${"0".repeat(64)},${good.split(",")[1]}`;
    expect(await verifyStripeSignature("{}", header, SECRET, NOW)).toBe(true);
  });

  it("changes nothing when the signature does not check out", async () => {
    await checkout("cus_A", "u_github_1");
    const res = await subscription("created");
    expect(res.status).toBe(200);

    const forged = await deliver("customer.subscription.deleted", { id: "sub_1", customer: "cus_A", status: "canceled" }, NOW + 5, "t=1,v1=bad");
    expect(forged.status).toBe(400);
    expect((await billing.paidPlan("u_github_1"))?.plan).toBe("pro");
  });

  it("only takes POST", async () => {
    const res = await handleStripeWebhook(new Request("https://x/stripe/webhook"), { secret: SECRET, billing });
    expect(res.status).toBe(405);
  });
});

describe("subscriptions to plans", () => {
  it("gives the paying user the plan once checkout names them", async () => {
    await checkout("cus_A", "u_github_1");
    await subscription("created");

    expect(await billing.paidPlan("u_github_1")).toEqual({ plan: "pro", customerId: "cus_A" });
  });

  it("does not care which of checkout and subscription arrives first", async () => {
    await subscription("created");
    expect(await billing.paidPlan("u_github_1")).toBeUndefined();

    await checkout("cus_A", "u_github_1");
    expect((await billing.paidPlan("u_github_1"))?.plan).toBe("pro");
  });

  it("takes the plan away when the subscription ends", async () => {
    await checkout("cus_A", "u_github_1");
    await subscription("created");
    await subscription("deleted", { status: "canceled", created: NOW + 60 });

    expect(await billing.paidPlan("u_github_1")).toBeUndefined();
  });

  it("keeps a cancelled subscription cancelled, whatever arrives late", async () => {
    await checkout("cus_A", "u_github_1");
    await subscription("deleted", { status: "canceled", created: NOW + 60 });
    await subscription("created", { created: NOW });
    await subscription("updated", { created: NOW + 120 });

    expect(await billing.paidPlan("u_github_1")).toBeUndefined();
  });

  it("drops an update older than the one on record", async () => {
    await checkout("cus_A", "u_github_1");
    await subscription("updated", { lookup: "team_seat_monthly", created: NOW + 60 });
    await subscription("updated", { lookup: "pro_monthly", created: NOW + 30 });

    expect((await billing.paidPlan("u_github_1"))?.plan).toBe("team");
  });

  it("keeps the plan through past_due retries and drops it at unpaid", async () => {
    await checkout("cus_A", "u_github_1");
    await subscription("updated", { status: "past_due" });
    expect((await billing.paidPlan("u_github_1"))?.plan).toBe("pro");

    await subscription("updated", { status: "unpaid", created: NOW + 60 });
    expect(await billing.paidPlan("u_github_1")).toBeUndefined();
  });

  it("grants nothing for a price that names no plan it knows", async () => {
    await checkout("cus_A", "u_github_1");
    await subscription("created", { lookup: "enterprise_custom" });

    expect(await billing.paidPlan("u_github_1")).toBeUndefined();
  });

  it("takes the best plan across a user's subscriptions", async () => {
    await checkout("cus_A", "u_github_1");
    await subscription("created", { id: "sub_1", lookup: "pro_monthly" });
    await subscription("created", { id: "sub_2", lookup: "team_seat_annual" });

    expect((await billing.paidPlan("u_github_1"))?.plan).toBe("team");
  });

  it("links a user id an operator grant named, not only the ones sign-in mints", async () => {
    await checkout("cus_A", "u_jesse");
    await subscription("created");

    expect((await billing.paidPlan("u_jesse"))?.plan).toBe("pro");
  });

  it("links nothing for a checkout without a Bellman user id", async () => {
    const none = await checkout("cus_A", null);
    const junk = await checkout("cus_B", "not a user id");

    expect(((await none.json()) as { applied: boolean }).applied).toBe(false);
    expect(((await junk.json()) as { applied: boolean }).applied).toBe(false);
  });
});

describe("someone else's user id on a checkout", () => {
  it("cannot move a customer that already belongs to another user", async () => {
    await checkout("cus_A", "u_github_1");
    await subscription("created");
    await checkout("cus_A", "u_github_2");

    expect((await billing.paidPlan("u_github_1"))?.plan).toBe("pro");
    expect(await billing.paidPlan("u_github_2")).toBeUndefined();
  });

  it("can only add a plan, never take away the one the victim pays for", async () => {
    await checkout("cus_A", "u_github_1");
    await subscription("created", { customer: "cus_A", id: "sub_1" });

    // The attacker pays with the victim's id, then cancels.
    await checkout("cus_EVIL", "u_github_1");
    await subscription("created", { customer: "cus_EVIL", id: "sub_evil" });
    await subscription("deleted", { customer: "cus_EVIL", id: "sub_evil", status: "canceled", created: NOW + 60 });

    expect(await billing.paidPlan("u_github_1")).toEqual({ plan: "pro", customerId: "cus_A" });
  });
});

describe("plans on an identity", () => {
  const signedIn: Identity = { userId: "u_github_1", orgId: null, plan: "free", role: "member", label: "a@github" };

  it("is free with nothing paid", () => {
    expect(withPaidPlan(signedIn, undefined)).toEqual(signedIn);
  });

  it("drops a stale paid plan back to free", () => {
    expect(withPaidPlan({ ...signedIn, plan: "pro" }, undefined).plan).toBe("free");
  });

  it("gives a team buyer an org of their own, as its admin", () => {
    expect(withPaidPlan(signedIn, { plan: "team", customerId: "cus_A" })).toEqual({
      ...signedIn, plan: "team", orgId: "org_cus_A", role: "admin",
    });
  });

  it("gives pro without an org", () => {
    expect(withPaidPlan(signedIn, { plan: "pro", customerId: "cus_A" })).toEqual({ ...signedIn, plan: "pro" });
  });
});

describe("prices", () => {
  it("reads the plan from metadata first, then the lookup key prefix", () => {
    expect(planForPrice({ lookup_key: "pro_monthly", metadata: { plan: "team" } })).toBe("team");
    expect(planForPrice({ lookup_key: "team_seat_annual" })).toBe("team");
  });

  it("never sells free, and ignores what it does not know", () => {
    expect(planForPrice({ lookup_key: "free_forever" })).toBeNull();
    expect(planForPrice({ metadata: { plan: "platinum" } })).toBeNull();
    expect(planForPrice(undefined)).toBeNull();
  });
});

describe("payment links", () => {
  it("keeps only Stripe-hosted https links", () => {
    expect(
      parsePaymentLinks(JSON.stringify({
        pro_monthly: "https://buy.stripe.com/abc",
        evil: "https://evil.example/buy",
        plain: "http://buy.stripe.com/abc",
        "Bad Name": "https://buy.stripe.com/x",
      }))
    ).toEqual({ pro_monthly: "https://buy.stripe.com/abc" });
  });

  it("serves no links from malformed JSON", () => {
    expect(parsePaymentLinks("{nope")).toEqual({});
    expect(parsePaymentLinks(undefined)).toEqual({});
  });
});

describe("the BELLMAN_BILLING switch", () => {
  const secrets = {
    STRIPE_WEBHOOK_SECRET: "whsec_x",
    STRIPE_PAYMENT_LINKS: JSON.stringify({ pro_monthly: "https://buy.stripe.com/abc" }),
  };

  it("is off unless set, and off for anything it does not recognise", () => {
    expect(billingMode(undefined)).toBe("off");
    expect(billingMode("")).toBe("off");
    expect(billingMode("true")).toBe("off");
    expect(billingMode("yes please")).toBe("off");
    expect(billingMode(" On ")).toBe("on");
  });

  it("does nothing when off, even with every secret set", () => {
    expect(billingSettings({ ...secrets })).toEqual({ mode: "off", applyPlans: false, paymentLinks: {} });
    expect(billingSettings({ ...secrets, BELLMAN_BILLING: "off" }).webhookSecret).toBeUndefined();
  });

  it("records and sells in shadow, but leaves tokens alone", () => {
    const shadow = billingSettings({ ...secrets, BELLMAN_BILLING: "shadow" });
    expect(shadow).toMatchObject({ mode: "shadow", webhookSecret: "whsec_x", applyPlans: false });
    expect(shadow.paymentLinks).toEqual({ pro_monthly: "https://buy.stripe.com/abc" });
  });

  it("applies plans when on", () => {
    expect(billingSettings({ ...secrets, BELLMAN_BILLING: "on" })).toMatchObject({ mode: "on", applyPlans: true });
  });

  it("stays off when switched on without a webhook secret", () => {
    const half = billingSettings({ BELLMAN_BILLING: "on", STRIPE_PAYMENT_LINKS: secrets.STRIPE_PAYMENT_LINKS });
    expect(half).toEqual({ mode: "off", applyPlans: false, paymentLinks: {} });
  });
});
