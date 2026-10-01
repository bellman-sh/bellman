import { ENTITLEMENTS } from "../auth.js";
import type { PlanGrant } from "../types.js";
import type { GrantDelete, GrantWrite } from "../store.js";
import type { AuditIntent } from "../grant-audit.js";
import { isOrgId } from "../grant-index.js";
import type { BillingStorage } from "./ledger.js";

/**
 * Turning what Stripe says into a plan grant.
 *
 * Billing deliberately has no plan lookup of its own. Every plan is resolved
 * through one path — operator override, then stored grant — and that path
 * carries ownership checks, expiry, claiming onto a stable subject and an
 * audit trail. A second source read at sign-in would inherit none of it, and
 * would be a second set of semantics to keep in step forever. So the webhook
 * writes a grant, and a purchase resolves exactly like any other plan.
 *
 * Runtime-free, so it runs under plain Node in tests.
 */

/** What billing stamps on the grants it owns, and the only ones it may touch. */
export const PURCHASE = "purchase";

/**
 * The identity key a purchased plan is filed under.
 *
 * Grants are keyed by upstream identity (`github:4242`) while billing knows
 * the Bellman user id (`u_github_4242`) — which is derived from exactly that
 * identity, which is why this inverse exists at all. null for anything else,
 * including the hand-written user ids an operator grant may carry (`u_jesse`):
 * those name an account but not an upstream human, so there is no key to file
 * a purchase under and the purchase is left for an operator to apply.
 */
export function grantKeyForUser(userId: string): string | null {
  const match = /^u_(github|google)_(\d+)$/.exec(userId);
  return match ? `${match[1]}:${match[2]}` : null;
}

/** The org a team buyer becomes admin of. Named for them, not for the customer. */
export const orgForUser = (userId: string): string => `org_${userId}`;

/**
 * Whether a purchase can be applied to this user at all.
 *
 * Two things have to hold, and both of them decide whether taking the money
 * would be honest:
 *
 * - the identity key has to be recoverable, so the grant has somewhere to go;
 * - the org named after them has to satisfy the grant store's grammar, or a
 *   team grant built from it is one `usableGrant` refuses — the buyer pays and
 *   keeps the free plan, with nothing anywhere saying why.
 *
 * `isLinkableUserId` is a weaker question and answers a different one: whether
 * the id can survive the trip through Stripe as a `client_reference_id`. An id
 * can do that and still be one no purchase can be filed against.
 */
export function canPurchaseAs(userId: string): boolean {
  return grantKeyForUser(userId) !== null && isOrgId(orgForUser(userId));
}

/**
 * The grant a paid plan becomes.
 *
 * Team buyers get an org of their own and are its admin. The org is named for
 * the user, not for whichever Stripe customer is paying: anyone can check out
 * with anyone's user id attached, so which customer wins must not decide which
 * org somebody is in. `org_u_github_4242` satisfies the org id grammar the
 * grant store enforces.
 */
export function purchaseGrant(key: string, plan: PlanGrant["plan"], userId: string): PlanGrant {
  const scoped = ENTITLEMENTS[plan].orgScoping;
  return {
    key,
    plan,
    role: scoped ? "admin" : "member",
    orgId: scoped ? orgForUser(userId) : null,
    source: PURCHASE,
    grantedAt: Date.now(),
    grantedBy: "stripe",
    // No expiry. Stripe tells us when a subscription ends, and a purchase that
    // lapsed silently would be a plan nobody is paying for — so the webhook
    // removes it rather than a clock doing it. A missed cancellation event is
    // the failure this trades for, and Stripe retries those.
    expiresAt: null,
  };
}

/** The slice of the store billing writes through. The store audits, not us. */
export interface PurchaseGrantStore {
  putGrantIfSource(grant: PlanGrant, expectedSource: string, audit: AuditIntent): Promise<GrantWrite>;
  deleteGrantIfSource(key: string, expectedSource: string, audit: AuditIntent): Promise<GrantDelete>;
}

/**
 * Make the stored grant match what this user is currently paying for.
 *
 * Called after anything that can change the answer. It reads the ledger rather
 * than the event, because a user may have several subscriptions and several
 * Stripe customers, and the plan is the best of them — an event tells you one
 * subscription changed, not what the total comes to.
 *
 * A grant an operator wrote by hand is never touched: a lapsing subscription is
 * not a reason to revoke a plan somebody was comped. Those come back as
 * "conflict", which is reported, not retried — a human has to decide.
 *
 * The audit record is the store's job now, written in the same transaction as
 * the grant change. Auditing here meant a failed append after a durable delete
 * was lost for good: Stripe retried, the delete returned "missing", and the
 * revocation never reached the org's stream.
 */
export async function reconcilePurchase(
  userId: string,
  billing: BillingStorage,
  plans: PurchaseGrantStore
): Promise<"written" | "deleted" | "missing" | "conflict" | "unkeyable"> {
  const key = grantKeyForUser(userId);
  // canPurchaseAs, not just a recoverable key: a user id that would produce an
  // org too long for the store is one whose team grant would be refused after
  // the money was taken. /upgrade turns those away before Stripe, and this is
  // the same rule on the write side for anything that got past it.
  if (!key || !canPurchaseAs(userId)) return "unkeyable";

  const paid = await billing.paidPlan(userId);

  if (!paid) {
    const { outcome } = await plans.deleteGrantIfSource(key, PURCHASE, {
      actorUserId: "stripe",
      detail: { reason: "subscription no longer paying" },
    });
    return outcome;
  }

  const grant = purchaseGrant(key, paid.plan, userId);
  const { outcome } = await plans.putGrantIfSource(grant, PURCHASE, {
    actorUserId: "stripe",
    detail: { stripe_customer: paid.customerId },
  });
  return outcome;
}
