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
    maxMembers: 2,
    monthlyCreates: 20,
    orgScoping: false,
    audit: false,
  },
  pro: {
    modes: ["pair", "swarm"],
    maxMembers: 8,
    monthlyCreates: 500,
    orgScoping: false,
    audit: false,
  },
  // Team-sized rooms for one person, without an org. Org scoping, the audit
  // log and 30-day rooms stay team-only: that is why a company still buys team.
  max: {
    modes: ["pair", "swarm"],
    maxMembers: 25,
    monthlyCreates: 2000,
    orgScoping: false,
    audit: false,
  },
  team: {
    modes: ["pair", "swarm"],
    maxMembers: 25,
    monthlyCreates: 5000,
    orgScoping: true,
    audit: true,
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
