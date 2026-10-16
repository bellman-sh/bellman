/**
 * The moderation routes (abuse protections spec, sections 1 and 3): a room's bans and reports for its
 * creator, a creator's bans across their rooms, and a report from anyone the room admits. Over one MemoryStore.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveIdentity } from "../src/auth.js";
import { MAX_BAN_BYTES, moderationRoutes } from "../src/http/moderation.js";
import type { RoomCaller } from "../src/http/rooms.js";
import { MemoryStore } from "../src/store.js";
import { member, roomManifest, session } from "./helpers/fixtures.js";
import { DEV_KEY } from "./helpers/harness.js";

const ISSUER = "https://mcp.example.test";
const PANEL = "https://dash.example.test";
const ROOM = "qs_mod";
let store: MemoryStore;

/** Bearer: a dev key. Cookie: the dev key as the cookie's value. */
const caller = async (request: Request): Promise<RoomCaller | null> => {
  const bearer = resolveIdentity(request.headers.get("authorization") ?? undefined);
  if (bearer) return { identity: bearer, via: "bearer" };
  const cookie = /bellman_session=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  const identity = cookie ? resolveIdentity(`Bearer ${cookie}`) : null;
  return identity ? { identity, via: "cookie" } : null;
};

/** jesse created the public room; peer sits in it; outsider holds no handle. */
const peer = () => member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b" });
beforeEach(async () => {
  store = new MemoryStore();
  await store.createSession(session({ id: ROOM, manifest: roomManifest({ public: true }), members: [member(), peer()] }));
});

function call(key: string | null, path: string, over: { method?: string; body?: unknown; cookie?: string; origin?: string } = {}) {
  const headers: Record<string, string> = {};
  if (key) headers.authorization = `Bearer ${key}`;
  if (over.cookie) headers.cookie = `__Host-bellman_session=${over.cookie}`;
  if (over.origin) headers.origin = over.origin;
  if (over.body !== undefined) headers["content-type"] = "application/json";
  return moderationRoutes(new Request(`${ISSUER}${path}`, {
    method: over.method ?? "GET", headers, body: over.body === undefined ? undefined : JSON.stringify(over.body),
  }), { store, caller, panelOrigins: [PANEL] });
}
const answer = async (res: Response | undefined) => [res!.status, await res!.json().catch(() => null)];

describe("the moderation routes", () => {
  it("leave every other path to the next module", async () => {
    for (const path of [`/rooms/${ROOM}`, `/rooms/${ROOM}/surface`, "/account", "/account/handle"]) {
      expect(await call(DEV_KEY.jesse, path), path).toBeUndefined();
    }
  });
});

describe("a room's bans", () => {
  it("bans a member for the creator, lists the ban by label and time with no user id, and lifts it", async () => {
    const banned = await call(DEV_KEY.jesse, `/rooms/${ROOM}/bans`, { method: "POST", body: { member_id: "m_peer", scope: "room" } });
    expect(await answer(banned)).toEqual([200, { evicted: true, code_retired: "peer_b", session_status: "active", banned: "room" }]);
    const [status, body] = await answer(await call(DEV_KEY.jesse, `/rooms/${ROOM}/bans`));
    expect(status).toBe(200);
    expect(body).toEqual({ bans: [{ ban_id: expect.stringMatching(/^ban_/), label: "peer@codenerd", at: expect.any(String) }] });
    expect(JSON.stringify(body)).not.toContain("u_peer");
    const id = (body as { bans: { ban_id: string }[] }).bans[0].ban_id;
    expect((await call(DEV_KEY.jesse, `/rooms/${ROOM}/bans/${id}`, { method: "DELETE" }))!.status).toBe(204);
    expect((await call(DEV_KEY.jesse, `/rooms/${ROOM}/bans/${id}`, { method: "DELETE" }))!.status).toBe(404);
    expect(await store.roomBans(ROOM)).toEqual([]);
  });

  it("answers a member who did not create the room 403, and a stranger and a missing room the same 404, banning nobody", async () => {
    expect((await call(DEV_KEY.peer, `/rooms/${ROOM}/bans`))!.status).toBe(403);
    expect((await call(DEV_KEY.peer, `/rooms/${ROOM}/bans`, { method: "POST", body: { member_id: "m_creator", scope: "all" } }))!.status).toBe(403);
    expect((await call(DEV_KEY.outsider, `/rooms/${ROOM}/bans`))!.status).toBe(404);
    expect((await call(DEV_KEY.jesse, "/rooms/qs_nowhere/bans"))!.status).toBe(404);
    expect((await call(null, `/rooms/${ROOM}/bans`))!.status).toBe(401);
    expect(await store.roomBans(ROOM)).toEqual([]);
  });

  it("refuses a body with no member or no scope, and a cookie write without the panel's Origin", async () => {
    for (const body of [{ scope: "room" }, { member_id: "m_peer" }, { member_id: "m_peer", scope: "everywhere" }, []]) {
      expect((await call(DEV_KEY.jesse, `/rooms/${ROOM}/bans`, { method: "POST", body }))!.status, JSON.stringify(body)).toBe(400);
    }
    const forged = await call(null, `/rooms/${ROOM}/bans`, { method: "POST", cookie: DEV_KEY.jesse, body: { member_id: "m_peer", scope: "room" } });
    expect(forged!.status).toBe(403);
    expect(await store.roomBans(ROOM)).toEqual([]);
    const real = await call(null, `/rooms/${ROOM}/bans`, { method: "POST", cookie: DEV_KEY.jesse, origin: PANEL, body: { member_id: "m_peer", scope: "room" } });
    expect(real!.status, "the control: the panel's Origin bans").toBe(200);
  });
});

describe("a creator's bans across their rooms", () => {
  it("lists the bans with the room each came from, and lifts one, for the creator alone", async () => {
    await call(DEV_KEY.jesse, `/rooms/${ROOM}/bans`, { method: "POST", body: { member_id: "m_peer", scope: "all" } });
    const [status, body] = await answer(await call(DEV_KEY.jesse, "/account/bans"));
    expect(status).toBe(200);
    expect(body).toEqual({ bans: [{ ban_id: expect.stringMatching(/^ban_/), label: "peer@codenerd", at: expect.any(String), session_id: ROOM }] });
    const id = (body as { bans: { ban_id: string }[] }).bans[0].ban_id;
    expect(await answer(await call(DEV_KEY.peer, "/account/bans"))).toEqual([200, { bans: [] }]);
    expect((await call(DEV_KEY.peer, `/account/bans/${id}`, { method: "DELETE" }))!.status).toBe(404);
    expect((await call(DEV_KEY.jesse, `/account/bans/${id}`, { method: "DELETE" }))!.status).toBe(204);
    expect(await store.isBannedByCreator("u_jesse", "u_peer")).toBe(false);
    expect((await call(null, "/account/bans"))!.status).toBe(401);
  });
});

describe("every ban route", () => {
  const raw = (path: string, init: RequestInit) => moderationRoutes(new Request(`${ISSUER}${path}`, init), { store, caller, panelOrigins: [PANEL] });
  const bearer = { authorization: `Bearer ${DEV_KEY.jesse}` };
  const BAN = "ban_0123456789abcdef";
  const PATHS = [`/rooms/${ROOM}/bans`, `/rooms/${ROOM}/bans/${BAN}`, "/account/bans", `/account/bans/${BAN}`];

  afterEach(() => vi.restoreAllMocks());

  it("answers the panel's preflight with a grant for POST and DELETE, and a stranger's with none", async () => {
    for (const path of PATHS) {
      const panel = (await raw(path, { method: "OPTIONS", headers: { origin: PANEL } }))!;
      expect([panel.status, panel.headers.get("access-control-allow-origin")], path).toEqual([204, PANEL]);
      expect(panel.headers.get("access-control-allow-methods")?.split(/,\s*/), path).toEqual(expect.arrayContaining(["POST", "DELETE"]));
      const stranger = (await raw(path, { method: "OPTIONS", headers: { origin: "https://elsewhere.example.test" } }))!;
      expect([stranger.status, stranger.headers.get("access-control-allow-origin")], path).toEqual([204, null]);
    }
  });

  it("answers 405 with the methods a path takes", async () => {
    const wrong = async (method: string, path: string) => {
      const res = (await raw(path, { method, headers: bearer }))!;
      return [res.status, res.headers.get("allow")];
    };
    expect(await wrong("PUT", PATHS[0])).toEqual([405, "GET, POST"]);
    expect(await wrong("GET", PATHS[1])).toEqual([405, "DELETE"]);
    expect(await wrong("POST", PATHS[2])).toEqual([405, "GET"]);
    expect(await wrong("GET", PATHS[3])).toEqual([405, "DELETE"]);
  });

  it("refuses a ban request over the bound before reading it, and a body that is not JSON", async () => {
    const ban = (body: string, headers: Record<string, string> = {}) =>
      raw(PATHS[0], { method: "POST", headers: { ...bearer, "content-type": "application/json", ...headers }, body });
    const fine = JSON.stringify({ member_id: "m_peer", scope: "room" });
    expect((await ban(fine, { "content-length": String(MAX_BAN_BYTES + 1) }))!.status).toBe(413);
    expect((await ban(fine, { "content-length": "garbage" }))!.status).toBe(400);
    expect((await ban("not json"))!.status).toBe(400);
    expect(await store.roomBans(ROOM)).toEqual([]);
  });

  it("maps the eviction's refusals through STATUS: an unknown member 404, the creator themselves 403, a frozen room 409", async () => {
    await store.createSession(session({ id: "qs_mod_frozen", frozenAt: Date.now(), members: [member(), peer()] }));
    const ban = (room: string, memberId: string) =>
      call(DEV_KEY.jesse, `/rooms/${room}/bans`, { method: "POST", body: { member_id: memberId, scope: "room" } });
    expect(await answer(await ban(ROOM, "m_nobody"))).toMatchObject([404, { error: "not_found" }]);
    expect(await answer(await ban(ROOM, "m_creator"))).toMatchObject([403, { error: "forbidden" }]);
    expect(await answer(await ban("qs_mod_frozen", "m_peer"))).toMatchObject([409, { error: "frozen" }]);
    expect(await store.roomBans("qs_mod_frozen")).toEqual([]);
  });

  it("lets only the creator lift a room's ban: the banned account and a stranger are refused, and the ban stays", async () => {
    await call(DEV_KEY.jesse, PATHS[0], { method: "POST", body: { member_id: "m_peer", scope: "room" } });
    const [{ banId }] = await store.roomBans(ROOM);
    expect((await call(DEV_KEY.peer, `/rooms/${ROOM}/bans/${banId}`, { method: "DELETE" }))!.status).toBe(403);
    expect((await call(DEV_KEY.outsider, `/rooms/${ROOM}/bans/${banId}`, { method: "DELETE" }))!.status).toBe(404);
    expect(await store.roomBans(ROOM)).toHaveLength(1);
  });

  it("answers a failing store with the route's own 500, and logs the cause", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(store, "roomBans").mockRejectedValue(new Error("storage is down"));
    expect(await answer(await call(DEV_KEY.jesse, PATHS[0]))).toMatchObject([500, { error: "internal" }]);
    expect(logged.mock.calls.flat().join(" ")).toContain("storage is down");
  });
});
