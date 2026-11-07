/**
 * What a person holds, under `/me`, for the panel and for desktop apps.
 *
 * `GET /me/rooms` (#434): the rooms a person sits in, with their seats: what `bellman_rooms` returns, from the same
 * `liveRooms`. A desktop app calls it at launch, on wake, after a membership change it caused, and on a slow
 * reconcile; what changes inside a room arrives over that room's socket. On the handle route's rules: the same caller
 * (the panel cookie, or a bearer an app got by signing in), CORS for the panel's origins and the same preflight. It
 * writes nothing, so it has no CSRF check.
 *
 * No ETag: the body has to be built to be hashed, so a 304 would save the bytes and none of the reads, and
 * `silent_for_seconds` moves every second, so a live room would almost never match one.
 *
 * `GET /me/memory` (#530, ADR 0047 decision 13): the account's memory settings, `{ capture }`, for the dash and for
 * the bridge, which reads it with its bearer when the Stop hook asks. `PUT /me/memory` with exactly `{ "capture":
 * boolean }` sets it, from a signed-in dash session only, Origin checked: a bearer is refused, since turning capture on
 * is what makes an agent write memory unasked, and an agent reads peer content that can ask for it.
 */
import { allowedOrigin, csrfRefusal, preflightResponse } from "../oauth/browser.js";
import { readMemorySettings, setMemoryCapture } from "../files/memory.js";
import { liveRooms } from "../room/rooms.js";
import { json, methodNotAllowed, problem, type RoomRouteDeps } from "./rooms.js";

export type MeRouteDeps = Pick<RoomRouteDeps, "store" | "caller" | "panelOrigins">;

const ROOMS = "/me/rooms";
const MEMORY = "/me/memory";

/** `undefined` for any other path, so the server carries on. */
export async function meRoutes(request: Request, deps: MeRouteDeps): Promise<Response | undefined> {
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  if (path !== ROOMS && path !== MEMORY) return undefined;
  const origin = allowedOrigin(request, deps.panelOrigins);
  if (request.method === "OPTIONS") return preflightResponse(origin);
  const allowed = path === ROOMS ? "GET" : "GET, PUT";
  if (!allowed.split(", ").includes(request.method)) return methodNotAllowed(allowed, origin);
  try {
    const who = await deps.caller(request);
    if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
    if (path === ROOMS) return json(200, { rooms: await liveRooms(deps.store, who.identity) }, origin);
    if (request.method === "GET") return json(200, await readMemorySettings(deps.store, who.identity), origin);
    if (who.via !== "cookie") return problem(403, "forbidden", "memory settings are changed by the person signed in to the dash, never with a bearer token", origin);
    const refusal = csrfRefusal(request, who.via, origin);
    if (refusal) return refusal;
    const raw: unknown = await request.json().catch(() => null);
    const capture = typeof raw === "object" && raw !== null && Object.keys(raw).join() === "capture" ? (raw as { capture: unknown }).capture : undefined;
    if (typeof capture !== "boolean") return problem(400, "invalid_request", 'send {"capture": true} or {"capture": false}', origin);
    return json(200, await setMemoryCapture(deps.store, who.identity, capture), origin);
  } catch (err) {
    console.error(`${request.method} ${path} failed:`, err);
    return problem(500, "internal", "the request failed on the server", origin);
  }
}
