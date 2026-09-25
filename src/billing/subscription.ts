import { ENTITLEMENTS } from "../auth.js";
import type { Plan } from "../types.js";

/**
 * Reading a subscription from Stripe and working out which plan it sells.
 * Shared by the webhook and the ledger, and free of any Workers import.
 */

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isPaidPlan(value: unknown): value is Plan {
  return typeof value === "string" && value !== "free" && Object.hasOwn(ENTITLEMENTS, value);
}

export interface StripePrice {
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

/** Prices on a subscription's items, skipping anything that is not an item. */
export function pricesOf(items: unknown): (StripePrice | undefined)[] {
  const data = isRecord(items) ? items.data : undefined;
  if (!Array.isArray(data)) return [];
  return data.filter(isRecord).map((item) => (isRecord(item.price) ? (item.price as StripePrice) : undefined));
}

/**
 * How to reach Stripe: a restricted key that can read subscriptions and
 * nothing else. Plain data, so it can cross into the Durable Object by RPC.
 */
export interface SubscriptionSource {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export interface SubscriptionReading {
  /** null when no price on it names a plan this server knows. */
  plan: Plan | null;
  status: string;
}

/**
 * The subscription as Stripe has it now. A subscription Stripe no longer has
 * reads as cancelled. Anything else Stripe answers throws, so the webhook
 * replies 5xx and Stripe delivers the event again later.
 */
export async function readSubscription(id: string, source: SubscriptionSource): Promise<SubscriptionReading> {
  const get = source.fetchImpl ?? fetch;
  const res = await get(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${source.apiKey}` },
  });
  if (res.status === 404) return { plan: null, status: "canceled" };
  if (!res.ok) throw new Error(`Stripe answered ${res.status} reading subscription ${id}`);
  const body: unknown = await res.json();
  if (!isRecord(body)) throw new Error(`Stripe returned a non-object for subscription ${id}`);
  const prices = pricesOf(body.items);
  const plans = [...new Set(prices.map(planForPrice).filter((p): p is Plan => p !== null))];
  const status = typeof body.status === "string" ? body.status : "";

  if (prices.length > 0 && plans.length === 0) {
    console.warn(`subscription ${id} has no price naming a known plan`);
  }
  // Plans are mutually exclusive: a subscription sells exactly one, and the
  // catalogue is built so that no subscription can carry two. If one does,
  // the catalogue is wrong, and picking a winner would hide that — by item
  // order, which Stripe does not promise, so the same subscription could grant
  // pro one day and team the next. It grants nothing until somebody fixes it.
  //
  // Several items naming the *same* plan is fine; that is quantity, not
  // conflict, which is why this counts distinct plans rather than items.
  if (plans.length > 1) {
    console.error(
      `subscription ${id} sells more than one plan (${plans.join(", ")}) — plans are ` +
        `mutually exclusive, so this grants nothing. Fix the prices on it in Stripe.`
    );
    return { plan: null, status };
  }
  return { plan: plans[0] ?? null, status };
}
