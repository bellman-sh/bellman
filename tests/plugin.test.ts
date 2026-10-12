/**
 * The Claude Code plugin. The repository root is a marketplace named `bellman` that lists
 * one plugin, `plugin/`. Claude Code copies that directory into its cache and runs what
 * plugin/.mcp.json and plugin/hooks/hooks.json name from the copy, so what a user runs is
 * the committed bundle under plugin/bridge/, never src/. These tests read the committed
 * tree and spawn the committed bundle.
 *
 * The bundle is rebuilt in release PRs, not on every bridge change, so nothing here
 * compares it to src/ beyond the version: the version is what a release changes, and a
 * release that bumps it without `npm run build:plugin` fails here. The Stop-hook bundle
 * runs in tests/stop-hook.test.ts, beside the source it was built from.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN = join(ROOT, "plugin");

const json = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));
const pkg: { version: string } = json("package.json");

/** The plugin-relative paths a config file runs, as written after `${CLAUDE_PLUGIN_ROOT}/`. */
function referenced(path: string): string[] {
  const text = readFileSync(join(PLUGIN, path), "utf8");
  return [...text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\\\s]+)/g)].map((m) => m[1]);
}

/**
 * What makes Claude Code install a plugin's npm dependencies when it caches the plugin: a
 * package.json beside a lockfile it reads, at the plugin root. No setting turns that off,
 * which is why the plugin is plugin/ and not the repository root.
 */
const INSTALL_TRIGGERS = [
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "bun.lock", "bun.lockb", "yarn.lock", "pnpm-lock.yaml",
];

describe("the plugin's shape", () => {
  it("is listed by the repository's marketplace, bellman, from ./plugin", () => {
    const marketplace = json(".claude-plugin/marketplace.json");

    expect(marketplace.name).toBe("bellman");
    expect(marketplace.plugins).toEqual([expect.objectContaining({ name: "bellman", source: "./plugin" })]);
  });

  it("carries the package's version", () => {
    expect(json("plugin/.claude-plugin/plugin.json")).toMatchObject({ name: "bellman", version: pkg.version });
  });

  /**
   * node itself, not npx or a shell: hook delivery keys the inbox by the bridge's parent
   * PID, and the Stop hook finds it by walking up to Claude Code. A wrapper in between
   * puts the inbox under the wrapper's PID, where the hook never looks.
   */
  it("starts the bridge with node itself, in hook delivery", () => {
    expect(json("plugin/.mcp.json")).toEqual({
      mcpServers: {
        bellman: {
          command: "node",
          args: ["${CLAUDE_PLUGIN_ROOT}/bridge/channel.mjs"],
          env: { BELLMAN_DELIVERY: "hook" },
        },
      },
    });
  });

  it("runs only files that exist under plugin/", () => {
    const files = [...referenced(".mcp.json"), ...referenced("hooks/hooks.json")];

    expect(files).toEqual(["bridge/channel.mjs", "bridge/stop-hook.mjs"]);
    for (const file of files) expect(existsSync(join(PLUGIN, file)), file).toBe(true);
  });

  it("holds no package.json and no lockfile", () => {
    const found = readdirSync(PLUGIN, { recursive: true, encoding: "utf8" }).filter((path) =>
      INSTALL_TRIGGERS.includes(basename(path))
    );

    expect(found).toEqual([]);
  });

  it("carries both skills", () => {
    for (const skill of ["canvas", "room-manifest"]) {
      expect(existsSync(join(PLUGIN, "skills", skill, "SKILL.md")), skill).toBe(true);
    }
  });

  it("carries Bellman's license and the notices of every package it bundles", () => {
    expect(existsSync(join(PLUGIN, "LICENSE"))).toBe(true);
    const notices = readFileSync(join(PLUGIN, "bridge", "THIRD-PARTY-NOTICES.txt"), "utf8");
    for (const pkg of ["@modelcontextprotocol/sdk@", "fast-uri@", "yaml@", "zod@"]) {
      expect(notices, pkg).toContain(pkg);
    }
  });
});

describe("the committed bridge bundle, run as plugin/.mcp.json declares it", () => {
  const spawned: ChildProcess[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const proc of spawned.splice(0)) proc.kill("SIGKILL");
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * initialize, and nothing after it. tools/list would start a sign-in and register a
   * client with whatever BELLMAN_URL names, so the URL here is the discard port on
   * loopback, HOME and XDG_CONFIG_HOME are a directory deleted afterwards, and the bus,
   * which would make a socket under ~/.claude, is off.
   */
  async function initialize(): Promise<{ serverInfo: { name: string; version: string }; instructions?: string }> {
    const home = mkdtempSync(join(tmpdir(), "bellman-plugin-"));
    dirs.push(home);
    const { args, env } = json("plugin/.mcp.json").mcpServers.bellman as { args: string[]; env: Record<string, string> };

    const proc = spawn(process.execPath, args.map((arg) => arg.replace("${CLAUDE_PLUGIN_ROOT}", PLUGIN)), {
      env: {
        PATH: process.env.PATH,
        ...env,
        HOME: home,
        XDG_CONFIG_HOME: home,
        BELLMAN_BUS: "off",
        BELLMAN_URL: "http://127.0.0.1:9/mcp",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    spawned.push(proc);

    let stdout = "";
    let stderr = "";
    proc.stderr!.on("data", (chunk) => (stderr += String(chunk)));
    const answer = new Promise<string>((resolve, reject) => {
      proc.stdout!.on("data", (chunk) => {
        stdout += String(chunk);
        const line = stdout.split("\n").find((l) => l.includes('"id":1'));
        if (line) resolve(line);
      });
      proc.on("exit", (code) => reject(new Error(`the bundle exited ${code} before answering: ${stderr}`)));
    });

    proc.stdin!.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "plugin-test", version: "0.0.1" } },
      })}\n`
    );
    return JSON.parse(await answer).result;
  }

  it("reports package.json's version", async () => {
    const { serverInfo } = await initialize();

    expect(serverInfo).toEqual({ name: "bellman", version: pkg.version });
  });

  // By what only hook delivery tells the agent: the Stop hook hands events over, and
  // bellman_wait, which only a hook-mode bridge lists, blocks for them mid-turn.
  it("gives the agent the hook instructions", async () => {
    const { instructions } = await initialize();

    expect(instructions).toContain("Stop hook");
    expect(instructions).toContain("bellman_wait");
  });
});
