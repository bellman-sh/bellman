/**
 * A surface row stored before `createdAt` existed (room pages spec, D4), against the storage that holds
 * it. Nothing rewrites such a row (R1), so a read answers its `at` for both dates, and the first edit
 * carries that `at` over as when the key was written (R2). The store's interface cannot write a row
 * without the field, so the case takes it off a row the store wrote, as members-as-rows.test.ts takes
 * the fields off an older record.
 */
import { it, expect, vi, afterEach } from "vitest";
import { env, reset, abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { readSurface } from "../src/rooms.js";
import { DurableObjectStore, type SessionDO } from "../src/store-do.js";
import type { SurfaceItem, SurfaceRow } from "../src/types.js";
import { session } from "../tests/helpers/fixtures.js";

afterEach(async () => {
  vi.useRealTimers();
  await reset();
  await abortAllDurableObjects();
});

const ROOM = "qs_row_before_created_at";

const plan = (body: string): SurfaceItem => ({
  key: "plan", kind: "text", title: "Plan", body, ends: null, placement: null, blob: null, shape: null,
});
const write = (store: DurableObjectStore, item: SurfaceItem) =>
  store.appendEvent(
    ROOM,
    { type: "surface", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: item, refId: null },
    { surface: { key: item.key, item } },
  );
/** The item as a client reads it: through `readSurface`, the path every read of the surface takes. */
const read = async (store: DurableObjectStore) =>
  (await readSurface(store, (await store.getSession(ROOM))!)).items[0].data;

it("reads a row stored before createdAt as written at its at, and an edit keeps that as when it was written", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(session({ id: ROOM }));
  // `Date` is the only clock moved, as in purge.test.ts: the room stamps a row with the one it reads, and no
  // timer is faked, so no RPC waits on one.
  const now = Date.now();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now + 60_000);
  const first = (await write(store, plan("first")))!;
  // As a row stored before the field: the store wrote this one, and the field comes off it.
  await runInDurableObject(env.SESSION.get(env.SESSION.idFromName(ROOM)), async (_i: SessionDO, ctx) => {
    const { createdAt: _createdAt, ...old } = (await ctx.storage.get<SurfaceRow>("sf:plan"))!;
    await ctx.storage.put("sf:plan", old);
  });
  expect(Object.keys((await store.surfaceOf(ROOM))[0]), "control: the row holds no createdAt").not.toContain("createdAt");

  const written = new Date(first.at).toISOString();
  expect(await read(store)).toMatchObject({ body: "first", created_at: written, changed_at: written, at: written });

  vi.setSystemTime(now + 120_000);
  const edit = (await write(store, plan("revised")))!;
  expect(edit.at).toBeGreaterThan(first.at);
  const edited = new Date(edit.at).toISOString();
  expect(await read(store)).toMatchObject({ body: "revised", created_at: written, changed_at: edited, at: edited });
});

// Surface frames R10: a locked move writes one event and one row per carried card, all in the frame's transaction.
it("moves a locked frame holding 900 cards in one append: 900 carried events, every card moved", async () => {
  const id = "qs_frame_of_900";
  const store = new DurableObjectStore(env as never);
  await store.createSession(session({ id }));
  const by = { type: "surface", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", refId: null } as const;
  const frame = (x: number): SurfaceItem => ({
    key: "f", kind: "frame", title: "Board", body: null, ends: null, placement: { x, y: 0, w: 3000, h: 3000 }, blob: null, shape: null, locked: true,
  });
  expect((await store.appendSurface(id, { ...by, payload: frame(0) }, { surface: { key: "f", item: frame(0) } }, null)).outcome).toBe("appended");
  for (let i = 0; i < 900; i++) {
    const card: SurfaceItem = {
      key: `c${String(i).padStart(3, "0")}`, kind: "text", title: null, body: "x", ends: null,
      placement: { x: (i % 30) * 90, y: Math.floor(i / 30) * 90 }, blob: null, shape: null,
    };
    await store.appendEvent(id, { ...by, payload: card }, { surface: { key: card.key, item: card } });
  }
  const before = new Map((await store.surfaceOf(id)).map((r) => [r.key, r.placement!]));
  // A long poll waiting from before the move: one wake after the transaction hands it every event the move wrote.
  const from = (await store.recentEvents(id, 1))[0].cursor;
  const poll = store.waitForEvents(id, from, 30_000);
  await new Promise((r) => setTimeout(r, 50));

  const out = await store.appendSurface(id, { ...by, payload: frame(5000) }, { surface: { key: "f", item: frame(5000) } }, null);

  if (out.outcome !== "appended") throw new Error(`the move said ${out.outcome}`);
  expect((await poll).map((e) => e.cursor), "the poll's one wake").toEqual(Array.from({ length: 901 }, (_, i) => from + 1 + i));
  expect(out.carried).toHaveLength(900);
  expect(out.carried.map((e) => e.cursor - out.event.cursor)).toEqual(Array.from({ length: 900 }, (_, i) => i + 1));
  expect(await store.eventsAfter(id, out.event.cursor - 1)).toHaveLength(901);
  const after = await store.surfaceOf(id);
  expect(after).toHaveLength(901);
  for (const r of after) {
    const was = before.get(r.key)!;
    expect(r.placement, r.key).toEqual({ ...was, x: was.x + 5000 });
  }
  // Seeding 900 rows took past the 15 s default under load on 2026-10-23 and passed alone; the move is not what is slow.
}, 60_000);
