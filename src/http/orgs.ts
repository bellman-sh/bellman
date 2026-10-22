/**
 * The org routes (orgs spec, D6): an org's record for its members, and its roster for its admins,
 * who seat a teammate by any stable identity key, change a role, and remove a member. On the audit
 * routes' rules: `deps.caller` (a bearer token or the panel's cookie), CORS for the panel's origins,
 * the same preflight, the CSRF check on every write a cookie makes, one JSON error shape, and the
 * org always the caller's own, never a parameter.
 *
 * A member here is a grant whose `orgId` is this org (D2), written through the guarded grant write
 * that counts the seats (D3) and audits in the same operation. A purchased admin writes here: a grant
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
import { isStableIdentityKey } from "../oauth/providers.js";
import { MAX_ORG_NAME_CHARS, orgView, parseOrgName, userIdForKey } from "../orgs.js";
import type { AuditIntent } from "../store.js";
import type { Org, PlanGrant, Role } from "../types.js";
import { json, lengthRefusal, methodNotAllowed, problem, type RoomRouteDeps } from "./rooms.js";

export type OrgRouteDeps = Pick<RoomRouteDeps, "store" | "caller" | "panelOrigins">;

// ponytail: 4 KB, not tuned. A body here is a key and a role, or a name of at most 80 characters.
export const MAX_ORG_WRITE_BYTES = 4096;

const ORG = "/org";
const MEMBERS = "/org/members";
const MEMBER = /^\/org\/members\/([^/]+)$/;

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
    if (path !== ORG && path !== MEMBERS && !member) return problem(404, "not_found", "no such route", origin);
    const allow = path === ORG ? "GET, PATCH" : path === MEMBERS ? "GET, POST" : "PATCH, DELETE";
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
      // The name is the one field an admin changes here. A stray field is a mistake answered, not
      // ignored: `seats` is the operator's (D7) and `active` is billing's (D5).
      const stray = Object.keys(body).find((field) => field !== "name");
      if (stray !== undefined) return problem(400, "invalid_request", `${stray} is not a field of PATCH /org`, origin);
      const name = parseOrgName(body.name);
      if (name === undefined) return problem(400, "invalid_request", `name must be 1 to ${MAX_ORG_NAME_CHARS} characters`, origin);
      const updated = await deps.store.updateOrg(orgId, { name }, intent);
      if (!updated) return problem(404, "no_org", "this org has no record yet; the operator creates one", origin);
      return json(200, orgView(updated, await deps.store.countOrgMembers(orgId), identity.role), origin);
    }

    if (path === MEMBERS) {
      if (request.method === "GET") {
        // ponytail: two hundred members a read, the bound `/admin/grants` reads with, and no paging.
        const grants = await deps.store.listGrants(200, orgId);
        return json(200, { members: grants.map((grant) => memberView(grant, org)) }, origin);
      }
      const body = await readBody(request, origin);
      if (body instanceof Response) return body;
      if (typeof body.key !== "string" || !isStableIdentityKey(body.key)) {
        return problem(400, "invalid_request",
          "key must be github:<numeric id>, google:<numeric id>, or an email address (github:, google: or email:) — a username or display name can be reassigned", origin);
      }
      const role = parseRole(body.role);
      if (role === undefined) return problem(400, "invalid_request", "role must be member or admin", origin);
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
    if (!existing || existing.orgId !== orgId) return problem(404, "not_found", "no such member in your org", origin);
    if (request.method === "DELETE") {
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
