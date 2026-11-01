# Decision Deadline Alarm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every decision past its deadline is closed `expired` when its deadline passes, in quiet, frozen and closed
rooms alike, instead of waiting for another decision to open.

**Architecture:** `SessionDO`'s one alarm gains a derived handler, `decision`, due one millisecond after the earliest
deadline in the record's `openDecisions` book. It is derived before the closed-room early return in `#derivedDue`.
Firing it closes every overdue decision through `closeDecision`, with audit rows written as the system. A
`closeDecision` with `expired` no longer refuses a frozen room. The Node server's `MemoryStore.housekeep` does the
same on its 60-second pass.

**Tech Stack:** TypeScript, Cloudflare Workers and Durable Objects, vitest (Node), vitest-pool-workers (workerd).

**Spec:** `docs/superpowers/specs/2026-11-01-secret-ballot-design.md`, Change 1 (plan items 1-7, sections "Deadline
alarm (every decision)" and "Close paths", path 4). One deviation: the spec's item 5 adds the alarm cases to
`worker-tests/alarms.test.ts`; this plan puts them in a new `worker-tests/decision-deadline.test.ts`, because they
need a vote-holding room and that file's fixture has none.

## Global Constraints

- Every `BellmanStore` method stays async. `MemoryStore.housekeep` stays synchronous ("No awaits").
- Read and register in the same turn: nothing added to `#derivedDue` may await between reads it already makes.
- `#private` for any new `SessionDO` method: a Durable Object answers RPC for every method on its class.
- The new handler is derived, never a stored `due:` row, so a rollback strands nothing.
- `npm run verify` passes before every commit.
- The repo is a plain git worktree here; commit with git. Commits are signed (ssh); never bypass signing.
- Docs never describe a room as two sessions; say members.

## Review Focus

1. **A deadline exactly at `now`.** `dueToExpire` and `decideClose` treat a decision as overdue only once
   `now > expires_at`. The handler is due at `expires_at + 1`, so the alarm never fires, finds nothing, and fires
   again at once. Pinned by Task 3's "armed at the deadline plus one" test.
2. **A room that closes with a decision open.** Without the derivation above the closed-room return, the decision
   stays open forever. Pinned by Task 3's closed-room test.
3. **A frozen room.** A freeze stops members writing; it must not stop the clock closing a decision. Pinned by
   Task 1's contract test and Task 3's frozen test.
4. **A decision opened with an earlier deadline than the armed alarm.** The alarm must move earlier, or the new
   decision closes late. Pinned by Task 3's re-arm test.
5. **A late vote between the deadline and the alarm.** It still lands (ADR 0040 decision 4 as amended); after the
   close it is refused `closed`. Already pinned by the existing contract test "derives expired from the clock
   given, closes only once it is due, and lands no vote after the close".

---

### Task 1: `earliestDeadline`, and an `expired` close that ignores a freeze

**Files:**
- Modify: `src/decision.ts` (beside `dueToExpire`)
- Modify: `src/store.ts` (`MemoryStore.closeDecision`, and the `closeDecision` doc on `BellmanStore`)
- Modify: `src/store-do.ts` (`SessionDO.closeDecision`)
- Test: `tests/decision.test.ts`, `tests/helpers/store-contract.ts` (the decisions `describe` that defines `room`,
  `draft`, `opening`, `open` and `ballot`)

**Interfaces:**
- Produces: `earliestDeadline(book: OpenDecisions): number | null` exported from `src/decision.ts`: the smallest
  `expires_at` in the book, `null` for an empty book.
- Produces: `closeDecision(..., { state: "expired" }, now, audit)` succeeds in a frozen room in both stores. Any
  other state still returns `{ outcome: "frozen" }` there.

- [ ] **Step 1: Write the failing unit test** in `tests/decision.test.ts`:
  `it("earliestDeadline is the smallest expires_at, null for an empty book")`:
  `earliestDeadline({})` is `null`; for
  `{ "7": { expires_at: 300, by: "m_a" }, "9": { expires_at: 200, by: "m_b" } }` it is `200`.

- [ ] **Step 2: Write the failing contract test** in the decisions `describe` of `tests/helpers/store-contract.ts`:
  `it("closes an overdue decision expired in a frozen room, and still refuses any other close there")`:
  `const id = await room(); const { event } = await open(id);` read `deadline` from
  `event.payload.expires_at`; `await store.freezeSession(id, Date.now())`;
  `closeDecision(id, event.cursor, { state: "failed", reason: "rejected" }, deadline + 1)` equals
  `{ outcome: "frozen" }`; `closeDecision(id, event.cursor, { state: "expired" }, deadline + 1)` matches
  `{ outcome: "appended", event: { type: "decision_closed", payload: { decision: event.cursor, state: "expired" } } }`.

- [ ] **Step 3: Run both to verify they fail**

  Run: `npx vitest run tests/decision.test.ts tests/store.test.ts -t "earliestDeadline|frozen room, and still refuses"`
  Expected: FAIL: `earliestDeadline is not a function`, and the frozen `expired` close returns `{ outcome: "frozen" }`.

- [ ] **Step 4: Implement**
  - `earliestDeadline` in `src/decision.ts`, documented like `dueToExpire`.
  - In both `closeDecision`s, refuse a frozen room only when `close.state !== "expired"`. Update the
    `BellmanStore.closeDecision` doc: "An `expired` close ignores a freeze: the clock closes a decision whatever the
    members may write."

- [ ] **Step 5: Run to verify they pass**, including the workerd copy of the contract.

  Run: `npx vitest run tests/decision.test.ts tests/store.test.ts && npm run test:worker`
  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add src/decision.ts src/store.ts src/store-do.ts tests/decision.test.ts tests/helpers/store-contract.ts
  git commit -m "An expired decision close ignores a freeze; earliestDeadline reads the open-decisions book"
  ```

### Task 2: `MemoryStore.housekeep` closes overdue decisions

**Files:**
- Modify: `src/store.ts` (`MemoryStore.housekeep`)
- Test: `tests/store.test.ts`

**Interfaces:**
- Consumes: `dueToExpire`, `noteDecisions`, `closingEvent` (`src/decision.ts`); `auditRows`, `SYSTEM_ACTOR`
  (`src/audit.ts`); `rosterParties` (`src/store.ts`); the private `decisionIn` and `decisionWrites`.
- Produces: after `housekeep(now, rules)`, every decision in every room whose `expires_at < now` has a
  `decision_closed` with `state: "expired"`, and a closing audit row with `actorUserId: "system"`.

- [ ] **Step 1: Write the failing test** in `tests/store.test.ts`:
  `it("housekeep closes every overdue decision expired, in live, abandoned and frozen rooms, as the system")`.
  - Build three rooms with a vote-holding manifest, as the contract's decisions `describe` does: a live room, an
    abandoned room (its members' `lastSeenAt` set past `ABANDONED_AFTER_MS`), and a frozen room
    (`freezeSession(id, Date.now())` after the open).
  - Open one decision in each through `store.openDecision`, and read its `expires_at`.
  - Call `store.housekeep(deadline + 1, { dueFindings: () => [], clearedKeys: () => [] })`.
  - For each room: `store.decision(id, cursor, deadline + 1)` has `state: "expired"`, and the last event is a
    `decision_closed` from `system`.
  - `store.auditForOrg("org_codenerd", 50)` holds a `decision_closed` row per room with `actorUserId: "system"` and
    `direction: null`.
  - A second `housekeep` at the same time writes no event: the count of `eventsAfter(id, 0)` is unchanged.

- [ ] **Step 2: Run it to verify it fails**

  Run: `npx vitest run tests/store.test.ts -t "housekeep closes every overdue decision"`
  Expected: FAIL: state `open` (or `expired` derived from the clock with no `decision_closed` event).

- [ ] **Step 3: Implement in `MemoryStore.housekeep`**
  - At the top of the per-room loop, **before** the `isAbandoned` skip, run
    `dueToExpire(noteDecisions({}, s.events), now)`.
  - For each cursor, `this.decisionWrites(s, [closingEvent(this.decisionIn(s, cursor, now)!, { state: "expired" })], now, audit)`,
    where `audit` is `auditRows(rosterParties(s), { at: now, sessionId: s.id, action: "decision_closed", roomName: s.manifest.room, detail: {} }, SYSTEM_ACTOR)`.
  - No await. The frozen state is not checked: the clock's close ignores a freeze (Task 1).

- [ ] **Step 4: Run it to verify it passes**

  Run: `npx vitest run tests/store.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/store.ts tests/store.test.ts
  git commit -m "The Node housekeeping pass closes every overdue decision, as the system"
  ```

### Task 3: `SessionDO`'s `decision` alarm handler

**Files:**
- Modify: `src/store-do.ts` (a `DECISION_HANDLER` constant beside `EXPIRY_HANDLER`; `#derivedDue`; `alarm()`; a new
  `#expireDecisionsIfDue`; `#writeDecision`'s `forward`)
- Create: `worker-tests/decision-deadline.test.ts`

**Interfaces:**
- Consumes: `earliestDeadline` and `dueToExpire` (`src/decision.ts`); `closeDecision` (Task 1); `auditRows`,
  `SYSTEM_ACTOR`, `rosterParties`.
- Produces: an armed alarm no later than `earliestDeadline(openDecisions) + 1` whenever a decision is open, in open,
  frozen and closed rooms.

- [ ] **Step 1: Write the failing tests** in `worker-tests/decision-deadline.test.ts`.
  - **Fixtures:** copy `room()`, `draft()` and `opening()` from `worker-tests/decision-pages.test.ts` (a vote-holding
    `peer_a`). Add a `backdate(stub, cursor, at)` helper that runs in the object:
    - `editRoom(ctx.storage, { record: (r) => ({ ...r, openDecisions: { ...r.openDecisions, [cursor]: { ...r.openDecisions[cursor], expires_at: at } } }) })`
    - then rewrite the `e:` row whose value has `cursor === cursor`, setting `payload.expires_at = at`
  - `it("arms the alarm one millisecond after the earliest open deadline")`: open a decision with
    `expires_ms: MIN_DECISION_TTL_MS` (5 minutes, earlier than anything else the fixture arms); `getAlarm()` equals
    its `expires_at + 1`.
  - `it("re-arms earlier when a decision opens with an earlier deadline")`: open a decision with the default
    deadline, then one with `expires_ms: MIN_DECISION_TTL_MS`; `getAlarm()` equals the second's `expires_at + 1`.
  - `it("firing closes an overdue decision expired and arms nothing for it after")`:
    - `backdate(stub, cursor, Date.now() - 1)`, then `instance.alarm()`
    - the last `e:` row is a `decision_closed` with `state: "expired"` from `system`
    - the record's `openDecisions` no longer holds the cursor
    - `getAlarm()` is not `expires_at + 1`
  - `it("closes an overdue decision in a frozen room")`: as above, after `editRoom` sets `frozenAt: Date.now()`.
  - `it("closes an overdue decision in a closed room")`: as above, after `editRoom` sets `closed: true`.
  - `it("writes the closing audit row as the system")`: after the firing test's close,
    `vi.waitFor(() => store.auditForOrg("org_codenerd", 50))` holds a `decision_closed` row with
    `actorUserId: "system"`.

- [ ] **Step 2: Run them to verify they fail**

  Run: `npm run test:worker -- decision-deadline`
  Expected: FAIL. `getAlarm()` is the abandonment time, not the deadline, and firing leaves the decision open.

- [ ] **Step 3: Implement in `src/store-do.ts`**
  - **The constant:** `DECISION_HANDLER = "decision"`, with a doc comment in the style of `EXPIRY_HANDLER`'s:
    derived from the record's `openDecisions`, never stored under `due:`, and consumed by `#expireDecisionsIfDue`,
    which closes every overdue decision and so moves the time on.
  - **`#derivedDue`:** compute `earliestDeadline(s.openDecisions ?? {})` **before** the `if (s.closed)` branch, and
    set `DECISION_HANDLER` to it plus 1 when it is non-null. Extend the method's comment: a closed room still owes
    its open decisions their close.
  - **`alarm()`:** dispatch with `if (name === DECISION_HANDLER) await this.#expireDecisionsIfDue(now)`.
  - **`#expireDecisionsIfDue(now: number): Promise<void>`:**
    - read `this.stored()`, and return when it is missing
    - for each cursor of `dueToExpire(s.openDecisions ?? {}, now)`, call
      `this.closeDecision(cursor, { state: "expired" }, now, audit)` with `audit` as in Task 2 (`s.id`, `s.manifest.room`)
    - write nothing when none is due
  - **`#writeDecision`:** `forward` is also true when the book after the write has an earlier `earliestDeadline`
    than the book before it (a `null` before counts as later than anything).

- [ ] **Step 4: Run them to verify they pass**, plus the existing alarm and decision suites.

  Run: `npm run test:worker`
  Expected: PASS, including `worker-tests/alarms.test.ts` and `worker-tests/decision-pages.test.ts` unchanged.

- [ ] **Step 5: Commit**

  ```bash
  git add src/store-do.ts worker-tests/decision-deadline.test.ts
  git commit -m "SessionDO's alarm closes every overdue decision at its deadline, in frozen and closed rooms too"
  ```

### Task 4: ADR 0040 amendment and the architecture diagram

**Files:**
- Modify: `docs/adr/0040-room-consensus.md`
- Modify: `docs/ARCHITECTURE.md` (the `SDO[...]` node of the Durable Objects diagram)
- Modify, only if PR #507 has merged into this branch's base: `src/EGM.md`

- [ ] **Step 1: ADR 0040.**
  - Add a section "### Amendment, 2026-11-01 (Jesse)" after the 2026-10-29 amendment, with decision 22: "The
    deadline alarm closes every overdue decision `expired` one millisecond after its deadline, in frozen and closed
    rooms too; a vote cast between the deadline and that close still lands."
  - In decision 4, replace the clause saying `expired` is written on the first read or housekeeping tick after the
    deadline with "and `expired` is written by the room's deadline alarm (decision 22)". Keep the sentence on late
    votes landing until the close.
  - Mark open question 6 "*Resolved (Jesse, 2026-11-01):* the room's alarm writes it (decision 22)."
  - Add one line to the revision note at the top.
- [ ] **Step 2: ARCHITECTURE.** In the `SDO["SessionDO — ..."]` label, add "decision deadlines" to the list of the
  alarm's jobs.
- [ ] **Step 3: EGM contract.** Only if `src/EGM.md` exists: add `decision` to its list of `SessionDO` alarm
  handlers, with a one-clause gloss.
- [ ] **Step 4: Verify.** Run `npm run verify` (expected: exit code 0), then `npx wrangler deploy --dry-run`
  (expected: it builds and reports no binding errors).
- [ ] **Step 5: Commit**

  ```bash
  git add docs/adr/0040-room-consensus.md docs/ARCHITECTURE.md
  git commit -m "ADR 0040 decision 22: the room's alarm closes overdue decisions; open question 6 resolved"
  ```

## After the last task

Open the PR as a **draft** while spec PR #510 is unmerged, if this branch was cut from `mcfearsome/secret-ballot-spec`.
After merging, confirm the deploy workflow run on `main` succeeded.
