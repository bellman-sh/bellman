import { describe, it, expect } from "vitest";
import { clearSilence, lastReport, nextTickAt, dueMembers, snapshotOf } from "../src/heartbeat.js";
import { member, roomManifest, session } from "./helpers/fixtures.js";
import type { StoredSession } from "../src/stored-session.js";

const T0 = Date.parse("2026-03-15T12:00:00Z");
const FIVE_MIN = 300_000;

const manifest = roomManifest({
  roles: {
    lead: { can: ["send"], description: null, reports: true },
    observer: { can: [], description: null, reports: false },
  },
  defaultRole: "observer",
  creatorRole: "lead",
  heartbeatOnMs: FIVE_MIN,
});

/** A StoredSession is a Session without its events. */
function stored(over: Partial<StoredSession> = {}): StoredSession {
  const { events, ...rest } = session({ manifest });
  return { ...rest, ...over } as StoredSession;
}

const lead = (over = {}) =>
  member({ memberId: "m_lead", label: "lead@a", roomRole: "lead", joinedAt: T0, ...over });
const watcher = (over = {}) =>
  member({ memberId: "m_obs", label: "obs@b", roomRole: "observer", joinedAt: T0, ...over });

describe("nextTickAt", () => {
  /**
   * Review Focus 2. A tick does not move lastReportAt — only a reply does — so a
   * due time computed from member reports stays in the past for a member that
   * never answers, and reArm() would fire the alarm back to back for good. The
   * clock anchors on lastTickAt, which strictly advances.
   */
  it("advances with lastTickAt, so a silent member cannot spin the alarm", () => {
    const s = stored({ members: [lead()], lastTickAt: T0 });
    expect(nextTickAt(s)).toBe(T0 + FIVE_MIN);

    // One firing later, the member still having reported nothing.
    const after = stored({ members: [lead()], lastTickAt: T0 + FIVE_MIN });
    expect(nextTickAt(after)).toBe(T0 + 2 * FIVE_MIN);
  });

  it("anchors on the earliest reporting member before any tick has fired", () => {
    const s = stored({ members: [lead({ joinedAt: T0 + 1_000 })], lastTickAt: undefined });
    expect(nextTickAt(s)).toBe(T0 + 1_000 + FIVE_MIN);
  });

  it("returns a past time at most once, and converges after one firing", () => {
    const asleep = stored({ members: [lead()], lastTickAt: T0 - 10 * FIVE_MIN });
    expect(nextTickAt(asleep)).toBeLessThan(T0);
    const woken = stored({ members: [lead()], lastTickAt: T0 });
    expect(nextTickAt(woken)).toBe(T0 + FIVE_MIN);
  });

  it("arms nothing when the room declares no cadence", () => {
    const s = { ...stored({ members: [lead()] }), manifest: roomManifest() } as StoredSession;
    expect(nextTickAt(s)).toBe(null);

    // The room above has no `lead` seat, so the empty-roster guard answers null
    // even with the cadence guard gone. Here a seat that reports is present and
    // only the cadence is missing — a legal manifest: `reports` without `heartbeat_on`.
    const undeclared = stored({ members: [lead()], manifest: { ...manifest, heartbeatOnMs: null } });
    expect(nextTickAt(undeclared)).toBe(null);
  });

  // With one member, min and max and "every member" are the same number, so the
  // anchor test above cannot tell them apart. Three can: the observer joined
  // first but is not asked, and of the two seats that are, the earlier one starts
  // the clock.
  it("starts the clock at the earliest member that must report, and nobody else", () => {
    const s = stored({
      members: [
        watcher({ joinedAt: T0 - 9_000 }),
        lead({ memberId: "m_late", joinedAt: T0 + 4_000 }),
        lead({ memberId: "m_early", joinedAt: T0 + 1_000 }),
      ],
      lastTickAt: undefined,
    });
    expect(nextTickAt(s)).toBe(T0 + 1_000 + FIVE_MIN);
  });

  // Review Focus 3's sibling: an empty roster must not arm, or the alarm fires
  // for as long as the object lives with nobody to ask.
  it("arms nothing when no member must report", () => {
    expect(nextTickAt(stored({ members: [watcher()] }))).toBe(null);
    expect(nextTickAt(stored({ members: [] }))).toBe(null);
    expect(nextTickAt(stored({ members: [lead({ leftAt: T0 })] }))).toBe(null);
  });

  it("arms nothing for a frozen or closed room", () => {
    expect(nextTickAt(stored({ members: [lead()], frozenAt: T0 }))).toBe(null);
    expect(nextTickAt(stored({ members: [lead()], closed: true }))).toBe(null);
  });
});

describe("lastReport", () => {
  /**
   * Review Focus 3. Durable Object storage has no migration step, so a member
   * stored before the field existed has none. Reading undefined as "never
   * reported" makes every one of them instantly due and instantly silent.
   */
  it("lifts a member stored before the field existed to joinedAt", () => {
    expect(lastReport(member({ joinedAt: T0, lastReportAt: undefined }))).toBe(T0);
  });

  it("uses the stamp when there is one", () => {
    expect(lastReport(member({ joinedAt: T0, lastReportAt: T0 + 60_000 }))).toBe(T0 + 60_000);
  });
});

describe("dueMembers", () => {
  it("is due at one cadence and not before", () => {
    const s = stored({ members: [lead({ lastReportAt: T0 })] });
    expect(dueMembers(s, T0 + FIVE_MIN - 1)).toEqual([]);
    expect(dueMembers(s, T0 + FIVE_MIN).map((m) => m.memberId)).toEqual(["m_lead"]);
  });

  it("never includes a seat that is not asked", () => {
    const s = stored({ members: [watcher({ lastReportAt: T0 })] });
    expect(dueMembers(s, T0 + 100 * FIVE_MIN)).toEqual([]);
  });

  // A seat can say it reports while the room names no cadence. `>= null` is
  // `>= 0`, so without the guard every such member is due the moment it is asked.
  it("is never due in a room that declares no cadence", () => {
    const s = stored({
      members: [lead({ lastReportAt: T0 })],
      manifest: { ...manifest, heartbeatOnMs: null },
    });
    expect(dueMembers(s, T0 + 100 * FIVE_MIN)).toEqual([]);
  });
});

describe("snapshotOf", () => {
  it("marks silent only at two cadences, so a member is asked before peers are alarmed", () => {
    const s = stored({ members: [lead({ lastReportAt: T0 })] });
    expect(snapshotOf(s, T0 + FIVE_MIN).members[0].silent).toBe(false);
    expect(snapshotOf(s, T0 + 2 * FIVE_MIN).members[0].silent).toBe(true);
  });

  it("reports a measurement taken at the tick, never a claim about now", () => {
    const s = stored({ members: [lead({ lastReportAt: T0 })] });
    const row = snapshotOf(s, T0 + 11 * 60_000).members[0];
    expect(row).toMatchObject({
      member_id: "m_lead",
      label: "lead@a",
      last_report_at: new Date(T0).toISOString(),
      silent_for_seconds: 660,
      silent: true,
    });
  });

  it("says so when a member has never reported", () => {
    const s = stored({ members: [lead({ lastReportAt: undefined })] });
    const row = snapshotOf(s, T0 + FIVE_MIN).members[0];
    expect(row.last_report_at).toBe(null);
    expect(row.silent_for_seconds).toBe(300);
  });

  it("lists only members that must report", () => {
    const s = stored({ members: [lead(), watcher()] });
    expect(snapshotOf(s, T0).members.map((r) => r.member_id)).toEqual(["m_lead"]);
  });

  // A report stamped after the tick's own clock reading is what a clock that stepped
  // backwards looks like. The row is a measurement, so it must not say "-60 seconds".
  it("never reports a negative silence", () => {
    const s = stored({ members: [lead({ lastReportAt: T0 + 60_000 })] });
    const row = snapshotOf(s, T0).members[0];
    expect(row.silent_for_seconds).toBe(0);
    expect(row.silent).toBe(false);
  });

  /** Invariant 7: no field may be a claim about now. */
  it("carries no presence key", () => {
    const s = stored({ members: [lead()] });
    const keys = Object.keys(snapshotOf(s, T0).members[0]);
    for (const banned of ["present", "status", "alive", "healthy", "state"]) {
      expect(keys).not.toContain(banned);
    }
  });

  it("carries the cadence and the ask", () => {
    const snap = snapshotOf(stored({ members: [lead()] }), T0);
    expect(snap.cadence_seconds).toBe(300);
    expect(snap.ask).toMatch(/bellman_send/);
  });
});

/**
 * Spec D10: "A member cannot report its way out of a frozen room, so none may be
 * named silent in one. A freeze must cost nobody their standing."
 *
 * The rule is pure and lives here; that it lands in the data on a thaw is proved
 * under real alarms in worker-tests/heartbeat-tick.test.ts, because snapshotOf
 * cannot see a freeze and no unit test can stand in for that.
 */
describe("clearSilence", () => {
  it("credits every seat the room asks with a report", () => {
    const s = stored({ members: [lead({ lastReportAt: T0 })] });
    const after = clearSilence(s, T0 + 12 * FIVE_MIN);
    expect(after[0].lastReportAt).toBe(T0 + 12 * FIVE_MIN);
    // And the thawed room then owes nobody an answer for a full cadence.
    expect(dueMembers({ ...s, members: after }, T0 + 12 * FIVE_MIN)).toEqual([]);
  });

  it("credits a member that had never reported, so a freeze cannot strand it", () => {
    const s = stored({ members: [lead({ lastReportAt: undefined })] });
    expect(clearSilence(s, T0 + FIVE_MIN)[0].lastReportAt).toBe(T0 + FIVE_MIN);
  });

  /**
   * Only the seats the room asks. A stamp on a member nothing reads is a field
   * that later disagrees with the roster for no reason — and the question of who
   * is asked has exactly one answer in this module.
   */
  it("leaves a member the room does not ask untouched", () => {
    const s = stored({ members: [watcher({ lastReportAt: T0 })] });
    expect(clearSilence(s, T0 + FIVE_MIN)[0].lastReportAt).toBe(T0);
  });

  it("leaves a departed member untouched, however its role reads", () => {
    const s = stored({ members: [lead({ lastReportAt: T0, leftAt: T0 + 1 })] });
    expect(clearSilence(s, T0 + FIVE_MIN)[0].lastReportAt).toBe(T0);
  });
});
