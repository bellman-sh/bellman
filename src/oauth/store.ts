/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from "cloudflare:workers";
import type { AuthCode, AuthStorage, RefreshToken, RegisteredClient } from "./storage.js";

/**
 * Durable Object storage for the authorization server: registered clients,
 * authorization codes, and refresh tokens. One object, because all three are
 * small, global, and read on a path where a wrong answer is a security bug
 * rather than a slow page.
 *
 * Access tokens are absent on purpose — they are signed, not stored. The shapes
 * and the in-memory implementation live in storage.ts, which stays importable
 * from plain Node.
 */

const CODE = "code:";
const REFRESH = "refresh:";

export class AuthDO extends DurableObject {
  async registerClient(client: RegisteredClient): Promise<void> {
    await this.ctx.storage.put(`client:${client.client_id}`, client);
  }

  async getClient(clientId: string): Promise<RegisteredClient | undefined> {
    return this.ctx.storage.get<RegisteredClient>(`client:${clientId}`);
  }

  async putCode(code: string, value: AuthCode): Promise<void> {
    await this.ctx.storage.put(`${CODE}${code}`, value);
    await this.purge(CODE);
  }

  /** Single use: a replayed authorization code finds nothing. */
  async takeCode(code: string): Promise<AuthCode | undefined> {
    const key = `${CODE}${code}`;
    const value = await this.ctx.storage.get<AuthCode>(key);
    if (!value) return undefined;
    await this.ctx.storage.delete(key);
    return Date.now() > value.expires_at ? undefined : value;
  }

  async putRefresh(token: string, value: RefreshToken): Promise<void> {
    await this.ctx.storage.put(`${REFRESH}${token}`, value);
    await this.purge(REFRESH);
  }

  /** Single use as well: refresh tokens rotate, so using one retires it. */
  async takeRefresh(token: string): Promise<RefreshToken | undefined> {
    const key = `${REFRESH}${token}`;
    const value = await this.ctx.storage.get<RefreshToken>(key);
    if (!value) return undefined;
    await this.ctx.storage.delete(key);
    return Date.now() > value.expires_at ? undefined : value;
  }

  /** Codes and refresh tokens that were never redeemed would otherwise pile up. */
  private async purge(prefix: string): Promise<void> {
    const now = Date.now();
    const entries = await this.ctx.storage.list<{ expires_at: number }>({ prefix, limit: 200 });
    for (const [key, value] of entries) {
      if (value.expires_at < now) await this.ctx.storage.delete(key);
    }
  }
}

/** What the routes use — a thin facade over the single AuthDO instance. */
export class AuthStore implements AuthStorage {
  constructor(private namespace: DurableObjectNamespace<AuthDO>) {}

  private get object() {
    return this.namespace.get(this.namespace.idFromName("auth"));
  }

  registerClient(client: RegisteredClient): Promise<void> {
    return this.object.registerClient(client);
  }
  getClient(clientId: string): Promise<RegisteredClient | undefined> {
    return this.object.getClient(clientId);
  }
  putCode(code: string, value: AuthCode): Promise<void> {
    return this.object.putCode(code, value);
  }
  takeCode(code: string): Promise<AuthCode | undefined> {
    return this.object.takeCode(code);
  }
  putRefresh(token: string, value: RefreshToken): Promise<void> {
    return this.object.putRefresh(token, value);
  }
  takeRefresh(token: string): Promise<RefreshToken | undefined> {
    return this.object.takeRefresh(token);
  }
}

export type { AuthCode, AuthStorage, RefreshToken, RegisteredClient } from "./storage.js";
