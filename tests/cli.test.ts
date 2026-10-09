/**
 * The `bellman` command (src/cli.ts) and the version it and the bridge both report (src/version.ts).
 *
 * run() takes everything with a side effect as a dependency, so most of this drives the real command
 * against fakes and asserts what it printed, what it spawned and what it exited with. Two things a
 * fake cannot reach are run for real: the browser launcher, against a stand-in for spawn, and the file
 * itself as a process, which is where the main-module check and the real spawnSync wiring live.
 * Nothing here touches the network, npm or a browser.
 */
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBridge } from "../src/bridge.js";
import {
  browserOpener, compareVersions, featureRequestUrl, installKind, run, type CliDeps, type Launch,
} from "../src/cli.js";
import { VERSION, readVersion } from "../src/version.js";

const pkg: { version: string; bin: Record<string, string> } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const repo = fileURLToPath(new URL("..", import.meta.url));
const entry = join(repo, "src", "cli.ts");

const PKG = "@bellman-sh/mcp-server";
const FORM = "https://github.com/bellman-sh/bellman/issues/new?template=feature_request.yml";
const GLOBAL_ROOT = "/usr/local/lib/node_modules";
const GLOBAL_PKG = `${GLOBAL_ROOT}/@bellman-sh/mcp-server`;
const CLONE = "/home/me/src/bellman";
const LOCAL_PKG = "/home/me/app/node_modules/@bellman-sh/mcp-server";

const temps: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Plan {
  /** The installed version. */
  version?: string;
  /** What `npm view` reports; null makes it fail. */
  latest?: string | null;
  packageRoot?: string;
  /** What `npm root -g` prints; null makes it fail. */
  globalRoot?: string | null;
  /** A version-control entry present at the package root: ".git" or ".jj". Absent, the root has none. */
  vcs?: string;
  /** What the install exits with; null is a process that could not be run or was killed. */
  install?: number | null;
  realpath?: (path: string) => string;
  openThrows?: boolean;
}

interface Fake {
  deps: CliDeps;
  out: string[];
  err: string[];
  /** Every side effect, in the order it happened. */
  log: string[];
  exec: Mock<CliDeps["exec"]>;
  execInherited: Mock<CliDeps["execInherited"]>;
  open: Mock<CliDeps["open"]>;
}

/**
 * A command's whole world, by default a global install at 0.3.1 with 0.3.2 on npm. An `exec` it was
 * not told about throws, so a test notices a command the code was never expected to run — an install
 * that went through exec instead of execInherited, say.
 */
function fake(plan: Plan = {}): Fake {
  const out: string[] = [];
  const err: string[] = [];
  const log: string[] = [];
  const packageRoot = plan.packageRoot ?? GLOBAL_PKG;
  const exec = vi.fn<CliDeps["exec"]>((command, args) => {
    const line = [command, ...args].join(" ");
    log.push(`exec ${line}`);
    if (line === `npm view ${PKG} version`) {
      return plan.latest === null ? { status: 1, stdout: "" } : { status: 0, stdout: `${plan.latest ?? "0.3.2"}\n` };
    }
    if (line === "npm root -g") {
      return plan.globalRoot === null ? { status: 1, stdout: "" } : { status: 0, stdout: `${plan.globalRoot ?? GLOBAL_ROOT}\n` };
    }
    throw new Error(`unexpected exec: ${line}`);
  });
  const execInherited = vi.fn<CliDeps["execInherited"]>((command, args) => {
    log.push(`inherited ${[command, ...args].join(" ")}`);
    return plan.install === undefined ? 0 : plan.install;
  });
  const open = vi.fn<CliDeps["open"]>((url) => {
    log.push(`open ${url}`);
    if (plan.openThrows) throw new Error("spawn xdg-open ENOENT");
  });
  const deps: CliDeps = {
    version: plan.version ?? "0.3.1",
    exec,
    execInherited,
    open,
    exists: (path) => plan.vcs !== undefined && path === join(packageRoot, plan.vcs),
    realpath: plan.realpath ?? ((path) => path),
    packageRoot,
    out: (line) => {
      out.push(line);
      log.push(`out ${line}`);
    },
    err: (line) => {
      err.push(line);
      log.push(`err ${line}`);
    },
  };
  return { deps, out, err, log, exec, execInherited, open };
}

const text = (lines: string[]): string => lines.join("\n");

describe("featureRequestUrl", () => {
  it("is GitHub's feature-request form for this repo, with no title when no words are given", () => {
    expect(featureRequestUrl([])).toBe(FORM);
  });

  it("joins the words with spaces into a title, encoded", () => {
    expect(featureRequestUrl(["let", "me", "pin", "a", "room"])).toBe(`${FORM}&title=let%20me%20pin%20a%20room`);
  });

  // The title is the only part of the URL a person types. A raw & would end it and start a parameter of their
  // choosing (labels, assignees); a raw # would end the query. Both have to arrive as text in the title.
  it("encodes what would end the title or start another parameter", () => {
    expect(featureRequestUrl(["fix", "a&b", "#1", "100%", "x=y"])).toBe(`${FORM}&title=fix%20a%26b%20%231%20100%25%20x%3Dy`);
  });

  it("treats words that are only whitespace as no words", () => {
    expect(featureRequestUrl(["", " "])).toBe(FORM);
  });
});

describe("compareVersions", () => {
  it("orders by number, not by text", () => {
    expect(compareVersions("0.3.1", "0.3.2")).toBeLessThan(0);
    expect(compareVersions("0.3.2", "0.3.1")).toBeGreaterThan(0);
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
  });

  it("calls equal versions equal", () => {
    expect(compareVersions("0.3.1", "0.3.1")).toBe(0);
  });

  it("calls a release with more numbers newer", () => {
    expect(compareVersions("0.3.1", "0.3.1.1")).toBeLessThan(0);
    expect(compareVersions("1.2.3.4", "1.2.3")).toBeGreaterThan(0);
  });

  it("reads a prerelease or build suffix as the release it leads up to", () => {
    expect(compareVersions("0.4.0-rc.1", "0.4.0")).toBe(0);
    expect(compareVersions("0.4.0+build5", "0.3.9")).toBeGreaterThan(0);
  });

  it("refuses text that is not a version, rather than ordering it", () => {
    expect(() => compareVersions("unknown", "0.3.1")).toThrow();
    expect(() => compareVersions("0.3.1", "latest")).toThrow();
  });
});

describe("installKind", () => {
  const none = () => false;

  // A clone can sit under the directory npm calls global (npm link puts a symlink there; a home directory
  // can be a prefix of both), and updating it with npm install -g would replace the checkout with a copy.
  it("calls a package root with a .git entry a clone, whatever else is true of its path", () => {
    expect(installKind(CLONE, "/home/me/src", (path) => path === join(CLONE, ".git"))).toBe("clone");
  });

  // A jj workspace has .jj and no .git at all. It is a checkout all the same, and the one this command was
  // first run in.
  it("calls a package root with a .jj entry a clone too", () => {
    expect(installKind(CLONE, GLOBAL_ROOT, (path) => path === join(CLONE, ".jj"))).toBe("clone");
  });

  it("calls a package root under npm's global root a global install", () => {
    expect(installKind(GLOBAL_PKG, GLOBAL_ROOT, none)).toBe("global");
  });

  it("calls anything else a project-local install", () => {
    expect(installKind(LOCAL_PKG, GLOBAL_ROOT, none)).toBe("local");
    // npm could not say where its global root is: nothing can be called global without it.
    expect(installKind(GLOBAL_PKG, null, none)).toBe("local");
  });

  // The prefix has to end at a separator: /usr/local/lib/node_modules-old is not under /usr/local/lib/node_modules.
  it("does not take a sibling directory that starts with the global root's name for being under it", () => {
    expect(installKind(`${GLOBAL_ROOT}-old/@bellman-sh/mcp-server`, GLOBAL_ROOT, none)).toBe("local");
  });
});

describe("bellman with no command, help, version or an unknown command", () => {
  for (const argv of [[], ["help"], ["--help"], ["-h"]]) {
    it(`prints the usage on stdout and exits 0 for \`bellman ${argv.join(" ")}\``, async () => {
      const f = fake();
      expect(await run(argv, f.deps)).toBe(0);
      expect(f.err).toEqual([]);
      const usage = text(f.out);
      expect(usage).toContain("Usage:");
      for (const command of ["feature-request", "update", "version"]) expect(usage).toContain(command);
    });
  }

  for (const flag of ["version", "--version", "-v"]) {
    it(`prints the package.json version, and only that, for \`bellman ${flag}\``, async () => {
      const f = fake({ version: VERSION });
      expect(await run([flag], f.deps)).toBe(0);
      expect(f.out).toEqual([pkg.version]);
      expect(f.err).toEqual([]);
    });
  }

  it("prints the usage on stderr and exits 1 for a command it does not have", async () => {
    const f = fake();
    expect(await run(["frobnicate"], f.deps)).toBe(1);
    expect(f.out).toEqual([]);
    expect(text(f.err)).toContain("frobnicate");
    expect(text(f.err)).toContain("Usage:");
  });
});

describe("bellman feature-request", () => {
  // Over SSH there is no browser to open, and the printed URL is all a person has: it has to be on screen
  // before the attempt to open anything, and whatever the attempt does.
  it("prints the URL first, then opens it once", async () => {
    const f = fake();
    expect(await run(["feature-request"], f.deps)).toBe(0);
    expect(f.log[0]).toBe(`out ${FORM}`);
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.open).toHaveBeenCalledWith(FORM);
    expect(f.log.indexOf(`open ${FORM}`)).toBeGreaterThan(0);
  });

  it("carries the words in the title", async () => {
    const f = fake();
    const url = `${FORM}&title=dark%20mode%20for%20the%20canvas`;
    expect(await run(["feature-request", "dark", "mode", "for", "the", "canvas"], f.deps)).toBe(0);
    expect(f.out).toEqual([url]);
    expect(f.open).toHaveBeenCalledWith(url);
  });

  it("is not an error when no browser can be opened: the URL is already printed", async () => {
    const f = fake({ openThrows: true });
    expect(await run(["feature-request", "x"], f.deps)).toBe(0);
    expect(f.out).toHaveLength(1);
    expect(f.err).toEqual([]);
  });
});

describe("bellman update", () => {
  it("asks npm for the latest version, so the user's own registry, proxy and auth apply", async () => {
    const f = fake({ version: "0.3.1", latest: "0.3.1" });
    await run(["update"], f.deps);
    expect(f.exec).toHaveBeenCalledWith("npm", ["view", PKG, "version"]);
  });

  it("--check reports installed, latest and the command that would update, and never installs", async () => {
    const f = fake({ version: "0.3.1", latest: "0.3.2" });
    expect(await run(["update", "--check"], f.deps)).toBe(0);
    expect(f.execInherited).not.toHaveBeenCalled();
    const report = text(f.out);
    expect(report).toContain("0.3.1");
    expect(report).toContain("0.3.2");
    expect(report).toContain(`npm install -g ${PKG}@latest`);
  });

  it("behind on a global install, installs once, then names both versions and the restart", async () => {
    const f = fake({ version: "0.3.1", latest: "0.3.2" });
    expect(await run(["update"], f.deps)).toBe(0);
    expect(f.execInherited).toHaveBeenCalledTimes(1);
    expect(f.execInherited).toHaveBeenCalledWith("npm", ["install", "-g", `${PKG}@latest`]);
    // After the install, not before: a line that says it is done cannot come first.
    const after = f.log.slice(f.log.findIndex((line) => line.startsWith("inherited ")) + 1);
    const done = text(after);
    expect(done).toContain("0.3.1");
    expect(done).toContain("0.3.2");
    expect(done).toMatch(/restart/i);
  });

  for (const status of [13, null]) {
    it(`exits ${status ?? 1} and claims no update when the install ends with ${status === null ? "no status" : `status ${status}`}`, async () => {
      const f = fake({ install: status });
      expect(await run(["update"], f.deps)).toBe(status ?? 1);
      expect(f.err).toHaveLength(1);
      expect(text(f.out)).not.toMatch(/restart|updated/i);
    });
  }

  it("on a clone, prints the commands and installs nothing", async () => {
    const f = fake({ packageRoot: CLONE, vcs: ".git" });
    expect(await run(["update"], f.deps)).toBe(0);
    expect(f.execInherited).not.toHaveBeenCalled();
    expect(text(f.out)).toContain("git pull && npm install && npm run build");
  });

  it("on a jj workspace, which has no .git, prints the clone's commands as well", async () => {
    const f = fake({ packageRoot: CLONE, vcs: ".jj" });
    expect(await run(["update"], f.deps)).toBe(0);
    expect(f.execInherited).not.toHaveBeenCalled();
    expect(text(f.out)).toContain("git pull && npm install && npm run build");
  });

  it("on a project-local install, prints npm install … @latest and installs nothing", async () => {
    const f = fake({ packageRoot: LOCAL_PKG });
    expect(await run(["update"], f.deps)).toBe(0);
    expect(f.execInherited).not.toHaveBeenCalled();
    const lines = text(f.out);
    expect(lines).toContain(`npm install ${PKG}@latest`);
    expect(lines).not.toContain("-g");
  });

  it("when up to date, says so and installs nothing", async () => {
    const f = fake({ version: "0.3.2", latest: "0.3.2" });
    expect(await run(["update"], f.deps)).toBe(0);
    expect(f.execInherited).not.toHaveBeenCalled();
    expect(text(f.out)).toMatch(/up to date/i);
  });

  // A clone can be ahead of the registry, and so can a prerelease. Downgrading either to npm's latest is the
  // one outcome nobody asked for.
  it("counts an install newer than npm's latest as up to date", async () => {
    const f = fake({ version: "0.4.0", latest: "0.3.9" });
    expect(await run(["update"], f.deps)).toBe(0);
    expect(f.execInherited).not.toHaveBeenCalled();
    expect(text(f.out)).toMatch(/up to date/i);
  });

  for (const status of [1, null]) {
    it(`exits 1 with one line on stderr and installs nothing when npm view fails with ${status === null ? "no status" : `status ${status}`}`, async () => {
      const f = fake({ latest: null });
      if (status === null) f.exec.mockImplementationOnce(() => ({ status: null, stdout: "" }));
      expect(await run(["update"], f.deps)).toBe(1);
      expect(f.err).toHaveLength(1);
      expect(f.out).toEqual([]);
      expect(f.execInherited).not.toHaveBeenCalled();
    });
  }

  // `update --chek` is a typo for the safe option. Read as a plain `update` it would install.
  it("refuses an option it does not know, and installs nothing", async () => {
    const f = fake({ version: "0.3.1", latest: "0.3.2" });
    expect(await run(["update", "--chek"], f.deps)).toBe(1);
    expect(f.execInherited).not.toHaveBeenCalled();
    expect(text(f.err)).toContain("--chek");
  });

  it("refuses to guess when it cannot read the installed version", async () => {
    const f = fake({ version: "unknown", latest: "0.3.2" });
    expect(await run(["update"], f.deps)).toBe(1);
    expect(f.execInherited).not.toHaveBeenCalled();
    expect(f.err).toHaveLength(1);
  });

  it("refuses to guess when npm answers with something that is not a version", async () => {
    const f = fake({ version: "0.3.1", latest: "<html>" });
    expect(await run(["update"], f.deps)).toBe(1);
    expect(f.execInherited).not.toHaveBeenCalled();
  });

  // npm root -g and the module's own path are two spellings of one place when a prefix is reached through a
  // symlink (a home directory that is one, a version manager's alias). Compared as spelled, a global install
  // reads as project-local and is told to run npm install in whatever directory it happens to be in.
  it("finds a global install through a symlinked prefix", async () => {
    const real = new Map([["/home/me/.nvm/lib/node_modules", "/data/home/me/.nvm/lib/node_modules"]]);
    const f = fake({
      packageRoot: "/data/home/me/.nvm/lib/node_modules/@bellman-sh/mcp-server",
      globalRoot: "/home/me/.nvm/lib/node_modules",
      realpath: (path) => real.get(path) ?? path,
    });
    expect(await run(["update"], f.deps)).toBe(0);
    expect(f.execInherited).toHaveBeenCalledTimes(1);
  });
});

describe("browserOpener", () => {
  const url = `${FORM}&title=a%20b`;

  function launcher() {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const launch = vi.fn<Launch>(() => child);
    return { child, launch };
  }

  it("uses open on macOS", () => {
    const { launch } = launcher();
    browserOpener("darwin", launch)(url);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith("open", [url], expect.anything());
  });

  it("uses xdg-open on Linux", () => {
    const { launch } = launcher();
    browserOpener("linux", launch)(url);
    expect(launch).toHaveBeenCalledWith("xdg-open", [url], expect.anything());
  });

  // cmd.exe reads & as the end of a command, and the form's URL has one before &title=. Without the ^ the
  // title would be run as a program; the arguments go through unquoted so the ^ reaches cmd.exe.
  it("uses cmd /c start on Windows, with the & kept out of cmd.exe's hands", () => {
    const { launch } = launcher();
    browserOpener("win32", launch)(url);
    expect(launch).toHaveBeenCalledWith(
      "cmd",
      ["/c", "start", '""', `${FORM}^&title=a%20b`],
      expect.objectContaining({ windowsVerbatimArguments: true }),
    );
  });

  it("detaches the browser from this process and lets go of it, with stdio ignored", () => {
    const { child, launch } = launcher();
    browserOpener("linux", launch)(url);
    expect(launch.mock.calls[0]?.[2]).toMatchObject({ detached: true, stdio: "ignore" });
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  // spawn reports a missing program as an error event after it returns. Unhandled, that crashes the process
  // after the URL was printed, which turns "no browser here" into a failure.
  it("treats a launcher that fails afterwards as no browser, not as a crash", () => {
    const { child, launch } = launcher();
    browserOpener("linux", launch)(url);
    expect(() => child.emit("error", new Error("spawn xdg-open ENOENT"))).not.toThrow();
  });
});

describe("VERSION", () => {
  it("is the version in package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });

  describe("readVersion, which VERSION is made with", () => {
    const file = (content?: string): URL => {
      const path = join(tempDir("bellman-version-"), "package.json");
      if (content !== undefined) writeFileSync(path, content);
      return pathToFileURL(path);
    };

    it("reads the version field of the file it is given", () => {
      expect(readVersion(file(JSON.stringify({ version: "9.8.7" })))).toBe("9.8.7");
    });

    // The bridge must start whatever state the install is in; a version string is not worth a crash.
    it.each([
      ["a file that is not there", undefined],
      ["a file that is not JSON", "{ nope"],
      ["JSON with no version", "{}"],
      ["a version that is not a string", '{"version":3}'],
      ["a version that is empty", '{"version":""}'],
      ["JSON that is not an object", "null"],
    ])("answers unknown instead of throwing for %s", (_name, content) => {
      expect(readVersion(file(content))).toBe("unknown");
    });
  });

  // The bug: the bridge said 0.1.0 to every host through two releases, because a constant was never bumped.
  it("is what the bridge reports to the MCP host that connects to it", async () => {
    const bridge = createBridge({
      delivery: "channel",
      remote: async () => {
        throw new Error("initialize never reaches the remote");
      },
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const host = new Client({ name: "host", version: "0.0.1" });
    await Promise.all([bridge.server.connect(serverSide), host.connect(clientSide)]);
    try {
      expect(host.getServerVersion()).toMatchObject({ name: "bellman", version: pkg.version });
    } finally {
      await bridge.close();
      await host.close();
    }
  });
});

describe("the bellman bin", () => {
  it("is declared in package.json at dist/cli.js, and the source keeps the shebang that makes it runnable", () => {
    expect(pkg.bin.bellman).toBe("dist/cli.js");
    expect(readFileSync(entry, "utf8").split("\n")[0]).toBe("#!/usr/bin/env node");
  });

  const bellman = (script: string, ...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", script, ...args], { cwd: repo, encoding: "utf8" });

  // npm puts a bin on the PATH as a symlink, and process.argv[1] is then the link while import.meta.url is the
  // file it points at. A main-module check that compares them as they are never matches, and the command does
  // nothing at all and exits 0, which reads as a command that worked.
  it("runs when started through a symlink, as npm installs its bins", () => {
    const link = join(tempDir("bellman-bin-"), "bellman.ts");
    symlinkSync(entry, link);
    const done = bellman(link, "--version");
    expect(done.stdout.trim()).toBe(pkg.version);
    expect(done.status).toBe(0);
  }, 30_000);

  it("prints the usage on stdout and exits 0 when run with no command", () => {
    const done = bellman(entry);
    expect(done.status).toBe(0);
    expect(done.stdout).toContain("Usage:");
  }, 30_000);

  it("prints the usage on stderr and exits 1 for a command it does not have", () => {
    const done = bellman(entry, "frobnicate");
    expect(done.status).toBe(1);
    expect(done.stdout).toBe("");
    expect(done.stderr).toContain("Usage:");
  }, 30_000);
});
