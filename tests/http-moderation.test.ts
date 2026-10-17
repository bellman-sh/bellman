/**
 * The moderation routes (abuse protections spec, sections 1 and 3): a room's bans and reports for its
 * creator, a creator's bans across their rooms, and a report from anyone the room admits. Over one MemoryStore.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveIdentity } from "../src/auth.js";
import { MAX_BAN_BYTES, MAX_REPORT_BYTES, moderationRoutes } from "../src/http/moderation.js";
import type { RoomCaller } from "../src/http/rooms.js";
import { MemoryStore } from "../src/store.js";
import { member, roomManifest, session } from "./helpers/fixtures.js";
import { DEV_KEY } from "./helpers/harness.js";

const ISSUER = "https://mcp.example.test";
const PANEL = "https://dash.example.test";
const ROOM = "qs_mod";
let store: MemoryStore;
/** The ids of the reports the route handed to its mailer, in order. */
let mailed: string[];

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
  mailed = [];
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
  }), { store, caller, panelOrigins: [PANEL], mailReport: async (r) => { mailed.push(r.id); } });
}
const answer =async (res: Response | undefined) => [res!.status, await res!.json().catch(() => null)];

describe("the moderation routes", () => {
  it("leave every other path to the next module", async () => {
    for (const path of [`/rooms/${ROOM}`, `/rooms/${ROOM}/surface`, `/rooms/${ROOM}/reports/extra`, "/account", "/account/handle", "/admin/reports"]) {
      expect(await call(DEV_KEY.jesse, path), path).toBeUndefined();
    }
  });
});

describe("a room's bans", () => {
  it("bans a member for the creator, lists the ban by label and time with no user id, and lifts it", async () => {
    const banned = await call(DEV_KEY.jesse, `/rooms/${ROOM}/bans`, { method: "POST", body: { member_id: "m_peer", scope: "room" } });
    expect(await answer(banned)).toEqual([200, { evicted: true, code_retired: "peer_b", session_status: "active", banned: "room", also_removed_from: 0 }]);
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

describe("a room's reports", () => {
  const report = (key: string | null, body: unknown, over: { cookie?: string; origin?: string } = {}) =>
    call(key, `/rooms/${ROOM}/reports`, { method: "POST", body, ...over });

  it("files a public room reader's report, mails it once, and shows the creator what it is about and never who filed it", async () => {
    const filed = await report(DEV_KEY.outsider, { member_id: "m_peer", reason: "harassment", note: "<b>not markup</b>" });
    const [status, made] = await answer(filed);
    expect([status, made]).toEqual([201, { report_id: expect.stringMatching(/^rpt_/), folded: false }]);
    expect(mailed).toEqual([(made as { report_id: string }).report_id]);
    const [listed, body] = await answer(await call(DEV_KEY.jesse, `/rooms/${ROOM}/reports`));
    expect(listed).toBe(200);
    expect(body).toEqual({ reports: [{
      id: expect.stringMatching(/^rpt_/), target: { kind: "member", member_id: "m_peer" }, about: { member_id: "m_peer", label: "peer@codenerd" },
      reason: "harassment", note: "<b>not markup</b>", at: expect.any(String), resolved: false,
    }] });
    expect(JSON.stringify(body)).not.toContain("outsider");
  });

  it("folds a repeat: 200, the first report's id, and no second email", async () => {
    const [, first] = await answer(await report(DEV_KEY.peer, { reason: "spam" }));
    expect(await answer(await report(DEV_KEY.peer, { reason: "spam", note: "again" })))
      .toEqual([200, { report_id: (first as { report_id: string }).report_id, folded: true }]);
    expect(mailed).toHaveLength(1);
  });

  it("answers the eleventh report in a day 429 with Retry-After, and files nothing for it", async () => {
    for (let i = 0; i < 8; i++) {
      await store.appendEvent(ROOM, { type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: { text: `m${i}` }, refId: null });
    }
    const targets = [{}, { member_id: "m_peer" }, { member_id: "m_creator" }, ...[1, 2, 3, 4, 5, 6, 7].map((cursor) => ({ cursor }))];
    for (const t of targets) expect((await report(DEV_KEY.peer, { ...t, reason: "spam" }))!.status, JSON.stringify(t)).toBe(201);
    const limited = (await report(DEV_KEY.peer, { cursor: 8, reason: "spam" }))!;
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(86_000);
    expect(await store.listReports(50)).toHaveLength(10);
    // The wait is in the body too, the same whole seconds, for a client that cannot read the header.
    expect(await limited.json()).toEqual({
      error: "rate_limited", error_description: expect.stringContaining("10 reports"), retry_after: Number(limited.headers.get("retry-after")),
    });
    expect(mailed, "ten filed and mailed, the eleventh not").toHaveLength(10);
    // The panel reads this refusal for its wait, so it carries the panel's CORS grant as every answer of the route does.
    const forPanel = (await report(DEV_KEY.peer, { cursor: 8, reason: "spam" }, { origin: PANEL }))!;
    expect([forPanel.status, forPanel.headers.get("access-control-allow-origin")]).toEqual([429, PANEL]);
  });

  it("refuses a stranger to a private room as it refuses a missing one, a target the room lacks, and a cookie report without the panel's Origin, filing nothing", async () => {
    await store.createSession(session({ id: "qs_private", members: [member(), peer()] }));
    await store.appendEvent(ROOM, { type: "invite_revoked", fromMemberId: "system", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: {}, refId: null });
    const asStranger = async (room: string) =>
      answer(await call(DEV_KEY.outsider, `/rooms/${room}/reports`, { method: "POST", body: { reason: "spam" } }));
    const [refusedStatus, refusedBody] = await asStranger("qs_private");
    expect(refusedStatus).toBe(404);
    expect(await asStranger("qs_nowhere"), "the answer for a room that is not there, word for word").toEqual([refusedStatus, refusedBody]);
    for (const body of [
      { member_id: "m_nobody", reason: "spam" }, { cursor: 99, reason: "spam" }, { cursor: 1, reason: "spam" },
      { reason: "rude" }, { member_id: "m_peer", cursor: 1, reason: "spam" }, { reason: "spam", note: "x".repeat(501) },
    ]) {
      expect((await report(DEV_KEY.peer, body))!.status, JSON.stringify(body)).toBe(400);
    }
    expect((await report(null, { reason: "spam" }, { cookie: DEV_KEY.peer }))!.status).toBe(403);
    expect((await report(null, { reason: "spam" }))!.status).toBe(401);
    expect(await store.listReports(50)).toEqual([]);
    expect(mailed).toEqual([]);
  });

  it("shows a room's reports to its creator alone", async () => {
    const [status, refused] = await answer(await call(DEV_KEY.peer, `/rooms/${ROOM}/reports`));
    expect([status, refused]).toEqual([403, { error: "forbidden", error_description: expect.stringContaining("reports") }]);
    expect((await call(DEV_KEY.outsider, `/rooms/${ROOM}/reports`))!.status).toBe(404);
    // A room that is not public answers a stranger as it answers a room that is not there.
    await store.createSession(session({ id: "qs_private", members: [member(), peer()] }));
    const asStranger = async (room: string) => answer(await call(DEV_KEY.outsider, `/rooms/${room}/reports`));
    const [refusedStatus, refusedBody] = await asStranger("qs_private");
    expect(refusedStatus).toBe(404);
    expect(await asStranger("qs_nowhere"), "the answer for a room that is not there, word for word").toEqual([refusedStatus, refusedBody]);
    expect((await call(null, `/rooms/${ROOM}/reports`))!.status).toBe(401);
  });
});

describe("the report route's rules", () => {
  const PATH = `/rooms/${ROOM}/reports`;
  const raw = (path: string, init: RequestInit) => moderationRoutes(new Request(`${ISSUER}${path}`, init), {
    store, caller, panelOrigins: [PANEL], mailReport: async (r) => { mailed.push(r.id); },
  });
  const bearer = { authorization: `Bearer ${DEV_KEY.peer}` };
  const post = (body: string, headers: Record<string, string> = {}) =>
    raw(PATH, { method: "POST", headers: { ...bearer, "content-type": "application/json", ...headers }, body });

  afterEach(() => vi.restoreAllMocks());

  it("answers the panel's preflight with a grant for POST, and a stranger's with none", async () => {
    const panel = (await raw(PATH, { method: "OPTIONS", headers: { origin: PANEL } }))!;
    expect([panel.status, panel.headers.get("access-control-allow-origin")]).toEqual([204, PANEL]);
    expect(panel.headers.get("access-control-allow-methods")?.split(/,\s*/)).toEqual(expect.arrayContaining(["POST"]));
    const stranger = (await raw(PATH, { method: "OPTIONS", headers: { origin: "https://elsewhere.example.test" } }))!;
    expect([stranger.status, stranger.headers.get("access-control-allow-origin")]).toEqual([204, null]);
  });

  it("answers 405 with the methods the path takes", async () => {
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const res = (await raw(PATH, { method, headers: bearer }))!;
      expect([method, res.status, res.headers.get("allow")]).toEqual([method, 405, "GET, POST"]);
    }
  });

  it("refuses a report over the bound before reading it, takes one at the bound, and refuses a body that is not JSON", async () => {
    const fine = JSON.stringify({ reason: "spam" });
    expect((await post(fine, { "content-length": String(MAX_REPORT_BYTES + 1) }))!.status).toBe(413);
    expect((await post(fine, { "content-length": String(16 * 1024) }))!.status, "a report is small: 16 KB is far over").toBe(413);
    expect((await post(fine, { "content-length": "garbage" }))!.status).toBe(400);
    expect((await post("not json"))!.status).toBe(400);
    expect(await store.listReports(50), "none of those filed").toEqual([]);
    expect((await post(fine, { "content-length": String(MAX_REPORT_BYTES) }))!.status, "the control: the bound itself is accepted").toBe(201);
  });

  // The bound's reason, as a behavior rather than a number: JSON writes a control character as six bytes (\u0001), so a note of
  // 500 of them is the largest legal report, about 3 KB. A bound below that would refuse a report the route promises to take.
  it("takes the largest legal report: a note of 500 characters that JSON writes in six bytes each", async () => {
    const body = JSON.stringify({ reason: "spam", note: "\u{1}".repeat(500) });
    const bytes = new TextEncoder().encode(body).length;
    expect(bytes).toBeGreaterThan(3000);
    const res = (await post(body, { "content-length": String(bytes) }))!;
    expect([res.status, await res.json()]).toEqual([201, { report_id: expect.stringMatching(/^rpt_/), folded: false }]);
    expect(mailed).toHaveLength(1);
  });

  it("takes a body of the right shape alone: member_id a string, cursor a number, reason a string, note a string", async () => {
    for (const body of [
      "null", "[]", "5", '"spam"', "{}", '{"reason":5}',
      '{"reason":"spam","member_id":5}', '{"reason":"spam","member_id":null}',
      '{"reason":"spam","cursor":"1"}', '{"reason":"spam","cursor":null}',
      '{"reason":"spam","note":5}', '{"reason":"spam","note":null}',
    ]) {
      const res = (await post(body))!;
      expect([body, res.status, ((await res.json()) as { error: string }).error]).toEqual([body, 400, "invalid_request"]);
    }
    expect(await store.listReports(50)).toEqual([]);
    expect(mailed).toEqual([]);
  });

  it("answers a failing store with the route's own 500, mails nothing, and logs the cause", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(store, "fileReport").mockRejectedValue(new Error("storage is down"));
    expect(await answer(await call(DEV_KEY.peer, PATH, { method: "POST", body: { reason: "spam" } }))).toMatchObject([500, { error: "internal" }]);
    expect(logged.mock.calls.flat().join(" ")).toContain("storage is down");
    expect(mailed).toEqual([]);
  });

  it("files a cookie caller's report once it carries the panel's Origin, answers with the panel's grant, and reads the creator's list with no Origin", async () => {
    const res = (await call(null, PATH, { method: "POST", cookie: DEV_KEY.outsider, origin: PANEL, body: { member_id: "m_peer", reason: "spam" } }))!;
    expect([res.status, res.headers.get("access-control-allow-origin")]).toEqual([201, PANEL]);
    expect(mailed).toHaveLength(1);
    expect((await call(null, PATH, { cookie: DEV_KEY.jesse }))!.status, "a read needs no Origin").toBe(200);
  });
});
