import { beforeEach, describe, expect, it } from "vitest";
import { MemoryBillingStore, withPaidPlan } from "../src/billing/ledger.js";
import {
  MAX_WEBHOOK_BYTES, handleStripeWebhook, parsePaymentLinks, planForPrice, verifyStripeSignature,
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

/** What Stripe's API answers for each subscription right now. */
let stripeNow: Map<string, Record<string, unknown>>;
let stripeDown: boolean;
let stripeReads: { url: string; auth: string | null }[];
let clock: number;

const fakeStripe = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  stripeReads.push({ url, auth: new Headers(init?.headers).get("authorization") });
  if (stripeDown) return new Response("unavailable", { status: 500 });
  const id = decodeURIComponent(url.replace("https://api.stripe.com/v1/subscriptions/", ""));
  const sub = stripeNow.get(id);
  return sub ? Response.json(sub) : Response.json({ error: { code: "resource_missing" } }, { status: 404 });
}) as typeof fetch;

/** Each read happens a millisecond after the last, near NOW so signatures stay fresh. */
const webhookConfig = () => ({
  secret: SECRET, billing, apiKey: "rk_test", fetchImpl: fakeStripe, now: () => ++clock,
});

beforeEach(() => {
  billing = new MemoryBillingStore();
  stripeNow = new Map();
  stripeDown = false;
  stripeReads = [];
  clock = NOW * 1000;
});

async function deliver(type: string, object: Record<string, unknown>, created = NOW, header?: string) {
  const payload = JSON.stringify({ id: `evt_${++seq}`, type, created, data: { object } });
  const request = new Request("https://mcp.example.test/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": header ?? (await sign(payload)) },
    body: payload,
  });
  return handleStripeWebhook(request, webhookConfig());
}

const checkout = (customer: string, userId: string | null) =>
  deliver("checkout.session.completed", { object: "checkout.session", mode: "subscription", customer, client_reference_id: userId });

/**
 * A subscription event. By default Stripe's current state becomes what the
 * event describes, as it would when the change happens. `stale` delivers the
 * event without touching Stripe's state: a late or duplicate delivery.
 */
const subscription = (
  type: "created" | "updated" | "deleted",
  opts: { id?: string; customer?: string; status?: string; lookup?: string; created?: number; stale?: boolean } = {}
) => {
  const snapshot = {
    id: opts.id ?? "sub_1",
    object: "subscription",
    customer: opts.customer ?? "cus_A",
    status: opts.status ?? (type === "deleted" ? "canceled" : "active"),
    items: { data: [{ price: { lookup_key: opts.lookup ?? "pro_monthly", metadata: {} } }] },
  };
  if (!opts.stale) stripeNow.set(snapshot.id, snapshot);
  return deliver(`customer.subscription.${type}`, snapshot, opts.created ?? NOW);
};

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
    const res = await handleStripeWebhook(new Request("https://x/stripe/webhook"), webhookConfig());
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
    await subscription("created", { created: NOW, stale: true });
    await subscription("updated", { created: NOW + 120, stale: true });

    expect(await billing.paidPlan("u_github_1")).toBeUndefined();
  });

  it("records what Stripe says now, not what a late event says", async () => {
    await checkout("cus_A", "u_github_1");
    await subscription("updated", { lookup: "team_seat_monthly", created: NOW + 60 });
    await subscription("updated", { lookup: "pro_monthly", created: NOW + 30, stale: true });

    expect((await billing.paidPlan("u_github_1"))?.plan).toBe("team");
  });

  it("keeps the plan through past_due retries and drops it at unpaid", async () => {
    await checkout("cus_A", "u_github_1");
    await subscription("updated", { status: "past_due", created: NOW + 30 });
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
      ...signedIn, plan: "team", orgId: "org_u_github_1", role: "admin",
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
    STRIPE_API_KEY: "rk_x",
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

  it("stays off when switched on without the API key it reads subscriptions with", () => {
    const { STRIPE_API_KEY: _, ...noKey } = secrets;
    expect(billingSettings({ ...noKey, BELLMAN_BILLING: "on" })).toEqual({ mode: "off", applyPlans: false, paymentLinks: {} });
  });

  it("stays off when switched on without a webhook secret", () => {
    const half = billingSettings({ BELLMAN_BILLING: "on", STRIPE_PAYMENT_LINKS: secrets.STRIPE_PAYMENT_LINKS });
    expect(half).toEqual({ mode: "off", applyPlans: false, paymentLinks: {} });
  });
});

describe("signed bodies of an unexpected shape", () => {
  async function deliverRaw(payload: string) {
    const request = new Request("https://mcp.example.test/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": await sign(payload) },
      body: payload,
    });
    return handleStripeWebhook(request, webhookConfig());
  }

  it("answers 400, not a crash, for anything that is not an event", async () => {
    for (const payload of ["null", '"text"', "[]", "{}", "not json"]) {
      expect((await deliverRaw(payload)).status, payload).toBe(400);
    }
  });

  it("answers 400 for an event with no data object or no created time", async () => {
    const base = { id: "evt_x", type: "customer.subscription.created", created: NOW, data: { object: { id: "sub_1", customer: "cus_A" } } };
    expect((await deliverRaw(JSON.stringify({ ...base, data: null }))).status).toBe(400);
    expect((await deliverRaw(JSON.stringify({ ...base, data: { object: "sub_1" } }))).status).toBe(400);
    expect((await deliverRaw(JSON.stringify({ ...base, created: undefined }))).status).toBe(400);
    expect((await deliverRaw(JSON.stringify({ ...base, created: "yesterday" }))).status).toBe(400);
  });

  it("skips items that are not items and keys that are not strings", async () => {
    await checkout("cus_A", "u_github_1");
    const junk = {
      id: "sub_1",
      customer: "cus_A",
      status: "active",
      items: { data: [null, "junk", { price: { lookup_key: 42 } }, { price: { lookup_key: "pro_monthly" } }] },
    };
    stripeNow.set("sub_1", junk);
    const res = await deliver("customer.subscription.created", junk);

    expect(res.status).toBe(200);
    expect((await billing.paidPlan("u_github_1"))?.plan).toBe("pro");
  });

  it("records no plan, without crashing, when items is not a list", async () => {
    await checkout("cus_A", "u_github_1");
    const odd = { id: "sub_1", customer: "cus_A", status: "active", items: { data: "nope" } };
    stripeNow.set("sub_1", odd);
    const res = await deliver("customer.subscription.created", odd);

    expect(res.status).toBe(200);
    expect(await billing.paidPlan("u_github_1")).toBeUndefined();
  });
});

describe("events Stripe delivers out of order", () => {
  it("keeps an upgrade when the older same-second event arrives after it", async () => {
    await checkout("cus_A", "u_github_1");
    // pro → team within one second; Stripe delivers the team event first.
    stripeNow.set("sub_1", { id: "sub_1", customer: "cus_A", status: "active", items: { data: [{ price: { lookup_key: "team_seat_monthly" } }] } });
    await subscription("updated", { lookup: "team_seat_monthly", created: NOW, stale: true });
    await subscription("created", { lookup: "pro_monthly", created: NOW, stale: true });

    expect((await billing.paidPlan("u_github_1"))?.plan).toBe("team");
  });

  it("keeps a resumed subscription resumed when the pause arrives late", async () => {
    await checkout("cus_A", "u_github_1");
    await subscription("updated", { status: "paused" });
    expect(await billing.paidPlan("u_github_1")).toBeUndefined();

    await subscription("updated", { status: "active" });
    await subscription("updated", { status: "paused", stale: true });
    expect((await billing.paidPlan("u_github_1"))?.plan).toBe("pro");
  });

  it("keeps active when a same-second created: incomplete arrives after it", async () => {
    await checkout("cus_A", "u_github_1");
    await subscription("updated", { status: "active", created: NOW });
    await subscription("created", { status: "incomplete", created: NOW, stale: true });

    expect((await billing.paidPlan("u_github_1"))?.plan).toBe("pro");
  });

  it("treats a subscription Stripe no longer has as over", async () => {
    await checkout("cus_A", "u_github_1");
    await subscription("created");
    stripeNow.delete("sub_1");
    await subscription("updated", { stale: true });

    expect(await billing.paidPlan("u_github_1")).toBeUndefined();
  });

  it("answers 502 and records nothing when Stripe cannot be read, so Stripe retries", async () => {
    await checkout("cus_A", "u_github_1");
    stripeDown = true;
    const res = await subscription("created");

    expect(res.status).toBe(502);
    expect(await billing.paidPlan("u_github_1")).toBeUndefined();
  });

  it("reads the subscription the event names, with the restricted key", async () => {
    await subscription("created", { id: "sub_9" });

    expect(stripeReads).toEqual([{ url: "https://api.stripe.com/v1/subscriptions/sub_9", auth: "Bearer rk_test" }]);
  });
});

describe("which org a team buyer is in", () => {
  it("does not depend on which customer paid first, or leave when a stranger cancels", async () => {
    // A stranger pays for team with the victim's id before the victim does.
    await checkout("cus_EVIL", "u_github_1");
    await subscription("created", { customer: "cus_EVIL", id: "sub_evil", lookup: "team_seat_monthly" });
    await checkout("cus_A", "u_github_1");
    await subscription("created", { customer: "cus_A", id: "sub_1", lookup: "team_seat_monthly" });
    const signedIn: Identity = { userId: "u_github_1", orgId: null, plan: "free", role: "member", label: "v" };

    const before = withPaidPlan(signedIn, await billing.paidPlan("u_github_1"));
    await subscription("deleted", { customer: "cus_EVIL", id: "sub_evil", status: "canceled", created: NOW + 60 });
    const after = withPaidPlan(signedIn, await billing.paidPlan("u_github_1"));

    expect(before.orgId).toBe("org_u_github_1");
    expect(after).toEqual(before);
  });
});

describe("body size", () => {
  const post = (init: RequestInit & { duplex?: string }) =>
    handleStripeWebhook(new Request("https://mcp.example.test/stripe/webhook", { method: "POST", ...init } as RequestInit), webhookConfig());

  it("refuses a body declared larger than the limit before reading it", async () => {
    const res = await post({ headers: { "content-length": String(MAX_WEBHOOK_BYTES + 1) }, body: "{}" });
    expect(res.status).toBe(413);
  });

  it("refuses a chunked body once it passes the limit", async () => {
    const chunk = new Uint8Array(64 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 10) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const res = await post({ body: stream, duplex: "half" });

    expect(res.status).toBe(413);
    expect(sent).toBeLessThan(10); // stopped reading early
  });
});
