/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from "cloudflare:workers";
import { allKeysFor, grantKey, orgIndexKey, orgIndexPrefix, staleIndexKeys } from "./grant-index.js";
import { SWEEP_RPC_BUDGET } from "./store.js";
import type { GrantDelete, GrantWrite, SetJoinCode } from "./store.js";
import type {
  AuditEntry, EventType, Member, PendingConnect, PlanGrant, Session, SessionEvent, SurfaceRow,
} from "./types.js";
import type {
  AppendExtras, BellmanStore, EventWrite, MemberPatch, RemovalOutcome, RemovalRequest,
  SeatOutcome,
} from "./store.js";
import {
  ABANDONED_AFTER_MS, abandonedAt, capacityOf, connectedAmong, creditReport, isAbandoned,
  isActiveMember, isRemovedMember, markRemoved, seatVictims, stampSeen,
} from "./store.js";
import { fingerprint, idempotencyKey, type IdempotencyRecord } from "./idempotency.js";
import { hydrateStoredSession, type StoredSession } from "./stored-session.js";
import { publicEvent } from "./public-event.js";
import { PING, PONG } from "./keepalive.js";
import { grantAuditEntries, revokeAuditEntries, type AuditIntent } from "./grant-audit.js";
import { OUTBOX_HANDLER, OutboxDriver, type OutboxIntent, type OutboxRow } from "./outbox.js";
import { clearSilence, dueMembers, nextTickAt, snapshotOf } from "./heartbeat.js";
import { UPGRADE_REQUIRED, wantsWebSocket } from "./upgrade.js";
import { reviving } from "./rpc-error.js";
import { applySurfaceWrite } from "./surface.js";

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
 * global iteration across a DO namespace, so abandonment is enforced by a
 * per-object alarm and connect tokens expire lazily on read. sweep() is
 * therefore a no-op — see the comment on the method.
 */

const CURSOR_PAD = 12;
const eventKey = (cursor: number) => `e:${String(cursor).padStart(CURSOR_PAD, "0")}`;
/** One row per surface item (#129). The key is a slug, so the prefix is injective. */
const surfaceKey = (key: string) => `sf:${key}`;
const SURFACE_PREFIX = "sf:";
const auditKey = (seq: number) => `a:${String(seq).padStart(CURSOR_PAD, "0")}`;
/**
 * Delivered intent ids, so a redelivered audit entry is applied once.
 * One row per entry that arrives with an id, and nothing prunes them, as
 * nothing prunes the entries.
 */
const deliveredKey = (intentId: string) => `d:${intentId}`;
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
 * Whether a room reads as closed, deciding it without writing: closed outright, or
 * abandoned with the alarm still to come. A row that is gone reads closed, which
 * is the answer an unknown room has always had.
 *
 * `attached` is what the object's sockets carry (`#attachedIds()`), because a
 * socket vouching for an active member is the one thing that keeps a room past
 * its window open. The rule is `isAbandoned`'s, shared with `#closeIfAbandoned`
 * and both stores' sweeps, so a room reads closed here exactly when the alarm
 * would close it.
 *
 * Every read that refuses a closed room goes through here, so the rule and the
 * refusals cannot drift apart. `membersOf` authorizes a watch with it and `fetch`
 * rechecks it before accepting the socket: one rule asked twice, which is what #133
 * was missing. With no recheck, a close landing between the two calls left a socket
 * on a closed room and nothing to close it.
 */
const readsClosed = (s: StoredSession | undefined, now: number, attached: Iterable<string>): boolean =>
  !s || s.closed || isAbandoned(s, now, connectedAmong(s.members, attached));

// ---------------------------------------------------------------------------
// SessionDO — one per Bellman session
// ---------------------------------------------------------------------------

export class SessionDO extends DurableObject<BellmanEnv> {
  /** Live long-polls. In-memory is correct: one instance serves this session. */
  private waiters: Waiter[] = [];

  /**
   * This object's one alarm, shared by name: the driver works out which handlers
   * are due and points the alarm at the soonest. Three handlers use it.
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
   * gate does not cover; AuditDO.append gives the same reason. That is a net under a
   * mistake and not a licence for one: the closure holds every other call to this
   * object until it commits (docs/ARCHITECTURE.md section 9, runtime fact 2), so
   * what goes inside it is storage and nothing slower.
   * worker-tests/session-close-join-race.test.ts holds a call at exactly that point.
   *
   * Not every mutator has been converted. updateMember, closeSession and freezeSession
   * still read and then put. They are unconverted, not exempt: the input gate covers
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
   */
  private async stored(
    from: { get<T>(key: string): Promise<T | undefined> } = this.ctx.storage
  ): Promise<StoredSession | undefined> {
    return hydrateStoredSession(await from.get("session"));
  }

  /**
   * TypeScript-`private` rather than `#private`, for the reason `stored` gives
   * and a third kind of cost (#126). `tests/store-do-wiring.test.ts` overrides
   * it on the INSTANCE to make a frame fail to build and to pin D5's ordering —
   * read, then attach, accept and send, with nothing yielding in between. An
   * override cannot shadow a `#private` method, so converting this would retire
   * both.
   */
  private async events(after = 0): Promise<SessionEvent[]> {
    const map = await this.ctx.storage.list<SessionEvent>({
      prefix: "e:",
      start: eventKey(after + 1),
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
   * `#private`, because it writes the event and any extra rows its caller supplies, and a
   * Durable Object answers RPC for every method on its class: TypeScript's `private` is
   * erased at compile time.
   */
  async #writeEvent(
    txn: DurableObjectTransaction,
    e: SessionEvent,
    extra: Record<string, unknown> = {},
    deletes: readonly string[] = [],
  ): Promise<void> {
    await txn.put<unknown>({
      [eventKey(e.cursor)]: e, cursor: e.cursor, ...extra,
    });
    // A removed surface row (#129), in the same transaction as the event that
    // removed it. After the put: a key is never both put and deleted here.
    for (const key of deletes) await txn.delete(key);
  }

  async createSession(s: Session): Promise<void> {
    const { events, ...rest } = s;
    // Session, seed events, cursor and the registrations its join codes owe land
    // together. Separately committed, an interruption could leave a session with no
    // events, or events with a cursor of zero, or a session whose code nothing can
    // resolve — and the alarm is what sweeps it, so a session that half-exists
    // would also never be cleaned up.
    const seeded: Record<string, unknown> = { session: rest, cursor: 0 };
    for (const e of events) seeded[eventKey(e.cursor)] = e;
    if (events.length > 0) seeded.cursor = events[events.length - 1].cursor;
    const intents = Object.values(rest.joinCodes).map((rec) => putCodeIntent(rec.code, s.id));
    await this.ctx.storage.transaction(async (txn) => {
      const rows = await this.driver.enqueue(txn, intents);
      await txn.put<unknown>({ ...seeded, ...rows });
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
    return this.stored();
  }

  /**
   * Which members this user owns here, and whether the room is closed.
   *
   * The authorization check for a /ws upgrade. Deliberately mirrors
   * findMember (src/server.ts), leftAt and all: bellman_sync serves a
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
    return {
      // `isRemovedMember` and not `isActiveMember`: see above. An identity that
      // holds one removed handle and one live one keeps its socket, on the live
      // one's entitlement (D5), which falls out of this filter without a rule.
      memberIds: s
        ? s.members.filter((m) => m.userId === userId && !isRemovedMember(m)).map((m) => m.memberId)
        : [],
      closed: readsClosed(s, Date.now(), this.#attachedIds()),
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
    return [...connectedAmong(s.members, this.#attachedIds())];
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
   * attach. Every one of them is a storage read, which is what keeps the gate
   * closed across the whole sequence.
   *
   * The gate is D5's premise and is untested here: the fake has no input gate,
   * and the sequence test pins only that nothing else awaits. Task 8's test,
   * which races an append against an upgrade, is what exercises it.
   *
   * What goes out is publicEvent(e), the shape wake() and the poll use, and not
   * the stored event, which carries the sender's user id (spec D1a). The frames
   * are built straight after the read, so that a failure there, like the read's
   * and the attach's, accepts nothing.
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
   * agree about who may watch the open feed, and nothing removes a member from
   * the roster. The list grows with seatings, not with the room's capacity
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
    // `s` through it, and the cut below reads `s.members`. Naming the case here
    // is honest about why, where a non-null assertion would hide that the two
    // guards agree. Change `readsClosed` to a predicate and this collapses.
    if (!s || readsClosed(s, Date.now(), this.#attachedIds())) {
      return new Response("This room is closed", { status: 409 });
    }

    // Then the cut: the roster this request was built against, re-read.
    const cut = new Set<string>(s.members.filter(isRemovedMember).map((m) => m.memberId));
    const memberIds = asked.filter((id) => !cut.has(id));
    if (asked.length > 0 && memberIds.length === 0) {
      return new Response("Forbidden", { status: 403 });
    }

    // The last await, and every one before it is a storage read, so the gate
    // holds from the first recheck to the return. From here nothing yields.
    const missed = await this.events(cursor);
    const frames = missed.map((e) => JSON.stringify(publicEvent(e)));

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
   * has not moved since it joined, because nothing it does calls `bellman_sync`
   * or `bellman_send`, the only two things that touch it (src/server.ts). So it
   * read stale the moment its socket dropped, with its window already spent, and
   * the next contested `bellman_confirm` took its seat.
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
   * One put for every member, not one each: this is a read-modify-write of the
   * whole session blob, and a socket serving several members would otherwise pay
   * it several times. No reArm, for `updateMember`'s reason — `lastSeenAt`
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
      const stamped = connectedAmong(s.members, ids);
      if (stamped.size === 0) return;
      const now = Date.now();
      await this.ctx.storage.put("session", {
        ...s,
        members: stampSeen(s.members, now, stamped),
      });
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
      await txn.put<unknown>({ session: { ...s, joinCodes: rest }, ...rows });
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
      await txn.put<unknown>({ session: { ...s, joinCodes: {} }, ...rows });
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
    role: string, code: string, expiresAt: number,
    guard: { replaceLive: boolean; now: number },
  ): Promise<SetJoinCode> {
    const outcome = await this.ctx.storage.transaction<SetJoinCode>(async (txn) => {
      const s = await this.stored(txn);
      if (!s) return { ok: false, reason: "frozen" };
      if (s.frozenAt !== null) return { ok: false, reason: "frozen" };

      // The `revoke` authority, decided inside the transaction that writes.
      // Deciding it from a record read earlier let two callers holding `invite`
      // alone both see no live code, and the second retire the first's (#90,
      // found in review). Live and not merely present: an expired record shuts
      // no door, so minting over it is opening rather than replacing.
      const existing = s.joinCodes[role];
      const live = existing !== undefined && guard.now <= existing.expiresAt;
      if (live && !guard.replaceLive) return { ok: false, reason: "live_code_exists" };

      const previous = existing?.code;
      const rows = await this.driver.enqueue(txn, [
        ...(previous ? [dropCodeIntent(previous)] : []),
        putCodeIntent(code, s.id),
      ]);
      await txn.put<unknown>({
        session: { ...s, joinCodes: { ...s.joinCodes, [role]: { code, expiresAt } } },
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
   * `nextTickAt` returns null for four reasons — no cadence, the room is closed,
   * the room is frozen, or no active member holds a reporting seat. While it is
   * null nothing is armed for the tick, so there is no firing left to notice the
   * state that made it non-null: the answer cannot correct itself. Adding a member
   * is one such write (this and `seatMember`), and so is clearing `frozenAt`
   * (`freezeSession`). The other direction needs nothing: the armed alarm fires
   * once, finds nobody due, and the reArm() that ends `alarm()` drops the tick.
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
  async addMember(member: Member): Promise<boolean> {
    const added = await this.ctx.storage.transaction(async (txn) => {
      const s = await this.stored(txn);
      if (!s) return false;
      if (s.frozenAt !== null) return false;
      if (s.closed) return false;
      await txn.put("session", { ...s, members: [...s.members, member] });
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
  async seatMember(member: Member, staleBefore: number, now: number): Promise<SeatOutcome> {
    const outcome = await this.ctx.storage.transaction<SeatOutcome>(async (txn) => {
      const no = { reclaimed: [], codesCleared: false };
      const s = await this.stored(txn);
      if (!s) return { refused: "not_found" as const, ...no };
      if (s.closed) return { refused: "closed" as const, ...no };
      if (s.frozenAt !== null) return { refused: "frozen" as const, ...no };

      // The sockets as they are now, read here and not passed in. It is
      // synchronous and inside the transaction, so the decision is made against
      // the sockets that exist while this holds the object. A set fetched by the
      // caller first could not promise that: a member can connect in the gap, and
      // reclaiming it is final.
      const connected = connectedAmong(s.members, this.#attachedIds());
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
      const seated = [...members, member];

      // A full room has no seat for ANY role, so every code goes — in this
      // transaction, not in a second call after it committed (#116). The
      // registry drops ride the same outbox clearJoinCodes uses.
      //
      // "Full" is asked the only way that preserves what bellman_confirm used to
      // compute: whether a FURTHER joiner would be refused. Counting members with
      // a null leftAt is not the same question — a stale seat is occupied but
      // reclaimable, so a room with one still has a door worth leaving open.
      //
      // Cleared by presence, where removeMember retires only a code that is still live
      // (`req.now <= rec.expiresAt`). The two ask different questions. A removal
      // announces a door shutting, so it must not announce one that had already shut,
      // and an expired record is not a door. A seating announces nothing: it tidies
      // rows, and a full room needs no code at all, so an expired record is dropped
      // from the room and from the registry's index with the rest. A room that fills
      // while holding only one therefore reports `codesCleared: true`, which answers
      // this question and does not contradict the other. The contract suite pins this
      // side, and its expired-code cases for removeMember pin the other.
      const full = seatVictims(seated, capacityOf(s.manifest), staleBefore, connected) === null;
      const codes = full ? Object.values(s.joinCodes).map((rec) => rec.code) : [];
      const rows = await this.driver.enqueue(txn, codes.map((code) => dropCodeIntent(code)));

      await txn.put<unknown>({
        session: { ...s, members: seated, joinCodes: full ? {} : s.joinCodes },
        ...rows,
      });
      // What the call did, and not only whether the room filled: a room that fills
      // with no code left in it queued nothing, so there is nothing to deliver.
      return { refused: null, reclaimed, codesCleared: codes.length > 0 };
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
    // not land. It is stripped before the result goes back over RPC.
    const outcome = await this.ctx.storage.transaction<
      RemovalOutcome & { written: SessionEvent[] }
    >(async (txn) => {
      const no = { removed: false, codeRetired: null, written: [] };
      const s = await this.stored(txn);
      if (!s) return { refused: "not_found" as const, ...no };
      if (s.closed) return { refused: "closed" as const, ...no };
      if (req.frozen === "refuse" && s.frozenAt !== null) {
        return { refused: "frozen" as const, ...no };
      }
      if (req.byUserId !== undefined && s.createdBy !== req.byUserId) {
        return { refused: "forbidden" as const, ...no };
      }
      const m = s.members.find((mm) => mm.memberId === memberId);
      if (!m) return { refused: "not_found" as const, ...no };
      // One value for "there is a live door to shut". Nothing prunes an expired
      // record, so a code's presence in joinCodes is not the same as a door
      // being open, and retiring on presence announces a closing that already
      // happened. Decided before the member's state is looked at, because a live
      // door is owed to one who is already out as much as to one who is not.
      const rec = req.retire ? s.joinCodes[req.retire.role] : undefined;
      const retiring = req.retire && rec && req.now <= rec.expiresAt
        ? { role: req.retire.role, code: rec.code, event: req.retire.event, audit: req.retire.audit ?? [] }
        : null;

      // Already out: the idempotent path. The departure is not said again, and
      // queueing nothing for it is the half an idempotency key could not cover. A
      // live door behind them is a different matter: it was never shut, so shutting
      // it is a write that has not happened yet and not a duplicate. With neither
      // owed, nothing is written and nothing is queued.
      const leaving = isActiveMember(m);
      if (!leaving && !retiring) return { refused: null, ...no };

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
      // and go in the same order as the events: the outbox delivers in order.
      const intents = [...(leaving ? req.audit : []), ...(retiring ? retiring.audit : [])]
        .filter((e) => e.orgId)
        .map(auditIntent);
      const codeRows = retiring ? [dropCodeIntent(retiring.code)] : [];
      const rows = await this.driver.enqueue(txn, [...codeRows, ...intents]);

      await txn.put<unknown>({
        session: { ...s, members, joinCodes },
        ...Object.fromEntries(written.map((e) => [eventKey(e.cursor), e])),
        // The cursor row ends at the LAST event written, or the next append takes
        // that event's cursor and overwrites it (#120).
        cursor: written[written.length - 1].cursor,
        ...rows,
      });
      return { refused: null, removed: leaving, codeRetired: retiring?.role ?? null, written };
    });

    const { written, ...result } = outcome;
    // After the commit, never inside the closure: everything awaited in there
    // holds every other call to this object until it commits, and reArm() reads
    // stored(). `written` is empty exactly when nothing was done: a refusal, or a
    // member who was already out behind no live door. A door shut on its own
    // queues rows that want delivering, and moves nothing else.
    for (const e of written) this.#wake(e);
    // After the wake, as appendEvent does it: the member removed is sent the
    // frame announcing it before their socket goes, so the notice is the last
    // thing they receive. Only when this call recorded a cut — the pass reads the
    // roster, which is a storage read no other removal should pay, and a leave
    // cuts nobody so it has no socket to close.
    if (result.removed && req.cut) await this.#closeCutSockets();
    if (written.length > 0) await this.driver.deliverNow();
    // A member leaving can take the last reporting seat with them, so the derived
    // tick may have moved.
    if (result.removed) await this.driver.reArm();
    return result;
  }

  // updateMember, closeSession and freezeSession below still read and then put.
  // Unconverted, not exempt: see stored().
  async updateMember(memberId: string, patch: MemberPatch): Promise<void> {
    const s = await this.stored();
    if (!s) return;
    const members = s.members.map((m) => {
      if (m.memberId !== memberId) return m;
      const next = { ...m };
      if (patch.brief !== undefined) next.brief = patch.brief;
      if (patch.capabilities !== undefined) next.capabilities = patch.capabilities;
      if (patch.leftAt !== undefined) next.leftAt = patch.leftAt;
      if (patch.lastSeenAt !== undefined) next.lastSeenAt = patch.lastSeenAt;
      if (patch.lastReportAt !== undefined) next.lastReportAt = patch.lastReportAt;
      return next;
    });
    await this.ctx.storage.put("session", { ...s, members });
    // addMember's rule, and `leftAt` is the only field in MemberPatch that can
    // flip nextTickAt off null: clearing it returns a departed member to the
    // roster. Nothing calls it that way today — every caller sets a time — but
    // MemberPatch permits it, and the predicate is about what a write CAN do.
    //
    // Deliberately narrow, where the three above are unconditional: this is the
    // hot path. Every bellman_sync and every send stamps `lastSeenAt` through
    // here, and that one reaches nextTickAt not at all.
    //
    // `lastReportAt` DOES reach it, since each member's deadline is its own
    // report plus the cadence — and it still needs no reArm, because a fresh
    // stamp only ever moves that deadline LATER. The armed alarm is then early:
    // it fires, finds nobody due, advances `lastTickAt`, and the closing reArm()
    // points it at the right time. One wake spent, and the tick that comes out of
    // it is correct — the same self-healing path a member leaving takes. Arming
    // here would save that wake and cost a storage read on every sync, which is
    // a trade about cost and not about correctness.
    if (patch.leftAt === null) await this.driver.reArm();
  }

  async closeSession(): Promise<void> {
    const s = await this.stored();
    if (!s) return;
    await this.ctx.storage.put("session", { ...s, closed: true });
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
    return this.ctx.storage.transaction(async (txn) => {
      const s = await this.stored(txn);
      if (!s) return false;
      if (s.closed) return true;
      if (s.members.some(isActiveMember)) return false;
      await txn.put("session", { ...s, closed: true });
      return true;
    });
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
   * The reArm() stays unconditional, and the two are not the same question. It
   * costs one derived read and points the alarm where it already was, and it has to
   * run on the thaw that matters; the credit writes member state, so it needs the
   * transition.
   */
  async freezeSession(frozenAt: number | null): Promise<void> {
    const s = await this.stored();
    if (!s) return;
    const thawing = frozenAt === null && s.frozenAt !== null;
    const now = Date.now();
    const members = thawing ? stampSeen(clearSilence(s, now), now) : s.members;
    await this.ctx.storage.put("session", { ...s, frozenAt, members });
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
   * No `reArm()`, for `updateMember`'s reason: a credit is monotonic, so it only
   * ever moves a member's deadline LATER, and a removal only takes a member off
   * the roster, which cannot bring the soonest one forward either. An alarm
   * already armed is then early — it fires, finds nobody due, advances
   * `lastTickAt`, and the closing `reArm()` points it at the right time. One wake
   * spent, and the tick it produces is correct.
   */
  async appendEvent(
    e: Omit<SessionEvent, "cursor" | "at">,
    extras: AppendExtras = {},
  ): Promise<SessionEvent | null> {
    const event = await this.ctx.storage.transaction<SessionEvent | null>(async (txn) => {
      const s = await this.stored(txn);
      if (!s) throw new Error("Unknown session");
      if (s.frozenAt !== null) return null;
      const next: SessionEvent = { ...e, cursor: await this.nextCursor(txn), at: Date.now() };
      const owed = await extraRows(txn, s, next, extras);
      await this.#writeEvent(txn, next, owed.puts, owed.deletes);
      return next;
    });
    if (event) this.#wake(event);
    // After the wake, so the member removed receives the frame announcing it
    // before the socket goes. The notice is the last thing they get.
    if (event && extras.markRemoved !== undefined) await this.#closeCutSockets();
    return event;
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
   */
  async appendEventOnce(
    e: Omit<SessionEvent, "cursor" | "at">,
    key: string,
    extras: AppendExtras = {},
  ): Promise<EventWrite> {
    const result = await this.ctx.storage.transaction<EventWrite>(async (txn) => {
      const s = await this.stored(txn);
      if (!s) throw new Error("Unknown session");

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
        const owed = await extraRows(txn, s, original, { ...extras, surface: undefined });
        if (Object.keys(owed.puts).length > 0) await txn.put<unknown>(owed.puts);
        return { outcome: "replayed", event: original };
      }

      if (s.frozenAt !== null) return { outcome: "frozen" };

      const event: SessionEvent = { ...e, cursor: await this.nextCursor(txn), at: Date.now() };
      // The key row joins the event and the cursor in one put, for the reason
      // writeEvent gives carried one step further: committed separately, an
      // interruption leaves the event stored with no key naming it, and the
      // retry that follows appends the duplicate this method exists to prevent.
      const stored: IdempotencyRecord = { cursor: event.cursor, print };
      const owed = await extraRows(txn, s, event, extras);
      await this.#writeEvent(txn, event, { [storageKey]: stored, ...owed.puts }, owed.deletes);
      return { outcome: "appended", event };
    });
    if (result.outcome === "appended") this.#wake(result.event);
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
    return result;
  }

  async eventsAfter(cursor: number): Promise<SessionEvent[]> {
    return this.events(cursor);
  }

  async eventAt(cursor: number): Promise<SessionEvent | undefined> {
    return this.ctx.storage.get<SessionEvent>(eventKey(cursor));
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
  #wake(event: SessionEvent): void {
    const woken = this.waiters.filter((w) => event.cursor > w.after);
    this.waiters = this.waiters.filter((w) => event.cursor <= w.after);
    for (const w of woken) w.resolve([event]);

    // Built on the first socket that is due the event and shared by the rest: a
    // poll-only room pays nothing per append, and a projection failure lands in
    // the per-socket try below instead of failing an append whose event is
    // already stored.
    let frame: string | undefined;
    for (const ws of this.ctx.getWebSockets()) {
      // One socket must not starve the rest. getWebSockets() returns a list, and
      // a throw would end this loop with every later socket missing the event,
      // after the waiter arm had run and the event was stored. So each socket is
      // its own try: log, skip, carry on. The cause known today is building the
      // frame, JSON.stringify(publicEvent(event)), which sits inside the try and
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
        frame ??= JSON.stringify(publicEvent(event));
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
      const cut = new Set(s.members.filter(isRemovedMember).map((m) => m.memberId));
      const known = new Set(s.members.map((m) => m.memberId));
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
    } else {
      throw new Error(`outbox: unknown kind ${row.kind}`);
    }
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
   * derivedDue returns next is in the future.
   *
   * **The loop's order is `dueNames`' alphabet, which is not a priority.** A firing
   * delayed past `abandonedAt` finds "abandoned" and "heartbeat" both due and runs
   * the close first, because "a" sorts before "h". That is the right order for this
   * pair, and it is right by accident: before #18 the room's clock had a name that
   * sorted after the tick's, and the tick ran first. Each handler therefore reads
   * the state it needs for itself rather than relying on its place here: #tickIfDue
   * refuses an abandoned room with the same `isAbandoned` test #closeIfAbandoned
   * uses. A rename would undo the order and leave the next pair to be discovered,
   * and the handler that reads its own precondition is the one a reader can check.
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
      if (name === OUTBOX_HANDLER) await this.driver.deliverNow();
      if (name === ABANDONED_HANDLER) {
        const s = await this.stored();
        if (s) await this.#closeIfAbandoned(s, now);
      }
      if (name === HEARTBEAT_HANDLER) await this.#tickIfDue(now);
    }
    await this.driver.reArm();
  }

  /**
   * Due times this object computes rather than stores. A closed session has nothing
   * left to enforce: deriving a time for it would re-arm the alarm to a moment already
   * past, and it would fire again for as long as the session existed. It has no tick
   * to send either, which is why the early return covers both. A frozen room derives
   * neither (both functions answer null for it), and reArm() never clears an alarm,
   * so a freeze leaves the one already armed to fire once, find nothing due and arm
   * nothing after it. The thaw re-arms.
   */
  async #derivedDue(): Promise<Map<string, number>> {
    const s = await this.stored();
    if (!s || s.closed) return new Map();
    const due = new Map<string, number>();
    // Derived rather than a stored `due:` row, deliberately. A name the driver
    // can report with no branch in alarm() is never consumed, and the closing
    // reArm() fires the alarm back to back for good: the rollback hazard this
    // object's alarm() comment records for `due:outbox`. A build that does not
    // know this name does not compute it either, so rolling back strands nothing.
    const abandoned = abandonedAt(s);
    if (abandoned !== null) due.set(ABANDONED_HANDLER, abandoned);
    const tick = nextTickAt(s);
    if (tick !== null) due.set(HEARTBEAT_HANDLER, tick);
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
    // The sockets as they are now, synchronous, so the decision and the write are
    // made against the same set. Nothing but storage is awaited between the read
    // that produced `s` and the put below, so the input gate holds across both.
    const connected = connectedAmong(s.members, this.#attachedIds());
    if (!isAbandoned(s, now, connected)) {
      await this.ctx.storage.put("session", { ...s, members: stampSeen(s.members, now, connected) });
      return;
    }
    // The close clears the session's codes, so their rows leave the registry's index
    // with it, in the same transaction. Otherwise an abandoned room's codes stay there
    // for good. They are already inert, because getSessionByJoinCode refuses a closed
    // session; this is about not leaking rows.
    const intents = Object.values(s.joinCodes).map((rec) => dropCodeIntent(rec.code));
    // The cursor is read in the transaction that writes the event (see nextCursor), and
    // every write is to this object's own storage, so a transaction is enough and no
    // outbox is needed for the event.
    const event = await this.ctx.storage.transaction<SessionEvent>(async (txn) => {
      const rows = await this.driver.enqueue(txn, intents);
      const expired: SessionEvent = {
        cursor: await this.nextCursor(txn),
        type: "session_expired" as EventType,
        fromMemberId: "system",
        fromUserId: "system",
        fromLabel: "bellman",
        payload: { reason: "abandoned", last_seen_at: new Date(due - ABANDONED_AFTER_MS).toISOString() },
        refId: null,
        at: now,
      };
      await this.#writeEvent(txn, expired, {
        session: { ...s, closed: true, joinCodes: {} }, ...rows,
      });
      return expired;
    });
    this.#wake(event);
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
   *   keeps `reclaimStaleSeats` out of a frozen room.
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
   * `#tickIfDue` makes no cross-object call, so the closure stays within
   * ARCHITECTURE.md §9 runtime fact 2: everything awaited in it is this object's
   * storage.
   *
   * `lastTickAt` advances whether or not an event is written, which is what
   * stops the alarm spinning: the clock has to move even on a firing that found
   * nobody due, or `derivedDue` returns the same past time and `reArm()` points
   * the alarm straight back at it.
   */
  async #tickIfDue(now: number): Promise<void> {
    const event = await this.ctx.storage.transaction<SessionEvent | null>(async (txn) => {
      const s = await this.stored(txn);
      if (!s) return null;
      if (s.closed || s.frozenAt !== null) return null;
      if (isAbandoned(s, now, connectedAmong(s.members, this.#attachedIds()))) return null;
      if (s.manifest.heartbeatOnMs === null) return null;

      const due = dueMembers(s, now);
      if (due.length === 0) {
        // Nothing to ask, but the clock still moves. See the comment above.
        await txn.put<unknown>({ session: { ...s, lastTickAt: now } });
        return null;
      }

      const tick: SessionEvent = {
        cursor: await this.nextCursor(txn),
        type: "heartbeat" as EventType,
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
      // clock unmoved, and the next firing writes the same tick again.
      await this.#writeEvent(txn, tick, { session: { ...s, lastTickAt: now } });
      return tick;
    });
    if (event) this.#wake(event);
  }
}

// ---------------------------------------------------------------------------
// RegistryDO — singleton: how you FIND a session
// ---------------------------------------------------------------------------

/** One definition of "expired", so every path agrees on what a grant is. */
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
   * The backstop for the inline delivery. It fires after OUTBOX_GRACE_MS, finds
   * an empty queue and does nothing, unless the inline attempt never ran or is
   * still waiting on an audit object that has stopped answering.
   *
   * The closing reArm() is the safety net SessionDO.alarm has too: a fired alarm is
   * consumed, so whatever is still due must have one scheduled before this returns.
   * The drain re-arms for itself after a failed delivery, so this covers a path
   * that returns without having done so; nothing reaches it today.
   */
  async alarm(): Promise<void> {
    for (const name of await this.driver.dueNow()) {
      if (name === OUTBOX_HANDLER) await this.driver.deliverNow();
    }
    await this.driver.reArm();
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
  ): Promise<"written" | "conflict"> {
    return this.ctx.storage.transaction(async (txn) => {
      const stored = await txn.get<PlanGrant>(grantKey(grant.key));
      // A lapsed grant is not a grant — the same rule getGrant applies. Letting
      // an expired record from another org answer this check would block the
      // key indefinitely, because nothing sweeps it until someone reads it.
      const previous = stored && !lapsed(stored) ? stored : undefined;
      if (previous && previous.orgId !== expectedOrgId) return "conflict" as const;
      // The stale entry to clear is the one actually in storage, expired or not.
      for (const stale of staleIndexKeys(stored, grant)) await txn.delete(stale);
      const rows = await this.driver.enqueue(
        txn, this.#auditIntents(grantAuditEntries(previous, grant, audit, Date.now()))
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
  ): Promise<"written" | "conflict"> {
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
    });
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
    const list = (await this.ctx.storage.get<number[]>(`cr:${userId}`)) ?? [];
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    return list.filter((t) => t >= monthStart).length;
  }

  /**
   * `us:<userId>:<sessionId>` — which rooms a person created.
   *
   * The create counts below cannot answer this: they are timestamps kept for
   * the monthly quota, with no session id in them. Freezing needs the ids.
   *
   * Two variable segments, so the same injectivity question as the grant index
   * applies, and the same answer: neither can contain the separator. A user id
   * is `u_[A-Za-z0-9_-]+` and a session id is `qs_<uuid>`.
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
    const prefix = `us:${userId}:`;
    const map = await this.ctx.storage.list<number>({
      prefix,
      limit,
      ...(startAfter === undefined ? {} : { startAfter: `${prefix}${startAfter}` }),
    });
    return [...map.keys()].map((k) => k.slice(prefix.length));
  }

  /**
   * Forget that this person created this room. Called by the sweep above as it
   * meets a closed room, so a dead row is paid for once rather than on every
   * listing for the life of the account — the index was never pruned at all
   * before (#75, #115).
   *
   * Only the `us:` half. `um:` is history and keeps its rows deliberately: its
   * contract is rooms a person HELD a handle in, closed ones included.
   */
  async dropCreatedIndex(userId: string, sessionId: string): Promise<void> {
    await this.ctx.storage.delete(`us:${userId}:${sessionId}`);
  }

  /**
   * `um:<userId>:<sessionId>` — which rooms a person holds a handle in.
   *
   * The same shape as `us:` above, and the same injectivity argument: two
   * variable segments, and neither can contain the separator. A user id is
   * `u_[A-Za-z0-9_-]+` and a session id is `qs_<uuid>`.
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
    const prefix = `um:${userId}:`;
    const map = await this.ctx.storage.list<number>({ prefix, limit });
    return [...map.keys()].map((k) => k.slice(prefix.length));
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
  /**
   * Append an audit entry, at most once per intent.
   *
   * The outbox that feeds this delivers at least once — a row is deleted only
   * after this call returns, so an acknowledgement lost in flight redelivers.
   * The `d:` row is what makes that safe. Callers with no intent to redeliver
   * pass no id and always append.
   */
  async append(entry: AuditEntry, intentId?: string): Promise<void> {
    // The look at the marker and the write that sets it are one transaction, so a
    // second delivery of the same intent cannot get between them, even if a later
    // edit puts an await there that opens the input gate (a timer, a call to
    // another object). Bare, that edit lets both deliveries find no marker, and
    // both append.
    await this.ctx.storage.transaction(async (txn) => {
      if (intentId !== undefined && (await txn.get(deliveredKey(intentId)))) return;
      const seq = ((await txn.get<number>("seq")) ?? 0) + 1;
      // Entry, sequence and delivery marker in one write, in this transaction.
      // Committed apart (in another transaction, or by a write after this one
      // closes), an interruption between the commits leaves one without the
      // others: an entry with no sequence is overwritten by the next entry; a
      // marker with no entry makes the redelivery skip an entry that never
      // landed; an entry with no marker is appended again by the redelivery. An
      // audit log that can quietly drop or double the record of a privilege
      // change is not an audit log.
      await txn.put<unknown>({
        [auditKey(seq)]: entry,
        seq,
        ...(intentId !== undefined ? { [deliveredKey(intentId)]: seq } : {}),
      });
    });
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

  async createSession(s: Session): Promise<void> {
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
    // person's joined listing.
    for (const m of s.members) {
      await this.writeIndex("um", m.userId, s.id, () =>
        this.registry.indexMembership(m.userId, s.id));
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
    if (Date.now() > rec.expiresAt) return undefined;
    return { session, role };
  }

  async consumeJoinCode(sessionId: string, role: string): Promise<void> {
    await this.session(sessionId).consumeJoinCode(role);
  }

  async clearJoinCodes(sessionId: string): Promise<void> {
    await this.session(sessionId).clearJoinCodes();
  }

  async setJoinCode(
    sessionId: string, role: string, code: string, expiresAt: number,
    guard: { replaceLive: boolean; now: number },
  ): Promise<SetJoinCode> {
    return this.session(sessionId).setJoinCode(role, code, expiresAt, guard);
  }

  async addMember(sessionId: string, member: Member): Promise<boolean> {
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
    }
    return added;
  }

  async seatMember(
    sessionId: string,
    member: Member,
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

  async connectedMembers(sessionId: string): Promise<ReadonlySet<string>> {
    return new Set(await this.session(sessionId).connectedMembers());
  }

  async updateMember(sessionId: string, memberId: string, patch: MemberPatch): Promise<void> {
    await this.session(sessionId).updateMember(memberId, patch);
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

  async eventsAfter(sessionId: string, cursor: number): Promise<SessionEvent[]> {
    return this.session(sessionId).eventsAfter(cursor);
  }

  async eventAt(sessionId: string, cursor: number): Promise<SessionEvent | undefined> {
    return this.session(sessionId).eventAt(cursor);
  }

  async surfaceOf(sessionId: string): Promise<SurfaceRow[]> {
    return this.session(sessionId).surfaceOf();
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
  ): Promise<"written" | "conflict"> {
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

  async appendAudit(a: AuditEntry): Promise<void> {
    if (a.orgId === null) return; // no org, no audit stream to write to
    await this.audit(a.orgId).append(a);
  }

  async auditForOrg(orgId: string, limit: number): Promise<AuditEntry[]> {
    return this.audit(orgId).recent(limit);
  }

  /**
   * No-op by design. MemoryStore sweeps on a timer because it can iterate every
   * session cheaply; a DO namespace cannot. Abandonment is enforced by the
   * per-object alarm set in SessionDO.createSession, and connect tokens are
   * checked for expiry when taken. Nothing is left for a sweep to do.
   */
  async sweep(_now: number): Promise<void> {}
}
