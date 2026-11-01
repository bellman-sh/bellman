/**
 * The cost capture through the Worker's `scheduled` export (#473), over the real objects: the registry's room index,
 * the key table, R2 and `CostDO`.
 *
 * It also guards how the job reaches rooms. It must read them through `listRoomsPage` only, never by listing `rm:`
 * keys: the operator rooms design (dash, its PR 2) moves the index into a SQLite `rooms` table behind the same
 * method, and a direct `rm:` list would then find nothing and every object would go unmatched without an error. This
 * test passes whichever of the two merges second.
 */
import { afterEach, describe, expect, it } from "vitest";
import { env, reset, abortAllDurableObjects, createScheduledController } from "cloudflare:test";
import worker from "../src/worker.js";
import { DurableObjectStore } from "../src/store-do.js";
import { costStore } from "../src/cost-do.js";
import { R2BlobStore } from "../src/blobs-r2.js";
import { member, session } from "../tests/helpers/fixtures.js";

type WorkerEnv = Parameters<typeof worker.fetch>[1];

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

describe("the cost capture's scheduled run", () => {
  it("records the room with its object ids, its creator's plan from the key table, and its blob bytes", async () => {
    const on = env as unknown as WorkerEnv;
    const store = new DurableObjectStore(on);
    const s = session({ id: "qs_costed", members: [member()] });
    await store.createSession(s);
    const body = new TextEncoder().encode("12345").buffer as ArrayBuffer;
    await new R2BlobStore(on.BLOBS).put(s.id, "ab".repeat(16), body, { bytes: 5, type: "text/plain", name: "a.txt", by: "m_creator", at: 1 });

    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: "17 3 * * *" }), on, ctx);
    await Promise.all(waits);

    const costs = costStore(on.COST);
    const month = await costs.month(new Date().toISOString().slice(0, 7));
    expect(month.rooms).toEqual([expect.objectContaining({
      sessionId: s.id, createdBy: "u_jesse",
      sessionObjectId: on.SESSION.idFromName(s.id).toString(), hostObjectId: on.HOST.idFromName(s.id).toString(),
    })]);
    expect(month.plans.at(-1)?.creators).toEqual([{ userId: "u_jesse", plan: "team", via: "keyed", grantSource: null, grantOrgId: null }]);
    expect(month.blobs).toEqual([expect.objectContaining({ sessionId: s.id, bytes: 5 })]);
    expect(month.lastRun).toMatchObject({ plansStatus: "written", blobsStatus: "written", error: null });
  });
});
