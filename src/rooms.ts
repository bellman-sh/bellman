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
import { JOIN_CODE_TTL, isActiveMember, type BellmanStore } from "./store.js";
import { STALE_AFTER_MS, lastSeen, presentMembers, staleMembers } from "./presence.js";

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
 */
export function seatedMembers(s: StoredSession, now: number = Date.now()): Member[] {
  return presentMembers(s.members, now);
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
 * **One call site.** `bellman_confirm`, and nothing else. An earlier shape
 * reaped from `bellman_connect` and `issueInvite` too, and that made this an
 * unauthorized removal path: `evictMember` is creator-only and outside the verb
 * set on purpose, while `bellman_connect` is reachable by anyone holding a join
 * code without joining at all, and never consumes the code — so one preview
 * call, repeatable for the code's 15 minutes, could empty a quiet 25-seat hub
 * room of every member including its creator. Seat-wanting paths that are not
 * about to seat anybody therefore only *count* with `seatedMembers`, which
 * already excludes stale members and writes nothing. The reap belongs where a
 * seat is actually being taken, by a caller holding a valid connect token,
 * behind the frozen and closed guards that path already has.
 *
 * **One seat, not every stale seat.** A joiner needs one, so exactly enough
 * are freed to seat it, longest-quiet first. Reaping all of them instead is
 * what turned a quiet hub room into a wipe: the blast radius has to be the size
 * of the request. The next joiner reaps the next one.
 *
 * **Only when the seat is contested.** A room with a spare seat reaps nobody,
 * however long they have been quiet: the joiner can have the free seat, so
 * there is no question to force. The test is `activeMembers(session).length >=
 * maxMembers` — precisely the capacity check that used to refuse — because
 * present and stale together are exactly the undeparted members.
 *
 * The removal is then final. A reaped member can still read its history and
 * must redeem a fresh code to write again, the same position an evicted one is
 * in. Making it reversible instead would mean a `pair` room could hold three
 * writers the moment the vanished peer reopened its laptop.
 *
 * Unlike an eviction this retires no join code — freeing the seat is the whole
 * point — and it never closes the room, even when it empties it. A room is
 * reaped because a joiner is waiting directly behind the call; closing it over
 * them would be the gap `closeSessionIfEmpty` exists to avoid.
 *
 * Frozen rooms are refused. `updateMember` has no frozen guard and
 * `appendEvent` returns null, so reaping a frozen room would remove members
 * permanently and *silently* — their watchers would never see the event that
 * stops them — and a freeze is meant to be reversible without costing anyone
 * their place. "A frozen room's roster cannot change" is what
 * tests/tools/freeze.test.ts pins by name.
 */
export async function reclaimStaleSeats(
  store: BellmanStore,
  session: StoredSession,
  actor: Identity,
  now: number = Date.now(),
): Promise<Member[]> {
  if (session.closed || session.frozenAt !== null) return [];

  // Re-read before deciding. The caller's copy predates any concurrent reap,
  // and a member already departed by one must not be departed again: two
  // `member_timed_out` events for one removal is what evictMember's
  // `target.leftAt !== null` early return exists to prevent.
  const fresh = (await store.getSession(session.id)) ?? session;
  if (fresh.closed || fresh.frozenAt !== null) return [];

  // Exactly the capacity check that would otherwise refuse this joiner. Below
  // it the room has a seat going spare and nobody has to lose theirs.
  const needed = activeMembers(fresh).length - fresh.maxMembers + 1;
  if (needed <= 0) return [];

  // Longest-quiet first: if only one seat has to go, it is the one whose member
  // has been gone longest.
  const victims = staleMembers(fresh.members, now)
    .sort((a, b) => lastSeen(a) - lastSeen(b))
    .slice(0, needed);

  for (const m of victims) {
    await store.updateMember(session.id, m.memberId, { leftAt: now });
    // The departure first, then the announcement, as leaveRoom and evictMember
    // both order it: the member is out from `updateMember` on, and a room that
    // froze in the gap swallowing the event must not keep the seat occupied.
    await store.appendEvent(session.id, {
      type: "member_timed_out",
      // "system" for the same reason member_evicted uses it: no member handle
      // authored this, and the member it is about is named in the payload. The
      // reaped member's own user and label go in fromUserId/fromLabel so the
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
    // `actor` is the joiner taking the seat, because the audit trail has to name
    // a real identity — but the action is `member_timed_out`, not
    // `member_evicted`, so the row says the seat timed out rather than that this
    // person removed anybody. Omitting the row entirely, which an earlier shape
    // did, left an org reconciling a lost room with a silent gap.
    await audit(
      store, fresh, actor, "member_timed_out",
      {
        member_id: m.memberId, user_id: m.userId, room_role: m.roomRole,
        last_seen_at: new Date(lastSeen(m)).toISOString(),
        seat_taken_by: actor.userId,
      },
      [m.orgId]
    );
  }
  return victims;
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
export async function audit(
  store: BellmanStore,
  session: StoredSession,
  actor: Identity,
  action: string,
  detail: Record<string, unknown>,
  alsoOrgs: readonly (string | null)[] = []
): Promise<void> {
  const orgs = new Set<string | null>([session.orgId, actor.orgId, ...alsoOrgs]);
  for (const orgId of orgs) {
    if (orgId === null) continue;
    const entry: AuditEntry = {
      at: Date.now(),
      orgId,
      sessionId: session.id,
      actorUserId: actor.userId,
      action,
      detail,
    };
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
 * the decision moved into it. The other half is `addMember` refusing a closed
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
 * Reads stay open to a member who left — history is still theirs — so a
 * departed handle is not an error here. Leaving again is a no-op — it
 * announces and audits nothing — except that it closes a room the first
 * attempt left empty and open.
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

  if (me.leftAt !== null) {
    // The early return is for not saying a departure twice, and no more than
    // that: it is not licence to skip the closing. A leave that died between
    // recording the departure and closing the room leaves it empty but open,
    // and a retry landing here is how that heals. Only the closing is restored,
    // on purpose. The announcement could be replayed safely through
    // appendEventOnce under a stable key, but this path writes it with
    // appendEvent, and the audit row has no idempotent write at all. The outbox
    // marker that would complete the repair is #59.
    return succeed({ sessionStatus: await closeIfEmpty(store, session) });
  }

  await store.updateMember(session.id, memberId, { leftAt: Date.now() });
  // The result is ignored on purpose. A frozen room swallows the announcement
  // (null) but still lets a member leave: freezing refuses sending, joining and
  // inviting, and must not trap anyone inside.
  await store.appendEvent(session.id, {
    type: "member_left",
    fromMemberId: memberId,
    fromUserId: actor.userId,
    fromLabel: actor.label,
    payload: { label: actor.label },
    refId: null,
  });

  // Before the close, not after it. The departure is a fact from updateMember
  // on, and a leave that dies at the close should still have its record: the
  // retry cannot write it, so it must not wait on a step that has nothing to do
  // with it. The order moves the failure window rather than closing it — if
  // this throws, an emptied room stays open until a retry heals it, where
  // closing first would have closed the room and lost the row. That is the
  // trade taken deliberately: a retry can restore the closing, and nothing can
  // restore the row.
  await audit(store, session, actor, "member_left", {});
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
  return succeed(session);
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
  // to remove anybody. The `invite` verb is not the `evict` authority.
  if (seatedMembers(session).length >= session.maxMembers) {
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
 * Tell the room a seat's code was retired by its creator. From "system" for the
 * reason member_evicted is: there is no member handle to name.
 */
async function announceDoorShut(
  store: BellmanStore,
  actor: Identity,
  sessionId: string,
  role: string,
): Promise<void> {
  // A null return means the room froze in the gap. The code is already retired,
  // so it is tolerated rather than unwound.
  await store.appendEvent(sessionId, {
    type: "invite_revoked",
    fromMemberId: "system",
    fromUserId: actor.userId,
    fromLabel: actor.label,
    payload: { roles: [role] },
    refId: null,
  });
}

/**
 * The room's creator removes a member.
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
 * A member who already left can still be evicted, and it is not a no-op:
 * `leaveRoom` retires no code, so their seat's code may still be live and the
 * seat free, and evicting them shuts that door. Only the removal is not said a
 * second time.
 */
export async function evictMember(
  store: BellmanStore,
  actor: Identity,
  sessionId: string,
  targetMemberId: string,
): Promise<RoomResult<{ evicted: boolean; codeRetired: string | null; sessionStatus: string }>> {
  const session = await store.getSession(sessionId);
  if (!session) return refuse("not_found", "session not found.");
  if (session.closed) return refuse("closed", "session is closed.");
  if (session.frozenAt !== null) return refuse("frozen", FROZEN);
  if (session.createdBy !== actor.userId) {
    return refuse("forbidden", "only the person who created this room can remove a member from it.");
  }

  // A direct lookup, NOT findMember: that helper requires the handle to belong
  // to the caller, which is the one thing eviction has to do differently.
  const target = session.members.find((m) => m.memberId === targetMemberId);
  if (!target) return refuse("not_found", "no member with that member_id is in this room.");
  if (target.userId === actor.userId) {
    // Names no tool and no route. This module serves every transport, and a panel
    // user cannot call an MCP tool: advice naming one is advice half the callers
    // cannot act on. An agent reading "leave the room" knows which tool does that.
    return refuse("forbidden", "you cannot evict yourself; leave the room instead.");
  }

  // A code that has expired is not a live one, though nothing prunes it (see
  // revokeInvite), so a code's presence alone does not mean the door is open.
  //
  // Reading it from the state is also what makes a repeated eviction write
  // nothing: the first one consumed the code. A consequence comes with that,
  // chosen rather than overlooked: a fresh code minted for this role between two
  // evictions of the same member is live, so the second retires it. That is the
  // over-revoke bias again, and minting once more recovers it.
  const rec = session.joinCodes[target.roomRole];
  const live = rec !== undefined && Date.now() <= rec.expiresAt;

  if (target.leftAt !== null) {
    // The early return is for not saying the removal twice, not licence to skip
    // what is still owed, and two things can be. The closing: a retry landing here
    // closes a room an interrupted eviction left empty and open. And the door:
    // leaveRoom retires no code, so a member who left on their own leaves their
    // seat's code live and the seat free, and whoever holds the code walks back in.
    // Neither says the removal again: its announcement and audit row cannot be
    // replayed safely as they are written (see leaveRoom, and #59). The door's
    // closing is new, so it is announced and audited, and it cannot repeat: it is
    // guarded by `live`, and the first closing made that false.
    if (live) {
      await store.consumeJoinCode(sessionId, target.roomRole);
      await announceDoorShut(store, actor, sessionId, target.roomRole);
      // A row of its own, where the live path below folds the same closing into
      // `member_evicted` as `code_retired`: this call writes no `member_evicted`
      // to fold it into, because the removal already happened and not saying it
      // twice is what this early return is for. So a query for `invite_revoked`
      // finds this door and not the live path's.
      //
      // As revokeInvite writes it: the room's org and the creator's, and no more.
      // The row names a role and no person, so the departed member's org could not
      // tell whom it concerned, and a row an org cannot resolve to anyone is worse
      // than none.
      await audit(store, session, actor, "invite_revoked", { roles: [target.roomRole] });
    }
    // Last, as below: whatever came after the close would be lost, because every
    // later call refuses on "closed".
    return succeed({
      evicted: true,
      codeRetired: live ? target.roomRole : null,
      sessionStatus: await closeIfEmpty(store, session),
    });
  }

  // The door shuts BEFORE the member is recorded out, so this operation never
  // leaves them out with their seat's door still open: the removal that undoes
  // itself, which is what it exists to prevent. The early return above would shut
  // it on a retry, but only once someone retries, and until then the member could
  // redeem the code and walk back in. This order fails the other way: member
  // still in, door shut, and a retry finishes the eviction. It finds the code
  // already gone, so what it records under-reports the retirement — the end state
  // is right and the record is thin. Over-revoking is recoverable by minting
  // again; under-revoking leaves a door open behind someone who believes it shut.
  if (live) await store.consumeJoinCode(sessionId, target.roomRole);

  await store.updateMember(sessionId, targetMemberId, { leftAt: Date.now() });

  // The events read in the order a person would tell it — the member went,
  // then the door shut — even though the store writes went the other way. A
  // null return means the room froze in the gap; the member is already out, so
  // it is tolerated rather than unwound.
  await store.appendEvent(sessionId, {
    type: "member_evicted",
    // No member handle to name: creator authority is on the user, and a
    // creator who has left the room still holds it. "system" is the existing
    // marker for a server-originated event; the creator is in fromUserId.
    fromMemberId: "system",
    fromUserId: actor.userId,
    fromLabel: actor.label,
    payload: { member_id: targetMemberId, label: target.label, room_role: target.roomRole },
    refId: null,
  });
  if (live) await announceDoorShut(store, actor, sessionId, target.roomRole);

  // Before the close, as in leaveRoom: the eviction is a fact from
  // updateMember on, and its record must not wait on a step unrelated to it.
  // The order moves the failure window rather than closing it — if this throws,
  // an emptied room stays open until a retry heals it, where closing first
  // would have closed the room and lost the row. That is the trade taken
  // deliberately: a retry can restore the closing, and nothing can restore the
  // row.
  await audit(
    store, session, actor, "member_evicted",
    {
      // The seat and the person. member_id is per connection and only resolves
      // inside the room, so user_id is what lets an org reading its own log see
      // which of its people went; member_id stays for when one person holds two.
      member_id: targetMemberId, user_id: target.userId,
      room_role: target.roomRole, code_retired: live,
    },
    // The evicted member's org as well. The actor here is the creator, not the
    // member, so unless that org is also the room's it would get no row.
    [target.orgId],
  );

  return succeed({
    evicted: true,
    codeRetired: live ? target.roomRole : null,
    sessionStatus: await closeIfEmpty(store, session),
  });
}
