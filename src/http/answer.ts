/**
 * A person signed in to the dash answers an action request as one of their seats in the room.
 *
 *   POST /rooms/:id/requests/:cursor/answer?member_id=  { approved, result? }   200 { cursor, room_members, applied? }
 *
 * Through `answerAction`, the operation `bellman_send type: "action_response"` runs, so the verb (`respond_actions`),
 * the first-answer check, the shape, a topic room's approval, the minute's count, the event and the audit row are one
 * sequence for both transports. Dash session only, Origin checked: a bearer is refused (403 `dash_session_required`),
 * since the human this answers for is the one signed in, and an agent that reads peer content answers with
 * `bellman_send`. A decision is voted on, never answered here (400). `room_members` is the roster read before the
 * append, not a read receipt.
 *
 * Runtime-free, as rooms.ts: a web Request in, a Response out.
 */
import { csrfRefusal } from "../oauth/browser.js";
import { answerAction } from "../room/answer.js";
import { FROZEN, findMember } from "../room/rooms.js";
import { STATUS, adminWriteRefusal, json, lengthRefusal, methodNotAllowed, problem, type RoomRouteDeps } from "./rooms.js";

export const ANSWER = /^\/rooms\/([^/]+)\/requests\/([^/]+)\/answer$/;

// ponytail: 16 KB, not tuned. `result` is at most 2,000 characters, under 12 KB even written as six-byte \uXXXX escapes.
export const MAX_ANSWER_BYTES = 16 * 1024;

async function answerRoute(
  request: Request, url: URL, sessionId: string, refId: string, origin: string | undefined, deps: RoomRouteDeps,
): Promise<Response> {
  const who = await deps.caller(request);
  if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
  if (who.via !== "cookie") {
    return problem(403, "dash_session_required", "an action request is answered here by the person signed in to the dash; an agent answers with bellman_send", origin);
  }
  const refusal = csrfRefusal(request, who.via, origin);
  if (refusal) return refusal;

  const memberId = url.searchParams.get("member_id") ?? "";
  if (!memberId) return problem(400, "invalid_request", "member_id is required", origin);
  const tooLong = lengthRefusal(request, MAX_ANSWER_BYTES, "an answer", origin);
  if (tooLong) return tooLong;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return problem(400, "invalid_request", 'send {"approved": boolean} and optionally {"result": string}', origin);
  }
  // Only the two fields reach the event: a body's other keys are the dash's, not the answer's.
  const { approved, result } = body as { approved?: unknown; result?: unknown };
  const payload: Record<string, unknown> = { approved, ...(result !== undefined ? { result } : {}) };

  // A stranger's answer is the unknown room's: a handle that is not the caller's is 404.
  const session = await deps.store.getSession(sessionId);
  const me = session ? await findMember(deps.store, session, memberId, who.identity) : undefined;
  if (!session || !me) {
    return await adminWriteRefusal(deps.store, session, who.identity, origin)
      ?? problem(404, "not_found", "no such room, or no member of yours in it", origin);
  }
  if (session.closed) return problem(409, "closed", "this room is closed", origin);
  if (session.frozenAt !== null) return problem(409, "frozen", FROZEN, origin);
  if (me.leftAt !== null) return problem(403, "forbidden", "this seat has left the room", origin);

  const at = Number(refId);
  const named = Number.isSafeInteger(at) && at > 0 ? await deps.store.eventAt(sessionId, at) : undefined;
  if (named?.type === "decision_opened" && String(named.cursor) === refId) {
    return problem(400, "invalid_request", "this is a decision: it is voted on, not answered", origin);
  }
  const out = await answerAction(deps.store, deps.blobs, who.identity, session, me, refId, named, payload, undefined);
  if (!out.ok) return problem(STATUS[out.code], out.code, out.reason, origin);
  return json(200, {
    cursor: out.value.cursor,
    room_members: out.value.roomMembers,
    ...(out.value.applied !== null ? { applied: out.value.applied } : {}),
  }, origin);
}

/** Dispatch the answer route, or undefined when `path` is not it. */
export async function answerRoutes(
  request: Request, url: URL, path: string, origin: string | undefined, deps: RoomRouteDeps,
): Promise<Response | undefined> {
  const m = ANSWER.exec(path);
  if (!m) return undefined;
  if (request.method !== "POST") return methodNotAllowed("POST", origin);
  return answerRoute(request, url, m[1], m[2], origin, deps);
}
