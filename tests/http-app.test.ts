/**
 * The app API (#434): `GET /me/rooms`, what `bellman_rooms` returns for the panel and desktop apps, and
 * `POST /rooms/:id/codes`, a join code minted through the operation `bellman_invite` runs. Rooms are made
 * through the tools on a Harness, so the routes read what a real room holds; who is calling is a stub over
 * the dev keys, as in tests/http-rooms.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveIdentity } from "../src/auth.js";
import { homeRoomId } from "../src/files/home.js";
import { meRoutes } from "../src/http/me.js";
import type { LookupShown } from "../src/files/memory.js";
import { MAX_CODE_BYTES, roomRoutes, type RoomCaller, type RoomRouteDeps } from "../src/http/rooms.js";
import { SEND_LIMIT } from "../src/room/send-limit.js";
import { joinWith, pairUp, publicRoom, startRoom } from "./helpers/flows.js";
import { DEV_KEY, Harness } from "./helpers/harness.js";

const ISSUER = "https://mcp.example.test";
const PANEL = "https://dash.example.test";

/** A swarm whose lead may invite and revoke and whose helper may only send. */
const SWARM = {
  room: "swarm", mode: "swarm",
  roles: { lead: { can: ["send", "invite", "revoke"] }, helper: { can: ["send"] } },
  default_role: "helper", creator_role: "lead",
};

const caller = async (request: Request): Promise<RoomCaller | null> => {
  const bearer = resolveIdentity(request.headers.get("authorization") ?? undefined);
  if (bearer) return { identity: bearer, via: "bearer" };
  const cookie = /bellman_session=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  const identity = cookie ? resolveIdentity(`Bearer ${cookie}`) : null;
  return identity ? { identity, via: "cookie" } : null;
};

let h: Harness;
let deps: RoomRouteDeps;
beforeEach(() => {
  h = new Harness();
  deps = { store: h.store, blobs: h.blobs, caller, panelOrigins: [PANEL] };
});
afterEach(async () => {
  await h.close();
  vi.useRealTimers();
});

interface CallOptions { method?: string; body?: unknown; rawBody?: string; headers?: Record<string, string>; cookie?: string }

async function call(key: string | null, path: string, over: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(over.headers ?? {}) };
  if (key) headers.authorization = `Bearer ${key}`;
  if (over.cookie) headers.cookie = `__Host-bellman_session=${over.cookie}`;
  const body = over.rawBody ?? (over.body === undefined ? undefined : JSON.stringify(over.body));
  if (body !== undefined) headers["content-type"] ??= "application/json";
  const request = new Request(`${ISSUER}${path}`, { method: over.method ?? "GET", headers, body });
  return (await meRoutes(request, deps)) ?? (await roomRoutes(request, deps))!;
}

const bodyOf = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe("GET /me/rooms", () => {
  it("answers what bellman_rooms returns, for every seat", async () => {
    // Frozen, so `silent_for_seconds` reads the same in the tool and the route.
    vi.useFakeTimers({ toFake: ["Date"] });
    const pair = await pairUp(h);
    for (const [peer, key] of [[pair.creator, DEV_KEY.jesse], [pair.joiner, DEV_KEY.peer]] as const) {
      const tool = (await peer.call("bellman_rooms")).data;
      const res = await call(key, "/me/rooms");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(tool);
      expect((tool.rooms as unknown[]).length).toBe(1);
    }
  });

  it("lists a room joined from another connection on the next read", async () => {
    const { sessionId, started } = await startRoom(await h.connect(DEV_KEY.jesse), SWARM);
    const before = (await bodyOf(await call(DEV_KEY.peer, "/me/rooms"))).rooms as { session_id: string }[];
    expect(before.map((r) => r.session_id)).not.toContain(sessionId);
    const joined = await joinWith(await h.connect(DEV_KEY.peer), String(started.data.join_code));
    expect(joined.isError, joined.text).toBe(false);
    const after = (await bodyOf(await call(DEV_KEY.peer, "/me/rooms"))).rooms as { session_id: string }[];
    expect(after.map((r) => r.session_id)).toContain(sessionId);
  });

  it("refuses no credential with 401 and any method but GET with 405, with CORS for the panel", async () => {
    const anonymous = await call(null, "/me/rooms", { headers: { origin: PANEL } });
    expect([anonymous.status, anonymous.headers.get("access-control-allow-origin")]).toEqual([401, PANEL]);
    const post = await call(DEV_KEY.jesse, "/me/rooms", { method: "POST", body: {} });
    expect([post.status, post.headers.get("allow")]).toEqual([405, "GET"]);
    expect((await call(DEV_KEY.jesse, "/me/rooms", { cookie: DEV_KEY.jesse })).status).toBe(200);
  });
});

// #530: the account's memory settings. Read by bearer or cookie (the bridge reads with its bearer for the Stop hook);
// written from a dash session alone, with the panel's Origin.
describe("GET and PUT /me/memory", () => {
  const dash = (body: unknown, over: CallOptions = {}) =>
    call(null, "/me/memory", { method: "PUT", body, cookie: DEV_KEY.jesse, headers: { origin: PANEL }, ...over });

  it("reads off until the dash turns it on, for the bearer and the cookie alike, and per account", async () => {
    expect(await bodyOf(await call(DEV_KEY.jesse, "/me/memory"))).toEqual({ capture: false, paused: false });
    const on = await dash({ capture: true });
    expect([on.status, await bodyOf(on)]).toEqual([200, { capture: true, paused: false }]);
    expect(await bodyOf(await call(DEV_KEY.jesse, "/me/memory"))).toEqual({ capture: true, paused: false });
    expect(await bodyOf(await call(null, "/me/memory", { cookie: DEV_KEY.jesse }))).toEqual({ capture: true, paused: false });
    expect(await bodyOf(await call(DEV_KEY.peer, "/me/memory"))).toEqual({ capture: false, paused: false });
    const off = await dash({ capture: false });
    expect([off.status, await bodyOf(off)]).toEqual([200, { capture: false, paused: false }]);
    // A home room exists for nothing but the switch: no note, and bellman_memory lists none.
    const peer = await h.connect(DEV_KEY.jesse);
    expect((await peer.call("bellman_memory", { op: "recall" })).data).toMatchObject({ entries: [] });
  });

  it("refuses the write with a bearer, without the panel's Origin, with any other body, and anonymously", async () => {
    const bearer = await call(DEV_KEY.jesse, "/me/memory", { method: "PUT", body: { capture: true } });
    expect([bearer.status, (await bodyOf(bearer)).error]).toEqual([403, "dash_session_required"]);
    expect((await dash({ capture: true }, { headers: {} })).status).toBe(403);
    for (const body of [{ capture: "yes" }, { capture: true, pause: true }, {}, [true], null]) {
      expect((await dash(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await call(null, "/me/memory")).status).toBe(401);
    expect((await call(DEV_KEY.jesse, "/me/memory", { method: "PATCH" })).headers.get("allow")).toBe("GET, PUT, DELETE");
    expect(await bodyOf(await call(DEV_KEY.jesse, "/me/memory"))).toEqual({ capture: false, paused: false });
  });

  it("sets paused and capture independently, in either order", async () => {
    expect(await bodyOf(await dash({ paused: true }))).toEqual({ capture: false, paused: true });
    expect(await bodyOf(await dash({ capture: true }))).toEqual({ capture: true, paused: true });
    expect(await bodyOf(await dash({ paused: false, capture: false }))).toEqual({ capture: false, paused: false });
    for (const body of [{ paused: "yes" }, { paused: true, pause: true }]) expect((await dash(body)).status, JSON.stringify(body)).toBe(400);
  });
});

describe("GET /me/memory/lookups", () => {
  it("lists the account's lookup rows newest first with the room's name, to the dash alone", async () => {
    const pair = await pairUp(h);
    await pair.creator.call("bellman_memory", { op: "remember", path: "/a.md", content: "a" });
    await pair.creator.call("bellman_memory", { op: "recall", path: "/a.md" });
    await pair.creator.call("bellman_memory", { op: "share", session_id: pair.sessionId, member_id: pair.creatorMemberId, path: "/a.md", to: "notes" });
    const res = await call(null, "/me/memory/lookups", { cookie: DEV_KEY.jesse });
    expect(res.status).toBe(200);
    const { lookups } = (await bodyOf(res)) as { lookups: LookupShown[] };
    expect(lookups.map((l) => [l.op, l.room?.session_id ?? null, l.room?.room ?? null, l.paths])).toEqual([
      ["share", pair.sessionId, "test-room", ["/a.md"]],
      ["read", null, null, ["/a.md"]],
    ]);
    expect((await call(DEV_KEY.jesse, "/me/memory/lookups")).status).toBe(403);
    // The joiner's account holds only its own arrival read, none of the creator's.
    const peer = await call(null, "/me/memory/lookups", { cookie: DEV_KEY.peer });
    expect(peer.status).toBe(200);
    expect(((await bodyOf(peer)) as { lookups: LookupShown[] }).lookups.map((l) => [l.op, l.room?.session_id, l.paths])).toEqual([["arrival", pair.sessionId, []]]);
    expect((await call(null, "/me/memory/lookups", { method: "PUT", cookie: DEV_KEY.jesse, body: {} })).headers.get("allow")).toBe("GET");
  });
});

describe("GET /me/memory/export", () => {
  it("returns one Markdown document of home notes and the account's room notes, to the dash alone", async () => {
    const pair = await pairUp(h);
    await pair.creator.call("bellman_memory", { op: "remember", path: "/a.md", content: "home note" });
    await pair.creator.call("bellman_fs", { op: "write", session_id: pair.sessionId, member_id: pair.creatorMemberId, path: "/members/me/r.md", content: "room note" });
    await pair.joiner.call("bellman_fs", { op: "write", session_id: pair.sessionId, member_id: pair.joinerMemberId, path: "/members/me/p.md", content: "peer note" });
    const res = await call(null, "/me/memory/export", { cookie: DEV_KEY.jesse, headers: { origin: PANEL } });
    expect([res.status, res.headers.get("content-type"), res.headers.get("content-disposition")]).toEqual([200, "text/markdown; charset=utf-8", expect.stringMatching(/^attachment; filename="bellman-memory-\d{4}-\d{2}-\d{2}\.md"$/)]);
    const md = await res.text();
    expect(md).toContain("### /a.md");
    expect(md).toContain("home note");
    expect(md).toContain(`### test-room (${pair.sessionId})`);
    expect(md).toContain("room note");
    expect(md).not.toContain("peer note");
    expect((await call(DEV_KEY.jesse, "/me/memory/export")).status).toBe(403);
    expect((await call(null, "/me/memory/export", { method: "PUT", cookie: DEV_KEY.jesse, body: {} })).headers.get("allow")).toBe("GET");
  });

  const exported = async () => (await call(null, "/me/memory/export", { cookie: DEV_KEY.jesse, headers: { origin: PANEL } })).text();

  it("leaves out the account's notes in a room it left and in a closed room", async () => {
    const left = await pairUp(h);
    await left.creator.call("bellman_fs", { op: "write", session_id: left.sessionId, member_id: left.creatorMemberId, path: "/members/me/l.md", content: "left note" });
    expect((await left.creator.call("bellman_leave", { session_id: left.sessionId, member_id: left.creatorMemberId })).isError).toBe(false);
    const jesse = await h.connect(DEV_KEY.jesse);
    const closed = await startRoom(jesse, SWARM);
    await jesse.call("bellman_fs", { op: "write", session_id: closed.sessionId, member_id: closed.memberId, path: "/members/me/c.md", content: "closed note" });
    await h.store.closeSession(closed.sessionId);
    const open = await startRoom(jesse, SWARM);
    await jesse.call("bellman_fs", { op: "write", session_id: open.sessionId, member_id: open.memberId, path: "/members/me/o.md", content: "open note" });
    const md = await exported();
    expect(md).toContain("open note");
    expect(md).not.toContain("left note");
    expect(md).not.toContain("closed note");
  });

  it("works while paused and writes no lookup row", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    await jesse.call("bellman_memory", { op: "remember", path: "/a.md", content: "home note" });
    await jesse.call("bellman_memory", { op: "recall", path: "/a.md" });
    const home = homeRoomId(resolveIdentity(`Bearer ${DEV_KEY.jesse}`)!.userId);
    const before = (await h.store.homeLookups(home)).length;
    await call(null, "/me/memory", { method: "PUT", body: { paused: true }, cookie: DEV_KEY.jesse, headers: { origin: PANEL } });
    expect(await exported()).toContain("home note");
    expect((await h.store.homeLookups(home)).length).toBe(before);
  });
});

// #531, ADR 0047 decision 14: hard delete, from a dash session alone, and never refused as paused.
describe("DELETE /me/memory and /me/memory/notes", () => {
  const dash = (body: unknown) => call(null, "/me/memory", { method: "PUT", body, cookie: DEV_KEY.jesse, headers: { origin: PANEL } });

  it("deletes everything from the dash and nothing with a bearer, turning capture off and keeping a pause", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    await jesse.call("bellman_memory", { op: "remember", path: "/a.md", content: "a" });
    await dash({ capture: true });
    const purge = () => call(null, "/me/memory", { method: "DELETE", cookie: DEV_KEY.jesse, headers: { origin: PANEL } });
    expect((await call(DEV_KEY.jesse, "/me/memory", { method: "DELETE" })).status).toBe(403);
    expect((await call(null, "/me/memory", { method: "DELETE", cookie: DEV_KEY.jesse })).status).toBe(403); // no Origin
    expect((await purge()).status).toBe(204);
    expect((await jesse.call("bellman_memory", { op: "recall" })).data).toMatchObject({ entries: [] });
    expect(await bodyOf(await call(DEV_KEY.jesse, "/me/memory"))).toEqual({ capture: false, paused: false });
    await dash({ capture: true, paused: true });
    expect((await purge()).status).toBe(204);
    expect(await bodyOf(await call(DEV_KEY.jesse, "/me/memory"))).toEqual({ capture: false, paused: true });
    expect((await jesse.call("bellman_memory", { op: "recall" })).isError).toBe(true);
  });

  it("deletes one note by path, 404 for a note that is not there, 400 without a path", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    await jesse.call("bellman_memory", { op: "remember", path: "/a.md", content: "a" });
    const del = (q: string) => call(null, `/me/memory/notes${q}`, { method: "DELETE", cookie: DEV_KEY.jesse, headers: { origin: PANEL } });
    expect((await del("?path=%2Fa.md")).status).toBe(204);
    expect((await del("?path=%2Fa.md")).status).toBe(404);
    expect((await del("")).status).toBe(400);
    expect((await jesse.call("bellman_memory", { op: "recall", path: "/a.md" })).isError).toBe(true);
  });

  it("deletes while paused, refuses a bearer on /notes, and takes DELETE alone there", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    await jesse.call("bellman_memory", { op: "remember", path: "/a.md", content: "a" });
    await jesse.call("bellman_memory", { op: "remember", path: "/b.md", content: "b" });
    await dash({ paused: true });
    const bearer = await call(DEV_KEY.jesse, "/me/memory/notes?path=%2Fa.md", { method: "DELETE" });
    expect([bearer.status, (await bodyOf(bearer)).error]).toEqual([403, "dash_session_required"]);
    expect((await call(null, "/me/memory/notes?path=%2Fa.md", { method: "DELETE", cookie: DEV_KEY.jesse, headers: { origin: PANEL } })).status).toBe(204);
    expect((await call(null, "/me/memory/notes?path=%2Fapps%2Fx", { method: "DELETE", cookie: DEV_KEY.jesse, headers: { origin: PANEL } })).status).toBe(400);
    expect((await call(DEV_KEY.jesse, "/me/memory/notes", { method: "GET" })).headers.get("allow")).toBe("DELETE");
    expect((await call(null, "/me/memory", { method: "DELETE", cookie: DEV_KEY.jesse, headers: { origin: PANEL } })).status).toBe(204);
    await dash({ paused: false });
    expect((await jesse.call("bellman_memory", { op: "recall" })).data).toMatchObject({ entries: [] });
  });
});

describe("POST /rooms/:id/codes", () => {
  const mint = (key: string | null, sessionId: string, body: unknown, over: CallOptions = {}) =>
    call(key, `/rooms/${sessionId}/codes`, { method: "POST", body, ...over });

  it("mints a code that expires, for the default role or a named one, and the code seats a newcomer", async () => {
    const { sessionId, memberId } = await startRoom(await h.connect(DEV_KEY.jesse), SWARM);
    const res = await mint(DEV_KEY.jesse, sessionId, { member_id: memberId });
    expect(res.status).toBe(201);
    const body = await bodyOf(res);
    expect(body).toMatchObject({ role: "helper", replaced_previous: true });
    expect(Object.keys(body).sort()).toEqual(["expires_at", "join_code", "join_url", "replaced_previous", "role"]);
    expect(Date.parse(String(body.expires_at))).toBeGreaterThan(Date.now());
    expect(String(body.join_url)).toContain(String(body.join_code));
    const lead = await bodyOf(await mint(DEV_KEY.jesse, sessionId, { member_id: memberId, role: "lead" }));
    expect(lead).toMatchObject({ role: "lead", replaced_previous: false });
    const joined = await joinWith(await h.connect(DEV_KEY.peer), String(body.join_code));
    expect(joined.isError, joined.text).toBe(false);
  });

  it("refuses a seat without invite and a stranger's borrowed member id with 403, an unknown room with 404, and no credential with 401", async () => {
    const { sessionId, memberId, started } = await startRoom(await h.connect(DEV_KEY.jesse), SWARM);
    const helper = await joinWith(await h.connect(DEV_KEY.peer), String(started.data.join_code));
    const refused = await mint(DEV_KEY.peer, sessionId, { member_id: String(helper.data.member_id) });
    expect([refused.status, (await bodyOf(refused)).error]).toEqual([403, "forbidden"]);
    const stranger = await mint(DEV_KEY.outsider, sessionId, { member_id: memberId });
    expect([stranger.status, (await bodyOf(stranger)).error_description]).toEqual([403, "member_id is not yours or has left the session."]);
    expect((await mint(DEV_KEY.jesse, "qs_nope", { member_id: memberId })).status).toBe(404);
    expect((await mint(null, sessionId, { member_id: memberId })).status).toBe(401);
  });

  it("refuses any other body with 400, permanent included, and one over the bound with 413", async () => {
    const { sessionId, memberId } = await startRoom(await h.connect(DEV_KEY.jesse), SWARM);
    const shapes: unknown[] = [{}, { role: "lead" }, { member_id: 1 }, { member_id: memberId, role: 2 },
      { member_id: memberId, permanent: true }, [], null, "x"];
    for (const body of shapes) expect((await mint(DEV_KEY.jesse, sessionId, body)).status, JSON.stringify(body)).toBe(400);
    expect((await mint(DEV_KEY.jesse, sessionId, undefined, { rawBody: "not json" })).status).toBe(400);
    const big = await mint(DEV_KEY.jesse, sessionId, undefined, {
      rawBody: JSON.stringify({ member_id: memberId }), headers: { "content-length": String(MAX_CODE_BYTES + 1) },
    });
    expect(big.status).toBe(413);
  });

  it("refuses a cookie without the panel's Origin, and takes one with it", async () => {
    const { sessionId, memberId } = await startRoom(await h.connect(DEV_KEY.jesse), SWARM);
    expect((await mint(null, sessionId, { member_id: memberId }, { cookie: DEV_KEY.jesse })).status).toBe(403);
    expect((await mint(null, sessionId, { member_id: memberId }, { cookie: DEV_KEY.jesse, headers: { origin: PANEL } })).status).toBe(201);
  });

  it("will not replace a public room's permanent link, and tells a stranger nothing of it", async () => {
    const { sessionId, memberId, code } = await publicRoom(h);
    const res = await mint(DEV_KEY.jesse, sessionId, { member_id: memberId });
    expect([res.status, (await bodyOf(res)).error]).toEqual([409, "permanent_code"]);
    const session = (await h.store.getSession(sessionId))!;
    expect(session.joinCodes[session.manifest.defaultRole]).toMatchObject({ code, expiresAt: null });
    // The stranger gets the 403 any room gives a borrowed member id, not the 409.
    expect((await mint(DEV_KEY.outsider, sessionId, { member_id: memberId })).status).toBe(403);
  });
});

// #531, ADR 0047 decision 14: the account's own room notes in one room, from a dash session alone.
describe("DELETE /rooms/:id/notes", () => {
  it("removes the account's room notes and no one else's, to the dash alone", async () => {
    const pair = await pairUp(h);
    await pair.creator.call("bellman_fs", { op: "write", session_id: pair.sessionId, member_id: pair.creatorMemberId, path: "/members/me/a.md", content: "a" });
    await pair.creator.call("bellman_fs", { op: "write", session_id: pair.sessionId, member_id: pair.creatorMemberId, path: "/members/me/b.md", content: "b" });
    await pair.joiner.call("bellman_fs", { op: "write", session_id: pair.sessionId, member_id: pair.joinerMemberId, path: "/members/me/p.md", content: "p" });
    const res = await call(null, `/rooms/${pair.sessionId}/notes`, { method: "DELETE", cookie: DEV_KEY.jesse, headers: { origin: PANEL } });
    expect(res.status).toBe(200);
    const body = await bodyOf(res) as { deleted: string[]; refused: unknown };
    expect(body.deleted.map((p) => p.split("/").pop()).sort()).toEqual(["a.md", "b.md"]);
    expect(body.refused).toBeNull();
    expect((await pair.creator.call("bellman_fs", { op: "list", session_id: pair.sessionId, member_id: pair.creatorMemberId, prefix: "/members/me/" })).data).toMatchObject({ entries: [] });
    expect((await pair.joiner.call("bellman_fs", { op: "read", session_id: pair.sessionId, member_id: pair.joinerMemberId, path: "/members/me/p.md" })).isError).toBe(false);
    expect((await call(DEV_KEY.jesse, `/rooms/${pair.sessionId}/notes`, { method: "DELETE" })).status).toBe(403);
    expect((await call(null, `/rooms/qs_nope/notes`, { method: "DELETE", cookie: DEV_KEY.jesse, headers: { origin: PANEL } })).status).toBe(404);
  });

  it("stops at the seat's send limit with what it deleted, the refusal and its wait, and one fs event per delete", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const pair = await pairUp(h);
    const write = (i: number) => pair.creator.call("bellman_fs", { op: "write", session_id: pair.sessionId, member_id: pair.creatorMemberId, path: `/members/me/n${String(i).padStart(2, "0")}.md`, content: "n" });
    // Each write is a send too, so the 31 notes are written over two minutes and the delete starts on a fresh one.
    for (let i = 0; i < SEND_LIMIT; i++) expect((await write(i)).isError).toBe(false);
    vi.advanceTimersByTime(61_000);
    expect((await write(SEND_LIMIT)).isError).toBe(false);
    vi.advanceTimersByTime(61_000);
    const cursor = (await h.store.eventsAfter(pair.sessionId, 0)).at(-1)!.cursor;
    const paths = (await h.store.listFs(pair.sessionId, "/members")).entries.map((e) => e.path);
    expect(paths).toHaveLength(SEND_LIMIT + 1);
    const res = await call(null, `/rooms/${pair.sessionId}/notes`, { method: "DELETE", cookie: DEV_KEY.jesse, headers: { origin: PANEL } });
    expect(res.status).toBe(200);
    const body = await bodyOf(res) as { deleted: string[]; refused: { path: string; code: string; retry_after: number } };
    expect(body.deleted).toEqual(paths.slice(0, SEND_LIMIT));
    expect(body.refused).toEqual({ path: paths[SEND_LIMIT], code: "rate_limited", retry_after: expect.any(Number) });
    expect(body.refused.retry_after).toBeGreaterThan(0);
    for (const p of body.deleted) expect(await h.store.readFs(pair.sessionId, p)).toBeNull();
    expect(await h.store.readFs(pair.sessionId, paths[SEND_LIMIT])).not.toBeNull();
    const deletes = (await h.store.eventsAfter(pair.sessionId, cursor)).filter((e) => e.type === "fs");
    expect(deletes.map((e) => [(e.payload as { op: string }).op, (e.payload as { path: string }).path])).toEqual(body.deleted.map((p) => ["delete", p]));
  });
});
