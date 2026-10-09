import { describe, it, expect, vi } from "vitest";
import { ABANDONED_AFTER_MS, MemoryStore } from "../src/store.js";
import { hydrateStoredSession } from "../src/stored-session.js";
import { HOST_MEMBER_ID, HOST_USER_ID, hostMember, type HostWake } from "../src/host.js";
import { tickStep } from "../src/heartbeat.js";
import type { Session } from "../src/types.js";
import { describeStoreContract } from "./helpers/store-contract.js";
import { member, roomManifest, session } from "./helpers/fixtures.js";

describeStoreContract("MemoryStore", () => new MemoryStore());

class Recording extends MemoryStore {
  wakes: HostWake[] = [];
  protected override hostWoken(wake: HostWake): void { this.wakes.push(wake); }
}

describe("MemoryStore wakes the host (hosted seat spec, D4)", () => {
  const hosted = () => roomManifest({ mode: "swarm", preset: null, heartbeatOnMs: 3_600_000,
    roles: { lead: { can: ["send", "invite"], description: null, reports: false }, host: { can: ["send"], description: null, reports: false } },
    defaultRole: "lead", creatorRole: "lead", host: { role: "host", model: "haiku", instructions: null } });
  const NOW = Date.now();

  it("queues a tick wake when a heartbeat lands in a hosted room, and none in a room without a host", async () => {
    const store = new Recording();
    const m = hosted();
    const s = session({ manifest: m, members: [member({ lastSeenAt: NOW }), hostMember(m, NOW)] });
    await store.createSession(s);
    await store.appendEvent(s.id, { type: "heartbeat", fromMemberId: "system", fromUserId: "system", fromLabel: "bellman", payload: {}, refId: null });
    expect(store.wakes).toEqual([{ sessionId: s.id, cause: "tick", cursor: 1 }]);
    const plain = session({ id: "qs_plain" });
    await store.createSession(plain);
    await store.appendEvent(plain.id, { type: "heartbeat", fromMemberId: "system", fromUserId: "system", fromLabel: "bellman", payload: {}, refId: null });
    expect(store.wakes).toHaveLength(1);
  });

  it("queues a reply wake for a message that references the host's event, and not for one that references a member's", async () => {
    const store = new Recording();
    const m = hosted();
    // Units to spend: the fixture's default is 0, and the meter refuses the question without them.
    const s = session({ manifest: m, members: [member({ lastSeenAt: NOW }), hostMember(m, NOW)], hostUnitsPerMonth: 10 });
    await store.createSession(s);
    const q = await store.appendHostEvent(s.id, { type: "message", fromMemberId: HOST_MEMBER_ID, fromUserId: HOST_USER_ID, fromLabel: "host@bellman", payload: { kind: "question", text: "q" }, refId: null }, 1, NOW);
    expect(q.ok).toBe(true);
    const qc = q.ok ? q.event.cursor : 0;
    await store.appendEvent(s.id, { type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: { text: "a" }, refId: String(qc) });
    expect(store.wakes).toEqual([{ sessionId: s.id, cause: "reply", cursor: qc + 1 }]);
    await store.appendEvent(s.id, { type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: { text: "b" }, refId: String(qc + 1) });
    expect(store.wakes).toHaveLength(1);
  });

  // The host's own answer carries its question's cursor as `refId`, which reads as a
  // reply to the host. SessionDO queues no wake for the host's sends (appendHostEvent
  // queues none), so MemoryStore must not either, or the seat wakes itself.
  it("queues no wake for the host's own answer in its thread", async () => {
    const store = new Recording();
    const m = hosted();
    const s = session({ manifest: m, members: [member({ lastSeenAt: NOW }), hostMember(m, NOW)], hostUnitsPerMonth: 10 });
    await store.createSession(s);
    const host = { type: "message" as const, fromMemberId: HOST_MEMBER_ID, fromUserId: HOST_USER_ID, fromLabel: "host@bellman" };
    const q = await store.appendHostEvent(s.id, { ...host, payload: { kind: "question", text: "q" }, refId: null }, 1, NOW);
    const qc = q.ok ? q.event.cursor : 0;
    const a = await store.appendHostEvent(s.id, { ...host, payload: { kind: "answer", text: "a" }, refId: String(qc) }, 1, NOW);
    expect(a.ok).toBe(true);
    expect(store.wakes).toEqual([]);
  });
});

/**
 * The Node server's heartbeat (#111, #188). `MemoryStore.tick` is handed its rule,
 * `tickStep` from heartbeat.ts, because heartbeat.ts imports store.ts and the reverse
 * import would be a cycle. These cases hand it the real one.
 */
describe("MemoryStore ticks its rooms with the step it is handed", () => {
  const HOUR = 3_600_000;
  const T = Date.now();
  const manifest = (host: boolean, reports: boolean) => roomManifest({
    mode: "swarm", preset: null, heartbeatOnMs: HOUR,
    roles: { lead: { can: ["send", "invite"], description: null, reports }, host: { can: ["send"], description: null, reports: false } },
    defaultRole: "lead", creatorRole: "lead", host: host ? { role: "host", model: "haiku", instructions: null } : null,
  });
  /**
   * One person (`m_creator`, joined two cadences ago) and, unless `host: false`, the
   * seat, which was seen at T, after the last tick: a rule that counted the host would
   * tick every room here.
   */
  const room = (id: string, { host = true, reports = false, seenAt = T - 1_000, lastTickAt = T - HOUR - 1 } = {}) => {
    const m = manifest(host, reports);
    const members = [member({ roomRole: "lead", joinedAt: T - 2 * HOUR, lastSeenAt: seenAt }), ...(host ? [hostMember(m, T)] : [])];
    return { ...session({ id, manifest: m, members, joinCodes: {} }), lastTickAt } as Session;
  };
  const ticked = async (store: MemoryStore, id: string) => ({
    events: await store.eventsAfter(id, 0),
    lastTickAt: (await store.getSession(id))!.lastTickAt,
  });

  it("(a) ticks a hosted room no role reports in while a person is in it, and wakes the seat", async () => {
    const store = new Recording();
    await store.createSession(room("qs_tick_a"));
    store.tick(T, tickStep);
    const after = await ticked(store, "qs_tick_a");
    expect(after.events).toMatchObject([{ cursor: 1, type: "heartbeat", fromMemberId: "system", refId: null, at: T, payload: { members: [] } }]);
    expect(after.lastTickAt).toBe(T);
    expect(store.wakes).toEqual([{ sessionId: "qs_tick_a", cause: "tick", cursor: 1 }]);
  });

  it("(b) writes nothing into a hosted room nobody has been in since the last tick, and moves the clock", async () => {
    const store = new Recording();
    await store.createSession(room("qs_tick_b", { seenAt: T - HOUR - 1_000 }));
    store.tick(T, tickStep);
    expect(await ticked(store, "qs_tick_b")).toEqual({ events: [], lastTickAt: T });
    expect(store.wakes).toEqual([]);
  });

  it("(c) writes a due reporter's tick into a hosted room nobody has been in, and leaves the seat asleep", async () => {
    const store = new Recording();
    await store.createSession(room("qs_tick_c", { reports: true, seenAt: T - HOUR - 1_000 }));
    store.tick(T, tickStep);
    const after = await ticked(store, "qs_tick_c");
    expect(after.events).toMatchObject([{ type: "heartbeat", payload: { members: [{ member_id: "m_creator" }] } }]);
    expect(store.wakes).toEqual([]);
  });

  it("(d) never ticks a room without a host whose roles ask for no reports", async () => {
    const store = new Recording();
    await store.createSession(room("qs_tick_d", { host: false }));
    store.tick(T, tickStep);
    expect(await ticked(store, "qs_tick_d")).toEqual({ events: [], lastTickAt: T - HOUR - 1 });
    expect(store.wakes).toEqual([]);
  });

  // The caller runs this on an interval far shorter than any cadence. A room whose tick
  // is not due keeps its clock, or every call would push the cadence back again.
  it("(e) leaves a hosted room whose cadence has not come round untouched, clock included", async () => {
    const store = new Recording();
    await store.createSession(room("qs_tick_e", { lastTickAt: T - 60_000 }));
    store.tick(T, tickStep);
    expect(await ticked(store, "qs_tick_e")).toEqual({ events: [], lastTickAt: T - 60_000 });
    expect(store.wakes).toEqual([]);
  });

  it("(f) writes no tick into an abandoned room, though a reporter is due in it", async () => {
    const store = new Recording();
    await store.createSession(room("qs_tick_f", { reports: true, seenAt: T - ABANDONED_AFTER_MS - 1_000 }));
    store.tick(T, tickStep);
    expect((await store.eventsAfter("qs_tick_f", 0)).filter((e) => e.type === "heartbeat")).toEqual([]);
    expect(store.wakes).toEqual([]);
  });
});

describe("manifest persistence", () => {
  it("round-trips a manifest through the store unchanged", async () => {
    const store = new MemoryStore();
    const s = session({ manifest: roomManifest({ room: "persisted", purpose: "keep me" }) });
    await store.createSession(s);

    const back = await store.getSession(s.id);
    expect(back?.manifest).toEqual(s.manifest);
    expect(back?.manifest.roles.peer_a.can).toContain("revoke");
  });

  it("hands back a detached manifest that callers cannot mutate in place", async () => {
    const store = new MemoryStore();
    const s = session({ manifest: roomManifest() });
    await store.createSession(s);

    const first = await store.getSession(s.id);
    first!.manifest.roles.peer_b.can.push("revoke");

    const second = await store.getSession(s.id);
    expect(second?.manifest.roles.peer_b.can).not.toContain("revoke");
  });
});

/**
 * What `getSession` copies (#134).
 *
 * #25 stopped `getSession` returning a room's events, and the Durable Object store
 * stopped reading them. `MemoryStore` kept paying for them anyway: it cloned the whole
 * session and dropped the events from the copy, so a call nearly every tool makes cost
 * O(the room's history) on the Node server and in local development, which is the
 * growth #25 exists to remove.
 *
 * Wall-clock cannot pin that without flaking, so this watches the one primitive that
 * does the copying. `detach` is `structuredClone`, and whatever `getSession` hands it
 * is the work it does. The events carry a marker, and none of it may reach the clone.
 * The controls keep the probe honest: it has to see the same events being copied by a
 * read that does copy them, and see `getSession` copying the record, or a `detach`
 * moved off `structuredClone` would leave this passing over a probe that watches nothing.
 */
describe("what MemoryStore.getSession copies (#134)", () => {
  const MARK = "history-body-";

  /** Everything handed to `structuredClone` while `read` runs, as one string. */
  const copiedBy = async (read: () => Promise<unknown>): Promise<string> => {
    const clone = vi.spyOn(globalThis, "structuredClone");
    try {
      await read();
      return clone.mock.calls.map(([value]) => JSON.stringify(value)).join("\n");
    } finally {
      clone.mockRestore();
    }
  };

  /** One marker per event, so this is how many events a copy carried. */
  const eventsIn = (copy: string): number => copy.split(MARK).length - 1;

  it("copies the session record and none of the room's history", async () => {
    const store = new MemoryStore();
    const s = session({ id: "qs_history" });
    await store.createSession(s);
    const HISTORY = 25;
    for (let i = 0; i < HISTORY; i++) {
      await store.appendEvent(s.id, {
        type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse",
        fromLabel: "jesse", payload: { text: `${MARK}${i}` }, refId: null,
      });
    }

    expect(eventsIn(await copiedBy(() => store.eventsAfter(s.id, 0))),
      "control: a read that returns the events copies all of them").toBe(HISTORY);

    const copied = await copiedBy(() => store.getSession(s.id));
    expect(copied, "control: getSession copies the record").toContain(s.id);
    expect(eventsIn(copied), "events getSession copied").toBe(0);
  });
});

/**
 * Records written before a field existed.
 *
 * Both fields post-date the sessions now in production, and they want opposite
 * treatment: a manifest cannot be invented, so those rows read as gone; a
 * freeze can be defaulted, and must be, or every existing room reports frozen
 * and refuses every write in it.
 */
describe("hydrating a session written before a field existed", () => {
  const stored = (over: Record<string, unknown> = {}) => {
    const { events, ...rest } = session();
    return { ...rest, ...over };
  };

  it("reads a row with no frozenAt as not frozen", () => {
    const { frozenAt, ...legacy } = stored();

    expect(hydrateStoredSession(legacy)?.frozenAt).toBeNull();
  });

  it("leaves a real freeze alone", () => {
    expect(hydrateStoredSession(stored({ frozenAt: 1_790_000_000 }))?.frozenAt)
      .toBe(1_790_000_000);
  });

  /** A manifest is a declaration; inventing one would put words in a mouth. */
  it("treats a row with no manifest as gone rather than defaulting it", () => {
    const { manifest, ...legacy } = stored();

    expect(hydrateStoredSession(legacy)).toBeUndefined();
    expect(hydrateStoredSession(stored({ manifest: { roles: undefined } }))).toBeUndefined();
    expect(hydrateStoredSession(undefined)).toBeUndefined();
  });
});
