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
    retainAfterCloseMs: 365 * 24 * 60 * 60 * 1000,
  },
  // Coming soon. With no room lifetime and no member cap (#18), max differs from
  // pro by creates, the blob ceiling and how long a closed room is kept (#65), so
  // nothing sells it: no Stripe price names it and
  // STRIPE_PAYMENT_LINKS carries no `max` entry, so /upgrade/max stays a 404. It
  // stays here because a hand grant still works and because it is the shape
  // hosted agents (#188, #189) attach their facet to. tests/auth.test.ts pins
  // the difference, so a facet landing is a deliberate edit to that line.
  max: {
    modes: ["pair", "swarm"],
    monthlyCreates: 2000,
    orgScoping: false,
    audit: false,
    blobBytesPerRoom: 5 * 1024 * 1024 * 1024,
    retainAfterCloseMs: null,
  },
  team: {
    modes: ["pair", "swarm"],
    monthlyCreates: 5000,
    orgScoping: true,
    audit: true,
    blobBytesPerRoom: 5 * 1024 * 1024 * 1024,
    retainAfterCloseMs: null,
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
      const parsed = JSON.parse(fromEnv) as Record<string, Identity>;
      return parsed[token] ?? null;
    } catch {
      // Fail closed. A malformed key map must reject every request rather
      // than silently downgrade the server to the dev identities.
      console.error("BELLMAN_KEYS is set but is not valid JSON — rejecting all requests");
      return null;
    }
  }

  return DEV_KEYS[token] ?? null;
}

export function entitlementsFor(identity: Identity): Entitlements {
  return ENTITLEMENTS[identity.plan];
}
