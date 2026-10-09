/**
 * One hosted seat (hosted seat spec, D4–D6): where the model is called in production.
 *
 * The room wakes this object through its outbox, and `wake` only queues: the wake is
 * stored and the alarm armed, so the delivery, and a member's reply waiting on it,
 * returns after a few storage operations. The alarm handles the queue one wake per firing
 * through `handleWake`, in src/host.ts, which `MemoryHost` runs on the Node server too.
 * This object is its driver: it reads the room by RPC and writes back through
 * SessionDO.appendHostEvent, which charges the units in the same transaction as the
 * event, and it keeps the seat's record in its own storage. One alarm runs at a time per
 * object, so no two wakes are handled at once and neither saves over the other's record.
 */
import { DurableObject } from "cloudflare:workers";
import type { BellmanEnv } from "./store-do.js";
import type { HostAppend } from "./store.js";
import {
  ANTHROPIC_MESSAGES_URL, RETRY_MS, callMessages, emptyHostRecord, handleWake, joinsQueue,
  type HostDriver, type HostRecord, type HostWake,
} from "./host.js";

/** The seat's queue of wakes, oldest first. The head is the one being handled, or waiting on a retry. */
const PENDING = "pending";

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
  };

  #room(sessionId: string) {
    return this.env.SESSION.get(this.env.SESSION.idFromName(sessionId));
  }

  async #pending(): Promise<HostWake[]> {
    return (await this.ctx.storage.get<HostWake[]>(PENDING)) ?? [];
  }

  /**
   * Delivered by SessionDO's outbox, and only queued. The wake joins the queue unless its
   * cause is handled or already queued, and the alarm is armed for now unless one is set:
   * a set alarm is either about to fire or a retry's backoff, which a new wake waits
   * behind. Nothing here awaits anything but storage, so two deliveries cannot both read
   * the queue before either writes it.
   */
  async wake(wake: HostWake, _rowId: string): Promise<void> {
    const pending = await this.#pending();
    if (!joinsQueue(await this.#driver.load(wake.sessionId), pending, wake)) return;
    await this.ctx.storage.put(PENDING, [...pending, wake]);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
  }

  /**
   * Handles the wake at the head of the queue. A wake the model failed stays at the head
   * and the alarm comes back after its retry delay; any other leaves the queue, and the
   * alarm comes back now while wakes remain. The queue is read again after the model call,
   * so a wake queued during it is kept. A throw leaves the head queued, and the runtime
   * retries a throwing alarm.
   */
  async alarm(): Promise<void> {
    const [head] = await this.#pending();
    if (!head) return;
    const retryIn = await handleWake(this.#driver, head, Date.now());
    if (retryIn !== null) return this.ctx.storage.setAlarm(Date.now() + retryIn);
    const rest = (await this.#pending()).filter((w) => w.cursor !== head.cursor);
    await this.ctx.storage.put(PENDING, rest);
    if (rest.length > 0) await this.ctx.storage.setAlarm(Date.now());
  }
}
