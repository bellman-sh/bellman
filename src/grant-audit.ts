import type { AuditEntry, PlanGrant } from "./types.js";

/**
 * What a grant change becomes in the audit log.
 *
 * The admin route and billing each built these entries for themselves, and the
 * two diverged: #68 found a redelivered Stripe event appending a plan_granted
 * line for a change that had not happened. RegistryDO is the only thing that
 * knows the previous grant at commit time, so the rule belongs beside the
 * mutation, not in either caller.
 *
 * Runtime-free, as grant-index.ts is: store-do.ts imports `cloudflare:workers`,
 * which no vitest test can import, so a rule written inside it could not be
 * tested at all.
 */

/** What a caller contributes: who is acting, and anything extra to record. */
export interface AuditIntent {
  actorUserId: string;
  detail?: Record<string, unknown>;
}

/**
 * Whether a write left plan, role and org as they were. Nothing else is
 * compared: a redelivered Stripe event rewrites grantedAt and nothing more, and
 * an entry for it would say only that nothing happened.
 */
function samePlan(a: PlanGrant | undefined, b: PlanGrant): boolean {
  return a !== undefined && a.plan === b.plan && a.role === b.role && a.orgId === b.orgId;
}

/**
 * One entry.
 *
 * The caller's detail is merged over the store's so billing can say why a plan
 * was revoked, or which Stripe customer paid. `key` goes last regardless: it
 * names the record this entry is about, and a caller that could rename it could
 * file an entry against a grant it does not hold.
 */
function entry(
  orgId: string,
  key: string,
  action: "plan_granted" | "plan_revoked",
  intent: AuditIntent,
  detail: Record<string, unknown>,
  now: number
): AuditEntry {
  return {
    at: now,
    orgId,
    sessionId: `grant:${key}`,
    actorUserId: intent.actorUserId,
    action,
    detail: { ...detail, ...intent.detail, key },
  };
}

/**
 * What a guarded grant WRITE should record. `previous` is the grant this write
 * replaced under the same key, or undefined for a first grant.
 *
 * Nothing when plan, role and org are all as they were. When the org moved, the
 * old org gets a revocation — that is the only place it will ever be recorded,
 * since the grant is re-homed rather than deleted.
 *
 * An org-less grant records nothing at all: the audit log is org-scoped and a
 * pro purchase has no stream to be written to. Queuing one would park a row
 * that can never be delivered at the head of a FIFO queue.
 */
export function grantAuditEntries(
  previous: PlanGrant | undefined,
  next: PlanGrant,
  intent: AuditIntent,
  now: number
): AuditEntry[] {
  if (samePlan(previous, next)) return [];
  const entries: AuditEntry[] = [];
  if (previous && previous.orgId !== null && previous.orgId !== next.orgId) {
    entries.push(entry(previous.orgId, next.key, "plan_revoked", intent, {
      plan: previous.plan, reason: "moved to another plan", moved_to: next.orgId,
    }, now));
  }
  if (next.orgId !== null) {
    entries.push(entry(next.orgId, next.key, "plan_granted", intent, {
      plan: next.plan, role: next.role, org_id: next.orgId, source: next.source,
      ...(previous ? { replaced_plan: previous.plan } : {}),
    }, now));
  }
  return entries;
}

/** What a guarded grant DELETE should record. Nothing, for an org-less grant. */
export function revokeAuditEntries(
  removed: PlanGrant,
  intent: AuditIntent,
  now: number
): AuditEntry[] {
  if (removed.orgId === null) return [];
  return [entry(removed.orgId, removed.key, "plan_revoked", intent, { plan: removed.plan }, now)];
}
