/**
 * The hosted seat on the Node server (hosted seat spec, D7): `handleWake` over a
 * `MemoryStore`, with each seat's record and queue in maps and its retries on timers. It
 * mirrors `HostDO`: a wake is queued and returns at once, and one drain per seat handles
 * the queue in order. Local development and tests; production is `HostDO`. Imports
 * nothing from `cloudflare:workers`.
 */
import {
  ANTHROPIC_MESSAGES_URL, RETRY_MS, callMessages, emptyHostRecord, joinsQueue, runWake,
  type HostDriver, type HostRecord, type HostWake,
} from "./host.js";
import type { MemoryStore } from "./store.js";

/**
 * Which model the Node server's seat calls (M11), and the line it prints at startup to say
 * so. Claude Code users commonly export ANTHROPIC_API_KEY, so the key alone must not make
 * `npm start` spend it: the real Messages API is called only with BELLMAN_REAL_MODEL=1
 * beside the key. MODEL_URL, set by hand, is used as it says. Anything else gets the
 * server's own fake model, which is sent no key. The line never holds the key.
 */
export function nodeModel(env: Record<string, string | undefined>, port: number): { modelUrl: string; apiKey: string | undefined; says: string } {
  if (env.MODEL_URL) {
    return { modelUrl: env.MODEL_URL, apiKey: env.ANTHROPIC_API_KEY, says: `hosted seat: the model at MODEL_URL (${env.MODEL_URL})` };
  }
  if (env.BELLMAN_REAL_MODEL === "1" && env.ANTHROPIC_API_KEY) {
    return { modelUrl: ANTHROPIC_MESSAGES_URL, apiKey: env.ANTHROPIC_API_KEY, says: "hosted seat: the real Messages API, billed to ANTHROPIC_API_KEY (BELLMAN_REAL_MODEL=1)" };
  }
  return {
    modelUrl: `http://localhost:${port}/__fake-model`, apiKey: undefined,
    says: "hosted seat: this server's fake model; set BELLMAN_REAL_MODEL=1 beside ANTHROPIC_API_KEY to call the real Messages API",
  };
}

export class MemoryHost {
  // ponytail: a purged room's record stays in this map until the process exits, because
  // MemoryStore's purge cannot reach it (HostDO.forget is the production path). Local
  // development only; hand MemoryStore a forget hook beside `host` if that ever matters.
  readonly #records = new Map<string, HostRecord>();
  /** Each seat's queue of wakes, oldest first. The head is the one being handled, or waiting on a retry. */
  readonly #pending = new Map<string, HostWake[]>();
  /** The seats whose queue a drain is working through. */
  readonly #draining = new Set<string>();
  /** The drains running, retry waits included. `settled` waits for all of them. */
  readonly #inFlight = new Set<Promise<void>>();
  readonly #driver: HostDriver;

  constructor(store: MemoryStore, opts: { modelUrl: string; apiKey?: string; fetch?: typeof fetch; retryMs?: number[] }) {
    const fetcher = opts.fetch ?? fetch;
    this.#driver = {
      retryMs: opts.retryMs ?? RETRY_MS,
      read: async (id) => ({
        room: await store.getSession(id),
        events: (cursor, limit) => store.eventsAfter(id, cursor, limit),
        sent: (key) => store.hostEventFor(id, key),
      }),
      callModel: (body) => callMessages(fetcher, opts.modelUrl, opts.apiKey, body),
      write: (id, e, units, now, key) => store.appendHostEvent(id, e, units, now, key),
      load: async (id) => this.#records.get(id) ?? emptyHostRecord(),
      save: async (id, record) => { this.#records.set(id, record); },
    };
  }

  /**
   * Queue one wake, and start the seat's drain if none is running. Resolves at once: the
   * drain calls the model, as `HostDO`'s alarm does, so whatever woke the seat never waits
   * on it.
   */
  async wake(wake: HostWake): Promise<void> {
    const id = wake.sessionId;
    let pending = this.#pending.get(id);
    if (!pending) this.#pending.set(id, (pending = []));
    if (!joinsQueue(this.#records.get(id) ?? emptyHostRecord(), pending, wake)) return;
    pending.push(wake);
    if (this.#draining.has(id)) return;
    this.#draining.add(id);
    this.#track(this.#drain(id, pending));
  }

  /** Resolves once no drain is running, which is when every queue is empty. */
  async settled(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.all(this.#inFlight);
  }

  /**
   * Handle a seat's queue in order, one wake at a time. A wake the model failed is run
   * again after its retry delay, before anything behind it. The drain ends in the same
   * step that finds the queue empty, so a wake queued after that starts a new one.
   */
  async #drain(id: string, pending: HostWake[]): Promise<void> {
    try {
      while (pending.length > 0) {
        const retryIn = await runWake(this.#driver, pending[0], Date.now());
        if (retryIn === null) pending.shift();
        // Unref'd: a retry waiting up to 15 minutes does not keep a stopping process alive.
        else await new Promise<void>((resolve) => setTimeout(resolve, retryIn).unref());
      }
    } finally {
      this.#draining.delete(id);
    }
  }

  /** A drain's failure is logged, as the store that woke the seat has nobody to hand it to. */
  #track(work: Promise<void>): void {
    const tracked: Promise<void> = work
      .catch((err: unknown) => console.error("hosted seat: a wake failed:", err))
      .finally(() => this.#inFlight.delete(tracked));
    this.#inFlight.add(tracked);
  }
}
