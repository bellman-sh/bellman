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
});
