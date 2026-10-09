import { it, expect, afterEach, beforeEach, vi } from "vitest";
import { env, reset, runInDurableObject, runDurableObjectAlarm, abortAllDurableObjects } from "cloudflare:test";
import { DurableObjectStore, type SessionDO } from "../src/store-do.js";
import type { HostDO } from "../src/host-do.js";
import { HOST_MEMBER_ID, hostMember, ANTHROPIC_MESSAGES_URL } from "../src/host.js";
import { monthKey } from "../src/stored-session.js";
import { member, roomManifest, session } from "../tests/helpers/fixtures.js";

const hosted = () => roomManifest({ mode: "swarm", preset: null, heartbeatOnMs: 3_600_000,
  roles: { lead: { can: ["send", "invite"], description: null, reports: false }, host: { can: ["send"], description: null, reports: false } },
  defaultRole: "lead", creatorRole: "lead", host: { role: "host", model: "haiku", instructions: null } });

/**
 * The model, stubbed at `fetch`. `fetchMock` left `cloudflare:test` at pool 0.22.0; the
 * pool runs this Worker's objects in the test's own isolate, so `HostDO` calls this.
 * Only a POST to the Messages API matches, one queued reply each, in order. Anything
 * else throws, as `disableNetConnect` did, and a reply left unread fails the test in
 * `afterEach`, as `assertNoPendingInterceptors` did.
 */
const replies: { status: number; text: string }[] = [];
const modelAnswers = (text: string, status = 200) => { replies.push({ status, text }); };

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const reply = req.method === "POST" && req.url === ANTHROPIC_MESSAGES_URL ? replies.shift() : undefined;
    if (!reply) throw new Error(`the model stub has no reply for ${req.method} ${req.url}`);
    return Response.json(reply.status === 200 ? { content: [{ type: "text", text: reply.text }] } : { error: { type: "rate_limit" } },
      { status: reply.status });
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  const unread = replies.splice(0);
  await reset();
  await abortAllDurableObjects();
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

it("a tick wakes the host, which asks a question in the room with the tick as its ref", async () => {
  const { store, id, stub } = await hostedRoom();
  modelAnswers("What did you ship this week?");
  await tick(stub);
  const events = await store.eventsAfter(id, 0);
  const heartbeat = events.find((e) => e.type === "heartbeat")!;
  const q = events.find((e) => e.fromMemberId === HOST_MEMBER_ID)!;
  expect(q).toMatchObject({ type: "message", refId: String(heartbeat.cursor), payload: { kind: "question", text: "What did you ship this week?" } });
  expect((await store.getSession(id))!.hostUnits.used).toBe(1);
});

it("a reply wakes the host, which answers in the thread", async () => {
  const { store, id, stub } = await hostedRoom();
  modelAnswers("Ask me anything.");
  await tick(stub);
  const q = (await store.eventsAfter(id, 0)).find((e) => e.fromMemberId === HOST_MEMBER_ID)!;
  modelAnswers("Nice, tell us more.");
  await store.appendEvent(id, { type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: { text: "a parser" }, refId: String(q.cursor) });
  await new Promise((r) => setTimeout(r, 200));
  const answer = (await store.eventsAfter(id, q.cursor)).find((e) => e.fromMemberId === HOST_MEMBER_ID)!;
  expect(answer).toMatchObject({ refId: String(q.cursor), payload: { kind: "answer", text: "Nice, tell us more." } });
  expect((await store.getSession(id))!.hostUnits.used).toBe(2);
});

it("backs off on a 429 and asks on the retry; a redelivered wake asks nothing twice", async () => {
  const { store, id, stub, host } = await hostedRoom();
  modelAnswers("", 429);
  await tick(stub);
  expect((await store.eventsAfter(id, 0)).filter((e) => e.fromMemberId === HOST_MEMBER_ID)).toEqual([]);
  const armed = await runInDurableObject(host, async (_i: HostDO, ctx) => ctx.storage.getAlarm());
  expect(armed).not.toBeNull();
  modelAnswers("Second try.");
  await runDurableObjectAlarm(host);
  const asked = (await store.eventsAfter(id, 0)).filter((e) => e.fromMemberId === HOST_MEMBER_ID);
  expect(asked).toHaveLength(1);
  const heartbeat = (await store.eventsAfter(id, 0)).find((e) => e.type === "heartbeat")!;
  await host.wake({ sessionId: id, cause: "tick", cursor: heartbeat.cursor }, "host:tick:redelivered");
  expect((await store.eventsAfter(id, 0)).filter((e) => e.fromMemberId === HOST_MEMBER_ID)).toHaveLength(1);
});

it("drops a wake for a frozen room without calling the model", async () => {
  const { store, id, stub, host } = await hostedRoom();
  await store.freezeSession(id, Date.now());
  await host.wake({ sessionId: id, cause: "tick", cursor: 1 }, "host:tick:1");
  expect(await store.eventsAfter(id, 0)).toEqual([]);
  void stub;
});

it("a spent month gets one notice outside the meter, then silence", async () => {
  const { store, id, host } = await hostedRoom("qs_spent");
  await runInDurableObject(env.SESSION.get(env.SESSION.idFromName(id)), async (_i: SessionDO, ctx) => {
    const s = await ctx.storage.get<Record<string, unknown>>("session");
    await ctx.storage.put("session", { ...s, hostUnits: { month: monthKey(Date.now()), used: 10, wakes: [] } });
  });
  // No reply queued: the meter refuses before the model is called, and a call would throw in the stub.
  await host.wake({ sessionId: id, cause: "tick", cursor: 1 }, "host:tick:1");
  const notices = (await store.eventsAfter(id, 0)).filter((e) => e.fromMemberId === HOST_MEMBER_ID);
  expect(notices).toHaveLength(1);
  expect(notices[0].payload).toMatchObject({ kind: "notice", text: expect.stringMatching(/used its 10 units/) });
  await host.wake({ sessionId: id, cause: "tick", cursor: 2 }, "host:tick:2");
  expect((await store.eventsAfter(id, 0)).filter((e) => e.fromMemberId === HOST_MEMBER_ID)).toHaveLength(1);
});
