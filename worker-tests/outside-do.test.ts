/**
 * An outside caller's question and its task row, against the storage that makes them one write (A2A, Task 2): the
 * row rides `appendEvent`'s extras, so the event and the row commit in one `ctx.storage.transaction` or not at all.
 */
import { it, expect, afterEach } from "vitest";
import { env, reset, abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { askRoom, outsideTask } from "../src/outside.js";
import { DurableObjectStore, type SessionDO } from "../src/store-do.js";
import type { OutsideTask } from "../src/types.js";
import { member, roomManifest, session } from "../tests/helpers/fixtures.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

const ID = "qs_outside";
const stubOf = (id: string) => env.SESSION.get(env.SESSION.idFromName(id));
const publicRoom = () => session({ id: ID, manifest: roomManifest({ public: true, room: "Open review", purpose: "Ask us" }), members: [member()] });
const question = { type: "outside_question" as const, fromMemberId: "system", fromUserId: "system", fromLabel: "visitor 1", payload: { taskId: "t1", text: "hi" }, refId: null };
const task = (over: Partial<OutsideTask> = {}): OutsideTask => ({
  id: "t1", contextId: "c1", sessionId: ID, callerUserId: "u_out", origin: "visitor 1", state: "TASK_STATE_WORKING", voice: "members",
  questionCursors: [], answers: [], createdAt: 1, updatedAt: 1, seatDeadline: null, ...over,
});

it("task row and event commit together", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(publicRoom());
  const before = await store.eventsAfter(ID, 0);

  // A row for another room's task fails the append after its event is built, inside the transaction.
  const refused = runInDurableObject(stubOf(ID), (instance: SessionDO) =>
    instance.appendEvent(question, { outsideTask: task({ sessionId: "qs_elsewhere" }), outsideCaller: { userId: "u_out", contextId: "c1", visitor: 1 } }));
  await expect(refused).rejects.toThrow(/belongs to qs_elsewhere/);

  expect(await store.eventsAfter(ID, 0)).toEqual(before);
  expect(await outsideTask(store, ID, "u_out", "t1")).toBeUndefined();
  expect(await store.outsideCallers(ID)).toEqual([]);

  // The control: the same append with a row for this room lands both, and the next event takes the cursor the failed one did not use.
  const landed = await runInDurableObject(stubOf(ID), (instance: SessionDO) =>
    instance.appendEvent(question, { outsideTask: task(), outsideCaller: { userId: "u_out", contextId: "c1", visitor: 1 } }));
  expect(landed?.cursor).toBe((before.at(-1)?.cursor ?? 0) + 1);
  expect(await outsideTask(store, ID, "u_out", "t1")).toMatchObject({ id: "t1", questionCursors: [landed!.cursor] });
  expect(await store.outsideCallers(ID)).toEqual([{ userId: "u_out", contextId: "c1", visitor: 1 }]);
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
