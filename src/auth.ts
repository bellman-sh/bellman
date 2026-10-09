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
    hostedRoomsPerMonth: 0,
    hostUnitsPerRoom: 0,
  },
  pro: {
    modes: ["pair", "swarm"],
    monthlyCreates: 500,
    orgScoping: false,
    audit: false,
    blobBytesPerRoom: 500 * 1024 * 1024,
    hostedRoomsPerMonth: 0,
    hostUnitsPerRoom: 0,
  },
  // Max sells the hosted seat: three hosted rooms a month, 3,000 units each
  // (the hosted seat spec, D2 and D3), over pro's creates and blob ceiling.
  // tests/auth.test.ts pins the four differences. Not on sale yet: no Stripe
  // price names it and STRIPE_PAYMENT_LINKS carries no `max` entry, so
  // /upgrade/max stays a 404 until the site follow-up adds both (spec D2).
  max: {
    modes: ["pair", "swarm"],
    monthlyCreates: 2000,
    orgScoping: false,
    audit: false,
    blobBytesPerRoom: 5 * 1024 * 1024 * 1024,
    hostedRoomsPerMonth: 3,
    hostUnitsPerRoom: 3000,
  },
  team: {
    modes: ["pair", "swarm"],
    monthlyCreates: 5000,
    orgScoping: true,
    audit: true,
    blobBytesPerRoom: 5 * 1024 * 1024 * 1024,
    hostedRoomsPerMonth: 5,
    hostUnitsPerRoom: 3000,
  },
};

/**
 * Identity resolution boundary.
 *
 * v1: static bearer keys (works with Claude custom connectors today).
 * Cross-provider path: replace this function with OAuth 2.1 + Dynamic Client
 * Registration token introspection — ChatGPT-style remote connectors require
 * it. Nothing outside this file changes when that lands.
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
