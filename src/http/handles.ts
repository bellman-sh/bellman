/**
 * A person's public handle (bylines spec D6): read, claimed or changed, and released, at
 * `/account/handle`. On the preset routes' rules: the same caller, CORS for the panel's origins, the
 * same preflight, the CSRF check on every write a cookie makes, and the bound on a write's body. Here,
 * not in the OAuth router that serves `/account`, because that router has no store (plan ruling R1).
 */
import { checkHandle } from "../handles.js";
import { allowedOrigin, corsHeaders, csrfRefusal, preflightResponse } from "../oauth/browser.js";
import { json, lengthRefusal, methodNotAllowed, problem, type RoomRouteDeps } from "./rooms.js";

export type HandleRouteDeps = Pick<RoomRouteDeps, "store" | "caller" | "panelOrigins">;

// ponytail: 1 KB, not tuned. A handle is at most 30 characters, so its JSON body is a few dozen bytes.
export const MAX_HANDLE_BYTES = 1024;

const PATH = "/account/handle";

/** `undefined` for any other path, so the server carries on. */
export async function handleRoutes(request: Request, deps: HandleRouteDeps): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (path !== PATH) return undefined;
  const origin = allowedOrigin(request, deps.panelOrigins);
  if (request.method === "OPTIONS") return preflightResponse(origin);
  try {
    const who = await deps.caller(request);
    if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
    const userId = who.identity.userId;
    if (request.method === "GET") return json(200, { handle: (await deps.store.handleOf(userId)) ?? null }, origin);
    if (request.method !== "PUT" && request.method !== "DELETE") return methodNotAllowed("GET, PUT, DELETE", origin);
    const refusal = csrfRefusal(request, who.via, origin);
    if (refusal) return refusal;

    if (request.method === "DELETE") {
      await deps.store.releaseHandle(userId);
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const refused = lengthRefusal(request, MAX_HANDLE_BYTES, "a handle request", origin);
    if (refused) return refused;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = undefined;
    }
    const raw = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as { handle?: unknown }).handle : undefined;
    const check = checkHandle(raw);
    if (!check.ok) return problem(400, check.error, check.description, origin);
    if ((await deps.store.claimHandle(userId, check.handle)) === "taken") {
      return problem(409, "handle_taken", `${check.handle} belongs to someone else`, origin);
    }
    return json(200, { handle: check.handle }, origin);
  } catch (err) {
    console.error(`${request.method} ${path} failed:`, err);
    return problem(500, "internal", "the request failed on the server; nothing was saved", origin);
  }
}
