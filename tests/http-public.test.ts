/**
 * The public reads (public rooms spec D3, D4): a room marked public, read with no
 * credential by anyone with its link. Driven as tests/http-rooms.test.ts drives the
 * member routes, a web Request in and a Response out over MemoryStore and
 * MemoryBlobStore, with the member routes beside them for the writes a case needs.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resolveIdentity } from "../src/auth.js";
import { MemoryBlobStore } from "../src/blobs.js";
import { publicRoutes } from "../src/http/public.js";
import { MAX_EVENTS_READ, roomRoutes, type RoomRouteDeps } from "../src/http/rooms.js";
import { storedMember } from "../src/projections.js";
import { MemoryStore } from "../src/store.js";
import type { EventType, Member, Session } from "../src/types.js";
import { brief, member, roomManifest, session } from "./helpers/fixtures.js";
import { DEV_KEY } from "./helpers/harness.js";

const ISSUER = "https://mcp.example.test";
const PUB = "qs_public";
const NOT_PUBLIC = { error: "not_found", error_description: "no such public room" };

let store: MemoryStore;
let blobs: MemoryBlobStore;
let members: RoomRouteDeps;

const peer = () => member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b" });
const publicRoom = (over: Partial<Session> = {}) => session({
  id: PUB, manifest: roomManifest({ public: true, room: "Open review", purpose: "Read along" }), members: [member(), peer()], ...over,
});

beforeEach(async () => {
  store = new MemoryStore();
  blobs = new MemoryBlobStore();
  members = {
    store, blobs, panelOrigins: [],
    caller: async (request) => {
      const identity = resolveIdentity(request.headers.get("authorization") ?? undefined);
      return identity ? { identity, via: "bearer" as const } : null;
    },
  };
  await store.createSession(publicRoom());
});

/** A public read: no credential unless a case adds one, from an origin nobody listed. */
const read = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  publicRoutes(new Request(`${ISSUER}${path}`, { method, headers: { origin: "https://anywhere.example.test", ...headers } }), { store, blobs });
const bodyOf = async (res: Response | undefined) => (await res!.json()) as Record<string, unknown>;

/** A write as the creator, who holds write_surface, through the member routes. */
const asCreator = (path: string, init: RequestInit = {}) => roomRoutes(new Request(`${ISSUER}${path}`, {
  ...init, headers: { authorization: `Bearer ${DEV_KEY.jesse}`, ...(init.headers as Record<string, string> | undefined) },
}), members);
const placeFile = (key: string, blobId: string) => asCreator(`/rooms/${PUB}/surface/${key}?member_id=m_creator`, {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "file", blob: { id: blobId } }),
});
const upload = async (name: string) => {
  const res = (await asCreator(`/rooms/${PUB}/blobs?member_id=m_creator&name=${name}`, {
    method: "POST", headers: { "content-type": "text/plain", "content-length": "5" }, body: "hello",
  }))!;
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { blob_id: string }).blob_id;
};
const say = async (from: Member, type: EventType, payload: unknown) => {
  const e = await store.appendEvent(PUB, { type, fromMemberId: from.memberId, fromUserId: from.userId, fromLabel: from.label, payload, refId: null });
  expect(e).not.toBeNull();
  return e!;
};

describe("GET /public/rooms/:id", () => {
  it("answers a public room to anyone with no credential, every origin and no credentials grant", async () => {
    const res = (await read(`/public/rooms/${PUB}`))!;
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    const body = await bodyOf(res);
    expect(Object.keys(body).sort()).toEqual(["closed_at", "id", "mode", "status", "text"]);
    expect(body).toMatchObject({ id: PUB, status: "active", closed_at: null, mode: "pair" });
    expect(body.text).toEqual({
      trust: "untrusted", origin: { memberId: "m_creator", label: "jesse@codenerd" }, data: { room: "Open review", purpose: "Read along" },
    });
  });

  it("answers a private, an unpublished, an unknown and a purged room, and their sub-routes, with one 404", async () => {
    await store.createSession(session({ id: "qs_private", members: [member()] }));
    await store.createSession(publicRoom({ id: "qs_unpublished" }));
    await store.unpublishSession("qs_unpublished", Date.now());
    await store.createSession(publicRoom({ id: "qs_purged", closed: true, closedAt: Date.now() - 1_000, joinCodes: {} }));
    await store.schedulePurge("qs_purged", Date.now(), "u_jesse");
    await store.sweep(Date.now());
    for (const id of ["qs_private", "qs_unpublished", "qs_nope", "qs_purged"]) {
      for (const sub of ["", "/surface", "/events", `/blobs/${"a".repeat(32)}`]) {
        const res = (await read(`/public/rooms/${id}${sub}`))!;
        expect(res.status, `${id}${sub}`).toBe(404);
        expect(await bodyOf(res), `${id}${sub}`).toEqual(NOT_PUBLIC);
      }
    }
  });

  // Review Focus 4.
  it("opens nothing for a member's credential: a private room is the same 404 with a bearer", async () => {
    await store.createSession(session({ id: "qs_private", members: [member()] }));
    const res = (await read("/public/rooms/qs_private", { authorization: `Bearer ${DEV_KEY.jesse}` }))!;
    expect([res.status, await bodyOf(res)]).toEqual([404, NOT_PUBLIC]);
  });

  it("still reads a closed public room until its purge", async () => {
    const at = Date.parse("2026-10-09T12:00:00Z");
    await store.createSession(publicRoom({ id: "qs_closed_public", closed: true, closedAt: at, joinCodes: {} }));
    expect(await bodyOf(await read("/public/rooms/qs_closed_public"))).toMatchObject({ status: "closed", closed_at: "2026-10-09T12:00:00.000Z" });
  });
});

describe("GET /public/rooms/:id/surface", () => {
  it("answers the items as members read them, the surface cursor as an ETag a page can read, and 304 on a match", async () => {
    const put = (await asCreator(`/rooms/${PUB}/surface/plan?member_id=m_creator`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "text", title: "The plan", body: "hello" }),
    }))!;
    expect(put.status, await put.clone().text()).toBe(200);
    const res = (await read(`/public/rooms/${PUB}/surface`))!;
    expect([res.status, res.headers.get("access-control-expose-headers")]).toEqual([200, "etag"]);
    const tag = res.headers.get("etag")!;
    const body = (await res.json()) as { surface_cursor: number; items: { origin: unknown; data: { key: string } }[] };
    expect(tag).toBe(`"${body.surface_cursor}"`);
    expect(body.items.map((i) => i.data.key)).toEqual(["plan"]);
    expect(body.items[0].origin).toEqual({ memberId: "m_creator", label: "jesse@codenerd" });
    const again = (await read(`/public/rooms/${PUB}/surface`, { "if-none-match": tag }))!;
    expect([again.status, again.headers.get("etag"), again.headers.get("access-control-allow-origin")]).toEqual([304, tag, "*"]);
  });
});

describe("GET /public/rooms/:id/events", () => {
  interface Read { events: { origin: unknown; data: { cursor: number; type: string; payload: unknown } }[]; cursor: number }
  const events = async (query = "") => (await bodyOf(await read(`/public/rooms/${PUB}/events${query}`))) as unknown as Read;

  it("reads the log as members do, less every brief: no brief_update, and a joiner as its id, label and seat", async () => {
    await say(member(), "message", { text: "hello" });
    await say(peer(), "member_joined", { member: { ...storedMember(peer()), later: "x" }, brief: brief(), extra: "y" });
    await say(peer(), "brief_update", brief());
    const out = await events();
    expect(out.events.map((e) => e.data.type)).toEqual(["message", "member_joined"]);
    expect(out.events[0].origin).toEqual({ memberId: "m_creator", label: "jesse@codenerd" });
    expect(out.events[1].data.payload).toEqual({ member: { member_id: "m_peer", label: "peer@codenerd", room_role: "peer_b" } });
    expect(JSON.stringify(out)).not.toContain(brief().goal);
  });

  // Review Focus 2.
  it("names a joiner's fields null where a payload of another shape has none, and shows nothing else", async () => {
    await say(peer(), "member_joined", { member_id: "m_peer", brief: brief() });
    await say(peer(), "member_joined", { member: { member_id: 7, label: { goal: "x" }, room_role: "peer_b" } });
    expect((await events()).events.map((e) => e.data.payload)).toEqual([
      { member: { member_id: null, label: null, room_role: null } },
      { member: { member_id: null, label: null, room_role: "peer_b" } },
    ]);
  });

  // Review Focus 1.
  it("moves its cursor past a page of nothing but briefs, so a poll is never stuck on one", async () => {
    const first = await say(member(), "message", { text: "before" });
    for (let i = 0; i < 3; i++) await say(peer(), "brief_update", brief());
    const out = await events(`?after=${first.cursor}`);
    expect(out).toEqual({ events: [], cursor: first.cursor + 3 });
  });

  it("reads the newest MAX_EVENTS_READ, the earliest past ?after, and refuses a cursor that is not one", async () => {
    for (let i = 0; i < MAX_EVENTS_READ + 5; i++) await say(member(), "message", { text: `m${i}` });
    const text = (e: Read["events"][number]) => (e.data.payload as { text: string }).text;
    const newest = await events();
    expect([newest.events.length, text(newest.events.at(-1)!)]).toEqual([MAX_EVENTS_READ, `m${MAX_EVENTS_READ + 4}`]);
    const earliest = await events("?after=0");
    expect([earliest.events.length, text(earliest.events[0]), earliest.cursor]).toEqual([MAX_EVENTS_READ, "m0", earliest.events.at(-1)!.data.cursor]);
    expect((await read(`/public/rooms/${PUB}/events?after=-1`))!.status).toBe(400);
  });
});

describe("GET /public/rooms/:id/blobs/:blobId", () => {
  it("serves a blob an item on the surface names, under the member download's headers, to anyone", async () => {
    const id = await upload("notes.txt");
    expect((await placeFile("notes", id))!.status).toBe(200);
    const res = (await read(`/public/rooms/${PUB}/blobs/${id}`))!;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    const h = (name: string) => res.headers.get(name);
    expect([h("access-control-allow-origin"), h("x-content-type-options"), h("content-security-policy"), h("content-type")])
      .toEqual(["*", "nosniff", "sandbox", "application/octet-stream"]);
    expect(h("content-disposition")).toContain("attachment");
  });

  // Review Focus 3.
  it("keeps a blob no item names the members': one never placed, and one whose item was removed", async () => {
    const never = await upload("draft.txt");
    const gone = await upload("old.txt");
    expect((await placeFile("old", gone))!.status).toBe(200);
    expect((await asCreator(`/rooms/${PUB}/surface/old?member_id=m_creator`, { method: "DELETE" }))!.ok).toBe(true);
    for (const id of [never, gone, "not-a-blob-id"]) {
      const res = (await read(`/public/rooms/${PUB}/blobs/${id}`))!;
      expect([res.status, await bodyOf(res)], id).toEqual([404, { error: "not_found", error_description: "no such blob" }]);
    }
  });
});

describe("the public routes", () => {
  it("answer a preflight from any origin, letting a page send If-None-Match", async () => {
    const res = (await read(`/public/rooms/${PUB}/surface`, { "access-control-request-method": "GET", "access-control-request-headers": "if-none-match" }, "OPTIONS"))!;
    const h = (name: string) => res.headers.get(name);
    expect([res.status, h("access-control-allow-origin"), h("access-control-allow-methods"), h("access-control-allow-headers")])
      .toEqual([204, "*", "GET", "if-none-match"]);
  });

  it("take GET alone, answer a path they do not know, and leave every other path to the next module", async () => {
    const post = (await read(`/public/rooms/${PUB}`, {}, "POST"))!;
    expect([post.status, post.headers.get("allow")]).toEqual([405, "GET"]);
    expect(await bodyOf(await read("/public/elsewhere"))).toEqual({ error: "not_found", error_description: "no such route" });
    expect(await read(`/rooms/${PUB}`)).toBeUndefined();
    expect(await read("/publicity")).toBeUndefined();
  });
});
