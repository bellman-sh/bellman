/**
 * room_id is session_id under another name. One host's route to a local server
 * strips any tool argument named session_id before it reaches the bridge, and
 * a host that treats the name as reserved breaks every tool that needs it. So
 * every tool that takes a room takes both names, one is enough, neither is
 * refused in the handler's own words rather than by the schema.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Harness, type Peer } from "../helpers/harness.js";
import { pairUp } from "../helpers/flows.js";
import { NEED_ROOM } from "../../src/tools/kit.js";

let h: Harness;
beforeEach(() => { h = new Harness(); });
afterEach(async () => { await h.close(); });

const SWARM = {
  room: "swarm", mode: "swarm",
  roles: { lead: { can: ["send", "invite", "revoke", "request_actions", "respond_actions"] }, helper: { can: ["send"] }, observer: { can: [] } },
  default_role: "helper", creator_role: "lead",
};

const ok = async (peer: Peer, name: string, args: Record<string, unknown>) => {
  const out = await peer.call(name, args);
  expect(out.isError, `${name}: ${out.text}`).toBe(false);
  return out;
};

describe("room_id as an alias for session_id", () => {
  it("bellman_sync reads with room_id alone", async () => {
    const p = await pairUp(h);
    const out = await ok(p.creator, "bellman_sync", { room_id: p.sessionId, member_id: p.creatorMemberId, since_cursor: 0 });
    expect(Array.isArray(out.data.events)).toBe(true);
  });

  it("bellman_surface reads with room_id alone, and answers with the room's session_id", async () => {
    const p = await pairUp(h);
    const out = await ok(p.creator, "bellman_surface", { room_id: p.sessionId });
    expect(out.data.session_id).toBe(p.sessionId);
  });

  it("bellman_send writes with room_id alone", async () => {
    const p = await pairUp(h);
    await ok(p.creator, "bellman_send", { room_id: p.sessionId, member_id: p.creatorMemberId, type: "message", payload: { text: "under another name" } });
    const seen = await ok(p.joiner, "bellman_sync", { session_id: p.sessionId, member_id: p.joinerMemberId, since_cursor: p.joinerCursor });
    expect(JSON.stringify(seen.data.events)).toContain("under another name");
  });

  it("bellman_invite issues with room_id alone", async () => {
    const p = await pairUp(h, { manifest: SWARM });
    const out = await ok(p.creator, "bellman_invite", { room_id: p.sessionId, member_id: p.creatorMemberId, role: "observer" });
    expect(String(out.data.join_code)).toMatch(/^BELL-/);
  });

  it("bellman_evict removes with room_id alone", async () => {
    const p = await pairUp(h);
    await ok(p.creator, "bellman_evict", { room_id: p.sessionId, member_id: p.joinerMemberId });
    const rooms = await ok(p.joiner, "bellman_rooms", {});
    expect(rooms.data.rooms).toEqual([]);
  });

  it("bellman_leave departs with room_id alone", async () => {
    const p = await pairUp(h);
    await ok(p.joiner, "bellman_leave", { room_id: p.sessionId, member_id: p.joinerMemberId });
    const rooms = await ok(p.joiner, "bellman_rooms", {});
    expect(rooms.data.rooms).toEqual([]);
  });

  it("session_id wins when both are given, and the schema no longer refuses its absence", async () => {
    const p = await pairUp(h);
    const out = await ok(p.creator, "bellman_surface", { session_id: p.sessionId, room_id: "qs_not_this_one" });
    expect(out.data.session_id).toBe(p.sessionId);
  });

  it("refuses neither name, in the handler's words, on every tool that takes a room", async () => {
    const p = await pairUp(h);
    const calls: [string, Record<string, unknown>][] = [
      ["bellman_sync", { member_id: p.creatorMemberId, since_cursor: 0 }],
      ["bellman_surface", {}],
      ["bellman_send", { member_id: p.creatorMemberId, type: "message", payload: { text: "x" } }],
      ["bellman_invite", { member_id: p.creatorMemberId, role: "peer_b" }],
      ["bellman_evict", { member_id: p.joinerMemberId }],
      ["bellman_leave", { member_id: p.joinerMemberId }],
    ];
    for (const [name, args] of calls) {
      const out = await p.creator.call(name, args);
      expect(out.isError, name).toBe(true);
      expect(out.text, name).toContain(NEED_ROOM);
    }
  });
});
