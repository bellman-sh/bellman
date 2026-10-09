/// <reference types="@cloudflare/workers-types" />
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { resolveIdentity } from "./auth.js";
import { R2BlobStore } from "./blobs-r2.js";
import { presetRoutes } from "./http/presets.js";
import { roomRoutes, type RoomCaller } from "./http/rooms.js";
import { buildServer } from "./server.js";
import type { Identity } from "./types.js";
import { DurableObjectStore, type BellmanEnv } from "./store-do.js";
import { AuthDO, AuthStore } from "./oauth/store.js";
import { caller, handleOAuth, identityFromAccessToken, unauthorizedHeaders, type OAuthConfig } from "./oauth/routes.js";
import { parseOverrides, type ProviderCredentials, type ProviderName } from "./oauth/providers.js";
import { parsePanelOrigins } from "./oauth/browser.js";
import { canonicalResource } from "./oauth/tokens.js";
import { handleStripeWebhook } from "./billing/stripe.js";
import { billingSettings } from "./billing/config.js";
import { UPGRADE_REQUIRED, wantsWebSocket } from "./upgrade.js";

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
  /** The room blob store (#183): one private bucket, keyed by room. */
  BLOBS: R2Bucket;
  /** Signs access tokens. Absent means OAuth sign-in is switched off. */
  BELLMAN_TOKEN_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Optional JSON: upstream identity -> a Bellman identity with a plan/org. */
  BELLMAN_USERS?: string;
  /**
   * Comma-separated origins the control panel is served from, e.g.
   * "https://dash.bellman.sh". Unset means no browser may hold a session —
   * browser authentication is a capability this grants, not a default it
   * restricts, so a deploy that forgets it gets a panel that cannot sign in
   * rather than one that accepts a cookie from anywhere.
   */
  BELLMAN_PANEL_ORIGINS?: string;
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
    panelOrigins: parsePanelOrigins(env.BELLMAN_PANEL_ORIGINS),
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

/**
 * Fail closed with neither a key map nor OAuth: answer 503 and log why, rather
 * than 401 every caller as though their credentials were wrong.
 *
 * The dev table is kept out twice over. resolveIdentity falls back to it
 * (qk_dev_jesse: team plan, admin role) when it is handed no key map, and
 * resolveCaller tests `env.BELLMAN_KEYS` before calling it. With neither a map
 * nor OAuth, either that test or this guard refuses the dev key on its own.
 * With OAuth on and no map this guard passes, and that test is all that stands
 * between the dev key and a public URL. Local runs supply the map through
 * .dev.vars, so dev exercises the same path production does.
 */
function unconfigured(env: WorkerEnv, oauth?: OAuthConfig): Response | undefined {
  if (env.BELLMAN_KEYS || oauth) return undefined;
  console.error("BELLMAN_KEYS is unset — refusing to serve. Set it with: wrangler secret put BELLMAN_KEYS");
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32002, message: "Server is not configured with an identity key map" }, id: null },
    { status: 503 }
  );
}

/**
 * Who is calling, or null. An OAuth access token first, then the static key
 * map. The bearer key path stays for stdio clients and scripts, which the spec
 * says should take credentials from the environment rather than run an OAuth
 * flow.
 *
 * Both routes resolve through here, so what counts as a caller cannot differ
 * between them: a copy hardened on one route and not the other leaves the
 * weaker one as the way in.
 *
 * The `env.BELLMAN_KEYS` test below is not a shortcut. resolveIdentity falls
 * back to the dev table (qk_dev_jesse: team plan, admin role) when it is handed
 * no key map, so it is never called without one. `unconfigured` refuses a
 * deploy with neither a map nor OAuth, but with OAuth on and no map it passes,
 * and this test is all that stands between the dev key and a public URL.
 */
async function resolveCaller(
  request: Request,
  env: WorkerEnv,
  oauth?: OAuthConfig
): Promise<Identity | null> {
  const header = request.headers.get("authorization") ?? undefined;
  const bearer = header?.replace(/^Bearer\s+/i, "").trim() ?? "";
  let identity = oauth && bearer ? await identityFromAccessToken(bearer, oauth) : null;
  if (!identity && env.BELLMAN_KEYS) identity = resolveIdentity(header, env.BELLMAN_KEYS);
  return identity;
}

/**
 * Who is calling a room route, and how (#183). The bearer paths /mcp takes —
 * an access token, then the key map — and then the panel cookie through the
 * authorization server's own `caller`, so a route and a tool cannot disagree
 * about who someone is. A bearer that is present and bad stops here: `caller`
 * sees the header, fails the token, and never falls through to a cookie.
 */
async function roomCaller(request: Request, env: WorkerEnv, oauth?: OAuthConfig): Promise<RoomCaller | null> {
  const identity = await resolveCaller(request, env, oauth);
  if (identity) return { identity, via: "bearer" };
  if (!oauth) return null;
  const who = await caller(request, oauth);
  return who ? { identity: who.identity, via: who.via } : null;
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const store = new DurableObjectStore(env);
    const oauth = oauthConfig(request, env, store);
    const blobs = new R2BlobStore(env.BLOBS);

    // Ahead of the OAuth routes: Stripe signs its own requests and carries no
    // bearer token, so it must not fall through anything expecting one.
    if (url.pathname === "/stripe/webhook") {
      const { webhookSecret, apiKey } = billingSettings(env);
      if (!webhookSecret || !apiKey || !env.AUTH) {
        return new Response("Billing is off", { status: 503 });
      }
      const auth = new AuthStore(env.AUTH);
      return handleStripeWebhook(request, {
        secret: webhookSecret,
        apiKey,
        billing: auth,
        // Grants are written in every mode, including shadow. What `shadow`
        // withholds is honouring them, which happens at resolution time via
        // honourPurchases above — so the store stays a true record of what
        // Stripe has said, and the switch works in both directions: turning
        // billing on activates purchases already seen, and turning it off and
        // on again does not leave a stale grant behind. Withholding the write
        // instead meant a purchase seen during shadow stayed invisible until
        // Stripe happened to send another event about it, which it may never do.
        reconcile: (userId) => auth.reconcile(userId),
      });
    }

    // The room routes (#183, #184), ahead of the OAuth routes: /rooms/ is that
    // module's prefix, and /rooms with no slash is the list. The fail-closed
    // guard /ws has covers them all — a deploy with neither a key map nor OAuth
    // serves no room.
    if (url.pathname === "/rooms" || url.pathname.startsWith("/rooms/")) {
      const blocked = unconfigured(env, oauth);
      if (blocked) return blocked;
      const handled = await roomRoutes(request, {
        store,
        blobs,
        caller: (req) => roomCaller(req, env, oauth),
        panelOrigins: oauth?.panelOrigins ?? [],
      });
      if (handled) return handled;
    }

    // The saved presets (designer spec D5), on the room routes' rules and behind the same guard.
    if (url.pathname === "/presets" || url.pathname.startsWith("/presets/")) {
      const blocked = unconfigured(env, oauth);
      if (blocked) return blocked;
      const handled = await presetRoutes(request, {
        store,
        caller: (req) => roomCaller(req, env, oauth),
        panelOrigins: oauth?.panelOrigins ?? [],
      });
      if (handled) return handled;
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

    /**
     * The watching path. Delivery only — tool calls stay on /mcp, which is
     * what keeps this a side-channel rather than a second MCP transport.
     *
     * Nothing from the caller's request is forwarded to the object. The
     * Worker reads the query, resolves the identity, asks the object which
     * members that identity owns, and then BUILDS the upgrade request. A
     * client setting x-bellman-members itself therefore achieves nothing,
     * because its request is not the one the object ever sees. Presence reads
     * that list (see SocketAttachment in store-do.ts), and this is what keeps
     * it trustworthy: a list a client could write would keep any member it
     * named out of every seat reclaim.
     */
    if (url.pathname === "/ws") {
      // A handshake is a GET (RFC 6455 section 4.1). Given any other method,
      // workerd hands the request to the Worker all the same, the object accepts
      // a socket, and workerd then answers the client 500 because it cannot
      // complete the upgrade. Measured in bare workerd: one accepted socket per
      // request. So this comes first, ahead of authentication, as /mcp's does for
      // anything but a POST. Under wrangler dev the Worker is handed a GET
      // instead, so a POST handshake there cannot show any of this.
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });
      }
      // Case-insensitively, and tolerating a list: `Upgrade: WebSocket` is a valid
      // handshake this refused 426 until #132, and the 426 now names the protocol it
      // wants rather than leaving a client to guess. Both rules are in upgrade.ts.
      if (!wantsWebSocket(request.headers.get("upgrade"))) {
        return new Response(UPGRADE_REQUIRED.body, {
          status: UPGRADE_REQUIRED.status,
          headers: UPGRADE_REQUIRED.headers,
        });
      }
      const blocked = unconfigured(env, oauth);
      if (blocked) return blocked;

      const sessionId = url.searchParams.get("session");
      if (!sessionId) return new Response("Missing session", { status: 400 });

      // Number() alone accepts "", "1.5", "1e99" and " 1". A cursor is an
      // index into storage keys; anything else is a bad request, not a
      // silently clamped one.
      const raw = url.searchParams.get("cursor") ?? "";
      const cursor = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(cursor)) {
        return new Response("cursor must be a non-negative integer", { status: 400 });
      }

      const identity = await resolveCaller(request, env, oauth);
      if (!identity) return unauthorized(oauth);

      const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
      const { memberIds, closed } = await stub.membersOf(identity.userId);
      // An unknown room and a closed one both come back closed from membersOf,
      // so a caller who owns no member here cannot tell them apart: both are
      // 404. An open room it owns nothing in is 403.
      if (memberIds.length === 0) {
        return new Response(closed ? "Not found" : "Forbidden", { status: closed ? 404 : 403 });
      }
      if (closed) return new Response("This room is closed", { status: 409 });

      // This 409 is the early one, not the guarantee. membersOf and the upgrade are
      // two invocations of the object, so a close or the abandonment alarm can land
      // between them; SessionDO.fetch rechecks and answers 409 itself, and that
      // response is returned here unchanged (#133). What this check is for is the
      // 403/404 distinction above, which the object cannot make without naming the
      // room to a stranger, and not upgrading a caller who owns nothing here.
      return stub.fetch(
        new Request(`https://session/ws?cursor=${cursor}`, {
          headers: { upgrade: "websocket", "x-bellman-members": memberIds.join(",") },
        })
      );
    }

    if (url.pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
    }

    const blocked = unconfigured(env, oauth);
    if (blocked) return blocked;

    const identity = await resolveCaller(request, env, oauth);
    if (!identity) return unauthorized(oauth);

    try {
      const server = buildServer(identity, store, blobs);
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
