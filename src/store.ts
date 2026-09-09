import type {
  AuditEntry, PendingConnect, Session, SessionEvent, EventType,
} from "./types.js";

const JOIN_CODE_TTL_MS = 15 * 60 * 1000;
const CONNECT_TOKEN_TTL_MS = 10 * 60 * 1000;

type Waiter = { after: number; resolve: (events: SessionEvent[]) => void };

/**
 * Storage boundary. Everything stateful goes through this interface so the
 * in-memory implementation can be replaced by Durable Objects / Redis without
 * touching tool logic.
 */
export interface QuoraiStore {
  createSession(s: Session): void;
  getSession(id: string): Session | undefined;
  getSessionByJoinCode(code: string): Session | undefined;
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

export class MemoryStore implements QuoraiStore {
  private sessions = new Map<string, Session>();
  private byJoinCode = new Map<string, string>();
  private pending = new Map<string, PendingConnect>();
  private creates = new Map<string, number[]>(); // userId -> timestamps
  private audit: AuditEntry[] = [];
  private waiters = new Map<string, Waiter[]>();

  createSession(s: Session): void {
    this.sessions.set(s.id, s);
    if (s.joinCode) this.byJoinCode.set(s.joinCode, s.id);
  }

  getSession(id: string): Session | undefined {
    const s = this.sessions.get(id);
    if (s) this.expireIfDue(s, Date.now());
    return s;
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

  consumeJoinCode(s: Session): void {
    if (s.joinCode) this.byJoinCode.delete(s.joinCode);
    s.joinCode = null;
  }

  appendEvent(sessionId: string, e: Omit<SessionEvent, "cursor" | "at">): SessionEvent {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session ${sessionId}`);
    const event: SessionEvent = { ...e, cursor: s.events.length + 1, at: Date.now() };
    s.events.push(event);
    const ws = this.waiters.get(sessionId) ?? [];
    this.waiters.set(sessionId, []);
    for (const w of ws) w.resolve(s.events.filter((ev) => ev.cursor > w.after));
    return event;
  }

  eventsAfter(sessionId: string, cursor: number): SessionEvent[] {
    const s = this.sessions.get(sessionId);
    if (!s) return [];
    return s.events.filter((e) => e.cursor > cursor);
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
    this.pending.set(p.token, p);
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
    this.audit.push(a);
  }

  auditForOrg(orgId: string, limit: number): AuditEntry[] {
    return this.audit.filter((a) => a.orgId === orgId).slice(-limit);
  }

  sweep(now: number): void {
    for (const s of this.sessions.values()) this.expireIfDue(s, now);
    for (const [token, p] of this.pending) {
      if (now > p.expiresAt) this.pending.delete(token);
    }
  }

  private expireIfDue(s: Session, now: number): void {
    if (!s.closed && now > s.expiresAt) {
      s.closed = true;
      if (s.joinCode) this.byJoinCode.delete(s.joinCode);
      s.joinCode = null;
      this.appendEvent(s.id, {
        type: "session_expired" as EventType,
        fromMemberId: "system",
        fromUserId: "system",
        fromLabel: "quorai",
        payload: { reason: "ttl" },
        refId: null,
      });
    }
  }
}

export const JOIN_CODE_TTL = JOIN_CODE_TTL_MS;
export const CONNECT_TOKEN_TTL = CONNECT_TOKEN_TTL_MS;
