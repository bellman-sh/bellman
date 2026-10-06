/**
 * A stale registry row is already inert: getSessionByJoinCode re-reads the
 * session and requires the code to still match a live joinCodes entry. The
 * direction that was open is the opposite one — a session holding a code the
 * registry never learned about, which nobody can join and no scan can find,
 * because a Durable Object namespace cannot be enumerated.
 *
 * Two things the assertions below depend on, so a failure can be read correctly.
 *
 * The registry is read through lookupJoinCode, never through getSessionByJoinCode.
 * The facade's lookup re-reads the session, so it answers "no" for a code the
 * registry still holds as readily as for one it never learned, and cannot show that a
 * removal was delivered.
 *
 * No test here needs an alarm to fire on its own. Each one that wants the alarm runs
 * it with runDurableObjectAlarm. Each that reads the registry straight after a call is
 * relying on OUTBOX_GRACE_MS to keep the real alarm five seconds out of the way, so the
 * inline delivery is the only thing that can have run. None of it relies on the accident
 * that fake timers make every alarm in the contract suite overdue, so that it fires at once.
 */
import { it, expect, afterEach } from "vitest";
import {
  env, reset, runInDurableObject, runDurableObjectAlarm, abortAllDurableObjects,
} from "cloudflare:test";
import { DurableObjectStore, type RegistryDO, type SessionDO } from "../src/store-do.js";
import {
  OUTBOX_GRACE_MS, OUTBOX_HANDLER, OUTBOX_PREFIX, dueKey, outboxKey, type OutboxRow,
} from "../src/outbox.js";
import { JOIN_CODE_TTL } from "../src/store.js";
// The shared fixture, not a hand-rolled literal: hydrateStoredSession returns
// undefined for a session whose manifest has no roles object, so a `manifest: null`
// fixture reads as GONE and every assertion below would fail against correct code.
import { member, oneCode, session } from "../tests/helpers/fixtures.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

const A = "BELL-AAAA-01";
const B = "BELL-BBBB-02";
const NEW = "BELL-NEWW-03";
const live = () => Date.now() + JOIN_CODE_TTL;

const sessionStub = (id: string) => env.SESSION.get(env.SESSION.idFromName(id));
const registry = () => env.REGISTRY.get(env.REGISTRY.idFromName("registry"));

/** A room holding a live code for each of two roles. */
const twoCodes = (id: string) =>
  session({
    id,
    joinCodes: { peer_b: { code: A, expiresAt: live() }, peer_a: { code: B, expiresAt: live() } },
  });

/** What the registry's index holds for each code: the session it names, or undefined. */
const indexed = (...codes: string[]) =>
  Promise.all(codes.map((code) => registry().lookupJoinCode(code)));

/** The rows still waiting to be delivered, in queue order. */
const queuedRows = (id: string) =>
  runInDurableObject(sessionStub(id), async (_i: SessionDO, ctx) => [
    ...(await ctx.storage.list<OutboxRow>({ prefix: OUTBOX_PREFIX })).values(),
  ]);

/** The same, as what each row asks the registry to do, without its random id. */
const queuedIntents = async (id: string) =>
  (await queuedRows(id)).map((row) => ({
    kind: row.kind, ...(row.payload as object), attempts: row.attempts,
  }));

/** Every row the object holds, so "nothing changed" means nothing at all. */
const everything = (id: string) =>
  runInDurableObject(sessionStub(id), async (_i: SessionDO, ctx) =>
    Object.fromEntries(await ctx.storage.list()));

/** When the object's one alarm is set for, or null when nothing is scheduled. */
const armedAlarm = (id: string) =>
  runInDurableObject(sessionStub(id), (_i: SessionDO, ctx) => ctx.storage.getAlarm());

/**
 * Move the alarm to a time no write here would choose. A call that arms one then shows
 * as a different time, where reading the alarm back after a call that armed the same
 * millisecond it already held would show nothing.
 */
const parkAlarm = async (id: string) => {
  const at = Date.now() + 3_600_000;
  await runInDurableObject(sessionStub(id), (_i: SessionDO, ctx) => ctx.storage.setAlarm(at));
  return at;
};

/** Put the session's expiry in the past, as alarms.test.ts does. */
const lapse = (id: string) =>
  runInDurableObject(sessionStub(id), async (_i: SessionDO, ctx) => {
    const stored = await ctx.storage.get<Record<string, unknown>>("session");
    await ctx.storage.put("session", { ...stored, expiresAt: Date.now() - 1 });
  });

/**
 * Turn the inline delivery off, on the instance the session's calls are served by. With
 * it off a write commits and queues what it owes and does not try to deliver it, which
 * is what the isolate going away just before that attempt would amount to. TypeScript's
 * `private` is a compile-time check, so the test can reach the field; nothing in the
 * production class exists for the purpose, and nothing public could, because every
 * method on a Durable Object is reachable over RPC.
 */
type Driver = { deliverNow?: () => Promise<void> };
const deliveryOff = (id: string) =>
  runInDurableObject(sessionStub(id), (instance: SessionDO) => {
    (instance as unknown as { driver: Driver }).driver.deliverNow = async () => {};
  });

/**
 * Make writes of one kind fail, wherever they are made: through the object's storage or
 * through a transaction opened on it. Which write fails is chosen by the keys it
 * carries. They live on that instance, and the abort in afterEach discards them.
 */
const failWritesTo = (id: string, prefix: string, onFail: () => void) =>
  runInDurableObject(sessionStub(id), async (_i: SessionDO, ctx) => {
    type Call = (...args: unknown[]) => Promise<unknown>;
    const wrap = (store: DurableObjectStorage | DurableObjectTransaction) => {
      const write = (store as unknown as { put: Call }).put.bind(store);
      Object.defineProperty(store, "put", {
        configurable: true,
        value: (...args: unknown[]) => {
          const entries = args[0];
          if (typeof entries === "object" && entries !== null
            && Object.keys(entries).some((k) => k.startsWith(prefix))) {
            onFail();
            throw new Error("interrupted");
          }
          return write(...args);
        },
      });
    };
    const storage = ctx.storage;
    wrap(storage);
    const open = (storage as unknown as { transaction: Call }).transaction.bind(storage);
    Object.defineProperty(storage, "transaction", {
      configurable: true,
      value: (closure: (txn: DurableObjectTransaction) => Promise<unknown>) =>
        open((txn: DurableObjectTransaction) => {
          wrap(txn);
          return closure(txn);
        }),
    });
  });

/**
 * Make the registry slow, or unable to take a join-code write, from the inside: every put
 * and delete of a `jc:` row waits `delayMs` and then goes through, or is refused while
 * `down` is set. The state is an object the test holds, so it can change its mind.
 */
const flaky = (how: { down: boolean; delayMs: number }) =>
  runInDurableObject(registry(), async (_i: RegistryDO, ctx) => {
    type Call = (...args: unknown[]) => Promise<unknown>;
    for (const method of ["put", "delete"]) {
      const real = (ctx.storage as unknown as Record<string, Call>)[method].bind(ctx.storage);
      Object.defineProperty(ctx.storage, method, {
        configurable: true,
        value: async (...args: unknown[]) => {
          if (typeof args[0] === "string" && args[0].startsWith("jc:")) {
            if (how.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, how.delayMs));
            if (how.down) throw new Error("registry down");
          }
          return real(...args);
        },
      });
    }
  });

/**
 * Take a field out of the session record, as a row written before the field existed
 * would lack it. hydrateStoredSession fills such a field back in on every read, so a call
 * that rewrote the row would put it back, and a call that did not leaves the row as it was.
 */
const without = (id: string, field: string) =>
  runInDurableObject(sessionStub(id), async (_i: SessionDO, ctx) => {
    const row = await ctx.storage.get<Record<string, unknown>>("session");
    const { [field]: _gone, ...rest } = row!;
    await ctx.storage.put("session", rest);
  });

it("registers a join code, so the room can be joined immediately", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(session({ id: "qs_join", joinCodes: oneCode(A, "peer_b") }));

  // Inline delivery, not the alarm: handing someone a code straight after
  // creating a room has to work.
  expect((await store.getSessionByJoinCode(A))?.role).toBe("peer_b");
  expect(await indexed(A)).toEqual(["qs_join"]);
  expect(await queuedRows("qs_join")).toEqual([]);
});

it("recovers a registration whose inline attempt never ran", async () => {
  const store = new DurableObjectStore(env as never);
  const id = "qs_lost";
  const before = Date.now();

  await deliveryOff(id);
  await store.createSession(session({ id, joinCodes: oneCode(A, "peer_b") }));
  // The alarm waits behind the inline attempt. That is what keeps it from racing the
  // attempt on every write, and what lets this test look at the queue before it fires.
  expect(await armedAlarm(id)).toBeGreaterThanOrEqual(before + OUTBOX_GRACE_MS);
  await abortAllDurableObjects();

  // Unjoinable, and the intent is still queued.
  expect(await store.getSessionByJoinCode(A)).toBeUndefined();
  expect(await indexed(A)).toEqual([undefined]);
  expect(await queuedIntents(id)).toEqual([
    { kind: "join_code_put", code: A, sessionId: id, attempts: 0 },
  ]);

  expect(await runDurableObjectAlarm(sessionStub(id))).toBe(true);

  expect((await store.getSessionByJoinCode(A))?.session.id).toBe(id);
  expect(await queuedRows(id)).toEqual([]);
});

/**
 * setJoinCode returns false for a frozen session and writes nothing. Queuing the
 * registration anyway would register a code for a room that refused to issue it, and
 * arming an alarm for rows that were never written would wake the object for nothing.
 * Both are checked: they are different mistakes, and the second leaves the queue empty.
 */
it("queues nothing, and arms nothing, when setJoinCode is refused", async () => {
  const store = new DurableObjectStore(env as never);
  const id = "qs_frozen";
  await store.createSession(session({ id, joinCodes: oneCode(A, "peer_b") }));
  await store.freezeSession(id, Date.now());
  const parked = await parkAlarm(id);
  const before = await everything(id);

  expect((await store.setJoinCode(id, "peer_b", NEW, live(), { replaceLive: true, now: Date.now() })).ok).toBe(false);

  expect(await everything(id)).toEqual(before);
  expect(await armedAlarm(id)).toBe(parked);
  expect(await store.getSessionByJoinCode(NEW)).toBeUndefined();
  // And the original code still resolves, so the emptiness above is about the refused
  // call rather than about registration being broken outright.
  expect((await store.getSessionByJoinCode(A))?.role).toBe("peer_b");
  expect(await indexed(A, NEW)).toEqual([id, undefined]);
});

it("queues nothing, and arms nothing, for a session that does not exist", async () => {
  const store = new DurableObjectStore(env as never);
  const id = "qs_nobody";

  expect((await store.setJoinCode(id, "peer_b", NEW, live(), { replaceLive: true, now: Date.now() })).ok).toBe(false);
  await store.consumeJoinCode(id, "peer_b");
  await store.clearJoinCodes(id);

  expect(await everything(id)).toEqual({});
  expect(await armedAlarm(id)).toBeNull();
  expect(await indexed(NEW)).toEqual([undefined]);
});

it("queues nothing, arms nothing and rewrites nothing, when there is no code to retire", async () => {
  const store = new DurableObjectStore(env as never);
  const withCode = "qs_one_code";
  const withNone = "qs_no_codes";
  await store.createSession(session({ id: withCode, joinCodes: oneCode(A, "peer_b") }));
  await store.createSession(session({ id: withNone, joinCodes: {} }));
  // Nothing may rewrite a row it has nothing to change in. The fixture's record already
  // carries frozenAt, so a rewrite would write back what was there; without it, one shows.
  await without(withCode, "frozenAt");
  await without(withNone, "frozenAt");
  const parked = [await parkAlarm(withCode), await parkAlarm(withNone)];
  const before = [await everything(withCode), await everything(withNone)];

  // A role that holds no code, and a room that holds none at all.
  await store.consumeJoinCode(withCode, "peer_a");
  await store.clearJoinCodes(withNone);

  expect([await everything(withCode), await everything(withNone)]).toEqual(before);
  expect([await armedAlarm(withCode), await armedAlarm(withNone)]).toEqual(parked);
  expect(await indexed(A)).toEqual([withCode]);
});

/**
 * The writes a join-code change owes the registry, for each way the code set changes.
 * `given` puts the room where the call starts, with delivery on so the setup is all in
 * the registry. `owes` is what the call must queue, in the order it must go out, and
 * `after` is what the registry's index must say of A, B and NEW once it has been
 * delivered. Both are checked, because they catch different mistakes: a row missing, a
 * code dropped that should have stayed, or a pair reversed, against a row that is right
 * and never sent.
 */
type Site = {
  name: string;
  given: (store: DurableObjectStore, id: string) => Promise<void>;
  act: (store: DurableObjectStore, id: string) => Promise<unknown>;
  owes: (id: string) => Array<Record<string, unknown>>;
  after: (id: string) => Array<string | undefined>;
};
const put = (code: string, id: string) =>
  ({ kind: "join_code_put", code, sessionId: id, attempts: 0 });
const drop = (code: string) => ({ kind: "join_code_drop", code, attempts: 0 });
const holdTwo = (store: DurableObjectStore, id: string) => store.createSession(twoCodes(id));

const CREATE: Site = {
  name: "createSession",
  given: async () => {},
  act: holdTwo,
  owes: (id) => [put(A, id), put(B, id)],
  after: (id) => [id, id, undefined],
};

const SITES: Site[] = [
  {
    name: "setJoinCode, replacing a role's code",
    given: holdTwo,
    act: (store, id) => store.setJoinCode(id, "peer_b", NEW, live(), { replaceLive: true, now: Date.now() }),
    // The drop goes ahead of the put, so the rotated-out code stops resolving before
    // its replacement starts and never the reverse.
    owes: (id) => [drop(A), put(NEW, id)],
    after: (id) => [undefined, id, id],
  },
  {
    name: "setJoinCode, for a role with no code",
    given: (store, id) => store.createSession(session({ id, joinCodes: oneCode(A, "peer_b") })),
    act: (store, id) => store.setJoinCode(id, "peer_a", NEW, live(), { replaceLive: true, now: Date.now() }),
    owes: (id) => [put(NEW, id)],
    after: (id) => [id, undefined, id],
  },
  {
    name: "consumeJoinCode",
    given: holdTwo,
    act: (store, id) => store.consumeJoinCode(id, "peer_b"),
    owes: () => [drop(A)],
    after: (id) => [undefined, id, undefined],
  },
  {
    name: "clearJoinCodes",
    given: holdTwo,
    act: (store, id) => store.clearJoinCodes(id),
    owes: () => [drop(A), drop(B)],
    after: () => [undefined, undefined, undefined],
  },
  {
    // The seat and the clearing are one transaction (#116), and this is the site whose
    // `act` is a seating and not a join-code call. The room holds one member and seats
    // two, nobody is stale, so the joiner takes the free seat and fills it. The contract
    // suite cannot see these rows, because the facade's lookup re-reads the session and
    // answers "no" for a code the registry still holds.
    name: "seatMember, when the seat fills the room",
    given: holdTwo,
    act: (store, id) => store.seatMember(
      id, member({ memberId: "m_late", userId: "u_late", roomRole: "peer_b" }), 1, Date.now(),
    ),
    owes: () => [drop(A), drop(B)],
    after: () => [undefined, undefined, undefined],
  },
  {
    name: "closeSession",
    given: holdTwo,
    act: (store, id) => store.closeSession(id),
    owes: () => [drop(A), drop(B)],
    after: () => [undefined, undefined, undefined],
  },
];

/**
 * Not in SITES: an expiry arms an alarm for the moment it is enforcing, which is already
 * past, so the real alarm comes within milliseconds and no test can look at the queue
 * before it does. Its queue is read in the failure and call-count tests below instead.
 */
const EXPIRY: Site = {
  name: "an expiry",
  given: async (store, id) => {
    await holdTwo(store, id);
    await lapse(id);
  },
  act: (store, id) => store.getSession(id),
  owes: () => [drop(A), drop(B)],
  after: () => [undefined, undefined, undefined],
};

it.each([CREATE, ...SITES, EXPIRY])(
  "$name delivers inline, so the registry is current when the call returns",
  async (site) => {
    const store = new DurableObjectStore(env as never);
    const id = "qs_inline";
    await site.given(store, id);

    await site.act(store, id);

    expect(await indexed(A, B, NEW)).toEqual(site.after(id));
    expect(await queuedRows(id)).toEqual([]);
  }
);

it.each([CREATE, ...SITES])(
  "$name queues what it owes, in order, and the alarm delivers it",
  async (site) => {
    const store = new DurableObjectStore(env as never);
    const id = "qs_queued";
    await site.given(store, id);
    await deliveryOff(id);

    await site.act(store, id);

    expect(await queuedIntents(id)).toEqual(site.owes(id));
    await abortAllDurableObjects();

    expect(await runDurableObjectAlarm(sessionStub(id))).toBe(true);

    expect(await indexed(A, B, NEW)).toEqual(site.after(id));
    expect(await queuedRows(id)).toEqual([]);
  }
);

/**
 * Re-issuing a code to the role that already holds it queues a drop and then a put of
 * the same code. In that order it ends registered. Reversed it would end dropped, with
 * the session still listing it: the room's own code, held and unresolvable.
 */
it("keeps a code registered when it is issued again to the role that holds it", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(session({ id: "qs_again", joinCodes: oneCode(A, "peer_b") }));

  expect((await store.setJoinCode("qs_again", "peer_b", A, live(), { replaceLive: true, now: Date.now() })).ok).toBe(true);

  expect(await indexed(A)).toEqual(["qs_again"]);
  expect((await store.getSessionByJoinCode(A))?.role).toBe("peer_b");
});

/**
 * An expiry through each way into it. A read that finds the session lapsed expires it,
 * and so does the alarm, and both have to take the room's codes out of the registry.
 * They are already inert once the session is closed, which is why the registry is read
 * directly: the facade's lookup would answer "no" with the rows still there.
 */
it("takes an expired room's codes out of the registry when the alarm expires it", async () => {
  const store = new DurableObjectStore(env as never);
  const id = "qs_lapsed";
  await store.createSession(twoCodes(id));
  await lapse(id);

  // createSession's backstop alarm, run now. It is the TTL handler that closes the room.
  expect(await runDurableObjectAlarm(sessionStub(id))).toBe(true);

  const raw = await runInDurableObject(sessionStub(id), (_i: SessionDO, ctx) =>
    ctx.storage.get<{ closed: boolean; joinCodes: object }>("session"));
  expect(raw).toMatchObject({ closed: true, joinCodes: {} });
  expect(await indexed(A, B)).toEqual([undefined, undefined]);
  expect(await queuedRows(id)).toEqual([]);
});

/**
 * The expiry arms an alarm for the moment it is enforcing, which is already past, so
 * the alarm would come back for the rows within milliseconds whether or not the expiry
 * drains them itself. That is an accident of where the alarm is dated. This pins the
 * intent: the expiry drains straight away, and does not bother when it queued nothing.
 * The call counts drains rather than delivering, in one callback with no I/O, so the
 * alarm cannot be the one counted.
 */
it.each([
  {
    name: "drains straight after an expiry, rather than leaving the rows to the alarm",
    room: twoCodes, drains: 1,
  },
  {
    name: "does not drain after an expiry that queued nothing",
    room: (id: string) => session({ id, joinCodes: {} }), drains: 0,
  },
])("$name", async ({ room, drains: expected }) => {
  const store = new DurableObjectStore(env as never);
  const id = "qs_drains";
  await store.createSession(room(id));
  await lapse(id);

  await runInDurableObject(sessionStub(id), async (instance: SessionDO, ctx) => {
    let drains = 0;
    (instance as unknown as { driver: Driver }).driver.deliverNow = async () => { drains++; };

    await instance.getSession();

    expect(drains).toBe(expected);
    // The stub never delivers, so leave no alarm behind to fire against it.
    await ctx.storage.deleteAlarm();
  });
});

/**
 * An expiry commits the closed flag and the event that announces it as one transaction
 * (#124), then wakes the polls waiting for it, with nothing in between that lets another
 * call in. Only then does it drain, and the drain waits on the registry, which does let
 * other calls in. Drained first, a read arriving while the registry answers would see the
 * room closed with no expiry event, and a poll waiting for that event would wait on the
 * registry too. A registry call made inside the transaction would hold the read until it
 * committed. The registry is slow here so there is time to look, and the read is issued
 * while it is still being told.
 */
it("shows an expiry's event to every call before it waits on the registry", async () => {
  const store = new DurableObjectStore(env as never);
  const id = "qs_midway";
  await store.createSession(twoCodes(id));
  await lapse(id);
  await flaky({ down: false, delayMs: 300 });
  let wokenAt = 0;
  const poll = store.waitForEvents(id, 0, 5_000).then((events) => {
    wokenAt = Date.now();
    return events;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const started = Date.now();
  let expiredAt = 0;
  const expiring = store.getSession(id).then(() => { expiredAt = Date.now(); });
  // Past the commit, inside the drain.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const midway = await store.getSession(id);
  // getSession no longer carries events (#25): it returns the session record
  // and members only, so a caller that wants history asks for it. Read before
  // midwayAt so the timing assertion below still measures the same window.
  const midwayEvents = await store.eventsAfter(id, 0);
  const midwayAt = Date.now();
  const woken = await poll;
  await expiring;

  expect(woken.map((e) => e.type)).toEqual(["session_expired"]);
  expect(midway?.closed).toBe(true);
  expect(midwayEvents.map((e) => e.type)).toEqual(["session_expired"]);
  // Both were answered while the registry was still being told. It takes two removals at
  // 300 ms each, so the drain finishes long after.
  expect(midwayAt - started).toBeLessThan(350);
  expect(wokenAt - started).toBeLessThan(350);
  expect(expiredAt - started).toBeGreaterThanOrEqual(550);
});

/**
 * The whole point of the change. The session write and the intent to register its codes
 * are one commit: if the write that carries one fails, the other must not be left behind,
 * in either direction. A session with no row is the code nothing can resolve. A row with
 * no session is a registration for a change that never happened. The alarm armed for the
 * rows has to go back with them.
 *
 * Which write fails is chosen by what it carries. Failing the rows catches a queue filled
 * in a commit of its own after the session's, and failing the session catches one filled
 * before it. All of them are one write today, so each fails the same way, and the
 * assertions cover both ends. closeSession is left out: it is two calls by design, and
 * the second is clearJoinCodes, which is here.
 */
const ATOMIC = [CREATE, ...SITES.filter((s) => s.name !== "closeSession"), EXPIRY].flatMap(
  (write) => [OUTBOX_PREFIX, "session"].map((prefix) => ({ ...write, prefix }))
);

it.each(ATOMIC)(
  "commits $name together with its registry writes or not at all, when a write to $prefix fails",
  async ({ given, act, prefix }) => {
    const store = new DurableObjectStore(env as never);
    const id = "qs_atomic";
    await given(store, id);
    const parked = await parkAlarm(id);
    const before = await everything(id);
    const indexBefore = await indexed(A, B, NEW);
    let attempts = 0;
    await failWritesTo(id, prefix, () => { attempts++; });

    await expect(act(store, id)).rejects.toThrow(/interrupted/);

    // The write the hook fails was made. Without it the rest proves nothing.
    expect(attempts).toBeGreaterThan(0);
    expect(await everything(id)).toEqual(before);
    expect(await armedAlarm(id)).toBe(parked);
    expect(await indexed(A, B, NEW)).toEqual(indexBefore);
  }
);

/**
 * Delivery waits for the registry, and nothing may hold the room while it does. Every
 * other call to this object waits for a transaction closure to commit, so a registry
 * call made inside one would hold every read of the room for as long as the registry
 * takes to answer. By then the write has committed, and a read is served while the
 * registry is still being told. The write answers only once the registry is current: a
 * delivery that was started and not waited for would return while the entry was still on
 * its way, and usually the read that follows would win the race anyway, which is why the
 * time the write takes is checked too.
 */
it.each([CREATE, ...SITES])(
  "$name serves other calls while it waits for the registry, and answers once it has",
  async (site) => {
    const store = new DurableObjectStore(env as never);
    const id = "qs_busy";
    await site.given(store, id);
    await flaky({ down: false, delayMs: 500 });

    const started = Date.now();
    const write = site.act(store, id);
    // Past the commit, inside the delivery.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const read = await store.getSession(id);
    const readTook = Date.now() - started;
    await write;
    const writeTook = Date.now() - started;

    expect(read).toBeDefined();
    expect(readTook).toBeLessThan(350);
    // The delivery did take that long, or being served early says nothing.
    expect(writeTook).toBeGreaterThanOrEqual(450);
    expect(await indexed(A, B, NEW)).toEqual(site.after(id));
  }
);

/**
 * The room's call answers, and the registration waits, when the registry cannot take it.
 * Before the queue, a registry that failed here failed createSession, after the session
 * had already committed. The row stays, counted as tried once, and delivers when the
 * registry is back and the time the retry was set for arrives.
 */
it("keeps the registration, and still answers, when the registry is down", async () => {
  const store = new DurableObjectStore(env as never);
  const id = "qs_down";
  const registryState = { down: true, delayMs: 0 };
  await flaky(registryState);

  await store.createSession(session({ id, joinCodes: oneCode(A, "peer_b") }));

  // Tried, and refused: the attempt count is how this knows the hook did the refusing.
  expect(await queuedIntents(id)).toEqual([
    { kind: "join_code_put", code: A, sessionId: id, attempts: 1 },
  ]);
  expect(await indexed(A)).toEqual([undefined]);

  // The registry comes back, and the time the retry was set for arrives. The backoff is
  // the driver's; this only lets it elapse.
  registryState.down = false;
  await runInDurableObject(sessionStub(id), (_i: SessionDO, ctx) =>
    ctx.storage.put({ [dueKey(OUTBOX_HANDLER)]: Date.now() - 1 }));
  expect(await runDurableObjectAlarm(sessionStub(id))).toBe(true);

  expect(await indexed(A)).toEqual([id]);
  expect(await queuedRows(id)).toEqual([]);
});

/**
 * Nothing but join-code rows is queued today, and a row of any other kind is not
 * something this object knows how to deliver. It has to stay queued rather than be
 * dropped: a row written by a build that knows more would otherwise be lost by one that
 * does not, which is what a rollback does.
 */
it("keeps a row of a kind it cannot deliver, rather than dropping it", async () => {
  const id = "qs_mystery";
  await runInDurableObject(sessionStub(id), async (_i: SessionDO, ctx) => {
    await ctx.storage.put<unknown>({
      [outboxKey(0)]: { id: "x", kind: "mystery", payload: {}, attempts: 0 } satisfies OutboxRow,
      [dueKey(OUTBOX_HANDLER)]: Date.now() - 1,
    });
    await ctx.storage.setAlarm(Date.now() + 60_000);
  });

  expect(await runDurableObjectAlarm(sessionStub(id))).toBe(true);

  // Tried once, and still here.
  expect(await queuedRows(id)).toMatchObject([{ id: "x", kind: "mystery", attempts: 1 }]);
});

/**
 * createSession arms the alarm for the queue and not for the TTL, because the TTL is
 * derived from a session that does not exist yet when the queue is armed. The TTL
 * follows when that alarm fires. A room created with a code must still end up armed for
 * its expiry, or it never expires: nothing else would come back for it.
 */
it("arms the TTL once the backstop has fired, for a room created with a join code", async () => {
  const store = new DurableObjectStore(env as never);
  const id = "qs_ttl_chain";
  const expiresAt = Date.now() + 3_600_000;
  await store.createSession(session({ id, expiresAt, joinCodes: oneCode(A, "peer_b") }));

  expect(await runDurableObjectAlarm(sessionStub(id))).toBe(true);

  expect(await armedAlarm(id)).toBe(expiresAt);
});

/**
 * The delivery is `#private`. TypeScript's `private` is erased at compile time, and a
 * Durable Object answers RPC for every method on its class, so a `private` one would
 * register any code against any session for anything holding the SESSION binding. The
 * forged row below is what that would look like. A method that is meant to be public
 * answers, so the refusal is about the method and not about the stub.
 */
it("does not answer over RPC for the delivery", async () => {
  const stub = sessionStub("qs_rpc") as unknown as
    Record<string, (...args: unknown[]) => Promise<unknown>>;
  expect(await stub.getSession()).toBeUndefined();

  const forged = {
    id: "x", kind: "join_code_put", attempts: 0,
    payload: { code: "BELL-EVIL-01", sessionId: "qs_victim" },
  };
  const outcome = await stub.deliver(forged).then(() => "answered", (err: unknown) => String(err));

  expect(outcome).toMatch(/does not implement/);
  // It did not run.
  expect(await indexed("BELL-EVIL-01")).toEqual([undefined]);
});

/**
 * The two methods that write what their caller hands them are `#private` as well.
 * expireIfDue overwrites the session record with the one it is given and queues the
 * removal of every code in it, and writeEvent writes the event it is given and any extra
 * rows. Called over RPC with a forged record they would rewrite this room's session and
 * reach into the registry's index, for anything holding the SESSION binding. The forged
 * record names another room's live code, so a removal that ran would show. Neither
 * answers, and neither ran: this object is still empty and the code is still registered.
 */
it("does not answer over RPC for the methods that write what their caller supplies", async () => {
  const store = new DurableObjectStore(env as never);
  const id = "qs_rpc_writes";
  await store.createSession(session({ id: "qs_victim", joinCodes: oneCode(A, "peer_b") }));
  const stub = sessionStub(id) as unknown as
    Record<string, (...args: unknown[]) => Promise<unknown>>;
  expect(await stub.getSession()).toBeUndefined();
  expect(await indexed(A)).toEqual(["qs_victim"]);

  // A record that is lapsed and open, so expireIfDue would act on it if it could be reached.
  const { events: _events, ...forged } = session({
    id, expiresAt: 1, joinCodes: { peer_b: { code: A, expiresAt: live() } },
  });
  const answered = (call: Promise<unknown>) =>
    call.then(() => "answered", (err: unknown) => String(err));
  const outcomes = {
    expireIfDue: await answered(stub.expireIfDue(forged, Date.now())),
    writeEvent: await answered(stub.writeEvent({ cursor: 1, type: "message" }, { "forged:row": 1 })),
  };

  expect(outcomes.expireIfDue).toMatch(/does not implement/);
  expect(outcomes.writeEvent).toMatch(/does not implement/);
  // Neither ran: nothing was written here, and the other room's code is still registered.
  expect(await everything(id)).toEqual({});
  expect(await indexed(A)).toEqual(["qs_victim"]);
});

/**
 * `wake` resolves every long-poll that is waiting with the event it is handed, and it is
 * `#private` as well. A Durable Object answers RPC for every method on its class, so a
 * TypeScript `private` one would let anything holding the SESSION binding put an event in
 * front of a waiting member that was never stored and never will be. The forged event
 * below is what a wake that ran would deliver. It is refused, and the poll is still
 * waiting afterwards: a real append is what wakes it, with the real event.
 */
it("does not answer over RPC for the method that wakes the waiting polls", async () => {
  const store = new DurableObjectStore(env as never);
  const id = "qs_rpc_wake";
  await store.createSession(session({ id, joinCodes: {} }));
  const stub = sessionStub(id) as unknown as
    Record<string, (...args: unknown[]) => Promise<unknown>>;
  // A public method answers, so the refusal below is about the method and not the stub.
  expect(await stub.eventsAfter(0)).toEqual([]);

  // A poll that is waiting. The forged wake has to arrive after it has registered, or it
  // finds no one to wake and shows nothing, so wait for the registration itself.
  const poll = store.waitForEvents(id, 0, 3_000);
  poll.catch(() => {}); // a failed test has the object torn down under it
  const waiting = () =>
    runInDurableObject(sessionStub(id), (instance: SessionDO) =>
      (instance as unknown as { waiters: unknown[] }).waiters.length);
  for (let tries = 0; tries < 400 && (await waiting()) === 0; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(await waiting()).toBe(1);

  const forged = {
    cursor: 1, type: "message", fromMemberId: "m_forged", fromUserId: "u_forged",
    fromLabel: "forged", payload: { text: "forged" }, refId: null, at: 1,
  };
  const outcome = await stub.wake(forged).then(() => "answered", (err: unknown) => String(err));
  expect(outcome).toMatch(/does not implement/);

  // It did not run: the poll has not been woken, and is still the one waiting.
  const woken = await Promise.race([
    poll.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
  ]);
  expect(woken).toBe(false);
  expect(await waiting()).toBe(1);
  // A real append wakes it, and it gets that event.
  const real = await store.appendEvent(id, {
    type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse",
    payload: { text: "real" }, refId: null,
  });
  expect(real).not.toBeNull();
  expect(await poll).toEqual([real]);
});

/**
 * The read-only methods converted in #126: `derivedDue`, which was the only one of the four with no
 * test reaching for it. `stored`, `nextCursor` and `events` are deliberately
 * not converted — see their docblocks in src/store-do.ts. Six tests patch those
 * three, on the prototype or on the instance, to open the windows they guard.
 * The #59/#62/#69 branch converted the
 * methods that WRITE to `#private`, because a Durable Object answers RPC for
 * every method on its class and TypeScript's `private` is erased at compile
 * time. These four were left as TypeScript-private on the grounds that they
 * only read, which is true and is not the same as harmless: `stored` hands back
 * the whole room record, every member's brief included.
 *
 * The exposure was redundant rather than new — everything these return is
 * reachable through the object's public reads — so this is tidying, and the
 * assertion is what keeps it tidy. Reverting any one conversion reddens it.
 */
it("does not answer over RPC for the one reader nothing patches", async () => {
  const store = new DurableObjectStore(env as never);
  const id = "qs_rpc_reads";
  await store.createSession(session({ id, joinCodes: {} }));
  const stub = sessionStub(id) as unknown as
    Record<string, (...args: unknown[]) => Promise<unknown>>;
  // A public read answers, so the refusals below are about the methods and not
  // the stub — without this the test would pass against a stub that answered
  // nothing at all.
  expect(await stub.eventsAfter(0)).toEqual([]);

  const answered = (call: Promise<unknown>) =>
    call.then(() => "answered", (err: unknown) => String(err));
  const outcomes = {
    derivedDue: await answered(stub.derivedDue()),
  };

  for (const [name, outcome] of Object.entries(outcomes)) {
    expect(outcome, name).toMatch(/does not implement/);
  }
});
