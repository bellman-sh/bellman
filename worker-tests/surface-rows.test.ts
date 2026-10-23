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
