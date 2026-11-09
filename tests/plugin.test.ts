/**
 * The Claude Code plugins. The repository root is a marketplace named `bellman` that lists
 * two: `plugin/`, and the mod, `mod/`. Claude Code copies each directory into its cache and
 * runs what plugin/.mcp.json and plugin/hooks/hooks.json name from the copy, so what a user
 * runs is the committed bundle under plugin/bridge/, never src/; the mod runs its committed
 * mod/hooks/register.mjs the same way. These tests read the committed tree and spawn the
 * committed bundle. The mod's own behaviour is tested by its kit tests (`npm run test:mod`).
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
const MOD = join(ROOT, "mod");

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

/** Every plugin-relative file under `dir` that would make Claude Code install dependencies. */
function installTriggers(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((path) => INSTALL_TRIGGERS.includes(basename(path)));
}

describe("the plugin's shape", () => {
  it("is listed by the repository's marketplace, bellman, from ./plugin, and the mod from ./mod", () => {
    const marketplace = json(".claude-plugin/marketplace.json");

    expect(marketplace.name).toBe("bellman");
    expect(marketplace.plugins).toEqual([
      expect.objectContaining({ name: "bellman", source: "./plugin" }),
      expect.objectContaining({ name: "bellman-mod", source: "./mod" }),
    ]);
  });

  it("carries the package's version", () => {
    expect(json("plugin/.claude-plugin/plugin.json")).toMatchObject({ name: "bellman", version: pkg.version });
  });

  /**
   * node itself, not npx or a shell: hook delivery keys the inbox by the bridge's parent
   * PID, and the Stop hook finds it by walking up to Claude Code. A wrapper in between
   * puts the inbox under the wrapper's PID, where the hook never looks.
   */
  // BELLMAN_INSTALL tells the bridge it runs from the plugin, so an update notice names `claude plugin update`.
  it("starts the bridge with node itself, in hook delivery, as the plugin's install", () => {
    expect(json("plugin/.mcp.json")).toEqual({
      mcpServers: {
        bellman: {
          command: "node",
          args: ["${CLAUDE_PLUGIN_ROOT}/bridge/channel.mjs"],
          env: { BELLMAN_DELIVERY: "hook", BELLMAN_INSTALL: "plugin" },
        },
      },
    });
  });

  /**
   * The monitor replaces channel pushes, which MCP 2026-07-28 cannot carry: Claude Code runs it for the whole session
   * and what it prints reaches Claude. Through node and the plugin root, like every other entry, and declared where
   * Claude Code reads monitors from: `experimental.monitors` in plugin.json.
   */
  it("declares one monitor, run with node from the plugin's bundle", () => {
    expect(json("plugin/.claude-plugin/plugin.json").experimental).toEqual({
      monitors: [{
        name: "bellman-events",
        command: 'node "${CLAUDE_PLUGIN_ROOT}/bridge/monitor.mjs"',
        description: "Peer events from your Bellman rooms, as they arrive",
      }],
    });
  });

  it("runs only files that exist under plugin/", () => {
    const files = [...referenced(".mcp.json"), ...referenced("hooks/hooks.json"), ...referenced(".claude-plugin/plugin.json")];

    expect(files).toEqual([
      "bridge/channel.mjs", "bridge/join-hook.mjs", "bridge/stop-hook.mjs", "bridge/status-hook.mjs", "bridge/status-hook.mjs",
      "bridge/monitor.mjs",
    ]);
    for (const file of files) expect(existsSync(join(PLUGIN, file)), file).toBe(true);
  });

  it("holds no package.json and no lockfile", () => {
    expect(installTriggers(PLUGIN)).toEqual([]);
  });

  it("carries every skill", () => {
    for (const skill of ["canvas", "room-manifest", "memory-import"]) {
      expect(existsSync(join(PLUGIN, "skills", skill, "SKILL.md")), skill).toBe(true);
    }
  });

  it("carries Bellman's license and the notices of every package it bundles", () => {
    expect(existsSync(join(PLUGIN, "LICENSE"))).toBe(true);
    const notices = readFileSync(join(PLUGIN, "bridge", "THIRD-PARTY-NOTICES.txt"), "utf8");
    for (const pkg of ["yaml@", "zod@"]) {
      expect(notices, pkg).toContain(pkg);
    }
    // The MCP SDK: v1's one package, which brought fast-uri in through ajv, or, once a release rebuilds the
    // bundles, v2's split packages, which bring neither.
    if (notices.includes("@modelcontextprotocol/sdk@")) expect(notices).toContain("fast-uri@");
    else expect(notices).toMatch(/@modelcontextprotocol\/(core|client|server)@/);
  });
});

/**
 * The mod: a plugin that is a hooks module alone. Its bundle is built from mod/src (and the
 * runtime-free modules under src/ it imports) by `npm run build:mod`, and committed.
 */
describe("the mod's shape", () => {
  it("carries the package's version and its types", () => {
    expect(json("mod/.claude-plugin/plugin.json")).toMatchObject({ name: "bellman-mod", version: pkg.version, types: "./types/index.d.ts" });
  });

  it("runs only its committed module", () => {
    expect(json("mod/hooks/hooks.json")).toEqual({ modules: ["./register.mjs"] });
    expect(existsSync(join(MOD, "hooks", "register.mjs"))).toBe(true);
  });

  /**
   * The engine hands a hooks module `claude-code` and nothing else: the module runs with no
   * Node and no node_modules, so every other import must have been bundled in. The scan has to
   * find the one import there is, or it proves nothing.
   */
  it("imports nothing but claude-code", () => {
    const bundle = readFileSync(join(MOD, "hooks", "register.mjs"), "utf8");
    const specifiers = [...bundle.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g)].map((m) => m[1] ?? m[2]);

    expect([...new Set(specifiers)]).toEqual(["claude-code"]);
  });

  it("holds no package.json and no lockfile", () => {
    expect(installTriggers(MOD)).toEqual([]);
  });

  it("carries Bellman's license", () => {
    expect(readFileSync(join(MOD, "LICENSE"), "utf8")).toBe(readFileSync(join(PLUGIN, "LICENSE"), "utf8"));
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
  /** The handshake Claude Code sends (2026-07-28), and the one Claude Desktop still sends (a 2025-era `initialize`). */
  const DISCOVER = {
    method: "server/discover",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "plugin-test", version: "0.0.1" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
  const LEGACY_INITIALIZE = {
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-ai", version: "0.1.0" } },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function initialize(opening: { method: string; params: unknown } = DISCOVER): Promise<any> {
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

    proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, ...opening })}\n`);
    const reply = JSON.parse(await answer);
    if (reply.error) throw new Error(`the bundle refused ${opening.method}: ${JSON.stringify(reply.error)}`);
    return reply.result;
  }

  it("reports package.json's version", async () => {
    // On 2026-07-28 the server names itself in the result's _meta, as a client does in each request's.
    const { _meta } = await initialize();

    expect(_meta["io.modelcontextprotocol/serverInfo"]).toEqual({ name: "bellman", version: pkg.version });
  });

  // By what only hook delivery tells the agent: the Stop hook hands events over, and
  // bellman_wait, which only a hook-mode bridge lists, blocks for them mid-turn.
  it("gives the agent the hook instructions", async () => {
    const { instructions } = await initialize();

    expect(instructions).toContain("Stop hook");
    expect(instructions).toContain("bellman_wait");
  });

  // Claude Desktop opens the .mcpb with a 2025-era `initialize` (its MCP log, 9 Nov). A bundle that refuses it shows no
  // Bellman tools there at all.
  it("answers the 2025-era initialize Claude Desktop sends, with the same server and instructions", async () => {
    const result = await initialize(LEGACY_INITIALIZE);

    expect(result.serverInfo).toMatchObject({ name: "bellman", version: pkg.version });
    expect(result.instructions).toContain("bellman_wait");
  });
});
