# Room Housekeeping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A room that declares `housekeeping` in its manifest gets a server-authored `housekeeping` event when a member has gone quiet, an action request sits unanswered, or the room has gone idle, once per window, cleared by the condition, with the server acting on nothing.

**Architecture:** The rules are pure functions over the session record in `src/housekeeping.ts`, beside `src/heartbeat.ts`, and they read three bookkeeping fields both stores keep at append through one shared helper (`noteAppend`): each member's `lastSentAt`, the room's `lastMemberEventAt`, and `openRequests` (the action requests with no response yet). `SessionDO` gets a fourth derived handler, `housekeep`, on its one alarm; it fires only when a rule is due, appends one event per due finding inside one transaction, records the raise in `raised`, and re-arms to the next anchor. `MemoryStore` keeps the bookkeeping and the record but runs no handler, as it runs no tick. No tool, no verb, no seat.

**Tech Stack:** TypeScript, zod, vitest; Durable Objects alarms through the outbox driver's `derivedDue`.

**Spec:** `docs/superpowers/specs/2026-10-08-room-housekeeping-design.md` (D1 to D7). Issue #66.

## Global Constraints

- Finding names: `member_quiet`, `request_unanswered`, `room_idle`. Keys: `member_quiet:<memberId>`, `request_unanswered:<cursor>`, `room_idle`.
- Durations in the manifest take `heartbeat_on`'s form (`"30s"`, `"5m"`, `"1h"`, now also `"2d"`), bounded between `MIN_HOUSEKEEPING_MS = 5 * 60_000` and `MAX_HOUSEKEEPING_MS = 7 * 24 * 3_600_000`; `repeat_after` defaults, per finding, to that finding's threshold.
- The `housekeeping` event: `fromMemberId: "system"`, `fromUserId: "system"`, `fromLabel: "bellman"`, attention `interrupt`, payload `{ finding, about?, since, repeat }` with numbers and identifiers only. `bellman_send` refuses the type (the `SEND_KINDS` enum does not hold it; a test pins the refusal).
- The handler never writes into a closed, frozen or abandoned room, and never into one whose manifest has no `housekeeping`. The next due time strictly advances after a firing (no back-to-back alarm), which `nextHousekeepAt`'s tests prove the way `nextTickAt`'s do.
- Server-authored events are not activity: `lastMemberEventAt` moves only on a member's event.
- No preset carries `housekeeping`; `VERBS` is unchanged; `extension/manifest.json` is untouched.
- Writing: a room holds many members; never "two sessions", "the other session", "counterpart", "the other side"; never "load-bearing" or "worth saying plainly". Commits signed (`git -c commit.gpgsign=true commit -S`), subjects in sentence case.
- `npm run verify` green before every commit.

## Review Focus

1. A member leaves after an `action_request` of theirs went unanswered: the key clears (the request is no longer open) and no further proposal names it. (Task 3 test.)
2. A room with housekeeping whose every member has left: `nextHousekeepAt` is `null` (the abandonment rule owns what happens next), and a handler firing writes nothing. (Task 3 and Task 4 tests.)
3. A thaw after a freeze: the anchors are older than the thresholds, so every finding is due at once; one event per key is written in that firing, each with `repeat: 1`, and the next due is `repeat_after` away. (Task 4 worker test.)
4. A `repeat_after` shorter than the threshold it repeats, say `quiet_after: "2h", repeat_after: "5m"`: accepted (both in bounds), and a quiet member is named every five minutes until it sends. The plan keeps it and the README says so in one sentence; a cap is a later decision. (Task 1 test for acceptance; Task 3 test for the cadence.)
5. A room with more than a thousand events and an old open request: `openRequests` is a field on the record, not a scan of the log, so the request is found whatever the log's length. (Task 2 contract test writes 1,100 events after the request and reads the field.)

---

### Task 1: The manifest field

**Files:**
- Modify: `src/manifest.ts` (a general `parseDuration`, `HousekeepingShape`, the field on `AuthorShape` and `CiteShape`, `resolveManifest`, the preset catalog's `housekeeping: null`, `withHeartbeatDefaults` renamed `withManifestDefaults` or extended), `src/types.ts` (`RoomManifest.housekeeping`), the room-manifest skill document (`grep -rln heartbeat_on docs/ skills/ 2>/dev/null` and `tests/room-manifest-skill.test.ts` say which file is pinned)
- Test: `tests/manifest.test.ts`, `tests/room-manifest-skill.test.ts`

**Interfaces:**
- Consumes: `parseHeartbeatOn`, `DURATION`, `UNIT_MS`, `duration()`, `MIN_HEARTBEAT_MS`/`MAX_HEARTBEAT_MS`.
- Produces: `RoomManifest.housekeeping: { quietAfterMs: number | null; answerWithinMs: number | null; idleAfterMs: number | null; repeatAfterMs: number | null } | null`; `MIN_HOUSEKEEPING_MS`, `MAX_HOUSEKEEPING_MS`; `HousekeepingInput = { quiet_after?: string; answer_within?: string; idle_after?: string; repeat_after?: string }`.

- [ ] **Step 1: Tests first**, in `tests/manifest.test.ts` under a new `describe("housekeeping (#66)")`: an authored manifest with `housekeeping: { quiet_after: "2h", answer_within: "30m", idle_after: "1d" }` resolves to `{ quietAfterMs: 7_200_000, answerWithinMs: 1_800_000, idleAfterMs: 86_400_000, repeatAfterMs: null }`; a cited preset with the field resolves it too; absent → `null`; `{}` → every field `null` (an empty object disables every finding, same as absent: assert `housekeeping` is `null` for `{}` as well, so one representation exists); `quiet_after: "1m"` refuses with `housekeeping.quiet_after must be between 5m and 7d (got "1m")`; `idle_after: "8d"` refuses with the matching message; `quiet_after: "soon"` refuses with `housekeeping.quiet_after must be a duration like "30s", "5m", "1h" or "2d" (got "soon")`; `repeat_after: "5m"` with `quiet_after: "2h"` is accepted (Review Focus 4); every preset in the catalog has `housekeeping: null`; the verb enum test is unchanged and still green. Run: red.

- [ ] **Step 2: Generalise the duration parser.** In `src/manifest.ts`, `UNIT_MS` gains `d: 86_400_000` and `DURATION` admits `d`; `parseHeartbeatOn(raw)` becomes `parseDuration(field: string, raw: string, min: number, max: number)` with the two messages built from `field` (`heartbeat_on` keeps its exact current wording when `field === "heartbeat_on"`: the existing tests pin it, including the example list without `"2d"`; the housekeeping messages use the four-example list). Keep a `parseHeartbeatOn = (raw) => parseDuration("heartbeat_on", raw, MIN_HEARTBEAT_MS, MAX_HEARTBEAT_MS)`.

```ts
export const MIN_HOUSEKEEPING_MS = 5 * 60_000;
export const MAX_HOUSEKEEPING_MS = 7 * 24 * 3_600_000;
const DurationShape = z.string().max(8);
const HousekeepingShape = z.strictObject({
  quiet_after: DurationShape.optional(),
  answer_within: DurationShape.optional(),
  idle_after: DurationShape.optional(),
  repeat_after: DurationShape.optional(),
});
```

Both `AuthorShape` and `CiteShape` gain `housekeeping: HousekeepingShape.nullish()`. In `resolveManifest`, after `heartbeatOnMs`:

```ts
    housekeeping: resolveHousekeeping(v.housekeeping),
```

```ts
function resolveHousekeeping(h: z.infer<typeof HousekeepingShape> | null | undefined): RoomManifest["housekeeping"] {
  if (!h) return null;
  const parse = (field: keyof typeof h) =>
    h[field] == null ? null : parseDuration(`housekeeping.${field}`, h[field]!, MIN_HOUSEKEEPING_MS, MAX_HOUSEKEEPING_MS);
  const out = { quietAfterMs: parse("quiet_after"), answerWithinMs: parse("answer_within"), idleAfterMs: parse("idle_after"), repeatAfterMs: parse("repeat_after") };
  return out.quietAfterMs === null && out.answerWithinMs === null && out.idleAfterMs === null ? null : out;
}
```

`RoomManifest` in `src/types.ts` gains the field; the preset catalog's `PresetBody` omits it and the catalog resolution sets `housekeeping: null`; `withHeartbeatDefaults` (in `src/stored-session.ts`) also defaults `housekeeping` to `null` on rows written before this (rename it `withManifestDefaults` and update its callers, or add the one line and leave the name; say which). Fix the literal manifests the typecheck flags (`roomManifest()` in `tests/helpers/fixtures.ts` gains `housekeeping: null`).

- [ ] **Step 3: The skill document.** The room-manifest skill (the file `tests/room-manifest-skill.test.ts` pins) gains the `housekeeping` field beside `heartbeat_on`, with the four keys, the bounds and one sentence per finding; keep its test green (read what it asserts first).

- [ ] **Step 4: Green, controls, commit.** Controls, quoted: lower `MIN_HOUSEKEEPING_MS` to `60_000` and the `"1m"` refusal test goes red; drop the `{}`-to-`null` collapse and that test goes red. `npm run verify`. Then:

```bash
git add src/manifest.ts src/types.ts src/stored-session.ts tests/manifest.test.ts tests/helpers/fixtures.ts <skill doc> tests/room-manifest-skill.test.ts
git -c commit.gpgsign=true commit -S -m "Let a manifest declare housekeeping: how long before a quiet member, an unanswered request or an idle room is named"
```

---

### Task 2: The event type, and the bookkeeping both stores keep at append

**Files:**
- Create: `src/housekeeping.ts` (the types and `noteAppend` only; the rules come in Task 3)
- Modify: `src/types.ts` (`EventType`, `HousekeepingPayload`, `Session.raised`, `Session.openRequests`, `Session.lastMemberEventAt`, `Member.lastSentAt`), `src/attention.ts`, `src/stored-session.ts` (defaults), `src/store.ts` (`MemoryStore.appendEvent`, `appendEventOnce`, the leave path), `src/store-do.ts` (`#writeEvent` or `appendEvent`, the leave path), `tests/helpers/fixtures.ts`
- Test: `tests/attention.test.ts`, `tests/helpers/store-contract.ts`, `tests/housekeeping.test.ts` (for `noteAppend`)

**Interfaces:**
- Consumes: `SessionEvent`, `Member`, both stores' append paths (`markReported` in `src/store.ts` is the pattern: find it with `grep -n lastReportAt src/store.ts`).
- Produces: `noteAppend(s: Pick<Session, "members" | "openRequests" | "lastMemberEventAt">, e: SessionEvent): Pick<...>` returning the updated fields (pure); `Session.raised: Record<string, { at: number; repeat: number }>`; `Session.openRequests: Record<string, { at: number; fromMemberId: string }>` keyed by the request's cursor as a string; `Session.lastMemberEventAt: number | null`; `Member.lastSentAt?: number`; `EventType` with `"housekeeping"`, `ATTENTION.housekeeping = "interrupt"`.

- [ ] **Step 1: Types and attention.** Add to `EventType`: `/** A proposal the server raises from the room's own thresholds (#66). Never sent by a member. */ | "housekeeping"`. `ATTENTION` gains `housekeeping: "interrupt"` with a comment (a finding nobody reads produces no action, which is the tick's reason). `tests/attention.test.ts`: the known-types set gains `"housekeeping"` and an assertion that it interrupts. `HousekeepingPayload` in `src/types.ts`:

```ts
export type HousekeepingFinding = "member_quiet" | "request_unanswered" | "room_idle";
export interface HousekeepingPayload {
  finding: HousekeepingFinding;
  about?: { member_id: string } | { cursor: number };
  /** When the condition began, ms epoch, the server's clock. */
  since: number;
  /** 1 on the first raise of this key, counting up on each repeat. */
  repeat: number;
}
```

Session fields (with `hydrateStoredSession` defaults `{}`, `{}`, `null`, and `fixtures.session()` the same; `Member.lastSentAt?: number` absent on old rows, read through `lastSent(m) = m.lastSentAt ?? m.joinedAt` in Task 3).

- [ ] **Step 2: `noteAppend`, test first.** `tests/housekeeping.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { noteAppend } from "../src/housekeeping.js";
import { member } from "./helpers/fixtures.js";

const T0 = Date.parse("2026-03-15T12:00:00Z");
const ev = (over: Partial<import("../src/types.js").SessionEvent>) => ({
  cursor: 1, type: "message" as const, fromMemberId: "m_a", fromUserId: "u_a", fromLabel: "a", payload: {}, refId: null, at: T0, ...over,
});
const base = () => ({ members: [member({ memberId: "m_a", joinedAt: T0 - 10 }), member({ memberId: "m_b", userId: "u_b", joinedAt: T0 - 10 })], openRequests: {}, lastMemberEventAt: null as number | null });

describe("noteAppend", () => {
  it("stamps the sender's lastSentAt and the room's lastMemberEventAt on a member event", () => {
    const out = noteAppend(base(), ev({ at: T0 + 5 }));
    expect(out.members.find((m) => m.memberId === "m_a")!.lastSentAt).toBe(T0 + 5);
    expect(out.members.find((m) => m.memberId === "m_b")!.lastSentAt).toBeUndefined();
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
    const answered = noteAppend(opened, ev({ cursor: 9, type: "action_response", fromMemberId: "m_b", refId: "7", at: T0 + 1 }));
    expect(answered.openRequests).toEqual({});
    const unrelated = noteAppend(opened, ev({ cursor: 9, type: "action_response", fromMemberId: "m_b", refId: "3", at: T0 + 1 }));
    expect(unrelated.openRequests).toEqual({ "7": { at: T0, fromMemberId: "m_a" } });
  });
  it("closes a member's requests when that member leaves or is removed", () => {
    const opened = noteAppend(base(), ev({ cursor: 7, type: "action_request", at: T0 }));
    for (const type of ["member_left", "member_evicted", "member_timed_out"] as const) {
      const gone = noteAppend(opened, ev({ cursor: 8, type, fromMemberId: "m_a", at: T0 + 1 }));
      expect(gone.openRequests, type).toEqual({});
    }
  });
});
```

Read how an `action_response` carries the request it answers (`refId` in `src/tools/send.ts`, and whether the stored value is the cursor as a string); the test above assumes `refId: "7"`; if the store holds a number or another shape, adapt the test and the helper to that shape and say so. Likewise read which event types mark a member's departure (`member_left`, `member_evicted`, `member_timed_out`) and whose `fromMemberId` they carry (the leaver's, or the remover's with the leaver in the payload); the helper must key off the member who left.

`src/housekeeping.ts`:

```ts
import type { Member, Session, SessionEvent } from "./types.js";

export const HOUSEKEEP_HANDLER = "housekeep";
type Book = Pick<Session, "members" | "openRequests" | "lastMemberEventAt">;
const DEPARTURES = new Set(["member_left", "member_evicted", "member_timed_out"]);

/**
 * What an append owes housekeeping (#66): the sender's last send, the room's
 * last member event, and the set of requests still waiting. Pure, and shared by
 * both stores, so the two cannot disagree about what "open" means.
 */
export function noteAppend(s: Book, e: SessionEvent): Book {
  if (e.fromMemberId === "system") return s;
  const members = s.members.map((m) => (m.memberId === e.fromMemberId ? { ...m, lastSentAt: e.at } : m));
  const open = { ...s.openRequests };
  if (e.type === "action_request") open[String(e.cursor)] = { at: e.at, fromMemberId: e.fromMemberId };
  if (e.type === "action_response" && e.refId !== null) delete open[String(e.refId)];
  if (DEPARTURES.has(e.type)) {
    const gone = departedMemberId(e);
    for (const [k, r] of Object.entries(open)) if (r.fromMemberId === gone) delete open[k];
  }
  return { members, openRequests: open, lastMemberEventAt: e.at };
}
```

with `departedMemberId(e)` reading the leaver from the event the way the store writes it. Red, then green.

- [ ] **Step 3: Both stores call it.** `MemoryStore.appendEvent` (and `appendEventOnce` if it has its own write path): after building the event, `Object.assign(s, noteAppend(s, event))` in the same synchronous span as the push. `SessionDO`: in `#writeEvent` (or in `appendEvent`'s transaction where the session is put), merge `noteAppend(s, event)` into the session being put, so the event and the bookkeeping land in one put. Contract tests in `tests/helpers/store-contract.ts`: after a member's `message`, `getSession` shows that member's `lastSentAt` at the event's `at` and `lastMemberEventAt` the same; a `heartbeat`-typed append (as the DO writes it, `fromMemberId: "system"`; if the contract cannot append one, assert through the DO-only path in worker-tests instead) moves neither; an `action_request` appears in `openRequests` and the matching `action_response` removes it; Review Focus 5: write 1,100 `message` events after a request and the request is still in `openRequests`.

- [ ] **Step 4: Verify, controls, commit.** Controls, quoted: make `noteAppend` ignore `refId`: the "closes it on the response" test goes red; drop the `system` guard: the server-event test goes red. `npm run verify`. Then:

```bash
git add src/housekeeping.ts src/types.ts src/attention.ts src/stored-session.ts src/store.ts src/store-do.ts tests/helpers/fixtures.ts tests/attention.test.ts tests/housekeeping.test.ts tests/helpers/store-contract.ts
git -c commit.gpgsign=true commit -S -m "Keep what housekeeping reads at every append: the last send, the last member event, and the requests still waiting"
```

---

### Task 3: The rules

**Files:**
- Modify: `src/housekeeping.ts`
- Test: `tests/housekeeping.test.ts`

**Interfaces:**
- Consumes: Task 1's manifest field, Task 2's fields, `isActiveMember` (from `src/store.ts` or `src/presence.ts`: `grep -n "export const isActiveMember" src`), `isRemovedMember`.
- Produces:

```ts
export interface Finding { key: string; payload: HousekeepingPayload }
export function nextHousekeepAt(s: StoredSession, now: number): number | null;
export function dueFindings(s: StoredSession, now: number): Finding[];
export function clearedKeys(s: StoredSession, now: number): string[];
```

- [ ] **Step 1: Tests first.** Build sessions with `session({ manifest: roomManifest({ housekeeping: { quietAfterMs: H2, answerWithinMs: M30, idleAfterMs: D1, repeatAfterMs: null } }) })` as `tests/heartbeat.test.ts` builds its `stored()`. Cases:

- `member_quiet`: a member whose `lastSentAt` is `T0` is not due at `T0 + H2 - 1` and due at `T0 + H2` with `about: { member_id }`, `since: T0 + H2`, `repeat: 1`; a member who left is never named; a removed member (`removedAtCursor` set) is never named; a member with no `lastSentAt` counts from `joinedAt`; with `quietAfterMs: null` nobody is named.
- `request_unanswered`: an entry in `openRequests` at `T0` is due at `T0 + M30` with `about: { cursor: 7 }`; the key is `request_unanswered:7`; with `answerWithinMs: null` nothing.
- `room_idle`: `lastMemberEventAt: T0` is due at `T0 + D1` with no `about`; a room with `lastMemberEventAt: null` counts from the latest `joinedAt`; server events do not move it (that is Task 2's).
- Repeats: with `raised: { "member_quiet:m_a": { at: T0 + H2, repeat: 1 } }`, `dueFindings` at `T0 + H2 + 1` is empty; at `T0 + 2 * H2` (the default `repeat_after` is the threshold) it holds the key with `repeat: 2`; with `repeatAfterMs: M5` it is due at `T0 + H2 + M5` (Review Focus 4).
- `clearedKeys`: a raised quiet key whose member has since sent (`lastSentAt` newer than the threshold allows) is returned; a raised request key whose cursor is no longer in `openRequests` is returned (Review Focus 1); a raised idle key after a member event is returned; a key whose condition still holds is not.
- `nextHousekeepAt`: `null` for `housekeeping: null`, for a closed room, for a frozen room, and for a room with no active member (Review Focus 2); the soonest of the anchors otherwise; for a condition already raised, `raised.at + repeat_after` rather than the past anchor; **strictly after `now` once every due key has just been raised at `now`** (the spin property, pinned as `nextTickAt`'s is: compute due at `now`, apply the raises to `raised`, and assert `nextHousekeepAt(s', now) > now`).

Run: red (`nextHousekeepAt` is not exported).

- [ ] **Step 2: The rules.**

```ts
const lastSent = (m: Member): number => m.lastSentAt ?? m.joinedAt;
const live = (s: StoredSession): Member[] => s.members.filter((m) => isActiveMember(m) && !isRemovedMember(m));

/** Every condition holding at `now`, raised or not: the key, the payload's static part, and when it began. */
function conditions(s: StoredSession, now: number): Array<{ key: string; finding: HousekeepingFinding; about?: HousekeepingPayload["about"]; since: number }> {
  const h = s.manifest.housekeeping;
  if (!h || s.closed || s.frozenAt !== null) return [];
  const members = live(s);
  if (members.length === 0) return [];
  const out = [];
  if (h.quietAfterMs !== null) {
    for (const m of members) {
      const since = lastSent(m) + h.quietAfterMs;
      if (now >= since) out.push({ key: `member_quiet:${m.memberId}`, finding: "member_quiet" as const, about: { member_id: m.memberId }, since });
    }
  }
  if (h.answerWithinMs !== null) {
    for (const [cursor, r] of Object.entries(s.openRequests)) {
      const since = r.at + h.answerWithinMs;
      if (now >= since) out.push({ key: `request_unanswered:${cursor}`, finding: "request_unanswered" as const, about: { cursor: Number(cursor) }, since });
    }
  }
  if (h.idleAfterMs !== null) {
    const last = s.lastMemberEventAt ?? Math.max(...members.map((m) => m.joinedAt));
    const since = last + h.idleAfterMs;
    if (now >= since) out.push({ key: "room_idle", finding: "room_idle" as const, since });
  }
  return out;
}

const repeatAfter = (s: StoredSession, finding: HousekeepingFinding): number => {
  const h = s.manifest.housekeeping!;
  return h.repeatAfterMs ?? (finding === "member_quiet" ? h.quietAfterMs! : finding === "request_unanswered" ? h.answerWithinMs! : h.idleAfterMs!);
};

export function dueFindings(s: StoredSession, now: number): Finding[] {
  return conditions(s, now).flatMap((c) => {
    const prev = s.raised[c.key];
    if (prev && now < prev.at + repeatAfter(s, c.finding)) return [];
    return [{ key: c.key, payload: { finding: c.finding, ...(c.about ? { about: c.about } : {}), since: c.since, repeat: (prev?.repeat ?? 0) + 1 } }];
  });
}

export function clearedKeys(s: StoredSession, now: number): string[] {
  const holding = new Set(conditions(s, now).map((c) => c.key));
  return Object.keys(s.raised).filter((k) => !holding.has(k));
}

/** The soonest moment a rule can become due, or a raised key can repeat; null when nothing can. */
export function nextHousekeepAt(s: StoredSession, now: number): number | null {
  const h = s.manifest.housekeeping;
  if (!h || s.closed || s.frozenAt !== null) return null;
  const members = live(s);
  if (members.length === 0) return null;
  const times: number[] = [];
  const consider = (key: string, finding: HousekeepingFinding, anchor: number) => {
    const prev = s.raised[key];
    times.push(prev ? Math.max(anchor, prev.at + repeatAfter(s, finding)) : anchor);
  };
  if (h.quietAfterMs !== null) for (const m of members) consider(`member_quiet:${m.memberId}`, "member_quiet", lastSent(m) + h.quietAfterMs);
  if (h.answerWithinMs !== null) for (const [cursor, r] of Object.entries(s.openRequests)) consider(`request_unanswered:${cursor}`, "request_unanswered", r.at + h.answerWithinMs);
  if (h.idleAfterMs !== null) consider("room_idle", "room_idle", (s.lastMemberEventAt ?? Math.max(...members.map((m) => m.joinedAt))) + h.idleAfterMs);
  return times.length === 0 ? null : Math.min(...times);
}
```

`now` is unused by `nextHousekeepAt`'s arithmetic and kept in the signature for symmetry with `dueFindings`; if the lint flags it, drop the parameter and update the spec's schema line in Task 5. Run: green.

- [ ] **Step 3: Controls, commit.** Controls, quoted: make `consider` ignore `prev` and the spin test goes red; make `conditions` skip the `removedAtCursor` check and the removed-member test goes red; make `clearedKeys` return `[]` and Review Focus 1's test goes red. `npm run verify`. Then:

```bash
git add src/housekeeping.ts tests/housekeeping.test.ts
git -c commit.gpgsign=true commit -S -m "The housekeeping rules: a quiet member, an unanswered request and an idle room, each due once per window and cleared by its condition"
```

---

### Task 4: The handler on the room's alarm, and the wire

**Files:**
- Modify: `src/store-do.ts` (`#derivedDue`, `alarm`, `#housekeepIfDue`), `src/public-event.ts` (if the projection branches on type), `tests/tools/send.test.ts` or the file that refuses a forged `heartbeat` (`grep -rn '"heartbeat"' tests/tools/`)
- Test: `worker-tests/housekeeping.test.ts`, the send refusal test

**Interfaces:**
- Consumes: `HOUSEKEEP_HANDLER`, `nextHousekeepAt`, `dueFindings`, `clearedKeys`; `#writeEvent`, `nextCursor`, `#wake`; `isAbandoned`, `connectedAmong`.
- Produces: the `housekeeping` events on the wire, through `bellman_sync` and the sockets as any event.

- [ ] **Step 1: The derived due and the handler.** In `#derivedDue()`, after the heartbeat line: `const hk = nextHousekeepAt(s, Date.now()); if (hk !== null) due.set(HOUSEKEEP_HANDLER, hk);`. In `alarm()`: `if (name === HOUSEKEEP_HANDLER) await this.#housekeepIfDue(now);`. The handler, modelled on `#tickIfDue`:

```ts
  /**
   * Raise what the room's own thresholds say is due (#66), once per window, and
   * forget what no longer holds. One transaction: the events, their cursors and
   * the updated `raised` land together, so an interruption leaves nothing half
   * said. The guards are the same as the tick's and are the point: nothing is
   * written into a room that cannot answer.
   */
  async #housekeepIfDue(now: number): Promise<void> {
    const events = await this.ctx.storage.transaction<SessionEvent[]>(async (txn) => {
      const s = await this.stored(txn);
      if (!s || s.closed || s.frozenAt !== null || !s.manifest.housekeeping) return [];
      if (isAbandoned(s, now, connectedAmong(s.members, this.#attachedIds()))) return [];
      const raised = { ...s.raised };
      for (const k of clearedKeys(s, now)) delete raised[k];
      const due = dueFindings(s, now);
      const written: SessionEvent[] = [];
      let next: StoredSession = { ...s, raised };
      for (const f of due) {
        const event: SessionEvent = {
          cursor: await this.nextCursor(txn),
          type: "housekeeping" as EventType,
          fromMemberId: "system", fromUserId: "system", fromLabel: "bellman",
          payload: f.payload, refId: null, at: now,
        };
        raised[f.key] = { at: now, repeat: f.payload.repeat };
        next = { ...next, raised: { ...raised } };
        await this.#writeEvent(txn, event, { session: next });
        written.push(event);
      }
      if (due.length === 0) await txn.put("session", next);
      return written;
    });
    for (const e of events) this.#wake(e);
  }
```

Read `#writeEvent` and `nextCursor` before writing this: if `nextCursor` reads the cursor once per transaction, draw it once and increment locally; if `#writeEvent` requires the whole session in `{ session }`, the shape above fits. Note that `noteAppend` must not be applied to these events (they are `system`; Task 2's helper already returns the input unchanged for them).

- [ ] **Step 2: Worker tests**, `worker-tests/housekeeping.test.ts`, in the style of `worker-tests/heartbeat-tick.test.ts`: (a) a room with `quietAfterMs` five minutes and one member whose `lastSentAt` is `T0`: after creation `getAlarm()` is `T0 + 5 min`; set the clock past it, `runDurableObjectAlarm`; one `housekeeping` event with `finding: "member_quiet"`, `about.member_id`, `repeat: 1`, `fromMemberId: "system"`; `getAlarm()` is now `T0 + 10 min`; a second run before that writes nothing. (b) Review Focus 3: a frozen room thawed after every threshold passed: one firing writes one event per key, each `repeat: 1`. (c) Review Focus 2: every member left: `getAlarm()` holds no housekeeping time and a forced `alarm()` writes nothing. (d) An `action_request` appended through the store, then the alarm at `T0 + answer_within`: `request_unanswered` with `about.cursor` equal to the request's cursor; an `action_response` with its `refId` then clears it: the next alarm writes nothing for it. (e) The event reaches `bellman_sync`'s shape: `publicEvent` of it carries the payload unwrapped and no `ambient` flag (read `src/public-event.ts`: if member payloads are wrapped as untrusted, assert this one is not, as the tick is not).

- [ ] **Step 3: The refusal.** Beside the test that refuses `bellman_send` with `type: "heartbeat"`, add `type: "housekeeping"`, asserting the refusal names the allowed kinds and appends nothing. If no such heartbeat test exists, write both.

- [ ] **Step 4: Verify, controls, commit.** Controls, quoted: drop the `isAbandoned` guard and a test with every member past `ABANDONED_AFTER_MS` (one more case, written for the control and kept) goes red; drop the `raised` write and (a)'s "second run writes nothing" goes red. `npm run verify`. Then:

```bash
git add src/store-do.ts src/public-event.ts worker-tests/housekeeping.test.ts <send refusal test>
git -c commit.gpgsign=true commit -S -m "Raise housekeeping proposals on the room's alarm, one per finding per window, and refuse the type from any member"
```

---

### Task 5: The docs

**Files:**
- Modify: `docs/ARCHITECTURE.md` (§4 the handler beside `outbox`, `abandoned`, `heartbeat`, `sweep` and `purge` if #65 landed first, else beside the three; §8 B3 shipped; the frontmatter's `last-verified-against-source`), `README.md` (the manifest's `housekeeping` field, the event, and the sentence that the server proposes and never acts; the Review Focus 4 sentence on a short `repeat_after`), `src/tools/send.ts` if its description lists event types a member may receive (`grep -n heartbeat src/tools/send.ts src/tools/sync.ts`)
- Test: none beyond `npm run verify` and the writing sweep

- [ ] **Step 1: ARCHITECTURE.** Beside the handler list: `housekeep` raises a server-authored `housekeeping` event when a member has gone quiet, an action request is unanswered or the room is idle past the thresholds the manifest declares, once per window, cleared by the condition; it holds no seat and no verb and acts on nothing; the bookkeeping it reads is kept at every append by both stores. §8: B3 shipped. Bump `last-verified-against-source` to Task 4's commit.

- [ ] **Step 2: README and the tool text.** The manifest section documents `housekeeping` with its four keys, the bounds, the defaults, and the one-sentence trust statement; one sentence that a `repeat_after` shorter than a threshold repeats that often, by design. If `bellman_sync`'s or `bellman_send`'s description enumerates the event types a member sees, add `housekeeping` with one clause. Writing sweep: `git diff origin/main..HEAD | grep -E '^\+' | grep -niE 'load-bearing|worth saying plainly|two sessions|other session|counterpart|other side'` prints nothing.

- [ ] **Step 3: Verify and commit.**

```bash
git add docs/ARCHITECTURE.md README.md src/tools/send.ts src/tools/sync.ts
git -c commit.gpgsign=true commit -S -m "Record housekeeping in ARCHITECTURE, the README and the tool text"
```
