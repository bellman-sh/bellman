/**
 * An action_request's state is DERIVED, never stored (#81). The event log holds
 * everything these read and events are append-only, so a written-down status
 * would be a second copy of the answer that could disagree with the first.
 *
 * What is being pinned is that the four states partition: every request is in
 * exactly one, and three of them are terminal. Before this, a request nobody
 * answered and a request nobody saw were the same thing — silence — and the
 * requester could not tell them apart.
 */
import { describe, it, expect } from "vitest";
import {
  ACTION_REQUEST_TTL_MS, actionStates, outstandingFor,
} from "../src/action-state.js";
import type { EventType, SessionEvent } from "../src/types.js";

const T0 = 1_700_000_000_000;

const event = (over: Partial<SessionEvent> & { cursor: number; type: EventType }): SessionEvent => ({
  fromMemberId: "m_a",
  fromUserId: "u_a",
  fromLabel: "jesse@codenerd",
  payload: {},
  refId: null,
  at: T0,
  ...over,
});

const request = (cursor: number, over: Partial<SessionEvent> = {}) =>
  event({ cursor, type: "action_request", ...over });

const response = (cursor: number, ref: number, approved: boolean | undefined) =>
  event({
    cursor,
    type: "action_response",
    fromMemberId: "m_b",
    refId: String(ref),
    payload: approved === undefined ? { result: "done" } : { approved },
  });

describe("actionStates", () => {
  it("leaves a request with no response outstanding", () => {
    expect(actionStates([request(1)], T0).get(1)).toBe("outstanding");
  });

  it("marks an approved response answered", () => {
    expect(actionStates([request(1), response(2, 1, true)], T0).get(1)).toBe("answered");
  });

  /**
   * The distinction the whole issue is about. A human who said no and a human
   * who never looked produce different states, where before both produced
   * silence.
   */
  it("marks a refused response declined, not merely answered", () => {
    expect(actionStates([request(1), response(2, 1, false)], T0).get(1)).toBe("declined");
  });

  it("expires a request nobody answered once the deadline passes", () => {
    const states = actionStates([request(1)], T0 + ACTION_REQUEST_TTL_MS + 1);
    expect(states.get(1)).toBe("expired");
  });

  it("holds a request outstanding right up to the deadline", () => {
    // The boundary itself is not expiry: `now > at + TTL`. Without this, an
    // off-by-one in either direction passes the test above.
    expect(actionStates([request(1)], T0 + ACTION_REQUEST_TTL_MS).get(1)).toBe("outstanding");
  });

  it("lets a late answer beat the clock", () => {
    // The deadline ends the waiting; it does not refuse a human who came back
    // to it. bellman_send does not enforce it either, so a state that said
    // "expired" here would disagree with a response the room actually holds.
    const states = actionStates(
      [request(1), response(2, 1, true)],
      T0 + ACTION_REQUEST_TTL_MS + 60_000,
    );
    expect(states.get(1)).toBe("answered");
  });

  it("counts a response with no approved field as answered", () => {
    // The tool requires the field, so one without it came from a build that did
    // not. Ignoring it would leave the request outstanding for ever on the
    // strength of a missing boolean.
    expect(actionStates([request(1), response(2, 1, undefined)], T0).get(1)).toBe("answered");
  });

  it("holds each request's state apart from the others", () => {
    const states = actionStates(
      [request(1), request(2), request(3), response(4, 2, false), response(5, 3, true)],
      T0,
    );
    expect([states.get(1), states.get(2), states.get(3)])
      .toEqual(["outstanding", "declined", "answered"]);
  });

  it("names no state for an event that is not a request", () => {
    const states = actionStates([event({ cursor: 1, type: "message" }), request(2)], T0);
    expect([...states.keys()]).toEqual([2]);
  });

  /**
   * A room holds many members. `bellman_send` refuses only a response to your
   * OWN request, so in a swarm — where the default seat holds `respond_actions`
   * — any joiner can answer one another member's human has already answered.
   * Last-writer-wins turned a refusal into an approval, which is the exact
   * inversion this module exists to prevent.
   */
  it("keeps the first answer when a second member answers the same request", () => {
    const states = actionStates(
      [request(1), response(2, 1, false), response(3, 1, true)],
      T0,
    );
    expect(states.get(1)).toBe("declined");
  });

  it("keeps the first answer in the other order too", () => {
    // Not symmetry for its own sake: a rule of "declined wins" would pass the
    // test above while still not being first-answer-wins.
    const states = actionStates(
      [request(1), response(2, 1, true), response(3, 1, false)],
      T0,
    );
    expect(states.get(1)).toBe("answered");
  });

  /**
   * `Boolean("false")` is `true`. Reading `approved` through it recorded a
   * human's refusal as an approval — the one direction that must never happen,
   * so anything present that is not exactly `true` fails closed.
   */
  it.each([
    ["the string false", "false"],
    ["the string no", "no"],
    ["zero", 0],
    ["null", null],
    ["an empty string", ""],
  ])("declines rather than approves when approved is %s", (_label, approved) => {
    const e = event({ cursor: 2, type: "action_response", refId: "1", payload: { approved } });
    expect(actionStates([request(1), e], T0).get(1)).toBe("declined");
  });

  it("approves only on a boolean true", () => {
    const e = event({ cursor: 2, type: "action_response", refId: "1", payload: { approved: true } });
    expect(actionStates([request(1), e], T0).get(1)).toBe("answered");
  });

  /**
   * bellman_send admits a response only when `String(req.cursor) === ref_id`, so
   * "007" never answers cursor 7. Resolving with `Number(refId)` here was looser
   * than the check this module says it trusts, and would let a row that did not
   * come through that path terminate a request it could not answer.
   */
  it.each(["007", "7.0", " 7", "+7", "7e0"])(
    "does not let the ref %s terminate cursor 7",
    (ref) => {
      const e = event({ cursor: 8, type: "action_response", refId: ref, payload: { approved: true } });
      expect(actionStates([request(7), e], T0).get(7)).toBe("outstanding");
    },
  );

  it("does terminate on the exact decimal string, so the test above is about the form", () => {
    const e = event({ cursor: 8, type: "action_response", refId: "7", payload: { approved: true } });
    expect(actionStates([request(7), e], T0).get(7)).toBe("answered");
  });

  it("ignores a response whose ref names no request in the log", () => {
    const states = actionStates([request(1), response(2, 99, true)], T0);
    expect(states.get(1)).toBe("outstanding");
    expect(states.size).toBe(1);
  });
});

describe("outstandingFor", () => {
  const events = [
    request(1),                                   // from m_a, unanswered
    request(2, { fromMemberId: "m_b", fromLabel: "peer@openai" }),
    request(3),
    response(4, 3, true),                         // 3 is answered
  ];

  it("reports both directions, and says which are the caller's own", () => {
    const out = outstandingFor(events, "m_a", T0);
    expect(out.map((o) => [o.cursor, o.mine])).toEqual([[1, true], [2, false]]);
  });

  it("flips `mine` for the other member, from the same log", () => {
    // The same events read by the peer. `mine` is about the reader, not the
    // event, and reading it off the wrong member is the obvious way to get this
    // backwards.
    const out = outstandingFor(events, "m_b", T0);
    expect(out.map((o) => [o.cursor, o.mine])).toEqual([[1, false], [2, true]]);
  });

  it("drops a request once it is terminal", () => {
    expect(outstandingFor(events, "m_a", T0).map((o) => o.cursor)).not.toContain(3);
    expect(outstandingFor(events, "m_a", T0 + ACTION_REQUEST_TTL_MS + 1)).toEqual([]);
  });

  it("carries the age and the deadline, so a caller can tell how long it has", () => {
    const [first] = outstandingFor([request(1)], "m_a", T0 + 90_000);
    expect(first.age_seconds).toBe(90);
    expect(first.expires_at).toBe(new Date(T0 + ACTION_REQUEST_TTL_MS).toISOString());
    expect(first.from_label).toBe("jesse@codenerd");
  });
});
