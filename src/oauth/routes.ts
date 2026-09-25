import { entitlementsFor } from "../auth.js";
import { isOrgId } from "../grant-index.js";
import { isLinkableUserId } from "../billing/stripe.js";
import { PURCHASE, canPurchaseAs } from "../billing/grants.js";
import type { BellmanStore } from "../store.js";
import type { Identity, PlanGrant } from "../types.js";
import {
  PROVIDERS, defaultIdentity, grantKeys, identityKeys, immutableKeys,
  isProviderName, isStableIdentityKey,
  type ProviderCredentials, type ProviderName, type ProviderProfile,
} from "./providers.js";
import {
  CLIENT_CAP, REGISTRATIONS_PER_HOUR, REGISTRATION_WINDOW_MS, UNUSED_CLIENT_TTL_MS,
  type AuthStorage,
} from "./storage.js";
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
   * Stripe Payment Links by name, e.g. { pro_monthly: "https://buy.stripe.com/…" }.
   * /upgrade/<name> signs the human in and sends them to the link tagged with
   * their user id, which is how the webhook knows whose plan to change.
   *
   * Billing itself is not here. A purchase becomes a grant, so it resolves
   * through `plans` like every other plan — there is no second source to wire.
   */
  paymentLinks?: Record<string, string>;
  /**
   * Whether purchased plans count. False makes BELLMAN_BILLING a real switch:
   * with it off, grants Stripe wrote earlier stop resolving instead of quietly
   * carrying on, and the ones an operator or admin wrote are untouched.
   */
  honourPurchases?: boolean;
  /** Runtime plan grants. Absent means only BELLMAN_USERS decides a plan. */
  plans?: PlanStore;
  fetchImpl?: typeof fetch;
}

/** The slice of BellmanStore the authorization server needs. */
export type PlanStore = Pick<
  BellmanStore,
  | "getGrant" | "putGrant" | "deleteGrant" | "moveGrant" | "listGrants"
  | "putGrantIfOwned" | "deleteGrantIfOwned"
  | "countCreatesThisMonth" | "appendAudit"
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
 *
 * An override is the exception, and only here: it supplies the whole identity,
 * userId included, which is what lets an operator point someone at a specific
 * account. replanOnRefresh deliberately does not — see there.
 */
export async function resolvePlan(
  profile: ProviderProfile,
  config: Pick<OAuthConfig, "overrides" | "plans" | "honourPurchases">
): Promise<{ identity: Identity; source: PlanSource; grantSource?: string; keys: string[] }> {
  const keys = identityKeys(profile);
  for (const key of keys) {
    const override = config.overrides?.[key];
    if (override) return { identity: override, source: "operator", keys };
  }
  const match = config.plans
    ? await firstGrant(config.plans, keys, config.honourPurchases !== false)
    : undefined;
  if (match) {
    // Sign-in is the only place with the profile, so it is the only place that
    // can pin an address-keyed grant to the subject behind it.
    await claimGrant(config.plans!, match.grant, match.key, profile);
    const { grant } = match;
    return {
      identity: { ...defaultIdentity(profile), plan: grant.plan, role: grant.role, orgId: grant.orgId },
      source: "grant",
      // `source` says a stored grant decided this; `grantSource` says who wrote
      // it. /upgrade needs the second: a purchase may replace a purchase, and
      // must not replace one an admin wrote by hand.
      grantSource: grant.source,
      keys,
    };
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
  config: Pick<OAuthConfig, "overrides" | "plans" | "honourPurchases">
): Promise<{ identity: Identity; source: PlanSource }> {
  const base: Identity = { ...stored, plan: "free", role: "member", orgId: null };
  // The subject and nothing else. These keys were written down at sign-in and
  // any of the others may have been reassigned since — an address handed to a
  // new hire, a login vacated and reclaimed — so an override or grant added
  // against one of those names somebody who is not the holder of this token.
  const durable = immutableKeys(keys);
  for (const key of durable) {
    const override = config.overrides?.[key];
    // Plan, role and org only — the same three fields the grant branch below
    // applies. Returning the override whole would let an operator added after
    // sign-in rewrite userId on the next refresh, and this token's holder would
    // come back as a different human with none of their sessions. Sign-in is
    // where an override gets to name someone; refresh is not.
    if (override) {
      return {
        identity: { ...base, plan: override.plan, role: override.role, orgId: override.orgId },
        source: "operator",
      };
    }
  }
  // Same rule for grants. An address-keyed grant is claimed onto the subject at
  // sign-in, so one that legitimately applies to this human is already filed
  // under a key this sees; one that is not is a grant for whoever holds that
  // address now, and this token is not them.
  const match = config.plans
    ? await firstGrant(config.plans, durable, config.honourPurchases !== false)
    : undefined;
  if (match) {
    const { grant } = match;
    return {
      identity: { ...base, plan: grant.plan, role: grant.role, orgId: grant.orgId },
      source: "grant",
    };
  }
  return { identity: base, source: "default" };
}

/**
 * The grant for the most specific key that has one.
 *
 * Only stable keys are consulted: a label is not an identifier, and a grant
 * filed against one would transfer to whoever holds that label next. See
 * isStableIdentityKey.
 *
 * The lookups run together rather than one await at a time. Each is a round
 * trip to the singleton registry object, this runs on every sign-in and every
 * refresh, and the common case — no grant at all — otherwise pays for every
 * key in sequence. Priority order is preserved by picking from the results.
 */
async function firstGrant(
  plans: PlanStore,
  keys: string[],
  honourPurchases: boolean
): Promise<{ grant: PlanGrant; key: string } | undefined> {
  const stable = grantKeys(keys);
  const found = await Promise.all(stable.map((key) => plans.getGrant(key)));
  for (const [i, grant] of found.entries()) {
    if (usableGrant(grant) && (honourPurchases || grant.source !== PURCHASE)) {
      return { grant, key: stable[i] };
    }
  }
  return undefined;
}

/**
 * Whether a stored grant is one the admin route would have written.
 *
 * That route validates, but it is not the only way a record gets here:
 * putGrant is part of the store API and the billing path writes through it. Org
 * scoping and the audit log both key off orgId, so a `team` or `admin` grant
 * without one hands out the limits while belonging to nobody. Skipping it here
 * rather than trusting the write path also lets a lower-priority key still have
 * its turn, instead of one malformed record shadowing a good grant.
 */
function usableGrant(grant: PlanGrant | undefined): grant is PlanGrant {
  if (!grant) return false;
  if ((grant.plan === "team" || grant.role === "admin") && !grant.orgId) return false;
  if (grant.orgId !== null && !isOrgId(grant.orgId)) return false;
  return true;
}

/**
 * Pin an address-keyed grant to the subject that just claimed it.
 *
 * A verified address is not an identity either. In a managed domain it can be
 * taken off one account and handed to the next person with that name, and they
 * can verify it upstream — so a grant that does not expire would follow the
 * address rather than the human, which is the same transfer the label rule
 * exists to stop.
 *
 * Refusing address keys outright would take away the only way an admin can
 * grant to someone they know by email. So the first sign-in that resolves
 * through an address rewrites the grant onto the provider's immutable subject
 * and retires the address key: after that the address is inert and a later
 * owner of it inherits nothing.
 *
 * The move is one atomic store operation, not a write followed by a delete: a
 * failed delete would leave the address key standing while the subject copy won
 * for this user, so nothing would ever retry the cleanup and the address would
 * stay claimable by its next owner.
 *
 * Best effort at the call site, which is now safe — the move either happened or
 * it did not. Failing to tidy up must not cost the human their sign-in, and the
 * grant keeps resolving by address until a later sign-in succeeds.
 */
async function claimGrant(
  plans: PlanStore,
  grant: PlanGrant,
  matchedKey: string,
  profile: ProviderProfile
): Promise<void> {
  const subjectKey = `${profile.provider}:${profile.subject}`;
  if (matchedKey === subjectKey) return;
  try {
    await plans.moveGrant(matchedKey, subjectKey);
  } catch (err) {
    console.error("could not pin a grant to its subject:", err);
  }
}

/**
 * The identity keys on a stored authorization code or refresh token, or null
 * when the record predates the field.
 *
 * OAuth shipped before plans were re-resolved on refresh, so records written by
 * the previous build have no identity_keys and refresh tokens live 30 days.
 * Iterating the missing field throws — and by then takeRefresh has already
 * retired the token, so the client loses it to a 500. Defaulting to [] would be
 * worse: it resolves to the free plan, silently downgrading a paying customer.
 * Refusing deliberately costs one sign-in and mints a record with the field.
 */
function storedIdentityKeys(stored: { identity_keys?: string[] }): string[] | null {
  return Array.isArray(stored.identity_keys) ? stored.identity_keys : null;
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

/** A configured Payment Link by name. Own keys only: /upgrade/constructor is not a plan. */
function paymentLink(config: OAuthConfig, name: string): string | undefined {
  const links = config.paymentLinks;
  return links && Object.hasOwn(links, name) ? links[name] : undefined;
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
  const target = paymentLink(config, pending.link);
  const code = url.searchParams.get("code");
  if (!target || !code) {
    return html(`<h1>Sign-in did not finish</h1><p>Nothing was charged. Start the upgrade again.</p>`, 400);
  }
  let resolved: Awaited<ReturnType<typeof resolvePlan>>;
  let email: string | undefined;
  try {
    const profile = await PROVIDERS[name].exchange(creds, code, `${config.issuer}/callback/${name}`, config.fetchImpl);
    resolved = await resolvePlan(profile, config);
    email = profile.email;
  } catch (err) {
    console.error(`${name} sign-in for upgrade failed:`, err);
    return html(`<h1>Sign-in failed</h1><p>Nothing was charged. Start the upgrade again.</p>`, 502);
  }
  const { identity } = resolved;
  // Stop before Stripe rather than take money for a plan that will not apply.
  //
  // Two ways that happens. An operator override outranks anything paid for. And
  // a stored grant an *admin* wrote is one billing may not touch — reconciling
  // would call putGrantIfSource(…, "purchase"), get "conflict", and leave the
  // buyer charged with nothing changed. A purchase grant is fine: a purchase is
  // allowed to replace one it already owns, which is what an upgrade is.
  const blockedByGrant = resolved.source === "grant" && resolved.grantSource !== PURCHASE;
  if (resolved.source === "operator" || blockedByGrant) {
    return html(
      `<h1>Your plan is set by an administrator</h1>` +
        `<p>This account is on <strong>${escape(identity.plan)}</strong>, assigned directly rather than bought. ` +
        `Paying wouldn't change it, so nothing was charged. Ask whoever runs this Bellman server to change your plan.</p>`
    );
  }
  // Both questions, before any money moves: can this id survive the trip
  // through Stripe, and can a purchase actually be applied to it afterwards?
  // An operator-named id like u_jesse passes the first and fails the second,
  // and taking payment for a grant that will be refused is the worst outcome
  // available here.
  if (!isLinkableUserId(identity.userId) || !canPurchaseAs(identity.userId)) {
    console.error(`upgrade: no purchase can be applied to user id ${identity.userId}`);
    return html(`<h1>This account can't be upgraded here</h1><p>Nothing was charged. Contact the operator.</p>`, 409);
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
    // Cloudflare sets this; the Node server is local development and has no
    // proxy in front of it. Unknown IP means no limiting rather than a shared
    // bucket, which would rate-limit a developer against themself.
    const ip = request.headers.get("cf-connecting-ip");
    if (ip) {
      const recent = await config.store.countRecentRegistrations(ip, Date.now() - REGISTRATION_WINDOW_MS);
      if (recent >= REGISTRATIONS_PER_HOUR) {
        return oauthError("too_many_requests", "too many registrations from this address — try later", 429);
      }
    }

    const redirects = Array.isArray(body.redirect_uris) ? (body.redirect_uris as string[]) : [];
    if (redirects.length === 0) {
      return oauthError("invalid_redirect_uri", "redirect_uris is required");
    }
    if (!redirects.every((uri) => typeof uri === "string" && usableRedirect(uri))) {
      return oauthError("invalid_redirect_uri", "every redirect_uri must be https, or http on loopback");
    }

    // Evict lapsed registrations before testing the cap. Refusing outright
    // would let anyone who fills the table with clients they never signed in
    // with block every real client until the next purge.
    await config.store.purgeExpiredClients(Date.now());
    if ((await config.store.countClients()) >= CLIENT_CAP) {
      return oauthError("too_many_requests", "the client registry is full — try later", 429);
    }

    const client = {
      client_id: randomId(16),
      client_name: typeof body.client_name === "string" ? body.client_name.slice(0, 120) : undefined,
      redirect_uris: redirects,
      created_at: Date.now(),
      // Disposable until a token is issued for it.
      expires_at: Date.now() + UNUSED_CLIENT_TTL_MS,
    };
    await config.store.registerClient(client);
    if (ip) await config.store.recordRegistration(ip);
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
    if (!paymentLink(config, link)) {
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
    // Either audience: the same provider hand-off serves connecting a client
    // and signing in to pay, and only the callback needs to tell them apart.
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
      // An upgrade came back through the same callback; it ends at Stripe
      // rather than at an authorization code.
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
      const codeKeys = storedIdentityKeys(stored);
      if (!codeKeys) {
        return oauthError("invalid_grant", "this authorization code predates plan re-resolution — start the flow again");
      }
      // Same rule as the refresh branch below: takeCode has already burned this
      // code, and issuing can still fail on the way to storing a refresh token.
      // Put the code back so the client can retry, rather than sending it round
      // the whole authorize flow again. It is the code the caller just
      // presented, so restoring it opens no window this request did not have.
      try {
        return await issueTokens(
          config, stored.client_id, stored.resource, stored.identity,
          stored.plan_source, codeKeys
        );
      } catch (err) {
        console.error("could not issue tokens for an authorization code:", err);
        await config.store.putCode(code, stored).catch(() => {});
        return oauthError("temporarily_unavailable", "could not issue tokens — retry", 503);
      }
    }

    if (grant === "refresh_token") {
      const token = form.get("refresh_token") ?? "";
      const stored = token ? await config.store.takeRefresh(token) : undefined;
      if (!stored) return oauthError("invalid_grant", "refresh token is invalid, used, or expired");
      const clientId = form.get("client_id");
      if (clientId && stored.client_id !== clientId) {
        return oauthError("invalid_grant", "refresh token was issued to another client");
      }
      const keys = storedIdentityKeys(stored);
      if (!keys) {
        return oauthError("invalid_grant", "this refresh token predates plan re-resolution — sign in again");
      }
      // Re-resolved, not replayed: a grant revoked since sign-in must not
      // survive because the client kept refreshing.
      //
      // takeRefresh has already retired this token, and re-resolution talks to
      // the registry object over RPC. A transient failure there would otherwise
      // cost the client its refresh token and force a full sign-in, so the
      // token goes back and the client is told to retry. Restoring the token it
      // just presented opens no replay window the request did not already have.
      try {
        const current = await replanOnRefresh(stored.identity, keys, config);
        // Issuance is inside the same guard: signing and storing the
        // replacement refresh token can fail too, and the old one is just as
        // gone. Anything between takeRefresh and a response the client can use
        // must put the token back.
        return await issueTokens(
          config, stored.client_id, stored.resource, current.identity,
          current.source, keys
        );
      } catch (err) {
        console.error("could not complete a refresh:", err);
        await config.store.putRefresh(token, stored).catch(() => {});
        return oauthError("temporarily_unavailable", "could not complete the refresh — retry", 503);
      }
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
    // Writing is for admins the operator made, not admins a purchase made.
    //
    // Buying team makes you admin of your own org. If that also let you write
    // grants, one month of team would buy permanent team: an admin can write a
    // grant for their own key, billing only ever removes grants it wrote
    // itself, and the self-written one would survive the cancellation. Granting
    // a second identity into the org does the same thing one step removed.
    //
    // Closing that properly means org membership with a lifetime tied to the
    // purchase, which is not built — the README already says adding people to
    // a purchased org is not a feature yet. Until it is, a purchased admin gets
    // the plan and the org scoping and reads the grant list, and nothing else.
    const writing = method !== "GET";
    if (writing && who.planSource !== "operator") {
      return oauthError(
        "insufficient_scope",
        "writing grants is limited to admins the operator granted; a purchased team admin cannot",
        403
      );
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
        const parsed: unknown = await request.json();
        // Valid JSON is not necessarily an object. `null` parses fine and then
        // throws on the very next property read, turning malformed client input
        // into a 500 where the documented answer is a 400.
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return oauthError("invalid_request", "body must be a JSON object");
        }
        body = parsed as typeof body;
      } catch {
        return oauthError("invalid_request", "body must be JSON");
      }
      // The body is untrusted JSON. A cast is not validation: an unusable key
      // or a non-numeric expiresAt would otherwise be accepted and stored.
      //
      // The key must also be one that keeps naming the same human. A login or
      // display name can be renamed and reclaimed, so a grant filed against one
      // would hand this org's plan — and with role "admin", this org — to
      // whoever picks that label up next.
      if (typeof body.key !== "string" || !isStableIdentityKey(body.key)) {
        return oauthError(
          "invalid_request",
          "key must be github:<numeric id>, google:<numeric id>, or an email address " +
            "(github:, google: or email:) — a username or display name can be reassigned"
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
      // The org id is a storage key segment. A separator inside it makes the
      // index encoding ambiguous, and an ambiguous key is another org's key —
      // see grant-index.ts. The encoding defends itself too; this is the layer
      // that says so rather than silently mangling the input.
      if (orgId !== null && !isOrgId(orgId)) {
        return oauthError("invalid_request", "orgId must be 1-64 characters of letters, digits, _ or -");
      }
      // An admin administers their own org and no other. Without this, every
      // team admin could grant themselves admin inside anyone else's org —
      // which becomes reachable the moment a purchase creates an org and makes
      // the buyer its admin. Org-less grants come from billing, not from here;
      // the operator's BELLMAN_USERS remains the way to grant outside an org.
      if (orgId !== identity.orgId) {
        return oauthError("insufficient_scope", "grants must target your own org", 403);
      }

      const grant: PlanGrant = {
        key: body.key,
        plan: body.plan,
        role: body.role,
        orgId,
        // Decided here, never by the caller. This is the hand-grant path, so
        // that is what the audit trail must say: letting the body choose would
        // let a manual grant label itself "purchase" and make the provenance
        // in every audit entry worthless. Billing writes through its own path.
        source: "operator",
        grantedAt: Date.now(),
        grantedBy: identity.userId,
        expiresAt: body.expiresAt ?? null,
      };
      // The org check above validates what the caller CLAIMS. This checks what
      // is stored, and does it in the same operation as the write: read-then-
      // write let another org's admin land a grant for the same key in the gap.
      if ((await config.plans.putGrantIfOwned(grant, identity.orgId)) === "conflict") {
        return oauthError("insufficient_scope", "that key already has a grant in another org", 403);
      }
      await recordGrantAudit(config, identity, grant.orgId, "plan_granted", grant.key, {
        plan: grant.plan, role: grant.role, org_id: grant.orgId, source: grant.source,
      });
      return json({ granted: grant }, 201);
    }

    if (method === "DELETE") {
      const key = url.searchParams.get("key") ?? "";
      if (!key) return oauthError("invalid_request", "key is required");
      // Check and delete in one operation, and act on what it actually removed.
      // Read-then-delete could report a revocation that never happened: a
      // sign-in in the gap claims an address grant onto its subject key, the
      // delete finds nothing, and this would still audit plan_revoked and
      // answer 200 while the grant carried on applying.
      const outcome = await config.plans.deleteGrantIfOwned(key, identity.orgId);
      if (outcome !== "deleted") {
        return oauthError("insufficient_scope", "no such grant in your org", 403);
      }
      await recordGrantAudit(config, identity, identity.orgId, "plan_revoked", key, {});
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
  // A token was issued, so this client is no longer a disposable registration.
  // This is the only place that mints one, and reaching it needed a human to
  // complete a GitHub or Google sign-in.
  await config.store.markClientUsed(clientId);
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
