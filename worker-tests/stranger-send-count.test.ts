/**
 * A stranger's send count is stored and a member's is not (abuse protections spec D5, amended).
 *
 * The contract suite pins that a stranger's count outlives the room object's memory, for both stores. This file
 * pins what only the Durable Objects store has: what it writes, and what it leaves in memory. A stranger's times
 * are a row of the room object's storage that holds only the sends still inside the minute. A member's are not a
 * row at all, so a room object that loses its memory forgets them, which also proves the abort below drops the
 * memory the stranger's count survives.
 */
import { afterEach, describe, expect, it } from "vitest";
import { abortAllDurableObjects, env, reset, runInDurableObject } from "cloudflare:test";
import { sendKeyFor } from "../src/send-limit.js";
import { DurableObjectStore, type SessionDO } from "../src/store-do.js";
import { session } from "../tests/helpers/fixtures.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

const ROOM = "qs_counts";
const stranger = sendKeyFor({ via: "permanent", userId: "u_peer", memberId: "m_peer" });

/** Every row of the room object's storage whose key names `needle`, with its value. The key layout is the object's, so this asks for rows and not for a prefix. */
const rowsNaming = (needle: string) =>
  runInDurableObject(env.SESSION.get(env.SESSION.idFromName(ROOM)), async (_i: SessionDO, ctx) =>
    [...(await ctx.storage.list()).entries()].filter(([key]) => key.includes(needle)));

async function roomStore(): Promise<DurableObjectStore> {
  const store = new DurableObjectStore(env as never);
  await store.createSession(session({ id: ROOM }));
  return store;
}

describe("the send count in a room object's storage (spec D5, amended)", () => {
  it("stores a stranger's sends in one row, and drops the times past the minute as it writes", async () => {
    const store = await roomStore();
    for (const at of [1_000, 20_000, 40_000]) expect(await store.admitSend(ROOM, stranger, 6, at)).toEqual({ ok: true });
    expect(await rowsNaming(stranger)).toEqual([[expect.any(String), [1_000, 20_000, 40_000]]]);
    expect(await store.admitSend(ROOM, stranger, 6, 61_500)).toEqual({ ok: true });
    expect(await rowsNaming(stranger), "the first send left the window and is gone from the row")
      .toEqual([[expect.any(String), [20_000, 40_000, 61_500]]]);
  });

  it("never holds more times than the limit: sends past it are refused and add nothing", async () => {
    const store = await roomStore();
    const answers: boolean[] = [];
    for (let i = 0; i < 10; i++) answers.push((await store.admitSend(ROOM, stranger, 6, 1_000 + i)).ok);
    expect(answers).toEqual([true, true, true, true, true, true, false, false, false, false]);
    expect(await rowsNaming(stranger)).toEqual([[expect.any(String), [1_000, 1_001, 1_002, 1_003, 1_004, 1_005]]]);
  });

  it("counts sends that land together one after the other, so a burst cannot pass the limit", async () => {
    const store = await roomStore();
    const answers = await Promise.all(Array.from({ length: 12 }, () => store.admitSend(ROOM, stranger, 6, 1_000)));
    expect(answers.filter((a) => a.ok)).toHaveLength(6);
    expect(await rowsNaming(stranger)).toEqual([[expect.any(String), [1_000, 1_000, 1_000, 1_000, 1_000, 1_000]]]);
  });

  it("keeps a member's sends in memory only: no row, and an object that loses its memory forgets them", async () => {
    const store = await roomStore();
    for (let i = 0; i < 3; i++) expect(await store.admitSend(ROOM, "m_unseated", 3, 1_000 + i)).toEqual({ ok: true });
    expect(await store.admitSend(ROOM, "m_unseated", 3, 2_000), "the premise: the count is full").toMatchObject({ ok: false });
    expect(await rowsNaming("m_unseated")).toEqual([]);
    await abortAllDurableObjects();
    expect(await store.admitSend(ROOM, "m_unseated", 3, 2_000), "the control: the memory is gone").toEqual({ ok: true });
  });
});
