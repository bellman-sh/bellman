import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleOAuth, type OAuthConfig } from "../src/oauth/routes.js";
import {
  CLIENT_CAP,
  MemoryAuthStore,
  REGISTRATIONS_PER_HOUR,
  REGISTRATION_WINDOW_MS,
  UNUSED_CLIENT_TTL_MS,
} from "../src/oauth/storage.js";
import { sha256Base64url } from "../src/oauth/tokens.js";

/**
 * Registration is the first unauthenticated write Bellman has: DCR is how
 * Claude Desktop and claude.ai get a client id with no human in the loop, so
 * the endpoint cannot ask for a credential. What it can do is refuse to grow
 * without bound. Nothing here is about access — a registered client still
 * needs a human to sign in — it is about storage, and about not letting an
 * attacker who fills the table lock out a real client.
 */

const ISSUER = "https://mcp.example.test";
const RESOURCE = `${ISSUER}/mcp`;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const IP = "203.0.113.7";
const VERIFIER = "v".repeat(64);

const fakeFetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.startsWith("https://github.com/login/oauth/access_token")) {
    return Response.json({ access_token: "gh_upstream_token" });
  }
  if (url === "https://api.github.com/user") {
    return Response.json({ id: 4242, login: "mcfearsome", email: "jesse@example.dev" });
  }
  return new Response("unexpected upstream call", { status: 500 });
}) as typeof fetch;

let config: OAuthConfig;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-15T12:00:00Z"));
  config = {
    issuer: ISSUER,
    resource: RESOURCE,
    secret: "test-signing-secret",
    store: new MemoryAuthStore(),
    credentials: { github: { clientId: "gh-id", clientSecret: "gh-secret" } },
    overrides: {},
    fetchImpl: fakeFetch,
  };
});

afterEach(() => {
  vi.useRealTimers();
});

const call = async (path: string, init?: RequestInit) =>
  (await handleOAuth(new Request(`${ISSUER}${path}`, init), config))!;

const register = (ip: string | null = IP, redirects = [REDIRECT]) =>
  call("/register", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(ip ? { "cf-connecting-ip": ip } : {}),
    },
    body: JSON.stringify({ client_name: "Test", redirect_uris: redirects }),
  });

const registerMany = async (n: number, ip: string | null = IP) => {
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) statuses.push((await register(ip)).status);
  return statuses;
};

const clientIdFrom = async (res: Response) =>
  ((await res.json()) as { client_id: string }).client_id;

describe("per-IP rate limit", () => {
  it("still registers a client normally", async () => {
    const res = await register();

    expect(res.status).toBe(201);
    expect(await clientIdFrom(res)).toMatch(/\S/);
  });

  it("refuses more than the hourly allowance from one IP", async () => {
    const statuses = await registerMany(REGISTRATIONS_PER_HOUR + 1);

    expect(statuses.slice(0, REGISTRATIONS_PER_HOUR)).not.toContain(429);
    expect(statuses.at(-1)).toBe(429);
  });

  /**
   * The check and the write have to be one operation. Separate calls let every
   * request in a burst read the same count below the limit and then all write,
   * so the advertised bound would only hold when requests arrive one at a time.
   */
  it("holds the bound when a burst arrives at once", async () => {
    const burst = await Promise.all(
      Array.from({ length: REGISTRATIONS_PER_HOUR + 15 }, () => register())
    );

    expect(burst.filter((r) => r.status === 201)).toHaveLength(REGISTRATIONS_PER_HOUR);
    expect(await config.store.countRecentRegistrations(IP, 0)).toBe(REGISTRATIONS_PER_HOUR);
  });

  it("counts each IP separately", async () => {
    await registerMany(REGISTRATIONS_PER_HOUR);

    expect((await register(IP)).status).toBe(429);
    expect((await register("203.0.113.8")).status).toBe(201);
  });

  it("lets the same IP back in once the window has passed", async () => {
    await registerMany(REGISTRATIONS_PER_HOUR);
    expect((await register()).status).toBe(429);

    vi.advanceTimersByTime(REGISTRATION_WINDOW_MS + 1);

    expect((await register()).status).toBe(201);
  });

  /**
   * The Node server is local development only and sits behind no proxy that
   * sets the header. Inventing a key would put every local client in one
   * bucket and rate-limit a developer against themself.
   */
  it("does not rate limit when no client IP is known", async () => {
    const statuses = await registerMany(REGISTRATIONS_PER_HOUR + 5, null);

    expect(statuses).not.toContain(429);
  });

  it("rejects a bad redirect_uri before spending any allowance", async () => {
    expect((await register(IP, ["http://evil.example.com/cb"])).status).toBe(400);

    expect(await config.store.countRecentRegistrations(IP, 0)).toBe(0);
  });
});

describe("unused registrations expire", () => {
  it("forgets a client that never completed a flow", async () => {
    const clientId = await clientIdFrom(await register());
    expect(await config.store.getClient(clientId)).toBeDefined();

    vi.advanceTimersByTime(UNUSED_CLIENT_TTL_MS + 1);

    expect(await config.store.getClient(clientId)).toBeUndefined();
  });

  /**
   * Drives the real authorization code flow rather than calling the store
   * primitive, because the thing worth protecting is the wiring: issuing a
   * token is what promotes a registration. Poking markClientUsed directly
   * would still pass if that call were deleted from issueTokens.
   */
  it("keeps a client once a token has actually been issued for it", async () => {
    const clientId = await clientIdFrom(await register());
    const challenge = await sha256Base64url(VERIFIER);

    const chooser = await call(
      `/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}` +
        `&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(RESOURCE)}`
    );
    const req = decodeURIComponent(
      /href="\/authorize\/github\?req=([^"]+)"/.exec(await chooser.text())![1]
    );
    const callback = await call(`/callback/github?code=upstream-code&state=${encodeURIComponent(req)}`);
    const code = new URL(callback.headers.get("location")!).searchParams.get("code")!;

    const token = await call("/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
        resource: RESOURCE,
      }).toString(),
    });
    expect(token.status).toBe(200);

    vi.advanceTimersByTime(UNUSED_CLIENT_TTL_MS * 10);

    expect(await config.store.getClient(clientId)).toBeDefined();
  });

  it("purgeStale reports what it reclaimed and is idempotent", async () => {
    await register();
    await register("203.0.113.8");
    vi.advanceTimersByTime(UNUSED_CLIENT_TTL_MS + 1);

    expect(await config.store.purgeStale(Date.now())).toMatchObject({ clients: 2 });
    expect(await config.store.purgeStale(Date.now())).toMatchObject({ clients: 0 });
    expect(await config.store.countClients()).toBe(0);
  });

  /**
   * Pruning a bucket's timestamps never reclaimed the bucket itself, so one key
   * per source address survived forever — unbounded growth from rotating
   * addresses, which is the exact failure this change exists to prevent.
   */
  it("reclaims a per-IP bucket once its window is empty", async () => {
    await register("203.0.113.9");
    expect(await config.store.countRegistrationBuckets()).toBe(1);

    vi.advanceTimersByTime(REGISTRATION_WINDOW_MS + 1);

    expect(await config.store.purgeStale(Date.now())).toMatchObject({ buckets: 1 });
    expect(await config.store.countRegistrationBuckets()).toBe(0);
  });

  it("leaves a bucket alone while it still has timestamps in the window", async () => {
    await register();

    expect(await config.store.purgeStale(Date.now())).toMatchObject({ buckets: 0 });
    expect(await config.store.countRegistrationBuckets()).toBe(1);
  });
});

describe("the client cap", () => {
  /** Insert directly: the cap, not one IP's allowance, is what is under test. */
  const fill = async (n: number, used = false) => {
    for (let i = 0; i < n; i++) {
      await config.store.registerClient({
        client_id: `c_${i}`,
        redirect_uris: [REDIRECT],
        created_at: Date.now(),
        expires_at: used ? null : Date.now() + UNUSED_CLIENT_TTL_MS,
      });
    }
  };

  it("refuses to register when the cap is full of clients in use", async () => {
    await fill(CLIENT_CAP, true);

    expect((await register()).status).toBe(429);
  });

  /**
   * The point of evicting first: an attacker who fills the table with junk they
   * never signed in with must not be able to block a real client.
   */
  it("evicts expired junk and admits a real client anyway", async () => {
    await fill(CLIENT_CAP);
    vi.advanceTimersByTime(UNUSED_CLIENT_TTL_MS + 1);

    expect((await register()).status).toBe(201);
    expect(await config.store.countClients()).toBeLessThan(CLIENT_CAP);
  });

  it("does not evict a client still inside its TTL", async () => {
    await fill(CLIENT_CAP);

    expect((await register()).status).toBe(429);
    expect(await config.store.countClients()).toBe(CLIENT_CAP);
  });

  /** The same check-then-act race as the rate limit, against the cap. */
  it("does not overflow the cap when a burst arrives at once", async () => {
    await fill(CLIENT_CAP - 5, true);

    await Promise.all(Array.from({ length: 15 }, (_, i) => register(`198.51.100.${i}`)));

    expect(await config.store.countClients()).toBeLessThanOrEqual(CLIENT_CAP);
  });
});
