/**
 * RegistryDO.putPreset, held open in workerd between its count and its write. It counts a person's
 * saved presets and writes a new one, and the cap holds only if no other save can count in between:
 * two new names racing for the last place must not both land.
 *
 * The input gate keeps a second save out while nothing but storage is awaited between the count and
 * the write, and a transaction keeps it out whatever is awaited there: the difference
 * auth-race.test.ts makes for AuthDO (#173). This holds the first save just past its count, with a
 * timer await standing in for whatever a later edit might put there, and lets a second save try.
 * The store contract's case for the same race sends the two saves together, which cannot choose
 * where they land and passes on either shape.
 */
import { describe, it, expect, afterEach } from "vitest";
import { env, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import type { RegistryDO } from "../src/store-do.js";
import type { SavedPreset } from "../src/types.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait for a condition, or fail the test instead of hanging it. */
async function until(condition: () => boolean, what: string, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}`);
    await sleep(2);
  }
}

/** Whether `promise` settles within `ms`; false means it is still waiting. */
const settlesWithin = (promise: Promise<unknown>, ms: number) =>
  Promise.race([promise.then(() => true, () => true), sleep(ms).then(() => false)]);

const hold = { held: false, released: false };
const inFlight: Promise<unknown>[] = [];

afterEach(async () => {
  hold.released = true;
  await Promise.race([Promise.allSettled(inFlight.splice(0)), sleep(2_000)]);
  Object.assign(hold, { held: false, released: false });
  await reset();
  await abortAllDurableObjects();
});

const registry = () => env.REGISTRY.get(env.REGISTRY.idFromName("registry"));

const preset = (name: string): SavedPreset => ({
  name,
  description: null,
  mode: "pair",
  heartbeat: null,
  housekeeping: null,
  roles: { lead: { can: ["send"], description: null, heartbeat_on: false } },
  default_role: "lead",
  creator_role: "lead",
  updated_at: "2026-03-15T12:00:00.000Z",
});

/**
 * Hold the first listing of `prefix` in the registry, after it has returned and before whatever
 * called it writes. A plain read lists through `storage.list` and a transaction through the `txn`
 * handed to its closure, so both are patched, as auth-race.test.ts's holdFirstReadOf patches `get`.
 */
async function holdFirstListOf(prefix: string): Promise<void> {
  await runInDurableObject<RegistryDO, void>(registry(), (_instance, ctx) => {
    type Call = (...args: unknown[]) => Promise<unknown>;
    const storage = ctx.storage as unknown as { list: Call; transaction: Call };
    let first = true;

    const holding = (list: Call): Call => async (...args) => {
      const value = await list(...args);
      if (first && (args[0] as { prefix?: string } | undefined)?.prefix === prefix) {
        first = false;
        hold.held = true;
        await until(() => hold.released, "the hold to be released", 15_000);
      }
      return value;
    };
    const holdingTxn = (txn: object) => new Proxy(txn, {
      get(target, prop) {
        const member = Reflect.get(target, prop, target) as unknown;
        if (typeof member !== "function") return member;
        const bound = (member as Call).bind(target);
        return prop === "list" ? holding(bound) : bound;
      },
    });

    const list = storage.list.bind(storage);
    const transaction = storage.transaction.bind(storage);
    Object.defineProperty(ctx.storage, "list", { configurable: true, value: holding(list) });
    Object.defineProperty(ctx.storage, "transaction", {
      configurable: true,
      value: (closure: (txn: object) => Promise<unknown>, ...rest: unknown[]) =>
        transaction((txn: object) => closure(holdingTxn(txn)), ...rest),
    });
  });
}

describe("putPreset, the first save held between its count and its write", () => {
  it("lets one of two new names racing for the last place land, never both", async () => {
    expect(await registry().putPreset("u_jesse", preset("a"), 2)).toBe("saved");
    await holdFirstListOf("pr:u_jesse:");

    const first = registry().putPreset("u_jesse", preset("b"), 2); // counts one, then is held
    inFlight.push(first);
    await until(() => hold.held, "the first save to be held");
    const second = registry().putPreset("u_jesse", preset("c"), 2);
    inFlight.push(second);
    await settlesWithin(second, 300);
    hold.released = true;

    expect([...(await Promise.all([first, second]))].sort(), "both new names took the last place")
      .toEqual(["full", "saved"]);
    expect(await registry().listPresets("u_jesse")).toHaveLength(2);
  });
});
