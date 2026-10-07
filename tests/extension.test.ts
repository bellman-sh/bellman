/**
 * The Claude Desktop bundle's manifest declares its tools, and Claude Desktop renders
 * that list during install — so it is the first description of Bellman a Desktop user
 * reads. It is hand-written prose in extension/manifest.json, and until this file
 * nothing tied it to the code: when the bundle moved into this repo the manifest named
 * nine tools, and had been missing bellman_whoami since the bridge grew it.
 *
 * What a bundle actually exposes is the server's tools plus the bridge's own, and which
 * of its own depends on BELLMAN_DELIVERY: src/bridge.ts lists bellman_wait only under
 * "hook". The manifest hardcodes that mode, so the mode is asserted here too — flipping
 * it to "channel" drops a tool from the real surface, and a names-only check would
 * otherwise go on passing against a list that had quietly become wrong.
 *
 * Names, not descriptions. The manifest's one-liners are deliberately shorter than the
 * tool descriptions the model is shown; holding them identical would force marketing
 * copy into a tool schema. Sibling of tests/tools/surface.test.ts, which pins the
 * server's eight.
 */
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveIdentity } from "../src/auth.js";
import { createBridge, type Remote } from "../src/bridge.js";
import { buildServer } from "../src/server.js";
import { MemoryBlobStore } from "../src/blobs.js";
import { MemoryStore } from "../src/store.js";
import { DEV_KEY } from "./helpers/harness.js";

interface ExtensionManifest {
  version: string;
  server: { entry_point: string; mcp_config: { env: Record<string, string> } };
  user_config: Record<string, unknown>;
  tools: { name: string; description?: string }[];
}

const manifest: ExtensionManifest = JSON.parse(
  readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8")
);

const pkg: { version: string } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
);

const declared = () => manifest.tools.map((t) => t.name).sort();

/**
 * The bundle's own surface: a hook-mode bridge over the real tool handlers, which is
 * exactly what manifest.json's mcp_config launches — node server/channel.js with
 * BELLMAN_DELIVERY=hook. Nothing is stubbed, so a tool added to either side shows up
 * here without this file being told about it.
 */
const temps: string[] = [];

async function bundleTools(): Promise<string[]> {
  const store = new MemoryStore();
  const identity = resolveIdentity(`Bearer ${DEV_KEY.jesse}`);
  if (!identity) throw new Error(`dev key ${DEV_KEY.jesse} no longer resolves`);

  const inboxDir = mkdtempSync(join(tmpdir(), "bellman-extension-"));
  temps.push(inboxDir);

  const bridge = createBridge({
    delivery: "hook",
    inboxDir,
    remote: async (): Promise<Remote> => {
      const server = buildServer(identity, store, new MemoryBlobStore());
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
    return tools.map((t) => t.name).sort();
  } finally {
    await bridge.close();
    await client.close();
  }
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the Claude Desktop bundle manifest", () => {
  it("declares every tool the bundle exposes, and no others", async () => {
    expect(declared()).toEqual(await bundleTools());
  });

  // The count as an assertion, not prose: tests/tools/surface.test.ts once said 7 over a
  // list of 8 and nothing failed. Eleven is the server's nine plus the bridge's two.
  it("declares exactly eleven tools", () => {
    expect(declared()).toHaveLength(11);
  });

  // Not cosmetic: the expected list above is mode-dependent, so this is what makes the
  // comparison meaningful rather than circular.
  it("launches the bridge in hook delivery, which is the mode that surface assumes", () => {
    expect(manifest.server.mcp_config.env.BELLMAN_DELIVERY).toBe("hook");
    expect(manifest.server.entry_point).toBe("server/channel.js");
  });

  it("gives every declared tool a description", () => {
    for (const tool of manifest.tools) {
      expect(tool.description?.trim(), tool.name).toBeTruthy();
    }
  });

  // build.sh overwrites this field from the package it packs, so a bundle's version is
  // never wrong. The committed value is a template — and it sat at 0.1.0 through two
  // releases, which is what anyone reading the file saw. Pinned so a version bump that
  // forgets it fails here instead.
  it("carries the package's version as its template version", () => {
    expect(manifest.version).toBe(pkg.version);
  });

  // The bridge signs itself in and caches the credential; BELLMAN_KEY unset is what makes
  // src/channel.ts take that path. The bundle asked for a key by hand long after it stopped
  // needing one, so a required install field collected a secret for nothing.
  it("asks for no key: the bridge signs itself in", () => {
    expect(manifest.user_config).not.toHaveProperty("bellman_key");
    expect(manifest.server.mcp_config.env).not.toHaveProperty("BELLMAN_KEY");
  });
});
