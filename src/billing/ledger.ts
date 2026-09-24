import { ENTITLEMENTS } from "../auth.js";
import type { Identity, Plan } from "../types.js";

/**
 * What Stripe says a person has paid for, kept free of any Workers import so
 * it runs under plain Node in tests. The Durable Object that serves production
 * wraps the same BillingLedger around its own storage (src/oauth/store.ts).
 *
 * Stripe is the system of record for subscriptions. This is a cache of the
 * part Bellman needs: which plan each Stripe customer's subscriptions grant,
 * and which Bellman user each customer belongs to.
 */

/** Subscription statuses that still grant the plan. past_due keeps it through Stripe's retries. */
const GRANTING = new Set(["active", "trialing", "past_due"]);
/** Statuses Stripe never moves a subscription out of. */
const TERMINAL = new Set(["canceled", "incomplete_expired"]);

/**
 * How far along its lifecycle a status is. Stripe's `created` has one-second
 * precision, so two events about one subscription can carry the same time;
 * between those, the later stage wins. That is what keeps a same-second
 * "created: incomplete" arriving after "updated: active" from erasing the
 * plan. A subscription does not step backwards within one second.
 */
const LIFECYCLE: Record<string, number> = {
  incomplete: 0,
  trialing: 1,
  active: 2,
  past_due: 3,
  paused: 4,
  unpaid: 4,
  canceled: 5,
  incomplete_expired: 5,
};
const stage = (status: string) => LIFECYCLE[status] ?? -1;

export interface SubscriptionState {
  /** null when the price names no plan this server knows. */
  plan: Plan | null;
  status: string;
  /** The Stripe event's `created`, in seconds. Older events never overwrite newer ones. */
  eventAt: number;
}

export interface CustomerRecord {
  userId?: string;
  subscriptions: Record<string, SubscriptionState>;
}

export interface PaidPlan {
  plan: Plan;
  customerId: string;
}

export interface BillingStorage {
  /**
   * Tie a Stripe customer to a Bellman user. The first link wins: a customer
   * already linked to someone else stays theirs, and false says so.
   */
  linkCustomer(customerId: string, userId: string): Promise<boolean>;
  recordSubscription(customerId: string, subscriptionId: string, state: SubscriptionState): Promise<void>;
  /** The best plan any of this user's customers is paying for, if any. */
  paidPlan(userId: string): Promise<PaidPlan | undefined>;
}

/** The storage a ledger needs: a key-value map with async access. */
export interface LedgerKV {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

const CUSTOMER = "billing:customer:";
const USER = "billing:user:";

/** Plan order is the order ENTITLEMENTS declares them in, cheapest first. */
const RANK = Object.keys(ENTITLEMENTS) as Plan[];

export function isPaidPlan(value: unknown): value is Plan {
  return typeof value === "string" && value !== "free" && Object.hasOwn(ENTITLEMENTS, value);
}

export class BillingLedger implements BillingStorage {
  constructor(private kv: LedgerKV) {}

  async linkCustomer(customerId: string, userId: string): Promise<boolean> {
    const record = (await this.kv.get<CustomerRecord>(`${CUSTOMER}${customerId}`)) ?? { subscriptions: {} };
    if (record.userId && record.userId !== userId) return false;
    if (!record.userId) {
      record.userId = userId;
      await this.kv.put(`${CUSTOMER}${customerId}`, record);
    }
    // Users collect customers rather than swapping one for another. Anyone can
    // pay with any user's id attached, so a link may only ever add a plan to
    // that user, never replace the one they are already paying for.
    const customers = (await this.kv.get<string[]>(`${USER}${userId}`)) ?? [];
    if (!customers.includes(customerId)) {
      await this.kv.put(`${USER}${userId}`, [...customers, customerId]);
    }
    return true;
  }

  async recordSubscription(customerId: string, subscriptionId: string, state: SubscriptionState): Promise<void> {
    const record = (await this.kv.get<CustomerRecord>(`${CUSTOMER}${customerId}`)) ?? { subscriptions: {} };
    const previous = record.subscriptions[subscriptionId];
    // Stripe does not promise delivery order. A cancelled subscription stays
    // cancelled, an older event never overwrites a newer one, and between
    // events from the same second the later lifecycle stage wins.
    if (previous && TERMINAL.has(previous.status)) return;
    if (previous && previous.eventAt > state.eventAt) return;
    if (previous && previous.eventAt === state.eventAt && stage(previous.status) > stage(state.status)) return;
    record.subscriptions[subscriptionId] = state;
    await this.kv.put(`${CUSTOMER}${customerId}`, record);
  }

  async paidPlan(userId: string): Promise<PaidPlan | undefined> {
    const customers = (await this.kv.get<string[]>(`${USER}${userId}`)) ?? [];
    let best: PaidPlan | undefined;
    for (const customerId of customers) {
      const record = await this.kv.get<CustomerRecord>(`${CUSTOMER}${customerId}`);
      if (record?.userId !== userId) continue;
      for (const sub of Object.values(record.subscriptions)) {
        if (!sub.plan || !GRANTING.has(sub.status)) continue;
        if (!best || RANK.indexOf(sub.plan) > RANK.indexOf(best.plan)) best = { plan: sub.plan, customerId };
      }
    }
    return best;
  }
}

/** In-memory implementation, for tests and the Node server. */
export class MemoryBillingStore extends BillingLedger {
  constructor() {
    const map = new Map<string, unknown>();
    super({
      get: async <T>(key: string) => structuredClone(map.get(key)) as T | undefined,
      put: async <T>(key: string, value: T) => {
        map.set(key, structuredClone(value));
      },
    });
  }
}

/**
 * The identity a signed-in human gets once billing has had its say. Only for
 * identities that did not come from an operator grant (BELLMAN_USERS), which
 * always win: comping or fixing an account is deliberate, and a webhook
 * cannot undo it.
 *
 * Team buyers get an org of their own and are its admin. The org is named for
 * the user, not for whichever Stripe customer happens to be paying: anyone
 * can pay with anyone's id attached, so which customer wins must not decide
 * which org someone is in. Adding other people to that org is not built yet.
 */
export function withPaidPlan(identity: Identity, paid: PaidPlan | undefined): Identity {
  const base: Identity = { ...identity, plan: "free", orgId: null, role: "member" };
  if (!paid) return base;
  if (ENTITLEMENTS[paid.plan].orgScoping) {
    return { ...base, plan: paid.plan, orgId: `org_${identity.userId}`, role: "admin" };
  }
  return { ...base, plan: paid.plan };
}
