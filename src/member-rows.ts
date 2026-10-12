/**
 * A room's members as rows of their own beside its record (ADR 0019): the keys, the record a
 * session is stored as, the rows a write owes, and the move of an older room's members out of
 * its record. The Durable Objects store is the only one that keeps rows.
 *
 * Not in store-do.ts, for the reason CLAUDE.md gives for src/oauth/storage.ts: that module
 * imports `cloudflare:workers`, and the tests that seed a room's storage by hand build its rows
 * here, through the same functions the object writes them with.
 */
import type { ArrivingMember, Brief, Member } from "./types.js";
import { creatorOf, isActiveMember, seatInOrder, type Seating } from "./store.js";
import { orgsOnRoster } from "./retention.js";
import { hydrateStoredSession, type StoredSession } from "./stored-session.js";

/** The most keys one storage call reads or writes. */
export const KEYS_PER_CALL = 128;

/** One row per member, in the room or gone from it (D1). */
export const MEMBER_PREFIX = "mb:";
export const memberKey = (memberId: string): string => `${MEMBER_PREFIX}${memberId}`;
/**
 * A person's handles, one row each, the member id its value (D1). The user segment is
 * percent-encoded, so an id that begins another's (`u_a` and `u_a:b`) cannot list its rows.
 */
export const USER_PREFIX = "mu:";
export const userPrefix = (userId: string): string => `${USER_PREFIX}${encodeURIComponent(userId)}:`;
export const userKey = (userId: string, memberId: string): string => `${userPrefix(userId)}${memberId}`;
/** The person a handle's index row names, read back from its key. */
export const userOfKey = (key: string): string =>
  decodeURIComponent(key.slice(USER_PREFIX.length, key.indexOf(":", USER_PREFIX.length)));
/** A label's public number (D6), a row per label: the key is the whole label, so no prefix is listed. */
export const labelKey = (label: string): string => `lb:${label}`;
/** One row per member's brief (ADR 0018). */
export const BRIEF_PREFIX = "bf:";
export const briefKey = (memberId: string): string => `bf:${memberId}`;

/** What rows are read through: the object's storage, or a transaction it holds. */
export interface RowReader {
  get<T>(key: string): Promise<T | undefined>;
  get<T>(keys: string[]): Promise<Map<string, T>>;
}

/** What rows are written through, the same two. */
export interface RowWriter {
  put<T>(entries: Record<string, T>): Promise<void>;
}

/** The rows with these keys, at most KEYS_PER_CALL a read. A key with no row is left out. */
export async function getRows<T>(from: RowReader, keys: readonly string[]): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  for (let i = 0; i < keys.length; i += KEYS_PER_CALL) {
    for (const [key, row] of await from.get<T>(keys.slice(i, i + KEYS_PER_CALL))) out.set(key, row);
  }
  return out;
}

/** Rows put at most KEYS_PER_CALL a call, through the transaction the caller writes everything else in. */
export async function putRows(to: RowWriter, rows: Record<string, unknown>): Promise<void> {
  const entries = Object.entries(rows);
  for (let i = 0; i < entries.length; i += KEYS_PER_CALL) {
    await to.put(Object.fromEntries(entries.slice(i, i + KEYS_PER_CALL)));
  }
}

/** The members in the room now, read by the ids the record keeps for them, in that order (D2). */
export async function loadPresent(from: RowReader, present: readonly string[]): Promise<Member[]> {
  const rows = await getRows<Member>(from, present.map(memberKey));
  return present.flatMap((id) => rows.get(memberKey(id)) ?? []);
}

/** The record as it is stored (D2): the session without its members, and the ids of those in the room now. */
export type StoredRecord = Omit<StoredSession, "members"> & { present: string[] };

/** The record `s` is stored as: its present members' ids in join order, and no members. */
export function recordOf(s: StoredSession): StoredRecord {
  const { members, ...rest } = s;
  return { ...rest, present: members.filter(isActiveMember).sort((a, b) => a.seq - b.seq).map((m) => m.memberId) };
}

/**
 * The rows a write of `next` owes (D4): the row of each member `next` holds that `read` did
 * not, and the record when anything on it changed. Every write rebuilds a member array by
 * replacing the members that change and keeping the others, so a member kept is the same
 * object, and identity says which rows to write. A member `read` did not hold at all, one who
 * has left and was read by id, is written the same way. The record's fields are compared the
 * same way, so a write that changes members alone, a stamp or a report, writes their rows and
 * not the record. `read` is undefined for a room being created, which writes everything.
 *
 * A member `read` held that `next` does not would leave the room with no departure on its row,
 * so that write is refused: a member goes by `leftAt`, never by being left out.
 */
export function memberRows(read: StoredSession | undefined, next: StoredSession): Record<string, unknown> {
  const kept = new Set(next.members.map((m) => m.memberId));
  const dropped = read?.members.find((m) => !kept.has(m.memberId));
  if (dropped) throw new Error(`a write left ${dropped.memberId} off the roster instead of recording it out`);
  const held = new Set(read?.members);
  const rows: Record<string, unknown> = {};
  for (const m of next.members) if (!held.has(m)) rows[memberKey(m.memberId)] = m;
  const record = recordOf(next);
  if (!read || recordChanged(read, next, record.present)) rows.session = record;
  return rows;
}

function recordChanged(read: StoredSession, next: StoredSession, present: readonly string[]): boolean {
  const was = read.members.map((m) => m.memberId);
  if (was.length !== present.length || was.some((id, i) => id !== present[i])) return true;
  const a = read as unknown as Record<string, unknown>;
  const b = next as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key !== "members" && a[key] !== b[key]) return true;
  }
  return false;
}

/**
 * The rows a seating owes besides the members' own (D1, D6): each person's index row, the
 * number of each label seated for the first time, and each brief (ADR 0018).
 */
export function seatRows(
  seat: { members: readonly Member[]; briefs: Record<string, Brief>; numbered: ReadonlyMap<string, number> },
): Record<string, unknown> {
  const rows: Record<string, unknown> = {};
  for (const m of seat.members) rows[userKey(m.userId, m.memberId)] = m.memberId;
  for (const [label, n] of seat.numbered) rows[labelKey(label)] = n;
  for (const [memberId, brief] of Object.entries(seat.briefs)) rows[briefKey(memberId)] = brief;
  return rows;
}

/**
 * The room with one more member seated after `members`, and the rows the seat owes besides the
 * room's own: `seatInOrder` gives it the next `seq` and its label's number, the one the room gave
 * that label before (`known`, read from its `lb:` row) or the next, and its org joins `orgs`.
 * `members` is the roster the seat goes after, which a seating that reclaimed seats has changed.
 */
export function seated(
  s: StoredSession, members: readonly Member[], arriving: ArrivingMember, known: number | undefined,
): { room: StoredSession; rows: Record<string, unknown> } {
  const seat = seatInOrder([arriving], { memberSeq: s.memberSeq ?? 0, labelSeq: s.labelSeq ?? 0 }, () => known);
  const [m] = seat.members;
  const orgs = m.orgId && !s.orgs.includes(m.orgId) ? [...s.orgs, m.orgId] : s.orgs;
  return {
    room: { ...s, members: [...members, m], memberSeq: seat.memberSeq, labelSeq: seat.labelSeq, orgs },
    rows: seatRows(seat),
  };
}

/**
 * The rows an older room's record moves into (D5), or null for a record that holds no members:
 * every record written since, a room that is not there, and a record the gate reads as gone,
 * which nothing rewrites. Every member becomes a row, numbered in the order the record held
 * them, which is the order they joined in, and each label by its first seat, as a public read
 * numbered them. A brief still inline moves to its own row (ADR 0018). The record keeps the ids
 * of those in the room, its creator and every org that sat in it.
 */
export function legacyRows(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { members?: unknown }).members)) return null;
  const s = hydrateStoredSession(raw);
  if (!s) return null;
  const seat = seatInOrder(s.members as Seating[], { memberSeq: 0, labelSeq: 0 });
  // No room Bellman created lacks its creator. One that does keeps who made it, and no seat.
  const creator = seat.members.length > 0
    ? creatorOf(seat.members[0])
    : { memberId: "", userId: s.createdBy, label: "", joinedAt: 0 };
  const room: StoredSession = {
    ...s, members: seat.members, creator, orgs: orgsOnRoster(seat), memberSeq: seat.memberSeq, labelSeq: seat.labelSeq,
  };
  return { ...memberRows(undefined, room), ...seatRows(seat) };
}
