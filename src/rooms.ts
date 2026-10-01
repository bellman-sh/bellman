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
 * It lives here rather than in a transport because a transport that writes its
 * own row is a transport that will one day write it for one org and not the
 * other.
 */
export async function audit(
  store: BellmanStore,
  session: Session,
  actor: Identity,
  action: string,
  detail: Record<string, unknown>
): Promise<void> {
  const orgs = new Set<string | null>([session.orgId, actor.orgId]);
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
 * room if so, and returns the status to report. Both successful paths through
 * leaveRoom end here.
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
  // with it.
  await audit(store, session, actor, "member_left", {});
  return succeed({ sessionStatus: await closeIfEmpty(store, session) });
}

/**
 * The preamble every verb-gated operation shares: the room is live, it is not
 * frozen, the handle is the caller's and still in the room, and the seat holds
 * the verb.
 *
 * `leaveRoom` does not use it. Leaving needs no verb, and it must work on a
 * closed room so a member can tidy up after one.
 */
async function gateSeat(
  store: BellmanStore,
  actor: Identity,
  sessionId: string,
  memberId: string,
  verb: Verb,
): Promise<RoomResult<{ session: Session; me: Member }>> {
  const session = await store.getSession(sessionId);
  // Two branches, not one, and the reason text is identical on purpose. The
  // sentence a caller reads is unchanged from the old handler; the CODE is what
  // a future HTTP route switches on, and answering a closed room with
  // "not_found" here while evictMember answers "closed" would map one condition
  // to two statuses.
  if (!session) return refuse("not_found", "session not found or closed.");
  if (session.closed) return refuse("closed", "session not found or closed.");
  if (session.frozenAt !== null) return refuse("frozen", FROZEN);
  const me = findMember(session, memberId, actor);
  if (!me || me.leftAt !== null) {
    return refuse("forbidden", "member_id is not yours or has left the session.");
  }
  const denial = denyVerb(session, me, verb);
  if (denial) return refuse("forbidden", denial);
  return succeed({ session, me });
}

/** Every name the manifest declares, for the sentence a bad role gets back. */
function noSuchRole(session: Session, role: string): RoomResult<never> {
  return refuse(
    "not_found",
    `this room declares no role "${role}" (it declares: ${Object.keys(session.manifest.roles).join(", ")}).`
  );
}

/**
 * Mint a fresh code for a seat. Issuing for a role RETIRES that role's previous
 * code and leaves every other role's alone.
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
  const { session } = gate.value;

  if (role !== undefined && !Object.hasOwn(session.manifest.roles, role)) {
    return noSuchRole(session, role);
  }
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
  const { session } = gate.value;

  if (role !== undefined && !Object.hasOwn(session.manifest.roles, role)) {
    return noSuchRole(session, role);
  }

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
