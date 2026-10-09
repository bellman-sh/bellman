/**
 * The BellmanStore contract suite, unmodified, against the store that serves
 * production — inside a real Durable Object, in real workerd.
 *
 * Why this lives in its own vitest program rather than beside tests/: see
 * ./README.md.
 */
import { afterEach } from "vitest";
import { env, reset, abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { R2BlobStore } from "../src/blobs-r2.js";
import { DurableObjectStore, type SessionDO } from "../src/store-do.js";
import { describeStoreContract } from "../tests/helpers/store-contract.js";

/**
 * Both calls are needed, and they clear different things.
 *
 * reset() drops durable storage, so RegistryDO's grants and the fixed `qs_test`
 * SessionDO (fixtures.ts hands every case the same session id, so every case
 * addresses the SAME Durable Object) do not carry into the next case.
 *
 * abortAllDurableObjects() tears the instances down, and that is what clears
 * SessionDO.waiters — in-memory state no storage rollback would touch. Without
 * it a case that leaves a 20s waiter behind leaks into the next one.
 *
 * Registered at file level so it runs AFTER the contract suite's own afterEach,
 * i.e. once vi.useRealTimers() has run: these are real RPCs into workerd and
 * would not settle under a fake clock.
 */
afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

// No divergences. `errorIdentityAcrossRpc` was the last one and closed with #101:
// DurableObjectStore reaches every object through accessors wrapped in `reviving`,
// so a class thrown inside one is still that class outside.
//
// What the harness hands the suite instead (#65): the real bucket the rooms' objects go in, and the
// alarm. `DurableObjectStore.sweep` is a no-op, since a room is purged by its own alarm, so after a case
// sweeps, the alarm of the room it names runs here. Called on the instance and not through
// `runDurableObjectAlarm`: this pool fires a due alarm by itself, and these cases' faked clock is months
// behind the real one, so an alarm armed on it is already due. Measured through the pool's helper, the
// cases that wait for a purge found no alarm armed when they asked (`getAlarm()` null, the helper
// answering false and running nothing) and failed three runs in three; `alarm()` is the same handler,
// run when asked.
describeStoreContract("DurableObjectStore", () => new DurableObjectStore(env as never), {
  blobsFor: () => new R2BlobStore((env as unknown as { BLOBS: R2Bucket }).BLOBS),
  advance: (id) =>
    runInDurableObject(env.SESSION.get(env.SESSION.idFromName(id)), (instance: SessionDO) => instance.alarm()),
});
