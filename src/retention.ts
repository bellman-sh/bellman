import type { StoredSession } from "./stored-session.js";
import type { AuditEntry, SurfaceRow } from "./types.js";

// Runtime-free on purpose, for the reason CLAUDE.md gives: both stores and both test
// programs read these rules, and store-do.ts, which cannot be imported by a root test,
// is the only place the alarm that acts on them lives.

export const PURGE_HANDLER = "purge";
export const SWEEP_HANDLER = "sweep";

/**
 * When a closed room's record and bytes go (#65, D2, D6): the time a delete
 * asked for, else the end of the window stamped at creation, else never. An
 * open room is never due, whatever it carries. A row closed before the window
 * existed has no closedAt and is kept; only a delete reaches it.
 */
export function purgeDueAt(s: Pick<StoredSession, "closed" | "closedAt" | "retainAfterCloseMs" | "purgeAt">): number | null {
  if (!s.closed) return null;
  if (s.purgeAt !== null) return s.purgeAt;
  if (s.retainAfterCloseMs === null || s.closedAt === null) return null;
  return s.closedAt + s.retainAfterCloseMs;
}

/** The close-time sweep of unnamed objects (#65, D3) is due once, at the close. */
export function sweepDueAt(s: Pick<StoredSession, "closed" | "closedAt" | "blobsSwept">): number | null {
  if (!s.closed || s.blobsSwept || s.closedAt === null) return null;
  return s.closedAt;
}

/**
 * The objects under a room's prefix that no surface item names (#65, D3): what the close-time
 * sweep removes. A `file` or `image` item names one by `blob.id`; an item of any other kind names
 * none and protects nothing. An item that names an object that is not listed is a dangling
 * reference: it keeps it, a download answers 404 as it does today, and there is nothing to remove.
 */
export function unnamedObjects<T extends { id: string }>(
  listed: readonly T[], rows: readonly Pick<SurfaceRow, "blob">[],
): T[] {
  const named = new Set(rows.flatMap((row) => (row.blob ? [row.blob.id] : [])));
  return listed.filter((object) => !named.has(object.id));
}

/**
 * `blobBytes` once the sweep has freed `credited` bytes. Never below zero: a charge that threw is
 * kept in the bucket on purpose (#183) without ever having landed, so what the sweep frees can
 * outrun what the room was charged.
 */
export const creditedBlobBytes = (charged: number, credited: number): number =>
  Math.max(0, charged - credited);

/**
 * Every org the room involved, once each, in roster order: the orgs a purge or a
 * delete owes an audit entry, one per stream. The roster keeps a member who left
 * or was removed, and so does this, because their org sat in the room. A falsy
 * org names a stream nobody reads, so it is no org here (ARCHITECTURE.md, runtime
 * fact 4).
 */
export function orgsOnRoster(s: Pick<StoredSession, "members">): string[] {
  return [...new Set(s.members.map((m) => m.orgId).filter((orgId): orgId is string => Boolean(orgId)))];
}

type Room = Pick<StoredSession, "id" | "manifest">;

/** The window ran out (#65, D2): nobody asked, so the system is the actor. */
export const roomPurgedEntry = (s: Room, orgId: string, at: number): AuditEntry => ({
  at, orgId, sessionId: s.id, actorUserId: "system", action: "room_purged",
  detail: { session_id: s.id, room: s.manifest.room },
});

/** A delete asked for the purge (#65, D6): `by` is who, or null when the caller was not a person. */
export const roomDeletedEntry = (s: Room, orgId: string, by: string | null, at: number): AuditEntry => ({
  at, orgId, sessionId: s.id, actorUserId: by ?? "system", action: "room_deleted",
  detail: { session_id: s.id, room: s.manifest.room },
});
