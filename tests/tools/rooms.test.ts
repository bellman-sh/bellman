/**
 * `bellman_rooms`: the rooms the caller holds a seat in, shaped for the in-chat
 * monitor (#28). The shaping is pinned in tests/room-summary.test.ts; this file
 * drives it through MCP: which rooms a caller sees, from which seat, and what the
 * result promises about itself.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Harness, DEV_KEY, type Peer } from "../helpers/harness.js";
import { brief, manifestFixture, member } from "../helpers/fixtures.js";
import { pairUp } from "../helpers/flows.js";
import { UNTRUSTED_PREAMBLE } from "../../src/projections.js";
import { snapshotOf } from "../../src/heartbeat.js";
import { APP_RESOURCE_URI } from "../../src/ui/resource.js";

let h: Harness;
beforeEach(() => { h = new Harness(); });
afterEach(async () => { await h.close(); vi.useRealTimers(); });

interface Room {
  session_id: string;
  status: string;
  your_member_id: string;
  room: { your_role: string };
  members: { member_id: string; room_role: string; beat: Record<string, unknown> }[];
  join_codes: Record<string, unknown>[];
  last_event: { cursor: number; type: string } | null;
}

const roomsOf = async (peer: Peer) => (await peer.call("bellman_rooms")).data.rooms as Room[];

/** A swarm whose lead reports on a 5-minute cadence; the helper and observer do not. */
const SWARM = {
  room: "swarm", mode: "swarm", heartbeat_on: "5m",
  roles: {
    lead: { can: ["send", "invite", "revoke", "request_actions", "respond_actions"], reports: true },
    helper: { can: ["send"] },
    observer: { can: [] },
  },
  default_role: "helper", creator_role: "lead",
};

describe("bellman_rooms", () => {
  it("lists a room to its creator and to a member who joined, each from their own seat", async () => {
    const p = await pairUp(h);
    const [mine] = await roomsOf(p.creator);
    expect(mine.session_id).toBe(p.sessionId);
    expect(mine.your_member_id).toBe(p.creatorMemberId);
    expect(mine.room.your_role).toBe("peer_a");
    const [theirs] = await roomsOf(p.joiner);
    expect(theirs.your_member_id).toBe(p.joinerMemberId);
    expect(theirs.room.your_role).toBe("peer_b");
    expect(theirs.members.map((m) => m.room_role).sort()).toEqual(["peer_a", "peer_b"]);
  });

  it("lists a frozen room with its status, and omits a closed one", async () => {
    const p = await pairUp(h);
    await h.store.freezeSession(p.sessionId, Date.now());
    expect((await roomsOf(p.creator))[0].status).toBe("frozen");
    await h.store.closeSession(p.sessionId);
    expect(await roomsOf(p.creator)).toEqual([]);
  });

  it("does not list a room to a member who left", async () => {
    const p = await pairUp(h);
    const gone = await p.joiner.call("bellman_leave", { session_id: p.sessionId, member_id: p.joinerMemberId });
    expect(gone.isError, gone.text).toBe(false);
    expect(await roomsOf(p.joiner)).toEqual([]);
    expect((await roomsOf(p.creator))[0].members.map((m) => m.member_id)).toEqual([p.creatorMemberId]);
  });

  it("does not list a room to a member the creator removed", async () => {
    const p = await pairUp(h);
    const out = await p.creator.call("bellman_evict", { session_id: p.sessionId, member_id: p.joinerMemberId });
    expect(out.isError, out.text).toBe(false);
    expect(await roomsOf(p.joiner)).toEqual([]);
  });

  it("shows a code's string and link to a seat holding invite, and only its role and expiry to others", async () => {
    const p = await pairUp(h, { manifest: SWARM });
    const issued = await p.creator.call("bellman_invite", {
      session_id: p.sessionId, member_id: p.creatorMemberId, role: "observer",
    });
    expect(issued.isError, issued.text).toBe(false);

    const [asLead] = await roomsOf(p.creator);
    expect(asLead.join_codes.find((c) => c.role === "observer")).toEqual({
      role: "observer",
      code: issued.data.join_code,
      join_url: issued.data.join_url,
      expires_at: issued.data.join_code_expires_at,
    });

    const [asHelper] = await roomsOf(p.joiner);
    expect(asHelper.join_codes.find((c) => c.role === "observer")).toEqual({
      role: "observer", expires_at: issued.data.join_code_expires_at,
    });
    expect(asHelper.join_codes.some((c) => "code" in c || "join_url" in c)).toBe(false);
  });

  it("reports each member's beat as the tick would, with the latest note as peer content", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const p = await pairUp(h, { manifest: SWARM });
    const sent = await p.creator.call("bellman_send", {
      session_id: p.sessionId, member_id: p.creatorMemberId, type: "progress", payload: { note: "on the migration" },
    });
    expect(sent.isError, sent.text).toBe(false);
    vi.setSystemTime(Date.now() + 11 * 60_000);

    const [room] = await roomsOf(p.creator);
    const stored = (await h.store.getSession(p.sessionId))!;
    const row = snapshotOf(stored, Date.now()).members.find((m) => m.member_id === p.creatorMemberId)!;

    const lead = room.members.find((m) => m.member_id === p.creatorMemberId)!;
    expect(lead.beat).toMatchObject({
      asked: true,
      last_report_at: row.last_report_at,
      silent_for_seconds: row.silent_for_seconds,
      silent: true,
      note: {
        trust: "untrusted",
        origin: { memberId: p.creatorMemberId, label: p.creator.identity.label },
        data: { note: "on the migration" },
      },
    });
    const helper = room.members.find((m) => m.member_id === p.joinerMemberId)!;
    expect(helper.beat).toMatchObject({ asked: false, silent: false, note: null });
  });

  it("names the newest event, or null for a room nothing has happened in", async () => {
    const creator = await h.connect(DEV_KEY.jesse);
    const started = await creator.call("bellman_start", { manifest: manifestFixture({ preset: "swarm" }), brief: brief() });
    expect(started.isError, started.text).toBe(false);
    expect((await roomsOf(creator))[0].last_event).toBeNull();

    const p = await pairUp(h, { creatorKey: DEV_KEY.peer, joinerKey: DEV_KEY.outsider });
    const log = await h.store.eventsAfter(p.sessionId, 0);
    const [room] = await roomsOf(p.creator);
    expect(room.last_event).toEqual({
      cursor: log[log.length - 1].cursor, type: "member_joined", at: new Date(log[log.length - 1].at).toISOString(),
    });
  });

  // Review Focus 1: one person, two machines, one room.
  it("speaks for the newest live seat when one person holds two in a room", async () => {
    const p = await pairUp(h, { manifest: SWARM });
    const second = member({
      memberId: "m_second", userId: p.creator.identity.userId, label: p.creator.identity.label,
      roomRole: "helper", joinedAt: Date.now() + 1, lastSeenAt: Date.now() + 1,
    });
    expect(await h.store.addMember(p.sessionId, second)).toBe(true);
    const rooms = await roomsOf(p.creator);
    expect(rooms).toHaveLength(1);
    expect(rooms[0].your_member_id).toBe("m_second");
    expect(rooms[0].room.your_role).toBe("helper");
  });

  it("opens with the untrusted preamble when a room is listed, and not when none is", async () => {
    const p = await pairUp(h);
    expect((await p.creator.call("bellman_rooms")).text.startsWith(UNTRUSTED_PREAMBLE)).toBe(true);
    const outsider = await h.connect(DEV_KEY.outsider);
    const empty = await outsider.call("bellman_rooms");
    expect(empty.data.rooms).toEqual([]);
    expect(empty.text).not.toContain(UNTRUSTED_PREAMBLE);
  });

  it("is read-only, rendered through the app, and never a sign of life", async () => {
    const p = await pairUp(h);
    const { tools } = await p.creator.listTools();
    const rooms = tools.find((t) => t.name === "bellman_rooms")!;
    expect(rooms.annotations?.readOnlyHint).toBe(true);
    expect((rooms._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri).toBe(APP_RESOURCE_URI);
    expect(rooms.description).not.toMatch(/verbs/i);

    const old = Date.now() - 60 * 60_000;
    await h.store.updateMember(p.sessionId, p.creatorMemberId, { lastSeenAt: old });
    await roomsOf(p.creator);
    const me = (await h.store.getSession(p.sessionId))!.members.find((m) => m.memberId === p.creatorMemberId)!;
    expect(me.lastSeenAt).toBe(old);
  });
});
