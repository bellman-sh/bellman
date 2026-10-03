import http from "node:http";
import https from "node:https";
import type { RoomEvent } from "./bus.js";

/**
 * The upstream half of room delivery: one WebSocket to one room's Durable Object,
 * held by whichever bridge is the bus coordinator, feeding `Coordinator.ingest`
 * (spec D2, D7, D11).
 *
 * A long poll is an in-flight request, an in-flight request keeps the object
 * resident, and a resident object bills duration. A hibernating socket does not:
 * that is Cloudflare's statement, and neither the spec's probe nor anything here
 * can observe a bill, so the first real one is the test. It is the only reason
 * this exists, so the job here is two-sided: hold the socket, and be harmless
 * when it cannot be held.
 *
 * What crosses it. A frame is `publicEvent(event)` (src/public-event.ts, D1a), the
 * projection `bellman_sync` returns, so a bridge reads one shape whichever path
 * delivered an event. This module carries frames and does not render or unwrap
 * them: peer content stays untrusted all the way to the last hop, where each bridge
 * escapes it (D9).
 *
 * Degrading (D11). If the socket cannot be had, or will not stay, this long-polls
 * the same room through the `poll` it is given and keeps feeding the same
 * coordinator. The bus above cannot tell which path an event came by, which is the
 * property that makes #99 safe to ship: it can fail without costing #43's collapse.
 * `poll` is a required option and not a nicety, because the fallback is mandatory;
 * it is injected, like the bus's `syncFrom`, so this file never learns what an MCP
 * client is.
 *
 * Node's WebSocket cannot say why a handshake failed. Measured on Node 22.16
 * (undici 6.21.2) and Node 25.8.2 (undici 7.24.4): a refusal with 400, 401, 403,
 * 404, 409, 426, 500 or 503 produces the same bare `error` event, with no status
 * anywhere on it. The status is the whole of the server's answer (409 is a room
 * that is over, 401 a credential that is not accepted, the rest are worth waiting
 * out), so a failed handshake is followed by one more request, made with
 * node:http, whose only purpose is to read it. See `probeStatus`.
 */

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

/**
 * The part of a WebSocket this module uses. It is declared here and not taken from a lib because
 * `headers` is not part of the standard constructor and neither program this file is type-checked
 * in admits it: tsc rejects `new WebSocket(url, { headers })` under tsconfig.json and under
 * tsconfig.worker.json alike ("'headers' does not exist in type 'string[]'").
 */
export interface WebSocketLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
  send(data: string): void;
  close(code?: number): void;
}

/** `headers` is an undici extension to the constructor that Node's global WebSocket inherits (spec D2). */
export type WebSocketConstructor = new (url: string, init: { headers: Record<string, string> }) => WebSocketLike;

/**
 * `connecting`: no socket is open and the poll has not been needed yet (the first attempt, or a
 * reconnect still inside its first failures). `open`: a WebSocket is delivering. `degraded`: the
 * room is being polled while the socket is still tried. `stopped`: over, for good.
 */
export type RoomSocketState = "connecting" | "open" | "degraded" | "stopped";

/**
 * Why the state changed. `opened`: the handshake completed. `dropped`: an open socket closed or
 * errored. `silent`: an open socket stopped answering the keepalive. `refused`: the upgrade was
 * answered with a status other than 401 or 409. `unreachable`: it was not answered at all.
 * `timeout`: it was not answered within `connectTimeoutMs`. `unusable`: the request could not be
 * built, or the credential could not be read. `unauthorized`: a 401, or a poll that says the
 * credential is gone. `closed`: the room is over. `gone`: the room or the member is not there.
 * `requested`: `close()` was called.
 */
export type Why =
  | "opened" | "dropped" | "silent" | "refused" | "unreachable" | "timeout" | "unusable"
  | "unauthorized" | "closed" | "gone" | "requested";

/** What `stopped` settles with. */
export type StopReason = "closed" | "gone" | "unauthorized" | "requested";

/**
 * One long poll for this room, made for the room's sake and not for any one subscriber's.
 * `waitSeconds` is how long to hold it, `cursor` is where to read from, and `signal` is aborted
 * when the answer is no longer wanted (the socket came back, or this was closed).
 */
export interface PollRequest { cursor: number; waitSeconds: number; signal: AbortSignal }

/**
 * What a poll answers. `events` are in `publicEvent`'s shape (an envelope's `data`, not the
 * envelope) and are read by the same parser a socket's frames are. `cursor` is the room cursor
 * the answer covers: `bellman_sync` counts the member's own events and does not return them, so
 * it can be past the last event, and without it a gap of only the member's own events would be
 * asked for again for ever. `closed` is `session_status === "closed"`.
 */
export interface PollResult { events: unknown[]; cursor: number; closed?: boolean }

export type Poll = (request: PollRequest) => Promise<PollResult>;

/**
 * Throw this from `poll` when the room cannot be polled any more and nothing will change that:
 * `closed` (the room is over), `gone` (the room or the member is not there), `unauthorized` (the
 * credential is gone). Anything else a poll throws is retried, with a wait.
 */
export class RoomEnded extends Error {
  override readonly name = "RoomEnded";
  constructor(readonly reason: Exclude<StopReason, "requested">, message?: string) {
    super(message ?? `the room is over: ${reason}`);
  }
}

export interface RoomSocketTuning {
  /** The first ceiling of the reconnect wait, and what it doubles from. 1 s. */
  baseMs: number;
  /** The most the ceiling reaches while the socket is the primary path. 30 s. */
  capMs: number;
  /** The same, once the room is being polled and the socket is only being re-tried. 120 s. */
  degradedCapMs: number;
  /** How many attempts in a row fail before the room is polled instead. 3. */
  degradeAfter: number;
  /** How long a handshake may go unanswered before it is abandoned. Node's own client waits 300 s. 10 s. */
  connectTimeoutMs: number;
  /**
   * How long a connection must have lasted for the wait after it ends to start again from the base.
   * One that ended sooner counts toward the failures in a row, however well it opened. 30 s.
   */
  stableMs: number;
  /** Silence on an open socket before it is asked "ping". 0 turns the keepalive off. 30 s. */
  pingIntervalMs: number;
  /** How long after "ping" any frame at all may take before the connection is abandoned. 10 s. */
  pongTimeoutMs: number;
  /** `waitSeconds` for a poll. `bellman_sync` allows 25 at most, and that is what `watch()` asks for. 25. */
  pollWaitSeconds: number;
  /** The least a poll that delivered nothing is followed by, so an answer at once is not a hot loop. 1 s, as `watch()`. */
  pollFloorMs: number;
  /** For the jitter. Math.random. */
  random: () => number;
  /** For every wait. It must settle when the signal aborts. Real timers. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The global WebSocket. A seam for the one test that has to behave as an older Node does. */
  WebSocket: WebSocketConstructor;
}

export interface RoomSocketOptions {
  /** The server URL, as the bridge has it (https://mcp.bellman.sh/mcp). The socket is at /ws beside it. */
  url: string;
  /**
   * The bearer credential for the upgrade, or a function that returns the current one. It is read
   * again for every attempt, because a bridge's OAuth access token lasts ten minutes
   * (ACCESS_TOKEN_TTL_SECONDS) and the first reconnect after that would otherwise carry a token
   * that is already dead. This is not the bus's `credential`, and the two must not be given the same
   * value: the bus hashes its credential into its socket path, so it has to stay the same for as long
   * as the identity does (`BusOptions.credential` in src/bus.ts), while this one is a secret that
   * rotates. An access token handed to both would give every rotation a new bus path, and the old
   * coordinator would keep serving the old one.
   */
  credential: string | (() => string | Promise<string>);
  sessionId: string;
  /** The highest cursor already delivered. The first connection asks for what is above it. */
  cursor: number;
  /**
   * Called once per event, in order, with nothing at or below the cursor reached. Keep it cheap
   * and do not block: it runs on the socket's own turn. `Coordinator.ingest` is exactly that.
   */
  onEvent(event: RoomEvent): void;
  /** The fallback (D11). Required. */
  poll: Poll;
  /** Told when the state changes, and why. Safe to leave out: nothing here depends on anyone listening. */
  onState?(state: RoomSocketState, why: Why): void;
  log?(message: string): void;
  tuning?: Partial<RoomSocketTuning>;
}

export interface RoomSocket {
  readonly sessionId: string;
  /** The highest cursor handed to `onEvent`: where a reconnect, or a poll, resumes. */
  readonly cursor: number;
  readonly state: RoomSocketState;
  /** Settles when this has stopped for good, with why. */
  readonly stopped: Promise<StopReason>;
  /**
   * Idempotent. When it settles nothing of this module's will run again: no callback, no attempt,
   * no poll. A poll already in flight is cancelled through its signal, and is not waited for if
   * it ignores it.
   */
  close(): Promise<void>;
}

const BASE_MS = 1_000;
const CAP_MS = 30_000;
const DEGRADED_CAP_MS = 120_000;
const DEGRADE_AFTER = 3;
const CONNECT_TIMEOUT_MS = 10_000;
const STABLE_MS = 30_000;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const POLL_WAIT_SECONDS = 25;
const POLL_FLOOR_MS = 1_000;

/**
 * The text the Durable Object answers itself: `setWebSocketAutoResponse(ping, pong)`, in the
 * constructor of SessionDO (src/store-do.ts). The runtime replies with no JavaScript running, so
 * a keepalive does not wake a hibernated object (measured in the server half, see that
 * constructor's comment); any other text a client sends reaches `webSocketMessage`, which closes
 * the socket with 1003 (D1). A keepalive has to be exactly this. Against `wrangler dev` this module's
 * keepalive ran for six seconds at 0.5 s of silence per ping without the socket once closing.
 */
const PING = "ping";
const PONG = "pong";

/** Says on the probe's own requests that they are probes, so a server's log can tell them from sockets. */
const PROBE_USER_AGENT = "bellman-room-socket/probe";

// ---------------------------------------------------------------------------
// What can be said without a socket
// ---------------------------------------------------------------------------

/**
 * Where a room's socket is, given the server URL a bridge has: `/ws` beside the `/mcp` it points at,
 * with the session and the cursor. A browser could not send the header this authenticates by, but this
 * is not a browser (D2), so nothing about the credential is in the URL.
 *
 * Anything else on the URL is dropped on purpose: a query, a fragment and userinfo have no meaning at
 * /ws, and a credential in the userinfo would be sent where the Authorization header is meant to be.
 */
export function roomSocketUrl(serverUrl: string, sessionId: string, cursor: number): string {
  const url = new URL(serverUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  url.username = "";
  url.password = "";
  url.pathname = url.pathname.replace(/\/mcp\/?$/, "").replace(/\/$/, "") + "/ws";
  url.search = "";
  url.hash = "";
  url.searchParams.set("session", sessionId);
  url.searchParams.set("cursor", String(cursor));
  return url.toString();
}

/**
 * Full jitter: anywhere from nothing up to `min(cap, base * 2^failures)`, never the ceiling itself.
 *
 * A reconnect storm is already smaller than it was, because a machine holds one socket per room and not one
 * per member per session (D7). Jitter is what stops what is left of it resynchronising after a deploy: without
 * it every coordinator that lost its socket at the same moment asks again at the same moments.
 * `failures` counts from zero, so the first wait is under `base`.
 */
export function backoffDelay(failures: number, baseMs: number, capMs: number, random: () => number): number {
  return random() * Math.min(capMs, baseMs * 2 ** failures);
}

/**
 * Read one `publicEvent` frame into the bus's `RoomEvent`, or undefined when it is not one.
 *
 * The event is built from the fields it is known to have, so a field the server never meant to send
 * (a user id, say) does not travel on by being spread. The payload is the very object it was given: it is
 * peer content, it is untrusted, and this is not the place that renders or escapes it (D9).
 *
 * A `ref_id` that is absent reads as none. `publicEvent` always writes one, but an absent key and a null
 * mean the same thing in JSON, and dropping every event over it would be the worse mistake.
 */
export function roomEventFromFrame(sessionId: string, frame: unknown): RoomEvent | undefined {
  if (typeof frame !== "object" || frame === null) return undefined;
  const { cursor, type, from, payload, ref_id: refId, at } = frame as Record<string, unknown>;
  if (typeof from !== "object" || from === null) return undefined;
  const { member_id: memberId, label } = from as Record<string, unknown>;
  if (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 1) return undefined;
  if (typeof type !== "string" || typeof memberId !== "string" || typeof label !== "string") return undefined;
  if (typeof at !== "string") return undefined;
  if (refId !== null && refId !== undefined && typeof refId !== "string") return undefined;
  return {
    session_id: sessionId,
    cursor,
    type,
    from_member_id: memberId,
    from_label: label,
    ref_id: refId ?? null,
    at,
    payload,
  };
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const ABORTED = Symbol("aborted");

/**
 * `promise`, or ABORTED the moment `signal` aborts, whichever is first. A wait that the abort cannot end is a
 * `close()` that never returns: the poll is the caller's, an MCP call may not honour its signal, and a
 * credential provider may never answer.
 */
function orAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function sleepFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref(); // waiting to try again is never a reason to keep a process alive
    signal.addEventListener("abort", done, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Learning why a handshake failed
// ---------------------------------------------------------------------------

/**
 * A fresh Sec-WebSocket-Key: 16 random bytes, base64 (RFC 6455 section 4.1). Web Crypto and not
 * node:crypto's randomBytes, which the Workers program this file is also type-checked in declares
 * with no parameters.
 */
function handshakeKey(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Make the upgrade request again, with node:http, to read the status Node's WebSocket will not give.
 *
 * It is the same URL and the same credential, with the headers a handshake carries. A 101 means the
 * server would have accepted it after all (the first failure was passing), and that socket is destroyed
 * at once. Anything that is not an HTTP answer (nothing listening, a reset, no reply in time) is
 * undefined, which the caller treats as "wait and try again": the safe reading of not knowing.
 *
 * Why not read it off the first request. There is no way to: undici's `error` event carries no response.
 * Why not a plain fetch. The Worker answers a request that is not an upgrade 426 before it looks at who is
 * asking, and fetch will not send an `Upgrade` header (measured on both Nodes: a TypeError whose cause is
 * "invalid upgrade header", and nothing reaches the server). The cost is one extra request after a failure
 * that has already cost one, and failures are already spaced by the backoff. On Node 25 a refused upgrade
 * costs more than that when the status is 401: its WebSocket sends the request a second time itself
 * (measured: two identical requests for a 401, one for a 409 or a 503; Node 22.16 sends one every time).
 */
function probeStatus(
  wsUrl: string,
  credential: string,
  signal: AbortSignal,
  timeoutMs: number
): Promise<number | undefined> {
  return new Promise((resolve) => {
    let request: http.ClientRequest | undefined;
    let settled = false;
    const finish = (status: number | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      // Destroying the request is also what closes a socket the server upgraded: it destroys the
      // connection even after the 'upgrade' event has handed it over (measured on Node 22.16 and
      // 25.8.2). "is not fooled by a failure that has cleared" goes red without this line.
      request?.destroy();
      resolve(status);
    };
    const onAbort = (): void => finish(undefined);
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const target = new URL(wsUrl);
      const secure = target.protocol === "wss:";
      target.protocol = secure ? "https:" : "http:";
      request = (secure ? https : http).request(target, {
        method: "GET",
        agent: false, // one connection for one question: nothing here is worth pooling
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": handshakeKey(),
          authorization: `Bearer ${credential}`,
          "user-agent": PROBE_USER_AGENT,
        },
      });
      request.on("response", (response) => {
        response.resume();
        finish(response.statusCode);
      });
      request.on("upgrade", () => finish(101));
      request.on("error", () => finish(undefined));
      request.end();
    } catch {
      finish(undefined);
    }
  });
}

// ---------------------------------------------------------------------------
// The socket
// ---------------------------------------------------------------------------

type AttemptEnd =
  | { kind: "stopped" }
  | { kind: "unusable"; error: unknown }
  | { kind: "failed"; timedOut: boolean }
  | { kind: "ended"; heldMs: number; silent: boolean; code: number | undefined };

export function openRoomSocket(options: RoomSocketOptions): RoomSocket {
  const { sessionId } = options;
  if (typeof sessionId !== "string" || sessionId === "") {
    throw new TypeError("openRoomSocket: sessionId must be a non-empty string");
  }
  if (!Number.isSafeInteger(options.cursor) || options.cursor < 0) {
    throw new TypeError(`openRoomSocket: cursor must be a non-negative integer, got ${String(options.cursor)}`);
  }
  try {
    roomSocketUrl(options.url, sessionId, 0);
  } catch {
    throw new TypeError(`openRoomSocket: url is not a URL: ${JSON.stringify(options.url)}`);
  }

  const tune = options.tuning ?? {};
  const baseMs = tune.baseMs ?? BASE_MS;
  const capMs = tune.capMs ?? CAP_MS;
  const degradedCapMs = tune.degradedCapMs ?? DEGRADED_CAP_MS;
  const degradeAfter = tune.degradeAfter ?? DEGRADE_AFTER;
  const connectTimeoutMs = tune.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const stableMs = tune.stableMs ?? STABLE_MS;
  const pingIntervalMs = tune.pingIntervalMs ?? PING_INTERVAL_MS;
  const pongTimeoutMs = tune.pongTimeoutMs ?? PONG_TIMEOUT_MS;
  const pollWaitSeconds = tune.pollWaitSeconds ?? POLL_WAIT_SECONDS;
  const pollFloorMs = tune.pollFloorMs ?? POLL_FLOOR_MS;
  const random = tune.random ?? Math.random;
  const sleep = tune.sleep ?? sleepFor;
  const NodeWebSocket = tune.WebSocket ?? (globalThis.WebSocket as unknown as WebSocketConstructor);

  let state: RoomSocketState = "connecting";
  let cursor = options.cursor;
  let stopReason: StopReason | undefined;
  /** Aborted when this stops, whatever the reason: it is what every wait and every request below listens to. */
  const life = new AbortController();
  let resolveStopped!: (reason: StopReason) => void;
  const stopped = new Promise<StopReason>((resolve) => {
    resolveStopped = resolve;
  });

  /**
   * What this module tells the outside runs inside a try, because it is the caller's code and a
   * throw from it must not end the loop that is keeping a room served.
   */
  const emit = (message: string): void => {
    try {
      options.log?.(`room ${sessionId}: ${message}`);
    } catch {
      // a logger that throws is not a reason to stop delivering
    }
  };

  function setState(next: RoomSocketState, why: Why): void {
    if (state === next) return;
    state = next;
    try {
      options.onState?.(next, why);
    } catch (error) {
      emit(`onState threw: ${messageOf(error)}`);
    }
  }

  function stop(reason: StopReason): void {
    if (stopReason !== undefined) return;
    stopReason = reason;
    setState("stopped", reason);
    life.abort();
    resolveStopped(reason);
  }

  /**
   * The one place an event reaches `onEvent`, and one monotonic guard in front of it. A replay that
   * starts below events the poll delivered while the socket was still connecting, an event a poll
   * returns that the cursor has already passed, and a server that sends an old one all look the
   * same from here, and none of them gets through. It is the bus's `sentThrough` (D9), one level up.
   */
  function accept(event: RoomEvent): boolean {
    if (stopReason !== undefined || event.cursor <= cursor) return false;
    cursor = event.cursor;
    try {
      options.onEvent(event);
    } catch (error) {
      emit(`onEvent threw for cursor ${event.cursor}: ${messageOf(error)}`);
    }
    return true;
  }

  /** Deliver what a poll answered, and move to the cursor it covers. Returns how many events got through. */
  function take(answer: PollResult): number {
    let delivered = 0;
    for (const raw of Array.isArray(answer.events) ? answer.events : []) {
      const event = roomEventFromFrame(sessionId, raw);
      if (!event) {
        emit("ignoring a frame the poll returned: it is not an event");
        continue;
      }
      if (accept(event)) delivered += 1;
    }
    if (Number.isSafeInteger(answer.cursor) && answer.cursor > cursor) cursor = answer.cursor;
    return delivered;
  }

  async function readCredential(): Promise<string> {
    const source = options.credential;
    return typeof source === "function" ? await source() : source;
  }

  // ------------------------------------------------------------------ polling

  let pollController: AbortController | undefined;
  let pollDone: Promise<void> = Promise.resolve();

  function startPolling(): void {
    if (pollController || life.signal.aborted) return;
    const controller = (pollController = new AbortController());
    const follow = (): void => controller.abort();
    life.signal.addEventListener("abort", follow, { once: true });
    emit("polling this room until the socket comes back");
    pollDone = pollUntil(controller.signal)
      .catch((error: unknown) => emit(`the poll loop failed: ${messageOf(error)}`))
      .finally(() => life.signal.removeEventListener("abort", follow));
  }

  function stopPolling(): void {
    pollController?.abort();
    pollController = undefined;
  }

  /**
   * The fallback: `watch()`'s loop, for a room and not for a member. A failure waits, with the
   * same jitter and doubling the socket's reconnects use; an answer that comes at once with
   * nothing waits `pollFloorMs`, so a server that stops holding the request cannot make this a
   * hot loop. It is the cursor the answer reports that the next poll starts from, not the last
   * event's, for the reason `PollResult` gives.
   */
  async function pollUntil(signal: AbortSignal): Promise<void> {
    let errors = 0;
    while (!signal.aborted) {
      const startedAt = Date.now();
      let delivered = 0;
      let closed = false;
      try {
        const answer = await orAbort(options.poll({ cursor, waitSeconds: pollWaitSeconds, signal }), signal);
        // A late answer is dropped, not delivered: if the socket is back it will replay from
        // the cursor, which has not moved, so nothing is lost and nothing arrives twice.
        if (answer === ABORTED || signal.aborted) return;
        delivered = take(answer);
        closed = answer.closed === true;
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof RoomEnded) {
          emit(`the poll says the room is over (${error.reason}): ${error.message}`);
          stop(error.reason);
          return;
        }
        emit(`poll failed: ${messageOf(error)}`);
        await sleep(backoffDelay(errors++, baseMs, capMs, random), signal);
        continue;
      }
      errors = 0;
      if (closed) {
        emit("the poll reports the room closed");
        stop("closed");
        return;
      }
      if (delivered === 0 && Date.now() - startedAt < pollFloorMs) await sleep(pollFloorMs, signal);
    }
  }

  /**
   * One poll for what was missed, with no wait, before a closed room is given up on.
   *
   * A 409 comes instead of a replay: the reconnect that learns the room is over was going to be sent
   * everything above its cursor, and now it will not be. Whatever the room said between the cursor
   * and its closing (the session_expired notice among it) is therefore only to be had from a poll,
   * which still answers for a closed room (bellman_sync returns the events after the cursor and
   * reports session_status; src/server.ts). Failing to get it changes nothing about stopping.
   */
  async function tail(): Promise<void> {
    const controller = new AbortController();
    const follow = (): void => controller.abort();
    life.signal.addEventListener("abort", follow, { once: true });
    const timer = setTimeout(follow, connectTimeoutMs);
    timer.unref();
    try {
      const answer = await orAbort(
        options.poll({ cursor, waitSeconds: 0, signal: controller.signal }),
        controller.signal
      );
      if (answer !== ABORTED) take(answer);
    } catch (error) {
      emit(`could not fetch what the room held before it closed: ${messageOf(error)}`);
    } finally {
      clearTimeout(timer);
      life.signal.removeEventListener("abort", follow);
    }
  }

  // ------------------------------------------------------------------ one attempt

  /**
   * One WebSocket, from the request until it ends. Resolves when it is over, whichever way.
   *
   * Three things in here are about Node's client and not about Bellman. Its wait on a handshake nobody
   * answers is five minutes: a server that takes the connection and says nothing leaves it with no event
   * for 300 s and then an `error` (measured on both Nodes, 301.1 s each), and a room cannot go unserved
   * that long, so this has its own timer. A refused handshake ends
   * with `error` alone on Node 22: readyState stays CONNECTING and no `close` arrives (a first
   * measurement waited two minutes for one). Node 25 follows the `error` with a `close`. So the attempt
   * ends on the first `error` and never waits for a `close` that may not come.
   * And the constructor throws, synchronously, for a header value that cannot be sent (a TypeError for
   * a credential holding a line break, on both Nodes), which is also what stops a credential being used
   * to add a header.
   */
  function attempt(credential: string): Promise<AttemptEnd> {
    return new Promise<AttemptEnd>((resolve) => {
      let socket: WebSocketLike;
      try {
        socket = new NodeWebSocket(roomSocketUrl(options.url, sessionId, cursor), {
          headers: { authorization: `Bearer ${credential}` },
        });
      } catch (error) {
        resolve({ kind: "unusable", error });
        return;
      }

      let openedAt: number | undefined;
      let over = false;
      let idleTimer: NodeJS.Timeout | undefined;
      let pongTimer: NodeJS.Timeout | undefined;
      // Not a safety net, and not what ends a refusal: that is the first `error`, handled below. This
      // ends an attempt at a server that takes the connection and never answers the handshake, which
      // Node would otherwise hold for 300 s (measured on both Nodes) with the room unserved all of it.
      const connectTimer = setTimeout(() => finish({ kind: "failed", timedOut: true }), connectTimeoutMs);
      connectTimer.unref();

      const ended = (silent: boolean, code?: number): AttemptEnd => ({
        kind: "ended",
        heldMs: openedAt === undefined ? 0 : Date.now() - openedAt,
        silent,
        code,
      });

      function finish(end: AttemptEnd): void {
        if (over) return;
        over = true;
        clearTimeout(connectTimer);
        clearTimeout(idleTimer);
        clearTimeout(pongTimer);
        life.signal.removeEventListener("abort", onAbort);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
        try {
          // Polite when it can be: a close frame, which the object answers. When the connection was
          // never made this is an error nobody is listening for any more. When it is dead it frees
          // nothing: Node waits for the peer's close frame, and against a peer that never answers the
          // socket was still CLOSING 30 s later (measured on both Nodes). An abandoned connection
          // therefore holds its file descriptor until the operating system gives up on it.
          socket.close(1000);
        } catch {
          // already closed
        }
        resolve(end);
      }

      /**
       * Any frame at all is proof of life, so a socket that is delivering is never asked, and a socket
       * that is asked has one deadline to say anything. Ping only after a silence: the room is usually
       * quiet, and the keepalive exists for that case.
       */
      function armIdle(): void {
        clearTimeout(idleTimer);
        if (pingIntervalMs <= 0 || over || openedAt === undefined) return;
        idleTimer = setTimeout(() => {
          try {
            socket.send(PING);
          } catch (error) {
            emit(`could not send the keepalive: ${messageOf(error)}`);
            finish(ended(true));
            return;
          }
          pongTimer = setTimeout(() => finish(ended(true)), pongTimeoutMs);
          pongTimer.unref();
        }, pingIntervalMs);
        idleTimer.unref();
      }

      const onAbort = (): void => finish({ kind: "stopped" });
      const onOpen = (): void => {
        if (over) return;
        clearTimeout(connectTimer);
        openedAt = Date.now();
        stopPolling();
        setState("open", "opened");
        armIdle();
      };
      const onMessage = (event: { data?: unknown }): void => {
        if (over) return;
        clearTimeout(pongTimer);
        armIdle();
        const data = event.data;
        if (typeof data !== "string") {
          emit("ignoring a frame: it is not text");
          return;
        }
        if (data === PONG) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          emit("ignoring a frame: it is not JSON");
          return;
        }
        const roomEvent = roomEventFromFrame(sessionId, parsed);
        if (!roomEvent) {
          emit("ignoring a frame: it is not an event");
          return;
        }
        accept(roomEvent);
      };
      const onError = (): void => finish(openedAt === undefined ? { kind: "failed", timedOut: false } : ended(false));
      const onClose = (event: { code?: number }): void =>
        finish(openedAt === undefined ? { kind: "failed", timedOut: false } : ended(false, event.code));

      life.signal.addEventListener("abort", onAbort, { once: true });
      socket.addEventListener("open", onOpen);
      socket.addEventListener("message", onMessage);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
    });
  }

  // ------------------------------------------------------------------ the loop

  /**
   * Attempt, and when an attempt ends, decide what that means. This is the whole of the policy:
   *
   * - an open socket that ends is a drop. Only a connection that lasted `stableMs` makes the next
   *   wait start again from the base; one that opens and is gone at once does not, or a server that
   *   accepts and closes would be asked again within a second, for ever.
   * - a handshake that failed is asked about, once (`probeStatus`), and the status decides: 409 is the
   *   room being over (stop, after one poll for what was missed), 401 is a credential that is not
   *   accepted, anything else is waited out.
   * - `degradeAfter` failures in a row, or a 401, and the room is polled until the socket returns.
   */
  async function drive(): Promise<void> {
    let failures = 0;
    /** The credential a 401 last answered: nothing is attempted with it again. */
    let refused: string | undefined;
    let retriedAfter401 = false;
    let carried: string | undefined;

    const pause = async (why: Why): Promise<void> => {
      const degraded = failures >= degradeAfter || refused !== undefined;
      if (degraded) startPolling();
      setState(degraded ? "degraded" : "connecting", why);
      const wait = backoffDelay(Math.max(failures, 1) - 1, baseMs, degraded ? degradedCapMs : capMs, random);
      await sleep(wait, life.signal);
    };

    while (!life.signal.aborted) {
      let credential = carried;
      carried = undefined;
      if (credential === undefined) {
        try {
          const read = await orAbort(readCredential(), life.signal);
          if (read === ABORTED) return;
          credential = read;
        } catch (error) {
          emit(`could not read the credential: ${messageOf(error)}`);
          failures += 1;
          await pause("unusable");
          continue;
        }
      }

      if (credential === refused) {
        // The server has already refused this very string, and a second try cannot go differently.
        // The room is being polled; this tick only looks for a credential that has changed, which
        // costs no request, and the next one that has changed is attempted at once. It counts as a
        // failure all the same, so that the looks themselves back off: the provider may be reading a
        // file, and a look every half second for ever is not what "not tried again" should cost.
        failures += 1;
        await pause("unauthorized");
        continue;
      }

      const end = await attempt(credential);
      if (end.kind === "stopped" || life.signal.aborted) return;

      if (end.kind === "ended") {
        failures = (end.heldMs >= stableMs ? 0 : failures) + 1;
        refused = undefined;
        retriedAfter401 = false;
        emit(
          end.silent
            ? `the socket stopped answering after ${end.heldMs} ms; abandoning it`
            : `the socket closed after ${end.heldMs} ms${end.code === undefined ? "" : ` (code ${end.code})`}`
        );
        await pause(end.silent ? "silent" : "dropped");
        continue;
      }

      failures += 1;
      if (end.kind === "unusable") {
        emit(`cannot open a socket: ${messageOf(end.error)}`);
        await pause("unusable");
        continue;
      }

      // The handshake did not complete. A timeout was not answered by anyone, so there is nothing to
      // ask about; anything else gets one more request, to read the status.
      const status = end.timedOut
        ? undefined
        : await probeStatus(roomSocketUrl(options.url, sessionId, cursor), credential, life.signal, connectTimeoutMs);
      if (life.signal.aborted) return;

      if (status === 409) {
        emit("the upgrade was refused with 409: the room is closed");
        await tail();
        stop("closed");
        return;
      }

      if (status === 401) {
        refused = credential;
        let again: string | undefined;
        try {
          const read = await orAbort(readCredential(), life.signal);
          if (read === ABORTED) return;
          again = read;
        } catch {
          again = undefined;
        }
        if (again !== undefined && again !== credential && !retriedAfter401) {
          // A token that rotated between being read and being refused. Once: a provider that hands
          // out a new string every time must not turn this into a loop.
          retriedAfter401 = true;
          carried = again;
          emit("the upgrade was refused with 401, and the credential has changed since: trying it at once");
          continue;
        }
        emit(
          "the upgrade was refused with 401: this credential is not accepted. It is not tried again; " +
            "the room is polled until the credential changes"
        );
        await pause("unauthorized");
        continue;
      }

      const why: Why = end.timedOut ? "timeout" : status === undefined || status === 101 ? "unreachable" : "refused";
      emit(
        end.timedOut
          ? `the upgrade got no answer in ${connectTimeoutMs} ms`
          : status === undefined
            ? "the upgrade failed and the server could not be asked why"
            : status === 101
              ? "the upgrade failed, and was accepted when asked again"
              : `the upgrade was refused with ${status}`
      );
      await pause(why);
    }
  }

  const driverDone: Promise<void> = drive().catch((error: unknown) => {
    // A bug here must not take the room with it, nor the process: an unhandled rejection ends a Node
    // process. The fallback is the one thing that does not depend on this loop.
    emit(`the socket loop failed: ${messageOf(error)}; polling instead`);
    startPolling();
    setState("degraded", "unusable");
  });

  return {
    sessionId,
    get cursor() {
      return cursor;
    },
    get state() {
      return state;
    },
    stopped,
    async close() {
      stop("requested");
      await Promise.all([driverDone, pollDone]);
    },
  };
}
