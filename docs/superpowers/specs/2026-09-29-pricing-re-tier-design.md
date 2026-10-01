# Pricing Re-tier — Design

Status: **SUPERSEDED by #99, before implementation.** Do not build from this.
Closes: #45 (the `max` plan), #75 (the creator index is never pruned)
Related: #25, #12, #18 — the next branch, which this one clears the way for
Defers: #53 (orgs and seats), #39 (self-serve checkout)

> ## Superseded
>
> This spec rests on one claim: that watched-room concurrency is the entire
> marginal cost of a room, at $0.005625 per watched room-hour. That is true of
> the long-poll delivery path it was written against, and **#99 removes that
> path** for every client that can reach a local process.
>
> A throwaway probe (scratchpad, not committed) confirmed a Durable Object is
> evicted after ~10 s idle while its WebSocket stays open, and that delivery
> works after revival. So for socket-watched rooms:
>
> - the $4.05/watched room-month duration term goes to approximately zero;
> - the `103,680 × members × events` poll-read term disappears, because there
>   are no polls;
> - team's ~$53/month read exposure mostly goes with it;
> - **`maxLiveRooms` loses its cost justification**, surviving only as an abuse
>   control, which is a much weaker case for a new entitlement.
>
> What survives unchanged: remote MCP clients (ChatGPT connectors, Claude's web
> connector) cannot reach a local process, so they keep long-polling and keep
> costing duration. Whatever replaces this spec has to price that path alone
> rather than all traffic.
>
> Two things here are worth keeping whatever comes next, and neither depends on
> the cost argument:
>
> - **D2's index change** — storing `expiresAt` rather than `Date.now()` in
>   `us:<userId>:<sessionId>` and pruning on read. That is #75, and it is a fix
>   on its own terms.
> - **D3's rank argument** — `max` must be declared between `pro` and `team`,
>   because `src/billing/ledger.ts:80` derives plan rank from declaration
>   order. #45 needs this regardless.
>
> Revisit once #99 is measured against a real bill.

## Problem

`ENTITLEMENTS` meters the things that are free and does not meter the thing
that costs money.

Bellman runs on Cloudflare Workers with SQLite-backed Durable Objects. Billing
there has four components, and for a room only one of them is significant:

| component | rate | included | what drives it |
|---|---|---|---|
| duration | $12.50 / M GB-s | 400,000 GB-s | **a room being watched** |
| rows read | $0.001 / M | 25 B | room age × members × poll rate |
| rows written | $1.00 / M | 50 M | events appended |
| SQL storage | $0.20 / GB-month | 5 GB-month | events retained |

A Durable Object is billed 128 MB against wall-clock time for as long as a
request is in flight, and there is no hibernation for plain HTTP — only for
WebSockets. The bridge holds a long poll open (`MAX_WAIT_SECONDS = 25`,
`src/server.ts:18`), so a room somebody is watching keeps its object resident
continuously:

```
0.125 GB × 3,600 s × $12.50/M GB-s  =  $0.005625 per watched room-hour
                                    =  $1.35 / month at 8 h/day
                                    =  $4.05 / month at 24/7
```

The 400,000 GB-s allowance covers **1.23 always-watched rooms, account-wide.**
Storage does not compete: at roughly 1 KB per event and 100 events a day, the
5 GB-month allowance is about 140 room-years, and a thousand busy rooms held
for a year bill $6.20.

So the marginal cost of Bellman is, very nearly, *the number of rooms being
watched at once*. `Entitlements` has no field for that:

| field | gates | marginal cost |
|---|---|---|
| `monthlyCreates` | rooms created | ~$0 — an unwatched room costs nothing |
| `maxMembers` | members per room | multiplies reads only |
| `sessionTtlMs` | room age | the only thing bounding read cost today |
| `modes`, `orgScoping`, `audit` | features | ~$0 |
| — none — | **rooms live at once** | **the entire bill** |

Two consequences follow, and both are live today rather than hypothetical.

**Pro goes cash-negative inside its own rules.** `monthlyCreates: 500` permits
five hundred creations a month and nothing caps how many run at once. Three
rooms held open around the clock cost $12.15 against $12 of revenue; ten cost
$40.50.

**Team is already close.** Reads scale as `103,680 × members × events` per
watched room-month, at one poll per member every 25 seconds. A 30-day team room
with 25 members and 100 events a day holds 3,000 events and burns 7.8 B rows a
month, so the 25 B allowance covers 3.2 of them. A team account running ten
concurrent rooms reads 78 B rows — about **$53 a month against $60 of revenue.**

That second number is why this spec leads the branch that was going to be
#25 + #12 + #18. Raising any TTL before the read cost is bounded makes an
existing exposure worse.

## Scope

**In scope:** the entitlement shape, the tier values, the `max` plan, and the
index change that makes a concurrency cap enforceable.

**Out of scope, deliberately:**

1. **The expiry model (#18).** Inactivity-based extension and a hard age
   ceiling belong together — a ceiling with no sliding window is a TTL under a
   different name. Both land in the next branch, where they are used.
2. **The read split (#25).** Splitting `getSession` from history is what makes
   room age cheap, and it is the prerequisite for raising any TTL. Next branch.
3. **Running the contract suite against `DurableObjectStore` (#12).** This spec
   adds a method to the suite; wiring `@cloudflare/vitest-pool-workers` so the
   DO implementation runs against it is its own piece of work.
4. **Seats (#53).** `Entitlements` is `Record<Plan, Entitlements>` — one static
   value per plan, with no org size anywhere in the program. Team therefore
   gets flat numbers. See D6.
5. **Self-serve checkout (#39).** Prices are configured in Stripe; no purchase
   flow changes here.

## Decisions

### D1 — `maxLiveRooms` on `Entitlements`, checked at creation.

A single integer: how many of this user's rooms may be un-expired at once.

`tests/auth.test.ts:108` carries a deliberate tripwire:

> **INVARIANT 1: entitlements gate session CREATION only.** If a join-side
> field ever appears here, joining has stopped being free and being invited
> broken — this test is the tripwire.

`maxLiveRooms` satisfies it by construction. It is read once in
`bellman_start`, beside the `monthlyCreates` check at `src/server.ts:325`, and
never consulted again. Joining stays free on every plan, including joining a
room whose creator is at their cap — the cap is on *creating*, and a member
arriving costs the room nothing it was not already paying.

The test's `creationOnlyFields` list must gain the name, which is the tripwire
working rather than failing: the list is where the invariant is argued, and a
new entry there is a claim that has to be true.

**Rejected: metering watched room-hours directly.** It is what the bill
actually is, and it is unenforceable at creation time — nothing at
`bellman_start` knows how long a room will be watched. It also turns a refusal
into a surprise mid-session, which is the shape Bellman avoids everywhere else.

### D2 — The index stores `expiresAt`, not `Date.now()`, and prunes as it reads.

Counting a user's live rooms naively means one RPC per room, asking each
`SessionDO` whether it is still alive. At a cap of 10 that is 10 cross-object
hops on every `bellman_start`.

The registry already keeps the list. `src/store-do.ts:509` writes:

```ts
await this.ctx.storage.put(`us:${userId}:${sessionId}`, Date.now());
```

The value is unused — `sessionsCreatedBy` reads only the keys. Storing the
room's deadline instead makes the index self-describing:

```ts
await this.ctx.storage.put(`us:${userId}:${sessionId}`, expiresAt);
```

`countLiveRooms(userId)` is then one `storage.list` over the `us:<userId>:`
prefix, counting entries whose deadline is in the future and deleting the ones
that have passed. No cross-object hops, and the list shortens every time it is
read.

**This is #75.** That issue is that the creator index is never pruned and its
limit counts dead sessions. Pruning on read fixes both halves: the index stops
growing for the life of an account, and `sessionsCreatedBy`'s `limit` stops
being consumed by rooms that ended weeks ago.

**Both readers filter, one of them deletes.** `sessionsCreatedBy` exists to
find the rooms a lapsed plan has to freeze, and freezing a room that already
expired is wasted work, so it skips past-deadline entries for the same reason
`countLiveRooms` does not count them. The delete happens in `countLiveRooms`
alone. Two writers racing to prune the same key is harmless, but
`sessionsCreatedBy` runs on the billing path, where a read that also writes
would put a storage write inside plan resolution — and that path should stay
readable when storage is degraded.

**A stated imprecision.** A room closed *before* its deadline — by
`bellman_leave` emptying it, or by an explicit close — still counts until that
deadline passes. The count therefore over-counts and never under-counts, so it
errs toward refusing a creation rather than permitting one over the cap. The
alternative is decrementing from `SessionDO` when a room closes, which is a
cross-object write landing squarely in #62's atomicity gap: a decrement that
fails leaves the count permanently high, which is the same error made permanent
instead of self-healing.

### D3 — `max`, declared between `pro` and `team`.

#45 specifies the plan: $30/month or $300/year, team-sized rooms for one
person, no org. This spec adopts it unchanged except for `maxLiveRooms`.

Declaration order in `ENTITLEMENTS` is plan rank — `src/billing/ledger.ts:80`
reads `RANK = Object.keys(ENTITLEMENTS)`, and somebody paying for two plans
gets the higher-ranked one. `max` must therefore be declared after `pro` and
before `team`, or a customer holding both `max` and `team` lands on the wrong
one.

`orgScoping` and `audit` stay team-only. That is the reason a company with
several people creating rooms still buys Team rather than several Max seats.

### D4 — TTLs do not move in this spec.

The shape this spec was chosen from gave `pro` a 30-day room and `max`/`team`
no ceiling at all. The arithmetic in **Problem** rules that out for now: team's
read cost at today's 30 days is already about $53 a month at ten concurrent
rooms, and read cost scales linearly in age. Raising a TTL before #25
multiplies a number that is already the largest one in the system.

So `sessionTtlMs` keeps its current values, `max` takes #45's 14 days, and the
longer lives arrive in the next branch once `getSession` stops dragging the
whole history on every call. `maxLiveRooms` is what bounds the exposure in the
meantime, and it bounds it immediately.

### D5 — The numbers, and where they came from.

| | free | pro | max | team |
|---|---|---|---|---|
| price | $0 | $12 | **$30** | $20/seat, 3 min |
| **`maxLiveRooms`** | **1** | **3** | **10** | **10** |
| `sessionTtlMs` | 4 h | 72 h | **14 d** | 30 d |
| `maxMembers` | 2 | 8 | 25 | 25 |
| `monthlyCreates` | 20 | 500 | 2,000 | 5,000 |
| `modes` | pair | + swarm | + swarm | + swarm |
| `orgScoping` / `audit` | — | — | — | ✓ |

Only `maxLiveRooms` is new. Everything else is today's value, plus #45's `max`
row as that issue specifies it.

Duration cost against revenue, at the two rates from **Problem**:

| | revenue | worst case, 24/7 | realistic, 8 h/day |
|---|---|---|---|
| free | $0 | $0.45 | $0.15 |
| pro | $12 | $12.15 — break-even | $4.05 — 66% |
| max | $30 | $40.50 — negative | $13.50 — 55% |
| team | $60 | $40.50 — 33% | $13.50 — 78% |

Free is safe because its rooms cannot outlive four hours: twenty creations of a
four-hour room is eighty room-hours, $0.45. The short TTL, not the cap, is what
makes free free — which is also why D4's decision not to raise it matters more
for free than for any other tier.

Max at ten rooms is the one negative cell. It requires one person to pin ten
rooms open around the clock for a full month; the 14-day TTL and
`monthlyCreates: 2,000` bound how that accumulates, and the realistic figure is
55% margin. Accepted, with the number written down here so a later reader finds
it rather than rediscovering it.

### D6 — Team is flat until #53.

The shape this spec was chosen from wrote team's limits per seat. Nothing in
the program knows how many seats an org has: `Entitlements` is one static record
per plan, `Identity` carries an `orgId` and no count, and org membership does
not exist as an object yet — that is #53.

Team therefore gets flat numbers, sized for the three-seat minimum. When #53
lands, `maxLiveRooms` and `monthlyCreates` become the natural per-seat
quantities, and the constant here becomes a per-seat multiplier. Noted so that
work does not have to re-derive it.

### D7 — `countLiveRooms` joins the store contract.

`tests/helpers/store-contract.ts` is what makes `BellmanStore` a seam rather
than a comment — its own docstring says every implementation must pass it
identically. A counting method whose two implementations disagree would show up
as a cap that binds on Workers and not in tests, or the reverse.

The cases: an empty count for an unknown user; a count that rises with
creations; a count that ignores entries past their deadline; a count unchanged
by a *second* read, proving the prune is idempotent rather than destructive of
live rows; and `sessionsCreatedBy` omitting a past-deadline room while a later
`countLiveRooms` still reports the same number, which is what pins D2's split
between the reader that filters and the reader that deletes.

#12 is what will run these against `DurableObjectStore`. Until it lands they
run against `MemoryStore` only, and that gap is #12's to close — but the cases
exist now, so #12 inherits them rather than having to invent them.

## Changes

- `src/types.ts:1` — `"max"` on `Plan`.
- `src/types.ts:125` — `maxLiveRooms: number` on `Entitlements`.
- `src/auth.ts:7` — `ENTITLEMENTS.max`, declared between `pro` and `team`
  (D3); `maxLiveRooms` on all four plans.
- `src/server.ts:325` — the cap checked beside `monthlyCreates`, refusing with
  the plan name and the limit, in the shape that check already uses.
- `src/store.ts:71` — `countLiveRooms(userId: string): Promise<number>` on
  `BellmanStore`, and the `MemoryStore` implementation.
- `src/store-do.ts:509` — the index value becomes `expiresAt`;
  `RegistryDO.countLiveRooms` lists, counts and prunes; the facade forwards it.
- `src/store-do.ts:512` and `src/store.ts` — `sessionsCreatedBy` filters out
  past-deadline entries without deleting them (D2).
- `tests/helpers/store-contract.ts` — D7's cases.
- `tests/auth.test.ts:114` — `maxLiveRooms` in `creationOnlyFields`, with D1's
  argument in a comment beside it.
- `tests/auth.test.ts:82,92` — `"max"` in `plans`; `toBeLessThanOrEqual` for
  `max → team` on `maxMembers` and `maxLiveRooms`, which are equal by design,
  keeping `sessionTtlMs` and `monthlyCreates` strict. #45 anticipates this.
- `scripts/grant-plan.ts:38`, `scripts/rotate-key.ts:38` — `"max"` in `PLANS`.
  `max` is not an org plan, so the team/admin org check at `grant-plan.ts:110`
  is unchanged.
- `README.md:38` — `max` in the plan summary.
- `docs/ARCHITECTURE.md:244` — the `entitlementsFor` node lists "modes,
  members, TTL, quota, audit"; add live rooms.
- `docs/ARCHITECTURE.md:208` — the `RegistryDO` node names the creator index;
  say that it now carries deadlines and prunes itself.
- Stripe — `max_monthly` and `max_annual` prices carrying
  `metadata.plan = "max"`. No billing code: `planForPrice`
  (`src/billing/subscription.ts:26`) already reads `metadata.plan` or the
  lookup key's prefix, and accepts any plan in `ENTITLEMENTS` except `free`.

`npm run verify` and `npm run typecheck:worker` must both pass. The second is
not optional here — `src/store-do.ts` is in the Workers program and is checked
by nothing else (#40).

## Tests

Beyond the contract cases in D7 and the amendments above:

- A `max` identity creates a swarm room, admits a 25th member, is refused a
  26th, and is refused `org_only: true`.
- A user at `maxLiveRooms` is refused a further `bellman_start`, and the
  refusal names the plan and the limit.
- A user at the cap whose oldest room has passed its deadline creates
  successfully — the prune in D2 is what makes the room, and the test fails
  without it.
- A member may still *join* a room whose creator is at their cap. This is
  INVARIANT 1 as an executable claim rather than a field-name check.
- `tests/billing.test.ts` — a `max_monthly` price grants `max`; a user holding
  both `max` and `team` subscriptions resolves to `team` (D3's rank argument,
  which a wrong declaration order would break silently).

## Risks

**The cap is the first entitlement that can refuse a returning user.** Every
existing gate refuses something the user has not done yet — a mode they cannot
use, a member over the ceiling. `maxLiveRooms` refuses a person whose previous
rooms are still alive, which is a new kind of message to have to write well.
The refusal should say which limit was hit, and that closing a room or letting
one expire frees a slot.

**Over-counting is visible to the user.** D2's imprecision means somebody who
closes three rooms and immediately tries to create a fourth may be refused
until those deadlines pass. On free that is four hours. It is the conservative
direction, and the refusal text should acknowledge it rather than claim the
count is exact.

**The duration figures assume a bridge is attached.** A room created and never
watched costs approximately nothing, so every cost number here is an upper
bound on a room somebody is actually sitting on. The realistic column assumes
eight hours a day; neither column is measured, and both should be checked
against a real bill once there is one.
