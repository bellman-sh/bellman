import type { AgentInfo, Brief, Member, RoomCreator, Session, SessionEvent } from "./types.js";
import type { StoredSession } from "./storage/stored-session.js";
import { mustReport } from "./roles.js";
import { partiesOf } from "./audit.js";
import type { DepartedMembers } from "./storage/store.js";

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
 * Every hosted seat's label (M13). The role is the creator's to name, so a label built
 * from it, `security@bellman` say, would lend Bellman's name to the creator's words.
 * Here with the seat's other facts, and not in host.ts, because member-names.ts names
 * the seat by it and host.ts imports that module.
 */
export const HOST_LABEL = "host@bellman";

/**
 * A member still in the room who is a person and not the hosted seat (hosted seat
 * spec, D5). The host does not vouch for a room, so whether a room is empty, when it
 * is abandoned and whether a hosted tick has anyone to ask all count these and only
 * these: one predicate, so the three cannot disagree about who is there.
 */
export const isActivePerson = (m: Member): boolean => isActiveMember(m) && !isHostMember(m);

/**
 * Whether the room holds a member outside any org (ADR 0031): the hosted seat has no org and is not one, since it
 * is Bellman's and no counterparty. The creator is on the roster, so `orgId` is read for a room with none yet.
 */
export const rosterHasOrgless = (s: Pick<StoredSession, "orgId" | "members">): boolean =>
  s.orgId === null || s.members.some((m) => m.orgId === null && !isHostMember(m));

/** A member as it comes to be seated: a brief to keep beside the room, or the agent of one kept there already. */
export type Seating = Omit<Member, "agent" | "seq" | "publicNumber"> & { agent?: AgentInfo; brief?: Brief };

/**
 * Members as a room seats them, in the order given (ADR 0018, ADR 0019). Each brief leaves
 * its member for a row of its own, and the member keeps the brief's `agent`. Each member
 * takes the next `seq`. Each label takes a public number: the one the room gave it before
 * (`known`), or the next one, and none for the hosted seat, whose label names no person.
 *
 * `counts` are the last `seq` and the last public number the room has given. What comes
 * back is the members, their briefs, the labels this numbered for the first time, and the
 * counts after. Both stores seat through here, and so does the Durable Object's move of an
 * older room's members into rows, so the three cannot number a member differently.
 */
export function seatInOrder(
  arriving: readonly Seating[],
  counts: { memberSeq: number; labelSeq: number },
  known: (label: string) => number | undefined = () => undefined,
): { members: Member[]; briefs: Record<string, Brief>; numbered: Map<string, number>; memberSeq: number; labelSeq: number } {
  let { memberSeq, labelSeq } = counts;
  const briefs: Record<string, Brief> = {};
  const numbered = new Map<string, number>();
  const members = arriving.map(({ brief, ...m }): Member => {
    if (brief) briefs[m.memberId] = brief;
    let publicNumber: number | null = null;
    if (!isHostMember(m)) {
      publicNumber = numbered.get(m.label) ?? known(m.label) ?? null;
      if (publicNumber === null) numbered.set(m.label, (publicNumber = ++labelSeq));
    }
    return { ...m, agent: brief ? brief.agent : m.agent!, seq: ++memberSeq, publicNumber };
  });
  return { members, briefs, numbered, memberSeq, labelSeq };
}

/**
 * The room's first seat as its record keeps it (ADR 0019). A room is created with its creator
 * seated, so a creation with nobody to seat is refused here, before either store writes.
 */
export function creatorOf(m: Member | undefined): RoomCreator {
  if (!m) throw new Error("a room is created with its creator seated, and this one names no member");
  return { memberId: m.memberId, userId: m.userId, label: m.label, joinedAt: m.joinedAt };
}

/**
 * What `departedMembers` answers, from every member a room has seated (ADR 0019, D7): those
 * who have left, after `leftAfter` when it is given, and of those the `limit` who left most
 * recently, a later joiner first where two left at once. Handed back in join order. Both
 * stores answer through here, so they cannot choose different members to show.
 */
export function departures(
  members: readonly Member[],
  { limit, leftAfter }: { limit?: number; leftAfter?: number } = {},
): DepartedMembers {
  const gone = members.filter((m) => m.leftAt !== null && (leftAfter === undefined || m.leftAt > leftAfter));
  const shown = limit === undefined
    ? gone
    : [...gone].sort((a, b) => b.leftAt! - a.leftAt! || b.seq - a.seq).slice(0, Math.max(0, limit));
  return { members: [...shown].sort((a, b) => a.seq - b.seq), omitted: gone.length - shown.length };
}

/**
 * Everyone a room ever seated, the hosted seat left out, as an audit row's parties (audit trail
 * spec, D2): what a purge's and a delete's rows say the room held. The roster keeps a member who
 * left, as the record's `orgs` does, because their org sat in the room. So `members` is every
 * member seated, not a read room's: MemoryStore's record holds them all, and the Durable Objects
 * store reads them from their rows, since its record holds only those in the room (ADR 0019).
 */
export const rosterParties = (s: Pick<StoredSession, "members">): (string | null)[] =>
  partiesOf(s.members.filter((m) => !isHostMember(m)).map((m) => m.orgId));

/**
 * Whether the room's hosted seat is still in it (C1). Evicting the host is the
 * creator's one control over it, so once it has left nothing wakes it and the room
 * refuses its writes: the tick (`tickPlan`), both stores' reply wakes and
 * `decideHostCharge` all ask this.
 */
export const hostSeated = (s: Pick<Session, "members">): boolean =>
  s.members.some((m) => isHostMember(m) && isActiveMember(m));

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
