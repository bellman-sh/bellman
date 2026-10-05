import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  BusUnavailableError, openBus,
  type Bus, type BusOptions, type Coordinator, type Subscription, type SyncFrom,
} from "./bus.js";
import { fromEnvelope, type PeerEvent, type WireEnvelope } from "./inbox.js";
import {
  RoomEnded, openRoomSocket,
  type Poll, type RoomSocket, type RoomSocketTuning, type StopReason,
} from "./room-socket.js";

/**
 * What a bridge does with the local bus (src/bus.ts) and a room's socket (src/room-socket.ts): keep each
 * member's events flowing through them, and say so, once, when they cannot (spec D7-D11).
 *
 * A bridge asks for one thing, `watch`: deliver this member's events from the cursor it has reached. If this
 * process is the first on the machine for its identity it becomes the bus's coordinator and holds a socket
 * for each room that has a member watching it; otherwise it subscribes to whoever is. Either way the events
 * arrive through `onEvent`, and the bridge cannot tell which it is. That is also this module's whole
 * contract with D11, in layers:
 *
 *   - A room's socket that cannot be had is polled for by the socket itself (`poll` below), and the bus above
 *     it cannot tell. #99 failing never costs #43's collapse.
 *   - A bus that cannot be had, or that stops being usable for one member, is `onFallback`: the bridge polls
 *     for that member the way it always has. #43 failing never costs anyone their messages.
 *
 * Nothing here is a dependency. Every way of not getting what was asked for ends in `onFallback` or in a
 * retry that has a limit. A fallback is final for the member it is for: the loop the caller starts for it can
 * only be ended by ending the member, and it may have a request in flight, so it cannot be handed back to the
 * bus half way.
 */

/** The one tool of the bridge's connection that the link calls. `Remote` (src/bridge.ts) satisfies it. */
export interface BusConnection {
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<CallToolResult>;
}

export interface BusLinkOptions {
  /** The server URL as the bridge has it (.../mcp): half of what names the bus, and where a room's socket is. */
  url: string;
  /**
   * Who this is, for as long as it stays them: the other half of what names the bus (`BusOptions.credential`),
   * so it must not be a token that rotates. Asked when the bus is first needed and not before, because a
   * signed-in bridge has no identity to name until it has signed in. Undefined means it cannot be said, and
   * there is no bus to use.
   */
  identity: () => string | undefined;
  /** What a room's upgrade presents, as it is now. Read again for every attempt: an access token lasts ten minutes. */
  bearer: () => string | Promise<string>;
  /**
   * The bridge's connection to Bellman if it has one, and undefined if it has none. It never asks for one to
   * be made: on the signed-in path making one can open a browser, and a background poll must not do that.
   * An empty answer therefore reads as "Bellman no longer accepts this connection", as it does for `watch()`.
   */
  connection: () => Promise<BusConnection> | undefined;
  /**
   * A handle whose membership has ended. A room is never polled as one, whatever else is known about it. A
   * member a creator removed is answered at once and shown nothing past its cut, so a poll as one would only
   * spin; one whose seat timed out reads on, so a poll as one would go on returning events.
   */
  departed: (memberId: string) => boolean;
  /** How long one poll of a room holds, in seconds. The socket's own default (25) when it is not given. */
  pollWaitSeconds?: number;
  log?: (message: string) => void;

  // Seams for tests. Nothing in production sets them.
  root?: string;
  platform?: NodeJS.Platform;
  ackTimeoutMs?: number;
  window?: BusOptions["window"];
  roomSocket?: Partial<RoomSocketTuning>;
  /** How long the bus is left alone after it could not be had, did not answer, or kept being lost. 60 s. */
  cooldownMs?: number;
  /** A bus lost this many times within `lossWindowMs` is left alone for `cooldownMs`. 5. */
  maxLosses?: number;
  /** 30 s. */
  lossWindowMs?: number;
}

export interface WatchRequest {
  sessionId: string;
  memberId: string;
  /**
   * Where this member has got to, asked each time a subscription is made, so that one made again after the
   * coordinator went away resumes from there and not from where the first began.
   */
  cursor(): number;
  /**
   * One event for this member: in order, nothing at or below the cursor it subscribed from, and none of its
   * own. Awaited before the next. One member's slow handler holds up that bridge's others, because they share
   * a connection, so keep it cheap.
   */
  onEvent(event: PeerEvent): void | Promise<void>;
  /**
   * The bus cannot serve this member any more and will not be asked again for it: poll for it instead.
   * Called at most once, and never after `stop`.
   */
  onFallback(why: string): void;
}

export interface Watching {
  /** Idempotent. Nothing is called afterwards, and the room is closed upstream if this was its last member. */
  stop(): void;
}

export interface BusLink {
  watch(request: WatchRequest): Watching;
  /** Which of the two this process is on the bus right now, or undefined while it has none. */
  role(): "coordinator" | "subscriber" | undefined;
  /**
   * Idempotent. Stops everything and closes the bus: if this process coordinated, that is the bus's own socket
   * file and, told to close as the bus closes its rooms, every room's socket. A bus that was still opening is
   * closed when it has opened. It does not wait for a room's socket to finish closing, which it is already
   * on its way to doing; it waits for the bus, which is where the socket file is removed.
   */
  close(): Promise<void>;
}

const COOLDOWN_MS = 60_000;
const MAX_LOSSES = 5;
const LOSS_WINDOW_MS = 30_000;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * What each way a room's socket can end for good means, for a person. It is the middle of the line a member's own
 * bridge writes when this hands it back to polling, so it says what the socket found. The poll that follows says what
 * that member finds, and the two are meant to read as a cause and its confirmation and not as two faults.
 */
const ENDED_UPSTREAM: Partial<Record<StopReason, string>> = {
  closed: "the room is closed",
  gone: "Bellman says the room is not there, or the member is not this identity's",
  unauthorized: "Bellman no longer accepts this bridge's connection",
};

/** One macrotask, which is long enough for every promise reaction already queued to have run. */
const nextTurn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const textOf = (result: CallToolResult): string =>
  (result.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("\n");

/** The bridge has no connection to Bellman. */
class NotConnected extends Error {}
/** Bellman says the room is not there, or the member is not this identity's. The same two answers `watch()` stops on. */
class RoomGone extends Error {}

interface Answer { events: WireEnvelope[]; cursor: number; closed: boolean; removed: boolean }

/** One bus, from the moment it was asked for until it is lost or closed. */
interface Slot {
  promise: Promise<Opened>;
  bus?: Bus;
  coordinator?: Coordinator;
  /** A socket for each room this process holds, when it coordinates. */
  upstreams: Map<string, RoomSocket>;
}

type Opened = { bus: Bus; why?: undefined } | { bus?: undefined; why: string };

interface Entry extends WatchRequest {
  sub?: Subscription;
  /** Stopped, or fallen back: either way finished, and nothing is called for it again. */
  done: boolean;
}

export function createBusLink(opts: BusLinkOptions): BusLink {
  /** The caller's logger, which is its code: one that throws is not a reason to lose a member's events. */
  const log = (message: string): void => {
    try {
      opts.log?.(message);
    } catch {
      // nothing to do about it, and nothing that depends on it
    }
  };
  const cooldownMs = opts.cooldownMs ?? COOLDOWN_MS;
  const maxLosses = opts.maxLosses ?? MAX_LOSSES;
  const lossWindowMs = opts.lossWindowMs ?? LOSS_WINDOW_MS;

  let isClosing = false;
  let closing: Promise<void> | undefined;
  /** The bus new members are put on: opening, or open. */
  let current: Slot | undefined;
  /** No bus is opened before this time, and what to say to a member that asks in the meantime. */
  let coolUntil = 0;
  let coolWhy = "";
  /** When the bus was last lost, within the window. */
  const losses: number[] = [];
  const entries = new Set<Entry>();

  function cool(why: string): void {
    coolUntil = Date.now() + cooldownMs;
    coolWhy = why;
  }

  // ------------------------------------------------------------ asking Bellman

  /**
   * One `bellman_sync`, as a member, on the connection the bridge already has.
   *
   * The cache, and not the rejection, says whether there is a connection: a retirement closes the transport
   * underneath a call in flight, and that surfaces as a plain "Connection closed", which is not an auth error
   * at all. `watch()` reasons the same way, for the same reason.
   */
  async function sync(sessionId: string, memberId: string, cursor: number, waitSeconds: number): Promise<Answer> {
    const pending = opts.connection();
    if (pending === undefined) throw new NotConnected("the bridge has no connection to Bellman");
    let result: CallToolResult;
    try {
      result = await (await pending).callTool({
        name: "bellman_sync",
        arguments: { session_id: sessionId, member_id: memberId, since_cursor: cursor, wait_seconds: waitSeconds },
      });
    } catch (error) {
      if (opts.connection() === undefined) {
        throw new NotConnected(`the connection to Bellman was retired: ${messageOf(error)}`);
      }
      throw error;
    }
    if (result.isError) {
      const text = textOf(result);
      if (/session not found|not yours/i.test(text)) throw new RoomGone(text);
      throw new Error(text);
    }
    const out = (result.structuredContent ?? {}) as {
      events?: WireEnvelope[]; cursor?: number; session_status?: string; removed?: boolean;
    };
    return {
      events: Array.isArray(out.events) ? out.events : [],
      cursor: Number(out.cursor ?? cursor),
      closed: out.session_status === "closed",
      // Carried, not dropped. This is the bus-enabled path, and it is the one
      // production takes: a removed member's room socket falls back to THIS
      // poll, and a subscriber reading only `closed` would be handed an empty
      // active answer for ever and sleep only the poll floor (#113).
      //
      // UNPINNED, and said so rather than left looking covered. Both ends of
      // the chain have controls — the server's flag in
      // worker-tests/removed-member-sync.test.ts, and `room-socket.ts` ending
      // the room `gone`, which reddens when its own check is removed. This hop
      // does not: reaching it needs a subscription already fallen back to
      // polling AND a server answer carrying the flag, and an attempt at that
      // in tests/bus-link.test.ts could not get the link to fall back at all.
      // What is unverified is therefore narrow and explicit — that these two
      // field copies happen — and a mutation setting either to `false` passes.
      removed: out.removed === true,
    };
  }

  /** What the coordinator asks for a subscriber that is behind its window: one sync, as that member, with no wait. */
  const syncFrom: SyncFrom = async (sessionId, memberId, cursor) => {
    const answer = await sync(sessionId, memberId, cursor, 0);
    return {
      events: answer.events.map((envelope) => fromEnvelope({ session_id: sessionId, member_id: memberId }, envelope)),
      cursor: answer.cursor,
    };
  };

  /**
   * A room's poll, for a socket that cannot be had. It is made as a member the coordinator was told is
   * watching the room, because `bellman_sync` wants one the identity owns and the bus names them: the room may
   * have been opened by another bridge's member, and none of this process's may be in it. A departed handle is
   * skipped, as it is everywhere.
   *
   * Two answers end the room, because nothing will change them: the connection is gone (the credential is
   * not accepted any more) and Bellman says the room is not there. Anything else is retried by the socket.
   */
  function pollFor(slot: Slot, sessionId: string): Poll {
    return async ({ cursor, waitSeconds }) => {
      const as = slot.coordinator?.members(sessionId).find((memberId) => !opts.departed(memberId));
      if (as === undefined) throw new Error(`no member watching ${sessionId} to poll as`);
      let answer: Answer;
      try {
        answer = await sync(sessionId, as, cursor, waitSeconds);
      } catch (error) {
        if (error instanceof NotConnected) throw new RoomEnded("unauthorized", error.message);
        if (error instanceof RoomGone) throw new RoomEnded("gone", error.message);
        throw error;
      }
      return {
        events: answer.events.map((envelope) => envelope.data),
        cursor: answer.cursor,
        closed: answer.closed,
        removed: answer.removed,
      };
    };
  }

  // ----------------------------------------------------- a coordinator's rooms

  function closeUpstream(slot: Slot, sessionId: string): void {
    const socket = slot.upstreams.get(sessionId);
    if (!socket) return;
    slot.upstreams.delete(sessionId);
    void socket.close().catch(() => undefined);
  }

  function openUpstream(slot: Slot, sessionId: string, cursor: number): void {
    const coordinator = slot.coordinator;
    if (!coordinator) throw new Error(`room ${sessionId} was opened before its coordinator was known`);
    let socket: RoomSocket;
    try {
      socket = openRoomSocket({
        url: opts.url,
        credential: opts.bearer,
        sessionId,
        cursor,
        onEvent: (event) => coordinator.ingest(event),
        poll: pollFor(slot, sessionId),
        onState: (state, why) => log(`room ${sessionId}: ${state} (${why})`),
        log,
        tuning: { ...opts.roomSocket, pollWaitSeconds: opts.pollWaitSeconds ?? opts.roomSocket?.pollWaitSeconds },
      });
    } catch (error) {
      // The bus holds the room open with nothing behind it unless somebody is told. Deferred, so that no
      // handler runs inside the subscribe() that is in the middle of opening this room.
      log(`room ${sessionId}: no socket could be opened: ${messageOf(error)}`);
      const told = new Error(
        `the process holding this room's socket could not open one (${messageOf(error)}), so each member checks for itself`,
        { cause: error }
      );
      queueMicrotask(() => coordinator.endRoom(sessionId, told));
      return;
    }
    slot.upstreams.set(sessionId, socket);
    void socket.stopped.then((reason) => {
      // Only a socket that is still the room's registered one has anything to report: one closed on purpose has
      // been forgotten by closeUpstream. No test reaches this check, because nothing closes a socket while its
      // room is still registered with the bus (the bus closes the room first), so it is here for the day
      // something does.
      if (slot.upstreams.get(sessionId) !== socket) return;
      slot.upstreams.delete(sessionId);
      const found = ENDED_UPSTREAM[reason] ?? reason;
      log(`room ${sessionId} is over upstream (${found}): telling every member of it on this machine to check for itself`);
      // Every member of it, here and on other bridges, is told: each polls for itself, and its own poll is what
      // reads closed, gone and not-accepted the way it always has.
      coordinator.endRoom(
        sessionId,
        new Error(`the process holding this room's socket found that ${found}, so each member checks for itself`)
      );
    });
  }

  // ------------------------------------------------------------------ the bus

  async function openSlot(slot: Slot): Promise<Opened> {
    const unavailable = (why: string): Opened => {
      if (current === slot) current = undefined;
      cool(why);
      log(`bus unavailable, polling instead: ${why}`);
      return { why };
    };
    let credential: string | undefined;
    try {
      credential = opts.identity();
    } catch (error) {
      return unavailable(`cannot say who this is: ${messageOf(error)}`);
    }
    if (credential === undefined || credential === "") {
      return unavailable("cannot say who this is, so there is no bus to name");
    }
    let bus: Bus;
    try {
      bus = await openBus({
        url: opts.url,
        credential,
        syncFrom,
        onRoomOpen: (sessionId, cursor) => openUpstream(slot, sessionId, cursor),
        onRoomClose: (sessionId) => closeUpstream(slot, sessionId),
        root: opts.root,
        platform: opts.platform,
        ackTimeoutMs: opts.ackTimeoutMs,
        window: opts.window,
        log,
      });
    } catch (error) {
      return unavailable(messageOf(error));
    }
    slot.bus = bus;
    if (bus.role === "coordinator") slot.coordinator = bus;
    void bus.closed.then(() => lost(slot));
    return { bus };
  }

  function ensure(): Promise<Opened> {
    if (current) return current.promise;
    if (Date.now() < coolUntil) return Promise.resolve({ why: `${coolWhy} (not trying again for a while)` });
    let settle!: (opened: Opened) => void;
    const slot: Slot = { upstreams: new Map(), promise: new Promise<Opened>((resolve) => { settle = resolve; }) };
    current = slot; // before it opens: a failure inside has to find it there to clear it
    // openSlot does not reject: each thing in it that can throw is caught there and becomes `unavailable`. One
    // that did anyway would be an unhandled rejection, which is loud, and not a member waiting for ever.
    void openSlot(slot).then(settle);
    return slot.promise;
  }

  /**
   * The bus can no longer deliver. Whoever was on it is told through their own `onEnd`, and what they do about
   * it is `ended`. This only forgets the bus, and counts: a bus lost over and over is not one to keep asking.
   */
  function lost(slot: Slot): void {
    if (current === slot) current = undefined;
    const now = Date.now();
    losses.push(now);
    while (losses.length > 0 && now - losses[0] > lossWindowMs) losses.shift();
    if (losses.length >= maxLosses) {
      const why = `the bus was lost ${losses.length} times within ${lossWindowMs} ms`;
      losses.length = 0;
      cool(why);
      log(`bus: ${why}; polling instead for a while`);
    }
  }

  // ----------------------------------------------------------------- a member

  function finish(entry: Entry): boolean {
    if (entry.done) return false;
    entry.done = true;
    entries.delete(entry);
    const sub = entry.sub;
    entry.sub = undefined;
    sub?.unsubscribe();
    return true;
  }

  function fallback(entry: Entry, why: string): void {
    if (!finish(entry)) return;
    try {
      entry.onFallback(why);
    } catch (error) {
      log(`bus: a fallback handler threw: ${messageOf(error)}`);
    }
  }

  function attach(entry: Entry, bus: Bus): void {
    let sub: Subscription;
    try {
      sub = bus.subscribe(entry.sessionId, entry.memberId, entry.cursor(), {
        onEvent: (event) => entry.onEvent(event),
        onEnd: (reason) => void ended(entry, bus, reason),
      });
    } catch (error) {
      fallback(entry, `a subscription could not be made: ${messageOf(error)}`);
      return;
    }
    entry.sub = sub;
  }

  /**
   * A subscription ended without being asked to. A connection that died and one subscription that was ended
   * arrive the same way, and the bus is what tells them apart: if it is gone, `closed` settles in the same
   * turn, so one turn later it has.
   *
   *   - The coordinator is there and not answering (`unresponsive`). Subscribing again through the same bus
   *     would only wait again, so there is no second try, and the bus is left alone for a while so that nobody
   *     new waits on it either.
   *   - The coordinator went away. Whoever it was, the bridges race again and one wins, and this member
   *     subscribes to the winner from its own cursor, which is gapless. A bus lost over and over is the one
   *     exit from that: see `lost`.
   *   - This subscription only: a catch-up the coordinator needed failed, or its room ended upstream. The
   *     bus is fine, and asking again would ask for the same failure. This member polls.
   */
  async function ended(entry: Entry, bus: Bus, reason: Error): Promise<void> {
    entry.sub = undefined;
    if (reason instanceof BusUnavailableError && reason.reason === "unresponsive") {
      cool(reason.message);
      return fallback(entry, reason.message);
    }
    const gone = await Promise.race([bus.closed.then(() => true), nextTurn().then(() => false)]);
    if (!gone) return fallback(entry, reason.message);
    const next = await ensure();
    // Stopped while the bus was being found again, which can take as long as an election: a member that has
    // departed in that time must not be subscribed on the new bus, where the coordinator would go on serving it.
    if (entry.done) return;
    if (!next.bus) return fallback(entry, `the bus coordinator went away, and ${next.why}`);
    attach(entry, next.bus);
  }

  async function begin(entry: Entry): Promise<void> {
    const opened = await ensure();
    if (entry.done) return;
    if (!opened.bus) return fallback(entry, opened.why);
    attach(entry, opened.bus);
  }

  return {
    watch(request) {
      // Nothing is watched once the link is closed, and nothing is called back for it: not even a fallback.
      if (isClosing) return { stop() {} };
      const entry: Entry = { ...request, done: false };
      entries.add(entry);
      void begin(entry);
      return { stop: () => void finish(entry) };
    },

    role: () => current?.bus?.role,

    close() {
      isClosing = true;
      closing ??= (async () => {
        for (const entry of [...entries]) finish(entry);
        const slot = current;
        current = undefined;
        const opened = await slot?.promise;
        await opened?.bus?.close();
      })();
      return closing;
    },
  };
}
