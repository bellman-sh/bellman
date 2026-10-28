import { existsSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Delivery } from "./bridge.js";
import {
  DOOR_SEAT_STATUSES, DOOR_VERSION, type DoorEvent, type DoorJoin, type DoorSeat, type DoorSeatStatus, type DoorStatus,
  type DoorWaiting,
} from "./door-protocol.js";
import { parentPid, pendingSummary } from "./inbox.js";

/**
 * The bridge's door: what the Claude Code mod in the same session reads off the bridge, over a Unix socket.
 *
 * The bridge holds three things the mod cannot get anywhere else: how many events wait in its inbox, a room's
 * log (the events route wants a credential, and the credential stays in the bridge), and whether it holds a sign-in.
 * The socket is named for the bridge's pid, so each bridge has a door of its own, and a session with two bridges
 * has two.
 *
 * Six routes: `GET /status`, `GET /rooms`, `GET /rooms/<session_id>/events`, `GET /rooms/<session_id>/surface`,
 * `POST /rooms/<session_id>/decline` and `POST /seats/status`. A mod's own call of a Bellman tool is refused by Claude
 * Code from its timers and presses, and a read over this socket needs no permission, so the bridge serves what the mod
 * needs through the connection it already holds: the room list, the canvas, and a refusal of an action request. The
 * two POSTs are the writes: that refusal, and a seat status the Claude Code hooks set (#432), which carries no words.
 * The folder is 0700 and the socket 0600, which is the only check there is on who may connect, as on the bus
 * (src/bus.ts): any process running as the person can decline a request or set a status through this door, as it can
 * already read the person's Bellman sign-in.
 *
 * The hooks run under Claude Code, beside the bridge and not under it, so they cannot find a socket named for the
 * bridge's pid. `doorOwnerPathFor` names a link to it for the bridge's parent, which is Claude Code, and a hook finds
 * that by walking its own parents (`findDoor`), as the Stop hook finds the inbox.
 *
 * The bridge is the session's Bellman MCP server, and the door is an aid to something else. Nothing that goes
 * wrong behind a request may take the bridge down, so a throw is answered with a 500, and an error on the running
 * server is swallowed: either would be an uncaught exception, and the bridge has no handler for one. A 500 leaves one
 * line in the bridge's log, saying which route failed and why, and nothing of the room or the request it was sent.
 */

/** The folder every door lives in, beside the inbox and the bus. */
export function doorRoot(): string {
  return process.env.BELLMAN_DOOR_ROOT ?? join(homedir(), ".claude", "bellman", "door");
}

/** The socket of the bridge with this pid. */
export function doorPathFor(pid: number, root = doorRoot()): string {
  return join(root, `${pid}.sock`);
}

/**
 * A link to the door of the bridge whose parent has this pid: the Claude Code process the bridge serves.
 * ponytail: one per Claude Code process, so of two bridges in one session the last to start holds it.
 */
export function doorOwnerPathFor(ownerPid: number, root = doorRoot()): string {
  return join(root, `owner-${ownerPid}.sock`);
}

/**
 * Point `link` at `door`, replacing whatever a process that had the owner's pid before left there. A failure is the
 * caller's to log: the hooks then find no door, and set no status.
 */
export function linkDoor(door: string, link: string): void {
  rmSync(link, { force: true });
  symlinkSync(door, link);
}

/** Remove `link` if it still points at `door`: a bridge started since in the same session may hold it now. */
export function unlinkDoor(door: string, link: string): void {
  try {
    if (readlinkSync(link) === door) rmSync(link, { force: true });
  } catch {
    // Gone already, or never made.
  }
}

/**
 * What a hook sends (#432): `status` to the door's seat-status route, waiting at most `timeoutMs`. Resolves whether the
 * door said 200, and never rejects: a hook with no door, or a door that does not answer, sets nothing and says nothing.
 * The bridge goes on sending after a hook stops waiting.
 */
export function postSeatStatus(status: DoorSeatStatus, socketPath = findDoor(), timeoutMs = 2_000): Promise<boolean> {
  if (socketPath === undefined) return Promise.resolve(false);
  const body = JSON.stringify({ status });
  return new Promise((resolve) => {
    const req = http.request(
      {
        socketPath, path: SEAT_STATUS, method: "POST", timeout: timeoutMs,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode === 200));
        res.on("error", () => resolve(false));
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end(body);
  });
}

/**
 * What the SessionStart hook reads (#435): the door's `/status`, waiting at most `timeoutMs`. Resolves undefined when
 * there is no door, it does not answer, or its answer is not JSON. Never rejects.
 */
export function readDoorStatus(socketPath: string, timeoutMs = 2_000): Promise<DoorStatus | undefined> {
  return new Promise((resolve) => {
    const req = http.request({ socketPath, path: "/status", method: "GET", timeout: timeoutMs }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => {
        try {
          resolve(res.statusCode === 200 ? (JSON.parse(text) as DoorStatus) : undefined);
        } catch {
          resolve(undefined);
        }
      });
      res.on("error", () => resolve(undefined));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(undefined));
    req.end();
  });
}

/** The door a hook should use: the owner link of the nearest ancestor that has one, walking up from `startPid`. */
export function findDoor(startPid: number = process.ppid, root = doorRoot(), maxDepth = 8): string | undefined {
  let pid: number | undefined = startPid;
  for (let depth = 0; pid !== undefined && depth < maxDepth; depth++) {
    const link = doorOwnerPathFor(pid, root);
    if (existsSync(link)) return link;
    pid = parentPid(pid);
  }
  return undefined;
}

/**
 * What a door reports and reads, handed over as functions so that each request sees the bridge as it is then.
 * `seats`, `recent` and `readEvents` are the bridge's own (see createBridge in src/bridge.ts); whoever starts the
 * door supplies the rest.
 */
export interface DoorSource {
  delivery: Delivery;
  /** Whether the bridge holds a sign-in (`DoorStatus.has_sign_in`): cached, or a key; not whether the server takes it. */
  hasSignIn(): boolean;
  seats(): DoorSeat[];
  recent(): DoorEvent[];
  /** Hook and queue delivery's inbox. Channel delivery keeps none. */
  inboxDir?: string;
  /** The bridge's own never rejects (see readEvents in src/bridge.ts). The door answers with the status and body it gives. */
  readEvents(sessionId: string, after?: number): Promise<{ status: number; body: unknown }>;
  /** The rooms the bridge holds a seat in, as `bellman_rooms` gave them. Never rejects, like `readEvents`. */
  readRooms(): Promise<{ status: number; body: unknown }>;
  /** A room's canvas, as `bellman_surface` gave it, for a room the bridge holds a seat in. Never rejects. */
  readSurface(sessionId: string): Promise<{ status: number; body: unknown }>;
  /**
   * The one write: answer the action request `refId` with a refusal, as the bridge's seat in the room, and send nothing
   * else. `refId` is a cursor the door has checked. Never rejects.
   */
  decline(sessionId: string, refId: string): Promise<{ status: number; body: unknown }>;
  /** The second write (#432): set every seat's status, sending only where it changes. Never rejects. */
  setStatus(status: DoorSeatStatus): Promise<{ status: number; body: unknown }>;
  /** Where the join from `BELLMAN_JOIN_CODE` stands (#435); undefined, or absent, when the bridge was given none. */
  join?(): DoorJoin | undefined;
}

/**
 * `GET /status`. `waiting` is the inbox's counts regrouped by room, because the inbox is keyed by member and the
 * mod draws rooms; a room's members add up. A member the bridge holds no seat for is left out: its events are
 * still queued, for the Stop hook or bellman_wait, and no room is waiting on them. Counted with `pendingSummary`,
 * which takes nothing from the inbox, so every event is still there to be drained. Channel delivery keeps no inbox.
 */
export function statusOf(src: DoorSource): DoorStatus {
  const seats = src.seats();
  const join = src.join?.();
  return {
    version: DOOR_VERSION,
    delivery: src.delivery,
    has_sign_in: src.hasSignIn(),
    seats,
    waiting: src.delivery !== "channel" && src.inboxDir ? waitingByRoom(src.inboxDir, seats) : [],
    recent: src.recent(),
    ...(join ? { join } : {}),
  };
}

function waitingByRoom(inboxDir: string, seats: DoorSeat[]): DoorWaiting[] {
  const rooms = new Map<string, DoorWaiting>();
  for (const row of pendingSummary(inboxDir)) {
    const seat = seats.find((s) => s.member_id === row.member_id);
    if (!seat) continue;
    const room = rooms.get(seat.session_id) ?? { session_id: seat.session_id, interrupting: 0, ambient: 0 };
    room.interrupting += row.interrupting;
    room.ambient += row.ambient;
    rooms.set(seat.session_id, room);
  }
  return [...rooms.values()];
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

interface Reply {
  status: number;
  body: unknown;
}

const ROOM_ROUTE = /^\/rooms\/([^/]+)\/(events|surface|decline)$/;
/** The seat-status route (#432): one path, POST only. */
const SEAT_STATUS = "/seats/status";
/** At most fifteen digits, so that the number it parses to is exact: a cursor is an event count, and a `ref_id` names one. */
const CURSOR = /^\d{1,15}$/;
/** A decline's body is `{"ref_id":"<fifteen digits>"}`: about thirty bytes. */
const DECLINE_BODY_MAX = 1024;

/**
 * The route a request named, for a log line: the room it named and anything it sent are left out, since a room's id
 * names who is in it, and a body or an unserved path is whatever the caller wrote.
 */
function shapeOf(target: string): string {
  const path = target.split("?")[0];
  const room = ROOM_ROUTE.exec(path);
  if (room !== null) return `/rooms/<id>/${room[2]}`;
  return path === "/status" || path === "/rooms" || path === SEAT_STATUS ? path : "a path it does not serve";
}

const NOT_FOUND: Reply = { status: 404, body: { error: "not_found" } };
const BAD_REQUEST: Reply = { status: 400, body: { error: "bad_request" } };

/** A path segment as text, or undefined when its escapes do not decode and it names nothing. */
function decode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/**
 * The path is matched as it came, with nothing normalised, so each route has one spelling. A throw here is the
 * caller's to catch. A POST is for the decline route alone: any other method gets a 405, whatever the path, as it
 * always did, and a GET of the decline route is a path the door does not serve.
 */
async function route(src: DoorSource, req: http.IncomingMessage): Promise<Reply> {
  const target = req.url ?? "";
  const query = target.indexOf("?");
  const path = query < 0 ? target : target.slice(0, query);
  const room = ROOM_ROUTE.exec(path);
  const sessionId = room === null ? undefined : decode(room[1]);
  const leaf = room?.[2];

  if (req.method === "POST" && leaf === "decline" && sessionId !== undefined) return decline(src, req, sessionId);
  if (req.method === "POST" && path === SEAT_STATUS) return seatStatus(src, req);
  if (req.method !== "GET") return { status: 405, body: { error: "method_not_allowed" } };
  if (path === "/status") return { status: 200, body: statusOf(src) };
  if (path === "/rooms") return src.readRooms();
  if (sessionId === undefined) return NOT_FOUND;
  if (leaf === "surface") return src.readSurface(sessionId);
  if (leaf !== "events") return NOT_FOUND;

  const after = new URLSearchParams(query < 0 ? "" : target.slice(query + 1)).get("after");
  if (after !== null && !CURSOR.test(after)) return { status: 400, body: { error: "bad_cursor" } };
  return src.readEvents(sessionId, after === null ? undefined : Number(after));
}

/**
 * `POST /rooms/<session_id>/decline`. What it takes is `application/json` and a body of at most 1 KiB that is exactly
 * `{ "ref_id": "<cursor>" }`, and everything else is a 400: this is the door's one write, and it sends nothing but
 * the refusal of that request.
 */
async function decline(src: DoorSource, req: http.IncomingMessage, sessionId: string): Promise<Reply> {
  const type = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return BAD_REQUEST;
  const body = await readBody(req, DECLINE_BODY_MAX);
  const refId = body === undefined ? undefined : refIdOf(body);
  return refId === undefined ? BAD_REQUEST : src.decline(sessionId, refId);
}

/**
 * `POST /seats/status`, the door's second write (#432): `application/json`, at most 1 KiB, exactly `{ "status": <one of
 * DOOR_SEAT_STATUSES> }`, and everything else a 400. It sends a status and nothing a peer reads as words.
 */
async function seatStatus(src: DoorSource, req: http.IncomingMessage): Promise<Reply> {
  const type = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return BAD_REQUEST;
  const body = await readBody(req, DECLINE_BODY_MAX);
  const status = body === undefined ? undefined : soleField(body, "status");
  return (DOOR_SEAT_STATUSES as readonly unknown[]).includes(status) ? src.setStatus(status as DoorSeatStatus) : BAD_REQUEST;
}

/** The value of a body that is exactly `{ "<key>": <value> }`, and undefined for any other. */
function soleField(text: string, key: string): unknown {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const keys = Object.keys(body);
  return keys.length === 1 && keys[0] === key ? (body as Record<string, unknown>)[key] : undefined;
}

/** The `ref_id` of a body that is exactly `{ "ref_id": "<cursor>" }`, and undefined for any other. */
function refIdOf(text: string): string | undefined {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const keys = Object.keys(body);
  const refId = (body as { ref_id?: unknown }).ref_id;
  return keys.length === 1 && keys[0] === "ref_id" && typeof refId === "string" && CURSOR.test(refId) ? refId : undefined;
}

/**
 * A request's body as text, or undefined when it is more than `max` bytes. It is read to its end either way and
 * nothing past `max` is kept, so that the answer can still be sent: dropping the connection on a client that is
 * mid-write would reach it as a reset, and not as a 400.
 */
function readBody(req: http.IncomingMessage, max: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= max) chunks.push(chunk);
    });
    req.on("end", () => resolve(size <= max ? Buffer.concat(chunks).toString("utf8") : undefined));
    req.on("error", reject);
  });
}

/**
 * One `end(json)` with no length of its own: Node frames a body it is given whole, counting bytes, so a peer's text
 * outside ASCII comes through entire. Nothing is written until `end`, so a body that will not serialize, or a status
 * that is not one, throws before the first byte and the 500 below can still be sent.
 */
function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(json);
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

/**
 * Open the door at `path`, which is named for this process's pid (see doorPathFor): whatever is there was left by a
 * bridge that had the pid before, and is removed. A directory is not removed: it is no leftover of ours, and this
 * rejects and leaves it. The folder is made 0700 when it has to be made; one that is
 * already there is left as it is, as `elect` leaves the bus's, because BELLMAN_DOOR_ROOT may name somewhere shared
 * and chmod-ing that would be a far worse surprise than a socket with a permissive parent.
 *
 * The socket is made 0600 by narrowing the umask around listen() and not by chmod-ing afterwards, which would leave
 * it connectable by anyone for the moment between. Node binds synchronously inside listen(), so the narrowed mask
 * covers the bind and nothing else.
 *
 * close() drops every open connection before it waits for them: a request the bridge is still answering, a log read
 * waiting on the server, must not hold up the shutdown that awaits this. Closing a server unlinks its socket (Node's
 * documentation, and src/bus.ts measured it), so nothing is left at `path`.
 *
 * `log` is the bridge's own (its stderr): each 500 is one line there.
 */
export async function startDoor(
  path: string,
  src: DoorSource,
  log: (message: string) => void = () => undefined,
): Promise<{ path: string; close(): Promise<void> }> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true });

  const server = http.createServer(async (req, res) => {
    try {
      const reply = await route(src, req);
      send(res, reply.status, reply.body);
    } catch (error) {
      // Whatever failed, the answer is this one, and the error goes no further than the bridge's own log: what the
      // bridge threw is not for a request to read.
      const why = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
      log(`door: ${req.method} ${shapeOf(req.url ?? "")} answered 500: ${why}`);
      send(res, 500, { error: "internal" });
    }
  });
  // Attached before listen() and kept after it: once the bind has settled, an error on the running server (EMFILE
  // accepting, say) must not be an uncaught exception, as it is not on the bus's.
  server.on("error", () => undefined);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    const mask = process.umask(0o177);
    try {
      server.listen(path, resolve);
    } finally {
      process.umask(mask);
    }
  });

  return {
    path,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
