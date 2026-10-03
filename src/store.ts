import type {
  AuditEntry, Member, PendingConnect, PlanGrant, Session, SessionEvent, EventType,
} from "./types.js";
import { fingerprint, idempotencyKey, type IdempotencyRecord } from "./idempotency.js";
import type { StoredSession } from "./stored-session.js";
import { grantAuditEntries, revokeAuditEntries, type AuditIntent } from "./grant-audit.js";
export type { AuditIntent } from "./grant-audit.js";

const JOIN_CODE_TTL_MS = 15 * 60 * 1000;
const CONNECT_TOKEN_TTL_MS = 10 * 60 * 1000;

type Waiter = { after: number; resolve: (events: SessionEvent[]) => void };

/** Fields of a Member that may change after it is created. */
export type MemberPatch = Partial<Pick<Member, "brief" | "capabilities" | "leftAt" | "lastSeenAt">>;

/**
 * Whether a member is still in the room: they have not left.
 *
 * Here, and not in rooms.ts, because the stores now decide a room is empty
 * (`closeSessionIfEmpty`) and rooms.ts imports this module, not the reverse.
 * `activeMembers` is built on it, so the members rooms.ts counts and the members
 * a close is decided on are one reading of `leftAt` and cannot drift apart.
 */
export const isActiveMember = (m: Member): boolean => m.leftAt === null;

/**
 * When this member was last heard from, falling back to when it joined.
 *
 * Here beside `isActiveMember`, and not in presence.ts, because `seatMember`
 * has to read it inside the store — presence.ts imports this module, so the
 * other direction would be a cycle. The fallback is the legacy lift: members
 * stored before `lastSeenAt` existed have none, and reading `undefined` as
 * "never seen" would make every one of them reclaimable on the next join.
 * Joining is a call the member made, so `joinedAt` is the honest answer for a
 * row that predates the field — the same read-time `??` lift commit 7d19453
 * applies to `joinCode`.
 */
export const lastSeen = (m: Member): number => m.lastSeenAt ?? m.joinedAt;

/**
 * What `seatMember` did. `refused` is null exactly when the member is seated.
 *
 * `reclaimed` lists the stale members this call departed to make the room, and
 * it is non-empty only when the seating succeeded — so a caller announcing them
 * is announcing removals that actually happened. A call that cannot free enough
 * seats refuses "full" and removes nobody: a partial reap would remove a member
 * for a joiner that never got in.
 */
export interface SeatOutcome {
  refused: "not_found" | "closed" | "frozen" | "full" | null;
  reclaimed: Member[];
}

/**
 * Pick the stale members to reclaim so one more can be seated, or say it cannot.
 *
 * Shared by both stores so the seat rule is one piece of code rather than two
 * that can drift — the same reason `isActiveMember` lives here. It is pure, and
 * takes the cutoff rather than a window, so the store holds no presence policy:
 * all it knows is that a member last heard from before `staleBefore` may lose
 * its seat.
 *
 * `null` means refuse: the room is full of members that are not reclaimable.
 * An empty array means seat them with nobody removed.
 */
export function seatVictims(
  members: Member[],
  maxMembers: number,
  staleBefore: number,
): Member[] | null {
  const active = members.filter(isActiveMember);
  const needed = active.length - maxMembers + 1;
  if (needed <= 0) return [];
  // Longest-quiet first: if only one seat has to go, it is the one whose member
  // has been gone longest.
  const victims = active
    .filter((m) => lastSeen(m) < staleBefore)
    .sort((a, b) => lastSeen(a) - lastSeen(b))
    .slice(0, needed);
  return victims.length < needed ? null : victims;
}

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
 * What a source-guarded write replaced: `previous` here, `removed` on
 * GrantDelete.
 *
 * No production code reads either field. The store contract suite is their only
 * reader. Billing needed them while it audited for itself, to tell a change
 * from a repeat and to see which org a grant moved out of. The store decides
 * both now: all four guarded writes record their own audit entries in the same
 * operation that makes the change, from the same read they report here (see
 * grant-audit.ts). Nothing depends on the fields, so removing them breaks no
 * caller; it means deleting them from both stores and from the contract cases
 * that pin them.
 *
 * Only the source-guarded pair reports them, because only billing ever needed
 * them. The org-guarded pair answers with the outcome alone: the admin route
 * authored the write and knew what it sent.
 */
export interface GrantWrite {
  outcome: "written" | "conflict";
  previous?: PlanGrant;
}

export interface GrantDelete {
  outcome: "deleted" | "missing" | "conflict";
  removed?: PlanGrant;
}

/**
 * What an idempotent append did.
 *
 * A union rather than an optional `event` field, because the caller must tell
 * four cases apart and two of them have no event: letting the compiler carry
 * that removes a non-null assertion at the one call site that reads the cursor.
 */
export type EventWrite =
  | { outcome: "appended"; event: SessionEvent }
  | { outcome: "replayed"; event: SessionEvent }
  | { outcome: "frozen" }
  | { outcome: "conflict" };

export interface BellmanStore {
  createSession(s: Session): Promise<void>;
  /**
   * The session record and its members. NOT its events.
   *
   * Returning StoredSession rather than Session is what stops #25 coming
   * back: a handler that reaches for history no longer compiles, so it has
   * to call eventsAfter or eventAt and say which events it wants.
   */
  getSession(id: string): Promise<StoredSession | undefined>;
  /**
   * Resolve a code to its session and the role it carries.
   *
   * The whole rendered string is the key, role group included, so a code with a
   * hand-edited suffix was never issued and does not resolve. The role comes
   * from the record, never from reading the string — there is no code path that
   * parses a suffix, which is what makes the tamper case fail closed.
   */
  getSessionByJoinCode(code: string): Promise<{ session: StoredSession; role: string } | undefined>;

  /** Retire one role's code. Idempotent. */
  consumeJoinCode(sessionId: string, role: string): Promise<void>;

  /** Retire every live code — a pair session filling, a session closing. Idempotent. */
  clearJoinCodes(sessionId: string): Promise<void>;

  /** Issue a code for one role, retiring only that role's previous code. False means frozen. */
  setJoinCode(sessionId: string, role: string, code: string, expiresAt: number): Promise<boolean>;
  /**
   * Append a member to a session, unless it is frozen or closed. False means
   * refused — frozen, closed, or no such session — and a caller that has to say
   * which reads the session again.
   *
   * The refusals are here rather than only in the tool, because the tool reads
   * the session and then writes, and a freeze landing in that gap would let a
   * frozen room grow — which is the one thing freezing is for. A close landing in
   * it is the same gap with a worse result: a member seated in a room that is
   * over. Like `seatMember`'s, this is the other half of `closeSessionIfEmpty`,
   * which keeps a close from landing on an occupied room; the pair is sound only
   * together. Unlike the cross-object races on #59 and #62, both halves live in
   * the same object, so this one can simply be made not to have a gap.
   */
  addMember(sessionId: string, member: Member): Promise<boolean>;
  /**
   * Seat a member, reclaiming stale seats if that is what it takes, as ONE
   * operation.
   *
   * This is the production join path; `addMember` is the unconditional append,
   * kept for the contract suite and for a caller that is not allocating a seat,
   * the same relationship `closeSession` has to `closeSessionIfEmpty`.
   *
   * It cannot be three calls, and it was. A tool that reclaimed, re-read, checked
   * capacity and then appended handed two concurrent confirms a window to agree
   * on the same free slot: both would reap the same victim, both announce it,
   * both pass the check, and the room would end with more members than it has
   * seats. Worse, a `bellman_sync` landing in the window makes a member live
   * again *after* the reclaim decision was taken against it, and a freeze
   * landing there removes a member from a room that is meant to cost nobody
   * their place. Deciding and writing inside the object closes all three: the
   * Durable Objects store is one transaction, and MemoryStore does not yield
   * between the read and the write — the rule `closeSessionIfEmpty` and the
   * guarded grant writes already follow.
   *
   * `staleBefore` is the cutoff, so the store holds no presence policy: a member
   * last heard from before it may lose its seat. Pass `Date.now()` for `now` so
   * the departure stamp and the joiner's `joinedAt` agree.
   *
   * Refuses rather than partially reaping. Reclaiming one of two seats a joiner
   * needs would remove a member for somebody who never got in.
   */
  seatMember(
    sessionId: string,
    member: Member,
    staleBefore: number,
    now: number,
  ): Promise<SeatOutcome>;
  /** Patch a member's mutable fields. Unknown session/member is a no-op. */
  updateMember(sessionId: string, memberId: string, patch: MemberPatch): Promise<void>;
  /**
   * Mark a session closed, whoever is in it. Idempotent. To close a room because
   * it has emptied, use `closeSessionIfEmpty`: deciding that from a read and then
   * calling this is the gap it exists to close.
   *
   * No production path calls this today. The room operations close through
   * `closeSessionIfEmpty`, and only tests use this one. It stays as the
   * unconditional close, which the close-a-room route #49 lists will need, and
   * for the contract suite to set a room up closed. Do not read its presence as
   * behaviour anything depends on.
   */
  closeSession(sessionId: string): Promise<void>;
  /**
   * Close a session if nobody is in it. Resolves to whether the session IS closed
   * when this returns, and not to whether this call closed it, which is how the
   * name reads: true for a room this call closed and for one that already was,
   * false for a room left open because a member is in it, and for one that does
   * not exist.
   *
   * The check and the write are one operation, and cannot be two. A caller that
   * read the roster, saw it empty and then called `closeSession` would leave a
   * window for a member to join in, and the room would close over them with its
   * codes retired. Here the Durable Objects store decides inside the one object
   * that owns the session, in one transaction, and MemoryStore does not yield
   * between the two. `seatMember`'s refusal of a closed session is the other half,
   * and `addMember`'s is the same refusal: this keeps a close from landing on an
   * occupied room, those keep a join from landing on a closed one, and neither is
   * enough alone.
   *
   * "Nobody" is no member for whom `isActiveMember` holds. A frozen room closes
   * like any other: freezing refuses writes into a room someone is in, and an
   * empty one is over either way.
   *
   * The answer is a state and not an event, on purpose, and DurableObjectStore
   * depends on it. An already-closed room answers true whoever is listed in it.
   * A close can die after the room is marked closed and before the registry drops
   * its codes, and the retry has to read the room as closed to finish that: "did
   * this call close it" would answer false there, and leave the rows for good.
   */
  closeSessionIfEmpty(sessionId: string): Promise<boolean>;
  /** Freeze or thaw a session. null thaws. */
  freezeSession(sessionId: string, frozenAt: number | null): Promise<void>;
  /**
   * Sessions this user created, newest first is not promised — only that a
   * lapsed plan can find the rooms it has to freeze. The create *counts* used
   * for quota cannot answer that: they are timestamps, not identities.
   *
   * That promise has two exceptions, both in the Durable Objects store, and a
   * miss costs more than a row missing from a list: a lapse freezes the rooms
   * this names, so a room it misses is not frozen and keeps working on a plan
   * that no longer pays for it. The index starts at its deploy, so a room
   * created before then is not listed (see `RegistryDO.indexSession`). And a
   * failed index write is logged rather than thrown, deliberately, so that a
   * registry failure cannot abort a create whose room had already committed;
   * nothing rebuilds the row it lost (see `DurableObjectStore.writeIndex`). A
   * creator's room takes two such writes, one per listing, and either can fail
   * alone, so a room can be in `sessionsJoinedBy` and absent from here.
   */
  sessionsCreatedBy(userId: string, limit: number): Promise<string[]>;
  /**
   * Rooms in which this user has held a member handle — created, joined, left
   * and closed alike — for as far back as the store's index goes. In MemoryStore
   * that is everything; in the Durable Objects store it starts at its deploy, so
   * a handle held before then is not listed (see `RegistryDO.indexMembership`).
   *
   * Nor is every handle held since that deploy. The Durable Objects store logs a
   * failed index write rather than throwing it, deliberately, so that a registry
   * failure cannot abort a join whose seat had already committed; nothing
   * rebuilds the row it lost (see `DurableObjectStore.writeIndex`). A creator's
   * room takes two such writes, one per listing, and either can fail alone, so
   * the room can be in `sessionsCreatedBy` and absent from here, or the reverse.
   * Absence from this list is not proof that the user never held a handle.
   *
   * Ids only, like `sessionsCreatedBy`, and no status parameter. The consumers
   * it is meant for do not agree on what counts as current: the control panel
   * hides closed rooms, a freeze sweep wants exactly the live ones. Encoding
   * either answer here would make one of them filter twice.
   *
   * Order is not promised, and it differs between the stores — insertion order
   * in MemoryStore, key order in the Durable Objects store — so which rooms
   * survive `limit` is unspecified too.
   */
  sessionsJoinedBy(userId: string, limit: number): Promise<string[]>;

  /** Append an event. Null means the session is frozen, for the same reason. */
  appendEvent(
    sessionId: string,
    e: Omit<SessionEvent, "cursor" | "at">
  ): Promise<SessionEvent | null>;
  /**
   * Append an event unless this member has already used this key.
   *
   * A separate method rather than a parameter on appendEvent: `null` there
   * already means frozen, and a caller now has four outcomes to tell apart.
   * Same shape as the guarded grant writes — the guarantee is in the name, and
   * a caller that does not want it calls the other method.
   *
   * The key check and the append are one operation, and cannot be two: a
   * caller that read the key and then wrote would leave a window for its own
   * retry to read the same empty slot and append a second event, which is the
   * entire thing this prevents.
   *
   * The key check precedes the frozen check. A write that already succeeded
   * keeps reporting its result even after the room freezes — the replay
   * appends nothing, so nothing new enters a frozen room, and a retry across a
   * freeze can otherwise never learn whether its first attempt landed.
   */
  appendEventOnce(
    sessionId: string,
    e: Omit<SessionEvent, "cursor" | "at">,
    key: string
  ): Promise<EventWrite>;
  eventsAfter(sessionId: string, cursor: number): Promise<SessionEvent[]>;
  /**
   * The event at exactly this cursor, or undefined.
   *
   * One key, not a scan. `bellman_send` resolves an action_response's ref_id
   * this way; reading the whole history to find one event is what #25 was.
   */
  eventAt(sessionId: string, cursor: number): Promise<SessionEvent | undefined>;
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
   * Write a grant only if the key is unowned or already belongs to
   * `expectedOrgId`, and record what changed.
   *
   * The check, the write and the audit intent are one operation. A caller that
   * reads with getGrant and then writes has given the object a window to serve
   * another org's write in between; a caller that writes and then audits has
   * given it a window to lose the record of a change that already happened.
   * `audit` carries only what the store cannot see — who is acting, and any
   * detail to annotate the entry with. See grant-audit.ts for the rule.
   */
  putGrantIfOwned(
    grant: PlanGrant, expectedOrgId: string | null, audit: AuditIntent
  ): Promise<"written" | "conflict">;
  /** Delete a grant only if it belongs to `expectedOrgId`, and say what happened. */
  deleteGrantIfOwned(
    key: string, expectedOrgId: string | null, audit: AuditIntent
  ): Promise<"deleted" | "missing" | "conflict">;
  /**
   * Write a grant only if the key is unowned or already carries
   * `expectedSource`.
   *
   * The second writer. An admin claims a key by org, which is what
   * putGrantIfOwned checks; billing claims by having written it, because a
   * lapsing subscription must not revoke a plan an operator granted by hand.
   * Same atomicity argument either way.
   */
  putGrantIfSource(
    grant: PlanGrant, expectedSource: string, audit: AuditIntent
  ): Promise<GrantWrite>;
  /** Delete a grant only if it carries `expectedSource`, and say what happened. */
  deleteGrantIfSource(
    key: string, expectedSource: string, audit: AuditIntent
  ): Promise<GrantDelete>;
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
  private byMember = new Map<string, Set<string>>();
  private pending = new Map<string, PendingConnect>();
  private creates = new Map<string, number[]>(); // userId -> timestamps
  private grants = new Map<string, PlanGrant>();
  private audit: AuditEntry[] = [];
  private waiters = new Map<string, Waiter[]>();
  /**
   * Idempotency keys, by session. Beside `waiters` rather than on the Session
   * record: that type is the one SessionDO persists and hydrateStoredSession
   * validates, and a field there would need a hydration rule it does not need.
   * Same lifetime either way — a session is never deleted from this store.
   */
  private keys = new Map<string, Map<string, IdempotencyRecord>>();

  async createSession(s: Session): Promise<void> {
    const stored = detach(s);
    this.sessions.set(stored.id, stored);
    for (const rec of Object.values(stored.joinCodes)) this.byJoinCode.set(rec.code, stored.id);
    const mine = this.byCreator.get(stored.createdBy) ?? new Set<string>();
    mine.add(stored.id);
    this.byCreator.set(stored.createdBy, mine);
    // The members a session is created with are seated directly — bellman_start
    // hands over the creator in `members` and never calls addMember — so they
    // are indexed here. addMember indexes everyone who joins afterwards.
    for (const m of stored.members) this.indexMember(m.userId, stored.id);
  }

  /**
   * The one place the joined index is written, so the two ways of seating a
   * member cannot drift apart. Keyed by user, so a second handle for the same
   * person in the same room is the same entry.
   */
  private indexMember(userId: string, sessionId: string): void {
    const joined = this.byMember.get(userId) ?? new Set<string>();
    joined.add(sessionId);
    this.byMember.set(userId, joined);
  }

  async getSession(id: string): Promise<StoredSession | undefined> {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    this.expireIfDue(s, Date.now());
    const { events: _events, ...rest } = detach(s);
    return rest;
  }

  async getSessionByJoinCode(code: string): Promise<{ session: StoredSession; role: string } | undefined> {
    const id = this.byJoinCode.get(code);
    if (!id) return undefined;
    const session = await this.getSession(id);
    if (!session || session.closed) return undefined;
    const hit = Object.entries(session.joinCodes).find(([, rec]) => rec.code === code);
    if (!hit) return undefined; // consumed or rotated
    const [role, rec] = hit;
    if (Date.now() > rec.expiresAt) return undefined;
    return { session, role };
  }

  async consumeJoinCode(sessionId: string, role: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    const rec = s?.joinCodes[role];
    if (!s || !rec) return;
    this.byJoinCode.delete(rec.code);
    delete s.joinCodes[role];
  }

  async clearJoinCodes(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    for (const rec of Object.values(s.joinCodes)) this.byJoinCode.delete(rec.code);
    s.joinCodes = {};
  }

  async setJoinCode(
    sessionId: string, role: string, code: string, expiresAt: number
  ): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    if (s.frozenAt !== null) return false;
    const previous = s.joinCodes[role];
    if (previous) this.byJoinCode.delete(previous.code); // only THIS role's old code
    s.joinCodes[role] = { code, expiresAt };
    this.byJoinCode.set(code, sessionId);
    return true;
  }

  async addMember(sessionId: string, member: Member): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    if (s.frozenAt !== null) return false;
    // Closed is refused for the reason frozen is: the caller read the room before
    // this write, and a close in the gap would otherwise seat a member in a room
    // that is over. closeSessionIfEmpty is the other half.
    if (s.closed) return false;
    s.members.push(detach(member));
    // After the guards, so a refused add leaves no trace in the listing.
    this.indexMember(member.userId, sessionId);
    return true;
  }

  async seatMember(
    sessionId: string,
    member: Member,
    staleBefore: number,
    now: number,
  ): Promise<SeatOutcome> {
    // No await from here to the write, deliberately — the same rule, and the
    // same reason, as closeSessionIfEmpty. The Durable Objects store gets it
    // from a transaction instead.
    const s = this.sessions.get(sessionId);
    if (!s) return { refused: "not_found", reclaimed: [] };
    if (s.closed) return { refused: "closed", reclaimed: [] };
    if (s.frozenAt !== null) return { refused: "frozen", reclaimed: [] };

    const victims = seatVictims(s.members, s.maxMembers, staleBefore);
    if (victims === null) return { refused: "full", reclaimed: [] };

    const reclaimed: Member[] = [];
    for (const v of victims) {
      const row = s.members.find((m) => m.memberId === v.memberId)!;
      row.leftAt = now;
      reclaimed.push(detach(row));
    }
    s.members.push(detach(member));
    // After the guards, so a refused seating leaves no trace in the listing.
    this.indexMember(member.userId, sessionId);
    return { refused: null, reclaimed };
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
    if (patch.lastSeenAt !== undefined) m.lastSeenAt = patch.lastSeenAt;
  }

  async closeSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.closeNow(s);
  }

  async closeSessionIfEmpty(sessionId: string): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    // No await from here to the write, deliberately. The check and the close are
    // one operation, and a yield between them is the window a join lands in: the
    // same rule, and the same reason, as waitForEvents and the guarded grant
    // writes. The Durable Objects store gets it from a transaction instead.
    if (s.closed) return true;
    if (s.members.some(isActiveMember)) return false;
    this.closeNow(s);
    return true;
  }

  /**
   * The close itself, with no awaits in it, so both public closers can call it
   * without yielding between their guard and their write. The same arrangement,
   * and the same reason, as appendNow.
   *
   * Agrees with expireIfDue: a closed room's codes stop resolving AND stop
   * occupying the index, rather than relying on the `closed` guard alone.
   */
  private closeNow(s: Session): void {
    s.closed = true;
    for (const rec of Object.values(s.joinCodes)) this.byJoinCode.delete(rec.code);
    s.joinCodes = {};
  }

  async freezeSession(sessionId: string, frozenAt: number | null): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.frozenAt = frozenAt;
  }

  async sessionsCreatedBy(userId: string, limit: number): Promise<string[]> {
    return [...(this.byCreator.get(userId) ?? [])].slice(0, limit);
  }

  async sessionsJoinedBy(userId: string, limit: number): Promise<string[]> {
    return [...(this.byMember.get(userId) ?? [])].slice(0, limit);
  }

  async appendEvent(
    sessionId: string,
    e: Omit<SessionEvent, "cursor" | "at">
  ): Promise<SessionEvent | null> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session ${sessionId}`);
    if (s.frozenAt !== null) return null;
    return detach(this.appendNow(s, e));
  }

  async appendEventOnce(
    sessionId: string,
    e: Omit<SessionEvent, "cursor" | "at">,
    key: string
  ): Promise<EventWrite> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session ${sessionId}`);

    // Everything from here to appendNow is synchronous, deliberately. An await
    // in this stretch yields, and this method's own retry can read the same
    // empty slot in the gap and append a second event.
    const storageKey = idempotencyKey(e.fromMemberId, key);
    const seen = this.keys.get(sessionId);
    const record = seen?.get(storageKey);
    const print = fingerprint(e);

    if (record) {
      if (record.print !== print) return { outcome: "conflict" };
      const original = s.events.find((ev) => ev.cursor === record.cursor);
      // A record naming a cursor with no event is a store bug, not a replay.
      // Returning "replayed" without one would crash the caller a frame later,
      // where nothing says why.
      if (!original) {
        throw new Error(
          `Idempotency record for ${sessionId} names missing cursor ${record.cursor}`
        );
      }
      return { outcome: "replayed", event: detach(original) };
    }

    if (s.frozenAt !== null) return { outcome: "frozen" };

    const event = this.appendNow(s, e);
    const map = seen ?? new Map<string, IdempotencyRecord>();
    map.set(storageKey, { cursor: event.cursor, print });
    this.keys.set(sessionId, map);
    return { outcome: "appended", event: detach(event) };
  }

  /**
   * The append itself, with no awaits in it, so both public appenders can call
   * it without yielding between their guard and their write. Same rule, and
   * the same reason, as liveGrant and waitForEvents.
   */
  private appendNow(s: Session, e: Omit<SessionEvent, "cursor" | "at">): SessionEvent {
    const event: SessionEvent = {
      ...detach(e), cursor: s.events.length + 1, at: Date.now(),
    };
    s.events.push(event);
    this.wake(s);
    return event;
  }

  async eventsAfter(sessionId: string, cursor: number): Promise<SessionEvent[]> {
    const s = this.sessions.get(sessionId);
    if (!s) return [];
    return detach(s.events.filter((e) => e.cursor > cursor));
  }

  async eventAt(sessionId: string, cursor: number): Promise<SessionEvent | undefined> {
    const e = this.sessions.get(sessionId)?.events.find((ev) => ev.cursor === cursor);
    return e ? detach(e) : undefined;
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

  /**
   * No outbox here. There is one process and one array, so the audit write
   * cannot fail independently of the grant write and there is no gap to
   * protect. The Durable Object store needs one because its audit lives in a
   * different object; both owe the same observable result, which is what the
   * contract suite checks.
   */
  private recordAudit(entries: AuditEntry[]): void {
    for (const entry of entries) this.audit.push(detach(entry));
  }

  async putGrantIfOwned(
    grant: PlanGrant,
    expectedOrgId: string | null,
    audit: AuditIntent
  ): Promise<"written" | "conflict"> {
    // liveGrant, not the raw map: a lapsed grant is defined as absent
    // everywhere else, and reading past that here would let a dead record from
    // another org hold a key hostage until some unrelated read swept it.
    const existing = this.liveGrant(grant.key);
    if (existing && existing.orgId !== expectedOrgId) return "conflict";
    this.grants.set(grant.key, detach(grant));
    this.recordAudit(grantAuditEntries(existing, grant, audit, Date.now()));
    return "written";
  }

  async deleteGrantIfOwned(
    key: string,
    expectedOrgId: string | null,
    audit: AuditIntent
  ): Promise<"deleted" | "missing" | "conflict"> {
    const existing = this.liveGrant(key);
    if (!existing) return "missing";
    if (existing.orgId !== expectedOrgId) return "conflict";
    this.grants.delete(key);
    this.recordAudit(revokeAuditEntries(existing, audit, Date.now()));
    return "deleted";
  }

  async putGrantIfSource(
    grant: PlanGrant, expectedSource: string, audit: AuditIntent
  ): Promise<GrantWrite> {
    const previous = this.liveGrant(grant.key);
    if (previous && previous.source !== expectedSource) return { outcome: "conflict" };
    this.grants.set(grant.key, detach(grant));
    this.recordAudit(grantAuditEntries(previous, grant, audit, Date.now()));
    // Detached after the write, because the caller is handed this and the
    // stored object must not be reachable through it.
    return { outcome: "written", previous: previous && detach(previous) };
  }

  async deleteGrantIfSource(
    key: string, expectedSource: string, audit: AuditIntent
  ): Promise<GrantDelete> {
    const removed = this.liveGrant(key);
    if (!removed) return { outcome: "missing" };
    if (removed.source !== expectedSource) return { outcome: "conflict" };
    this.grants.delete(key);
    this.recordAudit(revokeAuditEntries(removed, audit, Date.now()));
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
    for (const rec of Object.values(s.joinCodes)) this.byJoinCode.delete(rec.code);
    s.joinCodes = {};
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
