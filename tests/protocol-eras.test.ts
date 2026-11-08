/**
 * `/mcp` speaks both protocol eras through one handler (`createMcpHandler`, #571): a 2025-era client opens with
 * `initialize`, as every client did before MCP 2026-07-28, and a 2026-07-28 client sends none, carrying its version
 * and identity in each request's `_meta`. The same identity-bound server answers both, and they share one store, so
 * a room one era creates is a room the other joins. The real Express app over a real socket, no stubs.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp } from "../src/app.js";
import { MemoryBlobStore } from "../src/files/blobs.js";
import { MemoryStore } from "../src/storage/memory-store.js";
import { brief, manifestFixture } from "./helpers/fixtures.js";
import { DEV_KEY } from "./helpers/harness.js";

let http: Server;
let base: string;

beforeAll(async () => {
  const app = createApp(new MemoryStore(), new MemoryBlobStore(), { hostedSeat: false });
  http = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

/** A client of either era, signed in with a dev key. */
async function connect(key: string, era: "legacy" | "modern"): Promise<Client> {
  const client = new Client(
    { name: `eras-${era}`, version: "0.0.1" },
    era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    }),
  );
  return client;
}

const json = (res: { structuredContent?: unknown }) => res.structuredContent as Record<string, unknown>;

describe("both protocol eras on /mcp", () => {
  it("serves a 2025-era client through the initialize handshake", async () => {
    const client = await connect(DEV_KEY.jesse, "legacy");
    expect(client.getProtocolEra()).toBe("legacy");
    expect(client.getNegotiatedProtocolVersion()).toBe("2025-11-25");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("bellman_start");
    await client.close();
  });

  it("serves a 2026-07-28 client with no handshake", async () => {
    const client = await connect(DEV_KEY.jesse, "modern");
    expect(client.getProtocolEra()).toBe("modern");
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("bellman_start");
    await client.close();
  });

  it("lets a room one era opens be joined from the other, as one identity-bound server", async () => {
    const modern = await connect(DEV_KEY.jesse, "modern");
    const started = json(await modern.callTool({
      name: "bellman_start",
      arguments: { manifest: manifestFixture({ preset: "swarm" }), brief: brief(), capabilities: ["read_context", "receive_messages"] },
    }));
    expect(started.join_code).toEqual(expect.stringMatching(/^BELL-/));

    const legacy = await connect(DEV_KEY.peer, "legacy");
    const preview = json(await legacy.callTool({ name: "bellman_connect", arguments: { join_code: started.join_code } }));
    const joined = json(await legacy.callTool({
      name: "bellman_confirm",
      arguments: { connect_token: preview.connect_token, brief: brief({ goal: "Join from a 2025-era client" }) },
    }));
    expect(joined.session_id).toBe(started.session_id);

    // Each request is its caller's: the modern client is still the creator, not the peer who joined after it.
    const rooms = json(await modern.callTool({ name: "bellman_rooms", arguments: {} }));
    expect(JSON.stringify(rooms)).toContain(String(started.session_id));
    await modern.close();
    await legacy.close();
  });

  it("refuses either era without a key", async () => {
    for (const era of ["legacy", "modern"] as const) {
      const client = new Client(
        { name: "eras-anon", version: "0.0.1" },
        era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
      );
      await expect(client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)))).rejects.toThrow();
    }
  });
});
