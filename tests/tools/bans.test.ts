import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BANNED } from "../../src/bans.js";
import { brief, manifestFixture } from "../helpers/fixtures.js";
import { joinWith, publicRoom } from "../helpers/flows.js";
import { DEV_KEY, Harness } from "../helpers/harness.js";

let h: Harness;
beforeEach(() => {
  h = new Harness();
});
afterEach(async () => {
  await h.close();
});

describe("bellman_evict with ban (abuse protections spec \u{A7}1)", () => {
  /** The hole this closes (spec section 4). */
  it("refuses a member banned from the room when they redeem its permanent code, and seats anyone else", async () => {
    const room = await publicRoom(h);
    const peer = await h.connect(DEV_KEY.peer);
    const joined = await joinWith(peer, room.code);
    expect(joined.isError, joined.text).toBe(false);

    const out = await room.creator.call("bellman_evict", { session_id: room.sessionId, member_id: joined.data.member_id, ban: "room" });
    expect(out.isError, out.text).toBe(false);
    expect(out.data).toMatchObject({ evicted: true, banned: "room" });
    const row = (await h.store.auditForOrg("org_codenerd", 50)).find((a) => a.action === "member_evicted");
    expect(row?.detail).toMatchObject({ ban: "room" });

    const back = await joinWith(peer, room.code);
    expect([back.isError, back.text]).toEqual([true, `Error: ${BANNED}`]);
    expect((await joinWith(await h.connect(DEV_KEY.outsider), room.code)).isError, "the control").toBe(false);
  });

  it("without ban, lets the same permanent code seat them again", async () => {
    const room = await publicRoom(h);
    const peer = await h.connect(DEV_KEY.peer);
    const joined = await joinWith(peer, room.code);
    await room.creator.call("bellman_evict", { session_id: room.sessionId, member_id: joined.data.member_id });
    const back = await joinWith(peer, room.code);
    expect(back.isError, back.text).toBe(false);
  });

  it("with ban all, refuses the account's preview of another room the creator owns", async () => {
    const first = await publicRoom(h);
    const peer = await h.connect(DEV_KEY.peer);
    const joined = await joinWith(peer, first.code);
    await first.creator.call("bellman_evict", { session_id: first.sessionId, member_id: joined.data.member_id, ban: "all" });
    const second = await publicRoom(h);
    const preview = await peer.call("bellman_connect", { join_code: second.code });
    expect([preview.isError, preview.text]).toEqual([true, `Error: ${BANNED}`]);
  });

  // R2: a preview holds a 10-minute token, minted before the ban.
  it("refuses a confirm whose preview came before a ban from every room", async () => {
    const first = await publicRoom(h);
    const second = await publicRoom(h);
    const peer = await h.connect(DEV_KEY.peer);
    const joined = await joinWith(peer, first.code);
    const preview = await peer.call("bellman_connect", { join_code: second.code });
    expect(preview.isError, preview.text).toBe(false);
    await first.creator.call("bellman_evict", { session_id: first.sessionId, member_id: joined.data.member_id, ban: "all" });
    const confirmed = await peer.call("bellman_confirm", {
      connect_token: String(preview.data.connect_token), brief: brief(), capabilities: ["read_context", "receive_messages"],
    });
    expect([confirmed.isError, confirmed.text]).toEqual([true, `Error: ${BANNED}`]);
  });

  /** Review Focus 2. */
  it("removes every handle the banned account holds in the room", async () => {
    const room = await publicRoom(h);
    const laptop = await h.connect(DEV_KEY.peer);
    const desktop = await h.connect(DEV_KEY.peer);
    const a = await joinWith(laptop, room.code);
    const b = await joinWith(desktop, room.code);
    await room.creator.call("bellman_evict", { session_id: room.sessionId, member_id: a.data.member_id, ban: "room" });
    const sent = await desktop.call("bellman_send", { session_id: room.sessionId, member_id: b.data.member_id, type: "message", payload: { text: "still here" } });
    expect([sent.isError, sent.text]).toEqual([true, "Error: member_id is not yours or has left the session."]);
  });

  it("bans nobody when someone other than the creator asks", async () => {
    const room = await publicRoom(h);
    const peer = await h.connect(DEV_KEY.peer);
    const joined = await joinWith(peer, room.code);
    const outsider = await h.connect(DEV_KEY.outsider);
    await joinWith(outsider, room.code);
    const out = await outsider.call("bellman_evict", { session_id: room.sessionId, member_id: joined.data.member_id, ban: "all" });
    expect(out.isError).toBe(true);
    expect(await h.store.roomBans(room.sessionId)).toEqual([]);
    expect(await h.store.isBannedByCreator("u_jesse", "u_peer")).toBe(false);
  });

  it("says in its description what a ban adds, and takes it in its schema", async () => {
    const { tools } = await (await h.connect(DEV_KEY.jesse)).listTools();
    const tool = tools.find((t) => t.name === "bellman_evict")!;
    expect(tool.description!.replace(/\s+/g, " ")).toContain("Without ban, removal is not a ban");
    expect(tool.inputSchema.properties).toHaveProperty("ban");
  });

  // A ban on someone who already left is the eviction's row in the audit log, and their next join is refused.
  it("audits a ban on a member who already left as the eviction it is, and refuses them at the door", async () => {
    const room = await publicRoom(h);
    const peer = await h.connect(DEV_KEY.peer);
    const joined = await joinWith(peer, room.code);
    const left = await peer.call("bellman_leave", { session_id: room.sessionId, member_id: joined.data.member_id });
    expect(left.isError, left.text).toBe(false);
    const evictions = async () => (await h.store.auditForOrg("org_codenerd", 50)).filter((a) => a.action === "member_evicted");
    expect(await evictions(), "the control: leaving files no eviction").toEqual([]);

    const out = await room.creator.call("bellman_evict", { session_id: room.sessionId, member_id: joined.data.member_id, ban: "room" });
    expect(out.isError, out.text).toBe(false);
    expect((await evictions()).map((a) => a.detail)).toEqual([expect.objectContaining({ user_id: "u_peer", ban: "room" })]);

    const back = await joinWith(peer, room.code);
    expect([back.isError, back.text]).toEqual([true, `Error: ${BANNED}`]);
  });

  // The seating decides "banned" before "full", and the confirm maps it: a banned account is never told the room is full.
  it("tells a banned account it can't join, and not that the room filled, when another took the seat meanwhile", async () => {
    const creator = await h.connect(DEV_KEY.jesse);
    const started = await creator.call("bellman_start", { manifest: manifestFixture({ preset: "pair", public: true }), brief: brief() });
    expect(started.isError, started.text).toBe(false);
    const sessionId = String(started.data.session_id);
    const door = await creator.call("bellman_invite", { session_id: sessionId, member_id: String(started.data.member_id), permanent: true });
    expect(door.isError, door.text).toBe(false);
    const code = String(door.data.join_code);

    // A second preview, kept for after the ban: its token is what the confirm below redeems.
    const peer = await h.connect(DEV_KEY.peer);
    const held = await peer.call("bellman_connect", { join_code: code });
    expect(held.isError, held.text).toBe(false);
    const joined = await joinWith(peer, code);
    expect(joined.isError, joined.text).toBe(false);
    const evicted = await creator.call("bellman_evict", { session_id: sessionId, member_id: joined.data.member_id, ban: "room" });
    expect(evicted.isError, evicted.text).toBe(false);
    expect((await joinWith(await h.connect(DEV_KEY.outsider), code)).isError, "the control: another account takes the free seat").toBe(false);
    const roster = (await h.store.getSession(sessionId))!.members.filter((m) => m.leftAt === null);
    expect(roster, "the premise: a pair room holds two, and both seats are taken").toHaveLength(2);

    const confirmed = await peer.call("bellman_confirm", {
      connect_token: String(held.data.connect_token), brief: brief(), capabilities: ["read_context", "receive_messages"],
    });
    expect([confirmed.isError, confirmed.text]).toEqual([true, `Error: ${BANNED}`]);
  });
});

/** A ban from every room covers the rooms the account sits in now, as well as its later joins (spec section 1). */
describe("bellman_evict with ban all, in the creator's other rooms", () => {
  /** A room started by `key`, and a 15-minute code for its default seat. */
  async function roomBy(key: string, preset = "swarm") {
    const creator = await h.connect(key);
    const started = await creator.call("bellman_start", { manifest: manifestFixture({ preset }), brief: brief() });
    expect(started.isError, started.text).toBe(false);
    const sessionId = String(started.data.session_id);
    const memberId = String(started.data.member_id);
    const door = await creator.call("bellman_invite", { session_id: sessionId, member_id: memberId });
    expect(door.isError, door.text).toBe(false);
    return { creator, sessionId, memberId, code: String(door.data.join_code) };
  }

  /** Rooms A and B are jesse's, and C is outsider's, a pair room on the free plan. The account sits in all three, in B with two handles. */
  async function seatedInThree() {
    const a = await publicRoom(h);
    const b = await roomBy(DEV_KEY.jesse);
    const c = await roomBy(DEV_KEY.outsider, "pair");
    const peer = await h.connect(DEV_KEY.peer);
    const inA = await joinWith(peer, a.code);
    expect(inA.isError, inA.text).toBe(false);
    for (const [who, code] of [[peer, b.code], [await h.connect(DEV_KEY.peer), b.code], [peer, c.code]] as const) {
      const joined = await joinWith(who, code);
      expect(joined.isError, joined.text).toBe(false);
    }
    return { a, b, c, peer, target: String(inA.data.member_id) };
  }

  /** How many handles the account holds in the room now. */
  const seats = async (sessionId: string) =>
    (await h.store.getSession(sessionId))!.members.filter((m) => m.userId === "u_peer").length;

  it("removes the account from every other room its creator owns, and leaves another creator's", async () => {
    const { a, b, c, peer, target } = await seatedInThree();
    const out = await a.creator.call("bellman_evict", { session_id: a.sessionId, member_id: target, ban: "all" });
    expect(out.isError, out.text).toBe(false);
    expect(out.data).toMatchObject({ evicted: true, banned: "all", also_removed_from: 1 });
    expect([await seats(a.sessionId), await seats(b.sessionId), await seats(c.sessionId)]).toEqual([0, 0, 1]);

    // In B, what an eviction writes, once a handle: the member_evicted event, and the audit row with the ban on it. No
    // room ban of B's own: the creator-wide ban keeps the account out.
    expect((await h.store.eventsAfter(b.sessionId, 0)).filter((e) => e.type === "member_evicted")).toHaveLength(2);
    const rows = (await h.store.auditForOrg("org_codenerd", 500)).filter((r) => r.sessionId === b.sessionId && r.action === "member_evicted");
    expect(rows.map((r) => r.detail)).toEqual([
      expect.objectContaining({ user_id: "u_peer", ban: "all" }), expect.objectContaining({ user_id: "u_peer", ban: "all" }),
    ]);
    expect(await h.store.roomBans(b.sessionId)).toEqual([]);

    // B's 15-minute code went with the seat, as an eviction's does, and the next code B's creator mints refuses the account.
    const late = await joinWith(await h.connect(DEV_KEY.outsider), b.code);
    expect([late.isError, late.text], "B's code is retired").toEqual([true, expect.stringContaining("join code not found")]);
    const fresh = await b.creator.call("bellman_invite", { session_id: b.sessionId, member_id: b.memberId });
    expect(fresh.isError, fresh.text).toBe(false);
    const back = await joinWith(peer, String(fresh.data.join_code));
    expect([back.isError, back.text]).toEqual([true, `Error: ${BANNED}`]);
  });

  it("with ban room, leaves the account in the creator's other rooms", async () => {
    const { a, b, target } = await seatedInThree();
    const out = await a.creator.call("bellman_evict", { session_id: a.sessionId, member_id: target, ban: "room" });
    expect(out.data).toMatchObject({ evicted: true, banned: "room", also_removed_from: 0 });
    expect(await seats(b.sessionId)).toBe(2);
  });

  // R3's rule: a removal refused partway, here by a frozen room, is finished by repeating the ban.
  it("finishes on a repeat what a room that refused the removal left undone", async () => {
    const { a, b, c, target } = await seatedInThree();
    const evict = () => a.creator.call("bellman_evict", { session_id: a.sessionId, member_id: target, ban: "all" });
    await h.store.freezeSession(b.sessionId, Date.now());
    const first = await evict();
    expect(first.data).toMatchObject({ evicted: true, also_removed_from: 0 });
    expect(await seats(b.sessionId), "the premise: frozen, B refused both removals").toBe(2);
    await h.store.freezeSession(b.sessionId, null);
    const again = await evict();
    expect(again.data).toMatchObject({ evicted: true, also_removed_from: 1 });
    expect([await seats(a.sessionId), await seats(b.sessionId), await seats(c.sessionId)]).toEqual([0, 0, 1]);
  });

  // The rule every removal keeps: a room with nobody left in it is over.
  it("closes a room of the creator's that the removal leaves with nobody in it", async () => {
    const a = await publicRoom(h);
    const b = await roomBy(DEV_KEY.jesse);
    const peer = await h.connect(DEV_KEY.peer);
    const inA = await joinWith(peer, a.code);
    expect((await joinWith(peer, b.code)).isError).toBe(false);
    expect((await b.creator.call("bellman_leave", { session_id: b.sessionId, member_id: b.memberId })).isError).toBe(false);
    expect((await h.store.getSession(b.sessionId))!.closed, "the premise: the account keeps B open").toBe(false);
    await a.creator.call("bellman_evict", { session_id: a.sessionId, member_id: inA.data.member_id, ban: "all" });
    expect((await h.store.getSession(b.sessionId))!.closed).toBe(true);
  });
});
