/**
 * Single sign-on end to end (SSO spec, D12, D13): a work email routes a sign-in to its org's IdP,
 * the callback seats the person and mints what GitHub's would, and `require_sso` closes the other
 * doors to everyone in the org but its owner. The IdP, GitHub and the resolver are faked at the
 * fetch boundary; everything else is the real authorization server over a MemoryStore.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ACCESS_TOKEN_TTL_SECONDS, base64url, sha256Base64url } from "../src/oauth/tokens.js";
import { handleOAuth, identityFromAccessToken, type OAuthConfig } from "../src/oauth/routes.js";
import { MemoryAuthStore, SESSION_TTL_MS } from "../src/oauth/storage.js";
import { ssoUserId } from "../src/oauth/providers.js";
import { seal } from "../src/oauth/sealed.js";
import { MemoryStore } from "../src/store.js";
import { scimIntent } from "../src/grant-audit.js";
import type { Identity, Org, PlanGrant, ScimUser } from "../src/types.js";

const ISSUER = "https://mcp.example.test";
const RESOURCE = "https://mcp.example.test/mcp";
const PANEL = "https://dash.example.test";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(64);
const IDP = "https://idp.test";
const SEAL = "test-seal-secret";
const COOKIE = "__Host-bellman_session";
const NONCE_COOKIE = "__Host-bellman_signin";

/** What the fake IdP and the fake GitHub answer, adjustable per case. */
let idp: { sub: string; email?: string; emailVerified: boolean; name?: string; nonce: string; iss: string };
let github: { id: number; email: string | undefined };

const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
const idToken = () => `${encode({ alg: "RS256" })}.${encode({
  iss: idp.iss, aud: "0oa-client", exp: Math.floor(Date.now() / 1000) + 300, nonce: idp.nonce, sub: idp.sub,
  ...(idp.email ? { email: idp.email, email_verified: idp.emailVerified } : {}), ...(idp.name ? { name: idp.name } : {}),
})}.sig`;

const fakeFetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url === `${IDP}/token`) return Response.json({ access_token: "at", id_token: idToken() });
  if (url === `${IDP}/userinfo`) return Response.json({ sub: idp.sub, email: idp.email, email_verified: idp.emailVerified });
  if (url.startsWith("https://github.com/login/oauth/access_token")) return Response.json({ access_token: "gh" });
  if (url === "https://api.github.com/user") return Response.json({ id: github.id, login: `user${github.id}`, email: null });
  if (url === "https://api.github.com/user/emails") {
    return Response.json(github.email ? [{ email: github.email, primary: true, verified: true }] : []);
  }
  return new Response(`unexpected upstream call: ${url}`, { status: 500 });
}) as typeof fetch;

let config: OAuthConfig;
let plans: MemoryStore;
const acme: Org = {
  orgId: "org_acme", name: "Acme", ownerUserId: "u_github_1", seats: 3, source: "operator", active: true,
  createdAt: 1, requireSso: false, domains: [],
};
const ownerGrant: PlanGrant = { key: "github:1", plan: "team", role: "admin", orgId: "org_acme", source: "operator", grantedAt: 1, grantedBy: "u_op", expiresAt: null };
const by = { actorUserId: "u_op" };

beforeEach(async () => {
  idp = { sub: "00u1abc", email: "ana@acme.test", emailVerified: true, name: "Ana", nonce: "", iss: IDP };
  github = { id: 4242, email: "jesse@example.dev" };
  plans = new MemoryStore();
  config = {
    issuer: ISSUER, resource: RESOURCE, secret: "test-signing-secret", sealSecret: SEAL,
    store: new MemoryAuthStore(), credentials: { github: { clientId: "gh-id", clientSecret: "gh-secret" } },
    overrides: {}, panelOrigins: [PANEL], plans, paymentLinks: { pro_monthly: "https://buy.stripe.com/test_link" }, fetchImpl: fakeFetch,
  };
  await plans.createOrg(acme, ownerGrant, by);
  await plans.claimDomain("org_acme", "acme.test", "tok", 1, by);
  await plans.verifyDomain("org_acme", "acme.test", 2, by);
  await plans.putOrgIdp("org_acme", {
    protocol: "oidc", issuer: IDP, clientId: "0oa-client", clientSecret: await seal(SEAL, "shh"), tokenAuth: "client_secret_basic",
    authorizationEndpoint: `${IDP}/authorize`, tokenEndpoint: `${IDP}/token`, userinfoEndpoint: `${IDP}/userinfo`, configuredAt: 3, configuredBy: "u_github_1",
  }, by);
});

const call = async (path: string, init?: RequestInit) => (await handleOAuth(new Request(`${ISSUER}${path}`, init), config))!;

async function registerClient(): Promise<string> {
  const res = await call("/register", { method: "POST", body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }) });
  return ((await res.json()) as { client_id: string }).client_id;
}

/** The chooser page for a client, and the signed state its form and buttons carry. */
async function chooser(clientId: string) {
  const challenge = await sha256Base64url(VERIFIER);
  const page = await call(`/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256&state=st-1&resource=${encodeURIComponent(RESOURCE)}`);
  const text = await page.text();
  const req = decodeURIComponent(/href="\/authorize\/github\?req=([^"]+)"/.exec(text)![1]);
  return { page, text, req };
}

/** The hand-off to the IdP: what `/authorize/sso` answers for an address, and the state and nonce it sent. */
async function handoff(req: string, email: string) {
  const res = await call(`/authorize/sso?req=${encodeURIComponent(req)}&email=${encodeURIComponent(email)}`);
  const location = res.headers.get("location");
  const to = location ? new URL(location) : null;
  return { res, to, state: to?.searchParams.get("state") ?? "", nonce: to?.searchParams.get("nonce") ?? "" };
}

/** The whole code flow through SSO: the chooser, the hand-off, the callback, the token. */
async function signInThroughSso(email = "ana@acme.test") {
  const clientId = await registerClient();
  const { req } = await chooser(clientId);
  const { state, nonce } = await handoff(req, email);
  idp.nonce = nonce;
  const callback = await call(`/callback/sso/org_acme?code=c-1&state=${encodeURIComponent(state)}`);
  const target = new URL(callback.headers.get("location") ?? "https://none.test/");
  const code = target.searchParams.get("code");
  if (!code) return { clientId, callback, target, identity: null as Identity | null, tokens: null as Record<string, string> | null };
  const res = await call("/token", {
    method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: VERIFIER, resource: RESOURCE }).toString(),
  });
  const tokens = (await res.json()) as Record<string, string>;
  return { clientId, callback, target, identity: await identityFromAccessToken(tokens.access_token, config), tokens };
}

async function signInThroughGithub() {
  const clientId = await registerClient();
  const { req } = await chooser(clientId);
  await call(`/authorize/github?req=${encodeURIComponent(req)}`);
  const callback = await call(`/callback/github?code=upstream-code&state=${encodeURIComponent(req)}`);
  const target = new URL(callback.headers.get("location")!);
  const code = target.searchParams.get("code");
  if (!code) return { clientId, target, identity: null as Identity | null, tokens: null as Record<string, string> | null };
  const res = await call("/token", {
    method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: VERIFIER, resource: RESOURCE }).toString(),
  });
  const tokens = (await res.json()) as Record<string, string>;
  return { clientId, target, identity: await identityFromAccessToken(tokens.access_token, config), tokens };
}

const refresh = (clientId: string, token: string) => call("/token", {
  method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: clientId }).toString(),
});

describe("the sign-in pages", () => {
  it("carry a work-email form beside the buttons, except the page that signs in to pay", async () => {
    const { text, req } = await chooser(await registerClient());
    expect(text).toContain('action="/authorize/sso"');
    expect(text).toContain(`name="req" value="${req.replace(/"/g, "&quot;")}"`);
    expect(text).toContain('type="email"');
    expect(text).toContain('href="/authorize/github?req=');
    const panel = await call("/auth/signin");
    expect(await panel.text()).toContain('action="/authorize/sso"');
    const upgrade = await call("/upgrade/pro_monthly");
    expect(await upgrade.text()).not.toContain('action="/authorize/sso"');
  });
});

describe("routing by domain (D12)", () => {
  it("sends a verified domain's address to its org's IdP with the state, a nonce and the org's redirect", async () => {
    const { req } = await chooser(await registerClient());
    const { res, to, state, nonce } = await handoff(req, "Ana@ACME.test");
    expect(res.status).toBe(302);
    expect(to!.origin + to!.pathname).toBe(`${IDP}/authorize`);
    expect(Object.fromEntries(to!.searchParams)).toEqual({
      client_id: "0oa-client", redirect_uri: `${ISSUER}/callback/sso/org_acme`, response_type: "code", scope: "openid email profile", state, nonce,
    });
    expect(state).toBe(req);
    expect(nonce).toBe(await sha256Base64url(req));
  });

  it("shows the page again, with a notice and the buttons, for an address no verified domain routes", async () => {
    const { req } = await chooser(await registerClient());
    await plans.claimDomain("org_acme", "claimed.test", "t2", 1, by);
    for (const email of ["bo@nowhere.test", "bo@claimed.test", "not-an-address"]) {
      const { res } = await handoff(req, email);
      expect(res.status, email).toBe(200);
      const text = await res.text();
      expect(text).toContain("No single sign-on is set up for");
      expect(text).toContain('href="/authorize/github?req=');
      expect(text).toContain('action="/authorize/sso"');
    }
    await plans.deleteOrgIdp("org_acme", by);
    expect(await (await handoff(req, "ana@acme.test")).res.text()).toContain("No single sign-on is set up for");
  });

  it("refuses an expired or forged state, and does not pay through single sign-on", async () => {
    const { res } = await handoff("not-a-state", "ana@acme.test");
    expect(res.status).toBe(400);
    const upgrade = await call("/upgrade/pro_monthly");
    const req = decodeURIComponent(/href="\/authorize\/github\?req=([^"]+)"/.exec(await upgrade.text())![1]);
    const paying = await handoff(req, "ana@acme.test");
    expect(paying.res.status).toBe(400);
    expect(await paying.res.text()).toContain("not used to pay");
  });
});

describe("the callback (D12, D13)", () => {
  it("seats the person on first use and mints a token for the team member they now are", async () => {
    const { identity, target } = await signInThroughSso();
    expect(target.searchParams.get("state")).toBe("st-1");
    expect(identity).toEqual({
      userId: ssoUserId("org_acme", "00u1abc"), orgId: "org_acme", plan: "team", role: "member", label: "ana@acme.test",
    });
    expect(await plans.getGrant("sso:org_acme:00u1abc")).toMatchObject({ plan: "team", role: "member", orgId: "org_acme", source: "sso", grantedBy: "sso" });
    expect(await plans.countOrgMembers("org_acme")).toBe(2);
  });

  it("provisions nothing the second time, and resolves the role an admin set since", async () => {
    await signInThroughSso();
    await plans.putGrantIfOwned({ ...ownerGrant, key: "sso:org_acme:00u1abc", role: "admin", source: "sso" }, "org_acme", by);
    const { identity } = await signInThroughSso();
    expect(identity).toMatchObject({ role: "admin", plan: "team" });
    expect(await plans.countOrgMembers("org_acme")).toBe(2);
    expect((await plans.auditForOrg("org_acme", 50)).filter((e) => e.actorUserId === "sso")).toHaveLength(1);
  });

  it("claims an admin's address grant onto the subject, taking no second seat", async () => {
    await plans.putGrantIfOwned({ ...ownerGrant, key: "email:ana@acme.test", role: "admin", source: "org" }, "org_acme", by);
    const { identity } = await signInThroughSso();
    expect(identity).toMatchObject({ role: "admin", userId: ssoUserId("org_acme", "00u1abc") });
    expect(await plans.getGrant("email:ana@acme.test")).toBeUndefined();
    expect(await plans.getGrant("sso:org_acme:00u1abc")).toMatchObject({ role: "admin", source: "org" });
    expect(await plans.countOrgMembers("org_acme")).toBe(2);
  });

  it("labels by the name when the IdP vouches for no address, and files no email key then", async () => {
    idp = { ...idp, emailVerified: false };
    const { identity } = await signInThroughSso();
    expect(identity).toMatchObject({ label: "Ana@sso", plan: "team" });
    idp = { ...idp, email: "ana@elsewhere.test", emailVerified: true };
    expect((await signInThroughSso()).identity?.label).toBe("Ana@sso");
  });

  it("refuses a full org before anything is minted", async () => {
    await plans.updateOrg("org_acme", { seats: 1 }, by);
    const { target, identity } = await signInThroughSso();
    expect(identity).toBeNull();
    expect(target.searchParams.get("error")).toBe("access_denied");
    expect(target.searchParams.get("error_description")).toContain("no free seat");
    expect(await plans.getGrant("sso:org_acme:00u1abc")).toBeUndefined();
  });

  it("refuses an id token for another nonce or another issuer", async () => {
    const clientId = await registerClient();
    const { req } = await chooser(clientId);
    const { state } = await handoff(req, "ana@acme.test");
    idp.nonce = "someone-elses";
    const replayed = await call(`/callback/sso/org_acme?code=c-1&state=${encodeURIComponent(state)}`);
    expect(new URL(replayed.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
    idp = { ...idp, nonce: await sha256Base64url(state), iss: "https://evil.test" };
    const forged = await call(`/callback/sso/org_acme?code=c-1&state=${encodeURIComponent(state)}`);
    expect(new URL(forged.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
    expect(await plans.getGrant("sso:org_acme:00u1abc")).toBeUndefined();
  });

  it("answers a page for an org with no IdP or no record, and 400 for a bad state", async () => {
    const { req } = await chooser(await registerClient());
    expect((await call(`/callback/sso/org_nobody?code=c&state=${encodeURIComponent(req)}`)).status).toBe(404);
    expect((await call(`/callback/sso/org_acme?code=c&state=forged`)).status).toBe(400);
    expect((await call(`/callback/sso/bad%20id?code=c&state=${encodeURIComponent(req)}`)).status).toBe(404);
  });
});

describe("SCIM-provisioned members (SCIM spec, D4)", () => {
  const pushed = (over: Partial<ScimUser> = {}): ScimUser => ({
    id: "x1", orgId: "org_acme", userName: "ana@acme.test", externalId: "00u1abc", active: true, key: "email:ana@acme.test", createdAt: 5, updatedAt: 5, ...over,
  });

  it("signs in a pushed address onto its seat, taking no second one, and links the subject to the SCIM user", async () => {
    expect((await plans.createScimUser(pushed(), scimIntent("org_acme"))).outcome).toBe("written");
    const { identity } = await signInThroughSso();
    expect(identity).toMatchObject({ orgId: "org_acme", plan: "team", role: "member", userId: ssoUserId("org_acme", "00u1abc") });
    expect(await plans.getGrant("email:ana@acme.test")).toBeUndefined();
    expect(await plans.getGrant("sso:org_acme:00u1abc")).toMatchObject({ source: "scim" });
    expect(await plans.scimUserByKey("sso:org_acme:00u1abc")).toMatchObject({ id: "x1", key: "sso:org_acme:00u1abc" });
    expect(await plans.countOrgMembers("org_acme")).toBe(2);
  });

  it("links a push to a person who signed in before the connector existed", async () => {
    await signInThroughSso();
    expect((await plans.createScimUser(pushed(), scimIntent("org_acme"))).outcome).toBe("linked");
    expect(await plans.scimUserByKey("sso:org_acme:00u1abc")).toMatchObject({ id: "x1" });
    expect(await plans.countOrgMembers("org_acme")).toBe(2);
  });

  it("refuses a deactivated person at the callback, minting nothing", async () => {
    await plans.createScimUser(pushed(), scimIntent("org_acme"));
    await signInThroughSso();
    await plans.updateScimUser("org_acme", "x1", { active: false }, Date.now(), scimIntent("org_acme"));
    const { identity, target } = await signInThroughSso();
    expect(identity).toBeNull();
    expect(target.searchParams.get("error")).toBe("access_denied");
    expect(target.searchParams.get("error_description")).toContain("removed your access");
    expect(await plans.getGrant("sso:org_acme:00u1abc")).toBeUndefined();
    expect(await plans.countOrgMembers("org_acme")).toBe(1);
  });

  it("stops a deactivated person's refresh and panel session at their next re-check, and admits them again once reactivated", async () => {
    await plans.createScimUser(pushed(), scimIntent("org_acme"));
    const { clientId, tokens } = await signInThroughSso();
    expect(tokens).not.toBeNull();
    const sid = "sid-scim";
    const now = Date.now();
    await config.store.putSession(sid, {
      identity: { userId: ssoUserId("org_acme", "00u1abc"), orgId: "org_acme", plan: "team", role: "member", label: "ana@acme.test" },
      plan_source: "grant", identity_keys: ["sso:org_acme:00u1abc", "email:ana@acme.test"], created_at: now, last_used_at: now,
      replanned_at: now - ACCESS_TOKEN_TTL_SECONDS * 1000 - 1, expires_at: now + SESSION_TTL_MS,
    });
    await plans.updateScimUser("org_acme", "x1", { active: false }, now, scimIntent("org_acme"));

    const refused = await refresh(clientId, tokens!.refresh_token);
    const body = (await refused.json()) as { error: string; error_description: string };
    expect([refused.status, body.error]).toEqual([400, "invalid_grant"]);
    expect(body.error_description).toContain("removed your access");
    expect((await refresh(clientId, tokens!.refresh_token)).status).toBe(400);
    const session = await call("/auth/session", { headers: { cookie: `${COOKIE}=${sid}`, origin: PANEL } });
    expect(session.status).toBe(401);
    expect(await config.store.touchSession(sid, Date.now())).toBeUndefined();

    await plans.updateScimUser("org_acme", "x1", { active: true }, Date.now(), scimIntent("org_acme"));
    const { identity } = await signInThroughSso();
    expect(identity).toMatchObject({ orgId: "org_acme", plan: "team", role: "member" });
    expect(await plans.countOrgMembers("org_acme")).toBe(2);
  });
});

describe("the panel's sign-in through single sign-on", () => {
  it("sets the session cookie for the member, bound to the browser that started it", async () => {
    const start = await call("/auth/signin?return_to=" + encodeURIComponent(`${PANEL}/rooms`));
    const nonceCookie = /__Host-bellman_signin=([^;]+)/.exec(start.headers.get("set-cookie") ?? "")![1];
    const req = decodeURIComponent(/href="\/authorize\/github\?req=([^"]+)"/.exec(await start.text())![1]);
    const { state, nonce } = await handoff(req, "ana@acme.test");
    idp.nonce = nonce;
    const stranger = await call(`/callback/sso/org_acme?code=c-1&state=${encodeURIComponent(state)}`);
    expect(stranger.status).toBe(400);
    const done = await call(`/callback/sso/org_acme?code=c-1&state=${encodeURIComponent(state)}`, { headers: { cookie: `${NONCE_COOKIE}=${nonceCookie}` } });
    expect([done.status, done.headers.get("location")]).toEqual([302, `${PANEL}/rooms`]);
    const sid = /__Host-bellman_session=([^;]+)/.exec(done.headers.get("set-cookie") ?? "")![1];
    const session = await call("/auth/session", { headers: { cookie: `${COOKIE}=${sid}`, origin: PANEL } });
    expect(await session.json()).toMatchObject({ user_id: ssoUserId("org_acme", "00u1abc"), plan: "team", org_id: "org_acme" });
  });
});

describe("require_sso (D13)", () => {
  beforeEach(async () => {
    await plans.putGrantIfOwned({ ...ownerGrant, key: "github:4242", role: "member", source: "org" }, "org_acme", by);
    await plans.updateOrg("org_acme", { requireSso: true }, by);
  });

  it("refuses a member's GitHub sign-in, naming the org", async () => {
    const { identity, target } = await signInThroughGithub();
    expect(identity).toBeNull();
    expect(target.searchParams.get("error")).toBe("access_denied");
    expect(target.searchParams.get("error_description")).toContain("Acme requires single sign-on");
  });

  it("refuses a GitHub sign-in whose verified address is under the org's domain, grant or none", async () => {
    github = { id: 777, email: "bo@acme.test" };
    const { identity, target } = await signInThroughGithub();
    expect(identity).toBeNull();
    expect(target.searchParams.get("error_description")).toContain("Acme requires single sign-on");
  });

  /**
   * The documented path: an admin seats an address as admin, turns the switch on, and the person
   * clicks GitHub once by mistake. The refusal must leave the address grant where the SSO sign-in
   * will claim it; moving it onto the refused GitHub subject first would strand the role and burn
   * a seat when SSO then provisions a fresh member.
   */
  it("refuses before it claims, so a mistaken GitHub click costs the address grant nothing", async () => {
    await plans.putGrantIfOwned({ ...ownerGrant, key: "email:bo@acme.test", role: "admin", source: "org" }, "org_acme", by);
    github = { id: 777, email: "bo@acme.test" };
    expect((await signInThroughGithub()).identity).toBeNull();
    expect(await plans.getGrant("email:bo@acme.test")).toMatchObject({ role: "admin" });
    expect(await plans.getGrant("github:777")).toBeUndefined();
    idp = { ...idp, sub: "00u777", email: "bo@acme.test", name: "Bo" };
    expect((await signInThroughSso("bo@acme.test")).identity).toMatchObject({ role: "admin", userId: ssoUserId("org_acme", "00u777") });
    expect(await plans.countOrgMembers("org_acme")).toBe(3);
  });

  it("admits the owner, an operator override and the IdP's own sign-in", async () => {
    github = { id: 1, email: "owner@acme.test" };
    expect((await signInThroughGithub()).identity).toMatchObject({ userId: "u_github_1", role: "admin", orgId: "org_acme" });
    github = { id: 4242, email: "jesse@example.dev" };
    config.overrides = { "github:4242": { userId: "u_github_4242", orgId: "org_acme", plan: "team", role: "member", label: "op" } };
    expect((await signInThroughGithub()).identity).toMatchObject({ plan: "team" });
    config.overrides = {};
    expect((await signInThroughSso()).identity).toMatchObject({ plan: "team", userId: ssoUserId("org_acme", "00u1abc") });
  });

  it("stops a member's refresh and a panel session at their next re-check", async () => {
    await plans.updateOrg("org_acme", { requireSso: false }, by);
    const { clientId, tokens } = await signInThroughGithub();
    expect(tokens).not.toBeNull();
    const sid = "sid-1";
    const now = Date.now();
    await config.store.putSession(sid, {
      identity: { userId: "u_github_4242", orgId: "org_acme", plan: "team", role: "member", label: "jesse@example.dev" },
      plan_source: "grant", identity_keys: ["github:4242", "email:jesse@example.dev"], created_at: now, last_used_at: now,
      replanned_at: now - ACCESS_TOKEN_TTL_SECONDS * 1000 - 1, expires_at: now + SESSION_TTL_MS,
    });
    await plans.updateOrg("org_acme", { requireSso: true }, by);

    const refused = await refresh(clientId, tokens!.refresh_token);
    expect([refused.status, ((await refused.json()) as { error: string }).error]).toEqual([400, "invalid_grant"]);
    expect((await refresh(clientId, tokens!.refresh_token)).status).toBe(400);
    const session = await call("/auth/session", { headers: { cookie: `${COOKIE}=${sid}`, origin: PANEL } });
    expect(session.status).toBe(401);
    expect(await config.store.touchSession(sid, Date.now())).toBeUndefined();
  });
});
