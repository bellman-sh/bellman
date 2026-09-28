import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleOAuth, type OAuthConfig } from "../src/oauth/routes.js";
import {
  CLIENT_CAP,
  CLIENT_COUNT_KEY,
  MemoryAuthStore,
  REGISTRATIONS_PER_HOUR,
  REGISTRATION_WINDOW_MS,
  PURGE_BACKOFF_MS,
  UNUSED_CLIENT_TTL_MS,
  clientCount,
  hasLapsed,
  purgeDue,
  sweepPage,
  type CounterStorage,
  type SweepStorage,
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

/** The real flow: authorize, come back from the provider, exchange the code. */
const exchangeFor = async (clientId: string): Promise<Response> => {
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

  return call("/token", {
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
};

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

    expect((await exchangeFor(clientId)).status).toBe(200);
    vi.advanceTimersByTime(UNUSED_CLIENT_TTL_MS * 10);

    expect(await config.store.getClient(clientId)).toBeDefined();
  });

  /**
   * Refresh tokens rotate on every use, so promotion is attempted on every
   * refresh for the life of a session. Once a client is permanent there is
   * nothing left to write, and rewriting the record to the value it already
   * holds costs a read and a write per refresh, forever.
   */
  it("does not rewrite a client that is already permanent", async () => {
    const clientId = await clientIdFrom(await register());
    await exchangeFor(clientId);
    const promoted = await config.store.getClient(clientId);

    vi.advanceTimersByTime(60_000);
    await exchangeFor(clientId);

    expect((await config.store.getClient(clientId))?.used_at).toBe(promoted?.used_at);
  });

  /**
   * Promotion has to happen with the refresh token, not before it. A store that
   * fails mid-issuance returns 503 and gives the authorization code back, so
   * nobody got a token — but a client promoted ahead of that write would hold a
   * permanent slot against the cap for a registration that never worked.
   */
  it("leaves the client disposable when issuing the refresh token fails", async () => {
    const clientId = await clientIdFrom(await register());
    const store = config.store;
    const realPut = store.putRefresh.bind(store);
    store.putRefresh = () => Promise.reject(new Error("auth store unreachable"));

    expect((await exchangeFor(clientId)).status).toBe(503);

    store.putRefresh = realPut;
    vi.advanceTimersByTime(UNUSED_CLIENT_TTL_MS + 1);

    expect(await store.getClient(clientId)).toBeUndefined();
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

/**
 * The counter is newer than the data it counts. The deployed object already
 * holds client registrations from before it existed, so the interesting case is
 * a first read against a populated store — tested here through the same adapter
 * the Durable Object supplies, because the DO itself cannot be imported by this
 * test program.
 */
describe("the client counter on a deploy that already has clients", () => {
  const PREFIX = "client:";
  const PAGE = 200;

  const fakeStorage = (keys: string[]) => {
    const kv = new Map<string, unknown>(keys.map((k) => [k, { client_id: k }]));
    let listCalls = 0;
    const storage: CounterStorage = {
      get: async <T>(key: string) => kv.get(key) as T | undefined,
      put: async <T>(key: string, value: T) => void kv.set(key, value),
      listKeys: async (prefix, startAfter, limit) => {
        listCalls++;
        return [...kv.keys()]
          .filter((k) => k.startsWith(prefix) && (startAfter === undefined || k > startAfter))
          .sort()
          .slice(0, limit);
      },
    };
    return { storage, kv, calls: () => listCalls };
  };

  const clientKeys = (n: number) =>
    Array.from({ length: n }, (_, i) => `${PREFIX}c${String(i).padStart(6, "0")}`);

  /**
   * Reading an absent counter as zero would raise the effective cap by however
   * many registrations are already stored.
   */
  it("seeds from the existing keys rather than starting at zero", async () => {
    const { storage } = fakeStorage(clientKeys(37));

    expect(await clientCount(storage, PREFIX, PAGE)).toBe(37);
  });

  it("pages through more keys than one listing returns", async () => {
    const { storage, calls } = fakeStorage(clientKeys(PAGE * 2 + 13));

    expect(await clientCount(storage, PREFIX, PAGE)).toBe(PAGE * 2 + 13);
    expect(calls()).toBeGreaterThan(2);
  });

  it("persists the seeded count, so the scan happens once", async () => {
    const { storage, kv, calls } = fakeStorage(clientKeys(5));

    await clientCount(storage, PREFIX, PAGE);
    const afterSeed = calls();
    expect(kv.get(CLIENT_COUNT_KEY)).toBe(5);

    expect(await clientCount(storage, PREFIX, PAGE)).toBe(5);
    expect(calls()).toBe(afterSeed);
  });

  it("uses a counter that is already there, including a legitimate zero", async () => {
    const { storage, calls } = fakeStorage(clientKeys(9));
    await storage.put(CLIENT_COUNT_KEY, 0);

    expect(await clientCount(storage, PREFIX, PAGE)).toBe(0);
    expect(calls()).toBe(0);
  });

  it("counts nothing on a genuinely empty object", async () => {
    const { storage } = fakeStorage([]);

    expect(await clientCount(storage, PREFIX, PAGE)).toBe(0);
  });
});

/**
 * Records written before `expires_at` existed carry neither it nor `used_at`, so
 * there is no way to tell an abandoned registration from one a live connector
 * depends on. They are grandfathered as permanent deliberately — deleting a
 * working client is worse than holding a slot — and the rule is one predicate so
 * reads and sweeps cannot disagree about it.
 */
describe("registrations written before the TTL field existed", () => {
  const legacy = {
    client_id: "c_legacy",
    redirect_uris: [REDIRECT],
    created_at: 0,
  } as unknown as Parameters<MemoryAuthStore["registerClient"]>[0];

  it("only a number can lapse", () => {
    expect(hasLapsed({ expires_at: 1_000 }, 1_001)).toBe(true);
    expect(hasLapsed({ expires_at: 1_000 }, 1_000)).toBe(false);
    expect(hasLapsed({ expires_at: null }, Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(hasLapsed({ expires_at: undefined } as never, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it("keeps serving a legacy client instead of quietly dropping it", async () => {
    await config.store.registerClient(legacy);
    vi.advanceTimersByTime(UNUSED_CLIENT_TTL_MS * 100);

    expect(await config.store.getClient("c_legacy")).toBeDefined();
  });

  it("does not sweep a legacy client away", async () => {
    await config.store.registerClient(legacy);
    vi.advanceTimersByTime(UNUSED_CLIENT_TTL_MS * 100);

    expect(await config.store.purgeStale(Date.now())).toMatchObject({ clients: 0 });
    expect(await config.store.countClients()).toBe(1);
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

/**
 * Refusing for a full registry happens before any per-IP state is written, so
 * that path is not covered by the 20/hour limit. Writing a timestamp for every
 * refused attempt would fix the accounting and reintroduce the leak just closed:
 * one bucket per attacking address, created on demand. So refusal stays free of
 * per-IP writes, and is made cheap instead — the repeated work was a fruitless
 * purge scan per request.
 */
describe("a full registry refuses cheaply", () => {
  const fillUsed = async (n: number) => {
    for (let i = 0; i < n; i++) {
      await config.store.registerClient({
        client_id: `c_${i}`,
        redirect_uris: [REDIRECT],
        created_at: Date.now(),
        expires_at: null,
      });
    }
  };

  it("refuses without charging the address for it", async () => {
    await fillUsed(CLIENT_CAP);

    expect((await register()).status).toBe(429);
    expect(await config.store.countRecentRegistrations(IP, 0)).toBe(0);
  });

  it("keeps refusing, and still writes no per-IP state", async () => {
    await fillUsed(CLIENT_CAP);

    const statuses = await registerMany(REGISTRATIONS_PER_HOUR + 10);

    expect(new Set(statuses)).toEqual(new Set([429]));
    expect(await config.store.countRegistrationBuckets()).toBe(0);
  });

  /**
   * Once room frees up the same address is served normally: the refusals did
   * not silently consume its allowance.
   */
  it("serves the address normally once there is room again", async () => {
    await fillUsed(CLIENT_CAP);
    expect((await register()).status).toBe(429);

    await config.store.purgeStale(Date.now());
    for (let i = 0; i < 10; i++) await config.store.markClientUsed(`c_${i}`);
    await config.store.registerClient({
      client_id: "c_0", redirect_uris: [REDIRECT], created_at: Date.now(),
      expires_at: Date.now() - 1,
    });
    await config.store.purgeStale(Date.now());

    expect((await register()).status).toBe(201);
  });
});

/**
 * A scan that reclaims nothing is the part worth not repeating. Backing off only
 * after an empty pass keeps draining fast while there is junk to drop, and stops
 * scanning once there is not.
 */
describe("purge backoff", () => {
  it("purges when nothing has been tried yet", () => {
    expect(purgeDue(undefined, 1_000)).toBe(true);
  });

  it("holds off until the backoff has elapsed", () => {
    const idleUntil = 1_000 + PURGE_BACKOFF_MS;

    expect(purgeDue(idleUntil, 1_000)).toBe(false);
    expect(purgeDue(idleUntil, idleUntil - 1)).toBe(false);
    expect(purgeDue(idleUntil, idleUntil)).toBe(true);
  });
});

/**
 * A bounded scan with no cursor is not a sweep — it is the same page, forever.
 * Combined with a backoff that trusts "reclaimed nothing", the first page being
 * all live starves everything behind it: a full registry refuses new clients
 * while lapsed ones sit further down the keyspace, and stale rate buckets are
 * never visited at all.
 */
describe("a bounded sweep resumes where it stopped", () => {
  const PREFIX = "k:";
  const CURSOR = "cursor:k";
  const LIMIT = 2;

  const fake = (entries: [string, number][]) => {
    const kv = new Map<string, unknown>(entries);
    const storage: SweepStorage = {
      get: async <T>(key: string) => kv.get(key) as T | undefined,
      put: async <T>(key: string, value: T) => void kv.set(key, value),
      delete: async (key: string) => void kv.delete(key),
      deleteMany: async (keys: string[]) => keys.forEach((k) => kv.delete(k)),
      listEntries: async <T>(prefix: string, startAfter: string | undefined, limit: number) =>
        [...kv.entries()]
          .filter(([k]) => k.startsWith(prefix) && (startAfter === undefined || k > startAfter))
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .slice(0, limit) as [string, T][],
      lastKey: async (prefix: string) =>
        [...kv.keys()].filter((k) => k.startsWith(prefix)).sort().pop(),
    };
    return { storage, kv };
  };

  /** Stale when the stored number is 0; 1 is live. */
  const decide = (value: number) => (value === 0 ? { action: "delete" as const } : { action: "keep" as const });

  const sweep = (storage: SweepStorage) =>
    sweepPage<number>(storage, PREFIX, CURSOR, LIMIT, decide);

  it("reaches an expired entry that sorts behind a full page of live ones", async () => {
    const { storage, kv } = fake([
      ["k:a", 1], ["k:b", 1], ["k:c", 1], ["k:d", 1], ["k:e", 0],
    ]);

    // Three passes of two: the stale entry is only on the third page.
    const first = await sweep(storage);
    expect(first).toMatchObject({ reclaimed: 0, wrapped: false });
    expect(kv.has("k:e")).toBe(true);

    await sweep(storage);
    const third = await sweep(storage);

    expect(third.reclaimed).toBe(1);
    expect(kv.has("k:e")).toBe(false);
  });

  it("only reports wrapped once it has seen the end of the keyspace", async () => {
    const { storage } = fake([["k:a", 1], ["k:b", 1], ["k:c", 1]]);

    expect(await sweep(storage)).toMatchObject({ wrapped: false });
    // Page two is short, so this pass finished the traversal.
    expect(await sweep(storage)).toMatchObject({ wrapped: true });
  });

  /**
   * A cursor alone does not bound a traversal while new keys can land after it.
   * Accepted registrations add rate buckets under attacker-chosen addresses, so
   * without an end fixed at the start each pass reads the fresh keys, advances
   * by the influx, and never comes back for the stale ones behind the cursor.
   */
  it("is not chased by keys inserted after it starts", async () => {
    const { storage, kv } = fake([["k:a", 1], ["k:b", 1], ["k:c", 1], ["k:d", 1]]);

    expect(await sweep(storage)).toMatchObject({ wrapped: false });
    kv.set("k:z0", 1);
    kv.set("k:z1", 1);

    // The traversal ends where it did when it began, at k:d.
    expect(await sweep(storage)).toMatchObject({ wrapped: true });
  });

  it("comes back for a key that went stale behind the cursor", async () => {
    const { storage, kv } = fake([["k:a", 1], ["k:b", 1], ["k:c", 1], ["k:d", 1]]);

    await sweep(storage);
    kv.set("k:a", 0);
    kv.set("k:z0", 1);
    await sweep(storage);

    expect((await sweep(storage)).reclaimed).toBe(1);
    expect(kv.has("k:a")).toBe(false);
  });

  /**
   * A key count that is an exact multiple of the page size has a full final
   * page, so page size alone never reveals the end. Reaching the traversal's end
   * key does. Without that, `wrapped` stayed false forever — and CLIENT_CAP over
   * PURGE_BATCH is exactly 10,000 over 200.
   */
  it("completes when the key count is an exact multiple of the page size", async () => {
    const { storage } = fake([["k:a", 1], ["k:b", 1], ["k:c", 1], ["k:d", 1]]);

    expect(await sweep(storage)).toMatchObject({ wrapped: false });

    expect(await sweep(storage)).toMatchObject({ reclaimed: 0, wrapped: true });
  });

  /** Completion clears the state, so the pass after it starts from the front. */
  it("starts over on the pass after it completes", async () => {
    const { storage, kv } = fake([["k:a", 1], ["k:b", 1]]);

    // Two keys, page size two: this pass reaches the end key and completes.
    expect(await sweep(storage)).toMatchObject({ wrapped: true });
    kv.set("k:a", 0);

    expect((await sweep(storage)).reclaimed).toBe(1);
  });

  it("clears its state on completion, so nothing is skipped next time round", async () => {
    const { storage, kv } = fake([["k:a", 1], ["k:b", 1], ["k:c", 1]]);

    await sweep(storage);
    expect(kv.get(CURSOR)).toMatchObject({ cursor: "k:b", end: "k:c" });
    await sweep(storage);

    expect(kv.get(CURSOR)).toBeUndefined();
  });

  it("rewrites an entry a decider asks to keep in changed form", async () => {
    const { storage, kv } = fake([["k:a", 5]]);

    await sweepPage<number>(storage, PREFIX, CURSOR, LIMIT, (value) =>
      value === 5 ? { action: "rewrite", value: 9 } : { action: "keep" }
    );

    expect(kv.get("k:a")).toBe(9);
  });

  it("counts nothing and wraps on an empty keyspace", async () => {
    const { storage } = fake([]);

    expect(await sweep(storage)).toMatchObject({ reclaimed: 0, wrapped: true });
  });
});
