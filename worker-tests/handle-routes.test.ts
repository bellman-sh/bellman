/**
 * The Worker mounts the handle routes over the real registry (bylines spec D6).
 * The routes' rules are pinned in tests/http-bylines.test.ts; this is the wiring.
 */
import { afterEach, describe, expect, it } from "vitest";
import { env, reset, abortAllDurableObjects } from "cloudflare:test";
import worker from "../src/worker.js";
import { ACCESS_TOKEN_TTL_SECONDS, canonicalResource, signJwt } from "../src/oauth/tokens.js";
import { DurableObjectStore } from "../src/store-do.js";
import type { Identity } from "../src/types.js";

const ORIGIN = "https://mcp.example.test";
const KEY = "qk_ws_test";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const workerEnv = env as unknown as Parameters<typeof worker.fetch>[1];
const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), workerEnv, ctx);

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

describe("the handle routes through the Worker", () => {
  it("read, claim, refuse a held one, free the old on a change, release, and refuse the rest", async () => {
    const auth = { authorization: `Bearer ${KEY}` };
    const put = (handle: unknown) =>
      call("/account/handle", { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ handle }) });
    const get = async (path = "/account/handle") => {
      const res = await call(path, { headers: auth });
      return { status: res.status, body: await res.json() };
    };
    const registry = new DurableObjectStore(env as never);

    expect(await get()).toEqual({ status: 200, body: { handle: null } });
    const first = await put(" Wire-Do ");
    expect(first.status, await first.clone().text()).toBe(200);
    expect(await first.json()).toEqual({ handle: "wire-do" });
    expect(await get("/account/handle/")).toEqual({ status: 200, body: { handle: "wire-do" } });
    expect(await registry.handleOf("u_jesse")).toBe("wire-do");

    // Another person holds a handle, set straight in the registry: the route refuses it.
    await registry.claimHandle("u_someone_else", "held-by-other");
    const taken = await put("held-by-other");
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ error: "handle_taken" });

    // A change frees the old handle for anyone else.
    expect((await put("wire-do-two")).status).toBe(200);
    expect(await registry.claimHandle("u_someone_else", "wire-do")).toBe("claimed");

    expect((await call("/account/handle", { method: "DELETE", headers: auth })).status).toBe(204);
    expect(await get()).toEqual({ status: 200, body: { handle: null } });
    expect(await registry.userOfHandle("wire-do-two")).toBeUndefined();

    expect((await call("/account/handle")).status).toBe(401);
    expect((await call("/account/handle", { method: "OPTIONS" })).status).toBe(204);
    expect((await call("/account/handle", { method: "POST", headers: auth })).status).toBe(405);
  });

  // The dash's PUT and DELETE on these routes carry its cookie across origins, so a browser sends them only after a
  // preflight that grants them (final review, recommendation 1). The OPTIONS above sends no Origin and so checks no
  // grant. The panel's origin reaches the routes only with OAuth on, through BELLMAN_PANEL_ORIGINS.
  it("grants the dash's origin PUT and DELETE in the preflight of /account/handle and of /rooms/:id/byline", async () => {
    const panel = "https://dash.bellman.sh";
    const panelEnv = { ...env, BELLMAN_TOKEN_SECRET: "test-signing-secret", BELLMAN_PANEL_ORIGINS: panel } as unknown as Parameters<typeof worker.fetch>[1];
    for (const path of ["/account/handle", "/rooms/qs_any/byline"]) {
      for (const method of ["PUT", "DELETE"]) {
        const res = await worker.fetch(new Request(`${ORIGIN}${path}`, {
          method: "OPTIONS",
          headers: { origin: panel, "access-control-request-method": method, "access-control-request-headers": "content-type" },
        }), panelEnv, ctx);
        const at = `${method} ${path}`;
        expect(res.status, at).toBe(204);
        expect(res.headers.get("access-control-allow-origin"), at).toBe(panel);
        expect(res.headers.get("access-control-allow-credentials"), at).toBe("true");
        expect(res.headers.get("access-control-allow-methods")?.split(/,\s*/), at).toContain(method);
        expect(res.headers.get("access-control-allow-headers")?.split(/,\s*/), at).toContain("content-type");
      }
    }
  });

  // /admin is the authorization server's, so this needs OAuth on and a token it signed, here for a user id the
  // BELLMAN_OPERATORS secret lists (ADR 0021). The gate's cases are pinned in tests/http-bylines.test.ts. This is the
  // wiring, so the listed id's token is also refused with the secret unset: the Worker reads the list from its env.
  it("lets a user id BELLMAN_OPERATORS lists release someone's handle at /admin/handles/:handle, over the real registry", async () => {
    const secret = "test-signing-secret";
    const envWith = (operators: string | undefined) =>
      ({ ...env, BELLMAN_TOKEN_SECRET: secret, BELLMAN_OPERATORS: operators }) as unknown as Parameters<typeof worker.fetch>[1];
    const listed = envWith("u_operator");
    const tokenFor = (identity: Identity, planSource: string) => signJwt(
      { iss: ORIGIN, sub: identity.userId, aud: canonicalResource(`${ORIGIN}/mcp`), bellman: identity, plan_source: planSource },
      secret, ACCESS_TOKEN_TTL_SECONDS,
    );
    const operator = await tokenFor({ userId: "u_operator", orgId: null, plan: "free", role: "member", label: "ops@example.dev" }, "default");
    const teamAdmin = await tokenFor({ userId: "u_team_admin", orgId: "org_ops", plan: "team", role: "admin", label: "admin@example.dev" }, "operator");
    const release = (segment: string, authorization: string, on = listed) =>
      worker.fetch(new Request(`${ORIGIN}/admin/handles/${segment}`, { method: "DELETE", headers: { authorization } }), on, ctx);
    const registry = new DurableObjectStore(env as never);
    await registry.claimHandle("u_someone", "wire-held");
    await registry.signRoom("u_someone", "qs_wire", 1_000);

    // The key map's team admin holds no token the authorization server signed, so /admin does not know them.
    expect((await release("wire-held", `Bearer ${KEY}`)).status).toBe(401);
    // A team admin BELLMAN_USERS made is not on the list, and the list's own id passes nothing with the secret unset.
    expect((await release("wire-held", `Bearer ${teamAdmin}`)).status).toBe(403);
    expect((await release("wire-held", `Bearer ${operator}`, envWith(undefined))).status).toBe(403);
    expect(await registry.userOfHandle("wire-held")).toBe("u_someone");

    const released = await release("Wire-Held", `Bearer ${operator}`);
    expect(released.status, await released.clone().text()).toBe(204);
    expect(await registry.userOfHandle("wire-held")).toBeUndefined();
    expect(await registry.signedRooms("u_someone")).toEqual([]);
    expect((await release("wire-held", `Bearer ${operator}`)).status).toBe(404);
  });
});
