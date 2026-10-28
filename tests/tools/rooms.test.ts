/**
 * `bellman_rooms`: the rooms the caller holds a seat in, shaped for the in-chat
 * monitor (#28). The shaping is pinned in tests/room-summary.test.ts; this file
 * drives it through MCP: which rooms a caller sees, from which seat, and what the
 * result promises about itself.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Harness, DEV_KEY, type Peer } from "../helpers/harness.js";
import { brief, manifestFixture, member, pairVerbs } from "../helpers/fixtures.js";
import { pairUp, seatAgain, startRoom } from "../helpers/flows.js";
import { ROOM_TAIL, UNTRUSTED_PREAMBLE } from "../../src/projections.js";
import { snapshotOf } from "../../src/heartbeat.js";
import { APP_RESOURCE_URI } from "../../src/ui/resource.js";
import { ROOMS_LIMIT } from "../../src/tools/rooms.js";
import { session } from "../helpers/fixtures.js";
import { roomsFixture } from "../../ui/test/fixtures.js";

let h: Harness;
beforeEach(() => { h = new Harness(); });
afterEach(async () => { await h.close(); vi.useRealTimers(); });

interface Seat { member_id: string; role: string; verbs: string[] }

interface Room {
  session_id: string;
  status: string;
  your_member_id: string | null;
  your_seats: Seat[];
  room: { your_role: string | null; your_verbs: string[]; your_heartbeat_on: boolean };
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
  // The monitor's tests render ui/test/fixtures.ts, and #244 shipped because its room carried an expires_at the server
  // no longer sent: every UI test passed while the real monitor read "expires NaN… left". So the fixture's room is
  // held to the keys a real one arrives with.
  it("sends a room with the keys the monitor's fixture is written against", async () => {
    const creator = await h.connect(DEV_KEY.jesse);
    await creator.call("bellman_start", { manifest: manifestFixture({ preset: "swarm" }), brief: brief() });
    const [real] = await roomsOf(creator);

    expect(Object.keys(roomsFixture().rooms[0]!).sort()).toEqual(Object.keys(real!).sort());
  });

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

    // One seat: the viewer fields speak for it as they always have, and your_seats holds just that seat.
    expect(mine.room.your_verbs).toEqual(pairVerbs("peer_a"));
    expect(mine.your_seats).toEqual([{ member_id: p.creatorMemberId, role: "peer_a", verbs: pairVerbs("peer_a") }]);
    expect(theirs.room.your_verbs).toEqual(pairVerbs("peer_b"));
    expect(theirs.your_seats).toEqual([{ member_id: p.joinerMemberId, role: "peer_b", verbs: pairVerbs("peer_b") }]);
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

  // #432: the request that waits on a seat can sit further back than the tail the listing reads.
  it("derives needs_you from a request older than the tail, and clears it on the answer", async () => {
    const p = await pairUp(h);
    const asked = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId, type: "action_request", payload: { action: "deploy" },
    });
    expect(asked.isError, asked.text).toBe(false);
    for (let i = 0; i < ROOM_TAIL + 20; i++) {
      await h.store.appendEvent(p.sessionId, {
        type: "heartbeat", fromMemberId: "system", fromUserId: "system", fromLabel: "bellman", payload: {}, refId: null,
      });
    }
    const seat = (room: Room, id: string) => room.members.find((m) => m.member_id === id) as unknown as Record<string, unknown>;

    const [waiting] = await roomsOf(p.joiner);
    expect(seat(waiting, p.creatorMemberId)).toMatchObject({ status: "needs_you", status_source: "derived", needs_you: true });
    expect(seat(waiting, p.joinerMemberId)).toMatchObject({ needs_you: false });
    expect((waiting as unknown as { needs_you_count: number }).needs_you_count).toBe(1);

    const answered = await p.creator.call("bellman_send", {
      session_id: p.sessionId, member_id: p.creatorMemberId, type: "action_response",
      ref_id: String(asked.data.cursor), payload: { approved: false },
    });
    expect(answered.isError, answered.text).toBe(false);
    const [done] = await roomsOf(p.joiner);
    expect(seat(done, p.creatorMemberId)).toMatchObject({ status: "working", status_source: "presence", needs_you: false });
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

  // One person, two machines, one room. The tool is called by the account, and nothing in the call says
  // which seat is asking, so the answer lists every seat the account holds and does not pick one. It used
  // to name the newest as "yours": a claude.ai session as peer_a beside a Claude Code session as peer_b was
  // told it was peer_b, and could not see the join codes its peer_a seat could mint.
  it("lists every seat one account holds in a room, oldest first", async () => {
    const creator = await h.connect(DEV_KEY.jesse);
    const { sessionId, memberId } = await startRoom(creator);
    await seatAgain(h, creator, sessionId, "peer_b");

    const rooms = await roomsOf(creator);
    expect(rooms).toHaveLength(1);
    expect(rooms[0].your_seats).toEqual([
      { member_id: memberId, role: "peer_a", verbs: pairVerbs("peer_a") },
      { member_id: "m_second", role: "peer_b", verbs: pairVerbs("peer_b") },
    ]);
  });

  it("names none of them as yours, and leaves the room block's seat fields empty", async () => {
    const creator = await h.connect(DEV_KEY.jesse);
    const { sessionId, memberId } = await startRoom(creator, SWARM);
    // One lead seat, which the cadence asks to report: the fields speak for it.
    const [alone] = await roomsOf(creator);
    expect(alone.your_member_id).toBe(memberId);
    expect(alone.room).toMatchObject({ your_role: "lead", your_heartbeat_on: true });

    await seatAgain(h, creator, sessionId, "lead");
    const [room] = await roomsOf(creator);
    expect(room.your_member_id).toBeNull();
    expect(room.room).toMatchObject({ your_role: null, your_verbs: [], your_heartbeat_on: false });
  });

  it("shows a code's string and link when any of the seats holds invite, though the newest does not", async () => {
    const creator = await h.connect(DEV_KEY.jesse);
    const { started, sessionId } = await startRoom(creator);
    // peer_a can invite and peer_b cannot, and the newer seat is the one that cannot.
    await seatAgain(h, creator, sessionId, "peer_b");

    const [room] = await roomsOf(creator);
    expect(room.join_codes).toEqual([{
      role: "peer_b",
      code: started.data.join_code,
      join_url: started.data.join_url,
      expires_at: started.data.join_code_expires_at,
    }]);
  });

  it("keeps a code's string and link hidden when none of the seats holds invite", async () => {
    const p = await pairUp(h, { manifest: SWARM });
    const issued = await p.creator.call("bellman_invite", {
      session_id: p.sessionId, member_id: p.creatorMemberId, role: "observer",
    });
    expect(issued.isError, issued.text).toBe(false);
    await seatAgain(h, p.joiner, p.sessionId, "helper");

    const [room] = await roomsOf(p.joiner);
    // Two helper seats of one account, so this is the several-seats path, and a helper cannot invite.
    expect(room.members.map((m) => m.member_id)).toEqual(expect.arrayContaining([p.joinerMemberId, "m_second"]));
    expect(room.join_codes.find((c) => c.role === "observer")).toEqual({
      role: "observer", expires_at: issued.data.join_code_expires_at,
    });
    expect(room.join_codes.some((c) => "code" in c || "join_url" in c)).toBe(false);
  });

  it("does not count a seat that left", async () => {
    const creator = await h.connect(DEV_KEY.jesse);
    const { sessionId, memberId } = await startRoom(creator);
    await seatAgain(h, creator, sessionId, "peer_b");
    const gone = await creator.call("bellman_leave", { session_id: sessionId, member_id: "m_second" });
    expect(gone.isError, gone.text).toBe(false);

    const [room] = await roomsOf(creator);
    expect(room.your_member_id).toBe(memberId);
    expect(room.your_seats).toEqual([{ member_id: memberId, role: "peer_a", verbs: pairVerbs("peer_a") }]);
  });

  // The joined index lists every room a person ever held a handle in, closed
  // ones included, in no promised order, and is never pruned
  // (BellmanStore.sessionsJoinedBy). A window the size of the answer, taken
  // before the closed filter, cut a live room for anyone past it, for good.
  it("still lists a live room for a member whose joined history is longer than the answer", async () => {
    for (let i = 0; i < ROOMS_LIMIT; i++) {
      const id = `qs_dead_${i}`;
      await h.store.createSession(session({
        id, joinCodes: {},
        members: [member(), member({ memberId: `m_dead_${i}`, userId: "u_peer", label: "peer@codenerd" })],
      }));
      await h.store.closeSession(id);
    }
    const p = await pairUp(h, { creatorKey: DEV_KEY.jesse, joinerKey: DEV_KEY.peer });
    expect((await roomsOf(p.joiner)).map((r) => r.session_id)).toEqual([p.sessionId]);
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

  // The listing is what a model reads to know what the result means, so a result that names every seat
  // and an answer that says "yours" for one of several would be two stories about the same field.
  it("tells a caller in its description what one seat and several seats mean, and who sees a code", async () => {
    const { tools } = await (await h.connect(DEV_KEY.jesse)).listTools();
    const doc = tools.find((t) => t.name === "bellman_rooms")!.description!.replace(/\s+/g, " ");

    expect(doc).toContain("your_seats[]");
    expect(doc).toContain("null when you hold several");
    expect(doc).toContain("any of your seats holds invite");
  });
});
