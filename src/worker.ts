/// <reference types="@cloudflare/workers-types" />
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { resolveIdentity } from "./auth.js";
import { buildServer } from "./server.js";
import { DurableObjectStore, type BellmanEnv } from "./store-do.js";
import { AuthDO, AuthStore } from "./oauth/store.js";
import { handleOAuth, identityFromAccessToken, unauthorizedHeaders, type OAuthConfig } from "./oauth/routes.js";
import { parseOverrides, type ProviderCredentials, type ProviderName } from "./oauth/providers.js";
import { canonicalResource } from "./oauth/tokens.js";
import { handleStripeWebhook } from "./billing/stripe.js";
import { billingSettings } from "./billing/config.js";

/**
 * Cloudflare Workers entry point.
 *
 * The routing mirrors src/app.ts deliberately — same two endpoints, same
 * stateless-per-request transport, same identity binding. What differs is only
 * the runtime seam: Workers speaks Request/Response, so this uses the SDK's
 * WebStandardStreamableHTTPServerTransport directly, where the Node path uses
 * StreamableHTTPServerTransport (itself a thin wrapper around this same class).
 *
 * Durable Object classes must be exported from the entry module for the
 * runtime to bind them.
 */
export { SessionDO, RegistryDO, AuditDO } from "./store-do.js";
export { AuthDO } from "./oauth/store.js";

/** Worker bindings: the session stores, plus the authorization server's. */
export interface WorkerEnv extends BellmanEnv {
  AUTH: DurableObjectNamespace<AuthDO>;
  /** Signs access tokens. Absent means OAuth sign-in is switched off. */
  BELLMAN_TOKEN_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Optional JSON: upstream identity -> a Bellman identity with a plan/org. */
  BELLMAN_USERS?: string;
  /** off | shadow | on. See src/billing/config.ts. Anything else is off. */
  BELLMAN_BILLING?: string;
  /** Signing secret (whsec_…) of the Stripe webhook endpoint. */
  STRIPE_WEBHOOK_SECRET?: string;
  /** Restricted key (rk_…) with read access to subscriptions only. */
  STRIPE_API_KEY?: string;
  /** Optional JSON: link name -> Stripe Payment Link URL, served at /upgrade/<name>. */
  STRIPE_PAYMENT_LINKS?: string;
}

/**
 * OAuth is configured per request because issuer and resource come from the
 * hostname actually being used, so a token minted for mcp.bellman.sh is not
 * accepted on any other hostname this Worker answers.
 */
function oauthConfig(
  request: Request,
  env: WorkerEnv,
  plans: DurableObjectStore
): OAuthConfig | undefined {
  if (!env.BELLMAN_TOKEN_SECRET || !env.AUTH) return undefined;
  const origin = new URL(request.url).origin;
  const credentials: Partial<Record<ProviderName, ProviderCredentials>> = {};
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    credentials.github = { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
  }
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    credentials.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  }
  return {
    issuer: origin,
    resource: canonicalResource(`${origin}/mcp`),
    secret: env.BELLMAN_TOKEN_SECRET,
    store: new AuthStore(env.AUTH),
    credentials,
    overrides: parseOverrides(env.BELLMAN_USERS),
    plans,
    paymentLinks: billingSettings(env).paymentLinks,
    // The switch has to reach plans already stored, or it only stops new
    // purchases and every earlier one keeps issuing paid tokens.
    honourPurchases: billingSettings(env).applyPlans,
  };
}

/**
 * Shadow mode: everything runs, nothing is granted. The ledger still records
 * what Stripe says, so the webhook can be exercised against real purchases
 * before a plan depends on it.
 */

const unauthorized = (oauth?: OAuthConfig) =>
  Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: missing or invalid credentials" },
      id: null,
    },
    // With OAuth on, the 401 has to say where discovery starts, or a client
    // has no way to begin the flow (RFC 9728 section 5.1).
    { status: 401, headers: oauth ? unauthorizedHeaders(oauth) : undefined }
  );

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const store = new DurableObjectStore(env);
    const oauth = oauthConfig(request, env, store);

    // Ahead of the OAuth routes: Stripe signs its own requests and carries no
    // bearer token, so it must not fall through anything expecting one.
    if (url.pathname === "/stripe/webhook") {
      const { webhookSecret, apiKey } = billingSettings(env);
      if (!webhookSecret || !apiKey || !env.AUTH) {
        return new Response("Billing is off", { status: 503 });
      }
      return handleStripeWebhook(request, {
        secret: webhookSecret,
        apiKey,
        billing: new AuthStore(env.AUTH),
        // Grants are written in every mode, including shadow. What `shadow`
        // withholds is honouring them, which happens at resolution time via
        // honourPurchases above — so the store stays a true record of what
        // Stripe has said, and the switch works in both directions: turning
        // billing on activates purchases already seen, and turning it off and
        // on again does not leave a stale grant behind. Withholding the write
        // instead meant a purchase seen during shadow stayed invisible until
        // Stripe happened to send another event about it, which it may never do.
        plans: store,
      });
    }

    if (oauth) {
      const handled = await handleOAuth(request, oauth);
      if (handled) return handled;
    }

    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({
        ok: true,
        service: "bellman",
        runtime: "workers",
        at: new Date().toISOString(),
      });
    }

    if (url.pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
    }

    /**
     * Fail closed with neither a key map nor OAuth. resolveIdentity falls back
     * to the dev table when handed nothing, and nodejs_compat means `process`
     * exists here — so without this guard a deploy that forgot the secret would
     * serve qk_dev_jesse (team plan, admin role) on a public URL. Local runs
     * supply this through .dev.vars, so dev exercises the same path production
     * does.
     */
    if (!env.BELLMAN_KEYS && !oauth) {
      console.error("BELLMAN_KEYS is unset — refusing to serve. Set it with: wrangler secret put BELLMAN_KEYS");
      return Response.json(
        {
          jsonrpc: "2.0",
          error: { code: -32002, message: "Server is not configured with an identity key map" },
          id: null,
        },
        { status: 503 }
      );
    }

    // An OAuth access token first, then the static key map. The bearer key path
    // stays for stdio clients and scripts, which the spec says should take
    // credentials from the environment rather than run an OAuth flow.
    const header = request.headers.get("authorization") ?? undefined;
    const bearer = header?.replace(/^Bearer\s+/i, "").trim() ?? "";
    let identity = oauth && bearer ? await identityFromAccessToken(bearer, oauth) : null;
    if (!identity && env.BELLMAN_KEYS) identity = resolveIdentity(header, env.BELLMAN_KEYS);
    if (!identity) return unauthorized(oauth);

    try {
      const server = buildServer(identity, store);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      return await transport.handleRequest(request);
    } catch (err) {
      console.error("MCP request failed:", err);
      return Response.json(
        { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null },
        { status: 500 }
      );
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
