#!/usr/bin/env node
/**
 * Bellman for Claude Code — the stdio MCP server Claude Code spawns.
 *
 * Environment:
 *   BELLMAN_KEY       required. Your bearer key.
 *   BELLMAN_URL       optional. Defaults to https://mcp.bellman.sh/mcp
 *   BELLMAN_DELIVERY  "channel" (default): push peer events into the session.
 *                     Launch with --dangerously-load-development-channels server:<name>.
 *                     "hook": queue them for the Bellman Stop hook and bellman_wait.
 *
 * Launch it with `node` directly, not through npx or a shell: hook delivery
 * keys the inbox by this process's parent PID, which must be Claude Code.
 *
 * stdout is the MCP transport. Log to stderr only.
 */
import { rmSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { connectRemote, createBridge, type Delivery } from "./bridge.js";
import { inboxDirFor, sweepStaleInboxes } from "./inbox.js";

const key = process.env.BELLMAN_KEY;
if (!key) {
  console.error("[bellman] BELLMAN_KEY is not set; refusing to start.");
  process.exit(1);
}
const url = process.env.BELLMAN_URL ?? "https://mcp.bellman.sh/mcp";
const delivery: Delivery = process.env.BELLMAN_DELIVERY === "hook" ? "hook" : "channel";

const inboxDir = delivery === "hook" ? inboxDirFor(process.ppid) : undefined;
if (delivery === "hook") sweepStaleInboxes();

const bridge = createBridge({
  delivery,
  inboxDir,
  remote: () => connectRemote(url, key),
  log: (message) => console.error(`[bellman] ${message}`),
});

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await bridge.close().catch(() => undefined);
  if (inboxDir) rmSync(inboxDir, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.stdin.on("close", shutdown);

await bridge.server.connect(new StdioServerTransport());
console.error(`[bellman] ready: ${delivery} delivery via ${url}`);
