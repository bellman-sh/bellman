/**
 * The audit trail's rules (audit trail spec). This module starts with the one every
 * builder of an audit row comes through: who the row is about, which orgs it reaches, and
 * whether, from each org's side, it crossed that org's boundary and which way (D1 to D3).
 * One rule, so no row can reach one org saying something its copy in another contradicts.
 *
 * Runtime-free, as grant-audit.ts is: store-do.ts imports `cloudflare:workers`, which no
 * vitest test can import, so a rule written there could not be tested in Node.
 */
import type { AuditEntry } from "./types.js";

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

/** An entry with its place in its org's stream: the cursor `before` and `through` count in (D6). */
export type SeqEntry = AuditEntry & { seq: number };

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
};

/**
 * An entry as the table's columns, in AUDIT_COLUMNS order. A row from before D2 has no
 * `crossing`, and its five companions are stored null beside it, so it reads back as it was.
 */
export function recordOf(e: AuditEntry): (string | number | null)[] {
  const recorded = e.crossing !== undefined;
  return [
    e.at, e.orgId, e.sessionId, e.action, e.actorUserId,
    recorded ? e.actorLabel ?? null : null,
    recorded ? e.actorOrgId ?? null : null,
    recorded ? e.roomName ?? null : null,
    recorded ? JSON.stringify(e.parties ?? []) : null,
    e.crossing ?? null,
    recorded ? e.direction ?? null : null,
    JSON.stringify(e.detail ?? {}),
  ];
}

/** A table row as an entry: with the six fields when it recorded a crossing, without them when it is from before (D4). */
export function entryOf(r: AuditRecord): SeqEntry {
  const base: SeqEntry = {
    seq: r.seq, at: r.at, orgId: r.org_id, sessionId: r.session_id, actorUserId: r.actor_id, action: r.action,
    detail: JSON.parse(r.detail) as Record<string, unknown>,
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
