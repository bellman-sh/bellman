/**
 * The daily room cost capture (#473): one run, from the Worker's `scheduled` handler. It records raw facts only;
 * pricing and classification happen when the cost page is read. It never calls a room.
 *
 * Each half stands alone: a failure is recorded in that half's status and the others still run, so a registry
 * outage does not cost a day of blob levels, and R2 trouble does not cost a day of plans.
 */
import type { BlobStore } from "../blobs.js";
import { monthKey } from "../stored-session.js";
import { capturePlans, type CapturePlansDeps } from "./plans.js";
import { dayKey, previousMonth, type CostStore, type RunRecord } from "./records.js";

export type CostJobDeps = CapturePlansDeps & {
  costs: CostStore;
  blobs: Pick<BlobStore, "bytesByRoom">;
};

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function runCostJob(deps: CostJobDeps, now: number): Promise<RunRecord> {
  const day = dayKey(now);
  const run: RunRecord = {
    startedAt: now, finishedAt: null, plansStatus: null, blobsStatus: null, usageStatus: {}, error: null, counts: {},
  };
  const errors: string[] = [];
  await deps.costs.putRun(run);

  try {
    const { plans, rooms } = await capturePlans(day, deps);
    await deps.costs.putPlans(plans);
    await deps.costs.putRooms(rooms);
    run.plansStatus = plans.creatorsCapped || plans.grantsCapped ? "capped" : "written";
    run.counts.creator_plans = plans.creators.length;
    run.counts.rooms = rooms.length;
  } catch (err) {
    run.plansStatus = "error";
    errors.push(`plans: ${message(err)}`);
  }

  try {
    const bytes = await deps.blobs.bytesByRoom();
    await deps.costs.putBlobs(day, [...bytes].map(([sessionId, b]) => ({ sessionId, bytes: b })));
    run.blobsStatus = "written";
    run.counts.blobs = bytes.size;
  } catch (err) {
    run.blobsStatus = "error";
    errors.push(`blobs: ${message(err)}`);
  }

  // Usage from Cloudflare is step 2b (design section 2). Until it lands, every run says so for both months.
  for (const month of [previousMonth(monthKey(now)), monthKey(now)]) run.usageStatus[month] = "skipped_no_token";

  run.finishedAt = Date.now();
  run.error = errors.length > 0 ? errors.join("; ") : null;
  await deps.costs.putRun(run);
  const usage = Object.entries(run.usageStatus).map(([m, s]) => `${m}:${s}`).join(",");
  console.log(`cost job: plans=${run.plansStatus} blobs=${run.blobsStatus} usage=${usage} counts=${JSON.stringify(run.counts)}`);
  return run;
}
