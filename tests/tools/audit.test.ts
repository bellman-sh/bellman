/**
 * The audit trail is where the team plan's value concentrates: a cross-org
 * session writes into BOTH orgs' streams, so each side sees the crossings that
 * touched its own boundary and nothing else.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Harness, DEV_KEY } from "../helpers/harness.js";
import { pairUp } from "../helpers/flows.js";
import { brief } from "../helpers/fixtures.js";
import type { Identity } from "../../src/types.js";

let h: Harness;

beforeEach(() => { h = new Harness(); });
afterEach(async () => { await h.close(); });

const teamAdmin = (userId: string, orgId: string): Identity => ({
  userId, orgId, plan: "team", role: "admin", label: `${userId}@${orgId}`,
});

interface AuditRow { action: string; session_id: string; actor: string }

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

    await acme.call("bellman_start", { mode: "pair", brief: brief() });
    await other.call("bellman_start", { mode: "pair", brief: brief() });

    const acmeLog = await acme.call("bellman_audit", { limit: 100 });
    const otherLog = await other.call("bellman_audit", { limit: 100 });

    expect(rows(acmeLog.data).every((e) => e.actor === "u_acme")).toBe(true);
    expect(rows(otherLog.data).every((e) => e.actor === "u_other")).toBe(true);
    expect(rows(acmeLog.data)).toHaveLength(1);
    expect(rows(otherLog.data)).toHaveLength(1);
  });

  /** The enterprise promise: a crossing shows up on both sides of the boundary. */
  it("writes a cross-org session into both orgs' streams", async () => {
    const acme = await h.connectAs(teamAdmin("u_acme", "org_acme"));
    const other = await h.connectAs(teamAdmin("u_other", "org_other"));

    const started = await acme.call("bellman_start", { mode: "pair", brief: brief() });
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

  it("keeps an unrelated org's activity out of the log", async () => {
    const acme = await h.connectAs(teamAdmin("u_acme", "org_acme"));
    const bystander = await h.connectAs(teamAdmin("u_bystander", "org_bystander"));

    await bystander.call("bellman_start", {
      mode: "pair", brief: brief({ goal: "unrelated org business" }),
    });

    const acmeLog = await acme.call("bellman_audit", { limit: 100 });
    expect(rows(acmeLog.data)).toHaveLength(0);
    expect(JSON.stringify(acmeLog.data)).not.toContain("unrelated org business");
  });

  it("records nothing for an org-less identity's session", async () => {
    const outsider = await h.connect(DEV_KEY.outsider);
    const jesse = await h.connect(DEV_KEY.jesse);

    await outsider.call("bellman_start", { mode: "pair", brief: brief() });

    const log = await jesse.call("bellman_audit", { limit: 100 });
    expect(rows(log.data)).toHaveLength(0);
  });
});
