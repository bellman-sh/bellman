import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { resolveIdentity } from "./auth.js";
import { buildServer, store } from "./server.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "quorai", at: new Date().toISOString() });
});

/**
 * Stateless streamable HTTP: a fresh transport + identity-bound McpServer per
 * request. Session state lives in the store, not the transport — the same
 * shape a Durable Objects port needs, where each Quorai session becomes one DO.
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

// Periodic expiry of sessions and pending connect tokens.
setInterval(() => store.sweep(Date.now()), 60_000).unref();

const port = parseInt(process.env.PORT || "3900", 10);
app.listen(port, () => {
  console.error(`quorai-mcp-server listening on http://localhost:${port}/mcp`);
});
