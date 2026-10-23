/**
 * Room operations, and the seam under them.
 *
 * Each operation here does the whole thing: resolve the room, authorize the
 * caller, mutate, append the event, write the audit row. That is the point.
 * `src/server.ts` used to hold the sequence inline in every tool handler, and
 * #49 wants an HTTP API over the same rooms — a second transport re-typing the
 * sequence would be a second chance to skip the audit row or the frozen guard,
 * on exactly the paths where skipping one matters.
 *
 * So a transport's job is narrowed to translation: call an operation, map its
 * result. MCP maps it to a ToolResult, a route maps it to a status code.
 *
 * This module must stay importable by the Node build: no `cloudflare:workers`,
 * directly or transitively.
 */
import { SEND_KINDS, type AuditEntry, type Identity, type Member, type RoomManifest, type SessionEvent, type Verb } from "./types.js";
import type { StoredSession } from "./stored-session.js";
import { publicRoomUrl, renderJoinCode } from "./codes.js";
import type { BanScope } from "./bans.js";
import { MAX_REPORT_NOTE_CHARS, REPORTS_PER_DAY, REPORT_REASONS, type NewReport, type ReportMailer, type ReportTarget } from "./reports.js";
import { claimName } from "./public-names.js";
import { denyVerb } from "./roles.js";
import { sendKeyFor, sendLimitFor } from "./send-limit.js";
import {
  JOINED_SCAN, JOIN_CODE_TTL, ROOM_MEMBER_CEILING, capacityOf, codeIsLive, isActiveMember, isActivePerson, isPublic, isRemovedMember,
  type AppendExtras, type BellmanStore, type EventBody, type RemovalRequest,
} from "./store.js";
import { NO_SOCKETS, STALE_AFTER_MS, lastSeen, presentMembers } from "./presence.js";
import { surfaceItem } from "./projections.js";
import { briefAuthors, publicReadEvent, readableEvent, readableEvents } from "./public-event.js";
import { MAX_SURFACE_ITEMS, normalizeSurfaceWrite, surfaceCursor } from "./surface.js";
import { IMAGE_TYPES, isImageType, normalizeMediaType, type BlobStore } from "./blobs.js";
import { auditRows, partiesOf } from "./audit.js";

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Why an operation refused, in a form a transport can switch on.
 *
 * A route picks 403 from `"forbidden"` rather than pattern-matching English,
 * and a route that forgets a case fails to compile rather than returning 500.
 *
 * `"invalid"` is the caller's mistake in a room that was found: the request
 * named something the room does not have. It is not `"not_found"`, which is the
 * room itself or a member of it, and a route answers 400 from the one and 404
 * from the other.
 *
 * `"rate_limited"` is a send past its member's minute (ADR 0022), or a report past its account's day. It is
 * the one refusal that carries a number, `retryAfter`, and a route answers it 429.
 */
export type RoomFailure = "not_found" | "closed" | "frozen" | "forbidden" | "conflict" | "invalid" | "rate_limited";

/**
 * Not a throw, because these are ordinary outcomes — a closed room is not
 * exceptional. Not a ToolResult, because that shape is MCP's and a route has
 * no use for a `content` array.
 *
 * `retryAfter` is whole seconds, and only a `rate_limited` refusal has one.
 */
export type RoomResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: RoomFailure; reason: string; retryAfter?: number };

export const succeed = <T>(value: T): RoomResult<T> => ({ ok: true, value });

/** `RoomResult<never>` so a refusal is assignable to any operation's result. */
export const refuse = (code: RoomFailure, reason: string, extra?: { retryAfter: number }): RoomResult<never> =>
  ({ ok: false, code, reason, ...extra });

// ---------------------------------------------------------------------------
// Room primitives
// ---------------------------------------------------------------------------

/**
 * Refused while frozen, allowed while frozen: writes stop, reads do not.
 *
 * Freezing is what a lapsed plan does to a room, and it has to be reversible
 * without costing anyone their work — so membership, history and sync all keep
 * working, and only sending, joining and inviting are refused.
 */
export const FROZEN =
  "this session is frozen: the plan behind it has lapsed, or its creator's access was removed. Everyone stays a " +
  "member and the history is still readable, but nothing new can be sent or joined until it is restored; the org's " +
  "admin can say which.";

/** A permanent code refused to a room that is not public (ADR 0020), by `issueInvite`'s check or the store's. */
const NOT_PUBLIC =
  "this room is not public, so it cannot hold a permanent code: a link that never expires belongs only to a room " +
  "anyone can already read. Omit permanent for a code that expires in 15 minutes.";

export function activeMembers(s: StoredSession): Member[] {
  return s.members.filter(isActiveMember);
}

/**
 * Members whose seat a capacity check should count: present, not merely
 * undeparted. See src/presence.ts for why this is a second reading of the
 * roster rather than a change to `activeMembers`.
 *
 * `connected` is `BellmanStore.connectedMembers`, and a caller that is deciding
 * whether a room is full has to pass it. Without it a member on a socket that
 * has been quiet for ten minutes does not count, and the room reads as having
 * room that `seatMember` will then refuse to give.
 */
export function seatedMembers(
  s: StoredSession,
  now: number = Date.now(),
  connected: ReadonlySet<string> = NO_SOCKETS,
): Member[] {
  return presentMembers(s.members, now, connected);
}

/**
 * Why a seat is refused, said for the room's shape. A pair room is two by its
 * preset; a swarm room is at the ceiling, which is storage and the same on every
 * plan, so the message says so rather than pointing at an upgrade that would not
 * help. Every variant keeps the word "full": clients and tests match on it.
 */
export function fullMessage(manifest: RoomManifest): string {
  return manifest.mode === "pair"
    ? "session is full (2 members — a pair room holds two). Wait for someone to leave, or start a swarm session."
    : `session is full: this room holds ${ROOM_MEMBER_CEILING} members, Bellman's ceiling for one room, the same on every plan. Wait for someone to leave, or start another room.`;
}

/**
 * Record that this member is alive, from a call it was making anyway.
 *
 * Fire-and-forget on purpose: it is a side effect of somebody else's
 * operation, and a `bellman_sync` that returned the peer's message must not
 * fail because the liveness write did. The cost of losing one is that the
 * member looks quiet for another 25 seconds, which the window absorbs many
 * times over.
 *
 * Takes the member, not a `memberId`, so the guards can be read off it. Callers
 * pass what `findMember` resolved, which is already restricted to a handle the
 * caller's identity owns — so this cannot be used to make somebody else look
 * alive.
 *
 * Written at most once every half-window. In the Durable Objects store an
 * `updateMember` reads the room, its present members included, and writes the
 * member's row (ADR 0019), so a write on each 25-second poll would cost more
 * than the per-beat event row this design rejects as the wrong home for
 * liveness. Half the window keeps `lastSeenAt` at
 * worst five minutes behind inside a ten-minute window, which is never the
 * difference between present and stale, at a twelfth of the writes.
 *
 * Refused for a closed room, a frozen one, and a member who has left, because
 * `bellman_sync` has none of those guards on purpose: reads stay open to all
 * three. Without them a reaped member's watcher would rewrite a closed room's
 * record every 25 seconds for as long as it ran.
 */
export async function touchMember(
  store: BellmanStore,
  session: StoredSession,
  me: Member,
  now: number = Date.now(),
): Promise<void> {
  if (session.closed || session.frozenAt !== null) return;
  if (!isActiveMember(me)) return;
  if (now - lastSeen(me) < STALE_AFTER_MS / 2) return;
  try {
    await store.updateMember(session.id, me.memberId, { lastSeenAt: now });
  } catch {
    // Deliberately swallowed. See above.
  }
}

/**
 * Turn stale seats into departed ones, so a room whose members' sessions died
 * can be joined again.
 *
 * Say that these seats timed out: the event each reaped member's peers read,
 * and the audit row their org reads.
 *
 * Announcement only. The decision and the write are `BellmanStore.seatMember`'s,
 * because they cannot be two operations — a handler that chose a victim, then
 * re-read, then wrote hands two concurrent confirms a window to agree on the
 * same seat, and lets a `bellman_sync` make a member live again after it was
 * already condemned. So this is called with what the store *did*, and nobody is
 * told a member timed out unless that member's seat really was taken.
 *
 * It follows from that, and is the answer to "held for them, or taken": held,
 * until somebody actually needs it. `seatVictims` reclaims nothing while the
 * room has a seat going spare, however long a member has been quiet, and frees
 * one seat rather than every stale one — the blast radius is the size of the
 * request, and the next joiner reclaims the next seat. An earlier shape reaped
 * every stale seat from three different call sites, one of which was a preview
 * any holder of a join code could repeat for fifteen minutes; between them that
 * was a way to empty a quiet 25-seat hub room of every member, creator
 * included. `evictMember` is creator-only and deliberately outside the verb
 * set, and a second removal path must not be looser than the first.
 *
 * The removal is final. A reclaimed member reads on and must redeem a fresh code
 * to write again. An evicted one is in the same position for writing and no
 * further: a creator's removal also cuts what it reads after the removal (#113),
 * and a timeout, being the server's guess, does not (R2). Making it reversible
 * instead would mean a `pair` room could hold three writers the moment the
 * vanished peer reopened its laptop.
 *
 * Unlike an eviction this retires no join code — freeing the seat is the whole
 * point — and it never closes the room: the joiner that caused it is already
 * seated by the time this runs.
 */
export async function announceReclaimed(
  store: BellmanStore,
  session: StoredSession,
  actor: Identity,
  reclaimed: readonly Member[],
): Promise<void> {
  for (const m of reclaimed) {
    // A frozen room swallows the event (null) and it is tolerated rather than
    // unwound: the seat is already given. The store refuses to seat into a frozen
    // room at all, so reaching here frozen means the room froze in the gap after
    // the seating.
    //
    // No cut on this append, on purpose (#113, R2): a timeout is the server
    // guessing a member is gone, not a creator deciding they should be out, so
    // the seat's old occupant keeps the open feed. Only `member_evicted` cuts —
    // `evictMember` asks `removeMember` for it with `cut: true`, and `leaveRoom`
    // does not — and nobody should add a cut here for symmetry with it.
    await store.appendEvent(session.id, {
      type: "member_timed_out",
      // "system" for the same reason member_evicted uses it: no member handle
      // authored this, and the member it is about is named in the payload. The
      // reclaimed member's own user and label go in fromUserId/fromLabel so the
      // event reads as being about them.
      fromMemberId: "system",
      fromUserId: m.userId,
      fromLabel: m.label,
      payload: {
        member_id: m.memberId,
        label: m.label,
        room_role: m.roomRole,
        last_seen_at: new Date(lastSeen(m)).toISOString(),
      },
      refId: null,
    });
    // `alsoOrgs` for the reason evictMember passes it: the roster may no longer
    // count the member losing access, and that org's admins are the ones who
    // need to see their engineer leave a room.
    //
    // `actor` is the joiner that took the seat, because an audit row has to name
    // a real identity — but the action is `member_timed_out`, not
    // `member_evicted`, so the row says the seat timed out rather than that this
    // person removed anybody. Omitting the row entirely, which an earlier shape
    // did, left an org reconciling a lost room with a silent gap.
    await audit(
      store, session, actor, "member_timed_out",
      {
        member_id: m.memberId, user_id: m.userId, room_role: m.roomRole,
        last_seen_at: new Date(lastSeen(m)).toISOString(),
        seat_taken_by: actor.userId,
      },
      [m.orgId]
    );
  }
}

/**
 * The caller's handle in this room, in it or gone from it, or undefined. One who has left
 * is not on the session (ADR 0019), so that handle is read by id: reads stay open to a
 * member who left, and every caller that refuses one reads `leftAt` for itself.
 */
export async function findMember(
  store: BellmanStore, s: StoredSession, memberId: string, identity: Identity,
): Promise<Member | undefined> {
  const m = s.members.find((mm) => mm.memberId === memberId) ?? await store.getMember(s.id, memberId);
  // A member handle can only be driven by the identity that created it.
  if (!m || m.userId !== identity.userId) return undefined;
  return m;
}

export const sessionStatus = (session: { closed: boolean; frozenAt: number | null }): string =>
  session.closed ? "closed" : session.frozenAt !== null ? "frozen" : "active";

/** Defined beside the stores, which decide it too (ADR 0020); the routes and projections read it from here. */
export { isPublic };

/**
 * Every handle this person has held in the room, in join order, those that left included, from
 * the store (ADR 0019): the session holds only the members in the room now. Empty means a stranger.
 */
export const handlesOf = (
  store: BellmanStore, session: Pick<StoredSession, "id">, identity: Pick<Identity, "userId">,
): Promise<Member[]> => store.membersOfUser(session.id, identity.userId);

/**
 * `bellman_public_name`'s write (public names spec, D3): the room's creator names their public,
 * open room. The index first, then the record; a record write that fails gives the claim back (D5 as
 * amended). The name the room held before is given back at once, and the link returned is read back
 * from the record, so it says what the call established.
 */
export async function namePublicRoom(
  store: BellmanStore, identity: Pick<Identity, "userId">, sessionId: string, name: string,
): Promise<RoomResult<{ name: string; publicUrl: string }>> {
  const session = await store.getSession(sessionId);
  if (!session || (await handlesOf(store, session, identity)).length === 0) {
    return refuse("not_found", "no such room, or no member of yours in it");
  }
  if (session.createdBy !== identity.userId) return refuse("forbidden", "only the room's creator may name it");
  if (session.closed) return refuse("closed", "the room is closed, and a closed room holds no name");
  if (!isPublic(session)) return refuse("invalid", "only a public room has a public name");
  const claim = await claimName(store, name, session.id);
  if (!claim) return refuse("conflict", `public name "${name}" is taken: choose another`);
  if (session.publicName !== name) {
    try {
      await store.setPublicName(session.id, name);
    } catch (err) {
      await store.releasePublicName(name, claim);
      throw err;
    }
    if (session.publicName !== null) {
      const before = await store.publicNameEntry(session.publicName);
      if (before?.id === session.id) await store.releasePublicName(session.publicName, before);
    }
  }
  const after = await store.getSession(session.id);
  return succeed({ name, publicUrl: publicRoomUrl(after ?? session) });
}

/**
 * Where a person's reading stops (#113), if anywhere. Only when every handle
 * they hold was removed: a handle still in the room, or one that left of its
 * own accord, keeps the open feed, as it does on `bellman_sync`. With several
 * removed handles, the latest cut: the most this person was ever shown.
 * Shared by the room routes and bellman_surface (canvas spec D2).
 */
export const cutFor = (handles: readonly Member[]): number | undefined =>
  handles.every(isRemovedMember)
    ? Math.max(...handles.map((m) => m.removedAtCursor ?? 0))
    : undefined;

/**
 * The same cut as a moment, for what a cursor cannot bound: the roster and the
 * member count carry times and no cursors. `markRemoved` sets `leftAt` in the
 * write that sets the cut, so the latest removal's `leftAt` is when this person's
 * reading stopped. Undefined exactly when `cutFor` is, since it asks `cutFor`.
 */
export const cutAtFor = (handles: readonly Member[]): number | undefined =>
  cutFor(handles) === undefined ? undefined : Math.max(...handles.map((m) => m.leftAt ?? 0));

/**
 * The surface as a member reads it (#129, D7): every row in an envelope, and
 * the cursor of the last change.
 *
 * `cut` is a removed member's cursor (#113): such a member reads its history
 * up to the `member_evicted` event that removed it and nothing after, so rows
 * changed past the cut are left out. An item rewritten after the cut is
 * omitted outright; its earlier version is still in that member's event
 * history.
 *
 * Under a cut the cursor is derived from the rows the member is shown (the
 * largest of their cursors, 0 for none) and never from the record. The
 * record's cursor, capped at the cut, claims a change AT the cut when nothing
 * had changed by then, and a member removed from a still-empty room would
 * learn from a nonzero number that the surface changed after it was out. What
 * it is told is what it can see. The cost is that a removal before the cut
 * leaves no row, so the number can sit below the last change the member was
 * entitled to; it only ever understates, and a removed member's feed has
 * ended, so it compares the number with nothing.
 */
export async function readSurface(
  store: BellmanStore,
  session: StoredSession,
  cut?: number,
) {
  const rows = await store.surfaceOf(session.id);
  const visible = cut === undefined ? rows : rows.filter((r) => r.cursor <= cut);
  const cursor = cut === undefined
    ? surfaceCursor(session)
    : visible.reduce((last, r) => Math.max(last, r.cursor), 0);
  return { cursor, items: visible.map(surfaceItem) };
}

/**
 * These events as `reader` may see them (read_context spec, section 1): a `brief_update` its author
 * keeps is left out, a `member_joined` of one loses its brief, and the author's own account reads both.
 * `reader` is a user id, or null for a path every member shares.
 *
 * The rows of the briefs' authors are read by id, gone from the room or not: the session holds only the
 * members in the room now (ADR 0019), and a member who left keeps their last grant (D2). One
 * `getMembers` call, and none when no event carries a brief.
 *
 * The result can be shorter than `events`. A caller that moves a cursor takes it from the events it
 * read and not from this list, so a dropped event is passed over and not asked for again.
 */
export async function eventsFor(
  s: BellmanStore,
  sessionId: string,
  events: readonly SessionEvent[],
  reader: string | null,
): Promise<SessionEvent[]> {
  const authors = briefAuthors(events);
  return readableEvents(events, authors.length === 0 ? [] : await s.getMembers(sessionId, authors), reader);
}

/**
 * Which orgs get a row for this action, and what it says (audit trail spec, D1 and D2). One
 * rule, in one place, for the callers that write it themselves and the ones that hand it to
 * a store operation to commit with the mutation it records.
 *
 * The parties are the room's org, the actor's, any named in `alsoOrgs`, and the org of every
 * person still in the room. The last is what makes a crossing visible from both sides: when a
 * member of org A sends in A's room while a member of org B is in it, A's context reaches B, so
 * B's stream records it too. `alsoOrgs` is for an actor acting on someone else: an eviction
 * touches the evicted member's org, which need be neither the room's nor the creator's, and
 * that member may already have left the room, where the roster no longer counts them. The
 * hosted seat is not a party; it acts for the room. A person with no org is a party with no
 * stream: the room is cross-org for everyone else, and no row is written for them.
 *
 * `roster` is the room as it stands for this action: the session's members unless a caller holds
 * a newer roster, and none for an act nobody in the room sees, such as a preview before joining.
 *
 * It lives here rather than in a transport because a transport that writes its own row is a
 * transport that will one day write it for one org and not the other.
 */
export function auditEntries(
  session: StoredSession,
  actor: Identity,
  action: string,
  detail: Record<string, unknown>,
  alsoOrgs: readonly (string | null)[] = [],
  roster: readonly Member[] = session.members
): AuditEntry[] {
  const parties = partiesOf([
    session.orgId, actor.orgId, ...alsoOrgs, ...roster.filter(isActivePerson).map((m) => m.orgId),
  ]);
  return auditRows(
    parties,
    { at: Date.now(), sessionId: session.id, action, roomName: session.manifest.room, detail },
    { userId: actor.userId, label: actor.label, orgId: actor.orgId },
  );
}

/**
 * Write what `auditEntries` builds, one row per org and all at once, for a caller
 * that has no store operation to commit it with. Any one failing fails the call.
 */
export async function audit(
  store: BellmanStore,
  session: StoredSession,
  actor: Identity,
  action: string,
  detail: Record<string, unknown>,
  alsoOrgs: readonly (string | null)[] = [],
  roster: readonly Member[] = session.members
): Promise<void> {
  const entries = auditEntries(session, actor, action, detail, alsoOrgs, roster);
  await Promise.all(entries.map((e) => store.appendAudit(e)));
}

/**
 * The room's closing invariant: with nobody left in it, it is over. Closes the
 * room if so, and returns the status to report. Every successful path through
 * leaveRoom and evictMember ends here.
 *
 * The store decides and writes in one call. The shape this replaced read the
 * room, saw it empty and then called closeSession, and a member who joined in
 * the gap was closed over: the room ended with them in it, and its codes
 * retired. That gap cannot be closed from this side of the store, which is why
 * the decision moved into it. The other half is `seatMember` refusing a closed
 * room, so a join arriving after the close is turned away and not seated.
 */
async function closeIfEmpty(store: BellmanStore, session: StoredSession): Promise<string> {
  // Closed wins over frozen: an empty room is over either way, and telling
  // someone their room is frozen when it has no members left to thaw for
  // would point them at paying to fix something payment will not fix. The store
  // closes a frozen room like any other, so one that empties never reaches the
  // status below.
  if (await store.closeSessionIfEmpty(session.id)) return "closed";

  // Left open, so the status is whatever the room is now. Re-read: `session`
  // predates whatever the caller has just done to it.
  const now = (await store.getSession(session.id)) ?? session;
  return sessionStatus(now);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * A member departs. The room closes behind the last one out.
 *
 * The departure, its announcement and its audit rows are one `removeMember`
 * operation. Two calls on one handle cannot both announce, and a frozen room
 * does not lose the event: freezing refuses sending, joining and inviting, and
 * must not trap anyone inside.
 *
 * Reads stay open to a member who left — history is still theirs — so a
 * departed handle is not an error here. Leaving again is a no-op — it
 * announces and audits nothing — except that it closes a room the first
 * attempt left empty and open. So is leaving a room that has already closed:
 * the store writes nothing into one, and the answer is the one a repeat of the
 * leave that closed it gives.
 */
export async function leaveRoom(
  store: BellmanStore,
  actor: Identity,
  sessionId: string,
  memberId: string,
): Promise<RoomResult<{ sessionStatus: string }>> {
  const session = await store.getSession(sessionId);
  if (!session) return refuse("not_found", "session not found.");
  const me = await findMember(store, session, memberId, actor);
  if (!me) return refuse("forbidden", "member_id is not yours.");

  // One operation: the guard, the stamp, the departure and the audit row. Read
  // then write was the bug — two calls on one handle both saw leftAt null and
  // both announced (#117) — and the frozen room lost the event outright, because
  // the public append refuses while frozen and leaving must never be refused
  // (#73). `frozen: "allow"` is that rule, said once, here.
  const outcome = await store.removeMember(sessionId, memberId, {
    now: Date.now(),
    frozen: "allow",
    // No cut (#113, R2). A member who chose to go keeps reading: the removal is a
    // decision they made, not one a creator made about them, and the history was
    // theirs. Only `evictMember` asks for the cut; `announceReclaimed` argues the
    // same for a timeout and warns against adding one for symmetry. `false` and
    // not an omission, because `RemovalRequest.cut` has no default: a removal
    // that did not say would read as one that did not decide.
    cut: false,
    event: {
      type: "member_left",
      fromMemberId: memberId,
      fromUserId: actor.userId,
      fromLabel: actor.label,
      payload: { label: actor.label },
      refId: null,
    },
    audit: auditEntries(session, actor, "member_left", {}),
  });

  // A closed room is not a refusal here. Leaving has to work on a room that is
  // over, so that a member can tidy up after one and a client can repeat the
  // leave that closed it; the store writes nothing into a closed room, and the
  // closing below reports it closed. Anything else the store refuses is a room
  // that is no longer there.
  if (outcome.refused !== null && outcome.refused !== "closed") {
    return refuse("not_found", "session not found.");
  }

  // The closing is a separate decision and stays one. `closeSessionIfEmpty`
  // makes it atomically; folding it into the removal would close the room over
  // a member who joined in the gap. A leave that died before this leaves the
  // room empty and open, and a retry — which takes the idempotent path, writing
  // nothing — still reaches here and heals it.
  return succeed({ sessionStatus: await closeIfEmpty(store, session) });
}

/**
 * The preamble every verb-gated operation shares: the room is live, it is not
 * frozen, the handle is the caller's and still in the room, and the seat holds
 * the verb.
 *
 * `leaveRoom` does not use it. Leaving needs no verb, and it must work on a
 * closed room so a member can tidy up after one. `evictMember` stays outside
 * it too: its authority is creator-only, which no verb expresses, and it must
 * work for a creator who has already left the room, whom a gate that requires
 * the caller's handle to still be in it would refuse.
 *
 * Exported for the upload route (#183), which runs it as the tool does and maps
 * its codes to statuses.
 */
export async function gateSeat(
  store: BellmanStore,
  actor: Identity,
  sessionId: string,
  memberId: string,
  verb: Verb,
): Promise<RoomResult<StoredSession>> {
  const session = await store.getSession(sessionId);
  // Two branches, not one, and the reason text is identical on purpose. The
  // sentence a caller reads is unchanged from the old handler; the CODE is what
  // a future HTTP route switches on. A closed room and a missing one are
  // different conditions; folding the first into "not_found" would leave a
  // route no way to tell them apart. Every operation that refuses a closed room
  // answers "closed", whether it goes through this gate or not.
  if (!session) return refuse("not_found", "session not found or closed.");
  if (session.closed) return refuse("closed", "session not found or closed.");
  if (session.frozenAt !== null) return refuse("frozen", FROZEN);
  const me = await findMember(store, session, memberId, actor);
  if (!me || me.leftAt !== null) {
    return refuse("forbidden", "member_id is not yours or has left the session.");
  }
  const denial = denyVerb(session, me, verb);
  if (denial) return refuse("forbidden", denial);
  // A member driving a room operation is as alive as one polling. Without this
  // a member quiet for eleven minutes could call bellman_invite, demonstrably
  // present, and still be chosen as the longest-quiet victim by the very
  // joiner it had just let in. After the verb check, so a refused call is not
  // a membership write; before the operation, so the operation's own reads see
  // it. `me` is already restricted to a handle this identity owns.
  await touchMember(store, session, me);
  // Re-read, because the touch wrote: the operation below decides capacity from
  // this roster, and the caller must be in it as present.
  return succeed((await store.getSession(sessionId)) ?? session);
}

/**
 * A role the manifest does not declare, refused with the names it does. Null
 * when no role was asked for, or the one asked for is declared.
 *
 * Refused as "invalid", not "not_found": the room was found, and it is the
 * request that names a role the room does not have. Read as "not_found", a
 * route would answer 404 for a room that exists, or special-case invite and
 * revoke to get 400 — matching on the operation, which is what a code is there
 * to spare it.
 *
 * One check for both operations, because the old handler made it once, before
 * the issue/revoke split. Revoke is where a copy that drifted would hurt: a
 * mistyped role retires nothing, so without the check it answers an empty
 * success, and an open door reads as shut.
 */
function unknownRole(session: StoredSession, role: string | undefined): RoomResult<never> | null {
  if (role === undefined || Object.hasOwn(session.manifest.roles, role)) return null;
  return refuse(
    "invalid",
    `this room declares no role "${role}" (it declares: ${Object.keys(session.manifest.roles).join(", ")}).`
  );
}

/**
 * Mint a fresh code for a seat: the named role's, or the manifest's default
 * when none is named. Issuing for a role RETIRES that role's previous code and
 * leaves every other role's alone.
 *
 * `invite` and `revoke` are separate verbs, so a seat may hold one without the
 * other. A room whose manifest gives nobody `invite` cannot be reopened by
 * anyone, its creator included: tests/manifest.test.ts calls that a legal
 * manifest, so it is the declared behaviour, not a hole.
 *
 * `permanent` mints a code with no expiry, a null `expiresAt` (ADR 0020), for a
 * public room's default seat and no other. A link put on a page seats whoever
 * finds it, so it belongs only to a room whose work anyone can already read, and
 * only for the seat its creator chose for newcomers. The store asks again whether
 * the room is public where it writes, for a room made private after this read.
 */
export async function issueInvite(
  store: BellmanStore,
  actor: Identity,
  sessionId: string,
  memberId: string,
  role?: string,
  permanent = false,
): Promise<RoomResult<{ code: string; role: string; expiresAt: number | null; replacedPrevious: boolean }>> {
  const gate = await gateSeat(store, actor, sessionId, memberId, "invite");
  if (!gate.ok) return gate;
  const session = gate.value;

  const bad = unknownRole(session, role);
  if (bad) return bad;
  if (permanent && !isPublic(session)) return refuse("conflict", NOT_PUBLIC);
  if (permanent && role !== undefined && role !== session.manifest.defaultRole) {
    return refuse(
      "invalid",
      `a permanent code seats only the room's default role, "${session.manifest.defaultRole}", the seat its creator chose for newcomers. Omit role, or omit permanent for a "${role}" code that expires in 15 minutes.`
    );
  }
  // Seated, not active: a room held full by a session that died must still be
  // able to mint the code that replaces it, which is the confusion #103 opens
  // with. This only counts — the seat is actually reclaimed by the
  // bellman_confirm that redeems this code, which is the one caller authorized
  // to remove anybody. The `invite` verb is not the `evict` authority. Members on
  // a socket are counted for the same reason `seatMember` will not reclaim them.
  const connected = await store.connectedMembers(session.id);
  if (seatedMembers(session, Date.now(), connected).length >= capacityOf(session.manifest)) {
    return refuse("conflict", `a new code could not be used: ${fullMessage(session.manifest)}`);
  }

  const issuedRole = role ?? session.manifest.defaultRole;

  // Replacing a LIVE code is the `revoke` authority, not the `invite` one (#90).
  // Issuing used to retire the previous code unconditionally, so a seat holding
  // `invite` alone could cut off a code someone was holding just by minting.
  // `bellman_connect` shows a joiner's human `your_verbs` before any of their
  // context crosses, and `invite` without `revoke` reads there as "this seat
  // cannot take a live code away" — a preview promising more restriction than
  // the room enforced. The verbs now mean what that preview implies: `invite`
  // opens a door that is shut, `revoke` shuts one that is open, and replacing a
  // live code is both, so it needs both.
  //
  // **The decision goes to the store, and that is the fix for the second bug
  // here.** This used to read the roster, see no live code, and then call
  // `setJoinCode`, which wrote unconditionally — so two callers holding `invite`
  // and not `revoke` could both observe no live code, and the second would
  // retire the first's with neither of them allowed to. Found in review on the
  // PR. The store is the only place that holds the record and the write
  // together, so it is the only place the two can be one decision; here we say
  // only what this seat is ALLOWED to do, and it says what was there.
  //
  // Fails closed. `gateSeat` has already established this member exists, so a
  // miss means the predicate moved under us, and the safe answer to "may this
  // seat retire a code someone is holding" is no.
  const me = await findMember(store, session, memberId, actor);
  const mayReplaceLive = me !== undefined && denyVerb(session, me, "revoke") === null;

  const now = Date.now();
  const code = renderJoinCode(issuedRole);
  const expiresAt = permanent ? null : now + JOIN_CODE_TTL;
  const set = await store.setJoinCode(sessionId, issuedRole, code, expiresAt, {
    replaceLive: mayReplaceLive,
    now,
  });
  if (!set.ok) {
    // Refused rather than silently downgraded to a no-op: a caller that asked
    // for a code and got none must hear why, or it hands out one that never came.
    if (set.reason === "frozen") return refuse("frozen", FROZEN);
    if (set.reason === "not_public") return refuse("conflict", NOT_PUBLIC);
    const wait = session.joinCodes[issuedRole]?.expiresAt === null
      ? "That code is permanent and will not expire, so ask a seat that holds revoke."
      : "Wait for that code to expire, or ask a seat that holds revoke.";
    return refuse(
      "forbidden",
      `role "${issuedRole}" already has a live join code. Replacing it retires the one someone may be holding, so it needs the "revoke" verb as well as "invite" — your seat holds invite alone. ${wait}`
    );
  }
  const previous = set.replacedLive;

  await store.appendEvent(session.id, {
    type: "invite_issued",
    fromMemberId: memberId,
    fromUserId: actor.userId,
    fromLabel: actor.label,
    payload: { role: issuedRole, expires_at: expiresAt === null ? null : new Date(expiresAt).toISOString(), permanent },
    refId: null,
  });
  await audit(store, session, actor, "invite_issued", {
    role: issuedRole, replaced_previous: previous, permanent,
  });

  return succeed({ code, role: issuedRole, expiresAt, replacedPrevious: previous });
}

/**
 * Close a door and leave it closed. An absent role retires EVERY code,
 * deliberately asymmetric with issuing: over-revoking is recoverable by minting
 * again, while under-revoking leaves a door open behind someone who believes
 * they shut it.
 */
export async function revokeInvite(
  store: BellmanStore,
  actor: Identity,
  sessionId: string,
  memberId: string,
  role?: string,
): Promise<RoomResult<{ roles: string[] }>> {
  const gate = await gateSeat(store, actor, sessionId, memberId, "revoke");
  if (!gate.ok) return gate;
  const session = gate.value;

  const bad = unknownRole(session, role);
  if (bad) return bad;

  // An expired code is not a live code, and nothing prunes joinCodes when a
  // code merely expires — only setJoinCode, consumeJoinCode, clearJoinCodes and
  // the abandonment sweep touch the map. So presence alone is not enough, or a
  // bare revoke announces the closing of a door that had already shut by
  // itself: an event, an audit row, and over-reported roles.
  const retired = (role ? [role] : Object.keys(session.joinCodes)).filter((r) => {
    const rec = session.joinCodes[r];
    return rec !== undefined && codeIsLive(rec, Date.now());
  });
  if (role) await store.consumeJoinCode(sessionId, role);
  else await store.clearJoinCodes(sessionId);

  if (retired.length > 0) {
    await store.appendEvent(session.id, {
      type: "invite_revoked",
      fromMemberId: memberId,
      fromUserId: actor.userId,
      fromLabel: actor.label,
      payload: { roles: retired },
      refId: null,
    });
    await audit(store, session, actor, "invite_revoked", { roles: retired });
  }

  return succeed({ roles: retired });
}

/**
 * Count one bellman_send against its sender's minute (spec D5), or refuse it. Called after every check
 * that can refuse the send and before its append.
 *
 * Whose minute is `sendKeyFor`'s: a stranger's belongs to the account within this room, so a second handle
 * taken through the permanent code, or a leave and a rejoin, does not start it again; anyone else's belongs
 * to the seat.
 *
 * Last of the checks and ahead of the first write, so a send refused for its verb, its payload or a frozen
 * room spends no place, and a refusal here leaves the log as it was. Once the count says yes the place is
 * spent whatever the append then does: a send that meets a key conflict, or a room that froze in the gap,
 * still used it (R7). A keyed retry is a send like any other, so at the limit it is refused before its key
 * is looked up, and the same key replays once the minute has room again (R6).
 *
 * `retryAfter` is `waitRefusal`'s: whole seconds, rounded up.
 */
export async function admitSend(
  store: BellmanStore,
  sessionId: string,
  member: Member,
  now: number = Date.now(),
): Promise<RoomResult<null>> {
  const limit = sendLimitFor(member);
  const admission = await store.admitSend(sessionId, sendKeyFor(member), limit, now);
  if (admission.ok) return succeed(null);
  return waitRefusal(`this seat has used its ${limit} sends for the minute, and nothing was sent`, admission.retryAfterMs);
}

/**
 * The refusal of a limit that carries a wait: a send's minute and an account's reports in a day. The store answers
 * in milliseconds and a refusal in whole seconds, rounded up, because a client that waited the rounded-down second
 * would be refused again. One function, so the two limits cannot come to round differently.
 */
function waitRefusal(spent: string, retryAfterMs: number): RoomResult<never> {
  const retryAfter = Math.ceil(retryAfterMs / 1000);
  return refuse(
    "rate_limited",
    `rate_limited: ${spent}. Try again in ${retryAfter} second${retryAfter === 1 ? "" : "s"}.`,
    { retryAfter },
  );
}

/**
 * A seat writes one item on the room's working surface, or removes one (#129).
 *
 * One operation for both transports — `bellman_send type: "surface"` and
 * `PUT`/`DELETE /rooms/:id/surface/:key` (#184) — for the reason this module
 * exists: a second transport re-typing the sequence is a second chance to skip
 * the verb guard or the audit row. The order is the write path the spec gives:
 * the seat's guards (`gateSeat`, which also touches the caller), the payload's
 * shape and each kind's rule, the blob a file, image or html item names, the rows for the
 * cap and a connector's ends, the append with the row riding it, the audit row.
 *
 * The rows are read once and then the append happens, which is a
 * read-then-write with the window open: two writers can both add a 64th item,
 * and a connector can name a key removed a millisecond earlier. Both are
 * courtesy bounds — a 65th row costs nothing and a dangling connector is a
 * state the spec declares a reader handles — so neither moves into the store.
 * The verb guard, the frozen guard and the row's write are not courtesies, and
 * each is where it has to be.
 *
 * `countSend` is `bellman_send`'s: its `surface` kind is a send, and counts against the member's minute
 * (ADR 0022, R6), after every validation and ahead of the append. The routes leave it off, because the
 * dash's group drag writes one PUT per card and would pass 30.
 */
export async function writeSurface(
  store: BellmanStore,
  blobs: BlobStore,
  actor: Identity,
  sessionId: string,
  memberId: string,
  payload: unknown,
  idempotencyKey?: string,
  countSend = false,
): Promise<RoomResult<{ cursor: number; replayed: boolean; roomMembers: string[] }>> {
  const gate = await gateSeat(store, actor, sessionId, memberId, "write_surface");
  if (!gate.ok) return gate;
  const session = gate.value;

  const normalized = normalizeSurfaceWrite(payload);
  if (!normalized.ok) return refuse("invalid", normalized.reason);
  let { write } = normalized;

  // A blob-backed item carries the object's metadata, not the writer's (#183,
  // D5): the writer named an id, and what readers get is what the bucket holds
  // under this room's prefix. `head` resolves nothing from another room (D1),
  // so a foreign id is "no blob" here too. The image and html checks are on the
  // STORED type, which D6 already decided at upload.
  if (normalized.blobId !== null && write.item !== null) {
    const meta = await blobs.head(sessionId, normalized.blobId);
    if (!meta) {
      return refuse("invalid", `surface ${write.item.kind} "${write.key}": no blob ${normalized.blobId} has been uploaded to this room.`);
    }
    if (write.item.kind === "image" && !isImageType(meta.type)) {
      return refuse(
        "invalid",
        `surface image "${write.key}": blob ${normalized.blobId} is stored as ${meta.type}, which is not an image this server serves as one (${IMAGE_TYPES.join(", ")}); place it as a file.`,
      );
    }
    // normalizeMediaType drops parameters and lower-cases, so text/html; charset=utf-8 places; a type it cannot
    // read comes back as an octet-stream, which is no more text/html than the original was.
    if (write.item.kind === "html" && normalizeMediaType(meta.type) !== "text/html") {
      return refuse(
        "invalid",
        `surface html "${write.key}": blob ${normalized.blobId} is stored as ${meta.type}, which is not text/html; place it as a file.`,
      );
    }
    write = {
      key: write.key,
      item: { ...write.item, blob: { id: normalized.blobId, bytes: meta.bytes, type: meta.type, name: meta.name } },
    };
  }

  const rows = await store.surfaceOf(sessionId);
  const byKey = new Map(rows.map((r) => [r.key, r] as const));
  if (write.item !== null) {
    if (!byKey.has(write.key) && rows.length >= MAX_SURFACE_ITEMS) {
      return refuse(
        "conflict",
        `this room's surface already holds ${MAX_SURFACE_ITEMS} items; remove one with { key, remove: true } before adding "${write.key}".`,
      );
    }
    if (write.item.kind === "connector" && write.item.ends !== null) {
      for (const end of [write.item.ends.from, write.item.ends.to]) {
        const target = byKey.get(end);
        if (!target) {
          return refuse("invalid", `connector "${write.key}" names "${end}", which is not on the surface.`);
        }
        if (target.kind === "connector") {
          return refuse("invalid", `connector "${write.key}" names "${end}", which is a connector; connectors join items, not each other.`);
        }
      }
    }
  }

  if (countSend) {
    const me = await findMember(store, session, memberId, actor);
    if (!me) return refuse("forbidden", "member_id is not yours or has left the session.");
    const admitted = await admitSend(store, sessionId, me);
    if (!admitted.ok) return admitted;
  }

  const draft: EventBody = {
    type: "surface",
    fromMemberId: memberId,
    fromUserId: actor.userId,
    fromLabel: actor.label,
    // The normalised item, so the event reads as the row does: every optional
    // field present as null. A removal's payload is the tombstone itself.
    payload: write.item ?? { key: write.key, remove: true },
    refId: null,
  };
  const extras: AppendExtras = { surface: write };

  let event: SessionEvent;
  let replayed = false;
  if (idempotencyKey) {
    const w = await store.appendEventOnce(sessionId, draft, idempotencyKey, extras);
    if (w.outcome === "conflict") {
      return refuse(
        "conflict",
        `idempotency_key "${idempotencyKey}" was already used for a different message. Reuse a key only to retry the same send; pick a new one for new content.`,
      );
    }
    if (w.outcome === "frozen") return refuse("frozen", FROZEN);
    event = w.event;
    replayed = w.outcome === "replayed";
  } else {
    const appended = await store.appendEvent(sessionId, draft, extras);
    if (!appended) return refuse("frozen", FROZEN);
    event = appended;
  }

  // Nothing below happens twice: a replay's original call did it.
  if (!replayed) {
    await audit(
      store, session, actor, "sent_surface",
      write.item !== null
        ? {
            key: write.key, kind: write.item.kind, chars: write.item.body?.length ?? 0,
            ...(write.item.blob ? { bytes: write.item.blob.bytes } : {}),
          }
        : { key: write.key, removed: true },
    );
  }

  return succeed({
    cursor: event.cursor,
    replayed,
    // Who else was active when the gate read the room — `bellman_send`'s
    // `room_members`, with the same caveat: not a read receipt.
    roomMembers: activeMembers(session).filter((m) => m.memberId !== memberId).map((m) => m.label),
  });
}

/**
 * The event that says a seat's code was retired by its creator. Built here and
 * written by the store, in the transaction that retires the code. From "system"
 * for the reason member_evicted is: there is no member handle to name.
 */
function doorShutEvent(actor: Identity, role: string): EventBody {
  return {
    type: "invite_revoked",
    fromMemberId: "system",
    fromUserId: actor.userId,
    fromLabel: actor.label,
    payload: { roles: [role] },
    refId: null,
  };
}

/**
 * One removal's request, built from the member it removes: what `evictMember` asks the store for, and what a
 * deprovision asks (SCIM spec, D6). `room` is the room the member is removed from, whose codes and orgs the
 * request reads; `stored` is the ban the store is asked to write, `asked` the ban the call asked for, which the
 * audit row carries whatever it is; `policy` is what differs between the two callers: whether a frozen room
 * refuses (a creator's eviction) or not (the system acting on the org's instruction), whether the store's
 * creator guard is armed, and a reason the event and the row name.
 */
export function evictionRequest(
  room: StoredSession, m: Member, actor: Identity, stored: BanScope | undefined, asked: BanScope | undefined,
  policy: { frozen: "allow" | "refuse"; byUserId: string | undefined; reason?: string },
): RemovalRequest {
  return {
    now: Date.now(),
    frozen: policy.frozen,
    // An eviction cuts the feed (#113): the target is recorded out at the
    // `member_evicted` event's own cursor, so their last readable event is the one
    // telling them why (R4), and everything after it is refused. The store writes
    // the cut in the same transaction as that event, because the two cannot be
    // allowed to disagree — a cut naming a cursor no event carries, or a member
    // recorded out with no cut at all, which IS the open feed this closes.
    //
    // A leave asks for no cut and a reclaimed seat gets none: see
    // `RemovalRequest.cut` and the note in `announceReclaimed`. Nobody should add
    // one there for symmetry with this.
    cut: true,
    // The caller, so that the store's creator guard is a real one: passing
    // `session.createdBy` would compare the creator with itself and refuse nobody.
    // The check above has already turned away anyone else, so on a real room this guard
    // does not fire from here. It is the second belt, and it is what guards a removal
    // wherever the removal is asked from.
    ...(policy.byUserId === undefined ? {} : { byUserId: policy.byUserId }),
    event: {
      type: "member_evicted",
      // No member handle to name: creator authority is on the user, and a
      // creator who has left the room still holds it. "system" is the existing
      // marker for a server-originated event; the creator is in fromUserId.
      fromMemberId: "system",
      fromUserId: actor.userId,
      fromLabel: actor.label,
      payload: { member_id: m.memberId, label: m.label, room_role: m.roomRole, ...(policy.reason ? { reason: policy.reason } : {}) },
      refId: null,
    },
    // The door and the member go together now. Under the old shape the door shut
    // FIRST and deliberately, so a failure left the member in with the door shut
    // rather than out with it open: over-revoking is recoverable by minting again,
    // and under-revoking leaves a door open behind someone who believes it shut.
    // One transaction makes both land or neither, so the ordering no longer
    // carries that. What is left of the bias is a repeat of an eviction, which
    // retires a code minted for the seat since; minting again recovers it. The
    // events are written in the order a person would tell it — the member went,
    // then the door shut.
    //
    // Both paths record the door the same way: an `invite_revoked` event and an
    // `invite_revoked` audit row, queued with the retirement and only when the
    // store retires a code. That holds for a member who was already out too, whose
    // live door the store still shuts. A `code_retired` field on the `member_evicted`
    // row would be worse twice over. It is filled in before the store says whether
    // a door shut, so it would be wrong whenever the door changed between the read
    // above and the removal. And it could only describe a removal this call made,
    // so the doors an eviction shut would sit in two places, a field for members who
    // were present and a row for those who had already left, and a query for
    // `invite_revoked` would find half of them. The row goes where revokeInvite's
    // goes, to the orgs `auditEntries` names. Those include the evicted member's
    // org while they are still in the room, since the door shuts as they leave and
    // their org's `member_evicted` row beside it names them. A member who had
    // already left is no party to it, and their org is not added: the row names a
    // role and no person, so that org could not tell whom it concerned, and a row
    // an org cannot resolve to anyone is worse than none.
    //
    // Except a public room's permanent code, which an eviction leaves open (see above). Read from
    // the room as this call found it, so a code replaced since is the next eviction's to shut.
    ...(room.joinCodes[m.roomRole]?.expiresAt === null ? {} : {
      retire: {
        role: m.roomRole,
        event: doorShutEvent(actor, m.roomRole),
        audit: auditEntries(room, actor, "invite_revoked", { roles: [m.roomRole] }),
      },
    }),
    ...(stored ? { ban: stored } : {}),
    audit: auditEntries(
      room, actor, "member_evicted",
      {
        // The seat and the person. member_id is per connection and only resolves
        // inside the room, so user_id is what lets an org reading its own log see
        // which of its people went; member_id stays for when one person holds two.
        //
        // No `code_retired`: whether a door shut is the store's answer, and this
        // row is built before the store gives it. The door has its own row, see
        // `retire`.
        member_id: m.memberId, user_id: m.userId, room_role: m.roomRole,
        // The ban, when the call asked for one, so an org reading its log finds every ban there. The
        // event above never carries it: the log is public in a public room.
        ...(asked ? { ban: asked } : {}),
        ...(policy.reason ? { reason: policy.reason } : {}),
      },
      // The evicted member's org as well. The roster counts them only while they are
      // still in the room, and a target who has already left still needs this row.
      [m.orgId],
    ),
  };
}

/**
 * The room's creator removes a member, and cuts what they read after it.
 *
 * Creator-only, and outside the verb set — the same category as closing a
 * room. Authority over a room as an object, rather than authority to act
 * within it. An `evict` verb would let a manifest hand eviction to a joiner,
 * and a room whose preset does that is not one anybody asked for.
 *
 * Not an org-admin path either. `Identity.role` is platform authority over an
 * org and buys nothing inside a room; an org admin is not automatically
 * anything in a room, and a room's creator need not be an org admin. That is
 * why the check lives here and not in `src/roles.ts`.
 *
 * Removal is soft, as a leave is: the record stays, with `leftAt` set, and
 * `activeMembers` already reads that as out. Events carry their sender's
 * `fromMemberId`, `fromUserId` and `fromLabel`, so history reads the same
 * either way, but deleting the record would leave every earlier event naming a
 * member the roster no longer holds, to keep the present tidy.
 *
 * The removal, the cut it records, its announcement, the closing of the seat's
 * door and the audit rows are one `removeMember` operation, and so are its
 * guards: a room that closed or froze, or a caller who did not create it, is
 * refused inside the transaction that would have written. A guard read here and a
 * write made after it is the gap #118 was filed for: a freeze landing between the
 * two.
 *
 * So a refusal means NOTHING happened — the member is still in, with no cut, and
 * their seat's door untouched. Under the shape this replaced, where the door shut
 * first and the member write rode a separate append, a refusal could leave the
 * member in with their door already shut: over-revoked, recoverable by minting
 * again, and deliberately the better of the two halves available then. One
 * transaction has neither half, so a retry repeats the whole eviction.
 *
 * A member who already left can still be evicted, and it is not a no-op:
 * `leaveRoom` retires no code, so their seat's code may still be live and the
 * seat free, and evicting them shuts that door. Only the removal is not said a
 * second time: the store writes the departure for a member it removes, and the
 * door's closing whenever a code is live.
 *
 * A public room's permanent code is the one door an eviction leaves open. This departs from
 * ADR 0020 section 5, which has an eviction shut it. It is the link everyone else uses, and a
 * stranger came in through it, so shutting it on every removal would make the creator reissue
 * and republish it each time. Keeping someone out of a room that publishes one is what `ban` is for.
 *
 * `ban` also bars the account from joining again (spec section 1): from this room, or from every
 * room the creator owns. The store writes it with the removal, in the transaction that records the
 * member out, and it is not an event: a public room's log is public, and the person banned is told
 * only that they can't join. The audit row of the eviction carries `ban`, and the store files that
 * row for a ban on a member who already left too. A ban is on the account and a member_id is per
 * connection, so every other handle the account still holds in the room is removed as well, each by
 * a removal of its own with its own event, door and rows. Their outcomes are not reported: a refusal
 * partway is finished by repeating the eviction, which finds the target out and removes the rest.
 *
 * `"all"` covers the creator's rooms now as well as later: every other room they own where the account
 * holds a handle loses it too, each handle by the removal an eviction makes there, under that room's own
 * code rules, and with no room ban, since the creator-wide one keeps the account out. `alsoRemovedFrom`
 * counts the rooms this call removed it from. They are found through the joined-rooms index, so a seat
 * the index lost (`BellmanStore.sessionsJoinedBy`) stays, and only the account's next join there is refused.
 */
export async function evictMember(
  store: BellmanStore,
  actor: Identity,
  sessionId: string,
  targetMemberId: string,
  ban?: BanScope,
): Promise<RoomResult<{
  evicted: boolean; codeRetired: string | null; sessionStatus: string; banned: BanScope | null; alsoRemovedFrom: number;
}>> {
  const session = await store.getSession(sessionId);
  if (!session) return refuse("not_found", "session not found.");

  // Authority before anything the room would say about itself. The refusals below
  // name a member that is not there and a handle that is the caller's, and a caller
  // who did not create this room must read neither. `bellman_evict` takes the
  // target's member_id and no handle of the caller's, so nothing in the call shows the
  // caller is in the room at all: "no member with that member_id is in this room"
  // would tell anyone holding a session id which ids it holds, and the refusal for
  // evicting oneself would tell them which are theirs. The store checks the same
  // thing again, because the removal's guards live there and every caller of
  // removeMember gets them. The creator never changes, so the two cannot disagree on
  // a real room; this check is what decides what a caller is told.
  if (session.createdBy !== actor.userId) {
    return refuse("forbidden", "only the person who created this room can remove a member from it.");
  }

  // A direct lookup, NOT findMember: that helper requires the handle to belong
  // to the caller, which is the one thing eviction has to do differently. Read
  // here to say WHICH refusal the caller reads and to build the rows. The two
  // checks made on this read are of facts that cannot change under it: a member's
  // record is never deleted and its user never changes. The room closing and a
  // freeze can, so those guards are inside removeMember, where a freeze landing in
  // this gap cannot slip past them (#118). A target who has left is read by id, since
  // the session holds only the members in the room now (ADR 0019).
  const target = session.members.find((m) => m.memberId === targetMemberId)
    ?? await store.getMember(sessionId, targetMemberId);
  if (!target) return refuse("not_found", "no member with that member_id is in this room.");
  if (target.userId === actor.userId) {
    // Names no tool and no route. This module serves every transport, and a panel
    // user cannot call an MCP tool: advice naming one is advice half the callers
    // cannot act on. An agent reading "leave the room" knows which tool does that.
    return refuse("forbidden", "you cannot evict yourself; leave the room instead.");
  }

  // One removal's request, built from the member it removes. A ban takes every handle the account
  // holds in the room (below), and each is a member of its own, with its own seat, door and org, so
  // each gets its own event, door and audit rows. With no ban, and no permanent code behind the seat,
  // for one handle it is the request this function has always made. `room` is the room the member is
  // removed from, whose codes and orgs the request reads; `stored` is the ban the store is asked to
  // write, and the audit row carries the call's `ban` whatever it is.
  const request = (room: StoredSession, m: Member, stored: BanScope | undefined): RemovalRequest =>
    evictionRequest(room, m, actor, stored, ban, { frozen: "refuse", byUserId: actor.userId });
  const outcome = await store.removeMember(sessionId, targetMemberId, request(session, target, ban));

  if (outcome.refused === "closed") return refuse("closed", "session is closed.");
  if (outcome.refused === "frozen") return refuse("frozen", FROZEN);
  if (outcome.refused === "forbidden") {
    return refuse("forbidden", "only the person who created this room can remove a member from it.");
  }
  if (outcome.refused !== null) return refuse("not_found", "session not found.");

  // A ban is on the account and a member_id is per connection, so the person's other handles in
  // the room go too, or one of them keeps sending. Each is removed by a removal of its own, and
  // the outcomes are not read: a refusal partway, such as a freeze landing between two of them,
  // is finished by repeating the eviction. That finds the target out and the ban kept, and removes
  // whoever is left. Each asks the store for the room's ban alone: the target's removal queued the
  // creator-wide one, and a second row the outbox delivered after a lift would bring it back.
  if (ban) {
    for (const other of await handlesOf(store, session, target)) {
      if (other.memberId !== targetMemberId && isActiveMember(other)) {
        await store.removeMember(sessionId, other.memberId, request(session, other, "room"));
      }
    }
  }

  // "all" now: the account's handles in the creator's other rooms go as well, each by the removal an
  // eviction makes in that room, read from that room, with no ban of the room's own. A room that refuses,
  // frozen say, is finished by repeating the ban, as above. Each room that loses its last person closes,
  // the rule every removal ends on. The scan is bounded by JOINED_SCAN, whose note gives the cost.
  let alsoRemovedFrom = 0;
  if (ban === "all") {
    for (const id of await store.sessionsJoinedBy(target.userId, JOINED_SCAN)) {
      const room = id === sessionId ? undefined : await store.getSession(id);
      if (!room || room.closed || room.createdBy !== session.createdBy) continue;
      let removed = false;
      for (const m of room.members.filter((mm) => mm.userId === target.userId && isActiveMember(mm))) {
        removed = (await store.removeMember(id, m.memberId, request(room, m, undefined))).removed || removed;
      }
      if (removed) {
        alsoRemovedFrom++;
        await store.closeSessionIfEmpty(id);
      }
    }
  }

  // `removed: false` with no refusal is a member who was already out. The store
  // did not say the departure again, and shut their seat's door if it was still
  // open; `codeRetired` is its answer either way. The closing is still owed, and
  // is the other thing a repeat is for: a retry landing here closes a room an
  // interrupted eviction left empty and open.
  return succeed({
    evicted: true,
    codeRetired: outcome.codeRetired,
    // Last, as before: whatever came after the close would be lost, because
    // every later call refuses on "closed".
    sessionStatus: await closeIfEmpty(store, session),
    // What the call asked for, and the target's removal has committed it: the room's ban in its
    // own transaction, and for "all" the registry's, queued in that transaction for the outbox
    // to deliver. A refusal returned above, so none of this is claimed for one.
    banned: ban ?? null,
    alsoRemovedFrom,
  });
}

/** One refusal for a cursor that names no event and for one that names an event the caller may not read, so the two read alike. */
const NO_MESSAGE_AT_CURSOR = "no message at that cursor.";

/**
 * File a report (abuse protections spec section 3, R11), for both transports: who may report, what a target must
 * be, the store's fold and daily limit, and the email once a report is filed, never for a fold or a refusal.
 *
 * Anyone who holds or held a handle in the room may report it, and while the room is public so may anyone signed in.
 * A room that is neither is refused as a room that is not there, before the target is read, so a stranger learns
 * nothing about the member ids or cursors it holds. A frozen room can be reported, and so can a closed one until it
 * is purged: a report is how the people who were in a room tell the operators what happened there.
 *
 * The target is the room, a member (`memberId`) or a message (`cursor`), never two. A member is anyone the room ever
 * seated, one who left included. A message is an event of a kind a member sends (`SEND_KINDS`). The room writes notices
 * of its own, some as "system" (an eviction, a timeout, a heartbeat tick) and some under the member they are about (a
 * join, a leave, a code issued or revoked), and none of those is a message: a report of one would be a report about
 * whoever it names. The report keeps whom it is about (R12), read from the member or from the event's sender, so an
 * operator can act on the account.
 *
 * A caller may report a message exactly when it could read it. A removed member read a room that is not public up to
 * its cut and no further (#113), so a cursor past the cut names an event it was never shown, and is refused as one that
 * does not exist: a report must not tell it what the room holds after it was out. A public room's log is public to
 * anyone, so while the room is public there is no cut, and someone removed from it may still report what is said about
 * them afterwards. A member who left keeps the open feed, and so the open cursors.
 *
 * A brief_update whose author does not grant `read_context` is one a caller cannot read, unless the caller is the author's
 * own account (read_context spec, section 1). A cursor that names one is refused in the words for a cursor that names no
 * event, so the refusal does not say an update is there. The author's row decides as it stands, one who left included,
 * and a missing row reads as not granting.
 *
 * A caller who reads a public room as anyone with its link does reads what the public page shows, and the page shows no
 * brief_update: a caller with no handle in the room, now or before, and one whose every handle was removed from it. For them
 * a cursor that names an update is refused whatever its author grants, in the same words, because filed for an author who
 * grants and refused for one who keeps their brief would tell them what the page keeps from them. A caller with a handle
 * still in the room, or one that left of its own accord, reads as their account, as above.
 *
 * The shape of the request is checked first, because it reads nothing from the room. The limit on a note applies to what
 * was sent, before it is trimmed, which is what the tool's schema bounds, so the tool and the route agree. A note is then
 * trimmed and an empty one is none. The note is untrusted text and is kept as written.
 *
 * `mail` runs once the store has answered `filed`, and a `ReportMailer` never rejects, so a failed email cannot undo a
 * filing. A repeat of a report still open answers `folded` and mails nothing (R9). Past 10 filings in a rolling day
 * (R10) the store answers `limited`, and the refusal is `rate_limited` with the wait, as a send's is.
 */
export async function fileRoomReport(
  store: BellmanStore,
  actor: Identity,
  sessionId: string,
  input: { memberId?: string; cursor?: number; reason: string; note?: string | null },
  mail: ReportMailer,
  now: number = Date.now(),
): Promise<RoomResult<{ reportId: string; folded: boolean }>> {
  const reason = REPORT_REASONS.find((r) => r === input.reason);
  if (reason === undefined) return refuse("invalid", `reason must be one of ${REPORT_REASONS.join(", ")}.`);
  if (input.memberId !== undefined && input.cursor !== undefined) {
    return refuse("invalid", "name a member or a message, not both; name neither to report the room.");
  }
  // The bound is on the note as sent, before it is trimmed, as the tool's schema has it, so the tool and the route refuse the
  // same notes. Trimming only shortens, so a note that passes here is within it after the trim as well.
  if (input.note != null && input.note.length > MAX_REPORT_NOTE_CHARS) {
    return refuse("invalid", `a note is at most ${MAX_REPORT_NOTE_CHARS} characters.`);
  }
  const note = input.note?.trim() || null;

  const session = await store.getSession(sessionId);
  const handles = session ? await handlesOf(store, session, actor) : [];
  if (!session || (handles.length === 0 && !isPublic(session))) {
    return refuse("not_found", "no such room, or no member of yours in it");
  }

  let target: ReportTarget = { kind: "room" };
  let subject: NewReport["subject"] = null;
  if (input.memberId !== undefined) {
    const seated = await store.getMember(session.id, input.memberId);
    if (!seated) return refuse("invalid", "no member with that member_id has been in this room.");
    target = { kind: "member", memberId: seated.memberId };
    subject = { memberId: seated.memberId, userId: seated.userId, label: seated.label };
  } else if (input.cursor !== undefined) {
    if (!Number.isInteger(input.cursor) || input.cursor < 1) {
      return refuse("invalid", "cursor must be a positive whole number.");
    }
    // A caller may report what it could read. A public room's log is public, so it has no cut to keep. Past the access
    // check above, a caller of a room that is not public holds a handle, which `cutFor` needs: given none it says -Infinity.
    // `memberCut` is where reading as a member stops, if it does: defined for a caller with no handle and for one whose every
    // handle was removed, undefined while any handle reads on.
    const memberCut = cutFor(handles);
    const cut = isPublic(session) ? undefined : memberCut;
    const event = cut !== undefined && input.cursor > cut ? undefined : await store.eventAt(session.id, input.cursor);
    if (!event || !SEND_KINDS.some((kind) => kind === event.type)) return refuse("invalid", NO_MESSAGE_AT_CURSOR);
    // And what read_context lets it read (D2, D3). In a public room, a caller with no member reading of it has the public page
    // and nothing else, and the page has no brief_update to show. Anyone else reads as their account: a brief_update its author
    // keeps is no event to any account but the author's, from the author's row as it stands, one who left included, and no row
    // reads as not granting (R11).
    const shown = isPublic(session) && memberCut !== undefined
      ? publicReadEvent(event)
      : readableEvent(event, await store.getMember(session.id, event.fromMemberId), actor.userId);
    if (!shown) return refuse("invalid", NO_MESSAGE_AT_CURSOR);
    target = { kind: "message", cursor: event.cursor };
    subject = { memberId: event.fromMemberId, userId: event.fromUserId, label: event.fromLabel };
  }

  const filed = await store.fileReport(
    {
      sessionId: session.id, creatorId: session.createdBy, target, subject, reason, note,
      reporterUserId: actor.userId, reporterLabel: actor.label,
    },
    now,
  );
  if (filed.outcome === "limited") {
    return waitRefusal(`this account has filed ${REPORTS_PER_DAY} reports in the last day, and nothing was filed`, filed.retryAfterMs);
  }
  if (filed.outcome === "filed") await mail(filed.report);
  return succeed({ reportId: filed.report.id, folded: filed.outcome === "folded" });
}
