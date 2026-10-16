import type { Member } from "./types.js";

/**
 * The send limit (abuse protections spec D5): how many sends a member may make in a rolling minute, counted per
 * member and per room. A member gets 30. A stranger gets 6: a member who joined a public room through its
 * permanent code, recorded as `Member.via`. The hosted seat is exempt, because its writes go through
 * `appendHostEvent` and never reach the count.
 *
 * Constants in one module, and a room cannot set its own yet. The count itself lives in the room object's
 * memory (`BellmanStore.admitSend`). This module imports no runtime, so both stores and the tests share it.
 */
export const SEND_LIMIT = 30;
export const STRANGER_SEND_LIMIT = 6;
export const SEND_WINDOW_MS = 60_000;

/** The count's answer: admitted, or refused with how long until the oldest send in the window leaves it. */
export type SendAdmission = { ok: true } | { ok: false; retryAfterMs: number };

/** How many sends a minute this member gets: a stranger's fewer, everyone else's the full limit. */
export const sendLimitFor = (m: Pick<Member, "via">): number =>
  m.via === "permanent" ? STRANGER_SEND_LIMIT : SEND_LIMIT;

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
