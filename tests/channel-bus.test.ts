import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { busPath } from "../src/bus.js";

/**
 * channel.ts as Claude Code runs it, with the local bus.
 *
 * tests/bridge-bus.test.ts drives createBridge with a `bus` it builds itself, and says nothing about whether the
 * bridge that ships is given one. That is a fact about the process: whether the entry point passes the option at all,
 * what it names the bus after for each kind of credential, and whether a stop signal removes the socket before the
 * process ends. A typo in the wiring would leave every other test green, and every session polling as it did before.
 *
 * Bellman here is the smallest MCP server that can seat a member: it answers initialize, tools/list, bellman_start and
 * bellman_sync over HTTP, and refuses every WebSocket upgrade, so a room is polled and nothing about a real socket is
 * claimed.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(root, "node_modules", ".bin", "tsx");
const ENTRY = join(root, "src", "channel.ts");

const spawned: ChildProcess[] = [];
const dirs: string[] = [];
const servers: http.Server[] = [];

afterEach(() => {
  for (const proc of spawned.splice(0)) proc.kill("SIGKILL");
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Bellman {
  url: string;
  /** Every tools/call the bridge made, in order. */
  calls: Array<{ name: string; args: Record<string, unknown> }>;
}

async function bellman(): Promise<Bellman> {
  const calls: Bellman["calls"] = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const message = JSON.parse(body) as { id?: number; method: string; params?: Record<string, any> };
    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    let result: unknown = {};
    if (message.method === "initialize") {
      result = {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "bellman", version: "0.0.0" },
      };
    } else if (message.method === "tools/list") {
      result = {
        tools: ["bellman_start", "bellman_sync"].map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
      };
    } else if (message.method === "tools/call") {
      const name = String(message.params?.name);
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      calls.push({ name, args });
      if (name === "bellman_start") {
        result = {
          content: [{ type: "text", text: "started" }],
          structuredContent: { session_id: "qs_process", member_id: "m_process", join_code: "BELL-X" },
        };
      } else {
        await new Promise((resolve) => setTimeout(resolve, 150)); // a poll that holds a little, and is not a hot loop
        result = {
          content: [{ type: "text", text: "no events" }],
          structuredContent: { events: [], cursor: Number(args.since_cursor ?? 0), session_status: "active" },
        };
      }
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  // Every room's socket is refused: a room is polled, and the process still has to deliver.
  server.on("upgrade", (_req, socket) => {
    socket.end("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/mcp`, calls };
}

/** A JWT the way src/oauth/tokens.ts writes one, with the claim a signed-in bridge reads its identity from. */
function fakeJwt(payload: unknown): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.not-a-real-signature`;
}

interface Bridge {
  proc: ChildProcess;
  /** Only the bridge's own diagnostics: tsx and Node may write their own. */
  log(): string[];
  /** Everything it wrote to stdout, which is the MCP transport. */
  replies(): Array<{ id?: number; result?: { structuredContent?: Record<string, unknown> } }>;
  send(message: unknown): void;
  exit: Promise<{ code: number | null; signal: string | null }>;
  busRoot: string;
}

interface Options {
  /** BELLMAN_KEY. Absent means signed in, with a cached credential for `userId`. */
  key?: string;
  userId?: string;
  /** What BELLMAN_BUS_ROOT is, when it is not a directory of the test's own. */
  busRoot?: string;
  /** Anything else the process is started with: BELLMAN_BUS, in the tests of the switch. */
  env?: Record<string, string>;
}

function startBridge(server: Bellman, { key, userId = "u_process", busRoot, env: extra = {} }: Options): Bridge {
  const configHome = mkdtempSync(join(tmpdir(), "bc-"));
  dirs.push(configHome);
  const bus = busRoot ?? join(configHome, "bus");
  if (!key) {
    const dir = join(configHome, "bellman");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dir, "credentials.json"),
      JSON.stringify({
        version: 1,
        servers: {
          [server.url]: {
            client: { client_id: "c_test" },
            tokens: {
              access_token: fakeJwt({ bellman: { userId, orgId: null, plan: "free", role: "member", label: "proc@test" } }),
              expires_at: Date.now() + 3_600_000,
            },
          },
        },
      }),
      { mode: 0o600 }
    );
  }
  const env = { ...process.env };
  delete env.BELLMAN_KEY;
  if (key) env.BELLMAN_KEY = key;
  env.BELLMAN_URL = server.url;
  env.XDG_CONFIG_HOME = configHome;
  env.BELLMAN_BUS_ROOT = bus;
  env.BELLMAN_NO_BROWSER = "1";
  delete env.BELLMAN_BUS; // a developer's own switch must not decide what these tests start
  Object.assign(env, extra);

  const proc = spawn(TSX, [ENTRY], { env, stdio: ["pipe", "pipe", "pipe"] });
  spawned.push(proc);
  let stderr = "";
  let stdout = "";
  proc.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  proc.stdout!.on("data", (chunk) => { stdout += String(chunk); });
  return {
    proc,
    busRoot: bus,
    log: () => stderr.split("\n").filter((line) => line.startsWith("[bellman] ")).map((line) => line.slice("[bellman] ".length)),
    replies: () => stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    send: (message) => proc.stdin!.write(`${JSON.stringify(message)}\n`),
    exit: new Promise((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal: signal as string | null }))),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(25);
  }
}

/** Claude Code's half of a session: the handshake, and the one call that seats a member. */
async function startRoom(bridge: Bridge): Promise<void> {
  bridge.send({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "channel-bus-test", version: "0.0.1" } },
  });
  bridge.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  bridge.send({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "bellman_start", arguments: { manifest: { room: "process-room", preset: "pair" } } },
  });
  await until(() => bridge.replies().some((r) => r.id === 3 && r.result?.structuredContent?.session_id === "qs_process"), "bellman_start to answer");
}

describe("the bridge as a process, with the local bus", () => {
  it("coordinates a bus named after its key once it is in a room, and removes the socket when it is told to stop", async () => {
    const server = await bellman();
    const bridge = startBridge(server, { key: "qk_process_key" });
    await until(() => bridge.log().some((l) => l.startsWith("ready:")), "the bridge to be ready");
    await startRoom(bridge);

    const path = busPath({ url: server.url, credential: "qk_process_key", root: bridge.busRoot });
    await until(() => existsSync(path), "the bus socket to appear");
    // The log is on a pipe of its own, so it can arrive after the socket does.
    await until(() => bridge.log().some((l) => l.includes("bus: coordinating at")), "the bridge to say it coordinates");

    bridge.proc.kill("SIGTERM");
    const exited = await bridge.exit;
    expect(exited).toEqual({ code: 0, signal: null });
    expect(existsSync(path)).toBe(false);
  }, 60_000);

  it("names a signed-in bridge's bus after the person and not after its access token", async () => {
    // The token changes every ten minutes and the person does not: a bus named for the token would be a new bus
    // after every refresh, with the old coordinator still serving the old one.
    const server = await bellman();
    const bridge = startBridge(server, { userId: "u_the_person" });
    await until(() => bridge.log().some((l) => l.startsWith("ready:")), "the bridge to be ready");
    await startRoom(bridge);

    const path = busPath({ url: server.url, credential: "u_the_person", root: bridge.busRoot });
    await until(() => existsSync(path), "the bus socket to appear");

    bridge.proc.kill("SIGTERM");
    expect(await bridge.exit).toEqual({ code: 0, signal: null });
    expect(existsSync(path)).toBe(false);
  }, 60_000);

  it("polls as it always did when the bus cannot be had, and says so", async () => {
    const server = await bellman();
    const bridge = startBridge(server, { key: "qk_process_key", busRoot: "not/an/absolute/path" });
    await until(() => bridge.log().some((l) => l.startsWith("ready:")), "the bridge to be ready");
    await startRoom(bridge);

    await until(() => server.calls.some((c) => c.name === "bellman_sync" && Number(c.args.wait_seconds) > 0), "the bridge to poll");
    await until(
      () => bridge.log().some((l) => /polling for m_process instead of using the local bus: .*not absolute/.test(l)),
      "the bridge to say why it polls"
    );
    expect(existsSync("not/an/absolute/path")).toBe(false);

    bridge.proc.kill("SIGTERM");
    expect(await bridge.exit).toEqual({ code: 0, signal: null });
  }, 60_000);
});

/**
 * BELLMAN_BUS is the way back to what every bridge did before the bus: a long poll of its own for each member, no
 * socket on the machine. Nothing else turns the bus off once channel.ts has given it to the bridge, and a delivery
 * path that cannot be turned off is a bad trade, so these are run as processes: the switch is read at the entry point.
 */
describe("the bridge as a process, with BELLMAN_BUS", () => {
  /** A bridge started with BELLMAN_BUS=`value` in a room, for as long as it takes to see whether it made a bus. */
  async function inARoom(value: string) {
    const server = await bellman();
    const bridge = startBridge(server, { key: "qk_process_key", env: { BELLMAN_BUS: value } });
    await until(() => bridge.log().some((l) => l.startsWith("ready:")), `the bridge with BELLMAN_BUS=${value} to be ready`);
    await startRoom(bridge);
    await until(
      () => server.calls.some((c) => c.name === "bellman_sync" && Number(c.args.wait_seconds) > 0),
      `the bridge with BELLMAN_BUS=${value} to poll`
    );
    // A bridge with a bus has made it by the time it first polls, or is about to: it is the first thing arming a
    // member does. This is how long it would have needed.
    await sleep(300);
    return { server, bridge, path: busPath({ url: server.url, credential: "qk_process_key", root: bridge.busRoot }) };
  }

  const busLines = (bridge: Bridge): string[] =>
    bridge.log().filter((l) => l.startsWith("bus:") || l.includes("instead of using the local bus"));

  it.each(["off", "OFF", "0", "false", "no"])("polls for the member and makes no bus when BELLMAN_BUS=%s", async (value) => {
    const { bridge } = await inARoom(value);

    expect(existsSync(bridge.busRoot)).toBe(false); // not even the directory
    expect(busLines(bridge)).toEqual([]);
    // Said once, where a person looking for why the bus is not there will look.
    expect(bridge.log().find((l) => l.startsWith("ready:"))).toContain(`local bus off (BELLMAN_BUS=${value})`);

    bridge.proc.kill("SIGTERM");
    expect(await bridge.exit).toEqual({ code: 0, signal: null });
  }, 60_000);

  it("reads a value it does not recognise as off, and says so, rather than keeping a bus the person tried to turn off", async () => {
    const { bridge } = await inARoom("banana");

    expect(existsSync(bridge.busRoot)).toBe(false);
    expect(busLines(bridge)).toEqual([]);
    expect(bridge.log()).toContain('BELLMAN_BUS="banana" is not on or off, so it is read as off');

    bridge.proc.kill("SIGTERM");
    expect(await bridge.exit).toEqual({ code: 0, signal: null });
  }, 60_000);

  it.each(["on", "ON", "1", "true", "yes"])("keeps the bus, and says nothing of it, when BELLMAN_BUS=%s", async (value) => {
    const server = await bellman();
    const bridge = startBridge(server, { key: "qk_process_key", env: { BELLMAN_BUS: value } });
    await until(() => bridge.log().some((l) => l.startsWith("ready:")), "the bridge to be ready");
    await startRoom(bridge);
    const path = busPath({ url: server.url, credential: "qk_process_key", root: bridge.busRoot });
    await until(() => existsSync(path), "the bus socket to appear");

    // The line is the one every bridge writes: the bus being on is not news.
    expect(bridge.log().find((l) => l.startsWith("ready:"))).toBe(`ready: channel delivery via ${server.url} (BELLMAN_KEY)`);
    expect(bridge.log().some((l) => l.includes("BELLMAN_BUS"))).toBe(false);

    bridge.proc.kill("SIGTERM");
    expect(await bridge.exit).toEqual({ code: 0, signal: null });
  }, 60_000);
});
