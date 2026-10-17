/**
 * Public rooms on bellman.sh, D7: a reader on bellman.sh files a report with their cookie, and makes no other signed-in
 * call. A cookie caller here is the bearer caller marked `via: "cookie"`, as tests/http-bylines.test.ts makes one, so
 * the CSRF check runs as it does for a browser.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resolveIdentity } from "../src/auth.js";
import { handleRoutes } from "../src/http/handles.js";
import { moderationRoutes, type ModerationDeps } from "../src/http/moderation.js";
import type { RoomCaller } from "../src/http/rooms.js";
import { MemoryStore } from "../src/store.js";
import { member, roomManifest, session } from "./helpers/fixtures.js";
import { DEV_KEY } from "./helpers/harness.js";

const ISSUER = "https://mcp.example.test";
const PANEL = "https://dash.example.test";
const PAGE = "https://bellman.sh";
const ROOM = "qs_page_origin";
const BAN = "ban_0123456789abcdef";
/** A valid ban of a peer in the room, so a refusal of it can only be the origin's and never the body's. */
const BAN_BODY = { member_id: "m_peer", scope: "room" };

let store: MemoryStore;
let deps: ModerationDeps;
const viaCookie = async (request: Request): Promise<RoomCaller | null> => {
  const identity = resolveIdentity(request.headers.get("authorization") ?? undefined);
  return identity ? { identity, via: "cookie" } : null;
};
const peer = () => member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b" });

beforeEach(async () => {
  store = new MemoryStore();
  deps = { store, caller: viaCookie, panelOrigins: [PANEL], publicPageOrigins: [PAGE], mailReport: async () => {} };
  await store.createSession(session({ id: ROOM, manifest: roomManifest({ public: true }), members: [member(), peer()] }));
});

type Route = (r: Request) => Promise<Response | undefined>;
const send = (route: Route, method: string, path: string, origin: string, body?: unknown, key: string = DEV_KEY.outsider) =>
  route(new Request(`${ISSUER}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, origin, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
const preflight = (route: Route, path: string, origin: string) =>
  route(new Request(`${ISSUER}${path}`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" } }));
/** The origin a response grants, or null: what a browser reads to decide whether the page may use the answer. */
const grant = async (res: Promise<Response | undefined>) => (await res)!.headers.get("access-control-allow-origin");
const moderation: Route = (r) => moderationRoutes(r, deps);
const handles: Route = (r) => handleRoutes(r, { store, caller: viaCookie, panelOrigins: [PANEL] });
/** Every other moderation path: the room's bans, a ban, the creator's bans, one of them. */
const BAN_PATHS = [`/rooms/${ROOM}/bans`, `/rooms/${ROOM}/bans/${BAN}`, "/account/bans", `/account/bans/${BAN}`];

describe("bellman.sh's one signed-in write (public rooms on bellman.sh spec, D7)", () => {
  it("grants the report route's preflight to bellman.sh", async () => {
    const pre = (await preflight(moderation, `/rooms/${ROOM}/reports`, PAGE))!;
    expect([pre.status, pre.headers.get("access-control-allow-origin"), pre.headers.get("access-control-allow-credentials")]).toEqual([204, PAGE, "true"]);
  });

  it("files a report a reader on bellman.sh posts with their cookie", async () => {
    const filed = (await send(moderation, "POST", `/rooms/${ROOM}/reports`, PAGE, { reason: "harassment" }))!;
    expect([filed.status, filed.headers.get("access-control-allow-origin")]).toEqual([201, PAGE]);
    // A report about the room itself reaches the operators' queue and not the creator's list.
    expect((await store.listReports(10)).map((r) => [r.sessionId, r.reporterUserId])).toEqual([[ROOM, "u_outsider"]]);
  });

  // The list is read, not the one origin written in: with it empty, which is what the Node server passes, nothing is granted.
  it("grants nothing to an origin on neither list, or to bellman.sh when the list is empty", async () => {
    const forged = (await send(moderation, "POST", `/rooms/${ROOM}/reports`, "https://evil.example", { reason: "spam" }))!;
    expect([forged.status, forged.headers.get("access-control-allow-origin")]).toEqual([403, null]);
    const without: Route = (r) => moderationRoutes(r, { ...deps, publicPageOrigins: [] });
    expect(await grant(preflight(without, `/rooms/${ROOM}/reports`, PAGE))).toBeNull();
    const refused = (await send(without, "POST", `/rooms/${ROOM}/reports`, PAGE, { reason: "spam" }))!;
    expect([refused.status, refused.headers.get("access-control-allow-origin")]).toEqual([403, null]);
    expect(await store.listReports(10)).toEqual([]);
  });

  // Review Focus 8.
  it("refuses bellman.sh every other signed-in call: the creator's list of reports, a ban, a handle", async () => {
    const listed = (await send(moderation, "GET", `/rooms/${ROOM}/reports`, PAGE, undefined, DEV_KEY.jesse))!;
    expect(listed.headers.get("access-control-allow-origin")).toBeNull();
    expect((await send(moderation, "POST", `/rooms/${ROOM}/bans`, PAGE, BAN_BODY, DEV_KEY.jesse))!.status).toBe(403);
    expect(await store.roomBans(ROOM)).toEqual([]);
    expect((await send(handles, "PUT", "/account/handle", PAGE, { handle: "page-write" }, DEV_KEY.jesse))!.status).toBe(403);
    expect(await store.handleOf("u_jesse")).toBeUndefined();
  });

  it("grants bellman.sh no preflight on the other routes, and no grant on the report route's other methods", async () => {
    for (const path of BAN_PATHS) expect(await grant(preflight(moderation, path, PAGE)), path).toBeNull();
    expect(await grant(preflight(handles, "/account/handle", PAGE))).toBeNull();
    for (const method of ["PUT", "DELETE"]) {
      expect(await grant(send(moderation, method, `/rooms/${ROOM}/reports`, PAGE, undefined, DEV_KEY.jesse)), method).toBeNull();
    }
  });

  // The control for the refusals above: the same calls from the panel pass the origin check.
  it("still serves the panel those calls", async () => {
    const listed = (await send(moderation, "GET", `/rooms/${ROOM}/reports`, PANEL, undefined, DEV_KEY.jesse))!;
    expect([listed.status, listed.headers.get("access-control-allow-origin")]).toEqual([200, PANEL]);
    expect((await send(moderation, "POST", `/rooms/${ROOM}/bans`, PANEL, BAN_BODY, DEV_KEY.jesse))!.status).toBe(200);
    expect(await store.roomBans(ROOM)).toHaveLength(1);
    expect((await send(handles, "PUT", "/account/handle", PANEL, { handle: "panel-write" }, DEV_KEY.jesse))!.status).toBe(200);
    expect(await store.handleOf("u_jesse")).toBe("panel-write");
    for (const path of BAN_PATHS) expect(await grant(preflight(moderation, path, PANEL)), path).toBe(PANEL);
    expect(await grant(preflight(handles, "/account/handle", PANEL))).toBe(PANEL);
    // The report route serves both origins: the panel's Report button is not displaced.
    const filed = (await send(moderation, "POST", `/rooms/${ROOM}/reports`, PANEL, { reason: "spam" }))!;
    expect([filed.status, filed.headers.get("access-control-allow-origin")]).toEqual([201, PANEL]);
  });
});
