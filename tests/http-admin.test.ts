/**
 * The operator's routes (abuse protections spec D3): suspensions and the report queue, for a user id
 * BELLMAN_OPERATORS lists, over a bearer token and never a cookie, as /admin/handles is (ADR 0021).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_ACCOUNTS_LISTED, MAX_BACKFILL_WINDOW, MAX_REPORTS_LISTED, type OAuthConfig } from "../src/oauth/routes.js";
import { ACCESS_TOKEN_TTL_SECONDS, signJwt } from "../src/oauth/tokens.js";
import type { Report } from "../src/reports.js";
import { MemoryStore } from "../src/store.js";
import { DEFAULT_POLICY, type Identity } from "../src/types.js";
import { policyView } from "../src/orgs.js";
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

describe("/admin/accounts", () => {
  const seed = async () => {
    await store.recordSignIn("u_google_2", Date.UTC(2026, 9, 3), undefined, "two@example.dev");
    await store.recordSignIn("u_github_9", Date.UTC(2026, 9, 1), "octo");
    await store.recordSignIn("u_github_9", Date.UTC(2026, 9, 20));
  };

  it("lists accounts by first sign-in, with the total, an id, two dates and a GitHub login each and nothing else", async () => {
    await seed();
    const res = await send("GET", "/admin/accounts", await bearer(OPERATOR));
    expect([res.status, await res.json()]).toEqual([200, {
      total: 2,
      accounts: [
        { user_id: "u_github_9", first_seen_at: "2026-10-01T00:00:00.000Z", last_seen_at: "2026-10-20T00:00:00.000Z", github_login: "octo", google_email: null },
        { user_id: "u_google_2", first_seen_at: "2026-10-03T00:00:00.000Z", last_seen_at: "2026-10-03T00:00:00.000Z", github_login: null, google_email: "two@example.dev" },
      ],
    }]);
    const one = await (await send("GET", "/admin/accounts?limit=1", await bearer(OPERATOR))).json() as { total: number; accounts: unknown[] };
    expect([one.total, one.accounts.length]).toEqual([2, 1]);
  });

  it("takes a limit of 1 to MAX_ACCOUNTS_LISTED and nothing else", async () => {
    const auth = await bearer(OPERATOR);
    for (const limit of ["0", "-1", "1.5", "abc", "", String(MAX_ACCOUNTS_LISTED + 1), "01"]) {
      expect((await send("GET", `/admin/accounts?limit=${limit}`, auth)).status, limit).toBe(400);
    }
    expect((await send("GET", `/admin/accounts?limit=${MAX_ACCOUNTS_LISTED}`, auth)).status).toBe(200);
  });

  it("lets no one else read it, takes GET alone, and answers 501 with no plan store", async () => {
    await seed();
    for (const operators of [undefined, new Set<string>()]) {
      const closed = routeWith(panelConfig({ plans: store, operators }));
      expect((await send("GET", "/admin/accounts", await bearer(OPERATOR), undefined, closed)).status).toBe(403);
    }
    expect((await send("GET", "/admin/accounts", await bearer(TEAM_ADMIN, "operator"))).status).toBe(403);
    const sid = await seedSession(cfg, "ops-sid", { identity: OPERATOR, plan_source: "default" });
    expect((await send("GET", "/admin/accounts", { cookie: `${COOKIE}=${sid}`, origin: PANEL })).status).toBe(401);
    expect((await send("GET", "/admin/accounts", {})).status).toBe(401);
    const post = await send("POST", "/admin/accounts", await bearer(OPERATOR));
    expect([post.status, post.headers.get("allow")]).toEqual([405, "GET"]);
    const bare = routeWith(panelConfig({ plans: undefined, operators: new Set([OPERATOR.userId]) }));
    expect((await send("GET", "/admin/accounts", await bearer(OPERATOR), undefined, bare)).status).toBe(501);
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

  // Section 1C review, Minor 3, re-graded Important: an open report older than the newest 200 is still in the queue an operator
  // reads. Open reports come first, then the resolved ones, newest first in each, MAX_REPORTS_LISTED in all.
  it("lists an open report first however many newer ones are resolved, then the resolved newest first, in all at most MAX_REPORTS_LISTED", async () => {
    const fileAt = async (i: number) => ((await store.fileReport({
      sessionId: "qs_1", creatorId: "u_jesse", target: { kind: "room" }, subject: null, reason: "spam",
      note: null, reporterUserId: `u_reader_${i}`, reporterLabel: `reader${i}@example.dev`,
    }, 1_000 + i)) as { report: Report }).report;
    const old = await fileAt(0);
    for (let i = 1; i <= MAX_REPORTS_LISTED + 1; i++) {
      await store.resolveReport((await fileAt(i)).id, { note: "done", by: "u_operator" }, 9_000 + i);
    }
    const { reports } = (await (await send("GET", "/admin/reports", await bearer(OPERATOR))).json()) as { reports: { id: string; at: string; resolved_at: string | null }[] };
    expect(reports).toHaveLength(MAX_REPORTS_LISTED);
    expect(reports[0], "the old open report heads the list").toMatchObject({ id: old.id, resolved_at: null });
    expect(reports[1].at, "then the newest resolved").toBe(new Date(1_000 + MAX_REPORTS_LISTED + 1).toISOString());
    expect(reports[reports.length - 1].at, "and the cut falls in the resolved ones").toBe(new Date(1_003).toISOString());
    expect(reports.slice(1).every((r) => r.resolved_at !== null)).toBe(true);
  });
});

describe("/admin/orgs (orgs spec, D7)", () => {
  const acme = { org_id: "org_acme", name: " Acme ", owner_key: "github:1", seats: 3 };
  const error = async (res: Response) => ((await res.json()) as { error: string }).error;

  it("creates an org with its owner seated, and refuses the id a second time", async () => {
    const auth = await bearer(OPERATOR);
    const res = await send("POST", "/admin/orgs", auth, acme);
    expect([res.status, await res.json()]).toEqual([201, { org: {
      org_id: "org_acme", name: "Acme", owner_user_id: "u_github_1", seats: 3, seats_used: 1, active: true,
      source: "operator", created_at: expect.any(String), require_sso: false, domains: [], your_role: null, policy: policyView(DEFAULT_POLICY),
    } }]);
    expect(await store.getGrant("github:1")).toMatchObject({
      plan: "team", role: "admin", orgId: "org_acme", source: "operator", grantedBy: OPERATOR.userId, expiresAt: null,
    });
    expect((await store.auditForOrg("org_acme", 10)).map((e) => [e.action, e.actorUserId]))
      .toEqual([["org_created", OPERATOR.userId], ["plan_granted", OPERATOR.userId]]);
    const again = await send("POST", "/admin/orgs", auth, { ...acme, name: "Again" });
    expect([again.status, await error(again)]).toEqual([409, "exists"]);
    expect((await store.getOrg("org_acme"))?.name).toBe("Acme");
  });

  it("refuses an owner key granted in another org, creating nothing", async () => {
    await store.putGrant({ key: "github:1", plan: "team", role: "admin", orgId: "org_other", source: "operator", grantedAt: 1, grantedBy: "u_op", expiresAt: null });
    const res = await send("POST", "/admin/orgs", await bearer(OPERATOR), acme);
    expect([res.status, await error(res)]).toEqual([409, "conflict"]);
    expect(await store.getOrg("org_acme")).toBeUndefined();
  });

  it("refuses a body that is not the shape named, creating nothing", async () => {
    const auth = await bearer(OPERATOR);
    const bodies: unknown[] = [
      undefined, [], "acme", { ...acme, owner_key: "email:a@acme.test" }, { ...acme, owner_key: "github:mcfearsome" },
      { ...acme, org_id: "bad id" }, { ...acme, seats: 0 }, { ...acme, seats: "3" }, { ...acme, name: "a".repeat(81) },
      { ...acme, name: "  " },
    ];
    for (const body of bodies) {
      expect((await send("POST", "/admin/orgs", auth, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await store.getOrg("org_acme")).toBeUndefined();
    expect(await store.getGrant("github:1")).toBeUndefined();
  });

  it("renames and resizes with PATCH, and knows no other org", async () => {
    const auth = await bearer(OPERATOR);
    await send("POST", "/admin/orgs", auth, acme);
    const res = await send("PATCH", "/admin/orgs/org_acme", auth, { seats: 5, name: "Acme Ltd" });
    expect([res.status, await res.json()]).toEqual([200, { org: expect.objectContaining({ seats: 5, name: "Acme Ltd", seats_used: 1 }) }]);
    expect(await store.getOrg("org_acme")).toMatchObject({ seats: 5, name: "Acme Ltd", ownerUserId: "u_github_1" });
    expect((await send("PATCH", "/admin/orgs/org_acme", auth, { seats: 7 })).status).toBe(200);
    expect((await store.getOrg("org_acme"))?.name).toBe("Acme Ltd");
    expect((await send("PATCH", "/admin/orgs/org_nobody", auth, { seats: 2 })).status).toBe(404);
    expect((await send("PATCH", "/admin/orgs/bad%20id", auth, { seats: 2 })).status).toBe(404);
    for (const body of [{}, undefined, { seats: 0 }, { name: "" }, { active: false }]) {
      expect((await send("PATCH", "/admin/orgs/org_acme", auth, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await store.getOrg("org_acme"))?.seats).toBe(7);
    const get = await send("GET", "/admin/orgs/org_acme", auth);
    expect([get.status, get.headers.get("allow")]).toEqual([405, "PATCH"]);
    const list = await send("GET", "/admin/orgs", auth);
    expect([list.status, list.headers.get("allow")]).toEqual([405, "POST"]);
  });

  /**
   * A purchased org's seats are what its subscription sells: the next Stripe event would write
   * them back, so a resize here would be undone with only a `stripe` row to explain it. The name
   * is not billing's, so that still goes through.
   */
  it("leaves a purchased org's seats to billing, and still renames it", async () => {
    const auth = await bearer(OPERATOR);
    await store.activatePurchasedOrg("org_u_github_4242", "u_github_4242", 3, { actorUserId: "stripe" });
    const seats = await send("PATCH", "/admin/orgs/org_u_github_4242", auth, { seats: 5 });
    expect([seats.status, await error(seats)]).toEqual([409, "purchased"]);
    const both = await send("PATCH", "/admin/orgs/org_u_github_4242", auth, { seats: 5, name: "Acme" });
    expect(both.status).toBe(409);
    expect(await store.getOrg("org_u_github_4242")).toMatchObject({ seats: 3, name: "org_u_github_4242" });
    const name = await send("PATCH", "/admin/orgs/org_u_github_4242", auth, { name: "Acme" });
    expect([name.status, ((await name.json()) as { org: { name: string; seats: number } }).org]).toEqual([200, expect.objectContaining({ name: "Acme", seats: 3 })]);
  });

  it("lets no one else through, and creates nothing", async () => {
    for (const operators of [undefined, new Set<string>()]) {
      const closed = routeWith(panelConfig({ plans: store, operators }));
      expect((await send("POST", "/admin/orgs", await bearer(OPERATOR), acme, closed)).status).toBe(403);
    }
    expect((await send("POST", "/admin/orgs", await bearer(TEAM_ADMIN, "operator"), acme)).status).toBe(403);
    expect((await send("PATCH", "/admin/orgs/org_acme", await bearer(TEAM_ADMIN, "operator"), { seats: 9 })).status).toBe(403);
    const sid = await seedSession(cfg, "ops-sid", { identity: OPERATOR, plan_source: "default" });
    expect((await send("POST", "/admin/orgs", { cookie: `${COOKIE}=${sid}`, origin: PANEL }, acme)).status).toBe(401);
    expect((await send("POST", "/admin/orgs", {}, acme)).status).toBe(401);
    expect(await store.getOrg("org_acme")).toBeUndefined();
  });
});

describe("/admin/rooms/backfill", () => {
  it("runs one window of the room index's backfill, passing the limit and the cursor, and answers what it wrote", async () => {
    const asked: unknown[][] = [];
    store.backfillRoomIndex = async (...args) => {
      asked.push(args);
      return { indexed: 2, next: "us:u_a:qs_b" };
    };
    const auth = await bearer(OPERATOR);
    const res = await send("POST", "/admin/rooms/backfill", auth);
    expect([res.status, await res.json()]).toEqual([200, { indexed: 2, next: "us:u_a:qs_b" }]);
    await send("POST", `/admin/rooms/backfill?limit=7&after=${encodeURIComponent("us:u_a:qs_b")}`, auth);
    expect(asked).toEqual([[MAX_BACKFILL_WINDOW, undefined], [7, "us:u_a:qs_b"]]);
  });

  it("takes a limit of 1 to MAX_BACKFILL_WINDOW and nothing else", async () => {
    const auth = await bearer(OPERATOR);
    for (const limit of ["0", "-1", "1.5", "abc", "", String(MAX_BACKFILL_WINDOW + 1), "01"]) {
      expect((await send("POST", `/admin/rooms/backfill?limit=${limit}`, auth)).status, limit).toBe(400);
    }
    expect((await send("POST", `/admin/rooms/backfill?limit=${MAX_BACKFILL_WINDOW}`, auth)).status).toBe(200);
  });

  it("lets no one else run it, takes POST alone, and answers 501 with no plan store", async () => {
    for (const operators of [undefined, new Set<string>()]) {
      const closed = routeWith(panelConfig({ plans: store, operators }));
      expect((await send("POST", "/admin/rooms/backfill", await bearer(OPERATOR), undefined, closed)).status).toBe(403);
    }
    expect((await send("POST", "/admin/rooms/backfill", await bearer(TEAM_ADMIN, "operator"))).status).toBe(403);
    const sid = await seedSession(cfg, "ops-sid", { identity: OPERATOR, plan_source: "default" });
    expect((await send("POST", "/admin/rooms/backfill", { cookie: `${COOKIE}=${sid}`, origin: PANEL })).status).toBe(401);
    expect((await send("POST", "/admin/rooms/backfill", {})).status).toBe(401);
    const get = await send("GET", "/admin/rooms/backfill", await bearer(OPERATOR));
    expect([get.status, get.headers.get("allow")]).toEqual([405, "POST"]);
    const bare = routeWith(panelConfig({ plans: undefined, operators: new Set([OPERATOR.userId]) }));
    expect((await send("POST", "/admin/rooms/backfill", await bearer(OPERATOR), undefined, bare)).status).toBe(501);
  });
});
