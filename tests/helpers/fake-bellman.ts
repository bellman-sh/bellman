import http from "node:http";
import type { Duplex } from "node:stream";
import { ignoreResets } from "./upgrade-socket.js";
import { resolveIdentity } from "../../src/auth.js";
import {
  handleOAuth, identityFromAccessToken, unauthorizedHeaders, type OAuthConfig,
} from "../../src/oauth/routes.js";
import { MemoryAuthStore } from "../../src/oauth/storage.js";
import { signJwt } from "../../src/oauth/tokens.js";
import { PING, PONG } from "../../src/keepalive.js";
import { publicEvent } from "../../src/public-event.js";
import type { Identity, SessionEvent } from "../../src/types.js";
import { ClientFrames, OPCODE, binaryFrame, closeCodeOf, closeFrame, handshake, textFrame } from "./ws-wire.js";

/**
 * A `fetch` that is the real Bellman: the real handleOAuth for every OAuth
 * path, and a minimal JSON-RPC /mcp that demands a token minted for itself.
 * Nothing about the protocol is mocked — only the upstream identity provider
 * and the network are.
 *
 * `rooms()` below adds the one thing a `fetch` cannot be: a listener that
 * completes a real WebSocket upgrade at /ws, so Node's own client can be
 * pointed at it.
 */

export const ISSUER = "https://mcp.example.test";
export const RESOURCE = "https://mcp.example.test/mcp";

const upstream = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.startsWith("https://github.com/login/oauth/access_token")) {
    return Response.json({ access_token: "gh_upstream_token" });
  }
  if (url === "https://api.github.com/user") {
    return Response.json({ id: 4242, login: "mcfearsome", email: null });
  }
  if (url === "https://api.github.com/user/emails") {
    return Response.json([{ email: "jesse@example.dev", primary: true, verified: true }]);
  }
  return new Response("unexpected upstream call", { status: 500 });
}) as typeof fetch;

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export interface FakeBellman {
  fetch: typeof fetch;
  config: OAuthConfig;
  /** Every /register body the client sent — length is the registration count. */
  registrations: unknown[];
  /** Drives the browser half: authorize page -> provider -> loopback. */
  browser(authorizeUrl: URL): Promise<void>;
  /**
   * Mint a fresh token pair from a refresh token, the way a SECOND bridge
   * would. Spends the one given — refresh tokens rotate on use — so afterwards
   * that token is dead and the pair returned is what the file would hold.
   */
  refresh(refreshToken: string, clientId: string): Promise<TokenPair>;
  /**
   * The same server on a real listener, with rooms behind /ws. A `fetch` cannot
   * complete a WebSocket upgrade, and the point of this one is that Node's own
   * client really does connect to it. It shares this fake's identity, so an
   * access token the OAuth endpoints mint is accepted at /ws as it is at /mcp.
   * The caller closes it.
   */
  rooms(options?: FakeRoomsOptions): Promise<FakeRooms>;
}

export interface FakeBellmanOptions {
  overrides?: Record<string, Identity>;
  /**
   * The server's own origin. A second fake needs a DIFFERENT one rather than a
   * URL rewrite: tokens carry an RFC 8707 resource indicator derived from the
   * server URL, and /authorize refuses any resource that is not its own
   * (`invalid_target`). Two servers means two origins, all the way down.
   */
  origin?: string;
}

export function fakeBellman({ overrides = {}, origin = ISSUER }: FakeBellmanOptions = {}): FakeBellman {
  const config: OAuthConfig = {
    issuer: origin,
    resource: `${origin}/mcp`,
    secret: "test-signing-secret",
    store: new MemoryAuthStore(),
    credentials: { github: { clientId: "gh-id", clientSecret: "gh-secret" } },
    overrides,
    fetchImpl: upstream,
  };
  const registrations: unknown[] = [];

  const serve: typeof fetch = async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    const url = new URL(request.url);

    if (url.pathname === "/register" && request.method === "POST") {
      registrations.push(await request.clone().json());
    }

    if (url.pathname !== "/mcp") {
      const handled = await handleOAuth(request, config);
      return handled ?? new Response("not found", { status: 404 });
    }

    // ------------------------------------------------------------- /mcp
    if (request.method === "GET") return new Response("no sse", { status: 405 });

    const header = request.headers.get("authorization") ?? "";
    const identity = header.toLowerCase().startsWith("bearer ")
      ? await identityFromAccessToken(header.slice(7).trim(), config)
      : null;
    if (!identity) {
      return new Response("unauthorized", { status: 401, headers: unauthorizedHeaders(config) });
    }

    const body = (await request.json()) as { method?: string; id?: unknown };
    if (body.id === undefined) return new Response(null, { status: 202 }); // a notification

    const result =
      body.method === "initialize"
        ? {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "bellman", version: "0.1.0" },
          }
        : body.method === "tools/list"
          ? { tools: [{ name: "bellman_start", description: "start", inputSchema: { type: "object" } }] }
          : {};

    return Response.json(
      { jsonrpc: "2.0", id: body.id, result },
      { headers: { "content-type": "application/json" } }
    );
  };

  return {
    fetch: serve,
    config,
    registrations,
    /**
     * What a human's browser does: load /authorize, pick GitHub, let the
     * provider come back, and follow the final redirect to the loopback — that
     * last hop with the REAL fetch, because the listener is a real server.
     */
    async browser(authorizeUrl: URL): Promise<void> {
      const page = await (await serve(authorizeUrl)).text();
      const req = /\/authorize\/github\?req=([^"]+)/.exec(page)?.[1];
      if (!req) throw new Error(`no provider link on the authorize page: ${page.slice(0, 200)}`);
      const back = await serve(`${origin}/callback/github?code=gh_code&state=${req}`, { redirect: "manual" });
      const location = back.headers.get("location");
      if (!location) throw new Error(`callback did not redirect: ${back.status}`);
      /**
       * One connection per request. fetch pools keep-alive connections by
       * origin, and every test here rebinds the same loopback ports, so a
       * pooled connection to a listener an earlier test closed can be handed to
       * this request, which then fails with ECONNRESET. Which pair of tests
       * trips it depends on event-loop timing, so no delay cures it; not
       * pooling does.
       */
      await fetch(location, { headers: { connection: "close" } });
    },
    async refresh(refreshToken, clientId) {
      const response = await serve(`${origin}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
        }).toString(),
      });
      if (!response.ok) throw new Error(`refresh failed: ${response.status} ${await response.text()}`);
      return (await response.json()) as TokenPair;
    },
    rooms: (roomOptions) => serveRooms(config, roomOptions),
  };
}

// ---------------------------------------------------------------------------
// /ws: rooms behind a real WebSocket handshake
// ---------------------------------------------------------------------------
//
// What this is a fake OF. The checks run in the order src/worker.ts's /ws route
// runs them, with its statuses: 405 for a method that is not GET, 426 for a
// request that is not an upgrade, 400 for a missing session or a cursor that is
// not a non-negative integer, 401 for a caller with no identity, 403 for an
// identity that owns no member in an open room, 404 for one that owns none in a
// closed or unknown room, 409 for a closed room that it does own a member in. A
// room then behaves as SessionDO does: it replays what the client missed and
// registers the socket in the same turn, sends each later event to every socket
// that is behind it, answers PING with PONG without any handler running, and
// closes a socket that sends anything else with 1003.
//
// What it is not. The route logic is a copy, not the Worker: src/worker.ts
// imports `cloudflare:workers` and cannot be loaded into this program, so
// tests/worker-ws.test.ts is what pins the real statuses and this file has to be
// kept in step with it by hand. Cloudflare's edge, workerd's hibernation and its
// auto-response are not here either; they are why the server half has its own
// workerd tests. This exists so a CLIENT can be driven through a real handshake.

export interface FakeRoomsOptions {
  /**
   * Static bearer keys, as the Worker's BELLMAN_KEYS map. The object is held and
   * not copied, so a test revokes a key by deleting it.
   */
  keys?: Record<string, Identity>;
}

/** One request /ws answered, as the listener saw it. */
export interface UpgradeRecord {
  /** The request target exactly as sent: path and query. */
  target: string;
  session: string | null;
  cursor: string | null;
  authorization: string | undefined;
  userAgent: string | undefined;
  /** 101 for an accepted socket, the status it was refused with, or "stalled" for a handshake never answered. */
  answered: number | "stalled";
}

/** What bellman_sync hands back for one member, minus the untrusted envelope the tool boundary adds. */
export interface FakePoll {
  events: Array<ReturnType<typeof publicEvent>>;
  cursor: number;
  closed: boolean;
}

/** A socket a room accepted. */
export interface FakeSocket {
  readonly room: FakeRoom;
  /** The credential in the Authorization header, as sent. */
  readonly bearer: string;
  /** What the Durable Object's attachment would hold: the highest cursor sent to this socket. */
  cursor: number;
  /** Every text frame the client sent, in order. */
  readonly received: string[];
  /** Set once the client sends a close frame. */
  closedByClient?: { code: number | undefined };
  readonly open: boolean;
  /** A raw text frame, for the tests that want one the server would never send. */
  send(text: string): void;
  sendBinary(bytes: Buffer): void;
}

export interface FakeRoom {
  readonly id: string;
  /** Every event so far, as the Durable Object stores it: fromUserId and all. */
  readonly events: readonly SessionEvent[];
  readonly closed: boolean;
  readonly sockets: readonly FakeSocket[];
  /** userId to the member ids that identity owns here, which is what SessionDO.membersOf reads. */
  members: Record<string, string[]>;
  /** How many bellman_sync-style polls ran, and the most that were ever in flight at once. */
  readonly polls: { started: number; active: number; maxActive: number };
  /** Store an event, then send it to every open socket that is behind it. Returns the stored event. */
  append(event?: Partial<Omit<SessionEvent, "cursor">>): SessionEvent;
  /** The room ends. With `announce`, the session_expired event the real expiry appends goes out first. */
  close(options?: { announce?: boolean }): void;
  /** bellman_sync's contract for one of your members: the others' events, the cursor counting all of them. */
  poll(memberId: string, since: number, waitMs: number, signal?: AbortSignal): Promise<FakePoll>;
  /** Every socket drops with no close frame: a connection that was cut. */
  drop(): void;
  /** Every socket is sent a close frame with this code. */
  closeSockets(code: number, reason?: string): void;
  /** While on, sockets neither answer nor deliver, as a connection that is open on one side only does. */
  silence(on?: boolean): void;
}

export interface FakeRooms {
  /** This listener's /mcp URL, which is what a bridge's BELLMAN_URL looks like. */
  readonly url: string;
  readonly keys: Record<string, Identity>;
  /** Every request /ws has answered, oldest first. */
  readonly upgrades: UpgradeRecord[];
  /** Every text frame any client has sent to any room, in order. A client that is dropped and reconnects does not take its history with it. */
  readonly received: string[];
  /** The room with this id, made on first use. */
  room(id: string, members?: Record<string, string[]>): FakeRoom;
  /** Every socket open now, in any room. */
  readonly sockets: FakeSocket[];
  /** Answer the next `times` upgrades with this status, whoever they are from. */
  refuse(status: number, times?: number): void;
  /** Take the TCP connection of the next `times` upgrades and never answer the handshake. */
  stall(times?: number): void;
  /** Accept the next `times` upgrades and close each socket at once. */
  flap(times?: number): void;
  /** Stop refusing, stalling and flapping. */
  clearFaults(): void;
  /** An access token for this identity, minted the way the token endpoint does. A negative ttl is already expired. */
  mintToken(identity: Identity, ttlSeconds?: number): Promise<string>;
  close(): Promise<void>;
}

class Peer implements FakeSocket {
  readonly received: string[] = [];
  closedByClient?: { code: number | undefined };
  readonly #reader = new ClientFrames();

  constructor(
    readonly room: Room,
    private readonly raw: Duplex,
    readonly bearer: string,
    public cursor: number,
    private readonly everything: string[]
  ) {
    raw.on("data", (chunk: Buffer) => this.#onData(chunk));
    // An http.Server's sockets are half-open by default: a client that vanishes sends a FIN and
    // nothing here would ever answer it, so the peer would stay registered for ever. A real
    // server ends its side when the other has ended.
    raw.on("end", () => raw.end());
    raw.on("close", () => room.detach(this));
    raw.on("error", () => {});
  }

  get open(): boolean {
    return !this.raw.destroyed && this.raw.writable;
  }

  /** Bytes toward the client. A silenced room swallows them, which is what a half-open connection does. */
  write(bytes: Buffer): void {
    if (this.room.silent || !this.open) return;
    this.raw.write(bytes);
  }

  send(text: string): void {
    this.write(textFrame(text));
  }

  sendBinary(bytes: Buffer): void {
    this.write(binaryFrame(bytes));
  }

  drop(): void {
    this.raw.destroy();
  }

  #onData(chunk: Buffer): void {
    let frames;
    try {
      frames = this.#reader.push(chunk);
    } catch {
      this.raw.destroy();
      return;
    }
    for (const frame of frames) {
      // Recorded even when silenced, so a test can see what a client sent into the
      // void. Answered only when not: a half-open connection hears nothing.
      if (frame.opcode === OPCODE.text) {
        const text = frame.payload.toString("utf8");
        this.received.push(text);
        this.everything.push(text);
        if (this.room.silent) continue;
        // setWebSocketAutoResponse(PING, PONG): the runtime answers that exact
        // text. Any other frame reaches webSocketMessage, which closes a
        // receive-only socket with 1003. These are the SAME constants SessionDO
        // registers (src/keepalive.ts, #144), so this fake can no longer go on
        // agreeing with the client while the real server drifts — which it
        // would have, when each file held its own copy.
        if (text === PING) this.send(PONG);
        else this.write(closeFrame(1003, "This socket is receive-only."));
      } else if (frame.opcode === OPCODE.close) {
        this.closedByClient = { code: closeCodeOf(frame.payload) };
        if (this.room.silent) continue;
        // webSocketClose answers a close with ws.close(1000): that is what completes the handshake.
        this.write(closeFrame(1000, "closing"));
        this.raw.end();
      }
    }
  }
}

class Room implements FakeRoom {
  readonly events: SessionEvent[] = [];
  closed = false;
  silent = false;
  readonly sockets: Peer[] = [];
  readonly polls = { started: 0, active: 0, maxActive: 0 };
  readonly #waiters = new Set<() => void>();

  constructor(
    readonly id: string,
    public members: Record<string, string[]>,
    private readonly everything: string[]
  ) {}

  /** The 101 is already written. Replay and registration share one turn, as in SessionDO.fetch. */
  attach(raw: Duplex, bearer: string, since: number): Peer {
    const peer = new Peer(this, raw, bearer, since, this.everything);
    const missed = this.events.filter((e) => e.cursor > since);
    for (const e of missed) peer.write(textFrame(JSON.stringify(publicEvent(e))));
    if (missed.length > 0) peer.cursor = missed[missed.length - 1].cursor;
    this.sockets.push(peer);
    return peer;
  }

  detach(peer: Peer): void {
    const at = this.sockets.indexOf(peer);
    if (at >= 0) this.sockets.splice(at, 1);
  }

  append(partial: Partial<Omit<SessionEvent, "cursor">> = {}): SessionEvent {
    const cursor = this.events.length + 1;
    const event: SessionEvent = {
      type: "message",
      fromMemberId: "m_peer",
      fromUserId: "u_peer",
      fromLabel: "peer@laptop",
      payload: { text: `event ${cursor}` },
      refId: null,
      at: Date.UTC(2026, 9, 3, 12, 0, cursor),
      ...partial,
      cursor,
    };
    this.events.push(event);
    for (const peer of this.sockets) {
      if (event.cursor <= peer.cursor) continue;
      peer.write(textFrame(JSON.stringify(publicEvent(event))));
      // Advanced even when the bytes were swallowed, as SessionDO's wake() advances a socket's
      // cursor after a send that returned (store-do.ts): a reconnect replays from the cursor
      // its client names (fetch), which is what makes that safe.
      peer.cursor = event.cursor;
    }
    this.#wake();
    return event;
  }

  close({ announce = false }: { announce?: boolean } = {}): void {
    if (announce) {
      this.append({
        type: "session_expired", fromMemberId: "system", fromUserId: "system", fromLabel: "bellman",
        payload: { reason: "expired" },
      });
    }
    this.closed = true;
    this.#wake();
  }

  async poll(memberId: string, since: number, waitMs: number, signal?: AbortSignal): Promise<FakePoll> {
    const stats = this.polls;
    stats.started++;
    stats.active++;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    try {
      const deadline = Date.now() + waitMs;
      for (;;) {
        const newer = this.events.filter((e) => e.cursor > since);
        const remaining = deadline - Date.now();
        if (newer.length > 0 || this.closed || remaining <= 0 || signal?.aborted) {
          return {
            events: newer.filter((e) => e.fromMemberId !== memberId).map((e) => publicEvent(e)),
            cursor: newer.length > 0 ? newer[newer.length - 1].cursor : since,
            closed: this.closed,
          };
        }
        await new Promise<void>((resolve) => {
          const done = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            this.#waiters.delete(done);
            resolve();
          };
          const timer = setTimeout(done, remaining);
          signal?.addEventListener("abort", done, { once: true });
          this.#waiters.add(done);
        });
      }
    } finally {
      stats.active--;
    }
  }

  drop(): void {
    for (const peer of [...this.sockets]) peer.drop();
  }

  closeSockets(code: number, reason = ""): void {
    for (const peer of this.sockets) peer.write(closeFrame(code, reason));
  }

  silence(on = true): void {
    this.silent = on;
  }

  #wake(): void {
    for (const waiter of [...this.#waiters]) waiter();
  }
}

async function serveRooms(config: OAuthConfig, options: FakeRoomsOptions = {}): Promise<FakeRooms> {
  const keys = options.keys ?? {};
  const upgrades: UpgradeRecord[] = [];
  const received: string[] = [];
  const byId = new Map<string, Room>();
  const connections = new Set<Duplex>();
  const faults = { refuse: { status: 0, left: 0 }, stall: 0, flap: 0 };

  /** The Worker's resolveCaller: an OAuth access token first, then the static key map. */
  async function resolveCaller(header: string | undefined): Promise<Identity | null> {
    const bearer = header?.replace(/^Bearer\s+/i, "").trim() ?? "";
    let identity = bearer ? await identityFromAccessToken(bearer, config) : null;
    // The map is always handed over, empty included: resolveIdentity falls back to
    // the dev table when it is given none.
    if (!identity) identity = resolveIdentity(header, JSON.stringify(keys));
    return identity;
  }

  async function onUpgrade(req: http.IncomingMessage, socket: Duplex): Promise<void> {
    socket.on("error", () => {});
    const url = new URL(req.url ?? "/", "http://fake");
    const record: UpgradeRecord = {
      target: req.url ?? "",
      session: url.searchParams.get("session"),
      cursor: url.searchParams.get("cursor"),
      authorization: req.headers.authorization,
      userAgent: req.headers["user-agent"],
      answered: "stalled",
    };
    upgrades.push(record);
    const refuse = (status: number, text: string): void => {
      record.answered = status;
      socket.end(
        `HTTP/1.1 ${status} ${text}\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(text)}\r\n` +
          `connection: close\r\n\r\n${text}`
      );
    };

    // Faults stand in for what happens before Bellman is reached: an edge that is down, a
    // proxy that eats the handshake. They come first, so they hide nothing behind them.
    if (faults.stall > 0) {
      faults.stall--;
      return;
    }
    if (faults.refuse.left > 0) {
      faults.refuse.left--;
      return refuse(faults.refuse.status, "injected refusal");
    }

    if (req.method !== "GET") return refuse(405, "Method not allowed");
    if (req.headers.upgrade !== "websocket") return refuse(426, "Expected a WebSocket upgrade");
    const sessionId = url.searchParams.get("session");
    if (!sessionId) return refuse(400, "Missing session");
    const raw = url.searchParams.get("cursor") ?? "";
    const cursor = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(cursor)) {
      return refuse(400, "cursor must be a non-negative integer");
    }
    const identity = await resolveCaller(req.headers.authorization);
    if (!identity) return refuse(401, "Unauthorized");

    const room = byId.get(sessionId);
    const memberIds = room?.members[identity.userId] ?? [];
    const closed = !room || room.closed;
    if (memberIds.length === 0) return refuse(closed ? 404 : 403, closed ? "Not found" : "Forbidden");
    if (closed) return refuse(409, "This room is closed");

    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") return refuse(400, "Missing Sec-WebSocket-Key");
    record.answered = 101;
    socket.write(handshake(key));
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
    room!.attach(socket, bearer, cursor);
    if (faults.flap > 0) {
      faults.flap--;
      socket.end(closeFrame(1012, "service restart"));
    }
  }

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://fake").pathname;
    res.writeHead(pathname === "/ws" ? 426 : 404, { "content-type": "text/plain" });
    res.end(pathname === "/ws" ? "Expected a WebSocket upgrade" : "not found");
  });
  server.on("connection", (connection) => {
    connections.add(connection);
    connection.on("close", () => connections.delete(connection));
  });
  server.on("upgrade", (req, socket) => {
    // The .catch below handles onUpgrade REJECTING. It does not handle an 'error' on
    // the socket, which after 'upgrade' has no listener of http.Server's left, so a
    // peer that resets takes the whole run down (see ignoreResets).
    ignoreResets(socket);
    onUpgrade(req, socket).catch(() => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the fake listener has no port");

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    keys,
    upgrades,
    received,
    room(id, members = {}) {
      let room = byId.get(id);
      if (!room) byId.set(id, (room = new Room(id, members, received)));
      return room;
    },
    get sockets() {
      return [...byId.values()].flatMap((room) => room.sockets);
    },
    refuse(status, times = Infinity) {
      faults.refuse = { status, left: times };
    },
    stall(times = Infinity) {
      faults.stall = times;
    },
    flap(times = Infinity) {
      faults.flap = times;
    },
    clearFaults() {
      faults.refuse = { status: 0, left: 0 };
      faults.stall = 0;
      faults.flap = 0;
    },
    mintToken: (identity, ttlSeconds = 600) =>
      signJwt(
        { iss: config.issuer, sub: identity.userId, aud: config.resource, bellman: identity },
        config.secret,
        ttlSeconds
      ),
    async close() {
      for (const connection of connections) connection.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
