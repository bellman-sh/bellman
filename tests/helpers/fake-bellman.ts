import {
  handleOAuth, identityFromAccessToken, unauthorizedHeaders, type OAuthConfig,
} from "../../src/oauth/routes.js";
import { MemoryAuthStore } from "../../src/oauth/storage.js";
import type { Identity } from "../../src/types.js";

/**
 * A `fetch` that is the real Bellman: the real handleOAuth for every OAuth
 * path, and a minimal JSON-RPC /mcp that demands a token minted for itself.
 * Nothing about the protocol is mocked — only the upstream identity provider
 * and the network are.
 */

export const ISSUER = "https://mcp.example.test";
export const RESOURCE = "https://mcp.example.test/mcp";

const upstream = (async (input: RequestInfo | URL) => {
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

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export interface FakeBellman {
  fetch: typeof fetch;
  config: OAuthConfig;
  /** Every /register body the client sent — length is the registration count. */
  registrations: unknown[];
  /** Drives the browser half: authorize page -> provider -> loopback. */
  browser(authorizeUrl: URL): Promise<void>;
  /**
   * Mint a fresh token pair from a refresh token, the way a SECOND bridge
   * would. Spends the one given — refresh tokens rotate on use — so afterwards
   * that token is dead and the pair returned is what the file would hold.
   */
  refresh(refreshToken: string, clientId: string): Promise<TokenPair>;
}

export interface FakeBellmanOptions {
  overrides?: Record<string, Identity>;
  /**
   * The server's own origin. A second fake needs a DIFFERENT one rather than a
   * URL rewrite: tokens carry an RFC 8707 resource indicator derived from the
   * server URL, and /authorize refuses any resource that is not its own
   * (`invalid_target`). Two servers means two origins, all the way down.
   */
  origin?: string;
}

export function fakeBellman({ overrides = {}, origin = ISSUER }: FakeBellmanOptions = {}): FakeBellman {
  const config: OAuthConfig = {
    issuer: origin,
    resource: `${origin}/mcp`,
    secret: "test-signing-secret",
    store: new MemoryAuthStore(),
    credentials: { github: { clientId: "gh-id", clientSecret: "gh-secret" } },
    overrides,
    fetchImpl: upstream,
  };
  const registrations: unknown[] = [];

  const serve: typeof fetch = async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    const url = new URL(request.url);

    if (url.pathname === "/register" && request.method === "POST") {
      registrations.push(await request.clone().json());
    }

    if (url.pathname !== "/mcp") {
      const handled = await handleOAuth(request, config);
      return handled ?? new Response("not found", { status: 404 });
    }

    // ------------------------------------------------------------- /mcp
    if (request.method === "GET") return new Response("no sse", { status: 405 });

    const header = request.headers.get("authorization") ?? "";
    const identity = header.toLowerCase().startsWith("bearer ")
      ? await identityFromAccessToken(header.slice(7).trim(), config)
      : null;
    if (!identity) {
      return new Response("unauthorized", { status: 401, headers: unauthorizedHeaders(config) });
    }

    const body = (await request.json()) as { method?: string; id?: unknown };
    if (body.id === undefined) return new Response(null, { status: 202 }); // a notification

    const result =
      body.method === "initialize"
        ? {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "bellman", version: "0.1.0" },
          }
        : body.method === "tools/list"
          ? { tools: [{ name: "bellman_start", description: "start", inputSchema: { type: "object" } }] }
          : {};

    return Response.json(
      { jsonrpc: "2.0", id: body.id, result },
      { headers: { "content-type": "application/json" } }
    );
  };

  return {
    fetch: serve,
    config,
    registrations,
    /**
     * What a human's browser does: load /authorize, pick GitHub, let the
     * provider come back, and follow the final redirect to the loopback — that
     * last hop with the REAL fetch, because the listener is a real server.
     */
    async browser(authorizeUrl: URL): Promise<void> {
      const page = await (await serve(authorizeUrl)).text();
      const req = /\/authorize\/github\?req=([^"]+)/.exec(page)?.[1];
      if (!req) throw new Error(`no provider link on the authorize page: ${page.slice(0, 200)}`);
      const back = await serve(`${origin}/callback/github?code=gh_code&state=${req}`, { redirect: "manual" });
      const location = back.headers.get("location");
      if (!location) throw new Error(`callback did not redirect: ${back.status}`);
      /**
       * One connection per request. fetch pools keep-alive connections by
       * origin, and every test here rebinds the same loopback ports, so a
       * pooled connection to a listener an earlier test closed can be handed to
       * this request, which then fails with ECONNRESET. Which pair of tests
       * trips it depends on event-loop timing, so no delay cures it; not
       * pooling does.
       */
      await fetch(location, { headers: { connection: "close" } });
    },
    async refresh(refreshToken, clientId) {
      const response = await serve(`${origin}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
        }).toString(),
      });
      if (!response.ok) throw new Error(`refresh failed: ${response.status} ${await response.text()}`);
      return (await response.json()) as TokenPair;
    },
  };
}
