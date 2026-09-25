import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * channel.ts as Claude Code runs it: a real process, over real stdio.
 *
 * Everything here is a fact about the PROCESS rather than about a function —
 * whether a SIGTERM during a sign-in reaches process.exit, what is on stderr
 * while it does, and when the bridge first talks to Bellman. None of it
 * survives being extracted into something unit-testable: an in-process test of
 * a shutdown() that never really exits would pass straight over the bug it
 * exists to catch.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(root, "node_modules", ".bin", "tsx");
const ENTRY = join(root, "src", "channel.ts");

interface Bellman {
  server: Server;
  url: string;
  /** The requests that actually arrived — the bridge talking to Bellman, observed. */
  hits: { authorization: string | undefined }[];
}

/** A Bellman that takes the request and answers however the test says, or never. */
async function fakeBellman(answer: (res: ServerResponse) => void): Promise<Bellman> {
  const hits: Bellman["hits"] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    hits.push({ authorization: req.headers.authorization });
    answer(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${port}/mcp`, hits };
}

/** Takes the request and holds it: a server thinking, or a human at a browser. */
const hangs = () => undefined;
const refuses = (res: ServerResponse) => {
  res.writeHead(500, { "content-type": "text/plain" }).end("nope");
};

interface Bridge {
  proc: ChildProcess;
  /** Only the bridge's own diagnostics: tsx and Node may write their own. */
  log: () => string[];
  send: (message: unknown) => void;
  exit: Promise<{ code: number | null; signal: string | null }>;
}

const spawned: ChildProcess[] = [];
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const proc of spawned.splice(0)) proc.kill("SIGKILL");
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Options {
  key?: string;
  /**
   * Start with a credential already cached. That is both the common path and
   * the one that binds no loopback port — an uncached start would have this
   * competing for 51004 with whatever else is on the machine.
   */
  cached?: boolean;
}

function startBridge(bellman: Bellman, { key, cached = true }: Options = {}): Bridge {
  const configHome = mkdtempSync(join(tmpdir(), "bellman-channel-"));
  dirs.push(configHome);
  servers.push(bellman.server);

  if (cached) {
    const dir = join(configHome, "bellman");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dir, "credentials.json"),
      JSON.stringify({
        version: 1,
        servers: {
          [bellman.url]: {
            client: { client_id: "c_test" },
            // Deliberately not a JWT: a token to try, with no readable identity
            // behind it, which is what the ready line below reports as unknown.
            tokens: { access_token: "not.a.jwt", expires_at: Date.now() + 3_600_000 },
          },
        },
      }),
      { mode: 0o600 }
    );
  }

  const env = { ...process.env };
  delete env.BELLMAN_KEY;
  if (key) env.BELLMAN_KEY = key;
  env.BELLMAN_URL = bellman.url;
  env.XDG_CONFIG_HOME = configHome;
  env.BELLMAN_NO_BROWSER = "1";

  const proc = spawn(TSX, [ENTRY], { env, stdio: ["pipe", "pipe", "pipe"] });
  spawned.push(proc);

  let stderr = "";
  proc.stderr!.on("data", (chunk) => {
    stderr += String(chunk);
  });

  return {
    proc,
    log: () =>
      stderr
        .split("\n")
        .filter((line) => line.startsWith("[bellman] "))
        .map((line) => line.slice("[bellman] ".length)),
    send: (message) => proc.stdin!.write(`${JSON.stringify(message)}\n`),
    exit: new Promise((resolve) =>
      proc.on("exit", (code, signal) => resolve({ code, signal: signal as string | null }))
    ),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
  return true;
}

const initialize = (bridge: Bridge) =>
  bridge.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "channel-test", version: "0.0.1" },
    },
  });

const listTools = (bridge: Bridge) => {
  bridge.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  bridge.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
};

describe("the bridge as a process", () => {
  it("starts with no BELLMAN_KEY at all, where it used to refuse to", async () => {
    const bellman = await fakeBellman(hangs);
    const bridge = startBridge(bellman);

    const ready = await until(() => bridge.log().length > 0);

    expect({ ready, log: bridge.log(), exitCode: bridge.proc.exitCode }).toEqual({
      ready: true,
      log: [`ready: channel delivery via ${bellman.url} (signing in)`],
      // Not exit 1 with "BELLMAN_KEY is not set; refusing to start".
      exitCode: null,
    });
  });

  /**
   * R12, and the reason the spec's "a session that never touches Bellman never
   * opens a tab" is false. Claude Code lists a server's tools the moment it
   * connects, the bridge proxies tools/list, and proxying it means connecting.
   * The sign-in — and on a fresh machine, the browser — happens at LAUNCH.
   */
  it("reaches Bellman on tools/list, before any bellman_* tool is ever called", async () => {
    const bellman = await fakeBellman(hangs);
    const bridge = startBridge(bellman);
    await until(() => bridge.log().length > 0);

    initialize(bridge);
    await sleep(500);
    const afterInitialize = bellman.hits.length;

    listTools(bridge);
    const reached = await until(() => bellman.hits.length > 0);

    expect({ afterInitialize, reached }).toEqual({
      // The MCP handshake alone is local: nothing has been asked of Bellman yet.
      afterInitialize: 0,
      // And listing the tools, with no tool called, is what connects.
      reached: true,
    });
  });

  /**
   * R1, and the silent half of R2. shutdown() awaits bridge.close(), which
   * awaits the connect in flight, and a sign-in waiting on a human holds for up
   * to 300s. Aborting first is what lets the process reach process.exit(0)
   * instead of being force-terminated with the credential lock still held.
   *
   * The whole log is pinned in the same object as the exit: a cancel this
   * process caused itself must not be reported as a failure, and asserting the
   * exact list is what stops that being a check satisfied by nothing happening.
   */
  it("a SIGTERM during a sign-in exits cleanly, and says nothing about the cancel", async () => {
    const bellman = await fakeBellman(hangs);
    const bridge = startBridge(bellman);
    await until(() => bridge.log().length > 0);

    initialize(bridge);
    listTools(bridge);
    // Only once the sign-in is genuinely on the wire, and being held there.
    const signingIn = await until(() => bellman.hits.length > 0);

    bridge.proc.kill("SIGTERM");
    const outcome = await Promise.race([
      bridge.exit.then(({ code, signal }) => ({ stopped: "exited", code, signal })),
      sleep(4_000).then(() => ({ stopped: "still running", code: null, signal: null })),
    ]);

    expect({ signingIn, ...outcome, log: bridge.log() }).toEqual({
      signingIn: true,
      stopped: "exited",
      code: 0,
      signal: null,
      log: [`ready: channel delivery via ${bellman.url} (signing in)`],
    });
  });

  /** The loud half of R2: a sign-in that failed on its own must reach the user. */
  it("says why a sign-in failed, when it was not a cancel", async () => {
    const bellman = await fakeBellman(refuses);
    const bridge = startBridge(bellman);
    await until(() => bridge.log().length > 0);

    initialize(bridge);
    listTools(bridge);
    const reported = await until(() => bridge.log().length > 1);

    expect({ reported, log: bridge.log() }).toEqual({
      reported: true,
      log: [
        `ready: channel delivery via ${bellman.url} (signing in)`,
        expect.stringMatching(/^sign-in failed: .*nope/),
      ],
    });
  });

  /** An explicitly set key still wins, still goes out as a bearer header, and never signs in. */
  it("uses BELLMAN_KEY unchanged when one is set", async () => {
    const bellman = await fakeBellman(refuses);
    const bridge = startBridge(bellman, { key: "qk_dev_jesse", cached: false });
    await until(() => bridge.log().length > 0);

    initialize(bridge);
    listTools(bridge);
    const reached = await until(() => bellman.hits.length > 0);
    await sleep(300);

    expect({ reached, authorization: bellman.hits[0]?.authorization, log: bridge.log() }).toEqual({
      reached: true,
      authorization: "Bearer qk_dev_jesse",
      // No sign-in was attempted, so there is no sign-in failure to report either.
      log: [`ready: channel delivery via ${bellman.url} (BELLMAN_KEY)`],
    });
  });
});
