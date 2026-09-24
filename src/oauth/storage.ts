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
  expires_at: number;
}

export interface RefreshToken {
  client_id: string;
  resource: string;
  identity: Identity;
  expires_at: number;
}

export interface AuthStorage {
  registerClient(client: RegisteredClient): Promise<void>;
  /** Undefined for an unknown client, and for one whose registration lapsed. */
  getClient(clientId: string): Promise<RegisteredClient | undefined>;
  /** A token was issued for this client, so it stops being disposable. */
  markClientUsed(clientId: string): Promise<void>;
  /** Drops lapsed registrations. Returns how many went, for the caller's cap check. */
  purgeExpiredClients(now: number): Promise<number>;
  countClients(): Promise<number>;
  countRecentRegistrations(ip: string, since: number): Promise<number>;
  recordRegistration(ip: string): Promise<void>;
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

  async markClientUsed(clientId: string): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) return;
    this.clients.set(clientId, { ...client, expires_at: null, used_at: Date.now() });
  }

  async purgeExpiredClients(now: number): Promise<number> {
    let removed = 0;
    for (const [id, client] of this.clients) {
      if (client.expires_at !== null && now > client.expires_at) {
        this.clients.delete(id);
        removed++;
      }
    }
    return removed;
  }

  async countClients(): Promise<number> {
    return this.clients.size;
  }

  async countRecentRegistrations(ip: string, since: number): Promise<number> {
    return (this.registrations.get(ip) ?? []).filter((at) => at >= since).length;
  }

  async recordRegistration(ip: string): Promise<void> {
    const recent = (this.registrations.get(ip) ?? []).filter(
      (at) => at >= Date.now() - REGISTRATION_WINDOW_MS
    );
    recent.push(Date.now());
    this.registrations.set(ip, recent);
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
