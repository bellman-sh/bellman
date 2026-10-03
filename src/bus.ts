import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, unlinkSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { PeerEvent } from "./inbox.js";

/**
 * The local bus: one process per (machine, identity) holds the upstream
 * connections, and every other bridge on the machine reads from it over a Unix
 * socket (spec D7-D11).
 *
 * Every Claude Code session spawns its own bridge. Left alone, each one long-polls
 * for the members it knows, so two sessions in a room is two connections carrying
 * identical events and five is five. The bus makes the connection count follow the
 * rooms rather than the sessions: whichever bridge gets here first becomes the
 * coordinator and the rest subscribe to it.
 *
 * This module is the local half only. It knows nothing of MCP, of WebSockets or of
 * how an event reached the coordinator: the caller feeds it room events through
 * `Coordinator.ingest` and gives it `syncFrom` for the one thing it cannot do
 * itself. That is what keeps the election, the framing and the window testable
 * with nothing but sockets, and it is why this file imports no client.
 */

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

/**
 * An event as the room carries it, before it is addressed to any one member.
 * `PeerEvent.member_id` is "YOUR handle", and a room's events belong to no one
 * handle until the coordinator addresses them, once per subscriber.
 */
export type RoomEvent = Omit<PeerEvent, "member_id">;

/**
 * What `syncFrom` answers: the events after a cursor, already addressed to the
 * member that asked, and the cursor the answer covers.
 *
 * `cursor` is not redundant with the last event. bellman_sync excludes a member's
 * own events but still counts them, so an answer can be empty and have moved ("even
 * an empty events list can advance it", in its own description). Without it a
 * catch-up whose gap held only the member's own events could never tell it had
 * finished.
 */
export interface SyncResult { events: PeerEvent[]; cursor: number }

/**
 * Fetch what a member missed from the server. Injected so the bus never learns
 * what an MCP client is: the bridge hands in a closure over its own connection.
 */
export type SyncFrom = (sessionId: string, memberId: string, cursor: number) => Promise<SyncResult>;

export interface Handlers {
  /** Awaited before the next event is sent, so a slow handler is backpressure and not a queue. */
  onEvent(event: PeerEvent): void | Promise<void>;
  /**
   * The subscription ended without being asked to: the coordinator went away, or
   * a catch-up it needed failed. Nothing more will arrive for it. Subscribe again
   * from your own cursor; that is the whole recovery, and it is gapless.
   */
  onEnd?(reason: Error): void;
}

export interface Subscription { unsubscribe(): void }

export interface BusOptions {
  /** The server URL: half of what identifies a bus. */
  url: string;
  /**
   * The other half. Pass whatever stays the same for as long as the identity does,
   * not a short-lived token: a credential that rotates gives every rotation a new
   * bus path, and the old coordinator keeps serving the old one.
   */
  credential: string;
  /** Used only if this process becomes the coordinator. */
  syncFrom: SyncFrom;
  /**
   * Coordinator only. A room gained its first subscriber at `cursor`: start its
   * upstream there. The window holds the room's events contiguously from this
   * cursor, so an upstream that opens anywhere else is safe (a gap resets the
   * window) but wasteful.
   */
  onRoomOpen?(sessionId: string, cursor: number): void;
  /** Coordinator only. A room lost its last subscriber: close its upstream. */
  onRoomClose?(sessionId: string): void;
  /** Where the sockets live. Defaults to `busRoot()`. */
  root?: string;
  /** Overridable so the Windows fallback is testable on the platform running the tests. */
  platform?: NodeJS.Platform;
  /** Overrides for the window bounds (D10), which default to 500 events and 2 MB. */
  window?: { events?: number; bytes?: number };
  log?(message: string): void;
}

export interface RoomStats { floor: number; head: number; events: number; bytes: number; subscribers: number }
export interface CoordinatorStats { connections: number; rooms: Record<string, RoomStats> }

interface BusBase {
  readonly role: "coordinator" | "subscriber";
  subscribe(sessionId: string, memberId: string, cursor: number, handlers: Handlers): Subscription;
  /** Settles when this bus can no longer deliver, whatever the reason. */
  readonly closed: Promise<void>;
  /** Idempotent. A deliberate close does not call any handler's `onEnd`. */
  close(): Promise<void>;
}

/** The process that holds the upstream connections and serves everyone else. */
export interface Coordinator extends BusBase {
  readonly role: "coordinator";
  /** Feed one room event. Cheap, and never runs a handler: delivery happens afterwards. */
  ingest(event: RoomEvent): void;
  stats(): CoordinatorStats;
}

/** A process reading from someone else's coordinator. */
export interface Subscriber extends BusBase { readonly role: "subscriber" }

/** The caller gets one of these and cannot tell which beyond `role`. */
export type Bus = Coordinator | Subscriber;

export type BusUnavailableReason =
  | "platform"
  | "path-too-long"
  | "relative-root"
  | "filesystem"
  | "contended";

/**
 * The bus cannot be created here, and the caller should poll as it does today
 * (D11). Every way of not getting a bus surfaces as this, so the one catch is the
 * whole fallback decision: nothing about it is a crash.
 */
export class BusUnavailableError extends Error {
  override readonly name = "BusUnavailableError";
  constructor(readonly reason: BusUnavailableReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

// ---------------------------------------------------------------------------
// Where the bus lives
// ---------------------------------------------------------------------------

/**
 * The longest socket path, in bytes, that is safe to hand to Node.
 *
 * sun_path is 104 bytes on macOS and the BSDs and 108 on Linux, one of them the
 * terminator. The tempting failure is an error and the actual one is worse: Node
 * does not refuse a longer path, it truncates it, and the hash is the last part of
 * ours. Two identities whose paths differ only past the cut are then handed one
 * socket. That was measured, and tests/bus.test.ts carries the measurement as a
 * control, so this number is checked against the OS and not just against me.
 */
export const SUN_PATH_MAX_BYTES =
  process.platform === "darwin" || process.platform === "freebsd" || process.platform === "openbsd"
    ? 103
    : 107;

/** Beside the inbox (`~/.claude/bellman/inbox`): both are runtime state, and neither is configuration. */
export function busRoot(): string {
  return process.env.BELLMAN_BUS_ROOT ?? join(homedir(), ".claude", "bellman", "bus");
}

/**
 * The socket for one identity: a hash over the server URL and the credential, so
 * two identities on one machine never share a bus. The coordinator syncs on behalf
 * of its subscribers with its own credential (D10), which is only sound if every
 * subscriber is the same identity.
 *
 * The inputs are framed as JSON. Hashing the bare concatenation would give
 * ("a", "bc") and ("ab", "c") one digest, and so one bus.
 */
export function busPath(o: { url: string; credential: string; root?: string }): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([o.url, o.credential]))
    .digest("hex")
    .slice(0, 16);
  return join(o.root ?? busRoot(), `${digest}.sock`);
}

// ---------------------------------------------------------------------------
// Election (D8): the socket is the lock
// ---------------------------------------------------------------------------

/** Each round is one probe and at most one listen. Needing more than a few means something is wrong. */
const MAX_ROUNDS = 8;

type Probe =
  | { kind: "connected"; socket: net.Socket }
  | { kind: "absent" }
  | { kind: "stale" }
  | { kind: "blocked"; error: NodeJS.ErrnoException };

/**
 * Is anyone there? Connectability is the whole liveness test: no pid in a file, no
 * `kill(pid, 0)`, no clock, no pid reuse.
 */
function probe(path: string): Promise<Probe> {
  return new Promise((resolve) => {
    const socket = net.connect(path);
    const failed = (error: NodeJS.ErrnoException): void => {
      socket.destroy();
      // ENOENT: nothing at the path. ECONNREFUSED: a socket file nobody is
      // listening on, which is what a SIGKILLed coordinator leaves. Anything else
      // (ENOTSOCK, EACCES, ...) is a path we do not understand and must not touch.
      if (error.code === "ENOENT") resolve({ kind: "absent" });
      else if (error.code === "ECONNREFUSED") resolve({ kind: "stale" });
      else resolve({ kind: "blocked", error });
    };
    socket.once("error", failed);
    socket.once("connect", () => {
      socket.off("error", failed);
      resolve({ kind: "connected", socket });
    });
  });
}

/** Enough of a file's identity to tell it from another file that reused its name. */
interface FileId { dev: bigint; ino: bigint; ctimeNs: bigint; birthtimeNs: bigint; socket: boolean }

function identify(path: string): FileId | undefined {
  const s = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  return s && { dev: s.dev, ino: s.ino, ctimeNs: s.ctimeNs, birthtimeNs: s.birthtimeNs, socket: s.isSocket() };
}

/**
 * Inode numbers alone are not identity: a filesystem hands a freed one to the next
 * file it creates, and "unlink the stale socket, bind a fresh one" is exactly that
 * sequence. The change times are what tell the two apart.
 */
function sameFile(a: FileId, b: FileId): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.ctimeNs === b.ctimeNs && a.birthtimeNs === b.birthtimeNs;
}

/**
 * Remove the dead socket we failed to connect to, and only that file.
 *
 * "ECONNREFUSED, so unlink and listen" has a race in it. Two openers both see the
 * same dead file; one unlinks it and binds a live socket; the other, a moment
 * later, unlinks THAT, and binds its own. Both are coordinators, but the first is
 * now unreachable: it keeps serving the connections it already had and nobody can
 * ever find it. So the file about to be removed is compared with the one that was
 * tested, and a replacement means someone else is already electing: go round
 * again and connect to them.
 *
 * This narrows the window from "the whole connect-and-listen" to the two
 * synchronous calls below, and it does not close it. Nothing short of a lock can,
 * and D8 rules out a lock. What is left costs a second coordinator for one
 * identity (the collapse is partly lost until one exits) and never an event.
 */
function removeStale(path: string, tested: FileId | undefined): "removed" | "gone" | "replaced" {
  const now = identify(path);
  if (!now) return "gone"; // another opener already removed it
  if (!tested || !sameFile(tested, now)) return "replaced";
  try {
    unlinkSync(path);
    return "removed";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    throw error;
  }
}

type Listen =
  | { kind: "listening" }
  | { kind: "taken"; code: string }
  | { kind: "blocked"; error: NodeJS.ErrnoException };

/**
 * Bind. Losing is the one expected failure: another opener bound the path between
 * our probe and now, and it won.
 *
 * Losing has two spellings. EADDRINUSE is bind() noticing the path is taken. EEXIST
 * is what macOS reports to the loser of two simultaneous binds, where the kernel's
 * create lost to the other's after the existence check had passed, and Linux
 * translates that same case to EADDRINUSE. Racing eight real processes at one path
 * found it: in about a third of the trials some opener was told EEXIST and, treating
 * it as a filesystem failure, went off to poll instead of connecting to the winner.
 *
 * The socket is created 0600 by narrowing the umask around listen() rather than
 * chmod-ing afterwards, which would leave it connectable by anyone for the moment
 * between. Node binds synchronously inside listen() (the file exists the instant it
 * returns), so the narrowed umask covers exactly the bind and nothing else.
 */
function listen(server: net.Server, path: string): Promise<Listen> {
  return new Promise((resolve) => {
    const failed = (error: NodeJS.ErrnoException): void => {
      server.off("listening", bound);
      resolve(
        error.code === "EADDRINUSE" || error.code === "EEXIST"
          ? { kind: "taken", code: error.code }
          : { kind: "blocked", error }
      );
    };
    const bound = (): void => {
      server.off("error", failed);
      resolve({ kind: "listening" });
    };
    server.once("error", failed);
    server.once("listening", bound);
    const mask = process.umask(0o177);
    try {
      server.listen(path);
    } catch (error) {
      failed(error as NodeJS.ErrnoException);
    } finally {
      process.umask(mask);
    }
  });
}

const unavailable = (reason: BusUnavailableReason, message: string, cause?: unknown) =>
  new BusUnavailableError(reason, message, cause === undefined ? undefined : { cause });

/**
 * Become the coordinator, or subscribe to the one that exists.
 *
 * Try to connect: success means a coordinator is alive and we are a subscriber.
 * ENOENT or ECONNREFUSED means the path is free or stale, so remove what is there
 * and listen. EADDRINUSE means another opener won, so connect again. Whatever
 * cannot be made to work throws BusUnavailableError and the caller polls (D11).
 *
 * Everything before the first await is synchronous on purpose. Two openers called
 * in one tick then both have their first probe in flight before either result is
 * handled, which is the race this exists to survive and what the tests rely on to
 * produce it deterministically.
 */
export async function openBus(opts: BusOptions): Promise<Bus> {
  if ((opts.platform ?? process.platform) === "win32") {
    // net speaks named pipes there, but D8's election is unverified on them, and an
    // unverified mechanism belongs behind the fallback and not in front of it.
    throw unavailable("platform", "the local bus is not supported on Windows");
  }

  const root = opts.root ?? busRoot();
  if (!isAbsolute(root)) {
    throw unavailable("relative-root", `bus root ${JSON.stringify(root)} is not absolute`);
  }
  const path = busPath({ url: opts.url, credential: opts.credential, root });
  if (Buffer.byteLength(path) > SUN_PATH_MAX_BYTES) {
    throw unavailable(
      "path-too-long",
      `bus path is ${Buffer.byteLength(path)} bytes and a socket path may be at most ${SUN_PATH_MAX_BYTES}`
    );
  }

  try {
    return await elect(root, path, opts);
  } catch (error) {
    if (error instanceof BusUnavailableError) throw error;
    // Anything else is the OS refusing something we did not anticipate: an unlink
    // that EACCESes in a read-only directory, an lstat on an unsearchable one, a
    // umask that a worker thread may not change. The caller's one catch has to be
    // the whole fallback decision, so it becomes the same error, with the cause kept
    // for whoever has to work out why.
    throw unavailable("filesystem", `the bus election failed at ${path}: ${(error as Error).message}`, error);
  }
}

async function elect(root: string, path: string, opts: BusOptions): Promise<Bus> {
  const log = opts.log ?? (() => undefined);
  try {
    // 0700 on a directory we create. One we did not is left as it is: BELLMAN_BUS_ROOT
    // may point at somewhere shared, and chmod-ing that would be a far worse surprise
    // than a socket with a permissive parent.
    mkdirSync(root, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw unavailable("filesystem", `cannot create the bus directory ${root}: ${(error as Error).message}`, error);
  }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const tested = identify(path);
    const found = await probe(path);

    if (found.kind === "connected") {
      log(`bus: subscribing through ${path}`);
      return subscriberOver(found.socket);
    }
    if (found.kind === "blocked") {
      throw unavailable("filesystem", `cannot use ${path}: ${found.error.message}`, found.error);
    }
    if (found.kind === "stale") {
      const outcome = removeStale(path, tested);
      if (outcome === "replaced") continue; // someone else is already electing
      if (outcome === "removed") log(`bus: removed a stale socket at ${path}`);
    }

    // Built before listen(), so its connection handler is attached before the first
    // subscriber could possibly arrive. A server that fails to bind holds no handle
    // and no file, so losing the race leaves nothing to clean up.
    const server = net.createServer();
    const coordinator = coordinatorOver(server, path, opts);
    const bound = await listen(server, path);
    if (bound.kind === "listening") {
      log(`bus: coordinating at ${path}`);
      return coordinator;
    }
    if (bound.kind === "blocked") {
      throw unavailable("filesystem", `cannot listen at ${path}: ${bound.error.message}`, bound.error);
    }
    log(`bus: lost the race to bind ${path} (${bound.code}); connecting to the winner`);
  }
  throw unavailable("contended", `could not settle who coordinates ${path} in ${MAX_ROUNDS} rounds`);
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

function subscriberOver(socket: net.Socket): Subscriber {
  socket.on("error", () => undefined); // a close always follows; that is where it is handled
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  return {
    role: "subscriber",
    subscribe() {
      throw new Error("bus.subscribe is not implemented yet");
    },
    closed,
    async close() {
      socket.destroy();
      await closed;
    },
  };
}

function coordinatorOver(server: net.Server, _path: string, _opts: BusOptions): Coordinator {
  const connections = new Set<net.Socket>();
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => connections.delete(socket));
  });
  // After the first listen() settles its own once-handler is gone; an error on a
  // running server (EMFILE accepting, say) must not be an uncaught exception.
  server.on("error", () => undefined);

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve) => {
      for (const socket of connections) socket.destroy();
      // Closing a listening server unlinks its socket file: that is libuv's doing,
      // and it is how "a clean exit unlinks its own" (D8) holds. It unlinks by NAME,
      // which is why a coordinator that has been replaced must not be closed
      // casually: it would remove its successor's file. See removeStale.
      server.close(() => resolve());
    });
    return closing;
  };

  return {
    role: "coordinator",
    subscribe() {
      throw new Error("bus.subscribe is not implemented yet");
    },
    ingest() {
      throw new Error("bus.ingest is not implemented yet");
    },
    stats: () => ({ connections: connections.size, rooms: {} }),
    closed: new Promise<void>((resolve) => server.once("close", () => resolve())),
    close,
  };
}
