# workerd

## Overview

Everything that runs only inside workerd: the Workers entry and the six Durable Object classes. A file belongs here
when it imports `cloudflare:workers` or Workers-only types, or a file here, so the Node program cannot compile it:
`tsconfig.json` and `tsconfig.test.json` exclude this directory, `tsconfig.worker.json` checks it, and no root vitest
test imports it except over a stubbed `cloudflare:workers` (`tests/store-do-wiring.test.ts`, `tests/worker-ws.test.ts`,
`tests/hosted-seat-wiring.test.ts`). The rules these files apply live in the runtime-free modules of `src/`, shared
with `MemoryStore` and the Node server; what is here is storage layout, transactions, alarms and RPC between objects.

## Interface

### Entry

- `[src/workerd/worker.ts:fetch]` the Workers entry. Dispatch order: `/stripe/webhook`; `/rooms[/*]` (moderation routes, then
  room routes); `/public[/*]`; `/presets`, `/scim/v2`, `/audit`, `/org`, `/me/rooms`, `/me/memory`, `/account/handle`,
  `/account/bans`, `/operator/(stats|accounts|rooms|room-counts)` and `/operator/rooms/:id`; `GET /.well-known/agent-card.json`; the server card; OAuth
  routes; `GET /healthz`; `GET /ws`; A2A paths; `POST /mcp`. Anything else is 404.
- `[src/workerd/worker.ts]` re-exports the Durable Object classes `SessionDO`, `RegistryDO`, `AuditDO` `AuthDO`, `HostDO` and `CostDO`
  from the files beside it. `[src/workerd/worker.ts:WorkerEnv]` extends
  `BellmanEnv` with `AUTH`, `BLOBS`, the mail bindings, and the OAuth, operator, panel-origin and Stripe secrets.
- `[src/workerd/worker.ts:resolveCaller]` identity from an OAuth access token minted for the named resource (`/mcp` or
  `/a2a`), else `resolveIdentity` over `BELLMAN_KEYS`.

### Objects

- `[src/workerd/session-do.ts:SessionDO]` one Durable Object per room: the session record (with `openDecisions`, the book of
  unclosed decisions), the `e:` event log, member rows, `sf:` surface rows, the decision index (`dx:` one row per
  decision, `dv:<decision>:<cursor>` a copy of each of its events, `dx-at` the last cursor indexed, written by a
  read in batches of `DECISION_INDEX_BATCH` = 1,000 events and never by an append), `bv:<decision>:<account>` a
  secret ballot's row per voting account (its choice, vote count and idempotency keys, deleted by every close),
  bans, outside tasks and an outbox; `roomSummary` answers the operator's counts; `fetch` is the `/ws` upgrade; `alarm` multiplexes the
  handlers `outbox`, `abandoned`, `heartbeat`, `housekeep`, `purge`, `sweep`, `seat`, `expiry` and `decision` (the
  soonest open decision's deadline, plus a millisecond, derived even for a closed room) through one
  `OutboxDriver`. `REPLAY_LIMIT = 1_000`.
- `[src/workerd/registry-do.ts:RegistryDO]` the singleton: join codes `jc:`, public names `pn:`, connect tokens `pc:`, grants
  `gr:`/`go:`, orgs, IdPs, domains, invites, SCIM users and tokens, created/joined/org room indexes
  (`us:`/`um:`/`uo:`), the operator's index of every room (the SQL table `rooms`, one `RoomIndexRow` a room, indexed
  newest first, by creator and by org; `listRoomsPage`, `listRoomsFiltered`, `roomCounts`, `handlesOf`, `indexRoom`,
  `dropRoomIndex`, `unindexedRooms`; moved from `rm:`/`ri:` by the constructor on wake),
  presets `pr:`, hosted slots `ho:`, handles `uh:`/`hn:`/`hs:`, creator bans `cb:`,
  suspensions, and the report queue (`rp:`, `ro:`, `rf:`, `rl:`, `rc:`, `rr:`) with its `report_purge` alarm.
- `[src/workerd/audit-do.ts:AuditDO]` one per org, plus the platform operator's stream named `OPERATOR_AUDIT_STREAM`
  (`"~operator"`, `[src/grant-index.ts:OPERATOR_AUDIT_STREAM]`, outside every org id's grammar): SQL tables `entries` (hash-chained) and `delivered`, a daily retention
  sweep, and the org's SIEM sink, both on its one alarm.
- `[src/workerd/store-do.ts:DurableObjectStore]` the production facade: `SessionDO` by `idFromName(sessionId)`, `RegistryDO` by
  `idFromName("registry")`, `AuditDO` by `idFromName(orgId)`, each stub wrapped in `reviving`
  (`rpc-error.ts`). `[src/workerd/store-do.ts:BellmanEnv]` names the bindings `SESSION`, `REGISTRY`, `AUDIT`, `HOST`,
  `BLOBS` and the vars `BELLMAN_KEYS`, `BELLMAN_HOSTED_SEAT`, `BELLMAN_HOSTED_SEAT_USERS`,
  `ANTHROPIC_API_KEY`, `MODEL_URL`.
- `[src/workerd/host-do.ts:HostDO]` one Durable Object per hosted seat, keyed by the room's session id: RPC `wake`, `alarm`,
  `forget`.
- `[src/workerd/blobs-r2.ts:R2BlobStore]` the same interface over the `BLOBS` R2 bucket (Workers only).
- `[src/workerd/auth-do.ts:AuthDO]` implements `AuthStorage` (`[src/oauth/storage.ts:AuthStorage]`, whose contract
  is in [../oauth/EGM.md](../oauth/EGM.md)); `[src/workerd/auth-do.ts:AuthStore]` is a facade over the one instance
  named `"auth"` and also implements `BillingStorage`.
- `[src/workerd/cost-do.ts:CostDO]` the room cost capture's one object (#473), `idFromName("cost")`: SQLite tables
  the daily scheduled job writes (`putRooms`, `replaceUsage`, `putBlobs`, `putPlans`, `putRun`) and the operator cost
  routes read (`month`, `roomMonths`, `months`). Implements `CostStore`; the schema and shapes are runtime-free in
  `[src/cost/records.ts]`, so the contract suite holds it and `MemoryCostStore` to the same behaviour.
  `[src/workerd/cost-do.ts:costStore]` is the stub, wrapped in `reviving`.

## Invariants

### The room socket

- `[src/workerd/session-do.ts:SessionDO.fetch]` rechecks `readsClosed` itself (409) although the Worker already asked
  `membersOf` (#133), drops removed member ids (403 when none remain, #113), and refuses with 410 when more than
  `REPLAY_LIMIT` (1,000) events were missed, so the client catches up through `bellman_sync`.
- The room socket is receive-only: `[src/workerd/session-do.ts:SessionDO.webSocketMessage]` closes on any client frame with
  1003. `[src/workerd/worker.ts:fetch]` builds a fresh `Request` for the object carrying only the validated cursor, the
  upgrade header and `x-bellman-members` from `membersOf`; nothing from the caller's request is forwarded.

### Across objects

No transaction spans two Durable Objects; cross-object writes go through the outbox (see [../EGM.md](../EGM.md),
"Across objects").

- `[src/workerd/store-do.ts:DurableObjectStore.createSession]` writes the room first and the registry indexes (`us`, `um`,
  `uo`) after, with no transaction across them; `[src/workerd/store-do.ts:DurableObjectStore.writeIndex]` logs a failed
  index write rather than throwing, and nothing rebuilds a lost `us`, `um` or `uo` row. The operator's room index
  row is written in the same `transactionSync` as the creator's `us:` row (`[src/workerd/registry-do.ts:RegistryDO.indexSession]`);
  a room missing from it is restored by `backfillRoomIndex`, and the purge removes it (`dropRoomIndex`), as does an
  operator list page that finds the room gone. Join codes reach
  the registry through the room's outbox, not the facade.
- `[src/workerd/store-do.ts:DurableObjectStore.getSessionByJoinCode]` treats the registry row as a hint: the room must be open,
  still hold the code, and `codeIsLive` must pass. The public-name index works the same way: claims are
  compare-and-set (`[src/workerd/registry-do.ts:RegistryDO.claimPublicName]`) and `[src/public-names.ts:holdsName]` checks the room
  record.
- `[src/workerd/store-do.ts:DurableObjectStore]` neither retries an RPC nor falls back when a stub lacks a method.
- `[src/workerd/audit-do.ts:AuditDO.append]` dedupes by intent id in the same `transactionSync` as the insert, so outbox
  redelivery files one row; each row's `hash` chains to the previous (`[src/audit-sink.ts:chainHash]`).

### Trust boundaries

- `[src/workerd/worker.ts:routeGate]` refuses a suspended caller with 403 before the room, preset, audit, org and account
  modules; `/public` and `/scim/v2` are not gated there.
- `AuthDO` write helpers are `#private`, because a Durable Object answers RPC for every method and TypeScript
  `private` is erased [src/workerd/auth-do.ts:AuthDO]

## Side Effects

- Durable Object storage. `SessionDO`: `session`, `cursor`, `e:<cursor>`, `sf:<key>`, member rows (`mb:`, `mu:`,
  `lb:`, `bf:`), `ik:` idempotency records, `bn:`/`bu:` bans, `sn:` stranger send counts, `ot:`/`oc:`/`ov`
  outside tasks, the decision index `dx:`/`dv:`/`dx-at`, outbox `ob:`/`ob_seq`/`due:`. `RegistryDO`: the
  prefixes listed under Interface plus its own outbox, and SQL `rooms` (the room index). `AuditDO`: SQL `entries` and `delivered`, KV `sink`, `settings`, `chain_anchor`, `due:sink`,
  `due:sweep`. `HostDO`: `state` and `pending`. Each of the four object types runs on a single alarm.
- Cross-object RPC: `SessionDO` to `RegistryDO` (`putJoinCode`, `dropJoinCode`, `releaseHostedRoom`,
  `putCreatorBan`, index drops on purge, `dropRoomIndex` among them), to `AuditDO.append`, and to `HostDO.wake`/`forget`; `HostDO` back to
  `SessionDO` (`appendHostEvent`, `eventsAfter`, `renewHostAllowance`, `seatSkipped`). The facade calls
  `RegistryDO.indexSession` with the room's `RoomIndexRow` on create, `unindexedRooms` and `indexRoom` on a
  backfill, `SessionDO.roomSummary` per listed room, and the operator's `AuditDO` for `appendOperatorAudit`.
- R2: the `BLOBS` bucket under `rooms/<sessionId>/<blobId>` `[src/workerd/blobs-r2.ts:R2BlobStore]`; a closed room's
  unnamed objects are swept and a purge deletes the prefix `[src/workerd/session-do.ts:SessionDO.#purgeIfDue]`.
- `AuthDO` storage under `client:`, `reg:`, `code:`, `spent:`, `refresh:`, `sess:`, `agentreg:`,
  `agentattempt:`, `agentgrant:`, `agentip:` and cursor keys; billing ledger keys through `BillingLedger`
  [src/workerd/auth-do.ts:AuthDO]
- `AuthDO`'s alarm sweep: armed after a transaction, `purgeStale` re-armed in a `finally`; bounded sweeps of 200
  keys [src/workerd/auth-do.ts:AuthDO.alarm]
- RPC from `AuthDO` to `RegistryDO` (`env.REGISTRY`, `"registry"`) during billing reconcile
  [src/workerd/auth-do.ts:AuthDO.reconcile]

## Verification

- Run: `npm run typecheck:worker` and `npm run test:worker`; `worker-tests/` runs the store contract against
  `DurableObjectStore`, and the auth and cost contracts against `AuthDO` and `CostDO`, in workerd.
- Run: `npm run verify` before every commit.
