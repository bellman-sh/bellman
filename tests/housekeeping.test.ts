/**
 * What an append owes housekeeping (#66), proved on `noteAppend` alone: no store, no clock.
 *
 * The rules that read these books arrive in the next group of cases; this file starts with the
 * part both stores share, because "open" and "last send" are decided here once and a store that
 * kept its own copy could disagree with the other about them.
 */
import { describe, expect, it } from "vitest";
import { noteAppend } from "../src/store.js";
import type { SessionEvent } from "../src/types.js";
import { member, roomManifest } from "./helpers/fixtures.js";

const T0 = Date.parse("2026-03-15T12:00:00Z");

/** A room that declared housekeeping: the only kind that keeps books. */
const declared = () =>
  roomManifest({
    housekeeping: { quietAfterMs: 7_200_000, answerWithinMs: 1_800_000, idleAfterMs: 86_400_000, repeatAfterMs: null },
  });

const ev = (over: Partial<SessionEvent>): SessionEvent => ({
  cursor: 1, type: "message", fromMemberId: "m_a", fromUserId: "u_a", fromLabel: "a",
  payload: {}, refId: null, at: T0, ...over,
});

const base = (manifest = declared()) => ({
  manifest,
  members: [
    member({ memberId: "m_a", joinedAt: T0 - 10 }),
    member({ memberId: "m_b", userId: "u_b", joinedAt: T0 - 10 }),
  ],
  openRequests: {} as Record<string, { at: number; fromMemberId: string }>,
  lastMemberEventAt: null as number | null,
});

const lastSentOf = (out: { members: Array<{ memberId: string; lastSentAt?: number }> }, id: string) =>
  out.members.find((m) => m.memberId === id)!.lastSentAt;

/** How the server writes each way a member leaves, as `leaveRoom`, `evictMember` and `announceReclaimed` build them. */
const departures = (gone: string, cursor: number, at: number): Array<[string, SessionEvent]> => [
  // The leaver speaks for themselves.
  ["member_left", ev({ cursor, type: "member_left", fromMemberId: gone, at })],
  // An eviction and a timeout are the server's: no member handle authored them, and the
  // member they are about is named in the payload.
  ["member_evicted", ev({ cursor, type: "member_evicted", fromMemberId: "system", payload: { member_id: gone }, at })],
  ["member_timed_out", ev({ cursor, type: "member_timed_out", fromMemberId: "system", payload: { member_id: gone }, at })],
];

describe("noteAppend", () => {
  it("stamps the sender's lastSentAt and the room's lastMemberEventAt on a member event", () => {
    const out = noteAppend(base(), ev({ at: T0 + 5 }));
    expect(lastSentOf(out, "m_a")).toBe(T0 + 5);
    expect(lastSentOf(out, "m_b")).toBeUndefined();
    expect(out.lastMemberEventAt).toBe(T0 + 5);
  });

  it("moves nothing on a server event", () => {
    const out = noteAppend(base(), ev({ type: "heartbeat", fromMemberId: "system", at: T0 + 5 }));
    expect(out.lastMemberEventAt).toBeNull();
    expect(out.members.every((m) => m.lastSentAt === undefined)).toBe(true);
  });

  it("opens a request at its cursor and closes it on the response that names it", () => {
    const opened = noteAppend(base(), ev({ cursor: 7, type: "action_request", at: T0 }));
    expect(opened.openRequests).toEqual({ "7": { at: T0, fromMemberId: "m_a" } });
    // Asking is a send: the request moves the sender and the room like any member event.
    expect(lastSentOf(opened, "m_a")).toBe(T0);
    expect(opened.lastMemberEventAt).toBe(T0);

    const answered = noteAppend(
      { ...base(), ...opened },
      ev({ cursor: 9, type: "action_response", fromMemberId: "m_b", refId: "7", at: T0 + 1 }),
    );
    expect(answered.openRequests).toEqual({});

    const unrelated = noteAppend(
      { ...base(), ...opened },
      ev({ cursor: 9, type: "action_response", fromMemberId: "m_b", refId: "3", at: T0 + 1 }),
    );
    expect(unrelated.openRequests).toEqual({ "7": { at: T0, fromMemberId: "m_a" } });
  });

  // Keyed off the member who LEFT, which is not always the event's author: an eviction and a
  // timeout are authored by "system", so a helper that read `fromMemberId` would close nothing.
  it.each(departures("m_a", 8, T0 + 1))("closes a member's requests on %s", (_type, departure) => {
    const opened = { ...base(), ...noteAppend(base(), ev({ cursor: 7, type: "action_request", at: T0 })) };
    const gone = noteAppend(opened, departure);
    expect(gone.openRequests).toEqual({});
  });

  it.each(departures("m_a", 8, T0 + 1))("leaves another member's requests open on %s", (_type, departure) => {
    const theirs = { ...base(), ...noteAppend(base(), ev({ cursor: 7, type: "action_request", fromMemberId: "m_b", at: T0 })) };
    const gone = noteAppend(theirs, departure);
    expect(gone.openRequests).toEqual({ "7": { at: T0, fromMemberId: "m_b" } });
  });

  // An eviction and a timeout are the server's word, so they are nobody's activity: the same
  // rule that keeps a tick from counting as a send keeps them from counting as one.
  it.each(departures("m_a", 8, T0 + 1).slice(1))("counts %s as no member's activity", (_type, departure) => {
    const out = noteAppend(base(), departure);
    expect(out.lastMemberEventAt).toBeNull();
    expect(out.members.every((m) => m.lastSentAt === undefined)).toBe(true);
  });

  it("counts a member's own leaving as that member's last send", () => {
    const out = noteAppend(base(), ev({ cursor: 8, type: "member_left", fromMemberId: "m_a", at: T0 + 1 }));
    expect(out.lastMemberEventAt).toBe(T0 + 1);
  });

  // The row a room without housekeeping writes is the row it wrote before this existed.
  // Returning the very object it was handed is how a caller tells there is nothing to write.
  it.each([
    ["a message", ev({ at: T0 + 5 })],
    ["an action_request", ev({ cursor: 7, type: "action_request" })],
    ["a departure", ev({ cursor: 8, type: "member_left" })],
  ])("keeps no books in a room that declared no housekeeping: %s", (_what, event) => {
    const plain = base(roomManifest({ housekeeping: null }));
    expect(noteAppend(plain, event)).toBe(plain);
  });

  it("does not write into what it is handed", () => {
    const input = base();
    const withRequest = { ...input, ...noteAppend(input, ev({ cursor: 7, type: "action_request", at: T0 })) };
    const before = structuredClone(withRequest);
    noteAppend(withRequest, ev({ cursor: 9, type: "action_response", fromMemberId: "m_b", refId: "7", at: T0 + 1 }));
    noteAppend(withRequest, ev({ cursor: 8, type: "member_left", fromMemberId: "m_a", at: T0 + 1 }));
    expect(withRequest).toEqual(before);
  });
});
