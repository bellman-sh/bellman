import { isPaidPlan, type BillingStorage } from "./ledger.js";
import type { Plan } from "../types.js";

/**
 * POST /stripe/webhook — Stripe tells Bellman what someone has paid for.
 *
 * Nothing here trusts the body until its signature checks out against the
 * endpoint's signing secret: a webhook that cannot be verified changes
 * nothing. Verification is done by hand with Web Crypto rather than the
 * stripe package, because it is one HMAC and it keeps the Worker free of an
 * SDK it would otherwise only use for this.
 *
 * Handling is idempotent, so Stripe's retries and redeliveries are harmless:
 * a link is set-once, and a subscription update older than the one on record
 * is dropped (see BillingLedger).
 */

/** Stripe's own default: reject signatures more than five minutes old. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Largest body read. Stripe's events are a few kilobytes; this leaves room for
 * a subscription with many items while keeping an unauthenticated caller
 * from making the Worker buffer and hash an arbitrarily large body.
 */
export const MAX_WEBHOOK_BYTES = 256 * 1024;

/**
 * Read a body, giving up past `limit` bytes. Content-Length is checked first,
 * but a chunked body has none, so the stream is counted as it arrives.
 */
async function readLimited(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * A Bellman user id: u_github_4308278 as identityFor mints it, or whatever an
 * operator grant names, like u_jesse. Bounded by what Stripe allows in
 * client_reference_id: 200 characters of letters, digits, - and _.
 */
const USER_ID = /^u_[A-Za-z0-9_-]{1,198}$/;

const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Check a Stripe-Signature header: `t=<seconds>,v1=<hex>[,v1=<hex>…]`, where
 * each v1 is HMAC-SHA256 over `<t>.<raw body>`. Several v1 values appear while
 * a signing secret is being rolled; any one matching is enough.
 */
export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  tolerance = SIGNATURE_TOLERANCE_SECONDS
): Promise<boolean> {
  if (!header || !secret) return false;
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2).map((s) => s.trim());
    if (key === "t") timestamp = Number(value);
    else if (key === "v1" && value) signatures.push(value);
  }
  if (timestamp === undefined || !Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > tolerance) return false;
  const expected = await hmacHex(secret, `${timestamp}.${payload}`);
  return signatures.some((sig) => timingSafeEqual(sig, expected));
}

interface StripePrice {
  lookup_key?: string | null;
  metadata?: Record<string, string> | null;
}

/**
 * Which plan a price sells: `metadata.plan` when set, otherwise the lookup
 * key's prefix (`pro_monthly` → pro). A price naming no plan this server
 * knows grants nothing, rather than guessing.
 */
export function planForPrice(price: StripePrice | null | undefined): Plan | null {
  const lookup = typeof price?.lookup_key === "string" ? price.lookup_key.split("_")[0] : undefined;
  const named = price?.metadata?.plan ?? lookup;
  return isPaidPlan(named) ? named : null;
}

const idOf = (value: unknown): string | undefined =>
  typeof value === "string" ? value
    : value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string"
      ? (value as { id: string }).id
      : undefined;

interface StripeEvent {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The event envelope, checked rather than cast. A signed body is Stripe's, but
 * a shape this code did not expect must end in a clean 400, not a TypeError:
 * that would be a 500, which Stripe retries for days. `created` is required
 * because the ledger orders subscription updates by it.
 */
function parseEvent(payload: string): StripeEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.data) || !isRecord(parsed.data.object)) return null;
  const { id, type, created } = parsed;
  if (typeof id !== "string" || typeof type !== "string") return null;
  if (typeof created !== "number" || !Number.isFinite(created)) return null;
  return { id, type, created, data: { object: parsed.data.object } };
}

/** Prices on a subscription's items, skipping anything that is not an item. */
function pricesOf(items: unknown): (StripePrice | undefined)[] {
  const data = isRecord(items) ? items.data : undefined;
  if (!Array.isArray(data)) return [];
  return data.filter(isRecord).map((item) => (isRecord(item.price) ? (item.price as StripePrice) : undefined));
}

export interface StripeWebhookConfig {
  secret: string;
  billing: BillingStorage;
  now?: () => number;
}

const reply = (status: number, body: Record<string, unknown>) => Response.json(body, { status });

export async function handleStripeWebhook(request: Request, config: StripeWebhookConfig): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  }
  const payload = await readLimited(request, MAX_WEBHOOK_BYTES);
  if (payload === null) return reply(413, { error: "body too large" });
  const nowSeconds = Math.floor((config.now?.() ?? Date.now()) / 1000);
  if (!(await verifyStripeSignature(payload, request.headers.get("stripe-signature"), config.secret, nowSeconds))) {
    return reply(400, { error: "signature verification failed" });
  }

  const event = parseEvent(payload);
  if (!event) {
    console.error("stripe webhook: signed body is not an event this handler understands");
    return reply(400, { error: "not a Stripe event" });
  }
  const object = event.data.object;

  // Errors past this point are ours, so they surface as 5xx and Stripe retries.
  switch (event.type) {
    case "checkout.session.completed": {
      const userId = object.client_reference_id;
      const customerId = idOf(object.customer);
      if (typeof userId !== "string" || !USER_ID.test(userId) || !customerId) {
        // A checkout that did not come through /upgrade has no one to credit.
        console.warn(`stripe ${event.id}: checkout without a Bellman user id; nothing linked`);
        return reply(200, { received: true, applied: false });
      }
      const linked = await config.billing.linkCustomer(customerId, userId);
      if (!linked) console.warn(`stripe ${event.id}: customer ${customerId} already belongs to another user`);
      return reply(200, { received: true, applied: linked });
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscriptionId = idOf(object);
      const customerId = idOf(object.customer);
      if (!subscriptionId || !customerId) return reply(400, { error: "subscription without an id or customer" });
      const prices = pricesOf(object.items);
      const plans = prices.map(planForPrice).filter((p): p is Plan => p !== null);
      if (prices.length > 0 && plans.length === 0) {
        console.warn(`stripe ${event.id}: subscription ${subscriptionId} has no price naming a known plan`);
      }
      await config.billing.recordSubscription(customerId, subscriptionId, {
        plan: plans[0] ?? null,
        status: event.type === "customer.subscription.deleted" ? "canceled"
          : typeof object.status === "string" ? object.status : "",
        eventAt: event.created,
      });
      return reply(200, { received: true, applied: true });
    }

    default:
      // Subscribed to more than we act on is fine; acknowledge and move on.
      return reply(200, { received: true, applied: false });
  }
}

/**
 * STRIPE_PAYMENT_LINKS: JSON of link name → Payment Link URL. Only https links
 * on Stripe's own checkout hosts are kept, so a bad value cannot turn /upgrade
 * into an open redirect, and malformed JSON serves no links rather than guessing.
 */
export function parsePaymentLinks(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("STRIPE_PAYMENT_LINKS is set but is not valid JSON — ignoring it");
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const links: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== "string" || !/^[a-z0-9_]{1,64}$/.test(name)) continue;
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && (url.hostname === "buy.stripe.com" || url.hostname === "checkout.stripe.com")) {
        links[name] = value;
      }
    } catch {
      // not a URL; skipped
    }
  }
  return links;
}
