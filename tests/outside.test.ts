/**
 * Outside callers (A2A): the limits and the verb (Task 1), and asking a public room (Task 2).
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { VERBS, builtinPresets, resolveManifest, PRESET_NAMES } from "../src/manifest.js";
import { verbsOfRole } from "../src/roles.js";
import { pairUp } from "./helpers/flows.js";
import { Harness } from "./helpers/harness.js";
import { askRoom, outsideTask, outsideTasksOf, type AskInput, type Caller } from "../src/outside.js";
import { evictMember } from "../src/rooms.js";
import { MemoryStore } from "../src/store.js";
import type { Identity, Session } from "../src/types.js";
import { member, roomManifest, session } from "./helpers/fixtures.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("the answer verb", () => {
  it('"answer" is a verb no built-in preset grants', () => {
    expect(VERBS).toContain("answer");
    for (const { name } of builtinPresets()) {
      const m = resolveManifest({ room: "r", preset: name });
      for (const role of Object.keys(m.roles)) {
        expect(verbsOfRole(m, role), `${name}/${role}`).not.toContain("answer");
      }
    }
    expect(builtinPresets()).toHaveLength(PRESET_NAMES.length);
  });

  it("a manifest role can be granted answer", () => {
    const m = resolveManifest({
      room: "r", mode: "pair",
      roles: { lead: { can: ["send", "answer"] }, helper: { can: ["send"] } },
      default_role: "helper", creator_role: "lead",
    });
    expect(verbsOfRole(m, "lead")).toContain("answer");
  });
});

describe("outside_answer before the A2A door exists", () => {
  it("is refused by bellman_send, whatever the sender's role", async () => {
    const harness = (h = new Harness());
    const s = await pairUp(harness);
    const out = await s.creator.call("bellman_send", {
      session_id: s.sessionId, member_id: s.creatorMemberId, type: "outside_answer", payload: { text: "hi" },
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("not supported yet");
  });
});

describe("asking a public room", () => {
  const PUB = "qs_public";
  const jesse: Identity = { userId: "u_jesse", orgId: "org_codenerd", plan: "team", role: "admin", label: "jesse@codenerd" };
  const caller = (n: number): Caller => ({ userId: `u_out${n}`, label: `out${n}@elsewhere` });
  let store: MemoryStore;

  const publicRoom = (over: Partial<Session> = {}) => session({
    id: PUB, manifest: roomManifest({ public: true, room: "Open review", purpose: "Ask us" }),
    members: [member(), member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b" })], ...over,
  });
  const ask = (c: Caller, text = "what is this room for?", extra: Partial<AskInput> = {}, ref = PUB, now?: number) =>
    askRoom(store, ref, c, { text, ...extra }, now);
  const questions = async () => (await store.eventsAfter(PUB, 0)).filter((e) => e.type === "outside_question");

  beforeEach(async () => {
    store = new MemoryStore();
    await store.createSession(publicRoom());
  });

  it("asks a public room", async () => {
    const r = await ask(caller(1));

    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.task.state).toBe("TASK_STATE_WORKING");
    expect(r.task.voice).toBe("members");
    expect(r.task.seatDeadline).toBeNull();
    const events = await questions();
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ taskId: r.task.id, text: "what is this room for?" });
    expect(r.task.questionCursors).toEqual([events[0].cursor]);
    expect(await outsideTask(store, PUB, "u_out1", r.task.id)).toEqual(r.task);
  });

  it("same caller reuses one contextId per room", async () => {
    const a = await ask(caller(1));
    const b = await ask(caller(1));
    const c = await ask(caller(2));

    if (!a.ok || !b.ok || !c.ok) throw new Error("asks refused");
    expect(a.task.contextId).toBe(b.task.contextId);
    expect(c.task.contextId).not.toBe(a.task.contextId);
    expect((await outsideTasksOf(store, PUB, "u_out1")).map((t) => t.id)).toEqual([b.task.id, a.task.id]);
  });

  it("answers to a public name as to an id", async () => {
    await store.createSession(publicRoom({ id: "qs_named", publicName: "open-review" }));
    expect(await store.claimPublicName("open-review", { id: "qs_named", at: Date.now() }, null)).toBe(true);

    const r = await ask(caller(1), "hi", {}, "open-review");

    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect((await store.eventsAfter("qs_named", 0)).filter((e) => e.type === "outside_question")).toHaveLength(1);
  });

  it.each([
    ["a private room", () => session({ id: PUB })],
    ["an unpublished room", () => publicRoom({ unpublishedAt: Date.now() })],
    ["a closed room", () => publicRoom({ closed: true, closedAt: Date.now() })],
    ["a frozen room", () => publicRoom({ frozenAt: Date.now() })],
  ])("refuses %s as not_found", async (_name, make) => {
    store = new MemoryStore();
    await store.createSession(make());

    expect(await ask(caller(1))).toEqual({ ok: false, error: "not_found" });
    expect(await ask(caller(1), "hi", {}, "no_such_room")).toEqual({ ok: false, error: "not_found" });
    expect(await questions()).toEqual([]);
  });

  it("refuses a banned account", async () => {
    await evictMember(store, jesse, PUB, "m_peer", "room");

    expect(await ask({ userId: "u_peer", label: "peer" })).toEqual({ ok: false, error: "banned" });
    expect(await ask(caller(1))).toMatchObject({ ok: true });
  });

  it("refuses an account its host banned from every room", async () => {
    await evictMember(store, jesse, PUB, "m_peer", "all");
    await store.createSession(publicRoom({ id: "qs_other" }));

    expect(await ask({ userId: "u_peer", label: "peer" }, "hi", {}, "qs_other")).toEqual({ ok: false, error: "banned" });
  });

  it("refuses a suspended account", async () => {
    expect(await ask({ ...caller(1), suspended: true })).toEqual({ ok: false, error: "suspended" });
    expect(await questions()).toEqual([]);
  });

  it("seventh ask in a minute is rate_limited", async () => {
    const t = Date.now();
    for (let i = 0; i < 6; i++) await ask(caller(1), `q${i}`, {}, PUB, t + i);

    const r = await ask(caller(1), "q6", {}, PUB, t + 6);

    expect(r).toMatchObject({ ok: false, error: "rate_limited" });
    if (r.ok) return;
    expect(r.retryAfter).toBeGreaterThan(0);
    expect(await ask(caller(2), "someone else is not held", {}, PUB, t + 6)).toMatchObject({ ok: true });
  });

  it("fourth open task is too_many_open", async () => {
    for (let i = 0; i < 3; i++) expect(await ask(caller(1), `q${i}`)).toMatchObject({ ok: true });

    expect(await ask(caller(1), "q3")).toEqual({ ok: false, error: "too_many_open" });
    expect(await ask(caller(2), "another caller has their own three")).toMatchObject({ ok: true });
  });

  it("follow-up on a WORKING task is not_input_required", async () => {
    const first = await ask(caller(1));
    if (!first.ok) throw new Error("refused");

    expect(await ask(caller(1), "more", { taskId: first.task.id })).toEqual({ ok: false, error: "not_input_required" });
  });

  it("follow-up with someone else's taskId is task_not_found", async () => {
    const theirs = await ask(caller(2));
    if (!theirs.ok) throw new Error("refused");

    expect(await ask(caller(1), "mine now", { taskId: theirs.task.id })).toEqual({ ok: false, error: "task_not_found" });
    expect(await ask(caller(1), "nothing", { taskId: "no-such-task" })).toEqual({ ok: false, error: "task_not_found" });
  });

  it("a follow-up on an INPUT_REQUIRED task asks again on the same task and is not counted as a new one", async () => {
    const first = await ask(caller(1));
    if (!first.ok) throw new Error("refused");
    await ask(caller(1), "b");
    await ask(caller(1), "c");
    // Task 3 moves a task to INPUT_REQUIRED when a member asks for more; here the row is written as that would.
    await store.appendEvent(PUB, { type: "message", fromMemberId: "system", fromUserId: "system", fromLabel: "x", payload: {}, refId: null }, {
      outsideTask: { ...first.task, state: "TASK_STATE_INPUT_REQUIRED" },
    });

    const r = await ask(caller(1), "here is the detail", { taskId: first.task.id });

    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.task.id).toBe(first.task.id);
    expect(r.task.state).toBe("TASK_STATE_WORKING");
    const asked = await questions();
    // Its first question and the follow-up, and not the setup's own event (which is not a question) or the other tasks'.
    expect(r.task.questionCursors).toEqual([asked[0].cursor, asked[3].cursor]);
    expect((await questions()).map((e) => (e.payload as { text: string }).text)).toEqual(["what is this room for?", "b", "c", "here is the detail"]);
  });

  it("a foreign contextId is bad_context", async () => {
    const mine = await ask(caller(1));
    const theirs = await ask(caller(2));
    if (!mine.ok || !theirs.ok) throw new Error("refused");

    expect(await ask(caller(1), "x", { contextId: theirs.task.contextId })).toEqual({ ok: false, error: "bad_context" });
    expect(await ask(caller(3), "x", { contextId: mine.task.contextId })).toEqual({ ok: false, error: "bad_context" });
    expect(await ask(caller(1), "x", { contextId: mine.task.contextId })).toMatchObject({ ok: true });
  });

  it("origin is the handle, else visitor 1, visitor 2 by first-ask order", async () => {
    await store.claimHandle("u_out3", "ada");
    const one = await ask(caller(1));
    const handled = await ask(caller(3));
    const two = await ask(caller(2));
    const oneAgain = await ask(caller(1));

    expect([one, handled, two, oneAgain].map((r) => r.ok && r.task.origin)).toEqual(["visitor 1", "ada", "visitor 2", "visitor 1"]);
    expect((await questions()).map((e) => e.fromLabel)).toEqual(["visitor 1", "ada", "visitor 2", "visitor 1"]);
  });

  it("simultaneous asks from one account stop at the cap, share one context, and do not skip a visitor number", async () => {
    const same = await Promise.all([1, 2, 3, 4, 5].map((n) => ask(caller(1), `q${n}`)));
    const others = await Promise.all([2, 3].map((n) => ask(caller(n), "hi")));

    expect(same.filter((r) => r.ok)).toHaveLength(3);
    expect(same.filter((r) => !r.ok)).toEqual([{ ok: false, error: "too_many_open" }, { ok: false, error: "too_many_open" }]);
    expect(new Set(same.flatMap((r) => (r.ok ? [r.task.contextId] : []))).size).toBe(1);
    expect(same.flatMap((r) => (r.ok ? [r.task.origin] : []))).toEqual(["visitor 1", "visitor 1", "visitor 1"]);
    expect(others.map((r) => r.ok && r.task.origin).sort()).toEqual(["visitor 2", "visitor 3"]);
    expect(await questions()).toHaveLength(5);
  });

  it("two first-time callers asking at once get different visitor numbers", async () => {
    const [a, b] = await Promise.all([ask(caller(1)), ask(caller(2))]);

    expect([a, b].map((r) => r.ok && r.task.origin).sort()).toEqual(["visitor 1", "visitor 2"]);
  });

  it("two follow-ups at once on one task: one lands and the other finds it already working", async () => {
    const first = await ask(caller(1));
    if (!first.ok) throw new Error("refused");
    await store.appendEvent(PUB, { type: "message", fromMemberId: "system", fromUserId: "system", fromLabel: "x", payload: {}, refId: null }, {
      outsideTask: { ...first.task, state: "TASK_STATE_INPUT_REQUIRED" },
    });

    const both = await Promise.all([ask(caller(1), "one", { taskId: first.task.id }), ask(caller(1), "two", { taskId: first.task.id })]);

    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.find((r) => !r.ok)).toEqual({ ok: false, error: "not_input_required" });
    expect((await outsideTask(store, PUB, "u_out1", first.task.id))?.questionCursors).toHaveLength(2);
  });
});
