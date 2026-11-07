/**
 * The governed config routes (#414) over MemoryStore: a dash session on a seat whose role holds `govern` writes;
 * nothing else does. Driven directly, a web Request in and a Response out, as tests/http-rooms.test.ts.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resolveIdentity } from "../src/auth.js";
import { MemoryBlobStore } from "../src/files/blobs.js";
import { roomRoutes, type RoomCaller, type RoomRouteDeps } from "../src/http/rooms.js";
import { MemoryStore } from "../src/storage/memory-store.js";
import { member, session } from "./helpers/fixtures.js";
import { DEV_KEY } from "./helpers/harness.js";

const ISSUER = "https://mcp.example.test";
const PANEL = "https://dash.example.test";
const ROOM = "qs_config";

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
  // jesse is peer_a, the pair preset's creator role, which holds govern; peer is peer_b, which does not.
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

const CFG = `/rooms/${ROOM}/config/room_instructions`;
const put = (markdown: string, baseRev: number, o: Opts = {}, seat = "m_creator") =>
  call(`${CFG}?member_id=${seat}`, { method: "PUT", body: { body: { markdown }, base_rev: baseRev }, ...o });
const bodyOf = async (res: Response | undefined) => (await res!.json()) as Record<string, unknown>;
const configEvents = async () => (await store.eventsAfter(ROOM, 0)).filter((e) => e.type === "config_changed");

describe("PUT /rooms/:id/config/:name", () => {
  it("writes from a dash session on a seat holding govern, and reads back with its approver", async () => {
    const res = (await put("Be terse.", 0))!;
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(await bodyOf(res)).toEqual({ name: "room_instructions", rev: 1 });
    const read = await bodyOf(await call(`${CFG}?member_id=m_creator`));
    expect(read).toMatchObject({ name: "room_instructions", rev: 1, body: { markdown: "Be terse." }, approver: { member_id: "m_creator", label: "jesse@codenerd" } });
    expect(JSON.stringify(read)).not.toContain("u_jesse");
  });

  it("refuses a bearer caller even on a seat holding govern, before anything is written", async () => {
    const res = (await put("Be terse.", 0, { bearer: DEV_KEY.jesse }))!;
    expect(res.status).toBe(403);
    expect(await bodyOf(res)).toMatchObject({ error: "dash_session_required" });
    expect(await configEvents()).toEqual([]);
    expect(await store.getConfigRow(ROOM, "room_instructions")).toBeNull();
  });

  it("refuses a cookie write without the panel's Origin", async () => {
    expect((await put("Be terse.", 0, { origin: null }))!.status).toBe(403);
    expect(await configEvents()).toEqual([]);
  });

  it("refuses a seat whose role lacks govern", async () => {
    const res = (await put("Be terse.", 0, { cookie: DEV_KEY.peer }, "m_peer"))!;
    expect(res.status).toBe(403);
    expect(await bodyOf(res)).toMatchObject({ error: "forbidden" });
  });

  it("refuses a seat that is not the caller's as an unknown room", async () => {
    expect((await put("Be terse.", 0, { cookie: DEV_KEY.peer }, "m_creator"))!.status).toBe(404);
  });

  it("refuses a body carrying governance, and a name outside the closed set", async () => {
    const forged = (await call(`${CFG}?member_id=m_creator`, {
      method: "PUT", body: { body: { markdown: "x", governance: { approvedBy: "u_other" } }, base_rev: 0 },
    }))!;
    expect(forged.status).toBe(400);
    const unknown = (await call(`/rooms/${ROOM}/config/judge.consent?member_id=m_creator`, { method: "PUT", body: { body: {}, base_rev: 0 } }))!;
    expect(unknown.status).toBe(400);
    expect(await configEvents()).toEqual([]);
  });

  it("refuses a stale base_rev with the current revision", async () => {
    await put("first", 0);
    const res = (await put("second", 0))!;
    expect(res.status).toBe(409);
    expect(await bodyOf(res)).toMatchObject({ error: "stale", current_rev: 1 });
  });

  it("refuses a frozen room", async () => {
    await store.freezeSession(ROOM, Date.now());
    const res = (await put("Be terse.", 0))!;
    expect(res.status).toBe(409);
    expect(await bodyOf(res)).toMatchObject({ error: "frozen" });
  });
});

describe("history and restore", () => {
  it("lists revisions without bodies, reads one by rev, and restores an old one as a new revision", async () => {
    await put("one", 0);
    await put("two", 1);
    const history = await bodyOf(await call(`${CFG}/history?member_id=m_creator`));
    expect((history.revisions as { rev: number }[]).map((r) => r.rev)).toEqual([2, 1]);
    expect(JSON.stringify(history)).not.toContain("one");
    expect(await bodyOf(await call(`${CFG}/history?member_id=m_creator&rev=1`))).toMatchObject({ rev: 1, body: { markdown: "one" } });

    const restored = (await call(`${CFG}/restore?member_id=m_creator`, { method: "POST", body: { rev: 1, base_rev: 2 } }))!;
    expect(restored.status).toBe(200);
    expect(await bodyOf(restored)).toEqual({ name: "room_instructions", rev: 3 });
    expect((await store.getConfigRow(ROOM, "room_instructions"))?.body).toEqual({ markdown: "one" });
  });

  it("refuses a bearer restore", async () => {
    await put("one", 0);
    const res = (await call(`${CFG}/restore?member_id=m_creator`, { method: "POST", body: { rev: 1, base_rev: 1 }, bearer: DEV_KEY.jesse }))!;
    expect(res.status).toBe(403);
  });
});

describe("GET /rooms/:id/config/:name", () => {
  it("reads as nothing before the first write, for any seat in the room", async () => {
    expect(await bodyOf(await call(`${CFG}?member_id=m_peer`, { cookie: DEV_KEY.peer }))).toEqual({ name: "room_instructions", rev: 0, body: null, approver: null });
  });
});
