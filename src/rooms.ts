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
import type { AuditEntry, Identity, Member, Verb } from "./types.js";
import type { StoredSession } from "./stored-session.js";
import { renderJoinCode } from "./codes.js";
import { denyVerb } from "./roles.js";
import { JOIN_CODE_TTL, isActiveMember, type BellmanStore, type EventBody } from "./store.js";
import { NO_SOCKETS, STALE_AFTER_MS, lastSeen, presentMembers } from "./presence.js";

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
 */
export type RoomFailure = "not_found" | "closed" | "frozen" | "forbidden" | "conflict" | "invalid";

/**
 * Not a throw, because these are ordinary outcomes — a closed room is not
 * exceptional. Not a ToolResult, because that shape is MCP's and a route has
 * no use for a `content` array.
 */
export type RoomResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: RoomFailure; reason: string };

export const succeed = <T>(value: T): RoomResult<T> => ({ ok: true, value });

/** `RoomResult<never>` so a refusal is assignable to any operation's result. */
export const refuse = (code: RoomFailure, reason: string): RoomResult<never> =>
  ({ ok: false, code, reason });

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
  "this session is frozen: the plan that created it has lapsed. Everyone stays a member and the " +
  "history is still readable, but nothing new can be sent or joined until the plan is restored.";

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
 * `updateMember` is a read-modify-write of the whole session blob — every
 * member with its brief, every join code, the manifest — so a write on each
 * 25-second poll would cost more than the per-beat event row this design
 * rejects as the wrong home for liveness. Half the window keeps `lastSeenAt` at
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
    // `alsoOrgs` for the reason evictMember passes it: the member losing access
    // may be in neither the room's org nor the joiner's, and that org's admins
    // are the ones who need to see their engineer leave a room.
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

export function findMember(s: StoredSession, memberId: string, identity: Identity): Member | undefined {
  const m = s.members.find((mm) => mm.memberId === memberId);
  // A member handle can only be driven by the identity that created it.
  if (!m || m.userId !== identity.userId) return undefined;
  return m;
}

export const sessionStatus = (session: { closed: boolean; frozenAt: number | null }): string =>
  session.closed ? "closed" : session.frozenAt !== null ? "frozen" : "active";

/**
 * Which orgs get a row for this action, and what it says. One rule, in one
 * place, for the callers that write it themselves and the ones that hand it to
 * a store operation to commit with the mutation it records.
 *
 * Enterprise audit trail. Cross-org sessions write one entry per involved org
 * so each org's admins see the crossings that touched THEIR boundary —
 * without being able to read the other org's unrelated activity.
 *
 * The involved orgs are the room's and the actor's, and that is enough while
 * the actor is the person the entry is about: a member joining or leaving
 * writes a row for their own org. It is not enough when the actor acts on
 * someone else. An eviction touches the evicted member's org, which need be
 * neither the room's nor the creator's, so that caller names it in `alsoOrgs`
 * and the entry reaches the org whose member lost access. The parameter only
 * adds: the room's and the actor's rows are always written, an org named twice
 * gets one row, and an org-less member gets none.
 *
 * It lives here rather than in a transport because a transport that writes its
 * own row is a transport that will one day write it for one org and not the
 * other.
 */
export function auditEntries(
  session: StoredSession,
  actor: Identity,
  action: string,
  detail: Record<string, unknown>,
  alsoOrgs: readonly (string | null)[] = []
): AuditEntry[] {
  const orgs = new Set<string | null>([session.orgId, actor.orgId, ...alsoOrgs]);
  const at = Date.now();
  return [...orgs]
    .filter((orgId): orgId is string => orgId !== null)
    .map((orgId) => ({
      at, orgId, sessionId: session.id, actorUserId: actor.userId, action, detail,
    }));
}

/**
 * Write what `auditEntries` builds, one row per org, for a caller that has no
 * store operation to commit it with.
 */
export async function audit(
  store: BellmanStore,
  session: StoredSession,
  actor: Identity,
  action: string,
  detail: Record<string, unknown>,
  alsoOrgs: readonly (string | null)[] = []
): Promise<void> {
  for (const entry of auditEntries(session, actor, action, detail, alsoOrgs)) {
    await store.appendAudit(entry);
  }
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
  const me = findMember(session, memberId, actor);
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
 */
async function gateSeat(
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
  const me = findMember(session, memberId, actor);
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
 */
export async function issueInvite(
  store: BellmanStore,
  actor: Identity,
  sessionId: string,
  memberId: string,
  role?: string,
): Promise<RoomResult<{ code: string; role: string; expiresAt: number; replacedPrevious: boolean }>> {
  const gate = await gateSeat(store, actor, sessionId, memberId, "invite");
  if (!gate.ok) return gate;
  const session = gate.value;

  const bad = unknownRole(session, role);
  if (bad) return bad;
  // Seated, not active: a room held full by a session that died must still be
  // able to mint the code that replaces it, which is the confusion #103 opens
  // with. This only counts — the seat is actually reclaimed by the
  // bellman_confirm that redeems this code, which is the one caller authorized
  // to remove anybody. The `invite` verb is not the `evict` authority. Members on
  // a socket are counted for the same reason `seatMember` will not reclaim them.
  const connected = await store.connectedMembers(session.id);
  if (seatedMembers(session, Date.now(), connected).length >= session.maxMembers) {
    return refuse(
      "conflict",
      `session is full (${session.maxMembers} members) — a new code could not be used. Wait for someone to leave, or start a swarm session.`
    );
  }

  const issuedRole = role ?? session.manifest.defaultRole;
  const previous = Boolean(session.joinCodes[issuedRole]);
  const code = renderJoinCode(issuedRole);
  const expiresAt = Date.now() + JOIN_CODE_TTL;
  if (!(await store.setJoinCode(sessionId, issuedRole, code, expiresAt))) {
    return refuse("frozen", FROZEN);
  }
  await store.appendEvent(session.id, {
    type: "invite_issued",
    fromMemberId: memberId,
    fromUserId: actor.userId,
    fromLabel: actor.label,
    payload: { role: issuedRole, expires_at: new Date(expiresAt).toISOString() },
    refId: null,
  });
  await audit(store, session, actor, "invite_issued", {
    role: issuedRole, replaced_previous: previous,
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
  // the session-TTL sweep touch the map. So presence alone is not enough, or a
  // bare revoke announces the closing of a door that had already shut by
  // itself: an event, an audit row, and over-reported roles.
  const retired = (role ? [role] : Object.keys(session.joinCodes)).filter((r) => {
    const rec = session.joinCodes[r];
    return rec !== undefined && Date.now() <= rec.expiresAt;
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
 */
export async function evictMember(
  store: BellmanStore,
  actor: Identity,
  sessionId: string,
  targetMemberId: string,
): Promise<RoomResult<{ evicted: boolean; codeRetired: string | null; sessionStatus: string }>> {
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
  // this gap cannot slip past them (#118).
  const target = session.members.find((m) => m.memberId === targetMemberId);
  if (!target) return refuse("not_found", "no member with that member_id is in this room.");
  if (target.userId === actor.userId) {
    // Names no tool and no route. This module serves every transport, and a panel
    // user cannot call an MCP tool: advice naming one is advice half the callers
    // cannot act on. An agent reading "leave the room" knows which tool does that.
    return refuse("forbidden", "you cannot evict yourself; leave the room instead.");
  }

  const outcome = await store.removeMember(sessionId, targetMemberId, {
    now: Date.now(),
    frozen: "refuse",
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
    byUserId: actor.userId,
    event: {
      type: "member_evicted",
      // No member handle to name: creator authority is on the user, and a
      // creator who has left the room still holds it. "system" is the existing
      // marker for a server-originated event; the creator is in fromUserId.
      fromMemberId: "system",
      fromUserId: actor.userId,
      fromLabel: actor.label,
      payload: { member_id: targetMemberId, label: target.label, room_role: target.roomRole },
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
    // `invite_revoked` would find half of them. The row goes to the room's org and
    // the creator's, as revokeInvite writes it, and no more: it names a role and no
    // person, so the departed member's org could not tell whom it concerned, and a
    // row an org cannot resolve to anyone is worse than none.
    retire: {
      role: target.roomRole,
      event: doorShutEvent(actor, target.roomRole),
      audit: auditEntries(session, actor, "invite_revoked", { roles: [target.roomRole] }),
    },
    audit: auditEntries(
      session, actor, "member_evicted",
      {
        // The seat and the person. member_id is per connection and only resolves
        // inside the room, so user_id is what lets an org reading its own log see
        // which of its people went; member_id stays for when one person holds two.
        //
        // No `code_retired`: whether a door shut is the store's answer, and this
        // row is built before the store gives it. The door has its own row, see
        // `retire`.
        member_id: targetMemberId, user_id: target.userId, room_role: target.roomRole,
      },
      // The evicted member's org as well. The actor here is the creator, not the
      // member, so unless that org is also the room's it would get no row.
      [target.orgId],
    ),
  });

  if (outcome.refused === "closed") return refuse("closed", "session is closed.");
  if (outcome.refused === "frozen") return refuse("frozen", FROZEN);
  if (outcome.refused === "forbidden") {
    return refuse("forbidden", "only the person who created this room can remove a member from it.");
  }
  if (outcome.refused !== null) return refuse("not_found", "session not found.");

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
  });
}
