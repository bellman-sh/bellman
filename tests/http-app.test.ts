/**
 * The app API (#434): `GET /me/rooms`, what `bellman_rooms` returns for the panel and desktop apps, and
 * `POST /rooms/:id/codes`, a join code minted through the operation `bellman_invite` runs. Rooms are made
 * through the tools on a Harness, so the routes read what a real room holds; who is calling is a stub over
 * the dev keys, as in tests/http-rooms.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveIdentity } from "../src/auth.js";
import { meRoutes } from "../src/http/me.js";
import { MAX_CODE_BYTES, roomRoutes, type RoomCaller, type RoomRouteDeps } from "../src/http/rooms.js";
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
