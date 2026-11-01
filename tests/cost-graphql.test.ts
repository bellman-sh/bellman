import { describe, expect, it } from "vitest";
import { MAX_USAGE_ROWS, monthWindow, parseUsage, usageQuery } from "../src/cost/graphql.js";

const periodicRow = (objectId: string, namespaceId = "ns_s") => ({
  dimensions: { objectId, namespaceId },
  sum: { duration: 168.5, activeTime: 1316477139, rowsRead: 5, rowsWritten: 2 },
  avg: { sampleInterval: 1.004 },
});
const invocationRow = (objectId: string, type: string, requests: number, namespaceId = "ns_s") => ({
  dimensions: { objectId, namespaceId, type }, sum: { requests, wallTime: 10 }, avg: { sampleInterval: 1 },
});

const answer = (over: Record<string, unknown[]> = {}) => ({
  data: { viewer: { accounts: [{
    periodic: [periodicRow("o1"), periodicRow("o2")],
    invocations: [invocationRow("o1", "jsrpc", 9), invocationRow("o1", "alarm", 1), invocationRow("o2", "http", 3)],
    periodicTotals: [{ dimensions: { namespaceId: "ns_s" }, sum: { duration: 337 }, avg: { sampleInterval: 1 } }],
    invocationTotals: [{ dimensions: { namespaceId: "ns_s", type: "jsrpc" }, sum: { requests: 9, wallTime: 10 }, avg: { sampleInterval: 1.5 } }],
    ...over,
  }] } },
});

describe("the cost capture's GraphQL query", () => {
  it("asks for one month, by object and by namespace, in one request", () => {
    expect(monthWindow("2026-10")).toEqual({ from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z" });
    expect(monthWindow("2026-12")).toEqual({ from: "2026-12-01T00:00:00Z", to: "2027-01-01T00:00:00Z" });
    const q = usageQuery("acct_1", "2026-10");
    expect(q.variables).toEqual({ account: "acct_1", from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z" });
    for (const part of [
      "accounts(filter: { accountTag: $account })",
      `periodic: durableObjectsPeriodicGroups(limit: ${MAX_USAGE_ROWS}, filter: { datetime_geq: $from, datetime_lt: $to }`,
      "dimensions { objectId namespaceId type }",
      "invocationTotals: durableObjectsInvocationsAdaptiveGroups",
      "sum { duration activeTime cpuTime rowsRead rowsWritten",
    ]) expect(q.query).toContain(part);
  });

  it("parses the rows, keeping every sum field and the sample interval", () => {
    const got = parseUsage(answer());
    expect(got).toEqual({
      periodic: [
        { objectId: "o1", namespaceId: "ns_s", sums: { duration: 168.5, activeTime: 1316477139, rowsRead: 5, rowsWritten: 2 }, sampleInterval: 1.004 },
        { objectId: "o2", namespaceId: "ns_s", sums: { duration: 168.5, activeTime: 1316477139, rowsRead: 5, rowsWritten: 2 }, sampleInterval: 1.004 },
      ],
      invocations: [
        { objectId: "o1", namespaceId: "ns_s", type: "jsrpc", requests: 9, wallTime: 10, sampleInterval: 1 },
        { objectId: "o1", namespaceId: "ns_s", type: "alarm", requests: 1, wallTime: 10, sampleInterval: 1 },
        { objectId: "o2", namespaceId: "ns_s", type: "http", requests: 3, wallTime: 10, sampleInterval: 1 },
      ],
      periodicTotals: [{ namespaceId: "ns_s", sums: { duration: 337 }, sampleInterval: 1 }],
      invocationTotals: [{ namespaceId: "ns_s", type: "jsrpc", requests: 9, wallTime: 10, sampleInterval: 1.5 }],
    });
  });

  it("answers an error with Cloudflare's message, and a full page as fullPage", () => {
    expect(parseUsage({ data: null, errors: [{ message: "unknown field foo" }] })).toEqual({ error: "unknown field foo" });
    expect(parseUsage({ data: { viewer: { accounts: [] } } })).toEqual({ error: "no account in the answer" });
    expect(parseUsage("not json at all")).toEqual({ error: "unexpected answer" });
    const full = Array.from({ length: MAX_USAGE_ROWS }, (_, i) => periodicRow(`o${i}`));
    expect(parseUsage(answer({ periodic: full }))).toEqual({ fullPage: true });
  });
});
