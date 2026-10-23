/**
 * The audit stream's tamper evidence, retention and sink: the pure parts (audit for a SIEM
 * spec, ADR 0033). Runtime-free, so both stores run the same rules and vitest can test them
 * without `cloudflare:workers`. The stores own the storage; this module owns what to write.
 */
import { createHash } from "node:crypto";
import { recordOf, type AuditEntryView } from "./audit.js";
import type { AuditIntent } from "./grant-audit.js";
import { backoffMs } from "./outbox.js";
import type { AuditEntry } from "./types.js";

export const RETENTION_FLOOR_DAYS = 30;
export const SWEEP_BATCH = 500;
export const SWEEP_EVERY_MS = 86_400_000;
export const SINK_BATCH = 100;
export const SINK_DELAY_MS = 5_000;
export const SINK_TIMEOUT_MS = 10_000;
export const SINK_DEAD_AFTER_MS = 86_400_000;
export const VERIFY_PAGE = 500;

/** The server on its own clock, as a row's intent: the sweep and the sink's death. */
export const SYSTEM_INTENT: AuditIntent = { actorUserId: "system", actorOrgId: null };

/** Where a chain starts: the newest row a sweep deleted, or nothing. */
export interface ChainAnchor { seq: number; hash: string }
export const NO_ANCHOR: ChainAnchor = { seq: 0, hash: "" };

/** D1: sha256 over the seq, the previous hash and the row's twelve columns. */
export function chainHash(seq: number, prevHash: string, entry: AuditEntry): string {
  return createHash("sha256").update(`${seq}\n${prevHash}\n${JSON.stringify(recordOf(entry))}`).digest("hex");
}

export interface ChainRow { seq: number; prevHash: string | null; hash: string | null; entry: AuditEntry }

export interface AuditVerification {
  ok: boolean;
  from_seq: number;
  through_seq: number;
  checked: number;
  unhashed: number;
  broken_at?: number;
  anchor: ChainAnchor;
}

/**
 * An incremental walk, so a store can feed it a page at a time. `feed` returns false at
 * the first break: the caller stops paging. A walk started `from` a seq takes that row's
 * stored prev_hash on trust, since the rows before it are not in hand.
 */
export function chainWalk(anchor: ChainAnchor, from?: number): { feed(rows: ChainRow[]): boolean; result(): AuditVerification } {
  const r: AuditVerification = { ok: true, from_seq: 0, through_seq: 0, checked: 0, unhashed: 0, anchor };
  let prev: string | null = from === undefined ? anchor.hash : null;
  return {
    feed(rows) {
      for (const row of rows) {
        if (r.from_seq === 0) r.from_seq = row.seq;
        r.through_seq = row.seq;
        if (row.hash === null) {
          if (r.checked > 0) { r.ok = false; r.broken_at = row.seq; return false; }
          r.unhashed++;
          continue;
        }
        const expectedPrev = prev ?? row.prevHash ?? "";
        if (row.prevHash !== expectedPrev || row.hash !== chainHash(row.seq, expectedPrev, row.entry)) {
          r.ok = false; r.broken_at = row.seq; r.checked++; return false;
        }
        r.checked++;
        prev = row.hash;
      }
      return true;
    },
    result: () => r,
  };
}

/** D2: rows in seq order; delete through the last one before the first young row. */
export function sweepPlan(rows: { seq: number; at: number; hash: string | null }[], cutoff: number): { through: number; count: number; anchor: ChainAnchor } | null {
  let last: { seq: number; hash: string | null } | null = null;
  let count = 0;
  for (const row of rows) {
    if (row.at >= cutoff) break;
    last = row; count++;
  }
  return last ? { through: last.seq, count, anchor: { seq: last.seq, hash: last.hash ?? "" } } : null;
}

export interface AuditSink {
  url: string;
  secret: string;
  createdAt: number;
  deliveredThrough: number;
  attempts: number;
  failingSince: number | null;
  lastError: string | null;
  dead: boolean;
}

export interface AuditSinkStatus {
  url: string;
  created_at: string;
  delivered_through: number;
  pending: number;
  status: "ok" | "failing" | "dead";
  failing_since: string | null;
  last_error: string | null;
  attempts: number;
}

export interface AuditSettings { retentionDays: number | null; sink: AuditSinkStatus | null }

export function newSink(url: string, now: number, secret: string, deliveredThrough = 0): AuditSink {
  return { url, secret, createdAt: now, deliveredThrough, attempts: 0, failingSince: null, lastError: null, dead: false };
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export function sinkStatus(sink: AuditSink, through: number): AuditSinkStatus {
  return {
    url: sink.url, created_at: iso(sink.createdAt)!, delivered_through: sink.deliveredThrough,
    pending: Math.max(0, through - sink.deliveredThrough),
    status: sink.dead ? "dead" : sink.failingSince !== null ? "failing" : "ok",
    failing_since: iso(sink.failingSince), last_error: sink.lastError, attempts: sink.attempts,
  };
}

export type SinkOutcome = { ok: true; through: number } | { ok: false; error: string };

/** D3: what one delivery attempt leaves behind, and when to try again. */
export function nextSinkState(sink: AuditSink, outcome: SinkOutcome, now: number, more: boolean): { sink: AuditSink; armAt: number | null; died: boolean } {
  if (outcome.ok) return { sink: { ...sink, deliveredThrough: outcome.through, attempts: 0, failingSince: null, lastError: null }, armAt: more ? now : null, died: false };
  const attempts = sink.attempts + 1;
  const failingSince = sink.failingSince ?? now;
  if (now - failingSince >= SINK_DEAD_AFTER_MS) return { sink: { ...sink, attempts, failingSince, lastError: outcome.error, dead: true }, armAt: null, died: true };
  return { sink: { ...sink, attempts, failingSince, lastError: outcome.error }, armAt: now + backoffMs(attempts), died: false };
}

export function batchBody(orgId: string, entries: unknown[], first: number, last: number): { delivery: string; body: string } {
  const delivery = `${orgId}:${first}-${last}`;
  return { delivery, body: JSON.stringify({ org_id: orgId, delivery, entries }) };
}

/** The `Bellman-Signature` header: `t=<ms>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`. */
export async function signBatch(secret: string, t: number, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${body}`)));
  return `t=${t},v1=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * One delivery: the batch body signed with the sink's secret, posted with the sink's timeout. `ok`
 * only on a 2xx; a refusal carries its status and a failure its message, so the status page says
 * why. `post` is `fetch`, or what a test hands in.
 */
export async function deliverBatch(post: typeof fetch, sink: AuditSink, orgId: string, entries: AuditEntryView[], now: number): Promise<SinkOutcome> {
  const last = entries.at(-1)!.seq;
  const { delivery, body } = batchBody(orgId, entries, entries[0].seq, last);
  try {
    const res = await post(sink.url, {
      method: "POST", body,
      headers: { "Content-Type": "application/json", "Bellman-Delivery": delivery, "Bellman-Signature": await signBatch(sink.secret, now, body) },
      signal: AbortSignal.timeout(SINK_TIMEOUT_MS),
    });
    return res.ok ? { ok: true, through: last } : { ok: false, error: String(res.status) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The `audit_sink_dead` row's detail (ADR 0033, D3). */
export const deadDetail = (sink: AuditSink) => ({ url: sink.url, failing_since: new Date(sink.failingSince ?? 0).toISOString(), last_error: sink.lastError });

export function retentionDaysOf(value: unknown): number | null | "invalid" {
  if (value === null) return null;
  return Number.isInteger(value) && (value as number) >= RETENTION_FLOOR_DAYS ? (value as number) : "invalid";
}

export function sinkUrlOf(value: unknown): string | "invalid" {
  if (typeof value !== "string") return "invalid";
  try { return new URL(value).protocol === "https:" ? value : "invalid"; } catch { return "invalid"; }
}
