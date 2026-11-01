# Room cost metering (#473)

*   **Author:** mcfearsome
*   **Status:** Proposed
*   **Date:** 2026-11-01 (revised after the EGM review the same day)

--------------------------------------------------------------------------------

## Overview

The operator needs to know what each room costs to run and what each plan earns, so plan prices can be set from
evidence. Once a day, a scheduled job records raw facts in a new Durable Object, `CostDO`:

*   each room's Durable Object usage for the current and previous month, as Cloudflare measured it per object;
*   each room's R2 blob bytes, from a listing of the blob bucket;
*   who held which plan that day: each room creator's plan, each org's seats and standing, and a count of individual
    purchase grants.

Nothing is priced or classified when it is written. When the operator reads the cost page, a runtime-free module
applies #475's list prices and the rules below and returns two monthly figures:

*   **each room's cost**, by driver;
*   **each plan's margin**: the plan's list-price revenue, prorated by the days accounts held it, minus the cost of
    the rooms charged to it.

This is part of epic [#477](https://github.com/bellman-sh/bellman/issues/477). It supplies the numbers that the
operator rooms routes ([#472](https://github.com/bellman-sh/bellman/issues/472)) and the dash's rooms page
(bellman-sh/dash#94) display, priced by [#475](https://github.com/bellman-sh/bellman/issues/475)'s cost function.

## The Problem

Bellman cannot tell what any room costs, or whether any plan earns more than its users cost.

*   **Cloudflare bills the account, not the room.** The invoice shows one total per product. A room held resident by
    one member's long poll all month costs about $4 in Durable Object duration
    ([ADR 0005](../../adr/0005-watch-and-delivery-paths.md)), but nothing shows which rooms those are or which plans
    they belong to.
*   **Cloudflare's per-object data expires after 90 days.** Its GraphQL Analytics reports duration, requests and rows
    for each Durable Object, but a year of pricing history needs those figures copied somewhere that keeps them.
*   **Plan membership is not kept by day.** Grants and org records hold only their current state. Which accounts held
    which plan last month, including comped operator grants, `BELLMAN_KEYS` accounts and `BELLMAN_USERS` overrides,
    cannot be rebuilt once it changes. Paid revenue could be rebuilt from Stripe's invoices, but this design uses list
    price (see Alternative B), so it needs the membership record.
*   **Plans carry no price in the code.** `ENTITLEMENTS` and `ON_SALE` (`src/auth.ts`) name plans and Stripe lookup
    keys. Prices come from #475.

## Goals

*   **Margin per plan, monthly.** For each plan and month: revenue prorated by plan-days, minus the cost of the rooms
    charged to that plan. Free-plan, comped and unattributed rooms are their own lines.
*   **Cost per room, monthly, by driver.** Requests, duration, rows read and rows written for the room's `SessionDO`
    and its `HostDO`, as Cloudflare measured them per object, and the room's R2 blob bytes.
*   **Figures that outlive their sources.** Usage and plan records are kept in `CostDO` after Cloudflare's 90 days
    and after the room is purged.
*   **Wrong rules are fixable.** Classification and pricing run at read time over raw records, so a corrected rule or
    a new price table reprices every past month.
*   **Each number names its source and price date.** Every driver carries one of three labels (`cloudflare`, `listing`
    or `not_metered`) and the date of #475's price table.
*   **Success check (can fail):** each month, the rooms' share of Cloudflare's `SessionDO` and `HostDO` namespace
    totals is reported for duration and requests. A share below 95% means objects are going unmatched, and the page
    says so.

## Non-Goals

*   **Amount actually paid.** Revenue is list price. Coupons, annual discounts and refunds are not seen.
*   **Metering inside the room.** No storage wrapper, no residency timer, no room-side reports. Cloudflare and the R2
    listing supply every per-room figure.
*   **Workers Analytics Engine** ([#452](https://github.com/bellman-sh/bellman/issues/452)). Not needed for this work.
*   **An overhead line.** Registry, auth and audit objects, the Worker's own requests and CPU, SQLite storage, R2
    operations and Cloudflare's free allowances are read off the monthly invoice by hand, once a month if needed.
*   **Hosted-seat model tokens.** [#474](https://github.com/bellman-sh/bellman/issues/474) adds them. Until then a
    hosted room's cost carries `tokens: not_metered`.
*   **Invite email as a room cost.** Invites are sent from an org, not a room
    ([ADR 0036](../../adr/0036-invites-by-email.md)).
*   **Waking rooms to measure them.** The job reads Cloudflare, R2, the registry and `CostDO`; it never calls a room.
*   **Real-time cost.** Figures are as fresh as the last daily run.
*   **The dash page.** This work supplies the routes; bellman-sh/dash#94 draws them.

## Open Questions

Step zero, run on 2026-11-01, was a manual GraphQL schema introspection of Bellman's Cloudflare account with an
Account Analytics: Read token. It established which datasets report per object (`objectId`) and their limits: 32 days
per query, 90 days of retention, 10,000 rows per page. These questions remain. The first must be answered before the
usage capture ships; the rest only change how stored data is read.

1.  **Paging and filters (before capture).** Do the per-object queries accept `filter: { objectId_gt }` with
    `orderBy: [objectId_ASC]`, and what are the date filter field names (`datetime_geq` / `datetime_lt` or `date_geq`)?
2.  **Object-to-room mapping.** Does a row's `name` hold the room id, or must the job match `objectId` against
    `env.SESSION.idFromName(sessionId).toString()`? Check one known room, for `SessionDO` and `HostDO`.
3.  **Billed duration.** Which of `sum.duration` and `sum.activeTime` is the GB-s charge computed from, and in what
    unit? Cloudflare's Durable Objects pricing page should say.
4.  **Sampling.** Are `sum` values already weighted for sampling, or must they be multiplied by `avg.sampleInterval`?
5.  **Key-value meters on SQLite objects.** Are `storageReadUnits`, `storageWriteUnits` and `storageDeletes` non-zero
    and billed for SQLite-backed classes, where key-value calls bill as rows?
6.  **Requests and WebSocket messages.** Does `requests` already include WebSocket messages and alarms (the
    invocations `type` dimension), which would double-count against `inboundWebsocketMsgCount`?
7.  **Creator-pays and joiners.** Under creator-pays, a paid account that only joins other accounts' rooms carries no
    cost. Compare each plan's margin with a view weighted by `SessionEvent.fromUserId`; a difference above 20% of
    the plan's cost is the signal to revisit the rule.

## Critical User Journeys (CUJs)

### CUJ 1: The operator compares plan margins for last month

*   **Given**: The job has run every day of October 2026 and the first day of November.
*   **When**: The operator opens the cost page for October.
*   **Then**: Each plan shows prorated revenue, the cost of its rooms by driver, and margin, beside the free-plan and
    comped lines, with each driver's source label, the price table's date and the coverage share. The read is in the
    operator audit stream.

### CUJ 2: The operator finds the costliest rooms

*   **Given**: The current month has usage recorded.
*   **When**: The operator opens the cost page.
*   **Then**: It lists the 20 rooms with the highest cost this month, each with its plan and cost by driver, and links
    to that room's detail, which shows its cost by month. No briefs, messages or surface content appear, and each read
    is audited.

### CUJ 3: A room is purged mid-month

*   **Given**: A room charged to the `pro` plan has three months of usage and is purged on 15 October.
*   **When**: The operator reads October and lifetime figures for `pro`.
*   **Then**: The room's usage up to its purge still counts toward `pro`, shown under its room id because its name is
    gone.

## Technical Plan (Architecture)

The work runs in three places: a daily scheduled job (sections 1–4), a new Durable Object that stores what the job
captures (section 5), and the operator routes, which price and classify at read time (sections 6–7).

```text
              daily cron, 03:17 UTC  (scheduled handler, src/worker.ts)
                                 |
                       runCostJob (src/cost/job.ts)
     +---------------+-----------+-------------+-------------------+
     |               |                         |                   |
     v               v                         v                   v
 RegistryDO       Cloudflare GraphQL       R2 bellman-blobs    planOf (shared resolver)
 rm: room index   per-object usage,        list rooms/*        per distinct room creator
 gr: grants       current + previous       -> bytes per room
 org records      month
     |               |                         |                   |
     +---------------+-----------+-------------+-------------------+
                                 v
                 CostDO  (one object, SQL tables, src/cost-do.ts)
          rooms | usage | totals | blobs | creator_plans | org_days | solo_grants | days | runs
                                 |
     GET /operator/costs   and   GET /operator/rooms/:id
                                 |
            src/cost/margin.ts: #475 prices + read-time rules
                                 v
              margin per plan, cost per room, coverage share
```

### 1. Plans, captured daily

The job reaches rooms only through `listRoomsPage`, never by listing `rm:` keys. The operator rooms design (dash
`docs/superpowers/specs/2026-11-01-operator-rooms-design.md`, its PR 2) moves the index from `rm:` rows into a SQLite
`rooms` table and keeps `listRoomsPage`'s signature. A direct `rm:` list would then return nothing, and every object
would go unmatched without an error; `worker-tests/cost-job-room-index.test.ts` guards this.

Each run reads the registry's room index once (`BellmanStore.listRoomsPage`, 500 rows a call, until a short page)
and records, for the current UTC day:

*   **Room creators.** For each distinct `createdBy`, the result of `planOf(userId, deps, { raw: true })`:
    `{ plan, via, grantSource, grantOrgId }`. `planOf` is the resolution `HostDO`'s `plan` closure performs today,
    moved into one shared function: `BELLMAN_KEYS` first, then `BELLMAN_USERS` overrides, then stored grants through
    `replanOnRefresh`, then `free`. `via` says which answered (`"keyed"`, `"override"`, `"grant"`, `"default"`).
    With `raw: true` it applies neither `honourPurchases` nor the org's standing: it returns the first usable grant's
    own plan, its `source` and its `orgId`, so the read side applies both rules and can change them later. `HostDO`
    calls it without `raw`, and its behaviour is unchanged.
*   **Orgs.** For each distinct `orgId` among the grants (`BellmanStore.listGrants`, capped at `MAX_GRANTS_COUNTED`)
    and among the room index's `orgId`s: the org record's `seats`, `source` and `active` (all null when `getOrg`
    finds no record), and the count of its grants per plan.
*   **Individual grants.** For grants with no org, a count per `(plan, source)`, leaving out grant keys that a
    `BELLMAN_USERS` override shadows, as `statsRoutes` already does.
*   **The day's settings.** Whether purchases are honoured (`billingSettings(env).applyPlans`), whether the grant read
    hit its cap, and whether the creator read hit its cap (below).
*   **Rooms.** Each room in the index not yet in `CostDO.rooms`, with its two object ids, so a room's ids are kept
    even on days the usage capture cannot run.

Rows hold user ids, org ids, plans, sources and counts only: no grant keys, names, labels or emails.

**Registry reads, and the subrequest budget.** A scheduled invocation may make 1,000 subrequests, the limit the
codebase already budgets against (`MAX_BACKFILL_WINDOW`, `src/oauth/routes.ts`). Each creator costs up to four
registry calls (`getGrant` per identity key, `getOrg`, `scimUserByKey` inside the SSO check). Those reads behave as
they do at every sign-in: `getGrant` and `listGrants` delete a lapsed grant when they meet one, so the job's reads
can cause registry writes. The run resolves at most `MAX_COST_CREATORS = 150` creators, about 600 subrequests,
leaving room for the index pages, `getOrg` per org, the R2 listing, eight GraphQL fetches and the `CostDO` calls.
Past the cap it records `plans_status = "capped"` and leaves the remaining creators unrecorded that day
(`ponytail:` ceiling; the upgrade is a cursor that resumes the next creators in a second invocation).

### 2. Usage, captured daily from Cloudflare

The job posts to `https://api.cloudflare.com/client/v4/graphql` under `viewer { accounts(filter: { accountTag }) }`.
Every run covers both the previous month and the current month to date, with four queries per month (each inside the
32-day limit):

1.  `durableObjectsPeriodicGroups` grouped by `objectId` and `namespaceId`: every `sum` field (`duration`,
    `activeTime`, `cpuTime`, `rowsRead`, `rowsWritten`, `storageReadUnits`, `storageWriteUnits`, `storageDeletes`,
    `inboundWebsocketMsgCount`, `outboundWebsocketMsgCount`, `subrequests`) and `avg.sampleInterval`.
2.  `durableObjectsInvocationsAdaptiveGroups` grouped by `objectId`, `namespaceId` and `type`: `sum.requests`,
    `sum.wallTime` and `avg.sampleInterval`. One object returns one row per invocation type.
3.  Query 1 grouped by `namespaceId` alone.
4.  Query 2 grouped by `namespaceId` and `type`.

Every raw field is stored, so the open questions about billed duration, sampling, key-value meters and request types
are answered at read time without recapturing. Each query asks for at most 10,000 rows. There is no paging: a query
that returns exactly 10,000 rows marks that month `skipped_full_page` and writes nothing for it (`ponytail:` ceiling
in `src/cost/graphql.ts`; the upgrade is paging with the `objectId_gt` filter Open Question 1 confirms). A month whose
four queries all succeed is written; the other month's result does not depend on it.

### 3. Mapping objects to rooms

Each object id is computed with `env.SESSION.idFromName(sessionId)` and `env.HOST.idFromName(sessionId)` for every
room in `CostDO`'s `rooms` table, which the plans half fills from the room index every day (section 1) and never
deletes. `idFromName` is a local hash with no network call. So a room purged mid-month keeps its object ids, and its
usage up to the purge still maps to it. A room created and purged between two daily runs is never recorded, and its
usage stays unmatched.

A row matching a room's `SessionDO` id is that room's room usage; one matching its `HostDO` id is its hosted-seat
usage. Rows matching nothing (the registry, auth and audit singletons, and anything else) are stored as unmatched.
The `namespaceId` of any matched row identifies Bellman's `SessionDO` and `HostDO` namespaces, so no namespace id is
configured.

### 4. Blob bytes, from a bucket listing

Blob objects are keyed `rooms/<sessionId>/<blobId>` (`src/blobs.ts:blobKey`). The job lists the bucket under `rooms/`
1,000 objects a call and sums sizes per room, recording one level per room per day. It runs whether or not the
analytics token is set, because a missed day cannot be listed later. Rooms that never write again are covered,
because the bucket still holds their blobs. SQLite database bytes are not per room (Cloudflare reports them
per namespace only) and stay off the room figures.

### 5. `CostDO`

One SQLite-backed Durable Object, `idFromName("cost")`, holds every captured record in SQL tables. It answers to the
scheduled job and the operator routes only, so it adds no load to `RegistryDO`, which serves joins and sign-ins.

```sql
CREATE TABLE rooms (session_id TEXT PRIMARY KEY, created_by TEXT NOT NULL, org_id TEXT,
  session_object_id TEXT NOT NULL, host_object_id TEXT NOT NULL, first_seen_day TEXT NOT NULL);
-- One row per object per month. kind: 'session' | 'host' | 'unmatched'; session_id is null when unmatched.
-- periodic: JSON of every sum field from query 1. by_type: JSON {type: {requests, wall_time}} from query 2.
CREATE TABLE usage (month TEXT NOT NULL, object_id TEXT NOT NULL, kind TEXT NOT NULL, session_id TEXT,
  namespace_id TEXT NOT NULL, periodic TEXT NOT NULL, by_type TEXT NOT NULL,
  periodic_sample_interval REAL, invocations_sample_interval REAL, PRIMARY KEY (month, object_id));
CREATE TABLE totals (month TEXT NOT NULL, namespace_id TEXT NOT NULL, periodic TEXT NOT NULL,
  by_type TEXT NOT NULL, periodic_sample_interval REAL, invocations_sample_interval REAL,
  PRIMARY KEY (month, namespace_id));
CREATE TABLE blobs (day TEXT NOT NULL, session_id TEXT NOT NULL, bytes INTEGER NOT NULL,
  PRIMARY KEY (day, session_id));
-- via: 'keyed' | 'override' | 'grant' | 'default'; grant_* null unless via = 'grant'.
CREATE TABLE creator_plans (day TEXT NOT NULL, user_id TEXT NOT NULL, plan TEXT NOT NULL, via TEXT NOT NULL,
  grant_source TEXT, grant_org_id TEXT, PRIMARY KEY (day, user_id));
-- seats, source, active null when the org has no record. plans: JSON {plan: grant count}.
CREATE TABLE org_days (day TEXT NOT NULL, org_id TEXT NOT NULL, seats INTEGER, source TEXT, active INTEGER,
  plans TEXT NOT NULL, PRIMARY KEY (day, org_id));
CREATE TABLE solo_grants (day TEXT NOT NULL, plan TEXT NOT NULL, source TEXT NOT NULL, count INTEGER NOT NULL,
  PRIMARY KEY (day, plan, source));
CREATE TABLE days (day TEXT PRIMARY KEY, honour_purchases INTEGER NOT NULL, grants_capped INTEGER NOT NULL,
  creators_capped INTEGER NOT NULL);
-- *_status: 'written' | 'capped' | 'skipped_no_token' | 'skipped_full_page' | 'error'.
-- usage_status: JSON {month: status}. counts: JSON of rows written per table.
CREATE TABLE runs (started_at INTEGER PRIMARY KEY, finished_at INTEGER, plans_status TEXT, blobs_status TEXT,
  usage_status TEXT, error TEXT, counts TEXT);
```

`rooms` rows are inserted if absent and never deleted. `usage` and `totals` are replaced per month on each run for
the current and previous month. The daily tables are replaced per day. `runs` gains one row per run.

Replacing a month's `usage` and `totals` is one SQL transaction: delete that month's rows, insert the new ones. A
daily table's rows for a day are replaced the same way, so a second run on the same day leaves the same rows.
Months older than the previous one are never rewritten, so a late run cannot overwrite complete totals with the
shorter sums left in Cloudflare's window.

### 6. Read-time rules

`src/cost/margin.ts` is runtime-free. It takes one month's records from `CostDO`, #475's price table and cost
function, and returns the cost page. Its rules:

*   **Who a room is charged to.** A room with an `org_id` is charged to its org; otherwise to its creator.
*   **The owner's standing on a day.** Each owner-day resolves to one `(plan, class)`, where class is `paid`,
    `comped` or `free`:
    *   **Org.** No `org_days` row: no standing that day. A row with no record (`source` null): comped, at the
        highest-ranked plan among its grants. `active` false: `free`. `source = "operator"`: comped. `source =
        "purchase"`: paid if purchases were honoured that day, else `free`. The plan is the highest-ranked among its
        grants (`ENTITLEMENTS` order); an org with no grants has no plan and no standing.
    *   **Creator.** No `creator_plans` row: no standing. `via = "keyed"` or `"override"`: comped. `via = "default"`:
        free. `via = "grant"`: if `grant_org_id`'s `org_days` row says inactive, `free`; else if `grant_source =
        "purchase"`, paid when purchases were honoured that day and `free` when not; any other source is comped.
*   **Which plan a room's month goes to.** The `(plan, class)` its owner held on the most days of the month on which
    the room had usage recorded; a tie goes to the one held later in the month. An owner with no standing on any day
    of the month puts the room on the **unattributed** line, beside free and comped.
*   **Revenue.** For each captured day of the month: each paid org's `planRevenue(plan, seats)` and each paid
    individual purchase grant's `planRevenue(plan, 1)`, divided by the month's days. A day with no `days` row (the
    job did not run) takes the previous day's rows; the first day of a month may take the previous month's last day.
    The current month counts only days up to today, so its revenue is month to date. The page reports plan coverage:
    the captured days divided by the days elapsed.
*   **Room cost.** #475's cost function over requests, billed duration (Open Question 3), rows read and rows written
    for both of the room's objects, weighted by `sample_interval` if Open Question 4 says so, plus blob GB-months
    (the sum of the room's daily levels divided by the month's days). Other stored fields are shown as diagnostics,
    not priced.
*   **Coverage.** For duration and requests in each namespace: matched usage divided by the namespace total.

Because these rules run on every read, changing one changes every month at once.

### 7. Operator routes

*   **`GET /operator/costs?month=YYYY-MM`.** `month` defaults to the current UTC month. A malformed month, a month
    after the current one, or any other query parameter is a 400. A month with no records returns empty lines.
    Returns the per-plan table, the free, comped and unattributed lines, the 20 costliest rooms (ids, plans and
    costs, no names, so no room is woken), coverage, lifetime totals per plan, the price table's date, and the last
    run. Lifetime totals compute every month `CostDO` holds through the same rules, one `month()` read each
    (`ponytail:` ceiling; the upgrade is a stored per-month summary once months number in the dozens).
*   **`GET /operator/rooms/:id`** gains `cost`: the room's cost by driver for each month it has usage, and the plan
    and class it was charged to each month. For a purged room (no session, but a `CostDO.rooms` row) it answers 200
    with `{ id, purged: true, org_id, cost }`. An id neither knows is a 404, as today.

Both sit behind `BELLMAN_OPERATORS` (401 with no caller, 403 `not_available` for a non-operator) and append to
`OPERATOR_AUDIT_STREAM` before answering, failing closed with a 500 as #472's routes do.

*   **Cost page audit.** One platform entry: action `operator_costs_read`, sentinel session id `"operator:costs"`,
    `detail: { month }`, `roomName: null`, parties the operator's org plus the org of each of the 20 rooms shown.
    Each of those orgs also gets its own entry through `auditRows`, as the room detail writes today.
*   **Purged-room audit.** The detail's existing `operator_room_read` entry, with `roomName: null` and parties the
    operator's org and `rooms.org_id`.

### Data sizes

At today's scale (`MAX_GRANTS_COUNTED`'s note counts three paid accounts) every table is small. At 10,000 rooms the
`usage` table gains about 20,000 rows a month and the daily tables about 10,000 rows a day; one SQLite object holds
that for years. The cost page reads one month's `usage` rows and up to 31 days of plan rows per request.

## Risks and Mitigations

| Risk | Signal | Mitigation |
| --- | --- | --- |
| The job stops running (deploy error, cron removed) | The last run's age on the cost page, flagged past 36 hours | Run it by hand through `wrangler`'s scheduled test endpoint |
| The analytics token is missing, expired or revoked | `usage_status` shows `skipped_no_token` or `error` | Plans, rooms and blobs keep being captured; replace the secret; the next run refills the current and previous month |
| Cloudflare renames a field or dataset | The GraphQL error text in `runs.error` | Fix the query; up to 90 days can be recovered |
| More than 10,000 objects in one query | `usage_status` shows `skipped_full_page` | Add paging (the `ponytail:` ceiling in `src/cost/graphql.ts`) |
| Objects go unmatched (index gaps, rooms created and purged between runs) | Coverage below 95% | List unmatched object ids from `usage` and fix the mapping |
| Grants or creators exceed a read cap | `days.grants_capped`, `days.creators_capped`, `plans_status = capped` | Raise the cap, or resume creators in a second invocation |
| Owners with no plan record | The unattributed line, and plan coverage below 100% | Months before the capture started show here; nothing to fix for those |
| `CostDO` stores user ids forever | — | Same identifiers the registry already holds; an account erasure path, when one exists, must cover `creator_plans` and `rooms` |

## Alternatives Considered

### Alternative A: Measure usage inside the room (the original #473 design)

A counting wrapper around `SessionDO`'s storage and methods, a residency timer, and Workers Analytics Engine points.

*   **Pros**: Needs no Cloudflare token; data arrives within seconds.
*   **Cons**: Summing per-invocation wall time counts a room's resident time once per overlapping long poll. About 65
    to 80 RPC methods and three entry paths need covering. Analytics Engine samples heavily written indexes and costs
    more per point than a request.
*   **Reason for Rejection**: Step zero showed Cloudflare reports duration, rows and requests per object, from the same
    meters it bills.

### Alternative B: Revenue from Stripe invoices

*   **Pros**: The amount actually paid, after discounts, annual billing and refunds.
*   **Cons**: `STRIPE_API_KEY` is restricted to reading subscriptions; invoices need a wider or second key. Team
    invoices must be mapped to orgs. Comped, keyed and free accounts still need the plan record.
*   **Reason for Rejection**: Owner chose list price (2026-11-01).

### Alternative C: Split revenue by each member's written activity

*   **Pros**: A paid account that only joins others' rooms would carry part of their cost.
*   **Cons**: Hosted rooms show the largest losses, because the host writes and has no account; a room's margin moves
    when its members get busier elsewhere; account ids would travel with usage.
*   **Reason for Rejection**: Owner chose creator-pays. Open Question 7 keeps the activity-weighted view as a check.

### Alternative D: Room-reported storage

Each room sends its database and blob bytes to the registry after an append, at most daily.

*   **Pros**: Database bytes per room.
*   **Cons**: Hooks at seven append sites, a call outside the outbox, a stamp written only when the record changes,
    and rooms that stop writing never report again. The figure is worth about $0.01 per full room-month.
*   **Reason for Rejection**: The R2 listing covers blob bytes for every room with no room code (owner, 2026-11-01).

### Alternative E: Cost rows in `RegistryDO`

*   **Pros**: No new class.
*   **Cons**: Batch writes and full scans on the object every join and sign-in waits on, and about 11 new
    `BellmanStore` methods.
*   **Reason for Rejection**: Owner chose a dedicated `CostDO`.

### Alternative F: One R2 file per month

*   **Pros**: No new Durable Object class.
*   **Cons**: Every read parses a whole month's file, and room lookups and lifetime totals are scans in code rather
    than queries.
*   **Reason for Rejection**: Owner chose `CostDO`'s SQL tables.

### Alternative G: Plan at month end

*   **Pros**: The simplest read.
*   **Cons**: An account that cancels on the 30th shows no revenue for the month.
*   **Reason for Rejection**: Owner chose prorated revenue, with each room's month charged to the plan held most days.

### Alternative H: A computed overhead line

Overhead as Cloudflare's account totals minus the sum of room costs.

*   **Pros**: Every dollar would sit somewhere.
*   **Cons**: The check "rooms plus overhead equal the total" cannot fail, room and namespace storage are in different
    units, and the Worker and R2 totals come from datasets never introspected.
*   **Reason for Rejection**: Margin per plan does not need it; coverage share is a check that can fail.

### Alternative I: Room-kept monthly counters, or a daily alarm per room

*   **Pros**: Exact for what the room counts; every room's size known.
*   **Cons**: The in-process problems of Alternative A, and an alarm per room wakes idle rooms and adds a stored alarm
    name that a rollback can leave firing.
*   **Reason for Rejection**: Cloudflare and the R2 listing cover the same drivers without touching rooms.

--------------------------------------------------------------------------------

## Non-Functional Requirements

*   **Security & Privacy.** `CF_ANALYTICS_TOKEN` (Account Analytics: Read) is a Worker secret, read only by the
    scheduled handler and never returned by a route. `CostDO` holds ids, plans and numbers only. Cost routes are
    operator-only and every read is audited.
*   **Performance.** The job never wakes a room. Its registry reads are the room index, one capped grant list,
    `getOrg` per org, and up to four calls per creator; like every sign-in, they may delete lapsed grants. The run
    stays under 1,000 subrequests through `MAX_COST_CREATORS` (section 1).
*   **Rollout & Rollback.** `CostDO` is a new class with its own migration tag. Rolling back the read side leaves the
    capture running; rolling back the capture leaves `CostDO`'s rows, which only the cost routes read. A migration
    that adds a class cannot be rolled back by redeploying an older build that lacks the class; leave the class in
    place and disable the cron instead.

--------------------------------------------------------------------------------

### Additional Resources

*   `docs/ARCHITECTURE.md`: the Durable Object types and the cross-object atomicity gap.
*   [ADR 0005](../../adr/0005-watch-and-delivery-paths.md): a held long poll keeps the object resident.
*   [ADR 0036](../../adr/0036-invites-by-email.md): invites are sent from an org.
*   Issues: #361 (a new Durable Object method lags a deploy), #452, #472, #474, #475, #476, #477; bellman-sh/dash#94.
*   Cloudflare: GraphQL Analytics for Durable Objects; Durable Objects pricing.

### Future Improvements

*   **Tokens per room**, when #474 records them somewhere the job can read without waking a room.
*   **Database bytes per room**, if namespace SQLite storage becomes a material share of the invoice.
*   **Amount actually paid**, from Stripe invoices (Alternative B).

--------------------------------------------------------------------------------

## Detailed Implementation Plan

### Delivery order

Steps 1 and 5 change no code. Steps 2 and 3 are two PRs each, merged and deployed in order.

1.  **Pre-check (manual, before step 2b).** With an Account Analytics: Read token, run query 1 of section 2 for one day
    once for each candidate date filter name (`datetime_geq` / `datetime_lt`, `date_geq` / `date_lt`), and record the
    working form on #473. Answer Open Questions 2–6 by query or from Cloudflare's pricing documentation, and record the
    answers on #473 before step 3.
2.  **Capture.**
    *   **2a: `CostDO`, the cron, plans, rooms and blobs.** Begins the daily plan, room and blob records, none of which
        needs the analytics token.
    *   **2b: usage.** Every run captures the previous month as well as the current one, so no usage is lost while 2b
        waits on step 1.
3.  **Read side.** Re-plan 3a and 3b when #475 merges, against its actual exports. The minimum they need from #475:
    `planRevenue(plan, seats): number` for a month, a cost per driver and quantity, and the price table's date.
    *   **3a: `margin.ts`.**
    *   **3b: the routes.**
4.  **Separate issue (any time): the long-poll timer.** `waitForEvents` never clears its `setTimeout`. File it with the
    call sites (`SessionDO.#wake`, `SessionDO.#settleWatchers`), a `timer` field on `Waiter`, and a test in
    `tests/store-do-wiring.test.ts` that uses `vi.useFakeTimers()` and asserts `vi.getTimerCount() === 0` after an
    early answer and after a purge. Comparing Cloudflare's per-object `duration` before and after the fix shows
    whether the fix changed the bill.
5.  **Issue bookkeeping (with 2a).** Edit #473's body to match this design; drop #452 from #473's dependencies in #477;
    reduce #476 to comparing coverage with the invoice by hand.

### Interfaces

The types the steps below implement. Days are `YYYY-MM-DD` and months `YYYY-MM`, both UTC; months come from
`monthKey` (`src/stored-session.ts`).

```ts
// src/oauth/routes.ts
type PlanOf = {
  plan: Plan;
  via: "keyed" | "override" | "grant" | "default";
  grantSource: string | null;  // set only when via is "grant"
  grantOrgId: string | null;   // set only when via is "grant"
};
type PlanOfDeps = Pick<OAuthConfig, "overrides" | "plans" | "honourPurchases"> & { keys: string | undefined };
function planOf(userId: string, deps: PlanOfDeps, opts?: { raw?: boolean }): Promise<PlanOf>;

// src/cost/records.ts
type RoomRecord = { sessionId: string; createdBy: string; orgId: string | null;
  sessionObjectId: string; hostObjectId: string; firstSeenDay: string };
type UsageRecord = { month: string; objectId: string; kind: "session" | "host" | "unmatched";
  sessionId: string | null; namespaceId: string; periodic: Record<string, number>;
  byType: Record<string, { requests: number; wallTime: number }>;
  periodicSampleInterval: number | null; invocationsSampleInterval: number | null };
type TotalsRecord = Omit<UsageRecord, "objectId" | "kind" | "sessionId">;
type PlansDay = { day: string; honourPurchases: boolean; grantsCapped: boolean; creatorsCapped: boolean;
  creators: { userId: string; plan: string; via: PlanOf["via"]; grantSource: string | null; grantOrgId: string | null }[];
  orgs: { orgId: string; seats: number | null; source: "purchase" | "operator" | null; active: boolean | null;
    plans: Record<string, number> }[];
  soloGrants: { plan: string; source: string; count: number }[] };
type RunStatus = "written" | "capped" | "skipped_no_token" | "skipped_full_page" | "error";
type RunRecord = { startedAt: number; finishedAt: number | null; plansStatus: RunStatus | null;
  blobsStatus: RunStatus | null; usageStatus: Record<string, RunStatus>; error: string | null;
  counts: Record<string, number> };
type MonthRecords = { month: string; rooms: RoomRecord[]; usage: UsageRecord[]; totals: TotalsRecord[];
  blobs: { day: string; sessionId: string; bytes: number }[];
  plans: PlansDay[];          // every captured day of the month, plus the previous month's last captured day
  lastRun: RunRecord | null };

interface CostStore {
  putRooms(rooms: RoomRecord[]): Promise<void>;                       // insert if absent
  knownRooms(): Promise<RoomRecord[]>;
  replaceUsage(month: string, usage: UsageRecord[], totals: TotalsRecord[], now: number):
    Promise<{ ok: true } | { ok: false; reason: "too_old" }>;        // refuses months before monthKey(now)'s previous
  putBlobs(day: string, rows: { sessionId: string; bytes: number }[]): Promise<void>;   // replaces the day
  putPlans(plans: PlansDay): Promise<void>;                           // replaces the day
  putRun(run: RunRecord): Promise<void>;                              // insert or replace by startedAt
  month(month: string): Promise<MonthRecords>;
  roomMonths(sessionId: string): Promise<string[]>;                   // months with usage for the room
  months(): Promise<string[]>;                                        // months with any usage, ascending
}
```

A refusal is a returned value, not a throw, so it crosses RPC unchanged.

### Target Files to Create/Modify

#### Step 2a: `CostDO`, the cron, plans, rooms and blobs

##### 1. `src/oauth/routes.ts` (Modify)

*   **Type / Scope**: TypeScript module (Node and Workers builds).
*   **Proposed Changes**:
    *   `replanOnRefresh` also returns the matched `grant` (or `null`). Its three callers ignore the new field.
    *   `firstGrant` gains a `standing: boolean` argument (default `true`). Only `raw` resolution passes `false`.
    *   Add `planOf` (Interfaces). Order: when `deps.keys` is set and `keyedPlan(userId, deps.keys)` returns a plan,
        `via: "keyed"`; otherwise continue. `keyedPlan` is never called with `undefined`, which would fall back to
        the dev keys. Next, derive the identity key as `signedInPlan` does (github or google subject, else
        `ssoKeyForUser`); with none, return `{ plan: "free", via: "default", grantSource: null, grantOrgId: null }`.
        Then call `replanOnRefresh` with `honourPurchases: true` and grant standing off when `opts.raw`, else with
        `deps` as given. Map its `source`: `"operator"` to `"override"`; `"grant"` to `"grant"`, with `grantSource`
        and `grantOrgId` from the returned grant; `"default"` to `"default"`. `SignInRefused` resolves to the same
        free result.
    *   `signedInPlan` becomes `planOf(...).plan` with `keys` unset, so its tests keep passing unchanged.

##### 2. `src/host-do.ts` (Modify)

*   **Type / Scope**: Workers module.
*   **Proposed Changes**: The `plan` dep returns `(await planOf(userId, { keys: env.BELLMAN_KEYS, overrides,
    plans, honourPurchases })).plan`. Behaviour unchanged.

##### 3. `src/cost/records.ts` (Create)

*   **Type / Scope**: runtime-free module.
*   **Proposed Changes**: The Interfaces types, the `CREATE TABLE` statements from section 5 as constants, and
    `isTooOld(month, now)`, which both stores use to refuse `replaceUsage`.

##### 4. `src/cost/memory.ts` (Create)

*   **Type / Scope**: runtime-free module.
*   **Proposed Changes**: `MemoryCostStore implements CostStore`, backed by `Map`s, for tests and the Node server.

##### 5. `src/cost-do.ts` (Create)

*   **Type / Scope**: Workers-only module.
*   **Proposed Changes**:
    *   `CostDO extends DurableObject`. It creates the tables in its constructor inside `blockConcurrencyWhile`, and
        implements each `CostStore` method with `ctx.storage.sql.exec`. Each replace runs inside
        `ctx.storage.transactionSync`, as a delete followed by inserts.
    *   `DurableObjectCostStore` takes a stub and delegates each method through `reviving` (`src/rpc-error.ts`), as
        `DurableObjectStore` does.

##### 6. `src/cost/plans.ts` (Create)

*   **Type / Scope**: runtime-free module.
*   **Proposed Changes**: `capturePlans(day, deps)` returns a `PlansDay` and the day's new `RoomRecord`s. It:
    *   pages the room index with `listRoomsPage(500, after)` until a page comes back shorter than 500;
    *   resolves each distinct creator once through `planOf(..., { raw: true })`, up to `MAX_COST_CREATORS = 150`,
        with a `ponytail:` comment naming the 1,000-subrequest ceiling and resuming creators in a second invocation
        as the upgrade;
    *   reads grants with one `listGrants(MAX_GRANTS_COUNTED)` call (the constant is exported from
        `src/http/stats.ts`);
    *   calls `getOrg` once for each distinct `orgId` found in the grants or the room index;
    *   counts individual grants after dropping keys that an override shadows;
    *   computes object ids with the `sessionIdOf` and `hostIdOf` functions it is given.

##### 7. `src/cost/blobs.ts` (Create)

*   **Type / Scope**: runtime-free module.
*   **Proposed Changes**: `captureBlobs(day, blobs: BlobStore)` returns the day's rows from `bytesByRoom()`.

##### 8. `src/blobs.ts`, `src/blobs-r2.ts` (Modify)

*   **Proposed Changes**: `BlobStore` gains `bytesByRoom(): Promise<Map<string, number>>`. `R2BlobStore` lists
    `rooms/` 1,000 objects a call and sums `size` per `sessionId`. `MemoryBlobStore` sums its map.

##### 9. `src/cost/job.ts` (Create)

*   **Type / Scope**: runtime-free orchestrator.
*   **Proposed Changes**:
    *   `runCostJob(deps: CostJobDeps, now: number): Promise<RunRecord>`. `CostJobDeps` holds:
        *   `store: BellmanStore`;
        *   `costs: CostStore`;
        *   `blobs: BlobStore`;
        *   `planDeps: PlanOfDeps`;
        *   `sessionIdOf` and `hostIdOf`, each `(sessionId: string) => string`;
        *   `honourPurchases: boolean`;
        *   `cloudflare`, with `{ accountId, token, fetch }`, or `undefined`.
    *   In 2a, the plans half (`putPlans`, then `putRooms`) and the blobs half (`putBlobs`) run independently. A
        failure in one is recorded in its status and does not stop the other.
    *   It writes one `RunRecord` with `putRun` at the start and again at the end, and logs one line:
        `cost job: plans=<status> blobs=<status> usage=<month>:<status>,… counts=<json>`.

##### 10. `src/worker.ts` (Modify)

*   **Type / Scope**: Workers entry.
*   **Proposed Changes**:
    *   Export `CostDO`.
    *   Add `scheduled(controller, env, ctx)`, which calls `ctx.waitUntil(runCostJob(…, Date.now()))`.
    *   `sessionIdOf` is `(id) => env.SESSION.idFromName(id).toString()`, and `hostIdOf` is the same over `env.HOST`.
    *   `WorkerEnv` gains `COST: DurableObjectNamespace`, and optional `CF_ANALYTICS_TOKEN` and `CF_ACCOUNT_ID`.

##### 11. `wrangler.toml` (Modify)

*   **Type / Scope**: deploy configuration.
*   **Proposed Changes**:
    *   A `[[durable_objects.bindings]]` block with `name = "COST"` and `class_name = "CostDO"`.
    *   `[[migrations]] tag = "v4"`, `new_sqlite_classes = ["CostDO"]`.
    *   `[triggers] crons = ["17 3 * * *"]`, which runs daily at 03:17 UTC.
    *   `CF_ANALYTICS_TOKEN` and `CF_ACCOUNT_ID` in the `wrangler secret put` comment block.

##### 12. `worker-tests/wrangler.toml` (Modify)

*   **Proposed Changes**: Add a `COST` binding for `CostDO`, and append `"CostDO"` to its single `v1` migration's
    `new_sqlite_classes`, as `worker-tests/README.md` asks for every class.

##### 13. `tsconfig.json`, `tsconfig.test.json`, `CLAUDE.md` (Modify)

*   **Proposed Changes**:
    *   `tsconfig.json` and `tsconfig.test.json`: add `src/cost-do.ts` to `exclude` in both. The test config replaces
        the inherited list rather than extending it.
    *   `CLAUDE.md`: add `src/cost-do.ts` to the Workers-only file list, and change "the five Durable Object types"
        to six.

##### 14. Tests (Create or Modify)

*   **`tests/plan-of.test.ts`.**
    *   Precedence runs keyed, then override, then grant, then default.
    *   A user set in `BELLMAN_KEYS` but missing from it falls through to the grant lookup.
    *   Without `raw`, an inactive org's grant resolves `free`, and a purchase grant is skipped when
        `honourPurchases` is false.
    *   With `raw`, both return the grant's own plan, `grantSource` and `grantOrgId`.
    *   An SSO user resolves through `ssoKeyForUser`.
    *   `signedInPlan` returns what it did before.
*   **`tests/helpers/cost-store-contract.ts`**, covering every `CostStore` method:
    *   replacing a month twice leaves the same rows;
    *   `replaceUsage` for a month before the previous one returns `{ ok: false, reason: "too_old" }`;
    *   a second `putRooms` for a known room leaves its first record unchanged;
    *   `putPlans` for a day replaces that day's rows rather than adding to them;
    *   `month()` includes the previous month's last captured day.
*   **`tests/cost-store.test.ts`** runs the contract against `MemoryCostStore`, and
    **`worker-tests/cost-do.test.ts`** runs it against `CostDO`, each case on a unique object name.
*   **`tests/cost-plans.test.ts`.**
    *   Each distinct creator is resolved once, and creators past the cap set `creatorsCapped`.
    *   Each org's seat count, source, active flag and plan counts are recorded; an org with no record is recorded
        with nulls.
    *   An org named only in the room index is read.
    *   An overridden key's purchase grant is not counted.
    *   No row carries a grant key, label or email.
*   **`tests/cost-job.test.ts`.**
    *   A failing plans half still writes blobs, and the reverse.
    *   The run record and the log line carry each status.
*   **`tests/helpers/blob-store-contract.ts`.** `bytesByRoom` sums per room. Assert only on the case's own session
    ids, because the bucket is shared across cases.
*   **`worker-tests/cost-scheduled.test.ts`.** The `scheduled` export, driven with `createScheduledController`,
    writes a plans day to `CostDO`.
*   **`worker-tests/cost-job-room-index.test.ts`.** Runs in the Durable Object runtime against the real
    `RegistryDO` index. It creates a room, runs the job, and checks that `CostDO.rooms` holds that room with its
    object ids. The test must pass whichever of this work and the operator rooms PR 2 merges second: before PR 2 the
    index is `rm:`, and after it the `rooms` table. A job that lists `rm:` keys directly fails this test once PR 2
    is in. In 2b, the same test also checks that a fake Cloudflare row for that room's `SessionDO` id maps to the
    room and not to `unmatched`.

#### Step 2b: usage

##### 15. `src/cost/graphql.ts` (Create)

*   **Type / Scope**: runtime-free module.
*   **Proposed Changes**:
    *   `usageQueries(accountTag, from, to)` builds section 2's four queries, with the date filter form recorded by the
        pre-check.
    *   `parseUsage(json)` returns typed rows, `{ error: string }` carrying Cloudflare's message, or
        `{ fullPage: true }` when a query returns 10,000 rows.
    *   No other module names a Cloudflare field.
    *   The `ponytail:` comment names the no-paging ceiling and `objectId_gt` paging as the upgrade.

##### 16. `src/cost/usage.ts` (Create)

*   **Type / Scope**: runtime-free module.
*   **Proposed Changes**: `mapUsage(month, rows, rooms, sessionIdOf, hostIdOf)` returns `UsageRecord`s (each matched
    or `unmatched`, with `byType` assembled from query 2's rows) and `TotalsRecord`s from queries 3 and 4.

##### 17. `src/cost/job.ts` (Modify)

*   **Proposed Changes**: The usage half.
    *   With `cloudflare` undefined, it records `skipped_no_token` for both months and skips the queries. Plans,
        rooms and blobs are unaffected.
    *   Otherwise, for the previous month and then the current month, it runs the four queries and handles the
        results:
        *   any `{ error }` records `error` for that month;
        *   any `{ fullPage }` records `skipped_full_page`;
        *   otherwise it maps the rows against `knownRooms()` and calls `replaceUsage` once, recording `written`.
    *   One month's result never blocks the other.

##### 18. Tests (Create or Modify)

*   **`tests/cost-graphql.test.ts`.** It checks the query text and parsing, that a Cloudflare error returns
    `{ error }`, and that a 10,000-row result returns `{ fullPage }`.
*   **`tests/cost-usage.test.ts`.** The fixture has three rooms, one `HostDO`, a registry object and a purged room
    known only from `rooms`. Each room and the `HostDO` map to their session ids, the purged room maps through
    `rooms`, the registry object is `unmatched`, and `byType` holds one entry per invocation type.
*   **`tests/cost-job.test.ts`.** With a fake `fetch`:
    *   with no secrets, the job writes plans, blobs and `skipped_no_token`;
    *   a failing query writes nothing for its month and leaves the other month written;
    *   no month older than the previous one is requested.

#### Step 3: read side (re-plan when #475 merges)

These are the files and the obligations 3a and 3b must meet. The signatures that touch #475 are fixed then.

##### 19. `src/cost/margin.ts` (Create, 3a)

*   **Proposed Changes**: `costPage(records: MonthRecords, prices, now): CostPageBody` applies section 6's rules.
    `lifetime(costs: CostStore, prices, now)` loops over `months()`.
*   **Body.** Snake case, typed as `CostPageBody`:
    *   `month`, `price_table_date`, `month_to_date: boolean`;
    *   `plans[]`: `{ plan, revenue, cost: { requests, duration, rows_read, rows_written, blob_storage }, margin,
        rooms }`;
    *   `free`, `comped` and `unattributed`, each `{ cost, rooms }`;
    *   `top_rooms[]`: `{ id, plan, class, cost }`;
    *   `coverage`: `{ namespaces: [{ namespace_id, kind, duration_share, requests_share }], plan_days_share,
        below_threshold: boolean }`;
    *   `lifetime[]`: `{ plan, revenue, cost, margin }`;
    *   `sources`: `{ requests: "cloudflare", duration: "cloudflare", rows_read: "cloudflare", rows_written:
        "cloudflare", blob_storage: "listing", tokens: "not_metered" }`;
    *   `last_run`: `{ at, stale: boolean, plans_status, blobs_status, usage_status }`, where `stale` means more than
        36 hours old;
    *   `grants_capped` and `creators_capped`.
*   **Tests: `tests/cost-margin.test.ts`.** One case for each rule and edge case in section 6:
    *   org and creator charging;
    *   the most-days rule and a tie going to the later plan;
    *   an owner with no standing going to unattributed;
    *   an org with no record;
    *   an inactive org's purchase grant;
    *   purchases not honoured;
    *   carry-forward across a missed day and across a month boundary;
    *   month-to-date revenue;
    *   coverage below 95% flagged.

##### 20. `src/http/operator-costs.ts` (Create, 3b)

*   **Proposed Changes**:
    *   `GET /operator/costs` with section 7's query rules and audit entries.
    *   It appends before answering and fails closed with a 500.
*   **Tests: `tests/operator-costs.test.ts`.**
    *   401, and 403 with `not_available`, each writing no audit row.
    *   One platform entry, plus one per org shown.
    *   A failed append returns a 500.
    *   No response field holds a brief, message, surface content, label or email.

##### 21. `src/http/operator-rooms.ts` (Modify, 3b)

*   **Proposed Changes**:
    *   Export `operatorEntry`.
    *   `operatorRooms(url, path, who, store, origin, costs?, prices?)`: the detail adds `cost` and answers purged
        rooms as section 7 says.
    *   Update the file's "No cost yet" header comment.
*   **Tests.** Extend `tests/operator-rooms.test.ts` and `worker-tests/operator-rooms-routes.test.ts`:
    *   the `cost` field;
    *   a purged room's 200 body and its audit parties;
    *   a 404 when neither store knows the id.

##### 22. `src/http/stats.ts`, `src/worker.ts`, `src/app.ts` (Modify, 3b)

*   **Proposed Changes**:
    *   `StatsRouteDeps` gains `costs?: CostStore` and `prices?`.
    *   `statsRoutes` adds `/operator/costs` to its path check, before the 401/403, and passes `costs` to
        `operatorRooms`.
    *   `src/worker.ts`:
        *   adds `costs` to the `/operator/(…)` regex;
        *   passes `costs: new DurableObjectCostStore(env.COST.get(env.COST.idFromName("cost")))` in its
            `statsRoutes` deps.
    *   `src/app.ts` adds `/operator/costs` to its mount list and passes one `MemoryCostStore`.
*   **Tests.**
    *   `worker-tests/operator-costs-route.test.ts`: an operator's `GET /operator/costs` returns 200 with a
        `CostPageBody` from the Worker.
    *   Add `/operator/costs` to the path list in `worker-tests/panel-wiring.test.ts` and to the suspended-operator
        `it.each` in `worker-tests/moderation-routes.test.ts`.

#### Documentation (with the step that changes each)

##### 23. `docs/ARCHITECTURE.md` (Modify, 2a)

*   **Proposed Changes**:
    *   `CostDO` as the sixth Durable Object type.
    *   The cron as an entry point.
    *   The analytics token as a secret and a trust boundary.
    *   The job's registry reads, and the lapsed-grant deletes they can cause.

##### 24. `src/cost/EGM.md` (Create, 2a), `src/EGM.md`, `src/http/EGM.md`, root `EGM.md` (Modify)

*   **Proposed Changes**:
    *   `src/cost/EGM.md`, the `src/cost/` contract:
        *   no record holds a grant key, label or email;
        *   months older than the previous one are never rewritten;
        *   read-time rules live only in `margin.ts`;
        *   the job wakes no room.
    *   `src/EGM.md`:
        *   `planOf`, `CostDO`, the `scheduled` handler and `bytesByRoom`;
        *   "five Durable" object types becomes six;
        *   `src/cost-do.ts` joins the Workers-only file list.
    *   `src/http/EGM.md` (3b): `/operator/costs`, the detail's `cost` field, and the purged-room answer.
    *   Root `EGM.md`: `cost` in the subdirectory list.

##### 25. `docs/adr/NNNN-room-cost-from-cloudflare.md` (Create, 2a)

*   **Proposed Changes**: The ADR records four decisions:
    *   read Cloudflare's per-object analytics instead of metering in the room;
    *   a dedicated `CostDO`;
    *   creator-pays, with prorated revenue;
    *   raw capture with classification at read time.

    When the PR opens, take the next number not used on `origin/main`, in any open PR, or on any local branch.

### Verification Plan

*   **Every PR**: `npm run verify`, which runs `typecheck:worker` and the workerd tests. CI also runs
    `wrangler deploy --dry-run`.
*   **After merging 2a and 2b**: confirm the deploy workflow run on `main` succeeds.
*   **Locally**:
    1.  Run `npx wrangler dev --test-scheduled`.
    2.  Run `curl "http://localhost:8787/__scheduled?cron=17+3+*+*+*"`.
    3.  Check the `cost job:` log line, which gives each half's status and row counts.
*   **After 2a deploys**: the next day's run writes plans, rooms and blobs with `usage = skipped_no_token`.
*   **After 2b deploys**:
    *   For one known room, its `usage` rows match a hand-run GraphQL query for the same month.
    *   A second run on the same day leaves the same rows.
    *   Coverage is reported for the `SessionDO` and `HostDO` namespaces.
*   **After 3b deploys**:
    *   `/operator/costs` returns a body whose plan, free, comped and unattributed costs add up to the priced sum of
        every matched room.
    *   The read appears in the operator audit stream.

--------------------------------------------------------------------------------

*Drafted with EGM*
