import { describe, expect, it } from "vitest";
import { capturePlans, MAX_COST_CREATORS } from "../src/cost/plans.js";
import { type RoomIndexRow } from "../src/storage/store.js";
import { MemoryStore } from "../src/storage/memory-store.js";
import { DEFAULT_POLICY, type Identity, type Org, type PlanGrant } from "../src/types.js";

const DAY = "2026-11-02";
const grant = (key: string, plan: PlanGrant["plan"], source: string, orgId: string | null = null): PlanGrant =>
  ({ key, plan, role: "member", orgId, source, grantedAt: 0, grantedBy: "test", expiresAt: null });
const org = (orgId: string, over: Partial<Org> = {}): Org => ({
  orgId, name: `name of ${orgId}`, ownerUserId: "u_github_1", seats: 5, source: "purchase", active: true, createdAt: 1,
  requireSso: false, domains: [], policy: DEFAULT_POLICY, ...over,
});
const room = (sessionId: string, createdBy: string, createdAt: number, orgId: string | null = null): RoomIndexRow =>
  ({ sessionId, createdAt, createdBy, orgId, preset: null, mode: "collab" as RoomIndexRow["mode"], public: false, hosted: false });

/** A store whose room index is the given rows, everything else a real MemoryStore. */
function setup(index: RoomIndexRow[], overrides: Record<string, Identity> = {}) {
  const store = new MemoryStore();
  const calls = { pages: 0 };
  const deps = {
    store: {
      listRoomsPage: async (limit: number, after?: Pick<RoomIndexRow, "createdAt" | "sessionId">) => {
        calls.pages++;
        const sorted = [...index].sort((a, b) => b.createdAt - a.createdAt);
        const from = after ? sorted.findIndex((r) => r.sessionId === after.sessionId) + 1 : 0;
        return sorted.slice(from, from + limit);
      },
      listGrants: store.listGrants.bind(store),
      getOrg: store.getOrg.bind(store),
    },
    planDeps: { plans: store, overrides },
    honourPurchases: true,
    sessionIdOf: (id: string) => `so_${id}`,
    hostIdOf: (id: string) => `ho_${id}`,
  };
  return { store, deps, calls };
}

describe("capturePlans", () => {
  it("records each creator once, raw, with the rooms and their object ids", async () => {
    const { store, deps } = setup([room("qs_a", "u_github_1", 3), room("qs_b", "u_github_1", 2), room("qs_c", "u_github_2", 1, "org_t")]);
    const by = { actorUserId: "u_op" };
    await store.createOrg(org("org_t", { active: false }), grant("github:2", "team", "purchase", "org_t"), by);
    await store.putGrant(grant("github:1", "pro", "purchase"));

    const { plans, rooms } = await capturePlans(DAY, deps);
    expect(plans.creators).toEqual([
      { userId: "u_github_1", plan: "pro", via: "grant", grantSource: "purchase", grantOrgId: null },
      { userId: "u_github_2", plan: "team", via: "grant", grantSource: "purchase", grantOrgId: "org_t" },
    ]);
    expect(rooms).toEqual([
      { sessionId: "qs_a", createdBy: "u_github_1", orgId: null, sessionObjectId: "so_qs_a", hostObjectId: "ho_qs_a", firstSeenDay: DAY },
      { sessionId: "qs_b", createdBy: "u_github_1", orgId: null, sessionObjectId: "so_qs_b", hostObjectId: "ho_qs_b", firstSeenDay: DAY },
      { sessionId: "qs_c", createdBy: "u_github_2", orgId: "org_t", sessionObjectId: "so_qs_c", hostObjectId: "ho_qs_c", firstSeenDay: DAY },
    ]);
    expect(plans).toMatchObject({ day: DAY, honourPurchases: true, grantsCapped: false, creatorsCapped: false });
  });

  it("records each org's seats, source, standing and grant counts, with nulls for an org with no record", async () => {
    const { store, deps } = setup([room("qs_x", "u_github_9", 1, "org_ghost")]);
    const by = { actorUserId: "u_op" };
    await store.createOrg(org("org_t", { seats: 4 }), grant("github:1", "team", "purchase", "org_t"), by);
    await store.putGrantIfOwned(grant("github:3", "team", "invite", "org_t"), "org_t", by);

    const { plans } = await capturePlans(DAY, deps);
    expect(plans.orgs).toEqual([
      { orgId: "org_ghost", seats: null, source: null, active: null, plans: {} },
      { orgId: "org_t", seats: 4, source: "purchase", active: true, plans: { team: 2 } },
    ]);
  });

  it("counts individual grants by plan and source, leaving out keys an override shadows", async () => {
    const overrides: Record<string, Identity> = { "github:7": { userId: "u_x", orgId: null, plan: "pro", role: "member", label: "x" } };
    const { store, deps } = setup([], overrides);
    await store.putGrant(grant("github:5", "pro", "purchase"));
    await store.putGrant(grant("github:6", "pro", "purchase"));
    await store.putGrant(grant("github:7", "max", "purchase"));
    await store.putGrant(grant("github:8", "max", "operator"));

    const { plans } = await capturePlans(DAY, deps);
    expect(plans.soloGrants).toEqual([
      { plan: "max", source: "operator", count: 1 },
      { plan: "pro", source: "purchase", count: 2 },
    ]);
  });

  it("pages the room index to its end and stops resolving creators at the cap", async () => {
    const index = Array.from({ length: 1100 }, (_, i) => room(`qs_${i}`, `u_github_${i}`, i));
    const { deps, calls } = setup(index);
    const { plans, rooms } = await capturePlans(DAY, deps);
    expect(calls.pages).toBe(3);
    expect(rooms).toHaveLength(1100);
    expect(plans.creators).toHaveLength(MAX_COST_CREATORS);
    expect(plans.creatorsCapped).toBe(true);
  });

  it("holds no grant key, room name, label or email", async () => {
    const { store, deps } = setup([room("qs_a", "u_github_1", 1, "org_t")]);
    await store.createOrg(org("org_t"), grant("github:1", "team", "purchase", "org_t"), { actorUserId: "u_op" });
    await store.putGrant(grant("google:44", "pro", "purchase"));
    const text = JSON.stringify(await capturePlans(DAY, deps));
    expect(text).not.toMatch(/github:|google:|name of/);
  });
});
