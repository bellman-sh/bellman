/**
 * The operator's room list and detail (#472), driven as both servers drive the route modules: a Request in, a
 * Response out, over a MemoryStore. The gate is `/operator/stats`'s, pinned in tests/stats.test.ts; the rows here.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resolveIdentity } from "../src/auth.js";
import type { RoomCaller } from "../src/http/rooms.js";
import { statsRoutes, type StatsRouteDeps } from "../src/http/stats.js";
import { NotReadyError } from "../src/rpc-error.js";
import { MemoryStore, roomIndexKey } from "../src/store.js";
import { DEFAULT_POLICY, type SurfaceItem } from "../src/types.js";
import { DEV_KEY } from "./helpers/harness.js";
import { brief, member, roomManifest, session, type SessionSeed } from "./helpers/fixtures.js";

const ISSUER = "https://mcp.example.test";
const PANEL = "https://dash.example.test";
const T = Date.parse("2026-10-01T00:00:00Z");

let store: MemoryStore;
let deps: StatsRouteDeps;

const caller = async (request: Request): Promise<RoomCaller | null> => {
  const identity = resolveIdentity(request.headers.get("authorization") ?? undefined);
  return identity ? { identity, via: "bearer" } : null;
};

beforeEach(() => {
  store = new MemoryStore();
  // u_jesse is DEV_KEY.jesse's userId, in org_codenerd; u_peer is DEV_KEY.peer's.
  deps = { store, caller, panelOrigins: [PANEL], operators: new Set(["u_jesse"]), overrides: {}, honourPurchases: true };
});

function call(key: string | null, path = "/operator/rooms", method = "GET") {
  const headers: Record<string, string> = { origin: PANEL };
  if (key) headers.authorization = `Bearer ${key}`;
  return statsRoutes(new Request(`${ISSUER}${path}`, { method, headers }), deps);
}

const bodyOf = async (res: Response | undefined) => (await res!.json()) as Record<string, unknown>;
type Row = Record<string, unknown> & { id: string };
const listOf = async (path = "/operator/rooms") => {
  const res = await call(DEV_KEY.jesse, path);
  expect(res!.status, await res!.clone().text()).toBe(200);
  return (await res!.json()) as { rooms: Row[]; next: string | null };
};

/** A room created at `T + at`, its creator seated then, so the index orders the rooms by `at`. */
async function room(id: string, at: number, over: SessionSeed = {}) {
  const orgId = over.orgId === undefined ? "org_codenerd" : over.orgId;
  const s = session({ id, orgId, members: [member({ joinedAt: T + at, lastSeenAt: Date.now(), orgId })], ...over });
  await store.createSession(s);
  return s;
}

describe("GET /operator/rooms and /operator/rooms/:id: the gate", () => {
  it.each(["/operator/rooms", "/operator/rooms/qs_any", "/operator/rooms/"])("refuses a caller it cannot identify at %s", async (path) => {
    const res = await call(null, path);
    expect(res!.status).toBe(401);
    expect(await bodyOf(res)).toMatchObject({ error: "unauthorized" });
  });

  it.each(["GET", "POST", "DELETE"].flatMap((method) => ["/operator/rooms", "/operator/rooms/qs_any"].map((path) => ({ method, path }))))(
    "refuses a signed-in caller who is not an operator, $method $path, and names no mechanism",
    async ({ method, path }) => {
      await room("qs_any", 0);
      const res = await call(DEV_KEY.peer, path, method);
      expect(res!.status).toBe(403);
      const body = await bodyOf(res);
      expect(body).toMatchObject({ error: "not_available" });
      expect(JSON.stringify(body)).not.toMatch(/BELLMAN_OPERATORS|operator|qs_any/i);
      expect(await store.operatorAudit(10), "a refusal reads nothing, so audits nothing").toEqual([]);
    },
  );

  it("answers 405 to an operator sending anything but GET", async () => {
    for (const path of ["/operator/rooms", "/operator/rooms/qs_any"]) {
      const res = await call(DEV_KEY.jesse, path, "POST");
      expect(res!.status).toBe(405);
      expect(res!.headers.get("allow")).toBe("GET");
    }
  });

  it("carries on for a path past a room's id", async () => {
    expect(await call(DEV_KEY.jesse, "/operator/rooms/qs_a/events")).toBeUndefined();
  });

  it("answers the preflight and carries the panel's origin", async () => {
    const pre = await call(null, "/operator/rooms", "OPTIONS");
    expect(pre!.status).toBe(204);
    expect(pre!.headers.get("access-control-allow-origin")).toBe(PANEL);
    expect((await call(DEV_KEY.jesse))!.headers.get("access-control-allow-origin")).toBe(PANEL);
  });
});

describe("GET /operator/rooms", () => {
  it("lists every room newest first, each with its index facts and its summary", async () => {
    await room("qs_old", 0, { orgId: null, members: [member({ joinedAt: T, orgId: null, userId: "u_outsider" })], createdBy: "u_outsider" });
    const s = await room("qs_new", 1_000, { manifest: roomManifest({ public: true }) });
    await store.appendEvent(s.id, { type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: { text: "hi" }, refId: null });
    await store.chargeBlobBytes(s.id, 40);
    await store.closeSession("qs_old");

    const { rooms, next } = await listOf();
    expect(next).toBeNull();
    const last = (await store.recentEvents(s.id, 1))[0]!;
    expect(rooms).toEqual([
      {
        id: "qs_new", name: "test-room", created_by: "u_jesse", created_by_handle: null, org_id: "org_codenerd", preset: "pair", mode: "pair",
        public: true, hosted: false, created_at: new Date(T + 1_000).toISOString(), last_event_at: new Date(last.at).toISOString(),
        status: "open", seats: { active: 1, capacity: 2 }, events: 1, surface_items: 0, blob_bytes: 40,
      },
      {
        id: "qs_old", name: "test-room", created_by: "u_outsider", created_by_handle: null, org_id: null, preset: "pair", mode: "pair",
        public: false, hosted: false, created_at: new Date(T).toISOString(), last_event_at: null,
        status: "closed", seats: { active: 1, capacity: 2 }, events: 0, surface_items: 0, blob_bytes: 0,
      },
    ]);
  });

  it("pages by `limit`, `next` resuming after the page's last row and null once the index is exhausted", async () => {
    for (let i = 0; i < 5; i++) await room(`qs_${i}`, i * 1_000);
    const first = await listOf("/operator/rooms?limit=2");
    expect(first.rooms.map((r) => r.id)).toEqual(["qs_4", "qs_3"]);
    expect(first.next).toBe(roomIndexKey({ createdAt: T + 3_000, sessionId: "qs_3" }));
    const second = await listOf(`/operator/rooms?limit=2&after=${encodeURIComponent(first.next!)}`);
    expect(second.rooms.map((r) => r.id)).toEqual(["qs_2", "qs_1"]);
    const third = await listOf(`/operator/rooms?limit=2&after=${encodeURIComponent(second.next!)}`);
    expect(third.rooms.map((r) => r.id)).toEqual(["qs_0"]);
    expect(third.next).toBeNull();
    // A page that ends exactly at the index's end says so: the read looks one row past the page.
    expect((await listOf("/operator/rooms?limit=5")).next).toBeNull();
  });

  it("answers 50 rooms a page by default", async () => {
    for (let i = 0; i < 51; i++) await room(`qs_${String(i).padStart(2, "0")}`, i);
    const { rooms, next } = await listOf();
    expect(rooms).toHaveLength(50);
    expect(rooms[0].id).toBe("qs_50");
    expect(next).toBe(roomIndexKey({ createdAt: T + 1, sessionId: "qs_01" }));
  });

  it("filters on public, hosted and org, from the index rows", async () => {
    await room("qs_plain", 0);
    await room("qs_pub", 1, { manifest: roomManifest({ public: true }) });
    await room("qs_hosted", 2, { manifest: roomManifest({ mode: "swarm", preset: null, host: { role: "peer_b", model: "haiku", instructions: null } }) });
    await room("qs_other", 3, { orgId: "org_other" });

    const ids = async (q: string) => (await listOf(`/operator/rooms?${q}`)).rooms.map((r) => r.id);
    expect(await ids("public=true")).toEqual(["qs_pub"]);
    expect(await ids("public=false")).toEqual(["qs_other", "qs_hosted", "qs_plain"]);
    expect(await ids("hosted=true")).toEqual(["qs_hosted"]);
    expect(await ids("org=org_other")).toEqual(["qs_other"]);
    expect(await ids("org=org_codenerd&public=false&hosted=false")).toEqual(["qs_plain"]);
  });

  it("filters on status over the summarised page", async () => {
    await room("qs_open", 0);
    await room("qs_closed", 1);
    await store.closeSession("qs_closed");
    await room("qs_frozen", 2);
    await store.freezeSession("qs_frozen", Date.now());
    const ids = async (q: string) => (await listOf(`/operator/rooms?${q}`)).rooms.map((r) => r.id);
    expect(await ids("status=open")).toEqual(["qs_open"]);
    expect(await ids("status=closed")).toEqual(["qs_closed"]);
    expect(await ids("status=frozen")).toEqual(["qs_frozen"]);
    expect(await ids("status=purge_scheduled")).toEqual([]);
  });

  it("fills a page filtered by owner however many other rooms sit between, and pages on to exactly the owner's rooms", async () => {
    for (let i = 0; i < 60; i++) {
      const mine = i % 12 !== 0; // 55 of 60
      await room(`qs_${String(i).padStart(2, "0")}`, i, mine ? {} : {
        createdBy: "u_peer", members: [member({ userId: "u_peer", joinedAt: T + i, lastSeenAt: Date.now() })],
      });
    }
    const first = await listOf("/operator/rooms?created_by=u_jesse");
    expect(first.rooms).toHaveLength(50);
    expect(first.rooms.every((r) => r.created_by === "u_jesse")).toBe(true);
    const second = await listOf(`/operator/rooms?created_by=u_jesse&after=${encodeURIComponent(first.next!)}`);
    expect(second.rooms).toHaveLength(5);
    expect(second.next).toBeNull();
  });

  it("filters on created_by, alone and with org, and answers an unknown owner an empty last page", async () => {
    await room("qs_mine", 0);
    await room("qs_mine_noorg", 1, { orgId: null });
    await room("qs_peers", 2, { createdBy: "u_peer", members: [member({ userId: "u_peer", joinedAt: T + 2, lastSeenAt: Date.now() })] });
    const ids = async (q: string) => (await listOf(`/operator/rooms?${q}`)).rooms.map((r) => r.id);
    expect(await ids("created_by=u_jesse")).toEqual(["qs_mine_noorg", "qs_mine"]);
    expect(await ids("created_by=u_jesse&org=org_codenerd")).toEqual(["qs_mine"]);
    expect(await ids("created_by=u_jesse&org=~none")).toEqual(["qs_mine_noorg"]);
    expect(await listOf("/operator/rooms?created_by=u_nobody")).toEqual({ rooms: [], next: null });
  });

  it("answers org=~none with exactly the rooms that have no org", async () => {
    await room("qs_org", 0);
    await room("qs_none_a", 1, { orgId: null });
    await room("qs_other", 2, { orgId: "org_other" });
    await room("qs_none_b", 3, { orgId: null });
    expect((await listOf("/operator/rooms?org=~none")).rooms.map((r) => r.id)).toEqual(["qs_none_b", "qs_none_a"]);
  });

  it("names each row's creator by handle, null for one without", async () => {
    await store.claimHandle("u_jesse", "jesse");
    await room("qs_handled", 0);
    await room("qs_bare", 1, { createdBy: "u_peer", members: [member({ userId: "u_peer", joinedAt: T + 1, lastSeenAt: Date.now() })] });
    const { rooms } = await listOf();
    expect(Object.fromEntries(rooms.map((r) => [r.id, r.created_by_handle]))).toEqual({ qs_handled: "jesse", qs_bare: null });
    expect((await bodyOf(await call(DEV_KEY.jesse, "/operator/rooms/qs_handled"))).created_by_handle).toBe("jesse");
  });

  // The index row keeps the flag a room was created with; unpublishing is one way, and the record is what says it now.
  it("reads public off the room as it is now, an unpublished room included, in the row and in both public filters", async () => {
    await room("qs_was_public", 0, { manifest: roomManifest({ public: true }) });
    await room("qs_still_public", 1, { manifest: roomManifest({ public: true }) });
    await room("qs_private", 2);
    await store.unpublishSession("qs_was_public", Date.now());

    const { rooms } = await listOf();
    expect(Object.fromEntries(rooms.map((r) => [r.id, r.public]))).toEqual({ qs_private: false, qs_still_public: true, qs_was_public: false });
    const ids = async (q: string) => (await listOf(`/operator/rooms?${q}`)).rooms.map((r) => r.id);
    expect(await ids("public=false")).toEqual(["qs_private", "qs_was_public"]);
    expect(await ids("public=true")).toEqual(["qs_still_public"]);
    expect((await bodyOf(await call(DEV_KEY.jesse, "/operator/rooms/qs_was_public"))).public).toBe(false);
  });

  it("skips a row whose room is gone, and takes it out of the index so the counts stop including it", async () => {
    await room("qs_kept", 0);
    await room("qs_gone", 1);
    const summary = store.roomSummary.bind(store);
    store.roomSummary = async (id) => (id === "qs_gone" ? undefined : summary(id));
    const drop = store.dropRoomIndex.bind(store);
    const dropped: string[] = [];
    store.dropRoomIndex = async (id) => {
      dropped.push(id);
      return drop(id);
    };
    const { rooms } = await listOf();
    expect(rooms.map((r) => r.id)).toEqual(["qs_kept"]);
    expect(dropped).toEqual(["qs_gone"]);
    expect((await store.operatorAudit(1))[0].detail).toMatchObject({ room_ids: ["qs_kept"] });
    expect((await store.listRoomsPage(10)).map((r) => r.sessionId)).toEqual(["qs_kept"]);
    expect((await store.roomCounts("owner", 10)).total).toBe(1);
  });

  it("never drops a room whose summary failed, and answers the page when a drop fails", async () => {
    await room("qs_lagging", 0);
    await room("qs_gone", 1);
    const summary = store.roomSummary.bind(store);
    store.roomSummary = async (id) =>
      id === "qs_lagging" ? Promise.reject(new Error("does not implement roomSummary")) : id === "qs_gone" ? undefined : summary(id);
    const dropped: string[] = [];
    store.dropRoomIndex = async (id) => {
      dropped.push(id);
      throw new Error("registry unreachable");
    };
    const { rooms } = await listOf();
    expect(rooms.map((r) => r.id)).toEqual(["qs_lagging"]);
    expect(dropped).toEqual(["qs_gone"]);
  });

  it("answers a room whose summary failed with its index facts and the summary's fields null", async () => {
    await room("qs_lagging", 0);
    await room("qs_fine", 1);
    const summary = store.roomSummary.bind(store);
    store.roomSummary = async (id) => (id === "qs_lagging" ? Promise.reject(new Error("does not implement roomSummary")) : summary(id));
    const { rooms } = await listOf();
    expect(rooms.map((r) => r.id)).toEqual(["qs_fine", "qs_lagging"]);
    expect(rooms[1]).toEqual({
      id: "qs_lagging", name: null, created_by: "u_jesse", created_by_handle: null, org_id: "org_codenerd", preset: "pair", mode: "pair",
      public: false, hosted: false, created_at: new Date(T).toISOString(), last_event_at: null,
      status: null, seats: null, events: null, surface_items: null, blob_bytes: null,
    });
    expect((await listOf("/operator/rooms?status=open")).rooms.map((r) => r.id), "a status filter cannot pass a status it does not know").toEqual(["qs_fine"]);
  });

  it.each([
    ["limit=0", "limit"], ["limit=51", "limit"], ["limit=two", "limit"], ["limit=1.5", "limit"], ["limit=", "limit"],
    ["after=nonsense", "after"], ["after=", "after"],
    ["public=yes", "public"], ["hosted=1", "hosted"], ["org=org%3Aa", "org"], ["org=", "org"], ["org=~x", "org"],
    ["created_by=", "created_by"], [`created_by=${"u".repeat(129)}`, "created_by"],
    ["status=active", "status"], ["sort=cost", "sort"],
  ])("refuses %s, naming %s", async (query, param) => {
    const res = await call(DEV_KEY.jesse, `/operator/rooms?${query}`);
    expect(res!.status).toBe(400);
    const body = await bodyOf(res);
    expect(body).toMatchObject({ error: "invalid_request" });
    expect(String(body.error_description)).toContain(param);
    expect(await store.operatorAudit(10)).toEqual([]);
  });
});

describe("GET /operator/rooms/:id", () => {
  it("answers the row, its purpose and its role names", async () => {
    const s = await room("qs_detail", 0, { manifest: roomManifest({ purpose: "Ship the invoice fix" }) });
    const res = await call(DEV_KEY.jesse, `/operator/rooms/${s.id}`);
    expect(res!.status, await res!.clone().text()).toBe(200);
    expect(await res!.json()).toEqual({
      id: "qs_detail", name: "test-room", created_by: "u_jesse", created_by_handle: null, org_id: "org_codenerd", preset: "pair", mode: "pair",
      public: false, hosted: false, created_at: new Date(T).toISOString(), last_event_at: null,
      status: "open", seats: { active: 1, capacity: 2 }, events: 0, surface_items: 0, blob_bytes: 0,
      purpose: "Ship the invoice fix", roles: Object.keys(roomManifest().roles),
    });
  });

  it("answers 404 for a room that is not there, a purged one included, and audits nothing", async () => {
    expect((await call(DEV_KEY.jesse, "/operator/rooms/qs_never"))!.status).toBe(404);
    await room("qs_purged", 0, { retainAfterCloseMs: 0 });
    await store.closeSession("qs_purged");
    await store.sweep(Date.now() + 1);
    expect(await store.getSession("qs_purged")).toBeUndefined();
    const res = await call(DEV_KEY.jesse, "/operator/rooms/qs_purged");
    expect(res!.status).toBe(404);
    expect(await bodyOf(res)).toMatchObject({ error: "not_found" });
    expect(await store.operatorAudit(10)).toEqual([]);
  });

  it("answers a room whose summary failed with the summary's fields null and the record's purpose and roles", async () => {
    await room("qs_lagging", 0);
    store.roomSummary = () => Promise.reject(new Error("does not implement roomSummary"));
    const body = await bodyOf(await call(DEV_KEY.jesse, "/operator/rooms/qs_lagging"));
    expect(body).toMatchObject({ id: "qs_lagging", status: null, seats: null, events: null, roles: Object.keys(roomManifest().roles) });
  });
});

describe("the operator's reads are audited (#472)", () => {
  it("writes one platform entry a list page, naming the operator, the room ids returned and the filters", async () => {
    await room("qs_a", 0);
    await room("qs_b", 1);
    await listOf("/operator/rooms?limit=1&public=false");
    await listOf("/operator/rooms?status=frozen");
    expect(await store.operatorAudit(10)).toEqual([
      expect.objectContaining({
        orgId: null, sessionId: "operator:rooms", actorUserId: "u_jesse", action: "operator_rooms_listed",
        detail: { room_ids: ["qs_b"], filters: { limit: 1, public: false } },
      }),
      expect.objectContaining({ detail: { room_ids: [], filters: { status: "frozen" } } }),
    ]);
    expect(await store.auditForOrg("org_codenerd", 10), "a list page writes to no org's stream").toEqual([]);
  });

  it("writes a detail read to the platform stream and to every org that sat in the room", async () => {
    const s = session({
      id: "qs_two_orgs", orgId: "org_codenerd",
      members: [member({ joinedAt: T }), member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b", orgId: "org_other", joinedAt: T })],
    });
    await store.createSession(s);
    expect((await call(DEV_KEY.jesse, `/operator/rooms/${s.id}`))!.status).toBe(200);

    expect(await store.operatorAudit(10)).toEqual([
      expect.objectContaining({ sessionId: s.id, actorUserId: "u_jesse", action: "operator_room_read", detail: { room_id: s.id } }),
    ]);
    for (const org of ["org_codenerd", "org_other"]) {
      expect(await store.auditForOrg(org, 10), org).toEqual([
        expect.objectContaining({ orgId: org, sessionId: s.id, actorUserId: "u_jesse", action: "operator_room_read", detail: { room_id: s.id } }),
      ]);
    }
  });

  it("files the platform entries with the operator's label and org, the room, and the orgs the read crossed", async () => {
    await room("qs_mine", 0);
    await room("qs_theirs", 1, { orgId: "org_customer" });
    await room("qs_nobodys", 2, { orgId: null });
    await listOf();
    await call(DEV_KEY.jesse, "/operator/rooms/qs_mine");
    await call(DEV_KEY.jesse, "/operator/rooms/qs_theirs");
    const common = { orgId: null, actorUserId: "u_jesse", actorLabel: "jesse@codenerd", actorOrgId: "org_codenerd" };
    expect(await store.operatorAudit(10)).toEqual([
      expect.objectContaining({
        ...common, sessionId: "operator:rooms", roomName: null,
        parties: ["org_codenerd", "org_customer", null], crossing: "cross_org", direction: "outbound",
      }),
      expect.objectContaining({ ...common, sessionId: "qs_mine", roomName: "test-room", parties: ["org_codenerd"], crossing: "internal", direction: null }),
      expect.objectContaining({
        ...common, sessionId: "qs_theirs", roomName: "test-room", parties: ["org_codenerd", "org_customer"], crossing: "cross_org", direction: "outbound",
      }),
    ]);
  });

  it.each([
    { operator: "an operator in another org", key: DEV_KEY.jesse, userId: "u_jesse", parties: ["org_codenerd", "org_customer"] },
    { operator: "an operator in no org", key: DEV_KEY.outsider, userId: "u_outsider", parties: ["org_customer", null] },
  ])("files a customer's row for $operator as an inbound crossing, and nothing in the operator's own org", async ({ key, userId, parties }) => {
    deps = { ...deps, operators: new Set([userId]) };
    await room("qs_customer", 0, { orgId: "org_customer" });
    expect((await call(key, "/operator/rooms/qs_customer"))!.status).toBe(200);
    expect(await store.auditForOrg("org_customer", 10)).toEqual([
      expect.objectContaining({ orgId: "org_customer", actorUserId: userId, parties, crossing: "cross_org", direction: "inbound" }),
    ]);
    expect(await store.auditForOrg("org_codenerd", 10)).toEqual([]);
  });

  it.each([
    { what: "the platform entry, on a list page", path: "/operator/rooms", fail: "appendOperatorAudit" as const },
    { what: "the platform entry, on a detail read", path: "/operator/rooms/qs_secret", fail: "appendOperatorAudit" as const },
    { what: "an org's entry, on a detail read", path: "/operator/rooms/qs_secret", fail: "appendAudit" as const },
  ])("answers 500 and no room when $what cannot be written", async ({ path, fail }) => {
    await room("qs_secret", 0);
    store[fail] = () => Promise.reject(new Error("audit unreachable"));
    const res = await call(DEV_KEY.jesse, path);
    expect(res!.status).toBe(500);
    const text = await res!.text();
    expect(JSON.parse(text)).toMatchObject({ error: "internal" });
    expect(text).not.toContain("qs_secret");
    expect(text).not.toContain("test-room");
  });
});

describe("GET /operator/room-counts (dash#94)", () => {
  const counts = async (q: string) => {
    const res = await call(DEV_KEY.jesse, `/operator/room-counts?${q}`);
    expect(res!.status, await res!.clone().text()).toBe(200);
    return (await res!.json()) as { by: string; total_rooms: number; groups: { key: string; label: string | null; rooms: number }[]; next: string | null };
  };
  const peer = (id: string, at: number, orgId: string | null = "org_other") =>
    room(id, at, { createdBy: "u_peer", orgId, members: [member({ userId: "u_peer", joinedAt: T + at, lastSeenAt: Date.now(), orgId })] });
  const org = (orgId: string, name: string) => store.createOrg(
    { orgId, name, ownerUserId: "u_x", seats: 1, source: "operator", active: true, createdAt: 1, requireSso: false, domains: [], policy: DEFAULT_POLICY },
    { key: `github:${orgId}`, plan: "team", role: "admin", orgId, source: "operator", grantedAt: 1, grantedBy: "u_op", expiresAt: null },
    { actorUserId: "u_op" },
  );

  it.each(["GET", "POST", "DELETE"])("refuses a non-operator's %s with 403 and audits nothing", async (method) => {
    await room("qs_any", 0);
    const res = await call(DEV_KEY.peer, "/operator/room-counts?by=owner", method);
    expect(res!.status).toBe(403);
    expect(await bodyOf(res)).toMatchObject({ error: "not_available" });
    expect(await store.operatorAudit(10)).toEqual([]);
  });

  it("counts by owner, largest first and ties by key, labelled by handle, with the total", async () => {
    await store.claimHandle("u_peer", "peer");
    await room("qs_1", 0);
    await room("qs_2", 1, { orgId: null });
    await peer("qs_3", 2);
    await peer("qs_4", 3);
    await room("qs_5", 4, { createdBy: "u_outsider", orgId: null, members: [member({ userId: "u_outsider", joinedAt: T + 4, orgId: null })] });
    expect(await counts("by=owner")).toEqual({
      by: "owner", total_rooms: 5, next: null,
      groups: [{ key: "u_jesse", label: null, rooms: 2 }, { key: "u_peer", label: "peer", rooms: 2 }, { key: "u_outsider", label: null, rooms: 1 }],
    });
  });

  it("counts by org, the no-org group keyed ~none, labelled by the org's name", async () => {
    await org("org_other", "Other Inc");
    await room("qs_1", 0);
    await room("qs_2", 1, { orgId: null });
    await peer("qs_3", 2);
    await peer("qs_4", 3);
    await peer("qs_5", 4);
    expect((await counts("by=org")).groups).toEqual([
      { key: "org_other", label: "Other Inc", rooms: 3 }, { key: "org_codenerd", label: null, rooms: 1 }, { key: "~none", label: null, rooms: 1 },
    ]);
  });

  it("pages by limit, following next to every remaining group with none repeated", async () => {
    for (let i = 0; i < 7; i++) {
      const userId = `u_${String.fromCharCode(97 + i)}`;
      for (let j = 0; j <= i % 3; j++) await room(`qs_${i}_${j}`, i * 10 + j, { createdBy: userId, members: [member({ userId, joinedAt: T + i * 10 + j })] });
    }
    const seen: string[] = [];
    let after: string | null = null;
    do {
      const page = await counts(`by=owner&limit=3${after ? `&after=${encodeURIComponent(after)}` : ""}`);
      expect(page.groups.length).toBeLessThanOrEqual(3);
      seen.push(...page.groups.map((g) => g.key));
      after = page.next;
    } while (after !== null);
    expect(seen).toEqual(["u_c", "u_f", "u_b", "u_e", "u_a", "u_d", "u_g"]);
  });

  it("answers at most 50 groups with no limit", async () => {
    for (let i = 0; i < 51; i++) await room(`qs_${i}`, i, { createdBy: `u_${i}`, members: [member({ userId: `u_${i}`, joinedAt: T + i })] });
    const page = await counts("by=owner");
    expect(page.groups).toHaveLength(50);
    expect(page.next).not.toBeNull();
  });

  it.each([["", "by"], ["by=room", "by"], ["by=owner&limit=0", "limit"], ["by=owner&limit=101", "limit"], ["by=owner&after=x", "after"], ["by=owner&sort=n", "sort"]])(
    "refuses %s, naming %s, and audits nothing",
    async (query, param) => {
      const res = await call(DEV_KEY.jesse, `/operator/room-counts?${query}`);
      expect(res!.status).toBe(400);
      expect(String((await bodyOf(res)).error_description)).toContain(param);
      expect(await store.operatorAudit(10)).toEqual([]);
    },
  );

  it("files one platform entry, with the keys returned and the cursor asked for, crossing when a counted room is another org's", async () => {
    await room("qs_mine", 0);
    expect((await counts("by=owner")).groups).toHaveLength(1);
    await peer("qs_theirs", 1);
    await counts("by=org&limit=2&after=9%3Az");
    expect(await store.operatorAudit(10)).toEqual([
      expect.objectContaining({
        sessionId: "operator:room-counts", action: "operator_room_counts_read", actorUserId: "u_jesse",
        detail: { by: "owner", keys: ["u_jesse"], after: null }, parties: ["org_codenerd"], crossing: "internal",
      }),
      expect.objectContaining({
        detail: { by: "org", keys: ["org_codenerd", "org_other"], after: "9:z" }, crossing: "cross_org",
      }),
    ]);
    await counts("by=owner");
    expect((await store.operatorAudit(10)).at(-1)).toMatchObject({ detail: { keys: ["u_jesse", "u_peer"] }, crossing: "cross_org" });
  });

  it("answers 500 and no counts when the entry cannot be written", async () => {
    await room("qs_a", 0);
    store.appendOperatorAudit = () => Promise.reject(new Error("audit unreachable"));
    const res = await call(DEV_KEY.jesse, "/operator/room-counts?by=owner");
    expect(res!.status).toBe(500);
    const body = await bodyOf(res);
    expect(body.groups).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("u_jesse");
  });

  it("answers 503 not_ready, and audits nothing, while the registry is still on older code", async () => {
    store.roomCounts = () => Promise.reject(new NotReadyError());
    store.listRoomsFiltered = () => Promise.reject(new NotReadyError());
    for (const path of ["/operator/room-counts?by=org", "/operator/rooms?created_by=u_jesse"]) {
      const res = await call(DEV_KEY.jesse, path);
      expect(res!.status, path).toBe(503);
      expect(await bodyOf(res)).toMatchObject({ error: "not_ready" });
    }
    expect(await store.operatorAudit(10)).toEqual([]);
  });

  it("answers only the keys of counts, at any depth", async () => {
    await store.claimHandle("u_jesse", "jesse");
    await room("qs_a", 0);
    const keys = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); }
    };
    for (const by of ["owner", "org"]) walk(await counts(`by=${by}`));
    expect([...keys].sort()).toEqual(["by", "groups", "key", "label", "next", "rooms", "total_rooms"]);
  });
});

describe("no brief, message or surface content leaves (#472)", () => {
  const PLANTED = ["PLANTED-BRIEF-GOAL", "PLANTED-BRIEF-STATE", "PLANTED-MESSAGE", "PLANTED-CARD-TITLE", "PLANTED-CARD-BODY", "PLANTED-FILE-NAME"];
  const ALLOWED = new Set([
    "rooms", "next", "id", "name", "created_by", "created_by_handle", "org_id", "preset", "mode", "public", "hosted", "created_at", "last_event_at",
    "status", "seats", "active", "capacity", "events", "surface_items", "blob_bytes", "purpose", "roles",
  ]);

  /** Every key and every string in `value`, however deep. */
  function walk(value: unknown, keys: string[] = [], strings: string[] = []): { keys: string[]; strings: string[] } {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) for (const v of value) walk(v, keys, strings);
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        keys.push(k);
        walk(v, keys, strings);
      }
    }
    return { keys, strings };
  }

  it("answers neither in a list page nor in a detail read, at any depth", async () => {
    for (const [i, id] of ["qs_planted_a", "qs_planted_b"].entries()) {
      const s = session({
        id,
        members: [member({ joinedAt: T + i, brief: brief({ goal: PLANTED[0], state: PLANTED[1] }) })],
      });
      await store.createSession(s);
      await store.appendEvent(id, { type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: { text: PLANTED[2] }, refId: null });
      const card: SurfaceItem = { key: "card", kind: "text", title: PLANTED[3], body: PLANTED[4], ends: null, placement: null, blob: null, shape: null };
      const file: SurfaceItem = {
        key: "file", kind: "file", title: null, body: null, ends: null, placement: null, shape: null,
        blob: { id: "b_1", bytes: 3, type: "text/plain", name: PLANTED[5] },
      };
      for (const item of [card, file]) {
        await store.appendEvent(id, { type: "surface", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: item, refId: null }, { surface: { key: item.key, item } });
      }
    }
    // The positive control: the planted strings are in the store, where the walk would find them if a route leaked them.
    expect(JSON.stringify(await store.recentEvents("qs_planted_a", 10))).toContain(PLANTED[4]);
    expect(JSON.stringify(await store.getBriefs("qs_planted_a", ["m_creator"]))).toContain(PLANTED[0]);

    const bodies = [
      await bodyOf(await call(DEV_KEY.jesse, "/operator/rooms")),
      await bodyOf(await call(DEV_KEY.jesse, "/operator/rooms/qs_planted_a")),
    ];
    expect((bodies[0].rooms as unknown[]).length).toBe(2);
    for (const body of bodies) {
      const { keys, strings } = walk(body);
      expect(keys.filter((k) => !ALLOWED.has(k)), "a key outside the allowlist").toEqual([]);
      for (const planted of PLANTED) {
        expect(strings.filter((s) => s.includes(planted)), planted).toEqual([]);
      }
    }
  });
});
