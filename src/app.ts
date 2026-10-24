import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import express, { type Express, type Request as ExpressRequest, type Response as ExpressResponse } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { a2aRoutes } from "./a2a/routes.js";
import { resolveIdentity } from "./auth.js";
import type { BlobStore } from "./blobs.js";
import { handleRoutes } from "./http/handles.js";
import { moderationRoutes } from "./http/moderation.js";
import { orgRoutes } from "./http/orgs.js";
import { scimRoutes } from "./http/scim.js";
import { presetRoutes } from "./http/presets.js";
import { publicRoutes } from "./http/public.js";
import { problem, roomRoutes } from "./http/rooms.js";
import { statsRoutes } from "./http/stats.js";
import { reportMailer } from "./reports.js";
import { buildServer } from "./server.js";
import type { BellmanStore } from "./store.js";
import { SUSPENDED } from "./suspension.js";

/**
 * Builds the HTTP surface around an injected store.
 *
 * Kept separate from the process bootstrap so tests can mount the real app on
 * an ephemeral port with their own store, and so a Workers/DO port can reuse
 * the routing without Node's listener. The room routes (#183) are the one piece
 * shared as a module rather than re-typed: `src/http/rooms.ts` serves both, and
 * this file only translates.
 *
 * `features` is what the process bootstrap read from its environment (src/index.ts reads
 * BELLMAN_HOSTED_SEAT once and hands the same answer to the seat itself), passed on to
 * `buildServer`. Nothing here reads `process.env`, so a test mounts an app with either answer.
 */
export function createApp(store: BellmanStore, blobs: BlobStore, features: { hostedSeat: boolean }): Express {
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
  // This server has no send_email binding, so a report is stored and the log says no email went. The queue is where it is read.
  const mailReport = reportMailer(undefined);
  /**
   * A route module behind the suspension check the Worker makes (plan ruling R8): a suspended account is refused
   * before the module reads or writes anything as it. The store is read each time, with no cache: MemoryStore
   * answers at once.
   */
  const gated = (routes: (request: Request) => Promise<Response | undefined>) => async (request: Request) => {
    const who = await caller(request);
    return who && (await store.isSuspended(who.identity.userId)) ? problem(403, "suspended", SUSPENDED, undefined) : routes(request);
  };
  // The moderation routes are asked first: they answer the paths under /rooms/:id/bans and /rooms/:id/reports, and
  // leave every other path to the room routes.
  app.use("/rooms", serve(gated(async (request) => {
    const deps = { store, blobs, caller, panelOrigins: [] };
    return (await moderationRoutes(request, { ...deps, publicPageOrigins: [], mailReport })) ?? roomRoutes(request, deps);
  })));
  app.use("/presets", serve(gated((request) => presetRoutes(request, { store, caller, panelOrigins: [] }))));
  // A fixed seal secret: this server keeps nothing between runs, so there is nothing a rotation could lock out.
  // No link secret: this server signs no one in, so an invite link would lead nowhere; an invite answers `link: null`.
  app.use("/org", serve(gated((request) => orgRoutes(request, { store, caller, panelOrigins: [], sealSecret: "local-dev-seal", issuer: "http://localhost:3900" }))));
  // The org's token is the only credential, so no gate: the module answers 401 itself.
  app.use("/scim/v2", serve((request) => scimRoutes(request, { store })));
  app.use("/account/handle", serve(gated((request) => handleRoutes(request, { store, caller, panelOrigins: [] }))));
  app.use("/account/bans", serve(gated((request) => moderationRoutes(request, { store, caller, panelOrigins: [], publicPageOrigins: [] }))));
  // No operators locally: `npm start` serves the dev identities, and an operator gate that admitted one of
  // them would make the local server the loose one. No overrides and no billing either, which is the truth
  // here: nothing on this server reads BELLMAN_USERS or BELLMAN_BILLING, and a plan here comes from the key
  // table, never from a grant. With no operators the route answers 403 before it reads either.
  app.use("/operator/stats", serve(gated((request) => statsRoutes(request, {
    store, caller, panelOrigins: [], operators: undefined, overrides: {}, honourPurchases: false,
  }))));
  // No credential, so no gate.
  // Bearer keys only, so the cards say no OAuth (this server has none to honour).
  const publicReads = serve((request) => publicRoutes(request, { store, blobs, oauth: false }));
  app.use("/public", publicReads);
  // A room's 0.3 card, where a 0.3 resolver looks from the room's 0.3 URL: a public read, ahead of /a2a's key check.
  app.get("/a2a/:room/.well-known/agent-card.json", publicReads);
  // A2A (ADR 0033): outside agents ask a public room. The 401 is the Worker's, less the OAuth hint this server cannot give;
  // a suspended account is refused inside, in JSON-RPC.
  app.use("/a2a", serve(async (request) => {
    const who = await caller(request);
    if (!who) {
      return new Response("Unauthorized: missing or invalid credentials", { status: 401, headers: { "content-type": "text/plain" } });
    }
    return (await a2aRoutes(request, {
      store, caller: who.identity, suspended: () => store.isSuspended(who.identity.userId), origin: new URL(request.url).origin,
    })) ?? undefined;
  }));

  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, service: "bellman", at: new Date().toISOString() });
  });

  /**
   * A model for local development (hosted seat spec, D7): the Messages API's
   * shape with a canned answer, so `npm start` runs a host with no key. The
   * Worker never serves this; `MODEL_URL` points here only on the Node server.
   */
  app.post("/__fake-model", (req, res) => {
    const asking = String((req.body as { messages?: { content?: string }[] })?.messages?.[0]?.content ?? "").includes("Ask the room one new question");
    res.json({ content: [{ type: "text", text: asking ? "What did you build today, and what got in the way?" : "Thanks for telling the room. Who else has one?" }] });
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
    if (await store.isSuspended(identity.userId)) {
      res.status(403).json({ jsonrpc: "2.0", error: { code: -32003, message: SUSPENDED }, id: null });
      return;
    }
    try {
      const server = buildServer(identity, store, blobs, { ...features, mailReport });
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
