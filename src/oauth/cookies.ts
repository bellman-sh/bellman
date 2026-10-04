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
 * Trims space and tab, all the whitespace that HTTP's optional whitespace (OWS)
 * and RFC 6265's WSP allow, rather than String.prototype.trim, which also
 * strips non-breaking and Unicode spaces and the byte-order mark.
 *
 * The difference is a way round `__Host-`. A browser applies that prefix only
 * to a name that starts with it, so `\u2000__Host-bellman_session` is outside
 * its rules, and a sibling subdomain can set it with Domain=.bellman.sh. The
 * Workers runtime decodes header bytes as UTF-8, so the space reaches
 * readSessionCookie as one character, and trim() would hand the name back as
 * exactly ours: the cookie the prefix exists to keep out, selected by whoever
 * set it.
 *
 * Measured in October 2026. Chrome for Testing 153.0.8010.12 stores a name
 * padded with U+2000, U+00A0, U+FEFF, U+3000, U+2028 or U+1680 together with a
 * Domain and sends it, whether it was set through document.cookie or
 * Set-Cookie. Through workerd under wrangler dev, the reader that used trim()
 * returned the attacker's id for such a cookie: session fixation when the
 * victim had no session, and a duplicate, so a lockout, when they had one. This
 * reader returns null in the first case and the real session in the second.
 * Chrome refuses a name padded with space, tab, VT or FF, and refuses a
 * nameless cookie, so the Unicode spaces are the route.
 *
 * Not tried: Firefox, Safari, other versions of Chrome, and Cloudflare's edge,
 * which may differ in whether it passes UTF-8 header bytes through. The
 * trimming does not wait on them: a name that is not ours once space and tab
 * are set aside is not ours.
 *
 * A loop and not a regular expression, because `/^[ \t]+|[ \t]+$/g` rescans a
 * run of spaces from every start position and is quadratic in its length:
 * 32,000 spaces cost workerd about 212 ms and 64,000 about 845 ms, from one
 * unauthenticated request. A test holds the bound.
 */
function trimOws(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && (text[start] === " " || text[start] === "\t")) start++;
  while (end > start && (text[end - 1] === " " || text[end - 1] === "\t")) end--;
  return text.slice(start, end);
}

/**
 * The session id from a request's Cookie header, or undefined.
 *
 * Hand-parsed rather than `split(";").find(…)`, because that form gets three
 * things wrong: it matches a name that merely begins or ends with ours, it takes
 * a bare name with no `=` for a match with an undefined value, which then hides
 * a real cookie after it, and it silently picks one of two cookies with the same
 * name.
 *
 * A duplicate name is refused outright rather than resolved. __Host- stops a
 * sibling subdomain from setting this name, so seeing it twice is not an
 * ambiguity to break sensibly — it is a signal that something set it that should
 * not have been able to. Picking either one hands the choice to whoever tossed
 * the second, since cookie order is not specified.
 *
 * Refusing is not free. A duplicate that differs in Domain or Path survives
 * sign-out and sign-in, because the Set-Cookie for ours cannot overwrite it, so
 * the user stays refused until it expires or they clear it. That is accepted
 * because the alternative lets whoever set the duplicate pick the session.
 *
 * Where the browser enforces __Host-, nothing can plant such a duplicate under
 * the secure name, and trimOws closes the padded-name route, so the refusal is
 * a backstop there. Over http the name is unprefixed and the lockout is real,
 * in development only.
 */
export function readSessionCookie(request: Request, secure: boolean): string | undefined {
  return readCookie(request, sessionCookieName(secure));
}

/**
 * The sign-in nonce cookie's name. Prefixed for the same reason the session
 * cookie is: without it a sibling subdomain can plant this name with a Domain,
 * and a planted nonce defeats the check it exists for.
 */
export function signinNonceCookieName(secure: boolean): string {
  return secure ? "__Host-bellman_signin" : "bellman_signin";
}

/**
 * Binds a panel sign-in to the browser that started it.
 *
 * Short-lived: it is wanted only for the provider round trip, so it expires with
 * the signed state rather than outliving it. Otherwise identical to the session
 * cookie's attributes, including the prefix — see signinNonceCookieName.
 */
export function serializeSigninNonce(nonce: string, secure: boolean, maxAgeSeconds: number): string {
  return [`${signinNonceCookieName(secure)}=${nonce}`, ...attributes(secure), `Max-Age=${maxAgeSeconds}`]
    .join("; ");
}

/** Cleared the moment the sign-in completes or fails; it has no later use. */
export function clearedSigninNonce(secure: boolean): string {
  return serializeSigninNonce("", secure, 0);
}

export function readSigninNonce(request: Request, secure: boolean): string | undefined {
  return readCookie(request, signinNonceCookieName(secure));
}

/**
 * One parser for every cookie this server reads.
 *
 * Shared rather than copied because the two things that make it correct are not
 * obvious and would not survive being written twice: OWS-exact trimming, which
 * is what stops a padded name passing for a prefixed one, and refusing a
 * duplicate rather than choosing between them. A second cookie with its own
 * parser would have neither.
 */
function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  // This mode's name and no other. In secure mode the unprefixed name is ignored,
  // because a sibling subdomain can set it with a Domain and a browser will send it.

  let found: string | undefined;
  for (const part of header.split(";")) {
    const equals = part.indexOf("=");
    // No '=' at all is not a cookie; "=x" has no name.
    if (equals <= 0) continue;
    if (trimOws(part.slice(0, equals)) !== name) continue;
    // Seen twice. See the note above: refuse, do not choose.
    if (found !== undefined) return undefined;
    found = trimOws(part.slice(equals + 1));
  }
  return found ? found : undefined;
}
