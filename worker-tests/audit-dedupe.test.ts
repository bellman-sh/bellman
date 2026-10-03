import { it, expect, afterEach } from "vitest";
import { env, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import type { AuditDO } from "../src/store-do.js";
import type { AuditEntry } from "../src/types.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

const entry = (action: string): AuditEntry => ({
  at: 1_000, orgId: "org_mine", sessionId: "grant:github:4242",
  actorUserId: "stripe", action, detail: { key: "github:4242" },
});

it("applies an entry once however many times it is delivered", async () => {
  const audit = env.AUDIT.get(env.AUDIT.idFromName("org_mine"));

  await audit.append(entry("plan_granted"), "intent-1");
  await audit.append(entry("plan_granted"), "intent-1");
  await audit.append(entry("plan_granted"), "intent-1");

  // Exact match, not a count: a length check alone would also pass against an
  // append that silently wrote nothing at all.
  expect(await audit.recent(10)).toEqual([entry("plan_granted")]);
});

it("keeps entries that carry different intent ids", async () => {
  const audit = env.AUDIT.get(env.AUDIT.idFromName("org_mine"));

  await audit.append(entry("plan_revoked"), "intent-1");
  await audit.append(entry("plan_granted"), "intent-2");

  expect(await audit.recent(10)).toEqual([entry("plan_revoked"), entry("plan_granted")]);
});

it("still appends when no intent id is given", async () => {
  const audit = env.AUDIT.get(env.AUDIT.idFromName("org_mine"));

  await audit.append(entry("plan_granted"));
  await audit.append(entry("plan_granted"));

  expect(await audit.recent(10)).toEqual([entry("plan_granted"), entry("plan_granted")]);
});

/**
 * Hooks for putting something into a delivery that the code under test does not.
 * They go on the object's own storage and on every transaction it opens, so they
 * see a delivery whichever of the two it reads and writes through. They live on
 * that instance, and the abort in afterEach discards them.
 */
type Hooks = {
  /** Runs before every `put`. Throw to interrupt the delivery at that write. */
  onWrite?: () => void;
  /** Awaited when a read of a delivery marker finds nothing, before the caller is told so. */
  gapAfterLook?: () => Promise<void>;
};

const hook = (audit: DurableObjectStub<AuditDO>, hooks: Hooks) =>
  runInDurableObject(audit, async (_i: AuditDO, ctx) => {
    type Call = (...args: unknown[]) => Promise<unknown>;
    const wrap = (store: DurableObjectStorage | DurableObjectTransaction) => {
      const { get, put } = store as unknown as Record<"get" | "put", Call>;
      const read = get.bind(store);
      const write = put.bind(store);
      Object.defineProperty(store, "put", {
        configurable: true,
        value: (...args: unknown[]) => {
          hooks.onWrite?.();
          return write(...args);
        },
      });
      Object.defineProperty(store, "get", {
        configurable: true,
        value: async (...args: unknown[]) => {
          const found = await read(...args);
          if (found === undefined && String(args[0]).startsWith("d:")) await hooks.gapAfterLook?.();
          return found;
        },
      });
    };

    const storage = ctx.storage;
    wrap(storage);
    const { transaction } = storage as unknown as { transaction: Call };
    const open = transaction.bind(storage);
    Object.defineProperty(storage, "transaction", {
      configurable: true,
      value: (closure: (txn: DurableObjectTransaction) => Promise<unknown>) =>
        open((txn: DurableObjectTransaction) => {
          wrap(txn);
          return closure(txn);
        }),
    });
  });

/**
 * An inline drain racing an alarm hands the same row over twice at once, so
 * looking for the marker and writing it must not be separable by a second
 * delivery.
 *
 * With a gap, every delivery that finds no marker waits before it goes on. That
 * is the edit this guards against: a timer, or a call to another object, between
 * the look and the write, which opens the input gate and lets a second delivery
 * in before the first has written. Eight arrive together, and the entry must
 * still land once.
 */
it.each([0, 25])(
  "applies an entry once when the same delivery arrives concurrently, %i ms between the look and the write",
  async (gapMs) => {
    const audit = env.AUDIT.get(env.AUDIT.idFromName("org_mine"));

    let gaps = 0;
    if (gapMs > 0) {
      await hook(audit, {
        gapAfterLook: async () => {
          gaps++;
          await new Promise((resolve) => setTimeout(resolve, gapMs));
        },
      });
    }

    await Promise.all(
      Array.from({ length: 8 }, () => audit.append(entry("plan_granted"), "intent-1"))
    );

    // A gap that never ran proves nothing: the delivery may have stopped looking
    // for the marker where the hook is, or stopped looking at all.
    expect(gaps > 0).toBe(gapMs > 0);
    expect(await audit.recent(10)).toEqual([entry("plan_granted")]);
  }
);

/**
 * A delivery that stops part-way must leave nothing a redelivery mishandles.
 * Simulate the stop by failing the Nth write one delivery makes, through the
 * object's storage or through its transaction, then deliver the same intent
 * again as the outbox would, then a later entry. However far the first delivery
 * got, the stream must end up holding each entry exactly once.
 *
 * Inside the transaction a failed write rolls everything back, so the delivery's
 * one write (N = 1) lands nothing and a later N never fires. The cases that fire
 * are a write made outside the transaction, which is a commit of its own: the
 * marker, the entry or the sequence landing without the others. The redelivery
 * then skips an entry that never landed, appends it a second time, or the next
 * entry overwrites it.
 */
it.each([1, 2, 3])("holds each entry once when write %i of a delivery is interrupted", async (failAt) => {
  const audit = env.AUDIT.get(env.AUDIT.idFromName("org_mine"));

  let writes = 0;
  let failOn = failAt; // 0 once the interruption is over, when the hook only counts
  await hook(audit, {
    onWrite: () => {
      if (++writes === failOn) throw new Error("interrupted");
    },
  });

  // A failed write has to reach the caller as a failed delivery: the outbox
  // deletes its row on success, so a swallowed failure is never redelivered.
  const interrupted = await audit.append(entry("plan_revoked"), "intent-1").then(
    () => false,
    (err: unknown) => {
      if (!String(err).includes("interrupted")) throw err;
      return true;
    }
  );
  failOn = 0;
  // Every delivery makes a write. Seeing none means the interruption never sat
  // in front of `append`, or `append` wrote nothing; either way what follows
  // proves nothing.
  expect(writes).toBeGreaterThan(0);
  expect(interrupted).toBe(writes >= failAt);

  // Redelivered as the outbox would, then a later entry with its own id.
  await audit.append(entry("plan_revoked"), "intent-1");
  await audit.append(entry("plan_granted"), "intent-2");

  expect(await audit.recent(10)).toEqual([entry("plan_revoked"), entry("plan_granted")]);
});
