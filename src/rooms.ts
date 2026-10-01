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
import type { AuditEntry, Identity, Member, Session } from "./types.js";
import type { BellmanStore } from "./store.js";

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
