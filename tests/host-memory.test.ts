import { describe, it, expect } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { MemoryBlobStore } from "../src/blobs.js";
import { MemoryStore } from "../src/store.js";
import { MemoryHost } from "../src/host-memory.js";
import { HOST_MEMBER_ID, hostMember } from "../src/host.js";
import { monthKey } from "../src/stored-session.js";
import { member, roomManifest, session } from "./helpers/fixtures.js";

const hosted = () => roomManifest({ mode: "swarm", preset: null, heartbeatOnMs: 3_600_000,
  roles: { lead: { can: ["send", "invite"], description: null, reports: false }, host: { can: ["send"], description: null, reports: false } },
  defaultRole: "lead", creatorRole: "lead", host: { role: "host", model: "haiku", instructions: null } });

/** A canned Messages API. Status 0 is a model that cannot be reached: the call throws, as `fetch` does on a network failure. */
function fakeModel(replies: Array<{ status: number; text?: string }>) {
  const calls: unknown[] = [];
  const f = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    const r = replies.shift() ?? { status: 200, text: "default" };
    if (r.status === 0) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(r.status === 200 ? { content: [{ type: "text", text: r.text }] } : { error: {} }), { status: r.status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

async function hostedStore(replies: Array<{ status: number; text?: string }>) {
  const { f, calls } = fakeModel(replies);
  let host!: MemoryHost;
  const store = new MemoryStore({ host: (w) => void host.wake(w) });
  host = new MemoryHost(store, { modelUrl: "http://fake", fetch: f, retryMs: [5, 5, 5] });
  const m = hosted();
  const now = Date.now();
  const s = session({ manifest: m, members: [member({ lastSeenAt: now }), hostMember(m, now)], hostUnitsPerMonth: 10,
    hostUnits: { month: monthKey(now), used: 0, wakes: [] } });
  await store.createSession(s);
  return { store, host, id: s.id, calls };
}

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
});
