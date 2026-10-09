/**
 * The hosted seat on the Node server (hosted seat spec, D7): `handleWake` over a
 * `MemoryStore`, with each seat's record in a map and its retries on timers. Local
 * development and tests; production is `HostDO`, which runs the same `handleWake`.
 * Imports nothing from `cloudflare:workers`.
 */
import { RETRY_MS, callMessages, emptyHostRecord, handleWake, type HostDriver, type HostRecord, type HostWake } from "./host.js";
import type { MemoryStore } from "./store.js";

export class MemoryHost {
  readonly #records = new Map<string, HostRecord>();
  /** Wakes being handled and retries waiting on a timer. `settled` waits for all of them. */
  readonly #inFlight = new Set<Promise<void>>();
  readonly #driver: HostDriver;

  constructor(store: MemoryStore, opts: { modelUrl: string; apiKey?: string; fetch?: typeof fetch; retryMs?: number[] }) {
    const fetcher = opts.fetch ?? fetch;
    this.#driver = {
      retryMs: opts.retryMs ?? RETRY_MS,
      read: async (id) => ({ room: await store.getSession(id), events: (cursor) => store.eventsAfter(id, cursor) }),
      callModel: (body) => callMessages(fetcher, opts.modelUrl, opts.apiKey, body),
      write: (id, e, units, now) => store.appendHostEvent(id, e, units, now),
      load: async (id) => this.#records.get(id) ?? emptyHostRecord(),
      save: async (id, record) => { this.#records.set(id, record); },
      schedule: async (id, inMs) => {
        // Unref'd: a retry waiting up to 15 minutes does not keep a stopping process alive.
        void this.#track(new Promise<void>((resolve) => setTimeout(resolve, inMs).unref()).then(() => this.#retry(id)));
      },
    };
  }

  /** Handle one wake. Never rejects: a failure is logged, as the store that woke the seat has nobody to hand it to. */
  wake(wake: HostWake): Promise<void> {
    return this.#track(handleWake(this.#driver, wake, Date.now()));
  }

  /** Resolves once no wake is being handled and no retry is waiting. */
  async settled(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.all(this.#inFlight);
  }

  async #retry(sessionId: string): Promise<void> {
    const pending = this.#records.get(sessionId)?.pending;
    if (pending) await handleWake(this.#driver, pending, Date.now());
  }

  #track(work: Promise<void>): Promise<void> {
    const tracked: Promise<void> = work
      .catch((err: unknown) => console.error("hosted seat: a wake failed:", err))
      .finally(() => this.#inFlight.delete(tracked));
    this.#inFlight.add(tracked);
    return tracked;
  }
}
