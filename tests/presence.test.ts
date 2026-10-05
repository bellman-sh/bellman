/**
 * #103: a member whose session died held its seat forever.
 *
 * `leftAt` records a goodbye, and a crash does not say goodbye, so a `pair`
 * room whose peer's laptop closed read as full for the rest of its TTL — and
 * #18 made TTLs long. These tests pin the two halves of the fix: the derived
 * presence reading, and the seat actually coming back.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  STALE_AFTER_MS, lastSeen, presenceOf, presentMembers, staleMembers,
} from "../src/presence.js";
import { activeMembers, announceReclaimed, seatedMembers, touchMember } from "../src/rooms.js";
import { MemoryStore, seatVictims } from "../src/store.js";
import type { Identity } from "../src/types.js";
import { member, session } from "./helpers/fixtures.js";
import { Harness, DEV_KEY, envelopes } from "./helpers/harness.js";
import { pairUp } from "./helpers/flows.js";
import { brief, manifestFixture } from "./helpers/fixtures.js";

const NOW = 1_800_000_000_000;
const AGES_AGO = NOW - STALE_AFTER_MS - 1;

describe("presence is derived from lastSeenAt, not stored", () => {
  it("reads a recently-heard-from member as present", () => {
    const m = member({ lastSeenAt: NOW - 1000 });
    expect(presenceOf(m, NOW)).toBe("present");
  });

  it("reads a member past the window as stale, not departed", () => {
    const m = member({ lastSeenAt: AGES_AGO });
    expect(presenceOf(m, NOW)).toBe("stale");
    // The distinction is the point: nothing was written when it went quiet.
    expect(m.leftAt).toBeNull();
  });

  it("reads a member who said goodbye as departed, however recently it spoke", () => {
    const m = member({ lastSeenAt: NOW, leftAt: NOW - 1 });
    expect(presenceOf(m, NOW)).toBe("departed");
  });

  it("goes back to present the moment the member is heard from again", () => {
    const quiet = member({ lastSeenAt: AGES_AGO });
    expect(presenceOf(quiet, NOW)).toBe("stale");
    // A reopened laptop calls bellman_sync; nothing is undone, because nothing
    // was written.
    expect(presenceOf({ ...quiet, lastSeenAt: NOW }, NOW)).toBe("present");
  });

  it("lifts a row stored before lastSeenAt existed to its joinedAt", () => {
    const legacy = member({ joinedAt: NOW - 1000 });
    delete (legacy as { lastSeenAt?: number }).lastSeenAt;
    expect(lastSeen(legacy)).toBe(NOW - 1000);
    // Without the lift, `undefined` would read as the epoch and reap every
    // member stored before this change on the next capacity check.
    expect(presenceOf(legacy, NOW)).toBe("present");
  });

  it("splits a roster into present and stale", () => {
    const roster = [
      member({ memberId: "m_here", lastSeenAt: NOW }),
      member({ memberId: "m_gone", lastSeenAt: AGES_AGO }),
      member({ memberId: "m_left", lastSeenAt: NOW, leftAt: NOW - 1 }),
    ];
    expect(presentMembers(roster, NOW).map((m) => m.memberId)).toEqual(["m_here"]);
    expect(staleMembers(roster, NOW).map((m) => m.memberId)).toEqual(["m_gone"]);
  });

  it("gives the window several multiples of the sync poll interval", () => {
    // bellman_sync long-polls at most MAX_WAIT_SECONDS (25s), and the bridge
    // watcher re-polls on the same cadence. A window near that would reap a
    // member that is merely thinking.
    expect(STALE_AFTER_MS).toBeGreaterThan(5 * 25_000);
  });
});

describe("seatVictims — the seat rule both stores share", () => {
  const at = (ms: number, id: string) => member({ memberId: id, lastSeenAt: ms });
  const CUTOFF = NOW - STALE_AFTER_MS;

  it("reclaims nobody while the room has a seat going spare", () => {
    // Held for them, not taken: the joiner can have the free seat, so there is
    // no question to force, however long a member has been quiet.
    expect(seatVictims([at(1, "m_quiet")], 5, CUTOFF)).toEqual([]);
  });

  it("frees one seat when the room is full, longest-quiet first", () => {
    const victims = seatVictims(
      [at(NOW, "m_here"), at(3000, "m_b"), at(1000, "m_a")], 3, CUTOFF
    );
    expect(victims?.map((m) => m.memberId)).toEqual(["m_a"]);
  });

  it("frees as many as an over-full room needs, and no more", () => {
    const victims = seatVictims(
      [at(3000, "m_c"), at(1000, "m_a"), at(2000, "m_b")], 2, CUTOFF
    );
    // Three undeparted members in a two-seat room: two must go to seat one
    // more, and the one heard from most recently keeps its seat.
    expect(victims?.map((m) => m.memberId)).toEqual(["m_a", "m_b"]);
  });

  it("frees one seat from a quiet 25-seat room, not twenty-five", () => {
    // The blast radius is the size of the request. Reaping all of them is what
    // turned a quiet hub room into a wipe.
    const roster = Array.from({ length: 25 }, (_, i) => at(1000 + i, `m_${i}`));
    expect(seatVictims(roster, 25, CUTOFF)?.map((m) => m.memberId)).toEqual(["m_0"]);
  });

  it("refuses rather than reclaiming a member that is present", () => {
    expect(seatVictims([at(NOW, "m_a"), at(NOW, "m_b")], 2, CUTOFF)).toBeNull();
  });

  it("refuses rather than freeing some of the seats a joiner needs", () => {
    // One stale seat, two needed. A partial reap would remove a member for
    // somebody who never got in.
    expect(seatVictims([at(NOW, "m_a"), at(NOW, "m_b"), at(1, "m_c")], 2, CUTOFF))
      .toBeNull();
  });

  it("ignores members that already departed", () => {
    const roster = [at(NOW, "m_here"), member({ memberId: "m_gone", leftAt: 5 })];
    // Two rows, one occupant: the departed one frees nothing because it holds
    // nothing.
    expect(seatVictims(roster, 2, CUTOFF)).toEqual([]);
  });

  it("lifts a row stored before lastSeenAt existed to its joinedAt", () => {
    const legacy = member({ memberId: "m_legacy", joinedAt: NOW });
    delete (legacy as { lastSeenAt?: number }).lastSeenAt;
    // Without the lift, undefined reads as the epoch and every member stored
    // before this change loses its seat to the next joiner.
    expect(seatVictims([legacy], 1, CUTOFF)).toBeNull();
  });
});

describe("announceReclaimed", () => {
  let store: MemoryStore;
  const joiner: Identity = {
    userId: "u_late", orgId: "org_codenerd", plan: "team", role: "member",
    label: "late@codenerd",
  };

  beforeEach(() => { store = new MemoryStore(); });

  const reaped = member({
    memberId: "m_peer", userId: "u_peer", orgId: "org_peer",
    roomRole: "peer_b", lastSeenAt: 1, leftAt: NOW,
  });

  it("announces it as member_timed_out, naming the seat and when it was last heard", async () => {
    await store.createSession(session());

    await announceReclaimed(store, (await store.getSession("qs_test"))!, joiner, [reaped]);

    const events = await store.eventsAfter("qs_test", 0);
    expect(events.map((e) => e.type)).toEqual(["member_timed_out"]);
    // Its own type, not a reused member_left: nobody said goodbye, and a peer
    // deciding whether to keep waiting needs to know which of the two happened.
    expect(events[0].fromMemberId).toBe("system");
    expect(events[0].payload).toMatchObject({
      member_id: "m_peer", room_role: "peer_b", last_seen_at: expect.any(String),
    });
  });

  it("audits it to the reclaimed member's org as well as the room's", async () => {
    await store.createSession(session());

    await announceReclaimed(store, (await store.getSession("qs_test"))!, joiner, [reaped]);

    // The member losing access may be in neither the room's org nor the
    // joiner's, and that org's admins are the ones who need to see it.
    const theirs = (await store.auditForOrg("org_peer", 50))
      .filter((a) => a.action === "member_timed_out");
    expect(theirs).toHaveLength(1);
    expect(theirs[0].detail).toMatchObject({ member_id: "m_peer", seat_taken_by: "u_late" });
    expect((await store.auditForOrg("org_codenerd", 50))
      .filter((a) => a.action === "member_timed_out")).toHaveLength(1);
  });

  it("says nothing when the store reclaimed nothing", async () => {
    await store.createSession(session());

    await announceReclaimed(store, (await store.getSession("qs_test"))!, joiner, []);

    expect(await store.eventsAfter("qs_test", 0)).toEqual([]);
    expect(await store.auditForOrg("org_codenerd", 50)).toEqual([]);
  });
});

describe("seatMember claims the seat and frees it in one operation", () => {
  let store: MemoryStore;
  beforeEach(() => { store = new MemoryStore(); });

  const read = async () => (await store.getSession("qs_test"))!;
  const joiner = (over = {}) =>
    member({ memberId: "m_late", userId: "u_late", roomRole: "peer_b", ...over });
  const seat = (staleBefore = Date.now() - STALE_AFTER_MS) =>
    store.seatMember("qs_test", joiner(), staleBefore, Date.now());

  const fullWithStalePeer = async () =>
    store.createSession(session({
      members: [
        member({ memberId: "m_creator", lastSeenAt: Date.now() }),
        member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b", lastSeenAt: 1 }),
      ],
    }));

  it("seats the joiner and reports the seat it took", async () => {
    await fullWithStalePeer();

    const outcome = await seat();

    expect(outcome.refused).toBeNull();
    expect(outcome.reclaimed.map((m) => m.memberId)).toEqual(["m_peer"]);
    // Reported with leftAt already set, so the caller announces a removal that
    // happened rather than one it predicted.
    expect(outcome.reclaimed[0].leftAt).toEqual(expect.any(Number));

    const after = await read();
    expect(after.members.find((m) => m.memberId === "m_peer")?.leftAt).toEqual(expect.any(Number));
    expect(after.members.find((m) => m.memberId === "m_creator")?.leftAt).toBeNull();
    expect(seatedMembers(after).map((m) => m.memberId)).toEqual(["m_creator", "m_late"]);
  });

  it("never overfills the room, however many confirms race", async () => {
    await fullWithStalePeer();

    // Two joiners, one reclaimable seat. Serialised by the store rather than by
    // the handler, which is the whole point: the old shape reclaimed, re-read,
    // checked capacity and appended as three calls, and two confirms could
    // agree on the same free slot.
    const first = await store.seatMember("qs_test", joiner(), Date.now() - STALE_AFTER_MS, Date.now());
    const second = await store.seatMember(
      "qs_test", joiner({ memberId: "m_later", userId: "u_later" }),
      Date.now() - STALE_AFTER_MS, Date.now()
    );

    expect(first.refused).toBeNull();
    expect(second.refused).toBe("full");
    expect(second.reclaimed).toEqual([]);
    const room = await read();
    expect(seatedMembers(room)).toHaveLength(room.maxMembers);
    expect(room.members.filter((m) => m.leftAt !== null)).toHaveLength(1);
  });

  it("refuses a full room of present members, and reclaims nobody", async () => {
    await store.createSession(session({
      members: [
        member({ memberId: "m_creator", lastSeenAt: Date.now() }),
        member({ memberId: "m_peer", userId: "u_peer", lastSeenAt: Date.now() }),
      ],
    }));

    expect(await seat()).toEqual({ refused: "full", reclaimed: [] });
    expect((await read()).members).toHaveLength(2);
  });

  it("refuses a frozen room, so a lapsed plan costs nobody their place", async () => {
    await fullWithStalePeer();
    await store.freezeSession("qs_test", Date.now());

    expect(await seat()).toEqual({ refused: "frozen", reclaimed: [] });
    // The guard is inside the operation because the removal and the
    // announcement are separate writes: updateMember has no frozen guard and
    // appendEvent returns null, so a reap here would remove members
    // permanently AND silently, from a state meant to be reversible.
    expect((await read()).members.find((m) => m.memberId === "m_peer")?.leftAt).toBeNull();
    expect(await store.eventsAfter("qs_test", 0)).toEqual([]);
  });

  it("refuses a closed room", async () => {
    await fullWithStalePeer();
    await store.closeSession("qs_test");

    expect(await seat()).toEqual({ refused: "closed", reclaimed: [] });
  });

  it("refuses a session that does not exist", async () => {
    expect(await store.seatMember("qs_nope", joiner(), 0, Date.now()))
      .toEqual({ refused: "not_found", reclaimed: [] });
  });

  it("does not close the room when it reclaims its last member", async () => {
    await store.createSession(session({
      maxMembers: 1, members: [member({ memberId: "m_only", lastSeenAt: 1 })],
    }));

    expect((await seat()).reclaimed.map((m) => m.memberId)).toEqual(["m_only"]);

    // The joiner is seated in the same operation, so the room is never empty.
    expect((await read()).closed).toBe(false);
    expect(seatedMembers(await read()).map((m) => m.memberId)).toEqual(["m_late"]);
  });

  it("leaves the join code alone — freeing the seat is the whole point", async () => {
    await fullWithStalePeer();
    await seat();

    expect(Object.keys((await read()).joinCodes)).not.toEqual([]);
  });

  it("keeps a stale member out of the seat count while leaving it active", async () => {
    await fullWithStalePeer();
    const room = await read();

    expect(seatedMembers(room)).toHaveLength(1);
    // activeMembers still counts it: that is the reading the stores use to
    // decide a room has emptied, and it must not learn about staleness.
    expect(activeMembers(room)).toHaveLength(2);
  });
});

describe("touchMember", () => {
  let store: MemoryStore;
  beforeEach(() => { store = new MemoryStore(); });

  const seed = async (over: Parameters<typeof member>[0] = {}) => {
    await store.createSession(session({ members: [member({ lastSeenAt: 1, ...over })] }));
    const s = (await store.getSession("qs_test"))!;
    return { session: s, me: s.members[0] };
  };

  it("moves lastSeenAt", async () => {
    const { session: s, me } = await seed();

    await touchMember(store, s, me, NOW);

    expect((await store.getSession("qs_test"))!.members[0].lastSeenAt).toBe(NOW);
  });

  it("skips the write inside half the window, so a 25-second poll is not a 25-second write", async () => {
    const { session: s, me } = await seed({ lastSeenAt: NOW - 1000 });

    await touchMember(store, s, me, NOW);

    // In the Durable Objects store an updateMember rewrites the whole session
    // blob. Half the window keeps lastSeenAt at worst five minutes behind
    // inside a ten-minute window, which never changes present into stale.
    expect((await store.getSession("qs_test"))!.members[0].lastSeenAt).toBe(NOW - 1000);
  });

  it("writes once the member is more than half a window quiet", async () => {
    const { session: s, me } = await seed({ lastSeenAt: NOW - STALE_AFTER_MS / 2 - 1 });

    await touchMember(store, s, me, NOW);

    expect((await store.getSession("qs_test"))!.members[0].lastSeenAt).toBe(NOW);
  });

  it("writes nothing for a member that has left", async () => {
    const { session: s, me } = await seed({ leftAt: 50 });

    await touchMember(store, s, me, NOW);

    expect((await store.getSession("qs_test"))!.members[0].lastSeenAt).toBe(1);
  });

  it("writes nothing to a frozen or closed room", async () => {
    const { session: s, me } = await seed();

    await touchMember(store, { ...s, frozenAt: Date.now() }, me, NOW);
    await touchMember(store, { ...s, closed: true }, me, NOW);

    // bellman_sync has no closed, frozen or leftAt guard on purpose — reads
    // stay open to all three — so the write needs its own.
    expect((await store.getSession("qs_test"))!.members[0].lastSeenAt).toBe(1);
  });

  it("swallows a store failure rather than failing the call it rode in on", async () => {
    const { session: s, me } = await seed();
    vi.spyOn(store, "updateMember").mockRejectedValue(new Error("storage is down"));

    await expect(touchMember(store, s, me, NOW)).resolves.toBeUndefined();
  });
});

describe("the seat comes back", () => {
  let h: Harness;
  beforeEach(() => { h = new Harness(); });
  afterEach(async () => { await h.close(); });

  /** Age a member out of the window by rewriting its lastSeenAt in the store. */
  const goQuiet = async (sessionId: string, memberId: string) =>
    h.store.updateMember(sessionId, memberId, { lastSeenAt: Date.now() - STALE_AFTER_MS - 1 });

  it("lets a third agent take the seat of a peer whose session died", async () => {
    const { creator, joiner, sessionId, creatorMemberId, joinerMemberId, joinerCursor } =
      await pairUp(h);
    // The laptop closes. No bellman_leave: that is the entire bug.
    await goQuiet(sessionId, joinerMemberId);

    const invited = await creator.call("bellman_invite", {
      session_id: sessionId, member_id: creatorMemberId,
    });
    expect(invited.isError, invited.text).toBe(false);

    const replacement = await h.connect(DEV_KEY.jesse);
    const preview = await replacement.call("bellman_connect", {
      join_code: String(invited.data.join_code),
    });
    expect(preview.isError, preview.text).toBe(false);

    const confirmed = await replacement.call("bellman_confirm", {
      connect_token: String(preview.data.connect_token),
      brief: brief({ goal: "Take over from the peer that vanished" }),
      capabilities: ["read_context", "receive_messages"],
    });
    expect(confirmed.isError, confirmed.text).toBe(false);

    const room = await h.store.getSession(sessionId);
    expect(room?.members.find((m) => m.memberId === joinerMemberId)?.leftAt)
      .toEqual(expect.any(Number));
    expect(seatedMembers(room!)).toHaveLength(2);

    // R2 (#113): a timeout is not an eviction, so the seat's old occupant is not
    // cut. Nothing is recorded against it, and what the room says next still
    // reaches it — the reclaim moves it out of the seat count and no further.
    expect(room?.members.find((m) => m.memberId === joinerMemberId)?.removedAtCursor)
      .toBeUndefined();
    const said = await creator.call("bellman_send", {
      session_id: sessionId, member_id: creatorMemberId,
      type: "message", payload: { text: "after the seat timed out" },
    });
    expect(said.isError, said.text).toBe(false);
    const stillReads = await joiner.call("bellman_sync", {
      session_id: sessionId, member_id: joinerMemberId,
      since_cursor: joinerCursor, wait_seconds: 0,
    });
    expect(stillReads.isError, stillReads.text).toBe(false);
    expect(envelopes(stillReads.data.events)
      .map((e) => e.data as { type: string; payload: { text?: string } })
      .filter((d) => d.type === "message")
      .map((d) => d.payload.text)).toEqual(["after the seat timed out"]);
  });

  it("refuses the seat while the peer is still answering", async () => {
    const { creator, sessionId, creatorMemberId } = await pairUp(h);

    const invited = await creator.call("bellman_invite", {
      session_id: sessionId, member_id: creatorMemberId,
    });

    expect(invited.isError).toBe(true);
    expect(invited.text).toMatch(/full/i);
  });

  it("counts a bellman_sync as a sign of life", async () => {
    const { joiner, sessionId, joinerMemberId } = await pairUp(h);
    await goQuiet(sessionId, joinerMemberId);

    const synced = await joiner.call("bellman_sync", {
      session_id: sessionId, member_id: joinerMemberId, since_cursor: 0,
    });
    expect(synced.isError, synced.text).toBe(false);

    const room = (await h.store.getSession(sessionId))!;
    // Not stale any more, and never written down as having gone: the seat was
    // held for it, because nobody needed it in the meantime.
    expect(seatedMembers(room).map((m) => m.memberId)).toContain(joinerMemberId);
    expect(room.members.find((m) => m.memberId === joinerMemberId)?.leftAt).toBeNull();
  });

  it("counts a bellman_send as a sign of life", async () => {
    const { joiner, sessionId, joinerMemberId } = await pairUp(h);
    await goQuiet(sessionId, joinerMemberId);

    const sent = await joiner.call("bellman_send", {
      session_id: sessionId, member_id: joinerMemberId,
      type: "message", payload: { text: "back at my desk" },
    });
    expect(sent.isError, sent.text).toBe(false);

    expect(seatedMembers((await h.store.getSession(sessionId))!).map((m) => m.memberId))
      .toContain(joinerMemberId);
  });

  it("reports a quiet peer as stale on the roster, beside the old active flag", async () => {
    // A swarm room has spare seats, so nothing reaps and the quiet member is
    // still there to be described.
    const { creator, sessionId, creatorMemberId, joinerMemberId } =
      await pairUp(h, { manifest: manifestFixture({ preset: "swarm" }) });
    await goQuiet(sessionId, joinerMemberId);

    const invited = await creator.call("bellman_invite", {
      session_id: sessionId, member_id: creatorMemberId,
    });
    expect(invited.isError, invited.text).toBe(false);
    const third = await h.connect(DEV_KEY.outsider);
    const preview = await third.call("bellman_connect", {
      join_code: String(invited.data.join_code),
    });
    const confirmed = await third.call("bellman_confirm", {
      connect_token: String(preview.data.connect_token),
      brief: brief({ goal: "Join a swarm with one quiet member" }),
      capabilities: ["read_context", "receive_messages"],
    });
    expect(confirmed.isError, confirmed.text).toBe(false);

    const roster = confirmed.data.members as Array<Record<string, unknown>>;
    const quiet = roster.find((m) => m.member_id === joinerMemberId)!;
    expect(quiet.presence).toBe("stale");
    // `active` keeps its old meaning — has not departed — so a client reading
    // it does not have the roster change shape underneath it.
    expect(quiet.active).toBe(true);
    expect(roster.find((m) => m.member_id === creatorMemberId)?.presence).toBe("present");
  });

  it("does not let a preview remove anybody, however full and quiet the room", async () => {
    const { sessionId, creatorMemberId, joinerMemberId, joinCode } = await pairUp(h);
    await goQuiet(sessionId, creatorMemberId);
    await goQuiet(sessionId, joinerMemberId);

    // bellman_connect is reachable by anyone holding a code, without joining,
    // and never consumes the code — so a preview that reaped would let one
    // caller empty a quiet room, repeatedly, for the code's whole 15 minutes.
    // It counts; it does not write. The code is already spent here, so reissue.
    const reissued = await (await h.connect(DEV_KEY.jesse)).call("bellman_invite", {
      session_id: sessionId, member_id: creatorMemberId,
    });
    expect(reissued.isError, reissued.text).toBe(false);

    const outsider = await h.connect(DEV_KEY.outsider);
    for (let i = 0; i < 3; i++) {
      const preview = await outsider.call("bellman_connect", {
        join_code: String(reissued.data.join_code),
      });
      expect(preview.isError, preview.text).toBe(false);
    }

    const room = (await h.store.getSession(sessionId))!;
    expect(room.members.filter((m) => m.leftAt !== null)).toEqual([]);
    expect(joinCode).toBeTruthy();
  });

  it("does not reclaim the seat of the member that just issued the code", async () => {
    // The sharp version of "a verb-gated call is a sign of life". Both members
    // have been quiet past the window; the creator then calls bellman_invite,
    // which is proof it is there. Without a touch in gateSeat it stays the
    // longest-quiet member on the roster, and the joiner it just let in reclaims
    // its seat.
    const { creator, sessionId, creatorMemberId, joinerMemberId } = await pairUp(h);
    await h.store.updateMember(sessionId, creatorMemberId, { lastSeenAt: 1 });
    await goQuiet(sessionId, joinerMemberId);

    const invited = await creator.call("bellman_invite", {
      session_id: sessionId, member_id: creatorMemberId,
    });
    expect(invited.isError, invited.text).toBe(false);

    const third = await h.connect(DEV_KEY.outsider);
    const preview = await third.call("bellman_connect", {
      join_code: String(invited.data.join_code),
    });
    const confirmed = await third.call("bellman_confirm", {
      connect_token: String(preview.data.connect_token),
      brief: brief({ goal: "Join on the code the creator just minted" }),
      capabilities: ["read_context", "receive_messages"],
    });
    expect(confirmed.isError, confirmed.text).toBe(false);

    const room = (await h.store.getSession(sessionId))!;
    expect(room.members.find((m) => m.memberId === creatorMemberId)?.leftAt).toBeNull();
    expect(room.members.find((m) => m.memberId === joinerMemberId)?.leftAt)
      .toEqual(expect.any(Number));
  });

  it("does not let bellman_invite remove anybody either", async () => {
    const { creator, sessionId, creatorMemberId, joinerMemberId } = await pairUp(h);
    await goQuiet(sessionId, joinerMemberId);

    // The `invite` verb is not the `evict` authority: a manifest can hand
    // inviting to a joiner, and evicting is creator-only and outside the verb
    // set on purpose.
    const invited = await creator.call("bellman_invite", {
      session_id: sessionId, member_id: creatorMemberId,
    });
    expect(invited.isError, invited.text).toBe(false);

    const room = (await h.store.getSession(sessionId))!;
    expect(room.members.find((m) => m.memberId === joinerMemberId)?.leftAt).toBeNull();
  });

  it("leaves a frozen room's roster alone when a confirm tries to take a seat", async () => {
    const { creator, sessionId, creatorMemberId, joinerMemberId } = await pairUp(h);
    await goQuiet(sessionId, joinerMemberId);
    const invited = await creator.call("bellman_invite", {
      session_id: sessionId, member_id: creatorMemberId,
    });
    expect(invited.isError, invited.text).toBe(false);
    const third = await h.connect(DEV_KEY.outsider);
    const preview = await third.call("bellman_connect", {
      join_code: String(invited.data.join_code),
    });
    expect(preview.isError, preview.text).toBe(false);

    await h.store.freezeSession(sessionId, Date.now());
    const confirmed = await third.call("bellman_confirm", {
      connect_token: String(preview.data.connect_token),
      brief: brief({ goal: "Confirm into a room that froze mid-handshake" }),
      capabilities: ["read_context", "receive_messages"],
    });
    expect(confirmed.isError).toBe(true);
    expect(confirmed.text).toMatch(/frozen|plan/i);

    // The removal would otherwise land while the announcement was swallowed —
    // members gone permanently and silently from a reversible state. This is
    // the invariant tests/tools/freeze.test.ts pins: a frozen room's roster
    // cannot change.
    const room = (await h.store.getSession(sessionId))!;
    expect(room.members.filter((m) => m.leftAt !== null)).toEqual([]);
    expect(await h.store.eventsAfter(sessionId, 0))
      .not.toContainEqual(expect.objectContaining({ type: "member_timed_out" }));
  });

  it("keeps the derived presence out of the replayable member_joined payload", async () => {
    const { sessionId } = await pairUp(h);

    const joined = (await h.store.eventsAfter(sessionId, 0))
      .find((e) => e.type === "member_joined")!;

    // The event is durable and replayed, and presence is read off the clock: a
    // stored "present" would still read as present hours after that member was
    // reaped. ARCHITECTURE.md rule 7 — derived, never stored.
    expect(joined.payload).toMatchObject({ member: { active: true } });
    expect((joined.payload as { member: Record<string, unknown> }).member)
      .not.toHaveProperty("presence");
  });

  it("does not reap a swarm room that merely has spare seats", async () => {
    const { sessionId, joinerMemberId } = await pairUp(h, {
      manifest: manifestFixture({ preset: "swarm" }),
    });
    await goQuiet(sessionId, joinerMemberId);

    // Nothing has asked for a seat, so nothing is written: the quiet member is
    // still in the room, and still reversible.
    const room = (await h.store.getSession(sessionId))!;
    expect(room.members.find((m) => m.memberId === joinerMemberId)?.leftAt).toBeNull();
    expect(await h.store.eventsAfter(sessionId, 0))
      .not.toContainEqual(expect.objectContaining({ type: "member_timed_out" }));
  });
});
