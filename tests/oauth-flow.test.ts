import { beforeEach, describe, expect, it } from "vitest";
import { handleOAuth, identityFromAccessToken, type OAuthConfig } from "../src/oauth/routes.js";
import { MemoryAuthStore } from "../src/oauth/storage.js";
import { MemoryStore } from "../src/store.js";
import { sha256Base64url } from "../src/oauth/tokens.js";
import type { Identity } from "../src/types.js";

/**
 * The whole authorization code flow, with GitHub and Google stubbed at the
 * fetch boundary. Everything else — discovery, registration, PKCE, the signed
 * state that survives the trip to the provider, code and refresh single-use —
 * is the real implementation.
 */

const ISSUER = "https://mcp.example.test";
const RESOURCE = "https://mcp.example.test/mcp";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(64);

const fakeFetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.startsWith("https://github.com/login/oauth/access_token")) {
    return Response.json({ access_token: "gh_upstream_token" });
  }
  if (url === "https://api.github.com/user") {
    return Response.json({ id: 4242, login: "mcfearsome", email: null });
  }
  if (url === "https://api.github.com/user/emails") {
    return Response.json([{ email: "jesse@example.dev", primary: true, verified: true }]);
  }
  if (url.startsWith("https://oauth2.googleapis.com/token")) {
    return Response.json({ access_token: "g_upstream_token" });
  }
  if (url.startsWith("https://openidconnect.googleapis.com")) {
    return Response.json({ sub: "g-1", email: "jesse@example.dev", email_verified: true, name: "Jesse" });
  }
  return new Response("unexpected upstream call", { status: 500 });
}) as typeof fetch;

let config: OAuthConfig;

beforeEach(() => {
  config = {
    issuer: ISSUER,
    resource: RESOURCE,
    secret: "test-signing-secret",
    store: new MemoryAuthStore(),
    credentials: {
      github: { clientId: "gh-id", clientSecret: "gh-secret" },
      google: { clientId: "g-id", clientSecret: "g-secret" },
    },
    overrides: {},
    plans: new MemoryStore(),
    fetchImpl: fakeFetch,
  };
});

const call = async (path: string, init?: RequestInit) =>
  (await handleOAuth(new Request(`${ISSUER}${path}`, init), config))!;

async function registerClient(redirects = [REDIRECT]): Promise<string> {
  const res = await call("/register", {
    method: "POST",
    body: JSON.stringify({ client_name: "Claude", redirect_uris: redirects }),
  });
  return ((await res.json()) as { client_id: string }).client_id;
}

/** Walk authorize → provider → callback and return the authorization code. */
async function authorizeThrough(provider: "github" | "google", clientId: string, state = "st-1") {
  const challenge = await sha256Base64url(VERIFIER);
  const chooser = await call(
    `/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}` +
      `&code_challenge=${challenge}&code_challenge_method=S256&state=${state}&resource=${encodeURIComponent(RESOURCE)}`
  );
  const req = decodeURIComponent(
    new RegExp(`href="/authorize/${provider}\\?req=([^"]+)"`).exec(await chooser.text())![1]
  );
  const handoff = await call(`/authorize/${provider}?req=${encodeURIComponent(req)}`);
  const callback = await call(`/callback/${provider}?code=upstream-code&state=${encodeURIComponent(req)}`);
  const target = new URL(callback.headers.get("location")!);
  return { chooser, handoff, callback, target, code: target.searchParams.get("code") ?? "" };
}

async function exchange(clientId: string, code: string, over: Record<string, string> = {}) {
  const res = await call("/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      resource: RESOURCE,
      ...over,
    }).toString(),
  });
  return { res, body: (await res.json()) as Record<string, string> };
}

describe("discovery", () => {
  it("publishes protected resource metadata pointing at its own authorization server", async () => {
    const body = (await (await call("/.well-known/oauth-protected-resource")).json()) as Record<string, unknown>;

    expect(body.resource).toBe(RESOURCE);
    expect(body.authorization_servers).toEqual([ISSUER]);
  });

  it("publishes authorization server metadata with S256 and DCR", async () => {
    const body = (await (await call("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      registration_endpoint: `${ISSUER}/register`,
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
    });
  });

  it("leaves unrelated paths alone so the MCP endpoint still works", async () => {
    expect(await handleOAuth(new Request(`${ISSUER}/mcp`, { method: "POST" }), config)).toBeUndefined();
    expect(await handleOAuth(new Request(`${ISSUER}/healthz`), config)).toBeUndefined();
  });
});

describe("client registration", () => {
  it("issues a public client id", async () => {
    const res = await call("/register", {
      method: "POST",
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }),
    });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(201);
    expect(String(body.client_id)).toHaveLength(22);
    expect(body.token_endpoint_auth_method).toBe("none");
  });

  it("refuses redirects that would leak a code over plain http", async () => {
    const bad = await call("/register", {
      method: "POST",
      body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }),
    });
    expect(bad.status).toBe(400);

    const none = await call("/register", { method: "POST", body: JSON.stringify({}) });
    expect(none.status).toBe(400);

    const loopback = await call("/register", {
      method: "POST",
      body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:8976/cb"] }),
    });
    expect(loopback.status).toBe(201); // a local client has nowhere else to listen
  });
});

describe("authorize", () => {
  it("offers both providers once the client checks out", async () => {
    const clientId = await registerClient();
    const challenge = await sha256Base64url(VERIFIER);

    const res = await call(
      `/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}` +
        `&code_challenge=${challenge}&code_challenge_method=S256&state=st`
    );
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain("Continue with GitHub");
    expect(body).toContain("Continue with Google");
  });

  /** Redirecting an unvalidated redirect_uri is the open-redirect bug itself. */
  it("shows errors in place while the client or redirect is untrusted", async () => {
    const unknown = await call(`/authorize?response_type=code&client_id=nope&redirect_uri=${encodeURIComponent(REDIRECT)}`);
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get("location")).toBeNull();

    const clientId = await registerClient();
    const wrongRedirect = await call(
      `/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent("https://evil.example/cb")}`
    );
    expect(wrongRedirect.status).toBe(400);
    expect(wrongRedirect.headers.get("location")).toBeNull();
  });

  it("refuses plain PKCE and a resource that is not this server", async () => {
    const clientId = await registerClient();
    const base = `/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}`;
    const challenge = await sha256Base64url(VERIFIER);

    const plain = await call(`${base}&code_challenge=${challenge}&code_challenge_method=plain`);
    expect(new URL(plain.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");

    const elsewhere = await call(
      `${base}&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent("https://other.example/mcp")}`
    );
    expect(new URL(elsewhere.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
  });
});

describe("the full flow", () => {
  it("signs in with GitHub and issues a usable access token", async () => {
    const clientId = await registerClient();

    const { handoff, target, code } = await authorizeThrough("github", clientId);
    expect(handoff.headers.get("location")).toContain("https://github.com/login/oauth/authorize");
    expect(target.origin + target.pathname).toBe(REDIRECT);
    expect(target.searchParams.get("state")).toBe("st-1"); // the client's state, returned intact
    expect(code).not.toBe("");

    const { res, body } = await exchange(clientId, code);
    expect(res.status).toBe(200);
    expect(body.token_type).toBe("Bearer");

    const identity = await identityFromAccessToken(body.access_token, config);
    expect(identity).toEqual({
      userId: "u_github_4242", orgId: null, plan: "free", role: "member", label: "jesse@example.dev",
    });
  });

  it("signs in with Google too", async () => {
    const clientId = await registerClient();
    const { code } = await authorizeThrough("google", clientId);
    const { body } = await exchange(clientId, code);

    expect((await identityFromAccessToken(body.access_token, config))?.userId).toBe("u_google_g-1");
  });

  it("gives a known human the plan and org they were granted", async () => {
    const granted: Identity = {
      userId: "u_jesse", orgId: "org_codenerd", plan: "team", role: "admin", label: "jesse@codenerd",
    };
    config.overrides = { "github:4242": granted };
    const clientId = await registerClient();

    const { code } = await authorizeThrough("github", clientId);
    const { body } = await exchange(clientId, code);

    expect(await identityFromAccessToken(body.access_token, config)).toEqual(granted);
  });

  it("burns the authorization code on first use", async () => {
    const clientId = await registerClient();
    const { code } = await authorizeThrough("github", clientId);

    expect((await exchange(clientId, code)).res.status).toBe(200);
    const replay = await exchange(clientId, code);

    expect(replay.res.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
  });

  it("refuses the wrong verifier, the wrong client, and the wrong redirect", async () => {
    const clientId = await registerClient();

    const a = await authorizeThrough("github", clientId);
    expect((await exchange(clientId, a.code, { code_verifier: "w".repeat(64) })).body.error).toBe("invalid_grant");

    const b = await authorizeThrough("github", clientId);
    expect((await exchange("some-other-client", b.code)).body.error).toBe("invalid_grant");

    const c = await authorizeThrough("github", clientId);
    expect((await exchange(clientId, c.code, { redirect_uri: "https://claude.ai/other" })).body.error).toBe("invalid_grant");
  });

  it("rotates refresh tokens, retiring the one just used", async () => {
    const clientId = await registerClient();
    const { code } = await authorizeThrough("github", clientId);
    const first = (await exchange(clientId, code)).body;

    const refreshed = await call("/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId,
      }).toString(),
    });
    const second = (await refreshed.json()) as Record<string, string>;
    expect(refreshed.status).toBe(200);
    expect(second.refresh_token).not.toBe(first.refresh_token);

    const reuse = await call("/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId,
      }).toString(),
    });
    expect(((await reuse.json()) as Record<string, string>).error).toBe("invalid_grant");
  });

  it("passes an upstream refusal back to the client instead of hanging", async () => {
    const clientId = await registerClient();
    const challenge = await sha256Base64url(VERIFIER);
    const chooser = await call(
      `/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}` +
        `&code_challenge=${challenge}&code_challenge_method=S256&state=st`
    );
    const req = decodeURIComponent(/href="\/authorize\/github\?req=([^"]+)"/.exec(await chooser.text())![1]);

    const denied = await call(`/callback/github?error=access_denied&state=${encodeURIComponent(req)}`);

    expect(new URL(denied.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
  });

  it("will not take a forged or expired state on the way back", async () => {
    const forged = await call("/callback/github?code=x&state=not-a-real-state");

    expect(forged.status).toBe(400);
    expect(forged.headers.get("location")).toBeNull();
  });

  it("rejects an unsupported grant", async () => {
    const res = await call("/token", {
      method: "POST",
      body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
    });

    expect(((await res.json()) as Record<string, string>).error).toBe("unsupported_grant_type");
  });
});


/**
 * Plans are runtime data now: a stored grant decides what a signed-in human
 * gets, and the operator's BELLMAN_USERS still outranks it.
 */
describe("plan resolution", () => {
  const grant = (over: Record<string, unknown> = {}) => ({
    key: "github:4242", plan: "pro" as const, role: "member" as const, orgId: null,
    source: "purchase", grantedAt: Date.now(), grantedBy: "stripe", expiresAt: null, ...over,
  });

  async function signedInIdentity(): Promise<Identity | null> {
    const clientId = await registerClient();
    const { code } = await authorizeThrough("github", clientId);
    const { body } = await exchange(clientId, code);
    return identityFromAccessToken(body.access_token, config);
  }

  it("gives the default free identity when nothing grants anything", async () => {
    expect(await signedInIdentity()).toMatchObject({ plan: "free", role: "member", orgId: null });
  });

  it("applies a stored grant without changing who the person is", async () => {
    await config.plans!.putGrant(grant({ plan: "team", role: "admin", orgId: "org_example" }));

    const identity = await signedInIdentity();

    expect(identity).toMatchObject({ plan: "team", role: "admin", orgId: "org_example" });
    // The property that matters: a grant must not orphan existing sessions.
    expect(identity?.userId).toBe("u_github_4242");
  });

  it("lets the operator override outrank a stored grant", async () => {
    await config.plans!.putGrant(grant({ plan: "pro" }));
    config.overrides = {
      "github:4242": {
        userId: "u_jesse", orgId: "org_codenerd", plan: "team", role: "admin", label: "jesse@codenerd",
      },
    };

    expect(await signedInIdentity()).toMatchObject({ plan: "team", label: "jesse@codenerd" });
  });

  it("ignores a grant that has lapsed", async () => {
    await config.plans!.putGrant(grant({ plan: "team", orgId: "org_x", expiresAt: Date.now() - 1 }));

    expect(await signedInIdentity()).toMatchObject({ plan: "free" });
  });
});

describe("the account surface", () => {
  async function tokenFor(identity?: Identity): Promise<string> {
    if (identity) config.overrides = { "github:4242": identity };
    const clientId = await registerClient();
    const { code } = await authorizeThrough("github", clientId);
    return (await exchange(clientId, code)).body.access_token;
  }
  const admin: Identity = {
    userId: "u_admin", orgId: "org_example", plan: "team", role: "admin", label: "admin@example",
  };

  it("refuses an anonymous request and says where to start", async () => {
    const res = await call("/account");

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  it("shows plan, where it came from, and the quota", async () => {
    const token = await tokenFor();
    const res = await call("/account", { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    const body = (await res.json()) as Record<string, any>;

    expect(body).toMatchObject({ plan: "free", plan_source: "default", user_id: "u_github_4242" });
    expect(body.usage).toMatchObject({ sessions_created_this_month: 0, monthly_limit: 20, remaining: 20 });
  });

  it("names the operator when a plan was granted by the secret", async () => {
    const token = await tokenFor(admin);
    const res = await call("/account", { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });

    expect((await res.json() as Record<string, unknown>).plan_source).toBe("operator");
  });
});

describe("granting plans at runtime", () => {
  const admin: Identity = {
    userId: "u_admin", orgId: "org_example", plan: "team", role: "admin", label: "admin@example",
  };

  async function tokenFor(identity: Identity): Promise<string> {
    config.overrides = { "github:4242": identity };
    const clientId = await registerClient();
    const { code } = await authorizeThrough("github", clientId);
    return (await exchange(clientId, code)).body.access_token;
  }
  const as = (token: string, init: RequestInit = {}) => ({
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
  });

  it("is closed to anonymous callers and to people who are not team admins", async () => {
    expect((await call("/admin/grants")).status).toBe(401);

    const free = await tokenFor({
      userId: "u_free", orgId: null, plan: "free", role: "member", label: "free@example",
    });
    expect((await call("/admin/grants", as(free))).status).toBe(403);
  });

  it("grants, lists and revokes", async () => {
    const token = await tokenFor(admin);

    const granted = await call("/admin/grants", as(token, {
      method: "POST",
      body: JSON.stringify({ key: "github:99", plan: "pro", role: "member", orgId: "org_example" }),
    }));
    expect(granted.status).toBe(201);

    const listed = (await (await call("/admin/grants", as(token))).json()) as { grants: { key: string }[] };
    expect(listed.grants.map((g) => g.key)).toContain("github:99");

    const revoked = await call("/admin/grants?key=github:99", as(token, { method: "DELETE" }));
    expect(revoked.status).toBe(200);
    expect(await config.plans!.getGrant("github:99")).toBeUndefined();
  });

  it("refuses a team or admin grant with no org, which would be inert", async () => {
    const token = await tokenFor(admin);

    const res = await call("/admin/grants", as(token, {
      method: "POST",
      body: JSON.stringify({ key: "github:98", plan: "team", role: "admin" }),
    }));

    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, string>).error_description).toContain("orgId");
  });

  it("writes plan changes to the org audit log", async () => {
    const token = await tokenFor(admin);
    await call("/admin/grants", as(token, {
      method: "POST",
      body: JSON.stringify({ key: "github:97", plan: "pro", role: "member", orgId: "org_example" }),
    }));
    await call("/admin/grants?key=github:97", as(token, { method: "DELETE" }));

    const entries = await (config.plans as MemoryStore).auditForOrg("org_example", 50);
    expect(entries.map((e) => e.action)).toEqual(["plan_granted", "plan_revoked"]);
  });
});


/**
 * Grants are org-tenanted. A team admin administers their own org and nobody
 * else's — which only becomes reachable once buying `team` mints an org and
 * makes the buyer its admin, so it is worth pinning before that ships.
 */
describe("grants do not cross org boundaries", () => {
  const admin = (orgId: string, userId: string): Identity => ({
    userId, orgId, plan: "team", role: "admin", label: `${userId}@example`,
  });

  async function tokenFor(identity: Identity): Promise<string> {
    config.overrides = { "github:4242": identity };
    const clientId = await registerClient();
    const { code } = await authorizeThrough("github", clientId);
    return (await exchange(clientId, code)).body.access_token;
  }
  const as = (token: string, init: RequestInit = {}) => ({
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
  });

  it("refuses a grant aimed at another org", async () => {
    const token = await tokenFor(admin("org_mine", "u_mine"));

    const res = await call("/admin/grants", as(token, {
      method: "POST",
      body: JSON.stringify({ key: "github:victim", plan: "team", role: "admin", orgId: "org_theirs" }),
    }));

    expect(res.status).toBe(403);
    expect(await config.plans!.getGrant("github:victim")).toBeUndefined();
  });

  it("refuses an org-less grant, which would escape org scoping entirely", async () => {
    const token = await tokenFor(admin("org_mine", "u_mine"));

    const res = await call("/admin/grants", as(token, {
      method: "POST",
      body: JSON.stringify({ key: "github:anyone", plan: "pro", role: "member" }),
    }));

    expect(res.status).toBe(403);
  });

  it("lists only your own org's grants", async () => {
    await config.plans!.putGrant({
      key: "github:theirs", plan: "team", role: "member", orgId: "org_theirs",
      source: "purchase", grantedAt: Date.now(), grantedBy: "stripe", expiresAt: null,
    });
    await config.plans!.putGrant({
      key: "github:mine", plan: "team", role: "member", orgId: "org_mine",
      source: "purchase", grantedAt: Date.now(), grantedBy: "stripe", expiresAt: null,
    });
    const token = await tokenFor(admin("org_mine", "u_mine"));

    const body = (await (await call("/admin/grants", as(token))).json()) as { grants: { key: string }[] };

    expect(body.grants.map((g) => g.key)).toEqual(["github:mine"]);
  });

  it("refuses to revoke another org's grant, and leaves it standing", async () => {
    await config.plans!.putGrant({
      key: "github:theirs", plan: "team", role: "admin", orgId: "org_theirs",
      source: "purchase", grantedAt: Date.now(), grantedBy: "stripe", expiresAt: null,
    });
    const token = await tokenFor(admin("org_mine", "u_mine"));

    const res = await call("/admin/grants?key=github:theirs", as(token, { method: "DELETE" }));

    expect(res.status).toBe(403);
    expect(await config.plans!.getGrant("github:theirs")).toBeDefined();
  });
});


/** Review found each of these; each one is a way a grant outlives its revocation. */
describe("a revoked grant cannot be kept alive", () => {
  const key = "github:4242";
  const liveGrant = {
    key, plan: "team" as const, role: "admin" as const, orgId: "org_example",
    source: "purchase", grantedAt: Date.now(), grantedBy: "stripe", expiresAt: null,
  };

  it("re-resolves the plan on refresh instead of replaying the one from sign-in", async () => {
    await config.plans!.putGrant(liveGrant);
    const clientId = await registerClient();
    const { code } = await authorizeThrough("github", clientId);
    const first = (await exchange(clientId, code)).body;
    expect((await identityFromAccessToken(first.access_token, config))?.plan).toBe("team");

    // The subscription lapses. Rotation would otherwise hand out a fresh
    // 30-day refresh window carrying the old plan, forever.
    await config.plans!.deleteGrant(key);

    const refreshed = await call("/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId,
      }).toString(),
    });
    const second = (await refreshed.json()) as Record<string, string>;
    const identity = await identityFromAccessToken(second.access_token, config);

    expect(identity?.plan).toBe("free");
    expect(identity?.role).toBe("member");
    expect(identity?.orgId).toBeNull();
    // Still the same human: revoking a plan must not orphan their sessions.
    expect(identity?.userId).toBe("u_github_4242");
  });

  it("picks up an upgrade on refresh too", async () => {
    const clientId = await registerClient();
    const { code } = await authorizeThrough("github", clientId);
    const first = (await exchange(clientId, code)).body;
    expect((await identityFromAccessToken(first.access_token, config))?.plan).toBe("free");

    await config.plans!.putGrant({ ...liveGrant, plan: "pro", role: "member", orgId: null });

    const refreshed = await call("/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId,
      }).toString(),
    });
    const second = (await refreshed.json()) as Record<string, string>;

    expect((await identityFromAccessToken(second.access_token, config))?.plan).toBe("pro");
  });
});

describe("the grant endpoint validates what it is given", () => {
  const admin: Identity = {
    userId: "u_admin", orgId: "org_mine", plan: "team", role: "admin", label: "admin@example",
  };
  async function adminToken(): Promise<string> {
    config.overrides = { "github:4242": admin };
    const clientId = await registerClient();
    const { code } = await authorizeThrough("github", clientId);
    return (await exchange(clientId, code)).body.access_token;
  }
  const post = async (token: string, body: unknown) =>
    call("/admin/grants", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  it("rejects a key that could never match a signed-in human", async () => {
    const token = await adminToken();

    for (const key of [42, {}, "", "nonsense:1", "github:"]) {
      const res = await post(token, { key, plan: "pro", role: "member", orgId: "org_mine" });
      expect(res.status, `key ${JSON.stringify(key)}`).toBe(400);
    }
  });

  /** Date.now() > "soon" is false, so a bad value means "never lapses". */
  it("rejects an expiresAt that would silently never expire", async () => {
    const token = await adminToken();

    const res = await post(token, {
      key: "github:99", plan: "pro", role: "member", orgId: "org_mine", expiresAt: "next tuesday",
    });

    expect(res.status).toBe(400);
    expect(await config.plans!.getGrant("github:99")).toBeUndefined();
  });

  it("will not overwrite a grant that belongs to another org", async () => {
    await config.plans!.putGrant({
      key: "github:contested", plan: "team", role: "admin", orgId: "org_theirs",
      source: "purchase", grantedAt: Date.now(), grantedBy: "stripe", expiresAt: null,
    });
    const token = await adminToken();

    const res = await post(token, {
      key: "github:contested", plan: "pro", role: "member", orgId: "org_mine",
    });

    expect(res.status).toBe(403);
    expect((await config.plans!.getGrant("github:contested"))?.orgId).toBe("org_theirs");
  });
});
