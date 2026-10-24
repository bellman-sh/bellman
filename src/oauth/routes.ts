import { ENTITLEMENTS, entitlementsFor } from "../auth.js";
import { isOrgId } from "../grant-index.js";
import { handleFromSegment } from "../handles.js";
import { operatorReportView } from "../reports.js";
import { isLinkableUserId } from "../billing/stripe.js";
import { isRecord } from "../billing/subscription.js";
import { MAX_ORG_NAME_CHARS, MAX_SEATS, drawnOrgName, inviteLive, isUnownedSeat, orgView, parseOrgName, parseSeats, userIdForKey } from "../orgs.js";
import { PURCHASE, canPurchaseAs } from "../billing/grants.js";
import type { AuditIntent, BellmanStore } from "../store.js";
import { DEFAULT_POLICY, type Identity, type Org, type OrgInvite, type Plan, type PlanGrant } from "../types.js";
import { parseSsoKey,
  PROVIDERS, defaultIdentity, grantKeys, identityKeys, immutableKeys,
  isProviderName, isStableIdentityKey, ssoKey, ssoKeyForUser,
  type ProviderCredentials, type ProviderName, type ProviderProfile,
} from "./providers.js";
import { inviteNamedBy, verifyInviteLink, type InviteClaim } from "../invite-mail.js";
import { domainOf } from "./dns.js";
import { nonceFor, oidcAuthorizeUrl, oidcExchange } from "./oidc.js";
import { unseal } from "./sealed.js";
import {
  SESSION_TTL_MS, UNUSED_CLIENT_TTL_MS, replannedAt,
  type AuthStorage, type PanelSession, type SettledAnswer,
} from "./storage.js";
import {
  clearedSessionCookie, clearedSigninNonce, readSessionCookie, readSigninNonce,
  serializeSessionCookie, serializeSigninNonce,
} from "./cookies.js";
import { allowedOrigin, corsHeaders, csrfRefusal, preflightResponse } from "./browser.js";
import {
  AGENT_CODE_TTL_MS, AGENT_POLL_INTERVAL_MS, AGENT_REGISTRATION_TTL_MS, ASSERTION_AUDIENCE, CLAIM_GRANT,
  JWT_BEARER_GRANT,
  newAttempt, type AgentAttempt, type AgentRegistration, type ApproveVerdict,
} from "./agent-auth.js";
import {
  ACCESS_TOKEN_TTL_SECONDS, AUTH_CODE_TTL_MS, REFRESH_TOKEN_TTL_MS, STATE_TTL_SECONDS,
  canonicalResource, randomId, sha256Base64url, signJwt, verifyJwt, verifyPkce, type Claims,
} from "./tokens.js";

/**
 * Bellman's authorization server: OAuth 2.1 with PKCE, dynamic client
 * registration, and GitHub/Google as the upstream identity providers.
 *
 * Bellman is both the authorization server and the resource server, which is
 * allowed and keeps the deployment to one Worker. The two roles are still kept
 * honest about each other: a token is minted for exactly one resource URI, and
 * /mcp and /a2a each refuse anything whose audience is not itself.
 */

export interface OAuthConfig {
  /** Origin of this server, e.g. https://mcp.bellman.sh */
  issuer: string;
  /** Canonical URI tokens are minted for when the client names none, e.g. https://mcp.bellman.sh/mcp */
  resource: string;
  /**
   * Every canonical resource a token may be minted for, `resource` among them, e.g. …/mcp and …/a2a (ADR 0033).
   * Absent means `resource` alone.
   */
  resources?: string[];
  secret: string;
  /** What seals an org's IdP client secret (SSO spec, D14): BELLMAN_SEAL_SECRET, or else `secret`. */
  sealSecret?: string;
  store: AuthStorage;
  credentials: Partial<Record<ProviderName, ProviderCredentials>>;
  overrides?: Record<string, Identity>;
  /**
   * Origins the control panel is served from, e.g. ["https://dash.bellman.sh"].
   *
   * Absent or empty means no browser may hold a session: see allowedOrigin.
   * Browser authentication is a capability this list grants, not a default the
   * list restricts.
   */
  panelOrigins?: string[];
  /**
   * Origins public room pages are served from, e.g. ["https://bellman.sh"] (BELLMAN_PUBLIC_PAGE_ORIGINS).
   *
   * This router reads it for the sign-in return alone (`panelDestination`): a sign-in started on one of these pages
   * comes back to it. It adds nothing to what `panelOrigins` grants: sessions, CORS and the CSRF check here still read
   * the panel's list. The Worker hands the same list to the report route and to the suspension gate's refusal of it
   * (`routeOrigin`), the only other things that honour it.
   */
  publicPageOrigins?: string[];
  /**
   * Stripe Payment Links by name, e.g. { pro_monthly: "https://buy.stripe.com/…" }.
   * /upgrade/<name> signs the human in and sends them to the link tagged with
   * their user id, which is how the webhook knows whose plan to change.
   *
   * Billing itself is not here. A purchase becomes a grant, so it resolves
   * through `plans` like every other plan — there is no second source to wire.
   */
  paymentLinks?: Record<string, string>;
  /**
   * Whether purchased plans count. False makes BELLMAN_BILLING a real switch:
   * with it off, grants Stripe wrote earlier stop resolving instead of quietly
   * carrying on, and the ones an operator or admin wrote are untouched.
   */
  honourPurchases?: boolean;
  /** Runtime plan grants. Absent means only BELLMAN_USERS decides a plan. */
  plans?: PlanStore;
  /**
   * The user ids BELLMAN_OPERATORS names (`parseOperators`): who holds the
   * operator's platform-wide powers, which no plan, role or grant confers.
   * Today that is releasing anyone's handle, listing who holds one, suspending an
   * account and working the report queue. Absent or empty names no one.
   */
  operators?: ReadonlySet<string>;
  fetchImpl?: typeof fetch;
}

/** The slice of BellmanStore the authorization server needs. */
export type PlanStore = Pick<
  BellmanStore,
  | "getGrant" | "putGrant" | "deleteGrant" | "moveGrant" | "listGrants"
  | "putGrantIfOwned" | "deleteGrantIfOwned"
  | "getOrg" | "createOrg" | "updateOrg" | "countOrgMembers"
  | "getOrgIdp" | "orgForDomain" | "provisionSsoMember" | "scimUserByKey"
  | "invitesFor" | "acceptOrgInvite" | "declineOrg" | "declinedOrgs"
  | "countCreatesThisMonth"
  | "releaseHandleNamed" | "handleHolders" | "sessionsJoinedBy" | "membersOfUser"
  | "recordSignIn" | "countUsers" | "listUsers"
  | "suspend" | "unsuspend"
  | "listReports" | "resolveReport"
>;

// ponytail: two hundred reports a read, not tuned, and no paging. The queue lists the open reports first and then the
// resolved ones, newest first in each, so the cut falls among the resolved unless more than this many reports are open at
// once: only then does an open report fall past it, and an operator that far behind wants a cursor on the queue. The route
// takes no limit: whatever it asks the store for is this number.
export const MAX_REPORTS_LISTED = 200;

// ponytail: a thousand accounts a read, and no cursor: the store sorts every record to answer, and the first thousand
// by first sign-in is the read this was built for. A cursor on first sign-in when the list outgrows it.
export const MAX_ACCOUNTS_LISTED = 1000;

export type PlanSource = "operator" | "grant" | "default";

/**
 * A sign-in an org has closed, thrown where plans resolve, so a token or a panel session from before the
 * closing stops at its next re-check: `require_sso` (SSO spec, D13) or a deprovision (SCIM spec, D4). The
 * places that catch one end the sign-in with its message; the SSO one adds which door to use.
 */
export class SignInRefused extends Error {}

/**
 * The refusal `require_sso` makes (SSO spec, D13): a GitHub or Google sign-in by someone the org
 * claims, named so the person knows which door to use.
 */
export class SsoRequired extends SignInRefused {
  constructor(public readonly orgId: string, public readonly orgName: string) {
    super(`${orgName} requires single sign-on`);
    this.name = "SsoRequired";
  }
}

/** An org with no seat left for the person its IdP just authenticated (D13): nothing is minted. */
export class SeatsFull extends Error {
  constructor(orgName: string) {
    super(`${orgName} has no free seat: ask its admin for one`);
    this.name = "SeatsFull";
  }
}

/** A person the org's identity provider deprovisioned (SCIM spec, D4): no sign-in, and nothing minted. */
export class AccessRemoved extends SignInRefused {
  constructor(public readonly orgName: string) {
    super(`${orgName} has removed your access: ask its admin`);
    this.name = "AccessRemoved";
  }
}

/**
 * Whether `require_sso` refuses this person (D13): the org their plan puts them in, and the org a
 * verified domain of any of their addresses belongs to, each with the switch on, unless they are
 * that org's owner, whose original provider is the break-glass. An SSO profile is exempt, since it
 * came through the door the switch points at; an operator override never reaches this.
 *
 * The plan's org is a grant's, one that took effect, never an invite's (ADR 0027): an invite is kept
 * apart from the grants and nothing that resolves a plan reads it, so an org that has only invited a
 * person refuses none of their sign-ins. The domain half is the org's by its form, as before.
 */
async function ssoRefusal(plans: PlanStore | undefined, identity: Identity, keys: string[]): Promise<SignInRefused | null> {
  if (!plans) return null;
  // A person the org's identity provider deprovisioned (SCIM spec, D4): one read per stable key, here so that a
  // token refresh, a panel session's re-check and a hosted room's month turn all stop them, as the switch stops
  // its people. Before the exemption below: the subject the IdP deprovisioned is an `sso:` key. Only that key: a
  // personal GitHub or Google account that an address linked to the org loses the org's grant and nothing else,
  // or an org could end a stranger's sign-in by pushing their address.
  for (const key of grantKeys(keys)) {
    const managed = await plans.scimUserByKey(key);
    if (managed && !managed.active && parseSsoKey(key)?.orgId === managed.orgId) {
      return new AccessRemoved((await plans.getOrg(managed.orgId))?.name ?? managed.orgId);
    }
  }
  if (keys.some((key) => key.startsWith("sso:"))) return null;
  const orgIds = new Set<string>();
  if (identity.orgId) orgIds.add(identity.orgId);
  for (const key of keys) {
    if (!key.startsWith("email:")) continue;
    const domain = domainOf(key.slice("email:".length));
    const orgId = domain ? await plans.orgForDomain(domain) : undefined;
    if (orgId) orgIds.add(orgId);
  }
  for (const orgId of orgIds) {
    const org = await plans.getOrg(orgId);
    if (org?.requireSso && org.ownerUserId !== identity.userId) return new SsoRequired(orgId, org.name);
  }
  return null;
}

async function refuseUnlessSso(plans: PlanStore | undefined, identity: Identity, keys: string[]): Promise<void> {
  const refusal = await ssoRefusal(plans, identity, keys);
  if (refusal) throw refusal;
}

/**
 * Which identity a signed-in human gets, and why.
 *
 * Precedence is deliberate: the operator's BELLMAN_USERS wins over a stored
 * grant. That is the escape hatch — comping an account, fixing a botched
 * webhook, granting yourself team — and it has to outrank automation or it
 * cannot do that job.
 *
 * A grant contributes plan, role and org ONLY. userId and label come from the
 * provider profile, so granting, changing or revoking a plan never orphans the
 * sessions that human already created.
 *
 * An override is the exception, and only here: it supplies the whole identity,
 * userId included, which is what lets an operator point someone at a specific
 * account. replanOnRefresh deliberately does not — see there.
 *
 * `key` is the identity key that decided the plan: the override's, or the
 * grant's where claimGrant left it, and null when nothing did. The panel's
 * settings page shows it, so that a plan resting on an address is visible.
 */
export async function resolvePlan(
  profile: ProviderProfile,
  config: Pick<OAuthConfig, "overrides" | "plans" | "honourPurchases">
): Promise<{ identity: Identity; source: PlanSource; grantSource?: string; keys: string[]; key: string | null }> {
  const resolved = await decidePlan(profile, config);
  /**
   * The one place a sign-in is observable. Every caller of this function has
   * just exchanged an authorization code — the panel, /upgrade and /authorize —
   * and nothing else calls it, so recording here cannot be forgotten by a
   * fourth caller the way three call sites could (#258).
   *
   * Swallowed on purpose. The record is an observation for counting accounts;
   * losing one is a wrong number, and failing the sign-in over it is a person
   * locked out.
   */
  try {
    // GitHub's label is the login (src/oauth/providers.ts), kept for the operator's account list; no other provider's.
    await config.plans?.recordSignIn(resolved.identity.userId, Date.now(), profile.provider === "github" ? profile.label : undefined);
  } catch (err) {
    console.error("recording the sign-in failed:", err);
  }
  return resolved;
}

async function decidePlan(
  profile: ProviderProfile,
  config: Pick<OAuthConfig, "overrides" | "plans" | "honourPurchases">
): Promise<{ identity: Identity; source: PlanSource; grantSource?: string; keys: string[]; key: string | null }> {
  const keys = identityKeys(profile);
  for (const key of keys) {
    const override = config.overrides?.[key];
    if (override) return { identity: override, source: "operator", keys, key };
  }
  const match = config.plans
    ? await firstGrant(config.plans, keys, config.honourPurchases !== false)
    : undefined;
  if (match) {
    // Sign-in is the only place with the profile, so it is the only place that
    // can pin an address-keyed grant to the subject behind it. Where the grant is
    // filed afterwards is the key worth reporting: one moved onto the subject is
    // found there at every re-check, and one that could not be moved is not.
    const { grant } = match;
    const identity: Identity = { ...defaultIdentity(profile), plan: grant.plan, role: grant.role, orgId: grant.orgId };
    // Refused before the claim (SSO spec, D13): a mistaken GitHub click by someone the switch
    // covers must leave an address grant where their SSO sign-in will claim it, or the role is
    // stranded under a subject the switch never admits and SSO seats a fresh member beside it.
    await refuseUnlessSso(config.plans, identity, keys);
    const filed = await claimGrant(config.plans!, match.grant, match.key, profile);
    return {
      identity,
      source: "grant",
      // `source` says a stored grant decided this; `grantSource` says who wrote
      // it. /upgrade needs the second: a purchase may replace a purchase, and
      // must not replace one an admin wrote by hand.
      grantSource: grant.source,
      keys,
      key: filed,
    };
  }
  const identity = defaultIdentity(profile);
  await refuseUnlessSso(config.plans, identity, keys);
  return { identity, source: "default", keys, key: null };
}

/**
 * Re-resolve a plan at refresh time, from the keys captured at sign-in.
 *
 * Without this a token refresh reissues whatever plan was captured when the
 * human first signed in, and because every rotation grants a fresh 30-day
 * refresh window, a revoked grant would survive for as long as the client kept
 * refreshing. userId and label are kept from the original identity: those come
 * from the provider and do not change, and re-deriving them here would need a
 * profile this code no longer has.
 */
export async function replanOnRefresh(
  stored: Identity,
  keys: string[],
  config: Pick<OAuthConfig, "overrides" | "plans" | "honourPurchases">
): Promise<{ identity: Identity; source: PlanSource; key: string | null }> {
  const base: Identity = { ...stored, plan: "free", role: "member", orgId: null };
  // The subject and nothing else. These keys were written down at sign-in and
  // any of the others may have been reassigned since — an address handed to a
  // new hire, a login vacated and reclaimed — so an override or grant added
  // against one of those names somebody who is not the holder of this token.
  const durable = immutableKeys(keys);
  for (const key of durable) {
    const override = config.overrides?.[key];
    // Plan, role and org only — the same three fields the grant branch below
    // applies. Returning the override whole would let an operator added after
    // sign-in rewrite userId on the next refresh, and this token's holder would
    // come back as a different human with none of their sessions. Sign-in is
    // where an override gets to name someone; refresh is not.
    if (override) {
      return {
        identity: { ...base, plan: override.plan, role: override.role, orgId: override.orgId },
        source: "operator",
        key,
      };
    }
  }
  // Same rule for grants. An address-keyed grant is claimed onto the subject at
  // sign-in, so one that legitimately applies to this human is already filed
  // under a key this sees; one that is not is a grant for whoever holds that
  // address now, and this token is not them.
  const match = config.plans
    ? await firstGrant(config.plans, durable, config.honourPurchases !== false)
    : undefined;
  if (match) {
    const { grant } = match;
    const identity: Identity = { ...base, plan: grant.plan, role: grant.role, orgId: grant.orgId };
    // The stored keys, addresses included, for the domain half of the check: a stale address refuses, which is the closed direction.
    await refuseUnlessSso(config.plans, identity, keys);
    return { identity, source: "grant", key: match.key };
  }
  await refuseUnlessSso(config.plans, base, keys);
  return { identity: base, source: "default", key: null };
}

/**
 * The plan a user who signed in with a provider holds now, from their user id alone (I7):
 * what their next token refresh would carry, `replanOnRefresh` over the provider subject the
 * id is built from (`defaultIdentity`). A hosted room's seat reads its creator's plan this way
 * at each month turn. Null for a user id no provider minted, such as a key table's.
 */
export async function signedInPlan(
  userId: string,
  config: Pick<OAuthConfig, "overrides" | "plans" | "honourPurchases">,
): Promise<Plan | null> {
  const subject = /^u_(github|google)_(\d+)$/.exec(userId);
  const key = subject ? `${subject[1]}:${subject[2]}` : ssoKeyForUser(userId);
  if (!key) return null;
  const stored: Identity = { userId, orgId: null, plan: "free", role: "member", label: "" };
  try {
    return (await replanOnRefresh(stored, [key], config)).identity.plan;
  } catch (err) {
    // An account `require_sso` or a deprovision has closed can no longer sign in, so its plan is as good as free.
    if (err instanceof SignInRefused) return "free";
    throw err;
  }
}

/**
 * The grant for the most specific key that has one.
 *
 * Only stable keys are consulted: a label is not an identifier, and a grant
 * filed against one would transfer to whoever holds that label next. See
 * isStableIdentityKey.
 *
 * The lookups run together rather than one await at a time. Each is a round
 * trip to the singleton registry object, this runs on every sign-in and every
 * refresh, and the common case — no grant at all — otherwise pays for every
 * key in sequence. Priority order is preserved by picking from the results.
 */
async function firstGrant(
  plans: PlanStore,
  keys: string[],
  honourPurchases: boolean
): Promise<{ grant: PlanGrant; key: string } | undefined> {
  const stable = grantKeys(keys);
  const found = await Promise.all(stable.map((key) => plans.getGrant(key)));
  for (const [i, grant] of found.entries()) {
    if (!usableGrant(grant) || (!honourPurchases && grant.source === PURCHASE)) continue;
    const org = grant.orgId === null ? undefined : await plans.getOrg(grant.orgId);
    // An admin's seat on an address the org does not own by its form as it stands resolves nothing
    // and is never claimed (ADR 0027): the sign-in's page offers it as an invite instead. Only a
    // sign-in reads address keys, so a refresh never meets one.
    if (isUnownedSeat(grant, org)) continue;
    // The org's standing is applied here and nowhere else (orgs spec, D5): sign-in, a token
    // refresh, a panel session's re-check and a hosted room's month turn all come through
    // this function, so a lapse reaches each of them as a revocation does.
    return { grant: standingOf(grant, org), key: stable[i] };
  }
  return undefined;
}

/**
 * The grant as the org it names stands (orgs spec, D5): the free plan while the org's record says
 * nobody is paying, the role and the org kept so the person is still a member of it; the grant
 * unchanged for an active org and for an org with no record, which is only a string in grants
 * and overrides and has no standing to lose.
 */
export function standingOf(grant: PlanGrant, org: Org | undefined): PlanGrant {
  return org && !org.active ? { ...grant, plan: "free" } : grant;
}

/**
 * Whether a stored grant is one the admin route would have written.
 *
 * That route validates, but it is not the only way a record gets here:
 * putGrant is part of the store API and the billing path writes through it. Org
 * scoping and the audit log both key off orgId, so a `team` or `admin` grant
 * without one hands out the limits while belonging to nobody. Skipping it here
 * rather than trusting the write path also lets a lower-priority key still have
 * its turn, instead of one malformed record shadowing a good grant.
 */
function usableGrant(grant: PlanGrant | undefined): grant is PlanGrant {
  if (!grant) return false;
  if ((grant.plan === "team" || grant.role === "admin") && !grant.orgId) return false;
  if (grant.orgId !== null && !isOrgId(grant.orgId)) return false;
  return true;
}

/**
 * Pin an address-keyed grant to the subject that just claimed it.
 *
 * A verified address is not an identity either. In a managed domain it can be
 * taken off one account and handed to the next person with that name, and they
 * can verify it upstream — so a grant that does not expire would follow the
 * address rather than the human, which is the same transfer the label rule
 * exists to stop.
 *
 * Refusing address keys outright would take away the only way an admin can
 * grant to someone they know by email. So the first sign-in that resolves
 * through an address rewrites the grant onto the provider's immutable subject
 * and retires the address key: after that the address is inert and a later
 * owner of it inherits nothing.
 *
 * The move is one atomic store operation, not a write followed by a delete: a
 * failed delete would leave the address key standing while the subject copy won
 * for this user, so nothing would ever retry the cleanup and the address would
 * stay claimable by its next owner.
 *
 * Best effort at the call site, which is now safe — the move either happened or
 * it did not. Failing to tidy up must not cost the human their sign-in, and the
 * grant keeps resolving by address until a later sign-in succeeds.
 *
 * Answers the key the grant is filed under when it returns: the subject's, or
 * the address it was found under when the move failed and left it there.
 */
async function claimGrant(
  plans: PlanStore,
  grant: PlanGrant,
  matchedKey: string,
  profile: ProviderProfile
): Promise<string> {
  const subjectKey = `${profile.provider}:${profile.subject}`;
  if (matchedKey === subjectKey) return subjectKey;
  try {
    await plans.moveGrant(matchedKey, subjectKey);
    return subjectKey;
  } catch (err) {
    console.error("could not pin a grant to its subject:", err);
    return matchedKey;
  }
}

/**
 * The identity keys on a stored authorization code or refresh token, or null
 * when the record predates the field.
 *
 * OAuth shipped before plans were re-resolved on refresh, so records written by
 * the previous build have no identity_keys and refresh tokens live 30 days.
 * Iterating the missing field throws — and by then takeRefresh has already
 * retired the token, so the client loses it to a 500. Defaulting to [] would be
 * worse: it resolves to the free plan, silently downgrading a paying customer.
 * Refusing deliberately costs one sign-in and mints a record with the field.
 */
function storedIdentityKeys(stored: { identity_keys?: string[] }): string[] | null {
  return Array.isArray(stored.identity_keys) ? stored.identity_keys : null;
}

const STATE_AUDIENCE = "bellman:authorize-state";
const UPGRADE_AUDIENCE = "bellman:upgrade-state";
const SESSION_AUDIENCE = "bellman:session-state";
/** A sign-in held at the invites page (ADR 0027): accepted by its answer route and nowhere else. */
const INVITES_AUDIENCE = "bellman:invites-state";
/** The claim page's form (ADR 0037): names the attempt and the session that saw the page. */
const CLAIM_AUDIENCE = "bellman:claim-state";
const SCOPE = "bellman";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

const oauthError = (error: string, description: string, status = 400) =>
  json({ error, error_description: description }, status);

/** Where the human approves an agent: the claim page, keyed by the attempt. */
const verificationUri = (issuer: string, attemptToken: string) =>
  `${issuer}/agent/claim?claim_attempt_token=${encodeURIComponent(attemptToken)}`;

const claimOffer = (issuer: string, attempt: AgentAttempt) => ({
  user_code: attempt.user_code,
  expires_in: AGENT_CODE_TTL_MS / 1000,
  verification_uri: verificationUri(issuer, attempt.attempt_token),
  interval: AGENT_POLL_INTERVAL_MS / 1000,
});

const claimSignin = (issuer: string, attemptToken: string) =>
  `<a href="/auth/signin?return_to=${escape(encodeURIComponent(verificationUri(issuer, attemptToken)))}">`;

/** The approve form, with a fresh `held` bound to this attempt and this session. */
async function claimForm(config: OAuthConfig, attemptToken: string, sessionId: string, label: string, notice = ""): Promise<Response> {
  const held = await signJwt(
    { iss: config.issuer, aud: CLAIM_AUDIENCE, sub: attemptToken, sid: await sha256Base64url(sessionId), bellman: null as never },
    config.secret,
    STATE_TTL_SECONDS
  );
  return html(
    `<h1>Approve an agent?</h1><p>Signed in as <b>${escape(label)}</b>.</p>` +
      `<p>An agent asked to act as you on Bellman. Approving lets it start rooms and read and send in your rooms, ` +
      `for 30 days or until an operator removes it. Approve only if you started this from your own agent just now.</p>` +
      (notice ? `<p class="notice">${escape(notice)}</p>` : "") +
      `<form class="sso" action="/agent/claim" method="post"><input type="hidden" name="held" value="${escape(held)}">` +
      `<label for="code">Enter the 6-digit code your agent gave you.</label>` +
      `<input id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required>` +
      `<button class="btn" type="submit">Approve</button></form>` +
      `<p>Not you? ${claimSignin(config.issuer, attemptToken)}Sign in with another account.</a></p>`
  );
}

const claimNotice = (title: string, body: string, status = 200) => html(`<h1>${title}</h1><p>${body}</p>`, status);
const CLAIM_INVALID = () => claimNotice("Agent approval", "This link isn't valid. Ask your agent for a new one.", 400);
const CLAIM_EXPIRED = () => claimNotice("Agent approval", "This code has expired. Ask your agent for a new one.");

async function claimVerdict(
  verdict: ApproveVerdict, config: OAuthConfig, attemptToken: string, sessionId: string, label: string
): Promise<Response> {
  switch (verdict.kind) {
    case "approved":
      return claimNotice("Agent approved", "Approved. Your agent can continue.");
    case "wrong_code":
      return claimForm(config, attemptToken, sessionId, label,
        `That code didn't match. You have ${verdict.left} ${verdict.left === 1 ? "try" : "tries"} left.`);
    case "dead":
      return claimNotice("Agent approval", "That code didn't match, and that was the last try. Ask your agent for a new code.");
    case "wrong_account":
      return claimNotice("Agent approval",
        "This request is for a different account. Sign in with the account whose email address you gave your agent. " +
          `${claimSignin(config.issuer, attemptToken)}Sign in with another account.</a>`);
    case "reg_expired":
      return claimNotice("Agent approval", "This request has expired. Ask your agent to start again.");
    case "already":
      return claimNotice("Agent approval", "This agent is already approved.");
    // A held this server signed whose attempt is gone: superseded by a new code, killed by wrong
    // codes, or swept. The person's next step is the same in every case.
    case "unknown":
    case "code_expired":
      return CLAIM_EXPIRED();
  }
}

const html = (body: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Bellman</title><style>
        :root{color-scheme:light dark}
        body{font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
             max-width:32rem;margin:0 auto;padding:3rem 1.25rem;}
        h1{font-size:1.35rem;letter-spacing:-.02em;margin:0 0 .25rem}
        p{color:#556;margin:.25rem 0 1.5rem}
        a.btn{display:block;padding:.85rem 1rem;margin:.5rem 0;border:1px solid #c7ccd4;
              border-radius:8px;text-decoration:none;color:inherit;font-weight:600}
        a.btn:hover{border-color:#1a5e7a}
        form.sso{margin:1.25rem 0 .75rem}
        form.sso label{display:block;font-weight:600;margin-bottom:.35rem}
        form.sso input{width:100%;box-sizing:border-box;padding:.7rem .8rem;margin-bottom:.5rem;border:1px solid #c7ccd4;
                       border-radius:8px;font:inherit;background:transparent;color:inherit}
        button.btn{width:100%;background:none;cursor:pointer;font:inherit;text-align:left}
        p.notice{color:#8a3b12}
        code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}
        @media (prefers-color-scheme:dark){p{color:#98a2b0}a.btn,form.sso input{border-color:#39424f}p.notice{color:#e8a26a}}
      </style>${body}`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  );

const escape = (value: string) =>
  value.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);

/** The hand-written providers this server has credentials for, in the order the pages list them. */
const configured = (config: OAuthConfig): ProviderName[] =>
  (Object.keys(PROVIDERS) as ProviderName[]).filter((name) => config.credentials[name]);

/**
 * A sign-in page's body: the heading, a line, the work-email form when single sign-on is offered
 * (SSO spec, D12), a notice when the last attempt routed nowhere, and the provider buttons. The form
 * carries the same signed state the buttons do, so the three audiences and the panel's nonce binding
 * work unchanged.
 */
function signInBody(title: string, intro: string, stateToken: string, available: ProviderName[], sso: boolean, notice?: string): string {
  const buttons = available
    .map((name) => `<a class="btn" href="/authorize/${name}?req=${encodeURIComponent(stateToken)}">Continue with ${PROVIDERS[name].displayName}</a>`)
    .join("");
  const form = sso
    ? `<form class="sso" action="/authorize/sso" method="get"><input type="hidden" name="req" value="${escape(stateToken)}">` +
      `<label for="sso-email">Work email</label>` +
      `<input id="sso-email" type="email" name="email" required autocomplete="email" placeholder="you@yourcompany.com">` +
      `<button class="btn" type="submit">Continue with single sign-on</button></form>`
    : "";
  return `<h1>${title}</h1><p>${intro}</p>${notice ? `<p class="notice">${escape(notice)}</p>` : ""}${form}${buttons}`;
}

/** A redirect_uri must be registered, and must be https or loopback. */
function usableRedirect(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol === "https:") return true;
    return parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

interface AuthorizeRequest {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  state?: string;
}

/** A configured Payment Link by name. Own keys only: /upgrade/constructor is not a plan. */
function paymentLink(config: OAuthConfig, name: string): string | undefined {
  const links = config.paymentLinks;
  return links && Object.hasOwn(links, name) ? links[name] : undefined;
}

/** Carried through the provider round trip when signing in to the panel. */
interface SessionRequest {
  return_to: string;
  /** Binds this sign-in to the browser that started it. See finishSession. */
  nonce: string;
  /**
   * The invite the link this sign-in started from names (ADR 0036, D2): the verified claim, never the link's token,
   * since this state is sent to the provider. It is as trustworthy as the state that signs it.
   */
  invite?: InviteClaim;
}

/**
 * Constant-time string equality, for comparing a nonce against a cookie.
 *
 * `===` on strings can return as soon as two bytes differ, which leaks how much
 * of a guess was right. Both values here are 32 random bytes in base64url, so a
 * length difference is already a mismatch and comparing the whole of both costs
 * nothing.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Where to send a freshly-authenticated browser.
 *
 * The open redirect. `returnTo` reaches us inside a signed state, so it cannot
 * have been altered mid-flow — but it was supplied by whoever started the flow,
 * and that is not necessarily the person finishing it. So it is validated here
 * too, on exact origin equality against the panel allowlist and the public room
 * pages' (BELLMAN_PUBLIC_PAGE_ORIGINS), which a "Sign in to report" on a room's
 * page comes back to.
 *
 * Exact equality, not a prefix test: startsWith("https://dash.bellman.sh")
 * admits "https://dash.bellman.sh.attacker.example".
 *
 * Parsing is not validation. `new URL("javascript:alert(1)")` succeeds, and its
 * origin is the string "null" — so the origin comparison is what refuses it,
 * not the parse. A relative path throws instead. Both land on the fallback.
 *
 * Anything unusable falls back to the first configured panel origin rather than
 * erroring: a sign-in that completed should end somewhere the human can use.
 */
function panelDestination(
  returnTo: string | undefined,
  panelOrigins: string[],
  publicPageOrigins: readonly string[],
  issuer: string
): string {
  const fallback = panelOrigins[0];
  if (!returnTo) return fallback;
  let parsed: URL;
  try {
    parsed = new URL(returnTo);
  } catch {
    return fallback;
  }
  // `returnTo` unchanged, not `parsed.toString()`. This runs twice — once at
  // /auth/signin to seal a usable destination into the state, and again in
  // finishSession on the way out — and toString() normalises a bare origin to
  // origin + "/", so the second pass would rewrite the first pass's answer.
  // Returning the input makes it idempotent. The origin is what was validated;
  // the path and query are the destination's business.
  // The agent claim page is this server's own, and the one page of it a sign-in comes back to.
  const claimPage = parsed.origin === new URL(issuer).origin && parsed.pathname === "/agent/claim";
  return claimPage || panelOrigins.includes(parsed.origin) || publicPageOrigins.includes(parsed.origin) ? returnTo : fallback;
}

/** Carried through the provider round trip when signing in to pay. */
interface UpgradeRequest {
  link: string;
}

/**
 * Complete a client's authorization: the provider's half (`exchange`, GitHub's, Google's or an org's
 * IdP), the plan, and the code the client redeems; or the client's refusal. A refusal travels as
 * `access_denied` with a description a person can act on: `require_sso` names the org (D13), a full
 * org says to ask its admin, and anything else says only that the sign-in failed, with the cause in
 * the log. `via` names the door for that log line.
 */
async function finishAuthorize(
  exchange: () => Promise<ProviderProfile>,
  pending: AuthorizeRequest,
  config: OAuthConfig,
  via: string,
): Promise<Response> {
  let profile: ProviderProfile;
  try {
    profile = await exchange();
  } catch (err) {
    return refuseAuthorize(pending, err, via);
  }
  return (await invitesHeld(profile, via, { authorize: pending }, config)) ?? completeAuthorize(profile, pending, config, via);
}

/** The client's refusal, as `finishAuthorize` describes it: `access_denied`, in words a person can act on. */
function refuseAuthorize(pending: AuthorizeRequest, err: unknown, via: string): Response {
  const target = new URL(pending.redirect_uri);
  if (pending.state) target.searchParams.set("state", pending.state);
  let description = `${via} sign-in failed`;
  if (err instanceof SsoRequired) description = `${err.message}: start again and enter your work email`;
  else if (err instanceof SeatsFull || err instanceof AccessRemoved) description = err.message;
  else console.error(`${via} sign-in failed:`, err);
  target.searchParams.set("error", "access_denied");
  target.searchParams.set("error_description", description);
  return Response.redirect(target.toString(), 302);
}

/** The client's half once the provider's is done, and the invites page when there was one: the plan, and the code the client redeems. */
async function completeAuthorize(profile: ProviderProfile, pending: AuthorizeRequest, config: OAuthConfig, via: string): Promise<Response> {
  let identity: Identity;
  let planSource: PlanSource = "default";
  let keys: string[] = [];
  try {
    const resolved = await resolvePlan(profile, config);
    identity = resolved.identity;
    planSource = resolved.source;
    keys = resolved.keys;
  } catch (err) {
    return refuseAuthorize(pending, err, via);
  }

  const target = new URL(pending.redirect_uri);
  if (pending.state) target.searchParams.set("state", pending.state);
  const authCode = randomId();
  await config.store.putCode(authCode, {
    client_id: pending.client_id,
    redirect_uri: pending.redirect_uri,
    code_challenge: pending.code_challenge,
    resource: pending.resource,
    identity,
    plan_source: planSource,
    identity_keys: keys,
    expires_at: Date.now() + AUTH_CODE_TTL_MS,
  });
  target.searchParams.set("code", authCode);
  return Response.redirect(target.toString(), 302);
}

/** Send a signed-in human to the Payment Link, tagged so the webhook can credit them. */
async function finishUpgrade(
  url: URL,
  name: ProviderName,
  creds: ProviderCredentials,
  pending: UpgradeRequest,
  config: OAuthConfig
): Promise<Response> {
  const target = paymentLink(config, pending.link);
  const code = url.searchParams.get("code");
  if (!target || !code) {
    return html(`<h1>Sign-in did not finish</h1><p>Nothing was charged. Start the upgrade again.</p>`, 400);
  }
  let resolved: Awaited<ReturnType<typeof resolvePlan>>;
  let email: string | undefined;
  try {
    const profile = await PROVIDERS[name].exchange(creds, code, `${config.issuer}/callback/${name}`, config.fetchImpl);
    resolved = await resolvePlan(profile, config);
    email = profile.email;
  } catch (err) {
    if (err instanceof SsoRequired) {
      return html(`<h1>${escape(err.orgName)} requires single sign-on</h1><p>Nothing was charged. An organisation's plan is its own; ask its admin.</p>`, 403);
    }
    if (err instanceof AccessRemoved) {
      return html(`<h1>Access removed</h1><p>${escape(err.message)}. Nothing was charged.</p>`, 403);
    }
    console.error(`${name} sign-in for upgrade failed:`, err);
    return html(`<h1>Sign-in failed</h1><p>Nothing was charged. Start the upgrade again.</p>`, 502);
  }
  const { identity } = resolved;
  // Stop before Stripe rather than take money for a plan that will not apply.
  //
  // Two ways that happens. An operator override outranks anything paid for. And
  // a stored grant an *admin* wrote is one billing may not touch — reconciling
  // would call putGrantIfSource(…, "purchase"), get "conflict", and leave the
  // buyer charged with nothing changed. A purchase grant is fine: a purchase is
  // allowed to replace one it already owns, which is what an upgrade is.
  const blockedByGrant = resolved.source === "grant" && resolved.grantSource !== PURCHASE;
  if (resolved.source === "operator" || blockedByGrant) {
    return html(
      `<h1>Your plan is set by an administrator</h1>` +
        `<p>This account is on <strong>${escape(identity.plan)}</strong>, assigned directly rather than bought. ` +
        `Paying wouldn't change it, so nothing was charged. Ask whoever runs this Bellman server to change your plan.</p>`
    );
  }
  // Both questions, before any money moves: can this id survive the trip
  // through Stripe, and can a purchase actually be applied to it afterwards?
  // An operator-named id like u_jesse passes the first and fails the second,
  // and taking payment for a grant that will be refused is the worst outcome
  // available here.
  if (!isLinkableUserId(identity.userId) || !canPurchaseAs(identity.userId)) {
    console.error(`upgrade: no purchase can be applied to user id ${identity.userId}`);
    return html(`<h1>This account can't be upgraded here</h1><p>Nothing was charged. Contact the operator.</p>`, 409);
  }
  const checkout = new URL(target);
  checkout.searchParams.set("client_reference_id", identity.userId);
  if (email) checkout.searchParams.set("prefilled_email", email);
  return Response.redirect(checkout.toString(), 302);
}

/**
 * Verify a signed state blob against any of several audiences, and say which
 * one matched.
 *
 * Connecting a client and signing in to pay share one provider round trip, so
 * the hand-off and the callback must both accept either state, and only the
 * callback has to know which it was: one ends at an authorization code, the
 * other at Stripe. Returning the audience with the claims lets it dispatch on
 * the answer rather than verify a second time to find out. A further audience
 * is one more entry in each list.
 */
async function verifyState(
  token: string,
  config: Pick<OAuthConfig, "issuer" | "secret">,
  audiences: readonly string[]
): Promise<{ claims: Claims; audience: string } | null> {
  for (const audience of audiences) {
    const claims = await verifyJwt(token, config.secret, { issuer: config.issuer, audience });
    if (claims) return { claims, audience };
  }
  return null;
}

/**
 * Complete a panel sign-in: mint a session, set the cookie, send the browser on.
 *
 * The record carries identity_keys so the plan can be re-resolved later, the
 * same way a refresh token does — see sessionCaller.
 */
async function finishSession(
  request: Request,
  url: URL,
  exchange: () => Promise<ProviderProfile>,
  pending: SessionRequest,
  config: OAuthConfig
): Promise<Response> {
  const panels = config.panelOrigins ?? [];
  const secure = new URL(config.issuer).protocol === "https:";
  const ending = (res: Response) => endSignin(res, secure);

  if (panels.length === 0) {
    return ending(html(`<h1>No control panel configured</h1><p>Nothing was signed in.</p>`, 503));
  }

  /**
   * The state is signed, so it cannot have been altered — but a signature says
   * nothing about WHO is presenting it. This is what makes the state
   * non-replayable: the browser finishing the sign-in must be the one that
   * started it, and only that browser has the nonce cookie.
   *
   * Compared before the code is exchanged, so a replay costs the attacker's
   * code nothing and tells them nothing.
   */
  if (!signinNonceMatches(request, pending, secure)) return ending(signinElsewhere());

  if (!url.searchParams.get("code")) {
    return ending(html(`<h1>Sign-in did not complete</h1><p>No authorization code came back. Start again.</p>`, 400));
  }

  let profile: ProviderProfile;
  try {
    profile = await exchange();
  } catch (err) {
    return ending(sessionRefusal(err));
  }
  // The invites page keeps the nonce cookie: its answer is bound to this browser, as this callback was.
  return (await invitesHeld(profile, "the panel's", { session: pending }, config)) ?? completeSession(profile, pending, config);
}

/**
 * Every exit from a panel sign-in clears the nonce cookie. It is worth nothing
 * after the sign-in either way, and leaving a live one behind would let a second
 * replay of the same state succeed. The one exception is the invites page, which
 * is not an exit: its answer comes back to this browser and is checked against it.
 */
function endSignin(res: Response, secure: boolean): Response {
  res.headers.append("set-cookie", clearedSigninNonce(secure));
  return res;
}

const signinElsewhere = () =>
  html(`<h1>That sign-in did not start here</h1><p>Start it again from the control panel.</p>`, 400);

/** Whether the browser presenting a panel sign-in holds the nonce cookie of the one that started it (see finishSession). */
function signinNonceMatches(request: Request, pending: SessionRequest, secure: boolean): boolean {
  const presented = readSigninNonce(request, secure);
  return Boolean(presented && pending.nonce && timingSafeEqual(presented, pending.nonce));
}

/** A panel sign-in's refusal, as a page: `require_sso` names the org (D13), a full org and a removed access say so, anything else is logged. */
function sessionRefusal(err: unknown): Response {
  if (err instanceof SsoRequired) {
    return html(`<h1>${escape(err.orgName)} requires single sign-on</h1><p>Start again from the control panel and enter your work email.</p>`, 403);
  }
  if (err instanceof SeatsFull) return html(`<h1>No free seat</h1><p>${escape(err.message)}. Nothing was signed in.</p>`, 403);
  if (err instanceof AccessRemoved) return html(`<h1>Access removed</h1><p>${escape(err.message)}. Nothing was signed in.</p>`, 403);
  console.error("the panel's sign-in failed:", err);
  return html(`<h1>Sign-in failed</h1><p>Start again from the control panel.</p>`, 502);
}

/** The panel's half once the provider's is done, and the invites page when there was one: the plan, the session, the cookie. */
async function completeSession(profile: ProviderProfile, pending: SessionRequest, config: OAuthConfig): Promise<Response> {
  const panels = config.panelOrigins ?? [];
  const secure = new URL(config.issuer).protocol === "https:";
  const ending = (res: Response) => endSignin(res, secure);
  let resolved: Awaited<ReturnType<typeof resolvePlan>>;
  try {
    resolved = await resolvePlan(profile, config);
  } catch (err) {
    return ending(sessionRefusal(err));
  }

  const now = Date.now();
  const id = randomId();
  await config.store.putSession(id, {
    identity: resolved.identity,
    plan_source: resolved.source,
    plan_key: resolved.key,
    identity_keys: resolved.keys,
    created_at: now,
    last_used_at: now,
    replanned_at: now,
    expires_at: now + SESSION_TTL_MS,
  });

  return ending(new Response(null, {
    status: 302,
    headers: {
      location: panelDestination(pending.return_to, panels, config.publicPageOrigins ?? [], config.issuer),
      "set-cookie": serializeSessionCookie(id, secure, Math.floor(SESSION_TTL_MS / 1000)),
      "cache-control": "no-store",
      // This response's own URL holds the provider's authorization code, and it
      // must not be handed on to the panel in a Referer.
      "referrer-policy": "no-referrer",
    },
  }));
}

/**
 * A sign-in held at the invites page (ADR 0027): who the provider said this is, and the flow the page
 * finishes, a client's authorization or the panel's session. Signed and short-lived, as the state the
 * provider round trip carries, and carried the same way, in the page's forms; the first answer that
 * comes back with it spends it, and every drawing of the page signs a fresh one.
 */
interface HeldSignIn {
  profile: ProviderProfile;
  via: string;
  authorize?: AuthorizeRequest;
  session?: SessionRequest;
  /** The invite the link named (ADR 0036, D2), verified at the callback: offered and joinable, and no other. */
  invite?: InviteClaim;
}

/** A line the page shows after an answer: fixed text, and an org's name between, drawn apart from it. */
interface Notice {
  lead: string;
  org?: Org;
  tail?: string;
}

const subjectOf = (profile: ProviderProfile): string => `${profile.provider}:${profile.subject}`;

/**
 * What orgs have offered this sign-in (ADR 0027): their invites of its keys, and an admin's seat on one
 * of its addresses that the org no longer owns by its form, which resolves nothing and is offered here in
 * its place, read as the invite it would be; but no offer an org made by the time the person last declined
 * it, while one made since shows. Most specific key first, as `firstGrant` picks a grant, and one an org.
 */
async function offersFor(plans: PlanStore, keys: string[], subjectKey: string, now: number, linked?: InviteClaim): Promise<OrgInvite[]> {
  const [own, viaLink, grants, declined] = await Promise.all([
    plans.invitesFor(keys), linked ? plans.invitesFor([linked.key]) : [],
    Promise.all(keys.map((key) => plans.getGrant(key))), plans.declinedOrgs(subjectKey),
  ]);
  // A link offers its own invite and no other: the address's invites from other orgs stay that address's, and one
  // resent or issued again since the link was signed is not the link's to offer (ADR 0036, D2).
  const invites = [...viaLink.filter((invite) => linked && inviteNamedBy(invite, linked)), ...own];
  const seats: OrgInvite[] = [];
  for (const grant of grants) {
    if (grant?.orgId && isUnownedSeat(grant, await plans.getOrg(grant.orgId))) {
      seats.push({ orgId: grant.orgId, key: grant.key, role: grant.role, invitedBy: grant.grantedBy, invitedAt: grant.grantedAt, expiresAt: Infinity });
    }
  }
  const declinedAt = new Map(declined.map((d) => [d.orgId, d.at]));
  const seen = new Set<string>();
  return [...invites.filter((invite) => inviteLive(invite, now)), ...seats].filter((offer) =>
    offer.invitedAt > (declinedAt.get(offer.orgId) ?? -Infinity) && !seen.has(offer.orgId) && Boolean(seen.add(offer.orgId)));
}

/**
 * The page a sign-in stops at while an org has offered this person a seat (ADR 0027), or undefined to
 * carry on. It sits after the provider's exchange and before the plan resolves, so a Join is the grant
 * the plan then resolves through, and carrying on leaves every offer as it was. An SSO sign-in is its
 * org's by its form and stops at nothing. A failed read of the offers costs the person nothing: no page
 * this time, and the offers stand for the next.
 */
async function invitesHeld(
  profile: ProviderProfile, via: string, next: Pick<HeldSignIn, "authorize" | "session">, config: OAuthConfig,
): Promise<Response | undefined> {
  if (!config.plans || profile.provider === "sso") return undefined;
  let offers: OrgInvite[];
  let invite: InviteClaim | undefined;
  try {
    invite = next.session?.invite;
    offers = await offersFor(config.plans, grantKeys(identityKeys(profile)), subjectOf(profile), Date.now(), invite);
  } catch (err) {
    console.error("could not read a sign-in's invites:", err);
    return undefined;
  }
  if (offers.length === 0) return undefined;
  return invitesPage({ profile, via, ...next, invite }, offers, config, Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS);
}

/** An org's name as the page draws it: without what a name may not hold, escaped, and isolated so it reorders nothing around it. */
const drawnName = (org: Org): string => `<bdi>${escape(drawnOrgName(org))}</bdi>`;

/**
 * The offers, one form each, with Join and Decline, and a form that carries on without an answer. The
 * buttons say only that: an org's name is its admin's text, so it is drawn once, as text, never as a
 * label. Each drawing signs a fresh held sign-in for its forms, as the sign-in pages' forms carry their
 * state, ending at `exp`, the end the first drawing set ten minutes after the provider's exchange, however
 * often the page is drawn again.
 */
async function invitesPage(held: HeldSignIn, offers: OrgInvite[], config: OAuthConfig, exp: number, notice?: Notice): Promise<Response> {
  const token = await signJwt(
    { iss: config.issuer, sub: "invites", aud: INVITES_AUDIENCE, bellman: held as never, exp }, config.secret, STATE_TTL_SECONDS,
  );
  const hidden = `<input type="hidden" name="held" value="${escape(token)}">`;
  const rows = await Promise.all(offers.map(async (offer) => {
    const org = await config.plans!.getOrg(offer.orgId);
    if (!org) return "";
    return `<form class="invite" action="/auth/invites" method="post">${hidden}<input type="hidden" name="org" value="${escape(org.orgId)}">` +
      `<p><strong>${drawnName(org)}</strong> invited you to join it as ${offer.role === "admin" ? "an admin" : "a member"}.</p>` +
      `<button class="btn" type="submit" name="choice" value="join">Join</button>` +
      `<button class="btn" type="submit" name="choice" value="decline">Decline</button></form>`;
  }));
  const said = notice ? `<p class="notice">${escape(notice.lead)}${notice.org ? drawnName(notice.org) : ""}${escape(notice.tail ?? "")}</p>` : "";
  return html(
    `<h1>You have been invited</h1>` +
      `<p>Joining puts this account in the organisation: you take its plan, its audit log records the rooms you take part in, ` +
      `its admins can read those rooms once they close, and if it requires single sign-on you sign in through it. ` +
      `Until you join, it has none of that.</p>` +
      `${said}${rows.join("")}` +
      `<form action="/auth/invites" method="post">${hidden}` +
      `<button class="btn" type="submit" name="choice" value="continue">Not now: continue signing in</button></form>`
  );
}

/**
 * A Join (ADR 0027), one operation in the store: the offer, the switch, each key's grant and the seats
 * are read in the transaction that writes the grant, so an offer withdrawn first seats nobody. Answers
 * whether the person is now a member, and the line the page shows, which names the org only when it
 * made this person an offer.
 */
async function acceptInvite(
  plans: PlanStore, profile: ProviderProfile, keys: string[], orgId: string, linked?: InviteClaim,
): Promise<{ joined: boolean; notice: Notice }> {
  const person = defaultIdentity(profile);
  // The link's key answers for its own org only, and the store reads it only while its invite is the one the link was
  // signed for, in the Join's own operation (ADR 0036, D2); a Join of any other org is the person's own keys'.
  const link = linked?.orgId === orgId ? { key: linked.key, at: linked.at } : undefined;
  const outcome = await plans.acceptOrgInvite(orgId, keys, subjectOf(profile), Date.now(), {
    actorUserId: person.userId, actorLabel: person.label, actorOrgId: null,
  }, link);
  const org = outcome === "gone" ? undefined : await plans.getOrg(orgId);
  if (!org) return { joined: false, notice: { lead: "That invitation is no longer open." } };
  if (outcome === "joined") return { joined: true, notice: { lead: "You joined ", org, tail: "." } };
  if (outcome === "member") return { joined: true, notice: { lead: "You are already a member of ", org, tail: "." } };
  if (outcome === "sso") return { joined: false, notice: { lead: "", org, tail: " requires single sign-on: to join it, start again and enter your work email." } };
  if (outcome === "full") return { joined: false, notice: { lead: "", org, tail: " has no free seat: ask its admin for one." } };
  return {
    joined: false,
    notice: { lead: "This account is already in another organisation or holds a plan of its own, so it cannot join ", org, tail: "." },
  };
}

/**
 * A Decline (ADR 0027), kept on the person's side: that org's offers stop showing on their pages, and
 * its invites stay as they were, so its admins learn nothing from it, not even which of the keys they
 * invited were one person's. Only an org that made this sign-in an offer is declined, or named.
 */
async function declineInvite(
  plans: PlanStore, keys: string[], subjectKey: string, orgId: string, linked?: InviteClaim,
): Promise<{ declined: boolean; notice: Notice }> {
  const offered = (await offersFor(plans, keys, subjectKey, Date.now(), linked)).some((offer) => offer.orgId === orgId);
  const org = offered ? await plans.getOrg(orgId) : undefined;
  if (!org) return { declined: false, notice: { lead: "That invitation is no longer open." } };
  await plans.declineOrg(subjectKey, orgId, Date.now());
  return { declined: true, notice: { lead: "You declined the invitation from ", org, tail: "." } };
}

/**
 * An answer to a page already answered with the same held sign-in (ADR 0027), such as a second press of
 * Join: it applies nothing, and mints nothing. It follows the first answer to where that left the browser,
 * the client's code or the panel with its cookies, since the browser may show this response and not the
 * first's; draws the page again when the first did, ending when it would; and while the first is still on
 * its way, says so, with a button that asks again. Reaching it takes the held sign-in, and for a panel's
 * the nonce cookie as well, checked before it, so it gives nobody anything the first answer did not.
 */
async function answeredAlready(
  held: HeldSignIn, token: string, settled: SettledAnswer | undefined, keys: string[], subjectKey: string, exp: number, config: OAuthConfig,
): Promise<Response> {
  if (settled?.location) {
    const res = new Response(null, { status: 302, headers: { location: settled.location, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
    for (const cookie of settled.cookies) res.headers.append("set-cookie", cookie);
    return res;
  }
  if (settled?.redrawn) return invitesPage(held, await offersFor(config.plans!, keys, subjectKey, Date.now(), held.invite), config, exp);
  if (settled) return html(`<h1>That sign-in has ended</h1><p>Start it again.</p>`, 400);
  return html(
    `<h1>Your answer is on its way</h1><p>It was sent once already. Continue when it has been saved.</p>` +
      `<form action="/auth/invites" method="post"><input type="hidden" name="held" value="${escape(token)}">` +
      `<button class="btn" type="submit" name="choice" value="continue">Continue</button></form>`
  );
}

export async function handleOAuth(
  request: Request,
  config: OAuthConfig
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;

  /**
   * The paths the panel reaches with fetch, and the only ones that get CORS.
   *
   * Not /mcp: MCP clients are not browsers, and a CORS surface there invites a
   * browser to try. Not /admin: see the branch below. Not /auth/signin or
   * /callback/:provider, which are navigations and never subject to the
   * same-origin policy.
   */
  const browserPath = path === "/auth/session" || path === "/auth/signout" || path === "/account";

  if (method === "OPTIONS" && browserPath) {
    return preflightResponse(allowedOrigin(request, config.panelOrigins));
  }

  // ------------------------------------------------------------- discovery
  // RFC 9728 section 3.1: a resource's metadata is at this prefix plus its path, so /a2a's is under /a2a. The bare
  // path and every other suffix name /mcp, as they did before /a2a was a resource.
  if (method === "GET" && path.startsWith(PROTECTED_RESOURCE_PATH)) {
    const suffix = path.slice(PROTECTED_RESOURCE_PATH.length);
    const named = suffix.startsWith("/") ? canonicalResource(`${config.issuer}${suffix}`) : "";
    return json({
      resource: resourcesOf(config).includes(named) ? named : config.resource,
      authorization_servers: [config.issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: [SCOPE],
      resource_documentation: "https://github.com/bellman-sh/bellman",
    });
  }

  if (method === "GET" && path.startsWith("/.well-known/oauth-authorization-server")) {
    return json({
      issuer: config.issuer,
      authorization_endpoint: `${config.issuer}/authorize`,
      token_endpoint: `${config.issuer}/token`,
      registration_endpoint: `${config.issuer}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token", JWT_BEARER_GRANT, CLAIM_GRANT],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [SCOPE],
      service_documentation: "https://github.com/bellman-sh/bellman",
      // auth.md (ADR 0037): an agent registers by its human's email and polls
      // /token while that human approves on the claim page.
      agent_auth: {
        skill: "https://bellman.sh/auth.md",
        identity_endpoint: `${config.issuer}/agent/identity`,
        claim_endpoint: `${config.issuer}/agent/identity/claim`,
        register_uri: `${config.issuer}/agent/identity`,
        claim_uri: `${config.issuer}/agent/identity/claim`,
        identity_types_supported: ["service_auth"],
      },
    });
  }

  // ------------------------------------------- auth.md agent registration
  if (path === "/agent/identity" || path === "/agent/identity/claim") {
    if (method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return oauthError("invalid_request", "body must be JSON");
    }
    if (!isRecord(body)) return oauthError("invalid_request", "body must be a JSON object");
    const now = Date.now();

    if (path === "/agent/identity") {
      if (body.type === "anonymous") return oauthError("anonymous_not_enabled", "only service_auth is offered");
      if (body.type === "identity_assertion") return oauthError("issuer_not_enabled", "only service_auth is offered");
      if (body.type !== "service_auth") return oauthError("invalid_request", "type must be service_auth");
      const hint = typeof body.login_hint === "string" ? body.login_hint.trim().toLowerCase() : "";
      const [local, domain, ...rest] = hint.split("@");
      if (hint.length > 254 || !local || !domain || rest.length > 0) {
        return oauthError("invalid_request", "login_hint must be the email of the person who will approve");
      }
      const claimToken = `clm_${randomId()}`;
      const reg: AgentRegistration = {
        registration_id: `reg_${randomId(16)}`,
        login_hint: hint,
        created_at: now,
        expires_at: now + AGENT_REGISTRATION_TTL_MS,
        last_poll_at: null,
        attempt: newAttempt(now),
        claimed: null,
      };
      // Same address rule as /register.
      const admission = await config.store.admitAgentRegistration(
        claimToken, reg, request.headers.get("cf-connecting-ip") ?? "unknown", now
      );
      if (admission !== "ok") return oauthError("rate_limited", "too many agent registrations — try later", 429);
      return json({
        registration_id: reg.registration_id,
        registration_type: "service_auth",
        claim_url: `${config.issuer}/agent/identity/claim`,
        claim_token: claimToken,
        claim_token_expires: new Date(reg.expires_at).toISOString(),
        post_claim_scopes: [SCOPE],
        claim: claimOffer(config.issuer, reg.attempt),
      });
    }

    if (typeof body.claim_token !== "string" || typeof body.email !== "string") {
      return oauthError("invalid_request", "claim_token and email are required");
    }
    const { verdict, reg } = await config.store.reissueAgentCode(body.claim_token, body.email, now);
    if (verdict === "unknown") return oauthError("invalid_claim_token", "no registration holds that claim_token");
    if (verdict === "expired") return oauthError("claim_expired", "the registration expired — register again", 410);
    if (verdict === "claimed") return oauthError("claimed_or_in_flight", "the registration is already approved — poll /token");
    if (verdict === "mismatch" || !reg) return oauthError("invalid_request", "email does not match the registration");
    return json({
      registration_id: reg.registration_id,
      claim_attempt_id: reg.attempt.attempt_id,
      status: "initiated",
      expires_at: new Date(reg.expires_at).toISOString(),
      claim_attempt: claimOffer(config.issuer, reg.attempt),
    });
  }

  // --------------------------------------------- dynamic client registration
  if (method === "POST" && path === "/register") {
    let body: { client_name?: string; redirect_uris?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return oauthError("invalid_client_metadata", "body must be JSON");
    }
    const redirects = Array.isArray(body.redirect_uris) ? (body.redirect_uris as string[]) : [];
    if (redirects.length === 0) {
      return oauthError("invalid_redirect_uri", "redirect_uris is required");
    }
    if (!redirects.every((uri) => typeof uri === "string" && usableRedirect(uri))) {
      return oauthError("invalid_redirect_uri", "every redirect_uri must be https, or http on loopback");
    }

    const client = {
      client_id: randomId(16),
      client_name: typeof body.client_name === "string" ? body.client_name.slice(0, 120) : undefined,
      redirect_uris: redirects,
      created_at: Date.now(),
      // Disposable until a token is issued for it.
      expires_at: Date.now() + UNUSED_CLIENT_TTL_MS,
    };

    // Cloudflare sets this; the Node server is local development with no proxy
    // in front of it. An unknown address is not limited rather than sharing one
    // bucket, which would rate-limit a developer against themself.
    //
    // Rate window, stale purge, cap and insert all happen inside the store, as
    // one operation. Checking here and writing there would let every request in
    // a burst pass the same check before any of them wrote.
    const ip = request.headers.get("cf-connecting-ip");
    const admission = await config.store.admitRegistration(client, ip, Date.now());
    if (admission === "rate_limited") {
      return oauthError("too_many_requests", "too many registrations from this address — try later", 429);
    }
    if (admission === "full") {
      return oauthError("too_many_requests", "the client registry is full — try later", 429);
    }
    return json(
      {
        client_id: client.client_id,
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
        // A public client: no secret to leak from a desktop app, PKCE instead.
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_id_issued_at: Math.floor(client.created_at / 1000),
      },
      201
    );
  }

  // ------------------------------------------------------------- /authorize
  if (method === "GET" && path === "/authorize") {
    const q = url.searchParams;
    const clientId = q.get("client_id") ?? "";
    const redirectUri = q.get("redirect_uri") ?? "";

    // Until the client and its redirect_uri are known good, errors are shown
    // here rather than redirected: sending them onward is an open redirect.
    const client = clientId ? await config.store.getClient(clientId) : undefined;
    if (!client) {
      return html(`<h1>Unknown client</h1><p>This application is not registered with Bellman.</p>`, 400);
    }
    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
      return html(
        `<h1>Redirect not registered</h1><p><code>${escape(redirectUri || "(none)")}</code> is not a registered redirect for this client.</p>`,
        400
      );
    }

    const back = (error: string, description: string) => {
      const target = new URL(redirectUri);
      target.searchParams.set("error", error);
      target.searchParams.set("error_description", description);
      const state = q.get("state");
      if (state) target.searchParams.set("state", state);
      return Response.redirect(target.toString(), 302);
    };

    if (q.get("response_type") !== "code") return back("unsupported_response_type", "only code is supported");
    if (q.get("code_challenge_method") !== "S256") return back("invalid_request", "code_challenge_method must be S256");
    const challenge = q.get("code_challenge") ?? "";
    if (challenge.length < 43) return back("invalid_request", "code_challenge is required");

    // The token's audience is the resource named, or /mcp when none is (RFC 8707).
    const requested = q.get("resource");
    const resource = requested ? canonicalResource(requested) : config.resource;
    if (!resourcesOf(config).includes(resource)) {
      return back("invalid_target", `this server only issues tokens for ${resourcesOf(config).join(" and ")}`);
    }

    const pending: AuthorizeRequest = {
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      resource,
      state: q.get("state") ?? undefined,
    };
    const stateToken = await signJwt(
      { iss: config.issuer, sub: "authorize", aud: STATE_AUDIENCE, bellman: pending as never },
      config.secret,
      STATE_TTL_SECONDS
    );

    const available = configured(config);
    if (available.length === 0) {
      return html(`<h1>No sign-in configured</h1><p>This Bellman server has no identity provider set up.</p>`, 503);
    }
    return html(signInBody(
      "Connect to Bellman",
      `<strong>${escape(client.client_name ?? "An application")}</strong> wants to join and create Bellman sessions as you.`,
      stateToken, available, true,
    ));
  }

  // --------------------------------------------------------- /upgrade/<link>
  // Paying needs to know who is paying, so it starts with the same sign-in.
  const upgradeMatch = /^\/upgrade\/([a-z0-9_]{1,64})$/.exec(path);
  if (method === "GET" && upgradeMatch) {
    const link = upgradeMatch[1];
    if (!paymentLink(config, link)) {
      return html(`<h1>Unknown plan</h1><p>There is no plan called <code>${escape(link)}</code>.</p>`, 404);
    }
    const available = configured(config);
    if (available.length === 0) {
      return html(`<h1>No sign-in configured</h1><p>This Bellman server has no identity provider set up.</p>`, 503);
    }
    const stateToken = await signJwt(
      { iss: config.issuer, sub: "upgrade", aud: UPGRADE_AUDIENCE, bellman: { link } as never },
      config.secret,
      STATE_TTL_SECONDS
    );
    // No work-email form: an organisation's plan is its own, and a person pays as the account they use.
    return html(signInBody(
      "Upgrade Bellman",
      "Sign in with the account you use Bellman with, so the plan lands on it. Then you'll pay on Stripe.",
      stateToken, available, false,
    ));
  }

  // -------------------------------------------------------- /auth/signin
  // The panel's sign-in. Same provider hand-off as /authorize and /upgrade;
  // what differs is only where it ends — a cookie rather than an authorization
  // code or a Stripe redirect.
  if (method === "GET" && path === "/auth/signin") {
    const panels = config.panelOrigins ?? [];
    if (panels.length === 0) {
      return html(
        `<h1>No control panel configured</h1>` +
          `<p>This Bellman server has no panel origin set, so it cannot start a browser session.</p>`,
        503
      );
    }
    const available = configured(config);
    if (available.length === 0) {
      return html(`<h1>No sign-in configured</h1><p>This Bellman server has no identity provider set up.</p>`, 503);
    }
    // Binds this sign-in to this browser. Without it the signed state is a
    // bearer credential anyone can replay: an attacker completes the provider
    // half as themselves, keeps the callback URL, and gets a victim to open it
    // — the callback then mints a session for the ATTACKER's account and sets
    // it in the VICTIM's browser, who goes on using the panel believing the
    // account is theirs. SameSite=Lax does not help, because the callback is a
    // top-level GET navigation, which is the case Lax deliberately allows.
    const nonce = randomId();
    // Validated now as well as on the way out. Sealing an unusable destination
    // into a signed blob and discovering it after the provider round trip is a
    // worse error message for the same outcome.
    const pending: SessionRequest = {
      return_to: panelDestination(url.searchParams.get("return_to") ?? undefined, panels, config.publicPageOrigins ?? [], config.issuer),
      nonce,
    };
    const stateToken = await signJwt(
      { iss: config.issuer, sub: "session", aud: SESSION_AUDIENCE, bellman: pending as never },
      config.secret,
      STATE_TTL_SECONDS
    );
    const page = html(signInBody("Sign in to Bellman", "Use the account your rooms belong to.", stateToken, available, true));
    page.headers.append(
      "set-cookie",
      serializeSigninNonce(nonce, new URL(config.issuer).protocol === "https:", STATE_TTL_SECONDS)
    );
    return page;
  }

  // ------------------------------------------------------- /invite/:token
  // An invitation's link (ADR 0036, D2): the panel's sign-in, with the org and the role named above the
  // buttons and the token's claim carried in the state, so the callback offers the invite it names, whichever
  // address the provider reports. Opening it grants nothing: the invite is read again, live, at the
  // callback and at the answer. A browser signed in already signs in again, since the link is not proof
  // that the session's account is the one invited.
  const linkMatch = method === "GET" ? /^\/invite\/([^/]+)$/.exec(path) : null;
  if (linkMatch) {
    // The page's own URL holds the token, which joins as the invite: no answer to it hands that on in a Referer.
    const noReferrer = (res: Response): Response => {
      res.headers.set("referrer-policy", "no-referrer");
      return res;
    };
    const panels = config.panelOrigins ?? [];
    if (panels.length === 0) {
      return noReferrer(html(`<h1>No control panel configured</h1><p>This Bellman server has no panel origin set, so it cannot start a browser session.</p>`, 503));
    }
    const token = linkMatch[1];
    const claim = config.plans ? await verifyInviteLink(token, config.issuer, config.secret) : null;
    const invite = claim
      ? (await config.plans!.invitesFor([claim.key])).find((i) => inviteNamedBy(i, claim) && inviteLive(i, Date.now()))
      : undefined;
    const org = invite ? await config.plans!.getOrg(invite.orgId) : undefined;
    if (!invite || !org) {
      return noReferrer(html(`<h1>This invitation has expired or was withdrawn</h1><p>Ask the person who invited you to send it again.</p>`, 410));
    }
    const nonce = randomId();
    const pending: SessionRequest = {
      return_to: panelDestination(undefined, panels, config.publicPageOrigins ?? [], config.issuer), nonce, invite: claim!,
    };
    const stateToken = await signJwt(
      { iss: config.issuer, sub: "session", aud: SESSION_AUDIENCE, bellman: pending as never }, config.secret, STATE_TTL_SECONDS,
    );
    // An org that requires single sign-on is joined through its IdP, so its page offers only the work-email form.
    const page = html(signInBody(
      `Join ${drawnName(org)} on Bellman`,
      `${drawnName(org)} invited you to join it as ${invite.role === "admin" ? "an admin" : "a member"}. Sign in to accept. ` +
        `Joining puts this account in the organisation: it records rooms you take part in, its admins can read rooms once ` +
        `they close, and if it requires single sign-on you sign in through it. Until you join, it has none of that.`,
      stateToken, org.requireSso ? [] : configured(config), true,
    ));
    page.headers.append("set-cookie", serializeSigninNonce(nonce, new URL(config.issuer).protocol === "https:", STATE_TTL_SECONDS));
    return noReferrer(page);
  }

  // ------------------------------------------------------- /auth/session
  // What the panel calls on boot: who am I, or 401.
  if (method === "GET" && path === "/auth/session") {
    const origin = allowedOrigin(request, config.panelOrigins);
    const who = await caller(request, config);
    if (!who) {
      // No WWW-Authenticate. It exists to tell an OAuth client where discovery
      // starts (RFC 9728), and a browser cannot act on it — the panel's answer
      // to a 401 is to show a link to /auth/signin.
      return json({ error: "not_signed_in" }, 401, corsHeaders(origin));
    }
    const { identity } = who;
    // The identity and nothing that costs a second store read. /account adds
    // entitlements and this month's usage, which is a round trip to the
    // registry; the panel's render-or-sign-in decision needs neither.
    return json(
      {
        user_id: identity.userId,
        label: identity.label,
        plan: identity.plan,
        role: identity.role,
        org_id: identity.orgId,
      },
      200,
      corsHeaders(origin)
    );
  }

  // ------------------------------------------------------- /auth/signout
  if (path === "/auth/signout") {
    const origin = allowedOrigin(request, config.panelOrigins);
    if (method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "POST", ...corsHeaders(origin) },
      });
    }
    const refusal = csrfRefusal(request, "cookie", origin);
    if (refusal) return refusal;

    const secure = new URL(config.issuer).protocol === "https:";
    const id = readSessionCookie(request, secure);
    // Best effort, and deliberately not conditional on the record existing.
    // Signing out must never fail: the recourse when it does is to leave the
    // session open, which is the opposite of what was asked for.
    if (id) {
      await config.store
        .deleteSession(id)
        .catch((err) => console.error("could not delete a panel session:", err));
    }
    return new Response(null, {
      status: 204,
      headers: {
        "set-cookie": clearedSessionCookie(secure),
        "cache-control": "no-store",
        ...corsHeaders(origin),
      },
    });
  }

  // ------------------------------------------- the invites page's answers (ADR 0027)
  // Join, Decline, or carrying on, from the page a sign-in stopped at. The held sign-in is signed,
  // short-lived and spent by the first answer; a panel's is bound to its browser by the nonce cookie,
  // checked before anything is spent or applied, as the callback checked it. The page comes back with
  // what an answer did while an offer remains or the answer did not take; otherwise the sign-in
  // finishes as the callback would have.
  // ------------------------------------------------ auth.md claim page (ADR 0037)
  // A signed-in human approves an agent with the code it gave them. No csrfRefusal (D9): the form
  // carries a `held` bound to the session that saw the page and spent by the first answer.
  if (path === "/agent/claim") {
    if (method !== "GET" && method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
    }
    const caller = await sessionCaller(request, config);
    const sessionId = readSessionCookie(request, new URL(config.issuer).protocol === "https:");
    const now = Date.now();
    if (method === "GET") {
      if (!caller || !sessionId) {
        return new Response(null, { status: 302, headers: { location: `/auth/signin?return_to=${encodeURIComponent(request.url)}` } });
      }
      const attemptToken = url.searchParams.get("claim_attempt_token") ?? "";
      const reg = await config.store.readAgentAttempt(attemptToken, now);
      if (!reg) return CLAIM_EXPIRED();
      if (reg.claimed) return claimNotice("Agent approval", "This agent is already approved.");
      return claimForm(config, attemptToken, sessionId, caller.identity.label);
    }
    const form = new URLSearchParams(await request.text());
    const claims = await verifyJwt(form.get("held") ?? "", config.secret, { issuer: config.issuer, audience: CLAIM_AUDIENCE });
    if (!claims || !caller || !sessionId || claims.sid !== (await sha256Base64url(sessionId))) return CLAIM_INVALID();
    if (!(await config.store.spendOnce(claims.jti, claims.exp * 1000)).first) {
      return claimNotice("Agent approval", "This form was already used. Open the link from your agent again.", 400);
    }
    const verdict = await config.store.approveAgentClaim(claims.sub, form.get("code") ?? "", {
      identity: caller.identity, plan_source: caller.planSource, plan_key: caller.planKey, identity_keys: caller.identityKeys,
    }, now);
    return claimVerdict(verdict, config, claims.sub, sessionId, caller.identity.label);
  }

  if (method === "POST" && path === "/auth/invites") {
    const form = new URLSearchParams(await request.text());
    const claims = await verifyJwt(form.get("held") ?? "", config.secret, { issuer: config.issuer, audience: INVITES_AUDIENCE });
    const plans = config.plans;
    const held = claims?.bellman as unknown as HeldSignIn | undefined;
    if (!claims || !held || !plans || !(held.session || held.authorize)) {
      return html(`<h1>This sign-in link expired</h1><p>Start the sign-in again.</p>`, 400);
    }
    const secure = new URL(config.issuer).protocol === "https:";
    if (held.session && !signinNonceMatches(request, held.session, secure)) return endSignin(signinElsewhere(), secure);
    const choice = form.get("choice");
    if (choice !== "join" && choice !== "decline" && choice !== "continue") {
      return html(`<h1>That answer is not one the page offers</h1><p>Go back and choose again, or start the sign-in again.</p>`, 400);
    }
    const keys = grantKeys(identityKeys(held.profile));
    const subjectKey = subjectOf(held.profile);
    const spent = await config.store.spendOnce(claims.jti, claims.exp * 1000);
    if (!spent.first) return answeredAlready(held, form.get("held") ?? "", spent.settled, keys, subjectKey, claims.exp, config);
    const orgId = form.get("org") ?? "";
    let notice: Notice | undefined;
    let stay = false;
    if (choice === "join") {
      const answer = await acceptInvite(plans, held.profile, keys, orgId, held.invite);
      notice = answer.notice;
      stay = !answer.joined;
    } else if (choice === "decline") {
      const answer = await declineInvite(plans, keys, subjectKey, orgId, held.invite);
      notice = answer.notice;
      stay = !answer.declined;
    }
    const remaining = choice === "continue" ? [] : await offersFor(plans, keys, subjectKey, Date.now(), held.invite);
    const redrawn = stay || remaining.length > 0;
    const res = redrawn
      ? await invitesPage(held, remaining, config, claims.exp, notice)
      : held.session
        ? await completeSession(held.profile, held.session, config)
        : await completeAuthorize(held.profile, held.authorize!, config, held.via);
    // Where this answer left the browser, for a second press of the same button (`answeredAlready`).
    await config.store.settleSpent(claims.jti, { location: res.headers.get("location"), cookies: res.headers.getSetCookie(), redrawn });
    return res;
  }

  // ---------------------------------------- the work-email hand-off (SSO spec, D12)
  // The address's domain picks the org, the org's IdP takes the sign-in, and the same signed state
  // the buttons carry rides along as the IdP's `state`, so the callback tells the audiences apart as
  // the provider callbacks do. No match, or an org with no IdP, is the page again with a notice.
  if (method === "GET" && path === "/authorize/sso") {
    const req = url.searchParams.get("req") ?? "";
    const state = await verifyState(req, config, [STATE_AUDIENCE, UPGRADE_AUDIENCE, SESSION_AUDIENCE]);
    if (!state) return html(`<h1>This sign-in link expired</h1><p>Start the connection again.</p>`, 400);
    const available = configured(config);
    if (state.audience === UPGRADE_AUDIENCE) {
      return html(signInBody(
        "Upgrade Bellman",
        "Single sign-on is not used to pay: an organisation's plan is its own. Sign in with the account you use Bellman with.",
        req, available, false,
      ), 400);
    }
    const email = url.searchParams.get("email") ?? "";
    const domain = domainOf(email);
    const orgId = domain && config.plans ? await config.plans.orgForDomain(domain) : undefined;
    const idp = orgId && config.plans ? await config.plans.getOrgIdp(orgId) : undefined;
    if (!orgId || !idp) {
      return html(signInBody(
        "Sign in to Bellman",
        "Enter your work email again, or use one of the buttons.",
        req, available, true,
        `No single sign-on is set up for ${domain ?? "that address"}. Use one of the buttons, or ask your admin.`,
      ));
    }
    return Response.redirect(oidcAuthorizeUrl(idp, `${config.issuer}/callback/sso/${orgId}`, req, await nonceFor(req)), 302);
  }

  // ------------------------------------------- hand off to a provider
  const startMatch = /^\/authorize\/([a-z]+)$/.exec(path);
  if (method === "GET" && startMatch) {
    const name = startMatch[1];
    if (!isProviderName(name)) return oauthError("invalid_request", "unknown provider", 404);
    const creds = config.credentials[name];
    if (!creds) return oauthError("invalid_request", `${name} sign-in is not configured`, 503);

    const req = url.searchParams.get("req") ?? "";
    // Every audience reaches the same hand-off; only the callback needs to tell
    // them apart.
    const state = await verifyState(req, config, [STATE_AUDIENCE, UPGRADE_AUDIENCE, SESSION_AUDIENCE]);
    if (!state) return html(`<h1>This sign-in link expired</h1><p>Start the connection again.</p>`, 400);

    return Response.redirect(
      PROVIDERS[name].authorizeUrl(creds, `${config.issuer}/callback/${name}`, req),
      302
    );
  }

  // ------------------------------------------- an org's IdP comes back (SSO spec, D12, D13)
  // One redirect URI per org, which is what an Okta or Entra admin registers. The exchange reads the
  // id token, seats the person on first use, and hands the same tail the provider callbacks run.
  const ssoCallback = /^\/callback\/sso\/([^/]+)$/.exec(path);
  if (method === "GET" && ssoCallback) {
    const stateToken = url.searchParams.get("state") ?? "";
    const state = await verifyState(stateToken, config, [STATE_AUDIENCE, UPGRADE_AUDIENCE, SESSION_AUDIENCE]);
    if (!state) return html(`<h1>This sign-in link expired</h1><p>Start the connection again.</p>`, 400);
    const orgId = ssoCallback[1];
    const plans = config.plans;
    const org = plans && isOrgId(orgId) ? await plans.getOrg(orgId) : undefined;
    const idp = org && plans ? await plans.getOrgIdp(orgId) : undefined;
    if (!plans || !org || !idp) {
      return html(`<h1>No single sign-on here</h1><p>This organisation has no identity provider set up. Start the sign-in again.</p>`, 404);
    }
    if (state.audience === UPGRADE_AUDIENCE) {
      return html(`<h1>Single sign-on is not used to pay</h1><p>Nothing was charged. Start the upgrade again with the account you use Bellman with.</p>`, 400);
    }
    const code = url.searchParams.get("code");
    const upstreamError = url.searchParams.get("error");
    const redirectUri = `${config.issuer}/callback/sso/${orgId}`;
    const exchange = async (): Promise<ProviderProfile> => {
      if (upstreamError || !code) throw new Error(upstreamError ?? "no authorization code returned");
      const secret = await unseal(config.sealSecret ?? config.secret, idp.clientSecret);
      const who = await oidcExchange({ ...idp, clientSecret: secret }, code, redirectUri, await nonceFor(stateToken), config.fetchImpl);
      // The address counts only when the IdP vouched for it and it is under a domain the org
      // verified (D12): then it is the key an admin's `email:` grant is claimed by; else a label.
      const domain = who.email ? domainOf(who.email) : null;
      const vouched = who.emailVerified && domain !== null && org.domains.some((d) => d.domain === domain && d.verifiedAt !== null);
      const profile: ProviderProfile = {
        provider: "sso", subject: `${orgId}:${who.sub}`, label: who.name ?? who.email ?? who.sub, email: vouched ? who.email : undefined,
      };
      // The seat, before any token (D13), with the vouched address (SCIM spec, D4): an address an admin or
      // the IdP's connector seated is claimed onto the subject inside the same transaction, so the person
      // keeps the role they were given and takes no second seat; a full org refuses here and nothing is
      // minted; a person the IdP deprovisioned is refused the same way.
      const key = ssoKey(orgId, who.sub);
      const seated = await plans.provisionSsoMember(orgId, key, Date.now(), { actorUserId: "sso", actorOrgId: orgId, detail: { org_id: orgId } }, profile.email);
      if (seated === "full") throw new SeatsFull(org.name);
      if (seated === "deprovisioned") throw new AccessRemoved(org.name);
      if (seated === "no_org") throw new Error("the org's record is gone");
      return profile;
    };
    if (state.audience === SESSION_AUDIENCE) {
      return finishSession(request, url, exchange, state.claims.bellman as unknown as SessionRequest, config);
    }
    return finishAuthorize(exchange, state.claims.bellman as unknown as AuthorizeRequest, config, "single sign-on");
  }

  // ------------------------------------------------- provider comes back
  const callbackMatch = /^\/callback\/([a-z]+)$/.exec(path);
  if (method === "GET" && callbackMatch) {
    const name = callbackMatch[1];
    if (!isProviderName(name)) return oauthError("invalid_request", "unknown provider", 404);
    const creds = config.credentials[name];
    if (!creds) return oauthError("invalid_request", `${name} sign-in is not configured`, 503);

    const stateToken = url.searchParams.get("state") ?? "";
    const state = await verifyState(stateToken, config, [STATE_AUDIENCE, UPGRADE_AUDIENCE, SESSION_AUDIENCE]);
    if (!state) {
      return html(`<h1>This sign-in link expired</h1><p>Start the connection again.</p>`, 400);
    }
    const code = url.searchParams.get("code") ?? "";
    const exchange = () => PROVIDERS[name].exchange(creds, code, `${config.issuer}/callback/${name}`, config.fetchImpl);
    if (state.audience === SESSION_AUDIENCE) {
      return finishSession(request, url, exchange, state.claims.bellman as unknown as SessionRequest, config);
    }
    if (state.audience === UPGRADE_AUDIENCE) {
      // An upgrade came back through the same callback; it ends at Stripe
      // rather than at an authorization code.
      return finishUpgrade(url, name, creds, state.claims.bellman as unknown as UpgradeRequest, config);
    }
    const pending = state.claims.bellman as unknown as AuthorizeRequest;
    const upstreamError = url.searchParams.get("error");
    if (upstreamError || !code) {
      const target = new URL(pending.redirect_uri);
      if (pending.state) target.searchParams.set("state", pending.state);
      target.searchParams.set("error", "access_denied");
      target.searchParams.set("error_description", upstreamError ?? "no authorization code returned");
      return Response.redirect(target.toString(), 302);
    }
    return finishAuthorize(exchange, pending, config, name);
  }

  // ----------------------------------------------------------------- /token
  if (method === "POST" && path === "/token") {
    const form = new URLSearchParams(await request.text());
    const grant = form.get("grant_type");

    if (grant === "authorization_code") {
      const code = form.get("code") ?? "";
      const stored = code ? await config.store.takeCode(code) : undefined;
      if (!stored) return oauthError("invalid_grant", "authorization code is invalid, used, or expired");
      if (stored.client_id !== form.get("client_id")) {
        return oauthError("invalid_grant", "authorization code was issued to another client");
      }
      if (stored.redirect_uri !== form.get("redirect_uri")) {
        return oauthError("invalid_grant", "redirect_uri does not match the authorization request");
      }
      if (!(await verifyPkce(form.get("code_verifier") ?? "", stored.code_challenge))) {
        return oauthError("invalid_grant", "PKCE verification failed");
      }
      const requested = form.get("resource");
      if (requested && canonicalResource(requested) !== stored.resource) {
        return oauthError("invalid_target", "resource does not match the authorization request");
      }
      const codeKeys = storedIdentityKeys(stored);
      if (!codeKeys) {
        return oauthError("invalid_grant", "this authorization code predates plan re-resolution — start the flow again");
      }
      // Same rule as the refresh branch below: takeCode has already burned this
      // code, and issuing can still fail on the way to storing a refresh token.
      // Put the code back so the client can retry, rather than sending it round
      // the whole authorize flow again. It is the code the caller just
      // presented, so restoring it opens no window this request did not have.
      try {
        return await issueTokens(
          config, stored.client_id, stored.resource, stored.identity,
          stored.plan_source, codeKeys
        );
      } catch (err) {
        console.error("could not issue tokens for an authorization code:", err);
        await config.store.putCode(code, stored).catch(() => {});
        return oauthError("temporarily_unavailable", "could not issue tokens — retry", 503);
      }
    }

    if (grant === "refresh_token") {
      // Canonicalized before the token is taken, so a resource that does not parse costs the client nothing.
      const requested = form.get("resource");
      const resource = requested ? canonicalResource(requested) : undefined;
      const token = form.get("refresh_token") ?? "";
      const stored = token ? await config.store.takeRefresh(token) : undefined;
      if (!stored) return oauthError("invalid_grant", "refresh token is invalid, used, or expired");
      const clientId = form.get("client_id");
      if (clientId && stored.client_id !== clientId) {
        return oauthError("invalid_grant", "refresh token was issued to another client");
      }
      // A refresh keeps the audience it was granted (RFC 8707 section 2.2 lets it narrow, and there is nothing
      // narrower than one resource): naming another is refused, and naming none keeps it. The token goes back,
      // as on the failures below: it is the one the caller just presented.
      if (resource && resource !== stored.resource) {
        await config.store.putRefresh(token, stored).catch(() => {});
        return oauthError("invalid_target", "a refresh keeps the resource it was granted for");
      }
      const keys = storedIdentityKeys(stored);
      if (!keys) {
        return oauthError("invalid_grant", "this refresh token predates plan re-resolution — sign in again");
      }
      // Re-resolved, not replayed: a grant revoked since sign-in must not
      // survive because the client kept refreshing.
      //
      // takeRefresh has already retired this token, and re-resolution talks to
      // the registry object over RPC. A transient failure there would otherwise
      // cost the client its refresh token and force a full sign-in, so the
      // token goes back and the client is told to retry. Restoring the token it
      // just presented opens no replay window the request did not already have.
      try {
        const current = await replanOnRefresh(stored.identity, keys, config);
        // Issuance is inside the same guard: signing and storing the
        // replacement refresh token can fail too, and the old one is just as
        // gone. Anything between takeRefresh and a response the client can use
        // must put the token back.
        return await issueTokens(
          config, stored.client_id, stored.resource, current.identity,
          current.source, keys
        );
      } catch (err) {
        // Not put back: the account signs in through its organisation's IdP from now on (SSO spec, D13), or
        // not at all (SCIM spec, D4).
        if (err instanceof SsoRequired) return oauthError("invalid_grant", `${err.message}: sign in again through it`);
        if (err instanceof AccessRemoved) return oauthError("invalid_grant", err.message);
        console.error("could not complete a refresh:", err);
        await config.store.putRefresh(token, stored).catch(() => {});
        return oauthError("temporarily_unavailable", "could not complete the refresh — retry", 503);
      }
    }

    // The agent's poll (D4): the store retires the registration as it grants,
    // so a second poll after a grant is a claim token nobody knows.
    if (grant === CLAIM_GRANT) {
      const claimToken = form.get("claim_token");
      if (!claimToken) return oauthError("invalid_request", "claim_token is required");
      const now = Date.now();
      const verdict = await config.store.pollAgentClaim(claimToken, now);
      switch (verdict.kind) {
        case "unknown":
          return oauthError("invalid_grant", "claim token is invalid or already used");
        case "pending":
          return json({ error: "authorization_pending", error_description: "the human has not approved yet", status: "pending" }, 400);
        case "slow_down":
          return oauthError("slow_down", `poll at most every ${AGENT_POLL_INTERVAL_MS / 1000} s`);
        case "expired":
          return json({ error: "expired_token", error_description: "this registration or its code has expired", status: "expired" }, 400);
        case "granted": {
          const { identity, plan_source } = verdict.claimed;
          // The grant row's expiry is now + REFRESH_TOKEN_TTL_MS, written by
          // the same call with the same now.
          const assertion = await signJwt(
            { iss: config.issuer, sub: identity.userId, aud: ASSERTION_AUDIENCE, jti: verdict.registration_id, bellman: null as never },
            config.secret,
            REFRESH_TOKEN_TTL_MS / 1000
          );
          return json({
            ...(await accessTokenBody(config, config.resource, identity, plan_source)),
            identity_assertion: assertion,
            assertion_expires: new Date(now + REFRESH_TOKEN_TTL_MS).toISOString(),
          });
        }
      }
    }

    // The assertion buys access tokens, never a refresh token (D5), and each
    // one re-resolves the plan as a refresh would (D6).
    if (grant === JWT_BEARER_GRANT) {
      const assertion = form.get("assertion");
      if (!assertion) return oauthError("invalid_request", "assertion is required");
      const requested = form.get("resource");
      if (requested && canonicalResource(requested) !== config.resource) {
        return oauthError("invalid_target", "this server issues tokens for its own resource only");
      }
      const claims = await verifyJwt(assertion, config.secret, { issuer: config.issuer, audience: ASSERTION_AUDIENCE });
      const stored = claims ? await config.store.getAgentGrant(claims.jti, Date.now()) : null;
      if (!claims || !stored) return oauthError("invalid_grant", "assertion is invalid, expired, or revoked");
      try {
        const current = await replanOnRefresh(stored.identity, stored.identity_keys, config);
        return json(await accessTokenBody(config, config.resource, current.identity, current.source));
      } catch (err) {
        if (err instanceof SignInRefused) {
          await config.store.deleteAgentGrant(claims.jti);
          return oauthError("invalid_grant", err.message);
        }
        console.error("could not exchange an agent assertion:", err);
        return oauthError("temporarily_unavailable", "could not exchange the assertion — retry", 503);
      }
    }

    return oauthError("unsupported_grant_type", "use authorization_code, refresh_token, jwt-bearer or the agent claim grant");
  }

  // -------------------------------------------------------------- /account
  // What a signed-in human can see about themselves: who they are, what plan,
  // where that plan came from, and how much of the monthly quota is left.
  if (method === "GET" && path === "/account") {
    const origin = allowedOrigin(request, config.panelOrigins);
    const who = await caller(request, config);
    if (!who) {
      // A browser with no session has nothing to see here: the account page
      // lives in the control panel, which signs the person in and brings them
      // back. A navigation is told from an API call by what it accepts, and a
      // bearer client keeps the 401 with RFC 9728 discovery either way.
      const panel = config.panelOrigins?.[0];
      const navigation = (request.headers.get("accept") ?? "").includes("text/html") && !request.headers.get("authorization");
      if (panel && navigation) return Response.redirect(`${panel}/billing`, 302);
      return new Response("Sign in to see your account.", {
        status: 401,
        headers: {
          // unauthorizedHeaders stays: /account is reached by bearer clients
          // too, and RFC 9728 discovery is what one of those needs.
          // /auth/session is the browser-only endpoint, and that is where the
          // header is omitted.
          ...unauthorizedHeaders(config),
          "content-type": "text/plain",
          ...corsHeaders(origin),
        },
      });
    }
    const { identity, planSource, planKey, subjectKey } = who;
    const limits = entitlementsFor(identity);
    const used = (await config.plans?.countCreatesThisMonth(identity.userId)) ?? 0;
    const account = {
      user_id: identity.userId,
      label: identity.label,
      plan: identity.plan,
      role: identity.role,
      org_id: identity.orgId,
      plan_source: planSource,
      // A panel session's keys. Both are undefined for a bearer caller, and
      // plan_key is for a session signed in before it was kept. JSON leaves an
      // undefined field out, and absent is how the panel tells "not known" from
      // null, which means nothing matched.
      subject_key: subjectKey,
      plan_key: planKey,
      entitlements: limits,
      usage: {
        sessions_created_this_month: used,
        monthly_limit: limits.monthlyCreates,
        remaining: Math.max(limits.monthlyCreates - used, 0),
      },
    };
    if ((request.headers.get("accept") ?? "").includes("application/json")) {
      return json(account, 200, corsHeaders(origin));
    }

    const row = (k: string, v: string) => `<tr><th>${escape(k)}</th><td>${escape(v)}</td></tr>`;
    return html(
      `<h1>Your Bellman account</h1>` +
        `<p>${escape(identity.label)}</p>` +
        `<table>` +
        row("Plan", `${identity.plan} (${planSource === "operator" ? "granted by the operator" : planSource === "grant" ? "granted" : "default"})`) +
        row("Role", identity.role) +
        row("Org", identity.orgId ?? "none") +
        row("Sessions this month", `${used} of ${limits.monthlyCreates}`) +
        row("Modes", limits.modes.join(", ")) +
        `</table>` +
        `<p>Joining a session is free on every plan. Only creating one is limited.</p>`
    );
  }

  // ------------------------------------------------------- /admin/grants
  // Plans as runtime data. Same bar as the audit log: team plan, admin role,
  // and an org — the three things that make someone an operator here.
  if (path === "/admin/grants") {
    const who = await caller(request, config);
    if (!who) return oauthError("invalid_token", "sign in first", 401);
    /**
     * Bearer only, and deliberately not a role check.
     *
     * The writes below gate on planSource === "operator", so a cookie that
     * carried it would be an operator bit on the customer session — the thing
     * #61 rules out, even though the endpoint is itself org-scoped. Operator
     * authority derives from deploy access, and converting "can deploy" into
     * "holds a session cookie" is a strictly weaker credential for the one
     * account whose compromise is every customer's problem rather than one
     * customer's.
     *
     * No CORS either, so a browser cannot read this refusal — there is nothing
     * here for the panel to do with it. When #53-#58 build the org-admin UI,
     * that is the point to design a cookie-reachable admin surface on purpose.
     */
    if (who.via === "cookie") {
      return oauthError(
        "invalid_token",
        "this endpoint requires a bearer token, not a browser session",
        401
      );
    }
    const { identity } = who;
    if (!entitlementsFor(identity).audit || identity.role !== "admin" || !identity.orgId) {
      return oauthError("insufficient_scope", "granting plans requires a team admin", 403);
    }
    // Writing is for admins the operator made, not admins a purchase made.
    //
    // Buying team makes you admin of your own org. If that also let you write
    // grants, one month of team would buy permanent team: an admin can write a
    // grant for their own key, billing only ever removes grants it wrote
    // itself, and the self-written one would survive the cancellation. Granting
    // a second identity into the org does the same thing one step removed.
    //
    // Closing that properly means org membership with a lifetime tied to the
    // purchase, which is not built — the README already says adding people to
    // a purchased org is not a feature yet. Until it is, a purchased admin gets
    // the plan and the org scoping and reads the grant list, and nothing else.
    const writing = method !== "GET";
    if (writing && who.planSource !== "operator") {
      return oauthError(
        "insufficient_scope",
        "writing grants is limited to admins the operator granted; a purchased team admin cannot",
        403
      );
    }
    if (!config.plans) return oauthError("unsupported", "this server has no plan store", 501);

    if (method === "GET") {
      // Scoped to the caller's org: a listing of every grant on the platform
      // would leak other orgs' customers and their plans.
      return json({ grants: await config.plans.listGrants(200, identity.orgId) });
    }

    if (method === "POST") {
      let body: Partial<PlanGrant> & { note?: string };
      try {
        const parsed: unknown = await request.json();
        // Valid JSON is not necessarily an object. `null` parses fine and then
        // throws on the very next property read, turning malformed client input
        // into a 500 where the documented answer is a 400.
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return oauthError("invalid_request", "body must be a JSON object");
        }
        body = parsed as typeof body;
      } catch {
        return oauthError("invalid_request", "body must be JSON");
      }
      // The body is untrusted JSON. A cast is not validation: an unusable key
      // or a non-numeric expiresAt would otherwise be accepted and stored.
      //
      // The key must also be one that keeps naming the same human. A login or
      // display name can be renamed and reclaimed, so a grant filed against one
      // would hand this org's plan — and with role "admin", this org — to
      // whoever picks that label up next.
      if (typeof body.key !== "string" || !isStableIdentityKey(body.key)) {
        return oauthError(
          "invalid_request",
          "key must be github:<numeric id>, google:<numeric id>, or an email address " +
            "(github:, google: or email:) — a username or display name can be reassigned"
        );
      }
      if (body.expiresAt !== undefined && body.expiresAt !== null &&
          !Number.isFinite(body.expiresAt)) {
        // Date.now() > "soon" is false, so a bad value would silently mean
        // "never lapses" — the opposite of what the caller asked for.
        return oauthError("invalid_request", "expiresAt must be a number of milliseconds, or null");
      }
      if (typeof body.plan !== "string" || !Object.hasOwn(ENTITLEMENTS, body.plan)) {
        return oauthError("invalid_request", `plan must be one of ${Object.keys(ENTITLEMENTS).join(", ")}`);
      }
      if (!body.role || !["member", "admin"].includes(body.role)) {
        return oauthError("invalid_request", "role must be member or admin");
      }
      // Same rule grant-plan enforces locally: org scoping and the audit log
      // both key off orgId, so a team or admin grant without one is inert.
      const orgId = body.orgId ?? null;
      if ((body.plan === "team" || body.role === "admin") && !orgId) {
        return oauthError("invalid_request", "a team or admin grant needs an orgId");
      }
      // The org id is a storage key segment. A separator inside it makes the
      // index encoding ambiguous, and an ambiguous key is another org's key —
      // see grant-index.ts. The encoding defends itself too; this is the layer
      // that says so rather than silently mangling the input.
      if (orgId !== null && !isOrgId(orgId)) {
        return oauthError("invalid_request", "orgId must be 1-64 characters of letters, digits, _ or -");
      }
      // An admin administers their own org and no other. Without this, every
      // team admin could grant themselves admin inside anyone else's org —
      // which becomes reachable the moment a purchase creates an org and makes
      // the buyer its admin. Org-less grants come from billing, not from here;
      // the operator's BELLMAN_USERS remains the way to grant outside an org.
      if (orgId !== identity.orgId) {
        return oauthError("insufficient_scope", "grants must target your own org", 403);
      }

      const grant: PlanGrant = {
        key: body.key,
        plan: body.plan,
        role: body.role,
        orgId,
        // Decided here, never by the caller. This is the hand-grant path, so
        // that is what the audit trail must say: letting the body choose would
        // let a manual grant label itself "purchase" and make the provenance
        // in every audit entry worthless. Billing writes through its own path.
        source: "operator",
        grantedAt: Date.now(),
        grantedBy: identity.userId,
        expiresAt: body.expiresAt ?? null,
      };
      // The org check above validates what the caller CLAIMS. This checks what
      // is stored, and does it in the same operation as the write and the audit
      // record: read-then-write let another org's admin land a grant for the
      // same key in the gap, and write-then-audit let the record of a change
      // that already happened be lost with no way to retry it.
      const written = await config.plans.putGrantIfOwned(grant, identity.orgId,
        { actorUserId: identity.userId, actorLabel: identity.label, actorOrgId: identity.orgId });
      if (written === "conflict") {
        return oauthError("insufficient_scope", "that key already has a grant in another org", 403);
      }
      // The seat cap (orgs spec, D3): an org with a record holds as many grants as it bought.
      if (written === "full") return oauthError("conflict", "that org has no free seat", 409);
      return json({ granted: grant }, 201);
    }

    if (method === "DELETE") {
      const key = url.searchParams.get("key") ?? "";
      if (!key) return oauthError("invalid_request", "key is required");
      // Check and delete in one operation, and answer from what it actually
      // removed. Read-then-delete could report a revocation that never
      // happened: a sign-in in the gap claims an address grant onto its subject
      // key, the delete finds nothing, and this would still answer 200 while
      // the grant carried on applying. The store records plan_revoked only for
      // a delete that removed something, so a refusal leaves no entry either.
      const outcome = await config.plans.deleteGrantIfOwned(key, identity.orgId,
        { actorUserId: identity.userId, actorLabel: identity.label, actorOrgId: identity.orgId });
      if (outcome !== "deleted") {
        return oauthError("insufficient_scope", "no such grant in your org", 403);
      }
      return json({ revoked: key });
    }

    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST, DELETE" } });
  }

  // ----------------------------------------------------- /admin/accounts
  // The operator lists who has signed in, first sign-in first: `?limit=` from 1 to MAX_ACCOUNTS_LISTED, 50 when absent.
  // A record is an id and two dates, and that is all this answers: no label, no email, no room. It is the first route
  // to answer rows of accounts, which #259 kept out of /operator/stats; #61 decides where such reads live next. On
  // /admin/handles' gate, in the order every operator route takes: the gate, the method, the plan store, the query.
  if (path === "/admin/accounts") {
    const gate = await operatorGate(request, config, "listing accounts");
    if (gate instanceof Response) return gate;
    if (method !== "GET") return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });
    if (!config.plans) return oauthError("unsupported", "this server has no plan store", 501);
    const raw = new URL(request.url).searchParams.get("limit");
    const limit = raw === null ? 50 : /^[1-9]\d{0,3}$/.test(raw) ? Number(raw) : NaN;
    if (!(limit <= MAX_ACCOUNTS_LISTED)) {
      return oauthError("invalid_request", `limit must be a whole number from 1 to ${MAX_ACCOUNTS_LISTED}`);
    }
    const [total, users] = await Promise.all([config.plans.countUsers(), config.plans.listUsers(limit)]);
    return json({
      total,
      accounts: users.map((u) => ({
        user_id: u.userId,
        first_seen_at: new Date(u.firstSeenAt).toISOString(),
        last_seen_at: new Date(u.lastSeenAt).toISOString(),
        github_login: u.githubLogin ?? null,
      })),
    });
  }

  // ------------------------------------------------------ /admin/handles
  // The operator lists every account holding a handle, for the notice that goes to every holder 30 days before members
  // are named by handle (public rooms on bellman.sh spec, D6). Each holder comes with the sign-in label of its seat in
  // one room it sat in. For most accounts that is an email address, or `<login>@<provider>` when the provider gave none,
  // and it is where the notice goes. `label: null` means the room index (`sessionsJoinedBy`) names no room for the
  // holder. A holder who sat in none reads that way, and so does one who sat only in rooms from before the index, one
  // whose index write failed (`DurableObjectStore.writeIndex` logs a failed put and moves on), and one whose user id
  // another extends past a colon, since the list then answers the other's rooms in place of its own (#295). So null
  // does not say that no notice is owed: the owner cross-checks null holders by hand before leaving one off. On
  // /admin/handles/:handle's gate, and outside the suspension check as /admin/reports is (R8), in the order every
  // route here takes: the gate, the method, the plan store, then the answer. The path is exact, so a release's never
  // lands here and this one never lands on a release.
  //
  // ponytail: the whole list in one answer, and two reads per holder (a room, then its seat). The Workers cap of 1,000
  // subrequests ends it near 500 holders, with an error and not a short list. Page it before then.
  if (path === "/admin/handles") {
    const gate = await operatorGate(request, config, "listing handle holders");
    if (gate instanceof Response) return gate;
    if (method !== "GET") return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });
    const { plans } = config;
    if (!plans) return oauthError("unsupported", "this server has no plan store", 501);
    const holders = await Promise.all((await plans.handleHolders()).map(async ({ userId, handle }) => {
      const room = (await plans.sessionsJoinedBy(userId, 1))[0];
      const seat = room === undefined ? undefined : (await plans.membersOfUser(room, userId))[0];
      return { handle, user_id: userId, label: seat?.label ?? null };
    }));
    return json({ holders });
  }

  // ---------------------------------------------- /admin/handles/:handle
  // The operator releases someone's handle, for a deletion or an abusive name
  // (ADR 0021): the handle and every room signed with it go in one registry
  // transaction, as the holder's own release does. A handle belongs to no org,
  // so this reaches every account, and it is given by name: a bearer token for
  // a user id BELLMAN_OPERATORS lists. No plan, role or grant confers it, so a
  // team admin BELLMAN_USERS makes for one org releases nothing. Bearer only,
  // for /admin/grants' reason. The segment is read as the handle page reads it.
  const named = ADMIN_HANDLE.exec(path);
  if (named) {
    const gate = await operatorGate(request, config, "releasing a handle");
    if (gate instanceof Response) return gate;
    if (method !== "DELETE") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "DELETE" } });
    }
    if (!config.plans) return oauthError("unsupported", "this server has no plan store", 501);
    const handle = handleFromSegment(named[1]);
    if (handle === undefined || (await config.plans.releaseHandleNamed(handle)) === undefined) {
      return oauthError("not_found", "no such handle", 404);
    }
    return new Response(null, { status: 204 });
  }

  // ------------------------------------------ /admin/suspensions/:userId
  // The operator suspends an account or lifts its suspension (abuse protections
  // spec, section 1): every authenticated call that reads or writes the store as
  // a suspended account is refused (plan ruling R8). On /admin/handles' gate. No
  // listing route: the spec names none (R14).
  const suspension = ADMIN_SUSPENSION.exec(path);
  if (suspension) {
    const gate = await operatorGate(request, config, "suspending an account");
    if (gate instanceof Response) return gate;
    if (method !== "POST" && method !== "DELETE") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "POST, DELETE" } });
    }
    if (!config.plans) return oauthError("unsupported", "this server has no plan store", 501);
    let userId: string;
    try {
      userId = decodeURIComponent(suspension[1]);
    } catch {
      return oauthError("invalid_request", "the path's user id is not a valid percent-encoding");
    }
    if (!isLinkableUserId(userId)) {
      return oauthError("invalid_request", "the path must name a user id: u_ and up to 198 letters, digits, - or _");
    }
    if (method === "DELETE") {
      return (await config.plans.unsuspend(userId))
        ? new Response(null, { status: 204 })
        : oauthError("not_found", "no such suspension", 404);
    }
    const note = await operatorNote(request);
    if (note === undefined) return oauthError("invalid_request", "note must be 1 to 500 characters");
    const at = Date.now();
    await config.plans.suspend(userId, { note, by: gate.identity.userId, at });
    return json({ user_id: userId, note, suspended_at: new Date(at).toISOString() });
  }

  // ------------------------------------------------------ /admin/reports
  // The operator reads the report queue and closes a report with a note (abuse protections spec, section 3). On
  // /admin/handles' gate, and outside the suspension check as /admin/suspensions is (R8). Every route here takes the
  // order: the gate, the method, the plan store, then the body.
  if (path === "/admin/reports") {
    const gate = await operatorGate(request, config, "reading reports");
    if (gate instanceof Response) return gate;
    if (method !== "GET") return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });
    if (!config.plans) return oauthError("unsupported", "this server has no plan store", 501);
    // The queue as the store orders it (open reports first, then resolved, newest first in each), with who filed each and whom it is about.
    return json({ reports: (await config.plans.listReports(MAX_REPORTS_LISTED)).map(operatorReportView) });
  }
  const resolving = ADMIN_REPORT_RESOLVE.exec(path);
  if (resolving) {
    const gate = await operatorGate(request, config, "resolving a report");
    if (gate instanceof Response) return gate;
    if (method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
    if (!config.plans) return oauthError("unsupported", "this server has no plan store", 501);
    const note = await operatorNote(request);
    if (note === undefined) return oauthError("invalid_request", "note must be 1 to 500 characters");
    // The id is read as it stands. A report id is `rpt_`, digits, `_` and hex, so it never needs percent-decoding, and
    // any other string is no report: the store answers `undefined`. A report already resolved is answered as it is.
    const report = await config.plans.resolveReport(resolving[1], { note, by: gate.identity.userId }, Date.now());
    return report ? json({ report: operatorReportView(report) }) : oauthError("not_found", "no such report", 404);
  }

  // ------------------------------------------------------------ /admin/orgs
  // The operator creates an org that was not bought, with its owner seated, and resizes one (orgs
  // spec, D7), on /admin/handles' gate. A purchased org is billing's to create (D4), and BELLMAN_USERS
  // keeps naming orgs by string; this is for the org that should have a record, a cap and an owner,
  // so its admin gets the member routes. The order the other operator routes keep: the gate, the
  // method, the plan store, then the body.
  if (path === ADMIN_ORGS) {
    const gate = await operatorGate(request, config, "creating an org");
    if (gate instanceof Response) return gate;
    if (method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
    if (!config.plans) return oauthError("unsupported", "this server has no plan store", 501);
    const body = await jsonObject(request);
    if (!body) return oauthError("invalid_request", "body must be a JSON object");
    const orgId = typeof body.org_id === "string" && isOrgId(body.org_id) ? body.org_id : undefined;
    if (orgId === undefined) return oauthError("invalid_request", "org_id must be 1-64 characters of letters, digits, _ or -");
    const name = parseOrgName(body.name);
    if (name === undefined) return oauthError("invalid_request", `name must be 1 to ${MAX_ORG_NAME_CHARS} characters`);
    const seats = parseSeats(body.seats);
    if (seats === undefined) return oauthError("invalid_request", `seats must be a whole number from 1 to ${MAX_SEATS}`);
    // A subject key, never an address: an address names no user id until a sign-in claims it, and
    // the record needs its owner's id now.
    const ownerUserId = typeof body.owner_key === "string" ? userIdForKey(body.owner_key) : null;
    if (ownerUserId === null) {
      return oauthError("invalid_request", "owner_key must be github:<numeric id> or google:<numeric id> — an address names no user id yet, so it cannot own an org");
    }
    const now = Date.now();
    const org: Org = { orgId, name, ownerUserId, seats, source: "operator", active: true, createdAt: now, requireSso: false, domains: [], policy: DEFAULT_POLICY };
    const owner: PlanGrant = {
      key: body.owner_key as string, plan: "team", role: "admin", orgId, source: "operator",
      grantedAt: now, grantedBy: gate.identity.userId, expiresAt: null,
    };
    const outcome = await config.plans.createOrg(org, owner, operatorIntent(gate.identity));
    if (outcome === "exists") return oauthError("exists", "an org with that id already has a record", 409);
    if (outcome === "conflict") return oauthError("conflict", "the owner's key already has a grant in another org", 409);
    return json({ org: orgView(org, 1, null) }, 201);
  }
  const adminOrg = ADMIN_ORG.exec(path);
  if (adminOrg) {
    const gate = await operatorGate(request, config, "resizing an org");
    if (gate instanceof Response) return gate;
    if (method !== "PATCH") return new Response("Method not allowed", { status: 405, headers: { allow: "PATCH" } });
    if (!config.plans) return oauthError("unsupported", "this server has no plan store", 501);
    // An org id needs no decoding: its grammar has nothing to encode, so a segment outside it names no org.
    if (!isOrgId(adminOrg[1])) return oauthError("not_found", "no such org", 404);
    const body = await jsonObject(request);
    if (!body) return oauthError("invalid_request", "body must be a JSON object");
    const name = body.name === undefined ? undefined : parseOrgName(body.name);
    if (body.name !== undefined && name === undefined) return oauthError("invalid_request", `name must be 1 to ${MAX_ORG_NAME_CHARS} characters`);
    const seats = body.seats === undefined ? undefined : parseSeats(body.seats);
    if (body.seats !== undefined && seats === undefined) return oauthError("invalid_request", `seats must be a whole number from 1 to ${MAX_SEATS}`);
    // `active` is billing's for a purchased org and always true for an operator one; nothing else is editable here.
    if (name === undefined && seats === undefined) return oauthError("invalid_request", "give a name, seats, or both");
    // A purchased org's seats are what its subscription sells: the next Stripe event writes them back,
    // so a resize here would be undone with only a `stripe` row to explain it. The source never
    // changes, so reading it ahead of the write is safe. The name is not billing's.
    const current = await config.plans.getOrg(adminOrg[1]);
    if (!current) return oauthError("not_found", "no such org", 404);
    if (seats !== undefined && current.source === "purchase") {
      return oauthError("purchased", "seats are billing's for a purchased org: change the subscription's quantity in Stripe", 409);
    }
    const org = await config.plans.updateOrg(adminOrg[1], { name, seats }, operatorIntent(gate.identity));
    if (!org) return oauthError("not_found", "no such org", 404);
    return json({ org: orgView(org, await config.plans.countOrgMembers(org.orgId), null) });
  }

  return undefined;
}

const ADMIN_ORGS = "/admin/orgs";
const ADMIN_ORG = /^\/admin\/orgs\/([^/]+)$/;
const ADMIN_HANDLE = /^\/admin\/handles\/([^/]+)$/;
const ADMIN_SUSPENSION = /^\/admin\/suspensions\/([^/]+)$/;
const ADMIN_REPORT_RESOLVE = /^\/admin\/reports\/([^/]+)\/resolve$/;

/** The body as a JSON object, or undefined: not JSON, `null`, an array and a scalar are all no body. */
async function jsonObject(request: Request): Promise<Record<string, unknown> | undefined> {
  const parsed: unknown = await request.json().catch(() => undefined);
  return isRecord(parsed) ? parsed : undefined;
}

/** How an operator's write is recorded: by their id and label, with no org, since the operator acts for the platform. */
const operatorIntent = (identity: Identity): AuditIntent =>
  ({ actorUserId: identity.userId, actorLabel: identity.label, actorOrgId: null });

/**
 * The note an operator's write carries, for a suspension and for a resolution: trimmed, 1 to 500 characters, or
 * `undefined`. A body that is not JSON, `null`, an array or a scalar has no note, and is `undefined` too.
 */
async function operatorNote(request: Request): Promise<string | undefined> {
  const { note } = ((await request.json().catch(() => null)) ?? {}) as { note?: unknown };
  const trimmed = typeof note === "string" ? note.trim() : "";
  return trimmed.length >= 1 && trimmed.length <= 500 ? trimmed : undefined;
}

/**
 * The gate for the operator's platform-wide powers (ADR 0021; abuse protections spec D3): a bearer token, never a
 * cookie, for a user id BELLMAN_OPERATORS lists. The operator, or the refusal: 401 for no credential or a cookie,
 * 403 `insufficient_scope` "<what> is limited to the user ids BELLMAN_OPERATORS lists".
 */
async function operatorGate(request: Request, config: OAuthConfig, what: string): Promise<{ identity: Identity } | Response> {
  const who = await caller(request, config);
  if (!who) return oauthError("invalid_token", "sign in first", 401);
  // Bearer only, for /admin/grants' reason.
  if (who.via === "cookie") {
    return oauthError(
      "invalid_token",
      "this endpoint requires a bearer token, not a browser session",
      401
    );
  }
  if (!config.operators?.has(who.identity.userId)) {
    return oauthError("insufficient_scope", `${what} is limited to the user ids BELLMAN_OPERATORS lists`, 403);
  }
  return who;
}

/**
 * BELLMAN_OPERATORS, a Worker secret: the user ids, comma-separated, that hold
 * the operator's platform-wide powers. Unset or empty names no one. An entry
 * that is not a user id (`isLinkableUserId`'s shape) is skipped and logged, so
 * a subject key such as BELLMAN_USERS is keyed by, or a typo, names no one.
 */
export function parseOperators(raw: string | undefined): ReadonlySet<string> {
  const operators = new Set<string>();
  for (const entry of (raw ?? "").split(",").map((e) => e.trim()).filter(Boolean)) {
    if (isLinkableUserId(entry)) operators.add(entry);
    else console.error(`BELLMAN_OPERATORS lists "${entry}", which is not a user id — skipping it`);
  }
  return operators;
}

/**
 * Who is calling, and how.
 *
 * Bearer first, then a session cookie. `via` is the only thing a consumer
 * learns beyond the identity, and only the CSRF check and /admin read it —
 * everything else sees an Identity and cannot tell the two apart, which is what
 * keeps the authorization rules in one place.
 *
 * Exported for the room routes (#183), which the Worker composes it into so a
 * route and a tool cannot disagree about who someone is.
 */
export async function caller(
  request: Request,
  config: OAuthConfig
): Promise<{
  identity: Identity;
  planSource: string;
  /** The key the plan resolved through. A panel session's only, and absent on one that predates it. */
  planKey?: string | null;
  /** The stable `<provider>:<subject>` key. A panel session's only. */
  subjectKey?: string | null;
  via: "bearer" | "cookie";
} | null> {
  const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (bearer) {
    const claims = await verifyJwt(bearer, config.secret, {
      issuer: config.issuer,
      audience: config.resource,
    });
    if (!claims) return null;
    return {
      identity: claims.bellman,
      planSource: String((claims as Record<string, unknown>).plan_source ?? "default"),
      via: "bearer",
    };
  }
  return sessionCaller(request, config);
}

/**
 * The cookie half, including re-resolving the plan.
 *
 * The record holds the identity captured at sign-in, and a session lives seven
 * days — so without re-resolution a grant revoked on day one would keep
 * applying for six more. replanOnRefresh is the function for it: it is the one
 * that already re-derives a plan from stored keys rather than a provider
 * profile, and its rules carry over intact, including that it consults only
 * immutableKeys so an address that has changed hands since sign-in cannot
 * resolve a stranger's plan onto this session.
 *
 * The bound is ACCESS_TOKEN_TTL_SECONDS deliberately: the same staleness a
 * bearer token already has on /mcp. One number for the system rather than two,
 * and a revoked grant cannot outlive on the panel what it outlives on the tool
 * surface.
 */
async function sessionCaller(
  request: Request,
  config: OAuthConfig
): Promise<{
  identity: Identity; planSource: string; planKey?: string | null; subjectKey: string | null; identityKeys: string[]; via: "cookie";
} | null> {
  // The allowlist is what grants browser authentication at all. Without this a
  // deploy that forgot BELLMAN_PANEL_ORIGINS would still accept cookies while
  // serving no CORS — a session usable by anything that is not a browser.
  if (!config.panelOrigins?.length) return null;

  const secure = new URL(config.issuer).protocol === "https:";
  const id = readSessionCookie(request, secure);
  if (!id) return null;

  const now = Date.now();
  const stored = await config.store.touchSession(id, now);
  if (!stored) return null;
  // Read from the keys and not from userId, which an operator override may have
  // set to anything (u_jesse). The subject is the key an admin grants a plan to.
  const subjectKey = immutableKeys(stored.identity_keys)[0] ?? null;

  if (now - replannedAt(stored) <= ACCESS_TOKEN_TTL_SECONDS * 1000) {
    return {
      identity: stored.identity, planSource: stored.plan_source, planKey: stored.plan_key, subjectKey,
      identityKeys: stored.identity_keys, via: "cookie",
    };
  }

  let current: Awaited<ReturnType<typeof replanOnRefresh>>;
  try {
    current = await replanOnRefresh(stored.identity, stored.identity_keys, config);
  } catch (err) {
    // The session ends here (SSO spec, D13; SCIM spec, D4): the person signs in again through their
    // organisation's IdP, or not at all.
    if (err instanceof SignInRefused) {
      await config.store.deleteSession(id).catch((e) => console.error("could not end a session the org closed:", e));
      return null;
    }
    throw err;
  }
  // Written back so the next request inside the window is served from the
  // record rather than re-resolving again.
  //
  // replanSession, not putSession. Re-resolving can await the registry, so a
  // sign-out can land between the touch above and this write, and putSession
  // would write `stored` back whole and recreate the session the human just
  // ended. replanSession merges the four fields into what is stored now and
  // does nothing if the record is gone. Merging also leaves alone a
  // last_used_at that another request bumped in the same gap, which a
  // whole-record write would revert.
  //
  // Its answer is acted on. False means the record is gone, because the human
  // signed out or the session was swept as dead, and either way there is no
  // session, so this request is refused rather than finished. It began before
  // the sign-out, and letting an in-flight request finish is ordinary
  // elsewhere, but the reason to store a session at all is that sign-out takes
  // effect now, and one more authenticated response after it gives that back.
  // The window is small: this path runs about once per ACCESS_TOKEN_TTL_SECONDS
  // per session.
  //
  // A write that fails is a different thing. It costs a repeated
  // re-resolution, not a wrong answer, and says nothing about whether the
  // session is still there, so it must not cost the human their session.
  let merged = true;
  try {
    merged = await config.store.replanSession(id, current.identity, current.source, current.key, now);
  } catch (err) {
    console.error("could not store a re-resolved panel session:", err);
  }
  if (!merged) return null;
  return {
    identity: current.identity, planSource: current.source, planKey: current.key, subjectKey,
    identityKeys: stored.identity_keys, via: "cookie",
  };
}

async function issueTokens(
  config: OAuthConfig,
  clientId: string,
  resource: string,
  identity: Identity,
  planSource = "default",
  identityKeysForRefresh: string[] = []
): Promise<Response> {
  const body = await accessTokenBody(config, resource, identity, planSource);
  // Rotated on every use: the previous one was deleted when it was taken.
  // Storing it is also what promotes the client out of being a disposable
  // registration — putRefresh does both in one operation, so a failure here
  // cannot leave a permanent client behind with no token to show for it.
  const refreshToken = randomId();
  await config.store.putRefresh(refreshToken, {
    client_id: clientId,
    resource,
    identity,
    plan_source: planSource,
    identity_keys: identityKeysForRefresh,
    expires_at: Date.now() + REFRESH_TOKEN_TTL_MS,
  });
  return json({ ...body, refresh_token: refreshToken });
}

/** The access-token half of a token response: every grant mints this; only some add a refresh token. */
async function accessTokenBody(
  config: OAuthConfig,
  resource: string,
  identity: Identity,
  planSource: string
): Promise<{ access_token: string; token_type: "Bearer"; expires_in: number; scope: string }> {
  const accessToken = await signJwt(
    { iss: config.issuer, sub: identity.userId, aud: resource, bellman: identity, plan_source: planSource },
    config.secret,
    ACCESS_TOKEN_TTL_SECONDS
  );
  return { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_SECONDS, scope: SCOPE };
}

/**
 * Resolve an access token presented to a resource: /mcp's unless another canonical resource is named. Audience is
 * checked here, so a token minted for one resource is refused at the other.
 */
export async function identityFromAccessToken(
  token: string,
  config: Pick<OAuthConfig, "issuer" | "resource" | "secret">,
  audience = config.resource
): Promise<Identity | null> {
  const claims = await verifyJwt(token, config.secret, { issuer: config.issuer, audience });
  return (claims?.bellman as Identity | undefined) ?? null;
}

const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

const resourcesOf = (config: Pick<OAuthConfig, "resource" | "resources">) => config.resources ?? [config.resource];

/**
 * RFC 9728: a 401 points the client at the metadata that starts the dance. /mcp's is the bare path, as it has always
 * been; /a2a's is its own (section 3.1).
 */
export function unauthorizedHeaders(config: Pick<OAuthConfig, "issuer">, resource: "/mcp" | "/a2a" = "/mcp"): Record<string, string> {
  return {
    "www-authenticate":
      `Bearer resource_metadata="${config.issuer}${PROTECTED_RESOURCE_PATH}${resource === "/a2a" ? "/a2a" : ""}"`,
  };
}
