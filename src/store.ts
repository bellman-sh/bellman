import type {
  AuditEntry, HostUnits, Member, PendingConnect, PlanGrant, RoomManifest, Session, SessionEvent, EventType,
  SavedPreset, SurfaceRow,
} from "./types.js";
import { MemoryBlobStore, type BlobStore } from "./blobs.js";
import { fingerprint, idempotencyKey, type IdempotencyRecord } from "./idempotency.js";
import {
  creditedBlobBytes, orgsOnRoster, purgeDueAt, roomDeletedEntry, roomPurgedEntry, sweepDueAt, unnamedObjects,
} from "./retention.js";
import { monthKey, type StoredSession } from "./stored-session.js";
// Type-only: host.ts and heartbeat.ts import this module at runtime, so a value import
// back would be a cycle. `MemoryStore.tick` is handed its rule for that reason.
import type { HostWake } from "./host.js";
import type { TickStep } from "./heartbeat.js";
import { grantAuditEntries, revokeAuditEntries, type AuditIntent } from "./grant-audit.js";
import { mustReport } from "./roles.js";
import { applySurfaceWrite, type SurfaceWrite } from "./surface.js";
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

/**
 * The hosted seat's identity (hosted seat spec, D1): the member id it holds in
 * every room, and the user every hosted seat is seated under.
 *
 * These and the two rules below are here beside `isActiveMember`, and
 * re-exported from host.ts, for the reason `lastSeen` gives: both stores read
 * them inside their own methods, and host.ts imports this module.
 */
export const HOST_MEMBER_ID = "m_host";
export const HOST_USER_ID = "u_bellman_host";
export const isHostMember = (m: Pick<Member, "userId">): boolean => m.userId === HOST_USER_ID;

/**
 * A member still in the room who is a person and not the hosted seat (hosted seat
 * spec, D5). The host does not vouch for a room, so whether a room is empty, when it
 * is abandoned and whether a hosted tick has anyone to ask all count these and only
 * these: one predicate, so the three cannot disagree about who is there.
 */
export const isActivePerson = (m: Member): boolean => isActiveMember(m) && !isHostMember(m);

/**
 * Whether the room's hosted seat is still in it (C1). Evicting the host is the
 * creator's one control over it, so once it has left nothing wakes it and the room
 * refuses its writes: the tick (`tickPlan`), both stores' reply wakes and
 * `decideHostCharge` all ask this.
 */
export const hostSeated = (s: Pick<Session, "members">): boolean =>
  s.members.some((m) => isHostMember(m) && isActiveMember(m));

/** Wakes the hosted seat may spend in any hour, whatever its month has left (spec D3: the burst cap). */
export const WAKES_PER_HOUR = 8;

/** A member's answer to the host: a message or a progress event whose ref names one of the host's events. */
export function isReplyToHost(
  e: Pick<SessionEvent, "type" | "refId">,
  referenced: Pick<SessionEvent, "fromMemberId"> | undefined,
): boolean {
  if (e.refId === null || referenced === undefined) return false;
  if (e.type !== "message" && e.type !== "progress") return false;
  return referenced.fromMemberId === HOST_MEMBER_ID;
}

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
 * How long a room may go with nobody in it before it is abandoned (#18).
 *
 * Rooms persist: there is no clock on a room, on any plan. What ends one is its
 * last member leaving (`closeSessionIfEmpty`) or this: 90 days in which no
 * active member was heard from or held a socket. An abandoned room costs
 * storage and nothing else, and the member a hub room would most regret losing
 * is its quietest one, so the window is long. It is not forever because a room
 * whose every member died with its laptop should not sit in a Durable Object
 * for good, and the sweep is also what retires its codes from the registry.
 *
 * Here beside `lastSeen`, and re-exported from presence.ts, for the reason
 * `lastSeen` gives: both stores read these inside their own methods, and
 * presence.ts imports this module.
 */
export const ABANDONED_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

/** What the abandonment rule reads: a session, or a stored one. */
export type RoomRoster = Pick<Session, "closed" | "frozenAt" | "members">;

/**
 * When this room becomes abandoned, or null if the question does not apply: a
 * closed room is over, a frozen one is waiting on a payment and `touchMember`
 * cannot stamp it, and an empty one is `closeSessionIfEmpty`'s. Departed members
 * do not count: a goodbye yesterday does not keep open a room that nobody else
 * has been in for a season. Nor does the hosted seat (hosted seat spec, D5): its
 * sends stamp it as seen, and a room whose people have all gone quiet still ends
 * 90 days after one of them was last there, however recently its host spoke.
 */
export function abandonedAt(s: RoomRoster): number | null {
  if (s.closed || s.frozenAt !== null) return null;
  const active = s.members.filter(isActivePerson);
  if (active.length === 0) return null;
  return Math.max(...active.map(lastSeen)) + ABANDONED_AFTER_MS;
}

/**
 * Whether this room is abandoned now. `connected` is the members a live socket
 * vouches for (`connectedAmong`): a member on a socket is there whatever its
 * `lastSeenAt` says, so a room with one is never abandoned. Strict `>`, so a
 * read landing exactly on `abandonedAt` still sees the room open.
 *
 * Shared by both stores' sweeps and lazy closes, SessionDO's derived alarm and
 * every reader that answers "closed" without writing (`readsClosed`), so the
 * four cannot drift the first time one of them is edited.
 */
export function isAbandoned(
  s: RoomRoster,
  now: number,
  connected: ReadonlySet<string> = NO_SOCKETS,
): boolean {
  const due = abandonedAt(s);
  if (due === null || now <= due) return false;
  return !s.members.some((m) => isActiveMember(m) && connected.has(m.memberId));
}

/**
 * The roster with `lastSeenAt` moved to `now` on every active member, or only
 * on those named. New objects, so a caller's copy is not written into.
 *
 * Two callers. A thaw stamps every active member, so a room coming back from a
 * freeze gets a full window rather than closing on the alarm the thaw re-arms.
 * The abandonment alarm stamps the members a socket vouches for, which is the
 * stamp `webSocketClose` makes on a drop (#152), made on a schedule: without it
 * a room held open on one socket for a season would fire its alarm back to back.
 */
export function stampSeen(members: Member[], now: number, only?: ReadonlySet<string>): Member[] {
  return members.map((m) =>
    isActiveMember(m) && (only === undefined || only.has(m.memberId)) ? { ...m, lastSeenAt: now } : m,
  );
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
 * `null` in three cases, and none of them is merely an optimisation.
 *
 * A member the roster does not name: `updateMember`'s rule, an unknown member is
 * a no-op and not a throw.
 *
 * A member already carrying a cursor. Without this a creator evicting the same
 * member twice would move the cut forward and widen the window the first
 * eviction closed.
 *
 * A member who has already left (#113, D6). `evictMember` returns early for one,
 * but it reads the roster once and appends later, and a voluntary leave can land
 * in between: `leaveRoom` sets `leftAt` through `updateMember`, and
 * `removedAtCursor` is not patchable, so neither bail-out above sees it. Without
 * this one that member would be handed a cut and have its own `leftAt`
 * overwritten, and a member who chose to go is the one R2 gives the open feed.
 * It is a `null` and not `leftAt: members[i].leftAt ?? at`, which would keep the
 * leave time and still write the cut — the part D6 forbids.
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
  if (members[i].leftAt !== null) return null;
  const next = [...members];
  next[i] = { ...next[i], leftAt: at, removedAtCursor: cursor };
  return next;
}

/** What an append owes housekeeping (#66): the fields of a session `noteAppend` may move. */
type Books = Pick<Session, "members" | "openRequests" | "lastMemberEventAt">;

/**
 * The member a departure event is about, or null when the event is not a departure.
 *
 * `member_left` is authored by the member who left. `member_evicted` and
 * `member_timed_out` are authored by "system" and name the member in their payload,
 * because no member handle authored either (`evictMember` and `announceReclaimed`
 * write them so). Reading `fromMemberId` alone would close nobody's requests for
 * exactly the two removals the server makes.
 */
function departedMemberId(e: SessionEvent): string | null {
  if (e.type === "member_left") return e.fromMemberId;
  if (e.type === "member_evicted" || e.type === "member_timed_out") {
    const id = (e.payload as { member_id?: unknown } | null)?.member_id;
    return typeof id === "string" ? id : null;
  }
  return null;
}

/**
 * What an append owes housekeeping (#66): the sender's last send, the room's last member
 * event, and the set of requests still waiting. The books to write, or the very object it
 * was handed when there is nothing to write, so a caller tells "no change" by identity.
 *
 * **Only a room that declared housekeeping keeps books.** Any other returns at once, and
 * the Durable Objects store then writes exactly the rows it wrote before this existed.
 *
 * **A person's event moves the sender and the room; the server's does not, and neither
 * does the hosted seat's.** A tick, a proposal, an eviction and a timeout are all authored by
 * "system", and none of them is anybody's activity. The seat is Bellman's, not a person
 * (hosted seat spec, D5; ruling H3): it speaks on its own clock, in answer to its two wake
 * causes, so what it says is not a member writing to the room, and a room only it speaks in
 * reads idle. Departures still close the departed member's requests whoever authored them,
 * which is why that comes first.
 *
 * Requests are kept here and not derived from the log, because every read of the log is
 * bounded and a request older than the bound must not be forgotten. An `action_response`
 * closes the request whose cursor its `refId` names, and `bellman_send` has already
 * checked that it names a real one. The closing on a departure keeps the record small;
 * it is not what stops a departed member's request being named, which the rule that
 * reads the record decides for itself.
 *
 * Pure, and applied INSIDE both stores at the write, so the two cannot disagree about
 * what "open" means. Unlike `creditReport` and `markRemoved` it is not asked for by an
 * `AppendExtras` flag: the departures that close a request are written by paths no caller
 * flags (`removeMember`, `announceReclaimed`), and a flag every caller had to remember is
 * how the books would go stale. Here beside them for their reason otherwise: housekeeping.ts
 * imports this module, as heartbeat.ts does, so the other direction would be a cycle.
 *
 * NOT applied to a replay. The books went in with the first append, and applying the
 * original event again would put a request back after its answer.
 */
export function noteAppend(s: Books & Pick<Session, "manifest">, e: SessionEvent): Books {
  if (s.manifest.housekeeping === null) return s;

  let openRequests = s.openRequests;
  const gone = departedMemberId(e);
  if (gone !== null && Object.values(openRequests).some((r) => r.fromMemberId === gone)) {
    openRequests = Object.fromEntries(Object.entries(openRequests).filter(([, r]) => r.fromMemberId !== gone));
  }

  if (e.fromMemberId === "system" || isHostMember({ userId: e.fromUserId })) {
    return openRequests === s.openRequests
      ? s
      : { members: s.members, openRequests, lastMemberEventAt: s.lastMemberEventAt };
  }

  if (e.type === "action_request") {
    openRequests = { ...openRequests, [String(e.cursor)]: { at: e.at, fromMemberId: e.fromMemberId } };
  } else if (e.type === "action_response" && e.refId !== null && Object.hasOwn(openRequests, e.refId)) {
    const { [e.refId]: _answered, ...rest } = openRequests;
    openRequests = rest;
  }
  return {
    members: s.members.map((m) => (m.memberId === e.fromMemberId ? { ...m, lastSentAt: e.at } : m)),
    openRequests,
    lastMemberEventAt: e.at,
  };
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

/** What `appendEvent` already takes: an event without the fields the store fills. */
export type EventBody = Omit<SessionEvent, "cursor" | "at">;

/** What a removal did, reported from inside the transaction that did it. */
export interface RemovalOutcome {
  refused: "not_found" | "closed" | "frozen" | "forbidden" | null;
  /** True only when THIS call recorded the member out. */
  removed: boolean;
  /**
   * The role whose code this call retired, or null. Not tied to `removed`: a member
   * who was already out can still have a live code behind them, and shutting it is
   * a write this call makes.
   */
  codeRetired: string | null;
}

/** The guard and the writes a removal performs, handed in by its caller. */
export interface RemovalRequest {
  now: number;
  /** Leaving a frozen room is never refused; eviction from one is. */
  frozen: "allow" | "refuse";
  /**
   * Record the member out AT THE REMOVAL EVENT'S OWN CURSOR, capping what they
   * read after it (#113) — not only stamping `leftAt`.
   *
   * A property of the caller, not of removal. The two callers differ on it:
   * `evictMember` is a creator deciding someone should be out, and it cuts;
   * `leaveRoom` is the member deciding for themselves, and it does not, because
   * one who chose to go keeps the open feed (R2). `announceReclaimed` says the
   * same of a timeout and warns against adding a cut here for symmetry with the
   * eviction. Read that comment before changing this.
   *
   * No default, deliberately. A removal that did not say reads as one that did
   * not decide, and the one a new caller would forget is the eviction — which is
   * #113 back again, in the operation written to close it.
   *
   * Applied through `markRemoved`, the same rule `appendEvent` applies for its
   * `markRemoved` extra, so a cut recorded by a removal and a cut recorded by an
   * append are one piece of code and cannot drift.
   */
  cut: boolean;
  /** When set, the call is refused unless it matches `session.createdBy`. */
  byUserId?: string;
  /** Written only if this call did the removing. */
  event: EventBody;
  /**
   * Retire this role's code, and write this event and queue this audit, if the code
   * is still live. That holds whether or not this call removed the member: a live
   * code behind one who is already out was never shut. The rows are queued only
   * when a code was retired, so a row says what this call did and not what its
   * caller expected to happen.
   */
  retire?: { role: string; event: EventBody; audit?: readonly AuditEntry[] };
  /** Queued in the same transaction and delivered by the outbox, only if this call did the removing. */
  audit: readonly AuditEntry[];
}

/**
 * What `seatMember` did. `refused` is null exactly when the member is seated.
 *
 * `reclaimed` lists the stale members this call departed to make the room, and
 * it is non-empty only when the seating succeeded — so a caller announcing them
 * is announcing removals that actually happened. A call that cannot free enough
 * seats refuses "full" and removes nobody: a partial reap would remove a member
 * for a joiner that never got in.
 *
 * `codesCleared` says what the seating did: it filled the room and retired the codes
 * the room held, in the same operation that seated the member. A room that fills with
 * no code left in it reports false, because nothing was cleared, and so does every
 * refusal, which writes nothing. "Filled" means a further joiner would be refused,
 * with no free seat and none reclaimable, which is not the same as every seat being
 * occupied: a stale seat is occupied and still reclaimable, so a room holding one
 * keeps its codes.
 *
 * Nothing in `bellman_confirm` reads it, and nothing announces a retired code: a room
 * that fills has its codes cleared without a word, as `clearJoinCodes` did. The field
 * is here so the outcome says what the seating did. `SessionDO` reads it to decide
 * whether the seating queued registry drops that want delivering, and the contract
 * suite reads it to pin what a seating did.
 */
export interface SeatOutcome {
  refused: "not_found" | "closed" | "frozen" | "full" | null;
  reclaimed: Member[];
  /** The seating filled the room and retired the codes it held. False when it held none. */
  codesCleared: boolean;
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
 * The hosted seat holds a seat and is never reclaimable (hosted seat spec, D5).
 * Its `lastSeenAt` moves only when it sends, so a quiet host reads stale, and
 * without this it would be the first seat a full room gave up.
 *
 * `null` means refuse: the room is full of members that are not reclaimable.
 * An empty array means seat them with nobody removed.
 */
export function seatVictims(
  members: Member[],
  cap: number,
  staleBefore: number,
  connected: ReadonlySet<string> = NO_SOCKETS,
): Member[] | null {
  const active = members.filter(isActiveMember);
  const needed = active.length - cap + 1;
  if (needed <= 0) return [];
  // Longest-quiet first: if only one seat has to go, it is the one whose member
  // has been gone longest.
  const victims = active
    .filter((m) => !isHostMember(m) && lastSeen(m) < staleBefore && !connected.has(m.memberId))
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
 * One exception, and it is not a flag: housekeeping's books (#66). `noteAppend` reads
 * an event's type and sender, because the departures that close a member's requests
 * are written by paths no caller flags (`removeMember`, `announceReclaimed`), and a
 * flag every caller had to remember is how the books would go stale. Both stores
 * apply it at the write, for a room that declared housekeeping.
 *
 * It is not an optimisation. The stamp and the event have to commit together or
 * a due tick can read one without the other, and the cut and its event have to
 * commit together or a reader can be refused at a cursor no stored event
 * carries; see `creditReport`, `markRemoved` and `SessionDO.appendEvent`.
 */
/**
 * What `setJoinCode` did, which a boolean could not say once the write became
 * conditional: `frozen` and `live_code_exists` are different refusals and the
 * caller answers them with different sentences.
 */
export type SetJoinCode =
  | { ok: true; replacedLive: boolean }
  | { ok: false; reason: "frozen" | "live_code_exists" };

/** What a blob charge did (#183, D3). `used` is the room's total after the call, or as it stood when refused. */
export type BlobCharge =
  | { ok: true; used: number }
  | { ok: false; reason: "over_quota" | "frozen" | "closed" | "not_found"; used: number };

/**
 * The charge rule (#183, D3), applied by both stores and decided nowhere else: the
 * order of the refusals, what `used` says on each, and the one comparison that is
 * the bound. Whether the room reads as closed is the caller's, because that is the
 * one input the stores compute differently (`closeIfAbandoned` in `MemoryStore`,
 * `readsClosed` in the room object). Returns the refusal, or the new total for the
 * caller to write.
 */
export function decideBlobCharge(
  s: Pick<StoredSession, "frozenAt" | "blobBytesCeiling" | "blobBytes">,
  closed: boolean,
  bytes: number,
): BlobCharge {
  const used = s.blobBytes ?? 0;
  if (closed) return { ok: false, reason: "closed", used };
  if (s.frozenAt !== null) return { ok: false, reason: "frozen", used };
  if (used + bytes > s.blobBytesCeiling) return { ok: false, reason: "over_quota", used };
  return { ok: true, used: used + bytes };
}

/** Whether a hosted-room slot was taken (I7), and when refused, how many the person holds open. */
export type HostedSlot = { ok: true } | { ok: false; open: number };

/**
 * What the hosted seat's write did (hosted seat spec, D3). A refusal says what
 * the room's month has spent (`used`) and may spend (`allowed`), so the seat can
 * say so in its one notice.
 */
export type HostAppend =
  | { ok: true; event: SessionEvent }
  | { ok: false; reason: "not_found" | "closed" | "frozen" | "removed" | "units" | "hourly"; used: number; allowed: number };

/**
 * The meter's decision (hosted seat spec, D3), shared by both stores so they
 * cannot charge differently. Returns the refusal, or the units record to write.
 * A host the room has evicted is refused (`removed`, C1) before the meter is read.
 *
 * A write of no units is the month's notice, which is outside the meter (spec D6, I9):
 * neither cap applies to it and the hour does not count it, so the spent month it reports
 * cannot refuse it. The seat also runs this read-only before it reads or calls anything
 * (I4, M7), so a wake the meter would refuse costs neither.
 */
export function decideHostCharge(
  s: Pick<StoredSession, "closed" | "frozenAt" | "members" | "hostUnitsPerMonth" | "hostUnits">,
  units: number,
  now: number,
): { ok: false; reason: "closed" | "frozen" | "removed" | "units" | "hourly"; used: number; allowed: number } | { ok: true; next: HostUnits } {
  if (s.closed) return { ok: false, reason: "closed", used: s.hostUnits.used, allowed: s.hostUnitsPerMonth };
  if (s.frozenAt !== null) return { ok: false, reason: "frozen", used: s.hostUnits.used, allowed: s.hostUnitsPerMonth };
  if (!hostSeated(s)) return { ok: false, reason: "removed", used: s.hostUnits.used, allowed: s.hostUnitsPerMonth };
  const month = monthKey(now);
  const current = s.hostUnits.month === month ? s.hostUnits : { month, used: 0, wakes: [] };
  if (units === 0) return { ok: true, next: current };
  const wakes = current.wakes.filter((t) => t > now - 3_600_000);
  if (wakes.length >= WAKES_PER_HOUR) return { ok: false, reason: "hourly", used: current.used, allowed: s.hostUnitsPerMonth };
  if (current.used + units > s.hostUnitsPerMonth) return { ok: false, reason: "units", used: current.used, allowed: s.hostUnitsPerMonth };
  return { ok: true, next: { month, used: current.used + units, wakes: [...wakes, now] } };
}

/**
 * The audit row a host's send owes (C1): the `sent_<type>` row `bellman_send` writes for
 * a member, so a team org's stream sees the host as it sees members. The host belongs to
 * no org, so only the room's own gets it. Both stores queue it in the send's own write.
 */
export function hostSentEntries(s: Pick<StoredSession, "id" | "orgId">, e: Omit<SessionEvent, "cursor" | "at">, now: number): AuditEntry[] {
  if (!s.orgId) return [];
  return [{
    at: now, orgId: s.orgId, sessionId: s.id, actorUserId: e.fromUserId, action: `sent_${e.type}`,
    detail: { chars: JSON.stringify(e.payload).length, ...(e.refId ? { ref_id: e.refId } : {}) },
  }];
}

/**
 * What a delete on demand was told (#65, D6). `purgeAt` is the time the room is stored with: the first
 * request's, whatever time a repeated one asked for. A client that asks again is told when the room goes,
 * and that is the record's word and not the clock of the request that is answering.
 */
export type PurgeSchedule =
  | { ok: true; purgeAt: number }
  | { ok: false; reason: "open" | "missing" };

/**
 * How many ids an index is read for, per call, when its rows are resolved and filtered before the answer
 * is full. The joined index lists every room a person ever held a handle in, closed ones included, in no
 * promised order, and is never pruned (`BellmanStore.sessionsJoinedBy`), so a window the size of the
 * answer, taken before the closed filter, cut live rooms for anyone past 50 memberships, and the cut was
 * permanent. The org index is the same shape (`sessionsForOrg`): open and closed rooms together, in no
 * promised order, so the admin's list asks it for this many and keeps the closed rooms of what it finds,
 * and the monitor's listing asks the joined index for the same. The created index needs no such room:
 * `sessionsCreatedBy` drops closed rows as it meets them.
 *
 * Each id the filter drops costs one `getSession`, so this is also the bound on that spend.
 * ponytail: a person whose live rooms sit past 500 dead memberships loses them from the monitor's
 * listing, and an org whose closed rooms sit past 500 index rows loses them from the admin's list; the
 * upgrade is a status-aware or pruned index, or a summary of the org's closed rooms (#49).
 */
export const JOINED_SCAN = 500;

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
  /**
   * Record the event's own `at` as the room's most recent `action_request`.
   *
   * Passed by `bellman_send` on an `action_request` append. Monotonic, and
   * re-asserted on an idempotent replay for `creditReport`'s reason: a caller
   * retrying cannot know whether the first attempt landed it.
   */
  stampActionRequest?: boolean;
  /**
   * Write or remove one surface row in the event's own transaction (#129),
   * under the rule in `applySurfaceWrite`: a newer cursor replaces, an older
   * or equal one is a no-op, `item: null` removes. The row and `surfaceCursor`
   * on the record commit with the event or not at all — a poll reads the
   * cursor off the record and a reader reads the row, and the two must not be
   * allowed to disagree.
   *
   * NOT applied on an idempotent replay, unlike the extras above. The row went
   * in with the event in one transaction, so a replay has nothing to repair, and
   * whatever has happened to the key since carries a higher cursor. A removal
   * leaves no tombstone, so re-applying the original write would find no row to
   * compare against and could only put back what was removed.
   */
  surface?: SurfaceWrite;
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

  /**
   * Issue a code for one role, retiring only that role's previous code.
   *
   * `guard.replaceLive` is the `revoke` authority, and it is decided HERE rather
   * than by the caller because the two cannot be separated. `issueInvite` used
   * to read the roster, see no live code, and then call this — so two callers
   * holding `invite` and not `revoke` could both observe no live code, and the
   * second write would retire the first's code with neither of them allowed to
   * (#90, found in review). The check and the write are one operation now: this
   * is the only place that can make them one, because it is the only place that
   * holds the record and the write together.
   *
   * `now` is a parameter so that liveness is the caller's clock, as it is for
   * `seatMember`: an expired code is not a live one, and minting over it is
   * opening a shut door rather than replacing an open one.
   */
  setJoinCode(
    sessionId: string,
    role: string,
    code: string,
    expiresAt: number,
    guard: { replaceLive: boolean; now: number },
  ): Promise<SetJoinCode>;
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
   *
   * When the seat it took fills the room, it also retires every role's join code,
   * and `codesCleared` says whether there was one to retire. That was
   * `bellman_confirm`'s second call, made once the seat had committed with nothing
   * spanning the two, and a failure there left the member in the room with no event,
   * no audit row and no member_id returned, and a connect token that is single use
   * and so could not replay (#116). "Fills" means a further joiner would be refused,
   * which is `seatVictims` answering null once this member is in: not a count of
   * undeparted members, because a stale seat is occupied and still reclaimable.
   */
  seatMember(
    sessionId: string,
    member: Member,
    staleBefore: number,
    now: number,
  ): Promise<SeatOutcome>;
  /**
   * Record a member out of a room, say so, and retire their seat's code — as ONE
   * operation.
   *
   * It cannot be four calls, and it was. `leaveRoom` read `leftAt` and wrote it
   * with an await between, so two calls on one handle both saw null and both
   * announced (#117). `evictMember` checked `closed` and `frozenAt` against a
   * snapshot and mutated afterwards, so a freeze landing in the window either
   * wrote to a room whose writes had stopped or swallowed the event the bridge
   * disarms its watcher on (#118). And a leave from a frozen room lost its event
   * outright, because the public append refuses while frozen (#73).
   *
   * The caller hands the event bodies in. The store writes the record it was
   * given and never asks what an event means — the constraint #147 set. The
   * frozen refusal stays on `appendEvent`, which is a different operation: this
   * one declares its own policy through `frozen`, so a leave records its
   * departure in a frozen room without the store learning that `member_left` is
   * special.
   *
   * `req.cut` says whether the removal also caps what the member reads after it,
   * at the departure event's own cursor (#113). The store applies `markRemoved`
   * for it, inside the same write — so the cut and the event it names commit
   * together, which is the whole of why it is not a call afterwards. Only the
   * caller knows: an eviction cuts and a leave does not. See `RemovalRequest.cut`.
   *
   * `removed: false` with `refused: null` is the idempotent path: the member was
   * already out. The departure is not written or queued again, so a retry
   * announces no second one. What is still owed is a live code behind them: a
   * leave retires none, so it was never shut, and shutting it is a write that has
   * not happened yet and not a duplicate of one that has. `codeRetired` says so.
   * With no live code, nothing is written and nothing is queued at all. Closing
   * the room if it has emptied is NOT part of this — `closeSessionIfEmpty` makes
   * that decision atomically on its own, and folding it in here would close over a
   * member who joined in the gap.
   */
  removeMember(
    sessionId: string,
    memberId: string,
    req: RemovalRequest,
  ): Promise<RemovalOutcome>;
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
   * "Nobody" is no member for whom `isActivePerson` holds: `isActiveMember`, and
   * not the hosted seat (#188). The host is not a person, so a hosted room closes
   * when its last person leaves, as a room without one does, with the seat still on
   * the roster. A frozen room closes like any other: freezing refuses writes into a
   * room someone is in, and an empty one is over either way.
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
   * Ask for a closed room to be purged at `at` rather than at the end of its window (#65, D6):
   * the delete on demand. Resolves to `{ ok: true, purgeAt }` for a closed room, `reason: "open"`
   * for a room that has not closed, which a delete never closes, and `reason: "missing"` for a room
   * that is not there, a purged one included. The purge itself is the store's own to carry out, by
   * `sweep` for MemoryStore and by the room's alarm for the Durable Objects store, so `ok` means
   * asked, not done.
   *
   * Asking again changes nothing and files nothing: the first request stands. A client that
   * retries a delete it never heard the answer to is the case, and the audit log owes one
   * `room_deleted` for each org on the roster, naming who asked, however often it was asked.
   * `purgeAt` says the same of the time: it is the one the room is stored with, the first
   * request's, and a repeat is told that and not the `at` it asked for. `by` is null when the
   * caller is not a person.
   */
  schedulePurge(sessionId: string, at: number, by: string | null): Promise<PurgeSchedule>;
  /**
   * The close-time sweep (#65, D3), run now: delete every object under this closed room's prefix
   * that no surface item names, and credit the room's `blobBytes` with their sizes. They are the
   * uploads that never reached an item: a put whose answer was lost, and a charge that threw and
   * was kept on purpose (#183). Resolves to how many objects it removed and how many bytes that
   * freed.
   *
   * Nothing happens to a room that is open, whose unnamed object is an upload between its put and
   * its charge or its item, or to one that is not there: `{ removed: 0, credited: 0 }`.
   *
   * The credit lands once. Two sweeps that overlap list the same objects and free the same bytes,
   * and the first to commit sets `blobsSwept`; the other changes the bucket and nothing else.
   *
   * MemoryStore calls this as a room closes, and from `sweep` for a room whose close it did not
   * see; the Durable Objects store calls it from the room's alarm, due the moment the room closes
   * and never again.
   */
  sweepBlobs(sessionId: string): Promise<{ removed: number; credited: number }>;
  /**
   * Sessions this user created that are not closed — newest first is not
   * promised, only that a lapsed plan can find the rooms it has to freeze. The
   * create *counts* used for quota cannot answer that: they are timestamps, not
   * identities.
   *
   * Closed rooms are left out, and `limit` counts the rooms returned rather than
   * the index rows read. Both halves are the same fix: the listing applied
   * `limit` to raw rows, so a prolific account's walk filled its window with
   * long-dead rooms and never reached the live ones — a freeze that silently did
   * nothing for exactly the accounts that use Bellman most (#75, #115). An
   * abandoned room counts as closed here whether or not its alarm has fired.
   *
   * A frozen room is still listed. Freezing one twice is harmless, and leaving it
   * out would hide it from the only listing that can find it again.
   *
   * The rows of the closed rooms it passes are deleted as it meets them, so the
   * index no longer grows for the life of an account and a dead room is paid for
   * once. `sessionsJoinedBy` keeps its rows deliberately; see there.
   *
   * **It may return fewer than `limit` when it meets a long run of closed
   * rooms.** The Durable Objects walk resolves each row in another object, and
   * the work it spends on rows the caller did not ask for — resolving a closed
   * one, then dropping it — is bounded by SWEEP_RPC_BUDGET, so a dead tail
   * cannot spend a Workers request's subrequest cap and throw. Live rows do not
   * count against that budget: they are what was asked for, `limit` bounds them,
   * and choosing a limit one request can resolve is the caller's part.
   *
   * A short list therefore always means progress was made — the rows it passed
   * are deleted, so the next call starts further in. A caller that needs the
   * whole set calls again rather than treating a short list as the end.
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
   * **Closed rooms are listed, and this index is not pruned** — the two ways it
   * differs from `sessionsCreatedBy`, and both follow from the sentence above.
   * This answers which rooms a person HELD a handle in, so a closed one is the
   * history being asked for rather than a tombstone, and a row whose room has
   * closed is still a true answer. The growth is the cost of that promise.
   * The one thing that prunes it is the purge (#65): a room that has been deleted
   * is no room at all, and its rows go with it.
   *
   * Order is not promised, and it differs between the stores — insertion order
   * in MemoryStore, key order in the Durable Objects store — so which rooms
   * survive `limit` is unspecified too.
   */
  sessionsJoinedBy(userId: string, limit: number): Promise<string[]>;
  /**
   * Rooms an org sat in, closed ones included (#65, D5): the ids the admin's list resolves. A room
   * is listed for the org of everyone it is created with, and for the org of each member who joins
   * it afterwards, so a person from another org joining adds the room to their org's list as well.
   * A member with no org adds it to none. The one thing that removes a row is the purge.
   *
   * Ids only, as `sessionsJoinedBy` answers them, and for the same reasons: no status parameter,
   * because the admin's list wants the closed rooms and a freeze sweep would want others; the
   * caller resolves each id and checks the record, since an index row names a room and only the
   * roster says whether the org is in it; and no order is promised, so which rooms survive `limit`
   * is unspecified.
   *
   * The Durable Objects store starts at its deploy, as its other indexes do: a room created
   * before then is not listed, and the admin's read of it by id works all the same.
   */
  sessionsForOrg(orgId: string, limit: number): Promise<string[]>;

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
  /**
   * The events after `cursor`, in cursor order: at most `limit` of them, the earliest,
   * when a limit is given. The hosted seat's read is the bounded one (I4); every other
   * caller reads the tail whole.
   */
  eventsAfter(sessionId: string, cursor: number, limit?: number): Promise<SessionEvent[]>;
  /**
   * The event at exactly this cursor, or undefined.
   *
   * One key, not a scan. `bellman_send` resolves an action_response's ref_id
   * this way; reading the whole history to find one event is what #25 was.
   */
  eventAt(sessionId: string, cursor: number): Promise<SessionEvent | undefined>;
  /**
   * The last `limit` events, in cursor order. A bounded read for callers that
   * want the end of the log and nothing else: the monitor's poll (#28) reads it
   * for each member's latest `progress` note and the room's last event, every
   * 15 seconds, for every room a user is in. `eventsAfter(id, 0)` would read
   * the whole log each time, and nothing guards that read the way
   * `lastActionRequestAt` guards `bellman_sync`'s.
   *
   * `[]` for an unknown room, and for a limit of zero or less: `slice(-0)` is
   * the whole array, so the memory store has to say so itself.
   */
  recentEvents(sessionId: string, limit: number): Promise<SessionEvent[]>;
  waitForEvents(sessionId: string, cursor: number, waitMs: number): Promise<SessionEvent[]>;
  /**
   * Every surface row of this room, sorted by key, as detached copies. An
   * unknown session answers none. One hop: the Durable Objects store reads the
   * rows inside the object and returns them together, which is why this is a
   * method and not N `eventAt` reads from a handler.
   */
  surfaceOf(sessionId: string): Promise<SurfaceRow[]>;
  /**
   * Charge `bytes` to this room's blob total unless that would pass the
   * room's own `blobBytesCeiling` (#183, D3), stamped at creation from the
   * plan that made it. The read and the write are one operation, for
   * seatMember's reason: two uploads landing together must not both read the
   * same total and both fit the last megabyte. Refused for a closed or frozen
   * room as every write is, with the total it would have charged against, and
   * `not_found` for no room. The upload route pre-checks the ceiling as a
   * courtesy and this is the bound: a refusal here is what deletes the object
   * just put. Nothing credits the total; retention (#65) will.
   */
  chargeBlobBytes(sessionId: string, bytes: number): Promise<BlobCharge>;
  /**
   * The hosted seat's one write (hosted seat spec, D3): the event and the charge
   * of `units` against the room's month, in one transaction. Refused, nothing is
   * written. `now` is the caller's clock, as `seatMember`'s is.
   *
   * `key` is the wake's intent id (`host:<cause>:<cursor>`, M6). A write under a key
   * already used returns the event that key wrote and charges nothing, so a seat that
   * runs a wake again after losing the response to its write cannot post or charge
   * twice. The key alone decides: the rerun's text is a new model call's.
   */
  appendHostEvent(sessionId: string, e: Omit<SessionEvent, "cursor" | "at">, units: number, now: number, key: string): Promise<HostAppend>;
  /** The host's write under `key` (M6), or undefined: what the seat checks before it calls the model. */
  hostEventFor(sessionId: string, key: string): Promise<SessionEvent | undefined>;
  /**
   * The hosted seat's allowance for a new month (I7): `units`, its creator's plan's as the
   * seat read it at the month's first wake, 0 once that plan includes no hosted seat, with
   * the meter started empty in `month`. A renewal for a month the meter has reached already
   * changes nothing, so a second one cannot hand back what the month has spent. A missing
   * room is a no-op.
   */
  renewHostAllowance(sessionId: string, month: string, units: number): Promise<void>;

  putPendingConnect(p: PendingConnect): Promise<void>;
  takePendingConnect(token: string): Promise<PendingConnect | undefined>;

  countCreatesThisMonth(userId: string): Promise<number>;
  recordCreate(userId: string): Promise<void>;
  /**
   * Take one of this person's hosted-room slots for `sessionId`, unless `limit` are held
   * already (I7): the count and the record are one operation, so two starts at the limit
   * cannot both pass. A plan's hosted rooms are the most a person holds open at once; a
   * slot is given back when the room closes, which both stores do inside their closes,
   * or is purged. Taking a slot the room already holds is not a second room.
   */
  reserveHostedRoom(userId: string, sessionId: string, limit: number): Promise<HostedSlot>;
  /** Give the slot back. Idempotent. `bellman_start` calls it when the room it reserved for was not created. */
  releaseHostedRoom(userId: string, sessionId: string): Promise<void>;

  /** A person's saved presets (designer spec D4), in name order. Keyed by the person: nothing here reads another's. */
  listPresets(userId: string): Promise<SavedPreset[]>;
  getPreset(userId: string, name: string): Promise<SavedPreset | undefined>;
  /**
   * Save or replace by name. "full" when a new name would pass `cap`; replacing
   * one never counts against it. The count and the write are one operation, so
   * two saves racing for the last place cannot both land.
   */
  putPreset(userId: string, preset: SavedPreset, cap: number): Promise<"saved" | "full">;
  /** True when there was one to delete. */
  deletePreset(userId: string, name: string): Promise<boolean>;

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

  /**
   * Housekeeping that cannot wait for a read: closes the rooms nobody has been in for 90 days
   * (#18), purges the closed rooms whose window has run out or whose delete was asked for (#65),
   * sweeps the unnamed objects of a closed room whose close it did not see (#65), and drops
   * expired connect tokens. MemoryStore does all of it here; the Durable Objects store does
   * none, because each room's alarm does its room's.
   */
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
  /** Rooms by the orgs that sat in them (#65, D5): written where `byMember` is, cleared by the purge. */
  private byOrg = new Map<string, Set<string>>();
  private pending = new Map<string, PendingConnect>();
  private creates = new Map<string, number[]>(); // userId -> timestamps
  private hostedOpen = new Map<string, Set<string>>(); // userId -> the hosted rooms holding a slot (I7)
  private presets = new Map<string, Map<string, SavedPreset>>(); // userId -> name -> preset
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
  /**
   * Surface rows, by session then by key. Beside `keys` for the same reason it
   * is: the Session record is what SessionDO persists, and the rows live under
   * their own storage keys there too.
   */
  private surfaces = new Map<string, Map<string, SurfaceRow>>();
  /**
   * Where the purge deletes a room's objects from (#65). Hand it the store the routes and the
   * tools serve, as `src/index.ts` does, or the purge empties a bucket nobody reads. Absent, the
   * store holds one of its own, which has nothing in it unless the caller put it there.
   */
  private readonly blobs: BlobStore;

  /** `host` is what a wake of a hosted seat does here: the Node server hands in `MemoryHost.wake`. */
  constructor(private readonly options: { blobs?: BlobStore; host?: (wake: HostWake) => void } = {}) {
    this.blobs = options.blobs ?? new MemoryBlobStore();
  }

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
    for (const orgId of orgsOnRoster(stored)) this.indexOrg(orgId, stored.id);
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

  /** The org index's one writer (#65, D5), for the same reason: a member with no org writes nothing. */
  private indexOrg(orgId: string | null, sessionId: string): void {
    if (!orgId) return;
    const rooms = this.byOrg.get(orgId) ?? new Set<string>();
    rooms.add(sessionId);
    this.byOrg.set(orgId, rooms);
  }

  async getSession(id: string): Promise<StoredSession | undefined> {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    this.closeIfAbandoned(s, Date.now());
    // The events come off before the copy, not after it (#134): detach is a deep clone,
    // so cloning first paid for the room's whole history on every call and then threw it
    // away. closeIfAbandoned has already run on `s`, so nothing it did is skipped by cloning later.
    const { events: _events, ...rest } = s;
    return detach(rest);
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
    sessionId: string, role: string, code: string, expiresAt: number,
    guard: { replaceLive: boolean; now: number },
  ): Promise<SetJoinCode> {
    const s = this.sessions.get(sessionId);
    if (!s) return { ok: false, reason: "frozen" };
    if (s.frozenAt !== null) return { ok: false, reason: "frozen" };
    const previous = s.joinCodes[role];
    // Live, not merely present: an expired record shuts no door.
    const live = previous !== undefined && guard.now <= previous.expiresAt;
    if (live && !guard.replaceLive) return { ok: false, reason: "live_code_exists" };
    // No awaits between the test above and the writes below, which is what makes
    // this atomic here — the same arrangement appendEvent and addMember use. The
    // Durable Object gets it from a transaction instead.
    if (previous) this.byJoinCode.delete(previous.code); // only THIS role's old code
    s.joinCodes[role] = { code, expiresAt };
    this.byJoinCode.set(code, sessionId);
    return { ok: true, replacedLive: live };
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
    this.indexOrg(member.orgId, sessionId);
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
    if (!s) return { refused: "not_found", reclaimed: [], codesCleared: false };
    if (s.closed) return { refused: "closed", reclaimed: [], codesCleared: false };
    if (s.frozenAt !== null) return { refused: "frozen", reclaimed: [], codesCleared: false };

    const connected = connectedAmong(s.members, this.attachedTo(sessionId));
    const victims = seatVictims(s.members, capacityOf(s.manifest), staleBefore, connected);
    if (victims === null) return { refused: "full", reclaimed: [], codesCleared: false };

    const reclaimed: Member[] = [];
    for (const v of victims) {
      const row = s.members.find((m) => m.memberId === v.memberId)!;
      row.leftAt = now;
      reclaimed.push(detach(row));
    }
    s.members.push(detach(member));
    // After the guards, so a refused seating leaves no trace in the listing.
    this.indexMember(member.userId, sessionId);
    this.indexOrg(member.orgId, sessionId);

    // A full room has no seat for ANY role, so every code goes — decided and
    // written here rather than by the caller afterwards. As a second call made
    // once the seat had committed it had nothing spanning it: a failure left the
    // joiner seated with the codes still redeemable (#116).
    //
    // "Full" is asked the only way that preserves what the caller used to
    // compute: whether a FURTHER joiner would be refused. Counting members with
    // a null leftAt is not the same question — a stale seat is occupied but
    // reclaimable, so a room with one still has a door worth leaving open, and
    // counting would have retired its code.
    //
    // Cleared by presence, where removeMember retires only a code that is still live
    // (`req.now <= rec.expiresAt`). The two ask different questions. A removal
    // announces a door shutting, so it must not announce one that had already shut,
    // and an expired record is not a door. A seating announces nothing: it tidies
    // rows, and a full room needs no code at all, so an expired record goes with the
    // rest. A room that fills while holding only one therefore reports
    // `codesCleared: true`, which answers this question and does not contradict the
    // other. The contract suite pins this side, and its expired-code cases for
    // removeMember pin the other.
    const full = seatVictims(s.members, capacityOf(s.manifest), staleBefore, connected) === null;
    const codes = full ? Object.values(s.joinCodes) : [];
    if (full) {
      for (const rec of codes) this.byJoinCode.delete(rec.code);
      s.joinCodes = {};
    }
    // What the call did, and not only whether the room filled: a room that fills
    // with no code left in it had nothing to retire.
    return { refused: null, reclaimed, codesCleared: codes.length > 0 };
  }

  async removeMember(
    sessionId: string,
    memberId: string,
    req: RemovalRequest,
  ): Promise<RemovalOutcome> {
    // No await from here to the last write, deliberately — the same rule, and
    // the same reason, as seatMember and closeSessionIfEmpty. The Durable
    // Objects store gets it from a transaction instead.
    const none = { removed: false, codeRetired: null };
    const s = this.sessions.get(sessionId);
    if (!s) return { refused: "not_found", ...none };
    if (s.closed) return { refused: "closed", ...none };
    if (req.frozen === "refuse" && s.frozenAt !== null) return { refused: "frozen", ...none };
    if (req.byUserId !== undefined && s.createdBy !== req.byUserId) {
      return { refused: "forbidden", ...none };
    }
    const m = s.members.find((mm) => mm.memberId === memberId);
    if (!m) return { refused: "not_found", ...none };

    // One value for "there is a live door to shut", so nothing downstream has to
    // re-derive it. Nothing prunes an expired record, so a code's presence in
    // joinCodes is not the same as a door being open. Decided before the member's
    // state is looked at, because a live door is owed to one who is already out as
    // much as to one who is not.
    const rec = req.retire ? s.joinCodes[req.retire.role] : undefined;
    const retiring = req.retire && rec && req.now <= rec.expiresAt
      ? { role: req.retire.role, code: rec.code, event: req.retire.event, audit: req.retire.audit ?? [] }
      : null;

    // Already out: the idempotent path. The departure is not said again, which is
    // the point of it. A live door behind them is a different matter: it was never
    // shut, so shutting it is a write that has not happened yet and not a
    // duplicate. With neither owed, nothing is written.
    const leaving = isActiveMember(m);
    if (!leaving && !retiring) return { refused: null, ...none };

    if (leaving) {
      // The event first, then the member write, because a cut names the
      // departure's OWN cursor and the departure has none until it is written.
      const departure = this.appendNow(s, req.event);
      // `markRemoved` and not a `leftAt` of this method's own, so the cut an
      // eviction records here is the write `appendEvent`'s `markRemoved` extra
      // makes — one rule, applied inside both stores (#113). It replaces the
      // array rather than mutating `m`, which is why nothing below reads `m`.
      //
      // `req.now` for the stamp and not `departure.at`: within a removal the
      // caller's clock is the operation's, and the contract pins `leftAt` to the
      // `now` it was handed. A room where the two disagree is a room whose
      // members left at a time nobody asked for.
      //
      // Null is unreachable from here — `leaving` already read `leftAt` as null,
      // in this same synchronous stretch, and the roster names `m`. It falls back
      // to the roster unchanged rather than asserting, because the alternative to
      // a cut is not a stamp of this method's own: that is the half-write the
      // transaction exists to prevent.
      if (req.cut) {
        s.members = markRemoved(s.members, memberId, departure.cursor, req.now) ?? s.members;
      } else {
        // The roster as it stands now, and not `m`: the departure just written may have
        // replaced the roster's member objects (housekeeping's books stamp the leaver's
        // last send), and a `leftAt` set on `m` would land on a member nobody holds.
        s.members = s.members.map((mm) => (mm.memberId === memberId ? { ...mm, leftAt: req.now } : mm));
      }
    }
    if (retiring) {
      this.byJoinCode.delete(retiring.code);
      delete s.joinCodes[retiring.role];
      this.appendNow(s, retiring.event);
    }
    // A falsy org names a stream nobody reads, and the Durable Objects store
    // drops such an entry rather than file it, so this one does too. The member's
    // rows, then the door's: the order the events were written in.
    this.recordAudit(
      [...(leaving ? req.audit : []), ...(retiring ? retiring.audit : [])].filter((e) => e.orgId),
    );

    return { refused: null, removed: leaving, codeRetired: retiring?.role ?? null };
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
    await this.sweepAfterClose(sessionId);
  }

  async closeSessionIfEmpty(sessionId: string): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    // No await from here to the write, deliberately. The check and the close are
    // one operation, and a yield between them is the window a join lands in: the
    // same rule, and the same reason, as waitForEvents and the guarded grant
    // writes. The Durable Objects store gets it from a transaction instead. The
    // sweep that follows is after the close, so it is outside that rule.
    if (s.closed) return true;
    if (s.members.some(isActivePerson)) return false;
    this.closeNow(s);
    await this.sweepAfterClose(sessionId);
    return true;
  }

  /**
   * The sweep as a room closes (#65, D3), for the store that has no alarm to run it. A bucket that
   * refuses must not turn a close that happened into a failure: the room is closed either way,
   * `blobsSwept` stays false, and `sweep` finds the room and tries again.
   */
  private async sweepAfterClose(sessionId: string): Promise<void> {
    // Only a sweep that is owed: a second close of a room already swept looks at nothing.
    const s = this.sessions.get(sessionId);
    if (!s || sweepDueAt(s) === null) return;
    try {
      await this.sweepBlobs(sessionId);
    } catch (err) {
      console.error(`sweep of ${sessionId} failed; the next sweep tries again:`, err);
    }
  }

  async sweepBlobs(sessionId: string): Promise<{ removed: number; credited: number }> {
    const room = this.sessions.get(sessionId);
    if (!room || !room.closed) return { removed: 0, credited: 0 };
    // The objects are listed before the rows are read, so an object an item names is listed first
    // and named after, never the reverse.
    const listed = await this.blobs.list(sessionId);
    const orphans = unnamedObjects(listed, await this.surfaceOf(sessionId));
    let credited = 0;
    for (const object of orphans) {
      await this.blobs.delete(sessionId, object.id);
      credited += object.bytes;
    }
    // Read again, because the awaits above are where a purge or another sweep could get in. Only the
    // sweep that finds `blobsSwept` still false credits the room, so two that listed the same
    // objects do not free the same bytes twice.
    const s = this.sessions.get(sessionId);
    if (s && !s.blobsSwept) {
      const charged = (s as { blobBytes?: number }).blobBytes ?? 0;
      (s as { blobBytes?: number }).blobBytes = creditedBlobBytes(charged, credited);
      s.blobsSwept = true;
    }
    return { removed: orphans.length, credited };
  }

  /**
   * The close itself, with no awaits in it, so both public closers can call it
   * without yielding between their guard and their write. The same arrangement,
   * and the same reason, as appendNow.
   *
   * Agrees with closeIfAbandoned: a closed room's codes stop resolving AND stop
   * occupying the index, rather than relying on the `closed` guard alone.
   *
   * Dates the close once (#65): `closedAt` is where the retention window starts, so a
   * second close, or a read that finds the room closed again, must not move it. `at` is
   * the clock of the caller that has one, so an abandonment is dated as its
   * `session_expired` event is.
   */
  private closeNow(s: Session, at = Date.now()): void {
    s.closed = true;
    s.closedAt ??= at;
    for (const rec of Object.values(s.joinCodes)) this.byJoinCode.delete(rec.code);
    s.joinCodes = {};
    // A hosted room gives its creator's slot back as it closes (I7), however it closes.
    if (s.manifest.host !== null) this.hostedOpen.get(s.createdBy)?.delete(s.id);
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
   *
   * The thaw also stamps every active member as seen now (#18). `touchMember`
   * refuses a frozen room, so the window was not moving while it was frozen;
   * without this stamp a room thawed after 90 days frozen would be swept on the
   * next read.
   *
   * And it records the moment, `thawedAt` (#66, R9), which housekeeping floors its
   * clocks at: a finding computed across the freeze would name a condition the room
   * imposed. Paid on the same transition, for the same reason.
   */
  async freezeSession(sessionId: string, frozenAt: number | null): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const wasFrozen = s.frozenAt !== null;
    s.frozenAt = frozenAt;
    if (frozenAt === null && wasFrozen) {
      const now = Date.now();
      // The report credit (#111 D10) and the presence stamp (#18) ride the same
      // transition: a room coming back from a freeze gets a full window, not the
      // one the freeze spent.
      s.members = stampSeen(clearSilence(s, now), now);
      s.thawedAt = now;
    }
  }

  async schedulePurge(sessionId: string, at: number, by: string | null): Promise<PurgeSchedule> {
    const s = this.sessions.get(sessionId);
    if (!s) return { ok: false, reason: "missing" };
    if (!s.closed) return { ok: false, reason: "open" };
    // Asked already: the first request stands, is on the record once, and is the time the answer gives.
    if (s.purgeAt !== null) return { ok: true, purgeAt: s.purgeAt };
    s.purgeAt = at;
    this.recordAudit(orgsOnRoster(s).map((orgId) => roomDeletedEntry(s, orgId, by, Date.now())));
    return { ok: true, purgeAt: at };
  }

  async sessionsCreatedBy(userId: string, limit: number): Promise<string[]> {
    const mine = this.byCreator.get(userId);
    if (!mine) return [];
    const live: string[] = [];
    for (const id of mine) {
      if (live.length >= limit) break;
      const s = this.sessions.get(id);
      // `closeIfAbandoned` first, for the same reason getSession calls it: an
      // abandoned room is closed whether or not anything has written that down
      // yet, and a sweep that read the flag alone would keep every abandoned room
      // in the window until something else happened to touch it.
      if (s) this.closeIfAbandoned(s, Date.now());
      if (s && !s.closed) {
        live.push(id);
        continue;
      }
      // Self-healing, and the reason `limit` can now be trusted: the row goes as
      // it is encountered, so a walk pays for a dead room once rather than on
      // every listing forever (#75).
      mine.delete(id);
    }
    return live;
  }

  async sessionsJoinedBy(userId: string, limit: number): Promise<string[]> {
    return [...(this.byMember.get(userId) ?? [])].slice(0, limit);
  }

  async sessionsForOrg(orgId: string, limit: number): Promise<string[]> {
    return [...(this.byOrg.get(orgId) ?? [])].slice(0, limit);
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
    this.wakeHost(s, event);
    return detach(event);
  }

  /**
   * Called synchronously once an append has landed that wakes the hosted seat
   * (hosted seat spec, D4): hands the wake to `options.host`, the Node server's
   * `MemoryHost`, or to nothing when none was given. `SessionDO` queues the same
   * wakes as outbox rows, in the event's own transaction.
   */
  protected hostWoken(wake: HostWake): void {
    this.options.host?.(wake);
  }

  /**
   * Wake the hosted seat if `event` is one of the two causes (spec D4): a
   * `heartbeat`, or a reply to one of the host's events, in a room whose
   * manifest has a host and which has not evicted it (`hostSeated`, C1).
   *
   * Called by the two public appends once the event and its extras have landed,
   * which are `SessionDO`'s places too, and not from `appendNow`: the host's own
   * answer names its question as `refId`, so it reads as a reply, and
   * `appendHostEvent` queues no wake in either store. No awaits, for
   * appendEvent's reason.
   *
   * The two causes stay two (ruling H1). A housekeeping proposal (#66) is a server event
   * with no `refId`, so it falls through here, and it must: waking spends the room's
   * host units on the server's initiative, which a proposal's design rules out.
   */
  private wakeHost(s: Session, event: SessionEvent): void {
    if (s.manifest.host === null || !hostSeated(s)) return;
    if (event.type === "heartbeat") this.hostWoken({ sessionId: s.id, cause: "tick", cursor: event.cursor });
    else if (event.refId !== null) {
      const referenced = s.events.find((x) => x.cursor === Number(event.refId));
      if (isReplyToHost(event, referenced)) this.hostWoken({ sessionId: s.id, cause: "reply", cursor: event.cursor });
    }
  }

  async appendHostEvent(sessionId: string, e: Omit<SessionEvent, "cursor" | "at">, units: number, now: number, key: string): Promise<HostAppend> {
    const s = this.sessions.get(sessionId);
    if (!s) return { ok: false, reason: "not_found", used: 0, allowed: 0 };
    // Synchronous from here, for appendEventOnce's reason: the key check, the event, the
    // meter, the stamp and the audit row land together.
    const storageKey = idempotencyKey(e.fromMemberId, key);
    const done = this.keys.get(sessionId)?.get(storageKey);
    if (done) {
      const original = s.events.find((ev) => ev.cursor === done.cursor);
      if (!original) throw new Error(`Idempotency record names missing cursor ${done.cursor}`);
      return { ok: true, event: detach(original) };
    }
    const charge = decideHostCharge(s, units, now);
    if (!charge.ok) return charge;
    const event = this.appendNow(s, e);
    const keys = this.keys.get(sessionId) ?? new Map<string, IdempotencyRecord>();
    keys.set(storageKey, { cursor: event.cursor, print: fingerprint(e) });
    this.keys.set(sessionId, keys);
    s.hostUnits = charge.next;
    s.members = s.members.map((m) => m.memberId === e.fromMemberId ? { ...m, lastSeenAt: now } : m);
    this.recordAudit(hostSentEntries(s, e, now));
    return { ok: true, event: detach(event) };
  }

  async renewHostAllowance(sessionId: string, month: string, units: number): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s || s.hostUnits.month >= month) return;
    s.hostUnitsPerMonth = units;
    s.hostUnits = { month, used: 0, wakes: [] };
  }

  async hostEventFor(sessionId: string, key: string): Promise<SessionEvent | undefined> {
    const done = this.keys.get(sessionId)?.get(idempotencyKey(HOST_MEMBER_ID, key));
    const s = this.sessions.get(sessionId);
    const event = done && s?.events.find((ev) => ev.cursor === done.cursor);
    return event ? detach(event) : undefined;
  }

  /**
   * Apply an append's `extras`, if it asked for any. The roster rules,
   * `creditReport` and `markRemoved`, live in this module and the surface rule,
   * `applySurfaceWrite`, in surface.ts; `SessionDO`'s `extraRows` applies the
   * same functions, so the two stores cannot disagree about when an extra rides
   * an append. The action-request stamp is the one extra with no function to
   * share: it is a line in each store.
   *
   * One method rather than one per extra, because the two roster rules rewrite
   * the same member array: applied separately, the second would read `s.members`
   * from before the first and discard it.
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
    // Monotonic, so a replay of an older append cannot pull the stamp back and
    // make a live request invisible to the poll.
    if (extras.stampActionRequest) {
      const stored = s as { lastActionRequestAt?: number };
      stored.lastActionRequestAt = Math.max(stored.lastActionRequestAt ?? 0, event.at);
    }
    if (extras.surface !== undefined) {
      const rows = this.surfaces.get(s.id) ?? new Map<string, SurfaceRow>();
      const verdict = applySurfaceWrite(rows.get(extras.surface.key), event, extras.surface);
      if (verdict !== null) {
        // Copied in, as the event is in `appendNow`: the item holds objects of its
        // own (`placement`, `ends`), and storing the caller's would let a caller
        // that kept them rewrite the row. The Durable Object store gets the copy
        // from the RPC boundary.
        if (verdict === "remove") rows.delete(extras.surface.key);
        else rows.set(extras.surface.key, detach(verdict));
        this.surfaces.set(s.id, rows);
        // Monotonic, as the action-request stamp is: a change moves it forward
        // and nothing moves it back.
        const stored = s as { surfaceCursor?: number };
        stored.surfaceCursor = Math.max(stored.surfaceCursor ?? 0, event.cursor);
      }
    }
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
      // The replay re-asserts the member extras (`creditReport`, `markRemoved`
      // and `stampActionRequest`) and applies no surface write.
      //
      // A retry cannot know whether the first attempt landed a member write, and
      // each of the three is monotonic or answers `null` once it is recorded, so
      // re-asserting one is either a repair or a no-op and never a regression.
      // `original` and not `e`, so `markRemoved` sees the cursor the key names: a
      // replay re-asserts the same cut.
      //
      // The surface write is the exception, so it is taken out of the extras. The
      // row went in with the event in one transaction, so there is nothing to
      // repair, and whatever has happened to the key since carries a higher
      // cursor. A removal leaves no tombstone, so re-applying the original write
      // would find no row to compare against and could only put back what was
      // removed.
      this.applyExtras(s, original, { ...extras, surface: undefined });
      return { outcome: "replayed", event: detach(original) };
    }

    if (s.frozenAt !== null) return { outcome: "frozen" };

    const event = this.appendNow(s, e);
    const map = seen ?? new Map<string, IdempotencyRecord>();
    map.set(storageKey, { cursor: event.cursor, print });
    this.keys.set(sessionId, map);
    this.applyExtras(s, event, extras);
    this.wakeHost(s, event);
    return { outcome: "appended", event: detach(event) };
  }

  /**
   * The append itself, with no awaits in it, so both public appenders can call
   * it without yielding between their guard and their write. Same rule, and
   * the same reason, as liveGrant and waitForEvents.
   */
  private appendNow(s: Session, e: Omit<SessionEvent, "cursor" | "at">, at = Date.now()): SessionEvent {
    const event: SessionEvent = {
      ...detach(e), cursor: s.events.length + 1, at,
    };
    s.events.push(event);
    // Housekeeping's books (#66), in the same synchronous stretch as the push so the event
    // and what it owes land together. Here, where every event joins a room's log, because
    // a departure is written by `removeMember` and not by a send. The roster is replaced,
    // not edited, so a caller holding a member object across this call holds a stale one.
    const books = noteAppend(s, event);
    if (books !== s) Object.assign(s, books);
    this.wake(s);
    return event;
  }

  async eventsAfter(sessionId: string, cursor: number, limit?: number): Promise<SessionEvent[]> {
    const s = this.sessions.get(sessionId);
    if (!s) return [];
    return detach(s.events.filter((e) => e.cursor > cursor).slice(0, limit));
  }

  async eventAt(sessionId: string, cursor: number): Promise<SessionEvent | undefined> {
    const e = this.sessions.get(sessionId)?.events.find((ev) => ev.cursor === cursor);
    return e ? detach(e) : undefined;
  }

  async recentEvents(sessionId: string, limit: number): Promise<SessionEvent[]> {
    const s = this.sessions.get(sessionId);
    if (!s || limit <= 0) return [];
    return detach(s.events.slice(-limit));
  }

  async surfaceOf(sessionId: string): Promise<SurfaceRow[]> {
    const rows = this.surfaces.get(sessionId);
    if (!rows) return [];
    const sorted = [...rows.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return detach(sorted);
  }

  async chargeBlobBytes(sessionId: string, bytes: number): Promise<BlobCharge> {
    // No await from the read to the write — the rule, and the reason, seatMember
    // gives. `closeIfAbandoned` first, as getSession does: an abandoned room is
    // closed whether or not anything has written that down yet.
    const s = this.sessions.get(sessionId);
    if (!s) return { ok: false, reason: "not_found", used: 0 };
    this.closeIfAbandoned(s, Date.now());
    const charge = decideBlobCharge(s, s.closed, bytes);
    if (charge.ok) (s as { blobBytes?: number }).blobBytes = charge.used;
    return charge;
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
    return this.countMonth(this.creates, userId);
  }

  async recordCreate(userId: string): Promise<void> {
    this.recordMonth(this.creates, userId);
  }

  async reserveHostedRoom(userId: string, sessionId: string, limit: number): Promise<HostedSlot> {
    // No await: the count and the record are one step, for seatMember's reason.
    const held = this.hostedOpen.get(userId) ?? new Set<string>();
    if (held.has(sessionId)) return { ok: true };
    if (held.size >= limit) return { ok: false, open: held.size };
    held.add(sessionId);
    this.hostedOpen.set(userId, held);
    return { ok: true };
  }

  async releaseHostedRoom(userId: string, sessionId: string): Promise<void> {
    this.hostedOpen.get(userId)?.delete(sessionId);
  }

  /** The monthly create count's rule, as `RegistryDO`'s `#countMonth` is, so the two cannot drift. */
  private countMonth(counts: Map<string, number[]>, userId: string): number {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    return (counts.get(userId) ?? []).filter((t) => t >= monthStart).length;
  }

  private recordMonth(counts: Map<string, number[]>, userId: string): void {
    const list = counts.get(userId) ?? [];
    list.push(Date.now());
    counts.set(userId, list);
  }

  async listPresets(userId: string): Promise<SavedPreset[]> {
    const mine = this.presets.get(userId);
    if (!mine) return [];
    // Code-unit order, which is the registry's key order.
    return detach([...mine.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
  }

  async getPreset(userId: string, name: string): Promise<SavedPreset | undefined> {
    const p = this.presets.get(userId)?.get(name);
    return p && detach(p);
  }

  async putPreset(userId: string, preset: SavedPreset, cap: number): Promise<"saved" | "full"> {
    const mine = this.presets.get(userId) ?? new Map<string, SavedPreset>();
    if (!mine.has(preset.name) && mine.size >= cap) return "full";
    mine.set(preset.name, detach(preset));
    this.presets.set(userId, mine);
    return "saved";
  }

  async deletePreset(userId: string, name: string): Promise<boolean> {
    return this.presets.get(userId)?.delete(name) ?? false;
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
    for (const s of this.sessions.values()) this.closeIfAbandoned(s, now);
    // After the abandonment pass, so a room it has just closed is judged on the same clock. Walked
    // from a copy, because a purge deletes from the map.
    for (const s of [...this.sessions.values()]) {
      const purge = purgeDueAt(s);
      if (purge !== null && now >= purge) {
        // The purge wins when the sweep is due as well: it deletes every object and the room, so a
        // sweep first is work thrown away.
        await this.purgeNow(s, now);
        continue;
      }
      const sweep = sweepDueAt(s);
      if (sweep !== null && now >= sweep) await this.sweepBlobs(s.id);
    }
    for (const [token, p] of this.pending) {
      if (now > p.expiresAt) this.pending.delete(token);
    }
  }

  /**
   * The Node server's heartbeat (#111, #188): for every room, what SessionDO's alarm
   * does for one. `step` is `tickStep` from heartbeat.ts, handed in because that module
   * imports this one; it decides, and this writes. Not on `BellmanStore`: the Workers
   * store ticks by alarm.
   *
   * A room whose tick is not due is left alone, clock included. The caller runs this
   * far more often than any cadence, and moving `lastTickAt` on every call would push
   * every room's next tick back for good. A due room either gets its heartbeat, written
   * as `#tickIfDue` writes it, or only its clock moved; the seat is woken after the
   * write when the step says so. No awaits, for appendEvent's reason.
   */
  tick(now: number, step: (s: StoredSession, now: number) => TickStep): void {
    for (const s of this.sessions.values()) {
      if (s.closed || s.frozenAt !== null || s.manifest.heartbeatOnMs === null) continue;
      if (isAbandoned(s, now, connectedAmong(s.members, this.attachedTo(s.id)))) continue;
      const r = step(s, now);
      if (!r.due) continue;
      (s as { lastTickAt?: number }).lastTickAt = now;
      if (!r.write) continue;
      const tick = this.appendNow(s, {
        type: "heartbeat", fromMemberId: "system", fromUserId: "system", fromLabel: "bellman",
        payload: r.payload, refId: null,
      }, now);
      if (!r.wakeHost) continue;
      // The host's own clock moves only on a tick that wakes it (I3), in the same step as the tick.
      (s as { lastHostTickAt?: number | null }).lastHostTickAt = now;
      this.hostWoken({ sessionId: s.id, cause: "tick", cursor: tick.cursor });
    }
  }

  /**
   * The purge (#65, D2), in the order the Durable Objects store keeps: the bytes first, then what
   * the rest of the store holds about the room, then the room. The first step is the only one that
   * can fail, and it fails before anything is forgotten, so a failed purge leaves a room the next
   * sweep tries again. What the order guarantees is never bytes that no record can find. It does not
   * keep a room from naming bytes that are gone: from the bucket's delete to the forgetting the room
   * is there and its objects are not, and a download of one answers 404, as it does for any
   * reference that dangles.
   *
   * A poll still waiting on the room is answered with nothing rather than dropped: it registered a
   * promise, and its own timer would find no waiter to settle.
   */
  private async purgeNow(s: Session, now: number): Promise<void> {
    await this.blobs.deleteAll(s.id);
    this.byCreator.get(s.createdBy)?.delete(s.id);
    this.hostedOpen.get(s.createdBy)?.delete(s.id);
    for (const m of s.members) this.byMember.get(m.userId)?.delete(s.id);
    for (const orgId of orgsOnRoster(s)) this.byOrg.get(orgId)?.delete(s.id);
    for (const rec of Object.values(s.joinCodes)) this.byJoinCode.delete(rec.code);
    this.recordAudit(orgsOnRoster(s).map((orgId) => roomPurgedEntry(s, orgId, now)));
    for (const w of this.waiters.get(s.id) ?? []) w.resolve([]);
    this.waiters.delete(s.id);
    this.keys.delete(s.id);
    this.surfaces.delete(s.id);
    this.sessions.delete(s.id);
  }

  /** Resolve every waiter on a session from its own cursor. */
  private wake(s: Session): void {
    const ws = this.waiters.get(s.id);
    if (!ws || ws.length === 0) return;
    this.waiters.set(s.id, []);
    for (const w of ws) w.resolve(detach(s.events.filter((ev) => ev.cursor > w.after)));
  }

  /**
   * Operates on the canonical session; callers hold detached copies.
   *
   * The abandonment rule is `isAbandoned`'s, shared with SessionDO's alarm and
   * readers. A socket vouching for an active member is the one way a room past
   * the window stays open, and it is recorded: those members are stamped as seen
   * now, which is what `webSocketClose` does on a drop (#152), so the next sweep
   * finds a fresh window rather than the same question.
   */
  private closeIfAbandoned(s: Session, now: number): void {
    const due = abandonedAt(s);
    if (due === null || now <= due) return;
    const connected = connectedAmong(s.members, this.attachedTo(s.id));
    if (!isAbandoned(s, now, connected)) {
      s.members = stampSeen(s.members, now, connected);
      return;
    }
    this.closeNow(s, now);
    const event: SessionEvent = {
      cursor: s.events.length + 1,
      type: "session_expired" as EventType,
      fromMemberId: "system",
      fromUserId: "system",
      fromLabel: "bellman",
      payload: { reason: "abandoned", last_seen_at: new Date(due - ABANDONED_AFTER_MS).toISOString() },
      refId: null,
      at: now,
    };
    s.events.push(event);
    this.wake(s);
  }
}

/**
 * How many cross-object RPCs one `sessionsCreatedBy` walk may spend.
 *
 * The walk resolves each index row in another object and drops the dead ones,
 * so its cost is in RPCs, and a Workers request is capped at 1,000 subrequests.
 * Spending the cap throws and the whole call fails; stopping early returns a
 * short list and leaves the rest for the next walk, which starts further in
 * because the rows this one dropped are gone. Well under the platform cap, so
 * the budget is reached long before anything is at risk of being refused.
 */
export const SWEEP_RPC_BUDGET = 300;

/**
 * How many members one room holds, on every plan that can start a swarm (#18).
 *
 * A ceiling, not a plan fact. A room is one value in SQLite-backed Durable Object
 * storage, members and briefs included (events and surface rows are separate,
 * #25), and a value holds 2 MB. A brief at the schema's maximum (src/tools/kit.ts:
 * goal 500, state 2,000, twenty constraints and twenty open questions of 300) is
 * 14,710 characters; 100 of them are 1.47 MB, under the limit with room for the
 * manifest and the codes. 250 would be 3.7 MB. Two-byte text at the maximum in
 * every brief of a full room is the remaining gap, and the transaction turns it
 * into one failed join rather than a broken room. Reaching this is the trigger
 * for moving members to rows of their own, which is what lifts it.
 */
export const ROOM_MEMBER_CEILING = 100;

/**
 * How many members this room holds. A `pair` room holds two because the preset
 * says so; a `swarm` room holds as many as its creator invites, up to the
 * ceiling. Derived from the manifest and never stored, for the rule written on
 * the Session type: two fields for one fact could disagree.
 */
export const capacityOf = (manifest: RoomManifest): number =>
  manifest.mode === "pair" ? 2 : ROOM_MEMBER_CEILING;

export const JOIN_CODE_TTL = JOIN_CODE_TTL_MS;
export const CONNECT_TOKEN_TTL = CONNECT_TOKEN_TTL_MS;
