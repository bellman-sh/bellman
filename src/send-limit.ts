import type { Member } from "./types.js";

/**
 * The send limit (abuse protections spec D5): how many sends may be made in a rolling minute, counted per room.
 * A member gets 30, counted per seat. A stranger gets 6, counted per account: a member who joined a public room
 * through its permanent code, recorded as `Member.via`. The hosted seat is exempt, because its writes go through
 * `appendHostEvent` and never reach the count.
 *
 * Constants in one module, and a room cannot set its own yet. The count itself is the room object's
 * (`BellmanStore.admitSend`), under the key `sendKeyFor` names. This module imports no runtime, so both stores
 * and the tests share it.
 */
export const SEND_LIMIT = 30;
export const STRANGER_SEND_LIMIT = 6;
export const SEND_WINDOW_MS = 60_000;

/** The count's answer: admitted, or refused with how long until the oldest send in the window leaves it. */
export type SendAdmission = { ok: true } | { ok: false; retryAfterMs: number };

/** How many sends a minute this member gets: a stranger's fewer, everyone else's the full limit. */
export const sendLimitFor = (m: Pick<Member, "via">): number =>
  m.via === "permanent" ? STRANGER_SEND_LIMIT : SEND_LIMIT;

/** Starts every stranger's count key. A member id is `m_` and eight characters, so it never starts this way. */
export const STRANGER_KEY_PREFIX = "user:";

/**
 * What this member's sends are counted under, within the room: the `key` of `BellmanStore.admitSend`.
 *
 * A stranger's is the account's. Every confirm mints a handle, and nothing limits how many handles an account
 * takes through a permanent code, so a count kept by handle would start at zero for each one a script takes, and
 * again after a leave and a rejoin. Anyone else's is the seat's, so one account's several agents in a busy swarm
 * do not share a single 30.
 */
export const sendKeyFor = (m: Pick<Member, "via" | "userId" | "memberId">): string =>
  m.via === "permanent" ? `${STRANGER_KEY_PREFIX}${m.userId}` : m.memberId;

/**
 * The rolling minute (spec D5), pure so both stores count alike: the times still inside the window, this one
 * added when admitted; or, at the limit, the times unchanged and how long until the oldest leaves the window.
 *
 * A time is inside the window while `now - t` is under `SEND_WINDOW_MS`, so a send stops counting exactly a
 * minute after it was made and `retryAfterMs` is always positive. The times stay in send order.
 */
export function admitAt(
  times: readonly number[],
  limit: number,
  now: number,
): { times: number[]; retryAfterMs: number | null } {
  const kept = times.filter((t) => now - t < SEND_WINDOW_MS);
  if (kept.length >= limit) return { times: kept, retryAfterMs: kept[0] + SEND_WINDOW_MS - now };
  return { times: [...kept, now], retryAfterMs: null };
}
