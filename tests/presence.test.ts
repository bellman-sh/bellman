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
import { activeMembers, reclaimStaleSeats, seatedMembers, touchMember } from "../src/rooms.js";
import { MemoryStore } from "../src/store.js";
import type { Identity } from "../src/types.js";
import { member, session } from "./helpers/fixtures.js";
import { Harness, DEV_KEY } from "./helpers/harness.js";
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

describe("reclaimStaleSeats", () => {
  let store: MemoryStore;
  const joiner: Identity = {
    userId: "u_late", orgId: "org_codenerd", plan: "team", role: "member",
    label: "late@codenerd",
  };

  beforeEach(() => { store = new MemoryStore(); });

  const read = async () => (await store.getSession("qs_test"))!;

  /** A two-seat room, one present member and one whose session died. */
  const fullWithStalePeer = async () =>
    store.createSession(session({
      members: [
        member({ memberId: "m_creator", lastSeenAt: Date.now() }),
        member({ memberId: "m_peer", userId: "u_peer", orgId: "org_peer", roomRole: "peer_b", lastSeenAt: 1 }),
      ],
    }));

  it("turns the contested stale seat into a departed one", async () => {
    await fullWithStalePeer();

    const reaped = await reclaimStaleSeats(store, await read(), joiner);

    expect(reaped.map((m) => m.memberId)).toEqual(["m_peer"]);
    const after = await read();
    expect(after.members.find((m) => m.memberId === "m_peer")?.leftAt).toEqual(expect.any(Number));
    expect(after.members.find((m) => m.memberId === "m_creator")?.leftAt).toBeNull();
  });

  it("announces it as member_timed_out, naming the seat and when it was last heard", async () => {
    await fullWithStalePeer();
    await reclaimStaleSeats(store, await read(), joiner);

    const events = await store.eventsAfter("qs_test", 0);
    expect(events.map((e) => e.type)).toEqual(["member_timed_out"]);
    // Its own type, not a reused member_left: nobody said goodbye, and a peer
    // deciding whether to keep waiting needs to know which of the two happened.
    expect(events[0].fromMemberId).toBe("system");
    expect(events[0].payload).toMatchObject({
      member_id: "m_peer", room_role: "peer_b", last_seen_at: expect.any(String),
    });
  });

  it("audits it to the removed member's org as well as the room's", async () => {
    await fullWithStalePeer();
    await reclaimStaleSeats(store, await read(), joiner);

    // The member losing access may be in neither the room's org nor the
    // joiner's, and that org's admins are the ones who need to see it.
    const theirs = (await store.auditForOrg("org_peer", 50))
      .filter((a) => a.action === "member_timed_out");
    expect(theirs).toHaveLength(1);
    expect(theirs[0].detail).toMatchObject({ member_id: "m_peer", seat_taken_by: "u_late" });
    expect((await store.auditForOrg("org_codenerd", 50))
      .filter((a) => a.action === "member_timed_out")).toHaveLength(1);
  });

  it("frees one seat, not every stale seat", async () => {
    // The whole blast-radius question. A quiet room must not be emptied just
    // because one agent wants in: a 25-seat hub room whose members have all
    // been quiet ten minutes loses exactly the one seat the joiner needs.
    await store.createSession(session({
      maxMembers: 25,
      members: Array.from({ length: 25 }, (_, i) =>
        member({ memberId: `m_${i}`, userId: `u_${i}`, lastSeenAt: 1000 + i })),
    }));

    const reaped = await reclaimStaleSeats(store, await read(), joiner);

    expect(reaped.map((m) => m.memberId)).toEqual(["m_0"]); // the longest quiet
    expect((await read()).members.filter((m) => m.leftAt !== null)).toHaveLength(1);
  });

  it("frees as many seats as an over-full room needs, longest-quiet first", async () => {
    await store.createSession(session({
      maxMembers: 2,
      members: [
        member({ memberId: "m_a", lastSeenAt: 3000 }),
        member({ memberId: "m_b", userId: "u_b", lastSeenAt: 1000 }),
        member({ memberId: "m_c", userId: "u_c", lastSeenAt: 2000 }),
      ],
    }));

    // Three undeparted members in a two-seat room, so two must go to seat one
    // more. The one heard from most recently keeps its seat.
    expect((await reclaimStaleSeats(store, await read(), joiner)).map((m) => m.memberId))
      .toEqual(["m_b", "m_c"]);
  });

  it("reaps nobody while the room has a seat going spare", async () => {
    await store.createSession(session({
      maxMembers: 5,
      members: [
        member({ memberId: "m_creator", lastSeenAt: Date.now() }),
        member({ memberId: "m_quiet", userId: "u_quiet", lastSeenAt: 1 }),
      ],
    }));

    expect(await reclaimStaleSeats(store, await read(), joiner)).toEqual([]);
    // Held for them, not taken: the joiner can have the free seat, so there is
    // no question to force.
    expect((await read()).members.find((m) => m.memberId === "m_quiet")?.leftAt).toBeNull();
    expect(await store.eventsAfter("qs_test", 0)).toEqual([]);
  });

  it("does nothing, and says nothing, when everyone is present", async () => {
    await store.createSession(session({
      members: [
        member({ memberId: "m_creator", lastSeenAt: Date.now() }),
        member({ memberId: "m_peer", userId: "u_peer", lastSeenAt: Date.now() }),
      ],
    }));

    expect(await reclaimStaleSeats(store, await read(), joiner)).toEqual([]);
    expect(await store.eventsAfter("qs_test", 0)).toEqual([]);
  });

  it("refuses a frozen room, so a lapsed plan costs nobody their place", async () => {
    await fullWithStalePeer();
    await store.freezeSession("qs_test", Date.now());

    expect(await reclaimStaleSeats(store, await read(), joiner)).toEqual([]);
    // Without the guard the removal would land and the announcement would not:
    // updateMember has no frozen guard, appendEvent returns null. Members gone
    // permanently and silently, from a state that is meant to be reversible.
    expect((await read()).members.find((m) => m.memberId === "m_peer")?.leftAt).toBeNull();
    expect(await store.eventsAfter("qs_test", 0)).toEqual([]);
  });

  it("refuses a closed room", async () => {
    await fullWithStalePeer();
    await store.closeSession("qs_test");

    expect(await reclaimStaleSeats(store, await read(), joiner)).toEqual([]);
  });

  it("does not reap the same member twice, however stale the caller's copy", async () => {
    await fullWithStalePeer();
    const copy = await read();

    await reclaimStaleSeats(store, copy, joiner);
    // The same pre-reap snapshot, replayed: a second joiner racing the first.
    await reclaimStaleSeats(store, copy, joiner);

    // One removal, one event. Two would show peers the same member timing out
    // twice and overwrite its recorded departure time.
    expect((await store.eventsAfter("qs_test", 0)).map((e) => e.type))
      .toEqual(["member_timed_out"]);
  });

  it("leaves the join code alone — freeing the seat is the whole point", async () => {
    await fullWithStalePeer();
    await reclaimStaleSeats(store, await read(), joiner);

    expect(await read()).toHaveProperty("joinCodes");
    expect(Object.keys((await read()).joinCodes)).not.toEqual([]);
  });

  it("does not close the room, even when it reaps its last member", async () => {
    // One stale member in a ONE-seat room, so the seat really is contested and
    // the reap really does run — the earlier version of this test used the
    // two-seat fixture, reaped nothing, and asserted against a no-op.
    await store.createSession(session({
      maxMembers: 1, members: [member({ memberId: "m_only", lastSeenAt: 1 })],
    }));

    expect((await reclaimStaleSeats(store, await read(), joiner)).map((m) => m.memberId))
      .toEqual(["m_only"]);

    // A joiner is waiting directly behind every call to this; closing the room
    // over them is the gap closeSessionIfEmpty exists to avoid.
    expect((await read()).closed).toBe(false);
  });

  it("stops counting a stale member against the room's capacity", async () => {
    await fullWithStalePeer();
    const room = await read();

    expect(room.maxMembers).toBe(2);
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
    const { creator, sessionId, creatorMemberId, joinerMemberId } = await pairUp(h);
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
