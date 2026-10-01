import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pairUp } from "../helpers/flows.js";
import { DEV_KEY, Harness, envelopes } from "../helpers/harness.js";

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
  // following the operation. The tests above read `evicted` and one value of
  // `code_retired`, and never read `session_status`: a handler that hard-coded
  // "active" would have passed all four. Each field below is pinned at both ends
  // of its range, in rooms where the operation answers differently, and the whole
  // object is compared so a fourth key cannot appear unnoticed.
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

  describe("its declaration", () => {
    // The only tool that removes a person. A client uses the hints to decide how
    // hard to confirm before running a tool, so they are part of its contract.
    it("is destructive, and not read-only", async () => {
      const { tools } = await (await h.connect(DEV_KEY.jesse)).listTools();

      expect(tools.find((t) => t.name === "bellman_evict")?.annotations).toMatchObject({
        readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false,
      });
    });

    // An operation with two effects has to name both. A caller who reads only
    // "removes a member" has no reason to expect the seat's code to stop working.
    it("names both of its effects", async () => {
      const { tools } = await (await h.connect(DEV_KEY.jesse)).listTools();
      const doc = tools.find((t) => t.name === "bellman_evict")!.description!.replace(/\s+/g, " ");

      expect(doc).toContain("Remove someone from a room you created");
      expect(doc).toContain("retires the join code for that member's seat");
    });
  });
});
