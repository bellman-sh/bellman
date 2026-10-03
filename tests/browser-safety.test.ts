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
