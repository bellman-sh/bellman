/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from "cloudflare:workers";
import { allKeysFor, grantKey, orgIndexKey, orgIndexPrefix, staleIndexKeys } from "./grant-index.js";
import type { GrantDelete, GrantWrite } from "./store.js";
import type {
  AuditEntry, EventType, Member, PendingConnect, PlanGrant, Session, SessionEvent,
} from "./types.js";
import type { BellmanStore, EventWrite, MemberPatch, SeatOutcome } from "./store.js";
import { isActiveMember, seatVictims } from "./store.js";
import { fingerprint, idempotencyKey, type IdempotencyRecord } from "./idempotency.js";
import { hydrateStoredSession, type StoredSession } from "./stored-session.js";
import { publicEvent } from "./public-event.js";
import { grantAuditEntries, revokeAuditEntries, type AuditIntent } from "./grant-audit.js";
import { OUTBOX_HANDLER, OutboxDriver, type OutboxIntent, type OutboxRow } from "./outbox.js";
import { clearSilence, dueMembers, nextTickAt, snapshotOf } from "./heartbeat.js";

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
 * global iteration across a DO namespace, so session TTL is enforced by a
 * per-object alarm and connect tokens expire lazily on read. sweep() is
 * therefore a no-op — see the comment on the method.
 */

const CURSOR_PAD = 12;
const eventKey = (cursor: number) => `e:${String(cursor).padStart(CURSOR_PAD, "0")}`;
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

type Waiter = { after: number; resolve: (events: SessionEvent[]) => void };

/**
 * What a hibernating socket remembers. The runtime rejects more than 16 KB;
 * fetch says how close this can get.
 *
 * Nothing reads `memberIds` today. wake() reads only `cursor` and carries the
 * rest along unchanged, and every member of a room receives every event (spec
 * D1a), so delivery does not depend on whose socket it is. It is kept for what
 * has to find a socket by member, the use in view being to close the sockets of
 * a member who has left. Nothing does that yet.
 *
 * Whatever reads it first can trust it, because of where it comes from:
 * membersOf answered it, and fetch received it in a request the Worker built
 * (see the /ws route in worker.ts), never in a header the client sent. A
 * forged x-bellman-members reaches nothing. tests/worker-ws.test.ts pins that
 * the Worker never forwards a caller's request; it guards the day this field is
 * read, not a path that is exploitable now. If the field is removed, that test
 * can go with it; until then, keep both.
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
   * "ttl" expires the session. It is DERIVED from the session record rather than
   * stored as a `due:` row, because sessions written before named alarms have no row
   * and an alarm re-armed from stored rows alone would leave every one of them with
   * no expiry. See derivedDue().
   *
   * "heartbeat" asks the room's members where they are, when the room declared a
   * cadence and one of them owes an answer (#111). Derived like "ttl", and for a
   * firmer reason: a stored row that an older build never consumes is the spin
   * alarm() warns about. See derivedDue() and #tickIfDue().
   */
  private driver = new OutboxDriver(
    this.ctx.storage,
    (row) => this.#deliver(row),
    () => this.derivedDue()
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
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /**
   * The one raw read of the "session" record. Everything in this class reads it
   * through here, so hydrateStoredSession's rules reach all of it: getSession
   * (and the facade's getSession and getSessionByJoinCode with it), every
   * mutator, and the TTL alarm. A row predating Session.manifest reads as gone;
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
   */
  private async stored(
    from: { get<T>(key: string): Promise<T | undefined> } = this.ctx.storage
  ): Promise<StoredSession | undefined> {
    return hydrateStoredSession(await from.get("session"));
  }

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
   * read and this write are one unit.
   *
   * `#private`, because it writes the event and any extra rows its caller supplies, and a
   * Durable Object answers RPC for every method on its class: TypeScript's `private` is
   * erased at compile time.
   */
  async #writeEvent(
    txn: DurableObjectTransaction,
    e: SessionEvent,
    extra: Record<string, unknown> = {}
  ): Promise<void> {
    await txn.put<unknown>({
      [eventKey(e.cursor)]: e, cursor: e.cursor, ...extra,
    });
  }

  async createSession(s: Session): Promise<void> {
    const { events, ...rest } = s;
    // Session, seed events, cursor and the registrations its join codes owe land
    // together. Separately committed, an interruption could leave a session with no
    // events, or events with a cursor of zero, or a session whose code nothing can
    // resolve — and the alarm is what expires it, so a session that half-exists
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
      // enqueue armed the alarm for the queue, inside the transaction. The TTL is
      // armed when that alarm fires, because alarm() ends by pointing the alarm at
      // whatever is due next. A reArm() here would point it at the queue's marker
      // instead, which is dated now, and bring the alarm in a few milliseconds
      // behind the commit to race the delivery below.
      await this.driver.deliverNow();
    } else {
      // Nothing was queued, so nothing armed an alarm, and the session still needs
      // its TTL. It is DERIVED from the session record rather than stored as a due
      // row: sessions written before named alarms have no due row, and re-arming
      // from stored rows alone would leave every one of them with no alarm and no
      // expiry.
      await this.driver.reArm();
    }
  }

  async getSession(): Promise<StoredSession | undefined> {
    const s = await this.stored();
    if (!s) return undefined;
    await this.#expireIfDue(s, Date.now());
    // Re-read: expireIfDue may have written closed=true and cleared the codes.
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
   * Two reasons the route asks here rather than calling getSession. This
   * returns two fields, not the whole record (live join codes and every
   * member's brief) across an RPC hop. And it does not expire the room as a
   * side effect: getSession runs expireIfDue, which can write, and authorizing
   * a watch must not.
   *
   * The second reason carries an obligation. The two paths must still agree
   * on "closed", or a room past its TTL whose alarm has not fired yet reads
   * as open here while bellman_sync, through getSession, reads it as closed.
   * So `closed` is computed by expireIfDue's own rule (now past expiresAt)
   * and not written. Change that rule in one place and it must change in both.
   */
  async membersOf(userId: string): Promise<{ memberIds: string[]; closed: boolean }> {
    const s = await this.stored();
    if (!s) return { memberIds: [], closed: true };
    return {
      memberIds: s.members.filter((m) => m.userId === userId).map((m) => m.memberId),
      closed: s.closed || Date.now() > s.expiresAt,
    };
  }

  /**
   * Accept a watching socket. The Worker has already authenticated the caller
   * and asked membersOf who they are; this request is one the Worker BUILT,
   * so nothing on it came from the client (see the /ws route in worker.ts).
   *
   * Read, attach, accept and send happen in this one invocation, and, its
   * only await being a storage read, the input gate holds every other request
   * to this object for its duration. That is CLAUDE.md's read-and-register
   * rule, not an exemption from it: an event appended between the read and
   * the accept would otherwise be delivered to nobody and skipped by the
   * cursor. So the order is waitForEvents' own: await the read FIRST, then
   * register with no await between.
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
   * owns in this room, departed members included: membersOf returns them on
   * purpose, so /ws and bellman_sync agree about who may watch, and nothing
   * removes a member. The list grows with seatings, not with the plan's cap on
   * active members (ENTITLEMENTS in auth.ts), so it takes over a thousand
   * seatings by one identity in one room's life. That is churn, not a breach
   * of the cap.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const url = new URL(request.url);
    const cursor = Number(url.searchParams.get("cursor"));
    const memberIds = (request.headers.get("x-bellman-members") ?? "")
      .split(",").filter(Boolean);

    // The only await. From here to the return nothing yields.
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
    ws.close(1000, "closing");
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
  async setJoinCode(role: string, code: string, expiresAt: number): Promise<boolean> {
    const set = await this.ctx.storage.transaction(async (txn) => {
      const s = await this.stored(txn);
      if (!s) return false;
      if (s.frozenAt !== null) return false;
      const previous = s.joinCodes[role]?.code;
      const rows = await this.driver.enqueue(txn, [
        ...(previous ? [dropCodeIntent(previous)] : []),
        putCodeIntent(code, s.id),
      ]);
      await txn.put<unknown>({
        session: { ...s, joinCodes: { ...s.joinCodes, [role]: { code, expiresAt } } },
        ...rows,
      });
      return true;
    });
    if (set) await this.driver.deliverNow();
    return set;
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
   * `createSession` deliberately skips reArm() when it queued outbox intents,
   * because `enqueue` arms for the queue's marker — dated now — and a reArm()
   * would bring the alarm in behind the commit to race the inline delivery. That
   * guard is about a method's OWN enqueue and does not transfer: this one queues
   * nothing, so the only due times reArm() can see are the TTL, the tick, and an
   * outbox marker some earlier call left behind — and a marker still present means
   * a delivery genuinely is owed, so arming for it is recovery rather than a race.
   * `bellman_confirm`'s `clearJoinCodes`, which runs after this, arms the alarm
   * itself inside its own transaction and so overwrites whatever this set.
   */
  async seatMember(member: Member, staleBefore: number, now: number): Promise<SeatOutcome> {
    const outcome = await this.ctx.storage.transaction<SeatOutcome>(async (txn) => {
      const s = await this.stored(txn);
      if (!s) return { refused: "not_found", reclaimed: [] };
      if (s.closed) return { refused: "closed", reclaimed: [] };
      if (s.frozenAt !== null) return { refused: "frozen", reclaimed: [] };

      const victims = seatVictims(s.members, s.maxMembers, staleBefore);
      if (victims === null) return { refused: "full", reclaimed: [] };

      const departed = new Set(victims.map((v) => v.memberId));
      const reclaimed: Member[] = [];
      const members = s.members.map((m) => {
        if (!departed.has(m.memberId)) return m;
        const next = { ...m, leftAt: now };
        reclaimed.push(next);
        return next;
      });
      await txn.put("session", { ...s, members: [...members, member] });
      return { refused: null, reclaimed };
    });
    if (outcome.refused === null) await this.driver.reArm();
    return outcome;
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
   * It earns its place on the freeze too, and is unconditional for that reason. A
   * freeze does not disarm anything — the alarm stays pointed at the tick time it
   * already held — so without this, a frozen room wakes once at that time to be
   * refused by #tickIfDue, and only then re-arms to the TTL. Re-arming here moves
   * it out to the TTL at the freeze and spends that wake on nothing.
   *
   * The thaw also credits every reporting seat with a report, so the interval
   * nobody was allowed to report in costs nobody their standing — spec D10, and
   * `clearSilence` carries the whole argument. The rule belongs to heartbeat.ts;
   * this picks the moment to apply it.
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
    const members = thawing ? clearSilence(s, Date.now()) : s.members;
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
   */
  async appendEvent(e: Omit<SessionEvent, "cursor" | "at">): Promise<SessionEvent | null> {
    const event = await this.ctx.storage.transaction<SessionEvent | null>(async (txn) => {
      const s = await this.stored(txn);
      if (!s) throw new Error("Unknown session");
      if (s.frozenAt !== null) return null;
      const next: SessionEvent = { ...e, cursor: await this.nextCursor(txn), at: Date.now() };
      await this.#writeEvent(txn, next);
      return next;
    });
    if (event) this.#wake(event);
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
    key: string
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
        return { outcome: "replayed", event: original };
      }

      if (s.frozenAt !== null) return { outcome: "frozen" };

      const event: SessionEvent = { ...e, cursor: await this.nextCursor(txn), at: Date.now() };
      // The key row joins the event and the cursor in one put, for the reason
      // writeEvent gives carried one step further: committed separately, an
      // interruption leaves the event stored with no key naming it, and the
      // retry that follows appends the duplicate this method exists to prevent.
      const stored: IdempotencyRecord = { cursor: event.cursor, print };
      await this.#writeEvent(txn, event, { [storageKey]: stored });
      return { outcome: "appended", event };
    });
    if (result.outcome === "appended") this.#wake(result.event);
    return result;
  }

  async eventsAfter(cursor: number): Promise<SessionEvent[]> {
    return this.events(cursor);
  }

  async eventAt(cursor: number): Promise<SessionEvent | undefined> {
    return this.ctx.storage.get<SessionEvent>(eventKey(cursor));
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
        if (ws.readyState === WS_CLOSING || ws.readyState === WS_CLOSED) continue;
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
   * One queued registry write, delivered to the registry's index.
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
    } else {
      throw new Error(`outbox: unknown kind ${row.kind}`);
    }
  }

  /**
   * The object's single alarm, shared by name: the driver reports which handlers
   * are due and this dispatches on them. The outbox drains here when the inline
   * attempt never ran or could not finish, and the session TTL fires here rather
   * than in a global sweep.
   *
   * Nothing here clears a handler's due time. Each decides its next one from state
   * it has already changed, so a handler that throws keeps its due time and the
   * alarm is retried instead of forgotten. The outbox's drain moves its own marker,
   * deleting it when the queue is empty and dating it ahead after a failure. The
   * TTL's handler is idempotent: expireIfDue does nothing to a session that is
   * closed or not yet past its expiry. The heartbeat's moves its own clock:
   * #tickIfDue advances `lastTickAt` on every firing, written or not, so the time
   * derivedDue returns next is in the future.
   *
   * **The loop's order is `dueNames`' alphabet, which is not a priority.** A firing
   * delayed past `expiresAt` finds "heartbeat" and "ttl" both due and runs the tick
   * first, because "h" sorts before "t". Each handler therefore reads the state it
   * needs for itself rather than relying on its place here: #tickIfDue refuses a
   * room already past its expiry, with the same `now > expiresAt` test #expireIfDue
   * uses. Reordering the names would fix this one pair and leave the next one to be
   * discovered, and the handler that reads its own precondition is the one a reader
   * can check.
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
   * The closing reArm() is what keeps the TTL alive when this ran for another
   * reason. A fired alarm is consumed, so without it a live session would be left
   * with none.
   *
   * It is also what covers the boundary, so the TTL needs no re-arm of its own.
   * expireIfDue acts only once now is past expiresAt and the driver counts a handler
   * due AT its time, so a firing exactly on expiresAt finds the TTL due, expires
   * nothing, and reArm() points the alarm at expiresAt again, due at once. The first
   * firing to read now > expiresAt closes the room, and a closed room derives no TTL,
   * so that firing arms nothing. The re-arm is not strictly after the boundary: a
   * firing can land in the same millisecond and go round once more, and the clock is
   * what ends it. A socket-watched room is not polled, so no getSession is there to
   * expire it lazily; this is the only thing that does.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    for (const name of await this.driver.dueNow(now)) {
      if (name === OUTBOX_HANDLER) await this.driver.deliverNow();
      if (name === "ttl") {
        const s = await this.stored();
        if (s) await this.#expireIfDue(s, now);
      }
      if (name === HEARTBEAT_HANDLER) await this.#tickIfDue(now);
    }
    await this.driver.reArm();
  }

  /**
   * Due times this object computes rather than stores. A closed session has no TTL
   * left to enforce: deriving one for it would re-arm the alarm to a time already
   * past, and it would fire again for as long as the session existed. It has no
   * tick to send either, which is why the early return covers both.
   */
  private async derivedDue(): Promise<Map<string, number>> {
    const s = await this.stored();
    if (!s || s.closed) return new Map();
    const due = new Map([["ttl", s.expiresAt]]);
    // Derived rather than a stored `due:` row, deliberately. A name the driver
    // can report with no branch below is never consumed, and the closing reArm()
    // fires the alarm back to back for good — the rollback hazard this object's
    // alarm() comment records for `due:outbox`. A build that does not know this
    // name does not compute it either, so rolling back strands nothing.
    const tick = nextTickAt(s);
    if (tick !== null) due.set(HEARTBEAT_HANDLER, tick);
    return due;
  }

  /**
   * `#private`, because it overwrites the session with the record it is handed and queues
   * the registry's removal of every code in it. A Durable Object answers RPC for every
   * method on its class, so a TypeScript `private` one would let anything holding the
   * SESSION binding rewrite a room and reach into the registry's index.
   */
  async #expireIfDue(s: StoredSession, now: number): Promise<void> {
    // membersOf is the other half of this rule: it answers "closed" the same way, without writing.
    if (s.closed || now <= s.expiresAt) return;
    // The write below clears the session's codes, so their rows leave the registry's
    // index with it, in the same transaction. Otherwise an expired room's codes stay
    // there for good. They are already inert, because getSessionByJoinCode refuses a
    // closed session; this is about not leaking rows.
    const intents = Object.values(s.joinCodes).map((rec) => dropCodeIntent(rec.code));
    await this.ctx.storage.transaction(async (txn) => {
      const rows = await this.driver.enqueue(txn, intents);
      await txn.put<unknown>({ session: { ...s, closed: true, joinCodes: {} }, ...rows });
    });
    // The expiry event takes its cursor in a transaction of its own, like any append (see
    // nextCursor). It stays apart from the close above, as it was: folding the two would
    // change what an interruption between them leaves, which is not this change's to decide.
    const event = await this.ctx.storage.transaction<SessionEvent>(async (txn) => {
      const expired: SessionEvent = {
        cursor: await this.nextCursor(txn),
        type: "session_expired" as EventType,
        fromMemberId: "system",
        fromUserId: "system",
        fromLabel: "bellman",
        payload: { reason: "ttl" },
        refId: null,
        at: now,
      };
      await this.#writeEvent(txn, expired);
      return expired;
    });
    this.#wake(event);
    // Last, so a poll woken above does not wait on the registry. Reached from the
    // alarm and from any read that finds the session lapsed, and both drain here
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
   * through `#writeEvent`, as `#expireIfDue` does, which means it does NOT
   * inherit `appendEvent`'s frozen check. Without them:
   *
   * - A **frozen** room gets ticks naming members silent who cannot report out
   *   of it, and a freeze must cost nobody their standing — the same rule that
   *   keeps `reclaimStaleSeats` out of a frozen room.
   * - A **closed** room gets a tick nobody can answer, because every send into
   *   it is refused.
   * - A room **past its TTL** gets the same, and it is reachable where the other
   *   two are not. `dueNames` sorts the due handlers, "heartbeat" sorts before
   *   "ttl", and a firing delayed past `expiresAt` finds both due — so the tick
   *   ran, appended and woke every watcher on a room the very next iteration of
   *   that loop was about to close. `now > s.expiresAt` is `#expireIfDue`'s own
   *   test for lapsed, read here rather than reordering the handlers: a guard is
   *   checkable where a name's place in an alphabet is an accident.
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
      if (s.closed || s.frozenAt !== null || now > s.expiresAt) return null;
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
    return entries.map((entry) => ({ id: crypto.randomUUID(), kind: "audit", payload: entry }));
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
   * closes by itself as those sessions reach their TTL and expire. Until then
   * a lapse will not freeze them, which means a room outliving its plan rather
   * than a room lost.
   *
   * **Sessions created after this deploy can be missing too.**
   * `DurableObjectStore` puts this row once the room has committed, and logs a
   * failed put rather than throwing it (`writeIndex`), deliberately: a throw
   * would report a failed create for a room that already exists. Nothing
   * rebuilds the row, so the outcome is the one above: a lapse cannot freeze a
   * room it cannot find, and the room keeps working on a plan that no longer
   * pays for it. The gap above only shrinks, as those rooms expire; this one
   * also grows whenever a put fails. A creator's `um:` row is a separate put, so
   * either row can land without the other, and a room can be listed for its
   * creator and still be out of a lapse's reach.
   */
  async indexSession(userId: string, sessionId: string): Promise<void> {
    await this.ctx.storage.put(`us:${userId}:${sessionId}`, Date.now());
  }

  async sessionsCreatedBy(userId: string, limit: number): Promise<string[]> {
    const prefix = `us:${userId}:`;
    const map = await this.ctx.storage.list<number>({ prefix, limit });
    return [...map.keys()].map((k) => k.slice(prefix.length));
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
   * fills itself in as sessions reach their TTL. Older rooms have no list to
   * enumerate (see `us:`), so for them expiry is the only repair. Until then a
   * joined room is missing from one screen, which is not a room lost.
   *
   * **Members who joined after this deploy can be missing too, creators
   * included.** `DurableObjectStore` puts this row once the seat has committed,
   * and logs a failed put rather than throwing it (`writeIndex`), deliberately:
   * a throw would report a failed join for a seat that had already landed.
   * Nothing rebuilds the row. The gap above only shrinks, as those rooms expire;
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

  private session(id: string) {
    return this.env.SESSION.get(this.env.SESSION.idFromName(id));
  }

  private get registry() {
    return this.env.REGISTRY.get(this.env.REGISTRY.idFromName("registry"));
  }

  private audit(orgId: string) {
    return this.env.AUDIT.get(this.env.AUDIT.idFromName(orgId));
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
    sessionId: string, role: string, code: string, expiresAt: number
  ): Promise<boolean> {
    return this.session(sessionId).setJoinCode(role, code, expiresAt);
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

  async sessionsCreatedBy(userId: string, limit: number): Promise<string[]> {
    return this.registry.sessionsCreatedBy(userId, limit);
  }

  async sessionsJoinedBy(userId: string, limit: number): Promise<string[]> {
    return this.registry.sessionsJoinedBy(userId, limit);
  }

  async appendEvent(
    sessionId: string,
    e: Omit<SessionEvent, "cursor" | "at">
  ): Promise<SessionEvent | null> {
    return this.session(sessionId).appendEvent(e);
  }

  async appendEventOnce(
    sessionId: string,
    e: Omit<SessionEvent, "cursor" | "at">,
    key: string
  ): Promise<EventWrite> {
    return this.session(sessionId).appendEventOnce(e, key);
  }

  async eventsAfter(sessionId: string, cursor: number): Promise<SessionEvent[]> {
    return this.session(sessionId).eventsAfter(cursor);
  }

  async eventAt(sessionId: string, cursor: number): Promise<SessionEvent | undefined> {
    return this.session(sessionId).eventAt(cursor);
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
   * session cheaply; a DO namespace cannot. Session TTL is enforced by the
   * per-object alarm set in SessionDO.createSession, and connect tokens are
   * checked for expiry when taken. Nothing is left for a sweep to do.
   */
  async sweep(_now: number): Promise<void> {}
}
