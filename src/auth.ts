import type { Entitlements, Identity, Plan } from "./types.js";

/**
 * Plan entitlements. The asymmetry: these gate session CREATION only.
 * Joining is free on every plan — that keeps the viral loop open.
 */
export const ENTITLEMENTS: Record<Plan, Entitlements> = {
  free: {
    modes: ["pair"],
    maxMembers: 2,
    sessionTtlMs: 4 * 60 * 60 * 1000,
    monthlyCreates: 20,
    orgScoping: false,
    audit: false,
  },
  pro: {
    modes: ["pair", "swarm"],
    maxMembers: 8,
    sessionTtlMs: 72 * 60 * 60 * 1000,
    monthlyCreates: 500,
    orgScoping: false,
    audit: false,
  },
  team: {
    modes: ["pair", "swarm"],
    maxMembers: 25,
    sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
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

export function resolveIdentity(authHeader: string | undefined): Identity | null {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  /**
   * BELLMAN_KEYS is AUTHORITATIVE wherever it is set: once real keys are
   * configured the dev table is out of play entirely. Falling through to it
   * would leave `qk_dev_jesse` — team plan, admin role, and printed in the
   * README — valid on a deployed server. Any deployment must set this.
   */
  const fromEnv = process.env.BELLMAN_KEYS; // JSON map of key -> identity
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
