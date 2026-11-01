# Secret ballot for room decisions (#469)

*   **Author:** mcfearsome
*   **Status:** Proposed (Stage 9 re-audit fixes applied 2026-11-01)
*   **Date:** 2026-11-01

--------------------------------------------------------------------------------

## Overview

A room's manifest can mark a decision kind `ballot: secret`. Under a secret ballot, nobody in the room learns how
another seat voted, and while the decision is open nobody learns which seats have voted. The live count of
approvals, rejections and abstentions stays readable throughout. When the decision closes, the set of seats that
voted becomes readable, and the server deletes its only record of who chose what. From then on, the stored tally
is the only record of the result.

This builds on room consensus ([ADR 0040](../../adr/0040-room-consensus.md), epic #401), where a decision is
opened, voted on by a fixed electorate, and closed by a rule. Today every vote is a `decision_vote` event that
every member receives with its seat, choice and reason.

**The solution in one paragraph.** A secret vote is written to the room's log with the server as its author and
no choice, so neither a reader nor anyone holding storage can tell which seat cast it or how. The choice is kept
in one row per account that only the tally reads, and every way a decision can close deletes those rows in the
same transaction. The audit records the tally and the set of seats that voted, never a choice and never the
deciding voter. A deadline alarm makes sure every decision closes, and so is erased, even in a quiet, frozen or
closed room.

## Glossary

*   **Seat:** one member's place in a room (`member_id`). A person can hold several seats.
*   **Account:** the signed-in identity behind a seat (`user_id`). One account counts once in a decision, however
    many seats it holds.
*   **Electorate snapshot:** the seats that may vote, and each seat's account, fixed when the decision opens.
*   **Binding vote:** a vote the agent says its human decided (`human_approved: true`). Only binding votes count.
*   **Advisory vote:** an agent's own opinion (`human_approved: false`), shown but never counted. Refused under a
    secret ballot.
*   **Revision:** a later vote by the same voter, which replaces the earlier one. Today the cap is six votes per
    seat (`MAX_REVISIONS` = 5 revisions after the first).
*   **Unreachable account:** an account all of whose snapshot seats have left or been evicted.
*   **The `openDecisions` book:** a list in the room's stored record of every decision not yet closed, with its
    deadline. Rooms whose decisions opened before #407 do not have it.
*   **Ballot book:** one secret decision's ballot rows: each voting account mapped to its current choice. Never the
    same thing as the `openDecisions` book.
*   **Idempotency record (`ik:` row):** what lets a caller retry a write with the same `idempotency_key` and get
    the first result back. It stores a fingerprint ("print") of the request, choice included.
*   **Host seat:** a seat Bellman itself runs with a model, fed the room's events.
*   **Dash session:** voting from the Bellman web dashboard, reserved for a later phase.

## The Problem

Bellman's first civic customer promises its members that they can vote "without fear of reprisal". Bellman cannot
support that promise today:

*   **Every member sees every vote.** A `decision_vote` event reaches every member's log carrying the voter's seat,
    their choice and their free-text reason. The decisions route and `bellman_decide read` list each vote beside
    its seat.
*   **The audit trail records every choice permanently.** The org audit row written when a decision closes lists
    each counted vote with its seat, account and choice (`decisionAudit`, `src/decision.ts`). Audit rows form a hash
    chain shipped to a signed sink (ADR 0035), so nothing written there can ever be removed.
*   **Storage keeps every choice forever.** The vote events, their copies in the decisions index, and the
    idempotency records all hold the choice, with no end date.
*   **Who voted, and when, is visible.** Seeing which seat voted and when lets members pressure those who have not
    voted, and lets anyone who logs the live count match a count change to a seat.

Civic rooms (epic #486) cannot hold their first poll until this is settled.

### What the promise covers

These statements are the canonical list. The consent preview and the docs site use them word for word, numbered as
here, from one constant (`SECRET_BALLOT_PROMISE`). The `bellman_decide` description names the limits in one sentence
and points to the preview, because every connected client pays for description text on every request.

*   **P1.** No member, and no one holding a public room's link, ever sees another seat's choice, or which seat cast
    which vote.
*   **P2.** No voter can read back their own choice. A voter can show a coercer that they voted, never how.
*   **P3.** After close, no Bellman storage holds a choice, except what point-in-time recovery can restore for about
    30 days.

The limits, stated with the promise:

*   **L1.** The operator can read choices while a decision is open, because the server needs them to tally and to
    apply revisions.
*   **L2.** Point-in-time recovery can restore a choice for about 30 days after close.
*   **L3.** A vote relayed by an agent is seen by that agent's model provider and stays in the agent's transcript
    and the client's history. Bellman cannot erase those copies.
*   **L4.** Who voted is revealed at close.
*   **L5.** Unanimous results and small electorates reveal choices. No tally can avoid that.
*   **L6.** A member who knows when someone was active, or who sees a seat's presence change, can match it to a
    change in the live count.
*   **L7.** A removal that closes a decision at once shows that the removed voter had not voted.

## Goals

*   **G1. No reader sees a choice or a voter.** For a secret decision, no read path returns another seat's choice,
    or ties a seat to a vote. Read paths covered: `bellman_sync`, the room socket, `bellman_surface`,
    `bellman_decide` (read, vote and open results), `GET /rooms/:id/events`, `GET /rooms/:id/decisions`, the public
    room page, the host seat's model input, and audit rows. Verified by one test that reads through every one of
    them.
*   **G2. Who voted is hidden while open and readable at close.** While open, the only per-seat fact a reader gets
    is whether their own account has voted. At close, the seats that voted become readable to every member, in
    electorate order, never in vote order.
*   **G3. Live counts.** The tally (approve, reject, abstain, turnout) can be read while open and equals the closed
    tally at close.
*   **G4. Erasure at close.** When a secret decision closes, by any of the six close paths, no row in either store
    holds its choices or a link from a seat to one of its votes. Verified by a contract test that inspects storage
    after each path.
*   **G5. Every decision closes on time.** A decision whose deadline passes is closed `expired`, and erased if
    secret, when the deadline alarm fires: in quiet, frozen and closed rooms alike. Decisions in records from
    before #407 keep today's behaviour.
*   **G6. No receipts.** No read, vote result or retry shows a voter their own choice, or the cursor of their vote.
*   **G7. Manifest refusals.** `ballot: secret` together with `veto` on the same kind is refused, and so is
    `ballot: secret` on a `single` rule. Each refusal names the fix.
*   **G8. Advisory votes and reasons refused.** On a secret decision, a vote with `human_approved: false`, or with a
    reason, is refused with a message that says what to do instead.
*   **G9. Removal does not move the count.** When a seat leaves or is evicted, its account's vote stays counted.
*   **G10. The promise is written where people decide.** The consent preview and the docs site state P1 to P3 and
    L1 to L7 word for word; the `bellman_decide` description points to the preview.

## Non-Goals

*   **Operator blindness while a decision is open.** This needs encrypted ballots, a key held by trustees, and
    per-seat keys (#382). It also conflicts with live counts: the operator knows which seat submitted each ballot,
    so a count change reveals the choice whatever the encryption.
*   **Coercion resistance beyond no receipts and revisions.** A coercer standing beside the voter at the moment of
    voting is out of scope. A coerced voter's way out is to revise after the coercer leaves.
*   **Ballots voters can verify end to end.** Nobody can recount a closed secret decision; the server's stored
    tally is trusted.
*   **Secret ballots in existing rooms.** A manifest is fixed when a room starts (ADR 0040), so existing rooms keep
    open ballots. The customer creates new rooms.
*   **Keeping votes away from the relaying agent's model provider.** Agents may relay their human's vote (L3).
*   **Dash-session-only voting.**
*   **Hiding advisory votes.** They are refused under a secret ballot, not stored and hidden.

## Open Questions

*   **Do Durable Object storage trace spans record the values a write stores?** Workers traces are persisted for
    every request (`wrangler.toml`). If storage spans hold written values, every choice lands in Cloudflare's trace
    store, past close. **Check:** there is no staging environment, so deploy the branch as a separate, temporary
    Worker with the same observability settings and no routes (`npx wrangler deploy --name bellman-trace-check`),
    cast a secret vote through its `workers.dev` URL, and search that Worker's traces in the Cloudflare dashboard
    (Workers, `bellman-trace-check`, Observability) for the choice and the ballot row key. Delete the Worker
    afterwards. **Pass:** no span holds either. **Rule:** release 2 does not ship until this passes. **Fallback:**
    set `[observability.traces] enabled = false` for the whole Worker; tracing cannot be turned off for one Durable
    Object class. The cost is no traces for any Bellman request.

## Critical User Journeys (CUJs)

### CUJ 1: A member votes in a secret decision through their agent

*   **Given**: A civic room whose manifest declares `decide.surface_proposal: { rule: majority, ballot: secret }`.
    A decision is open, and the member's seat is in its electorate.
*   **When**: The member tells their agent to vote reject. The agent calls `bellman_decide` with
    `human_approved: true` and no reason.
*   **Then**: The call returns `ballot: "secret"`, its capacity and the decision's state: no cursor, no choice.
    Every member, the voter included, receives a `decision_vote` event from `bellman` with no choice, and the live
    reject count rises by one. The voter's read of the decision shows that their account has voted, never "reject".

### CUJ 2: A coercer asks a voter to prove their vote

*   **Given**: A voter voted in an open secret decision.
*   **When**: Someone demands that the voter show how they voted.
*   **Then**: Nothing the voter can open shows their choice or which vote event was theirs: not
    `bellman_decide read`, not `bellman_sync`, not the decisions route, not a retry of their vote. The voter can
    revise later, up to the cap, and the count moves with no author attached.

### CUJ 3: A secret decision closes

*   **Given**: An open secret decision with some votes cast.
*   **When**: Any of the six close paths runs (see Close paths).
*   **Then**: In the same transaction, the server records the closed tally and the seats that voted, deletes every
    ballot row and every idempotency record of the decision's votes, and queues an audit row holding the tally and
    those seats, written as the system. Members can now read which seats voted, in electorate order. No row in
    storage holds a choice.

### CUJ 4: A voter is evicted while the decision is open

*   **Given**: An open secret decision in which seat X has voted.
*   **When**: Seat X is evicted.
*   **Then**: The live count does not change. The removal event names the seat and voids nothing. Seat X cannot vote
    again on this decision. Its account's vote counts in the closed tally.

### CUJ 5: A room creator writes a secret-ballot manifest

*   **Given**: A creator writing a manifest for a new civic room.
*   **When**: They declare `ballot: secret` on a kind that a role also vetoes, or on a `single` rule.
*   **Then**: Starting the room is refused, with a message that names the fix. With a valid manifest, a joiner's
    consent preview shows `ballot: secret` and the promise and limits from the canonical list.

## Technical Plan (Architecture)

The design rests on two moves. **A secret vote's choice never enters the room's log**, so the log, its index
copies and every event that leaves the server carry no choice. **A secret vote's author is never stored**: the
event is written with the server as its author, so neither a reader nor anyone holding storage can tie a vote to a
seat. What remains private lives in one row per account that only the store reads, and every close deletes it.

### Data model

**Manifest.** A kind's rule object gains `ballot: "open" | "secret"`, default `open`:

```yaml
decide:
  surface_proposal: { rule: majority, quorum: 50%, ballot: secret }
```

The resolved rule (`DecideConfig`) carries `ballot` as an optional field read as `"open"` when absent, so stored
manifests stay valid. When a decision opens, `src/tools/decide.ts` builds the draft rule. For a secret kind that is
`{ rule, quorum?, ballot: "secret" }`; an open kind keeps today's shape (a string, or `{ rule, quorum }`), so no
existing decision's hash changes. The rule is part of `decisionHash`, so every vote is bound to the ballot mode.
One helper, `isSecret(payload)`, reads it from `decision_opened`. Absent means open, so every decision opened
before this ships stays an open ballot.

**A secret vote event** (`decision_vote`):

| Field | Open ballot (today) | Secret ballot |
| --- | --- | --- |
| `decision`, `hash`, `via`, `capacity`, `human_approved` | stored | stored (`capacity` is always `binding`) |
| `choice` | stored | absent |
| `reason` | stored | refused at the tool |
| `response_cursor` | stored when set | absent |
| `ballot` | absent | `"secret"` |
| author (`fromMemberId`, `fromUserId`, `fromLabel`) | the voter | the system: `system`, `system`, `bellman` |

The system author is the one every server-written event already uses, so rendering, channel metadata and
attention rules need no new case. Because the author is not a member, the books `#writeDecision` folds (each
member's `lastSentAt`, housekeeping findings) see no send from the voter, and `bellman_sync`, which leaves out the
caller's own events, delivers the vote to the voter like everyone else.

**Ballot rows.** One row per voting account: `bv:<decision>:<account>` → `{ choice, n, iks }`.

*   `choice` is the account's latest vote. A revision overwrites the row, so revised-away choices are never kept.
*   `n` counts the account's votes; the cap becomes six votes per account (today it is per seat).
*   `iks` lists the idempotency record keys of the account's votes on this decision, so close can delete them.

A secret ballot has no advisory votes and no voiding, so the row is exactly the account's counted vote. At most
5,000 rows per decision (the seat ceiling). MemoryStore keeps the same data in a map.

**Removal.** A secret decision's `decision_voter_removed` is written with `voided: []` and `ballot: "secret"`. The
removed seat still goes into `removed`, so it cannot vote again.

**Closing event.** A secret decision's `decision_closed` payload gains `voted`: every electorate seat whose
account has a ballot row (every seat of such an account), in electorate order. It is written in the closing
transaction, before the ballot rows are deleted.

**Closing audit row.** For a secret decision, the detail is `{ decision, kind, hash, state, reason?, tally, voted }`.
No per-vote rows, no cursors, no choices. The rows are built fresh with
`auditRows(rosterParties(session), facts, SYSTEM_ACTOR)`, never from the caller's template: the template carries the
actor of whatever call closed the decision, so a vote that settles it would put the deciding voter in
`actorUserId`, `actorLabel` and `actorOrgId`, and a `direction` derived from the voter's org. Built this way, each
row has `actorUserId: "system"`, `actorLabel: null`, `actorOrgId: null`, and lands in each roster org's stream
(`orgId`). `decision_opened` and `decision_voter_removed` rows keep their real actor: neither is secret.

### Close paths

A decision closes in exactly these six ways. G4, CUJ 3 and the store contract all use this list.

1.  **A vote settles the rule.** `castVote` writes the vote and the close together.
2.  **Supersession.** `openDecision` opens a replacement and closes the old decision `failed: superseded`.
3.  **Overdue decisions found by an open.** `openDecision` closes every decision past its deadline (`dueToExpire`).
4.  **The deadline alarm.** `SessionDO`'s `DECISION_HANDLER` (Node: the `housekeep` sweep) calls `closeDecision`
    with `expired`.
5.  **A removal settles it.** The departure transaction writes `decision_voter_removed`, and its recount closes
    the decision.
6.  **A direct `closeDecision` call.**

Every path runs one shared erase step, `eraseClosed`, inside its transaction.

### Write path

```text
 bellman_decide vote / action_response answering a decision
            │  voteOn: on a secret decision, refuse a reason (or result) and human_approved:false
            ▼
 castVote (one transaction)
   1. read the decision's opening event (is it secret?)
   2. idempotency check  ik:<member>:<key>   (full print, as today)
        secret decision, record names this decision: return "recorded", choice matching or not
        record names another decision: "conflict", as today
   3. read the log since decision.cursor, and the ballot book bv:<decision>:*
   4. fold with the ballot book → applyVote → record | refusal
   5. #writeDecision puts, in one batch:
        e:<cursor>                 decision_vote: system author, no choice, ballot:"secret"
        bv:<decision>:<account>    { choice, n+1, iks + this key }   (through its record argument)
        ik:<member>:<key>          (when a key was given)
        e:<cursor+1>               the closing event with voted, if the vote closes it
   6. then, last: eraseClosed() deletes bv:<decision>:* and every ik they list
```

*   **Idempotency.** `castVote` reads the decision's opening event before the idempotency check, in both stores.
    On a secret decision, a found record whose print names this decision gives one outcome, `recorded`, whether the
    retry matches the stored print or reuses the key with a different choice. A record naming another decision gives
    `conflict`, as today. Both tools reach the same `castVote`, so `bellman_send` answers the same way. The tool answers "Recorded under this key. To change
    your vote, vote again with a new key." It carries no cursor, so a retry cannot reveal the stored choice or the
    vote's place in the log. The idempotency record keeps its full print while open (L1); close deletes it, so a
    retry after close is refused `closed`.
*   **Folding.** `decisionsOf(events, now, ballots)` takes the ballot books of secret decisions
    (`ReadonlyMap<decision, ReadonlyMap<account, Choice>>`) and puts each on its view as `view.book`, where
    `count`, `closingEvent` and `removalEvents` read it. Folding an open secret decision without its book throws, so
    a caller cannot show a silently zero tally. Callers that never read the tally (the outstanding list,
    `decisionStates`) pass `"untallied"` explicitly. Every store read method deletes `view.book` before returning,
    so it never crosses RPC.
*   **Erase.** `eraseClosed(txn, closingEvents)` runs last in the transaction, after every put, so nothing it deletes
    is written back. It lists `bv:<decision>:` for each closed secret decision, deletes those rows and every key in
    their `iks`, and returns the counts. After commit, one log line: room, decision, tally,
    ballot rows deleted, idempotency rows deleted. No seats, no choices.

### Count and evaluate under a secret ballot

**How it works today.** `count()` takes each account's latest binding vote, drops votes that were voided or whose
seat was removed, and counts the rest. `evaluate` closes a decision early when the result can no longer change:
it fails the decision if the rule could not hold even if every account yet to vote approved, and passes it if the
rule would hold even if every account yet to vote, and every unreachable account, rejected.

**What changes for a secret decision.**

1.  The count reads the ballot book, one entry per account, not vote events.
2.  A removed seat's account keeps its vote. Only a ballot row's absence means "has not voted".
3.  `evaluate`'s pass check adds to the assumed rejections only the unreachable accounts **with no ballot-book
    entry**. Adding
    every unreachable account would count a removed voter twice: once as their vote, once as an assumed reject.
    The shown `tally.unreachable` keeps counting every removed account, so it moves on every removal whether or not
    the seat had voted.

A removal that closes the decision at once shows that the removed voter had not voted (L7). That reveals who
voted, never a choice.

### Deadline alarm (every decision)

`SessionDO` runs every timed job through one alarm and a scheduler of named handlers whose due times are derived
from the stored record (`#derivedDue`, `driver.reArm`).

*   **A new handler**, `DECISION_HANDLER`, is due at the earliest `expires_at` in `openDecisions`, plus one
    millisecond, because `dueToExpire` treats a decision as overdue only once `now` is past `expires_at`.
*   **It is derived before `#derivedDue`'s early return for closed rooms**, so a room that closes with decisions
    open still closes them. `closeDecision` has no closed-room refusal.
*   **When it fires**, it closes every overdue decision as `expired` through `closeDecision`, which erases secret
    ones. It ignores a freeze: a freeze stops members writing, and must not keep choices in storage.
*   **Re-arming.** `#writeDecision` reports `forward` when the earliest deadline in `openDecisions` moves earlier,
    so opening a decision that ends sooner than the armed alarm re-arms it.
*   **It applies to every decision, not only secret ones** (owner, 2026-11-01). ADR 0040 decision 4 ("a vote past
    the deadline still lands until something closes it") is retired, and its open question 6 is answered. A vote
    between the deadline and the alarm still lands; after the close, `applyVote` refuses it.
*   **A purged room** has no record, so `#derivedDue` arms nothing for it.
*   **Records without the `openDecisions` book** (decisions opened before #407) hold only open ballots and keep
    today's behaviour.
*   **Node.** `MemoryStore.housekeep` closes overdue decisions in every room on its pass, before it skips abandoned
    rooms or rooms with nothing due.
*   **Audit.** Closes from the alarm and the sweep are written with the system actor; the parties are the room's
    org and the orgs on its roster, through the existing `auditRows` helper.

### Reads

No event filter is needed: no stored event holds a secret choice or a secret voter. `publicEvent`,
`publicReadEvent`, `readableEvent`, `eventsFor`, the room socket and the public route are unchanged. What changes:

*   **`decisionShown(v, members, full, reader, voted)`.** `reader` is the caller's user id, and `voted` the caller's
    `votedOn` answer for this decision; the admin read passes `null` for both. For a secret decision:
    *   `votes` and `advisory_votes` are always empty.
    *   While open, `voted` appears only on electorate rows whose account is `reader`, with the value of the `voted`
        argument.
    *   After close, every row's `voted` comes from the `decision_closed` payload's `voted` list.
*   **`bellman_decide read`** without a decision lists through `store.decisions({ limit: DECISIONS_LISTED })`,
    which folds with the ballot books, instead of folding the raw log in the tool. It returns every decision in
    `open`, then the page's closed ones, de-duplicated by cursor, newest first, capped at 20. The output shape is
    unchanged. Open-ballot rooms change too: the list can now include closed decisions older than today's time
    window, and the description says so. `GET /rooms/:id/decisions` already reads through the store. Both pass the
    caller's own `votedOn` answer to `decisionShown`; the route's body-hash `ETag` is computed after that and the
    route stays `no-store`.
*   **`BellmanStore.votedOn(sessionId, userId, decisions)`** returns which of the given open secret decisions the
    account has a ballot row in. It answers only for the caller's own account.
*   **Sync's outstanding list.** `decisionsAwaiting` takes the set from `votedOn` for secret decisions and folds with
    `"untallied"`. For open-ballot decisions it reads the log as today.
*   **Not affected.** Search indexes only `message`. Restore reads only `surface`. Report refuses anything outside
    `SEND_KINDS`. A2A reads only `outside_question`. The host model reads replies only.

### Tools, manifest and consent

*   **`voteOn(..., reasonField: "reason" | "result")`** reads the decision's opening event (`eventAt`) before
    anything else, and on a secret decision refuses before the send-limit check (`admitSend`):
    *   `human_approved: false`: "Advisory votes are not taken in a secret ballot. Ask your human, then vote with
        human_approved: true."
    *   a reason: "A secret ballot stores no reason. Vote again without one." The message names `reasonField`, so
        a vote that arrived as a `bellman_send` `action_response`, whose reason is `result`, is told to drop
        `result`.
    *   past the cap: "This account has voted the most times it may on this decision."

    An unknown decision returns today's `unknown`. A secret vote's result is `{ ballot: "secret", capacity, state }`
    when appended and `{ ballot: "secret", recorded: true, note }` on a retry: never a cursor, never a choice.
*   **`bellman_decide open`** on a secret kind adds a warning when the snapshot has two or fewer accounts, or the rule
    is `unanimous`: "This secret ballot has N accounts; with this few, or under unanimous, the result can reveal how
    individuals voted." It counts accounts, not seats.
*   **Manifest resolution** refuses:
    *   `ballot: secret` on `single`: "decide.<kind>: single is one approver's action request; a secret ballot needs
        a vote."
    *   `ballot: secret` on a kind a role vetoes (`checkDecide`): "role "<key>" vetoes <kind>, which uses
        ballot: secret; drop veto on <kind> or use ballot: open; a veto reveals its holder's choice."
*   **Consent preview** (`src/projections.ts`, the `decide` block). Every kind shows `ballot`. A secret kind adds
    `ballot_promise`, a fixed string the server writes (never creator text), holding P1 to P3 and L1 to L7.
*   **`bellman_decide` description.** One sentence: under a secret ballot, send no reason, never state your human's
    choice in `bellman_send`, a surface write or progress, change a vote with a new idempotency key, and read the
    limits in the consent preview's `ballot_promise`.
*   **`bellman_send` description.** Its `action_response` answer shape adds the secret forms:
    `{ ballot: "secret", capacity, state }` and `{ ballot: "secret", recorded: true, note }`.

### Logging rule

Workers logs and traces are persisted for every request (`wrangler.toml`). No log line or error message may
include a `DecisionVote` payload or a ballot row. The catch-all handlers that print whole errors
(`src/http/rooms.ts`, `src/worker.ts`, `SessionDO.alarm()`) are where an accidental copy would land, so errors in
the vote and erase paths name only the room and the decision. Whether trace spans record stored values is the
Open Question above.

### Rollout

Three changes, each of which can be rolled back on its own:

1.  **The deadline alarm** (every decision). Ships first. It changes open-ballot behaviour: a late vote no longer
    lands once the alarm has closed the decision.
2.  **Secret ballot, release 1.** Everything else, including `DecideConfig.ballot`, the draft-rule change and
    every read and erase path, while the manifest parser still refuses `ballot`. No room can declare a secret
    ballot yet; tests create secret decisions through the store.
3.  **Secret ballot, release 2.** The parser accepts `ballot: secret`. Rolled back to release 1, a room created
    under release 2 keeps its stored manifest, and release 1 still opens, tallies and erases its decisions as
    secret.

## Alternatives Considered

### A. Operator-blind ballots while open (encrypted ballots, trustee key, validity proofs)

*   **Pros**: The operator could not read a choice at any time.
*   **Cons**: The operator authenticates whoever submits a ballot, so it always knows which seat voted when. With
    live counts, the count change after a ballot reveals its choice to the operator whatever the encryption.
    Hiding that needs anonymous submission. It also needs per-seat keys (#382), trustees who decrypt only the summed
    tally and destroy their key shares, and zero-knowledge proofs that each ballot is one valid choice. The browser
    code that encrypts would be served by the operator it guards against.
*   **Reason for Rejection**: It conflicts with live counts, which the owner kept, and it is a cryptographic voting
    project in its own right.

### B. Erase at close by rewriting every stored copy

*   **Pros**: Keeps today's event shape while open.
*   **Cons**: Breaks the rule that a log row is never rewritten (`src/store-do.ts`). It has to reach the `e:` row,
    its `dv:` copy and the idempotency record on every close path, and every exit has to strip the choice.
*   **Reason for Rejection**: Keeping choices out of the log makes erasure a prefix delete and leaves the exits
    unchanged.

### C. Reveal each vote's author at close, or keep it in storage and hide it on read

*   **Pros**: The full history of who voted when would exist after the fact.
*   **Cons**: Members see each vote event's cursor and the count change it caused. Knowing the author of cursor N
    turns "cursor N moved reject +1" into "seat X voted reject", for every vote. If the author stays in storage, a
    breach, subpoena or operator read plus one member's log of the live count does the same. Hiding it on read also
    needs a filter on every exit, and `bellman_sync`, which leaves out the caller's own events by author, would show
    a voter exactly which cursors were theirs.
*   **Reason for Rejection**: The author is never stored. Who voted is revealed only as a set, in electorate order.

### D. Batched or at-close tallies

*   **Pros**: A count change cannot be matched to a single vote's timing.
*   **Cons**: Members lose the live count. With authors never stored, a count change cannot be tied to a seat, so
    batching protects only against matching it to when someone was active.
*   **Reason for Rejection**: The owner chose plain live counts and accepted L6.

### E. Who-voted visible while open

*   **Pros**: Turnout pressure.
*   **Cons**: The same visibility makes reprisal against non-voters possible.
*   **Reason for Rejection**: Hidden until close (owner, 2026-10-30).

### F. Secret from members only, with storage keeping every choice

*   **Pros**: No erasure and no deadline alarm. A tally could be recounted later.
*   **Cons**: Anyone with storage access reads every choice forever.
*   **Reason for Rejection**: After close, no storage may hold a choice (owner, 2026-11-01).

### G. Dash-session-only secret votes

*   **Pros**: Keeps choices away from the relaying agent's model provider.
*   **Cons**: Dash voting is not built, and agents could no longer relay their human's vote.
*   **Reason for Rejection**: Agents may relay votes (owner, 2026-11-01). The provider's copy is L3.

### H. Void a removed seat's vote, and hold the tally change back until close

*   **Pros**: An evicted bad actor's vote does not count, as under an open ballot today.
*   **Cons**: Voiding it at once reveals the choice the moment the seat leaves. Holding the change back reveals it at
    close, as the difference from the last live count. A removal that settles the decision either closes at once,
    revealing the choice, or runs on a tally the server knows is wrong.
*   **Reason for Rejection**: Every variant reveals the choice. A removed seat's vote stays counted (owner,
    2026-11-01).

### I. Voter read-back of their own choice

*   **Pros**: A voter can confirm their agent relayed the vote as asked.
*   **Cons**: It is a receipt a coercer can demand, and a dishonest relaying agent would lie about it too.
*   **Reason for Rejection**: No receipts (owner, 2026-11-01). The same reasoning removes the vote's cursor from
    results and a `revisions_left` count from reads: the cap refusal already tells a voter when they are out.

### J. Hide advisory votes instead of refusing them

*   **Pros**: An agent could still record its own opinion.
*   **Cons**: A hidden advisory vote has no reader, and ADR 0040 justifies advisory votes by humans reading them.
*   **Reason for Rejection**: Refused on secret kinds (owner, 2026-11-01).

### K. Other ballot row layouts

*   **One row per decision.** Every vote rewrites one value that holds every account's choice, up to about 200 KB at
    the 5,000-seat ceiling. Rejected for size and write cost.
*   **One row per vote.** Every vote, and every read of an open decision, lists up to 30,000 rows, and revised-away
    choices stay stored until close. Rejected for read cost and for keeping more than the tally needs.
*   **Reason for choosing one row per account**: one read answers every per-account question (the cap, "has this
    account voted", the voted set at close), and close deletes at most 5,000 rows plus the idempotency records
    (owner, 2026-11-01).

### L. Other idempotency handling for a secret vote

*   **Store no idempotency record.** A network retry would become a revision and use one of the account's six
    votes. Rejected: the owner kept the record (2026-11-01).
*   **Answer a matching retry and a different-choice reuse differently** (today's "replayed" and "conflict").
    Resending a key with each choice would reveal the stored one. Rejected.
*   **A print without the choice.** A reused key with a different choice would replay silently. Rejected; the one
    `recorded` answer tells the caller to use a new key to change a vote.
*   **Hashing the print.** Three possible choices make a hash reversible. Rejected.

### M. Store a secret vote's reason and erase it at close

*   **Pros**: Agents that always send a reason are not refused.
*   **Cons**: Nobody reads it, the operator can while open, and free text can identify its author or state the
    choice.
*   **Reason for Rejection**: Refused at the tool.

### N. A deadline alarm for secret decisions only, or closing decisions inside the room-close transactions

*   **Secret only.** Two rules in one room, and ADR 0040's open question 6 left open. Rejected (owner, 2026-11-01).
*   **Close in the room-close transactions.** Touches three call sites and adds a close path. Deriving the alarm
    before the closed-room early return covers the same case in one place. Rejected.

### O. A tally check before erasure

*   **Pros**: It would catch a tally that disagrees with the ballots at the last moment they exist.
*   **Cons**: The tally is computed from the same rows the check would read, so it proves nothing. A throw at that
    point blocks the close, so choices are never erased and an eviction that settles a decision fails.
*   **Reason for Rejection**: It fails unsafe. The leak and contract tests check the tally instead.

### P. Skip the presence update on a secret vote

*   **Pros**: A seat's presence would not change at the moment a vote lands.
*   **Cons**: Presence updates are throttled, and any `bellman_sync` near the vote updates it anyway.
*   **Reason for Rejection**: It buys nothing; L6 states the limit.

## Risks & Mitigations

| Risk | Effect | Mitigation | Owner |
| --- | --- | --- | --- |
| Operator reads choices while open | Choices visible to Bellman staff for up to 7 days | L1 stated in consent preview and docs | Product |
| Point-in-time recovery | Erased choices restorable for ~30 days | L2 stated; restores need a named approval in the runbook | Operator |
| Model provider and client copies | Relayed choices kept outside Bellman | L3 stated; tool description says send no reason | Product |
| Trace spans or a log line capture a choice | Choices persist in Cloudflare past close | Open Question gates release 2 (fallback: tracing off for the whole Worker); logging rule | Engineering |
| A new read path or store method exposes a choice | Leak | No stored event holds one; the leak test covers every exit; the contract inspects storage | Engineering |
| Removal closes a decision at once | Shows the removed voter had not voted | L7 stated | Product |
| Timing and presence | A member matches a count change to a seat's activity | L6 stated | Product |
| The deadline alarm changes open-ballot rooms | Late votes stop landing once the alarm fires | Ships as its own change; ADR 0040 amended | Engineering |
| Close at the seat ceiling | Up to 5,000 ballot rows and 30,000 idempotency rows deleted in one transaction | Known limit; move behind a watermark on a follow-up alarm if measured over the request budget | Engineering |

## Non-Functional Requirements

*   **Security & privacy.** No existing read path loses a protection. The new rule that must not regress, that no
    stored or outbound data ties a seat to a secret vote or holds a choice after close, is enforced by the leak test
    and the storage inspection.
*   **Performance.** A secret vote reads the decision's ballot book (at most 5,000 rows) and writes one row. A poll
    of the decisions route can read up to 20 open secret decisions' books, 100,000 rows at the ceiling. A close
    deletes the decision's ballot rows and their idempotency records (see Risks).
*   **Tool listing budget.** `ballot` in the rule schema grows the `bellman_start` and `bellman_connect` schemas, and the
    `bellman_decide` and `bellman_send` descriptions grow by a sentence each. Re-measured by the method in `docs/ARCHITECTURE.md` §11 and
    recorded there. The listing must stay under 11,840 tokens.
*   **Rollout & rollback.** See Rollout.

## Additional Resources

*   [ADR 0040](../../adr/0040-room-consensus.md) (room consensus) and its 2026-10-29 amendment;
    [ADR 0035](../../adr/0035-audit-tamper-evidence-and-sink.md) (audit hash chain and sink).
*   Issues #469 (this), #401 (consensus epic), #486 (civic rooms), #382 (device identities), #411 (decisions route).
*   The owner's decisions cited as "(owner, date)" are recorded in the ADR 0040 amendment this change adds.

## Future Improvements

*   **Operator-blind ballots**, if live counts are ever given up or anonymous submission becomes available
    (Alternative A).
*   **Resumable erasure** behind a watermark, if closes at the seat ceiling prove slow.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

Files are grouped by change (see Rollout). Code is referenced by symbol name, not line number. ADR placement: a new
"Amendment, 2026-11-01" section in ADR 0040, numbering decisions from 22, following the 2026-10-29 amendment.

### Change 1: the deadline alarm

#### 1. `src/store-do.ts` (Modify)

*   **Type / Scope**: `SessionDO`.
*   **Proposed Changes**:
    *   A handler name `DECISION_HANDLER = "decision"`. `#derivedDue` derives it as the earliest `expires_at` in
        `s.openDecisions` plus one millisecond, computed **before** the early return for closed rooms. It is absent
        when the `openDecisions` book is empty or missing, and when the room is purged (no record).
    *   `alarm()` dispatches that name to a new private method `#expireDecisionsIfDue(now)`. The method reads the
        `openDecisions` book and closes each overdue decision with `closeDecision(cursor, { state: "expired" }, now,
        audit)`, where `audit` is `auditRows(rosterParties(s), facts, SYSTEM_ACTOR)`. It writes nothing when none is
        due.
    *   `closeDecision` skips its `frozenAt` refusal when `close.state` is `expired`.
    *   `#writeDecision` sets `forward` when the earliest deadline in the `openDecisions` book after the write is
        earlier than before it, so `#afterDecision` re-arms.

#### 2. `src/store.ts` (Modify)

*   **Type / Scope**: `BellmanStore` contract docs and `MemoryStore`.
*   **Proposed Changes**:
    *   `closeDecision`'s contract doc says an `expired` close ignores a freeze. `MemoryStore.closeDecision` drops its
        `frozenAt` refusal for `expired`.
    *   `MemoryStore.housekeep` stays synchronous. For each room, before its `isAbandoned` and "nothing due" skips,
        it closes every overdue decision through the synchronous close internals that `closeDecision` uses (not the
        async method), with audit rows from `auditRows(rosterParties(s), facts, SYSTEM_ACTOR)`.

#### 3. `tests/helpers/store-contract.ts` (Modify)

*   **Type / Scope**: conformance suite.
*   **Proposed Changes**: an overdue decision in a frozen room is closed by `closeDecision("expired")`; the closing
    audit row of a system close has `actorUserId: "system"`.

#### 4. `tests/store.test.ts` (Modify)

*   **Type / Scope**: MemoryStore tests.
*   **Proposed Changes**: `housekeep` closes an overdue decision, including in an abandoned room and a frozen one.

#### 5. `worker-tests/alarms.test.ts` (Modify)

*   **Type / Scope**: alarm scheduling in workerd.
*   **Proposed Changes**: through `getAlarm()`:
    *   the alarm is armed at the earliest open deadline plus one millisecond, and not for decisions when none is
        open
    *   opening a decision with an earlier deadline re-arms it
    *   a closed room with an open decision still arms it
    *   firing closes the decision `expired`, in open and frozen rooms alike, then arms the next deadline

#### 6. `docs/adr/0040-room-consensus.md` (Modify)

*   **Type / Scope**: ADR.
*   **Proposed Changes**: "Amendment, 2026-11-01", decision 22: the deadline alarm closes every overdue decision,
    frozen and closed rooms included; decision 4 is retired; open question 6 is answered. Update the revision note at
    the top.

#### 7. `docs/ARCHITECTURE.md` and `src/EGM.md` (Modify)

*   **Type / Scope**: whole-system doc and the `src/` directory contract.
*   **Proposed Changes**: in the paragraph of each that names the alarm's handlers (beside `expiry`), add `decision`:
    the earliest open decision deadline, derived even for a closed room.

### Change 2: secret ballot, release 1

#### 8. `src/types.ts` (Modify)

*   **Type / Scope**: shared types.
*   **Proposed Changes**: `DecideConfig`'s per-kind rule gains `ballot?: "open" | "secret"`.

#### 9. `src/manifest.ts` (Modify)

*   **Type / Scope**: manifest parsing.
*   **Proposed Changes**: `RuleShape`'s object form gains an optional `ballot` string. `resolveDecide` checks it
    against `open | secret`, following `RuleShape`'s existing habit of taking strings and checking them in the
    resolver, and carries it into `DecideConfig`. In this release it refuses `secret` with "decide.<kind>.ballot:
    secret ballots are not enabled yet; omit it", following the `require` precedent. The schema change lands now so
    the tool listing is measured once.

#### 10. `src/decision.ts` (Modify)

*   **Type / Scope**: runtime-free decision logic shared by both stores.
*   **Proposed Changes**:
    *   `isSecret(payload: DecisionOpened): boolean`.
    *   `SecretVote`: `DecisionVote` without `choice`, `reason` and `response_cursor`, with `ballot: "secret"`.
        `Ballot.vote` becomes `DecisionVote | SecretVote`. `VoteInput` keeps its choice: the tool still hands the
        store one.
    *   `BallotBook = ReadonlyMap<number, ReadonlyMap<string, Choice>>` (decision → account → choice), and
        `DecisionView.book?: ReadonlyMap<string, Choice>`.
    *   `decisionsOf(events, now, ballots?: BallotBook | "untallied")`. It puts each secret decision's ballot book on
        its view as `book`. Folding an open secret decision with no ballot book throws, unless the caller passed
        `"untallied"`, which gives it the zero tally and is used only where the tally is not read. A closed decision
        takes its stored tally, as today. `decisionStates` folds with `"untallied"`.
    *   `count()` for a secret decision counts one vote per account from `view.book`, removed seats' accounts
        included. `evaluate`'s pass check adds to the assumed rejections only unreachable accounts with no
        ballot-book entry. `Tally.unreachable` is unchanged.
    *   `applyVote(view, voter, vote, n?)` takes the vote with its choice and reads secrecy from `view.payload`. On a
        secret decision:
        *   it evaluates with the voter's account entry in `view.book` replaced by the new choice
        *   it refuses `capacity: "advisory"` with a new `{ kind: "advisory_secret" }` refusal
        *   it applies the cap to `n`, the account's vote count from its ballot row

        `n` is ignored for open ballots, which keep the per-seat count.
    *   `removalEvents`: for a secret decision, writes `voided: []` and `ballot: "secret"`, and recounts from
        `view.book`.
    *   `closingEvent`: for a secret decision, adds `voted` to the payload: every electorate seat whose account has an
        entry in `view.book`, in electorate order.
    *   `decisionAudit(template, events, views, secretParties)`: for a secret decision's `decision_closed`, the
        detail is `{ decision, kind, hash, state, reason?, tally, voted }`, and the rows are built with
        `auditRows(secretParties, facts, SYSTEM_ACTOR)` instead of from `template`. Rows for `decision_opened` and
        `decision_voter_removed` are built from `template` as today.
    *   `decisionsAwaiting(events, memberId, now, perOpener, secretVoted: ReadonlySet<number>)`: for a secret
        decision, "has voted" is membership in `secretVoted`; it folds with `"untallied"`.

#### 11. `src/store.ts` (Modify)

*   **Type / Scope**: `BellmanStore` and `MemoryStore`.
*   **Proposed Changes**:
    *   **Interface:**
        *   A new method, `votedOn(sessionId, userId, decisions: number[]): Promise<number[]>`.
        *   A new `VoteWrite` outcome, `recorded`.
        *   Contract docs: a secret vote is stored with the system author and no choice; reads never return a choice
            or a ballot book; every close of a secret decision deletes its ballot rows and their idempotency
            records.
    *   **MemoryStore**, a ballot map per room (`decision → account → { choice, n, iks }`):
        *   **`castVote`:**
            *   reads the opening event first
            *   `decisionKey` returns its storage key
            *   on a secret decision, a found record naming this decision answers `recorded`, and one naming another
                answers `conflict`
            *   otherwise it appends the secret event with the system author and no choice, updates the ballot row,
                and stores the key record, all **before** `decisionWrites` writes any close
        *   **`decisionWrites`** runs `eraseClosed` last, deleting a closed decision's ballot rows and their `keys`
            entries.
        *   **The removal path,** which today appends through `appendNow` and calls `decisionAudit` itself, moves
            onto `decisionWrites`, and its own `decisionAudit` call is removed so rows are not written twice.
        *   **Every fold** passes the room's ballot books.
        *   **Reads:** `decision` and `decisions` delete `view.book` before returning, and `votedOn` reads the map.

#### 12. `src/store-do.ts` (Modify)

*   **Type / Scope**: `SessionDO` and `DurableObjectStore`, the production store.
*   **Proposed Changes**:
    *   **Key helpers:** `ballotKey(decision, account)` = `bv:<decision>:<account>` and `ballotPrefix(decision)`.
    *   **`#decisionKey`** also returns the storage key it computed.
    *   **`castVote`:**
        *   reads the opening event (`eventKey(decision)`) before `#decisionKey`
        *   on a secret decision, maps a found record whose print names this decision to `recorded`, and leaves one
            naming another decision as `conflict`
        *   reads `ballotPrefix(decision)` with the log, and folds with that ballot book
        *   hands `#writeDecision` the event, and the ballot row `{ choice, n + 1, iks }` through its `record`
            argument beside the idempotency record
    *   **`#writeDecision`** receives the ballot books, which it passes to `decisionsOf` for `decisionAudit` along
        with `rosterParties(s)`. After its `putRows`, it calls `#eraseClosed(txn, events)`, which:
        *   for each `decision_closed` of a secret decision, lists `ballotPrefix`
        *   deletes those rows and every key in their `iks`
        *   returns the counts for the log line
    *   **The departure transaction** that calls `removalEvents` reads the ballot books of the decisions it recounts.
        It calls `#eraseClosed` after its put for any close it writes.
    *   **Folds:** `openDecision` and `closeDecision` read the ballot books of the decisions they fold.
    *   **Reads:** `decision()` and `decisions()` read the ballot books of the open secret decisions they return, so
        the tally is live, then delete `view.book`.
    *   **`votedOn`** gets `ballotKey(decision, userId)` for each named open secret decision.
        `DurableObjectStore.votedOn` forwards to it.
    *   **Logging:** after a secret close commits, one `console.log` line: room id, decision cursor, tally, ballot rows
        deleted, idempotency rows deleted. Errors thrown in these paths must not include a vote payload.

#### 13. `src/projections.ts` (Modify)

*   **Type / Scope**: wire projections.
*   **Proposed Changes**:
    *   **`decisionShown(v, members, full, reader: string | null, voted: boolean | null)`.** For a secret decision:
        *   `votes: []` and `advisory_votes: []`
        *   while open, `voted` appears only on electorate rows whose account is `reader`, with the value of the
            `voted` argument
        *   after close, every row's `voted` comes from the closing payload

        Open-ballot decisions are unchanged and ignore both arguments.
    *   **`decisionMembers`** leaves out ballots whose author is `system` when it looks up departed members.
    *   **Consent preview:** `decide.rules[kind]` gains `ballot`, always present. A secret kind adds `ballot_promise`,
        the constant `SECRET_BALLOT_PROMISE`, which holds P1 to P3 and L1 to L7 word for word.

#### 14. `src/tools/decide.ts` (Modify)

*   **Type / Scope**: `bellman_decide` and `voteOn`.
*   **Proposed Changes**:
    *   **open:** the draft rule is `{ rule, quorum?, ballot: "secret" }` for a secret kind, and today's shape for an
        open one. The result adds the small-electorate warning (Tools, manifest and consent), counting the snapshot's
        distinct accounts.
    *   **read:**
        *   The list path calls `store.decisions({ limit: DECISIONS_LISTED })` and merges `open` with the page as in
            Reads.
        *   Both paths call `store.votedOn` for the caller's account and pass the caller's user id and the answer to
            `decisionShown`.
    *   **`voteOn(s, sessionId, session, me, identity, vote, key, reasonField: "reason" | "result")`:**
        *   It reads the opening event with `eventAt` before `admitSend`. A missing event returns `unknown`.
        *   On a secret decision it refuses `human_approved: false` and a reason, with the messages in Tools, manifest
            and consent, naming `reasonField`.
        *   It answers `{ ballot: "secret", capacity, state }` when appended, and
            `{ ballot: "secret", recorded: true, note }` on `recorded`. Never a cursor.
    *   **Description:** the one added sentence (Tools, manifest and consent), and a note that the list includes
        closed decisions.

#### 15. `src/tools/send.ts` (Modify)

*   **Type / Scope**: `bellman_send`.
*   **Proposed Changes**: the `action_response` path that answers a decision passes `reasonField: "result"` to
    `voteOn`. The description's answer shape for a decision answer adds the two secret forms.

#### 16. `src/tools/sync.ts` (Modify)

*   **Type / Scope**: `bellman_sync`.
*   **Proposed Changes**: before building the outstanding list, call `store.votedOn` for the open secret decisions in
    the window, and pass the set to `decisionsAwaiting`.

#### 17. `src/http/rooms.ts` (Modify)

*   **Type / Scope**: member HTTP routes.
*   **Proposed Changes**: `GET /rooms/:id/decisions` calls `store.votedOn` for the caller and passes the caller's
    user id and each answer to `decisionShown`; the admin read passes `null` for both. The `ETag` hash is computed
    after.

#### 18. `src/EGM.md` and `src/tools/EGM.md` (Modify)

*   **Type / Scope**: directory contracts.
*   **Proposed Changes**: `src/EGM.md` names the `bv:` storage prefix and `votedOn` in the decisions method family.
    `src/tools/EGM.md` gives the secret vote result shapes beside today's `{ cursor, ... }`.

#### 19. `tests/decision.test.ts` (Modify)

*   **Type / Scope**: unit tests of `src/decision.ts`.
*   **Proposed Changes**:
    *   `isSecret`.
    *   `decisionsOf` with ballot books, with `"untallied"`, and the throw without either.
    *   A removed seat's account stays counted, and `evaluate` does not count it twice.
    *   `applyVote`'s advisory refusal, per-account cap and choice replacement. Existing `applyVote` calls keep
        passing, since `n` is optional.
    *   `removalEvents` writes `voided: []`.
    *   `closingEvent` writes `voted`: in electorate order, every seat of an account that voted.
    *   `decisionAudit`'s secret closing row: `actorUserId: "system"`, one row per party, no per-vote rows.
    *   `decisionsAwaiting` with `secretVoted`.
    *   `decisionStates` on an open secret decision.
    *   Open-ballot behaviour unchanged.

#### 20. `tests/http-decisions.test.ts` (Modify)

*   **Type / Scope**: `decisionShown` and the decisions route.
*   **Proposed Changes**:
    *   A secret decision while open has no vote lists, and shows `voted` only on the reader's own rows.
    *   After close, every row's `voted` matches the closing payload.
    *   Two readers, one who has voted and one who has not, get different `ETag`s.

#### 21. `tests/decide-manifest.test.ts` (Modify)

*   **Type / Scope**: manifest and consent-preview tests.
*   **Proposed Changes**:
    *   Release 1 refuses `ballot: secret`.
    *   The preview shows `ballot` for every kind. For a stored manifest carrying `ballot: secret`, it shows
        `ballot_promise` equal to `SECRET_BALLOT_PROMISE`.

#### 22. `tests/helpers/store-contract.ts` (Modify)

*   **Type / Scope**: conformance suite both stores must pass.
*   **Proposed Changes**:
    *   **Harness:** a new required callback, `roomRows(sessionId): Promise<[string, unknown][]>`, which returns
        every stored key and value of the room.
    *   **Close paths:** one case each for paths 1-3, 5 and 6. Path 4 is in items 24 and 26. Each case opens a secret
        decision through `store.openDecision` with a secret rule, votes with known choices and idempotency keys,
        closes it by that path, then asserts:
        *   the closed tally equals the count of the latest choice of each account that voted
        *   `voted` lists, in electorate order, every seat of each account that voted
        *   no `bv:<decision>:` key remains
        *   no `ik:` key for the test's keys remains
        *   no stored decision event has a `choice` property, or a voter as its author
        *   the closing audit row has `actorUserId: "system"` and no per-vote rows
    *   **Retries:**
        *   After close, a retry returns `closed`.
        *   While open, a retry with the same or a different choice returns `recorded`.
        *   A key first used on another decision returns `conflict`.
    *   **Other cases:**
        *   A removed voter's vote stays in the closed tally.
        *   `votedOn` answers only for the given account.
        *   The live tally from `decision()` while open equals the closed tally (G3).

#### 23. `worker-tests/store-contract.test.ts` (Modify)

*   **Type / Scope**: the workerd harness.
*   **Proposed Changes**: implements `roomRows` with `runInDurableObject(stub, (_, ctx) => ctx.storage.list())`.

#### 24. `tests/store.test.ts` (Modify)

*   **Type / Scope**: the Node harness and MemoryStore tests.
*   **Proposed Changes**:
    *   `roomRows` reads MemoryStore's private maps through a cast, as the harness already does for `reporterRows`,
        and names their entries `e:<cursor>`, `bv:<decision>:<account>` and `ik:<member>:<key>`.
    *   Close path 4: `housekeep` erases an overdue secret decision's ballot and key entries.

#### 25. `tests/tools/decide.test.ts` (Modify)

*   **Type / Scope**: tool tests through the in-memory MCP harness.
*   **Proposed Changes**:
    *   Refusals: advisory; a reason; `result` through `bellman_send`, which names `result`.
    *   Refusals happen before the send limit is charged.
    *   The vote and retry results have no cursor and no choice.
    *   The list path shows a live tally for an open secret decision, and includes a closed decision older than the
        window.
    *   `open` returns the warning for a two-account electorate.

#### 26. `worker-tests/secret-ballot.test.ts` (Create)

*   **Type / Scope**: real workerd, `SessionDO`.
*   **Proposed Changes**:
    *   Socket replay and the live frame carry the system author and no choice.
    *   Close path 4: the deadline alarm erases an expired secret decision's ballot rows and idempotency rows.

#### 27. `tests/secret-ballot-leak.test.ts` (Create)

*   **Type / Scope**: the leak test across every exit (G1).
*   **Proposed Changes**: a room with three members and a secret decision opened through the store, with votes cast
    with known choices through the tool. Read through each exit below as a non-voting member, as the voter, and as
    a public-link reader:
    *   `bellman_sync`
    *   `bellman_surface`
    *   `bellman_decide` read, vote and retry results
    *   `GET /rooms/:id/events` and `GET /rooms/:id/decisions`
    *   the public events route
    *   `liveRooms`
    *   the host seat's model input, captured through `MemoryHost`'s `fetch` constructor option
    *   the org audit rows queued for the close

    Assert:
    *   no `choice` key anywhere for the decision
    *   no voter's member id, label or user id on a `decision_vote`
    *   no vote cursor in any result
    *   no `voted` for another account while open
    *   the closing audit row's `actorUserId` is `"system"`

    Run it while open and after close. The socket exits are covered in item 26.

#### 28. `docs/adr/0040-room-consensus.md` (Modify)

*   **Type / Scope**: ADR.
*   **Proposed Changes**: the 2026-11-01 amendment gains decisions 23 to 28:
    *   23: the secret ballot, its promise and its limits (P1 to P3, L1 to L7)
    *   24: choices are kept out of the log, in one ballot row per account, and deleted on every close path
    *   25: a secret vote's author is never stored; who voted is revealed at close as a set
    *   26: a removed seat's vote stays counted under a secret ballot
    *   27: no read-back, no cursor in results, and one `recorded` answer for retries; advisory votes and reasons are
        refused
    *   28: the closing audit row holds the tally and the voted set, written as the system

    Decision 21's sentence "a secret-ballot option (#469)" becomes "a secret-ballot option (#469, decisions 23 to
    28)".

#### 29. `docs/ARCHITECTURE.md` (Modify)

*   **Type / Scope**: whole-system doc.
*   **Proposed Changes**:
    *   §11: a budget row for this change (the `ballot` schema field and the `bellman_decide` and `bellman_send`
        description changes), with the tool listing re-measured by §11's method.
    *   The consensus section: one paragraph on secret ballots, the ballot rows and the six close paths.

#### 30. `docs-site/src/content/docs/reference/tools/*` and `reference/bridge-tools.md` (Regenerate)

*   **Type / Scope**: generated tool reference.
*   **Proposed Changes**: `npm run docs:gen` after the description and rule schema changes. Never edited by hand.

### Change 3: secret ballot, release 2

#### 31. `src/manifest.ts` (Modify)

*   **Type / Scope**: manifest parsing.
*   **Proposed Changes**:
    *   `resolveDecide` stops refusing `ballot: secret`, and refuses it with `rule: single`.
    *   `checkDecide` refuses it on a kind any role vetoes.
    *   The messages are as in Tools, manifest and consent.

#### 32. `tests/decide-manifest.test.ts` (Modify)

*   **Type / Scope**: manifest tests.
*   **Proposed Changes**: replace the release 1 refusal with these cases:
    *   `secret` is accepted and reaches `decision_opened.rule` through the tool
    *   `secret` with `single` is refused
    *   `secret` with a veto is refused
    *   a rule with no `ballot` is read as `open`
    *   `docs-site/src/content/docs/guides/manifests.md` contains `SECRET_BALLOT_PROMISE`

#### 33. `docs-site/src/content/docs/guides/manifests.md` (Modify)

*   **Type / Scope**: user guide.
*   **Proposed Changes**:
    *   a `ballot: secret` example beside the existing `decide` example
    *   P1 to P3 and L1 to L7, word for word
    *   the two refusals

#### 34. `docs/ARCHITECTURE.md` and the generated reference (Conditional)

*   **Type / Scope**: docs.
*   **Proposed Changes**: only if release 2 changes a tool description, re-run `npm run docs:gen` and re-measure §11.

### Verification Plan

*   **Every change**: `npm run verify` (typecheck of the UI, Node and Worker programs, build, `npm test`,
    `npm run test:worker`, `npm run test:mod`).
*   **Positive controls**: before relying on the leak test and the storage assertions, break each of these on
    purpose in a scratch copy and watch it fail:
    *   write a secret vote with the voter as author
    *   leave `choice` on a secret vote event
    *   skip `#eraseClosed` on the removal path
    *   run the erase before the put
    *   skip the idempotency-record delete
    *   return the cursor in a secret vote result
    *   build the secret closing audit row from the template
*   **Deploy path**: `npx wrangler deploy --dry-run` before merging Change 1, since it adds an alarm handler. After
    merging, confirm the deploy workflow run on `main` succeeded.
*   **Trace check**, before Change 3 merges:
    1.  `npx wrangler deploy --name bellman-trace-check` from the branch.
    2.  Cast a secret vote through its `workers.dev` URL.
    3.  Search that Worker's traces in the Cloudflare dashboard for the choice and the ballot row key. It passes if
        no span holds either.
    4.  Delete the Worker.
*   **Tool budget**: re-measure the listing by `docs/ARCHITECTURE.md` §11's method and confirm it is under 11,840
    tokens.
