/// <reference types="@cloudflare/workers-types" />
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { resolveIdentity } from "./auth.js";
import { buildServer } from "./server.js";
import { DurableObjectStore, type BellmanEnv } from "./store-do.js";
import { AuthDO, AuthStore } from "./oauth/store.js";
import { handleOAuth, identityFromAccessToken, unauthorizedHeaders, type OAuthConfig } from "./oauth/routes.js";
import { parseOverrides, type ProviderCredentials, type ProviderName } from "./oauth/providers.js";
import { canonicalResource } from "./oauth/tokens.js";

/**
 * Cloudflare Workers entry point.
 *
 * The routing mirrors src/app.ts deliberately — same two endpoints, same
 * stateless-per-request transport, same identity binding. What differs is only
 * the runtime seam: Workers speaks Request/Response, so this uses the SDK's
 * WebStandardStreamableHTTPServerTransport directly, where the Node path uses
 * StreamableHTTPServerTransport (itself a thin wrapper around this same class).
 *
 * Durable Object classes must be exported from the entry module for the
 * runtime to bind them.
 */
export { SessionDO, RegistryDO, AuditDO } from "./store-do.js";
export { AuthDO } from "./oauth/store.js";

/** Worker bindings: the session stores, plus the authorization server's. */
export interface WorkerEnv extends BellmanEnv {
  AUTH: DurableObjectNamespace<AuthDO>;
  /** Signs access tokens. Absent means OAuth sign-in is switched off. */
  BELLMAN_TOKEN_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Optional JSON: upstream identity -> a Bellman identity with a plan/org. */
  BELLMAN_USERS?: string;
}

/**
 * OAuth is configured per request because issuer and resource come from the
 * hostname actually being used, so a token minted for mcp.bellman.sh is not
 * accepted on any other hostname this Worker answers.
 */
function oauthConfig(request: Request, env: WorkerEnv): OAuthConfig | undefined {
  if (!env.BELLMAN_TOKEN_SECRET || !env.AUTH) return undefined;
  const origin = new URL(request.url).origin;
  const credentials: Partial<Record<ProviderName, ProviderCredentials>> = {};
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    credentials.github = { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
  }
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    credentials.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  }
  return {
    issuer: origin,
    resource: canonicalResource(`${origin}/mcp`),
    secret: env.BELLMAN_TOKEN_SECRET,
    store: new AuthStore(env.AUTH),
    credentials,
    overrides: parseOverrides(env.BELLMAN_USERS),
  };
}

const unauthorized = (oauth?: OAuthConfig) =>
  Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: missing or invalid credentials" },
      id: null,
    },
    // With OAuth on, the 401 has to say where discovery starts, or a client
    // has no way to begin the flow (RFC 9728 section 5.1).
    { status: 401, headers: oauth ? unauthorizedHeaders(oauth) : undefined }
  );

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const oauth = oauthConfig(request, env);

    if (oauth) {
      const handled = await handleOAuth(request, oauth);
      if (handled) return handled;
    }

    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({
        ok: true,
        service: "bellman",
        runtime: "workers",
        at: new Date().toISOString(),
      });
    }

    if (url.pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
    }

    /**
     * Fail closed with neither a key map nor OAuth. resolveIdentity falls back
     * to the dev table when handed nothing, and nodejs_compat means `process`
     * exists here — so without this guard a deploy that forgot the secret would
     * serve qk_dev_jesse (team plan, admin role) on a public URL. Local runs
     * supply this through .dev.vars, so dev exercises the same path production
     * does.
     */
    if (!env.BELLMAN_KEYS && !oauth) {
      console.error("BELLMAN_KEYS is unset — refusing to serve. Set it with: wrangler secret put BELLMAN_KEYS");
      return Response.json(
        {
          jsonrpc: "2.0",
          error: { code: -32002, message: "Server is not configured with an identity key map" },
          id: null,
        },
        { status: 503 }
      );
    }

    // An OAuth access token first, then the static key map. The bearer key path
    // stays for stdio clients and scripts, which the spec says should take
    // credentials from the environment rather than run an OAuth flow.
    const header = request.headers.get("authorization") ?? undefined;
    const bearer = header?.replace(/^Bearer\s+/i, "").trim() ?? "";
    let identity = oauth && bearer ? await identityFromAccessToken(bearer, oauth) : null;
    if (!identity && env.BELLMAN_KEYS) identity = resolveIdentity(header, env.BELLMAN_KEYS);
    if (!identity) return unauthorized(oauth);

    try {
      const server = buildServer(identity, new DurableObjectStore(env));
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      return await transport.handleRequest(request);
    } catch (err) {
      console.error("MCP request failed:", err);
      return Response.json(
        { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null },
        { status: 500 }
      );
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
