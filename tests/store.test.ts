import { describe, it, expect, vi } from "vitest";
import { MemoryBlobStore, blobBytesUsed } from "../src/blobs.js";
import { MemoryStore, hostSentEntries, rosterParties } from "../src/store.js";
import type { AuditEntry, Session } from "../src/types.js";
import { ABANDONED_AFTER_MS } from "../src/presence.js";
import { hydrateStoredSession } from "../src/stored-session.js";
import { HOST_MEMBER_ID, HOST_USER_ID, hostMember, type HostWake } from "../src/host.js";
import { tickStep } from "../src/heartbeat.js";
import { clearedKeys, dueFindings } from "../src/housekeeping.js";
import { describeStoreContract } from "./helpers/store-contract.js";
import { SINK_BATCH, SINK_DEAD_AFTER_MS, SINK_DELAY_MS } from "../src/audit-sink.js";
import { backoffMs } from "../src/outbox.js";
import { member, roomManifest, session, type SeededSession } from "./helpers/fixtures.js";

// A fresh blob store for each case, handed both to the store, which purges from it, and to the cases,
// which put objects in it: a purge that missed the bucket the store was built over is seen.
let blobs = new MemoryBlobStore();
let memory = new MemoryStore();
describeStoreContract(
  "MemoryStore",
  () => { blobs = new MemoryBlobStore(); memory = new MemoryStore({ blobs }); return memory; },
  {
    blobsFor: () => blobs,
    // The filing times a report's limit counts from are in a private map, and BellmanStore cannot show whose are still held.
    reporterRows: async () => [...(memory as unknown as { filings: Map<string, number[]> }).filings.keys()],
    // The SCIM key index is a private map too, and every read of a row goes on to the user it names.
    scimIndexRows: async () => [...(memory as unknown as { scimByKey: Map<string, unknown> }).scimByKey.keys()].sort(),
  },
);

/**
 * `closedAt` is the clock of whoever closed the room (#65): an abandonment that `sweep(now)` closes is
 * dated `now`, as its `session_expired` event is, and not the wall clock the call happened to run at. The
 * Durable Object store has no `sweep(now)` to hand a clock to, so this is MemoryStore's alone.
 */
describe("closedAt on MemoryStore's abandonment close", () => {
  it("is the clock the sweep was handed, the one the closing event carries", async () => {
    const store = new MemoryStore();
    const handed = Date.now() + 5_000;
    // Open at the wall clock, a millisecond past the window as of the sweep's.
    const s = session({ members: [member({ lastSeenAt: handed - ABANDONED_AFTER_MS - 1 })] });
    await store.createSession(s);

    await store.sweep(handed);

    expect((await store.getSession(s.id))).toMatchObject({ closed: true, closedAt: handed });
    expect((await store.eventsAfter(s.id, 0)).at(-1)).toMatchObject({ type: "session_expired", at: handed });
  });
});

class RefusingBlobStore extends MemoryBlobStore {
  refusals = 1;
  override async deleteAll(sessionId: string): Promise<number> {
    if (this.refusals-- > 0) throw new Error("bucket unavailable");
    return super.deleteAll(sessionId);
  }
}

/**
 * The purge's order (#65, Review Focus 1) for the store that has no alarm to retry it: the bytes go first, and
 * a bucket that refuses leaves the room whole for the next sweep. Never a room that names bytes that are gone.
 */
describe("a purge whose bucket refuses", () => {
  it("leaves the room, its listings and its audit alone, and the next sweep purges it", async () => {
    const blobs = new RefusingBlobStore();
    const store = new MemoryStore({ blobs });
    // Its sweep has run already: this case is about the purge, and the sweep at close would take an unnamed object.
    const s = session({ id: "qs_refused", retainAfterCloseMs: 60_000, joinCodes: {}, blobsSwept: true });
    await store.createSession(s);
    await blobs.put(s.id, "b_one", new Uint8Array(3).buffer as ArrayBuffer, {
      bytes: 3, type: "text/plain", name: "a.txt", by: "m_creator", at: Date.now(),
    });
    await store.closeSession(s.id);
    const due = (await store.getSession(s.id))!.closedAt! + 60_000;

    await expect(store.sweep(due)).rejects.toThrow("bucket unavailable");

    expect(await store.getSession(s.id), "the room is kept").toMatchObject({ closed: true });
    expect(await store.sessionsJoinedBy("u_jesse", 10), "and listed").toContain(s.id);
    expect(await blobs.list(s.id), "with its bytes").toHaveLength(1);
    expect(await store.auditForOrg("org_codenerd", 50), "and nothing says it is gone").toEqual([]);

    await store.sweep(due);

    expect(await store.getSession(s.id)).toBeUndefined();
    expect(await blobs.list(s.id)).toEqual([]);
    expect(await store.auditForOrg("org_codenerd", 50)).toHaveLength(1);
  });
});

/**
 * The close-time sweep (#65, D3) on the store that has no alarm to run it. MemoryStore sweeps at the close
 * itself, after the room is closed, and `sweep(now)` is what finds a room whose close it did not see: an
 * abandonment, and a close that could not sweep.
 */
describe("the sweep at close, on MemoryStore", () => {
  const put = (blobs: MemoryBlobStore, room: string, id: string, bytes: number) =>
    blobs.put(room, id, new Uint8Array(bytes).buffer as ArrayBuffer, {
      bytes, type: "text/plain", name: `${id}.txt`, by: "m_creator", at: Date.now(),
    });
  /** Created closed, so no close of the store's has swept it, and charged 45 bytes: `Session` carries no `blobBytes`, stored rooms do. */
  const closedAndCharged = (id: string): SeededSession =>
    ({ ...session({ id, closed: true, closedAt: Date.now(), joinCodes: {} }), blobBytes: 45 }) as SeededSession;

  it("answers what it removed and credited, from a room the close has not swept", async () => {
    const blobs = new MemoryBlobStore();
    const store = new MemoryStore({ blobs });
    await store.createSession(closedAndCharged("qs_counts"));
    await put(blobs, "qs_counts", "b_orphan", 30);
    await put(blobs, "qs_counts", "b_other", 5);

    expect(await store.sweepBlobs("qs_counts")).toEqual({ removed: 2, credited: 35 });
    expect(blobBytesUsed((await store.getSession("qs_counts"))!)).toBe(10);
    expect(await store.sweepBlobs("qs_counts"), "nothing is left to remove").toEqual({ removed: 0, credited: 0 });
  });

  // Both list the same objects before either deletes, so both free the same bytes; the room is credited once.
  it("credits the freed bytes once when two sweeps overlap", async () => {
    const blobs = new MemoryBlobStore();
    const store = new MemoryStore({ blobs });
    await store.createSession(closedAndCharged("qs_overlap"));
    await put(blobs, "qs_overlap", "b_orphan", 30);
    await put(blobs, "qs_overlap", "b_other", 5);

    await Promise.all([store.sweepBlobs("qs_overlap"), store.sweepBlobs("qs_overlap")]);

    expect(blobBytesUsed((await store.getSession("qs_overlap"))!)).toBe(10);
  });

  it("sweeps as either closer closes the room, without waiting for a sweep", async () => {
    const blobs = new MemoryBlobStore();
    const store = new MemoryStore({ blobs });
    await store.createSession(session({ id: "qs_by_close", joinCodes: {} }));
    await store.createSession(session({ id: "qs_by_empty", joinCodes: {}, members: [member({ leftAt: Date.now() })] }));
    await put(blobs, "qs_by_close", "b_orphan", 3);
    await put(blobs, "qs_by_empty", "b_orphan", 3);

    await store.closeSession("qs_by_close");
    expect(await store.closeSessionIfEmpty("qs_by_empty")).toBe(true);

    expect(await blobs.list("qs_by_close")).toEqual([]);
    expect(await blobs.list("qs_by_empty")).toEqual([]);
  });

  it("looks at nothing when a room already swept is closed again", async () => {
    const blobs = new MemoryBlobStore();
    const store = new MemoryStore({ blobs });
    await store.createSession(session({ id: "qs_closed_twice", joinCodes: {} }));
    await store.closeSession("qs_closed_twice");
    await put(blobs, "qs_closed_twice", "b_late", 3);

    await store.closeSession("qs_closed_twice");

    expect(await blobs.list("qs_closed_twice")).toHaveLength(1);
  });

  // The room is closed whether or not its bucket answers, and `blobsSwept` stays false, so a sweep finds it.
  it("does not turn a close into a failure when the bucket refuses, and the next sweep tries again", async () => {
    class DeleteRefusingBlobStore extends MemoryBlobStore {
      refusals = 1;
      override async delete(sessionId: string, id: string): Promise<void> {
        if (this.refusals-- > 0) throw new Error("bucket unavailable");
        return super.delete(sessionId, id);
      }
    }
    const blobs = new DeleteRefusingBlobStore();
    const store = new MemoryStore({ blobs });
    await store.createSession(session({ id: "qs_refused_close", joinCodes: {} }));
    await put(blobs, "qs_refused_close", "b_orphan", 3);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(store.closeSession("qs_refused_close")).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
    expect(await store.getSession("qs_refused_close")).toMatchObject({ closed: true, blobsSwept: false });
    expect(await blobs.list("qs_refused_close")).toHaveLength(1);

    await store.sweep(Date.now());

    expect(await blobs.list("qs_refused_close")).toEqual([]);
    expect((await store.getSession("qs_refused_close"))!.blobsSwept).toBe(true);
  });
});

/**
 * A poll registers a promise and a timer, and the timer settles it by looking the waiter up. A purge that
 * dropped the waiter would leave the promise for ever, with nothing left to find it. MemoryStore's alone: a
 * room's poll in the Durable Objects store is that object's own, and it times out there.
 */
describe("a poll waiting on a room that is purged", () => {
  it("settles with nothing, and does not wait out its timeout", async () => {
    const store = new MemoryStore();
    const s = session({ id: "qs_poll", retainAfterCloseMs: 60_000, joinCodes: {} });
    await store.createSession(s);
    await store.closeSession(s.id);
    const waiting = store.waitForEvents(s.id, 0, 120_000);

    await store.sweep(Date.now() + 60_001);

    expect(await store.getSession(s.id)).toBeUndefined();
    expect(await waiting).toEqual([]);
  });
});

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
    const q = await store.appendHostEvent(s.id, { type: "message", fromMemberId: HOST_MEMBER_ID, fromUserId: HOST_USER_ID, fromLabel: "host@bellman", payload: { kind: "question", text: "q" }, refId: null }, 1, NOW, "host:tick:1");
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
    const q = await store.appendHostEvent(s.id, { ...host, payload: { kind: "question", text: "q" }, refId: null }, 1, NOW, "host:tick:1");
    const qc = q.ok ? q.event.cursor : 0;
    const a = await store.appendHostEvent(s.id, { ...host, payload: { kind: "answer", text: "a" }, refId: String(qc) }, 1, NOW, "host:reply:2");
    expect(a.ok).toBe(true);
    expect(store.wakes).toEqual([]);
  });

  // Housekeeping (#66, ruling H1): a proposal is a third thing the server writes into a room,
  // and it is not a cause. Waking spends the room's host units on the server's initiative,
  // which the proposal's own design rules out, so the wake's two causes stay two.
  it("queues no wake for a housekeeping proposal in a hosted room, and still wakes for a heartbeat after it", async () => {
    const store = new Recording();
    const m = hosted();
    const s = session({ manifest: m, members: [member({ lastSeenAt: NOW }), hostMember(m, NOW)] });
    await store.createSession(s);
    const server = { fromMemberId: "system", fromUserId: "system", fromLabel: "bellman", refId: null };
    await store.appendEvent(s.id, { type: "housekeeping", ...server, payload: { finding: "room_idle", since: NOW, repeat: 1 } });
    await store.appendEvent(s.id, { type: "housekeeping", ...server, payload: { finding: "member_quiet", about: { member_id: "m_creator" }, since: NOW, repeat: 1 } });
    expect(store.wakes).toEqual([]);
    // The fixture is wired: the same room wakes the seat for a tick, so the silence above is the rule.
    await store.appendEvent(s.id, { type: "heartbeat", ...server, payload: {} });
    expect(store.wakes).toEqual([{ sessionId: s.id, cause: "tick", cursor: 3 }]);
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
   * tick every room here. The last tick woke the host (`lastHostTickAt`, I3).
   */
  const room = (id: string, { host = true, reports = false, seenAt = T - 1_000, lastTickAt = T - HOUR - 1 } = {}) => {
    const m = manifest(host, reports);
    const members = [member({ roomRole: "lead", joinedAt: T - 2 * HOUR, lastSeenAt: seenAt }), ...(host ? [hostMember(m, T)] : [])];
    return { ...session({ id, manifest: m, members, joinCodes: {} }), lastTickAt, ...(host ? { lastHostTickAt: lastTickAt } : {}) } as SeededSession;
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
    // The host's own clock moves with the tick that wakes it (I3).
    expect((await store.getSession("qs_tick_a"))!.lastHostTickAt).toBe(T);
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

/**
 * The Node server's housekeeping (#231): for every room, what SessionDO's housekeeping handler does for
 * one. `MemoryStore.housekeep` is handed its rules, `dueFindings` and `clearedKeys` from housekeeping.ts,
 * because that module imports this one, as `tick` is handed its step. These cases hand it the real ones.
 */
describe("MemoryStore raises housekeeping with the rules it is handed (#231)", () => {
  const HOUR = 3_600_000;
  const T = Date.now();
  const rules = { dueFindings, clearedKeys };
  /**
   * A room with a hosted seat that names a person quiet two hours after their last send and again four
   * hours after a raise, or names nothing when `declared` is false. Each person joined at their entry in
   * `quietSince`, has sent nothing since, and was last seen at `seenAt`.
   */
  const room = (id: string, { quietSince = [T - 3 * HOUR], seenAt = T - 1_000, declared = true, over = {} as Partial<SeededSession> } = {}) => {
    const m = roomManifest({
      mode: "swarm", preset: null,
      roles: { lead: { can: ["send", "invite"], description: null, reports: false }, host: { can: ["send"], description: null, reports: false } },
      defaultRole: "lead", creatorRole: "lead", host: { role: "host", model: "haiku", instructions: null },
      housekeeping: declared ? { quietAfterMs: 2 * HOUR, answerWithinMs: null, idleAfterMs: null, repeatAfterMs: 4 * HOUR } : null,
    });
    const people = quietSince.map((at, i) => member({ memberId: `m_${i}`, userId: `u_${i}`, roomRole: "lead", joinedAt: at, lastSeenAt: seenAt }));
    return { ...session({ id, manifest: m, members: [...people, hostMember(m, T)], joinCodes: {} }), ...over } as SeededSession;
  };
  const housekept = async (store: MemoryStore, id: string) => ({
    events: (await store.eventsAfter(id, 0)).filter((e) => e.type === "housekeeping"),
    raised: (await store.getSession(id))!.raised,
  });

  it("(a) raises one proposal for a person past the threshold, from the room itself, records it, and wakes no seat", async () => {
    const store = new Recording();
    await store.createSession(room("qs_hk_a"));
    store.housekeep(T, rules);
    const { events, raised } = await housekept(store, "qs_hk_a");
    expect(events).toMatchObject([{
      cursor: 1, type: "housekeeping", fromMemberId: "system", fromUserId: "system", fromLabel: "bellman", refId: null, at: T,
      payload: { finding: "member_quiet", about: { member_id: "m_0" }, repeat: 1 },
    }]);
    expect(raised).toEqual({ "member_quiet:m_0": { at: T, repeat: 1, since: (events[0]!.payload as { since: number }).since } });
    expect(store.wakes).toEqual([]);
  });

  it("(b) raises nothing again inside the repeat window, and raises again at its end, counting up", async () => {
    const store = new Recording();
    await store.createSession(room("qs_hk_b"));
    store.housekeep(T, rules);
    store.housekeep(T + 4 * HOUR - 1, rules);
    expect((await housekept(store, "qs_hk_b")).events).toHaveLength(1);
    store.housekeep(T + 4 * HOUR, rules);
    expect((await housekept(store, "qs_hk_b")).events.map((e) => (e.payload as { repeat: number }).repeat)).toEqual([1, 2]);
  });

  it("(c) forgets a raised finding that no longer holds, and writes nothing for it", async () => {
    const store = new Recording();
    const seeded = room("qs_hk_c");
    // The person has sent since the raise: the finding holds no longer.
    (seeded.members[0] as { lastSentAt?: number }).lastSentAt = T - 60_000;
    await store.createSession({ ...seeded, raised: { "member_quiet:m_0": { at: T - HOUR, repeat: 1, since: T - HOUR } } } as SeededSession);
    store.housekeep(T, rules);
    expect(await housekept(store, "qs_hk_c")).toEqual({ events: [], raised: {} });
  });

  it.each([
    ["declares no housekeeping", { declared: false }],
    ["is closed", { over: { closed: true } }],
    ["is frozen", { over: { frozenAt: T - HOUR } }],
    ["is abandoned", { seenAt: T - ABANDONED_AFTER_MS - 1_000 }],
  ] as const)("(d) writes nothing into a room that %s, however long its person has been quiet", async (_, opts) => {
    const store = new Recording();
    await store.createSession(room("qs_hk_d", opts));
    store.housekeep(T, rules);
    expect(await housekept(store, "qs_hk_d")).toEqual({ events: [], raised: {} });
  });

  it("(e) writes one proposal per due key in one call, with consecutive cursors", async () => {
    const store = new Recording();
    await store.createSession(room("qs_hk_e", { quietSince: [T - 3 * HOUR, T - 5 * HOUR] }));
    store.housekeep(T, rules);
    const { events, raised } = await housekept(store, "qs_hk_e");
    expect(events.map((e) => [e.cursor, (e.payload as { about: { member_id: string } }).about.member_id])).toEqual([[1, "m_0"], [2, "m_1"]]);
    expect(Object.keys(raised).sort()).toEqual(["member_quiet:m_0", "member_quiet:m_1"]);
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

describe("hostSentEntries", () => {
  it("records a host's send for the room's org and every org with a person present, as the room's org acting", () => {
    const s = session({
      id: "qs_hosted", orgId: "org_a",
      members: [
        member({ orgId: "org_a" }),
        member({ memberId: "m_bo", userId: "u_bo", label: "Bo", orgId: "org_b", roomRole: "peer_b" }),
        member({ memberId: "m_host", userId: HOST_USER_ID, label: "host@bellman", orgId: null, roomRole: "host" }),
      ],
    });
    const rows = hostSentEntries(s, {
      type: "message", fromMemberId: "m_host", fromUserId: HOST_USER_ID, fromLabel: "host@bellman",
      payload: { text: "hi" }, refId: null,
    }, 9);

    expect(rows.map((r) => [r.orgId, r.actorOrgId, r.direction, r.parties])).toEqual([
      ["org_a", "org_a", "outbound", ["org_a", "org_b"]],
      ["org_b", "org_a", "inbound", ["org_a", "org_b"]],
    ]);
    expect(rows[0]).toMatchObject({ action: "sent_message", actorLabel: "host@bellman", roomName: s.manifest.room, detail: { chars: 13 } });
  });

  // The room's org got this row before the roster counted, so it still does when nobody of its own is left in the room.
  it("records a host's send for the room's org when none of its people are still in the room", () => {
    const s = session({
      id: "qs_hosted", orgId: "org_a",
      members: [
        member({ orgId: "org_a", leftAt: Date.now() }),
        member({ memberId: "m_bo", userId: "u_bo", label: "Bo", orgId: "org_b", roomRole: "peer_b" }),
        member({ memberId: "m_host", userId: HOST_USER_ID, label: "host@bellman", orgId: null, roomRole: "host" }),
      ],
    });
    const rows = hostSentEntries(s, {
      type: "message", fromMemberId: "m_host", fromUserId: HOST_USER_ID, fromLabel: "host@bellman",
      payload: { text: "hi" }, refId: null,
    }, 9);

    expect(rows.map((r) => [r.orgId, r.direction, r.parties])).toEqual([
      ["org_a", "outbound", ["org_a", "org_b"]],
      ["org_b", "inbound", ["org_a", "org_b"]],
    ]);
  });
});

describe("rosterParties", () => {
  it("is everyone the room seated, departed included, with the hosted seat left out", () => {
    const s = session({ members: [
      member({ orgId: "org_b" }),
      member({ memberId: "m_gone", userId: "u_gone", orgId: "org_a", leftAt: 1 }),
      member({ memberId: "m_solo", userId: "u_solo", orgId: null }),
      member({ memberId: "m_host", userId: HOST_USER_ID, orgId: null }),
    ] });
    expect(rosterParties(s)).toEqual(["org_a", "org_b", null]);
  });

  it("has no null when the only member with no org is the hosted seat", () => {
    const s = session({ members: [member({ orgId: "org_a" }), member({ memberId: "m_host", userId: HOST_USER_ID, orgId: null })] });
    expect(rosterParties(s)).toEqual(["org_a"]);
  });
});

describe("verifyAudit sees a row edited behind the store's back", () => {
  it("reports the edited row as the break", async () => {
    const store = new MemoryStore();
    for (const at of [1, 2, 3]) await store.appendAudit({ at, orgId: "org_a", sessionId: "qs_1", actorUserId: "u_a", action: "sent_message", detail: { at } });
    (store as unknown as { audit: { seq: number; entry: AuditEntry }[] }).audit[1]!.entry.action = "edited";
    expect(await store.verifyAudit("org_a")).toMatchObject({ ok: false, broken_at: 2 });
  });
});

describe("the sink's deliveries", () => {
  const by = { actorUserId: "u_admin", actorOrgId: "org_a" };
  const url = "https://collector.example/in";
  const row = (at: number) => ({ at, orgId: "org_a", sessionId: "qs_1", actorUserId: "u_a", action: "sent_message", detail: { at } });
  /** A store whose sink posts to `answer`: every request kept, in order. */
  const rig = (answer: () => Response | Promise<Response>) => {
    const posts: { url: string; init: RequestInit }[] = [];
    const store = new MemoryStore({ post: ((u: string, init: RequestInit) => { posts.push({ url: u, init }); return answer(); }) as unknown as typeof fetch });
    return { store, posts };
  };
  const verified = async (secret: string, init: RequestInit) => {
    const h = init.headers as Record<string, string>;
    const [t, v1] = h["Bellman-Signature"].split(",").map((kv) => kv.slice(kv.indexOf("=") + 1));
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    return crypto.subtle.verify("HMAC", key, Uint8Array.from(v1.match(/../g)!, (x) => parseInt(x, 16)), enc.encode(`${t}.${init.body as string}`));
  };

  it("posts the rows past the cursor as one signed batch and advances the cursor", async () => {
    const { store, posts } = rig(() => new Response(null, { status: 200 }));
    await store.appendAudit(row(1));
    await store.appendAudit(row(2));
    const { secret } = await store.setAuditSink("org_a", url, by);
    const t = Date.now() + SINK_DELAY_MS;
    await store.sweep(t);
    expect(posts).toHaveLength(1);
    const { init } = posts[0];
    const h = init.headers as Record<string, string>;
    expect([posts[0].url, init.method, h["Content-Type"], h["Bellman-Delivery"]]).toEqual([url, "POST", "application/json", "org_a:1-3"]);
    expect(await verified(secret, init)).toBe(true);
    expect(await verified("not the secret", init)).toBe(false);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ org_id: "org_a", delivery: "org_a:1-3" });
    expect(body.entries.map((e: { seq: number; action: string }) => [e.seq, e.action])).toEqual([[1, "sent_message"], [2, "sent_message"], [3, "audit_sink_set"]]);
    expect((await store.auditSettings("org_a")).sink).toMatchObject({ status: "ok", delivered_through: 3, pending: 0, attempts: 0 });
    await store.sweep(t + 1);
    expect(posts).toHaveLength(1);
  });

  it("keeps the cursor on a refusal, backs off, and clears the failure when the next post lands", async () => {
    let status = 500;
    const { store, posts } = rig(() => new Response(null, { status }));
    await store.appendAudit(row(1));
    await store.setAuditSink("org_a", url, by);
    const t = Date.now() + SINK_DELAY_MS;
    await store.sweep(t);
    expect((await store.auditSettings("org_a")).sink).toMatchObject({ status: "failing", attempts: 1, delivered_through: 0, pending: 2, last_error: "500", failing_since: new Date(t).toISOString() });
    await store.sweep(t + backoffMs(1) - 1);
    expect(posts).toHaveLength(1);
    status = 200;
    await store.sweep(t + backoffMs(1));
    expect(posts).toHaveLength(2);
    expect((await store.auditSettings("org_a")).sink).toMatchObject({ status: "ok", attempts: 0, delivered_through: 2, pending: 0, last_error: null, failing_since: null });
  });

  it("records a thrown post as the error", async () => {
    const { store } = rig(() => { throw new Error("getaddrinfo ENOTFOUND collector.example"); });
    await store.appendAudit(row(1));
    await store.setAuditSink("org_a", url, by);
    await store.sweep(Date.now() + SINK_DELAY_MS);
    expect((await store.auditSettings("org_a")).sink).toMatchObject({ status: "failing", attempts: 1, last_error: "getaddrinfo ENOTFOUND collector.example" });
  });

  it("is dead after a day of failure, says so in the stream, posts no more, and delivers again once resumed", async () => {
    let status = 503;
    const { store, posts } = rig(() => new Response(null, { status }));
    await store.appendAudit(row(1));
    await store.setAuditSink("org_a", url, by);
    const t = Date.now() + SINK_DELAY_MS;
    await store.sweep(t);
    await store.sweep(t + SINK_DEAD_AFTER_MS);
    expect(posts).toHaveLength(2);
    const sink = (await store.auditSettings("org_a")).sink!;
    expect(sink).toMatchObject({ status: "dead", attempts: 2, last_error: "503", failing_since: new Date(t).toISOString() });
    expect((await store.auditForOrg("org_a", 10)).at(-1)).toMatchObject({
      action: "audit_sink_dead", actorUserId: "system", detail: { url, failing_since: new Date(t).toISOString(), last_error: "503" },
    });
    status = 200;
    await store.appendAudit(row(2));
    await store.sweep(t + 2 * SINK_DEAD_AFTER_MS);
    expect(posts).toHaveLength(2);
    const resumed = (await store.resumeAuditSink("org_a", by))!;
    expect(resumed).toMatchObject({ status: "ok", attempts: 0, delivered_through: 0, pending: 5, last_error: null, failing_since: null });
    await store.sweep(t + 2 * SINK_DEAD_AFTER_MS + 1);
    expect(posts).toHaveLength(3);
    expect((posts[2].init.headers as Record<string, string>)["Bellman-Delivery"]).toBe("org_a:1-5");
    expect((await store.auditSettings("org_a")).sink).toMatchObject({ status: "ok", delivered_through: 5, pending: 0 });
  });

  it("delivers a long backlog a batch at a time, the next pass dated now", async () => {
    const { store, posts } = rig(() => new Response(null, { status: 200 }));
    for (let i = 1; i <= SINK_BATCH + 50; i++) await store.appendAudit(row(i));
    await store.setAuditSink("org_a", url, by);
    const t = Date.now() + SINK_DELAY_MS;
    await store.sweep(t);
    expect(posts).toHaveLength(1);
    expect((posts[0].init.headers as Record<string, string>)["Bellman-Delivery"]).toBe(`org_a:1-${SINK_BATCH}`);
    expect((await store.auditSettings("org_a")).sink).toMatchObject({ delivered_through: SINK_BATCH, pending: 51 });
    await store.sweep(t);
    expect(posts).toHaveLength(2);
    expect((posts[1].init.headers as Record<string, string>)["Bellman-Delivery"]).toBe(`org_a:${SINK_BATCH + 1}-${SINK_BATCH + 51}`);
    expect((await store.auditSettings("org_a")).sink).toMatchObject({ delivered_through: SINK_BATCH + 51, pending: 0 });
    await store.sweep(t);
    expect(posts).toHaveLength(2);
  });
});
