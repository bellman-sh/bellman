/**
 * Clearing lapsed registrations used to happen ON the registration request,
 * under a size bound. #51 took six rounds to make that safe — unbounded deletes,
 * two scans per refusal, starvation behind the first page, a cursorless listing
 * re-reading page one for ever, a `wrapped` flag that missed exact multiples of
 * the page size, and a cursor that does not bound a traversal new inserts can
 * extend. Each fix was right for what it answered and created the next.
 *
 * They are all the same shape: keyspace maintenance on a request, under a bound,
 * is a distributed traversal problem. It is on an alarm now (#87), which is what
 * SessionDO has always done for session TTL. AuthDO had no alarm at all.
 *
 * What these pin is the behaviour that replaced it: the object arms itself, the
 * alarm sweeps and re-arms, and the registration path does no scanning — a full
 * table brings the sweep forward instead.
 */
import { it, expect, afterEach, describe } from "vitest";
import { env, reset, runInDurableObject, runDurableObjectAlarm, abortAllDurableObjects } from "cloudflare:test";
import { type AuthDO } from "../src/oauth/store.js";
import { CLIENT_CAP, CLIENT_COUNT_KEY, SWEEP_INTERVAL_MS, type RegisteredClient } from "../src/oauth/storage.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

/**
 * Counts are asserted as DELTAS, never as absolutes.
 *
 * This pool does not give each test a clean authorization object: `reset()`
 * leaves what the previous test registered, and naming a different object per
 * test does not help either, so the first version of this file read 3 where it
 * had written 2. A delta says the thing actually under test — that the sweep
 * reclaimed exactly the lapsed one — without depending on isolation that is not
 * there.
 */
const authStub = () => env.AUTH.get(env.AUTH.idFromName("auth"));
const inAuth = <R>(run: (instance: AuthDO) => R | Promise<R>) =>
  runInDurableObject<AuthDO, R>(authStub(), run);

const client = (id: string, expires_at: number | null): RegisteredClient => ({
  client_id: id,
  redirect_uris: ["https://example.test/cb"],
  created_at: 1_000,
  expires_at,
});

/** When the object's alarm is pointed at, or null when it has none. */
const alarmAt = () => inAuth((i) =>
  (i as unknown as { ctx: { storage: { getAlarm(): Promise<number | null> } } }).ctx.storage.getAlarm());

describe("the authorization object sweeps on an alarm", () => {
  it("has no alarm until something is written", async () => {
    // The control for every assertion below. AuthDO had none before #87, so a
    // test that only ever saw one armed could not tell arming from inheriting.
    expect(await alarmAt()).toBeNull();
  });

  it("arms itself on the first registration", async () => {
    await inAuth((i) => i.registerClient(client("c_first", null)));

    const at = await alarmAt();
    expect(at).not.toBeNull();
    // At the interval, not sooner: nothing is known to be reclaimable yet.
    expect(at! - Date.now()).toBeGreaterThan(SWEEP_INTERVAL_MS / 2);
    expect(at! - Date.now()).toBeLessThanOrEqual(SWEEP_INTERVAL_MS);
  });

  it("reclaims a lapsed registration when the alarm fires, and re-arms", async () => {
    const before = await inAuth((i) => i.countClients());
    await inAuth(async (i) => {
      await i.registerClient(client("c_live", null));
      await i.registerClient(client("c_lapsed", 1_000)); // expires_at in the past
    });
    expect(await inAuth((i) => i.countClients())).toBe(before + 2);

    expect(await runDurableObjectAlarm(authStub())).toBe(true);

    // One reclaimed, not both and not none. `countClients` returns
    // `#clientCount()`, which is CLIENT_COUNT_KEY itself — the number the cap
    // reads — so this is the space coming back and not just keys going away.
    expect(await inAuth((i) => i.countClients())).toBe(before + 1);
    expect(await inAuth((i) => i.getClient("c_live"))).toBeDefined();
    expect(await inAuth((i) => i.getClient("c_lapsed"))).toBeUndefined();
    // Re-armed, or the object sweeps once and never again — and nothing else
    // here would notice.
    expect(await alarmAt()).not.toBeNull();
  });

});

describe("a refusal still schedules maintenance", () => {
  /**
   * A refusal still leaves the object with a sweep scheduled.
   *
   * `admitRegistration` reclaims inline when the cap is in the way, so a table
   * of lapsed records does not need the alarm to admit a real client — #174
   * covers that, inside the transaction. What the alarm is for is the table
   * nobody is currently registering against, and a refused registration is
   * exactly the moment an object most needs maintenance scheduled: it is full,
   * and the caller is going away.
   */
  it("arms the sweep even when it refuses the registration", async () => {
    await inAuth((i) =>
      (i as unknown as { ctx: { storage: { deleteAlarm(): Promise<void> } } }).ctx.storage.deleteAlarm());
    await inAuth(async (i) => {
      // Full by the counter, with no real keys, so there is nothing to reclaim
      // and the refusal is the outcome under test.
      const storage = (i as unknown as { ctx: { storage: { put(k: string, v: unknown): Promise<void> } } }).ctx.storage;
      await storage.put(CLIENT_COUNT_KEY, CLIENT_CAP);
    });

    const admitted = await inAuth((i) =>
      i.admitRegistration(client("c_new", null), "203.0.113.9", Date.now()));

    expect(admitted).toBe("full");
    expect(await inAuth((i) => i.getClient("c_new"))).toBeUndefined();
    expect(await alarmAt()).not.toBeNull();
  });

  it("admits normally when there is room, without touching the alarm's urgency", async () => {
    await inAuth((i) => i.registerClient(client("c_seed", null)));
    const before = await alarmAt();

    const admitted = await inAuth((i) =>
      i.admitRegistration(client("c_ok", null), "203.0.113.10", Date.now()));

    expect(admitted).toBe("ok");
    expect(await inAuth((i) => i.getClient("c_ok"))).toBeDefined();
    // Arming never moves an alarm later, and an ordinary admission has no reason
    // to move it earlier.
    expect((await alarmAt())!).toBeLessThanOrEqual(before!);
  });
});
