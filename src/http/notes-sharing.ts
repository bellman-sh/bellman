/**
 * An account's notes-sharing switch in a room (ADR 0047 decision 7, #538): whether peers may read its
 * `/members/<memory id>/` files there, off until the person turns it on.
 *
 *   GET /rooms/:id/notes-sharing            { shared } for the caller's account; bearer or cookie
 *   PUT /rooms/:id/notes-sharing { shared }  from a signed-in dash session alone, Origin checked
 *
 * A bearer is refused the write even from a seat of the caller's: turning sharing on is what exposes notes, and an
 * agent reads peer content that can ask for it. Turning it off is also `bellman_memory` `unshare`, from any seat.
 * The caller must have held a seat in the room, present or departed: a departed seat's notes are still its own.
 *
 * Runtime-free, as rooms.ts: a web Request in, a Response out.
 */
import { csrfRefusal } from "../oauth/browser.js";
import { notesSharersOf } from "../room/rooms.js";
import { json, methodNotAllowed, problem, type RoomRouteDeps } from "./rooms.js";

export const NOTES_SHARING = /^\/rooms\/([^/]+)\/notes-sharing$/;

const NOT_FOUND = "no such room, or no seat of yours in it";

/** Dispatch the notes-sharing route, or undefined when `path` is not it. */
export async function notesSharingRoutes(request: Request, path: string, origin: string | undefined, deps: RoomRouteDeps): Promise<Response | undefined> {
  const match = NOTES_SHARING.exec(path);
  if (!match) return undefined;
  if (request.method !== "GET" && request.method !== "PUT") return methodNotAllowed("GET, PUT", origin);
  const sessionId = match[1];
  const who = await deps.caller(request);
  if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
  if (request.method === "PUT") {
    if (who.via !== "cookie") {
      return problem(403, "dash_session_required", "notes sharing is turned on by the person signed in to the dash, never with a bearer token; an agent can only turn it off, with bellman_memory unshare", origin);
    }
    const refusal = csrfRefusal(request, who.via, origin);
    if (refusal) return refusal;
  }
  const session = await deps.store.getSession(sessionId);
  const seats = session ? await deps.store.membersOfUser(sessionId, who.identity.userId) : [];
  if (!session || seats.length === 0) return problem(404, "not_found", NOT_FOUND, origin);

  if (request.method === "GET") {
    return json(200, { shared: (await notesSharersOf(deps.store, sessionId)).has(who.identity.userId) }, origin);
  }
  const raw: unknown = await request.json().catch(() => null);
  const shared = typeof raw === "object" && raw !== null && !Array.isArray(raw) && Object.keys(raw).join() === "shared"
    ? (raw as { shared: unknown }).shared
    : undefined;
  if (typeof shared !== "boolean") return problem(400, "invalid_request", 'send {"shared": true} or {"shared": false}', origin);
  await deps.store.setNotesSharing(sessionId, who.identity.userId, shared);
  return json(200, { shared }, origin);
}
