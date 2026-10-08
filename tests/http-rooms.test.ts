/**
 * The room routes the panel calls (#184) over MemoryStore and MemoryBlobStore:
 * the list, the detail, the surface read with its ETag, and the surface writes
 * through the operation the tools call. Driven directly — a web Request in, a
 * Response out — with no listener. Who is calling is a stub over the dev keys,
 * as in tests/http-blobs.test.ts.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { resolveIdentity } from "../src/auth.js";
import { MemoryBlobStore } from "../src/blobs.js";
import { MAX_ROOMS_LISTED, MAX_SURFACE_WRITE_BYTES, roomRoutes, type RoomCaller, type RoomRouteDeps } from "../src/http/rooms.js";
import { STALE_AFTER_MS } from "../src/presence.js";
import { MemoryStore } from "../src/store.js";
import { member, session } from "./helpers/fixtures.js";
import { DEV_KEY, Harness } from "./helpers/harness.js";

const ISSUER = "https://mcp.example.test";
const PANEL = "https://dash.example.test";
const ROOM = "qs_routes";

let store: MemoryStore;
let blobs: MemoryBlobStore;
let deps: RoomRouteDeps;

/** Bearer: a dev key. Cookie: the dev key as the cookie's value, read straight off it. */
const caller = async (request: Request): Promise<RoomCaller | null> => {
  const bearer = resolveIdentity(request.headers.get("authorization") ?? undefined);
  if (bearer) return { identity: bearer, via: "bearer" };
  const cookie = /bellman_session=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  const identity = cookie ? resolveIdentity(`Bearer ${cookie}`) : null;
  return identity ? { identity, via: "cookie" } : null;
};

/** The peer member of the fixture room: a second person, with the seat that cannot write. */
const peer = () => member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b" });

beforeEach(async () => {
  store = new MemoryStore();
  blobs = new MemoryBlobStore();
  deps = { store, blobs, caller, panelOrigins: [PANEL] };
  // jesse (peer_a, the creator) holds write_surface; peer (peer_b) does not;
  // outsider holds no handle at all.
  await store.createSession(session({ id: ROOM, members: [member(), peer()] }));
});

interface CallOptions {
  method?: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  cookie?: string;
}

/** One request to the routes. `key` null sends no credential at all. */
function call(key: string | null, path: string, over: CallOptions = {}) {
  const headers: Record<string, string> = { ...(over.headers ?? {}) };
  if (key) headers.authorization = `Bearer ${key}`;
  if (over.cookie) headers.cookie = `__Host-bellman_session=${over.cookie}`;
  let body: string | undefined;
  if (over.rawBody !== undefined) body = over.rawBody;
  else if (over.body !== undefined) body = JSON.stringify(over.body);
  if (body !== undefined && !headers["content-type"]) headers["content-type"] = "application/json";
  return roomRoutes(new Request(`${ISSUER}${path}`, { method: over.method ?? "GET", headers, body }), deps);
}

const bodyOf = async (res: Response | undefined) => (await res!.json()) as Record<string, unknown>;

describe("GET /rooms", () => {
  it("refuses without a credential, with CORS on the refusal", async () => {
    const res = (await call(null, "/rooms", { headers: { origin: PANEL } }))!;
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe(PANEL);
    expect(await bodyOf(res)).toMatchObject({ error: "unauthorized" });
  });

  it("lists the rooms I created and the rooms I joined, marks mine, and omits a room I hold no handle in", async () => {
    // Created by jesse: the fixture room. Joined by jesse, created by peer: a second.
    await store.createSession(session({
      id: "qs_joined", createdBy: "u_peer",
      members: [peer(), member({ memberId: "m_jesse2", roomRole: "peer_b" })],
    }));
    // Created by jesse on the record, but jesse holds no handle: not listed, whatever the index says.
    await store.createSession(session({ id: "qs_stranger", members: [peer()] }));
    const res = (await call(DEV_KEY.jesse, "/rooms"))!;
    expect(res.status).toBe(200);
    const { rooms } = (await res.json()) as { rooms: { id: string; mine: boolean; members: number; status: string; mode: string }[] };
    const ids = rooms.map((r) => r.id).sort();
    expect(ids).toEqual(["qs_joined", ROOM]);
    expect(rooms.find((r) => r.id === ROOM)).toMatchObject({ mine: true, members: 2, status: "active", mode: "pair" });
    expect(rooms.find((r) => r.id === "qs_joined")).toMatchObject({ mine: false });
    expect(Object.keys(rooms[0]).sort()).toEqual(["id", "members", "mine", "mode", "room", "status"]);
  });

  it("lists a closed room with its status, and counts only the members still in", async () => {
    const departed = member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b", leftAt: Date.now() });
    await store.createSession(session({ id: "qs_closed", closed: true, members: [member(), departed] }));
    const res = (await call(DEV_KEY.jesse, "/rooms"))!;
    const { rooms } = (await res.json()) as { rooms: { id: string; status: string; members: number }[] };
    expect(rooms.find((r) => r.id === "qs_closed")).toMatchObject({ status: "closed", members: 1 });
  });

  it("is bounded at MAX_ROOMS_LISTED", async () => {
    for (let i = 0; i < MAX_ROOMS_LISTED + 5; i++) {
      await store.createSession(session({ id: `qs_many_${i}`, members: [member()] }));
    }
    const { rooms } = (await bodyOf(await call(DEV_KEY.jesse, "/rooms"))) as { rooms: unknown[] };
    expect(rooms.length).toBe(MAX_ROOMS_LISTED);
  });

  // The test above passes with the final slice gone, or with the listings unbounded: either one alone keeps
  // the rows at the bound when the two listings name the same rooms. Here they name different ones, so the
  // union is past it, and the reads are counted because the bound on the walk is the other half of D1.
  it("stays bounded in rows and in reads when the two listings share no room", async () => {
    for (let i = 0; i < 60; i++) {
      await store.createSession(session({
        id: `qs_joined_${i}`, createdBy: "u_peer",
        members: [peer(), member({ memberId: `m_jesse_${i}`, roomRole: "peer_b" })],
      }));
    }
    for (let i = 0; i < 60; i++) await store.createSession(session({ id: `qs_made_${i}`, members: [member()] }));
    let reads = 0;
    const read = store.getSession.bind(store);
    store.getSession = async (id: string) => { reads++; return read(id); };
    const { rooms } = (await bodyOf(await call(DEV_KEY.jesse, "/rooms"))) as { rooms: unknown[] };
    expect(rooms.length).toBe(MAX_ROOMS_LISTED);
    expect(reads).toBeLessThanOrEqual(2 * MAX_ROOMS_LISTED);
  });

  it("lists the newest room first, by the creator's seat", async () => {
    const madeAt = (id: string, joinedAt: number) =>
      store.createSession(session({ id, members: [member({ joinedAt })] }));
    await madeAt("qs_old", 1_000);
    await madeAt("qs_newest", 3_000);
    await madeAt("qs_middle", 2_000);
    const { rooms } = (await bodyOf(await call(DEV_KEY.jesse, "/rooms"))) as { rooms: { id: string }[] };
    // The fixture room's creator joined just now, so it leads.
    expect(rooms.map((r) => r.id)).toEqual([ROOM, "qs_newest", "qs_middle", "qs_old"]);
  });

  it("answers the list for a cookie caller and a preflight for the panel", async () => {
    const res = (await call(null, "/rooms", { cookie: DEV_KEY.jesse, headers: { origin: PANEL } }))!;
    expect(res.status).toBe(200);
    const pre = (await call(null, "/rooms", { method: "OPTIONS", headers: { origin: PANEL } }))!;
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-methods")).toContain("GET");
  });

  it("answers 405 to a method the list does not take", async () => {
    const res = (await call(DEV_KEY.jesse, "/rooms", { method: "POST", body: {} }))!;
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });

  // #113 on the list: a person every one of whose handles was removed is told the member count as it stood at the
  // removal, not how many are in now. The creator, still in, is the control: it sees the late joiner.
  it("counts a removed member's room as it stood at the removal", async () => {
    await evictThroughTool("m_peer");
    const cutAt = (await store.getSession(ROOM))!.members.find((m) => m.memberId === "m_peer")!.leftAt!;
    await store.addMember(ROOM, member({ memberId: "m_late", userId: "u_late", label: "late@codenerd", roomRole: "peer_b", joinedAt: cutAt + 1 }));
    const count = async (key: string) =>
      ((await bodyOf(await call(key, "/rooms"))) as { rooms: { id: string; members: number }[] }).rooms.find((r) => r.id === ROOM)!.members;
    expect(await count(DEV_KEY.peer)).toBe(1);
    expect(await count(DEV_KEY.jesse)).toBe(2);
  });

  // The list is newest first among the rooms the two indexes returned, and each index is asked for MAX_ROOMS_LISTED ids
  // and does not order by recency, so past the bound the page is shown a window the indexes chose. `truncated` says so.
  // One case per way the rule can be true, since each has its own clause.
  describe("truncated", () => {
    const listed = async () => (await bodyOf(await call(DEV_KEY.jesse, "/rooms"))) as { rooms: { id: string }[]; truncated: boolean };

    it("is true when the created listing came back full", async () => {
      for (let i = 0; i < 60; i++) await store.createSession(session({ id: `qs_made_${i}`, members: [member()] }));
      const { rooms, truncated } = await listed();
      expect([rooms.length, truncated]).toEqual([MAX_ROOMS_LISTED, true]);
    });

    it("is true when the joined listing came back full", async () => {
      for (let i = 0; i < 60; i++) {
        await store.createSession(session({
          id: `qs_joined_${i}`, createdBy: "u_peer",
          members: [peer(), member({ memberId: `m_jesse_${i}`, roomRole: "peer_b" })],
        }));
      }
      const { rooms, truncated } = await listed();
      expect([rooms.length, truncated]).toEqual([MAX_ROOMS_LISTED, true]);
    });

    it("is true when the created listing came back full, though none of its other rooms survive the roster check", async () => {
      // Created by jesse on the record, with no handle of jesse's: named by the index, dropped by the roster.
      for (let i = 0; i < MAX_ROOMS_LISTED; i++) await store.createSession(session({ id: `qs_theirs_${i}`, members: [peer()] }));
      const { rooms, truncated } = await listed();
      expect([rooms.map((r) => r.id), truncated]).toEqual([[ROOM], true]);
    });

    it("is true when the rooms found exceed the bound though neither listing came back full", async () => {
      // The registry's two indexes can disagree about a room, so the union can be larger than either listing.
      const ids = Array.from({ length: 60 }, (_, i) => `qs_either_${i}`);
      for (const id of ids) await store.createSession(session({ id, members: [member()] }));
      store.sessionsCreatedBy = async () => ids.slice(0, 30);
      store.sessionsJoinedBy = async () => ids.slice(30);
      const { rooms, truncated } = await listed();
      expect([rooms.length, truncated]).toEqual([MAX_ROOMS_LISTED, true]);
    });

    it("is false while the listings come back short, and true at the first full one", async () => {
      expect((await listed()).truncated).toBe(false);
      for (let i = 0; i < MAX_ROOMS_LISTED - 2; i++) await store.createSession(session({ id: `qs_more_${i}`, members: [member()] }));
      // The fixture room and 48 more: 49 rooms, one short of the bound.
      expect(await listed()).toMatchObject({ truncated: false });
      await store.createSession(session({ id: "qs_fiftieth", members: [member()] }));
      // A listing of exactly the bound may have held more, so it counts as bounded.
      expect(await listed()).toMatchObject({ truncated: true });
    });
  });
});

describe("GET /rooms/:id", () => {
  it("answers one 404 for a stranger and for an unknown room", async () => {
    const stranger = (await call(DEV_KEY.outsider, `/rooms/${ROOM}`))!;
    const unknown = (await call(DEV_KEY.jesse, "/rooms/qs_nope"))!;
    expect([stranger.status, unknown.status]).toEqual([404, 404]);
    expect(await bodyOf(stranger)).toEqual(await bodyOf(unknown));
  });

  it("returns the preview for my seat, the roster, the status, and my handles with their verbs", async () => {
    const res = (await call(DEV_KEY.jesse, `/rooms/${ROOM}`))!;
    expect(res.status).toBe(200);
    const body = await bodyOf(res) as {
      id: string; session_status: string;
      preview: { your_role: string; your_verbs: string[]; text: { trust: string } };
      members: { member_id: string; presence: string; active: boolean }[];
      my_handles: { member_id: string; room_role: string; verbs: string[]; active: boolean; removed: boolean }[];
    };
    expect(body.id).toBe(ROOM);
    expect(body.session_status).toBe("active");
    expect(body.preview.your_role).toBe("peer_a");
    expect(body.preview.your_verbs).toContain("write_surface");
    expect(body.preview.text.trust).toBe("untrusted");
    expect(body.members.map((m) => m.member_id).sort()).toEqual(["m_creator", "m_peer"]);
    expect(body.members[0]).toHaveProperty("presence");
    expect(body.my_handles).toEqual([
      { member_id: "m_creator", room_role: "peer_a", verbs: expect.arrayContaining(["write_surface"]), active: true, removed: false },
    ]);
  });

  it("gives a seat without the verb a preview that says so", async () => {
    const body = await bodyOf(await call(DEV_KEY.peer, `/rooms/${ROOM}`)) as { my_handles: { verbs: string[] }[] };
    expect(body.my_handles[0].verbs).not.toContain("write_surface");
  });

  it("lists every handle I hold, and names the removed one", async () => {
    // Joined twice: one handle removed by the creator, one still in.
    await store.createSession(session({
      id: "qs_two", createdBy: "u_peer",
      members: [
        peer(),
        member({ memberId: "m_old", roomRole: "peer_b", leftAt: Date.now(), removedAtCursor: 3 }),
        member({ memberId: "m_new", roomRole: "peer_b" }),
      ],
    }));
    const body = await bodyOf(await call(DEV_KEY.jesse, "/rooms/qs_two")) as {
      preview: { your_role: string }; my_handles: { member_id: string; active: boolean; removed: boolean }[];
    };
    expect(body.my_handles).toEqual([
      { member_id: "m_old", room_role: "peer_b", verbs: expect.any(Array), active: false, removed: true },
      { member_id: "m_new", room_role: "peer_b", verbs: expect.any(Array), active: true, removed: false },
    ]);
    expect(body.preview.your_role).toBe("peer_b");
  });

  // The test above gives both handles one role, so it cannot tell which handle the preview follows. Here the
  // removed handle comes first and holds another seat: the preview is the seat still in the room.
  it("previews the seat of the handle still in the room, not the first one held", async () => {
    await store.createSession(session({
      id: "qs_two_seats", createdBy: "u_peer",
      members: [
        peer(),
        member({ memberId: "m_old", roomRole: "peer_a", leftAt: Date.now(), removedAtCursor: 3 }),
        member({ memberId: "m_new", roomRole: "peer_b" }),
      ],
    }));
    const body = await bodyOf(await call(DEV_KEY.jesse, "/rooms/qs_two_seats")) as { preview: { your_role: string } };
    expect(body.preview.your_role).toBe("peer_b");
  });

  it("still answers a member who left, and a closed room", async () => {
    await store.createSession(session({ id: "qs_gone", closed: true, members: [member({ leftAt: Date.now() })] }));
    const res = (await call(DEV_KEY.jesse, "/rooms/qs_gone"))!;
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toMatchObject({ session_status: "closed", my_handles: [{ active: false, removed: false }] });
  });

  it("refuses without a credential, with CORS on the refusal, and answers 405 to a method it does not take", async () => {
    const anonymous = (await call(null, `/rooms/${ROOM}`, { headers: { origin: PANEL } }))!;
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("access-control-allow-origin")).toBe(PANEL);
    expect(await bodyOf(anonymous)).toMatchObject({ error: "unauthorized" });
    const post = (await call(DEV_KEY.jesse, `/rooms/${ROOM}`, { method: "POST", body: {} }))!;
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
  });

  // #113 on this route: a person every one of whose handles was removed reads the room as it stood at the removal and
  // nothing after it, as on the surface, `bellman_sync` and `/ws`. The creator, still in, is the control: it sees the late
  // joiner and the presence the removed member must not.
  it("serves a removed member the roster as of its removal, with no presence", async () => {
    await evictThroughTool("m_peer");
    const cutAt = (await store.getSession(ROOM))!.members.find((m) => m.memberId === "m_peer")!.leftAt!;
    await store.addMember(ROOM, member({ memberId: "m_late", userId: "u_late", label: "late@codenerd", roomRole: "peer_b", joinedAt: cutAt + 1 }));
    type Roster = { members: Record<string, unknown>[]; my_handles: { removed: boolean }[] };
    const asPeer = await bodyOf(await call(DEV_KEY.peer, `/rooms/${ROOM}`)) as Roster;
    expect(asPeer.members.map((m) => m.member_id).sort()).toEqual(["m_creator", "m_peer"]);
    expect(asPeer.members.some((m) => "presence" in m)).toBe(false);
    // The page can still say "you were removed".
    expect(asPeer.my_handles).toMatchObject([{ removed: true }]);
    const asCreator = await bodyOf(await call(DEV_KEY.jesse, `/rooms/${ROOM}`)) as Roster;
    expect(asCreator.members.map((m) => m.member_id).sort()).toEqual(["m_creator", "m_late", "m_peer"]);
    expect(asCreator.members.every((m) => "presence" in m)).toBe(true);
  });

  // The cut is for a person with nothing left in the room. One handle still in it, or one that left of its own accord,
  // keeps the live roster: the same predicate the surface route cuts on, so the two cannot disagree.
  it("keeps the live roster, presence included, for a person with a handle still in the room or one that left", async () => {
    await store.createSession(session({
      id: "qs_one_in", createdBy: "u_peer",
      members: [peer(), member({ memberId: "m_old", roomRole: "peer_b", leftAt: Date.now(), removedAtCursor: 3 }), member({ memberId: "m_new", roomRole: "peer_b" })],
    }));
    await store.createSession(session({
      id: "qs_left", createdBy: "u_peer",
      members: [peer(), member({ memberId: "m_left", roomRole: "peer_b", leftAt: Date.now() })],
    }));
    for (const id of ["qs_one_in", "qs_left"]) {
      const body = await bodyOf(await call(DEV_KEY.jesse, `/rooms/${id}`)) as { members: object[] };
      expect(body.members.length, id).toBeGreaterThan(1);
      expect(body.members.every((m) => "presence" in m), id).toBe(true);
    }
  });

  it("shows each member as in or out as they were at the removal, not as they are", async () => {
    const joined = (memberId: string) => member({ memberId, userId: `u_${memberId}`, label: `${memberId}@codenerd`, roomRole: "peer_b" });
    await store.addMember(ROOM, joined("m_before"));
    await store.addMember(ROOM, joined("m_after"));
    await store.updateMember(ROOM, "m_before", { leftAt: Date.now() });
    await evictThroughTool("m_peer");
    const cutAt = (await store.getSession(ROOM))!.members.find((m) => m.memberId === "m_peer")!.leftAt!;
    // Leaves after the removal: still in, as far as the removed member may know.
    await store.updateMember(ROOM, "m_after", { leftAt: cutAt + 1_000 });
    const active = async (key: string) =>
      Object.fromEntries(((await bodyOf(await call(key, `/rooms/${ROOM}`))) as { members: { member_id: string; active: boolean }[] }).members.map((m) => [m.member_id, m.active]));
    expect(await active(DEV_KEY.peer)).toEqual({ m_creator: true, m_peer: false, m_before: false, m_after: true });
    expect(await active(DEV_KEY.jesse)).toEqual({ m_creator: true, m_peer: false, m_before: false, m_after: false });
  });

  // Removed, back on a fresh handle, removed again: the roster is as of the later removal, since the person read the
  // open room in between. The pauses keep the moments in distinct milliseconds, which is the unit the comparison is made in.
  it("serves a person with every handle removed the roster as of the latest removal", async () => {
    const pause = () => new Promise((resolve) => setTimeout(resolve, 10));
    await evictThroughTool("m_peer");
    await pause();
    await store.addMember(ROOM, member({ memberId: "m_peer2", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b" }));
    await pause();
    await evictThroughTool("m_peer2");
    await pause();
    await store.addMember(ROOM, member({ memberId: "m_late", userId: "u_late", label: "late@codenerd", roomRole: "peer_b" }));
    const body = await bodyOf(await call(DEV_KEY.peer, `/rooms/${ROOM}`)) as { members: { member_id: string }[] };
    expect(body.members.map((m) => m.member_id).sort()).toEqual(["m_creator", "m_peer", "m_peer2"]);
  });
});

/** Write one item through the tool, so the route's read has something to show. */
async function placeThroughTool(key: string, payload: Record<string, unknown>) {
  const h = new Harness(store, blobs);
  const jesse = await h.connect(DEV_KEY.jesse);
  const out = await jesse.call("bellman_send", { session_id: ROOM, member_id: "m_creator", type: "surface", payload: { key, ...payload } });
  await h.close();
  expect(out.isError, out.text).toBe(false);
  return out.data as { cursor: number };
}

/**
 * Remove a member the way the creator does, through the tool, so the room records the cut itself: the
 * `member_evicted` event's own cursor, written in the transaction that appends it. A removal cannot be
 * patched onto a record (`MemberPatch` leaves `removedAtCursor` out), and a fixture that set it by hand
 * would test the route against a cut no event carries.
 */
async function evictThroughTool(memberId: string) {
  const h = new Harness(store, blobs);
  const jesse = await h.connect(DEV_KEY.jesse);
  const out = await jesse.call("bellman_evict", { session_id: ROOM, member_id: memberId });
  await h.close();
  expect(out.isError, out.text).toBe(false);
}

describe("GET /rooms/:id/surface", () => {
  it("returns every item in an untrusted envelope, with the surface cursor as the ETag", async () => {
    const { cursor } = await placeThroughTool("plan", { kind: "text", body: "# Plan\nship it" });
    const res = (await call(DEV_KEY.peer, `/rooms/${ROOM}/surface`, { headers: { origin: PANEL } }))!;
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(`"${cursor}"`);
    // Exposed by name, or a cross-origin fetch in the panel cannot read it.
    expect(res.headers.get("access-control-expose-headers")).toBe("etag");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await bodyOf(res) as { surface_cursor: number; items: { trust: string; origin: { memberId: string }; data: { key: string; body: string } }[] };
    expect(body.surface_cursor).toBe(cursor);
    expect(body.items).toEqual([
      { trust: "untrusted", origin: { memberId: "m_creator", label: "jesse@codenerd" }, data: expect.objectContaining({ key: "plan", kind: "text", body: "# Plan\nship it", cursor }) },
    ]);
    expect(Object.keys(body).sort()).toEqual(["items", "surface_cursor"]);
  });

  it("answers 304 from the record alone when If-None-Match names the cursor, and 200 once a write moves it", async () => {
    const { cursor } = await placeThroughTool("plan", { kind: "text", body: "v1" });
    const reads = { n: 0 };
    const original = store.surfaceOf.bind(store);
    store.surfaceOf = async (id: string) => { reads.n++; return original(id); };
    const same = (await call(DEV_KEY.jesse, `/rooms/${ROOM}/surface`, { headers: { "if-none-match": `"${cursor}"` } }))!;
    expect(same.status).toBe(304);
    expect(same.headers.get("etag")).toBe(`"${cursor}"`);
    expect(await same.text()).toBe("");
    expect(reads.n).toBe(0);
    const next = await placeThroughTool("plan", { kind: "text", body: "v2" });
    const moved = (await call(DEV_KEY.jesse, `/rooms/${ROOM}/surface`, { headers: { "if-none-match": `"${cursor}"` } }))!;
    expect(moved.status).toBe(200);
    expect(moved.headers.get("etag")).toBe(`"${next.cursor}"`);
  });

  it("matches a weak validator and a list, and treats garbage as a miss, never a throw", async () => {
    const { cursor } = await placeThroughTool("plan", { kind: "text", body: "v1" });
    for (const header of [`W/"${cursor}"`, `"1", "${cursor}"`, "*"]) {
      const res = (await call(DEV_KEY.jesse, `/rooms/${ROOM}/surface`, { headers: { "if-none-match": header } }))!;
      expect(res.status, header).toBe(304);
    }
    for (const header of ["garbage", `"${cursor + 1}"`, ""]) {
      const res = (await call(DEV_KEY.jesse, `/rooms/${ROOM}/surface`, { headers: { "if-none-match": header } }))!;
      expect(res.status, header).toBe(200);
    }
  });

  it("answers an empty surface with cursor 0 and an ETag of \"0\"", async () => {
    const res = (await call(DEV_KEY.jesse, `/rooms/${ROOM}/surface`))!;
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe('"0"');
    expect(await bodyOf(res)).toEqual({ surface_cursor: 0, items: [] });
  });

  it("stops a removed member at its cut, and derives the cursor from what it is shown", async () => {
    const first = await placeThroughTool("a", { kind: "text", body: "before" });
    await evictThroughTool("m_peer");
    await placeThroughTool("b", { kind: "text", body: "after" });
    const res = (await call(DEV_KEY.peer, `/rooms/${ROOM}/surface`))!;
    const body = await bodyOf(res) as { surface_cursor: number; items: { data: { key: string } }[] };
    expect(body.items.map((i) => i.data.key)).toEqual(["a"]);
    expect(body.surface_cursor).toBe(first.cursor);
    expect(res.headers.get("etag")).toBe(`"${first.cursor}"`);
  });

  it("does not cut a person while one of their handles is still in the room", async () => {
    await placeThroughTool("a", { kind: "text", body: "before" });
    await evictThroughTool("m_peer");
    await placeThroughTool("b", { kind: "text", body: "after" });
    await store.addMember(ROOM, member({ memberId: "m_peer2", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b" }));
    const body = await bodyOf(await call(DEV_KEY.peer, `/rooms/${ROOM}/surface`)) as { items: { data: { key: string } }[] };
    expect(body.items.map((i) => i.data.key)).toEqual(["a", "b"]);
  });

  it("answers one 404 for a stranger and an unknown room", async () => {
    expect((await call(DEV_KEY.outsider, `/rooms/${ROOM}/surface`))!.status).toBe(404);
    expect((await call(DEV_KEY.jesse, "/rooms/qs_nope/surface"))!.status).toBe(404);
  });

  // The first write in a fresh room is cursor 1, which makes the list in the weak-validator test above one
  // value twice: it passes if only the first validator is read. Here the match is never first.
  it("finds the cursor anywhere in a list of validators", async () => {
    const { cursor } = await placeThroughTool("plan", { kind: "text", body: "v1" });
    for (const header of [`"${cursor + 1}", "${cursor}"`, `"${cursor + 1}", W/"${cursor}", "${cursor + 2}"`]) {
      const res = (await call(DEV_KEY.jesse, `/rooms/${ROOM}/surface`, { headers: { "if-none-match": header } }))!;
      expect(res.status, header).toBe(304);
    }
  });

  it("carries the CORS headers and no-store on a 304, as on the 200", async () => {
    const { cursor } = await placeThroughTool("plan", { kind: "text", body: "v1" });
    const res = (await call(DEV_KEY.jesse, `/rooms/${ROOM}/surface`, { headers: { origin: PANEL, "if-none-match": `"${cursor}"` } }))!;
    expect(res.status).toBe(304);
    expect(res.headers.get("access-control-allow-origin")).toBe(PANEL);
    expect(res.headers.get("access-control-expose-headers")).toBe("etag");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  // A 304 on the record's cursor would tell a removed member that the surface changed after it was out, which
  // is the one thing its cursor is derived from the rows to avoid saying.
  it("answers a removed member's conditional read from what it is shown, never from the record", async () => {
    const first = await placeThroughTool("a", { kind: "text", body: "before" });
    await evictThroughTool("m_peer");
    const last = await placeThroughTool("b", { kind: "text", body: "after" });
    const asked = (await call(DEV_KEY.peer, `/rooms/${ROOM}/surface`, { headers: { "if-none-match": `"${last.cursor}"` } }))!;
    expect(asked.status).toBe(200);
    expect(asked.headers.get("etag")).toBe(`"${first.cursor}"`);
    const shown = (await call(DEV_KEY.peer, `/rooms/${ROOM}/surface`, { headers: { "if-none-match": `"${first.cursor}"` } }))!;
    expect(shown.status).toBe(304);
    expect(shown.headers.get("etag")).toBe(`"${first.cursor}"`);
  });

  it("does not cut a member who left of its own accord", async () => {
    await placeThroughTool("a", { kind: "text", body: "before" });
    await store.updateMember(ROOM, "m_peer", { leftAt: Date.now() });
    await placeThroughTool("b", { kind: "text", body: "after" });
    const body = await bodyOf(await call(DEV_KEY.peer, `/rooms/${ROOM}/surface`)) as { items: { data: { key: string } }[] };
    expect(body.items.map((i) => i.data.key)).toEqual(["a", "b"]);
  });

  // Removed, back on a fresh handle, removed again: the person read the open feed in between, so the cut is the
  // latest one. Taking the earliest would hide what the second handle was entitled to see.
  it("cuts a person with every handle removed at the latest cut", async () => {
    await placeThroughTool("a", { kind: "text", body: "first" });
    await evictThroughTool("m_peer");
    await store.addMember(ROOM, member({ memberId: "m_peer2", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b" }));
    await placeThroughTool("b", { kind: "text", body: "second" });
    await evictThroughTool("m_peer2");
    await placeThroughTool("c", { kind: "text", body: "third" });
    const body = await bodyOf(await call(DEV_KEY.peer, `/rooms/${ROOM}/surface`)) as { items: { data: { key: string } }[] };
    expect(body.items.map((i) => i.data.key)).toEqual(["a", "b"]);
  });

  it("refuses without a credential, with CORS on the refusal, and answers 405 to a method it does not take", async () => {
    const anonymous = (await call(null, `/rooms/${ROOM}/surface`, { headers: { origin: PANEL } }))!;
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("access-control-allow-origin")).toBe(PANEL);
    expect(await bodyOf(anonymous)).toMatchObject({ error: "unauthorized" });
    const post = (await call(DEV_KEY.jesse, `/rooms/${ROOM}/surface`, { method: "POST", body: {} }))!;
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
  });
});

const put = (key: string | null, itemKey: string, body: unknown, over: CallOptions & { member?: string | null; room?: string } = {}) => {
  const q = over.member === null ? "" : `?member_id=${over.member ?? "m_creator"}`;
  return call(key, `/rooms/${over.room ?? ROOM}/surface/${itemKey}${q}`, { method: "PUT", body, ...over });
};
const del = (key: string | null, itemKey: string, over: CallOptions & { member?: string | null } = {}) => {
  const q = over.member === null ? "" : `?member_id=${over.member ?? "m_creator"}`;
  return call(key, `/rooms/${ROOM}/surface/${itemKey}${q}`, { method: "DELETE", ...over });
};

/** The surface as the tool reads it, for the agreement tests. */
async function surfaceThroughTool(key: string, memberId: string) {
  const h = new Harness(store, blobs);
  const p = await h.connect(key);
  const out = await p.call("bellman_sync", { session_id: ROOM, member_id: memberId, since_cursor: 0, wait_seconds: 0, surface: true });
  await h.close();
  return out.data as { surface?: { cursor: number; items: unknown[] }; surface_cursor?: number };
}

describe("PUT and DELETE /rooms/:id/surface/:key", () => {
  it("writes an item through the route, and the tool reads back exactly what the route reads", async () => {
    const res = (await put(DEV_KEY.jesse, "plan", { kind: "text", title: "Plan", body: "ship it", placement: { x: 10, y: 20 } }))!;
    expect(res.status, await res.clone().text()).toBe(200);
    const out = await bodyOf(res) as { cursor: number; room_members: string[] };
    expect(out.room_members).toEqual(["peer@codenerd"]);
    const viaRoute = await bodyOf(await call(DEV_KEY.peer, `/rooms/${ROOM}/surface`)) as { surface_cursor: number; items: unknown[] };
    const viaTool = await surfaceThroughTool(DEV_KEY.peer, "m_peer");
    expect(viaRoute.items).toEqual(viaTool.surface!.items);
    expect(viaRoute.surface_cursor).toBe(viaTool.surface_cursor);
    expect(viaRoute.surface_cursor).toBe(out.cursor);
  });

  it("reads back through the route what the tool wrote, and replaces by key", async () => {
    await placeThroughTool("plan", { kind: "text", body: "v1" });
    const res = (await put(DEV_KEY.jesse, "plan", { kind: "text", body: "v2" }))!;
    expect(res.status).toBe(200);
    const body = await bodyOf(await call(DEV_KEY.jesse, `/rooms/${ROOM}/surface`)) as { items: { data: { key: string; body: string } }[] };
    expect(body.items.map((i) => [i.data.key, i.data.body])).toEqual([["plan", "v2"]]);
  });

  it("removes an item, and the tool no longer sees it", async () => {
    await placeThroughTool("plan", { kind: "text", body: "v1" });
    const res = (await del(DEV_KEY.jesse, "plan"))!;
    expect(res.status).toBe(200);
    expect((await surfaceThroughTool(DEV_KEY.jesse, "m_creator")).surface!.items).toEqual([]);
  });

  // The commit's claim is that the audit row cannot differ by transport; this is the row the tool test pins
  // (tests/tools/working-surface.test.ts), read after the route wrote it.
  it("leaves the audit row the tool leaves, for a write and for a removal", async () => {
    expect((await put(DEV_KEY.jesse, "plan", { kind: "text", body: "ship it" }))!.status).toBe(200);
    expect((await store.auditForOrg("org_codenerd", 50)).at(-1)).toMatchObject({
      action: "sent_surface", actorUserId: "u_jesse", detail: { key: "plan", kind: "text", chars: 7 },
    });
    expect((await del(DEV_KEY.jesse, "plan"))!.status).toBe(200);
    expect((await store.auditForOrg("org_codenerd", 50)).at(-1)).toMatchObject({
      action: "sent_surface", detail: { key: "plan", removed: true },
    });
  });

  it("refuses a seat without the verb, and the log is unchanged", async () => {
    const before = (await store.eventsAfter(ROOM, 0)).length;
    const res = (await put(DEV_KEY.peer, "plan", { kind: "text", body: "mine" }, { member: "m_peer" }))!;
    expect(res.status).toBe(403);
    expect(await bodyOf(res)).toMatchObject({ error: "forbidden" });
    expect((await store.eventsAfter(ROOM, 0)).length).toBe(before);
    expect(await store.surfaceOf(ROOM)).toEqual([]);
  });

  it("answers 404 for a handle that is not the caller's, before any gate", async () => {
    const res = (await put(DEV_KEY.peer, "plan", { kind: "text", body: "x" }, { member: "m_creator" }))!;
    expect(res.status).toBe(404);
  });

  it("requires member_id", async () => {
    const res = (await put(DEV_KEY.jesse, "plan", { kind: "text", body: "x" }, { member: null }))!;
    expect(res.status).toBe(400);
    expect(await bodyOf(res)).toMatchObject({ error_description: expect.stringContaining("member_id") });
  });

  it("maps the operation's refusals to statuses: invalid is 400, a frozen room is 409", async () => {
    const invalid = (await put(DEV_KEY.jesse, "plan", { kind: "link", body: "not a url" }))!;
    expect(invalid.status).toBe(400);
    expect(await bodyOf(invalid)).toMatchObject({ error: "invalid", error_description: expect.stringContaining("http") });
    await store.freezeSession(ROOM, Date.now());
    const frozen = (await put(DEV_KEY.jesse, "plan", { kind: "text", body: "x" }))!;
    expect(frozen.status).toBe(409);
    expect(await bodyOf(frozen)).toMatchObject({ error: "frozen" });
  });

  // A member who has left is the seat's 403 through the gate, not the 404 a handle that is not the caller's gets.
  it("refuses a write from a member who has left with the gate's 403", async () => {
    await store.updateMember(ROOM, "m_creator", { leftAt: Date.now() });
    const res = (await put(DEV_KEY.jesse, "plan", { kind: "text", body: "x" }))!;
    expect(res.status).toBe(403);
    expect(await bodyOf(res)).toMatchObject({ error: "forbidden" });
    expect(await store.surfaceOf(ROOM)).toEqual([]);
  });

  it("refuses a write to a closed room with 409 closed", async () => {
    await store.closeSession(ROOM);
    const res = (await put(DEV_KEY.jesse, "plan", { kind: "text", body: "x" }))!;
    expect(res.status).toBe(409);
    expect(await bodyOf(res)).toMatchObject({ error: "closed" });
    expect(await store.surfaceOf(ROOM)).toEqual([]);
  });

  it("refuses a body that is not a JSON object with the route's own 400", async () => {
    for (const rawBody of ["not json", "[1,2]", '"text"', ""]) {
      const res = (await call(DEV_KEY.jesse, `/rooms/${ROOM}/surface/plan?member_id=m_creator`, { method: "PUT", rawBody }))!;
      expect(res.status, JSON.stringify(rawBody)).toBe(400);
      expect(await bodyOf(res)).toMatchObject({ error: "invalid_request" });
    }
    expect(await store.surfaceOf(ROOM)).toEqual([]);
  });

  // `normalizeSurfaceWrite` takes the removal arm on the key's presence, so without this a PUT would delete, and a mixed
  // body would get the removal arm's strict-object error instead of an answer that says what is wrong.
  it("refuses a PUT body that carries the removal marker, alone or beside an item, and removes nothing", async () => {
    await placeThroughTool("plan", { kind: "text", body: "v1" });
    for (const body of [{ remove: true }, { kind: "text", body: "v2", remove: true }]) {
      const res = (await put(DEV_KEY.jesse, "plan", body))!;
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await bodyOf(res)).toMatchObject({ error: "invalid_request", error_description: expect.stringContaining("DELETE") });
    }
    expect((await store.surfaceOf(ROOM)).map((r) => r.body)).toEqual(["v1"]);
  });

  it("refuses a body whose key disagrees with the path, and accepts one that agrees", async () => {
    const clash = (await put(DEV_KEY.jesse, "plan", { key: "other", kind: "text", body: "x" }))!;
    expect(clash.status).toBe(400);
    const same = (await put(DEV_KEY.jesse, "plan", { key: "plan", kind: "text", body: "x" }))!;
    expect(same.status).toBe(200);
  });

  it("refuses a key the grammar refuses with the operation's 400, a malformed escape with 400, and an unknown deeper path with 404", async () => {
    const bad = (await put(DEV_KEY.jesse, "-bad", { kind: "text", body: "x" }))!;
    expect(bad.status).toBe(400);
    const slash = (await put(DEV_KEY.jesse, "a%2Fb", { kind: "text", body: "x" }))!;
    expect(slash.status).toBe(400);
    const escape = (await put(DEV_KEY.jesse, "%E0%A4%A", { kind: "text", body: "x" }))!;
    expect(escape.status).toBe(400);
    const deeper = (await call(DEV_KEY.jesse, `/rooms/${ROOM}/surface/plan/more?member_id=m_creator`, { method: "PUT", body: {} }))!;
    expect(deeper.status).toBe(404);
  });

  // The malformed escape above is a 400 whether or not the path is decoded, since the raw form fails the grammar
  // too; only a key that is valid once decoded can tell the two apart.
  it("takes a percent-encoded key as the key it spells", async () => {
    const res = (await put(DEV_KEY.jesse, "p%6Can", { kind: "text", body: "x" }))!;
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await store.surfaceOf(ROOM)).map((r) => r.key)).toEqual(["plan"]);
  });

  // The malformed escape is decided from the path alone and leaks nothing, but it is still a branch an unauthenticated
  // caller should not reach: the answer to a stranger is the 401 every other route gives.
  it("answers a malformed escape with 401 to a caller who has not signed in, and 400 to one who has", async () => {
    const anonymous = (await put(null, "%E0%A4%A", { kind: "text", body: "x" }))!;
    expect(anonymous.status).toBe(401);
    const signedIn = (await put(DEV_KEY.jesse, "%E0%A4%A", { kind: "text", body: "x" }))!;
    expect(signedIn.status).toBe(400);
    expect(await bodyOf(signedIn)).toMatchObject({ error: "invalid_request", error_description: expect.stringContaining("percent-encoding") });
  });

  it("refuses a body over MAX_SURFACE_WRITE_BYTES from its Content-Length, unparsed", async () => {
    const res = (await put(DEV_KEY.jesse, "plan", { kind: "text", body: "x" }, { headers: { "content-length": String(64 * 1024 + 1) } }))!;
    expect(res.status).toBe(413);
  });

  // A length that is present and is not a digit string is the client's mistake. `Number` would read each of these as NaN,
  // -5 or 1000 and pass them under the bound, so the body would be parsed and written; none of them is a length.
  it("refuses a Content-Length that is not a non-negative integer, before the body is read", async () => {
    for (const length of ["garbage", "-5", "1e3"]) {
      const res = (await put(DEV_KEY.jesse, "plan", { kind: "text", body: "x" }, { headers: { "content-length": length } }))!;
      expect(res.status, length).toBe(400);
      expect(await bodyOf(res), length).toMatchObject({ error: "invalid_request", error_description: "Content-Length must be a non-negative integer" });
    }
    expect(await store.surfaceOf(ROOM)).toEqual([]);
  });

  // The test above would pass if the body were parsed first and the size checked after: both orders answer 413
  // for a valid body. A body that is not JSON tells them apart, since parsed first it is the body's 400.
  it("decides the size from the header before the body is parsed, and takes a body exactly at the bound", async () => {
    const over = (await call(DEV_KEY.jesse, `/rooms/${ROOM}/surface/plan?member_id=m_creator`, {
      method: "PUT", rawBody: "not json", headers: { "content-length": String(MAX_SURFACE_WRITE_BYTES + 1) },
    }))!;
    expect(over.status).toBe(413);
    expect(await bodyOf(over)).toMatchObject({ error: "too_large" });
    const at = (await put(DEV_KEY.jesse, "plan", { kind: "text", body: "x" }, { headers: { "content-length": String(MAX_SURFACE_WRITE_BYTES) } }))!;
    expect(at.status).toBe(200);
  });

  // The Origin check runs ahead of `writeSurface`, whose gate touches the caller's lastSeenAt: a forged request
  // writes nothing at all, not even a liveness stamp. The seat starts stale because touchMember skips one seen
  // within half the window, so a fresh fixture would read "unchanged" whatever the order of the two.
  it("refuses a cookie write without the panel's Origin before touching the seat, and takes one with it", async () => {
    const stale = Date.now() - 2 * STALE_AFTER_MS;
    await store.updateMember(ROOM, "m_creator", { lastSeenAt: stale });
    const lastSeen = async () =>
      (await store.getSession(ROOM))!.members.find((m) => m.memberId === "m_creator")!.lastSeenAt;
    expect(await lastSeen(), "the seat starts stale").toBe(stale);
    const forged = (await put(null, "plan", { kind: "text", body: "x" }, { cookie: DEV_KEY.jesse }))!;
    expect([forged.status, await lastSeen()], "no Origin: refused, and the seat as it was").toEqual([403, stale]);
    const offList = (await put(null, "plan", { kind: "text", body: "x" }, { cookie: DEV_KEY.jesse, headers: { origin: "https://evil.example" } }))!;
    expect([offList.status, await lastSeen()], "an off-list Origin: refused, and the seat as it was").toEqual([403, stale]);
    const gone = (await del(null, "plan", { cookie: DEV_KEY.jesse }))!;
    expect([gone.status, await lastSeen()], "a DELETE with no Origin: refused, and the seat as it was").toEqual([403, stale]);
    expect(await store.surfaceOf(ROOM)).toEqual([]);
    // The control: the same stale seat with the panel's Origin is served, and touched, so "unchanged" above means something.
    const real = (await put(null, "plan", { kind: "text", body: "x" }, { cookie: DEV_KEY.jesse, headers: { origin: PANEL } }))!;
    expect(real.status).toBe(200);
    expect(await lastSeen()).toBeGreaterThan(stale);
  });

  it("answers the preflight for a PUT", async () => {
    const pre = (await call(null, `/rooms/${ROOM}/surface/plan`, { method: "OPTIONS", headers: { origin: PANEL } }))!;
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-methods")).toContain("PUT");
    expect(pre.headers.get("access-control-allow-headers")).toContain("if-none-match");
  });

  it("refuses without a credential, with CORS on the refusal, and answers 405 to the methods it does not take", async () => {
    const anonymous = (await put(null, "plan", { kind: "text", body: "x" }, { headers: { origin: PANEL } }))!;
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("access-control-allow-origin")).toBe(PANEL);
    expect(await bodyOf(anonymous)).toMatchObject({ error: "unauthorized" });
    for (const method of ["GET", "POST", "PATCH"]) {
      const res = (await call(DEV_KEY.jesse, `/rooms/${ROOM}/surface/plan?member_id=m_creator`, { method }))!;
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow"), method).toBe("PUT, DELETE");
    }
  });

  // The blob route and this one meet here: nothing else threads the route's blob store into the operation, and
  // an item that names a blob is the only write that reads it.
  it("places a blob uploaded through the blob route, and the read carries the object's own metadata", async () => {
    const uploaded = (await roomRoutes(new Request(`${ISSUER}/rooms/${ROOM}/blobs?member_id=m_creator&name=notes.txt`, {
      method: "POST",
      headers: { authorization: `Bearer ${DEV_KEY.jesse}`, "content-type": "text/plain", "content-length": "5" },
      body: "hello",
    }), deps))!;
    expect(uploaded.status, await uploaded.clone().text()).toBe(201);
    const { blob_id } = (await uploaded.json()) as { blob_id: string };
    const placed = (await put(DEV_KEY.jesse, "notes", { kind: "file", blob: { id: blob_id } }))!;
    expect(placed.status, await placed.clone().text()).toBe(200);
    const body = await bodyOf(await call(DEV_KEY.peer, `/rooms/${ROOM}/surface`)) as { items: { data: { blob: unknown } }[] };
    expect(body.items[0].data.blob).toEqual({ id: blob_id, bytes: 5, type: "text/plain", name: "notes.txt" });
  });
});
