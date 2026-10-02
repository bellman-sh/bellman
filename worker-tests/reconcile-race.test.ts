/**
 * The ledger serializes per customer, but that queue is released when
 * syncSubscription returns. Two webhook deliveries could then both read
 * paidPlan and race their separate grant writes, so an older "active" result
 * landed after a cancellation had deleted the grant — leaving paid access for a
 * plan nobody is paying for. Stripe sends the deletion once, so nothing
 * corrected it.
 *
 * AuthDO.reconcile now runs the whole decision in the user's queue, and these
 * tests are about that order. They cannot leave it to scheduling: with the lock
 * removed, reconciles started back to back still come out in the right order
 * here (none stale in 1,200 overlapping rounds across four shapes), so a test
 * that only dispatches them together passes without the fix. The races below
 * hold one reconcile where a slower one would be — after it has read the
 * ledger, or while its write is on the way into the registry — and let the
 * cancellation overtake it. Without the lock both leave a grant behind.
 */
import { describe, it, expect, afterEach } from "vitest";
import { env, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import worker from "../src/worker.js";
import { AuthStore, type AuthDO } from "../src/oauth/store.js";
import { DurableObjectStore, type RegistryDO } from "../src/store-do.js";
import type { BillingLedger, SubscriptionState } from "../src/billing/ledger.js";

const USER = "u_github_4242";
const KEY = "github:4242";
const ACTIVE: SubscriptionState = { plan: "pro", status: "active", eventAt: 1_000 };
const CANCELED: SubscriptionState = { plan: "pro", status: "canceled", eventAt: 2_000 };

const authStub = () => env.AUTH.get(env.AUTH.idFromName("auth"));
const registryStub = () => env.REGISTRY.get(env.REGISTRY.idFromName("registry"));

/** `runInDurableObject` with the object's type spelled out, which it cannot work out from a stub. */
const inAuth = <R>(run: (instance: AuthDO) => R | Promise<R>) => runInDurableObject<AuthDO, R>(authStub(), run);
const inRegistry = <R>(run: (instance: RegistryDO) => R | Promise<R>) =>
  runInDurableObject<RegistryDO, R>(registryStub(), run);

/**
 * The ledger inside the live AuthDO. TypeScript's `private` is a compile-time
 * check only, so a test running inside the object can reach it; over RPC it
 * cannot be reached at all (see the last describe).
 */
const ledgerOf = (instance: AuthDO) => (instance as unknown as { ledger: BillingLedger }).ledger;

/**
 * Put a subscription state in the ledger without a Stripe to read it from.
 * AuthDO exposes no method for this, on purpose: over RPC it would let any
 * caller that holds the binding write a paid plan.
 */
const record = (customer: string, subscription: string, state: SubscriptionState) =>
  inAuth((instance) => ledgerOf(instance).recordSubscription(customer, subscription, state));

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

/** A point in a reconcile where the first caller to arrive waits until `release()`. */
interface Hold {
  held: boolean;
  released: boolean;
  release(): void;
}

const holds: Hold[] = [];
const undo: (() => void)[] = [];
const inFlight: Promise<unknown>[] = [];

/**
 * Remember a call a test starts and may not get to await. A test that fails
 * between releasing a hold and awaiting its reconcile would otherwise have the
 * object torn down underneath it, and the failure it reports would be buried in
 * "Application called deleteAllDurableObjects()".
 */
function track<T>(promise: Promise<T>): Promise<T> {
  inFlight.push(promise.then(() => undefined, () => undefined));
  return promise;
}

function newHold(): Hold {
  const hold: Hold = { held: false, released: false, release: () => { hold.released = true; } };
  holds.push(hold);
  return hold;
}

/**
 * The wait polls a timer rather than awaiting a promise made by the test: the
 * object is waiting on something only another request can change, and a timer is
 * what keeps the runtime from deciding it has hung.
 */
async function waitForRelease(hold: Hold): Promise<void> {
  hold.held = true;
  await until(() => hold.released, "the hold to be released", 15_000);
}

/**
 * Hold the first reconcile after it has read the ledger and before it sends its
 * write: the gap in which what it read can go stale. In production that is any
 * await someone later puts between the decision and the write.
 */
async function holdAfterLedgerRead(): Promise<Hold> {
  const hold = newHold();
  await inAuth((instance) => {
    const ledger = ledgerOf(instance);
    const read = ledger.paidPlan.bind(ledger);
    let first = true;
    ledger.paidPlan = async (userId: string) => {
      const paid = await read(userId);
      if (first) {
        first = false;
        await waitForRelease(hold);
      }
      return paid;
    };
  });
  return hold;
}

/**
 * Hold the first grant write on its way into the registry: sent, not yet applied.
 * That is a busy registry, or a write overtaken in transit by one sent after it.
 *
 * It patches the class's prototype, and undoes it afterwards. Nothing else works:
 * a Durable Object answers RPC from its prototype, so an override set on the
 * instance is never called.
 */
async function holdGrantWrite(): Promise<Hold> {
  const hold = newHold();
  await inRegistry((instance) => {
    const proto = Object.getPrototypeOf(instance) as RegistryDO;
    const write = proto.putGrantIfSource;
    let first = true;
    proto.putGrantIfSource = async function (this: RegistryDO, ...args: Parameters<RegistryDO["putGrantIfSource"]>) {
      if (first) {
        first = false;
        await waitForRelease(hold);
      }
      return write.apply(this, args);
    };
    undo.push(() => { proto.putGrantIfSource = write; });
  });
  return hold;
}

/** Make the first grant write fail, as a registry that is down would. */
async function failGrantWrite(message: string): Promise<void> {
  await inRegistry((instance) => {
    const proto = Object.getPrototypeOf(instance) as RegistryDO;
    const write = proto.putGrantIfSource;
    let first = true;
    proto.putGrantIfSource = async function (this: RegistryDO, ...args: Parameters<RegistryDO["putGrantIfSource"]>) {
      if (first) {
        first = false;
        throw new Error(message);
      }
      return write.apply(this, args);
    };
    undo.push(() => { proto.putGrantIfSource = write; });
  });
}

afterEach(async () => {
  for (const hold of holds.splice(0)) hold.release();
  await Promise.race([Promise.allSettled(inFlight.splice(0)), sleep(2_000)]);
  for (const restore of undo.splice(0)) restore();
  await reset();
  await abortAllDurableObjects();
});

describe("a cancellation that arrives while an older reconcile is in flight", () => {
  const where = {
    "after it has read the ledger": holdAfterLedgerRead,
    "while its write is on the way into the registry": holdGrantWrite,
  };

  describe.each(Object.entries(where))("with the first reconcile held %s", (_where, holdFirst) => {
    it("leaves no grant, because the later reconcile waits its turn", async () => {
      const auth = new AuthStore(env.AUTH as never);
      const store = new DurableObjectStore(env as never);
      await auth.linkCustomer("cus_1", USER);
      await record("cus_1", "sub_1", ACTIVE);
      const hold = await holdFirst();

      const first = track(auth.reconcile(USER)); // reads "pro", then is held
      await until(() => hold.held, "the first reconcile to be held");
      await record("cus_1", "sub_1", CANCELED); // the cancellation lands meanwhile
      const second = track(auth.reconcile(USER)); // reads "nothing paid"
      // Unlocked, this one finishes now and removes a grant that is not there yet,
      // and the held write lands after it. Locked, it is still queued.
      await settlesWithin(second, 300);
      hold.release();
      const outcomes = await Promise.all([first, second]);

      // The cancellation is the later state, so no grant may survive.
      expect(await store.getGrant(KEY)).toBeUndefined();
      expect(outcomes).toEqual(["written", "deleted"]);
    });
  });

  it("holds up only the user whose reconcile is in flight", async () => {
    const auth = new AuthStore(env.AUTH as never);
    const store = new DurableObjectStore(env as never);
    await auth.linkCustomer("cus_1", USER);
    await auth.linkCustomer("cus_2", "u_github_77");
    await record("cus_1", "sub_1", ACTIVE);
    await record("cus_2", "sub_2", ACTIVE);
    const hold = await holdAfterLedgerRead();

    const held = track(auth.reconcile(USER));
    await until(() => hold.held, "the first user's reconcile to be held");
    const other = track(auth.reconcile("u_github_77"));

    // One queue per user: another user's purchase is not stuck behind this one.
    expect(await settlesWithin(other, 1_000)).toBe(true);
    hold.release();
    expect(await Promise.all([held, other])).toEqual(["written", "written"]);
    expect(await store.getGrant("github:77")).toMatchObject({ plan: "pro" });
  });

  it("holds up a link for the same user, which writes that user's customer list", async () => {
    const auth = new AuthStore(env.AUTH as never);
    await auth.linkCustomer("cus_1", USER);
    await record("cus_1", "sub_1", ACTIVE);
    const hold = await holdAfterLedgerRead();

    const reconciling = track(auth.reconcile(USER));
    await until(() => hold.held, "the reconcile to be held");
    const linking = track(auth.linkCustomer("cus_2", USER));

    expect(await settlesWithin(linking, 300)).toBe(false);
    hold.release();
    expect(await Promise.all([reconciling, linking])).toEqual(["written", true]);
  });
});

describe("lock ordering", () => {
  /**
   * linkCustomer takes a customer's queue and then the user's. A reconcile that
   * took a customer's queue while holding the user's would wait on a link that
   * is waiting on it. So the one that holds the user's queue must never wait on
   * a customer's, and this holds a customer's queue and checks that it does not.
   */
  it("a reconcile does not wait for a customer's queue", async () => {
    const auth = new AuthStore(env.AUTH as never);
    await auth.linkCustomer("cus_1", USER);
    await record("cus_1", "sub_1", ACTIVE);

    // A sync still waiting on Stripe holds its customer's queue.
    let asked = false;
    let stripeAnswers = false;
    const slowStripe = (async () => {
      asked = true;
      await until(() => stripeAnswers, "the test to let Stripe answer", 15_000);
      return Response.json({ id: "sub_2", status: "active", items: { data: [{ price: { lookup_key: "pro_monthly" } }] } });
    }) as typeof fetch;
    const syncing = track(inAuth((instance) =>
      ledgerOf(instance).syncSubscription("cus_1", "sub_2", { apiKey: "rk_test", fetchImpl: slowStripe })
    ));
    try {
      await until(() => asked, "the sync to reach Stripe");

      expect(await settlesWithin(track(auth.reconcile(USER)), 1_000)).toBe(true);
    } finally {
      stripeAnswers = true;
    }
    await syncing;
  });
});

describe("what a reconcile answers", () => {
  it("writes the grant when the ledger says the user is paying", async () => {
    const auth = new AuthStore(env.AUTH as never);
    const store = new DurableObjectStore(env as never);
    await auth.linkCustomer("cus_1", USER);
    await record("cus_1", "sub_1", ACTIVE);

    expect(await auth.reconcile(USER)).toBe("written");
    expect(await store.getGrant(KEY)).toMatchObject({ plan: "pro", source: "purchase" });
  });

  it("removes it once the ledger says they are not", async () => {
    const auth = new AuthStore(env.AUTH as never);
    const store = new DurableObjectStore(env as never);
    await auth.linkCustomer("cus_1", USER);
    await record("cus_1", "sub_1", ACTIVE);
    await auth.reconcile(USER);
    await record("cus_1", "sub_1", CANCELED);

    expect(await auth.reconcile(USER)).toBe("deleted");
    expect(await store.getGrant(KEY)).toBeUndefined();
  });

  it("says missing when there is no grant to remove", async () => {
    const auth = new AuthStore(env.AUTH as never);
    await auth.linkCustomer("cus_1", USER);

    expect(await auth.reconcile(USER)).toBe("missing");
  });

  it("leaves a plan an operator granted by hand alone, and says so", async () => {
    const auth = new AuthStore(env.AUTH as never);
    const store = new DurableObjectStore(env as never);
    await store.putGrant({
      key: KEY, plan: "team", role: "admin", orgId: "org_comped",
      source: "operator", grantedAt: Date.now(), grantedBy: "u_admin", expiresAt: null,
    });
    await auth.linkCustomer("cus_1", USER);
    await record("cus_1", "sub_1", ACTIVE);

    expect(await auth.reconcile(USER)).toBe("conflict");
    expect(await store.getGrant(KEY)).toMatchObject({ plan: "team", source: "operator" });
  });

  it("writes nothing for a user id no purchase can be filed against", async () => {
    const auth = new AuthStore(env.AUTH as never);
    await auth.linkCustomer("cus_1", "u_jesse");
    await record("cus_1", "sub_1", ACTIVE);

    expect(await auth.reconcile("u_jesse")).toBe("unkeyable");
  });

  it("fails when the registry cannot take the write, and the next one is not stuck behind it", async () => {
    const auth = new AuthStore(env.AUTH as never);
    const store = new DurableObjectStore(env as never);
    await auth.linkCustomer("cus_1", USER);
    await record("cus_1", "sub_1", ACTIVE);
    await failGrantWrite("registry unavailable");

    // Stripe retries a delivery that got a 5xx, so the failure has to reach it.
    // Wrapped because an RPC promise is callable, and `.rejects` would call it.
    await expect(Promise.resolve(auth.reconcile(USER))).rejects.toThrow("registry unavailable");
    expect(await auth.reconcile(USER)).toBe("written");
    expect(await store.getGrant(KEY)).toMatchObject({ plan: "pro" });
  });
});

describe("the webhook route", () => {
  const SECRET = "whsec_test_secret";

  async function sign(payload: string): Promise<string> {
    const enc = new TextEncoder();
    const t = Math.floor(Date.now() / 1000);
    const key = await crypto.subtle.importKey("raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`)));
    return `t=${t},v1=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  }

  /** The Worker's own fetch handler, with billing switched on and the Stripe secrets set. */
  async function deliver(type: string, object: Record<string, unknown>): Promise<Response> {
    const payload = JSON.stringify({ id: "evt_1", type, created: Math.floor(Date.now() / 1000), data: { object } });
    return worker.fetch(
      new Request("https://mcp.example.test/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": await sign(payload) },
        body: payload,
      }),
      {
        SESSION: env.SESSION, REGISTRY: env.REGISTRY, AUDIT: env.AUDIT, AUTH: env.AUTH,
        BELLMAN_BILLING: "on", STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_API_KEY: "rk_test",
      } as never
    );
  }

  const checkout = () =>
    deliver("checkout.session.completed", {
      object: "checkout.session", mode: "subscription", customer: "cus_1", client_reference_id: USER,
    });

  /**
   * The subscription is already in the ledger when the checkout that links its
   * customer arrives, which is an order Stripe is allowed to deliver in. The
   * grant that results has to have been written by the object behind this route,
   * and what the route answers has to be what that object answered.
   */
  it("reconciles through the object: a checkout writes the grant, and a later delivery removes it", async () => {
    const store = new DurableObjectStore(env as never);
    await record("cus_1", "sub_1", ACTIVE);

    const written = await checkout();

    expect(written.status).toBe(200);
    expect(await written.json()).toEqual({ received: true, applied: true, grant: "written" });
    expect(await store.getGrant(KEY)).toMatchObject({ plan: "pro", source: "purchase" });

    await record("cus_1", "sub_1", CANCELED);
    const removed = await checkout();

    expect(await removed.json()).toEqual({ received: true, applied: true, grant: "deleted" });
    expect(await store.getGrant(KEY)).toBeUndefined();
  });
});

describe("what a caller holding the binding can reach", () => {
  /**
   * Every method and getter on a Durable Object answers over RPC. What AuthDO
   * adds for the Worker is `reconcile`. The registry accessor stays inside, and
   * nothing lets a caller write a subscription state, which with a reconcile
   * would be a paid plan for anyone.
   *
   * The ledger needs no case of its own: it is not an RPC target, so even
   * behind a prototype getter it can be neither returned nor called into.
   */
  it.each(["grants", "recordSubscription"])("%s is not reachable over RPC", async (name) => {
    const stub = authStub() as unknown as Record<string, unknown>;

    await expect(Promise.resolve(stub[name])).rejects.toThrow();
  });
});
