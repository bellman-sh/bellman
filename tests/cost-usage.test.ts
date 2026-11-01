import { describe, expect, it } from "vitest";
import { mapUsage } from "../src/cost/usage.js";
import type { UsageRows } from "../src/cost/graphql.js";
import type { RoomRecord } from "../src/cost/records.js";

const room = (sessionId: string): RoomRecord => ({
  sessionId, createdBy: "u_github_1", orgId: null, sessionObjectId: `so_${sessionId}`, hostObjectId: `ho_${sessionId}`, firstSeenDay: "2026-10-01",
});

const rows: UsageRows = {
  periodic: [
    { objectId: "so_qs_a", namespaceId: "ns_s", sums: { duration: 10 }, sampleInterval: 1 },
    { objectId: "ho_qs_a", namespaceId: "ns_h", sums: { duration: 2 }, sampleInterval: 1 },
    { objectId: "so_qs_gone", namespaceId: "ns_s", sums: { duration: 4 }, sampleInterval: 1.2 },
    { objectId: "registry", namespaceId: "ns_r", sums: { duration: 30 }, sampleInterval: 1 },
  ],
  invocations: [
    { objectId: "so_qs_a", namespaceId: "ns_s", type: "jsrpc", requests: 9, wallTime: 100, sampleInterval: 1 },
    { objectId: "so_qs_a", namespaceId: "ns_s", type: "alarm", requests: 1, wallTime: 5, sampleInterval: 1 },
    { objectId: "so_qs_b", namespaceId: "ns_s", type: "http", requests: 3, wallTime: 7, sampleInterval: 1.5 },
  ],
  periodicTotals: [{ namespaceId: "ns_s", sums: { duration: 14 }, sampleInterval: 1 }],
  invocationTotals: [
    { namespaceId: "ns_s", type: "jsrpc", requests: 9, wallTime: 100, sampleInterval: 1 },
    { namespaceId: "ns_s", type: "http", requests: 3, wallTime: 7, sampleInterval: 1.5 },
  ],
};

describe("mapUsage", () => {
  it("maps each object to its room, purged rooms included, and leaves the rest unmatched", () => {
    // qs_gone is known only from CostDO.rooms: purged, so no longer in the index.
    const { usage, totals } = mapUsage("2026-10", rows, [room("qs_a"), room("qs_b"), room("qs_gone")]);
    expect(usage).toEqual([
      { month: "2026-10", objectId: "ho_qs_a", kind: "host", sessionId: "qs_a", namespaceId: "ns_h", periodic: { duration: 2 }, byType: {}, periodicSampleInterval: 1, invocationsSampleInterval: null },
      { month: "2026-10", objectId: "registry", kind: "unmatched", sessionId: null, namespaceId: "ns_r", periodic: { duration: 30 }, byType: {}, periodicSampleInterval: 1, invocationsSampleInterval: null },
      {
        month: "2026-10", objectId: "so_qs_a", kind: "session", sessionId: "qs_a", namespaceId: "ns_s", periodic: { duration: 10 },
        byType: { jsrpc: { requests: 9, wallTime: 100 }, alarm: { requests: 1, wallTime: 5 } },
        periodicSampleInterval: 1, invocationsSampleInterval: 1,
      },
      { month: "2026-10", objectId: "so_qs_b", kind: "session", sessionId: "qs_b", namespaceId: "ns_s", periodic: {}, byType: { http: { requests: 3, wallTime: 7 } }, periodicSampleInterval: null, invocationsSampleInterval: 1.5 },
      { month: "2026-10", objectId: "so_qs_gone", kind: "session", sessionId: "qs_gone", namespaceId: "ns_s", periodic: { duration: 4 }, byType: {}, periodicSampleInterval: 1.2, invocationsSampleInterval: null },
    ]);
    expect(totals).toEqual([{
      month: "2026-10", namespaceId: "ns_s", periodic: { duration: 14 },
      byType: { jsrpc: { requests: 9, wallTime: 100 }, http: { requests: 3, wallTime: 7 } },
      periodicSampleInterval: 1, invocationsSampleInterval: 1.5,
    }]);
  });
});
