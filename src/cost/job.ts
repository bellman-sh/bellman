/**
 * The daily room cost capture (#473): one run, from the Worker's `scheduled` handler. It records raw facts only;
 * pricing and classification happen when the cost page is read. It never calls a room.
 *
 * Each half stands alone: a failure is recorded in that half's status and the others still run, so a registry
 * outage does not cost a day of blob levels, and R2 trouble does not cost a day of plans.
 */
import type { BlobStore } from "../blobs.js";
import { monthKey } from "../storage/stored-session.js";
import { GRAPHQL_URL, parseUsage, usageQuery } from "./graphql.js";
import { capturePlans, type CapturePlansDeps } from "./plans.js";
import { mapUsage } from "./usage.js";
import { dayKey, previousMonth, type CostStore, type RunRecord } from "./records.js";

export type CostJobDeps = CapturePlansDeps & {
  costs: CostStore;
  blobs: Pick<BlobStore, "bytesByRoom">;
  /** Unset without both CF_ANALYTICS_TOKEN and CF_ACCOUNT_ID: the run records `skipped_no_token` for usage. */
  cloudflare?: { accountId: string; token: string; fetch: typeof fetch };
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

  // After the plans half, so rooms first seen today map too. Each month stands alone.
  const cf = deps.cloudflare;
  const rooms = cf ? await deps.costs.knownRooms().catch((err: unknown) => (errors.push(`usage: ${message(err)}`), null)) : null;
  for (const month of [previousMonth(monthKey(now)), monthKey(now)]) {
    if (!cf) {
      run.usageStatus[month] = "skipped_no_token";
      continue;
    }
    if (!rooms) {
      run.usageStatus[month] = "error";
      continue;
    }
    try {
      const response = await cf.fetch(GRAPHQL_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${cf.token}`, "content-type": "application/json" },
        body: JSON.stringify(usageQuery(cf.accountId, month)),
      });
      if (!response.ok) throw new Error(`Cloudflare answered ${response.status}`);
      const answer = parseUsage(await response.json());
      if ("error" in answer) throw new Error(answer.error);
      if ("fullPage" in answer) {
        run.usageStatus[month] = "skipped_full_page";
        continue;
      }
      const { usage, totals } = mapUsage(month, answer, rooms);
      const stored = await deps.costs.replaceUsage(month, usage, totals, now);
      run.usageStatus[month] = stored.ok ? "written" : "error";
      if (!stored.ok) errors.push(`usage ${month}: ${stored.reason}`);
      run.counts[`usage_${month}`] = usage.length;
    } catch (err) {
      run.usageStatus[month] = "error";
      errors.push(`usage ${month}: ${message(err)}`);
    }
  }

  run.finishedAt = Date.now();
  run.error = errors.length > 0 ? errors.join("; ") : null;
  await deps.costs.putRun(run);
  const usage = Object.entries(run.usageStatus).map(([m, s]) => `${m}:${s}`).join(",");
  console.log(`cost job: plans=${run.plansStatus} blobs=${run.blobsStatus} usage=${usage} counts=${JSON.stringify(run.counts)}`);
  return run;
}
