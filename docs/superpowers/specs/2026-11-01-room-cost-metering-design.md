# Room cost metering (#473)

*   **Author:** mcfearsome
*   **Status:** Proposed
*   **Date:** 2026-11-01

--------------------------------------------------------------------------------

## Overview

The operator needs to know what each room costs to run and what each plan earns, so plan prices can be set from
evidence. This design computes, once a day, two monthly figures:

*   **Each room's cost** at published Cloudflare and Anthropic rates, broken down by cost driver.
*   **Each plan's margin**: the plan's list-price revenue for the month minus the cost of every room its accounts
    created.

Cloudflare already measures most of a room's usage per Durable Object and keeps it for 90 days. A daily job reads
those figures, maps each object back to its room, and writes the month's totals into the registry, where they are
kept after Cloudflare's data expires and after the room is deleted. Bellman adds its own measurement only for the
drivers Cloudflare does not report per object.

This is part of epic #477 (operator rooms list and room cost). It supplies the numbers that `GET /operator/rooms`
(#472) and the dash's rooms page (bellman-sh/dash#94) display, priced by #475's cost function.

## The Problem

Bellman cannot tell what any room costs, or whether any plan earns more than its users cost.

*   **Cloudflare bills the account, not the room.** The invoice shows one total per product. A room held resident by
    one member's long poll all month costs about $4 in Durable Object duration (ADR 0005), and a hosted seat's model
    tokens likely cost more, but nothing shows which rooms those are or which plans they belong to.
*   **Cloudflare's per-object data expires.** Its GraphQL Analytics reports duration, active time, requests, rows
    read and written, and WebSocket messages for each Durable Object, but keeps them for 90 days. A pricing decision
    that compares a plan's cost across a year needs the figures copied somewhere that keeps them.
*   **Revenue history is not kept.** `BillingLedger` (`src/billing/ledger.ts`) holds each customer's current
    subscription state only. An upgrade, cancellation or lapse overwrites the previous state, so last month's
    revenue for a plan cannot be rebuilt. Every month that passes without a snapshot is lost for good.
*   **Plans carry no price in the code.** `ENTITLEMENTS` and `ON_SALE` (`src/auth.ts`) name plans and Stripe lookup
    keys. The prices themselves come from #475.

The proposal: a daily job reads Cloudflare's per-object usage for the `SessionDO` and `HostDO` namespaces, rolls it
into one row per room per month, and attributes each room to its creator's plan (or its org's plan). A separate
snapshot records which plan each paying account held each month. Margin per plan is computed from the two when the
operator reads it.

## Goals

*   **Margin per plan, monthly.** For each plan and month: revenue (plan price times seats, from the plan-month
    snapshot) minus the cost of the rooms created by that plan's accounts. A room with an `orgId` is charged to the
    org's plan. A room whose creator held no paid plan that month falls on a free-plan line. Accounts with a plan
    granted by an operator or a key, without payment, fall on a comped line: cost with no revenue.
*   **Cost per room, monthly, by driver.** Durable Object duration, requests, rows read and written (SQL), storage
    read and write units and deletes (the key-value API, which `SessionDO` uses), and incoming WebSocket messages for
    the room's `SessionDO` and its `HostDO`, taken from Cloudflare per object; hosted-seat
    model tokens, exact, from #474. Each driver is priced by #475's cost function when it is read, so a price change
    reprices past months.
*   **Figures that outlive their sources.** Room-month rows (`cm:`) and plan-month rows (`pm:`) are kept forever,
    including after the room is purged.
*   **The plan-month snapshot starts first.** It is the one input that is lost by waiting, so it ships ahead of
    everything else.
*   **Each number says where it came from.** Every driver is labeled Cloudflare-measured, Bellman-measured or
    estimated, with the month it covers and the date of the price table.
*   **Success check:** for each month, the sum of room costs plus the overhead line equals Cloudflare's namespace
    totals at the same rates, and two runs of the daily job over the same month write identical rows.

## Non-Goals

*   **Amount actually paid.** Revenue is the plan's list price. Coupons, annual discounts and refunds are not seen.
*   **Measuring Durable Object usage inside the room.** No wrapper around storage calls, no residency timer, no
    per-invocation data points. Cloudflare reports these drivers per object; Bellman reads them.
*   **Workers Analytics Engine for this work.** With Cloudflare's per-object data available, #473 no longer depends on
    #452.
*   **Charging registry, auth, audit or Worker costs to rooms.** `RegistryDO`, `AuthDO`, `AuditDO` and the Worker's
    own requests and CPU form one overhead line, computed as Cloudflare's account totals minus the sum of room costs.
*   **Invite email as a room cost.** Invites are sent from an org, not a room (ADR 0036).
*   **Waking rooms to measure them.** The job reads Cloudflare and the registry index; it never calls a room.
*   **Real-time cost.** The figures are as fresh as the last daily run.
*   **The dash page.** This work supplies the stored rows and the operator routes; bellman-sh/dash#94 draws them.

## Open Questions

*   **How does a Cloudflare row map to a room?** Both per-object datasets carry `objectId` and `name`. If `name` holds
    the string passed to `idFromName` (the room id), the mapping needs no computation; otherwise check that
    `objectId` equals `env.SESSION.idFromName(sessionId).toString()`. Test against one known room, for `SessionDO` and
    for `HostDO` (keyed by the room id).
*   **Which field is billed duration?** The periodic dataset has both `duration` and `activeTime`. Confirm the units of
    each and which one Cloudflare's GB-s charge is computed from.
*   **Are sums already corrected for sampling?** Both datasets expose `avg.sampleInterval` and confidence intervals.
    Confirm whether `sum` values are sample-weighted before use.
*   **Does the uncleared long-poll timer extend billed duration?** `waitForEvents` (`src/store-do.ts`) never clears its
    `setTimeout`. Cloudflare's per-object `duration` before and after a fix will show it.
*   **Do joiner-heavy plans look too profitable?** Under creator-pays, a paid account that only joins others' rooms
    carries no cost. If per-plan margins look wrong, compare against a view weighted by `SessionEvent.fromUserId`.

## Critical User Journeys (CUJs)

### CUJ 1: The operator compares plan margins for last month

*   **Given**: The daily job has run since the month ended, and the plan-month snapshot covered that month.
*   **When**: The operator opens the cost summary on the dash for October 2026.
*   **Then**: Each plan shows revenue, the cost of its accounts' rooms by driver, and margin, beside the free-plan,
    comped and overhead lines, all labeled with their sources and the price table's date. The read is in the
    operator audit stream.

### CUJ 2: The operator investigates one costly room

*   **Given**: A room sorts near the top of `/operator/rooms` by this month's cost.
*   **When**: The operator opens the room's detail.
*   **Then**: The detail shows the room's cost by driver and by month, the plan it is charged to, and when the job
    last ran. No briefs, messages or surface content appear, and the read is audited.

### CUJ 3: A room is purged

*   **Given**: A room with three months of `cm:` rows reaches its retention limit and is purged.
*   **When**: The operator reads lifetime cost for its creator's plan.
*   **Then**: The purged room's months still count, shown under the room's id because its name is gone.

## Technical Plan (Architecture)

Four parts. Three run inside a new daily job; one runs inside each room.

```text
                         daily cron (scheduled handler, src/worker.ts)
                                        |
        +-------------------------------+--------------------------------+
        |                               |                                |
        v                               v                                v
 Cloudflare GraphQL              RegistryDO (singleton)            RegistryDO
 per-object usage,               room index      -> object ids     gr: grants, orgs
 current + previous month        ru: room size levels              -> pm:<month>:<key>
        |                               |                          (plan-month snapshot)
        +---------------+---------------+
                        v
           cost-rollup reducer (runtime-free)
                        |
                        v
     RegistryDO  cm:<month>:<sessionId>  (one row per room per month, quantities only)
                 cx:<month>              (namespace and Worker totals, for overhead)

 SessionDO, after a committed append, at most once a day:
     reportRoomUsage(sessionId, databaseBytes, blobBytes)  -->  RegistryDO ru:<sessionId>

 GET /operator/costs?month=  and  /operator/rooms/:id
     read cm:, cx:, pm:  ->  #475 cost function and plan prices  ->  margin per plan, cost per room
```

### 1. Usage from Cloudflare, per object

The job queries Cloudflare's GraphQL Analytics (`viewer.accounts(accountTag)`) for the current UTC month to date and
the whole previous month. Each query covers at most one month, inside the 32-day `maxDuration` and the 90-day
`notOlderThan` the account reported.

*   **`durableObjectsPeriodicGroups`**, grouped by `objectId`: `sum { duration, activeTime, cpuTime, rowsRead,
    rowsWritten, storageReadUnits, storageWriteUnits, storageDeletes, inboundWebsocketMsgCount }`.
*   **`durableObjectsInvocationsAdaptiveGroups`**, grouped by `objectId`: `sum { requests }`.
*   **Totals for overhead**: the same two datasets grouped by `namespaceId` with no object dimension, plus
    `durableObjectsSqlStorageGroups` `max { storedBytes }` per namespace and the Worker's own request and CPU totals.
    These go into one `cx:<month>` row.

Results are paged at `maxPageSize` (10,000 rows) with `orderBy: objectId_ASC` and an `objectId_gt` filter carrying the
last id seen. The introspection listed the filter input types but not their fields; if `objectId_gt` is not
accepted, the job pages by splitting the month into day-long windows instead. The job stores the sums exactly as Cloudflare returns them; whether they need weighting by
`avg.sampleInterval` is an open question settled before the first deploy.

### 2. Mapping objects to rooms

Object ids are computed, not stored. The job pages through the registry's room index (every room,
`RegistryDO.listRoomsPage`), only ever through that method, never by listing `rm:` keys. The operator
rooms design (dash `docs/superpowers/specs/2026-11-01-operator-rooms-design.md`, its PR 2) moves the index from `rm:`
rows into a SQLite `rooms` table and keeps `listRoomsPage`'s signature. A direct `rm:` list would then return nothing,
and every object would fall to overhead without an error; item 24a guards this. For each room the job computes `env.SESSION.idFromName(sessionId)` and
`env.HOST.idFromName(sessionId)`. `idFromName` is a local hash with no network call. A Cloudflare row whose `objectId` matches a room's
`SessionDO` id is that room's room usage; one matching its `HostDO` id is that room's hosted-seat usage. A row
matching nothing (the registry, auth, audit objects, and any object not in the index) is not attributed and is
left to overhead.

This needs no namespace ids in configuration: ids are namespace-specific, so a `SessionDO` id never collides with a
`HostDO` id for the same room.

### 3. Storage reported by the room

Cloudflare reports stored bytes per namespace only, and R2 bytes live in the room's own `blobBytes` count. So each
room reports its two storage levels.

*   **When.** After any append that commits (`appendEvent`, `appendEventOnce`, `appendHostEvent`, `appendSurface`,
    `appendSurfaces`) and after a blob charge or credit, if the last report was more than 24 hours ago. The time of
    the last report is a field on the room's stored session record, which every one of those transactions already
    writes, so the check adds no storage operation.
*   **What.** `{ sessionId, databaseBytes: ctx.storage.sql.databaseSize, blobBytes, at }`, sent to a new
    `RegistryDO.reportRoomUsage`, which overwrites `ru:<sessionId>`.
*   **How it is sent.** Directly, after the transaction commits, not through the outbox, and the caller's reply
    does not wait for it. A failure is logged and dropped. Sizes are levels: the next report replaces the last, so
    a lost one only leaves the value a day staler. The outbox would be wrong here: it delivers in order and an
    undeliverable row holds every row behind it (`SessionDO.#deliver` throws on an unknown kind), so a deploy lag
    (#361) or a rollback would delay join codes and audit entries behind a size report.
*   **Rooms that never report.** A room that has not written since this ships has no `ru:` row. Its bytes stay in
    the namespace total, so they land in overhead by subtraction.
*   **The purge.** `RegistryDO.dropRoomIndex` deletes `ru:<sessionId>` with the index rows, so a purged room stops
    accruing storage.

R2 operations are not counted per room. Downloads run in the Worker (`src/http/rooms.ts`, `src/http/public.ts`), and
recording each one per room would cost a row write (about $1 per million) to count an operation that costs about
$0.36 per million. Uploads are rarer still. R2 operations stay in overhead, taken from the account's R2 totals.

### 4. Room-month rows

The runtime-free reducer turns the Cloudflare rows, the room map and the `ru:` levels into one row per room per
month:

```text
cm:<YYYY-MM>:<sessionId> = {
  room:   { duration, activeTime, cpuTime, requests, rowsRead, rowsWritten,
            storageReadUnits, storageWriteUnits, storageDeletes, inboundWebsocketMsgs },   // SessionDO
  host:   { duration, requests, rowsRead, rowsWritten, ... },                              // HostDO
  tokens: { input, output, cacheRead, cacheWrite } | null,                                 // from #474
  databaseByteDays, blobByteDays, storageThroughDay,
  chargedTo: { kind: "org" | "account", key },   // fixed when the row is first written
  sources: { cloudflare: true, storage: "reported" | "none", tokens: "metered" | "none" },
  version: 1, writtenAt
}
```

*   **Cloudflare fields are replaced on every run** with the month's current sums, so a rerun writes the same values.
*   **Storage accrues with a watermark.** Each run adds `bytes x (today - storageThroughDay)` days and moves the
    watermark to today, inside the same registry transaction that reads the row. A second run on the same day adds
    zero days; a missed day is filled at the next run from the last known level. Closed rooms keep accruing until
    the purge, because they still store bytes.
*   **Months older than the previous one are never rewritten**, so a late run cannot overwrite good totals with the
    shorter sums left in Cloudflare's 90-day window.
*   **Quantities, not dollars.** Pricing happens at read time, so a new price table reprices every past month.
*   **Writes go in batches** to a new `RegistryDO.putCostMonths(rows)`. Only rooms with usage or a storage level in
    that month get a row.

### 5. The plan-month snapshot

Each run calls a new `RegistryDO.snapshotPlans(month)`, which reads every `gr:` grant and every org record inside one
registry transaction and writes `pm:<YYYY-MM>:<grantKey>` with `{ plan, source, orgId, seats, expiresAt }`. Expired
grants are skipped. The current month's rows are overwritten on every run, so the last run of a month records the
plan in force at month end. Earlier months are never touched.

*   **Paid or comped.** `source: "purchase"` is paid. Any other source (operator grants) is comped. Accounts on a
    plan through `BELLMAN_KEYS` have no grant; the job, which can read the Worker's environment, adds them as
    comped.
*   **This ships first, alone**, since every month without it loses its revenue side.

### 6. Attribution and margin, at read time

A room is charged to `chargedTo`: its `orgId` if it has one, otherwise `grantKeyForUser(createdBy)`. It is set when
the room's first `cm:` row is written and copied forward, so a room keeps its owner across months.

For a month, margin per plan is computed from the `cm:`, `pm:` and `cx:` rows:

*   **Revenue** for a plan = the sum over its paid `pm:` rows of #475's plan price times seats.
*   **Cost** for a plan = the sum, over rooms whose `chargedTo` held that plan in that month's `pm:` rows, of #475's
    cost function applied to the room's quantities.
*   **Free-plan line**: rooms whose `chargedTo` has no `pm:` row. **Comped line**: rooms charged to comped rows.
*   **Overhead** = the `cx:` totals priced the same way, minus the sum of every room's cost. A negative value means
    the attribution counted something twice and is shown as an error, not hidden.

`GET /operator/costs?month=YYYY-MM` returns that table. `GET /operator/rooms/:id` (#472) gains the room's `cm:`
rows priced per driver, its `chargedTo` and the job's last run time. Both sit behind `BELLMAN_OPERATORS` and append
to `OPERATOR_AUDIT_STREAM`, as #472's routes do.

### 7. The job

*   **Trigger.** `[triggers] crons` in `wrangler.toml`, once a day, and a `scheduled` export in `src/worker.ts`.
*   **Order.** Snapshot plans, read the room index, query Cloudflare, read `ru:` levels, reduce, write `cm:` and `cx:`,
    write a `cost:last-run` row with the time and counts.
*   **Secrets.** `CF_ANALYTICS_TOKEN` (Account Analytics: Read) and `CF_ACCOUNT_ID`. If either is missing, the job
    still writes the plan snapshot, logs that it skipped the usage half, and writes nothing else.
*   **Failure.** A failed run writes nothing partial for that month's Cloudflare fields: rows are written only after
    every page is read. The next day's run covers it; a cron run that fails is not retried.

### Data sizes

The registry singleton gains one `cm:` row per active room per month, one `pm:` row per grant per month, and one
`ru:` row per room. At 10,000 rooms that is about 20,000 row writes a day (two months recomputed), about $0.60 a
month. The cost summary route reads every `cm:` row of one month per request, which is fine at that size and is the
first thing to cache if the room count grows by ten times.

## Alternatives Considered

### Alternative A: Measure usage inside the room (the original #473 design)

A counting wrapper around `SessionDO`'s storage and methods, a residency timer for active time, and one Workers
Analytics Engine point per invocation.

*   **Pros**: Works without a Cloudflare API token; data arrives within seconds.
*   **Cons**: Summing per-invocation wall time counts a room's resident time once per overlapping long poll, so the
    busiest rooms are overstated most. `SessionDO` has no `sql.exec` call, so row counts would be inferred. About 65
    to 80 RPC methods and three entry paths need covering. Analytics Engine samples heavily written indexes and
    costs more per point than the requests it would count.
*   **Reason for Rejection**: Step zero showed `durableObjectsPeriodicGroups` reports duration, active time, rows and
    WebSocket messages per `objectId`. Cloudflare's numbers are the ones it bills from.

### Alternative B: Split plan revenue by each member's written activity

*   **Pros**: A paid account that only joins others' rooms would carry part of their cost.
*   **Cons**: The formula has two readings; hosted rooms show the largest losses because the host writes and has no
    account; a room's margin moves when its members get busier elsewhere; account ids would have to travel with
    usage records. Pricing needs margin per plan, which creator-pays gives directly.
*   **Reason for Rejection**: Owner chose creator-pays (2026-11-01). The activity-weighted view stays available from
    `SessionEvent.fromUserId` as a check.

### Alternative C: Room storage reported through the outbox

*   **Pros**: A report queued in the write's own transaction is never lost.
*   **Cons**: The outbox delivers in order and holds every row behind one it cannot deliver. A deploy lag on the new
    `RegistryDO` method (#361), or a rollback past the deploy that added the intent kind, would hold join codes and
    audit entries behind a size report.
*   **Reason for Rejection**: Sizes are levels. A lost report is replaced by the next one, so durable delivery buys
    nothing and risks the rows that need it.

### Alternative D: Stored bytes left in overhead, or apportioned by rows written

*   **Pros**: No room code.
*   **Cons**: Overhead hides rooms that hold most of the bytes. Apportioning by rows written is wrong for rooms that
    wrote little but store much (large uploads, old long-lived rooms).
*   **Reason for Rejection**: Owner chose room-reported storage.

### Alternative E: R2 operations counted per room in the Worker

*   **Pros**: R2 cost per room would be complete.
*   **Cons**: Each counted download needs a row write somewhere, about $1 per million, to record an operation that
    costs about $0.36 per million.
*   **Reason for Rejection**: The meter would cost more than what it measures. R2 operations stay in overhead.

### Alternative F: A `due:` handler on `RegistryDO.alarm` instead of a cron trigger

*   **Pros**: No `[triggers]` entry; reuses the registry's alarm machinery.
*   **Cons**: A new saved alarm name fires repeatedly on a build without its branch after a rollback, as the
    `SessionDO.alarm` comment warns.
*   **Reason for Rejection**: A daily cron has no rollback hazard, and a failed run is covered the next day.

### Alternative G: A daily alarm in every room to sample its size

*   **Pros**: Every room's size is known, including rooms that never write.
*   **Cons**: Wakes idle rooms, which is a cost in itself, and adds a saved alarm name with the same rollback hazard.
    The only rooms it would add are ones that have not written since this ships, whose size changes little.
*   **Reason for Rejection**: Waking rooms to measure them is a non-goal.

### Alternative J: Room-kept monthly counters delivered to the registry

Each room counts its own usage per month and hands the totals to the registry through the outbox.

*   **Pros**: Exact for what the room counts; no API token, no cron.
*   **Cons**: Has the same in-process measurement problems as Alternative A and the same delivery hazard as
    Alternative C.
*   **Reason for Rejection**: Cloudflare already counts the same drivers per object.

### Alternative H: Log export only

A week of Workers Logs (`$workers.durableObjectId`, wall time) exported by hand and priced offline.

*   **Pros**: No code at all; good for a first look.
*   **Cons**: Logs are kept for days and exported by hand, so they cannot feed a monthly view.
*   **Reason for Rejection**: GraphQL gives the same per-object figures for 90 days through an API.

### Alternative I: Invite email as a room cost

*   **Pros**: Every outbound cost would sit on a room.

*   **Reason for Rejection**: Invites are sent from an org through `POST /org/members`, not from a room (ADR 0036).

--------------------------------------------------------------------------------

## Non-Functional Requirements

*   **Security & Privacy.** `CF_ANALYTICS_TOKEN` is read-only (Account Analytics: Read), a Worker secret, used only
    by the scheduled handler, and never returned by any route. No `cm:`, `pm:`, `ru:` or `cx:` row holds content,
    room names, labels or emails: only room ids, grant keys, org ids and numbers. Cost routes sit behind
    `BELLMAN_OPERATORS` and every read is audited.
*   **Performance.** The job never wakes a room. Room-side cost is one `databaseSize` read and one registry call per
    room per day at most, off the reply path.
*   **Rollout & Rollback.** Each part ships alone (see Delivery order). The registry methods ship a deploy ahead of
    the room code that calls them (#361). Rolling back the room code only stops reports; rolling back the job
    leaves the rows it wrote, which nothing else reads.

## Detailed Implementation Plan

### Delivery order

Each step is one PR on its own branch, merged and deployed before the next unless marked independent.

1.  **Clear the long-poll timer** (independent, any time). Small and harmless either way.
2.  **Plan-month snapshot + daily cron** (first, now). Starts the only record lost by waiting.
3.  **Pre-checks for the rollup** (no code, done by hand with the step-zero token). Settles the three open
    GraphQL questions before step 5 is written:
    *   Query `durableObjectsPeriodicGroups` grouped by `objectId` and `name` for one day; check that `name` is the
        room id, or that `objectId` equals `SESSION.idFromName(<a known room id>).toString()`, for one room and its
        `HostDO`.
    *   Compare `sum.duration` and `sum.activeTime` for that room with its Workers Logs wall time for the same hour,
        and read Cloudflare's billing docs for which one GB-s is computed from.
    *   Run the same query with `filter: { objectId_gt: "<id>" }` and `orderBy: [objectId_ASC]`; check that it is
        accepted, and whether `avg.sampleInterval` is above 1 for rooms with few requests.
    *   Record the answers on #473 before step 5 starts.
4.  **Registry storage levels, then room reports** (two PRs, a deploy apart). The `RegistryDO` method first, the
    `SessionDO` caller second.
5.  **Cloudflare usage rollup** (after step 3). Writes `cm:` and `cx:` rows.
6.  **Margin and operator routes** (after #475 lands its price table and cost function).
7.  **Issue bookkeeping** (with step 5): edit #473's body to this design; edit #477 to drop #452 as a dependency of
    #473; reduce #476 to the coverage display, since per-object data and the overhead line now come from this work.

### Target Files to Create/Modify

#### Step 1: the long-poll timer

##### 1. `src/store-do.ts` (Modify)

*   **Type / Scope**: Workers module, `SessionDO`.
*   **Proposed Changes**: The `Waiter` type gains the timer handle returned by `setTimeout` in `waitForEvents`. Every
    place a waiter is resolved early (the wake path that answers polls, and close) calls `clearTimeout` on it. The
    read-then-register order in `waitForEvents` is unchanged: the handle is stored on the waiter object after the
    synchronous push, with no await between.

##### 2. `worker-tests/session-append-race.test.ts` or a new `worker-tests/poll-timer.test.ts` (Modify or Create)

*   **Type / Scope**: workerd test.
*   **Proposed Changes**: A poll answered early leaves no pending timer: after the answer, advancing past the wait
    does not resolve anything twice and the waiter list is empty. The existing race test must still pass.

#### Step 2: plan-month snapshot and the cron

##### 3. `src/cost/plan-snapshot.ts` (Create)

*   **Type / Scope**: runtime-free module.
*   **Proposed Changes**: `planMonthRows(month, grants, orgs, keyedPlans, now)` returns the `pm:` rows for a month:
    one per unexpired grant, keyed by grant key, with `{ plan, source, paid: source === "purchase", orgId, seats,
    expiresAt }`. Seats come from the org record for org-scoped grants and are 1 otherwise. `keyedPlans` are the
    plans `BELLMAN_KEYS` grants, added as comped. `monthOf(epochMs)` returns `YYYY-MM` in UTC.

##### 4. `src/cost/EGM.md` (Create)

*   **Type / Scope**: directory contract.
*   **Proposed Changes**: Interface, invariants and side effects for every file in `src/cost/`, with
    `[file:symbol]` citations, written as each step lands. Invariants: no row holds content, names, labels or
    emails; only the current and previous month are ever written; `pm:` and `cm:` rows are never deleted.

##### 5. `src/store.ts` (Modify)

*   **Type / Scope**: `BellmanStore` interface and `MemoryStore`.
*   **Proposed Changes**: `snapshotPlans(month, keyedPlans): Promise<number>` reads every grant and org and writes
    that month's `pm:` rows in one step, returning the count; `planMonths(month): Promise<PlanMonthRow[]>`;
    `putCostLastRun(row)` and `costLastRun()`. `MemoryStore` implements each with a `Map`.

##### 6. `src/store-do.ts` (Modify)

*   **Type / Scope**: `RegistryDO` and `DurableObjectStore`.
*   **Proposed Changes**: `RegistryDO.snapshotPlans` lists `gr:` and org rows and writes `pm:<month>:<grantKey>` rows
    in one transaction, through `planMonthRows`. `planMonths` lists by prefix. `DurableObjectStore` delegates both.

##### 7. `src/worker.ts` (Modify)

*   **Type / Scope**: Worker entry.
*   **Proposed Changes**: The default export gains `scheduled(controller, env, ctx)`, which calls `runCostJob` (step
    5) or, in this step, only the snapshot and `putCostLastRun`. `WorkerEnv` gains optional `CF_ANALYTICS_TOKEN` and
    `CF_ACCOUNT_ID`.

##### 8. `src/cost/job.ts` (Create)

*   **Type / Scope**: runtime-free orchestrator taking a `BellmanStore`, an env slice and a `fetch`.
*   **Proposed Changes**: `runCostJob(deps, now)`. In this step: snapshot the current month, write the last-run row.
    Step 5 adds the usage half.

##### 9. `wrangler.toml` (Modify)

*   **Type / Scope**: deploy configuration.
*   **Proposed Changes**: `[triggers] crons = ["17 3 * * *"]` (once a day, off the hour).

##### 10. `tests/plan-snapshot.test.ts` (Create)

*   **Type / Scope**: vitest.
*   **Proposed Changes**: Purchase grants are paid and operator grants comped; expired grants are skipped; org seats
    are read from the org; keyed plans appear as comped; no row carries a field outside the declared shape.

##### 11. `tests/helpers/store-contract.ts` (Modify)

*   **Type / Scope**: store conformance suite.
*   **Proposed Changes**: `snapshotPlans` twice in a month gives identical rows; a grant deleted mid-month is gone
    from the current month after the next snapshot and still present in the previous month's rows.

##### 12. `tests/cost-job.test.ts` (Create)

*   **Type / Scope**: vitest over `MemoryStore`.
*   **Proposed Changes**: With no Cloudflare secrets the job writes the snapshot and the last-run row and nothing
    else, and logs that it skipped the usage half.

#### Step 4: storage levels

##### 13. `src/store.ts` (Modify)

*   **Type / Scope**: `BellmanStore`, `MemoryStore`, and a runtime-free rule.
*   **Proposed Changes**: `reportRoomUsage({ sessionId, databaseBytes, blobBytes, at })` overwrites the room's level;
    `roomUsagePage(limit, after?)` lists levels; `dropRoomIndex` also deletes the level.
    `USAGE_REPORT_INTERVAL_MS = 24 h` and `usageReportDue(lastAt, now)`.

##### 14. `src/store-do.ts` (Modify, first PR)

*   **Type / Scope**: `RegistryDO`, `DurableObjectStore`.
*   **Proposed Changes**: `RegistryDO.reportRoomUsage` puts `ru:<sessionId>`; `roomUsagePage` lists `ru:`;
    `dropRoomIndex` deletes `ru:<sessionId>` in its existing transaction.

##### 15. `src/stored-session.ts` (Modify, second PR)

*   **Type / Scope**: stored record type.
*   **Proposed Changes**: Optional `usageReportedAt?: number`. Absent on old records, which reads as due.

##### 16. `src/store-do.ts` (Modify, second PR)

*   **Type / Scope**: `SessionDO`.
*   **Proposed Changes**: In `appendEvent`, `appendEventOnce`, `appendHostEvent`, `appendSurface`, `appendSurfaces`
    and the blob charge and credit paths: when `usageReportDue(s.usageReportedAt, now)`, set `usageReportedAt` in the
    record the transaction already writes. After the transaction commits, call the registry's `reportRoomUsage` with
    `ctx.storage.sql.databaseSize` and the record's `blobBytes`, without awaiting it in the reply path and with a
    `.catch` that logs. One private helper does both halves so the seven sites stay one line each.

##### 17. `worker-tests/room-usage-report.test.ts` (Create)

*   **Type / Scope**: workerd test.
*   **Proposed Changes**: The first append reports; a second append within 24 h does not; a registry that throws
    leaves the append committed and its reply unchanged; a purged room's level is gone.

##### 18. `tests/helpers/store-contract.ts` (Modify)

*   **Type / Scope**: store conformance suite.
*   **Proposed Changes**: A report overwrites, never adds; `dropRoomIndex` removes the level.

#### Step 5: the usage rollup

##### 19. `src/cost/graphql.ts` (Create)

*   **Type / Scope**: runtime-free module.
*   **Proposed Changes**: `usageQuery(accountTag, from, to, afterObjectId?)` builds the two per-object queries and
    the namespace totals query from section 1 of the Technical Plan; `parseUsage(json)` returns typed rows or a
    refusal carrying Cloudflare's error text. Field names live in one place.

##### 20. `src/cost/rollup.ts` (Create)

*   **Type / Scope**: runtime-free module.
*   **Proposed Changes**: The `CostMonthRow` type with `version: 1`; `reduceMonth(month, usageRows, rooms,
    levels, existing, today)` returns the `cm:` rows. Cloudflare fields replaced, storage accrued with the
    `storageThroughDay` watermark, `chargedTo` kept from `existing` or set from `orgId` / `grantKeyForUser(createdBy)`.
    Rows only for rooms with usage or a level. `objectIdsFor(sessionId)` takes the two `idFromName` functions as
    arguments so the module stays runtime-free.

##### 21. `src/cost/job.ts` (Modify)

*   **Type / Scope**: orchestrator.
*   **Proposed Changes**: The usage half: for the current and previous month, page Cloudflare, page the room index through `listRoomsPage` and `ru:`,
    reduce, write `cm:` in batches and `cx:`; write rows only after every page is read; refuse to write any month
    older than the previous one.

##### 22. `src/store.ts` and `src/store-do.ts` (Modify)

*   **Type / Scope**: `BellmanStore`, `MemoryStore`, `RegistryDO`, `DurableObjectStore`.
*   **Proposed Changes**: `putCostMonths(rows)` (one transaction per batch, reading the existing row for the storage
    watermark), `costMonths(month, limit, after?)`, `costMonthsForRoom(sessionId)`, `putCostTotals(month, row)`,
    `costTotals(month)`.

##### 23. `tests/cost-rollup.test.ts`, `tests/cost-graphql.test.ts` (Create)

*   **Type / Scope**: vitest.
*   **Proposed Changes**: A fixture of Cloudflare rows for three rooms, a registry object and a `HostDO`; the reducer
    attributes each correctly and leaves the registry row unattributed; a rerun on the same day gives identical rows;
    a two-day gap accrues two days at the last level; an org room is charged to its org; `chargedTo` survives across
    months; parsing a Cloudflare error returns a refusal, not a throw.

##### 24. `tests/cost-job.test.ts` (Modify)

*   **Type / Scope**: vitest with a fake `fetch`.
*   **Proposed Changes**: Paging follows `objectId_gt`; a failure on page two writes nothing; the month two back is
    never written; no request body or stored row carries anything but ids and numbers.

##### 24a. `worker-tests/cost-job-room-index.test.ts` (Create)

*   **Type / Scope**: Worker test in the Durable Object runtime, so it reads the real `RegistryDO` index.
*   **Proposed Changes**: Create a room, then run the usage job with a fake Cloudflare answer that has a row for that
    room's `SessionDO` id (`env.SESSION.idFromName(sessionId)`). The month's `cm:` row for the room carries the usage,
    and overhead does not. The test must pass whichever of this PR and the operator rooms PR 2 merges second: before
    PR 2 the index is `rm:`, after it the `rooms` table, and the job reaches both only through `listRoomsPage`. A job
    that lists `rm:` keys directly fails this test once PR 2 is in.

#### Step 6: margin and routes

##### 25. `src/cost/margin.ts` (Create)

*   **Type / Scope**: runtime-free module.
*   **Proposed Changes**: `marginByPlan(cmRows, pmRows, cxRow, prices)` returns per-plan revenue, cost by driver and
    margin, plus the free-plan, comped and overhead lines. Takes #475's cost function and plan prices as arguments.
    A negative overhead is returned as an error field.

##### 26. `src/http/operator-costs.ts` (Create)

*   **Type / Scope**: HTTP route.
*   **Proposed Changes**: `GET /operator/costs?month=YYYY-MM` returns `marginByPlan`'s table, the price table's date,
    each driver's source, and the job's last run. Refuses a malformed month (400). Appends
    `operator_costs_read` to `OPERATOR_AUDIT_STREAM`.

##### 27. `src/http/stats.ts` (Modify)

*   **Type / Scope**: operator route dispatch.
*   **Proposed Changes**: Routes `/operator/costs` beside `/operator/rooms`, on the same `BELLMAN_OPERATORS` gate.

##### 28. `src/http/operator-rooms.ts` (Modify)

*   **Type / Scope**: HTTP route.
*   **Proposed Changes**: The room detail adds `cost`: its `cm:` rows priced per driver, `chargedTo`, and the job's
    last run. The list adds this month's cost per row from the current month's `cm:` rows, for sorting on the dash.

##### 29. `tests/cost-margin.test.ts`, `tests/operator-costs.test.ts`, `tests/operator-rooms.test.ts` (Create, Create, Modify)

*   **Type / Scope**: vitest.
*   **Proposed Changes**: Room totals plus overhead equal the `cx:` total; free-plan and comped lines are separate;
    a non-operator gets 404 as #472's routes do; every read appends one audit entry; no response field holds a
    brief, message or surface content.

#### Documentation (with the step that changes each)

##### 30. `docs/ARCHITECTURE.md` (Modify)

*   **Proposed Changes**: The registry's new prefixes (`pm:`, `ru:`, `cm:`, `cx:`, `cost:last-run`); the cron as a
    new entry point; the analytics token as a new secret and trust boundary; the room-to-registry report as a
    non-durable cross-object write and why it is not on the outbox.

##### 31. `src/EGM.md`, `src/http/EGM.md` (Modify)

*   **Proposed Changes**: `src/EGM.md`: the new `BellmanStore` methods, `BellmanEnv`/`WorkerEnv` secrets, the purge
    deleting `ru:`, the `scheduled` handler under Side Effects. `src/http/EGM.md`: the `/operator/costs` route and the
    detail's new field.

##### 32. `docs/adr/NNNN-room-cost-from-cloudflare.md` (Create, with step 5)

*   **Proposed Changes**: The decision to read Cloudflare's per-object usage instead of metering in-process, to charge
    rooms to their creator's plan, and to send storage levels outside the outbox. Number it against `origin/main`,
    every open PR and every local branch when the PR opens.

### Verification Plan

*   **Build and types**: `npm run verify` and `npm run typecheck:worker` on every PR.
*   **Unit and contract tests**: the vitest files above, plus `tests/helpers/store-contract.ts` for each new
    `BellmanStore` method; `worker-tests/` for the poll timer and room reports.
*   **Deploy path**: `npx wrangler deploy --dry-run` before merging steps 2, 4 and 5 (a new cron trigger and new
    registry methods), then read the main deploy run after merge.
*   **Scheduled handler locally**: `npx wrangler dev --test-scheduled` and `curl "http://localhost:8787/__scheduled?cron=17+3+*+*+*"`;
    the `pm:` rows and last-run row appear.
*   **After the step 5 deploy**: for one known room, the `cm:` row's `duration` and `requests` match a hand-run
    GraphQL query for the same month; a second run on the same day leaves every row byte-identical; the sum of room
    rows plus unattributed objects equals the namespace totals in `cx:`.
*   **After the step 6 deploy**: `/operator/costs` for the current month returns a table whose room costs plus overhead
    equal the priced `cx:` total, and the read appears in the operator audit stream.

--------------------------------------------------------------------------------

*Drafted with EGM*
