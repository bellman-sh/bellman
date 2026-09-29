/**
 * Durable delivery between Durable Objects, and the named alarms it needs.
 *
 * A Durable Object's input gate covers one invocation; nothing spans two. An
 * operation that mutates one object and must write to another therefore has a
 * window in the middle, and losing the second write loses it permanently —
 * there is no record anywhere that it was owed. The fix is to persist the
 * intent in the SAME transaction as the mutation, then deliver it.
 *
 * Runtime-free on purpose, for the reason CLAUDE.md gives: store-do.ts imports
 * `cloudflare:workers`, so no vitest test can reach inside it. The key layout,
 * FIFO order and backoff are the parts worth testing, so they live here.
 */

export const DUE_PREFIX = "due:";

/** One alarm per object, so every handler that wants one takes a name. */
export const dueKey = (name: string): string => `${DUE_PREFIX}${name}`;

/** The earliest of a set of due times, or null when nothing is scheduled. */
export function earliestDue(times: Iterable<number>): number | null {
  let best: number | null = null;
  for (const at of times) if (best === null || at < best) best = at;
  return best;
}

/**
 * Which handlers are due at `now`, in name order so a drain is deterministic.
 *
 * Inclusive: an alarm fires AT its due time. An exclusive comparison would
 * skip the handler at that instant, and re-arming to `earliestDue` would set
 * the alarm to the same instant again, so it spins until the clock moves on.
 */
export function dueNames(due: Map<string, number>, now: number): string[] {
  return [...due]
    .filter(([, at]) => at <= now)
    .map(([name]) => name)
    .sort();
}

/**
 * Every due time an object knows: the `due:` rows it stored, over the ones it
 * derives from state it already holds.
 *
 * Stored wins so a handler can reschedule itself past a derived default.
 */
export function mergeDue(
  rows: Map<string, number>,
  derived: Map<string, number>
): Map<string, number> {
  const out = new Map(derived);
  for (const [key, at] of rows) out.set(key.slice(DUE_PREFIX.length), at);
  return out;
}
