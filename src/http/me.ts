/**
 * The rooms a person sits in, with their seats (#434), at `GET /me/rooms`: what `bellman_rooms` returns, from the
 * same `liveRooms`, for the panel and for desktop apps. A desktop app calls it at launch, on wake, after a
 * membership change it caused, and on a slow reconcile; what changes inside a room arrives over that room's
 * socket. On the handle route's rules: the same caller (the panel cookie, or a bearer an app got by signing in),
 * CORS for the panel's origins and the same preflight. It writes nothing, so it has no CSRF check.
 *
 * No ETag: the body has to be built to be hashed, so a 304 would save the bytes and none of the reads, and
 * `silent_for_seconds` moves every second, so a live room would almost never match one.
 */
import { allowedOrigin, preflightResponse } from "../oauth/browser.js";
import { liveRooms } from "../rooms.js";
import { json, methodNotAllowed, problem, type RoomRouteDeps } from "./rooms.js";

export type MeRouteDeps = Pick<RoomRouteDeps, "store" | "caller" | "panelOrigins">;

const PATH = "/me/rooms";

/** `undefined` for any other path, so the server carries on. */
export async function meRoutes(request: Request, deps: MeRouteDeps): Promise<Response | undefined> {
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  if (path !== PATH) return undefined;
  const origin = allowedOrigin(request, deps.panelOrigins);
  if (request.method === "OPTIONS") return preflightResponse(origin);
  if (request.method !== "GET") return methodNotAllowed("GET", origin);
  try {
    const who = await deps.caller(request);
    if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
    return json(200, { rooms: await liveRooms(deps.store, who.identity) }, origin);
  } catch (err) {
    console.error(`${request.method} ${path} failed:`, err);
    return problem(500, "internal", "the request failed on the server", origin);
  }
}
