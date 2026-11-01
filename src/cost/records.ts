/**
 * What the room cost capture records (#473, design section 5), and the store it records into.
 *
 * Runtime-free on purpose: `CostDO` (src/cost-do.ts) imports `cloudflare:workers`, so no vitest test can reach
 * inside it. The row shapes, the table definitions and the one rule both stores apply (`isTooOld`) live here, and the
 * contract suite in tests/helpers/cost-store-contract.ts runs against `MemoryCostStore` and `CostDO` alike.
 *
 * Nothing here holds a grant key, a room name, a label or an email: ids, plans, sources and numbers only.
 */
import { monthKey } from "../stored-session.js";

/** A day as the capture writes it: `YYYY-MM-DD`, UTC. */
export const dayKey = (now: number): string => new Date(now).toISOString().slice(0, 10);

/** The month before `month` (`YYYY-MM`). */
export function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/**
 * Whether `month` is older than the month before `now`'s. Usage for such a month is never rewritten: Cloudflare keeps
 * 90 days, so a late run would replace complete totals with the shorter sums left in its window.
 */
export const isTooOld = (month: string, now: number): boolean => month < previousMonth(monthKey(now));

/** A room the capture has seen, kept after the room is purged so its usage up to the purge still maps to it. */
export type RoomRecord = {
  sessionId: string;
  createdBy: string;
  orgId: string | null;
  sessionObjectId: string;
  hostObjectId: string;
  firstSeenDay: string;
};

/** Per invocation type: Cloudflare's `requests` and `wallTime` sums. */
export type ByType = Record<string, { requests: number; wallTime: number }>;

/** One Durable Object's usage for a month, every raw field as Cloudflare reported it. */
export type UsageRecord = {
  month: string;
  objectId: string;
  kind: "session" | "host" | "unmatched";
  sessionId: string | null;
  namespaceId: string;
  /** Every `sum` field of `durableObjectsPeriodicGroups`, by Cloudflare's name. */
  periodic: Record<string, number>;
  byType: ByType;
  periodicSampleInterval: number | null;
  invocationsSampleInterval: number | null;
};

/** A namespace's totals for a month, in the same shape. */
export type TotalsRecord = Omit<UsageRecord, "objectId" | "kind" | "sessionId">;

export type PlanVia = "keyed" | "override" | "grant" | "default";

/** Who held which plan on one day, as captured: raw, classified only when the cost page is read. */
export type PlansDay = {
  day: string;
  honourPurchases: boolean;
  grantsCapped: boolean;
  creatorsCapped: boolean;
  creators: { userId: string; plan: string; via: PlanVia; grantSource: string | null; grantOrgId: string | null }[];
  /** `seats`, `source` and `active` are null for an org with no record. `plans` counts its grants per plan. */
  orgs: { orgId: string; seats: number | null; source: "purchase" | "operator" | null; active: boolean | null; plans: Record<string, number> }[];
  soloGrants: { plan: string; source: string; count: number }[];
};

export type BlobRow = { sessionId: string; bytes: number };

export type RunStatus = "written" | "capped" | "skipped_no_token" | "skipped_full_page" | "error";

export type RunRecord = {
  startedAt: number;
  finishedAt: number | null;
  plansStatus: RunStatus | null;
  blobsStatus: RunStatus | null;
  /** By month. */
  usageStatus: Record<string, RunStatus>;
  error: string | null;
  /** Rows written, by table. */
  counts: Record<string, number>;
};

/** Everything the read side needs for one month. */
export type MonthRecords = {
  month: string;
  rooms: RoomRecord[];
  usage: UsageRecord[];
  totals: TotalsRecord[];
  blobs: ({ day: string } & BlobRow)[];
  /** Every captured day of the month, in day order, after the previous month's last captured day when there is one. */
  plans: PlansDay[];
  lastRun: RunRecord | null;
};

/**
 * The capture's storage. Two implementations: `MemoryCostStore` (src/cost/memory.ts) for tests and the Node server,
 * `CostDO` (src/cost-do.ts) in production. A refusal is a returned value, not a throw, so it crosses RPC unchanged.
 */
export interface CostStore {
  /** Inserts the rooms not already recorded; a known room keeps its first record. */
  putRooms(rooms: RoomRecord[]): Promise<void>;
  knownRooms(): Promise<RoomRecord[]>;
  /** Replaces the month's usage and totals in one step, unless `isTooOld(month, now)`. */
  replaceUsage(month: string, usage: UsageRecord[], totals: TotalsRecord[], now: number):
    Promise<{ ok: true } | { ok: false; reason: "too_old" }>;
  /** Replaces the day's blob levels. */
  putBlobs(day: string, rows: BlobRow[]): Promise<void>;
  /** Replaces the day's plan records. */
  putPlans(plans: PlansDay): Promise<void>;
  /** Inserts or replaces the run with this `startedAt`. */
  putRun(run: RunRecord): Promise<void>;
  month(month: string): Promise<MonthRecords>;
  /** Months with usage recorded for the room, ascending. */
  roomMonths(sessionId: string): Promise<string[]>;
  /** Months with any usage recorded, ascending. */
  months(): Promise<string[]>;
}

/** `CostDO`'s tables (design section 5). JSON columns hold the record fields of the same name. */
export const COST_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS rooms (session_id TEXT PRIMARY KEY, created_by TEXT NOT NULL, org_id TEXT,
    session_object_id TEXT NOT NULL, host_object_id TEXT NOT NULL, first_seen_day TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS usage (month TEXT NOT NULL, object_id TEXT NOT NULL, kind TEXT NOT NULL, session_id TEXT,
    namespace_id TEXT NOT NULL, periodic TEXT NOT NULL, by_type TEXT NOT NULL,
    periodic_sample_interval REAL, invocations_sample_interval REAL, PRIMARY KEY (month, object_id))`,
  `CREATE INDEX IF NOT EXISTS usage_by_room ON usage (session_id, month)`,
  `CREATE TABLE IF NOT EXISTS totals (month TEXT NOT NULL, namespace_id TEXT NOT NULL, periodic TEXT NOT NULL,
    by_type TEXT NOT NULL, periodic_sample_interval REAL, invocations_sample_interval REAL,
    PRIMARY KEY (month, namespace_id))`,
  `CREATE TABLE IF NOT EXISTS blobs (day TEXT NOT NULL, session_id TEXT NOT NULL, bytes INTEGER NOT NULL,
    PRIMARY KEY (day, session_id))`,
  `CREATE TABLE IF NOT EXISTS creator_plans (day TEXT NOT NULL, user_id TEXT NOT NULL, plan TEXT NOT NULL,
    via TEXT NOT NULL, grant_source TEXT, grant_org_id TEXT, PRIMARY KEY (day, user_id))`,
  `CREATE TABLE IF NOT EXISTS org_days (day TEXT NOT NULL, org_id TEXT NOT NULL, seats INTEGER, source TEXT,
    active INTEGER, plans TEXT NOT NULL, PRIMARY KEY (day, org_id))`,
  `CREATE TABLE IF NOT EXISTS solo_grants (day TEXT NOT NULL, plan TEXT NOT NULL, source TEXT NOT NULL,
    count INTEGER NOT NULL, PRIMARY KEY (day, plan, source))`,
  `CREATE TABLE IF NOT EXISTS days (day TEXT PRIMARY KEY, honour_purchases INTEGER NOT NULL,
    grants_capped INTEGER NOT NULL, creators_capped INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS runs (started_at INTEGER PRIMARY KEY, finished_at INTEGER, plans_status TEXT,
    blobs_status TEXT, usage_status TEXT NOT NULL, error TEXT, counts TEXT NOT NULL)`,
];
