/**
 * The Worker's dispatch for the room routes (#184): `/rooms` with no trailing
 * slash must reach src/http/rooms.ts, which the blob routes' prefix test did
 * not admit. One request through the real fetch handler proves the condition.
 *
 * Reached the way blobs-route.test.ts reaches the Worker: `worker.fetch` with the
 * pool's `env`, and the key vitest.config.ts binds (`qk_ws_test`, u_jesse). The
 * isolate is fresh, so that identity has made no room and the list is empty.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { env, reset, abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { DurableObjectStore, type RegistryDO } from "../src/store-do.js";
import worker from "../src/worker.js";
import { member, session } from "../tests/helpers/fixtures.js";

const ORIGIN = "https://mcp.example.test";
const KEY = "qk_ws_test";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const workerEnv = env as unknown as Parameters<typeof worker.fetch>[1];
const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), workerEnv, ctx);

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

describe("GET /rooms through the Worker", () => {
  it("reaches the room routes module with no trailing slash", async () => {
    const res = await call("/rooms", { headers: { authorization: `Bearer ${KEY}` } });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ rooms: [], truncated: false, viewer: "member" });
  });
});

/**
 * The admin's reads and the delete (#65) over the real objects: the org index in the registry, the
 * schedule on the room, and the purge on its alarm, reached through the Worker's own dispatch. KEY is
 * u_jesse, the team plan's admin for org_codenerd, and the room is one u_peer created and sat in, so the
 * admin holds no seat in it.
 */
describe("an org admin's reads and delete on demand, through the Worker (#65)", () => {
  const ROOM = "qs_worker_org";
  const bearer = { authorization: `Bearer ${KEY}` };
  const peerSeat = () => member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b" });

  async function closedOrgRoom() {
    const store = new DurableObjectStore(env as never);
    await store.createSession(session({
      id: ROOM, createdBy: "u_peer", closed: true, closedAt: Date.now(), joinCodes: {}, members: [peerSeat()],
    }));
    return store;
  }
  const orgRows = () =>
    runInDurableObject(env.REGISTRY.get(env.REGISTRY.idFromName("registry")), async (_i: RegistryDO, state) =>
      [...(await state.storage.list({ prefix: "uo:" })).keys()]);

  it("lists the room for the org's admin through the registry's index, and reads it with no seat", async () => {
    await closedOrgRoom();

    const list = await call("/rooms?as=admin", { headers: bearer });
    expect(list.status, await list.clone().text()).toBe(200);
    expect(await list.json()).toMatchObject({ viewer: "admin", truncated: false, rooms: [{ id: ROOM, status: "closed" }] });

    const detail = await call(`/rooms/${ROOM}`, { headers: bearer });
    expect(detail.status, await detail.clone().text()).toBe(200);
    expect(await detail.json()).toMatchObject({ viewer: "admin", my_handles: [], preview: { your_role: null } });
  });

  it("deletes it on the admin's word: 202, then the purge, and then it is gone from the read, the list and the org index", async () => {
    await closedOrgRoom();
    expect(await orgRows(), "indexed for the org before").toEqual([`uo:org_codenerd:${ROOM}`]);

    const res = await call(`/rooms/${ROOM}`, { method: "DELETE", headers: bearer });
    expect(res.status, await res.clone().text()).toBe(202);

    // The room's own alarm does the work, so the read is polled until it has.
    await vi.waitFor(async () => expect((await call(`/rooms/${ROOM}`, { headers: bearer })).status).toBe(404), { timeout: 5_000 });
    const list = await call("/rooms?as=admin", { headers: bearer });
    expect(await list.json()).toMatchObject({ rooms: [] });
    expect(await orgRows()).toEqual([]);
    expect((await new DurableObjectStore(env as never).auditForOrg("org_codenerd", 20)).map((a) => a.action))
      .toEqual(["room_deleted", "room_purged"]);
  });

  it("answers an admin of another org 404 for the read and the delete, and the room stays", async () => {
    await closedOrgRoom();
    const store = new DurableObjectStore(env as never);
    // KEY is u_jesse for org_codenerd; the stranger here is the same key against a room of no org of its own.
    await store.createSession(session({
      id: "qs_worker_other", createdBy: "u_other", closed: true, closedAt: Date.now(), joinCodes: {},
      members: [member({ memberId: "m_other", userId: "u_other", label: "other@elsewhere", orgId: "org_elsewhere" })],
    }));
    expect((await call("/rooms/qs_worker_other", { headers: bearer })).status).toBe(404);
    expect((await call("/rooms/qs_worker_other", { method: "DELETE", headers: bearer })).status).toBe(404);
    expect(await store.getSession("qs_worker_other")).toMatchObject({ closed: true });
  });
});
