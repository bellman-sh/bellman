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
import type { AuditEntry, Identity, Member, Session, Verb } from "./types.js";
import { renderJoinCode } from "./codes.js";
import { denyVerb } from "./roles.js";
import { JOIN_CODE_TTL, type BellmanStore } from "./store.js";

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Why an operation refused, in a form a transport can switch on.
 *
 * A route picks 403 from `"forbidden"` rather than pattern-matching English,
 * and a route that forgets a case fails to compile rather than returning 500.
 */
export type RoomFailure = "not_found" | "closed" | "frozen" | "forbidden" | "conflict";

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

export function activeMembers(s: Session): Member[] {
  return s.members.filter((m) => m.leftAt === null);
}

export function findMember(s: Session, memberId: string, identity: Identity): Member | undefined {
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
  session: Session,
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
 */
async function closeIfEmpty(store: BellmanStore, session: Session): Promise<string> {
  // Re-read: `session` predates whatever the caller has just done to it.
  const now = (await store.getSession(session.id)) ?? session;
  const empty = activeMembers(now).length === 0;
  if (empty) await store.closeSession(session.id);

  // Closed wins over frozen: an empty room is over either way, and telling
  // someone their room is frozen when it has no members left to thaw for
  // would point them at paying to fix something payment will not fix.
  return now.closed || empty ? "closed" : sessionStatus(now);
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
): Promise<RoomResult<Session>> {
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
 * One check for both operations, because the old handler made it once, before
 * the issue/revoke split. Revoke is where a copy that drifted would hurt: a
 * mistyped role retires nothing, so without the check it answers an empty
 * success, and an open door reads as shut.
 */
function unknownRole(session: Session, role: string | undefined): RoomResult<never> | null {
  if (role === undefined || Object.hasOwn(session.manifest.roles, role)) return null;
  return refuse(
    "not_found",
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
  if (activeMembers(session).length >= session.maxMembers) {
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
    return refuse("forbidden", "you cannot evict yourself — use bellman_leave.");
  }

  if (target.leftAt !== null) {
    // The same contract as leaveRoom's early return: it is for not saying the
    // removal twice, not licence to skip the closing. A retry landing here
    // closes a room an interrupted eviction left empty and open. See
    // leaveRoom for why only the closing is restored, and #59 for the outbox
    // marker that would complete it.
    return succeed({
      evicted: true,
      codeRetired: null,
      sessionStatus: await closeIfEmpty(store, session),
    });
  }

  // The door shuts BEFORE the member is recorded out, and that order is the
  // point. `leftAt` is the commit point: once it is set, every retry takes the
  // early return above, so anything not done by then is never done. Retiring
  // the code afterwards would mean a crash in between leaves the member out
  // with their seat's door still open — the removal that undoes itself, which
  // is the thing this operation exists to prevent, and nothing could heal it.
  // This order fails the other way: member still in, door shut, and a retry
  // finishes the eviction. It finds the code already gone, so what it records
  // under-reports the retirement — the end state is right and the record is
  // thin. Over-revoking is recoverable by minting again; under-revoking is not.
  const rec = session.joinCodes[target.roomRole];
  const live = rec !== undefined && Date.now() <= rec.expiresAt;
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
  if (live) {
    await store.appendEvent(sessionId, {
      type: "invite_revoked",
      fromMemberId: "system",
      fromUserId: actor.userId,
      fromLabel: actor.label,
      payload: { roles: [target.roomRole] },
      refId: null,
    });
  }

  // Before the close, as in leaveRoom: the eviction is a fact from
  // updateMember on, and its record must not wait on a step unrelated to it.
  // The order moves the failure window rather than closing it — if this throws,
  // an emptied room stays open until a retry heals it, where closing first
  // would have closed the room and lost the row. That is the trade taken
  // deliberately: a retry can restore the closing, and nothing can restore the
  // row.
  //
  // The evicted member's org is named as well. The actor here is the creator, not
  // the member, so unless that org is also the room's it would get no row.
  //
  // The detail names the person as well as the seat. member_id is per connection
  // and only resolves inside the room, so an org reading its own log needs
  // user_id to see which of its people was removed. member_id stays, because it
  // says which seat went when one person holds two.
  await audit(store, session, actor, "member_evicted", {
    member_id: targetMemberId, user_id: target.userId,
    room_role: target.roomRole, code_retired: live,
  }, [target.orgId]);

  return succeed({
    evicted: true,
    codeRetired: live ? target.roomRole : null,
    sessionStatus: await closeIfEmpty(store, session),
  });
}
