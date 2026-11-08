# room

## Overview

The room's rules: the operations both transports call (`rooms.ts`), the roster rules both stores apply
(`members.ts`), manifests, roles and presets, join codes and names, presence, the heartbeat and housekeeping,
retention, sends and payload bounds, and decisions. Runtime-free: both stores, the tools, the HTTP routes and both
test programs import these.

## Interface

- `[src/room/repo-room.ts]` a repo's default room: `bindRepoRoom` (creator only, never a public room, any manifest
  role; marks the room kept open and clears the flag on a room it replaced once nothing names it), `unbindRepoRoom`,
  `listRepoRooms`, `connectFromBinding` (a pending connect with `via: "binding"`), each a `RepoRoomResult` with the
  HTTP status. `[src/room/remote.ts:normalizeRemote]` the key, `host/owner/repo` lower-cased; it imports nothing, since
  the bridge bundles it.
- `[src/room/rooms.ts]` the operations both transports call, each returning `RoomResult<T>` (`succeed`/`refuse` with a
  `RoomFailure` of `not_found | closed | frozen | forbidden | conflict | invalid | rate_limited | stale | too_large |
  over_quota | paused`): `gateSeat`, `leaveRoom`, `issueInvite`, `revokeInvite`, `admitSend`, `writeSurface`,
  `writeSurfaceBatch`, `resolveSurfaceWrite`, `checkProposal`, `evictMember`, `banAsker`, `fileRoomReport`, `namePublicRoom`,
  `liveRooms` (`ROOMS_LIMIT = 50`), `readSurfaceWindow`, `searchSurface`, `searchLog`, and `audit`.
- `[src/room/rooms.ts:activeMembers]` membership as stored; `[src/room/rooms.ts:seatedMembers]` the presence-derived roster a
  capacity check counts.
- `[src/room/attention.ts:ATTENTION]` every `EventType` as `interrupt` or `ambient`; `[src/room/presence.ts:presenceOf]`
  (`present | stale | departed`, `STALE_AFTER_MS` = 10 min).
- Members: `[src/room/members.ts]` the roster rules both stores apply (`isActiveMember`, `lastSeen`, `seatInOrder`,
  `seatVictims`, `markRemoved`, `creditReport`, `noteAppend`, `clearSilence`, `asked`) and the hosted seat's ids
  (`HOST_MEMBER_ID`, `HOST_USER_ID`, `isHostMember`).
- Manifests and roles: `[src/room/manifest.ts:resolveManifest]` (cited presets `pair`, `swarm`, `review`, `social`,
  `topic`, or an authored manifest; throws `ManifestError`), `VERBS`, `[src/room/presets.ts:checkPreset]`,
  `[src/room/roles.ts:denyVerb]`, `verbsOfRole`, `mustReport`.
- Names and codes: `[src/room/codes.ts:renderJoinCode]` (`BELL-XXXX-XX-ROLE`), `generateSessionId` (`qs_`),
  `generateConnectToken` (`qct_`), `publicRoomUrl`; `[src/room/handles.ts:checkHandle]`;
  `[src/room/public-names.ts:claimName]`, `holdsName`; `[src/room/member-names.ts:publicNames]` (`member N`, `host`).
- Sends: `[src/room/payload.ts]` (`MAX_PAYLOAD_CHARS`, `MAX_PAYLOAD_DEPTH`), `[src/room/send-limit.ts:admitAt]`,
  `[src/client/result-data.ts:resultData]`.
- Decisions (ADR 0040): `[src/room/decision.ts:evaluate]` the rule engine (closes a decision `passed`, or `failed` as
  `vetoed`, `blocked`, `rejected` or `no_quorum`, once the worst case for the seats yet to vote decides it; never
  for `single`), `applyVote`, `decisionsOf`, `tally`, `ruleOf`, `decisionTtlMs`; the quotas `decideOpenQuota`,
  `noteDecisions` (the `OpenDecisions` book), `dueToExpire`; `removalEvents` (what a leave or eviction writes into
  unclosed decisions); `decisionAudit` (the org's rows per decision event); `decisionsAwaiting` (`bellman_sync`'s
  open decisions); `decisionPageOf`, `decisionOwning` (the read page and its index).
- Room lifecycle: `[src/room/heartbeat.ts:tickPlan]`, `nextTickAt`, `snapshotOf`; `[src/room/housekeeping.ts:dueFindings]`;
  `[src/room/retention.ts:purgeDueAt]`, `sweepDueAt`, `unnamedObjects`; `[src/room/action-state.ts:actionStates]`.

## Invariants

- Room members: `ROOM_MEMBER_CEILING = 5000`, 2 for `pair` `[src/room/manifest.ts:capacityOf]`. Sends: 30 per rolling minute
  per member, 6 per stranger `[src/room/send-limit.ts:SEND_LIMIT]`. Payloads: 20,000 characters, 64 levels
  `[src/room/payload.ts:MAX_PAYLOAD_CHARS]`.
- Action requests stay answerable 30 minutes, topic-room proposals 7 days `[src/room/action-state.ts:ACTION_REQUEST_TTL_MS]`;
  the first response wins and only `approved === true` counts as an approval `[src/room/action-state.ts:verdictOf]`.
- Decisions: 20 open per room, 3 open per opening seat, 5 revisions of one seat's vote on one decision
  `[src/room/decision.ts:MAX_OPEN_DECISIONS]`, `[src/room/decision.ts:MAX_OPEN_PER_SEAT]`, `[src/room/decision.ts:MAX_REVISIONS]`; an expiry
  from 5 minutes to 7 days `[src/room/decision.ts:MIN_DECISION_TTL_MS]`; a page of 50 by default and 100 at most
  `[src/room/decision.ts:DECISION_PAGE]`. Only a binding vote (`dash_session`, or an `action_response` with
  `human_approved: true`) counts, one per account `[src/room/decision.ts:capacityOfVote]`.

## Verification

- Run: `npm test`; `npm run verify` before every commit.
