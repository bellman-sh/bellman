/**
 * Briefs in rows of their own (ADR 0018), against the storage that sets the limit: a value
 * holds 2 MB. A room's record now carries each member's small fields and no brief, so a full
 * room stays storable with every field at its maximum, and an old room's inline briefs move
 * out on its next seat.
 */
import { it, expect, afterEach } from "vitest";
import { env, reset, abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { DurableObjectStore, type SessionDO } from "../src/store-do.js";
import { ROOM_MEMBER_CEILING } from "../src/store.js";
import { brief, member, swarmSession } from "../tests/helpers/fixtures.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

const stubOf = (id: string) => env.SESSION.get(env.SESSION.idFromName(id));

/** Outside Latin-1, so the string is stored at two bytes a character: the most text can weigh. */
const wide = (n: number) => "\u{142}".repeat(n);
const maxBrief = (i: number) => brief({
  goal: wide(496) + String(i).padStart(4, "0"),
  state: wide(2000),
  constraints: Array.from({ length: 20 }, () => wide(300)),
  open_questions: Array.from({ length: 20 }, () => wide(300)),
  agent: { provider: wide(50), model: wide(80), client: wide(80) },
});
const maxMember = (i: number) => member({
  memberId: `m_${String(i).padStart(4, "0")}`,
  userId: `u_${"x".repeat(194)}${String(i).padStart(4, "0")}`,
  label: wide(254),
  roomRole: "peer_b",
  brief: maxBrief(i),
});

it("stores a full room with every member's fields and brief at their maximum", { timeout: 120_000 }, async () => {
  const store = new DurableObjectStore(env as never);
  const members = Array.from({ length: ROOM_MEMBER_CEILING - 1 }, (_, i) => maxMember(i));
  await store.createSession(swarmSession({ id: "qs_full", members }));

  // The last seat goes through the join path, which rewrites the record at its fullest.
  const last = await store.seatMember("qs_full", maxMember(ROOM_MEMBER_CEILING - 1), 0, Date.now());
  expect(last.refused).toBeNull();
  const read = (await store.getSession("qs_full"))!;
  expect(read.members.filter((m) => m.leftAt === null)).toHaveLength(ROOM_MEMBER_CEILING);
  const id = `m_${String(ROOM_MEMBER_CEILING - 1).padStart(4, "0")}`;
  expect((await store.getBriefs("qs_full", [id]))[id]).toEqual(maxBrief(ROOM_MEMBER_CEILING - 1));

  // Full is a refusal, never a write that breaks the room.
  expect((await store.seatMember("qs_full", maxMember(ROOM_MEMBER_CEILING), 0, Date.now())).refused).toBe("full");
});

// The control: the same members as one value with their briefs inside are past what storage holds.
it("could not store those members as one value with their briefs inline", { timeout: 60_000 }, async () => {
  await runInDurableObject(stubOf("qs_probe"), async (_i: SessionDO, ctx) => {
    const inline = Array.from({ length: ROOM_MEMBER_CEILING }, (_, i) => maxMember(i));
    await expect(ctx.storage.put("probe", { members: inline })).rejects.toThrow();
  });
});

it("reads an old room's inline briefs, and moves them into rows on its next seat", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(swarmSession({ id: "qs_old" }));
  await runInDurableObject(stubOf("qs_old"), async (_i: SessionDO, ctx) => {
    const row = (await ctx.storage.get<Record<string, unknown>>("session"))!;
    // As a room stored before ADR 0018: each brief inline on its member, and no `agent` beside it.
    const legacy = [0, 1].map((i) => {
      const { agent: _agent, ...m } = member({ memberId: `m_old${i}`, userId: `u_old${i}`, brief: brief({ goal: `old ${i}` }) });
      return m;
    });
    await ctx.storage.put("session", { ...row, members: legacy });
    await ctx.storage.delete("bf:m_creator");
  });

  expect(await store.getBriefs("qs_old", ["m_old0", "m_old1"]))
    .toEqual({ m_old0: brief({ goal: "old 0" }), m_old1: brief({ goal: "old 1" }) });
  expect((await store.getSession("qs_old"))!.members.map((m) => m.agent)).toEqual([brief().agent, brief().agent]);

  const seated = await store.seatMember("qs_old", member({ memberId: "m_new", userId: "u_new", brief: brief({ goal: "new" }) }), 0, Date.now());
  expect(seated.refused).toBeNull();
  await runInDurableObject(stubOf("qs_old"), async (_i: SessionDO, ctx) => {
    const row = (await ctx.storage.get<{ members: Record<string, unknown>[] }>("session"))!;
    for (const m of row.members) expect(m, String(m.memberId)).not.toHaveProperty("brief");
    expect(await ctx.storage.get("bf:m_old0")).toEqual(brief({ goal: "old 0" }));
  });
  expect(await store.getBriefs("qs_old", ["m_old0", "m_old1", "m_new"])).toEqual({
    m_old0: brief({ goal: "old 0" }), m_old1: brief({ goal: "old 1" }), m_new: brief({ goal: "new" }),
  });
});
