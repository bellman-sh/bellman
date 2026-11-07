/**
 * `CostDO`: the room cost capture's one object (#473, design section 5), `idFromName("cost")`. SQLite tables, written
 * by the daily scheduled job and read by the operator cost routes, so none of it lands on `RegistryDO`, which serves
 * joins and sign-ins. The shapes, the schema and the age rule are in src/cost/records.ts, runtime-free, so the
 * contract suite can hold this and `MemoryCostStore` to the same behaviour.
 *
 * Workers-only: it imports `cloudflare:workers`, so it stays out of the Node build (tsconfig.json and
 * tsconfig.test.json exclude it).
 */
import { DurableObject } from "cloudflare:workers";
import { reviving } from "../rpc-error.js";
import {
  COST_SCHEMA, isTooOld, previousMonth,
  type BlobRow, type CostStore, type MonthRecords, type PlansDay, type RoomRecord, type RunRecord, type TotalsRecord, type UsageRecord,
} from "../cost/records.js";

type Row = Record<string, SqlStorageValue>;

const json = (v: unknown): string => JSON.stringify(v);
const parse = <T>(v: SqlStorageValue): T => JSON.parse(v as string) as T;
const nullable = <T extends SqlStorageValue>(v: SqlStorageValue): T | null => (v === null ? null : (v as T));

const roomOf = (r: Row): RoomRecord => ({
  sessionId: r.session_id as string, createdBy: r.created_by as string, orgId: nullable<string>(r.org_id),
  sessionObjectId: r.session_object_id as string, hostObjectId: r.host_object_id as string, firstSeenDay: r.first_seen_day as string,
});

const usageOf = (r: Row): UsageRecord => ({
  month: r.month as string, objectId: r.object_id as string, kind: r.kind as UsageRecord["kind"],
  sessionId: nullable<string>(r.session_id), namespaceId: r.namespace_id as string,
  periodic: parse(r.periodic), byType: parse(r.by_type),
  periodicSampleInterval: nullable<number>(r.periodic_sample_interval),
  invocationsSampleInterval: nullable<number>(r.invocations_sample_interval),
});

const totalsOf = (r: Row): TotalsRecord => {
  const { objectId: _o, kind: _k, sessionId: _s, ...rest } = usageOf({ ...r, object_id: "", kind: "", session_id: null });
  return rest;
};

const runOf = (r: Row): RunRecord => ({
  startedAt: r.started_at as number, finishedAt: nullable<number>(r.finished_at),
  plansStatus: nullable(r.plans_status) as RunRecord["plansStatus"], blobsStatus: nullable(r.blobs_status) as RunRecord["blobsStatus"],
  usageStatus: parse(r.usage_status), error: nullable<string>(r.error), counts: parse(r.counts),
});

export class CostDO extends DurableObject implements CostStore {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    void this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.transactionSync(() => {
        for (const statement of COST_SCHEMA) this.ctx.storage.sql.exec(statement);
      });
    });
  }

  private get sql() {
    return this.ctx.storage.sql;
  }

  async putRooms(rooms: RoomRecord[]): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      for (const r of rooms) {
        this.sql.exec(
          `INSERT OR IGNORE INTO rooms (session_id, created_by, org_id, session_object_id, host_object_id, first_seen_day)
           VALUES (?, ?, ?, ?, ?, ?)`,
          r.sessionId, r.createdBy, r.orgId, r.sessionObjectId, r.hostObjectId, r.firstSeenDay,
        );
      }
    });
  }

  async knownRooms(): Promise<RoomRecord[]> {
    return this.sql.exec<Row>("SELECT * FROM rooms ORDER BY session_id").toArray().map(roomOf);
  }

  async replaceUsage(month: string, usage: UsageRecord[], totals: TotalsRecord[], now: number) {
    if (isTooOld(month, now)) return { ok: false as const, reason: "too_old" as const };
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM usage WHERE month = ?", month);
      this.sql.exec("DELETE FROM totals WHERE month = ?", month);
      for (const u of usage) {
        this.sql.exec(
          `INSERT INTO usage (month, object_id, kind, session_id, namespace_id, periodic, by_type,
             periodic_sample_interval, invocations_sample_interval) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          month, u.objectId, u.kind, u.sessionId, u.namespaceId, json(u.periodic), json(u.byType),
          u.periodicSampleInterval, u.invocationsSampleInterval,
        );
      }
      for (const t of totals) {
        this.sql.exec(
          `INSERT INTO totals (month, namespace_id, periodic, by_type, periodic_sample_interval, invocations_sample_interval)
           VALUES (?, ?, ?, ?, ?, ?)`,
          month, t.namespaceId, json(t.periodic), json(t.byType), t.periodicSampleInterval, t.invocationsSampleInterval,
        );
      }
    });
    return { ok: true as const };
  }

  async putBlobs(day: string, rows: BlobRow[]): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM blobs WHERE day = ?", day);
      for (const r of rows) this.sql.exec("INSERT INTO blobs (day, session_id, bytes) VALUES (?, ?, ?)", day, r.sessionId, r.bytes);
    });
  }

  async putPlans(p: PlansDay): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      for (const table of ["creator_plans", "org_days", "solo_grants", "days"]) this.sql.exec(`DELETE FROM ${table} WHERE day = ?`, p.day);
      this.sql.exec(
        "INSERT INTO days (day, honour_purchases, grants_capped, creators_capped) VALUES (?, ?, ?, ?)",
        p.day, Number(p.honourPurchases), Number(p.grantsCapped), Number(p.creatorsCapped),
      );
      for (const c of p.creators) {
        this.sql.exec(
          "INSERT INTO creator_plans (day, user_id, plan, via, grant_source, grant_org_id) VALUES (?, ?, ?, ?, ?, ?)",
          p.day, c.userId, c.plan, c.via, c.grantSource, c.grantOrgId,
        );
      }
      for (const o of p.orgs) {
        this.sql.exec(
          "INSERT INTO org_days (day, org_id, seats, source, active, plans) VALUES (?, ?, ?, ?, ?, ?)",
          p.day, o.orgId, o.seats, o.source, o.active === null ? null : Number(o.active), json(o.plans),
        );
      }
      for (const g of p.soloGrants) {
        this.sql.exec("INSERT INTO solo_grants (day, plan, source, count) VALUES (?, ?, ?, ?)", p.day, g.plan, g.source, g.count);
      }
    });
  }

  async putRun(r: RunRecord): Promise<void> {
    this.sql.exec(
      `INSERT OR REPLACE INTO runs (started_at, finished_at, plans_status, blobs_status, usage_status, error, counts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      r.startedAt, r.finishedAt, r.plansStatus, r.blobsStatus, json(r.usageStatus), r.error, json(r.counts),
    );
  }

  #plansDay(day: string): PlansDay {
    const d = this.sql.exec<Row>("SELECT * FROM days WHERE day = ?", day).one();
    return {
      day,
      honourPurchases: d.honour_purchases === 1, grantsCapped: d.grants_capped === 1, creatorsCapped: d.creators_capped === 1,
      creators: this.sql.exec<Row>("SELECT * FROM creator_plans WHERE day = ? ORDER BY user_id", day).toArray().map((c) => ({
        userId: c.user_id as string, plan: c.plan as string, via: c.via as PlansDay["creators"][number]["via"],
        grantSource: nullable<string>(c.grant_source), grantOrgId: nullable<string>(c.grant_org_id),
      })),
      orgs: this.sql.exec<Row>("SELECT * FROM org_days WHERE day = ? ORDER BY org_id", day).toArray().map((o) => ({
        orgId: o.org_id as string, seats: nullable<number>(o.seats), source: nullable(o.source) as PlansDay["orgs"][number]["source"],
        active: o.active === null ? null : o.active === 1, plans: parse(o.plans),
      })),
      soloGrants: this.sql.exec<Row>("SELECT * FROM solo_grants WHERE day = ? ORDER BY plan, source", day).toArray().map((g) => ({
        plan: g.plan as string, source: g.source as string, count: g.count as number,
      })),
    };
  }

  async month(month: string): Promise<MonthRecords> {
    const before = this.sql.exec<Row>(
      "SELECT day FROM days WHERE day LIKE ? ORDER BY day DESC LIMIT 1", `${previousMonth(month)}-%`,
    ).toArray().map((r) => r.day as string);
    const days = this.sql.exec<Row>("SELECT day FROM days WHERE day LIKE ? ORDER BY day", `${month}-%`).toArray().map((r) => r.day as string);
    const last = this.sql.exec<Row>("SELECT * FROM runs ORDER BY started_at DESC LIMIT 1").toArray()[0];
    return {
      month,
      rooms: await this.knownRooms(),
      usage: this.sql.exec<Row>("SELECT * FROM usage WHERE month = ? ORDER BY object_id", month).toArray().map(usageOf),
      totals: this.sql.exec<Row>("SELECT * FROM totals WHERE month = ? ORDER BY namespace_id", month).toArray().map(totalsOf),
      blobs: this.sql.exec<Row>("SELECT * FROM blobs WHERE day LIKE ? ORDER BY day, session_id", `${month}-%`).toArray()
        .map((b) => ({ day: b.day as string, sessionId: b.session_id as string, bytes: b.bytes as number })),
      plans: [...before, ...days].map((day) => this.#plansDay(day)),
      lastRun: last ? runOf(last) : null,
    };
  }

  async roomMonths(sessionId: string): Promise<string[]> {
    return this.sql.exec<Row>("SELECT DISTINCT month FROM usage WHERE session_id = ? ORDER BY month", sessionId).toArray()
      .map((r) => r.month as string);
  }

  async months(): Promise<string[]> {
    return this.sql.exec<Row>("SELECT DISTINCT month FROM usage ORDER BY month").toArray().map((r) => r.month as string);
  }
}

/** The Worker's handle on `CostDO`: every call through `reviving`, as `DurableObjectStore` does for the others. */
export const costStore = (namespace: DurableObjectNamespace<CostDO>): CostStore =>
  reviving(namespace.get(namespace.idFromName("cost"))) as unknown as CostStore;
