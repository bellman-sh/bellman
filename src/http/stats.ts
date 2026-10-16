/**
 * The operator's platform stats (operator stats spec D1): three numbers and a
 * flag, at `/operator/stats`. On the handle routes' rules — the same caller,
 * CORS for the panel's origins, the same preflight — and with no CSRF check,
 * because there is no write here (D5).
 *
 * The one route on this surface not scoped to the caller's own account, and the
 * one gated on `operators` (D2). A route that writes belongs on `/admin/*`
 * behind a bearer token, whose refusal of browser sessions this does not touch.
 */
import { allowedOrigin, preflightResponse } from "../oauth/browser.js";
import { json, methodNotAllowed, problem, type RoomRouteDeps } from "./rooms.js";

export type StatsRouteDeps = Pick<RoomRouteDeps, "store" | "caller" | "panelOrigins"> & {
  /** The user ids BELLMAN_OPERATORS names. Absent or empty admits nobody. */
  operators?: ReadonlySet<string>;
};

/**
 * Scalars only (#259, spec D6).
 *
 * The endpoint was asked for on the condition that it cannot return a row, and
 * two things hold that together. `stats` below is typed as this interface, so a
 * field outside it is an excess-property error and a required field added to it
 * must be given a value there. And the "answers scalars only" test fails on any
 * value in the response that is not a number or a boolean. The type alone would
 * miss a row spread into the body, because `json` takes `unknown`; the test is
 * what catches that.
 */
export interface PlatformStats {
  accounts: number;
  free: number;
  paid: number;
  paidCapped: boolean;
}

// ponytail: 1000 grants, not tuned. One grant per paying key; at three paid
// accounts this is years of headroom. paidCapped is what says when it is not.
export const MAX_GRANTS_COUNTED = 1000;

const PATH = "/operator/stats";

/** `undefined` for any other path, so the server carries on. */
export async function statsRoutes(request: Request, deps: StatsRouteDeps): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (path !== PATH) return undefined;
  const origin = allowedOrigin(request, deps.panelOrigins);
  // Before the caller is read: a browser sends no credential on a preflight.
  if (request.method === "OPTIONS") return preflightResponse(origin);
  try {
    const who = await deps.caller(request);
    if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
    /**
     * Names no mechanism, unlike the refusals on /admin/*, which say "limited to
     * the user ids BELLMAN_OPERATORS lists" and are read only by someone already
     * holding a bearer token. Any signed-in customer can try this URL (D4).
     *
     * Ahead of the method check on purpose (ruling R2): a 405 would confirm the
     * route to someone who may not know it is there.
     */
    if (!deps.operators?.has(who.identity.userId)) {
      return problem(403, "not_available", "this account has no platform stats", origin);
    }
    if (request.method !== "GET") return methodNotAllowed("GET", origin);

    // No second argument: listGrants(limit, null) filters to the grants with no
    // org, and undefined is what asks for every org's. Both stores drop a
    // lapsed grant before the bound is applied, so neither fills the window.
    const [accounts, grants] = await Promise.all([
      deps.store.countUsers(),
      deps.store.listGrants(MAX_GRANTS_COUNTED),
    ]);
    const paid = grants.filter((g) => g.plan !== "free").length;
    const stats: PlatformStats = {
      accounts,
      // Floored: a grant for a key that has never signed in makes this
      // negative, and a negative count of people is worse than a floor.
      free: Math.max(0, accounts - paid),
      paid,
      // The scan's bound, not the paid count (ruling R1): free grants come out
      // of `paid`, so `paid` can sit below the limit on a scan that reached it.
      paidCapped: grants.length === MAX_GRANTS_COUNTED,
    };
    return json(200, stats, origin);
  } catch (err) {
    console.error(`${request.method} ${path} failed:`, err);
    return problem(500, "internal", "the request failed on the server", origin);
  }
}
