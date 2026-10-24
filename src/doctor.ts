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
 * absent, never thrown. Some of what it prints came from a cloned repository (`.mcp.json`) or from another process (a
 * door), so nothing is printed raw: control characters are removed from every line, and a command argument that is not
 * plain is quoted.
 */
import { request } from "node:http";
import { join } from "node:path";
import type { DoorStatus } from "./door-protocol.js";
import { compareVersions } from "./version.js";

const PACKAGE = "@bellman-sh/mcp-server";
const REPO = "bellman-sh/bellman";
/** A marketplace added by URL: this repo's, and not `bellman-sh/bellman-anything`. */
const REPO_URL = /[/:]bellman-sh\/bellman(\.git)?\/?$/;
/** The Claude Code build whose mod API `bellman-mod` was written against (README, the mod's section). */
export const MOD_BUILT_FOR = "2.1.301";
/** How long a door has to answer, start to finish, and the most of an answer that is read. */
const DOOR_DEADLINE_MS = 1000;
const DOOR_MAX_BYTES = 64 * 1024;

export interface DoctorDeps {
  /** This package's version: what `bellman-channel` runs when it resolves to this install. */
  version: string;
  home: string;
  cwd: string;
  /** `process.platform`: Windows reports group and other permission bits on every folder. */
  platform: string;
  /** Where bridges open their doors: `doorRoot()` in src/door.ts. */
  doorRoot: string;
  /** True when `BELLMAN_DOOR_ROOT` is unset: only then is the folder one a bridge made 0700. */
  doorRootIsDefault: boolean;
  /** Runs a command to completion and captures its stdout; `status` is null when it could not be started. */
  exec(command: string, args: string[]): { status: number | null; stdout: string };
  /** A file's text, or null when there is none to read. */
  readText(path: string): string | null;
  /** A folder's entries, or null when there is no folder. */
  listDir(path: string): string[] | null;
  /** A path's permission bits, or null when there is nothing there. */
  mode(path: string): number | null;
  /** `GET /status` on a door: see `DoorAnswer`. */
  askDoor(socketPath: string): Promise<DoorAnswer>;
  out(line: string): void;
}

/** A door's answer: its status, `gone` when nothing is there to connect to (a bridge that exited), `silent` for anything else. */
export type DoorAnswer = { status: unknown } | "gone" | "silent";

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

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** -1, 0 or 1, or null when either side is not a version this can compare. */
function order(a: string, b: string): number | null {
  try {
    return compareVersions(a, b);
  } catch {
    return null;
  }
}

/** The one place text is made safe to print: no control character survives, so no field can start a line of its own or move the cursor. */
function clean(text: string): string {
  return text.replace(/\p{Cc}/gu, "");
}

/** A command argument a shell reads as itself: plain characters as they are, anything else in single quotes. */
function quote(arg: string): string {
  return /^[A-Za-z0-9_./@:-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

const cmd = (...args: string[]): string => args.map(quote).join(" ");

type Scope = "local" | "project" | "user";
/** Claude Code's precedence when one name is configured in several scopes. */
const PRECEDENCE: Scope[] = ["local", "project", "user"];

/** What a configured server is to Bellman: a bridge on this machine, the hosted server reached directly, or neither. Never reads `env`. */
function classify(server: unknown): "local" | "remote" | null {
  const entry = object(server);
  if (entry === null) return null;
  if (typeof entry.url === "string") return entry.url.includes("bellman.sh") ? "remote" : null;
  const words = [...strings([entry.command]), ...strings(entry.args)];
  if (words.includes("mcp-remote") && words.some((word) => word.includes("bellman.sh"))) return "remote";
  const runsBridge = words.some(
    (word) =>
      word.endsWith("bellman-channel") ||
      word.includes(PACKAGE) ||
      ((word.endsWith("/channel.js") || word.endsWith("/channel.mjs")) && word.includes("bellman")),
  );
  return runsBridge ? "local" : null;
}

/** `~/.claude/settings.json`, then the project's two, later winning: the settings Claude Code merges for this folder. */
function settings(deps: DoctorDeps): { enabledPlugins: Json; enableAllProjectMcpServers: boolean } {
  const files = [
    join(deps.home, ".claude", "settings.json"),
    join(deps.cwd, ".claude", "settings.json"),
    join(deps.cwd, ".claude", "settings.local.json"),
  ];
  const merged = { enabledPlugins: {} as Json, enableAllProjectMcpServers: false };
  for (const file of files) {
    const read = readJson(deps, file);
    Object.assign(merged.enabledPlugins, object(read?.enabledPlugins) ?? {});
    if (typeof read?.enableAllProjectMcpServers === "boolean") merged.enableAllProjectMcpServers = read.enableAllProjectMcpServers;
  }
  return merged;
}

interface Counted {
  name: string;
  scope: Scope;
  where: string;
  /** A remote server (a `url`): Claude Code talks to it directly, with no local bridge. */
  remote: boolean;
}

interface Servers {
  /** Bellman servers Claude Code would start here, highest scope first. */
  counted: Counted[];
  /** Names of Bellman servers in `.mcp.json` that Claude Code has neither approved nor refused. */
  waiting: string[];
}

const WHERE: Record<Scope, string> = {
  local: "~/.claude.json (local scope, this folder)",
  project: ".mcp.json (project scope)",
  user: "~/.claude.json (user scope)",
};

/**
 * The servers Claude Code would start in `cwd`. A name configured in several scopes is one server, the highest
 * scope's; a `.mcp.json` server is started only once approved, and never once refused.
 */
function mcpServers(deps: DoctorDeps, enableAll: boolean): Servers {
  const claudeJson = readJson(deps, join(deps.home, ".claude.json"));
  const project = object(object(claudeJson?.projects)?.[deps.cwd]);
  const approved = strings(project?.enabledMcpjsonServers);
  const refused = strings(project?.disabledMcpjsonServers);
  const scopes: Record<Scope, Json> = {
    user: object(claudeJson?.mcpServers) ?? {},
    project: object(readJson(deps, join(deps.cwd, ".mcp.json"))?.mcpServers) ?? {},
    local: object(project?.mcpServers) ?? {},
  };

  const byName = new Map<string, { scope: Scope; server: unknown }>();
  const waiting: string[] = [];
  for (const scope of [...PRECEDENCE].reverse()) {
    for (const [name, server] of Object.entries(scopes[scope])) {
      if (scope === "project") {
        if (refused.includes(name)) continue;
        if (!approved.includes(name) && !enableAll) {
          if (classify(server) !== null) waiting.push(name);
          continue;
        }
      }
      byName.set(name, { scope, server });
    }
  }
  const counted: Counted[] = [];
  for (const [name, { scope, server }] of byName) {
    const kind = classify(server);
    if (kind !== null) counted.push({ name, scope, where: `MCP server "${name}" in ${WHERE[scope]}`, remote: kind === "remote" });
  }
  counted.sort((a, b) => PRECEDENCE.indexOf(a.scope) - PRECEDENCE.indexOf(b.scope));
  return { counted, waiting };
}

interface Plugins {
  /** The marketplace's name in Claude Code, when one points at this repo. */
  marketplace: string | null;
  /** An installed plugin's version, or null when it is not installed for this folder. */
  version(name: string): string | null;
  /** Whether the settings Claude Code merges for this folder say `true` for it. */
  enabled(name: string): boolean;
}

function plugins(deps: DoctorDeps, enabledPlugins: Json): Plugins {
  const dir = join(deps.home, ".claude", "plugins");
  const known = Object.entries(readJson(deps, join(dir, "known_marketplaces.json")) ?? {});
  // Added from this repo by name or URL; failing that, one keyed `bellman`, as a local clone's path marketplace is.
  const marketplace =
    known.find(([, entry]) => {
      const source = object(object(entry)?.source);
      return source?.repo === REPO || (typeof source?.url === "string" && REPO_URL.test(source.url));
    })?.[0] ??
    known.find(([key]) => key === "bellman")?.[0] ??
    null;
  const installed = object(readJson(deps, join(dir, "installed_plugins.json"))?.plugins) ?? {};
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
    enabled: (name) => marketplace !== null && enabledPlugins[key(name)] === true,
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
  const merged = settings(deps);
  const p = plugins(deps, merged.enabledPlugins);
  const { counted, waiting } = mcpServers(deps, merged.enableAllProjectMcpServers);
  const pluginVersion = p.version("bellman");
  const pluginRuns = pluginVersion !== null && p.enabled("bellman");
  const pluginDisabled = pluginVersion !== null && !pluginRuns;
  const local: string[] = [];
  if (pluginRuns) {
    local.push(`the bellman plugin ${pluginVersion}`);
    if (behind(pluginVersion)) {
      findings.push({ status: "fix", line: `The bellman plugin is ${pluginVersion}; the latest is ${latest}.`, run: [cmd("claude", "plugin", "update", `bellman@${p.marketplace}`)] });
    }
  }
  const servers = counted.filter((s) => !s.remote);
  for (const server of counted) {
    if (server.remote) {
      findings.push({ status: "note", line: `${server.where} connects to the hosted server with no local bridge: the mod and the Stop hook see nothing through it.` });
    } else {
      local.push(server.where);
    }
  }
  for (const name of waiting) {
    findings.push({ status: "note", line: `MCP server "${name}" in ${WHERE.project} waits for your approval in Claude Code, so it starts no bridge yet.` });
  }
  if (local.length === 0) {
    if (pluginDisabled) {
      findings.push({
        status: "fix",
        line: `The bellman plugin ${pluginVersion} is installed and disabled, and nothing else starts a bridge, so rooms reach no session.`,
        run: [cmd("claude", "plugin", "enable", `bellman@${p.marketplace}`)],
      });
    } else {
      findings.push({
        status: "fix",
        line: "No local bridge: Claude Code here starts no Bellman bridge, so rooms reach no session and the mod has nothing to show.",
        run: p.marketplace === null
          ? ["claude plugin marketplace add bellman-sh/bellman", "claude plugin install bellman@bellman"]
          : [cmd("claude", "plugin", "install", `bellman@${p.marketplace}`)],
      });
    }
  } else if (local.length === 1) {
    if (pluginDisabled) findings.push({ status: "note", line: `The bellman plugin ${pluginVersion} is installed and disabled.` });
    findings.push({ status: "ok", line: `One local bridge: ${local[0]}.` });
  } else {
    if (pluginDisabled) findings.push({ status: "note", line: `The bellman plugin ${pluginVersion} is installed and disabled.` });
    // Each one is a Bellman server in every session, with its own seats and its own door. Never advise removing them all.
    const kept = pluginRuns ? null : servers[0];
    const remove = kept === null ? servers : servers.slice(1);
    findings.push({
      status: "fix",
      line: `${local.length} local bridges start in every session: ${local.join("; ")}. ${kept === null ? "Keep the plugin and remove the servers." : `Keeping ${kept.where}.`}`,
      run: remove.map((s) => cmd("claude", "mcp", "remove", s.name, "-s", s.scope)),
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
    findings.push({ status: "fix", line: "bellman-mod is not installed.", run: [cmd("claude", "plugin", "install", `bellman-mod@${p.marketplace}`)] });
  } else if (!p.enabled("bellman-mod")) {
    findings.push({ status: "fix", line: `bellman-mod ${modVersion} is installed and disabled.`, run: [cmd("claude", "plugin", "enable", `bellman-mod@${p.marketplace}`)] });
  } else if (behind(modVersion)) {
    findings.push({ status: "fix", line: `bellman-mod is ${modVersion}; the latest is ${latest}.`, run: [cmd("claude", "plugin", "update", `bellman-mod@${p.marketplace}`)] });
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
      const open = `${deps.doorRoot} is open to other users (mode ${(mode & 0o777).toString(8)}); a bridge creates it 0700`;
      if (deps.doorRootIsDefault && deps.platform !== "win32") {
        findings.push({ status: "fix", line: `${open}.`, run: [cmd("chmod", "700", deps.doorRoot)] });
      } else if (!deps.doorRootIsDefault) {
        findings.push({ status: "note", line: `${open}, but BELLMAN_DOOR_ROOT names this folder and a bridge leaves an existing folder's mode alone.` });
      } else {
        findings.push({ status: "note", line: `${open}, but Windows reports these bits on every folder, so this is not checked there.` });
      }
    }
    const live: { name: string; status: NonNullable<ReturnType<typeof doorStatus>> }[] = [];
    const silent: string[] = [];
    let gone = 0;
    const answers = await Promise.all(sockets.map(async (name) => ({ name, answer: await deps.askDoor(join(deps.doorRoot, name)) })));
    for (const { name, answer } of answers) {
      if (answer === "gone") {
        gone++;
      } else {
        const status = typeof answer === "object" && answer !== null ? doorStatus(answer.status) : null;
        if (status === null) silent.push(name);
        else live.push({ name, status });
      }
    }
    for (const { name, status } of live) {
      const seats = status.seats.length;
      const line = `The door ${name} answers: ${status.delivery} delivery, ${seats} ${seats === 1 ? "seat" : "seats"}`;
      findings.push(
        status.has_sign_in
          ? { status: "ok", line: `${line}, signed in.` }
          : { status: "note", line: `${line}, not signed in: the next Bellman tool call in that session asks you to sign in.` },
      );
    }
    if (gone > 0) {
      findings.push({ status: "note", line: `${gone} ${gone === 1 ? "door was" : "doors were"} left by bridges that have exited; harmless.` });
    }
    if (silent.length > 0) {
      findings.push({
        status: "note",
        line: `${silent.length} ${silent.length === 1 ? "door" : "doors"} did not answer as expected: ${silent.join(", ")}.`,
      });
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

/** Prints every finding, and exits 1 when any has something to fix. A command is printed once, at its first finding. */
export async function doctor(deps: DoctorDeps): Promise<number> {
  const findings = await diagnose(deps);
  const shown = new Set<string>();
  for (const f of findings) {
    deps.out(clean(`${f.status.padEnd(4)}  ${f.line}`));
    for (const command of f.run ?? []) {
      if (shown.has(command)) continue;
      shown.add(command);
      deps.out(clean(`        $ ${command}`));
    }
  }
  return findings.some((f) => f.status === "fix") ? 1 : 0;
}

/**
 * `GET /status` on a door's socket, as the mod asks it. It always settles: the answer inside one second from the
 * request (a door that sends headers and stalls, or trickles, is `silent` at the deadline) and no more than 64 KB of it.
 * `gone` is a socket nobody listens on or a path nothing is at, which is what a bridge that exited leaves.
 */
export function askDoor(socketPath: string): Promise<DoorAnswer> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (answer: DoorAnswer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req.destroy();
      resolve(answer);
    };
    // agent: false, a connection of its own: the shared agent keeps a finished request's socket for reuse, and a door
    // that has since closed would then answer the next ask with a broken pipe instead of "gone".
    const req = request({ socketPath, path: "/status", agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > DOOR_MAX_BYTES) settle("silent");
      });
      res.on("end", () => {
        try {
          settle(res.statusCode === 200 ? { status: JSON.parse(body) } : "silent");
        } catch {
          settle("silent");
        }
      });
      res.on("error", () => settle("silent"));
      res.on("close", () => settle("silent"));
    });
    const deadline = setTimeout(() => settle("silent"), DOOR_DEADLINE_MS);
    req.on("error", (error: NodeJS.ErrnoException) => settle(error.code === "ENOENT" || error.code === "ECONNREFUSED" ? "gone" : "silent"));
    req.on("close", () => settle("silent"));
    req.end();
  });
}
