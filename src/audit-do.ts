/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from "cloudflare:workers";
import type { AuditEntry } from "./types.js";
import { AUDIT_COLUMNS, FACET_LIMIT, auditWhere, entryOf, entryView, recordOf, type AuditFacets, type AuditPage, type AuditQuery, type AuditRecord } from "./audit.js";
import { orgEventEntry, type AuditIntent } from "./grant-audit.js";
import { DUE_PREFIX, dueKey, dueNames, earliestDue } from "./outbox.js";
import { SINK_BATCH, SINK_DELAY_MS, SWEEP_BATCH, SWEEP_EVERY_MS, SYSTEM_INTENT, VERIFY_PAGE, chainHash, chainWalk, deadDetail, deliverBatch, NO_ANCHOR, newSink, nextSinkState, sinkStatus, sweepPlan, type AuditSettings, type AuditSink, type AuditSinkStatus, type AuditVerification, type ChainAnchor } from "./audit-sink.js";
import { randomId } from "./oauth/tokens.js";

/** The stream's tables (audit trail spec, D5). `AUTOINCREMENT` never reuses a seq, so a cursor once handed out names one row for good. */
const AUDIT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS entries (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    org_id TEXT,
    session_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    actor_label TEXT,
    actor_org TEXT,
    room_name TEXT,
    parties TEXT,
    crossing TEXT,
    direction TEXT,
    detail TEXT NOT NULL,
    prev_hash TEXT,
    hash TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS entries_at ON entries (at)",
  "CREATE TABLE IF NOT EXISTS delivered (intent_id TEXT PRIMARY KEY, seq INTEGER NOT NULL)",
];

/** The chain anchor a sweep left (ADR 0035, D2): the newest deleted row's seq and hash, so the chain survives the sweep. */
const anchorOf = (storage: DurableObjectStorage): ChainAnchor => storage.kv.get<ChainAnchor>("chain_anchor") ?? NO_ANCHOR;

/**
 * Insert one entry and return its seq: the one given, for a row moved from the KV shape, or the next.
 * An appended row is chained (ADR 0035): prev_hash is the newest row's hash, the sweep's anchor when
 * there is no row, "" when the newest predates the chain, and hash is `chainHash` over the seq the
 * insert gave it. A moved row is left unhashed, as it was.
 */
function insertAuditRow(storage: DurableObjectStorage, e: AuditEntry, seq: number | null = null): number {
  const sql = storage.sql;
  const got = sql.exec<{ seq: number }>(
    `INSERT INTO entries (seq, ${AUDIT_COLUMNS.join(", ")}) VALUES (?, ${AUDIT_COLUMNS.map(() => "?").join(", ")}) RETURNING seq`,
    seq, ...recordOf(e),
  ).one().seq;
  if (seq === null) {
    const newest = sql.exec<{ hash: string | null }>("SELECT hash FROM entries WHERE seq < ? ORDER BY seq DESC LIMIT 1", got).toArray()[0];
    const prev = newest === undefined ? anchorOf(storage).hash : newest.hash ?? "";
    sql.exec("UPDATE entries SET prev_hash = ?, hash = ? WHERE seq = ?", prev, chainHash(got, prev, e), got);
  }
  return got;
}

/** The `settings` row (ADR 0035): the window, in days, or null for none, and the org the stream belongs to. */
interface AuditRetention { retentionDays: number | null; orgId: string }

/** The columns ADR 0035 added, for a table created before them. */
const AUDIT_ADDED_COLUMNS = ["prev_hash", "hash"];

/** How many KV rows the move holds in memory at once, whatever the stream's size. */
const MOVE_BATCH = 500;

/**
 * Every KV row under `prefix`, in key order, handed to `move` and deleted, a batch at a time.
 * Each batch starts after the last key of the one before, so the walk ends however a delete
 * inside the transaction shows to the next list.
 */
export function moveKv<T>(storage: DurableObjectStorage, prefix: string, move: (key: string, value: T) => void): void {
  let after: string | undefined;
  for (;;) {
    const batch = [...storage.kv.list<T>({ prefix, startAfter: after, limit: MOVE_BATCH })];
    if (batch.length === 0) return;
    for (const [key, value] of batch) {
      move(key, value);
      storage.kv.delete(key);
    }
    after = batch.at(-1)![0];
  }
}

/**
 * The tables, and a stream written in the KV shape (`a:<seq>` rows, the `seq` counter,
 * `d:<intent>` markers) moved into them. Run inside one `transactionSync`, so it lands
 * whole or not at all, however many batches it reads.
 *
 * Into an empty table each row keeps the seq its key carries, so every cursor already handed
 * out still names its row. Once the table holds rows, what is in KV was written there by an
 * older Worker after a rollback: it read the deleted `seq` counter as 0 and counted again
 * from 1, so its keys would collide with rows that exist. Those are appended in key order
 * with the next seqs instead, so nothing collides and nothing is lost, and a stream moved
 * once and then written to by an older Worker still wakes. Which of the two applies is decided
 * once, before the first batch: after that batch the table is never empty.
 * ponytail: memory is flat, MOVE_BATCH rows at a time. Time is the ceiling left: blockConcurrencyWhile
 * allows 30 s, about two million rows at the 15 µs a row measured locally. Past that, move it across wakes.
 */
function migrateAudit(storage: DurableObjectStorage): void {
  for (const ddl of AUDIT_SCHEMA) storage.sql.exec(ddl);
  const have = new Set(storage.sql.exec<{ name: string }>("PRAGMA table_info(entries)").toArray().map((c) => c.name));
  for (const col of AUDIT_ADDED_COLUMNS) if (!have.has(col)) storage.sql.exec(`ALTER TABLE entries ADD COLUMN ${col} TEXT`);
  const keepKeySeqs = storage.sql.exec("SELECT 1 FROM entries LIMIT 1").toArray().length === 0;
  moveKv<AuditEntry>(storage, "a:", (key, entry) => insertAuditRow(storage, entry, keepKeySeqs ? Number(key.slice(2)) : null));
  // After a rollback a mark keeps the older build's KV seq, not its row's: informational, dedupe reads intent_id.
  moveKv<number>(storage, "d:", (key, seq) => {
    storage.sql.exec("INSERT OR IGNORE INTO delivered (intent_id, seq) VALUES (?, ?)", key.slice(2), seq);
  });
  storage.kv.delete("seq");
}

export class AuditDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    // Before any call is let in: the tables, and a stream still in the KV shape moved into them.
    void this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.transactionSync(() => migrateAudit(this.ctx.storage));
    });
  }

  /**
   * Append an audit entry, at most once per intent.
   *
   * The outbox that feeds this delivers at least once: a row is deleted only after this
   * call returns, so an acknowledgement lost in flight redelivers. The `delivered` row is
   * what makes that safe. The look at it, the entry and the marker are one synchronous
   * transaction, so no second delivery can come between the look and the writes, and a
   * throw anywhere in it rolls all of it back: an audit log that could drop or double the
   * record of a privilege change would not be one. Callers with no intent to redeliver pass
   * no id and always append.
   */
  async append(entry: AuditEntry, intentId?: string): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      if (intentId !== undefined && sql.exec("SELECT 1 FROM delivered WHERE intent_id = ?", intentId).toArray().length > 0) {
        return;
      }
      const seq = insertAuditRow(this.ctx.storage, entry);
      if (intentId !== undefined) sql.exec("INSERT INTO delivered (intent_id, seq) VALUES (?, ?)", intentId, seq);
    });
    if (this.#armSink(Date.now())) await this.#reArm();
  }

  /** D3: a live sink with no delivery due gets one `SINK_DELAY_MS` out, so a burst of rows goes as one batch. */
  #armSink(now: number): boolean {
    const kv = this.ctx.storage.kv;
    const sink = kv.get<AuditSink>("sink");
    if (!sink || sink.dead || kv.get<number>(dueKey("sink")) !== undefined) return false;
    this.#arm("sink", now + SINK_DELAY_MS);
    return true;
  }

  async setSink(orgId: string, url: string, intent: AuditIntent, now: number): Promise<{ sink: AuditSinkStatus; secret: string }> {
    const kv = this.ctx.storage.kv;
    const secret = randomId(32);
    this.ctx.storage.transactionSync(() => {
      kv.put<AuditSink>("sink", newSink(url, now, secret, kv.get<AuditSink>("sink")?.deliveredThrough ?? 0));
      insertAuditRow(this.ctx.storage, orgEventEntry(orgId, "audit_sink_set", { url }, intent, now));
    });
    this.#armSink(now);
    await this.#reArm();
    return { sink: (await this.settings()).sink!, secret };
  }

  async removeSink(orgId: string, intent: AuditIntent, now: number): Promise<boolean> {
    const kv = this.ctx.storage.kv;
    const sink = kv.get<AuditSink>("sink");
    if (!sink) return false;
    this.ctx.storage.transactionSync(() => {
      kv.delete("sink");
      this.#disarm("sink");
      insertAuditRow(this.ctx.storage, orgEventEntry(orgId, "audit_sink_removed", { url: sink.url }, intent, now));
    });
    await this.#reArm();
    return true;
  }

  async resumeSink(orgId: string, intent: AuditIntent, now: number): Promise<AuditSinkStatus | undefined> {
    const kv = this.ctx.storage.kv;
    const sink = kv.get<AuditSink>("sink");
    if (!sink) return undefined;
    this.ctx.storage.transactionSync(() => {
      kv.put<AuditSink>("sink", { ...sink, attempts: 0, failingSince: null, lastError: null, dead: false });
      insertAuditRow(this.ctx.storage, orgEventEntry(orgId, "audit_sink_resumed", { url: sink.url, delivered_through: sink.deliveredThrough }, intent, now));
    });
    this.#arm("sink", now);
    await this.#reArm();
    return (await this.settings()).sink!;
  }

  /**
   * D3: one batch past the cursor, posted, and the state the outcome leaves; the next attempt armed
   * from it. The org's id is read off the rows: a Durable Object cannot read its own name.
   * ponytail: the alarm and a manual pump can overlap on one object; the second posts a batch the
   * first may also deliver, which the receiver dedupes on `Bellman-Delivery`.
   */
  async pump(now: number): Promise<AuditSinkStatus | undefined> {
    const kv = this.ctx.storage.kv;
    const sink = kv.get<AuditSink>("sink");
    if (!sink) return undefined;
    const rows = sink.dead ? [] : this.ctx.storage.sql.exec<AuditRecord>("SELECT * FROM entries WHERE seq > ? ORDER BY seq LIMIT ?", sink.deliveredThrough, SINK_BATCH).toArray().map(entryOf);
    if (rows.length === 0) return sinkStatus(sink, this.#newestSeq());
    const orgId = rows[0].orgId as string;
    const outcome = await deliverBatch(fetch, sink, orgId, rows.map(entryView), now);
    // Removed or replaced while the post was in flight (the input gate opens across an awaited fetch): the
    // outcome belongs to a sink that is gone, and whoever replaced it armed the next attempt.
    const live = kv.get<AuditSink>("sink");
    if (live?.secret !== sink.secret) return live ? sinkStatus(live, this.#newestSeq()) : undefined;
    // Rows appended while the post was in flight are pending too: one more pass, not a wait for the next append.
    const next = nextSinkState(sink, outcome, now, rows.length === SINK_BATCH || this.#newestSeq() > rows.at(-1)!.seq);
    kv.put<AuditSink>("sink", next.sink);
    if (next.armAt === null) this.#disarm("sink"); else this.#arm("sink", next.armAt);
    if (next.died) await this.append(orgEventEntry(orgId, "audit_sink_dead", deadDetail(next.sink), SYSTEM_INTENT, now));
    await this.#reArm();
    return sinkStatus(next.sink, this.#newestSeq());
  }

  /** The newest `limit` entries, oldest first: `bellman_audit`'s read, without the stream's seq and chain. */
  async recent(limit: number): Promise<AuditEntry[]> {
    return this.ctx.storage.sql
      .exec<AuditRecord>("SELECT * FROM entries ORDER BY seq DESC LIMIT ?", limit)
      .toArray()
      .reverse()
      .map(entryOf)
      .map(({ seq: _seq, hash: _hash, prevHash: _prev, ...entry }) => entry);
  }

  /** One page under the filters, newest first (D6): the same answer `pageOf` gives over memory. */
  async query(q: AuditQuery): Promise<AuditPage> {
    const sql = this.ctx.storage.sql;
    const through = q.through ?? sql.exec<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM entries").one().seq;
    const page = auditWhere(q, through, { scope: true, before: true });
    const rows = sql.exec<AuditRecord>(
      `SELECT * FROM entries ${page.clause} ORDER BY seq DESC LIMIT ?`, ...page.params, q.limit + 1,
    ).toArray();
    const all = auditWhere(q, through, { scope: true, before: false });
    const total = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM entries ${all.clause}`, ...all.params).one().n;
    let unrecorded = 0;
    // A row from before D2 records no crossing and no parties, so neither filter can judge it (D4).
    if (q.scope !== undefined || q.org !== undefined) {
      const rest = auditWhere({ ...q, org: undefined }, through, { scope: false, before: false });
      unrecorded = sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM entries ${rest.clause ? `${rest.clause} AND` : "WHERE"} crossing IS NULL`, ...rest.params,
      ).one().n;
    }
    const entries = rows.slice(0, q.limit).map(entryOf);
    return { entries, next: rows.length > q.limit ? entries.at(-1)!.seq : null, through, total, unrecorded };
  }

  /** Walks the chain a page at a time from the anchor a sweep left (ADR 0035), or from `from`. */
  async verify(from?: number): Promise<AuditVerification> {
    const walk = chainWalk(anchorOf(this.ctx.storage), from);
    let next = from ?? 0;
    for (;;) {
      const rows = this.ctx.storage.sql.exec<AuditRecord>("SELECT * FROM entries WHERE seq >= ? ORDER BY seq LIMIT ?", next, VERIFY_PAGE).toArray();
      const fed = walk.feed(rows.map((r) => { const { seq, hash, prevHash, ...entry } = entryOf(r); return { seq, hash, prevHash, entry }; }));
      if (!fed || rows.length < VERIFY_PAGE) return walk.result();
      next = rows.at(-1)!.seq + 1;
    }
  }

  /** The org's window and sink (ADR 0035), both unset until an admin sets them. */
  async settings(): Promise<AuditSettings> {
    const kv = this.ctx.storage.kv;
    const sink = kv.get<AuditSink>("sink") ?? null;
    return { retentionDays: kv.get<AuditRetention>("settings")?.retentionDays ?? null, sink: sink && sinkStatus(sink, this.#newestSeq()) };
  }

  #newestSeq(): number {
    return this.ctx.storage.sql.exec<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM entries").one().seq ?? 0;
  }

  /**
   * D2: the window and its audit row in one transaction, then the sweep armed for now or disarmed.
   * The org's id is kept beside the window: a Durable Object cannot read its own name, and the alarm
   * has no caller to tell it.
   */
  async setRetention(orgId: string, days: number | null, intent: AuditIntent, now: number): Promise<AuditSettings> {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.put<AuditRetention>("settings", { retentionDays: days, orgId });
      insertAuditRow(this.ctx.storage, orgEventEntry(orgId, "audit_retention_set", { days }, intent, now));
    });
    if (days === null) this.#disarm("sweep"); else this.#arm("sweep", now);
    await this.#reArm();
    return this.settings();
  }

  /**
   * D2: delete the rows past the window in seq order, a batch at a time, each batch one transaction that
   * moves the anchor with it, so a sweep cut short leaves a chain that still verifies. One `audit_swept`
   * row after the loop, by the system, chained from the anchor when it emptied the table.
   */
  async sweep(now: number): Promise<number> {
    const storage = this.ctx.storage;
    const settings = storage.kv.get<AuditRetention>("settings");
    if (!settings || settings.retentionDays === null) return 0;
    const cutoff = now - settings.retentionDays * 86_400_000;
    // Armed before the first delete: the alarm disarmed `due:sweep` to call this, and a sweep that
    // throws part way must not be the last one the org ever gets.
    this.#arm("sweep", now + SWEEP_EVERY_MS);
    let through = 0, count = 0;
    for (;;) {
      const rows = storage.sql.exec<{ seq: number; at: number; hash: string | null }>("SELECT seq, at, hash FROM entries ORDER BY seq LIMIT ?", SWEEP_BATCH).toArray();
      const plan = sweepPlan(rows, cutoff);
      if (!plan) break;
      storage.transactionSync(() => {
        storage.sql.exec("DELETE FROM entries WHERE seq <= ?", plan.through);
        storage.sql.exec("DELETE FROM delivered WHERE seq <= ?", plan.through);
        storage.kv.put<ChainAnchor>("chain_anchor", plan.anchor);
      });
      through = plan.through; count += plan.count;
      if (plan.count < rows.length || rows.length < SWEEP_BATCH) break;
    }
    if (count > 0) await this.append(orgEventEntry(settings.orgId, "audit_swept", { through_seq: through, count }, SYSTEM_INTENT, now));
    return count;
  }

  #arm(name: string, at: number): void { this.ctx.storage.kv.put(dueKey(name), at); }
  #disarm(name: string): void { this.ctx.storage.kv.delete(dueKey(name)); }

  /** One alarm per object, pointed at the earliest `due:` row, or none (the outbox's pattern). */
  async #reArm(): Promise<void> {
    const at = earliestDue([...this.ctx.storage.kv.list<number>({ prefix: DUE_PREFIX })].map(([, at]) => at));
    if (at === null) await this.ctx.storage.deleteAlarm(); else await this.ctx.storage.setAlarm(at);
  }

  /** RegistryDO's loop: every due name, consumed before it runs, then the alarm pointed at what is still due. */
  async alarm(): Promise<void> {
    const now = Date.now();
    const due = new Map([...this.ctx.storage.kv.list<number>({ prefix: DUE_PREFIX })].map(([k, at]) => [k.slice(DUE_PREFIX.length), at]));
    for (const name of dueNames(due, now)) {
      this.#disarm(name);
      try {
        if (name === "sweep") await this.sweep(now);
        else if (name === "sink") await this.pump(now);
      } catch (error) {
        console.error(`alarm handler "${name}" failed for the audit stream:`, error);
        throw error;
      }
    }
    await this.#reArm();
  }

  /**
   * What the filters offer (D6), newest first. A label or a room's name comes from its newest
   * row: SQLite reads a bare column of a MAX() group from the row that holds the max.
   * ponytail: `at` is the only index; these and the filters on actor, room and action read the
   * table by seq, and gain indexes when a stream is large enough to feel the scan.
   */
  async facets(): Promise<AuditFacets> {
    const sql = this.ctx.storage.sql;
    return {
      actors: sql.exec<{ id: string; label: string | null; newest: number }>(
        "SELECT actor_id AS id, actor_label AS label, MAX(seq) AS newest FROM entries GROUP BY actor_id ORDER BY newest DESC LIMIT ?",
        FACET_LIMIT,
      ).toArray().map(({ id, label }) => ({ id, label })),
      rooms: sql.exec<{ id: string; name: string | null; newest: number }>(
        "SELECT session_id AS id, room_name AS name, MAX(seq) AS newest FROM entries WHERE session_id NOT LIKE 'grant:%' GROUP BY session_id ORDER BY newest DESC LIMIT ?",
        FACET_LIMIT,
      ).toArray().map(({ id, name }) => ({ id, name })),
      orgs: sql.exec<{ org: string; newest: number }>(
        "SELECT p.value AS org, MAX(e.seq) AS newest FROM entries e, json_each(e.parties) p WHERE p.value IS NOT NULL AND p.value != e.org_id GROUP BY p.value ORDER BY newest DESC, org ASC LIMIT ?",
        FACET_LIMIT,
      ).toArray().map(({ org }) => org),
      actions: sql.exec<{ action: string; newest: number }>(
        "SELECT action, MAX(seq) AS newest FROM entries GROUP BY action ORDER BY newest DESC LIMIT ?",
        FACET_LIMIT,
      ).toArray().map(({ action }) => action),
    };
  }
}
