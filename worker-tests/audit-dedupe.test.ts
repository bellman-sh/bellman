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
 * An inline drain racing an alarm hands the same row over twice at once, so
 * looking for the marker and writing it must not be separable by a second
 * delivery.
 *
 * This sees a gap wide enough for a second delivery to arrive inside it: an
 * await on another object, or a 25 ms timer, leaves eight entries here. It does
 * not see a narrower one. A zero-length timer between the look and the write
 * still passes, because the first delivery finishes before the second is
 * admitted.
 */
it("applies an entry once when the same delivery arrives concurrently", async () => {
  const audit = env.AUDIT.get(env.AUDIT.idFromName("org_mine"));

  await Promise.all(
    Array.from({ length: 8 }, () => audit.append(entry("plan_granted"), "intent-1"))
  );

  expect(await audit.recent(10)).toEqual([entry("plan_granted")]);
});

/**
 * The single write is what keeps a partial commit from stranding an intent.
 * Simulate an interruption by failing the Nth `put` one delivery makes, then
 * deliver the same intent again as the outbox would, then a later entry.
 * However far the first delivery got, the stream must end up holding each
 * entry exactly once.
 *
 * With one `put`, only N = 1 fires, and it lands nothing. A version that splits
 * the marker from the entry, or either from the sequence, has an N that lands
 * one without the other: the redelivery then skips an entry that never landed,
 * appends it a second time, or the next entry overwrites it.
 */
it.each([1, 2, 3])("holds each entry once when write %i of a delivery is interrupted", async (failAt) => {
  const audit = env.AUDIT.get(env.AUDIT.idFromName("org_mine"));

  let puts = 0;
  let failOn = failAt; // 0 once the interruption is over, when the wrapper only forwards
  await runInDurableObject(audit, async (_i: AuditDO, ctx) => {
    const storage = ctx.storage;
    const put = storage.put.bind(storage) as (...args: unknown[]) => Promise<void>;
    Object.defineProperty(storage, "put", {
      configurable: true,
      value: (...args: unknown[]) => {
        if (++puts === failOn) throw new Error("interrupted");
        return put(...args);
      },
    });
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
  expect(puts).toBeGreaterThan(0);
  expect(interrupted).toBe(puts >= failAt);

  // Redelivered as the outbox would, then a later entry with its own id.
  await audit.append(entry("plan_revoked"), "intent-1");
  await audit.append(entry("plan_granted"), "intent-2");

  expect(await audit.recent(10)).toEqual([entry("plan_revoked"), entry("plan_granted")]);
});
