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
import { brief, manifestFixture, member, openaiAgent, roomManifest, session } from "./helpers/fixtures.js";

let http: Server;
let store: BellmanStore;
let base: string;

beforeAll(async () => {
  store = new MemoryStore();
  const app = createApp(store, new MemoryBlobStore(), { hostedSeat: true });
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
  it("serves the public reads beside the room routes, with no credential", async () => {
    await store.createSession(session({ id: "qs_http_public", manifest: roomManifest({ public: true }) }));
    const res = await fetch(`${base}/public/rooms/qs_http_public`);
    expect([res.status, res.headers.get("access-control-allow-origin")]).toEqual([200, "*"]);
  });

  it("serves the preset routes beside the room routes", async () => {
    const res = await fetch(`${base}/presets`, { headers: { authorization: "Bearer qk_dev_jesse" } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { builtin: unknown[] }).builtin).toHaveLength(5);
  });

  it("serves the ban routes beside the room routes", async () => {
    await store.createSession(session({
      id: "qs_http_bans",
      members: [member(), member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b" })],
    }));
    const headers = { authorization: "Bearer qk_dev_jesse", "content-type": "application/json" };
    // A room ban, not "all": this file's one store serves every test, and a ban from every room jesse owns
    // would refuse the peer at the pairing tests below. The account list's rows are pinned in tests/http-moderation.test.ts.
    const banned = await fetch(`${base}/rooms/qs_http_bans/bans`, { method: "POST", headers, body: JSON.stringify({ member_id: "m_peer", scope: "room" }) });
    expect(banned.status).toBe(200);
    const room = await fetch(`${base}/rooms/qs_http_bans/bans`, { headers });
    const account = await fetch(`${base}/account/bans`, { headers });
    expect([room.status, account.status]).toEqual([200, 200]);
    expect(((await room.json()) as { bans: { label: string }[] }).bans.map((b) => b.label)).toEqual(["peer@codenerd"]);
    expect(Array.isArray(((await account.json()) as { bans: unknown }).bans)).toBe(true);
  });

  it("serves the host route beside the room routes", async () => {
    await store.createSession(session({
      id: "qs_http_host",
      manifest: roomManifest({ mode: "swarm", preset: null, heartbeatOnMs: 3_600_000,
        roles: { lead: { can: ["send"], description: null, reports: false }, host: { can: ["send"], description: null, reports: false } },
        defaultRole: "lead", creatorRole: "lead", host: { role: "host", model: "haiku", instructions: null } }),
      members: [member({ roomRole: "lead" }), member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", roomRole: "lead" })],
    }));
    const put = (key: string) => fetch(`${base}/rooms/qs_http_host/host`, {
      method: "PUT", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ instructions: "Ask how agents have grown." }),
    });
    expect((await put("qk_dev_peer")).status, "a member who did not create the room").toBe(403);
    expect((await store.getSession("qs_http_host"))!.manifest.host?.instructions).toBeNull();
    const set = await put("qk_dev_jesse");
    expect([set.status, await set.json()]).toEqual([200, { instructions: "Ask how agents have grown." }]);
    expect((await store.getSession("qs_http_host"))!.manifest.host?.instructions).toBe("Ask how agents have grown.");
  });

  // This server has no send_email binding, so a report is stored and the log says no email went. The route's own cases are in
  // tests/http-moderation.test.ts.
  it("serves the report routes beside the room routes, and says in the log that this server sends no email", async () => {
    await store.createSession(session({
      id: "qs_http_reports",
      members: [member(), member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b" })],
    }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const file = async (key: string, memberId: string) => {
        const res = await fetch(`${base}/rooms/qs_http_reports/reports`, {
          method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ member_id: memberId, reason: "spam" }),
        });
        expect(res.status).toBe(201);
        return ((await res.json()) as { report_id: string }).report_id;
      };
      // The peer reports the creator, and the creator reports the peer. The creator's list holds the second alone: a report
      // about the creator reaches the operators, not the creator.
      const aboutCreator = await file("qk_dev_peer", "m_creator");
      const aboutPeer = await file("qk_dev_jesse", "m_peer");
      expect(logged.mock.calls.flat().join(" ")).toContain(`report ${aboutCreator}: no send_email binding`);
      const listed = await fetch(`${base}/rooms/qs_http_reports/reports`, { headers: { authorization: "Bearer qk_dev_jesse" } });
      expect(((await listed.json()) as { reports: { id: string }[] }).reports.map((r) => r.id)).toEqual([aboutPeer]);
    } finally {
      logged.mockRestore();
    }
  });

  // The Node server passes no public page origin (src/app.ts): a script on bellman.sh is granted nothing here, as a stranger is not.
  it("grants the report route's preflight to no origin, bellman.sh included", async () => {
    const res = await fetch(`${base}/rooms/qs_http_reports/reports`, {
      method: "OPTIONS", headers: { origin: "https://bellman.sh", "access-control-request-method": "POST" },
    });
    expect([res.status, res.headers.get("access-control-allow-origin")]).toEqual([204, null]);
  });

  // The dev keys are valid callers here, and an operator gate that admitted one would make this server the loose one.
  // It mounts the stats with no operators, so even the team admin is refused. The route's own cases are in tests/stats.test.ts.
  it.each(["/operator/stats", "/operator/accounts"])("serves %s to no one, the dev team admin included", async (at) => {
    expect((await fetch(`${base}${at}`)).status).toBe(401);
    for (const key of ["qk_dev_jesse", "qk_dev_peer", "qk_dev_outsider"]) {
      const res = await fetch(`${base}${at}`, { headers: { authorization: `Bearer ${key}` } });
      expect([key, res.status]).toEqual([key, 403]);
    }
  });

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

  it("lists the 13 tools over HTTP", async () => {
    const client = await mcpClient("qk_dev_jesse");
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(13);
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

describe("A2A over the Node server (ADR 0033)", () => {
  const rpc = (key: string | null, method: string, params: unknown) => fetch(`${base}/a2a`, {
    method: "POST",
    headers: { "content-type": "application/json", "a2a-version": "1.0", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const ask = (tenant: string) => ({
    tenant, configuration: { returnImmediately: true },
    message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "What does this room review?" }] },
  });

  it("the Node app serves /a2a SendMessage with a bearer key", async () => {
    await store.createSession(session({ id: "qs_http_a2a", manifest: roomManifest({ public: true }) }));
    const res = await rpc("qk_dev_outsider", "SendMessage", ask("qs_http_a2a"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { task: { id: string; status: { state: string } } } };
    expect(body.result?.task.status.state).toBe("TASK_STATE_WORKING");
    const got = await rpc("qk_dev_outsider", "GetTask", { tenant: "qs_http_a2a", id: body.result!.task.id });
    expect(((await got.json()) as { result: { id: string } }).result.id).toBe(body.result!.task.id);
  });

  it("answers SendStreamingMessage with no tenant as one SSE event, while SendMessage stays JSON", async () => {
    const noRoom = { message: { messageId: "m2", role: "ROLE_USER", parts: [{ text: "Anyone there?" }] } };
    const streamed = await rpc("qk_dev_outsider", "SendStreamingMessage", noRoom);
    expect(streamed.headers.get("content-type")?.startsWith("text/event-stream")).toBe(true);
    const event = (await streamed.text()).split("\n").find((line) => line.startsWith("data: "))!;
    const body = JSON.parse(event.slice("data: ".length)) as { id: number; result: { message: { parts: { text: string }[] } } };
    expect(body.id).toBe(1);
    expect(body.result.message.parts[0].text).toContain("tenant");
    const plain = await rpc("qk_dev_outsider", "SendMessage", noRoom);
    expect(plain.headers.get("content-type")?.startsWith("application/json")).toBe(true);
    await expect(plain.json()).resolves.toMatchObject({ id: 1, result: { message: { role: "ROLE_AGENT" } } });
  });

  it("answers a request with no key as a plain 401, with no OAuth hint this server cannot honour", async () => {
    const res = await rpc(null, "SendMessage", ask("qs_http_a2a"));
    expect([res.status, res.headers.get("content-type")?.startsWith("text/plain"), res.headers.get("www-authenticate")]).toEqual([401, true, null]);
    expect(await res.text()).toBe("Unauthorized: missing or invalid credentials");
    expect((await rpc("qk_nobody", "ListTasks", {})).status).toBe(401);
  });

  it("serves a room card that offers the bearer scheme and no OAuth", async () => {
    await store.createSession(session({ id: "qs_http_card", manifest: roomManifest({ public: true }) }));
    const card = (await (await fetch(`${base}/public/rooms/qs_http_card/agent-card.json`)).json()) as {
      securitySchemes: Record<string, unknown>; securityRequirements: unknown[];
    };
    expect(Object.keys(card.securitySchemes)).toEqual(["bearer"]);
    expect(card.securityRequirements).toEqual([{ schemes: { bearer: { list: [] } } }]);
    // The 0.3 card, where a 0.3 resolver looks from the room's own URL, says the same: bearer and no OAuth, and no key needed to read it.
    const old = await fetch(`${base}/a2a/qs_http_card/.well-known/agent-card.json`);
    expect(old.status).toBe(200);
    const v03 = (await old.json()) as { url: string; securitySchemes: Record<string, unknown>; security: unknown[] };
    expect(v03.url).toBe(`${base}/a2a/qs_http_card`);
    expect(Object.keys(v03.securitySchemes)).toEqual(["bearer"]);
    expect(v03.security).toEqual([{ bearer: [] }]);
    expect((await fetch(`${base}/a2a/qs_http_nope/.well-known/agent-card.json`)).status).toBe(404);
  });

  it("serves A2A 0.3 at the room's own URL, which its card lists, with a bearer key", async () => {
    await store.createSession(session({ id: "qs_http_v03", manifest: roomManifest({ public: true }) }));
    const card = (await (await fetch(`${base}/public/rooms/qs_http_v03/agent-card.json`)).json()) as { supportedInterfaces: { url: string; protocolVersion: string }[] };
    const v03 = card.supportedInterfaces.find((face) => face.protocolVersion === "0.3")!;
    expect(v03.url).toBe(`${base}/a2a/qs_http_v03`);
    const post = (key: string | null) => fetch(v03.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "message/send",
        params: { message: { kind: "message", messageId: "m1", role: "user", parts: [{ kind: "text", text: "Hello?" }] }, configuration: { blocking: false } },
      }),
    });
    const body = (await (await post("qk_dev_outsider")).json()) as { result?: { kind: string; status: { state: string } } };
    expect(body.result).toMatchObject({ kind: "task", status: { state: "working" } });
    const none = await post(null);
    expect([none.status, none.headers.get("www-authenticate")]).toEqual([401, null]);
  });
});

/**
 * The hosted seat's switch, over the wire: `createApp` hands its `features` to the tools it
 * serves, so the same request is refused by an app built with the seat off and served by one
 * built with it on. The second case is the control for the first.
 */
describe("the hosted seat's switch over /mcp", () => {
  const social = { room: "the square", preset: "social" };

  async function startSocial(hostedSeat: boolean): Promise<Outcome> {
    const server = await new Promise<Server>((resolve) => {
      const s = createApp(new MemoryStore(), new MemoryBlobStore(), { hostedSeat }).listen(0, () => resolve(s));
    });
    const client = new Client({ name: "http-switch", version: "0.0.1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`),
        { requestInit: { headers: { Authorization: "Bearer qk_dev_jesse" } } },
      ));
      return await call(client, "bellman_start", { manifest: social, brief: brief() });
    } finally {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("refuses a hosted room from an app built with the seat off", async () => {
    const out = await startSocial(false);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("hosted seats are not available yet");
  });

  it("starts it from an app built with the seat on", async () => {
    const out = await startSocial(true);
    expect(out.isError, out.text).toBe(false);
  });
});
