/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from "cloudflare:workers";
import {
  REGISTRATION_WINDOW_MS,
  type AuthCode, type AuthStorage, type RefreshToken, type RegisteredClient,
} from "./storage.js";
import { BillingLedger, type BillingStorage, type PaidPlan } from "../billing/ledger.js";
import type { SubscriptionSource } from "../billing/subscription.js";

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
const CLIENT = "client:";
const REG = "reg:";

export class AuthDO extends DurableObject {
  /**
   * What Stripe says each customer is paying for. The logic is BillingLedger,
   * shared with the in-memory store; this object only supplies the storage.
   *
   * The input gate is not enough on its own here: a sync awaits a fetch to
   * Stripe and other calls run meanwhile, so the ledger queues every write per
   * customer and per user itself.
   */
  private ledger = new BillingLedger({
    get: <T>(key: string) => this.ctx.storage.get<T>(key),
    put: <T>(key: string, value: T) => this.ctx.storage.put(key, value),
  });

  linkCustomer(customerId: string, userId: string): Promise<boolean> {
    return this.ledger.linkCustomer(customerId, userId);
  }

  /**
   * The Stripe read happens here, inside the one object, because that is the
   * only place the ledger's per-subscription queue can serialize it. A read
   * made in the Worker could be overtaken by another Worker's.
   */
  syncSubscription(customerId: string, subscriptionId: string, source: SubscriptionSource): Promise<void> {
    return this.ledger.syncSubscription(customerId, subscriptionId, source);
  }

  userForCustomer(customerId: string): Promise<string | undefined> {
    return this.ledger.userForCustomer(customerId);
  }

  paidPlan(userId: string): Promise<PaidPlan | undefined> {
    return this.ledger.paidPlan(userId);
  }

  async registerClient(client: RegisteredClient): Promise<void> {
    await this.ctx.storage.put(`${CLIENT}${client.client_id}`, client);
  }

  async getClient(clientId: string): Promise<RegisteredClient | undefined> {
    const client = await this.ctx.storage.get<RegisteredClient>(`${CLIENT}${clientId}`);
    if (!client) return undefined;
    // Checked on read as well as purged in bulk, so a lapsed registration is
    // never usable just because no purge has run yet.
    if (client.expires_at !== null && Date.now() > client.expires_at) return undefined;
    return client;
  }

  /** A token was issued for this client, so it stops being disposable. */
  async markClientUsed(clientId: string): Promise<void> {
    const key = `${CLIENT}${clientId}`;
    const client = await this.ctx.storage.get<RegisteredClient>(key);
    if (!client) return;
    await this.ctx.storage.put(key, { ...client, expires_at: null, used_at: Date.now() });
  }

  async purgeExpiredClients(now: number): Promise<number> {
    const entries = await this.ctx.storage.list<RegisteredClient>({ prefix: CLIENT });
    let removed = 0;
    for (const [key, client] of entries) {
      if (client.expires_at !== null && now > client.expires_at) {
        await this.ctx.storage.delete(key);
        removed++;
      }
    }
    return removed;
  }

  async countClients(): Promise<number> {
    return (await this.ctx.storage.list({ prefix: CLIENT })).size;
  }

  async countRecentRegistrations(ip: string, since: number): Promise<number> {
    const stamps = (await this.ctx.storage.get<number[]>(`${REG}${ip}`)) ?? [];
    return stamps.filter((at) => at >= since).length;
  }

  async recordRegistration(ip: string): Promise<void> {
    const key = `${REG}${ip}`;
    const stamps = (await this.ctx.storage.get<number[]>(key)) ?? [];
    // Pruned on write, or this key grows for as long as the address keeps
    // registering — the same reason RegistryDO.recordCreate trims on write.
    const recent = stamps.filter((at) => at >= Date.now() - REGISTRATION_WINDOW_MS);
    recent.push(Date.now());
    await this.ctx.storage.put(key, recent);
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
export class AuthStore implements AuthStorage, BillingStorage {
  constructor(private namespace: DurableObjectNamespace<AuthDO>) {}

  linkCustomer(customerId: string, userId: string): Promise<boolean> {
    return this.object.linkCustomer(customerId, userId);
  }

  syncSubscription(customerId: string, subscriptionId: string, source: SubscriptionSource): Promise<void> {
    return this.object.syncSubscription(customerId, subscriptionId, source);
  }

  userForCustomer(customerId: string): Promise<string | undefined> {
    return this.object.userForCustomer(customerId);
  }

  paidPlan(userId: string): Promise<PaidPlan | undefined> {
    return this.object.paidPlan(userId);
  }

  private get object() {
    return this.namespace.get(this.namespace.idFromName("auth"));
  }

  registerClient(client: RegisteredClient): Promise<void> {
    return this.object.registerClient(client);
  }
  getClient(clientId: string): Promise<RegisteredClient | undefined> {
    return this.object.getClient(clientId);
  }
  markClientUsed(clientId: string): Promise<void> {
    return this.object.markClientUsed(clientId);
  }
  purgeExpiredClients(now: number): Promise<number> {
    return this.object.purgeExpiredClients(now);
  }
  countClients(): Promise<number> {
    return this.object.countClients();
  }
  countRecentRegistrations(ip: string, since: number): Promise<number> {
    return this.object.countRecentRegistrations(ip, since);
  }
  recordRegistration(ip: string): Promise<void> {
    return this.object.recordRegistration(ip);
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
