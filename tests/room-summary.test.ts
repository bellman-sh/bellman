/**
 * `roomSummary` is what `bellman_rooms` returns per room, and `beatOf` is the
 * member's heartbeat standing inside it (#28). Pure: a stored session, a seat, the
 * sockets, the tail of the log and a clock go in; the wire object comes out. The
 * tool test (tests/tools/rooms.test.ts) drives the same shaping through MCP; this
 * file pins the rules that are easier to see with a hand-built session.
 */
import { describe, it, expect } from "vitest";
import { beatOf, roomSummary } from "../src/projections.js";
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
  const { events, ...rest } = session({ manifest, maxMembers: 8, members: [lead, helper] });
  return { ...rest, ...over } as StoredSession;
}

const progress = (cursor: number, from: typeof lead, note: string): SessionEvent => ({
  cursor, type: "progress", fromMemberId: from.memberId, fromUserId: from.userId,
  fromLabel: from.label, payload: { note }, refId: null, at: T0 + cursor,
});

describe("roomSummary", () => {
  it("shows the code string and link only to a seat holding invite", () => {
    const s = stored({ joinCodes: { helper: { code: "BELL-AAAA-11-HELPER", expiresAt: T0 + 60_000 } } });
    const asLead = roomSummary(s, lead, NONE, [], T0);
    const asHelper = roomSummary(s, helper, NONE, [], T0);
    expect(asLead.join_codes).toEqual([{
      role: "helper", expires_at: new Date(T0 + 60_000).toISOString(),
      code: "BELL-AAAA-11-HELPER", join_url: "https://bellman.sh/j/BELL-AAAA-11-HELPER",
    }]);
    expect(asHelper.join_codes).toEqual([{ role: "helper", expires_at: new Date(T0 + 60_000).toISOString() }]);
  });

  // Review Focus 2: the record outlives the code it names.
  it("leaves out a code that has expired", () => {
    const s = stored({ joinCodes: { helper: { code: "BELL-AAAA-11-HELPER", expiresAt: T0 - 1 } } });
    expect(roomSummary(s, lead, NONE, [], T0).join_codes).toEqual([]);
  });

  it("reads the room from the caller's seat, and lists live members with their roles", () => {
    const gone = member({ memberId: "m_gone", userId: "u_gone", label: "gone@c", roomRole: "helper", leftAt: T0 });
    const s = stored({ members: [lead, helper, gone] });
    const out = roomSummary(s, helper, NONE, [], T0);
    expect(out.your_member_id).toBe("m_help");
    expect(out.room.your_role).toBe("helper");
    expect(out.room.your_verbs).toEqual(["send"]);
    expect(out.members.map((m) => [m.member_id, m.room_role])).toEqual([["m_lead", "lead"], ["m_help", "helper"]]);
    expect(out.active_members).toBe(2);
    expect(out.status).toBe("active");
  });

  it("takes each member's latest progress note from the tail, wrapped as untrusted, and the last event", () => {
    const tail = [progress(1, lead, "first"), progress(2, helper, "mine"), progress(3, lead, "latest")];
    const out = roomSummary(stored(), lead, NONE, tail, T0);
    expect(out.members[0].beat.note).toEqual({
      trust: "untrusted", origin: { memberId: "m_lead", label: "lead@a" }, data: { note: "latest" },
    });
    expect(out.members[1].beat.note?.data).toEqual({ note: "mine" });
    expect(out.last_event).toEqual({ cursor: 3, type: "progress", at: new Date(T0 + 3).toISOString() });
    expect(roomSummary(stored(), lead, NONE, [], T0).last_event).toBeNull();
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
