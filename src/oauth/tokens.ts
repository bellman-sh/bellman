import type { Identity } from "../types.js";

/**
 * Token primitives for Bellman's authorization server.
 *
 * Access tokens are HMAC-signed JWTs carrying the caller's Identity, so /mcp
 * validates one with a signature check and no storage read. That is the whole
 * reason they are short-lived: there is no revocation list, so a stolen token
 * is only good until it expires, and a plan or role change only takes effect
 * at the next refresh.
 *
 * Refresh tokens and authorization codes are opaque and stored, because both
 * need single-use semantics that a stateless token cannot give.
 */

const encoder = new TextEncoder();

/** Web Crypto wants a plain ArrayBuffer; a Uint8Array view is not one. */
function buffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

export const ACCESS_TOKEN_TTL_SECONDS = 10 * 60;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const AUTH_CODE_TTL_MS = 60 * 1000;
/** The signed blob handed to an upstream provider and back, as `state`. */
export const STATE_TTL_SECONDS = 10 * 60;

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** 256 bits of randomness: authorization codes, refresh tokens, client ids. */
export function randomId(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function hmacKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw", buffer(encoder.encode(secret)), { name: "HMAC", hash: "SHA-256" }, false, usage
  );
}

export async function sha256Base64url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer(encoder.encode(value)));
  return base64url(new Uint8Array(digest));
}

export interface Claims {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  jti: string;
  /** The Bellman identity this token speaks for. */
  bellman: Identity;
  [key: string]: unknown;
}

export async function signJwt(
  claims: Omit<Claims, "exp" | "iat" | "jti"> & Partial<Pick<Claims, "exp" | "iat" | "jti">>,
  secret: string,
  ttlSeconds: number
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Claims = {
    ...claims,
    iat: claims.iat ?? now,
    exp: claims.exp ?? now + ttlSeconds,
    jti: claims.jti ?? randomId(16),
  } as Claims;
  const header = { alg: "HS256", typ: "JWT" };
  const body =
    `${base64url(encoder.encode(JSON.stringify(header)))}.` +
    `${base64url(encoder.encode(JSON.stringify(payload)))}`;
  const signature = await crypto.subtle.sign(
    "HMAC", await hmacKey(secret, ["sign"]), buffer(encoder.encode(body))
  );
  return `${body}.${base64url(new Uint8Array(signature))}`;
}

/**
 * Verify signature, expiry, issuer and audience. Audience is not optional:
 * the spec requires a resource server to reject a token minted for anyone
 * else, which is what stops a token for another MCP server being replayed here.
 */
export async function verifyJwt(
  token: string,
  secret: string,
  expect: { issuer: string; audience: string }
): Promise<Claims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;

  const ok = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, ["verify"]),
    buffer(base64urlDecode(signature)),
    buffer(encoder.encode(`${header}.${payload}`))
  );
  if (!ok) return null;

  let claims: Claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64urlDecode(payload))) as Claims;
  } catch {
    return null;
  }
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) return null;
  if (claims.iss !== expect.issuer) return null;
  if (claims.aud !== expect.audience) return null;
  return claims;
}

/** PKCE S256 only — `plain` is not accepted, per OAuth 2.1. */
export async function verifyPkce(verifier: string, challenge: string): Promise<boolean> {
  if (!verifier || verifier.length < 43 || verifier.length > 128) return false;
  return (await sha256Base64url(verifier)) === challenge;
}

/**
 * The canonical resource URI a token is minted for, per RFC 8707. Compared
 * exactly against the client's `resource` parameter, so it must be normalized
 * the same way on both sides: no trailing slash, no fragment, lowercase host.
 */
export function canonicalResource(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.search = "";
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}`;
}
