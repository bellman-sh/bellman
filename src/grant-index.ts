import type { PlanGrant } from "./types.js";

/**
 * Key layout for the org-scoped grant index.
 *
 * This lives in its own runtime-free module for the reason CLAUDE.md gives:
 * store-do.ts imports `cloudflare:workers`, so no vitest test can reach inside
 * it. The part worth testing is not the storage calls, it is this key layout
 * and the rule for when an index entry goes stale — so that part lives here,
 * where the test suite can hold it to account.
 */

/**
 * Org-less grants need a bucket too, and it must be one no real org id can
 * spell. Org ids are `[A-Za-z0-9_-]+` (see isOrgId), so a `~` cannot collide.
 */
export const NO_ORG = "~none";

/** The grammar an org id must obey for the index encoding below to be sound. */
export function isOrgId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

export const grantKey = (key: string): string => `gr:${key}`;

/** The org record's row (orgs spec, D1): its own prefix, beside the grant's and the index's. */
export const orgKey = (orgId: string): string => `org:${orgId}`;

/** An org's IdP (SSO spec, D9), apart from its record so a read of the org never hands out a secret. */
export const idpKey = (orgId: string): string => `oi:${orgId}`;

/** The one index a verified domain writes (SSO spec, D11): the org a domain routes a sign-in to. */
export const domainKey = (domain: string): string => `od:${domain}`;

/**
 * `go:<org>:<key>` is only unambiguous if the org segment cannot itself contain
 * the separator. Otherwise the encoding is not injective and two different
 * (org, key) pairs collide: `("org_a", "github:google:y")` and
 * `("org_a:github", "google:y")` both spell `go:org_a:github:google:y`, and the
 * second org gets to read and overwrite the first one's grant.
 *
 * Two defences, because one of them is a validator someone can forget to call:
 * the write path rejects an org id that is not isOrgId, and the segment is
 * percent-encoded here regardless, so even a grant written by some future path
 * that skipped validation lands in its own range rather than someone else's.
 *
 * The trailing colon matters for a second reason too: without it the prefix
 * for `org_a` would also match every grant in `org_ab`.
 */
function segment(value: string): string {
  // encodeURIComponent leaves both ":" and "~" alone. The first would make the
  // encoding ambiguous; the second would let an org spell the org-less bucket,
  // merging its listing with every grant that has no org.
  return encodeURIComponent(value).replace(/:/g, "%3A").replace(/~/g, "%7E");
}

/**
 * Null is a tag, not a value that goes through the encoder: branching here is
 * what makes the sentinel unspellable, rather than trusting that no org id
 * happens to be "~none".
 */
export const orgIndexPrefix = (orgId: string | null): string =>
  orgId === null ? `go:${NO_ORG}:` : `go:${segment(orgId)}:`;

export const orgIndexKey = (orgId: string | null, key: string): string =>
  `${orgIndexPrefix(orgId)}${key}`;

/**
 * Index entries to delete when `next` replaces `previous` for the same key.
 *
 * Re-homing a key to another org is the one write that can leave a stale entry
 * behind, and a stale entry means the org a customer left keeps listing them.
 */
export function staleIndexKeys(
  previous: PlanGrant | undefined,
  next: PlanGrant
): string[] {
  if (!previous || previous.orgId === next.orgId) return [];
  return [orgIndexKey(previous.orgId, next.key)];
}

/** Both storage keys a grant occupies. Every delete path must clear both. */
export function allKeysFor(grant: PlanGrant): string[] {
  return [grantKey(grant.key), orgIndexKey(grant.orgId, grant.key)];
}

/**
 * An invite's two rows (ADR 0027), as a grant has two: `io:<org>:<key>` for the org's listing and
 * its count, `iv:<key>:<org>` for the sign-in that looks up every org that invited a key. Neither
 * prefix is a grant's, so no scan of `gr:` or `go:` reads one. The key segment of `iv:` is encoded
 * by the rule above, so a key holding a colon cannot reach another key's range.
 */
export const orgInvitesPrefix = (orgId: string): string => `io:${segment(orgId)}:`;
export const keyInvitesPrefix = (key: string): string => `iv:${segment(key)}:`;

/** Both storage keys an invite occupies. Every delete path clears both. */
export function inviteKeysFor(invite: { orgId: string; key: string }): string[] {
  return [`${orgInvitesPrefix(invite.orgId)}${invite.key}`, `${keyInvitesPrefix(invite.key)}${segment(invite.orgId)}`];
}

/**
 * The orgs a person declined (ADR 0027), on the person's side: `ix:<subject>:<org>`, keyed by the provider
 * subject that answered, so an org's own rows for the keys it invited stay as they were.
 */
export const declinesPrefix = (subjectKey: string): string => `ix:${segment(subjectKey)}:`;
export const declineKey = (subjectKey: string, orgId: string): string => `${declinesPrefix(subjectKey)}${segment(orgId)}`;
