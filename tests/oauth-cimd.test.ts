/**
 * Client ID Metadata Documents (src/oauth/cimd.ts, #570): a client_id that is an https URL serving the client's own
 * metadata. The fetcher's rules are SSRF rules, so each refusal is pinned here, and the whole sign-in runs once end
 * to end with a document client: authorize, the provider, the callback, the token.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  CIMD_FETCHES_PER_HOST_PER_MINUTE,
  CIMD_MAX_BYTES,
  CIMD_TTL_CEILING_MS,
  CIMD_TTL_FLOOR_MS,
  CimdCache,
  cimdTtl,
  isCimdClientId,
  resolveCimdClient,
  validateCimdDocument,
} from "../src/oauth/cimd.js";
import { handleOAuth, type OAuthConfig } from "../src/oauth/routes.js";
import { MemoryAuthStore } from "../src/oauth/storage.js";
import { sha256Base64url } from "../src/oauth/tokens.js";
import { MemoryStore } from "../src/storage/memory-store.js";

const DOC_URL = "https://app.example.com/oauth/client.json";
const REDIRECT = "https://app.example.com/callback";
const usable = (u: string) => u.startsWith("https://") || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(u);
const doc = (over: Record<string, unknown> = {}) => ({
  client_id: DOC_URL,
  client_name: "Example App",
  redirect_uris: [REDIRECT],
  token_endpoint_auth_method: "none",
  ...over,
});
const serve = (body: unknown, init: ResponseInit = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });

describe("which client_ids are documents", () => {
  it("takes an https URL on a public name with a path", () => {
    expect(isCimdClientId(DOC_URL)).toBe(true);
    expect(isCimdClientId("https://a.example.org/c")).toBe(true);
  });

  it("refuses everything an attacker could aim at us or that is not exactly a document URL", () => {
    for (const id of [
      "client_abc123", // a registered client
      "http://app.example.com/c.json", // not https
      "https://app.example.com", // no path
      "https://app.example.com/", // root path
      "https://app.example.com:8443/c.json", // a port
      "https://user:pw@app.example.com/c.json", // credentials
      "https://app.example.com/c.json?x=1", // query
      "https://app.example.com/c.json#f", // fragment
      "https://app.example.com/a/../c.json", // dot segment
      "https://127.0.0.1/c.json", // IP literal
      "https://[::1]/c.json",
      "https://localhost/c.json",
      "https://intranet/c.json", // single label
      "https://printer.local/c.json",
      "https://svc.internal/c.json",
      "https://APP.example.com/c.json", // not as it would be fetched
    ]) {
      expect(isCimdClientId(id), id).toBe(false);
    }
  });
});

describe("validating a document", () => {
  it("accepts a well-formed public client", () => {
    const r = validateCimdDocument(doc(), DOC_URL, usable, 1);
    expect(r).toEqual({ client: { client_id: DOC_URL, client_name: "Example App", redirect_uris: [REDIRECT], created_at: 1, expires_at: null } });
  });

  it("refuses a document that is not its own, incomplete, or a confidential client", () => {
    const refuse = (d: unknown) => expect("error" in validateCimdDocument(d, DOC_URL, usable, 1), JSON.stringify(d)).toBe(true);
    refuse([doc()]);
    refuse(doc({ client_id: "https://evil.example.com/c.json" }));
    refuse(doc({ client_name: "" }));
    refuse(doc({ client_name: undefined }));
    refuse(doc({ redirect_uris: [] }));
    refuse(doc({ redirect_uris: ["ftp://x"] }));
    refuse(doc({ redirect_uris: ["http://app.example.com/cb"] }));
    refuse(doc({ token_endpoint_auth_method: "private_key_jwt" }));
  });
});

describe("how long a document is kept", () => {
  it("honours max-age between the floor and the ceiling", () => {
    expect(cimdTtl(null)).toBe(CIMD_TTL_FLOOR_MS);
    expect(cimdTtl("no-store")).toBe(CIMD_TTL_FLOOR_MS);
    expect(cimdTtl("public, max-age=3600")).toBe(3_600_000);
    expect(cimdTtl("max-age=1")).toBe(CIMD_TTL_FLOOR_MS);
    expect(cimdTtl("max-age=999999999")).toBe(CIMD_TTL_CEILING_MS);
  });
});

describe("fetching a document", () => {
  let cache: CimdCache;
  let calls: { url: string; init?: RequestInit }[];
  beforeEach(() => {
    cache = new CimdCache();
    calls = [];
  });
  const resolve = (respond: () => Response | Promise<Response>, now = 1_000) =>
    resolveCimdClient(DOC_URL, {
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return respond();
      }) as typeof fetch,
      usable,
      cache,
      now: () => now,
    });

  it("fetches once, follows no redirect, and serves the cache until it expires", async () => {
    expect(await resolve(() => serve(doc(), { headers: { "cache-control": "max-age=600" } }))).toHaveProperty("client.client_name", "Example App");
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.redirect).toBe("manual");
    await resolve(() => serve(doc()), 1_000 + 599_000);
    expect(calls).toHaveLength(1);
    await resolve(() => serve(doc()), 1_000 + 600_001);
    expect(calls).toHaveLength(2);
  });

  it("refuses a redirect, an error status, the wrong type, an oversized body and bad JSON, and caches none", async () => {
    for (const respond of [
      () => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } }),
      () => new Response("nope", { status: 404 }),
      () => new Response(JSON.stringify(doc()), { headers: { "content-type": "text/html" } }),
      () => serve(JSON.stringify(doc({ client_name: "x".repeat(CIMD_MAX_BYTES) }))),
      () => serve("{not json"),
    ]) {
      expect(await resolve(respond)).toHaveProperty("error");
    }
    expect(cache.get(DOC_URL, 1_000)).toBeUndefined();
  });

  it("reports a fetch that throws, such as a timeout", async () => {
    expect(await resolve(() => Promise.reject(new DOMException("timed out", "TimeoutError")))).toEqual({
      error: "the client metadata could not be fetched",
    });
  });

  it("calls fetch with no receiver, as workerd's global fetch requires", async () => {
    // workerd throws "Illegal invocation" when its fetch is called as a method of another object.
    const workerdFetch = function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(serve(doc()));
    } as unknown as typeof fetch;
    expect(await resolveCimdClient(DOC_URL, { fetchImpl: workerdFetch, usable, cache, now: () => 1_000 })).toHaveProperty("client");
  });

  it("stops fetching from a host past its minute's allowance", async () => {
    for (let i = 0; i < CIMD_FETCHES_PER_HOST_PER_MINUTE; i++) await resolve(() => new Response("x", { status: 500 }));
    expect(await resolve(() => serve(doc()))).toHaveProperty("error", "too many metadata fetches for this host; try again in a minute");
    expect(calls).toHaveLength(CIMD_FETCHES_PER_HOST_PER_MINUTE);
    expect(await resolve(() => serve(doc()), 1_000 + 61_000)).toHaveProperty("client");
  });
});

describe("signing in with a document client", () => {
  const ISSUER = "https://mcp.example.test";
  const RESOURCE = `${ISSUER}/mcp`;
  const VERIFIER = "v".repeat(64);
  let config: OAuthConfig;
  let served: unknown;

  beforeEach(() => {
    served = doc();
    config = {
      issuer: ISSUER,
      resource: RESOURCE,
      secret: "test-signing-secret",
      store: new MemoryAuthStore(),
      credentials: { github: { clientId: "gh-id", clientSecret: "gh-secret" } },
      overrides: {},
      plans: new MemoryStore(),
      cimdCache: new CimdCache(),
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === DOC_URL) return serve(served);
        if (url.startsWith("https://github.com/login/oauth/access_token")) return Response.json({ access_token: "gh" });
        if (url === "https://api.github.com/user") return Response.json({ id: 4242, login: "m", email: null });
        if (url === "https://api.github.com/user/emails") return Response.json([{ email: "m@example.dev", primary: true, verified: true }]);
        return new Response("unexpected", { status: 500 });
      }) as typeof fetch,
    };
  });
  const call = async (path: string, init?: RequestInit) => (await handleOAuth(new Request(`${ISSUER}${path}`, init), config))!;
  const authorize = async (redirect = REDIRECT) =>
    call(
      `/authorize?response_type=code&client_id=${encodeURIComponent(DOC_URL)}&redirect_uri=${encodeURIComponent(redirect)}` +
        `&code_challenge=${await sha256Base64url(VERIFIER)}&code_challenge_method=S256&state=s&resource=${encodeURIComponent(RESOURCE)}`,
    );

  it("advertises support beside registration", async () => {
    const meta = (await (await call("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(meta.client_id_metadata_document_supported).toBe(true);
    expect(meta.registration_endpoint).toBe(`${ISSUER}/register`);
  });

  it("names the publisher and the return host, then completes authorize, callback and token", async () => {
    const chooser = await authorize();
    const page = await chooser.text();
    expect(chooser.status).toBe(200);
    expect(page).toContain("<strong>Example App</strong>");
    expect(page).toContain("Published by <strong>app.example.com</strong>");
    expect(page).toContain("returns you to <strong>app.example.com</strong>");

    const req = decodeURIComponent(/href="\/authorize\/github\?req=([^"]+)"/.exec(page)![1]);
    const callback = await call(`/callback/github?code=upstream&state=${encodeURIComponent(req)}`);
    const target = new URL(callback.headers.get("location")!);
    expect(target.origin + target.pathname).toBe(REDIRECT);
    expect(target.searchParams.get("iss")).toBe(ISSUER);

    const token = await call("/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: target.searchParams.get("code")!,
        client_id: DOC_URL,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
        resource: RESOURCE,
      }).toString(),
    });
    expect(token.status).toBe(200);
    expect(((await token.json()) as Record<string, unknown>).access_token).toEqual(expect.any(String));
  });

  it("warns when sign-in returns to this computer", async () => {
    served = doc({ redirect_uris: ["http://127.0.0.1:3000/callback"] });
    const page = await (await authorize("http://127.0.0.1:3000/callback")).text();
    expect(page).toContain("returns you to <strong>an application on this computer</strong>");
    expect(page).toContain("Continue only if you just started connecting Bellman");
  });

  it("shows an error page, and redirects nowhere, for a redirect the document does not list or a bad document", async () => {
    const unlisted = await authorize("https://evil.example.com/cb");
    expect(unlisted.status).toBe(400);
    expect(unlisted.headers.get("location")).toBeNull();

    config.cimdCache = new CimdCache();
    served = doc({ client_id: "https://other.example.com/c.json" });
    const wrong = await authorize();
    expect(wrong.status).toBe(400);
    expect(wrong.headers.get("location")).toBeNull();
    expect(await wrong.text()).toContain("client_id is not its own URL");
  });

  it("escapes a document's name, which is the client's own claim", async () => {
    served = doc({ client_name: "<img src=x onerror=alert(1)>" });
    const page = await (await authorize()).text();
    expect(page).not.toContain("<img src=x");
    expect(page).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});
