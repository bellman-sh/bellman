/**
 * Bans over HTTP (abuse protections spec, section 1): what the dash's Ban button and its two lists
 * call. A room's creator bans a member, lists the room's bans and lifts one; anyone signed in lists and
 * lifts the bans they made across the rooms they own.
 *
 * The spec gives `bellman_evict` its `ban` and no route, so `POST /rooms/:id/bans` runs the same
 * `evictMember` the tool runs and answers with the tool's fields. A ban id is opaque: the lists send
 * `banView` and `creatorBanView`, which leave the account's user id out.
 *
 * On the room routes' rules: the same caller, CORS for the panel's origins, the same preflight, the CSRF
 * check on every write a cookie makes, and the bound on a write's body. The room routes refuse in the
 * order `unpublishRoom` does: 401 with no caller, the CSRF check, one 404 for a missing room and for a
 * caller with no handle in it, then 403 for a member who did not create it. A body is read only after those.
 */
import { banView, creatorBanView } from "../bans.js";
import { allowedOrigin, corsHeaders, csrfRefusal, preflightResponse } from "../oauth/browser.js";
import { evictMember, handlesOf } from "../rooms.js";
import { STATUS, json, lengthRefusal, methodNotAllowed, problem, type RoomCaller, type RoomRouteDeps } from "./rooms.js";

export type ModerationDeps = Pick<RoomRouteDeps, "store" | "caller" | "panelOrigins">;

// ponytail: 1 KB, not tuned. The body is a member id and a scope.
export const MAX_BAN_BYTES = 1024;

const ROOM_BANS = /^\/rooms\/([^/]+)\/bans$/;
const ROOM_BAN = /^\/rooms\/([^/]+)\/bans\/([^/]+)$/;
const ACCOUNT_BANS = "/account/bans";
const ACCOUNT_BAN = /^\/account\/bans\/([^/]+)$/;

/** `undefined` for a path this module does not serve, so the server carries on to the room routes. */
export async function moderationRoutes(request: Request, deps: ModerationDeps): Promise<Response | undefined> {
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  const roomBans = ROOM_BANS.exec(path);
  const roomBan = ROOM_BAN.exec(path);
  const accountBan = ACCOUNT_BAN.exec(path);
  if (!roomBans && !roomBan && !accountBan && path !== ACCOUNT_BANS) return undefined;
  const origin = allowedOrigin(request, deps.panelOrigins);
  if (request.method === "OPTIONS") return preflightResponse(origin);

  // An unexpected throw is answered here, in this route's own JSON, as the room routes answer theirs.
  // A ban that threw partway is finished by asking again: the store keeps one ban per account.
  try {
    if (roomBans) {
      if (request.method === "GET") return await listRoomBans(request, roomBans[1], origin, deps);
      if (request.method === "POST") return await banMember(request, roomBans[1], origin, deps);
      return methodNotAllowed("GET, POST", origin);
    }
    if (roomBan) {
      if (request.method !== "DELETE") return methodNotAllowed("DELETE", origin);
      return await liftRoomBan(request, roomBan[1], roomBan[2], origin, deps);
    }
    if (accountBan) {
      if (request.method !== "DELETE") return methodNotAllowed("DELETE", origin);
      return await liftCreatorBan(request, accountBan[1], origin, deps);
    }
    if (request.method !== "GET") return methodNotAllowed("GET", origin);
    return await listCreatorBans(request, origin, deps);
  } catch (err) {
    console.error(`${request.method} ${path} failed:`, err);
    return problem(500, "internal", "the request failed on the server; repeating it is safe", origin);
  }
}

/** Who is calling, or the refusal that turns them away: 401 with no caller, then the CSRF check for a cookie write. */
async function admit(request: Request, origin: string | undefined, deps: ModerationDeps): Promise<RoomCaller | Response> {
  const who = await deps.caller(request);
  if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
  return csrfRefusal(request, who.via, origin) ?? who;
}

/**
 * The caller, once they are the room's creator, or the refusal. A person with no handle in the room and a
 * room that is not there get the one 404; a member who did not create it knows the room is there and gets
 * a 403 that says who may.
 */
async function admitCreator(
  request: Request, sessionId: string, origin: string | undefined, deps: ModerationDeps,
): Promise<RoomCaller | Response> {
  const who = await admit(request, origin, deps);
  if (who instanceof Response) return who;
  const session = await deps.store.getSession(sessionId);
  if (!session || (await handlesOf(deps.store, session, who.identity)).length === 0) {
    return problem(404, "not_found", "no such room, or no member of yours in it", origin);
  }
  if (session.createdBy !== who.identity.userId) {
    return problem(403, "forbidden", "only the room's creator may manage its bans", origin);
  }
  return who;
}

async function listRoomBans(request: Request, sessionId: string, origin: string | undefined, deps: ModerationDeps): Promise<Response> {
  const who = await admitCreator(request, sessionId, origin, deps);
  if (who instanceof Response) return who;
  return json(200, { bans: (await deps.store.roomBans(sessionId)).map(banView) }, origin);
}

/** The Ban button: the removal `bellman_evict` makes, with its `ban`. The refusals map through `STATUS`. */
async function banMember(request: Request, sessionId: string, origin: string | undefined, deps: ModerationDeps): Promise<Response> {
  const who = await admitCreator(request, sessionId, origin, deps);
  if (who instanceof Response) return who;
  const tooLong = lengthRefusal(request, MAX_BAN_BYTES, "a ban request", origin);
  if (tooLong) return tooLong;

  // A body that is not JSON, `null`, an array or a scalar has neither field, and is the one 400 below.
  const { member_id, scope } = ((await request.json().catch(() => null)) ?? {}) as { member_id?: unknown; scope?: unknown };
  if (typeof member_id !== "string") return problem(400, "invalid_request", "member_id must be a string", origin);
  if (scope !== "room" && scope !== "all") return problem(400, "invalid_request", 'scope must be "room" or "all"', origin);

  const r = await evictMember(deps.store, who.identity, sessionId, member_id, scope);
  if (!r.ok) return problem(STATUS[r.code], r.code, r.reason, origin);
  return json(200, {
    evicted: r.value.evicted,
    code_retired: r.value.codeRetired,
    session_status: r.value.sessionStatus,
    banned: r.value.banned,
  }, origin);
}

/** A string that is not shaped like a ban id answers false without storage being read, so it is this 404 and no more. */
async function liftRoomBan(request: Request, sessionId: string, banId: string, origin: string | undefined, deps: ModerationDeps): Promise<Response> {
  const who = await admitCreator(request, sessionId, origin, deps);
  if (who instanceof Response) return who;
  return (await deps.store.liftRoomBan(sessionId, banId))
    ? new Response(null, { status: 204, headers: corsHeaders(origin) })
    : problem(404, "not_found", "no such ban", origin);
}

async function listCreatorBans(request: Request, origin: string | undefined, deps: ModerationDeps): Promise<Response> {
  const who = await admit(request, origin, deps);
  if (who instanceof Response) return who;
  return json(200, { bans: (await deps.store.creatorBans(who.identity.userId)).map(creatorBanView) }, origin);
}

/** Another creator's ban id, a lifted one and a malformed one are the one 404: the store says false to each. */
async function liftCreatorBan(request: Request, banId: string, origin: string | undefined, deps: ModerationDeps): Promise<Response> {
  const who = await admit(request, origin, deps);
  if (who instanceof Response) return who;
  return (await deps.store.liftCreatorBan(who.identity.userId, banId))
    ? new Response(null, { status: 204, headers: corsHeaders(origin) })
    : problem(404, "not_found", "no such ban", origin);
}
