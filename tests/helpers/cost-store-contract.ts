/**
 * Conformance suite for the CostStore seam (#473). `MemoryCostStore` runs it under the root program
 * (tests/cost-store.test.ts) and `CostDO` inside workerd (worker-tests/cost-do.test.ts). `makeStore` must hand
 * every case a store of its own: the Durable Object run names a fresh object per case.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { CostStore, PlansDay, RoomRecord, RunRecord, TotalsRecord, UsageRecord } from "../../src/cost/records.js";

const NOW = Date.UTC(2026, 10, 15, 3, 17); // 2026-11-15

const room = (sessionId: string, over: Partial<RoomRecord> = {}): RoomRecord => ({
  sessionId, createdBy: "u_github_1", orgId: null, sessionObjectId: `so_${sessionId}`, hostObjectId: `ho_${sessionId}`,
  firstSeenDay: "2026-11-01", ...over,
});

const usage = (month: string, objectId: string, over: Partial<UsageRecord> = {}): UsageRecord => ({
  month, objectId, kind: "session", sessionId: "qs_a", namespaceId: "ns_session",
  periodic: { duration: 12.5, rowsRead: 40, rowsWritten: 7 }, byType: { rpc: { requests: 9, wallTime: 1200 } },
  periodicSampleInterval: 1, invocationsSampleInterval: null, ...over,
});

const totals = (month: string, over: Partial<TotalsRecord> = {}): TotalsRecord => ({
  month, namespaceId: "ns_session", periodic: { duration: 30 }, byType: { rpc: { requests: 20, wallTime: 3000 } },
  periodicSampleInterval: 1, invocationsSampleInterval: 1, ...over,
});

const plans = (day: string, over: Partial<PlansDay> = {}): PlansDay => ({
  day, honourPurchases: true, grantsCapped: false, creatorsCapped: false,
  creators: [{ userId: "u_github_1", plan: "pro", via: "grant", grantSource: "purchase", grantOrgId: null }],
  orgs: [{ orgId: "org_a", seats: 3, source: "purchase", active: true, plans: { team: 3 } }],
  soloGrants: [{ plan: "pro", source: "purchase", count: 1 }],
  ...over,
});

const run = (startedAt: number, over: Partial<RunRecord> = {}): RunRecord => ({
  startedAt, finishedAt: startedAt + 1000, plansStatus: "written", blobsStatus: "written",
  usageStatus: { "2026-11": "skipped_no_token" }, error: null, counts: { creator_plans: 1 }, ...over,
});

export function describeCostStoreContract(name: string, makeStore: () => CostStore): void {
  describe(`CostStore contract: ${name}`, () => {
    let store: CostStore;
    beforeEach(() => {
      store = makeStore();
    });

    it("answers an empty month for a store with nothing in it", async () => {
      expect(await store.month("2026-11")).toEqual({
        month: "2026-11", rooms: [], usage: [], totals: [], blobs: [], plans: [], lastRun: null,
      });
      expect(await store.months()).toEqual([]);
      expect(await store.knownRooms()).toEqual([]);
    });

    it("keeps a room's first record when it is put again", async () => {
      await store.putRooms([room("qs_a"), room("qs_b", { orgId: "org_a" })]);
      await store.putRooms([room("qs_a", { createdBy: "u_github_2", firstSeenDay: "2026-11-09" })]);
      const known = await store.knownRooms();
      expect(known.sort((x, y) => x.sessionId.localeCompare(y.sessionId))).toEqual([room("qs_a"), room("qs_b", { orgId: "org_a" })]);
    });

    it("replaces a month's usage and totals whole, and a second replace leaves the same rows", async () => {
      expect(await store.replaceUsage("2026-11", [usage("2026-11", "o1"), usage("2026-11", "o2", { kind: "unmatched", sessionId: null })], [totals("2026-11")], NOW))
        .toEqual({ ok: true });
      await store.replaceUsage("2026-11", [usage("2026-11", "o1")], [totals("2026-11")], NOW);
      await store.replaceUsage("2026-11", [usage("2026-11", "o1")], [totals("2026-11")], NOW);
      const got = await store.month("2026-11");
      expect(got.usage).toEqual([usage("2026-11", "o1")]);
      expect(got.totals).toEqual([totals("2026-11")]);
    });

    it("keeps months apart and lists the months with usage", async () => {
      await store.replaceUsage("2026-10", [usage("2026-10", "o1")], [], NOW);
      await store.replaceUsage("2026-11", [usage("2026-11", "o1", { sessionId: "qs_b" })], [], NOW);
      expect((await store.month("2026-10")).usage).toEqual([usage("2026-10", "o1")]);
      expect(await store.months()).toEqual(["2026-10", "2026-11"]);
      expect(await store.roomMonths("qs_a")).toEqual(["2026-10"]);
      expect(await store.roomMonths("qs_b")).toEqual(["2026-11"]);
    });

    it("refuses usage for a month older than the previous one", async () => {
      expect(await store.replaceUsage("2026-09", [usage("2026-09", "o1")], [], NOW)).toEqual({ ok: false, reason: "too_old" });
      expect(await store.months()).toEqual([]);
    });

    it("replaces a day's plans and blobs rather than adding to them", async () => {
      await store.putPlans(plans("2026-11-02"));
      await store.putPlans(plans("2026-11-02", {
        creators: [{ userId: "u_github_9", plan: "free", via: "default", grantSource: null, grantOrgId: null }],
        orgs: [], soloGrants: [], honourPurchases: false,
      }));
      await store.putBlobs("2026-11-02", [{ sessionId: "qs_a", bytes: 10 }, { sessionId: "qs_b", bytes: 5 }]);
      await store.putBlobs("2026-11-02", [{ sessionId: "qs_a", bytes: 12 }]);
      const got = await store.month("2026-11");
      expect(got.plans).toEqual([plans("2026-11-02", {
        creators: [{ userId: "u_github_9", plan: "free", via: "default", grantSource: null, grantOrgId: null }],
        orgs: [], soloGrants: [], honourPurchases: false,
      })]);
      expect(got.blobs).toEqual([{ day: "2026-11-02", sessionId: "qs_a", bytes: 12 }]);
    });

    it("hands a month its days in order, after the previous month's last captured day", async () => {
      await store.putPlans(plans("2026-10-30"));
      await store.putPlans(plans("2026-10-31", { orgs: [{ orgId: "org_x", seats: null, source: null, active: null, plans: {} }] }));
      await store.putPlans(plans("2026-11-03"));
      await store.putPlans(plans("2026-11-01"));
      await store.putPlans(plans("2026-12-01"));
      await store.putBlobs("2026-10-31", [{ sessionId: "qs_a", bytes: 1 }]);
      const got = await store.month("2026-11");
      expect(got.plans.map((p) => p.day)).toEqual(["2026-10-31", "2026-11-01", "2026-11-03"]);
      expect(got.plans[0].orgs).toEqual([{ orgId: "org_x", seats: null, source: null, active: null, plans: {} }]);
      expect(got.blobs).toEqual([]);
    });

    it("answers the latest run, and a run put again replaces itself", async () => {
      await store.putRun(run(1000, { finishedAt: null, plansStatus: null }));
      await store.putRun(run(1000));
      await store.putRun(run(500, { error: "older" }));
      expect((await store.month("2026-11")).lastRun).toEqual(run(1000));
    });

    it("hands every known room with any month", async () => {
      await store.putRooms([room("qs_a")]);
      expect((await store.month("2026-01")).rooms).toEqual([room("qs_a")]);
    });
  });
}
