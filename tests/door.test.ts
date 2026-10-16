/**
 * The bridge's door (src/door.ts): its status and a room's log, on a Unix socket. Each test starts a real door
 * on a socket under a scratch folder and asks it over HTTP, as the mod will. Only the bridge behind it is a
 * stand-in: a `DoorSource` of spies, because what the door reports is the bridge's and what the door does with it
 * is the point here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { doorPathFor, doorRoot, startDoor, statusOf, type DoorSource } from "../src/door.js";
import { drain, enqueue, pendingCount, type PeerEvent } from "../src/inbox.js";

let root: string;
/** Every door a test started, closed in afterEach so that no listener outlives the test that opened it. */
let doors: Array<{ close(): Promise<void> }>;

beforeEach(() => {
  // Short on purpose: a Unix socket path may be at most 104 bytes on macOS.
  root = mkdtempSync(join(tmpdir(), "bd-"));
  doors = [];
});

afterEach(async () => {
  await Promise.all(doors.map((door) => door.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function event(over: Partial<PeerEvent> = {}): PeerEvent {
  return {
    session_id: "qs_room1",
    member_id: "m1",
    cursor: 1,
    type: "message",
    from_member_id: "m_peer",
    from_label: "peer@a",
    ref_id: null,
    at: "2026-10-16T12:00:00.000Z",
    payload: { text: "hello" },
    ...over,
  };
}

/** A bridge in channel delivery, signed in, watching one member in one room, whose log reads answer 200. */
function source(over: Partial<DoorSource> = {}): DoorSource {
  return {
    delivery: "channel",
    signedIn: () => true,
    seats: () => [{ session_id: "qs_room1", member_id: "m1", retrying: false }],
    recent: () => [event()],
    readEvents: vi.fn(async () => ({ status: 200, body: { events: [], cursor: 3 } })),
    ...over,
  };
}

/** A door on a socket named `name` under the scratch folder. */
async function start(name: string, src: DoorSource) {
  const door = await startDoor(join(root, name), src);
  doors.push(door);
  return door;
}

/** One request over a socket, answered as the door answered it. A door that does not answer fails the test, not hangs it. */
function request(method: string, socketPath: string, path: string) {
  return new Promise<{ status: number; type: string | undefined; body: string }>((resolve, reject) => {
    const req = http.request({ socketPath, path, method, agent: false, timeout: 3_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          type: res.headers["content-type"],
          body: Buffer.concat(chunks).toString("utf8"),
        })
      );
    });
    req.on("timeout", () => req.destroy(new Error("the door did not answer")));
    req.on("error", reject);
    req.end();
  });
}

const get = (socketPath: string, path: string) => request("GET", socketPath, path);
const post = (socketPath: string, path: string) => request("POST", socketPath, path);

/** The process's umask, read the way that is not deprecated: set one, and put it back. */
function currentUmask(): number {
  const mask = process.umask(0);
  process.umask(mask);
  return mask;
}

describe("where the door is", () => {
  it("is ~/.claude/bellman/door unless BELLMAN_DOOR_ROOT says otherwise", () => {
    vi.stubEnv("BELLMAN_DOOR_ROOT", undefined);
    expect(doorRoot()).toBe(join(homedir(), ".claude", "bellman", "door"));
    vi.stubEnv("BELLMAN_DOOR_ROOT", "/somewhere/else");
    expect(doorRoot()).toBe("/somewhere/else");
    expect(doorPathFor(4242)).toBe("/somewhere/else/4242.sock");
  });

  it("names a socket for the pid that owns it", () => {
    expect(doorPathFor(4242, "/r")).toBe("/r/4242.sock");
  });
});

describe("statusOf", () => {
  it("counts waiting events per room in hook delivery, and none in channel delivery", () => {
    const inboxDir = join(root, "inbox");
    enqueue(inboxDir, event({ member_id: "m1", cursor: 1 }));
    enqueue(inboxDir, event({ member_id: "m-gone", cursor: 2 }));
    const seats = () => [{ session_id: "qs_room1", member_id: "m1", retrying: false }];
    expect(statusOf(source({ delivery: "hook", inboxDir, seats })).waiting).toEqual([
      { session_id: "qs_room1", interrupting: 1, ambient: 0 },
    ]);
    expect(statusOf(source({ delivery: "channel", inboxDir, seats })).waiting).toEqual([]);
  });

  it("adds up the members that sit in one room, and lists a room once", () => {
    const inboxDir = join(root, "inbox");
    enqueue(inboxDir, event({ member_id: "m1", cursor: 1 }));
    enqueue(inboxDir, event({ member_id: "m2", cursor: 2, ambient: true }));
    enqueue(inboxDir, event({ member_id: "m3", cursor: 3 }));
    const seats = () => [
      { session_id: "qs_room1", member_id: "m1", retrying: false },
      { session_id: "qs_room2", member_id: "m2", retrying: false },
      { session_id: "qs_room1", member_id: "m3", retrying: true },
    ];
    expect(statusOf(source({ delivery: "hook", inboxDir, seats })).waiting).toEqual([
      { session_id: "qs_room1", interrupting: 2, ambient: 0 },
      { session_id: "qs_room2", interrupting: 0, ambient: 1 },
    ]);
  });

  it("reports what the source reports", () => {
    const seats = [{ session_id: "qs_room1", member_id: "m1", retrying: true }];
    const recent = [event({ cursor: 8 })];
    const src = source({ delivery: "hook", signedIn: () => false, seats: () => seats, recent: () => recent });
    expect(statusOf(src)).toEqual({ version: 1, delivery: "hook", signed_in: false, seats, waiting: [], recent });
  });
});

describe("the door", () => {
  it("serves /status on its socket, to its owner alone", async () => {
    const src = source();
    const door = await start("1.sock", src);
    const res = await get(door.path, "/status");
    expect(res.status).toBe(200);
    expect(res.type).toBe("application/json");
    expect(JSON.parse(res.body)).toEqual(statusOf(src));
    expect(statSync(door.path).mode & 0o777).toBe(0o600);
  });

  it("makes the folder it lives in 0700", async () => {
    const door = await start(join("folder", "1.sock"), source());
    expect(statSync(dirname(door.path)).mode & 0o777).toBe(0o700);
  });

  it("counts an inbox through /status without taking from it", async () => {
    const inboxDir = join(root, "inbox");
    enqueue(inboxDir, event({ member_id: "m1", cursor: 1 }));
    enqueue(inboxDir, event({ member_id: "m1", cursor: 2, ambient: true }));
    const door = await start("1.sock", source({ delivery: "hook", inboxDir }));
    const res = await get(door.path, "/status");
    expect(JSON.parse(res.body).waiting).toEqual([{ session_id: "qs_room1", interrupting: 1, ambient: 1 }]);
    expect(pendingCount(inboxDir)).toBe(2);
    expect(drain(inboxDir).map((e) => e.cursor)).toEqual([1, 2]);
  });

  it("passes a log read to readEvents, and refuses a bad cursor", async () => {
    const src = source();
    const door = await start("2.sock", src);
    expect((await get(door.path, "/rooms/qs_room1/events?after=3")).status).toBe(200);
    expect(src.readEvents).toHaveBeenCalledWith("qs_room1", 3);
    expect(await get(door.path, "/rooms/qs_room1/events?after=abc")).toMatchObject({ status: 400 });
  });

  it("answers a log read with the status and the body readEvents gave", async () => {
    const refusal = { status: 503, body: { error: "no_credential" } };
    const door = await start("2.sock", source({ readEvents: vi.fn(async () => refusal) }));
    const res = await get(door.path, "/rooms/qs_room1/events");
    expect(res).toMatchObject({ status: 503, type: "application/json" });
    expect(JSON.parse(res.body)).toEqual({ error: "no_credential" });
  });

  it("answers a peer's text outside ASCII whole", async () => {
    const peer = event({ payload: { text: "h\u{e9}llo \u{1f642} \u{fc}" }, from_label: "\u{fc}n\u{ef}@\u{1f642}" });
    const log = { events: [peer], cursor: 3 };
    const readEvents = vi.fn(async () => ({ status: 200, body: log }));
    const door = await start("2.sock", source({ recent: () => [peer], readEvents }));
    expect(JSON.parse((await get(door.path, "/rooms/qs_room1/events")).body)).toEqual(log);
    expect(JSON.parse((await get(door.path, "/status")).body).recent).toEqual([peer]);
  });

  it("reads from the start when it is given no cursor", async () => {
    const src = source();
    const door = await start("2.sock", src);
    await get(door.path, "/rooms/qs_room1/events");
    expect(src.readEvents).toHaveBeenCalledWith("qs_room1", undefined);
  });

  it("decodes the room in the path before it asks for the log", async () => {
    const src = source();
    const door = await start("2.sock", src);
    await get(door.path, "/rooms/qs%2Fa%20b/events");
    expect(src.readEvents).toHaveBeenCalledWith("qs/a b", undefined);
  });

  it("takes a cursor of one to fifteen digits and refuses anything else", async () => {
    const src = source();
    const door = await start("2.sock", src);
    for (const after of ["", "abc", "-1", "1.5", "1e3", "%203", "0x10", "1234567890123456"]) {
      const res = await get(door.path, `/rooms/qs_room1/events?after=${after}`);
      expect(res.status, `after=${after}`).toBe(400);
      expect(JSON.parse(res.body), `after=${after}`).toEqual({ error: "bad_cursor" });
    }
    expect(src.readEvents).not.toHaveBeenCalled();
    for (const after of ["0", "7", "999999999999999"]) {
      expect((await get(door.path, `/rooms/qs_room1/events?after=${after}`)).status, `after=${after}`).toBe(200);
      expect(src.readEvents).toHaveBeenLastCalledWith("qs_room1", Number(after));
    }
  });

  it("answers 405 to a POST and 404 to an unknown path", async () => {
    const door = await start("3.sock", source());
    expect((await post(door.path, "/status")).status).toBe(405);
    expect((await get(door.path, "/elsewhere")).status).toBe(404);
  });

  it("serves two routes and nothing near them", async () => {
    const src = source();
    const door = await start("3.sock", src);
    const near = [
      "/",
      "/status/",
      "//status",
      "/rooms",
      "/rooms/qs_room1",
      "/rooms//events",
      "/rooms/qs_room1/events/more",
      "/x/rooms/qs_room1/events",
      "/rooms/a/b/events",
      "/rooms/%E0%A4%A/events", // an escape that does not decode names no room
    ];
    for (const path of near) {
      const res = await get(door.path, path);
      expect(res.status, path).toBe(404);
      expect(JSON.parse(res.body), path).toEqual({ error: "not_found" });
    }
    expect(src.readEvents).not.toHaveBeenCalled();
  });

  it("answers 500 to whatever throws behind a request, and goes on serving", async () => {
    const boom = () => {
      throw new Error("secret detail");
    };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic; // JSON cannot say it
    const readEvents = vi
      .fn()
      .mockRejectedValueOnce(new Error("secret detail"))
      .mockResolvedValueOnce({ status: 200, body: cyclic })
      .mockResolvedValueOnce({ status: 1000, body: {} });
    const door = await start("5.sock", source({ signedIn: boom, seats: boom, recent: boom, readEvents }));
    const thrown = [
      ["/status", "a getter that throws"],
      ["/rooms/qs_room1/events", "a read that rejects"],
      ["/rooms/qs_room1/events", "a body that will not serialize"],
      ["/rooms/qs_room1/events", "a status that is not one"],
    ] as const;
    for (const [path, why] of thrown) {
      const res = await get(door.path, path);
      expect(res.status, why).toBe(500);
      expect(JSON.parse(res.body), why).toEqual({ error: "internal" });
    }
    expect((await get(door.path, "/elsewhere")).status).toBe(404);
  });

  it("outlives an error on its running server, which would otherwise be an uncaught exception", async () => {
    const real = http.createServer;
    let server!: http.Server;
    vi.spyOn(http, "createServer").mockImplementation(((...args: Parameters<typeof real>) =>
      (server = real(...args))) as typeof real);
    const door = await start("6.sock", source());
    const accept = () => server.emit("error", Object.assign(new Error("accept EMFILE"), { code: "EMFILE" }));
    // Twice: startDoor's own once-listener for a failed start hears the first, so only the second tells whether
    // the running server has a listener of its own.
    expect(accept).not.toThrow();
    expect(accept).not.toThrow();
    expect((await get(door.path, "/status")).status).toBe(200);
  });

  it("replaces whatever sits at its path, and removes its socket on close", async () => {
    const path = join(root, "4.sock");
    writeFileSync(path, "stale");
    const door = await start("4.sock", source());
    expect(door.path).toBe(path);
    expect((await get(path, "/status")).status).toBe(200);
    await door.close();
    expect(existsSync(path)).toBe(false);
  });

  it("replaces the socket a bridge left behind when it was killed", async () => {
    const path = join(root, "4.sock");
    // SIGKILL runs no cleanup, so the socket file stays with nothing listening on it: what a crashed bridge leaves.
    const killed = spawnSync(process.execPath, [
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(path)}, () => process.kill(process.pid, "SIGKILL"));`,
    ]);
    expect(killed.signal).toBe("SIGKILL");
    expect(lstatSync(path).isSocket()).toBe(true);
    const door = await start("4.sock", source());
    expect((await get(door.path, "/status")).status).toBe(200);
  });

  it("rejects when a directory sits at its path, and leaves the directory alone", async () => {
    const path = join(root, "4.sock");
    mkdirSync(join(path, "inside"), { recursive: true });
    await expect(startDoor(path, source())).rejects.toThrow();
    expect(lstatSync(join(path, "inside")).isDirectory()).toBe(true);
  });

  it("rejects, and does not hang, when it cannot listen", async () => {
    const real = http.createServer;
    vi.spyOn(http, "createServer").mockImplementation(((...args: Parameters<typeof real>) => {
      const server = real(...args);
      // listen() reports a failure as an 'error' event and never by throwing: say it the way it does.
      vi.spyOn(server, "listen").mockImplementation(() => {
        queueMicrotask(() => server.emit("error", Object.assign(new Error("listen EACCES"), { code: "EACCES" })));
        return server;
      });
      return server;
    }) as typeof real);
    const outcome = await Promise.race([
      startDoor(join(root, "8.sock"), source()).then(() => "listening", (error: unknown) => error),
      new Promise((resolve) => setTimeout(resolve, 2_000, "hung")),
    ]);
    expect(outcome).toMatchObject({ code: "EACCES" });
  });

  it("leaves the process's umask as it found it", async () => {
    const before = currentUmask();
    await start("8.sock", source());
    expect(currentUmask()).toBe(before);
  });

  it("closes without waiting for a request it is still answering", async () => {
    let reached!: () => void;
    const reading = new Promise<void>((resolve) => (reached = resolve));
    const readEvents = vi.fn(() => {
      reached();
      return new Promise<never>(() => undefined); // an upstream that never answers
    });
    const door = await start("7.sock", source({ readEvents }));
    const dropped = get(door.path, "/rooms/qs_room1/events").catch((error: Error) => error);
    await reading;
    const outcome = await Promise.race([
      door.close().then(() => "closed"),
      new Promise((resolve) => setTimeout(resolve, 2_000, "still open")),
    ]);
    expect(outcome).toBe("closed");
    expect(await dropped).toBeInstanceOf(Error);
  });
});
