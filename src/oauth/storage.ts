import type { Identity } from "../types.js";

/**
 * The authorization server's storage shape, kept free of any Workers import so
 * it can run under plain Node in tests. The Durable Object implementation lives
 * in store.ts, which is the half that cannot.
 */

/**
 * Registration limits. `/register` is the one unauthenticated write Bellman
 * has — dynamic client registration is how Claude Desktop and claude.ai obtain
 * a client id with no human in the loop, so it cannot ask for a credential.
 * These bound what an anonymous caller can cost us.
 */
export const REGISTRATION_WINDOW_MS = 60 * 60 * 1000;
export const REGISTRATIONS_PER_HOUR = 20;
export const CLIENT_CAP = 10_000;
/** A client nobody ever signed in with is dead weight. */
export const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;

export interface RegisteredClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  created_at: number;
  /**
   * When this registration lapses, or null once it is in use. A client becomes
   * used when a token is issued for it, which takes a completed GitHub or
   * Google sign-in — the one step an attacker cannot automate. Refreshing on
   * getClient would be the natural-looking alternative and is wrong: getClient
   * is called from unauthenticated /authorize, so anyone holding their own junk
   * client ids could keep every one of them alive for free.
   */
  expires_at: number | null;
  used_at?: number;
}

export interface AuthCode {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  identity: Identity;
  /** Where the plan came from: operator override, stored grant, or default. */
  plan_source: string;
  /** Upstream keys this human resolves under, so a refresh can re-check the plan. */
  identity_keys: string[];
  expires_at: number;
}

export interface RefreshToken {
  client_id: string;
  resource: string;
  identity: Identity;
  plan_source: string;
  identity_keys: string[];
  expires_at: number;
}

/** Why a registration was refused, or that it was taken. */
export type Admission = "ok" | "rate_limited" | "full";

/** What a purge reclaimed: lapsed client registrations, and empty rate buckets. */
export interface Reclaimed {
  clients: number;
  buckets: number;
}

export interface AuthStorage {
  /**
   * The unguarded insert. `admitRegistration` is the path that enforces the
   * limits; this one exists because something has to do the writing.
   */
  registerClient(client: RegisteredClient): Promise<void>;
  /**
   * Admit a registration, or say why not — window check, stale purge, cap check
   * and insert as ONE operation.
   *
   * Splitting these across calls is a check-then-act race: every request in a
   * burst reads the same count below the limit, then every one of them writes,
   * and the advertised bound only holds for traffic that arrives single file.
   * Implementations must not yield between the check and the write.
   */
  admitRegistration(client: RegisteredClient, ip: string | null, now: number): Promise<Admission>;
  /** Undefined for an unknown client, and for one whose registration lapsed. */
  getClient(clientId: string): Promise<RegisteredClient | undefined>;
  /** A token was issued for this client, so it stops being disposable. */
  markClientUsed(clientId: string): Promise<void>;
  /**
   * Drop lapsed registrations, and rate buckets with nothing left in their
   * window. Buckets matter: pruning a bucket's timestamps without removing the
   * empty bucket leaves one key per source address forever.
   */
  purgeStale(now: number): Promise<Reclaimed>;
  countClients(): Promise<number>;
  countRegistrationBuckets(): Promise<number>;
  countRecentRegistrations(ip: string, since: number): Promise<number>;
  putCode(code: string, value: AuthCode): Promise<void>;
  /** Single use: a replayed authorization code must find nothing. */
  takeCode(code: string): Promise<AuthCode | undefined>;
  putRefresh(token: string, value: RefreshToken): Promise<void>;
  /** Single use as well — refresh tokens rotate, so using one retires it. */
  takeRefresh(token: string): Promise<RefreshToken | undefined>;
}

/** In-memory implementation, for tests and for the Node server. */
export class MemoryAuthStore implements AuthStorage {
  private clients = new Map<string, RegisteredClient>();
  private codes = new Map<string, AuthCode>();
  private refreshes = new Map<string, RefreshToken>();
  private registrations = new Map<string, number[]>();

  async registerClient(client: RegisteredClient): Promise<void> {
    this.clients.set(client.client_id, client);
  }

  async getClient(clientId: string): Promise<RegisteredClient | undefined> {
    const client = this.clients.get(clientId);
    if (!client) return undefined;
    // Checked on read as well as purged in bulk, so a lapsed client is never
    // usable just because no purge has run yet.
    if (client.expires_at !== null && Date.now() > client.expires_at) return undefined;
    return client;
  }

  /**
   * Entirely synchronous on purpose. An `await` anywhere between the checks and
   * the writes would let a concurrent call interleave and both admit past the
   * limit — the whole point of doing this in one method.
   */
  async admitRegistration(
    client: RegisteredClient,
    ip: string | null,
    now: number
  ): Promise<Admission> {
    const inWindow = (stamps: number[]) => stamps.filter((at) => at >= now - REGISTRATION_WINDOW_MS);

    if (ip && inWindow(this.registrations.get(ip) ?? []).length >= REGISTRATIONS_PER_HOUR) {
      return "rate_limited";
    }
    this.reclaim(now);
    if (this.clients.size >= CLIENT_CAP) return "full";

    this.clients.set(client.client_id, client);
    if (ip) this.registrations.set(ip, [...inWindow(this.registrations.get(ip) ?? []), now]);
    return "ok";
  }

  async markClientUsed(clientId: string): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) return;
    this.clients.set(clientId, { ...client, expires_at: null, used_at: Date.now() });
  }

  async purgeStale(now: number): Promise<Reclaimed> {
    return this.reclaim(now);
  }

  private reclaim(now: number): Reclaimed {
    let clients = 0;
    for (const [id, client] of this.clients) {
      if (client.expires_at !== null && now > client.expires_at) {
        this.clients.delete(id);
        clients++;
      }
    }

    let buckets = 0;
    for (const [ip, stamps] of this.registrations) {
      const recent = stamps.filter((at) => at >= now - REGISTRATION_WINDOW_MS);
      // An empty bucket is deleted, not stored empty: otherwise one key per
      // source address survives forever and rotating addresses grow storage
      // without bound.
      if (recent.length === 0) {
        this.registrations.delete(ip);
        buckets++;
      } else if (recent.length !== stamps.length) {
        this.registrations.set(ip, recent);
      }
    }
    return { clients, buckets };
  }

  async countClients(): Promise<number> {
    return this.clients.size;
  }

  async countRegistrationBuckets(): Promise<number> {
    return this.registrations.size;
  }

  async countRecentRegistrations(ip: string, since: number): Promise<number> {
    return (this.registrations.get(ip) ?? []).filter((at) => at >= since).length;
  }

  async putCode(code: string, value: AuthCode): Promise<void> {
    this.codes.set(code, value);
  }

  async takeCode(code: string): Promise<AuthCode | undefined> {
    const value = this.codes.get(code);
    if (!value) return undefined;
    this.codes.delete(code);
    return Date.now() > value.expires_at ? undefined : value;
  }

  async putRefresh(token: string, value: RefreshToken): Promise<void> {
    this.refreshes.set(token, value);
  }

  async takeRefresh(token: string): Promise<RefreshToken | undefined> {
    const value = this.refreshes.get(token);
    if (!value) return undefined;
    this.refreshes.delete(token);
    return Date.now() > value.expires_at ? undefined : value;
  }
}
