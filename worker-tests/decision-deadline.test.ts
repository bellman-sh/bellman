/**
 * Change 1 of the secret ballot spec in the real SessionDO: the room's one alarm closes every overdue decision at
 * its deadline, in a frozen room and a closed one too, instead of waiting for another decision to open.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { env, reset, runInDurableObject } from "cloudflare:test";
import { MIN_DECISION_TTL_MS, type DecisionDraft } from "../src/decision.js";
import { DurableObjectStore } from "../src/workerd/store-do.js";
import type { SessionDO } from "../src/workerd/session-do.js";
import type { EventBody, SessionEvent } from "../src/types.js";
import { roomManifest, session } from "../tests/helpers/fixtures.js";
import { editRoom } from "../tests/helpers/rows.js";

afterEach(async () => {
  await reset();
});

/**
 * A room whose creator may vote, under its own id: the fixture's default id would share one Durable Object with
 * every other file that uses it, in the same run. No join codes, so no outbox row arms the alarm before a decision
 * does.
 */
let rooms = 0;
async function room() {
  const store = new DurableObjectStore(env as never);
  const pair = roomManifest();
  const manifest = roomManifest({ roles: { ...pair.roles, peer_a: { ...pair.roles.peer_a, can: [...pair.roles.peer_a.can, "vote"] } } });
  const s = session({ id: `qs_deadline_${++rooms}`, manifest, joinCodes: {} });
  await store.createSession(s);
  return { id: s.id, store, stub: env.SESSION.get(env.SESSION.idFromName(s.id)) };
}

const draft = (key: string, expires_ms?: number): DecisionDraft => ({
  key, effect: { kind: "surface_proposal", item: { key, kind: "text", body: "x" }, base: 0 }, rule: "unanimous",
  ...(expires_ms === undefined ? {} : { expires_ms }),
});
const opening = (key: string, expires_ms?: number): EventBody =>
  ({ type: "decision_opened", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: draft(key, expires_ms), refId: null });

type Stub = ReturnType<typeof env.SESSION.get>;
type Book = Record<string, { expires_at: number; by: string }>;

async function opened(store: DurableObjectStore, id: string, key: string, expires_ms?: number) {
  const out = await store.openDecision(id, opening(key, expires_ms), null);
  if (out.outcome !== "appended") throw new Error(out.outcome);
  return { cursor: out.event.cursor, deadline: (out.event.payload as { expires_at: number }).expires_at };
}

/** Moves a decision's deadline to `at` in both places it is kept: the record's book and its opening event. */
const backdate = (stub: Stub, cursor: number, at: number) =>
  runInDurableObject(stub, async (_i: SessionDO, ctx) => {
    await editRoom(ctx.storage, {
      record: (r) => {
        const book = r.openDecisions as Book;
        return { ...r, openDecisions: { ...book, [cursor]: { ...book[String(cursor)], expires_at: at } } };
      },
    });
    for (const [key, e] of await ctx.storage.list<SessionEvent>({ prefix: "e:" })) {
      if (e.cursor === cursor) await ctx.storage.put(key, { ...e, payload: { ...(e.payload as object), expires_at: at } });
    }
  });

const fire = (stub: Stub) => runInDurableObject(stub, (instance: SessionDO) => instance.alarm());

const raw = (stub: Stub) => runInDurableObject(stub, async (_i: SessionDO, ctx) => ({
  alarm: await ctx.storage.getAlarm(),
  book: ((await ctx.storage.get<{ openDecisions?: Book }>("session"))?.openDecisions ?? {}) as Book,
  last: [...(await ctx.storage.list<SessionEvent>({ prefix: "e:" })).values()].at(-1),
}));

describe("the decision deadline alarm (secret ballot spec, Change 1)", () => {
  it("arms the alarm one millisecond after the earliest open deadline", async () => {
    const { id, store, stub } = await room();
    const { deadline } = await opened(store, id, "a", MIN_DECISION_TTL_MS);
    expect((await raw(stub)).alarm).toBe(deadline + 1);
  });

  it("re-arms earlier when a decision opens with an earlier deadline", async () => {
    const { id, store, stub } = await room();
    await opened(store, id, "late");
    const { deadline } = await opened(store, id, "soon", MIN_DECISION_TTL_MS);
    expect((await raw(stub)).alarm).toBe(deadline + 1);
  });

  it("firing closes an overdue decision expired and arms nothing for it after", async () => {
    const { id, store, stub } = await room();
    const { cursor } = await opened(store, id, "a");
    const at = Date.now() - 1;
    await backdate(stub, cursor, at);
    await fire(stub);
    const after = await raw(stub);
    expect(after.last).toMatchObject({ type: "decision_closed", fromMemberId: "system", payload: { decision: cursor, state: "expired" } });
    expect(after.book).toEqual({});
    expect(after.alarm).not.toBe(at + 1);
  });

  it("closes an overdue decision in a frozen room", async () => {
    const { id, store, stub } = await room();
    const { cursor } = await opened(store, id, "a");
    await runInDurableObject(stub, (_i: SessionDO, ctx) => editRoom(ctx.storage, { record: (r) => ({ ...r, frozenAt: Date.now() }) }));
    await backdate(stub, cursor, Date.now() - 1);
    await fire(stub);
    expect((await raw(stub)).last).toMatchObject({ type: "decision_closed", payload: { decision: cursor, state: "expired" } });
  });

  it("closes an overdue decision in a closed room", async () => {
    const { id, store, stub } = await room();
    const { cursor } = await opened(store, id, "a");
    await runInDurableObject(stub, (_i: SessionDO, ctx) => editRoom(ctx.storage, { record: (r) => ({ ...r, closed: true }) }));
    await backdate(stub, cursor, Date.now() - 1);
    await fire(stub);
    const events = await runInDurableObject(stub, async (_i: SessionDO, ctx) =>
      [...(await ctx.storage.list<SessionEvent>({ prefix: "e:" })).values()]);
    expect(events.find((e) => e.type === "decision_closed")).toMatchObject({ payload: { decision: cursor, state: "expired" } });
  });

  it("drops a booked decision the log does not hold, so the alarm does not fire again at once", async () => {
    const { stub } = await room();
    const at = Date.now() - 1;
    await runInDurableObject(stub, (_i: SessionDO, ctx) =>
      editRoom(ctx.storage, { record: (r) => ({ ...r, openDecisions: { "999": { expires_at: at, by: "m_creator" } } }) }));
    await fire(stub);
    const after = await raw(stub);
    expect(after.book).toEqual({});
    expect(after.alarm).not.toBe(at + 1);
  });

  it("rebooks a decision whose booked deadline disagrees with its opening event, and leaves it open", async () => {
    const { id, store, stub } = await room();
    const { cursor, deadline } = await opened(store, id, "a");
    await runInDurableObject(stub, (_i: SessionDO, ctx) => editRoom(ctx.storage, {
      record: (r) => ({ ...r, openDecisions: { [cursor]: { ...(r.openDecisions as Book)[String(cursor)], expires_at: Date.now() - 1 } } }),
    }));
    await fire(stub);
    const after = await raw(stub);
    expect(after.book[String(cursor)]?.expires_at).toBe(deadline);
    expect(after.last).toMatchObject({ type: "decision_opened", cursor });
    expect(after.alarm).toBe(deadline + 1);
  });

  it("writes the closing audit row as the system", async () => {
    const { id, store, stub } = await room();
    const { cursor } = await opened(store, id, "a");
    await backdate(stub, cursor, Date.now() - 1);
    await fire(stub);
    await vi.waitFor(async () => {
      const rows = (await store.auditForOrg("org_codenerd", 50)).filter((a) => a.action === "decision_closed");
      expect(rows).toEqual([expect.objectContaining({ actorUserId: "system", direction: null, detail: expect.objectContaining({ decision: cursor }) })]);
    }, { timeout: 3_000 });
  });
});
