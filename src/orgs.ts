import { isOrgId } from "./grant-index.js";
import { domainOf } from "./oauth/dns.js";
import { immutableKeys, parseSsoKey, ssoUserId } from "./oauth/providers.js";
import { DEFAULT_POLICY, type Capability, type Org, type OrgInvite, type OrgPolicy, type PlanGrant, type Role } from "./types.js";

/**
 * What the org routes share (orgs spec, D6, D7): the rules a body is read by and the shape an org
 * is answered in. Runtime-free, so the operator's routes in `src/oauth/routes.ts` and the admin's
 * in `src/http/orgs.ts` read one rule each, and the tests hold it once.
 */

/** A display name, not an id: long enough for a company's legal name, short enough for a heading. */
export const MAX_ORG_NAME_CHARS = 80;

/** The record as the code reads it: a row written before `policy` carries the default, as its own object. */
export function liftOrg(org: Org): Org {
  return { ...org, policy: { ...(org.policy ?? DEFAULT_POLICY) } };
}

// ponytail: a ceiling on seats so a typo cannot store a number nothing counts up to; not a plan limit.
export const MAX_SEATS = 100_000;

// ponytail: pending invites an org holds at once, the bound the roster is read with, so `GET /org/members`
// lists every one. An invite takes no seat, so without it an admin could fill the registry; raise it with paging.
export const MAX_PENDING_INVITES = 200;

/** How long an invite stays an offer (ADR 0036, D3). */
export const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** How soon an invite may be resent (ADR 0036, D4): long enough that a resend is not a way to flood an inbox. */
export const RESEND_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * How many invite mails an org may send in a UTC day (ADR 0036, D4): fifty, or twice its seats if that is more. Every
 * send counts, a resend's and a fresh invite's after a withdrawal alike, so no route past the cooldown reaches more.
 */
export const inviteMailBudget = (org: Org): number => Math.max(50, 2 * org.seats);

/** The UTC day `now` falls in, as the invite mail budget counts it. */
export const inviteMailDay = (now: number): number => Math.floor(now / 86_400_000);

/** The invite as the code reads it: a row written before `expiresAt` lapses fourteen days after it was made. */
export function liftInvite(invite: OrgInvite): OrgInvite {
  return { ...invite, expiresAt: invite.expiresAt ?? invite.invitedAt + INVITE_TTL_MS };
}

/** Whether an invite is still an offer at `now`: the one rule the stores and the routes ask. */
export const inviteLive = (invite: OrgInvite, now: number): boolean => invite.expiresAt > now;

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
  policy: PolicyView;
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
    policy: policyView(org.policy),
  };
}

/** The most org ids `allowed_counterparty_orgs` may list (policy spec, D6). */
export const MAX_COUNTERPARTY_ORGS = 50;

export interface PolicyView {
  require_org_only: boolean;
  forbidden_capabilities: Capability[];
  allowed_counterparty_orgs: string[] | null;
  who_may_create: OrgPolicy["whoMayCreate"];
  allow_operator_impersonation: boolean;
}

export function policyView(policy: OrgPolicy): PolicyView {
  return {
    require_org_only: policy.requireOrgOnly,
    forbidden_capabilities: [...policy.forbiddenCapabilities],
    allowed_counterparty_orgs: policy.allowedCounterpartyOrgs && [...policy.allowedCounterpartyOrgs],
    who_may_create: policy.whoMayCreate,
    allow_operator_impersonation: policy.allowOperatorImpersonation,
  };
}

const CAPABILITIES: readonly Capability[] = ["read_context", "receive_messages", "request_actions"];
const distinct = (list: readonly unknown[]): boolean => new Set(list).size === list.length;

/** The patch a PATCH /org body's `policy` names, or the text of the first fault. An empty object is a fault. */
export function parsePolicyPatch(value: unknown): { patch: Partial<OrgPolicy> } | { error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { error: "policy must be an object" };
  const fields = Object.entries(value);
  if (fields.length === 0) return { error: "policy names no field" };
  const patch: Partial<OrgPolicy> = {};
  for (const [field, v] of fields) {
    switch (field) {
      case "require_org_only":
      case "allow_operator_impersonation":
        if (typeof v !== "boolean") return { error: `${field} must be true or false` };
        patch[field === "require_org_only" ? "requireOrgOnly" : "allowOperatorImpersonation"] = v;
        break;
      case "forbidden_capabilities":
        if (!Array.isArray(v) || !v.every((c) => CAPABILITIES.includes(c)) || !distinct(v)) {
          return { error: "forbidden_capabilities must list read_context, receive_messages or request_actions, each once" };
        }
        patch.forbiddenCapabilities = v as Capability[];
        break;
      case "allowed_counterparty_orgs":
        if (v !== null && !(Array.isArray(v) && v.length <= MAX_COUNTERPARTY_ORGS && v.every((id) => typeof id === "string" && isOrgId(id)) && distinct(v))) {
          return { error: `allowed_counterparty_orgs must be null or a list of at most ${MAX_COUNTERPARTY_ORGS} distinct org ids` };
        }
        patch.allowedCounterpartyOrgs = v as string[] | null;
        break;
      case "who_may_create":
        if (v !== "any_member" && v !== "admins_only") return { error: "who_may_create must be any_member or admins_only" };
        patch.whoMayCreate = v;
        break;
      default:
        return { error: `${field} is not a field of policy` };
    }
  }
  return { patch };
}

/** The first forbidden capability a declaration holds, as the refusal text, or null. */
export function forbiddenCapabilityRefusal(policy: OrgPolicy, capabilities: readonly string[]): string | null {
  const hit = policy.forbiddenCapabilities.find((c) => capabilities.includes(c));
  return hit ? `your org's policy forbids granting ${hit} to peers; call again without it.` : null;
}

/** Whether `list` (an org's allowed counterparties) admits `other`; `null` on the other side is a member outside any org. */
const admits = (list: string[] | null, other: string | null): boolean => list === null || (other !== null && list.includes(other));

/**
 * Spec D3, both sides: the joiner's org must allow every org in the room, and every org in the room
 * must allow the joiner's. `roomOrgIds` is `session.orgs`; `roomHasOrgless` is true when the creator
 * or any member on the roster is outside any org, which no list admits. A room org with no record
 * reads as open.
 */
export async function joinRefusal(
  getOrg: (orgId: string) => Promise<Org | undefined>,
  joinerOrgId: string | null,
  roomOrgIds: readonly string[],
  roomHasOrgless: boolean,
): Promise<string | null> {
  const others = roomOrgIds.filter((id) => id !== joinerOrgId);
  const mine = joinerOrgId === null ? null : (await getOrg(joinerOrgId))?.policy.allowedCounterpartyOrgs ?? null;
  if (mine !== null) {
    if (roomHasOrgless) return "your org's policy does not allow rooms with a member outside any org.";
    for (const id of others) if (!admits(mine, id)) return `your org's policy does not allow rooms with org "${id}".`;
  }
  for (const id of others) {
    const theirs = (await getOrg(id))?.policy.allowedCounterpartyOrgs ?? null;
    if (!admits(theirs, joinerOrgId)) return `org "${id}"'s policy does not allow members of your org in its rooms.`;
  }
  return null;
}
