/**
 * Suspensions (abuse protections spec, section 1): an account the operator turns away from every
 * authenticated call that reads or writes the store as it (plan ruling R8).
 *
 * It imports nothing, as bans.ts does, so the stores, the Worker and the Node server can all reach it.
 */

/** What the registry keeps for a suspended account: the operator's note, which operator, and when. */
export interface Suspension {
  note: string;
  by: string;
  at: number;
}

/** All a suspended account is told, on every path that refuses it. */
export const SUSPENDED = "This account is suspended.";

/** How long an isolate keeps its answer for an account (spec D4), so a suspension or a lift lands within it. */
export const SUSPENSION_CACHE_MS = 60_000;

// ponytail: cleared whole past `max` (10,000) rather than evicted entry by entry; an LRU if one isolate ever holds that many.
export class SuspensionCache {
  private readonly answers = new Map<string, { suspended: boolean; until: number }>();

  constructor(private readonly ttlMs = SUSPENSION_CACHE_MS, private readonly max = 10_000) {}

  /** Whether `userId` is suspended, read through `read` at most once per `ttlMs` (spec D4). */
  async check(userId: string, read: () => Promise<boolean>, now = Date.now()): Promise<boolean> {
    const kept = this.answers.get(userId);
    if (kept && now < kept.until) return kept.suspended;
    const suspended = await read();
    if (this.answers.size >= this.max && !this.answers.has(userId)) this.answers.clear();
    this.answers.set(userId, { suspended, until: now + this.ttlMs });
    return suspended;
  }
}
