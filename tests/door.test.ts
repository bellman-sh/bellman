/**
 * The bridge's door (src/door.ts): its status, a room's log, the room list, a room's canvas and a decline, on a Unix
 * socket. Each test starts a real door on a socket under a scratch folder and asks it over HTTP, as the mod will. Only
 * the bridge behind it is a stand-in: a `DoorSource` of spies, because what the door reports is the bridge's and what
 * the door does with it is the point here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { doorPathFor, doorRoot, startDoor, statusOf, type DoorSource } from "../src/door.js";
import { drain, enqueue, pendingCount, type PeerEvent } from "../src/inbox.js";
import { SurfaceKeyShape } from "../src/surface.js";

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

/** A bridge in channel delivery, holding a sign-in, watching one member in one room, whose log reads answer 200. */
function source(over: Partial<DoorSource> = {}): DoorSource {
  return {
    delivery: "channel",
    hasSignIn: () => true,
    seats: () => [{ session_id: "qs_room1", member_id: "m1", retrying: false }],
    recent: () => [event()],
    readEvents: vi.fn(async () => ({ status: 200, body: { events: [], cursor: 3 } })),
    readRooms: vi.fn(async () => ({ status: 200, body: { rooms: [] } })),
    readSurface: vi.fn(async () => ({ status: 200, body: { session_id: "qs_room1", room: {}, surface: { cursor: 0, items: [] } } })),
    decline: vi.fn(async () => ({ status: 200, body: { cursor: 12 } })),
    setStatus: vi.fn(async () => ({ status: 200, body: { sent: 1 } })),
    writeSurface: vi.fn(async () => ({ status: 200, body: { cursor: 14 } })),
    ...over,
  };
}

/** A door on a socket named `name` under the scratch folder. */
async function start(name: string, src: DoorSource) {
  const door = await startDoor(join(root, name), src);
  doors.push(door);
  return door;
}

/** What a test sends with a request: a body, and its content type (application/json unless it says otherwise; null sends none). */
interface Sent {
  body?: string;
  type?: string | null;
}

/** One request over a socket, answered as the door answered it. A door that does not answer fails the test, not hangs it. */
function request(method: string, socketPath: string, path: string, sent: Sent = {}) {
  return new Promise<{ status: number; type: string | undefined; body: string }>((resolve, reject) => {
    const headers: Record<string, string> = {};
    // Framed with a length, so that a body on a DELETE is a body and not the start of another request.
    if (sent.body !== undefined) headers["content-length"] = String(Buffer.byteLength(sent.body));
    if (sent.body !== undefined && sent.type !== null) headers["content-type"] = sent.type ?? "application/json";
    const req = http.request({ socketPath, path, method, headers, agent: false, timeout: 3_000 }, (res) => {
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
    req.end(sent.body);
  });
}

const get = (socketPath: string, path: string) => request("GET", socketPath, path);
const post = (socketPath: string, path: string, sent?: Sent) => request("POST", socketPath, path, sent);

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
  it("counts waiting events per room in hook and queue delivery, and none in channel delivery", () => {
    const inboxDir = join(root, "inbox");
    enqueue(inboxDir, event({ member_id: "m1", cursor: 1 }));
    enqueue(inboxDir, event({ member_id: "m-gone", cursor: 2 }));
    const seats = () => [{ session_id: "qs_room1", member_id: "m1", retrying: false }];
    expect(statusOf(source({ delivery: "hook", inboxDir, seats })).waiting).toEqual([
      { session_id: "qs_room1", interrupting: 1, ambient: 0 },
    ]);
    // Queue delivery keeps the same inbox as hook (the Claude Desktop bundle's, #241), and says which it is.
    expect(statusOf(source({ delivery: "queue", inboxDir, seats }))).toMatchObject({
      delivery: "queue",
      waiting: [{ session_id: "qs_room1", interrupting: 1, ambient: 0 }],
    });
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
    const src = source({ delivery: "hook", hasSignIn: () => false, seats: () => seats, recent: () => recent });
    expect(statusOf(src)).toEqual({ version: 1, delivery: "hook", has_sign_in: false, seats, waiting: [], recent });
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

  it("serves its routes and nothing near them", async () => {
    const src = source();
    const door = await start("3.sock", src);
    const near = [
      "/",
      "/status/",
      "//status",
      "//rooms",
      "/rooms/",
      "/rooms/qs_room1",
      "/rooms//events",
      "/rooms/qs_room1/events/more",
      "/x/rooms/qs_room1/events",
      "/rooms/a/b/events",
      "/rooms/%E0%A4%A/events", // an escape that does not decode names no room
      "/rooms//surface",
      "/rooms/qs_room1/surface/",
      "/rooms/qs_room1/Surface",
      "/x/rooms/qs_room1/surface",
      "/rooms/a/b/surface",
      "/rooms/%E0%A4%A/surface",
      "/rooms//decline",
      "/rooms/qs_room1/decline/",
      "/rooms/%E0%A4%A/decline",
    ];
    for (const path of near) {
      const res = await get(door.path, path);
      expect(res.status, path).toBe(404);
      expect(JSON.parse(res.body), path).toEqual({ error: "not_found" });
    }
    expect(src.readEvents).not.toHaveBeenCalled();
    expect(src.readRooms).not.toHaveBeenCalled();
    expect(src.readSurface).not.toHaveBeenCalled();
    expect(src.decline).not.toHaveBeenCalled();
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
    const door = await start("5.sock", source({ hasSignIn: boom, seats: boom, recent: boom, readEvents }));
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

  it("leaves one line in the bridge's log for each 500: the method, the route and why, and nothing of the room or the body", async () => {
    const lines: string[] = [];
    const door = await startDoor(
      join(root, "5.sock"),
      source({
        readEvents: vi.fn().mockRejectedValue(new Error("the upstream\n  went away")),
        decline: vi.fn().mockRejectedValue(new Error("no seat")),
        recent: () => {
          throw new Error("recent threw");
        },
      }),
      (line) => lines.push(line),
    );
    doors.push(door);
    expect((await get(door.path, "/rooms/qs_secret_room/events?after=41")).status).toBe(500);
    expect((await post(door.path, "/rooms/qs_secret_room/decline", { body: '{"ref_id":"777"}' })).status).toBe(500);
    expect((await get(door.path, "/status")).status).toBe(500);
    // What the door answers itself is no failure, and leaves nothing.
    expect((await get(door.path, "/elsewhere/qs_secret_room")).status).toBe(404);
    expect((await post(door.path, "/rooms/qs_secret_room/decline", { body: "{}" })).status).toBe(400);
    expect(lines).toEqual([
      "door: GET /rooms/<id>/events answered 500: the upstream went away",
      "door: POST /rooms/<id>/decline answered 500: no seat",
      "door: GET /status answered 500: recent threw",
    ]);
    for (const secret of ["qs_secret_room", "41", "777"]) expect(lines.join("\n")).not.toContain(secret);
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

const DECLINE = "/rooms/qs_room1/decline";
const declineWith = (socketPath: string, body: string, sent: Sent = {}) => post(socketPath, DECLINE, { body, ...sent });
const BAD_REQUEST = { error: "bad_request" };

const SEAT_STATUS = "/seats/status";

// #432: the Claude Code hooks set every seat's status through the door's second write.
describe("a seat status", () => {
  it("hands the bridge the status from a body of exactly { status }, and answers as it did", async () => {
    const setStatus = vi.fn(async () => ({ status: 200, body: { sent: 2 } }));
    const door = await start("12.sock", source({ setStatus }));
    const ok = await post(door.path, SEAT_STATUS, { body: '{"status":"idle"}' });
    expect(ok).toMatchObject({ status: 200, type: "application/json" });
    expect(JSON.parse(ok.body)).toEqual({ sent: 2 });
    expect(setStatus).toHaveBeenLastCalledWith("idle");
  });

  it("refuses any other body or type with a 400, and asks the bridge nothing", async () => {
    const setStatus = vi.fn(async () => ({ status: 200, body: { sent: 0 } }));
    const door = await start("12.sock", source({ setStatus }));
    for (const body of ['{"status":"busy"}', '{"status":"idle","note":"x"}', "{}", '"idle"', "[]", "not json", "x".repeat(2048)]) {
      expect((await post(door.path, SEAT_STATUS, { body })).status, body.slice(0, 30)).toBe(400);
    }
    expect((await post(door.path, SEAT_STATUS, { body: '{"status":"idle"}', type: "text/plain" })).status).toBe(400);
    expect((await get(door.path, SEAT_STATUS)).status).toBe(404);
    expect(setStatus).not.toHaveBeenCalled();
  });
});

describe("the rooms, the canvas and a decline", () => {
  it("serves /rooms from readRooms, with the status and body it gave", async () => {
    const rooms = { rooms: [{ session_id: "qs_room1", status: "active" }] };
    const readRooms = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, body: rooms })
      .mockResolvedValueOnce({ status: 503, body: { error: "not_connected" } });
    const door = await start("9.sock", source({ readRooms }));
    const ok = await get(door.path, "/rooms");
    expect(ok).toMatchObject({ status: 200, type: "application/json" });
    expect(JSON.parse(ok.body)).toEqual(rooms);
    const refused = await get(door.path, "/rooms");
    expect(refused).toMatchObject({ status: 503, type: "application/json" });
    expect(JSON.parse(refused.body)).toEqual({ error: "not_connected" });
    expect(readRooms).toHaveBeenCalledTimes(2);
  });

  it("serves a room's canvas from readSurface, the room decoded from the path, with the status and body it gave", async () => {
    const canvas = { session_id: "qs/a b", room: {}, surface: { cursor: 4, items: [] } };
    const readSurface = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, body: canvas })
      .mockResolvedValueOnce({ status: 404, body: { error: "not_found" } });
    const door = await start("9.sock", source({ readSurface }));
    const ok = await get(door.path, "/rooms/qs%2Fa%20b/surface");
    expect(ok).toMatchObject({ status: 200, type: "application/json" });
    expect(JSON.parse(ok.body)).toEqual(canvas);
    expect(readSurface).toHaveBeenLastCalledWith("qs/a b");
    const none = await get(door.path, "/rooms/qs_elsewhere/surface");
    expect(none.status).toBe(404);
    expect(JSON.parse(none.body)).toEqual({ error: "not_found" });
    expect(readSurface).toHaveBeenLastCalledWith("qs_elsewhere");
  });

  it("declines through the bridge: the room from the path, the ref_id from the body, the answer as it came", async () => {
    const decline = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, body: { cursor: 12 } })
      .mockResolvedValueOnce({ status: 404, body: { error: "not_found" } });
    const door = await start("10.sock", source({ decline }));
    const ok = await post(door.path, "/rooms/qs%2Fa%20b/decline", { body: '{"ref_id":"5"}' });
    expect(ok).toMatchObject({ status: 200, type: "application/json" });
    expect(JSON.parse(ok.body)).toEqual({ cursor: 12 });
    expect(decline).toHaveBeenLastCalledWith("qs/a b", "5");
    const none = await declineWith(door.path, '{"ref_id":"5"}');
    expect(none.status).toBe(404);
    expect(JSON.parse(none.body)).toEqual({ error: "not_found" });
    expect(decline).toHaveBeenCalledTimes(2);
  });

  it("takes a ref_id of one to fifteen decimal digits and refuses anything else", async () => {
    const src = source();
    const door = await start("10.sock", src);
    const refused = ["", "abc", "-1", "1.5", "1e3", " 5", "5 ", "5\n", "0x10", "\u{ff15}", "1234567890123456", "5; drop"];
    for (const ref of refused) {
      const res = await declineWith(door.path, JSON.stringify({ ref_id: ref }));
      expect(res.status, JSON.stringify(ref)).toBe(400);
      expect(JSON.parse(res.body), JSON.stringify(ref)).toEqual(BAD_REQUEST);
    }
    expect(src.decline).not.toHaveBeenCalled();
    for (const ref of ["0", "5", "007", "999999999999999"]) {
      expect((await declineWith(door.path, JSON.stringify({ ref_id: ref }))).status, ref).toBe(200);
      expect(src.decline).toHaveBeenLastCalledWith("qs_room1", ref);
    }
  });

  it("takes a body that is exactly { ref_id } and refuses every other", async () => {
    const src = source();
    const door = await start("10.sock", src);
    const refused: Array<[string, string]> = [
      ["text that is not JSON", "ref_id=5"],
      ["nothing", ""],
      ["JSON that is cut off", '{"ref_id":"5"'],
      ["a string", '"5"'],
      ["a number", "5"],
      ["null", "null"],
      ["a list", '["5"]'],
      ["an object without a ref_id", "{}"],
      ["another key beside ref_id", '{"ref_id":"5","approved":true}'],
      ["another key in place of ref_id", '{"ref":"5"}'],
      ["a number for ref_id", '{"ref_id":5}'],
      ["null for ref_id", '{"ref_id":null}'],
      ["a list for ref_id", '{"ref_id":["5"]}'],
      ["a ref_id that only a prototype holds", '{"__proto__":{"ref_id":"5"}}'],
    ];
    for (const [why, body] of refused) {
      const res = await declineWith(door.path, body);
      expect(res.status, why).toBe(400);
      expect(JSON.parse(res.body), why).toEqual(BAD_REQUEST);
    }
    expect(src.decline).not.toHaveBeenCalled();
    expect((await declineWith(door.path, ' {\n "ref_id" : "5" } ')).status).toBe(200);
    expect(src.decline).toHaveBeenCalledWith("qs_room1", "5");
  });

  it("takes a body of 1 KiB at most, however much more is sent", async () => {
    const src = source();
    const door = await start("10.sock", src);
    const padded = (bytes: number) => '{"ref_id":"5"}' + " ".repeat(bytes - 14);
    expect((await declineWith(door.path, padded(1024))).status).toBe(200);
    expect(src.decline).toHaveBeenCalledTimes(1);
    for (const bytes of [1025, 1_048_576]) {
      const res = await declineWith(door.path, padded(bytes));
      expect(res.status, `${bytes} bytes`).toBe(400);
      expect(JSON.parse(res.body), `${bytes} bytes`).toEqual(BAD_REQUEST);
    }
    expect(src.decline).toHaveBeenCalledTimes(1);
    expect((await get(door.path, "/status")).status).toBe(200);
  });

  it("takes application/json, with parameters and in any case, and no other content type", async () => {
    const src = source();
    const door = await start("10.sock", src);
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "application/jsonp", "application/json-patch+json", "multipart/form-data", "json", null]) {
      const res = await declineWith(door.path, '{"ref_id":"5"}', { type });
      expect(res.status, String(type)).toBe(400);
      expect(JSON.parse(res.body), String(type)).toEqual(BAD_REQUEST);
    }
    expect(src.decline).not.toHaveBeenCalled();
    for (const type of ["application/json", "Application/JSON", "application/json; charset=utf-8"]) {
      expect((await declineWith(door.path, '{"ref_id":"5"}', { type })).status, type).toBe(200);
    }
  });

  it("allows a POST on the decline and seat-status routes and on no other path, and no other method anywhere", async () => {
    const src = source();
    const door = await start("11.sock", src);
    const paths = ["/status", "/rooms", "/rooms/qs_room1/events", "/rooms/qs_room1/surface", "/rooms/qs_room1", "/", "/elsewhere"];
    for (const path of paths) {
      const res = await post(door.path, path, { body: '{"ref_id":"5"}' });
      expect(res.status, `POST ${path}`).toBe(405);
      expect(JSON.parse(res.body), `POST ${path}`).toEqual({ error: "method_not_allowed" });
    }
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      for (const path of [...paths, DECLINE, SEAT_STATUS]) {
        const res = await request(method, door.path, path, { body: '{"ref_id":"5"}' });
        expect(res.status, `${method} ${path}`).toBe(405);
      }
    }
    expect(src.readEvents).not.toHaveBeenCalled();
    expect(src.readRooms).not.toHaveBeenCalled();
    expect(src.readSurface).not.toHaveBeenCalled();
    expect(src.decline).not.toHaveBeenCalled();
  });

  it("answers a GET on the decline route as it answers any path it does not serve", async () => {
    const src = source();
    const door = await start("11.sock", src);
    const res = await get(door.path, DECLINE);
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "not_found" });
    expect(src.decline).not.toHaveBeenCalled();
  });

  it("answers 500 to whatever throws behind these routes, and goes on serving", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic; // JSON cannot say it
    const door = await start(
      "12.sock",
      source({
        readRooms: vi.fn().mockRejectedValue(new Error("secret detail")),
        readSurface: vi.fn().mockResolvedValue({ status: 200, body: cyclic }),
        decline: vi.fn().mockRejectedValue(new Error("secret detail")),
      }),
    );
    const thrown = [
      ["GET", "/rooms", undefined, "a room list that rejects"],
      ["GET", "/rooms/qs_room1/surface", undefined, "a canvas that will not serialize"],
      ["POST", DECLINE, { body: '{"ref_id":"5"}' }, "a decline that rejects"],
    ] as const;
    for (const [method, path, sent, why] of thrown) {
      const res = await request(method, door.path, path, sent);
      expect(res.status, why).toBe(500);
      expect(JSON.parse(res.body), why).toEqual({ error: "internal" });
    }
    expect((await get(door.path, "/status")).status).toBe(200);
  });
});

const ITEM = "/rooms/qs_room1/surface/plan";
const put = (socketPath: string, path: string, body: string, sent: Sent = {}) => request("PUT", socketPath, path, { body, ...sent });

describe("a canvas item", () => {
  it("hands the bridge a PUT's item with the path's key, and a DELETE's removal, and answers as it did", async () => {
    const writeSurface = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, body: { cursor: 14 } })
      .mockResolvedValueOnce({ status: 200, body: { cursor: 15 } })
      .mockResolvedValueOnce({ status: 404, body: { error: "not_found" } });
    const door = await start("20.sock", source({ writeSurface }));

    const written = await put(door.path, "/rooms/qs%2Fa%20b/surface/plan", '{"kind":"text","title":"Plan"}');
    expect([written.status, JSON.parse(written.body)]).toEqual([200, { cursor: 14 }]);
    expect(writeSurface).toHaveBeenLastCalledWith("qs/a b", { kind: "text", title: "Plan", key: "plan" });

    const removed = await request("DELETE", door.path, ITEM);
    expect([removed.status, JSON.parse(removed.body)]).toEqual([200, { cursor: 15 }]);
    expect(writeSurface).toHaveBeenLastCalledWith("qs_room1", { key: "plan", remove: true });

    const none = await put(door.path, ITEM, '{"key":"plan","kind":"text"}');
    expect([none.status, JSON.parse(none.body)]).toEqual([404, { error: "not_found" }]);
    expect(writeSurface).toHaveBeenLastCalledWith("qs_room1", { key: "plan", kind: "text" });
  });

  // The door's pattern repeats the server's so that the hooks bundle no zod: these are held to one grammar here.
  it("takes the keys the server takes and refuses the rest with a 400, before it asks the bridge", async () => {
    const src = source();
    const door = await start("21.sock", src);
    const keys = [
      "plan", "a", "a-b", "a_b", "a1", "z".repeat(31), "z".repeat(32), "A", "1a", "-a", "_a", "a b", "a/b", "a.b", "é",
      "constructor", "prototype", "__proto__", "plan\n",
    ];
    for (const key of keys) {
      const takes = SurfaceKeyShape.safeParse(key).success;
      for (const method of ["PUT", "DELETE"]) {
        const res = await request(method, door.path, `/rooms/qs_room1/surface/${encodeURIComponent(key)}`, { body: "{}" });
        expect(res.status, `${method} ${JSON.stringify(key)}`).toBe(takes ? 200 : 400);
        if (!takes) expect(JSON.parse(res.body)).toEqual({ error: "bad_key" });
      }
    }
    expect((await put(door.path, "/rooms/qs_room1/surface/%E0%A4%A", "{}")).status).toBe(400);
    const taken = keys.filter((key) => SurfaceKeyShape.safeParse(key).success);
    expect(taken.length).toBeGreaterThan(0);
    expect(src.writeSurface).toHaveBeenCalledTimes(taken.length * 2);
  });

  it("refuses a PUT body that is no JSON object, names another key or carries remove, and asks the bridge nothing", async () => {
    const src = source();
    const door = await start("22.sock", src);
    const bodies = ["", "not json", "[]", "null", '"plan"', "3", '{"key":"other","kind":"text"}', '{"key":"plan","remove":true}', '{"remove":false}'];
    for (const body of bodies) {
      const res = await put(door.path, ITEM, body);
      expect(res.status, body).toBe(400);
      expect(JSON.parse(res.body), body).toEqual({ error: "bad_request" });
    }
    for (const type of [null, "text/plain", "application/jsonx"]) {
      expect((await put(door.path, ITEM, '{"kind":"text"}', { type })).status, String(type)).toBe(400);
    }
    expect(src.writeSurface).not.toHaveBeenCalled();
    expect((await put(door.path, ITEM, '{"kind":"text"}', { type: "Application/JSON; charset=utf-8" })).status).toBe(200);
  });

  it("takes a body of 64 KiB at most, and answers 413 to a larger one however much is sent", async () => {
    const src = source();
    const door = await start("23.sock", src);
    const padded = (bytes: number) => {
      const head = '{"kind":"text","body":"';
      return head + "x".repeat(bytes - head.length - 2) + '"}';
    };
    expect((await put(door.path, ITEM, padded(64 * 1024))).status).toBe(200);
    for (const bytes of [64 * 1024 + 1, 1024 * 1024]) {
      const res = await put(door.path, ITEM, padded(bytes));
      expect([res.status, JSON.parse(res.body)], String(bytes)).toEqual([413, { error: "too_large" }]);
    }
    expect(src.writeSurface).toHaveBeenCalledTimes(1);
  });

  it("serves a canvas item to a PUT and a DELETE alone: a GET is a path it does not serve, a POST a 405", async () => {
    const src = source();
    const door = await start("24.sock", src);
    expect((await get(door.path, ITEM)).status).toBe(404);
    expect((await post(door.path, ITEM, { body: "{}" })).status).toBe(405);
    expect((await request("PATCH", door.path, ITEM, { body: "{}" })).status).toBe(405);
    for (const path of ["/rooms/qs_room1/surface/", "/rooms//surface/plan", "/rooms/qs_room1/surface/plan/", "/rooms/qs_room1/surface/a/b", "/rooms/%E0%A4%A/surface/plan"]) {
      const res = await put(door.path, path, "{}");
      expect(res.status, path).toBe(path.includes("%E0") ? 404 : 405);
    }
    expect(src.writeSurface).not.toHaveBeenCalled();
  });

  it("answers 500 to a canvas write that rejects, with one log line naming the route and nothing of the room or key", async () => {
    const lines: string[] = [];
    const door = await startDoor(join(root, "25.sock"), source({ writeSurface: vi.fn().mockRejectedValue(new Error("no seat")) }), (l) => lines.push(l));
    doors.push(door);
    const res = await put(door.path, "/rooms/qs_secret_room/surface/secret-key", '{"kind":"text","body":"secret body"}');
    expect([res.status, JSON.parse(res.body)]).toEqual([500, { error: "internal" }]);
    expect(lines).toEqual(["door: PUT /rooms/<id>/surface/<key> answered 500: no seat"]);
    expect((await get(door.path, "/status")).status).toBe(200);
  });
});
