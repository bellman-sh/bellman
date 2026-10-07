/**
 * What makes it safe for a browser to hold a Bellman session.
 *
 * Two jobs, both keyed on one allowlist: which origins may be granted CORS, and
 * which origins may perform a cookie-authenticated mutation. A second leaf
 * module beside cookies.ts, so neither needs the other and both are unit
 * testable.
 *
 * The config parser lives here rather than in src/worker.ts, because that file
 * imports cloudflare:workers and so cannot be reached from a vitest test.
 */

/** A preflight result is cacheable for a day; the allowlist changes by deploy. */
const PREFLIGHT_MAX_AGE_SECONDS = 86_400;

/** The methods the panel uses. Explicit rather than echoing the request. */
const ALLOWED_METHODS = "GET, POST, PUT, DELETE, OPTIONS";

/**
 * The request headers the panel sends that a browser does not send unasked. The
 * page sends `If-None-Match` on its surface poll, which is not a CORS-safelisted
 * request header, so the browser asks first and must be told yes.
 */
const ALLOWED_HEADERS = "content-type, if-none-match";

/**
 * The request's Origin, if the allowlist admits it. Undefined otherwise, which
 * is also the answer when no Origin was sent.
 *
 * Exact string equality against the configured list. Not a prefix test: a
 * startsWith against "https://dash.bellman.sh" admits
 * "https://dash.bellman.sh.attacker.example". Not a hostname test either, or
 * http would pass where only https is configured.
 *
 * An absent or empty allowlist admits nothing. A deploy that forgot
 * BELLMAN_PANEL_ORIGINS gets no browser authentication at all, which is a
 * visibly broken panel; the alternative reading — no list means no restriction —
 * is a silently open one.
 *
 * The literal string "null" is refused unconditionally, including if it somehow
 * appears in the allowlist. Browsers send it as the Origin from sandboxed
 * iframes, from some redirect chains, and from `file:` documents. It is not an
 * origin, it is the absence of one, and it is shared by every caller that has
 * none.
 */
export function allowedOrigin(
  request: Request,
  panelOrigins: readonly string[] | undefined
): string | undefined {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return undefined;
  if (!panelOrigins || panelOrigins.length === 0) return undefined;
  return panelOrigins.includes(origin) ? origin : undefined;
}

/**
 * CORS headers for a response, given the already-validated origin.
 *
 * `origin` is the output of allowedOrigin, never a raw header — echoing an
 * unvalidated Origin is the CORS hole that looks like an allowlist.
 *
 * Vary: Origin goes on every response, including those with no grant. Without
 * it a cache can hand one origin's Access-Control-Allow-Origin to another, in
 * either direction: a cached grant served to a stranger, or a cached refusal
 * served to the panel.
 *
 * No wildcard anywhere. A wildcard with credentials is rejected by browsers, so
 * it would not even work.
 */
export function corsHeaders(origin: string | undefined): Record<string, string> {
  if (!origin) return { vary: "Origin" };
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    vary: "Origin",
  };
}

/**
 * The answer to a preflight. 204 either way — a stranger's preflight simply
 * carries no grant, and the browser blocks the real request itself. Answering
 * 403 would tell a caller whether it is on the list.
 */
export function preflightResponse(origin: string | undefined): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(origin),
      ...(origin
        ? {
            "access-control-allow-methods": ALLOWED_METHODS,
            "access-control-allow-headers": ALLOWED_HEADERS,
            "access-control-max-age": String(PREFLIGHT_MAX_AGE_SECONDS),
          }
        : {}),
    },
  });
}

/** Methods that change nothing, so they need no CSRF defence. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * A 403 when a cookie-authenticated mutation cannot prove where it came from,
 * or undefined to let the request proceed.
 *
 * The whole CSRF story, and it is a header check rather than a token because
 * the header already answers the question. Browsers send Origin on every
 * cross-origin request and on every POST, so a cookie-authenticated mutation
 * without one is not a browser we have any reason to serve.
 *
 * SameSite=Lax is not sufficient on its own, which is why this exists: SameSite
 * is evaluated on the registrable domain, so bellman.sh is same-site with
 * mcp.bellman.sh. An XSS on the marketing site could otherwise POST here with
 * the session cookie attached, and Lax would allow it.
 *
 * Bearer callers are exempt entirely. curl sends no Origin and needs none, and
 * a browser cannot attach a bearer token cross-site without JavaScript that
 * already holds the token — at which point CSRF is not the problem.
 *
 * `origin` is the output of allowedOrigin, so an off-list Origin arrives here as
 * undefined and is refused by the same branch as a missing one. A caller that
 * passed the raw header instead would accept every origin that sent one, which
 * is why this takes the validated value rather than the request alone.
 */
export function csrfRefusal(
  request: Request,
  via: "bearer" | "cookie",
  origin: string | undefined
): Response | undefined {
  if (via === "bearer") return undefined;
  if (SAFE_METHODS.has(request.method)) return undefined;
  if (origin) return undefined;
  return Response.json(
    {
      error: "invalid_request",
      error_description:
        "a cookie-authenticated write must carry an Origin header from the control panel",
    },
    { status: 403, headers: { "cache-control": "no-store" } }
  );
}

/**
 * The panel origins from BELLMAN_PANEL_ORIGINS — comma-separated, trimmed, and
 * reduced to bare origins.
 *
 * Normalised rather than taken literally, because allowedOrigin compares against
 * the Origin header by exact string equality and that header never carries a path
 * or a trailing slash. An entry of "https://dash.bellman.sh/" would therefore
 * match nothing, and the symptom is a panel that cannot sign in with no error
 * anywhere saying why.
 *
 * Entries that are not absolute http(s) URLs are dropped with a log line. A typo
 * should cost one origin, not the whole allowlist — and an unparseable entry left
 * in place would throw from inside allowedOrigin on every request.
 *
 * `trim()` is right here where it is wrong in cookies.ts, and the difference is
 * worth stating because the two sit one import apart. This reads a deploy-time
 * configuration string an operator wrote; trimOws reads a header an attacker
 * controls, where accepting a Unicode space let a padded cookie name pass for the
 * protected one. Being generous about whitespace costs nothing when the writer is
 * trusted, and refusing a space somebody pasted in would only be unhelpful.
 */
export function parsePanelOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  const origins: string[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      console.error(`BELLMAN_PANEL_ORIGINS: ignoring "${trimmed}" — not an absolute URL`);
      continue;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      console.error(`BELLMAN_PANEL_ORIGINS: ignoring "${trimmed}" — only http and https`);
      continue;
    }
    if (!origins.includes(parsed.origin)) origins.push(parsed.origin);
  }
  return origins;
}
