/**
 * The notes-sharing route (ADR 0047 decision 7, #538) over MemoryStore: a dash session turns an account's room-notes
 * sharing on or off in a room it has a seat in; a bearer reads it and never writes it. Driven directly, a web Request
 * in and a Response out, as tests/http-config.test.ts.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resolveIdentity } from "../src/auth.js";
import { MemoryBlobStore } from "../src/blobs.js";
import { roomRoutes, type RoomCaller, type RoomRouteDeps } from "../src/http/rooms.js";
import { leaveRoom, readFsFor, writeFs } from "../src/rooms.js";
import { MemoryStore } from "../src/store.js";
import type { Identity } from "../src/types.js";
import { member, session } from "./helpers/fixtures.js";
import { DEV_KEY } from "./helpers/harness.js";

const ISSUER = "https://mcp.example.test";
const PANEL = "https://dash.example.test";
const ROOM = "qs_ns";
const ROUTE = `/rooms/${ROOM}/notes-sharing`;

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
    id: ROOM, members: [member(), member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b" })],
  }));
});

interface Opts { method?: string; body?: unknown; bearer?: string; cookie?: string; origin?: string | null }

/** A dash request: jesse's cookie and the panel's Origin unless told otherwise. */
function call(path: string, o: Opts = {}) {
  const headers: Record<string, string> = {};
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
  else headers.cookie = `__Host-bellman_session=${o.cookie ?? DEV_KEY.jesse}`;
  if (o.origin !== null) headers.origin = o.origin ?? PANEL;
  let body: string | undefined;
  if (o.body !== undefined) { body = JSON.stringify(o.body); headers["content-type"] = "application/json"; }
  return roomRoutes(new Request(`${ISSUER}${path}`, { method: o.method ?? "GET", headers, body }), deps);
}
const put = (shared: unknown, o: Opts = {}) => call(ROUTE, { method: "PUT", body: { shared }, ...o });
const bodyOf = async (res: Response | undefined) => (await res!.json()) as Record<string, unknown>;

const JESSE: Identity = { userId: "u_jesse", label: "jesse@codenerd", orgId: "org_codenerd", plan: "team", role: "member" };
const PEER: Identity = { userId: "u_peer", label: "peer@codenerd", orgId: "org_codenerd", plan: "team", role: "member" };

describe("GET and PUT /rooms/:id/notes-sharing", () => {
  it("reads off, turns on from a dash session so a peer reads the notes, and off again", async () => {
    const wrote = await writeFs(store, JESSE, ROOM, "m_creator", { path: "/members/me/n.md", write: { op: "write", content: "mine" } });
    const path = wrote.ok ? wrote.value.path : "";
    expect(await bodyOf(await call(ROUTE))).toEqual({ shared: false });
    expect(await bodyOf(await call(ROUTE, { bearer: DEV_KEY.jesse })), "a bearer reads it").toEqual({ shared: false });
    expect(await readFsFor(store, PEER, ROOM, "m_peer", path)).toMatchObject({ ok: false, code: "not_found" });

    const on = (await put(true))!;
    expect([on.status, await bodyOf(on)]).toEqual([200, { shared: true }]);
    expect(await bodyOf(await call(ROUTE, { bearer: DEV_KEY.jesse }))).toEqual({ shared: true });
    expect(await bodyOf(await call(ROUTE, { cookie: DEV_KEY.peer })), "the peer's own switch is its own").toEqual({ shared: false });
    expect(await readFsFor(store, PEER, ROOM, "m_peer", path)).toMatchObject({ ok: true, value: { content: "mine" } });

    const off = (await put(false))!;
    expect([off.status, await bodyOf(off)]).toEqual([200, { shared: false }]);
    expect(await readFsFor(store, PEER, ROOM, "m_peer", path)).toMatchObject({ ok: false, code: "not_found" });
  });

  it("refuses the write with a bearer, without the panel's Origin, with any other body, from a stranger, and anonymously", async () => {
    const bearer = (await put(true, { bearer: DEV_KEY.jesse }))!;
    expect([bearer.status, (await bodyOf(bearer)).error]).toEqual([403, "dash_session_required"]);
    expect((await put(true, { origin: null }))!.status).toBe(403);
    for (const body of ["yes", { shared: true, pause: true }, {}, null]) {
      const res = (await call(ROUTE, { method: "PUT", body }))!;
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await put(true, { cookie: DEV_KEY.outsider }))!.status, "no seat in the room").toBe(404);
    expect((await call(ROUTE, { cookie: DEV_KEY.outsider }))!.status).toBe(404);
    expect((await call(`/rooms/qs_nope/notes-sharing`))!.status).toBe(404);
    const anon = await roomRoutes(new Request(`${ISSUER}${ROUTE}`, { method: "PUT", body: "{}", headers: { "content-type": "application/json" } }), deps);
    expect(anon!.status).toBe(401);
    expect((await call(ROUTE, { method: "DELETE" }))!.headers.get("allow")).toBe("GET, PUT");
    expect(await store.notesSharers(ROOM)).toEqual([]);
  });

  it("lets a departed seat's account turn sharing off", async () => {
    await put(true);
    expect((await leaveRoom(store, JESSE, ROOM, "m_creator")).ok).toBe(true);
    const off = (await put(false))!;
    expect([off.status, await bodyOf(off)]).toEqual([200, { shared: false }]);
  });
});
