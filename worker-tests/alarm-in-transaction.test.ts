/**
 * ARCHITECTURE.md §9, first runtime fact: `setAlarm` called inside a
 * `ctx.storage.transaction()` closure commits with that transaction, and is discarded if
 * the closure throws.
 *
 * Everything the outbox does rests on it. OutboxDriver.enqueue arms the alarm from inside
 * the caller's closure, so that a row never commits with nothing scheduled to deliver it,
 * and a refused or failed mutation leaves the alarm where it was. RegistryDO has no other
 * alarm to come back for a row that was left behind. This file holds the fact on its own,
 * on raw storage, with none of Bellman's code in the way.
 *
 * Other tests reach it through the outbox: join-code-outbox.test.ts checks that a write
 * which fails puts the alarm back, and that an alarm armed by a commit survives an abort.
 * When one of those fails the symptom is a join code that does not resolve, and nothing
 * says the runtime changed. If a test HERE fails, the runtime no longer behaves the way
 * §9 and the outbox assume, and the outbox's arming is unsound. Do not fix the test.
 *
 * What it can and cannot see. It sees outcomes: after a commit the alarm survives a
 * teardown, and after a throw it is gone and the alarm that was armed before is back.
 * It cannot stop a commit halfway, so it pins the outcomes and not the instant.
 *
 * Each test arms an alarm first, as a session's TTL is in production. That makes the
 * outcomes three different readings: the closure's alarm, the earlier alarm, or none. A
 * commit must leave the closure's. A throw must leave the earlier one, not the closure's
 * (the arm leaked) and not none (the throw cleared an alarm it had no business touching).
 *
 * Each reads the result back twice: on the instance that ran the closure, and, after
 * abortAllDurableObjects(), on a new one. The marker proves the second read is a new
 * instance, so it can only see what reached durable storage.
 */
import { it, expect, afterEach } from "vitest";
import { env, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import type { RegistryDO } from "../src/store-do.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

const probe = () => env.REGISTRY.get(env.REGISTRY.idFromName("probe_alarm_in_transaction"));

/** `runInDurableObject` with the object's type spelled out, which it cannot work out from a stub. */
const inProbe = <R>(run: (instance: RegistryDO, ctx: DurableObjectState) => R | Promise<R>) =>
  runInDurableObject<RegistryDO, R>(probe(), run);

/** Set on the instance that ran the closure; a new instance after an abort does not have it. */
type Marked = { marker?: string };
const mark = (instance: RegistryDO) => {
  (instance as unknown as Marked).marker = "the instance that ran the closure";
};
const marked = (instance: RegistryDO) => (instance as unknown as Marked).marker;

const ROW = "probe:row";
const VALUE = { hello: "world" };

it("keeps an alarm armed in a transaction that commits, and its row, across an abort", async () => {
  const parked = Date.now() + 7_200_000;
  const at = Date.now() + 3_600_000;

  await inProbe(async (instance, ctx) => {
    mark(instance);
    await ctx.storage.setAlarm(parked);
    await ctx.storage.transaction(async (txn) => {
      await txn.put(ROW, VALUE);
      await ctx.storage.setAlarm(at);
    });

    expect(await ctx.storage.get(ROW)).toEqual(VALUE);
    expect(await ctx.storage.getAlarm()).toBe(at);
  });
  await abortAllDurableObjects();

  await inProbe(async (instance, ctx) => {
    expect(marked(instance)).toBeUndefined();
    expect(await ctx.storage.get(ROW)).toEqual(VALUE);
    expect(await ctx.storage.getAlarm()).toBe(at);
  });
});

it("discards an alarm armed in a transaction that throws, and its row, and keeps the alarm armed before", async () => {
  const parked = Date.now() + 7_200_000;
  const at = Date.now() + 3_600_000;

  await inProbe(async (instance, ctx) => {
    mark(instance);
    await ctx.storage.setAlarm(parked);
    await expect(
      ctx.storage.transaction(async (txn) => {
        await txn.put(ROW, VALUE);
        await ctx.storage.setAlarm(at);
        throw new Error("force rollback");
      })
    ).rejects.toThrow("force rollback");

    expect(await ctx.storage.get(ROW)).toBeUndefined();
    expect(await ctx.storage.getAlarm()).toBe(parked);
  });
  await abortAllDurableObjects();

  await inProbe(async (instance, ctx) => {
    expect(marked(instance)).toBeUndefined();
    expect(await ctx.storage.get(ROW)).toBeUndefined();
    expect(await ctx.storage.getAlarm()).toBe(parked);
  });
});
