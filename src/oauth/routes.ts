import { entitlementsFor } from "../auth.js";
import type { BellmanStore } from "../store.js";
import type { Identity, PlanGrant } from "../types.js";
import {
  PROVIDERS, defaultIdentity, identityKeys, isProviderName,
  type ProviderCredentials, type ProviderName, type ProviderProfile,
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
  /** Runtime plan grants. Absent means only BELLMAN_USERS decides a plan. */
  plans?: PlanStore;
  fetchImpl?: typeof fetch;
}

/** The slice of BellmanStore the authorization server needs. */
export type PlanStore = Pick<
  BellmanStore,
  "getGrant" | "putGrant" | "deleteGrant" | "listGrants" | "countCreatesThisMonth" | "appendAudit"
>;

export type PlanSource = "operator" | "grant" | "default";

/**
 * Which identity a signed-in human gets, and why.
 *
 * Precedence is deliberate: the operator's BELLMAN_USERS wins over a stored
 * grant. That is the escape hatch — comping an account, fixing a botched
 * webhook, granting yourself team — and it has to outrank automation or it
 * cannot do that job.
 *
 * A grant contributes plan, role and org ONLY. userId and label come from the
 * provider profile, so granting, changing or revoking a plan never orphans the
 * sessions that human already created.
 */
export async function resolvePlan(
  profile: ProviderProfile,
  config: Pick<OAuthConfig, "overrides" | "plans">
): Promise<{ identity: Identity; source: PlanSource; keys: string[] }> {
  const keys = identityKeys(profile);
  for (const key of keys) {
    const override = config.overrides?.[key];
    if (override) return { identity: override, source: "operator", keys };
  }
  if (config.plans) {
    for (const key of keys) {
      const grant = await config.plans.getGrant(key);
      if (grant) {
        return {
          identity: { ...defaultIdentity(profile), plan: grant.plan, role: grant.role, orgId: grant.orgId },
          source: "grant",
          keys,
        };
      }
    }
  }
  return { identity: defaultIdentity(profile), source: "default", keys };
}

/**
 * Re-resolve a plan at refresh time, from the keys captured at sign-in.
 *
 * Without this a token refresh reissues whatever plan was captured when the
 * human first signed in, and because every rotation grants a fresh 30-day
 * refresh window, a revoked grant would survive for as long as the client kept
 * refreshing. userId and label are kept from the original identity: those come
 * from the provider and do not change, and re-deriving them here would need a
 * profile this code no longer has.
 */
export async function replanOnRefresh(
  stored: Identity,
  keys: string[],
  config: Pick<OAuthConfig, "overrides" | "plans">
): Promise<{ identity: Identity; source: PlanSource }> {
  const base: Identity = { ...stored, plan: "free", role: "member", orgId: null };
  for (const key of keys) {
    const override = config.overrides?.[key];
    if (override) return { identity: override, source: "operator" };
  }
  if (config.plans) {
    for (const key of keys) {
      const grant = await config.plans.getGrant(key);
      if (grant) {
        return {
          identity: { ...base, plan: grant.plan, role: grant.role, orgId: grant.orgId },
          source: "grant",
        };
      }
    }
  }
  return { identity: base, source: "default" };
}

const STATE_AUDIENCE = "bellman:authorize-state";
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

  // ------------------------------------------- hand off to a provider
  const startMatch = /^\/authorize\/([a-z]+)$/.exec(path);
  if (method === "GET" && startMatch) {
    const name = startMatch[1];
    if (!isProviderName(name)) return oauthError("invalid_request", "unknown provider", 404);
    const creds = config.credentials[name];
    if (!creds) return oauthError("invalid_request", `${name} sign-in is not configured`, 503);

    const req = url.searchParams.get("req") ?? "";
    const claims = await verifyJwt(req, config.secret, { issuer: config.issuer, audience: STATE_AUDIENCE });
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
    if (!claims) return html(`<h1>This sign-in link expired</h1><p>Start the connection again.</p>`, 400);
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
    let planSource: PlanSource = "default";
    let keys: string[] = [];
    try {
      const profile = await PROVIDERS[name].exchange(
        creds, code, `${config.issuer}/callback/${name}`, config.fetchImpl
      );
      const resolved = await resolvePlan(profile, config);
      identity = resolved.identity;
      planSource = resolved.source;
      keys = resolved.keys;
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
      plan_source: planSource,
      identity_keys: keys,
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
      return issueTokens(
        config, stored.client_id, stored.resource, stored.identity,
        stored.plan_source, stored.identity_keys
      );
    }

    if (grant === "refresh_token") {
      const token = form.get("refresh_token") ?? "";
      const stored = token ? await config.store.takeRefresh(token) : undefined;
      if (!stored) return oauthError("invalid_grant", "refresh token is invalid, used, or expired");
      const clientId = form.get("client_id");
      if (clientId && stored.client_id !== clientId) {
        return oauthError("invalid_grant", "refresh token was issued to another client");
      }
      // Re-resolved, not replayed: a grant revoked since sign-in must not
      // survive because the client kept refreshing.
      const current = await replanOnRefresh(stored.identity, stored.identity_keys, config);
      return issueTokens(
        config, stored.client_id, stored.resource, current.identity,
        current.source, stored.identity_keys
      );
    }

    return oauthError("unsupported_grant_type", "use authorization_code or refresh_token");
  }

  // -------------------------------------------------------------- /account
  // What a signed-in human can see about themselves: who they are, what plan,
  // where that plan came from, and how much of the monthly quota is left.
  if (method === "GET" && path === "/account") {
    const who = await caller(request, config);
    if (!who) {
      return new Response("Sign in to see your account.", {
        status: 401,
        headers: { ...unauthorizedHeaders(config), "content-type": "text/plain" },
      });
    }
    const { identity, planSource } = who;
    const limits = entitlementsFor(identity);
    const used = (await config.plans?.countCreatesThisMonth(identity.userId)) ?? 0;
    const account = {
      user_id: identity.userId,
      label: identity.label,
      plan: identity.plan,
      role: identity.role,
      org_id: identity.orgId,
      plan_source: planSource,
      entitlements: limits,
      usage: {
        sessions_created_this_month: used,
        monthly_limit: limits.monthlyCreates,
        remaining: Math.max(limits.monthlyCreates - used, 0),
      },
    };
    if ((request.headers.get("accept") ?? "").includes("application/json")) return json(account);

    const row = (k: string, v: string) => `<tr><th>${escape(k)}</th><td>${escape(v)}</td></tr>`;
    return html(
      `<h1>Your Bellman account</h1>` +
        `<p>${escape(identity.label)}</p>` +
        `<table>` +
        row("Plan", `${identity.plan} (${planSource === "operator" ? "granted by the operator" : planSource === "grant" ? "granted" : "default"})`) +
        row("Role", identity.role) +
        row("Org", identity.orgId ?? "none") +
        row("Sessions this month", `${used} of ${limits.monthlyCreates}`) +
        row("Modes", limits.modes.join(", ")) +
        row("Members per session", String(limits.maxMembers)) +
        row("Session lifetime", `${Math.round(limits.sessionTtlMs / 3_600_000)} hours`) +
        `</table>` +
        `<p>Joining a session is free on every plan. Only creating one is limited.</p>`
    );
  }

  // ------------------------------------------------------- /admin/grants
  // Plans as runtime data. Same bar as the audit log: team plan, admin role,
  // and an org — the three things that make someone an operator here.
  if (path === "/admin/grants") {
    const who = await caller(request, config);
    if (!who) return oauthError("invalid_token", "sign in first", 401);
    const { identity } = who;
    if (!entitlementsFor(identity).audit || identity.role !== "admin" || !identity.orgId) {
      return oauthError("insufficient_scope", "granting plans requires a team admin", 403);
    }
    if (!config.plans) return oauthError("unsupported", "this server has no plan store", 501);

    if (method === "GET") {
      // Scoped to the caller's org: a listing of every grant on the platform
      // would leak other orgs' customers and their plans.
      return json({ grants: await config.plans.listGrants(200, identity.orgId) });
    }

    if (method === "POST") {
      let body: Partial<PlanGrant> & { note?: string };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return oauthError("invalid_request", "body must be JSON");
      }
      // The body is untrusted JSON. A cast is not validation: an unusable key
      // or a non-numeric expiresAt would otherwise be accepted and stored.
      const KEY_PREFIXES = ["github:", "google:", "email:"];
      if (typeof body.key !== "string" || !KEY_PREFIXES.some((p) => body.key!.startsWith(p)) ||
          body.key.length <= Math.max(...KEY_PREFIXES.map((p) => p.length))) {
        return oauthError(
          "invalid_request",
          `key must be one of ${KEY_PREFIXES.map((p) => `${p}<id>`).join(", ")}`
        );
      }
      if (body.expiresAt !== undefined && body.expiresAt !== null &&
          !Number.isFinite(body.expiresAt)) {
        // Date.now() > "soon" is false, so a bad value would silently mean
        // "never lapses" — the opposite of what the caller asked for.
        return oauthError("invalid_request", "expiresAt must be a number of milliseconds, or null");
      }
      if (!body.plan || !["free", "pro", "team"].includes(body.plan)) {
        return oauthError("invalid_request", "plan must be free, pro or team");
      }
      if (!body.role || !["member", "admin"].includes(body.role)) {
        return oauthError("invalid_request", "role must be member or admin");
      }
      // Same rule grant-plan enforces locally: org scoping and the audit log
      // both key off orgId, so a team or admin grant without one is inert.
      const orgId = body.orgId ?? null;
      if ((body.plan === "team" || body.role === "admin") && !orgId) {
        return oauthError("invalid_request", "a team or admin grant needs an orgId");
      }
      // An admin administers their own org and no other. Without this, every
      // team admin could grant themselves admin inside anyone else's org —
      // which becomes reachable the moment a purchase creates an org and makes
      // the buyer its admin. Org-less grants come from billing, not from here;
      // the operator's BELLMAN_USERS remains the way to grant outside an org.
      if (orgId !== identity.orgId) {
        return oauthError("insufficient_scope", "grants must target your own org", 403);
      }

      // The org check above validates what the caller CLAIMS. This checks what
      // is stored: without it, an admin could overwrite another org's grant for
      // the same key simply by naming their own org.
      const existingForKey = await config.plans.getGrant(body.key);
      if (existingForKey && existingForKey.orgId !== identity.orgId) {
        return oauthError("insufficient_scope", "that key already has a grant in another org", 403);
      }

      const grant: PlanGrant = {
        key: body.key,
        plan: body.plan,
        role: body.role,
        orgId,
        source: body.source ?? "operator",
        grantedAt: Date.now(),
        grantedBy: identity.userId,
        expiresAt: body.expiresAt ?? null,
      };
      await config.plans.putGrant(grant);
      await recordGrantAudit(config, identity, grant.orgId, "plan_granted", grant.key, {
        plan: grant.plan, role: grant.role, org_id: grant.orgId, source: grant.source,
      });
      return json({ granted: grant }, 201);
    }

    if (method === "DELETE") {
      const key = url.searchParams.get("key") ?? "";
      if (!key) return oauthError("invalid_request", "key is required");
      const existing = await config.plans.getGrant(key);
      // Same rule as granting, and checked against what is stored rather than
      // what the caller claims: revoking another org's customer is not yours.
      if (!existing || existing.orgId !== identity.orgId) {
        return oauthError("insufficient_scope", "no such grant in your org", 403);
      }
      await config.plans.deleteGrant(key);
      await recordGrantAudit(config, identity, existing.orgId, "plan_revoked", key, {});
      return json({ revoked: key });
    }

    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST, DELETE" } });
  }

  return undefined;
}

/** Identify the caller from an access token. Bearer keys are for /mcp, not here. */
async function caller(
  request: Request,
  config: OAuthConfig
): Promise<{ identity: Identity; planSource: string } | null> {
  const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!bearer) return null;
  const claims = await verifyJwt(bearer, config.secret, {
    issuer: config.issuer,
    audience: config.resource,
  });
  if (!claims) return null;
  return {
    identity: claims.bellman,
    planSource: String((claims as Record<string, unknown>).plan_source ?? "default"),
  };
}

/**
 * A plan change is exactly the kind of crossing the org audit log is for.
 * It is written to the AFFECTED org, not the actor's, so the record lands where
 * the consequence does even if the two ever diverge.
 */
async function recordGrantAudit(
  config: OAuthConfig,
  actor: Identity,
  affectedOrgId: string | null,
  action: string,
  key: string,
  detail: Record<string, unknown>
): Promise<void> {
  if (!config.plans || !affectedOrgId) return;
  await config.plans.appendAudit({
    at: Date.now(),
    orgId: affectedOrgId,
    sessionId: `grant:${key}`,
    actorUserId: actor.userId,
    action,
    detail: { key, ...detail },
  });
}

async function issueTokens(
  config: OAuthConfig,
  clientId: string,
  resource: string,
  identity: Identity,
  planSource = "default",
  identityKeysForRefresh: string[] = []
): Promise<Response> {
  const accessToken = await signJwt(
    { iss: config.issuer, sub: identity.userId, aud: resource, bellman: identity, plan_source: planSource },
    config.secret,
    ACCESS_TOKEN_TTL_SECONDS
  );
  // Rotated on every use: the previous one was deleted when it was taken.
  const refreshToken = randomId();
  await config.store.putRefresh(refreshToken, {
    client_id: clientId,
    resource,
    identity,
    plan_source: planSource,
    identity_keys: identityKeysForRefresh,
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
