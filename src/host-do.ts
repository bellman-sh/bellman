/**
 * One hosted seat (hosted seat spec, D4–D6): where the model is called.
 *
 * The room wakes this object through its outbox; this object reads the room by
 * RPC, decides through src/host.ts, calls the model once, and writes back through
 * SessionDO.appendHostEvent, which charges the units in the same transaction as
 * the event. No room transaction spans a model call: the wake is queued with the
 * event that caused it and delivered after the commit. A failed call re-arms this
 * object's own alarm: 1, 5, 15 minutes, three attempts, then the wake is dropped.
 */
import { DurableObject } from "cloudflare:workers";
import type { BellmanEnv } from "./store-do.js";
import {
  ANTHROPIC_MESSAGES_URL, HOST_MEMBER_ID, HOST_USER_ID, answerPrompt, applyDecision, decide, emptyHostState,
  messagesBody, parseModelText, questionPrompt, unitsFor, type HostState, type HostWake,
} from "./host.js";
import { monthKey } from "./stored-session.js";
import type { HostAppend } from "./store.js";
import type { SessionEvent } from "./types.js";

const RETRY_MS = [60_000, 300_000, 900_000];

interface Stored extends HostState { pending: HostWake | null; attempts: number; noticed: string | null }

export class HostDO extends DurableObject<BellmanEnv> {
  async #state(): Promise<Stored> {
    return (await this.ctx.storage.get<Stored>("state")) ?? { ...emptyHostState(), pending: null, attempts: 0, noticed: null };
  }

  /** Delivered by SessionDO's outbox. Throwing would leave the row queued; nothing here throws for a wake that is merely dropped. */
  async wake(wake: HostWake, _rowId: string): Promise<void> {
    const st = await this.#state();
    await this.#handle(st, wake);
  }

  async alarm(): Promise<void> {
    const st = await this.#state();
    if (st.pending) await this.#handle(st, st.pending);
  }

  async #handle(st: Stored, wake: HostWake): Promise<void> {
    const room = this.env.SESSION.get(this.env.SESSION.idFromName(wake.sessionId));
    const s = await room.getSession();
    if (!s) return this.#settle(st, wake.cursor);
    const events = wake.cause === "reply" ? await room.eventsAfter(st.cursor) : [];
    const decision = decide(st, wake, s, events, Date.now());
    if (decision.kind === "skip") return this.#settle(st, wake.cursor);

    const model = s.manifest.host!.model;
    const units = unitsFor(model);
    const label = `${s.manifest.host!.role}@bellman`;
    // The meter first: a wake the month cannot pay for costs no model call.
    if (s.hostUnits.month === monthKey(Date.now()) && s.hostUnits.used + units > s.hostUnitsPerMonth) {
      return this.#settle(await this.#notice(st, s.id, label, s.hostUnits.used, s.hostUnitsPerMonth, model, units), wake.cursor);
    }

    const prompt = decision.kind === "question"
      ? questionPrompt(s.manifest, st)
      : answerPrompt(s.manifest, decision.question.text, decision.replies);
    const res = await fetch(this.env.MODEL_URL ?? ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01" },
      body: JSON.stringify(messagesBody(model, prompt)),
    });
    if (res.status === 429 || res.status >= 500) return this.#retry(st, wake);
    const text = parseModelText(await res.json().catch(() => null));
    if (text === null) return this.#settle(st, wake.cursor);

    const refId = decision.kind === "question" ? String(decision.refId) : String(decision.question.cursor);
    const e: Omit<SessionEvent, "cursor" | "at"> = {
      type: "message", fromMemberId: HOST_MEMBER_ID, fromUserId: HOST_USER_ID, fromLabel: label,
      payload: { kind: decision.kind, text }, refId,
    };
    // Read as the store's union, as the facade's appendHostEvent returns it: the RPC stub's
    // mapped result does not narrow on `ok`.
    const written = (await room.appendHostEvent(e, units, Date.now())) as HostAppend;
    if (!written.ok) {
      const after = written.reason === "units" ? await this.#notice(st, s.id, label, written.used, written.allowed, model, units) : st;
      return this.#settle(after, wake.cursor);
    }
    const next = applyDecision(st, decision, { cursor: written.event.cursor, text }, Date.now());
    await this.ctx.storage.put("state", { ...st, ...next, pending: null, attempts: 0 });
  }

  /**
   * One notice a month, outside the meter: appended with zero units so it cannot itself be refused.
   * Returns the state with the month marked, for the caller to settle with.
   */
  async #notice(st: Stored, sessionId: string, label: string, used: number, allowed: number, model: string, units: number): Promise<Stored> {
    const month = monthKey(Date.now());
    if (st.noticed === month) return st;
    const room = this.env.SESSION.get(this.env.SESSION.idFromName(sessionId));
    await room.appendHostEvent({
      type: "message", fromMemberId: HOST_MEMBER_ID, fromUserId: HOST_USER_ID, fromLabel: label,
      payload: { kind: "notice", text: `The host has used its ${allowed} units this month (${used} spent; a ${model} wake costs ${units}). It is quiet until the month turns.` },
      refId: null,
    }, 0, Date.now());
    const noticed = { ...st, noticed: month };
    await this.ctx.storage.put("state", noticed);
    return noticed;
  }

  async #settle(st: Stored, cause: number): Promise<void> {
    await this.ctx.storage.put("state", { ...st, lastCause: Math.max(st.lastCause, cause), pending: null, attempts: 0 });
  }

  async #retry(st: Stored, wake: HostWake): Promise<void> {
    if (st.attempts >= RETRY_MS.length) return this.#settle(st, wake.cursor);
    await this.ctx.storage.put("state", { ...st, pending: wake, attempts: st.attempts + 1 });
    await this.ctx.storage.setAlarm(Date.now() + RETRY_MS[st.attempts]);
  }
}
