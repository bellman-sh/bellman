/**
 * `bellman doctor` (src/doctor.ts): every check against a fake machine, and `askDoor` against a real door.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run, type CliDeps } from "../src/cli.js";
import { askDoor, diagnose, doctor, type DoctorDeps, type Finding } from "../src/doctor.js";
import { startDoor } from "../src/door.js";

const HOME = "/home/me";
const CWD = "/home/me/app";
const DOORS = `${HOME}/.claude/bellman/door`;
const PLUGINS = `${HOME}/.claude/plugins`;

interface Machine {
  version?: string;
  /** npm's latest; null makes `npm view` fail. */
  latest?: string | null;
  /** `claude --version`'s output; null makes it fail. */
  claude?: string | null;
  files?: Record<string, unknown>;
  /** The door folder's mode; null is no folder. */
  doorMode?: number | null;
  /** Each socket's answer to `GET /status`. */
  doors?: Record<string, unknown>;
}

function deps(m: Machine, out: string[] = []): DoctorDeps {
  return {
    version: m.version ?? "0.5.0",
    home: HOME,
    cwd: CWD,
    doorRoot: DOORS,
    exec: (command, args) => {
      const line = [command, ...args].join(" ");
      if (line === "npm view @bellman-sh/mcp-server version") {
        return m.latest === null ? { status: 1, stdout: "" } : { status: 0, stdout: `${m.latest ?? "0.5.0"}\n` };
      }
      if (line === "claude --version") {
        return m.claude === null ? { status: null, stdout: "" } : { status: 0, stdout: m.claude ?? "2.1.310 (Claude Code)\n" };
      }
      throw new Error(`unexpected exec: ${line}`);
    },
    readText: (path) => {
      const value = m.files?.[path];
      return value === undefined ? null : typeof value === "string" ? value : JSON.stringify(value);
    },
    listDir: (path) => (path === DOORS && m.doorMode !== null ? Object.keys(m.doors ?? {}) : null),
    mode: (path) => (path === DOORS ? (m.doorMode === undefined ? 0o40700 : m.doorMode) : null),
    askDoor: async (socketPath) => m.doors?.[socketPath.slice(DOORS.length + 1)] ?? null,
    out: (line) => out.push(line),
  };
}

const MARKETPLACE = { [`${PLUGINS}/known_marketplaces.json`]: { bellman: { source: { source: "github", repo: "bellman-sh/bellman" } } } };
const installed = (plugins: Record<string, unknown[]>) => ({ [`${PLUGINS}/installed_plugins.json`]: { version: 2, plugins } });
const user = (version: string) => [{ scope: "user", version }];
const USER_CHANNEL = { [`${HOME}/.claude.json`]: { mcpServers: { bellman: { type: "stdio", command: "bellman-channel", args: [] } } } };
const LIVE_DOOR = { delivery: "hook", has_sign_in: true, seats: [{}, {}], waiting: [], recent: [], version: 1 };

const healthy: Machine = {
  files: { ...MARKETPLACE, ...installed({ "bellman@bellman": user("0.5.0"), "bellman-mod@bellman": user("0.5.0") }) },
  doors: { "2437.sock": LIVE_DOOR },
};

const fixes = (findings: Finding[]) => findings.filter((f) => f.status === "fix");
const commands = (findings: Finding[]) => fixes(findings).flatMap((f) => f.run ?? []);
const lines = (findings: Finding[]) => findings.map((f) => `${f.status} ${f.line}`);

describe("diagnose", () => {
  it("finds what #365 found: a user-scope bridge a release behind, and no marketplace, so no mod", async () => {
    const findings = await diagnose(deps({
      version: "0.4.0",
      files: USER_CHANNEL,
      doors: { "2437.sock": LIVE_DOOR, "8572.sock": null },
    }));
    expect(commands(findings)).toEqual([
      "bellman update",
      "claude plugin marketplace add bellman-sh/bellman",
      "claude plugin install bellman-mod@bellman",
    ]);
    expect(lines(findings)).toContain(`ok One local bridge: MCP server "bellman" in ~/.claude.json (user scope).`);
    expect(lines(findings)).toContain("note 1 door was left by bridges that have exited; harmless.");
  });

  it("finds nothing to fix on a machine with the plugin, the mod and a signed-in bridge, all current", async () => {
    const findings = await diagnose(deps(healthy));
    expect(fixes(findings)).toEqual([]);
    expect(lines(findings)).toEqual([
      "ok The bellman package is 0.5.0, the latest.",
      "ok One local bridge: the bellman plugin 0.5.0.",
      "ok bellman-mod 0.5.0 is installed and enabled.",
      "ok The door 2437.sock answers: hook delivery, 2 seats, signed in.",
      "ok Claude Code is 2.1.310 (bellman-mod was written for 2.1.301; a build without mods skips it quietly).",
    ]);
  });

  it("says to keep one bridge when the plugin and an MCP server both start one, and how to remove the server", async () => {
    const findings = await diagnose(deps({ ...healthy, files: { ...healthy.files, ...USER_CHANNEL } }));
    expect(commands(findings)).toEqual(["claude mcp remove bellman -s user"]);
    expect(fixes(findings)[0].line).toMatch(/^2 local bridges start in every session/);
  });

  it("counts local- and project-scope servers, and a remote server as no local bridge", async () => {
    const findings = await diagnose(deps({
      ...healthy,
      files: {
        ...MARKETPLACE,
        ...installed({ "bellman-mod@bellman": user("0.5.0") }),
        [`${HOME}/.claude.json`]: {
          mcpServers: { hosted: { type: "http", url: "https://mcp.bellman.sh/mcp" } },
          projects: { [CWD]: { mcpServers: { b: { command: "npx", args: ["-y", "@bellman-sh/mcp-server"] } } } },
        },
        [`${CWD}/.mcp.json`]: { mcpServers: { other: { command: "unrelated" }, bell: { command: "bellman-channel" } } },
      },
    }));
    expect(lines(findings)).toContain(
      `note MCP server "hosted" in ~/.claude.json (user scope) connects to the hosted server with no local bridge: the mod and the Stop hook see nothing through it.`,
    );
    expect(commands(findings)).toEqual(["claude mcp remove b -s local", "claude mcp remove bell -s project"]);
  });

  it("asks for the plugin when nothing starts a bridge, by the marketplace's own name", async () => {
    const files = {
      [`${PLUGINS}/known_marketplaces.json`]: { "bm": { source: { source: "git", url: "https://github.com/bellman-sh/bellman.git" } } },
      ...installed({ "bellman-mod@bm": user("0.5.0") }),
    };
    expect(commands(await diagnose(deps({ ...healthy, files })))).toEqual(["claude plugin install bellman@bm"]);
  });

  it("does not count a project-scope install made for another folder", async () => {
    const files = { ...MARKETPLACE, ...installed({ "bellman@bellman": user("0.5.0"), "bellman-mod@bellman": [{ scope: "project", projectPath: "/elsewhere", version: "0.5.0" }] }) };
    expect(commands(await diagnose(deps({ ...healthy, files })))).toEqual(["claude plugin install bellman-mod@bellman"]);
  });

  it("enables a disabled mod, and updates a plugin or a mod behind npm", async () => {
    const disabled = { ...healthy.files, [`${HOME}/.claude/settings.json`]: { enabledPlugins: { "bellman-mod@bellman": false } } };
    expect(commands(await diagnose(deps({ ...healthy, files: disabled })))).toEqual(["claude plugin enable bellman-mod@bellman"]);

    const behind = { ...MARKETPLACE, ...installed({ "bellman@bellman": user("0.4.0"), "bellman-mod@bellman": user("0.4.0") }) };
    expect(commands(await diagnose(deps({ ...healthy, files: behind })))).toEqual([
      "claude plugin update bellman@bellman",
      "claude plugin update bellman-mod@bellman",
    ]);
  });

  it("compares no version when npm cannot be asked", async () => {
    const findings = await diagnose(deps({ ...healthy, version: "0.1.0", latest: null }));
    expect(fixes(findings)).toEqual([]);
    expect(lines(findings)[0]).toBe("note Could not ask npm for the latest version, so no version below is compared.");
  });

  it("reads a file it cannot parse as absent", async () => {
    const files = { ...healthy.files, [`${PLUGINS}/known_marketplaces.json`]: "{ not json" };
    const findings = await diagnose(deps({ ...healthy, files }));
    expect(commands(findings)).toContain("claude plugin marketplace add bellman-sh/bellman");
  });

  it("closes a door folder others can enter, and counts an answer of the wrong shape as no answer", async () => {
    const { delivery, has_sign_in, seats, ...rest } = LIVE_DOOR;
    const findings = await diagnose(deps({
      ...healthy,
      doorMode: 0o40755,
      doors: {
        "1.sock": { ...rest, has_sign_in, seats },
        "2.sock": { ...rest, delivery, seats },
        "3.sock": { ...rest, delivery, has_sign_in },
        "4.sock": null,
      },
    }));
    expect(commands(findings)).toEqual([`chmod 700 "${DOORS}"`]);
    expect(lines(findings)).toContain("note 4 doors were left by bridges that have exited; harmless.");
    expect(lines(findings)).toContain("note No running bridge answered: the mod shows a bridge once a Claude Code session has started it.");
  });

  it("notes a bridge with no sign-in, and a machine where no door was ever opened", async () => {
    const signedOut = await diagnose(deps({ ...healthy, doors: { "9.sock": { ...LIVE_DOOR, has_sign_in: false, seats: [{}] } } }));
    expect(lines(signedOut)).toContain(
      "note The door 9.sock answers: hook delivery, 1 seat, not signed in: the next Bellman tool call in that session asks you to sign in.",
    );
    const none = await diagnose(deps({ ...healthy, doorMode: null }));
    expect(lines(none)).toContain(`note No bridge has opened a door yet (${DOORS} does not exist).`);
  });

  it("asks for a newer Claude Code than the mod's, and notes a claude it cannot run", async () => {
    expect(commands(await diagnose(deps({ ...healthy, claude: "2.1.250 (Claude Code)" })))).toEqual(["claude update"]);
    expect(lines(await diagnose(deps({ ...healthy, claude: null })))).toContain(
      "note Could not run claude --version, so the Claude Code build is not checked.",
    );
  });
});

describe("doctor", () => {
  it("prints each finding with its commands, and exits 1 when there is something to fix", async () => {
    const out: string[] = [];
    expect(await doctor(deps({ ...healthy, version: "0.4.0" }, out))).toBe(1);
    expect(out.slice(0, 2)).toEqual([
      "fix   The bellman package is 0.4.0; the latest is 0.5.0.",
      "        $ bellman update",
    ]);
    expect(await doctor(deps(healthy, []))).toBe(0);
  });

  it("is routed from the bellman command, and refuses an argument", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const d = deps(healthy, out);
    const cli = { ...d, err: (line: string) => err.push(line), doctor: d } as unknown as CliDeps;
    expect(await run(["doctor"], cli)).toBe(0);
    expect(out[0]).toBe("ok    The bellman package is 0.5.0, the latest.");
    expect(await run(["doctor", "--fix"], cli)).toBe(1);
    expect(err[0]).toBe("bellman: doctor does not take --fix");
  });
});

describe("askDoor", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reads a real door's status, and answers null where nothing listens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bd-"));
    temps.push(dir);
    const door = await startDoor(join(dir, "1.sock"), {
      delivery: "hook",
      hasSignIn: () => true,
      seats: () => [{ session_id: "qs_1", member_id: "m_1", retrying: false }],
      recent: () => [],
      readEvents: async () => ({ status: 404, body: {} }),
      readRooms: async () => ({ status: 200, body: { rooms: [] } }),
      readSurface: async () => ({ status: 404, body: {} }),
      decline: async () => ({ status: 404, body: {} }),
    } as Parameters<typeof startDoor>[1]);
    try {
      const status = (await askDoor(door.path)) as { delivery: string; has_sign_in: boolean; seats: unknown[] };
      expect([status.delivery, status.has_sign_in, status.seats.length]).toEqual(["hook", true, 1]);
    } finally {
      await door.close();
    }
    expect(await askDoor(join(dir, "1.sock"))).toBeNull();
  });
});
