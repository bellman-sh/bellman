import type { Identity } from "../types.js";

/**
 * The authorization server's storage shape, kept free of any Workers import so
 * it can run under plain Node in tests. The Durable Object implementation lives
 * in store.ts, which is the half that cannot.
 */

export interface RegisteredClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  created_at: number;
}

export interface AuthCode {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  identity: Identity;
  /**
   * True when the identity is an operator grant (BELLMAN_USERS), false when it
   * is the default a signed-in human gets. Only the default is re-resolved
   * against billing when tokens are issued; a grant is left alone. Absent on
   * records written before billing existed, which are left alone too.
   */
  granted?: boolean;
  expires_at: number;
}

export interface RefreshToken {
  client_id: string;
  resource: string;
  identity: Identity;
  /** See AuthCode.granted. */
  granted?: boolean;
  expires_at: number;
}

export interface AuthStorage {
  registerClient(client: RegisteredClient): Promise<void>;
  getClient(clientId: string): Promise<RegisteredClient | undefined>;
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

  async registerClient(client: RegisteredClient): Promise<void> {
    this.clients.set(client.client_id, client);
  }

  async getClient(clientId: string): Promise<RegisteredClient | undefined> {
    return this.clients.get(clientId);
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
