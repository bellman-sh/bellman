import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, Notification } from "@modelcontextprotocol/sdk/types.js";
import { resolveIdentity } from "../src/auth.js";
import { createBridge, type BridgeBus, type Remote } from "../src/bridge.js";
import { busPath } from "../src/bus.js";
import { createBusLink } from "../src/bus-link.js";
import { busCredentials, readServer } from "../src/credentials.js";
import type { PeerEvent } from "../src/inbox.js";
import { identityFromAccessToken, unauthorizedHeaders } from "../src/oauth/routes.js";
import { buildServer } from "../src/server.js";
import { MemoryBlobStore } from "../src/blobs.js";
import { connectSignedIn } from "../src/signin.js";
import { MemoryStore, type BellmanStore } from "../src/store.js";
import { fakeBellman, RESOURCE, type FakeBellman, type FakeRoom, type FakeRooms } from "./helpers/fake-bellman.js";
import { brief, manifestFixture } from "./helpers/fixtures.js";
import { DEV_KEY } from "./helpers/harness.js";

/**
 * #43's definition of done, run together: the properties tests/bus.test.ts, tests/room-socket.test.ts,
 * tests/bus-link.test.ts and tests/bridge-bus.test.ts each prove for their own layer, here through the whole stack
 * and in one room.
 *
 * What is real. Every bridge is `createBridge` with a bus it builds for itself: the election, the Unix socket
 * between bridges, the coordinator's window and the room's WebSocket are the shipped code, and the WebSocket
 * completes a real handshake with tests/helpers/fake-bellman.ts. The tool handlers are the server's own, over one
 * in-memory store, and each room is mirrored from that store onto the fake /ws as SessionDO's wake() would.
 *
 * What is not. The bridges share one process, so "killing the coordinator" is `bridge.close()`: what channel.ts
 * runs on SIGTERM and on stdin closing. What a SIGKILL adds is a socket file nobody is listening on, and
 * tests/bus.test.ts's "unlinks a stale socket left by a SIGKILLed coordinator and takes over" is where that
 * is run. The fake is not Cloudflare, and hibernation is not here: tests/worker-ws.test.ts and the smoke run are.
 */

const caps = ["read_context", "receive_messages", "request_actions"];
const jesse = resolveIdentity(`Bearer ${DEV_KEY.jesse}`)!;
const peer = resolveIdentity(`Bearer ${DEV_KEY.peer}`)!;

/** Every wait of a room's socket cut down, as in tests/bridge-bus.test.ts. The keepalive is off. */
const FAST_ROOM = {
  baseMs: 5,
  capMs: 40,
  degradedCapMs: 60,
  degradeAfter: 3,
  connectTimeoutMs: 250,
  stableMs: 150,
  pingIntervalMs: 0,
  pongTimeoutMs: 250,
  pollFloorMs: 20,
};

interface Call { name: string; args: Record<string, unknown> }

interface Session {
  client: Client;
  pushed: Notification[];
  bridge: ReturnType<typeof createBridge>;
  /** Every call the bridge made to Bellman, its watchers' polls included, and the agent's own too. */
  calls: Call[];
  call(name: string, args?: Record<string, unknown>): Promise<{ isError: boolean; data: Record<string, unknown>; text: string }>;
}

let store: BellmanStore;
let rooms: FakeRooms;
let tmp: string;
let root: string;
let opened: Session[];
let mirrors: Array<() => Promise<void>>;
let cleanups: Array<() => Promise<void>>;
let logs: string[];

beforeEach(async () => {
  store = new MemoryStore();
  rooms = await fakeBellman().rooms({ keys: { [DEV_KEY.jesse]: jesse, [DEV_KEY.peer]: peer } });
  // Short, because a socket path is limited to about a hundred bytes.
  tmp = mkdtempSync(join(tmpdir(), "be-"));
  root = join(tmp, "bus");
  opened = [];
  mirrors = [];
  cleanups = [];
  logs = [];
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map(async (s) => {
    await s.bridge.close();
    await s.client.close();
  }));
  await Promise.all(mirrors.splice(0).map((stop) => stop()));
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await rooms.close();
  rmSync(tmp, { recursive: true, force: true });
});

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean | Promise<boolean>, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await wait(10);
  }
}

// ---------------------------------------------------------------------------
// Bridges
// ---------------------------------------------------------------------------

/** One bridge's connection to Bellman: the server's own handlers, bound to the key's identity, over the shared store. */
async function remoteFor(key: string, calls: Call[]): Promise<Remote> {
  const identity = resolveIdentity(`Bearer ${key}`);
  if (!identity) throw new Error(`unknown dev key ${key}`);
  const server = buildServer(identity, store, new MemoryBlobStore(), { hostedSeat: true });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "bridge-remote", version: "0.0.1" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return {
    listTools: () => client.listTools(),
    callTool: async (params) => {
      calls.push({ name: params.name, args: params.arguments ?? {} });
      const result = (await client.callTool(params)) as CallToolResult;
      // A room's socket is let in for the members the room's own listener knows, and the creator's bridge opens
      // one as soon as it has seen this answer. Teaching the listener first means the first upgrade is accepted,
      // and a count of upgrades is then a count of connections and not of a race against the mirror below.
      const started = result.structuredContent as { session_id?: string; member_id?: string } | undefined;
      if (params.name === "bellman_start" && !result.isError && started?.session_id && started.member_id) {
        rooms.room(started.session_id, { [identity.userId]: [started.member_id] });
      }
      return result;
    },
    close: () => client.close(),
  };
}

/** The bus a bridge is given: this machine's, which every bridge here shares by having the same URL and identity. */
function busFor(key: string, over: Partial<BridgeBus> = {}): BridgeBus {
  return {
    url: rooms.url,
    identity: () => key,
    bearer: () => key,
    root,
    roomSocket: FAST_ROOM,
    ackTimeoutMs: 1500,
    cooldownMs: 400,
    ...over,
  };
}

/** `bus` is true for the machine's bus, an object for that bus with something changed, and absent for none. */
async function open(key: string, bus?: true | Partial<BridgeBus>): Promise<Session> {
  const calls: Call[] = [];
  const bridge = createBridge({
    delivery: "channel",
    remote: () => remoteFor(key, calls),
    pollWaitSeconds: 1,
    log: (message) => logs.push(message),
    ...(bus ? { bus: busFor(key, bus === true ? {} : bus) } : {}),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "claude-code", version: "0.0.1" });
  const pushed: Notification[] = [];
  client.fallbackNotificationHandler = async (n) => {
    pushed.push(n);
  };
  await Promise.all([bridge.server.connect(serverSide), client.connect(clientSide)]);
  const session: Session = {
    client, pushed, bridge, calls,
    async call(name, args = {}) {
      const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
      return {
        isError: Boolean(res.isError),
        data: (res.structuredContent ?? {}) as Record<string, unknown>,
        text: (res.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("\n"),
      };
    },
  };
  opened.push(session);
  return session;
}

/**
 * A swarm room with one member on each of three bridges. `a` and `b` are one identity, as two Claude Code sessions
 * of one person are, and `p` is somebody else: the bus is per identity, so the room has to hold two members of one.
 */
async function room3(a: Session, b: Session, p: Session) {
  const started = await a.call("bellman_start", {
    manifest: manifestFixture({ preset: "swarm" }), brief: brief(), capabilities: caps,
  });
  expect(started.isError, started.text).toBe(false);
  const sessionId = String(started.data.session_id);
  const aMember = String(started.data.member_id);
  const room = mirror(sessionId);
  const join = async (who: Session, code: unknown) => {
    const preview = await who.call("bellman_connect", { join_code: code });
    expect(preview.isError, preview.text).toBe(false);
    const confirmed = await who.call("bellman_confirm", {
      connect_token: preview.data.connect_token, brief: brief(), capabilities: caps,
    });
    expect(confirmed.isError, confirmed.text).toBe(false);
    return String(confirmed.data.member_id);
  };
  const bMember = await join(b, started.data.join_code);
  const invited = await a.call("bellman_invite", { session_id: sessionId, member_id: aMember });
  expect(invited.isError, invited.text).toBe(false);
  const pMember = await join(p, invited.data.join_code);
  return { sessionId, room, aMember, bMember, pMember };
}

/**
 * A room's events from the real store, carried onto the fake /ws as SessionDO's wake() would carry them, and the
 * members the store knows as the members the upgrade is let in for. It copies cursors rather than trusting that
 * they match, and says so loudly if they ever do not.
 */
function mirror(sessionId: string): FakeRoom {
  const fake = rooms.room(sessionId);
  let stopped = false;
  const loop = (async () => {
    let cursor = 0;
    while (!stopped) {
      const session = await store.getSession(sessionId);
      if (session) {
        const members: Record<string, string[]> = {};
        for (const m of session.members) (members[m.userId] ??= []).push(m.memberId);
        fake.members = members;
      }
      const events = await store.waitForEvents(sessionId, cursor, 40);
      for (const e of events) {
        const carried = fake.append({
          type: e.type, fromMemberId: e.fromMemberId, fromUserId: e.fromUserId, fromLabel: e.fromLabel,
          payload: e.payload, refId: e.refId, at: e.at,
        });
        if (carried.cursor !== e.cursor) {
          throw new Error(`the mirror drifted: the store says cursor ${e.cursor}, the fake says ${carried.cursor}`);
        }
        cursor = e.cursor;
      }
      if (session?.closed && !fake.closed) fake.close();
    }
  })();
  mirrors.push(async () => {
    stopped = true;
    await loop;
  });
  return fake;
}

async function send(from: Session, sessionId: string, memberId: string, text: string): Promise<void> {
  const sent = await from.call("bellman_send", { session_id: sessionId, member_id: memberId, type: "message", payload: { text } });
  // A message that was never sent proves nothing about who did not hear it.
  expect(sent.isError, `${text}: ${sent.text}`).toBe(false);
}

type ChannelParams = { content: string; meta: Record<string, string> };

/** The messages a session's human has been pushed, by the token each one's text carries (`evt-p1`, ...), in the order they came. */
const heard = (s: Session): string[] =>
  s.pushed
    .filter((n) => n.method === "notifications/claude/channel")
    .map((n) => n.params as unknown as ChannelParams)
    .filter((e) => e.meta.type === "message")
    .map((e) => /evt-[abp]\d+/.exec(e.content)?.[0] ?? `unrecognised: ${e.content}`);

const longPolls = (s: Session) => s.calls.filter((c) => c.name === "bellman_sync" && Number(c.args.wait_seconds) > 0);

const socketPath = (key: string): string => busPath({ url: rooms.url, credential: key, root });

const texts = (...ids: string[]): string[] => ids.map((id) => `evt-${id}`);

// ---------------------------------------------------------------------------
// The three
// ---------------------------------------------------------------------------

describe("two bridges, one room", () => {
  it("holds one upstream connection for the room, and both bridges hear every event", async () => {
    const a = await open(DEV_KEY.jesse, true);
    const b = await open(DEV_KEY.jesse, true);
    const p = await open(DEV_KEY.peer);
    const { sessionId, aMember, bMember, pMember } = await room3(a, b, p);
    await until(() => a.bridge.busRole() === "coordinator" && b.bridge.busRole() === "subscriber", "one coordinator and one subscriber");
    await until(() => rooms.sockets.length === 1, "the room's socket");

    for (const n of [1, 2, 3, 4, 5]) await send(p, sessionId, pMember, `evt-p${n}`);
    await send(a, sessionId, aMember, "evt-a1");
    await send(b, sessionId, bMember, "evt-b1");
    await until(() => heard(a).length === 6 && heard(b).length === 6 && heard(p).length === 2, "every bridge to hear its room");

    // Each hears everything but its own, once and in the order the room said it.
    expect(heard(a)).toEqual(texts("p1", "p2", "p3", "p4", "p5", "b1"));
    expect(heard(b)).toEqual(texts("p1", "p2", "p3", "p4", "p5", "a1"));
    expect(heard(p)).toEqual(texts("a1", "b1"));

    // One request, and it was accepted: not one connection per bridge, and not one that was refused and retried.
    expect(rooms.upgrades.map((u) => u.answered)).toEqual([101]);
    expect(rooms.sockets).toHaveLength(1);
    // And neither of the two held a long poll of its own, which is what the connection replaces.
    expect(longPolls(a)).toEqual([]);
    expect(longPolls(b)).toEqual([]);
  });

  it("hands the room to the surviving bridge when the coordinator is killed, and loses no event", async () => {
    // The new coordinator reconnects from its own cursor, and the server replays exactly what was missed. To make
    // "what was missed" certain and not a race, the new connection's handshake is held up (the room has no socket
    // at all for a while) and the room speaks into that gap.
    const slow = { roomSocket: { ...FAST_ROOM, connectTimeoutMs: 600 } };
    const a = await open(DEV_KEY.jesse, slow);
    const b = await open(DEV_KEY.jesse, slow);
    const p = await open(DEV_KEY.peer);
    const { sessionId, room, pMember } = await room3(a, b, p);
    await until(() => a.bridge.busRole() === "coordinator" && b.bridge.busRole() === "subscriber", "one coordinator and one subscriber");
    await until(() => rooms.sockets.length === 1, "the room's socket");

    for (const n of [1, 2, 3]) await send(p, sessionId, pMember, `evt-p${n}`);
    await until(() => heard(a).length === 3 && heard(b).length === 3, "both to hear the first three");
    const before = b.bridge.watching()[0].delivered;
    expect(before).toBeGreaterThan(0);

    rooms.stall(1); // the next upgrade is the survivor's
    await a.bridge.close();
    await send(p, sessionId, pMember, "evt-p4");
    await send(p, sessionId, pMember, "evt-p5");
    await until(() => room.events.some((e) => JSON.stringify(e.payload).includes("evt-p5")), "the gap's last event on the room");

    // The gap, as it stands: the room holds what the survivor has not heard, and nothing connects the two. The old
    // coordinator's socket closes on its own account, a moment after its bridge says it has closed.
    await until(() => rooms.sockets.length === 0, "the old coordinator's socket to close");
    expect(heard(b)).toEqual(texts("p1", "p2", "p3"));

    await until(() => b.bridge.busRole() === "coordinator", "the survivor to take over");
    await until(() => heard(b).length === 5, "the survivor to hear what it missed");
    await send(p, sessionId, pMember, "evt-p6");
    await until(() => heard(b).length === 6, "the survivor to hear a live event on its own connection");

    expect(heard(b)).toEqual(texts("p1", "p2", "p3", "p4", "p5", "p6")); // each once, in order
    // Both attempts the survivor made asked from where it had got to, and not from the start or the head.
    expect(rooms.upgrades.map((u) => [u.cursor, u.answered])).toEqual([
      [expect.any(String), 101], // the first coordinator's
      [String(before), "stalled"],
      [String(before), 101],
    ]);
    expect(rooms.sockets).toHaveLength(1);
    // Not one sync of any kind: the room's replay brought it what it missed. Neither a long poll (it did not fall back
    // to polling to get there) nor the bus's own catch-up, which is what would have covered a replay that came up short.
    expect(b.calls.filter((c) => c.name === "bellman_sync")).toEqual([]);
    expect(existsSync(socketPath(DEV_KEY.jesse))).toBe(true); // the survivor's own
  });

  it("serves every member by polling when the bus cannot be had, each bridge for itself", async () => {
    // Not a platform flag but the real thing: a bus directory that cannot be made, because a regular file is in the way.
    const inTheWay = join(tmp, "plain-file");
    writeFileSync(inTheWay, "");
    const unusable = { root: join(inTheWay, "bus") };
    const a = await open(DEV_KEY.jesse, unusable);
    const b = await open(DEV_KEY.jesse, unusable);
    const p = await open(DEV_KEY.peer);
    const { sessionId, aMember, bMember, pMember } = await room3(a, b, p);

    for (const n of [1, 2, 3]) await send(p, sessionId, pMember, `evt-p${n}`);
    await send(a, sessionId, aMember, "evt-a1");
    await until(() => heard(a).length === 3 && heard(b).length === 4 && heard(p).length === 1, "every member to be served");

    expect(heard(a)).toEqual(texts("p1", "p2", "p3"));
    expect(heard(b)).toEqual(texts("p1", "p2", "p3", "a1"));
    expect(heard(p)).toEqual(texts("a1"));

    // Each polled, and as its own member: this is what it did before there was a bus.
    expect(longPolls(a).length).toBeGreaterThan(0);
    expect(longPolls(b).length).toBeGreaterThan(0);
    expect(new Set(longPolls(a).map((c) => c.args.member_id))).toEqual(new Set([aMember]));
    expect(new Set(longPolls(b).map((c) => c.args.member_id))).toEqual(new Set([bMember]));
    expect(a.bridge.busRole()).toBeUndefined();
    expect(b.bridge.busRole()).toBeUndefined();
    expect(rooms.upgrades).toEqual([]); // no connection to the room at all
    expect(logs.filter((l) => l.startsWith("polling for ") && l.includes("instead of using the local bus"))).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// An expired token
// ---------------------------------------------------------------------------

/** Three ports that are free right now, for the sign-in's loopback listener. */
async function freePorts(count: number): Promise<number[]> {
  const held: net.Server[] = [];
  try {
    for (let i = 0; i < count; i++) {
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      held.push(server);
    }
    return held.map((s) => (s.address() as net.AddressInfo).port);
  } finally {
    await Promise.all(held.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  }
}

/**
 * Bellman's /mcp for a signed-in bridge: the real OAuth endpoints of the fake, and for the one tool a poll calls
 * the room's own `poll`, behind the real check of the bearer. A token the server will not verify gets the 401 a
 * real expiry gets, from the same code that decides it for /ws.
 */
function mcpOver(
  bellman: FakeBellman,
  room: FakeRoom,
  seen: { refreshes: number; upgradesAtRefresh: number[]; polls: number },
  upgrades: () => number
): typeof fetch {
  return (async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    const { pathname } = new URL(request.url);
    if (pathname === "/token" && (await request.clone().text()).includes("grant_type=refresh_token")) {
      seen.refreshes += 1;
      seen.upgradesAtRefresh.push(upgrades());
    }
    if (pathname === "/mcp" && request.method === "POST") {
      const rpc = (await request.clone().json()) as {
        id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> };
      };
      if (rpc.method === "tools/call" && rpc.params?.name === "bellman_sync") {
        const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
        if (!(await identityFromAccessToken(bearer, bellman.config))) {
          return new Response("unauthorized", { status: 401, headers: unauthorizedHeaders(bellman.config) });
        }
        seen.polls += 1;
        const args = rpc.params.arguments ?? {};
        const answer = await room.poll(
          String(args.member_id), Number(args.since_cursor ?? 0), Number(args.wait_seconds ?? 0) * 1000, request.signal
        );
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            content: [{ type: "text", text: `${answer.events.length} events` }],
            structuredContent: {
              events: answer.events.map((data) => ({
                trust: "untrusted", origin: { memberId: data.from.member_id, label: data.from.label }, data,
              })),
              cursor: answer.cursor,
              session_status: answer.closed ? "closed" : "active",
            },
          },
        });
      }
    }
    return bellman.fetch(request);
  }) as typeof fetch;
}

describe("an access token that is no longer accepted", () => {
  it("is replaced by the poll the 401 sends the room to, and the next upgrade carries the new one", async () => {
    // The chain src/credentials.ts's storedAccessToken says is built from two tested halves: a 401 on the upgrade
    // makes the room socket poll, the poll goes through the MCP connection, whose transport refreshes on its own 401
    // and writes the file, and the socket reads the file again and is let in. Here it is run once, whole.
    const bellman = fakeBellman();
    const chainRooms = await bellman.rooms();
    cleanups.push(() => chainRooms.close());
    const dir = join(tmp, "config");
    const room = chainRooms.room("qs_chain");
    const seen = { refreshes: 0, upgradesAtRefresh: [] as number[], polls: 0 };
    const browserCalls: URL[] = [];

    const remote = await connectSignedIn({
      serverUrl: RESOURCE,
      configDir: dir,
      fetchImpl: mcpOver(bellman, room, seen, () => chainRooms.upgrades.length),
      ports: await freePorts(3),
      lock: { waitMs: 5_000, heartbeatMs: 20, staleMs: 5_000 },
      callbackTimeoutMs: 5_000,
      log: (message) => logs.push(message),
      browser: async (url) => {
        browserCalls.push(url);
        await bellman.browser(url);
      },
    });
    cleanups.push(() => remote.close());
    const me = readServer(dir, RESOURCE).identity!;
    room.members = { [me.userId]: ["m_chain"] };

    // What channel.ts builds for a signed-in bridge: named by the person, signed by whatever the file holds now.
    const credentials = busCredentials(RESOURCE, undefined, () => dir);
    const heard: PeerEvent[] = [];
    const fellBack: string[] = [];
    let cursor = 0;
    const link = createBusLink({
      url: chainRooms.url,
      identity: credentials.identity,
      bearer: credentials.bearer,
      connection: () => Promise.resolve(remote),
      departed: () => false,
      pollWaitSeconds: 1,
      root: join(tmp, "chain-bus"),
      roomSocket: FAST_ROOM,
      log: (message) => logs.push(message),
    });
    cleanups.push(() => link.close());
    link.watch({
      sessionId: "qs_chain",
      memberId: "m_chain",
      cursor: () => cursor,
      onEvent: (event) => {
        heard.push(event);
        cursor = event.cursor;
      },
      onFallback: (why) => fellBack.push(why),
    });
    const said = (text: string): boolean => heard.some((e) => (e.payload as { text?: string } | null)?.text === text);

    // While the token is good the socket is let in with it.
    await until(() => chainRooms.sockets.length === 1, "the room's socket");
    const stale = readServer(dir, RESOURCE).tokens!.access_token;
    expect(chainRooms.upgrades.map((u) => [u.authorization, u.answered])).toEqual([[`Bearer ${stale}`, 101]]);
    room.append({ payload: { text: "while it was good" } });
    await until(() => said("while it was good"), "an event over the first socket");

    // To the client an expired token and one the server cannot verify are the same 401, and moving the server's signing
    // key is the way to get one with no clock to wait ten minutes on (this is not a clock expiry). Nothing signed so far
    // is accepted, /mcp and /ws alike; the refresh token is the server's own record and is untouched, as it is when an
    // access token merely expires. The connection is cut, so the next thing the room socket does is ask for a token,
    // and the room speaks while it has none.
    bellman.config.secret = "the key moved on since this token was signed";
    room.drop();
    room.append({ payload: { text: "while it had no token" } });

    await until(() => said("while it had no token"), "the event that came while the token was refused");
    await until(() => chainRooms.sockets.length === 1, "the room's socket to come back");

    const fresh = readServer(dir, RESOURCE).tokens!.access_token;
    expect(fresh).not.toBe(stale);
    const upgrades = chainRooms.upgrades.map((u) => [u.authorization, u.answered]);
    expect(upgrades[0]).toEqual([`Bearer ${stale}`, 101]);
    expect(upgrades.at(-1)).toEqual([`Bearer ${fresh}`, 101]);
    // Every request between them carried the old token and was refused: nothing guessed at another one.
    const between = upgrades.slice(1, -1);
    expect(between.length).toBeGreaterThan(0);
    expect(between.every(([auth, status]) => auth === `Bearer ${stale}` && status === 401)).toBe(true);

    // The refresh came from the poll, in the middle of that: after the first refusal and before the upgrade that worked.
    expect(seen.refreshes).toBe(1);
    expect(seen.upgradesAtRefresh[0]).toBeGreaterThan(1);
    expect(seen.upgradesAtRefresh[0]).toBeLessThan(upgrades.length);
    expect(seen.polls).toBeGreaterThan(0);
    expect(browserCalls).toHaveLength(1); // the sign-in at the start, and no human after it
    expect(fellBack).toEqual([]); // the member never stopped being served by the bus

    // The socket is the path again, and the poll that carried it over has stopped.
    room.append({ payload: { text: "after it came back" } });
    await until(() => said("after it came back"), "an event over the new socket");
    const polls = seen.polls;
    await wait(300);
    expect(seen.polls).toBe(polls);
    expect(heard.map((e) => (e.payload as { text?: string }).text)).toEqual([
      "while it was good", "while it had no token", "after it came back",
    ]);
  });
});
