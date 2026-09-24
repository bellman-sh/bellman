import { beforeEach, describe, expect, it } from "vitest";
import { handleOAuth, identityFromAccessToken, type OAuthConfig } from "../src/oauth/routes.js";
import { MemoryAuthStore } from "../src/oauth/storage.js";
import { sha256Base64url } from "../src/oauth/tokens.js";
import type { Identity } from "../src/types.js";
import { MemoryBillingStore } from "../src/billing/ledger.js";

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

describe("plans from billing", () => {
  let billing: MemoryBillingStore;

  beforeEach(() => {
    billing = new MemoryBillingStore();
    config.billing = billing;
    config.paymentLinks = { pro_monthly: "https://buy.stripe.com/test_pro" };
  });

  const refresh = async (clientId: string, token: string) => {
    const res = await call("/token", {
      method: "POST",
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: clientId }).toString(),
    });
    return (await res.json()) as Record<string, string>;
  };

  const pay = async (userId: string, plan: "pro" | "team", status = "active", eventAt = 1) => {
    await billing.linkCustomer("cus_1", userId);
    await billing.recordSubscription("cus_1", "sub_1", { plan, status, eventAt });
  };

  it("signs in on the plan already paid for", async () => {
    await pay("u_github_4242", "pro");
    const clientId = await registerClient();
    const { code } = await authorizeThrough("github", clientId);
    const { body } = await exchange(clientId, code);

    expect((await identityFromAccessToken(body.access_token, config))?.plan).toBe("pro");
  });

  it("picks up an upgrade and a cancellation on the next refresh, without signing in again", async () => {
    const clientId = await registerClient();
    const { code } = await authorizeThrough("github", clientId);
    const first = (await exchange(clientId, code)).body;
    expect((await identityFromAccessToken(first.access_token, config))?.plan).toBe("free");

    await pay("u_github_4242", "team");
    const upgraded = await refresh(clientId, first.refresh_token);
    expect(await identityFromAccessToken(upgraded.access_token, config)).toMatchObject({
      userId: "u_github_4242", plan: "team", orgId: "org_cus_1", role: "admin",
    });

    await billing.recordSubscription("cus_1", "sub_1", { plan: "team", status: "canceled", eventAt: 2 });
    const cancelled = await refresh(clientId, upgraded.refresh_token);
    expect(await identityFromAccessToken(cancelled.access_token, config)).toMatchObject({
      plan: "free", orgId: null, role: "member",
    });
  });

  it("leaves an operator grant alone, whatever billing says", async () => {
    const granted: Identity = {
      userId: "u_jesse", orgId: "org_codenerd", plan: "team", role: "admin", label: "jesse@codenerd",
    };
    config.overrides = { "github:4242": granted };
    await pay("u_jesse", "pro", "canceled");
    const clientId = await registerClient();
    const { code } = await authorizeThrough("github", clientId);
    const first = (await exchange(clientId, code)).body;
    const again = await refresh(clientId, first.refresh_token);

    expect(await identityFromAccessToken(first.access_token, config)).toEqual(granted);
    expect(await identityFromAccessToken(again.access_token, config)).toEqual(granted);
  });

  it("leaves refresh tokens from before billing existed as they were", async () => {
    const legacy: Identity = { userId: "u_github_4242", orgId: null, plan: "pro", role: "member", label: "x" };
    await config.store.putRefresh("legacy-token", {
      client_id: "c1", resource: RESOURCE, identity: legacy, expires_at: Date.now() + 60_000,
    });
    const body = await refresh("c1", "legacy-token");

    expect(await identityFromAccessToken(body.access_token, config)).toEqual(legacy);
  });

  it("signs a human in on the way to checkout and tags the link with who they are", async () => {
    const chooser = await call("/upgrade/pro_monthly");
    expect(chooser.status).toBe(200);
    const req = decodeURIComponent(/href="\/authorize\/github\?req=([^"]+)"/.exec(await chooser.text())![1]);

    const handoff = await call(`/authorize/github?req=${encodeURIComponent(req)}`);
    expect(handoff.headers.get("location")).toContain("https://github.com/login/oauth/authorize");

    const back = await call(`/callback/github?code=upstream-code&state=${encodeURIComponent(req)}`);
    const checkout = new URL(back.headers.get("location")!);
    expect(checkout.origin + checkout.pathname).toBe("https://buy.stripe.com/test_pro");
    expect(checkout.searchParams.get("client_reference_id")).toBe("u_github_4242");
    expect(checkout.searchParams.get("prefilled_email")).toBe("jesse@example.dev");
  });

  it("does not let an upgrade state stand in for an authorization request", async () => {
    const chooser = await call("/upgrade/pro_monthly");
    const req = decodeURIComponent(/href="\/authorize\/github\?req=([^"]+)"/.exec(await chooser.text())![1]);
    const back = await call(`/callback/github?code=upstream-code&state=${encodeURIComponent(req)}`);

    // Straight to Stripe: no authorization code is minted for anyone.
    expect(new URL(back.headers.get("location")!).searchParams.get("code")).toBeNull();
  });

  it("refuses a plan it has no link for", async () => {
    expect((await call("/upgrade/platinum")).status).toBe(404);
  });
});

describe("switching billing off", () => {
  it("drops a plan paid for while billing was on at the next refresh", async () => {
    const billing = new MemoryBillingStore();
    config.billing = billing;
    await billing.linkCustomer("cus_1", "u_github_4242");
    await billing.recordSubscription("cus_1", "sub_1", { plan: "pro", status: "active", eventAt: 1 });
    const clientId = await registerClient();
    const { code } = await authorizeThrough("github", clientId);
    const first = (await exchange(clientId, code)).body;
    expect((await identityFromAccessToken(first.access_token, config))?.plan).toBe("pro");

    config.billing = undefined; // BELLMAN_BILLING back to off
    const res = await call("/token", {
      method: "POST",
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId }).toString(),
    });
    const after = (await res.json()) as Record<string, string>;

    expect(await identityFromAccessToken(after.access_token, config)).toMatchObject({ plan: "free", orgId: null, role: "member" });
  });
});
