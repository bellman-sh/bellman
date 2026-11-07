# tools

## Overview

The MCP tools, one file per tool plus `kit.ts` for what they share. Each file exports one `register*` function
that registers one tool on the `McpServer` that `src/server.ts` builds per request, bound to the caller's
`Identity` and a `BellmanStore`. Most room logic lives in `src/rooms.ts` (`evictMember`, `issueInvite`,
`leaveRoom`, `writeSurface`, ...); the tool files validate input, gate, and shape the answer. A new tool also
means editing `extension/manifest.json` and running `npm run docs:gen` (root `CLAUDE.md`;
`tests/extension.test.ts` and `tests/docs-reference.test.ts` fail otherwise).

## Interface

| Register function | MCP tool | File |
|---|---|---|
| `registerStart(server, identity, s, features)` | `bellman_start` | [src/tools/start.ts:registerStart] |
| `registerConnect` | `bellman_connect` | [src/tools/connect.ts:registerConnect] |
| `registerConfirm` | `bellman_confirm` | [src/tools/confirm.ts:registerConfirm] |
| `registerInvite` | `bellman_invite` | [src/tools/invite.ts:registerInvite] |
| `registerSend(server, identity, s, blobs)` | `bellman_send` | [src/tools/send.ts:registerSend] |
| `registerSync` | `bellman_sync` | [src/tools/sync.ts:registerSync] |
| `registerRooms` | `bellman_rooms` | [src/tools/rooms.ts:registerRooms] |
| `registerSurface` | `bellman_surface` | [src/tools/surface.ts:registerSurface] |
| `registerLeave` | `bellman_leave` | [src/tools/leave.ts:registerLeave] |
| `registerEvict` | `bellman_evict` | [src/tools/evict.ts:registerEvict] |
| `registerAudit(server, identity, s, features)` | `bellman_audit` | [src/tools/audit.ts:registerAudit] |
| `registerPublicName` | `bellman_public_name` | [src/tools/public-name.ts:registerPublicName] |
| `registerReport(server, identity, s, mail)` | `bellman_report` | [src/tools/report.ts:registerReport] |
| `registerDecide` | `bellman_decide` | [src/tools/decide.ts:registerDecide] |

- `bellman_send` returns `{room_members, cursor, count?, replayed?, applied?, note?}`; an `outside_answer`
  returns `{task_id, state, cursor}` [src/tools/send.ts:registerSend]
- `bellman_sync` takes `since_cursor`, `wait_seconds` (0..`MAX_WAIT_SECONDS` = 25), `surface`; returns
  `{events, cursor, session_status, more?, outstanding?, removed?, surface_cursor?, surface?}`; `SYNC_PAGE` = 50
  [src/tools/sync.ts:SYNC_PAGE]. In a room whose manifest has a `decide` block, `outstanding` also lists the open
  decisions waiting on the caller's human, each with `decision: {kind, key, hash}` [src/decision.ts:decisionsAwaiting]
- `bellman_decide` takes `action` (`open | vote | read`). `open` returns `{decision, hash, rule, expires_at,
  electorate, superseded?, replayed?, warning?}`; `vote` returns `{cursor, capacity, state?, reason?, replayed?,
  note?}` (`note` on an advisory vote), or on a secret ballot `{ballot, capacity, state, reason?}` or
  `{ballot, recorded, note}` and never a cursor; `read` returns one decision in `decisionShown`'s full shape, or with no `decision`
  `{decisions}` (every open one and the newest closed, at most `DECISIONS_LISTED` = 20, from `BellmanStore.decisions`)
  [src/tools/decide.ts:registerDecide]
- `voteOn` is the one vote path, shared by `bellman_decide vote` and an `action_response` that answers a
  decision [src/tools/decide.ts:voteOn]
- `bellman_start` returns `session_id`, `member_id`, `join_code`, `join_url`, `public_url` (public rooms only),
  `plan`, `room`, `share_instructions` [src/tools/start.ts:registerStart]
- `bellman_connect` returns a `connect_token`, the session summary, `creator_brief` and a surface index with no
  item contents; `bellman_confirm` takes it and returns `members` (present first), `recall` (the joiner's home-note
  paths, newest first, at most `RECALL_CHARS`), `briefs` (at most `BRIEFS_ON_JOIN` = 25) and `surface`, the whole
  reply at most `CONFIRM_REPLY_CHARS` as rendered: the surface is cut first (`next` pages the rest), briefs second;
  the room, its instructions and the roster are never cut (ADR 0047 decision 9)
  [src/tools/connect.ts:registerConnect] [src/tools/confirm.ts:CONFIRM_REPLY_CHARS] [src/rooms.ts:readSurfaceWithin]
- `start`, `connect`, `confirm`, `rooms` and `surface` carry `_meta: APP_UI_META` (see
  [`../ui/EGM.md`](../ui/EGM.md)) [src/tools/start.ts:registerStart]
- Annotations: `audit`, `rooms`, `surface` read-only; `evict` destructive and not idempotent; `leave` and
  `public_name` idempotent; `decide` neither read-only nor idempotent [src/tools/evict.ts:registerEvict]
  [src/tools/decide.ts:registerDecide]
- Kit result helpers `ok(output, preamble?)`, `fail(message)`, `refusal(r)` (rate-limited refusals add
  `structuredContent {error: "rate_limited", retry_after}`), `ToolResult` [src/tools/kit.ts:refusal]
- Kit input shapes `RoomRefShape`, `roomIdOf`, `NEED_ROOM`, `BriefShape`, `AgentShape`, `CapabilitiesShape`,
  `ActionResponseShape`, `DecisionAnswerShape` (an `action_response` payload plus `hash` and `human_approved`),
  `ProgressShape`, `OutsideAnswerShape`, `isReport` [src/tools/kit.ts:BriefShape]
  [src/tools/kit.ts:DecisionAnswerShape]
- `SEND_VERB` maps each `SendKind` to one `Verb`; `SEND_KINDS` re-exported [src/tools/kit.ts:SEND_VERB]
- `FrozenError` and `appendOrFrozen`, which throws when `appendEvent` returns null [src/tools/kit.ts:appendOrFrozen]
- `NO_SEAT`, `IN_NEEDS_QUERY` refusal strings [src/tools/surface.ts:NO_SEAT]

## Invariants

- `session_id` wins over `room_id`; neither is refused with `NEED_ROOM` [src/tools/kit.ts:roomIdOf]
- `bellman_send` checks the verb (`SEND_VERB[type]`) before payload validation and before reading the roster, so a
  seat without the verb learns nothing about who is present [src/tools/send.ts:registerSend]
- An `action_response` whose `ref_id` is the exact cursor of a `decision_opened` is a vote: it is told apart
  before the verb check, needs `DecisionAnswerShape`, and goes through `voteOn`, gated by `vote` rather than
  `respond_actions` (`approved` maps to approve or reject, `result` to the reason) [src/tools/send.ts:registerSend]
- Every send is refused past `MAX_PAYLOAD_DEPTH` or `MAX_PAYLOAD_CHARS`, keyed or not [src/tools/send.ts:registerSend]
- Idempotency: a known key replays the original event (`replayed: true`) without re-running checks and writes no
  audit row, brief or report stamp; a key reused for different content is refused [src/tools/send.ts:registerSend]
- Every kind but `progress` needs another active member; messages need a peer that granted `receive_messages`;
  an `action_request` needs `request_actions` from its whole audience [src/tools/send.ts:registerSend]
- `action_response` needs `ref_id` to be the exact string cursor of an `action_request`; a member cannot answer
  its own request; the first answer wins, with the derivation in action-state as the backstop
  [src/tools/send.ts:registerSend]
- `admitSend` (per-minute limit, ADR 0022) runs after the last check that can refuse and before the first write;
  keyed retries are charged too [src/tools/send.ts:registerSend]
- `room_members` claims only the other active members this call read just before its append: not a read
  receipt, and on a replay the roster at the retry [src/tools/send.ts:registerSend]
- `bellman_sync` wraps events in `untrusted()` envelopes and prepends `UNTRUSTED_PREAMBLE` when foreign content is
  present; a brief its author keeps is not handed over [src/tools/sync.ts:registerSync]
- A removed member reads only up to its `member_evicted` cursor and `wait_seconds` is ignored for it; `removed`
  is never sent with `more` [src/tools/sync.ts:registerSync]
- `session_status` and the action-request stamp are read from a fresh session read after the wait, so they are
  never older than the events returned [src/tools/sync.ts:registerSync]
- `bellman_start` resolves the manifest, then gates in order (hosted seat, mode, public, public name, org-only,
  org policy, monthly quota); each refusal creates nothing [src/tools/start.ts:registerStart]
- `bellman_confirm` checks org capability policy before taking the single-use token; `seatMember` decides
  capacity, stale-seat reclaim and bans atomically [src/tools/confirm.ts:registerConfirm]
- Briefs on join come only from active peers that pass `seesBrief`, wrapped with `untrusted()`
  [src/tools/confirm.ts:registerConfirm]
- `bellman_connect` refuses bans, org-only mismatch, org join policy and a full room before describing the room,
  and never reclaims a seat [src/tools/connect.ts:registerConnect]
- `bellman_surface` needs a handle in the room (`NO_SEAT`), reads only to the caller's cut, and keeps no seat
  alive [src/tools/surface.ts:registerSurface]
- `bellman_evict` needs exactly one of `member_id` or `question_cursor`; the creator-only rule is in
  `evictMember` [src/tools/evict.ts:registerEvict]
- `bellman_audit` refuses through `auditRefusal`; the upgrade hint appears only when the plan is the reason
  [src/tools/audit.ts:registerAudit]
- `bellman_sync` lists open decisions in `outstanding` only for a member still in the room, at most
  `MAX_REQUESTS_PER_SENDER` per opener, merged with the action requests in cursor order; a room with no `decide`
  block never reads a decision window [src/tools/sync.ts:registerSync]
- `bellman_decide` needs a seat of the caller's that has not left, and refuses `open` and `vote` in a frozen room;
  `read` is not verb-gated and prepends `UNTRUSTED_PREAMBLE` whenever it returns a decision
  [src/tools/decide.ts:registerDecide]
- `bellman_decide open` refuses, before any write: a room with no `decide` block, a kind the block does not
  declare, a `single` rule (that is an `action_request`), a seat without `request_actions`, an `effect` past
  `MAX_PAYLOAD_DEPTH` or `MAX_PAYLOAD_CHARS`, a room where no seat holds `vote`, and a `supersedes` naming
  another member's decision; `admitSend` runs last. The store's `quota` refusal is reported per room or per seat
  [src/tools/decide.ts:registerDecide]
- A vote checks `vote` before `admitSend`; its capacity is the store's, from `human_approved`, and an advisory vote
  is answered with a note that only the human's approval binds. Refusals `stale` (with the current hash in
  `structuredContent`), `closed`, `not_electorate`, `quota`, `unknown`, `conflict` and `frozen` write nothing
  [src/tools/decide.ts:voteOn]

## Side Effects

- `bellman_send` appends through `appendEventOnce` (keyed), `appendOrFrozen` or `approveProposal`; `touchMember`
  runs before the verb check; `brief_update` calls `updateMember`; audit rows `sent_<type>` on non-replayed sends
  [src/tools/send.ts:registerSend]
- The `surface` kind delegates to `writeSurface` / `writeSurfaceBatch`; an `action_response` to a decision writes
  a `decision_vote` through `voteOn` and `castVote` [src/tools/send.ts:registerSend]
- `bellman_sync` calls `touchMember` on every poll and long-polls `waitForEvents` [src/tools/sync.ts:registerSync]
- `bellman_start` claims a public name and reserves a hosted slot (both released if a later step fails), calls
  `createSession` and `recordCreate`, audits `session_created` [src/tools/start.ts:registerStart]
- `bellman_connect` writes a pending connect (`putPendingConnect`) and a `connect_previewed` audit row
  [src/tools/connect.ts:registerConnect]
- `bellman_confirm` takes the token, seats the member, appends `member_joined`, audits `brief_exchanged`
  [src/tools/confirm.ts:registerConfirm]
- `evict`, `invite`, `leave`, `public_name`, `report` call `evictMember`/`banAsker`, `issueInvite`/`revokeInvite`,
  `leaveRoom`, `namePublicRoom`, `fileRoomReport` (which mails a new report) [src/tools/report.ts:registerReport]
- `bellman_decide` calls `touchMember` on every call; `open` writes through `openDecision` and `vote` through
  `castVote`, each with `auditEntries` rows (`decision_opened`, `decision_vote`) for the store to file per decision
  event; `read` reads `decision` or the decision window [src/tools/decide.ts:registerDecide]
  [src/tools/decide.ts:voteOn]
- `bellman_audit`, `bellman_rooms` and `bellman_surface` only read [src/tools/surface.ts:registerSurface]

## Verification

- Run: `npm test -- tests/tools/`
- After a tool's title, description or schema changes: `npm run docs:gen`, then
  `npm test -- tests/extension.test.ts tests/docs-reference.test.ts`
- Full gate: `npm run verify`
