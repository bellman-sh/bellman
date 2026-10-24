/**
 * An outside caller's question, against the storage that makes it one write (A2A, Task 2): `askOutside` decides and
 * writes the event, the task row, the caller's standing and the visitor counter in one `ctx.storage.transaction`.
 */
import { it, expect, afterEach, vi } from "vitest";
import { env, reset, abortAllDurableObjects, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { answerQuestion, askRoom, cancelOutsideTask, OUTSIDE_TASK_TTL_MS, type AskRequest } from "../src/outside.js";
import { DurableObjectStore, type SessionDO } from "../src/store-do.js";
import { member, roomManifest, session } from "../tests/helpers/fixtures.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

const ID = "qs_outside";
const stubOf = (id: string) => env.SESSION.get(env.SESSION.idFromName(id));
const publicRoom = () => session({ id: ID, manifest: roomManifest({ public: true, room: "Open review", purpose: "Ask us" }), members: [member()] });
const req = (over: Partial<AskRequest> = {}): AskRequest => ({ callerUserId: "u_out", handle: undefined, text: "hi", now: 1, ...over });
const rowsOf = (prefix: string) => runInDurableObject(stubOf(ID), (_i: SessionDO, state) => state.storage.list({ prefix }).then((m) => [...m.keys()]));

it("task row and event commit together", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(publicRoom());
  const before = await store.eventsAfter(ID, 0);

  // The task row's write is the one that fails, after everything else of the ask is staged: the event and the cursor
  // go in first, then the `ot:` entry is refused. Patched on this object's storage, in the test only, for both the
  // transaction's writes and the storage's own, so a task row written anywhere else is refused the same way.
  const refused = runInDurableObject(stubOf(ID), async (instance: SessionDO, state) => {
    const refuse = (put: (e: Record<string, unknown>) => Promise<void>) => async (a: unknown, b?: unknown) => {
      const all: Record<string, unknown> = typeof a === "string" ? { [a]: b } : (a as Record<string, unknown>);
      const task = Object.keys(all).filter((k) => k.startsWith("ot:"));
      await put(Object.fromEntries(Object.entries(all).filter(([k]) => !k.startsWith("ot:"))));
      if (task.length > 0) throw new Error("storage rejected the task row");
    };
    const real = state.storage.transaction.bind(state.storage);
    const realPut = state.storage.put.bind(state.storage);
    state.storage.put = refuse((e) => realPut(e)) as never;
    state.storage.transaction = ((closure: (t: DurableObjectTransaction) => Promise<unknown>) => real((txn) => {
      const put = txn.put.bind(txn);
      txn.put = refuse((e) => put(e)) as never;
      return closure(txn);
    })) as never;
    try {
      return await instance.askOutside(req());
    } finally {
      delete (state.storage as { transaction?: unknown; put?: unknown }).transaction;
      delete (state.storage as { transaction?: unknown; put?: unknown }).put;
    }
  });
  await expect(refused).rejects.toThrow(/storage rejected the task row/);

  expect(await store.eventsAfter(ID, 0)).toEqual(before);
  expect([await rowsOf("ot:"), await rowsOf("oc:"), await rowsOf("ov")]).toEqual([[], [], []]);

  // The control, unpatched: the same ask lands all of it, and the cursor the failed one did not consume.
  const landed = await runInDurableObject(stubOf(ID), (instance: SessionDO) => instance.askOutside(req()));
  if (!landed.ok) throw new Error("refused");
  const last = (await store.eventsAfter(ID, 0)).at(-1);
  expect(last).toMatchObject({ type: "outside_question", cursor: (before.at(-1)?.cursor ?? 0) + 1 });
  expect(landed.task.questionCursors).toEqual([last?.cursor]);
  expect([(await rowsOf("ot:")).length, await rowsOf("oc:"), await rowsOf("ov")]).toEqual([1, ["oc:u_out"], ["ov"]]);
});

it("simultaneous asks hold the cap, one context and distinct visitor numbers", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(publicRoom());
  const ask = (n: number, text: string) => askRoom(store, ID, { userId: `u_${n}`, label: `${n}@x` }, { text });

  const same = await Promise.all([1, 2, 3, 4, 5].map((n) => ask(1, `q${n}`)));
  const others = await Promise.all([2, 3].map((n) => ask(n, "hi")));

  expect(same.filter((r) => r.ok)).toHaveLength(3);
  expect(same.filter((r) => !r.ok)).toEqual([{ ok: false, error: "too_many_open" }, { ok: false, error: "too_many_open" }]);
  expect(new Set(same.flatMap((r) => (r.ok ? [r.task.contextId] : []))).size).toBe(1);
  expect(same.flatMap((r) => (r.ok ? [r.task.origin] : []))).toEqual(["visitor 1", "visitor 1", "visitor 1"]);
  expect(others.map((r) => r.ok && r.task.origin).sort()).toEqual(["visitor 2", "visitor 3"]);
  expect((await store.eventsAfter(ID, 0)).filter((e) => e.type === "outside_question")).toHaveLength(5);
  expect((await store.outsideTasksOf(ID, "u_1")).every((t) => t.questionCursors.length === 1)).toBe(true);
});

it("two follow-ups at once on one task: one lands, so no question cursor is lost", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(publicRoom());
  const first = await askRoom(store, ID, { userId: "u_1", label: "1@x" }, { text: "q" });
  if (!first.ok) throw new Error("refused");
  await store.appendEvent(ID, { type: "message", fromMemberId: "system", fromUserId: "system", fromLabel: "x", payload: {}, refId: null }, {
    outsideTask: { ...first.task, state: "TASK_STATE_INPUT_REQUIRED" },
  });

  const both = await Promise.all(["one", "two"].map((text) => askRoom(store, ID, { userId: "u_1", label: "1@x" }, { text, taskId: first.task.id })));

  expect(both.filter((r) => r.ok)).toHaveLength(1);
  expect(both.find((r) => !r.ok)).toEqual({ ok: false, error: "not_input_required" });
  expect((await store.outsideTask(ID, "u_1", first.task.id))?.questionCursors).toHaveLength(2);
});

it("asks a public room through the Durable Object store", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(publicRoom());

  const first = await askRoom(store, ID, { userId: "u_a", label: "a" }, { text: "one" });
  const again = await askRoom(store, ID, { userId: "u_a", label: "a" }, { text: "two" });
  const other = await askRoom(store, ID, { userId: "u_b", label: "b" }, { text: "three" });

  if (!first.ok || !again.ok || !other.ok) throw new Error("asks refused");
  expect(again.task.contextId).toBe(first.task.contextId);
  expect(other.task.contextId).not.toBe(first.task.contextId);
  expect([first.task.origin, other.task.origin]).toEqual(["visitor 1", "visitor 2"]);
  expect((await store.outsideTasksOf(ID, "u_a")).map((t) => t.id)).toEqual([again.task.id, first.task.id]);
  expect(await store.outsideTask(ID, "u_b", first.task.id), "someone else's task").toBeUndefined();
  const asked = (await store.eventsAfter(ID, 0)).filter((e) => e.type === "outside_question");
  expect(asked.map((e) => [e.fromLabel, (e.payload as { text: string }).text])).toEqual([["visitor 1", "one"], ["visitor 1", "two"], ["visitor 2", "three"]]);
  expect(first.task.questionCursors).toEqual([asked[0].cursor]);
});

it("two role holders answering at once: one answer event, one winner, and the row shows it", async () => {
  const store = new DurableObjectStore(env as never);
  const m = roomManifest({ public: true, room: "Open review", purpose: "Ask us" });
  const manifest = { ...m, roles: Object.fromEntries(Object.entries(m.roles).map(([r, def]) => [r, { ...def, can: [...def.can, "answer" as const] }])) };
  await store.createSession(session({ id: ID, manifest, members: [member(), member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b" })] }));
  const asked = await askRoom(store, ID, { userId: "u_1", label: "1@x" }, { text: "q" });
  if (!asked.ok) throw new Error("refused");
  const ref = asked.task.questionCursors[0];

  const both = await Promise.all(["m_creator", "m_peer"].map((memberId, n) => answerQuestion(store, ID, { memberId }, { refId: ref, text: `answer ${n}` })));

  expect(both.filter((r) => r.ok)).toHaveLength(1);
  expect(both.find((r) => !r.ok)).toEqual({ ok: false, error: "already_answered" });
  const events = (await store.eventsAfter(ID, 0)).filter((e) => e.type === "outside_answer");
  expect(events).toHaveLength(1);
  const row = await store.outsideTask(ID, "u_1", asked.task.id);
  expect(row).toMatchObject({ state: "TASK_STATE_COMPLETED" });
  expect(row?.answers).toEqual([{ cursor: events[0].cursor, text: (events[0].payload as { text: string }).text, at: events[0].at }]);
});

const notices = async (store: DurableObjectStore) =>
  (await store.eventsAfter(ID, 0)).filter((e) => e.type === "outside_notice").map((e) => e.payload);
const alarmAt = () => runInDurableObject(stubOf(ID), (i: SessionDO) =>
  (i as unknown as { ctx: { storage: { getAlarm(): Promise<number | null> } } }).ctx.storage.getAlarm());

const record = () => runInDurableObject(stubOf(ID), (_i: SessionDO, state) =>
  state.storage.get<{ seatWaits?: Record<string, number>; outsideExpiryAt?: number | null }>("session"));

it("an unanswered task fails after OUTSIDE_TASK_TTL_MS", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(publicRoom());
  const now = Date.now();
  const young = await askRoom(store, ID, { userId: "u_new", label: "n@x" }, { text: "recent" }, now);
  // Asked more than the lifetime ago: the ask arms the alarm, and a past alarm fires by itself, so nothing here calls it.
  const old = await askRoom(store, ID, { userId: "u_old", label: "o@x" }, { text: "ancient" }, now - OUTSIDE_TASK_TTL_MS - 1);
  if (!young.ok || !old.ok) throw new Error("refused");

  await vi.waitFor(async () => expect((await store.outsideTask(ID, "u_old", old.task.id))?.state).toBe("TASK_STATE_FAILED"));

  expect(await store.outsideTask(ID, "u_old", old.task.id)).toMatchObject({ statusMessage: "The room didn't answer in time.", seatDeadline: null });
  expect(await store.outsideTask(ID, "u_new", young.task.id), "a recent task is left open").toMatchObject({ state: "TASK_STATE_WORKING" });
  expect(await notices(store)).toEqual([{ taskId: old.task.id, text: "The room didn't answer in time." }]);
  expect((await record())?.outsideExpiryAt, "the next lapse is the recent task's").toBe(young.task.updatedAt + OUTSIDE_TASK_TTL_MS);
});

it("the expiry alarm ends the lapsed task and leaves the seat's deadline and the alarm alone", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(publicRoom());
  const asked = await askRoom(store, ID, { userId: "u_old", label: "o@x" }, { text: "q" });
  if (!asked.ok) throw new Error("refused");
  const wait = Date.now() + 60 * 60_000;
  const lapsed = Date.now() - OUTSIDE_TASK_TTL_MS - 1;
  await runInDurableObject(stubOf(ID), async (_i: SessionDO, state) => {
    const rec = (await state.storage.get<Record<string, unknown>>("session"))!;
    await state.storage.put("session", { ...rec, seatWaits: { other: wait }, outsideExpiryAt: lapsed + OUTSIDE_TASK_TTL_MS });
    const key = `ot:${asked.task.id}`;
    await state.storage.put(key, { ...(await state.storage.get<object>(key)), updatedAt: lapsed });
  });

  await runDurableObjectAlarm(stubOf(ID));

  expect(await store.outsideTask(ID, "u_old", asked.task.id)).toMatchObject({ state: "TASK_STATE_FAILED", statusMessage: "The room didn't answer in time." });
  expect(await notices(store)).toEqual([{ taskId: asked.task.id, text: "The room didn't answer in time." }]);
  expect(await record(), "the seat's wait stays, and nothing is left to expire").toMatchObject({ seatWaits: { other: wait }, outsideExpiryAt: null });
  const next = await alarmAt();
  expect(next, "the alarm is still armed for what is owed").not.toBeNull();
  expect(next).toBeLessThanOrEqual(wait);
  await runDurableObjectAlarm(stubOf(ID));
  expect(await notices(store), "fires once").toHaveLength(1);
});

it("caller cancel, unpublish and close each end open tasks, with the notice, in storage", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(publicRoom());
  const ask = async (n: number) => {
    const r = await askRoom(store, ID, { userId: `u_${n}`, label: `${n}@x` }, { text: "q" });
    if (!r.ok) throw new Error("refused");
    return r.task;
  };
  const [a, b, c] = [await ask(1), await ask(2), await ask(3)];

  expect(await cancelOutsideTask(store, ID, "u_2", a.id), "someone else's").toEqual({ ok: false, error: "task_not_found" });
  expect(await cancelOutsideTask(store, ID, "u_1", a.id)).toMatchObject({ ok: true, task: { state: "TASK_STATE_CANCELED" } });
  expect(await cancelOutsideTask(store, ID, "u_1", a.id)).toEqual({ ok: false, error: "not_cancelable" });
  expect(await answerQuestion(store, ID, { memberId: "m_creator" }, { refId: a.questionCursors[0], text: "late" })).toEqual({ ok: false, error: "task_closed" });
  await store.unpublishSession(ID, Date.now());
  expect(await store.outsideTask(ID, "u_2", b.id)).toMatchObject({ state: "TASK_STATE_CANCELED", statusMessage: "The room went private." });
  expect(await store.outsideTask(ID, "u_3", c.id)).toMatchObject({ state: "TASK_STATE_CANCELED", seatDeadline: null });
  expect(await notices(store)).toEqual([
    { taskId: a.id, text: "The asker canceled this question." },
    { taskId: b.id, text: "The room went private." },
    { taskId: c.id, text: "The room went private." },
  ]);
});

it("closing the room ends its open tasks with the room's words", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(publicRoom());
  const asked = await askRoom(store, ID, { userId: "u_1", label: "1@x" }, { text: "q" });
  if (!asked.ok) throw new Error("refused");

  await store.closeSession(ID);

  expect(await store.outsideTask(ID, "u_1", asked.task.id)).toMatchObject({ state: "TASK_STATE_CANCELED", statusMessage: "The room closed.", seatDeadline: null });
  expect(await notices(store)).toEqual([{ taskId: asked.task.id, text: "The room closed." }]);
  await store.closeSession(ID);
  expect(await notices(store), "a second close ends nothing again").toHaveLength(1);
});
