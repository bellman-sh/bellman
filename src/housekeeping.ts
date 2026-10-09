/**
 * What the server notices about a room on its own clock, and proposes (#66).
 *
 * Three findings, each a rule over the record: a member who has sent nothing for
 * `quiet_after`, an `action_request` nobody has answered within `answer_within`, and a
 * room no member has written to for `idle_after`. The server proposes and acts on
 * nothing; what to do about a finding is a member's call, under the verb that member
 * already holds.
 *
 * Every rule here is pure: a session in, a verdict out, with the clock handed in as `now`
 * where a rule reads it. The store holds no housekeeping policy, the same split
 * heartbeat.ts has. The books the rules read (`Member.lastSentAt`, `openRequests`,
 * `lastMemberEventAt`) are kept at the write by `noteAppend`, in store.ts, and the record
 * of what has been raised (`raised`) is the firing's.
 *
 * This module must stay importable by both builds: no `cloudflare:workers`, directly or
 * transitively. `SessionDO` imports it, and so do both test programs.
 */
import type { HousekeepingFinding, HousekeepingPayload, Member, SessionEvent } from "./types.js";
import type { StoredSession } from "./stored-session.js";
// `isActivePerson` and `isRemovedMember` live in store.ts beside the other member rules, and
// store.ts applies `noteAppend` inside both stores, so this module imports that one and not
// the reverse. heartbeat.ts is built the same way.
import { isActivePerson, isRemovedMember } from "./store.js";

/** The name of this handler on the room's one alarm, beside the others' (retention.ts, outbox.ts). */
export const HOUSEKEEP_HANDLER = "housekeep";

/** A proposal ready to be written: the key it is raised under, and the event's payload. */
export interface Finding {
  key: string;
  payload: HousekeepingPayload;
}

/**
 * When this member last sent, falling back to when it joined.
 *
 * The fallback is the legacy lift `lastSeen` and `lastReport` apply: a member who has sent
 * nothing since joining, or whose row predates the field, has no `lastSentAt`, and reading
 * `undefined` as "never sent" would name every one of them quiet the moment a room declares
 * housekeeping. Joining is not a send, but it IS the moment the clock should start from.
 */
const lastSent = (m: Member): number => m.lastSentAt ?? m.joinedAt;

/**
 * One condition the rules know of, holding or not: which finding it is, who or what it is
 * about, when its threshold is crossed, and how long a raise holds it back before it is
 * raised again.
 */
interface Anchor {
  key: string;
  finding: HousekeepingFinding;
  about?: HousekeepingPayload["about"];
  /** When the threshold is crossed, which is when the condition begins to hold. */
  since: number;
  /** The window after a raise before the same condition is raised again. */
  every: number;
}

/**
 * Every condition the room's rules know of, holding or not, or null when the rules are not
 * evaluated for this room at all.
 *
 * **The one list.** `dueFindings`, `clearedKeys` and `nextHousekeepAt` all read it, so "what
 * is due" and "when to look next" cannot disagree: a second loop for each would be two
 * readings of the same record, and a disagreement between them is an alarm that fires with
 * nothing due, or never fires for a finding that is.
 *
 * Not evaluated: a room that declared no housekeeping, one that is closed or frozen (nothing
 * can answer a finding in either, and a freeze is not anybody's silence), and one with no
 * person in it, which is about to close. A member counts while it is a person in the room
 * (`isActivePerson`: still in it, and not the hosted seat) and has not been removed from it,
 * and the same question is asked of the sender of a request (the request is named only while
 * someone who could be asked about it is there).
 *
 * **The hosted seat is not a person (hosted seat spec, D5; ruling H3).** It is never named
 * quiet, it does not keep a room from being empty, and its latest join does not date a room's
 * idleness. It speaks on Bellman's clock, in answer to its two wake causes, so there is no one
 * to nudge, and `isActivePerson` is the one predicate the three readings of "who is there"
 * (empty, abandoned, and this) share.
 *
 * **A thaw restarts the clocks (R9).** Every base time is floored at `thawedAt`: a member's
 * last send, a request's `at`, the last member event. While the room was frozen nobody could
 * send and no request could be answered, so a threshold crossed across the freeze names a
 * condition the room imposed, and every finding comes back one threshold after the thaw
 * instead. The book keeps its meaning (`lastSentAt` is still the last send); only the
 * reading is floored. A raise made before the freeze belongs to a condition whose anchor has
 * moved, so after the thaw it is a new condition (`continued`) and starts at `repeat: 1`.
 */
function anchors(s: StoredSession): Anchor[] | null {
  const h = s.manifest.housekeeping;
  if (!h || s.closed || s.frozenAt !== null) return null;
  const live = s.members.filter((m) => isActivePerson(m) && !isRemovedMember(m));
  if (live.length === 0) return null;

  const from = (base: number): number => Math.max(base, s.thawedAt ?? 0);
  const out: Anchor[] = [];
  if (h.quietAfterMs !== null) {
    const every = h.repeatAfterMs ?? h.quietAfterMs;
    for (const m of live) {
      out.push({
        key: `member_quiet:${m.memberId}`, finding: "member_quiet", about: { member_id: m.memberId },
        since: from(lastSent(m)) + h.quietAfterMs, every,
      });
    }
  }
  if (h.answerWithinMs !== null) {
    const every = h.repeatAfterMs ?? h.answerWithinMs;
    const inRoom = new Set(live.map((m) => m.memberId));
    for (const [cursor, r] of Object.entries(s.openRequests)) {
      // The books drop a leaver's requests to keep the record small, but whether a request is
      // named is decided here, whichever event a departure was written as.
      if (!inRoom.has(r.fromMemberId)) continue;
      out.push({
        key: `request_unanswered:${cursor}`, finding: "request_unanswered", about: { cursor: Number(cursor) },
        since: from(r.at) + h.answerWithinMs, every,
      });
    }
  }
  if (h.idleAfterMs !== null) {
    const last = s.lastMemberEventAt ?? Math.max(...live.map((m) => m.joinedAt));
    out.push({
      key: "room_idle", finding: "room_idle", since: from(last) + h.idleAfterMs, every: h.repeatAfterMs ?? h.idleAfterMs,
    });
  }
  return out;
}

/**
 * The raise this condition continues, if the record holds one for the same condition.
 *
 * The same key AND the same `since`. A key names a member, a request or the room, and a
 * condition can end and come back under it: a member who sent after being named, then went
 * quiet again before any firing cleared the key, has a new `since`. That is a new condition,
 * raised from its own anchor at `repeat: 1`, and the old raise says nothing about when it is
 * due.
 */
const continued = (s: StoredSession, a: Anchor) => {
  const prev = s.raised[a.key];
  return prev !== undefined && prev.since === a.since ? prev : undefined;
};

/**
 * When this condition is next due: its own anchor, or one window after the raise it
 * continues. A raise cannot make a condition due sooner than its anchor, so the later of the
 * two.
 */
const dueAt = (s: StoredSession, a: Anchor): number => {
  const prev = continued(s, a);
  return prev ? Math.max(a.since, prev.at + a.every) : a.since;
};

/**
 * The proposals to write at `now`: every condition that holds and has not been raised
 * inside its window. A key is raised once, then again only after its window has passed since
 * the last raise, with `repeat` counting up. The window is `repeat_after` when the manifest
 * declares one and otherwise the threshold that raised the finding.
 */
export function dueFindings(s: StoredSession, now: number): Finding[] {
  return (anchors(s) ?? [])
    .filter((a) => dueAt(s, a) <= now)
    .map((a) => ({
      key: a.key,
      payload: {
        finding: a.finding,
        ...(a.about ? { about: a.about } : {}),
        since: a.since,
        repeat: (continued(s, a)?.repeat ?? 0) + 1,
      },
    }));
}

/**
 * The raised keys whose condition no longer holds at `now`: the member sent, the request was
 * answered or its sender left, the room saw a member event. The record drops a key the
 * moment its condition ends, so the same condition coming back starts afresh.
 *
 * Empty for a room the rules are not evaluated for. Nothing is judged cleared in a closed or
 * frozen room, so the record is left as it was for the room that thaws.
 */
export function clearedKeys(s: StoredSession, now: number): string[] {
  const all = anchors(s);
  if (all === null) return [];
  const holding = new Set(all.filter((a) => a.since <= now).map((a) => a.key));
  return Object.keys(s.raised).filter((key) => !holding.has(key));
}

/**
 * Whether appending `e` starts a clock the alarm already armed cannot know of: an
 * `action_request` in a room that declares `answer_within`. Its anchor, the request's time
 * plus `answer_within`, can fall before the time armed, and no other append can: a send only
 * moves a member's quiet clock later, a response only removes an anchor, and a join re-arms
 * where it is written. The room's store asks this after a commit and re-arms if it is true.
 *
 * Shared by both appends so the "when" is written once.
 */
export const startsAnswerClock = (
  s: Pick<StoredSession, "manifest">,
  e: Pick<SessionEvent, "type">,
): boolean => e.type === "action_request" && (s.manifest.housekeeping?.answerWithinMs ?? null) !== null;

/**
 * The soonest moment a condition is due, or null when nothing can become due: no housekeeping,
 * a closed or frozen room, nobody in it, or no condition to wait on.
 *
 * It reads the same anchors `dueFindings` does, so at the time it names something is due and
 * at no earlier time is. And **strictly after `now` once everything due has just been raised**:
 * a raise at `now` puts the condition's next due time one window out, and a window is positive.
 * Without that, a condition that stays true would keep its due time in the past for as long
 * as it held, and re-arming from it would fire the alarm back to back for good. A raise made
 * for a condition that has since come back is not counted (`continued`), because it says
 * nothing about the new one.
 *
 * It may return a time in the past, once, for an object that slept through a moment that was
 * due. That is correct: the alarm fires at once, the firing raises it, and the answer after
 * that is in the future.
 *
 * `_now` is unused. Every anchor is stored state. It is in the signature so the handler calls
 * the three rules the same way, as `dueFindings(s, now)` and `clearedKeys(s, now)` are called;
 * `nextTickAt`, in heartbeat.ts, takes none, for the reason that a parameter nothing reads
 * suggests the answer depends on the clock.
 */
export function nextHousekeepAt(s: StoredSession, _now: number): number | null {
  const all = anchors(s);
  if (all === null || all.length === 0) return null;
  return Math.min(...all.map((a) => dueAt(s, a)));
}
