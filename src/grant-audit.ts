import { auditRow } from "./audit.js";
import type { AuditEntry, Org, PlanGrant } from "./types.js";

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
  /** The acting admin's name and org (audit trail spec, D2). Billing acts as `stripe`, which has neither. */
  actorLabel?: string;
  actorOrgId?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Whether an org has an audit stream to write to. The log is org-scoped, so a
 * grant with no org has nowhere to be recorded.
 *
 * Null is no org, and so is anything else falsy. A Durable Object namespace
 * accepts "" and undefined as names, so an entry filed against one is delivered,
 * to a stream no org reads (undefined names the same object as an org called
 * "undefined", which isOrgId allows). isOrgId rejects "" at the admin route and
 * billing derives its own org id, but putGrant is part of the store API and
 * checks nothing, so this does not lean on those having run. grant-index.ts
 * keeps two defences for the org id for the same reason.
 */
function hasOrg(orgId: string | null): orgId is string {
  return Boolean(orgId);
}

/**
 * Whether a write left the grant as an org's audit stream would describe it:
 * plan, role, org, source and expiry. A change of source can take a grant out of
 * billing's hands, and a change of expiry moves the day somebody loses access,
 * so neither passes as a repeat.
 *
 * Two fields are left out on purpose. grantedAt is Date.now() on every write, so
 * comparing it would record every redelivered Stripe event, which is the noise
 * this check exists to remove. grantedBy is who performed the write, and the
 * entry already carries that as its actor; comparing it would record the same
 * fact twice, and add a line whenever a second admin re-asserts an identical
 * grant. (key is not compared either, because previous was read under it.)
 */
function samePlan(a: PlanGrant | undefined, b: PlanGrant): boolean {
  return (
    a !== undefined &&
    a.plan === b.plan &&
    a.role === b.role &&
    a.orgId === b.orgId &&
    a.source === b.source &&
    a.expiresAt === b.expiresAt
  );
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
  // An org's own plan: its only party is the org, so the row is internal and has no room (D2).
  return auditRow(orgId, [orgId], {
    at: now, sessionId: `grant:${key}`, action, roomName: null, detail: { ...detail, ...intent.detail, key },
  }, { userId: intent.actorUserId, label: intent.actorLabel ?? null, orgId: intent.actorOrgId ?? null });
}

/**
 * What a guarded grant WRITE should record. `previous` is the grant this write
 * replaced under the same key, or undefined for a first grant.
 *
 * Nothing when samePlan finds the grant as it was. When the org moved, the old
 * org gets a revocation — that is the only place it will ever be recorded,
 * since the grant is re-homed rather than deleted.
 *
 * An org-less grant records nothing at all (see hasOrg): the audit log is
 * org-scoped and a pro purchase has no stream to be written to. Queuing one
 * would put a row in the outbox that has nowhere to go.
 *
 * The grant entry states every field samePlan compares, as the grant now has
 * it, so no change files a line that omits the field it changed.
 */
export function grantAuditEntries(
  previous: PlanGrant | undefined,
  next: PlanGrant,
  intent: AuditIntent,
  now: number
): AuditEntry[] {
  if (samePlan(previous, next)) return [];
  const entries: AuditEntry[] = [];
  if (previous && hasOrg(previous.orgId) && previous.orgId !== next.orgId) {
    entries.push(entry(previous.orgId, next.key, "plan_revoked", intent, {
      plan: previous.plan, reason: "moved to another plan", moved_to: next.orgId,
    }, now));
  }
  if (hasOrg(next.orgId)) {
    entries.push(entry(next.orgId, next.key, "plan_granted", intent, {
      plan: next.plan, role: next.role, org_id: next.orgId, source: next.source,
      expires_at: next.expiresAt,
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
  if (!hasOrg(removed.orgId)) return [];
  return [entry(removed.orgId, removed.key, "plan_revoked", intent, { plan: removed.plan }, now)];
}

/**
 * What an org change should record (orgs spec, D8): `org_created` with the record's facts, or
 * `org_updated` naming only what changed among the name, the seats, the standing and the SSO
 * switch, and nothing when none of those moved. A redelivered Stripe event activates an org
 * that is already active, and a domain claim changes nothing the stream says, so neither
 * files a line. Filed under `org:<orgId>` as a grant row is under `grant:<key>`: the org's own
 * affair, one party, internal, no room.
 */
export function orgAuditEntries(previous: Org | undefined, next: Org, intent: AuditIntent, now: number): AuditEntry[] {
  const row = (action: "org_created" | "org_updated", detail: Record<string, unknown>): AuditEntry =>
    auditRow(next.orgId, [next.orgId], { at: now, sessionId: `org:${next.orgId}`, action, roomName: null, detail },
      { userId: intent.actorUserId, label: intent.actorLabel ?? null, orgId: intent.actorOrgId ?? null });
  if (!previous) {
    return [row("org_created", {
      name: next.name, owner_user_id: next.ownerUserId, seats: next.seats, source: next.source, active: next.active,
      ...intent.detail,
    })];
  }
  const changed: Record<string, unknown> = {};
  if (previous.name !== next.name) changed.name = next.name;
  if (previous.seats !== next.seats) changed.seats = next.seats;
  if (previous.active !== next.active) changed.active = next.active;
  if (previous.requireSso !== next.requireSso) changed.require_sso = next.requireSso;
  if (Object.keys(changed).length === 0) return [];
  return [row("org_updated", { ...changed, ...intent.detail })];
}

/**
 * What an org's IdP and domain changes record (SSO spec, D9, D11), and its admins' invites (ADR 0027): one
 * row each, under `org:<orgId>`, the org's own affair. An invite's row names the key the admin typed and
 * nothing of the person; a person's answer to an invite files no row here, and a Join is the grant's row.
 */
export type OrgEvent =
  | "idp_configured" | "idp_removed" | "domain_claimed" | "domain_verified" | "domain_released"
  | "member_invited" | "invite_withdrawn";

export function orgEventEntry(orgId: string, action: OrgEvent, detail: Record<string, unknown>, intent: AuditIntent, now: number): AuditEntry {
  return auditRow(orgId, [orgId], { at: now, sessionId: `org:${orgId}`, action, roomName: null, detail: { ...detail, ...intent.detail } },
    { userId: intent.actorUserId, label: intent.actorLabel ?? null, orgId: intent.actorOrgId ?? null });
}
