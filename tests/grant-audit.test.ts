import { describe, it, expect } from "vitest";
import { grantAuditEntries, revokeAuditEntries, type AuditIntent } from "../src/grant-audit.js";
import type { PlanGrant } from "../src/types.js";

const NOW = 1_700_000_000_000;
const admin: AuditIntent = { actorUserId: "u_admin" };

const grant = (over: Partial<PlanGrant> = {}): PlanGrant => ({
  key: "github:4242", plan: "team", role: "admin", orgId: "org_mine",
  source: "operator", grantedAt: NOW, grantedBy: "u_admin", expiresAt: null, ...over,
});

describe("grantAuditEntries", () => {
  it("records a new grant against the org it lands in", () => {
    expect(grantAuditEntries(undefined, grant(), admin, NOW)).toEqual([{
      at: NOW, orgId: "org_mine", sessionId: "grant:github:4242", actorUserId: "u_admin",
      action: "plan_granted",
      detail: {
        plan: "team", role: "admin", org_id: "org_mine", source: "operator",
        key: "github:4242",
      },
    }]);
  });

  /**
   * Stripe delivers the same event twice and delivers events for changes that
   * do not move the plan. Auditing every write would fill the org stream with
   * lines saying nothing happened.
   */
  it("records nothing when plan, role and org all match", () => {
    expect(grantAuditEntries(grant(), grant({ grantedAt: NOW + 5 }), admin, NOW)).toEqual([]);
  });

  it("records a change when any of plan, role or org moved", () => {
    expect(grantAuditEntries(grant(), grant({ plan: "pro" }), admin, NOW)).toHaveLength(1);
    expect(grantAuditEntries(grant(), grant({ role: "member" }), admin, NOW)).toHaveLength(1);
  });

  /**
   * Leaving an org is a revocation for that org, and it is the only place it
   * will ever be recorded: the grant is re-homed rather than deleted, so the
   * plan_granted goes to the new org and the old one would otherwise hear
   * nothing. A team subscription ending while a pro one continues does this.
   */
  it("revokes from the old org and grants to the new one when the org moves", () => {
    const entries = grantAuditEntries(
      grant({ orgId: "org_old" }), grant({ orgId: "org_new" }), admin, NOW
    );
    expect(entries.map((e) => [e.orgId, e.action])).toEqual([
      ["org_old", "plan_revoked"],
      ["org_new", "plan_granted"],
    ]);
    expect(entries[0].detail).toMatchObject({ moved_to: "org_new", plan: "team" });
    expect(entries[1].detail).toMatchObject({ replaced_plan: "team" });
  });

  /**
   * Review Focus 1. The audit log is org-scoped, so an org-less grant — every
   * pro purchase — has nowhere to be recorded. Emitting a row for one would
   * queue something that can never be delivered, and it sits at the head of a
   * FIFO queue blocking everything behind it.
   */
  it("records nothing for an org-less grant", () => {
    expect(grantAuditEntries(
      undefined, grant({ orgId: null, plan: "pro", role: "member" }), admin, NOW
    )).toEqual([]);
  });

  /**
   * Review Focus 5. Billing needs to say WHY on a revocation, and needs its
   * Stripe customer on a grant. The caller's detail wins over the store's so it
   * can annotate — but never over `key`, which names the record itself.
   */
  it("merges caller detail over store-filled fields, except key", () => {
    const intent: AuditIntent = {
      actorUserId: "stripe",
      detail: { stripe_customer: "cus_1", source: "purchase", key: "github:evil" },
    };
    const [entry] = grantAuditEntries(undefined, grant({ source: "purchase" }), intent, NOW);
    expect(entry.detail).toMatchObject({ stripe_customer: "cus_1", source: "purchase" });
    expect(entry.detail.key).toBe("github:4242");
  });
});

describe("revokeAuditEntries", () => {
  it("records a revocation against the org the grant was in", () => {
    const intent: AuditIntent = { actorUserId: "stripe", detail: { reason: "no longer paying" } };
    expect(revokeAuditEntries(grant(), intent, NOW)).toEqual([{
      at: NOW, orgId: "org_mine", sessionId: "grant:github:4242", actorUserId: "stripe",
      action: "plan_revoked",
      detail: { plan: "team", reason: "no longer paying", key: "github:4242" },
    }]);
  });

  it("records nothing when the removed grant had no org", () => {
    expect(revokeAuditEntries(grant({ orgId: null }), admin, NOW)).toEqual([]);
  });
});

/**
 * Everything from here on was added after sweeping wrong implementations of the
 * rule against the cases above. Each case pins something those leave open.
 *
 * Grants here keep grantedBy as u_admin even when the intent is Stripe's: an
 * entry's actor is the intent's, never the grant's, and a fixture where the two
 * agree could not tell.
 */
const billing: AuditIntent = { actorUserId: "stripe", detail: { stripe_customer: "cus_1" } };

describe("grantAuditEntries, field by field", () => {
  /**
   * Plan, role and org are the whole comparison. A redelivered Stripe event
   * rewrites grantedAt and nothing else; an admin saving a grant again changes
   * who granted it. Neither tells an org anything. The cost is that a change to
   * source or expiry alone is not recorded either.
   */
  it.each<[string, Partial<PlanGrant>]>([
    ["grantedBy", { grantedBy: "u_other" }],
    ["source", { source: "purchase" }],
    ["expiresAt", { expiresAt: NOW + 86_400_000 }],
  ])("records nothing when only %s differs", (_field, over) => {
    expect(grantAuditEntries(grant(), grant(over), admin, NOW)).toEqual([]);
  });

  /**
   * A team subscription ending while a pro one continues re-homes the grant to
   * no org. The org it left is told, and that is the only entry: nothing may be
   * filed against the org-less side.
   */
  it("tells only the org a plan left when the grant becomes org-less", () => {
    const entries = grantAuditEntries(
      grant(), grant({ orgId: null, plan: "pro", role: "member", source: "purchase" }), billing, NOW
    );
    expect(entries).toEqual([{
      at: NOW, orgId: "org_mine", sessionId: "grant:github:4242", actorUserId: "stripe",
      action: "plan_revoked",
      detail: {
        plan: "team", reason: "moved to another plan", moved_to: null,
        stripe_customer: "cus_1", key: "github:4242",
      },
    }]);
  });

  /**
   * The same boundary from the other side: a pro subscriber buys team. The new
   * org is told. The org-less side the grant came from is not written to.
   */
  it("tells only the org a plan arrives in when the grant was org-less", () => {
    const entries = grantAuditEntries(
      grant({ orgId: null, plan: "pro", role: "member", source: "purchase" }),
      grant({ source: "purchase" }), billing, NOW
    );
    expect(entries.map((e) => [e.orgId, e.action])).toEqual([["org_mine", "plan_granted"]]);
    expect(entries[0].detail).toMatchObject({ plan: "team", replaced_plan: "pro" });
  });

  /**
   * Every field names the grant as it is now, except the ones that exist to say
   * what it was. All four fields differ here, so a field read from the wrong
   * side of the change cannot agree by accident.
   */
  it("describes the grant as it is now and names what it replaced", () => {
    const previous = grant({ plan: "pro", role: "member", orgId: "org_old", source: "operator" });
    const next = grant({ plan: "team", role: "admin", orgId: "org_new", source: "purchase" });
    expect(grantAuditEntries(previous, next, billing, NOW)).toEqual([
      {
        at: NOW, orgId: "org_old", sessionId: "grant:github:4242", actorUserId: "stripe",
        action: "plan_revoked",
        detail: {
          plan: "pro", reason: "moved to another plan", moved_to: "org_new",
          stripe_customer: "cus_1", key: "github:4242",
        },
      },
      {
        at: NOW, orgId: "org_new", sessionId: "grant:github:4242", actorUserId: "stripe",
        action: "plan_granted",
        detail: {
          plan: "team", role: "admin", org_id: "org_new", source: "purchase",
          replaced_plan: "pro", stripe_customer: "cus_1", key: "github:4242",
        },
      },
    ]);
  });

  /** toEqual cannot see this: it treats a key holding undefined as absent. */
  it("does not claim a first grant replaced anything", () => {
    const [entry] = grantAuditEntries(undefined, grant(), admin, NOW);
    expect(Object.keys(entry.detail)).not.toContain("replaced_plan");
  });
});

describe("revokeAuditEntries, field by field", () => {
  /** What the admin route passes: an actor, and nothing to add. */
  it("says which plan was lost, and nothing more, when the caller adds nothing", () => {
    expect(revokeAuditEntries(grant(), admin, NOW)).toEqual([{
      at: NOW, orgId: "org_mine", sessionId: "grant:github:4242", actorUserId: "u_admin",
      action: "plan_revoked", detail: { plan: "team", key: "github:4242" },
    }]);
  });
});

describe("every entry", () => {
  /**
   * `now` is when the store committed the change. A grant's grantedAt is when it
   * was first made, which says nothing about when this entry was written.
   */
  it("is stamped with the time it was given, not the grant's", () => {
    const later = NOW + 60_000;
    const entries = [
      ...grantAuditEntries(undefined, grant(), admin, later),
      ...grantAuditEntries(grant({ orgId: "org_old" }), grant({ orgId: "org_new" }), admin, later),
      ...revokeAuditEntries(grant(), admin, later),
    ];
    expect(entries.map((e) => e.at)).toEqual([later, later, later, later]);
  });

  /**
   * The caller may replace anything the store filled in — billing gives its own
   * reason for a move — and nothing but `key`, at each of the three places an
   * entry is made. The caller supplies every field here, so whatever the store
   * would have said shows up as a field that failed to be replaced.
   */
  it("lets the caller replace every field the store fills in, except key", () => {
    const said = {
      plan: "x", role: "x", org_id: "x", source: "x", reason: "x", moved_to: "x", replaced_plan: "x",
    };
    const intent: AuditIntent = {
      actorUserId: "stripe", detail: { ...said, stripe_customer: "cus_1", key: "github:evil" },
    };
    const entries = [
      ...grantAuditEntries(undefined, grant(), intent, NOW),
      ...grantAuditEntries(grant({ orgId: "org_old" }), grant({ orgId: "org_new" }), intent, NOW),
      ...revokeAuditEntries(grant(), intent, NOW),
    ];
    expect(entries).toHaveLength(4);
    for (const e of entries) {
      expect(e.detail).toEqual({ ...said, stripe_customer: "cus_1", key: "github:4242" });
      expect(e.sessionId).toBe("grant:github:4242");
    }
  });

  /**
   * One intent serves both entries of an org move, and the store keeps hold of
   * the grants it passes in. Writing into any of them would change what the
   * next call sees.
   */
  it("leaves what it is given untouched", () => {
    const intent: AuditIntent = { actorUserId: "stripe", detail: { stripe_customer: "cus_1" } };
    const previous = grant({ orgId: "org_old" });
    const next = grant({ orgId: "org_new" });

    grantAuditEntries(previous, next, intent, NOW);
    revokeAuditEntries(previous, intent, NOW);

    expect(intent).toEqual({ actorUserId: "stripe", detail: { stripe_customer: "cus_1" } });
    expect(previous).toEqual(grant({ orgId: "org_old" }));
    expect(next).toEqual(grant({ orgId: "org_new" }));
  });
});
