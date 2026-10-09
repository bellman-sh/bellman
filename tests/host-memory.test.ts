import { describe, it, expect } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { MemoryBlobStore } from "../src/blobs.js";
import { MemoryStore } from "../src/store.js";
import { MemoryHost } from "../src/host-memory.js";
import { HOST_MEMBER_ID, hostMember, type HostWake } from "../src/host.js";
import { monthKey } from "../src/stored-session.js";
import type { SessionEvent } from "../src/types.js";
import { member, roomManifest, session } from "./helpers/fixtures.js";

const hosted = () => roomManifest({ mode: "swarm", preset: null, heartbeatOnMs: 3_600_000,
  roles: { lead: { can: ["send", "invite"], description: null, reports: false }, host: { can: ["send"], description: null, reports: false } },
  defaultRole: "lead", creatorRole: "lead", host: { role: "host", model: "haiku", instructions: null } });

type Reply = { status: number; text?: string; hold?: Promise<void>; asked?: () => void };

/**
 * A canned Messages API. Status 0 is a model that cannot be reached: the call throws, as
 * `fetch` does on a network failure. A held reply (`held`) is given only once released.
 */
function fakeModel(replies: Reply[]) {
  const calls: unknown[] = [];
  const f = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    const r = replies.shift() ?? { status: 200, text: "default" };
    r.asked?.();
    await r.hold;
    if (r.status === 0) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(r.status === 200 ? { content: [{ type: "text", text: r.text }] } : { error: {} }), { status: r.status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

/** A reply the model gives only once `release` is called. `asked` resolves when the seat has called for it. */
function held(text: string) {
  let release!: () => void;
  const reply: Reply = { status: 200, text, hold: new Promise<void>((r) => { release = r; }) };
  const asked = new Promise<void>((r) => { reply.asked = r; });
  return { reply, asked, release };
}

/** With `deliver: false` the store's wakes are kept in `woken`, for the test to deliver itself. */
async function hostedStore(replies: Reply[], { deliver = true } = {}) {
  const { f, calls } = fakeModel(replies);
  let host!: MemoryHost;
  const woken: HostWake[] = [];
  const store = new MemoryStore({ host: (w) => { if (deliver) void host.wake(w); else woken.push(w); } });
  host = new MemoryHost(store, { modelUrl: "http://fake", fetch: f, retryMs: [5, 5, 5] });
  const m = hosted();
  const now = Date.now();
  const s = session({ manifest: m, members: [member({ lastSeenAt: now }), hostMember(m, now)], hostUnitsPerMonth: 10,
    hostUnits: { month: monthKey(now), used: 0, wakes: [] } });
  await store.createSession(s);
  return { store, host, id: s.id, calls, replies, woken };
}

/** What the host has written into the room after `cursor`. */
const hostSaid = async (store: MemoryStore, id: string, cursor = 0) =>
  (await store.eventsAfter(id, cursor)).filter((e) => e.fromMemberId === HOST_MEMBER_ID);

const replyTo = (cursor: number): Omit<SessionEvent, "cursor" | "at"> =>
  ({ type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: { text: "a parser" }, refId: String(cursor) });
const heartbeat: Omit<SessionEvent, "cursor" | "at"> =
  { type: "heartbeat", fromMemberId: "system", fromUserId: "system", fromLabel: "bellman", payload: {}, refId: null };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("MemoryHost", () => {
  it("asks a question when a heartbeat lands, through the same loop", async () => {
    const { store, host, id, calls } = await hostedStore([{ status: 200, text: "What shipped?" }]);
    await store.appendEvent(id, { type: "heartbeat", fromMemberId: "system", fromUserId: "system", fromLabel: "bellman", payload: {}, refId: null });
    await host.settled();
    const q = (await store.eventsAfter(id, 0)).find((e) => e.fromMemberId === HOST_MEMBER_ID)!;
    expect(q).toMatchObject({ refId: "1", payload: { kind: "question", text: "What shipped?" } });
    expect(calls).toHaveLength(1);
    expect((await store.getSession(id))!.hostUnits.used).toBe(1);
  });

  /**
   * Evicting the host is the creator's off-switch (C1). The reviewer's reproduction: the
   * eviction reported success, and the next tick still asked, as the evicted host, and
   * charged a unit. Now nothing the room does wakes it, and a wake that reaches it anyway
   * settles with no model call.
   */
  it("an evicted host is woken by nothing, and a wake delivered anyway asks nothing and spends nothing", async () => {
    const { store, host, id, calls, woken } = await hostedStore([{ status: 200, text: "What shipped?" }], { deliver: false });
    await store.appendEvent(id, heartbeat);
    await host.wake(woken.shift()!);
    await host.settled();
    const [q] = await hostSaid(store, id);
    await store.removeMember(id, HOST_MEMBER_ID, {
      now: Date.now(), frozen: "refuse", cut: true, byUserId: "u_jesse", audit: [],
      event: { type: "member_evicted", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd",
        payload: { member_id: HOST_MEMBER_ID }, refId: null },
    });

    await store.appendEvent(id, replyTo(q.cursor));
    const beat = (await store.appendEvent(id, heartbeat))!;
    expect(woken, "the room queues no wake for a host it has evicted").toEqual([]);

    await host.wake({ sessionId: id, cause: "tick", cursor: beat.cursor });
    await host.settled();
    expect(calls).toHaveLength(1);
    expect(await hostSaid(store, id, q.cursor)).toEqual([]);
    expect((await store.getSession(id))!.hostUnits.used).toBe(1);
  });

  it("retries a 429 and gives up after three", async () => {
    const { store, host, id, calls } = await hostedStore([{ status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }]);
    await store.appendEvent(id, { type: "heartbeat", fromMemberId: "system", fromUserId: "system", fromLabel: "bellman", payload: {}, refId: null });
    await host.settled();
    expect(calls).toHaveLength(4);
    expect((await store.eventsAfter(id, 0)).filter((e) => e.fromMemberId === HOST_MEMBER_ID)).toEqual([]);
  });

  it("retries a model it cannot reach, as it retries a 5xx", async () => {
    const { store, host, id, calls } = await hostedStore([{ status: 0 }, { status: 200, text: "Back again." }]);
    await store.appendEvent(id, { type: "heartbeat", fromMemberId: "system", fromUserId: "system", fromLabel: "bellman", payload: {}, refId: null });
    await host.settled();
    expect(calls).toHaveLength(2);
    const asked = (await store.eventsAfter(id, 0)).filter((e) => e.fromMemberId === HOST_MEMBER_ID);
    expect(asked.map((e) => e.payload)).toEqual([{ kind: "question", text: "Back again." }]);
  });

  it("runs on the Node server's fake model with no key: a question, then an answer in its thread", async () => {
    let host!: MemoryHost;
    const store = new MemoryStore({ host: (w) => void host.wake(w) });
    const http = await new Promise<Server>((resolve) => {
      const s = createApp(store, new MemoryBlobStore()).listen(0, () => resolve(s));
    });
    try {
      host = new MemoryHost(store, { modelUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}/__fake-model` });
      const m = hosted();
      const now = Date.now();
      const s = session({ manifest: m, members: [member({ lastSeenAt: now }), hostMember(m, now)], hostUnitsPerMonth: 10,
        hostUnits: { month: monthKey(now), used: 0, wakes: [] } });
      await store.createSession(s);
      await store.appendEvent(s.id, { type: "heartbeat", fromMemberId: "system", fromUserId: "system", fromLabel: "bellman", payload: {}, refId: null });
      await host.settled();
      const q = (await store.eventsAfter(s.id, 0)).find((e) => e.fromMemberId === HOST_MEMBER_ID)!;
      expect(q.payload).toEqual({ kind: "question", text: "What did you build today, and what got in the way?" });

      await store.appendEvent(s.id, { type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: { text: "a parser" }, refId: String(q.cursor) });
      await host.settled();
      const answer = (await store.eventsAfter(s.id, q.cursor)).find((e) => e.fromMemberId === HOST_MEMBER_ID)!;
      expect(answer).toMatchObject({ refId: String(q.cursor), payload: { kind: "answer", text: "Thanks for telling the room. Who else has one?" } });
    } finally {
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });

  it("a wake returns at once while the model is held, and the answer lands once it answers", async () => {
    const { store, host, id, replies, woken } = await hostedStore([{ status: 200, text: "What shipped?" }], { deliver: false });
    await store.appendEvent(id, heartbeat);
    await host.wake(woken.shift()!);
    await host.settled();
    const [q] = await hostSaid(store, id);
    const answer = held("Nice, tell us more.");
    replies.push(answer.reply);
    try {
      await store.appendEvent(id, replyTo(q.cursor));
      const delivered = host.wake(woken.shift()!).then(() => "returned");
      // Bounded, because a wake that makes the model call before it returns waits on the hold.
      expect(await Promise.race([delivered, sleep(1_000).then(() => "still waiting on the model")])).toBe("returned");
      await answer.asked;
      expect(await hostSaid(store, id, q.cursor)).toEqual([]);
    } finally {
      answer.release();
    }
    await host.settled();
    expect(await hostSaid(store, id, q.cursor)).toMatchObject([{ refId: String(q.cursor), payload: { kind: "answer", text: "Nice, tell us more." } }]);
  });

  it("a wake delivered while another is being handled waits its turn, and the seat keeps what both did", async () => {
    const { store, host, id, replies, woken } = await hostedStore([{ status: 200, text: "Ask me anything." }], { deliver: false });
    await store.appendEvent(id, heartbeat);
    await host.wake(woken.shift()!);
    await host.settled();
    const [q] = await hostSaid(store, id);
    const answer = held("Nice, tell us more.");
    replies.push(answer.reply, { status: 200, text: "What did you learn?" });
    let beat!: SessionEvent;
    try {
      await store.appendEvent(id, replyTo(q.cursor));
      void host.wake(woken.shift()!);
      await answer.asked;
      // A tick lands while the reply's model call is held, and its wake is delivered at once.
      beat = (await store.appendEvent(id, heartbeat))!;
      await host.wake(woken.shift()!);
      expect(await hostSaid(store, id, q.cursor)).toEqual([]);
    } finally {
      answer.release();
    }
    await host.settled();
    expect((await hostSaid(store, id, q.cursor)).map((e) => [e.refId, e.payload])).toEqual([
      [String(q.cursor), { kind: "answer", text: "Nice, tell us more." }],
      [String(beat.cursor), { kind: "question", text: "What did you learn?" }],
    ]);

    // What the seat kept, read through what it does next: the new question is the open one,
    // so a reply to it is answered, and the tick is handled, so delivering it again asks nothing.
    const q2 = (await hostSaid(store, id, q.cursor)).find((e) => e.refId === String(beat.cursor))!;
    replies.push({ status: 200, text: "Good one." });
    await store.appendEvent(id, replyTo(q2.cursor));
    await host.wake(woken.shift()!);
    await host.wake({ sessionId: id, cause: "tick", cursor: beat.cursor });
    await host.settled();
    expect((await hostSaid(store, id, q2.cursor)).map((e) => [e.refId, e.payload])).toEqual([
      [String(q2.cursor), { kind: "answer", text: "Good one." }],
    ]);
  });
});
