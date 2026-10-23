/**
 * A plan refusal ends with where yes is (#203): the cheapest plan on sale that allows what was refused,
 * at this server's /upgrade/<link>. It is in the refusal's own text, so every client shows it unchanged.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Harness, DEV_KEY, type Outcome } from "./helpers/harness.js";
import { brief, manifestFixture } from "./helpers/fixtures.js";
import { ENTITLEMENTS, upgradeHint } from "../src/auth.js";
import type { Identity, Plan } from "../src/types.js";

const links = {
  origin: "https://mcp.test",
  paymentLinks: { pro_monthly: "https://buy.stripe.com/pro", team_seat_monthly: "https://buy.stripe.com/team" },
};
const PRO = " Upgrade to pro: https://mcp.test/upgrade/pro_monthly";
const TEAM = " Upgrade to team: https://mcp.test/upgrade/team_seat_monthly";

describe("upgradeHint", () => {
  it("names the cheapest plan on sale that allows it", () => {
    expect(upgradeHint(links, (e) => e.modes.includes("swarm"))).toBe(PRO);
    expect(upgradeHint(links, (e) => e.orgScoping)).toBe(TEAM);
  });

  it("never names max, which is not on sale (#18), though it is cheaper than team and has a hosted seat", () => {
    const withMax = { ...links, paymentLinks: { ...links.paymentLinks, max_monthly: "https://buy.stripe.com/max" } };
    expect(upgradeHint(withMax, (e) => e.hostedRooms > 0)).toBe(TEAM);
  });

  it("names nothing when no plan on sale allows it, or this server has no link for one", () => {
    expect(upgradeHint(links, (e) => e.monthlyCreates > ENTITLEMENTS.team.monthlyCreates)).toBe("");
    expect(upgradeHint({ ...links, paymentLinks: {} }, (e) => e.orgScoping)).toBe("");
    expect(upgradeHint(undefined, (e) => e.orgScoping)).toBe("");
  });
});

describe("a plan refusal", () => {
  let h: Harness;
  afterEach(async () => { await h.close(); });

  const caller = (plan: Plan, role: Identity["role"] = "member", orgId: string | null = null): Identity =>
    ({ userId: `u_${plan}_${role}`, orgId, plan, role, label: plan });
  /** A caller on `plan` who has spent the month's creates. */
  const spent = async (plan: Plan) => {
    const who = caller(plan);
    for (let i = 0; i < ENTITLEMENTS[plan].monthlyCreates; i++) await h.store.recordCreate(who.userId);
    return h.connectAs(who);
  };
  const endsWith = (res: Outcome, hint: string) => {
    expect(res.isError, res.text).toBe(true);
    expect(res.text.endsWith(hint), res.text).toBe(true);
  };
  const start = (args: Record<string, unknown>) => ({ brief: brief(), manifest: manifestFixture(), ...args });

  it("sends free to pro for swarm mode, a public room and the month's creates, and pro to team for its creates", async () => {
    h = new Harness(undefined, undefined, { upgrade: links });
    const free = await h.connect(DEV_KEY.outsider);
    endsWith(await free.call("bellman_start", start({ manifest: manifestFixture({ preset: "swarm" }) })), PRO);
    endsWith(await free.call("bellman_start", start({ manifest: manifestFixture({ public: true }) })), PRO);
    endsWith(await (await spent("free")).call("bellman_start", start({})), PRO);
    endsWith(await (await spent("pro")).call("bellman_start", start({})), TEAM);
  });

  it("sends a caller to team for org_only, a hosted seat, a fourth hosted room on max and the audit log", async () => {
    h = new Harness(undefined, undefined, { upgrade: links });
    const peer = await h.connect(DEV_KEY.peer);
    endsWith(await peer.call("bellman_start", start({ org_only: true })), TEAM);
    const social = { room: "the square", preset: "social" };
    endsWith(await peer.call("bellman_start", start({ manifest: social })), TEAM);
    const max = await h.connectAs(caller("max"));
    for (let i = 0; i < ENTITLEMENTS.max.hostedRooms; i++) {
      const opened = await max.call("bellman_start", start({ manifest: social }));
      expect(opened.isError, opened.text).toBe(false);
    }
    endsWith(await max.call("bellman_start", start({ manifest: social })), TEAM);
    endsWith(await peer.call("bellman_audit"), TEAM);
  });

  it("names no plan when a plan is not the reason, or nothing on sale allows it", async () => {
    h = new Harness(undefined, undefined, { upgrade: links });
    const member = await h.connectAs(caller("team", "member", "org_x"));
    const audit = await member.call("bellman_audit");
    expect(audit.text).toContain("requires the admin role");
    expect(audit.text).not.toContain("Upgrade");
    expect((await (await spent("team")).call("bellman_start", start({}))).text).not.toContain("Upgrade");
  });

  it("reads as before on a server that sells no plan", async () => {
    h = new Harness();
    const free = await h.connect(DEV_KEY.outsider);
    const res = await free.call("bellman_start", start({ manifest: manifestFixture({ preset: "swarm" }) }));
    expect(res.text).toMatch(/swarm mode requires .* or upgrade\.$/);
  });
});
