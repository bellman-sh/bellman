/**
 * The max plan (#45): team-sized, long-lived rooms for one person, with none
 * of the org machinery. org_only scoping and the audit log stay team-only —
 * that is why a company with several people creating rooms still buys team.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Harness } from "../helpers/harness.js";
import { brief, manifestFixture } from "../helpers/fixtures.js";
import type { Identity } from "../../src/types.js";

let h: Harness;

beforeEach(() => { h = new Harness(); });
afterEach(async () => { await h.close(); });

/** Max with an org, so a refusal below is the plan's and not a missing org's. */
const max: Identity = { userId: "u_max", orgId: "org_max", plan: "max", role: "member", label: "max" };

describe("a room created on the max plan", () => {
  it("is a swarm that seats 25 members and refuses a 26th", async () => {
    const creator = await h.connectAs(max);
    const started = await creator.call("bellman_start", {
      manifest: manifestFixture({ preset: "swarm" }), brief: brief(),
    });
    expect(started.isError, started.text).toBe(false);
    const sessionId = String(started.data.session_id);
    const memberId = String(started.data.member_id);

    // A code is single-use, so every member after the first joins on a reissued one.
    let code = String(started.data.join_code);
    for (let n = 2; n <= 25; n++) {
      if (n > 2) {
        const issued = await creator.call("bellman_invite", { session_id: sessionId, member_id: memberId });
        expect(issued.isError, `code for member ${n}: ${issued.text}`).toBe(false);
        code = String(issued.data.join_code);
      }
      const joiner = await h.connectAs({ userId: `u_${n}`, orgId: null, plan: "free", role: "member", label: `m${n}` });
      const preview = await joiner.call("bellman_connect", { join_code: code });
      expect(preview.isError, `member ${n}: ${preview.text}`).toBe(false);
      const joined = await joiner.call("bellman_confirm", {
        connect_token: String(preview.data.connect_token), brief: brief(),
      });
      expect(joined.isError, `member ${n}: ${joined.text}`).toBe(false);
    }

    const session = await h.store.getSession(sessionId);
    expect(session?.members.filter((m) => m.leftAt === null)).toHaveLength(25);

    // Full: no code can be issued, so nobody else gets in.
    const refused = await creator.call("bellman_invite", { session_id: sessionId, member_id: memberId });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/full/);
  });

  it("cannot be org_only, which stays with the team plan", async () => {
    const creator = await h.connectAs(max);
    const res = await creator.call("bellman_start", {
      manifest: manifestFixture(), brief: brief(), org_only: true,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("team plan");
  });

  it("has no audit log, which stays with the team plan", async () => {
    const creator = await h.connectAs({ ...max, role: "admin" });
    const res = await creator.call("bellman_audit", {});
    expect(res.isError).toBe(true);
    expect(res.text).toContain("team plan");
  });
});
