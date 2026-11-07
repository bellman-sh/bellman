/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from "cloudflare:workers";
import { isBanId, newBanId, oldestFirst, type Ban, type CreatorBan } from "../bans.js";
import { codeIsLive, isPublic, newestTaskFirst, taskWithEvent } from "../store.js";
import type { BlobCharge, HostAppend, PurgeSchedule, SetJoinCode } from "../store.js";
import type { ArrivingMember, AuditEntry, Brief, Member, NewSession, PublicView, SessionEvent, SurfaceRow, OutsideCaller, OutsideTask, ApprovedBy, ConfigName, ConfigRow, FsRow, HomeSettings, LookupRow, LookupSource } from "../types.js";
import { DEFAULT_HOME_SETTINGS, LOOKUP_KEEP, LOOKUP_KEEP_MS } from "../types.js";
import { CONFIG_HISTORY } from "../config.js";
import { configEvent, decideConfigWrite, decideFsWrite, fsEntryOf, fsPrint, hiddenMemory, homeKey, newestKey, pageFs, pathMatches, resolveFsPath, underPrefix, type HomeAppend, type HomeKeyRecord } from "../store.js";
import { FS_FIND_MAX, FS_LIST_PAGE, newMemoryId } from "../fs.js";
import { namespaceOf } from "../fs-path.js";
import type { AppendExtras, ApprovalWrite, ConfigWrite, ConfigWriteResult, FsAppend, FsEntry, FsPage, FsWrite, DepartedMembers, EventBody, EventWrite, HostInstructionsSet, MemberPatch, AccountBanRequest, ProposalApproval, RemovalOutcome, RemovalRequest, SeatOutcome, SurfaceAppend, SurfaceAuthor, SurfaceBatchAppend, SurfaceFacts, DecisionClose, DecisionOpen, VoteWrite, RoomSummary } from "../store.js";
import { electorateOf, voteRefusal, withoutBook } from "../store.js";
import { applyVote, capacityOfVote, closingEvent, decideClose, decideOpenQuota, decideSupersede, decisionAudit, decisionsOf, decisionOwning, dueToExpire, earliestDeadline, isSecret, noteDecisions, type BallotBook, type Choice, type DecisionOpened, type SecretVote, openedPayload, decisionPageOf, removalEvents, type ClosedState, type DecisionPage, type DecisionPageAsk, type DecisionDraft, type DecisionView, type DecisionVote, type FailReason, type VoteInput } from "../decision.js";
import { isTopicRoom } from "../manifest.js";
import { asRowWriter, batchEvent, carriedEvent, placeSurfaceBatch, placedEvent, placesAmongRows, surfaceBatchPrint, surfaceFactsOf, surfacePrint, windowUnderCut } from "../store.js";
import { ABANDONED_AFTER_MS, HOST_MEMBER_ID, abandonedAt, capacityOf, connectedAmong, creatorOf, creditReport, decideBlobCharge, decideHostCharge, departures, handOff, hostSeated, hostSentEntries, isAbandoned, isActiveMember, isActivePerson, isRemovedMember, isReplyToHost, markRemoved, noteAppend, rosterParties, roomSummaryOf, seatInOrder, seatVictims, stampSeen } from "../store.js";
import { BRIEF_PREFIX, KEYS_PER_CALL, MEMBER_PREFIX, briefKey, getRows, labelKey, legacyRows, loadPresent, memberKey, memberRows, putRows, seatRows, seated, userOfKey, userPrefix, USER_PREFIX, type RowReader } from "../member-rows.js";
import { hostWakeIntent, type HostWake } from "../host.js";
import { fingerprint, idempotencyKey, type IdempotencyRecord } from "../idempotency.js";
import { hydrateStoredSession, type StoredSession } from "../stored-session.js";
import { publicEvent, readableEvent, readableEvents } from "../public-event.js";
import { PING, PONG } from "../keepalive.js";
import { SYSTEM_ACTOR, auditRows, type AuditActor } from "../audit.js";
import { OUTBOX_HANDLER, OUTBOX_PREFIX, OutboxDriver, type OutboxIntent, type OutboxRow } from "../outbox.js";
import { R2BlobStore } from "./blobs-r2.js";
import { PURGE_HANDLER, SWEEP_HANDLER, creditedBlobBytes, orgsOnRoster, purgeDueAt, roomDeletedEntry, roomPurgedEntry, sweepDueAt, unnamedObjects } from "../retention.js";
import { clearSilence, nextTickAt, snapshotOf, tickBroughtForward, tickPlan } from "../heartbeat.js";
import { HOUSEKEEP_HANDLER, bringsForward, clearedKeys, dueFindings, nextHousekeepAt } from "../housekeeping.js";
import { UPGRADE_REQUIRED, wantsWebSocket } from "../upgrade.js";
import { applySurfaceWrite, needsPlacement, withPlacement, type SurfaceWrite } from "../surface.js";
import { FRAME_WRITE_PATH, isFrameWrite, placeSurfaceWrite, type Placed, type Window, type WindowPage } from "../frames.js";
import { decideApproval } from "../proposal.js";
import { decideAnswer, decideAsk, decideCancel, endings, handedOverNotice, nextLapse, type AnswerRequest, type AnswerResult, type AskOutcome, type AskRequest, type CancelRequest, type CancelResult, type EndReason } from "../outside.js";
import { admitAt, isStrangerKey, type SendAdmission } from "../send-limit.js";
import type { BellmanEnv } from "./store-do.js";

const CURSOR_PAD = 12;
const eventKey = (cursor: number) => `e:${String(cursor).padStart(CURSOR_PAD, "0")}`;
/**
 * A secret ballot's row for one account (secret ballot spec): its current choice, its vote count and the
 * idempotency keys its votes used. The only place a secret choice is kept; every close deletes the decision's rows.
 */
const ballotKey = (decision: number, account: string) => `bv:${decision}:${account}`;
const ballotPrefix = (decision: number) => `bv:${decision}:`;
type BallotRow = { choice: Choice; n: number; iks: string[] };
/** Ballot rows as a fold reads them: decision → account → choice. */
const bookOf = (rows: ReadonlyMap<number, ReadonlyMap<string, BallotRow>>): BallotBook =>
  new Map([...rows].map(([d, r]) => [d, new Map([...r].map(([a, row]) => [a, row.choice]))]));
/** One row per surface item (#129). The key is a slug, so the prefix is injective. */
const surfaceKey = (key: string) => `sf:${key}`;
const SURFACE_PREFIX = "sf:";
/**
 * The decisions index (#411). `dx:<opening cursor>` is one row per decision, which a page lists newest first, and
 * `dv:<opening cursor>:<cursor>` a copy of each of its own events, the opening included, which is all a page reads of
 * it: never the log between them, however long a decision stays unclosed. No append writes them. A page read first
 * indexes the log past `DECISION_INDEX_AT`, the last cursor indexed, `DECISION_INDEX_BATCH` events a transaction, so
 * the rows follow whatever any release appended and a long log's first read resumes where a cut-short one stopped.
 * An event row is never rewritten after its append; a path that comes to rewrite one rewrites its copy too.
 */
const DECISION_INDEX_PREFIX = "dx:";
const pad = (cursor: number) => String(cursor).padStart(CURSOR_PAD, "0");
const decisionIndexKey = (cursor: number) => `${DECISION_INDEX_PREFIX}${pad(cursor)}`;
const decisionEventPrefix = (decision: number) => `dv:${pad(decision)}:`;
const DECISION_INDEX_AT = "dx-at";
export const DECISION_INDEX_BATCH = 1_000;
function decisionIndexRows(events: readonly SessionEvent[]): Record<string, unknown> {
  const rows: Record<string, unknown> = {};
  for (const e of events) {
    const decision = decisionOwning(e);
    if (decision === null) continue;
    if (e.cursor === decision) rows[decisionIndexKey(decision)] = true;
    rows[`${decisionEventPrefix(decision)}${pad(e.cursor)}`] = e;
  }
  return rows;
}
/** One row per outside task, `ot:<taskId>`, and one per outside caller, `oc:<user>` (A2A). The user segment is percent-encoded, for `userPrefix`'s reason. */
const OUTSIDE_TASK_PREFIX = "ot:";
const OUTSIDE_CALLER_PREFIX = "oc:";
/** The last visitor number a room handed an outside caller. One row, read and bumped in the ask's own transaction. */
const OUTSIDE_VISITORS_KEY = "ov";
/**
 * One row per ban, `bn:<banId>` (abuse protections spec, section 1), and a row from the person to
 * their ban's id, `bu:<user>`, so a seating asks one `get` and not a listing. The user segment is
 * percent-encoded, for the reason `userPrefix` gives.
 */
const BAN_PREFIX = "bn:";
const banKey = (banId: string) => `${BAN_PREFIX}${banId}`;
const banUserKey = (userId: string) => `bu:${encodeURIComponent(userId)}`;
/**
 * A stranger's recent sends (abuse protections spec D5, amended): one row per count key, `sn:<key>`, holding the
 * times still inside the minute, so the count outlives an idle object's eviction. A member's are not rows (see
 * `SessionDO.#sends`). The key is `sendKeyFor`'s whole answer and nothing lists by this prefix, so the mapping
 * is injective as it stands.
 */
const sendCountKey = (key: string) => `sn:${key}`;
/**
 * `rows` with the `session` draft it may carry written as the record and the member rows that
 * draft owes (ADR 0019, D4): every write of the session goes through `memberRows`, and an append
 * builds its draft in pieces (`extraRows`, the books in `#writeEvent`) before it is written.
 */
function asRows(read: StoredSession, rows: Record<string, unknown>): Record<string, unknown> {
  const { session, ...rest } = rows;
  return session === undefined ? rest : { ...rest, ...memberRows(read, session as StoredSession) };
}
/**
 * Governed config (#414): `cfg:<name>` is the current revision, `cfgh:<name>:<rev>` the kept history, the revision
 * zero-padded so a reverse list reads newest first. Purged with the room's storage.
 */
const configKey = (name: ConfigName): string => `cfg:${name}`;
const configHistoryPrefix = (name: ConfigName): string => `cfgh:${name}:`;
const configHistoryKey = (name: ConfigName, rev: number): string => `${configHistoryPrefix(name)}${String(rev).padStart(10, "0")}`;
/**
 * Room files (ADR 0046): `fs:<path>` the current revision (a tombstone included), `fsh:<path>:<rev>` each kept one,
 * the revision zero-padded. A path may hold colons, so a history list keeps only keys whose rest after the prefix is
 * exactly a padded revision: `fsh:/a:` also lists `/a:b`'s rows. `fsm:<path>` is `fs:`'s row without content, for
 * listings. `mi:<userId>` is an account's memory id and
 * `mio:<memoryId>` its owner. All purged with the room's storage.
 */
const fsKey = (path: string): string => `fs:${path}`;
/** `fsm:<path>`: the current row without its content, which listings and finds read so they never load file bodies. */
const fsIndexKey = (path: string): string => `fsm:${path}`;
const fsHistoryPrefix = (path: string): string => `fsh:${path}:`;
const fsHistoryKey = (path: string, rev: number): string => `${fsHistoryPrefix(path)}${String(rev).padStart(10, "0")}`;
const REV_PAD = /^\d{10}$/;
const memoryIdKey = (userId: string): string => `mi:${userId}`;
const memoryOwnerKey = (memoryId: string): string => `mio:${memoryId}`;
/** `ns:<userId>`: the account shares its room notes here (ADR 0047 decision 7). Absent is off. Purged with the room. */
const NOTES_SHARING_PREFIX = "ns:";
const notesSharingKey = (userId: string): string => `${NOTES_SHARING_PREFIX}${userId}`;
/**
 * `lk:<at>:<nonce>`: one home memory read (ADR 0047 decision 13), `at` zero-padded so a reverse list reads newest
 * first, the nonce so two reads in one millisecond do not collide. Purged with the room.
 */
const LOOKUP_PREFIX = "lk:";
const lookupKey = (at: number, nonce = crypto.randomUUID().slice(0, 8)): string => `${LOOKUP_PREFIX}${String(at).padStart(14, "0")}:${nonce}`;
/**
 * The alarm handler that asks the room's members where they are (#111). A name
 * only: its due time is derived, never stored under `due:`. See derivedDue().
 */
const HEARTBEAT_HANDLER = "heartbeat";
/**
 * The alarm handler that closes a room nobody has been in for 90 days (#18). A
 * name only, derived like the heartbeat's: never stored under `due:`, so a
 * rollback strands nothing. See derivedDue().
 */
const ABANDONED_HANDLER = "abandoned";
/**
 * The alarm handler that hands an outside question (A2A) the seat stayed silent on to the members. A name only,
 * derived like heartbeat's from the record's `seatWaits`: never stored under `due:`. See derivedDue().
 */
const SEAT_HANDLER = "seat";
/**
 * An outside task's lifetime (A2A, `OUTSIDE_TASK_TTL_MS`): derived from the record's `outsideExpiryAt`, never stored
 * under `due:`, for the reason SEAT_HANDLER gives. `#expireOutsideIfDue` consumes it, and always moves it on or clears it.
 */
const EXPIRY_HANDLER = "expiry";
/**
 * A decision's deadline (secret ballot spec, Change 1): derived from the record's `openDecisions`, one millisecond
 * past the soonest deadline, since a decision is overdue only once the clock is past it. Never stored under `due:`,
 * for the reason SEAT_HANDLER gives. `#expireDecisionsIfDue` consumes it: it closes every overdue decision, which
 * takes each out of the book, so the time moves on.
 */
const DECISION_HANDLER = "decision";

/** A long poll: woken with the events past `after`, at most `limit` of them when the poll gave one. */
type Waiter = { after: number; resolve: (events: SessionEvent[]) => void; limit?: number };

/**
 * What a hibernating socket remembers. The runtime rejects more than 16 KB;
 * fetch says how close this can get.
 *
 * Three things read it. wake() reads `cursor` and carries the rest along
 * unchanged, and every member of a room receives every event (spec D1a), so
 * delivery does not depend on whose socket it is. Presence reads `memberIds`
 * (#146): they find the identity that opened the socket, and every undeparted
 * member of that identity counts as connected while the socket is open, which
 * `connectedAmong` in store.ts explains (the ids are a snapshot, so they are a
 * starting point and not the whole answer). `#closeCutSockets` is what reads it
 * to find a socket by member: on an eviction it finds the sockets naming only
 * members a creator removed and closes them (#113). A member who merely left
 * keeps its socket, so "has left" is not the predicate — "was removed" is.
 *
 * Whatever reads it can trust it, because of where it comes from: membersOf
 * answered it, and fetch received it in a request the Worker built (see the
 * /ws route in worker.ts), never in a header the client sent, and cut it down
 * by the roster as it stood when the socket was accepted (#113). A forged
 * x-bellman-members reaches nothing. That matters now that presence reads it: a
 * list naming a member would keep that member's whole identity out of every
 * reclaim for as long as the socket stayed open. tests/worker-ws.test.ts pins
 * that the Worker never forwards a caller's request, and stays for as long as
 * this field is read.
 */
type SocketAttachment = { memberIds: string[]; cursor: number };

/**
 * WebSocket.readyState for a socket on its way out (CLOSING) or gone (CLOSED).
 * Literals, and not WebSocket.CLOSING and WebSocket.CLOSED, so this does not
 * depend on which WebSocket global the program has: the Workers runtime's, or
 * Node's under the tests. Both use 2 and 3.
 */
const WS_CLOSING = 2;
const WS_CLOSED = 3;

/**
 * The most events a socket is replayed when it connects (#208). A client further behind is
 * refused with 410, which today's bridges take as any refusal they do not know: they poll
 * `bellman_sync`, which pages, and the socket they keep retrying is accepted once the gap is
 * under this. A socket never carries the whole log.
 */
export const REPLAY_LIMIT = 1_000;

/**
 * Whether a socket the runtime lists is one a peer can still be reached on.
 * Exactly CLOSING and CLOSED are not, so a reading nobody expected counts as
 * open: wake() would rather send to it than go silent, and presence would
 * rather hold a seat than free one. One definition for both, so "a live socket"
 * cannot mean one thing to delivery and another to presence. The runtime goes
 * on listing a socket this object has closed until its peer acknowledges
 * (still listed 23 s on, for a peer that never did; see wake()), which is why
 * a listing is not enough.
 */
const isOpen = (ws: WebSocket): boolean =>
  ws.readyState !== WS_CLOSING && ws.readyState !== WS_CLOSED;

/**
 * What a join-code change owes the registry's index, as outbox intents.
 *
 * Nothing downstream recognises the id, and nothing needs to: a put and a delete of
 * one key are each idempotent, so a row handed over twice leaves the index as one
 * delivery would. That is why these have no dedupe marker, where an audit entry,
 * which appends, does.
 */
const putCodeIntent = (code: string, sessionId: string): OutboxIntent => ({
  id: crypto.randomUUID(), kind: "join_code_put", payload: { code, sessionId },
});
const dropCodeIntent = (code: string): OutboxIntent => ({
  id: crypto.randomUUID(), kind: "join_code_drop", payload: { code },
});

/**
 * The creator-wide ban an eviction owes the registry (abuse protections spec, section 1), as an outbox
 * intent. The ban is made by the transaction that queues it, so a redelivery carries the first one's id.
 * The registry writes it only when the creator holds no ban on the account yet, so a row handed over
 * twice leaves one ban, as one delivery would.
 */
const creatorBanIntent = (creatorId: string, ban: CreatorBan): OutboxIntent => ({
  id: crypto.randomUUID(), kind: "creator_ban", payload: { creatorId, ban },
});

/**
 * A hosted room gives its creator's slot back as it closes (I7), however it closes: queued
 * in the close's own transaction and delivered to the registry by the outbox. None for a
 * room with no host, or one already closed.
 */
const hostedReleaseIntents = (s: StoredSession): OutboxIntent[] =>
  s.manifest.host !== null && !s.closed
    ? [{ id: crypto.randomUUID(), kind: "hosted_release", payload: { userId: s.createdBy, sessionId: s.id } }]
    : [];

/**
 * An audit entry as an outbox intent, for an object that earns the entry in a
 * transaction and must not then write it from outside one. Shared by SessionDO
 * and RegistryDO so the two cannot disagree about the row's shape.
 */
export const auditIntent = (entry: AuditEntry): OutboxIntent => ({
  id: crypto.randomUUID(), kind: "audit", payload: entry,
});

/**
 * The extra storage rows an append owes: the rows to put, and the keys to delete.
 *
 * One function for every extra, and one `session` row: written as a builder per
 * rule each returning `{ session: ... }`, the second would overwrite the first's
 * member array and silently drop its write. The action-request stamp and the
 * surface cursor ride in that same row.
 *
 * Empty when the append owes nothing — it asked for no extras, the stamp already
 * sits forward of this event, the cut is already recorded, the member is not on
 * the roster, or the surface write is a no-op under `applySurfaceWrite`. The
 * caller folds the rows into the put it was already making:
 * `#writeEvent`'s whole argument is that an event and the rows that belong with
 * it commit in ONE write, and a member write committed separately is the split
 * this exists to remove.
 *
 * A free function and not a method on the class: a Durable Object answers RPC for
 * every method on its class, so a writing helper reachable from outside would let
 * a plain stub forge one of these into any room. The rules it applies
 * (`creditReport`, `markRemoved`, `applySurfaceWrite`) are shared with
 * MemoryStore and belong to neither store.
 *
 * The surface row (#129) joins the member rules here. It needs the row it
 * replaces, which is a storage read, so this is async and takes the
 * transaction: read and write stay one unit, as `stored(txn)` and
 * `nextCursor(txn)` are. A removal is a `delete`, which a put map cannot
 * carry, so the result names both the rows to put and the keys to delete.
 *
 * A replay is handed these extras without `surface`; `appendEventOnce` says why.
 *
 * The `session` it returns is a draft, the session as the append leaves it, and not a row: the
 * caller writes it through `asRows`, which puts the record and the rows of the members it
 * changed (ADR 0019), so a credit or a cut writes one member's row and not the room's.
 */
async function extraRows(
  txn: DurableObjectTransaction,
  s: StoredSession,
  event: SessionEvent,
  extras: AppendExtras,
): Promise<{ puts: Record<string, unknown>; deletes: string[] }> {
  let members = s.members;
  if (extras.creditReport) {
    members = creditReport(members, event.fromMemberId, event.at) ?? members;
  }
  if (extras.markRemoved !== undefined) {
    members = markRemoved(members, extras.markRemoved, event.cursor, event.at) ?? members;
  }
  // Monotonic, for the reason MemoryStore's copy gives.
  const stamp = extras.stampActionRequest
    ? Math.max(s.lastActionRequestAt ?? 0, event.at)
    : s.lastActionRequestAt;

  const puts: Record<string, unknown> = {};
  const deletes: string[] = [];
  if (extras.outsideTask !== undefined) {
    const task = extras.outsideTask;
    // Thrown inside the transaction, so the event, its cursor and every other row of this append roll back with it.
    if (task.sessionId !== s.id) throw new Error(`Outside task ${task.id} belongs to ${task.sessionId}, not ${s.id}`);
    puts[`${OUTSIDE_TASK_PREFIX}${task.id}`] = taskWithEvent(task, event);
  }
  if (extras.outsideCaller !== undefined) {
    puts[`${OUTSIDE_CALLER_PREFIX}${encodeURIComponent(extras.outsideCaller.userId)}`] = extras.outsideCaller;
  }
  let surfaceCursor = s.surfaceCursor ?? 0;
  if (extras.surface !== undefined) {
    const key = surfaceKey(extras.surface.key);
    const verdict = applySurfaceWrite(await txn.get<SurfaceRow>(key), event, extras.surface, extras.approvedBy);
    if (verdict === "remove") deletes.push(key);
    else if (verdict !== null) puts[key] = verdict;
    if (verdict !== null) surfaceCursor = Math.max(surfaceCursor, event.cursor);
  }

  const changed =
    members !== s.members || stamp !== s.lastActionRequestAt || surfaceCursor !== (s.surfaceCursor ?? 0);
  if (changed) {
    puts.session = { ...s, members, lastActionRequestAt: stamp, surfaceCursor };
  }
  return { puts, deletes };
}

/**
 * The append a surface write owes before its event is built (surface placement spec D3): a write that arrives
 * without a placement is placed from the room's rows, and the event carries the placement the row will, so the
 * log and the row agree. Everything else comes back untouched, and reads nothing.
 *
 * ponytail: one list of the room's `sf:` rows per write that needs a slot (a card written without a
 * placement), in the append's own transaction so two such writes cannot take one slot. A write with a
 * placement, a removal, a connector and a shape read nothing here; the dash's drag writes are all of those.
 * A room is held to 1,000 items by `resolveSurfaceWrite`, so the list stays bounded at 1,000 rows; the upgrade
 * is a row of the taken cells beside the surface cursor, if a room ever outgrows that. `appendSurface` follows
 * the same rule through `placesAmongRows`.
 *
 * An idempotent replay never gets here: `appendEventOnce` returns the original event before it, and takes
 * its fingerprint from the draft as the caller sent it, so a retry reads as a retry however the room has
 * filled since.
 */
async function placedAppend(
  txn: DurableObjectTransaction,
  e: Omit<SessionEvent, "cursor" | "at">,
  extras: AppendExtras,
): Promise<{ e: Omit<SessionEvent, "cursor" | "at">; extras: AppendExtras }> {
  if (extras.surface === undefined || !needsPlacement(extras.surface)) return { e, extras };
  const rows = [...(await txn.list<SurfaceRow>({ prefix: SURFACE_PREFIX })).values()];
  const surface = withPlacement(rows, extras.surface);
  return surface === extras.surface ? { e, extras } : { e: { ...e, payload: surface.item }, extras: { ...extras, surface } };
}

/**
 * The room's surface rows by key, listed in the caller's transaction, and the write placed among them: an empty map
 * and the write as it came for a write `placeSurfaceWrite` does not place among rows (`placesAmongRows`), so a
 * placed card, a removal and a connector list nothing.
 */
async function placedInRows(
  txn: DurableObjectTransaction,
  write: SurfaceWrite,
): Promise<{ rows: Map<string, SurfaceRow>; placed: Placed }> {
  if (!placesAmongRows(write)) return { rows: new Map(), placed: { ok: true, write, carried: [] } };
  const rows = new Map([...(await txn.list<SurfaceRow>({ prefix: SURFACE_PREFIX })).values()].map((r) => [r.key, r]));
  return { rows, placed: placeSurfaceWrite([...rows.values()], write) };
}

/**
 * What a placed surface write owes (surface frames spec, D2), for the caller's one put: its event at `cursor`,
 * each carried card's event at the cursors after it, authored by the mover, and their rows. The books (#66) are
 * folded over `before` (the events the caller numbered ahead of this one) and then these, in cursor order, and
 * `extraRows` runs per event in cursor order, threading the session each returns. A carried row keeps its writer
 * and approver (lead ruling L2), so its rule is handed the event as that writer and the row's own approver.
 *
 * A free function, for `extraRows`'s reason: a writing helper on the class would answer RPC.
 *
 * ponytail: one `txn.get` per carried row inside `extraRows`, beside the list the placement already read; a locked
 * move of the item cap's 1,000 cards reads each twice in one transaction. The upgrade is handing `extraRows` the row.
 */
async function placedSurfaceRows(
  txn: DurableObjectTransaction,
  s: StoredSession,
  before: readonly SessionEvent[],
  e: EventBody,
  placed: Extract<Placed, { ok: true }>,
  approvedBy: ApprovedBy | undefined,
  rows: ReadonlyMap<string, SurfaceRow>,
  cursor: number,
  at: number,
): Promise<{ event: SessionEvent; carried: SessionEvent[]; events: SessionEvent[]; session: StoredSession; puts: Record<string, unknown>; deletes: string[] }> {
  const event: SessionEvent = { ...e, cursor, at };
  const carried = placed.carried.map((write, i): SessionEvent => ({ ...carriedEvent(e, write), cursor: cursor + 1 + i, at }));
  const events = [...before, event, ...carried];
  let session = events.reduce<StoredSession>((draft, ev) => {
    const books = noteAppend(draft, ev);
    return books === draft ? draft : { ...draft, ...books };
  }, s);
  const writes: [SessionEvent, AppendExtras][] = [
    [event, { surface: placed.write, approvedBy }],
    ...placed.carried.map((write, i): [SessionEvent, AppendExtras] => {
      const row = rows.get(write.key)!;
      return [asRowWriter(carried[i], row), { surface: write, approvedBy: row.approvedBy }];
    }),
  ];
  const puts: Record<string, unknown> = {};
  const deletes: string[] = [];
  for (const [ev, extras] of writes) {
    const owed = await extraRows(txn, session, ev, extras);
    const { session: next, ...rest } = owed.puts;
    Object.assign(puts, rest);
    deletes.push(...owed.deletes);
    if (next !== undefined) session = next as StoredSession;
  }
  return { event, carried, events, session, puts, deletes };
}

/**
 * Whether a room reads as closed, deciding it without writing: closed outright, or
 * abandoned with the alarm still to come. A row that is gone reads closed, which
 * is the answer an unknown room has always had.
 *
 * `connected` is the members the object's sockets vouch for (`#connected`), because a
 * socket vouching for an active member is the one thing that keeps a room past
 * its window open. The caller reads it, since a socket can name a member who has
 * left, and that member's row is a storage read. The rule is `isAbandoned`'s, shared
 * with `#closeIfAbandoned` and both stores' sweeps, so a room reads closed here
 * exactly when the alarm would close it.
 *
 * Every read that refuses a closed room goes through here, so the rule and the
 * refusals cannot drift apart. `membersOf` authorizes a watch with it and `fetch`
 * rechecks it before accepting the socket: one rule asked twice, which is what #133
 * was missing. With no recheck, a close landing between the two calls left a socket
 * on a closed room and nothing to close it.
 */
const readsClosed = (s: StoredSession | undefined, now: number, connected: ReadonlySet<string>): boolean =>
  !s || s.closed || isAbandoned(s, now, connected);

// ---------------------------------------------------------------------------
// SessionDO — one per Bellman session
// ---------------------------------------------------------------------------

export class SessionDO extends DurableObject<BellmanEnv> {
  /** Live long-polls. In-memory is correct: one instance serves this session. */
  private waiters: Waiter[] = [];

  /**
   * A member's recent sends for the send limit (abuse protections spec D5): count key (`sendKeyFor`, the seat's)
   * to the times of the sends still inside the minute. In the instance and never in storage, so an object that
   * sleeps forgets them, which keeps a write off every send of the busiest senders and costs a member at most a
   * second 30 in a minute across an eviction. A stranger's are rows instead (`sendCountKey`), where the same
   * trade would let a script send 6, pause, and send 6 more. One instance serves the room, as it does for
   * `waiters`, so this is the room's one count of members. An entry stays until the instance goes and holds no
   * more times than the limit allows.
   */
  #sends = new Map<string, number[]>();

  /**
   * This object's one alarm, shared by name: the driver works out which handlers
   * are due and points the alarm at the soonest. Six handlers use it.
   *
   * "outbox" delivers what a join-code change owes the registry. A code lives in two
   * objects, here and in the registry's index, so the two writes cannot share a
   * transaction. The index write is queued in the session's own transaction instead,
   * and delivered after it: inline when the call returns, by the alarm if the isolate
   * went away first. Without that, an interruption between the two left a session
   * holding a code that nothing could resolve, and no scan could find it, because a
   * Durable Object namespace cannot be enumerated.
   *
   * "abandoned" closes a room nobody has been in for 90 days (#18). It is DERIVED
   * from the members' lastSeenAt rather than stored as a `due:` row, because sessions
   * written before named alarms have no row and an alarm re-armed from stored rows
   * alone would leave every one of them unswept. See derivedDue().
   *
   * "heartbeat" asks the room's members where they are, when the room declared a
   * cadence and one of them owes an answer (#111). Derived like "abandoned", and for a
   * firmer reason: a stored row that an older build never consumes is the spin
   * alarm() warns about. See derivedDue() and #tickIfDue().
   *
   * "housekeep" raises a proposal when a member has gone quiet, an action request is
   * unanswered or the room is idle past the thresholds its manifest declared, once per
   * window, and forgets a finding once its condition ends (#66). Derived like the
   * heartbeat's, from the record: the bookkeeping it reads is kept at every append by
   * both stores. See derivedDue() and #housekeepIfDue().
   *
   * "purge" deletes a closed room once the window its plan promised has run out, or
   * when a delete asked for it sooner (#65). Derived like the two above, from the
   * record (`purgeDueAt`), so a room closed before it existed is not given a clock it
   * was never promised. See derivedDue() and #purgeIfDue().
   *
   * "sweep" deletes the objects no surface item names, once, the moment the room
   * closes, and credits the room their bytes (#65, D3). Derived from the record too
   * (`sweepDueAt`): due at `closedAt` until `blobsSwept` says it ran, so it fires one
   * time and then owes nothing, and a row closed before the close was dated owes
   * nothing at all. See derivedDue() and #sweepIfDue().
   */
  private driver = new OutboxDriver(
    this.ctx.storage,
    (row) => this.#deliver(row),
    () => this.#derivedDue()
  );

  /**
   * Registers the ping auto-response, once per construction and not in fetch
   * beside the accept.
   *
   * The runtime answers a text frame "ping" with "pong" itself: no JavaScript
   * runs and this object is not constructed. Without it a client keepalive
   * reaches this object, and a ping to an evicted one revives it (measured),
   * which undoes the saving this socket exists for. Delivery would still work,
   * so nothing on the delivery path would show it; a test pins the registration
   * for that reason, and what a revival costs is the spec's unmeasured billing
   * risk. Any frame that is not that text reaches webSocketMessage and is
   * closed, so a client's keepalive has to be exactly that.
   *
   * The text comes from src/keepalive.ts, which is the only place it is written
   * (#144). The client that sends it (src/client/room-socket.ts) and the fake server
   * the end-to-end tests run against (tests/helpers/fake-bellman.ts) import the
   * same two constants, so the three cannot drift. They each held their own copy
   * until #144, tied together only by comments, and nothing compiled or ran any
   * two of them together — so changing one side left every test green while the
   * client was closed 1003 at its first keepalive, which looks from the client
   * like a server-side drop.
   *
   * Where to register was settled against workerd 1.20260926.1 at compat date
   * 2026-09-01, with a throwaway Worker, Node's WebSocket client, and objects
   * left idle for 25 to 30 s so they were evicted. The Worker counted
   * constructor runs from outside the objects, which is how "answered by the
   * runtime" was told from "answered by us". All of it ran in local workerd
   * under `wrangler dev`; production is unmeasured. "Measured" in this comment,
   * in the socket handlers below and in wake() means that setup.
   *  - Registered here, before any socket exists, it is answered by the
   *    runtime. A control that never registered had the ping delivered to its
   *    handler, so the probe could tell the two apart.
   *  - The runtime holds the pair for the object, not per socket and not in
   *    this instance. A registration made after a socket was accepted covers
   *    that socket, and an object revived by a frame or by a request, whose
   *    constructor had not set it, still had it. So registering in fetch would
   *    work too, and setting it again on every revival here is redundant, not
   *    required.
   *  - It does not keep an idle object resident. One that registered and never
   *    held a socket was evicted like one that never registered.
   *
   * Here rather than in fetch because it is state of the object. This covers a
   * socket however it is accepted, fetch being the only accept site today, and
   * leaves fetch's read, attach, accept and send to be about the socket. The
   * cost is one small object and one call per construction, a poll-only room's
   * included. Not measured.
   */
  constructor(ctx: DurableObjectState, env: BellmanEnv) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    // Before any request or alarm reaches the room: `blockConcurrencyWhile` holds every
    // other event until the move has committed, so nothing reads an older record's members
    // from the record (ADR 0019, D5). A move that throws resets the object, and the next
    // event constructs it again and tries again.
    void this.ctx.blockConcurrencyWhile(() => this.#moveMembersToRows());
  }

  /**
   * The move of an older room's members out of its record and into rows (ADR 0019, D5), in
   * one transaction: every member to a row, numbered in join order, each label's public
   * number, each person's index row, and any brief still inline to its own (`legacyRows`).
   * A record written since holds no members and costs this one read; a room that is not
   * there, or a record the gate reads as gone, is left as it is.
   *
   * `#private`: it rewrites the room, and a Durable Object answers RPC for every method on
   * its class.
   */
  async #moveMembersToRows(): Promise<void> {
    const rows = legacyRows(await this.ctx.storage.get("session"));
    if (rows === null) return;
    await this.ctx.storage.transaction(async (txn) => {
      await putRows(txn, rows);
    });
  }

  /**
   * The one raw read of the "session" record. Everything in this class reads it
   * through here, so hydrateStoredSession's rules reach all of it: getSession
   * (and the facade's getSession and getSessionByJoinCode with it), every
   * mutator, and the abandonment alarm. A row predating Session.manifest reads as gone;
   * one predating frozenAt reads as not frozen; one predating the heartbeat reads
   * as asking for none. Nothing rewrites any of them.
   *
   * A mutator reads through its own transaction, so the check and the write it
   * guards are one unit rather than two that rely on nothing getting between them.
   * That makes explicit what the input gate gives implicitly. The gate holds other
   * calls off only while a storage operation is outstanding, so a read and then a
   * put is atomic as long as every await between them is storage, and nothing in
   * the code says so. The transaction does, and it keeps holding if a later edit
   * puts an await on anything else in between (a fetch, a timer), the one case the
   * gate does not cover. That is a net under a mistake and not a licence for one: the
   * closure holds every other call to this object until it commits
   * (docs/ARCHITECTURE.md section 9, runtime fact 2), so what goes inside it is
   * storage and nothing slower.
   * worker-tests/session-close-join-race.test.ts holds a call at exactly that point.
   *
   * Not every mutator has been converted. updateMember and the two stamps (a socket's
   * close and the abandonment check's) still read and then put. They are unconverted, not exempt: the input gate covers
   * them in production, since every await between their read and their write is
   * storage, and the transaction is the stronger form. The appends were converted
   * after the local test pool lost writes in them (see appendEventOnce).
   *
   * **Still TypeScript-`private`, and alone among this class's readers in that
   * (#126).** `events`, `nextCursor` and `derivedDue` are `#private`, because a
   * Durable Object answers RPC for every method it has and TypeScript's
   * `private` is erased at compile time. This one cannot follow them yet: three
   * race tests patch it ON THE PROTOTYPE to hold the first read of the session
   * open — `holdFirstReadOfTheSession` in removal-race, session-close-join-race
   * and heartbeat-tick-race — and a `#private` method is not on the prototype to
   * patch. They guard real atomicity bugs, so the conversion waits on moving
   * them to another seam rather than on weakening them.
   *
   * Patching `ctx.storage.get` is the obvious replacement and is not a straight
   * swap: this reads through whatever `from` it is given, so a read inside a
   * transaction goes to `txn.get` and never touches `ctx.storage.get` at all.
   *
   * The exposure is redundant either way — `getSession` returns this record over
   * RPC already — which is why #126 called the family tidying and not a
   * vulnerability.
   *
   * **The members it hands back are the ones in the room now** (ADR 0019, D3): the
   * record keeps their ids in `present` and each is a row of its own (`mb:`), read
   * through the same `from`, so a transaction's read of the room is one unit with its
   * members. A member who has left is not read here; the member reads reach one.
   * Every write of the session goes back through `memberRows`, which writes the record
   * and the rows of the members the write changed. A record that still holds its
   * members inline is refused rather than read: the constructor moves them to rows
   * before any event reaches the object, so one here means that move did not run, and
   * reading on would write the room back without the members who had left.
   */
  private async stored(from: RowReader = this.ctx.storage): Promise<StoredSession | undefined> {
    const raw = await from.get<{ present?: unknown }>("session");
    const s = hydrateStoredSession(raw);
    if (!s) return undefined;
    const present = raw!.present;
    if (!Array.isArray(present)) {
      throw new Error(`room ${s.id}: its record still holds its members, which the constructor moves to rows`);
    }
    return { ...s, members: await loadPresent(from, present as string[]) };
  }

  /**
   * These members, in the room or gone from it: the ones `s` holds, and the rest read by
   * id from their rows. An id the room never seated is left out. Read through `from`, so
   * a caller inside a transaction reads them in it.
   */
  async #membersById(s: StoredSession, ids: Iterable<string>, from: RowReader = this.ctx.storage): Promise<Member[]> {
    const present = new Map(s.members.map((m) => [m.memberId, m]));
    const wanted = [...new Set(ids)];
    const gone = wanted.filter((id) => !present.has(id));
    const rows = gone.length > 0 ? await getRows<Member>(from, gone.map(memberKey)) : new Map<string, Member>();
    return wanted.flatMap((id) => present.get(id) ?? rows.get(memberKey(id)) ?? []);
  }

  /**
   * The members of this room that a live socket vouches for (`connectedAmong`), from
   * the sockets as they are when this is called. A socket names the members its
   * identity held when it was accepted, which can include one who has since left, and
   * that member's row is what says whose socket it is, so those rows are read; every
   * other input is synchronous.
   */
  async #connected(s: StoredSession, from: RowReader = this.ctx.storage): Promise<ReadonlySet<string>> {
    const attached = this.#attachedIds();
    // The room's members and the ones the sockets name: a member named twice counts once.
    return connectedAmong([...s.members, ...await this.#membersById(s, attached, from)], attached);
  }

  /**
   * TypeScript-`private` rather than `#private`, for the reason `stored` gives
   * and a third kind of cost (#126). `tests/store-do-wiring.test.ts` overrides
   * it on the INSTANCE to make a frame fail to build and to pin D5's ordering —
   * read, then attach, accept and send, with nothing yielding in between. An
   * override cannot shadow a `#private` method, so converting this would retire
   * both.
   */
  private async events(after = 0, limit?: number): Promise<SessionEvent[]> {
    const map = await this.ctx.storage.list<SessionEvent>({
      prefix: "e:",
      start: eventKey(after + 1),
      ...(limit === undefined ? {} : { limit }),
    });
    return [...map.values()];
  }

  /**
   * The cursor the next event takes: the stored one, plus one.
   *
   * It takes the transaction, so a caller that holds none cannot call it. The read of
   * `cursor` and the write that advances it have to be one unit: two appends that read
   * the same cursor write the same `e:` key, one event overwrites the other, and the
   * cursors stay contiguous, so nothing downstream can tell (#120). Every caller reads
   * it inside the transaction that writes the event, which is the same reasoning as
   * stored() gives for the session record.
   *
   * TypeScript-`private` rather than `#private`, for the reason `stored` gives
   * and the same cost (#126): `session-append-race.test.ts` patches it on the
   * prototype to hand two appends the same cursor, which is the #120 collision
   * this docblock is about. A `#private` method is not there to patch, and that
   * test is the only thing standing between #120 and a silent recurrence.
   */
  private async nextCursor(txn: DurableObjectTransaction): Promise<number> {
    return ((await txn.get<number>("cursor")) ?? 0) + 1;
  }

  /**
   * One write, not two. Awaiting each put separately commits them separately,
   * and an interruption between the two leaves the event stored with `cursor`
   * still naming the one before it — so the next append computes the same
   * cursor and overwrites the event that is already there. A dropped message in
   * a log whose whole job is not to drop messages, and silent: the cursors stay
   * contiguous, so nothing downstream can tell.
   *
   * It writes into the transaction the cursor was read in (see nextCursor), so the
   * read and this write are one unit. `deletes` are the rows a removal owes, and
   * they commit with the event for the same reason the puts do.
   *
   * Housekeeping's books (#66) ride in the same put. `s` is the session the caller read
   * in this transaction, so the books cost no second read, and the base they merge into
   * is the `session` the caller is already putting when it puts one: a stamp, a cut or a
   * tick's clock, which a books row built from `s` alone would overwrite. Nothing is added
   * to the put when the room keeps no books, or the event moves none.
   *
   * **It answers whether the write brought housekeeping's soonest time or the next tick
   * forward** (I1, #208): the record it put against the record the caller read, by
   * `bringsForward` and `tickBroughtForward`. The two public
   * member appends re-arm the alarm after their commit when it is true, so the rule is
   * "the soonest time moved earlier" and not a list of the event kinds that can do it. The
   * hosted seat's append and the alarm's own writers ignore it: the books do nothing for the
   * seat (H3) or for a server event, and `alarm()` ends with a re-arm of its own. `removeMember`
   * runs the books in its own put and re-arms whenever a member left.
   *
   * `#private`, because it writes the event and any extra rows its caller supplies, and a
   * Durable Object answers RPC for every method on its class: TypeScript's `private` is
   * erased at compile time.
   */
  async #writeEvent(
    txn: DurableObjectTransaction,
    s: StoredSession,
    e: SessionEvent,
    extra: Record<string, unknown> = {},
    deletes: readonly string[] = [],
  ): Promise<boolean> {
    const base = (extra.session as StoredSession | undefined) ?? s;
    const books = noteAppend(base, e);
    const kept = books === base ? base : { ...base, ...books };
    // The session as this write leaves it, as the record and the member rows it owes (ADR 0019).
    await putRows(txn, {
      [eventKey(e.cursor)]: e, cursor: e.cursor, ...asRows(s, { ...extra, session: kept === s ? undefined : kept }),
    });
    // A removed surface row (#129), in the same transaction as the event that
    // removed it. After the put: a key is never both put and deleted here.
    for (const key of deletes) await txn.delete(key);
    return kept !== s && (bringsForward(s, kept, e.at) || tickBroughtForward(s, kept));
  }

  async createSession(s: NewSession): Promise<void> {
    const { events, members: arriving, ...others } = s;
    // Each member a row of its own, numbered in the order given with the creator first, and
    // each brief a row beside it (ADR 0018, ADR 0019). `creatorOf` refuses a room with nobody
    // to seat before anything is written.
    const seat = seatInOrder(arriving, { memberSeq: 0, labelSeq: 0 });
    const room: StoredSession = {
      ...others, members: seat.members, creator: creatorOf(seat.members[0]), orgs: orgsOnRoster(seat),
      memberSeq: seat.memberSeq, labelSeq: seat.labelSeq,
    };
    // Session, seed events, cursor and the registrations its join codes owe land
    // together. Separately committed, an interruption could leave a session with no
    // events, or events with a cursor of zero, or a session whose code nothing can
    // resolve — and the alarm is what sweeps it, so a session that half-exists
    // would also never be cleaned up.
    const seeded: Record<string, unknown> = { ...memberRows(undefined, room), ...seatRows(seat), cursor: 0 };
    for (const e of events) seeded[eventKey(e.cursor)] = e;
    if (events.length > 0) seeded.cursor = events[events.length - 1].cursor;
    const intents = Object.values(room.joinCodes).map((rec) => putCodeIntent(rec.code, s.id));
    await this.ctx.storage.transaction(async (txn) => {
      const rows = await this.driver.enqueue(txn, intents);
      await putRows(txn, { ...seeded, ...rows });
    });
    if (intents.length > 0) {
      // enqueue armed the alarm for the queue, inside the transaction. The
      // abandonment time is armed when that alarm fires, because alarm() ends by
      // pointing the alarm at whatever is due next. A reArm() here would point it at
      // the queue's marker instead, which is dated now, and bring the alarm in a few
      // milliseconds behind the commit to race the delivery below.
      await this.driver.deliverNow();
    } else {
      // Nothing was queued, so nothing armed an alarm, and the session still needs
      // its abandonment time. It is DERIVED from the members' lastSeenAt rather than
      // stored as a due row: sessions written before named alarms have no due row, and
      // re-arming from stored rows alone would leave every one of them with no alarm,
      // never swept.
      await this.driver.reArm();
    }
  }

  async getSession(): Promise<StoredSession | undefined> {
    const s = await this.stored();
    if (!s) return undefined;
    await this.#closeIfAbandoned(s, Date.now());
    // Re-read: closeIfAbandoned may have written closed=true and cleared the codes,
    // or stamped a socket's members.
    const read = await this.stored();
    // A room owes what #derivedDue lists: a closed one the sweep of its unnamed objects, once,
    // and the purge; an open one its abandonment time, its tick and housekeeping's time. If the
    // earliest is already due, its alarm should have run it. When one is found here the alarm
    // has been lost (a throwing alarm() is retried a few times and then left, with nothing
    // armed), so point it back. reArm() arms the earliest of what is owed, so the one question
    // covers every handler: #65 asked it for the sweep and the purge, and a tick or a
    // housekeeping time the runtime gave up on is the same loss. Re-armed and not run from
    // here: the alarm does the work, as it does for every other room, so no read pays for
    // deleting a prefix or writing a proposal. A room kept until deleted owes the sweep and
    // nothing else, which is why the sweep counts: no purge is ever due to bring a read back
    // to it. Nothing is asked of a room whose earliest due time is null or still ahead: one
    // inside its window with its sweep done, one kept and swept, one from before the window,
    // or an open one with every time ahead (review I1).
    //
    // **A read never fails for it.** Every read of an open room now runs the three derivations
    // and may arm the alarm, so a read would depend on both. A throw from either is logged the
    // way `alarm()` logs a handler's and the record is returned: the work is the alarm's, and
    // a read's job is to answer (review, Rec 2).
    if (read) {
      try {
        const owed = await this.#derivedDue(read);
        if (owed.size > 0 && Date.now() >= Math.min(...owed.values())) await this.driver.reArm();
      } catch (error) {
        console.error(`re-arm on read failed for room ${read.id}:`, error);
      }
    }
    return read;
  }

  /**
   * Which members this user owns here, and whether the room is closed.
   *
   * The authorization check for a /ws upgrade. Deliberately mirrors
   * findMember (src/rooms.ts), leftAt and all: bellman_sync serves a
   * member who has left, and two delivery paths that disagree about who may
   * watch is exactly the drift the spec names as its standing risk.
   *
   * The one place it does not mirror it, on purpose, is a member a creator
   * removed (#113). bellman_sync answers that member with its history up to the
   * removal and nothing after. A socket is the room's future and a removed
   * member has none, so the member is left out here, and an identity that owns
   * only removed handles gets an empty list, which the route answers 403. That
   * is a difference in what each path serves, not drift: both still give the
   * open feed to a member who left and to one whose seat timed out (R2), which
   * is why the filter is on `removedAtCursor` and NOT on `isActiveMember`, both
   * of those members having `leftAt` set.
   *
   * Two reasons the route asks here rather than calling getSession. This
   * returns two fields, not the whole record (live join codes and every
   * member's brief) across an RPC hop. And it does not close the room as a
   * side effect: getSession runs closeIfAbandoned, which can write, and authorizing
   * a watch must not.
   *
   * The second reason carries an obligation. The two paths must still agree
   * on "closed", or an abandoned room whose alarm has not fired yet reads
   * as open here while bellman_sync, through getSession, reads it as closed.
   * So `closed` comes from `readsClosed`, closeIfAbandoned's own rule, and is not
   * written. That predicate is where the rule lives for all of its readers.
   *
   * What this answer does NOT settle is whether the room is still open by the
   * time the socket is accepted: that is a second invocation, and `fetch` asks
   * `readsClosed` again for itself (#133). This one is what distinguishes 403
   * from 404 without telling a stranger which, and it spares an upgrade for a
   * caller who owns nothing here.
   */
  async membersOf(userId: string): Promise<{ memberIds: string[]; closed: boolean }> {
    const s = await this.stored();
    if (!s) return { memberIds: [], closed: true };
    return {
      // `isRemovedMember` and not `isActiveMember`: see above. An identity that
      // holds one removed handle and one live one keeps its socket, on the live
      // one's entitlement (D5), which falls out of this filter without a rule.
      // Every handle the person has held, read from their index rows, since one
      // who left is not on the record (ADR 0019).
      memberIds: (await this.membersOfUser(userId)).filter((m) => !isRemovedMember(m)).map((m) => m.memberId),
      closed: readsClosed(s, Date.now(), await this.#connected(s)),
    };
  }

  /**
   * The member ids the sockets open to this room carry, from their attachments.
   *
   * Synchronous, as wake() is: getWebSockets and deserializeAttachment are, so
   * seatMember can call this inside its transaction and decide against the
   * sockets as they are while that transaction holds the object. An await here
   * would put a gap between reading them and deciding.
   *
   * A socket this object is closing is skipped (`isOpen`). One with no
   * attachment, or one that does not read as a list, names nobody. fetch
   * attaches before it accepts, so every accepted socket has one. A workerd that
   * stopped persisting a pre-accept attachment would hand every socket back
   * without one: delivery would go quiet (wake fails closed, see fetch) and this
   * would answer nobody, so presence would fall back to the window alone.
   * worker-tests/presence-sockets.test.ts goes red in that case.
   *
   * `#private`, since a Durable Object answers RPC for every method on its class
   * (#126) and nothing outside needs this: connectedMembers is the answer a
   * caller can have.
   */
  #attachedIds(): string[] {
    const ids: string[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (!isOpen(ws)) continue;
      const memberIds = (ws.deserializeAttachment() as Partial<SocketAttachment> | null)?.memberIds;
      if (Array.isArray(memberIds)) ids.push(...memberIds);
    }
    return ids;
  }

  /**
   * The members of this room that a live socket vouches for, as ids (#146).
   * `BellmanStore.connectedMembers` is the contract and this is SessionDO's
   * answer to it, from the sockets it holds; `connectedAmong` says which members
   * that is.
   *
   * It answers RPC like every method on this class. What it adds to getSession
   * is which members have a socket open, which every member of the room already
   * reads as `presence`, less precisely, and only code holding the SESSION
   * binding can ask. Like membersOf it writes nothing and does not close the
   * room, because it is a question about who is connected and not a reason to
   * change the room.
   */
  async connectedMembers(): Promise<string[]> {
    const s = await this.stored();
    if (!s) return [];
    return [...await this.#connected(s)];
  }

  /**
   * Accept a watching socket. The Worker has already authenticated the caller
   * and asked membersOf who they are; this request is one the Worker BUILT,
   * so nothing on it came from the client (see the /ws route in worker.ts).
   *
   * Recheck, read, attach, accept and send happen in this one invocation, and,
   * every await in it being a storage read, the input gate holds every other
   * request to this object for its duration. That is CLAUDE.md's read-and-register
   * rule, not an exemption from it: an event appended between the read and
   * the accept would otherwise be delivered to nobody and skipped by the
   * cursor. So the order is waitForEvents' own: await the read FIRST, then
   * register with no await between.
   *
   * **The roster is read again here, and it answers two questions from one
   * read.** The Worker asked membersOf and then sent this request: two calls,
   * and anything can commit between them. #133 found the close in that gap and
   * #113 found the removal, and they are the same hazard — a state the Worker's
   * answer predates — so they share the read rather than paying two.
   *
   * `closed` first, because a closed room owes a 409 whoever is asking, and the
   * route's own pre-check answers the same 409 with the same body for a room
   * already closed when it looked (#133). A close committed in the gap would
   * otherwise be answered with an accepted socket that nothing is left to close.
   *
   * Then the cut (#113). The member list this request carries was true when it
   * was made and is not now, and a socket accepted on it would hold the open
   * feed of a member already removed — which `#closeCutSockets` cannot undo,
   * because it ran before the socket existed. So the ids of members the roster
   * has since cut are dropped, and a request left with none is refused 403, the
   * answer the route gives an identity that owns nothing here. An id the roster
   * does not hold is kept: it is neither entitled nor condemned, as
   * `#closeCutSockets` reads it.
   *
   * Both come BEFORE the events read, so a refusal reads nothing more and
   * accepts nothing, and the events read stays the last await ahead of the
   * attach. So does the list of every member row the frames are judged by
   * (read_context), after both rechecks, so a refusal still lists nothing.
   * Every one of them is a storage read, which is what keeps the gate closed
   * across the whole sequence.
   *
   * The gate is D5's premise and is untested here: the fake has no input gate,
   * and the sequence test pins only that nothing else awaits. Task 8's test,
   * which races an append against an upgrade, is what exercises it.
   *
   * What goes out is publicEvent(e), the shape wake() and the poll use, and not
   * the stored event, which carries the sender's user id (spec D1a). And only
   * the events as no one may read them (read_context plan, R2), which is what
   * wake() sends a live socket, so a reconnect is shown no more: a brief its
   * author keeps is dropped, and their join goes out with its brief null. The
   * attached cursor is still the last event read, so it moves past one dropped.
   * The frames are built straight after the read, so that a failure there, like
   * the read's and the attach's, accepts nothing.
   *
   * The cursor goes on before the accept. wake() has no good answer for a
   * socket whose cursor it does not know: send it everything, or silently
   * send it nothing. The read can throw, and so can serializeAttachment, above
   * 16 KB. Both come before the accept, so a failure of either accepts nothing.
   *
   * DEPENDENCY. Attaching before accepting works, and survives eviction, in
   * the workerd that worker-tests pins (D5 records which, and how it was
   * measured). That is observed behaviour, not a guarantee this repo controls.
   * Do not "tidy" this back to accept-then-attach: it reopens the stranded
   * socket. And if a future workerd stopped persisting a pre-accept
   * attachment, every socket would arrive with no cursor and wake() fails
   * closed (D5), so delivery would go quiet instead of erroring. Task 8's
   * workerd test and the smoke leg are what would catch that.
   *
   * The 16 KB is reachable only by churn. What goes in is the ids one identity
   * owns in this room, departed members included, except one a creator removed
   * (#113): membersOf returns the others on purpose, so /ws and bellman_sync
   * agree about who may watch the open feed, and nothing deletes a member's
   * row (ADR 0019). The list grows with seatings, not with the room's capacity
   * (`capacityOf`), so it takes over a thousand seatings by one identity in one
   * room's life. That is churn, not a breach of the capacity.
   */
  async fetch(request: Request): Promise<Response> {
    // The same reading as the route's, from the same module (#132). The Worker builds
    // this request and sets the header itself, so nothing reaches here with `WebSocket`
    // or a list today — which is the reason to share the rule rather than let a second
    // copy of it sit here being quietly wrong.
    if (!wantsWebSocket(request.headers.get("upgrade"))) {
      return new Response(UPGRADE_REQUIRED.body, {
        status: UPGRADE_REQUIRED.status,
        headers: UPGRADE_REQUIRED.headers,
      });
    }
    const url = new URL(request.url);
    const cursor = Number(url.searchParams.get("cursor"));
    const asked = (request.headers.get("x-bellman-members") ?? "")
      .split(",").filter(Boolean);

    // ONE roster read answering both rechecks (#133 and #113). The Worker's
    // membersOf said open, and said who this identity holds, but that was a
    // second invocation of this object and the input gate spans neither it nor
    // the gap after it: a close, the abandonment alarm, or a removal lands there. So
    // both guards are asked HERE, where the registration is, and all of it is
    // one invocation — the read-and-register rule again, with "closed" and the
    // roster as the things read instead of the cursor.
    //
    // Read once rather than twice: the two guards ask different questions of
    // the same record, and a second `stored()` would be a second read of a row
    // the gate already holds still.
    const s = await this.stored();

    // Closed first: a closed room owes a 409 whoever is asking. The Worker
    // returns this response unchanged, and its own pre-check answers the same
    // 409 with the same body for a room already closed when it looked.
    //
    // `!s` is spelled out although `readsClosed` already answers true for a
    // missing record: it is not a type predicate, so the compiler cannot narrow
    // `s` through it, and the cut below reads `s`. Naming the case here
    // is honest about why, where a non-null assertion would hide that the two
    // guards agree. Change `readsClosed` to a predicate and this collapses.
    if (!s || readsClosed(s, Date.now(), await this.#connected(s))) {
      return new Response("This room is closed", { status: 409 });
    }

    // Then the cut: the roster this request was built against, re-read. A removed
    // member is not on the record (ADR 0019), so the ids asked for are read by row,
    // which is storage like every other await here.
    const cut = new Set<string>(
      (await this.#membersById(s, asked)).filter(isRemovedMember).map((m) => m.memberId),
    );
    const memberIds = asked.filter((id) => !cut.has(id));
    if (asked.length > 0 && memberIds.length === 0) {
      return new Response("Forbidden", { status: 403 });
    }

    // Every member row, departed included: a frame shows a brief only when its
    // author grants read_context, a member who left keeps their grant (D2), and
    // the record holds only the members in the room now (ADR 0019). Listed before
    // the events read, though only the briefs' authors are wanted, because those
    // are known only from the events, and the events read must stay the last
    // await (plan ruling R12).
    // ponytail: every member row on each upgrade, as departedMembers lists them;
    // read only briefAuthors(missed)'s rows when a roster outgrows one list, which
    // moves a storage read after the events read and the sequence test with it.
    const rows = [...(await this.ctx.storage.list<Member>({ prefix: MEMBER_PREFIX })).values()];

    // The last await, and every one before it is a storage read, so the gate
    // holds from the first recheck to the return. From here nothing yields.
    const missed = await this.events(cursor, REPLAY_LIMIT + 1);
    if (missed.length > REPLAY_LIMIT) {
      return new Response(
        `More than ${REPLAY_LIMIT} events since cursor ${cursor}: catch up with bellman_sync, then reconnect`,
        { status: 410 },
      );
    }
    // As no one (R2), so the attachment below still takes its cursor from `missed`.
    const frames = readableEvents(missed, rows, null).map((e) => JSON.stringify(publicEvent(e)));

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const attachment: SocketAttachment = {
      memberIds,
      cursor: missed.length > 0 ? missed[missed.length - 1].cursor : cursor,
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);
    for (const frame of frames) server.send(frame);

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * The socket is receive-only, and this is where that is enforced rather than
   * merely intended.
   *
   * A send over the socket would need bellman_send's verb check, frozen guard,
   * idempotency record, payload-depth limit and audit write reimplemented at a
   * second entry point and kept behaviourally identical to the first (spec D1).
   * Adding that is a deliberate act, and it starts here: whoever adds a
   * protocol message has to take this close out first.
   *
   * Closed, not ignored: an ignored frame leaves a client believing it spoke.
   * 1003 is "unsupported data", and the reason is what a developer reads in
   * their client's close event, so it says where to send. Nothing in the frame
   * is read, parsed or stored: peer content is untrusted, and the safest thing
   * to do with a client's bytes here is nothing.
   *
   * The reason has to stay within 123 bytes of UTF-8. ws.close() throws above
   * that, and the throw leaves the socket open (both measured), so enforcement
   * would become an exception. The test fake throws there too.
   *
   * A frame equal to the auto-response's request never arrives here (see the
   * constructor).
   *
   * After this close the runtime goes on listing the socket until its peer
   * acknowledges, reading CLOSING, and a send to it throws. Measured: still
   * listed 23 s on, for a peer that never answered, and the same on an instance
   * revived after eviction. wake() skips a socket that reads CLOSING or CLOSED,
   * so one that has sent a frame costs the room no send and no log line.
   */
  async webSocketMessage(ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    ws.close(1003, "This socket is receive-only. Send with bellman_send over /mcp.");
  }

  /**
   * The peer closed, or the connection dropped. A drop arrives here too, as
   * code 1006 and wasClean false.
   *
   * There is nothing to prune. The runtime drops the socket from
   * getWebSockets() on its own, measured after a polite close, a bare TCP FIN
   * and an RST, with this handler and without it, and this object keeps no list
   * of sockets of its own.
   *
   * What this is for is the answer. The runtime does not complete a close
   * handshake the peer started. With an empty handler, or none (the same, in
   * every case measured), the peer's close never completes: Node's WebSocket
   * client gave up after about 10 s and reported 1006, unclean. Replying
   * completes it in milliseconds. Neither this handler nor webSocketError is
   * needed for the object to hibernate or for a socket to leave
   * getWebSockets(). An object with neither was evicted and revived like one
   * with both, and a client close woke it either way.
   *
   * Always 1000, never the peer's own code. A peer that calls close() with no
   * argument arrives as 1005, and ws.close(1005) throws, as do 1004, 1006 and
   * 1015, the codes RFC 6455 reserves. Echoing the code, the obvious thing to
   * write, therefore fails for the first client that closes politely and says
   * nothing: the handler throws and the close never completes (measured). RFC
   * 6455 says an endpoint typically echoes the code, not that it must. This
   * also runs when the peer acknowledges the close webSocketMessage started,
   * and replying to a socket already closed does not throw (measured).
   */
  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    // The answer first, and the stamp after. Completing the peer's close is what
    // this handler is FOR, it takes milliseconds, and a stamp that threw before
    // it would cost the client the 10 s wait and an unclean 1006 described above.
    ws.close(1000, "closing");
    await this.#stampClosing(ws);
  }

  /**
   * Record that the members this socket carried were here, as it goes (#152).
   *
   * Presence has three signals and this is the seam between two of them. While
   * the socket is open `connectedMembers` answers for it, and that beats the
   * window. The instant it closes the socket stops vouching — correctly, since
   * reading the live list is the whole design — and the member falls back to
   * `lastSeenAt`. For a member fed by this socket or by the local bus that field
   * has not moved since it joined, because nothing it does runs `touchMember`
   * (src/rooms.ts): `bellman_sync` and `bellman_send` run it, and so does
   * `gateSeat`, for an invite, a revoke or a surface write. So it read stale the
   * moment its socket dropped, with its window already spent, and the next
   * contested `bellman_confirm` took its seat.
   *
   * Here rather than on the upgrade, which was the other candidate. This covers a
   * socket that has been open for hours, where a stamp at connect buys one window
   * and then expires; and it records a fact rather than predicting one, because
   * the member demonstrably was there a moment ago. A DROP reaches this handler
   * too, as 1006 with wasClean false, so it is not only polite closes. What it
   * cannot cover is a socket the runtime never reports at all, which would need
   * the upgrade stamp as well.
   *
   * `connectedAmong` and not the attachment's ids directly, so this stamps
   * exactly whom the socket was vouching FOR. The attachment is a snapshot taken
   * at upgrade, and a member that joined the room later is served by the same
   * socket without being named in it — the reason that function exists.
   *
   * Closed and frozen rooms are skipped, `touchMember`'s rule (src/rooms.ts). A
   * closed room's record is over, and a freeze is meant to cost nobody their
   * place so nobody needs defending during one.
   *
   * One put for every member, not one each, and of their rows alone (ADR 0019): a
   * socket serving several members would otherwise pay a read of the room for each.
   * No reArm, for `updateMember`'s reason — `lastSeenAt`
   * reaches `nextTickAt` not at all, and it moves `abandonedAt` only later, so the
   * armed alarm is early at worst and the reArm() that ends `alarm()` corrects it.
   *
   * Swallowed on failure, `touchMember`'s rule again: this rides on somebody
   * else's teardown, and a liveness write that failed must not turn a close into
   * an error. The cost of losing one is the member looking quiet, which is the
   * behaviour before this existed.
   */
  async #stampClosing(ws: WebSocket): Promise<void> {
    try {
      const att = ws.deserializeAttachment() as Partial<SocketAttachment> | null;
      const ids = att?.memberIds;
      if (!Array.isArray(ids) || ids.length === 0) return;
      const s = await this.stored();
      if (!s || s.closed || s.frozenAt !== null) return;
      // The ids can name a member who has left, whose row says whose socket it was.
      const stamped = connectedAmong([...s.members, ...await this.#membersById(s, ids)], ids);
      if (stamped.size === 0) return;
      const now = Date.now();
      // The stamped members' rows and nothing else (ADR 0019).
      await putRows(this.ctx.storage, memberRows(s, { ...s, members: stampSeen(s.members, now, stamped) }));
    } catch (err) {
      console.error("socket close stamp failed:", err);
    }
  }

  /**
   * A protocol error from the peer: a reserved opcode, or a compressed frame on
   * a connection that never negotiated compression (the two measured). The
   * runtime sends its own Close, 1002, and drops the socket from
   * getWebSockets() without help from this handler (measured with and without
   * it), so there is nothing to answer and nothing to prune. Empty on purpose.
   * It is here to state the answer for each of the lifecycle's three events,
   * not because the runtime needs it.
   */
  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {}

  /**
   * Retire one role's code, and drop it from the registry's index.
   *
   * This and the two mutators below share a shape. The check, the session write and
   * the queued registry writes are one transaction, and the delivery waits until it has
   * committed: nothing that awaits another object runs inside a transaction closure,
   * because every other call to this object waits for the closure to commit. A call
   * that is refused or has nothing to do never reaches the queue, so it queues nothing
   * and arms nothing.
   */
  async consumeJoinCode(role: string): Promise<void> {
    const consumed = await this.ctx.storage.transaction(async (txn) => {
      const s = await this.stored(txn);
      const rec = s?.joinCodes[role];
      if (!s || !rec) return false;
      const { [role]: _retired, ...rest } = s.joinCodes;
      const rows = await this.driver.enqueue(txn, [dropCodeIntent(rec.code)]);
      await putRows(txn, { ...memberRows(s, { ...s, joinCodes: rest }), ...rows });
      return true;
    });
    if (consumed) await this.driver.deliverNow();
  }

  /** Retire every code, and drop each from the registry's index. */
  async clearJoinCodes(): Promise<void> {
    const cleared = await this.ctx.storage.transaction(async (txn) => {
      const s = await this.stored(txn);
      if (!s) return false;
      const codes = Object.values(s.joinCodes).map((rec) => rec.code);
      if (codes.length === 0) return false;
      const rows = await this.driver.enqueue(txn, codes.map((code) => dropCodeIntent(code)));
      await putRows(txn, { ...memberRows(s, { ...s, joinCodes: {} }), ...rows });
      return true;
    });
    if (cleared) await this.driver.deliverNow();
  }

  /**
   * Issue a code for one role, replacing that role's previous one in the registry's
   * index. `false` means frozen or missing, and queues nothing.
   *
   * The previous code's drop is queued ahead of the new code's put, and the queue is
   * delivered in order, so the rotated-out code stops resolving before its
   * replacement starts and never the reverse. Reversed, re-issuing a code a role
   * already holds would end with it dropped from the index while the session still
   * lists it.
   */
  async setJoinCode(
    role: string, code: string, expiresAt: number | null,
    guard: { replaceLive: boolean; now: number },
  ): Promise<SetJoinCode> {
    const outcome = await this.ctx.storage.transaction<SetJoinCode>(async (txn) => {
      const s = await this.stored(txn);
      if (!s) return { ok: false, reason: "frozen" };
      if (s.frozenAt !== null) return { ok: false, reason: "frozen" };
      // A permanent code only for a public room, decided in this transaction for the
      // reason below: unpublishSession retires them in its own, so a room made private
      // after the caller read it public would otherwise keep this one (ADR 0020).
      if (expiresAt === null && !isPublic(s)) return { ok: false, reason: "not_public" };

      // The `revoke` authority, decided inside the transaction that writes.
      // Deciding it from a record read earlier let two callers holding `invite`
      // alone both see no live code, and the second retire the first's (#90,
      // found in review). Live and not merely present: an expired record shuts
      // no door, so minting over it is opening rather than replacing.
      const existing = s.joinCodes[role];
      const live = existing !== undefined && codeIsLive(existing, guard.now);
      if (live && !guard.replaceLive) return { ok: false, reason: "live_code_exists" };

      const previous = existing?.code;
      const rows = await this.driver.enqueue(txn, [
        ...(previous ? [dropCodeIntent(previous)] : []),
        putCodeIntent(code, s.id),
      ]);
      await putRows(txn, {
        ...memberRows(s, { ...s, joinCodes: { ...s.joinCodes, [role]: { code, expiresAt } } }),
        ...rows,
      });
      return { ok: true, replacedLive: live };
    });
    if (outcome.ok) await this.driver.deliverNow();
    return outcome;
  }

  /**
   * Append a member, refused only when the room is missing, frozen or closed. No
   * capacity check and no reclaiming. No tool calls it: the production join is
   * seatMember, which makes the same refusals and also allocates the seat. It stays
   * for the contract suite and for a caller that is not allocating one, as
   * BellmanStore.seatMember says.
   *
   * One transaction, for the reason stored() gives. Closed is the other half of
   * closeSessionIfEmpty, as it is in seatMember: that keeps a close from landing on
   * an occupied room, and this keeps a join from landing on a closed one.
   *
   * **The rule the heartbeat's derived alarm imposes on every mutator here, stated
   * once: a write that can flip `nextTickAt` from null to non-null must `reArm()`
   * once it has committed.**
   *
   * `nextTickAt` returns null for five reasons — no cadence, the room is closed,
   * the room is frozen, no active member holds a reporting seat, or every member
   * that holds one has gone `ASKS` cadences without reporting (#208). While it is
   * null nothing is armed for the tick, so there is no firing left to notice the
   * state that made it non-null: the answer cannot correct itself. Adding a member
   * is one such write (this and `seatMember`), so is clearing `frozenAt`
   * (`freezeSession`), and so is a report from a member the room had stopped asking,
   * which the appends re-arm for by `tickBroughtForward`. The other direction needs
   * nothing: the armed alarm fires once, finds nobody due, and the reArm() that ends
   * `alarm()` drops the tick.
   *
   * After the transaction has COMMITTED, never inside its closure.
   * ARCHITECTURE.md §9: everything awaited in a closure holds every other call to
   * this object until it commits, and reArm() reads `derivedDue()`, which reads
   * `stored()`. `OutboxDriver.enqueue` arming from inside a caller's closure is
   * the one deliberate exception, and it is a bare `setAlarm` with nothing to read.
   *
   * Guarded on the write having landed, where it used to be unconditional: the
   * transaction now reports whether it committed, and a refusal commits nothing,
   * so a join that did not land arms nothing. reArm() is still idempotent, so the
   * guard is about saying what this method means rather than about the cost.
   * `createSession`'s "only when nothing was queued" guard does NOT transfer here
   * — see seatMember.
   */
  async addMember(member: ArrivingMember): Promise<boolean> {
    const added = await this.ctx.storage.transaction(async (txn) => {
      const s = await this.stored(txn);
      if (!s) return false;
      if (s.frozenAt !== null) return false;
      if (s.closed) return false;
      // The member's row, its index row, its brief's row, and its label's number when the
      // room has not numbered that label before (ADR 0018, ADR 0019).
      const { room, rows } = seated(s, s.members, member, await txn.get<number>(labelKey(member.label)));
      await putRows(txn, { ...memberRows(s, room), ...rows });
      return true;
    });
    if (added) await this.driver.reArm();
    return added;
  }

  /**
   * Reclaim stale seats and seat the member, as one transaction. This is the
   * production join (bellman_confirm), and the other half of closeSessionIfEmpty:
   * that keeps a close from landing on an occupied room, and the closed refusal here
   * keeps a join from landing on a closed one. Neither is enough alone, and the pair
   * is atomic only if each is one unit.
   *
   * The decision and the write are one unit for the other callers too: no confirm,
   * sync or freeze can land between them. A caller that read the roster, chose a
   * victim and then wrote would be handed exactly the window two concurrent joiners
   * need to overfill the room. See stored() for what a transaction adds to the input
   * gate's hold on a read and then a put.
   *
   * The reArm() is addMember's rule — seating the member the room asks for reports
   * is the write that flips `nextTickAt` off null, and the room this feature exists
   * for is exactly the one whose creator does not report. It runs AFTER the
   * transaction has committed, never inside the closure, which is both ARCHITECTURE
   * §9's rule and what makes it safe: it does not reopen invariant 9, because the
   * seat is already committed and nothing it does can refuse or undo it. A reArm()
   * that failed would leave the seat standing and the arming missed, which is what
   * this method did before it was here.
   *
   * Only on a successful seating, so a room that refused "full", "closed" or
   * "frozen" arms nothing it did not change.
   *
   * A seating that fills the room also retires its codes (#116). The registry drops
   * are queued in this transaction, by the same `enqueue` `clearJoinCodes` uses, and
   * delivered once it has committed. That used to be `bellman_confirm` calling
   * `clearJoinCodes` after this returned, a second transaction in this object with
   * nothing spanning the two, and its failure left the member seated with no event,
   * no audit row and no member_id returned.
   *
   * `createSession` deliberately skips reArm() when it queued outbox intents,
   * because `enqueue` arms for the queue's marker — dated now — and a reArm()
   * would bring the alarm in behind the commit to race the inline delivery. A
   * seating that retired codes queued some, so the same race is open here, and it
   * is closed by the order: deliver first, and re-arm only once the delivery has
   * finished. By then the marker is gone unless a delivery failed, and a marker
   * still present means a delivery genuinely is owed, so arming for it is recovery
   * rather than a race. A seating that retired nothing queued nothing, so the only
   * due times reArm() sees are the abandonment time, the tick, and a marker some
   * earlier call left behind.
   */
  async seatMember(member: ArrivingMember, staleBefore: number, now: number): Promise<SeatOutcome> {
    const outcome = await this.ctx.storage.transaction<SeatOutcome>(async (txn) => {
      const no = { reclaimed: [], codesCleared: false };
      const s = await this.stored(txn);
      if (!s) return { refused: "not_found" as const, ...no };
      if (s.closed) return { refused: "closed" as const, ...no };
      if (s.frozenAt !== null) return { refused: "frozen" as const, ...no };
      // Read in this transaction and before any seat is counted: a ban landing between a caller's
      // read and this write cannot be missed, and a banned account is never told the room is full.
      if ((await txn.get<string>(banUserKey(member.userId))) !== undefined) {
        return { refused: "banned" as const, ...no };
      }

      // The sockets as they are now, read here and not passed in. They are read
      // inside the transaction, and the one await in it is a storage read of the
      // rows of members they name who have left, so the decision is made against
      // the sockets that exist while this holds the object. A set fetched by the
      // caller first could not promise that: a member can connect in the gap, and
      // reclaiming it is final.
      const connected = await this.#connected(s, txn);
      const victims = seatVictims(s.members, capacityOf(s.manifest), staleBefore, connected);
      if (victims === null) return { refused: "full" as const, ...no };

      const departed = new Set(victims.map((v) => v.memberId));
      const reclaimed: Member[] = [];
      const members = s.members.map((m) => {
        if (!departed.has(m.memberId)) return m;
        const next = { ...m, leftAt: now };
        reclaimed.push(next);
        return next;
      });
      // The member after the seats reclaimed, with its rows (ADR 0018, ADR 0019).
      const { room, rows: seatingRows } = seated(s, members, member, await txn.get<number>(labelKey(member.label)));

      // A full room has no seat for ANY role, so every temporary code goes — in this
      // transaction, not in a second call after it committed (#116). The
      // registry drops ride the same outbox clearJoinCodes uses.
      //
      // "Full" is asked the only way that preserves what bellman_confirm used to
      // compute: whether a FURTHER joiner would be refused. Counting members with
      // a null leftAt is not the same question — a stale seat is occupied but
      // reclaimable, so a room with one still has a door worth leaving open.
      //
      // Cleared by presence, where removeMember retires only a code that is still live
      // (`codeIsLive(rec, req.now)`). The two ask different questions. A removal
      // announces a door shutting, so it must not announce one that had already shut,
      // and an expired record is not a door. A seating announces nothing: it tidies
      // rows, and a full room needs no code at all, so an expired record is dropped
      // from the room and from the registry's index with the rest. A room that fills
      // while holding only one therefore reports `codesCleared: true`, which answers
      // this question and does not contradict the other. The contract suite pins this
      // side, and its expired-code cases for removeMember pin the other.
      //
      // A permanent code stays (ADR 0020): the room refuses joiners while it is full,
      // and the link on a public page works again when a seat frees.
      const full = seatVictims(room.members, capacityOf(s.manifest), staleBefore, connected) === null;
      const retired = full ? Object.entries(s.joinCodes).filter(([, rec]) => rec.expiresAt !== null) : [];
      const rows = await this.driver.enqueue(txn, retired.map(([, rec]) => dropCodeIntent(rec.code)));
      const joinCodes = { ...s.joinCodes };
      for (const [role] of retired) delete joinCodes[role];

      await putRows(txn, {
        ...memberRows(s, { ...room, joinCodes }),
        ...seatingRows,
        ...rows,
      });
      // What the call did, and not only whether the room filled: a room that fills
      // with no code left in it queued nothing, so there is nothing to deliver.
      return { refused: null, reclaimed, codesCleared: retired.length > 0 };
    });
    // After the commit, never inside the closure: everything awaited in there holds
    // every other call to this object until it commits. Delivery first, then the
    // re-arm, for the reason above.
    if (outcome.refused === null) {
      if (outcome.codesCleared) await this.driver.deliverNow();
      await this.driver.reArm();
    }
    return outcome;
  }

  async removeMember(
    memberId: string,
    req: RemovalRequest,
  ): Promise<RemovalOutcome> {
    // `written` rides out of the closure so the wake can happen after the
    // commit, the way appendEvent does it: nobody hears of an event that did
    // not land. `queued` rides with it, for the delivery: rows can be owed with
    // no event written. Both are stripped before the result goes back over RPC.
    const outcome = await this.ctx.storage.transaction<
      RemovalOutcome & { written: SessionEvent[]; queued: boolean }
    >(async (txn) => {
      const no = { removed: false, codeRetired: null, written: [], queued: false };
      const s = await this.stored(txn);
      if (!s) return { refused: "not_found" as const, ...no };
      if (s.closed) return { refused: "closed" as const, ...no };
      if (req.frozen === "refuse" && s.frozenAt !== null) {
        return { refused: "frozen" as const, ...no };
      }
      if (req.byUserId !== undefined && s.createdBy !== req.byUserId) {
        return { refused: "forbidden" as const, ...no };
      }
      // A member who has left is a row of its own and not on the record (ADR 0019), and
      // still answers here: the idempotent path below is for exactly that member.
      const m = s.members.find((mm) => mm.memberId === memberId) ?? await txn.get<Member>(memberKey(memberId));
      if (!m) return { refused: "not_found" as const, ...no };
      // One value for "there is a live door to shut". Nothing prunes an expired
      // record, so a code's presence in joinCodes is not the same as a door
      // being open, and retiring on presence announces a closing that already
      // happened. Decided before the member's state is looked at, because a live
      // door is owed to one who is already out as much as to one who is not.
      const rec = req.retire ? s.joinCodes[req.retire.role] : undefined;
      const retiring = req.retire && rec && codeIsLive(rec, req.now)
        ? { role: req.retire.role, code: rec.code, event: req.retire.event, audit: req.retire.audit ?? [] }
        : null;

      // The ban this call owes: asked for, and not yet on the room. One ban per account, so a repeat
      // keeps the first and owes nothing. Decided before the member's state is looked at, for the
      // door's reason: a ban is owed to one who is already out as much as to one who is not.
      const banning: Ban | null = req.ban !== undefined && (await txn.get<string>(banUserKey(m.userId))) === undefined
        ? { banId: newBanId(), userId: m.userId, label: m.label, at: req.now }
        : null;
      // The creator-wide ban that "all" also asks for. It lives in the registry, which this transaction
      // cannot write, so it is queued for the outbox below. Owed whenever it is asked for, and not only
      // while this room holds no ban: the registry cannot be read from here, and its write keeps
      // whichever ban came first, so a repeat costs one row and changes nothing. The id is made here, so
      // a redelivery carries the same one.
      const widening: CreatorBan | null = req.ban === "all"
        ? { banId: newBanId(), userId: m.userId, label: m.label, at: req.now, sessionId: s.id }
        : null;

      // Already out: the idempotent path. The departure is not said again, and
      // queueing nothing for it is the half an idempotency key could not cover. A
      // live door behind them, or a ban not yet on the room, is a different matter:
      // it was never done, so doing it is a write that has not happened yet and not a
      // duplicate. With none owed, nothing is written and nothing is queued.
      const leaving = isActiveMember(m);
      if (!leaving && !retiring && !banning && !widening) return { refused: null, ...no };

      const joinCodes = { ...s.joinCodes };
      if (retiring) delete joinCodes[retiring.role];

      // Written in this transaction's one put, not through appendEvent: the
      // frozen refusal lives on the public append and stays there, because it is
      // what stops a freeze landing between a tool's read and its write and
      // letting a room grow. This operation declares its own policy through
      // `frozen`. The store still never asks what an event means — it writes
      // what it was given.
      //
      // The order is the one a person would tell it: the member went, then the
      // door shut. Either may be missing, and not both: a member who was already
      // out has no departure to write.
      let next = await this.nextCursor(txn);
      const at = Date.now();
      const written: SessionEvent[] = [];
      if (leaving) written.push({ ...req.event, cursor: next++, at });
      if (retiring) written.push({ ...retiring.event, cursor: next++, at });
      // The seat's votes on every decision still unclosed, voided after the member and the door (ADR 0040, decision
      // 12). The book names them; one list of the log from the oldest reads them, as an open reads the ones it closes.
      const book = s.openDecisions ?? {};
      const unclosed = Object.keys(book).map(Number);
      const log = leaving && unclosed.length > 0 ? await this.#logFrom(txn, Math.min(...unclosed)) : [];
      const ballots = log.length === 0 ? new Map() : bookOf(await this.#ballotRows(txn, unclosed));
      const voiding: SessionEvent[] = log.length === 0
        ? []
        : removalEvents(decisionsOf(log, at, ballots).values(), memberId, req.event).map((b) => ({ ...b, cursor: next++, at }));
      written.push(...voiding);

      // The roster is built AFTER the events, because a cut names the departure's
      // own cursor and the departure does not have one until it is numbered. The
      // departure is `written[0]` whenever there is one: the order above is the
      // member then the door, and a member who was already out has no departure.
      //
      // `markRemoved` when the caller asked to cut, which is the rule `extraRows`
      // applies for an append's `markRemoved` extra — one piece of code shared
      // with MemoryStore, so the two stores cannot record a cut differently
      // (#113). Without it a removal routed through here would stamp `leftAt` and
      // cap nothing, which is #113 reopened in the operation written to close it.
      //
      // `req.now` for the stamp and not `at`: a removal's clock is its caller's,
      // and the contract pins `leftAt` to the `now` it was handed.
      //
      // Null is unreachable: `leaving` read `leftAt` as null from this same
      // transaction's roster. It falls back to the roster unchanged rather than
      // stamping `leftAt` on its own, because a member recorded out with no cut
      // is the open feed, and leaving them in is the recoverable half.
      const members = !leaving
        ? s.members
        : req.cut
          ? markRemoved(s.members, memberId, written[0].cursor, req.now) ?? s.members
          : s.members.map((mm) => (mm.memberId === memberId ? { ...mm, leftAt: req.now } : mm));

      // A falsy org names a stream nobody reads (ARCHITECTURE.md section 9,
      // runtime fact 4). It is filtered here, so a dead row never enters the
      // queue, and again in #deliver, so one that arrives another way is dropped
      // instead of misfiled. The door's rows get the same filter as the member's,
      // and go in the same order as the events: the outbox delivers in order. The member's
      // rows are for a call that removed them or wrote this room's ban, as MemoryStore files
      // them: a ban on someone who already left is the eviction's row all the same. Not for
      // `widening`, which is owed on every ask here because the registry cannot be read from
      // this transaction, so a retry of "all" would file the row again.
      const decided = decisionsOf([...log, ...voiding], at, ballots);
      const secretRows = voiding.some((e) => e.type === "decision_closed" && isSecret(decided.get((e.payload as { decision: number }).decision)?.payload ?? { rule: "" }))
        ? await this.#secretTemplate(txn, s, at)
        : [];
      const intents = [
        ...(leaving || banning ? req.audit : []), ...(retiring ? retiring.audit : []),
        ...decisionAudit(req.audit, voiding, decided, secretRows),
      ].filter((e) => e.orgId).map(auditIntent);
      const codeRows = retiring ? [dropCodeIntent(retiring.code)] : [];
      // The registry's writes, the code's and the ban's, ahead of the audit rows: one enqueue, in order.
      const banRows = widening ? [creatorBanIntent(s.createdBy, widening)] : [];
      const queue = [...codeRows, ...banRows, ...intents];
      const rows = await this.driver.enqueue(txn, queue);

      // Housekeeping's books (#66), for each event this removal wrote. These events go in
      // the put below and not through `#writeEvent`, so its step does not cover them, and a
      // departure is the very event that closes the leaver's requests. Applied over the
      // roster built above, so the stamp is laid on the leave and the cut and never over them.
      const kept = written.reduce<StoredSession>(
        (draft, e) => ({ ...draft, ...noteAppend(draft, e) }),
        { ...s, members, joinCodes, ...(voiding.length > 0 ? { openDecisions: noteDecisions(book, voiding) } : {}) },
      );
      await putRows(txn, {
        ...memberRows(s, kept),
        ...Object.fromEntries(written.map((e) => [eventKey(e.cursor), e])),
        // The cursor row ends at the LAST event written, or the next append takes
        // that event's cursor and overwrites it (#120). A ban on a member who was already out,
        // behind no live door, writes no event: the row stays where it is, because the last
        // of no events does not exist to read, and any other value would move the cursor.
        ...(written.length > 0 ? { cursor: written[written.length - 1].cursor } : {}),
        // The ban's two rows commit with whatever else this removal wrote, or not at all.
        ...(banning ? { [banKey(banning.banId)]: banning, [banUserKey(banning.userId)]: banning.banId } : {}),
        ...rows,
      });
      // Last, after the put: a secret ballot this removal closed keeps no choice (secret ballot spec, close path 5).
      await this.#eraseClosed(txn, voiding, decided);
      return { refused: null, removed: leaving, codeRetired: retiring?.role ?? null, written, queued: queue.length > 0 };
    });

    const { written, queued, ...result } = outcome;
    // After the commit, never inside the closure: everything awaited in there
    // holds every other call to this object until it commits, and reArm() reads
    // stored(). `written` is empty when no event was written: a refusal, or a
    // member who was already out behind no live door, with a ban to record or none.
    // A door shut on its own queues rows that want delivering, and moves nothing else,
    // and so does a creator-wide ban on a member who left long ago.
    for (const e of written) this.#wake(e);
    // After the wake, as appendEvent does it: the member removed is sent the
    // frame announcing it before their socket goes, so the notice is the last
    // thing they receive. Only when this call recorded a cut — the pass reads the
    // roster, which is a storage read no other removal should pay, and a leave
    // cuts nobody so it has no socket to close.
    if (result.removed && req.cut) await this.#closeCutSockets();
    // Whenever a row was queued, and not only when an event was written: a creator-wide ban on a member
    // who already left queues one and writes none, and nothing else would deliver it before the alarm.
    if (written.length > 0 || queued) await this.driver.deliverNow();
    // A member leaving can take the last reporting seat with them, so the derived
    // tick may have moved.
    if (result.removed) await this.driver.reArm();
    return result;
  }

  /** Whether this room bans the account: one `get` of its `bu:` row. An unknown room holds none. */
  async isBanned(userId: string): Promise<boolean> {
    return (await this.ctx.storage.get<string>(banUserKey(userId))) !== undefined;
  }

  /** The bans on this room, oldest first (spec section 1). An object with no ban rows lists none, an unknown room's included. */
  async roomBans(): Promise<Ban[]> {
    const rows = await this.ctx.storage.list<Ban>({ prefix: BAN_PREFIX });
    return [...rows.values()].sort(oldestFirst);
  }

  /**
   * Both of a ban's rows go in one transaction, and the answer is whether there was a ban to lift. An id
   * that is not shaped like one is answered before the transaction opens: it arrives from outside, and
   * Durable Object storage limits a key to 2 KiB.
   */
  async liftRoomBan(banId: string): Promise<boolean> {
    if (!isBanId(banId)) return false;
    return this.ctx.storage.transaction(async (txn) => {
      const ban = await txn.get<Ban>(banKey(banId));
      if (ban === undefined) return false;
      await txn.delete([banKey(banId), banUserKey(ban.userId)]);
      return true;
    });
  }

  /**
   * The briefs of these members, from their rows (ADR 0018). An older room's inline briefs
   * moved to rows with its members (ADR 0019, D5), so the rows are all there is.
   */
  async getBriefs(memberIds: string[]): Promise<Record<string, Brief>> {
    const out: Record<string, Brief> = {};
    for (const [key, brief] of await getRows<Brief>(this.ctx.storage, memberIds.map(briefKey))) {
      out[key.slice(BRIEF_PREFIX.length)] = brief;
    }
    return out;
  }

  /** `BellmanStore.getMember`, for this room: the member's row, in the room or gone from it. */
  async getMember(memberId: string): Promise<Member | undefined> {
    return this.ctx.storage.get<Member>(memberKey(memberId));
  }

  /** `BellmanStore.getMembers`, for this room: their rows, in join order. */
  async getMembers(memberIds: string[]): Promise<Member[]> {
    const rows = await getRows<Member>(this.ctx.storage, [...new Set(memberIds)].map(memberKey));
    return [...rows.values()].sort((a, b) => a.seq - b.seq);
  }

  /** `BellmanStore.membersOfUser`, for this room: the rows the person's index names, in join order. */
  async membersOfUser(userId: string): Promise<Member[]> {
    const ids = await this.ctx.storage.list<string>({ prefix: userPrefix(userId) });
    return this.getMembers([...ids.values()]);
  }

  /**
   * `BellmanStore.departedMembers`, for this room, by `departures`, the rule MemoryStore
   * answers with. It lists every member's row to find those who have left.
   */
  async departedMembers(opts?: { limit?: number; leftAfter?: number }): Promise<DepartedMembers> {
    // ponytail: lists every member row; an index on leftAt, when a room's departures outgrow one list.
    const rows = await this.ctx.storage.list<Member>({ prefix: MEMBER_PREFIX });
    return departures([...rows.values()], opts);
  }

  /**
   * Every member the room has seated, in it or gone from it, from their rows: the roster whose
   * orgs a purge's and a delete's audit rows name as their parties (audit trail spec, D2), as
   * MemoryStore's record holds it. The record keeps only the members in the room (ADR 0019).
   * Read through `from`, so a caller inside a transaction reads them in it.
   */
  async #everyone(
    from: { list<T>(options: { prefix: string }): Promise<Map<string, T>> } = this.ctx.storage,
  ): Promise<Member[]> {
    // ponytail: lists every member row, as departedMembers does; once per delete and per purge.
    return [...(await from.list<Member>({ prefix: MEMBER_PREFIX })).values()];
  }

  /** `BellmanStore.publicNumbers`, for this room: each label's number, from its `lb:` row. */
  async publicNumbers(labels: string[]): Promise<Record<string, number>> {
    const unique = [...new Set(labels)];
    const rows = await getRows<number>(this.ctx.storage, unique.map(labelKey));
    return Object.fromEntries(unique.flatMap((label) => {
      const n = rows.get(labelKey(label));
      return n === undefined ? [] : [[label, n]];
    }));
  }

  // updateMember still reads and then puts. Unconverted, not exempt: see stored().
  async updateMember(memberId: string, patch: MemberPatch): Promise<void> {
    const s = await this.stored();
    if (!s) return;
    // A member who has left is read by its row, so a patch reaches it as it reaches one
    // still in the room (ADR 0019). An unknown member is a no-op.
    const was = s.members.find((m) => m.memberId === memberId) ?? await this.ctx.storage.get<Member>(memberKey(memberId));
    if (!was) return;
    const next = { ...was };
    // The agent to the member's row and the brief to its own (ADR 0018).
    if (patch.brief !== undefined) next.agent = patch.brief.agent;
    if (patch.capabilities !== undefined) next.capabilities = patch.capabilities;
    if (patch.leftAt !== undefined) next.leftAt = patch.leftAt;
    if (patch.lastSeenAt !== undefined) next.lastSeenAt = patch.lastSeenAt;
    if (patch.lastReportAt !== undefined) next.lastReportAt = patch.lastReportAt;
    const members = s.members.includes(was) ? s.members.map((m) => (m === was ? next : m)) : [...s.members, next];
    // One put of every key, so the member's agent and the brief's row cannot disagree. A
    // stamp writes the member's row and not the record; a leave writes both.
    await putRows(this.ctx.storage, {
      ...memberRows(s, { ...s, members }),
      ...(patch.brief !== undefined ? { [briefKey(memberId)]: patch.brief } : {}),
    });
    // addMember's rule. `leftAt` can flip nextTickAt off null, and so can
    // `lastReportAt` (below): clearing `leftAt` returns a departed member to the
    // roster. Nothing calls it that way today — every caller sets a time — but
    // MemberPatch permits it, and the predicate is about what a write CAN do.
    //
    // Deliberately narrow, where the three above are unconditional: this is the
    // hot path. Every bellman_sync and every send stamps `lastSeenAt` through
    // here, and that one reaches nextTickAt not at all.
    //
    // `lastReportAt` reaches it too, since each member's deadline is its own report
    // plus the cadence, and for a member the room has stopped asking (`ASKS`, #208)
    // a fresh stamp brings a deadline back where there was none. No caller patches
    // it today; reports ride the append, which re-arms by `tickBroughtForward`. It
    // is not the hot path, so it re-arms unconditionally.
    if (patch.leftAt === null || patch.lastReportAt !== undefined) await this.driver.reArm();
  }

  async closeSession(): Promise<void> {
    let released = false;
    let events: SessionEvent[] = [];
    let members: readonly Member[] = [];
    await this.ctx.storage.transaction(async (txn) => {
      events = [];
      const s = await this.stored(txn);
      if (!s) return;
      members = s.members;
      // A hosted room's slot goes back with the close, in its transaction (I7).
      const intents = hostedReleaseIntents(s);
      released = intents.length > 0;
      const rows = released ? await this.driver.enqueue(txn, intents) : {};
      // `closedAt` once (#65): the window starts at the first close, and a second one
      // does not move it.
      const now = Date.now();
      // The room's open outside tasks end with it, in this transaction (A2A): a stranger is not left waiting on a closed room.
      const end = await this.#endOutside(txn, s, "closed", now);
      await putRows(txn, { ...memberRows(s, { ...end.session, closed: true, closedAt: s.closedAt ?? now }), ...rows });
      events = end.events;
    });
    for (const event of events) this.#wake(event, members);
    // The purge is due from the close, and the alarm may be pointing at an abandonment
    // time months off: nothing else re-arms it for a room with no code to retire and
    // no audit row to queue. See derivedDue().
    await this.driver.reArm();
    if (released) await this.driver.deliverNow();
  }

  /**
   * Close the room unless somebody is still in it, and say whether it is closed
   * when this returns: true when this call closed it or it already was.
   *
   * The check and the write are one transaction, and that is the point. A caller
   * that read the roster itself and then called closeSession would have handed a
   * join the gap between them, and so would a check and a write that merely follow
   * one another here, the day an await on something other than storage lands between
   * them (see stored()). seatMember's refusal of a closed room is the other half of
   * the same guarantee, as addMember's is: this keeps a close from landing on an
   * occupied room, those keep a join from landing on a closed one, and neither is
   * enough alone.
   *
   * Marks the room closed and nothing else. The join codes stay in the record
   * for the facade to retire, because it is the one holding the registry handle:
   * it clears them once this returns true, and the retry of a close that died in
   * between finds them still listed and finishes the job.
   */
  async closeSessionIfEmpty(): Promise<boolean> {
    let released = false;
    let events: SessionEvent[] = [];
    let members: readonly Member[] = [];
    const closed = await this.ctx.storage.transaction(async (txn) => {
      events = [];
      const s = await this.stored(txn);
      if (!s) return false;
      if (s.closed) return true;
      if (s.members.some(isActivePerson)) return false;
      members = s.members;
      // A hosted room's slot goes back with the close, in its transaction (I7).
      const intents = hostedReleaseIntents(s);
      released = intents.length > 0;
      const rows = released ? await this.driver.enqueue(txn, intents) : {};
      const now = Date.now();
      const end = await this.#endOutside(txn, s, "closed", now);
      await putRows(txn, { ...memberRows(s, { ...end.session, closed: true, closedAt: s.closedAt ?? now }), ...rows });
      events = end.events;
      return true;
    });
    for (const event of events) this.#wake(event, members);
    // After the commit, never inside the closure (see stored()), and for closeSession's reason.
    if (closed) await this.driver.reArm();
    if (released) await this.driver.deliverNow();
    return closed;
  }

  /**
   * The delete on demand (#65, D6): ask for this closed room to be purged at `at`.
   * Only the asking happens here, in the one transaction that queues the entries
   * recording who asked, since the record still exists to carry the outbox. The purge
   * is the alarm's, so a delete and a window that ran out are one code path
   * (`#purgeIfDue`) and no request holds the object open while a prefix is deleted.
   *
   * "open" for a room that has not closed, which a delete never closes, and "missing"
   * for one that is not there. A room already asked for answers with the time it is
   * stored with and writes nothing: the first request stands, and a client retrying a
   * delete it never heard the answer to files one `room_deleted` for each org, not two,
   * and is told the first request's `purgeAt` and not the `at` of the retry.
   *
   * The re-arm and the delivery are for that retry as much as for the first ask: a
   * process that died between the commit and them left an alarm only if there was an
   * entry to queue, and the retry is what points it at the purge.
   */
  async schedulePurge(at: number, by: AuditActor | null): Promise<PurgeSchedule> {
    const outcome = await this.ctx.storage.transaction(async (txn): Promise<PurgeSchedule> => {
      const s = await this.stored(txn);
      if (!s) return { ok: false, reason: "missing" };
      if (!s.closed) return { ok: false, reason: "open" };
      if (s.purgeAt !== null) return { ok: true, purgeAt: s.purgeAt };
      const now = Date.now();
      // Every org that sat in the room, those of members who have left included (ADR 0019), and for
      // the rows' parties the whole roster, which only the member rows still hold (`#everyone`).
      const parties = rosterParties({ members: await this.#everyone(txn) });
      const rows = await this.driver.enqueue(
        txn, s.orgs.map((orgId) => auditIntent(roomDeletedEntry(s, orgId, parties, by, now))),
      );
      await putRows(txn, { ...memberRows(s, { ...s, purgeAt: at }), ...rows });
      return { ok: true, purgeAt: at };
    });
    if (outcome.ok) {
      await this.driver.reArm();
      await this.driver.deliverNow();
    }
    return outcome;
  }

  /**
   * `BellmanStore.unpublishSession`, for this room. One transaction, so two requests cannot both
   * find the room public: the first time is the one kept. An empty object is left empty.
   *
   * The room's permanent codes go in the same transaction (ADR 0020), their registry drops queued
   * by the `enqueue` `clearJoinCodes` uses and delivered once it has committed.
   */
  async unpublishSession(at: number): Promise<void> {
    let events: SessionEvent[] = [];
    let members: readonly Member[] = [];
    const dropped = await this.ctx.storage.transaction(async (txn) => {
      events = [];
      const s = await this.stored(txn);
      if (!s || s.unpublishedAt != null) return false;
      members = s.members;
      const permanent = Object.entries(s.joinCodes).filter(([, rec]) => rec.expiresAt === null);
      const rows = await this.driver.enqueue(txn, permanent.map(([, rec]) => dropCodeIntent(rec.code)));
      const joinCodes = { ...s.joinCodes };
      for (const [role] of permanent) delete joinCodes[role];
      // A room that went private answers nobody, so what strangers are waiting on ends with it, in this transaction (A2A).
      const end = await this.#endOutside(txn, s, "unpublished", Date.now());
      await putRows(txn, { ...memberRows(s, { ...end.session, unpublishedAt: at, joinCodes }), ...rows });
      events = end.events;
      return permanent.length > 0;
    });
    for (const event of events) this.#wake(event, members);
    if (dropped) await this.driver.deliverNow();
  }

  /** `BellmanStore.setPublicName`, for this room (public names spec, D5). An empty object is left empty. */
  async setPublicName(name: string): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const s = await this.stored(txn);
      if (!s) return;
      await putRows(txn, memberRows(s, { ...s, publicName: name }));
    });
  }

  /** `BellmanStore.setPublicView`, for this room (room pages spec, D3). An empty object is left empty. */
  async setPublicView(view: PublicView): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const s = await this.stored(txn);
      if (!s) return;
      await putRows(txn, memberRows(s, { ...s, publicView: view }));
    });
  }

  /**
   * The close-time sweep (#65, D3), run now. `BellmanStore.sweepBlobs` is the contract and
   * this is SessionDO's answer to it; the alarm reaches the same work through #sweepIfDue,
   * which first asks whether it is owed. Public because the facade calls it, so anything
   * holding the SESSION binding can ask for a closed room's sweep, which is the work the
   * alarm does for every closed room anyway.
   *
   * An open room, whose unnamed object is an upload between its put and its charge or its
   * item, and a room that is not there, are left alone.
   */
  async sweepBlobs(): Promise<{ removed: number; credited: number }> {
    const s = await this.stored();
    if (!s || !s.closed) return { removed: 0, credited: 0 };
    return this.#sweep(s);
  }

  /**
   * Freeze the room, or thaw it with null.
   *
   * The reArm() is addMember's rule: a thaw is the write that flips `nextTickAt`
   * off null for a room whose cadence and roster were there all along, and without
   * it a thawed room never ticks again.
   *
   * On the freeze it arms nothing of the room's own: a frozen room derives neither
   * an abandonment time nor a tick (#18), and reArm() never clears an alarm. So a
   * freeze leaves the alarm pointed at whatever it already held, and the room wakes
   * once at that time, finds nothing due and arms nothing after it. The call is
   * unconditional all the same, for the reason the last paragraph gives.
   *
   * The thaw also credits every reporting seat with a report, so the interval
   * nobody was allowed to report in costs nobody their standing — spec D10, and
   * `clearSilence` carries the whole argument. The rule belongs to heartbeat.ts;
   * this picks the moment to apply it.
   *
   * The thaw also stamps every active member as seen now (#18): `touchMember`
   * refuses a frozen room, so the window did not move while it was frozen, and the
   * `reArm()` below would otherwise point at an abandonment time already past and
   * the next firing would close the room the thaw just gave back.
   *
   * **The moment is the TRANSITION, not the argument.** `frozenAt === null` alone
   * credits on a call that thawed nothing, because the room was already thawed —
   * handing every reporting seat a fresh stamp with nobody having reported. A
   * caller retrying this idempotent call on a schedule would reset every member's
   * clock for good: nobody ever due, no tick ever asking, `silent` never true, and
   * nothing in the log to say why. So the credit is paid only when the record as
   * read was frozen, which pays a freeze-then-thaw once however many thaws follow.
   *
   * The thaw also records the moment, `thawedAt` (#66, R9), which housekeeping floors
   * its clocks at: a finding computed across the freeze would name a condition the room
   * imposed. It rides the same put and needs the same transition, and the `reArm()`
   * below is what arms housekeeping's time for a room that has just come back.
   *
   * The reArm() stays unconditional, and the two are not the same question. It
   * costs one derived read and points the alarm where it already was, and it has to
   * run on the thaw that matters; the credit writes member state, so it needs the
   * transition.
   */
  async freezeSession(frozenAt: number | null): Promise<void> {
    // One transaction: a thaw writes a row for every member in the room as well as the
    // record (ADR 0019), more keys than one put takes, and they land together or not at all.
    await this.ctx.storage.transaction(async (txn) => {
      const s = await this.stored(txn);
      if (!s) return;
      const thawing = frozenAt === null && s.frozenAt !== null;
      const now = Date.now();
      const members = thawing ? stampSeen(clearSilence(s, now), now) : s.members;
      await putRows(txn, memberRows(s, { ...s, frozenAt, members, thawedAt: thawing ? now : s.thawedAt }));
    });
    await this.driver.reArm();
  }

  /**
   * Append an event, or null when the room is frozen.
   *
   * One transaction, for the reason stored() gives: the session read, the cursor read
   * and the write are one unit, so two appends take two cursors and neither event
   * overwrites the other. The wake comes after the commit, so nobody hears of an event
   * that did not land, and the wiring tests fail a wake that goes out before it.
   *
   * **`extras.creditReport` rides in that same put, and it has to.** The handler
   * used to stamp `lastReportAt` with an `updateMember` call AFTER this returned,
   * which is a second RPC into a second transaction — and `#wake` above fires
   * before it, so a due alarm could read the committed progress event while the
   * stale stamp still named that member silent. Folded in here the stamp and the
   * event commit together or not at all, and the wake still waits for both.
   *
   * **`extras.markRemoved` rides in that same put, for the same reason.** The
   * cut a member's feed is capped at has to commit with the event whose cursor
   * it names, or a reader can be refused at a cursor no stored event carries,
   * or admitted past one that is already written (#113).
   *
   * **The sockets of a member just cut close after the wake** (#113), through
   * `#closeCutSockets` and only for an append that carried `markRemoved`. After
   * the wake, so the member removed is sent the frame announcing it before the
   * socket goes and the notice is the last thing they receive.
   *
   * No `reArm()` as a rule: a credit to a member the room still asks only moves its
   * deadline LATER, and a removal only takes a member off the roster, which cannot
   * bring the soonest one forward either. An alarm already armed is then early — it
   * fires, finds nobody due, advances `lastTickAt`, and the closing `reArm()` points it
   * at the right time. One wake spent, and the tick it produces is correct.
   *
   * **The exception is a rule and not a list of event kinds (#66, I1; #208): an append
   * that brings housekeeping's soonest time or the next tick forward re-arms after its
   * commit.** The tick comes forward when a member the room had stopped asking (`ASKS`)
   * reports, since it armed nothing until then (`tickBroughtForward`).
   * `#writeEvent` compares that time for the record it wrote against the record this
   * transaction read (`bringsForward`), and a null before counts as later. An
   * `action_request` in a room that declares `answer_within` adds an anchor, the
   * request's time plus `answer_within`, that can fall before the time armed. So can a
   * send, or a response, that ends a raised finding: the member's new condition is due
   * at its own anchor (R8), which is before the old raise's window whenever
   * `repeat_after` is the longer, and a member event does the same to a raised
   * `room_idle`. A join re-arms in `addMember`. An append that moves the time later, or
   * not at all, asks for nothing, which is the ordinary send.
   */
  async appendEvent(
    e: Omit<SessionEvent, "cursor" | "at">,
    extras: AppendExtras = {},
  ): Promise<SessionEvent | null> {
    if (extras.surface !== undefined && isFrameWrite(extras.surface)) throw new Error(FRAME_WRITE_PATH);
    let broughtForward = false as boolean;
    let wakesHost = false;
    // The rows this transaction read, for the wake's read_context rule.
    let members: readonly Member[] = [];
    const event = await this.ctx.storage.transaction<SessionEvent | null>(async (txn) => {
      const s = await this.stored(txn);
      if (!s) throw new Error("Unknown session");
      if (s.frozenAt !== null) return null;
      members = s.members;
      // After the frozen check, so a room that refuses the write reads nothing; before the event is built, so
      // the event carries the placement the row takes.
      const placed = await placedAppend(txn, e, extras);
      const next: SessionEvent = { ...placed.e, cursor: await this.nextCursor(txn), at: Date.now() };
      const owed = await extraRows(txn, s, next, placed.extras);
      const wake = await this.#replyWakeRows(txn, s, next);
      wakesHost = Object.keys(wake).length > 0;
      broughtForward = await this.#writeEvent(txn, s, next, { ...owed.puts, ...wake }, owed.deletes);
      return next;
    });
    if (event) this.#wake(event, members);
    // After the wake, so the member removed receives the frame announcing it
    // before the socket goes. The notice is the last thing they get.
    if (event && extras.markRemoved !== undefined) await this.#closeCutSockets();
    // After the commit and the wake, as addMember's is: the append has landed, and
    // reArm() reads the record it landed in.
    if (event && broughtForward) await this.driver.reArm();
    // Last, so nobody woken above waits on the host's delivery.
    if (wakesHost) await this.driver.deliverNow();
    return event;
  }

  /**
   * The wake a reply to the hosted seat owes it (hosted seat spec, D4), as outbox rows
   * for the caller to fold into the event's own put: none unless the room has a host it
   * has not evicted (`hostSeated`, C1) and `event` is a message or progress event whose
   * `refId` names one of the host's events. The two public appends call it, which are
   * MemoryStore's places too.
   * `appendHostEvent` does not: the host's own answer names its question, and a seat
   * must not wake itself.
   *
   * `#private` for the reason every writing method on this class is: it queues a row
   * this object then delivers.
   */
  async #replyWakeRows(
    txn: DurableObjectTransaction,
    s: StoredSession,
    event: SessionEvent,
  ): Promise<Record<string, unknown>> {
    if (s.manifest.host === null || !hostSeated(s) || event.refId === null) return {};
    const referenced = await txn.get<SessionEvent>(eventKey(Number(event.refId)));
    if (!isReplyToHost(event, referenced)) return {};
    return this.driver.enqueue(txn, [hostWakeIntent(s.id, "reply", event.cursor)]);
  }

  /**
   * The hosted seat's one write (hosted seat spec, D3): the event, the charge of
   * `units` against the room's month, the host's `lastSeenAt` stamp, the send's audit
   * row (C1) and the record of `key` (M6), in one transaction. `decideHostCharge`
   * decides, the call MemoryStore makes, so a refusal writes nothing in either store. A
   * key already used returns the event it wrote and charges nothing, for
   * `appendEventOnce`'s reason. A missing row is `not_found`. It queues no wake.
   */
  async appendHostEvent(
    e: Omit<SessionEvent, "cursor" | "at">,
    units: number,
    now: number,
    key: string,
  ): Promise<HostAppend> {
    let appended = false;
    let audited = false;
    const result = await this.ctx.storage.transaction<HostAppend>(async (txn) => {
      const s = await this.stored(txn);
      if (!s) return { ok: false, reason: "not_found", used: 0, allowed: 0 };
      const storageKey = idempotencyKey(e.fromMemberId, key);
      const done = await txn.get<IdempotencyRecord>(storageKey);
      if (done) {
        const original = await txn.get<SessionEvent>(eventKey(done.cursor));
        if (!original) throw new Error(`Idempotency record names missing cursor ${done.cursor}`);
        return { ok: true, event: original };
      }
      const charge = decideHostCharge(s, units, now);
      if (!charge.ok) return charge;
      const event: SessionEvent = { ...e, cursor: await this.nextCursor(txn), at: Date.now() };
      const stamped = s.members.map((m) => m.memberId === e.fromMemberId ? { ...m, lastSeenAt: now } : m);
      const intents = hostSentEntries(s, e, now).map(auditIntent);
      audited = intents.length > 0;
      const rows = audited ? await this.driver.enqueue(txn, intents) : {};
      const record: IdempotencyRecord = { cursor: event.cursor, print: fingerprint(e) };
      // `session` is the base the books merge into (see #writeEvent), so the charge and the
      // stamp are kept: this write runs the books like every other (#66).
      await this.#writeEvent(txn, s, event, { session: { ...s, hostUnits: charge.next, members: stamped }, [storageKey]: record, ...rows });
      appended = true;
      return { ok: true, event };
    });
    if (result.ok && appended) this.#wake(result.event);
    if (appended && audited) await this.driver.deliverNow();
    return result;
  }

  /**
   * Append the event unless this key has been used: the same key and content replays the
   * first event, and the same key with different content is a conflict.
   *
   * One transaction, for the reason stored() gives: the key check, the cursor read and
   * the write of the event, the cursor and the key's record are one unit. Two calls
   * with the same key therefore resolve as one append and one replay, two with
   * different keys take two cursors and neither event overwrites the other, and an
   * interruption leaves all three rows or none. On workerd's local test pool the plain
   * shape handed two concurrent calls the same cursor in about 1% of rounds, both
   * reporting `appended` (#120); the transaction is what makes the contract case for it
   * reliable there. The wake comes after the commit, so nobody hears of an event that
   * did not land.
   *
   * An append that brings housekeeping's soonest time or the next tick forward re-arms after
   * the commit, as `appendEvent`'s docblock says, when it is appended. A replay appended
   * nothing and re-runs no books, so it brings housekeeping nothing; it re-arms only when the
   * credit it re-asserts brings the next tick forward (#208), as the report's own would have.
   */
  async appendEventOnce(
    e: Omit<SessionEvent, "cursor" | "at">,
    key: string,
    extras: AppendExtras = {},
  ): Promise<EventWrite> {
    if (extras.surface !== undefined && isFrameWrite(extras.surface)) throw new Error(FRAME_WRITE_PATH);
    let broughtForward = false as boolean;
    let wakesHost = false;
    // The rows this transaction read, for the wake's read_context rule, as in appendEvent.
    let members: readonly Member[] = [];
    const result = await this.ctx.storage.transaction<EventWrite>(async (txn) => {
      const s = await this.stored(txn);
      if (!s) throw new Error("Unknown session");
      members = s.members;

      const storageKey = idempotencyKey(e.fromMemberId, key);
      const record = await txn.get<IdempotencyRecord>(storageKey);
      const print = fingerprint(e);

      if (record) {
        if (record.print !== print) return { outcome: "conflict" };
        const original = await txn.get<SessionEvent>(eventKey(record.cursor));
        // A key naming a cursor with no event is a storage bug, not a replay.
        if (!original) {
          throw new Error(`Idempotency record names missing cursor ${record.cursor}`);
        }
        // The replay re-asserts the member extras (`creditReport`, `markRemoved`
        // and `stampActionRequest`), in this transaction, and applies no surface
        // write. A retry cannot know whether the first attempt landed a member
        // write, and skipping it here is what made a stamp the first attempt never
        // wrote permanent rather than late. `creditReport` and `stampActionRequest`
        // are monotonic and `markRemoved` leaves a recorded cut where it is, so
        // this is a repair or a no-op and never a regression — and it writes
        // nothing at all when there is nothing to repair, which is why the put is
        // guarded on the row being empty. `original` and not `e`, because
        // `markRemoved` records the cut at the cursor the key names and `e` has
        // none.
        //
        // The surface write is the exception, so `extraRows` is handed the extras
        // without it. The row committed with the event in one transaction, so
        // there is nothing to repair, and whatever has happened to the key since
        // carries a higher cursor. A removal leaves no tombstone, so re-applying
        // the original write would read no row to compare against and could only
        // put back what was removed. It also means a replay deletes nothing.
        const repair = (await extraRows(txn, s, original, { ...extras, surface: undefined })).puts;
        const owed = asRows(s, repair);
        if (Object.keys(owed).length > 0) await putRows(txn, owed);
        // A stamp repaired here is the report's, late, and brings the next tick forward as the
        // first attempt's would have (#208). Only the tick: the books are not re-run on a replay.
        broughtForward = repair.session !== undefined && tickBroughtForward(s, repair.session as StoredSession);
        return { outcome: "replayed", event: original };
      }

      if (s.frozenAt !== null) return { outcome: "frozen" };

      // After the replay branch and the frozen check, so neither reads the surface, and with `print` already
      // taken from the draft as the caller sent it: a retry reads as a retry however the room has changed.
      const placed = await placedAppend(txn, e, extras);
      const event: SessionEvent = { ...placed.e, cursor: await this.nextCursor(txn), at: Date.now() };
      // The key row joins the event and the cursor in one put, for the reason
      // writeEvent gives carried one step further: committed separately, an
      // interruption leaves the event stored with no key naming it, and the
      // retry that follows appends the duplicate this method exists to prevent.
      const stored: IdempotencyRecord = { cursor: event.cursor, print };
      const owed = await extraRows(txn, s, event, placed.extras);
      // Appended only: a replay's wake went out with the first attempt's event.
      const wake = await this.#replyWakeRows(txn, s, event);
      wakesHost = Object.keys(wake).length > 0;
      broughtForward = await this.#writeEvent(txn, s, event, { [storageKey]: stored, ...owed.puts, ...wake }, owed.deletes);
      return { outcome: "appended", event };
    });
    if (result.outcome === "appended") this.#wake(result.event, members);
    // The sockets follow the cut down this path as they do down appendEvent's:
    // the contract hands both the same extras, so a cut that held here and left
    // the socket open would be the open feed by another route. A replay counts
    // too, because it can be the call that writes the cut (see the replay branch
    // above). "frozen" and "conflict" wrote nothing, so there is nothing to follow.
    if (
      extras.markRemoved !== undefined &&
      (result.outcome === "appended" || result.outcome === "replayed")
    ) {
      await this.#closeCutSockets();
    }
    if (broughtForward) await this.driver.reArm();
    // Last, as in appendEvent: nobody woken above waits on the host's delivery.
    if (wakesHost) await this.driver.deliverNow();
    return result;
  }

  /**
   * `BellmanStore.appendSurface` (surface frames spec, D2), in `approveProposal`'s shape: one transaction; the key
   * before the frozen check; the room's `sf:` rows listed and the write placed among them by `placeSurfaceWrite`;
   * a refusal returned before anything is written, the key's record included; then the write's event and each
   * carried card's at the cursors after it, the books and `extraRows` folded over them in cursor order, and one
   * `putRows` with the key's record. One wake comes after the commit, holding the write's event and every carried
   * card's in cursor order, and the alarm is re-armed when the books brought a due time forward. A `surface` event is never a reply to the host
   * (`isReplyToHost` reads a message or a progress event), so no wake row is queued.
   */
  async appendSurface(
    e: EventBody,
    extras: { surface: SurfaceWrite; approvedBy?: ApprovedBy },
    key: string | null,
  ): Promise<SurfaceAppend> {
    let broughtForward = false as boolean;
    // The rows this transaction read, for the wake's read_context rule, as in appendEvent.
    let members: readonly Member[] = [];
    const result = await this.ctx.storage.transaction<SurfaceAppend>(async (txn) => {
      // Assigned again if the runtime runs this closure again, as in approveProposal.
      broughtForward = false;
      const s = await this.stored(txn);
      if (!s) throw new Error("Unknown session");
      members = s.members;

      const keyed = key === null ? null : { storageKey: idempotencyKey(e.fromMemberId, key), print: surfacePrint(e, extras.surface) };
      if (keyed !== null) {
        const record = await txn.get<IdempotencyRecord>(keyed.storageKey);
        if (record) {
          if (record.print !== keyed.print) return { outcome: "conflict" };
          const original = await txn.get<SessionEvent>(eventKey(record.cursor));
          if (!original) throw new Error(`Idempotency record names missing cursor ${record.cursor}`);
          return { outcome: "replayed", event: original };
        }
      }
      if (s.frozenAt !== null) return { outcome: "frozen" };

      const { rows, placed } = await placedInRows(txn, extras.surface);
      if (!placed.ok) return { outcome: "refused", kind: placed.kind, reason: placed.reason };
      const at = Date.now();
      const out = await placedSurfaceRows(
        txn, s, [], placedEvent(e, extras.surface, placed), placed, extras.approvedBy, rows, await this.nextCursor(txn), at,
      );
      await putRows(txn, {
        ...Object.fromEntries(out.events.map((ev) => [eventKey(ev.cursor), ev])),
        cursor: out.events[out.events.length - 1].cursor,
        ...(keyed === null ? {} : { [keyed.storageKey]: { cursor: out.event.cursor, print: keyed.print } satisfies IdempotencyRecord }),
        ...asRows(s, { ...out.puts, session: out.session === s ? undefined : out.session }),
      });
      for (const gone of out.deletes) await txn.delete(gone);
      broughtForward = out.session !== s && (bringsForward(s, out.session, at) || tickBroughtForward(s, out.session));
      return { outcome: "appended", event: out.event, carried: out.carried };
    });
    if (result.outcome === "appended") {
      // One wake for the write and every card it carried, so a long poll is handed them all at once.
      this.#wake([result.event, ...result.carried], members);
      if (broughtForward) await this.driver.reArm();
    }
    return result;
  }

  /**
   * `BellmanStore.appendSurfaces` (surface widget and batch spec, D1), in `appendSurface`'s shape: one transaction;
   * the key before the frozen check; the room's `sf:` rows listed once when any write is placed among them, and the
   * batch placed in memory by `placeSurfaceBatch`, so a refusal returns before anything is written. Then each entry
   * through `placedSurfaceRows` in order, with the session threaded from one to the next and its events and rows put
   * before the next runs, so `extraRows`' reads see the rows the earlier entries wrote. The cursor, the key's record
   * and the record go in one last put. One wake after the commit holds every event, in cursor order.
   */
  async appendSurfaces(author: SurfaceAuthor, writes: readonly SurfaceWrite[], key: string | null): Promise<SurfaceBatchAppend> {
    let broughtForward = false as boolean;
    let members: readonly Member[] = [];
    const result = await this.ctx.storage.transaction<SurfaceBatchAppend>(async (txn) => {
      broughtForward = false;
      const s = await this.stored(txn);
      if (!s) throw new Error("Unknown session");
      members = s.members;

      const keyed = key === null ? null : { storageKey: idempotencyKey(author.fromMemberId, key), print: surfaceBatchPrint(author, writes) };
      if (keyed !== null) {
        const record = await txn.get<IdempotencyRecord>(keyed.storageKey);
        if (record) {
          if (record.print !== keyed.print) return { outcome: "conflict" };
          const original = await txn.get<SessionEvent>(eventKey(record.cursor));
          if (!original) throw new Error(`Idempotency record names missing cursor ${record.cursor}`);
          return { outcome: "replayed", event: original };
        }
      }
      if (s.frozenAt !== null) return { outcome: "frozen" };

      const at = Date.now();
      const first = await this.nextCursor(txn);
      const rows = writes.some(placesAmongRows) ? [...(await txn.list<SurfaceRow>({ prefix: SURFACE_PREFIX })).values()] : [];
      const placed = placeSurfaceBatch(rows, writes, author, first, at);
      if (!placed.ok) return { outcome: "refused", index: placed.index, kind: placed.kind, reason: placed.reason };

      let session = s;
      const events: SessionEvent[] = [];
      for (const [i, { placed: one, moved }] of placed.entries.entries()) {
        const out = await placedSurfaceRows(
          txn, session, [], placedEvent(batchEvent(author, writes[i]), writes[i], one), one, undefined,
          new Map(moved.map((r) => [r.key, r] as const)), first + events.length, at,
        );
        await putRows(txn, { ...Object.fromEntries(out.events.map((ev) => [eventKey(ev.cursor), ev])), ...out.puts });
        for (const gone of out.deletes) await txn.delete(gone);
        session = out.session;
        events.push(...out.events);
      }
      const last = events[events.length - 1].cursor;
      await putRows(txn, {
        cursor: last,
        ...(keyed === null ? {} : { [keyed.storageKey]: { cursor: last, print: keyed.print } satisfies IdempotencyRecord }),
        ...asRows(s, { session: session === s ? undefined : session }),
      });
      broughtForward = session !== s && (bringsForward(s, session, at) || tickBroughtForward(s, session));
      return { outcome: "appended", events };
    });
    if (result.outcome === "appended") {
      this.#wake(result.events, members);
      if (broughtForward) await this.driver.reArm();
    }
    return result;
  }

  /** `BellmanStore.idempotencyRecord`: one `get`, with no transaction, because it reads one row and writes nothing. */
  async idempotencyRecord(memberId: string, key: string): Promise<IdempotencyRecord | null> {
    return (await this.ctx.storage.get<IdempotencyRecord>(idempotencyKey(memberId, key))) ?? null;
  }

  /**
   * `BellmanStore.approveProposal` (topic rooms spec, D2; plan R12): a maintainer's response and, when
   * `decideApproval` says apply, the proposer's card and its row, in one transaction.
   *
   * The order inside it is the rule: the key (a retry returns its response and re-checks nothing, R21), then
   * frozen, then the reads (the request, the key's row, the log past `base`), then `decideApproval`, then the
   * write. A refusal returns before anything is written, so it leaves no record of the key either.
   *
   * **One `putRows`, and the books folded over both events.** The response, the card, the cursor, the key's
   * record and the row go in one put, as `removeMember`'s several events do, and not through two `#writeEvent`
   * calls: the second would run housekeeping's books (#66) on a record that does not hold the first's. The books
   * are folded over the record event by event and the result is written once.
   *
   * One wake comes after the commit, holding every event in cursor order, and only for an approval that appended.
   * Neither event is a reply to the host (`isReplyToHost` reads a message or a progress event), so no wake row is
   * queued as `appendEvent` may queue one. The alarm is re-armed when the books brought a due time forward, which
   * is `#writeEvent`'s rule.
   *
   * ponytail: one list of the log from `base` per approval, which bounds the cost at the events since the proposer
   * read. The upgrade is an `answered` marker beside the request, read in place of the list.
   */
  async approveProposal(e: EventBody, key: string | null, approval: ProposalApproval): Promise<ApprovalWrite> {
    let broughtForward = false as boolean;
    // The rows this transaction read, for the wake's read_context rule, as in appendEvent.
    let members: readonly Member[] = [];
    const result = await this.ctx.storage.transaction<ApprovalWrite>(async (txn) => {
      // Assigned again if the runtime runs this closure again, so a first attempt's answer cannot outlive it.
      broughtForward = false;
      const s = await this.stored(txn);
      if (!s) throw new Error("Unknown session");
      members = s.members;

      const keyed = key === null ? null : { storageKey: idempotencyKey(e.fromMemberId, key), print: fingerprint(e) };
      if (keyed !== null) {
        const record = await txn.get<IdempotencyRecord>(keyed.storageKey);
        if (record) {
          if (record.print !== keyed.print) return { outcome: "conflict" };
          const original = await txn.get<SessionEvent>(eventKey(record.cursor));
          if (!original) throw new Error(`Idempotency record names missing cursor ${record.cursor}`);
          // The card by the cursor the record names; a record without one wrote none.
          let written: SessionEvent | null = null;
          if (record.applied !== undefined) {
            const card = await txn.get<SessionEvent>(eventKey(record.applied));
            if (!card) throw new Error(`Idempotency record names missing card cursor ${record.applied}`);
            written = card;
          }
          return { outcome: "replayed", event: original, written };
        }
      }
      if (s.frozenAt !== null) return { outcome: "frozen" };

      const request = await txn.get<SessionEvent>(eventKey(approval.requestCursor));
      if (request === undefined || request.type !== "action_request") {
        throw new Error(`Approval names cursor ${approval.requestCursor}, which holds no action_request`);
      }
      const write = approval.write;
      const row = write === null ? undefined : await txn.get<SurfaceRow>(surfaceKey(write.key));
      const after = [...(await txn.list<SessionEvent>({ prefix: "e:", start: eventKey(approval.base + 1) })).values()];
      const decided = decideApproval({
        room: s, approverId: e.fromMemberId, requestCursor: approval.requestCursor, base: approval.base, write, row, after,
      });
      if (decided.kind === "answered") return { outcome: "answered", by: decided.by };
      if (decided.kind === "stale") return { outcome: "stale", cursor: decided.cursor };

      // Placed among the frames before anything is numbered, so a refusal writes neither event.
      const applying = decided.kind === "apply" && write !== null ? write : null;
      const { rows, placed } = applying === null ? { rows: new Map<string, SurfaceRow>(), placed: null } : await placedInRows(txn, applying);
      if (placed !== null && !placed.ok) return { outcome: "refused", kind: placed.kind, reason: placed.reason };

      const at = Date.now();
      const response: SessionEvent = { ...e, cursor: await this.nextCursor(txn), at };
      let card: SessionEvent | null = null;
      let carried: SessionEvent[] = [];
      let events = [response];
      // The books (#66) for each event, folded over the record in cursor order, as `removeMember` folds them; with a
      // card, `placedSurfaceRows` folds them over the response and every surface event.
      const books = noteAppend(s, response);
      let kept: StoredSession = books === s ? s : { ...s, ...books };
      let owed = { puts: {} as Record<string, unknown>, deletes: [] as string[] };
      if (decided.kind === "apply" && applying !== null && placed !== null) {
        // The proposer's, as a surface event's author is its row's author everywhere (R18), with no `refId`: nothing
        // reads one off a `surface` event, and the response and the card are adjacent (R30).
        const draft: EventBody = {
          type: "surface", fromMemberId: request.fromMemberId, fromUserId: request.fromUserId, fromLabel: request.fromLabel,
          payload: applying.item ?? { key: applying.key, remove: true }, refId: null,
        };
        // Surface placement's step, before the card is numbered: an item the proposer left unplaced takes the next
        // free slot, and the event carries the placement the row will (R19); a locked move's cards follow it.
        const out = await placedSurfaceRows(
          txn, s, [response], placedEvent(draft, applying, placed), placed, decided.approvedBy, rows, response.cursor + 1, at,
        );
        ({ event: card, carried, events, session: kept } = out);
        owed = out;
      }
      await putRows(txn, {
        ...Object.fromEntries(events.map((ev) => [eventKey(ev.cursor), ev])),
        cursor: events[events.length - 1].cursor,
        ...(keyed === null ? {} : {
          [keyed.storageKey]: {
            cursor: response.cursor, print: keyed.print, ...(card === null ? {} : { applied: card.cursor }),
          } satisfies IdempotencyRecord,
        }),
        ...asRows(s, { ...owed.puts, session: kept === s ? undefined : kept }),
      });
      for (const gone of owed.deletes) await txn.delete(gone);
      broughtForward = kept !== s && (bringsForward(s, kept, at) || tickBroughtForward(s, kept));
      return { outcome: "appended", event: response, written: card, carried };
    });
    if (result.outcome === "appended") {
      this.#wake([result.event, ...(result.written === null ? [] : [result.written]), ...result.carried], members);
      // After the wake, as appendEvent does it: reArm() reads the record the approval landed in.
      if (broughtForward) await this.driver.reArm();
    }
    return result;
  }

  /**
   * A decision write's key (ADR 0040), read in its transaction: the replay or the conflict when `key` was used, else
   * the key's row to put beside the event once it has its cursor. A retry re-checks nothing, as approveProposal's.
   */
  async #decisionKey(
    txn: DurableObjectTransaction,
    e: EventBody,
    key: string | null,
  ): Promise<
    | { done: { outcome: "replayed"; event: SessionEvent } | { outcome: "conflict" }; recorded: SessionEvent | undefined }
    | { done: null; record: (cursor: number) => Record<string, unknown>; storageKey: string | null }
  > {
    if (key === null) return { done: null, record: () => ({}), storageKey: null };
    const storageKey = idempotencyKey(e.fromMemberId, key);
    const print = fingerprint(e);
    const found = await txn.get<IdempotencyRecord>(storageKey);
    if (found) {
      const original = await txn.get<SessionEvent>(eventKey(found.cursor));
      if (found.print !== print) return { done: { outcome: "conflict" }, recorded: original };
      if (!original) throw new Error(`Idempotency record names missing cursor ${found.cursor}`);
      return { done: { outcome: "replayed", event: original }, recorded: original };
    }
    return { done: null, record: (cursor) => ({ [storageKey]: { cursor, print } satisfies IdempotencyRecord }), storageKey };
  }

  /** The ballot rows of `decisions`, each by account (secret ballot spec). Only an open secret ballot has any. */
  async #ballotRows(
    from: DurableObjectTransaction | DurableObjectStorage, decisions: readonly number[],
  ): Promise<Map<number, Map<string, BallotRow>>> {
    const out = new Map<number, Map<string, BallotRow>>();
    for (const d of new Set(decisions)) {
      const listed = await from.list<BallotRow>({ prefix: ballotPrefix(d) });
      if (listed.size > 0) out.set(d, new Map([...listed].map(([k, row]) => [k.slice(ballotPrefix(d).length), row])));
    }
    return out;
  }

  /**
   * Last in a write that closes, after its put: each closed secret ballot's rows and the idempotency records its votes
   * used, so nothing the put wrote comes back. Answers what it deleted, for the line logged once the write commits.
   */
  async #eraseClosed(
    txn: DurableObjectTransaction, events: readonly SessionEvent[], views: ReadonlyMap<number, DecisionView>,
  ): Promise<{ decision: number; rows: number; keys: number }[]> {
    const erased: { decision: number; rows: number; keys: number }[] = [];
    for (const e of events) {
      if (e.type !== "decision_closed") continue;
      const decision = (e.payload as { decision: number }).decision;
      const v = views.get(decision);
      if (v === undefined || !isSecret(v.payload)) continue;
      const rows = await txn.list<BallotRow>({ prefix: ballotPrefix(decision) });
      const keys = [...rows.values()].flatMap((row) => row.iks);
      // At most KEYS_PER_CALL keys a delete, as putRows writes: a 5,000-seat ballot holds far more than one call takes.
      const doomed = [...rows.keys(), ...keys];
      for (let i = 0; i < doomed.length; i += KEYS_PER_CALL) await txn.delete(doomed.slice(i, i + KEYS_PER_CALL));
      erased.push({ decision, rows: rows.size, keys: keys.length });
    }
    return erased;
  }

  /** The rows a secret ballot's close is filed under: the system, for every party the room has had, never a voter. */
  async #secretTemplate(txn: DurableObjectTransaction, s: StoredSession, at: number): Promise<AuditEntry[]> {
    return auditRows(
      rosterParties({ members: await this.#everyone(txn) }),
      { at, sessionId: s.id, action: "decision_closed", roomName: s.manifest.room, detail: {} }, SYSTEM_ACTOR,
    );
  }

  /**
   * The log from `cursor` on: everything a decision opened there can be read from.
   *
   * ponytail: one list of the log since the decision opened, at most its seven days, as approveProposal lists the
   * log since `base`. The reads go through #411's index instead; a write would need that index kept by appends.
   */
  async #logFrom(from: DurableObjectTransaction | DurableObjectStorage, cursor: number): Promise<SessionEvent[]> {
    return [...(await from.list<SessionEvent>({ prefix: "e:", start: eventKey(cursor) })).values()];
  }

  /**
   * A decision write's events in one put, with the key's row, the books (#66) folded over them in cursor order as
   * approveProposal folds them, the open decisions (`noteDecisions`), and the org's rows for them (`decisionAudit`,
   * from `audit` and `log`, the log read before them). Answers whether the books brought a due time forward, as
   * `#writeEvent` does, and whether rows were queued for delivery.
   */
  async #writeDecision(
    txn: DurableObjectTransaction,
    s: StoredSession,
    events: readonly SessionEvent[],
    record: Record<string, unknown>,
    audit: readonly AuditEntry[],
    log: readonly SessionEvent[],
    ballots: BallotBook = new Map(),
  ): Promise<{ forward: boolean; queued: boolean; erased: { decision: number; rows: number; keys: number }[] }> {
    let kept: StoredSession = s;
    for (const ev of events) {
      const books = noteAppend(kept, ev);
      if (books !== kept) kept = { ...kept, ...books };
    }
    const forward = kept !== s && (bringsForward(s, kept, events[0].at) || tickBroughtForward(s, kept));
    const book = noteDecisions(s.openDecisions ?? {}, events);
    if (book !== (s.openDecisions ?? {})) kept = { ...kept, openDecisions: book };
    // A decision that ends sooner than the armed alarm moves it, or that decision closes late.
    const soonest = earliestDeadline(book);
    const before = earliestDeadline(s.openDecisions ?? {});
    const sooner = soonest !== null && (before === null || soonest < before);
    const views = decisionsOf([...log, ...events], events[0].at, ballots);
    const secretClose = events.some((ev) => ev.type === "decision_closed" && isSecret(views.get((ev.payload as { decision: number }).decision)?.payload ?? { rule: "" }));
    const secretTemplate = secretClose ? await this.#secretTemplate(txn, s, events[0].at) : [];
    const rows = decisionAudit(audit, events, views, secretTemplate).filter((e) => e.orgId);
    await putRows(txn, {
      ...Object.fromEntries(events.map((ev) => [eventKey(ev.cursor), ev])),
      cursor: events[events.length - 1].cursor,
      ...record,
      ...asRows(s, { session: kept === s ? undefined : kept }),
      ...(rows.length > 0 ? await this.driver.enqueue(txn, rows.map(auditIntent)) : {}),
    });
    const erased = await this.#eraseClosed(txn, events, views);
    return { forward: forward || sooner, queued: rows.length > 0, erased };
  }

  /** The wake, the delivery and the re-arm a decision write owes once it has committed, as approveProposal's. */
  async #afterDecision(
    events: readonly SessionEvent[], members: readonly Member[],
    after: { forward: boolean; queued: boolean; erased?: { decision: number; rows: number; keys: number }[] },
  ): Promise<void> {
    // The one line a secret close logs: what it deleted, never a seat or a choice (secret ballot spec, Logging rule).
    for (const e of after.erased ?? []) {
      const closed = events.find((ev) => ev.type === "decision_closed" && (ev.payload as { decision: number }).decision === e.decision);
      console.log(`secret ballot closed: room ${this.ctx.id.name ?? this.ctx.id.toString()} decision ${e.decision} tally ${JSON.stringify((closed?.payload as { tally?: unknown })?.tally)} rows ${e.rows} keys ${e.keys}`);
    }
    this.#wake(events, members);
    if (after.queued) await this.driver.deliverNow();
    if (after.forward) await this.driver.reArm();
  }

  /** `BellmanStore.openDecision`: the snapshot, the hash and the append in one transaction, and a supersession's close after it. */
  async openDecision(e: EventBody, key: string | null, audit: readonly AuditEntry[] = []): Promise<DecisionOpen> {
    let after: { forward: boolean; queued: boolean; erased?: { decision: number; rows: number; keys: number }[] } = { forward: false, queued: false };
    let members: readonly Member[] = [];
    let written: SessionEvent[] = [];
    const result = await this.ctx.storage.transaction<DecisionOpen>(async (txn) => {
      // Assigned again if the runtime runs this closure again, so a first attempt's answer cannot outlive it.
      after = { forward: false, queued: false };
      const s = await this.stored(txn);
      if (!s) throw new Error("Unknown session");
      members = s.members;
      const k = await this.#decisionKey(txn, e, key);
      if (k.done !== null) return k.done;
      if (s.frozenAt !== null) return { outcome: "frozen" };
      const draft = e.payload as DecisionDraft;
      const at = Date.now();
      const book = s.openDecisions ?? {};
      const quota = decideOpenQuota(book, e.fromMemberId, at, draft.supersedes);
      if (quota.kind === "quota") return { outcome: "quota", scope: quota.scope, limit: quota.limit };
      // One list of the log, from the oldest decision this open reads: the one it supersedes and the ones past due.
      const due = dueToExpire(book, at);
      const reads = draft.supersedes === undefined ? due : [...due, draft.supersedes];
      const log = reads.length === 0 ? [] : await this.#logFrom(txn, Math.min(...reads));
      const ballots = bookOf(await this.#ballotRows(txn, reads));
      const views = decisionsOf(log, at, ballots);
      const old = draft.supersedes === undefined ? undefined : views.get(draft.supersedes);
      if (draft.supersedes !== undefined) {
        const d = decideSupersede(old);
        if (d.kind === "not_open") return { outcome: "not_open", state: d.state };
      }
      const payload = openedPayload(draft, at, isTopicRoom(s.manifest), electorateOf(s.manifest, s.members, draft.effect.kind));
      const event: SessionEvent = { ...e, payload, cursor: await this.nextCursor(txn), at };
      const superseded: SessionEvent | null = old === undefined
        ? null
        : { ...closingEvent(old, { state: "failed", reason: "superseded" }), cursor: event.cursor + 1, at };
      const expired: SessionEvent[] = due.flatMap((c, i) => {
        const v = views.get(c);
        return v === undefined ? [] : [{ ...closingEvent(v, { state: "expired" }), cursor: event.cursor + (superseded ? 2 : 1) + i, at }];
      });
      written = [event, ...(superseded === null ? [] : [superseded]), ...expired];
      after = await this.#writeDecision(txn, s, written, k.record(event.cursor), audit, log, ballots);
      return { outcome: "appended", event, superseded };
    });
    if (result.outcome === "appended") await this.#afterDecision(written, members, after);
    return result;
  }

  /** `BellmanStore.castVote`: `applyVote` decides from the decision read in the transaction that writes the vote. */
  async castVote(e: EventBody, key: string | null, audit: readonly AuditEntry[] = []): Promise<VoteWrite> {
    let after: { forward: boolean; queued: boolean; erased?: { decision: number; rows: number; keys: number }[] } = { forward: false, queued: false };
    let members: readonly Member[] = [];
    const result = await this.ctx.storage.transaction<VoteWrite>(async (txn) => {
      after = { forward: false, queued: false };
      const s = await this.stored(txn);
      if (!s) throw new Error("Unknown session");
      members = s.members;
      const input = e.payload as VoteInput;
      const opening = await txn.get<SessionEvent>(eventKey(input.decision));
      const secret = opening?.type === "decision_opened" && isSecret(opening.payload as DecisionOpened);
      const k = await this.#decisionKey(txn, e, key);
      if (k.done !== null) {
        // A secret ballot gives one answer to any retry of a key its own vote used, so the retry tells nothing apart.
        if (secret && (k.recorded?.payload as { decision?: number } | undefined)?.decision === input.decision) return { outcome: "recorded" };
        return k.done;
      }
      if (s.frozenAt !== null) return { outcome: "frozen" };
      const at = Date.now();
      const log = await this.#logFrom(txn, input.decision);
      const rows = await this.#ballotRows(txn, [input.decision]);
      const view = decisionsOf(log, at, bookOf(rows)).get(input.decision);
      if (view === undefined) return { outcome: "unknown" };
      const vote: DecisionVote = { ...input, capacity: capacityOfVote(input) };
      const account = view.payload.accounts[e.fromMemberId];
      const row = account === undefined ? undefined : rows.get(view.cursor)?.get(account);
      const d = applyVote(view, { memberId: e.fromMemberId, userId: e.fromUserId }, vote, row?.n ?? 0);
      if (d.kind !== "record") return voteRefusal(d);
      // A secret vote is logged as the system with no choice; the choice goes into the account's ballot row.
      const cursor = await this.nextCursor(txn);
      const event: SessionEvent = secret
        ? {
          ...e, fromMemberId: "system", fromUserId: "system", fromLabel: "bellman", cursor, at,
          payload: {
            decision: input.decision, hash: input.hash, via: input.via, human_approved: input.human_approved, capacity: vote.capacity, ballot: "secret",
          } satisfies SecretVote,
        }
        : { ...e, payload: vote, cursor, at };
      const newRow: BallotRow | null = secret
        ? { choice: vote.choice, n: (row?.n ?? 0) + 1, iks: k.storageKey === null ? row?.iks ?? [] : [...(row?.iks ?? []), k.storageKey] }
        : null;
      const ballots = newRow === null ? bookOf(rows) : bookOf(new Map([[view.cursor, new Map([...(rows.get(view.cursor) ?? []), [account!, newRow]])]]));
      // The close carries the tally with this vote counted in it.
      const closed: SessionEvent | null = d.close === null
        ? null
        : { ...closingEvent(decisionsOf([...log, event], at, ballots).get(view.cursor)!, d.close), cursor: event.cursor + 1, at };
      const record = { ...k.record(event.cursor), ...(newRow === null ? {} : { [ballotKey(view.cursor, account!)]: newRow }) };
      after = await this.#writeDecision(txn, s, closed === null ? [event] : [event, closed], record, audit, log, ballots);
      return { outcome: "appended", event, closed };
    });
    if (result.outcome === "appended") {
      await this.#afterDecision(result.closed === null ? [result.event] : [result.event, result.closed], members, after);
    }
    return result;
  }

  /**
   * Every decision past its deadline closed `expired`, each through `closeDecision`, written as the system: the
   * room's alarm, and not the next decision to open, is what closes one (secret ballot spec, Change 1). Nothing is
   * written when none is due. `#private`, for the reason #purgeIfDue gives.
   */
  async #expireDecisionsIfDue(now: number): Promise<void> {
    const s = await this.stored();
    if (!s) return;
    const due = dueToExpire(s.openDecisions ?? {}, now);
    if (due.length === 0) return;
    const parties = rosterParties({ members: await this.#everyone() });
    for (const cursor of due) {
      const audit = auditRows(
        parties, { at: now, sessionId: s.id, action: "decision_closed", roomName: s.manifest.room, detail: {} }, SYSTEM_ACTOR,
      );
      const out = await this.closeDecision(cursor, { state: "expired" }, now, audit);
      if (out.outcome === "appended") continue;
      // A booked decision this close could not consume would leave the derived time where it is, and the closing
      // reArm() would fire the alarm back to back for good. So the book is set from the log: an entry for a decision
      // the log does not hold open is dropped, and one whose deadline disagrees with its opening event takes the
      // event's. No write path reaches either today; this is the handler deciding its next time from state it changed.
      console.warn(`decision alarm: room ${s.id} decision ${cursor} answered ${out.outcome}; rebooking it from the log`);
      await this.#rebook(cursor);
    }
  }

  /** The `openDecisions` entry for `cursor` set from the log: the opening event's deadline while open, else none. */
  async #rebook(cursor: number): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const s = await this.stored(txn);
      if (!s?.openDecisions || !Object.hasOwn(s.openDecisions, String(cursor))) return;
      const view = decisionsOf(await this.#logFrom(txn, cursor), Date.now(), "untallied").get(cursor);
      const { [String(cursor)]: entry, ...rest } = s.openDecisions;
      const book = view === undefined || view.closed !== null
        ? rest
        : { ...rest, [cursor]: { ...entry, expires_at: view.payload.expires_at } };
      await putRows(txn, asRows(s, { session: { ...s, openDecisions: book } }));
    });
  }

  /** `BellmanStore.closeDecision`: the server's close, refused once a closing event exists or before an expiry is due. */
  async closeDecision(
    decision: number, close: { state: ClosedState; reason?: FailReason }, now: number, audit: readonly AuditEntry[] = [],
  ): Promise<DecisionClose> {
    let after: { forward: boolean; queued: boolean; erased?: { decision: number; rows: number; keys: number }[] } = { forward: false, queued: false };
    let members: readonly Member[] = [];
    const result = await this.ctx.storage.transaction<DecisionClose>(async (txn) => {
      after = { forward: false, queued: false };
      const s = await this.stored(txn);
      if (!s) throw new Error("Unknown session");
      members = s.members;
      if (s.frozenAt !== null && close.state !== "expired") return { outcome: "frozen" };
      const log = await this.#logFrom(txn, decision);
      const ballots = bookOf(await this.#ballotRows(txn, [decision]));
      const view = decisionsOf(log, now, ballots).get(decision);
      if (view === undefined) return { outcome: "unknown" };
      const d = decideClose(view, close.state, now);
      if (d.kind === "closed") return { outcome: "closed", state: d.state };
      if (d.kind === "not_due") return { outcome: "not_due" };
      const event: SessionEvent = { ...closingEvent(view, close), cursor: await this.nextCursor(txn), at: Date.now() };
      after = await this.#writeDecision(txn, s, [event], {}, audit, log, ballots);
      return { outcome: "appended", event };
    });
    if (result.outcome === "appended") await this.#afterDecision([result.event], members, after);
    return result;
  }

  /** `BellmanStore.decision`: its own events from the index, read without a transaction, as `decisions` is. */
  /** `BellmanStore.votedOn`: one read of the account's ballot row in each named decision. */
  async votedOn(userId: string, decisions: number[]): Promise<number[]> {
    const rows = await this.ctx.storage.get(decisions.map((d) => ballotKey(d, userId)));
    return decisions.filter((d) => rows.has(ballotKey(d, userId)));
  }

  async decision(cursor: number, now: number): Promise<DecisionView | null> {
    await this.#indexDecisions();
    const own = await this.ctx.storage.list<SessionEvent>({ prefix: decisionEventPrefix(cursor) });
    const view = decisionsOf([...own.values()], now, bookOf(await this.#ballotRows(this.ctx.storage, [cursor]))).get(cursor);
    return view === undefined ? null : withoutBook(view);
  }

  /**
   * `BellmanStore.decisions`: the page from the index rows, newest first, the open ones from the record's book, and
   * each one's own events. Without a transaction, as `decision` is: a decision written after the index is brought
   * up to date is on the next page read, as a poll's is.
   */
  async decisions(ask: DecisionPageAsk, now: number): Promise<DecisionPage> {
    await this.#indexDecisions();
    const storage = this.ctx.storage;
    const end = Math.min(ask.before ?? Infinity, (ask.upTo ?? Infinity) + 1);
    const listed = await storage.list({
      prefix: DECISION_INDEX_PREFIX, reverse: true, limit: ask.limit + 1,
      ...(Number.isFinite(end) ? { end: decisionIndexKey(end) } : {}),
    });
    const { page, next } = decisionPageOf([...listed.keys()].map((k) => Number(k.slice(DECISION_INDEX_PREFIX.length))), ask);
    const book = ask.upTo === undefined ? (await this.stored())?.openDecisions ?? {} : {};
    const open = Object.entries(book).filter(([, d]) => d.expires_at >= now).map(([c]) => Number(c)).sort((a, b) => b - a);
    const events: SessionEvent[] = [];
    for (const decision of new Set([...page, ...open])) {
      const prefix = decisionEventPrefix(decision);
      const own = await storage.list<SessionEvent>({ prefix, ...(ask.upTo === undefined ? {} : { end: `${prefix}${pad(ask.upTo + 1)}` }) });
      events.push(...own.values());
    }
    const ballots = bookOf(await this.#ballotRows(storage, Object.keys(book).map(Number)));
    const views = decisionsOf(events.sort((a, b) => a.cursor - b.cursor), now, ballots);
    const shown = (cursors: readonly number[]) => cursors.flatMap((c) => { const v = views.get(c); return v === undefined ? [] : [withoutBook(v)]; });
    return { open: shown(open).filter((v) => v.state === "open"), decisions: shown(page), next };
  }

  /** Indexes the log past `DECISION_INDEX_AT`, a batch a transaction, until none is left. */
  async #indexDecisions(): Promise<void> {
    for (let more = true; more;) {
      more = await this.ctx.storage.transaction(async (txn) => {
        const at = await txn.get<number>(DECISION_INDEX_AT);
        const batch = [...(await txn.list<SessionEvent>({
          prefix: "e:", limit: DECISION_INDEX_BATCH, ...(at === undefined ? {} : { startAfter: eventKey(at) }),
        })).values()];
        if (batch.length === 0) return false;
        await putRows(txn, { ...decisionIndexRows(batch), [DECISION_INDEX_AT]: batch[batch.length - 1].cursor });
        return batch.length === DECISION_INDEX_BATCH;
      });
    }
  }

  /**
   * `BellmanStore.admitSend`'s count. A stranger's key is a row, read and written in one transaction so two
   * sends landing together are counted one after the other. Only an admission writes, and what it writes is the
   * times still inside the minute plus this one, so a row never holds more than the limit and a script held at
   * the limit costs no write at all: at most 6 small writes a minute per stranger. Any other key is in
   * `#sends`: no await and no storage, so the read of a key's times and the write of them back are one turn.
   */
  async admitSend(key: string, limit: number, now: number): Promise<SendAdmission> {
    if (isStrangerKey(key)) {
      return this.ctx.storage.transaction(async (txn) => {
        const row = sendCountKey(key);
        const counted = admitAt((await txn.get<number[]>(row)) ?? [], limit, now);
        if (counted.retryAfterMs !== null) return { ok: false, retryAfterMs: counted.retryAfterMs };
        await txn.put(row, counted.times);
        return { ok: true };
      });
    }
    const counted = admitAt(this.#sends.get(key) ?? [], limit, now);
    this.#sends.set(key, counted.times);
    return counted.retryAfterMs === null ? { ok: true } : { ok: false, retryAfterMs: counted.retryAfterMs };
  }

  /**
   * The hosted seat's allowance for a new month (I7), `BellmanStore.renewHostAllowance`'s
   * rule: in one transaction, so a renewal and the seat's charge cannot interleave inside
   * the record. The seat is the only caller, on its first wake of a month.
   */
  async renewHostAllowance(month: string, units: number): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const s = await this.stored(txn);
      if (!s || s.hostUnits.month >= month) return;
      await putRows(txn, memberRows(s, { ...s, hostUnitsPerMonth: units, hostUnits: { month, used: 0, wakes: [] } }));
    });
  }

  /**
   * `BellmanStore.setHostInstructions`, for this room: the manifest's `host.instructions` and the audit rows the
   * change owes in one transaction, the rows riding the outbox as `removeMember`'s do and delivered once it has
   * committed. The value the room already holds writes nothing and queues nothing. The refusals are read in the
   * same transaction as the write, so a room that closes after the route read it is refused here.
   */
  async setHostInstructions(instructions: string | null, audit: readonly AuditEntry[]): Promise<HostInstructionsSet> {
    let queued = false;
    const result = await this.ctx.storage.transaction<HostInstructionsSet>(async (txn) => {
      const s = await this.stored(txn);
      if (!s) return { ok: false, reason: "not_found" };
      const host = s.manifest.host;
      if (host === null) return { ok: false, reason: "no_host" };
      if (s.closed) return { ok: false, reason: "closed" };
      if (host.instructions === instructions) return { ok: true, instructions };
      // A falsy org names a stream nobody reads (ARCHITECTURE.md section 9, runtime fact 4): filtered here, as
      // `removeMember` filters its rows, so a dead row never enters the queue.
      const intents = audit.filter((e) => e.orgId).map(auditIntent);
      queued = intents.length > 0;
      const rows = await this.driver.enqueue(txn, intents);
      await putRows(txn, { ...memberRows(s, { ...s, manifest: { ...s.manifest, host: { ...host, instructions } } }), ...rows });
      return { ok: true, instructions };
    });
    if (queued) await this.driver.deliverNow();
    return result;
  }

  /** `BellmanStore.getConfigRow`, for this room: the `cfg:<name>` row. */
  async getConfigRow(name: ConfigName): Promise<ConfigRow | null> {
    return (await this.ctx.storage.get<ConfigRow>(configKey(name))) ?? null;
  }

  /** `BellmanStore.configHistory`, for this room: the `cfgh:<name>:` rows, newest first. */
  async configHistory(name: ConfigName): Promise<ConfigRow[]> {
    const rows = await this.ctx.storage.list<ConfigRow>({ prefix: configHistoryPrefix(name), reverse: true, limit: CONFIG_HISTORY });
    return [...rows.values()];
  }

  /**
   * `BellmanStore.writeConfig`, for this room: `decideConfigWrite` on the record and the current row read in the
   * transaction, then the row, its history row, the record's revisions and bytes, the `config_changed` event and
   * the audit intents in one put, and the history row past `CONFIG_HISTORY` deleted. The wake, the delivery and the
   * re-arm after the commit, as a decision write's.
   */
  async writeConfig(w: ConfigWrite, audit: readonly AuditEntry[]): Promise<ConfigWriteResult> {
    let after: { forward: boolean; queued: boolean; erased?: { decision: number; rows: number; keys: number }[] } = { forward: false, queued: false };
    let members: readonly Member[] = [];
    let written: SessionEvent | null = null;
    const result = await this.ctx.storage.transaction<ConfigWriteResult>(async (txn) => {
      // Assigned again if the runtime runs this closure again.
      after = { forward: false, queued: false };
      written = null;
      const s = await this.stored(txn);
      if (!s) return { ok: false, reason: "not_found" };
      members = s.members;
      if (s.closed) return { ok: false, reason: "closed" };
      const at = Date.now();
      const decided = decideConfigWrite(s, (await txn.get<ConfigRow>(configKey(w.name))) ?? null, w, new Date(at).toISOString());
      if (!decided.ok) return decided.result;
      const { row } = decided;
      const intents = audit.filter((e) => e.orgId).map(auditIntent);
      after.queued = intents.length > 0;
      const rows = await this.driver.enqueue(txn, intents);
      const e: SessionEvent = { ...configEvent(row), cursor: await this.nextCursor(txn), at };
      const session: StoredSession = { ...s, configRevs: decided.configRevs, configBytes: decided.configBytes };
      const pruned = row.rev > CONFIG_HISTORY ? [configHistoryKey(w.name, row.rev - CONFIG_HISTORY)] : [];
      after.forward = await this.#writeEvent(
        txn, s, e, { session, [configKey(w.name)]: row, [configHistoryKey(w.name, row.rev)]: row, ...rows }, pruned,
      );
      written = e;
      return { ok: true, rev: row.rev };
    });
    if (written !== null) await this.#afterDecision([written], members, after);
    return result;
  }

  /** `BellmanStore.readFs`, for this room. */
  async readFs(path: string, rev?: number): Promise<FsRow | null> {
    if (rev !== undefined) return (await this.ctx.storage.get<FsRow>(fsHistoryKey(path, rev))) ?? null;
    const row = await this.ctx.storage.get<FsRow>(fsKey(path));
    return row && !row.deleted ? row : null;
  }

  // ponytail: a list or find reads every `fsm:` index row under the prefix, because the hidden memory ids are
  // filtered before the page is cut. Rows carry no content, so this is metadata only; bounded batches if rooms reach
  // hundreds of thousands of files.
  async #fsRows(prefix: string, from: { list: DurableObjectStorage["list"] } = this.ctx.storage): Promise<FsEntry[]> {
    return [...(await from.list<FsEntry>({ prefix: fsIndexKey(prefix) })).values()];
  }

  /** `BellmanStore.listFs`, for this room. */
  async listFs(prefix: string, opts: { cursor?: string; hide?: readonly string[]; newest?: boolean } = {}): Promise<FsPage> {
    return pageFs(await this.#fsRows(prefix), (r) => underPrefix(r.path, prefix) && !hiddenMemory(r, opts.hide), FS_LIST_PAGE, opts.cursor, opts.newest ? newestKey : undefined);
  }

  /** `BellmanStore.readHomeSettings` (#530): the `hs` row, or the defaults. Reads the record for nothing, so none is needed. */
  async readHomeSettings(): Promise<HomeSettings> {
    return { ...DEFAULT_HOME_SETTINGS, ...(await this.ctx.storage.get<HomeSettings>("hs")) };
  }

  /** `BellmanStore.writeHomeSettings`: the `hs` row replaced. No record, event, outbox intent or alarm: settings alone are not a home room. */
  async writeHomeSettings(settings: HomeSettings): Promise<void> {
    await this.ctx.storage.put("hs", settings);
  }

  /**
   * `BellmanStore.readHomeLogged` (ADR 0047 decision 13): the `hs` read, the file read, the `lk:` row and the
   * retention prune in one transaction, so a hard delete racing the read cannot leave a lookup row in an emptied room.
   */
  async readHomeLogged(path: string, source: LookupSource): Promise<{ paused: true } | { paused: false; file: FsRow | null }> {
    return this.ctx.storage.transaction(async (txn) => {
      if ((await txn.get<HomeSettings>("hs"))?.paused) return { paused: true as const };
      const row = await txn.get<FsRow>(fsKey(path));
      const file = row && !row.deleted ? row : null;
      await this.#logLookup(txn, source, file ? [file.path] : []);
      return { paused: false as const, file };
    });
  }

  /** `BellmanStore.listHomeLogged`: `listFs` newest first, read and logged in one transaction as `readHomeLogged`. */
  async listHomeLogged(prefix: string, cursor: string | undefined, source: LookupSource): Promise<{ paused: true } | { paused: false; page: FsPage }> {
    return this.ctx.storage.transaction(async (txn) => {
      if ((await txn.get<HomeSettings>("hs"))?.paused) return { paused: true as const };
      const page = pageFs(await this.#fsRows(prefix, txn), (r) => underPrefix(r.path, prefix), FS_LIST_PAGE, cursor, newestKey);
      await this.#logLookup(txn, source, page.entries.map((e) => e.path));
      return { paused: false as const, page };
    });
  }

  async #logLookup(txn: DurableObjectTransaction, source: LookupSource, paths: string[]): Promise<void> {
    const at = Date.now();
    await txn.put(lookupKey(at), { ...source, at, paths } satisfies LookupRow);
    const expired = await txn.list({ prefix: LOOKUP_PREFIX, end: lookupKey(at - LOOKUP_KEEP_MS, "") });
    for (const key of expired.keys()) await txn.delete(key);
  }

  // ponytail: the whole log is read to cap it at LOOKUP_KEEP; a count row if logs grow past a few thousand before
  // the dash reads them.
  /** `BellmanStore.homeLookups`: newest first, the rows past `LOOKUP_KEEP` deleted. */
  async homeLookups(): Promise<LookupRow[]> {
    const rows = [...(await this.ctx.storage.list<LookupRow>({ prefix: LOOKUP_PREFIX, reverse: true }))];
    for (const [key] of rows.slice(LOOKUP_KEEP)) await this.ctx.storage.delete(key);
    return rows.slice(0, LOOKUP_KEEP).map(([, r]) => r);
  }

  /**
   * `BellmanStore.writeHome`, for this home room (ADR 0047), in one transaction: the record created from `home` when
   * none is stored, the key (`hk:`) checked, `decideFsWrite` with `ceiling` as the room's and no memory rule, then the
   * file row, its index and history rows, the record's `fsBytes` and the key's record in one put, and the pruned
   * history deleted. No event, no outbox intent, no alarm: nothing is owed, so nothing is armed.
   */
  async writeHome(home: NewSession, w: FsWrite, ceiling: number): Promise<HomeAppend> {
    return this.ctx.storage.transaction<HomeAppend>(async (txn) => {
      const keyed = w.key === null ? null : { storageKey: homeKey(w.memberId, w.key), print: fsPrint(w) };
      if (keyed !== null) {
        const record = await txn.get<HomeKeyRecord>(keyed.storageKey);
        if (record) return record.print === keyed.print ? { outcome: "replayed", path: record.path, rev: record.rev } : { outcome: "conflict" };
      }
      if (w.write.op === "write" && (await txn.get<HomeSettings>("hs"))?.paused) return { outcome: "paused" };
      if (namespaceOf(w.path).ns === "app") return { outcome: "forbidden" };
      const read = await this.stored(txn);
      let s = read, seeded: Record<string, unknown> = {};
      if (!s) {
        const seat = seatInOrder(home.members, { memberSeq: 0, labelSeq: 0 });
        const { events: _events, members: _arriving, ...others } = home;
        s = { ...others, members: seat.members, creator: creatorOf(seat.members[0]), orgs: orgsOnRoster(seat), memberSeq: seat.memberSeq, labelSeq: seat.labelSeq };
        seeded = { ...seatRows(seat), cursor: 0 };
      }
      const at = Date.now();
      const current = (await txn.get<FsRow>(fsKey(w.path))) ?? null;
      const history = await this.#fsHistory(txn, w.path);
      const decided = decideFsWrite({ ...s, fsBytesCeiling: ceiling }, w, w.path, current, history, at, true);
      if (!decided.ok) return decided.result;
      const { row } = decided;
      await putRows(txn, {
        ...seeded,
        ...memberRows(read, { ...s, fsBytes: decided.fsBytes }),
        [fsKey(w.path)]: row,
        [fsIndexKey(w.path)]: fsEntryOf(row),
        ...(row.deleted ? {} : { [fsHistoryKey(w.path, row.rev)]: row }),
        ...(keyed === null ? {} : { [keyed.storageKey]: { print: keyed.print, path: w.path, rev: row.rev } satisfies HomeKeyRecord }),
      });
      for (const rev of decided.dropRevs) await txn.delete(fsHistoryKey(w.path, rev));
      return { outcome: "ok", path: w.path, rev: row.rev };
    });
  }

  /** `BellmanStore.findFs`, for this room. */
  async findFs(query: string, opts: { cursor?: string; hide?: readonly string[] } = {}): Promise<FsPage> {
    return pageFs(await this.#fsRows("/"), (r) => pathMatches(r.path, query) && !hiddenMemory(r, opts.hide), FS_FIND_MAX, opts.cursor);
  }

  /** `BellmanStore.fsHistory`, for this room: newest first. */
  async fsHistory(path: string): Promise<FsRow[]> {
    return this.#fsHistory(this.ctx.storage, path);
  }

  async #fsHistory(from: { list: DurableObjectStorage["list"] }, path: string): Promise<FsRow[]> {
    const prefix = fsHistoryPrefix(path);
    const rows = await from.list<FsRow>({ prefix, reverse: true });
    return [...rows].filter(([k]) => REV_PAD.test(k.slice(prefix.length))).map(([, r]) => r);
  }

  /** `BellmanStore.memoryIdOf`, for this room. Never writes. */
  async memoryIdOf(userId: string): Promise<string | null> {
    return (await this.ctx.storage.get<string>(memoryIdKey(userId))) ?? null;
  }

  /** `BellmanStore.memoryIdOwner`, for this room. */
  async memoryIdOwner(memoryId: string): Promise<string | null> {
    return (await this.ctx.storage.get<string>(memoryOwnerKey(memoryId))) ?? null;
  }

  /** `BellmanStore.memoryIds`, for this room. */
  async memoryIds(): Promise<Array<{ userId: string; memoryId: string }>> {
    const rows = await this.ctx.storage.list<string>({ prefix: "mi:" });
    return [...rows].map(([k, memoryId]) => ({ userId: k.slice("mi:".length), memoryId }));
  }

  /** `BellmanStore.notesSharers`, for this room: the `ns:` rows' accounts. */
  async notesSharers(): Promise<string[]> {
    const rows = await this.ctx.storage.list<true>({ prefix: NOTES_SHARING_PREFIX });
    return [...rows.keys()].map((k) => k.slice(NOTES_SHARING_PREFIX.length));
  }

  /** `BellmanStore.setNotesSharing`, for this room. Reads the record for nothing, so none is needed. */
  async setNotesSharing(userId: string, shared: boolean): Promise<void> {
    if (shared) await this.ctx.storage.put(notesSharingKey(userId), true);
    else await this.ctx.storage.delete(notesSharingKey(userId));
  }

  /**
   * `BellmanStore.appendFs`, for this room, in one transaction: the key before the room checks (as appendSurface),
   * the path resolved against the `mi:`/`mio:` rows, `decideFsWrite` on the rows read here, then the file row, its
   * history row, the record's `fsBytes`, the memory id rows on a first memory write, the event, the key's record and
   * the audit intents in one put, and the pruned or dropped history deleted.
   */
  async appendFs(w: FsWrite, audit: readonly AuditEntry[]): Promise<FsAppend> {
    let after = { forward: false, queued: false };
    let members: readonly Member[] = [];
    let written: SessionEvent | null = null;
    const result = await this.ctx.storage.transaction<FsAppend>(async (txn) => {
      after = { forward: false, queued: false };
      written = null;
      const s = await this.stored(txn);
      if (!s) return { outcome: "not_found" };
      members = s.members;
      const keyed = w.key === null ? null : { storageKey: idempotencyKey(w.memberId, w.key), print: fsPrint(w) };
      if (keyed !== null) {
        const record = await txn.get<IdempotencyRecord>(keyed.storageKey);
        if (record) {
          if (record.print !== keyed.print) return { outcome: "conflict" };
          const original = await txn.get<SessionEvent>(eventKey(record.cursor));
          if (!original) throw new Error(`Idempotency record names missing cursor ${record.cursor}`);
          return { outcome: "replayed", event: original };
        }
      }
      if (s.closed) return { outcome: "closed" };
      if (s.frozenAt !== null) return { outcome: "frozen" };
      const named = namespaceOf(w.path);
      const namedOwner = named.ns === "memory" && named.memoryId !== null
        ? (await txn.get<string>(memoryOwnerKey(named.memoryId))) ?? null
        : null;
      const writerId = (await txn.get<string>(memoryIdKey(w.userId))) ?? null;
      const resolved = resolveFsPath(w, writerId, namedOwner, newMemoryId);
      if (!resolved.ok) return { outcome: "forbidden" };
      const at = Date.now();
      const current = (await txn.get<FsRow>(fsKey(resolved.path))) ?? null;
      const history = await this.#fsHistory(txn, resolved.path);
      const decided = decideFsWrite(s, w, resolved.path, current, history, at);
      if (!decided.ok) return decided.result;
      const { row } = decided;
      const stamped = audit.map((e) => ({ ...e, detail: { ...e.detail, ...decided.stamp } }));
      const intents = stamped.filter((e) => e.orgId).map(auditIntent);
      after.queued = intents.length > 0;
      const rows = await this.driver.enqueue(txn, intents);
      const e: SessionEvent = { ...decided.event, cursor: await this.nextCursor(txn), at };
      const session: StoredSession = { ...s, fsBytes: decided.fsBytes, fsMemoryBytes: decided.fsMemoryBytes };
      after.forward = await this.#writeEvent(txn, s, e, {
        session,
        [fsKey(resolved.path)]: row,
        [fsIndexKey(resolved.path)]: fsEntryOf(row),
        ...(row.deleted ? {} : { [fsHistoryKey(resolved.path, row.rev)]: row }),
        ...(resolved.assign === null ? {} : { [memoryIdKey(w.userId)]: resolved.assign, [memoryOwnerKey(resolved.assign)]: w.userId }),
        ...(keyed === null ? {} : { [keyed.storageKey]: { cursor: e.cursor, print: keyed.print } satisfies IdempotencyRecord }),
        ...rows,
      }, decided.dropRevs.map((rev) => fsHistoryKey(resolved.path, rev)));
      written = e;
      return { outcome: "ok", path: resolved.path, rev: row.rev, event: e };
    });
    if (written !== null) await this.#afterDecision([written], members, after);
    return result;
  }

  /** `limit` bounds the storage list itself (I4): the hosted seat's read passes one, every other read none. */
  async eventsAfter(cursor: number, limit?: number): Promise<SessionEvent[]> {
    return this.events(cursor, limit);
  }

  /**
   * The host's write under `key` (M6), or undefined: what the seat checks before it calls
   * the model, so a wake run again after a lost response finds its post. A read, so it
   * answers RPC like `eventsAfter`.
   */
  async hostEventFor(key: string): Promise<SessionEvent | undefined> {
    const done = await this.ctx.storage.get<IdempotencyRecord>(idempotencyKey(HOST_MEMBER_ID, key));
    return done ? this.ctx.storage.get<SessionEvent>(eventKey(done.cursor)) : undefined;
  }

  async eventAt(cursor: number): Promise<SessionEvent | undefined> {
    return this.ctx.storage.get<SessionEvent>(eventKey(cursor));
  }

  /**
   * The tail of the log. Events are keyed `e:<padded cursor>` (`eventKey`), so
   * the newest `limit` are one reverse list; reversed back so the caller reads
   * them in cursor order like `eventsAfter`. Public on purpose: a read, like
   * `eventsAfter`, and the facade calls it over RPC.
   */
  async recentEvents(limit: number): Promise<SessionEvent[]> {
    if (limit <= 0) return [];
    const map = await this.ctx.storage.list<SessionEvent>({ prefix: "e:", reverse: true, limit });
    return [...map.values()].reverse();
  }

  /**
   * Every surface row (#129), in key order — `list` returns keys sorted, which
   * is the order the contract promises. A read, so it answers RPC like
   * `eventsAfter` does.
   */
  async surfaceOf(): Promise<SurfaceRow[]> {
    const map = await this.ctx.storage.list<SurfaceRow>({ prefix: SURFACE_PREFIX });
    return [...map.values()];
  }

  /**
   * `BellmanStore.roomSummary` (#472): the record, the newest event and the surface rows are read here, and only the
   * counts go back over RPC. A read: an abandoned room reads closed by `isAbandoned`, as `readsClosed` decides it, and
   * nothing is written.
   */
  async roomSummary(): Promise<RoomSummary | undefined> {
    const s = await this.stored();
    if (!s) return undefined;
    const [last] = await this.recentEvents(1);
    const rows = await this.ctx.storage.list({ prefix: SURFACE_PREFIX });
    return roomSummaryOf(s, last, rows.size, Date.now(), await this.#connected(s));
  }

  /** `BellmanStore.surfaceFacts`: the rows are read here, and only the counts and the rows named go back over RPC. */
  async surfaceFacts(keys: readonly string[]): Promise<SurfaceFacts> {
    return surfaceFactsOf((await this.ctx.storage.list<SurfaceRow>({ prefix: SURFACE_PREFIX })).values(), keys);
  }

  /** `BellmanStore.surfaceNamesBlob`: the rows are read here, and only the answer goes back over RPC. */
  async surfaceNamesBlob(blobId: string): Promise<boolean> {
    for (const r of (await this.ctx.storage.list<SurfaceRow>({ prefix: SURFACE_PREFIX })).values()) if (r.blob?.id === blobId) return true;
    return false;
  }

  /** One page of a window (lead ruling L1): every row is read here, and only the page goes back over RPC. */
  async surfaceWindow(
    asked: { window?: Window; next?: string },
    opts: { cut?: number },
  ): Promise<{ ok: true; page: WindowPage; cursor: number } | { ok: false; reason: string }> {
    const s = await this.stored();
    return windowUnderCut(await this.surfaceOf(), s?.surfaceCursor ?? 0, asked, opts.cut);
  }

  async outsideTask(callerUserId: string, taskId: string): Promise<OutsideTask | undefined> {
    const task = await this.ctx.storage.get<OutsideTask>(`${OUTSIDE_TASK_PREFIX}${taskId}`);
    return task?.callerUserId === callerUserId ? task : undefined;
  }

  async outsideTaskById(taskId: string): Promise<OutsideTask | undefined> {
    return this.ctx.storage.get<OutsideTask>(`${OUTSIDE_TASK_PREFIX}${taskId}`);
  }

  /** `removeMember`'s ban for an account that holds no member row: the same two rows, and for "all" the same queued registry write. */
  async banAccount(req: AccountBanRequest): Promise<{ refused: RemovalOutcome["refused"] }> {
    const outcome = await this.ctx.storage.transaction<{ refused: RemovalOutcome["refused"]; queued: boolean }>(async (txn) => {
      const s = await this.stored(txn);
      if (!s) return { refused: "not_found", queued: false };
      if (s.closed) return { refused: "closed", queued: false };
      if (s.frozenAt !== null) return { refused: "frozen", queued: false };
      if (s.createdBy !== req.byUserId) return { refused: "forbidden", queued: false };
      const banning: Ban | null = (await txn.get<string>(banUserKey(req.userId))) === undefined
        ? { banId: newBanId(), userId: req.userId, label: req.label, at: req.now }
        : null;
      // Owed whenever asked for, as in `removeMember`: the registry cannot be read from here, and its write keeps the first.
      const widening: CreatorBan | null = req.ban === "all"
        ? { banId: newBanId(), userId: req.userId, label: req.label, at: req.now, sessionId: s.id }
        : null;
      const queue = [
        ...(widening ? [creatorBanIntent(s.createdBy, widening)] : []),
        ...(banning ? req.audit.filter((e) => e.orgId).map(auditIntent) : []),
      ];
      const rows = await this.driver.enqueue(txn, queue);
      await putRows(txn, {
        ...(banning ? { [banKey(banning.banId)]: banning, [banUserKey(banning.userId)]: banning.banId } : {}),
        ...rows,
      });
      return { refused: null, queued: queue.length > 0 };
    });
    if (outcome.queued) await this.driver.deliverNow();
    return { refused: outcome.refused };
  }

  /**
   * ponytail: every task row of the room, filtered to the caller. A room holds a caller's three open
   * tasks and whatever they closed in the week before the sweep; if rooms outgrow that, key the rows by caller.
   */
  async outsideTasksOf(callerUserId: string): Promise<OutsideTask[]> {
    const all = await this.ctx.storage.list<OutsideTask>({ prefix: OUTSIDE_TASK_PREFIX });
    return [...all.values()].filter((t) => t.callerUserId === callerUserId).sort(newestTaskFirst);
  }

  /**
   * `BellmanStore.askOutside`: the follow-up rule, the cap, the caller's context and visitor number, the
   * `outside_question`, its task row, the caller's standing row and the visitor counter, in ONE transaction. The reads
   * are `decideAsk`'s inputs, taken in the transaction that writes, so two asks are serialised: the second reads the
   * first's rows and sees the cap, the counter and the context the first left. Like `chargeBlobBytes`, `seatMember`
   * and `approveProposal`, the decision is made where the write is.
   */
  async askOutside(req: AskRequest): Promise<AskOutcome> {
    let broughtForward = false as boolean;
    let wakesSeat = false as boolean;
    let expires = false as boolean;
    // The rows this transaction read, for the wake's read_context rule, as in appendEvent.
    let members: readonly Member[] = [];
    let appended: SessionEvent | null = null;
    const result = await this.ctx.storage.transaction<AskOutcome>(async (txn) => {
      // Assigned again if the runtime runs this closure again, so a first attempt's answer cannot outlive it.
      broughtForward = false;
      wakesSeat = false;
      expires = false;
      appended = null;
      const s = await this.stored(txn);
      if (!s || s.frozenAt !== null) return { ok: false, error: "not_found" };
      members = s.members;
      const mine = [...(await txn.list<OutsideTask>({ prefix: OUTSIDE_TASK_PREFIX })).values()]
        .filter((t) => t.callerUserId === req.callerUserId);
      const callerKey = `${OUTSIDE_CALLER_PREFIX}${encodeURIComponent(req.callerUserId)}`;
      const known = await txn.get<OutsideCaller>(callerKey);
      const issued = (await txn.get<number>(OUTSIDE_VISITORS_KEY)) ?? 0;
      const d = decideAsk(s, req, { mine, known, issued, seatDay: s.seatDay });
      if (!d.ok) return d;

      const event: SessionEvent = { ...d.event, cursor: await this.nextCursor(txn), at: Date.now() };
      const task = taskWithEvent(d.task, event);
      // The seat as voice: its day's count, its deadline on the record and its wake, in this transaction. The wake's
      // enqueue arms the alarm for the queue, and alarm()'s closing reArm() then finds the deadline, which `seatWaits`
      // derives: nothing here sets the alarm to it, so nothing pulls back an earlier time.
      const seat = d.seatDay === null ? {} : await this.driver.enqueue(txn, [hostWakeIntent(s.id, "outside", event.cursor)]);
      // The task's lifetime on the record (`outsideExpiryAt`): a lower bound on the soonest any open task lapses, so
      // the alarm is derived from one number and not from a read of every task row. Only ever brought earlier here.
      const lapse = nextLapse([task]);
      expires = lapse !== null && lapse < (s.outsideExpiryAt ?? Infinity);
      const session = d.seatDay === null && !expires ? undefined : {
        ...s,
        ...(d.seatDay === null ? {} : { seatDay: d.seatDay, seatWaits: { ...s.seatWaits, [task.id]: task.seatDeadline as number } }),
        ...(expires ? { outsideExpiryAt: lapse } : {}),
      };
      wakesSeat = d.seatDay !== null;
      broughtForward = await this.#writeEvent(txn, s, event, {
        ...seat,
        ...(session === undefined ? {} : { session }),
        [`${OUTSIDE_TASK_PREFIX}${task.id}`]: task,
        ...(d.standing === null ? {} : { [callerKey]: d.standing }),
        ...(d.issued === issued ? {} : { [OUTSIDE_VISITORS_KEY]: d.issued }),
      });
      appended = event;
      return { ok: true, task };
    });
    const event = appended as SessionEvent | null;
    if (event !== null) {
      this.#wake(event, members);
      if (broughtForward || expires) await this.driver.reArm();
      // Last, as appendEvent's: nobody woken above waits on the seat's delivery.
      if (wakesSeat) await this.driver.deliverNow();
    }
    return result;
  }

  /**
   * `BellmanStore.answerOutside`: who the voice is, whether the question is still open, the `outside_answer` and the
   * task row's new state, in ONE transaction. The room and the row are read in the transaction that writes them, so of
   * two answers at once the second reads the first's row and finds the question answered.
   */
  async answerOutside(req: AnswerRequest): Promise<AnswerResult> {
    let broughtForward = false as boolean;
    let audited = false as boolean;
    let members: readonly Member[] = [];
    let appended: SessionEvent | null = null;
    const result = await this.ctx.storage.transaction<AnswerResult>(async (txn) => {
      broughtForward = false;
      audited = false;
      appended = null;
      const s = await this.stored(txn);
      if (!s || s.frozenAt !== null || s.closed) return { ok: false, error: "task_closed" };
      members = s.members;
      const d = decideAnswer(s, await txn.get<OutsideTask>(`${OUTSIDE_TASK_PREFIX}${req.taskId}`), req);
      if (!d.ok) return d;
      // The seat pays for its answer in this write, as appendHostEvent's: the charge, its stamp and its audit row. A
      // meter that refuses leaves the seat no voice to answer with.
      const charge = req.units === undefined ? null : decideHostCharge(s, req.units, req.now);
      if (charge !== null && !charge.ok) return { ok: false, error: "not_the_voice" };

      const event: SessionEvent = { ...d.event, cursor: await this.nextCursor(txn), at: Date.now() };
      const task = taskWithEvent(d.task, event);
      const { [task.id]: _answered, ...seatWaits } = s.seatWaits ?? {};
      const intents = charge === null ? [] : hostSentEntries(s, d.event, req.now).map(auditIntent);
      audited = intents.length > 0;
      const seat = charge === null ? {} : {
        session: {
          ...s, seatWaits, hostUnits: charge.next,
          members: s.members.map((m) => m.memberId === d.event.fromMemberId ? { ...m, lastSeenAt: req.now } : m),
        },
        ...(audited ? await this.driver.enqueue(txn, intents) : {}),
      };
      broughtForward = await this.#writeEvent(txn, s, event, { ...seat, [`${OUTSIDE_TASK_PREFIX}${task.id}`]: task });
      appended = event;
      return { ok: true, task };
    });
    const event = appended as SessionEvent | null;
    if (event !== null) {
      this.#wake(event, members);
      if (broughtForward) await this.driver.reArm();
      if (audited) await this.driver.deliverNow();
    }
    return result;
  }

  /**
   * `BellmanStore.cancelOutside`: the asker withdraws a question. The task row, its `outside_notice` and the seat's
   * deadline off the record are ONE transaction, and the row is read in it, so a racing answer finds the task canceled
   * (`decideAnswer` maps that to "task_closed") and a cancel that finds the answer in first is "not_cancelable".
   */
  async cancelOutside(req: CancelRequest): Promise<CancelResult> {
    let appended: SessionEvent | null = null;
    let members: readonly Member[] = [];
    const result = await this.ctx.storage.transaction<CancelResult>(async (txn) => {
      appended = null;
      const s = await this.stored(txn);
      if (!s || s.frozenAt !== null) return { ok: false, error: "task_not_found" };
      members = s.members;
      const key = `${OUTSIDE_TASK_PREFIX}${req.taskId}`;
      const d = decideCancel(await txn.get<OutsideTask>(key), req);
      if (!d.ok) return d;
      const event: SessionEvent = { ...d.event, cursor: await this.nextCursor(txn), at: Date.now() };
      const { [req.taskId]: _canceled, ...seatWaits } = s.seatWaits ?? {};
      await this.#writeEvent(txn, s, event, {
        ...(s.seatWaits?.[req.taskId] === undefined ? {} : { session: { ...s, seatWaits } }),
        [key]: d.task,
      });
      appended = event;
      return { ok: true, task: d.task };
    });
    const event = appended as SessionEvent | null;
    if (event !== null) this.#wake(event, members);
    return result;
  }

  /**
   * End the room's open outside tasks for `reason`, inside the caller's transaction: each task's row and its
   * `outside_notice` are written here, and the tasks' entries leave `seatWaits` and `outsideExpiryAt` moves to the next
   * lapse among those left. The record is NOT written: it answers the session as it should now stand, and the caller
   * puts it with its own change (`memberRows(s, end.session)`), which is how a close and its cancels commit as one.
   * `s` is the session as the caller reads it in this transaction. The notices are "system" events, which keep no
   * books, so writing them against `s` cannot overwrite what the caller writes. The caller wakes `events` once it commits.
   *
   * Idempotent: an ended task is no longer open, so a second close or a retried transaction ends nothing again.
   *
   * `#private`, for the reason #purgeIfDue gives.
   */
  async #endOutside(
    txn: DurableObjectTransaction, s: StoredSession, reason: EndReason, now: number,
  ): Promise<{ session: StoredSession; events: SessionEvent[] }> {
    const rows = [...(await txn.list<OutsideTask>({ prefix: OUTSIDE_TASK_PREFIX })).values()];
    const ended = endings(rows, reason, now);
    const events: SessionEvent[] = [];
    for (const { task, event } of ended) {
      const notice: SessionEvent = { ...event, cursor: await this.nextCursor(txn), at: now };
      await this.#writeEvent(txn, s, notice, { [`${OUTSIDE_TASK_PREFIX}${task.id}`]: task });
      events.push(notice);
    }
    const gone = new Set(ended.map(({ task }) => task.id));
    const waits = Object.entries(s.seatWaits ?? {});
    const kept = waits.filter(([taskId]) => !gone.has(taskId));
    const lapse = nextLapse(rows.filter((t) => !gone.has(t.id)));
    const session = kept.length === waits.length && (s.outsideExpiryAt ?? null) === lapse ? s : {
      ...s,
      ...(kept.length === waits.length ? {} : { seatWaits: Object.fromEntries(kept) }),
      outsideExpiryAt: lapse,
    };
    return { session, events };
  }

  /**
   * An outside task's lifetime (EXPIRY_HANDLER): every open task idle for `OUTSIDE_TASK_TTL_MS` fails, in one
   * transaction with the notices, and `outsideExpiryAt` moves to the next lapse or clears, which moves the derived time
   * on. A closed or frozen room has nothing to end, and derives no name for it either.
   *
   * `#private`, for the reason #purgeIfDue gives.
   */
  async #expireOutsideIfDue(now: number): Promise<void> {
    let events: SessionEvent[] = [];
    let members: readonly Member[] = [];
    await this.ctx.storage.transaction(async (txn) => {
      events = [];
      const s = await this.stored(txn);
      if (!s || s.closed || s.frozenAt !== null || typeof s.outsideExpiryAt !== "number" || now < s.outsideExpiryAt) return;
      members = s.members;
      const end = await this.#endOutside(txn, s, "expired", now);
      await putRows(txn, memberRows(s, end.session));
      events = end.events;
    });
    for (const event of events) this.#wake(event, members);
  }

  /**
   * `BellmanStore.seatSkipped`: the task row's hand-off (`handOff`), its deadline off the record and the notice that
   * tells the members (`handedOverNotice`), in ONE transaction, so it serialises with the seat's answer: whichever lands
   * second finds the other's row. A frozen or closed room takes the hand-off without the notice, as it takes no event.
   */
  async seatSkipped(taskId: string, reason: string): Promise<void> {
    let notice: SessionEvent | null = null;
    let members: readonly Member[] = [];
    const moved = await this.ctx.storage.transaction<boolean>(async (txn) => {
      notice = null;
      const s = await this.stored(txn);
      if (!s) return false;
      members = s.members;
      const key = `${OUTSIDE_TASK_PREFIX}${taskId}`;
      const task = await txn.get<OutsideTask>(key);
      const handed = task !== undefined && handOff(task, Date.now());
      let rec = s;
      if (s.seatWaits?.[taskId] !== undefined) {
        const { [taskId]: _gone, ...seatWaits } = s.seatWaits;
        rec = { ...s, seatWaits };
      }
      if (handed && !s.closed && s.frozenAt === null) {
        const now = Date.now();
        notice = { ...handedOverNotice(task), cursor: await this.nextCursor(txn), at: now };
        await this.#writeEvent(txn, s, notice, { ...(rec === s ? {} : { session: rec }), [key]: task });
        return true;
      }
      if (handed) await txn.put(key, task);
      if (rec !== s) await putRows(txn, memberRows(s, rec));
      return handed;
    });
    if (notice) this.#wake(notice, members);
    if (moved) console.log(`seat handed outside task ${taskId} to the members: ${reason}`);
  }

  /**
   * The seat's silence (SEAT_HANDLER): every outside task whose `seatWaits` deadline has passed goes to the members,
   * with the notice that tells them (as `seatSkipped`), in one transaction, and leaves `seatWaits`, which moves the derived time on. `handOff` skips a task the seat has
   * answered since; its entry goes all the same.
   *
   * `#private`, for the reason #purgeIfDue gives.
   */
  async #seatSilenceIfDue(now: number): Promise<void> {
    let events: SessionEvent[] = [];
    let members: readonly Member[] = [];
    await this.ctx.storage.transaction(async (txn) => {
      events = [];
      const s = await this.stored(txn);
      if (!s?.seatWaits) return;
      const due = Object.entries(s.seatWaits).filter(([, at]) => now >= at).map(([taskId]) => taskId);
      if (due.length === 0) return;
      members = s.members;
      const tells = !s.closed && s.frozenAt === null;
      for (const taskId of due) {
        const key = `${OUTSIDE_TASK_PREFIX}${taskId}`;
        const task = await txn.get<OutsideTask>(key);
        if (task === undefined || !handOff(task, now)) continue;
        if (!tells) {
          await txn.put(key, task);
          continue;
        }
        const notice: SessionEvent = { ...handedOverNotice(task), cursor: await this.nextCursor(txn), at: now };
        await this.#writeEvent(txn, s, notice, { [key]: task });
        events.push(notice);
      }
      const seatWaits = Object.fromEntries(Object.entries(s.seatWaits).filter(([taskId]) => !due.includes(taskId)));
      await putRows(txn, memberRows(s, { ...s, seatWaits }));
    });
    for (const event of events) this.#wake(event, members);
  }

  /**
   * The quota's bound (#183, D3), decided in this object in one transaction
   * against the ceiling stamped on its own record: the read of the total and
   * the write that raises it are one unit, so two uploads cannot both fit the
   * last megabyte. An abandoned room reads as closed through `readsClosed`,
   * the rule every reader of "closed" shares; the rest of the decision is
   * `decideBlobCharge`'s, the same call `MemoryStore` makes. Nothing is written
   * for a refusal. `blobBytes` is the sum charged so far; nothing here credits it.
   */
  async chargeBlobBytes(bytes: number): Promise<BlobCharge> {
    return this.ctx.storage.transaction<BlobCharge>(async (txn) => {
      const s = await this.stored(txn);
      if (!s) return { ok: false, reason: "not_found", used: 0 };
      const charge = decideBlobCharge(s, readsClosed(s, Date.now(), await this.#connected(s, txn)), bytes);
      if (charge.ok) await putRows(txn, memberRows(s, { ...s, blobBytes: charge.used }));
      return charge;
    });
  }

  /**
   * The read and the registration must not be split by an await, or an event
   * appended in the gap wakes an empty waiter list and this poll hangs to its
   * own timeout. Storage is async here, so the read is awaited FIRST and the
   * registration then runs synchronously — no await between check and push.
   */
  async waitForEvents(cursor: number, waitMs: number, limit?: number): Promise<SessionEvent[]> {
    const immediate = await this.events(cursor, limit);
    if (immediate.length > 0 || waitMs <= 0) return immediate;

    return new Promise<SessionEvent[]>((resolve) => {
      const w: Waiter = { after: cursor, resolve, limit };
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

  /**
   * Two arms, one event.
   *
   * Waiters are in-memory long polls and do not survive eviction; sockets are
   * held by the runtime and do. Both are served here so that the room serves
   * the same events in the same shape however a member is watching it, which
   * is the property the whole two-path design rests on. It stops there. The
   * poll then drops the caller's own events and wraps the rest in the
   * untrusted envelope, at the tool boundary; a room socket is per room, not
   * per member, so it carries a member's own events and leaves both to the
   * client (spec D1a and D6).
   *
   * The frame is publicEvent(event), the projection the poll returns, and not
   * the stored event: that carries fromUserId, and every member of a room
   * receives every other member's events (spec D1a). The waiter arm resolves
   * with the stored event because the poll projects it at the tool boundary.
   *
   * And it is the event as no one may read it (read_context plan, R2), because
   * one frame goes to every socket in the room, the author's own included. A
   * brief_update whose author keeps their brief builds no frame: no socket is
   * sent it and no attachment moves. A member_joined of theirs goes out with its
   * brief null. Here the two arms part: the poll reads as its caller's account
   * (eventsFor), so an author reads their own brief on another handle's sync and
   * on no socket. The author is judged by their row in `members`, the rows the
   * append read; appendEvent and appendEventOnce hand theirs. An author not among
   * them reads as not granting (R11). Every other caller hands none, and none of
   * their events carries a brief.
   *
   * Synchronous on purpose. getWebSockets, deserializeAttachment, send and
   * serializeAttachment are all sync, so nothing here yields — an await
   * between reading a socket's cursor and sending would reopen the gap that
   * read-and-register exists to close.
   *
   * `#private`, because a Durable Object answers RPC for every method on its
   * class and TypeScript's `private` is erased at compile time. This one fans
   * out to every socket in the room, so reachable from outside would mean an
   * unauthenticated caller pushing frames to every watcher.
   *
   * main's version opened with `if (this.waiters.length === 0) return;`. That
   * is deliberately absent here: it would skip socket delivery whenever nobody
   * is long-polling, which is the common case once the bridge stops polling.
   */
  #wake(events: SessionEvent | readonly SessionEvent[], members: readonly Member[] = []): void {
    // Several events, in cursor order, are one wake: a write that carried cards hands a long poll all of them
    // at once (surface frames), at most the poll's `limit`, and each socket is sent them in order.
    const all: readonly SessionEvent[] = Array.isArray(events) ? events : [events as SessionEvent];
    if (all.length === 0) return;
    const last = all[all.length - 1].cursor;
    const woken = this.waiters.filter((w) => last > w.after);
    this.waiters = this.waiters.filter((w) => last <= w.after);
    for (const w of woken) w.resolve(all.filter((e) => e.cursor > w.after).slice(0, w.limit));

    for (const event of all) this.#sendToSockets(event, members);
  }

  /** `#wake`'s socket arm, for one event. `#private` for `#wake`'s reason. */
  #sendToSockets(event: SessionEvent, members: readonly Member[]): void {
    // Decided on the first socket that is due the event and shared by the rest: a
    // poll-only room pays nothing per append, and a projection failure lands in
    // the per-socket try below instead of failing an append whose event is
    // already stored. Null is a decision too, the event shown to no socket.
    let frame: string | null | undefined;
    for (const ws of this.ctx.getWebSockets()) {
      // One socket must not starve the rest. getWebSockets() returns a list, and
      // a throw would end this loop with every later socket missing the event,
      // after the waiter arm had run and the event was stored. So each socket is
      // its own try: log, skip, carry on. The cause known today is building the
      // frame, JSON.stringify(publicEvent(shown)), which sits inside the try and
      // which "contains a frame that cannot be built" drives. The one send
      // failure observed, to a socket that is closing, is skipped below instead
      // of caught; a send to a socket that reads OPEN has not been observed to
      // throw, and the catch stays for the cause nobody has seen. The cursor
      // moves only after a send that returned, and a reconnect replays from the
      // cursor its client names (fetch).
      try {
        // A socket that is closing or closed is skipped, before anything is read
        // from it, and is not an error worth a log line. The common case is one
        // webSocketMessage has closed, and a client sending a frame is what the
        // receive-only rule exists for, so this is a normal path: the runtime
        // goes on listing the socket until its peer acknowledges, reading
        // CLOSING (still listed 23 s on for a peer that never did, and the same
        // on an instance revived after eviction; measured), and a send to it
        // throws. Left to the catch below, a client that sends again and again
        // is one logged failure per append.
        //
        // That is all this decides: do not bother. It says nothing about what a
        // socket has received. Exactly CLOSING and CLOSED skip, so a reading
        // nobody expected still sends and delivery cannot stop silently on it.
        // CLOSED is defensive. workerd reports 3 inside webSocketClose, after
        // the peer acknowledges a close this object started, and the socket is
        // gone from getWebSockets() afterwards, so wake() has not been seen to
        // meet a CLOSED socket. The arm stays because a send to one cannot
        // succeed.
        if (!isOpen(ws)) continue;
        const att = ws.deserializeAttachment() as SocketAttachment | null;
        // Fail closed on a missing attachment. fetch() attaches before it sends,
        // so every accepted socket has one; a null here means something is
        // wrong, and over-delivering every event to a socket whose cursor we do
        // not know is the worse of the two answers.
        if (!att || event.cursor <= att.cursor) continue;
        if (frame === undefined) {
          const shown = readableEvent(event, members.find((m) => m.memberId === event.fromMemberId), null);
          frame = shown === null ? null : JSON.stringify(publicEvent(shown));
        }
        if (frame === null) break;
        ws.send(frame);
        ws.serializeAttachment({ ...att, cursor: event.cursor });
      } catch (err) {
        console.error("socket delivery failed:", err);
      }
    }
  }

  /**
   * Close every socket whose attachment names only members a creator removed (#113).
   *
   * `#private` for `#wake`'s reason: a Durable Object answers RPC for every method on its
   * class, so a reachable version would let any caller holding the SESSION binding close a
   * room's sockets.
   *
   * Run after a write that recorded a cut, and only then: an append carrying `markRemoved`,
   * or a `removeMember` whose caller asked to cut. It reads the roster, which is a storage
   * read no write that cut nobody should pay. It looks at every socket in
   * the room and not just the removed member's, so a socket an earlier removal missed is
   * closed by the next removal in the room. Nothing re-runs the pass for a missed removal
   * that no later one follows: a pass that failed, or an object that went away between the
   * commit and the pass, leaves that member's socket open until then.
   *
   * A socket survives if ANY member it names is still uncut: the socket is per identity
   * and one live handle entitles it (D5). "Uncut" includes a member who left and one whose
   * seat timed out, because the predicate is "was removed" and not "has left" (R2). An
   * attachment naming a member the roster does not hold counts as neither. It cannot
   * entitle the socket and it cannot condemn it, so such a socket is left alone, which is
   * the direction `#wake` fails in on a missing attachment.
   *
   * It never throws. The append has committed and the wake has gone out, so a failure here
   * must not turn it into an error for the caller: evictMember would report a removal that
   * failed when it had not, and skip the audit row it writes next.
   */
  async #closeCutSockets(): Promise<void> {
    try {
      const s = await this.stored();
      if (!s) return;
      // The members the sockets name, read by row: a removed member has left, so it is
      // not on the record (ADR 0019).
      const named = await this.#membersById(s, this.#attachedIds());
      const cut = new Set(named.filter(isRemovedMember).map((m) => m.memberId));
      const known = new Set(named.map((m) => m.memberId));
      for (const ws of this.ctx.getWebSockets()) {
        // One socket must not starve the rest, for the reason #wake gives: a throw would
        // leave every later socket unclosed, and a socket that stays open is the open feed.
        try {
          if (!isOpen(ws)) continue;
          const ids = (ws.deserializeAttachment() as Partial<SocketAttachment> | null)?.memberIds;
          if (!Array.isArray(ids)) continue;
          const named = ids.filter((id) => known.has(id));
          if (named.length === 0 || named.some((id) => !cut.has(id))) continue;
          // Within 123 bytes of UTF-8: ws.close() throws above that and the throw leaves
          // the socket open, so enforcement would become an exception. The reason is what
          // a developer reads in their client.
          ws.close(1008, "You were removed from this room. Its history is still readable over /mcp.");
        } catch (err) {
          console.error("closing a removed member's socket failed:", err);
        }
      }
    } catch (err) {
      console.error("closing a removed member's sockets failed:", err);
    }
  }

  /**
   * One queued write, delivered to the registry's index or to an org's audit stream.
   *
   * `#private` rather than `private`, because TypeScript's is erased at compile time
   * and a Durable Object answers RPC for every method on its class. A `private` one
   * could be called by anything holding the SESSION binding, which would register any
   * code against any session. RegistryDO's delivery is hidden for the same reason.
   *
   * Throwing leaves the row queued, with the rows behind it, and the driver retries
   * it later. An unknown kind throws rather than returning, so a row this build
   * cannot deliver waits for one that can instead of being dropped.
   */
  async #deliver(row: OutboxRow): Promise<void> {
    const registry = () => this.env.REGISTRY.get(this.env.REGISTRY.idFromName("registry"));
    if (row.kind === "join_code_put") {
      const { code, sessionId } = row.payload as { code: string; sessionId: string };
      await registry().putJoinCode(code, sessionId);
    } else if (row.kind === "join_code_drop") {
      await registry().dropJoinCode((row.payload as { code: string }).code);
    } else if (row.kind === "audit") {
      const entry = row.payload as AuditEntry;
      // A falsy org is not a stall, it is a misfile: a namespace accepts null
      // and "" as names, so this row WOULD be delivered, into a stream nobody
      // reads. Dropped here instead, and the row still counts as delivered.
      // ARCHITECTURE.md section 9, runtime fact 4.
      if (!entry.orgId) return;
      await this.env.AUDIT.get(this.env.AUDIT.idFromName(entry.orgId)).append(entry, row.id);
    } else if (row.kind === "host") {
      await this.#deliverHost(row);
    } else if (row.kind === "hosted_release") {
      const { userId, sessionId } = row.payload as { userId: string; sessionId: string };
      await registry().releaseHostedRoom(userId, sessionId);
    } else if (row.kind === "creator_ban") {
      const { creatorId, ban } = row.payload as { creatorId: string; ban: CreatorBan };
      await registry().putCreatorBan(creatorId, ban);
    } else {
      throw new Error(`outbox: unknown kind ${row.kind}`);
    }
  }

  /**
   * A wake for the hosted seat (hosted seat spec, D4), delivered to the room's own
   * `HostDO` by RPC. The row's id goes with it, as an audit row's does. A throw here
   * leaves the row queued, so the outbox redelivers it, and the seat drops a wake whose
   * cause it has already handled.
   */
  async #deliverHost(row: OutboxRow): Promise<void> {
    const wake = row.payload as HostWake;
    await this.env.HOST.get(this.env.HOST.idFromName(wake.sessionId)).wake(wake, row.id);
  }

  /**
   * The object's single alarm, shared by name: the driver reports which handlers
   * are due and this dispatches on them. The outbox drains here when the inline
   * attempt never ran or could not finish, and the abandonment time fires here rather
   * than in a global sweep.
   *
   * Nothing here clears a handler's due time. Each decides its next one from state
   * it has already changed, so a handler that throws keeps its due time and the
   * alarm is retried instead of forgotten. The outbox's drain moves its own marker,
   * deleting it when the queue is empty and dating it ahead after a failure. The
   * abandonment handler is idempotent: closeIfAbandoned does nothing to a session that
   * is closed or not yet abandoned. The heartbeat's moves its own clock:
   * #tickIfDue advances `lastTickAt` on every firing, written or not, so the time
   * derivedDue returns next is in the future. Housekeeping's moves with what it
   * raises: a proposal puts that key's next time a window after the raise
   * (`nextHousekeepAt`), and a firing that finds nothing due writes nothing and leaves
   * every time ahead, because the times it derives are the ones it acts on.
   *
   * **The loop's order is `dueNames`' alphabet, which is not a priority.** A firing
   * delayed past `abandonedAt` finds "abandoned" and "heartbeat" both due and runs
   * the close first, because "a" sorts before "h". That is the right order for this
   * pair, and it is right by accident: before #18 the room's clock had a name that
   * sorted after the tick's, and the tick ran first. Each handler therefore reads
   * the state it needs for itself rather than relying on its place here: #tickIfDue
   * and #housekeepIfDue refuse an abandoned room with the same `isAbandoned` test
   * #closeIfAbandoned uses. A rename would undo the order and leave the next pair to
   * be discovered, and the handler that reads its own precondition is the one a
   * reader can check.
   *
   * **"purge" and "sweep" can be due at one firing, and the purge wins** (#65): a room
   * closed with a window of nothing, or an alarm that ran late past the window. The
   * purge deletes every object under the prefix and then the record, so a sweep first
   * is work thrown away, and one after it finds no record to read. "purge" sorts before
   * "sweep" today, and #sweepIfDue does not lean on that: it returns when the purge is
   * due, and worker-tests/purge.test.ts runs the names the other way round to hold it.
   *
   * Each handler reads the session itself, inside the transaction it writes in, so
   * nothing is passed down from here: a record read in this loop and written by a
   * later iteration would be the stale snapshot #tickIfDue's own comment is about.
   *
   * Every name the driver can report needs a branch below. A name with none is never
   * consumed, and the closing reArm() points the alarm straight back at its due time,
   * so the alarm fires back to back for good. A build with no "outbox" branch does
   * exactly that to an object holding a `due:outbox` row, so roll back past this one
   * only after clearing them.
   *
   * The closing reArm() is what keeps the abandonment time alive when this ran for
   * another reason. A fired alarm is consumed, so without it a live session would be
   * left with none.
   *
   * It is also what covers the boundary, so the abandonment time needs no re-arm of
   * its own. closeIfAbandoned acts only once now is past abandonedAt and the driver
   * counts a handler due AT its time, so a firing exactly on abandonedAt finds the
   * abandonment time due, closes nothing, and reArm() points the alarm at abandonedAt
   * again, due at once. The first firing to read now > abandonedAt closes the room,
   * and a closed room derives no abandonment time, so that firing arms nothing. The
   * re-arm is not strictly after the boundary: a firing can land in the same
   * millisecond and go round once more, and the clock is what ends it. A
   * socket-watched room is not polled, so no getSession is there to close it lazily;
   * this is the only thing that does.
   *
   * A socket vouching past the window is the third case: the handler stamps and the
   * derived time moves a window ahead, so that firing is not repeated either.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    for (const name of await this.driver.dueNow(now)) {
      try {
        if (name === OUTBOX_HANDLER) await this.driver.deliverNow();
        if (name === ABANDONED_HANDLER) {
          const s = await this.stored();
          if (s) await this.#closeIfAbandoned(s, now);
        }
        if (name === HEARTBEAT_HANDLER) await this.#tickIfDue(now);
        if (name === HOUSEKEEP_HANDLER) await this.#housekeepIfDue(now);
        if (name === PURGE_HANDLER) await this.#purgeIfDue(now);
        if (name === SWEEP_HANDLER) await this.#sweepIfDue(now);
        if (name === SEAT_HANDLER) await this.#seatSilenceIfDue(now);
        if (name === EXPIRY_HANDLER) await this.#expireOutsideIfDue(now);
        if (name === DECISION_HANDLER) await this.#expireDecisionsIfDue(now);
      } catch (error) {
        // The runtime retries a throwing alarm a few times and then leaves it with nothing armed
        // (a read of the room arms it again: getSession), and it says nothing of which object it
        // gave up on. This line is the one record of the room and the handler. Rethrown, so the
        // runtime still retries (review I1).
        console.error(`alarm handler "${name}" failed for room ${await this.#roomIdForLog()}:`, error);
        throw error;
      }
    }
    await this.driver.reArm();
  }

  /**
   * The room's id for a log line: from the record, else the name the object was addressed by.
   * Never a second failure. The storage that made a handler throw may not answer a read, and the
   * line it is for must still be written.
   *
   * `#private`, for the reason #purgeIfDue gives.
   */
  async #roomIdForLog(): Promise<string> {
    try {
      return (await this.stored())?.id ?? this.ctx.id.name ?? this.ctx.id.toString();
    } catch {
      return this.ctx.id.name ?? this.ctx.id.toString();
    }
  }

  /**
   * Due times this object computes rather than stores. A closed session has nothing
   * left to enforce but its own end (#65): the sweep of its unnamed objects, once, and
   * the purge, at the window's end or when a delete asked. A room kept until deleted
   * owes the sweep alone, and one closed before the close was dated owes nothing at
   * all. Deriving the abandonment time for it would re-arm the alarm to a moment
   * already past, and it would fire again for as long as the session existed; neither
   * of these can, because a firing that runs the sweep sets `blobsSwept`, and one that
   * runs the purge deletes the record and a derivation from a missing record answers
   * nothing. It has no tick to send either, which is why the early return covers
   * both. A frozen room derives neither (both functions answer null for it), and
   * reArm() never clears an alarm, so a freeze leaves the one already armed to fire
   * once, find nothing due and arm nothing after it. The thaw re-arms.
   *
   * Every name derived here has a branch in alarm() that consumes it, or it is never
   * consumed and the closing reArm() points the alarm straight back at it for good.
   * The close-time sweep (`sweepDueAt`) is consumed by setting `blobsSwept`, which
   * moves it out of this map, so it fires once.
   *
   * `read` is the record a caller already holds, so `getSession` asks its question of the one
   * it is about to return and not of a second read of the same row.
   */
  async #derivedDue(read?: StoredSession): Promise<Map<string, number>> {
    const s = read ?? await this.stored();
    if (!s) return new Map();
    const due = new Map<string, number>();
    // Before the closed room's early return, and in a frozen room too: a room that closed or froze with a decision
    // open still owes it its close, and the clock's close ignores a freeze.
    const deadline = earliestDeadline(s.openDecisions ?? {});
    if (deadline !== null) due.set(DECISION_HANDLER, deadline + 1);
    if (s.closed) {
      // A closed room owes two things and nothing else (#65): the sweep of its unnamed
      // objects, once, and the purge at its window's end or when a delete asked.
      const sweep = sweepDueAt(s);
      if (sweep !== null) due.set(SWEEP_HANDLER, sweep);
      const purge = purgeDueAt(s);
      if (purge !== null) due.set(PURGE_HANDLER, purge);
      return due;
    }
    // Derived rather than a stored `due:` row, deliberately. A name the driver
    // can report with no branch in alarm() is never consumed, and the closing
    // reArm() fires the alarm back to back for good: the rollback hazard this
    // object's alarm() comment records for `due:outbox`. A build that does not
    // know this name does not compute it either, so rolling back strands nothing.
    const abandoned = abandonedAt(s);
    if (abandoned !== null) due.set(ABANDONED_HANDLER, abandoned);
    const tick = nextTickAt(s);
    if (tick !== null) due.set(HEARTBEAT_HANDLER, tick);
    const housekeeping = nextHousekeepAt(s, Date.now());
    if (housekeeping !== null) due.set(HOUSEKEEP_HANDLER, housekeeping);
    // Consumed by #seatSilenceIfDue, which removes every entry it finds due, so the time moves on.
    const waits = Object.values(s.seatWaits ?? {});
    if (waits.length > 0) due.set(SEAT_HANDLER, Math.min(...waits));
    // An open outside task's lifetime. Not in a frozen room (a freeze costs nobody their question's time: the thaw
    // re-arms), and consumed by #expireOutsideIfDue, which moves the number on or clears it.
    if (typeof s.outsideExpiryAt === "number" && s.frozenAt === null) due.set(EXPIRY_HANDLER, s.outsideExpiryAt);
    return due;
  }

  /**
   * `#private`, because it overwrites the session with the record it is handed and queues
   * the registry's removal of every code in it. A Durable Object answers RPC for every
   * method on its class, so a TypeScript `private` one would let anything holding the
   * SESSION binding rewrite a room and reach into the registry's index.
   *
   * Reached from the alarm and from any read that finds the room abandoned. Two
   * outcomes past the window. A socket vouching for an active member means the room
   * is not abandoned whatever `lastSeenAt` says, and that is written down: those
   * members are stamped as seen now, the stamp `webSocketClose` makes on a drop
   * (#152) made on a schedule, so reArm() points the alarm a window ahead instead
   * of straight back at this one. Otherwise the room closes: the close, the registry
   * removals its codes owe and the `session_expired` event are one commit (#124).
   * Split, an interruption after the close left a room closed with no event, and
   * nothing wrote one afterwards, because the retry found the room closed and had
   * nothing left to do. In one transaction an interruption leaves the room as it
   * was, still abandoned, and the next read or the alarm does all of it again.
   */
  async #closeIfAbandoned(s: StoredSession, now: number): Promise<void> {
    const due = abandonedAt(s);
    if (due === null || now <= due) return;
    // The sockets as they are now, so the decision and the write are made against
    // the same set. Nothing but storage is awaited between the read that produced
    // `s` and the put below, so the input gate holds across both.
    const connected = await this.#connected(s);
    if (!isAbandoned(s, now, connected)) {
      // The stamped members' rows, in one transaction however many there are (ADR 0019).
      const rows = memberRows(s, { ...s, members: stampSeen(s.members, now, connected) });
      await this.ctx.storage.transaction(async (txn) => { await putRows(txn, rows); });
      return;
    }
    // The close clears the session's codes, so their rows leave the registry's index
    // with it, in the same transaction. Otherwise an abandoned room's codes stay there
    // for good. They are already inert, because getSessionByJoinCode refuses a closed
    // session; this is about not leaking rows.
    // And a hosted room gives its creator's slot back (I7), by the same outbox.
    const intents = [...Object.values(s.joinCodes).map((rec) => dropCodeIntent(rec.code)), ...hostedReleaseIntents(s)];
    // The cursor is read in the transaction that writes the event (see nextCursor), and
    // every write is to this object's own storage, so a transaction is enough and no
    // outbox is needed for the event.
    let notices: SessionEvent[] = [];
    const event = await this.ctx.storage.transaction<SessionEvent>(async (txn) => {
      const rows = await this.driver.enqueue(txn, intents);
      // The room's open outside tasks end with it, notices first so `session_expired` is the last thing in the log (A2A).
      const end = await this.#endOutside(txn, s, "closed", now);
      notices = end.events;
      const expired: SessionEvent = {
        cursor: await this.nextCursor(txn),
        type: "session_expired",
        fromMemberId: "system",
        fromUserId: "system",
        fromLabel: "bellman",
        payload: { reason: "abandoned", last_seen_at: new Date(due - ABANDONED_AFTER_MS).toISOString() },
        refId: null,
        at: now,
      };
      await this.#writeEvent(txn, s, expired, {
        session: { ...end.session, closed: true, closedAt: s.closedAt ?? now, joinCodes: {} }, ...rows,
      });
      return expired;
    });
    for (const notice of notices) this.#wake(notice, s.members);
    this.#wake(event);
    // The purge is due from the close (#65). The alarm that reaches here re-arms on its
    // way out, and a read that finds the room abandoned does not, so the close does.
    await this.driver.reArm();
    // Last, so a poll woken above does not wait on the registry. Reached from the
    // alarm and from any read that finds the room abandoned, and both drain here
    // rather than leave the rows for the next alarm.
    if (intents.length > 0) await this.driver.deliverNow();
  }

  /**
   * Ask the room's members where they are, if any of them owes an answer.
   *
   * `#private` for the reason every writing method on this class is: a Durable
   * Object answers RPC for every method on it and TypeScript's `private` is
   * erased, so a plain stub could otherwise forge a tick into any room.
   *
   * **The guards are the point of this method, not a formality.** It writes
   * through `#writeEvent`, as `#closeIfAbandoned` does, which means it does NOT
   * inherit `appendEvent`'s frozen check. Without them:
   *
   * - A **frozen** room gets ticks naming members silent who cannot report out
   *   of it, and a freeze must cost nobody their standing — the same rule that
   *   keeps `seatMember` from reclaiming a seat in a frozen room.
   * - A **closed** room gets a tick nobody can answer, because every send into
   *   it is refused.
   * - An **abandoned** room gets the same, and it is reachable where the other
   *   two are not: it is not closed until `#closeIfAbandoned` closes it, so a
   *   firing told of the tick alone would ask members who are not there.
   *   `isAbandoned` is `#closeIfAbandoned`'s own test, read here rather than
   *   relying on `dueNames`' order: a guard is checkable where a name's place in
   *   an alphabet is an accident.
   *
   * **One transaction, for the reason `stored()` gives, and it is what makes the
   * clock safe to advance.** The session read, the cursor read and the write are
   * one unit, so the record this writes back is the record it decided on. Read
   * outside, the whole snapshot went back in — reverting anything that landed in
   * between, a freeze and a member's own `lastReportAt` stamp included, which is
   * the one write a tick must never lose, since losing it keeps the member named
   * silent for having answered. `#wake` comes after the commit, so nobody hears
   * of a tick that did not land.
   *
   * The closure makes no cross-object call, so it stays within ARCHITECTURE.md §9
   * runtime fact 2: everything awaited in it is this object's storage. A room with a
   * host ticks on its own cadence whether or not anyone reports, and `tickPlan` decides
   * both whether the tick is written and whether the seat is woken (#188). The seat's
   * wake (hosted seat spec, D4) is queued as an outbox row in the tick's own put, and
   * delivered after the commit.
   *
   * `lastTickAt` advances whether or not an event is written, which is what
   * stops the alarm spinning: the clock has to move even on a firing that found
   * nobody due, or `derivedDue` returns the same past time and `reArm()` points
   * the alarm straight back at it.
   */
  async #tickIfDue(now: number): Promise<void> {
    let wakesHost = false;
    const event = await this.ctx.storage.transaction<SessionEvent | null>(async (txn) => {
      const s = await this.stored(txn);
      if (!s) return null;
      if (s.closed || s.frozenAt !== null) return null;
      const connected = await this.#connected(s, txn);
      if (isAbandoned(s, now, connected)) return null;
      if (s.manifest.heartbeatOnMs === null) return null;

      // Read before the write below moves `lastTickAt`, as `tickPlan` requires.
      const plan = tickPlan(s, now, connected);
      if (!plan.write) {
        // Nothing to ask, but the clock still moves. See the comment above.
        await putRows(txn, memberRows(s, { ...s, lastTickAt: now }));
        return null;
      }

      const tick: SessionEvent = {
        cursor: await this.nextCursor(txn),
        type: "heartbeat",
        // The server is not a member and holds no role, so it needs no verb.
        fromMemberId: "system",
        fromUserId: "system",
        fromLabel: "bellman",
        payload: snapshotOf(s, now),
        refId: null,
        at: now,
      };
      // The event, its cursor and the advanced clock in one put. Committed
      // separately, an interruption between them leaves a tick stored with the
      // clock unmoved, and the next firing writes the same tick again. The seat's
      // wake rides the same put, so a tick that owes one cannot land without it.
      const wake = plan.wakeHost
        ? await this.driver.enqueue(txn, [hostWakeIntent(s.id, "tick", tick.cursor)])
        : {};
      wakesHost = plan.wakeHost;
      // The host's own clock moves only on a tick that wakes it (I3), in the tick's own put.
      const clocks = plan.wakeHost ? { lastTickAt: now, lastHostTickAt: now } : { lastTickAt: now };
      await this.#writeEvent(txn, s, tick, { session: { ...s, ...clocks }, ...wake });
      return tick;
    });
    if (event) this.#wake(event);
    if (wakesHost) await this.driver.deliverNow();
  }

  /**
   * Raise what the room's own thresholds say is due (#66), once per window, and forget what
   * no longer holds. One transaction: the proposals, their cursors and the updated `raised`
   * land together, so an interruption leaves nothing half said and the retry raises the same
   * set.
   *
   * Nothing is written into a room that cannot answer, and that is the point. Which rooms
   * those are (no housekeeping declared, closed, frozen, nobody in it) is `anchors`' gate in
   * housekeeping.ts, asked once for the rules and for this writer alike, and not copied
   * here: a second reading of the same fact could only agree with the first. The proposals
   * go through `#writeEvent`, which bypasses `appendEvent`'s frozen refusal, so that gate is
   * all that stands between a proposal and a frozen room, and the worker cases put it on
   * trial here, with this handler named. An abandoned room is the one thing the rules do not
   * know, and it is refused as #tickIfDue refuses it: the abandoned handler closes it in the
   * same firing and runs first only by the alphabet.
   *
   * Every proposal is written through `#writeEvent`, the path that runs the books. A proposal
   * is a `system` event and owes them nothing today, but every event row goes through one
   * path, so a later change to what the books keep cannot miss this writer.
   *
   * It queues no wake for a hosted seat (ruling H1): a proposal is not one of the seat's two
   * causes, and waking spends the room's host units on the server's initiative.
   *
   * It writes nothing when nothing is due and nothing is to be forgotten, not even the record,
   * so a firing the alarm made early (a member sent between the arming and the firing, which
   * re-arms nothing on the hot path) costs no write. Nothing here advances a clock to stop
   * the alarm spinning: a raise puts that key's next time a window ahead, and a firing that
   * found nothing due had every time ahead already.
   *
   * `#private`, for the reason #tickIfDue gives: it writes events into any room it is handed,
   * and a Durable Object answers RPC for every method on its class.
   */
  async #housekeepIfDue(now: number): Promise<void> {
    const written = await this.ctx.storage.transaction<SessionEvent[]>(async (txn) => {
      const s = await this.stored(txn);
      if (!s) return [];
      if (isAbandoned(s, now, await this.#connected(s, txn))) return [];

      const cleared = clearedKeys(s, now);
      const due = dueFindings(s, now);
      if (cleared.length === 0 && due.length === 0) return [];

      const raised = { ...s.raised };
      for (const key of cleared) delete raised[key];
      let cursor = await this.nextCursor(txn);
      const events: SessionEvent[] = [];
      for (const f of due) {
        raised[f.key] = { at: now, repeat: f.payload.repeat, since: f.payload.since };
        events.push({
          cursor: cursor++,
          type: "housekeeping",
          // The room speaks, not a member: no seat and no verb, as the tick has none.
          fromMemberId: "system",
          fromUserId: "system",
          fromLabel: "bellman",
          payload: f.payload,
          refId: null,
          at: now,
        });
      }
      // The whole record rides each event's put, and every one carries the final `raised`, so
      // the order of the puts inside the transaction does not matter. A forgetting with
      // nothing to say is a put of its own.
      const next: StoredSession = { ...s, raised };
      if (events.length === 0) await putRows(txn, memberRows(s, next));
      for (const e of events) await this.#writeEvent(txn, s, e, { session: next });
      return events;
    });
    for (const e of written) this.#wake(e);
  }

  /**
   * The purge (#65, D2). Bytes first, then what other objects hold about this room,
   * then the record: a crash between leaves a record whose next wake does it all
   * again. What the order guarantees is never bytes that no record can find, the
   * orphan the sweep exists for. It does not keep a record from naming bytes that
   * are gone: between the bucket's delete and the wipe, and after a crash between
   * them until the next wake, the record exists and its objects do not, and a
   * download of one answers 404, as it does for any reference that dangles. Direct
   * calls rather than the outbox, because the outbox rows live in the storage the
   * last step empties.
   *
   * Every step can run twice. The bucket delete, the index drops and the hosted
   * seat's `forget` are idempotent, and the audit entry carries `purge:<room>:<org>` as its intent id,
   * which `AuditDO.append` dedupes on, so a purge retried after a crash, or run by
   * two firings at once, files one entry for each org.
   *
   * What the outbox still owes is delivered before the storage goes, and a row that
   * will not deliver holds the purge back: a `room_deleted` entry, or a member's
   * removal, queued here and not yet filed in an org's stream would be emptied with
   * the rest, and an audit log that quietly drops the record of a delete is not one.
   * The throw is what makes the runtime try again. Once the room is gone its
   * watchers are told (#settleWatchers).
   *
   * `#private`, because it empties this object and a Durable Object answers RPC for
   * every method on its class (ARCHITECTURE.md section 9, runtime fact 3).
   */
  async #purgeIfDue(now: number): Promise<void> {
    const s = await this.stored();
    if (!s) return;
    const due = purgeDueAt(s);
    if (due === null || now < due) return;
    await new R2BlobStore(this.env.BLOBS).deleteAll(s.id);
    const registry = this.env.REGISTRY.get(this.env.REGISTRY.idFromName("registry"));
    await registry.dropCreatedIndex(s.createdBy, s.id);
    await registry.dropRoomIndex(s.id);
    // The close gave the slot back already (I7); a purge makes sure, and the delete is idempotent.
    if (s.manifest.host !== null) await registry.releaseHostedRoom(s.createdBy, s.id);
    // Everyone who ever sat in the room, from the person index rows, since those who left
    // are not on the record (ADR 0019); and every org, which the record keeps.
    const handles = await this.ctx.storage.list({ prefix: USER_PREFIX });
    for (const userId of new Set([...handles.keys()].map(userOfKey))) {
      await registry.dropMembershipIndex(userId, s.id);
    }
    for (const orgId of s.orgs) await registry.dropOrgIndex(orgId, s.id);
    const parties = rosterParties({ members: await this.#everyone() });
    for (const orgId of s.orgs) {
      await this.env.AUDIT.get(this.env.AUDIT.idFromName(orgId))
        .append(roomPurgedEntry(s, orgId, parties, now), `purge:${s.id}:${orgId}`);
    }
    await this.driver.deliverNow();
    if ((await this.ctx.storage.list({ prefix: OUTBOX_PREFIX, limit: 1 })).size > 0) {
      throw new Error(`purge of ${s.id}: the outbox still holds rows owed to other objects`);
    }
    // The hosted seat keeps its own record of the room, the questions it asked among it, in its
    // own object. That goes too: by direct call, for the registry's reason, and after the outbox
    // has drained, so no wake queued here reaches the seat once it is emptied.
    if (s.manifest.host !== null) await this.env.HOST.get(this.env.HOST.idFromName(s.id)).forget();
    await this.ctx.storage.deleteAll();
    // Measured on workerd 1.20260926.1 with SQLite-backed storage, which all five classes
    // here use: deleteAll() clears an armed alarm itself, so this call is redundant there,
    // and dropping it leaves every test green. It stays so that a purged room arms nothing
    // however the storage behaves, and worker-tests/purge.test.ts asserts that outcome.
    await this.ctx.storage.deleteAlarm();
    this.#settleWatchers();
  }

  /**
   * Tell the room's watchers it is gone (#65, review M3): a purged room has no future for them to wait on.
   * A long poll in flight is settled with nothing, as MemoryStore.purgeNow settles it, where it would wait
   * out its own timer on an empty object. A socket is closed, where it would stay attached to an empty
   * object until its client gave up on it.
   *
   * The close is the ordinary 1000, with a reason for the developer reading their client's close event.
   * No close code means "room gone" to the bridge: src/client/room-socket.ts reconnects after any close, whatever
   * its code, and learns the room's state from the upgrade's answer or from its poll.
   *
   * It never throws. The purge has committed, and a socket that will not close must not turn it into an
   * error for the runtime to retry, nor leave the rest of the sockets open: each is its own try, for
   * #wake's reason.
   *
   * `#private`, for the reason #purgeIfDue gives.
   */
  #settleWatchers(): void {
    for (const waiter of this.waiters.splice(0)) waiter.resolve([]);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        if (!isOpen(ws)) continue;
        ws.close(1000, "room purged");
      } catch (err) {
        console.error("closing a purged room's socket failed:", err);
      }
    }
  }

  /**
   * The sweep, when it is owed (#65, D3): the alarm's gate in front of #sweep.
   *
   * **The purge wins when it is due as well.** It deletes every object under the prefix and
   * then the record, so a sweep first is work thrown away. alarm() runs "purge" ahead of
   * "sweep" because of the alphabet, and this does not lean on that (see alarm()): a room
   * whose purge is due is not swept, whichever name came first.
   *
   * `#private`, for the reason #purgeIfDue gives.
   */
  async #sweepIfDue(now: number): Promise<void> {
    const s = await this.stored();
    if (!s) return;
    const due = sweepDueAt(s);
    if (due === null || now < due) return;
    const purge = purgeDueAt(s);
    if (purge !== null && now >= purge) return;
    await this.#sweep(s);
  }

  /**
   * Delete the objects under this room's prefix that no surface item names, and credit the
   * room their bytes, once. The bucket is outside any transaction, as the purge's is: a
   * delete here holds this object for as long as R2 takes if it sits inside one.
   *
   * The objects are listed before the rows are read, so an object an item names is listed
   * first and named after, never the reverse. The record is read again inside the
   * transaction that writes it, and only a sweep that finds `blobsSwept` still false
   * credits the room: two that overlap list the same objects and free the same bytes, and
   * the second would otherwise take them off twice. A purge that got in between leaves no
   * record to write to, and nothing is.
   *
   * A delete that fails throws before the record is touched, so `blobsSwept` stays false
   * and the next firing starts again. The bytes of the objects removed before the failure
   * are then not credited, since they cannot be listed twice. The room is closed, so
   * nothing charges it again, and the purge deletes whatever is left.
   *
   * A member's own append can land after the sweep's read of the rows: a member whose
   * surface write passed its gate and whose own leave then closed the room leaves an item
   * naming an object the sweep has deleted and credited. It takes a writer racing its own
   * leave, since another member's seat keeps the room open, and the download's 404 covers
   * an item that names bytes that are gone, so no code here tries to prevent it.
   *
   * `#private`: it deletes from the bucket on the strength of the record it is handed.
   */
  async #sweep(s: StoredSession): Promise<{ removed: number; credited: number }> {
    const blobs = new R2BlobStore(this.env.BLOBS);
    const listed = await blobs.list(s.id);
    const orphans = unnamedObjects(listed, await this.surfaceOf());
    let credited = 0;
    for (const object of orphans) {
      await blobs.delete(s.id, object.id);
      credited += object.bytes;
    }
    await this.ctx.storage.transaction(async (txn) => {
      const live = await this.stored(txn);
      if (!live || live.blobsSwept) return;
      await putRows(txn, memberRows(live, {
        ...live, blobBytes: creditedBlobBytes(live.blobBytes ?? 0, credited), blobsSwept: true,
      }));
    });
    return { removed: orphans.length, credited };
  }
}
