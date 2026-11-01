/**
 * Cloudflare's per-object rows mapped to rooms (#473, design section 3). Object ids come from the rooms `CostDO`
 * records, which outlive a purge, so a room's usage up to its purge still maps to it. Rows matching no room (the
 * registry, auth and audit singletons, and any room created and purged between two runs) are kept as unmatched.
 */
import type { UsageRows } from "./graphql.js";
import type { ByType, RoomRecord, TotalsRecord, UsageRecord } from "./records.js";

/** The largest interval among an object's invocation rows: one per type, and they can differ. */
const widest = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));

export function mapUsage(month: string, rows: UsageRows, rooms: RoomRecord[]): { usage: UsageRecord[]; totals: TotalsRecord[] } {
  const owner = new Map<string, { kind: "session" | "host"; sessionId: string }>();
  for (const r of rooms) {
    owner.set(r.sessionObjectId, { kind: "session", sessionId: r.sessionId });
    owner.set(r.hostObjectId, { kind: "host", sessionId: r.sessionId });
  }

  const byObject = new Map<string, UsageRecord>();
  const record = (objectId: string, namespaceId: string): UsageRecord => {
    let u = byObject.get(objectId);
    if (!u) {
      const o = owner.get(objectId);
      u = {
        month, objectId, kind: o?.kind ?? "unmatched", sessionId: o?.sessionId ?? null, namespaceId,
        periodic: {}, byType: {}, periodicSampleInterval: null, invocationsSampleInterval: null,
      };
      byObject.set(objectId, u);
    }
    return u;
  };
  for (const p of rows.periodic) {
    const u = record(p.objectId, p.namespaceId);
    u.periodic = p.sums;
    u.periodicSampleInterval = p.sampleInterval;
  }
  for (const i of rows.invocations) {
    const u = record(i.objectId, i.namespaceId);
    u.byType[i.type] = { requests: i.requests, wallTime: i.wallTime };
    u.invocationsSampleInterval = widest(u.invocationsSampleInterval, i.sampleInterval);
  }

  const byNamespace = new Map<string, TotalsRecord>();
  const total = (namespaceId: string): TotalsRecord => {
    let t = byNamespace.get(namespaceId);
    if (!t) {
      t = { month, namespaceId, periodic: {}, byType: {} as ByType, periodicSampleInterval: null, invocationsSampleInterval: null };
      byNamespace.set(namespaceId, t);
    }
    return t;
  };
  for (const p of rows.periodicTotals) {
    const t = total(p.namespaceId);
    t.periodic = p.sums;
    t.periodicSampleInterval = p.sampleInterval;
  }
  for (const i of rows.invocationTotals) {
    const t = total(i.namespaceId);
    t.byType[i.type] = { requests: i.requests, wallTime: i.wallTime };
    t.invocationsSampleInterval = widest(t.invocationsSampleInterval, i.sampleInterval);
  }

  return {
    usage: [...byObject.values()].sort((a, b) => a.objectId.localeCompare(b.objectId)),
    totals: [...byNamespace.values()].sort((a, b) => a.namespaceId.localeCompare(b.namespaceId)),
  };
}
