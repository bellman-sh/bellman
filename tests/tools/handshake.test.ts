/**
 * INVARIANT 1: plan entitlements gate session CREATION only — joining is free.
 * INVARIANT 2: two-phase connect. Nothing of the joiner crosses until confirm.
 *              Join codes are single-use with a 15-minute unused TTL.
 * INVARIANT 7: member_id is per-connection, and a handle is drivable only by
 *              the identity that minted it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Harness, DEV_KEY } from "../helpers/harness.js";
import { brief, manifestFixture, openaiAgent } from "../helpers/fixtures.js";
import { JOIN_CODE_TTL } from "../../src/store.js";
import { ENTITLEMENTS } from "../../src/auth.js";
import type { Identity } from "../../src/types.js";

let h: Harness;

beforeEach(() => { h = new Harness(); });
afterEach(async () => { await h.close(); vi.useRealTimers(); });

/** Time travel without faking setTimeout — the transports stay real. */
function travel(ms: number): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + ms);
}

// ---------------------------------------------------------------------------
describe("INVARIANT 1 — entitlements gate creation, never joining", () => {
  it("blocks a free plan from creating a swarm session", async () => {
    const peer = await h.connect(DEV_KEY.peer);
    const res = await peer.call("bellman_start", { manifest: manifestFixture({ preset: "swarm" }), brief: brief() });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("pro or team");
  });

  it("lets a free plan create a pair session", async () => {
    const peer = await h.connect(DEV_KEY.peer);
    const res = await peer.call("bellman_start", { manifest: manifestFixture(), brief: brief() });
    expect(res.isError, res.text).toBe(false);
  });

  it("blocks a free plan from org_only, which needs the team plan", async () => {
    const peer = await h.connect(DEV_KEY.peer);
    const res = await peer.call("bellman_start", {
      manifest: manifestFixture(), brief: brief(), org_only: true,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("team plan");
  });

  it("lets a free plan JOIN a session created on the team plan", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const peer = await h.connect(DEV_KEY.peer);

    const started = await jesse.call("bellman_start", { manifest: manifestFixture(), brief: brief() });
    const preview = await peer.call("bellman_connect", {
      join_code: String(started.data.join_code),
    });
    expect(preview.isError, preview.text).toBe(false);

    const confirmed = await peer.call("bellman_confirm", {
      connect_token: String(preview.data.connect_token),
      brief: brief({ agent: openaiAgent }),
    });
    expect(confirmed.isError, confirmed.text).toBe(false);
  });

  it("lets a plan-less outsider join too — joining is never gated", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const outsider = await h.connect(DEV_KEY.outsider);

    const started = await jesse.call("bellman_start", { manifest: manifestFixture(), brief: brief() });
    const preview = await outsider.call("bellman_connect", {
      join_code: String(started.data.join_code),
    });
    const confirmed = await outsider.call("bellman_confirm", {
      connect_token: String(preview.data.connect_token),
      brief: brief({ agent: openaiAgent }),
    });
    expect(confirmed.isError, confirmed.text).toBe(false);
  });

  it("stops creation at the monthly quota but still allows joining", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const peer = await h.connect(DEV_KEY.peer);

    // Exhaust the free plan's monthly create quota for u_peer.
    for (let i = 0; i < ENTITLEMENTS.free.monthlyCreates; i++) {
      (await h.store.recordCreate("u_peer"));
    }

    const blocked = await peer.call("bellman_start", { manifest: manifestFixture(), brief: brief() });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain("monthly session limit");

    // The same quota-exhausted identity can still join someone else's session.
    const started = await jesse.call("bellman_start", { manifest: manifestFixture(), brief: brief() });
    const preview = await peer.call("bellman_connect", {
      join_code: String(started.data.join_code),
    });
    const confirmed = await peer.call("bellman_confirm", {
      connect_token: String(preview.data.connect_token),
      brief: brief({ agent: openaiAgent }),
    });
    expect(confirmed.isError, confirmed.text).toBe(false);
  });

  it("gives a pro plan swarm but not org scoping", async () => {
    const pro: Identity = {
      userId: "u_pro", orgId: "org_pro", plan: "pro", role: "member", label: "pro@x",
    };
    const client = await h.connectAs(pro);

    expect((await client.call("bellman_start", { manifest: manifestFixture({ preset: "swarm" }), brief: brief() })).isError).toBe(false);
    const orgOnly = await client.call("bellman_start", {
      manifest: manifestFixture(), brief: brief(), org_only: true,
    });
    expect(orgOnly.isError).toBe(true);
    expect(orgOnly.text).toContain("team plan");
  });

  it("refuses org_only for a team identity with no org", async () => {
    const orgless: Identity = {
      userId: "u_teamless", orgId: null, plan: "team", role: "admin", label: "teamless",
    };
    const client = await h.connectAs(orgless);
    const res = await client.call("bellman_start", {
      manifest: manifestFixture(), brief: brief(), org_only: true,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("no org");
  });
});

// ---------------------------------------------------------------------------
describe("INVARIANT 2 — two-phase connect", () => {
  it("previews the creator's brief and issues a connect token", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const peer = await h.connect(DEV_KEY.peer);
    const creatorBrief = brief({ goal: "Only the creator's goal is visible here" });

    const started = await jesse.call("bellman_start", { manifest: manifestFixture(), brief: creatorBrief });
    const preview = await peer.call("bellman_connect", {
      join_code: String(started.data.join_code),
    });

    expect(preview.isError, preview.text).toBe(false);
    expect(preview.data.connect_token).toBeTruthy();
    const envelope = preview.data.creator_brief as { data: { goal: string } };
    expect(envelope.data.goal).toBe(creatorBrief.goal);
  });

  /**
   * The sharp edge of the invariant: after preview, before confirm, the creator
   * must learn nothing about the joiner. No event, no brief, no identity.
   */
  it("leaks nothing about the joiner between connect and confirm", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const peer = await h.connect(DEV_KEY.peer);

    const started = await jesse.call("bellman_start", { manifest: manifestFixture(), brief: brief() });
    const sessionId = String(started.data.session_id);
    const creatorMemberId = String(started.data.member_id);

    const preview = await peer.call("bellman_connect", {
      join_code: String(started.data.join_code),
    });
    expect(preview.isError, preview.text).toBe(false);

    // Nothing of the joiner is echoed back in their own preview response.
    const previewJson = JSON.stringify(preview.data);
    expect(previewJson).not.toContain("u_peer");
    expect(previewJson).not.toContain("peer@codenerd");

    // And the creator sees no event at all.
    const sync = await jesse.call("bellman_sync", {
      session_id: sessionId, member_id: creatorMemberId, since_cursor: 0,
    });
    expect(sync.data.events).toEqual([]);
    expect((await h.store.getSession(sessionId))!.members).toHaveLength(1);
    expect((await h.store.getSession(sessionId))!.events).toHaveLength(0);
  });

  it("ships the joiner's brief only on confirm", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const peer = await h.connect(DEV_KEY.peer);
    const joinerBrief = brief({ goal: "Joiner goal crosses only at confirm", agent: openaiAgent });

    const started = await jesse.call("bellman_start", { manifest: manifestFixture(), brief: brief() });
    const preview = await peer.call("bellman_connect", {
      join_code: String(started.data.join_code),
    });
    await peer.call("bellman_confirm", {
      connect_token: String(preview.data.connect_token),
      brief: joinerBrief,
    });

    const sync = await jesse.call("bellman_sync", {
      session_id: String(started.data.session_id),
      member_id: String(started.data.member_id),
      since_cursor: 0,
    });
    const events = sync.data.events as { data: { type: string; payload: { brief: { goal: string } } } }[];
    const joined = events.find((e) => e.data.type === "member_joined");
    expect(joined?.data.payload.brief.goal).toBe(joinerBrief.goal);
  });

  it("burns the connect token on first use", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const peer = await h.connect(DEV_KEY.peer);

    const started = await jesse.call("bellman_start", { manifest: manifestFixture({ preset: "swarm" }), brief: brief() });
    const preview = await peer.call("bellman_connect", {
      join_code: String(started.data.join_code),
    });
    const token = String(preview.data.connect_token);

    expect((await peer.call("bellman_confirm", { connect_token: token, brief: brief() })).isError).toBe(false);
    const replay = await peer.call("bellman_confirm", { connect_token: token, brief: brief() });
    expect(replay.isError).toBe(true);
    expect(replay.text).toContain("invalid or expired");
  });

  it("binds the connect token to the identity that previewed", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const peer = await h.connect(DEV_KEY.peer);
    const outsider = await h.connect(DEV_KEY.outsider);

    const started = await jesse.call("bellman_start", { manifest: manifestFixture(), brief: brief() });
    const preview = await peer.call("bellman_connect", {
      join_code: String(started.data.join_code),
    });

    const stolen = await outsider.call("bellman_confirm", {
      connect_token: String(preview.data.connect_token),
      brief: brief(),
    });
    expect(stolen.isError).toBe(true);
    expect(stolen.text).toContain("invalid or expired");
  });

  it("consumes the join code once a pair session fills", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const peer = await h.connect(DEV_KEY.peer);
    const outsider = await h.connect(DEV_KEY.outsider);

    const started = await jesse.call("bellman_start", { manifest: manifestFixture(), brief: brief() });
    const joinCode = String(started.data.join_code);

    const preview = await peer.call("bellman_connect", { join_code: joinCode });
    await peer.call("bellman_confirm", {
      connect_token: String(preview.data.connect_token), brief: brief(),
    });

    const reused = await outsider.call("bellman_connect", { join_code: joinCode });
    expect(reused.isError).toBe(true);
    expect(reused.text).toContain("not found or expired");
  });

  it("keeps a swarm code alive until the session fills", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const peer = await h.connect(DEV_KEY.peer);
    const outsider = await h.connect(DEV_KEY.outsider);

    const started = await jesse.call("bellman_start", { manifest: manifestFixture({ preset: "swarm" }), brief: brief() });
    const joinCode = String(started.data.join_code);

    const p1 = await peer.call("bellman_connect", { join_code: joinCode });
    await peer.call("bellman_confirm", {
      connect_token: String(p1.data.connect_token), brief: brief(),
    });

    // Team swarm allows 25 members, so the code survives the second member.
    const p2 = await outsider.call("bellman_connect", { join_code: joinCode });
    expect(p2.isError, p2.text).toBe(false);
  });

  it("expires an unused join code after 15 minutes", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const peer = await h.connect(DEV_KEY.peer);

    const started = await jesse.call("bellman_start", { manifest: manifestFixture(), brief: brief() });
    travel(JOIN_CODE_TTL + 1_000);

    const late = await peer.call("bellman_connect", {
      join_code: String(started.data.join_code),
    });
    expect(late.isError).toBe(true);
    expect(late.text).toContain("15 minutes");
  });

  it("normalizes case and whitespace in a relayed join code", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const peer = await h.connect(DEV_KEY.peer);

    const started = await jesse.call("bellman_start", { manifest: manifestFixture(), brief: brief() });
    const messy = `  ${String(started.data.join_code).toLowerCase()} `;

    const preview = await peer.call("bellman_connect", { join_code: messy });
    expect(preview.isError, preview.text).toBe(false);
  });

  it("blocks an out-of-org joiner from an org_only session", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const outsider = await h.connect(DEV_KEY.outsider);

    const started = await jesse.call("bellman_start", {
      manifest: manifestFixture(), brief: brief(), org_only: true,
    });
    const res = await outsider.call("bellman_connect", {
      join_code: String(started.data.join_code),
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("org-restricted");
  });

  it("allows a same-org joiner into an org_only session", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const peer = await h.connect(DEV_KEY.peer); // free plan, same org

    const started = await jesse.call("bellman_start", {
      manifest: manifestFixture(), brief: brief(), org_only: true,
    });
    const res = await peer.call("bellman_connect", {
      join_code: String(started.data.join_code),
    });
    expect(res.isError, res.text).toBe(false);
  });

  it("rejects a confirm whose session filled during the preview window", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const peer = await h.connect(DEV_KEY.peer);
    const outsider = await h.connect(DEV_KEY.outsider);

    const started = await jesse.call("bellman_start", { manifest: manifestFixture(), brief: brief() });
    const joinCode = String(started.data.join_code);

    // Both preview while there is still room.
    const slow = await outsider.call("bellman_connect", { join_code: joinCode });
    const fast = await peer.call("bellman_connect", { join_code: joinCode });

    await peer.call("bellman_confirm", {
      connect_token: String(fast.data.connect_token), brief: brief(),
    });
    const tooLate = await outsider.call("bellman_confirm", {
      connect_token: String(slow.data.connect_token), brief: brief(),
    });

    expect(tooLate.isError).toBe(true);
    expect(tooLate.text).toContain("filled while you were confirming");
  });
});

// ---------------------------------------------------------------------------
describe("INVARIANT 7 — member handles are per-connection", () => {
  /** The core cross-machine case: one user pairing with themself. */
  it("mints distinct member ids when one user joins their own session", async () => {
    const machineA = await h.connect(DEV_KEY.jesse);
    const machineB = await h.connect(DEV_KEY.jesse);

    const started = await machineA.call("bellman_start", { manifest: manifestFixture(), brief: brief() });
    const preview = await machineB.call("bellman_connect", {
      join_code: String(started.data.join_code),
    });
    const confirmed = await machineB.call("bellman_confirm", {
      connect_token: String(preview.data.connect_token),
      brief: brief({ goal: "Same user, second machine" }),
    });

    expect(confirmed.isError, confirmed.text).toBe(false);
    expect(confirmed.data.member_id).not.toBe(started.data.member_id);

    const session = (await h.store.getSession(String(started.data.session_id)))!;
    expect(session.members).toHaveLength(2);
    expect(session.members.every((m) => m.userId === "u_jesse")).toBe(true);
    expect(new Set(session.members.map((m) => m.memberId)).size).toBe(2);
  });

  it("refuses to let another identity drive a member handle", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const peer = await h.connect(DEV_KEY.peer);

    const started = await jesse.call("bellman_start", { manifest: manifestFixture(), brief: brief() });
    const sessionId = String(started.data.session_id);
    const jesseMember = String(started.data.member_id);

    const preview = await peer.call("bellman_connect", {
      join_code: String(started.data.join_code),
    });
    await peer.call("bellman_confirm", {
      connect_token: String(preview.data.connect_token), brief: brief(),
    });

    for (const tool of ["bellman_sync", "bellman_leave"]) {
      const res = await peer.call(tool, { session_id: sessionId, member_id: jesseMember });
      expect(res.isError, tool).toBe(true);
      expect(res.text, tool).toContain("not yours");
    }

    const send = await peer.call("bellman_send", {
      session_id: sessionId, member_id: jesseMember,
      type: "message", payload: { text: "impersonation attempt" },
    });
    expect(send.isError).toBe(true);
    expect(send.text).toContain("not yours");
  });
});

// ---------------------------------------------------------------------------
describe("INVARIANT 8 — every room is declared", () => {
  it("refuses to start a room with no manifest", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const res = await jesse.call("bellman_start", { brief: brief() });
    expect(res.isError).toBe(true);
  });

  it("creates NO session when the manifest is malformed", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const res = await jesse.call("bellman_start", {
      brief: brief(),
      manifest: {
        room: "broken",
        mode: "pair",
        roles: { lead: { can: ["send"] } },
        default_role: "ghost",
        creator_role: "lead",
      },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('default_role "ghost" is not defined');
    // recordCreate() runs only after a session is stored, so an unchanged
    // quota is proof that nothing was created.
    expect(await h.store.countCreatesThisMonth("u_jesse")).toBe(0);
  });

  // Cross-field errors (a role the manifest never defines, a repeated verb) pass
  // the shape and are the ones the handler itself reports, under this prefix.
  it("prefixes a cross-field manifest error so the caller knows which argument failed", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const res = await jesse.call("bellman_start", {
      brief: brief(),
      manifest: {
        room: "dup",
        mode: "pair",
        roles: { lead: { can: ["send", "send"] } },
        default_role: "lead",
        creator_role: "lead",
      },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('invalid manifest — role "lead" lists duplicate verb "send"');
    expect(await h.store.countCreatesThisMonth("u_jesse")).toBe(0);
  });

  // A shape error never reaches the handler: the MCP SDK validates the tool's
  // inputSchema first, so this message carries no "invalid manifest — " prefix.
  // What the caller must still get is the offending field.
  it("names the offending field when the manifest's shape is wrong, and creates nothing", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const res = await jesse.call("bellman_start", {
      brief: brief(),
      manifest: { room: "r", preset: "no-such-preset" },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("preset");
    expect(await h.store.countCreatesThisMonth("u_jesse")).toBe(0);
  });

  it("creates NO session when the plan rejects the manifest's mode", async () => {
    const peer = await h.connect(DEV_KEY.peer); // free plan
    const before = await h.store.countCreatesThisMonth("u_peer");
    const res = await peer.call("bellman_start", {
      brief: brief(),
      manifest: { room: "too-big", preset: "swarm" },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("pro or team");
    expect(await h.store.countCreatesThisMonth("u_peer")).toBe(before);
  });

  it("gives the creator the manifest's creator_role", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const res = await jesse.call("bellman_start", {
      brief: brief(),
      manifest: { room: "r", preset: "review" },
    });
    expect(res.isError, res.text).toBe(false);
    const session = await h.store.getSession(String(res.data.session_id));
    expect(session?.members[0].roomRole).toBe("author");
  });

  it("derives mode from the manifest, not from an argument", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const res = await jesse.call("bellman_start", {
      brief: brief(),
      manifest: { room: "r", preset: "swarm" },
    });
    expect(res.isError, res.text).toBe(false);
    const session = await h.store.getSession(String(res.data.session_id));
    expect(session?.manifest.mode).toBe("swarm");
    expect(session?.maxMembers).toBeGreaterThan(2);
  });

  it("reports the manifest's mode in the connect preview", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const peer = await h.connect(DEV_KEY.peer);
    const started = await jesse.call("bellman_start", {
      brief: brief(),
      manifest: { room: "r", preset: "swarm" },
    });
    const preview = await peer.call("bellman_connect", {
      join_code: String(started.data.join_code),
    });
    expect(preview.isError, preview.text).toBe(false);
    expect((preview.data.session as { mode: string }).mode).toBe("swarm");
  });

  // The other tests here cite a preset. This is the only one that authors roles
  // and gets past the tool, so it also pins the exact shape the store holds.
  it("stores an authored manifest expanded, and seats the creator and the joiner by its roles", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const peer = await h.connect(DEV_KEY.peer);
    const started = await jesse.call("bellman_start", {
      brief: brief(),
      manifest: {
        room: "authored",
        purpose: "Pair on the flaky job",
        mode: "pair",
        roles: {
          driver: { can: ["send", "invite"], description: "Drives." },
          navigator: { can: ["send"] },
        },
        default_role: "navigator",
        creator_role: "driver",
      },
    });
    expect(started.isError, started.text).toBe(false);

    const preview = await peer.call("bellman_connect", {
      join_code: String(started.data.join_code),
    });
    const confirmed = await peer.call("bellman_confirm", {
      connect_token: String(preview.data.connect_token),
      brief: brief({ agent: openaiAgent }),
    });
    expect(confirmed.isError, confirmed.text).toBe(false);

    const session = await h.store.getSession(String(started.data.session_id));
    expect(session?.manifest).toEqual({
      room: "authored",
      purpose: "Pair on the flaky job",
      preset: null,
      mode: "pair",
      roles: {
        driver: { can: ["send", "invite"], description: "Drives." },
        navigator: { can: ["send"], description: null },
      },
      defaultRole: "navigator",
      creatorRole: "driver",
    });
    expect(session?.maxMembers).toBe(2);
    const roleOf = (userId: string) => session?.members.find((m) => m.userId === userId)?.roomRole;
    expect(roleOf("u_jesse")).toBe("driver");
    expect(roleOf("u_peer")).toBe("navigator");
  });
});
