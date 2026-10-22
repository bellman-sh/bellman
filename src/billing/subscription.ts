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
  return itemsOf(items).map((item) => item.price);
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
  /**
   * The seats it sells (orgs spec, D4): the sum of `quantity` over the items whose price names the
   * plan, an item with no whole positive quantity counting one. The team price's three-seat minimum
   * is Stripe's to enforce on the Payment Link; this reads what was bought.
   */
  seats: number;
}

/** What one subscription item is, as far as the plan and the seats go. */
interface StripeItem {
  price?: StripePrice;
  quantity?: unknown;
}

/** The items as `price` and `quantity`, skipping anything that is not an item. */
function itemsOf(items: unknown): StripeItem[] {
  const data = isRecord(items) ? items.data : undefined;
  if (!Array.isArray(data)) return [];
  return data.filter(isRecord).map((item) => ({
    price: isRecord(item.price) ? (item.price as StripePrice) : undefined,
    quantity: item.quantity,
  }));
}

/** An item's seats: its quantity when that is a whole positive number, else one. */
const seatsOf = (item: StripeItem): number =>
  typeof item.quantity === "number" && Number.isInteger(item.quantity) && item.quantity > 0 ? item.quantity : 1;

/**
 * The subscription as Stripe has it now. Anything but a success throws, so the
 * webhook replies 5xx and Stripe delivers the event again later.
 *
 * A 404 too. Stripe keeps a cancelled subscription readable, so the only way to
 * miss one is a key that cannot see it: a test-mode key reading a live
 * subscription, or another account's key. Read as "cancelled", that recorded
 * the first live purchase as over before anyone had a plan from it.
 */
export async function readSubscription(id: string, source: SubscriptionSource): Promise<SubscriptionReading> {
  const get = source.fetchImpl ?? fetch;
  const res = await get(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${source.apiKey}` },
  });
  if (!res.ok) {
    // Stripe's message names the cause, such as "a test mode key was used".
    const body: unknown = await res.json().catch(() => null);
    const said = isRecord(body) && isRecord(body.error) && typeof body.error.message === "string" ? `: ${body.error.message}` : "";
    throw new Error(`Stripe answered ${res.status} reading subscription ${id}${said}`);
  }
  const body: unknown = await res.json();
  if (!isRecord(body)) throw new Error(`Stripe returned a non-object for subscription ${id}`);
  const items = itemsOf(body.items);
  const prices = items.map((item) => item.price);
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
    return { plan: null, status, seats: 0 };
  }
  const plan = plans[0] ?? null;
  // Only the items that sell the plan count a seat: an add-on priced beside it seats nobody.
  const seats = plan === null ? 0 : items.filter((item) => planForPrice(item.price) === plan).reduce((sum, item) => sum + seatsOf(item), 0);
  return { plan, status, seats };
}
