/**
 * The room file routes (ADR 0046) over MemoryStore: any seat reads, a signed-in dash session writes, and every
 * refusal maps to its status. Driven directly, a web Request in and a Response out, as tests/http-config.test.ts.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resolveIdentity } from "../src/auth.js";
import { MemoryBlobStore } from "../src/blobs.js";
import { roomRoutes, type RoomCaller, type RoomRouteDeps } from "../src/http/rooms.js";
import { MemoryStore } from "../src/store.js";
import { member, session } from "./helpers/fixtures.js";
import { DEV_KEY } from "./helpers/harness.js";

const ISSUER = "https://mcp.example.test";
const PANEL = "https://dash.example.test";
const ROOM = "qs_files";

let store: MemoryStore;
let deps: RoomRouteDeps;

const caller = async (request: Request): Promise<RoomCaller | null> => {
  const bearer = resolveIdentity(request.headers.get("authorization") ?? undefined);
  if (bearer) return { identity: bearer, via: "bearer" };
  const cookie = /bellman_session=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  const identity = cookie ? resolveIdentity(`Bearer ${cookie}`) : null;
  return identity ? { identity, via: "cookie" } : null;
};

beforeEach(async () => {
  store = new MemoryStore();
  deps = { store, blobs: new MemoryBlobStore(), caller, panelOrigins: [PANEL] };
  await store.createSession(session({
    id: ROOM, fsBytesCeiling: 20, members: [member(), member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b" })],
  }));
});

interface Opts { method?: string; body?: unknown; bearer?: string; cookie?: string; origin?: string | null }
function call(path: string, o: Opts = {}) {
  const headers: Record<string, string> = {};
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
  else headers.cookie = `__Host-bellman_session=${o.cookie ?? DEV_KEY.jesse}`;
  if (o.origin !== null) headers.origin = o.origin ?? PANEL;
  let body: string | undefined;
  if (o.body !== undefined) { body = JSON.stringify(o.body); headers["content-type"] = "application/json"; }
  return roomRoutes(new Request(`${ISSUER}${path}`, { method: o.method ?? "GET", headers, body }), deps);
}
const F = `/rooms/${ROOM}/files`;
const put = (path: string, body: unknown, o: Opts = {}, seat = "m_creator") => call(`${F}${path}?member_id=${seat}`, { method: "PUT", body, ...o });
const json = async (res: Response | undefined) => [res!.status, (await res!.json()) as Record<string, unknown>] as const;

describe("file routes", () => {
  it("writes from a dash session, reads back by path and in a listing, with a percent-encoded name", async () => {
    expect(await json(await put("/plans/a%20b.md", { content: "hi" }))).toEqual([200, { path: "/plans/a b.md", rev: 1 }]);
    const [status, file] = await json(await call(`${F}/plans/a%20b.md?member_id=m_peer`, { cookie: DEV_KEY.peer }));
    expect(status).toBe(200);
    expect(file).toMatchObject({ path: "/plans/a b.md", rev: 1, content: "hi", writer: { member_id: "m_creator", label: "jesse@codenerd" } });
    const [, list] = await json(await call(`${F}?member_id=m_creator&prefix=/plans`));
    expect(list).toEqual({ entries: [expect.objectContaining({ path: "/plans/a b.md", rev: 1 })], next: null });
    expect(JSON.stringify(list)).not.toContain("hi");
  });

  it("refuses a bearer write, a write without an allowed Origin, and an unknown member_id", async () => {
    const [s1, b1] = await json(await put("/a.md", { content: "x" }, { bearer: DEV_KEY.jesse }));
    expect([s1, b1.error]).toEqual([403, "dash_session_required"]);
    expect((await put("/a.md", { content: "x" }, { origin: "https://evil.example" }))!.status).toBe(403);
    expect((await put("/a.md", { content: "x" }, {}, "m_nobody"))!.status).toBe(404);
    expect((await store.eventsAfter(ROOM, 0)).filter((e) => e.type === "fs")).toEqual([]);
  });

  it("reads with a bearer token", async () => {
    await put("/a.md", { content: "x" });
    expect((await call(`${F}/a.md?member_id=m_creator`, { bearer: DEV_KEY.jesse }))!.status).toBe(200);
  });

  it("maps each refusal to its status: stale 409 with state, too_large and over_quota 413, forbidden 403, invalid 400, missing 404", async () => {
    await put("/a.md", { content: "x" });
    const [s, stale] = await json(await put("/a.md", { content: "y" }));
    expect(s).toBe(409);
    expect(stale).toMatchObject({ error: "stale", current_rev: 1, content: "x" });
    const [q, quota] = await json(await put("/b.md", { content: "x".repeat(30) }));
    expect([q, quota.error, quota.used, quota.ceiling]).toEqual([413, "over_quota", 1, 20]);
    expect((await put("/b.md", { content: "x" }, { cookie: DEV_KEY.peer }, "m_peer"))!.status, "peer_b lacks write_surface").toBe(403);
    expect((await put("/.bellman/room.md", { content: "x" }))!.status).toBe(403);
    // A literal ../ is resolved by the URL parser before routing; an encoded slash reaches normalizePath, which refuses it.
    expect((await put("/a%2F..%2Fb.md", { content: "x" }))!.status).toBe(400);
    expect((await put("/a.md", { body: "x" }))!.status).toBe(400);
    expect((await call(`${F}/nope.md?member_id=m_creator`))!.status).toBe(404);
  });

  it("deletes with base_rev, and refuses a delete without one", async () => {
    await put("/a.md", { content: "x" });
    expect((await call(`${F}/a.md?member_id=m_creator`, { method: "DELETE" }))!.status).toBe(400);
    expect(await json(await call(`${F}/a.md?member_id=m_creator&base_rev=1`, { method: "DELETE" }))).toEqual([200, { path: "/a.md", rev: 2 }]);
    expect((await call(`${F}/a.md?member_id=m_creator`))!.status).toBe(404);
  });
});
