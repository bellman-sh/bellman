/**
 * A cross-org session writes into BOTH orgs' audit streams, so each side sees
 * the crossings that touched its own boundary and nothing else. Getting that
 * wrong in either direction leaks one org's activity to the other, or leaves a
 * boundary crossing unrecorded.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Harness, DEV_KEY } from "../helpers/harness.js";
import { pairUp } from "../helpers/flows.js";
import { brief, manifestFixture, member, session } from "../helpers/fixtures.js";
import type { Identity } from "../../src/types.js";

let h: Harness;

beforeEach(() => { h = new Harness(); });
afterEach(async () => { await h.close(); });

const teamAdmin = (userId: string, orgId: string): Identity => ({
  userId, orgId, plan: "team", role: "admin", label: `${userId}@${orgId}`,
});

interface AuditRow { action: string; session_id: string; actor: string; detail: Record<string, unknown> }

function rows(data: Record<string, unknown>): AuditRow[] {
  return (data.entries ?? []) as AuditRow[];
}

describe("bellman_audit access control", () => {
  it("denies a free plan", async () => {
    const peer = await h.connect(DEV_KEY.peer);
    const res = await peer.call("bellman_audit", {});
    expect(res.isError).toBe(true);
    expect(res.text).toContain("team plan");
  });

  it("denies a team member who is not an admin", async () => {
    const client = await h.connectAs({
      userId: "u_teammate", orgId: "org_codenerd", plan: "team",
      role: "member", label: "teammate",
    });
    const res = await client.call("bellman_audit", {});
    expect(res.isError).toBe(true);
    expect(res.text).toContain("admin role");
  });

  it("denies a team admin with no org", async () => {
    const client = await h.connectAs({
      userId: "u_solo", orgId: null, plan: "team", role: "admin", label: "solo",
    });
    const res = await client.call("bellman_audit", {});
    expect(res.isError).toBe(true);
    expect(res.text).toContain("no org");
  });

  it("allows a team admin", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const res = await jesse.call("bellman_audit", {});
    expect(res.isError, res.text).toBe(false);
    expect(res.data.org_id).toBe("org_codenerd");
  });
});

describe("what the audit trail records", () => {
  it("captures every crossing in a full session lifecycle", async () => {
    const p = await pairUp(h);
    const req = await p.creator.call("bellman_send", {
      session_id: p.sessionId, member_id: p.creatorMemberId,
      type: "action_request", payload: { ask: "pull the webhook log" },
    });
    await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "action_response", ref_id: String(req.data.cursor),
      payload: { approved: true },
    });
    await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "done" },
    });
    await p.joiner.call("bellman_leave", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
    });

    const audit = await p.creator.call("bellman_audit", { limit: 100 });
    const actions = new Set(rows(audit.data).map((e) => e.action));

    for (const expected of [
      "session_created", "connect_previewed", "brief_exchanged",
      "sent_action_request", "sent_action_response", "sent_message", "member_left",
    ]) {
      expect(actions, expected).toContain(expected);
    }
  });

  it("honours the limit and returns the most recent entries", async () => {
    const p = await pairUp(h);
    for (let i = 0; i < 8; i++) {
      await p.joiner.call("bellman_send", {
        session_id: p.sessionId, member_id: p.joinerMemberId,
        type: "message", payload: { text: `msg ${i}` },
      });
    }

    const limited = await p.creator.call("bellman_audit", { limit: 3 });
    expect(rows(limited.data)).toHaveLength(3);
    expect(limited.data.count).toBe(3);
    expect(rows(limited.data).every((e) => e.action === "sent_message")).toBe(true);
  });

  it("scopes each org's log to its own boundary", async () => {
    const acme = await h.connectAs(teamAdmin("u_acme", "org_acme"));
    const other = await h.connectAs(teamAdmin("u_other", "org_other"));

    await acme.call("bellman_start", { manifest: manifestFixture(), brief: brief() });
    await other.call("bellman_start", { manifest: manifestFixture(), brief: brief() });

    const acmeLog = await acme.call("bellman_audit", { limit: 100 });
    const otherLog = await other.call("bellman_audit", { limit: 100 });

    expect(rows(acmeLog.data).every((e) => e.actor === "u_acme")).toBe(true);
    expect(rows(otherLog.data).every((e) => e.actor === "u_other")).toBe(true);
    expect(rows(acmeLog.data)).toHaveLength(1);
    expect(rows(otherLog.data)).toHaveLength(1);
  });

  it("records the mode and preset a room was created with", async () => {
    const acme = await h.connectAs(teamAdmin("u_acme", "org_acme"));
    const cited = await acme.call("bellman_start", {
      manifest: manifestFixture({ preset: "review" }), brief: brief(),
    });
    const authored = await acme.call("bellman_start", {
      manifest: {
        room: "authored", mode: "swarm",
        roles: { boss: { can: ["send"] } }, default_role: "boss", creator_role: "boss",
      },
      brief: brief(),
    });

    const log = rows((await acme.call("bellman_audit", { limit: 100 })).data);
    const createdDetail = (started: { data: Record<string, unknown> }) =>
      log.find((e) => e.action === "session_created" && e.session_id === String(started.data.session_id))?.detail;

    expect(createdDetail(cited)).toMatchObject({ mode: "pair", preset: "review" });
    // A room built from authored roles cites no preset.
    expect(createdDetail(authored)).toMatchObject({ mode: "swarm", preset: null });
  });

  /** The enterprise promise: a crossing shows up on both sides of the boundary. */
  it("writes a cross-org session into both orgs' streams", async () => {
    const acme = await h.connectAs(teamAdmin("u_acme", "org_acme"));
    const other = await h.connectAs(teamAdmin("u_other", "org_other"));

    const started = await acme.call("bellman_start", { manifest: manifestFixture(), brief: brief() });
    const sessionId = String(started.data.session_id);
    const preview = await other.call("bellman_connect", {
      join_code: String(started.data.join_code),
    });
    await other.call("bellman_confirm", {
      connect_token: String(preview.data.connect_token), brief: brief(),
    });

    const acmeLog = rows((await acme.call("bellman_audit", { limit: 100 })).data);
    const otherLog = rows((await other.call("bellman_audit", { limit: 100 })).data);

    // Both orgs see the brief exchange that crossed their boundary...
    expect(acmeLog.some((e) => e.action === "brief_exchanged")).toBe(true);
    expect(otherLog.some((e) => e.action === "brief_exchanged")).toBe(true);
    expect(acmeLog.every((e) => e.session_id === sessionId)).toBe(true);
    expect(otherLog.every((e) => e.session_id === sessionId)).toBe(true);

    // ...but only the creator's org logged the creation itself.
    expect(acmeLog.some((e) => e.action === "session_created")).toBe(true);
    expect(otherLog.some((e) => e.action === "session_created")).toBe(false);
  });

  /**
   * Nobody in the room sees a preview, and a previewer may never join, so only the room's org and
   * the previewer's record it (audit trail spec, D1). Bravo has a member in the room, and Charlie's
   * preview must not reach Bravo's log.
   */
  it("keeps a preview out of the log of an org whose member is in the room", async () => {
    const acme = await h.connectAs(teamAdmin("u_acme", "org_acme"));
    const bravo = await h.connectAs(teamAdmin("u_bravo", "org_bravo"));
    const charlie = await h.connectAs(teamAdmin("u_charlie", "org_charlie"));

    const started = await acme.call("bellman_start", { manifest: manifestFixture({ preset: "swarm" }), brief: brief() });
    const joinCode = String(started.data.join_code);
    const bravoPreview = await bravo.call("bellman_connect", { join_code: joinCode });
    await bravo.call("bellman_confirm", { connect_token: String(bravoPreview.data.connect_token), brief: brief() });
    const charliePreview = await charlie.call("bellman_connect", { join_code: joinCode });
    expect(charliePreview.isError, charliePreview.text).toBe(false);

    const previewers = async (peer: typeof acme) =>
      rows((await peer.call("bellman_audit", { limit: 100 })).data)
        .filter((e) => e.action === "connect_previewed").map((e) => e.actor).sort();
    expect(await previewers(acme), "the room's org records every preview").toEqual(["u_bravo", "u_charlie"]);
    expect(await previewers(charlie), "the previewer's org records its own").toEqual(["u_charlie"]);
    expect(await previewers(bravo), "bravo is told of its own preview, not of charlie's").toEqual(["u_bravo"]);
  });

  /**
   * The joiner's brief goes to the people in the room once the seat is taken, so the roster the row
   * is addressed from is the one after the seat. Bo's seat went quiet and Charlie's join takes it:
   * Bo's org is told the seat timed out, and is not told of a brief exchange Bo was never shown.
   */
  it("keeps the brief exchange from the org of the member the joiner's seat displaced", async () => {
    await h.store.createSession(session({
      id: "qs_stale", orgId: "org_acme",
      members: [
        member({ memberId: "m_ana", userId: "u_ana", label: "Ana", orgId: "org_acme" }),
        member({ memberId: "m_bo", userId: "u_bo", label: "Bo", orgId: "org_bravo", roomRole: "peer_b", lastSeenAt: 1 }),
      ],
    }));
    const charlie = await h.connectAs(teamAdmin("u_charlie", "org_charlie"));

    const preview = await charlie.call("bellman_connect", { join_code: "BELL-TEST-01" });
    const joined = await charlie.call("bellman_confirm", { connect_token: String(preview.data.connect_token), brief: brief() });
    expect(joined.isError, joined.text).toBe(false);

    const actions = async (orgId: string) => (await h.store.auditForOrg(orgId, 50)).map((e) => e.action);
    expect(await actions("org_bravo")).toEqual(["member_timed_out"]);
    expect(await actions("org_acme"), "the room's org still records the exchange").toContain("brief_exchanged");
  });

  it("keeps an unrelated org's activity out of the log", async () => {
    const acme = await h.connectAs(teamAdmin("u_acme", "org_acme"));
    const bystander = await h.connectAs(teamAdmin("u_bystander", "org_bystander"));

    await bystander.call("bellman_start", {
      manifest: manifestFixture(), brief: brief({ goal: "unrelated org business" }),
    });

    const acmeLog = await acme.call("bellman_audit", { limit: 100 });
    expect(rows(acmeLog.data)).toHaveLength(0);
    expect(JSON.stringify(acmeLog.data)).not.toContain("unrelated org business");
  });

  it("records nothing for an org-less identity's session", async () => {
    const outsider = await h.connect(DEV_KEY.outsider);
    const jesse = await h.connect(DEV_KEY.jesse);

    await outsider.call("bellman_start", { manifest: manifestFixture(), brief: brief() });

    const log = await jesse.call("bellman_audit", { limit: 100 });
    expect(rows(log.data)).toHaveLength(0);
  });
});
