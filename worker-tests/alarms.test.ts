/**
 * SessionDO's abandonment time shares the object's single alarm by name with the
 * outbox and the heartbeat, and this file is the proof that sharing did not lose
 * it — for sessions created before named alarms as well as after.
 */
import { it, expect, afterEach } from "vitest";
import { env, SELF, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { DurableObjectStore, type SessionDO } from "../src/store-do.js";
import { DUE_PREFIX } from "../src/outbox.js";
import { ABANDONED_AFTER_MS } from "../src/presence.js";
import type { Member } from "../src/types.js";
import { member, session } from "../tests/helpers/fixtures.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

/**
 * A room whose one member was last seen at `lastSeenAt`; the window runs from there.
 *
 * The shared fixture rather than a hand-rolled object. hydrateStoredSession reads
 * a row with no manifest as gone, so a session without one is invisible to
 * SessionDO.stored() and its abandonment time is never derived: every test below
 * would then fail, or pass, because the session was unreadable and not for the
 * reason it names. No join codes, so createSession queues no outbox row and sets no
 * `due:outbox` marker, and the abandonment time is the only thing that arms this
 * object's alarm. The registry is not out of it: the facade still writes the
 * creator's `us:` index row there, but that touches neither this object's alarm nor
 * its storage.
 */
const room = (id: string, lastSeenAt: number) =>
  session({ id, joinCodes: {}, members: [member({ lastSeenAt })] });

const KEY = "qk_ws_test";

/** The upgrade through the real route: auth, membersOf, then the object. */
async function open(id: string): Promise<WebSocket> {
  const res = await SELF.fetch(`https://bellman.test/ws?session=${id}&cursor=0`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${KEY}` },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  return ws;
}

it("arms the abandonment time through the named-alarm path", async () => {
  const store = new DurableObjectStore(env as never);
  const seen = Date.now() - 1_000;
  await store.createSession(room("qs_abandoned", seen));

  await runInDurableObject(
    env.SESSION.get(env.SESSION.idFromName("qs_abandoned")),
    async (_i: SessionDO, ctx) => {
      expect(await ctx.storage.getAlarm()).toBe(seen + ABANDONED_AFTER_MS);
    }
  );
});

/**
 * The migration case. A session written before named alarms has no `due:` row,
 * only its members' lastSeenAt. Re-arming from stored rows alone would leave it
 * with no alarm at all and it would never be swept — silently, because nothing
 * reads an alarm back.
 */
it("still closes an abandoned room that has no stored due row, and ignores a legacy expiresAt", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_legacy", Date.now()));

  const stub = env.SESSION.get(env.SESSION.idFromName("qs_legacy"));
  await runInDurableObject(stub, async (_i: SessionDO, ctx) => {
    // Forge the pre-migration shape: abandoned, not one `due:` row anywhere, and the
    // alarm that would have fired already consumed, as workerd consumes it.
    const stored = await ctx.storage.get<{ members: Member[] }>("session");
    // The pre-#18 shape as well: a clock in the past, which nothing reads any more.
    await ctx.storage.put("session", {
      ...stored, expiresAt: Date.now() - 1,
      members: stored!.members.map((m) => ({ ...m, lastSeenAt: 1 })),
    });
    for (const key of (await ctx.storage.list({ prefix: DUE_PREFIX })).keys()) {
      await ctx.storage.delete(key);
    }
    await ctx.storage.deleteAlarm();
    expect([...(await ctx.storage.list({ prefix: DUE_PREFIX })).keys()]).toEqual([]);
  });

  await runInDurableObject(stub, (instance: SessionDO) => instance.alarm());

  // The raw rows, not store.getSession(): a read closes an abandoned room lazily,
  // so it would report this one closed even if alarm() had done nothing.
  const after = await runInDurableObject(stub, async (_i: SessionDO, ctx) => ({
    closed: (await ctx.storage.get<{ closed: boolean }>("session"))?.closed,
    lastEvent: [...(await ctx.storage.list<{ type: string }>({ prefix: "e:" })).values()].at(-1),
  }));
  expect(after.closed).toBe(true);
  expect(after.lastEvent).toMatchObject({ type: "session_expired" });

  // Nothing is left to wait for, so no alarm may fire from here on. A closed session
  // that still derived its abandonment time would re-arm to a time already past, and
  // the alarm would fire again for as long as the object lived. Counted rather than
  // read back with getAlarm(): a past alarm is consumed the moment it fires, so a
  // read sees nothing armed while the loop runs.
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
 * live session with no alarm, never to be swept: the same silent loss as the
 * migration case, reached by another road. It is the road every other handler on
 * this object will take, because each of them wakes alarm() for a session that is
 * not yet due.
 */
it("leaves the abandonment time armed after an alarm that had nothing to close", async () => {
  const store = new DurableObjectStore(env as never);
  const seen = Date.now() - 1_000;
  await store.createSession(room("qs_live", seen));

  await runInDurableObject(
    env.SESSION.get(env.SESSION.idFromName("qs_live")),
    async (instance: SessionDO, ctx) => {
      await ctx.storage.deleteAlarm();
      await instance.alarm();
      expect(await ctx.storage.getAlarm()).toBe(seen + ABANDONED_AFTER_MS);
    }
  );
});

/**
 * Review Focus 1, through a real socket. The alarm finds the room past its window
 * and a socket vouching for its member: it stamps and re-arms a window ahead,
 * and the room is not closed. The fixture's member is u_jesse, which is the
 * identity KEY carries, so the socket vouches for it.
 */
it("stamps and re-arms instead of closing when a socket vouches for a member", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_held", Date.now()));
  const stub = env.SESSION.get(env.SESSION.idFromName("qs_held"));
  // Opened while the room is fresh, then aged under it: the route and fetch refuse an
  // upgrade onto a room that already reads closed, and an aged room with no socket does.
  await open("qs_held");
  await runInDurableObject(stub, async (_i: SessionDO, ctx) => {
    const stored = await ctx.storage.get<{ members: Member[] }>("session");
    await ctx.storage.put("session", {
      ...stored, members: stored!.members.map((m) => ({ ...m, lastSeenAt: 1 })),
    });
  });
  const before = Date.now();

  await runInDurableObject(stub, (instance: SessionDO) => instance.alarm());

  const after = await runInDurableObject(stub, async (_i: SessionDO, ctx) => ({
    session: await ctx.storage.get<{ closed: boolean; members: { lastSeenAt: number }[] }>("session"),
    alarm: await ctx.storage.getAlarm(),
    events: [...(await ctx.storage.list({ prefix: "e:" })).keys()],
  }));
  expect(after.session!.closed).toBe(false);
  expect(after.session!.members[0].lastSeenAt).toBeGreaterThanOrEqual(before);
  expect(after.events).toEqual([]);
  expect(after.alarm).toBeGreaterThanOrEqual(before + ABANDONED_AFTER_MS);
});
