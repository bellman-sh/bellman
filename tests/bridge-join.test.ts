/**
 * The join a desktop app asks for with BELLMAN_JOIN_CODE (#435), done by the bridge over the real tool handlers: a
 * private room is joined and watched, a public one and a code the server refuses are not, each said in the bridge's own
 * words, and the code is in nothing the bridge reports or logs.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { resolveIdentity } from "../src/auth.js";
import { createBridge, type Remote } from "../src/client/bridge.js";
import { buildServer } from "../src/server.js";
import { publicRoom, startRoom } from "./helpers/flows.js";
import { meRoutes } from "../src/http/me.js";
import { bindRepoRoom } from "../src/room/repo-room.js";
import type { RoomCaller } from "../src/http/rooms.js";
import { DEV_KEY, Harness } from "./helpers/harness.js";
import { bridgeClient, tmpInbox } from "./helpers/bridge-client.js";

/** A swarm room, so its code still seats someone after the creator's own seat. */
const SWARM = {
  room: "swarm", mode: "swarm",
  roles: { lead: { can: ["send", "invite", "revoke"] }, helper: { can: ["send"] } },
  default_role: "helper", creator_role: "lead",
};

let h: Harness;
const teardown: Array<() => Promise<void>> = [];
beforeEach(() => { h = new Harness(); });
afterEach(async () => {
  await Promise.all(teardown.splice(0).map((close) => close()));
  await h.close();
});

/** A bridge signed in as `peer`, over the real handlers, with every log line kept. */
async function bridgeAsPeer() {
  const identity = resolveIdentity(`Bearer ${DEV_KEY.peer}`)!;
  const logged: string[] = [];
  const remote = async (): Promise<Remote> => {
    const server = buildServer(identity, h.store, h.blobs, { hostedSeat: true });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const upstream = new Client({ name: "bridge-remote", version: "0.0.1" });
    await Promise.all([server.connect(serverSide), upstream.connect(clientSide)]);
    return {
      listTools: () => upstream.listTools(),
      callTool: (params) => upstream.callTool(params) as Promise<CallToolResult>,
      close: () => upstream.close(),
    };
  };
  const bridge = createBridge({ delivery: "hook", inboxDir: tmpInbox(), remote, pollWaitSeconds: 1, log: (line) => logged.push(line) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = bridgeClient("claude-code");
  client.fallbackNotificationHandler = async () => {};
  await Promise.all([bridge.serve(serverSide), client.connect(clientSide)]);
  teardown.push(async () => {
    await bridge.close();
    await client.close();
  });
  return { bridge, logged };
}

describe("the bridge's join from BELLMAN_JOIN_CODE", () => {
  it("joins a private room, watches the seat, and reports the role and what it may do", async () => {
    const { sessionId, started } = await startRoom(await h.connect(DEV_KEY.jesse), SWARM);
    const code = String(started.data.join_code);
    const { bridge, logged } = await bridgeAsPeer();
    const joined = await bridge.join(code, "colony");
    expect(joined).toMatchObject({ state: "joined", session_id: sessionId, role: "helper", verbs: ["send"] });
    expect(bridge.joinState()).toEqual(joined);
    const memberId = (joined as { member_id: string }).member_id;
    expect(bridge.watching().map((w) => w.member_id)).toEqual([memberId]);
    const brief = (await h.store.getBriefs(sessionId, [memberId]))[memberId];
    expect(brief?.goal).toBe("Joined from the colony project");
    expect(JSON.stringify([joined, logged])).not.toContain(code);
  });

  it("refuses a public room before confirming, and seats no one", async () => {
    const { sessionId, code } = await publicRoom(h);
    const before = (await h.store.getSession(sessionId))!.members.length;
    const { bridge, logged } = await bridgeAsPeer();
    const refused = await bridge.join(code, "colony");
    expect(refused).toEqual({
      state: "refused",
      from: "code",
      reason: "the room is public, and a session never joins a public room on its own. Join it with bellman_connect if you mean to",
    });
    expect((await h.store.getSession(sessionId))!.members.length).toBe(before);
    expect(bridge.watching()).toEqual([]);
    expect(JSON.stringify([refused, logged])).not.toContain(code);
  });

  it("refuses a code the server refuses in its own words, and logs the server's", async () => {
    const { bridge, logged } = await bridgeAsPeer();
    const refused = await bridge.join("qk-not-a-code", "colony");
    expect(refused).toMatchObject({ state: "refused" });
    expect((refused as { reason: string }).reason).toMatch(/^the join code was refused: it may have expired/);
    expect(logged.some((line) => line.startsWith("join refused: "))).toBe(true);
    expect(bridge.watching()).toEqual([]);
  });

  it("reports nothing when it was given no code", async () => {
    const { bridge } = await bridgeAsPeer();
    expect(bridge.joinState()).toBeUndefined();
  });
});

/** A bridge signed in as `key`, whose own-credential HTTP calls reach the real `/me` routes. */
async function bridgeWithRoutes(key: string, { list = true, hangLeave = false } = {}) {
  const identity = resolveIdentity(`Bearer ${key}`)!;
  const logged: string[] = [];
  const remote = async (): Promise<Remote> => {
    const server = buildServer(identity, h.store, h.blobs, { hostedSeat: true });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const upstream = new Client({ name: "bridge-remote", version: "0.0.1" });
    await Promise.all([server.connect(serverSide), upstream.connect(clientSide)]);
    return {
      listTools: () => upstream.listTools(),
      callTool: (params) =>
        hangLeave && params.name === "bellman_leave" ? new Promise<CallToolResult>(() => {}) : (upstream.callTool(params) as Promise<CallToolResult>),
      close: () => upstream.close(),
    };
  };
  const caller = async (request: Request): Promise<RoomCaller | null> => {
    const who = resolveIdentity(request.headers.get("authorization") ?? undefined);
    return who ? { identity: who, via: "bearer" } : null;
  };
  const posted: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) =>
    (posted.push(`${init?.method ?? "GET"} ${String(input)}`), await meRoutes(new Request(input, init), { store: h.store, caller, panelOrigins: [] })) ?? new Response(null, { status: 404 })) as typeof fetch;
  const bridge = createBridge({
    delivery: "hook", inboxDir: tmpInbox(), remote, pollWaitSeconds: 1, log: (line) => logged.push(line),
    upload: { serverUrl: "https://mcp.example.test", bearer: () => key, fetchImpl }, leaveTimeoutMs: 200,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = bridgeClient("claude-code");
  await Promise.all([bridge.serve(serverSide), client.connect(clientSide)]);
  // As Claude Code does after the handshake: the bound join waits for it.
  if (list) await client.listTools();
  teardown.push(async () => {
    await bridge.close();
    await client.close();
  });
  return { bridge, logged, identity, posted, client };
}

const REMOTE = "github.com/bellman-sh/bellman";

describe("the bridge's join from the repo's default room", () => {
  it("seats the account in the bound room and watches it", async () => {
    const { sessionId } = await startRoom(await h.connect(DEV_KEY.jesse), SWARM);
    const { bridge, identity } = await bridgeWithRoutes(DEV_KEY.jesse);
    expect((await bindRepoRoom(h.store, identity, { remote: REMOTE, sessionId, role: "helper" })).ok).toBe(true);
    const joined = await bridge.joinBound(REMOTE, "bellman");
    expect(joined).toMatchObject({ state: "joined", session_id: sessionId, role: "helper", verbs: ["send"], from: "repo" });
    const memberId = (joined as { member_id: string }).member_id;
    expect(bridge.watching().map((w) => w.member_id)).toEqual([memberId]);
    expect((await h.store.getSession(sessionId))!.members.find((m) => m.memberId === memberId)?.via).toBe("binding");
  });

  it("asks Bellman nothing before the first tools/list", async () => {
    const { bridge, posted, client } = await bridgeWithRoutes(DEV_KEY.jesse, { list: false });
    const pending = bridge.joinBound(REMOTE, "bellman");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(posted).toEqual([]);
    await client.listTools();
    expect(await pending).toBeUndefined();
    // Unbound: the account's own list is read, and the remote never leaves the machine.
    expect(posted).toEqual(["GET https://mcp.example.test/me/repo-rooms"]);
  });

  it("seats no one when the repo has no binding", async () => {
    const { bridge } = await bridgeWithRoutes(DEV_KEY.jesse);
    expect(await bridge.joinBound(REMOTE, "bellman")).toBeUndefined();
    expect(bridge.joinState()).toBeUndefined();
    expect(bridge.watching()).toEqual([]);
  });

  it("refuses in its own words when the bound room has closed", async () => {
    const { sessionId } = await startRoom(await h.connect(DEV_KEY.jesse), SWARM);
    const { bridge, identity } = await bridgeWithRoutes(DEV_KEY.jesse);
    await bindRepoRoom(h.store, identity, { remote: REMOTE, sessionId, role: "helper" });
    await h.store.closeSession(sessionId);
    expect(await bridge.joinBound(REMOTE, "bellman")).toEqual({
      state: "refused", from: "repo",
      reason: "the room it names is closed, public, or no longer takes that role. Change it in the dash",
    });
  });
});

describe("the bridge leaving its bound seats", () => {
  it("leaves the seat it took from the repo's default room on close, and keeps the one joined from a code", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const { sessionId, started } = await startRoom(jesse, SWARM);
    const { bridge, identity } = await bridgeWithRoutes(DEV_KEY.jesse);
    await bindRepoRoom(h.store, identity, { remote: REMOTE, sessionId, role: "helper" });
    const bound = (await bridge.joinBound(REMOTE, "bellman")) as { member_id: string };
    const coded = (await bridge.join(String(started.data.join_code), "bellman")) as { member_id: string };
    expect(bridge.watching().length).toBe(2);
    await bridge.close();
    expect((await h.store.getMember(sessionId, bound.member_id))?.leftAt).toEqual(expect.any(Number));
    expect((await h.store.getMember(sessionId, coded.member_id))?.leftAt ?? null).toBeNull();
  });

  it("closes without trying when it never connected", async () => {
    const { bridge } = await bridgeWithRoutes(DEV_KEY.jesse, { list: false });
    await bridge.close();
    expect(bridge.watching()).toEqual([]);
  });

  it("does not hold close past its bound when the leave never answers", async () => {
    const { sessionId } = await startRoom(await h.connect(DEV_KEY.jesse), SWARM);
    const { bridge, identity } = await bridgeWithRoutes(DEV_KEY.jesse, { hangLeave: true });
    await bindRepoRoom(h.store, identity, { remote: REMOTE, sessionId, role: "helper" });
    await bridge.joinBound(REMOTE, "bellman");
    const at = Date.now();
    await bridge.close();
    expect(Date.now() - at).toBeLessThan(2_000);
  });
});
