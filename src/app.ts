import express, { type Express } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { resolveIdentity } from "./auth.js";
import { buildServer } from "./server.js";
import type { BellmanStore } from "./store.js";

/**
 * Builds the HTTP surface around an injected store.
 *
 * Kept separate from the process bootstrap so tests can mount the real app on
 * an ephemeral port with their own store, and so a Workers/DO port can reuse
 * the routing without Node's listener.
 */
export function createApp(store: BellmanStore): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, service: "bellman", at: new Date().toISOString() });
  });

  /**
   * Stateless streamable HTTP: a fresh transport + identity-bound McpServer per
   * request. Session state lives in the store, not the transport — the same
   * shape a Durable Objects port needs, where each Bellman session becomes one DO.
   */
  app.post("/mcp", async (req, res) => {
    const identity = resolveIdentity(req.header("authorization"));
    if (!identity) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized: missing or unknown bearer key" },
        id: null,
      });
      return;
    }
    try {
      const server = buildServer(identity, store);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request failed:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  return app;
}
