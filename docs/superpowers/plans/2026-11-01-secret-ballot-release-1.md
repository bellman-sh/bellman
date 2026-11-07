# Secret Ballot, Release 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every read, write and erase path a secret ballot needs, in both stores, while the manifest parser still
refuses `ballot: secret`. After this release no room can declare a secret ballot, but every secret decision a
stored manifest could open is stored, tallied, shown and erased as the spec says.

**Architecture:** A secret vote is written to the log with the system author and no choice. Each voting account's
choice goes into one ballot row (`bv:<decision>:<account>`, a map in MemoryStore). The store merges those rows into
every fold as `view.book` and deletes `view.book` before returning any view. Every close path deletes the rows, and
the idempotency records they list, last in its transaction. Reads that need "has my account voted" ask the store
through `votedOn`, and the tools and routes pass the answer to `decisionShown`.

**Tech Stack:** TypeScript, Cloudflare Workers and Durable Objects, vitest (Node), vitest-pool-workers (workerd),
zod.

**Spec:** `docs/superpowers/specs/2026-11-01-secret-ballot-design.md`, Change 2 (plan items 8-30, with the sections
they cite: "Data model", "Close paths", "Write path", "Count and evaluate under a secret ballot", "Reads", "Tools,
manifest and consent", "Logging rule"). The spec gives each signature. This plan cites the spec's item numbers and
adds the tests, the order and the rulings below.

## Global Constraints

- Every `BellmanStore` method stays async. `MemoryStore` internals stay synchronous. `housekeep` has no awaits.
- Read and register in the same turn (CLAUDE.md): no await between reading events and registering a waiter.
- A new `SessionDO` method is `#private`, unless it is a `BellmanStore` method that `DurableObjectStore` forwards to.
- Peer content stays untrusted everywhere. This release weakens nothing a reader sees today; it only removes data.
- **No log line or error message carries a `DecisionVote` payload or a ballot row.** Errors in vote and erase paths
  name only the room id and the decision cursor.
- **Open ballots are unchanged.** A rule with no `ballot` (or `ballot: "open"`) keeps today's draft-rule shape, a
  string or `{ rule, quorum }`, so no existing decision hash changes. Its votes keep their author and choice.
- The tool listing must stay under §11's ceiling (11,840 tokens). `tests/tool-budget.test.ts` now enforces §11's
  rows on every `npm test`.
- `npm run docs:gen` after any tool description or schema change; never edit the generated pages by hand.
- `npm run verify` passes before every commit, with one exception: Task 3's commit leaves the workerd copy of its
  new contract cases red until Task 4 (its `roomRows` placeholder throws). Task 3 runs the Node suites only. Commits are signed (ssh); never bypass signing. The repo is a plain
  git worktree here.
- Docs never describe a room as two sessions; say members.

## Rulings made while planning

- **R1: release 1 tool tests set the ballot mode on the stored manifest.** The parser refuses `ballot: secret` in
  this release, so a tool test sets it after `pairUp` by writing
  `manifest.decide.rules.surface_proposal.ballot = "secret"` on MemoryStore's stored session, through a cast (the
  pattern `tests/store.test.ts` uses for private maps). A shared helper `secretBallot(store, sessionId)` lives in
  `tests/helpers/flows.ts`. Store-level tests open secret decisions directly, with a draft rule
  `{ rule: "majority", ballot: "secret" }`.
- **R2: the ballot row is keyed by account (`userId`) and stores no seats.** The voted set at close is computed from
  the snapshot's `accounts`: every electorate seat whose account has a row.
- **R3: the cap counts per account under a secret ballot.** `n` is the account's vote count from its row, and
  `applyVote` refuses at `n > MAX_REVISIONS`, the same comparison it makes today per seat.
- **R4: Change 1's deferred `src/EGM.md` line lands here.** PR #507 merged, so Task 8 adds `decision` to the
  `SessionDO` alarm handler list, together with this release's `bv:` prefix and `votedOn`.

## Review Focus

1. **One account holding two seats.** It votes from seat A and revises from seat B. Expected: one ballot row, a
   tally of one, one shared cap, and both seats in `voted` at close. Pinned in Task 3.
2. **A room holding one secret and one open decision at once.** Reads, `votedOn` and the outstanding list must
   treat each by its own mode. Pinned in Task 6.
3. **A key first used on another decision, sent with a vote on a secret one.** Expected: `conflict`, never
   `recorded`. Pinned in Task 3.
4. **A removal that settles a secret decision** (for example, quorum can no longer be met). It must erase like any
   other close. Pinned in Task 3 (close path 5).
5. **Open ballots are untouched.** An open-ballot vote still stores its author and choice. Its tally, audit row and
   reads are byte-for-byte what they were. Pinned in Tasks 2 and 3 by keeping every existing test green, plus one
   explicit regression case each.

---

### Task 1: The ballot mode in the manifest, the rule and the draft

**Files:**
- Modify: `src/types.ts` (`DecideConfig`), `src/manifest.ts` (`RuleShape`, `resolveDecide`), `src/tools/decide.ts`
  (the draft rule `open` builds)
- Test: `tests/decide-manifest.test.ts`, `tests/tools/decide.test.ts`

**Interfaces:**
- Produces: `DecideConfig.rules[kind].ballot?: "open" | "secret"`. `resolveDecide` refuses `secret` in this release
  with the message `decide.<kind>.ballot: secret ballots are not enabled yet; omit it`, and accepts `open`.
- Produces: for a stored manifest whose kind has `ballot: "secret"`, `bellman_decide open` writes the draft rule
  `{ rule, quorum?, ballot: "secret" }`. For every other kind it writes the rule exactly as today.

- [ ] **Step 1: Write the failing tests.**
  - `tests/decide-manifest.test.ts`, `it("refuses ballot: secret in release 1, naming the field, and accepts ballot: open")`:
    - a manifest with `decide: { surface_proposal: { rule: "majority", ballot: "secret" } }` throws a
      `ManifestError` whose message contains `decide.surface_proposal.ballot`
    - `{ rule: "majority", ballot: "open" }` resolves, with `ballot: "open"` on the rule
  - `tests/tools/decide.test.ts`, `it("opens a decision on a secret kind with ballot in its rule, and an open kind as before")`:
    - after `secretBallot(store, p.sessionId)` (R1), the `decision_opened` payload's `rule` is
      `{ rule: "majority", ballot: "secret" }`
    - in a fresh room without it, the rule is the string `"majority"`, and the `hashOf()` helper still matches the
      opened hash
- [ ] **Step 2: Run them to verify they fail.**
  Run: `npx vitest run tests/decide-manifest.test.ts tests/tools/decide.test.ts -t "ballot"`
  Expected: FAIL. The strict `RuleShape` rejects the unknown key `ballot`, and `secretBallot` is not defined.
- [ ] **Step 3: Implement.**
  - `RuleShape`'s object form takes `ballot: z.string().max(8).nullish()`. A string, not an enum: the comment above
    `RuleShape` gives the reason.
  - `resolveDecide` checks the value against `open | secret` (any other value is refused, naming the valid set),
    refuses `secret` with the message above, and carries `ballot` onto the resolved rule.
  - `decide.ts` builds the draft rule from it, with this shape:
    - `ballot === "secret"`: `{ rule, ...(quorum ? { quorum } : {}), ballot: "secret" }`
    - otherwise: today's expression, unchanged
  - Add `secretBallot` to `tests/helpers/flows.ts`.
- [ ] **Step 4: Run them to verify they pass.**
  Run: `npx vitest run tests/decide-manifest.test.ts tests/tools/decide.test.ts`
  Expected: PASS.
- [ ] **Step 5: Commit:** `Secret ballot release 1: ballot in the decide rule, refused by the parser, carried into the draft rule`

### Task 2: Pure decision logic for a secret ballot

**Files:**
- Modify: `src/decision.ts` (spec item 10)
- Test: `tests/decision.test.ts` (spec item 19)

**Interfaces:**
- Consumes: `auditRows`, `SYSTEM_ACTOR` (`src/audit.ts`, runtime-free).
- Produces, as spec item 10 states them:
  - `isSecret(p: DecisionOpened): boolean`
  - `SecretVote`, with `Ballot.vote` widened to `DecisionVote | SecretVote`
  - `BallotBook = ReadonlyMap<number, ReadonlyMap<string, Choice>>`, and `DecisionView.book?: ReadonlyMap<string, Choice>`
  - `decisionsOf(events, now, ballots?: BallotBook | "untallied")`
  - `applyVote(view, voter, vote, n?)`, plus a new `VoteDecision` kind, `{ kind: "advisory_secret" }`
  - `removalEvents` for a secret decision
  - `closingEvent` writing `voted` on a secret decision
  - `decisionAudit(template, events, views, secretParties: (string | null)[] = [])`
  - `decisionsAwaiting(events, memberId, now, perOpener, secretVoted: ReadonlySet<number> = new Set())`
  - `decisionStates`, folding `"untallied"`
- New parameters are optional or defaulted, so every existing caller compiles unchanged.

- [ ] **Step 1: Write the failing tests** in `tests/decision.test.ts`.
  - **Fixtures:** a `secretOpened(cursor)` built like the existing `opened()` but with
    `rule: { rule: "majority", ballot: "secret" }`, and a `secretVote(decision)` with the system author and no
    choice.
  - **Cases**, one `it` each:
    - `isSecret` is true only for `ballot: "secret"`.
    - `decisionsOf` on an open secret decision:
      - with no ballot book, it throws, and the message names the decision cursor
      - with `"untallied"`, it gives a zero tally
      - with a ballot book `{ u_a: "approve", u_b: "reject" }`, it gives approve 1, reject 1, turnout 2, and
        `view.book` equal to that map
    - A removed seat whose account has a ballot-book entry stays counted (approve 1). `evaluate` passes a majority
      only when it would pass with that account's vote counted once, and does not add it to the assumed
      rejections again.
    - `applyVote` on a secret decision:
      - `capacity: "advisory"` gives `{ kind: "advisory_secret" }`
      - `n = 6` gives `{ kind: "quota", limit: 5 }`, and `n = 5` gives `record`
      - the close it computes uses the new choice in place of the account's old one: a reject that flips a passing
        majority leaves it open, not passed
    - `removalEvents` on a secret decision writes `voided: []` and `ballot: "secret"`.
    - `closingEvent` on a secret decision writes `voted` in electorate order. An account that holds seats
      `m_a` and `m_c` and has voted lists both.
    - `decisionAudit` on a secret `decision_closed`:
      - one row per party in `secretParties`
      - each row has `actorUserId: "system"`, `actorLabel: null`, `actorOrgId: null` and `direction: null`
      - the detail has `tally` and `voted`, and no `votes` key
      - a secret `decision_opened` row keeps the template's actor
    - `decisionsAwaiting` lists a secret decision until its cursor is in `secretVoted`.
    - `decisionStates` on an open secret decision gives `open` without throwing.
    - **Regression (Review Focus 5):** an open-ballot decision through every function above gives the same result
      as before. Assert one open-ballot audit row deep-equal to a literal copied from the current output.
- [ ] **Step 2: Run them to verify they fail.**
  Run: `npx vitest run tests/decision.test.ts`
  Expected: FAIL on missing exports (`isSecret` is not a function) and on the secret cases.
- [ ] **Step 3: Implement spec item 10 in `src/decision.ts`.**
  - **`count()` for a secret decision:**
    - read one choice per snapshot account from `view.book`
    - removed seats' accounts are included
    - `unreachable` is unchanged
    - `pending` is the reachable accounts with no ballot-book entry
    - the pass check in `evaluate` adds `unreachable` accounts **with no ballot-book entry** in place of
      `t.unreachable`
  - **`applyVote` for a secret decision:** build the evaluated view with the voter's account entry in `view.book`
    replaced by the new choice. Do not push a ballot carrying a choice.
  - **The thrown message:** `decision ${cursor} is a secret ballot folded without its ballot book`. No payload.
- [ ] **Step 4: Run them to verify they pass**, together with every existing decision test.
  Run: `npx vitest run tests/decision.test.ts && npm run typecheck`
  Expected: PASS, and the typecheck exits 0.
- [ ] **Step 5: Commit:** `Secret ballot release 1: the fold, count, vote, removal, close and audit rules for a secret decision`

### Task 3: The store contract and MemoryStore

**Files:**
- Modify: `src/store.ts` (`BellmanStore` and `MemoryStore`, spec item 11)
- Modify: `tests/helpers/store-contract.ts` (spec item 22), `tests/store.test.ts` (spec item 24, the Node harness and
  close path 4)
- Modify: `worker-tests/store-contract.test.ts`: add `roomRows` to the harness as
  `async () => { throw new Error("roomRows: Task 4") }`, so the workerd program keeps compiling until Task 4

**Interfaces:**
- Consumes: everything Task 2 produces.
- Produces, on `BellmanStore`:
  - `votedOn(sessionId: string, userId: string, decisions: number[]): Promise<number[]>`
  - `VoteWrite` gains `{ outcome: "recorded" }`
  - `StoreContractHarness.roomRows(sessionId): Promise<[string, unknown][]>` (required)
- Produces, on `MemoryStore`: a private `ballots: Map<sessionId, Map<decision, Map<account, { choice: Choice; n: number; iks: string[] }>>>`.

- [ ] **Step 1: Write the failing contract cases**, in a new `describe("secret ballots (release 1)")` inside the
  decisions `describe`.
  - **Fixtures:** reuse `room`, `draft`, `opening`, `ballot`, `ANN`, `BEN`, `DAN`. Add
    `secretDraft = draft({ rule: { rule: "majority", ballot: "secret" } })`.
  - **One `it` per close path:**
    1.  a vote that settles the rule
    2.  supersession
    3.  an open finding the decision overdue, with `vi.setSystemTime` as the existing expiry test does
    5.  a removal that settles it (Review Focus 4)
    6.  a direct `closeDecision`

    Path 4 is tested in `tests/store.test.ts` and in Task 4. Each case votes with known choices and the keys
    `"k-ann"` and `"k-ben"`, closes, then asserts:
    - the closed tally equals the count of each account's latest choice
    - `voted` lists every seat of each account that voted, in electorate order
    - `roomRows(id)` holds no key starting `bv:<decision>:`, and no key containing `:k-ann` or `:k-ben`
    - no `decision_vote` value in `roomRows` has a `choice` property, or a `fromMemberId` other than `"system"`
    - `auditForOrg("org_codenerd", 50)` holds the closing row with `actorUserId: "system"`, and no `votes`
  - **Retries:**
    - while open, the same key with the same choice gives `{ outcome: "recorded" }`
    - the same key with a different choice also gives `{ outcome: "recorded" }`
    - a key first used on another decision gives `{ outcome: "conflict" }` (Review Focus 3)
    - after close, a retry gives `{ outcome: "closed", state }`
  - **Other cases:**
    - **Two seats, one account (Review Focus 1):** a room where `m_ann` and `m_ann2` share `u_ann`. A vote from
      each gives one ballot-book entry, tally turnout 1, and the seventh vote across the two seats refused
      `{ outcome: "quota", limit: 5 }`. Six votes land, as for one seat today.
    - **Removed voter:** stays in the closed tally.
    - **`votedOn`:** answers only for the given account, and only for secret decisions.
    - **Live tally (G3):** `decision(id, cursor, now)` while open equals the tally `decision_closed` later carries,
      and the returned view has no `book` property.
    - **Regression (Review Focus 5):** an open-ballot vote is stored with its author and choice, exactly as today.
- [ ] **Step 2: Implement the Node harness's `roomRows`** in `tests/store.test.ts`. It reads MemoryStore's
  `sessions`, `ballots` and `keys` through a cast, and names its entries:
  - `e:<cursor>` for each event, with the event as the value
  - `bv:<decision>:<account>` for each ballot row
  - `ik:<member>:<key>` for each idempotency record, exactly as `idempotencyKey` builds it
- [ ] **Step 3: Run them to verify they fail.**
  Run: `npx vitest run tests/store.test.ts -t "secret ballots"`
  Expected: FAIL. `votedOn` is not a function, and the secret vote is stored with its choice.
- [ ] **Step 4: Implement spec item 11 in `MemoryStore`**, in this order:
  1.  **`decisionKey`** returns its storage key.
  2.  **`castVote`:**
      - read the opening event (`s.events` at `input.decision`) before the key check
      - on a secret decision, a found record whose print names this decision answers `recorded`, and one that
          names another answers `conflict`
      - append the system-authored secret event, update the ballot row, and call `k.remember`, **before**
          `decisionWrites` writes any close (spec, Write path, step 6)
  3.  **Folds:** every `decisionsOf` call passes `this.book(s)`, where `book` is a private helper building the
      `BallotBook` from the map.
  4.  **`decisionWrites`:**
      - gets the ballot books
      - passes `rosterParties(s)` as `secretParties` to `decisionAudit`
      - runs `eraseClosed`, a private method, last: it deletes each closed secret decision's ballot rows and the
          `keys` entries their `iks` name
  5.  **The removal path** (the `removalEvents` call in the departure write) appends its events through
      `decisionWrites`. Remove its own `decisionAudit` line, so no row is written twice.
  6.  **`decision` and `decisions`** delete `view.book` before returning. Add **`votedOn`**.
  7.  **`housekeep`** passes the ballot books when it closes an overdue decision (Change 1's loop).
- [ ] **Step 5: Run to verify they pass** (Node only; the workerd copy waits for Task 4).
  Run: `npx vitest run tests/store.test.ts tests/decision.test.ts && npm run typecheck`
  Expected: PASS, and the typecheck exits 0.
- [ ] **Step 6: Commit:** `Secret ballot release 1: MemoryStore keeps choices in ballot rows, erases them on every close, answers votedOn`

### Task 4: SessionDO

**Files:**
- Modify: `src/store-do.ts` (`SessionDO` and `DurableObjectStore`, spec item 12)
- Modify: `worker-tests/store-contract.test.ts` (spec item 23, the real `roomRows`)
- Create: `worker-tests/secret-ballot.test.ts` (spec item 26)

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces:
  - `ballotKey(decision, account)` = `bv:<decision>:<account>` and `ballotPrefix(decision)`, both module-private
  - `SessionDO.votedOn` and `DurableObjectStore.votedOn`

- [ ] **Step 1: Write the failing tests.**
  - Replace the Task 3 placeholder in `worker-tests/store-contract.test.ts` with a real `roomRows`:
    `runInDurableObject(stub, async (_i, ctx) => [...(await ctx.storage.list()).entries()])` for the room named by
    `sessionId`. The contract cases from Task 3 now run in workerd.
  - In `worker-tests/secret-ballot.test.ts`, with fixtures copied from `worker-tests/decision-deadline.test.ts`
    (own room ids, no `abortAllDurableObjects`):
    - `it("a secret vote reaches a room socket with the system author and no choice")`: open a socket as
      `worker-tests/decision-pages.test.ts` does, cast a secret vote, and the frame's `from.member_id` is `"system"`
      with no `choice` in its payload. The same holds for the replay on reconnect.
    - `it("the deadline alarm erases an expired secret decision's ballot rows and keys")`: vote with key `"k-1"`,
      `backdate`, `fire`. Storage then holds no `bv:` key and no key ending `:k-1`.
- [ ] **Step 2: Run them to verify they fail.**
  Run: `npm run test:worker`
  Expected: FAIL in `store-contract.test.ts` (the secret cases) and in `secret-ballot.test.ts`.
- [ ] **Step 3: Implement spec item 12.**
  - **`castVote`:**
    - read `eventKey(input.decision)` before `#decisionKey`
    - read `ballotPrefix` together with the log
    - put the ballot row through `#writeDecision`'s `record` argument, beside the idempotency record
  - **`#writeDecision`:**
    - takes the ballot books
    - passes `rosterParties({ members: await this.#everyone(txn) })` as `secretParties`
    - calls `#eraseClosed(txn, events)` **after** its `putRows`
  - **The departure transaction:** reads the ballot books of the decisions it recounts, and calls `#eraseClosed`
    after its put.
  - **Folds and reads:**
    - `openDecision`, `closeDecision` and `#expireDecisionsIfDue`'s path fold with ballot books
    - `decision()` and `decisions()` read the books of the open secret decisions they return, then delete
      `view.book`
  - **`#rebook`** (Change 1) folds with `"untallied"`.
  - **`votedOn`:** one `get` of `ballotKey` per named decision.
  - **The log line** (spec, item 12, "Logging"): after a secret close commits, one `console.log`. Room id,
    decision cursor, tally and counts only.
- [ ] **Step 4: Run them to verify they pass.**
  Run: `npm run test:worker && npm run typecheck:worker`
  Expected: PASS, and the typecheck exits 0.
- [ ] **Step 5: Commit:** `Secret ballot release 1: SessionDO keeps choices in bv: rows and deletes them, and their keys, after every close`

### Task 5: Projections: `decisionShown` and the consent preview

**Files:**
- Modify: `src/projections.ts` (spec item 13)
- Test: `tests/http-decisions.test.ts` (spec item 20), `tests/decide-manifest.test.ts` (spec item 21)

**Interfaces:**
- Produces:
  - `decisionShown(v, members, full, reader: string | null = null, voted: boolean | null = null)`, defaulted so the
    current callers compile until Task 6
  - `SECRET_BALLOT_PROMISE: string`, exported from `src/projections.ts`. Its text is the spec's P1 to P3 and L1 to
    L7, word for word, joined with newlines.

- [ ] **Step 1: Write the failing tests.**
  - **`tests/http-decisions.test.ts`:**
    - `decisionShown` on a secret open view returns `votes: []` and `advisory_votes: []`.
    - `voted` appears only on the electorate rows whose account is `reader`, equal to the `voted` argument.
    - On a closed view, every row's `voted` matches the closing payload's `voted` list.
    - An open-ballot view is unchanged: deep-equal to the current output for the same input.
  - **`tests/decide-manifest.test.ts`:** the consent preview's `decide.rules.surface_proposal`:
    - holds `ballot: "open"` for a plain rule
    - for a stored manifest whose rule carries `ballot: "secret"`, holds `ballot: "secret"` and `ballot_promise`
      equal to `SECRET_BALLOT_PROMISE`
- [ ] **Step 2: Run them to verify they fail.**
  Run: `npx vitest run tests/http-decisions.test.ts tests/decide-manifest.test.ts`
  Expected: FAIL. The views still carry their vote lists and the preview has no `ballot` field.
- [ ] **Step 3: Implement spec item 13.** `decisionMembers` leaves out ballots whose author is `"system"`.
- [ ] **Step 4: Run them to verify they pass.**
  Run: `npx vitest run tests/http-decisions.test.ts tests/decide-manifest.test.ts tests/projections.test.ts`
  Expected: PASS. `projections.test.ts` is the import-graph test, and must stay green.
- [ ] **Step 5: Commit:** `Secret ballot release 1: decisionShown hides votes and other accounts' voted flags; the preview names the ballot and its promise`

### Task 6: Tools and routes

**Files:**
- Modify: `src/tools/decide.ts` (spec item 14), `src/tools/send.ts` (item 15), `src/tools/sync.ts` (item 16),
  `src/http/rooms.ts` (item 17)
- Test: `tests/tools/decide.test.ts` (item 25), `tests/http-decisions.test.ts` (item 20, the `ETag` case)

**Interfaces:**
- Consumes: `votedOn` (Task 3), `decisionShown(…, reader, voted)` (Task 5).
- Produces: `voteOn(s, sessionId, session, me, identity, vote, key, reasonField: "reason" | "result" = "reason")`.

- [ ] **Step 1: Write the failing tests** in `tests/tools/decide.test.ts`, in a secret room (R1). One `it` each:
  - **Refusals:**
    - a vote with `human_approved: false` is refused, and the error contains `Advisory votes are not taken in a secret ballot`
    - a vote with `reason` is refused with `A secret ballot stores no reason. Vote again without one.`
    - an `action_response` to the decision through `bellman_send`, with a `result`, is refused, and the message
      names `result`
    - a refused vote does not consume the send limit: a following valid vote succeeds even when the room's limit is 1
  - **Results:**
    - the vote result equals `{ ballot: "secret", capacity: "binding", state: "open" }`, with no `cursor` key
    - a retry with the same key equals `{ ballot: "secret", recorded: true, note: "Recorded under this key. To change your vote, vote again with a new key." }`
  - **Reads:**
    - the `read` list shows a live tally for the open secret decision
    - the list includes a closed decision older than the window (Review Focus 2: in the same room, open one
      open-ballot decision too, and assert its `votes` list is still shown)
    - `read` shows `voted: true` only on the caller's own rows after they vote
  - **`open`:** in the two-account room, the result carries the small-electorate warning, `This secret ballot has 2 accounts; with this few, or under unanimous, the result can reveal how individuals voted.`
  - **Sync:** `bellman_sync`'s outstanding list drops the secret decision for the joiner after the joiner votes,
    and keeps it for the creator.
  - **Route** (`tests/http-decisions.test.ts`): `GET /rooms/:id/decisions` for two members, one who has voted and
    one who has not, returns different `ETag`s.
- [ ] **Step 2: Run them to verify they fail.**
  Run: `npx vitest run tests/tools/decide.test.ts tests/http-decisions.test.ts`
  Expected: FAIL on each case above.
- [ ] **Step 3: Implement spec items 14 to 17**, including the description sentences (spec, "Tools, manifest and
  consent"). Then:
  - run `npm run docs:gen`
  - update ARCHITECTURE §11: set the tool-definitions figure, and add a budget row for this change with the delta
    that `npx vitest run tests/tool-budget.test.ts` reports
- [ ] **Step 4: Run them to verify they pass.**
  Run: `npx vitest run tests/tools tests/http-decisions.test.ts tests/docs-reference.test.ts tests/extension.test.ts`
  Then run `npx vitest run tests/tool-budget.test.ts`.
  Expected: PASS for both, with the total under 11,840.
- [ ] **Step 5: Commit:** `Secret ballot release 1: bellman_decide, bellman_send, bellman_sync and the decisions route read and refuse a secret ballot`
  (include the regenerated `docs-site/src/content/docs/reference/` pages and `docs/ARCHITECTURE.md`).

### Task 7: The leak test across every exit

**Files:**
- Create: `tests/secret-ballot-leak.test.ts` (spec item 27)

- [ ] **Step 1: Write the test.**
  - **Setup:**
    - `pairUp` with `mode: "swarm"`, then `secretBallot` (R1)
    - a third member: a peer from `h.connect(...)` joined with `joinWith` and a code from `bellman_invite`, as
      `tests/tools/approvals.test.ts` does
    - an open secret decision; the creator and the joiner vote, approve and reject
  - **Exits:** read each one below, as the third member (who has not voted), as the joiner (who has), and, for the
    public route, as a public-link reader:
    - `bellman_sync`
    - `bellman_surface`
    - `bellman_decide` read, plus the vote and retry results
    - `GET /rooms/:id/events`
    - `GET /rooms/:id/decisions`
    - the public events route, with the room made public as `publicRoom` does
    - `liveRooms`
    - the hosted seat's model input, captured by a `MemoryHost` built with a `fetch` option that records request
      bodies (`src/host-memory.ts`)
    - `auditForOrg`
  - **Asserts:** walk each result's JSON:
    - no `choice` key appears anywhere for the decision
    - no `decision_vote` names the creator's or the joiner's member id, label or user id
    - no vote result has a `cursor`
    - no `voted` field appears for another account while the decision is open
    - the closing audit row's `actorUserId` is `"system"`

    Run every assertion once while open, then once after a `closeDecision` with `expired`.
- [ ] **Step 2: Run it.**
  Run: `npx vitest run tests/secret-ballot-leak.test.ts`
  Expected: PASS.
- [ ] **Step 3: Positive controls.** In a scratch copy of the worktree (rsync it; never in this checkout), make
  each change below alone and confirm that this test or a Task 3 contract case goes red:
  - the vote written with the voter as author
  - `choice` left on the event
  - `eraseClosed` skipped on the removal path
  - the erase run before the put
  - the idempotency delete skipped
  - the cursor returned in the vote result
  - the secret closing audit row built from the template

  Record each result in the ledger.
- [ ] **Step 4: Commit:** `Secret ballot release 1: one test reads every exit for a choice or a voter, open and closed`

### Task 8: ADR, architecture and directory contracts

**Files:**
- Modify: `docs/adr/0040-room-consensus.md` (spec item 28), `docs/ARCHITECTURE.md` (spec item 29, the consensus paragraph),
  `src/EGM.md` and `src/tools/EGM.md` (spec item 18, and R4)

- [ ] **Step 1: ADR 0040.**
  - Add decisions 23 to 28 to the 2026-11-01 amendment, worded as spec item 28 gives them.
  - Edit decision 21's sentence.
  - Add a line to the revision note.
- [ ] **Step 2: ARCHITECTURE.** In the consensus section, one paragraph on secret ballots, the ballot rows and the
  six close paths. (The §11 row landed in Task 6.)
- [ ] **Step 3: Directory contracts.**
  - **`src/EGM.md`:**
    - add `decision` to `SessionDO`'s alarm handlers (R4)
    - add `bv:` to its storage prefixes
    - add `votedOn` to the decisions method family
  - **`src/tools/EGM.md`:** add the secret vote result shapes beside today's `{ cursor, ... }`.
- [ ] **Step 4: Verify.** Run `npm run verify`, expecting exit code 0. Then run
  `npx wrangler deploy --dry-run`, expecting it to build with no binding errors.
- [ ] **Step 5: Commit:** `Secret ballot release 1: ADR 0040 decisions 23 to 28, the architecture and directory contracts`

## After the last task

The PR targets main. Its body states:

- no room can declare a secret ballot until release 2
- release 2 waits for the trace check, which deploys a temporary Worker and needs the owner's go-ahead
