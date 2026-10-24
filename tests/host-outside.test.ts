/**
 * The hosted seat as the voice of an outside question (A2A, Task 4): the seat-or-members choice at ask time,
 * the hand-off when the seat skips or stays silent, and the seat answering through `answerQuestion`.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStore } from "../src/store.js";
import { MemoryHost } from "../src/host-memory.js";
import { HOST_MEMBER_ID, hostMember, type HostWake } from "../src/host.js";
import { SEAT_OUTSIDE_DAILY_CAP, SEAT_SILENCE_MS, answerQuestion, askRoom, outsideTask, type Caller } from "../src/outside.js";
import { monthKey } from "../src/stored-session.js";
import type { OutsideTask } from "../src/types.js";
import { member, roomManifest, session } from "./helpers/fixtures.js";

const PUB = "qs_hosted_public";
const DAY = Date.UTC(2026, 9, 23, 12, 0, 0);
const caller = (n: number): Caller => ({ userId: `u_out${n}`, label: `out${n}@elsewhere` });
const creator = { memberId: "m_creator" };
const seat = { memberId: HOST_MEMBER_ID };

const manifest = (host = true) => roomManifest({
  public: true, room: "Open review", purpose: "Ask us", mode: "swarm", preset: null,
  roles: { lead: { can: ["send", "invite"], description: null, reports: false }, host: { can: ["send"], description: null, reports: false } },
  defaultRole: "lead", creatorRole: "lead", host: host ? { role: "host", model: "haiku", instructions: null } : null,
});

async function room(store: MemoryStore, { host = true, now = DAY }: { host?: boolean; now?: number } = {}) {
  const m = manifest(host);
  await store.createSession(session({
    id: PUB, manifest: m, members: [member({ roomRole: "lead", lastSeenAt: now }), ...(host ? [hostMember(m, now)] : [])],
    hostUnitsPerMonth: 10, hostUnits: { month: monthKey(now), used: 0, wakes: [] },
  }));
}

const asked = async (store: MemoryStore, n: number, now = DAY): Promise<OutsideTask> => {
  const r = await askRoom(store, PUB, caller(n), { text: `question ${n}` }, now);
  if (!r.ok) throw new Error(`ask ${n} refused: ${r.error}`);
  return r.task;
};
const read = async (store: MemoryStore, n: number, taskId: string) => (await outsideTask(store, PUB, `u_out${n}`, taskId))!;

describe("the seat or the members, decided at ask time", () => {
  let store: MemoryStore;
  let woken: HostWake[];
  beforeEach(async () => {
    woken = [];
    store = new MemoryStore({ host: (w) => { woken.push(w); } });
    await room(store);
  });

  it("a room with a seat starts voice seat and enqueues an outside wake", async () => {
    const task = await asked(store, 1);
    expect(task.voice).toBe("seat");
    expect(task.seatDeadline).toBe(DAY + SEAT_SILENCE_MS);
    expect(woken).toEqual([{ sessionId: PUB, cause: "outside", cursor: task.questionCursors[0] }]);
  });

  it("a room without a seat starts voice members and enqueues nothing", async () => {
    const plain = new MemoryStore({ host: (w) => { woken.push(w); } });
    await room(plain, { host: false });
    const task = await asked(plain, 1);
    expect(task.voice).toBe("members");
    expect(task.seatDeadline).toBeNull();
    expect(woken).toEqual([]);
  });

  it("21st question of the UTC day starts voice members and enqueues nothing", async () => {
    for (let n = 1; n <= SEAT_OUTSIDE_DAILY_CAP; n++) expect((await asked(store, n)).voice).toBe("seat");
    expect(woken).toHaveLength(SEAT_OUTSIDE_DAILY_CAP);

    const late = await asked(store, SEAT_OUTSIDE_DAILY_CAP + 1);
    expect(late.voice).toBe("members");
    expect(late.seatDeadline).toBeNull();
    expect(woken).toHaveLength(SEAT_OUTSIDE_DAILY_CAP);

    // The count is the UTC day's: the next day starts again.
    const tomorrow = await asked(store, SEAT_OUTSIDE_DAILY_CAP + 2, DAY + 24 * 60 * 60_000);
    expect(tomorrow.voice).toBe("seat");
    expect(woken).toHaveLength(SEAT_OUTSIDE_DAILY_CAP + 1);
  });
});

describe("the hand-off to the members", () => {
  let store: MemoryStore;
  beforeEach(async () => {
    store = new MemoryStore();
    await room(store);
  });

  it("the seat skipping hands the voice to members", async () => {
    const task = await asked(store, 1);
    await store.seatSkipped(PUB, task.id, "the room is frozen");
    const after = await read(store, 1, task.id);
    expect(after.voice).toBe("members");
    expect(after.seatDeadline).toBeNull();

    const r = await answerQuestion(store, PUB, creator, { refId: task.questionCursors[0], text: "we review parsers" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it("a skip after the seat answered changes nothing", async () => {
    const task = await asked(store, 1);
    expect((await answerQuestion(store, PUB, seat, { refId: task.questionCursors[0], text: "parsers" })).ok).toBe(true);
    await store.seatSkipped(PUB, task.id, "late");
    const after = await read(store, 1, task.id);
    expect(after.voice).toBe("seat");
    expect(after.state).toBe("TASK_STATE_COMPLETED");
  });

  it("ten minutes of seat silence hands the voice to members", async () => {
    const task = await asked(store, 1);
    await store.sweep(DAY + SEAT_SILENCE_MS - 1);
    expect((await read(store, 1, task.id)).voice).toBe("seat");

    await store.sweep(DAY + SEAT_SILENCE_MS);
    const after = await read(store, 1, task.id);
    expect(after.voice).toBe("members");
    expect(after.seatDeadline).toBeNull();
    const r = await answerQuestion(store, PUB, creator, { refId: task.questionCursors[0], text: "we review parsers" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it("a seat answer after the hand-off is not_the_voice", async () => {
    const task = await asked(store, 1);
    await store.seatSkipped(PUB, task.id, "the model failed");
    const r = await answerQuestion(store, PUB, seat, { refId: task.questionCursors[0], text: "too late" });
    expect(r).toEqual({ ok: false, error: "not_the_voice" });
  });

  it("a member answer while the seat is voice is not_the_voice", async () => {
    const task = await asked(store, 1);
    const r = await answerQuestion(store, PUB, creator, { refId: task.questionCursors[0], text: "me first" });
    expect(r).toEqual({ ok: false, error: "not_the_voice" });
    expect((await answerQuestion(store, PUB, seat, { refId: task.questionCursors[0], text: "parsers" })).ok).toBe(true);
  });
});

/** A canned Messages API: each call takes the next reply. */
function fakeModel(replies: { status: number; text?: string }[]) {
  const calls: { system: string; messages: { content: string }[] }[] = [];
  const f = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    const r = replies.shift() ?? { status: 200, text: "default" };
    return new Response(JSON.stringify(r.status === 200 ? { content: [{ type: "text", text: r.text }] } : { error: {} }), { status: r.status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("the seat handles an outside wake", () => {
  async function seated(replies: { status: number; text?: string }[], { enabled = true, frozen = false } = {}) {
    const { f, calls } = fakeModel(replies);
    let host!: MemoryHost;
    const store = new MemoryStore({ host: (w) => { void host.wake(w); } });
    host = new MemoryHost(store, { modelUrl: "http://fake", fetch: f, retryMs: [1, 1, 1], enabled });
    await room(store, { now: Date.now() });
    await store.appendEvent(PUB, { type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: { text: "we only review parsers" }, refId: null });
    if (frozen) await store.freezeSession(PUB, Date.now());
    return { store, host, calls };
  }

  it("answers through answerQuestion, wraps the question untrusted, reads the room, and is charged", async () => {
    const { store, host, calls } = await seated([{ status: 200, text: "This room reviews parsers." }]);
    const task = await asked(store, 1, Date.now());
    await host.settled();

    const after = await read(store, 1, task.id);
    expect(after.state).toBe("TASK_STATE_COMPLETED");
    expect(after.answers.map((a) => a.text)).toEqual(["This room reviews parsers."]);
    const answer = (await store.eventsAfter(PUB, 0)).find((e) => e.type === "outside_answer")!;
    expect(answer.fromMemberId).toBe(HOST_MEMBER_ID);
    expect((await store.getSession(PUB))!.hostUnits.used).toBe(1);

    expect(calls).toHaveLength(1);
    const prompt = calls[0].messages[0].content;
    expect(prompt).toContain("question 1");
    expect(prompt).toContain('&quot;trust&quot;:&quot;untrusted&quot;');
    expect(prompt).toContain("we only review parsers");
  });

  it("the flag off hands the voice to members without a model call", async () => {
    const { store, host, calls } = await seated([], { enabled: false });
    const task = await asked(store, 1, Date.now());
    await host.settled();
    expect((await read(store, 1, task.id)).voice).toBe("members");
    expect(calls).toHaveLength(0);
  });

  it("the seat passing hands the voice to members and is not charged", async () => {
    const { store, host } = await seated([{ status: 200, text: "PASS" }]);
    const task = await asked(store, 1, Date.now());
    await host.settled();
    const after = await read(store, 1, task.id);
    expect(after.voice).toBe("members");
    expect(after.state).toBe("TASK_STATE_WORKING");
    expect((await store.getSession(PUB))!.hostUnits.used).toBe(0);
  });

  it("a model that keeps failing hands the voice to members", async () => {
    const { store, host, calls } = await seated([{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }]);
    const task = await asked(store, 1, Date.now());
    await host.settled();
    expect(calls).toHaveLength(4);
    expect((await read(store, 1, task.id)).voice).toBe("members");
  });

  it("a frozen room hands the voice to members", async () => {
    const { store, host, calls } = await seated([], { frozen: true });
    const task = await asked(store, 1, Date.now()).catch(() => null);
    // A frozen public room may refuse the ask outright; if it is admitted, the seat must not hold the voice.
    if (task) {
      await host.settled();
      expect((await read(store, 1, task.id)).voice).toBe("members");
    }
    expect(calls).toHaveLength(0);
  });

  it("no units left hands the voice to members", async () => {
    const { store, host, calls } = await seated([]);
    // Spend the month's allowance: the meter refuses before any model call.
    (store as unknown as { sessions: Map<string, { hostUnits: { used: number } }> }).sessions.get(PUB)!.hostUnits.used = 10;
    const task = await asked(store, 1, Date.now());
    await host.settled();
    expect((await read(store, 1, task.id)).voice).toBe("members");
    expect(calls).toHaveLength(0);
  });
});
