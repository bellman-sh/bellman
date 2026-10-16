/**
 * The audit routes (audit trail spec, D7 and D8): an org admin reads their own org's stream, a
 * page at a time or whole as a file. On the room routes' rules: the same caller, CORS for the
 * panel's origins and the same preflight. Both are reads, so neither needs a CSRF check. The
 * org is always the caller's own, never a parameter.
 */
import { auditRefusal, type AuditQuery, type SeqEntry } from "../audit.js";
import { allowedOrigin, preflightResponse } from "../oauth/browser.js";
import { json, methodNotAllowed, problem, type RoomRouteDeps } from "./rooms.js";

export type AuditRouteDeps = Pick<RoomRouteDeps, "store" | "caller" | "panelOrigins">;

/** Rows in one page of `GET /audit`. */
export const AUDIT_PAGE = 100;

export type AuditParams = Omit<AuditQuery, "limit">;

const LIST_PARAMS = ["from", "to", "actor", "room", "org", "action", "scope", "before", "through"];
const EXPORT_PARAMS = ["from", "to", "actor", "room", "org", "action", "scope", "through", "format"];
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_FILTER_CHARS = 200;

/**
 * The query string as a filter, or the sentence a 400 says. Every parameter is one this route
 * takes, given once, in its form: a filter an auditor mistyped must not be dropped quietly, or
 * an export holds rows its reader believes were left out.
 */
export function parseAuditQuery(
  params: URLSearchParams, exporting: boolean,
): { query: AuditParams; format?: "csv" | "json" } | { invalid: string } {
  const route = exporting ? "/audit/export" : "/audit";
  const known = exporting ? EXPORT_PARAMS : LIST_PARAMS;
  const given = new Map<string, string>();
  for (const [name, value] of params) {
    if (!known.includes(name)) return { invalid: `${name} is not a parameter of ${route}` };
    if (given.has(name)) return { invalid: `${name} is given more than once` };
    given.set(name, value);
  }
  const query: AuditParams = {};
  for (const name of ["from", "to"] as const) {
    const v = given.get(name);
    if (v === undefined) continue;
    const t = Date.parse(v);
    if (!ISO_INSTANT.test(v) || !Number.isFinite(t)) return { invalid: `${name} must be an ISO 8601 instant, such as 2026-10-09T00:00:00Z` };
    query[name] = t;
  }
  for (const name of ["actor", "room", "org", "action"] as const) {
    const v = given.get(name);
    if (v === undefined) continue;
    if (v.length < 1 || v.length > MAX_FILTER_CHARS) return { invalid: `${name} must be 1 to ${MAX_FILTER_CHARS} characters` };
    query[name] = v;
  }
  const scope = given.get("scope");
  if (scope !== undefined) {
    if (scope !== "internal" && scope !== "cross_org") return { invalid: "scope must be internal or cross_org" };
    query.scope = scope;
  }
  for (const name of ["before", "through"] as const) {
    const v = given.get(name);
    if (v === undefined) continue;
    if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) return { invalid: `${name} is a seq: a whole number, 0 or more` };
    query[name] = Number(v);
  }
  if (!exporting) return { query };
  const format = given.get("format");
  if (format !== "csv" && format !== "json") return { invalid: "format is required: csv or json" };
  return { query, format };
}

/** One row as the panel and an export read it (D7). A row from before D2 says it recorded no crossing. */
export interface AuditEntryView {
  seq: number;
  at: string;
  action: string;
  room: { id: string; name: string | null } | null;
  /** `label` and `org_id` are absent on a row from before D2: not recorded, which is not the same as no org. */
  actor: { id: string; label?: string | null; org_id?: string | null };
  parties: (string | null)[] | null;
  crossing: "internal" | "cross_org" | null;
  direction: "outbound" | "inbound" | null;
  detail: Record<string, unknown>;
}

export function entryView(e: SeqEntry): AuditEntryView {
  const recorded = e.crossing !== undefined;
  return {
    seq: e.seq,
    at: new Date(e.at).toISOString(),
    action: e.action,
    // A grant row is about an org's plan, filed under `grant:<key>`, not about a room.
    room: e.sessionId.startsWith("grant:") ? null : { id: e.sessionId, name: recorded ? e.roomName ?? null : null },
    actor: recorded ? { id: e.actorUserId, label: e.actorLabel ?? null, org_id: e.actorOrgId ?? null } : { id: e.actorUserId },
    parties: recorded ? e.parties ?? [] : null,
    crossing: e.crossing ?? null,
    direction: recorded ? e.direction ?? null : null,
    detail: e.detail,
  };
}

/** `undefined` for a path outside `/audit`, so the Worker carries on; everything under it is answered here. */
export async function auditRoutes(request: Request, deps: AuditRouteDeps): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (path !== "/audit" && !path.startsWith("/audit/")) return undefined;
  const origin = allowedOrigin(request, deps.panelOrigins);
  if (request.method === "OPTIONS") return preflightResponse(origin);
  try {
    if (path !== "/audit") return problem(404, "not_found", "no such route", origin);
    if (request.method !== "GET") return methodNotAllowed("GET", origin);
    const who = await deps.caller(request);
    if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
    const refused = auditRefusal(who.identity);
    if (refused) return problem(403, "forbidden", refused, origin);
    const orgId = who.identity.orgId as string; // auditRefusal refuses an identity with no org
    const parsed = parseAuditQuery(url.searchParams, false);
    if ("invalid" in parsed) return problem(400, "invalid_request", parsed.invalid, origin);
    return await readAudit(orgId, parsed.query, origin, deps);
  } catch (err) {
    console.error(`${request.method} ${path} failed:`, err);
    return problem(500, "internal", "the request failed on the server", origin);
  }
}

/** One page (D7). The filters' options come with the first page only, and cover the whole stream. */
async function readAudit(orgId: string, query: AuditParams, origin: string | undefined, deps: AuditRouteDeps): Promise<Response> {
  const page = await deps.store.queryAudit(orgId, { ...query, limit: AUDIT_PAGE });
  const facets = query.before === undefined ? await deps.store.auditFacets(orgId) : undefined;
  return json(200, {
    org_id: orgId,
    entries: page.entries.map(entryView),
    next: page.next,
    through: page.through,
    total: page.total,
    unrecorded: page.unrecorded,
    ...(facets ? { facets } : {}),
  }, origin);
}
