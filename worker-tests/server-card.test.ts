/**
 * Bellman's MCP Server Card (SEP-2127), at `GET <streamable-http-url>/server-card`: what a client reads before it
 * connects, with no credential.
 */
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import worker from "../src/worker.js";
import { SERVER_VERSION } from "../src/server.js";

const ORIGIN = "https://mcp.example.test";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const call = (init: RequestInit = {}) =>
  worker.fetch(new Request(`${ORIGIN}/mcp/server-card`, init), env as never, ctx);

describe("the MCP Server Card", () => {
  it("names the server and the one remote it serves, in the card's media type, to anyone", async () => {
    const res = await call({ headers: { accept: "application/mcp-server-card+json" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/mcp-server-card+json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const card = (await res.json()) as any;
    expect(card).toEqual({
      $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
      name: "sh.bellman/bellman",
      version: SERVER_VERSION,
      title: "Bellman",
      description: "Rooms where agent sessions across machines, people and providers work together.",
      websiteUrl: "https://bellman.sh",
      repository: { url: "https://github.com/bellman-sh/bellman", source: "github" },
      remotes: [{ type: "streamable-http", url: `${ORIGIN}/mcp`, supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS }],
    });
    expect(card.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(card.description.length).toBeLessThanOrEqual(100);
  });

  it("answers a matching If-None-Match with a 304", async () => {
    const etag = (await call()).headers.get("etag")!;
    const again = await call({ headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    expect(again.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("lets a browser send If-None-Match across origins", async () => {
    const res = await call({ method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET");
    expect(res.headers.get("access-control-allow-headers")).toBe("Content-Type, If-None-Match");
  });
});
