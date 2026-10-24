/**
 * The audit trail's rules (audit trail spec). This module starts with the one every
 * builder of an audit row comes through: who the row is about, which orgs it reaches, and
 * whether, from each org's side, it crossed that org's boundary and which way (D1 to D3).
 * One rule, so no row can reach one org saying something its copy in another contradicts.
 *
 * Runtime-free, as grant-audit.ts is: store-do.ts imports `cloudflare:workers`, which no
 * vitest test can import, so a rule written there could not be tested in Node.
 */
import { entitlementsFor } from "./auth.js";
import type { AuditEntry, Identity } from "./types.js";

/** Who acted, as a row records them. */
export interface AuditActor {
  userId: string;
  label: string | null;
  orgId: string | null;
}

/** The server acting on its own clock: a purge nobody asked for (#65, D2). It has no org and no direction. */
export const SYSTEM_ACTOR: AuditActor = { userId: "system", label: null, orgId: null };

/** What a row says about itself, before it is addressed to a stream. */
export interface AuditFacts {
  at: number;
  sessionId: string;
  action: string;
  roomName: string | null;
  detail: Record<string, unknown>;
}

/**
 * The parties to an action (D1), once each, sorted, with `null` last for a person with no
 * org. A falsy org is no org (ARCHITECTURE.md section 9, runtime fact 4), so "" counts as
 * null: a stream named "" is one nobody reads.
 */
export function partiesOf(orgs: readonly (string | null)[]): (string | null)[] {
  const named = [...new Set(orgs.filter((o): o is string => Boolean(o)))].sort();
  return orgs.some((o) => !o) ? [...named, null] : named;
}

/**
 * The row stream `orgId` keeps (D3). It is cross-org when the parties hold anyone but this
 * org. A cross-org row is outbound when this org acted and inbound when anyone else did; the
 * system acts for nobody, and an internal row has no direction.
 */
export function auditRow(orgId: string, parties: (string | null)[], facts: AuditFacts, actor: AuditActor): AuditEntry {
  const crossing = parties.some((p) => p !== orgId) ? "cross_org" : "internal";
  const direction = crossing === "internal" || actor.userId === SYSTEM_ACTOR.userId
    ? null
    : actor.orgId === orgId ? "outbound" : "inbound";
  return {
    at: facts.at, orgId, sessionId: facts.sessionId, actorUserId: actor.userId, action: facts.action,
    detail: facts.detail, actorLabel: actor.label, actorOrgId: actor.orgId, roomName: facts.roomName,
    parties, crossing, direction,
  };
}

/** One row for each org among the parties (D1). A person with no org is a party with no stream, and gets none. */
export function auditRows(parties: (string | null)[], facts: AuditFacts, actor: AuditActor): AuditEntry[] {
  return parties.filter((p): p is string => p !== null).map((orgId) => auditRow(orgId, parties, facts, actor));
}

/**
 * An entry with its place in its org's stream: the cursor `before` and `through` count in (D6),
 * and its link in the chain (ADR 0035): `hash` over seq, `prevHash` and the record, both null on
 * a row from before the chain.
 */
export type SeqEntry = AuditEntry & { seq: number; hash: string | null; prevHash: string | null };

/** The `entries` table's columns after `seq`, in the order `recordOf` binds them (D5). */
export const AUDIT_COLUMNS = [
  "at", "org_id", "session_id", "action", "actor_id", "actor_label", "actor_org",
  "room_name", "parties", "crossing", "direction", "detail",
] as const;

/** One row of the `entries` table, as `sql.exec` hands it back. A type, not an interface: `exec`'s row type must be indexable. */
export type AuditRecord = {
  seq: number;
  at: number;
  org_id: string | null;
  session_id: string;
  action: string;
  actor_id: string;
  actor_label: string | null;
  actor_org: string | null;
  room_name: string | null;
  parties: string | null;
  crossing: string | null;
  direction: string | null;
  detail: string;
  prev_hash: string | null;
  hash: string | null;
};

/**
 * An entry as the table's columns, in AUDIT_COLUMNS order. A row from before D2 has no
 * `crossing`, and its five companions are stored null beside it, so it reads back as it was.
 */
/** A lone surrogate becomes U+FFFD in SQLite's text columns; hash the value the row will hold. */
const wellFormed = (v: string | number | null) =>
  typeof v === "string" ? v.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD") : v;

export function recordOf(e: AuditEntry): (string | number | null)[] {
  const recorded = e.crossing !== undefined;
  return ([
    e.at, e.orgId, e.sessionId, e.action, e.actorUserId,
    recorded ? e.actorLabel ?? null : null,
    recorded ? e.actorOrgId ?? null : null,
    recorded ? e.roomName ?? null : null,
    recorded ? JSON.stringify(e.parties ?? []) : null,
    e.crossing ?? null,
    recorded ? e.direction ?? null : null,
    JSON.stringify(e.detail ?? {}),
  ] as (string | number | null)[]).map(wellFormed);
}

/** A table row as an entry: with the six fields when it recorded a crossing, without them when it is from before (D4). */
export function entryOf(r: AuditRecord): SeqEntry {
  const base: SeqEntry = {
    seq: r.seq, at: r.at, orgId: r.org_id, sessionId: r.session_id, actorUserId: r.actor_id, action: r.action,
    detail: JSON.parse(r.detail) as Record<string, unknown>, hash: r.hash, prevHash: r.prev_hash,
  };
  if (r.crossing === null) return base;
  return {
    ...base,
    actorLabel: r.actor_label,
    actorOrgId: r.actor_org,
    roomName: r.room_name,
    parties: JSON.parse(r.parties ?? "[]") as (string | null)[],
    crossing: r.crossing as "internal" | "cross_org",
    direction: r.direction as "outbound" | "inbound" | null,
  };
}

/** A read of one org's stream (D6). Every field but `limit` narrows it; together they are an AND. */
export interface AuditQuery {
  /** Epoch ms, inclusive. */
  from?: number;
  /** Epoch ms, exclusive. */
  to?: number;
  actor?: string;
  room?: string;
  /** Matches any entry of `parties`. */
  org?: string;
  action?: string;
  scope?: "internal" | "cross_org";
  /** A seq: only rows older than it. */
  before?: number;
  /** A seq: only rows at or below it. */
  through?: number;
  limit: number;
}

export interface AuditPage {
  /** Newest first. */
  entries: SeqEntry[];
  /** Pass as `before` for the next page; null at the end. */
  next: number | null;
  /** The highest seq the read covered: its `through`, or the stream's newest when it named none; null for an empty stream. */
  through: number | null;
  /** Rows matching the filters at or below `through`: what an export of them holds. */
  total: number;
  /** Rows matching every filter but scope and org that record no crossing (D4); 0 without either. */
  unrecorded: number;
}

/** What the panel's filters offer (D7), newest first, up to FACET_LIMIT each. `orgs` never holds the reader's own. */
export interface AuditFacets {
  actors: { id: string; label: string | null }[];
  rooms: { id: string; name: string | null }[];
  orgs: string[];
  actions: string[];
}

// ponytail: 200 a list, not tuned. A stream with more distinct values offers its newest 200, and a filter still takes any value by URL.
export const FACET_LIMIT = 200;

const matches = (e: SeqEntry, q: AuditQuery, through: number | null, scope: boolean): boolean =>
  (through === null || e.seq <= through)
  && (q.from === undefined || e.at >= q.from)
  && (q.to === undefined || e.at < q.to)
  && (q.actor === undefined || e.actorUserId === q.actor)
  && (q.room === undefined || e.sessionId === q.room)
  && (q.action === undefined || e.action === q.action)
  && (q.org === undefined || (e.parties ?? []).includes(q.org))
  && (!scope || q.scope === undefined || e.crossing === q.scope);

/** The query over rows in memory: MemoryStore's read, held to AuditDO's SQL by the store contract. */
export function pageOf(rows: readonly SeqEntry[], q: AuditQuery): AuditPage {
  const through = q.through ?? (rows.length > 0 ? rows.reduce((max, r) => Math.max(max, r.seq), 0) : null);
  const all = rows.filter((r) => matches(r, q, through, true)).sort((a, b) => b.seq - a.seq);
  const older = q.before === undefined ? all : all.filter((r) => r.seq < q.before!);
  const entries = older.slice(0, q.limit);
  return {
    entries,
    next: older.length > q.limit ? entries.at(-1)!.seq : null,
    through,
    total: all.length,
    unrecorded: q.scope === undefined && q.org === undefined
      ? 0
      : rows.filter((r) => r.crossing === undefined && matches(r, { ...q, org: undefined }, through, false)).length,
  };
}

/** The facets over rows in memory, newest first. Ties among orgs first seen in one row go in the row's sorted order, as the SQL's do. */
export function facetsOf(rows: readonly SeqEntry[], orgId: string): AuditFacets {
  const newestFirst = [...rows].sort((a, b) => b.seq - a.seq);
  const firstBy = (key: (e: SeqEntry) => string | undefined): [string, SeqEntry][] => {
    const seen = new Map<string, SeqEntry>();
    for (const e of newestFirst) {
      const k = key(e);
      if (k !== undefined && !seen.has(k)) seen.set(k, e);
    }
    return [...seen].slice(0, FACET_LIMIT);
  };
  return {
    actors: firstBy((e) => e.actorUserId).map(([id, e]) => ({ id, label: e.actorLabel ?? null })),
    rooms: firstBy((e) => (e.sessionId.startsWith("grant:") ? undefined : e.sessionId)).map(([id, e]) => ({ id, name: e.roomName ?? null })),
    orgs: [...new Set(newestFirst.flatMap((e) => (e.parties ?? []).filter((p): p is string => p !== null && p !== orgId)))]
      .slice(0, FACET_LIMIT),
    actions: firstBy((e) => e.action).map(([action]) => action),
  };
}

/**
 * The query as SQL for AuditDO's `entries` table: a WHERE clause built from fixed fragments,
 * with every value a bound parameter. `use.scope` and `use.before` leave those out, for the
 * counts: `total` ignores `before`, and `unrecorded` ignores the scope; its caller drops the org too.
 */
export function auditWhere(
  q: AuditQuery, through: number | null, use: { scope: boolean; before: boolean },
): { clause: string; params: (string | number)[] } {
  const parts: string[] = [];
  const params: (string | number)[] = [];
  const add = (sql: string, value: string | number) => {
    parts.push(sql);
    params.push(value);
  };
  if (through !== null) add("seq <= ?", through);
  if (use.before && q.before !== undefined) add("seq < ?", q.before);
  if (q.from !== undefined) add("at >= ?", q.from);
  if (q.to !== undefined) add("at < ?", q.to);
  if (q.actor !== undefined) add("actor_id = ?", q.actor);
  if (q.room !== undefined) add("session_id = ?", q.room);
  if (q.action !== undefined) add("action = ?", q.action);
  if (q.org !== undefined) add("EXISTS (SELECT 1 FROM json_each(entries.parties) WHERE value = ?)", q.org);
  if (use.scope && q.scope !== undefined) add("crossing = ?", q.scope);
  return { clause: parts.length > 0 ? `WHERE ${parts.join(" AND ")}` : "", params };
}

/**
 * Why `identity` may not read an org's audit stream, or null when it may: the team plan,
 * which is what pays for the log, the admin role, and an org, in that order and in
 * `bellman_audit`'s words. The tool, the room routes' admin read and the audit routes all
 * ask this, so the three conditions cannot drift apart.
 */
export function auditRefusal(identity: Identity): string | null {
  if (!entitlementsFor(identity).audit) return `the audit log requires the team plan (you are on "${identity.plan}").`;
  if (identity.role !== "admin") return "the audit log requires the admin role.";
  if (!identity.orgId) return "your identity has no org.";
  return null;
}

/** One row as the panel and an export read it (D7); the sink posts the same shape (ADR 0035). A row from before D2 says it recorded no crossing. */
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
  /** The row's link in the chain (ADR 0035); null on a row from before it. `GET /audit/verify` walks them. */
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
