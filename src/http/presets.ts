/**
 * The saved-preset routes (designer spec D5), beside the room routes and on
 * their rules: the same caller, CORS for the panel's origins, the same
 * preflight, and the CSRF check on every write a cookie makes. Every read and
 * write is keyed by the caller's own user id.
 */
import { allowedOrigin, corsHeaders, csrfRefusal, preflightResponse } from "../oauth/browser.js";
import { builtinPresets } from "../manifest.js";
import { MAX_PRESETS, checkPreset } from "../presets.js";
import { json, methodNotAllowed, problem, type RoomRouteDeps } from "./rooms.js";

export type PresetRouteDeps = Pick<RoomRouteDeps, "store" | "caller" | "panelOrigins">;

// ponytail: 32 KB, not tuned. Sixteen roles of six verbs and 300-character descriptions is a few KB.
export const MAX_PRESET_BYTES = 32 * 1024;

const LIST = /^\/presets$/;
const ONE = /^\/presets\/([^/]+)$/;

/** `undefined` for a path outside `/presets`, so the server carries on; everything under it is answered here. */
export async function presetRoutes(request: Request, deps: PresetRouteDeps): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (path !== "/presets" && !path.startsWith("/presets/")) return undefined;
  const origin = allowedOrigin(request, deps.panelOrigins);
  if (request.method === "OPTIONS") return preflightResponse(origin);
  try {
    if (LIST.test(path)) {
      if (request.method !== "GET") return methodNotAllowed("GET", origin);
      return await listPresets(request, origin, deps);
    }
    const one = ONE.exec(path);
    if (one) {
      if (request.method !== "PUT" && request.method !== "DELETE") return methodNotAllowed("PUT, DELETE", origin);
      return await writePreset(request, one[1], origin, deps);
    }
    return problem(404, "not_found", "no such route", origin);
  } catch (err) {
    console.error(`${request.method} ${path} failed:`, err);
    return problem(500, "internal", "the request failed on the server; nothing was saved", origin);
  }
}

async function listPresets(request: Request, origin: string | undefined, deps: PresetRouteDeps): Promise<Response> {
  const who = await deps.caller(request);
  if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
  return json(200, { builtin: builtinPresets(), mine: await deps.store.listPresets(who.identity.userId) }, origin);
}

async function writePreset(request: Request, rawName: string, origin: string | undefined, deps: PresetRouteDeps): Promise<Response> {
  const who = await deps.caller(request);
  if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
  const refusal = csrfRefusal(request, who.via, origin);
  if (refusal) return refusal;
  let name: string;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    return problem(400, "invalid_request", "the name is not valid percent-encoding", origin);
  }
  const userId = who.identity.userId;

  if (request.method === "DELETE") {
    if (!(await deps.store.deletePreset(userId, name))) {
      return problem(404, "not_found", `you have no preset named ${JSON.stringify(name)}`, origin);
    }
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  // The length before the body, as the surface write checks it: a present length must be a digit string.
  const length = request.headers.get("content-length");
  if (length !== null && !/^\d+$/.test(length)) {
    return problem(400, "invalid_request", "Content-Length must be a non-negative integer", origin);
  }
  if (Number(length ?? "0") > MAX_PRESET_BYTES) {
    return problem(413, "too_large", `a preset is at most ${MAX_PRESET_BYTES} bytes of JSON`, origin);
  }
  const notObject = () => problem(400, "invalid_request", "the body must be a JSON object: the preset", origin);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return notObject();
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return notObject();

  const check = checkPreset(name, body, Date.now());
  if (!check.ok) return problem(check.status, check.error, check.description, origin);
  if ((await deps.store.putPreset(userId, check.preset, MAX_PRESETS)) === "full") {
    return problem(409, "full", `you have ${MAX_PRESETS} presets, the most one person keeps; delete one first`, origin);
  }
  return json(200, check.preset, origin);
}
