import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleOAuth, type OAuthConfig } from "../src/oauth/routes.js";
import {
  CLIENT_CAP,
  MemoryAuthStore,
  REGISTRATIONS_PER_HOUR,
  REGISTRATION_WINDOW_MS,
  UNUSED_CLIENT_TTL_MS,
} from "../src/oauth/storage.js";

/**
 * Registration is the first unauthenticated write Bellman has: DCR is how
 * Claude Desktop and claude.ai get a client id with no human in the loop, so
 * the endpoint cannot ask for a credential. What it can do is refuse to grow
 * without bound. Nothing here is about access — a registered client still
 * needs a human to sign in — it is about storage, and about not letting an
 * attacker who fills the table lock out a real client.
 */

const ISSUER = "https://mcp.example.test";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const IP = "203.0.113.7";

let config: OAuthConfig;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-15T12:00:00Z"));
  config = {
    issuer: ISSUER,
    resource: `${ISSUER}/mcp`,
    secret: "test-signing-secret",
    store: new MemoryAuthStore(),
    credentials: { github: { clientId: "gh-id", clientSecret: "gh-secret" } },
    overrides: {},
  };
});

afterEach(() => {
  vi.useRealTimers();
});

const register = async (ip: string | null = IP, redirects = [REDIRECT]) =>
  (await handleOAuth(
    new Request(`${ISSUER}/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(ip ? { "cf-connecting-ip": ip } : {}),
      },
      body: JSON.stringify({ client_name: "Test", redirect_uris: redirects }),
    }),
    config
  ))!;

const registerMany = async (n: number, ip: string | null = IP) => {
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) statuses.push((await register(ip)).status);
  return statuses;
};

describe("per-IP rate limit", () => {
  it("still registers a client normally", async () => {
    const res = await register();

    expect(res.status).toBe(201);
    expect(((await res.json()) as { client_id: string }).client_id).toMatch(/\S/);
  });

  it("refuses more than the hourly allowance from one IP", async () => {
    const statuses = await registerMany(REGISTRATIONS_PER_HOUR + 1);

    expect(statuses.slice(0, REGISTRATIONS_PER_HOUR)).not.toContain(429);
    expect(statuses.at(-1)).toBe(429);
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
    const { client_id } = (await (await register()).json()) as { client_id: string };
    expect(await config.store.getClient(client_id)).toBeDefined();

    vi.advanceTimersByTime(UNUSED_CLIENT_TTL_MS + 1);

    expect(await config.store.getClient(client_id)).toBeUndefined();
  });

  it("keeps a client a token was issued for", async () => {
    const { client_id } = (await (await register()).json()) as { client_id: string };

    await config.store.markClientUsed(client_id);
    vi.advanceTimersByTime(UNUSED_CLIENT_TTL_MS * 10);

    expect(await config.store.getClient(client_id)).toBeDefined();
  });

  it("purgeExpiredClients reports what it removed and is idempotent", async () => {
    await register();
    await register("203.0.113.8");
    vi.advanceTimersByTime(UNUSED_CLIENT_TTL_MS + 1);

    expect(await config.store.purgeExpiredClients(Date.now())).toBe(2);
    expect(await config.store.purgeExpiredClients(Date.now())).toBe(0);
    expect(await config.store.countClients()).toBe(0);
  });
});

describe("the client cap", () => {
  /** Fill the table directly, so one IP's allowance is not the thing being tested. */
  const fill = async (n: number) => {
    for (let i = 0; i < n; i++) {
      await config.store.registerClient({
        client_id: `c_${i}`,
        redirect_uris: [REDIRECT],
        created_at: Date.now(),
        expires_at: Date.now() + UNUSED_CLIENT_TTL_MS,
      });
    }
  };

  it("refuses to register when the cap is full of clients in use", async () => {
    await fill(CLIENT_CAP);
    for (let i = 0; i < CLIENT_CAP; i++) await config.store.markClientUsed(`c_${i}`);

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
    expect(await config.store.countClients()).toBe(1);
  });

  it("does not evict a client still inside its TTL", async () => {
    await fill(CLIENT_CAP);

    expect((await register()).status).toBe(429);
    expect(await config.store.countClients()).toBe(CLIENT_CAP);
  });
});
