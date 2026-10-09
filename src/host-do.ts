/**
 * One hosted seat (hosted seat spec, D4–D6): where the model is called in production.
 *
 * The room wakes this object through its outbox. What a wake does is `handleWake`'s,
 * in src/host.ts, which `MemoryHost` runs on the Node server too; this object is its
 * driver. It reads the room by RPC and writes back through SessionDO.appendHostEvent,
 * which charges the units in the same transaction as the event; it keeps the seat's
 * record in its own storage; and a failed model call is retried on its own alarm. No
 * room transaction spans a model call: the wake is queued with the event that caused
 * it and delivered after the commit.
 */
import { DurableObject } from "cloudflare:workers";
import type { BellmanEnv } from "./store-do.js";
import type { HostAppend } from "./store.js";
import {
  ANTHROPIC_MESSAGES_URL, RETRY_MS, callMessages, emptyHostRecord, handleWake,
  type HostDriver, type HostRecord, type HostWake,
} from "./host.js";

export class HostDO extends DurableObject<BellmanEnv> {
  /**
   * `handleWake`'s driver. A field rather than methods on the class, because a Durable
   * Object answers RPC for every method on its class, and these write the room and the
   * seat's record.
   */
  readonly #driver: HostDriver = {
    retryMs: RETRY_MS,
    read: async (sessionId) => {
      const room = this.#room(sessionId);
      return { room: await room.getSession(), events: (cursor) => room.eventsAfter(cursor) };
    },
    callModel: (body) =>
      callMessages((url, init) => fetch(url, init), this.env.MODEL_URL ?? ANTHROPIC_MESSAGES_URL, this.env.ANTHROPIC_API_KEY, body),
    // Read as the store's union, as the facade's appendHostEvent returns it: the RPC
    // stub's mapped result does not narrow on `ok`.
    write: async (sessionId, e, units, now) => (await this.#room(sessionId).appendHostEvent(e, units, now)) as HostAppend,
    load: async () => (await this.ctx.storage.get<HostRecord>("state")) ?? emptyHostRecord(),
    save: (_sessionId, record) => this.ctx.storage.put("state", record),
    schedule: (_sessionId, inMs) => this.ctx.storage.setAlarm(Date.now() + inMs),
  };

  #room(sessionId: string) {
    return this.env.SESSION.get(this.env.SESSION.idFromName(sessionId));
  }

  /** Delivered by SessionDO's outbox. A throw leaves the row queued, and a redelivered wake is dropped by its cause cursor. */
  async wake(wake: HostWake, _rowId: string): Promise<void> {
    await handleWake(this.#driver, wake, Date.now());
  }

  /** A retry falls due: the pending wake runs again. */
  async alarm(): Promise<void> {
    const record = await this.ctx.storage.get<HostRecord>("state");
    if (record?.pending) await handleWake(this.#driver, record.pending, Date.now());
  }
}
