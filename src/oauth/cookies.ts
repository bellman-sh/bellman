/**
 * The control panel's session cookie: its name, its attributes, and how to read
 * one back off a request.
 *
 * A leaf module on purpose. It knows nothing about sessions, storage or routes,
 * so every attribute and every parsing edge is testable without a Request going
 * through handleOAuth.
 */

/**
 * The cookie's name, and why it has two.
 *
 * `__Host-` is a browser-enforced contract, not decoration: a cookie with that
 * prefix is accepted only if it is Secure, has Path=/, and has NO Domain. The
 * third clause is the one that matters here. The panel's cookie is host-only to
 * mcp.bellman.sh by our own choice — but without the prefix, anything running on
 * a sibling subdomain of bellman.sh (the marketing site, say, via XSS) can set
 * `Domain=.bellman.sh` with this same name, and the browser will send both. RFC
 * 6265 does not make the order deterministic, so which one the server reads
 * first becomes attacker-selectable. The prefix means the sibling's write is
 * rejected by the browser and never reaches us.
 *
 * It requires Secure, so it cannot be used over http. `wrangler dev` on
 * localhost therefore gets the unprefixed name — a development-only fallback,
 * and the only place the protection is absent.
 */
export function sessionCookieName(secure: boolean): string {
  return secure ? "__Host-bellman_session" : "bellman_session";
}

/**
 * `Path=/` because /auth/session and /account share no prefix, and #49's /api/*
 * will not either. Required by __Host- in any case.
 */
const BASE_ATTRIBUTES = ["HttpOnly", "SameSite=Lax", "Path=/"];

function attributes(secure: boolean): string[] {
  return secure ? [...BASE_ATTRIBUTES, "Secure"] : [...BASE_ATTRIBUTES];
}

/** No Domain attribute, ever. See sessionCookieName. */
export function serializeSessionCookie(
  id: string,
  secure: boolean,
  maxAgeSeconds: number
): string {
  return [`${sessionCookieName(secure)}=${id}`, ...attributes(secure), `Max-Age=${maxAgeSeconds}`]
    .join("; ");
}

/**
 * The clearing header.
 *
 * Every attribute identical to the one that set it, because a Set-Cookie that
 * differs in Path or Domain does not overwrite — it adds a second cookie, and
 * the session stays live while appearing to have been signed out of.
 */
export function clearedSessionCookie(secure: boolean): string {
  return serializeSessionCookie("", secure, 0);
}

/**
 * The session id from a request's Cookie header, or undefined.
 *
 * Hand-parsed rather than `split(";").find(…)`, because that form gets three
 * things wrong: it matches a name that merely ends with ours, it treats a bare
 * name with no `=` as a match with an undefined value, and it silently picks one
 * of two cookies with the same name.
 *
 * A duplicate name is refused outright rather than resolved. __Host- stops a
 * sibling subdomain from setting this name, so seeing it twice is not an
 * ambiguity to break sensibly — it is a signal that something set it that should
 * not have been able to. Picking either one hands the choice to whoever tossed
 * the second, since cookie order is not specified. Refusing costs one sign-in.
 */
export function readSessionCookie(request: Request, secure: boolean): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  const name = sessionCookieName(secure);

  let found: string | undefined;
  for (const part of header.split(";")) {
    const equals = part.indexOf("=");
    // No '=' at all is not a cookie; "=x" has no name.
    if (equals <= 0) continue;
    if (part.slice(0, equals).trim() !== name) continue;
    // Seen twice. See the note above: refuse, do not choose.
    if (found !== undefined) return undefined;
    found = part.slice(equals + 1).trim();
  }
  return found ? found : undefined;
}
