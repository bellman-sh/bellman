/**
 * AuthDO's registration counter, in real workerd (#122).
 *
 * The object keeps the count of registered clients as a stored number, because Durable
 * Object storage has no count API, and seeds it from the client keys the first time it is
 * asked. Anything that changes the keys has to read the count first, then: a read after
 * the change seeds from keys that already include it, and the change is counted twice.
 *
 * The cases every AuthStorage must pass run first, through the facade the Worker uses.
 * They are the first half of the report and the half the in-memory store cannot fail,
 * since it counts its map. The two below them are for the object alone, because they need
 * what the contract cannot build through the interface: an object that already holds
 * clients and has never counted them, which is what the deployed one was when the counter
 * arrived. Any registration through the interface seeds the counter, so only a row written
 * straight into storage leaves it unseeded.
 */
import { afterEach, describe, expect, it } from "vitest";
import { env, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { AuthStore, type AuthDO } from "../src/oauth/store.js";
import { CLIENT_COUNT_KEY, type RegisteredClient } from "../src/oauth/storage.js";
import { describeAuthStoreContract } from "../tests/helpers/auth-store-contract.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

describeAuthStoreContract("AuthStore (AuthDO)", () => new AuthStore(env.AUTH as never));

const authStub = () => env.AUTH.get(env.AUTH.idFromName("auth"));

const record = (id: string, over: Partial<RegisteredClient> = {}): RegisteredClient => ({
  client_id: id, redirect_uris: [], created_at: 1, expires_at: null, ...over,
});

/**
 * Client rows written straight into storage, with no counter beside them: the object as
 * it was deployed before the counter existed. The arrangement is checked, because every
 * case below is about the first count, and an object that had already counted would show
 * nothing.
 */
const holdingUncounted = (clients: RegisteredClient[]) =>
  runInDurableObject(authStub(), async (_i: AuthDO, ctx) => {
    await ctx.storage.put(Object.fromEntries(clients.map((c) => [`client:${c.client_id}`, c])));
    expect(await ctx.storage.get(CLIENT_COUNT_KEY), "arrangement: nothing has counted these").toBeUndefined();
  });

describe("an object that already holds clients nothing has counted", () => {
  /**
   * The registration is counted with the clients that were there, and once. The seed that
   * runs on the first read lists the keys, so a read taken after the write lists the new
   * client as well and the one added for it makes two.
   */
  it("counts a new registration once", async () => {
    await holdingUncounted([record("c_a"), record("c_b"), record("c_c")]);
    const store = new AuthStore(env.AUTH as never);

    await store.registerClient(record("c_new"));

    expect(await store.countClients()).toBe(4);
  });

  /**
   * The same ordering from the other side, and the direction that matters: a purge deletes
   * the lapsed rows and then subtracts them from the count. Read after the deletion, the
   * seed has already left them out and they are taken off twice, so the count comes out
   * too low and the cap opens late. A registration that errs the other way only closes it
   * early.
   */
  it("counts what is left when a purge reclaims the lapsed", async () => {
    await holdingUncounted([
      record("c_kept_a"), record("c_kept_b"), record("c_kept_c"),
      record("c_lapsed_a", { expires_at: 1 }), record("c_lapsed_b", { expires_at: 2 }),
    ]);
    const store = new AuthStore(env.AUTH as never);

    expect(await store.purgeStale(Date.now())).toMatchObject({ clients: 2 });

    expect(await store.countClients()).toBe(3);
  });
});
