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
 * `GET /me/memory` (#530, #531, ADR 0047 decision 13): the account's memory settings, `{ capture, paused }`, for the dash
 * and for the bridge, which reads it with its bearer when the Stop hook asks. `PUT /me/memory` with a non-empty object of
 * `capture` and/or `paused` booleans sets them, from a signed-in dash session only, Origin checked: a bearer is refused,
 * since turning capture on is what makes an agent write memory unasked, turning pause off is what lets it write again,
 * and an agent reads peer content that can ask for either. `paused` is pause: the tool refuses all but `forget` and `unshare`.
 *
 * `GET /me/memory/lookups` (#531, decision 13): the lookup log, `{ lookups }` newest first, each row's room named. Dash
 * session only (403 `dash_session_required` to a bearer): the log is for the person, and an agent has no use for it.
 *
 * `DELETE /me/memory` and `DELETE /me/memory/notes?path=<path>` (#531, decision 14): hard delete, 204. The first empties
 * the home room, settings and lookup log included; the second deletes one note as `forget` does and scrubs it from the
 * log (404 `not_found`, 400 `invalid_request` for a missing or invalid path). Dash session only, Origin checked, and
 * never refused while paused.
 *
 * `GET /me/memory/export` (#531, decision 14): one Markdown document, `text/markdown` as an attachment: the home notes,
 * then the account's own notes in each open room it sits in. Dash session only (403 `dash_session_required` to a
 * bearer), and never refused while paused: it reads the store, not the logged read, so the lookup log is untouched.
 */
import { allowedOrigin, corsHeaders, csrfRefusal, preflightResponse } from "../oauth/browser.js";
import { deleteMemory, exportMemory, forgetNote, memoryLookups, readMemorySettings, setMemorySettings } from "../files/memory.js";
import { liveRooms } from "../room/rooms.js";
import type { HomeSettings, RepoRoom } from "../types.js";
import { bindRepoRoom, connectFromBinding, listRepoRooms, unbindRepoRoom } from "../room/repo-room.js";
import { json, methodNotAllowed, problem, type RoomCaller, type RoomRouteDeps } from "./rooms.js";

export type MeRouteDeps = Pick<RoomRouteDeps, "store" | "caller" | "panelOrigins">;

const ROOMS = "/me/rooms";
const MEMORY = "/me/memory";
const LOOKUPS = "/me/memory/lookups";
const NOTES = "/me/memory/notes";
const EXPORT = "/me/memory/export";
const REPO_ROOMS = "/me/repo-rooms";
const REPO_CONNECT = "/me/repo-rooms/connect";

/** The body as a settings patch: a non-empty object whose every key is `capture` or `paused`, each a boolean; else `null`. */
function memoryPatch(raw: unknown): Partial<HomeSettings> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const entries = Object.entries(raw);
  if (entries.length === 0 || !entries.every(([k, v]) => (k === "capture" || k === "paused") && typeof v === "boolean")) return null;
  return Object.fromEntries(entries);
}

/** `undefined` for any other path, so the server carries on. */
export async function meRoutes(request: Request, deps: MeRouteDeps): Promise<Response | undefined> {
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  if (path !== ROOMS && path !== MEMORY && path !== LOOKUPS && path !== NOTES && path !== EXPORT && path !== REPO_ROOMS && path !== REPO_CONNECT) return undefined;
  const origin = allowedOrigin(request, deps.panelOrigins);
  if (request.method === "OPTIONS") return preflightResponse(origin);
  const allowed = path === MEMORY || path === REPO_ROOMS ? "GET, PUT, DELETE" : path === NOTES ? "DELETE" : path === REPO_CONNECT ? "POST" : "GET";
  if (!allowed.split(", ").includes(request.method)) return methodNotAllowed(allowed, origin);
  try {
    const who = await deps.caller(request);
    if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
    if (path === ROOMS) return json(200, { rooms: await liveRooms(deps.store, who.identity) }, origin);
    if (path === REPO_ROOMS) return await repoRooms(request, deps, who, origin);
    if (path === REPO_CONNECT) {
      // The bridge at launch, with its bearer, and only that: a cookie POST could come from any same-site page. It seats
      // nobody; the token it returns goes through bellman_confirm.
      if (who.via === "cookie") return problem(403, "bearer_required", "a connect token from a repo's default room is for the bridge, with its bearer token", origin);
      const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (typeof raw?.remote !== "string") return problem(400, "invalid_request", 'send {"remote": string}', origin);
      const out = await connectFromBinding(deps.store, who.identity, raw.remote);
      return out.ok
        ? json(200, { connect_token: out.value.connectToken, session_id: out.value.sessionId, role: out.value.role }, origin)
        : problem(out.status, out.code, out.reason, origin);
    }
    if (path === LOOKUPS) {
      if (who.via !== "cookie") return problem(403, "dash_session_required", "the lookup log is read by the person signed in to the dash", origin);
      return json(200, { lookups: await memoryLookups(deps.store, who.identity) }, origin);
    }
    if (path === EXPORT) {
      if (who.via !== "cookie") return problem(403, "dash_session_required", "memory is exported by the person signed in to the dash", origin);
      // The account's own notes, verbatim, as a download: never rendered here, so nothing is escaped.
      const day = new Date().toISOString().slice(0, 10);
      return new Response(await exportMemory(deps.store, who.identity), {
        status: 200,
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "content-disposition": `attachment; filename="bellman-memory-${day}.md"`,
          "cache-control": "no-store",
          ...corsHeaders(origin),
        },
      });
    }
    if (request.method === "DELETE") {
      if (who.via !== "cookie") return problem(403, "dash_session_required", "memory is deleted by the person signed in to the dash, never with a bearer token", origin);
      const refusal = csrfRefusal(request, who.via, origin);
      if (refusal) return refusal;
      if (path === MEMORY) await deleteMemory(deps.store, who.identity);
      else {
        const out = await forgetNote(deps.store, who.identity, new URL(request.url).searchParams.get("path") ?? "");
        if (!out.ok) return out.code === "not_found" ? problem(404, "not_found", out.reason, origin) : problem(400, "invalid_request", out.reason, origin);
      }
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method === "GET") return json(200, await readMemorySettings(deps.store, who.identity), origin);
    if (who.via !== "cookie") return problem(403, "dash_session_required", "memory settings are changed by the person signed in to the dash, never with a bearer token", origin);
    const refusal = csrfRefusal(request, who.via, origin);
    if (refusal) return refusal;
    const raw: unknown = await request.json().catch(() => null);
    const patch = memoryPatch(raw);
    if (!patch) return problem(400, "invalid_request", 'send {"capture": boolean} and/or {"paused": boolean}', origin);
    return json(200, await setMemorySettings(deps.store, who.identity, patch), origin);
  } catch (err) {
    console.error(`${request.method} ${path} failed:`, err);
    return problem(500, "internal", "the request failed on the server", origin);
  }
}

/** One binding as the routes show it. */
const repoRoomBody = (r: RepoRoom) => ({ remote: r.remote, session_id: r.sessionId, role: r.role, created_at: r.createdAt });

/**
 * `/me/repo-rooms`: a repo's default rooms. Read with a bearer or the dash (the bridge reads them at launch); bound
 * and unbound only by the person signed in to the dash, CSRF-checked, so an agent cannot give itself a standing seat.
 */
async function repoRooms(request: Request, deps: MeRouteDeps, who: RoomCaller, origin: string | undefined): Promise<Response> {
  if (request.method === "GET") return json(200, { repo_rooms: (await listRepoRooms(deps.store, who.identity)).map(repoRoomBody) }, origin);
  if (who.via !== "cookie") return problem(403, "dash_session_required", "a repo's default room is set by the person signed in to the dash, never with a bearer token", origin);
  const refusal = csrfRefusal(request, who.via, origin);
  if (refusal) return refusal;
  if (request.method === "DELETE") {
    const out = await unbindRepoRoom(deps.store, who.identity, new URL(request.url).searchParams.get("remote") ?? "");
    return out.ok ? new Response(null, { status: 204, headers: corsHeaders(origin) }) : problem(out.status, out.code, out.reason, origin);
  }
  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const remote = raw?.remote, sessionId = raw?.session_id, role = raw?.role;
  if (typeof remote !== "string" || typeof sessionId !== "string" || typeof role !== "string") {
    return problem(400, "invalid_request", 'send {"remote": string, "session_id": string, "role": string}', origin);
  }
  const out = await bindRepoRoom(deps.store, who.identity, { remote, sessionId, role });
  return out.ok ? json(200, repoRoomBody(out.value), origin) : problem(out.status, out.code, out.reason, origin);
}
