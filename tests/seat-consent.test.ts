/**
 * Seat consent (ADR 0027), end to end: an admin's seat for a person the org does not own by its form is
 * an invite, the person answers it on a page their next sign-in stops at, and until they join, the org
 * reaches nothing of theirs: not their sign-in, not their plan, not their rooms. GitHub is faked at the
 * fetch boundary; the org routes, the authorization server, the tools and the room routes are the real
 * ones, over one MemoryStore.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryBlobStore } from "../src/blobs.js";
import { orgRoutes } from "../src/http/orgs.js";
import { roomRoutes, type RoomCaller } from "../src/http/rooms.js";
import { handleOAuth, identityFromAccessToken, type OAuthConfig } from "../src/oauth/routes.js";
import { MemoryAuthStore } from "../src/oauth/storage.js";
import { seal } from "../src/oauth/sealed.js";
import { sha256Base64url } from "../src/oauth/tokens.js";
import { MemoryStore } from "../src/store.js";
import type { Identity, Org, PlanGrant } from "../src/types.js";
import { brief, manifestFixture } from "./helpers/fixtures.js";
import { Harness } from "./helpers/harness.js";

const ISSUER = "https://mcp.example.test";
const RESOURCE = "https://mcp.example.test/mcp";
const PANEL = "https://dash.example.test";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(64);
const NONCE_COOKIE = "__Host-bellman_signin";
const SESSION_COOKIE = "__Host-bellman_session";

/** The person signing in: GitHub 4242, whose verified address is jesse@example.dev. */
const fakeFetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.startsWith("https://github.com/login/oauth/access_token")) return Response.json({ access_token: "gh" });
  if (url === "https://api.github.com/user") return Response.json({ id: 4242, login: "jesse", email: null });
  if (url === "https://api.github.com/user/emails") return Response.json([{ email: "jesse@example.dev", primary: true, verified: true }]);
  return new Response(`unexpected upstream call: ${url}`, { status: 500 });
}) as typeof fetch;

const acme: Org = {
  orgId: "org_acme", name: "Acme", ownerUserId: "u_github_1", seats: 3, source: "operator", active: true,
  createdAt: 1, requireSso: false, domains: [],
};
const ownerGrant: PlanGrant = { key: "github:1", plan: "team", role: "admin", orgId: "org_acme", source: "operator", grantedAt: 1, grantedBy: "u_op", expiresAt: null };
const ACME_ADMIN: Identity = { userId: "u_github_1", orgId: "org_acme", plan: "team", role: "admin", label: "ana@acme.test" };
const B_ADMIN: Identity = { userId: "u_github_2", orgId: "org_b", plan: "team", role: "admin", label: "bo@b.test" };
const by = { actorUserId: "u_op" };

let plans: MemoryStore;
let config: OAuthConfig;
let harness: Harness;

beforeEach(async () => {
  plans = new MemoryStore();
  config = {
    issuer: ISSUER, resource: RESOURCE, secret: "test-signing-secret", sealSecret: "test-seal-secret",
    store: new MemoryAuthStore(), credentials: { github: { clientId: "gh-id", clientSecret: "gh-secret" } },
    overrides: {}, panelOrigins: [PANEL], plans, fetchImpl: fakeFetch,
  };
  harness = new Harness(plans);
  await plans.createOrg(acme, ownerGrant, by);
  await plans.createOrg({ ...acme, orgId: "org_b", name: "Bee", ownerUserId: "u_github_2" }, { ...ownerGrant, key: "github:2", orgId: "org_b" }, by);
});

afterEach(async () => {
  await harness.close();
});

const oauth = async (path: string, init?: RequestInit) => (await handleOAuth(new Request(`${ISSUER}${path}`, init), config))!;

/** What an org's admin sends `POST /org/members`, over a bearer token. */
async function seat(admin: Identity, key: string, role = "member") {
  const caller = async (): Promise<RoomCaller> => ({ identity: admin, via: "bearer" });
  const body = JSON.stringify({ key, role });
  return (await orgRoutes(new Request(`${ISSUER}/org/members`, {
    method: "POST", body, headers: { "content-type": "application/json", "content-length": String(body.length), authorization: "Bearer x" },
  }), { store: plans, caller, panelOrigins: [PANEL] }))!;
}

/** A client's GitHub sign-in up to the callback's answer: the invites page, or the redirect with a code. */
async function githubCallback() {
  const registered = await oauth("/register", { method: "POST", body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }) });
  const clientId = ((await registered.json()) as { client_id: string }).client_id;
  const challenge = await sha256Base64url(VERIFIER);
  const chooser = await oauth(`/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256&state=st-1&resource=${encodeURIComponent(RESOURCE)}`);
  const req = decodeURIComponent(/href="\/authorize\/github\?req=([^"]+)"/.exec(await chooser.text())![1]);
  return { clientId, res: await oauth(`/callback/github?code=upstream&state=${encodeURIComponent(req)}`) };
}

/** The held sign-in a page's forms carry. */
const heldOf = (page: string) => /name="held" value="([^"]+)"/.exec(page)![1];

/** An answer to the invites page, as its form posts it. */
const answer = (held: string, choice: string, org?: string, cookie?: string) => oauth("/auth/invites", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
  body: new URLSearchParams({ held, choice, ...(org ? { org } : {}) }).toString(),
});

/** The identity a redirect's code redeems for, or null when the redirect carried none. */
async function redeemed(clientId: string, res: Response): Promise<{ identity: Identity | null; target: URL }> {
  const target = new URL(res.headers.get("location") ?? "https://none.test/");
  const code = target.searchParams.get("code");
  if (!code) return { identity: null, target };
  const tokens = (await (await oauth("/token", {
    method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: VERIFIER, resource: RESOURCE }).toString(),
  })).json()) as { access_token: string };
  return { identity: await identityFromAccessToken(tokens.access_token, config), target };
}

/** A whole sign-in that answers every page it stops at with `choice` for `org`, then carries on. */
async function signIn(choice: "join" | "decline" | "continue" = "continue", org = "org_acme") {
  const { clientId, res } = await githubCallback();
  if (res.status !== 200) return { ...(await redeemed(clientId, res)), page: null as string | null };
  const page = await res.text();
  let after = await answer(heldOf(page), choice, org);
  if (after.status === 200) after = await answer(heldOf(await after.text()), "continue");
  return { ...(await redeemed(clientId, after)), page };
}

describe("the invites page (ADR 0027)", () => {
  it("stops a sign-in that has invites at a page naming each org, by the subject and by the verified address", async () => {
    expect((await seat(ACME_ADMIN, "github:4242", "admin")).status).toBe(202);
    expect((await seat(B_ADMIN, "email:jesse@example.dev")).status).toBe(202);
    const { res } = await githubCallback();
    expect([res.status, res.headers.get("location")]).toEqual([200, null]);
    const page = await res.text();
    expect(page).toContain("<strong>Acme</strong> invited you to join it as an admin.");
    expect(page).toContain("<strong>Bee</strong> invited you to join it as a member.");
    expect(page.match(/name="choice" value="join"/g)).toHaveLength(2);
    expect(page.match(/name="choice" value="decline"/g)).toHaveLength(2);
    expect(page).toContain('name="choice" value="continue"');
    expect(page).toContain('action="/auth/invites" method="post"');
    expect(await plans.getGrant("github:4242")).toBeUndefined();
  });

  it("carries a sign-in with no invites straight on, as before", async () => {
    const { res } = await githubCallback();
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("code")).toBeTruthy();
  });

  it("makes the grant on Join, under the subject, with the invite's role, and the sign-in lands in the org", async () => {
    await seat(ACME_ADMIN, "email:jesse@example.dev", "admin");
    await seat(ACME_ADMIN, "github:4242", "member");
    const { identity, target } = await signIn("join");
    expect(target.searchParams.get("state")).toBe("st-1");
    expect(identity).toMatchObject({ userId: "u_github_4242", orgId: "org_acme", plan: "team", role: "member" });
    expect(await plans.getGrant("github:4242")).toMatchObject({ plan: "team", role: "member", orgId: "org_acme", source: "invite", grantedBy: "u_github_1" });
    expect(await plans.getGrant("email:jesse@example.dev")).toBeUndefined();
    expect(await plans.invitesFor(["github:4242", "email:jesse@example.dev"])).toEqual([]);
    expect((await plans.auditForOrg("org_acme", 50)).at(-1)).toMatchObject({ action: "plan_granted", actorUserId: "u_github_4242", detail: { key: "github:4242", source: "invite" } });
  });

  it("removes the invite on Decline, and files nothing of the person in the org's stream", async () => {
    await seat(ACME_ADMIN, "github:4242");
    const { identity, page } = await signIn("decline");
    expect(page).toContain("Acme");
    expect(identity).toMatchObject({ userId: "u_github_4242", orgId: null, plan: "free" });
    expect(await plans.invitesFor(["github:4242"])).toEqual([]);
    expect(await plans.getGrant("github:4242")).toBeUndefined();
    const rows = await plans.auditForOrg("org_acme", 50);
    expect(rows.filter((e) => e.actorUserId === "u_github_4242" || JSON.stringify(e).includes("jesse@example.dev"))).toEqual([]);
    expect((await signIn()).page).toBeNull();
  });

  it("keeps the invite when the person carries on without answering, and asks again next time", async () => {
    await seat(ACME_ADMIN, "github:4242");
    const first = await signIn("continue");
    expect(first.page).toContain("Acme");
    expect(first.identity).toMatchObject({ orgId: null, plan: "free" });
    expect(await plans.invitesFor(["github:4242"])).toEqual([expect.objectContaining({ orgId: "org_acme" })]);
    expect((await signIn("continue")).page).toContain("Acme");
  });

  it("escapes the org's name, which is its admin's text", async () => {
    await plans.updateOrg("org_acme", { name: `<img src=x onerror="alert(1)"> & Co` }, by);
    await seat(ACME_ADMIN, "github:4242");
    const { res } = await githubCallback();
    const page = await res.text();
    expect(page).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; Co");
    expect(page).not.toContain("<img");
    const after = await answer(heldOf(page), "decline", "org_acme");
    expect(after.status).toBe(302);
  });

  it("refuses a Join while the person holds a seat elsewhere, or the org is full, keeping the invite and showing why", async () => {
    await plans.putGrantIfOwned({ ...ownerGrant, key: "github:4242", role: "member", orgId: "org_b", source: "org" }, "org_b", by);
    await seat(ACME_ADMIN, "github:4242");
    const { res } = await githubCallback();
    const refused = await answer(heldOf(await res.text()), "join", "org_acme");
    expect(refused.status).toBe(200);
    expect(await refused.text()).toContain("already in another organisation or holds a plan of its own, so it cannot join Acme");
    expect(await plans.getGrant("github:4242")).toMatchObject({ orgId: "org_b" });
    expect(await plans.invitesFor(["github:4242"])).toHaveLength(1);

    await plans.deleteGrant("github:4242");
    await plans.updateOrg("org_acme", { seats: 1 }, by);
    const full = await answer(heldOf(await (await githubCallback()).res.text()), "join", "org_acme");
    expect(await full.text()).toContain("Acme has no free seat: ask its admin for one.");
    expect(await plans.getGrant("github:4242")).toBeUndefined();
  });

  it("refuses an answer with no held sign-in, a forged one, and a choice the page does not offer", async () => {
    await seat(ACME_ADMIN, "github:4242");
    expect((await answer("forged", "join", "org_acme")).status).toBe(400);
    const { res } = await githubCallback();
    expect((await answer(heldOf(await res.text()), "seat-me", "org_acme")).status).toBe(400);
    expect(await plans.getGrant("github:4242")).toBeUndefined();
  });

  it("binds a panel sign-in's answer to the browser that started it, and keeps the nonce until the end", async () => {
    await seat(ACME_ADMIN, "github:4242");
    const start = await oauth(`/auth/signin?return_to=${encodeURIComponent(`${PANEL}/org`)}`);
    const nonce = /__Host-bellman_signin=([^;]+)/.exec(start.headers.get("set-cookie") ?? "")![1];
    const req = decodeURIComponent(/href="\/authorize\/github\?req=([^"]+)"/.exec(await start.text())![1]);
    const cookie = `${NONCE_COOKIE}=${nonce}`;
    const page = await oauth(`/callback/github?code=upstream&state=${encodeURIComponent(req)}`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(page.headers.get("set-cookie")).toBeNull();
    const held = heldOf(await page.text());

    const stranger = await answer(held, "join", "org_acme");
    expect(stranger.status).toBe(400);
    expect(await plans.getGrant("github:4242")).toBeUndefined();

    const done = await answer(held, "join", "org_acme", cookie);
    expect([done.status, done.headers.get("location")]).toEqual([302, `${PANEL}/org`]);
    expect(done.headers.get("set-cookie")).toContain(`${NONCE_COOKIE}=;`);
    const sid = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(done.headers.get("set-cookie") ?? "")![1];
    const session = await oauth("/auth/session", { headers: { cookie: `${SESSION_COOKIE}=${sid}`, origin: PANEL } });
    expect(await session.json()).toMatchObject({ user_id: "u_github_4242", org_id: "org_acme", plan: "team" });
  });
});

describe("require_sso and an invite (ADR 0027, SSO spec D13)", () => {
  beforeEach(async () => {
    await plans.claimDomain("org_acme", "acme.test", "tok", 1, by);
    await plans.verifyDomain("org_acme", "acme.test", 2, by);
    await plans.putOrgIdp("org_acme", {
      protocol: "oidc", issuer: "https://idp.test", clientId: "0oa", clientSecret: await seal("test-seal-secret", "shh"), tokenAuth: "client_secret_basic",
      authorizationEndpoint: "https://idp.test/authorize", tokenEndpoint: "https://idp.test/token", userinfoEndpoint: null, configuredAt: 3, configuredBy: "u_github_1",
    }, by);
  });

  it("does not refuse a sign-in an org only invited, and will not seat it into an org that requires SSO", async () => {
    await seat(ACME_ADMIN, "github:4242");
    await plans.updateOrg("org_acme", { requireSso: true }, by);
    const { res, clientId } = await githubCallback();
    expect(res.status).toBe(200);
    const page = await res.text();
    const join = await answer(heldOf(page), "join", "org_acme");
    expect(await join.text()).toContain("Acme requires single sign-on: to join it, start again and enter your work email.");
    expect(await plans.getGrant("github:4242")).toBeUndefined();
    const { identity } = await redeemed(clientId, await answer(heldOf(page), "continue"));
    expect(identity).toMatchObject({ userId: "u_github_4242", orgId: null, plan: "free" });
  });

  it("refuses the sign-in once the person has accepted the seat", async () => {
    await seat(ACME_ADMIN, "github:4242");
    expect((await signIn("join")).identity).toMatchObject({ orgId: "org_acme" });
    await plans.updateOrg("org_acme", { requireSso: true }, by);
    const { identity, target } = await signIn();
    expect(identity).toBeNull();
    expect(target.searchParams.get("error_description")).toContain("Acme requires single sign-on");
  });
});

describe("the rooms an org sat in (ADR 0027)", () => {
  /** A room the signed-in person starts and leaves, so it closes: what the admin's list and read look for. */
  async function closedRoomOf(identity: Identity): Promise<string> {
    const peer = await harness.connectAs(identity);
    const started = await peer.call("bellman_start", { manifest: manifestFixture(), brief: brief(), capabilities: ["read_context"] });
    expect(started.isError, started.text).toBe(false);
    const sessionId = String(started.data.session_id);
    const left = await peer.call("bellman_leave", { session_id: sessionId, member_id: String(started.data.member_id) });
    expect(left.isError, left.text).toBe(false);
    return sessionId;
  }

  const adminList = async () => {
    const caller = async (): Promise<RoomCaller> => ({ identity: ACME_ADMIN, via: "bearer" });
    const res = (await roomRoutes(new Request(`${ISSUER}/rooms?as=admin`, { headers: { authorization: "Bearer x" } }), {
      store: plans, blobs: new MemoryBlobStore(), caller, panelOrigins: [PANEL],
    }))!;
    return ((await res.json()) as { rooms: { id: string }[] }).rooms.map((r) => r.id);
  };

  it("writes no record of a room an invited person sits in, and lists none of theirs to the admin, until they join", async () => {
    await seat(ACME_ADMIN, "github:4242");
    const invited = (await signIn("continue")).identity!;
    expect(invited.orgId).toBeNull();
    const before = await closedRoomOf(invited);
    expect((await plans.getSession(before))?.orgs).toEqual([]);
    expect(await plans.sessionsForOrg("org_acme", 50)).toEqual([]);
    expect(await adminList()).toEqual([]);

    const member = (await signIn("join")).identity!;
    expect(member.orgId).toBe("org_acme");
    const after = await closedRoomOf(member);
    expect(await plans.sessionsForOrg("org_acme", 50)).toEqual([after]);
    expect(await adminList()).toEqual([after]);
  });
});
