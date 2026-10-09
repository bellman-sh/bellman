import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import express, { type Express, type Request as ExpressRequest, type Response as ExpressResponse } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { resolveIdentity } from "./auth.js";
import type { BlobStore } from "./blobs.js";
import { presetRoutes } from "./http/presets.js";
import { roomRoutes } from "./http/rooms.js";
import { buildServer } from "./server.js";
import type { BellmanStore } from "./store.js";

/**
 * Builds the HTTP surface around an injected store.
 *
 * Kept separate from the process bootstrap so tests can mount the real app on
 * an ephemeral port with their own store, and so a Workers/DO port can reuse
 * the routing without Node's listener. The room routes (#183) are the one piece
 * shared as a module rather than re-typed: `src/http/rooms.ts` serves both, and
 * this file only translates.
 */
export function createApp(store: BellmanStore, blobs: BlobStore): Express {
  const app = express();

  /**
   * The room routes (#183) and the preset routes, mounted ahead of the JSON body parser so an
   * upload's body reaches the route as the stream it was sent as. Express
   * speaks Node's req/res and the module speaks Request/Response, so this
   * translates: the headers and the body in (streamed, duplex half), the
   * status, headers and body out. The Node server is local development and
   * what `npm run smoke` and a bridge's bellman_upload point at, so the doors
   * open here too — over the same MemoryBlobStore `buildServer` heads, with
   * the static key map as the only caller (there is no OAuth and no panel here).
   */
  /** One shared route module, translated: Node's request in as the web one it reads, its Response out. */
  const serve = (routes: (request: Request) => Promise<Response | undefined>) =>
    async (req: ExpressRequest, res: ExpressResponse) => {
      const answer = await routes(toRequest(req));
      if (!answer) {
        res.status(404).send("Not found");
        return;
      }
      res.status(answer.status);
      answer.headers.forEach((value, name) => res.setHeader(name, value));
      if (!answer.body) {
        res.end();
        return;
      }
      Readable.fromWeb(answer.body as unknown as NodeReadableStream).pipe(res);
    };
  const caller = async (request: Request) => {
    const identity = resolveIdentity(request.headers.get("authorization") ?? undefined);
    return identity ? { identity, via: "bearer" as const } : null;
  };
  app.use("/rooms", serve((request) => roomRoutes(request, { store, blobs, caller, panelOrigins: [] })));
  app.use("/presets", serve((request) => presetRoutes(request, { store, caller, panelOrigins: [] })));

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
      const server = buildServer(identity, store, blobs);
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

/** Node's request as the web one the route reads: the full original URL, every header, the body as a stream. */
function toRequest(req: ExpressRequest): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) for (const each of value) headers.append(name, each);
  }
  const bodiless = req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";
  const init: RequestInit & { duplex?: "half" } = { method: req.method, headers };
  if (!bodiless) {
    init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(`${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl}`, init);
}
