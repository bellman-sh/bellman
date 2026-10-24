/**
 * AuthDO's agent claim methods (ADR 0037), held open in workerd the way auth-race.test.ts holds
 * the client registry: a poll parked between reading a registration and writing its
 * last_poll_at back must not overwrite an approval that ran in the gap, and two polls on one
 * claimed registration must not both be granted. Each method is one transaction; these
 * tests are what fails if one stops being one. The last case runs the sweep the alarm runs.
 * The helpers are copied from auth-race.test.ts, as each worker-test file keeps its own.
 */
import { describe, it, expect, afterEach } from "vitest";
import { env, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import type { AuthDO } from "../src/oauth/store.js";
import {
  AGENT_COUNT_KEY, AGENT_POLL_INTERVAL_MS, AGENT_REGISTRATION_TTL_MS, newAttempt,
  type AgentClaimed, type AgentRegistration,
} from "../src/oauth/agent-auth.js";
import type { Identity } from "../src/types.js";

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

interface Hold {
  held: boolean;
  released: boolean;
  release(): void;
}

const holds: Hold[] = [];
const inFlight: Promise<unknown>[] = [];

/**
 * Remember a call a test starts and may not get to await, so that a test that fails
 * between releasing a hold and awaiting its call does not have the object torn down
 * underneath it, and report that instead of its own failure.
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

afterEach(async () => {
  for (const hold of holds.splice(0)) hold.release();
  await Promise.race([Promise.allSettled(inFlight.splice(0)), sleep(2_000)]);
  await reset();
  await abortAllDurableObjects();
});

/** One object per test, so no test starts from another's rows. */
const auth = (name: string) => env.AUTH.get(env.AUTH.idFromName(name));

/**
 * Hold the first read of `key` in the object `name`, after it has returned and before
 * whatever called it writes: the gap in which what it read can go stale. In production that
 * is any await someone later puts between the decision and the write.
 *
 * A method reads through one of two handles, and the hold has to see both. One that reads
 * and then puts reads through `storage.get`. One that is a transaction reads through the
 * `txn` handed to its closure, which `storage.get` never sees, so `storage.transaction` is
 * patched to hand it a txn whose `get` holds the same way. The first read of `key` through
 * either waits, and only that one. A hold that reached neither would never fire, and every
 * case goes on to wait for it (`until(() => hold.held)`), so a setup that holds nothing
 * fails there instead of passing for the wrong reason.
 *
 * The patch is on the object's storage, which is not an RPC target, so it works on the
 * instance. The abort in afterEach discards the instance. The wait polls a timer rather than
 * awaiting a promise made by the test, because the object is waiting on something only
 * another request can change.
 */
async function holdFirstReadOf(name: string, key: string, hold: Hold): Promise<void> {
  await runInDurableObject<AuthDO, void>(auth(name), (_instance, ctx) => {
    type Call = (...args: unknown[]) => Promise<unknown>;
    const storage = ctx.storage as unknown as { get: Call; transaction: Call };
    let first = true;

    /** `get`, answering as it did, but parked after the first read of `key`. */
    const holding = (get: Call): Call => async (...args) => {
      const value = await get(...args);
      if (first && args[0] === key) {
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
        return prop === "get" ? holding(bound) : bound;
      },
    });

    const get = storage.get.bind(storage);
    const transaction = storage.transaction.bind(storage);
    Object.defineProperty(ctx.storage, "get", { configurable: true, value: holding(get) });
    Object.defineProperty(ctx.storage, "transaction", {
      configurable: true,
      value: (closure: (txn: object) => Promise<unknown>, ...rest: unknown[]) =>
        transaction((txn: object) => closure(holdingTxn(txn)), ...rest),
    });
  });
}

/** The keys an object holds under `prefix`, read by listing, which no hold looks at. */
const keysUnder = (name: string, prefix: string) =>
  runInDurableObject<AuthDO, string[]>(auth(name), async (_instance, ctx) =>
    [...(await ctx.storage.list({ prefix })).keys()]);

const NOW = Date.now();
const IDENTITY: Identity = { userId: "u_github_4242", orgId: null, plan: "free", role: "member", label: "jesse@example.dev" };
const CLAIMED: AgentClaimed = {
  identity: IDENTITY, plan_source: "default", plan_key: null, identity_keys: ["github:4242", "email:jesse@example.dev"],
};
const registration = (now = NOW): AgentRegistration => ({
  registration_id: "reg_race", login_hint: "jesse@example.dev", created_at: now,
  expires_at: now + AGENT_REGISTRATION_TTL_MS, last_poll_at: null, attempt: newAttempt(now), claimed: null,
});
/** Admit a registration under claim token `clm_race`, and return it. */
const register = async (name: string, now = NOW) => {
  const reg = registration(now);
  expect(await auth(name).admitAgentRegistration("clm_race", reg, "203.0.113.9", now)).toBe("ok");
  return reg;
};
const count = (name: string) =>
  runInDurableObject<AuthDO, number | undefined>(auth(name), (_instance, ctx) => ctx.storage.get<number>(AGENT_COUNT_KEY));

describe("pollAgentClaim, held between its read and its write", () => {
  it("a poll held between its read and write does not lose an approval", async () => {
    const name = "agent-race-approve";
    const reg = await register(name);
    const hold = newHold();
    await holdFirstReadOf(name, "agentreg:clm_race", hold);

    const poll = track(auth(name).pollAgentClaim("clm_race", NOW)); // reads the unclaimed row, then is held
    await until(() => hold.held, "the poll to be held");
    const approve = track(auth(name).approveAgentClaim(reg.attempt.attempt_token, reg.attempt.user_code, CLAIMED, NOW));
    // Not asserted: whether the approve waits its turn or finishes first.
    await settlesWithin(approve, 300);
    hold.release();
    const [polled, approved] = await Promise.all([poll, approve]);

    const where = `the poll answered ${polled.kind}, the approve ${approved.kind}`;
    expect(polled.kind, where).toBe("pending");
    expect(approved.kind, where).toBe("approved");
    const next = await auth(name).pollAgentClaim("clm_race", NOW + AGENT_POLL_INTERVAL_MS + 1);
    expect(next.kind, where).toBe("granted");
  });

  it("two polls on a claimed registration: exactly one is granted", async () => {
    const name = "agent-race-double";
    const reg = await register(name);
    expect((await auth(name).approveAgentClaim(reg.attempt.attempt_token, reg.attempt.user_code, CLAIMED, NOW)).kind)
      .toBe("approved");
    const hold = newHold();
    await holdFirstReadOf(name, "agentreg:clm_race", hold);

    const first = track(auth(name).pollAgentClaim("clm_race", NOW)); // reads the claimed row, then is held
    await until(() => hold.held, "the first poll to be held");
    const second = track(auth(name).pollAgentClaim("clm_race", NOW));
    await settlesWithin(second, 300);
    hold.release();
    const outcomes = (await Promise.all([first, second])).map((v) => v.kind);

    const where = `the polls answered ${outcomes.join(" and ")}`;
    expect(outcomes.filter((kind) => kind === "granted"), where).toHaveLength(1);
    expect(await keysUnder(name, "agentgrant:"), where).toHaveLength(1);
    expect(await count(name), where).toBe(0);
  });
});

describe("the sweep", () => {
  it("the alarm sweeps an expired registration and frees the cap", async () => {
    const name = "agent-sweep";
    await register(name);
    const alarm = await runInDurableObject<AuthDO, number | null>(auth(name), (_instance, ctx) => ctx.storage.getAlarm());
    expect(alarm, "admitAgentRegistration arms the sweep").not.toBeNull();
    expect(await count(name)).toBe(1);

    await runInDurableObject<AuthDO, void>(auth(name), async (instance) => {
      await instance.purgeStale(NOW + AGENT_REGISTRATION_TTL_MS + 1);
    });
    expect(await keysUnder(name, "agentreg:")).toEqual([]);
    expect(await keysUnder(name, "agentattempt:")).toEqual([]);
    expect(await count(name)).toBe(0);
  });
});
