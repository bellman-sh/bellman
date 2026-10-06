/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from "cloudflare:workers";
import {
  CLIENT_CAP, CLIENT_COUNT_KEY, PURGE_BACKOFF_MS, PURGE_IDLE_KEY,
  REGISTRATIONS_PER_HOUR, REGISTRATION_WINDOW_MS,
  clientCount, hasLapsed, purgeDue, sessionDead, sweepPage, touchDue,
  type Admission, type AuthCode, type AuthStorage, type CounterStorage,
  type PanelSession, type Reclaimed, type RefreshToken, type RegisteredClient,
  type SweepStorage,
} from "./storage.js";
import { BillingLedger, type BillingStorage, type PaidPlan } from "../billing/ledger.js";
import { reconcilePurchase, type PurchaseGrantStore } from "../billing/grants.js";
import type { SubscriptionSource } from "../billing/subscription.js";
import type { BellmanEnv } from "../store-do.js";
import type { Identity } from "../types.js";

/**
 * Durable Object storage for the authorization server: registered clients,
 * authorization codes, refresh tokens, and browser sessions. One object, because
 * all four are small, global, and read on a path where a wrong answer is a
 * security bug rather than a slow page.
 *
 * Access tokens are absent on purpose — they are signed, not stored. Browser
 * sessions are stored for the opposite reason: sign-out has to be able to delete
 * one. The shapes and the in-memory implementation live in storage.ts, which
 * stays importable from plain Node.
 */

const CODE = "code:";
const REFRESH = "refresh:";
const CLIENT = "client:";
const REG = "reg:";
const SESSION = "sess:";
const COUNT = CLIENT_COUNT_KEY;
/** Where each bounded sweep stopped, so the next pass does not re-read page one. */
const CLIENT_CURSOR_KEY = "clients:cursor";
const REG_CURSOR_KEY = "regs:cursor";
/** How much stale data one registration is willing to clear. */
const PURGE_BATCH = 200;

/**
 * What a method reads and writes through: the object's own storage, or the transaction it
 * is inside. The helpers a transaction calls take this and have no default for it, as
 * SessionDO's `nextCursor(txn)` takes the transaction, so that what runs inside a
 * transaction can be read off the code and a caller has to say which it means.
 */
type Rows = Pick<DurableObjectTransaction, "get" | "put" | "delete" | "list">;

/**
 * The counter's storage, as an adapter so the counting logic itself stays in
 * storage.ts and runs under plain Node in tests — the same split BillingLedger
 * uses.
 */
const counterOver = (rows: Rows): CounterStorage => ({
  get: <T>(key: string) => rows.get<T>(key),
  put: <T>(key: string, value: T) => rows.put(key, value),
  listKeys: async (prefix, startAfter, limit) => [
    ...(await rows.list({ prefix, limit, ...(startAfter ? { startAfter } : {}) })).keys(),
  ],
});

/** The same split, for the cursored sweeps: logic in storage.ts, storage here. */
const sweepOver = (rows: Rows): SweepStorage => ({
  get: <T>(key: string) => rows.get<T>(key),
  put: <T>(key: string, value: T) => rows.put(key, value),
  delete: async (key: string) => void (await rows.delete(key)),
  deleteMany: async (keys: string[]) => void (await rows.delete(keys)),
  listEntries: async <T>(prefix: string, startAfter: string | undefined, limit: number) => [
    ...(await rows.list<T>({ prefix, limit, ...(startAfter ? { startAfter } : {}) })).entries(),
  ],
  lastKey: async (prefix: string) =>
    [...(await rows.list({ prefix, reverse: true, limit: 1 })).keys()][0],
});

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
    await this.#insertClient(this.ctx.storage, client);
  }

  /**
   * registerClient's body, over the handle its caller reads and writes through, so that
   * admitRegistration can run it inside its transaction.
   */
  async #insertClient(rows: Rows, client: RegisteredClient): Promise<void> {
    const key = `${CLIENT}${client.client_id}`;
    const existed = (await rows.get(key)) !== undefined;
    // Counted before the key is written, and used for the new count rather than read again
    // (#122). An object that has not counted yet seeds its counter by listing the client
    // keys, so a read after the put lists this client too and the one added for it makes
    // two. The wrong number is stored, and a stored counter is never recounted, so the
    // object stays one ahead and closes registration a client early for good.
    //
    // The key and that count go in one put. As two writes, an interruption between them
    // stored the client and not its count, and the object stayed one behind for good, which
    // opens the cap late: the direction purgeStale closes below. A key that already exists
    // changes no count, so it is written alone.
    const before = existed ? undefined : await this.#clientCount(rows);
    if (before === undefined) await rows.put(key, client);
    else await rows.put({ [key]: client, [COUNT]: before + 1 });
  }

  /**
   * One RPC and one transaction, and everything it awaits is storage. The window check, the
   * purge, the cap check and the insert are a single unit, so no concurrent registration can
   * pass the same check before this one writes.
   *
   * That is what the input gate gave it before, implicitly: it holds other events off while
   * a storage operation is outstanding, so a read and then a put is atomic as long as every
   * await between them is storage, and nothing in the code said so. (A method that awaited
   * the network would not get that — see the ledger comment above.) The transaction says it,
   * and it keeps holding if a later edit puts an await on anything else in between (a fetch,
   * a timer), the one case the gate does not cover. That is a net under a mistake and not a
   * licence for one: the closure holds every other call to this object until it commits
   * (docs/ARCHITECTURE.md section 9, runtime fact 2), and this object also answers every
   * token and every browser session, so what goes inside it is storage and nothing slower.
   * worker-tests/auth-race.test.ts holds a call at exactly that point.
   *
   * Every read and write inside goes through `txn`, as SessionDO's transactions do, and
   * #insertClient, #purgeStale and #clientCount take the handle they work through so that
   * it does.
   *
   * Not every method here has been converted. takeCode, takeRefresh, markClientUsed,
   * putRefresh, registerClient and purgeStale still read and then write. They are
   * unconverted, not exempt: the input gate covers them in production, since every await
   * between their read and their write is storage, and the transaction is the stronger
   * form. registerClient and purgeStale have no production caller: /register goes through
   * admitRegistration, which runs their bodies as #insertClient and #purgeStale inside its
   * own transaction. They are public because `AuthStorage` declares them.
   */
  async admitRegistration(
    client: RegisteredClient,
    ip: string | null,
    now: number
  ): Promise<Admission> {
    return this.ctx.storage.transaction<Admission>(async (txn) => {
      const bucket = ip ? `${REG}${ip}` : undefined;
      const inWindow = async (key: string) =>
        ((await txn.get<number[]>(key)) ?? []).filter(
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
      if ((await this.#clientCount(txn)) >= CLIENT_CAP) {
        const idleUntil = await txn.get<number>(PURGE_IDLE_KEY);
        if (purgeDue(idleUntil, now)) {
          const { clients, buckets, complete } = await this.#purgeStale(txn, now);
          // Backing off on any empty pass would starve whatever sits behind the
          // current page. Only a pass that reached the end of the keyspace has
          // actually established there is nothing to reclaim.
          if (complete && clients + buckets === 0) {
            await txn.put(PURGE_IDLE_KEY, now + PURGE_BACKOFF_MS);
          }
          // That sweep may have pruned or dropped this address's bucket, so the
          // read taken before it is no longer what is stored.
          if (bucket) recent = await inWindow(bucket);
        }
        if ((await this.#clientCount(txn)) >= CLIENT_CAP) return "full";
      }

      await this.#insertClient(txn, client);
      if (bucket) await txn.put(bucket, [...recent, now]);
      return "ok";
    });
  }

  /**
   * Counted once and then maintained, because Durable Object storage has no
   * count API and the alternative is list()ing up to CLIENT_CAP entries on
   * every registration. Every insert and delete goes through #insertClient or
   * #purgeStale, which are the only two places this moves. Both read it before they touch
   * a key, because the seed lists the keys: read after, it would count the change itself
   * (#122). #insertClient writes it with the key in one put, and #purgeStale hands it to
   * #bumpCount, which has to follow its sweep.
   *
   * This and the methods beside it that write, #insertClient, #bumpCount, #purgeStale,
   * #purge and #purgeSessions, are `#private`. A Durable Object answers RPC for every
   * method on its class, and TypeScript's `private` is erased at compile time, so
   * `private` would leave all of them answering. Nothing outside this class calls them, so
   * none of them has a reason to.
   *
   * That is the whole of it: less surface, not a protected counter. `registerClient`,
   * `markClientUsed` and `purgeStale` are public because `AuthStorage` declares them, and
   * over a stub `purgeStale(now + 48h)` sweeps a registration that has not lapsed while
   * `registerClient` moves the counter. Anyone who could reach the private ones could
   * already reach those. This one only seeds the counter from the keys that are there, and
   * is private because it belongs to the same group, not because the seed needs guarding.
   */
  #clientCount(rows: Rows): Promise<number> {
    return clientCount(counterOver(rows), CLIENT, PURGE_BATCH);
  }

  /**
   * Store the count as `before` plus `by`, where `before` is what #clientCount said BEFORE
   * the keys changed. It is a parameter and not a read here because this runs after the
   * change, and a read then seeds an uncounted object from keys that already show it: the
   * change is counted twice, a registration too high and a purge too low (#122). Taking
   * the number makes the order something a caller has to state, where a read inside would
   * be right in every case but the first.
   */
  async #bumpCount(rows: Rows, by: number, before: number): Promise<void> {
    await rows.put(COUNT, Math.max(0, before + by));
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
    return this.#purgeStale(this.ctx.storage, now);
  }

  /**
   * purgeStale over the handle its caller reads and writes through, so that admitRegistration
   * can sweep inside its transaction.
   */
  async #purgeStale(rows: Rows, now: number): Promise<Reclaimed> {
    // Counted before the sweep deletes anything, for registerClient's reason from the other
    // side (#122). An object that has not counted yet seeds from the keys that are left,
    // which already leave out what this pass deletes, and taking those off again stores a
    // count too low. That is the direction that matters: the cap opens late.
    //
    // This seeds the counter on every call, where it used to wait for a pass that reclaimed
    // something. That costs the production path nothing: admitRegistration reads the count
    // before it purges, so the key is already there and this is one single-key read. Only a
    // direct purgeStale on an uncounted object pays for the seed, and it is the one that
    // needed it.
    const before = await this.#clientCount(rows);
    const clients = await sweepPage<RegisteredClient>(
      sweepOver(rows), CLIENT, CLIENT_CURSOR_KEY, PURGE_BATCH,
      (c) => (hasLapsed(c, now) ? { action: "delete" } : { action: "keep" })
    );
    if (clients.reclaimed > 0) await this.#bumpCount(rows, -clients.reclaimed, before);

    const buckets = await sweepPage<number[]>(
      sweepOver(rows), REG, REG_CURSOR_KEY, PURGE_BATCH,
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
    if (clients.reclaimed + buckets.reclaimed > 0) await rows.delete(PURGE_IDLE_KEY);

    return {
      clients: clients.reclaimed,
      buckets: buckets.reclaimed,
      // Only a pass that reached the end of both keyspaces licenses a backoff.
      complete: clients.wrapped && buckets.wrapped,
    };
  }

  async countClients(): Promise<number> {
    return this.#clientCount(this.ctx.storage);
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

  async putSession(id: string, value: PanelSession): Promise<void> {
    // Cleanup first, like putRefresh: the sweep lists, writes a cursor and
    // deletes, so it can fail, and a failure after the write would reject this
    // call with the session already stored and no cookie handed out.
    await this.#purgeSessions();
    await this.ctx.storage.put(`${SESSION}${id}`, value);
  }

  /**
   * One RPC and one transaction, so a concurrent request for the same session cannot read
   * the pre-touch value and write over this one. Splitting it into a get and a put from the
   * Worker is the window this exists to close, the same way admitRegistration does.
   *
   * It awaits nothing but storage, which is why the input gate covered it before the
   * transaction did, for the reason admitRegistration gives. The transaction holds if that
   * stops being true.
   */
  async touchSession(id: string, now: number): Promise<PanelSession | undefined> {
    const key = `${SESSION}${id}`;
    return this.ctx.storage.transaction<PanelSession | undefined>(async (txn) => {
      const stored = await txn.get<PanelSession>(key);
      if (!stored) return undefined;
      if (sessionDead(stored, now)) {
        // Dropped here rather than left to the sweep, so a dead session is
        // terminal the moment it is first read as dead.
        await txn.delete(key);
        return undefined;
      }
      // After the dead check and never before it: touchDue says only whether the
      // stored time is stale, so asked first it would serve a session that is past
      // its ceiling. See touchDue and MemoryAuthStore.touchSession.
      if (!touchDue(stored, now)) return stored;
      const touched: PanelSession = { ...stored, last_used_at: now };
      await txn.put(key, touched);
      return touched;
    });
  }

  /**
   * One RPC and one transaction, for the reason touchSession is. The read and the write
   * are a single unit, so a sign-out cannot land between them and be written over, and
   * another request's touch cannot land between them and be reverted. It awaits nothing but
   * storage, which is what let the input gate cover it before, as it did touchSession.
   *
   * It writes its three fields onto the record as it is stored now, and onto
   * nothing when there is none, and says which it did. The caller read its copy
   * before the plan was resolved, which can be a while ago, and putting that copy
   * back with putSession would recreate a session that was signed out in the
   * meantime.
   */
  async replanSession(
    id: string,
    identity: Identity,
    planSource: string,
    now: number
  ): Promise<boolean> {
    const key = `${SESSION}${id}`;
    return this.ctx.storage.transaction<boolean>(async (txn) => {
      const stored = await txn.get<PanelSession>(key);
      if (!stored) return false;
      // Typed, as touchSession's record is, so that a field written under the
      // wrong name fails typecheck:worker instead of being stored as an extra one.
      const replanned: PanelSession = {
        ...stored, identity, plan_source: planSource, replanned_at: now,
      };
      await txn.put(key, replanned);
      return true;
    });
  }

  async deleteSession(id: string): Promise<void> {
    await this.ctx.storage.delete(`${SESSION}${id}`);
  }

  /**
   * Sessions that were abandoned rather than signed out of.
   *
   * Its own sweep rather than #purge, because #purge decides on expires_at and
   * a session can die of idleness with its ceiling still ahead — so reusing it
   * would leave idle sessions stored for up to the full seven days.
   *
   * `#private`; see #clientCount.
   */
  async #purgeSessions(): Promise<void> {
    const now = Date.now();
    await sweepPage<PanelSession>(
      // The cursor lives outside the prefix, as #purge's does.
      sweepOver(this.ctx.storage), SESSION, `cursor:${SESSION}`, PURGE_BATCH,
      (value) => (sessionDead(value, now) ? { action: "delete" } : { action: "keep" })
    );
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
      sweepOver(this.ctx.storage), prefix, `cursor:${prefix}`, PURGE_BATCH,
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
  putSession(id: string, value: PanelSession): Promise<void> {
    return this.object.putSession(id, value);
  }
  touchSession(id: string, now: number): Promise<PanelSession | undefined> {
    return this.object.touchSession(id, now);
  }
  replanSession(id: string, identity: Identity, planSource: string, now: number): Promise<boolean> {
    return this.object.replanSession(id, identity, planSource, now);
  }
  deleteSession(id: string): Promise<void> {
    return this.object.deleteSession(id);
  }
}

export type {
  AuthCode, AuthStorage, PanelSession, RefreshToken, RegisteredClient,
} from "./storage.js";
