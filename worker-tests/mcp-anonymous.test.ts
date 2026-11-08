/** `/mcp` with no credential: the handshake and the tool list are anyone's; every other method is a 401 that starts sign-in. */
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/workerd/worker.js";

const ORIGIN = "https://mcp.example.test";
// OAuth on, as production runs it: the 401 then carries the challenge that starts sign-in.
const oauthEnv = { ...env, BELLMAN_TOKEN_SECRET: "test-signing-secret" } as never;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const post = (body: unknown, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  }), oauthEnv, ctx);
const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };

describe("/mcp with no credential", () => {
  it("lists the tools", async () => {
    const res = await post(list);
    expect(res.status).toBe(200);
    const { result } = await res.json() as { result: { tools: { name: string }[] } };
    expect(result.tools.map((t) => t.name)).toContain("bellman_start");
  });

  it("completes the handshake", async () => {
    const init = { jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
    const res = await post(init);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("bellman-mcp-server");
    expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
  });

  it("answers a tool call, any batch and an oversized body with the 401 that points at discovery", async () => {
    const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "bellman_rooms", arguments: {} } };
    const oversized = { ...list, params: { pad: "x".repeat(5000) } };
    for (const body of [call, [list, call], [list, list], oversized]) {
      const res = await post(body);
      expect([res.status, res.headers.get("www-authenticate")?.startsWith("Bearer resource_metadata=")]).toEqual([401, true]);
    }
  });

  it("refuses a listing that carries a bad credential, so an expired token is refreshed rather than ignored", async () => {
    expect((await post(list, { authorization: "Bearer not-a-token" })).status).toBe(401);
  });
});
