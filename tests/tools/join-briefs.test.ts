/**
 * What a joiner is handed of the room's briefs (ADR 0018): the members heard from most
 * recently, at most BRIEFS_ON_JOIN of them, never one who has left, and a count of the rest.
 * A room seats a thousand, and a joiner's agent reads all it is handed.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Harness, DEV_KEY } from "../helpers/harness.js";
import { brief, member, swarmSession } from "../helpers/fixtures.js";
import { BRIEFS_ON_JOIN } from "../../src/tools/confirm.js";

let h: Harness;
beforeEach(() => { h = new Harness(); });

describe("the briefs a joiner is handed", () => {
  it("are the most recently heard-from members', at most BRIEFS_ON_JOIN, with a count of the rest", async () => {
    const now = Date.now();
    // m_00 was heard from last, and each member after it a second earlier. Two have left.
    const members = Array.from({ length: 40 }, (_, i) => member({
      memberId: `m_${String(i).padStart(2, "0")}`,
      userId: `u_member_${i}`,
      roomRole: "peer_b",
      brief: brief({ goal: `member ${i}` }),
      joinedAt: now - 100_000,
      lastSeenAt: now - i * 1000,
      leftAt: i === 1 || i === 2 ? now - 500 : null,
    }));
    await h.store.createSession(swarmSession({ members }));

    const joiner = await h.connect(DEV_KEY.outsider);
    const preview = await joiner.call("bellman_connect", { join_code: "BELL-TEST-01" });
    expect(preview.isError, preview.text).toBe(false);
    const joined = await joiner.call("bellman_confirm", {
      connect_token: String(preview.data.connect_token),
      brief: brief({ goal: "the joiner's" }),
    });
    expect(joined.isError, joined.text).toBe(false);

    const briefs = joined.data.briefs as { origin: { memberId: string }; data: { goal: string } }[];
    const present = members.filter((m) => m.leftAt === null);
    expect(briefs.map((b) => b.origin.memberId)).toEqual(present.slice(0, BRIEFS_ON_JOIN).map((m) => m.memberId));
    expect(briefs[0].data.goal).toBe("member 0");
    expect(joined.data.briefs_omitted).toBe(present.length - BRIEFS_ON_JOIN);
  });
});
