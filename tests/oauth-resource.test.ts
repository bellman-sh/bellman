import { beforeEach, describe, expect, it } from "vitest";
import { handleOAuth, identityFromAccessToken, type OAuthConfig } from "../src/oauth/routes.js";
import { MemoryAuthStore } from "../src/oauth/storage.js";
import { MemoryStore } from "../src/store.js";
import { base64urlDecode, sha256Base64url } from "../src/oauth/tokens.js";

/**
 * /a2a is its own protected resource beside /mcp (ADR 0033): a token is minted for the one the client names, and
 * each resource's metadata names itself. The refusal of one resource's token at the other is tested through the
 * real handlers in worker-tests/a2a.test.ts.
 */

const ISSUER = "https://mcp.example.test";
const MCP = `${ISSUER}/mcp`;
const A2A = `${ISSUER}/a2a`;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(64);

const fakeFetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.startsWith("https://github.com/login/oauth/access_token")) return Response.json({ access_token: "gh_upstream_token" });
  if (url === "https://api.github.com/user") return Response.json({ id: 4242, login: "mcfearsome", email: null });
  if (url === "https://api.github.com/user/emails") {
    return Response.json([{ email: "jesse@example.dev", primary: true, verified: true }]);
  }
  return new Response("unexpected upstream call", { status: 500 });
}) as typeof fetch;

let config: OAuthConfig;

beforeEach(() => {
  config = {
    issuer: ISSUER,
    resource: MCP,
    resources: [MCP, A2A],
    secret: "test-signing-secret",
    store: new MemoryAuthStore(),
    credentials: { github: { clientId: "gh-id", clientSecret: "gh-secret" } },
    overrides: {},
    plans: new MemoryStore(),
    fetchImpl: fakeFetch,
  };
});

const call = async (path: string, init?: RequestInit) => (await handleOAuth(new Request(`${ISSUER}${path}`, init), config))!;
const token = (form: Record<string, string>) =>
  call("/token", { method: "POST", body: new URLSearchParams(form).toString() });
const audOf = (jwt: string) => (JSON.parse(new TextDecoder().decode(base64urlDecode(jwt.split(".")[1]))) as { aud: string }).aud;
const errorOf = (res: Response) => new URL(res.headers.get("location")!).searchParams.get("error");

async function registerClient(): Promise<string> {
  const res = await call("/register", { method: "POST", body: JSON.stringify({ client_name: "Agent", redirect_uris: [REDIRECT] }) });
  return ((await res.json()) as { client_id: string }).client_id;
}

const authorizeUrl = async (clientId: string, resource?: string) =>
  `/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}` +
  `&code_challenge=${await sha256Base64url(VERIFIER)}&code_challenge_method=S256&state=st` +
  (resource === undefined ? "" : `&resource=${encodeURIComponent(resource)}`);

/** authorize → GitHub → callback → /token, for the resource named at /authorize (and at /token, when given). */
async function signIn(resource: string | undefined, atToken: string | undefined = resource) {
  const clientId = await registerClient();
  const chooser = await call(await authorizeUrl(clientId, resource));
  const req = decodeURIComponent(/href="\/authorize\/github\?req=([^"]+)"/.exec(await chooser.text())![1]);
  const callback = await call(`/callback/github?code=upstream-code&state=${encodeURIComponent(req)}`);
  const code = new URL(callback.headers.get("location")!).searchParams.get("code")!;
  const res = await token({
    grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: VERIFIER,
    ...(atToken === undefined ? {} : { resource: atToken }),
  });
  return { clientId, res, body: (await res.json()) as Record<string, string> };
}

const refresh = async (clientId: string, refreshToken: string, resource?: string) => {
  const res = await token({
    grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, ...(resource ? { resource } : {}),
  });
  return { res, body: (await res.json()) as Record<string, string> };
};

describe("/a2a as an OAuth resource", () => {
  it("authorize with resource …/a2a issues a token whose aud is …/a2a", async () => {
    const { res, body } = await signIn(A2A);
    expect(res.status).toBe(200);
    expect(audOf(body.access_token)).toBe(A2A);
    expect((await identityFromAccessToken(body.access_token, config, A2A))?.userId).toBe("u_github_4242");
    expect(await identityFromAccessToken(body.access_token, config)).toBeNull();
  });

  it("a resource is compared in canonical form, and naming none still means /mcp", async () => {
    expect(audOf((await signIn("https://MCP.example.test/a2a/#x")).body.access_token)).toBe(A2A);
    expect(audOf((await signIn(undefined)).body.access_token)).toBe(MCP);
    expect(audOf((await signIn(MCP)).body.access_token)).toBe(MCP);
  });

  it("an unknown resource is still invalid_target", async () => {
    const clientId = await registerClient();
    for (const resource of [`${ISSUER}/other`, "https://other.example/a2a", `${ISSUER}/a2a/x`]) {
      expect(errorOf(await call(await authorizeUrl(clientId, resource)))).toBe("invalid_target");
    }
    // At /token, a resource other than the one authorized is refused, the other known one included.
    const { res, body } = await signIn(A2A, MCP);
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_target");
  });

  it("a refresh keeps the audience it was granted", async () => {
    const { clientId, body } = await signIn(A2A);
    const kept = await refresh(clientId, body.refresh_token);
    expect(audOf(kept.body.access_token)).toBe(A2A);
    const named = await refresh(clientId, kept.body.refresh_token, `${A2A}/`);
    expect(audOf(named.body.access_token)).toBe(A2A);
  });

  it("a refresh that names another resource is invalid_target, and the refresh token survives it", async () => {
    const { clientId, body } = await signIn(A2A);
    const switched = await refresh(clientId, body.refresh_token, MCP);
    expect(switched.res.status).toBe(400);
    expect(switched.body.error).toBe("invalid_target");
    expect(audOf((await refresh(clientId, body.refresh_token)).body.access_token)).toBe(A2A);

    const mcp = await signIn(MCP);
    expect((await refresh(mcp.clientId, mcp.body.refresh_token, A2A)).body.error).toBe("invalid_target");
  });
});

describe("protected-resource metadata", () => {
  const resourceAt = async (path: string) =>
    ((await (await call(`/.well-known/oauth-protected-resource${path}`)).json()) as { resource: string }).resource;

  it("protected-resource metadata for /a2a names the /a2a resource", async () => {
    expect(await resourceAt("/a2a")).toBe(A2A);
    expect(await resourceAt("/a2a/")).toBe(A2A);
  });

  it("the bare path still names /mcp", async () => {
    expect(await resourceAt("")).toBe(MCP);
    expect(await resourceAt("/mcp")).toBe(MCP);
    // Only an exact resource path is another resource: anything else under the prefix stays /mcp's, as before.
    for (const path of ["/a2ax", "-a2a", "/a2a/x", "/other"]) expect(await resourceAt(path)).toBe(MCP);
  });
});
