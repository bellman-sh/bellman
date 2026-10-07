/**
 * The blob charge where the contract cannot see it (#183, D3).
 *
 * `tests/helpers/store-contract.ts` runs `chargeBlobBytes` against both stores, but
 * its TTL case reaches the Durable Object's `s.closed` and not `readsClosed`: a room
 * created already past its TTL has been closed by the alarm before the charge
 * arrives. The window `readsClosed` exists for, past the TTL with the alarm still to
 * come, has to be made by hand, the way alarms.test.ts makes its own states.
 */
import { it, expect, afterEach } from "vitest";
import { env, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { DurableObjectStore, type SessionDO } from "../src/store-do.js";
import { session } from "../tests/helpers/fixtures.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

it("answers closed to a charge on a room past its TTL whose alarm has not fired", async () => {
  const store = new DurableObjectStore(env as never);
  // No join codes, so createSession queues no outbox row and the TTL is the only thing
  // that arms this object's alarm (alarms.test.ts's `room`).
  await store.createSession(session({ id: "qs_late", expiresAt: Date.now() + 3_600_000, joinCodes: {} }));
  const stub = env.SESSION.get(env.SESSION.idFromName("qs_late"));

  // Past its TTL and the alarm gone: the state between `expiresAt` and the alarm's delivery.
  await runInDurableObject(stub, async (_i: SessionDO, ctx) => {
    const stored = await ctx.storage.get<Record<string, unknown>>("session");
    await ctx.storage.put("session", { ...stored, expiresAt: Date.now() - 1 });
    await ctx.storage.deleteAlarm();
  });

  // The raw row, not getSession(): a read expires a lapsed room as a side effect. This is the
  // control: nothing has written the close, so the answer below can only come from the TTL read.
  const closedOnDisk = () =>
    runInDurableObject(stub, async (_i: SessionDO, ctx) =>
      (await ctx.storage.get<{ closed: boolean }>("session"))?.closed);
  expect(await closedOnDisk(), "nothing has written the close yet").toBe(false);

  expect(await store.chargeBlobBytes("qs_late", 1)).toEqual({ ok: false, reason: "closed", used: 0 });
});
