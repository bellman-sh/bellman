import { describe, expect, it } from "vitest";
import {
  base64url, base64urlDecode, canonicalResource, randomId, sha256Base64url,
  signJwt, verifyJwt, verifyPkce,
} from "../src/oauth/tokens.js";
import type { Identity } from "../src/types.js";

const SECRET = "a-test-signing-secret";
const ISSUER = "https://mcp.example.test";
const RESOURCE = "https://mcp.example.test/mcp";

const identity: Identity = {
  userId: "u_test", orgId: "org_test", plan: "team", role: "admin", label: "test@org",
};
const claims = { iss: ISSUER, sub: identity.userId, aud: RESOURCE, bellman: identity };

describe("encoding", () => {
  it("round-trips base64url without padding", () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    const encoded = base64url(bytes);

    expect(encoded).not.toMatch(/[+/=]/);
    expect([...base64urlDecode(encoded)]).toEqual([...bytes]);
  });

  it("mints ids with 256 bits of entropy", () => {
    expect(new Set(Array.from({ length: 200 }, () => randomId())).size).toBe(200);
  });
});

describe("access tokens", () => {
  it("verifies a token it just signed", async () => {
    const token = await signJwt(claims, SECRET, 600);

    const verified = await verifyJwt(token, SECRET, { issuer: ISSUER, audience: RESOURCE });

    expect(verified?.bellman).toEqual(identity);
  });

  it("rejects a tampered payload", async () => {
    const token = await signJwt(claims, SECRET, 600);
    const [header, , signature] = token.split(".");
    const forged = JSON.parse(
      new TextDecoder().decode(base64urlDecode(token.split(".")[1]))
    ) as Record<string, unknown>;
    forged.bellman = { ...identity, plan: "team", role: "admin", orgId: "org_someone_else" };
    const swapped = `${header}.${base64url(new TextEncoder().encode(JSON.stringify(forged)))}.${signature}`;

    expect(await verifyJwt(swapped, SECRET, { issuer: ISSUER, audience: RESOURCE })).toBeNull();
  });

  it("rejects another server's signing key", async () => {
    const token = await signJwt(claims, "someone-elses-secret", 600);

    expect(await verifyJwt(token, SECRET, { issuer: ISSUER, audience: RESOURCE })).toBeNull();
  });

  /**
   * The audience check is what stops a token minted for a different MCP server
   * being replayed here. The spec makes it a MUST for exactly this reason.
   */
  it("rejects a token minted for another resource", async () => {
    const token = await signJwt({ ...claims, aud: "https://other.example/mcp" }, SECRET, 600);

    expect(await verifyJwt(token, SECRET, { issuer: ISSUER, audience: RESOURCE })).toBeNull();
  });

  it("rejects another issuer and an expired token", async () => {
    const wrongIssuer = await signJwt({ ...claims, iss: "https://evil.example" }, SECRET, 600);
    expect(await verifyJwt(wrongIssuer, SECRET, { issuer: ISSUER, audience: RESOURCE })).toBeNull();

    const expired = await signJwt(
      { ...claims, exp: Math.floor(Date.now() / 1000) - 1 }, SECRET, 600
    );
    expect(await verifyJwt(expired, SECRET, { issuer: ISSUER, audience: RESOURCE })).toBeNull();
  });

  it("rejects anything that is not a three-part token", async () => {
    for (const bad of ["", "nope", "a.b", "a.b.c.d"]) {
      expect(await verifyJwt(bad, SECRET, { issuer: ISSUER, audience: RESOURCE })).toBeNull();
    }
  });
});

describe("PKCE", () => {
  it("accepts the verifier its challenge was derived from", async () => {
    const verifier = "x".repeat(64);

    expect(await verifyPkce(verifier, await sha256Base64url(verifier))).toBe(true);
  });

  it("rejects a different verifier, and one too short to be worth anything", async () => {
    const challenge = await sha256Base64url("x".repeat(64));

    expect(await verifyPkce("y".repeat(64), challenge)).toBe(false);
    expect(await verifyPkce("short", challenge)).toBe(false);
    expect(await verifyPkce("", challenge)).toBe(false);
  });
});

describe("canonical resource", () => {
  it("normalizes the forms RFC 8707 says are the same", () => {
    expect(canonicalResource("https://MCP.Bellman.SH/mcp")).toBe("https://mcp.bellman.sh/mcp");
    expect(canonicalResource("https://mcp.bellman.sh/mcp/")).toBe("https://mcp.bellman.sh/mcp");
    expect(canonicalResource("https://mcp.bellman.sh/mcp#frag")).toBe("https://mcp.bellman.sh/mcp");
    expect(canonicalResource("https://mcp.bellman.sh/mcp?x=1")).toBe("https://mcp.bellman.sh/mcp");
  });

  it("keeps servers on different paths and ports distinct", () => {
    expect(canonicalResource("https://mcp.bellman.sh/other")).not.toBe("https://mcp.bellman.sh/mcp");
    expect(canonicalResource("https://mcp.bellman.sh:8443/mcp")).not.toBe("https://mcp.bellman.sh/mcp");
  });
});
