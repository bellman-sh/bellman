import { domainOf } from "./oauth/dns.js";
import { immutableKeys, parseSsoKey, ssoUserId } from "./oauth/providers.js";
import type { Org, PlanGrant, Role } from "./types.js";

/**
 * What the org routes share (orgs spec, D6, D7): the rules a body is read by and the shape an org
 * is answered in. Runtime-free, so the operator's routes in `src/oauth/routes.ts` and the admin's
 * in `src/http/orgs.ts` read one rule each, and the tests hold it once.
 */

/** A display name, not an id: long enough for a company's legal name, short enough for a heading. */
export const MAX_ORG_NAME_CHARS = 80;

// ponytail: a ceiling on seats so a typo cannot store a number nothing counts up to; not a plan limit.
export const MAX_SEATS = 100_000;

// ponytail: pending invites an org holds at once, the bound the roster is read with, so `GET /org/members`
// lists every one. An invite takes no seat, so without it an admin could fill the registry; raise it with paging.
export const MAX_PENDING_INVITES = 200;

/**
 * Whether the org owns this key by its form (ADR 0027), so seating it takes effect without the
 * person's step, as it did before invites: a subject of the org's own IdP, or an address under a
 * domain the org has verified. Every other key is a person the org must invite.
 */
export function ownsByForm(org: Org, key: string): boolean {
  const sso = parseSsoKey(key);
  if (sso) return sso.orgId === org.orgId;
  if (!key.startsWith("email:")) return false;
  const domain = domainOf(key.slice("email:".length));
  return domain !== null && org.domains.some((d) => d.domain === domain && d.verifiedAt !== null);
}

/**
 * A seat an org gave an address it does not own by its form as it stands (ADR 0027): an admin's (`org`), one
 * seated before seats needed the person's consent or under a domain the org has released since, or one its
 * identity provider pushed (`scim`, ADR 0029), which may name any address. Ownership is read now, not when
 * the seat was written. Such a seat takes no effect at a sign-in and is offered there as an invite instead.
 * A seat on a provider subject is not an address, and keeps its effect.
 */
export function isUnownedSeat(grant: PlanGrant, org: Org | undefined): boolean {
  if ((grant.source !== "org" && grant.source !== "scim") || grant.orgId === null || immutableKeys([grant.key]).length > 0) return false;
  return !org || org.orgId !== grant.orgId || !ownsByForm(org, grant.key);
}

/**
 * Where a SCIM write that creates or restores a seat puts it (ADR 0027, ADR 0029): a push, a re-push after a
 * delete, a reactivation. On the org's own `sso:` subject when that is the key, and otherwise on the address,
 * `email:<userName>`; never on a personal account, whatever the IdP names the user. An address the org owns by
 * its form is claimed onto the person's account at their next sign-in, through their own verified email, which
 * no IdP sets; one it does not own is offered there and answered. Writes that only end a seat follow `key`.
 */
export function scimSeatKey(org: Org, userName: string, key: string): string {
  return parseSsoKey(key)?.orgId === org.orgId ? key : `email:${userName}`;
}

/**
 * Whether a grant `next` written for its org takes the key from `previous`, another org's seat (ADR 0027):
 * the seat is unowned, so it holds nothing, and the writing org owns the address by its form, so the
 * address is that org's to seat. The guarded write then replaces the seat rather than refusing the key.
 */
export function takesUnownedSeat(previous: PlanGrant, previousOrg: Org | undefined, next: PlanGrant, nextOrg: Org | undefined): boolean {
  return previous.orgId !== next.orgId && isUnownedSeat(previous, previousOrg)
    && nextOrg !== undefined && nextOrg.orgId === next.orgId && ownsByForm(nextOrg, next.key);
}

/**
 * The mod's rule for a peer's text (`spelledOut` in `src/mod/view.ts`), copied here and not shared, for
 * what an org's name may not hold: every control, format, private-use or unassigned character, every line
 * or paragraph separator, and every code point Unicode leaves undrawn (`Default_Ignorable_Code_Point`, the
 * Hangul fillers among them), but a variation selector (U+FE00 to U+FE0F) directly after a character that
 * draws, and a zero-width non-joiner or joiner (U+200C, U+200D) directly after one or after a selector so
 * kept. So a heart on fire (U+2764 U+FE0F U+200D U+1F525) and a Persian non-joiner between two letters are
 * names. A name is one line, so the mod's line break is not among the exceptions.
 */
const UNDRAWN = String.raw`\p{C}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}`;
const SELECTORS = String.raw`\u{fe00}-\u{fe0f}`;
const JOINERS = String.raw`\u{200c}\u{200d}`;
const UNDRAWN_IN_A_NAME = [
  String.raw`(?![${JOINERS}${SELECTORS}])[${UNDRAWN}]`,
  String.raw`(?<![^${UNDRAWN}])[${SELECTORS}]`,
  String.raw`(?<!(?:[^${UNDRAWN}]|[^${UNDRAWN}][${SELECTORS}]))[${JOINERS}]`,
].join("|");

/** The name as stored: trimmed, 1 to MAX_ORG_NAME_CHARS characters, nothing the rule above refuses; undefined for anything else. */
export function parseOrgName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  return name.length >= 1 && name.length <= MAX_ORG_NAME_CHARS && !new RegExp(UNDRAWN_IN_A_NAME, "u").test(name) ? name : undefined;
}

/**
 * An org's name as a page draws it: without the characters `parseOrgName` refuses, which a name stored
 * before that rule may still hold, and its id when nothing else is left.
 */
export function drawnOrgName(org: Pick<Org, "orgId" | "name">): string {
  return org.name.replace(new RegExp(UNDRAWN_IN_A_NAME, "gu"), "").trim() || org.orgId;
}

/** A seat count: a whole number from 1 to MAX_SEATS; undefined for anything else, a numeric string included. */
export function parseSeats(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_SEATS ? value : undefined;
}

/**
 * The user id a stable key names, as `defaultIdentity` mints it: `github:4242` is `u_github_4242`,
 * and an `sso:` key the encoded id of SSO spec D10. Null for an address, which names nobody until a
 * sign-in claims it onto a subject (ADR 0013), and for anything that is not a provider subject.
 */
export function userIdForKey(key: string): string | null {
  const match = /^(github|google):(\d+)$/.exec(key);
  if (match) return `u_${match[1]}_${match[2]}`;
  const sso = parseSsoKey(key);
  return sso ? ssoUserId(sso.orgId, sso.sub) : null;
}

/** An org as `GET /org` and the operator's routes answer it: snake_case, ISO dates, and never a domain's token. */
export interface OrgView {
  org_id: string;
  name: string;
  owner_user_id: string;
  seats: number;
  seats_used: number;
  active: boolean;
  source: Org["source"];
  created_at: string;
  require_sso: boolean;
  domains: { domain: string; verified_at: string | null }[];
  /** The caller's role in the org, or null for a caller who is not in it, such as the operator. */
  your_role: Role | null;
}

export function orgView(org: Org, seatsUsed: number, yourRole: Role | null): OrgView {
  return {
    org_id: org.orgId,
    name: org.name,
    owner_user_id: org.ownerUserId,
    seats: org.seats,
    seats_used: seatsUsed,
    active: org.active,
    source: org.source,
    created_at: new Date(org.createdAt).toISOString(),
    require_sso: org.requireSso,
    domains: org.domains.map((d) => ({ domain: d.domain, verified_at: d.verifiedAt === null ? null : new Date(d.verifiedAt).toISOString() })),
    your_role: yourRole,
  };
}
