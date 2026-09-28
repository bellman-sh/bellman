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
  expires_at?: number | null;
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

/**
 * Whether a registration has lapsed. Three cases, all deliberate:
 *
 * - a number: lapsed once `now` is past it.
 * - null: a token was issued for it, so it never lapses.
 * - absent: written before this field existed. Grandfathered as permanent,
 *   because a record from then carries no `used_at` either — there is no way to
 *   tell an abandoned registration from one a live connector depends on, and
 *   deleting a working client is worse than holding a slot against the cap.
 *   They become an explicit null the next time a token is issued for them.
 *
 * One predicate so a read and a sweep cannot disagree about any of it.
 */
export function hasLapsed(client: Pick<RegisteredClient, "expires_at">, now: number): boolean {
  return typeof client.expires_at === "number" && now > client.expires_at;
}

export const CLIENT_COUNT_KEY = "clients:count";
export const PURGE_IDLE_KEY = "clients:purgeIdleUntil";

/** How long to stop scanning after a pass that reclaimed nothing. */
export const PURGE_BACKOFF_MS = 60 * 1000;

/**
 * Whether a purge is worth running.
 *
 * Refusing a registration for a full registry writes no per-IP state, so that
 * path sits outside the 20/hour limit and an address can retry it freely. What
 * must not be unbounded is the *work* each retry costs, and that was a purge
 * scan per request. Backing off only after a pass that reclaimed nothing keeps
 * draining at full speed while there is junk to drop and stops scanning once
 * there is none, so the throttle lands on exactly the fruitless case.
 */
export function purgeDue(idleUntil: number | undefined, now: number): boolean {
  return idleUntil === undefined || now >= idleUntil;
}

/** Storage a bounded sweep needs: read, write, delete, and paged listing. */
export interface SweepStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  deleteMany(keys: string[]): Promise<void>;
  /** Entries under `prefix`, after `startAfter` when given, at most `limit`. */
  listEntries<T>(
    prefix: string,
    startAfter: string | undefined,
    limit: number
  ): Promise<[string, T][]>;
  /** The greatest key under `prefix`, or undefined when there are none. */
  lastKey(prefix: string): Promise<string | undefined>;
}

/**
 * Where a traversal has reached, and where it ends.
 *
 * `end` is fixed when the traversal starts. Without it a cursor does not bound
 * anything: keys inserted after the cursor — rate buckets under addresses the
 * caller picks — are read by the next pass, which advances by exactly the
 * influx, so the traversal never returns to what went stale behind it.
 */
export interface SweepState {
  cursor?: string;
  end: string;
}

/** What to do with one entry a sweep looked at. */
export type SweepVerdict<T> =
  | { action: "delete" }
  | { action: "keep" }
  | { action: "rewrite"; value: T };

export interface SweepResult {
  reclaimed: number;
  /** This pass reached the end of the keyspace, so the next one starts over. */
  wrapped: boolean;
}

/**
 * One bounded pass over `prefix`, resuming where the previous pass stopped.
 *
 * The cursor is the whole point. A bounded listing with no cursor re-reads the
 * lexicographically first page every time, so entries sitting behind a full
 * page of live ones are never examined — and a caller that backs off when a
 * pass reclaims nothing then starves them permanently. Only a pass that reaches
 * the end reports `wrapped`, which is the one signal a caller may treat as
 * "there was nothing to find".
 */
export async function sweepPage<T>(
  storage: SweepStorage,
  prefix: string,
  stateKey: string,
  limit: number,
  decide: (value: T, key: string) => SweepVerdict<T>
): Promise<SweepResult> {
  let state = await storage.get<SweepState>(stateKey);
  if (state === undefined) {
    const end = await storage.lastKey(prefix);
    // Nothing under the prefix at all: a complete pass over nothing.
    if (end === undefined) return { reclaimed: 0, wrapped: true };
    state = { end };
  }

  const raw = await storage.listEntries<T>(prefix, state.cursor, limit);
  const page = raw.filter(([key]) => key <= state.end);

  // Past the end, or nothing left after the cursor: this traversal is done.
  // Clear the state so the NEXT call starts a fresh one. Restarting inside this
  // call instead would return a full page and leave `wrapped` false — and when
  // the key count is an exact multiple of the page size, as CLIENT_CAP over
  // PURGE_BATCH is, it would never report completion at all.
  if (page.length === 0) {
    await storage.delete(stateKey);
    return { reclaimed: 0, wrapped: true };
  }

  const doomed: string[] = [];
  for (const [key, value] of page) {
    const verdict = decide(value, key);
    if (verdict.action === "delete") doomed.push(key);
    else if (verdict.action === "rewrite") await storage.put(key, verdict.value);
  }
  if (doomed.length > 0) await storage.deleteMany(doomed);

  const last = page[page.length - 1][0];
  const wrapped = raw.length < limit || page.length < raw.length || last >= state.end;
  if (wrapped) await storage.delete(stateKey);
  else await storage.put<SweepState>(stateKey, { cursor: last, end: state.end });

  return { reclaimed: doomed.length, wrapped };
}

/**
 * The slice of key-value storage the client counter needs. Kept as an adapter
 * so the counting runs under plain Node in tests, the way BillingLedger does
 * for the billing half — the Durable Object supplies its own storage.
 */
export interface CounterStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  /** Keys under `prefix`, after `startAfter` when given, at most `limit` of them. */
  listKeys(prefix: string, startAfter: string | undefined, limit: number): Promise<string[]>;
}

/**
 * How many client registrations are stored.
 *
 * Durable Object storage has no count API, so this is a maintained counter
 * rather than a listing per request. The catch is that the counter is newer
 * than the data: an object that has already served registrations holds client
 * keys and no counter, and reading absent as zero would raise the effective cap
 * by however many are already there. So a first read seeds it from the keys,
 * once, paging through them, and every read after that is one get.
 */
export async function clientCount(
  storage: CounterStorage,
  prefix: string,
  page: number
): Promise<number> {
  const stored = await storage.get<number>(CLIENT_COUNT_KEY);
  if (typeof stored === "number") return stored;

  let total = 0;
  let startAfter: string | undefined;
  for (;;) {
    const keys = await storage.listKeys(prefix, startAfter, page);
    total += keys.length;
    if (keys.length < page) break;
    startAfter = keys[keys.length - 1];
  }
  await storage.put(CLIENT_COUNT_KEY, total);
  return total;
}

/** What a purge reclaimed: lapsed client registrations, and empty rate buckets. */
export interface Reclaimed {
  clients: number;
  buckets: number;
  /**
   * The pass examined everything, so reclaiming nothing really does mean there
   * was nothing to reclaim. A bounded pass that stopped part-way must not be
   * read that way — see sweepPage.
   */
  complete: boolean;
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
  /**
   * Store a rotated refresh token and promote its client in one operation.
   *
   * Issuing a token IS what makes a registration permanent, so the two must not
   * be separable: a caller that promoted first would leave a client holding a
   * cap slot forever when this write failed and no token reached anyone.
   */
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
  /** Set after a purge that reclaimed nothing; see purgeDue. */
  private purgeIdleUntil: number | undefined;

  async registerClient(client: RegisteredClient): Promise<void> {
    this.clients.set(client.client_id, client);
  }

  async getClient(clientId: string): Promise<RegisteredClient | undefined> {
    const client = this.clients.get(clientId);
    if (!client) return undefined;
    // Checked on read as well as purged in bulk, so a lapsed client is never
    // usable just because no purge has run yet.
    if (hasLapsed(client, Date.now())) return undefined;
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

    // Only scan when the cap is actually in the way, and only when the last
    // scan found something — a full registry is retryable without limit, so the
    // work each retry costs is what has to stay bounded.
    if (this.clients.size >= CLIENT_CAP) {
      if (purgeDue(this.purgeIdleUntil, now)) {
        const { clients, buckets, complete } = this.reclaim(now);
        this.purgeIdleUntil =
          complete && clients + buckets === 0 ? now + PURGE_BACKOFF_MS : undefined;
      }
      if (this.clients.size >= CLIENT_CAP) return "full";
    }

    this.clients.set(client.client_id, client);
    if (ip) this.registrations.set(ip, [...inWindow(this.registrations.get(ip) ?? []), now]);
    return "ok";
  }

  async markClientUsed(clientId: string): Promise<void> {
    const client = this.clients.get(clientId);
    // Already permanent: refresh tokens rotate on every use, so this is asked
    // on every refresh for the life of a session and there is nothing to write.
    if (!client || client.expires_at === null) return;
    this.clients.set(clientId, { ...client, expires_at: null, used_at: Date.now() });
  }

  async purgeStale(now: number): Promise<Reclaimed> {
    const reclaimed = this.reclaim(now);
    // An explicit purge that freed something un-sticks admission immediately,
    // rather than leaving it waiting out a backoff that is no longer true.
    if (reclaimed.clients + reclaimed.buckets > 0) this.purgeIdleUntil = undefined;
    return reclaimed;
  }

  private reclaim(now: number): Reclaimed {
    let clients = 0;
    for (const [id, client] of this.clients) {
      if (hasLapsed(client, now)) {
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
    // Nothing is paged here, so every pass has seen everything.
    return { clients, buckets, complete: true };
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
    // Promoting here rather than in the caller keeps the two inseparable: a
    // store that fails mid-issuance must not leave a permanent registration
    // holding a cap slot for a client that never received a token.
    await this.markClientUsed(value.client_id);
  }

  async takeRefresh(token: string): Promise<RefreshToken | undefined> {
    const value = this.refreshes.get(token);
    if (!value) return undefined;
    this.refreshes.delete(token);
    return Date.now() > value.expires_at ? undefined : value;
  }
}
