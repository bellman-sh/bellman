import { ENTITLEMENTS } from "../auth.js";
import type { Identity, Plan } from "../types.js";
import { readSubscription, type SubscriptionSource } from "./subscription.js";

export { isPaidPlan } from "./subscription.js";

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


export interface SubscriptionState {
  /** null when the price names no plan this server knows. */
  plan: Plan | null;
  status: string;
  /**
   * Orders writes to one subscription: a lower value never overwrites a
   * higher one. syncSubscription makes it strictly increasing per
   * subscription, because it reads and writes one subscription at a time.
   */
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
  /**
   * Read the subscription from Stripe and record it. Calls for the same
   * subscription run one after another, read and write together, so a slow
   * read can never land after, and overwrite, a newer one.
   */
  syncSubscription(customerId: string, subscriptionId: string, source: SubscriptionSource): Promise<void>;
  /** The best plan any of this user's customers is paying for, if any. */
  paidPlan(userId: string): Promise<PaidPlan | undefined>;
  /**
   * Which Bellman user a Stripe customer belongs to, if it is linked.
   *
   * A subscription event names a customer, and the grant that has to be
   * rewritten is the user's. Events also arrive out of order, so a
   * subscription may turn up before the checkout that links its customer —
   * hence "if": nothing to reconcile yet, and the link will do it.
   */
  userForCustomer(customerId: string): Promise<string | undefined>;
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

export class BillingLedger implements BillingStorage {
  /**
   * One queue per record. Every change to a customer record runs in that
   * customer's queue and every change to a user's customer list in that
   * user's, so no two read-modify-writes of one record overlap. When both are
   * needed, the customer's is taken first, always, so queues cannot deadlock.
   *
   * This only serializes anything because there is exactly one ledger: one
   * Durable Object in production, one process in tests. It is memory, not
   * storage, and needs to be: when the object is evicted, nothing is queued.
   */
  private queues = new Map<string, Promise<unknown>>();

  constructor(private kv: LedgerKV) {}

  private serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const before = this.queues.get(key) ?? Promise.resolve();
    const run = before.catch(() => undefined).then(work);
    this.queues.set(key, run);
    const settle = () => {
      if (this.queues.get(key) === run) this.queues.delete(key);
    };
    run.then(settle, settle);
    return run;
  }

  syncSubscription(customerId: string, subscriptionId: string, source: SubscriptionSource): Promise<void> {
    return this.serial(`${CUSTOMER}${customerId}`, async () => {
      // The read happens inside the customer's queue: a read that started
      // earlier finishes, and is written, before a later one begins.
      const reading = await readSubscription(subscriptionId, source);
      const record = (await this.kv.get<CustomerRecord>(`${CUSTOMER}${customerId}`)) ?? { subscriptions: {} };
      const previous = record.subscriptions[subscriptionId];
      const eventAt = Math.max(Date.now(), (previous?.eventAt ?? 0) + 1);
      await this.writeSubscription(customerId, subscriptionId, { ...reading, eventAt });
    });
  }

  linkCustomer(customerId: string, userId: string): Promise<boolean> {
    return this.serial(`${CUSTOMER}${customerId}`, async () => {
      const record = (await this.kv.get<CustomerRecord>(`${CUSTOMER}${customerId}`)) ?? { subscriptions: {} };
      if (record.userId && record.userId !== userId) return false;
      if (!record.userId) {
        record.userId = userId;
        await this.kv.put(`${CUSTOMER}${customerId}`, record);
      }
      // Users collect customers rather than swapping one for another. Anyone
      // can pay with any user's id attached, so a link may only ever add a
      // plan to that user, never replace the one they are already paying for.
      await this.serial(`${USER}${userId}`, async () => {
        const customers = (await this.kv.get<string[]>(`${USER}${userId}`)) ?? [];
        if (!customers.includes(customerId)) {
          await this.kv.put(`${USER}${userId}`, [...customers, customerId]);
        }
      });
      return true;
    });
  }

  /** Record a subscription state directly, in the customer's queue. For tests and repair. */
  recordSubscription(customerId: string, subscriptionId: string, state: SubscriptionState): Promise<void> {
    return this.serial(`${CUSTOMER}${customerId}`, () => this.writeSubscription(customerId, subscriptionId, state));
  }

  /** The write itself. Callers must already hold the customer's queue. */
  private async writeSubscription(customerId: string, subscriptionId: string, state: SubscriptionState): Promise<void> {
    const record = (await this.kv.get<CustomerRecord>(`${CUSTOMER}${customerId}`)) ?? { subscriptions: {} };
    const previous = record.subscriptions[subscriptionId];
    // A cancelled subscription stays cancelled, and a lower eventAt never
    // overwrites a higher one.
    if (previous && TERMINAL.has(previous.status)) return;
    if (previous && previous.eventAt > state.eventAt) return;
    record.subscriptions[subscriptionId] = state;
    await this.kv.put(`${CUSTOMER}${customerId}`, record);
  }

  async userForCustomer(customerId: string): Promise<string | undefined> {
    return (await this.kv.get<CustomerRecord>(`${CUSTOMER}${customerId}`))?.userId;
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
