/**
 * The operator's routes (abuse protections spec D3): suspensions and the report queue, for a user id
 * BELLMAN_OPERATORS lists, over a bearer token and never a cookie, as /admin/handles is (ADR 0021).
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { OAuthConfig } from "../src/oauth/routes.js";
import { ACCESS_TOKEN_TTL_SECONDS, signJwt } from "../src/oauth/tokens.js";
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
