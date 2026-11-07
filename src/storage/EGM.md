# storage

## Overview

The storage boundary. `store.ts` is `BellmanStore`, the interface every tool and route writes through, with its
outcome types and the write rules both implementations apply. `memory-store.ts` is `MemoryStore`, the in-memory
implementation the Node server and the tests use. The production implementation, `DurableObjectStore`, is in
`src/workerd/store-do.ts`. The rest are the storage layout helpers both implementations share: the stored session
record, per-member rows, idempotency keys, the outbox and the registry's key layout. Everything here is
runtime-free, so vitest, the Node build and the Workers build all import it.

## Interface

- `[src/storage/store.ts:BellmanStore]` the interface every store implements; every method returns a Promise. Method families,
  each named by its real methods:
  - rooms: `createSession`, `getSession` (record and members, never events), `closeSessionIfEmpty`,
    `freezeSession`, `schedulePurge`, `unpublishSession`, `setPublicName`, `setPublicView`.
  - join codes and connect tokens: `getSessionByJoinCode`, `setJoinCode`, `consumeJoinCode`, `clearJoinCodes`,
    `putPendingConnect`, `takePendingConnect`.
  - membership: `seatMember` (the production join), `addMember` (tests), `removeMember`, `updateMember`,
    `getMember`, `getMembers`, `membersOfUser`, `departedMembers`, `publicNumbers`, `connectedMembers`.
  - the log: `appendEvent`, `appendEventOnce`, `idempotencyRecord`, `eventsAfter`, `eventAt`, `recentEvents`,
    `waitForEvents`, `admitSend`.
  - the surface: `appendSurface`, `appendSurfaces`, `approveProposal`, `surfaceOf`, `surfaceFacts`,
    `surfaceWindow`, `surfaceNamesBlob`, `sweepBlobs`, `chargeBlobBytes`.
  - decisions (ADR 0040): `openDecision`, `castVote`, `closeDecision` (each taking the caller's `audit` rows),
    `decision`, and `decisions`, a page of the room's decisions with every open one beside it, and `votedOn`, which
    open secret ballots one account has voted in (the only way to ask, since a secret vote names no seat).
  - outside tasks (A2A): `askOutside`, `answerOutside`, `cancelOutside`, `seatSkipped`, `outsideTask*`.
  - hosted seat: `appendHostEvent`, `hostEventFor`, `renewHostAllowance`, `setHostInstructions`,
    `reserveHostedRoom`, `releaseHostedRoom`.
  - moderation: `banAccount`, `roomBans`, `liftRoomBan`, `creatorBans`, `liftCreatorBan`, `suspend`,
    `unsuspend`, `isSuspended`, `fileReport`, `roomReports`, `listReports`, `resolveReport`.
  - registry indexes and accounts: `sessionsCreatedBy`, `sessionsJoinedBy`, `sessionsForOrg`, the operator's
    index of every room (`listRoomsPage`, `listRoomsFiltered`, `roomCounts`, `handlesOf`, `dropRoomIndex`,
    `backfillRoomIndex`) and `roomSummary`, `claimPublicName`, `releasePublicName`, `recordSignIn`, `listUsers`, presets, handles and `signRoom`.
  - grants, orgs, SSO, SCIM and invites: `putGrantIfOwned`, `moveGrant`, `createOrg`, `updateOrg`,
    `verifyDomain`, `provisionSsoMember`, `createScimUser`, `issueScimToken`, `putOrgInvite`,
    `acceptOrgInvite` and their reads.
  - audit (ADR 0035): `appendAudit`, `queryAudit`, `verifyAudit`, `setAuditRetention`, `sweepAudit`,
    `setAuditSink`, `pumpAuditSink`, and the platform operator's stream, `appendOperatorAudit` and
    `operatorAudit`.
  - `sweep`: housekeeping `MemoryStore` runs on an interval; `DurableObjectStore.sweep` is a no-op because each
    object's alarm does the work.
- `[src/storage/memory-store.ts:MemoryStore]` the in-memory implementation over private Maps, used by tests and the Node server. Adds
  `tick` and `housekeep` (not on the interface), which `index.ts` calls every 60 s with `sweep`.
- `[src/storage/store.ts]` shared write rules both stores apply: `codeIsLive`, `isPublic`, `seatInOrder`, `seatVictims`,
  `markRemoved`, `creditReport`, `noteAppend`, `decideBlobCharge`, `decideHostCharge`, `placeSurfaceBatch`,
  `handOff`, `electorateOf` (a decision's snapshot: the seats holding `vote`, each seat's account, and the veto
  seats for the kind), `voteRefusal`, `roomIndexRow`, `roomIndexKey`, `roomSummaryOf`; the operator's shapes
  `RoomIndexRow`, `RoomSummary`, `RoomStatus` (`open | closed | frozen | purge_scheduled`); the outcome unions
  `SeatOutcome`, `RemovalOutcome`, `EventWrite`, `SurfaceAppend`, `ApprovalWrite`, `DecisionOpen`, `VoteWrite`,
  `DecisionClose` (`DecisionOpen` and `VoteWrite` carry a `quota` refusal); and the constants `ROOM_MEMBER_CEILING = 5000`, `capacityOf` (2 for `pair`),
  `JOIN_CODE_TTL` (15 min), `CONNECT_TOKEN_TTL` (10 min), `ABANDONED_AFTER_MS` (90 days), `JOINED_SCAN = 500`,
  `SWEEP_RPC_BUDGET = 300`, `HOST_MEMBER_ID = "m_host"`, `WAKES_PER_HOUR = 8`.
- The Durable Object implementation (`SessionDO`, `RegistryDO`, `AuditDO`, `DurableObjectStore`) is in
  [../workerd/EGM.md](../workerd/EGM.md): a file the Node program cannot compile lives there, so the second
  `BellmanStore` sits outside this directory.
- Storage layout helpers, all runtime-free so vitest can test them: `[src/storage/stored-session.ts:hydrateStoredSession]`
  (defaults and legacy-field migration for a `SessionDO` row), `[src/storage/member-rows.ts:memberRows]` (per-member rows
  `mb:`, `mu:`, `lb:`, `bf:`), `[src/storage/idempotency.ts:idempotencyKey]` (`ik:<member>:<key>`) and `fingerprint`,
  `[src/storage/outbox.ts:OutboxDriver]` (durable cross-object delivery and named-alarm bookkeeping), and
  `[src/storage/grant-index.ts]` (the registry's grant, org, SCIM and invite key layout).

## Invariants

- Every `BellmanStore` method is async `[src/storage/store.ts:BellmanStore]`; reads return detached copies
  (`structuredClone` in `[src/storage/store.ts:detach]`, applied to `MemoryStore` reads and writes).
- Read and register in one turn. `[src/workerd/session-do.ts:SessionDO.waitForEvents]` awaits the event read, then pushes its
  waiter onto `this.waiters` synchronously; `[src/storage/memory-store.ts:MemoryStore.waitForEvents]` is not `async`, so its read
  and registration share one synchronous turn. `[src/workerd/session-do.ts:SessionDO.fetch]` (the `/ws` upgrade) does every
  storage read first and then serializes the attachment, accepts the socket and sends the replay with no await
  between.
- A seat is claimed in one operation. `[src/workerd/session-do.ts:SessionDO.seatMember]` and `[src/storage/memory-store.ts:MemoryStore.seatMember]`
  refuse in the order not_found, closed, frozen, banned, full (a banned account never learns the room is full),
  reclaim stale seats only when that frees enough (`[src/storage/store.ts:seatVictims]` returns `null` rather than reaping
  partly), seat the joiner, and retire temporary codes when the room fills, all in one transaction or one
  synchronous stretch. Permanent codes stay (ADR 0020).
- A member is removed only by an authorized call: `[src/storage/store.ts:RemovalRequest]` carries `byUserId`, and
  `removeMember` refuses `forbidden` when it is not the creator; `[src/rooms.ts:evictMember]` checks the creator before
  the target lookup and refuses self-eviction. `[src/storage/store.ts:markRemoved]` writes `leftAt` and `removedAtCursor`
  together and never moves an existing cut.
- Appends are single-unit: `[src/workerd/session-do.ts:SessionDO.nextCursor]` reads the cursor inside the caller's transaction so
  two appends cannot take one `e:` key (#120); `appendEventOnce`, `appendSurface(s)`, `approveProposal` and
  `appendHostEvent` check the idempotency key before the frozen check, and a refusal writes nothing, the key
  record included.
- A decision is decided in the transaction that writes it: `[src/workerd/session-do.ts:SessionDO.openDecision]` checks the quotas
  (`decideOpenQuota`) after the idempotency key, snapshots the electorate, and writes the `expired` close of every
  decision past its deadline after its own events; `castVote` decides through `applyVote` from the decision read in
  that transaction, so no vote lands after a closing event. `[src/workerd/session-do.ts:SessionDO.#writeDecision]` keeps the
  `openDecisions` book and queues each event's org rows (`decisionAudit`) through the outbox in the same put.
- A removal that records a member out also voids that seat's votes on every unclosed decision and writes the close
  that leaves due (`[src/decision.ts:removalEvents]`), after the departure and in the same transaction
  (`[src/workerd/session-do.ts:SessionDO.removeMember]`); a removal never passes a decision, and a rejoin restores neither the
  seat nor its vote (`[src/decision.ts:applyVote]`). A `SessionDO` record whose decisions opened before the book existed has no
  book, so those decisions are not voided.
- A surface batch is all or nothing at consecutive cursors (`[src/storage/store.ts:placeSurfaceBatch]`, decided in memory
  before either store writes); frame writes through `appendEvent` throw `FRAME_WRITE_PATH`.
- Presence is derived, never stored: `[src/presence.ts:presenceOf]` reads `leftAt`, `lastSeenAt` and live sockets;
  `[src/heartbeat.ts:snapshotOf]` must carry no `present`, `status`, `alive` or `healthy` key. `activeMembers` and
  `seatedMembers` in `[src/rooms.ts]` are two readings and stay separate.
- `[src/storage/store.ts:isAbandoned]` closes a room only past 90 days of no person seen and only when no active member holds a
  socket; `[src/workerd/session-do.ts:SessionDO.#closeIfAbandoned]` stamps `lastSeenAt` instead when a socket vouches.

## Verification

- Run: `npm test`. `tests/helpers/store-contract.ts` is the conformance suite every `BellmanStore` must pass,
  run against `MemoryStore` here and against `DurableObjectStore` in workerd by `npm run test:worker`.
- Run: `npm run verify` before every commit.
