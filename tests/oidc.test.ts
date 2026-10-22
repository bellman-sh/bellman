import { describe, expect, it } from "vitest";
import { discover, nonceFor, oidcAuthorizeUrl, oidcExchange, type OidcEndpoints } from "../src/oauth/oidc.js";
import { base64url, sha256Base64url } from "../src/oauth/tokens.js";

/**
 * The one OIDC client every org's IdP is spoken to with (SSO spec, D9, D12), over a fake IdP at
 * the fetch boundary: discovery, the authorization URL, and the exchange with each claim check.
 */

const ISSUER = "https://idp.test";
const CLIENT = "0oa-client";
const REDIRECT = "https://mcp.example.test/callback/sso/org_acme";
const NOW = Math.floor(Date.now() / 1000);

const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
/** An id token as the fake IdP mints one: any signature, since the claims come straight from the token endpoint. */
const idToken = (claims: Record<string, unknown>) => `${encode({ alg: "RS256", kid: "k1" })}.${encode(claims)}.sig`;
const claims = (over: Record<string, unknown> = {}) => ({
  iss: ISSUER, aud: CLIENT, exp: NOW + 300, iat: NOW, nonce: "the-nonce", sub: "00u1abc",
  email: "ana@acme.test", email_verified: true, name: "Ana", ...over,
});

interface Fake {
  discovery?: Record<string, unknown> | "missing" | "not json";
  token?: Record<string, unknown> | number;
  userinfo?: Record<string, unknown>;
  seen: { url: string; init?: RequestInit }[];
}
const fakeIdp = (over: Partial<Fake> = {}): { fetchImpl: typeof fetch; fake: Fake } => {
  const fake: Fake = { seen: [], ...over };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fake.seen.push({ url, init });
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      if (fake.discovery === "missing") return new Response("no", { status: 404 });
      if (fake.discovery === "not json") return new Response("<html>", { status: 200 });
      return Response.json(fake.discovery ?? {
        issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`,
        userinfo_endpoint: `${ISSUER}/userinfo`, token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      });
    }
    if (url === `${ISSUER}/token`) {
      if (typeof fake.token === "number") return new Response("no", { status: fake.token });
      return Response.json(fake.token ?? { access_token: "at", token_type: "Bearer", id_token: idToken(claims()) });
    }
    if (url === `${ISSUER}/userinfo`) return Response.json(fake.userinfo ?? { sub: "00u1abc", email: "ana@acme.test", email_verified: true });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return { fetchImpl, fake };
};

const endpoints: OidcEndpoints = {
  issuer: ISSUER, tokenAuth: "client_secret_basic", authorizationEndpoint: `${ISSUER}/authorize`,
  tokenEndpoint: `${ISSUER}/token`, userinfoEndpoint: `${ISSUER}/userinfo`,
};
const idp = { ...endpoints, clientId: CLIENT, clientSecret: "shh" };

describe("discovery", () => {
  it("reads the endpoints, preferring client_secret_basic when the IdP lists it", async () => {
    expect(await discover(ISSUER, fakeIdp().fetchImpl)).toEqual(endpoints);
    const post = fakeIdp({ discovery: { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, token_endpoint_auth_methods_supported: ["client_secret_post"] } });
    expect(await discover(ISSUER, post.fetchImpl)).toEqual({ ...endpoints, tokenAuth: "client_secret_post", userinfoEndpoint: null });
    const silent = fakeIdp({ discovery: { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token` } });
    expect((await discover(ISSUER, silent.fetchImpl)) as OidcEndpoints).toMatchObject({ tokenAuth: "client_secret_basic" });
  });

  it("says what is wrong with an issuer it cannot use", async () => {
    const error = async (issuer: string, over: Partial<Fake> = {}) => ((await discover(issuer, fakeIdp(over).fetchImpl)) as { error: string }).error;
    expect(await error("http://idp.test")).toMatch(/https/);
    expect(await error(`${ISSUER}/?x=1`)).toMatch(/query/);
    expect(await error(`${ISSUER}#frag`)).toMatch(/fragment/);
    expect(await error(ISSUER, { discovery: "missing" })).toMatch(/404/);
    expect(await error(ISSUER, { discovery: "not json" })).toMatch(/JSON/);
    expect(await error(ISSUER, { discovery: { issuer: `${ISSUER}/`, authorization_endpoint: `${ISSUER}/a`, token_endpoint: `${ISSUER}/t` } })).toMatch(/issuer/);
    expect(await error(ISSUER, { discovery: { issuer: ISSUER, authorization_endpoint: `${ISSUER}/a` } })).toMatch(/token_endpoint/);
    expect(await error(ISSUER, { discovery: { issuer: ISSUER, authorization_endpoint: `http://idp.test/a`, token_endpoint: `${ISSUER}/t` } })).toMatch(/https/);
  });

  it("strips a trailing slash from the issuer before asking, and keeps it stripped", async () => {
    const { fetchImpl, fake } = fakeIdp();
    expect(await discover(`${ISSUER}/`, fetchImpl)).toEqual(endpoints);
    expect(fake.seen[0].url).toBe(`${ISSUER}/.well-known/openid-configuration`);
  });
});

describe("the authorization URL", () => {
  it("asks for a code with openid, email and profile, the state and the nonce", async () => {
    const url = new URL(oidcAuthorizeUrl({ ...endpoints, clientId: CLIENT }, REDIRECT, "st-1", "n-1"));
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT, redirect_uri: REDIRECT, response_type: "code", scope: "openid email profile", state: "st-1", nonce: "n-1",
    });
    expect(await nonceFor("st-1")).toBe(await sha256Base64url("st-1"));
  });
});

describe("the exchange", () => {
  it("reads the subject, the address, its verification and the name from the id token", async () => {
    const { fetchImpl, fake } = fakeIdp();
    expect(await oidcExchange(idp, "code-1", REDIRECT, "the-nonce", fetchImpl)).toEqual({ sub: "00u1abc", email: "ana@acme.test", emailVerified: true, name: "Ana" });
    const token = fake.seen.find((s) => s.url === `${ISSUER}/token`)!;
    expect(new Headers(token.init?.headers).get("authorization")).toBe(`Basic ${btoa(`${CLIENT}:shh`)}`);
    const form = new URLSearchParams(String(token.init?.body));
    expect(Object.fromEntries(form)).toEqual({ grant_type: "authorization_code", code: "code-1", redirect_uri: REDIRECT });
    expect(fake.seen.some((s) => s.url === `${ISSUER}/userinfo`)).toBe(false);
  });

  it("sends the secret in the form under client_secret_post, and asks userinfo only when the token lacks an address", async () => {
    const { fetchImpl, fake } = fakeIdp({ token: { access_token: "at", id_token: idToken(claims({ email: undefined, name: undefined })) } });
    const read = await oidcExchange({ ...idp, tokenAuth: "client_secret_post" }, "code-1", REDIRECT, "the-nonce", fetchImpl);
    expect(read).toEqual({ sub: "00u1abc", email: "ana@acme.test", emailVerified: true, name: undefined });
    const token = fake.seen.find((s) => s.url === `${ISSUER}/token`)!;
    expect(new Headers(token.init?.headers).get("authorization")).toBeNull();
    expect(Object.fromEntries(new URLSearchParams(String(token.init?.body)))).toMatchObject({ client_id: CLIENT, client_secret: "shh" });
    const userinfo = fake.seen.find((s) => s.url === `${ISSUER}/userinfo`)!;
    expect(new Headers(userinfo.init?.headers).get("authorization")).toBe("Bearer at");
  });

  it("answers no address when the token has none and the IdP has no userinfo endpoint, and reads an unverified one as unverified", async () => {
    const none = fakeIdp({ token: { access_token: "at", id_token: idToken(claims({ email: undefined })) } });
    expect(await oidcExchange({ ...idp, userinfoEndpoint: null }, "c", REDIRECT, "the-nonce", none.fetchImpl)).toMatchObject({ sub: "00u1abc", email: undefined, emailVerified: false });
    const unverified = fakeIdp({ token: { access_token: "at", id_token: idToken(claims({ email_verified: undefined })) } });
    expect(await oidcExchange(idp, "c", REDIRECT, "the-nonce", unverified.fetchImpl)).toMatchObject({ email: "ana@acme.test", emailVerified: false });
  });

  it("refuses an id token that fails any claim it checks, naming the claim", async () => {
    const refusal = async (over: Record<string, unknown>, nonce = "the-nonce") => {
      const { fetchImpl } = fakeIdp({ token: { access_token: "at", id_token: idToken(claims(over)) } });
      return oidcExchange(idp, "c", REDIRECT, nonce, fetchImpl).then(() => "accepted", (e: Error) => e.message);
    };
    expect(await refusal({ iss: `${ISSUER}/` })).toMatch(/iss/);
    expect(await refusal({ aud: "someone-else" })).toMatch(/aud/);
    expect(await refusal({ aud: ["someone-else", CLIENT] })).toBe("accepted");
    expect(await refusal({ exp: NOW - 1 })).toMatch(/exp/);
    expect(await refusal({}, "another-nonce")).toMatch(/nonce/);
    expect(await refusal({ sub: undefined })).toMatch(/sub/);
    expect(await refusal({ sub: "a".repeat(129) })).toMatch(/sub/);
    expect(await refusal({ sub: "with space" })).toMatch(/sub/);
  });

  it("refuses a token response with no id token, one that is not a token, and a refused exchange", async () => {
    const noId = fakeIdp({ token: { access_token: "at" } });
    await expect(oidcExchange(idp, "c", REDIRECT, "the-nonce", noId.fetchImpl)).rejects.toThrow(/id_token/);
    const junk = fakeIdp({ token: { access_token: "at", id_token: "not.a" } });
    await expect(oidcExchange(idp, "c", REDIRECT, "the-nonce", junk.fetchImpl)).rejects.toThrow(/id_token/);
    const refused = fakeIdp({ token: 401 });
    await expect(oidcExchange(idp, "c", REDIRECT, "the-nonce", refused.fetchImpl)).rejects.toThrow(/401/);
  });
});
