/**
 * The public reads (public rooms spec D3, D4): a room marked public, read with no
 * credential by anyone with its link. Driven as tests/http-rooms.test.ts drives the
 * member routes, a web Request in and a Response out over MemoryStore and
 * MemoryBlobStore, with the member routes beside them for the writes a case needs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveIdentity } from "../src/auth.js";
import { MemoryBlobStore } from "../src/blobs.js";
import { HOST_LABEL, HOST_MEMBER_ID, HOST_USER_ID, hostMember } from "../src/host.js";
import { publicRoutes } from "../src/http/public.js";
import { MAX_EVENTS_READ, roomRoutes, type RoomRouteDeps } from "../src/http/rooms.js";
import { resolveManifest } from "../src/manifest.js";
import { storedMember } from "../src/projections.js";
import { MemoryStore } from "../src/store.js";
import type { EventType, Member, Session } from "../src/types.js";
import { brief, jesseActor, member, roomManifest, session } from "./helpers/fixtures.js";
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
    expect(Object.keys(body).sort()).toEqual(["by", "closed_at", "id", "mode", "preset", "public_url", "status", "text", "view"]);
    expect(body).toMatchObject({
      id: PUB, status: "active", closed_at: null, mode: "pair", view: "canvas", by: null, public_url: "https://bellman.sh/r/qs_public",
    });
    expect(body.text).toEqual({
      trust: "untrusted", origin: { memberId: "m_creator", label: "member 1" }, data: { room: "Open review", purpose: "Read along" },
    });
  });

  it("carries how the room opens, the canvas until its creator chooses the page", async () => {
    expect((await bodyOf(await read(`/public/rooms/${PUB}`))).view).toBe("canvas");
    await store.setPublicView(PUB, "page");
    expect((await bodyOf(await read(`/public/rooms/${PUB}`))).view).toBe("page");
  });

  // Topic rooms spec, R4 and R5.
  it("names the room's preset, null for a room that cites none, and a topic room opens as a page", async () => {
    expect((await bodyOf(await read(`/public/rooms/${PUB}`))).preset).toBe("pair");
    await store.createSession(publicRoom({
      id: "qs_topic", manifest: roomManifest({ ...resolveManifest({ room: "mcp", preset: "topic", public: true }) }), publicView: "page",
    }));
    expect(await bodyOf(await read("/public/rooms/qs_topic"))).toMatchObject({ preset: "topic", view: "page", mode: "swarm" });
    await store.createSession(publicRoom({ id: "qs_authored", manifest: roomManifest({ public: true, preset: null }) }));
    expect((await bodyOf(await read("/public/rooms/qs_authored"))).preset).toBeNull();
  });

  it("answers a private, an unpublished, an unknown and a purged room, and their sub-routes, with one 404", async () => {
    await store.createSession(session({ id: "qs_private", members: [member()] }));
    await store.createSession(publicRoom({ id: "qs_unpublished" }));
    await store.unpublishSession("qs_unpublished", Date.now());
    await store.createSession(publicRoom({ id: "qs_purged", closed: true, closedAt: Date.now() - 1_000, joinCodes: {} }));
    await store.schedulePurge("qs_purged", Date.now(), jesseActor);
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
    expect(body.items[0].origin).toEqual({ memberId: "m_creator", label: "member 1" });
    const again = (await read(`/public/rooms/${PUB}/surface`, { "if-none-match": tag }))!;
    expect([again.status, again.headers.get("etag"), again.headers.get("access-control-allow-origin")]).toEqual([304, tag, "*"]);
  });

  // Room pages spec, D4: what the page orders and dates a post by.
  it("dates each item: when its key was first written and when it last changed, ISO 8601", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const put = async (body: string) => {
        const res = (await asCreator(`/rooms/${PUB}/surface/plan?member_id=m_creator`, {
          method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "text", title: "The plan", body }),
        }))!;
        expect(res.status, await res.clone().text()).toBe(200);
      };
      vi.setSystemTime(new Date("2026-10-18T09:00:00.000Z"));
      await put("first");
      vi.setSystemTime(new Date("2026-10-19T10:30:00.000Z"));
      await put("revised");
      const { items } = (await bodyOf(await read(`/public/rooms/${PUB}/surface`))) as unknown as { items: { data: Record<string, unknown> }[] };
      expect(items[0].data).toMatchObject({
        created_at: "2026-10-18T09:00:00.000Z", changed_at: "2026-10-19T10:30:00.000Z", at: "2026-10-19T10:30:00.000Z",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // Topic rooms spec, section 2 and R20: the approver is named as the author is, by the public name rule.
  it("names a card's approver by number, as it names its author", async () => {
    const item = { key: "plan", kind: "text" as const, title: "The plan", body: "hello", ends: null, placement: null, blob: null, shape: null };
    await store.appendEvent(
      PUB,
      { type: "surface", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: item, refId: null },
      { surface: { key: "plan", item }, approvedBy: { memberId: "m_peer", label: "peer@codenerd" } },
    );
    const { items } = (await bodyOf(await read(`/public/rooms/${PUB}/surface`))) as unknown as {
      items: { origin: { label: string }; data: { approved_by: { member_id: string; label: string } | null } }[];
    };
    expect(items[0].origin.label).toBe("member 1");
    expect(items[0].data.approved_by).toEqual({ member_id: "m_peer", label: "member 2" });
    // The sign-in label is nowhere in what a reader gets, whichever key a later change files the approver under.
    expect(JSON.stringify(items)).not.toContain("peer@codenerd");
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
    expect(out.events[0].origin).toEqual({ memberId: "m_creator", label: "member 1" });
    expect(out.events[1].data.payload).toEqual({ member: { member_id: "m_peer", label: "member 2", room_role: "peer_b" } });
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

// Plan B's final review, Critical: a label is how a member signed in, an email address for most,
// and a reader with the link is not owed it.
describe("members' names on a public read", () => {
  it("names every member by number on every public read, wherever a label sits, and never by label", async () => {
    const put = (await asCreator(`/rooms/${PUB}/surface/plan?member_id=m_creator`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "text", title: "The plan", body: "hello" }),
    }))!;
    expect(put.status).toBe(200);
    await say(member(), "message", { text: "hello" });
    await say(peer(), "member_joined", { member: storedMember(peer()), brief: brief() });
    await say(peer(), "member_left", { label: "peer@codenerd" });
    // And has left: the session holds the members in the room now, and a member who left keeps the
    // number its label was given at seating (ADR 0019, D6).
    await store.updateMember(PUB, "m_peer", { leftAt: Date.now() });
    await store.appendEvent(PUB, {
      type: "heartbeat", fromMemberId: "system", fromUserId: "system", fromLabel: "bellman",
      payload: { members: [{ member_id: "m_peer", label: "peer@codenerd" }], about: { origin: { label: "jesse@codenerd" } } }, refId: null,
    });
    for (const sub of ["", "/surface", "/events"]) {
      expect(JSON.stringify(await bodyOf(await read(`/public/rooms/${PUB}${sub}`))), sub).not.toMatch(/@codenerd/);
    }
    const { events } = (await bodyOf(await read(`/public/rooms/${PUB}/events`))) as unknown as {
      events: { origin: { label: string }; data: { from: { label: string }; payload: unknown } }[];
    };
    // The surface write logs a `surface` event of its own, first.
    expect(events.map((e) => [e.origin.label, e.data.from.label])).toEqual([
      ["member 1", "member 1"], ["member 1", "member 1"], ["member 2", "member 2"], ["member 2", "member 2"], ["bellman", "bellman"],
    ]);
    expect(events[3].data.payload).toEqual({ label: "member 2" });
    expect(events[4].data.payload).toEqual({ members: [{ member_id: "m_peer", label: "member 2" }], about: { origin: { label: "member 1" } } });
  });
});

// The hosted seat's label is `host@bellman`, which reads as an email address on a public page. The
// room's rows, events and audit trail keep it; a reader outside the room is shown `host`, in every
// public read, old events included.
describe("the hosted seat on a public read", () => {
  const HOSTED = "qs_public_hosted";
  const seat = { memberId: HOST_MEMBER_ID, userId: HOST_USER_ID, label: HOST_LABEL };

  beforeEach(async () => {
    const m = roomManifest({
      public: true, room: "Open social", purpose: "Read along", mode: "swarm", preset: null, heartbeatOnMs: 3_600_000,
      roles: { lead: { can: ["send", "invite"], description: null, reports: false }, host: { can: ["send"], description: null, reports: false } },
      defaultRole: "lead", creatorRole: "lead", host: { role: "host", model: "haiku", instructions: null },
    });
    // The creator is member 1, the seat has no number, and the peer is member 2.
    await store.createSession(session({ id: HOSTED, manifest: m, members: [member(), hostMember(m, Date.now()), peer()] }));
  });

  const sayIn = async (from: { memberId: string; userId: string; label: string }, type: EventType, payload: unknown, extras?: Parameters<MemoryStore["appendEvent"]>[2]) => {
    const e = await store.appendEvent(HOSTED, { type, fromMemberId: from.memberId, fromUserId: from.userId, fromLabel: from.label, payload, refId: null }, extras);
    expect(e).not.toBeNull();
    return e!;
  };
  /** The log of a room whose seat has joined, asked, and written to the surface, and whose members have answered. */
  const hostedLog = async () => {
    await sayIn(member(), "message", { text: "hello" });
    await sayIn(seat, "member_joined", { member: { member_id: HOST_MEMBER_ID, label: HOST_LABEL, room_role: "host" } });
    await sayIn(seat, "message", { kind: "question", text: "What shipped?", tick: 1 });
    await sayIn(peer(), "message", { text: "a parser" });
    await sayIn(seat, "surface", { key: "note" }, {
      surface: { key: "note", item: { key: "note", kind: "text", title: "Notes", body: "hello", ends: null, placement: null, blob: null, shape: null } },
    });
    await sayIn({ memberId: "system", userId: "system", label: "bellman" }, "heartbeat", {
      members: [{ member_id: HOST_MEMBER_ID, label: HOST_LABEL }, { member_id: "m_peer", label: "peer@codenerd" }],
    });
  };

  it("names the seat 'host' as the sender and the origin of its events, in the join that seated it, and wherever a payload names it", async () => {
    await hostedLog();
    const { events } = (await bodyOf(await read(`/public/rooms/${HOSTED}/events`))) as unknown as {
      events: { origin: { memberId: string; label: string }; data: { type: string; from: { label: string }; payload: unknown } }[];
    };
    expect(events.map((e) => [e.data.type, e.origin.label, e.data.from.label])).toEqual([
      ["message", "member 1", "member 1"],
      ["member_joined", "host", "host"],
      ["message", "host", "host"],
      ["message", "member 2", "member 2"],
      ["surface", "host", "host"],
      ["heartbeat", "bellman", "bellman"],
    ]);
    expect(events[2].origin.memberId).toBe(HOST_MEMBER_ID);
    expect(events[1].data.payload).toEqual({ member: { member_id: HOST_MEMBER_ID, label: "host", room_role: "host" } });
    expect(events[5].data.payload).toEqual({ members: [{ member_id: HOST_MEMBER_ID, label: "host" }, { member_id: "m_peer", label: "member 2" }] });
  });

  it("names the seat 'host' as the writer of a surface item", async () => {
    await hostedLog();
    const { items } = (await bodyOf(await read(`/public/rooms/${HOSTED}/surface`))) as unknown as { items: { origin: unknown }[] };
    expect(items.map((i) => i.origin)).toEqual([{ memberId: HOST_MEMBER_ID, label: "host" }]);
  });

  it("shows no public response the seat's label, which the room itself still stores", async () => {
    await hostedLog();
    for (const sub of ["", "/surface", "/events"]) {
      const body = JSON.stringify(await bodyOf(await read(`/public/rooms/${HOSTED}${sub}`)));
      expect(body, sub).not.toContain(HOST_LABEL);
      expect(body, sub).not.toMatch(/@codenerd/);
    }
    // The control: the label is what the room stores, so the reads above had something to hide.
    expect((await store.eventsAfter(HOSTED, 0)).filter((e) => e.fromLabel === HOST_LABEL)).toHaveLength(3);
    expect((await store.getSession(HOSTED))!.members.map((m) => m.label)).toContain(HOST_LABEL);
  });
});

describe("a public room read by its name (public names spec, D6)", () => {
  const name = async (id: string, n: string) => {
    await store.claimPublicName(n, { id, at: Date.now() }, null);
    await store.setPublicName(id, n);
  };

  // The sitemap's list: only rooms that hold their name, each at the link its own read gives.
  it("lists the named public rooms at GET /public/rooms, in name order, leaving out a name its room no longer holds", async () => {
    await store.createSession(session({ id: "qs_closed_pub", manifest: roomManifest({ public: true }), members: [member()], closed: true, closedAt: Date.now(), joinCodes: {} }));
    await store.createSession(session({ id: "qs_other", manifest: roomManifest({ public: true, room: "Other" }), members: [member()] }));
    await name("qs_closed_pub", "closed-room");
    await name(PUB, "open-review");
    await name("qs_other", "another");
    await store.claimPublicName("in-flight", { id: "qs_nowhere", at: Date.now() }, null);
    const res = (await read("/public/rooms"))!;
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual({ rooms: [
      { id: "qs_other", name: "another", public_url: "https://bellman.sh/r/another" },
      { id: PUB, name: "open-review", public_url: "https://bellman.sh/r/open-review" },
    ] });
    await store.unpublishSession(PUB, Date.now());
    expect(await bodyOf(await read("/public/rooms"))).toEqual({ rooms: [{ id: "qs_other", name: "another", public_url: "https://bellman.sh/r/another" }] });
  });

  it("reads the room, its surface and its log by its name as by its session id", async () => {
    await name(PUB, "open-review");
    // The room's one link, whichever way it was read: its name's while it holds one.
    expect((await bodyOf(await read(`/public/rooms/${PUB}`))).public_url).toBe("https://bellman.sh/r/open-review");
    for (const part of ["", "/surface", "/events"]) {
      const byName = (await read(`/public/rooms/open-review${part}`))!;
      expect(byName.status, part).toBe(200);
      expect(await byName.json(), part).toEqual(await (await read(`/public/rooms/${PUB}${part}`))!.json());
    }
  });

  // Review Focus 3: a closed room's name is free, and the room is still readable by its id.
  it("answers a name its room no longer holds as no public room, and keeps a closed room readable by its id", async () => {
    await store.createSession(session({
      id: "qs_closed_pub", manifest: roomManifest({ public: true }), members: [member()], closed: true, closedAt: Date.now(), joinCodes: {},
    }));
    await name("qs_closed_pub", "closed-room");
    expect((await read("/public/rooms/closed-room"))!.status).toBe(404);
    const byId = (await read("/public/rooms/qs_closed_pub"))!;
    expect(byId.status).toBe(200);
    // The record still carries the name, which the room no longer holds, so its one link is its id's.
    expect((await bodyOf(byId)).public_url).toBe("https://bellman.sh/r/qs_closed_pub");
    await name(PUB, "open-review");
    // The positive control: the name reads while its room holds it, so the 404 below is the release.
    expect((await read("/public/rooms/open-review"))!.status).toBe(200);
    await store.unpublishSession(PUB, Date.now());
    const gone = (await read("/public/rooms/open-review"))!;
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual(NOT_PUBLIC);
  });

  // Review Focus 5: a name nobody holds is answered from the index alone.
  it("answers a name nobody claimed without reading any room", async () => {
    const reads = vi.spyOn(store, "getSession");
    expect((await read("/public/rooms/never-claimed"))!.status).toBe(404);
    expect(reads).not.toHaveBeenCalled();
  });
});
