import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BusUnavailableError, SUN_PATH_MAX_BYTES, busPath, busRoot, openBus,
  type Bus, type BusOptions, type Coordinator, type SyncFrom,
} from "../src/bus.js";

// Every test here drives real Unix sockets in a per-test temp directory. Nothing
// is mocked: the election is a claim about what the OS does with bind, connect
// and unlink, and a fake socket could only agree with whatever I assumed.

let tmp: string;
/** The bus directory. Not created: openBus has to create it, and the mode is asserted. */
let root: string;
/** Closed in afterEach, so a listener never outlives the test that opened it. */
let opened: Bus[];
let logs: string[];

const noSync: SyncFrom = async (_session, _member, cursor) => ({ events: [], cursor });

function options(over: Partial<BusOptions> = {}): BusOptions {
  return {
    url: "https://bellman.test/mcp",
    credential: "qk_test",
    root,
    syncFrom: noSync,
    log: (message) => logs.push(message),
    ...over,
  };
}

async function open(over: Partial<BusOptions> = {}): Promise<Bus> {
  const bus = await openBus(options(over));
  opened.push(bus);
  return bus;
}

function asCoordinator(bus: Bus): Coordinator {
  if (bus.role !== "coordinator") throw new Error(`expected a coordinator, got a ${bus.role}`);
  return bus;
}

function socketPath(over: Partial<BusOptions> = {}): string {
  const o = options(over);
  return busPath({ url: o.url, credential: o.credential, root: o.root });
}

/** What a SIGKILLed coordinator leaves behind: a socket file with nothing listening on it. */
function leaveStaleSocket(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const child = spawnSync(process.execPath, [
    "-e",
    `const s = require("node:net").createServer();
     s.listen(${JSON.stringify(path)}, () => process.kill(process.pid, "SIGKILL"));`,
  ]);
  expect(child.signal).toBe("SIGKILL");
  expect(lstatSync(path).isSocket()).toBe(true);
}

/** The error code connect() reports for a path, or "connected". */
function probe(path: string): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(path);
    s.once("connect", () => { s.destroy(); resolve("connected"); });
    s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? e.message));
  });
}

let savedBusRoot: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "bellman-bus-"));
  root = join(tmp, "bus");
  opened = [];
  logs = [];
  // A test that forgets to pass `root` must land in the scratch directory and not in
  // the real ~/.claude/bellman/bus, where it would leave a socket behind.
  savedBusRoot = process.env.BELLMAN_BUS_ROOT;
  process.env.BELLMAN_BUS_ROOT = join(tmp, "unspecified-root");
});

afterEach(async () => {
  await Promise.all(opened.map((b) => b.close()));
  if (savedBusRoot === undefined) delete process.env.BELLMAN_BUS_ROOT;
  else process.env.BELLMAN_BUS_ROOT = savedBusRoot;
  rmSync(tmp, { recursive: true, force: true });
});

describe("the bus path", () => {
  const identity = { url: "https://bellman.test/mcp", credential: "qk_test" };

  it("is the same for the same identity, and sits under the root it is given", () => {
    const a = busPath({ ...identity, root: "/r" });
    expect(busPath({ ...identity, root: "/r" })).toBe(a);
    expect(a.startsWith("/r/")).toBe(true);
    expect(a.endsWith(".sock")).toBe(true);
  });

  it("differs for a different server URL and for a different credential, so two identities never share a bus", () => {
    const base = busPath({ ...identity, root: "/r" });
    expect(busPath({ ...identity, url: "https://other.test/mcp", root: "/r" })).not.toBe(base);
    expect(busPath({ ...identity, credential: "qk_someone_else", root: "/r" })).not.toBe(base);
  });

  it("cannot be steered by moving the boundary between the URL and the credential", () => {
    // Hashing url + credential as bare concatenation would give both of these the
    // same digest, and one identity would be handed the other's bus.
    expect(busPath({ url: "a", credential: "bc", root: "/r" }))
      .not.toBe(busPath({ url: "ab", credential: "c", root: "/r" }));
  });

  it("defaults to ~/.claude/bellman/bus, beside the inbox", () => {
    const saved = process.env.BELLMAN_BUS_ROOT;
    delete process.env.BELLMAN_BUS_ROOT;
    try {
      expect(busRoot()).toBe(join(homedir(), ".claude", "bellman", "bus"));
    } finally {
      if (saved !== undefined) process.env.BELLMAN_BUS_ROOT = saved;
    }
  });

  it("honours BELLMAN_BUS_ROOT, as the inbox honours BELLMAN_INBOX_ROOT", () => {
    const saved = process.env.BELLMAN_BUS_ROOT;
    process.env.BELLMAN_BUS_ROOT = "/somewhere/else";
    try {
      expect(busRoot()).toBe("/somewhere/else");
      expect(busPath(identity).startsWith("/somewhere/else/")).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.BELLMAN_BUS_ROOT;
      else process.env.BELLMAN_BUS_ROOT = saved;
    }
  });
});

describe("election: the socket is the lock (D8)", () => {
  it("makes the first opener the coordinator, and the next a subscriber that is really attached to it", async () => {
    const first = await open();
    const second = await open();
    expect(first.role).toBe("coordinator");
    expect(second.role).toBe("subscriber");
    // The role field alone would pass a subscriber that connected to nothing.
    await vi.waitFor(() => expect(asCoordinator(first).stats().connections).toBe(1));
  });

  it("creates the bus directory 0700 and the socket 0600", async () => {
    await open();
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(socketPath()).mode & 0o777).toBe(0o600);
  });

  it("elects exactly one coordinator when openers race on an empty path", async () => {
    // Called in one synchronous array literal, so every probe is in flight before
    // any result is handled: all three see ENOENT, all three go on to listen().
    // That is the race, not a polite imitation of it.
    const buses = await Promise.all([open(), open(), open()]);
    expect(buses.filter((b) => b.role === "coordinator")).toHaveLength(1);
    expect(buses.filter((b) => b.role === "subscriber")).toHaveLength(2);
    // The losers lost at listen() with EADDRINUSE and went round again to connect,
    // rather than falling back to polling: one log line each says the branch ran.
    expect(logs.filter((l) => /EADDRINUSE/.test(l))).toHaveLength(2);
    const coordinator = asCoordinator(buses.find((b) => b.role === "coordinator")!);
    await vi.waitFor(() => expect(coordinator.stats().connections).toBe(2));
  });

  it("unlinks a stale socket left by a SIGKILLed coordinator and takes over", async () => {
    const path = socketPath();
    leaveStaleSocket(path);
    expect(await probe(path)).toBe("ECONNREFUSED"); // unconnectable, and still on disk

    const bus = await open();
    expect(bus.role).toBe("coordinator");
    expect(await probe(path)).toBe("connected");
    const next = await open();
    expect(next.role).toBe("subscriber");
  });

  it("elects exactly one coordinator when openers race on a stale path", async () => {
    // Two or more bridges find the same dead file at once. Each used to unlink it
    // and listen, and a late unlink would delete the winner's live socket: the
    // winner keeps serving its own connections, nobody else can ever find it, and
    // the next opener becomes a second coordinator for the same identity.
    const path = socketPath();
    leaveStaleSocket(path);
    const buses = await Promise.all([open(), open(), open()]);
    expect(buses.filter((b) => b.role === "coordinator")).toHaveLength(1);
    const coordinator = asCoordinator(buses.find((b) => b.role === "coordinator")!);
    await vi.waitFor(() => expect(coordinator.stats().connections).toBe(2));
    // And the file on disk is still the live one.
    expect(await probe(path)).toBe("connected");
  });

  it("treats EEXIST from bind as losing the race too, which is what macOS tells the loser of a simultaneous bind", async () => {
    // Found by racing eight real processes at one stale path: in about a third of the
    // trials at least one opener was told "listen EEXIST: file already exists" and
    // gave up, where the plan says a loser must connect to the winner. The kernel's
    // create lost to the other's, and macOS reports that as EEXIST where Linux
    // translates it to EADDRINUSE. In one process the first listen() always finishes
    // before the second begins, so the real thing cannot happen here and is scripted:
    // a real winner binds while the loser is mid-bind, then the loser is told EEXIST.
    const real = net.createServer;
    let scripted = false;
    const spy = vi.spyOn(net, "createServer").mockImplementation(((...args: unknown[]) => {
      if (scripted) return (real as (...a: unknown[]) => net.Server).apply(net, args);
      scripted = true;
      const loser = new EventEmitter() as unknown as net.Server;
      loser.listen = (() => {
        void openBus(options()).then((winner) => {
          opened.push(winner);
          loser.emit("error", Object.assign(new Error("listen EEXIST: file already exists"), { code: "EEXIST" }));
        });
        return loser;
      }) as net.Server["listen"];
      loser.close = (() => loser) as net.Server["close"];
      return loser;
    }) as never);
    try {
      const bus = await open();
      expect(bus.role).toBe("subscriber"); // it connected to the winner, and did not fall back to polling
      expect(logs.some((l) => /lost the race.*EEXIST/.test(l))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("unlinks its own socket on a clean close, and a later opener takes over", async () => {
    const path = socketPath();
    const first = await open();
    expect(existsSync(path)).toBe(true);
    await first.close();
    expect(existsSync(path)).toBe(false);
    expect((await open()).role).toBe("coordinator");
  });

  it("closes cleanly when its socket file has already been removed from under it", async () => {
    const first = await open();
    rmSync(socketPath(), { force: true });
    await expect(first.close()).resolves.toBeUndefined();
  });

  it("gives two identities on one machine two separate buses", async () => {
    const a = await open({ credential: "qk_a" });
    const b = await open({ credential: "qk_b" });
    expect(a.role).toBe("coordinator");
    expect(b.role).toBe("coordinator");
    const aAgain = await open({ credential: "qk_a" });
    expect(aAgain.role).toBe("subscriber");
    await vi.waitFor(() => expect(asCoordinator(a).stats().connections).toBe(1));
    expect(asCoordinator(b).stats().connections).toBe(0);
  });
});

describe("when the bus cannot be created, the caller can fall back (D11)", () => {
  const unavailable = (reason: string) =>
    expect.objectContaining({ name: "BusUnavailableError", reason });

  it("reports a path past sun_path as a clean failure and touches nothing", async () => {
    const long = join(tmp, "x".repeat(150));
    const error = await openBus(options({ root: long })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BusUnavailableError);
    expect(error).toEqual(unavailable("path-too-long"));
    expect(existsSync(long)).toBe(false);
  });

  /** A root deep enough that the socket path is exactly `bytes` long. */
  function rootForSocketOf(bytes: number): string | undefined {
    const shortest = Buffer.byteLength(socketPath({ root: tmp }));
    const pad = bytes - shortest - 1; // "/" plus the padding directory
    return pad >= 1 ? join(tmp, "p".repeat(pad)) : undefined;
  }

  it("accepts a path of exactly the limit, and it really works as a bus", async (ctx) => {
    const deep = rootForSocketOf(SUN_PATH_MAX_BYTES);
    if (!deep) return ctx.skip();
    expect(Buffer.byteLength(socketPath({ root: deep }))).toBe(SUN_PATH_MAX_BYTES);
    const first = await open({ root: deep });
    const second = await open({ root: deep });
    expect([first.role, second.role]).toEqual(["coordinator", "subscriber"]);
  });

  it("refuses a path one byte past the limit", async (ctx) => {
    const deep = rootForSocketOf(SUN_PATH_MAX_BYTES + 1);
    if (!deep) return ctx.skip();
    await expect(openBus(options({ root: deep }))).rejects.toEqual(unavailable("path-too-long"));
    expect(existsSync(deep)).toBe(false);
  });

  /**
   * The control for the two tests above, and for the reason the guard exists at
   * all. Node does not fail on a path past sun_path: it silently truncates it. The
   * hash is the tail of the path, so truncation cuts it off, and two identities
   * whose paths differ only there are handed the same socket.
   *
   * Measured here rather than assumed, because the limit is the OS's and not
   * mine: find the longest path the OS keeps whole, and require the guard never
   * to admit more than that. If a future Node starts throwing instead of
   * truncating, the last two assertions fail and say the comment above is stale.
   */
  it("[control] Node truncates an over-long socket path instead of refusing it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bellman-trunc-"));
    try {
      const make = (bytes: number, tail: string) =>
        join(dir, "s".repeat(bytes - Buffer.byteLength(dir) - 1 - tail.length) + tail);
      const listen = (p: string) =>
        new Promise<net.Server | string>((resolve) => {
          const server = net.createServer();
          server.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? e.message));
          server.listen(p, () => resolve(server));
        });
      const shut = (s: net.Server) => new Promise<void>((r) => s.close(() => r()));

      let faithful = 0; // the longest path whose own name appears on disk
      for (let bytes = 90; bytes <= 140; bytes++) {
        const p = make(bytes, "AAAA");
        const server = await listen(p);
        if (typeof server === "string") throw new Error(`listen failed outright at ${bytes} bytes: ${server}`);
        const kept = existsSync(p);
        await shut(server);
        if (!kept) break;
        faithful = bytes;
      }
      expect(faithful).toBeGreaterThan(0);
      // The guard must never admit a path the OS would truncate.
      expect(SUN_PATH_MAX_BYTES).toBeLessThanOrEqual(faithful);
      // ...and the OS really does truncate, or this whole guard is moot.
      expect(faithful).toBeLessThan(140);

      // The consequence: identities differing only past the cut share one socket.
      const a = await listen(make(faithful + 6, "AAAA"));
      const b = await listen(make(faithful + 6, "BBBB"));
      expect(typeof a).not.toBe("string");
      expect(b).toBe("EADDRINUSE");
      if (typeof a !== "string") await shut(a);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a relative root, which would put sockets wherever the bridge was started", async () => {
    await expect(openBus(options({ root: "relative/bus" }))).rejects.toEqual(unavailable("relative-root"));
  });

  it("reports a root that is not a directory, even when run as root", async () => {
    const file = join(tmp, "a-file");
    writeFileSync(file, "x");
    await expect(openBus(options({ root: file }))).rejects.toEqual(unavailable("filesystem"));
  });

  it("leaves a file that is not a socket alone, and reports the bus unavailable", async () => {
    const path = socketPath();
    mkdirSync(root, { recursive: true });
    writeFileSync(path, "this is somebody's file");
    await expect(openBus(options())).rejects.toEqual(unavailable("filesystem"));
    expect(readFileSync(path, "utf8")).toBe("this is somebody's file");
  });

  it("reports a stale socket it cannot remove as unavailable, not as a crash", async (ctx) => {
    // Root can unlink from a read-only directory, so there is nothing to refuse.
    if (process.getuid?.() === 0) return ctx.skip();
    const path = socketPath();
    leaveStaleSocket(path);
    chmodSync(dirname(path), 0o500);
    try {
      await expect(openBus(options())).rejects.toEqual(unavailable("filesystem"));
    } finally {
      chmodSync(dirname(path), 0o700);
    }
  });

  it("gives up with 'contended' rather than spinning when every round is lost", async () => {
    // Scripted, because no honest arrangement of real sockets loses every round
    // for ever. Every probe says "stale" and every bind says "someone else won".
    // The script gives way after 100 refusals: a loop with no cap would otherwise
    // spin on microtasks and starve the very timeout that is meant to catch it, so
    // without the cap this fails fast by resolving instead of rejecting.
    let probes = 0;
    const refused = (): net.Socket => {
      const socket = new EventEmitter() as unknown as net.Socket;
      socket.destroy = () => socket;
      const stale = probes++ < 100;
      queueMicrotask(() => stale
        ? socket.emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" }))
        : socket.emit("connect"));
      return socket;
    };
    const taken = (): net.Server => {
      const server = new EventEmitter() as unknown as net.Server;
      server.listen = (() => {
        queueMicrotask(() => server.emit("error", Object.assign(new Error("in use"), { code: "EADDRINUSE" })));
        return server;
      }) as net.Server["listen"];
      server.close = (() => server) as net.Server["close"];
      return server;
    };
    const connect = vi.spyOn(net, "connect").mockImplementation(refused as never);
    const createServer = vi.spyOn(net, "createServer").mockImplementation(taken as never);
    try {
      await expect(openBus(options())).rejects.toEqual(unavailable("contended"));
      expect(connect.mock.calls.length).toBeGreaterThan(1); // it did try again...
      expect(connect.mock.calls.length).toBeLessThan(50); // ...and it did stop
    } finally {
      connect.mockRestore();
      createServer.mockRestore();
    }
  }, 2_000);

  it("takes the fallback on Windows, where the election is unverified", async () => {
    await expect(openBus(options({ platform: "win32" }))).rejects.toEqual(unavailable("platform"));
    expect(existsSync(root)).toBe(false);
  });
});
