/**
 * The audit routes (audit trail spec, D7 and D8): an org admin reads their own org's stream, a
 * page at a time or whole as a file. On the room routes' rules: the same caller, CORS for the
 * panel's origins and the same preflight. Both are reads, so neither needs a CSRF check. The
 * org is always the caller's own, never a parameter.
 */
import { auditRefusal, type AuditPage, type AuditQuery, type SeqEntry } from "../audit.js";
import { RETENTION_FLOOR_DAYS, retentionDaysOf, type AuditSettings } from "../audit-sink.js";
import { attachmentDisposition } from "../blobs.js";
import { allowedOrigin, corsHeaders, preflightResponse } from "../oauth/browser.js";
import { json, lengthRefusal, methodNotAllowed, problem, type RoomRouteDeps } from "./rooms.js";

export type AuditRouteDeps = Pick<RoomRouteDeps, "store" | "caller" | "panelOrigins">;

/** Rows in one page of `GET /audit`. */
export const AUDIT_PAGE = 100;

export type AuditParams = Omit<AuditQuery, "limit">;

const MAX_SETTINGS_BYTES = 4096;

/** `GET` and `PATCH /audit/settings` answer the same shape: the window and the sink as the admin set them. */
const settingsView = (s: AuditSettings) => ({ retention_days: s.retentionDays, sink: s.sink });

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
    // Date.parse rolls a day its month lacks into the next (02-30 reads as 03-02), so the date the string itself names has to
    // survive a round trip. The string's, not the instant's UTC date: an offset such as +05:00 legitimately moves that one.
    const day = v.slice(0, 10);
    if (!ISO_INSTANT.test(v) || !Number.isFinite(t) || new Date(Date.parse(day)).toISOString().slice(0, 10) !== day) {
      return { invalid: `${name} must be an ISO 8601 instant, such as 2026-10-09T00:00:00Z` };
    }
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
  /** The row's link in the chain (ADR 0033); null on a row from before it. `GET /audit/verify` walks them. */
  hash: string | null;
}

export function entryView(e: SeqEntry): AuditEntryView {
  const recorded = e.crossing !== undefined;
  return {
    seq: e.seq,
    at: new Date(e.at).toISOString(),
    action: e.action,
    // A grant row is about an org's plan, filed under `grant:<key>`, an org row about the org itself, under
    // `org:<id>` (orgs spec, D8), and a SCIM row about a member the IdP pushed, under `scim:<id>` (SCIM spec,
    // D11): none is about a room.
    room: /^(grant|org|scim):/.test(e.sessionId) ? null : { id: e.sessionId, name: recorded ? e.roomName ?? null : null },
    actor: recorded ? { id: e.actorUserId, label: e.actorLabel ?? null, org_id: e.actorOrgId ?? null } : { id: e.actorUserId },
    parties: recorded ? e.parties ?? [] : null,
    crossing: e.crossing ?? null,
    direction: recorded ? e.direction ?? null : null,
    detail: e.detail,
    hash: e.hash ?? null,
  };
}

/** Rows the export reads per page: one page per pull, so a long stream is never held whole. */
export const AUDIT_EXPORT_PAGE = 500;

export const CSV_COLUMNS = [
  "seq", "at", "action", "room_id", "room_name", "actor_id", "actor_label", "actor_org",
  "parties", "crossing", "direction", "detail", "hash",
] as const;

export const csvHeader = `${CSV_COLUMNS.join(",")}\r\n`;

// What a spreadsheet reads as the start of a formula. Room names and labels are written by users.
const FORMULA = /^[=+\-@\t\r]/;

/** One RFC 4180 cell. A string a spreadsheet would run as a formula gets a leading ', so it is only text. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" && FORMULA.test(value) ? `'${value}` : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One row, in CSV_COLUMNS order, ending in CRLF. */
export function csvRow(v: AuditEntryView): string {
  return `${[
    v.seq, v.at, v.action, v.room?.id, v.room?.name, v.actor.id, v.actor.label, v.actor.org_id,
    v.parties?.map((p) => p ?? "(no org)").join(";"), v.crossing, v.direction, JSON.stringify(v.detail), v.hash,
  ].map(csvCell).join(",")}\r\n`;
}

/** The export's name (D8): the org, with anything outside a safe set written as `_` so no id can break the header, and its seq. */
export const exportFilename = (orgId: string, through: number | null, format: "csv" | "json"): string =>
  `bellman-audit-${orgId.replace(/[^A-Za-z0-9_.-]/g, "_")}-${through ?? 0}.${format}`;

/** `undefined` for a path outside `/audit`, so the Worker carries on; everything under it is answered here. */
export async function auditRoutes(request: Request, deps: AuditRouteDeps): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (path !== "/audit" && !path.startsWith("/audit/")) return undefined;
  const origin = allowedOrigin(request, deps.panelOrigins);
  if (request.method === "OPTIONS") return preflightResponse(origin);
  try {
    const exporting = path === "/audit/export";
    const settings = path === "/audit/settings";
    if (path !== "/audit" && !exporting && path !== "/audit/verify" && !settings) return problem(404, "not_found", "no such route", origin);
    if (settings ? request.method !== "GET" && request.method !== "PATCH" : request.method !== "GET") return methodNotAllowed(settings ? "GET, PATCH" : "GET", origin);
    const who = await deps.caller(request);
    if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
    const refused = auditRefusal(who.identity);
    if (refused) return problem(403, "forbidden", refused, origin);
    const orgId = who.identity.orgId as string; // auditRefusal refuses an identity with no org
    if (settings) {
      if (request.method === "GET") return json(200, settingsView(await deps.store.auditSettings(orgId)), origin);
      const refusedLength = lengthRefusal(request, MAX_SETTINGS_BYTES, "an audit setting", origin);
      if (refusedLength) return refusedLength;
      const body: unknown = await request.json().catch(() => undefined);
      const days = retentionDaysOf(typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>).retention_days : "invalid");
      if (days === "invalid") return problem(400, "invalid_request", `retention_days must be an integer of at least ${RETENTION_FLOOR_DAYS}, or null`, origin);
      const intent = { actorUserId: who.identity.userId, actorLabel: who.identity.label, actorOrgId: who.identity.orgId };
      return json(200, settingsView(await deps.store.setAuditRetention(orgId, days, intent)), origin);
    }
    if (path === "/audit/verify") {
      const from = url.searchParams.get("from");
      if (from !== null && !/^[1-9]\d*$/.test(from)) return problem(400, "invalid_request", "from must be a positive integer", origin);
      return json(200, await deps.store.verifyAudit(orgId, from === null ? undefined : Number(from)), origin);
    }
    const parsed = parseAuditQuery(url.searchParams, exporting);
    if ("invalid" in parsed) return problem(400, "invalid_request", parsed.invalid, origin);
    if (parsed.format) return await exportAudit(orgId, parsed.query, parsed.format, url.searchParams, origin, deps);
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

/**
 * The whole filtered stream as a file (D8), newest first as the page shows it, pinned to one
 * seq so it holds what the page counted. A page of AUDIT_EXPORT_PAGE per pull, so a long stream
 * is never held whole. A failure partway errors the stream instead of closing it: the reader
 * sees a failed body, never a short file that looks complete.
 * ponytail: one request over the whole filtered stream; a stream big enough to strain it wants #58's push.
 */
async function exportAudit(
  orgId: string, query: AuditParams, format: "csv" | "json", params: URLSearchParams,
  origin: string | undefined, deps: AuditRouteDeps,
): Promise<Response> {
  let page: AuditPage | null = await deps.store.queryAudit(orgId, { ...query, limit: AUDIT_EXPORT_PAGE });
  const through = page.through;
  const filter = Object.fromEntries([...params].filter(([name]) => name !== "format" && name !== "through"));
  const encoder = new TextEncoder();
  let written = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(format === "csv"
        ? csvHeader
        : `{"org_id":${JSON.stringify(orgId)},"filter":${JSON.stringify(filter)},"through":${JSON.stringify(through)},"entries":[`));
    },
    async pull(controller) {
      try {
        if (page === null) {
          if (format === "json") controller.enqueue(encoder.encode("]}"));
          controller.close();
          return;
        }
        let chunk = "";
        for (const e of page.entries) {
          const view = entryView(e);
          chunk += format === "csv" ? csvRow(view) : `${written++ > 0 ? "," : ""}${JSON.stringify(view)}`;
        }
        controller.enqueue(encoder.encode(chunk));
        page = page.next === null
          ? null
          : await deps.store.queryAudit(orgId, { ...query, through: through ?? undefined, before: page.next, limit: AUDIT_EXPORT_PAGE });
      } catch (err) {
        console.error(`the audit export for ${orgId} failed partway:`, err);
        controller.error(err);
      }
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
      "content-disposition": attachmentDisposition(exportFilename(orgId, through, format)),
      "cache-control": "no-store",
      // Without it a cross-origin fetch cannot read the name, and the panel would save under one of its own.
      "access-control-expose-headers": "content-disposition",
      ...corsHeaders(origin),
    },
  });
}
