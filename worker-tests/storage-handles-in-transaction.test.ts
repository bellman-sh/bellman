/**
 * ARCHITECTURE.md §9, sixth runtime fact: on a SQLite-backed Durable Object, a write made
 * through `ctx.storage` inside a `ctx.storage.transaction()` closure is part of that
 * transaction. Inside the closure `ctx.storage` and the `txn` share one view: each reads what
 * the other has written and not yet committed, the write commits with the closure, and when
 * the closure throws it is gone along with the `txn`'s own.
 *
 * What rests on it. AuthDO's admitRegistration, touchSession and replanSession are
 * transactions (#125), and the helpers admitRegistration calls take the handle they work
 * through (`rows`), as SessionDO's `stored(txn)` and `nextCursor(txn)` do. That is a convention
 * and not what makes a transaction hold, and the comments there say so on the strength of this
 * file. The fact was found by a deliberate break: `#bumpCount` made to write through
 * `this.ctx.storage` inside that transaction left every other test green, because on this
 * storage the write is part of the transaction anyway. This file holds the fact on its own, on
 * raw storage, with none of Bellman's code in the way.
 *
 * If a test HERE fails, a `ctx.storage` call inside a closure is no longer inside the
 * transaction. The convention becomes a requirement, and every closure that makes such a call
 * has to be read again. Do not fix the test.
 *
 * It runs against all four Durable Object classes, since the fact is claimed for all four.
 * The first case of each checks that the object is SQLite-backed (`ctx.storage.sql` exists
 * only there), so a class moved to the other storage fails on that and not on an assertion
 * after it that would be puzzling.
 *
 * What it can and cannot see. It sees outcomes: after a commit both rows survive an abort,
 * after a throw neither does, and mid-closure each handle reads the other's write. It does not
 * say how the runtime gets there.
 *
 * Each outcome is read back twice: on the instance that ran the closure, and, after
 * abortAllDurableObjects(), on a new one. The marker proves the second read is a new instance,
 * so it can only see what reached durable storage. The commit case is the control for the
 * throw case: without it, "both rows are gone" is also what a write that never landed looks
 * like.
 */
import { describe, it, expect, afterEach } from "vitest";
import { env, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

const CLASSES = ["SESSION", "REGISTRY", "AUDIT", "AUTH"] as const;
type Binding = (typeof CLASSES)[number];

const probe = (binding: Binding) =>
  env[binding].get(env[binding].idFromName(`probe_handles_in_transaction_${binding}`));

/** `runInDurableObject` against the probe object of one class, which it cannot type from a stub. */
const inProbe = <R>(
  binding: Binding,
  run: (instance: object, ctx: DurableObjectState) => R | Promise<R>
) => runInDurableObject<DurableObject, R>(probe(binding) as DurableObjectStub<DurableObject>, run);

/** Set on the instance that ran the closure; a new instance after an abort does not have it. */
type Marked = { marker?: string };
const mark = (instance: object) => {
  (instance as Marked).marker = "the instance that ran the closure";
};
const marked = (instance: object) => (instance as Marked).marker;

const VIA_TXN = "probe:via_txn";
const VIA_STORAGE = "probe:via_storage";
const VALUE = { hello: "world" };

describe.each(CLASSES)("%s", (binding) => {
  it("is SQLite-backed, which is what the fact is about", async () => {
    await inProbe(binding, (_instance, ctx) => {
      expect(ctx.storage.sql).toBeDefined();
    });
  });

  it("keeps what a closure that commits wrote through either handle, across an abort", async () => {
    await inProbe(binding, async (instance, ctx) => {
      mark(instance);
      await ctx.storage.transaction(async (txn) => {
        await txn.put(VIA_TXN, VALUE);
        await ctx.storage.put(VIA_STORAGE, VALUE);
      });

      expect(await ctx.storage.get(VIA_TXN)).toEqual(VALUE);
      expect(await ctx.storage.get(VIA_STORAGE)).toEqual(VALUE);
    });
    await abortAllDurableObjects();

    await inProbe(binding, async (instance, ctx) => {
      expect(marked(instance)).toBeUndefined();
      expect(await ctx.storage.get(VIA_TXN)).toEqual(VALUE);
      expect(await ctx.storage.get(VIA_STORAGE)).toEqual(VALUE);
    });
  });

  it("discards what a closure that throws wrote through either handle", async () => {
    await inProbe(binding, async (instance, ctx) => {
      mark(instance);
      await expect(
        ctx.storage.transaction(async (txn) => {
          await txn.put(VIA_TXN, VALUE);
          await ctx.storage.put(VIA_STORAGE, VALUE);
          throw new Error("force rollback");
        })
      ).rejects.toThrow("force rollback");

      expect(await ctx.storage.get(VIA_TXN)).toBeUndefined();
      expect(await ctx.storage.get(VIA_STORAGE)).toBeUndefined();
    });
    await abortAllDurableObjects();

    await inProbe(binding, async (instance, ctx) => {
      expect(marked(instance)).toBeUndefined();
      expect(await ctx.storage.get(VIA_TXN)).toBeUndefined();
      expect(await ctx.storage.get(VIA_STORAGE)).toBeUndefined();
    });
  });

  it("lets each handle read what the other has written and not yet committed", async () => {
    const seen = await inProbe(binding, (_instance, ctx) =>
      ctx.storage.transaction(async (txn) => {
        await txn.put(VIA_TXN, VALUE);
        await ctx.storage.put(VIA_STORAGE, VALUE);
        return {
          storageSeesTxn: await ctx.storage.get(VIA_TXN),
          txnSeesStorage: await txn.get(VIA_STORAGE),
        };
      })
    );

    expect(seen).toEqual({ storageSeesTxn: VALUE, txnSeesStorage: VALUE });
  });
});
