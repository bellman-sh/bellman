/**
 * The Worker mounts the moderation routes over the real objects (abuse protections spec, section 4). Their rules are
 * pinned in tests/http-moderation.test.ts and tests/http-admin.test.ts; this is the wiring.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { env, reset, abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import worker from "../src/worker.js";
import { sessionCookieName } from "../src/oauth/cookies.js";
import { SESSION_TTL_MS } from "../src/oauth/storage.js";
import { AuthStore } from "../src/oauth/store.js";
import { ACCESS_TOKEN_TTL_SECONDS, canonicalResource, signJwt } from "../src/oauth/tokens.js";
import type { OutboxDriver } from "../src/outbox.js";
import { DurableObjectStore, type SessionDO } from "../src/store-do.js";
import type { Identity } from "../src/types.js";
import { member, oneCode, roomManifest, session } from "../tests/helpers/fixtures.js";

const ORIGIN = "https://mcp.example.test";
const KEY = "qk_ws_test"; // u_jesse, in vitest.config.ts
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const workerEnv = env as unknown as Parameters<typeof worker.fetch>[1];
const call = (path: string, init: RequestInit = {}, on = workerEnv) => worker.fetch(new Request(`${ORIGIN}${path}`, {
  ...init, headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
}), on, ctx);
const store = () => new DurableObjectStore(env as never);
const seed = () => store().createSession(session({
  id: "qs_wire_mod", manifest: roomManifest({ public: true }),
  members: [member(), member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b" })],
}));

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

const SECRET = "test-signing-secret";
/** OAuth on, for a token the authorization server signed: /admin is its. */
const oauthEnv = (over: Record<string, unknown> = {}) =>
  ({ ...env, BELLMAN_TOKEN_SECRET: SECRET, BELLMAN_OPERATORS: "u_operator", ...over }) as unknown as Parameters<typeof worker.fetch>[1];
const tokenFor = (identity: Identity) => signJwt(
  { iss: ORIGIN, sub: identity.userId, aud: canonicalResource(`${ORIGIN}/mcp`), bellman: identity, plan_source: "default" },
  SECRET, ACCESS_TOKEN_TTL_SECONDS,
);
const OPERATOR: Identity = { userId: "u_operator", orgId: null, plan: "free", role: "member", label: "ops@example.dev" };

describe("the moderation routes through the Worker", () => {
  it("bans at /rooms/:id/bans, lists the ban, and lifts it at /rooms/:id/bans/:banId, over the real room", async () => {
    await seed();
    const banned = await call("/rooms/qs_wire_mod/bans", { method: "POST", body: JSON.stringify({ member_id: "m_peer", scope: "all" }) });
    expect(banned.status, await banned.clone().text()).toBe(200);
    const listed = (await (await call("/rooms/qs_wire_mod/bans")).json()) as { bans: { ban_id: string; label: string }[] };
    expect(listed.bans.map((b) => b.label)).toEqual(["peer@codenerd"]);
    expect((await call(`/rooms/qs_wire_mod/bans/${listed.bans[0].ban_id}`, { method: "DELETE" })).status).toBe(204);
    expect(await store().roomBans("qs_wire_mod")).toEqual([]);
  });

  // A lifted ban must not come back. Every creator_ban row the outbox delivers after a lift writes the ban again, so
  // one eviction queues one, however many handles the account holds in the room.
  it("queues one creator_ban row for a ban from every room on an account holding two handles in the room", async () => {
    await store().createSession(session({
      id: "qs_wire_mod", manifest: roomManifest({ public: true }),
      members: [
        member(),
        member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b" }),
        member({ memberId: "m_peer_2", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b" }),
      ],
    }));
    const queued: string[] = [];
    await runInDurableObject(env.SESSION.get(env.SESSION.idFromName("qs_wire_mod")), (room: SessionDO) => {
      const driver = (room as unknown as { driver: OutboxDriver }).driver;
      const enqueue = driver.enqueue.bind(driver);
      driver.enqueue = (txn, intents) => {
        queued.push(...intents.map((i) => i.kind));
        return enqueue(txn, intents);
      };
    });
    const banned = await call("/rooms/qs_wire_mod/bans", { method: "POST", body: JSON.stringify({ member_id: "m_peer", scope: "all" }) });
    expect(banned.status, await banned.clone().text()).toBe(200);
    expect((await store().getSession("qs_wire_mod"))!.members.map((m) => m.memberId), "the control: both handles went").toEqual(["m_creator"]);
    expect(queued.filter((kind) => kind === "creator_ban")).toHaveLength(1);
  });

  // A ban from every room removes the account from the creator's other rooms now, found through the registry's
  // joined-rooms index, and leaves another creator's alone. A frozen room refuses its removals, and a repeat finishes them.
  it("removes the account from every other room the creator owns, finishing on a repeat what a frozen room refused", async () => {
    const peerAs = (memberId: string) => member({ memberId, userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b" });
    await store().createSession(session({ id: "qs_wire_a", joinCodes: {}, members: [member(), peerAs("m_peer")] }));
    await store().createSession(session({
      id: "qs_wire_b", joinCodes: oneCode("BELL-WIRE-B"), members: [member(), peerAs("m_peer_b1"), peerAs("m_peer_b2")],
    }));
    await store().createSession(session({
      id: "qs_wire_c", createdBy: "u_other", joinCodes: {},
      members: [member({ userId: "u_other", label: "other@elsewhere" }), peerAs("m_peer_c")],
    }));
    const seated = async (id: string) =>
      (await store().getSession(id))!.members.filter((m) => m.userId === "u_peer").map((m) => m.memberId);
    const ban = async () => {
      const res = await call("/rooms/qs_wire_a/bans", { method: "POST", body: JSON.stringify({ member_id: "m_peer", scope: "all" }) });
      expect(res.status, await res.clone().text()).toBe(200);
      return res.json();
    };

    await store().freezeSession("qs_wire_b", Date.now());
    expect(await ban()).toMatchObject({ banned: "all", also_removed_from: 0 });
    expect(await seated("qs_wire_b"), "the premise: frozen, B refused both removals").toEqual(["m_peer_b1", "m_peer_b2"]);
    await store().freezeSession("qs_wire_b", null);
    expect(await ban()).toMatchObject({ banned: "all", also_removed_from: 1 });
    expect([await seated("qs_wire_a"), await seated("qs_wire_b"), await seated("qs_wire_c")]).toEqual([[], [], ["m_peer_c"]]);

    // In B, what an eviction writes, once a handle, the ban on its audit rows, and B's expiring code retired. No room ban of
    // B's own: the creator-wide ban, which the next join reads, keeps the account out.
    expect((await store().eventsAfter("qs_wire_b", 0)).filter((e) => e.type === "member_evicted")).toHaveLength(2);
    const rows = (await store().auditForOrg("org_codenerd", 100)).filter((r) => r.sessionId === "qs_wire_b" && r.action === "member_evicted");
    expect(rows.map((r) => r.detail)).toEqual([
      expect.objectContaining({ user_id: "u_peer", ban: "all" }), expect.objectContaining({ user_id: "u_peer", ban: "all" }),
    ]);
    expect((await store().getSession("qs_wire_b"))!.joinCodes).toEqual({});
    expect(await store().roomBans("qs_wire_b")).toEqual([]);
    expect(await store().isBannedByCreator("u_jesse", "u_peer")).toBe(true);
  });

  it("lists a creator's bans at /account/bans from the real registry, and lifts one at /account/bans/:banId", async () => {
    await seed();
    await call("/rooms/qs_wire_mod/bans", { method: "POST", body: JSON.stringify({ member_id: "m_peer", scope: "all" }) });
    const listed = (await (await call("/account/bans")).json()) as { bans: { ban_id: string; session_id: string }[] };
    expect(listed.bans.map((b) => b.session_id)).toEqual(["qs_wire_mod"]);
    expect((await call(`/account/bans/${listed.bans[0].ban_id}`, { method: "DELETE" })).status).toBe(204);
    expect(await store().isBannedByCreator("u_jesse", "u_peer")).toBe(false);
  });

  // `/account/bans` has its own copy of the fail-closed call, as `/rooms/` does (worker-tests/blobs-route.test.ts).
  // Without it a deploy with neither a key map nor OAuth answers the route's 401, which reads as a bad key on a
  // deploy that has none.
  it("answers 503 at /account/bans with neither a key map nor OAuth, and the route's own answer once a key map is bound", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const bare = { ...env, BELLMAN_KEYS: undefined } as unknown as Parameters<typeof worker.fetch>[1];
      expect((await call("/account/bans", {}, bare)).status).toBe(503);
      expect(quiet).toHaveBeenCalledWith(expect.stringContaining("BELLMAN_KEYS is unset"));
      // The control: the same request with the key map bound reaches the route.
      expect((await call("/account/bans")).status).toBe(200);
    } finally {
      quiet.mockRestore();
    }
  });

  // A user id no earlier case read, so this isolate's cache (spec D4) holds no answer for it yet.
  it("suspends at /admin/suspensions/:userId, and the Worker refuses that account at /mcp and /rooms", async () => {
    const operator = await tokenFor(OPERATOR);
    const target = await tokenFor({ userId: "u_wire_suspended", orgId: null, plan: "free", role: "member", label: "s@example.dev" });
    const post = await worker.fetch(new Request(`${ORIGIN}/admin/suspensions/u_wire_suspended`, {
      method: "POST", headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" }, body: JSON.stringify({ note: "wire" }),
    }), oauthEnv(), ctx);
    expect(post.status, await post.clone().text()).toBe(200);
    const mcp = await worker.fetch(new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${target}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }), oauthEnv(), ctx);
    expect([mcp.status, await mcp.json()]).toEqual([403, expect.objectContaining({ error: expect.objectContaining({ message: "This account is suspended." }) })]);
    const rooms = await worker.fetch(new Request(`${ORIGIN}/rooms`, { headers: { authorization: `Bearer ${target}` } }), oauthEnv(), ctx);
    expect(rooms.status).toBe(403);
  });

  it("lifts a suspension at DELETE /admin/suspensions/:userId from the real registry, and answers 404 when none is left", async () => {
    const operator = await tokenFor(OPERATOR);
    await store().suspend("u_wire_lifted", { note: "wire", by: OPERATOR.userId, at: Date.now() });
    const lift = () => worker.fetch(new Request(`${ORIGIN}/admin/suspensions/u_wire_lifted`, {
      method: "DELETE", headers: { authorization: `Bearer ${operator}` },
    }), oauthEnv(), ctx);
    const lifted = await lift();
    expect(lifted.status, await lifted.clone().text()).toBe(204);
    expect(await store().isSuspended("u_wire_lifted")).toBe(false);
    expect((await lift()).status, "nothing left to lift").toBe(404);
  });

  // The rest of R8's paths, a case each, each for an account of its own: this isolate's cache keeps its answer for an
  // account a minute. The control at each is an account nobody suspended, sent the same request.
  for (const [path, headers, served] of [
    ["/ws?session=qs_wire_none&cursor=0", { upgrade: "websocket" }, 404],
    ["/presets", {}, 200],
    ["/account/handle", {}, 200],
    ["/account/bans", {}, 200],
  ] as const) {
    const name = path.split("?")[0];
    it(`refuses a suspended account at ${name} with the one message, and serves another`, async () => {
      const as = async (userId: string) => worker.fetch(new Request(`${ORIGIN}${path}`, {
        headers: { ...headers, authorization: `Bearer ${await tokenFor({ userId, orgId: null, plan: "free", role: "member", label: `${userId}@example.dev` })}` },
      }), oauthEnv(), ctx);
      const suspended = `u_wire${name.replaceAll("/", "_")}`;
      await store().suspend(suspended, { note: "wire", by: OPERATOR.userId, at: Date.now() });
      const refused = await as(suspended);
      expect([refused.status, await refused.text()]).toEqual([403, expect.stringContaining("This account is suspended.")]);
      expect((await as(`${suspended}_control`)).status, "the control").toBe(served);
    });
  }

  // The dash comes with its cookie, which `roomCaller` resolves through the authorization server's `caller`. The
  // refusal carries CORS, so the panel can read why. The route reuses the gate's answer, so a request touches its
  // session once rather than once for the gate and again for the route.
  it("refuses a suspended account's panel cookie where the panel can read it, and touches a served session once", async () => {
    const PANEL = "https://dash.example.test";
    const cookieFor = async (userId: string) => {
      const now = Date.now();
      const id = crypto.randomUUID();
      await new AuthStore(env.AUTH as never).putSession(id, {
        identity: { userId, orgId: null, plan: "free", role: "member", label: `${userId}@example.dev` }, plan_source: "default",
        identity_keys: [], created_at: now, last_used_at: now, replanned_at: now, expires_at: now + SESSION_TTL_MS,
      });
      return `${sessionCookieName(true)}=${id}`;
    };
    const rooms = async (cookie: string) =>
      worker.fetch(new Request(`${ORIGIN}/rooms`, { headers: { cookie, origin: PANEL } }), oauthEnv({ BELLMAN_PANEL_ORIGINS: PANEL }), ctx);
    await store().suspend("u_wire_cookie", { note: "wire", by: OPERATOR.userId, at: Date.now() });
    const refused = await rooms(await cookieFor("u_wire_cookie"));
    expect([refused.status, await refused.json(), refused.headers.get("access-control-allow-origin")])
      .toEqual([403, { error: "suspended", error_description: "This account is suspended." }, PANEL]);

    const control = await cookieFor("u_wire_cookie_control");
    const touched = vi.spyOn(AuthStore.prototype, "touchSession");
    try {
      expect((await rooms(control)).status, "the control").toBe(200);
      expect(touched).toHaveBeenCalledTimes(1);
    } finally {
      touched.mockRestore();
    }
  });

  it("asks the registry about an account once a minute, not once a request", async () => {
    const read = vi.spyOn(DurableObjectStore.prototype, "isSuspended");
    try {
      const token = await tokenFor({ userId: "u_wire_cached", orgId: null, plan: "free", role: "member", label: "c@example.dev" });
      for (const path of ["/account/handle", "/presets"]) {
        const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { authorization: `Bearer ${token}` } }), oauthEnv(), ctx);
        expect(res.status, path).toBe(200);
      }
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      read.mockRestore();
    }
  });

  // Fail closed: a registry that cannot answer serves nobody. A route answers in its own JSON, as a throw inside it
  // is answered; /mcp answers JSON-RPC's internal error, which an MCP client can parse, and /ws a 500.
  it("serves nothing when the registry cannot say whether an account is suspended", async () => {
    const read = vi.spyOn(DurableObjectStore.prototype, "isSuspended").mockRejectedValue(new Error("registry down"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const token = await tokenFor({ userId: "u_wire_unread", orgId: null, plan: "free", role: "member", label: "u@example.dev" });
      const rooms = await worker.fetch(new Request(`${ORIGIN}/rooms`, { headers: { authorization: `Bearer ${token}` } }), oauthEnv(), ctx);
      expect([rooms.status, await rooms.json()]).toEqual([500, { error: "internal", error_description: expect.any(String) }]);
      const mcp = await worker.fetch(new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }), oauthEnv(), ctx);
      expect([mcp.status, await mcp.json()])
        .toEqual([500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }]);
      const ws = await worker.fetch(new Request(`${ORIGIN}/ws?session=qs_wire_none&cursor=0`, {
        headers: { authorization: `Bearer ${token}`, upgrade: "websocket" },
      }), oauthEnv(), ctx);
      expect(ws.status).toBe(500);
      expect(read).toHaveBeenCalledTimes(3);
    } finally {
      read.mockRestore();
      quiet.mockRestore();
    }
  });
});
