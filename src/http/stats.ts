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
import { PURCHASE } from "../billing/grants.js";
import { allowedOrigin, preflightResponse } from "../oauth/browser.js";
import type { Identity } from "../types.js";
import { json, methodNotAllowed, problem, type RoomRouteDeps } from "./rooms.js";

export type StatsRouteDeps = Pick<RoomRouteDeps, "store" | "caller" | "panelOrigins"> & {
  /** The user ids BELLMAN_OPERATORS names. Undefined or empty admits nobody. */
  operators: ReadonlySet<string> | undefined;
  /**
   * BELLMAN_USERS as `parseOverrides` returns it: identity key to identity. Only the
   * plan is read. Undefined or empty adds no one.
   */
  overrides: Readonly<Record<string, Identity>> | undefined;
  /**
   * `honourPurchases` as the OAuth config carries it, which is `billingSettings(env).applyPlans`:
   * whether a grant billing wrote counts. True only for BELLMAN_BILLING `on` with both Stripe
   * secrets set. False leaves purchase grants out, as sign-in does. Undefined counts them, as
   * sign-in reads it (`!== false`).
   */
  honourPurchases: boolean | undefined;
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
/**
 * The accounts pane on the panel's stats page: who has signed in, first sign-in first, each an id and two dates.
 * Rows, which `/operator/stats` is built never to answer (#259 asked that a panel needing rows start a separate
 * console; the owner asked for the pane on the dash instead, 2026-10-24). So a path of its own, on the same gate,
 * and the counts' type stays scalars only. Read-only: a route that writes stays on `/admin/*` behind a bearer token.
 */
const ACCOUNTS_PATH = "/operator/accounts";

// ponytail: the first 500 by first sign-in and no paging, a table on one page; `total` says when there are more.
export const MAX_ACCOUNTS_ANSWERED = 500;

/** `undefined` for any other path, so the server carries on. */
export async function statsRoutes(request: Request, deps: StatsRouteDeps): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (path !== PATH && path !== ACCOUNTS_PATH) return undefined;
  const origin = allowedOrigin(request, deps.panelOrigins);
  // Before the caller is read: a browser sends no credential on a preflight.
  if (request.method === "OPTIONS") return preflightResponse(origin);
  try {
    const who = await deps.caller(request);
    if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
    /**
     * Names no mechanism, unlike the refusals on /admin/*, which name theirs (the one on
     * /admin/handles says "limited to the user ids BELLMAN_OPERATORS lists") and are read
     * only by someone already holding a bearer token. Any signed-in customer can try this
     * URL (D4).
     *
     * Ahead of the method check on purpose (ruling R2). That does not hide the route:
     * the 401 above and this 403 already confirm it. It keeps the method back. Past
     * the preflight, a caller who is not an operator gets the same 401 or 403 whatever
     * method it sends, so only an operator is told, by the 405, which one the route takes.
     */
    if (!deps.operators?.has(who.identity.userId)) {
      return problem(403, "not_available", "this account has no platform stats", origin);
    }
    if (request.method !== "GET") return methodNotAllowed("GET", origin);

    if (path === ACCOUNTS_PATH) {
      const [total, users] = await Promise.all([deps.store.countUsers(), deps.store.listUsers(MAX_ACCOUNTS_ANSWERED)]);
      return json(200, {
        total,
        accounts: users.map((u) => ({
          user_id: u.userId,
          first_seen_at: new Date(u.firstSeenAt).toISOString(),
          last_seen_at: new Date(u.lastSeenAt).toISOString(),
          github_login: u.githubLogin ?? null,
        })),
      }, origin);
    }

    // No second argument: listGrants(limit, null) filters to the grants with no
    // org, and undefined is what asks for every org's. Both stores drop a
    // lapsed grant before the bound is applied, so neither fills the window.
    const [accounts, grants] = await Promise.all([
      deps.store.countUsers(),
      deps.store.listGrants(MAX_GRANTS_COUNTED),
    ]);
    // Paid is an identity key whose plan is not free, from a grant or from BELLMAN_USERS.
    // An override outranks a grant on the same key, as at sign-in (decidePlan), so a key
    // in both counts once, at the override's plan. A purchase grant counts unless
    // honourPurchases is false, as at sign-in (firstGrant); in the Worker that is applyPlans,
    // BELLMAN_BILLING on with both Stripe secrets set. A grant anyone else wrote and an
    // override count whatever honourPurchases says. parseOverrides casts its JSON without
    // checking it: an entry can be null or lack a plan, and neither is paid.
    // ponytail: keys, not people. Someone filed under two keys (a subject and an address)
    // counts twice; UserRecord keeps no keys to join them by.
    const honourPurchases = deps.honourPurchases !== false;
    const plans = new Map<string, unknown>();
    for (const g of grants) {
      if (honourPurchases || g.source !== PURCHASE) plans.set(g.key, g.plan);
    }
    for (const [key, entry] of Object.entries<Identity>(deps.overrides ?? {})) {
      if (entry) plans.set(key, entry.plan);
    }
    const paid = [...plans.values()].filter((plan) => typeof plan === "string" && plan !== "free").length;
    const stats: PlatformStats = {
      accounts,
      // Floored: a grant or an override for a key that has never signed in, or a
      // person filed under two keys, can push `paid` past `accounts`, which would make
      // this negative, and a negative count of people is worse than a floor.
      free: Math.max(0, accounts - paid),
      paid,
      // The scan's bound, not the paid count (ruling R1). A grant can sit in the window without
      // counting as paid: its plan is free, it is a purchase while honourPurchases is false, or
      // an override gives its key no paid plan. So `paid` can sit below the limit on a scan that
      // reached it. Overrides can add keys the scan never saw, so `paid` can sit above the limit
      // on one that did not.
      paidCapped: grants.length === MAX_GRANTS_COUNTED,
    };
    return json(200, stats, origin);
  } catch (err) {
    console.error(`${request.method} ${path} failed:`, err);
    return problem(500, "internal", "the request failed on the server", origin);
  }
}
