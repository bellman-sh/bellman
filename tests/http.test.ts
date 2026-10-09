/**
 * Integration: the real Express app, the real streamable HTTP transport, real
 * bearer auth. Everything else runs in-process; this proves the wire works.
 *
 * INVARIANT 4: bearer auth, stateless streamable HTTP.
 * INVARIANT 5: transports are stateless — state survives across independent
 *              HTTP requests only because it lives in the store.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Server } from "node:http";
import { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/app.js";
import { MemoryBlobStore } from "../src/blobs.js";
import { MemoryStore, type BellmanStore } from "../src/store.js";
import { text } from "./helpers/blob-bytes.js";
import { brief, manifestFixture, openaiAgent } from "./helpers/fixtures.js";

let http: Server;
let store: BellmanStore;
let base: string;

beforeAll(async () => {
  store = new MemoryStore();
  const app = createApp(store, new MemoryBlobStore());
  http = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

async function mcpClient(key: string): Promise<Client> {
  const client = new Client({ name: `http-${key}`, version: "0.0.1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    }),
  );
  return client;
}

interface Outcome { isError: boolean; data: Record<string, unknown>; text: string }

async function call(c: Client, name: string, args: Record<string, unknown>): Promise<Outcome> {
  const res = await c.callTool({ name, arguments: args });
  const content = (res.content as { type: string; text?: string }[]) ?? [];
  return {
    isError: Boolean(res.isError),
    data: (res as { structuredContent?: Record<string, unknown> }).structuredContent ?? {},
    text: content.map((b) => b.text ?? "").join("\n"),
  };
}

describe("HTTP surface", () => {
  it("serves a health check without auth", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, service: "bellman" });
  });

  it("rejects /mcp with no bearer key", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toContain("Unauthorized");
  });

  it("rejects /mcp with an unknown bearer key", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer qk_not_real",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("lists the 11 tools over HTTP", async () => {
    const client = await mcpClient("qk_dev_jesse");
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(11);
    await client.close();
  });
});

describe("cross-provider pairing over the wire", () => {
  it("runs the full handshake, exchange and departure", async () => {
    const jesse = await mcpClient("qk_dev_jesse");
    const peer = await mcpClient("qk_dev_peer");

    const started = await call(jesse, "bellman_start", {
      manifest: manifestFixture(), brief: brief(), org_only: true,
      capabilities: ["read_context", "receive_messages", "request_actions"],
    });
    expect(started.isError, started.text).toBe(false);
    expect(String(started.data.join_code)).toMatch(/^BELL-[A-Z2-9]{4}-[A-Z2-9]{2}-PEER-B$/);

    const sessionId = String(started.data.session_id);
    const jesseMember = String(started.data.member_id);

    const preview = await call(peer, "bellman_connect", {
      join_code: String(started.data.join_code),
    });
    expect(preview.isError, preview.text).toBe(false);
    expect(preview.text).toContain("UNTRUSTED");

    const confirmed = await call(peer, "bellman_confirm", {
      connect_token: String(preview.data.connect_token),
      brief: brief({ goal: "Pair from the ChatGPT side", agent: openaiAgent }),
      capabilities: ["read_context", "receive_messages", "request_actions"],
    });
    expect(confirmed.isError, confirmed.text).toBe(false);
    const peerMember = String(confirmed.data.member_id);

    const sent = await call(peer, "bellman_send", {
      session_id: sessionId, member_id: peerMember,
      type: "message", payload: { text: "over the wire" },
    });
    expect(sent.isError, sent.text).toBe(false);

    const sync = await call(jesse, "bellman_sync", {
      session_id: sessionId, member_id: jesseMember, since_cursor: 0,
    });
    expect(JSON.stringify(sync.data.events)).toContain("over the wire");

    const left = await call(peer, "bellman_leave", {
      session_id: sessionId, member_id: peerMember,
    });
    expect(left.isError, left.text).toBe(false);

    await Promise.all([jesse.close(), peer.close()]);
  });

  /** INVARIANT 5: nothing lives in the transport. */
  it("keeps session state across separate connections with the same key", async () => {
    const first = await mcpClient("qk_dev_jesse");
    const started = await call(first, "bellman_start", { manifest: manifestFixture(), brief: brief() });
    const sessionId = String(started.data.session_id);
    const memberId = String(started.data.member_id);
    await first.close();

    // A brand new transport, a brand new McpServer instance — same state.
    const second = await mcpClient("qk_dev_jesse");
    const sync = await call(second, "bellman_sync", {
      session_id: sessionId, member_id: memberId, since_cursor: 0,
    });
    expect(sync.isError, sync.text).toBe(false);
    expect(sync.data.session_status).toBe("active");
    await second.close();
  });

  it("resolves a long-poll across two HTTP connections", async () => {
    const jesse = await mcpClient("qk_dev_jesse");
    const peer = await mcpClient("qk_dev_peer");

    const started = await call(jesse, "bellman_start", { manifest: manifestFixture(), brief: brief() });
    const sessionId = String(started.data.session_id);
    const jesseMember = String(started.data.member_id);

    const preview = await call(peer, "bellman_connect", {
      join_code: String(started.data.join_code),
    });
    const confirmed = await call(peer, "bellman_confirm", {
      connect_token: String(preview.data.connect_token),
      brief: brief({ agent: openaiAgent }),
    });

    const cursor = Number(confirmed.data.cursor);
    const held = call(jesse, "bellman_sync", {
      session_id: sessionId, member_id: jesseMember,
      since_cursor: cursor, wait_seconds: 15,
    });

    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    await call(peer, "bellman_send", {
      session_id: sessionId, member_id: String(confirmed.data.member_id),
      type: "message", payload: { text: "unblocked" },
    });

    const sync = await held;
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(JSON.stringify(sync.data.events)).toContain("unblocked");

    await Promise.all([jesse.close(), peer.close()]);
  });
});

describe("the room routes over the Node server (#183)", () => {
  it("uploads and downloads a blob through the app, and the tool heads what the route stored", async () => {
    const jesse = await mcpClient("qk_dev_jesse");
    const started = await call(jesse, "bellman_start", { manifest: manifestFixture(), brief: brief() });
    expect(started.isError, started.text).toBe(false);
    const sessionId = String(started.data.session_id);
    const memberId = String(started.data.member_id);

    const body = text("# notes\n");
    const uploaded = await fetch(`${base}/rooms/${sessionId}/blobs?member_id=${memberId}&name=notes.md`, {
      method: "POST",
      headers: { authorization: "Bearer qk_dev_jesse", "content-type": "text/markdown" },
      body,
    });
    expect(uploaded.status, await uploaded.clone().text()).toBe(201);
    const { blob_id, bytes } = (await uploaded.json()) as { blob_id: string; bytes: number };
    expect(bytes).toBe(body.byteLength);

    // The same MemoryBlobStore behind the tool: the placement heads the object the route stored.
    const placed = await call(jesse, "bellman_send", {
      session_id: sessionId, member_id: memberId, type: "surface",
      payload: { key: "notes", kind: "file", blob: { id: blob_id } },
    });
    expect(placed.isError, placed.text).toBe(false);

    const served = await fetch(`${base}/rooms/${sessionId}/blobs/${blob_id}`, { headers: { authorization: "Bearer qk_dev_jesse" } });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("application/octet-stream");
    expect(served.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''notes.md");
    expect(served.headers.get("content-security-policy")).toBe("sandbox");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(body);

    expect((await fetch(`${base}/rooms/${sessionId}/blobs/${blob_id}`)).status).toBe(401);
    expect((await fetch(`${base}/rooms/${sessionId}/blobs`, { method: "POST", headers: { authorization: "Bearer qk_dev_jesse" }, body: "x" })).status).toBe(400);
    await jesse.close();
  });

  // The translation's other branch: an answer with no body (a 304 to a conditional GET, a preflight's
  // 204) ends the response, where a stream is piped for every other. Without the branch the route's
  // `null` body reaches Readable.fromWeb and the request answers 500.
  it("answers a conditional GET 304 and a preflight 204 with their headers and no body", async () => {
    const jesse = await mcpClient("qk_dev_jesse");
    const started = await call(jesse, "bellman_start", { manifest: manifestFixture(), brief: brief() });
    expect(started.isError, started.text).toBe(false);
    const sessionId = String(started.data.session_id);
    const memberId = String(started.data.member_id);
    const bearer = { authorization: "Bearer qk_dev_jesse" };

    const uploaded = await fetch(`${base}/rooms/${sessionId}/blobs?member_id=${memberId}&name=notes.md`, {
      method: "POST",
      headers: { ...bearer, "content-type": "text/markdown" },
      body: text("# notes\n"),
    });
    expect(uploaded.status, await uploaded.clone().text()).toBe(201);
    const { blob_id } = (await uploaded.json()) as { blob_id: string };
    const blobUrl = `${base}/rooms/${sessionId}/blobs/${blob_id}`;

    const served = await fetch(blobUrl, { headers: bearer });
    expect(served.status).toBe(200);
    const etag = served.headers.get("etag");
    expect(etag).toBeTruthy();
    await served.arrayBuffer();

    const unchanged = await fetch(blobUrl, { headers: { ...bearer, "if-none-match": etag! } });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    expect(unchanged.headers.get("etag")).toBe(etag);
    expect(unchanged.headers.get("cache-control")).toBe("private, max-age=300");
    expect(unchanged.headers.get("content-security-policy")).toBe("sandbox");

    // A stranger's preflight: 204 and no grant, because this server has no panel origins.
    const preflight = await fetch(`${base}/rooms/${sessionId}/blobs`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(await preflight.text()).toBe("");
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    await jesse.close();
  });

  // The list path, with no trailing slash, reaches the module. The key is outsider's: the store is shared
  // across this file and the tests above leave rooms behind them for jesse, so only a person who made none
  // answers the empty list this asserts.
  it("serves GET /rooms, with no trailing slash, from the room routes module", async () => {
    const res = await fetch(`${base}/rooms`, { headers: { authorization: "Bearer qk_dev_outsider" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ rooms: [], truncated: false, viewer: "member" });
  });

  // A handler that throws is answered by the route module, in JSON. Left to Express, a rejected async handler
  // is answered with its own HTML error page, which a bridge or the panel cannot read as the error it is.
  it("answers a route whose store throws with the module's JSON, not Express's HTML page", async () => {
    const throwing = vi.spyOn(store, "getSession").mockRejectedValueOnce(new Error("the store is unreachable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await fetch(`${base}/rooms/qs_nowhere/blobs/${"a".repeat(32)}`, {
        headers: { authorization: "Bearer qk_dev_jesse" },
      });
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toMatchObject({ error: "internal" });
    } finally {
      throwing.mockRestore();
      log.mockRestore();
    }
  });
});
