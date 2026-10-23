/** Outside callers (A2A) of a public room: the limits. The task row's type is `OutsideTask`, in types.ts. */

/** Tasks one caller may hold open in one room. */
export const MAX_OPEN_OUTSIDE_TASKS = 3;
/** How long a task lives with no activity: seven days. */
export const OUTSIDE_TASK_TTL_MS = 7 * 24 * 60 * 60_000;
/** How long a seat may stay silent on an outside question before the question goes to the members. */
export const SEAT_SILENCE_MS = 10 * 60_000;
/** Outside questions a seat answers per day. */
export const SEAT_OUTSIDE_DAILY_CAP = 20;
