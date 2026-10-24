/**
 * `bellman doctor`: what Claude Code on this machine runs of Bellman, and the command that fixes each thing that is
 * not what a person would expect. It reads and asks, and changes nothing: each finding prints its fix, and
 * `bellman update` stays the one command here that installs.
 *
 * It came out of #365: a machine that "had updated bellman" showed no mod, for three reasons none of which Claude Code
 * showed. Its bridge was a user-scope MCP server, not the plugin, so updating the plugin changed nothing it ran; that
 * server's package was a release behind; and the marketplace had never been added, so the mod was not installed.
 *
 * Everything it reads arrives in `DoctorDeps`, so tests/doctor.test.ts drives it against fakes. The files it reads are
 * Claude Code's own, and their shapes are not a published API: anything that does not parse as expected is read as
 * absent, never thrown.
 */
import { request } from "node:http";
import { join } from "node:path";
import type { DoorStatus } from "./door-protocol.js";
import { compareVersions } from "./version.js";

const PACKAGE = "@bellman-sh/mcp-server";
const REPO = "bellman-sh/bellman";
/** The Claude Code build whose mod API `bellman-mod` was written against (README, the mod's section). */
export const MOD_BUILT_FOR = "2.1.301";

export interface DoctorDeps {
  /** This package's version: what `bellman-channel` runs when it resolves to this install. */
  version: string;
  home: string;
  cwd: string;
  /** Where bridges open their doors: `doorRoot()` in src/door.ts. */
  doorRoot: string;
  /** Runs a command to completion and captures its stdout; `status` is null when it could not be started. */
  exec(command: string, args: string[]): { status: number | null; stdout: string };
  /** A file's text, or null when there is none to read. */
  readText(path: string): string | null;
  /** A folder's entries, or null when there is no folder. */
  listDir(path: string): string[] | null;
  /** A path's permission bits, or null when there is nothing there. */
  mode(path: string): number | null;
  /** `GET /status` on a door, or null when nothing answers it. */
  askDoor(socketPath: string): Promise<unknown>;
  out(line: string): void;
}

export interface Finding {
  /** `fix`: something to change, with the commands that change it. `note`: a fact about the setup, nothing to run. */
  status: "ok" | "fix" | "note";
  line: string;
  run?: string[];
}

type Json = Record<string, unknown>;

function object(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function readJson(deps: DoctorDeps, path: string): Json | null {
  const text = deps.readText(path);
  if (text === null) return null;
  try {
    return object(JSON.parse(text));
  } catch {
    return null;
  }
}

/** -1, 0 or 1, or null when either side is not a version this can compare. */
function order(a: string, b: string): number | null {
  try {
    return compareVersions(a, b);
  } catch {
    return null;
  }
}

/** Whether an MCP server entry runs Bellman: the bridge's binary, the package, or the hosted server's URL. */
function isBellman(server: unknown): boolean {
  const text = JSON.stringify(server) ?? "";
  return text.includes("bellman-channel") || text.includes(PACKAGE) || text.includes("bellman.sh");
}

interface Configured {
  where: string;
  /** How to remove it, for when there are too many. */
  remove: string;
  /** A remote server (a `url`): Claude Code talks to it directly, with no local bridge. */
  remote: boolean;
}

/** The Bellman MCP servers Claude Code would start in `cwd`: user and local scope in ~/.claude.json, project scope in .mcp.json. */
function mcpServers(deps: DoctorDeps): Configured[] {
  const found: Configured[] = [];
  const add = (servers: unknown, where: string, scope: string): void => {
    for (const [name, server] of Object.entries(object(servers) ?? {})) {
      if (!isBellman(server)) continue;
      found.push({
        where: `MCP server "${name}" in ${where}`,
        remove: `claude mcp remove ${name} -s ${scope}`,
        remote: typeof object(server)?.url === "string",
      });
    }
  };
  const claudeJson = readJson(deps, join(deps.home, ".claude.json"));
  add(claudeJson?.mcpServers, "~/.claude.json (user scope)", "user");
  add(object(object(claudeJson?.projects)?.[deps.cwd])?.mcpServers, "~/.claude.json (local scope, this folder)", "local");
  add(readJson(deps, join(deps.cwd, ".mcp.json"))?.mcpServers, ".mcp.json (project scope)", "project");
  return found;
}

interface Plugins {
  /** The marketplace's name in Claude Code, when one points at this repo. */
  marketplace: string | null;
  /** An installed plugin's version, or null when it is not installed for this folder. */
  version(name: string): string | null;
  enabled(name: string): boolean;
}

function plugins(deps: DoctorDeps): Plugins {
  const dir = join(deps.home, ".claude", "plugins");
  const known = readJson(deps, join(dir, "known_marketplaces.json")) ?? {};
  const marketplace =
    Object.entries(known).find(([, entry]) => {
      const source = object(object(entry)?.source);
      return source?.repo === REPO || (typeof source?.url === "string" && source.url.includes(REPO));
    })?.[0] ?? null;
  const installed = object(readJson(deps, join(dir, "installed_plugins.json"))?.plugins) ?? {};
  const enabledPlugins = object(readJson(deps, join(deps.home, ".claude", "settings.json"))?.enabledPlugins) ?? {};
  const key = (name: string): string => `${name}@${marketplace}`;
  return {
    marketplace,
    version: (name) => {
      if (marketplace === null) return null;
      const entries = Array.isArray(installed[key(name)]) ? (installed[key(name)] as unknown[]) : [];
      // A project-scope install counts only in its own project.
      const entry = entries.map(object).find((e) => e !== null && (e.scope === "user" || e.projectPath === deps.cwd));
      return entry ? (typeof entry.version === "string" ? entry.version : "unknown") : null;
    },
    enabled: (name) => marketplace !== null && enabledPlugins[key(name)] !== false,
  };
}

/** A door's answer, if it is one: the door is another process's, so its shape is checked, not trusted. */
function doorStatus(value: unknown): Pick<DoorStatus, "delivery" | "has_sign_in" | "seats"> | null {
  const status = object(value);
  if (status === null || typeof status.delivery !== "string" || typeof status.has_sign_in !== "boolean") return null;
  if (!Array.isArray(status.seats)) return null;
  return status as unknown as DoorStatus;
}

/** Every check, in the order a person would fix them. */
export async function diagnose(deps: DoctorDeps): Promise<Finding[]> {
  const findings: Finding[] = [];

  // npm, not the registry directly, as `bellman update` asks: the user's own registry and proxy apply.
  const asked = deps.exec("npm", ["view", PACKAGE, "version"]);
  const latest = asked.status === 0 ? asked.stdout.trim() : null;
  if (latest === null) findings.push({ status: "note", line: "Could not ask npm for the latest version, so no version below is compared." });
  const behind = (version: string): boolean => latest !== null && order(version, latest) === -1;

  // This package: what `bellman-channel` runs when the PATH finds this install.
  findings.push(
    behind(deps.version)
      ? { status: "fix", line: `The bellman package is ${deps.version}; the latest is ${latest}.`, run: ["bellman update"] }
      : { status: "ok", line: `The bellman package is ${deps.version}${latest === null ? "" : `, the latest`}.` },
  );

  // Which bridges Claude Code starts here.
  const p = plugins(deps);
  const servers = mcpServers(deps);
  const pluginVersion = p.version("bellman");
  const local: string[] = [];
  if (pluginVersion !== null) {
    if (!p.enabled("bellman")) {
      findings.push({ status: "note", line: `The bellman plugin ${pluginVersion} is installed and disabled.` });
    } else {
      local.push(`the bellman plugin ${pluginVersion}`);
      if (behind(pluginVersion)) {
        findings.push({ status: "fix", line: `The bellman plugin is ${pluginVersion}; the latest is ${latest}.`, run: [`claude plugin update bellman@${p.marketplace}`] });
      }
    }
  }
  for (const server of servers) {
    if (server.remote) {
      findings.push({ status: "note", line: `${server.where} connects to the hosted server with no local bridge: the mod and the Stop hook see nothing through it.` });
    } else {
      local.push(server.where);
    }
  }
  if (local.length === 0) {
    findings.push({
      status: "fix",
      line: "No local bridge: Claude Code here starts no Bellman bridge, so rooms reach no session and the mod has nothing to show.",
      run: p.marketplace === null
        ? ["claude plugin marketplace add bellman-sh/bellman", "claude plugin install bellman@bellman"]
        : [`claude plugin install bellman@${p.marketplace}`],
    });
  } else if (local.length === 1) {
    findings.push({ status: "ok", line: `One local bridge: ${local[0]}.` });
  } else {
    // Each one is a Bellman server in every session, with its own seats and its own door.
    findings.push({
      status: "fix",
      line: `${local.length} local bridges start in every session: ${local.join("; ")}. Keep one.`,
      run: servers.filter((s) => !s.remote).map((s) => s.remove),
    });
  }

  // The mod.
  const modVersion = p.version("bellman-mod");
  if (p.marketplace === null) {
    findings.push({
      status: "fix",
      line: "The bellman marketplace is not added, so bellman-mod is not installed.",
      run: ["claude plugin marketplace add bellman-sh/bellman", "claude plugin install bellman-mod@bellman"],
    });
  } else if (modVersion === null) {
    findings.push({ status: "fix", line: "bellman-mod is not installed.", run: [`claude plugin install bellman-mod@${p.marketplace}`] });
  } else if (!p.enabled("bellman-mod")) {
    findings.push({ status: "fix", line: `bellman-mod ${modVersion} is installed and disabled.`, run: [`claude plugin enable bellman-mod@${p.marketplace}`] });
  } else if (behind(modVersion)) {
    findings.push({ status: "fix", line: `bellman-mod is ${modVersion}; the latest is ${latest}.`, run: [`claude plugin update bellman-mod@${p.marketplace}`] });
  } else {
    findings.push({ status: "ok", line: `bellman-mod ${modVersion} is installed and enabled.` });
  }

  // The doors: what the mod reads. The folder's 0700 is the only check on who may connect (src/door.ts).
  const mode = deps.mode(deps.doorRoot);
  const sockets = (deps.listDir(deps.doorRoot) ?? []).filter((name) => name.endsWith(".sock")).sort();
  if (mode === null) {
    findings.push({ status: "note", line: `No bridge has opened a door yet (${deps.doorRoot} does not exist).` });
  } else {
    if ((mode & 0o077) !== 0) {
      findings.push({
        status: "fix",
        line: `${deps.doorRoot} is open to other users (mode ${(mode & 0o777).toString(8)}); a bridge makes it 0700.`,
        run: [`chmod 700 ${JSON.stringify(deps.doorRoot)}`],
      });
    }
    const answers = await Promise.all(sockets.map(async (name) => ({ name, status: doorStatus(await deps.askDoor(join(deps.doorRoot, name))) })));
    const live = answers.filter((a) => a.status !== null);
    for (const { name, status } of live) {
      const seats = status!.seats.length;
      const line = `The door ${name} answers: ${status!.delivery} delivery, ${seats} ${seats === 1 ? "seat" : "seats"}`;
      findings.push(
        status!.has_sign_in
          ? { status: "ok", line: `${line}, signed in.` }
          : { status: "note", line: `${line}, not signed in: the next Bellman tool call in that session asks you to sign in.` },
      );
    }
    const stale = answers.length - live.length;
    if (stale > 0) {
      findings.push({ status: "note", line: `${stale} ${stale === 1 ? "door was" : "doors were"} left by bridges that have exited; harmless.` });
    }
    if (live.length === 0) {
      findings.push({ status: "note", line: "No running bridge answered: the mod shows a bridge once a Claude Code session has started it." });
    }
  }

  // Claude Code itself.
  const claude = deps.exec("claude", ["--version"]);
  const build = claude.status === 0 ? /\d+\.\d+\.\d+/.exec(claude.stdout)?.[0] ?? null : null;
  if (build === null) {
    findings.push({ status: "note", line: "Could not run claude --version, so the Claude Code build is not checked." });
  } else if (order(build, MOD_BUILT_FOR) === -1) {
    findings.push({ status: "fix", line: `Claude Code is ${build}; bellman-mod was written for ${MOD_BUILT_FOR} or later.`, run: ["claude update"] });
  } else {
    findings.push({ status: "ok", line: `Claude Code is ${build} (bellman-mod was written for ${MOD_BUILT_FOR}; a build without mods skips it quietly).` });
  }

  return findings;
}

/** Prints every finding, and exits 1 when any has something to fix. */
export async function doctor(deps: DoctorDeps): Promise<number> {
  const findings = await diagnose(deps);
  for (const f of findings) {
    deps.out(`${f.status.padEnd(4)}  ${f.line}`);
    for (const command of f.run ?? []) deps.out(`        $ ${command}`);
  }
  return findings.some((f) => f.status === "fix") ? 1 : 0;
}

/** `GET /status` on a door's socket, as the mod asks it; null for anything but a 200 with JSON inside a second. */
export function askDoor(socketPath: string): Promise<unknown> {
  return new Promise((resolve) => {
    const req = request({ socketPath, path: "/status", timeout: 1000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(res.statusCode === 200 ? JSON.parse(body) : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });
}
