/**
 * When the server asks a room's members where they are, and what it tells them
 * about each other (#111).
 *
 * Not presence. `presence.ts` answers whether a member is *there*, derived from
 * calls it already makes; this answers whether it has *said where it is*, which
 * only a deliberate report can establish. The two never share a field: a member
 * can be present and silent, which is exactly the state this exists to surface.
 *
 * Every rule here is pure, and the ones that read the clock take it as `now`, so
 * the store holds no heartbeat policy — the same split `seatVictims` has from
 * `STALE_AFTER_MS`.
 *
 * This module must stay importable by both builds: no `cloudflare:workers`,
 * directly or transitively. `SessionDO` imports it, and so do both test
 * programs.
 */
import type { Member } from "./types.js";
import type { StoredSession } from "./stored-session.js";
// `asked` and `clearSilence` live in store.ts beside `isActiveMember`, because
// `freezeSession` applies them inside the store and this module imports that one.
import { asked, clearSilence } from "./store.js";
export { asked, clearSilence };

/**
 * When this member last reported, falling back to when it joined.
 *
 * The fallback is the legacy lift: members stored before `lastReportAt` existed
 * have none, and reading `undefined` as "never reported" would make every one of
 * them due and silent the moment this ships. Joining is not a report, but it IS
 * the moment the clock should start from, so `joinedAt` is the honest answer —
 * the same read-time lift `lastSeen` applies.
 *
 * Unlike `lastSeen`, this lives here rather than in store.ts: no store method
 * reads it, because seating a member does not depend on whether it has reported.
 */
export const lastReport = (m: Member): number => m.lastReportAt ?? m.joinedAt;

/** Members holding a seat the room expects reports from. */
const reporting = (s: StoredSession): Member[] => s.members.filter((m) => asked(s, m));

/**
 * When this member should next be asked, given when the room last ticked.
 *
 * **The anchor is per member, and `lastTickAt` is a floor rather than the
 * clock.** Two cases, and the split between them is the whole rule:
 *
 * - A member **not yet due at the last tick** keeps its own deadline,
 *   `lastReport + cadence`. That tick did not ask it, so nothing has been spent
 *   on it, and the deadline is the room's promise to it.
 * - A member **already due at the last tick** was asked then, so it is asked
 *   again no sooner than one cadence after that ask: `lastTickAt + cadence`. Its
 *   own deadline is in the past and stays there until it answers, so honouring
 *   that would mean asking it continuously.
 *
 * `deadline > tick` is the boundary `dueMembers` uses, read the other way round:
 * `dueMembers` calls a member due once `now - lastReport >= cadence`, which is
 * `deadline <= now`. So a deadline at or before `lastTickAt` means the member
 * genuinely was in that tick's list, and one after it means it was not. The two
 * must agree, or a firing arms for a moment nobody owes an answer at.
 *
 * A room with no `lastTickAt` has no floor: nothing has been asked yet, so every
 * member's deadline is simply its own.
 */
const askAt = (m: Member, every: number, tick: number | undefined): number => {
  const deadline = lastReport(m) + every;
  if (tick === undefined || deadline > tick) return deadline;
  return tick + every;
};

/**
 * When the heartbeat alarm should next fire, or null for a room that needs none.
 *
 * The earliest moment any member the room asks is due — `askAt` above carries
 * the per-member rule and the reasoning for it. Two properties hold together,
 * and tests/heartbeat.test.ts pins each against the shape that satisfies one
 * alone:
 *
 * - **P1. A reporting member is asked within one cadence of its last report.**
 *   This is the room's promise, and what a single global clock cannot keep.
 *   Anchored on `lastTickAt` alone, a member that reported a second after a tick
 *   was not due at the next one, and the firing that asked nobody advanced the
 *   clock anyway — so it was asked two cadences later, nine minutes and
 *   fifty-nine seconds after its report in a room that declared five. The
 *   mixed-roster case is the sharp one: an earlier tick forced by an overdue
 *   member must not swallow a prompt member's own deadline.
 * - **P2. The answer is always strictly after `lastTickAt`.** This is why the
 *   clock was anchored there to begin with, and it is not undone. A tick moves
 *   nobody's `lastReportAt`, so a member that never answers has a deadline fixed
 *   in the past, and returning it would point `reArm()` back at a moment already
 *   gone for as long as the object lived — the hazard `alarm()` records for
 *   `due:outbox`. Both of `askAt`'s branches land after the tick: the first by
 *   its own test, the second because a cadence is positive. So P2 holds by
 *   construction, with nothing to clamp.
 *
 * Together they give a property the old rule lacked: **every armed firing finds
 * somebody due.** If the earliest is a deadline, that member is due at it by
 * definition; if it is `lastTickAt + cadence`, that member's report is a cadence
 * older still, so it has been due for two. `#tickIfDue`'s nobody-due branch is
 * still reached constantly, because a member reporting between the arming and
 * the firing does not re-arm — `updateMember` skips that on the hot path.
 *
 * Takes no `now`: every anchor is stored state, and a parameter nothing reads
 * would suggest the answer depends on the clock.
 *
 * Null for a room with no cadence, no member to ask, or that cannot be answered
 * — a frozen or closed room. Deriving a time for a closed session would re-arm
 * the alarm to a moment already past and fire for as long as the object lived,
 * which is the reason `derivedDue` already gives about the TTL.
 *
 * It may return a time in the past, once, for an object that slept through a
 * tick or for a room that gained a cadence after its members joined. That is
 * correct: the alarm fires immediately, the firing moves `lastTickAt` to now,
 * and from then on the floor applies and the next answer is in the future.
 */
export function nextTickAt(s: StoredSession): number | null {
  const every = s.manifest.heartbeatOnMs;
  if (every === null || s.closed || s.frozenAt !== null) return null;
  const asked = reporting(s);
  if (asked.length === 0) return null;
  return Math.min(...asked.map((m) => askAt(m, every, s.lastTickAt)));
}

/** Members that have gone a full cadence without reporting. The tick asks these. */
export function dueMembers(s: StoredSession, now: number): Member[] {
  const every = s.manifest.heartbeatOnMs;
  if (every === null) return [];
  return reporting(s).filter((m) => now - lastReport(m) >= every);
}

export interface ReportRow {
  member_id: string;
  label: string;
  /** ISO 8601, or null for a member that has never reported. */
  last_report_at: string | null;
  /** Measured at the tick. A fact about `at`, not a claim about now. */
  silent_for_seconds: number;
  /** Past two cadences. */
  silent: boolean;
}

export interface HeartbeatPayload {
  cadence_seconds: number;
  ask: string;
  members: ReportRow[];
}

/**
 * One member's standing against the cadence, measured at `now`. The tick's
 * snapshot is built from this and so is the monitor's beat (#28, D8): a
 * dashboard that said "silent" where the tick did not would be a second rule
 * for one fact. `every` is null for a room that declares no cadence, and
 * nothing is silent against a cadence that does not exist.
 */
export function reportRow(m: Member, now: number, every: number | null): ReportRow {
  // `??`, not truthiness. Epoch 0 is a timestamp, and `m.lastReportAt ? … :
  // null` read it as "never reported" — the bug `lastReport` above already
  // avoids this way.
  const at = m.lastReportAt ?? null;
  return {
    member_id: m.memberId,
    label: m.label,
    last_report_at: at === null ? null : new Date(at).toISOString(),
    silent_for_seconds: Math.max(0, Math.round((now - lastReport(m)) / 1000)),
    silent: every !== null && now - lastReport(m) >= 2 * every,
  };
}

/**
 * What the tick carries: the thing only the server can see.
 *
 * **Invariant 7 holds here and the payload is where it would break.** Every
 * field is a claim about the tick's own `at` — "had reported nothing for 660
 * seconds at 14:05" was true then and stays true on replay. There is no
 * `present`, `status`, `alive` or `healthy` key, and there must never be: those
 * are claims about now, which replay re-asserts hours after the member went.
 * Presence stays derived, in presence.ts.
 *
 * Two thresholds. `silent` is two cadences and the ask is one, so a member is
 * asked for a full interval before any peer is told it has gone quiet. A false
 * silent costs every peer's trust in the signal; a late one costs a few minutes.
 *
 * **The ask is addressed to the list, not to the reader.** A `heartbeat` event
 * reaches every active member — the tick is ambient and nothing filters delivery
 * by seat — so an `observer` (`can: []`, `reports: false`) receives it too, and
 * `bellman_send` refuses `progress` from a seat without `send`. An unconditional
 * "Reply with …" therefore instructed such a member, every cadence, to make a
 * call this same server rejects. `members` below already names exactly the seats
 * the room asks, so the ask points there and a reader absent from it can tell
 * nothing is wanted of it. Narrowing DELIVERY instead would mean the server
 * knowing per-recipient what it sent, which the one-event-per-room shape does not
 * have and Invariant 7 would not let it store.
 */
export function snapshotOf(s: StoredSession, now: number): HeartbeatPayload {
  // Not a cadence this can describe. `#tickIfDue` refuses a null cadence before
  // it gets here, so this is unreachable — but a DEFAULT would have to be a
  // number, and every number is a lie: `0` makes `silent` true for every member
  // and reports a cadence of zero seconds, which is the false silent D10 exists
  // to prevent, applied to the whole room at once. Throwing is the honest answer
  // for "called in a state that should not reach it".
  const every = s.manifest.heartbeatOnMs;
  if (every === null) {
    throw new Error("snapshotOf: the room declared no heartbeat cadence");
  }
  return {
    cadence_seconds: Math.round(every / 1000),
    ask: "The members listed below: reply with bellman_send type=\"progress\", payload { note } "
      + "— one line on where you are. Nobody else is being asked.",
    members: reporting(s).map((m) => reportRow(m, now, every)),
  };
}
