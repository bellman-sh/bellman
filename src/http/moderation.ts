/**
 * Bans and reports over HTTP (abuse protections spec, sections 1 and 3): what the dash's Ban button and its two
 * lists call, and what files a report and shows a creator the ones about their room. A room's creator bans a member,
 * lists the room's bans and lifts one; anyone signed in lists and lifts the bans they made across the rooms they own.
 *
 * The spec gives `bellman_evict` its `ban` and no route, so `POST /rooms/:id/bans` runs the same
 * `evictMember` the tool runs and answers with the tool's fields. A ban id is opaque: the lists send
 * `banView` and `creatorBanView`, which leave the account's user id out.
 *
 * `POST /rooms/:id/reports` runs the `fileRoomReport` the `bellman_report` tool runs, for anyone signed in: who may
 * report what, the fold and the day's limit are that operation's, and the route translates its answer. A report is 201,
 * a repeat of one still open is 200 with the first one's id, and the day's limit is 429 with `Retry-After` and
 * `retry_after`, the wait in the whole seconds the operation rounded it to. `GET /rooms/:id/reports` is the creator's
 * list, in `creatorReportView`, which leaves out who filed.
 *
 * On the room routes' rules: the same caller, CORS for the panel's origins, the same preflight, the CSRF
 * check on every write a cookie makes, and the bound on a write's body. The room routes refuse in the
 * order `unpublishRoom` does: 401 with no caller, the CSRF check, one 404 for a missing room and for a
 * caller with no handle in it, then 403 for a member who did not create it. A body is read only after those.
 * A report is not the creator's alone to file, so it refuses in its own order: 401, the CSRF check, the body's bound
 * and shape, then `fileRoomReport`'s, whose 404 is the one answer for a missing room and for a private room the
 * caller has no handle in.
 */
import { banView, creatorBanView } from "../bans.js";
import { allowedOrigin, corsHeaders, csrfRefusal, preflightResponse } from "../oauth/browser.js";
import { creatorReportView, reportMailer, type ReportMailer } from "../reports.js";
import { evictMember, fileRoomReport, handlesOf } from "../rooms.js";
import { STATUS, json, lengthRefusal, methodNotAllowed, problem, type RoomCaller, type RoomRouteDeps } from "./rooms.js";

export type ModerationDeps = Pick<RoomRouteDeps, "store" | "caller" | "panelOrigins"> & {
  /** What mails a filed report. Absent, it is `reportMailer(undefined)`: the report is stored and the log says no email went. */
  mailReport?: ReportMailer;
};

// ponytail: 1 KB, not tuned. The body is a member id and a scope.
export const MAX_BAN_BYTES = 1024;

// ponytail: 4 KB, not tuned. A 500-character note escapes to at most about 3 KB of JSON.
export const MAX_REPORT_BYTES = 4096;

const ROOM_BANS = /^\/rooms\/([^/]+)\/bans$/;
const ROOM_REPORTS = /^\/rooms\/([^/]+)\/reports$/;
const ROOM_BAN = /^\/rooms\/([^/]+)\/bans\/([^/]+)$/;
const ACCOUNT_BANS = "/account/bans";
const ACCOUNT_BAN = /^\/account\/bans\/([^/]+)$/;

/** `undefined` for a path this module does not serve, so the server carries on to the room routes. */
export async function moderationRoutes(request: Request, deps: ModerationDeps): Promise<Response | undefined> {
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  const roomBans = ROOM_BANS.exec(path);
  const roomBan = ROOM_BAN.exec(path);
  const accountBan = ACCOUNT_BAN.exec(path);
  const roomReports = ROOM_REPORTS.exec(path);
  if (!roomBans && !roomBan && !accountBan && !roomReports && path !== ACCOUNT_BANS) return undefined;
  const origin = allowedOrigin(request, deps.panelOrigins);
  if (request.method === "OPTIONS") return preflightResponse(origin);

  // An unexpected throw is answered here, in this route's own JSON, as the room routes answer theirs.
  // A ban that threw partway is finished by asking again: the store keeps one ban per account. A report that threw
  // before the store answered filed nothing and is filed by asking again; one whose answer was lost after the store
  // wrote it is folded by the retry, which sends no email, so the queue is where that report is read.
  try {
    if (roomBans) {
      if (request.method === "GET") return await listRoomBans(request, roomBans[1], origin, deps);
      if (request.method === "POST") return await banMember(request, roomBans[1], origin, deps);
      return methodNotAllowed("GET, POST", origin);
    }
    if (roomReports) {
      if (request.method === "GET") return await listRoomReports(request, roomReports[1], origin, deps);
      if (request.method === "POST") return await fileReport(request, roomReports[1], origin, deps);
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
 * a 403 that says who may `what`.
 */
async function admitCreator(
  request: Request, sessionId: string, what: string, origin: string | undefined, deps: ModerationDeps,
): Promise<RoomCaller | Response> {
  const who = await admit(request, origin, deps);
  if (who instanceof Response) return who;
  const session = await deps.store.getSession(sessionId);
  if (!session || (await handlesOf(deps.store, session, who.identity)).length === 0) {
    return problem(404, "not_found", "no such room, or no member of yours in it", origin);
  }
  if (session.createdBy !== who.identity.userId) {
    return problem(403, "forbidden", `only the room's creator may ${what}`, origin);
  }
  return who;
}

async function listRoomBans(request: Request, sessionId: string, origin: string | undefined, deps: ModerationDeps): Promise<Response> {
  const who = await admitCreator(request, sessionId, "manage its bans", origin, deps);
  if (who instanceof Response) return who;
  return json(200, { bans: (await deps.store.roomBans(sessionId)).map(banView) }, origin);
}

/** The Ban button: the removal `bellman_evict` makes, with its `ban`. The refusals map through `STATUS`. */
async function banMember(request: Request, sessionId: string, origin: string | undefined, deps: ModerationDeps): Promise<Response> {
  const who = await admitCreator(request, sessionId, "manage its bans", origin, deps);
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
    also_removed_from: r.value.alsoRemovedFrom,
  }, origin);
}

/** A string that is not shaped like a ban id answers false without storage being read, so it is this 404 and no more. */
async function liftRoomBan(request: Request, sessionId: string, banId: string, origin: string | undefined, deps: ModerationDeps): Promise<Response> {
  const who = await admitCreator(request, sessionId, "manage its bans", origin, deps);
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

/** A room's reports about members and messages, newest first, in the view that leaves out who filed them. */
async function listRoomReports(request: Request, sessionId: string, origin: string | undefined, deps: ModerationDeps): Promise<Response> {
  const who = await admitCreator(request, sessionId, "read its reports", origin, deps);
  if (who instanceof Response) return who;
  return json(200, { reports: (await deps.store.roomReports(who.identity.userId, sessionId)).map(creatorReportView) }, origin);
}

/** The dash's Report button: the `fileRoomReport` the tool runs, answered as 201, 200 for a fold, or the refusal. */
async function fileReport(request: Request, sessionId: string, origin: string | undefined, deps: ModerationDeps): Promise<Response> {
  const who = await admit(request, origin, deps);
  if (who instanceof Response) return who;
  const tooLong = lengthRefusal(request, MAX_REPORT_BYTES, "a report", origin);
  if (tooLong) return tooLong;

  // A body that is not JSON, `null`, an array or a scalar has none of the fields, and is the `reason` 400 below. A field is
  // checked for its type when it is there; what a member id, a cursor or a note may be is `fileRoomReport`'s to say.
  const { member_id, cursor, reason, note } = ((await request.json().catch(() => null)) ?? {}) as {
    member_id?: unknown; cursor?: unknown; reason?: unknown; note?: unknown;
  };
  if (member_id !== undefined && typeof member_id !== "string") return problem(400, "invalid_request", "member_id must be a string", origin);
  if (cursor !== undefined && typeof cursor !== "number") return problem(400, "invalid_request", "cursor must be a number", origin);
  if (typeof reason !== "string") return problem(400, "invalid_request", "reason must be a string", origin);
  if (note !== undefined && typeof note !== "string") return problem(400, "invalid_request", "note must be a string", origin);

  const r = await fileRoomReport(
    deps.store, who.identity, sessionId, { memberId: member_id, cursor, reason, note }, deps.mailReport ?? reportMailer(undefined),
  );
  if (!r.ok) {
    if (r.code !== "rate_limited" || r.retryAfter === undefined) return problem(STATUS[r.code], r.code, r.reason, origin);
    // The wait is the operation's, whole seconds rounded up as a send's is: it is passed on as it is and never rounded again.
    const limited = json(STATUS[r.code], { error: r.code, error_description: r.reason, retry_after: r.retryAfter }, origin);
    limited.headers.set("retry-after", String(r.retryAfter));
    return limited;
  }
  return json(r.value.folded ? 200 : 201, { report_id: r.value.reportId, folded: r.value.folded }, origin);
}
