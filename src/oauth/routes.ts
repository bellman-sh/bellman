import type { Identity } from "../types.js";
import { withPaidPlan, type BillingStorage } from "../billing/ledger.js";
import {
  PROVIDERS, grantFor, identityFor, isProviderName, type ProviderCredentials, type ProviderName,
} from "./providers.js";
import type { AuthStorage } from "./storage.js";
import {
  ACCESS_TOKEN_TTL_SECONDS, AUTH_CODE_TTL_MS, REFRESH_TOKEN_TTL_MS, STATE_TTL_SECONDS,
  canonicalResource, randomId, signJwt, verifyJwt, verifyPkce,
} from "./tokens.js";

/**
 * Bellman's authorization server: OAuth 2.1 with PKCE, dynamic client
 * registration, and GitHub/Google as the upstream identity providers.
 *
 * Bellman is both the authorization server and the resource server, which is
 * allowed and keeps the deployment to one Worker. The two roles are still kept
 * honest about each other: a token is minted for exactly one resource URI, and
 * /mcp refuses anything whose audience is not itself.
 */

export interface OAuthConfig {
  /** Origin of this server, e.g. https://mcp.bellman.sh */
  issuer: string;
  /** Canonical URI tokens are minted for, e.g. https://mcp.bellman.sh/mcp */
  resource: string;
  secret: string;
  store: AuthStorage;
  credentials: Partial<Record<ProviderName, ProviderCredentials>>;
  overrides?: Record<string, Identity>;
  /**
   * What Stripe says people have paid for. When set, every token issued to a
   * signed-in human without an operator grant carries their paid plan, looked
   * up at sign-in and again on every refresh.
   */
  billing?: BillingStorage;
  /**
   * Stripe Payment Links by name, e.g. { pro_monthly: "https://buy.stripe.com/…" }.
   * /upgrade/<name> signs the human in and sends them to the link tagged with
   * their user id, which is how the webhook knows whose plan to change.
   */
  paymentLinks?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

const STATE_AUDIENCE = "bellman:authorize-state";
const UPGRADE_AUDIENCE = "bellman:upgrade-state";
const SCOPE = "bellman";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

const oauthError = (error: string, description: string, status = 400) =>
  json({ error, error_description: description }, status);

const html = (body: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Bellman</title><style>
        :root{color-scheme:light dark}
        body{font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
             max-width:32rem;margin:0 auto;padding:3rem 1.25rem;}
        h1{font-size:1.35rem;letter-spacing:-.02em;margin:0 0 .25rem}
        p{color:#556;margin:.25rem 0 1.5rem}
        a.btn{display:block;padding:.85rem 1rem;margin:.5rem 0;border:1px solid #c7ccd4;
              border-radius:8px;text-decoration:none;color:inherit;font-weight:600}
        a.btn:hover{border-color:#1a5e7a}
        code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}
        @media (prefers-color-scheme:dark){p{color:#98a2b0}a.btn{border-color:#39424f}}
      </style>${body}`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  );

const escape = (value: string) =>
  value.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);

/** A redirect_uri must be registered, and must be https or loopback. */
function usableRedirect(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol === "https:") return true;
    return parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

interface AuthorizeRequest {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  state?: string;
}

/** Carried through the provider round trip when signing in to pay. */
interface UpgradeRequest {
  link: string;
}

/** Send a signed-in human to the Payment Link, tagged so the webhook can credit them. */
async function finishUpgrade(
  url: URL,
  name: ProviderName,
  creds: ProviderCredentials,
  pending: UpgradeRequest,
  config: OAuthConfig
): Promise<Response> {
  const target = config.paymentLinks?.[pending.link];
  const code = url.searchParams.get("code");
  if (!target || !code) {
    return html(`<h1>Sign-in did not finish</h1><p>Nothing was charged. Start the upgrade again.</p>`, 400);
  }
  let identity: Identity;
  let email: string | undefined;
  try {
    const profile = await PROVIDERS[name].exchange(creds, code, `${config.issuer}/callback/${name}`, config.fetchImpl);
    identity = identityFor(profile, config.overrides);
    email = profile.email;
  } catch (err) {
    console.error(`${name} sign-in for upgrade failed:`, err);
    return html(`<h1>Sign-in failed</h1><p>Nothing was charged. Start the upgrade again.</p>`, 502);
  }
  const checkout = new URL(target);
  checkout.searchParams.set("client_reference_id", identity.userId);
  if (email) checkout.searchParams.set("prefilled_email", email);
  return Response.redirect(checkout.toString(), 302);
}

export async function handleOAuth(
  request: Request,
  config: OAuthConfig
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;

  // ------------------------------------------------------------- discovery
  if (method === "GET" && path.startsWith("/.well-known/oauth-protected-resource")) {
    return json({
      resource: config.resource,
      authorization_servers: [config.issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: [SCOPE],
      resource_documentation: "https://github.com/bellman-sh/bellman",
    });
  }

  if (method === "GET" && path.startsWith("/.well-known/oauth-authorization-server")) {
    return json({
      issuer: config.issuer,
      authorization_endpoint: `${config.issuer}/authorize`,
      token_endpoint: `${config.issuer}/token`,
      registration_endpoint: `${config.issuer}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [SCOPE],
      service_documentation: "https://github.com/bellman-sh/bellman",
    });
  }

  // --------------------------------------------- dynamic client registration
  if (method === "POST" && path === "/register") {
    let body: { client_name?: string; redirect_uris?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return oauthError("invalid_client_metadata", "body must be JSON");
    }
    const redirects = Array.isArray(body.redirect_uris) ? (body.redirect_uris as string[]) : [];
    if (redirects.length === 0) {
      return oauthError("invalid_redirect_uri", "redirect_uris is required");
    }
    if (!redirects.every((uri) => typeof uri === "string" && usableRedirect(uri))) {
      return oauthError("invalid_redirect_uri", "every redirect_uri must be https, or http on loopback");
    }

    const client = {
      client_id: randomId(16),
      client_name: typeof body.client_name === "string" ? body.client_name.slice(0, 120) : undefined,
      redirect_uris: redirects,
      created_at: Date.now(),
    };
    await config.store.registerClient(client);
    return json(
      {
        client_id: client.client_id,
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
        // A public client: no secret to leak from a desktop app, PKCE instead.
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_id_issued_at: Math.floor(client.created_at / 1000),
      },
      201
    );
  }

  // ------------------------------------------------------------- /authorize
  if (method === "GET" && path === "/authorize") {
    const q = url.searchParams;
    const clientId = q.get("client_id") ?? "";
    const redirectUri = q.get("redirect_uri") ?? "";

    // Until the client and its redirect_uri are known good, errors are shown
    // here rather than redirected: sending them onward is an open redirect.
    const client = clientId ? await config.store.getClient(clientId) : undefined;
    if (!client) {
      return html(`<h1>Unknown client</h1><p>This application is not registered with Bellman.</p>`, 400);
    }
    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
      return html(
        `<h1>Redirect not registered</h1><p><code>${escape(redirectUri || "(none)")}</code> is not a registered redirect for this client.</p>`,
        400
      );
    }

    const back = (error: string, description: string) => {
      const target = new URL(redirectUri);
      target.searchParams.set("error", error);
      target.searchParams.set("error_description", description);
      const state = q.get("state");
      if (state) target.searchParams.set("state", state);
      return Response.redirect(target.toString(), 302);
    };

    if (q.get("response_type") !== "code") return back("unsupported_response_type", "only code is supported");
    if (q.get("code_challenge_method") !== "S256") return back("invalid_request", "code_challenge_method must be S256");
    const challenge = q.get("code_challenge") ?? "";
    if (challenge.length < 43) return back("invalid_request", "code_challenge is required");

    const requested = q.get("resource");
    if (requested && canonicalResource(requested) !== config.resource) {
      return back("invalid_target", `this server only issues tokens for ${config.resource}`);
    }

    const pending: AuthorizeRequest = {
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      resource: config.resource,
      state: q.get("state") ?? undefined,
    };
    const stateToken = await signJwt(
      { iss: config.issuer, sub: "authorize", aud: STATE_AUDIENCE, bellman: pending as never },
      config.secret,
      STATE_TTL_SECONDS
    );

    const available = (Object.keys(PROVIDERS) as ProviderName[]).filter((name) => config.credentials[name]);
    if (available.length === 0) {
      return html(`<h1>No sign-in configured</h1><p>This Bellman server has no identity provider set up.</p>`, 503);
    }
    const buttons = available
      .map((name) => `<a class="btn" href="/authorize/${name}?req=${encodeURIComponent(stateToken)}">Continue with ${PROVIDERS[name].displayName}</a>`)
      .join("");
    return html(
      `<h1>Connect to Bellman</h1>` +
        `<p><strong>${escape(client.client_name ?? "An application")}</strong> wants to join and create Bellman sessions as you.</p>` +
        buttons
    );
  }

  // --------------------------------------------------------- /upgrade/<link>
  // Paying needs to know who is paying, so it starts with the same sign-in.
  const upgradeMatch = /^\/upgrade\/([a-z0-9_]{1,64})$/.exec(path);
  if (method === "GET" && upgradeMatch) {
    const link = upgradeMatch[1];
    if (!config.paymentLinks?.[link]) {
      return html(`<h1>Unknown plan</h1><p>There is no plan called <code>${escape(link)}</code>.</p>`, 404);
    }
    const available = (Object.keys(PROVIDERS) as ProviderName[]).filter((name) => config.credentials[name]);
    if (available.length === 0) {
      return html(`<h1>No sign-in configured</h1><p>This Bellman server has no identity provider set up.</p>`, 503);
    }
    const stateToken = await signJwt(
      { iss: config.issuer, sub: "upgrade", aud: UPGRADE_AUDIENCE, bellman: { link } as never },
      config.secret,
      STATE_TTL_SECONDS
    );
    const buttons = available
      .map((name) => `<a class="btn" href="/authorize/${name}?req=${encodeURIComponent(stateToken)}">Continue with ${PROVIDERS[name].displayName}</a>`)
      .join("");
    return html(
      `<h1>Upgrade Bellman</h1>` +
        `<p>Sign in with the account you use Bellman with, so the plan lands on it. Then you'll pay on Stripe.</p>` +
        buttons
    );
  }

  // ------------------------------------------- hand off to a provider
  const startMatch = /^\/authorize\/([a-z]+)$/.exec(path);
  if (method === "GET" && startMatch) {
    const name = startMatch[1];
    if (!isProviderName(name)) return oauthError("invalid_request", "unknown provider", 404);
    const creds = config.credentials[name];
    if (!creds) return oauthError("invalid_request", `${name} sign-in is not configured`, 503);

    const req = url.searchParams.get("req") ?? "";
    const claims =
      (await verifyJwt(req, config.secret, { issuer: config.issuer, audience: STATE_AUDIENCE })) ??
      (await verifyJwt(req, config.secret, { issuer: config.issuer, audience: UPGRADE_AUDIENCE }));
    if (!claims) return html(`<h1>This sign-in link expired</h1><p>Start the connection again.</p>`, 400);

    return Response.redirect(
      PROVIDERS[name].authorizeUrl(creds, `${config.issuer}/callback/${name}`, req),
      302
    );
  }

  // ------------------------------------------------- provider comes back
  const callbackMatch = /^\/callback\/([a-z]+)$/.exec(path);
  if (method === "GET" && callbackMatch) {
    const name = callbackMatch[1];
    if (!isProviderName(name)) return oauthError("invalid_request", "unknown provider", 404);
    const creds = config.credentials[name];
    if (!creds) return oauthError("invalid_request", `${name} sign-in is not configured`, 503);

    const state = url.searchParams.get("state") ?? "";
    const claims = await verifyJwt(state, config.secret, { issuer: config.issuer, audience: STATE_AUDIENCE });
    if (!claims) {
      const upgrade = await verifyJwt(state, config.secret, { issuer: config.issuer, audience: UPGRADE_AUDIENCE });
      if (upgrade) return finishUpgrade(url, name, creds, upgrade.bellman as unknown as UpgradeRequest, config);
      return html(`<h1>This sign-in link expired</h1><p>Start the connection again.</p>`, 400);
    }
    const pending = claims.bellman as unknown as AuthorizeRequest;

    const upstreamError = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const target = new URL(pending.redirect_uri);
    if (pending.state) target.searchParams.set("state", pending.state);

    if (upstreamError || !code) {
      target.searchParams.set("error", "access_denied");
      target.searchParams.set("error_description", upstreamError ?? "no authorization code returned");
      return Response.redirect(target.toString(), 302);
    }

    let identity: Identity;
    let granted: boolean;
    try {
      const profile = await PROVIDERS[name].exchange(
        creds, code, `${config.issuer}/callback/${name}`, config.fetchImpl
      );
      granted = grantFor(profile, config.overrides) !== undefined;
      identity = identityFor(profile, config.overrides);
    } catch (err) {
      console.error(`${name} sign-in failed:`, err);
      target.searchParams.set("error", "access_denied");
      target.searchParams.set("error_description", `${name} sign-in failed`);
      return Response.redirect(target.toString(), 302);
    }

    const authCode = randomId();
    await config.store.putCode(authCode, {
      client_id: pending.client_id,
      redirect_uri: pending.redirect_uri,
      code_challenge: pending.code_challenge,
      resource: pending.resource,
      identity,
      granted,
      expires_at: Date.now() + AUTH_CODE_TTL_MS,
    });
    target.searchParams.set("code", authCode);
    return Response.redirect(target.toString(), 302);
  }

  // ----------------------------------------------------------------- /token
  if (method === "POST" && path === "/token") {
    const form = new URLSearchParams(await request.text());
    const grant = form.get("grant_type");

    if (grant === "authorization_code") {
      const code = form.get("code") ?? "";
      const stored = code ? await config.store.takeCode(code) : undefined;
      if (!stored) return oauthError("invalid_grant", "authorization code is invalid, used, or expired");
      if (stored.client_id !== form.get("client_id")) {
        return oauthError("invalid_grant", "authorization code was issued to another client");
      }
      if (stored.redirect_uri !== form.get("redirect_uri")) {
        return oauthError("invalid_grant", "redirect_uri does not match the authorization request");
      }
      if (!(await verifyPkce(form.get("code_verifier") ?? "", stored.code_challenge))) {
        return oauthError("invalid_grant", "PKCE verification failed");
      }
      const requested = form.get("resource");
      if (requested && canonicalResource(requested) !== stored.resource) {
        return oauthError("invalid_target", "resource does not match the authorization request");
      }
      return issueTokens(config, stored.client_id, stored.resource, stored.identity, stored.granted);
    }

    if (grant === "refresh_token") {
      const token = form.get("refresh_token") ?? "";
      const stored = token ? await config.store.takeRefresh(token) : undefined;
      if (!stored) return oauthError("invalid_grant", "refresh token is invalid, used, or expired");
      const clientId = form.get("client_id");
      if (clientId && stored.client_id !== clientId) {
        return oauthError("invalid_grant", "refresh token was issued to another client");
      }
      return issueTokens(config, stored.client_id, stored.resource, stored.identity, stored.granted);
    }

    return oauthError("unsupported_grant_type", "use authorization_code or refresh_token");
  }

  return undefined;
}

async function issueTokens(
  config: OAuthConfig,
  clientId: string,
  resource: string,
  identity: Identity,
  granted: boolean | undefined
): Promise<Response> {
  // The plan is looked up here, not only at sign-in, because a refresh would
  // otherwise carry the sign-in plan forward forever: a cancelled customer
  // would keep paying-customer limits and an upgrade would never arrive. With
  // this, a plan change lands within one access-token lifetime.
  //
  // With billing switched off (or in shadow) there is no paid plan to find,
  // and the identity drops back to the free default. Skipping the lookup
  // instead would let a plan granted while billing was on ride refreshes
  // forever after it was switched off.
  if (granted === false) {
    identity = withPaidPlan(identity, config.billing ? await config.billing.paidPlan(identity.userId) : undefined);
  }
  const accessToken = await signJwt(
    { iss: config.issuer, sub: identity.userId, aud: resource, bellman: identity },
    config.secret,
    ACCESS_TOKEN_TTL_SECONDS
  );
  // Rotated on every use: the previous one was deleted when it was taken.
  const refreshToken = randomId();
  await config.store.putRefresh(refreshToken, {
    client_id: clientId,
    resource,
    identity,
    granted,
    expires_at: Date.now() + REFRESH_TOKEN_TTL_MS,
  });
  return json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: SCOPE,
  });
}

/** Resolve an access token presented to /mcp. Audience is checked here. */
export async function identityFromAccessToken(
  token: string,
  config: Pick<OAuthConfig, "issuer" | "resource" | "secret">
): Promise<Identity | null> {
  const claims = await verifyJwt(token, config.secret, {
    issuer: config.issuer,
    audience: config.resource,
  });
  return (claims?.bellman as Identity | undefined) ?? null;
}

/** RFC 9728: a 401 points the client at the metadata that starts the dance. */
export function unauthorizedHeaders(config: Pick<OAuthConfig, "issuer">): Record<string, string> {
  return {
    "www-authenticate":
      `Bearer resource_metadata="${config.issuer}/.well-known/oauth-protected-resource"`,
  };
}
