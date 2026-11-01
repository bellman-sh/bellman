/**
 * The Worker mounts the operator's rooms (#472) over the real objects: the registry's room index, each room's
 * `roomSummary`, and the audit streams, the operator's `~operator` AuditDO among them. The route's rules are pinned
 * in tests/operator-rooms.test.ts over a MemoryStore; this is the wiring, and the part a MemoryStore cannot show.
 */
import { afterEach, describe, expect, it } from "vitest";
import { env, reset, abortAllDurableObjects } from "cloudflare:test";
import worker from "../src/worker.js";
import { DurableObjectStore } from "../src/store-do.js";
import { member, session } from "../tests/helpers/fixtures.js";

const ORIGIN = "https://mcp.example.test";
// The key map's identity (vitest.config.ts) is u_jesse, the id BELLMAN_OPERATORS names below.
const KEY = "qk_ws_test";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
type WorkerEnv = Parameters<typeof worker.fetch>[1];
const envWith = (over: Record<string, string | undefined>) =>
  ({ ...env, BELLMAN_TOKEN_SECRET: "test-signing-secret", ...over }) as unknown as WorkerEnv;
const get = (on: WorkerEnv, path: string, init: RequestInit = { headers: { authorization: `Bearer ${KEY}` } }) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, init), on, ctx);

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

describe("the operator's rooms through the Worker", () => {
  it("lists and reads a room from its object, and audits both reads to the operator's stream and the room's orgs", async () => {
    const store = new DurableObjectStore(env as never);
    const s = session({
      id: "qs_wired",
      members: [member(), member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b", orgId: "org_other" })],
    });
    await store.createSession(s);
    await store.appendEvent(s.id, { type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: { text: "hi" }, refId: null });
    const operator = envWith({ BELLMAN_OPERATORS: "u_jesse" });

    const list = await get(operator, "/operator/rooms");
    expect(list.status, await list.clone().text()).toBe(200);
    expect(await list.json()).toMatchObject({
      rooms: [{ id: s.id, status: "open", seats: { active: 2, capacity: 2 }, events: 1, org_id: "org_codenerd" }],
      next: null,
    });

    const detail = await get(operator, `/operator/rooms/${s.id}`);
    expect(detail.status, await detail.clone().text()).toBe(200);
    expect(await detail.json()).toMatchObject({ id: s.id, events: 1, roles: Object.keys(s.manifest.roles) });

    expect((await store.operatorAudit(10)).map((e) => [e.action, e.actorUserId, e.detail])).toEqual([
      ["operator_rooms_listed", "u_jesse", { room_ids: [s.id], filters: {} }],
      ["operator_room_read", "u_jesse", { room_id: s.id }],
    ]);
    // AuditDO keeps an entry's label, room and parties only beside a `crossing`, so the route has to give one.
    expect((await store.operatorAudit(1))[0]).toMatchObject({
      actorLabel: "jesse@codenerd", actorOrgId: "org_codenerd", roomName: "test-room",
      parties: ["org_codenerd", "org_other"], crossing: "cross_org", direction: "outbound",
    });
    for (const org of ["org_codenerd", "org_other"]) {
      expect((await store.auditForOrg(org, 10)).filter((e) => e.action === "operator_room_read"), org).toHaveLength(1);
    }
  });

  it("refuses everyone BELLMAN_OPERATORS does not name, and a caller with no credential", async () => {
    for (const path of ["/operator/rooms", "/operator/rooms/qs_any"]) {
      expect((await get(envWith({ BELLMAN_OPERATORS: "u_someone_else" }), path)).status, path).toBe(403);
      expect((await get(envWith({}), path)).status, path).toBe(403);
      expect((await get(envWith({ BELLMAN_OPERATORS: "u_jesse" }), path, {})).status, path).toBe(401);
    }
  });
});
