#!/usr/bin/env node
/**
 * The `bellman` command: what a person types, as opposed to what Claude Code spawns.
 *
 *   bellman feature-request [words...]   open the feature-request form on GitHub, the words as its title
 *   bellman update [--check]             install the latest release from npm; --check only reports
 *   bellman version | help
 *
 * `run` is the whole command and does nothing by itself. Every side effect (spawning npm, opening a
 * browser, looking at the filesystem, printing) arrives in `CliDeps`, so tests/cli.test.ts drives it
 * against fakes. The bottom of the file wires the real ones and starts `run` only when this file is the
 * entry point, which is what keeps an import from a test inert.
 */
import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { VERSION } from "./version.js";

const PACKAGE = "@bellman-sh/mcp-server";
const FEATURE_FORM = "https://github.com/bellman-sh/bellman/issues/new?template=feature_request.yml";
/** What `update` runs on a global install, and what --check says it would run. One definition, so they cannot differ. */
const INSTALL_GLOBAL = { command: "npm", args: ["install", "-g", `${PACKAGE}@latest`] };
const INSTALL_LOCAL = `npm install ${PACKAGE}@latest`;
const UPDATE_CLONE = "git pull && npm install && npm run build";

const USAGE = [
  "Usage: bellman <command>",
  "",
  "  feature-request [words...]  open the feature-request form on GitHub; the words become its title",
  "  update [--check]            install the latest release from npm; --check only reports",
  "  version                     print the installed version (also --version, -v)",
  "  help                        print this text (also --help, -h)",
];

/**
 * GitHub's feature-request form for this repo, with the words as its title when there are any. The title is
 * the one part a person types, so it is encoded whole: a & in it must not start a parameter of its own.
 */
export function featureRequestUrl(words: string[]): string {
  const title = words.join(" ").trim();
  return title === "" ? FEATURE_FORM : `${FEATURE_FORM}&title=${encodeURIComponent(title)}`;
}

/** "0.4.0-rc.1" is [0, 4, 0]: a prerelease or build suffix is dropped. Null for anything that is not dotted numbers. */
function numbers(version: string): number[] | null {
  const match = /^(\d+(?:\.\d+)*)(?:[-+].*)?$/.exec(version.trim());
  return match?.[1] ? match[1].split(".").map(Number) : null;
}

/**
 * Negative when `a` is older than `b`, positive when newer, 0 when equal. Number by number, so 0.10.0 is
 * newer than 0.9.9; where one has more numbers than the other and they agree as far as both go, the longer
 * is newer (0.3.1.1 over 0.3.1). Throws for text that is not a version: ordering it would be a guess.
 */
export function compareVersions(a: string, b: string): number {
  const left = numbers(a);
  const right = numbers(b);
  if (!left || !right) throw new Error(`not a version: ${JSON.stringify(left ? b : a)}`);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return Math.sign(left.length - right.length);
}

export type InstallKind = "clone" | "global" | "local";

/** Whether `child` is a path under `parent`, and not `parent` itself or a sibling that merely starts with its name. */
function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/**
 * How this package got where it is, from the directory holding its package.json.
 *
 * A version-control entry there is a clone, and is asked first: npm link and `npm install -g <folder>` both
 * put a clone under npm's global root, and it is updated with git, not with npm. `.jj` counts as well as
 * `.git`, because a jj workspace has the one and not the other. An npm install never carries either: the
 * package's `files` list is dist, bin, README.md and LICENSE.
 *
 * Under npm's global root (`npm root -g`) it is a global install. Anything else is a dependency of some
 * project.
 */
export function installKind(
  packageRoot: string,
  globalRoot: string | null,
  exists: (path: string) => boolean,
): InstallKind {
  if (exists(join(packageRoot, ".git")) || exists(join(packageRoot, ".jj"))) return "clone";
  if (globalRoot !== null && isInside(globalRoot, packageRoot)) return "global";
  return "local";
}

export interface CliDeps {
  /** The installed version: src/version.ts, which is the package.json this file ships in. */
  version: string;
  /** Runs a command to completion and captures its stdout. `status` is null when it could not be started or was killed. */
  exec(command: string, args: string[]): { status: number | null; stdout: string };
  /** Runs a command on the terminal's own stdio, for the install: npm's progress and errors are the output. Null as for exec. */
  execInherited(command: string, args: string[]): number | null;
  /** Opens a URL in the user's browser. It may throw; `run` reads that as no browser and carries on. */
  open(url: string): void;
  exists(path: string): boolean;
  /** Resolves symbolic links. Both sides of the global-root comparison go through it. */
  realpath(path: string): string;
  /** The directory holding this package's package.json. */
  packageRoot: string;
  out(line: string): void;
  err(line: string): void;
}

/** The command, as an exit code. Everything it does to the world goes through `deps`. */
export async function run(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      for (const line of USAGE) deps.out(line);
      return 0;
    case "version":
    case "--version":
    case "-v":
      deps.out(deps.version);
      return 0;
    case "feature-request":
      return featureRequest(args, deps);
    case "update":
      return update(args, deps);
    default:
      return usageError(`unknown command "${command}"`, deps);
  }
}

function usageError(message: string, deps: CliDeps): number {
  deps.err(`bellman: ${message}`);
  for (const line of USAGE) deps.err(line);
  return 1;
}

/**
 * Prints the URL, then tries to open it, in that order. Over SSH there is no browser, and the printed line is
 * all a person has; so it comes first, and nothing the opening does can take it back.
 */
function featureRequest(words: string[], deps: CliDeps): number {
  const url = featureRequestUrl(words);
  deps.out(url);
  try {
    deps.open(url);
  } catch {
    // No browser to open is not a failure: the URL above is the way in.
  }
  return 0;
}

/** Where npm keeps global packages, resolved; null when npm cannot say. */
function globalRoot(deps: CliDeps): string | null {
  const asked = deps.exec("npm", ["root", "-g"]);
  const root = asked.status === 0 ? asked.stdout.trim() : "";
  return root === "" ? null : deps.realpath(root);
}

function update(args: string[], deps: CliDeps): number {
  // An option it does not know is refused, never skipped: `update --chek` is a typo for the safe option,
  // and read as a plain `update` it would install.
  const unknown = args.filter((arg) => arg !== "--check");
  if (unknown.length > 0) return usageError(`update does not take ${unknown.join(" ")}`, deps);
  const check = args.includes("--check");

  // npm, not the registry directly: the user's own registry, proxy and auth settings apply.
  const asked = deps.exec("npm", ["view", PACKAGE, "version"]);
  if (asked.status !== 0) {
    deps.err("bellman: could not ask npm for the latest version (is npm installed, and are you online?)");
    return 1;
  }
  const installed = deps.version;
  const latest = asked.stdout.trim();
  let order: number;
  try {
    order = compareVersions(installed, latest);
  } catch {
    deps.err(`bellman: cannot compare the installed version "${installed}" with npm's "${latest}"`);
    return 1;
  }
  // Newer than npm's latest counts too: a clone ahead of the registry is not something to downgrade.
  if (order >= 0) {
    deps.out(`bellman ${installed} is up to date (latest on npm: ${latest}).`);
    return 0;
  }
  deps.out(`bellman ${installed} is installed; the latest on npm is ${latest}.`);

  const root = deps.realpath(deps.packageRoot);
  switch (installKind(root, globalRoot(deps), deps.exists)) {
    case "clone":
      deps.out(`This is a clone, at ${root}. To update it, run there:`);
      deps.out(`  ${UPDATE_CLONE}`);
      return 0;
    case "local":
      deps.out("This is a project-local install. To update it, run in the project that depends on it:");
      deps.out(`  ${INSTALL_LOCAL}`);
      return 0;
    case "global": {
      const { command, args: installArgs } = INSTALL_GLOBAL;
      const line = [command, ...installArgs].join(" ");
      if (check) {
        deps.out(`To update, run: ${line}`);
        return 0;
      }
      deps.out(`Running: ${line}`);
      const status = deps.execInherited(command, installArgs);
      if (status !== 0) {
        deps.err(status === null ? "bellman: could not run npm install." : `bellman: npm install exited with status ${status}.`);
        return status ?? 1;
      }
      deps.out(`Updated bellman from ${installed} to ${latest}.`);
      deps.out("Claude Code sessions that are already open keep the old bridge until you restart them.");
      return 0;
    }
  }
}

/** The part of a spawned child the opener touches: tests hand in a stand-in, `spawn` is the real one. */
export interface Launched {
  on(event: "error", listener: () => void): unknown;
  unref(): void;
}
export type Launch = (command: string, args: string[], options: SpawnOptions) => Launched;

/**
 * Opens a URL in the default browser: `open` on macOS, `cmd /c start` on Windows, `xdg-open` elsewhere. The
 * browser is detached, its stdio ignored and the handle let go, so this process exits without waiting for it.
 *
 * spawn reports a program it cannot find as an error event after it returns, and an unhandled one would end
 * the process after the URL was printed. So the event is handled, and nothing is done about it: no browser here
 * is not a failure.
 */
export function browserOpener(platform: NodeJS.Platform, launch: Launch = spawn): (url: string) => void {
  return (url) => {
    let command = "xdg-open";
    let args = [url];
    let verbatim = false;
    if (platform === "darwin") {
      command = "open";
    } else if (platform === "win32") {
      // cmd.exe reads & as the end of a command, and the form's URL has one before &title=. ^& hands it to
      // start as text. The arguments go unquoted (verbatim) because quoting them would take the ^ away.
      command = "cmd";
      args = ["/c", "start", '""', url.replace(/&/g, "^&")];
      verbatim = true;
    }
    const child = launch(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
    });
    child.on("error", () => undefined);
    child.unref();
  };
}

/**
 * Runs a command to completion. npm is npm.cmd on Windows, which node starts only through a shell; the
 * commands here are constants, so joining them into the one string a shell takes is safe, and it avoids the
 * warning node prints for arguments passed alongside `shell`.
 */
function runSync(command: string, args: string[], stdio: "pipe" | "inherit"): { status: number | null; stdout: string } {
  const options = { encoding: "utf8", stdio } as const;
  const done =
    process.platform === "win32"
      ? spawnSync([command, ...args].join(" "), { ...options, shell: true })
      : spawnSync(command, args, options);
  return { status: done.status, stdout: done.stdout ?? "" };
}

function realDeps(): CliDeps {
  return {
    version: VERSION,
    exec: (command, args) => runSync(command, args, "pipe"),
    execInherited: (command, args) => runSync(command, args, "inherit").status,
    open: browserOpener(process.platform),
    exists: existsSync,
    realpath: (path) => {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    },
    packageRoot: dirname(fileURLToPath(new URL("../package.json", import.meta.url))),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  };
}

/**
 * Whether this file is the entry point. npm puts a bin on the PATH as a symlink, so process.argv[1] is the
 * link while import.meta.url is the file it points at: the link is resolved before the two are compared, and
 * left as it is they never match, so the command would do nothing and exit 0.
 */
function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(script)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // The exit code is set, not exited with, so output still buffered for a pipe is written first.
  void run(process.argv.slice(2), realDeps()).then((code) => {
    process.exitCode = code;
  });
}
