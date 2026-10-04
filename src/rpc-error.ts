import { PayloadTooDeepError } from "./payload.js";

/**
 * Give a typed error back its class after it has crossed a Durable Object RPC
 * boundary.
 *
 * **What workerd does.** An error thrown inside a Durable Object is reconstructed in
 * the caller's realm. Its `name`, `message` and own properties survive; its
 * PROTOTYPE does not, and workerd adds `durableObjectId` and `remote` of its own. So
 * the value that arrives reports itself as a `PayloadTooDeepError` in every log and
 * fails `instanceof PayloadTooDeepError` (#101):
 *
 *     PayloadTooDeepError { message: "payload nests deeper than 64 levels",
 *       name: "PayloadTooDeepError", depth: 65, durableObjectId: "a1035e…", remote: true }
 *
 * `MemoryStore` throws the class itself, in one realm, so every `instanceof` works
 * locally and in the root test program. That is how 933 passing tests never saw it,
 * and why the first run of the contract suite inside workerd is what found it.
 *
 * **Why revive rather than compare names.** A `name` check at each catch site works
 * and spreads knowledge of the boundary into every caller — and the next person to
 * write a catch reaches for `instanceof`, because that is what the class is for. One
 * reviver at the seam keeps `instanceof` true everywhere downstream, so no caller
 * has to know a Durable Object was involved.
 *
 * **The class of problem, not the one call site.** This is about where errors cross,
 * not about which error. `DurableObjectStore` reaches a Durable Object through three
 * accessors and nothing else, so `reviving()` on those three covers every method on
 * the facade, including ones added later. Anything thrown inside an object and caught
 * outside one goes through here.
 *
 * The /ws route is deliberately not wrapped. It holds its own `SESSION` stub and
 * calls `fetch`, whose failures become a 500 — no `instanceof` depends on them.
 */

/**
 * The errors whose identity has to survive, each with how to rebuild it.
 *
 * Deliberately a closed list rather than something generic. Rebuilding an arbitrary
 * class means calling a constructor with arguments guessed from a carcass, and
 * guessing wrong turns a typed refusal into a different bug. An error not named here
 * passes through untouched, which is exactly what it does today, so adding an entry
 * is the only thing that changes behaviour.
 *
 * **Adding a typed error that can be thrown inside a Durable Object means adding it
 * here.** Nothing enforces that automatically: a new class with no entry keeps
 * today's behaviour, which is to lose its prototype at the boundary and silently
 * fail the `instanceof` a caller wrote in good faith. The guard is
 * `tests/helpers/store-contract.ts`, which runs against both stores and so fails for
 * one of them the moment their error identities disagree.
 */
const REVIVERS: Record<string, (carcass: Record<string, unknown>) => Error | null> = {
  // null for a carcass without the property the class is defined by. `Number(c.depth)`
  // would have made that `depth: NaN` and reported a confident refusal with a
  // nonsense bound; handing back what actually arrived says more.
  [PayloadTooDeepError.name]: (c) =>
    typeof c.depth === "number" ? new PayloadTooDeepError(c.depth) : null,
};

/** Error-shaped enough to read a name off. workerd's reconstruction is an Error; this does not insist. */
function named(err: unknown): (Record<string, unknown> & { name: string }) | null {
  if (typeof err !== "object" || err === null) return null;
  const name = (err as { name?: unknown }).name;
  return typeof name === "string" ? (err as Record<string, unknown> & { name: string }) : null;
}

/**
 * The thrown value with its class restored, or unchanged when there is nothing to
 * restore.
 *
 * A value that is ALREADY an instance is returned as it is, untouched. That keeps
 * this a no-op on the local path — `MemoryStore`, and anything in the Worker's own
 * realm — so wrapping a call that never crossed a boundary costs nothing and changes
 * nothing.
 *
 * `stack` and the properties workerd adds are carried over. The remote stack is
 * where the throw actually happened, and `durableObjectId` names which object: both
 * are the useful part of a log line about this, and a fresh local stack would point
 * at this function instead.
 */
export function reviveRpcError(err: unknown): unknown {
  const carcass = named(err);
  if (!carcass) return err;
  const revive = REVIVERS[carcass.name];
  if (!revive) return err;

  const revived = revive(carcass);
  if (!revived) return err;
  if (Object.getPrototypeOf(err) === Object.getPrototypeOf(revived)) return err;

  for (const [key, value] of Object.entries(carcass)) {
    if (!(key in revived) || revived[key as keyof Error] === undefined) {
      Object.defineProperty(revived, key, { value, enumerable: true, configurable: true, writable: true });
    }
  }
  if (typeof carcass.stack === "string") revived.stack = carcass.stack;
  return revived;
}

/**
 * A view of `stub` whose every method rejects with revived errors.
 *
 * A `Proxy` and not a hand-written wrapper per method, because the point is to cover
 * methods nobody has written yet: a facade method added next year reaches its object
 * through the same accessor and is covered without being touched.
 *
 * Only promise results are intercepted. A Durable Object stub answers a method call
 * with a promise, and anything synchronous it hands back (a property, a nested RPC
 * target) is passed through as it is rather than guessed at.
 *
 * **`Reflect.apply`, never `fn.apply(...)`.** A method read off a stub is itself an
 * RPC proxy, so reading `.apply` on it sends a call for a Durable Object method NAMED
 * "apply" and fails with "The RPC receiver does not implement the method 'apply'".
 * `Reflect.apply` invokes `[[Call]]` without reading any property, and keeps `this`
 * — which `value(...args)` would drop.
 *
 * **Both handlers are real functions.** A stub does not answer with a `Promise` but
 * with a `JsRpcPromise`, and its `then` refuses a non-function first argument:
 * `.then(undefined, onRejected)`, the ordinary way to write this, dies with
 * "parameter 1 is not of type 'Function'" on every call. Measured — it reddened all
 * 78 cases of the contract suite at once.
 *
 * The cost of attaching a handler is that the result is a plain promise, so the
 * pipelining a `JsRpcPromise` allows (reading a property off it to chain a second
 * call without a round trip) is gone. Nothing uses it: every facade method awaits its
 * result. A caller that wants to pipeline has to reach for the unwrapped stub and say
 * why.
 */
export function reviving<T extends object>(stub: T): T {
  return new Proxy(stub, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]): unknown => {
        const result = Reflect.apply(value as (...a: unknown[]) => unknown, target, args);
        if (typeof (result as { then?: unknown })?.then !== "function") return result;
        return (result as Promise<unknown>).then(
          (ok) => ok,
          (err: unknown) => { throw reviveRpcError(err); },
        );
      };
    },
  });
}
