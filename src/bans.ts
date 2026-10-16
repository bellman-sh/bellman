/**
 * Bans (abuse protections spec, section 1): an account a room's creator removed and keeps out.
 *
 * It imports nothing, so the stores, the tools and the HTTP routes can all reach these types and
 * views without one of them pulling in another's dependencies.
 */

/** How far a ban reaches: the room it was made in, or every room its creator owns. */
export type BanScope = "room" | "all";

/** An account banned from a room (spec section 1): an opaque id, the label it had there, and when. */
export interface Ban {
  banId: string;
  userId: string;
  label: string;
  at: number;
}

/** An account banned from every room a creator owns, and the room the ban was made in. */
export interface CreatorBan extends Ban {
  sessionId: string;
}

/**
 * All a banned account is told, whichever door it comes through: not who banned it, and not how far
 * the ban reaches. The message is the same for a room ban and a creator-wide one.
 */
export const BANNED = "You can't join this room.";

/**
 * `ban_` and 16 hex characters: the first sixteen of a UUID, hyphens dropped. The id names a ban and
 * nothing else. A creator lifts a ban by it and never sees the account's user id.
 */
export function newBanId(): string {
  return `ban_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

/** Oldest first, and by id among bans made at one moment, so both stores list in one order. */
export function oldestFirst(a: Ban, b: Ban): number {
  return a.at - b.at || (a.banId < b.banId ? -1 : a.banId > b.banId ? 1 : 0);
}

/** What a ban list sends a creator: never the account's user id. */
export function banView(b: Ban): { ban_id: string; label: string; at: string } {
  return { ban_id: b.banId, label: b.label, at: new Date(b.at).toISOString() };
}

/** `banView` for a creator-wide ban, with the room it was made in. */
export function creatorBanView(b: CreatorBan): { ban_id: string; label: string; at: string; session_id: string } {
  return { ...banView(b), session_id: b.sessionId };
}
