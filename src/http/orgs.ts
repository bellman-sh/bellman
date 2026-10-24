/**
 * The org routes (orgs spec, D6): an org's record for its members, and its roster for its admins,
 * who seat or invite a teammate by a stable identity key, change a role, and remove a member or
 * withdraw an invite. On the audit
 * routes' rules: `deps.caller` (a bearer token or the panel's cookie), CORS for the panel's origins,
 * the same preflight, the CSRF check on every write a cookie makes, one JSON error shape, and the
 * org always the caller's own, never a parameter.
 *
 * A member here is a grant whose `orgId` is this org (D2), written through the guarded grant write
 * that counts the seats (D3) and audits in the same operation. A seat an admin gives takes effect only
 * for an identity the org owns by its form, its own IdP's subjects and addresses on its verified domains
 * (ADR 0027); anyone else is invited, apart from the grants, and becomes a member only by accepting at
 * a sign-in. The roster lists both, each with its status. A purchased admin writes here: a grant
 * in a recorded org resolves to free the moment the org stops paying (D5), can only be `team` in the
 * admin's own org, and is counted against the seats the subscription bought, which is what keeps
 * `/admin/grants` closed to them and this open.
 *
 * The order every path refuses in: the preflight, 401 with no caller, the CSRF refusal for a write,
 * the role (an org on the identity for `GET /org`; `auditRefusal`'s three for everything else), then
 * `404 no_org` for an org with no record, and only then the body.
 */
import { auditRefusal } from "../audit.js";
import { grantKeyForUser } from "../billing/grants.js";
import { allowedOrigin, corsHeaders, csrfRefusal, preflightResponse } from "../oauth/browser.js";
import { domainVerified, isDomain, newDomainToken, verificationRecord } from "../oauth/dns.js";
import { discover } from "../oauth/oidc.js";
import { isStableIdentityKey, parseSsoKey } from "../oauth/providers.js";
import { seal } from "../oauth/sealed.js";
import { randomId, sha256Base64url } from "../oauth/tokens.js";
import { INVITE_TTL_MS, MAX_ORG_NAME_CHARS, MAX_PENDING_INVITES, inviteLive, isUnownedSeat, orgView, ownsByForm, parseOrgName, parsePolicyPatch, userIdForKey } from "../orgs.js";
import type { AuditIntent } from "../store.js";
import type { Org, OrgIdp, OrgInvite, PlanGrant, Role } from "../types.js";
import { json, lengthRefusal, methodNotAllowed, problem, type RoomRouteDeps } from "./rooms.js";

export type OrgRouteDeps = Pick<RoomRouteDeps, "store" | "caller" | "panelOrigins"> & {
  /** What seals an IdP's client secret (SSO spec, D14): BELLMAN_SEAL_SECRET, else the token secret. Absent, no IdP can be saved. */
  sealSecret?: string;
  /** For discovery and the resolver; the tests hand in a fake. */
  fetchImpl?: typeof fetch;
};

// ponytail: a client secret is at most 1 KB; Okta's and Entra's are under 100 characters.
export const MAX_CLIENT_SECRET_CHARS = 1024;

// ponytail: 4 KB, not tuned. A body here is a key and a role, or a name of at most 80 characters.
export const MAX_ORG_WRITE_BYTES = 4096;

const ORG = "/org";
const MEMBERS = "/org/members";
const MEMBER = /^\/org\/members\/([^/]+)$/;
const IDP = "/org/idp";
const DOMAINS = "/org/domains";
const DOMAIN = /^\/org\/domains\/([^/]+)$/;
const VERIFY = /^\/org\/domains\/([^/]+)\/verify$/;
const SCIM = "/org/scim";
const SCIM_TOKEN = "/org/scim/token";

/** A member as the roster shows one (D2): the grant, with the user id its key names and whether it is the owner's. */
export interface MemberView {
  key: string;
  /** Derived from a provider subject; null for an address no sign-in has claimed onto one yet. */
  user_id: string | null;
  role: Role;
  plan: PlanGrant["plan"];
  source: string;
  granted_at: string;
  expires_at: string | null;
  owner: boolean;
  status: "member";
}

/** An invite as the roster shows one (ADR 0027): a seat offered and not taken, so no plan, no grant and no seat yet. */
export interface InviteView {
  key: string;
  user_id: string | null;
  /** The role the grant will carry if the person accepts. */
  role: Role;
  /** `expired` once its fourteen days have passed (ADR 0036, D3): it seats nobody, and the admin resends or withdraws it. */
  status: "invited" | "expired";
  invited_at: string;
  invited_by: string;
  /** Null for a seat on an address the org no longer owns by its form, which does not lapse. */
  expires_at: string | null;
}

const iso = (at: number): string => new Date(at).toISOString();

/** Whether a key is the owner's: the one grant nobody demotes or removes (D1). */
const isOwner = (key: string, org: Org): boolean => key === grantKeyForUser(org.ownerUserId);

export function memberView(grant: PlanGrant, org: Org): MemberView {
  return {
    key: grant.key,
    user_id: userIdForKey(grant.key),
    role: grant.role,
    plan: grant.plan,
    source: grant.source,
    granted_at: iso(grant.grantedAt),
    expires_at: grant.expiresAt === null ? null : iso(grant.expiresAt),
    owner: isOwner(grant.key, org),
    status: "member",
  };
}

export function inviteView(invite: OrgInvite, now = Date.now()): InviteView {
  return {
    key: invite.key, user_id: userIdForKey(invite.key), role: invite.role, status: inviteLive(invite, now) ? "invited" : "expired",
    invited_at: iso(invite.invitedAt), invited_by: invite.invitedBy,
    expires_at: Number.isFinite(invite.expiresAt) ? iso(invite.expiresAt) : null,
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The body as a JSON object under the bound, or the refusal. */
async function readBody(request: Request, origin: string | undefined): Promise<Record<string, unknown> | Response> {
  const refused = lengthRefusal(request, MAX_ORG_WRITE_BYTES, "an org write", origin);
  if (refused) return refused;
  const parsed: unknown = await request.json().catch(() => undefined);
  return isObject(parsed) ? parsed : problem(400, "invalid_request", "body must be a JSON object", origin);
}

const parseRole = (value: unknown): Role | undefined => (value === "member" || value === "admin" ? value : undefined);

/** The IdP as its admin sees it (SSO spec, D9, D14): everything but the secret, which is only ever "set". */
function idpView(idp: OrgIdp) {
  return {
    protocol: idp.protocol, issuer: idp.issuer, client_id: idp.clientId, client_secret_set: true, token_auth: idp.tokenAuth,
    authorization_endpoint: idp.authorizationEndpoint, token_endpoint: idp.tokenEndpoint, userinfo_endpoint: idp.userinfoEndpoint,
    configured_at: iso(idp.configuredAt), configured_by: idp.configuredBy,
  };
}

const hasVerifiedDomain = (org: Org): boolean => org.domains.some((d) => d.verifiedAt !== null);

/** The refusal of `require_sso` (D13): it needs the IdP and a verified domain, or members would be locked out of everything. */
const SSO_NEEDS = "single sign-on needs an IdP and a verified domain";

/** A domain path segment, as the claim stored it: lowercase, and nothing to percent-decode. */
const domainSegment = (segment: string): string | undefined => {
  const domain = segment.toLowerCase();
  return isDomain(domain) ? domain : undefined;
};

/** `409 full`, with the numbers the admin needs to act on it (D3). */
const full = (org: Org, used: number, origin: string | undefined) =>
  json(409, { error: "full", error_description: `this org holds ${used} of ${org.seats} seats`, seats: org.seats, seats_used: used }, origin);

/** `undefined` for a path outside `/org`, so the Worker carries on; everything under it is answered here. */
export async function orgRoutes(request: Request, deps: OrgRouteDeps): Promise<Response | undefined> {
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  if (path !== ORG && !path.startsWith("/org/")) return undefined;
  const origin = allowedOrigin(request, deps.panelOrigins);
  if (request.method === "OPTIONS") return preflightResponse(origin);
  try {
    const member = MEMBER.exec(path);
    const verify = VERIFY.exec(path);
    const domain = verify ? null : DOMAIN.exec(path);
    const known = path === ORG || path === MEMBERS || path === IDP || path === DOMAINS || path === SCIM || path === SCIM_TOKEN || member || domain || verify;
    if (!known) return problem(404, "not_found", "no such route", origin);
    const allow = path === ORG ? "GET, PATCH"
      : path === MEMBERS ? "GET, POST"
        : path === IDP ? "GET, PUT, DELETE"
          : path === DOMAINS || verify ? "POST"
            : path === SCIM ? "GET"
              : path === SCIM_TOKEN ? "POST, DELETE"
                : domain ? "DELETE" : "PATCH, DELETE";
    if (!allow.split(", ").includes(request.method)) return methodNotAllowed(allow, origin);

    const who = await deps.caller(request);
    if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
    const refusal = csrfRefusal(request, who.via, origin);
    if (refusal) return refusal;
    const { identity } = who;
    // A member reads the record; everything else is an admin's, in `bellman_audit`'s words, which
    // with D5 means the org is active: an inactive org's admin reads it and can change nothing.
    const refused = path === ORG && request.method === "GET"
      ? (identity.orgId ? null : "your identity has no org.")
      : auditRefusal(identity);
    if (refused) return problem(403, "forbidden", refused, origin);
    const orgId = identity.orgId as string;
    const org = await deps.store.getOrg(orgId);
    if (!org) return problem(404, "no_org", "this org has no record yet; the operator creates one", origin);
    const intent: AuditIntent = { actorUserId: identity.userId, actorLabel: identity.label, actorOrgId: identity.orgId };

    if (path === ORG) {
      if (request.method === "GET") return json(200, orgView(org, await deps.store.countOrgMembers(orgId), identity.role), origin);
      const body = await readBody(request, origin);
      if (body instanceof Response) return body;
      // The name, the SSO switch and the policy are what an admin changes here. A stray field is a
      // mistake answered, not ignored: `seats` is the operator's (D7) and `active` is billing's (D5).
      const stray = Object.keys(body).find((field) => field !== "name" && field !== "require_sso" && field !== "policy");
      if (stray !== undefined) return problem(400, "invalid_request", `${stray} is not a field of PATCH /org`, origin);
      const name = body.name === undefined ? undefined : parseOrgName(body.name);
      if (body.name !== undefined && name === undefined) return problem(400, "invalid_request", `name must be 1 to ${MAX_ORG_NAME_CHARS} characters`, origin);
      if (body.require_sso !== undefined && typeof body.require_sso !== "boolean") return problem(400, "invalid_request", "require_sso must be true or false", origin);
      const requireSso = body.require_sso as boolean | undefined;
      const policy = body.policy === undefined ? undefined : parsePolicyPatch(body.policy);
      if (policy && "error" in policy) return problem(400, "invalid_request", policy.error, origin);
      if (name === undefined && requireSso === undefined && policy === undefined) {
        return problem(400, "invalid_request", "give a name, require_sso, policy, or any of them", origin);
      }
      // Turning the switch on with nothing to sign in through would lock every member out (D13).
      if (requireSso === true && (!hasVerifiedDomain(org) || !(await deps.store.getOrgIdp(orgId)))) {
        return problem(409, "require_sso", SSO_NEEDS, origin);
      }
      const updated = await deps.store.updateOrg(orgId, { name, requireSso, policy: policy?.patch }, intent);
      if (!updated) return problem(404, "no_org", "this org has no record yet; the operator creates one", origin);
      return json(200, orgView(updated, await deps.store.countOrgMembers(orgId), identity.role), origin);
    }

    // The org's SCIM token (SCIM spec, D1): what its admin pastes into Okta or Entra beside the base URL. Only its
    // hash is stored, so it is shown once, here; issuing again replaces it, and the old one stops at the commit.
    const baseUrl = `${new URL(request.url).origin}/scim/v2`;
    if (path === SCIM) {
      const token = await deps.store.scimTokenOf(orgId);
      return json(200, {
        base_url: baseUrl, token_set: token !== undefined, issued_at: token ? iso(token.issuedAt) : null, issued_by: token?.issuedBy ?? null,
      }, origin);
    }
    if (path === SCIM_TOKEN) {
      if (request.method === "DELETE") {
        const outcome = await deps.store.revokeScimToken(orgId, intent);
        if (outcome === "missing") return problem(404, "not_found", "this org has no SCIM token", origin);
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
      }
      const token = `bst_${randomId(32)}`;
      const issuedAt = Date.now();
      const outcome = await deps.store.issueScimToken(orgId, { tokenHash: await sha256Base64url(token), issuedAt, issuedBy: identity.userId }, intent);
      if (outcome === "missing") return problem(404, "no_org", "this org has no record yet; the operator creates one", origin);
      return json(201, { token, issued_at: iso(issuedAt), issued_by: identity.userId, base_url: baseUrl, replaced: outcome === "replaced" }, origin);
    }

    if (path === IDP) {
      if (request.method === "GET") {
        const idp = await deps.store.getOrgIdp(orgId);
        return json(200, { idp: idp ? idpView(idp) : null }, origin);
      }
      if (request.method === "DELETE") {
        // With the switch on, the IdP is what everyone signs in through (D13): the switch goes off first.
        if (org.requireSso) return problem(409, "require_sso", "turn single sign-on off before removing the IdP", origin);
        const outcome = await deps.store.deleteOrgIdp(orgId, intent);
        if (outcome === "missing") return problem(404, "not_found", "this org has no IdP", origin);
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
      }
      const body = await readBody(request, origin);
      if (body instanceof Response) return body;
      if (typeof body.issuer !== "string" || !body.issuer) return problem(400, "invalid_request", "issuer must be the IdP's https issuer URL", origin);
      if (typeof body.client_id !== "string" || !body.client_id || body.client_id.length > 256) return problem(400, "invalid_request", "client_id must be 1 to 256 characters", origin);
      if (typeof body.client_secret !== "string" || !body.client_secret || body.client_secret.length > MAX_CLIENT_SECRET_CHARS) {
        return problem(400, "invalid_request", `client_secret must be 1 to ${MAX_CLIENT_SECRET_CHARS} characters`, origin);
      }
      if (!deps.sealSecret) return problem(503, "unconfigured", "this server has no secret to seal an IdP's secret with", origin);
      // Discovery runs once, here (D9): the endpoints it finds are what every sign-in uses, and what it cannot use is said now.
      const found = await discover(body.issuer, deps.fetchImpl);
      if ("error" in found) return problem(400, "discovery", found.error, origin);
      const idp: OrgIdp = {
        protocol: "oidc", ...found, clientId: body.client_id, clientSecret: await seal(deps.sealSecret, body.client_secret),
        configuredAt: Date.now(), configuredBy: identity.userId,
      };
      const outcome = await deps.store.putOrgIdp(orgId, idp, intent);
      if (outcome === "missing") return problem(404, "no_org", "this org has no record yet; the operator creates one", origin);
      return json(200, { idp: idpView(idp) }, origin);
    }

    if (path === DOMAINS) {
      const body = await readBody(request, origin);
      if (body instanceof Response) return body;
      const claimed = typeof body.domain === "string" ? domainSegment(body.domain) : undefined;
      if (claimed === undefined) return problem(400, "invalid_request", "domain must be a hostname, such as acme.com", origin);
      const token = newDomainToken();
      const outcome = await deps.store.claimDomain(orgId, claimed, token, Date.now(), intent);
      if (outcome === "exists") return problem(409, "exists", "this org already claims that domain; verify it, or release it first", origin);
      if (outcome === "missing") return problem(404, "no_org", "this org has no record yet; the operator creates one", origin);
      return json(201, { domain: claimed, verified_at: null, record: verificationRecord(claimed, token) }, origin);
    }

    if (verify || domain) {
      const name = domainSegment((verify ?? domain)![1]);
      const claim = name === undefined ? undefined : org.domains.find((d) => d.domain === name);
      if (name === undefined || !claim) return problem(404, "not_found", "this org has no such domain claim", origin);
      if (domain) {
        // The last verified domain while the switch is on is what routes every member's sign-in (D13).
        if (org.requireSso && claim.verifiedAt !== null && org.domains.filter((d) => d.verifiedAt !== null).length === 1) {
          return problem(409, "require_sso", "turn single sign-on off before releasing its last verified domain", origin);
        }
        const outcome = await deps.store.releaseDomain(orgId, name, intent);
        if (outcome === "unknown") return problem(404, "not_found", "this org has no such domain claim", origin);
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
      }
      let proof: Awaited<ReturnType<typeof domainVerified>>;
      try {
        proof = await domainVerified(name, claim.token, deps.fetchImpl);
      } catch (err) {
        // The resolver's failure is its own answer, never "unverified": the record may well be there.
        console.error(`verifying ${name} for ${orgId}: the resolver failed:`, err);
        return problem(502, "dns", "the resolver could not be asked; try again shortly", origin);
      }
      if (!proof.verified) {
        const record = verificationRecord(name, claim.token);
        return json(409, {
          error: "unverified", error_description: `no TXT record at ${record.name} carries ${record.value}`, found: proof.found,
        }, origin);
      }
      const outcome = await deps.store.verifyDomain(orgId, name, Date.now(), intent);
      if (outcome === "taken") return problem(409, "taken", "another org has verified that domain", origin);
      if (outcome === "unknown") return problem(404, "not_found", "this org has no such domain claim", origin);
      const verified = (await deps.store.getOrg(orgId))?.domains.find((d) => d.domain === name)?.verifiedAt ?? Date.now();
      return json(200, { domain: name, verified_at: iso(verified) }, origin);
    }

    if (path === MEMBERS) {
      if (request.method === "GET") {
        // ponytail: two hundred members a read, the bound `/admin/grants` reads with, and no paging.
        const grants = await deps.store.listGrants(200, orgId);
        const invites = await deps.store.listOrgInvites(orgId, MAX_PENDING_INVITES);
        // A seat on an address the org no longer owns by its form takes no effect until the person accepts it
        // (ADR 0027), so it is listed as the invite it now is; it still holds its seat, and DELETE removes it.
        const listed = grants.map((grant) => isUnownedSeat(grant, org)
          ? inviteView({ orgId, key: grant.key, role: grant.role, invitedBy: grant.grantedBy, invitedAt: grant.grantedAt, expiresAt: Infinity })
          : memberView(grant, org));
        return json(200, { members: [...listed, ...invites.map((invite) => inviteView(invite))] }, origin);
      }
      const body = await readBody(request, origin);
      if (body instanceof Response) return body;
      if (typeof body.key !== "string" || !isStableIdentityKey(body.key)) {
        return problem(400, "invalid_request",
          "key must be github:<numeric id>, google:<numeric id>, or an email address (github:, google: or email:) — a username or display name can be reassigned", origin);
      }
      // An sso key names its org (SSO spec, D10): seated here, a person of another org would sign in
      // through their own IdP and land in this one, with their own admin unable to see why.
      const sso = parseSsoKey(body.key);
      if (sso && sso.orgId !== orgId) return problem(400, "invalid_request", "that key names an IdP subject of another org", origin);
      const role = parseRole(body.role);
      if (role === undefined) return problem(400, "invalid_request", "role must be member or admin", origin);
      // Seating is create-only. The owner's grant is nobody's to rewrite here: seating them again as
      // a member would demote them and turn a purchase grant into an org one, which billing would then
      // refuse to touch. A member already seated is changed through PATCH, which keeps the grant's
      // source and expiry. Read-then-write, since the owner's key is a stable fact of the record and
      // two admins seating one key at once can only agree.
      if (isOwner(body.key, org)) return problem(409, "owner", "the owner stays an admin and cannot be re-seated", origin);
      // A person the IdP pushed and then deactivated or deleted comes back through the IdP (SCIM spec, D10): seated
      // here, they would hold a seat the sign-in keeps refusing.
      const managed = body.key.startsWith("email:")
        ? await deps.store.scimUserByName(orgId, body.key.slice("email:".length).toLowerCase()) ?? await deps.store.scimUserByKey(`email:${body.key.slice("email:".length).toLowerCase()}`)
        : await deps.store.scimUserByKey(body.key);
      if (managed && managed.orgId === orgId) {
        return problem(409, "managed", "this address is provisioned by your identity provider; assign them there", origin);
      }
      const seated = await deps.store.getGrant(body.key);
      if (seated && seated.orgId === orgId) {
        return problem(409, "exists", "that key is already a member; change its role with PATCH /org/members/:key", origin);
      }
      // A seat takes effect without the person only for an identity the org owns by its form (ADR 0027).
      // Anyone else is offered one: an invite, apart from the grants, that nothing resolves a plan, an org
      // or a refusal from, and that becomes their grant only when they accept it at a sign-in. Whether the
      // key holds another org's grant is not asked here, so an invite says nothing of the person to the admin.
      if (!ownsByForm(org, body.key)) {
        const now = Date.now();
        const invite: OrgInvite = { orgId, key: body.key, role, invitedBy: identity.userId, invitedAt: now, expiresAt: now + INVITE_TTL_MS };
        const invited = await deps.store.putOrgInvite(invite, intent);
        if (invited === "exists") {
          return problem(409, "exists", "that key is already invited; withdraw it with DELETE /org/members/:key to change the role", origin);
        }
        if (invited === "limit") return problem(409, "limit", `this org has ${MAX_PENDING_INVITES} pending invites; withdraw one first`, origin);
        if (invited === "no_org") return problem(404, "no_org", "this org has no record yet; the operator creates one", origin);
        // 202: the seat is offered, not taken. The person's answer is what seats them.
        return json(202, { member: inviteView(invite) }, origin);
      }
      // What the body says of plan, org, source or expiry is not read: a member of this org is a
      // team grant in this org, from this org, that lapses with the org and not on a date.
      const grant: PlanGrant = {
        key: body.key, plan: "team", role, orgId, source: "org", grantedAt: Date.now(), grantedBy: identity.userId, expiresAt: null,
      };
      const outcome = await deps.store.putGrantIfOwned(grant, orgId, intent);
      if (outcome === "conflict") return problem(409, "conflict", "that key already has a grant in another org", origin);
      if (outcome === "full") return full(org, await deps.store.countOrgMembers(orgId), origin);
      return json(201, { member: memberView(grant, org) }, origin);
    }

    // /org/members/:key
    let key: string;
    try {
      key = decodeURIComponent(member![1]);
    } catch {
      return problem(400, "invalid_request", "the path's key is not a valid percent-encoding", origin);
    }
    // The owner's grant is not this route's to touch, in either direction: they stay an admin (D1).
    if (isOwner(key, org)) return problem(409, "owner", "the owner stays an admin and cannot be removed", origin);
    const existing = await deps.store.getGrant(key);
    if (!existing || existing.orgId !== orgId) {
      // No member by that key: a DELETE may still withdraw this org's invite of it (ADR 0027).
      if (request.method === "DELETE" && (await deps.store.deleteOrgInvite(orgId, key, intent)) === "deleted") {
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
      }
      return problem(404, "not_found", "no such member in your org", origin);
    }
    if (request.method === "DELETE") {
      // A member the IdP pushed is the IdP's to remove (SCIM spec, D10): removed here, the next sync would seat
      // them again, and the roster would read as members reappearing. Their role stays Bellman's to change.
      const managed = await deps.store.scimUserByKey(key);
      if (managed?.active && managed.orgId === orgId) {
        return problem(409, "managed", "this member is provisioned by your identity provider; remove them there", origin);
      }
      // Answered from what the delete removed, as /admin/grants is: a sign-in claiming the key in the gap is a 404, not a lie.
      const outcome = await deps.store.deleteGrantIfOwned(key, orgId, intent);
      if (outcome !== "deleted") return problem(404, "not_found", "no such member in your org", origin);
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    const body = await readBody(request, origin);
    if (body instanceof Response) return body;
    const role = parseRole(body.role);
    if (role === undefined) return problem(400, "invalid_request", "role must be member or admin", origin);
    // The role and nothing else: plan, source and expiry stay as the grant was written.
    const changed: PlanGrant = { ...existing, role };
    const outcome = await deps.store.putGrantIfOwned(changed, orgId, intent);
    if (outcome === "conflict") return problem(409, "conflict", "that key already has a grant in another org", origin);
    if (outcome === "full") return full(org, await deps.store.countOrgMembers(orgId), origin);
    return json(200, { member: memberView(changed, org) }, origin);
  } catch (err) {
    console.error(`${request.method} ${path} failed:`, err);
    return problem(500, "internal", "the request failed on the server", origin);
  }
}
