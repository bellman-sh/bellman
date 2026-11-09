# Seat Names and Addressed Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every seat has a name, `<role>-<seq>`, and `bellman_send` can address a message or artifact to named seats, which wakes them and no one else on any delivery path.

**Architecture:** The name is derived, never stored (`seatName`). An addressed event stores `toMemberIds`. Projections take a names map and a reader, so `from.name`, `to` and a per-reader `ambient` come out of one function (`publicEvent`). The long poll gets a reader-aware waiter in both stores. The bridge, the Stop hook and `bellman_wait` treat an event addressed to other seats as no reason to wake.

**Tech Stack:** TypeScript, zod, MCP SDK, Cloudflare Durable Objects, vitest (Node and workerd programs), Bun for the mod kit.

**Spec:** `docs/superpowers/specs/2026-11-08-seat-names-design.md`. Executors read both. Where this plan and the spec disagree, this plan is the later reading of the code: the spec says `bellman_start` returns `members[]`, and it does not.

## Global Constraints

- Branch and land by PR; `main` moves only through merges. The repo is colocated jj.
- `npm run verify` before every commit, with its real exit code checked.
- Every `BellmanStore` method stays async. `waitForEvents` reads and registers in the same turn, with no `await` between them.
- Peer content is untrusted. A payload never sets `to`, and nothing parses `@name` out of text.
- An addressed message is not private: every reader that reads the room's log today reads it.
- Seat names are never called "handles" anywhere: code, docs, tool text, commit messages or PR bodies.
- Every event that exists today (no `toMemberIds`) behaves exactly as it does now, on every path.
- Tool text uses the concise style. The listing stays under 11,840 tokens: measure, trim other wording to fit if needed, and add a §11 row. The ceiling is not raised.
- A tool schema change runs `npm run docs:gen`. A bridge or Stop-hook change runs `npm run build:plugin` only in the release PR, not here (CLAUDE.md).
- Rooms hold many members. Never write "the other session".

## Review Focus

1. **An event from before this ships.** No `toMemberIds` field, `ambient` unchanged, fingerprint unchanged, nothing in the Stop hook or long poll behaves differently. Pinned in Tasks 2, 4, 6 and 7.
2. **A batch in the Stop hook that holds only events addressed to others.** It must force no turn and lose no event: they are still queued for the next waking batch. A mixed batch delivers everything. Pinned in Task 7.
3. **The long poll with only addressed-away events.** It must not return early, must return them at the timeout, and `cursor` must advance past them. An interrupting event arriving later in the wait returns both. Pinned in Task 6.
4. **`to` with case, duplicates, self, a departed seat, a seat without `receive_messages`, or 21 names.** Matched case-insensitively, deduplicated, and every other case refused naming the name. Pinned in Tasks 1 and 5.
5. **A keyed retry with a different `to`.** A reused key is refused as `conflict`; the same `to` replays. Pinned in Task 5.

---

### Task 1: Seat names and resolving addressees

**Files:**
- Modify: `src/room/member-names.ts`
- Test: `tests/member-names.test.ts` (create if absent, else extend)

**Interfaces:**
- Produces: `seatName(m: Pick<Member, "roomRole" | "seq">): string`, giving `` `${m.roomRole}-${m.seq}` ``.
- Produces: `seatNames(members: readonly Member[]): ReadonlyMap<string, string>`, from memberId to name.
- Produces: `resolveAddressees(session: StoredSession, me: Member, names: readonly string[]): RoomResult<Member[]>`, the matched active members in the order given, with duplicates removed.
- Produces: `MAX_ADDRESSEES = 20`.

- [ ] **Step 1: Write failing tests**
  - `seatName({ roomRole: "coder", seq: 17 })` is `"coder-17"`. A role with a hyphen: `seatName({ roomRole: "lead-dev", seq: 3 })` is `"lead-dev-3"`.
  - `resolveAddressees` with `["Coder-2", "coder-2"]` returns that one member once.
  - Refusals, each `code: "invalid"` with the name in `reason`:
    - an unknown name;
    - a departed seat (`leftAt !== null`), refused as unknown;
    - the caller's own name: "you cannot address yourself";
    - a named seat without `receive_messages`: "<name> does not allow receive_messages";
    - 21 names: "at most 20 addressees".
- [ ] **Step 2: Run** `npx vitest run tests/member-names.test.ts`. Expected: FAIL, `seatName` is not exported.
- [ ] **Step 3: Implement the four exports in `src/room/member-names.ts`.** Match names by `toLowerCase()`. Look up against `activeMembers(session)`. Refuse with `refuse` from `./rooms.js`.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit.** `jj commit -m "Seat names: seatName and resolveAddressees"`

### Task 2: `toMemberIds` on events, persisted and fingerprinted

**Files:**
- Modify: `src/types.ts` (`SessionEvent`)
- Modify: `src/storage/idempotency.ts` (`fingerprint`)
- Test: `tests/helpers/store-contract.ts`

**Interfaces:**
- Produces: `SessionEvent.toMemberIds?: string[] | null`. Absent or null means the event is not addressed.
- Produces: `fingerprint(e)`, which appends `e.toMemberIds` only when it is a non-empty array, so every existing print is unchanged.

- [ ] **Step 1: Write failing contract tests**
  - "persists toMemberIds on an appended event and reads it back on eventsAfter, eventAt and waitForEvents".
  - "appendEventOnce treats a different toMemberIds under the same key as conflict, and the same one as replayed".
  - "an event without toMemberIds reads back without the field", so old rows are unchanged.
- [ ] **Step 2: Run** `npx vitest run tests/store-contract` and `npm run test:worker -- store-contract`. Expected: the conflict case fails. The persistence cases may already pass, because both stores spread the body.
- [ ] **Step 3: Add the optional field to `SessionEvent`, and the conditional element to `fingerprint`.**
- [ ] **Step 4: Run** both programs' contract tests. Expected: PASS.
- [ ] **Step 5: Commit.** `jj commit -m "Events carry toMemberIds; the fingerprint covers it when set"`

### Task 3: Names on members

**Files:**
- Modify: `src/projections.ts` (`storedMember`, and through it `publicMember`, `roomSummary` and `rosterAsOf`)
- Modify: `src/tools/confirm.ts` (`head`; the `member_joined` payload)
- Modify: `src/tools/start.ts` (the return)
- Test: `tests/projections.test.ts`, `tests/tools/confirm.test.ts`, `tests/tools/start.test.ts`

**Interfaces:**
- Consumes: `seatName` (Task 1).
- Produces: `storedMember`'s Pick gains `"seq"`, and its output gains `name: seatName(m)`.
- Produces: `bellman_confirm` and `bellman_start` return the caller's `name` beside `member_id`.

- [ ] **Step 1: Write failing tests**
  - `bellman_confirm` returns `name` equal to `` `${room_role}-${seq}` `` for the joiner.
  - Each entry of `members[]` has its own `name`.
  - Two seats of one account have different names.
  - The `member_joined` event's payload `member.name` is the joiner's name.
  - `bellman_start` returns the creator's `name`.
  - `bellman_rooms` lists `name` on each member.
- [ ] **Step 2: Run** those files. Expected: FAIL, `name` is missing.
- [ ] **Step 3: Add `seq` to `storedMember`'s Pick and `name` to its output.** In `confirm.ts`, build `member_joined`'s `storedMember` from the seated row in `joined.members`, which has its `seq`, not from the pre-seat `member`. Add `name` to `head` and to `start.ts`'s return.
- [ ] **Step 4: Run** them. Expected: PASS. `tests/projections.test.ts` still asserts the module is runtime-free.
- [ ] **Step 5: Commit.** `jj commit -m "Members carry their seat name"`

### Task 4: One projection for `from.name`, `to` and per-reader `ambient`

**Files:**
- Modify: `src/room/attention.ts`
- Modify: `src/public-event.ts` (`publicEvent`)
- Modify: `src/tools/sync.ts`, `src/http/rooms.ts` (the events route), `src/workerd/session-do.ts` (`#sendToSockets`, socket replay)
- Test: `tests/attention.test.ts`, `tests/public-event.test.ts` (create if absent)

**Interfaces:**
- Produces: `addressedAway(e: Pick<SessionEvent, "toMemberIds">, reader: string | undefined): boolean`. True when `toMemberIds` is a non-empty array and `reader` is defined and not in it.
- Produces: `publicEvent(e: SessionEvent, view: { names?: ReadonlyMap<string, string>; reader?: string } = {})`.
  - `from` gains `name` when `view.names` has the sender.
  - The output gains `to: { member_id, name }[]` when the event is addressed.
  - `ambient: true` is set when `isAmbient(e) || addressedAway(e, view.reader)`.
- Consumes: `seatNames` (Task 1).

- [ ] **Step 1: Write failing tests**
  - `addressedAway` is false with no `toMemberIds`, false for an addressee, true for another reader, and false with no reader.
  - `publicEvent` of an unaddressed event with no view equals today's output, field for field.
  - An addressed message read by a non-addressee has `ambient: true` and `to` naming the addressees. Read by an addressee, it has no `ambient`.
  - `tests/attention.test.ts`'s table test is unchanged and passes.
  - A public room's read of an addressed event (`publicReadEvent`) has no `from.name`, and its `to` is `["member 2"]`,
    the addressees' public numbers from `publicNames` (spec: public pages name members by number).
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement `addressedAway` beside `isAmbient`, and the `view` parameter.** Pass `{ names: seatNames(session.members), reader: member_id }` from `bellman_sync`. Pass `{ names }` from the panel route and from both socket paths in `SessionDO`; the frame carries `to` and no per-reader `ambient`.
  `publicReadEvent` calls it with no names and maps `to` to public numbers.
- [ ] **Step 4: Run** the Node suite and `npm run test:worker`. Expected: PASS.
- [ ] **Step 5: Commit.** `jj commit -m "publicEvent names the sender and addressees, and is ambient for a non-addressee"`

### Task 5: `bellman_send` takes `to`

**Files:**
- Modify: `src/tools/send.ts` (`inputSchema`, the message/artifact checks, `draft`)
- Test: `tests/tools/send-to.test.ts` (create)

**Interfaces:**
- Consumes: `resolveAddressees`, `MAX_ADDRESSEES` (Task 1); `SessionEvent.toMemberIds` (Task 2).
- Produces: `bellman_send` argument `to?: string[]`, valid for `type` `message` and `artifact` only.

- [ ] **Step 1: Write failing tests**
  - An addressed message appends with `toMemberIds` set to the resolved ids.
  - `to` on any other type is refused: "to is only for message and artifact".
  - Each Task 1 refusal reaches the caller and appends nothing.
  - A keyed retry with the same `to` replays. The same key with another `to` is refused as reused.
  - An addressed message passes when the addressee allows `receive_messages`, even though another member does not.
- [ ] **Step 2: Run** `npx vitest run tests/tools/send-to.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add `to: z.array(z.string().min(1).max(64)).min(1).max(MAX_ADDRESSEES).optional()` to the schema. When `to` is given, `resolveAddressees` replaces the "every other member is deaf" check. Put `toMemberIds` on `draft` only when it is set.
- [ ] **Step 4: Run** it, then `npx vitest run tests/tools`. Expected: PASS.
- [ ] **Step 5: Commit.** `jj commit -m "bellman_send addresses a message or artifact to named seats"`

### Task 6: The long poll waits past events addressed to others

**Files:**
- Modify: `src/storage/store.ts` (`waitForEvents`)
- Modify: `src/storage/memory-store.ts` (`Waiter`, `waitForEvents`, `wake`)
- Modify: `src/workerd/session-do.ts` (`Waiter`, `waitForEvents`, `#wake`)
- Modify: `src/workerd/store-do.ts`
- Modify: `src/tools/sync.ts`
- Test: `tests/helpers/store-contract.ts`, `tests/tools/sync-status.test.ts`

**Interfaces:**
- Consumes: `addressedAway` (Task 4).
- Produces: `waitForEvents(sessionId: string, cursor: number, waitMs: number, limit?: number, reader?: string): Promise<SessionEvent[]>`.
  - With `reader`, it returns early only when an event after `cursor` is not `addressedAway` for `reader`.
  - Otherwise it waits.
  - At the timeout it resolves with the events after `cursor` (up to `limit`), not `[]`.
  - Without `reader`, behaviour is unchanged.

- [ ] **Step 1: Write failing contract tests**, in both stores:
  - "a reader-aware wait does not return early for an event addressed to another seat, and returns it at the timeout".
  - "a reader-aware wait wakes for an addressed-to-me event".
  - "a reader-aware wait that saw only addressed-away events wakes for a later unaddressed event, returning both".
  - "reads and registers in the same turn for a reader": an event appended in the same tick as the call must not be missed. Use `ParkingStore` in `sync-status.test.ts` as the model.
  - In `bellman_sync`: an addressed-away-only wait returns the events flagged `ambient`, and its `cursor` is past them.
- [ ] **Step 2: Run** `npx vitest run tests/store-contract` and `npm run test:worker -- store-contract`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `Waiter` gains `reader?: string`.
  - `MemoryStore.wake` resolves only the waiters with a waking event after `w.after`, and keeps the rest in the list instead of clearing it.
  - `SessionDO.#wake` filters the same way.
  - Both timeouts resolve with the read.
  - `bellman_sync` passes `member_id` as `reader`.
- [ ] **Step 4: Run** both programs in full. Expected: PASS.
- [ ] **Step 5: Commit.** `jj commit -m "The long poll waits past events addressed to other seats"`

### Task 7: Bridge, channel, Stop hook and `bellman_wait`

**Files:**
- Modify: `src/client/inbox.ts` (`WireEnvelope`, `PeerEvent`, `renderEvent`, `drain`)
- Modify: `src/client/room-socket.ts` (`roomEventFromFrame`)
- Modify: `src/client/bridge.ts` (`fromEnvelope`, `deliver`, `waitForQueued`)
- Modify: `src/client/stop-hook.ts` (`main`)
- Modify: `src/mod/` (the wake on a peer event), `mod/types/` if the door's event shape gains `to`
- Test: `tests/stop-hook.test.ts`, `tests/bridge-*.test.ts` (whichever covers `deliver` and `bellman_wait`), `tests/inbox.test.ts`

**Interfaces:**
- Consumes: the wire `from.name` and `to` (Task 4).
- Produces: `PeerEvent.from_name?: string` and `PeerEvent.to?: { member_id: string; name: string }[]`.
- Produces: `wakes(e: PeerEvent): boolean`, false only when `to` is set and does not hold `e.member_id`.
- Produces: `drainWaking(dir: string): PeerEvent[]`. It claims the whole queue only when at least one queued event `wakes`; otherwise it returns `[]` and leaves every file in place.

- [ ] **Step 1: Write failing tests**
  - `deliver` in channel mode sends no notification for an event addressed to another seat. For an addressee, `meta.from_name` and `meta.to` (the names joined with `,`) are set.
  - `renderEvent`'s first line names the sender's seat. An addressed event adds a line naming the addressees, marking `(you)`.
  - Stop hook: a queue holding only addressed-away events exits 0 (or reaches the capture prompt) and leaves the files queued. A queue with one waking event exits 2 and renders every event, the addressed-away ones included.
  - `bellman_wait` keeps waiting past addressed-away events and returns all of them with the next waking one.
  - The mod: where `src/mod/` starts a turn for a peer event (the wake, `WAKE_LIMIT`), an addressed-away event starts none
    (a test in `mod/tests/` or `tests/mod-*.test.ts`, whichever covers the wake today).
  - An unaddressed ambient event behaves exactly as today on each path.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Carry `from.name` and `to` through `WireEnvelope`, `fromEnvelope` and `roomEventFromFrame`.
  - `deliver` returns early on `!wakes(event)` as it does on `ambient`.
  - The Stop hook and `waitForQueued` use `drainWaking` instead of `drain`.
  - The mod's wake gates on `wakes` (or the same rule over the door's event shape, which `mod/types/` repeats by hand).
- [ ] **Step 4: Run** `npm test`. Expected: PASS. Do not run `build:plugin` (the release PR does).
- [ ] **Step 5: Commit.** `jj commit -m "Bridge, Stop hook and bellman_wait wake only for events addressed to their seat"`

### Task 8: Tool text, budget, docs and ADR

**Files:**
- Modify: `src/tools/send.ts`, `src/tools/sync.ts`, `src/tools/confirm.ts`, `src/tools/start.ts`, `src/tools/rooms.ts` (descriptions)
- Modify: `docs/ARCHITECTURE.md` (§11 budget table and tool-definitions row; §7 trust boundaries: addressed is not private)
- Create: `docs/adr/0048-seat-names-and-addressed-messages.md`
- Modify: `GLOSSARY.md` (Seat name, Addressed message)
- Modify: the `EGM.md` of each changed directory (`src/room`, `src/storage`, `src/tools`, `src/client`, `src/workerd`, and root `src/` for `projections.ts` and `public-event.ts`)
- Generated: `docs-site/src/content/docs/reference/tools/`, `reference/bridge-tools.md`

- [ ] **Step 1: Write the descriptions.**
  - `bellman_send`'s `to`: "seat names (up to 20); wakes only those seats; every member can still read it; message and artifact only."
  - Add `name` to each return's field list, and `to` and `from.name` to `bellman_sync`'s.
- [ ] **Step 2: Measure** with `npx vitest run tests/tool-budget.test.ts`. Expected: FAIL, naming the new total. If the total is over 11,840, cut wording in the descriptions until it fits, with no tool's contract lost.
- [ ] **Step 3: Update §11.** Set the tool-definitions row to the new total, and add a row: `| Seat names: \`to\`, \`name\` | +N | <total> | ADR 0048 |`. Rerun the budget test. Expected: PASS.
- [ ] **Step 4: Write ADR 0048.** It records: the name is `<role>-<seq>` and derived; addressed means not private; `toMemberIds` on events; per-reader `ambient` for addressed events only; the reader-aware long poll. Number it against origin/main and every open PR when the PR opens.
- [ ] **Step 5: Update the glossary and the EGMs, then run `npm run docs:gen`.**
- [ ] **Step 6: Run** `npm run verify`. Expected: exit 0.
- [ ] **Step 7: Commit.** `jj commit -m "Seat names: tool text, budget, ADR 0048, docs"`
