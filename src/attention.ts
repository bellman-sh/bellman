import type { EventType, SessionEvent } from "./types.js";

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
   * which members have gone silent. A tick that asks nobody does not interrupt:
   * see `isAmbient`.
   */
  heartbeat: "interrupt",
  /**
   * A reply does not, because a peer that cares is already looking, and progress
   * notes landing in a peer's context every few minutes are worse than silence.
   */
  progress: "ambient",
  /**
   * A surface write does not interrupt either (#129): a peer that cares is
   * already looking, and a plan edit landing mid-turn in every member's context
   * is worse than silence. A watcher on a socket or a poll still sees it land.
   */
  surface: "ambient",
} as const satisfies Record<EventType, Attention>;

export const attentionOf = (type: EventType): Attention => ATTENTION[type];

/**
 * Whether this event waits until a member looks: its type's posture, and one exception
 * the type cannot carry. A `heartbeat` whose `members` list is empty asks nobody for a
 * report (M4). In a hosted room that is the host's own tick, and as an interrupt it cost
 * every bridged member a turn each cadence, on top of the question's own.
 */
export const isAmbient = (e: Pick<SessionEvent, "type" | "payload">): boolean => {
  if (ATTENTION[e.type] === "ambient") return true;
  const members = (e.payload as { members?: unknown } | null)?.members;
  return e.type === "heartbeat" && Array.isArray(members) && members.length === 0;
};
