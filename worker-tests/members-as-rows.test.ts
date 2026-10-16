/**
 * Members as rows of their own (ADR 0019), against the storage that set the old limit: a value
 * holds 2 MB, and a room's record held every member who had ever sat in it. The record now names
 * the members in the room and each member is a row, so the record no longer grows with every join
 * and departure, and an older room's members move to rows when its object is next constructed (D5).
 */
import { it, expect, afterEach } from "vitest";
import { env, reset, abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { DurableObjectStore, type SessionDO } from "../src/store-do.js";
import { MEMBER_PREFIX } from "../src/member-rows.js";
import { ROOM_MEMBER_CEILING } from "../src/store.js";
import type { Member } from "../src/types.js";
import { brief, member, swarmSession } from "../tests/helpers/fixtures.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

const stubOf = (id: string) => env.SESSION.get(env.SESSION.idFromName(id));

/** A member as a record written before ADR 0019 held it: no place in the join order and no public number. */
const legacy = (over: Partial<Member>): Record<string, unknown> => {
  const { brief: _brief, seq: _seq, publicNumber: _number, ...m } = member(over);
  return m;
};

it("moves an older room's members into rows when its object is next constructed, numbered as they joined", async () => {
  const store = new DurableObjectStore(env as never);
  const t0 = Date.now();
  await store.createSession(swarmSession({ id: "qs_legacy" }));
  await runInDurableObject(stubOf("qs_legacy"), async (_i: SessionDO, ctx) => {
    const { present: _present, creator: _creator, orgs: _orgs, memberSeq: _seq, labelSeq: _labels, ...row } =
      (await ctx.storage.get<Record<string, unknown>>("session"))!;
    // As a room stored before ADR 0019: every member on the record, in the order they joined, among
    // them one person on two machines, a member who left and a member the creator removed.
    const members = [
      legacy({ memberId: "m_creator", joinedAt: t0 }),
      legacy({ memberId: "m_a1", userId: "u_a", label: "a@codenerd", orgId: "org_a", roomRole: "peer_b", joinedAt: t0 + 1, leftAt: t0 + 10 }),
      legacy({ memberId: "m_b", userId: "u_b", label: "b@other", orgId: "org_b", roomRole: "peer_b", joinedAt: t0 + 2, leftAt: t0 + 11, removedAtCursor: 3 }),
      legacy({ memberId: "m_a2", userId: "u_a", label: "a@codenerd", orgId: "org_a", roomRole: "peer_b", joinedAt: t0 + 3 }),
      legacy({ memberId: "m_c", userId: "u_c", label: "c@nowhere", orgId: null, roomRole: "peer_b", joinedAt: t0 + 4 }),
    ];
    await ctx.storage.deleteAll();
    await ctx.storage.put("session", { ...row, members });
  });
  // Moved when its object is next constructed, as every object is on a deploy; storage outlives the
  // instance until `reset()`.
  await abortAllDurableObjects();

  const read = (await store.getSession("qs_legacy"))!;
  expect(read.members.map((m) => [m.memberId, m.seq, m.publicNumber])).toEqual([["m_creator", 1, 1], ["m_a2", 4, 2], ["m_c", 5, 4]]);
  expect(read.creator).toEqual({ memberId: "m_creator", userId: "u_jesse", label: "jesse@codenerd", joinedAt: t0 });
  expect(read.orgs, "the orgs of the members who left among them").toEqual(["org_codenerd", "org_a", "org_b"]);
  expect(await store.getMember("qs_legacy", "m_a1")).toMatchObject({ leftAt: t0 + 10, seq: 2, publicNumber: 2 });
  expect(await store.getMember("qs_legacy", "m_b")).toMatchObject({ leftAt: t0 + 11, removedAtCursor: 3, seq: 3, publicNumber: 3 });
  expect((await store.membersOfUser("qs_legacy", "u_a")).map((m) => m.memberId)).toEqual(["m_a1", "m_a2"]);
  expect((await store.departedMembers("qs_legacy")).members.map((m) => m.memberId)).toEqual(["m_a1", "m_b"]);
  expect(await store.publicNumbers("qs_legacy", ["jesse@codenerd", "a@codenerd", "b@other", "c@nowhere"]))
    .toEqual({ "jesse@codenerd": 1, "a@codenerd": 2, "b@other": 3, "c@nowhere": 4 });

  await runInDurableObject(stubOf("qs_legacy"), async (_i: SessionDO, ctx) => {
    const record = (await ctx.storage.get<Record<string, unknown>>("session"))!;
    expect(record).not.toHaveProperty("members");
    expect(record).toMatchObject({ present: ["m_creator", "m_a2", "m_c"], memberSeq: 5, labelSeq: 4 });
    expect([...(await ctx.storage.list({ prefix: MEMBER_PREFIX })).keys()].sort())
      .toEqual(["mb:m_a1", "mb:m_a2", "mb:m_b", "mb:m_c", "mb:m_creator"]);
  });

  // The room numbers on from where the move left it: a new member after the last, a new label after
  // the last, and the person on a third machine under the number its label already had.
  const d = member({ memberId: "m_d", userId: "u_d", label: "d@nowhere", roomRole: "peer_b" });
  expect((await store.seatMember("qs_legacy", d, 0, Date.now())).refused).toBeNull();
  expect(await store.addMember("qs_legacy", member({ memberId: "m_a3", userId: "u_a", label: "a@codenerd", orgId: "org_a", roomRole: "peer_b" }))).toBe(true);
  expect(await store.getMember("qs_legacy", "m_d")).toMatchObject({ seq: 6, publicNumber: 5 });
  expect(await store.getMember("qs_legacy", "m_a3")).toMatchObject({ seq: 7, publicNumber: 2 });
});

// The old shape kept every member on the record, so a room's history walked it towards the 2 MB a
// value holds. Each member here joins and leaves under a label of its own, so every count the record
// keeps moves as well, and those counts are all that grow.
it("keeps the record the same size however many members have come and gone", { timeout: 120_000 }, async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(swarmSession({ id: "qs_churn" }));
  const stub = stubOf("qs_churn");
  const recordBytes = () => runInDurableObject(stub, async (_i: SessionDO, ctx) => JSON.stringify(await ctx.storage.get("session")).length);
  const comeAndGo = (from: number, to: number) => runInDurableObject(stub, async (instance: SessionDO) => {
    for (let i = from; i < to; i++) {
      const memberId = `m_${String(i).padStart(5, "0")}`;
      expect(await instance.addMember(member({ memberId, userId: `u_${i}`, label: `${i}@codenerd`, roomRole: "peer_b" }))).toBe(true);
      await instance.updateMember(memberId, { leftAt: Date.now() });
    }
  });

  await comeAndGo(0, 10);
  const afterTen = await recordBytes();
  await comeAndGo(10, 3_000);
  const afterThousands = await recordBytes();

  expect((await store.departedMembers("qs_churn")).members, "control: they came and went").toHaveLength(3_000);
  // `memberSeq` and `labelSeq`, each two digits longer.
  expect(afterThousands - afterTen).toBeLessThanOrEqual(4);
  expect(afterThousands).toBeLessThan(64 * 1024);
  expect((await store.getSession("qs_churn"))!.members.map((m) => m.memberId)).toEqual(["m_creator"]);
});

/** Outside Latin-1, so the string is stored at two bytes a character: the most text can weigh. */
const wide = (n: number) => "\u{142}".repeat(n);
/** A member with every field its row keeps at its maximum, the agent from a brief that is otherwise ordinary. */
const largest = (i: number) => {
  const agent = { provider: wide(50), model: wide(80), client: wide(80) };
  return member({
    memberId: `m_${String(i).padStart(4, "0")}`,
    userId: `u_${"x".repeat(194)}${String(i).padStart(4, "0")}`,
    label: wide(250) + String(i).padStart(4, "0"),
    roomRole: "peer_b",
    agent,
    brief: brief({ agent }),
  });
};

// The ceiling (D8): storage no longer bounds it, and every call still loads the members in the room.
// At their largest that is about 1.5 KB a member, 7.5 MB a read; as members are, about 300 bytes. The
// room is created in one call to its object, which seats its first members as `bellman_start` does,
// because the store's createSession then indexes each member in the registry one call at a time.
it("seats a full room of members at their largest, reads every one back in join order, and refuses one more", { timeout: 180_000 }, async () => {
  const store = new DurableObjectStore(env as never);
  await stubOf("qs_full").createSession(swarmSession({
    id: "qs_full", members: Array.from({ length: ROOM_MEMBER_CEILING - 1 }, (_, i) => largest(i)),
  }));

  // The last seat goes through the join path, which reads the whole roster in its transaction.
  expect((await store.seatMember("qs_full", largest(ROOM_MEMBER_CEILING - 1), 0, Date.now())).refused).toBeNull();
  const read = (await store.getSession("qs_full"))!;
  expect(read.members.map((m) => m.seq)).toEqual(Array.from({ length: ROOM_MEMBER_CEILING }, (_, i) => i + 1));
  expect(read.members.at(-1)).toMatchObject({ memberId: largest(ROOM_MEMBER_CEILING - 1).memberId, label: largest(ROOM_MEMBER_CEILING - 1).label });

  // Full is a refusal, never a write that breaks the room.
  expect((await store.seatMember("qs_full", largest(ROOM_MEMBER_CEILING), 0, Date.now())).refused).toBe("full");
});
