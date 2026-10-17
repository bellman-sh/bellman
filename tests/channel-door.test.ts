import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOOR_VERSION, type DoorStatus } from "../src/door-protocol.js";
import type { WireEnvelope } from "../src/inbox.js";
import { DEV_KEY } from "./helpers/harness.js";

/**
 * channel.ts as Claude Code runs it, and the door it opens.
 *
 * tests/door.test.ts starts a door on a socket of its own, and tests/bridge-door.test.ts asks a bridge for what the
 * door serves. Neither says whether the bridge that ships opens a door at all, what it names to the mod, whether the
 * door reports the process's own delivery, sign-in, rooms and inbox, whether it takes the socket with it when it goes,
 * or whether a bridge that cannot make one carries on. Those are facts about the process.
 *
 * The bridge is started with `node --import tsx` and not through the tsx command, which starts node as a child: the
 * door is named for the pid of the process that opens it, and these tests name it from the pid they spawned.
 * Bellman is the discard port unless a test says otherwise, and `bellman_whoami` is answered without connecting.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "src", "channel.ts");
const DISCARD = "http://127.0.0.1:9/mcp";

// Every test starts a tsx process, which takes seconds on a loaded machine: the longest of them needs more than the
// default 15s.
vi.setConfig({ testTimeout: 30_000 });
const ANSWER_MS = 15_000;

const spawned: ChildProcess[] = [];
const dirs: string[] = [];
const servers: http.Server[] = [];
afterEach(() => {
  for (const proc of spawned.splice(0)) proc.kill("SIGKILL");
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The bridge's HOME, config folder and (unless a test says otherwise) door folder. */
function scratchDir(): string {
  // Short on purpose: a Unix socket path may be at most 104 bytes on macOS, and the door is <folder>/<pid>.sock.
  const dir = mkdtempSync(join(tmpdir(), "bd-"));
  dirs.push(dir);
  return dir;
}

interface Options {
  /** BELLMAN_KEY. */
  key?: string;
  /** BELLMAN_URL. Unset, the discard port. */
  url?: string;
  /** A sign-in cached the way a real one leaves it, for a bridge with no key. */
  cachedSignIn?: boolean;
  delivery?: "hook";
  /** BELLMAN_DOOR_ROOT. Unset, the scratch folder itself. */
  doorRoot?: string;
}

interface Answer {
  id?: number;
  result?: { structuredContent?: Record<string, unknown> };
  error?: { message: string };
}

interface Bridge {
  /** The bridge's pid, which names its door. */
  pid: number;
  /** Only the bridge's own diagnostics: tsx and Node may write theirs. */
  log(): string[];
  /** A tool call, answered: its structured content. */
  call(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** What `bellman_whoami` answered. */
  whoami(): Promise<Record<string, unknown>>;
  /** Close the bridge's stdin, as Claude Code going away does, and wait for it to exit: its exit code. */
  stop(): Promise<number | null>;
}

/** Spawn the bridge and finish the MCP handshake. Env is spelled out, so nothing of the developer's BELLMAN_* is inherited. */
async function open(
  scratch: string,
  { key, url = DISCARD, cachedSignIn, delivery, doorRoot = scratch }: Options
): Promise<Bridge> {
  if (cachedSignIn) {
    const dir = join(scratch, "bellman");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dir, "credentials.json"),
      JSON.stringify({
        version: 1,
        servers: {
          [url]: {
            client: { client_id: "c_test" },
            tokens: { access_token: "not.a.jwt", expires_at: Date.now() + 3_600_000 },
            identity: { userId: "u_jesse", orgId: null, plan: "free", role: "member", label: "jesse@github" },
          },
        },
      }),
      { mode: 0o600 }
    );
  }

  const proc = spawn(process.execPath, ["--import", "tsx", ENTRY], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: scratch,
      XDG_CONFIG_HOME: scratch,
      BELLMAN_URL: url,
      BELLMAN_BUS: "off",
      BELLMAN_NO_BROWSER: "1",
      BELLMAN_DOOR_ROOT: doorRoot,
      ...(key ? { BELLMAN_KEY: key } : {}),
      ...(delivery ? { BELLMAN_DELIVERY: delivery } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  spawned.push(proc);

  let stderr = "";
  proc.stderr!.on("data", (chunk) => (stderr += String(chunk)));
  // "close", not "exit": by then every byte the bridge wrote has been read, so the log is whole once stop() returns.
  const closed = new Promise<number | null>((resolve) => proc.on("close", (code) => resolve(code)));

  const waiting = new Map<number, (answer: Answer) => void>();
  let pending = "";
  proc.stdout!.on("data", (chunk) => {
    pending += String(chunk);
    for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      try {
        const message = JSON.parse(line) as Answer;
        if (typeof message.id === "number") waiting.get(message.id)?.(message);
      } catch {
        // Not a message: nothing else is meant to be on this stream.
      }
    }
  });

  let nextId = 1;
  /** One request, answered. A bridge that exits first, or never answers, fails the test and does not hang it. */
  const request = (method: string, params: unknown): Promise<Answer> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(
        () => reject(new Error(`no answer to ${method} in ${ANSWER_MS}ms; the bridge said:\n${stderr}`)),
        ANSWER_MS
      );
      void closed.then((code) => {
        clearTimeout(timer);
        reject(new Error(`the bridge exited ${code} before answering ${method}; it said:\n${stderr}`));
      });
      waiting.set(id, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
      proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "channel-door-test", version: "0.0.1" },
  });
  proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const call: Bridge["call"] = async (name, args = {}) => {
    const answer = await request("tools/call", { name, arguments: args });
    if (!answer.result?.structuredContent) throw new Error(`${name} answered ${JSON.stringify(answer)}`);
    return answer.result.structuredContent;
  };

  return {
    pid: proc.pid!,
    log: () =>
      stderr
        .split("\n")
        .filter((line) => line.startsWith("[bellman] "))
        .map((line) => line.slice("[bellman] ".length)),
    call,
    whoami: () => call("bellman_whoami"),
    stop() {
      proc.stdin!.end();
      return Promise.race([
        closed,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`the bridge did not exit in ${ANSWER_MS}ms of its stdin closing`)), ANSWER_MS)
        ),
      ]);
    },
  };
}

/** One GET over a Unix socket, answered as the door answered it. A door that does not answer fails the test and does not hang it. */
function get(socketPath: string, path: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ socketPath, path, agent: false, timeout: 5_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => req.destroy(new Error("the door did not answer")));
    req.on("error", reject);
    req.end();
  });
}

const statusOf = async (door: string) => JSON.parse((await get(door, "/status")).body) as DoorStatus;

/** A GET, answered: its status, and its body read as JSON. */
async function json(door: string, path: string): Promise<{ status: number; body: unknown }> {
  const reply = await get(door, path);
  return { status: reply.status, body: JSON.parse(reply.body) };
}

async function until(check: () => Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("the bridge's door, as the process opens it", () => {
  it("opens at start, is named by bellman_whoami, answers /status, and is gone when the bridge exits", async () => {
    const scratch = scratchDir();
    const bridge = await open(scratch, { key: DEV_KEY.jesse });
    const door = join(scratch, `${bridge.pid}.sock`);

    expect((await bridge.whoami()).door).toBe(door);
    const status = await get(door, "/status");
    expect(status.status).toBe(200);
    expect(JSON.parse(status.body)).toEqual({
      version: DOOR_VERSION, delivery: "channel", signed_in: true, seats: [], waiting: [], recent: [],
    });

    expect(await bridge.stop()).toBe(0);
    expect(existsSync(door)).toBe(false);
  });

  // The door is an aid to the session's Bellman server, which is this process: not being able to make one costs the
  // mod its view of the room, and must cost the session nothing.
  it("carries on without a door when it cannot make one, says why, and still exits cleanly", async () => {
    const scratch = scratchDir();
    // A regular file where the folder should be: nothing can be made inside it.
    const notAFolder = join(scratch, "not-a-folder");
    writeFileSync(notAFolder, "");
    const bridge = await open(scratch, { key: DEV_KEY.jesse, doorRoot: notAFolder });

    const who = await bridge.whoami();
    const exitCode = await bridge.stop();

    expect({ source: who.source, door: who.door, exitCode, log: bridge.log() }).toEqual({
      source: "env",
      door: null,
      exitCode: 0,
      // The reason is the file system's own, and it names the folder; then the bridge says it is ready, which it
      // would not if the failure had ended it.
      log: [
        expect.stringMatching(new RegExp(`^door unavailable: .*${notAFolder}`)),
        expect.stringMatching(/^ready: channel delivery via /),
      ],
    });
    expect(existsSync(join(notAFolder, `${bridge.pid}.sock`))).toBe(false);
  });

  // Which of bellman_whoami's three answers the bridge is in decides signed_in, and only "unknown" is not signed in:
  // a BELLMAN_KEY is not an account the bridge can read, and it is still a credential the bridge holds.
  describe("what /status says of the process", () => {
    const cases: Array<[string, Options, Pick<DoorStatus, "delivery" | "signed_in">]> = [
      ["a BELLMAN_KEY, in channel delivery", { key: DEV_KEY.jesse }, { delivery: "channel", signed_in: true }],
      ["a cached sign-in, in hook delivery", { cachedSignIn: true, delivery: "hook" }, { delivery: "hook", signed_in: true }],
      ["no key and no sign-in", {}, { delivery: "channel", signed_in: false }],
    ];

    it.each(cases)("with %s", async (_what, options, expected) => {
      const scratch = scratchDir();
      const bridge = await open(scratch, options);
      const door = join(scratch, `${bridge.pid}.sock`);

      expect((await bridge.whoami()).door).toBe(door);
      const status = await statusOf(door);

      expect({ delivery: status.delivery, signed_in: status.signed_in }).toEqual(expected);
    });
  });

  // What the door reports of the rooms is the bridge's own (tests/bridge-door.test.ts), and channel.ts is what hands
  // those over. A member seated through bellman_start, one event waiting in a hook-delivery inbox, and the room's log
  // behind the bridge's own credential: each is read back through the socket.
  describe("what it reports of a room the bridge is in", () => {
    const ROOM = "qs_door";
    const MEMBER = "m_door";
    const AT = "2026-10-16T12:00:00.000Z";
    const envelope: WireEnvelope = {
      trust: "untrusted",
      origin: { memberId: "m_peer", label: "peer@a" },
      data: {
        cursor: 1,
        type: "message",
        from: { member_id: "m_peer", label: "peer@a" },
        payload: { text: "hello" },
        ref_id: null,
        at: AT,
      },
    };
    /** The envelope as the bridge keeps it: addressed to the member it watches the room as. */
    const event = {
      session_id: ROOM, member_id: MEMBER, cursor: 1, type: "message", from_member_id: "m_peer", from_label: "peer@a",
      ref_id: null, at: AT, payload: { text: "hello" },
    };

    /** The smallest Bellman that can seat a member and answer for its room: one event in the log, and the route that serves it. */
    async function bellman() {
      const logReads: Array<{ authorization: string | undefined; url: string | undefined }> = [];
      let initializes = 0;
      const server = http.createServer(async (req, res) => {
        if (req.method === "GET" && req.url?.startsWith(`/rooms/${ROOM}/events`)) {
          logReads.push({ authorization: req.headers.authorization, url: req.url });
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ events: [envelope], cursor: 1 }));
          return;
        }
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
          initializes += 1;
          result = {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "bellman", version: "0.0.0" },
          };
        } else if (message.method === "tools/list") {
          result = {
            tools: ["bellman_start", "bellman_sync", "bellman_rooms"].map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
          };
        } else if (message.method === "tools/call") {
          if (message.params?.name === "bellman_start") {
            result = {
              content: [{ type: "text", text: "started" }],
              structuredContent: { session_id: ROOM, member_id: MEMBER, join_code: "BELL-X" },
            };
          } else if (message.params?.name === "bellman_rooms") {
            // The account's rooms: the one the bridge sits in, and one it does not.
            const rooms = [
              { session_id: ROOM, your_member_id: MEMBER, status: "active" },
              { session_id: "qs_elsewhere", your_member_id: "m_else", status: "active" },
            ];
            result = { content: [{ type: "text", text: JSON.stringify({ rooms }) }], structuredContent: { rooms } };
          } else {
            // The member's long poll: the event to the first, and to the rest a poll that holds a little and brings nothing.
            const since = Number(message.params?.arguments?.since_cursor ?? 0);
            if (since > 0) await new Promise((resolve) => setTimeout(resolve, 150));
            result = {
              content: [{ type: "text", text: "events" }],
              structuredContent: { events: since > 0 ? [] : [envelope], cursor: Math.max(since, 1), session_status: "active" },
            };
          }
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as { port: number };
      return { url: `http://127.0.0.1:${port}/mcp`, logReads, connections: () => initializes };
    }

    it("reports its seat, the event that arrived, the one waiting for the hook, and reads the room's log", async () => {
      const fake = await bellman();
      const scratch = scratchDir();
      const bridge = await open(scratch, { key: DEV_KEY.jesse, url: fake.url, delivery: "hook" });
      const door = join(scratch, `${bridge.pid}.sock`);

      expect((await bridge.call("bellman_start", { manifest: { room: "door-room", preset: "pair" } })).session_id).toBe(ROOM);
      await until(async () => (await statusOf(door)).recent.length > 0, "the event to arrive");

      expect(await statusOf(door)).toEqual({
        version: DOOR_VERSION,
        delivery: "hook",
        signed_in: true,
        seats: [{ session_id: ROOM, member_id: MEMBER, retrying: false }],
        waiting: [{ session_id: ROOM, interrupting: 1, ambient: 0 }],
        recent: [event],
      });

      // The credential is the bridge's, and the mod never sees it: the log is read with the bearer the bridge holds.
      const log = await get(door, `/rooms/${ROOM}/events?after=0`);
      expect({ status: log.status, body: JSON.parse(log.body), reads: fake.logReads }).toEqual({
        status: 200,
        body: { events: [event], cursor: 1 },
        reads: [{ authorization: `Bearer ${DEV_KEY.jesse}`, url: `/rooms/${ROOM}/events?after=0` }],
      });
    });

    // The room list is the server's, asked through the connection the bridge holds. The door makes none of its own: on a
    // signed-in bridge that is what would open a browser, for a read nobody asked for.
    it("serves the room list for the seats it holds, and connects to nothing to do it", async () => {
      const fake = await bellman();
      const scratch = scratchDir();
      const bridge = await open(scratch, { key: DEV_KEY.jesse, url: fake.url });
      const door = join(scratch, `${bridge.pid}.sock`);

      expect(await json(door, "/rooms")).toEqual({ status: 503, body: { error: "not_connected" } });
      expect(fake.connections()).toBe(0);

      expect((await bridge.call("bellman_start", { manifest: { room: "door-room", preset: "pair" } })).session_id).toBe(ROOM);
      expect(fake.connections()).toBe(1);

      // Cut to the bridge's seat: the account's other room is not listed.
      expect(await json(door, "/rooms")).toEqual({
        status: 200,
        body: { rooms: [{ session_id: ROOM, your_member_id: MEMBER, status: "active" }] },
      });
      expect(fake.connections()).toBe(1);
    });
  });
});
