/**
 * The cost capture's one Cloudflare query (#473, design section 2): a month of Durable Object usage per object and per
 * namespace, from GraphQL Analytics. No other module names a Cloudflare field.
 *
 * Settled by the pre-check on #473: the `datetime_geq` / `datetime_lt` filter, `sum.duration` as billed GB-s,
 * `activeTime` in microseconds, and invocation `type`s `jsrpc`, `http`, `alarm`, `hibernation`.
 */

export const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";

// ponytail: no paging. Each part asks for 10,000 rows, and a part that comes back full marks its month
// `skipped_full_page` rather than storing a partial sum. The upgrade is paging with `objectId_gt` and
// `orderBy: [objectId_ASC]`, both confirmed on the account.
export const MAX_USAGE_ROWS = 10_000;

/** Every `sum` field of `durableObjectsPeriodicGroups`, stored as Cloudflare names them. */
const PERIODIC_SUMS = [
  "duration", "activeTime", "cpuTime", "rowsRead", "rowsWritten", "storageReadUnits", "storageWriteUnits",
  "storageDeletes", "inboundWebsocketMsgCount", "outboundWebsocketMsgCount", "subrequests",
].join(" ");

/** A month as Cloudflare's filter takes it: its first instant, and the next month's. */
export function monthWindow(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return { from: `${month}-01T00:00:00Z`, to: `${next}-01T00:00:00Z` };
}

/** The four parts in one request, so a month costs one subrequest. */
export function usageQuery(accountTag: string, month: string): { query: string; variables: Record<string, string> } {
  const { from, to } = monthWindow(month);
  const window = `limit: ${MAX_USAGE_ROWS}, filter: { datetime_geq: $from, datetime_lt: $to }`;
  const query = `query ($account: String!, $from: Time!, $to: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      periodic: durableObjectsPeriodicGroups(${window}) {
        dimensions { objectId namespaceId } sum { ${PERIODIC_SUMS} } avg { sampleInterval }
      }
      invocations: durableObjectsInvocationsAdaptiveGroups(${window}) {
        dimensions { objectId namespaceId type } sum { requests wallTime } avg { sampleInterval }
      }
      periodicTotals: durableObjectsPeriodicGroups(${window}) {
        dimensions { namespaceId } sum { ${PERIODIC_SUMS} } avg { sampleInterval }
      }
      invocationTotals: durableObjectsInvocationsAdaptiveGroups(${window}) {
        dimensions { namespaceId type } sum { requests wallTime } avg { sampleInterval }
      }
    }
  }
}`;
  return { query, variables: { account: accountTag, from, to } };
}

export type PeriodicRow = { objectId: string; namespaceId: string; sums: Record<string, number>; sampleInterval: number | null };
export type InvocationRow = { objectId: string; namespaceId: string; type: string; requests: number; wallTime: number; sampleInterval: number | null };
export type UsageRows = {
  periodic: PeriodicRow[];
  invocations: InvocationRow[];
  periodicTotals: Omit<PeriodicRow, "objectId">[];
  invocationTotals: Omit<InvocationRow, "objectId">[];
};
export type UsageAnswer = UsageRows | { error: string } | { fullPage: true };

type Group = { dimensions?: Record<string, string>; sum?: Record<string, number>; avg?: { sampleInterval?: number } };

const numbers = (sum: Record<string, number> | undefined): Record<string, number> =>
  Object.fromEntries(Object.entries(sum ?? {}).filter(([, v]) => typeof v === "number"));

/** Cloudflare's answer, typed. Never throws: anything unexpected comes back as an error string. */
export function parseUsage(json: unknown): UsageAnswer {
  if (typeof json !== "object" || json === null) return { error: "unexpected answer" };
  const body = json as { data?: { viewer?: { accounts?: Record<string, Group[]>[] } } | null; errors?: { message?: string }[] };
  if (body.errors?.length) return { error: body.errors.map((e) => e.message ?? "unknown error").join("; ") };
  const account = body.data?.viewer?.accounts?.[0];
  if (!account) return { error: "no account in the answer" };
  const parts = ["periodic", "invocations", "periodicTotals", "invocationTotals"].map((k) => account[k] ?? []);
  if (parts.some((p) => p.length >= MAX_USAGE_ROWS)) return { fullPage: true };
  const [periodic, invocations, periodicTotals, invocationTotals] = parts;
  const interval = (g: Group) => g.avg?.sampleInterval ?? null;
  const dim = (g: Group, k: string) => g.dimensions?.[k] ?? "";
  return {
    periodic: periodic.map((g) => ({ objectId: dim(g, "objectId"), namespaceId: dim(g, "namespaceId"), sums: numbers(g.sum), sampleInterval: interval(g) })),
    invocations: invocations.map((g) => ({
      objectId: dim(g, "objectId"), namespaceId: dim(g, "namespaceId"), type: dim(g, "type"),
      requests: g.sum?.requests ?? 0, wallTime: g.sum?.wallTime ?? 0, sampleInterval: interval(g),
    })),
    periodicTotals: periodicTotals.map((g) => ({ namespaceId: dim(g, "namespaceId"), sums: numbers(g.sum), sampleInterval: interval(g) })),
    invocationTotals: invocationTotals.map((g) => ({
      namespaceId: dim(g, "namespaceId"), type: dim(g, "type"),
      requests: g.sum?.requests ?? 0, wallTime: g.sum?.wallTime ?? 0, sampleInterval: interval(g),
    })),
  };
}
