import type { Entitlements, Identity, Plan } from "./types.js";

/**
 * Plan entitlements. These gate session CREATION only — joining is free on
 * every plan, so being invited into a room never depends on what you pay.
 *
 * Declared cheapest first: billing ranks plans by this order, and a user
 * paying for two gets the higher one (src/billing/ledger.ts).
 */
export const ENTITLEMENTS: Record<Plan, Entitlements> = {
  free: {
    modes: ["pair"],
    monthlyCreates: 20,
    orgScoping: false,
    audit: false,
    // ponytail: per-room blob ceilings (#183), not tuned: 50 MB, 500 MB, 5 GB.
    // A room is what a plan already rations, so nothing here is monthly.
    blobBytesPerRoom: 50 * 1024 * 1024,
    hostedRooms: 0,
    hostUnitsPerRoom: 0,
    // How long a closed room is kept before the purge (#65, D1): a week, a year, and for
    // max and team until someone with the right to delete it does.
    retainAfterCloseMs: 7 * 24 * 60 * 60 * 1000,
  },
  pro: {
    modes: ["pair", "swarm"],
    monthlyCreates: 500,
    orgScoping: false,
    audit: false,
    blobBytesPerRoom: 500 * 1024 * 1024,
    hostedRooms: 0,
    hostUnitsPerRoom: 0,
    retainAfterCloseMs: 365 * 24 * 60 * 60 * 1000,
  },
  // Max sells the hosted seat: three hosted rooms open at once, 3,000 units each a
  // month (the hosted seat spec, D2 and D3, and ADR 0002), over pro's creates, blob ceiling and how
  // long a closed room is kept (#65). tests/auth.test.ts pins the five
  // differences. Not on sale yet: no Stripe price names it and
  // STRIPE_PAYMENT_LINKS carries no `max` entry, so /upgrade/max stays a 404
  // until the site follow-up adds both (spec D2).
  max: {
    modes: ["pair", "swarm"],
    monthlyCreates: 2000,
    orgScoping: false,
    audit: false,
    blobBytesPerRoom: 5 * 1024 * 1024 * 1024,
    hostedRooms: 3,
    hostUnitsPerRoom: 3000,
    retainAfterCloseMs: null,
  },
  team: {
    modes: ["pair", "swarm"],
    monthlyCreates: 5000,
    orgScoping: true,
    audit: true,
    blobBytesPerRoom: 5 * 1024 * 1024 * 1024,
    hostedRooms: 5,
    hostUnitsPerRoom: 3000,
    retainAfterCloseMs: null,
  },
};

/**
 * Identity resolution for static bearer keys: the operator's BELLMAN_KEYS map,
 * or the dev table below when no map is set. The Worker never calls
 * resolveIdentity without a map.
 *
 * OAuth 2.1 with dynamic client registration did not replace this; it landed
 * beside it (#7, PR #21). resolveCaller in src/worker.ts tries an access token
 * first and falls back to resolveIdentity.
 */
const DEV_KEYS: Record<string, Identity> = {
  "qk_dev_jesse": {
    userId: "u_jesse",
    orgId: "org_codenerd",
    plan: "team",
    role: "admin",
    label: "jesse@codenerd",
  },
  "qk_dev_peer": {
    userId: "u_peer",
    orgId: "org_codenerd",
    plan: "free",
    role: "member",
    label: "peer@codenerd",
  },
  "qk_dev_outsider": {
    userId: "u_outsider",
    orgId: null,
    plan: "free",
    role: "member",
    label: "outsider",
  },
};

/**
 * Workers has no `process.env` — the key map arrives on the fetch handler's
 * `env` instead. Callers there pass it explicitly; the Node path falls back to
 * the environment, so existing call sites and tests are unchanged.
 */
function envKeys(): string | undefined {
  return typeof process !== "undefined" && process.env
    ? process.env.BELLMAN_KEYS
    : undefined;
}

const ROLES: ReadonlySet<string> = new Set(["member", "admin"]);

/**
 * Whether a value read from a key table is an identity: every field present
 * with its declared type, the plan one this server prices, the role one it
 * knows. A key map is operator-written JSON, and a value that is not an
 * identity (a string, a partial object, a plan nobody defined) must not become
 * a caller whose undefined fields every later check reads as unrestricted.
 */
export function isIdentity(v: unknown): v is Identity {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.userId === "string" && o.userId.length > 0
    && (typeof o.orgId === "string" || o.orgId === null)
    && typeof o.plan === "string" && Object.hasOwn(ENTITLEMENTS, o.plan)
    && typeof o.role === "string" && ROLES.has(o.role)
    && typeof o.label === "string"
  );
}

/**
 * The one way a token reads a key table. Both tables are plain objects, and a
 * plain object answers for every name on Object.prototype: `table[token]` with
 * a bearer of `constructor` once returned the Object function, non-null, and it
 * passed as an identity with every field undefined. Own keys only, and only
 * values that are identities.
 */
function lookup(table: unknown, token: string): Identity | null {
  if (typeof table !== "object" || table === null) return null;
  if (!Object.hasOwn(table, token)) return null;
  const v = (table as Record<string, unknown>)[token];
  return isIdentity(v) ? v : null;
}

export function resolveIdentity(
  authHeader: string | undefined,
  keysJson?: string
): Identity | null {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  /**
   * BELLMAN_KEYS is AUTHORITATIVE wherever it is set: once real keys are
   * configured the dev table is out of play entirely. Falling through to it
   * would leave `qk_dev_jesse` — team plan, admin role, and printed in the
   * README — valid on a deployed server. Any deployment must set this.
   */
  const fromEnv = keysJson ?? envKeys(); // JSON map of key -> identity
  if (fromEnv) {
    try {
      return lookup(JSON.parse(fromEnv), token);
    } catch {
      // Fail closed. A malformed key map must reject every request rather
      // than silently downgrade the server to the dev identities.
      console.error("BELLMAN_KEYS is set but is not valid JSON — rejecting all requests");
      return null;
    }
  }

  return lookup(DEV_KEYS, token);
}

export function entitlementsFor(identity: Identity): Entitlements {
  return ENTITLEMENTS[identity.plan];
}

/**
 * The plan a key table gives this user, or null when no key in it names them (I7). A hosted
 * room knows its creator by user id alone, and its seat reads that creator's plan again at
 * each month turn. The table is the one `resolveIdentity` reads: `keysJson` when given, else
 * BELLMAN_KEYS, else the dev keys; `null` is no table at all, which is how the Worker asks,
 * since it never reads the dev keys (`resolveCaller`). Two keys for one user count for the
 * higher plan, as billing ranks plans: cheapest first in ENTITLEMENTS.
 */
export function keyedPlan(userId: string, keysJson?: string | null): Plan | null {
  if (keysJson === null) return null;
  const raw = keysJson ?? envKeys();
  let table: unknown = DEV_KEYS;
  if (raw) {
    try {
      table = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof table !== "object" || table === null) return null;
  const ranks = Object.keys(ENTITLEMENTS);
  let best: Plan | null = null;
  for (const v of Object.values(table)) {
    if (!isIdentity(v) || v.userId !== userId) continue;
    if (best === null || ranks.indexOf(v.plan) > ranks.indexOf(best)) best = v.plan;
  }
  return best;
}
