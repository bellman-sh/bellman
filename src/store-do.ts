/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from "cloudflare:workers";
import {
  allKeysFor, declineKey, declinesPrefix, domainKey, grantKey, idpKey, inviteKeysFor, keyInvitesPrefix, orgIndexKey, orgIndexPrefix,
  orgInvitesPrefix, orgKey, scimKeyIndex, scimNameKey, scimTokenIndex, scimTokenKey, scimUserKey, scimUserPrefix, staleIndexKeys,
} from "./grant-index.js";
import { MAX_PENDING_INVITES, isUnownedSeat, scimSeatKey, takesUnownedSeat } from "./orgs.js";
import { isBanId, newBanId, oldestFirst, type Ban, type CreatorBan } from "./bans.js";
import type { Suspension } from "./suspension.js";
import { SWEEP_RPC_BUDGET, codeIsLive, isPublic, patchedOrg, purchasedOrg, sameEntry, scimGrant, type ScimCreate, type ScimUpdate } from "./store.js";
import type { BlobCharge, GrantDelete, GrantWrite, HostAppend, HostedSlot, PublicNameEntry, PurgeSchedule, SetJoinCode } from "./store.js";
import type {
  ArrivingMember, AuditEntry, Brief, Member, NewSession, PendingConnect, PlanGrant, PublicView, SavedPreset, Session, UserRecord,
  SessionEvent, SurfaceRow,
  Org, OrgIdp, OrgInvite, OrgPatch, ScimToken, ScimUser, ScimUserPatch, DirectoryEntry,
} from "./types.js";
import type {
  AppendExtras, BellmanStore, DepartedMembers, EventWrite, HostInstructionsSet, MemberPatch, RemovalOutcome, RemovalRequest,
  SeatOutcome,
} from "./store.js";
import {
  ABANDONED_AFTER_MS, HOST_MEMBER_ID, abandonedAt, capacityOf, connectedAmong, creatorOf, creditReport,
  decideBlobCharge, decideHostCharge, departures, hostSeated, hostSentEntries, isAbandoned, isActiveMember,
  isActivePerson, isRemovedMember, isReplyToHost, markRemoved, noteAppend, rosterParties, seatInOrder, seatVictims,
  stampSeen,
} from "./store.js";
import {
  BRIEF_PREFIX, KEYS_PER_CALL, MEMBER_PREFIX, briefKey, getRows, labelKey, legacyRows, loadPresent, memberKey, memberRows,
  putRows, seatRows, seated, userOfKey, userPrefix, USER_PREFIX, type RowReader,
} from "./member-rows.js";
import { hostWakeIntent, type HostWake } from "./host.js";
import type { HostDO } from "./host-do.js";
import { fingerprint, idempotencyKey, type IdempotencyRecord } from "./idempotency.js";
import { hydrateStoredSession, type StoredSession } from "./stored-session.js";
import { publicEvent, readableEvent, readableEvents } from "./public-event.js";
import { PING, PONG } from "./keepalive.js";
import {
  AUDIT_COLUMNS, FACET_LIMIT, auditWhere, entryOf, recordOf,
  type AuditActor, type AuditFacets, type AuditPage, type AuditQuery, type AuditRecord,
} from "./audit.js";
import { grantAuditEntries, orgAuditEntries, orgEventEntry, revokeAuditEntries, scimUserEntry, takenSeatAuditEntries, type AuditIntent } from "./grant-audit.js";
import { OUTBOX_HANDLER, OUTBOX_PREFIX, OutboxDriver, dueKey, type OutboxIntent, type OutboxRow } from "./outbox.js";
import {
  REPORT_PURGE_HANDLER, REPORT_RETENTION_MS, REPORT_WINDOW_MS, REPORTS_PER_DAY, reachesCreator, reportId, targetKey, withinWindow,
  type FiledReport, type NewReport, type Report,
} from "./reports.js";
import { R2BlobStore } from "./blobs-r2.js";
import {
  PURGE_HANDLER, SWEEP_HANDLER, creditedBlobBytes, orgsOnRoster, purgeDueAt, roomDeletedEntry, roomPurgedEntry,
  sweepDueAt, unnamedObjects,
} from "./retention.js";
import { clearSilence, nextTickAt, snapshotOf, tickBroughtForward, tickPlan } from "./heartbeat.js";
import { HOUSEKEEP_HANDLER, bringsForward, clearedKeys, dueFindings, nextHousekeepAt } from "./housekeeping.js";
import { UPGRADE_REQUIRED, wantsWebSocket } from "./upgrade.js";
import { reviving } from "./rpc-error.js";
import { applySurfaceWrite, needsPlacement, withPlacement } from "./surface.js";
import { presetInNewWords } from "./presets.js";
import { admitAt, isStrangerKey, type SendAdmission } from "./send-limit.js";

/**
 * Durable Objects implementation of BellmanStore.
 *
 * Topology — the three classes in this file, of the five Durable Object classes
 * (AuthDO is in src/oauth/store.ts, HostDO in src/host-do.ts), each matching a
 * real scope in the data:
 *
 *   SessionDO   one per room. Holds the session record, its events, its surface
 *               rows, bans and outbox, the live long-poll waiters, each member's
 *               send count and the room's sockets. Every request for a room
 *               routes to the same instance,
 *               which is what makes an in-memory waiter list correct here and
 *               what gives read-then-register its atomicity.
 *   RegistryDO  singleton. What resolves without a room in hand: join codes,
 *               pending connect tokens, plan grants, create counts, the creator,
 *               joined-rooms and org-rooms indexes, saved presets, hosted-room
 *               slots, creator-wide bans, suspensions and the report queue.
 *   AuditDO     one per org, so an org's audit stream is physically its own
 *               object. A cross-org room writes to each, and neither org's
 *               DO is reachable from the other.
 *
 * On sweep(): MemoryStore scans every session on a timer. There is no cheap
 * global iteration across a DO namespace, so abandonment is enforced by a
 * per-object alarm and connect tokens expire lazily on read. sweep() is
 * therefore a no-op — see the comment on the method. The registry's alarm
 * deletes a resolved report on a date it keeps (`report_purge`).
 */

const CURSOR_PAD = 12;
const eventKey = (cursor: number) => `e:${String(cursor).padStart(CURSOR_PAD, "0")}`;
/** One row per surface item (#129). The key is a slug, so the prefix is injective. */
const surfaceKey = (key: string) => `sf:${key}`;
const SURFACE_PREFIX = "sf:";
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
 * The org index's prefix, `uo:<org>:` (#65, D5). The org segment is percent-encoded, so an org id
 * that spells the separator cannot make one org's prefix reach another's rows. Org ids are
 * `[A-Za-z0-9_-]` where grants are written (isOrgId), but an identity's org can come from a key
 * map nobody validated, and grant-index.ts makes the same argument at more length.
 */
const orgRoomPrefix = (orgId: string): string => `uo:${encodeURIComponent(orgId)}:`;
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

type Waiter = { after: number; resolve: (events: SessionEvent[]) => void };

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
const auditIntent = (entry: AuditEntry): OutboxIntent => ({
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
  let surfaceCursor = s.surfaceCursor ?? 0;
  if (extras.surface !== undefined) {
    const key = surfaceKey(extras.surface.key);
    const verdict = applySurfaceWrite(await txn.get<SurfaceRow>(key), event, extras.surface);
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
 * A room is held to 64 rows by `writeSurface`, so the list is small; the upgrade is a row of the taken
 * cells beside the surface cursor, if a room ever outgrows that.
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
   * (#144). The client that sends it (src/room-socket.ts) and the fake server
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
      const intents = [...(leaving || banning ? req.audit : []), ...(retiring ? retiring.audit : [])]
        .filter((e) => e.orgId)
        .map(auditIntent);
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
        { ...s, members, joinCodes },
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
    await this.ctx.storage.transaction(async (txn) => {
      const s = await this.stored(txn);
      if (!s) return;
      // A hosted room's slot goes back with the close, in its transaction (I7).
      const intents = hostedReleaseIntents(s);
      released = intents.length > 0;
      const rows = released ? await this.driver.enqueue(txn, intents) : {};
      // `closedAt` once (#65): the window starts at the first close, and a second one
      // does not move it.
      await putRows(txn, { ...memberRows(s, { ...s, closed: true, closedAt: s.closedAt ?? Date.now() }), ...rows });
    });
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
    const closed = await this.ctx.storage.transaction(async (txn) => {
      const s = await this.stored(txn);
      if (!s) return false;
      if (s.closed) return true;
      if (s.members.some(isActivePerson)) return false;
      // A hosted room's slot goes back with the close, in its transaction (I7).
      const intents = hostedReleaseIntents(s);
      released = intents.length > 0;
      const rows = released ? await this.driver.enqueue(txn, intents) : {};
      await putRows(txn, { ...memberRows(s, { ...s, closed: true, closedAt: s.closedAt ?? Date.now() }), ...rows });
      return true;
    });
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
    const dropped = await this.ctx.storage.transaction(async (txn) => {
      const s = await this.stored(txn);
      if (!s || s.unpublishedAt != null) return false;
      const permanent = Object.entries(s.joinCodes).filter(([, rec]) => rec.expiresAt === null);
      const rows = await this.driver.enqueue(txn, permanent.map(([, rec]) => dropCodeIntent(rec.code)));
      const joinCodes = { ...s.joinCodes };
      for (const [role] of permanent) delete joinCodes[role];
      await putRows(txn, { ...memberRows(s, { ...s, unpublishedAt: at, joinCodes }), ...rows });
      return permanent.length > 0;
    });
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
  #wake(event: SessionEvent, members: readonly Member[] = []): void {
    const woken = this.waiters.filter((w) => event.cursor > w.after);
    this.waiters = this.waiters.filter((w) => event.cursor <= w.after);
    for (const w of woken) w.resolve([event]);

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
    const event = await this.ctx.storage.transaction<SessionEvent>(async (txn) => {
      const rows = await this.driver.enqueue(txn, intents);
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
        session: { ...s, closed: true, closedAt: s.closedAt ?? now, joinCodes: {} }, ...rows,
      });
      return expired;
    });
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
   * No close code means "room gone" to the bridge: src/room-socket.ts reconnects after any close, whatever
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

// ---------------------------------------------------------------------------
// RegistryDO — singleton: how you FIND a session
// ---------------------------------------------------------------------------

/** One definition of "expired", so every path agrees on what a grant is. */
/** One record per person, and the count beside them (#258). */
const userKey = (userId: string): string => `us:${userId}`;
const USER_COUNT = "us:count";

/**
 * `cb:<creator>:<user>` is an account a creator banned from every room they own (abuse protections spec,
 * section 1), one row each, so a seating asks one `get`. Both segments are percent-encoded, so the colon
 * between them is the only one in a key. An operator-issued user id may hold a colon, and unencoded,
 * `cb:u_x:` would begin the rows of a creator named `u_x:y`.
 */
const creatorBanPrefix = (creatorId: string): string => `cb:${encodeURIComponent(creatorId)}:`;
const creatorBanKey = (creatorId: string, userId: string): string =>
  `${creatorBanPrefix(creatorId)}${encodeURIComponent(userId)}`;

/** `su:<user>` is a suspended account (abuse protections spec, section 1), its id percent-encoded as `cb:`'s are. */
const suspensionKey = (userId: string): string => `su:${encodeURIComponent(userId)}`;

/**
 * Reports (abuse protections spec, section 3) are six kinds of row and a due row, all in the registry:
 * - `rp:<id>` is the report. An id sorts in filing order, so a listing of the prefix is the queue.
 * - `ro:<id>` holds the id of a report while it is open: written when it is filed, deleted when it is resolved. The
 *   operator's queue lists open reports first, and this is how it reads them without reading every report there is.
 * - `rf:<reporter>:<sessionId>:<targetKey>` holds the id of the open report that account filed about that target:
 *   what a repeat folds into (R9). Resolving the report deletes it.
 * - `rl:<reporter>` holds the times of the account's filings still inside the day (R10), a `number[]`. It only serves
 *   that limit, so the purge deletes it once its newest time has left the day.
 * - `rc:<creator>:<sessionId>:<id>` holds the id of a report that reaches the creator (`reachesCreator`: about a member
 *   or a message, and not about the creator's own account), so a creator's view of one room is a listing of a prefix.
 * - `rr:<purgeAt>:<id>` holds the id of a resolved report, dated for its deletion, the time padded to 15 digits so
 *   string order is time order. `due:report_purge` is the earliest of those dates.
 * The reporter and the creator are percent-encoded, as `cb:`'s segments are: an operator-issued user id may hold a
 * colon, and unencoded one account's prefix would cover the rows of another whose id extends it.
 */
const REPORT_PREFIX = "rp:";
const reportKey = (id: string): string => `${REPORT_PREFIX}${id}`;
const reportFoldKey = (reporterId: string, sessionId: string, target: string): string =>
  `rf:${encodeURIComponent(reporterId)}:${sessionId}:${target}`;
const REPORT_OPEN_PREFIX = "ro:";
const reportOpenKey = (id: string): string => `${REPORT_OPEN_PREFIX}${id}`;
const REPORT_TIMES_PREFIX = "rl:";
const reportTimesKey = (reporterId: string): string => `${REPORT_TIMES_PREFIX}${encodeURIComponent(reporterId)}`;
const reportCreatorPrefix = (creatorId: string, sessionId: string): string =>
  `rc:${encodeURIComponent(creatorId)}:${sessionId}:`;
const reportCreatorKey = (creatorId: string, sessionId: string, id: string): string =>
  `${reportCreatorPrefix(creatorId, sessionId)}${id}`;
const REPORT_PURGE_PREFIX = "rr:";
const reportPurgeAt = (at: number): string => `${REPORT_PURGE_PREFIX}${String(at).padStart(15, "0")}`;
const reportPurgeKey = (purgeAt: number, id: string): string => `${reportPurgeAt(purgeAt)}:${id}`;
/** The date a `rr:` key is for. */
const purgeAtOf = (key: string): number =>
  Number(key.slice(REPORT_PURGE_PREFIX.length, REPORT_PURGE_PREFIX.length + 15));

const lapsed = (grant: PlanGrant, now = Date.now()): boolean =>
  grant.expiresAt !== null && now > grant.expiresAt;

export class RegistryDO extends DurableObject<BellmanEnv> {
  /**
   * The queue of audit entries this object owes the per-org streams.
   *
   * A grant change is committed here and the record of it is filed in another
   * object, so the two cannot share a transaction. The entry is queued in the
   * grant's own transaction instead and delivered after it: inline when the write
   * returns, by the alarm if the isolate went away first.
   */
  private driver = new OutboxDriver(this.ctx.storage, (row) => this.#deliver(row));

  async putJoinCode(code: string, sessionId: string): Promise<void> {
    await this.ctx.storage.put(`jc:${code}`, sessionId);
  }

  async lookupJoinCode(code: string): Promise<string | undefined> {
    return this.ctx.storage.get<string>(`jc:${code}`);
  }

  async dropJoinCode(code: string): Promise<void> {
    await this.ctx.storage.delete(`jc:${code}`);
  }

  async lookupPublicName(name: string): Promise<PublicNameEntry | undefined> {
    return this.ctx.storage.get<PublicNameEntry>(`pn:${name}`);
  }

  /** `BellmanStore.publicNameEntries`: the index's first `limit` rows, in key order, which is name order. */
  async listPublicNames(limit: number): Promise<{ name: string; entry: PublicNameEntry }[]> {
    const rows = await this.ctx.storage.list<PublicNameEntry>({ prefix: "pn:", limit });
    return [...rows].map(([key, entry]) => ({ name: key.slice("pn:".length), entry }));
  }

  /** `BellmanStore.claimPublicName`, in one transaction (public names spec, D5). */
  async claimPublicName(name: string, entry: PublicNameEntry, expected: PublicNameEntry | null): Promise<boolean> {
    return this.ctx.storage.transaction(async (txn) => {
      if (!sameEntry((await txn.get<PublicNameEntry>(`pn:${name}`)) ?? null, expected)) return false;
      await txn.put(`pn:${name}`, entry);
      return true;
    });
  }

  /** `BellmanStore.releasePublicName`, in one transaction. */
  async releasePublicName(name: string, expected: PublicNameEntry): Promise<boolean> {
    return this.ctx.storage.transaction(async (txn) => {
      if (!sameEntry((await txn.get<PublicNameEntry>(`pn:${name}`)) ?? null, expected)) return false;
      await txn.delete(`pn:${name}`);
      return true;
    });
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
      await this.#dropGrant(grant);
      return undefined;
    }
    return grant;
  }

  async deleteGrant(key: string): Promise<void> {
    const existing = await this.ctx.storage.get<PlanGrant>(grantKey(key));
    if (!existing) return;
    await this.#dropGrant(existing);
  }

  /**
   * One audit entry, into its org's stream.
   *
   * The row id goes along as the intent id, so an entry that landed but whose
   * acknowledgement was lost is applied once when the queue retries it.
   *
   * This and the other methods below named with a `#` are JS-private, on purpose.
   * TypeScript's `private` is erased at compile time, and a Durable Object answers
   * RPC for every method on its class, so a `private` one can be called by anything
   * holding the REGISTRY binding. These do what no caller should be able to ask for
   * directly: file an entry in any org's stream, or commit a grant change and leave
   * its entry undelivered.
   */
  async #deliver(row: OutboxRow): Promise<void> {
    if (row.kind !== "audit") throw new Error(`outbox: unknown kind ${row.kind}`);
    const entry = row.payload as AuditEntry;
    // Falsy, not `=== null`: a namespace accepts "" and undefined as names, so a
    // malformed entry would be delivered into a stream no org reads rather than
    // failing. grantAuditEntries already refuses to build one; this is the second
    // defence, for the same reason grant-index.ts keeps two for the org id.
    if (!entry.orgId) return; // no stream to deliver it to; drop the row
    await this.env.AUDIT.get(this.env.AUDIT.idFromName(entry.orgId)).append(entry, row.id);
  }

  /** Each entry becomes one queued intent, with an id the stream can dedupe on. */
  #auditIntents(entries: AuditEntry[]): OutboxIntent[] {
    return entries.map(auditIntent);
  }

  /**
   * The backstop for the inline delivery, and the deletion of resolved reports.
   *
   * The outbox's: it fires after OUTBOX_GRACE_MS, finds an empty queue and does nothing, unless the inline attempt
   * never ran or is still waiting on an audit object that has stopped answering.
   *
   * `report_purge` (R15) is the other name a `due:` row carries here. Every name the driver can report needs a
   * branch below: a name with none is never consumed, and the closing reArm() points the alarm straight back at
   * its due time, so the alarm fires back to back for good. `now` is read once, as SessionDO.alarm reads it, so the
   * handlers due and the reports purged are judged on one clock. A handler that throws is logged by name and
   * rethrown, as SessionDO.alarm does, so the runtime retries and one line says which handler failed.
   *
   * The closing reArm() is the safety net SessionDO.alarm has too: a fired alarm is
   * consumed, so whatever is still due must have one scheduled before this returns.
   * The drain re-arms for itself after a failed delivery, so for the outbox this covers a path
   * that returns without having done so; nothing reaches it today. For reports it is the one
   * arming: `#purgeReports` leaves the next date in the due row, and this points the alarm at it.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    for (const name of await this.driver.dueNow(now)) {
      try {
        if (name === OUTBOX_HANDLER) await this.driver.deliverNow();
        if (name === REPORT_PURGE_HANDLER) await this.#purgeReports(now);
      } catch (error) {
        // The runtime retries a throwing alarm a few times and then leaves it with nothing armed (the next
        // `resolveReport`, or the next intent queued, arms it again), and it says nothing of which handler it gave up
        // on. This line is the one record. Rethrown, so the runtime still retries, as SessionDO.alarm does.
        console.error(`alarm handler "${name}" failed for the registry:`, error);
        throw error;
      }
    }
    await this.driver.reArm();
  }

  /**
   * `report_purge` (R15): in one transaction, delete every resolved report whose 180 days are up, with its creator
   * row and its `rr:` row, and every reporter's filing-times row whose times have all left the day, then point the
   * due row at the next `rr:` row, or delete it when none is left. Without that last step the name stays due and the
   * alarm fires back to back. The reports are listed up to `now` and not the whole prefix, because the prefix holds
   * every report resolved in the last 180 days and a firing needs the due ones.
   *
   * `#private`, for the reason `#deliver` gives: it deletes reports, and a method on a Durable Object's class is
   * reachable by anything holding the REGISTRY binding.
   *
   * ponytail: every report due is deleted in this one transaction, so a backlog is one large firing. Bound it per
   * firing if one ever gets that large: the due row would stay due, and the next firing would finish the rest.
   */
  async #purgeReports(now: number): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const due = await txn.list<string>({ prefix: REPORT_PURGE_PREFIX, end: reportPurgeAt(now + 1) });
      const reports = await getRows<Report>(txn, [...due.values()].map(reportKey));
      const keys = [...due.keys()];
      for (const id of due.values()) {
        const report = reports.get(reportKey(id));
        if (report === undefined) continue;
        keys.push(reportKey(id));
        if (report.target.kind !== "room") keys.push(reportCreatorKey(report.creatorId, report.sessionId, id));
      }
      // A reporter's filing times only serve the day's limit (R10), so a row whose times have all left the day goes too,
      // and an account is not kept for good. Listed whole: the rows are those of whoever filed in the last day, and of
      // whoever filed since the last purge.
      for (const [key, times] of await txn.list<number[]>({ prefix: REPORT_TIMES_PREFIX })) {
        if (withinWindow(times, now).length === 0) keys.push(key);
      }
      // A delete takes at most KEYS_PER_CALL keys.
      for (let i = 0; i < keys.length; i += KEYS_PER_CALL) await txn.delete(keys.slice(i, i + KEYS_PER_CALL));
      const [next] = await txn.list<string>({ prefix: REPORT_PURGE_PREFIX, limit: 1 });
      if (next) await txn.put(dueKey(REPORT_PURGE_HANDLER), purgeAtOf(next[0]));
      else await txn.delete(dueKey(REPORT_PURGE_HANDLER));
    });
  }

  /**
   * The transaction half of putGrantIfOwned: check, write, and queue the record of
   * it. The other three guarded writes below have the same two halves.
   *
   * Nothing that awaits another object runs inside a transaction closure. Every
   * other call to this object waits until the closure commits, so a delivery in
   * there would hold the registry for as long as the audit object takes to answer.
   * The closure queues; the wrapper delivers once it has committed.
   */
  async #putGrantIfOwnedTxn(
    grant: PlanGrant,
    expectedOrgId: string | null,
    audit: AuditIntent
  ): Promise<"written" | "conflict" | "full"> {
    return this.ctx.storage.transaction(async (txn) => {
      const stored = await txn.get<PlanGrant>(grantKey(grant.key));
      // A lapsed grant is not a grant — the same rule getGrant applies. Letting
      // an expired record from another org answer this check would block the
      // key indefinitely, because nothing sweeps it until someone reads it.
      const previous = stored && !lapsed(stored) ? stored : undefined;
      const orgOf = async (orgId: string | null) => (orgId === null ? undefined : txn.get<Org>(orgKey(orgId)));
      // An unowned seat elsewhere holds nothing (ADR 0027): the org that owns the address by its form takes the key.
      const taken = previous !== undefined && previous.orgId !== expectedOrgId
        && takesUnownedSeat(previous, await orgOf(previous.orgId), grant, await orgOf(grant.orgId));
      if (previous && previous.orgId !== expectedOrgId && !taken) return "conflict" as const;
      // The org whose IdP pushed the seat it took keeps no hold on the key: a claim does not carry its user along.
      if (taken && (await txn.get<{ orgId: string }>(scimKeyIndex(grant.key)))?.orgId === previous.orgId) await txn.delete(scimKeyIndex(grant.key));
      // The seat cap (orgs spec, D3), decided in the transaction that seats: an org with a
      // record holds as many grants as it bought, a key already in this org changes role for
      // no seat, and an org that is only a string in grants has no record and no cap.
      if (grant.orgId !== null && !(previous && previous.orgId === grant.orgId)) {
        const org = await txn.get<Org>(orgKey(grant.orgId));
        if (org && (await this.#countMembers(txn, grant.orgId, Date.now())) >= org.seats) return "full" as const;
      }
      // The stale entry to clear is the one actually in storage, expired or not.
      for (const stale of staleIndexKeys(stored, grant)) await txn.delete(stale);
      const rows = await this.driver.enqueue(
        txn, this.#auditIntents(taken ? takenSeatAuditEntries(previous, grant, audit, Date.now()) : grantAuditEntries(previous, grant, audit, Date.now()))
      );
      // Grant, index and the intent to record it, in one commit. A refused
      // write reaches none of this, so it queues nothing.
      await txn.put<unknown>({
        [grantKey(grant.key)]: grant,
        [orgIndexKey(grant.orgId, grant.key)]: grant,
        ...rows,
      });
      return "written" as const;
    });
  }

  async putGrantIfOwned(
    grant: PlanGrant,
    expectedOrgId: string | null,
    audit: AuditIntent
  ): Promise<"written" | "conflict" | "full"> {
    const outcome = await this.#putGrantIfOwnedTxn(grant, expectedOrgId, audit);
    if (outcome === "written") await this.driver.deliverNow();
    return outcome;
  }

  async #deleteGrantIfOwnedTxn(
    key: string,
    expectedOrgId: string | null,
    audit: AuditIntent
  ): Promise<"deleted" | "missing" | "conflict"> {
    return this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<PlanGrant>(grantKey(key));
      if (!existing) return "missing" as const;
      if (lapsed(existing)) {
        // Already gone as far as every reader is concerned; tidy it away and
        // say so, rather than reporting a revocation of something inert — and
        // record nothing, for the same reason.
        for (const storageKey of allKeysFor(existing)) await txn.delete(storageKey);
        return "missing" as const;
      }
      if (existing.orgId !== expectedOrgId) return "conflict" as const;
      for (const storageKey of allKeysFor(existing)) await txn.delete(storageKey);
      await txn.put<unknown>(
        await this.driver.enqueue(
          txn, this.#auditIntents(revokeAuditEntries(existing, audit, Date.now()))
        )
      );
      return "deleted" as const;
    });
  }

  async deleteGrantIfOwned(
    key: string,
    expectedOrgId: string | null,
    audit: AuditIntent
  ): Promise<"deleted" | "missing" | "conflict"> {
    const outcome = await this.#deleteGrantIfOwnedTxn(key, expectedOrgId, audit);
    if (outcome === "deleted") await this.driver.deliverNow();
    return outcome;
  }

  async #putGrantIfSourceTxn(
    grant: PlanGrant,
    expectedSource: string,
    audit: AuditIntent
  ): Promise<GrantWrite> {
    return this.ctx.storage.transaction(async (txn) => {
      const stored = await txn.get<PlanGrant>(grantKey(grant.key));
      const previous = stored && !lapsed(stored) ? stored : undefined;
      if (previous && previous.source !== expectedSource) return { outcome: "conflict" as const };
      for (const stale of staleIndexKeys(stored, grant)) await txn.delete(stale);
      const rows = await this.driver.enqueue(
        txn, this.#auditIntents(grantAuditEntries(previous, grant, audit, Date.now()))
      );
      await txn.put<unknown>({
        [grantKey(grant.key)]: grant,
        [orgIndexKey(grant.orgId, grant.key)]: grant,
        ...rows,
      });
      return { outcome: "written" as const, previous };
    });
  }

  async putGrantIfSource(
    grant: PlanGrant,
    expectedSource: string,
    audit: AuditIntent
  ): Promise<GrantWrite> {
    const result = await this.#putGrantIfSourceTxn(grant, expectedSource, audit);
    if (result.outcome === "written") await this.driver.deliverNow();
    return result;
  }

  async #deleteGrantIfSourceTxn(
    key: string,
    expectedSource: string,
    audit: AuditIntent
  ): Promise<GrantDelete> {
    return this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<PlanGrant>(grantKey(key));
      if (!existing) return { outcome: "missing" as const };
      if (lapsed(existing)) {
        for (const storageKey of allKeysFor(existing)) await txn.delete(storageKey);
        return { outcome: "missing" as const };
      }
      if (existing.source !== expectedSource) return { outcome: "conflict" as const };
      for (const storageKey of allKeysFor(existing)) await txn.delete(storageKey);
      await txn.put<unknown>(
        await this.driver.enqueue(
          txn, this.#auditIntents(revokeAuditEntries(existing, audit, Date.now()))
        )
      );
      return { outcome: "deleted" as const, removed: existing };
    });
  }

  async deleteGrantIfSource(
    key: string,
    expectedSource: string,
    audit: AuditIntent
  ): Promise<GrantDelete> {
    const result = await this.#deleteGrantIfSourceTxn(key, expectedSource, audit);
    if (result.outcome === "deleted") await this.driver.deliverNow();
    return result;
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
      await this.#repointScim(txn, grant, toKey);
    });
  }

  /**
   * The SCIM rows follow a moved key (SCIM spec, D3), in the move's own transaction: the user the key is managed
   * by, its key index, and the directory entry for its address; and a directory entry an SSO sign-in alone wrote
   * follows an address key.
   */
  async #repointScim(txn: DurableObjectTransaction, moved: PlanGrant, toKey: string): Promise<void> {
    const managed = await txn.get<{ orgId: string; scimId: string }>(scimKeyIndex(moved.key));
    if (managed) {
      const user = await txn.get<ScimUser>(scimUserKey(managed.orgId, managed.scimId));
      if (user) {
        await txn.put<unknown>({
          [scimUserKey(managed.orgId, managed.scimId)]: { ...user, key: toKey },
          [scimNameKey(managed.orgId, user.userName)]: { key: toKey, scimId: managed.scimId },
        });
      }
      await txn.delete(scimKeyIndex(moved.key));
      await txn.put(scimKeyIndex(toKey), managed);
      return;
    }
    if (moved.orgId && moved.key.startsWith("email:")) {
      const name = scimNameKey(moved.orgId, moved.key.slice("email:".length));
      const entry = await txn.get<DirectoryEntry>(name);
      if (entry && entry.key === moved.key) await txn.put(name, { ...entry, key: toKey });
    }
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
          await this.#dropGrant(grant);
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

  // ------------------------------------------------- orgs (orgs spec, D1 to D5)
  // The record sits beside the grants that are its members, so a seat is decided in the
  // transaction that takes it, and the rows an org change owes go out through the same outbox.

  async getOrg(orgId: string): Promise<Org | undefined> {
    return this.ctx.storage.get<Org>(orgKey(orgId));
  }

  /**
   * The org's live grants: its members (D2), the owner's among them. A scan of the org's index
   * range, bounded by the org's own size, so it can run inside a transaction with the write it
   * guards. `#private` because it reads through whatever storage it is handed.
   * ponytail: a scan per member write; a counter row is the upgrade if an org ever holds thousands.
   */
  async #countMembers(from: Pick<DurableObjectTransaction, "list">, orgId: string, now: number): Promise<number> {
    let count = 0;
    for (const grant of (await from.list<PlanGrant>({ prefix: orgIndexPrefix(orgId) })).values()) {
      if (!lapsed(grant, now)) count++;
    }
    return count;
  }

  async countOrgMembers(orgId: string): Promise<number> {
    return this.#countMembers(this.ctx.storage, orgId, Date.now());
  }

  async #createOrgTxn(org: Org, ownerGrant: PlanGrant, audit: AuditIntent): Promise<"created" | "exists" | "conflict"> {
    return this.ctx.storage.transaction(async (txn) => {
      if (await txn.get<Org>(orgKey(org.orgId))) return "exists" as const;
      const stored = await txn.get<PlanGrant>(grantKey(ownerGrant.key));
      const previous = stored && !lapsed(stored) ? stored : undefined;
      if (previous && previous.orgId !== org.orgId) return "conflict" as const;
      for (const stale of staleIndexKeys(stored, ownerGrant)) await txn.delete(stale);
      const now = Date.now();
      const rows = await this.driver.enqueue(txn, this.#auditIntents([
        ...orgAuditEntries(undefined, org, audit, now),
        ...grantAuditEntries(previous, ownerGrant, audit, now),
      ]));
      // The record, the owner's grant, its index copy and the rows to record them, in one commit (D7).
      await txn.put<unknown>({
        [orgKey(org.orgId)]: org,
        [grantKey(ownerGrant.key)]: ownerGrant,
        [orgIndexKey(ownerGrant.orgId, ownerGrant.key)]: ownerGrant,
        ...rows,
      });
      return "created" as const;
    });
  }

  async createOrg(org: Org, ownerGrant: PlanGrant, audit: AuditIntent): Promise<"created" | "exists" | "conflict"> {
    const outcome = await this.#createOrgTxn(org, ownerGrant, audit);
    if (outcome === "created") await this.driver.deliverNow();
    return outcome;
  }

  async #updateOrgTxn(orgId: string, patch: OrgPatch, audit: AuditIntent): Promise<Org | undefined> {
    return this.ctx.storage.transaction(async (txn) => {
      const previous = await txn.get<Org>(orgKey(orgId));
      if (!previous) return undefined;
      const next = patchedOrg(previous, patch);
      const rows = await this.driver.enqueue(txn, this.#auditIntents(orgAuditEntries(previous, next, audit, Date.now())));
      await txn.put<unknown>({ [orgKey(orgId)]: next, ...rows });
      return next;
    });
  }

  async updateOrg(orgId: string, patch: OrgPatch, audit: AuditIntent): Promise<Org | undefined> {
    const next = await this.#updateOrgTxn(orgId, patch, audit);
    if (next) await this.driver.deliverNow();
    return next;
  }

  async #activatePurchasedOrgTxn(
    orgId: string, ownerUserId: string, seats: number, audit: AuditIntent,
  ): Promise<"created" | "updated" | "unchanged" | "not_purchased"> {
    return this.ctx.storage.transaction(async (txn) => {
      const previous = await txn.get<Org>(orgKey(orgId));
      // Billing touches only what billing created (ADR 0014, decision 3): an operator org stays as it is.
      if (previous && previous.source !== "purchase") return "not_purchased" as const;
      if (previous && previous.seats === seats && previous.active) return "unchanged" as const;
      const now = Date.now();
      // The seats and the standing, and nothing else (D4): the name its owner gave it survives every Stripe event.
      const next: Org = previous ? { ...previous, seats, active: true } : purchasedOrg(orgId, ownerUserId, seats, now);
      const rows = await this.driver.enqueue(txn, this.#auditIntents(orgAuditEntries(previous, next, audit, now)));
      await txn.put<unknown>({ [orgKey(orgId)]: next, ...rows });
      return previous ? ("updated" as const) : ("created" as const);
    });
  }

  async activatePurchasedOrg(
    orgId: string, ownerUserId: string, seats: number, audit: AuditIntent,
  ): Promise<"created" | "updated" | "unchanged" | "not_purchased"> {
    const outcome = await this.#activatePurchasedOrgTxn(orgId, ownerUserId, seats, audit);
    if (outcome === "created" || outcome === "updated") await this.driver.deliverNow();
    return outcome;
  }

  async #deactivateOrgTxn(orgId: string, audit: AuditIntent): Promise<"updated" | "unchanged" | "missing" | "not_purchased"> {
    return this.ctx.storage.transaction(async (txn) => {
      const previous = await txn.get<Org>(orgKey(orgId));
      if (!previous) return "missing" as const;
      if (previous.source !== "purchase") return "not_purchased" as const;
      if (!previous.active) return "unchanged" as const;
      const next: Org = { ...previous, active: false };
      const rows = await this.driver.enqueue(txn, this.#auditIntents(orgAuditEntries(previous, next, audit, Date.now())));
      await txn.put<unknown>({ [orgKey(orgId)]: next, ...rows });
      return "updated" as const;
    });
  }

  async deactivateOrg(orgId: string, audit: AuditIntent): Promise<"updated" | "unchanged" | "missing" | "not_purchased"> {
    const outcome = await this.#deactivateOrgTxn(orgId, audit);
    if (outcome === "updated") await this.driver.deliverNow();
    return outcome;
  }

  // ------------------------------------------------- SSO (SSO spec, D9, D11, D13)

  async #putOrgIdpTxn(orgId: string, idp: OrgIdp, audit: AuditIntent): Promise<"written" | "missing"> {
    return this.ctx.storage.transaction(async (txn) => {
      if (!(await txn.get<Org>(orgKey(orgId)))) return "missing" as const;
      const rows = await this.driver.enqueue(txn, this.#auditIntents([orgEventEntry(orgId, "idp_configured", { issuer: idp.issuer }, audit, Date.now())]));
      await txn.put<unknown>({ [idpKey(orgId)]: idp, ...rows });
      return "written" as const;
    });
  }

  async putOrgIdp(orgId: string, idp: OrgIdp, audit: AuditIntent): Promise<"written" | "missing"> {
    const outcome = await this.#putOrgIdpTxn(orgId, idp, audit);
    if (outcome === "written") await this.driver.deliverNow();
    return outcome;
  }

  async getOrgIdp(orgId: string): Promise<OrgIdp | undefined> {
    return this.ctx.storage.get<OrgIdp>(idpKey(orgId));
  }

  async #deleteOrgIdpTxn(orgId: string, audit: AuditIntent): Promise<"deleted" | "missing"> {
    return this.ctx.storage.transaction(async (txn) => {
      if (!(await txn.get<OrgIdp>(idpKey(orgId)))) return "missing" as const;
      await txn.delete(idpKey(orgId));
      await txn.put<unknown>(await this.driver.enqueue(txn, this.#auditIntents([orgEventEntry(orgId, "idp_removed", {}, audit, Date.now())])));
      return "deleted" as const;
    });
  }

  async deleteOrgIdp(orgId: string, audit: AuditIntent): Promise<"deleted" | "missing"> {
    const outcome = await this.#deleteOrgIdpTxn(orgId, audit);
    if (outcome === "deleted") await this.driver.deliverNow();
    return outcome;
  }

  async #claimDomainTxn(orgId: string, domain: string, token: string, now: number, audit: AuditIntent): Promise<"claimed" | "exists" | "missing"> {
    return this.ctx.storage.transaction(async (txn) => {
      const org = await txn.get<Org>(orgKey(orgId));
      if (!org) return "missing" as const;
      if (org.domains.some((d) => d.domain === domain)) return "exists" as const;
      const next: Org = { ...org, domains: [...org.domains, { domain, token, verifiedAt: null }] };
      const rows = await this.driver.enqueue(txn, this.#auditIntents([orgEventEntry(orgId, "domain_claimed", { domain }, audit, now)]));
      await txn.put<unknown>({ [orgKey(orgId)]: next, ...rows });
      return "claimed" as const;
    });
  }

  async claimDomain(orgId: string, domain: string, token: string, now: number, audit: AuditIntent): Promise<"claimed" | "exists" | "missing"> {
    const outcome = await this.#claimDomainTxn(orgId, domain, token, now, audit);
    if (outcome === "claimed") await this.driver.deliverNow();
    return outcome;
  }

  /** The index read and the claim's write in one transaction (D11): two orgs verifying one domain at once cannot both win. */
  async #verifyDomainTxn(orgId: string, domain: string, now: number, audit: AuditIntent): Promise<"verified" | "taken" | "unknown"> {
    return this.ctx.storage.transaction(async (txn) => {
      const org = await txn.get<Org>(orgKey(orgId));
      const claim = org?.domains.find((d) => d.domain === domain);
      if (!org || !claim) return "unknown" as const;
      const holder = await txn.get<string>(domainKey(domain));
      if (holder !== undefined && holder !== orgId) return "taken" as const;
      if (claim.verifiedAt !== null) {
        await txn.put(domainKey(domain), orgId);
        return "verified" as const;
      }
      const next: Org = { ...org, domains: org.domains.map((d) => (d.domain === domain ? { ...d, verifiedAt: now } : d)) };
      const rows = await this.driver.enqueue(txn, this.#auditIntents([orgEventEntry(orgId, "domain_verified", { domain }, audit, now)]));
      await txn.put<unknown>({ [orgKey(orgId)]: next, [domainKey(domain)]: orgId, ...rows });
      return "verified" as const;
    });
  }

  async verifyDomain(orgId: string, domain: string, now: number, audit: AuditIntent): Promise<"verified" | "taken" | "unknown"> {
    const outcome = await this.#verifyDomainTxn(orgId, domain, now, audit);
    if (outcome === "verified") await this.driver.deliverNow();
    return outcome;
  }

  async #releaseDomainTxn(orgId: string, domain: string, audit: AuditIntent): Promise<"released" | "unknown"> {
    return this.ctx.storage.transaction(async (txn) => {
      const org = await txn.get<Org>(orgKey(orgId));
      if (!org || !org.domains.some((d) => d.domain === domain)) return "unknown" as const;
      const next: Org = { ...org, domains: org.domains.filter((d) => d.domain !== domain) };
      if ((await txn.get<string>(domainKey(domain))) === orgId) await txn.delete(domainKey(domain));
      const rows = await this.driver.enqueue(txn, this.#auditIntents([orgEventEntry(orgId, "domain_released", { domain }, audit, Date.now())]));
      await txn.put<unknown>({ [orgKey(orgId)]: next, ...rows });
      return "released" as const;
    });
  }

  async releaseDomain(orgId: string, domain: string, audit: AuditIntent): Promise<"released" | "unknown"> {
    const outcome = await this.#releaseDomainTxn(orgId, domain, audit);
    if (outcome === "released") await this.driver.deliverNow();
    return outcome;
  }

  async orgForDomain(domain: string): Promise<string | undefined> {
    return this.ctx.storage.get<string>(domainKey(domain));
  }

  /** Whether a key index row names a SCIM user the IdP deactivated (SCIM spec, D4). */
  async #scimInactive(txn: Pick<DurableObjectTransaction, "get">, managed: { orgId: string; scimId: string } | undefined): Promise<boolean> {
    const user = managed && await txn.get<ScimUser>(scimUserKey(managed.orgId, managed.scimId));
    return user !== undefined && !user.active;
  }

  async #provisionSsoMemberTxn(
    orgId: string, key: string, now: number, audit: AuditIntent, address?: string,
  ): Promise<"written" | "exists" | "full" | "no_org" | "deprovisioned"> {
    return this.ctx.storage.transaction(async (txn) => {
      const org = await txn.get<Org>(orgKey(orgId));
      if (!org) return "no_org" as const;
      if (await this.#scimInactive(txn, await txn.get<{ orgId: string; scimId: string }>(scimKeyIndex(key)))) return "deprovisioned" as const;
      const stored = await txn.get<PlanGrant>(grantKey(key));
      if (stored && !lapsed(stored, now)) return "exists" as const;
      const name = address === undefined ? undefined : scimNameKey(orgId, address);
      const entry = name === undefined ? undefined : await txn.get<DirectoryEntry>(name);
      if (entry?.scimId && (await this.#scimInactive(txn, { orgId, scimId: entry.scimId }))) return "deprovisioned" as const;
      // The grant the address is seated under, this org's: at the directory's key, else at the address as given or
      // lowercased (a push seats the lowercased address). It moves onto the subject with its role and source, as
      // `moveGrant` moves an admin's address grant: the seat follows the door the person last came through.
      const candidates = address === undefined ? [entry?.key] : [entry?.key, `email:${address}`, `email:${address.toLowerCase()}`];
      for (const from of candidates) {
        const found = from === undefined || from === key ? undefined : await txn.get<PlanGrant>(grantKey(from));
        const held = found && !lapsed(found, now) ? found : undefined;
        if (!held || held.orgId !== orgId) continue;
        for (const storageKey of allKeysFor(held)) await txn.delete(storageKey);
        for (const storageKey of stored ? allKeysFor(stored) : []) await txn.delete(storageKey);
        const moved: PlanGrant = { ...held, key };
        await txn.put<unknown>({ [grantKey(key)]: moved, [orgIndexKey(moved.orgId, key)]: moved, [name!]: { key, scimId: entry?.scimId ?? null } });
        await this.#repointScim(txn, held, key);
        return "written" as const;
      }
      if ((await this.#countMembers(txn, orgId, now)) >= org.seats) return "full" as const;
      const grant: PlanGrant = { key, plan: "team", role: "member", orgId, source: "sso", grantedAt: now, grantedBy: "sso", expiresAt: null };
      for (const stale of staleIndexKeys(stored, grant)) await txn.delete(stale);
      const extra: Record<string, unknown> = {};
      if (name !== undefined) {
        extra[name] = { key, scimId: entry?.scimId ?? null } satisfies DirectoryEntry;
        // A SCIM user whose grant is gone follows the subject that just signed in.
        const user = entry?.scimId ? await txn.get<ScimUser>(scimUserKey(orgId, entry.scimId)) : undefined;
        if (user) {
          await txn.delete(scimKeyIndex(user.key));
          Object.assign(extra, this.#scimRows({ ...user, key }));
        }
      }
      const rows = await this.driver.enqueue(txn, this.#auditIntents(grantAuditEntries(undefined, grant, audit, now)));
      await txn.put<unknown>({ [grantKey(key)]: grant, [orgIndexKey(orgId, key)]: grant, ...extra, ...rows });
      return "written" as const;
    });
  }

  async provisionSsoMember(
    orgId: string, key: string, now: number, audit: AuditIntent, address?: string,
  ): Promise<"written" | "exists" | "full" | "no_org" | "deprovisioned"> {
    const outcome = await this.#provisionSsoMemberTxn(orgId, key, now, audit, address);
    if (outcome === "written") await this.driver.deliverNow();
    return outcome;
  }

  // ------------------------------------------------- invites (ADR 0027)
  // Under `io:` and `iv:`, apart from the grants: nothing that reads `gr:` or `go:` can take one for a seat.

  async #putOrgInviteTxn(invite: OrgInvite, audit: AuditIntent): Promise<"invited" | "exists" | "limit" | "no_org"> {
    return this.ctx.storage.transaction(async (txn) => {
      if (!(await txn.get<Org>(orgKey(invite.orgId)))) return "no_org" as const;
      const [byOrg, byKey] = inviteKeysFor(invite);
      if (await txn.get<OrgInvite>(byOrg)) return "exists" as const;
      const pending = await txn.list({ prefix: orgInvitesPrefix(invite.orgId), limit: MAX_PENDING_INVITES });
      if (pending.size >= MAX_PENDING_INVITES) return "limit" as const;
      const rows = await this.driver.enqueue(txn, this.#auditIntents([
        orgEventEntry(invite.orgId, "member_invited", { key: invite.key, role: invite.role }, audit, invite.invitedAt),
      ]));
      await txn.put<unknown>({ [byOrg]: invite, [byKey]: invite, ...rows });
      return "invited" as const;
    });
  }

  async putOrgInvite(invite: OrgInvite, audit: AuditIntent): Promise<"invited" | "exists" | "limit" | "no_org"> {
    const outcome = await this.#putOrgInviteTxn(invite, audit);
    if (outcome === "invited") await this.driver.deliverNow();
    return outcome;
  }

  async listOrgInvites(orgId: string, limit: number): Promise<OrgInvite[]> {
    return [...(await this.ctx.storage.list<OrgInvite>({ prefix: orgInvitesPrefix(orgId), limit })).values()];
  }

  /** One prefix read per key, each bounded as an org's listing is: a key many orgs invited cannot make a sign-in read without end. */
  async invitesFor(keys: string[]): Promise<OrgInvite[]> {
    const found: OrgInvite[] = [];
    for (const key of new Set(keys)) {
      found.push(...(await this.ctx.storage.list<OrgInvite>({ prefix: keyInvitesPrefix(key), limit: MAX_PENDING_INVITES })).values());
    }
    return found;
  }

  async #deleteOrgInviteTxn(orgId: string, key: string, audit: AuditIntent): Promise<"deleted" | "missing"> {
    return this.ctx.storage.transaction(async (txn) => {
      const rowKeys = inviteKeysFor({ orgId, key });
      if (!(await txn.get<OrgInvite>(rowKeys[0]))) return "missing" as const;
      await txn.delete(rowKeys);
      await txn.put<unknown>(await this.driver.enqueue(txn, this.#auditIntents([orgEventEntry(orgId, "invite_withdrawn", { key }, audit, Date.now())])));
      return "deleted" as const;
    });
  }

  async deleteOrgInvite(orgId: string, key: string, audit: AuditIntent): Promise<"deleted" | "missing"> {
    const outcome = await this.#deleteOrgInviteTxn(orgId, key, audit);
    if (outcome === "deleted") await this.driver.deliverNow();
    return outcome;
  }

  /** The offer, the switch, every key's grant and the seats are read in the transaction that writes the grant (ADR 0027). */
  async #acceptOrgInviteTxn(
    orgId: string, keys: string[], subjectKey: string, now: number, audit: AuditIntent,
  ): Promise<"joined" | "member" | "taken" | "full" | "sso" | "gone"> {
    return this.ctx.storage.transaction(async (txn) => {
      const org = await txn.get<Org>(orgKey(orgId));
      if (!org) return "gone" as const;
      const unique = [...new Set([subjectKey, ...keys])];
      const inviteRows = unique.map((key) => inviteKeysFor({ orgId, key }));
      const invite = (await Promise.all(inviteRows.map(([byOrg]) => txn.get<OrgInvite>(byOrg)))).find((i) => i !== undefined);
      const stored = await Promise.all(unique.map((key) => txn.get<PlanGrant>(grantKey(key))));
      const grants = stored.filter((g): g is PlanGrant => g !== undefined && !lapsed(g, now));
      // An unowned seat, in this org or any other, holds nothing: this org's are the offer and move, and another's is no grant.
      const orgs = new Map<string, Org | undefined>([[orgId, org]]);
      for (const g of grants) if (g.orgId !== null && !orgs.has(g.orgId)) orgs.set(g.orgId, await txn.get<Org>(orgKey(g.orgId)));
      const unowned = grants.filter((g) => isUnownedSeat(g, g.orgId === null ? undefined : orgs.get(g.orgId)));
      const seats = unowned.filter((g) => g.orgId === orgId);
      const offer = invite ? { role: invite.role, by: invite.invitedBy } : seats[0] ? { role: seats[0].role, by: seats[0].grantedBy } : undefined;
      if (!offer) return "gone" as const;
      if (org.requireSso) return "sso" as const;
      const others = grants.filter((g) => !unowned.includes(g));
      if (others.some((g) => g.orgId === orgId)) {
        await txn.delete(inviteRows.flat());
        return "member" as const;
      }
      if (others.length > 0) return "taken" as const;
      if (seats.length === 0 && (await this.#countMembers(txn, orgId, now)) >= org.seats) return "full" as const;
      const grant: PlanGrant = { key: subjectKey, plan: "team", role: offer.role, orgId, source: "invite", grantedAt: now, grantedBy: offer.by, expiresAt: null };
      // The subject's own row is a lapsed one at most, here; its index copy in another org goes with it.
      const subject = stored[0];
      await txn.delete([...inviteRows.flat(), ...seats.flatMap(allKeysFor), ...staleIndexKeys(subject, grant)]);
      // A seat the IdP pushed stays the IdP's to end (ADR 0029): its rows follow it onto the subject, as a claim's do.
      for (const seat of seats) await this.#repointScim(txn, seat, subjectKey);
      const rows = await this.driver.enqueue(txn, this.#auditIntents(grantAuditEntries(undefined, grant, audit, now)));
      await txn.put<unknown>({ [grantKey(subjectKey)]: grant, [orgIndexKey(orgId, subjectKey)]: grant, ...rows });
      return "joined" as const;
    });
  }

  async acceptOrgInvite(
    orgId: string, keys: string[], subjectKey: string, now: number, audit: AuditIntent,
  ): Promise<"joined" | "member" | "taken" | "full" | "sso" | "gone"> {
    const outcome = await this.#acceptOrgInviteTxn(orgId, keys, subjectKey, now, audit);
    if (outcome === "joined") await this.driver.deliverNow();
    return outcome;
  }

  async declineOrg(subjectKey: string, orgId: string, now: number): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const key = declineKey(subjectKey, orgId);
      await txn.put(key, Math.max(now, (await txn.get<number>(key)) ?? now));
    });
  }

  async declinedOrgs(subjectKey: string): Promise<{ orgId: string; at: number }[]> {
    const prefix = declinesPrefix(subjectKey);
    const rows = await this.ctx.storage.list<number>({ prefix, limit: MAX_PENDING_INVITES });
    return [...rows].map(([key, at]) => ({ orgId: decodeURIComponent(key.slice(prefix.length)), at }));
  }

  // ------------------------------------------------- SCIM users (SCIM spec, D2 to D8)
  // The row, the directory entry and the key index beside the grant they name, so a push, a deactivation and a
  // rename are each one transaction, and a refusal in any of them is answered before the first write.

  #scimRows(user: ScimUser): Record<string, unknown> {
    return {
      [scimUserKey(user.orgId, user.id)]: user,
      [scimNameKey(user.orgId, user.userName)]: { key: user.key, scimId: user.id } satisfies DirectoryEntry,
      [scimKeyIndex(user.key)]: { orgId: user.orgId, scimId: user.id },
    };
  }

  async #createScimUserTxn(user: ScimUser, audit: AuditIntent): Promise<ScimCreate> {
    return this.ctx.storage.transaction(async (txn) => {
      const org = await txn.get<Org>(orgKey(user.orgId));
      if (!org) return { outcome: "no_org" as const };
      const entry = await txn.get<DirectoryEntry>(scimNameKey(user.orgId, user.userName));
      // A tombstone (a user the IdP deleted) is no user: the push starts them over under the key it kept.
      const prior = entry?.scimId ? await txn.get<ScimUser>(scimUserKey(user.orgId, entry.scimId)) : undefined;
      if (prior && prior.deletedAt === null) return { outcome: "exists" as const };
      const kept = entry?.key ?? user.key;
      let key = kept;
      let stored = await txn.get<PlanGrant>(grantKey(key));
      let held = stored && !lapsed(stored, user.createdAt) ? stored : undefined;
      if (held && held.orgId !== user.orgId) return { outcome: "conflict" as const };
      // A seat this push creates or restores never lands on a personal account the org does not own by its form (ADR 0027).
      if (!held) {
        key = scimSeatKey(org, user.userName, kept);
        if (key !== kept) {
          stored = await txn.get<PlanGrant>(grantKey(key));
          held = stored && !lapsed(stored, user.createdAt) ? stored : undefined;
          if (held && held.orgId !== user.orgId) return { outcome: "conflict" as const };
        }
      }
      const linked = held !== undefined;
      const entries: AuditEntry[] = [];
      const rows: Record<string, unknown> = {};
      if (key !== kept && (await txn.get<{ scimId: string }>(scimKeyIndex(kept)))?.scimId === entry?.scimId) await txn.delete(scimKeyIndex(kept));
      if (!linked && user.active) {
        if ((await this.#countMembers(txn, user.orgId, user.createdAt)) >= org.seats) return { outcome: "full" as const };
        const grant = scimGrant(key, user.orgId, user.createdAt);
        for (const stale of staleIndexKeys(stored, grant)) await txn.delete(stale);
        rows[grantKey(key)] = grant;
        rows[orgIndexKey(user.orgId, key)] = grant;
        entries.push(...grantAuditEntries(undefined, grant, audit, user.createdAt));
      } else if (held && !user.active) {
        // Pushed as inactive onto a seat a sign-in or an admin gave: the push is the deactivation (review finding 5).
        for (const storageKey of allKeysFor(held)) await txn.delete(storageKey);
        entries.push(...revokeAuditEntries(held, audit, user.createdAt));
      }
      if (prior) await txn.delete(scimUserKey(user.orgId, prior.id));
      const row: ScimUser = { ...user, key, deletedAt: null };
      entries.push(scimUserEntry(user.orgId, user.id, "scim_user_created", {
        user_name: user.userName, external_id: user.externalId, key, linked,
      }, audit, user.createdAt));
      const queued = await this.driver.enqueue(txn, this.#auditIntents(entries));
      await txn.put<unknown>({ ...rows, ...this.#scimRows(row), ...queued });
      return { outcome: linked ? ("linked" as const) : ("written" as const), user: row };
    });
  }

  async createScimUser(user: ScimUser, audit: AuditIntent): Promise<ScimCreate> {
    const outcome = await this.#createScimUserTxn(user, audit);
    if (outcome.outcome === "written" || outcome.outcome === "linked") await this.driver.deliverNow();
    return outcome;
  }

  /** A tombstone is hidden from every read but `scimUserByKey`, which the sign-in refusal reads. */
  async getScimUser(orgId: string, id: string): Promise<ScimUser | undefined> {
    const user = await this.ctx.storage.get<ScimUser>(scimUserKey(orgId, id));
    return user && user.deletedAt === null ? user : undefined;
  }

  async scimUserByName(orgId: string, userName: string): Promise<ScimUser | undefined> {
    const entry = await this.ctx.storage.get<DirectoryEntry>(scimNameKey(orgId, userName));
    return entry?.scimId ? this.getScimUser(orgId, entry.scimId) : undefined;
  }

  async scimUserByKey(key: string): Promise<ScimUser | undefined> {
    const managed = await this.ctx.storage.get<{ orgId: string; scimId: string }>(scimKeyIndex(key));
    return managed ? this.ctx.storage.get<ScimUser>(scimUserKey(managed.orgId, managed.scimId)) : undefined;
  }

  async listScimUsers(orgId: string, limit: number): Promise<ScimUser[]> {
    // ponytail: tombstones are read and dropped, so a page holds fewer than `limit` by their number.
    return [...(await this.ctx.storage.list<ScimUser>({ prefix: scimUserPrefix(orgId), limit })).values()].filter((u) => u.deletedAt === null);
  }

  async #updateScimUserTxn(orgId: string, id: string, patch: ScimUserPatch, now: number, audit: AuditIntent): Promise<ScimUpdate> {
    return this.ctx.storage.transaction(async (txn) => {
      const was = await txn.get<ScimUser>(scimUserKey(orgId, id));
      if (!was || was.deletedAt !== null) return { outcome: "missing" as const };
      const rename = patch.userName !== undefined && patch.userName !== was.userName ? patch.userName : undefined;
      const externalId = patch.externalId !== undefined && patch.externalId !== was.externalId ? patch.externalId : undefined;
      const active = patch.active !== undefined && patch.active !== was.active ? patch.active : undefined;
      if (rename === undefined && externalId === undefined && active === undefined) return { outcome: "updated" as const, user: was, was };
      // Every refusal before any write: a transaction rolls back on a throw and not on a return.
      const moves = rename !== undefined && was.key === `email:${was.userName}`;
      const toKey = moves ? `email:${rename}` : was.key;
      const liveAt = async (storageKey: string): Promise<PlanGrant | undefined> => {
        const found = await txn.get<PlanGrant>(grantKey(storageKey));
        return found && !lapsed(found, now) ? found : undefined;
      };
      if (rename !== undefined) {
        const taken = await txn.get<DirectoryEntry>(scimNameKey(orgId, rename));
        if (taken?.scimId && taken.scimId !== id) return { outcome: "exists" as const };
        // A tenant's seat is never handed to another: a live grant at the new address refuses the rename.
        const target = moves ? await liveAt(toKey) : undefined;
        if (target && target.orgId !== orgId) return { outcome: "conflict" as const };
        if (target) return { outcome: "exists" as const };
      }
      let reuse: PlanGrant | undefined;
      // A reactivation never re-seats a personal account the org does not own by its form (ADR 0027): on the address instead.
      const org = await txn.get<Org>(orgKey(orgId));
      const seatAt = active === true && org ? scimSeatKey(org, rename ?? was.userName, toKey) : toKey;
      if (active === true) {
        const held = moves && seatAt === toKey ? undefined : await liveAt(seatAt);
        if (held && held.orgId !== orgId) return { outcome: "conflict" as const };
        reuse = held;
        if (!reuse && org && (await this.#countMembers(txn, orgId, now)) >= org.seats) return { outcome: "full" as const };
      }

      const entries: AuditEntry[] = [];
      const rows: Record<string, unknown> = {};
      const detail: Record<string, unknown> = {};
      let next: ScimUser = { ...was, updatedAt: now };
      if (rename !== undefined) {
        // An address key names the address, so it moves with it; a key a sign-in claimed names the person and stays.
        if (moves) {
          const stored = await txn.get<PlanGrant>(grantKey(was.key));
          if (stored && !lapsed(stored, now)) {
            for (const storageKey of allKeysFor(stored)) await txn.delete(storageKey);
            const moved: PlanGrant = { ...stored, key: toKey };
            rows[grantKey(toKey)] = moved;
            rows[orgIndexKey(moved.orgId, toKey)] = moved;
          }
          await txn.delete(scimKeyIndex(was.key));
          next = { ...next, key: toKey };
        }
        await txn.delete(scimNameKey(orgId, was.userName));
        next = { ...next, userName: rename };
        detail.from = was.userName;
      }
      if (externalId !== undefined) {
        next = { ...next, externalId };
        detail.external_id = externalId;
      }
      let action: "scim_user_updated" | "scim_user_deactivated" | "scim_user_reactivated" = "scim_user_updated";
      if (active === true) {
        if (seatAt !== next.key) {
          await txn.delete(scimKeyIndex(next.key));
          next = { ...next, key: seatAt };
        }
        if (!reuse) {
          const grant = scimGrant(next.key, orgId, now);
          const stale = rows[grantKey(next.key)] === undefined ? await txn.get<PlanGrant>(grantKey(next.key)) : undefined;
          for (const staleKey of staleIndexKeys(stale, grant)) await txn.delete(staleKey);
          rows[grantKey(next.key)] = grant;
          rows[orgIndexKey(orgId, next.key)] = grant;
          entries.push(...grantAuditEntries(undefined, grant, audit, now));
        }
        action = "scim_user_reactivated";
      } else if (active === false) {
        const held = rows[grantKey(next.key)] as PlanGrant | undefined ?? await txn.get<PlanGrant>(grantKey(next.key));
        if (held && !lapsed(held, now) && held.orgId === orgId) {
          for (const storageKey of allKeysFor(held)) {
            await txn.delete(storageKey);
            delete rows[storageKey];
          }
          entries.push(...revokeAuditEntries(held, audit, now));
        }
        action = "scim_user_deactivated";
      }
      if (active !== undefined) next = { ...next, active };
      entries.push(scimUserEntry(orgId, id, action, { user_name: next.userName, key: next.key, ...detail }, audit, now));
      const queued = await this.driver.enqueue(txn, this.#auditIntents(entries));
      await txn.put<unknown>({ ...rows, ...this.#scimRows(next), ...queued });
      return { outcome: "updated" as const, user: next, was };
    });
  }

  async updateScimUser(orgId: string, id: string, patch: ScimUserPatch, now: number, audit: AuditIntent): Promise<ScimUpdate> {
    const outcome = await this.#updateScimUserTxn(orgId, id, patch, now, audit);
    if (outcome.outcome === "updated") await this.driver.deliverNow();
    return outcome;
  }

  /**
   * A delete is a deactivation that also hides the row (review finding 3): the grant goes, the row stays as a
   * tombstone with its directory entry and key index, so the subject is refused as a deactivated one is, and a
   * repeat answers the tombstone so a room walk cut short can be finished. A push for the address starts over.
   */
  async #deleteScimUserTxn(orgId: string, id: string, now: number, audit: AuditIntent): Promise<{ was: ScimUser; wrote: boolean } | undefined> {
    return this.ctx.storage.transaction(async (txn) => {
      const was = await txn.get<ScimUser>(scimUserKey(orgId, id));
      if (!was) return undefined;
      if (was.deletedAt !== null) return { was, wrote: false };
      const entries: AuditEntry[] = [];
      const stored = was.active ? await txn.get<PlanGrant>(grantKey(was.key)) : undefined;
      if (stored && !lapsed(stored, now) && stored.orgId === orgId) {
        for (const storageKey of allKeysFor(stored)) await txn.delete(storageKey);
        entries.push(...revokeAuditEntries(stored, audit, now));
      }
      entries.push(scimUserEntry(orgId, id, "scim_user_deleted", { user_name: was.userName, key: was.key }, audit, now));
      const rows = await this.driver.enqueue(txn, this.#auditIntents(entries));
      await txn.put<unknown>({ [scimUserKey(orgId, id)]: { ...was, active: false, updatedAt: now, deletedAt: now } satisfies ScimUser, ...rows });
      return { was, wrote: true };
    });
  }

  async deleteScimUser(orgId: string, id: string, now: number, audit: AuditIntent): Promise<ScimUser | undefined> {
    const outcome = await this.#deleteScimUserTxn(orgId, id, now, audit);
    if (outcome?.wrote) await this.driver.deliverNow();
    return outcome?.was;
  }

  // ------------------------------------------------- SCIM (SCIM spec, D1)
  // The token's hash and its lookup row, beside the org: issuing again replaces both in one transaction, so the
  // old token stops at the commit and no window serves two.

  async #issueScimTokenTxn(orgId: string, token: ScimToken, audit: AuditIntent): Promise<"issued" | "replaced" | "missing"> {
    return this.ctx.storage.transaction(async (txn) => {
      if (!(await txn.get<Org>(orgKey(orgId)))) return "missing" as const;
      const previous = await txn.get<ScimToken>(scimTokenKey(orgId));
      if (previous) await txn.delete(scimTokenIndex(previous.tokenHash));
      const rows = await this.driver.enqueue(txn, this.#auditIntents([
        orgEventEntry(orgId, "scim_token_issued", { replaced: previous !== undefined }, audit, token.issuedAt),
      ]));
      await txn.put<unknown>({ [scimTokenKey(orgId)]: token, [scimTokenIndex(token.tokenHash)]: orgId, ...rows });
      return previous ? ("replaced" as const) : ("issued" as const);
    });
  }

  async issueScimToken(orgId: string, token: ScimToken, audit: AuditIntent): Promise<"issued" | "replaced" | "missing"> {
    const outcome = await this.#issueScimTokenTxn(orgId, token, audit);
    if (outcome !== "missing") await this.driver.deliverNow();
    return outcome;
  }

  async #revokeScimTokenTxn(orgId: string, audit: AuditIntent): Promise<"revoked" | "missing"> {
    return this.ctx.storage.transaction(async (txn) => {
      const token = await txn.get<ScimToken>(scimTokenKey(orgId));
      if (!token) return "missing" as const;
      await txn.delete([scimTokenKey(orgId), scimTokenIndex(token.tokenHash)]);
      const rows = await this.driver.enqueue(txn, this.#auditIntents([orgEventEntry(orgId, "scim_token_revoked", {}, audit, Date.now())]));
      await txn.put<unknown>(rows);
      return "revoked" as const;
    });
  }

  async revokeScimToken(orgId: string, audit: AuditIntent): Promise<"revoked" | "missing"> {
    const outcome = await this.#revokeScimTokenTxn(orgId, audit);
    if (outcome === "revoked") await this.driver.deliverNow();
    return outcome;
  }

  async scimTokenOf(orgId: string): Promise<ScimToken | undefined> {
    return this.ctx.storage.get<ScimToken>(scimTokenKey(orgId));
  }

  async orgForScimToken(tokenHash: string): Promise<string | undefined> {
    return this.ctx.storage.get<string>(scimTokenIndex(tokenHash));
  }

  /**
   * Remove both copies of a grant. Every delete path goes through here, and in
   * one transaction: half a delete leaves the grant listed but unresolvable,
   * or resolvable but unlisted.
   *
   * `#private`, because it deletes whatever grant it is handed, and a Durable Object
   * answers RPC for every method on its class: TypeScript's `private` is erased at
   * compile time.
   */
  async #dropGrant(grant: PlanGrant): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      for (const storageKey of allKeysFor(grant)) {
        await txn.delete(storageKey);
      }
    });
  }

  async countCreatesThisMonth(userId: string): Promise<number> {
    return this.#countMonth(`cr:${userId}`);
  }

  /**
   * `ho:<userId>:<sessionId>` — the hosted rooms a person holds open (I7), one row a
   * slot. The count and the record are one transaction, so two starts at the limit
   * cannot both pass, and a room's close gives its row back through its outbox
   * (`hosted_release`). Only this person's rows count: one whose rest holds a colon belongs to
   * someone whose id extends theirs, as the `us:` index says below (#226). A plan's hosted rooms
   * are the most a person holds open at once, not a
   * count of creations a month: each room's allowance renews monthly, so a monthly count
   * let a creator's spend grow every month they kept rooms open.
   */
  async reserveHostedRoom(userId: string, sessionId: string, limit: number): Promise<HostedSlot> {
    return this.ctx.storage.transaction(async (txn) => {
      const prefix = `ho:${userId}:`;
      const held = [...(await txn.list({ prefix })).keys()]
        .map((key) => key.slice(prefix.length))
        .filter((id) => !id.includes(":"));
      if (held.includes(sessionId)) return { ok: true };
      if (held.length >= limit) return { ok: false, open: held.length };
      await txn.put(`${prefix}${sessionId}`, Date.now());
      return { ok: true };
    });
  }

  async releaseHostedRoom(userId: string, sessionId: string): Promise<void> {
    await this.ctx.storage.delete(`ho:${userId}:${sessionId}`);
  }

  /**
   * `us:<userId>:<sessionId>` — which rooms a person created.
   *
   * The create counts below cannot answer this: they are timestamps kept for
   * the monthly quota, with no session id in them. Freezing needs the ids.
   *
   * Two variable segments, and only the second is sure to hold no separator: a session id is
   * `qs_<uuid>`, but an operator-issued user id may hold a colon, so one person's prefix also
   * covers the rows of someone whose id extends theirs past one (`u_x:a` extends `u_x`). Reads
   * go through #ownIds, which skips a row whose rest holds a colon (#295).
   *
   * **Sessions created before this deploy are not in here, and cannot be.**
   * This registry has never known which sessions exist — it holds join codes,
   * which are consumed, and create counts, which are bare timestamps. There is
   * no list to backfill from, so the gap cannot be closed by a migration; it
   * closes only as those rooms end, and since #18 a room ends when its last
   * member leaves or nobody has been in it for 90 days. Until then a lapse will
   * not freeze them, which means a room outliving its plan rather than a room
   * lost.
   *
   * **Sessions created after this deploy can be missing too.**
   * `DurableObjectStore` puts this row once the room has committed, and logs a
   * failed put rather than throwing it (`writeIndex`), deliberately: a throw
   * would report a failed create for a room that already exists. Nothing
   * rebuilds the row, so the outcome is the one above: a lapse cannot freeze a
   * room it cannot find, and the room keeps working on a plan that no longer
   * pays for it. The gap above only shrinks, as those rooms end; this one
   * also grows whenever a put fails. A creator's `um:` row is a separate put, so
   * either row can land without the other, and a room can be listed for its
   * creator and still be out of a lapse's reach.
   */
  async indexSession(userId: string, sessionId: string): Promise<void> {
    await this.ctx.storage.put(`us:${userId}:${sessionId}`, Date.now());
  }

  /**
   * One window of this person's created-room index, ids only, starting after
   * `startAfter` when given.
   *
   * Paged rather than limited, because the registry cannot tell a live room from
   * a closed one — the room is in another object — so the caller that CAN
   * (`DurableObjectStore.sessionsCreatedBy`) walks these windows and keeps going
   * until it has `limit` live ids. Applying `limit` here was the bug: a lapse
   * walk spent its whole budget on closed rooms and never reached the live ones,
   * which silently did nothing for exactly the accounts that use Bellman most
   * (#75).
   */
  async createdIndexPage(userId: string, limit: number, startAfter?: string): Promise<string[]> {
    return this.#ownIds("us", userId, limit, startAfter);
  }

  /**
   * Forget that this person created this room. Called by the sweep above as it
   * meets a closed room, so a dead row is paid for once rather than on every
   * listing for the life of the account — the index was never pruned at all
   * before (#75, #115).
   *
   * Only the `us:` half. `um:` is history and keeps its rows deliberately: its
   * contract is rooms a person HELD a handle in, closed ones included, until the room
   * is purged (`dropMembershipIndex`).
   */
  async dropCreatedIndex(userId: string, sessionId: string): Promise<void> {
    await this.ctx.storage.delete(`us:${userId}:${sessionId}`);
  }

  /**
   * Forget that this person held a handle in this room: the purge's (#65), and only
   * the purge's. A closed room stays in `um:` as history, but a room that has been
   * purged is no room at all, and a row naming it would list something no read can
   * open. Idempotent, so a purge retried after a crash drops it again.
   */
  async dropMembershipIndex(userId: string, sessionId: string): Promise<void> {
    await this.ctx.storage.delete(`um:${userId}:${sessionId}`);
  }

  /**
   * `um:<userId>:<sessionId>` — which rooms a person holds a handle in.
   *
   * The same shape as `us:` above, and the same collision, so it is read through #ownIds too.
   *
   * Keyed by user rather than by member, so a person who joined the same room
   * from two machines is one entry — the put is idempotent, and the panel wants
   * the room once.
   *
   * **Members who joined before this deploy are not in here, creators of rooms
   * that already existed included.** For the rooms `us:` knows about, a backfill
   * is possible in principle — `us:` enumerates their creators and each session
   * lists its members — and is not worth walking the registry for a listing that
   * fills itself in as older rooms end. Older rooms have no list to enumerate
   * (see `us:`), so for them their end is the only repair. Until then a joined
   * room is missing from one screen, which is not a room lost.
   *
   * **Members who joined after this deploy can be missing too, creators
   * included.** `DurableObjectStore` puts this row once the seat has committed,
   * and logs a failed put rather than throwing it (`writeIndex`), deliberately:
   * a throw would report a failed join for a seat that had already landed.
   * Nothing rebuilds the row. The gap above only shrinks, as those rooms end;
   * this one also grows whenever a put fails. A creator's `us:` row is a
   * separate put, so either row can land without the other.
   */
  async indexMembership(userId: string, sessionId: string): Promise<void> {
    await this.ctx.storage.put(`um:${userId}:${sessionId}`, Date.now());
  }

  async sessionsJoinedBy(userId: string, limit: number): Promise<string[]> {
    return this.#ownIds("um", userId, limit);
  }

  /**
   * The session ids under `<tag>:<userId>:` in key order, at most `limit` of them, past
   * `startAfter` when given; `us:` and `um:` read through here. A row whose rest holds a colon
   * is someone else's, whose id extends this one past it, since a session id holds none (the
   * reason `#signed` gives for `hs:`). It is listed past rather than returned, so it takes none
   * of the window's places (#295).
   */
  async #ownIds(tag: "us" | "um", userId: string, limit: number, startAfter?: string): Promise<string[]> {
    const prefix = `${tag}:${userId}:`;
    const ids: string[] = [];
    let after = startAfter === undefined ? undefined : `${prefix}${startAfter}`;
    while (ids.length < limit) {
      const want = limit - ids.length;
      const page = await this.ctx.storage.list<number>({
        prefix, limit: want, ...(after === undefined ? {} : { startAfter: after }),
      });
      for (const key of page.keys()) {
        after = key;
        const id = key.slice(prefix.length);
        if (!id.includes(":")) ids.push(id);
      }
      if (page.size < want) break;
    }
    return ids;
  }

  /**
   * `uo:<org>:<room>` — which rooms an org sat in (#65, D5), for the admin's list of the
   * closed ones. The same shape as `um:`, keyed by org, so a room several of an org's people
   * joined is one entry, and a room people from two orgs joined is in both lists.
   *
   * **It starts at its deploy, like the two above.** A room created before it is not listed,
   * and cannot be backfilled: this registry has never held a list of rooms to walk. The
   * admin's read of such a room by id does not use the index and works. And a write that fails
   * is logged rather than thrown (`DurableObjectStore.writeIndex`), for the reason `um:` gives,
   * so a room can be missing from the list and present for the read.
   *
   * Kept for a closed room, which is what it is for, and dropped by the purge
   * (`dropOrgIndex`).
   */
  async indexOrg(orgId: string, sessionId: string): Promise<void> {
    await this.ctx.storage.put(`${orgRoomPrefix(orgId)}${sessionId}`, Date.now());
  }

  async sessionsForOrg(orgId: string, limit: number): Promise<string[]> {
    const prefix = orgRoomPrefix(orgId);
    const map = await this.ctx.storage.list<number>({ prefix, limit });
    return [...map.keys()].map((k) => k.slice(prefix.length));
  }

  /** The purge's (#65), and only the purge's: a room that is gone is no room any org sat in. Idempotent. */
  async dropOrgIndex(orgId: string, sessionId: string): Promise<void> {
    await this.ctx.storage.delete(`${orgRoomPrefix(orgId)}${sessionId}`);
  }

  async recordCreate(userId: string): Promise<void> {
    await this.#recordMonth(`cr:${userId}`);
  }

  /**
   * The monthly create count's rule, `cr:`, shared by its count and its record.
   * `#private`, as `#deliver` is: a Durable Object answers RPC for every method on
   * its class, and these read and write any key they are handed.
   */
  async #countMonth(key: string): Promise<number> {
    const list = (await this.ctx.storage.get<number[]>(key)) ?? [];
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    return list.filter((t) => t >= monthStart).length;
  }

  async #recordMonth(key: string): Promise<void> {
    const list = (await this.ctx.storage.get<number[]>(key)) ?? [];
    list.push(Date.now());
    // Only the current month is ever counted, so drop anything well past it —
    // otherwise this key grows for the life of the account.
    const cutoff = Date.now() - 62 * 24 * 60 * 60 * 1000;
    await this.ctx.storage.put(key, list.filter((t) => t >= cutoff));
  }

  /**
   * `pr:<userId>:<name>` — a person's saved presets (designer spec D4). A name is a slug and
   * holds no separator, but an operator-issued user id may hold a colon, as the `us:` index says,
   * so a read keeps only a row whose rest is its own preset's name. Storage lists keys in order,
   * which is the names' code-unit order.
   */
  async listPresets(userId: string): Promise<SavedPreset[]> {
    return this.#presets(this.ctx.storage, userId);
  }

  async getPreset(userId: string, name: string): Promise<SavedPreset | undefined> {
    return this.#preset(this.ctx.storage, userId, name);
  }

  /**
   * The count and the write in one transaction. It awaits nothing but storage, which is why the
   * input gate kept a second save from counting between them before the transaction did; the
   * transaction holds if a later edit puts anything else there (worker-tests/preset-race.test.ts).
   */
  async putPreset(userId: string, preset: SavedPreset, cap: number): Promise<"saved" | "full"> {
    return this.ctx.storage.transaction<"saved" | "full">(async (txn) => {
      if ((await this.#preset(txn, userId, preset.name)) === undefined) {
        if ((await this.#presets(txn, userId)).length >= cap) return "full";
      }
      await txn.put(`pr:${userId}:${preset.name}`, preset);
      return "saved";
    });
  }

  /** A person's presets, read through `storage`: the object's, or a transaction's handle. */
  async #presets(
    storage: { list<T>(options: { prefix: string }): Promise<Map<string, T>> },
    userId: string,
  ): Promise<SavedPreset[]> {
    const prefix = `pr:${userId}:`;
    const map = await storage.list<SavedPreset>({ prefix });
    // A key under this prefix whose rest is not its own preset's name belongs to someone whose id
    // extends this one past a colon. It is not this person's.
    return [...map].filter(([key, p]) => key === prefix + p.name).map(([, p]) => presetInNewWords(p));
  }

  /** The listing's guard for one name: the record under the key must be the preset asked for. */
  async #preset(
    storage: { get<T>(key: string): Promise<T | undefined> },
    userId: string,
    name: string,
  ): Promise<SavedPreset | undefined> {
    const p = await storage.get<SavedPreset>(`pr:${userId}:${name}`);
    return p && p.name === name ? presetInNewWords(p) : undefined;
  }

  /** Only a record that is this person's, by the listing's guard. */
  async deletePreset(userId: string, name: string): Promise<boolean> {
    if ((await this.getPreset(userId, name)) === undefined) return false;
    return this.ctx.storage.delete(`pr:${userId}:${name}`);
  }

  async handleOf(userId: string): Promise<string | undefined> {
    return this.ctx.storage.get<string>(`uh:${userId}`);
  }

  async userOfHandle(handle: string): Promise<string | undefined> {
    return this.ctx.storage.get<string>(`hn:${handle}`);
  }

  /**
   * `BellmanStore.handleHolders`: one list of the `uh:` rows, the user id being all of the key past the prefix, so an id
   * that holds a colon is read whole. Storage lists keys in ascending order, which is the user id order the method promises.
   */
  async handleHolders(): Promise<{ userId: string; handle: string }[]> {
    const rows = await this.ctx.storage.list<string>({ prefix: "uh:" });
    return [...rows].map(([key, handle]) => ({ userId: key.slice("uh:".length), handle }));
  }

  async claimHandle(userId: string, handle: string): Promise<"claimed" | "taken"> {
    return this.ctx.storage.transaction(async (txn) => {
      const holder = await txn.get<string>(`hn:${handle}`);
      if (holder !== undefined) return holder === userId ? "claimed" : "taken";
      const old = await txn.get<string>(`uh:${userId}`);
      if (old !== undefined) await txn.delete(`hn:${old}`);
      await txn.put({ [`hn:${handle}`]: userId, [`uh:${userId}`]: handle });
      return "claimed";
    });
  }

  async releaseHandle(userId: string): Promise<void> {
    await this.ctx.storage.transaction((txn) => this.#release(txn, userId));
  }

  async releaseHandleNamed(handle: string): Promise<string | undefined> {
    return this.ctx.storage.transaction(async (txn) => {
      const userId = await txn.get<string>(`hn:${handle}`);
      if (userId !== undefined) await this.#release(txn, userId);
      return userId;
    });
  }

  /** A person's handle and every signature, inside the caller's transaction. */
  async #release(txn: DurableObjectTransaction, userId: string): Promise<void> {
    const handle = await txn.get<string>(`uh:${userId}`);
    const signed = (await this.#signed(txn, userId)).map(([sessionId]) => `hs:${userId}:${sessionId}`);
    const keys = [`uh:${userId}`, ...signed, ...(handle === undefined ? [] : [`hn:${handle}`])];
    // A delete takes at most KEYS_PER_CALL keys.
    for (let i = 0; i < keys.length; i += KEYS_PER_CALL) await txn.delete(keys.slice(i, i + KEYS_PER_CALL));
  }

  async signRoom(userId: string, sessionId: string, at: number): Promise<string | undefined> {
    return this.ctx.storage.transaction(async (txn) => {
      const handle = await txn.get<string>(`uh:${userId}`);
      if (handle !== undefined) await txn.put(`hs:${userId}:${sessionId}`, at);
      return handle;
    });
  }

  async unsignRoom(userId: string, sessionId: string): Promise<void> {
    await this.ctx.storage.delete(`hs:${userId}:${sessionId}`);
  }

  async signedRooms(userId: string): Promise<{ sessionId: string; signedAt: number }[]> {
    return (await this.#signed(this.ctx.storage, userId))
      .map(([sessionId, signedAt]) => ({ sessionId, signedAt }))
      .sort((a, b) => b.signedAt - a.signedAt || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  }

  /**
   * `hs:<userId>:<sessionId>` — the rooms a person signed (bylines spec D2), as `[sessionId, signedAt]`.
   * The same shape as `pr:`, so the same collision: an operator-issued user id may hold a colon, and
   * one person's prefix then covers the rows of someone whose id extends it. A session id is
   * `qs_<uuid>` and holds none, so a key with a colon past this person's prefix is not theirs. The read
   * and the release both list through here, so they agree on whose rows these are.
   */
  async #signed(
    storage: { list<T>(options: { prefix: string }): Promise<Map<string, T>> },
    userId: string,
  ): Promise<[string, number][]> {
    const prefix = `hs:${userId}:`;
    const rows = await storage.list<number>({ prefix });
    return [...rows]
      .map(([key, signedAt]): [string, number] => [key.slice(prefix.length), signedAt])
      .filter(([sessionId]) => !sessionId.includes(":"));
  }

  async bylineFor(userId: string, sessionId: string): Promise<string | undefined> {
    const [handle, signed] = await Promise.all([
      this.ctx.storage.get<string>(`uh:${userId}`),
      this.ctx.storage.get<number>(`hs:${userId}:${sessionId}`),
    ]);
    return handle !== undefined && signed !== undefined ? handle : undefined;
  }

  /**
   * The record and the counter move together, or the count drifts from the
   * records it is meant to count.
   *
   * The counter starts at 0 and only ever increments on a first insert. It is
   * never seeded by reading the keys back, which is how AuthDO's client count
   * came to report 2 for one registration (#122): there were no users before
   * this landed, so 0 is the true starting point and there is nothing to seed.
   */
  async recordSignIn(userId: string, now: number): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const seen = await txn.get<UserRecord>(userKey(userId));
      if (!seen) await txn.put(USER_COUNT, ((await txn.get<number>(USER_COUNT)) ?? 0) + 1);
      await txn.put(userKey(userId), {
        userId,
        firstSeenAt: seen?.firstSeenAt ?? now,
        lastSeenAt: now,
      } satisfies UserRecord);
    });
  }

  async countUsers(): Promise<number> {
    return (await this.ctx.storage.get<number>(USER_COUNT)) ?? 0;
  }

  /**
   * The write a room's outbox delivers as `creator_ban`: the check and the write in one transaction, and
   * only while the creator holds no ban on the account, so a redelivery and an eviction that asks again
   * both keep the first ban.
   */
  async putCreatorBan(creatorId: string, ban: CreatorBan): Promise<void> {
    const key = creatorBanKey(creatorId, ban.userId);
    await this.ctx.storage.transaction(async (txn) => {
      if ((await txn.get(key)) === undefined) await txn.put(key, ban);
    });
  }

  /** This creator's rows, oldest first. The prefix ends at the colon after their encoded id, so it reaches no other creator's. */
  async creatorBans(creatorId: string): Promise<CreatorBan[]> {
    const rows = await this.ctx.storage.list<CreatorBan>({ prefix: creatorBanPrefix(creatorId) });
    return [...rows.values()].sort(oldestFirst);
  }

  /** Found and deleted in one transaction. A string that is not a ban id is answered before storage is read. */
  async liftCreatorBan(creatorId: string, banId: string): Promise<boolean> {
    if (!isBanId(banId)) return false;
    return this.ctx.storage.transaction(async (txn) => {
      const rows = await txn.list<CreatorBan>({ prefix: creatorBanPrefix(creatorId) });
      const found = [...rows].find(([, ban]) => ban.banId === banId);
      if (found === undefined) return false;
      await txn.delete(found[0]);
      return true;
    });
  }

  /** One read, for a seating. */
  async isBannedByCreator(creatorId: string, userId: string): Promise<boolean> {
    return (await this.ctx.storage.get(creatorBanKey(creatorId, userId))) !== undefined;
  }

  async suspend(userId: string, s: Suspension): Promise<void> {
    await this.ctx.storage.put(suspensionKey(userId), s);
  }

  async unsuspend(userId: string): Promise<boolean> {
    return this.ctx.storage.delete(suspensionKey(userId));
  }

  async isSuspended(userId: string): Promise<boolean> {
    return (await this.ctx.storage.get(suspensionKey(userId))) !== undefined;
  }

  /**
   * `BellmanStore.fileReport`, in one transaction: the fold's read, the day's count and the writes are one step, so
   * two filings cannot both pass the limit or both miss each other's fold. A fold and a refusal write nothing. The
   * filer's times are pruned to the day on the write that adds one, so a row never holds more than the limit.
   */
  async fileReport(r: NewReport, now: number): Promise<FiledReport> {
    return this.ctx.storage.transaction(async (txn): Promise<FiledReport> => {
      const foldKey = reportFoldKey(r.reporterUserId, r.sessionId, targetKey(r.target));
      const foldedId = await txn.get<string>(foldKey);
      const open = foldedId === undefined ? undefined : await txn.get<Report>(reportKey(foldedId));
      if (open?.resolvedAt === null) return { outcome: "folded", report: open };
      const timesKey = reportTimesKey(r.reporterUserId);
      const kept = withinWindow((await txn.get<number[]>(timesKey)) ?? [], now);
      if (kept.length >= REPORTS_PER_DAY) return { outcome: "limited", retryAfterMs: kept[0] + REPORT_WINDOW_MS - now };
      const report: Report = { ...r, id: reportId(now), at: now, resolvedAt: null, resolution: null, resolvedBy: null };
      await txn.put<unknown>({
        [reportKey(report.id)]: report,
        [foldKey]: report.id,
        [timesKey]: [...kept, now],
        [reportOpenKey(report.id)]: report.id,
        ...(reachesCreator(r) ? { [reportCreatorKey(r.creatorId, r.sessionId, report.id)]: report.id } : {}),
      });
      return { outcome: "filed", report };
    });
  }

  /**
   * This creator's rows for this room, newest first. The prefix ends at the colon after the room's id, so it reaches no
   * other room's.
   *
   * ponytail: a room's reports are read whole. A limit and a cursor if a public room ever gathers thousands.
   */
  async roomReports(creatorId: string, sessionId: string): Promise<Report[]> {
    const ids = [...(await this.ctx.storage.list<string>({
      prefix: reportCreatorPrefix(creatorId, sessionId), reverse: true,
    })).values()];
    const rows = await getRows<Report>(this.ctx.storage, ids.map(reportKey));
    return ids.flatMap((id) => rows.get(reportKey(id)) ?? []);
  }

  /**
   * `BellmanStore.listReports`: the open reports, from the `ro:` rows, newest first and at most `limit`, then the resolved
   * ones to fill what is left, which is none when the open ones fill the cut. When the open reports are fewer than `limit`
   * these are all of them, so at most that many of the newest `limit` reports are open and the rest of those are resolved:
   * reading `limit` rows of the queue finds every resolved report the cut needs. Neither read is more than `limit` rows,
   * however many reports the registry holds.
   */
  async listReports(limit: number): Promise<Report[]> {
    const openIds = [...(await this.ctx.storage.list<string>({ prefix: REPORT_OPEN_PREFIX, reverse: true, limit })).values()];
    const rows = await getRows<Report>(this.ctx.storage, openIds.map(reportKey));
    const open = openIds.flatMap((id) => rows.get(reportKey(id)) ?? []);
    const newest = [...(await this.ctx.storage.list<Report>({ prefix: REPORT_PREFIX, reverse: true, limit })).values()];
    return [...open, ...newest.filter((r) => r.resolvedAt !== null).slice(0, limit - open.length)];
  }

  /**
   * `BellmanStore.resolveReport`, in one transaction: the stamp, the end of the fold and the date of the deletion
   * land together. The due row takes the earlier of what it holds and this report's date, so a report resolved after
   * another never moves the alarm back; `#purgeReports` sets it to the next date when it runs. The alarm is pointed
   * at it after the commit, because `reArm()` reads the due rows the commit wrote.
   */
  async resolveReport(id: string, resolution: { note: string; by: string }, now: number): Promise<Report | undefined> {
    const outcome = await this.ctx.storage.transaction(async (txn) => {
      const report = await txn.get<Report>(reportKey(id));
      // An unknown id answers nothing, and a resolved report is answered as it is: the first resolution stands.
      if (report === undefined || report.resolvedAt !== null) return { report, scheduled: false };
      const done: Report = { ...report, resolvedAt: now, resolution: resolution.note, resolvedBy: resolution.by };
      const purgeAt = now + REPORT_RETENTION_MS;
      const due = await txn.get<number>(dueKey(REPORT_PURGE_HANDLER));
      await txn.delete([reportFoldKey(report.reporterUserId, report.sessionId, targetKey(report.target)), reportOpenKey(id)]);
      await txn.put<unknown>({
        [reportKey(id)]: done,
        [reportPurgeKey(purgeAt, id)]: id,
        [dueKey(REPORT_PURGE_HANDLER)]: due === undefined ? purgeAt : Math.min(due, purgeAt),
      });
      return { report: done, scheduled: true };
    });
    if (outcome.scheduled) await this.driver.reArm();
    return outcome.report;
  }
}

// ---------------------------------------------------------------------------
// AuditDO — one per org
// ---------------------------------------------------------------------------

/** The stream's tables (audit trail spec, D5). `AUTOINCREMENT` never reuses a seq, so a cursor once handed out names one row for good. */
const AUDIT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS entries (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    org_id TEXT,
    session_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    actor_label TEXT,
    actor_org TEXT,
    room_name TEXT,
    parties TEXT,
    crossing TEXT,
    direction TEXT,
    detail TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS entries_at ON entries (at)",
  "CREATE TABLE IF NOT EXISTS delivered (intent_id TEXT PRIMARY KEY, seq INTEGER NOT NULL)",
];

/** Insert one entry and return its seq: the one given, for a row moved from the KV shape, or the next. */
function insertAuditRow(sql: SqlStorage, e: AuditEntry, seq: number | null = null): number {
  return sql.exec<{ seq: number }>(
    `INSERT INTO entries (seq, ${AUDIT_COLUMNS.join(", ")}) VALUES (?, ${AUDIT_COLUMNS.map(() => "?").join(", ")}) RETURNING seq`,
    seq, ...recordOf(e),
  ).one().seq;
}

/** How many KV rows the move holds in memory at once, whatever the stream's size. */
const MOVE_BATCH = 500;

/**
 * Every KV row under `prefix`, in key order, handed to `move` and deleted, a batch at a time.
 * Each batch starts after the last key of the one before, so the walk ends however a delete
 * inside the transaction shows to the next list.
 */
function moveKv<T>(storage: DurableObjectStorage, prefix: string, move: (key: string, value: T) => void): void {
  let after: string | undefined;
  for (;;) {
    const batch = [...storage.kv.list<T>({ prefix, startAfter: after, limit: MOVE_BATCH })];
    if (batch.length === 0) return;
    for (const [key, value] of batch) {
      move(key, value);
      storage.kv.delete(key);
    }
    after = batch.at(-1)![0];
  }
}

/**
 * The tables, and a stream written in the KV shape (`a:<seq>` rows, the `seq` counter,
 * `d:<intent>` markers) moved into them. Run inside one `transactionSync`, so it lands
 * whole or not at all, however many batches it reads.
 *
 * Into an empty table each row keeps the seq its key carries, so every cursor already handed
 * out still names its row. Once the table holds rows, what is in KV was written there by an
 * older Worker after a rollback: it read the deleted `seq` counter as 0 and counted again
 * from 1, so its keys would collide with rows that exist. Those are appended in key order
 * with the next seqs instead, so nothing collides and nothing is lost, and a stream moved
 * once and then written to by an older Worker still wakes. Which of the two applies is decided
 * once, before the first batch: after that batch the table is never empty.
 * ponytail: memory is flat, MOVE_BATCH rows at a time. Time is the ceiling left: blockConcurrencyWhile
 * allows 30 s, about two million rows at the 15 µs a row measured locally. Past that, move it across wakes.
 */
function migrateAudit(storage: DurableObjectStorage): void {
  for (const ddl of AUDIT_SCHEMA) storage.sql.exec(ddl);
  const keepKeySeqs = storage.sql.exec("SELECT 1 FROM entries LIMIT 1").toArray().length === 0;
  moveKv<AuditEntry>(storage, "a:", (key, entry) => insertAuditRow(storage.sql, entry, keepKeySeqs ? Number(key.slice(2)) : null));
  // After a rollback a mark keeps the older build's KV seq, not its row's: informational, dedupe reads intent_id.
  moveKv<number>(storage, "d:", (key, seq) => {
    storage.sql.exec("INSERT OR IGNORE INTO delivered (intent_id, seq) VALUES (?, ?)", key.slice(2), seq);
  });
  storage.kv.delete("seq");
}

export class AuditDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    // Before any call is let in: the tables, and a stream still in the KV shape moved into them.
    void this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.transactionSync(() => migrateAudit(this.ctx.storage));
    });
  }

  /**
   * Append an audit entry, at most once per intent.
   *
   * The outbox that feeds this delivers at least once: a row is deleted only after this
   * call returns, so an acknowledgement lost in flight redelivers. The `delivered` row is
   * what makes that safe. The look at it, the entry and the marker are one synchronous
   * transaction, so no second delivery can come between the look and the writes, and a
   * throw anywhere in it rolls all of it back: an audit log that could drop or double the
   * record of a privilege change would not be one. Callers with no intent to redeliver pass
   * no id and always append.
   */
  async append(entry: AuditEntry, intentId?: string): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      if (intentId !== undefined && sql.exec("SELECT 1 FROM delivered WHERE intent_id = ?", intentId).toArray().length > 0) {
        return;
      }
      const seq = insertAuditRow(sql, entry);
      if (intentId !== undefined) sql.exec("INSERT INTO delivered (intent_id, seq) VALUES (?, ?)", intentId, seq);
    });
  }

  /** The newest `limit` entries, oldest first: `bellman_audit`'s read. */
  async recent(limit: number): Promise<AuditEntry[]> {
    return this.ctx.storage.sql
      .exec<AuditRecord>("SELECT * FROM entries ORDER BY seq DESC LIMIT ?", limit)
      .toArray()
      .reverse()
      .map(entryOf)
      .map(({ seq: _seq, ...entry }) => entry);
  }

  /** One page under the filters, newest first (D6): the same answer `pageOf` gives over memory. */
  async query(q: AuditQuery): Promise<AuditPage> {
    const sql = this.ctx.storage.sql;
    const through = q.through ?? sql.exec<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM entries").one().seq;
    const page = auditWhere(q, through, { scope: true, before: true });
    const rows = sql.exec<AuditRecord>(
      `SELECT * FROM entries ${page.clause} ORDER BY seq DESC LIMIT ?`, ...page.params, q.limit + 1,
    ).toArray();
    const all = auditWhere(q, through, { scope: true, before: false });
    const total = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM entries ${all.clause}`, ...all.params).one().n;
    let unrecorded = 0;
    // A row from before D2 records no crossing and no parties, so neither filter can judge it (D4).
    if (q.scope !== undefined || q.org !== undefined) {
      const rest = auditWhere({ ...q, org: undefined }, through, { scope: false, before: false });
      unrecorded = sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM entries ${rest.clause ? `${rest.clause} AND` : "WHERE"} crossing IS NULL`, ...rest.params,
      ).one().n;
    }
    const entries = rows.slice(0, q.limit).map(entryOf);
    return { entries, next: rows.length > q.limit ? entries.at(-1)!.seq : null, through, total, unrecorded };
  }

  /**
   * What the filters offer (D6), newest first. A label or a room's name comes from its newest
   * row: SQLite reads a bare column of a MAX() group from the row that holds the max.
   * ponytail: `at` is the only index; these and the filters on actor, room and action read the
   * table by seq, and gain indexes when a stream is large enough to feel the scan.
   */
  async facets(): Promise<AuditFacets> {
    const sql = this.ctx.storage.sql;
    return {
      actors: sql.exec<{ id: string; label: string | null; newest: number }>(
        "SELECT actor_id AS id, actor_label AS label, MAX(seq) AS newest FROM entries GROUP BY actor_id ORDER BY newest DESC LIMIT ?",
        FACET_LIMIT,
      ).toArray().map(({ id, label }) => ({ id, label })),
      rooms: sql.exec<{ id: string; name: string | null; newest: number }>(
        "SELECT session_id AS id, room_name AS name, MAX(seq) AS newest FROM entries WHERE session_id NOT LIKE 'grant:%' GROUP BY session_id ORDER BY newest DESC LIMIT ?",
        FACET_LIMIT,
      ).toArray().map(({ id, name }) => ({ id, name })),
      orgs: sql.exec<{ org: string; newest: number }>(
        "SELECT p.value AS org, MAX(e.seq) AS newest FROM entries e, json_each(e.parties) p WHERE p.value IS NOT NULL AND p.value != e.org_id GROUP BY p.value ORDER BY newest DESC, org ASC LIMIT ?",
        FACET_LIMIT,
      ).toArray().map(({ org }) => org),
      actions: sql.exec<{ action: string; newest: number }>(
        "SELECT action, MAX(seq) AS newest FROM entries GROUP BY action ORDER BY newest DESC LIMIT ?",
        FACET_LIMIT,
      ).toArray().map(({ action }) => action),
    };
  }
}

// ---------------------------------------------------------------------------
// The BellmanStore facade the Worker hands to buildServer()
// ---------------------------------------------------------------------------

export interface BellmanEnv {
  SESSION: DurableObjectNamespace<SessionDO>;
  REGISTRY: DurableObjectNamespace<RegistryDO>;
  AUDIT: DurableObjectNamespace<AuditDO>;
  /** One per hosted room, keyed by session id (hosted seat spec, D4). */
  HOST: DurableObjectNamespace<HostDO>;
  /** The room blob store (#183): a room's objects are deleted from it when the room is purged (#65). */
  BLOBS: R2Bucket;
  BELLMAN_KEYS?: string;
  /**
   * on | off, a var in wrangler.toml. The Worker reads it for `bellman_start` and `HostDO` for
   * its wakes (`hostedSeatOn`, src/host.ts); unset, empty or anything but "on" is off.
   */
  BELLMAN_HOSTED_SEAT?: string;
  /** User ids the hosted seat is on for while BELLMAN_HOSTED_SEAT is off (`hostedSeatUsers`, src/host.ts). */
  BELLMAN_HOSTED_SEAT_USERS?: string;
  /** A Worker secret. Absent, the seat's model calls go out unauthenticated and are refused. */
  ANTHROPIC_API_KEY?: string;
  /** Where the seat's model calls go. Unset means Anthropic's Messages API (spec D7). */
  MODEL_URL?: string;
}

export class DurableObjectStore implements BellmanStore {
  constructor(private env: BellmanEnv) {}

  /**
   * The three ways into a Durable Object, and every one of them `reviving`.
   *
   * This is the whole seam between the Worker's realm and the objects', so wrapping
   * it here covers every method on this facade — including ones added later, which a
   * per-method wrapper would not. workerd reconstructs a thrown error without its
   * prototype, so without this an `instanceof` outside an object never matches a
   * class thrown inside one (#101). `reviving` is a no-op on anything that does not
   * need it, so there is no call it is wrong for.
   */
  private session(id: string) {
    return reviving(this.env.SESSION.get(this.env.SESSION.idFromName(id)));
  }

  private get registry() {
    return reviving(this.env.REGISTRY.get(this.env.REGISTRY.idFromName("registry")));
  }

  private audit(orgId: string) {
    return reviving(this.env.AUDIT.get(this.env.AUDIT.idFromName(orgId)));
  }

  /**
   * Write into a derived index: attempted after the authoritative state is
   * committed, and a failure is logged rather than thrown.
   *
   * By the time an index is written, SessionDO has already committed the room
   * or the seat. A write that threw from here would abort the caller after its
   * effect had landed — a seat with no `member_joined` event and no audit row,
   * for a joiner who is told it failed. The index is derived and SessionDO is
   * authoritative, so swallowing costs a room missing from one listing. What
   * that costs depends on the listing: for `um:` a room missing from its
   * member's list, for `us:` a room a lapse cannot freeze, which outlives the
   * plan that pays for it.
   *
   * The row stays missing. Nothing rebuilds an index today: re-deriving `um:`
   * from SessionDO.members needs a list of sessions to walk, and the only list
   * of sessions the registry holds is `us:`, which has none of its own to be
   * rebuilt from. So the log line is the record of what to restore, and it
   * names both halves of the row's key — the user and the room.
   *
   * Only for indexes. The join code writes do not come through here: a join
   * code that does not resolve is a real failure, not a missing listing row.
   */
  private async writeIndex(
    index: string, userId: string, sessionId: string, write: () => Promise<unknown>
  ): Promise<void> {
    try {
      await write();
    } catch (err) {
      console.error(
        `${index} index write failed for ${userId} in ${sessionId}; ` +
          "that room is missing from their listing:",
        err,
      );
    }
  }

  async createSession(s: NewSession): Promise<void> {
    // Join codes register themselves from inside SessionDO, in the same
    // transaction as the session write. See #62.
    await this.session(s.id).createSession(s);
    // The join codes are already done: SessionDO enqueued a putJoinCode for each in
    // the same transaction as the session write, and delivered them. That is what #62
    // closed, so there is no putJoinCode call here any more — one would register every
    // code a second time.
    //
    // Every write below is an index, derived from what is committed above and attempted
    // after it, so a failure is logged rather than thrown (see writeIndex). Each is a
    // write into a second object with no transaction spanning it — the same gap #62
    // closed for the codes, still open here — and a lost one costs a row in one
    // listing, never the room.
    //
    // `us:` is how a lapsed plan finds this person's rooms, which bare create counts
    // cannot say. A missed entry means a room that is not frozen.
    await this.writeIndex("us", s.createdBy, s.id, () =>
      this.registry.indexSession(s.createdBy, s.id));
    // The members a session is created with are seated directly — bellman_start hands
    // over the creator in `members` and never calls addMember — so the joined index is
    // written here as well as in addMember. A missed entry leaves the room out of that
    // person's joined listing. Once a person, however many of the seats are theirs.
    for (const userId of new Set(s.members.map((m) => m.userId))) {
      await this.writeIndex("um", userId, s.id, () =>
        this.registry.indexMembership(userId, s.id));
    }
    // `uo:` is how an org's admin finds a closed room its people sat in (#65, D5): one row for each
    // org on the roster it starts with, the creator's included. A missed entry leaves the room out of
    // that one list, and the admin's read of it by id works all the same.
    for (const orgId of orgsOnRoster(s)) {
      await this.writeIndex("uo", orgId, s.id, () => this.registry.indexOrg(orgId, s.id));
    }
  }

  async getSession(id: string): Promise<StoredSession | undefined> {
    return this.session(id).getSession();
  }

  async getSessionByJoinCode(code: string): Promise<{ session: StoredSession; role: string } | undefined> {
    const id = await this.registry.lookupJoinCode(code);
    if (!id) return undefined;
    const session = await this.getSession(id);
    if (!session || session.closed) return undefined;
    const hit = Object.entries(session.joinCodes).find(([, rec]) => rec.code === code);
    if (!hit) return undefined; // consumed or rotated
    const [role, rec] = hit;
    if (!codeIsLive(rec, Date.now())) return undefined;
    return { session, role };
  }

  async consumeJoinCode(sessionId: string, role: string): Promise<void> {
    await this.session(sessionId).consumeJoinCode(role);
  }

  async clearJoinCodes(sessionId: string): Promise<void> {
    await this.session(sessionId).clearJoinCodes();
  }

  async setJoinCode(
    sessionId: string, role: string, code: string, expiresAt: number | null,
    guard: { replaceLive: boolean; now: number },
  ): Promise<SetJoinCode> {
    return this.session(sessionId).setJoinCode(role, code, expiresAt, guard);
  }

  async addMember(sessionId: string, member: ArrivingMember): Promise<boolean> {
    const added = await this.session(sessionId).addMember(member);
    // Gated on the result: addMember refuses an unknown, frozen or closed
    // session, and indexing regardless would put rooms into a person's joined
    // listing that they were turned away from.
    //
    // Attempted after the seat is committed, and a failure is logged rather than
    // thrown (see writeIndex): the caller still has the join event and the audit
    // row to write, and a joiner who was seated must not be told otherwise. A
    // second write into a second object with no transaction spanning it — the
    // same gap as the join code and the creator index, tracked on #62 — so a
    // lost write costs the room a row in one listing and nothing else.
    if (added) {
      await this.writeIndex("um", member.userId, sessionId, () =>
        this.registry.indexMembership(member.userId, sessionId));
      // The member's org, when it has one: a person from another org joining puts the room in that
      // org's list too (#65, D5).
      const orgId = member.orgId;
      if (orgId) await this.writeIndex("uo", orgId, sessionId, () => this.registry.indexOrg(orgId, sessionId));
    }
    return added;
  }

  async seatMember(
    sessionId: string,
    member: ArrivingMember,
    staleBefore: number,
    now: number,
  ): Promise<SeatOutcome> {
    const seated = await this.session(sessionId).seatMember(member, staleBefore, now);
    // The same membership index write addMember does, under the same rules:
    // gated on the result so a refused seating leaves no room in this person's
    // joined listing, attempted after the seat is committed, and a failure
    // logged rather than thrown. Reclaiming a seat does not retract the
    // reclaimed member's own row — their history is still theirs to list.
    if (seated.refused === null) {
      await this.writeIndex("um", member.userId, sessionId, () =>
        this.registry.indexMembership(member.userId, sessionId));
      const orgId = member.orgId;
      if (orgId) await this.writeIndex("uo", orgId, sessionId, () => this.registry.indexOrg(orgId, sessionId));
    }
    return seated;
  }

  async removeMember(
    sessionId: string,
    memberId: string,
    req: RemovalRequest,
  ): Promise<RemovalOutcome> {
    return this.session(sessionId).removeMember(memberId, req);
  }

  async roomBans(sessionId: string): Promise<Ban[]> {
    return this.session(sessionId).roomBans();
  }

  async liftRoomBan(sessionId: string, banId: string): Promise<boolean> {
    return this.session(sessionId).liftRoomBan(banId);
  }

  async creatorBans(creatorId: string): Promise<CreatorBan[]> {
    return this.registry.creatorBans(creatorId);
  }

  async liftCreatorBan(creatorId: string, banId: string): Promise<boolean> {
    return this.registry.liftCreatorBan(creatorId, banId);
  }

  async isBannedByCreator(creatorId: string, userId: string): Promise<boolean> {
    return this.registry.isBannedByCreator(creatorId, userId);
  }

  async isBannedFromRoom(sessionId: string, userId: string): Promise<boolean> {
    return this.session(sessionId).isBanned(userId);
  }

  async suspend(userId: string, s: Suspension): Promise<void> {
    await this.registry.suspend(userId, s);
  }

  async unsuspend(userId: string): Promise<boolean> {
    return this.registry.unsuspend(userId);
  }

  async isSuspended(userId: string): Promise<boolean> {
    return this.registry.isSuspended(userId);
  }

  async fileReport(r: NewReport, now: number): Promise<FiledReport> {
    return this.registry.fileReport(r, now);
  }

  async roomReports(creatorId: string, sessionId: string): Promise<Report[]> {
    return this.registry.roomReports(creatorId, sessionId);
  }

  async listReports(limit: number): Promise<Report[]> {
    return this.registry.listReports(limit);
  }

  async resolveReport(id: string, resolution: { note: string; by: string }, now: number): Promise<Report | undefined> {
    return this.registry.resolveReport(id, resolution, now);
  }

  async connectedMembers(sessionId: string): Promise<ReadonlySet<string>> {
    return new Set(await this.session(sessionId).connectedMembers());
  }

  async updateMember(sessionId: string, memberId: string, patch: MemberPatch): Promise<void> {
    await this.session(sessionId).updateMember(memberId, patch);
  }

  async getBriefs(sessionId: string, memberIds: readonly string[]): Promise<Record<string, Brief>> {
    if (memberIds.length === 0) return {};
    return this.session(sessionId).getBriefs([...memberIds]);
  }

  async getMember(sessionId: string, memberId: string): Promise<Member | undefined> {
    return this.session(sessionId).getMember(memberId);
  }

  async getMembers(sessionId: string, memberIds: readonly string[]): Promise<Member[]> {
    if (memberIds.length === 0) return [];
    return this.session(sessionId).getMembers([...memberIds]);
  }

  async membersOfUser(sessionId: string, userId: string): Promise<Member[]> {
    return this.session(sessionId).membersOfUser(userId);
  }

  async departedMembers(sessionId: string, opts?: { limit?: number; leftAfter?: number }): Promise<DepartedMembers> {
    return this.session(sessionId).departedMembers(opts);
  }

  async publicNumbers(sessionId: string, labels: readonly string[]): Promise<Record<string, number>> {
    if (labels.length === 0) return {};
    return this.session(sessionId).publicNumbers([...labels]);
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.session(sessionId).closeSession();
    // The codes are retired in a call of their own: closeSession sets the flag, and
    // clearJoinCodes empties the map and queues each code's removal from the
    // registry, in one transaction.
    await this.clearJoinCodes(sessionId);
  }

  async closeSessionIfEmpty(sessionId: string): Promise<boolean> {
    // The decision is SessionDO's, made in one transaction. What follows it is
    // cleanup in a second object, with no transaction spanning the two (the gap
    // docs/ARCHITECTURE.md section 9 describes). A Worker that dies between them
    // leaves a stale registry row and not an open door: getSessionByJoinCode
    // refuses a closed session whatever the registry still holds.
    const closed = await this.session(sessionId).closeSessionIfEmpty();
    // Only a closed room gives up its codes, as closeSession does. A room left
    // open keeps them, because they are how its next member gets in. And a room
    // that was ALREADY closed gives them up too, not only one this call closed:
    // the retry of a close that died before the registry was reached finishes
    // the clear here, from the codes SessionDO left in the record.
    if (closed) await this.clearJoinCodes(sessionId);
    return closed;
  }

  async freezeSession(sessionId: string, frozenAt: number | null): Promise<void> {
    await this.session(sessionId).freezeSession(frozenAt);
  }

  async schedulePurge(sessionId: string, at: number, by: AuditActor | null): Promise<PurgeSchedule> {
    return this.session(sessionId).schedulePurge(at, by);
  }

  async unpublishSession(sessionId: string, at: number): Promise<void> {
    await this.session(sessionId).unpublishSession(at);
  }

  async publicNameEntry(name: string): Promise<PublicNameEntry | null> {
    return (await this.registry.lookupPublicName(name)) ?? null;
  }

  async publicNameEntries(limit: number): Promise<{ name: string; entry: PublicNameEntry }[]> {
    return this.registry.listPublicNames(limit);
  }

  async claimPublicName(name: string, entry: PublicNameEntry, expected: PublicNameEntry | null): Promise<boolean> {
    return this.registry.claimPublicName(name, entry, expected);
  }

  async releasePublicName(name: string, expected: PublicNameEntry): Promise<boolean> {
    return this.registry.releasePublicName(name, expected);
  }

  async setPublicName(sessionId: string, name: string): Promise<void> {
    await this.session(sessionId).setPublicName(name);
  }

  async setPublicView(sessionId: string, view: PublicView): Promise<void> {
    await this.session(sessionId).setPublicView(view);
  }

  async sweepBlobs(sessionId: string): Promise<{ removed: number; credited: number }> {
    return this.session(sessionId).sweepBlobs();
  }

  /**
   * Rooms this person created that a lapse could still freeze.
   *
   * The registry holds the index and cannot read a room's state; the room is in
   * another object. So the paging is here: ask for a window of ids, resolve
   * each, keep the live ones, and go back for more until `limit` is met or the
   * range runs out. `limit` therefore counts live rooms, which is what every
   * caller meant by it.
   *
   * Closed is the whole predicate, and `getSession` is what decides it: it runs
   * the abandonment check, so an abandoned room reads closed here even if no alarm
   * has fired yet. A room that is merely frozen stays — a lapse freezing an
   * already-frozen room is harmless, and leaving it out would hide it from the
   * one listing that can find it again.
   *
   * The drop is a second write into a second object with no transaction
   * spanning it, the gap docs/ARCHITECTURE.md section 9 describes — and the
   * cheapest instance of it in the codebase. A drop that dies leaves the row it
   * was going to remove, which is the state this call already tolerates and
   * repairs on the next walk.
   */
  async sessionsCreatedBy(userId: string, limit: number): Promise<string[]> {
    const live: string[] = [];
    let startAfter: string | undefined;
    // The budget bounds the SWEEPING, not the rooms the caller asked for, and
    // that distinction is the whole of it. Counting live rows against it made
    // the contract above false: with `limit` above the budget and every row
    // live, the walk stopped early having dropped nothing, and because
    // `startAfter` is local to one call the next call began at the beginning and
    // returned the same short page for ever. No progress, no error, no way to
    // tell.
    //
    // So a live row costs nothing here. It is what the caller asked for, it is
    // bounded by `limit`, and choosing a `limit` one request can resolve is the
    // caller's to do. What is unbounded without this is the DEAD tail — an
    // account with thousands of closed rooms — and spending a Workers request's
    // 1,000-subrequest cap on it throws, failing the walk outright rather than
    // returning a short list. Those rows are dropped as they are met, so the
    // next walk really does start further in.
    let swept = 0;

    while (live.length < limit && swept < SWEEP_RPC_BUDGET) {
      // A full window each time, not `limit - live.length`: the rows that fail
      // are the ones being skipped, so asking for only what is still wanted
      // turns a page of closed rooms into one id per round trip.
      const page = await this.registry.createdIndexPage(userId, limit, startAfter);
      if (page.length === 0) break;

      for (const id of page) {
        if (live.length >= limit || swept >= SWEEP_RPC_BUDGET) break;
        const session = await this.session(id).getSession();
        if (session && !session.closed) {
          live.push(id);
          continue;
        }
        await this.registry.dropCreatedIndex(userId, id);
        // The resolve that found it dead and the drop that removed it: the two
        // calls this row cost that the caller did not ask for.
        swept += 2;
      }
      // A short window means the range is exhausted; nothing follows to scan.
      if (page.length < limit) break;
      startAfter = page[page.length - 1];
    }
    return live;
  }

  async sessionsJoinedBy(userId: string, limit: number): Promise<string[]> {
    return this.registry.sessionsJoinedBy(userId, limit);
  }

  async sessionsForOrg(orgId: string, limit: number): Promise<string[]> {
    return this.registry.sessionsForOrg(orgId, limit);
  }

  async appendEvent(
    sessionId: string,
    e: Omit<SessionEvent, "cursor" | "at">,
    extras: AppendExtras = {}
  ): Promise<SessionEvent | null> {
    return this.session(sessionId).appendEvent(e, extras);
  }

  async appendEventOnce(
    sessionId: string,
    e: Omit<SessionEvent, "cursor" | "at">,
    key: string,
    extras: AppendExtras = {}
  ): Promise<EventWrite> {
    return this.session(sessionId).appendEventOnce(e, key, extras);
  }

  async admitSend(sessionId: string, key: string, limit: number, now: number): Promise<SendAdmission> {
    return this.session(sessionId).admitSend(key, limit, now);
  }

  async eventsAfter(sessionId: string, cursor: number, limit?: number): Promise<SessionEvent[]> {
    return this.session(sessionId).eventsAfter(cursor, limit);
  }

  async eventAt(sessionId: string, cursor: number): Promise<SessionEvent | undefined> {
    return this.session(sessionId).eventAt(cursor);
  }

  async recentEvents(sessionId: string, limit: number): Promise<SessionEvent[]> {
    return this.session(sessionId).recentEvents(limit);
  }

  async surfaceOf(sessionId: string): Promise<SurfaceRow[]> {
    return this.session(sessionId).surfaceOf();
  }

  async chargeBlobBytes(sessionId: string, bytes: number): Promise<BlobCharge> {
    return this.session(sessionId).chargeBlobBytes(bytes);
  }

  async appendHostEvent(
    sessionId: string,
    e: Omit<SessionEvent, "cursor" | "at">,
    units: number,
    now: number,
    key: string,
  ): Promise<HostAppend> {
    return this.session(sessionId).appendHostEvent(e, units, now, key);
  }

  async hostEventFor(sessionId: string, key: string): Promise<SessionEvent | undefined> {
    return this.session(sessionId).hostEventFor(key);
  }

  async renewHostAllowance(sessionId: string, month: string, units: number): Promise<void> {
    await this.session(sessionId).renewHostAllowance(month, units);
  }

  async setHostInstructions(sessionId: string, instructions: string | null, audit: readonly AuditEntry[]): Promise<HostInstructionsSet> {
    return this.session(sessionId).setHostInstructions(instructions, audit);
  }

  async waitForEvents(
    sessionId: string,
    cursor: number,
    waitMs: number,
    limit?: number
  ): Promise<SessionEvent[]> {
    return this.session(sessionId).waitForEvents(cursor, waitMs, limit);
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

  async reserveHostedRoom(userId: string, sessionId: string, limit: number): Promise<HostedSlot> {
    return this.registry.reserveHostedRoom(userId, sessionId, limit);
  }

  async releaseHostedRoom(userId: string, sessionId: string): Promise<void> {
    await this.registry.releaseHostedRoom(userId, sessionId);
  }

  async listPresets(userId: string): Promise<SavedPreset[]> {
    return this.registry.listPresets(userId);
  }

  async getPreset(userId: string, name: string): Promise<SavedPreset | undefined> {
    return this.registry.getPreset(userId, name);
  }

  async putPreset(userId: string, preset: SavedPreset, cap: number): Promise<"saved" | "full"> {
    return this.registry.putPreset(userId, preset, cap);
  }

  async deletePreset(userId: string, name: string): Promise<boolean> {
    return this.registry.deletePreset(userId, name);
  }

  async handleOf(userId: string): Promise<string | undefined> {
    return this.registry.handleOf(userId);
  }

  async userOfHandle(handle: string): Promise<string | undefined> {
    return this.registry.userOfHandle(handle);
  }

  async handleHolders(): Promise<{ userId: string; handle: string }[]> {
    return this.registry.handleHolders();
  }

  async claimHandle(userId: string, handle: string): Promise<"claimed" | "taken"> {
    return this.registry.claimHandle(userId, handle);
  }

  async releaseHandle(userId: string): Promise<void> {
    await this.registry.releaseHandle(userId);
  }

  async releaseHandleNamed(handle: string): Promise<string | undefined> {
    return this.registry.releaseHandleNamed(handle);
  }

  async signRoom(userId: string, sessionId: string, at: number): Promise<string | undefined> {
    return this.registry.signRoom(userId, sessionId, at);
  }

  async unsignRoom(userId: string, sessionId: string): Promise<void> {
    await this.registry.unsignRoom(userId, sessionId);
  }

  async signedRooms(userId: string): Promise<{ sessionId: string; signedAt: number }[]> {
    return this.registry.signedRooms(userId);
  }

  async bylineFor(userId: string, sessionId: string): Promise<string | undefined> {
    return this.registry.bylineFor(userId, sessionId);
  }

  async recordSignIn(userId: string, now: number): Promise<void> {
    await this.registry.recordSignIn(userId, now);
  }

  async countUsers(): Promise<number> {
    return this.registry.countUsers();
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
    expectedOrgId: string | null,
    audit: AuditIntent
  ): Promise<"written" | "conflict" | "full"> {
    return this.registry.putGrantIfOwned(grant, expectedOrgId, audit);
  }

  async deleteGrantIfOwned(
    key: string,
    expectedOrgId: string | null,
    audit: AuditIntent
  ): Promise<"deleted" | "missing" | "conflict"> {
    return this.registry.deleteGrantIfOwned(key, expectedOrgId, audit);
  }

  async putGrantIfSource(
    grant: PlanGrant,
    expectedSource: string,
    audit: AuditIntent
  ): Promise<GrantWrite> {
    return this.registry.putGrantIfSource(grant, expectedSource, audit);
  }

  async deleteGrantIfSource(
    key: string,
    expectedSource: string,
    audit: AuditIntent
  ): Promise<GrantDelete> {
    return this.registry.deleteGrantIfSource(key, expectedSource, audit);
  }

  async moveGrant(fromKey: string, toKey: string): Promise<void> {
    await this.registry.moveGrant(fromKey, toKey);
  }

  async listGrants(limit: number, orgId?: string | null): Promise<PlanGrant[]> {
    return this.registry.listGrants(limit, orgId);
  }

  async getOrg(orgId: string): Promise<Org | undefined> {
    return this.registry.getOrg(orgId);
  }

  async createOrg(org: Org, ownerGrant: PlanGrant, audit: AuditIntent): Promise<"created" | "exists" | "conflict"> {
    return this.registry.createOrg(org, ownerGrant, audit);
  }

  async updateOrg(orgId: string, patch: OrgPatch, audit: AuditIntent): Promise<Org | undefined> {
    return this.registry.updateOrg(orgId, patch, audit);
  }

  async countOrgMembers(orgId: string): Promise<number> {
    return this.registry.countOrgMembers(orgId);
  }

  async activatePurchasedOrg(
    orgId: string, ownerUserId: string, seats: number, audit: AuditIntent,
  ): Promise<"created" | "updated" | "unchanged" | "not_purchased"> {
    return this.registry.activatePurchasedOrg(orgId, ownerUserId, seats, audit);
  }

  async deactivateOrg(orgId: string, audit: AuditIntent): Promise<"updated" | "unchanged" | "missing" | "not_purchased"> {
    return this.registry.deactivateOrg(orgId, audit);
  }

  async putOrgIdp(orgId: string, idp: OrgIdp, audit: AuditIntent): Promise<"written" | "missing"> {
    return this.registry.putOrgIdp(orgId, idp, audit);
  }

  async getOrgIdp(orgId: string): Promise<OrgIdp | undefined> {
    return this.registry.getOrgIdp(orgId);
  }

  async deleteOrgIdp(orgId: string, audit: AuditIntent): Promise<"deleted" | "missing"> {
    return this.registry.deleteOrgIdp(orgId, audit);
  }

  async claimDomain(orgId: string, domain: string, token: string, now: number, audit: AuditIntent): Promise<"claimed" | "exists" | "missing"> {
    return this.registry.claimDomain(orgId, domain, token, now, audit);
  }

  async verifyDomain(orgId: string, domain: string, now: number, audit: AuditIntent): Promise<"verified" | "taken" | "unknown"> {
    return this.registry.verifyDomain(orgId, domain, now, audit);
  }

  async releaseDomain(orgId: string, domain: string, audit: AuditIntent): Promise<"released" | "unknown"> {
    return this.registry.releaseDomain(orgId, domain, audit);
  }

  async orgForDomain(domain: string): Promise<string | undefined> {
    return this.registry.orgForDomain(domain);
  }

  async provisionSsoMember(
    orgId: string, key: string, now: number, audit: AuditIntent, address?: string,
  ): Promise<"written" | "exists" | "full" | "no_org" | "deprovisioned"> {
    return this.registry.provisionSsoMember(orgId, key, now, audit, address);
  }

  async issueScimToken(orgId: string, token: ScimToken, audit: AuditIntent): Promise<"issued" | "replaced" | "missing"> {
    return this.registry.issueScimToken(orgId, token, audit);
  }

  async revokeScimToken(orgId: string, audit: AuditIntent): Promise<"revoked" | "missing"> {
    return this.registry.revokeScimToken(orgId, audit);
  }

  async scimTokenOf(orgId: string): Promise<ScimToken | undefined> {
    return this.registry.scimTokenOf(orgId);
  }

  async orgForScimToken(tokenHash: string): Promise<string | undefined> {
    return this.registry.orgForScimToken(tokenHash);
  }

  async createScimUser(user: ScimUser, audit: AuditIntent): Promise<ScimCreate> {
    return this.registry.createScimUser(user, audit);
  }

  async getScimUser(orgId: string, id: string): Promise<ScimUser | undefined> {
    return this.registry.getScimUser(orgId, id);
  }

  async scimUserByName(orgId: string, userName: string): Promise<ScimUser | undefined> {
    return this.registry.scimUserByName(orgId, userName);
  }

  async scimUserByKey(key: string): Promise<ScimUser | undefined> {
    return this.registry.scimUserByKey(key);
  }

  async listScimUsers(orgId: string, limit: number): Promise<ScimUser[]> {
    return this.registry.listScimUsers(orgId, limit);
  }

  async updateScimUser(orgId: string, id: string, patch: ScimUserPatch, now: number, audit: AuditIntent): Promise<ScimUpdate> {
    return this.registry.updateScimUser(orgId, id, patch, now, audit);
  }

  async deleteScimUser(orgId: string, id: string, now: number, audit: AuditIntent): Promise<ScimUser | undefined> {
    return this.registry.deleteScimUser(orgId, id, now, audit);
  }

  async putOrgInvite(invite: OrgInvite, audit: AuditIntent): Promise<"invited" | "exists" | "limit" | "no_org"> {
    return this.registry.putOrgInvite(invite, audit);
  }

  async listOrgInvites(orgId: string, limit: number): Promise<OrgInvite[]> {
    return this.registry.listOrgInvites(orgId, limit);
  }

  async invitesFor(keys: string[]): Promise<OrgInvite[]> {
    return this.registry.invitesFor(keys);
  }

  async deleteOrgInvite(orgId: string, key: string, audit: AuditIntent): Promise<"deleted" | "missing"> {
    return this.registry.deleteOrgInvite(orgId, key, audit);
  }

  async acceptOrgInvite(
    orgId: string, keys: string[], subjectKey: string, now: number, audit: AuditIntent,
  ): Promise<"joined" | "member" | "taken" | "full" | "sso" | "gone"> {
    return this.registry.acceptOrgInvite(orgId, keys, subjectKey, now, audit);
  }

  async declineOrg(subjectKey: string, orgId: string, now: number): Promise<void> {
    await this.registry.declineOrg(subjectKey, orgId, now);
  }

  async declinedOrgs(subjectKey: string): Promise<{ orgId: string; at: number }[]> {
    return this.registry.declinedOrgs(subjectKey);
  }

  async appendAudit(a: AuditEntry): Promise<void> {
    if (!a.orgId) return; // no org, no audit stream to write to
    await this.audit(a.orgId).append(a);
  }

  async auditForOrg(orgId: string, limit: number): Promise<AuditEntry[]> {
    return this.audit(orgId).recent(limit);
  }

  async queryAudit(orgId: string, query: AuditQuery): Promise<AuditPage> {
    return this.audit(orgId).query(query);
  }

  async auditFacets(orgId: string): Promise<AuditFacets> {
    return this.audit(orgId).facets();
  }

  /**
   * No-op by design. MemoryStore sweeps on a timer because it can iterate every
   * session cheaply; a DO namespace cannot. Abandonment is enforced by the
   * per-object alarm set in SessionDO.createSession, the sweep and the purge of a
   * closed room (#65) by the same alarm, a resolved report by the registry's
   * (`report_purge`), and connect tokens are checked for expiry when taken.
   * Nothing is left for a sweep to do.
   */
  async sweep(_now: number): Promise<void> {}
}
