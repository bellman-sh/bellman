/**
 * The tool lists a client can see, as a client lists them: the server's, and a bridge's, which is
 * the server's plus the bridge's own. tests/extension.test.ts holds the Claude Desktop manifest to
 * a bridge in the delivery the manifest asks for; scripts/docs-reference.ts renders the docs
 * site's tool reference from the server's list and a hook-mode bridge's, so a page and its test
 * build their lists with the same code.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { resolveIdentity } from "../../src/auth.js";
import { createBridge, type Delivery, type Remote } from "../../src/bridge.js";
import { buildServer } from "../../src/server.js";
import { MemoryBlobStore } from "../../src/blobs.js";
import { MemoryStore } from "../../src/store.js";
import { DEV_KEY, Harness } from "./harness.js";

/** The server's tools, listed over an in-memory MCP client bound to the dev key for jesse. */
export async function listServerTools(): Promise<Tool[]> {
  const harness = new Harness();
  try {
    const peer = await harness.connect(DEV_KEY.jesse);
    return (await peer.listTools()).tools;
  } finally {
    await harness.close();
  }
}

/**
 * A bridge over the real tool handlers, in the given delivery, as a client meets it: the tools it
 * lists and the instructions it hands the model. Nothing is stubbed, so a tool added to either side
 * shows up here without this file being told about it.
 */
export async function listBridge(delivery: Delivery): Promise<{ tools: Tool[]; instructions: string }> {
  const store = new MemoryStore();
  const identity = resolveIdentity(`Bearer ${DEV_KEY.jesse}`);
  if (!identity) throw new Error(`dev key ${DEV_KEY.jesse} no longer resolves`);

  const inboxDir = mkdtempSync(join(tmpdir(), "bellman-extension-"));

  const bridge = createBridge({
    delivery,
    inboxDir,
    remote: async (): Promise<Remote> => {
      const server = buildServer(identity, store, new MemoryBlobStore(), { hostedSeat: true });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "bridge-remote", version: "0.0.1" });
      await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
      return {
        listTools: () => client.listTools(),
        callTool: (params) => client.callTool(params) as Promise<CallToolResult>,
        close: () => client.close(),
      };
    },
  });

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "claude-desktop", version: "0.0.1" });
  await Promise.all([bridge.server.connect(serverSide), client.connect(clientSide)]);

  try {
    const { tools } = await client.listTools();
    return { tools, instructions: client.getInstructions() ?? "" };
  } finally {
    await bridge.close();
    await client.close();
    rmSync(inboxDir, { recursive: true, force: true });
  }
}

/** The Claude Code plugin's bridge, which runs in hook delivery. */
export async function listHookBridgeTools(): Promise<Tool[]> {
  return (await listBridge("hook")).tools;
}
