/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from "cloudflare:workers";
import {
  CLIENT_CAP, CLIENT_COUNT_KEY, PURGE_BACKOFF_MS, PURGE_IDLE_KEY,
  REGISTRATIONS_PER_HOUR, REGISTRATION_WINDOW_MS, clientCount, hasLapsed, purgeDue, sweepPage,
  type Admission, type AuthCode, type AuthStorage, type CounterStorage, type Reclaimed,
  type RefreshToken, type RegisteredClient, type SweepStorage,
} from "./storage.js";
import { BillingLedger, type BillingStorage, type PaidPlan } from "../billing/ledger.js";
import { reconcilePurchase, type PurchaseGrantStore } from "../billing/grants.js";
import type { SubscriptionSource } from "../billing/subscription.js";
import type { BellmanEnv } from "../store-do.js";

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
const COUNT = CLIENT_COUNT_KEY;
/** Where each bounded sweep stopped, so the next pass does not re-read page one. */
const CLIENT_CURSOR_KEY = "clients:cursor";
const REG_CURSOR_KEY = "regs:cursor";
/** How much stale data one registration is willing to clear. */
const PURGE_BATCH = 200;

export class AuthDO extends DurableObject<BellmanEnv> {
  /**
   * What Stripe says each customer is paying for. The logic is BillingLedger,
   * shared with the in-memory store; this object only supplies the storage.
   *
   * The input gate is not enough on its own here: a sync awaits a fetch to
   * Stripe and other calls run meanwhile, so the ledger queues every write per
   * customer and per user itself. A reconcile awaits the registry the same way,
   * which is why it runs in the user's queue (see reconcile).
   */
  private ledger = new BillingLedger({
    get: <T>(key: string) => this.ctx.storage.get<T>(key),
    put: <T>(key: string, value: T) => this.ctx.storage.put(key, value),
  });

  /**
   * The grant store, reached from inside this object rather than the Worker.
   *
   * `#`, not `private`: every method and getter on a Durable Object answers
   * over RPC, and TypeScript's `private` does nothing about that. This one would
   * hand a caller a stub for the registry.
   */
  get #grants(): PurchaseGrantStore {
    return this.env.REGISTRY.get(this.env.REGISTRY.idFromName("registry"));
  }

  linkCustomer(customerId: string, userId: string): Promise<boolean> {
    return this.ledger.linkCustomer(customerId, userId);
  }

  /**
   * Make the stored grant match what this user is currently paying for, with
   * the whole decision inside the user's queue.
   *
   * It has to run here rather than in the Worker: the queue is in memory inside
   * this object and the grant lives in RegistryDO, so holding it across two
   * RPCs from outside is not something the Worker can do. The object that owns
   * the serialisation performs the whole operation and calls the other itself.
   *
   * Lock ordering stays acyclic — linkCustomer takes customer then user, this
   * takes user only, and nothing in RegistryDO calls back into this object.
   */
  reconcile(userId: string): ReturnType<typeof reconcilePurchase> {
    return this.ledger.serializeUser(userId, () =>
      reconcilePurchase(userId, this.ledger, this.#grants)
    );
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
    const key = `${CLIENT}${client.client_id}`;
    const existed = (await this.ctx.storage.get(key)) !== undefined;
    await this.ctx.storage.put(key, client);
    if (!existed) await this.#bumpCount(1);
  }

  /**
   * One RPC, and it awaits nothing but storage. That is what makes it atomic:
   * the input gate holds other events off for the duration, so no concurrent
   * registration can pass the same check before this one writes. (A method that
   * awaited the network would not get that — see the ledger comment above.)
   */
  async admitRegistration(
    client: RegisteredClient,
    ip: string | null,
    now: number
  ): Promise<Admission> {
    const bucket = ip ? `${REG}${ip}` : undefined;
    const inWindow = async (key: string) =>
      ((await this.ctx.storage.get<number[]>(key)) ?? []).filter(
        (at) => at >= now - REGISTRATION_WINDOW_MS
      );

    let recent: number[] = [];
    if (bucket) {
      recent = await inWindow(bucket);
      if (recent.length >= REGISTRATIONS_PER_HOUR) return "rate_limited";
    }

    // Evict before testing the cap, or anyone who fills the table with clients
    // they never signed in with blocks every real client until the next purge.
    //
    // Only when the cap is in the way, and only when the last scan found
    // something. A full registry is refused without writing per-IP state, so it
    // can be retried without limit — what has to stay bounded is the work each
    // retry costs, which was a scan per request.
    if ((await this.#clientCount()) >= CLIENT_CAP) {
      const idleUntil = await this.ctx.storage.get<number>(PURGE_IDLE_KEY);
      if (purgeDue(idleUntil, now)) {
        const { clients, buckets, complete } = await this.purgeStale(now);
        // Backing off on any empty pass would starve whatever sits behind the
        // current page. Only a pass that reached the end of the keyspace has
        // actually established there is nothing to reclaim.
        if (complete && clients + buckets === 0) {
          await this.ctx.storage.put(PURGE_IDLE_KEY, now + PURGE_BACKOFF_MS);
        }
        // That sweep may have pruned or dropped this address's bucket, so the
        // read taken before it is no longer what is stored.
        if (bucket) recent = await inWindow(bucket);
      }
      if ((await this.#clientCount()) >= CLIENT_CAP) return "full";
    }

    await this.registerClient(client);
    if (bucket) await this.ctx.storage.put(bucket, [...recent, now]);
    return "ok";
  }

  /**
   * The counter's storage, as an adapter so the counting logic itself stays in
   * storage.ts and runs under plain Node in tests — the same split BillingLedger
   * uses above.
   */
  /** The same split, for the cursored sweeps: logic in storage.ts, storage here. */
  private sweepStorage: SweepStorage = {
    get: <T>(key: string) => this.ctx.storage.get<T>(key),
    put: <T>(key: string, value: T) => this.ctx.storage.put(key, value),
    delete: async (key: string) => void (await this.ctx.storage.delete(key)),
    deleteMany: async (keys: string[]) => void (await this.ctx.storage.delete(keys)),
    listEntries: async <T>(prefix: string, startAfter: string | undefined, limit: number) => [
      ...(
        await this.ctx.storage.list<T>({ prefix, limit, ...(startAfter ? { startAfter } : {}) })
      ).entries(),
    ],
    lastKey: async (prefix: string) =>
      [...(await this.ctx.storage.list({ prefix, reverse: true, limit: 1 })).keys()][0],
  };

  private counterStorage: CounterStorage = {
    get: <T>(key: string) => this.ctx.storage.get<T>(key),
    put: <T>(key: string, value: T) => this.ctx.storage.put(key, value),
    listKeys: async (prefix, startAfter, limit) => [
      ...(
        await this.ctx.storage.list({ prefix, limit, ...(startAfter ? { startAfter } : {}) })
      ).keys(),
    ],
  };

  /**
   * Counted once and then maintained, because Durable Object storage has no
   * count API and the alternative is list()ing up to CLIENT_CAP entries on
   * every registration. Every insert and delete goes through registerClient or
   * purgeStale, which are the only two places this moves.
   *
   * This and the two below that write, #bumpCount and #purge, are `#private`. A Durable
   * Object answers RPC for every method on its class, and TypeScript's `private` is erased
   * at compile time. #bumpCount writes any count it is handed and #purge deletes whatever
   * has lapsed under any prefix, so a caller that could reach them could shut every client
   * out of registering or lift the cap. This one writes only to seed the counter from the
   * keys that are there, but it is the same group.
   */
  #clientCount(): Promise<number> {
    return clientCount(this.counterStorage, CLIENT, PURGE_BATCH);
  }

  async #bumpCount(by: number): Promise<void> {
    await this.ctx.storage.put(COUNT, Math.max(0, (await this.#clientCount()) + by));
  }

  async getClient(clientId: string): Promise<RegisteredClient | undefined> {
    const client = await this.ctx.storage.get<RegisteredClient>(`${CLIENT}${clientId}`);
    if (!client) return undefined;
    // Checked on read as well as purged in bulk, so a lapsed registration is
    // never usable just because no purge has run yet.
    if (hasLapsed(client, Date.now())) return undefined;
    return client;
  }

  /** A token was issued for this client, so it stops being disposable. */
  async markClientUsed(clientId: string): Promise<void> {
    const key = `${CLIENT}${clientId}`;
    const client = await this.ctx.storage.get<RegisteredClient>(key);
    // Already permanent: refresh tokens rotate on every use, so this is asked on
    // every refresh for the life of a session, and rewriting the record to the
    // value it already holds costs a write each time for nothing.
    if (!client || client.expires_at === null) return;
    await this.ctx.storage.put(key, { ...client, expires_at: null, used_at: Date.now() });
  }

  /**
   * Bounded and batched, because this runs on the registration path. An
   * unbounded sweep with one delete per key means a caller waits on up to
   * CLIENT_CAP sequential round-trips; PURGE_BATCH at a time still frees room
   * to admit, and the existing code/refresh purge below bounds itself the same
   * way for the same reason.
   */
  async purgeStale(now: number): Promise<Reclaimed> {
    const clients = await sweepPage<RegisteredClient>(
      this.sweepStorage, CLIENT, CLIENT_CURSOR_KEY, PURGE_BATCH,
      (c) => (hasLapsed(c, now) ? { action: "delete" } : { action: "keep" })
    );
    if (clients.reclaimed > 0) await this.#bumpCount(-clients.reclaimed);

    const buckets = await sweepPage<number[]>(
      this.sweepStorage, REG, REG_CURSOR_KEY, PURGE_BATCH,
      (stamps) => {
        const recent = stamps.filter((at) => at >= now - REGISTRATION_WINDOW_MS);
        // An empty bucket is deleted, not stored empty: otherwise one key per
        // source address survives forever and rotating addresses grow storage
        // without bound.
        if (recent.length === 0) return { action: "delete" };
        return recent.length === stamps.length ? { action: "keep" } : { action: "rewrite", value: recent };
      }
    );

    // Freeing something un-sticks admission immediately, rather than leaving it
    // waiting out a backoff that is no longer true.
    if (clients.reclaimed + buckets.reclaimed > 0) await this.ctx.storage.delete(PURGE_IDLE_KEY);

    return {
      clients: clients.reclaimed,
      buckets: buckets.reclaimed,
      // Only a pass that reached the end of both keyspaces licenses a backoff.
      complete: clients.wrapped && buckets.wrapped,
    };
  }

  async countClients(): Promise<number> {
    return this.#clientCount();
  }

  async countRegistrationBuckets(): Promise<number> {
    return (await this.ctx.storage.list({ prefix: REG })).size;
  }

  async countRecentRegistrations(ip: string, since: number): Promise<number> {
    const stamps = (await this.ctx.storage.get<number[]>(`${REG}${ip}`)) ?? [];
    return stamps.filter((at) => at >= since).length;
  }

  async putCode(code: string, value: AuthCode): Promise<void> {
    await this.ctx.storage.put(`${CODE}${code}`, value);
    await this.#purge(CODE);
  }

  /** Single use: a replayed authorization code finds nothing. */
  async takeCode(code: string): Promise<AuthCode | undefined> {
    const key = `${CODE}${code}`;
    const value = await this.ctx.storage.get<AuthCode>(key);
    if (!value) return undefined;
    await this.ctx.storage.delete(key);
    return Date.now() > value.expires_at ? undefined : value;
  }

  /**
   * One RPC, so the token and the promotion land together. Issuing a token is
   * what makes a registration permanent; doing it in the caller ahead of this
   * write would leave a client holding a cap slot forever whenever this failed
   * and nobody got a token.
   */
  async putRefresh(token: string, value: RefreshToken): Promise<void> {
    // Cleanup first, deliberately. It lists, writes a cursor and deletes, so it
    // can fail — and anything fallible after the promotion would reject this
    // call with the client already permanent, which is the failure the ordering
    // exists to prevent. Promotion goes last: if it is what fails, the token
    // still works and the registration merely lapses, which is recoverable by
    // registering again. The reverse is not.
    await this.#purge(REFRESH);
    await this.ctx.storage.put(`${REFRESH}${token}`, value);
    await this.markClientUsed(value.client_id);
  }

  /** Single use as well: refresh tokens rotate, so using one retires it. */
  async takeRefresh(token: string): Promise<RefreshToken | undefined> {
    const key = `${REFRESH}${token}`;
    const value = await this.ctx.storage.get<RefreshToken>(key);
    if (!value) return undefined;
    await this.ctx.storage.delete(key);
    return Date.now() > value.expires_at ? undefined : value;
  }

  /**
   * Codes and refresh tokens that were never redeemed would otherwise pile up.
   *
   * Cursored for the same reason the client sweep is: a bounded listing with no
   * cursor re-reads page one forever, and anything expired behind a full page
   * of live entries is never reached. Refresh tokens live 30 days, so that page
   * is not hypothetical.
   *
   * `#private`; see #clientCount.
   */
  async #purge(prefix: string): Promise<void> {
    const now = Date.now();
    await sweepPage<{ expires_at: number }>(
      // The cursor must live outside the prefix it tracks, or the sweep lists
      // its own cursor as an entry and can set the cursor to itself.
      this.sweepStorage, prefix, `cursor:${prefix}`, PURGE_BATCH,
      (value) => (value.expires_at < now ? { action: "delete" } : { action: "keep" })
    );
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

  reconcile(userId: string): ReturnType<typeof reconcilePurchase> {
    return this.object.reconcile(userId);
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
  admitRegistration(client: RegisteredClient, ip: string | null, now: number): Promise<Admission> {
    return this.object.admitRegistration(client, ip, now);
  }
  purgeStale(now: number): Promise<Reclaimed> {
    return this.object.purgeStale(now);
  }
  countClients(): Promise<number> {
    return this.object.countClients();
  }
  countRegistrationBuckets(): Promise<number> {
    return this.object.countRegistrationBuckets();
  }
  countRecentRegistrations(ip: string, since: number): Promise<number> {
    return this.object.countRecentRegistrations(ip, since);
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
