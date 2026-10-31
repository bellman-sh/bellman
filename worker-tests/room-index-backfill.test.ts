/**
 * The operator's room index (#471) starts at its deploy, so `backfillRoomIndex` writes a row for every room the
 * account indexes (`us:`, `um:`, `uo:`) can still name. Rooms from before the deploy are made here by creating them
 * and then deleting their `rm:` and `ri:` rows, which is the registry they will find in production.
 */
import { afterEach, describe, expect, it } from "vitest";
import { env, reset, abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { DurableObjectStore, type RegistryDO } from "../src/store-do.js";
import { member, session } from "../tests/helpers/fixtures.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

const registry = () => env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
const forgetRoomIndex = () =>
  runInDurableObject(registry(), async (_i: RegistryDO, ctx) => {
    for (const prefix of ["rm:", "ri:"]) await ctx.storage.delete([...(await ctx.storage.list({ prefix })).keys()]);
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
});
