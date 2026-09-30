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

/** The handler name the outbox schedules itself under. */
export const OUTBOX_HANDLER = "outbox";

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

export const OUTBOX_PREFIX = "ob:";
/**
 * Deliberately outside OUTBOX_PREFIX. A counter inside the prefix it tracks is
 * listed by its own drain, which hands a bare number to deliver() as though it
 * were a row. The same trap is commented for the OAuth purge cursor in
 * src/oauth/store.ts.
 */
export const OUTBOX_SEQ = "ob_seq";

const SEQ_PAD = 12;
export const outboxKey = (seq: number): string =>
  `${OUTBOX_PREFIX}${String(seq).padStart(SEQ_PAD, "0")}`;

/** What a caller asks to have delivered. */
export interface OutboxIntent {
  /** Stable for this row, so a redelivery can be recognised downstream. */
  id: string;
  kind: string;
  payload: unknown;
}

/** An intent as stored, with its delivery attempts. */
export interface OutboxRow extends OutboxIntent {
  attempts: number;
}

/** The slice of Durable Object storage the outbox needs. */
export interface OutboxStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(entries: Record<string, T>): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  setAlarm(at: number): Promise<void>;
}

/**
 * The storage rows one enqueue adds, for the caller to fold into its OWN
 * transaction alongside the mutation.
 *
 * Returning rows rather than writing them is the whole design: the mutation and
 * the intent to follow it up commit together or neither does. A separate write
 * here would reopen the window this module exists to close.
 */
export function enqueueRows(
  nextSeq: number,
  intents: OutboxIntent[]
): Record<string, unknown> {
  if (intents.length === 0) return {};
  const rows: Record<string, unknown> = {};
  intents.forEach((intent, i) => {
    rows[outboxKey(nextSeq + i)] = { ...intent, attempts: 0 } satisfies OutboxRow;
  });
  rows[OUTBOX_SEQ] = nextSeq + intents.length - 1;
  return rows;
}

/** 1s doubling to a five-minute cap. */
export const BACKOFF_CAP_MS = 300_000;
export function backoffMs(attempts: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempts - 1), BACKOFF_CAP_MS);
}

/** From this attempt on, every failure is logged. */
export const NOISY_AFTER = 5;

/**
 * Deliver queued rows in key order, head first.
 *
 * Returns when to wake again, or null when the queue is empty. A failing head
 * blocks the rows behind it on purpose: these carry an audit stream and a join
 * code index, and reordering around a stuck entry is worse than stalling.
 * Nothing is ever dropped — a permanently failing downstream object is an
 * outage, and it gets logged rather than discarded.
 */
export async function drain(
  storage: OutboxStorage,
  deliver: (row: OutboxRow) => Promise<void>,
  now: number
): Promise<number | null> {
  const rows = await storage.list<OutboxRow>({ prefix: OUTBOX_PREFIX });
  for (const [key, row] of rows) {
    try {
      await deliver(row);
      await storage.delete(key);
    } catch (err) {
      const attempts = row.attempts + 1;
      await storage.put({ [key]: { ...row, attempts } });
      if (attempts >= NOISY_AFTER) {
        console.error(`outbox: ${row.kind} ${row.id} failed ${attempts} times`, err);
      }
      return now + backoffMs(attempts);
    }
  }
  return null;
}

/**
 * The per-object half of the outbox: what a Durable Object needs in order to
 * own a queue, without every such object re-deriving it.
 *
 * Two objects use one of these each. They differ only in what they deliver and
 * in whether they have due times they compute rather than store, so both are
 * constructor arguments. Everything else — the storage rows, the FIFO drain,
 * which handler the single alarm currently points at — is identical, and a
 * second copy of it is a second place for the two to drift apart.
 */
export class OutboxDriver {
  /**
   * @param storage the object's storage, narrowed to what the outbox touches
   * @param deliver what one row means for this object; throwing leaves the row
   *                queued and blocks the ones behind it, which is intended
   * @param derivedDue due times the object computes rather than stores, keyed by
   *                handler name. SessionDO returns its session TTL here so that
   *                sessions written before named alarms still expire; an object
   *                with nothing derived returns an empty map.
   */
  constructor(
    private storage: OutboxStorage,
    private deliver: (row: OutboxRow) => Promise<void>,
    private derivedDue: () => Promise<Map<string, number>> = async () => new Map()
  ) {}

  /**
   * Rows for the caller to fold into ITS OWN transaction, alongside whatever
   * mutation owes them.
   *
   * Returned rather than written, and that is the point of this module: the
   * mutation and the intent to follow it up commit together or neither does. A
   * separate write here would reopen the window the outbox exists to close.
   * `txn` is the caller's transaction, so the sequence number is read inside it
   * too and two concurrent enqueues cannot pick the same one.
   *
   * An empty `intents` returns {}, so a refused mutation queues nothing.
   */
  async enqueue(
    txn: { get<T>(key: string): Promise<T | undefined> },
    intents: OutboxIntent[]
  ): Promise<Record<string, unknown>> {
    if (intents.length === 0) return {};
    const nextSeq = ((await txn.get<number>(OUTBOX_SEQ)) ?? -1) + 1;
    const at = Date.now();
    // Arm inside the caller's transaction, not after it.
    //
    // This is the one write this method performs rather than returns, and it
    // has to be: a row that commits with nothing scheduled to read it is the
    // window this module exists to close. RegistryDO has no other alarm, so
    // nothing would ever come back for it. setAlarm called inside a
    // transaction closure commits with that transaction — probed against
    // workerd, and recorded in Task 1 of
    // docs/superpowers/plans/2026-09-29-cross-object-atomicity.md.
    //
    // The earliest due time wins, so arming for the queue cannot push back a
    // session TTL that was already closer.
    await this.storage.setAlarm(Math.min(at, ...(await this.allDue()).values()));
    return { ...enqueueRows(nextSeq, intents), [dueKey(OUTBOX_HANDLER)]: at };
  }

  /**
   * Try to clear the queue now.
   *
   * Called straight after the transaction commits. Without it a join code would
   * not resolve until the alarm fired, so handing someone a code right after
   * creating a room would fail. The alarm is the backstop, not the path.
   */
  async deliverNow(): Promise<void> {
    const next = await drain(this.storage, this.deliver, Date.now());
    if (next === null) {
      await this.storage.delete(dueKey(OUTBOX_HANDLER));
      return;
    }
    await this.storage.put({ [dueKey(OUTBOX_HANDLER)]: next });
    await this.reArm();
  }

  /** Every due time this object knows: stored rows over derived ones. */
  async allDue(): Promise<Map<string, number>> {
    return mergeDue(
      await this.storage.list<number>({ prefix: DUE_PREFIX }),
      await this.derivedDue()
    );
  }

  /** Which handlers are due now, in name order. */
  async dueNow(now = Date.now()): Promise<string[]> {
    return dueNames(await this.allDue(), now);
  }

  /** Point the object's single alarm at whichever handler is soonest. */
  async reArm(): Promise<void> {
    const next = earliestDue((await this.allDue()).values());
    if (next !== null) await this.storage.setAlarm(next);
  }
}
