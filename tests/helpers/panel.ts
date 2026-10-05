import { MemoryAuthStore, SESSION_TTL_MS, type PanelSession } from "../../src/oauth/storage.js";
import { MemoryStore } from "../../src/store.js";
import { handleOAuth, type OAuthConfig } from "../../src/oauth/routes.js";
import type { Identity } from "../../src/types.js";

export const ISSUER = "https://mcp.example.test";
export const RESOURCE = "https://mcp.example.test/mcp";
export const PANEL = "https://dash.example.test";
export const COOKIE = "__Host-bellman_session";

// Frozen: seedSession hands this to the store by reference, and a store that keeps
// what it is given would show a method that changed it in place to every test that
// shares it. A write to a frozen object throws.
export const IDENTITY: Identity = Object.freeze({
  userId: "u_github_4242", orgId: null, plan: "free", role: "member",
  label: "jesse@example.dev",
});

/**
 * Someone else, for the sessions a route has no business touching. Their plan is
 * not one any test re-resolves to, so a write that lands on the wrong record
 * shows in the answer.
 */
export const BYSTANDER: Identity = Object.freeze({
  userId: "u_github_9999", orgId: null, plan: "pro", role: "member",
  label: "sam@example.dev",
});

/** GitHub stubbed at the fetch boundary; everything else is the real thing. */
export const fakeFetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.startsWith("https://github.com/login/oauth/access_token")) {
    return Response.json({ access_token: "gh_upstream_token" });
  }
  if (url === "https://api.github.com/user") {
    return Response.json({ id: 4242, login: "mcfearsome", email: null });
  }
  if (url === "https://api.github.com/user/emails") {
    return Response.json([{ email: "jesse@example.dev", primary: true, verified: true }]);
  }
  return new Response("unexpected upstream call", { status: 500 });
}) as typeof fetch;

export function panelConfig(over: Partial<OAuthConfig> = {}): OAuthConfig {
  return {
    issuer: ISSUER,
    resource: RESOURCE,
    secret: "test-signing-secret",
    store: new MemoryAuthStore(),
    credentials: { github: { clientId: "gh-id", clientSecret: "gh-secret" } },
    overrides: {},
    panelOrigins: [PANEL],
    plans: new MemoryStore(),
    fetchImpl: fakeFetch,
    ...over,
  };
}

/** handleOAuth, asserting it handled the path. */
export const routeWith = (config: OAuthConfig) => async (request: Request) =>
  (await handleOAuth(request, config))!;

/** A live session in the store. Returns its id. */
export async function seedSession(
  config: OAuthConfig,
  id = "sid",
  over: Partial<PanelSession> = {}
): Promise<string> {
  const now = Date.now();
  await config.store.putSession(id, {
    identity: IDENTITY, plan_source: "default", identity_keys: ["github:4242"],
    created_at: now, last_used_at: now, replanned_at: now,
    expires_at: now + SESSION_TTL_MS, ...over,
  });
  return id;
}

/** A live session for someone else. Returns its id. */
export const seedBystander = (
  config: OAuthConfig,
  id = "bystander",
  over: Partial<PanelSession> = {}
) =>
  seedSession(config, id, {
    identity: BYSTANDER, plan_source: "grant", identity_keys: ["github:9999"], ...over,
  });

/** A request carrying a session cookie. */
export const withCookie = (path: string, id: string, init: RequestInit = {}) =>
  new Request(`${ISSUER}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie: `${COOKIE}=${id}` },
  });
