import type {
  AuditEntry, Member, PendingConnect, Session, SessionEvent, EventType,
} from "./types.js";

const JOIN_CODE_TTL_MS = 15 * 60 * 1000;
const CONNECT_TOKEN_TTL_MS = 10 * 60 * 1000;

type Waiter = { after: number; resolve: (events: SessionEvent[]) => void };

/** Fields of a Member that may change after it is created. */
export type MemberPatch = Partial<Pick<Member, "brief" | "capabilities" | "leftAt">>;

/**
 * Storage boundary. Everything stateful goes through this interface so the
 * in-memory implementation can be replaced by Durable Objects / SQLite / Redis
 * without touching tool logic.
 *
 * Read methods return DETACHED copies. Callers must never mutate what they read
 * back and expect it to stick — every write has an explicit method here. That
 * rule is what makes the interface portable: a database-backed store cannot
 * hand out live references, so relying on them would silently break the port.
 */
export interface BellmanStore {
  createSession(s: Session): void;
  getSession(id: string): Session | undefined;
  getSessionByJoinCode(code: string): Session | undefined;

  /** Consume a session's single-use join code. Idempotent. */
  consumeJoinCode(sessionId: string): void;
  /** Append a member to a session. */
  addMember(sessionId: string, member: Member): void;
  /** Patch a member's mutable fields. Unknown session/member is a no-op. */
  updateMember(sessionId: string, memberId: string, patch: MemberPatch): void;
  /** Mark a session closed. Idempotent. */
  closeSession(sessionId: string): void;

  appendEvent(
    sessionId: string,
    e: Omit<SessionEvent, "cursor" | "at">
  ): SessionEvent;
  eventsAfter(sessionId: string, cursor: number): SessionEvent[];
  waitForEvents(sessionId: string, cursor: number, waitMs: number): Promise<SessionEvent[]>;

  putPendingConnect(p: PendingConnect): void;
  takePendingConnect(token: string): PendingConnect | undefined;

  countCreatesThisMonth(userId: string): number;
  recordCreate(userId: string): void;

  appendAudit(a: AuditEntry): void;
  auditForOrg(orgId: string, limit: number): AuditEntry[];

  sweep(now: number): void;
}

function detach<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryStore implements BellmanStore {
  private sessions = new Map<string, Session>();
  private byJoinCode = new Map<string, string>();
  private pending = new Map<string, PendingConnect>();
  private creates = new Map<string, number[]>(); // userId -> timestamps
  private audit: AuditEntry[] = [];
  private waiters = new Map<string, Waiter[]>();

  createSession(s: Session): void {
    const stored = detach(s);
    this.sessions.set(stored.id, stored);
    if (stored.joinCode) this.byJoinCode.set(stored.joinCode, stored.id);
  }

  getSession(id: string): Session | undefined {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    this.expireIfDue(s, Date.now());
    return detach(s);
  }

  getSessionByJoinCode(code: string): Session | undefined {
    const id = this.byJoinCode.get(code);
    if (!id) return undefined;
    const s = this.getSession(id);
    if (!s || s.closed) return undefined;
    if (s.joinCode !== code) return undefined; // consumed or rotated
    if (Date.now() > s.joinCodeExpiresAt) return undefined;
    return s;
  }

  consumeJoinCode(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || !s.joinCode) return;
    this.byJoinCode.delete(s.joinCode);
    s.joinCode = null;
  }

  addMember(sessionId: string, member: Member): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.members.push(detach(member));
  }

  updateMember(sessionId: string, memberId: string, patch: MemberPatch): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const m = s.members.find((mm) => mm.memberId === memberId);
    if (!m) return;
    if (patch.brief !== undefined) m.brief = detach(patch.brief);
    if (patch.capabilities !== undefined) m.capabilities = detach(patch.capabilities);
    if (patch.leftAt !== undefined) m.leftAt = patch.leftAt;
  }

  closeSession(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.closed = true;
  }

  appendEvent(sessionId: string, e: Omit<SessionEvent, "cursor" | "at">): SessionEvent {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session ${sessionId}`);
    const event: SessionEvent = { ...detach(e), cursor: s.events.length + 1, at: Date.now() };
    s.events.push(event);
    this.wake(s);
    return detach(event);
  }

  eventsAfter(sessionId: string, cursor: number): SessionEvent[] {
    const s = this.sessions.get(sessionId);
    if (!s) return [];
    return detach(s.events.filter((e) => e.cursor > cursor));
  }

  waitForEvents(sessionId: string, cursor: number, waitMs: number): Promise<SessionEvent[]> {
    const immediate = this.eventsAfter(sessionId, cursor);
    if (immediate.length > 0 || waitMs <= 0) return Promise.resolve(immediate);
    return new Promise((resolve) => {
      const w: Waiter = { after: cursor, resolve };
      const list = this.waiters.get(sessionId) ?? [];
      list.push(w);
      this.waiters.set(sessionId, list);
      setTimeout(() => {
        const cur = this.waiters.get(sessionId) ?? [];
        const idx = cur.indexOf(w);
        if (idx >= 0) {
          cur.splice(idx, 1);
          resolve([]);
        }
      }, waitMs).unref?.();
    });
  }

  putPendingConnect(p: PendingConnect): void {
    this.pending.set(p.token, detach(p));
  }

  takePendingConnect(token: string): PendingConnect | undefined {
    const p = this.pending.get(token);
    if (!p) return undefined;
    this.pending.delete(token); // single use
    if (Date.now() > p.expiresAt) return undefined;
    return p;
  }

  countCreatesThisMonth(userId: string): number {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    return (this.creates.get(userId) ?? []).filter((t) => t >= monthStart).length;
  }

  recordCreate(userId: string): void {
    const list = this.creates.get(userId) ?? [];
    list.push(Date.now());
    this.creates.set(userId, list);
  }

  appendAudit(a: AuditEntry): void {
    this.audit.push(detach(a));
  }

  auditForOrg(orgId: string, limit: number): AuditEntry[] {
    return detach(this.audit.filter((a) => a.orgId === orgId).slice(-limit));
  }

  sweep(now: number): void {
    for (const s of this.sessions.values()) this.expireIfDue(s, now);
    for (const [token, p] of this.pending) {
      if (now > p.expiresAt) this.pending.delete(token);
    }
  }

  /** Resolve every waiter on a session from its own cursor. */
  private wake(s: Session): void {
    const ws = this.waiters.get(s.id);
    if (!ws || ws.length === 0) return;
    this.waiters.set(s.id, []);
    for (const w of ws) w.resolve(detach(s.events.filter((ev) => ev.cursor > w.after)));
  }

  /** Operates on the canonical session; callers hold detached copies. */
  private expireIfDue(s: Session, now: number): void {
    if (s.closed || now <= s.expiresAt) return;
    s.closed = true;
    if (s.joinCode) this.byJoinCode.delete(s.joinCode);
    s.joinCode = null;
    const event: SessionEvent = {
      cursor: s.events.length + 1,
      type: "session_expired" as EventType,
      fromMemberId: "system",
      fromUserId: "system",
      fromLabel: "bellman",
      payload: { reason: "ttl" },
      refId: null,
      at: now,
    };
    s.events.push(event);
    this.wake(s);
  }
}

export const JOIN_CODE_TTL = JOIN_CODE_TTL_MS;
export const CONNECT_TOKEN_TTL = CONNECT_TOKEN_TTL_MS;
