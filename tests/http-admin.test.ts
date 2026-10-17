/**
 * The operator's routes (abuse protections spec D3): suspensions and the report queue, for a user id
 * BELLMAN_OPERATORS lists, over a bearer token and never a cookie, as /admin/handles is (ADR 0021).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_REPORTS_LISTED, type OAuthConfig } from "../src/oauth/routes.js";
import { ACCESS_TOKEN_TTL_SECONDS, signJwt } from "../src/oauth/tokens.js";
import type { Report } from "../src/reports.js";
import { MemoryStore } from "../src/store.js";
import type { Identity } from "../src/types.js";
import { COOKIE, ISSUER, PANEL, panelConfig, routeWith, seedSession } from "./helpers/panel.js";

const OPERATOR: Identity = { userId: "u_operator", orgId: null, plan: "free", role: "member", label: "ops@example.dev" };
const TEAM_ADMIN: Identity = { userId: "u_team_admin", orgId: "org_ops", plan: "team", role: "admin", label: "admin@example.dev" };
let store: MemoryStore;
let cfg: OAuthConfig;
let route: (request: Request) => Promise<Response>;

beforeEach(() => {
  store = new MemoryStore();
  cfg = panelConfig({ plans: store, operators: new Set([OPERATOR.userId]) });
  route = routeWith(cfg);
});

const bearer = async (identity: Identity, planSource = "default") => ({
  authorization: `Bearer ${await signJwt(
    { iss: ISSUER, sub: identity.userId, aud: cfg.resource, bellman: identity, plan_source: planSource },
    cfg.secret, ACCESS_TOKEN_TTL_SECONDS,
  )}`,
});
const send = (method: string, path: string, headers: Record<string, string>, body?: unknown, on = route) => on(new Request(`${ISSUER}${path}`, {
  method,
  headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
  body: body === undefined ? undefined : JSON.stringify(body),
}));

describe("/admin/suspensions/:userId", () => {
  it("suspends with a note and lifts, for a user id the list names", async () => {
    const auth = await bearer(OPERATOR);
    const res = await send("POST", "/admin/suspensions/u_peer", auth, { note: " spam in three rooms " });
    expect([res.status, await res.json()]).toEqual([200, { user_id: "u_peer", note: "spam in three rooms", suspended_at: expect.any(String) }]);
    expect(await store.isSuspended("u_peer")).toBe(true);
    expect((await send("DELETE", "/admin/suspensions/u_peer", auth)).status).toBe(204);
    expect((await send("DELETE", "/admin/suspensions/u_peer", auth)).status).toBe(404);
    expect(await store.isSuspended("u_peer")).toBe(false);
  });

  it("asks for a note and a user id's shape, and suspends nobody without them", async () => {
    const auth = await bearer(OPERATOR);
    for (const body of [undefined, {}, { note: "" }, { note: "   " }, { note: "x".repeat(501) }]) {
      expect((await send("POST", "/admin/suspensions/u_peer", auth, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await send("POST", "/admin/suspensions/github%3A4242", auth, { note: "x" })).status).toBe(400);
    expect(await store.isSuspended("u_peer")).toBe(false);
  });

  it("takes POST and DELETE alone, and reads a segment that is not a percent-encoding as a 400", async () => {
    const auth = await bearer(OPERATOR);
    const get = await send("GET", "/admin/suspensions/u_peer", auth);
    expect([get.status, get.headers.get("allow")]).toEqual([405, "POST, DELETE"]);
    expect((await send("POST", "/admin/suspensions/u_%E0%A4%A", auth, { note: "x" })).status).toBe(400);
    expect((await send("DELETE", "/admin/suspensions/u_%E0%A4%A", auth)).status).toBe(400);
  });

  // Fail closed (spec section 4): no list, an empty one, a team admin BELLMAN_USERS made, a cookie and no credential.
  it("lets no one else through, and suspends nobody", async () => {
    for (const operators of [undefined, new Set<string>()]) {
      const closed = routeWith(panelConfig({ plans: store, operators }));
      expect((await send("POST", "/admin/suspensions/u_peer", await bearer(OPERATOR), { note: "x" }, closed)).status).toBe(403);
    }
    expect((await send("POST", "/admin/suspensions/u_peer", await bearer(TEAM_ADMIN, "operator"), { note: "x" })).status).toBe(403);
    const sid = await seedSession(cfg, "ops-sid", { identity: OPERATOR, plan_source: "default" });
    expect((await send("POST", "/admin/suspensions/u_peer", { cookie: `${COOKIE}=${sid}`, origin: PANEL }, { note: "x" })).status).toBe(401);
    expect((await send("POST", "/admin/suspensions/u_peer", {}, { note: "x" })).status).toBe(401);
    expect(await store.isSuspended("u_peer")).toBe(false);
  });
});

describe("/admin/reports and /admin/reports/:id/resolve", () => {
  const file = async () => ((await store.fileReport({
    sessionId: "qs_1", creatorId: "u_jesse", target: { kind: "room" }, subject: null, reason: "illegal",
    note: "see the surface", reporterUserId: "u_reader", reporterLabel: "reader@example.dev",
  }, Date.now())) as { report: Report }).report;

  it("lists every report with who filed it, a room report included, and resolves one with a note", async () => {
    const report = await file();
    const auth = await bearer(OPERATOR);
    const listed = await send("GET", "/admin/reports", auth);
    expect([listed.status, await listed.json()]).toEqual([200, { reports: [expect.objectContaining({
      id: report.id, session_id: "qs_1", target: { kind: "room" }, about: null, reason: "illegal", note: "see the surface",
      filed_by: { user_id: "u_reader", label: "reader@example.dev" }, resolved_at: null,
    })] }]);
    expect((await send("POST", `/admin/reports/${report.id}/resolve`, auth, { note: "" })).status).toBe(400);
    const resolved = await send("POST", `/admin/reports/${report.id}/resolve`, auth, { note: "removed the item" });
    expect([resolved.status, await resolved.json()]).toEqual([200, { report: expect.objectContaining({
      id: report.id, resolution: "removed the item", resolved_by: "u_operator", resolved_at: expect.any(String),
    }) }]);
    expect((await send("POST", "/admin/reports/rpt_000000000000000_00000000/resolve", auth, { note: "x" })).status).toBe(404);
  });

  it("lets no one else read or resolve the queue", async () => {
    const report = await file();
    for (const operators of [undefined, new Set<string>()]) {
      const closed = routeWith(panelConfig({ plans: store, operators }));
      expect((await send("GET", "/admin/reports", await bearer(OPERATOR), undefined, closed)).status).toBe(403);
    }
    expect((await send("GET", "/admin/reports", await bearer(TEAM_ADMIN, "operator"))).status).toBe(403);
    expect((await send("POST", `/admin/reports/${report.id}/resolve`, await bearer(TEAM_ADMIN, "operator"), { note: "x" })).status).toBe(403);
    expect((await store.listReports(10))[0].resolvedAt).toBeNull();
  });

  it("admits a bearer token alone: a panel cookie or no credential is 401 at both routes, and resolves nothing", async () => {
    const report = await file();
    const sid = await seedSession(cfg, "ops-sid", { identity: OPERATOR, plan_source: "default" });
    const refused: Record<string, string>[] = [{ cookie: `${COOKIE}=${sid}`, origin: PANEL }, {}];
    for (const headers of refused) {
      expect((await send("GET", "/admin/reports", headers)).status, JSON.stringify(headers)).toBe(401);
      expect((await send("POST", `/admin/reports/${report.id}/resolve`, headers, { note: "x" })).status, JSON.stringify(headers)).toBe(401);
    }
    expect((await store.listReports(10))[0].resolvedAt).toBeNull();
  });

  it("takes GET at the queue and POST at a resolution, and answers 405 with the method each takes", async () => {
    const auth = await bearer(OPERATOR);
    const queue = await send("POST", "/admin/reports", auth, {});
    const resolution = await send("GET", "/admin/reports/rpt_000000000000000_00000000/resolve", auth);
    expect([queue.status, queue.headers.get("allow")]).toEqual([405, "GET"]);
    expect([resolution.status, resolution.headers.get("allow")]).toEqual([405, "POST"]);
  });

  it("answers 501 when the server has no plan store, once the gate has passed and before the body is read", async () => {
    const bare = routeWith(panelConfig({ plans: undefined, operators: new Set([OPERATOR.userId]) }));
    expect((await send("GET", "/admin/reports", await bearer(OPERATOR), undefined, bare)).status).toBe(501);
    expect((await send("POST", "/admin/reports/rpt_000000000000000_00000000/resolve", await bearer(OPERATOR), undefined, bare)).status).toBe(501);
    expect((await send("GET", "/admin/reports", await bearer(TEAM_ADMIN, "operator"), undefined, bare)).status, "the gate first").toBe(403);
  });

  it("takes a note of 1 to 500 characters, trimmed, and resolves nothing for any other body", async () => {
    const report = await file();
    const resolve = async (body?: unknown) => send("POST", `/admin/reports/${report.id}/resolve`, await bearer(OPERATOR), body);
    for (const body of [undefined, {}, { note: "" }, { note: "   " }, { note: 5 }, { note: "x".repeat(501) }, { note: ` ${"x".repeat(501)} ` }]) {
      expect((await resolve(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await store.listReports(10))[0].resolvedAt, "none of those resolved it").toBeNull();
    const ok = await resolve({ note: ` ${"x".repeat(500)} ` });
    expect([ok.status, ((await ok.json()) as { report: { resolution: string } }).report.resolution]).toEqual([200, "x".repeat(500)]);
  });

  it("answers a second resolution with the first, which stands", async () => {
    const report = await file();
    const auth = await bearer(OPERATOR);
    await send("POST", `/admin/reports/${report.id}/resolve`, auth, { note: "first" });
    const again = await send("POST", `/admin/reports/${report.id}/resolve`, auth, { note: "second" });
    expect([again.status, await again.json()]).toEqual([200, { report: expect.objectContaining({ resolution: "first" }) }]);
  });

  it("lists at most MAX_REPORTS_LISTED reports, the newest first", async () => {
    for (let i = 0; i <= MAX_REPORTS_LISTED; i++) {
      await store.fileReport({
        sessionId: "qs_1", creatorId: "u_jesse", target: { kind: "room" }, subject: null, reason: "spam",
        note: null, reporterUserId: `u_reader_${i}`, reporterLabel: `reader${i}@example.dev`,
      }, 1_000 + i);
    }
    const { reports } = (await (await send("GET", "/admin/reports", await bearer(OPERATOR))).json()) as { reports: { at: string }[] };
    expect(reports).toHaveLength(MAX_REPORTS_LISTED);
    expect(reports[0].at).toBe(new Date(1_000 + MAX_REPORTS_LISTED).toISOString());
    expect(reports[reports.length - 1].at, "the oldest is the one left off").toBe(new Date(1_001).toISOString());
  });
});
