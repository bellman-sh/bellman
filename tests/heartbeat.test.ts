import { describe, it, expect } from "vitest";
import { clearSilence, lastReport, nextTickAt, dueMembers, reportRow, snapshotOf } from "../src/heartbeat.js";
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
   * never answers, and reArm() would fire the alarm back to back for good. Such a
   * member's deadline falls at or before the last tick, so it takes the floor
   * `lastTickAt + cadence`, which strictly advances. That is P2, and the describe
   * block below pins it against the rule that keeps P1 with it.
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

  /**
   * The member has to be OVERDUE for the answer to be in the past, because that is
   * the only way an object genuinely owes a tick it has not sent. `lead()` is not
   * the fixture for it: having never reported, it dates from `joinedAt: T0`, which
   * is AFTER the slept-through tick — a member that joined since the last firing
   * and is not due yet, however long ago that firing was. Arming in the past for it
   * would wake the object to ask a member that had just arrived.
   */
  it("returns a past time at most once, and converges after one firing", () => {
    const members = [lead({ joinedAt: T0 - 20 * FIVE_MIN, lastReportAt: undefined })];
    const asleep = stored({ members, lastTickAt: T0 - 10 * FIVE_MIN });
    expect(nextTickAt(asleep)).toBeLessThan(T0);
    const woken = stored({ members, lastTickAt: T0 });
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

/**
 * **P1: a reporting member must be asked within one cadence of its last report.**
 * **P2: the alarm must never arm at or before `lastTickAt`.**
 *
 * The two together are the whole rule, and each alone is satisfiable by something
 * broken. Anchoring every member on `lastTickAt` keeps P2 and loses P1: a tick at
 * T, a member reporting at T+1s, and at T+5m it is not due by one second — so no
 * event is written, the clock advances anyway, and the next tick is T+10m. The
 * member is asked nine minutes and fifty-nine seconds after its report in a room
 * that declared five. Anchoring on member reports alone keeps P1 and loses P2: a
 * member that never answers has a deadline fixed in the past, so `reArm()` points
 * the alarm back at it for as long as the object lives.
 *
 * So the anchor is PER MEMBER, and `lastTickAt` is a floor rather than the clock:
 *
 * - A member not yet due at the last tick keeps its own deadline,
 *   `lastReport + cadence`. It was not asked then, so nothing was spent on it.
 * - A member already due at the last tick WAS asked then, so it is asked again no
 *   sooner than one cadence after that ask: `lastTickAt + cadence`.
 *
 * The alarm takes the earliest of those. Both branches are strictly after
 * `lastTickAt` — the first by its own test, the second because a cadence is
 * positive — so P2 holds by construction rather than by a clamp.
 *
 * A property worth naming, because the old rule did not have it: every armed
 * firing finds somebody due. If the earliest is a deadline, that member is due at
 * it by definition; if it is `lastTickAt + cadence`, that member's report is a
 * cadence older still, so it has been due for two. The nobody-due branch in
 * `#tickIfDue` is still reached constantly, because a member reporting between the
 * arming and the firing does not re-arm — `updateMember` skips it on the hot path.
 */
describe("nextTickAt, the two scheduling properties", () => {
  /**
   * **The case that breaks a single global clock.** A mixed roster: one member
   * reported a second after the last tick, one has never answered at all. The
   * overdue member forces a tick before the recent reporter is due, which is
   * correct — the question is what becomes of the recent reporter's own deadline
   * once that earlier tick has moved the clock past it.
   *
   * Under one global clock it is swallowed: the tick at T+5m advances `lastTickAt`,
   * and the reporter's next ask is pushed out to the fixed boundary at T+10m. Its
   * report was at T+1s, so the room asks it 9m59s later having promised 5m.
   */
  it("does not let a tick forced by an overdue member swallow a recent reporter's deadline", () => {
    const reportedAt = T0 + 1_000;
    const roster = [
      lead({ memberId: "m_prompt", lastReportAt: reportedAt }),
      lead({ memberId: "m_overdue", joinedAt: T0 - 10 * FIVE_MIN, lastReportAt: undefined }),
    ];

    // The overdue member is asked first: it was due before the last tick, so it is
    // asked a cadence after that tick, sooner than the prompt member's deadline.
    const first = stored({ members: roster, lastTickAt: T0 });
    expect(nextTickAt(first)).toBe(T0 + FIVE_MIN);
    expect(dueMembers(first, T0 + FIVE_MIN).map((m) => m.memberId)).toEqual(["m_overdue"]);

    // **The line this test exists for.** That firing moved the clock past the
    // prompt member's deadline without asking it. The deadline is still its own.
    const second = stored({ members: roster, lastTickAt: T0 + FIVE_MIN });
    expect(nextTickAt(second)).toBe(reportedAt + FIVE_MIN);
    // One cadence after its report, to the millisecond — not the T0+10m boundary.
    expect(nextTickAt(second)! - reportedAt).toBe(FIVE_MIN);
  });

  /**
   * The single-member reading of the same rule, and the simplest statement of P1.
   * A member that reports just after a tick is asked one cadence after its REPORT,
   * not at the next fixed multiple of the cadence.
   */
  it("asks a recent reporter one cadence after its report, not at the next boundary", () => {
    const reportedAt = T0 + 1_000;
    const s = stored({ members: [lead({ lastReportAt: reportedAt })], lastTickAt: T0 });
    expect(nextTickAt(s)).toBe(reportedAt + FIVE_MIN);
    expect(nextTickAt(s)).toBeGreaterThan(T0 + FIVE_MIN);
  });

  /**
   * P2, which is why the clock was anchored on `lastTickAt` in the first place. A
   * roster where everybody is overdue has every deadline in the past, and a rule
   * returning the earliest of those hands `reArm()` a time already gone — every
   * firing arming for the same moment, for as long as the object lives.
   */
  it("arms a cadence out, not in the past, when the whole roster is overdue", () => {
    const members = [
      lead({ memberId: "m_a", joinedAt: T0 - 20 * FIVE_MIN, lastReportAt: undefined }),
      lead({ memberId: "m_b", joinedAt: T0 - 11 * FIVE_MIN, lastReportAt: undefined }),
    ];
    expect(nextTickAt(stored({ members, lastTickAt: T0 }))).toBe(T0 + FIVE_MIN);

    // And it keeps advancing, firing by firing, with nobody ever answering.
    let clock = T0;
    for (let n = 0; n < 5; n++) {
      const next = nextTickAt(stored({ members, lastTickAt: clock }))!;
      expect(next).toBe(clock + FIVE_MIN);
      clock = next;
    }
  });

  /** P2 as the bare predicate, across every shape of roster a room can hold. */
  it("never arms at or before lastTickAt", () => {
    const rosters = [
      [lead({ lastReportAt: T0 + 1_000 })],
      [lead({ lastReportAt: T0 - 50 * FIVE_MIN })],
      [lead({ memberId: "m_a", lastReportAt: T0 }), lead({ memberId: "m_b", lastReportAt: T0 - FIVE_MIN })],
      [lead({ memberId: "m_a", lastReportAt: T0 + FIVE_MIN }), lead({ memberId: "m_b", lastReportAt: 0 })],
    ];
    for (const members of rosters) {
      expect(nextTickAt(stored({ members, lastTickAt: T0 }))).toBeGreaterThan(T0);
    }
  });

  /**
   * A fresh room has no tick to floor anything against, so every member's deadline
   * is simply its own — and `lastReport` falls back to `joinedAt`, so joining is
   * what starts the clock. The earliest of those is the first time anybody is due.
   */
  it("uses each member's own deadline in a room that has never ticked", () => {
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

  /**
   * A room that has never ticked whose members joined long ago — the shape an
   * existing room takes the moment a cadence is added to it. The answer is in the
   * past, which is correct and happens once: the alarm fires at once, the firing
   * sets `lastTickAt`, and the floor applies from then on.
   */
  it("converges after one firing in a room already overdue when it first ticked", () => {
    const members = [lead({ joinedAt: T0 - 10 * FIVE_MIN, lastReportAt: undefined })];
    expect(nextTickAt(stored({ members, lastTickAt: undefined }))).toBeLessThan(T0);
    expect(nextTickAt(stored({ members, lastTickAt: T0 }))).toBe(T0 + FIVE_MIN);
  });

  /**
   * The rule and `dueMembers` have to agree on the boundary, or an armed firing
   * wakes the object to ask nobody. `dueMembers` is due AT one cadence, so a
   * deadline exactly equal to `lastTickAt` means the member was asked at that tick
   * and takes the floor; one millisecond later it keeps its own deadline.
   */
  it("agrees with dueMembers about which side of the last tick a deadline falls", () => {
    const asked = stored({ members: [lead({ lastReportAt: T0 - FIVE_MIN })], lastTickAt: T0 });
    expect(dueMembers(asked, T0).map((m) => m.memberId)).toEqual(["m_lead"]);
    expect(nextTickAt(asked)).toBe(T0 + FIVE_MIN);

    const spared = stored({ members: [lead({ lastReportAt: T0 - FIVE_MIN + 1 })], lastTickAt: T0 });
    expect(dueMembers(spared, T0)).toEqual([]);
    expect(nextTickAt(spared)).toBe(T0 + 1);
  });

  /**
   * Whatever the armed time is, somebody is due at it. The old rule could arm for a
   * moment nobody owed an answer at, which is what let a deadline be skipped and
   * then pushed a full cadence out.
   */
  it("arms for a moment somebody is due at", () => {
    const rosters = [
      [lead({ lastReportAt: T0 + 1_000 })],
      [
        lead({ memberId: "m_prompt", lastReportAt: T0 + 1_000 }),
        lead({ memberId: "m_old", lastReportAt: T0 - 9 * FIVE_MIN }),
      ],
      [
        lead({ memberId: "m_a", lastReportAt: T0 - FIVE_MIN }),
        lead({ memberId: "m_b", lastReportAt: T0 + 2_000 }),
      ],
    ];
    for (const members of rosters) {
      const s = stored({ members, lastTickAt: T0 });
      expect(dueMembers(s, nextTickAt(s)!).length).toBeGreaterThan(0);
    }
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
  it("reportRow never says silent without a cadence, and snapshotOf is built from it", () => {
    const m = lead({ lastReportAt: T0 });
    expect(reportRow(m, T0 + 100 * FIVE_MIN, null)).toMatchObject({
      member_id: "m_lead", silent_for_seconds: 100 * 300, silent: false,
    });
    const s = stored({ members: [m] });
    expect(snapshotOf(s, T0 + 2 * FIVE_MIN).members[0]).toEqual(reportRow(m, T0 + 2 * FIVE_MIN, FIVE_MIN));
  });

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

  /**
   * A `heartbeat` event reaches EVERY active member, non-reporting observers
   * included — the tick is ambient, and nothing filters delivery by seat. So an
   * unconditional "Reply with …" told an `observer` (`can: []`, `reports: false`)
   * to make a call `bellman_send` then refuses, every cadence, forever.
   *
   * The snapshot's `members` list already names exactly the seats the room asks,
   * so the ask points at that list rather than at whoever is reading it. A reader
   * absent from the list can then tell the instruction is not addressed to it,
   * which is the only thing the payload can give it: delivery cannot be narrowed
   * without making presence a stored fact, which Invariant 7 forbids.
   */
  it("directs the members it lists, not whoever reads it", () => {
    const s = stored({ members: [lead(), watcher()] });
    const snap = snapshotOf(s, T0 + FIVE_MIN);

    // The observer is in the room and is NOT in the list — so the list is a real
    // qualifier and not a restatement of "everybody".
    expect(snap.members.map((m) => m.member_id)).toEqual(["m_lead"]);
    expect(snap.ask).toContain("listed");
    // Not an unconditional imperative at the reader.
    expect(snap.ask).not.toMatch(/^Reply with/);
    // Still the call the tick wants, which tests/tools/progress.test.ts pins to
    // what bellman_send accepts.
    expect(snap.ask).toContain('bellman_send type="progress"');
  });

  it("carries the cadence and the ask", () => {
    const snap = snapshotOf(stored({ members: [lead()] }), T0);
    expect(snap.cadence_seconds).toBe(300);
    expect(snap.ask).toMatch(/bellman_send/);
  });

  /**
   * Epoch 0 is a timestamp. `m.lastReportAt ? … : null` read it as "never
   * reported", which is the one place in this module that did not use the `??`
   * idiom `lastReport` uses. Not reachable in practice; the row it produced was
   * wrong in the direction that matters, claiming a member had never answered
   * when the stored value says when it did.
   */
  it("reads a report at epoch 0 as a report, not as never", () => {
    const row = snapshotOf(stored({ members: [lead({ lastReportAt: 0 })] }), T0).members[0];
    expect(row.last_report_at).toBe(new Date(0).toISOString());
  });

  /**
   * A cadence of null cannot be described, and every numeric default lies about
   * it: `?? 0` made `silent` true for every member and reported a cadence of zero
   * seconds — the false silent D10 exists to prevent, applied to the whole room.
   * #tickIfDue refuses a null cadence before this is reached, so the throw is
   * about what this says when something changes, not about today's callers.
   */
  it("refuses to describe a room that declared no cadence", () => {
    const s = stored({ members: [lead()], manifest: roomManifest({ heartbeatOnMs: null }) });
    expect(() => snapshotOf(s, T0)).toThrow(/no heartbeat cadence/);
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
