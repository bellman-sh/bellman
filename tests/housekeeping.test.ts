/**
 * What an append owes housekeeping (#66), proved on `noteAppend` alone: no store, no clock.
 *
 * The rules that read these books arrive in the next group of cases; this file starts with the
 * part both stores share, because "open" and "last send" are decided here once and a store that
 * kept its own copy could disagree with the other about them.
 */
import { describe, expect, it } from "vitest";
import { clearedKeys, dueFindings, nextHousekeepAt } from "../src/housekeeping.js";
import { noteAppend } from "../src/store.js";
import type { StoredSession } from "../src/stored-session.js";
import type { RoomManifest, SessionEvent } from "../src/types.js";
import { member, roomManifest, session } from "./helpers/fixtures.js";

const T0 = Date.parse("2026-03-15T12:00:00Z");
const M5 = 300_000;
const M30 = 1_800_000;
const H2 = 7_200_000;
const D1 = 86_400_000;

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

// ---------------------------------------------------------------------------
// The rules (#66): what is due, what clears, and when to look again.
// ---------------------------------------------------------------------------

type Thresholds = NonNullable<RoomManifest["housekeeping"]>;
type Raised = StoredSession["raised"];
const rules = (over: Partial<Thresholds> = {}): Thresholds => ({
  quietAfterMs: H2, answerWithinMs: M30, idleAfterMs: D1, repeatAfterMs: null, ...over,
});
/** One finding on and the others off, so a case about it is not also a case about them. */
const quietOnly = (over: Partial<Thresholds> = {}) => rules({ answerWithinMs: null, idleAfterMs: null, ...over });
const requestsOnly = (over: Partial<Thresholds> = {}) => rules({ quietAfterMs: null, idleAfterMs: null, ...over });
const idleOnly = (over: Partial<Thresholds> = {}) => rules({ quietAfterMs: null, answerWithinMs: null, ...over });

/** A StoredSession is a Session without its events. */
function stored(over: Partial<StoredSession> = {}, thresholds: Thresholds | null = rules()): StoredSession {
  const { events: _events, ...rest } = session({ manifest: roomManifest({ housekeeping: thresholds }) });
  return { ...rest, ...over } as StoredSession;
}
const who = (id: string, over: Record<string, unknown> = {}) =>
  member({ memberId: id, userId: `u_${id}`, label: `${id}@x`, joinedAt: T0 - 1_000, ...over });
const keysOf = (findings: ReturnType<typeof dueFindings>) => findings.map((f) => f.key);

/** What the housekeeping firing writes into `raised` for what it just raised. */
const raisedBy = (findings: ReturnType<typeof dueFindings>, at: number): Raised =>
  Object.fromEntries(findings.map((f) => [f.key, { at, repeat: f.payload.repeat, since: f.payload.since }]));

describe("member_quiet", () => {
  const room = (members = [who("m_a", { lastSentAt: T0 })]) => stored({ members }, quietOnly());

  it("names a member once quiet_after has passed since its last send, and not a moment before", () => {
    expect(dueFindings(room(), T0 + H2 - 1)).toEqual([]);
    expect(dueFindings(room(), T0 + H2)).toEqual([{
      key: "member_quiet:m_a",
      payload: { finding: "member_quiet", about: { member_id: "m_a" }, since: T0 + H2, repeat: 1 },
    }]);
  });

  it("counts a member that has not sent since joining from when it joined", () => {
    const s = room([who("m_a", { joinedAt: T0 })]);
    expect(dueFindings(s, T0 + H2 - 1)).toEqual([]);
    expect(keysOf(dueFindings(s, T0 + H2))).toEqual(["member_quiet:m_a"]);
  });

  it("never names a member who left", () => {
    const s = room([who("m_a", { lastSentAt: T0, leftAt: T0 + 1 }), who("m_b", { lastSentAt: T0 })]);
    expect(keysOf(dueFindings(s, T0 + H2))).toEqual(["member_quiet:m_b"]);
  });

  // A removal sets `leftAt` with the cut, so a member with the cut and no `leftAt` is not a state
  // the stores write. The rule asks both questions anyway, because "removed" is a fact of its own
  // that the feed already reads (#113), and this is the case that fails if it stops asking.
  it("never names a removed member", () => {
    const s = room([who("m_a", { lastSentAt: T0, removedAtCursor: 3 }), who("m_b", { lastSentAt: T0 })]);
    expect(keysOf(dueFindings(s, T0 + H2))).toEqual(["member_quiet:m_b"]);
  });

  it("names nobody when quiet_after is off", () => {
    const s = stored({ members: [who("m_a", { lastSentAt: T0 })] }, rules({ quietAfterMs: null }));
    const quiet = dueFindings(s, T0 + 30 * D1).filter((f) => f.payload.finding === "member_quiet");
    expect(quiet).toEqual([]);
  });
});

describe("request_unanswered", () => {
  const room = (over: Partial<StoredSession> = {}) =>
    stored({
      members: [who("m_a"), who("m_b")],
      openRequests: { "7": { at: T0, fromMemberId: "m_a" } },
      ...over,
    }, requestsOnly());

  it("names a request once answer_within has passed since it was asked, and not a moment before", () => {
    expect(dueFindings(room(), T0 + M30 - 1)).toEqual([]);
    expect(dueFindings(room(), T0 + M30)).toEqual([{
      key: "request_unanswered:7",
      payload: { finding: "request_unanswered", about: { cursor: 7 }, since: T0 + M30, repeat: 1 },
    }]);
  });

  it("names nothing when answer_within is off", () => {
    const s = stored({
      members: [who("m_a")], openRequests: { "7": { at: T0, fromMemberId: "m_a" } },
    }, rules({ answerWithinMs: null }));
    const unanswered = dueFindings(s, T0 + 30 * D1).filter((f) => f.payload.finding === "request_unanswered");
    expect(unanswered).toEqual([]);
  });

  // R5. The books close a leaver's requests to keep the record small, and a departure written by
  // another path could leave one behind. Whether a request is named is the rule's to decide.
  it("names a request only while its sender is in the room", () => {
    expect(keysOf(dueFindings(room(), T0 + M30))).toEqual(["request_unanswered:7"]);

    const left = room({ members: [who("m_a", { leftAt: T0 + 1 }), who("m_b")] });
    expect(dueFindings(left, T0 + M30)).toEqual([]);

    const removed = room({ members: [who("m_a", { removedAtCursor: 3 }), who("m_b")] });
    expect(dueFindings(removed, T0 + M30)).toEqual([]);
  });
});

describe("room_idle", () => {
  const room = (over: Partial<StoredSession> = {}) =>
    stored({ members: [who("m_a"), who("m_b")], lastMemberEventAt: T0, ...over }, idleOnly());

  it("names a room nobody has written to for idle_after, about nobody", () => {
    expect(dueFindings(room(), T0 + D1 - 1)).toEqual([]);
    const [finding] = dueFindings(room(), T0 + D1);
    expect(finding).toEqual({ key: "room_idle", payload: { finding: "room_idle", since: T0 + D1, repeat: 1 } });
    expect("about" in finding.payload).toBe(false);
  });

  it("counts a room with no member event from the latest join of those still in it", () => {
    const s = room({
      lastMemberEventAt: null,
      members: [who("m_a", { joinedAt: T0 - 500 }), who("m_b", { joinedAt: T0 }), who("m_gone", { joinedAt: T0 + 900, leftAt: T0 + 901 })],
    });
    expect(dueFindings(s, T0 + D1 - 1)).toEqual([]);
    expect(dueFindings(s, T0 + D1).map((f) => f.payload.since)).toEqual([T0 + D1]);
  });

  it("moves with a later member event", () => {
    const s = room({ lastMemberEventAt: T0 + 5_000 });
    expect(dueFindings(s, T0 + D1)).toEqual([]);
    expect(dueFindings(s, T0 + 5_000 + D1).map((f) => f.payload.since)).toEqual([T0 + 5_000 + D1]);
  });

  it("names nothing when idle_after is off", () => {
    const s = stored({ members: [who("m_a")], lastMemberEventAt: T0 }, rules({ idleAfterMs: null }));
    const idle = dueFindings(s, T0 + 30 * D1).filter((f) => f.payload.finding === "room_idle");
    expect(idle).toEqual([]);
  });
});

describe("repeating a finding", () => {
  const key = "member_quiet:m_a";
  const quiet = (raised: Raised, thresholds = quietOnly()) =>
    stored({ members: [who("m_a", { lastSentAt: T0 })], raised }, thresholds);

  it("holds a raised key back for a window, and raises it again at the end of it, counting up", () => {
    const s = quiet({ [key]: { at: T0 + H2, repeat: 1, since: T0 + H2 } });
    expect(dueFindings(s, T0 + H2 + 1)).toEqual([]);
    expect(dueFindings(s, T0 + 2 * H2 - 1)).toEqual([]);
    expect(dueFindings(s, T0 + 2 * H2)).toEqual([{
      key, payload: { finding: "member_quiet", about: { member_id: "m_a" }, since: T0 + H2, repeat: 2 },
    }]);

    const third = quiet({ [key]: { at: T0 + 2 * H2, repeat: 2, since: T0 + H2 } });
    expect(dueFindings(third, T0 + 3 * H2)[0].payload.repeat).toBe(3);
  });

  // Review Focus 4. Repeating faster than the threshold is a choice the manifest may make.
  it("uses repeat_after in place of the threshold, shorter or longer", () => {
    const shorter = quiet({ [key]: { at: T0 + H2, repeat: 1, since: T0 + H2 } }, quietOnly({ repeatAfterMs: M5 }));
    expect(dueFindings(shorter, T0 + H2 + M5 - 1)).toEqual([]);
    expect(dueFindings(shorter, T0 + H2 + M5)[0].payload.repeat).toBe(2);

    const longer = quiet({ [key]: { at: T0 + H2, repeat: 1, since: T0 + H2 } }, quietOnly({ repeatAfterMs: D1 }));
    expect(dueFindings(longer, T0 + H2 + D1 - 1)).toEqual([]);
    expect(dueFindings(longer, T0 + H2 + D1)[0].payload.repeat).toBe(2);
  });

  // Each finding repeats after its OWN threshold when repeat_after is absent.
  const windows: Array<[string, Thresholds, Partial<StoredSession>, string, number, number]> = [
    ["member_quiet", quietOnly(), { members: [who("m_a", { lastSentAt: T0 })] }, "member_quiet:m_a", T0 + H2, H2],
    ["request_unanswered", requestsOnly(), { members: [who("m_a")], openRequests: { "7": { at: T0, fromMemberId: "m_a" } } }, "request_unanswered:7", T0 + M30, M30],
    ["room_idle", idleOnly(), { members: [who("m_a")], lastMemberEventAt: T0 }, "room_idle", T0 + D1, D1],
  ];
  it.each(windows)("waits one %s threshold before raising it again", (_finding, thresholds, over, raisedKey, since, window) => {
    const raisedAt = since + 1_000;
    const s = stored({ ...over, raised: { [raisedKey]: { at: raisedAt, repeat: 1, since } } }, thresholds);
    expect(dueFindings(s, raisedAt + window - 1)).toEqual([]);
    expect(keysOf(dueFindings(s, raisedAt + window))).toEqual([raisedKey]);
  });

  // R8. The member sent after the raise and went quiet again before any firing cleared the key,
  // so the record still holds the old raise. This is a new condition, not the old one repeating.
  it("starts a condition that came back at repeat 1, from its own since", () => {
    const sentAgain = T0 + H2 + 10;
    const s = stored({
      members: [who("m_a", { lastSentAt: sentAgain })],
      raised: { [key]: { at: T0 + H2, repeat: 1, since: T0 + H2 } },
    }, quietOnly());

    expect(dueFindings(s, sentAgain + H2 - 1)).toEqual([]);
    expect(dueFindings(s, sentAgain + H2)).toEqual([{
      key, payload: { finding: "member_quiet", about: { member_id: "m_a" }, since: sentAgain + H2, repeat: 1 },
    }]);
  });
});

describe("clearedKeys", () => {
  const quietKey = "member_quiet:m_a";
  const raisedQuiet: Raised = { [quietKey]: { at: T0 + H2, repeat: 1, since: T0 + H2 } };

  it("returns a raised quiet key once its member has sent, and keeps it while the member is quiet", () => {
    const stillQuiet = stored({ members: [who("m_a", { lastSentAt: T0 })], raised: raisedQuiet }, quietOnly());
    expect(clearedKeys(stillQuiet, T0 + H2 + 1)).toEqual([]);

    const sent = stored({ members: [who("m_a", { lastSentAt: T0 + H2 + 5 })], raised: raisedQuiet }, quietOnly());
    expect(clearedKeys(sent, T0 + H2 + 10)).toEqual([quietKey]);
  });

  // Review Focus 1. A request answered after it was raised leaves `openRequests`, and its key has
  // to go with it, or a request that is answered is still on the record as raised.
  it("returns a raised request key once its cursor is no longer open, and keeps it while it is", () => {
    const raised: Raised = { "request_unanswered:7": { at: T0 + M30, repeat: 1, since: T0 + M30 } };
    const open = stored({
      members: [who("m_a")], openRequests: { "7": { at: T0, fromMemberId: "m_a" } }, raised,
    }, requestsOnly());
    expect(clearedKeys(open, T0 + M30 + 1)).toEqual([]);

    const answered = stored({ members: [who("m_a")], openRequests: {}, raised }, requestsOnly());
    expect(clearedKeys(answered, T0 + M30 + 1)).toEqual(["request_unanswered:7"]);
  });

  it("returns a raised idle key after a member event, and keeps it while the room is idle", () => {
    const raised: Raised = { room_idle: { at: T0 + D1, repeat: 1, since: T0 + D1 } };
    const idle = stored({ members: [who("m_a")], lastMemberEventAt: T0, raised }, idleOnly());
    expect(clearedKeys(idle, T0 + D1 + 1)).toEqual([]);

    const woke = stored({ members: [who("m_a")], lastMemberEventAt: T0 + D1 + 5, raised }, idleOnly());
    expect(clearedKeys(woke, T0 + D1 + 10)).toEqual(["room_idle"]);
  });

  it("returns the key of a member who has gone", () => {
    const gone = stored({
      members: [who("m_a", { lastSentAt: T0, leftAt: T0 + H2 + 1 }), who("m_b", { lastSentAt: T0 })], raised: raisedQuiet,
    }, quietOnly());
    expect(clearedKeys(gone, T0 + H2 + 2)).toEqual([quietKey]);
  });

  // Nothing is evaluated for a room that is closed or frozen, so nothing is judged cleared in one:
  // the record is left as it was for the room that thaws.
  it("clears nothing in a room whose rules are not being evaluated", () => {
    const members = [who("m_a", { lastSentAt: T0 + H2 + 5 })];
    expect(clearedKeys(stored({ members, raised: raisedQuiet, frozenAt: T0 }, quietOnly()), T0 + H2 + 10)).toEqual([]);
    expect(clearedKeys(stored({ members, raised: raisedQuiet, closed: true }, quietOnly()), T0 + H2 + 10)).toEqual([]);
  });
});

describe("nextHousekeepAt", () => {
  const members = () => [who("m_a", { lastSentAt: T0 })];

  it("is null for a room that declared no housekeeping", () => {
    expect(nextHousekeepAt(stored({ members: members() }, null), T0)).toBeNull();
  });

  it("is null for a closed room and for a frozen room", () => {
    expect(nextHousekeepAt(stored({ members: members(), closed: true }), T0)).toBeNull();
    expect(nextHousekeepAt(stored({ members: members(), frozenAt: T0 }), T0)).toBeNull();
  });

  // Review Focus 2. Deriving a time for a room with nobody in it would arm the alarm for a room
  // that is about to close, and nothing in it could answer a finding.
  it("is null for a room with no member in it", () => {
    expect(nextHousekeepAt(stored({ members: [] }), T0)).toBeNull();
    expect(nextHousekeepAt(stored({ members: [who("m_a", { leftAt: T0 })] }), T0)).toBeNull();
    expect(nextHousekeepAt(stored({ members: [who("m_a", { removedAtCursor: 3 })] }), T0)).toBeNull();
  });

  it("is null when nothing could become due", () => {
    expect(nextHousekeepAt(stored({ members: members() }, requestsOnly()), T0)).toBeNull();
  });

  it("is the soonest of the anchors", () => {
    const s = stored({
      members: [who("m_a", { lastSentAt: T0 }), who("m_b", { lastSentAt: T0 + 1_000 })],
      openRequests: { "7": { at: T0 + 100, fromMemberId: "m_a" } },
      lastMemberEventAt: T0 + 500,
    });
    // The request is asked at T0 + 100 and answered within 30m; the quiet members are 2h out, the room a day out.
    expect(nextHousekeepAt(s, T0)).toBe(T0 + 100 + M30);

    const noRequest = { ...s, openRequests: {} };
    expect(nextHousekeepAt(noRequest, T0)).toBe(T0 + H2);
  });

  it("is the raise plus the window for a condition already raised, and not the anchor in the past", () => {
    const raised: Raised = { "member_quiet:m_a": { at: T0 + H2 + 5, repeat: 1, since: T0 + H2 } };
    expect(nextHousekeepAt(stored({ members: members(), raised }, quietOnly()), T0 + H2 + 5)).toBe(T0 + H2 + 5 + H2);
    expect(nextHousekeepAt(stored({ members: members(), raised }, quietOnly({ repeatAfterMs: M5 })), T0 + H2 + 5))
      .toBe(T0 + H2 + 5 + M5);
  });

  // R8, for the clock. A raise made for a condition that has since come back says nothing about
  // when the new one is due, and counting it would wait out a window that was never owed.
  it("ignores a raise made for a condition that has since come back", () => {
    const sentAgain = T0 + H2 + 10;
    const s = stored({
      members: [who("m_a", { lastSentAt: sentAgain })],
      raised: { "member_quiet:m_a": { at: T0 + H2, repeat: 1, since: T0 + H2 } },
    }, quietOnly({ repeatAfterMs: 2 * D1 }));
    expect(nextHousekeepAt(s, sentAgain)).toBe(sentAgain + H2);
  });

  it("ignores a request whose sender has gone", () => {
    const s = stored({
      members: [who("m_a", { leftAt: T0 + 1 }), who("m_b")],
      openRequests: { "7": { at: T0, fromMemberId: "m_a" } },
    }, requestsOnly());
    expect(nextHousekeepAt(s, T0)).toBeNull();
  });

  // R4. "Due" and "next" read one list of anchors, so the alarm is armed for a moment something
  // is due and for none before it. A firing that finds nothing due re-arms at the same time and
  // spins; this pins both halves across the states above.
  it("names a moment something is due, and none before it is", () => {
    const states: StoredSession[] = [
      stored({ members: [who("m_a", { lastSentAt: T0 }), who("m_b", { lastSentAt: T0 + 7 })] }),
      stored({ members: [who("m_a")], openRequests: { "7": { at: T0 + 3, fromMemberId: "m_a" } } }, requestsOnly()),
      stored({ members: [who("m_a")], lastMemberEventAt: T0 + 11 }, idleOnly()),
      stored({ members: members(), raised: { "member_quiet:m_a": { at: T0 + H2 + 5, repeat: 1, since: T0 + H2 } } }, quietOnly()),
      stored({ members: members(), raised: { "member_quiet:m_a": { at: T0 + H2, repeat: 4, since: T0 + 1 } } }, quietOnly()),
    ];
    for (const s of states) {
      const at = nextHousekeepAt(s, T0)!;
      expect(at).not.toBeNull();
      expect(dueFindings(s, at).length, `something is due at ${at}`).toBeGreaterThan(0);
      expect(dueFindings(s, at - 1), `nothing is due at ${at - 1}`).toEqual([]);
    }
  });

  // The spin property, pinned as nextTickAt's is. A finding raised at `now` moves nobody's
  // anchor, so a due time resting on the anchor stays in the past for as long as the condition
  // holds, and re-arming from it would fire the alarm back to back for good.
  it("is strictly after now once every due key has just been raised", () => {
    const now = T0 + 2 * D1;
    for (const thresholds of [rules(), rules({ repeatAfterMs: M5 }), rules({ repeatAfterMs: 3 * D1 })]) {
      const s = stored({
        members: [who("m_a", { lastSentAt: T0 }), who("m_b", { lastSentAt: T0 + 50 })],
        openRequests: { "7": { at: T0, fromMemberId: "m_a" }, "9": { at: T0 + 70, fromMemberId: "m_b" } },
        lastMemberEventAt: T0 + 100,
      }, thresholds);

      const due = dueFindings(s, now);
      expect(due.length, "two quiet members, two requests and an idle room").toBe(5);
      const after = { ...s, raised: raisedBy(due, now) };

      const next = nextHousekeepAt(after, now)!;
      expect(next).toBeGreaterThan(now);
      // And exactly one window out for the shortest: the arithmetic, not only the direction.
      expect(next).toBe(now + (thresholds.repeatAfterMs ?? M30));
      // Nothing is due at the moment it was raised, so a firing there has nothing to find.
      expect(dueFindings(after, now)).toEqual([]);
    }
  });
});

// R9. While a room is frozen nobody can send and no request can be answered, so a finding
// computed across the freeze names a condition the room imposed. Heartbeat refuses the same for
// the tick (`clearSilence` at the thaw, D10); here the thaw is a floor under every base time.
describe("a thaw restarts the clocks", () => {
  // Frozen for ten days: every threshold the room declares has long passed by the thaw.
  const THAW = T0 + 10 * D1;

  it("floors a member's quiet clock at the thaw", () => {
    const s = stored({ members: [who("m_a", { lastSentAt: T0 })], thawedAt: THAW }, quietOnly());
    expect(dueFindings(s, THAW)).toEqual([]);
    expect(dueFindings(s, THAW + H2 - 1)).toEqual([]);
    expect(dueFindings(s, THAW + H2)).toEqual([{
      key: "member_quiet:m_a",
      payload: { finding: "member_quiet", about: { member_id: "m_a" }, since: THAW + H2, repeat: 1 },
    }]);
    expect(nextHousekeepAt(s, THAW)).toBe(THAW + H2);
  });

  it("floors a request at the thaw", () => {
    const s = stored({
      members: [who("m_a")], openRequests: { "7": { at: T0, fromMemberId: "m_a" } }, thawedAt: THAW,
    }, requestsOnly());
    expect(dueFindings(s, THAW + M30 - 1)).toEqual([]);
    expect(dueFindings(s, THAW + M30)).toEqual([{
      key: "request_unanswered:7",
      payload: { finding: "request_unanswered", about: { cursor: 7 }, since: THAW + M30, repeat: 1 },
    }]);
    expect(nextHousekeepAt(s, THAW)).toBe(THAW + M30);
  });

  it("floors the last member event at the thaw, and a room with none from its latest join", () => {
    const members = [who("m_a")];
    const withEvent = stored({ members, lastMemberEventAt: T0, thawedAt: THAW }, idleOnly());
    expect(dueFindings(withEvent, THAW + D1 - 1)).toEqual([]);
    expect(dueFindings(withEvent, THAW + D1)[0].payload.since).toBe(THAW + D1);

    const noEvent = stored({ members, lastMemberEventAt: null, thawedAt: THAW }, idleOnly());
    expect(nextHousekeepAt(noEvent, THAW)).toBe(THAW + D1);
  });

  it("leaves a time after the thaw where it was", () => {
    const sentAfter = stored({ members: [who("m_a", { lastSentAt: THAW + 5 })], thawedAt: THAW }, quietOnly());
    expect(nextHousekeepAt(sentAfter, THAW)).toBe(THAW + 5 + H2);

    // And a thaw older than the base time floors nothing: the room was thawed long before.
    const thawedBefore = stored({ members: [who("m_a", { lastSentAt: T0 + D1 })], thawedAt: T0 }, quietOnly());
    expect(nextHousekeepAt(thawedBefore, T0)).toBe(T0 + D1 + H2);
  });

  it("brings each finding back one threshold after the thaw, and none before", () => {
    const s = stored({
      members: [who("m_a", { lastSentAt: T0 })],
      openRequests: { "7": { at: T0, fromMemberId: "m_a" } },
      lastMemberEventAt: T0,
      thawedAt: THAW,
    });
    expect(dueFindings(s, THAW + M30 - 1)).toEqual([]);
    expect(keysOf(dueFindings(s, THAW + M30))).toEqual(["request_unanswered:7"]);
    expect(keysOf(dueFindings(s, THAW + H2))).toEqual(["member_quiet:m_a", "request_unanswered:7"]);
    expect(keysOf(dueFindings(s, THAW + D1))).toEqual(["member_quiet:m_a", "request_unanswered:7", "room_idle"]);
    expect(nextHousekeepAt(s, THAW)).toBe(THAW + M30);
  });

  // With R8: the raise was made for the condition as it stood before the freeze, and the floor
  // moves its anchor, so what comes due after the thaw is a new condition at repeat 1.
  it("treats a key raised before the freeze as a condition that came back", () => {
    const key = "member_quiet:m_a";
    const s = stored({
      members: [who("m_a", { lastSentAt: T0 })],
      raised: { [key]: { at: T0 + H2, repeat: 3, since: T0 + H2 } },
      thawedAt: THAW,
    }, quietOnly());

    expect(clearedKeys(s, THAW + 1)).toEqual([key]);
    expect(dueFindings(s, THAW + H2)).toEqual([{
      key, payload: { finding: "member_quiet", about: { member_id: "m_a" }, since: THAW + H2, repeat: 1 },
    }]);
  });
});

describe("the rules", () => {
  it("do not write into the session they read", () => {
    const s = stored({
      members: [who("m_a", { lastSentAt: T0 })],
      openRequests: { "7": { at: T0, fromMemberId: "m_a" } },
      raised: { "member_quiet:m_a": { at: T0 + H2, repeat: 1, since: T0 + H2 } },
    });
    const before = structuredClone(s);
    dueFindings(s, T0 + 3 * D1);
    clearedKeys(s, T0 + 3 * D1);
    nextHousekeepAt(s, T0 + 3 * D1);
    expect(s).toEqual(before);
  });
});
