/**
 * The BellmanStore contract suite, unmodified, against the store that serves
 * production — inside a real Durable Object, in real workerd.
 *
 * Why this lives in its own vitest program rather than beside tests/: see
 * ./README.md.
 */
import { afterEach } from "vitest";
import { env, reset, abortAllDurableObjects } from "cloudflare:test";
import { DurableObjectStore } from "../src/store-do.js";
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

describeStoreContract("DurableObjectStore", () => new DurableObjectStore(env as never), {
  // #101. Not a harness problem: src/server.ts:765 branches on this same
  // instanceof, so the branch never fires in production either.
  errorIdentityAcrossRpc:
    "workerd reconstructs an error thrown inside a Durable Object in the caller's " +
    "realm, so it keeps its name and own properties but not its prototype (#101)",
});
