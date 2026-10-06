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
 *
 * The last group is about the registration's own write rather than its count: the client row
 * and the new count are one put, and an interruption must not leave one without the other.
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

/**
 * Make any write that carries a row under `prefix` throw while `outage.on` is set, in either
 * of `put`'s shapes. `hits` counts the writes refused, so a test can tell the hook sat on the
 * write it names, and the state is an object the test holds so the interruption can be over by
 * the time of the retry. It lives on the instance that serves the object, and the abort in
 * afterEach discards it.
 */
const interruptWritesTo = (prefix: string, outage: { on: boolean; hits: number }) =>
  runInDurableObject(authStub(), async (_i: AuthDO, ctx) => {
    type Call = (...args: unknown[]) => Promise<unknown>;
    const carries = (arg: unknown) =>
      typeof arg === "string"
        ? arg.startsWith(prefix)
        : typeof arg === "object" && arg !== null && Object.keys(arg).some((k) => k.startsWith(prefix));
    const write = (ctx.storage as unknown as { put: Call }).put.bind(ctx.storage);
    Object.defineProperty(ctx.storage, "put", {
      configurable: true,
      value: (...args: unknown[]) => {
        if (outage.on && carries(args[0])) {
          outage.hits++;
          throw new Error("interrupted");
        }
        return write(...args);
      },
    });
  });

const storedClients = () =>
  runInDurableObject(authStub(), async (_i: AuthDO, ctx) =>
    (await ctx.storage.list({ prefix: "client:" })).size);

/**
 * The registration as a plain promise. The facade hands back the RPC promise itself, and when
 * one of those resolves, `rejects` reports it as "not a function" and not as a call that was
 * expected to fail and did not.
 */
const attempt = async (store: AuthStore, id: string) => store.registerClient(record(id));

/**
 * A registration stores the client and the new count, and an interruption between two writes
 * would store one without the other. A client stored and not counted is the bad half: a
 * stored counter is never recounted, so the object stays one behind for good, and a count too
 * low opens the registration cap late, the direction #122 closes in purgeStale.
 *
 * So the two are one write, and this holds it from both sides. The interruption is a write that
 * throws, aimed at the write that carries the counter and then at the one that carries the
 * client row. In the code as it stands they are one put, so both aim at it, and they are two
 * cases so that a split in either order fails one of them: the client first and the count
 * second leaves the count behind, the count first leaves it ahead.
 *
 * The object has counted before the interruption (a first registration), so what gets
 * interrupted is the registration and not the seed's own write to the counter key.
 */
describe("a registration interrupted part-way", () => {
  const WRITES = [
    { write: "the counter", prefix: CLIENT_COUNT_KEY },
    { write: "the client row", prefix: "client:" },
  ];

  it.each(WRITES)(
    "leaves the count equal to the stored clients when a write carrying $write is interrupted",
    async ({ prefix }) => {
      const store = new AuthStore(env.AUTH as never);
      await store.registerClient(record("c_first"));
      const outage = { on: true, hits: 0 };
      await interruptWritesTo(prefix, outage);

      await expect(attempt(store, "c_second")).rejects.toThrow(/interrupted/);

      // The write the hook refuses was made. Without it the rest proves nothing.
      expect(outage.hits).toBeGreaterThan(0);
      expect(await store.countClients()).toBe(await storedClients());
    }
  );

  /**
   * What the split cost in the end, as #124's retry case shows for the expiry: left with the
   * client and no count, the retry finds the client already there and counts nothing, so the
   * count is wrong for good. Left as it was, the retry registers the client whole.
   */
  it.each(WRITES)(
    "counts the client once when it is registered again after $write was interrupted",
    async ({ prefix, write }) => {
      const store = new AuthStore(env.AUTH as never);
      await store.registerClient(record("c_first"));
      const outage = { on: true, hits: 0 };
      await interruptWritesTo(prefix, outage);
      await expect(attempt(store, "c_second")).rejects.toThrow(/interrupted/);
      expect(outage.hits, `control: the interruption landed on a write carrying ${write}`).toBeGreaterThan(0);
      outage.on = false;

      await store.registerClient(record("c_second"));

      expect(await storedClients()).toBe(2);
      expect(await store.countClients()).toBe(2);
    }
  );
});
