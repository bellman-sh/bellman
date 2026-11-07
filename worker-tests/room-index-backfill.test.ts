/**
 * The operator's room index (#471) starts at its deploy, so `backfillRoomIndex` writes a row for every room the
 * account indexes (`us:`, `um:`, `uo:`) can still name. Rooms from before the deploy are made here by creating them
 * and then deleting their `rooms` rows, which is the registry they will find in production. The move of the index's
 * old KV rows into that table on wake is pinned below.
 */
import { afterEach, describe, expect, it } from "vitest";
import { env, reset, abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { DurableObjectStore } from "../src/store-do.js";
import type { RegistryDO } from "../src/registry-do.js";
import { roomIndexKey, type RoomIndexRow } from "../src/store.js";
import { member, session } from "../tests/helpers/fixtures.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

const registry = () => env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
const forgetRoomIndex = () =>
  runInDurableObject(registry(), (_i: RegistryDO, ctx) => { ctx.storage.sql.exec("DELETE FROM rooms"); });
const sqlRows = () =>
  runInDurableObject(registry(), (_i: RegistryDO, ctx) => ctx.storage.sql.exec("SELECT * FROM rooms ORDER BY session_id").toArray());
const kvKeys = (prefix: string) =>
  runInDurableObject(registry(), async (_i: RegistryDO, ctx) => [...(await ctx.storage.list({ prefix })).keys()]);
/** The room index as the code before the `rooms` table wrote it: `rm:<roomIndexKey>` the row, `ri:<id>` its key. */
const legacyRow = (r: RoomIndexRow) => {
  const key = `rm:${roomIndexKey(r)}`;
  return { [key]: r, [`ri:${r.sessionId}`]: key };
};
const row = (sessionId: string, createdAt: number, over: Partial<RoomIndexRow> = {}): RoomIndexRow => ({
  sessionId, createdAt, createdBy: "u_a", orgId: "org_x", preset: null, mode: "swarm", public: false, hosted: false, ...over,
});
const putRow = (key: string, value: unknown) =>
  runInDurableObject(registry(), async (_i: RegistryDO, ctx) => ctx.storage.put(key, value));

async function backfillAll(store: DurableObjectStore, limit: number): Promise<number> {
  let indexed = 0;
  let after: string | undefined;
  for (;;) {
    const page = await store.backfillRoomIndex(limit, after);
    indexed += page.indexed;
    if (page.next === null) return indexed;
    after = page.next;
  }
}

describe("backfillRoomIndex (#471)", () => {
  it("indexes every room an account index names, once, and skips a row naming no room", async () => {
    const store = new DurableObjectStore(env as never);
    await store.createSession(session({ id: "qs_open", createdBy: "u_a", members: [member({ userId: "u_a" })] }));
    // Closed, and its creator's `us:` row swept by a listing: only `um:` and `uo:` still name it.
    await store.createSession(session({ id: "qs_shut", createdBy: "u_b", members: [member({ userId: "u_b" })] }));
    await store.closeSession("qs_shut");
    expect(await store.sessionsCreatedBy("u_b", 10)).toEqual([]);
    // No org, so no `uo:` row: `us:` and `um:` name it.
    await store.createSession(session({ id: "qs_joined", createdBy: "u_c", orgId: null, members: [member({ userId: "u_c", orgId: null })] }));
    const want = await store.listRoomsPage(10);
    expect(want.map((r) => r.sessionId).sort()).toEqual(["qs_joined", "qs_open", "qs_shut"]);

    await forgetRoomIndex();
    await putRow("us:u_a:qs_never", Date.now()); // a room that is gone: an index row naming no record
    expect(await store.listRoomsPage(10)).toEqual([]);

    expect(await backfillAll(store, 2)).toBe(3);
    expect(await store.listRoomsPage(10)).toEqual(want);
    expect(await backfillAll(store, 2), "a second run finds nothing to write").toBe(0);
    expect(await store.listRoomsPage(10)).toEqual(want);
  });

  it("writes the `us:` row and the `rooms` row together at a create", async () => {
    const store = new DurableObjectStore(env as never);
    await store.createSession(session({ id: "qs_new", createdBy: "u_a", members: [member({ userId: "u_a" })] }));
    expect(await kvKeys("us:u_a:")).toEqual(["us:u_a:qs_new"]);
    expect((await sqlRows()).map((r) => r.session_id)).toEqual(["qs_new"]);
  });

  it("keeps a room's first row: a second `indexRoom` with other fields changes nothing, and counts it once", async () => {
    const store = new DurableObjectStore(env as never);
    await store.createSession(session({ id: "qs_once", members: [member()] }));
    const [first] = await store.listRoomsPage(10);
    await runInDurableObject(registry(), (instance: RegistryDO) => instance.indexRoom({ ...first, createdAt: 1, public: true }));
    await runInDurableObject(registry(), (instance: RegistryDO) => instance.indexRoom({ ...first, createdAt: 1, public: true }));
    expect(await store.listRoomsPage(10)).toEqual([first]);
    expect((await store.roomCounts("owner", 10)).total).toBe(1);
  });
});

describe("the room index's move into the `rooms` table (dash#94)", () => {
  /** Old-shape rows in the registry's storage, and the object dropped so the next call wakes it anew. */
  async function seedLegacy(rows: RoomIndexRow[]) {
    await runInDurableObject(registry(), async (_i: RegistryDO, ctx) => {
      await ctx.storage.put<unknown>(Object.assign({}, ...rows.map(legacyRow)));
    });
    await abortAllDurableObjects();
  }

  it("moves every `rm:` row into the table on wake, leaves no `rm:` or `ri:` key, and a second wake changes nothing", async () => {
    const rows = [
      row("qs_1", 1_000), row("qs_2", 2_000, { orgId: null, public: true }),
      row("qs_3", 3_000, { createdBy: "u_b", hosted: true, preset: "pair", mode: "pair" }),
    ];
    await seedLegacy(rows);
    const store = new DurableObjectStore(env as never);
    expect(await store.listRoomsPage(10)).toEqual([...rows].reverse());
    expect((await store.roomCounts("org", 10)).groups).toEqual([
      { key: "org_x", label: null, rooms: 2 }, { key: "~none", label: null, rooms: 1 },
    ]);
    expect([...(await kvKeys("rm:")), ...(await kvKeys("ri:"))]).toEqual([]);

    const before = await sqlRows();
    await abortAllDurableObjects();
    expect(await sqlRows()).toEqual(before);
  });

  it("leaves a room already in the table as it is when an older Worker's `rm:` row for it moves", async () => {
    const store = new DurableObjectStore(env as never);
    await store.createSession(session({ id: "qs_kept", members: [member()] }));
    const [kept] = await store.listRoomsPage(10);
    await seedLegacy([{ ...kept, createdBy: "u_other", public: true }, row("qs_rolled_back", 5)]);
    expect((await store.listRoomsPage(10)).map((r) => r.sessionId)).toEqual(["qs_kept", "qs_rolled_back"]);
    expect((await store.listRoomsPage(10))[0]).toEqual(kept);
  });

  it("backfills after the move the rooms only the account indexes name", async () => {
    const store = new DurableObjectStore(env as never);
    await store.createSession(session({ id: "qs_named", createdBy: "u_a", members: [member({ userId: "u_a" })] }));
    await forgetRoomIndex();
    await seedLegacy([row("qs_moved", 5)]);
    expect(await backfillAll(store, 10)).toBe(1);
    expect((await store.listRoomsPage(10)).map((r) => r.sessionId).sort()).toEqual(["qs_moved", "qs_named"]);
  });
});
