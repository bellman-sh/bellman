/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from "cloudflare:workers";
import { allKeysFor, grantKey, orgIndexKey, orgIndexPrefix, staleIndexKeys } from "./grant-index.js";
import type { GrantDelete, GrantWrite } from "./store.js";
import type {
  AuditEntry, EventType, Member, PendingConnect, PlanGrant, Session, SessionEvent,
} from "./types.js";
import type { BellmanStore, MemberPatch } from "./store.js";

/**
 * Durable Objects implementation of BellmanStore.
 *
 * Topology — three classes, each matching a real scope in the data:
 *
 *   SessionDO   one per session. Holds the session record, its events, and the
 *               live long-poll waiters. Every request for a session routes to
 *               the same instance, which is what makes an in-memory waiter list
 *               correct here and what gives read-then-register its atomicity.
 *   RegistryDO  singleton. The join-code index, pending connect tokens, and
 *               per-user monthly create counts — the three lookups that cannot
 *               live inside a session because they are how you FIND one.
 *   AuditDO     one per org, so an org's audit stream is physically its own
 *               object. A cross-org session writes to both, and neither org's
 *               DO is reachable from the other.
 *
 * On sweep(): MemoryStore scans every session on a timer. There is no cheap
 * global iteration across a DO namespace, so session TTL is enforced by a
 * per-object alarm and connect tokens expire lazily on read. sweep() is
 * therefore a no-op — see the comment on the method.
 */

const CURSOR_PAD = 12;
const eventKey = (cursor: number) => `e:${String(cursor).padStart(CURSOR_PAD, "0")}`;
const auditKey = (seq: number) => `a:${String(seq).padStart(CURSOR_PAD, "0")}`;

type Waiter = { after: number; resolve: (events: SessionEvent[]) => void };

/** The session record as stored — events live under their own keys. */
type StoredSession = Omit<Session, "events">;

// ---------------------------------------------------------------------------
// SessionDO — one per Bellman session
// ---------------------------------------------------------------------------

export class SessionDO extends DurableObject {
  /** Live long-polls. In-memory is correct: one instance serves this session. */
  private waiters: Waiter[] = [];

  private async stored(): Promise<StoredSession | undefined> {
    return this.ctx.storage.get<StoredSession>("session");
  }

  private async events(after = 0): Promise<SessionEvent[]> {
    const map = await this.ctx.storage.list<SessionEvent>({
      prefix: "e:",
      start: eventKey(after + 1),
    });
    return [...map.values()];
  }

  private async nextCursor(): Promise<number> {
    return ((await this.ctx.storage.get<number>("cursor")) ?? 0) + 1;
  }

  /**
   * One write, not two. Awaiting each put separately commits them separately,
   * and an interruption between the two leaves the event stored with `cursor`
   * still naming the one before it — so the next append computes the same
   * cursor and overwrites the event that is already there. A dropped message in
   * a log whose whole job is not to drop messages, and silent: the cursors stay
   * contiguous, so nothing downstream can tell.
   */
  private async writeEvent(e: SessionEvent): Promise<void> {
    await this.ctx.storage.put<unknown>({ [eventKey(e.cursor)]: e, cursor: e.cursor });
  }

  async createSession(s: Session): Promise<void> {
    const { events, ...rest } = s;
    // Session, seed events and cursor land together. Separately committed, an
    // interruption could leave a session with no events, or events with a
    // cursor of zero — and the alarm below is what expires it, so a session
    // that half-exists would also never be cleaned up.
    const seeded: Record<string, unknown> = { session: rest, cursor: 0 };
    for (const e of events) seeded[eventKey(e.cursor)] = e;
    if (events.length > 0) seeded.cursor = events[events.length - 1].cursor;
    await this.ctx.storage.put<unknown>(seeded);
    // TTL is enforced by this alarm rather than by a global sweep.
    await this.ctx.storage.setAlarm(s.expiresAt);
  }

  async getSession(): Promise<Session | undefined> {
    const s = await this.stored();
    if (!s) return undefined;
    await this.expireIfDue(s, Date.now());
    const fresh = await this.stored();
    if (!fresh) return undefined;
    return { ...fresh, events: await this.events(0) };
  }

  async consumeJoinCode(): Promise<void> {
    const s = await this.stored();
    if (!s || !s.joinCode) return;
    await this.ctx.storage.put("session", { ...s, joinCode: null });
  }

  /** Returns the code being replaced, so the caller can drop it from the registry. */
  async setJoinCode(code: string, expiresAt: number): Promise<string | null> {
    const s = await this.stored();
    if (!s) return null;
    const previous = s.joinCode;
    await this.ctx.storage.put("session", { ...s, joinCode: code, joinCodeExpiresAt: expiresAt });
    return previous;
  }

  async addMember(member: Member): Promise<void> {
    const s = await this.stored();
    if (!s) return;
    await this.ctx.storage.put("session", { ...s, members: [...s.members, member] });
  }

  async updateMember(memberId: string, patch: MemberPatch): Promise<void> {
    const s = await this.stored();
    if (!s) return;
    const members = s.members.map((m) => {
      if (m.memberId !== memberId) return m;
      const next = { ...m };
      if (patch.brief !== undefined) next.brief = patch.brief;
      if (patch.capabilities !== undefined) next.capabilities = patch.capabilities;
      if (patch.leftAt !== undefined) next.leftAt = patch.leftAt;
      return next;
    });
    await this.ctx.storage.put("session", { ...s, members });
  }

  async closeSession(): Promise<void> {
    const s = await this.stored();
    if (!s) return;
    await this.ctx.storage.put("session", { ...s, closed: true });
  }

  async appendEvent(e: Omit<SessionEvent, "cursor" | "at">): Promise<SessionEvent> {
    const s = await this.stored();
    if (!s) throw new Error("Unknown session");
    const event: SessionEvent = { ...e, cursor: await this.nextCursor(), at: Date.now() };
    await this.writeEvent(event);
    this.wake(event);
    return event;
  }

  async eventsAfter(cursor: number): Promise<SessionEvent[]> {
    return this.events(cursor);
  }

  /**
   * The read and the registration must not be split by an await, or an event
   * appended in the gap wakes an empty waiter list and this poll hangs to its
   * own timeout. Storage is async here, so the read is awaited FIRST and the
   * registration then runs synchronously — no await between check and push.
   */
  async waitForEvents(cursor: number, waitMs: number): Promise<SessionEvent[]> {
    const immediate = await this.events(cursor);
    if (immediate.length > 0 || waitMs <= 0) return immediate;

    return new Promise<SessionEvent[]>((resolve) => {
      const w: Waiter = { after: cursor, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          resolve([]);
        }
      }, waitMs);
    });
  }

  /** Resolve every waiter this event is past, each from its own cursor. */
  private wake(event: SessionEvent): void {
    if (this.waiters.length === 0) return;
    const woken = this.waiters.filter((w) => event.cursor > w.after);
    this.waiters = this.waiters.filter((w) => event.cursor <= w.after);
    for (const w of woken) w.resolve([event]);
  }

  /** Session TTL fires here rather than in a global sweep. */
  async alarm(): Promise<void> {
    const s = await this.stored();
    if (s) await this.expireIfDue(s, Date.now());
  }

  private async expireIfDue(s: StoredSession, now: number): Promise<void> {
    if (s.closed || now <= s.expiresAt) return;
    await this.ctx.storage.put("session", { ...s, closed: true, joinCode: null });
    const event: SessionEvent = {
      cursor: await this.nextCursor(),
      type: "session_expired" as EventType,
      fromMemberId: "system",
      fromUserId: "system",
      fromLabel: "bellman",
      payload: { reason: "ttl" },
      refId: null,
      at: now,
    };
    await this.writeEvent(event);
    this.wake(event);
  }
}

// ---------------------------------------------------------------------------
// RegistryDO — singleton: how you FIND a session
// ---------------------------------------------------------------------------

/** One definition of "expired", so every path agrees on what a grant is. */
const lapsed = (grant: PlanGrant, now = Date.now()): boolean =>
  grant.expiresAt !== null && now > grant.expiresAt;

export class RegistryDO extends DurableObject {
  async putJoinCode(code: string, sessionId: string): Promise<void> {
    await this.ctx.storage.put(`jc:${code}`, sessionId);
  }

  async lookupJoinCode(code: string): Promise<string | undefined> {
    return this.ctx.storage.get<string>(`jc:${code}`);
  }

  async dropJoinCode(code: string): Promise<void> {
    await this.ctx.storage.delete(`jc:${code}`);
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
      await this.dropGrant(grant);
      return undefined;
    }
    return grant;
  }

  async deleteGrant(key: string): Promise<void> {
    const existing = await this.ctx.storage.get<PlanGrant>(grantKey(key));
    if (!existing) return;
    await this.dropGrant(existing);
  }

  async putGrantIfOwned(
    grant: PlanGrant,
    expectedOrgId: string | null
  ): Promise<"written" | "conflict"> {
    return this.ctx.storage.transaction(async (txn) => {
      const stored = await txn.get<PlanGrant>(grantKey(grant.key));
      // A lapsed grant is not a grant — the same rule getGrant applies. Letting
      // an expired record from another org answer this check would block the
      // key indefinitely, because nothing sweeps it until someone reads it.
      const previous = stored && !lapsed(stored) ? stored : undefined;
      if (previous && previous.orgId !== expectedOrgId) return "conflict" as const;
      // The stale entry to clear is the one actually in storage, expired or not.
      for (const stale of staleIndexKeys(stored, grant)) await txn.delete(stale);
      await txn.put(grantKey(grant.key), grant);
      await txn.put(orgIndexKey(grant.orgId, grant.key), grant);
      return "written" as const;
    });
  }

  async deleteGrantIfOwned(
    key: string,
    expectedOrgId: string | null
  ): Promise<"deleted" | "missing" | "conflict"> {
    return this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<PlanGrant>(grantKey(key));
      if (!existing) return "missing" as const;
      if (lapsed(existing)) {
        // Already gone as far as every reader is concerned; tidy it away and
        // say so, rather than reporting a revocation of something inert.
        for (const storageKey of allKeysFor(existing)) await txn.delete(storageKey);
        return "missing" as const;
      }
      if (existing.orgId !== expectedOrgId) return "conflict" as const;
      for (const storageKey of allKeysFor(existing)) await txn.delete(storageKey);
      return "deleted" as const;
    });
  }

  async putGrantIfSource(grant: PlanGrant, expectedSource: string): Promise<GrantWrite> {
    return this.ctx.storage.transaction(async (txn) => {
      const stored = await txn.get<PlanGrant>(grantKey(grant.key));
      const previous = stored && !lapsed(stored) ? stored : undefined;
      if (previous && previous.source !== expectedSource) return { outcome: "conflict" as const };
      for (const stale of staleIndexKeys(stored, grant)) await txn.delete(stale);
      await txn.put(grantKey(grant.key), grant);
      await txn.put(orgIndexKey(grant.orgId, grant.key), grant);
      return { outcome: "written" as const, previous };
    });
  }

  async deleteGrantIfSource(key: string, expectedSource: string): Promise<GrantDelete> {
    return this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<PlanGrant>(grantKey(key));
      if (!existing) return { outcome: "missing" as const };
      if (lapsed(existing)) {
        for (const storageKey of allKeysFor(existing)) await txn.delete(storageKey);
        return { outcome: "missing" as const };
      }
      if (existing.source !== expectedSource) return { outcome: "conflict" as const };
      for (const storageKey of allKeysFor(existing)) await txn.delete(storageKey);
      return { outcome: "deleted" as const, removed: existing };
    });
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
    });
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
          await this.dropGrant(grant);
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

  /**
   * Remove both copies of a grant. Every delete path goes through here, and in
   * one transaction: half a delete leaves the grant listed but unresolvable,
   * or resolvable but unlisted.
   */
  private async dropGrant(grant: PlanGrant): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      for (const storageKey of allKeysFor(grant)) {
        await txn.delete(storageKey);
      }
    });
  }

  async countCreatesThisMonth(userId: string): Promise<number> {
    const list = (await this.ctx.storage.get<number[]>(`cr:${userId}`)) ?? [];
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    return list.filter((t) => t >= monthStart).length;
  }

  async recordCreate(userId: string): Promise<void> {
    const key = `cr:${userId}`;
    const list = (await this.ctx.storage.get<number[]>(key)) ?? [];
    list.push(Date.now());
    // Only the current month is ever counted, so drop anything well past it —
    // otherwise this key grows for the life of the account.
    const cutoff = Date.now() - 62 * 24 * 60 * 60 * 1000;
    await this.ctx.storage.put(key, list.filter((t) => t >= cutoff));
  }
}

// ---------------------------------------------------------------------------
// AuditDO — one per org
// ---------------------------------------------------------------------------

export class AuditDO extends DurableObject {
  async append(entry: AuditEntry): Promise<void> {
    const seq = ((await this.ctx.storage.get<number>("seq")) ?? 0) + 1;
    // Entry and sequence in one write: committed separately, an interruption
    // between them means the next entry reuses this sequence number and
    // overwrites it. An audit log that can quietly drop the record of a
    // privilege change is not an audit log.
    await this.ctx.storage.put<unknown>({ [auditKey(seq)]: entry, seq });
  }

  async recent(limit: number): Promise<AuditEntry[]> {
    const map = await this.ctx.storage.list<AuditEntry>({
      prefix: "a:",
      reverse: true,
      limit,
    });
    return [...map.values()].reverse();
  }
}

// ---------------------------------------------------------------------------
// The BellmanStore facade the Worker hands to buildServer()
// ---------------------------------------------------------------------------

export interface BellmanEnv {
  SESSION: DurableObjectNamespace<SessionDO>;
  REGISTRY: DurableObjectNamespace<RegistryDO>;
  AUDIT: DurableObjectNamespace<AuditDO>;
  BELLMAN_KEYS?: string;
}

export class DurableObjectStore implements BellmanStore {
  constructor(private env: BellmanEnv) {}

  private session(id: string) {
    return this.env.SESSION.get(this.env.SESSION.idFromName(id));
  }

  private get registry() {
    return this.env.REGISTRY.get(this.env.REGISTRY.idFromName("registry"));
  }

  private audit(orgId: string) {
    return this.env.AUDIT.get(this.env.AUDIT.idFromName(orgId));
  }

  async createSession(s: Session): Promise<void> {
    await this.session(s.id).createSession(s);
    if (s.joinCode) await this.registry.putJoinCode(s.joinCode, s.id);
  }

  async getSession(id: string): Promise<Session | undefined> {
    return this.session(id).getSession();
  }

  async getSessionByJoinCode(code: string): Promise<Session | undefined> {
    const id = await this.registry.lookupJoinCode(code);
    if (!id) return undefined;
    const s = await this.getSession(id);
    if (!s || s.closed) return undefined;
    if (s.joinCode !== code) return undefined; // consumed or rotated
    if (Date.now() > s.joinCodeExpiresAt) return undefined;
    return s;
  }

  async consumeJoinCode(sessionId: string): Promise<void> {
    const s = await this.getSession(sessionId);
    const code = s?.joinCode;
    await this.session(sessionId).consumeJoinCode();
    if (code) await this.registry.dropJoinCode(code);
  }

  async setJoinCode(sessionId: string, code: string, expiresAt: number): Promise<void> {
    const previous = await this.session(sessionId).setJoinCode(code, expiresAt);
    if (previous) await this.registry.dropJoinCode(previous);
    await this.registry.putJoinCode(code, sessionId);
  }

  async addMember(sessionId: string, member: Member): Promise<void> {
    await this.session(sessionId).addMember(member);
  }

  async updateMember(sessionId: string, memberId: string, patch: MemberPatch): Promise<void> {
    await this.session(sessionId).updateMember(memberId, patch);
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.session(sessionId).closeSession();
  }

  async appendEvent(
    sessionId: string,
    e: Omit<SessionEvent, "cursor" | "at">
  ): Promise<SessionEvent> {
    return this.session(sessionId).appendEvent(e);
  }

  async eventsAfter(sessionId: string, cursor: number): Promise<SessionEvent[]> {
    return this.session(sessionId).eventsAfter(cursor);
  }

  async waitForEvents(
    sessionId: string,
    cursor: number,
    waitMs: number
  ): Promise<SessionEvent[]> {
    return this.session(sessionId).waitForEvents(cursor, waitMs);
  }

  async putPendingConnect(p: PendingConnect): Promise<void> {
    await this.registry.putPendingConnect(p);
  }

  async takePendingConnect(token: string): Promise<PendingConnect | undefined> {
    return this.registry.takePendingConnect(token);
  }

  async countCreatesThisMonth(userId: string): Promise<number> {
    return this.registry.countCreatesThisMonth(userId);
  }

  async recordCreate(userId: string): Promise<void> {
    await this.registry.recordCreate(userId);
  }

  async getGrant(key: string): Promise<PlanGrant | undefined> {
    return this.registry.getGrant(key);
  }

  async putGrant(grant: PlanGrant): Promise<void> {
    await this.registry.putGrant(grant);
  }

  async deleteGrant(key: string): Promise<void> {
    await this.registry.deleteGrant(key);
  }

  async putGrantIfOwned(
    grant: PlanGrant,
    expectedOrgId: string | null
  ): Promise<"written" | "conflict"> {
    return this.registry.putGrantIfOwned(grant, expectedOrgId);
  }

  async deleteGrantIfOwned(
    key: string,
    expectedOrgId: string | null
  ): Promise<"deleted" | "missing" | "conflict"> {
    return this.registry.deleteGrantIfOwned(key, expectedOrgId);
  }

  async putGrantIfSource(grant: PlanGrant, expectedSource: string): Promise<GrantWrite> {
    return this.registry.putGrantIfSource(grant, expectedSource);
  }

  async deleteGrantIfSource(key: string, expectedSource: string): Promise<GrantDelete> {
    return this.registry.deleteGrantIfSource(key, expectedSource);
  }

  async moveGrant(fromKey: string, toKey: string): Promise<void> {
    await this.registry.moveGrant(fromKey, toKey);
  }

  async listGrants(limit: number, orgId?: string | null): Promise<PlanGrant[]> {
    return this.registry.listGrants(limit, orgId);
  }

  async appendAudit(a: AuditEntry): Promise<void> {
    if (a.orgId === null) return; // no org, no audit stream to write to
    await this.audit(a.orgId).append(a);
  }

  async auditForOrg(orgId: string, limit: number): Promise<AuditEntry[]> {
    return this.audit(orgId).recent(limit);
  }

  /**
   * No-op by design. MemoryStore sweeps on a timer because it can iterate every
   * session cheaply; a DO namespace cannot. Session TTL is enforced by the
   * per-object alarm set in SessionDO.createSession, and connect tokens are
   * checked for expiry when taken. Nothing is left for a sweep to do.
   */
  async sweep(_now: number): Promise<void> {}
}
