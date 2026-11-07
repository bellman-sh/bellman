/** `CostStore` in memory, for tests and the Node server. `CostDO` (src/workerd/cost-do.ts) is the production one. */
import {
  isTooOld, previousMonth,
  type BlobRow, type CostStore, type MonthRecords, type PlansDay, type RoomRecord, type RunRecord, type TotalsRecord, type UsageRecord,
} from "./records.js";

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryCostStore implements CostStore {
  private rooms = new Map<string, RoomRecord>();
  private usage = new Map<string, { usage: UsageRecord[]; totals: TotalsRecord[] }>();
  private blobs = new Map<string, BlobRow[]>();
  private plans = new Map<string, PlansDay>();
  private runs = new Map<number, RunRecord>();

  async putRooms(rooms: RoomRecord[]): Promise<void> {
    for (const r of rooms) if (!this.rooms.has(r.sessionId)) this.rooms.set(r.sessionId, clone(r));
  }

  async knownRooms(): Promise<RoomRecord[]> {
    return [...this.rooms.values()].map(clone);
  }

  async replaceUsage(month: string, usage: UsageRecord[], totals: TotalsRecord[], now: number) {
    if (isTooOld(month, now)) return { ok: false as const, reason: "too_old" as const };
    this.usage.set(month, { usage: clone(usage), totals: clone(totals) });
    return { ok: true as const };
  }

  async putBlobs(day: string, rows: BlobRow[]): Promise<void> {
    this.blobs.set(day, clone(rows));
  }

  async putPlans(plans: PlansDay): Promise<void> {
    this.plans.set(plans.day, clone(plans));
  }

  async putRun(run: RunRecord): Promise<void> {
    this.runs.set(run.startedAt, clone(run));
  }

  async month(month: string): Promise<MonthRecords> {
    const days = [...this.plans.keys()].sort();
    const before = days.filter((d) => d.startsWith(previousMonth(month))).at(-1);
    const latest = [...this.runs.keys()].sort((a, b) => a - b).at(-1);
    const held = this.usage.get(month);
    return {
      month,
      rooms: await this.knownRooms(),
      usage: clone(held?.usage ?? []),
      totals: clone(held?.totals ?? []),
      blobs: [...this.blobs].filter(([day]) => day.startsWith(month)).sort(([a], [b]) => a.localeCompare(b))
        .flatMap(([day, rows]) => rows.map((r) => ({ day, ...r }))),
      plans: [...(before ? [before] : []), ...days.filter((d) => d.startsWith(month))].map((d) => clone(this.plans.get(d)!)),
      lastRun: latest === undefined ? null : clone(this.runs.get(latest)!),
    };
  }

  async roomMonths(sessionId: string): Promise<string[]> {
    return [...this.usage].filter(([, m]) => m.usage.some((u) => u.sessionId === sessionId)).map(([month]) => month).sort();
  }

  async months(): Promise<string[]> {
    return [...this.usage].filter(([, m]) => m.usage.length > 0).map(([month]) => month).sort();
  }
}
