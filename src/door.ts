import { mkdirSync, rmSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Delivery } from "./bridge.js";
import { DOOR_VERSION, type DoorEvent, type DoorSeat, type DoorStatus, type DoorWaiting } from "./door-protocol.js";
import { pendingSummary } from "./inbox.js";

/**
 * The bridge's door: what the Claude Code mod in the same session reads off the bridge, over a Unix socket.
 *
 * The bridge holds three things the mod cannot get anywhere else: how many events wait in its inbox, a room's
 * log (the events route wants a credential, and the credential stays in the bridge), and whether it is signed in.
 * The socket is named for the bridge's pid, so each bridge has a door of its own, and a session with two bridges
 * has two.
 *
 * Five routes: `GET /status`, `GET /rooms`, `GET /rooms/<session_id>/events`, `GET /rooms/<session_id>/surface` and
 * `POST /rooms/<session_id>/decline`. A mod's own call of a Bellman tool is refused by Claude Code from its timers and
 * presses, and a read over this socket needs no permission, so the bridge serves what the mod needs through the
 * connection it already holds: the room list, the canvas, and a refusal of an action request. That refusal is the one
 * thing here that writes, and it is the only POST. The folder is 0700 and the socket 0600, which is the only check
 * there is on who may connect, as on the bus (src/bus.ts): any process running as the person can decline a request
 * through this door, as it can already read the person's Bellman sign-in.
 *
 * The bridge is the session's Bellman MCP server, and the door is an aid to something else. Nothing that goes
 * wrong behind a request may take the bridge down, so a throw is answered with a 500, and an error on the running
 * server is swallowed: either would be an uncaught exception, and the bridge has no handler for one.
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
 * What a door reports and reads, handed over as functions so that each request sees the bridge as it is then.
 * `seats`, `recent` and `readEvents` are the bridge's own (see createBridge in src/bridge.ts); whoever starts the
 * door supplies the rest.
 */
export interface DoorSource {
  delivery: Delivery;
  signedIn(): boolean;
  seats(): DoorSeat[];
  recent(): DoorEvent[];
  /** Hook delivery's inbox. Channel delivery keeps none. */
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
}

/**
 * `GET /status`. `waiting` is the inbox's counts regrouped by room, because the inbox is keyed by member and the
 * mod draws rooms; a room's members add up. A member the bridge holds no seat for is left out: its events are
 * still queued for the Stop hook, and no room is waiting on them. Counted with `pendingSummary`, which takes
 * nothing from the inbox, so every event is still there for that hook to drain. Channel delivery keeps no inbox.
 */
export function statusOf(src: DoorSource): DoorStatus {
  const seats = src.seats();
  return {
    version: DOOR_VERSION,
    delivery: src.delivery,
    signed_in: src.signedIn(),
    seats,
    waiting: src.delivery === "hook" && src.inboxDir ? waitingByRoom(src.inboxDir, seats) : [],
    recent: src.recent(),
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
/** At most fifteen digits, so that the number it parses to is exact: a cursor is an event count, and a `ref_id` names one. */
const CURSOR = /^\d{1,15}$/;
/** A decline's body is `{"ref_id":"<fifteen digits>"}`: about thirty bytes. */
const DECLINE_BODY_MAX = 1024;

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
 */
export async function startDoor(path: string, src: DoorSource): Promise<{ path: string; close(): Promise<void> }> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true });

  const server = http.createServer(async (req, res) => {
    try {
      const reply = await route(src, req);
      send(res, reply.status, reply.body);
    } catch {
      // Whatever failed, the answer is this one, and the error goes no further than this catch: what the bridge
      // threw is not for a request to read.
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
