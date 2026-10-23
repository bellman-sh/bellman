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
 *
 * A topic room's proposals are the one exception, and live `PROPOSAL_TTL_MS`.
 */
export const ACTION_REQUEST_TTL_MS = 30 * 60_000;

/** A topic room's contribution: the `kind` of an action request's payload that proposes a card (topic rooms spec, D2). */
export const PROPOSAL_KIND = "surface_proposal";

/**
 * Seven days: how long a topic room's proposal stays open before it reads `expired` (topic rooms
 * spec, D3). The human who answers one is a maintainer reading a room they keep, who comes to it in
 * days and not in the half hour an agent is willing to wait on a peer. Everything the half hour
 * says about an answer that arrives late holds here too: the response path never checks it.
 */
export const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * Whether an action request's payload calls itself a proposal. It reads `kind` and nothing else: the
 * payload's shape is checked once, when `bellman_send` takes it, and this runs on every poll over
 * what was stored. Whether the kind earns anything is `requestTtlMs`'s question, which asks the room.
 */
export const isProposalPayload = (payload: unknown): boolean =>
  typeof payload === "object" && payload !== null && (payload as { kind?: unknown }).kind === PROPOSAL_KIND;

/**
 * How long `e` stays answerable: `PROPOSAL_TTL_MS` for a proposal in a topic room,
 * `ACTION_REQUEST_TTL_MS` for everything else (topic rooms plan, R9).
 *
 * Both halves of the test are needed. The room alone would give a topic room's plain requests a
 * week, which is not what a plain request needs. The payload alone would let any member of any room
 * keep a request in every peer's `outstanding` for a week by naming a kind in it.
 */
export function requestTtlMs(e: Pick<SessionEvent, "payload">, topic: boolean): number {
  return topic && isProposalPayload(e.payload) ? PROPOSAL_TTL_MS : ACTION_REQUEST_TTL_MS;
}

/**
 * What became of an `action_request`. Every request is in exactly one of these,
 * and three of the four are terminal — which is the guarantee #81 asked for: a
 * request cannot sit in a state that means nothing.
 *
 * Derived, never stored. The event log already holds everything this reads, and
 * events are append-only, so a stored status would be a second copy of the
 * answer that could disagree with the first. `expired` is the one that is a
 * function of the clock rather than of an event, which is why it has to be
 * computed when it is asked for and cannot be written down once. Its deadline
 * is a function of the request and of the room's kind (`requestTtlMs`): the log
 * holds the first, the caller says the second, and neither is stored.
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

/**
 * What a response says, read so that only an actual approval reads as one.
 *
 * `Boolean(...)` was wrong in the one direction that matters: `Boolean("false")`
 * is `true`, so a client answering `{ approved: "false" }` had its human's
 * REFUSAL recorded as an approval — the exact distinction this module exists to
 * make, inverted. `approved === true` approves; anything else that is present
 * fails closed to `declined`, because a malformed answer is not a yes.
 *
 * An absent `approved` still counts as `answered`: the field is required at the
 * tool boundary now (ActionResponseShape), so a response without one came from
 * a build that predates it, and leaving the request outstanding for ever on a
 * missing boolean is worse than recording that it was answered.
 */
const verdictOf = (payload: unknown): "answered" | "declined" => {
  if (typeof payload !== "object" || payload === null || !("approved" in payload)) {
    return "answered";
  }
  return (payload as { approved: unknown }).approved === true ? "answered" : "declined";
};

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
 *
 * `topic` is whether the room is a topic room (`isTopicRoom`), which a list of events cannot say, and
 * it decides how long a proposal lives (`requestTtlMs`). It defaults to false, so a caller that does
 * not pass it reads every request as every request was read before topic rooms.
 */
export function actionStates(events: readonly SessionEvent[], now: number, topic = false): Map<number, ActionState> {
  const states = new Map<number, ActionState>();
  // Keyed by the refId STRING a response would have to carry, not by the number.
  // `bellman_send` admits a response only when `String(req.cursor) === ref_id`,
  // deliberately, so that "007" never answers cursor 7. Resolving with
  // `Number(refId)` here was a looser rule than the one this module says it
  // trusts, and would let a row that did not come through today's send path —
  // written before that check, or by another writer — terminate a request it was
  // never allowed to answer.
  const byRef = new Map<string, number>();

  for (const e of events) {
    if (e.type !== "action_request") continue;
    states.set(e.cursor, now > e.at + requestTtlMs(e, topic) ? "expired" : "outstanding");
    byRef.set(String(e.cursor), e.cursor);
  }

  for (const e of events) {
    if (e.type !== "action_response" || e.refId === null) continue;
    const cursor = byRef.get(e.refId);
    if (cursor === undefined) continue;

    // THE FIRST ANSWER WINS, and a terminal state is not revisited.
    //
    // A room holds many members, and `bellman_send` refuses only a response to
    // your OWN request — nothing stops a second member answering one another
    // member's human has already answered. Last-writer-wins let a later
    // `{approved: true}` overwrite an earlier refusal, so a human's "no" was
    // reported to the requester as a yes. In a swarm the default seat holds
    // `respond_actions`, so that is every joiner.
    //
    // Terminal means terminal: the requester has already been told, and
    // `outstandingFor` stopped listing it on the first answer, so no second
    // human was asked in any case.
    const current = states.get(cursor);
    if (current === "answered" || current === "declined") continue;

    // An answer beats the clock. A request that expired and was answered anyway
    // is answered: the deadline exists to end the waiting, not to refuse a
    // human who came back to it late, and the response path does not enforce it
    // either.
    states.set(cursor, verdictOf(e.payload));
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
 *
 * `topic` as in `actionStates`, and the `expires_at` it reports comes from the same deadline the
 * state was derived with: a listing that said half an hour for a proposal the state keeps a week
 * would tell the reader to give up on it.
 */
export function outstandingFor(
  events: readonly SessionEvent[],
  memberId: string,
  now: number,
  topic = false,
): OutstandingRequest[] {
  const states = actionStates(events, now, topic);
  return events
    .filter((e) => e.type === "action_request" && states.get(e.cursor) === "outstanding")
    .map((e) => ({
      cursor: e.cursor,
      from_member_id: e.fromMemberId,
      from_label: e.fromLabel,
      mine: e.fromMemberId === memberId,
      age_seconds: Math.max(0, Math.round((now - e.at) / 1000)),
      expires_at: new Date(e.at + requestTtlMs(e, topic)).toISOString(),
    }));
}

/**
 * How many proposals `memberId` holds open at `now`, read from the log of a topic room: their own
 * `action_request`s that are proposals and still `outstanding`. An answered, a declined and an
 * expired one are not open, so a proposer's place comes back when a maintainer's human answers it
 * or a week passes. No `topic` argument: the count is only ever asked of a topic room.
 */
export function openProposalsOf(events: readonly SessionEvent[], memberId: string, now: number): number {
  const states = actionStates(events, now, true);
  return events.filter(
    (e) => e.type === "action_request" && e.fromMemberId === memberId && isProposalPayload(e.payload)
      && states.get(e.cursor) === "outstanding",
  ).length;
}
