/**
 * A client for the local bridge, as Claude Code opens one on MCP 2026-07-28: the bridge refuses the 2025 handshake
 * (src/client/bridge.ts, `serve`), so every test that talks to a bridge opens in the new era.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";

export function bridgeClient(name: string): Client {
  return new Client({ name, version: "0.0.1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
}

/** A fresh inbox for a bridge under test: every bridge queues its peer events in one. */
export function tmpInbox(): string {
  return mkdtempSync(join(tmpdir(), "bellman-inbox-"));
}

/**
 * What a hand-written 2026-07-28 request carries in its `_meta`, with no `initialize` before it: the protocol revision,
 * the client, and its capabilities. For tests that speak JSON-RPC to the bridge process directly.
 */
export function modernMeta(client = { name: "bridge-test", version: "0.0.1" }): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": client,
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

/** A 2026-07-28 JSON-RPC request: `params` with the envelope added to its `_meta`. */
export function modernRequest(id: number, method: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  const meta = (params._meta ?? {}) as Record<string, unknown>;
  return { jsonrpc: "2.0", id, method, params: { ...params, _meta: { ...meta, ...modernMeta() } } };
}

/**
 * A hand-written message as a 2026-07-28 client sends it. Tests written against the 2025 handshake keep their
 * messages: `initialize` becomes `server/discover`, the request that stands in for it; `notifications/initialized`
 * is not sent, since nothing is being acknowledged; and every request carries the envelope. Undefined means send
 * nothing.
 */
export function toModern(message: Record<string, unknown>): Record<string, unknown> | undefined {
  if (message.method === "notifications/initialized") return undefined;
  if (typeof message.method !== "string" || !("id" in message)) return message;
  if (message.method === "initialize") return modernRequest(message.id as number, "server/discover");
  return modernRequest(message.id as number, message.method, (message.params ?? {}) as Record<string, unknown>);
}
