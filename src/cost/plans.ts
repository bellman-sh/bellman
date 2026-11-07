/**
 * The plans half of the daily cost capture (#473, design section 1): who held which plan today, raw, and every room
 * in the index with its object ids. Runtime-free: the object ids come from functions the Worker hands in.
 */
import { MAX_GRANTS_COUNTED } from "../http/stats.js";
import { planOf, type PlanOfDeps } from "../oauth/routes.js";
import type { BellmanStore, RoomIndexRow } from "../storage/store.js";
import type { PlansDay, RoomRecord } from "./records.js";

/** `listRoomsPage`'s window. A short page is the index's end. */
export const ROOM_INDEX_PAGE = 500;

// ponytail: 150 creators a run. Each costs up to four registry calls inside one scheduled invocation's 1,000
// subrequests, beside the index pages, the org reads, the R2 listing, the GraphQL fetches and CostDO. Past it the
// day's record says `creatorsCapped` and the rest are unrecorded; the upgrade is a cursor that resumes them in a
// second invocation.
export const MAX_COST_CREATORS = 150;

export type CapturePlansDeps = {
  /** The job reaches rooms only through `listRoomsPage`, never `rm:` keys: the operator rooms design moves the index. */
  store: Pick<BellmanStore, "listRoomsPage" | "listGrants" | "getOrg">;
  planDeps: PlanOfDeps;
  honourPurchases: boolean;
  sessionIdOf: (sessionId: string) => string;
  hostIdOf: (sessionId: string) => string;
};

async function roomIndex(store: CapturePlansDeps["store"]): Promise<RoomIndexRow[]> {
  const rows: RoomIndexRow[] = [];
  for (;;) {
    const last = rows.at(-1);
    const page = await store.listRoomsPage(ROOM_INDEX_PAGE, last && { createdAt: last.createdAt, sessionId: last.sessionId });
    rows.push(...page);
    if (page.length < ROOM_INDEX_PAGE) return rows;
  }
}

export async function capturePlans(day: string, deps: CapturePlansDeps): Promise<{ plans: PlansDay; rooms: RoomRecord[] }> {
  const index = await roomIndex(deps.store);
  const rooms = index.map((r): RoomRecord => ({
    sessionId: r.sessionId, createdBy: r.createdBy, orgId: r.orgId,
    sessionObjectId: deps.sessionIdOf(r.sessionId), hostObjectId: deps.hostIdOf(r.sessionId), firstSeenDay: day,
  }));

  const creatorIds = [...new Set(index.map((r) => r.createdBy))];
  const creators: PlansDay["creators"] = [];
  for (const userId of creatorIds.slice(0, MAX_COST_CREATORS)) {
    const found = await planOf(userId, deps.planDeps, { raw: true });
    creators.push({ userId, plan: found.plan, via: found.via, grantSource: found.grantSource, grantOrgId: found.grantOrgId });
  }

  const grants = await deps.store.listGrants(MAX_GRANTS_COUNTED);
  const orgIds = [...new Set([...grants.map((g) => g.orgId), ...index.map((r) => r.orgId)])]
    .filter((id): id is string => id !== null).sort();
  const orgs: PlansDay["orgs"] = [];
  for (const orgId of orgIds) {
    const record = await deps.store.getOrg(orgId);
    const plans: Record<string, number> = {};
    for (const g of grants) if (g.orgId === orgId) plans[g.plan] = (plans[g.plan] ?? 0) + 1;
    orgs.push({ orgId, seats: record?.seats ?? null, source: record?.source ?? null, active: record?.active ?? null, plans });
  }

  // An override outranks a grant on the same key, as at sign-in and in `statsRoutes`: that key is comped, so its
  // grant counts for nothing.
  const solo = new Map<string, { plan: string; source: string; count: number }>();
  for (const g of grants) {
    if (g.orgId !== null || deps.planDeps.overrides?.[g.key]) continue;
    const id = `${g.plan}|${g.source}`;
    const entry = solo.get(id) ?? { plan: g.plan, source: g.source, count: 0 };
    entry.count++;
    solo.set(id, entry);
  }

  return {
    plans: {
      day,
      honourPurchases: deps.honourPurchases,
      grantsCapped: grants.length >= MAX_GRANTS_COUNTED,
      creatorsCapped: creatorIds.length > MAX_COST_CREATORS,
      creators,
      orgs,
      soloGrants: [...solo.values()].sort((a, b) => a.plan.localeCompare(b.plan) || a.source.localeCompare(b.source)),
    },
    rooms,
  };
}
