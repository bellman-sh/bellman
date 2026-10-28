/**
 * `roomSummary` is what `bellman_rooms` returns per room, and `beatOf` is the
 * member's heartbeat standing inside it (#28). Pure: a stored session, a seat, the
 * sockets, the tail of the log and a clock go in; the wire object comes out. The
 * tool test (tests/tools/rooms.test.ts) drives the same shaping through MCP; this
 * file pins the rules that are easier to see with a hand-built session.
 */
import { describe, it, expect } from "vitest";
import { beatOf, roomPreview, roomSummary } from "../src/projections.js";
import { reportRow } from "../src/heartbeat.js";
import { member, roomManifest, session } from "./helpers/fixtures.js";
import type { StoredSession } from "../src/stored-session.js";
import type { SessionEvent } from "../src/types.js";

const T0 = Date.parse("2026-03-15T12:00:00Z");
const FIVE_MIN = 300_000;
const NONE: ReadonlySet<string> = new Set();

const manifest = roomManifest({
  mode: "swarm",
  preset: null,
  roles: {
    lead: { can: ["send", "invite", "revoke", "request_actions", "respond_actions"], description: "runs it", reports: true },
    helper: { can: ["send"], description: null, reports: false },
  },
  defaultRole: "helper",
  creatorRole: "lead",
  heartbeatOnMs: FIVE_MIN,
});

const lead = member({ memberId: "m_lead", userId: "u_lead", label: "lead@a", roomRole: "lead", joinedAt: T0, lastSeenAt: T0 });
const helper = member({ memberId: "m_help", userId: "u_help", label: "help@b", roomRole: "helper", joinedAt: T0, lastSeenAt: T0 });

function stored(over: Partial<StoredSession> = {}): StoredSession {
  const { events, ...rest } = session({ manifest, members: [lead, helper] });
  return { ...rest, ...over } as StoredSession;
}

const progress = (cursor: number, from: typeof lead, note: string): SessionEvent => ({
  cursor, type: "progress", fromMemberId: from.memberId, fromUserId: from.userId,
  fromLabel: from.label, payload: { note }, refId: null, at: T0 + cursor,
});

describe("roomSummary", () => {
  it("shows the code string and link only to a seat holding invite", () => {
    const s = stored({ joinCodes: { helper: { code: "BELL-AAAA-11-HELPER", expiresAt: T0 + 60_000 } } });
    const asLead = roomSummary(s, [lead], NONE, [], T0);
    const asHelper = roomSummary(s, [helper], NONE, [], T0);
    expect(asLead.join_codes).toEqual([{
      role: "helper", expires_at: new Date(T0 + 60_000).toISOString(),
      code: "BELL-AAAA-11-HELPER", join_url: "https://bellman.sh/j/BELL-AAAA-11-HELPER",
    }]);
    expect(asHelper.join_codes).toEqual([{ role: "helper", expires_at: new Date(T0 + 60_000).toISOString() }]);
  });

  // Review Focus 2: the record outlives the code it names.
  it("leaves out a code that has expired", () => {
    const s = stored({ joinCodes: { helper: { code: "BELL-AAAA-11-HELPER", expiresAt: T0 - 1 } } });
    expect(roomSummary(s, [lead], NONE, [], T0).join_codes).toEqual([]);
  });

  // ADR 0020: a permanent code is live at any hour, and has no time to give.
  it("lists a permanent code a week on, with no expiry", () => {
    const s = stored({ joinCodes: { helper: { code: "BELL-AAAA-11-HELPER", expiresAt: null } } });
    expect(roomSummary(s, [lead], NONE, [], T0 + 7 * 86_400_000).join_codes).toEqual([{
      role: "helper", expires_at: null,
      code: "BELL-AAAA-11-HELPER", join_url: "https://bellman.sh/j/BELL-AAAA-11-HELPER",
    }]);
  });

  it("reads the room from the caller's seat, and lists live members with their roles", () => {
    const gone = member({ memberId: "m_gone", userId: "u_gone", label: "gone@c", roomRole: "helper", leftAt: T0 });
    const s = stored({ members: [lead, helper, gone] });
    const out = roomSummary(s, [helper], NONE, [], T0);
    expect(out.your_member_id).toBe("m_help");
    expect(out.your_seats).toEqual([{ member_id: "m_help", role: "helper", verbs: ["send"] }]);
    expect(out.room.your_role).toBe("helper");
    expect(out.room.your_verbs).toEqual(["send"]);
    expect(out.members.map((m) => [m.member_id, m.room_role])).toEqual([["m_lead", "lead"], ["m_help", "helper"]]);
    expect(out.active_members).toBe(2);
    expect(out.status).toBe("active");
  });

  it("takes each member's latest progress note from the tail, wrapped as untrusted, and the last event", () => {
    const tail = [progress(1, lead, "first"), progress(2, helper, "mine"), progress(3, lead, "latest")];
    const out = roomSummary(stored(), [lead], NONE, tail, T0);
    expect(out.members[0].beat.note).toEqual({
      trust: "untrusted", origin: { memberId: "m_lead", label: "lead@a" }, data: { note: "latest" },
    });
    expect(out.members[1].beat.note?.data).toEqual({ note: "mine" });
    expect(out.last_event).toEqual({ cursor: 3, type: "progress", at: new Date(T0 + 3).toISOString() });
    expect(roomSummary(stored(), [lead], NONE, [], T0).last_event).toBeNull();
  });

  // One account, two seats: the lead it joined first and a helper it joined after, from a second machine.
  // joinedAt ties on purpose: the order comes from the join order the store gave (seq), and two joins in
  // one millisecond must not come back in whatever order the caller happened to hold them.
  describe("when the caller holds several seats", () => {
    const first = member({ memberId: "m_first", userId: "u_me", label: "me@a", roomRole: "lead", seq: 1, joinedAt: T0, lastSeenAt: T0 });
    const second = member({ memberId: "m_second", userId: "u_me", label: "me@a", roomRole: "helper", seq: 2, joinedAt: T0, lastSeenAt: T0 });
    const third = member({ memberId: "m_third", userId: "u_me", label: "me@a", roomRole: "helper", seq: 3, joinedAt: T0, lastSeenAt: T0 });
    const code = { helper: { code: "BELL-AAAA-11-HELPER", expiresAt: T0 + 60_000 } };

    it("lists every seat, oldest first, whatever order they are handed in", () => {
      const s = stored({ members: [first, second, third] });
      const seats = [
        { member_id: "m_first", role: "lead", verbs: ["send", "invite", "revoke", "request_actions", "respond_actions"] },
        { member_id: "m_second", role: "helper", verbs: ["send"] },
        { member_id: "m_third", role: "helper", verbs: ["send"] },
      ];
      expect(roomSummary(s, [first, second, third], NONE, [], T0).your_seats).toEqual(seats);
      expect(roomSummary(s, [third, first, second], NONE, [], T0).your_seats).toEqual(seats);
    });

    it("names none as the caller's, and gives the room block the empty form roomPreview has for no seat", () => {
      const s = stored({ members: [first, second] });
      const out = roomSummary(s, [second, first], NONE, [], T0);
      expect(out.your_member_id).toBeNull();
      expect(out.room).toMatchObject({ your_role: null, your_verbs: [], your_heartbeat_on: false });
      expect(out.room).toEqual(roomPreview(s, null));
    });

    it("shows a code's string and link when any seat holds invite, and not when none does", () => {
      const s = stored({ members: [first, second, third], joinCodes: code });
      const bare = { role: "helper", expires_at: new Date(T0 + 60_000).toISOString() };
      const shown = { ...bare, code: "BELL-AAAA-11-HELPER", join_url: "https://bellman.sh/j/BELL-AAAA-11-HELPER" };
      // The lead holds invite and the helpers do not, whichever of them is listed first or last.
      expect(roomSummary(s, [first, second], NONE, [], T0).join_codes).toEqual([shown]);
      expect(roomSummary(s, [second, first], NONE, [], T0).join_codes).toEqual([shown]);
      // Two helpers: neither can mint a code, so neither route shows one.
      expect(roomSummary(s, [second, third], NONE, [], T0).join_codes).toEqual([bare]);
    });
  });
});

// A hosted room's instructions ride in the room block for the account that created the room (the preview's own rule).
// `bellman_rooms` is called by an account, so the account is named beside the seats it holds.
describe("roomSummary and a hosted room's instructions", () => {
  const TEXT = "Ask about the week.";
  const hosted = roomManifest({
    ...manifest,
    roles: { ...manifest.roles, host: { can: ["send"], description: null, reports: false } },
    host: { role: "host", model: "haiku", instructions: TEXT },
  });
  const room = () => stored({ createdBy: "u_lead", manifest: hosted });

  it("carries them for the creator's account, and for no other", () => {
    const mine = roomSummary(room(), [lead], NONE, [], T0, "u_lead");
    expect(mine.room.text.data.host_instructions).toBe(TEXT);
    const theirs = roomSummary(room(), [helper], NONE, [], T0, "u_help");
    expect(theirs.room.text.data).not.toHaveProperty("host_instructions");
    expect(JSON.stringify(theirs)).not.toContain(TEXT);
  });

  it("leaves them out when the account is not named", () => {
    expect(roomSummary(room(), [lead], NONE, [], T0).room.text.data).not.toHaveProperty("host_instructions");
  });

  it("carries them with several seats too: the account is the creator whichever seat is asking", () => {
    const second = member({ memberId: "m_second", userId: "u_lead", label: "lead@a", roomRole: "lead", seq: 2, joinedAt: T0, lastSeenAt: T0 });
    const out = roomSummary(room(), [lead, second], NONE, [], T0, "u_lead");
    expect(out.your_member_id).toBeNull();
    expect(out.room.your_role).toBeNull();
    expect(out.room.text.data.host_instructions).toBe(TEXT);
  });
});

// #432: every seat is working, idle or needs_you, and the room counts the seats waiting on their humans.
describe("roomSummary seat status", () => {
  const granting = (m: typeof lead) => ({ ...m, capabilities: [...m.capabilities, "request_actions" as const] });
  const room = () => stored({ members: [granting(lead), granting(helper)] });
  const BOTH: ReadonlySet<string> = new Set([lead.memberId, helper.memberId]);
  const event = (cursor: number, from: typeof lead, type: SessionEvent["type"], payload: unknown, refId: string | null = null): SessionEvent => ({
    cursor, type, fromMemberId: from.memberId, fromUserId: from.userId, fromLabel: from.label, payload, refId, at: T0 + cursor,
  });
  const ask = (cursor: number, from: typeof lead) => event(cursor, from, "action_request", { action: "deploy" });
  const report = (cursor: number, from: typeof lead, status: string) => event(cursor, from, "progress", { note: "n", status });
  const statusOf = (out: ReturnType<typeof roomSummary>, id: string) => {
    const m = out.members.find((x) => x.member_id === id)!;
    return [m.status, m.status_source, m.needs_you];
  };

  it("derives needs_you for a seat that can answer a peer's outstanding request, and not for its sender", () => {
    const out = roomSummary(room(), [lead], BOTH, [ask(1, helper)], T0);
    expect(statusOf(out, "m_lead")).toEqual(["needs_you", "derived", true]);
    expect(statusOf(out, "m_help")).toEqual(["working", "presence", false]);
    expect(out.needs_you_count).toBe(1);
  });

  // The helper's role holds no respond_actions, so nothing it is shown is a question it could answer.
  it("does not flag a seat whose role cannot answer, or one that granted no request_actions", () => {
    expect(statusOf(roomSummary(room(), [lead], BOTH, [ask(1, lead)], T0), "m_help")[2]).toBe(false);
    const ungranted = stored({ members: [lead, granting(helper)] });
    expect(statusOf(roomSummary(ungranted, [lead], BOTH, [ask(1, helper)], T0), "m_lead")[2]).toBe(false);
  });

  it.each([
    ["answered", [ask(1, helper), event(2, lead, "action_response", { approved: true }, "1")], T0],
    ["declined", [ask(1, helper), event(2, lead, "action_response", { approved: false }, "1")], T0],
    ["expired", [ask(1, helper)], T0 + 31 * 60_000],
  ])("clears needs_you once the request is %s", (_state, tail, now) => {
    const out = roomSummary(room(), [lead], BOTH, tail as SessionEvent[], now as number);
    expect(statusOf(out, "m_lead")[2]).toBe(false);
    expect(out.needs_you_count).toBe(0);
  });

  it("takes a present seat's latest reported status, and the derived needs_you over it", () => {
    const tail = [report(1, helper, "needs_you"), report(2, helper, "idle"), report(3, lead, "working")];
    const out = roomSummary(room(), [lead], BOTH, tail, T0);
    expect(statusOf(out, "m_help")).toEqual(["idle", "reported", false]);
    expect(statusOf(out, "m_lead")).toEqual(["working", "reported", false]);
    // A claim about the report's time, never about now: the time rides beside it.
    expect(out.members.find((m) => m.member_id === "m_help")!.status_at).toBe(new Date(T0 + 2).toISOString());
    expect(roomSummary(room(), [lead], BOTH, [], T0).members[0].status_at).toBeNull();
    const waiting = roomSummary(room(), [lead], BOTH, [...tail, ask(4, helper)], T0);
    expect(statusOf(waiting, "m_lead")).toEqual(["needs_you", "derived", true]);
    // A seat may say it needs its human, and is counted for it.
    const asking = roomSummary(room(), [lead], BOTH, [report(1, helper, "needs_you")], T0);
    expect(statusOf(asking, "m_help")).toEqual(["needs_you", "reported", true]);
    expect(asking.needs_you_count).toBe(1);
  });

  // A hook's status-only report changes the status and leaves the beat's note on the last report that had one.
  it("keeps the latest note through a status-only report", () => {
    const tail = [event(1, helper, "progress", { note: "on the migration" }), event(2, helper, "progress", { status: "idle" })];
    const help = roomSummary(room(), [lead], BOTH, tail, T0).members.find((m) => m.member_id === "m_help")!;
    expect(help.beat.note?.data).toEqual({ note: "on the migration" });
    expect([help.status, help.status_source]).toEqual(["idle", "reported"]);
  });

  it("falls back to presence: a stale seat is idle whatever it last reported, and so is a silent one", () => {
    const later = T0 + 11 * 60_000;
    const stale = roomSummary(room(), [lead], NONE, [report(1, helper, "working")], later);
    expect(statusOf(stale, "m_help")).toEqual(["idle", "presence", false]);
    // Present on a socket, but asked to report and silent past the cadence.
    expect(statusOf(roomSummary(room(), [lead], BOTH, [], later), "m_lead")).toEqual(["idle", "presence", false]);
  });
});

describe("beatOf", () => {
  it("is the tick's row for an asked seat", () => {
    const s = stored({ members: [{ ...lead, lastReportAt: T0 }, helper] });
    const now = T0 + 2 * FIVE_MIN;
    const row = reportRow(s.members[0], now, FIVE_MIN);
    expect(beatOf(s, s.members[0], now, undefined)).toEqual({
      asked: true, last_report_at: row.last_report_at, silent_for_seconds: row.silent_for_seconds,
      silent: true, note: null,
    });
  });

  it("is never silent for a seat the room does not ask, and never in a room with no cadence", () => {
    const s = stored();
    expect(beatOf(s, helper, T0 + 10 * FIVE_MIN, undefined)).toMatchObject({ asked: false, silent: false });
    const quiet = stored({ manifest: { ...manifest, heartbeatOnMs: null } });
    expect(beatOf(quiet, lead, T0 + 10 * FIVE_MIN, undefined)).toMatchObject({ asked: false, silent: false });
  });
});
