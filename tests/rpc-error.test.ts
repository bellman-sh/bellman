/**
 * `reviveRpcError` and `reviving`, where a Durable Object cannot be reached.
 *
 * The end-to-end proof is `worker-tests/store-contract.test.ts`: the contract suite
 * inside real workerd, whose "throws on a payload too deep to fingerprint" case is an
 * `instanceof` across a real RPC boundary and was the suite's one known divergence
 * until this landed. That is the case that matters, and it is the one that cannot run
 * here — `src/store-do.ts` imports `cloudflare:workers`.
 *
 * What is left for this file is everything the real boundary makes expensive to vary:
 * the shapes a carcass can arrive in, and the rules the Proxy follows about what it
 * does and does not touch.
 *
 * **The fakes here are plain objects, and that is this file's limit.** Every one of
 * the three ways the Proxy was wrong at first passes against a plain object and fails
 * against a stub — `.then(undefined, fn)`, `fn.apply(...)`, and dropping `this`. No
 * assertion below would have caught any of them. Only workerd did.
 */
import { describe, it, expect } from "vitest";
import { reviveRpcError, reviving } from "../src/rpc-error.js";
import { MAX_PAYLOAD_DEPTH, PayloadTooDeepError } from "../src/payload.js";

/**
 * An error as workerd hands it back: name, message and own properties, no prototype,
 * plus the two fields it adds of its own.
 */
const carcass = (over: Record<string, unknown> = {}) => ({
  name: "PayloadTooDeepError",
  message: `payload nests deeper than ${MAX_PAYLOAD_DEPTH} levels`,
  depth: MAX_PAYLOAD_DEPTH + 1,
  durableObjectId: "a1035e86af027079e772183215f0a170cf5ec3911dd17353f4d6f2e7427dc2c1",
  remote: true,
  stack: "PayloadTooDeepError: payload nests deeper\n    at canonical (store-do.js:1)",
  ...over,
});

describe("reviveRpcError", () => {
  it("gives a carcass back its class", () => {
    const revived = reviveRpcError(carcass());

    // The whole point. The carcass fails this and reports itself as the class anyway,
    // which is what made #101 invisible in every log.
    expect(revived).toBeInstanceOf(PayloadTooDeepError);
    expect((revived as PayloadTooDeepError).depth).toBe(MAX_PAYLOAD_DEPTH + 1);
  });

  it("THE CONTROL: the carcass it was handed is not an instance", () => {
    // Without this the case above passes against a `reviveRpcError` that returns its
    // argument, which is precisely the bug.
    expect(carcass()).not.toBeInstanceOf(PayloadTooDeepError);
  });

  it("keeps the remote stack and the fields workerd added", () => {
    // Where the throw actually happened, and which object it happened in. A fresh
    // local stack would point at the reviver.
    const c = carcass();
    const revived = reviveRpcError(c) as PayloadTooDeepError & Record<string, unknown>;

    expect(revived.stack).toBe(c.stack);
    expect(revived.durableObjectId).toBe(c.durableObjectId);
    expect(revived.remote).toBe(true);
  });

  it("returns a real instance untouched, by identity", () => {
    // The local path — MemoryStore, and anything thrown in the Worker's own realm.
    // Returning the same object and not a copy is what makes wrapping a call that
    // never crossed a boundary free.
    const real = new PayloadTooDeepError(MAX_PAYLOAD_DEPTH + 1);
    expect(reviveRpcError(real)).toBe(real);
  });

  it("passes through a carcass whose class it cannot rebuild", () => {
    // `depth` is what this class is defined by. Coercing a missing one would report a
    // confident refusal naming a nonsense bound; what arrived says more.
    const noDepth = carcass({ depth: undefined });
    expect(reviveRpcError(noDepth)).toBe(noDepth);
  });

  it("passes through anything it has no reviver for", () => {
    // The registry is a closed list, so an unregistered error keeps exactly today's
    // behaviour. That is what makes adding an entry the only thing that changes.
    const other = Object.assign(new Error("boom"), { name: "SomeOtherError" });
    expect(reviveRpcError(other)).toBe(other);

    for (const value of ["a string", 42, null, undefined, { noName: true }]) {
      expect(reviveRpcError(value)).toBe(value);
    }
  });
});

describe("reviving", () => {
  it("revives what a method rejects with", async () => {
    const stub = { append: async () => { throw carcass(); } };

    await expect(reviving(stub).append()).rejects.toBeInstanceOf(PayloadTooDeepError);
  });

  it("passes arguments and results through unchanged", async () => {
    const stub = { echo: async (a: number, b: string) => `${a}${b}` };

    await expect(reviving(stub).echo(1, "x")).resolves.toBe("1x");
  });

  it("keeps `this`, so a method can reach its own object", async () => {
    // Reflect.apply rather than `value(...args)`, which would drop the receiver. A
    // Durable Object stub's methods are bound and would not have noticed; a method
    // that reads its own state would.
    const stub = {
      n: 7,
      async read(): Promise<number> { return this.n; },
    };

    await expect(reviving(stub).read()).resolves.toBe(7);
  });

  it("leaves non-function properties and synchronous results alone", async () => {
    // Only promise results are intercepted; anything else is handed back as it is
    // rather than guessed at.
    const stub = { id: "qs_1", plain: () => "sync" };
    const wrapped = reviving(stub);

    expect(wrapped.id).toBe("qs_1");
    expect(wrapped.plain()).toBe("sync");
  });

  it("does not disturb a rejection it has no reviver for", async () => {
    const boom = new Error("boom");
    const stub = { fail: async () => { throw boom; } };

    await expect(reviving(stub).fail()).rejects.toBe(boom);
  });
});
