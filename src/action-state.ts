import type { SessionEvent } from "./types.js";

/**
 * How long an `action_request` stays answerable.
 *
 * It is the whole difference between "your human said no" and "nobody was
 * there" (#81). Without a deadline those two are one state — silence — and a
 * requester waits on a room that is never going to answer.
 *
 * Long enough that a human who stepped away can still come back to it, short
 * enough that an agent is not left waiting on one for a working day. A request
 * that expires is not refused: nothing stops the requester asking again, and
 * the response path does not check the deadline, so an answer that arrives late
 * still lands and still counts.
 */
export const ACTION_REQUEST_TTL_MS = 30 * 60_000;

/**
 * What became of an `action_request`. Every request is in exactly one of these,
 * and three of the four are terminal — which is the guarantee #81 asked for: a
 * request cannot sit in a state that means nothing.
 *
 * Derived, never stored. The event log already holds everything this reads, and
 * events are append-only, so a stored status would be a second copy of the
 * answer that could disagree with the first. `expired` is the one that is a
 * function of the clock rather than of an event, which is why it has to be
 * computed when it is asked for and cannot be written down once.
 */
export type ActionState = "outstanding" | "answered" | "declined" | "expired";

/** An `action_request` still waiting for an answer, as `bellman_sync` reports it. */
export interface OutstandingRequest {
  /** The request's cursor — the id an `action_response` puts in `ref_id`. */
  cursor: number;
  from_member_id: string;
  from_label: string;
  /** True when the caller sent it: waiting on the room. False: the room waits on them. */
  mine: boolean;
  age_seconds: number;
  expires_at: string;
}

const approvedIn = (payload: unknown): boolean | undefined =>
  typeof payload === "object" && payload !== null && "approved" in payload
    ? Boolean((payload as { approved: unknown }).approved)
    : undefined;

/**
 * The state of every `action_request` in `events`, keyed by cursor.
 *
 * A response names its request by `refId`, and `bellman_send` has already
 * checked that against a real `action_request` on the way in, so the matching
 * here can trust it and does not re-validate.
 *
 * A response with no `approved` field counts as `answered` rather than being
 * ignored: the tool requires that field, so one without it came from a build
 * that did not, and treating it as no answer would leave a request outstanding
 * for ever on the strength of a missing boolean.
 */
export function actionStates(events: readonly SessionEvent[], now: number): Map<number, ActionState> {
  const states = new Map<number, ActionState>();
  for (const e of events) {
    if (e.type !== "action_request") continue;
    states.set(e.cursor, now > e.at + ACTION_REQUEST_TTL_MS ? "expired" : "outstanding");
  }
  for (const e of events) {
    if (e.type !== "action_response" || e.refId === null) continue;
    const cursor = Number(e.refId);
    if (!states.has(cursor)) continue;
    // An answer beats the clock. A request that expired and was answered anyway
    // is `answered`: the deadline exists to end the waiting, not to refuse a
    // human who came back to it late, and the response path does not enforce it
    // either.
    states.set(cursor, approvedIn(e.payload) === false ? "declined" : "answered");
  }
  return states;
}

/**
 * The requests still waiting, in cursor order, as this member should see them.
 *
 * Both directions, because "a terminal state they cannot skip" cuts both ways:
 * `mine` is what this member is waiting on the room for, and the rest are what
 * the room is waiting on this member's human for. An agent that saw only its
 * own would have no way to notice it had left a peer hanging.
 *
 * Terminal requests are not listed. There is nothing left to do about them, and
 * a list that grew for the life of the room would be read once and then ignored.
 */
export function outstandingFor(
  events: readonly SessionEvent[],
  memberId: string,
  now: number,
): OutstandingRequest[] {
  const states = actionStates(events, now);
  return events
    .filter((e) => e.type === "action_request" && states.get(e.cursor) === "outstanding")
    .map((e) => ({
      cursor: e.cursor,
      from_member_id: e.fromMemberId,
      from_label: e.fromLabel,
      mine: e.fromMemberId === memberId,
      age_seconds: Math.max(0, Math.round((now - e.at) / 1000)),
      expires_at: new Date(e.at + ACTION_REQUEST_TTL_MS).toISOString(),
    }));
}
