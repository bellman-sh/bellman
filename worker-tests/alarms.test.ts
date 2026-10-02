/**
 * SessionDO's TTL used to own the object's single alarm outright. It now shares
 * it by name, and this file is the proof that sharing did not lose it — for
 * sessions created before the change as well as after.
 */
import { it, expect, afterEach } from "vitest";
import { env, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { DurableObjectStore, type SessionDO } from "../src/store-do.js";
import { DUE_PREFIX } from "../src/outbox.js";
import { session } from "../tests/helpers/fixtures.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

/**
 * The shared fixture rather than a hand-rolled object. hydrateStoredSession reads
 * a row with no manifest as gone, so a session without one is invisible to
 * SessionDO.stored() and its TTL is never derived: every test below would then
 * fail, or pass, because the session was unreadable and not for the reason it
 * names. No join codes, so createSession queues no outbox row and sets no
 * `due:outbox` marker, and the TTL is the only thing that arms this object's alarm.
 * The registry is not out of it: the facade still writes the creator's `us:` index
 * row there, but that touches neither this object's alarm nor its storage.
 */
const room = (id: string, expiresAt: number) => session({ id, expiresAt, joinCodes: {} });

it("arms the session TTL through the named-alarm path", async () => {
  const store = new DurableObjectStore(env as never);
  const at = Date.now() + 3_600_000;
  await store.createSession(room("qs_ttl", at));

  await runInDurableObject(
    env.SESSION.get(env.SESSION.idFromName("qs_ttl")),
    async (_i: SessionDO, ctx) => {
      expect(await ctx.storage.getAlarm()).toBe(at);
    }
  );
});

/**
 * The migration case. A session written before named alarms has no `due:` row,
 * only its expiresAt. Re-arming from stored rows alone would leave it with no
 * alarm at all and it would never expire — silently, because nothing reads an
 * alarm back.
 */
it("still expires a session that has no stored due row", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_legacy", Date.now() + 3_600_000));

  const stub = env.SESSION.get(env.SESSION.idFromName("qs_legacy"));
  await runInDurableObject(stub, async (_i: SessionDO, ctx) => {
    // Forge the pre-migration shape: expired, not one `due:` row anywhere, and the
    // alarm that would have fired already consumed, as workerd consumes it.
    const stored = await ctx.storage.get<Record<string, unknown>>("session");
    await ctx.storage.put("session", { ...stored, expiresAt: Date.now() - 1 });
    for (const key of (await ctx.storage.list({ prefix: DUE_PREFIX })).keys()) {
      await ctx.storage.delete(key);
    }
    await ctx.storage.deleteAlarm();
    expect([...(await ctx.storage.list({ prefix: DUE_PREFIX })).keys()]).toEqual([]);
  });

  await runInDurableObject(stub, (instance: SessionDO) => instance.alarm());

  // The raw rows, not store.getSession(): a read expires a lapsed session lazily,
  // so it would report this one closed even if alarm() had done nothing.
  const after = await runInDurableObject(stub, async (_i: SessionDO, ctx) => ({
    closed: (await ctx.storage.get<{ closed: boolean }>("session"))?.closed,
    lastEvent: [...(await ctx.storage.list<{ type: string }>({ prefix: "e:" })).values()].at(-1),
  }));
  expect(after.closed).toBe(true);
  expect(after.lastEvent).toMatchObject({ type: "session_expired" });

  // Nothing is left to wait for, so no alarm may fire from here on. A closed session
  // that still derived its TTL would re-arm to a time already past, and the alarm
  // would fire again for as long as the object lived. Counted rather than read back
  // with getAlarm(): a past alarm is consumed the moment it fires, so a read sees
  // nothing armed while the loop runs.
  let refired = 0;
  await runInDurableObject(stub, (instance: SessionDO) => {
    const real = instance.alarm.bind(instance);
    instance.alarm = async () => {
      refired++;
      await real();
    };
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(refired).toBe(0);
});

/**
 * A fired alarm is consumed, so an alarm() that does not point it again leaves a
 * live session with no alarm and no expiry: the same silent loss as the migration
 * case, reached by another road. It is the road every other handler on this
 * object will take, because each of them wakes alarm() for a session that is not
 * yet due.
 */
it("leaves the TTL armed after an alarm that had nothing to expire", async () => {
  const store = new DurableObjectStore(env as never);
  const at = Date.now() + 3_600_000;
  await store.createSession(room("qs_live", at));

  await runInDurableObject(
    env.SESSION.get(env.SESSION.idFromName("qs_live")),
    async (instance: SessionDO, ctx) => {
      await ctx.storage.deleteAlarm();
      await instance.alarm();
      expect(await ctx.storage.getAlarm()).toBe(at);
    }
  );
});
