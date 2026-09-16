/// <reference types="@cloudflare/workers-types" />
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { resolveIdentity } from "./auth.js";
import { buildServer } from "./server.js";
import { DurableObjectStore, type BellmanEnv } from "./store-do.js";

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

const unauthorized = () =>
  Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: missing or unknown bearer key" },
      id: null,
    },
    { status: 401 }
  );

export default {
  async fetch(request: Request, env: BellmanEnv): Promise<Response> {
    const url = new URL(request.url);

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
     * Fail closed with no key map. resolveIdentity falls back to the dev table
     * when handed nothing, and nodejs_compat means `process` exists here — so
     * without this guard a deploy that forgot the secret would serve
     * qk_dev_jesse (team plan, admin role) on a public URL. Local runs supply
     * this through .dev.vars, so dev exercises the same path as production.
     */
    if (!env.BELLMAN_KEYS) {
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

    // Passed explicitly: there is no process.env here, and this keeps the dev
    // key table unreachable on a deployed server.
    const identity = resolveIdentity(
      request.headers.get("authorization") ?? undefined,
      env.BELLMAN_KEYS
    );
    if (!identity) return unauthorized();

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
} satisfies ExportedHandler<BellmanEnv>;
