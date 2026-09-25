import type {
  AuditEntry, Member, PendingConnect, PlanGrant, Session, SessionEvent, EventType,
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
 * EVERY METHOD IS ASYNC, including ones an in-memory store answers instantly.
 * That is not incidental. A Durable Objects port resolves a join code in one
 * DO and the session it names in another, and every cross-DO hop is RPC. A
 * synchronous signature here would be implementable only by MemoryStore, which
 * would make this interface a comment rather than a seam.
 *
 * Read methods return DETACHED copies. Callers must never mutate what they read
 * back and expect it to stick — every write has an explicit method here. That
 * rule is what makes the interface portable: a database-backed store cannot
 * hand out live references, so relying on them would silently break the port.
 */
/**
 * What a source-guarded write replaced, so the caller can tell a change from a
 * repeat and see which org a grant moved out of.
 *
 * Only the source-guarded pair reports this. The org-guarded pair the admin
 * route uses does not need it: that caller already knows what it sent and
 * audits its own action unconditionally. Billing is reacting to Stripe, where
 * the same event can arrive twice and a plan can move between orgs, so it has
 * to be told what actually happened.
 */
export interface GrantWrite {
  outcome: "written" | "conflict";
  previous?: PlanGrant;
}

export interface GrantDelete {
  outcome: "deleted" | "missing" | "conflict";
  removed?: PlanGrant;
}

export interface BellmanStore {
  createSession(s: Session): Promise<void>;
  getSession(id: string): Promise<Session | undefined>;
  getSessionByJoinCode(code: string): Promise<Session | undefined>;

  /** Consume a session's single-use join code. Idempotent. */
  consumeJoinCode(sessionId: string): Promise<void>;
  /** Issue a join code, retiring whatever the session had. False means frozen. */
  setJoinCode(sessionId: string, code: string, expiresAt: number): Promise<boolean>;
  /**
   * Append a member to a session, unless it is frozen. False means frozen.
   *
   * The refusal is here rather than only in the tool, because the tool reads
   * the session and then writes, and a freeze landing in that gap would let a
   * frozen room grow — which is the one thing freezing is for. Unlike the
   * cross-object races on #59 and #62, both halves live in the same object, so
   * this one can simply be made not to have a gap.
   */
  addMember(sessionId: string, member: Member): Promise<boolean>;
  /** Patch a member's mutable fields. Unknown session/member is a no-op. */
  updateMember(sessionId: string, memberId: string, patch: MemberPatch): Promise<void>;
  /** Mark a session closed. Idempotent. */
  closeSession(sessionId: string): Promise<void>;
  /** Freeze or thaw a session. null thaws. */
  freezeSession(sessionId: string, frozenAt: number | null): Promise<void>;
  /**
   * Sessions this user created, newest first is not promised — only that a
   * lapsed plan can find the rooms it has to freeze. The create *counts* used
   * for quota cannot answer that: they are timestamps, not identities.
   */
  sessionsCreatedBy(userId: string, limit: number): Promise<string[]>;

  /** Append an event. Null means the session is frozen, for the same reason. */
  appendEvent(
    sessionId: string,
    e: Omit<SessionEvent, "cursor" | "at">
  ): Promise<SessionEvent | null>;
  eventsAfter(sessionId: string, cursor: number): Promise<SessionEvent[]>;
  waitForEvents(sessionId: string, cursor: number, waitMs: number): Promise<SessionEvent[]>;

  putPendingConnect(p: PendingConnect): Promise<void>;
  takePendingConnect(token: string): Promise<PendingConnect | undefined>;

  countCreatesThisMonth(userId: string): Promise<number>;
  recordCreate(userId: string): Promise<void>;

  /** Plans granted at runtime. The operator's BELLMAN_USERS still outranks these. */
  getGrant(key: string): Promise<PlanGrant | undefined>;
  putGrant(grant: PlanGrant): Promise<void>;
  deleteGrant(key: string): Promise<void>;
  /**
   * Write a grant only if the key is unowned or already belongs to `expectedOrgId`.
   *
   * The ownership check and the write are one operation because they cannot be
   * two: a Durable Object's input gate covers one invocation, so a caller that
   * reads with getGrant and then writes has given the object a window to serve
   * somebody else's write for the same key in between.
   */
  putGrantIfOwned(grant: PlanGrant, expectedOrgId: string | null): Promise<"written" | "conflict">;
  /**
   * Delete a grant only if it belongs to `expectedOrgId`, and say what happened.
   *
   * "missing" and "conflict" are distinct on purpose: the caller must not audit
   * a revocation that did not occur, and must not report success for one.
   */
  deleteGrantIfOwned(key: string, expectedOrgId: string | null): Promise<"deleted" | "missing" | "conflict">;
  /**
   * Write a grant only if the key is unowned or already carries `expectedSource`.
   *
   * There are two writers with two different claims on a key. An admin claims
   * by org, which is what putGrantIfOwned checks; billing claims by having
   * written the record itself, because a subscription lapsing is no reason to
   * revoke a plan an operator granted by hand. Same atomicity argument either
   * way: the check and the write cannot be two calls.
   */
  putGrantIfSource(grant: PlanGrant, expectedSource: string): Promise<GrantWrite>;
  /** Delete a grant only if it carries `expectedSource`, and say what happened. */
  deleteGrantIfSource(key: string, expectedSource: string): Promise<GrantDelete>;
  /**
   * Re-file a grant under a new key, atomically. A no-op if `from` has none.
   *
   * Atomic because the caller is claiming an address-keyed grant onto the
   * subject that just proved it owns the address: write-then-delete would, on a
   * failed delete, leave the address key standing and claimable by whoever
   * holds that address next — the exact transfer claiming exists to stop.
   */
  moveGrant(fromKey: string, toKey: string): Promise<void>;
  /** Scoped to one org when given: grants are org-tenanted data. */
  listGrants(limit: number, orgId?: string | null): Promise<PlanGrant[]>;

  appendAudit(a: AuditEntry): Promise<void>;
  auditForOrg(orgId: string, limit: number): Promise<AuditEntry[]>;

  sweep(now: number): Promise<void>;
}

function detach<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryStore implements BellmanStore {
  private sessions = new Map<string, Session>();
  private byJoinCode = new Map<string, string>();
  private byCreator = new Map<string, Set<string>>();
  private pending = new Map<string, PendingConnect>();
  private creates = new Map<string, number[]>(); // userId -> timestamps
  private grants = new Map<string, PlanGrant>();
  private audit: AuditEntry[] = [];
  private waiters = new Map<string, Waiter[]>();

  async createSession(s: Session): Promise<void> {
    const stored = detach(s);
    this.sessions.set(stored.id, stored);
    if (stored.joinCode) this.byJoinCode.set(stored.joinCode, stored.id);
    const mine = this.byCreator.get(stored.createdBy) ?? new Set<string>();
    mine.add(stored.id);
    this.byCreator.set(stored.createdBy, mine);
  }

  async getSession(id: string): Promise<Session | undefined> {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    this.expireIfDue(s, Date.now());
    return detach(s);
  }

  async getSessionByJoinCode(code: string): Promise<Session | undefined> {
    const id = this.byJoinCode.get(code);
    if (!id) return undefined;
    const s = await this.getSession(id);
    if (!s || s.closed) return undefined;
    if (s.joinCode !== code) return undefined; // consumed or rotated
    if (Date.now() > s.joinCodeExpiresAt) return undefined;
    return s;
  }

  async consumeJoinCode(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s || !s.joinCode) return;
    this.byJoinCode.delete(s.joinCode);
    s.joinCode = null;
  }

  async setJoinCode(sessionId: string, code: string, expiresAt: number): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    if (s.frozenAt !== null) return false;
    if (s.joinCode) this.byJoinCode.delete(s.joinCode); // the old code stops resolving
    s.joinCode = code;
    s.joinCodeExpiresAt = expiresAt;
    this.byJoinCode.set(code, sessionId);
    return true;
  }

  async addMember(sessionId: string, member: Member): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    if (s.frozenAt !== null) return false;
    s.members.push(detach(member));
    return true;
  }

  async updateMember(
    sessionId: string,
    memberId: string,
    patch: MemberPatch
  ): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const m = s.members.find((mm) => mm.memberId === memberId);
    if (!m) return;
    if (patch.brief !== undefined) m.brief = detach(patch.brief);
    if (patch.capabilities !== undefined) m.capabilities = detach(patch.capabilities);
    if (patch.leftAt !== undefined) m.leftAt = patch.leftAt;
  }

  async closeSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.closed = true;
  }

  async freezeSession(sessionId: string, frozenAt: number | null): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.frozenAt = frozenAt;
  }

  async sessionsCreatedBy(userId: string, limit: number): Promise<string[]> {
    return [...(this.byCreator.get(userId) ?? [])].slice(0, limit);
  }

  async appendEvent(
    sessionId: string,
    e: Omit<SessionEvent, "cursor" | "at">
  ): Promise<SessionEvent | null> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session ${sessionId}`);
    if (s.frozenAt !== null) return null;
    const event: SessionEvent = { ...detach(e), cursor: s.events.length + 1, at: Date.now() };
    s.events.push(event);
    this.wake(s);
    return detach(event);
  }

  async eventsAfter(sessionId: string, cursor: number): Promise<SessionEvent[]> {
    const s = this.sessions.get(sessionId);
    if (!s) return [];
    return detach(s.events.filter((e) => e.cursor > cursor));
  }

  /**
   * Deliberately NOT declared `async`. The read and the waiter registration
   * must happen in the same synchronous turn: an `await` between them yields,
   * and an event appended in that gap calls wake() against an empty waiter
   * list, so this poll hangs until its own timeout — a lost wakeup. Callers
   * still get a Promise, so the interface is unchanged.
   *
   * A Durable Objects port gets this atomicity from the DO's single-threaded
   * execution, but the same rule applies: read and register without yielding.
   */
  waitForEvents(
    sessionId: string,
    cursor: number,
    waitMs: number
  ): Promise<SessionEvent[]> {
    const s = this.sessions.get(sessionId);
    const immediate = s ? detach(s.events.filter((e) => e.cursor > cursor)) : [];
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

  async putPendingConnect(p: PendingConnect): Promise<void> {
    this.pending.set(p.token, detach(p));
  }

  async takePendingConnect(token: string): Promise<PendingConnect | undefined> {
    const p = this.pending.get(token);
    if (!p) return undefined;
    this.pending.delete(token); // single use
    if (Date.now() > p.expiresAt) return undefined;
    return p;
  }

  async countCreatesThisMonth(userId: string): Promise<number> {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    return (this.creates.get(userId) ?? []).filter((t) => t >= monthStart).length;
  }

  async recordCreate(userId: string): Promise<void> {
    const list = this.creates.get(userId) ?? [];
    list.push(Date.now());
    this.creates.set(userId, list);
  }

  async getGrant(key: string): Promise<PlanGrant | undefined> {
    const grant = this.liveGrant(key);
    return grant && detach(grant);
  }

  /**
   * Deliberately synchronous, and the reason every guarded write below calls
   * it instead of `await this.getGrant(...)`.
   *
   * Those methods promise that the check and the mutation are one operation.
   * An `await` between them yields, and a second guarded writer can read the
   * same record, act on it, and have its write undone or its grant deleted by
   * the first one finishing against a value that is no longer there. The
   * Durable Object gets this from `storage.transaction`; here it comes from
   * not yielding, which only works if the read never awaits.
   *
   * Same rule, and the same reason, as `waitForEvents` above.
   */
  private liveGrant(key: string): PlanGrant | undefined {
    const grant = this.grants.get(key);
    if (!grant) return undefined;
    // A lapsed grant is not a grant. Deleting here keeps reads self-healing.
    if (grant.expiresAt !== null && Date.now() > grant.expiresAt) {
      this.grants.delete(key);
      return undefined;
    }
    return grant;
  }

  async putGrant(grant: PlanGrant): Promise<void> {
    this.grants.set(grant.key, detach(grant));
  }

  async deleteGrant(key: string): Promise<void> {
    this.grants.delete(key);
  }

  async putGrantIfOwned(
    grant: PlanGrant,
    expectedOrgId: string | null
  ): Promise<"written" | "conflict"> {
    // liveGrant, not the raw map: a lapsed grant is defined as absent
    // everywhere else, and reading past that here would let a dead record from
    // another org hold a key hostage until some unrelated read swept it.
    const existing = this.liveGrant(grant.key);
    if (existing && existing.orgId !== expectedOrgId) return "conflict";
    this.grants.set(grant.key, detach(grant));
    return "written";
  }

  async deleteGrantIfOwned(
    key: string,
    expectedOrgId: string | null
  ): Promise<"deleted" | "missing" | "conflict"> {
    const existing = this.liveGrant(key);
    if (!existing) return "missing";
    if (existing.orgId !== expectedOrgId) return "conflict";
    this.grants.delete(key);
    return "deleted";
  }

  async putGrantIfSource(grant: PlanGrant, expectedSource: string): Promise<GrantWrite> {
    const previous = this.liveGrant(grant.key);
    if (previous && previous.source !== expectedSource) return { outcome: "conflict" };
    this.grants.set(grant.key, detach(grant));
    // Detached after the write, because the caller is handed this and the
    // stored object must not be reachable through it.
    return { outcome: "written", previous: previous && detach(previous) };
  }

  async deleteGrantIfSource(key: string, expectedSource: string): Promise<GrantDelete> {
    const removed = this.liveGrant(key);
    if (!removed) return { outcome: "missing" };
    if (removed.source !== expectedSource) return { outcome: "conflict" };
    this.grants.delete(key);
    return { outcome: "deleted", removed: detach(removed) };
  }

  async moveGrant(fromKey: string, toKey: string): Promise<void> {
    // Synchronous for the same reason as the guarded writes: a move that
    // yielded between reading and re-filing could re-file a record another
    // writer had already replaced.
    const grant = this.liveGrant(fromKey);
    if (!grant) return;
    this.grants.delete(fromKey);
    this.grants.set(toKey, { ...grant, key: toKey });
  }

  async listGrants(limit: number, orgId?: string | null): Promise<PlanGrant[]> {
    // Same rule as getGrant: an expired grant is not a grant. Returning them
    // would let stale records fill the caller's window and hide live ones.
    const now = Date.now();
    const live: PlanGrant[] = [];
    for (const [key, grant] of this.grants) {
      if (grant.expiresAt !== null && now > grant.expiresAt) {
        this.grants.delete(key);
        continue;
      }
      if (orgId === undefined || grant.orgId === orgId) live.push(grant);
    }
    return detach(live.slice(0, limit));
  }

  async appendAudit(a: AuditEntry): Promise<void> {
    this.audit.push(detach(a));
  }

  async auditForOrg(orgId: string, limit: number): Promise<AuditEntry[]> {
    return detach(this.audit.filter((a) => a.orgId === orgId).slice(-limit));
  }

  async sweep(now: number): Promise<void> {
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
