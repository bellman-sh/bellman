/**
 * The blob charge where the contract cannot see it (#183, D3).
 *
 * `tests/helpers/store-contract.ts` runs `chargeBlobBytes` against both stores, but
 * its abandonment case reaches the Durable Object's `s.closed` and not `readsClosed`:
 * a room created already abandoned (#18) has been closed by the alarm before the
 * charge arrives. The window `readsClosed` exists for, abandoned with the alarm still
 * to come, has to be made by hand, the way alarms.test.ts makes its own states.
 */
import { it, expect, afterEach } from "vitest";
import { env, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { DurableObjectStore, type SessionDO } from "../src/store-do.js";
import { ABANDONED_AFTER_MS } from "../src/presence.js";
import type { Member } from "../src/types.js";
import { session } from "../tests/helpers/fixtures.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

it("answers closed to a charge on an abandoned room whose alarm has not fired", async () => {
  const store = new DurableObjectStore(env as never);
  // No join codes, so createSession queues no outbox row and the abandonment time is
  // the only thing that arms this object's alarm (alarms.test.ts's `room`).
  await store.createSession(session({ id: "qs_late", joinCodes: {} }));
  const stub = env.SESSION.get(env.SESSION.idFromName("qs_late"));

  // Every member last seen past the window, and the alarm gone: the state between
  // the window closing and the alarm's delivery.
  await runInDurableObject(stub, async (_i: SessionDO, ctx) => {
    const stored = await ctx.storage.get<{ members: Member[] }>("session");
    const aged = stored!.members.map((m) => ({ ...m, lastSeenAt: Date.now() - ABANDONED_AFTER_MS - 1 }));
    await ctx.storage.put("session", { ...stored, members: aged });
    await ctx.storage.deleteAlarm();
  });

  // The raw row, not getSession(): a read closes an abandoned room as a side effect. This
  // is the control: nothing has written the close, so the answer below can only come from
  // the abandonment read.
  const closedOnDisk = () =>
    runInDurableObject(stub, async (_i: SessionDO, ctx) =>
      (await ctx.storage.get<{ closed: boolean }>("session"))?.closed);
  expect(await closedOnDisk(), "nothing has written the close yet").toBe(false);

  expect(await store.chargeBlobBytes("qs_late", 1)).toEqual({ ok: false, reason: "closed", used: 0 });
});
