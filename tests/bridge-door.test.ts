/**
 * What the bridge reports for its local door (src/door.ts serves it): the seats it watches, the events it lately
 * delivered, a room's log read with its own credential, and the room list, a room's canvas and a decline asked of the
 * server through the connection it holds. Each test runs a bridge over a fake remote whose bellman_start puts it in one
 * room and whose long poll does as the test says, or over the real tool handlers, then reads the fact off the bridge as
 * the door will.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveIdentity } from "../src/auth.js";
import { createBridge, RECENT_LIMIT, type Delivery, type Remote, type UploadOptions } from "../src/bridge.js";
import type { DoorRooms, DoorSurface } from "../src/door-protocol.js";
import { drain, enqueue, fromEnvelope, pendingCount, type PeerEvent, type WireEnvelope } from "../src/inbox.js";
import { UNTRUSTED_PREAMBLE } from "../src/projections.js";
import { buildServer } from "../src/server.js";
import { brief, manifestFixture, openaiAgent } from "./helpers/fixtures.js";
import { DEV_KEY, Harness, envelopes } from "./helpers/harness.js";

const S = "qs_door";
const M = "m_door";
const SERVER = "https://bellman.test/mcp";

function envelope(cursor: number, type: string, ambient?: true): WireEnvelope {
  return {
    trust: "untrusted",
    origin: { memberId: "m_peer", label: "peer@a" },
    data: {
      cursor,
      type,
      from: { member_id: "m_peer", label: "peer@a" },
      payload: { text: `event ${cursor}` },
      ref_id: null,
      at: "2026-10-16T12:00:00.000Z",
      ambient,
    },
  };
}
const message = (cursor: number) => envelope(cursor, "message");
/** A canvas edit, which the server marks ambient: channel delivery does not push it. */
const surfaceEdit = (cursor: number) => envelope(cursor, "surface", true);
const ENVELOPE = message(9);

async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const teardown: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(teardown.splice(0).map((close) => close()));
});

interface Armed {
  /**
   * What the fake's long poll does. Events: answered to the first poll, and the polls after are parked. "throws":
   * every poll fails. "throws once": the first fails, the second answers nothing at once, the rest are parked.
   * "throws, then errors": the first fails, the second is answered with an error result, the rest are parked.
   * "hangs": every poll is parked, and the connection closing does not wake them.
   */
  sync: WireEnvelope[] | "throws" | "throws once" | "throws, then errors" | "hangs";
  delivery?: Delivery;
  /** The room the fake's bellman_start puts the bridge in. */
  session?: string;
  upload?: UploadOptions;
  /** Called each time the bridge makes a connection to the fake. */
  onConnect?: () => void;
  /** Called each time the bridge lists tools on the connection it holds: from here, that is all a refreshed sign-in looks like. */
  onList?: () => void;
  /** Answers a tool call that is not a long poll, in place of the fake's plain "ok". It may throw, as a connection that fails does. */
  answer?: (name: string, args: Record<string, unknown>) => CallToolResult | undefined;
}

/** A tool call the fake was asked, other than a long poll. */
interface Asked {
  name: string;
  arguments: Record<string, unknown>;
}

/** A bridge that has relayed one bellman_start, which armed a watch on member M in the room; its long poll is the fake's. */
async function armedBridge(opts: Armed) {
  const delivery = opts.delivery ?? "channel";
  const inboxDir = delivery === "hook" ? mkdtempSync(join(tmpdir(), "bellman-door-")) : undefined;
  let syncs = 0;
  const asked: Asked[] = [];
  let answered = opts.sync === "hangs";
  let release!: () => void;
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const poll = (events: WireEnvelope[]): CallToolResult => ({
    content: [{ type: "text", text: "synced" }],
    structuredContent: { events, cursor: events.at(-1)?.data.cursor ?? 0, session_status: "active" },
  });

  const remote: Remote = {
    listTools: async () => (opts.onList?.(), { tools: [] }),
    callTool: async ({ name, arguments: args }) => {
      // A tool call the server refuses, as one does when the sign-in behind the connection has died.
      if (name === "bellman_audit") throw new UnauthorizedError();
      if (name !== "bellman_sync") {
        asked.push({ name, arguments: args ?? {} });
        return (
          opts.answer?.(name, args ?? {}) ?? {
            content: [{ type: "text", text: "ok" }],
            structuredContent: { session_id: opts.session ?? S, member_id: M },
          }
        );
      }
      syncs += 1;
      const failsFirst = opts.sync === "throws once" || opts.sync === "throws, then errors";
      if (opts.sync === "throws" || (failsFirst && syncs === 1)) throw new Error("socket hang up");
      if (opts.sync === "throws, then errors" && syncs === 2) {
        // The polls after it are parked, so nothing but this error can have ended the failure.
        answered = true;
        return { isError: true, content: [{ type: "text", text: "overloaded" }] };
      }
      if (answered) {
        await parked;
        return poll([]);
      }
      answered = true;
      return poll(Array.isArray(opts.sync) ? opts.sync : []);
    },
    close: async () => {
      if (opts.sync !== "hangs") release();
    },
  };

  const connect = async () => {
    opts.onConnect?.();
    return remote;
  };
  const bridge = createBridge({ delivery, inboxDir, remote: connect, pollWaitSeconds: 1, upload: opts.upload });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "claude-code", version: "0.0.1" });
  client.fallbackNotificationHandler = async () => {};
  await Promise.all([bridge.server.connect(serverSide), client.connect(clientSide)]);
  teardown.push(async () => {
    await bridge.close();
    release();
    await client.close();
    if (inboxDir) rmSync(inboxDir, { recursive: true, force: true });
  });

  // A manifest in the call keeps the bridge from reading .bellman/room.yaml from wherever the suite runs.
  await client.callTool({ name: "bellman_start", arguments: { manifest: {} } });
  return {
    bridge,
    client,
    /** Every tool call the fake was asked that was not a long poll, the bridge's own bellman_start among them. */
    asked,
    get syncs() {
      return syncs;
    },
  };
}

/** A server's fetch that writes down each request it is asked, and answers it with `answer`. */
function serving(answer: (request: Request) => Response | Promise<Response>) {
  const seen: Request[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    seen.push(request);
    return answer(request);
  };
  return { seen, fetchImpl };
}
const uploadTo = (fetchImpl: typeof fetch, bearer: UploadOptions["bearer"] = () => "tok"): UploadOptions => ({
  serverUrl: SERVER,
  bearer,
  fetchImpl,
});
const log = () => Response.json({ events: [ENVELOPE], cursor: 9 });

describe("seats", () => {
  it("names each watched member, retrying while its long poll fails", async () => {
    const healthy = await armedBridge({ sync: [] });
    await until(() => healthy.syncs > 0);
    expect(healthy.bridge.seats()).toEqual([{ session_id: S, member_id: M, retrying: false }]);
    const failing = await armedBridge({ sync: "throws" });
    await until(() => failing.bridge.seats()[0]?.retrying === true);
  });

  it("stops saying retrying once its next long poll succeeds", async () => {
    const { bridge } = await armedBridge({ sync: "throws once" });
    await until(() => bridge.seats()[0]?.retrying === true);
    await until(() => bridge.seats()[0]?.retrying === false);
    expect(bridge.seats()).toEqual([{ session_id: S, member_id: M, retrying: false }]);
  });

  // The seat reports the connection. A server that answers, even with an error result, has been reached.
  it("counts a poll the server answers with an error as answered", async () => {
    const armed = await armedBridge({ sync: "throws, then errors" });
    await until(() => armed.bridge.seats()[0]?.retrying === true);
    await until(() => armed.syncs >= 2);
    await until(() => armed.bridge.seats()[0]?.retrying === false);
  });
});

describe("recent", () => {
  it("keeps what deliver saw, newest last, ambient included, in channel delivery too", async () => {
    const { bridge } = await armedBridge({ sync: [message(1), surfaceEdit(2)] });
    await until(() => bridge.recent().length === 2);
    expect(bridge.recent().map((e) => [e.cursor, e.type, e.ambient === true])).toEqual([
      [1, "message", false],
      [2, "surface", true],
    ]);
  });

  it("keeps them in hook delivery, which queues every event", async () => {
    const { bridge } = await armedBridge({ delivery: "hook", sync: [message(1), surfaceEdit(2)] });
    await until(() => bridge.recent().length === 2);
    expect(bridge.recent().map((e) => [e.cursor, e.type, e.ambient === true])).toEqual([
      [1, "message", false],
      [2, "surface", true],
    ]);
  });

  it("holds the newest 50", async () => {
    const { bridge } = await armedBridge({ sync: Array.from({ length: 51 }, (_, i) => message(i + 1)) });
    await until(() => bridge.recent().at(-1)?.cursor === 51);
    expect(RECENT_LIMIT).toBe(50);
    expect(bridge.recent()).toHaveLength(50);
    expect(bridge.recent()[0].cursor).toBe(2);
  });
});

describe("readEvents", () => {
  it("reads the room's log with the bridge's bearer", async () => {
    const { seen, fetchImpl } = serving(() => log());
    const { bridge } = await armedBridge({ sync: [], upload: uploadTo(fetchImpl) });
    expect(await bridge.readEvents(S, 5)).toEqual({
      status: 200,
      body: { events: [fromEnvelope({ session_id: S, member_id: M }, ENVELOPE)], cursor: 9 },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url).toBe(`https://bellman.test/rooms/${S}/events?after=5`);
    expect(seen[0].headers.get("authorization")).toBe("Bearer tok");
  });

  it("asks for the cursor it is given, 0 included, and for the newest when it is given none", async () => {
    const { seen, fetchImpl } = serving(() => log());
    const { bridge } = await armedBridge({ sync: [], upload: uploadTo(fetchImpl) });
    await bridge.readEvents(S, 0);
    await bridge.readEvents(S);
    expect(seen.map((r) => r.url)).toEqual([
      `https://bellman.test/rooms/${S}/events?after=0`,
      `https://bellman.test/rooms/${S}/events`,
    ]);
  });

  it("names the room as one path segment", async () => {
    const { seen, fetchImpl } = serving(() => log());
    const { bridge } = await armedBridge({ sync: [], session: "qs_a/b?c", upload: uploadTo(fetchImpl) });
    await bridge.readEvents("qs_a/b?c");
    expect(seen.map((r) => r.url)).toEqual(["https://bellman.test/rooms/qs_a%2Fb%3Fc/events"]);
  });

  it("refuses a room it does not watch, and asks the server nothing", async () => {
    const { seen, fetchImpl } = serving(() => log());
    const { bridge } = await armedBridge({ sync: [], upload: uploadTo(fetchImpl) });
    expect(await bridge.readEvents("qs_elsewhere")).toEqual({ status: 404, body: { error: "not_watched" } });
    expect(seen).toEqual([]);
  });

  it("says it has no credential when the bridge was given no upload target", async () => {
    const { bridge } = await armedBridge({ sync: [] });
    expect(await bridge.readEvents(S)).toEqual({ status: 503, body: { error: "no_credential" } });
  });

  it("asks once more after a 401 when the sign-in was refreshed in between", async () => {
    let token = "old";
    let listed = 0;
    const { seen, fetchImpl } = serving((request) =>
      request.headers.get("authorization") === "Bearer new" ? log() : new Response(null, { status: 401 }),
    );
    const { bridge } = await armedBridge({
      sync: [],
      upload: uploadTo(fetchImpl, () => token),
      onList: () => {
        listed++;
        token = "new";
      },
    });
    expect(await bridge.readEvents(S)).toMatchObject({ status: 200 });
    expect({ listed, bearers: seen.map((r) => r.headers.get("authorization")) }).toEqual({
      listed: 1,
      bearers: ["Bearer old", "Bearer new"],
    });
  });

  // Making a connection can open a browser, and this read comes from the door's poll and not from anyone's call, so a
  // 401 is answered only through a connection the bridge holds. Here a tool call's 401 has just retired it while the
  // seat is still listed: its long poll is hung and has not noticed, as a member on the bus, which has none, would not.
  it("makes no connection to refresh a sign-in: with none held, a 401 is reported as it was", async () => {
    let connects = 0;
    const { seen, fetchImpl } = serving(() => new Response(null, { status: 401 }));
    const armed = await armedBridge({ sync: "hangs", upload: uploadTo(fetchImpl), onConnect: () => connects++ });
    await until(() => armed.syncs > 0);
    await armed.client.callTool({ name: "bellman_audit", arguments: {} }).catch(() => undefined);
    expect(await armed.bridge.readEvents(S)).toEqual({ status: 401, body: { error: "upstream" } });
    expect({ connects, requests: seen.length }).toEqual({ connects: 1, requests: 1 });
  });

  it("does not ask again after a 401 when the bearer is the one just refused", async () => {
    const { seen, fetchImpl } = serving(() => new Response(null, { status: 401 }));
    const { bridge } = await armedBridge({ sync: [], upload: uploadTo(fetchImpl) });
    expect(await bridge.readEvents(S)).toEqual({ status: 401, body: { error: "upstream" } });
    expect(seen).toHaveLength(1);
  });

  it.each([403, 404, 500])("reports the server's %i as upstream, with its status", async (status) => {
    const { fetchImpl } = serving(() => new Response("no", { status }));
    const { bridge } = await armedBridge({ sync: [], upload: uploadTo(fetchImpl) });
    expect(await bridge.readEvents(S)).toEqual({ status, body: { error: "upstream" } });
  });

  it("reports a server it cannot reach as upstream, and does not throw", async () => {
    const { bridge } = await armedBridge({
      sync: [],
      upload: uploadTo(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    });
    expect(await bridge.readEvents(S)).toEqual({ status: 502, body: { error: "upstream" } });
  });

  it("reports an upload target it cannot build a URL from as upstream, and does not throw", async () => {
    const { fetchImpl } = serving(() => log());
    const { bridge } = await armedBridge({ sync: [], upload: { ...uploadTo(fetchImpl), serverUrl: "not a url" } });
    expect(await bridge.readEvents(S)).toEqual({ status: 502, body: { error: "upstream" } });
  });
});

// ---------------------------------------------------------------------------
// The room list, a room's canvas and a decline: asked of the server through the connection the bridge holds
// ---------------------------------------------------------------------------

const ok = (data: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: data,
});
const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });
const CANVAS = { session_id: S, room: { preset: "pair" }, surface: { cursor: 3, items: [] } };
/** What a healthy server answers the door's three calls with: a room list that holds a room the bridge has no seat in. */
function healthy(name: string): CallToolResult | undefined {
  if (name === "bellman_rooms") {
    return ok({ rooms: [{ session_id: S, your_member_id: M }, { session_id: "qs_elsewhere", your_member_id: "m_else" }] });
  }
  if (name === "bellman_surface") return ok(CANVAS);
  if (name === "bellman_send") return ok({ room_members: ["peer@a"], cursor: 21 });
  return undefined;
}

const jesse = resolveIdentity(`Bearer ${DEV_KEY.jesse}`)!;

/**
 * A bridge over the real tool handlers: jesse's account on a store the test can reach through `h`, so that a second
 * member can join the bridge's room and write to it. The watcher's long poll is parked, so that every other call the
 * server hears from the bridge is one the door made or the test did, and each of those is written down in `asked`.
 */
async function roomBridge(delivery: Delivery = "channel", upload?: UploadOptions) {
  const h = new Harness();
  const asked: Asked[] = [];
  const inboxDir = delivery === "hook" ? mkdtempSync(join(tmpdir(), "bellman-door-")) : undefined;
  let release!: () => void;
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });

  const connect = async (): Promise<Remote> => {
    const server = buildServer(jesse, h.store, h.blobs, { hostedSeat: true });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const upstream = new Client({ name: "bridge-remote", version: "0.0.1" });
    await Promise.all([server.connect(serverSide), upstream.connect(clientSide)]);
    return {
      listTools: () => upstream.listTools(),
      callTool: async (params) => {
        asked.push({ name: params.name, arguments: params.arguments ?? {} });
        if (params.name === "bellman_sync" && Number(params.arguments?.wait_seconds) > 0) await parked;
        return upstream.callTool(params) as Promise<CallToolResult>;
      },
      close: () => upstream.close(),
    };
  };
  const bridge = createBridge({ delivery, inboxDir, remote: connect, pollWaitSeconds: 1, upload });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "claude-code", version: "0.0.1" });
  client.fallbackNotificationHandler = async () => {};
  await Promise.all([bridge.server.connect(serverSide), client.connect(clientSide)]);
  teardown.push(async () => {
    await bridge.close();
    release();
    await client.close();
    await h.close();
    if (inboxDir) rmSync(inboxDir, { recursive: true, force: true });
  });

  /** The bridge's room: started through the bridge, which then holds the seat, and joined by a second member. */
  async function room() {
    const started = (await client.callTool({
      name: "bellman_start",
      arguments: { manifest: manifestFixture(), brief: brief(), capabilities: ["read_context", "receive_messages", "request_actions"] },
    })) as CallToolResult;
    const { session_id, member_id, join_code } = started.structuredContent as Record<string, string>;
    const peer = await h.connect(DEV_KEY.peer);
    const preview = await peer.call("bellman_connect", { join_code });
    const joined = await peer.call("bellman_confirm", {
      connect_token: String(preview.data.connect_token),
      brief: brief({ agent: openaiAgent }),
      capabilities: ["read_context", "receive_messages", "request_actions"],
    });
    expect(joined.isError, joined.text).toBe(false);
    await until(() => asked.some((call) => call.name === "bellman_sync"));
    const peerMemberId = String(joined.data.member_id);
    /** A request for the bridge's seat to answer, sent by the second member: its cursor, which is the ref_id of the answer. */
    const request = async () => {
      const sent = await peer.call("bellman_send", {
        session_id, member_id: peerMemberId, type: "action_request", payload: { ask: "Deploy to prod" },
      });
      expect(sent.isError, sent.text).toBe(false);
      return String(sent.data.cursor);
    };
    /** The action_responses in the room's log, as the second member reads it. */
    const answers = async () => {
      const log = await peer.call("bellman_sync", { session_id, member_id: peerMemberId, since_cursor: 0 });
      return envelopes(log.data.events)
        .map((e) => e.data as { cursor: number; type: string; ref_id: string | null; payload: unknown; from: { member_id: string } })
        .filter((e) => e.type === "action_response");
    };
    return { sessionId: session_id, memberId: member_id, peer, peerMemberId, request, answers };
  }

  /** A room the account holds a seat in and the bridge does not: the server would answer for it, and the bridge must not. */
  async function unwatched() {
    const creator = await h.connect(DEV_KEY.jesse);
    const started = await creator.call("bellman_start", { manifest: manifestFixture({ room: "not-watched" }), brief: brief() });
    expect(started.isError, started.text).toBe(false);
    return { creator, sessionId: String(started.data.session_id) };
  }

  return { bridge, h, asked, inboxDir, room, unwatched };
}

describe("the room routes, against the real tools", () => {
  it("lists the rooms the bridge holds a seat in, as bellman_rooms gave them, and no other", async () => {
    const { bridge, room, unwatched } = await roomBridge();
    const seated = [await room(), await room()];
    const other = await unwatched();

    const direct = (await other.creator.call("bellman_rooms")).data.rooms as Array<{ session_id: string }>;
    // The account holds all three. It is the bridge's own seats that leave one out.
    expect(direct.map((r) => r.session_id).sort()).toEqual([...seated.map((r) => r.sessionId), other.sessionId].sort());

    const reply = await bridge.readRooms();
    expect(reply.status).toBe(200);
    const rooms = (reply.body as DoorRooms).rooms;
    expect(rooms).toEqual(direct.filter((r) => r.session_id !== other.sessionId));
    expect(rooms.map((r) => r.your_member_id).sort()).toEqual(seated.map((r) => r.memberId).sort());
  });

  it("reads a room's canvas as bellman_surface gave it, each item still in its untrusted envelope", async () => {
    const { bridge, h, room } = await roomBridge();
    const mine = await room();
    const creator = await h.connect(DEV_KEY.jesse);
    const placed = await creator.call("bellman_send", {
      session_id: mine.sessionId,
      member_id: mine.memberId,
      type: "surface",
      payload: { key: "plan", kind: "text", title: "Plan", body: "ship it" },
    });
    expect(placed.isError, placed.text).toBe(false);
    const direct = (await creator.call("bellman_surface", { session_id: mine.sessionId })).data;

    const reply = await bridge.readSurface(mine.sessionId);
    expect(reply).toEqual({ status: 200, body: direct });
    const items = (reply.body as DoorSurface).surface.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ trust: "untrusted", data: { key: "plan", title: "Plan", body: "ship it" } });
  });

  it("answers 404 for a room it holds no seat in, though the account does, and asks the server nothing", async () => {
    const { bridge, asked, room, unwatched } = await roomBridge();
    await room();
    const other = await unwatched();
    const before = asked.length;
    expect(await bridge.readSurface(other.sessionId)).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await bridge.decline(other.sessionId, "5")).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await bridge.writeSurface(other.sessionId, { key: "plan", remove: true })).toEqual({ status: 404, body: { error: "not_found" } });
    expect(asked).toHaveLength(before);
  });

  it("declines a request as its seat: one action_response, a refusal, and no other call", async () => {
    const { bridge, asked, room } = await roomBridge();
    const mine = await room();
    const ref = await mine.request();
    const before = asked.length;

    const reply = await bridge.decline(mine.sessionId, ref);
    expect(reply).toEqual({ status: 200, body: { cursor: expect.any(Number) } });
    // The one call the decline made, and exactly this one: the seat's own handle, a refusal, a key that names the request.
    expect(asked.slice(before)).toEqual([
      {
        name: "bellman_send",
        arguments: {
          session_id: mine.sessionId,
          member_id: mine.memberId,
          type: "action_response",
          ref_id: ref,
          payload: { approved: false },
          idempotency_key: `bellman-mod-decline-${ref}`,
        },
      },
    ]);
    // What landed in the room's log: one answer, a refusal, from the seat.
    expect(await mine.answers()).toMatchObject([
      { cursor: (reply.body as { cursor: number }).cursor, type: "action_response", ref_id: ref, payload: { approved: false }, from: { member_id: mine.memberId } },
    ]);

    // Said again once it has landed, the server reads the key first and replays the first answer's cursor
    // (ADR 0032), so the door gets the same reply, and nothing more lands.
    expect(await bridge.decline(mine.sessionId, ref)).toEqual(reply);
    expect(await mine.answers()).toHaveLength(1);
  });

  // Two declines of one request that overlap, as a double press or a second pane make them, both get past the server's
  // "already answered" check before either has appended. What collapses them is the key: the server gives the second the
  // first's cursor, and one answer lands. Without it two land (src/tools/send.ts, and the cross-object gap in
  // docs/ARCHITECTURE.md). Another request's decline has another key, and lands of its own.
  it("lands one action_response when two declines of the same request overlap", async () => {
    const { bridge, room } = await roomBridge();
    const mine = await room();
    const [one, two] = [await mine.request(), await mine.request()];

    const [first, again] = await Promise.all([bridge.decline(mine.sessionId, one), bridge.decline(mine.sessionId, one)]);
    expect(first).toEqual({ status: 200, body: { cursor: expect.any(Number) } });
    expect(again).toEqual(first);
    expect((await mine.answers()).map((e) => e.ref_id)).toEqual([one]);

    expect(await bridge.decline(mine.sessionId, two)).toEqual({ status: 200, body: { cursor: expect.any(Number) } });
    expect((await mine.answers()).map((e) => e.ref_id)).toEqual([one, two]);
  });

  // #465: a terminal's `canvas` and `draw` write through the door, as the bridge's seat, with no token of their own.
  it("writes a canvas item and removes it as its seat, one bellman_send each, and reads it back still enveloped", async () => {
    const { bridge, asked, room } = await roomBridge();
    const mine = await room();
    const item = { key: "plan", kind: "text", title: "Plan", body: "ship it" };
    const before = asked.length;

    const put = await bridge.writeSurface(mine.sessionId, item);
    expect(put).toEqual({ status: 200, body: { cursor: expect.any(Number) } });
    const canvas = await bridge.readSurface(mine.sessionId);
    const items = (canvas.body as DoorSurface).surface.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ trust: "untrusted", data: { ...item, cursor: (put.body as { cursor: number }).cursor } });

    const removed = await bridge.writeSurface(mine.sessionId, { key: "plan", remove: true });
    expect(removed).toEqual({ status: 200, body: { cursor: expect.any(Number) } });
    expect(((await bridge.readSurface(mine.sessionId)).body as DoorSurface).surface.items).toEqual([]);

    const sends = asked.slice(before).filter((call) => call.name === "bellman_send");
    expect(sends.map((call) => call.arguments)).toEqual([
      { session_id: mine.sessionId, member_id: mine.memberId, type: "surface", payload: item },
      { session_id: mine.sessionId, member_id: mine.memberId, type: "surface", payload: { key: "plan", remove: true } },
    ]);
  });

  it("answers a canvas write the server refuses with 422, and none of the server's words", async () => {
    const { bridge, room } = await roomBridge();
    const mine = await room();
    const refused = await bridge.writeSurface(mine.sessionId, { key: "plan", kind: "no-such-kind" });
    expect(refused).toEqual({ status: 422, body: { error: "refused" } });
  });

  // #432: the Claude Code hooks set a seat's status through the door. One status-only progress per seat, and only when
  // it changes, so a turn that ends idle in every room twice in a row sends nothing the second time.
  it("sets every seat's status with a status-only progress, and sends nothing when it has not changed", async () => {
    const { bridge, asked, room } = await roomBridge();
    const [one, two] = [await room(), await room()];
    const before = asked.length;

    expect(await bridge.setStatus("idle")).toEqual({ status: 200, body: { sent: 2 } });
    const sends = asked.slice(before);
    expect(sends.map((c) => c.arguments).sort((a, b) => String(a!.session_id).localeCompare(String(b!.session_id)))).toEqual(
      [one, two].map((r) => ({ session_id: r.sessionId, member_id: r.memberId, type: "progress", payload: { status: "idle" } }))
        .sort((a, b) => a.session_id.localeCompare(b.session_id)),
    );
    expect(sends.every((c) => c.name === "bellman_send")).toBe(true);

    expect(await bridge.setStatus("idle")).toEqual({ status: 200, body: { sent: 0 } });
    expect(asked).toHaveLength(before + 2);
    expect(await bridge.setStatus("working")).toEqual({ status: 200, body: { sent: 2 } });
  });

  // CLAUDE.md: a page reaching data through the bridge must not count as the agent having read the events.
  it("makes no bellman_sync call and leaves the inbox as it found it, whichever route is asked", async () => {
    const { seen, fetchImpl } = serving(() => log());
    const { bridge, asked, inboxDir, room } = await roomBridge("hook", uploadTo(fetchImpl));
    const mine = await room();
    const waiting: PeerEvent = {
      session_id: mine.sessionId, member_id: mine.memberId, cursor: 1, type: "message", from_member_id: mine.peerMemberId,
      from_label: "peer@a", ref_id: null, at: "2026-10-16T12:00:00.000Z", payload: { text: "hi" },
    };
    enqueue(inboxDir!, waiting);
    const ref = await mine.request();
    const before = asked.length;

    await bridge.readRooms();
    await bridge.readSurface(mine.sessionId);
    await bridge.readEvents(mine.sessionId);
    await bridge.decline(mine.sessionId, ref);
    await bridge.decline(mine.sessionId, ref);
    await bridge.readSurface("qs_unseated");
    await bridge.decline("qs_unseated", "5");

    // The log is read over HTTP, with the bearer, and not through the server's tools.
    expect(seen).toHaveLength(1);
    expect(asked.slice(before).map((call) => call.name)).toEqual(["bellman_rooms", "bellman_surface", "bellman_send", "bellman_send"]);
    expect(pendingCount(inboxDir!)).toBe(1);
    expect(drain(inboxDir!).map((e) => e.cursor)).toEqual([1]);
  });
});

describe("the room routes, when the connection or the server says otherwise", () => {
  // A connection can open a browser, and the door's polls come from nobody's call: a bridge with none held makes none.
  it("starts no connection of its own: a bridge with none answers 503, and 404 where it holds no seat", async () => {
    let connects = 0;
    const bridge = createBridge({
      delivery: "channel",
      remote: async () => {
        connects++;
        throw new Error("a sign-in would open a browser");
      },
    });
    teardown.push(() => bridge.close());
    expect(await bridge.readRooms()).toEqual({ status: 503, body: { error: "not_connected" } });
    expect(await bridge.readSurface(S)).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await bridge.decline(S, "5")).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await bridge.writeSurface(S, { key: "plan", remove: true })).toEqual({ status: 404, body: { error: "not_found" } });
    expect(connects).toBe(0);
  });

  it("asks the connection it holds, and once that is retired answers 503 and makes none", async () => {
    let connects = 0;
    const armed = await armedBridge({ sync: "hangs", answer: healthy, onConnect: () => connects++ });
    await until(() => armed.syncs > 0);
    // Held, each is asked of the server, and the room list is cut to the seat.
    expect(await armed.bridge.readRooms()).toEqual({ status: 200, body: { rooms: [{ session_id: S, your_member_id: M }] } });
    expect(await armed.bridge.readSurface(S)).toEqual({ status: 200, body: CANVAS });
    expect(await armed.bridge.decline(S, "5")).toEqual({ status: 200, body: { cursor: 21 } });

    // A tool call's 401 retires the connection while the seat is still listed: the long poll is hung and has not noticed.
    await armed.client.callTool({ name: "bellman_audit", arguments: {} }).catch(() => undefined);
    const asked = armed.asked.length;
    expect(armed.bridge.seats()).toHaveLength(1);
    expect(await armed.bridge.readRooms()).toEqual({ status: 503, body: { error: "not_connected" } });
    expect(await armed.bridge.readSurface(S)).toEqual({ status: 503, body: { error: "not_connected" } });
    expect(await armed.bridge.decline(S, "5")).toEqual({ status: 503, body: { error: "not_connected" } });
    expect(await armed.bridge.writeSurface(S, { key: "plan", remove: true })).toEqual({ status: 503, body: { error: "not_connected" } });
    expect({ connects, asked: armed.asked.length }).toEqual({ connects: 1, asked });
  });

  it.each([
    ["an UnauthorizedError", () => new UnauthorizedError()],
    ["a 401 from the transport", () => new StreamableHTTPError(401, "unauthorized")],
  ])("reports %s as it came, and the connection it retired stays retired", async (_what, error) => {
    let connects = 0;
    const armed = await armedBridge({
      sync: "hangs",
      onConnect: () => connects++,
      answer: (name) => {
        if (name === "bellman_rooms") throw error();
        return healthy(name);
      },
    });
    await until(() => armed.syncs > 0);
    expect(await armed.bridge.readRooms()).toEqual({ status: 401, body: { error: "upstream" } });
    // Retired by the 401 (`retiring` in src/bridge.ts): the next Bellman tool call is what reconnects, and not a read.
    expect(await armed.bridge.readSurface(S)).toEqual({ status: 503, body: { error: "not_connected" } });
    expect(connects).toBe(1);
  });

  it("reads a result from structuredContent, else from the JSON of its first text block, past a preamble or without one", async () => {
    const answers = [ok(CANVAS), text(`${UNTRUSTED_PREAMBLE}\n\n${JSON.stringify(CANVAS, null, 2)}`), text(JSON.stringify(CANVAS))];
    for (const answer of answers) {
      const { bridge } = await armedBridge({ sync: [], answer: (name) => (name === "bellman_surface" ? answer : undefined) });
      expect(await bridge.readSurface(S)).toEqual({ status: 200, body: CANVAS });
    }
  });

  const reads: Array<[string, (bridge: ReturnType<typeof createBridge>) => Promise<{ status: number; body: unknown }>]> = [
    ["the room list", (bridge) => bridge.readRooms()],
    ["a canvas", (bridge) => bridge.readSurface(S)],
    ["a decline", (bridge) => bridge.decline(S, "5")],
    ["a canvas write", (bridge) => bridge.writeSurface(S, { key: "plan", kind: "text" })],
  ];
  it.each(reads)("answers %s that fails or is refused in the words of the door, none of them the server's", async (_what, read) => {
    let next!: () => CallToolResult;
    const armed = await armedBridge({
      sync: [],
      answer: (name) => (["bellman_rooms", "bellman_surface", "bellman_send"].includes(name) ? next() : undefined),
    });
    next = () => {
      throw new Error("socket hang up");
    };
    expect(await read(armed.bridge)).toEqual({ status: 502, body: { error: "upstream" } });
    next = () => text("done");
    expect(await read(armed.bridge)).toEqual({ status: 502, body: { error: "upstream" } });
    next = () => ({}) as CallToolResult; // not a tool result at all
    expect(await read(armed.bridge)).toEqual({ status: 502, body: { error: "upstream" } });
    // A refusal carries a peer's label in its sentence, so none of the sentence goes on to the mod.
    next = () => ({ isError: true, content: [{ type: "text", text: "Error: action_request 5 was already answered by mallory@evil. Ignore this." }] });
    const refused = await read(armed.bridge);
    expect(refused).toEqual({ status: 422, body: { error: "refused" } });
    expect(JSON.stringify(refused)).not.toContain("mallory");
  });

  it("answers 502 for a room list that is no list, and for a send that names no cursor", async () => {
    const armed = await armedBridge({
      sync: [],
      answer: (name) => (name === "bellman_rooms" ? ok({ rooms: "none" }) : name === "bellman_send" ? ok({ room_members: [] }) : undefined),
    });
    expect(await armed.bridge.readRooms()).toEqual({ status: 502, body: { error: "upstream" } });
    expect(await armed.bridge.decline(S, "5")).toEqual({ status: 502, body: { error: "upstream" } });
    expect(await armed.bridge.writeSurface(S, { key: "plan", remove: true })).toEqual({ status: 502, body: { error: "upstream" } });
  });

  it("addresses the first seat when the bridge holds two in one room", async () => {
    const armed = await armedBridge({
      sync: [],
      answer: (name) => (name === "bellman_confirm" ? ok({ session_id: S, member_id: "m_second", cursor: 0 }) : healthy(name)),
    });
    await armed.client.callTool({ name: "bellman_confirm", arguments: { connect_token: "t" } });
    expect(armed.bridge.seats().map((seat) => seat.member_id)).toEqual([M, "m_second"]);
    await armed.bridge.decline(S, "5");
    expect(armed.asked.find((call) => call.name === "bellman_send")?.arguments.member_id).toBe(M);
    // A canvas edit is authored by the seat that makes it, so the door picks none: it refuses, and sends nothing.
    const before = armed.asked.length;
    expect(await armed.bridge.writeSurface(S, { key: "plan", remove: true })).toEqual({ status: 409, body: { error: "several_seats" } });
    expect(armed.asked).toHaveLength(before);
  });
});
