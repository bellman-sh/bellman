import type {
  AuditEntry, Member, PendingConnect, PlanGrant, Session, SessionEvent, EventType,
} from "./types.js";
import { fingerprint, idempotencyKey, type IdempotencyRecord } from "./idempotency.js";
import type { StoredSession } from "./stored-session.js";
import { grantAuditEntries, revokeAuditEntries, type AuditIntent } from "./grant-audit.js";
import { mustReport } from "./roles.js";
export type { AuditIntent } from "./grant-audit.js";

const JOIN_CODE_TTL_MS = 15 * 60 * 1000;
const CONNECT_TOKEN_TTL_MS = 10 * 60 * 1000;

type Waiter = { after: number; resolve: (events: SessionEvent[]) => void };

/** Fields of a Member that may change after it is created. */
export type MemberPatch = Partial<
  Pick<Member, "brief" | "capabilities" | "leftAt" | "lastSeenAt" | "lastReportAt">
>;
// `removedAtCursor` is deliberately absent. It is the append's to write, inside
// the transaction that stores the event it names (#113), and a patch route
// would be a second way to write it — one that could set a cursor no event has.

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

/** Nobody is on a socket. What every reading of presence assumes until it is told otherwise. */
export const NO_SOCKETS: ReadonlySet<string> = new Set();

/**
 * Which of these members a live socket vouches for, given the member ids that
 * the sockets open in this room carry (their attachments, #146).
 *
 * A socket is authenticated as one identity, and its attachment lists the
 * members that identity owned in the room when the socket was accepted. That is
 * a snapshot, and the identity is what the socket vouches for, so this widens
 * the ids to every undeparted member of the users they belong to. The bus is
 * why: it serves every session of an identity on a machine through one socket
 * per room, so a member that joins after the socket was accepted is carried by
 * that socket and cannot be named in it. Read literally, the ids would leave
 * that member stale after ten minutes, and it never calls `bellman_sync` to say
 * otherwise.
 *
 * The cost is in one direction. A member of the identity whose session died
 * stays present for as long as another of its members holds a socket here,
 * because the socket does not say which of them it is for. That holds a seat too
 * long, which #139 prefers to the opposite: reaping too early removes a live
 * member, and the removal is final.
 *
 * Here beside `seatVictims`, and not in presence.ts, because `seatMember` runs
 * it inside the store and presence.ts imports this module.
 */
export function connectedAmong(
  members: readonly Member[],
  attached: Iterable<string>,
): ReadonlySet<string> {
  const named = new Set(attached);
  if (named.size === 0) return NO_SOCKETS;
  const users = new Set<string>();
  for (const m of members) if (named.has(m.memberId)) users.add(m.userId);
  const connected = new Set<string>();
  for (const m of members) {
    if (isActiveMember(m) && users.has(m.userId)) connected.add(m.memberId);
  }
  return connected;
}

/**
 * Whether the room asks this member for reports.
 *
 * Here beside `isActiveMember`, and not in heartbeat.ts, because `freezeSession`
 * applies `clearSilence` inside the store and that reads this — heartbeat.ts
 * imports this module, so the other direction would be a cycle. One that works
 * only while every use sits inside a function body: the first at module
 * evaluation fails at import under the Worker's load order, and neither tsc
 * program reports it.
 */
export const asked = (s: StoredSession, m: Member): boolean =>
  isActiveMember(m) && mustReport(s.manifest, m.roomRole);

/**
 * The roster with one member's report stamp moved forward to `at`, or null when
 * nothing moves.
 *
 * **Monotonic, and that is the whole rule.** `lastReportAt` only ever moves
 * later. A credit replayed from an older event, or one arriving out of order
 * behind a fresher report, would otherwise un-credit an answer the member had
 * already given — and the next tick would name it silent for having reported.
 * There is no reading of "it last reported earlier than we thought" that helps
 * anybody.
 *
 * Null for "no write needed" rather than an unchanged roster, so both stores
 * agree on WHEN a credit writes at all: a replay whose stamp is already forward
 * of the event touches no storage. A member the roster does not name is the same
 * answer, for `updateMember`'s reason — an unknown member is a no-op, not a
 * throw.
 *
 * Here beside `asked` and `clearSilence`, and the direction is the same: this is
 * applied INSIDE both stores, and heartbeat.ts imports this module, so the other
 * way round would be a cycle.
 */
export function creditReport(
  members: Member[],
  memberId: string,
  at: number,
): Member[] | null {
  const i = members.findIndex((m) => m.memberId === memberId);
  if (i < 0) return null;
  const was = members[i].lastReportAt;
  if (was !== undefined && was >= at) return null;
  const next = [...members];
  next[i] = { ...next[i], lastReportAt: at };
  return next;
}

/** Whether a creator removed this member, so its feed is cut (#113). */
export const isRemovedMember = (m: Member): boolean => m.removedAtCursor !== undefined;

/**
 * Record `memberId` out at `cursor`, returning the new roster or `null` when
 * there is nothing to write.
 *
 * Sets `leftAt` AND `removedAtCursor` in one go, because they are one write:
 * folded into the append's transaction, a failure leaves the member in rather
 * than half out. `creditReport` above carries the argument for why a member
 * write that must agree with an event belongs in the event's own transaction.
 *
 * `null` for a member the roster does not name — `updateMember`'s rule, an
 * unknown member is a no-op and not a throw — and `null` for one already
 * carrying a cursor. The second is not merely an optimisation: without it a
 * creator evicting the same member twice would move the cut forward and widen
 * the window the first eviction closed.
 *
 * Here beside `creditReport` and `isActiveMember`, and the direction is theirs:
 * this is applied INSIDE both stores, so it can live in neither.
 */
export function markRemoved(
  members: Member[],
  memberId: string,
  cursor: number,
  at: number,
): Member[] | null {
  const i = members.findIndex((m) => m.memberId === memberId);
  if (i < 0) return null;
  if (members[i].removedAtCursor !== undefined) return null;
  const next = [...members];
  next[i] = { ...next[i], leftAt: at, removedAtCursor: cursor };
  return next;
}

/**
 * The roster a thaw writes back: every seat the room asks is credited with a
 * report at `now`.
 *
 * Spec D10. "A member cannot report its way out of a frozen room, so none may be
 * named silent in one. A freeze must cost nobody their standing." `#tickIfDue`
 * honours the letter by writing no tick while frozen, but that is not enough on
 * its own: `silent_for_seconds` is measured from `lastReport`, which the freeze
 * stopped anybody from moving. A room frozen for an hour on a 5m cadence would
 * otherwise produce, on its first tick after the thaw, `silent: true` for every
 * member — a measurement of the freeze, not of anyone's behaviour, and exactly
 * the false silent D10 is written to avoid.
 *
 * What this loses is the pre-freeze report age, which after an outage long enough
 * to freeze a room is not something a peer can act on anyway. The faithful
 * alternative — carrying the frozen interval on the session and subtracting it in
 * `snapshotOf` — buys that back for a stored field and a second clock to keep
 * consistent with the first.
 *
 * Pure: it takes `now` rather than reading the clock, so the store contributes the
 * moment of the thaw and nothing else. Here for the reason `asked` gives. Who the
 * room asks is `asked`'s rule, and a store that filtered the roster itself would
 * be a second copy of it.
 */
export function clearSilence(s: StoredSession, now: number): Member[] {
  return s.members.map((m) => (asked(s, m) ? { ...m, lastReportAt: now } : m));
}

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
 * `connected` is the members a live socket vouches for (`connectedAmong`), and
 * none of them is reclaimable, however long it has been quiet: the socket is
 * the stronger evidence that it is there. It is an argument and not something
 * read here because only one store has sockets. SessionDO supplies it from the
 * sockets it holds, inside the transaction that makes the decision, and
 * MemoryStore from a hook that is empty unless a test says otherwise. The rule
 * stays one function, and the contract suite still holds both to it.
 *
 * `null` means refuse: the room is full of members that are not reclaimable.
 * An empty array means seat them with nobody removed.
 */
export function seatVictims(
  members: Member[],
  maxMembers: number,
  staleBefore: number,
  connected: ReadonlySet<string> = NO_SOCKETS,
): Member[] | null {
  const active = members.filter(isActiveMember);
  const needed = active.length - maxMembers + 1;
  if (needed <= 0) return [];
  // Longest-quiet first: if only one seat has to go, it is the one whose member
  // has been gone longest.
  const victims = active
    .filter((m) => lastSeen(m) < staleBefore && !connected.has(m.memberId))
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

/**
 * What an append writes BESIDES the event, in the event's own transaction.
 *
 * An explicit argument rather than the store reading `e.type`: nothing in either
 * store branches on an event's kind, and these are the writes that would have
 * made it. The caller already knows it is handling a `progress` send — it checked
 * the verb and validated the payload to get there — so saying so costs it a flag
 * and leaves the store a log that does not interpret what it logs. An eviction is
 * the same: `evictMember` is the one writing the `member_evicted` event.
 *
 * It is not an optimisation. The stamp and the event have to commit together or
 * a due tick can read one without the other, and the cut and its event have to
 * commit together or a reader can be refused at a cursor no stored event
 * carries; see `creditReport`, `markRemoved` and `SessionDO.appendEvent`.
 */
export interface AppendExtras {
  /**
   * Credit `e.fromMemberId` with a report at the event's own `at`, monotonically.
   *
   * Applied on an append AND on an idempotent replay. A replay re-asserts the
   * stamp because a caller retrying has no way to know whether the first attempt
   * landed it, and skipping the credit there is what made a lost stamp permanent
   * rather than late.
   */
  creditReport?: boolean;
  /**
   * Record this member out at the event's own cursor, in the event's own
   * transaction. `evictMember` passes it on the `member_evicted` append; see
   * `markRemoved` for why the two writes cannot be separated (#113).
   */
  markRemoved?: string;
}

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
   * No production path calls this today. The join is `seatMember`, which makes
   * these same refusals and also allocates the seat, and only tests use this
   * one. It stays as the unconditional append, for the contract suite and for a
   * caller that is not allocating a seat, the same relationship `closeSession`
   * has to `closeSessionIfEmpty`. Do not read its presence as behaviour anything
   * depends on.
   *
   * The refusals are here rather than only in a tool, because a tool reads the
   * session and then writes, and a freeze landing in that gap would let a
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
  /**
   * The members of this room that a live socket vouches for right now (#146).
   * Presence reads it beside `lastSeenAt`: a member fed by the local bus or by
   * the room's WebSocket never calls `bellman_sync`, so it never says anything
   * and would read stale after ten minutes with its connection open. See
   * `connectedAmong` for which members a socket vouches for, and what that
   * costs. An unknown session answers nobody.
   *
   * For reading: a preview, a roster, a capacity count. Nobody is removed from
   * this answer. `seatMember` decides that, and reads the sockets itself inside
   * the operation, because an answer fetched first is old by the time it is
   * used, and a member can connect or drop in the gap.
   *
   * MemoryStore has no socket to a room and answers nobody. SessionDO answers
   * from the sockets it holds.
   */
  connectedMembers(sessionId: string): Promise<ReadonlySet<string>>;
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

  /**
   * Append an event. Null means the session is frozen, for the same reason.
   *
   * `extras` names what else the append writes, in the same operation; see
   * `AppendExtras`.
   */
  appendEvent(
    sessionId: string,
    e: Omit<SessionEvent, "cursor" | "at">,
    extras?: AppendExtras
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
    key: string,
    extras?: AppendExtras
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

    const connected = connectedAmong(s.members, this.attachedTo(sessionId));
    const victims = seatVictims(s.members, s.maxMembers, staleBefore, connected);
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

  /**
   * The member ids the sockets open to this room carry. None: the Node server
   * holds no socket to a room, so nobody is connected through this store. A
   * subclass standing in for SessionDO says otherwise by overriding this, and
   * `connectedMembers` and `seatMember` both read it, so the two cannot answer
   * from different sources the way a store with a separate cache could.
   */
  protected attachedTo(_sessionId: string): Iterable<string> {
    return [];
  }

  async connectedMembers(sessionId: string): Promise<ReadonlySet<string>> {
    const s = this.sessions.get(sessionId);
    if (!s) return NO_SOCKETS;
    return connectedAmong(s.members, this.attachedTo(sessionId));
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
    if (patch.lastReportAt !== undefined) m.lastReportAt = patch.lastReportAt;
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

  /**
   * Freeze the room, or thaw it with null.
   *
   * The thaw credits every reporting seat with a report: spec D10, and
   * `clearSilence` carries the argument. Here as well as in `SessionDO` because it
   * is what a thaw MEANS rather than anything the alarm does — `lastReportAt` is
   * read back through `getSession`, so a store that left it alone would report
   * every member silent for the length of the outage. The contract suite has the
   * case, and that is what keeps the two implementations saying the same thing.
   *
   * **The credit is paid on the TRANSITION, not on the argument.** A `null` on a
   * room that is already thawed thaws nothing, and crediting on it stamps every
   * reporting seat with a report nobody made — so a caller retrying this
   * idempotent call keeps resetting every member's clock and nobody is ever due
   * again. `wasFrozen` is read before the assignment below, because that
   * assignment is what destroys the answer.
   */
  async freezeSession(sessionId: string, frozenAt: number | null): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const wasFrozen = s.frozenAt !== null;
    s.frozenAt = frozenAt;
    if (frozenAt === null && wasFrozen) s.members = clearSilence(s, Date.now());
  }

  async sessionsCreatedBy(userId: string, limit: number): Promise<string[]> {
    return [...(this.byCreator.get(userId) ?? [])].slice(0, limit);
  }

  async sessionsJoinedBy(userId: string, limit: number): Promise<string[]> {
    return [...(this.byMember.get(userId) ?? [])].slice(0, limit);
  }

  async appendEvent(
    sessionId: string,
    e: Omit<SessionEvent, "cursor" | "at">,
    extras: AppendExtras = {}
  ): Promise<SessionEvent | null> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session ${sessionId}`);
    if (s.frozenAt !== null) return null;
    // Synchronous from here, so the event and its extras land together. The
    // Durable Objects store gets that from a transaction; here it is the absence
    // of an await, the same arrangement closeSessionIfEmpty and appendNow use.
    const event = this.appendNow(s, e);
    this.applyExtras(s, event, extras);
    return detach(event);
  }

  /**
   * Apply an append's `extras`, if it asked for any. Both rules live in this
   * module and are shared with `SessionDO`, so the two stores cannot disagree
   * about when a member write rides an append.
   *
   * One method rather than two, because both rules rewrite the same member
   * array: applied separately, the second would read `s.members` from before
   * the first and discard it.
   *
   * No awaits, for appendEvent's reason above.
   */
  private applyExtras(s: Session, event: SessionEvent, extras: AppendExtras): void {
    let members = s.members;
    if (extras.creditReport) {
      members = creditReport(members, event.fromMemberId, event.at) ?? members;
    }
    if (extras.markRemoved !== undefined) {
      members = markRemoved(members, extras.markRemoved, event.cursor, event.at) ?? members;
    }
    if (members !== s.members) s.members = members;
  }

  async appendEventOnce(
    sessionId: string,
    e: Omit<SessionEvent, "cursor" | "at">,
    key: string,
    extras: AppendExtras = {}
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
      // The replay applies its extras too. A retry cannot know whether the first
      // attempt landed the stamp, and `creditReport` is monotonic, so re-asserting
      // it is either a repair or a no-op and never a regression. `original` and
      // not `e`, so `markRemoved` sees the cursor the key names: a replay
      // re-asserts the same cut, and `markRemoved` answers `null` once it is
      // recorded.
      this.applyExtras(s, original, extras);
      return { outcome: "replayed", event: detach(original) };
    }

    if (s.frozenAt !== null) return { outcome: "frozen" };

    const event = this.appendNow(s, e);
    const map = seen ?? new Map<string, IdempotencyRecord>();
    map.set(storageKey, { cursor: event.cursor, print });
    this.keys.set(sessionId, map);
    this.applyExtras(s, event, extras);
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
