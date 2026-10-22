import type { OrgIdp } from "../types.js";
import { SSO_SUB } from "./providers.js";
import { base64urlDecode, sha256Base64url } from "./tokens.js";

/**
 * The one OIDC client every org's identity provider is spoken to with (SSO spec, D9 and D12).
 * Discovery runs once, when an admin saves the IdP, and the endpoints it found are stored; a
 * sign-in then builds the authorization URL and exchanges the code against those, and reads the
 * id token's claims. Runtime-free: a fetch in, a profile out, so the tests drive it over a fake IdP.
 */

export type OidcEndpoints = Pick<OrgIdp, "issuer" | "tokenAuth" | "authorizationEndpoint" | "tokenEndpoint" | "userinfoEndpoint">;

/** What the exchange learned of the person: the subject, and the address and name when the IdP gave them. */
export interface OidcIdentity {
  sub: string;
  email?: string;
  /** True only when the IdP said so (`email_verified: true`); an address it did not vouch for is a label. */
  emailVerified: boolean;
  name?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The issuer as stored: https, no query, no fragment, no trailing slash; or why not. */
function usableIssuer(issuer: string): { issuer: string } | { error: string } {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return { error: "issuer must be an absolute https URL" };
  }
  if (url.protocol !== "https:") return { error: "issuer must be an https URL" };
  if (url.search) return { error: "issuer must carry no query string" };
  if (url.hash || issuer.includes("#")) return { error: "issuer must carry no fragment" };
  return { issuer: issuer.replace(/\/+$/, "") };
}

const httpsEndpoint = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * The IdP's discovery document, read once (D9): the issuer must state itself exactly as given, the
 * two endpoints must be https, and the client authenticates to the token endpoint by HTTP Basic when
 * the document lists it or says nothing, which is OIDC's default, and in the form otherwise.
 */
export async function discover(issuer: string, fetchImpl: typeof fetch = fetch): Promise<OidcEndpoints | { error: string }> {
  const usable = usableIssuer(issuer);
  if ("error" in usable) return usable;
  let res: Response;
  try {
    res = await fetchImpl(`${usable.issuer}/.well-known/openid-configuration`, { headers: { accept: "application/json" } });
  } catch (err) {
    return { error: `the discovery document could not be fetched: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) return { error: `the discovery document answered HTTP ${res.status}` };
  const doc: unknown = await res.json().catch(() => undefined);
  if (!isRecord(doc)) return { error: "the discovery document is not JSON" };
  if (doc.issuer !== usable.issuer) return { error: `the discovery document names another issuer: ${String(doc.issuer)}` };
  if (!httpsEndpoint(doc.authorization_endpoint)) return { error: "the discovery document's authorization_endpoint is missing or not https" };
  if (!httpsEndpoint(doc.token_endpoint)) return { error: "the discovery document's token_endpoint is missing or not https" };
  const methods = Array.isArray(doc.token_endpoint_auth_methods_supported) ? doc.token_endpoint_auth_methods_supported : undefined;
  return {
    issuer: usable.issuer,
    tokenAuth: methods === undefined || methods.includes("client_secret_basic") ? "client_secret_basic" : "client_secret_post",
    authorizationEndpoint: doc.authorization_endpoint,
    tokenEndpoint: doc.token_endpoint,
    userinfoEndpoint: httpsEndpoint(doc.userinfo_endpoint) ? doc.userinfo_endpoint : null,
  };
}

/** The nonce an authorization request carries, derived from the state so nothing has to be stored for it (D12). */
export const nonceFor = (state: string): Promise<string> => sha256Base64url(state);

export function oidcAuthorizeUrl(idp: OidcEndpoints & { clientId: string }, redirectUri: string, state: string, nonce: string): string {
  const url = new URL(idp.authorizationEndpoint);
  for (const [k, v] of Object.entries({
    client_id: idp.clientId, redirect_uri: redirectUri, response_type: "code", scope: "openid email profile", state, nonce,
  })) url.searchParams.set(k, v);
  return url.toString();
}

/** The id token's claims, read without a signature check: see `oidcExchange`. */
function claimsOf(idToken: unknown): Record<string, unknown> {
  const parts = typeof idToken === "string" ? idToken.split(".") : [];
  if (parts.length !== 3) throw new Error("the token response carries no usable id_token");
  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1])));
  } catch {
    throw new Error("the id_token's claims are not JSON");
  }
  if (!isRecord(claims)) throw new Error("the id_token's claims are not an object");
  return claims;
}

/**
 * Exchange the code and read who signed in (D12). The id token arrives in the token endpoint's own
 * response over TLS, the one case OIDC Core 3.1.3.7 step 6 lets a client skip the signature check
 * for, and the endpoint is the one the org's admin configured; `iss`, `aud`, `exp`, `nonce` and
 * `sub` are checked. The address and the name are read from the token, or from userinfo when the
 * token lacks the address and the IdP has the endpoint.
 * ponytail: a JWKS check is the upgrade if an IdP ever answers a token request from somewhere other than its issuer.
 */
export async function oidcExchange(
  idp: OidcEndpoints & { clientId: string; clientSecret: string },
  code: string,
  redirectUri: string,
  nonce: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OidcIdentity> {
  const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (idp.tokenAuth === "client_secret_basic") {
    headers.authorization = `Basic ${btoa(`${encodeURIComponent(idp.clientId)}:${encodeURIComponent(idp.clientSecret)}`)}`;
  } else {
    form.set("client_id", idp.clientId);
    form.set("client_secret", idp.clientSecret);
  }
  const res = await fetchImpl(idp.tokenEndpoint, { method: "POST", headers, body: form.toString() });
  if (!res.ok) throw new Error(`the token endpoint answered HTTP ${res.status}`);
  const body: unknown = await res.json().catch(() => undefined);
  if (!isRecord(body)) throw new Error("the token response is not JSON");
  const claims = claimsOf(body.id_token);

  if (claims.iss !== idp.issuer) throw new Error("the id_token's iss is not the configured issuer");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(idp.clientId)) throw new Error("the id_token's aud does not name this client");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) throw new Error("the id_token's exp has passed");
  if (claims.nonce !== nonce) throw new Error("the id_token's nonce is not this sign-in's");
  if (typeof claims.sub !== "string" || !SSO_SUB.test(claims.sub)) throw new Error("the id_token's sub is missing or outside the grammar");

  let email = typeof claims.email === "string" ? claims.email : undefined;
  // A verification is of an address: without one there is nothing it could be true of.
  let emailVerified = email !== undefined && claims.email_verified === true;
  let name = typeof claims.name === "string" ? claims.name : undefined;
  if (email === undefined && idp.userinfoEndpoint && typeof body.access_token === "string") {
    const info = await fetchImpl(idp.userinfoEndpoint, { headers: { authorization: `Bearer ${body.access_token}`, accept: "application/json" } });
    const user: unknown = info.ok ? await info.json().catch(() => undefined) : undefined;
    if (isRecord(user) && user.sub === claims.sub) {
      email = typeof user.email === "string" ? user.email : undefined;
      emailVerified = email !== undefined && user.email_verified === true;
      name ??= typeof user.name === "string" ? user.name : undefined;
    }
  }
  return { sub: claims.sub, email, emailVerified, name };
}
