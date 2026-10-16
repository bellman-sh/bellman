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
 * server's twelve.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listHookBridgeTools } from "./helpers/tool-lists.js";

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

describe("the Claude Desktop bundle manifest", () => {
  it("declares every tool the bundle exposes, and no others", async () => {
    expect(declared()).toEqual((await listHookBridgeTools()).map((t) => t.name).sort());
  });

  // The count as an assertion, not prose: tests/tools/surface.test.ts once said 7 over a
  // list of 8 and nothing failed. Fifteen is the server's twelve plus the bridge's three.
  it("declares exactly fifteen tools", () => {
    expect(declared()).toHaveLength(15);
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

  // bellman_upload reads only from under BELLMAN_UPLOAD_ROOT, and the bridge's fallback is the directory it was
  // started in, which Desktop chooses and the person does not. So the bundle hands the person a setting for it.
  // A placeholder that names no declared setting is never filled: mcpb's replaceVariables leaves it in the value
  // as written.
  it("exposes the upload root as a folder setting, and every placeholder it passes names a setting it declares", () => {
    expect(manifest.user_config.upload_root).toMatchObject({ type: "directory", title: "Upload folder", required: false });
    expect(manifest.server.mcp_config.env.BELLMAN_UPLOAD_ROOT).toBe("${user_config.upload_root}");
    const declared = Object.keys(manifest.user_config);
    for (const [name, value] of Object.entries(manifest.server.mcp_config.env)) {
      for (const [, key] of value.matchAll(/\$\{user_config\.([^}]+)\}/g)) {
        expect(declared, `${name} names ${key}`).toContain(key);
      }
    }
  });
});
