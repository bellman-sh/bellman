/**
 * The Worker mounts the moderation routes over the real objects (abuse protections spec, section 4). Their rules are
 * pinned in tests/http-moderation.test.ts and tests/http-admin.test.ts; this is the wiring.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { env, reset, abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import worker from "../src/worker.js";
import { hostMember } from "../src/host.js";
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
const PANEL = "https://dash.example.test";
const PAGE = "https://bellman.sh";
/** A panel session's cookie for `userId`, as a sign-in leaves one: what the dash and bellman.sh's room pages send. */
const cookieFor = async (userId: string) => {
  const now = Date.now();
  const id = crypto.randomUUID();
  await new AuthStore(env.AUTH as never).putSession(id, {
    identity: { userId, orgId: null, plan: "free", role: "member", label: `${userId}@example.dev` }, plan_source: "default",
    identity_keys: [], created_at: now, last_used_at: now, replanned_at: now, expires_at: now + SESSION_TTL_MS,
  });
  return `${sessionCookieName(true)}=${id}`;
};

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

  // PUT /rooms/:id/host writes a room's manifest as its caller, and R8 gates it with the rest of /rooms*. Each account
  // created a room of its own, so with no gate the suspended one's write lands; the control is another creator sent the
  // same request.
  it("refuses a suspended creator's PUT /rooms/:id/host with the one message, and serves another creator the same request", async () => {
    const hostedBy = (userId: string) => {
      const m = roomManifest({ mode: "swarm", preset: null, heartbeatOnMs: 3_600_000,
        roles: { lead: { can: ["send"], description: null, reports: false }, host: { can: ["send"], description: null, reports: false } },
        defaultRole: "lead", creatorRole: "lead", host: { role: "host", model: "haiku", instructions: null } });
      return store().createSession(session({
        id: `qs_${userId}`, createdBy: userId, manifest: m, joinCodes: {},
        members: [member({ memberId: `m_${userId}`, userId, label: `${userId}@example.dev`, orgId: null, roomRole: "lead" }), hostMember(m, Date.now())],
      }));
    };
    const put = async (userId: string) => worker.fetch(new Request(`${ORIGIN}/rooms/qs_${userId}/host`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${await tokenFor({ userId, orgId: null, plan: "max", role: "member", label: `${userId}@example.dev` })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ instructions: "Ask how agents have grown." }),
    }), oauthEnv(), ctx);
    const instructionsOf = async (userId: string) => (await store().getSession(`qs_${userId}`))!.manifest.host?.instructions;

    const suspended = "u_wire_host_suspended";
    const control = `${suspended}_control`;
    await hostedBy(suspended);
    await hostedBy(control);
    await store().suspend(suspended, { note: "wire", by: OPERATOR.userId, at: Date.now() });
    const refused = await put(suspended);
    expect([refused.status, await refused.json()]).toEqual([403, { error: "suspended", error_description: "This account is suspended." }]);
    expect(await instructionsOf(suspended), "the suspended creator's write did not land").toBeNull();
    const served = await put(control);
    expect([served.status, await served.json()], "the control").toEqual([200, { instructions: "Ask how agents have grown." }]);
    expect(await instructionsOf(control)).toBe("Ask how agents have grown.");
  });

  // /operator/stats reads the registry as its caller, so R8 gates it too. Both accounts are operators here, so with no
  // gate the suspended one would read the platform's counts; the control is the other operator, served them.
  it("refuses a suspended operator at /operator/stats with the one message, and serves another operator", async () => {
    const operators = oauthEnv({ BELLMAN_OPERATORS: "u_wire_stats,u_wire_stats_control" });
    const as = async (userId: string) => worker.fetch(new Request(`${ORIGIN}/operator/stats`, {
      headers: { authorization: `Bearer ${await tokenFor({ userId, orgId: null, plan: "free", role: "member", label: `${userId}@example.dev` })}` },
    }), operators, ctx);
    await store().suspend("u_wire_stats", { note: "wire", by: OPERATOR.userId, at: Date.now() });
    const refused = await as("u_wire_stats");
    expect([refused.status, await refused.json()]).toEqual([403, { error: "suspended", error_description: "This account is suspended." }]);
    expect((await as("u_wire_stats_control")).status, "the control").toBe(200);
  });

  // /audit reads an org's stream as its caller, so R8 gates it too. Both accounts are admins of one team org here, so with
  // no gate the suspended one would read the org's stream; the control is the other admin, served it.
  it("refuses a suspended org admin at /audit with the one message, and serves another admin of the org", async () => {
    const as = async (userId: string) => worker.fetch(new Request(`${ORIGIN}/audit`, {
      headers: { authorization: `Bearer ${await tokenFor({ userId, orgId: "org_wire", plan: "team", role: "admin", label: `${userId}@example.dev` })}` },
    }), oauthEnv(), ctx);
    await store().suspend("u_wire_audit", { note: "wire", by: OPERATOR.userId, at: Date.now() });
    const refused = await as("u_wire_audit");
    expect([refused.status, await refused.json()]).toEqual([403, { error: "suspended", error_description: "This account is suspended." }]);
    expect((await as("u_wire_audit_control")).status, "the control").toBe(200);
  });

  // The dash comes with its cookie, which `roomCaller` resolves through the authorization server's `caller`. The
  // refusal carries CORS, so the panel can read why. The route reuses the gate's answer, so a request touches its
  // session once rather than once for the gate and again for the route.
  it("refuses a suspended account's panel cookie where the panel can read it, and touches a served session once", async () => {
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

  // Public rooms on bellman.sh, D7, the whole path: the cookie a sign-in set, read by the authorization server's `caller`,
  // then the CSRF check with the page's origin. The reader's cookie files a report from bellman.sh while the var names it
  // and files none while it does not. The creator's cookie is refused a ban from bellman.sh, and makes it from the panel.
  it("files a report from bellman.sh with the reader's session cookie, and refuses that page a ban", async () => {
    const listed = oauthEnv({ BELLMAN_PANEL_ORIGINS: PANEL, BELLMAN_PUBLIC_PAGE_ORIGINS: PAGE });
    const unlisted = oauthEnv({ BELLMAN_PANEL_ORIGINS: PANEL });
    const post = (path: string, body: unknown, cookie: string, origin: string, on = listed) => worker.fetch(new Request(`${ORIGIN}${path}`, {
      method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body),
    }), on, ctx);
    await seed();

    const reader = await cookieFor("u_wire_reader");
    const filed = await post("/rooms/qs_wire_mod/reports", { reason: "spam" }, reader, PAGE);
    expect([filed.status, filed.headers.get("access-control-allow-origin")], await filed.clone().text()).toEqual([201, PAGE]);
    const refused = await post("/rooms/qs_wire_mod/reports", { reason: "harassment" }, reader, PAGE, unlisted);
    expect([refused.status, refused.headers.get("access-control-allow-origin")], "the control: the var unset").toEqual([403, null]);
    expect((await store().listReports(10)).map((r) => r.reporterUserId)).toEqual(["u_wire_reader"]);

    const creator = await cookieFor("u_jesse");
    const ban = { member_id: "m_peer", scope: "room" };
    expect((await post("/rooms/qs_wire_mod/bans", ban, creator, PAGE)).status).toBe(403);
    expect(await store().roomBans("qs_wire_mod")).toEqual([]);
    expect((await post("/rooms/qs_wire_mod/bans", ban, creator, PANEL)).status, "the control: the panel bans").toBe(200);
  });

  // The gate answers ahead of the route, so what its refusal grants is the gate's to decide, and it decides as the routes do
  // (`routeOrigin`). A suspended reader's report from bellman.sh is refused with the page's origin and credentials, so the page
  // reads "This account is suspended."; with no grant its fetch fails with no reason. The grant is that one write's and no
  // wider: the same account's ban and its read of a room's reports, which the page may not make, are refused with none, and the
  // panel is granted all three. Every answer here is the gate's and never the CSRF check's, so each carries the suspension.
  it("refuses a suspended reader's report from bellman.sh where the page can read it, and grants that page no other refusal", async () => {
    const listed = oauthEnv({ BELLMAN_PANEL_ORIGINS: PANEL, BELLMAN_PUBLIC_PAGE_ORIGINS: PAGE });
    const unlisted = oauthEnv({ BELLMAN_PANEL_ORIGINS: PANEL });
    await store().suspend("u_wire_page_suspended", { note: "wire", by: OPERATOR.userId, at: Date.now() });
    const reader = await cookieFor("u_wire_page_suspended");
    /** What a browser reads of an answer: its status and body, and whether the page that asked may read it at all. */
    const refusal = async (method: string, path: string, origin: string, on = listed) => {
      const res = await worker.fetch(new Request(`${ORIGIN}${path}`, {
        method, headers: { cookie: reader, origin }, body: method === "POST" ? "{}" : undefined,
      }), on, ctx);
      return [res.status, await res.json(), res.headers.get("access-control-allow-origin"), res.headers.get("access-control-allow-credentials")];
    };
    const suspended = { error: "suspended", error_description: "This account is suspended." };
    const reports = "/rooms/qs_wire_mod/reports";
    const bans = "/rooms/qs_wire_mod/bans";

    expect(await refusal("POST", reports, PAGE)).toEqual([403, suspended, PAGE, "true"]);
    expect(await refusal("POST", reports, PAGE, unlisted), "the control: the var unset").toEqual([403, suspended, null, null]);
    expect(await refusal("POST", bans, PAGE), "the control: another path").toEqual([403, suspended, null, null]);
    expect(await refusal("GET", reports, PAGE), "the control: another method").toEqual([403, suspended, null, null]);
    for (const [method, path] of [["POST", reports], ["POST", bans], ["GET", reports]] as const) {
      expect(await refusal(method, path, PANEL), `the panel's ${method} ${path}`).toEqual([403, suspended, PANEL, "true"]);
    }
  });

  // The gate's other answer, for a registry that cannot say whether an account is suspended: a 500 in the routes' JSON, under
  // the same rule. The page reads that one too, where a refusal with no grant is a failed fetch; its ban is granted nothing.
  it("answers a failed suspension read with the page's origin for its report and with none for its ban", async () => {
    const read = vi.spyOn(DurableObjectStore.prototype, "isSuspended").mockRejectedValue(new Error("registry down"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const reader = await cookieFor("u_wire_page_unread");
      const answer = async (path: string, origin: string) => {
        const res = await worker.fetch(new Request(`${ORIGIN}${path}`, {
          method: "POST", headers: { cookie: reader, origin }, body: "{}",
        }), oauthEnv({ BELLMAN_PANEL_ORIGINS: PANEL, BELLMAN_PUBLIC_PAGE_ORIGINS: PAGE }), ctx);
        return [res.status, await res.json(), res.headers.get("access-control-allow-origin")];
      };
      const internal = { error: "internal", error_description: expect.any(String) };

      expect(await answer("/rooms/qs_wire_mod/reports", PAGE)).toEqual([500, internal, PAGE]);
      expect(await answer("/rooms/qs_wire_mod/bans", PAGE), "the control: another path").toEqual([500, internal, null]);
      expect(await answer("/rooms/qs_wire_mod/bans", PANEL), "the control: the panel").toEqual([500, internal, PANEL]);
      expect(read, "each answer is the gate's").toHaveBeenCalledTimes(3);
    } finally {
      read.mockRestore();
      quiet.mockRestore();
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

  it("files a report at /rooms/:id/reports over the real registry, mails it once through SEND_EMAIL, and the creator reads it", async () => {
    await seed();
    const sent: unknown[] = [];
    const mailEnv = { ...env, SEND_EMAIL: { send: async (m: unknown) => { sent.push(m); return { messageId: "m1" }; } } } as unknown as Parameters<typeof worker.fetch>[1];
    const filed = await call("/rooms/qs_wire_mod/reports", { method: "POST", body: JSON.stringify({ member_id: "m_peer", reason: "spam", note: "ads" }) }, mailEnv);
    expect(filed.status, await filed.clone().text()).toBe(201);
    expect(sent).toEqual([expect.objectContaining({ from: "reports@bellman.sh", to: "support@bellman.sh" })]);
    const listed = (await (await call("/rooms/qs_wire_mod/reports", {}, mailEnv)).json()) as { reports: { reason: string }[] };
    expect(listed.reports.map((r) => r.reason)).toEqual(["spam"]);
  });

  // The tool and the route mail through one binding: the Worker builds the mailer once and hands it to both.
  it("mails a report the bellman_report tool files at /mcp through the same SEND_EMAIL binding", async () => {
    await seed();
    const sent: { subject: string }[] = [];
    const mailEnv = { ...env, SEND_EMAIL: { send: async (m: { subject: string }) => { sent.push(m); return { messageId: "m1" }; } } } as unknown as Parameters<typeof worker.fetch>[1];
    const res = await call("/mcp", {
      method: "POST",
      headers: { accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "bellman_report", arguments: { session_id: "qs_wire_mod", member_id: "m_peer", reason: "spam" } },
      }),
    }, mailEnv);
    const body = (await res.json()) as { result: { isError?: boolean; structuredContent: { report_id: string } } };
    expect(body.result.isError ?? false, JSON.stringify(body)).toBe(false);
    expect(sent.map((m) => m.subject)).toEqual([expect.stringContaining(body.result.structuredContent.report_id)]);
  });

  it("lists the queue at /admin/reports and resolves one at /admin/reports/:id/resolve for a listed operator", async () => {
    const filed = await store().fileReport({
      sessionId: "qs_wire_mod", creatorId: "u_jesse", target: { kind: "room" }, subject: null, reason: "illegal",
      note: null, reporterUserId: "u_reader", reporterLabel: "reader@x",
    }, Date.now());
    const id = (filed as { report: { id: string } }).report.id;
    const auth = { authorization: `Bearer ${await tokenFor(OPERATOR)}`, "content-type": "application/json" };
    const listed = await worker.fetch(new Request(`${ORIGIN}/admin/reports`, { headers: auth }), oauthEnv(), ctx);
    expect(((await listed.json()) as { reports: { id: string }[] }).reports.map((r) => r.id)).toEqual([id]);
    const resolved = await worker.fetch(new Request(`${ORIGIN}/admin/reports/${id}/resolve`, {
      method: "POST", headers: auth, body: JSON.stringify({ note: "handled" }),
    }), oauthEnv(), ctx);
    expect(resolved.status, await resolved.clone().text()).toBe(200);
    expect((await store().listReports(10))[0].resolvedAt).not.toBeNull();
  });

  // Both report routes sit under /rooms/, behind the suspension gate (R8): the POST files as the caller and the GET reads as
  // the creator. Each account is one no earlier case read, so this isolate's cache holds no answer for it. The controls are
  // the same requests from accounts nobody suspended, which the route serves.
  it("refuses a suspended account at POST and GET /rooms/:id/reports with the one message, files and mails nothing, and serves another", async () => {
    const sent: unknown[] = [];
    const mailing = oauthEnv({ SEND_EMAIL: { send: async (m: unknown) => { sent.push(m); return { messageId: "m1" }; } } });
    const asUser = async (userId: string, path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${await tokenFor({ userId, orgId: null, plan: "free", role: "member", label: `${userId}@example.dev` })}`, "content-type": "application/json" },
    }), mailing, ctx);
    const roomOf = (id: string, creator: string) => store().createSession(session({
      id, createdBy: creator, manifest: roomManifest({ public: true }), members: [member({ userId: creator, label: `${creator}@example.dev` })],
    }));
    await seed();
    await roomOf("qs_wire_gate_a", "u_wire_gate_creator_a");
    await roomOf("qs_wire_gate_b", "u_wire_gate_creator_b");
    for (const userId of ["u_wire_report_suspended", "u_wire_gate_creator_a"]) {
      await store().suspend(userId, { note: "wire", by: OPERATOR.userId, at: Date.now() });
    }
    const report = (userId: string) => asUser(userId, "/rooms/qs_wire_mod/reports", {
      method: "POST", body: JSON.stringify({ member_id: "m_peer", reason: "spam" }),
    });
    const suspended = { error: "suspended", error_description: "This account is suspended." };

    const refusedPost = await report("u_wire_report_suspended");
    expect([refusedPost.status, await refusedPost.json()]).toEqual([403, suspended]);
    const refusedGet = await asUser("u_wire_gate_creator_a", "/rooms/qs_wire_gate_a/reports");
    expect([refusedGet.status, await refusedGet.json()]).toEqual([403, suspended]);
    expect(await store().listReports(10), "nothing filed").toEqual([]);
    expect(sent, "nothing mailed").toEqual([]);

    const filed = await report("u_wire_report_control");
    expect(filed.status, await filed.clone().text()).toBe(201);
    const read = await asUser("u_wire_gate_creator_b", "/rooms/qs_wire_gate_b/reports");
    expect([read.status, await read.json()]).toEqual([200, { reports: [] }]);
    expect(await store().listReports(10)).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  // R8 leaves /admin/* ungated, so an operator who is suspended can still work the queue and lift a suspension.
  it("serves /admin/reports to a listed operator whose own account is suspended", async () => {
    await store().suspend("u_wire_op_suspended", { note: "wire", by: OPERATOR.userId, at: Date.now() });
    const operator = await tokenFor({ ...OPERATOR, userId: "u_wire_op_suspended" });
    const listed = await worker.fetch(new Request(`${ORIGIN}/admin/reports`, { headers: { authorization: `Bearer ${operator}` } }),
      oauthEnv({ BELLMAN_OPERATORS: "u_wire_op_suspended" }), ctx);
    expect([listed.status, await listed.json()]).toEqual([200, { reports: [] }]);
  });
});
