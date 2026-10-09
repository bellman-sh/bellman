import { it, expect, afterEach, beforeEach, vi } from "vitest";
import { env, reset, runInDurableObject, runDurableObjectAlarm, abortAllDurableObjects } from "cloudflare:test";
import { DurableObjectStore, type SessionDO } from "../src/store-do.js";
import type { HostDO } from "../src/host-do.js";
import { HOST_MEMBER_ID, hostMember, ANTHROPIC_MESSAGES_URL, type HostRecord, type HostWake } from "../src/host.js";
import { monthKey } from "../src/stored-session.js";
import type { SessionEvent } from "../src/types.js";
import { member, roomManifest, session } from "../tests/helpers/fixtures.js";

const hosted = () => roomManifest({ mode: "swarm", preset: null, heartbeatOnMs: 3_600_000,
  roles: { lead: { can: ["send", "invite"], description: null, reports: false }, host: { can: ["send"], description: null, reports: false } },
  defaultRole: "lead", creatorRole: "lead", host: { role: "host", model: "haiku", instructions: null } });

/**
 * The model, stubbed at `fetch`. `fetchMock` left `cloudflare:test` at pool 0.22.0; the
 * pool runs this Worker's objects in the test's own isolate, so `HostDO` calls this.
 * Only a POST to the Messages API matches, one queued reply each, in order. Anything
 * else throws, as `disableNetConnect` did, and is recorded: the seat retries a model it
 * cannot reach, so the throw alone would not fail a case. A stray call or a reply left
 * unread fails the test in `afterEach`, as `assertNoPendingInterceptors` did. A held
 * reply (`modelHolds`) is given only once the test releases it.
 *
 * The hold is a flag polled on a timer, not a promise: a promise made in the test's
 * request and awaited in the seat's alarm crosses workerd request contexts, and the
 * runtime crashes ("Promise callback destroyed itself").
 */
type Reply = { status: number; text: string; held?: boolean; asked?: boolean };
const replies: Reply[] = [];
const stray: string[] = [];
const modelAnswers = (text: string, status = 200) => { replies.push({ status, text }); };

/** A reply the model gives only once `release` is called. `asked()` waits until the seat has called for it. */
function modelHolds(text: string) {
  const reply: Reply = { status: 200, text, held: true, asked: false };
  replies.push(reply);
  return {
    asked: () => vi.waitFor(() => expect(reply.asked).toBe(true), { timeout: 5_000, interval: 5 }),
    release: () => { reply.held = false; },
  };
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const reply = req.method === "POST" && req.url === ANTHROPIC_MESSAGES_URL ? replies.shift() : undefined;
    if (!reply) {
      stray.push(`${req.method} ${req.url}`);
      throw new Error(`the model stub has no reply for ${req.method} ${req.url}`);
    }
    reply.asked = true;
    while (reply.held) await new Promise((r) => setTimeout(r, 5));
    return Response.json(reply.status === 200 ? { content: [{ type: "text", text: reply.text }] } : { error: { type: "rate_limit" } },
      { status: reply.status });
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  const unread = replies.splice(0);
  const calls = stray.splice(0);
  await reset();
  await abortAllDurableObjects();
  expect(calls, "model calls no case queued a reply for").toEqual([]);
  expect(unread, "model replies queued and never read").toEqual([]);
});

async function hostedRoom(id = "qs_hosted") {
  const store = new DurableObjectStore(env as never);
  const m = hosted();
  const now = Date.now();
  const s = session({ id, manifest: m, members: [member({ lastSeenAt: now }), hostMember(m, now)], joinCodes: {},
    hostUnitsPerMonth: 10, hostUnits: { month: monthKey(now), used: 0, wakes: [] } });
  await store.createSession(s);
  return { store, id, stub: env.SESSION.get(env.SESSION.idFromName(id)), host: env.HOST.get(env.HOST.idFromName(id)) };
}

/** Fire the room's heartbeat the way the alarm does: a tick lands, and a wake is queued and delivered. */
async function tick(stub: DurableObjectStub<SessionDO>) {
  await runInDurableObject(stub, async (i: SessionDO, ctx) => {
    const s = await ctx.storage.get<{ lastTickAt?: number }>("session");
    await ctx.storage.put("session", { ...s, lastTickAt: Date.now() - 3_600_000 - 1 });
  });
  await runDurableObjectAlarm(stub);
}

/** Wait for the seat to drain its queue: nothing pending and no alarm armed. The alarm it arms for now fires by itself. */
const seatIdle = (host: DurableObjectStub<HostDO>) =>
  vi.waitFor(async () => {
    const [pending, alarm] = await runInDurableObject(host, async (_i: HostDO, ctx) =>
      [await ctx.storage.get<HostWake[]>("pending"), await ctx.storage.getAlarm()] as const);
    expect(pending ?? []).toEqual([]);
    expect(alarm).toBeNull();
  }, { timeout: 5_000, interval: 10 });

/** Wait for the seat to back off: its alarm armed for a retry, a backoff ahead rather than now. */
const retryArmed = (host: DurableObjectStub<HostDO>) =>
  vi.waitFor(async () => {
    const alarm = await runInDurableObject(host, async (_i: HostDO, ctx) => ctx.storage.getAlarm());
    expect(alarm).toBeGreaterThan(Date.now() + 30_000);
  }, { timeout: 5_000, interval: 10 });

/** What the host has written into the room after `cursor`. */
const hostSaid = async (store: DurableObjectStore, id: string, cursor = 0) =>
  (await store.eventsAfter(id, cursor)).filter((e) => e.fromMemberId === HOST_MEMBER_ID);

/**
 * Append through the room with its outbox's inline delivery held, as heartbeat-tick.test.ts's
 * `fireHeld` holds a tick's: the wake the event owes stays queued, so the test delivers it itself.
 */
const appendHeld = (stub: DurableObjectStub<SessionDO>, e: Omit<SessionEvent, "cursor" | "at">) =>
  runInDurableObject(stub, async (i: SessionDO) => {
    const driver = (i as unknown as { driver: { deliverNow(): Promise<void> } }).driver;
    const deliverNow = driver.deliverNow;
    driver.deliverNow = async () => {};
    try {
      return (await i.appendEvent(e))!;
    } finally {
      driver.deliverNow = deliverNow;
    }
  });

const replyTo = (cursor: number): Omit<SessionEvent, "cursor" | "at"> =>
  ({ type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: { text: "a parser" }, refId: String(cursor) });
const heartbeat: Omit<SessionEvent, "cursor" | "at"> =
  { type: "heartbeat", fromMemberId: "system", fromUserId: "system", fromLabel: "bellman", payload: {}, refId: null };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

it("a tick wakes the host, which asks a question in the room with the tick as its ref", async () => {
  const { store, id, stub, host } = await hostedRoom();
  modelAnswers("What did you ship this week?");
  await tick(stub);
  await seatIdle(host);
  const events = await store.eventsAfter(id, 0);
  const heartbeat = events.find((e) => e.type === "heartbeat")!;
  const q = events.find((e) => e.fromMemberId === HOST_MEMBER_ID)!;
  expect(q).toMatchObject({ type: "message", refId: String(heartbeat.cursor), payload: { kind: "question", text: "What did you ship this week?" } });
  expect((await store.getSession(id))!.hostUnits.used).toBe(1);
});

it("a reply wakes the host, which answers in the thread", async () => {
  const { store, id, stub, host } = await hostedRoom();
  modelAnswers("Ask me anything.");
  await tick(stub);
  await seatIdle(host);
  const q = (await store.eventsAfter(id, 0)).find((e) => e.fromMemberId === HOST_MEMBER_ID)!;
  modelAnswers("Nice, tell us more.");
  await store.appendEvent(id, { type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: { text: "a parser" }, refId: String(q.cursor) });
  await seatIdle(host);
  const answer = (await store.eventsAfter(id, q.cursor)).find((e) => e.fromMemberId === HOST_MEMBER_ID)!;
  expect(answer).toMatchObject({ refId: String(q.cursor), payload: { kind: "answer", text: "Nice, tell us more." } });
  expect((await store.getSession(id))!.hostUnits.used).toBe(2);
});

it("backs off on a 429 and asks on the retry; a redelivered wake asks nothing twice", async () => {
  const { store, id, stub, host } = await hostedRoom();
  modelAnswers("", 429);
  await tick(stub);
  await retryArmed(host);
  expect((await store.eventsAfter(id, 0)).filter((e) => e.fromMemberId === HOST_MEMBER_ID)).toEqual([]);
  const armed = await runInDurableObject(host, async (_i: HostDO, ctx) => ctx.storage.getAlarm());
  expect(armed).not.toBeNull();
  modelAnswers("Second try.");
  await runDurableObjectAlarm(host);
  const asked = (await store.eventsAfter(id, 0)).filter((e) => e.fromMemberId === HOST_MEMBER_ID);
  expect(asked).toHaveLength(1);
  const heartbeat = (await store.eventsAfter(id, 0)).find((e) => e.type === "heartbeat")!;
  await host.wake({ sessionId: id, cause: "tick", cursor: heartbeat.cursor }, "host:tick:redelivered");
  await seatIdle(host);
  expect((await store.eventsAfter(id, 0)).filter((e) => e.fromMemberId === HOST_MEMBER_ID)).toHaveLength(1);
});

/**
 * Evicting the host is the creator's off-switch (C1): neither a reply nor a tick queues a
 * wake for a host the room has evicted, and a wake delivered to it anyway calls no model.
 * No model reply is queued after the first question, so any call would be a stray one.
 */
it("an evicted host is woken by neither a reply nor a tick, and a wake delivered anyway asks nothing", async () => {
  const { store, id, stub, host } = await hostedRoom("qs_hosted_evicted");
  modelAnswers("What did you ship this week?");
  await tick(stub);
  await seatIdle(host);
  const [q] = await hostSaid(store, id);
  const beat = (await store.eventsAfter(id, 0)).find((e) => e.type === "heartbeat")!;
  expect((await store.removeMember(id, HOST_MEMBER_ID, {
    now: Date.now(), frozen: "refuse", cut: true, byUserId: "u_jesse", audit: [],
    event: { type: "member_evicted", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd",
      payload: { member_id: HOST_MEMBER_ID }, refId: null },
  })).removed).toBe(true);

  await store.appendEvent(id, replyTo(q.cursor));
  await tick(stub);
  await seatIdle(host);
  const record = await runInDurableObject(host, async (_i: HostDO, ctx) => ctx.storage.get<HostRecord>("state"));
  expect(record!.lastCause, "no wake reached the seat after the eviction").toBe(beat.cursor);

  await host.wake({ sessionId: id, cause: "tick", cursor: 999 }, "host:tick:999");
  await seatIdle(host);
  expect(await hostSaid(store, id, q.cursor)).toEqual([]);
  expect((await store.getSession(id))!.hostUnits.used).toBe(1);
});

it("drops a wake for a frozen room without calling the model", async () => {
  const { store, id, stub, host } = await hostedRoom();
  await store.freezeSession(id, Date.now());
  await host.wake({ sessionId: id, cause: "tick", cursor: 1 }, "host:tick:1");
  await seatIdle(host);
  expect(await store.eventsAfter(id, 0)).toEqual([]);
  void stub;
});

it("a spent month gets one notice outside the meter, then silence", async () => {
  const { store, id, host } = await hostedRoom("qs_spent");
  await runInDurableObject(env.SESSION.get(env.SESSION.idFromName(id)), async (_i: SessionDO, ctx) => {
    const s = await ctx.storage.get<Record<string, unknown>>("session");
    await ctx.storage.put("session", { ...s, hostUnits: { month: monthKey(Date.now()), used: 10, wakes: [] } });
  });
  // No reply queued: the meter refuses before the model is called, and a call would be a stray one.
  await host.wake({ sessionId: id, cause: "tick", cursor: 1 }, "host:tick:1");
  await seatIdle(host);
  const notices = (await store.eventsAfter(id, 0)).filter((e) => e.fromMemberId === HOST_MEMBER_ID);
  expect(notices).toHaveLength(1);
  expect(notices[0].payload).toMatchObject({ kind: "notice", text: expect.stringMatching(/used its 10 units/) });
  await host.wake({ sessionId: id, cause: "tick", cursor: 2 }, "host:tick:2");
  await seatIdle(host);
  expect((await store.eventsAfter(id, 0)).filter((e) => e.fromMemberId === HOST_MEMBER_ID)).toHaveLength(1);
});

it("a member's reply returns without waiting for the model, and the answer lands once the model answers", async () => {
  const { store, id, stub, host } = await hostedRoom("qs_hosted_quick");
  modelAnswers("Ask me anything.");
  await tick(stub);
  await seatIdle(host);
  const [q] = await hostSaid(store, id);
  const answer = modelHolds("Nice, tell us more.");
  const appended = store.appendEvent(id, replyTo(q.cursor)).then(() => "returned", (err: unknown) => `threw: ${err}`);
  // Observed while the model is held, asserted once the room and the seat are quiet: a case
  // that fails with a call in flight leaves objects the pool aborts mid-call, and workerd crashes.
  let first = "";
  let whileHeld: SessionEvent[] = [];
  try {
    // Bounded, because a reply whose delivery makes the model call waits on the hold.
    first = await Promise.race([appended, sleep(2_000).then(() => "still waiting on the model")]);
    await answer.asked();
    whileHeld = await hostSaid(store, id, q.cursor);
  } finally {
    answer.release();
  }
  await appended;
  await seatIdle(host);
  expect(first).toBe("returned");
  expect(whileHeld).toEqual([]);
  expect(await hostSaid(store, id, q.cursor)).toMatchObject([{ refId: String(q.cursor), payload: { kind: "answer", text: "Nice, tell us more." } }]);
});

it("a wake delivered while another is being handled waits its turn, and the seat keeps what both did", async () => {
  const { store, id, stub, host } = await hostedRoom("qs_hosted_pair");
  modelAnswers("Ask me anything.");
  await tick(stub);
  await seatIdle(host);
  const [q] = await hostSaid(store, id);
  const answer = modelHolds("Nice, tell us more.");
  modelAnswers("What did you learn?");
  const replied = store.appendEvent(id, replyTo(q.cursor));
  let beat!: SessionEvent;
  let whileHeld: SessionEvent[] = [];
  try {
    await answer.asked();
    // A tick lands while the reply's model call is held; its wake is delivered by hand, so
    // it reaches the seat now rather than behind the reply in the room's outbox.
    beat = await appendHeld(stub, heartbeat);
    await host.wake({ sessionId: id, cause: "tick", cursor: beat.cursor }, `host:tick:${beat.cursor}`);
    whileHeld = await hostSaid(store, id, q.cursor);
  } finally {
    answer.release();
  }
  await replied;
  await seatIdle(host);
  expect(whileHeld).toEqual([]);
  expect((await hostSaid(store, id, q.cursor)).map((e) => [e.refId, e.payload])).toEqual([
    [String(q.cursor), { kind: "answer", text: "Nice, tell us more." }],
    [String(beat.cursor), { kind: "question", text: "What did you learn?" }],
  ]);
  const record = await runInDurableObject(host, async (_i: HostDO, ctx) => ctx.storage.get<HostRecord>("state"));
  expect(record!.questions.map(({ text, answers }) => ({ text, answers }))).toEqual([
    { text: "Ask me anything.", answers: 1 },
    { text: "What did you learn?", answers: 0 },
  ]);
  expect(record!.lastCause).toBe(beat.cursor);
});

it("wakes queued before the seat's alarm runs are all handled, in the order they came", async () => {
  const { store, id, stub, host } = await hostedRoom("qs_hosted_two");
  modelAnswers("Ask me anything.");
  await tick(stub);
  await seatIdle(host);
  const [q] = await hostSaid(store, id);
  const reply = await appendHeld(stub, replyTo(q.cursor));
  const beat = await appendHeld(stub, heartbeat);
  modelAnswers("Nice, tell us more.");
  modelAnswers("What did you learn?");
  // Both queued in one request: it awaits only storage, so the alarm the first wake arms
  // cannot fire before the second is queued, and the second arms none of its own.
  await runInDurableObject(host, async (i: HostDO) => {
    await i.wake({ sessionId: id, cause: "reply", cursor: reply.cursor }, `host:reply:${reply.cursor}`);
    await i.wake({ sessionId: id, cause: "tick", cursor: beat.cursor }, `host:tick:${beat.cursor}`);
  });
  await seatIdle(host);
  expect((await hostSaid(store, id, q.cursor)).map((e) => [e.refId, e.payload])).toEqual([
    [String(q.cursor), { kind: "answer", text: "Nice, tell us more." }],
    [String(beat.cursor), { kind: "question", text: "What did you learn?" }],
  ]);
});

/** Every key the seat's object holds. */
const seatRows = (host: DurableObjectStub<HostDO>) =>
  runInDurableObject(host, async (_i: HostDO, ctx) => [...(await ctx.storage.list()).keys()]);

/** Close the room and delete it now (#65, D6), and wait for the room's own alarm to purge it. */
async function closeAndPurge(store: DurableObjectStore, id: string) {
  await store.closeSession(id);
  expect(await store.schedulePurge(id, Date.now(), "u_jesse")).toMatchObject({ ok: true });
  await vi.waitFor(async () => expect(await store.getSession(id)).toBeUndefined(), { timeout: 5_000, interval: 10 });
}

it("the room's purge empties the seat's object: its record, the questions it asked, and its alarm", async () => {
  const { store, id, stub, host } = await hostedRoom("qs_hosted_purged");
  modelAnswers("What did you ship this week?");
  await tick(stub);
  await seatIdle(host);
  const kept = await runInDurableObject(host, async (_i: HostDO, ctx) => ctx.storage.get<HostRecord>("state"));
  expect(kept!.questions.map((q) => q.text), "the seat keeps what it asked").toEqual(["What did you ship this week?"]);

  await closeAndPurge(store, id);

  expect(await seatRows(host)).toEqual([]);
  expect(await runInDurableObject(host, (_i: HostDO, ctx) => ctx.storage.getAlarm())).toBeNull();
});

it("a wake the seat is still handling when the room is purged puts nothing back once it settles", async () => {
  const { store, id, stub, host } = await hostedRoom("qs_hosted_purged_mid_wake");
  // An alarm an hour out, as a retry's backoff would be: the tick's wake queues behind it, and
  // the test runs the seat's alarm itself, so it can hold the model mid-wake and await the end.
  await runInDurableObject(host, (_i: HostDO, ctx) => ctx.storage.setAlarm(Date.now() + 3_600_000));
  const held = modelHolds("What did you ship this week?");
  await tick(stub);
  const handling = runInDurableObject(host, (i: HostDO) => i.alarm());
  await held.asked();

  await closeAndPurge(store, id);
  held.release();
  await handling;

  expect(await seatRows(host)).toEqual([]);
  expect(await runInDurableObject(host, (_i: HostDO, ctx) => ctx.storage.getAlarm())).toBeNull();
  expect(await hostSaid(store, id), "the answer found no room to land in").toEqual([]);
});
