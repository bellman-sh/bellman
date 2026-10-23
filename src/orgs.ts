import type { Org, Role } from "./types.js";

/**
 * What the org routes share (orgs spec, D6, D7): the rules a body is read by and the shape an org
 * is answered in. Runtime-free, so the operator's routes in `src/oauth/routes.ts` and the admin's
 * in `src/http/orgs.ts` read one rule each, and the tests hold it once.
 */

/** A display name, not an id: long enough for a company's legal name, short enough for a heading. */
export const MAX_ORG_NAME_CHARS = 80;

// ponytail: a ceiling on seats so a typo cannot store a number nothing counts up to; not a plan limit.
export const MAX_SEATS = 100_000;

/** The name as stored: trimmed, 1 to MAX_ORG_NAME_CHARS characters; undefined for anything else. */
export function parseOrgName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  return name.length >= 1 && name.length <= MAX_ORG_NAME_CHARS ? name : undefined;
}

/** A seat count: a whole number from 1 to MAX_SEATS; undefined for anything else, a numeric string included. */
export function parseSeats(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_SEATS ? value : undefined;
}

/**
 * The user id a stable key names, as `defaultIdentity` mints it: `github:4242` is `u_github_4242`.
 * Null for an address, which names nobody until a sign-in claims it onto a subject (ADR 0013), and
 * for anything that is not a provider subject.
 */
export function userIdForKey(key: string): string | null {
  const match = /^(github|google):(\d+)$/.exec(key);
  return match ? `u_${match[1]}_${match[2]}` : null;
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
