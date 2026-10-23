import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Harness } from "../helpers/harness.js";
import { brief, manifestFixture } from "../helpers/fixtures.js";
import { DEFAULT_POLICY, type Identity, type Org, type OrgPolicy, type PlanGrant } from "../../src/types.js";

const org = (orgId: string, policy: Partial<OrgPolicy> = {}): Org => ({
  orgId, name: orgId, ownerUserId: `u_${orgId}`, seats: 10, source: "operator", active: true, createdAt: 1,
  requireSso: false, domains: [], policy: { ...DEFAULT_POLICY, ...policy },
});
const grant = (orgId: string): PlanGrant => ({ key: `github:${orgId}`, plan: "team", role: "admin", orgId, source: "operator", grantedAt: 1, grantedBy: "u_op", expiresAt: null });
const who = (orgId: string | null, role: "admin" | "member" = "member", n = 1): Identity => ({ userId: `u_${orgId ?? "none"}_${n}`, orgId, plan: "team", role, label: `${orgId ?? "nobody"} ${n}` });
const by = { actorUserId: "u_op" };

let h: Harness;
beforeEach(() => { h = new Harness(); });
afterEach(async () => { await h.close(); });

const start = (peer: Awaited<ReturnType<Harness["connectAs"]>>, args: Record<string, unknown> = {}) =>
  peer.call("bellman_start", { manifest: manifestFixture({ preset: "swarm" }), brief: brief(), capabilities: ["read_context", "receive_messages"], ...args });
const join = async (peer: Awaited<ReturnType<Harness["connectAs"]>>, code: string, capabilities = ["read_context", "receive_messages"]) => {
  const c = await peer.call("bellman_connect", { join_code: code });
  if (c.isError) return c;
  return peer.call("bellman_confirm", { connect_token: c.data.connect_token, brief: brief(), capabilities });
};

describe("who_may_create", () => {
  it("refuses a member and admits an admin when admins_only, and binds nobody by default", async () => {
    await h.store.createOrg(org("org_a", { whoMayCreate: "admins_only" }), grant("org_a"), by);
    const member = await start(await h.connectAs(who("org_a")));
    expect([member.isError, member.text]).toEqual([true, "Error: your org's policy lets only admins start rooms."]);
    expect((await start(await h.connectAs(who("org_a", "admin")))).isError).toBe(false);
    await h.store.createOrg(org("org_b"), grant("org_b"), by);
    expect((await start(await h.connectAs(who("org_b")))).isError).toBe(false);
  });
});

describe("require_org_only", () => {
  it("makes the room org-only whatever the call said, says so in the result and the audit row, and keeps outsiders out", async () => {
    await h.store.createOrg(org("org_a", { requireOrgOnly: true }), grant("org_a"), by);
    const started = await start(await h.connectAs(who("org_a")), { org_only: false });
    const body = started.data as { org_only: boolean; session_id: string; join_code: string };
    expect([started.isError, body.org_only]).toEqual([false, true]);
    expect((await h.store.getSession(body.session_id))?.orgOnly).toBe(true);
    expect((await h.store.auditForOrg("org_a", 10)).at(-1)).toMatchObject({ action: "session_created", detail: { org_only: true } });
    const outsider = await (await h.connectAs(who(null))).call("bellman_connect", { join_code: body.join_code });
    expect(outsider.text).toBe("Error: session is org-restricted and your identity is not in the creator's org.");
  });
});

describe("forbidden_capabilities", () => {
  it("refuses the declaration at start and at confirm, on the declarer's own org, and creates nothing", async () => {
    await h.store.createOrg(org("org_a", { forbiddenCapabilities: ["request_actions"] }), grant("org_a"), by);
    await h.store.createOrg(org("org_b"), grant("org_b"), by);
    const a = await h.connectAs(who("org_a"));
    const refused = await start(a, { capabilities: ["read_context", "request_actions"] });
    expect([refused.isError, refused.text]).toEqual([true, "Error: your org's policy forbids granting request_actions to peers; call again without it."]);
    expect(await h.store.countCreatesThisMonth(a.identity.userId)).toBe(0);
    const started = (await start(await h.connectAs(who("org_b")))).data as { session_id: string; join_code: string };
    const joined = await join(a, started.join_code, ["read_context", "request_actions"]);
    expect([joined.isError, joined.text]).toEqual([true, "Error: your org's policy forbids granting request_actions to peers; call again without it."]);
    expect((await h.store.getSession(started.session_id))?.members).toHaveLength(1);
    expect((await join(a, started.join_code)).isError).toBe(false);
  });
});

describe("allowed_counterparty_orgs", () => {
  it("binds the joiner's side and the room's side, and a room with a creator outside any org", async () => {
    await h.store.createOrg(org("org_a", { allowedCounterpartyOrgs: ["org_b"] }), grant("org_a"), by);
    await h.store.createOrg(org("org_b"), grant("org_b"), by);
    await h.store.createOrg(org("org_c"), grant("org_c"), by);
    const inA = (await start(await h.connectAs(who("org_a")))).data as { session_id: string; join_code: string };
    expect((await join(await h.connectAs(who("org_b")), inA.join_code)).isError).toBe(false);
    const c = await join(await h.connectAs(who("org_c")), inA.join_code);
    expect(c.text).toBe('Error: org "org_a"\'s policy does not allow members of your org in its rooms.');
    expect((await join(await h.connectAs(who(null)), inA.join_code)).text).toBe('Error: org "org_a"\'s policy does not allow members of your org in its rooms.');
    const inC = (await start(await h.connectAs(who("org_c")))).data as { session_id: string; join_code: string };
    expect((await join(await h.connectAs(who("org_a", "member", 2)), inC.join_code)).text).toBe('Error: your org\'s policy does not allow rooms with org "org_c".');
    const noOrg = (await start(await h.connectAs(who(null, "member", 2)))).data as { session_id: string; join_code: string };
    expect((await join(await h.connectAs(who("org_a", "member", 3)), noOrg.join_code)).text).toBe("Error: your org's policy does not allow rooms with a creator outside any org.");
  });

  it("is read again at confirm, so a policy tightened between preview and seat refuses the seat", async () => {
    await h.store.createOrg(org("org_a"), grant("org_a"), by);
    await h.store.createOrg(org("org_b"), grant("org_b"), by);
    const inA = (await start(await h.connectAs(who("org_a")))).data as { session_id: string; join_code: string };
    const b = await h.connectAs(who("org_b"));
    const preview = await b.call("bellman_connect", { join_code: inA.join_code });
    expect(preview.isError).toBe(false);
    await h.store.updateOrg("org_a", { policy: { allowedCounterpartyOrgs: [] } }, by);
    const seat = await b.call("bellman_confirm", { connect_token: preview.data.connect_token, brief: brief(), capabilities: ["read_context"] });
    expect(seat.text).toBe('Error: org "org_a"\'s policy does not allow members of your org in its rooms.');
  });
});
