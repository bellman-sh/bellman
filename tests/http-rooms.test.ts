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
import { MAX_ROOMS_LISTED, roomRoutes, type RoomCaller, type RoomRouteDeps } from "../src/http/rooms.js";
import { MemoryStore } from "../src/store.js";
import { member, session } from "./helpers/fixtures.js";
import { DEV_KEY } from "./helpers/harness.js";

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
    const { rooms } = (await res.json()) as { rooms: { id: string; mine: boolean; members: number; status: string; mode: string; expires_at: string }[] };
    const ids = rooms.map((r) => r.id).sort();
    expect(ids).toEqual(["qs_joined", ROOM]);
    expect(rooms.find((r) => r.id === ROOM)).toMatchObject({ mine: true, members: 2, status: "active", mode: "pair" });
    expect(rooms.find((r) => r.id === "qs_joined")).toMatchObject({ mine: false });
    expect(Date.parse(rooms[0].expires_at)).toBeGreaterThan(Date.now());
    expect(Object.keys(rooms[0]).sort()).toEqual(["expires_at", "id", "members", "mine", "mode", "room", "status"]);
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
});
