/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from "cloudflare:workers";
import { allKeysFor, declineKey, declinesPrefix, domainKey, grantKey, idpKey, inviteKeysFor, keyInvitesPrefix, NO_ORG, orgIndexKey, orgIndexPrefix, orgInvitesPrefix, orgKey, scimKeyIndex, scimNameKey, scimTokenIndex, scimTokenKey, scimUserKey, scimUserPrefix, staleIndexKeys } from "../storage/grant-index.js";
import { INVITE_TTL_MS, MAX_PENDING_INVITES, inviteLive, isUnownedSeat, liftInvite, liftOrg, scimSeatKey, takesUnownedSeat, inviteMailDay } from "../orgs.js";
import { isBanId, oldestFirst, type CreatorBan } from "../bans.js";
import type { Suspension } from "../suspension.js";
import { firstSignInFirst, patchedOrg, purchasedOrg, sameEntry, scimGrant, type ScimCreate, type ScimUpdate } from "../storage/store.js";
import type { GrantDelete, GrantWrite, HostedSlot, PublicNameEntry } from "../storage/store.js";
import type { AuditEntry, PendingConnect, PlanGrant, SavedPreset, UserRecord, Org, OrgIdp, OrgInvite, OrgPatch, ScimToken, ScimUser, ScimUserPatch, DirectoryEntry } from "../types.js";
import type { RoomCounts, RoomFilter, RoomIndexRow } from "../storage/store.js";
import { KEYS_PER_CALL, getRows } from "../storage/member-rows.js";
import { grantAuditEntries, orgAuditEntries, orgEventEntry, revokeAuditEntries, scimUserEntry, takenSeatAuditEntries, type AuditIntent } from "../grant-audit.js";
import { OUTBOX_HANDLER, OutboxDriver, dueKey, type OutboxIntent, type OutboxRow } from "../storage/outbox.js";
import { REPORT_PURGE_HANDLER, REPORT_RETENTION_MS, REPORT_WINDOW_MS, REPORTS_PER_DAY, reachesCreator, reportId, targetKey, withinWindow, type FiledReport, type NewReport, type Report } from "../reports.js";
import { presetInNewWords } from "../presets.js";
import type { BellmanEnv } from "./store-do.js";
import { auditIntent } from "./session-do.js";
import { moveKv } from "./audit-do.js";

/**
 * The org index's prefix, `uo:<org>:` (#65, D5). The org segment is percent-encoded, so an org id
 * that spells the separator cannot make one org's prefix reach another's rows. Org ids are
 * `[A-Za-z0-9_-]` where grants are written (isOrgId), but an identity's org can come from a key
 * map nobody validated, and grant-index.ts makes the same argument at more length.
 */
const orgRoomPrefix = (orgId: string): string => `uo:${encodeURIComponent(orgId)}:`;
/**
 * The operator's index of every room (#471, dash#94): one row a room, the fields of its `RoomIndexRow`, fixed at
 * the create. A close keeps it, the purge deletes it. No org is NULL; `NO_ORG` exists only past the HTTP layer.
 */
const ROOMS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS rooms (
    session_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    org_id TEXT,
    preset TEXT,
    mode TEXT NOT NULL,
    public INTEGER NOT NULL,
    hosted INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS rooms_newest ON rooms (created_at DESC, session_id DESC)",
  "CREATE INDEX IF NOT EXISTS rooms_by_owner ON rooms (created_by, created_at DESC, session_id DESC)",
  "CREATE INDEX IF NOT EXISTS rooms_by_org ON rooms (org_id, created_at DESC, session_id DESC)",
];

interface RoomSqlRow extends Record<string, SqlStorageValue> {
  session_id: string; created_at: number; created_by: string; org_id: string | null;
  preset: string | null; mode: string; public: number; hosted: number;
}

/** SQLite has no boolean: `public` and `hosted` go in as 1/0 and come back as booleans. */
function insertRoom(sql: SqlStorage, r: RoomIndexRow): void {
  sql.exec(
    "INSERT OR IGNORE INTO rooms (session_id, created_at, created_by, org_id, preset, mode, public, hosted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    r.sessionId, r.createdAt, r.createdBy, r.orgId, r.preset, r.mode, r.public ? 1 : 0, r.hosted ? 1 : 0,
  );
}

const roomOfSql = (r: RoomSqlRow): RoomIndexRow => ({
  sessionId: r.session_id, createdAt: r.created_at, createdBy: r.created_by, orgId: r.org_id,
  preset: r.preset as RoomIndexRow["preset"], mode: r.mode as RoomIndexRow["mode"], public: r.public === 1, hosted: r.hosted === 1,
});

/**
 * One page of `rooms`, newest first: a `WHERE` built from only the filters given, so SQLite plans each shape on its
 * own index (`rooms_by_owner`, `rooms_by_org`), which a fixed `(? IS NULL OR col = ?)` form never could. Exported
 * so the query-plan test runs exactly what the store runs.
 */
export function roomsPageQuery(
  limit: number, startAfter: Pick<RoomIndexRow, "createdAt" | "sessionId"> | undefined, f: RoomFilter,
): { sql: string; bindings: SqlStorageValue[] } {
  const where: string[] = [];
  const bindings: SqlStorageValue[] = [];
  if (f.createdBy !== undefined) { where.push("created_by = ?"); bindings.push(f.createdBy); }
  if (f.org === null) where.push("org_id IS NULL");
  else if (f.org !== undefined) { where.push("org_id = ?"); bindings.push(f.org); }
  if (f.hosted !== undefined) { where.push("hosted = ?"); bindings.push(f.hosted ? 1 : 0); }
  if (f.publicTrue) where.push("public = 1");
  if (startAfter) { where.push("(created_at, session_id) < (?, ?)"); bindings.push(startAfter.createdAt, startAfter.sessionId); }
  return {
    sql: `SELECT * FROM rooms${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, session_id DESC LIMIT ?`,
    bindings: [...bindings, limit],
  };
}
/** One definition of "expired", so every path agrees on what a grant is. */
/** One record per person, and the count beside them (#258). */
const userKey = (userId: string): string => `us:${userId}`;
const USER_COUNT = "us:count";

/**
 * `cb:<creator>:<user>` is an account a creator banned from every room they own (abuse protections spec,
 * section 1), one row each, so a seating asks one `get`. Both segments are percent-encoded, so the colon
 * between them is the only one in a key. An operator-issued user id may hold a colon, and unencoded,
 * `cb:u_x:` would begin the rows of a creator named `u_x:y`.
 */
const creatorBanPrefix = (creatorId: string): string => `cb:${encodeURIComponent(creatorId)}:`;
const creatorBanKey = (creatorId: string, userId: string): string =>
  `${creatorBanPrefix(creatorId)}${encodeURIComponent(userId)}`;

/** `su:<user>` is a suspended account (abuse protections spec, section 1), its id percent-encoded as `cb:`'s are. */
const suspensionKey = (userId: string): string => `su:${encodeURIComponent(userId)}`;

/**
 * Reports (abuse protections spec, section 3) are six kinds of row and a due row, all in the registry:
 * - `rp:<id>` is the report. An id sorts in filing order, so a listing of the prefix is the queue.
 * - `ro:<id>` holds the id of a report while it is open: written when it is filed, deleted when it is resolved. The
 *   operator's queue lists open reports first, and this is how it reads them without reading every report there is.
 * - `rf:<reporter>:<sessionId>:<targetKey>` holds the id of the open report that account filed about that target:
 *   what a repeat folds into (R9). Resolving the report deletes it.
 * - `rl:<reporter>` holds the times of the account's filings still inside the day (R10), a `number[]`. It only serves
 *   that limit, so the purge deletes it once its newest time has left the day.
 * - `rc:<creator>:<sessionId>:<id>` holds the id of a report that reaches the creator (`reachesCreator`: about a member
 *   or a message, and not about the creator's own account), so a creator's view of one room is a listing of a prefix.
 * - `rr:<purgeAt>:<id>` holds the id of a resolved report, dated for its deletion, the time padded to 15 digits so
 *   string order is time order. `due:report_purge` is the earliest of those dates.
 * The reporter and the creator are percent-encoded, as `cb:`'s segments are: an operator-issued user id may hold a
 * colon, and unencoded one account's prefix would cover the rows of another whose id extends it.
 */
const REPORT_PREFIX = "rp:";
const reportKey = (id: string): string => `${REPORT_PREFIX}${id}`;
const reportFoldKey = (reporterId: string, sessionId: string, target: string): string =>
  `rf:${encodeURIComponent(reporterId)}:${sessionId}:${target}`;
const REPORT_OPEN_PREFIX = "ro:";
const reportOpenKey = (id: string): string => `${REPORT_OPEN_PREFIX}${id}`;
const REPORT_TIMES_PREFIX = "rl:";
const reportTimesKey = (reporterId: string): string => `${REPORT_TIMES_PREFIX}${encodeURIComponent(reporterId)}`;
const reportCreatorPrefix = (creatorId: string, sessionId: string): string =>
  `rc:${encodeURIComponent(creatorId)}:${sessionId}:`;
const reportCreatorKey = (creatorId: string, sessionId: string, id: string): string =>
  `${reportCreatorPrefix(creatorId, sessionId)}${id}`;
const REPORT_PURGE_PREFIX = "rr:";
const reportPurgeAt = (at: number): string => `${REPORT_PURGE_PREFIX}${String(at).padStart(15, "0")}`;
const reportPurgeKey = (purgeAt: number, id: string): string => `${reportPurgeAt(purgeAt)}:${id}`;
/** The date a `rr:` key is for. */
const purgeAtOf = (key: string): number =>
  Number(key.slice(REPORT_PURGE_PREFIX.length, REPORT_PURGE_PREFIX.length + 15));

export const lapsed = (grant: PlanGrant, now = Date.now()): boolean =>
  grant.expiresAt !== null && now > grant.expiresAt;

export class RegistryDO extends DurableObject<BellmanEnv> {
  /**
   * The queue of audit entries this object owes the per-org streams.
   *
   * A grant change is committed here and the record of it is filed in another
   * object, so the two cannot share a transaction. The entry is queued in the
   * grant's own transaction instead and delivered after it: inline when the write
   * returns, by the alarm if the isolate went away first.
   */
  private driver = new OutboxDriver(this.ctx.storage, (row) => this.#deliver(row));

  constructor(ctx: DurableObjectState, env: BellmanEnv) {
    super(ctx, env);
    // Before any call is let in: the `rooms` table, and an index still in the KV shape moved into it.
    void this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.transactionSync(() => migrateRoomIndex(this.ctx.storage));
    });
  }

  async putJoinCode(code: string, sessionId: string): Promise<void> {
    await this.ctx.storage.put(`jc:${code}`, sessionId);
  }

  async lookupJoinCode(code: string): Promise<string | undefined> {
    return this.ctx.storage.get<string>(`jc:${code}`);
  }

  async dropJoinCode(code: string): Promise<void> {
    await this.ctx.storage.delete(`jc:${code}`);
  }

  async lookupPublicName(name: string): Promise<PublicNameEntry | undefined> {
    return this.ctx.storage.get<PublicNameEntry>(`pn:${name}`);
  }

  /** `BellmanStore.publicNameEntries`: the index's first `limit` rows, in key order, which is name order. */
  async listPublicNames(limit: number): Promise<{ name: string; entry: PublicNameEntry }[]> {
    const rows = await this.ctx.storage.list<PublicNameEntry>({ prefix: "pn:", limit });
    return [...rows].map(([key, entry]) => ({ name: key.slice("pn:".length), entry }));
  }

  /** `BellmanStore.claimPublicName`, in one transaction (public names spec, D5). */
  async claimPublicName(name: string, entry: PublicNameEntry, expected: PublicNameEntry | null): Promise<boolean> {
    return this.ctx.storage.transaction(async (txn) => {
      if (!sameEntry((await txn.get<PublicNameEntry>(`pn:${name}`)) ?? null, expected)) return false;
      await txn.put(`pn:${name}`, entry);
      return true;
    });
  }

  /** `BellmanStore.releasePublicName`, in one transaction. */
  async releasePublicName(name: string, expected: PublicNameEntry): Promise<boolean> {
    return this.ctx.storage.transaction(async (txn) => {
      if (!sameEntry((await txn.get<PublicNameEntry>(`pn:${name}`)) ?? null, expected)) return false;
      await txn.delete(`pn:${name}`);
      return true;
    });
  }

  async putPendingConnect(p: PendingConnect): Promise<void> {
    await this.ctx.storage.put(`pc:${p.token}`, p);
  }

  /** Single use, and expiry is checked on read rather than swept. */
  async takePendingConnect(token: string): Promise<PendingConnect | undefined> {
    const key = `pc:${token}`;
    const p = await this.ctx.storage.get<PendingConnect>(key);
    if (!p) return undefined;
    await this.ctx.storage.delete(key);
    if (Date.now() > p.expiresAt) return undefined;
    return p;
  }

  /**
   * Every grant is written twice: `gr:<key>` is the record, `go:<org>:<key>` an
   * org-scoped copy. A scoped listing then scans one org's range with the limit
   * pushed into storage, rather than reading every grant on the platform to
   * throw most of them away — which on this singleton object is O(all
   * customers) per admin request, and gets worse with every sale.
   *
   * The price is that the two move together. putGrant retires the old org's
   * copy before writing the new one, and both deletes drop both copies, or a
   * re-homed key would stay listed under the org it left. The key layout and
   * that rule live in grant-index.ts, which the test suite can reach; this
   * object's own wiring is covered once #12 runs the contract suite here.
   */
  async putGrant(grant: PlanGrant): Promise<void> {
    // One transaction, because the two copies must not be observable apart. A
    // re-home is delete-then-write: interrupted between them it would drop the
    // old org's entry without installing the new one, and the grant would stop
    // appearing in any listing while still resolving by key.
    await this.ctx.storage.transaction(async (txn) => {
      const previous = await txn.get<PlanGrant>(grantKey(grant.key));
      for (const stale of staleIndexKeys(previous, grant)) {
        await txn.delete(stale);
      }
      await txn.put(grantKey(grant.key), grant);
      await txn.put(orgIndexKey(grant.orgId, grant.key), grant);
    });
  }

  async getGrant(key: string): Promise<PlanGrant | undefined> {
    const grant = await this.ctx.storage.get<PlanGrant>(grantKey(key));
    if (!grant) return undefined;
    // A lapsed grant is not a grant. Deleting here keeps reads self-healing.
    if (lapsed(grant)) {
      await this.#dropGrant(grant);
      return undefined;
    }
    return grant;
  }

  async deleteGrant(key: string): Promise<void> {
    const existing = await this.ctx.storage.get<PlanGrant>(grantKey(key));
    if (!existing) return;
    await this.#dropGrant(existing);
  }

  /**
   * One audit entry, into its org's stream.
   *
   * The row id goes along as the intent id, so an entry that landed but whose
   * acknowledgement was lost is applied once when the queue retries it.
   *
   * This and the other methods below named with a `#` are JS-private, on purpose.
   * TypeScript's `private` is erased at compile time, and a Durable Object answers
   * RPC for every method on its class, so a `private` one can be called by anything
   * holding the REGISTRY binding. These do what no caller should be able to ask for
   * directly: file an entry in any org's stream, or commit a grant change and leave
   * its entry undelivered.
   */
  async #deliver(row: OutboxRow): Promise<void> {
    if (row.kind !== "audit") throw new Error(`outbox: unknown kind ${row.kind}`);
    const entry = row.payload as AuditEntry;
    // Falsy, not `=== null`: a namespace accepts "" and undefined as names, so a
    // malformed entry would be delivered into a stream no org reads rather than
    // failing. grantAuditEntries already refuses to build one; this is the second
    // defence, for the same reason grant-index.ts keeps two for the org id.
    if (!entry.orgId) return; // no stream to deliver it to; drop the row
    await this.env.AUDIT.get(this.env.AUDIT.idFromName(entry.orgId)).append(entry, row.id);
  }

  /** Each entry becomes one queued intent, with an id the stream can dedupe on. */
  #auditIntents(entries: AuditEntry[]): OutboxIntent[] {
    return entries.map(auditIntent);
  }

  /**
   * The backstop for the inline delivery, and the deletion of resolved reports.
   *
   * The outbox's: it fires after OUTBOX_GRACE_MS, finds an empty queue and does nothing, unless the inline attempt
   * never ran or is still waiting on an audit object that has stopped answering.
   *
   * `report_purge` (R15) is the other name a `due:` row carries here. Every name the driver can report needs a
   * branch below: a name with none is never consumed, and the closing reArm() points the alarm straight back at
   * its due time, so the alarm fires back to back for good. `now` is read once, as SessionDO.alarm reads it, so the
   * handlers due and the reports purged are judged on one clock. A handler that throws is logged by name and
   * rethrown, as SessionDO.alarm does, so the runtime retries and one line says which handler failed.
   *
   * The closing reArm() is the safety net SessionDO.alarm has too: a fired alarm is
   * consumed, so whatever is still due must have one scheduled before this returns.
   * The drain re-arms for itself after a failed delivery, so for the outbox this covers a path
   * that returns without having done so; nothing reaches it today. For reports it is the one
   * arming: `#purgeReports` leaves the next date in the due row, and this points the alarm at it.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    for (const name of await this.driver.dueNow(now)) {
      try {
        if (name === OUTBOX_HANDLER) await this.driver.deliverNow();
        if (name === REPORT_PURGE_HANDLER) await this.#purgeReports(now);
      } catch (error) {
        // The runtime retries a throwing alarm a few times and then leaves it with nothing armed (the next
        // `resolveReport`, or the next intent queued, arms it again), and it says nothing of which handler it gave up
        // on. This line is the one record. Rethrown, so the runtime still retries, as SessionDO.alarm does.
        console.error(`alarm handler "${name}" failed for the registry:`, error);
        throw error;
      }
    }
    await this.driver.reArm();
  }

  /**
   * `report_purge` (R15): in one transaction, delete every resolved report whose 180 days are up, with its creator
   * row and its `rr:` row, and every reporter's filing-times row whose times have all left the day, then point the
   * due row at the next `rr:` row, or delete it when none is left. Without that last step the name stays due and the
   * alarm fires back to back. The reports are listed up to `now` and not the whole prefix, because the prefix holds
   * every report resolved in the last 180 days and a firing needs the due ones.
   *
   * `#private`, for the reason `#deliver` gives: it deletes reports, and a method on a Durable Object's class is
   * reachable by anything holding the REGISTRY binding.
   *
   * ponytail: every report due is deleted in this one transaction, so a backlog is one large firing. Bound it per
   * firing if one ever gets that large: the due row would stay due, and the next firing would finish the rest.
   */
  async #purgeReports(now: number): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const due = await txn.list<string>({ prefix: REPORT_PURGE_PREFIX, end: reportPurgeAt(now + 1) });
      const reports = await getRows<Report>(txn, [...due.values()].map(reportKey));
      const keys = [...due.keys()];
      for (const id of due.values()) {
        const report = reports.get(reportKey(id));
        if (report === undefined) continue;
        keys.push(reportKey(id));
        if (report.target.kind !== "room") keys.push(reportCreatorKey(report.creatorId, report.sessionId, id));
      }
      // A reporter's filing times only serve the day's limit (R10), so a row whose times have all left the day goes too,
      // and an account is not kept for good. Listed whole: the rows are those of whoever filed in the last day, and of
      // whoever filed since the last purge.
      for (const [key, times] of await txn.list<number[]>({ prefix: REPORT_TIMES_PREFIX })) {
        if (withinWindow(times, now).length === 0) keys.push(key);
      }
      // A delete takes at most KEYS_PER_CALL keys.
      for (let i = 0; i < keys.length; i += KEYS_PER_CALL) await txn.delete(keys.slice(i, i + KEYS_PER_CALL));
      const [next] = await txn.list<string>({ prefix: REPORT_PURGE_PREFIX, limit: 1 });
      if (next) await txn.put(dueKey(REPORT_PURGE_HANDLER), purgeAtOf(next[0]));
      else await txn.delete(dueKey(REPORT_PURGE_HANDLER));
    });
  }

  /**
   * The transaction half of putGrantIfOwned: check, write, and queue the record of
   * it. The other three guarded writes below have the same two halves.
   *
   * Nothing that awaits another object runs inside a transaction closure. Every
   * other call to this object waits until the closure commits, so a delivery in
   * there would hold the registry for as long as the audit object takes to answer.
   * The closure queues; the wrapper delivers once it has committed.
   */
  async #putGrantIfOwnedTxn(
    grant: PlanGrant,
    expectedOrgId: string | null,
    audit: AuditIntent
  ): Promise<"written" | "conflict" | "full"> {
    return this.ctx.storage.transaction(async (txn) => {
      const stored = await txn.get<PlanGrant>(grantKey(grant.key));
      // A lapsed grant is not a grant — the same rule getGrant applies. Letting
      // an expired record from another org answer this check would block the
      // key indefinitely, because nothing sweeps it until someone reads it.
      const previous = stored && !lapsed(stored) ? stored : undefined;
      const orgOf = async (orgId: string | null) => (orgId === null ? undefined : txn.get<Org>(orgKey(orgId)));
      // An unowned seat elsewhere holds nothing (ADR 0027): the org that owns the address by its form takes the key.
      const taken = previous !== undefined && previous.orgId !== expectedOrgId
        && takesUnownedSeat(previous, await orgOf(previous.orgId), grant, await orgOf(grant.orgId));
      if (previous && previous.orgId !== expectedOrgId && !taken) return "conflict" as const;
      // The org whose IdP pushed the seat it took keeps no hold on the key: a claim does not carry its user along.
      if (taken && (await txn.get<{ orgId: string }>(scimKeyIndex(grant.key)))?.orgId === previous.orgId) await txn.delete(scimKeyIndex(grant.key));
      // The seat cap (orgs spec, D3), decided in the transaction that seats: an org with a
      // record holds as many grants as it bought, a key already in this org changes role for
      // no seat, and an org that is only a string in grants has no record and no cap.
      if (grant.orgId !== null && !(previous && previous.orgId === grant.orgId)) {
        const org = await txn.get<Org>(orgKey(grant.orgId));
        if (org && (await this.#countMembers(txn, grant.orgId, Date.now())) >= org.seats) return "full" as const;
      }
      // The stale entry to clear is the one actually in storage, expired or not.
      for (const stale of staleIndexKeys(stored, grant)) await txn.delete(stale);
      const rows = await this.driver.enqueue(
        txn, this.#auditIntents(taken ? takenSeatAuditEntries(previous, grant, audit, Date.now()) : grantAuditEntries(previous, grant, audit, Date.now()))
      );
      // Grant, index and the intent to record it, in one commit. A refused
      // write reaches none of this, so it queues nothing.
      await txn.put<unknown>({
        [grantKey(grant.key)]: grant,
        [orgIndexKey(grant.orgId, grant.key)]: grant,
        ...rows,
      });
      return "written" as const;
    });
  }

  async putGrantIfOwned(
    grant: PlanGrant,
    expectedOrgId: string | null,
    audit: AuditIntent
  ): Promise<"written" | "conflict" | "full"> {
    const outcome = await this.#putGrantIfOwnedTxn(grant, expectedOrgId, audit);
    if (outcome === "written") await this.driver.deliverNow();
    return outcome;
  }

  async #deleteGrantIfOwnedTxn(
    key: string,
    expectedOrgId: string | null,
    audit: AuditIntent
  ): Promise<"deleted" | "missing" | "conflict"> {
    return this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<PlanGrant>(grantKey(key));
      if (!existing) return "missing" as const;
      if (lapsed(existing)) {
        // Already gone as far as every reader is concerned; tidy it away and
        // say so, rather than reporting a revocation of something inert — and
        // record nothing, for the same reason.
        for (const storageKey of allKeysFor(existing)) await txn.delete(storageKey);
        return "missing" as const;
      }
      if (existing.orgId !== expectedOrgId) return "conflict" as const;
      for (const storageKey of allKeysFor(existing)) await txn.delete(storageKey);
      await txn.put<unknown>(
        await this.driver.enqueue(
          txn, this.#auditIntents(revokeAuditEntries(existing, audit, Date.now()))
        )
      );
      return "deleted" as const;
    });
  }

  async deleteGrantIfOwned(
    key: string,
    expectedOrgId: string | null,
    audit: AuditIntent
  ): Promise<"deleted" | "missing" | "conflict"> {
    const outcome = await this.#deleteGrantIfOwnedTxn(key, expectedOrgId, audit);
    if (outcome === "deleted") await this.driver.deliverNow();
    return outcome;
  }

  async #putGrantIfSourceTxn(
    grant: PlanGrant,
    expectedSource: string,
    audit: AuditIntent
  ): Promise<GrantWrite> {
    return this.ctx.storage.transaction(async (txn) => {
      const stored = await txn.get<PlanGrant>(grantKey(grant.key));
      const previous = stored && !lapsed(stored) ? stored : undefined;
      if (previous && previous.source !== expectedSource) return { outcome: "conflict" as const };
      for (const stale of staleIndexKeys(stored, grant)) await txn.delete(stale);
      const rows = await this.driver.enqueue(
        txn, this.#auditIntents(grantAuditEntries(previous, grant, audit, Date.now()))
      );
      await txn.put<unknown>({
        [grantKey(grant.key)]: grant,
        [orgIndexKey(grant.orgId, grant.key)]: grant,
        ...rows,
      });
      return { outcome: "written" as const, previous };
    });
  }

  async putGrantIfSource(
    grant: PlanGrant,
    expectedSource: string,
    audit: AuditIntent
  ): Promise<GrantWrite> {
    const result = await this.#putGrantIfSourceTxn(grant, expectedSource, audit);
    if (result.outcome === "written") await this.driver.deliverNow();
    return result;
  }

  async #deleteGrantIfSourceTxn(
    key: string,
    expectedSource: string,
    audit: AuditIntent
  ): Promise<GrantDelete> {
    return this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<PlanGrant>(grantKey(key));
      if (!existing) return { outcome: "missing" as const };
      if (lapsed(existing)) {
        for (const storageKey of allKeysFor(existing)) await txn.delete(storageKey);
        return { outcome: "missing" as const };
      }
      if (existing.source !== expectedSource) return { outcome: "conflict" as const };
      for (const storageKey of allKeysFor(existing)) await txn.delete(storageKey);
      await txn.put<unknown>(
        await this.driver.enqueue(
          txn, this.#auditIntents(revokeAuditEntries(existing, audit, Date.now()))
        )
      );
      return { outcome: "deleted" as const, removed: existing };
    });
  }

  async deleteGrantIfSource(
    key: string,
    expectedSource: string,
    audit: AuditIntent
  ): Promise<GrantDelete> {
    const result = await this.#deleteGrantIfSourceTxn(key, expectedSource, audit);
    if (result.outcome === "deleted") await this.driver.deliverNow();
    return result;
  }

  async moveGrant(fromKey: string, toKey: string): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const grant = await txn.get<PlanGrant>(grantKey(fromKey));
      if (!grant) return;
      // Whatever sat at the destination goes first, index copy included, or
      // its listing entry outlives the record it pointed at.
      const displaced = await txn.get<PlanGrant>(grantKey(toKey));
      for (const storageKey of displaced ? allKeysFor(displaced) : []) {
        await txn.delete(storageKey);
      }
      for (const storageKey of allKeysFor(grant)) await txn.delete(storageKey);
      const moved: PlanGrant = { ...grant, key: toKey };
      await txn.put(grantKey(toKey), moved);
      await txn.put(orgIndexKey(moved.orgId, toKey), moved);
      await this.#repointScim(txn, grant, toKey);
    });
  }

  /**
   * The SCIM rows follow a moved key (SCIM spec, D3), in the move's own transaction: the user the key is managed
   * by, its key index, and the directory entry for its address; and a directory entry an SSO sign-in alone wrote
   * follows an address key.
   */
  async #repointScim(txn: DurableObjectTransaction, moved: PlanGrant, toKey: string): Promise<void> {
    const managed = await txn.get<{ orgId: string; scimId: string }>(scimKeyIndex(moved.key));
    if (managed) {
      const user = await txn.get<ScimUser>(scimUserKey(managed.orgId, managed.scimId));
      if (user) {
        await txn.put<unknown>({
          [scimUserKey(managed.orgId, managed.scimId)]: { ...user, key: toKey },
          [scimNameKey(managed.orgId, user.userName)]: { key: toKey, scimId: managed.scimId },
        });
      }
      await txn.delete(scimKeyIndex(moved.key));
      await txn.put(scimKeyIndex(toKey), managed);
      return;
    }
    if (moved.orgId && moved.key.startsWith("email:")) {
      const name = scimNameKey(moved.orgId, moved.key.slice("email:".length));
      const entry = await txn.get<DirectoryEntry>(name);
      if (entry && entry.key === moved.key) await txn.put(name, { ...entry, key: toKey });
    }
  }

  async listGrants(limit: number, orgId?: string | null): Promise<PlanGrant[]> {
    // An omitted orgId means every org. That is the internal path; the admin
    // endpoint always names one, including null for the org-less grants, and
    // reads only that range. Scoping by prefix rather than by filtering is also
    // what stops a caller paging past their own org: other orgs' records are
    // never in the window to begin with.
    const prefix = orgId === undefined ? "gr:" : orgIndexPrefix(orgId);
    const now = Date.now();
    const live: PlanGrant[] = [];
    let startAfter: string | undefined;

    // Page until the window is full or the range runs out, rather than reading
    // one window and filtering it. Expired records are swept here to match
    // getGrant, and if the first page is entirely expired a single-window read
    // would answer "no grants" while live ones sat just past it — with no
    // pagination on the endpoint to let the caller find out otherwise.
    while (live.length < limit) {
      const want = limit - live.length;
      const page = await this.ctx.storage.list<PlanGrant>({ prefix, startAfter, limit: want });
      if (page.size === 0) break;

      let last: string | undefined;
      for (const [storageKey, grant] of page) {
        last = storageKey;
        if (grant.expiresAt !== null && now > grant.expiresAt) {
          await this.#dropGrant(grant);
          continue;
        }
        live.push(grant);
      }
      // A short page means the range is exhausted; nothing follows to scan.
      if (page.size < want) break;
      startAfter = last;
    }
    return live;
  }

  // ------------------------------------------------- orgs (orgs spec, D1 to D5)
  // The record sits beside the grants that are its members, so a seat is decided in the
  // transaction that takes it, and the rows an org change owes go out through the same outbox.

  async getOrg(orgId: string): Promise<Org | undefined> {
    const org = await this.ctx.storage.get<Org>(orgKey(orgId));
    return org && liftOrg(org);
  }

  /**
   * The org's live grants: its members (D2), the owner's among them. A scan of the org's index
   * range, bounded by the org's own size, so it can run inside a transaction with the write it
   * guards. `#private` because it reads through whatever storage it is handed.
   * ponytail: a scan per member write; a counter row is the upgrade if an org ever holds thousands.
   */
  async #countMembers(from: Pick<DurableObjectTransaction, "list">, orgId: string, now: number): Promise<number> {
    let count = 0;
    for (const grant of (await from.list<PlanGrant>({ prefix: orgIndexPrefix(orgId) })).values()) {
      if (!lapsed(grant, now)) count++;
    }
    return count;
  }

  async countOrgMembers(orgId: string): Promise<number> {
    return this.#countMembers(this.ctx.storage, orgId, Date.now());
  }

  async #createOrgTxn(org: Org, ownerGrant: PlanGrant, audit: AuditIntent): Promise<"created" | "exists" | "conflict"> {
    return this.ctx.storage.transaction(async (txn) => {
      if (await txn.get<Org>(orgKey(org.orgId))) return "exists" as const;
      const stored = await txn.get<PlanGrant>(grantKey(ownerGrant.key));
      const previous = stored && !lapsed(stored) ? stored : undefined;
      if (previous && previous.orgId !== org.orgId) return "conflict" as const;
      for (const stale of staleIndexKeys(stored, ownerGrant)) await txn.delete(stale);
      const now = Date.now();
      const rows = await this.driver.enqueue(txn, this.#auditIntents([
        ...orgAuditEntries(undefined, org, audit, now),
        ...grantAuditEntries(previous, ownerGrant, audit, now),
      ]));
      // The record, the owner's grant, its index copy and the rows to record them, in one commit (D7).
      await txn.put<unknown>({
        [orgKey(org.orgId)]: org,
        [grantKey(ownerGrant.key)]: ownerGrant,
        [orgIndexKey(ownerGrant.orgId, ownerGrant.key)]: ownerGrant,
        ...rows,
      });
      return "created" as const;
    });
  }

  async createOrg(org: Org, ownerGrant: PlanGrant, audit: AuditIntent): Promise<"created" | "exists" | "conflict"> {
    const outcome = await this.#createOrgTxn(org, ownerGrant, audit);
    if (outcome === "created") await this.driver.deliverNow();
    return outcome;
  }

  async #updateOrgTxn(orgId: string, patch: OrgPatch, audit: AuditIntent): Promise<Org | undefined> {
    return this.ctx.storage.transaction(async (txn) => {
      const previous = await txn.get<Org>(orgKey(orgId));
      if (!previous) return undefined;
      const next = patchedOrg(previous, patch);
      const rows = await this.driver.enqueue(txn, this.#auditIntents(orgAuditEntries(previous, next, audit, Date.now())));
      await txn.put<unknown>({ [orgKey(orgId)]: next, ...rows });
      return next;
    });
  }

  async updateOrg(orgId: string, patch: OrgPatch, audit: AuditIntent): Promise<Org | undefined> {
    const next = await this.#updateOrgTxn(orgId, patch, audit);
    if (next) await this.driver.deliverNow();
    return next;
  }

  async #activatePurchasedOrgTxn(
    orgId: string, ownerUserId: string, seats: number, audit: AuditIntent,
  ): Promise<"created" | "updated" | "unchanged" | "not_purchased"> {
    return this.ctx.storage.transaction(async (txn) => {
      const previous = await txn.get<Org>(orgKey(orgId));
      // Billing touches only what billing created (ADR 0014, decision 3): an operator org stays as it is.
      if (previous && previous.source !== "purchase") return "not_purchased" as const;
      if (previous && previous.seats === seats && previous.active) return "unchanged" as const;
      const now = Date.now();
      // The seats and the standing, and nothing else (D4): the name its owner gave it survives every Stripe event.
      const next: Org = previous ? { ...previous, seats, active: true } : purchasedOrg(orgId, ownerUserId, seats, now);
      const rows = await this.driver.enqueue(txn, this.#auditIntents(orgAuditEntries(previous, next, audit, now)));
      await txn.put<unknown>({ [orgKey(orgId)]: next, ...rows });
      return previous ? ("updated" as const) : ("created" as const);
    });
  }

  async activatePurchasedOrg(
    orgId: string, ownerUserId: string, seats: number, audit: AuditIntent,
  ): Promise<"created" | "updated" | "unchanged" | "not_purchased"> {
    const outcome = await this.#activatePurchasedOrgTxn(orgId, ownerUserId, seats, audit);
    if (outcome === "created" || outcome === "updated") await this.driver.deliverNow();
    return outcome;
  }

  async #deactivateOrgTxn(orgId: string, audit: AuditIntent): Promise<"updated" | "unchanged" | "missing" | "not_purchased"> {
    return this.ctx.storage.transaction(async (txn) => {
      const previous = await txn.get<Org>(orgKey(orgId));
      if (!previous) return "missing" as const;
      if (previous.source !== "purchase") return "not_purchased" as const;
      if (!previous.active) return "unchanged" as const;
      const next: Org = { ...previous, active: false };
      const rows = await this.driver.enqueue(txn, this.#auditIntents(orgAuditEntries(previous, next, audit, Date.now())));
      await txn.put<unknown>({ [orgKey(orgId)]: next, ...rows });
      return "updated" as const;
    });
  }

  async deactivateOrg(orgId: string, audit: AuditIntent): Promise<"updated" | "unchanged" | "missing" | "not_purchased"> {
    const outcome = await this.#deactivateOrgTxn(orgId, audit);
    if (outcome === "updated") await this.driver.deliverNow();
    return outcome;
  }

  // ------------------------------------------------- SSO (SSO spec, D9, D11, D13)

  async #putOrgIdpTxn(orgId: string, idp: OrgIdp, audit: AuditIntent): Promise<"written" | "missing"> {
    return this.ctx.storage.transaction(async (txn) => {
      if (!(await txn.get<Org>(orgKey(orgId)))) return "missing" as const;
      const rows = await this.driver.enqueue(txn, this.#auditIntents([orgEventEntry(orgId, "idp_configured", { issuer: idp.issuer }, audit, Date.now())]));
      await txn.put<unknown>({ [idpKey(orgId)]: idp, ...rows });
      return "written" as const;
    });
  }

  async putOrgIdp(orgId: string, idp: OrgIdp, audit: AuditIntent): Promise<"written" | "missing"> {
    const outcome = await this.#putOrgIdpTxn(orgId, idp, audit);
    if (outcome === "written") await this.driver.deliverNow();
    return outcome;
  }

  async getOrgIdp(orgId: string): Promise<OrgIdp | undefined> {
    return this.ctx.storage.get<OrgIdp>(idpKey(orgId));
  }

  async #deleteOrgIdpTxn(orgId: string, audit: AuditIntent): Promise<"deleted" | "missing"> {
    return this.ctx.storage.transaction(async (txn) => {
      if (!(await txn.get<OrgIdp>(idpKey(orgId)))) return "missing" as const;
      await txn.delete(idpKey(orgId));
      await txn.put<unknown>(await this.driver.enqueue(txn, this.#auditIntents([orgEventEntry(orgId, "idp_removed", {}, audit, Date.now())])));
      return "deleted" as const;
    });
  }

  async deleteOrgIdp(orgId: string, audit: AuditIntent): Promise<"deleted" | "missing"> {
    const outcome = await this.#deleteOrgIdpTxn(orgId, audit);
    if (outcome === "deleted") await this.driver.deliverNow();
    return outcome;
  }

  async #claimDomainTxn(orgId: string, domain: string, token: string, now: number, audit: AuditIntent): Promise<"claimed" | "exists" | "missing"> {
    return this.ctx.storage.transaction(async (txn) => {
      const org = await txn.get<Org>(orgKey(orgId));
      if (!org) return "missing" as const;
      if (org.domains.some((d) => d.domain === domain)) return "exists" as const;
      const next: Org = { ...org, domains: [...org.domains, { domain, token, verifiedAt: null }] };
      const rows = await this.driver.enqueue(txn, this.#auditIntents([orgEventEntry(orgId, "domain_claimed", { domain }, audit, now)]));
      await txn.put<unknown>({ [orgKey(orgId)]: next, ...rows });
      return "claimed" as const;
    });
  }

  async claimDomain(orgId: string, domain: string, token: string, now: number, audit: AuditIntent): Promise<"claimed" | "exists" | "missing"> {
    const outcome = await this.#claimDomainTxn(orgId, domain, token, now, audit);
    if (outcome === "claimed") await this.driver.deliverNow();
    return outcome;
  }

  /** The index read and the claim's write in one transaction (D11): two orgs verifying one domain at once cannot both win. */
  async #verifyDomainTxn(orgId: string, domain: string, now: number, audit: AuditIntent): Promise<"verified" | "taken" | "unknown"> {
    return this.ctx.storage.transaction(async (txn) => {
      const org = await txn.get<Org>(orgKey(orgId));
      const claim = org?.domains.find((d) => d.domain === domain);
      if (!org || !claim) return "unknown" as const;
      const holder = await txn.get<string>(domainKey(domain));
      if (holder !== undefined && holder !== orgId) return "taken" as const;
      if (claim.verifiedAt !== null) {
        await txn.put(domainKey(domain), orgId);
        return "verified" as const;
      }
      const next: Org = { ...org, domains: org.domains.map((d) => (d.domain === domain ? { ...d, verifiedAt: now } : d)) };
      const rows = await this.driver.enqueue(txn, this.#auditIntents([orgEventEntry(orgId, "domain_verified", { domain }, audit, now)]));
      await txn.put<unknown>({ [orgKey(orgId)]: next, [domainKey(domain)]: orgId, ...rows });
      return "verified" as const;
    });
  }

  async verifyDomain(orgId: string, domain: string, now: number, audit: AuditIntent): Promise<"verified" | "taken" | "unknown"> {
    const outcome = await this.#verifyDomainTxn(orgId, domain, now, audit);
    if (outcome === "verified") await this.driver.deliverNow();
    return outcome;
  }

  async #releaseDomainTxn(orgId: string, domain: string, audit: AuditIntent): Promise<"released" | "unknown"> {
    return this.ctx.storage.transaction(async (txn) => {
      const org = await txn.get<Org>(orgKey(orgId));
      if (!org || !org.domains.some((d) => d.domain === domain)) return "unknown" as const;
      const next: Org = { ...org, domains: org.domains.filter((d) => d.domain !== domain) };
      if ((await txn.get<string>(domainKey(domain))) === orgId) await txn.delete(domainKey(domain));
      const rows = await this.driver.enqueue(txn, this.#auditIntents([orgEventEntry(orgId, "domain_released", { domain }, audit, Date.now())]));
      await txn.put<unknown>({ [orgKey(orgId)]: next, ...rows });
      return "released" as const;
    });
  }

  async releaseDomain(orgId: string, domain: string, audit: AuditIntent): Promise<"released" | "unknown"> {
    const outcome = await this.#releaseDomainTxn(orgId, domain, audit);
    if (outcome === "released") await this.driver.deliverNow();
    return outcome;
  }

  async orgForDomain(domain: string): Promise<string | undefined> {
    return this.ctx.storage.get<string>(domainKey(domain));
  }

  /** Whether a key index row names a SCIM user the IdP deactivated (SCIM spec, D4). */
  async #scimInactive(txn: Pick<DurableObjectTransaction, "get">, managed: { orgId: string; scimId: string } | undefined): Promise<boolean> {
    const user = managed && await txn.get<ScimUser>(scimUserKey(managed.orgId, managed.scimId));
    return user !== undefined && !user.active;
  }

  async #provisionSsoMemberTxn(
    orgId: string, key: string, now: number, audit: AuditIntent, address?: string,
  ): Promise<"written" | "exists" | "full" | "no_org" | "deprovisioned"> {
    return this.ctx.storage.transaction(async (txn) => {
      const org = await txn.get<Org>(orgKey(orgId));
      if (!org) return "no_org" as const;
      if (await this.#scimInactive(txn, await txn.get<{ orgId: string; scimId: string }>(scimKeyIndex(key)))) return "deprovisioned" as const;
      const stored = await txn.get<PlanGrant>(grantKey(key));
      if (stored && !lapsed(stored, now)) return "exists" as const;
      const name = address === undefined ? undefined : scimNameKey(orgId, address);
      const entry = name === undefined ? undefined : await txn.get<DirectoryEntry>(name);
      if (entry?.scimId && (await this.#scimInactive(txn, { orgId, scimId: entry.scimId }))) return "deprovisioned" as const;
      // The grant the address is seated under, this org's: at the directory's key, else at the address as given or
      // lowercased (a push seats the lowercased address). It moves onto the subject with its role and source, as
      // `moveGrant` moves an admin's address grant: the seat follows the door the person last came through.
      const candidates = address === undefined ? [entry?.key] : [entry?.key, `email:${address}`, `email:${address.toLowerCase()}`];
      for (const from of candidates) {
        const found = from === undefined || from === key ? undefined : await txn.get<PlanGrant>(grantKey(from));
        const held = found && !lapsed(found, now) ? found : undefined;
        if (!held || held.orgId !== orgId) continue;
        for (const storageKey of allKeysFor(held)) await txn.delete(storageKey);
        for (const storageKey of stored ? allKeysFor(stored) : []) await txn.delete(storageKey);
        const moved: PlanGrant = { ...held, key };
        await txn.put<unknown>({ [grantKey(key)]: moved, [orgIndexKey(moved.orgId, key)]: moved, [name!]: { key, scimId: entry?.scimId ?? null } });
        await this.#repointScim(txn, held, key);
        return "written" as const;
      }
      if ((await this.#countMembers(txn, orgId, now)) >= org.seats) return "full" as const;
      const grant: PlanGrant = { key, plan: "team", role: "member", orgId, source: "sso", grantedAt: now, grantedBy: "sso", expiresAt: null };
      for (const stale of staleIndexKeys(stored, grant)) await txn.delete(stale);
      const extra: Record<string, unknown> = {};
      if (name !== undefined) {
        extra[name] = { key, scimId: entry?.scimId ?? null } satisfies DirectoryEntry;
        // A SCIM user whose grant is gone follows the subject that just signed in.
        const user = entry?.scimId ? await txn.get<ScimUser>(scimUserKey(orgId, entry.scimId)) : undefined;
        if (user) {
          await txn.delete(scimKeyIndex(user.key));
          Object.assign(extra, this.#scimRows({ ...user, key }));
        }
      }
      const rows = await this.driver.enqueue(txn, this.#auditIntents(grantAuditEntries(undefined, grant, audit, now)));
      await txn.put<unknown>({ [grantKey(key)]: grant, [orgIndexKey(orgId, key)]: grant, ...extra, ...rows });
      return "written" as const;
    });
  }

  async provisionSsoMember(
    orgId: string, key: string, now: number, audit: AuditIntent, address?: string,
  ): Promise<"written" | "exists" | "full" | "no_org" | "deprovisioned"> {
    const outcome = await this.#provisionSsoMemberTxn(orgId, key, now, audit, address);
    if (outcome === "written") await this.driver.deliverNow();
    return outcome;
  }

  // ------------------------------------------------- invites (ADR 0027)
  // Under `io:` and `iv:`, apart from the grants: nothing that reads `gr:` or `go:` can take one for a seat.

  async #putOrgInviteTxn(invite: OrgInvite, audit: AuditIntent): Promise<"invited" | "exists" | "limit" | "no_org"> {
    return this.ctx.storage.transaction(async (txn) => {
      if (!(await txn.get<Org>(orgKey(invite.orgId)))) return "no_org" as const;
      const [byOrg, byKey] = inviteKeysFor(invite);
      if (await txn.get<OrgInvite>(byOrg)) return "exists" as const;
      const pending = await txn.list({ prefix: orgInvitesPrefix(invite.orgId), limit: MAX_PENDING_INVITES });
      if (pending.size >= MAX_PENDING_INVITES) return "limit" as const;
      const rows = await this.driver.enqueue(txn, this.#auditIntents([
        orgEventEntry(invite.orgId, "member_invited", { key: invite.key, role: invite.role }, audit, invite.invitedAt),
      ]));
      await txn.put<unknown>({ [byOrg]: invite, [byKey]: invite, ...rows });
      return "invited" as const;
    });
  }

  async putOrgInvite(invite: OrgInvite, audit: AuditIntent): Promise<"invited" | "exists" | "limit" | "no_org"> {
    const outcome = await this.#putOrgInviteTxn(invite, audit);
    if (outcome === "invited") await this.driver.deliverNow();
    return outcome;
  }

  async listOrgInvites(orgId: string, limit: number): Promise<OrgInvite[]> {
    return [...(await this.ctx.storage.list<OrgInvite>({ prefix: orgInvitesPrefix(orgId), limit })).values()].map(liftInvite);
  }

  /** One prefix read per key, each bounded as an org's listing is: a key many orgs invited cannot make a sign-in read without end. */
  async invitesFor(keys: string[]): Promise<OrgInvite[]> {
    const found: OrgInvite[] = [];
    for (const key of new Set(keys)) {
      found.push(...[...(await this.ctx.storage.list<OrgInvite>({ prefix: keyInvitesPrefix(key), limit: MAX_PENDING_INVITES })).values()].map(liftInvite));
    }
    return found;
  }

  async #deleteOrgInviteTxn(orgId: string, key: string, audit: AuditIntent): Promise<"deleted" | "missing"> {
    return this.ctx.storage.transaction(async (txn) => {
      const rowKeys = inviteKeysFor({ orgId, key });
      if (!(await txn.get<OrgInvite>(rowKeys[0]))) return "missing" as const;
      await txn.delete(rowKeys);
      await txn.put<unknown>(await this.driver.enqueue(txn, this.#auditIntents([orgEventEntry(orgId, "invite_withdrawn", { key }, audit, Date.now())])));
      return "deleted" as const;
    });
  }

  async deleteOrgInvite(orgId: string, key: string, audit: AuditIntent): Promise<"deleted" | "missing"> {
    const outcome = await this.#deleteOrgInviteTxn(orgId, key, audit);
    if (outcome === "deleted") await this.driver.deliverNow();
    return outcome;
  }

  async #renewOrgInviteTxn(orgId: string, key: string, invitedBy: string, now: number, audit: AuditIntent): Promise<OrgInvite | "missing"> {
    return this.ctx.storage.transaction(async (txn) => {
      const [byOrg, byKey] = inviteKeysFor({ orgId, key });
      const found = await txn.get<OrgInvite>(byOrg);
      if (!found) return "missing" as const;
      const renewed: OrgInvite = { ...found, invitedBy, invitedAt: now, expiresAt: now + INVITE_TTL_MS };
      const rows = await this.driver.enqueue(txn, this.#auditIntents([orgEventEntry(orgId, "invite_resent", { key }, audit, now)]));
      await txn.put<unknown>({ [byOrg]: renewed, [byKey]: renewed, ...rows });
      return renewed;
    });
  }

  async spendInviteMail(orgId: string, budget: number, now: number): Promise<boolean> {
    return this.ctx.storage.transaction(async (txn) => {
      const key = `invmail:${orgId}`;
      const day = inviteMailDay(now);
      const row = await txn.get<{ day: number; spent: number }>(key);
      const spent = row?.day === day ? row.spent : 0;
      if (spent >= budget) return false;
      await txn.put(key, { day, spent: spent + 1 });
      return true;
    });
  }

  async renewOrgInvite(orgId: string, key: string, invitedBy: string, now: number, audit: AuditIntent): Promise<OrgInvite | "missing"> {
    const outcome = await this.#renewOrgInviteTxn(orgId, key, invitedBy, now, audit);
    if (outcome !== "missing") await this.driver.deliverNow();
    return outcome;
  }

  /** The offer, the switch, every key's grant and the seats are read in the transaction that writes the grant (ADR 0027). */
  async #acceptOrgInviteTxn(
    orgId: string, keys: string[], subjectKey: string, now: number, audit: AuditIntent, link?: { key: string; at: number },
  ): Promise<"joined" | "member" | "taken" | "full" | "sso" | "gone"> {
    return this.ctx.storage.transaction(async (txn) => {
      const org = await txn.get<Org>(orgKey(orgId));
      if (!org) return "gone" as const;
      const named = link ? await txn.get<OrgInvite>(inviteKeysFor({ orgId, key: link.key })[0]) : undefined;
      const linked = link && named?.invitedAt === link.at ? [link.key] : [];
      const unique = [...new Set([subjectKey, ...keys, ...linked])];
      const inviteRows = unique.map((key) => inviteKeysFor({ orgId, key }));
      const invite = (await Promise.all(inviteRows.map(([byOrg]) => txn.get<OrgInvite>(byOrg))))
        .find((i): i is OrgInvite => i !== undefined && inviteLive(liftInvite(i), now));
      const stored = await Promise.all(unique.map((key) => txn.get<PlanGrant>(grantKey(key))));
      const grants = stored.filter((g): g is PlanGrant => g !== undefined && !lapsed(g, now));
      // An unowned seat, in this org or any other, holds nothing: this org's are the offer and move, and another's is no grant.
      const orgs = new Map<string, Org | undefined>([[orgId, org]]);
      for (const g of grants) if (g.orgId !== null && !orgs.has(g.orgId)) orgs.set(g.orgId, await txn.get<Org>(orgKey(g.orgId)));
      const unowned = grants.filter((g) => isUnownedSeat(g, g.orgId === null ? undefined : orgs.get(g.orgId)));
      const seats = unowned.filter((g) => g.orgId === orgId);
      const offer = invite ? { role: invite.role, by: invite.invitedBy } : seats[0] ? { role: seats[0].role, by: seats[0].grantedBy } : undefined;
      if (!offer) return "gone" as const;
      if (org.requireSso) return "sso" as const;
      const others = grants.filter((g) => !unowned.includes(g));
      if (others.some((g) => g.orgId === orgId)) {
        await txn.delete(inviteRows.flat());
        return "member" as const;
      }
      if (others.length > 0) return "taken" as const;
      if (seats.length === 0 && (await this.#countMembers(txn, orgId, now)) >= org.seats) return "full" as const;
      const grant: PlanGrant = { key: subjectKey, plan: "team", role: offer.role, orgId, source: "invite", grantedAt: now, grantedBy: offer.by, expiresAt: null };
      // The subject's own row is a lapsed one at most, here; its index copy in another org goes with it.
      const subject = stored[0];
      await txn.delete([...inviteRows.flat(), ...seats.flatMap(allKeysFor), ...staleIndexKeys(subject, grant)]);
      // A seat the IdP pushed stays the IdP's to end (ADR 0029): its rows follow it onto the subject, as a claim's do.
      for (const seat of seats) await this.#repointScim(txn, seat, subjectKey);
      const rows = await this.driver.enqueue(txn, this.#auditIntents(grantAuditEntries(undefined, grant, audit, now)));
      await txn.put<unknown>({ [grantKey(subjectKey)]: grant, [orgIndexKey(orgId, subjectKey)]: grant, ...rows });
      return "joined" as const;
    });
  }

  async acceptOrgInvite(
    orgId: string, keys: string[], subjectKey: string, now: number, audit: AuditIntent, link?: { key: string; at: number },
  ): Promise<"joined" | "member" | "taken" | "full" | "sso" | "gone"> {
    const outcome = await this.#acceptOrgInviteTxn(orgId, keys, subjectKey, now, audit, link);
    if (outcome === "joined") await this.driver.deliverNow();
    return outcome;
  }

  async declineOrg(subjectKey: string, orgId: string, now: number): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const key = declineKey(subjectKey, orgId);
      await txn.put(key, Math.max(now, (await txn.get<number>(key)) ?? now));
    });
  }

  async declinedOrgs(subjectKey: string): Promise<{ orgId: string; at: number }[]> {
    const prefix = declinesPrefix(subjectKey);
    const rows = await this.ctx.storage.list<number>({ prefix, limit: MAX_PENDING_INVITES });
    return [...rows].map(([key, at]) => ({ orgId: decodeURIComponent(key.slice(prefix.length)), at }));
  }

  // ------------------------------------------------- SCIM users (SCIM spec, D2 to D8)
  // The row, the directory entry and the key index beside the grant they name, so a push, a deactivation and a
  // rename are each one transaction, and a refusal in any of them is answered before the first write.

  #scimRows(user: ScimUser): Record<string, unknown> {
    return {
      [scimUserKey(user.orgId, user.id)]: user,
      [scimNameKey(user.orgId, user.userName)]: { key: user.key, scimId: user.id } satisfies DirectoryEntry,
      [scimKeyIndex(user.key)]: { orgId: user.orgId, scimId: user.id },
    };
  }

  async #createScimUserTxn(user: ScimUser, audit: AuditIntent): Promise<ScimCreate> {
    return this.ctx.storage.transaction(async (txn) => {
      const org = await txn.get<Org>(orgKey(user.orgId));
      if (!org) return { outcome: "no_org" as const };
      const entry = await txn.get<DirectoryEntry>(scimNameKey(user.orgId, user.userName));
      // A tombstone (a user the IdP deleted) is no user: the push starts them over under the key it kept.
      const prior = entry?.scimId ? await txn.get<ScimUser>(scimUserKey(user.orgId, entry.scimId)) : undefined;
      if (prior && prior.deletedAt === null) return { outcome: "exists" as const };
      const kept = entry?.key ?? user.key;
      let key = kept;
      let stored = await txn.get<PlanGrant>(grantKey(key));
      let held = stored && !lapsed(stored, user.createdAt) ? stored : undefined;
      if (held && held.orgId !== user.orgId) return { outcome: "conflict" as const };
      // A seat this push creates or restores never lands on a personal account the org does not own by its form (ADR 0027).
      if (!held) {
        key = scimSeatKey(org, user.userName, kept);
        if (key !== kept) {
          stored = await txn.get<PlanGrant>(grantKey(key));
          held = stored && !lapsed(stored, user.createdAt) ? stored : undefined;
          if (held && held.orgId !== user.orgId) return { outcome: "conflict" as const };
        }
      }
      const linked = held !== undefined;
      const entries: AuditEntry[] = [];
      const rows: Record<string, unknown> = {};
      if (key !== kept && (await txn.get<{ scimId: string }>(scimKeyIndex(kept)))?.scimId === entry?.scimId) await txn.delete(scimKeyIndex(kept));
      if (!linked && user.active) {
        if ((await this.#countMembers(txn, user.orgId, user.createdAt)) >= org.seats) return { outcome: "full" as const };
        const grant = scimGrant(key, user.orgId, user.createdAt);
        for (const stale of staleIndexKeys(stored, grant)) await txn.delete(stale);
        rows[grantKey(key)] = grant;
        rows[orgIndexKey(user.orgId, key)] = grant;
        entries.push(...grantAuditEntries(undefined, grant, audit, user.createdAt));
      } else if (held && !user.active) {
        // Pushed as inactive onto a seat a sign-in or an admin gave: the push is the deactivation (review finding 5).
        for (const storageKey of allKeysFor(held)) await txn.delete(storageKey);
        entries.push(...revokeAuditEntries(held, audit, user.createdAt));
      }
      if (prior) await txn.delete(scimUserKey(user.orgId, prior.id));
      const row: ScimUser = { ...user, key, deletedAt: null };
      entries.push(scimUserEntry(user.orgId, user.id, "scim_user_created", {
        user_name: user.userName, external_id: user.externalId, key, linked,
      }, audit, user.createdAt));
      const queued = await this.driver.enqueue(txn, this.#auditIntents(entries));
      await txn.put<unknown>({ ...rows, ...this.#scimRows(row), ...queued });
      return { outcome: linked ? ("linked" as const) : ("written" as const), user: row };
    });
  }

  async createScimUser(user: ScimUser, audit: AuditIntent): Promise<ScimCreate> {
    const outcome = await this.#createScimUserTxn(user, audit);
    if (outcome.outcome === "written" || outcome.outcome === "linked") await this.driver.deliverNow();
    return outcome;
  }

  /** A tombstone is hidden from every read but `scimUserByKey`, which the sign-in refusal reads. */
  async getScimUser(orgId: string, id: string): Promise<ScimUser | undefined> {
    const user = await this.ctx.storage.get<ScimUser>(scimUserKey(orgId, id));
    return user && user.deletedAt === null ? user : undefined;
  }

  async scimUserByName(orgId: string, userName: string): Promise<ScimUser | undefined> {
    const entry = await this.ctx.storage.get<DirectoryEntry>(scimNameKey(orgId, userName));
    return entry?.scimId ? this.getScimUser(orgId, entry.scimId) : undefined;
  }

  async scimUserByKey(key: string): Promise<ScimUser | undefined> {
    const managed = await this.ctx.storage.get<{ orgId: string; scimId: string }>(scimKeyIndex(key));
    return managed ? this.ctx.storage.get<ScimUser>(scimUserKey(managed.orgId, managed.scimId)) : undefined;
  }

  async listScimUsers(orgId: string, limit: number): Promise<ScimUser[]> {
    // ponytail: tombstones are read and dropped, so a page holds fewer than `limit` by their number.
    return [...(await this.ctx.storage.list<ScimUser>({ prefix: scimUserPrefix(orgId), limit })).values()].filter((u) => u.deletedAt === null);
  }

  async #updateScimUserTxn(orgId: string, id: string, patch: ScimUserPatch, now: number, audit: AuditIntent): Promise<ScimUpdate> {
    return this.ctx.storage.transaction(async (txn) => {
      const was = await txn.get<ScimUser>(scimUserKey(orgId, id));
      if (!was || was.deletedAt !== null) return { outcome: "missing" as const };
      const rename = patch.userName !== undefined && patch.userName !== was.userName ? patch.userName : undefined;
      const externalId = patch.externalId !== undefined && patch.externalId !== was.externalId ? patch.externalId : undefined;
      const active = patch.active !== undefined && patch.active !== was.active ? patch.active : undefined;
      if (rename === undefined && externalId === undefined && active === undefined) return { outcome: "updated" as const, user: was, was };
      // Every refusal before any write: a transaction rolls back on a throw and not on a return.
      const moves = rename !== undefined && was.key === `email:${was.userName}`;
      const toKey = moves ? `email:${rename}` : was.key;
      const liveAt = async (storageKey: string): Promise<PlanGrant | undefined> => {
        const found = await txn.get<PlanGrant>(grantKey(storageKey));
        return found && !lapsed(found, now) ? found : undefined;
      };
      if (rename !== undefined) {
        const taken = await txn.get<DirectoryEntry>(scimNameKey(orgId, rename));
        if (taken?.scimId && taken.scimId !== id) return { outcome: "exists" as const };
        // A tenant's seat is never handed to another: a live grant at the new address refuses the rename.
        const target = moves ? await liveAt(toKey) : undefined;
        if (target && target.orgId !== orgId) return { outcome: "conflict" as const };
        if (target) return { outcome: "exists" as const };
      }
      let reuse: PlanGrant | undefined;
      // A reactivation never re-seats a personal account the org does not own by its form (ADR 0027): on the address instead.
      const org = await txn.get<Org>(orgKey(orgId));
      const seatAt = active === true && org ? scimSeatKey(org, rename ?? was.userName, toKey) : toKey;
      if (active === true) {
        const held = moves && seatAt === toKey ? undefined : await liveAt(seatAt);
        if (held && held.orgId !== orgId) return { outcome: "conflict" as const };
        reuse = held;
        if (!reuse && org && (await this.#countMembers(txn, orgId, now)) >= org.seats) return { outcome: "full" as const };
      }

      const entries: AuditEntry[] = [];
      const rows: Record<string, unknown> = {};
      const detail: Record<string, unknown> = {};
      let next: ScimUser = { ...was, updatedAt: now };
      if (rename !== undefined) {
        // An address key names the address, so it moves with it; a key a sign-in claimed names the person and stays.
        if (moves) {
          const stored = await txn.get<PlanGrant>(grantKey(was.key));
          if (stored && !lapsed(stored, now)) {
            for (const storageKey of allKeysFor(stored)) await txn.delete(storageKey);
            const moved: PlanGrant = { ...stored, key: toKey };
            rows[grantKey(toKey)] = moved;
            rows[orgIndexKey(moved.orgId, toKey)] = moved;
          }
          await txn.delete(scimKeyIndex(was.key));
          next = { ...next, key: toKey };
        }
        await txn.delete(scimNameKey(orgId, was.userName));
        next = { ...next, userName: rename };
        detail.from = was.userName;
      }
      if (externalId !== undefined) {
        next = { ...next, externalId };
        detail.external_id = externalId;
      }
      let action: "scim_user_updated" | "scim_user_deactivated" | "scim_user_reactivated" = "scim_user_updated";
      if (active === true) {
        if (seatAt !== next.key) {
          await txn.delete(scimKeyIndex(next.key));
          next = { ...next, key: seatAt };
        }
        if (!reuse) {
          const grant = scimGrant(next.key, orgId, now);
          const stale = rows[grantKey(next.key)] === undefined ? await txn.get<PlanGrant>(grantKey(next.key)) : undefined;
          for (const staleKey of staleIndexKeys(stale, grant)) await txn.delete(staleKey);
          rows[grantKey(next.key)] = grant;
          rows[orgIndexKey(orgId, next.key)] = grant;
          entries.push(...grantAuditEntries(undefined, grant, audit, now));
        }
        action = "scim_user_reactivated";
      } else if (active === false) {
        const held = rows[grantKey(next.key)] as PlanGrant | undefined ?? await txn.get<PlanGrant>(grantKey(next.key));
        if (held && !lapsed(held, now) && held.orgId === orgId) {
          for (const storageKey of allKeysFor(held)) {
            await txn.delete(storageKey);
            delete rows[storageKey];
          }
          entries.push(...revokeAuditEntries(held, audit, now));
        }
        action = "scim_user_deactivated";
      }
      if (active !== undefined) next = { ...next, active };
      entries.push(scimUserEntry(orgId, id, action, { user_name: next.userName, key: next.key, ...detail }, audit, now));
      const queued = await this.driver.enqueue(txn, this.#auditIntents(entries));
      await txn.put<unknown>({ ...rows, ...this.#scimRows(next), ...queued });
      return { outcome: "updated" as const, user: next, was };
    });
  }

  async updateScimUser(orgId: string, id: string, patch: ScimUserPatch, now: number, audit: AuditIntent): Promise<ScimUpdate> {
    const outcome = await this.#updateScimUserTxn(orgId, id, patch, now, audit);
    if (outcome.outcome === "updated") await this.driver.deliverNow();
    return outcome;
  }

  /**
   * A delete is a deactivation that also hides the row (review finding 3): the grant goes, the row stays as a
   * tombstone with its directory entry and key index, so the subject is refused as a deactivated one is, and a
   * repeat answers the tombstone so a room walk cut short can be finished. A push for the address starts over.
   */
  async #deleteScimUserTxn(orgId: string, id: string, now: number, audit: AuditIntent): Promise<{ was: ScimUser; wrote: boolean } | undefined> {
    return this.ctx.storage.transaction(async (txn) => {
      const was = await txn.get<ScimUser>(scimUserKey(orgId, id));
      if (!was) return undefined;
      if (was.deletedAt !== null) return { was, wrote: false };
      const entries: AuditEntry[] = [];
      const stored = was.active ? await txn.get<PlanGrant>(grantKey(was.key)) : undefined;
      if (stored && !lapsed(stored, now) && stored.orgId === orgId) {
        for (const storageKey of allKeysFor(stored)) await txn.delete(storageKey);
        entries.push(...revokeAuditEntries(stored, audit, now));
      }
      entries.push(scimUserEntry(orgId, id, "scim_user_deleted", { user_name: was.userName, key: was.key }, audit, now));
      const rows = await this.driver.enqueue(txn, this.#auditIntents(entries));
      await txn.put<unknown>({ [scimUserKey(orgId, id)]: { ...was, active: false, updatedAt: now, deletedAt: now } satisfies ScimUser, ...rows });
      return { was, wrote: true };
    });
  }

  async deleteScimUser(orgId: string, id: string, now: number, audit: AuditIntent): Promise<ScimUser | undefined> {
    const outcome = await this.#deleteScimUserTxn(orgId, id, now, audit);
    if (outcome?.wrote) await this.driver.deliverNow();
    return outcome?.was;
  }

  // ------------------------------------------------- SCIM (SCIM spec, D1)
  // The token's hash and its lookup row, beside the org: issuing again replaces both in one transaction, so the
  // old token stops at the commit and no window serves two.

  async #issueScimTokenTxn(orgId: string, token: ScimToken, audit: AuditIntent): Promise<"issued" | "replaced" | "missing"> {
    return this.ctx.storage.transaction(async (txn) => {
      if (!(await txn.get<Org>(orgKey(orgId)))) return "missing" as const;
      const previous = await txn.get<ScimToken>(scimTokenKey(orgId));
      if (previous) await txn.delete(scimTokenIndex(previous.tokenHash));
      const rows = await this.driver.enqueue(txn, this.#auditIntents([
        orgEventEntry(orgId, "scim_token_issued", { replaced: previous !== undefined }, audit, token.issuedAt),
      ]));
      await txn.put<unknown>({ [scimTokenKey(orgId)]: token, [scimTokenIndex(token.tokenHash)]: orgId, ...rows });
      return previous ? ("replaced" as const) : ("issued" as const);
    });
  }

  async issueScimToken(orgId: string, token: ScimToken, audit: AuditIntent): Promise<"issued" | "replaced" | "missing"> {
    const outcome = await this.#issueScimTokenTxn(orgId, token, audit);
    if (outcome !== "missing") await this.driver.deliverNow();
    return outcome;
  }

  async #revokeScimTokenTxn(orgId: string, audit: AuditIntent): Promise<"revoked" | "missing"> {
    return this.ctx.storage.transaction(async (txn) => {
      const token = await txn.get<ScimToken>(scimTokenKey(orgId));
      if (!token) return "missing" as const;
      await txn.delete([scimTokenKey(orgId), scimTokenIndex(token.tokenHash)]);
      const rows = await this.driver.enqueue(txn, this.#auditIntents([orgEventEntry(orgId, "scim_token_revoked", {}, audit, Date.now())]));
      await txn.put<unknown>(rows);
      return "revoked" as const;
    });
  }

  async revokeScimToken(orgId: string, audit: AuditIntent): Promise<"revoked" | "missing"> {
    const outcome = await this.#revokeScimTokenTxn(orgId, audit);
    if (outcome === "revoked") await this.driver.deliverNow();
    return outcome;
  }

  async scimTokenOf(orgId: string): Promise<ScimToken | undefined> {
    return this.ctx.storage.get<ScimToken>(scimTokenKey(orgId));
  }

  async orgForScimToken(tokenHash: string): Promise<string | undefined> {
    return this.ctx.storage.get<string>(scimTokenIndex(tokenHash));
  }

  /**
   * Remove both copies of a grant. Every delete path goes through here, and in
   * one transaction: half a delete leaves the grant listed but unresolvable,
   * or resolvable but unlisted.
   *
   * `#private`, because it deletes whatever grant it is handed, and a Durable Object
   * answers RPC for every method on its class: TypeScript's `private` is erased at
   * compile time.
   */
  async #dropGrant(grant: PlanGrant): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      for (const storageKey of allKeysFor(grant)) {
        await txn.delete(storageKey);
      }
    });
  }

  async countCreatesThisMonth(userId: string): Promise<number> {
    return this.#countMonth(`cr:${userId}`);
  }

  /**
   * `ho:<userId>:<sessionId>` — the hosted rooms a person holds open (I7), one row a
   * slot. The count and the record are one transaction, so two starts at the limit
   * cannot both pass, and a room's close gives its row back through its outbox
   * (`hosted_release`). Only this person's rows count: one whose rest holds a colon belongs to
   * someone whose id extends theirs, as the `us:` index says below (#226). A plan's hosted rooms
   * are the most a person holds open at once, not a
   * count of creations a month: each room's allowance renews monthly, so a monthly count
   * let a creator's spend grow every month they kept rooms open.
   */
  async reserveHostedRoom(userId: string, sessionId: string, limit: number): Promise<HostedSlot> {
    return this.ctx.storage.transaction(async (txn) => {
      const prefix = `ho:${userId}:`;
      const held = [...(await txn.list({ prefix })).keys()]
        .map((key) => key.slice(prefix.length))
        .filter((id) => !id.includes(":"));
      if (held.includes(sessionId)) return { ok: true };
      if (held.length >= limit) return { ok: false, open: held.length };
      await txn.put(`${prefix}${sessionId}`, Date.now());
      return { ok: true };
    });
  }

  async releaseHostedRoom(userId: string, sessionId: string): Promise<void> {
    await this.ctx.storage.delete(`ho:${userId}:${sessionId}`);
  }

  /**
   * `us:<userId>:<sessionId>` — which rooms a person created.
   *
   * The create counts below cannot answer this: they are timestamps kept for
   * the monthly quota, with no session id in them. Freezing needs the ids.
   *
   * Two variable segments, and only the second is sure to hold no separator: a session id is
   * `qs_<uuid>`, but an operator-issued user id may hold a colon, so one person's prefix also
   * covers the rows of someone whose id extends theirs past one (`u_x:a` extends `u_x`). Reads
   * go through #ownIds, which skips a row whose rest holds a colon (#295).
   *
   * **Sessions created before this deploy are not in here, and cannot be.**
   * This registry has never known which sessions exist — it holds join codes,
   * which are consumed, and create counts, which are bare timestamps. There is
   * no list to backfill from, so the gap cannot be closed by a migration; it
   * closes only as those rooms end, and since #18 a room ends when its last
   * member leaves or nobody has been in it for 90 days. Until then a lapse will
   * not freeze them, which means a room outliving its plan rather than a room
   * lost.
   *
   * **Sessions created after this deploy can be missing too.**
   * `DurableObjectStore` puts this row once the room has committed, and logs a
   * failed put rather than throwing it (`writeIndex`), deliberately: a throw
   * would report a failed create for a room that already exists. Nothing
   * rebuilds the row, so the outcome is the one above: a lapse cannot freeze a
   * room it cannot find, and the room keeps working on a plan that no longer
   * pays for it. The gap above only shrinks, as those rooms end; this one
   * also grows whenever a put fails. A creator's `um:` row is a separate put, so
   * either row can land without the other, and a room can be listed for its
   * creator and still be out of a lapse's reach.
   */
  async indexSession(userId: string, sessionId: string, room?: RoomIndexRow): Promise<void> {
    // `room` is optional so a caller a deploy ahead of this object still writes the `us:` row (#361's lag);
    // the backfill writes the room's row the call left out.
    // One transaction: in a SQLite-backed object KV and SQL are one database, so both land or neither does.
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.put(`us:${userId}:${sessionId}`, Date.now());
      if (room) insertRoom(this.ctx.storage.sql, room);
    });
  }

  /**
   * The `rooms` table — every room, for the operator (#471) — newest first. Written with the creator's `us:` row
   * (`indexSession`), or by the backfill (`indexRoom`); a close keeps the row, the purge deletes it.
   */
  async listRoomsPage(limit: number, startAfter?: Pick<RoomIndexRow, "createdAt" | "sessionId">): Promise<RoomIndexRow[]> {
    return this.listRoomsFiltered(limit, startAfter, {});
  }

  async listRoomsFiltered(limit: number, startAfter: Pick<RoomIndexRow, "createdAt" | "sessionId"> | undefined, filter: RoomFilter): Promise<RoomIndexRow[]> {
    const { sql, bindings } = roomsPageQuery(limit, startAfter, filter);
    return this.ctx.storage.sql.exec<RoomSqlRow>(sql, ...bindings).toArray().map(roomOfSql);
  }

  /**
   * `BellmanStore.roomCounts`: one `GROUP BY` inside SQLite, nothing copied out but the page of groups.
   * ponytail: O(rooms) a read. If that is ever measured too slow, a `room_counts(kind, key, rooms)` table written in
   * the insert's and the delete's transactions is the upgrade.
   */
  async roomCounts(by: "owner" | "org", limit: number, after?: { rooms: number; key: string }): Promise<RoomCounts> {
    const sql = this.ctx.storage.sql;
    // NO_ORG is a constant with no quote in it, and no org id can be spelled that way (`isOrgId`).
    const keyOf = by === "owner" ? "created_by" : `COALESCE(org_id, '${NO_ORG}')`;
    const page = sql.exec<{ k: string; n: number }>(
      `SELECT ${keyOf} AS k, COUNT(*) AS n FROM rooms GROUP BY k` +
        (after ? " HAVING n < ? OR (n = ? AND k > ?)" : "") +
        " ORDER BY n DESC, k ASC LIMIT ?",
      ...(after ? [after.rooms, after.rooms, after.key] : []), limit + 1,
    ).toArray();
    const more = page.length > limit;
    const groups = page.slice(0, limit);
    const keys = groups.map((g) => g.k);
    const total = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM rooms").one().n;
    const orgs = by === "org"
      ? keys.map((k) => (k === NO_ORG ? null : k))
      : sql.exec<{ org_id: string | null }>(
        "SELECT DISTINCT org_id FROM rooms WHERE created_by IN (SELECT value FROM json_each(?))", JSON.stringify(keys),
      ).toArray().map((r) => r.org_id);
    const labels = by === "owner"
      ? await this.handlesOf(keys)
      : new Map((await Promise.all(keys.filter((k) => k !== NO_ORG).map(async (k) => [k, (await this.getOrg(k))?.name] as const)))
        .flatMap(([k, name]) => (name === undefined ? [] : [[k, name] as const])));
    const last = groups.at(-1);
    return {
      total,
      groups: groups.map((g) => ({ key: g.k, label: labels.get(g.k) ?? null, rooms: g.n })),
      next: more && last ? `${last.n}:${last.k}` : null,
      orgs,
    };
  }

  /** `uh:<id>` for each id, in gets of at most 128 keys. */
  async handlesOf(userIds: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (let i = 0; i < userIds.length; i += 128) {
      const got = await this.ctx.storage.get<string>(userIds.slice(i, i + 128).map((id) => `uh:${id}`));
      for (const [key, handle] of got) out.set(key.slice("uh:".length), handle);
    }
    return out;
  }

  async indexRoom(room: RoomIndexRow): Promise<void> {
    insertRoom(this.ctx.storage.sql, room);
  }

  /** The purge's (#65), and a list page's for a row whose room is gone. Idempotent. */
  async dropRoomIndex(sessionId: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM rooms WHERE session_id = ?", sessionId);
  }

  /**
   * One window of the backfill's walk (#471): of at most `limit` rows of the account indexes (`um:`, `uo:`, `us:`,
   * which sort together and in that order), the rooms they name that have no `rooms` row, and the key to go on from,
   * null at the end. Every index row's key ends in its room's id, which holds no colon; a sign-in record and
   * `us:count` are not numbers, and are passed over.
   */
  async unindexedRooms(limit: number, after?: string): Promise<{ sessionIds: string[]; next: string | null }> {
    const page = await this.ctx.storage.list<unknown>({
      ...(after === undefined ? { start: "um:" } : { startAfter: after }), end: "ut", limit,
    });
    const named = new Set<string>();
    for (const [key, value] of page) {
      if (/^u[mos]:/.test(key) && typeof value === "number" && key.indexOf(":", 3) !== -1) {
        named.add(key.slice(key.lastIndexOf(":") + 1));
      }
    }
    const ids = [...named];
    // One bound parameter whatever the window's size, clear of SQLite's limit on them.
    const held = new Set(this.ctx.storage.sql.exec<{ session_id: string }>(
      "SELECT session_id FROM rooms WHERE session_id IN (SELECT value FROM json_each(?))", JSON.stringify(ids),
    ).toArray().map((r) => r.session_id));
    return { sessionIds: ids.filter((id) => !held.has(id)), next: page.size < limit ? null : [...page.keys()].at(-1)! };
  }

  /**
   * One window of this person's created-room index, ids only, starting after
   * `startAfter` when given.
   *
   * Paged rather than limited, because the registry cannot tell a live room from
   * a closed one — the room is in another object — so the caller that CAN
   * (`DurableObjectStore.sessionsCreatedBy`) walks these windows and keeps going
   * until it has `limit` live ids. Applying `limit` here was the bug: a lapse
   * walk spent its whole budget on closed rooms and never reached the live ones,
   * which silently did nothing for exactly the accounts that use Bellman most
   * (#75).
   */
  async createdIndexPage(userId: string, limit: number, startAfter?: string): Promise<string[]> {
    return this.#ownIds("us", userId, limit, startAfter);
  }

  /**
   * Forget that this person created this room. Called by the sweep above as it
   * meets a closed room, so a dead row is paid for once rather than on every
   * listing for the life of the account — the index was never pruned at all
   * before (#75, #115).
   *
   * Only the `us:` half. `um:` is history and keeps its rows deliberately: its
   * contract is rooms a person HELD a handle in, closed ones included, until the room
   * is purged (`dropMembershipIndex`).
   */
  async dropCreatedIndex(userId: string, sessionId: string): Promise<void> {
    await this.ctx.storage.delete(`us:${userId}:${sessionId}`);
  }

  /**
   * Forget that this person held a handle in this room: the purge's (#65), and only
   * the purge's. A closed room stays in `um:` as history, but a room that has been
   * purged is no room at all, and a row naming it would list something no read can
   * open. Idempotent, so a purge retried after a crash drops it again.
   */
  async dropMembershipIndex(userId: string, sessionId: string): Promise<void> {
    await this.ctx.storage.delete(`um:${userId}:${sessionId}`);
  }

  /**
   * `um:<userId>:<sessionId>` — which rooms a person holds a handle in.
   *
   * The same shape as `us:` above, and the same collision, so it is read through #ownIds too.
   *
   * Keyed by user rather than by member, so a person who joined the same room
   * from two machines is one entry — the put is idempotent, and the panel wants
   * the room once.
   *
   * **Members who joined before this deploy are not in here, creators of rooms
   * that already existed included.** For the rooms `us:` knows about, a backfill
   * is possible in principle — `us:` enumerates their creators and each session
   * lists its members — and is not worth walking the registry for a listing that
   * fills itself in as older rooms end. Older rooms have no list to enumerate
   * (see `us:`), so for them their end is the only repair. Until then a joined
   * room is missing from one screen, which is not a room lost.
   *
   * **Members who joined after this deploy can be missing too, creators
   * included.** `DurableObjectStore` puts this row once the seat has committed,
   * and logs a failed put rather than throwing it (`writeIndex`), deliberately:
   * a throw would report a failed join for a seat that had already landed.
   * Nothing rebuilds the row. The gap above only shrinks, as those rooms end;
   * this one also grows whenever a put fails. A creator's `us:` row is a
   * separate put, so either row can land without the other.
   */
  async indexMembership(userId: string, sessionId: string): Promise<void> {
    await this.ctx.storage.put(`um:${userId}:${sessionId}`, Date.now());
  }

  async sessionsJoinedBy(userId: string, limit: number): Promise<string[]> {
    return this.#ownIds("um", userId, limit);
  }

  /**
   * The session ids under `<tag>:<userId>:` in key order, at most `limit` of them, past
   * `startAfter` when given; `us:` and `um:` read through here. A row whose rest holds a colon
   * is someone else's, whose id extends this one past it, since a session id holds none (the
   * reason `#signed` gives for `hs:`). It is listed past rather than returned, so it takes none
   * of the window's places (#295).
   */
  async #ownIds(tag: "us" | "um", userId: string, limit: number, startAfter?: string): Promise<string[]> {
    const prefix = `${tag}:${userId}:`;
    const ids: string[] = [];
    let after = startAfter === undefined ? undefined : `${prefix}${startAfter}`;
    while (ids.length < limit) {
      const want = limit - ids.length;
      const page = await this.ctx.storage.list<number>({
        prefix, limit: want, ...(after === undefined ? {} : { startAfter: after }),
      });
      for (const key of page.keys()) {
        after = key;
        const id = key.slice(prefix.length);
        if (!id.includes(":")) ids.push(id);
      }
      if (page.size < want) break;
    }
    return ids;
  }

  /**
   * `uo:<org>:<room>` — which rooms an org sat in (#65, D5), for the admin's list of the
   * closed ones. The same shape as `um:`, keyed by org, so a room several of an org's people
   * joined is one entry, and a room people from two orgs joined is in both lists.
   *
   * **It starts at its deploy, like the two above.** A room created before it is not listed,
   * and cannot be backfilled: this registry has never held a list of rooms to walk. The
   * admin's read of such a room by id does not use the index and works. And a write that fails
   * is logged rather than thrown (`DurableObjectStore.writeIndex`), for the reason `um:` gives,
   * so a room can be missing from the list and present for the read.
   *
   * Kept for a closed room, which is what it is for, and dropped by the purge
   * (`dropOrgIndex`).
   */
  async indexOrg(orgId: string, sessionId: string): Promise<void> {
    await this.ctx.storage.put(`${orgRoomPrefix(orgId)}${sessionId}`, Date.now());
  }

  async sessionsForOrg(orgId: string, limit: number): Promise<string[]> {
    const prefix = orgRoomPrefix(orgId);
    const map = await this.ctx.storage.list<number>({ prefix, limit });
    return [...map.keys()].map((k) => k.slice(prefix.length));
  }

  /** The purge's (#65), and only the purge's: a room that is gone is no room any org sat in. Idempotent. */
  async dropOrgIndex(orgId: string, sessionId: string): Promise<void> {
    await this.ctx.storage.delete(`${orgRoomPrefix(orgId)}${sessionId}`);
  }

  async recordCreate(userId: string): Promise<void> {
    await this.#recordMonth(`cr:${userId}`);
  }

  /**
   * The monthly create count's rule, `cr:`, shared by its count and its record.
   * `#private`, as `#deliver` is: a Durable Object answers RPC for every method on
   * its class, and these read and write any key they are handed.
   */
  async #countMonth(key: string): Promise<number> {
    const list = (await this.ctx.storage.get<number[]>(key)) ?? [];
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    return list.filter((t) => t >= monthStart).length;
  }

  async #recordMonth(key: string): Promise<void> {
    const list = (await this.ctx.storage.get<number[]>(key)) ?? [];
    list.push(Date.now());
    // Only the current month is ever counted, so drop anything well past it —
    // otherwise this key grows for the life of the account.
    const cutoff = Date.now() - 62 * 24 * 60 * 60 * 1000;
    await this.ctx.storage.put(key, list.filter((t) => t >= cutoff));
  }

  /**
   * `pr:<userId>:<name>` — a person's saved presets (designer spec D4). A name is a slug and
   * holds no separator, but an operator-issued user id may hold a colon, as the `us:` index says,
   * so a read keeps only a row whose rest is its own preset's name. Storage lists keys in order,
   * which is the names' code-unit order.
   */
  async listPresets(userId: string): Promise<SavedPreset[]> {
    return this.#presets(this.ctx.storage, userId);
  }

  async getPreset(userId: string, name: string): Promise<SavedPreset | undefined> {
    return this.#preset(this.ctx.storage, userId, name);
  }

  /**
   * The count and the write in one transaction. It awaits nothing but storage, which is why the
   * input gate kept a second save from counting between them before the transaction did; the
   * transaction holds if a later edit puts anything else there (worker-tests/preset-race.test.ts).
   */
  async putPreset(userId: string, preset: SavedPreset, cap: number): Promise<"saved" | "full"> {
    return this.ctx.storage.transaction<"saved" | "full">(async (txn) => {
      if ((await this.#preset(txn, userId, preset.name)) === undefined) {
        if ((await this.#presets(txn, userId)).length >= cap) return "full";
      }
      await txn.put(`pr:${userId}:${preset.name}`, preset);
      return "saved";
    });
  }

  /** A person's presets, read through `storage`: the object's, or a transaction's handle. */
  async #presets(
    storage: { list<T>(options: { prefix: string }): Promise<Map<string, T>> },
    userId: string,
  ): Promise<SavedPreset[]> {
    const prefix = `pr:${userId}:`;
    const map = await storage.list<SavedPreset>({ prefix });
    // A key under this prefix whose rest is not its own preset's name belongs to someone whose id
    // extends this one past a colon. It is not this person's.
    return [...map].filter(([key, p]) => key === prefix + p.name).map(([, p]) => presetInNewWords(p));
  }

  /** The listing's guard for one name: the record under the key must be the preset asked for. */
  async #preset(
    storage: { get<T>(key: string): Promise<T | undefined> },
    userId: string,
    name: string,
  ): Promise<SavedPreset | undefined> {
    const p = await storage.get<SavedPreset>(`pr:${userId}:${name}`);
    return p && p.name === name ? presetInNewWords(p) : undefined;
  }

  /** Only a record that is this person's, by the listing's guard. */
  async deletePreset(userId: string, name: string): Promise<boolean> {
    if ((await this.getPreset(userId, name)) === undefined) return false;
    return this.ctx.storage.delete(`pr:${userId}:${name}`);
  }

  async handleOf(userId: string): Promise<string | undefined> {
    return this.ctx.storage.get<string>(`uh:${userId}`);
  }

  async userOfHandle(handle: string): Promise<string | undefined> {
    return this.ctx.storage.get<string>(`hn:${handle}`);
  }

  /**
   * `BellmanStore.handleHolders`: one list of the `uh:` rows, the user id being all of the key past the prefix, so an id
   * that holds a colon is read whole. Storage lists keys in ascending order, which is the user id order the method promises.
   */
  async handleHolders(): Promise<{ userId: string; handle: string }[]> {
    const rows = await this.ctx.storage.list<string>({ prefix: "uh:" });
    return [...rows].map(([key, handle]) => ({ userId: key.slice("uh:".length), handle }));
  }

  async claimHandle(userId: string, handle: string): Promise<"claimed" | "taken"> {
    return this.ctx.storage.transaction(async (txn) => {
      const holder = await txn.get<string>(`hn:${handle}`);
      if (holder !== undefined) return holder === userId ? "claimed" : "taken";
      const old = await txn.get<string>(`uh:${userId}`);
      if (old !== undefined) await txn.delete(`hn:${old}`);
      await txn.put({ [`hn:${handle}`]: userId, [`uh:${userId}`]: handle });
      return "claimed";
    });
  }

  async releaseHandle(userId: string): Promise<void> {
    await this.ctx.storage.transaction((txn) => this.#release(txn, userId));
  }

  async releaseHandleNamed(handle: string): Promise<string | undefined> {
    return this.ctx.storage.transaction(async (txn) => {
      const userId = await txn.get<string>(`hn:${handle}`);
      if (userId !== undefined) await this.#release(txn, userId);
      return userId;
    });
  }

  /** A person's handle and every signature, inside the caller's transaction. */
  async #release(txn: DurableObjectTransaction, userId: string): Promise<void> {
    const handle = await txn.get<string>(`uh:${userId}`);
    const signed = (await this.#signed(txn, userId)).map(([sessionId]) => `hs:${userId}:${sessionId}`);
    const keys = [`uh:${userId}`, ...signed, ...(handle === undefined ? [] : [`hn:${handle}`])];
    // A delete takes at most KEYS_PER_CALL keys.
    for (let i = 0; i < keys.length; i += KEYS_PER_CALL) await txn.delete(keys.slice(i, i + KEYS_PER_CALL));
  }

  async signRoom(userId: string, sessionId: string, at: number): Promise<string | undefined> {
    return this.ctx.storage.transaction(async (txn) => {
      const handle = await txn.get<string>(`uh:${userId}`);
      if (handle !== undefined) await txn.put(`hs:${userId}:${sessionId}`, at);
      return handle;
    });
  }

  async unsignRoom(userId: string, sessionId: string): Promise<void> {
    await this.ctx.storage.delete(`hs:${userId}:${sessionId}`);
  }

  async signedRooms(userId: string): Promise<{ sessionId: string; signedAt: number }[]> {
    return (await this.#signed(this.ctx.storage, userId))
      .map(([sessionId, signedAt]) => ({ sessionId, signedAt }))
      .sort((a, b) => b.signedAt - a.signedAt || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  }

  /**
   * `hs:<userId>:<sessionId>` — the rooms a person signed (bylines spec D2), as `[sessionId, signedAt]`.
   * The same shape as `pr:`, so the same collision: an operator-issued user id may hold a colon, and
   * one person's prefix then covers the rows of someone whose id extends it. A session id is
   * `qs_<uuid>` and holds none, so a key with a colon past this person's prefix is not theirs. The read
   * and the release both list through here, so they agree on whose rows these are.
   */
  async #signed(
    storage: { list<T>(options: { prefix: string }): Promise<Map<string, T>> },
    userId: string,
  ): Promise<[string, number][]> {
    const prefix = `hs:${userId}:`;
    const rows = await storage.list<number>({ prefix });
    return [...rows]
      .map(([key, signedAt]): [string, number] => [key.slice(prefix.length), signedAt])
      .filter(([sessionId]) => !sessionId.includes(":"));
  }

  async bylineFor(userId: string, sessionId: string): Promise<string | undefined> {
    const [handle, signed] = await Promise.all([
      this.ctx.storage.get<string>(`uh:${userId}`),
      this.ctx.storage.get<number>(`hs:${userId}:${sessionId}`),
    ]);
    return handle !== undefined && signed !== undefined ? handle : undefined;
  }

  /**
   * The record and the counter move together, or the count drifts from the
   * records it is meant to count.
   *
   * The counter starts at 0 and only ever increments on a first insert. It is
   * never seeded by reading the keys back, which is how AuthDO's client count
   * came to report 2 for one registration (#122): there were no users before
   * this landed, so 0 is the true starting point and there is nothing to seed.
   */
  async recordSignIn(userId: string, now: number, githubLogin?: string, googleEmail?: string, ref?: string): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const seen = await txn.get<UserRecord>(userKey(userId));
      if (!seen) await txn.put(USER_COUNT, ((await txn.get<number>(USER_COUNT)) ?? 0) + 1);
      const login = githubLogin ?? seen?.githubLogin;
      const email = googleEmail ?? seen?.googleEmail;
      // Set by the insert alone, in the same transaction that decides it is one (BellmanStore.recordSignIn).
      const tag = seen ? seen.ref : ref;
      await txn.put(userKey(userId), {
        userId,
        firstSeenAt: seen?.firstSeenAt ?? now,
        lastSeenAt: now,
        ...(login === undefined ? {} : { githubLogin: login }),
        ...(email === undefined ? {} : { googleEmail: email }),
        ...(tag === undefined ? {} : { ref: tag }),
      } satisfies UserRecord);
    });
  }

  async countUsers(): Promise<number> {
    return (await this.ctx.storage.get<number>(USER_COUNT)) ?? 0;
  }

  /**
   * `BellmanStore.listUsers`. Three kinds of row share `us:`: the sign-in records, `us:count`, and the created-room
   * index (`us:<userId>:<sessionId>`, a number; `indexSession`). A sign-in record is the object whose key is
   * `userKey` of its own id, so that is what is kept, whatever the id's shape: `countUsers` counts every one.
   *
   * ponytail: the list walks the room index too, one row per room ever created; give sign-in records a prefix of
   * their own when that index is large.
   */
  async listUsers(limit: number): Promise<UserRecord[]> {
    const rows = await this.ctx.storage.list<unknown>({ prefix: "us:" });
    const records = [...rows].flatMap(([key, value]) => {
      const r = value as Partial<UserRecord> | null;
      return typeof r === "object" && r !== null && typeof r.userId === "string" && key === userKey(r.userId)
        && typeof r.firstSeenAt === "number" && typeof r.lastSeenAt === "number"
        ? [{
            userId: r.userId, firstSeenAt: r.firstSeenAt, lastSeenAt: r.lastSeenAt,
            ...(typeof r.githubLogin === "string" ? { githubLogin: r.githubLogin } : {}),
            ...(typeof r.googleEmail === "string" ? { googleEmail: r.googleEmail } : {}),
            ...(typeof r.ref === "string" ? { ref: r.ref } : {}),
          }]
        : [];
    });
    return firstSignInFirst(records).slice(0, limit);
  }

  /**
   * The write a room's outbox delivers as `creator_ban`: the check and the write in one transaction, and
   * only while the creator holds no ban on the account, so a redelivery and an eviction that asks again
   * both keep the first ban.
   */
  async putCreatorBan(creatorId: string, ban: CreatorBan): Promise<void> {
    const key = creatorBanKey(creatorId, ban.userId);
    await this.ctx.storage.transaction(async (txn) => {
      if ((await txn.get(key)) === undefined) await txn.put(key, ban);
    });
  }

  /** This creator's rows, oldest first. The prefix ends at the colon after their encoded id, so it reaches no other creator's. */
  async creatorBans(creatorId: string): Promise<CreatorBan[]> {
    const rows = await this.ctx.storage.list<CreatorBan>({ prefix: creatorBanPrefix(creatorId) });
    return [...rows.values()].sort(oldestFirst);
  }

  /** Found and deleted in one transaction. A string that is not a ban id is answered before storage is read. */
  async liftCreatorBan(creatorId: string, banId: string): Promise<boolean> {
    if (!isBanId(banId)) return false;
    return this.ctx.storage.transaction(async (txn) => {
      const rows = await txn.list<CreatorBan>({ prefix: creatorBanPrefix(creatorId) });
      const found = [...rows].find(([, ban]) => ban.banId === banId);
      if (found === undefined) return false;
      await txn.delete(found[0]);
      return true;
    });
  }

  /** One read, for a seating. */
  async isBannedByCreator(creatorId: string, userId: string): Promise<boolean> {
    return (await this.ctx.storage.get(creatorBanKey(creatorId, userId))) !== undefined;
  }

  async suspend(userId: string, s: Suspension): Promise<void> {
    await this.ctx.storage.put(suspensionKey(userId), s);
  }

  async unsuspend(userId: string): Promise<boolean> {
    return this.ctx.storage.delete(suspensionKey(userId));
  }

  async isSuspended(userId: string): Promise<boolean> {
    return (await this.ctx.storage.get(suspensionKey(userId))) !== undefined;
  }

  /**
   * `BellmanStore.fileReport`, in one transaction: the fold's read, the day's count and the writes are one step, so
   * two filings cannot both pass the limit or both miss each other's fold. A fold and a refusal write nothing. The
   * filer's times are pruned to the day on the write that adds one, so a row never holds more than the limit.
   */
  async fileReport(r: NewReport, now: number): Promise<FiledReport> {
    return this.ctx.storage.transaction(async (txn): Promise<FiledReport> => {
      const foldKey = reportFoldKey(r.reporterUserId, r.sessionId, targetKey(r.target));
      const foldedId = await txn.get<string>(foldKey);
      const open = foldedId === undefined ? undefined : await txn.get<Report>(reportKey(foldedId));
      if (open?.resolvedAt === null) return { outcome: "folded", report: open };
      const timesKey = reportTimesKey(r.reporterUserId);
      const kept = withinWindow((await txn.get<number[]>(timesKey)) ?? [], now);
      if (kept.length >= REPORTS_PER_DAY) return { outcome: "limited", retryAfterMs: kept[0] + REPORT_WINDOW_MS - now };
      const report: Report = { ...r, id: reportId(now), at: now, resolvedAt: null, resolution: null, resolvedBy: null };
      await txn.put<unknown>({
        [reportKey(report.id)]: report,
        [foldKey]: report.id,
        [timesKey]: [...kept, now],
        [reportOpenKey(report.id)]: report.id,
        ...(reachesCreator(r) ? { [reportCreatorKey(r.creatorId, r.sessionId, report.id)]: report.id } : {}),
      });
      return { outcome: "filed", report };
    });
  }

  /**
   * This creator's rows for this room, newest first. The prefix ends at the colon after the room's id, so it reaches no
   * other room's.
   *
   * ponytail: a room's reports are read whole. A limit and a cursor if a public room ever gathers thousands.
   */
  async roomReports(creatorId: string, sessionId: string): Promise<Report[]> {
    const ids = [...(await this.ctx.storage.list<string>({
      prefix: reportCreatorPrefix(creatorId, sessionId), reverse: true,
    })).values()];
    const rows = await getRows<Report>(this.ctx.storage, ids.map(reportKey));
    return ids.flatMap((id) => rows.get(reportKey(id)) ?? []);
  }

  /**
   * `BellmanStore.listReports`: the open reports, from the `ro:` rows, newest first and at most `limit`, then the resolved
   * ones to fill what is left, which is none when the open ones fill the cut. When the open reports are fewer than `limit`
   * these are all of them, so at most that many of the newest `limit` reports are open and the rest of those are resolved:
   * reading `limit` rows of the queue finds every resolved report the cut needs. Neither read is more than `limit` rows,
   * however many reports the registry holds.
   */
  async listReports(limit: number): Promise<Report[]> {
    const openIds = [...(await this.ctx.storage.list<string>({ prefix: REPORT_OPEN_PREFIX, reverse: true, limit })).values()];
    const rows = await getRows<Report>(this.ctx.storage, openIds.map(reportKey));
    const open = openIds.flatMap((id) => rows.get(reportKey(id)) ?? []);
    const newest = [...(await this.ctx.storage.list<Report>({ prefix: REPORT_PREFIX, reverse: true, limit })).values()];
    return [...open, ...newest.filter((r) => r.resolvedAt !== null).slice(0, limit - open.length)];
  }

  /**
   * `BellmanStore.resolveReport`, in one transaction: the stamp, the end of the fold and the date of the deletion
   * land together. The due row takes the earlier of what it holds and this report's date, so a report resolved after
   * another never moves the alarm back; `#purgeReports` sets it to the next date when it runs. The alarm is pointed
   * at it after the commit, because `reArm()` reads the due rows the commit wrote.
   */
  async resolveReport(id: string, resolution: { note: string; by: string }, now: number): Promise<Report | undefined> {
    const outcome = await this.ctx.storage.transaction(async (txn) => {
      const report = await txn.get<Report>(reportKey(id));
      // An unknown id answers nothing, and a resolved report is answered as it is: the first resolution stands.
      if (report === undefined || report.resolvedAt !== null) return { report, scheduled: false };
      const done: Report = { ...report, resolvedAt: now, resolution: resolution.note, resolvedBy: resolution.by };
      const purgeAt = now + REPORT_RETENTION_MS;
      const due = await txn.get<number>(dueKey(REPORT_PURGE_HANDLER));
      await txn.delete([reportFoldKey(report.reporterUserId, report.sessionId, targetKey(report.target)), reportOpenKey(id)]);
      await txn.put<unknown>({
        [reportKey(id)]: done,
        [reportPurgeKey(purgeAt, id)]: id,
        [dueKey(REPORT_PURGE_HANDLER)]: due === undefined ? purgeAt : Math.min(due, purgeAt),
      });
      return { report: done, scheduled: true };
    });
    if (outcome.scheduled) await this.driver.reArm();
    return outcome.report;
  }
}

/**
 * The `rooms` table, and the room index's old KV rows moved into it (dash#94): each `rm:` row is inserted and
 * deleted, then each `ri:` row (its by-id pointer) is deleted. `INSERT OR IGNORE`, so a room already in the table
 * keeps its row, and a second wake moves nothing. After a rollback, the rooms an older Worker indexed as `rm:` move
 * on the next wake. Run inside one `transactionSync`, so it lands whole or not at all.
 * ponytail: the same ceiling as `migrateAudit`, about two million rows inside blockConcurrencyWhile's 30 s.
 */
function migrateRoomIndex(storage: DurableObjectStorage): void {
  for (const ddl of ROOMS_SCHEMA) storage.sql.exec(ddl);
  moveKv<RoomIndexRow>(storage, "rm:", (_key, row) => insertRoom(storage.sql, row));
  moveKv<string>(storage, "ri:", () => {});
}
