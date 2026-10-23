/**
 * The SCIM routes (SCIM spec, D5 to D9): what an org's identity provider calls to push, update and deactivate
 * the org's members. The org's token is the only credential, hashed and looked up in the registry (D1), and the
 * org it names is the org every path operates on: there is no caller, no cookie, no CORS, since a browser never
 * calls this. The order every path refuses in: 404 for a path outside the surface, 405 with `Allow` for a method
 * the path lacks, 401 for no or an unknown token, then the body, then the store.
 *
 * A deactivation's room walk (D6) runs after the registry has answered and before the response: the IdP's call
 * is the only thing that runs it, and a repeat of the call finishes a walk cut short.
 */
import { scimIntent } from "../grant-audit.js";
import { sha256Base64url, randomId } from "../oauth/tokens.js";
import { parseSsoKey } from "../oauth/providers.js";
import { userIdForKey } from "../orgs.js";
import { parseFilter } from "../scim/filter.js";
import { applyOperations, readUser } from "../scim/patch.js";
import { listResponse, resourceTypes, schemas, scimError, scimJson, serviceProviderConfig, userResource } from "../scim/resource.js";
import { departedRooms, scimIdentity, thawRooms } from "../scim/rooms.js";
import type { BellmanStore, ScimUpdate } from "../store.js";
import type { ScimUser, ScimUserPatch } from "../types.js";

export type ScimRouteDeps = { store: BellmanStore };

// ponytail: 16 KB, not tuned. A pushed User is a few hundred bytes; Entra's largest carries a dozen attributes.
export const MAX_SCIM_BODY_BYTES = 16 * 1024;
/** The most a list answers at once, and what ServiceProviderConfig says. */
export const SCIM_PAGE_MAX = 200;
// ponytail: a list is cut from a scan of this many of the org's rows, so an org with more SCIM users pages wrong
// past it; a counter row and a cursor are the upgrade.
const LIST_SCAN = 1000;

const PREFIX = "/scim/v2";
const USER = /^\/Users\/([^/]+)$/;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The body as a JSON object under the bound, or the refusal. Read as JSON whatever the content type says. */
async function readBody(request: Request): Promise<Record<string, unknown> | Response> {
  const length = request.headers.get("content-length");
  if (length !== null && !/^\d+$/.test(length)) return scimError(400, "Content-Length must be a non-negative integer", "invalidSyntax");
  if (Number(length ?? "0") > MAX_SCIM_BODY_BYTES) return scimError(413, `a body is at most ${MAX_SCIM_BODY_BYTES} bytes`);
  const parsed: unknown = await request.text().then((text) => JSON.parse(text) as unknown).catch(() => undefined);
  return isObject(parsed) ? parsed : scimError(400, "the body must be a JSON object", "invalidSyntax");
}

/** `undefined` for a path outside `/scim/v2`, so the Worker carries on; everything under it is answered here. */
export async function scimRoutes(request: Request, deps: ScimRouteDeps): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return undefined;
  const base = `${url.origin}${PREFIX}`;
  const rest = path.slice(PREFIX.length);
  try {
    const user = USER.exec(rest);
    const route = rest === "/ServiceProviderConfig" ? "config" : rest === "/ResourceTypes" ? "types" : rest === "/Schemas" ? "schemas"
      : rest === "/Users" ? "users" : user ? "user" : rest === "/Groups" ? "groups" : undefined;
    if (!route) return scimError(404, "no such route");
    const allow = { config: "GET", types: "GET", schemas: "GET", users: "GET, POST", user: "GET, PUT, PATCH, DELETE", groups: "GET" }[route];
    if (!allow.split(", ").includes(request.method)) {
      // A pushed group would have to mean something, and roles are not settled (#56): said as such, not as a method the path lacks.
      if (route === "groups" && request.method !== "OPTIONS") return scimError(501, "groups are not managed here; roles are set in Bellman");
      return scimJson(405, { schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "405", detail: `this path takes ${allow}` }, { allow });
    }

    const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const orgId = bearer ? await deps.store.orgForScimToken(await sha256Base64url(bearer)) : undefined;
    if (!orgId) return scimError(401, "send the org's SCIM token as a bearer token");
    const intent = scimIntent(orgId);
    const now = Date.now();
    const answer = (status: number, u: ScimUser, headers: Record<string, string> = {}) => scimJson(status, userResource(u, base), headers);
    const full = async () => {
      const org = await deps.store.getOrg(orgId);
      const used = await deps.store.countOrgMembers(orgId);
      return scimError(409, `this org holds ${used} of ${org?.seats ?? used} seats`);
    };

    if (route === "config") return scimJson(200, serviceProviderConfig(base));
    if (route === "types") return scimJson(200, resourceTypes(base));
    if (route === "schemas") return scimJson(200, schemas(base));
    if (route === "groups") return scimJson(200, listResponse([], 0, 1));

    if (route === "users") {
      if (request.method === "GET") {
        const filter = url.searchParams.get("filter");
        const startIndex = Math.max(1, Number(url.searchParams.get("startIndex") ?? "1") || 1);
        const count = Math.min(SCIM_PAGE_MAX, Math.max(0, Number(url.searchParams.get("count") ?? "100") || 0));
        let found: ScimUser[];
        if (filter === null) {
          found = await deps.store.listScimUsers(orgId, LIST_SCAN);
        } else {
          const parsed = parseFilter(filter);
          if ("error" in parsed) return scimError(400, parsed.error, "invalidFilter");
          if (parsed.attribute === "userName") {
            const one = await deps.store.scimUserByName(orgId, parsed.value);
            found = one ? [one] : [];
          } else {
            found = (await deps.store.listScimUsers(orgId, LIST_SCAN)).filter((u) => u.externalId === parsed.value);
          }
        }
        const page = found.slice(startIndex - 1, startIndex - 1 + count);
        return scimJson(200, listResponse(page.map((u) => userResource(u, base)), found.length, startIndex));
      }
      const body = await readBody(request);
      if (body instanceof Response) return body;
      const read = readUser(body);
      if ("error" in read) return scimError(400, read.error, "invalidValue");
      const made = await deps.store.createScimUser({
        id: randomId(16), orgId, userName: read.userName, externalId: read.externalId, active: read.active,
        key: `email:${read.userName}`, createdAt: now, updatedAt: now, deletedAt: null,
      }, intent);
      if (made.outcome !== "written" && made.outcome !== "linked") {
        if (made.outcome === "exists") return scimError(409, "a user with that userName exists", "uniqueness");
        if (made.outcome === "conflict") return scimError(409, "that address is a member of another org");
        if (made.outcome === "full") return full();
        return scimError(404, "this org has no record");
      }
      // Pushed as inactive onto a seat a sign-in had given (Entra pushes disabled accounts so): the deactivation's walk.
      if (!made.user.active) await rooms(deps.store, orgId, { ...made.user, active: true }, made.user, now);
      return answer(201, made.user, { location: `${base}/Users/${made.user.id}` });
    }

    // /Users/:id
    const id = decodeURIComponent(user![1]);
    if (request.method === "GET") {
      const found = await deps.store.getScimUser(orgId, id);
      return found ? answer(200, found) : scimError(404, "no such user");
    }
    if (request.method === "DELETE") {
      // A repeat answers the tombstone and walks again: that is how a walk cut short is finished.
      const was = await deps.store.deleteScimUser(orgId, id, now, intent);
      if (!was) return scimError(404, "no such user");
      await rooms(deps.store, orgId, { ...was, active: true }, { ...was, active: false }, now);
      return new Response(null, { status: 204 });
    }
    const body = await readBody(request);
    if (body instanceof Response) return body;
    let patch: ScimUserPatch;
    if (request.method === "PUT") {
      const read = readUser(body);
      if ("error" in read) return scimError(400, read.error, "invalidValue");
      patch = read;
    } else {
      const applied = applyOperations(body.Operations);
      if ("error" in applied) return scimError(400, applied.error, applied.scimType);
      patch = applied;
    }
    const updated: ScimUpdate = await deps.store.updateScimUser(orgId, id, patch, now, intent);
    if (updated.outcome !== "updated") {
      if (updated.outcome === "missing") return scimError(404, "no such user");
      if (updated.outcome === "exists") return scimError(409, "another user holds that userName", "uniqueness");
      if (updated.outcome === "conflict") return scimError(409, "that address is a member of another org");
      return full();
    }
    await rooms(deps.store, orgId, updated.was, updated.user, now);
    return answer(200, updated.user);
  } catch (err) {
    console.error(`${request.method} ${path} failed:`, err);
    return scimError(500, "the request failed on the server; repeating it is safe");
  }
}

/**
 * The rooms, after the registry has answered (D6, D7): a deactivation leaves every room and freezes the rooms
 * they created, a reactivation thaws them. A repeat of a deactivation walks again, which is how a walk cut short
 * is finished. A key no sign-in has claimed names nobody and has no rooms.
 */
async function rooms(store: BellmanStore, orgId: string, was: ScimUser, user: ScimUser, now: number): Promise<void> {
  const userId = userIdForKey(user.key);
  if (userId === null) return;
  // Every room for the IdP's own subject, whose sign-in is over; the org's rooms alone for a personal account.
  const scope = { orgId, everywhere: parseSsoKey(user.key)?.orgId === orgId };
  if (!user.active) await departedRooms(store, userId, scimIdentity(orgId), now, scope);
  else if (!was.active) await thawRooms(store, userId, scimIdentity(orgId), now, scope);
}
