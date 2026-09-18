/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from "cloudflare:workers";
import type {
  AuditEntry, EventType, Member, PendingConnect, Session, SessionEvent,
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

  private async writeEvent(e: SessionEvent): Promise<void> {
    await this.ctx.storage.put(eventKey(e.cursor), e);
    await this.ctx.storage.put("cursor", e.cursor);
  }

  async createSession(s: Session): Promise<void> {
    const { events, ...rest } = s;
    await this.ctx.storage.put("session", rest);
    await this.ctx.storage.put("cursor", 0);
    for (const e of events) await this.writeEvent(e);
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
    await this.ctx.storage.put(auditKey(seq), entry);
    await this.ctx.storage.put("seq", seq);
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
