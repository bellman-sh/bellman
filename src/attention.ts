import type { EventType } from "./types.js";

/**
 * Whether an event should reach a member mid-turn, or wait until it looks.
 *
 * In neither server.ts nor store-do.ts, and with no import beyond a type, for
 * the reason public-event.ts gives: publicEvent is called from both, so what
 * it reads must be importable from both. It is the only reader. It turns a
 * type's posture into the `ambient` field on the wire, and clients read that
 * field and not this table, so none of them keeps a type list of its own to
 * fall behind it.
 */
export type Attention = "interrupt" | "ambient";

/**
 * The posture of every event type. Closed over EventType by `satisfies`, so a
 * new type must declare one here or this stops compiling — the SEND_VERB
 * pattern. A default arm would hand it `interrupt` silently, and the point is
 * that every posture is one somebody chose.
 *
 * The twelve types that predate #111 are all `interrupt`, which is what they
 * already do: this table classifies, it does not change behaviour.
 * `invite_issued` and `member_joined` have a case for being ambient, and
 * re-classifying either is a separate change with its own argument to make.
 */
export const ATTENTION = {
  member_joined: "interrupt",
  member_left: "interrupt",
  member_evicted: "interrupt",
  member_timed_out: "interrupt",
  message: "interrupt",
  artifact: "interrupt",
  action_request: "interrupt",
  action_response: "interrupt",
  brief_update: "interrupt",
  invite_issued: "interrupt",
  invite_revoked: "interrupt",
  session_expired: "interrupt",
  /**
   * The tick interrupts, because interrupting a working member to ask where it
   * is IS the feature — the room asked for it, and a tick nobody reads produces
   * no report. It also carries the one thing a peer cannot discover by waiting:
   * which members have gone silent.
   */
  heartbeat: "interrupt",
  /**
   * A reply does not, because a peer that cares is already looking, and progress
   * notes landing in a peer's context every few minutes are worse than silence.
   */
  progress: "ambient",
} as const satisfies Record<EventType, Attention>;

export const attentionOf = (type: EventType): Attention => ATTENTION[type];
export const isAmbient = (type: EventType): boolean => ATTENTION[type] === "ambient";
