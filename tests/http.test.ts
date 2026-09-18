/**
 * Integration: the real Express app, the real streamable HTTP transport, real
 * bearer auth. Everything else runs in-process; this proves the wire works.
 *
 * INVARIANT 4: bearer auth, stateless streamable HTTP.
 * INVARIANT 5: transports are stateless — state survives across independent
 *              HTTP requests only because it lives in the store.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/app.js";
import { MemoryStore, type BellmanStore } from "../src/store.js";
import { brief, openaiAgent } from "./helpers/fixtures.js";

let http: Server;
let store: BellmanStore;
let base: string;

beforeAll(async () => {
  store = new MemoryStore();
  const app = createApp(store);
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

  it("lists the 8 tools over HTTP", async () => {
    const client = await mcpClient("qk_dev_jesse");
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(8);
    await client.close();
  });
});

describe("cross-provider pairing over the wire", () => {
  it("runs the full handshake, exchange and departure", async () => {
    const jesse = await mcpClient("qk_dev_jesse");
    const peer = await mcpClient("qk_dev_peer");

    const started = await call(jesse, "bellman_start", {
      mode: "pair", brief: brief(), org_only: true,
      capabilities: ["read_context", "receive_messages", "request_actions"],
    });
    expect(started.isError, started.text).toBe(false);
    expect(String(started.data.join_code)).toMatch(/^BELL-[A-Z2-9]{4}-[A-Z2-9]{2}$/);

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
    const started = await call(first, "bellman_start", { mode: "pair", brief: brief() });
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

    const started = await call(jesse, "bellman_start", { mode: "pair", brief: brief() });
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
