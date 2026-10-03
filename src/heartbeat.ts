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
 * When the heartbeat alarm should next fire, or null for a room that needs none.
 *
 * Anchored on `lastTickAt` and NOT on member report times, which is what keeps
 * the alarm from spinning: see the field's comment in stored-session.ts.
 *
 * Takes no `now`: the anchor is stored state, and a parameter nothing reads
 * would suggest the answer depends on the clock.
 *
 * Null for a room with no cadence, no member to ask, or that cannot be answered
 * — a frozen or closed room. Deriving a time for a closed session would re-arm
 * the alarm to a moment already past and fire for as long as the object lived,
 * which is the reason `derivedDue` already gives about the TTL.
 *
 * It may return a time in the past, once, for an object that slept through a
 * tick. That is correct: the alarm fires immediately, the firing moves
 * `lastTickAt` to now, and the next answer is in the future.
 */
export function nextTickAt(s: StoredSession): number | null {
  const every = s.manifest.heartbeatOnMs;
  if (every === null || s.closed || s.frozenAt !== null) return null;
  const asked = reporting(s);
  if (asked.length === 0) return null;
  const anchor = s.lastTickAt ?? Math.min(...asked.map((m) => m.joinedAt));
  return anchor + every;
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
    ask: "Reply with bellman_send type=\"progress\", payload { note } — one line on where you are.",
    members: reporting(s).map((m) => {
      // `??`, not truthiness. Epoch 0 is a timestamp, and `m.lastReportAt ? … :
      // null` read it as "never reported" — the bug `lastReport` above already
      // avoids this way, and this was the one place in the module that did not.
      const at = m.lastReportAt ?? null;
      return {
        member_id: m.memberId,
        label: m.label,
        last_report_at: at === null ? null : new Date(at).toISOString(),
        silent_for_seconds: Math.max(0, Math.round((now - lastReport(m)) / 1000)),
        silent: now - lastReport(m) >= 2 * every,
      };
    }),
  };
}
