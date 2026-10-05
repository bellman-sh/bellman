import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pairUp, type PairedSession } from "../helpers/flows.js";
import { brief } from "../helpers/fixtures.js";
import { DEV_KEY, Harness, envelopes, type Peer } from "../helpers/harness.js";
import { STALE_AFTER_MS } from "../../src/presence.js";

/**
 * A creator removing a member. The history stays open to the person removed — it
 * was theirs too — and the feed stops: what the room says after their removal
 * does not reach them, and a poll of theirs does not wait for it (#113). Writing
 * stops as well, and the room's roster changes.
 */
let h: Harness;

beforeEach(() => {
  h = new Harness();
});

afterEach(async () => {
  await h.close();
});

/** Both phases of joining on `joinCode`. Returns the confirm outcome for the caller to judge. */
async function join(peer: Peer, joinCode: unknown) {
  const preview = await peer.call("bellman_connect", { join_code: joinCode });
  expect(preview.isError, preview.text).toBe(false);
  return peer.call("bellman_confirm", {
    connect_token: String(preview.data.connect_token),
    brief: brief(),
    capabilities: ["read_context", "receive_messages"],
  });
}

/**
 * A third member of a swarm room, on a fresh code. The one removed has to be
 * somebody the room can carry on without: bellman_send refuses a room with nobody
 * else in it, so in a pair room the creator could not say anything afterwards.
 */
async function joinThird(s: PairedSession) {
  const issued = await s.creator.call("bellman_invite", {
    session_id: s.sessionId,
    member_id: s.creatorMemberId,
  });
  expect(issued.isError, issued.text).toBe(false);
  const peer = await h.connect(DEV_KEY.outsider);
  const confirmed = await join(peer, issued.data.join_code);
  expect(confirmed.isError, confirmed.text).toBe(false);
  return { peer, memberId: String(confirmed.data.member_id), cursor: Number(confirmed.data.cursor) };
}

describe("bellman_evict", () => {
  it("removes a member, who then sees why in their own sync", async () => {
    const s = await pairUp(h);

    const out = await s.creator.call("bellman_evict", {
      session_id: s.sessionId,
      member_id: s.joinerMemberId,
    });
    expect(out.isError, out.text).toBe(false);
    expect(out.data.evicted).toBe(true);

    const synced = await s.joiner.call("bellman_sync", {
      session_id: s.sessionId,
      member_id: s.joinerMemberId,
      since_cursor: s.joinerCursor,
      wait_seconds: 0,
    });
    const types = envelopes(synced.data.events).map((e) => (e.data as { type: string }).type);
    expect(types).toContain("member_evicted");
  });

  it("refuses the evicted member's next send", async () => {
    const s = await pairUp(h);
    await s.creator.call("bellman_evict", {
      session_id: s.sessionId,
      member_id: s.joinerMemberId,
    });

    const sent = await s.joiner.call("bellman_send", {
      session_id: s.sessionId,
      member_id: s.joinerMemberId,
      type: "message",
      payload: { text: "still here?" },
    });
    expect(sent.isError).toBe(true);
  });

  it("refuses a member who did not create the room", async () => {
    const s = await pairUp(h);

    const out = await s.joiner.call("bellman_evict", {
      session_id: s.sessionId,
      member_id: s.creatorMemberId,
    });

    expect(out.isError).toBe(true);
    expect(out.text).toContain("created this room");
  });

  it("reports the retired seat code", async () => {
    const s = await pairUp(h, { manifest: { room: "test-room", preset: "swarm" } });
    const issued = await s.creator.call("bellman_invite", {
      session_id: s.sessionId,
      member_id: s.creatorMemberId,
    });
    expect(issued.isError, issued.text).toBe(false);

    const out = await s.creator.call("bellman_evict", {
      session_id: s.sessionId,
      member_id: s.joinerMemberId,
    });

    expect(out.isError, out.text).toBe(false);
    expect(out.data.code_retired).toBe(String(issued.data.role));
    const stale = await h.connect(DEV_KEY.outsider);
    expect((await stale.call("bellman_connect", { join_code: issued.data.join_code })).isError)
      .toBe(true);
  });

  // The adapter is a mapping, so what is left to get wrong is a field that stops
  // following the operation: one hard-coded to a value, or one that never takes its
  // other value. Each field below is pinned at both ends of its range, in rooms
  // where the operation answers differently, and the whole object is compared so
  // an extra key cannot appear unnoticed.
  describe("what it reports is the operation's answer, field for field", () => {
    it("says no code was retired, and the room is active, when the seat's door was already shut", async () => {
      // A pair room consumes its code when it fills, so the joiner's seat has none.
      const s = await pairUp(h);

      const out = await s.creator.call("bellman_evict", {
        session_id: s.sessionId,
        member_id: s.joinerMemberId,
      });

      expect(out.isError, out.text).toBe(false);
      expect(out.data).toEqual({ evicted: true, code_retired: null, session_status: "active" });
    });

    it("says the room is closed when the member removed was the last one in it", async () => {
      const s = await pairUp(h);
      // The creator's authority is on the room, not on holding a seat in it, so
      // they can leave first and still remove whoever remains.
      const left = await s.creator.call("bellman_leave", {
        session_id: s.sessionId,
        member_id: s.creatorMemberId,
      });
      // The control: the joiner is still in, so this leave did not close the room
      // and the status below is the eviction's doing.
      expect(left.data.session_status).toBe("active");

      const out = await s.creator.call("bellman_evict", {
        session_id: s.sessionId,
        member_id: s.joinerMemberId,
      });

      expect(out.isError, out.text).toBe(false);
      expect(out.data).toEqual({ evicted: true, code_retired: null, session_status: "closed" });
    });

    it("shuts the seat's door behind a member who already left, and only once", async () => {
      const s = await pairUp(h, { manifest: { room: "test-room", preset: "swarm" } });
      const issued = await s.creator.call("bellman_invite", {
        session_id: s.sessionId,
        member_id: s.creatorMemberId,
      });
      expect(issued.isError, issued.text).toBe(false);
      // Leaving retires no code, so this one outlives the member whose seat it fills.
      await s.joiner.call("bellman_leave", {
        session_id: s.sessionId,
        member_id: s.joinerMemberId,
      });
      // The control: until the eviction the code is live, so a refusal after it
      // is the eviction's doing and not something about this caller or this room.
      const stranger = await h.connect(DEV_KEY.outsider);
      const before = await stranger.call("bellman_connect", { join_code: issued.data.join_code });
      expect(before.isError, before.text).toBe(false);

      const first = await s.creator.call("bellman_evict", {
        session_id: s.sessionId,
        member_id: s.joinerMemberId,
      });
      expect(first.isError, first.text).toBe(false);
      expect(first.data).toEqual({
        evicted: true, code_retired: String(issued.data.role), session_status: "active",
      });
      const after = await stranger.call("bellman_connect", { join_code: issued.data.join_code });
      expect(after.isError, after.text).toBe(true);

      const second = await s.creator.call("bellman_evict", {
        session_id: s.sessionId,
        member_id: s.joinerMemberId,
      });
      expect(second.isError, second.text).toBe(false);
      expect(second.data).toEqual({ evicted: true, code_retired: null, session_status: "active" });
    });
  });

  describe("what a refusal says", () => {
    // The wording lives in evictMember, which serves every transport, and the
    // handler only relays it. A tool name appended here would be advice that only
    // an MCP caller can act on; an agent reading "leave the room" already knows
    // which tool does that.
    it("tells a creator removing themselves to leave, in words that name no tool", async () => {
      const s = await pairUp(h);

      const out = await s.creator.call("bellman_evict", {
        session_id: s.sessionId,
        member_id: s.creatorMemberId,
      });

      expect(out.isError).toBe(true);
      expect(out.text).toContain("leave the room");
      expect(out.text).not.toContain("bellman_");
      // Refused means nothing was written: they are still in.
      const room = await h.store.getSession(s.sessionId);
      expect(room?.members.find((m) => m.memberId === s.creatorMemberId)?.leftAt).toBeNull();
    });
  });

  // The description makes promises about the person removed — the history stays
  // theirs, what follows does not reach them, and removal is not a ban — and each
  // is pinned by what happens rather than by the words, so whoever changes the
  // behaviour has to come back and change the sentence: these fail when they do.
  describe("what the person removed keeps, and what stops", () => {
    it("stops returning new events to them, while the history stays theirs", async () => {
      const s = await pairUp(h, { manifest: { room: "test-room", preset: "swarm" } });
      const third = await joinThird(s);
      const out = await s.creator.call("bellman_evict", {
        session_id: s.sessionId,
        member_id: third.memberId,
      });
      expect(out.isError, out.text).toBe(false);

      const sent = await s.creator.call("bellman_send", {
        session_id: s.sessionId,
        member_id: s.creatorMemberId,
        type: "message",
        payload: { text: "said after you were removed" },
      });
      expect(sent.isError, sent.text).toBe(false);

      const synced = await third.peer.call("bellman_sync", {
        session_id: s.sessionId,
        member_id: third.memberId,
        since_cursor: third.cursor,
        wait_seconds: 0,
      });
      expect(synced.isError, synced.text).toBe(false);
      const said = envelopes(synced.data.events)
        .map((e) => e.data as { type: string; payload: { text?: string } })
        .filter((d) => d.type === "message")
        .map((d) => d.payload.text);
      // The room went on talking; none of it reaches them.
      expect(said).toEqual([]);

      // The history is still theirs, including the event that removed them —
      // so the feed itself says why it stopped (#113 R4).
      const history = await third.peer.call("bellman_sync", {
        session_id: s.sessionId,
        member_id: third.memberId,
        since_cursor: 0,
        wait_seconds: 0,
      });
      expect(history.isError, history.text).toBe(false);
      const kinds = envelopes(history.data.events).map((e) => (e.data as { type: string }).type);
      expect(kinds).toContain("member_evicted");
      expect(kinds).not.toContain("message");
    });

    it("does not hold their long poll open, because there is nothing coming", async () => {
      // A pair room, because nothing may follow the removal. In a swarm room the
      // seat's door is shut after `member_evicted`, and that is announced as an
      // `invite_revoked` of its own: past the cut and hidden from the member,
      // but still there for a poll from the cut to find, so every implementation
      // answers at once — the one that waits as well as the one that does not.
      const s = await pairUp(h);
      await s.creator.call("bellman_evict", {
        session_id: s.sessionId,
        member_id: s.joinerMemberId,
      });

      // Read up to the cut first, because the poll under test has to START
      // there. From `joinerCursor` the member_evicted event is still ahead of
      // it, and the same is true: any implementation answers at once.
      const upToCut = await s.joiner.call("bellman_sync", {
        session_id: s.sessionId,
        member_id: s.joinerMemberId,
        since_cursor: s.joinerCursor,
        wait_seconds: 0,
      });
      expect(upToCut.isError, upToCut.text).toBe(false);
      // The controls: that read did reach the removal, and the record holds
      // nothing past the cursor it returned, so there is genuinely nothing for
      // the poll below to wait for. Without them a pass would only show that
      // something was already waiting.
      expect(envelopes(upToCut.data.events).map((e) => (e.data as { type: string }).type))
        .toContain("member_evicted");
      const cutCursor = Number(upToCut.data.cursor);
      expect(await h.store.eventsAfter(s.sessionId, cutCursor)).toEqual([]);

      const t0 = Date.now();
      const synced = await s.joiner.call("bellman_sync", {
        session_id: s.sessionId,
        member_id: s.joinerMemberId,
        since_cursor: cutCursor,
        wait_seconds: 3,
      });
      const waited = Date.now() - t0;

      expect(synced.isError, synced.text).toBe(false);
      expect(synced.data.events).toEqual([]);
      // A cut member that still waited would wake on every append it then
      // hides — a busy loop against a room it cannot read. Held for its three
      // seconds it reads as about 3000; answered at once, a few milliseconds.
      expect(waited).toBeLessThan(1_000);
    });

    // Review Focus 1.
    /**
     * The field a client needs to stop asking.
     *
     * The cut alone is invisible to a caller polling from past it: the slice is
     * empty and `session_status` still reads "active", which is indistinguishable
     * from a quiet room. A bridge restarted after the removal has no
     * `member_evicted` in hand either — its cursor is already past the event — so
     * `showsEvictionOf` can never fire for it, and it polls the 1-second floor
     * for the life of the process. Node's undici also collapses a /ws 403 into
     * the same bare `error` event as a 503 (see room-socket.ts), so the socket
     * arm cannot tell it either. This flag is the only signal that survives both.
     */
    it("tells them they are removed, on a poll that carries no events at all", async () => {
      const s = await pairUp(h, { manifest: { room: "test-room", preset: "swarm" } });
      const third = await joinThird(s);
      await s.creator.call("bellman_evict", {
        session_id: s.sessionId, member_id: third.memberId,
      });
      await s.creator.call("bellman_send", {
        session_id: s.sessionId, member_id: s.creatorMemberId,
        type: "message", payload: { text: "they must not see this" },
      });

      // From past the cut: the bridge-restarted case, where no event is returned.
      const blind = await third.peer.call("bellman_sync", {
        session_id: s.sessionId, member_id: third.memberId,
        since_cursor: 9_999, wait_seconds: 0,
      });
      expect(blind.isError, blind.text).toBe(false);
      expect(blind.data.events).toEqual([]);
      expect(blind.data.removed).toBe(true);

      // And on the poll that does carry the history, for the same reason.
      const withHistory = await third.peer.call("bellman_sync", {
        session_id: s.sessionId, member_id: third.memberId,
        since_cursor: 0, wait_seconds: 0,
      });
      expect(withHistory.data.removed).toBe(true);
    });

    it("says nothing of the kind to a member who left of their own accord", async () => {
      const s = await pairUp(h, { manifest: { room: "test-room", preset: "swarm" } });
      const third = await joinThird(s);
      await third.peer.call("bellman_leave", {
        session_id: s.sessionId, member_id: third.memberId,
      });

      const synced = await third.peer.call("bellman_sync", {
        session_id: s.sessionId, member_id: third.memberId,
        since_cursor: third.cursor, wait_seconds: 0,
      });

      // R2 again: a voluntary leaver keeps the open feed, so a client of theirs
      // must not be told to stop. `undefined` and not `false` — the field is
      // present only when it is true, as `replayed` and `ambient` are.
      expect(synced.data.removed).toBeUndefined();
    });

    /**
     * The other half R2 protects, and it needs a seat actually taken rather than
     * a name in a test title.
     *
     * A reclaim only happens when a room is FULL and someone needs the seat, so
     * this is a pair room: the joiner's seat is aged past the window, the creator
     * mints a code, and a third party redeeming it reclaims the stale seat. The
     * reclaimed member keeps the open feed, so nothing may tell its client to
     * stop asking.
     */
    it("says nothing of the kind to a member whose seat timed out", async () => {
      const s = await pairUp(h);
      // Aged past STALE_AFTER_MS, which is what makes the seat reclaimable.
      await h.store.updateMember(s.sessionId, s.joinerMemberId, {
        lastSeenAt: Date.now() - STALE_AFTER_MS - 1,
      });
      const invited = await s.creator.call("bellman_invite", {
        session_id: s.sessionId, member_id: s.creatorMemberId,
      });
      expect(invited.isError, invited.text).toBe(false);
      const taker = await h.connect(DEV_KEY.outsider);
      const confirmed = await join(taker, invited.data.join_code);
      expect(confirmed.isError, confirmed.text).toBe(false);

      const synced = await s.joiner.call("bellman_sync", {
        session_id: s.sessionId, member_id: s.joinerMemberId,
        since_cursor: 0, wait_seconds: 0,
      });

      // The arrangement, asserted rather than assumed: the seat really went.
      expect(envelopes(synced.data.events).map((e) => (e.data as { type: string }).type))
        .toContain("member_timed_out");
      expect(synced.data.removed, "a timed-out seat is not a removal (R2)").toBeUndefined();
    });

    it("says nothing of the kind to a member still in the room", async () => {
      const s = await pairUp(h, { manifest: { room: "test-room", preset: "swarm" } });
      const third = await joinThird(s);

      const synced = await third.peer.call("bellman_sync", {
        session_id: s.sessionId, member_id: third.memberId,
        since_cursor: third.cursor, wait_seconds: 0,
      });

      expect(synced.data.removed).toBeUndefined();
    });

    it("does not move their cursor backwards when they ask from past the cut", async () => {
      const s = await pairUp(h, { manifest: { room: "test-room", preset: "swarm" } });
      const third = await joinThird(s);
      await s.creator.call("bellman_evict", {
        session_id: s.sessionId,
        member_id: third.memberId,
      });
      await s.creator.call("bellman_send", {
        session_id: s.sessionId,
        member_id: s.creatorMemberId,
        type: "message",
        payload: { text: "well past their cut" },
      });

      const ahead = 9_999;
      const synced = await third.peer.call("bellman_sync", {
        session_id: s.sessionId,
        member_id: third.memberId,
        since_cursor: ahead,
        wait_seconds: 0,
      });

      expect(synced.isError, synced.text).toBe(false);
      expect(synced.data.events).toEqual([]);
      // Capping the RETURNED cursor to the cut would make a client that
      // round-trips it re-request the same empty range forever.
      expect(synced.data.cursor).toBe(ahead);
    });

    // Review Focus 3.
    it("cuts the old handle only: a fresh code reads the room again", async () => {
      const s = await pairUp(h, { manifest: { room: "test-room", preset: "swarm" } });
      const third = await joinThird(s);
      await s.creator.call("bellman_evict", {
        session_id: s.sessionId,
        member_id: third.memberId,
      });
      await s.creator.call("bellman_send", {
        session_id: s.sessionId,
        member_id: s.creatorMemberId,
        type: "message",
        payload: { text: "after the removal" },
      });

      // No `role`, and the field is `join_code` — both match the `joinThird`
      // helper at the top of this file. The swarm preset's roles are lead,
      // helper and observer; there is no "member" role to ask for.
      const invited = await s.creator.call("bellman_invite", {
        session_id: s.sessionId,
        member_id: s.creatorMemberId,
      });
      expect(invited.isError, invited.text).toBe(false);
      const rejoined = await join(third.peer, invited.data.join_code);
      expect(rejoined.isError, rejoined.text).toBe(false);

      const fresh = await third.peer.call("bellman_sync", {
        session_id: s.sessionId,
        member_id: String(rejoined.data.member_id),
        since_cursor: 0,
        wait_seconds: 0,
      });
      const freshKinds = envelopes(fresh.data.events).map((e) => (e.data as { type: string }).type);
      expect(freshKinds).toContain("message");

      // The cut is on the handle, not the person. R1: removal is not a ban.
      const old = await third.peer.call("bellman_sync", {
        session_id: s.sessionId,
        member_id: third.memberId,
        since_cursor: third.cursor,
        wait_seconds: 0,
      });
      expect(envelopes(old.data.events)
        .map((e) => (e.data as { type: string }).type)
        .filter((t) => t === "message")).toEqual([]);
    });

    // Review Focus 2, the poll half. The socket half is Task 4.
    it("caps the cut handle while the same person's live handle reads on", async () => {
      const s = await pairUp(h, { manifest: { room: "test-room", preset: "swarm" } });
      const first = await joinThird(s);
      // joinThird connects DEV_KEY.outsider every time, and one bearer key is
      // one userId — so a second call gives the SAME identity a second member
      // handle, which is exactly the input this test needs.
      const second = await joinThird(s);
      // The control for that premise, read from the record: two handles, one
      // person. Without it a room that quietly gave the second join the first's
      // seat would turn this into a test of nothing.
      expect(second.memberId).not.toBe(first.memberId);
      const room = await h.store.getSession(s.sessionId);
      const owners = room!.members
        .filter((m) => m.memberId === first.memberId || m.memberId === second.memberId)
        .map((m) => m.userId);
      expect(owners).toHaveLength(2);
      expect(new Set(owners).size).toBe(1);
      await s.creator.call("bellman_evict", {
        session_id: s.sessionId,
        member_id: first.memberId,
      });
      await s.creator.call("bellman_send", {
        session_id: s.sessionId,
        member_id: s.creatorMemberId,
        type: "message",
        payload: { text: "to whoever is left" },
      });

      const onCut = await first.peer.call("bellman_sync", {
        session_id: s.sessionId, member_id: first.memberId,
        since_cursor: first.cursor, wait_seconds: 0,
      });
      const onLive = await first.peer.call("bellman_sync", {
        session_id: s.sessionId, member_id: second.memberId,
        since_cursor: second.cursor, wait_seconds: 0,
      });

      const texts = (r: typeof onCut) => envelopes(r.data.events)
        .map((e) => e.data as { type: string; payload: { text?: string } })
        .filter((d) => d.type === "message").map((d) => d.payload.text);
      expect(texts(onCut)).toEqual([]);
      expect(texts(onLive)).toEqual(["to whoever is left"]);
    });

    // Review Focus 5.
    it("still serves their history after the removal closed the room", async () => {
      // A pair room closes when its last active member goes, and the creator is
      // active until they leave: removing the joiner alone leaves the room open.
      // So the creator leaves first, as in the closing case above, and the
      // removal is then what empties the room. bellman_sync has no closed guard
      // on reads.
      const s = await pairUp(h);
      const left = await s.creator.call("bellman_leave", {
        session_id: s.sessionId,
        member_id: s.creatorMemberId,
      });
      // The control: the joiner is still in, so the closing below is the
      // removal's doing and not the creator's leave.
      expect(left.data.session_status).toBe("active");
      const out = await s.creator.call("bellman_evict", {
        session_id: s.sessionId,
        member_id: s.joinerMemberId,
      });
      expect(out.data.session_status).toBe("closed");

      const history = await s.joiner.call("bellman_sync", {
        session_id: s.sessionId,
        member_id: s.joinerMemberId,
        since_cursor: 0,
        wait_seconds: 0,
      });

      expect(history.isError, history.text).toBe(false);
      expect(history.data.session_status).toBe("closed");
      // The removal itself, not merely some event: the cut keeps its own
      // announcement, and a closed room does not change that.
      expect(envelopes(history.data.events).map((e) => (e.data as { type: string }).type))
        .toContain("member_evicted");
    });

    it("leaves a member who LEFT reading the room, feed and all", async () => {
      const s = await pairUp(h, { manifest: { room: "test-room", preset: "swarm" } });
      const third = await joinThird(s);
      await third.peer.call("bellman_leave", {
        session_id: s.sessionId, member_id: third.memberId,
      });
      await s.creator.call("bellman_send", {
        session_id: s.sessionId, member_id: s.creatorMemberId,
        type: "message", payload: { text: "after they left of their own accord" },
      });

      const synced = await third.peer.call("bellman_sync", {
        session_id: s.sessionId, member_id: third.memberId,
        since_cursor: third.cursor, wait_seconds: 0,
      });
      // R2: leaving is a choice, and the open feed is deliberate there.
      expect(envelopes(synced.data.events)
        .map((e) => e.data as { type: string; payload: { text?: string } })
        .filter((d) => d.type === "message")
        .map((d) => d.payload.text)).toEqual(["after they left of their own accord"]);
    });

    it("does not tell the room which cursor cut a member", async () => {
      const s = await pairUp(h, { manifest: { room: "test-room", preset: "swarm" } });
      const third = await joinThird(s);
      const out = await s.creator.call("bellman_evict", {
        session_id: s.sessionId, member_id: third.memberId,
      });
      expect(out.isError, out.text).toBe(false);

      // The one surface that ships a member's CURRENT record is a confirm's
      // roster, which lists everyone the room has held, departed included — so
      // it takes a joiner after the removal for the removed handle to be on it
      // with its cut already recorded. Not `bellman_whoami`, which is the
      // bridge's own tool and answers about the caller, and not a replayed
      // member_joined payload, which is a snapshot taken before any cut exists.
      const invited = await s.creator.call("bellman_invite", {
        session_id: s.sessionId, member_id: s.creatorMemberId,
      });
      expect(invited.isError, invited.text).toBe(false);
      const rejoined = await join(third.peer, invited.data.join_code);
      expect(rejoined.isError, rejoined.text).toBe(false);
      const roster = rejoined.data.members as Record<string, unknown>[];

      const removed = roster.find((m) => m.member_id === third.memberId);
      const live = roster.find((m) => m.member_id === s.creatorMemberId);
      // The controls: the removed handle is on this roster, and as departed, so
      // what is absent below is about its cut and not about a roster that left
      // it out.
      expect(removed, "the removed member is on the roster").toBeDefined();
      expect(removed!.active).toBe(false);
      expect(live, "a member still in is on the roster").toBeDefined();

      // The point is not secrecy for its own sake: the roster already says a
      // member is departed. It is that no client needs the exact cursor at
      // which another member stopped being able to read (#113 D8).
      const serialized = JSON.stringify(rejoined.data);
      expect(serialized).not.toContain("removedAtCursor");
      expect(serialized).not.toContain("removed_at_cursor");
      // A leak need not be called either of those, so the shape is compared as
      // well: a removed member's entry carries nothing a live one's does not.
      expect(Object.keys(removed!).sort()).toEqual(Object.keys(live!).sort());
    });

    it("is not a ban: a fresh code seats them again, under a new handle", async () => {
      const s = await pairUp(h, { manifest: { room: "test-room", preset: "swarm" } });
      const third = await joinThird(s);
      const out = await s.creator.call("bellman_evict", {
        session_id: s.sessionId,
        member_id: third.memberId,
      });
      expect(out.isError, out.text).toBe(false);
      const fresh = await s.creator.call("bellman_invite", {
        session_id: s.sessionId,
        member_id: s.creatorMemberId,
      });
      expect(fresh.isError, fresh.text).toBe(false);

      const back = await join(third.peer, fresh.data.join_code);

      expect(back.isError, back.text).toBe(false);
      expect(back.data.member_id).not.toBe(third.memberId);
    });
  });

  describe("its declaration", () => {
    // The only tool that removes a person. A client uses the hints to decide how
    // hard to confirm before running a tool, so they are part of its contract.
    it("is destructive, not read-only, and not idempotent", async () => {
      const { tools } = await (await h.connect(DEV_KEY.jesse)).listTools();

      expect(tools.find((t) => t.name === "bellman_evict")?.annotations).toMatchObject({
        readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false,
      });
    });

    // Why the hint above is false. MCP defines it by effect: repeating a call with
    // the same arguments has no additional effect on its environment. This one can
    // have one: a code minted for the seat since the first call is live, so the
    // second call retires it, and says so. Whether to retry is a separate question
    // with the opposite answer: a repeat is how an interrupted eviction is finished.
    // This pins the behaviour the hint's value rests on, so that changing one
    // without the other is a decision and not an accident.
    it("is not free to repeat: a code minted for the seat in between is retired by the second call", async () => {
      const s = await pairUp(h, { manifest: { room: "test-room", preset: "swarm" } });
      const args = { session_id: s.sessionId, member_id: s.joinerMemberId };
      const first = await s.creator.call("bellman_evict", args);
      expect(first.isError, first.text).toBe(false);
      const minted = await s.creator.call("bellman_invite", {
        session_id: s.sessionId,
        member_id: s.creatorMemberId,
      });
      expect(minted.isError, minted.text).toBe(false);
      // The control: the new code is live, so a refusal after the repeat is the
      // repeat's doing and not something about this caller or this room.
      const stranger = await h.connect(DEV_KEY.outsider);
      const before = await stranger.call("bellman_connect", { join_code: minted.data.join_code });
      expect(before.isError, before.text).toBe(false);

      const second = await s.creator.call("bellman_evict", args);

      expect(second.isError, second.text).toBe(false);
      expect(second.data.code_retired).toBe(String(minted.data.role));
      const after = await stranger.call("bellman_connect", { join_code: minted.data.join_code });
      expect(after.isError, after.text).toBe(true);
    });

    // An operation with two effects has to name both. A caller who reads only
    // "removes a member" has no reason to expect the seat's code to stop working.
    it("names both of its effects", async () => {
      const { tools } = await (await h.connect(DEV_KEY.jesse)).listTools();
      const doc = tools.find((t) => t.name === "bellman_evict")!.description!.replace(/\s+/g, " ");

      expect(doc).toContain("Remove someone from a room you created");
      expect(doc).toContain("retires the join code for that member's seat");
    });

    it("no longer promises the person removed the room's new events", async () => {
      const { tools } = await (await h.connect(DEV_KEY.jesse)).listTools();
      const doc = tools.find((t) => t.name === "bellman_evict")!.description!.replace(/\s+/g, " ");

      expect(doc).toContain("The history stays readable to the person removed");
      expect(doc).toContain("new events do not reach them");
      // The sentence #112 shipped. It was true then and is false now.
      expect(doc).not.toContain("keeps returning new events");
      expect(doc).not.toContain("removal does not keep later messages from them");

      // The other sentence this change made false. A freeze landing mid-call
      // REFUSES and leaves the person in; it used to complete the removal and skip
      // the notice (#113 D2). The description said the old thing, and nothing
      // pinned it, so it outlived the behaviour.
      expect(doc, "the freeze sentence").not.toContain("the removal still completes, unannounced");
      // Two facts rather than one phrase. #113 wrote this as a single substring
      // ending "...and the person is still in the room", when the removal was an
      // append carrying the member write and the door had already been shut by a
      // separate call — so that sentence went on to say the code might be retired
      // anyway. The removal is one transaction now: a refusal writes nothing, and
      // the door is untouched. Pinning the claims separately keeps the test on the
      // behaviour instead of on the wording, and the third assertion is what stops
      // the retired-code caveat coming back now that it is false.
      expect(doc, "the freeze sentence").toContain("the call is refused");
      expect(doc, "the freeze sentence").toContain("the person is still in the room");
      expect(doc, "the freeze sentence").not.toContain("code may already be retired");
    });

    // The other half of the same promise, from the side of the agent it is made
    // about: a removed member's own bellman_sync is where the feed stops, and the
    // description it reads there should say so, including that waiting is pointless.
    it("tells a removed member's agent, in bellman_sync's own description, that the feed stops", async () => {
      const { tools } = await (await h.connect(DEV_KEY.jesse)).listTools();
      const doc = tools.find((t) => t.name === "bellman_sync")!.description!.replace(/\s+/g, " ");

      expect(doc).toContain("up to and including the member_evicted event that removed you");
      expect(doc).toContain("wait_seconds does not hold the request then");
    });

    // The description once said this path "changes nothing". It shuts a live door:
    // leaving retires no code, so a member who left on their own leaves their seat
    // open, and a creator who read "nothing" would repeat the call over an open
    // door and believe it shut. The behaviour is pinned above; this keeps the
    // sentence from drifting back.
    it("says that removing someone who already left still shuts their seat's door", async () => {
      const { tools } = await (await h.connect(DEV_KEY.jesse)).listTools();
      const doc = tools.find((t) => t.name === "bellman_evict")!.description!.replace(/\s+/g, " ");

      expect(doc).toContain("still retires their seat's code if one is live");
      expect(doc).not.toContain("changes nothing");
    });
  });
});
