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
 * The trailing colon is load-bearing for a second reason: without it the prefix
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
