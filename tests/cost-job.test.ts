import { afterEach, describe, expect, it, vi } from "vitest";
import { runCostJob, type CostJobDeps } from "../src/cost/job.js";
import { MemoryCostStore } from "../src/cost/memory.js";
import { MemoryStore, type RoomIndexRow } from "../src/store.js";

const NOW = Date.UTC(2026, 10, 2, 3, 17);
const room: RoomIndexRow = { sessionId: "qs_a", createdAt: 1, createdBy: "u_github_1", orgId: null, preset: null, mode: "collab" as RoomIndexRow["mode"], public: false, hosted: false };

function deps(over: Partial<CostJobDeps> = {}): CostJobDeps & { costs: MemoryCostStore } {
  const store = new MemoryStore();
  return {
    store: { listRoomsPage: async () => [room], listGrants: store.listGrants.bind(store), getOrg: store.getOrg.bind(store) },
    planDeps: { plans: store },
    honourPurchases: true,
    sessionIdOf: (id) => `so_${id}`,
    hostIdOf: (id) => `ho_${id}`,
    costs: new MemoryCostStore(),
    blobs: { bytesByRoom: async () => new Map([["qs_a", 42]]) },
    ...over,
  } as CostJobDeps & { costs: MemoryCostStore };
}

afterEach(() => vi.restoreAllMocks());

describe("runCostJob", () => {
  it("records plans, rooms and blobs, and marks usage skipped with no Cloudflare credentials", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const d = deps();
    const run = await runCostJob(d, NOW);

    expect(run).toMatchObject({
      startedAt: NOW, plansStatus: "written", blobsStatus: "written",
      usageStatus: { "2026-10": "skipped_no_token", "2026-11": "skipped_no_token" }, error: null,
      counts: { creator_plans: 1, rooms: 1, blobs: 1 },
    });
    expect(run.finishedAt).toEqual(expect.any(Number));
    const month = await d.costs.month("2026-11");
    expect(month.plans.map((p) => p.day)).toEqual(["2026-11-02"]);
    expect(month.rooms.map((r) => r.sessionId)).toEqual(["qs_a"]);
    expect(month.blobs).toEqual([{ day: "2026-11-02", sessionId: "qs_a", bytes: 42 }]);
    expect(month.lastRun).toEqual(run);
    expect(log).toHaveBeenCalledWith(
      'cost job: plans=written blobs=written usage=2026-10:skipped_no_token,2026-11:skipped_no_token counts={"creator_plans":1,"rooms":1,"blobs":1}',
    );
  });

  it("captures both months of usage from Cloudflare, mapped through the rooms CostDO knows", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const asked: { month: string; auth: string | null }[] = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { variables: { from: string } };
      asked.push({ month: body.variables.from.slice(0, 7), auth: new Headers(init.headers).get("authorization") });
      return Response.json({ data: { viewer: { accounts: [{
        periodic: [{ dimensions: { objectId: "so_qs_a", namespaceId: "ns_s" }, sum: { duration: 3 }, avg: { sampleInterval: 1 } }],
        invocations: [], periodicTotals: [], invocationTotals: [],
      }] } } });
    }) as unknown as typeof globalThis.fetch;
    const d = deps({ cloudflare: { accountId: "acct", token: "tok", fetch } });
    const run = await runCostJob(d, NOW);

    expect(asked).toEqual([{ month: "2026-10", auth: "Bearer tok" }, { month: "2026-11", auth: "Bearer tok" }]);
    expect(run.usageStatus).toEqual({ "2026-10": "written", "2026-11": "written" });
    expect((await d.costs.month("2026-10")).usage).toEqual([expect.objectContaining({ objectId: "so_qs_a", kind: "session", sessionId: "qs_a" })]);
  });

  it("records one month's error or full page without stopping the other", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fetch = (async (_url: string, init: RequestInit) => {
      const month = (JSON.parse(init.body as string) as { variables: { from: string } }).variables.from.slice(0, 7);
      if (month === "2026-10") return Response.json({ data: null, errors: [{ message: "field renamed" }] });
      const periodic = Array.from({ length: 10_000 }, (_, i) => ({ dimensions: { objectId: `o${i}`, namespaceId: "n" }, sum: {}, avg: {} }));
      return Response.json({ data: { viewer: { accounts: [{ periodic, invocations: [], periodicTotals: [], invocationTotals: [] }] } } });
    }) as unknown as typeof globalThis.fetch;
    const d = deps({ cloudflare: { accountId: "acct", token: "tok", fetch } });
    const run = await runCostJob(d, NOW);
    expect(run.usageStatus).toEqual({ "2026-10": "error", "2026-11": "skipped_full_page" });
    expect(run.error).toBe("usage 2026-10: field renamed");
    expect(await d.costs.months()).toEqual([]);

    const down = deps({ cloudflare: { accountId: "acct", token: "tok", fetch: (async () => new Response("bad gateway", { status: 502 })) as unknown as typeof globalThis.fetch } });
    const r = await runCostJob(down, NOW);
    expect(r.usageStatus).toEqual({ "2026-10": "error", "2026-11": "error" });
    expect(r.plansStatus).toBe("written");
  });

  it("writes blobs when the plans half fails, and plans when the blobs half fails", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const broken = deps({ store: { listRoomsPage: async () => { throw new Error("registry down"); }, listGrants: async () => [], getOrg: async () => undefined } });
    const a = await runCostJob(broken, NOW);
    expect(a).toMatchObject({ plansStatus: "error", blobsStatus: "written", error: "plans: registry down" });
    expect((await broken.costs.month("2026-11")).blobs).toHaveLength(1);

    const noBlobs = deps({ blobs: { bytesByRoom: async () => { throw new Error("R2 down"); } } });
    const b = await runCostJob(noBlobs, NOW);
    expect(b).toMatchObject({ plansStatus: "written", blobsStatus: "error", error: "blobs: R2 down" });
    expect((await noBlobs.costs.month("2026-11")).plans).toHaveLength(1);
  });
});
