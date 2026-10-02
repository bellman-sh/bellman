import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pairUp, type PairedSession } from "../helpers/flows.js";
import { brief } from "../helpers/fixtures.js";
import { DEV_KEY, Harness, envelopes, type Peer } from "../helpers/harness.js";

/**
 * A creator removing a member. Reads stay open to the person removed — the
 * history was theirs too — so what changes is writing, and the room's roster.
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

  // The description makes two promises about the person removed, and both are
  // pinned by what happens rather than by the words, so whoever changes the
  // behaviour has to come back and change the sentence: these fail when they do.
  describe("what the person removed keeps", () => {
    it("keeps returning new events to them, including what is said after", async () => {
      const s = await pairUp(h, { manifest: { room: "test-room", preset: "swarm" } });
      const third = await joinThird(s);
      const out = await s.creator.call("bellman_evict", {
        session_id: s.sessionId,
        member_id: third.memberId,
      });
      expect(out.isError, out.text).toBe(false);
      // The control: they really are out. Writing stopped, and reading is the claim.
      const refused = await third.peer.call("bellman_send", {
        session_id: s.sessionId,
        member_id: third.memberId,
        type: "message",
        payload: { text: "still here?" },
      });
      expect(refused.isError).toBe(true);

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
      expect(said).toEqual(["said after you were removed"]);
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
