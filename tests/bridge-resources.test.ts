/**
 * The bridge forwards the two resource requests an MCP Apps host makes, so the
 * Desktop bundle, whose host talks to the bridge over stdio, renders the same
 * screens a remote connector does (#28, D13). It also learns nothing from a
 * bellman_rooms result: the tool nests memberships under rooms[], and observe()
 * has no case for it, so no watcher is armed (D3).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveIdentity } from "../src/auth.js";
import { createBridge, type Remote } from "../src/bridge.js";
import { buildServer } from "../src/server.js";
import { MemoryStore } from "../src/store.js";
import { MemoryBlobStore } from "../src/blobs.js";
import { APP_MIME_TYPE, APP_RESOURCE_URI } from "../src/ui/resource.js";
import { DEV_KEY } from "./helpers/harness.js";
import { member, session } from "./helpers/fixtures.js";

const temps: string[] = [];
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => undefined);
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A real Bellman behind a real MCP client, as connectRemote builds one. */
async function remoteFor(store: MemoryStore): Promise<Remote> {
  const identity = resolveIdentity(`Bearer ${DEV_KEY.jesse}`)!;
  const server = buildServer(identity, store, new MemoryBlobStore());
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "bridge-remote", version: "0.0.1" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return {
    listTools: () => client.listTools(),
    callTool: (params) => client.callTool(params) as Promise<CallToolResult>,
    listResources: () => client.listResources(),
    readResource: (params) => client.readResource(params),
    close: () => client.close(),
  };
}

/** The bridge as Claude Desktop runs it, with a host client attached. */
async function bridged(remote: () => Promise<Remote>) {
  const inboxDir = mkdtempSync(join(tmpdir(), "bellman-resources-"));
  temps.push(inboxDir);
  const bridge = createBridge({ delivery: "hook", inboxDir, remote });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const host = new Client({ name: "host", version: "0.0.1" });
  await Promise.all([bridge.server.connect(serverSide), host.connect(clientSide)]);
  closers.push(() => bridge.close(), () => host.close());
  return { bridge, host };
}

describe("the bridge and UI resources", () => {
  it("declares resources, and lists and reads the remote's app", async () => {
    const { host } = await bridged(() => remoteFor(new MemoryStore()));
    expect(host.getServerCapabilities()?.resources).toBeDefined();

    const { resources } = await host.listResources();
    expect(resources.map((r) => r.uri)).toEqual([APP_RESOURCE_URI]);

    const { contents } = await host.readResource({ uri: APP_RESOURCE_URI });
    const page = contents[0] as { mimeType?: string; text?: string };
    expect(page.mimeType).toBe(APP_MIME_TYPE);
    expect(/^<!doctype html>/i.test(page.text!.trimStart())).toBe(true);

    // A host that sees `resources` enumerates templates too; "Method not found"
    // there is what the Desktop bundle would show for a server that has none.
    expect(await host.listResourceTemplates()).toEqual({ resourceTemplates: [] });
  });

  it("answers an empty list, and a not-found read, for a remote that serves no resources", async () => {
    const bare: Remote = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
      close: async () => undefined,
    };
    const { host } = await bridged(async () => bare);
    expect(await host.listResources()).toEqual({ resources: [] });
    expect(await host.listResourceTemplates()).toEqual({ resourceTemplates: [] });
    // -32002 is the code MCP reserves for a resource that does not exist.
    await expect(host.readResource({ uri: APP_RESOURCE_URI })).rejects.toMatchObject({ code: -32002 });
  });

  it("arms no watcher from a bellman_rooms result", async () => {
    const store = new MemoryStore();
    await store.createSession(session({ id: "qs_rooms", members: [member()] }));
    const { bridge, host } = await bridged(() => remoteFor(store));

    const result = (await host.callTool({ name: "bellman_rooms", arguments: {} })) as CallToolResult;
    const rooms = (result.structuredContent as { rooms: unknown[] }).rooms;
    expect(rooms).toHaveLength(1);
    expect(bridge.watching()).toEqual([]);
  });
});
