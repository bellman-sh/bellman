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
 * Two routes, GET only: `/status` and `/rooms/<session_id>/events`. The folder is 0700 and the socket 0600, which
 * is the only check there is on who may connect, as on the bus (src/bus.ts).
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

const ROOM_EVENTS = /^\/rooms\/([^/]+)\/events$/;
/** At most fifteen digits, so that the number it parses to is exact: a cursor is an event count. */
const CURSOR = /^\d{1,15}$/;

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
 * caller's to catch.
 */
async function route(src: DoorSource, method: string | undefined, target: string): Promise<Reply> {
  if (method !== "GET") return { status: 405, body: { error: "method_not_allowed" } };
  const query = target.indexOf("?");
  const path = query < 0 ? target : target.slice(0, query);
  if (path === "/status") return { status: 200, body: statusOf(src) };

  const encoded = ROOM_EVENTS.exec(path)?.[1];
  const sessionId = encoded === undefined ? undefined : decode(encoded);
  if (sessionId === undefined) return { status: 404, body: { error: "not_found" } };

  const after = new URLSearchParams(query < 0 ? "" : target.slice(query + 1)).get("after");
  if (after !== null && !CURSOR.test(after)) return { status: 400, body: { error: "bad_cursor" } };
  return src.readEvents(sessionId, after === null ? undefined : Number(after));
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
      const reply = await route(src, req.method, req.url ?? "");
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
