import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
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
 * for the members it knows, so N bridges watching one room are N connections
 * carrying the same events. The bus makes the connection count follow the rooms
 * rather than the sessions: whichever bridge gets here first becomes the
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
  /**
   * Awaited before the next event is handed over, so a slow handler is backpressure and
   * not a queue. The event is this handler's own copy: changing it changes nothing for
   * anyone else.
   */
  onEvent(event: PeerEvent): void | Promise<void>;
  /**
   * The subscription ended without being asked to: the coordinator went away, or
   * a catch-up it needed failed. Nothing more will arrive for it. Subscribe again
   * from your own cursor; that is the whole recovery, and it is gapless.
   *
   * One reason is different: a `BusUnavailableError` with reason `"unresponsive"` means
   * the coordinator is there and is not answering (a stopped process still accepts
   * connections). Subscribing again through the same bus would only wait again, so fall
   * back to polling for that member (D11) and try the bus later.
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
  /**
   * Subscriber only. How long to wait for the coordinator to acknowledge a subscribe
   * before treating the bus as unavailable. Defaults to `DEFAULT_ACK_TIMEOUT_MS`.
   *
   * A handler on this connection that holds the line for longer than this delays the
   * acknowledgement too, because lines are read one at a time, and trips it.
   */
  ackTimeoutMs?: number;
  /** Where the sockets live. Defaults to `busRoot()`. */
  root?: string;
  /** Overridable so the Windows fallback is testable on the platform running the tests. */
  platform?: NodeJS.Platform;
  /** Overrides for the window bounds (D10), which default to 500 events and 2 MB. */
  window?: { events?: number; bytes?: number };
  log?(message: string): void;
}

export interface RoomStats { floor: number; head: number; events: number; bytes: number; subscribers: number }
/** `connections` counts other processes connected to this one: this process's own subscriptions are not connections. */
export interface CoordinatorStats { connections: number; rooms: Record<string, RoomStats> }

interface BusBase {
  readonly role: "coordinator" | "subscriber";
  /**
   * Deliver every event after `cursor` for this member, in order and without gaps.
   *
   * Subscribing again for a member on the same bus replaces its earlier subscription,
   * silently. Over a socket that has one seam: events already in flight for the old
   * subscription can reach the new handler, and the new subscription then replays from
   * its own cursor, so a replacement can see an event twice. The bus promises no gaps,
   * and no repeats within one subscription; the caller's own per-event guard (the
   * bridge's `delivered`) is what covers a replacement.
   */
  subscribe(sessionId: string, memberId: string, cursor: number, handlers: Handlers): Subscription;
  /** Settles when this bus can no longer deliver, whatever the reason. */
  readonly closed: Promise<void>;
  /** Idempotent. A deliberate close does not call any handler's `onEnd`. */
  close(): Promise<void>;
}

/** The process that holds the upstream connections and serves everyone else. */
export interface Coordinator extends BusBase {
  readonly role: "coordinator";
  /**
   * Feed one room event. Cheap, and never runs a handler: delivery happens afterwards.
   * The window keeps the object it is handed, so do not change it after this call.
   */
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
  | "contended"
  | "unresponsive";

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
 * How long a subscriber waits for the coordinator to acknowledge a subscribe: 10 seconds.
 *
 * A coordinator that is working answers in well under a millisecond (it registers the
 * subscription and writes one line). The bound exists for the one that is not: a process
 * that is stopped, or wedged, still has its socket and still accepts the connection (measured
 * with SIGSTOP), so connecting cannot tell it from a live one, and a subscriber would wait for
 * ever, silently, while D11's fallback never fired. The election cannot find that out; a
 * timeout on a request the subscriber is making anyway can, and says nothing about who owns
 * the socket.
 *
 * It errs long on purpose. A machine that is loaded, swapping or paused by a debugger can stall
 * a healthy process for seconds, and a false alarm costs only that bridge its share of the
 * collapse, since polling is what it did before the bus. 10 seconds is also well under the
 * 25 second poll wait, so a bridge that gives up is back to being served soon after.
 *
 * What it covers: a coordinator that does not answer a subscribe. A coordinator that stops
 * after answering, while its subscribers sit idle, is not noticed until the next subscribe.
 */
export const DEFAULT_ACK_TIMEOUT_MS = 10_000;

/**
 * The longest socket path, in bytes, that is safe to hand to Node.
 *
 * sun_path is 104 bytes on macOS and the BSDs and 108 on Linux, one of them the
 * terminator. The tempting failure is an error, and what Node does depends on its
 * version. Node 22.16 on macOS does not refuse a longer path, it truncates it
 * (measured), and the hash is the last part of ours, so two identities whose paths
 * differ only past the cut are handed one socket. Node 25.8 on the same machine
 * refuses it with EINVAL (measured), and current Node documentation says it throws.
 * This guard sits in front of both: a path that is too long never reaches Node.
 * tests/bus.test.ts carries the measurement as a control, so on whatever platform and
 * Node the tests run this number is checked against what that Node does and not just
 * against me. Only macOS has been run, on those two versions: the Linux figure is the
 * documented one.
 *
 * Platforms known to share Linux's limit get 107; anything else gets the smaller BSD
 * figure, because a limit too small costs a fallback to polling and one too large
 * costs the separation between identities.
 */
export const SUN_PATH_MAX_BYTES =
  process.platform === "linux" || process.platform === "android" ||
  process.platform === "sunos" || process.platform === "aix"
    ? 107
    : 103;

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
 * Is anyone there? Connectability is the whole test of who owns the socket: no pid in a
 * file, no `kill(pid, 0)`, no clock, no pid reuse. It tells a dead coordinator from a live
 * one and nothing more: a coordinator that is stopped and not dead still accepts the
 * connection and then serves nothing (measured with SIGSTOP). The election cannot see
 * that; the subscriber's timeout on its own subscribe can (DEFAULT_ACK_TIMEOUT_MS).
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
 * Inode numbers alone are not identity on a filesystem that reuses them: ext4 hands a
 * freed one to the next file it creates, and "unlink the stale socket, bind a fresh
 * one" is exactly that sequence. The change times are what tell the two apart there.
 * Not exercised: this machine's filesystem never reused one (strictly increasing over
 * 200 create-and-unlink cycles), so no test here can tell this comparison from
 * comparing the inode alone.
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
 * identity (the collapse is partly lost until one exits) and never an event. It does
 * happen: eight real processes racing at one stale path, on macOS, elected two
 * coordinators in 1 of 160 trials, and in none of 80 at an empty one.
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

/** What a coordinator knows about the file it bound, filled in once the bind has succeeded. */
interface Claim { file?: FileId }

/**
 * Closing a listening server unlinks its path by NAME. libuv does it, synchronously,
 * inside close() (measured on Node 22.16 and 25.8; Node's documentation says
 * server.close() unlinks the socket). If the file at that name is no longer the one this
 * server bound, because it was removed and another process has since bound the name,
 * the unlink deletes THAT process's socket on the way out, and the next opener finds a
 * vacancy where a live coordinator was. That turned a rare double election into an
 * outage caused by cleanup, in the process that had already lost.
 *
 * This is an identity check on our own file, not a lock: the bind's own file is recorded
 * and, on the way out, compared with what is at the path now. If it is ours, or gone,
 * libuv's unlink is exactly right. If it is not, the file is theirs and we have no
 * business removing it: move it aside for the length of close(), and the caller puts it
 * back. Both renames, and the close between them, happen in one synchronous turn, so no
 * event-loop turn runs while the name is empty. It is empty for the microseconds between
 * the renames, and an opener probing in exactly that gap sees ENOENT and elects: the same
 * class of residual as removeStale's, and far narrower than deleting a successor outright.
 *
 * Returns the function that puts the file back; it does nothing when nothing was moved.
 */
function shieldSuccessor(path: string, own: FileId | undefined, log: (message: string) => void): () => void {
  const nothing = (): void => undefined;
  let now: FileId | undefined;
  try {
    now = identify(path);
  } catch {
    return nothing;
  }
  if (!now || !own || sameFile(own, now)) return nothing;
  const aside = `${path}.kept-${process.pid}`;
  try {
    renameSync(path, aside);
  } catch {
    return nothing; // whatever stopped this stops libuv's unlink the same way
  }
  return () => {
    try {
      renameSync(aside, path);
    } catch (error) {
      log(`bus: could not put ${path} back after closing: ${messageOf(error)}; it is at ${aside}`);
    }
  };
}

type Listen =
  /** `file` is what the bind created, read back the moment it returned: see shieldSuccessor. */
  | { kind: "listening"; file: FileId | undefined }
  | { kind: "taken"; code: string }
  | { kind: "blocked"; error: NodeJS.ErrnoException };

/**
 * Bind. Losing is the one expected failure: another opener bound the path between
 * our probe and now, and it won.
 *
 * Losing has two spellings. EADDRINUSE is bind() noticing the path is taken. EEXIST
 * is what macOS reports to the loser of two simultaneous binds, where the kernel's
 * create lost to the other's after the existence check had passed. (Linux's kernel
 * source translates that same case to EADDRINUSE; that half was not run here.) Racing
 * eight real processes at one path found it: at an empty one, 31 of 40 trials had an
 * opener told EEXIST who, treating it as a filesystem failure, went off to poll
 * instead of connecting to the winner (14 of 40 at a stale one).
 *
 * The socket is created 0600 by narrowing the umask around listen() rather than
 * chmod-ing afterwards, which would leave it connectable by anyone for the moment
 * between. Node binds synchronously inside listen() (the file exists the instant it
 * returns), so the narrowed umask covers exactly the bind and nothing else.
 */
function listen(server: net.Server, path: string): Promise<Listen> {
  return new Promise((resolve) => {
    let file: FileId | undefined;
    const failed = (error: NodeJS.ErrnoException): void => {
      server.off("listening", bound);
      // D8 names EADDRINUSE. macOS reports EEXIST instead to the loser of two simultaneous
      // binds: handling only the spec's code failed 31 of 40 real races at an empty path, with
      // the loser going off to poll instead of connecting to the winner. Linux is documented
      // to report EADDRINUSE for it and that was not measured here. Either code means the same
      // thing: someone else bound first.
      resolve(
        error.code === "EADDRINUSE" || error.code === "EEXIST"
          ? { kind: "taken", code: error.code }
          : { kind: "blocked", error }
      );
    };
    const bound = (): void => {
      server.off("error", failed);
      resolve({ kind: "listening", file });
    };
    server.once("error", failed);
    server.once("listening", bound);
    const mask = process.umask(0o177);
    try {
      server.listen(path);
    } catch (error) {
      failed(error as NodeJS.ErrnoException);
      return;
    } finally {
      process.umask(mask);
    }
    // The bind has happened by now, so what is at the path is the socket this call just
    // made. Read it back here, in the same turn: it is what close() must recognise later.
    try {
      file = identify(path);
    } catch {
      // Without it close() treats the file as its own, which is what it did before this.
    }
  });
}

const unavailable = (reason: BusUnavailableReason, message: string, cause?: unknown) =>
  new BusUnavailableError(reason, message, cause === undefined ? undefined : { cause });

/** Whatever was thrown, as text: user code is free to throw a string, and `.message` of one is undefined. */
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** An owner's onEnd is its code: a throw in it has to reach the log and not the process. */
function callEnd(log: (message: string) => void, handlers: Handlers, reason: Error): void {
  try {
    handlers.onEnd?.(reason);
  } catch (error) {
    log(`bus: onEnd threw: ${messageOf(error)}`);
  }
}

/**
 * Become the coordinator, or subscribe to the one that exists.
 *
 * Try to connect: success means a coordinator is alive and we are a subscriber.
 * ENOENT means the path is free and ECONNREFUSED that it is stale, so remove what is
 * there and listen. A lost bind (EADDRINUSE, or EEXIST on macOS) means another opener
 * won, so connect again. Whatever cannot be made to work throws BusUnavailableError
 * and the caller polls (D11).
 *
 * Everything up to the first await runs synchronously on purpose. Two openers called
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
  try {
    return await elect(opts);
  } catch (error) {
    if (error instanceof BusUnavailableError) throw error;
    // Anything else is the OS refusing something we did not anticipate: a home
    // directory that cannot be found, an unlink that EACCESes in a read-only directory,
    // an lstat on an unsearchable one, a umask that a worker thread may not change. The
    // caller's one catch has to be the whole fallback decision, so it becomes the same
    // error, with the cause kept for whoever has to work out why.
    throw unavailable("filesystem", `the bus could not be opened: ${messageOf(error)}`, error);
  }
}

async function elect(opts: BusOptions): Promise<Bus> {
  const log = opts.log ?? (() => undefined);

  const root = opts.root ?? busRoot();
  if (!isAbsolute(root)) {
    throw unavailable("relative-root", `bus root ${JSON.stringify(root)} is not absolute`);
  }
  const path = busPath({ url: opts.url, credential: opts.credential, root });
  // A correctness boundary, not tidiness. Node 22.16 silently truncates a socket path past the
  // OS limit, and the hash is the END of ours, so two identities whose hashes differ only past
  // the cut would share one bus: exactly what hashing the credential is there to prevent. Node
  // 25.8 refuses such a path (EINVAL) instead. Both were measured on macOS. Linux is unmeasured
  // and its limit here is the documented one: see SUN_PATH_MAX_BYTES.
  if (Buffer.byteLength(path) > SUN_PATH_MAX_BYTES) {
    throw unavailable(
      "path-too-long",
      `bus path is ${Buffer.byteLength(path)} bytes and a socket path may be at most ${SUN_PATH_MAX_BYTES}`
    );
  }

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
      const bound = Number.isFinite(opts.ackTimeoutMs) && (opts.ackTimeoutMs as number) > 0
        ? (opts.ackTimeoutMs as number)
        : DEFAULT_ACK_TIMEOUT_MS;
      return subscriberOver(found.socket, log, bound);
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
    // subscriber could possibly arrive. A server that fails to bind holds no file, and
    // no handle once it has settled (five failed binds left only the winner's), so
    // losing the race leaves nothing to clean up.
    const server = net.createServer();
    const claim: Claim = {};
    const coordinator = coordinatorOver(server, path, opts, claim);
    const bound = await listen(server, path);
    if (bound.kind === "listening") {
      claim.file = bound.file;
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
// The window (D10)
// ---------------------------------------------------------------------------

/** Per room: 500 events or 2 MB, whichever is reached first. */
export const WINDOW_MAX_EVENTS = 500;
export const WINDOW_MAX_BYTES = 2 * 1024 * 1024;

/**
 * One room's recent events, so that a subscriber a little behind is served from
 * memory and one a long way behind is served by the server.
 *
 * It is a CONTIGUOUS run: every event above `floor`, up to `head`, is held, and
 * nothing below `floor` is. That makes "is the next event I owe this subscriber
 * here?" one comparison (`cursor >= floor`) and not a search, and it is why a gap
 * in what the upstream delivers resets the window instead of being left in it. A
 * hole looks exactly like events that were never sent, so a subscriber walking
 * across one would skip them without knowing.
 *
 * Bounded twice, because `MAX_PAYLOAD_CHARS` is 20,000 (src/server.ts) and 500 of
 * those is a 10 MB worst case per room, per coordinator. Bytes are measured as the
 * event serializes, in UTF-8 bytes, not as a character count.
 */
export class RoomWindow {
  #floor: number;
  #head: number;
  #held: Array<{ event: RoomEvent; bytes: number }> = [];
  #bytes = 0;

  /** `start` is the cursor the window begins at: the first event it can hold is `start + 1`. */
  constructor(
    start: number,
    private readonly maxEvents = WINDOW_MAX_EVENTS,
    private readonly maxBytes = WINDOW_MAX_BYTES
  ) {
    this.#floor = start;
    this.#head = start;
  }

  /** Everything above this is held. Anything at or below it must come from the server. */
  get floor(): number { return this.#floor; }
  /** The newest cursor seen. */
  get head(): number { return this.#head; }

  stats(): { floor: number; head: number; events: number; bytes: number } {
    return { floor: this.#floor, head: this.#head, events: this.#held.length, bytes: this.#bytes };
  }

  push(event: RoomEvent): void {
    if (event.cursor <= this.#head) return; // a repeat, or older than anything held
    if (event.cursor !== this.#head + 1) {
      // The upstream skipped something. What lay in the hole is unknown, so nothing
      // before it can be called contiguous with what follows.
      this.#held = [];
      this.#bytes = 0;
      this.#floor = event.cursor - 1;
    }
    const bytes = Buffer.byteLength(JSON.stringify(event));
    this.#held.push({ event, bytes });
    this.#bytes += bytes;
    this.#head = event.cursor;
    // `held.length > 0` is what stops this being an endless loop on a budget smaller
    // than one event: it drops the event it was just given and the window is empty.
    while (this.#held.length > 0 && (this.#held.length > this.maxEvents || this.#bytes > this.maxBytes)) {
      const dropped = this.#held.shift()!;
      this.#bytes -= dropped.bytes;
      this.#floor = dropped.event.cursor;
    }
  }

  /**
   * The first held event after `after`, or undefined when there is none. A cursor
   * below the floor also answers undefined, which is a miss and not "nothing new":
   * callers compare with `floor` first.
   */
  next(after: number): RoomEvent | undefined {
    if (after < this.#floor) return undefined;
    return this.#held[after - this.#floor]?.event; // contiguous, so the index is the distance
  }
}

// ---------------------------------------------------------------------------
// The wire: NDJSON, one object per line
// ---------------------------------------------------------------------------
//
// Subscriber to coordinator:
//   {"op":"subscribe",   "session_id", "member_id", "cursor"}
//   {"op":"unsubscribe", "session_id", "member_id"}
// Coordinator to subscriber, for one subscription:
//   {"op":"subscribed", "session_id", "member_id"}   once, and first, for each subscribe
//   a raw PeerEvent, addressed to the subscribing member, for each event
//   {"op":"end", "session_id", "member_id", "reason"} when that subscription cannot go on

/**
 * A request is a few hundred bytes. An event line is its payload, which the server
 * caps at 20,000 characters once serialized (MAX_PAYLOAD_CHARS, escapes included, so
 * at most about 80 KB in UTF-8), plus a label and a handful of fields. A megabyte with
 * no newline in it is a peer that is not speaking this protocol.
 */
const MAX_LINE_CHARS = 1024 * 1024;

/**
 * Split a socket into lines and hand each to `onLine`, which finishes before the
 * next line is read. The socket is paused meanwhile, so a handler that takes a
 * while is backpressure on whoever is sending and not a queue in this process: what
 * is held here is one read's worth of lines and the start of a line that has not
 * ended yet, never a backlog. Anything `onLine` throws, and a line that never ends,
 * go to `onBad`.
 */
function readLines(
  socket: net.Socket,
  onLine: (line: string) => void | Promise<void>,
  onBad: (why: string) => void
): void {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", async (chunk: string) => {
    socket.pause();
    buffer += chunk;
    try {
      for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line.length > 0) await onLine(line);
        if (socket.destroyed) return;
      }
    } catch (error) {
      onBad((error as Error).message);
      return;
    }
    if (buffer.length > MAX_LINE_CHARS) {
      onBad("a line longer than a megabyte");
      return;
    }
    socket.resume();
  });
}

/**
 * Write one object and its newline. When the socket's buffer is full this waits for
 * `drain`, and that wait is the whole of the backpressure: a reader that cannot keep
 * up holds its own sender's loop and nobody else's, and grows nobody's memory.
 */
function writeLine(socket: net.Socket, value: unknown): Promise<void> {
  if (socket.destroyed || !socket.writable) return Promise.reject(new Error("connection closed"));
  if (socket.write(JSON.stringify(value) + "\n")) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const settle = (error?: Error): void => {
      socket.off("drain", onDrain);
      socket.off("close", onClose);
      socket.off("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onDrain = (): void => settle();
    const onClose = (): void => settle(new Error("connection closed"));
    const onError = (error: Error): void => settle(error);
    socket.once("drain", onDrain);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

type Request =
  | { op: "subscribe"; sessionId: string; memberId: string; cursor: number }
  | { op: "unsubscribe"; sessionId: string; memberId: string };

/** The same rules for an API call and for a line off the wire: there is one idea of a valid subscription. */
function checkSubscription(sessionId: unknown, memberId: unknown, cursor: unknown): void {
  if (typeof sessionId !== "string" || sessionId === "") throw new TypeError("session id must be a non-empty string");
  if (typeof memberId !== "string" || memberId === "") throw new TypeError("member id must be a non-empty string");
  if (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0) {
    throw new RangeError(`cursor must be a non-negative integer, got ${String(cursor)}`);
  }
}

/** Throws on anything that is not exactly a request; the caller drops the connection. */
function parseRequest(line: string): Request {
  const raw: unknown = JSON.parse(line);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("a request is a JSON object");
  const r = raw as Record<string, unknown>;
  if (r.op !== "subscribe" && r.op !== "unsubscribe") throw new Error(`unknown operation ${JSON.stringify(r.op)}`);
  checkSubscription(r.session_id, r.member_id, r.op === "subscribe" ? r.cursor : 0);
  return r.op === "subscribe"
    ? { op: "subscribe", sessionId: r.session_id as string, memberId: r.member_id as string, cursor: r.cursor as number }
    : { op: "unsubscribe", sessionId: r.session_id as string, memberId: r.member_id as string };
}

/**
 * JSON, not a delimiter: ids come off the wire and a delimiter an id can contain
 * would let two different subscriptions share a key.
 */
const subKey = (sessionId: string, memberId: string): string => JSON.stringify([sessionId, memberId]);

/** The three fields the bus itself reads. Everything else in an event is the peer's and is not its business. */
function isPeerEvent(x: unknown): x is PeerEvent {
  if (typeof x !== "object" || x === null) return false;
  const e = x as Record<string, unknown>;
  return typeof e.session_id === "string" && typeof e.member_id === "string" && Number.isSafeInteger(e.cursor);
}

// ---------------------------------------------------------------------------
// The coordinator
// ---------------------------------------------------------------------------

/** A connection, or this process standing in for one: what a subscription belongs to. */
interface Conn {
  subs: Map<string, Sub>;
  socket?: net.Socket;
}

interface Room {
  id: string;
  window: RoomWindow;
  subs: Set<Sub>;
}

/**
 * One member's subscription to one room. It owns no events: the window is the queue
 * and `sentThrough` is the read position in it, so a subscriber that stops reading
 * costs the coordinator one cursor and not a growing buffer.
 */
interface Sub {
  readonly conn: Conn;
  readonly room: Room;
  readonly sessionId: string;
  readonly memberId: string;
  /**
   * The one guard (D9). Nothing at or below it is ever sent, whether it came from
   * the window, from a catch-up or from the live stream, so the subscriber never
   * buffers, never dedupes against a second source and cannot tell which one an
   * event came from.
   */
  sentThrough: number;
  /** A pump is running, or has been scheduled. Cleared in the same turn that finds nothing left to send. */
  pumping: boolean;
  ended: boolean;
  send(event: PeerEvent): void | Promise<void>;
  end(reason: Error): void;
}

function coordinatorOver(server: net.Server, path: string, opts: BusOptions, claim: Claim): Coordinator {
  const log = opts.log ?? (() => undefined);
  const rooms = new Map<string, Room>();
  const remotes = new Set<Conn>();
  /** This process's own subscriptions: the same machinery as a remote one, minus the socket. */
  const local: Conn = { subs: new Map() };
  let closed = false;

  /** A hook is the caller's code, and a throw in it must not leave the registry half-updated. */
  const hook = (name: string, call: () => void): void => {
    try {
      call();
    } catch (error) {
      log(`bus: ${name} threw: ${messageOf(error)}`);
    }
  };

  /** Voluntary: the owner asked, or its connection is gone. Nobody is told. */
  function dropSub(sub: Sub): void {
    if (sub.ended) return;
    sub.ended = true;
    const key = subKey(sub.sessionId, sub.memberId);
    if (sub.conn.subs.get(key) === sub) sub.conn.subs.delete(key);
    const { room } = sub;
    room.subs.delete(sub);
    if (room.subs.size === 0 && rooms.get(room.id) === room) {
      rooms.delete(room.id);
      hook("onRoomClose", () => opts.onRoomClose?.(room.id));
    }
  }

  /** Involuntary: this subscription cannot go on, and its owner is told why. */
  function endSub(sub: Sub, reason: Error): void {
    if (sub.ended) return;
    dropSub(sub);
    try {
      sub.end(reason);
    } catch (error) {
      log(`bus: onEnd for ${sub.memberId} threw: ${messageOf(error)}`);
    }
  }

  function addSub(
    conn: Conn,
    sessionId: string,
    memberId: string,
    cursor: number,
    send: Sub["send"],
    end: Sub["end"]
  ): Sub {
    let room = rooms.get(sessionId);
    const opening = room === undefined;
    if (!room) {
      room = { id: sessionId, window: new RoomWindow(cursor, opts.window?.events, opts.window?.bytes), subs: new Set() };
      rooms.set(sessionId, room);
    }
    const key = subKey(sessionId, memberId);
    const prior = conn.subs.get(key);
    const sub: Sub = { conn, room, sessionId, memberId, sentThrough: cursor, pumping: false, ended: false, send, end };
    room.subs.add(sub);
    conn.subs.set(key, sub);
    // The replacement is in before the original goes, so a re-subscribe never empties
    // the room and its upstream does not close and reopen for nothing.
    if (prior) dropSub(prior);
    if (opening) hook("onRoomOpen", () => opts.onRoomOpen?.(sessionId, cursor));
    kick(sub);
    return sub;
  }

  /**
   * Make sure a pump will run. It is deferred, never run here, so that `ingest` never
   * runs a handler and no handler can run before `subscribe` has returned the
   * subscription it belongs to.
   */
  function kick(sub: Sub): void {
    if (sub.pumping || sub.ended) return;
    sub.pumping = true;
    queueMicrotask(() => void pump(sub));
  }

  /**
   * Send one subscription everything it is owed, in order, and then stop until kicked.
   *
   * Each subscription has its own pump, so one that is slow (a catch-up waiting on the
   * server, a consumer that is not reading) stalls itself and no other.
   *
   * The loop is the read and the idle decision in one turn: it finds nothing left to
   * send and clears `pumping` without an await in between. That is CLAUDE.md's rule for
   * `waitForEvents`, for the same reason. An `ingest` landing in a gap between the two
   * would see `pumping` still set, schedule nothing, and the event would sit in the
   * window until the next one happened to come.
   */
  async function pump(sub: Sub): Promise<void> {
    try {
      for (;;) {
        if (sub.ended) return;
        const { window } = sub.room;
        if (sub.sentThrough < window.floor) {
          // A miss: what this member needs next is no longer in the window, or never
          // was. It is the same test whether the subscriber arrived late or fell behind
          // while the window moved on.
          await catchUp(sub);
          continue;
        }
        const next = window.next(sub.sentThrough);
        if (!next) return;
        await offer(sub, next);
      }
    } catch (error) {
      endSub(sub, error as Error);
    } finally {
      sub.pumping = false;
    }
  }

  /**
   * Hand one event to one subscription, or not. This is the whole of D9's guard, and
   * the window, a catch-up and the live stream all go through it.
   *
   * A member never hears itself (bellman_sync leaves a member's own events out, and a
   * room socket does not), but the cursor still moves past it.
   */
  async function offer(sub: Sub, event: RoomEvent | PeerEvent): Promise<void> {
    // A cursor that is not an integer would make `sentThrough` NaN, every comparison
    // against it false, and the subscription silently stuck: refuse it with the repeats.
    if (!Number.isSafeInteger(event.cursor) || event.cursor <= sub.sentThrough) return;
    sub.sentThrough = event.cursor;
    if (event.from_member_id === sub.memberId) return;
    try {
      await sub.send({ ...event, member_id: sub.memberId });
    } catch (error) {
      // One bad delivery must not wedge the stream behind it: the handler has had its
      // event, and a retry would hand it the same one again.
      if (!sub.ended) log(`bus: delivering ${event.cursor} to ${sub.memberId} failed: ${messageOf(error)}`);
    }
  }

  /**
   * Ask the server for what a member missed, and stream the answer ahead of the window.
   *
   * It can take more than one question. The answer is current when the server gives it
   * and old when it arrives, and the window keeps moving in between: if it has rolled
   * past the end of the answer, the events in the gap are in neither place. So the pump
   * asks again from where the answer ended, and each answer has to move the guard or
   * the subscription ends, so a server that answers with nothing cannot make this loop
   * for ever.
   */
  async function catchUp(sub: Sub): Promise<void> {
    const from = sub.sentThrough;
    let answer: SyncResult;
    try {
      answer = await opts.syncFrom(sub.sessionId, sub.memberId, from);
    } catch (error) {
      throw new Error(`catching ${sub.memberId} up from cursor ${from} failed: ${messageOf(error)}`, { cause: error });
    }
    for (const event of answer.events) {
      if (sub.ended) return;
      await offer(sub, event);
    }
    if (sub.ended) return;
    // The cursor the answer covers, which can be past its last event: the member's own
    // events are counted and not returned.
    if (Number.isSafeInteger(answer.cursor)) sub.sentThrough = Math.max(sub.sentThrough, answer.cursor);
    if (sub.sentThrough === from) throw new Error(`syncFrom made no progress past cursor ${from}`);
  }

  function accept(socket: net.Socket): void {
    const conn: Conn = { subs: new Map(), socket };
    remotes.add(conn);
    socket.on("error", () => undefined); // a close always follows
    socket.once("close", () => {
      remotes.delete(conn);
      for (const sub of [...conn.subs.values()]) dropSub(sub);
    });
    readLines(
      socket,
      (line) => {
        const request = parseRequest(line);
        if (request.op === "unsubscribe") {
          const sub = conn.subs.get(subKey(request.sessionId, request.memberId));
          if (sub) dropSub(sub);
          return;
        }
        const { sessionId, memberId } = request;
        // The pump is deferred, so this goes out before the first event for the subscription.
        void writeLine(socket, { op: "subscribed", session_id: sessionId, member_id: memberId })
          .catch(() => undefined);
        addSub(
          conn,
          sessionId,
          memberId,
          request.cursor,
          (event) => writeLine(socket, event),
          (reason) => {
            // Only this subscription ended: the connection, and the rest of its
            // subscriptions, go on. Best effort, since a dead socket has no one to tell.
            void writeLine(socket, { op: "end", session_id: sessionId, member_id: memberId, reason: reason.message })
              .catch(() => undefined);
          }
        );
      },
      (why) => {
        log(`bus: dropping a subscriber connection: ${why}`);
        socket.destroy();
      }
    );
  }

  // Attached here and not after listen(): the first subscriber can connect the moment
  // the socket exists.
  server.on("connection", accept);
  // After the first listen() settles its own once-handler is gone; an error on a
  // running server (EMFILE accepting, say) must not be an uncaught exception.
  server.on("error", () => undefined);

  let closing: Promise<void> | undefined;

  return {
    role: "coordinator",

    subscribe(sessionId, memberId, cursor, handlers) {
      checkSubscription(sessionId, memberId, cursor);
      if (closed) {
        queueMicrotask(() => callEnd(log, handlers, new Error("the bus is closed")));
        return { unsubscribe() {} };
      }
      const sub = addSub(
        local,
        sessionId,
        memberId,
        cursor,
        // A remote subscriber is handed an event it parsed for itself. This one would
        // otherwise share its payload with the window and with every other local handler,
        // so a handler that changed it would change what a later replay delivers.
        (event) => handlers.onEvent(structuredClone(event)),
        (reason) => handlers.onEnd?.(reason)
      );
      return { unsubscribe: () => dropSub(sub) };
    },

    ingest(event) {
      if (closed) return;
      if (typeof event.session_id !== "string" || !Number.isSafeInteger(event.cursor) || event.cursor < 1) {
        log("bus: ignoring a room event with no usable session or cursor");
        return;
      }
      const room = rooms.get(event.session_id);
      if (!room) return; // nobody here is watching it: there is nothing to keep it for
      room.window.push(event);
      for (const sub of room.subs) kick(sub);
    },

    stats: () => ({
      connections: remotes.size,
      rooms: Object.fromEntries(
        [...rooms].map(([id, room]) => [id, { ...room.window.stats(), subscribers: room.subs.size }])
      ),
    }),

    closed: new Promise<void>((resolve) => server.once("close", () => resolve())),

    close() {
      closing ??= (async () => {
        closed = true;
        for (const conn of remotes) conn.socket?.destroy();
        for (const room of [...rooms.values()]) {
          rooms.delete(room.id);
          for (const sub of room.subs) sub.ended = true;
          hook("onRoomClose", () => opts.onRoomClose?.(room.id));
        }
        local.subs.clear();
        // Closing a listening server unlinks its socket file: that is libuv's doing, and it
        // is how "a clean exit unlinks its own" (D8) holds. It unlinks by NAME, so when the
        // file at the path is no longer ours it is moved aside for the length of the close
        // and put back: see shieldSuccessor.
        const putBack = shieldSuccessor(path, claim.file, log);
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          putBack(); // the unlink inside close() has already run: it is synchronous
        });
      })();
      return closing;
    },
  };
}

// ---------------------------------------------------------------------------
// The subscriber
// ---------------------------------------------------------------------------

function subscriberOver(socket: net.Socket, log: (message: string) => void, ackTimeoutMs: number): Subscriber {
  const handlers = new Map<string, Handlers>();
  /** Subscribes the coordinator has not acknowledged yet, each with the timer that will give up on it. */
  const waiting = new Map<string, NodeJS.Timeout>();
  let dead = false;
  let closedByUs = false;
  /** Why the bus was abandoned, when it was this side that abandoned it: handed to every later subscribe too. */
  let abandoned: Error | undefined;

  const stopWaiting = (key: string): void => {
    const timer = waiting.get(key);
    if (timer) clearTimeout(timer);
    waiting.delete(key);
  };

  /**
   * No answer in time. The coordinator accepted the connection and is not serving it, and
   * everything on this connection depends on it, so the connection is dropped and every
   * subscription on it ends with the same reason (the close handler below).
   */
  const unresponsive = (memberId: string): void => {
    abandoned = new BusUnavailableError(
      "unresponsive",
      `the bus coordinator did not acknowledge the subscription for ${memberId} within ${ackTimeoutMs} ms`
    );
    log(`bus: ${abandoned.message}`);
    socket.destroy();
  };

  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.on("error", () => undefined); // a close always follows; that is where it is handled
  socket.once("close", () => {
    dead = true;
    for (const timer of waiting.values()) clearTimeout(timer);
    waiting.clear();
    const orphaned = [...handlers.values()];
    handlers.clear();
    // A close the owner asked for is not news to it.
    if (!closedByUs) {
      const reason = abandoned ?? new Error("the connection to the bus coordinator closed");
      for (const h of orphaned) callEnd(log, h, reason);
    }
  });

  readLines(
    socket,
    async (line) => {
      const message: unknown = JSON.parse(line);
      const m = message as Record<string, unknown> | null;
      if (m && typeof m === "object" && m.op === "subscribed" && typeof m.session_id === "string" && typeof m.member_id === "string") {
        stopWaiting(subKey(m.session_id, m.member_id));
        return;
      }
      if (m && typeof m === "object" && m.op === "end" && typeof m.session_id === "string" && typeof m.member_id === "string") {
        const key = subKey(m.session_id, m.member_id);
        stopWaiting(key);
        const h = handlers.get(key);
        if (h) {
          handlers.delete(key);
          callEnd(log, h, new Error(typeof m.reason === "string" ? m.reason : "ended by the coordinator"));
        }
        return;
      }
      if (!isPeerEvent(message)) {
        log("bus: ignoring a line from the coordinator that is not an event");
        return;
      }
      const h = handlers.get(subKey(message.session_id, message.member_id));
      if (!h) return; // unsubscribed while this was on its way
      try {
        await h.onEvent(message);
      } catch (error) {
        log(`bus: handler for ${message.member_id} failed on ${message.cursor}: ${messageOf(error)}`);
      }
    },
    (why) => {
      log(`bus: dropping the coordinator connection: ${why}`);
      socket.destroy();
    }
  );

  return {
    role: "subscriber",

    subscribe(sessionId, memberId, cursor, h) {
      checkSubscription(sessionId, memberId, cursor);
      if (dead || closedByUs) {
        queueMicrotask(() => callEnd(log, h, abandoned ?? new Error("the bus is closed")));
        return { unsubscribe() {} };
      }
      const key = subKey(sessionId, memberId);
      handlers.set(key, h); // the coordinator replaces an earlier one for this member in the same way
      stopWaiting(key); // a replacement starts its own wait
      const timer = setTimeout(() => unresponsive(memberId), ackTimeoutMs);
      timer.unref(); // waiting for an answer is never a reason to keep a process alive
      waiting.set(key, timer);
      void writeLine(socket, { op: "subscribe", session_id: sessionId, member_id: memberId, cursor })
        .catch(() => undefined); // a dead socket's close event is what tells the handler
      return {
        unsubscribe() {
          if (handlers.get(key) !== h) return;
          handlers.delete(key);
          stopWaiting(key);
          void writeLine(socket, { op: "unsubscribe", session_id: sessionId, member_id: memberId })
            .catch(() => undefined);
        },
      };
    },

    closed,

    async close() {
      closedByUs = true;
      socket.destroy();
      await closed;
    },
  };
}
