import { ENTITLEMENTS } from "../auth.js";
import type { AuditEntry, PlanGrant } from "../types.js";
import type { GrantDelete, GrantWrite } from "../store.js";
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

/** The slice of the store billing writes through. */
export interface PurchaseGrantStore {
  putGrantIfSource(grant: PlanGrant, expectedSource: string): Promise<GrantWrite>;
  deleteGrantIfSource(key: string, expectedSource: string): Promise<GrantDelete>;
  appendAudit(entry: AuditEntry): Promise<void>;
}

/** Whether a write actually changed anything a reader would notice. */
function samePlan(a: PlanGrant | undefined, b: PlanGrant): boolean {
  return a !== undefined && a.plan === b.plan && a.role === b.role && a.orgId === b.orgId;
}

/**
 * A plan change made by Stripe, in the same stream as one made by an admin.
 *
 * The audit log is org-scoped, so a pro purchase — which has no org — has
 * nowhere to be recorded and is skipped. Team purchases are the ones where
 * somebody gaining or losing admin of an org is worth a line.
 */
async function auditPurchase(
  plans: PurchaseGrantStore,
  orgId: string | null,
  action: "plan_granted" | "plan_revoked",
  key: string,
  detail: Record<string, unknown>
): Promise<void> {
  if (!orgId) return;
  await plans.appendAudit({
    at: Date.now(),
    orgId,
    sessionId: `grant:${key}`,
    actorUserId: "stripe",
    action,
    detail: { key, ...detail },
  });
}

/**
 * Make the stored grant match what this user is currently paying for.
 *
 * Called after anything that can change the answer. It reads the ledger rather
 * than the event, because a user may have several subscriptions and several
 * Stripe customers, and the plan is the best of them — an event tells you one
 * subscription changed, not what the total comes to.
 *
 * A grant an operator wrote by hand is never touched: a lapsing subscription
 * is not a reason to revoke a plan somebody was comped. Those come back as
 * "conflict", which is reported, not retried — a human has to decide.
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
    const { outcome, removed } = await plans.deleteGrantIfSource(key, PURCHASE);
    if (outcome === "deleted") {
      await auditPurchase(plans, removed?.orgId ?? null, "plan_revoked", key, {
        plan: removed?.plan, reason: "subscription no longer paying",
      });
    }
    return outcome;
  }

  const grant = purchaseGrant(key, paid.plan, userId);
  const { outcome, previous } = await plans.putGrantIfSource(grant, PURCHASE);
  if (outcome !== "written") return outcome;

  // Stripe delivers the same event twice and delivers events for changes that
  // do not move the plan. Auditing every write would fill the org stream with
  // lines saying nothing happened, so only a real transition is recorded.
  if (samePlan(previous, grant)) return outcome;

  // Leaving an org is a revocation for that org, and it is the only place it
  // will ever be recorded: the grant is re-homed rather than deleted, so the
  // plan_granted below goes to the new org and the old one would hear nothing.
  // A team subscription ending while a pro one continues does exactly this.
  if (previous && previous.orgId !== grant.orgId) {
    await auditPurchase(plans, previous.orgId, "plan_revoked", key, {
      plan: previous.plan, reason: "moved to another plan", moved_to: grant.orgId,
    });
  }

  await auditPurchase(plans, grant.orgId, "plan_granted", key, {
    plan: grant.plan, role: grant.role, org_id: grant.orgId, source: grant.source,
    stripe_customer: paid.customerId,
    ...(previous ? { replaced_plan: previous.plan } : {}),
  });
  return outcome;
}
