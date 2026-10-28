/**
 * The join a desktop app asks for with BELLMAN_JOIN_CODE (#435), done by the bridge over the real tool handlers: a
 * private room is joined and watched, a public one and a code the server refuses are not, each said in the bridge's own
 * words, and the code is in nothing the bridge reports or logs.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveIdentity } from "../src/auth.js";
import { createBridge, type Remote } from "../src/bridge.js";
import { buildServer } from "../src/server.js";
import { publicRoom, startRoom } from "./helpers/flows.js";
import { DEV_KEY, Harness } from "./helpers/harness.js";

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
  const bridge = createBridge({ delivery: "channel", remote, pollWaitSeconds: 1, log: (line) => logged.push(line) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "claude-code", version: "0.0.1" });
  client.fallbackNotificationHandler = async () => {};
  await Promise.all([bridge.server.connect(serverSide), client.connect(clientSide)]);
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
