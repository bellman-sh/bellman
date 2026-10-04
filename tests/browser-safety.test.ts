import { describe, expect, it } from "vitest";
import {
  clearedSessionCookie, readSessionCookie, serializeSessionCookie, sessionCookieName,
} from "../src/oauth/cookies.js";

const HOST = "__Host-bellman_session";
const cookied = (header: string) =>
  new Request("https://mcp.example.test/auth/session", { headers: { cookie: header } });

describe("the session cookie", () => {
  it("uses the __Host- prefix when secure", () => {
    expect(sessionCookieName(true)).toBe(HOST);
  });

  it("drops the prefix when not secure, because __Host- requires Secure", () => {
    expect(sessionCookieName(false)).toBe("bellman_session");
  });

  it("serializes with every attribute the design requires", () => {
    const header = serializeSessionCookie("abc123", true, 604_800);

    expect(header).toContain(`${HOST}=abc123`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
    expect(header).toContain("Max-Age=604800");
  });

  it("never sets Domain — the cookie is host-only", () => {
    expect(serializeSessionCookie("abc123", true, 604_800)).not.toContain("Domain");
  });

  it("omits Secure over http so wrangler dev works", () => {
    const header = serializeSessionCookie("abc123", false, 604_800);

    expect(header).toContain("bellman_session=abc123");
    expect(header).not.toContain("Secure");
  });

  it("clears with Max-Age=0 and otherwise identical attributes", () => {
    const cleared = clearedSessionCookie(true);

    expect(cleared).toContain(`${HOST}=`);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("Path=/");
    expect(cleared).toContain("SameSite=Lax");
    expect(cleared).toContain("HttpOnly");
  });

  // The checks above are substring checks, and "Path=/" is a substring of
  // "Path=/auth". __Host- accepts only Path=/ itself, so this splits the header
  // on its separator and compares each attribute as a whole.
  it("carries each attribute exactly, not merely as a substring", () => {
    const [pair, ...attrs] = serializeSessionCookie("abc123", true, 604_800).split("; ");

    expect(pair).toBe(`${HOST}=abc123`);
    expect([...attrs].sort()).toEqual(
      ["HttpOnly", "Max-Age=604800", "Path=/", "SameSite=Lax", "Secure"]
    );
  });

  // A Set-Cookie that differs from the one it clears in Path, Domain or Secure is
  // kept beside it, or for a __Host- name refused outright, and either way the
  // session outlives the sign-out. So the clearing header is held against the
  // setting one, in both modes, rather than against a second list of attributes.
  it.each([true, false])("clears with the attributes that set it (secure: %s)", (secure) => {
    const [, ...setAttrs] = serializeSessionCookie("abc123", secure, 604_800).split("; ");
    const [clearPair, ...clearAttrs] = clearedSessionCookie(secure).split("; ");
    const apartFromAge = (attrs: string[]) =>
      attrs.filter((a) => !a.startsWith("Max-Age=")).sort();

    expect(clearPair).toBe(`${sessionCookieName(secure)}=`);
    expect(clearAttrs).toContain("Max-Age=0");
    expect(apartFromAge(clearAttrs)).toEqual(apartFromAge(setAttrs));
  });

  // The attribute list starts from one shared array. A call that appended to it
  // instead of copying would put Secure on every header after the first secure
  // one, and "omits Secure over http" would catch that only by running later
  // than a secure test.
  it("does not let one call's attributes leak into the next", () => {
    const secure = serializeSessionCookie("abc123", true, 604_800);
    serializeSessionCookie("abc123", true, 604_800);

    expect(serializeSessionCookie("abc123", false, 604_800)).not.toContain("Secure");
    expect(serializeSessionCookie("abc123", true, 604_800)).toBe(secure);
  });
});

describe("reading the session cookie", () => {
  it("finds it as the only cookie", () => {
    expect(readSessionCookie(cookied(`${HOST}=abc123`), true)).toBe("abc123");
  });

  it("finds it among others, whitespace and all", () => {
    const req = cookied(`_ga=GA1.2.3;  ${HOST}=abc123 ; theme=dark`);
    expect(readSessionCookie(req, true)).toBe("abc123");
  });

  it("returns undefined with no cookie header at all", () => {
    const req = new Request("https://mcp.example.test/auth/session");
    expect(readSessionCookie(req, true)).toBeUndefined();
  });

  it("returns undefined when the name is absent", () => {
    expect(readSessionCookie(cookied("theme=dark"), true)).toBeUndefined();
  });

  // Review Focus 1 — malformed and duplicated headers.
  it("survives a bare name with no equals sign", () => {
    expect(readSessionCookie(cookied(HOST), true)).toBeUndefined();
  });

  it("survives an empty value", () => {
    expect(readSessionCookie(cookied(`${HOST}=`), true)).toBeUndefined();
  });

  // Documents shape rather than guards behaviour: a segment with no "=" is skipped
  // before its name is looked at, so no edit to how names are compared can change
  // this result.
  it("survives a header that is only separators", () => {
    expect(readSessionCookie(cookied(";;  ;"), true)).toBeUndefined();
  });

  it("does not match a name that merely ends with the cookie name", () => {
    expect(readSessionCookie(cookied(`evil-${HOST}=tossed`), true)).toBeUndefined();
  });

  /**
   * Cookie tossing. __Host- stops a sibling subdomain setting this name at all,
   * so a duplicate means something is wrong rather than something is ambiguous.
   * Refusing both is the only answer that is not attacker-selectable: RFC 6265
   * does not make the order deterministic, so "first wins" lets the attacker
   * choose by setting a Path.
   */
  it("refuses outright when the name appears twice", () => {
    expect(readSessionCookie(cookied(`${HOST}=mine; ${HOST}=tossed`), true)).toBeUndefined();
  });

  it("reads the unprefixed name in insecure mode and ignores the prefixed one", () => {
    const req = cookied(`${HOST}=prod; bellman_session=dev`);
    expect(readSessionCookie(req, false)).toBe("dev");
  });

  // The decoy sits beside the real cookie and the real value is asserted, so a
  // reader that takes the decoy, or gives up on seeing it, fails. The "ends
  // with" test has the decoy alone, and a reader that returned undefined for
  // everything would pass that one.
  it("reads the real cookie past one whose name merely begins with ours", () => {
    const req = cookied(`${HOST}2=tossed; ${HOST}=abc123`);
    expect(readSessionCookie(req, true)).toBe("abc123");
  });

  // A bare name is not a cookie. `find` returns it as the match and stops, so the
  // cookie after it is never read, and a parser that counts it as a match sees
  // the name twice and refuses.
  it("does not let a bare name hide or double the real cookie", () => {
    expect(readSessionCookie(cookied(`${HOST}; ${HOST}=abc123`), true)).toBe("abc123");
  });

  // Without the check for a missing "=", indexOf's -1 makes slice(0, -1) drop the
  // last character, and a bare "__Host-bellman_sessionx" reads as the cookie
  // __Host-bellman_session whose value is the whole segment. The lone bare name
  // above never gets that far, because dropping its last character leaves a name
  // that does not match, so it passes with or without the check.
  it("does not read a bare segment as the cookie when it is the name plus one character", () => {
    expect(readSessionCookie(cookied(`${HOST}x`), true)).toBeUndefined();
  });

  // See trimOws. U+00A0 is the only space beyond ASCII that fits in a header value
  // `new Request` accepts; "trims nothing but space and tab", below, covers the rest
  // through a bare stand-in. With no real cookie the padded name would be read as
  // ours, and with one it would double it and the pair would be refused.
  it("does not take a name padded with a Unicode space for ours", () => {
    const padded = `\u00a0${HOST}=tossed`;

    expect(readSessionCookie(cookied(padded), true)).toBeUndefined();
    expect(readSessionCookie(cookied(`${padded}; ${HOST}=abc123`), true)).toBe("abc123");
  });
});

// `new Request` rejects header values above U+00FF, so the characters that need
// more, such as U+2000 and U+FEFF, which workerd delivers as single code points,
// go through a bare stand-in: readSessionCookie only calls headers.get("cookie").
const bareRequest = (header: string) =>
  ({ headers: new Map([["cookie", header]]) }) as unknown as Request;

// Every character String.prototype.trim strips beyond space and tab, found by
// asking it, so the list cannot fall behind the engine.
const BEYOND_OWS = Array.from({ length: 0x10000 }, (_, code) => String.fromCharCode(code))
  .filter((ch) => ch.trim() === "" && ch !== " " && ch !== "\t")
  .map((ch) => [ch.charCodeAt(0).toString(16).padStart(4, "0"), ch]);

describe("the serializer over http", () => {
  it("carries each attribute exactly over http too", () => {
    const [pair, ...attrs] = serializeSessionCookie("abc123", false, 604_800).split("; ");

    expect(pair).toBe("bellman_session=abc123");
    expect([...attrs].sort()).toEqual(["HttpOnly", "Max-Age=604800", "Path=/", "SameSite=Lax"]);
  });

  // Browsers take the last Max-Age they are sent, so a clearing header ending
  // "Max-Age=0; Max-Age=604800" clears nothing. The test that holds the clearing
  // header against the setting one drops every Max-Age before it compares, so it
  // cannot see a second.
  it.each([true, false])("clears with exactly one Max-Age, and it is 0 (secure: %s)", (secure) => {
    const maxAges = clearedSessionCookie(secure)
      .split("; ")
      .filter((a) => a.startsWith("Max-Age="));

    expect(maxAges).toEqual(["Max-Age=0"]);
  });
});

describe("reading, further", () => {
  // Chrome stores this from a sibling subdomain with Domain=.bellman.sh and sends
  // it to the victim, so in production the name check is all that stands between it
  // and a session. The opposite direction, the prefixed name in insecure mode, is
  // held above, and no browser sends it over http, because the prefix needs Secure.
  it("in secure mode ignores the unprefixed name, which a sibling subdomain can set", () => {
    expect(readSessionCookie(cookied("bellman_session=tossed"), true)).toBeUndefined();
    const beside = cookied(`bellman_session=tossed; ${HOST}=abc123`);
    expect(readSessionCookie(beside, true)).toBe("abc123");
  });

  // Exact, not folded: the comparison is the whole defence against a near-miss.
  it("matches the name by case", () => {
    expect(readSessionCookie(cookied("__host-bellman_session=tossed"), true)).toBeUndefined();
  });

  it.each([" ", "\t"])("trims %j around the name and the value", (ws) => {
    const header = `a=b;${ws}${HOST}${ws}=${ws}abc123${ws};c=d`;

    expect(readSessionCookie(cookied(header), true)).toBe("abc123");
  });

  // See trimOws. Before the name, after it and around the value: a reader that
  // trimmed one of these anywhere would be reading a different cookie from the one
  // the browser holds.
  it.each(BEYOND_OWS)("trims nothing but space and tab: U+%s", (_hex, ch) => {
    expect(readSessionCookie(bareRequest(`${ch}${HOST}=tossed`), true)).toBeUndefined();
    expect(readSessionCookie(bareRequest(`${HOST}${ch}=tossed`), true)).toBeUndefined();
    const padded = bareRequest(`${HOST}=${ch}abc123${ch}`);
    expect(readSessionCookie(padded, true)).toBe(`${ch}abc123${ch}`);
  });

  // The blank counts as the first sighting, so the pair is a duplicate like any
  // other, whatever the first one holds.
  it("refuses a blank value followed by a real one, as it does any duplicate", () => {
    expect(readSessionCookie(cookied(`${HOST}=; ${HOST}=abc123`), true)).toBeUndefined();
  });

  // A regular expression for the trim, /^[ \t]+|[ \t]+$/g, fails its second branch at
  // every start position inside a run of spaces and rescans the run each time, so
  // `a`, 100,000 spaces and `b=1` take it seconds, from one unauthenticated request.
  // The loop is linear. The bound is generous: the regular expression misses it by
  // an order of magnitude or more.
  it("is linear in the length of a run of spaces", () => {
    const run = " ".repeat(100_000);
    const started = performance.now();
    readSessionCookie(cookied(`a${run}b=1`), true);
    readSessionCookie(cookied(`${HOST}=a${run}b`), true);

    expect(performance.now() - started).toBeLessThan(500);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Task 5: the origin allowlist, CORS, the CSRF rule, and the config parser.
// ---------------------------------------------------------------------------

import {
  allowedOrigin, corsHeaders, csrfRefusal, parsePanelOrigins, preflightResponse,
} from "../src/oauth/browser.js";

const PANEL = "https://dash.example.test";
const ORIGINS = [PANEL];

const from = (origin: string | undefined, method = "GET") =>
  new Request("https://mcp.example.test/auth/session", {
    method,
    headers: origin === undefined ? {} : { origin },
  });

describe("the origin allowlist", () => {
  it("admits a configured origin", () => {
    expect(allowedOrigin(from(PANEL), ORIGINS)).toBe(PANEL);
  });

  it("refuses an origin that is not configured", () => {
    expect(allowedOrigin(from("https://evil.example"), ORIGINS)).toBeUndefined();
  });

  it("refuses an origin that merely starts with a configured one", () => {
    expect(allowedOrigin(from(`${PANEL}.evil.example`), ORIGINS)).toBeUndefined();
  });

  it("refuses a configured origin that merely starts with the request's", () => {
    // The other direction of the same mistake: an endsWith or includes test.
    expect(allowedOrigin(from("https://dash.example"), ORIGINS)).toBeUndefined();
  });

  it("refuses a different scheme on the same host", () => {
    expect(allowedOrigin(from("http://dash.example.test"), ORIGINS)).toBeUndefined();
  });

  it("refuses a different port on the same host", () => {
    expect(allowedOrigin(from("https://dash.example.test:8443"), ORIGINS)).toBeUndefined();
  });

  it("returns undefined when no Origin was sent", () => {
    expect(allowedOrigin(from(undefined), ORIGINS)).toBeUndefined();
  });

  // Review Focus 4 — the literal string "null".
  it('refuses the literal origin "null"', () => {
    expect(allowedOrigin(from("null"), ORIGINS)).toBeUndefined();
  });

  it('refuses "null" even when it appears in the allowlist', () => {
    expect(allowedOrigin(from("null"), ["null", PANEL])).toBeUndefined();
  });

  // Review Focus 3 — a deploy that forgot the var must fail closed.
  it("admits nothing when the allowlist is undefined", () => {
    expect(allowedOrigin(from(PANEL), undefined)).toBeUndefined();
  });

  it("admits nothing when the allowlist is empty", () => {
    expect(allowedOrigin(from(PANEL), [])).toBeUndefined();
  });

  it("admits the second entry, not only the first", () => {
    // A `=== panelOrigins[0]` implementation passes every test above.
    expect(allowedOrigin(from(PANEL), ["https://other.example", PANEL])).toBe(PANEL);
  });
});

describe("CORS headers", () => {
  it("echoes the allowlisted origin and allows credentials", () => {
    const headers = corsHeaders(PANEL);

    expect(headers["access-control-allow-origin"]).toBe(PANEL);
    expect(headers["access-control-allow-credentials"]).toBe("true");
  });

  it("never answers with a wildcard", () => {
    expect(Object.values(corsHeaders(PANEL))).not.toContain("*");
  });

  it("always varies on Origin, so a cache cannot cross-serve", () => {
    expect(corsHeaders(PANEL).vary).toBe("Origin");
  });

  it("emits no allow-origin at all for an origin that is not allowlisted", () => {
    const headers = corsHeaders(undefined);

    expect(headers["access-control-allow-origin"]).toBeUndefined();
    expect(headers["access-control-allow-credentials"]).toBeUndefined();
    // Vary still, or a cached no-CORS response is served to the panel.
    expect(headers.vary).toBe("Origin");
  });
});

describe("preflight", () => {
  it("answers 204 with methods, headers and a max age", async () => {
    const res = preflightResponse(PANEL);

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(PANEL);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toBe("content-type");
    expect(Number(res.headers.get("access-control-max-age"))).toBeGreaterThan(0);
    expect(await res.text()).toBe("");
  });

  it("allows DELETE, which /admin/grants uses", () => {
    expect(preflightResponse(PANEL).headers.get("access-control-allow-methods")).toContain("DELETE");
  });

  it("answers 204 with no CORS grant for a stranger, and no methods either", () => {
    const res = preflightResponse(undefined);

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    // Not just the grant: a stranger learns nothing about what is allowed.
    expect(res.headers.get("access-control-allow-methods")).toBeNull();
    expect(res.headers.get("access-control-max-age")).toBeNull();
    expect(res.headers.get("vary")).toBe("Origin");
  });
});

describe("the CSRF rule", () => {
  it("lets a cookie GET through without an Origin", () => {
    expect(csrfRefusal(from(undefined, "GET"), "cookie", undefined)).toBeUndefined();
  });

  it("lets a cookie HEAD through", () => {
    expect(csrfRefusal(from(undefined, "HEAD"), "cookie", undefined)).toBeUndefined();
  });

  it("lets a cookie OPTIONS through", () => {
    expect(csrfRefusal(from(undefined, "OPTIONS"), "cookie", undefined)).toBeUndefined();
  });

  it("refuses a cookie POST with no Origin", () => {
    expect(csrfRefusal(from(undefined, "POST"), "cookie", undefined)?.status).toBe(403);
  });

  it("refuses a cookie POST whose Origin was off the list", () => {
    // allowedOrigin already turned the off-list header into undefined.
    expect(csrfRefusal(from("https://evil.example", "POST"), "cookie", undefined)?.status).toBe(403);
  });

  it("lets a cookie POST from the panel through", () => {
    expect(csrfRefusal(from(PANEL, "POST"), "cookie", PANEL)).toBeUndefined();
  });

  it("refuses a cookie DELETE with no Origin, not only POST", () => {
    expect(csrfRefusal(from(undefined, "DELETE"), "cookie", undefined)?.status).toBe(403);
  });

  it("refuses a cookie PUT with no Origin", () => {
    // A SAFE_METHODS set written as a negation of ["POST","DELETE"] passes
    // every other test here.
    expect(csrfRefusal(from(undefined, "PUT"), "cookie", undefined)?.status).toBe(403);
  });

  it("refuses a lowercase cookie post with no Origin", () => {
    const req = new Request("https://mcp.example.test/auth/signout", { method: "post" });
    // fetch normalises the common methods to upper case; this pins that the
    // check reads request.method rather than a string the caller supplied.
    expect(csrfRefusal(req, "cookie", undefined)?.status).toBe(403);
  });

  it("says why, in a body the panel can show", async () => {
    const res = csrfRefusal(from(undefined, "POST"), "cookie", undefined)!;
    const body = (await res.json()) as { error: string; error_description: string };

    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toContain("Origin");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  // The exemption, asserted rather than left to the order of the checks.
  it("lets a bearer POST through with no Origin at all", () => {
    expect(csrfRefusal(from(undefined, "POST"), "bearer", undefined)).toBeUndefined();
  });

  it("lets a bearer POST through from an origin off the list", () => {
    expect(csrfRefusal(from("https://evil.example", "POST"), "bearer", undefined)).toBeUndefined();
  });

  it("lets a bearer DELETE through with no Origin", () => {
    expect(csrfRefusal(from(undefined, "DELETE"), "bearer", undefined)).toBeUndefined();
  });
});

describe("parsing BELLMAN_PANELS", () => {
  it("reads one origin", () => {
    expect(parsePanelOrigins("https://dash.bellman.sh")).toEqual(["https://dash.bellman.sh"]);
  });

  it("reads several, comma-separated, and trims them", () => {
    expect(parsePanelOrigins("https://dash.bellman.sh, https://dash.staging.bellman.sh"))
      .toEqual(["https://dash.bellman.sh", "https://dash.staging.bellman.sh"]);
  });

  it("keeps the configured order", () => {
    expect(parsePanelOrigins("https://b.example, https://a.example"))
      .toEqual(["https://b.example", "https://a.example"]);
  });

  it("is empty when the var is unset", () => {
    expect(parsePanelOrigins(undefined)).toEqual([]);
  });

  it("is empty for an empty or whitespace-only var", () => {
    expect(parsePanelOrigins("")).toEqual([]);
    expect(parsePanelOrigins("   ")).toEqual([]);
  });

  it("drops entries that are not absolute http(s) origins, keeping the rest", () => {
    expect(parsePanelOrigins("https://ok.example, not-a-url, javascript:x, /relative"))
      .toEqual(["https://ok.example"]);
  });

  it("drops a javascript: entry specifically, whose origin is the string null", () => {
    expect(parsePanelOrigins("javascript:alert(1)")).toEqual([]);
  });

  it("normalises a trailing slash away", () => {
    // The Origin header never carries a path or a trailing slash, so an entry
    // that does would match nothing and the panel would fail to sign in with
    // nothing anywhere saying why.
    expect(parsePanelOrigins("https://dash.bellman.sh/")).toEqual(["https://dash.bellman.sh"]);
  });

  it("reduces an entry with a path to its origin", () => {
    expect(parsePanelOrigins("https://dash.bellman.sh/panel")).toEqual(["https://dash.bellman.sh"]);
  });

  it("keeps a non-default port, which is part of the origin", () => {
    expect(parsePanelOrigins("https://dash.bellman.sh:8443")).toEqual(["https://dash.bellman.sh:8443"]);
  });

  it("de-duplicates", () => {
    expect(parsePanelOrigins("https://a.example, https://a.example/")).toEqual(["https://a.example"]);
  });

  it("accepts http, for wrangler dev on localhost", () => {
    expect(parsePanelOrigins("http://localhost:5173")).toEqual(["http://localhost:5173"]);
  });

  it("round-trips through allowedOrigin", () => {
    // The two halves have to agree about what an origin looks like: the parser
    // normalises and the allowlist compares exactly, so a mismatch between them
    // is a panel that cannot sign in. Neither unit test alone sees that.
    const origins = parsePanelOrigins("https://dash.bellman.sh/, https://other.example/x");

    expect(allowedOrigin(from("https://dash.bellman.sh"), origins)).toBe("https://dash.bellman.sh");
    expect(allowedOrigin(from("https://other.example"), origins)).toBe("https://other.example");
  });
});


// ---- Task 9: CORS, /admin refusing cookies, CSRF through the real routes ----

import { beforeEach } from "vitest";
import { handleOAuth, type OAuthConfig } from "../src/oauth/routes.js";
import { ACCESS_TOKEN_TTL_SECONDS, signJwt } from "../src/oauth/tokens.js";
import {
  BYSTANDER, COOKIE, IDENTITY, ISSUER, panelConfig, routeWith, seedBystander, seedSession,
} from "./helpers/panel.js";


describe("CORS through the real routes", () => {
  let cfg: OAuthConfig;
  let route: (r: Request) => Promise<Response>;

  beforeEach(() => {
    cfg = panelConfig();
    route = routeWith(cfg);
  });

  it("answers a preflight on /auth/session", async () => {
    const res = await route(new Request(`${ISSUER}/auth/session`, {
      method: "OPTIONS",
      headers: { origin: PANEL, "access-control-request-method": "GET" },
    }));

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(PANEL);
    expect(res.headers.get("vary")).toBe("Origin");
  });

  it("answers a preflight on /auth/signout", async () => {
    const res = await route(new Request(`${ISSUER}/auth/signout`, {
      method: "OPTIONS",
      headers: { origin: PANEL, "access-control-request-method": "POST" },
    }));

    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("answers a preflight on /account", async () => {
    const res = await route(new Request(`${ISSUER}/account`, {
      method: "OPTIONS",
      headers: { origin: PANEL, "access-control-request-method": "GET" },
    }));

    expect(res.headers.get("access-control-allow-origin")).toBe(PANEL);
  });

  it("grants no CORS to a stranger's preflight", async () => {
    const res = await route(new Request(`${ISSUER}/auth/session`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    }));

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("puts CORS on a real /account response", async () => {
    const sid = await seedSession(cfg);
    const res = await route(new Request(`${ISSUER}/account`, {
      headers: { accept: "application/json", origin: PANEL, cookie: `${COOKIE}=${sid}` },
    }));

    expect(res.headers.get("access-control-allow-origin")).toBe(PANEL);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("vary")).toBe("Origin");
  });

  it("does not answer a preflight on /mcp — MCP clients are not browsers", async () => {
    const res = await handleOAuth(
      new Request(`${ISSUER}/mcp`, { method: "OPTIONS", headers: { origin: PANEL } }),
      cfg
    );

    expect(res).toBeUndefined();
  });
});

describe("/admin stays bearer-only", () => {
  let cfg: OAuthConfig;
  let route: (r: Request) => Promise<Response>;

  /** A team admin the operator granted — the only identity that may write grants. */
  const OPERATOR_ADMIN = {
    ...IDENTITY, orgId: "acme", plan: "team" as const, role: "admin" as const,
  };

  const grantBody = JSON.stringify({
    key: "github:999", plan: "pro", role: "member", orgId: "acme",
  });

  /** A grant for the revocation tests to act on, written as the operator would. */
  const seedGrant = () =>
    cfg.plans!.putGrant({
      key: "github:999", plan: "pro", role: "member", orgId: "acme",
      source: "operator", grantedAt: Date.now(), grantedBy: OPERATOR_ADMIN.userId, expiresAt: null,
    });

  beforeEach(() => {
    cfg = panelConfig();
    route = routeWith(cfg);
  });

  it("refuses a cookie-authenticated read of the grant list", async () => {
    const sid = await seedSession(cfg, "admin-sid", {
      identity: OPERATOR_ADMIN, plan_source: "operator",
    });

    const res = await route(new Request(`${ISSUER}/admin/grants`, {
      headers: { cookie: `${COOKIE}=${sid}`, origin: PANEL },
    }));

    expect(res.status).toBe(401);
  });

  it("refuses a cookie-authenticated grant write", async () => {
    const sid = await seedSession(cfg, "admin-sid", {
      identity: OPERATOR_ADMIN, plan_source: "operator",
    });

    const res = await route(new Request(`${ISSUER}/admin/grants`, {
      method: "POST",
      headers: {
        cookie: `${COOKIE}=${sid}`, origin: PANEL, "content-type": "application/json",
      },
      body: grantBody,
    }));

    expect(res.status).toBe(401);
    // The refusal has to be the whole of what happened. A route that stored the
    // grant and then answered 401 passes the line above, and would have handed
    // a customer session the operator's write.
    expect(await cfg.plans!.getGrant("github:999")).toBeUndefined();
  });

  /**
   * The same identity over a bearer token still works. Without this the two
   * tests above would pass for a trivially wrong reason — /admin/grants broken
   * for everyone.
   *
   * It is also the control for the `getGrant` line in the write test: here the
   * same call has to find the grant, so a `getGrant` that read the wrong place
   * would fail this test instead of letting that line pass for every route.
   */
  it("still accepts the identical identity over a bearer token", async () => {
    const token = await signJwt(
      { iss: ISSUER, sub: OPERATOR_ADMIN.userId, aud: cfg.resource,
        bellman: OPERATOR_ADMIN, plan_source: "operator" },
      cfg.secret, ACCESS_TOKEN_TTL_SECONDS
    );

    const res = await route(new Request(`${ISSUER}/admin/grants`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: grantBody,
    }));

    expect(res.status).toBe(201);
    expect(await cfg.plans!.getGrant("github:999")).toMatchObject({
      key: "github:999", plan: "pro", role: "member", orgId: "acme",
    });
  });

  // A revocation is a write like the grant is. The guard names no method, and one
  // written to skip a method would leave a cookie able to take a grant away.
  it("refuses a cookie-authenticated revocation, and the grant stays", async () => {
    await seedGrant();
    const sid = await seedSession(cfg, "admin-sid", {
      identity: OPERATOR_ADMIN, plan_source: "operator",
    });

    const res = await route(new Request(`${ISSUER}/admin/grants?key=github:999`, {
      method: "DELETE",
      headers: { cookie: `${COOKIE}=${sid}`, origin: PANEL },
    }));

    expect(res.status).toBe(401);
    expect(await cfg.plans!.getGrant("github:999")).toMatchObject({
      key: "github:999", plan: "pro", role: "member", orgId: "acme",
    });
  });

  // The control for the revocation above: the same identity over a bearer token
  // revokes, so the grant staying is the refusal and not DELETE broken for everyone.
  it("still accepts the identical identity revoking over a bearer token", async () => {
    await seedGrant();
    const token = await signJwt(
      { iss: ISSUER, sub: OPERATOR_ADMIN.userId, aud: cfg.resource,
        bellman: OPERATOR_ADMIN, plan_source: "operator" },
      cfg.secret, ACCESS_TOKEN_TTL_SECONDS
    );

    const res = await route(new Request(`${ISSUER}/admin/grants?key=github:999`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    }));

    expect(res.status).toBe(200);
    expect(await cfg.plans!.getGrant("github:999")).toBeUndefined();
  });

  it("grants no CORS on /admin, so a browser cannot even read the refusal", async () => {
    const res = await route(new Request(`${ISSUER}/admin/grants`, {
      headers: { origin: PANEL },
    }));

    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("CSRF through the real routes", () => {
  let cfg: OAuthConfig;
  let route: (r: Request) => Promise<Response>;

  beforeEach(() => {
    cfg = panelConfig();
    route = routeWith(cfg);
  });

  it("refuses a cookie POST to /auth/signout with no Origin, and the session survives", async () => {
    const sid = await seedSession(cfg);

    const res = await route(new Request(`${ISSUER}/auth/signout`, {
      method: "POST",
      headers: { cookie: `${COOKIE}=${sid}` },
    }));

    expect(res.status).toBe(403);
    expect((await route(new Request(`${ISSUER}/auth/session`, {
      headers: { cookie: `${COOKIE}=${sid}` },
    }))).status).toBe(200);
  });

  // The same strength as the test above, for the other way into the same rule. A
  // refusal that deleted first would let a page on any origin sign a human out and
  // be told 403 about it.
  it("refuses a cookie POST from an origin off the list, and the session survives", async () => {
    const sid = await seedSession(cfg);

    const res = await route(new Request(`${ISSUER}/auth/signout`, {
      method: "POST",
      headers: { cookie: `${COOKIE}=${sid}`, origin: "https://evil.example" },
    }));

    expect(res.status).toBe(403);
    expect((await route(new Request(`${ISSUER}/auth/session`, {
      headers: { cookie: `${COOKIE}=${sid}` },
    }))).status).toBe(200);
  });
});
