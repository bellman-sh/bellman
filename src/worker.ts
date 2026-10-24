/// <reference types="@cloudflare/workers-types" />
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { resolveIdentity } from "./auth.js";
import { R2BlobStore } from "./blobs-r2.js";
import { auditRoutes } from "./http/audit.js";
import { orgRoutes } from "./http/orgs.js";
import { scimRoutes } from "./http/scim.js";
import { handleRoutes } from "./http/handles.js";
import { moderationRoutes, routeOrigin } from "./http/moderation.js";
import { presetRoutes } from "./http/presets.js";
import { publicRoutes } from "./http/public.js";
import { problem, roomRoutes, type RoomCaller } from "./http/rooms.js";
import { statsRoutes } from "./http/stats.js";
import { reportMailer } from "./reports.js";
import { inviteMailer } from "./invite-mail.js";
import { buildServer } from "./server.js";
import { SUSPENDED, SuspensionCache } from "./suspension.js";
import type { Identity } from "./types.js";
import { DurableObjectStore, type BellmanEnv } from "./store-do.js";
import { AuthDO, AuthStore } from "./oauth/store.js";
import { caller, handleOAuth, identityFromAccessToken, parseOperators, unauthorizedHeaders, type OAuthConfig } from "./oauth/routes.js";
import { parseOverrides, type ProviderCredentials, type ProviderName } from "./oauth/providers.js";
import { parsePanelOrigins } from "./oauth/browser.js";
import { canonicalResource } from "./oauth/tokens.js";
import { handleStripeWebhook } from "./billing/stripe.js";
import { billingSettings } from "./billing/config.js";
import { hostedSeatFor } from "./host.js";
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
export { HostDO } from "./host-do.js";

/** Worker bindings: the session stores, plus the authorization server's. */
export interface WorkerEnv extends BellmanEnv {
  AUTH: DurableObjectNamespace<AuthDO>;
  /** The room blob store (#183): one private bucket, keyed by room. */
  BLOBS: R2Bucket;
  /**
   * The `send_email` binding (wrangler.toml `[[send_email]]`) a report's email goes through. Absent, in a deploy whose
   * Email Routing is not set up, a report is stored and the log says no email went.
   */
  SEND_EMAIL?: SendEmail;
  /** Signs access tokens. Absent means OAuth sign-in is switched off. */
  BELLMAN_TOKEN_SECRET?: string;
  /**
   * A secret: what seals an org's IdP client secret at rest (SSO spec, D14). Unset, the token secret
   * seals it, and rotating that then means every org re-enters its secret; this keeps the two apart.
   */
  BELLMAN_SEAL_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Optional JSON: upstream identity -> a Bellman identity with a plan/org. */
  BELLMAN_USERS?: string;
  /**
   * A secret: the user ids, comma-separated, that hold the operator's
   * platform-wide powers (`parseOperators`). Unset, nobody holds them; no plan
   * BELLMAN_USERS grants stands in.
   */
  BELLMAN_OPERATORS?: string;
  /**
   * Comma-separated origins the control panel is served from, e.g.
   * "https://dash.bellman.sh". Unset means no browser may hold a session —
   * browser authentication is a capability this grants, not a default it
   * restricts, so a deploy that forgets it gets a panel that cannot sign in
   * rather than one that accepts a cookie from anywhere.
   */
  BELLMAN_PANEL_ORIGINS?: string;
  /**
   * Comma-separated origins public room pages are served from, e.g.
   * "https://bellman.sh" (the dash's Worker answers `/r/*` there). Parsed as
   * BELLMAN_PANEL_ORIGINS is. Honoured by `POST /rooms/:id/reports` (its CORS,
   * its preflight, its CSRF check and the suspension gate's refusal of it) and by
   * the sign-in return, and by nothing else: every other signed-in route answers
   * the panel's origins alone. Unset grants nothing.
   */
  BELLMAN_PUBLIC_PAGE_ORIGINS?: string;
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
    sealSecret: env.BELLMAN_SEAL_SECRET,
    store: new AuthStore(env.AUTH),
    credentials,
    overrides: parseOverrides(env.BELLMAN_USERS),
    panelOrigins: parsePanelOrigins(env.BELLMAN_PANEL_ORIGINS),
    publicPageOrigins: parsePanelOrigins(env.BELLMAN_PUBLIC_PAGE_ORIGINS, "BELLMAN_PUBLIC_PAGE_ORIGINS"),
    plans,
    operators: parseOperators(env.BELLMAN_OPERATORS),
    paymentLinks: billingSettings(env).paymentLinks,
    // The switch has to reach plans already stored, or it only stops new
    // purchases and every earlier one keeps issuing paid tokens.
    honourPurchases: billingSettings(env).applyPlans,
  };
}

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

/**
 * Which accounts are suspended (abuse protections spec, section 1), as this isolate last read the
 * registry: an answer is kept a minute (spec D4), so a suspension or a lift reaches every path within one.
 */
const suspensions = new SuspensionCache();

/** The first call's promise, kept: whatever asks again shares the one answer. */
function once<T>(f: () => Promise<T>): () => Promise<T> {
  let kept: Promise<T> | undefined;
  return () => (kept ??= f());
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const store = new DurableObjectStore(env);
    const oauth = oauthConfig(request, env, store);
    const blobs = new R2BlobStore(env.BLOBS);
    // What mails a filed report, for the `bellman_report` tool and the report route alike.
    const mailReport = reportMailer(env.SEND_EMAIL);
    // What mails an org's invite (ADR 0036, D1), through the same binding.
    const mailInvite = inviteMailer(env.SEND_EMAIL);
    const suspended = (userId: string) => suspensions.check(userId, () => store.isSuspended(userId));

    // A route module's caller, resolved once per request however often it is asked, so a cookie caller's
    // session is touched once. `routeGate` asks first, and refuses a suspended account before a module reads
    // or writes anything as it (plan ruling R8). /public takes no credential, so it has no gate. A throw in
    // the gate is answered as one inside a module is: the modules' JSON, with CORS, so the panel can read it. The CORS
    // is the routes' own rule (`routeOrigin`): a suspended reader's report from a public room page is refused with that
    // page's grant, so the page can read why.
    const who = once(() => roomCaller(request, env, oauth));
    const routeGate = async (): Promise<Response | undefined> => {
      const origin = routeOrigin(request, oauth?.panelOrigins ?? [], oauth?.publicPageOrigins ?? []);
      try {
        const them = await who();
        return them && (await suspended(them.identity.userId)) ? problem(403, "suspended", SUSPENDED, origin) : undefined;
      } catch (err) {
        console.error(`${request.method} ${url.pathname} failed:`, err);
        return problem(500, "internal", "the request failed on the server; repeating it is safe", origin);
      }
    };

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
    // serves no room. The moderation routes are asked first: they answer the paths
    // under /rooms/:id/bans and /rooms/:id/reports, and leave every other path to
    // the room routes. Both report routes are behind the suspension gate here. They
    // alone take the public room pages' origins, for the report write, and the gate
    // refuses that write with the same grant.
    if (url.pathname === "/rooms" || url.pathname.startsWith("/rooms/")) {
      const blocked = unconfigured(env, oauth) ?? (await routeGate());
      if (blocked) return blocked;
      const deps = {
        store,
        blobs,
        caller: who,
        panelOrigins: oauth?.panelOrigins ?? [],
      };
      const handled = (await moderationRoutes(request, { ...deps, publicPageOrigins: oauth?.publicPageOrigins ?? [], mailReport }))
        ?? (await roomRoutes(request, deps));
      if (handled) return handled;
    }

    // The public reads (public rooms spec D3): no credential, so no caller is composed. Behind the
    // fail-closed guard the room routes share (plan ruling R7): a deploy that serves no room serves
    // none in public either.
    if (url.pathname === "/public" || url.pathname.startsWith("/public/")) {
      const blocked = unconfigured(env, oauth);
      if (blocked) return blocked;
      const handled = await publicRoutes(request, { store, blobs });
      if (handled) return handled;
    }

    // The saved presets (designer spec D5), on the room routes' rules and behind the same guard.
    if (url.pathname === "/presets" || url.pathname.startsWith("/presets/")) {
      const blocked = unconfigured(env, oauth) ?? (await routeGate());
      if (blocked) return blocked;
      const handled = await presetRoutes(request, {
        store,
        caller: who,
        panelOrigins: oauth?.panelOrigins ?? [],
      });
      if (handled) return handled;
    }

    // An org's identity provider provisions and deprovisions its members (SCIM spec, D9): behind the fail-closed
    // guard, and not behind `routeGate`, since there is no caller and no cookie; the org's token is the only identity.
    if (url.pathname === "/scim/v2" || url.pathname.startsWith("/scim/v2/")) {
      const blocked = unconfigured(env, oauth);
      if (blocked) return blocked;
      const handled = await scimRoutes(request, { store });
      if (handled) return handled;
    }

    // The org's audit stream (audit trail spec, D7 and D8), on the room routes' rules and behind the same guard.
    if (url.pathname === "/audit" || url.pathname.startsWith("/audit/")) {
      const blocked = unconfigured(env, oauth) ?? (await routeGate());
      if (blocked) return blocked;
      const handled = await auditRoutes(request, {
        store,
        caller: who,
        panelOrigins: oauth?.panelOrigins ?? [],
      });
      if (handled) return handled;
    }

    // The org's record and its roster (orgs spec, D6), on the room routes' rules and behind the same guard:
    // what its members read and its admins seat people through, the panel's cookie included.
    if (url.pathname === "/org" || url.pathname.startsWith("/org/")) {
      const blocked = unconfigured(env, oauth) ?? (await routeGate());
      if (blocked) return blocked;
      const handled = await orgRoutes(request, {
        store,
        caller: who,
        panelOrigins: oauth?.panelOrigins ?? [],
        sealSecret: env.BELLMAN_SEAL_SECRET ?? env.BELLMAN_TOKEN_SECRET,
        issuer: url.origin,
        linkSecret: env.BELLMAN_TOKEN_SECRET,
        mail: mailInvite,
      });
      if (handled) return handled;
    }

    // A person's public handle (bylines spec D6), ahead of the OAuth routes, which serve /account and
    // have no store (plan ruling R1). The room routes' rules and the same guard.
    if (url.pathname === "/account/handle" || url.pathname === "/account/handle/") {
      const blocked = unconfigured(env, oauth) ?? (await routeGate());
      if (blocked) return blocked;
      const handled = await handleRoutes(request, {
        store,
        caller: who,
        panelOrigins: oauth?.panelOrigins ?? [],
      });
      if (handled) return handled;
    }

    // A creator's bans across their rooms (abuse protections spec, section 1): beside the handle, for the
    // same reason, and behind the same guard.
    if (url.pathname === "/account/bans" || url.pathname.startsWith("/account/bans/")) {
      const blocked = unconfigured(env, oauth) ?? (await routeGate());
      if (blocked) return blocked;
      const handled = await moderationRoutes(request, {
        store,
        caller: who,
        panelOrigins: oauth?.panelOrigins ?? [],
        publicPageOrigins: oauth?.publicPageOrigins ?? [],
      });
      if (handled) return handled;
    }

    // The operator's platform stats (operator stats spec D1), on the room routes' rules and behind the
    // same guard. Gated on the operators set, which is why it takes `operators` where the others take only
    // `panelOrigins`. `paid` follows sign-in on two points that come from config, so it also takes
    // `overrides` (BELLMAN_USERS outranks a grant) and `honourPurchases` (a purchase grant counts only
    // with applyPlans), off the same OAuth config. The route requires all three keys; it cannot check the
    // values, so worker-tests/stats-routes.test.ts reads the count through each.
    if (url.pathname === "/operator/stats" || url.pathname === "/operator/stats/") {
      const blocked = unconfigured(env, oauth) ?? (await routeGate());
      if (blocked) return blocked;
      const handled = await statsRoutes(request, {
        store,
        caller: who,
        panelOrigins: oauth?.panelOrigins ?? [],
        operators: oauth?.operators,
        overrides: oauth?.overrides,
        honourPurchases: oauth?.honourPurchases,
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
      // A socket already open stays open (plan ruling R8); this refuses the next one. A registry that
      // cannot say is a 500 rather than workerd's error page, and opens no socket either.
      let refused: boolean;
      try {
        refused = await suspended(identity.userId);
      } catch (err) {
        console.error("/ws suspension read failed:", err);
        return new Response("Internal server error", { status: 500 });
      }
      if (refused) return new Response(SUSPENDED, { status: 403 });

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
      // Inside the try: a registry that cannot say is JSON-RPC's internal error below, which an MCP
      // client can parse, and serves nobody.
      if (await suspended(identity.userId)) {
        return Response.json({ jsonrpc: "2.0", error: { code: -32003, message: SUSPENDED }, id: null }, { status: 403 });
      }
      const server = buildServer(identity, store, blobs, {
        hostedSeat: hostedSeatFor(identity.userId, env.BELLMAN_HOSTED_SEAT, env.BELLMAN_HOSTED_SEAT_USERS),
        mailReport,
        upgrade: oauth?.paymentLinks ? { origin: oauth.issuer, paymentLinks: oauth.paymentLinks } : undefined,
      });
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
