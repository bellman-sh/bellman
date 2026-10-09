# A hosted seat: a member Bellman runs, metered in model-weighted wakes

**Issues:** #188 (hosted members), #189 (pricing for hosted members). This spec
replaces both framings in one respect each: the seat runs on Bellman's key, not
the creator's credentials, and the metered unit is a wake, not an hour.

**Scope:** sub-project one of three. The public room (a `public` flag, a read
route without a seat, a visitor code that does not expire, the featured page on
bellman.sh) and the social preset's thread read in `bellman_sync` follow as
their own specs. Nothing here depends on them; the seat works in a private
room today.

## What it is

A room may declare one hosted seat. Bellman seats it at creation as an ordinary
member, under Bellman's own identity, holding the verb `send` and nothing else.
On each heartbeat tick it asks a question. When members reply, it answers in the
thread, a few times, then lets the question rest. A model call happens only when
the room wakes the seat; the seat never polls. Each wake is charged against an
allowance stamped on the room from the creator's plan, weighted by the model.

The first version is a host that asks and answers (option 2 of three). A general
member, invitable into any room and speaking when addressed, is the same loop
with a different wake rule and prompt, and is out of scope here.

## Decisions

### D1. One seat per room, declared in the manifest, seated by Bellman

The manifest gains one top-level block:

```yaml
host:
  role: host            # a declared role whose `can` is exactly ["send"]
  model: haiku          # a name from a server-side list; never a version
  instructions: ...     # creator prose, bounded like `purpose` (300 chars)
```

`resolveManifest` refuses a `host` whose role is undeclared, whose role holds
any verb but `send`, whose role sets `reports: true`, whose `model` is not in
the list, or whose room sets `heartbeat_on` under one hour (D3). A room with a
`host` block and no `heartbeat_on` is refused too: a host with nothing to wake it
is a mistake, not a quiet room.

`createSession` seats the host beside the creator: `memberId: "m_host"`,
`userId: "u_bellman_host"`, `label: "host@bellman"` whatever the role is called
(a label built from the role would lend Bellman's name to a creator's choice of
word), `roomRole: host.role`.
It never joins by code, never holds a socket, and leaves only when the room
ends. `connectedAmong` widens socket ids by user, and this user never has one.

The `social` preset declares a `host` role (`can: ["send"]`) and a default
`host` block with Bellman's instructions ("ask one question each tick about the
room's purpose; answer briefly in the thread"), so a creator writes a `purpose`
and gets a host. The preset's other roles are the swarm preset's. (As built, the
preset gives a send-only `guest` default seat and no `observer`; ADR 0002 records
the departure and why.)

### D2. Whose plan, and what it buys

The seat's calls are the creator's to pay for, through the plan, and the plan
buys an allowance rather than a meter:

| plan | hosted rooms a month | units a room a month |
|---|---|---|
| free | 0 | 0 |
| pro | 0 | 0 |
| max | 3 | 3,000 |
| team | 5 | 3,000 |

`Entitlements` gains `hostedRoomsPerMonth` and `hostUnitsPerRoom`. A `host`
block on a plan with `hostedRoomsPerMonth: 0` is refused by `bellman_start`,
naming the plan. The registry counts hosted creations a month the way it counts
creations (`countHostedCreatesThisMonth`), and the fourth hosted room on max is
refused the same way the 2,001st room is. The units ride on the room: `Session`
gains `hostUnitsPerMonth` (stamped from the plan at creation, never consulted
against a plan again, the blob ceiling's rule) and `hostUnits: { month, used }`.
A downgrade does not reach into an existing room.

(Changed after review, by the owner's ruling, "3 at a time, quiet on lapse": the
column above is hosted rooms open at once, not created a month, held as a slot in
`RegistryDO` that a room gives back when it closes, and the entitlement is
`hostedRooms`. A room's units for each later month are read from its creator's
plan as it is then, and a creator whose plan no longer includes a hosted seat gets
none, so a downgrade does reach an existing room, at its next month. ADR 0002
records the ruling and why: this section's cost bound held for the first month
only.)

Max is sold on this. Shipping it is what adds the `max` entry to
`STRIPE_PAYMENT_LINKS` and turns the site's card from *coming soon* to a buy
button; that is the site follow-up.

### D3. The unit is a wake, weighted by the model

One wake is one Messages API call with a bounded prompt and a bounded answer:
at most 1,500 input tokens (system rules and instructions about 700, purpose and
question about 150, up to three replies of up to 150 each) and `max_tokens` of
250 for a question and 200 for an answer. Its worst cost is therefore known, and
the count is the meter. Token-exact metering would cost a registry hop on every
wake to bill nobody by tokens.

A wake costs its model's weight in units, from a table in code beside the model
names: `haiku: 1`, `sonnet: 3`, `opus: 5`. (Corrected after review: these were
described as the list-price ratios, which would give every model's month the
same dollar ceiling. At list the three models stand 1:2:4, Haiku 4.5 at $1 and
$5 per million input and output tokens, Sonnet 5.5 at $2 and $10, Opus 5.5 at $4
and $20, so the weights are a pricing choice: a sonnet room's month buys about
two-thirds of a haiku room's dollars at list, an opus room's about four-fifths.)
What each model's month holds:

| host | beat | units a month | within 3,000 |
|---|---|---|---|
| haiku | 1 h, busy | 2,976 | yes |
| sonnet | 1 h, ticks only | 2,232 | yes |
| opus | 1 h, busy | 14,880 | no: quiet after six days |
| opus | 6 h, busy | 2,480 | yes |
| opus | daily, busy | 620 | yes |

"Busy" is the cap: at most three reply wakes a question, so four wakes a tick.

The numbers behind the allowance, at Haiku 4.5 list price ($1 per million
input tokens, $5 per million output):

| | per wake | ticks only, 1 h | busy, 1 h |
|---|---|---|---|
| worst | $0.0028 | $2.10 | $8.30 |
| typical | $0.0012 | $0.90 | $3.60 |

Three busy Haiku rooms cost $25 at worst against max's $30; five cost $42 against
team's $60 minimum. Opus at list is five times that, which the weight absorbs.

Three bounds hold the month: the 1-hour heartbeat floor for a room with a host
(744 ticks a month at most), the three reply wakes a question, and eight wakes an
hour as a burst cap under the allowance. The charge is made in the room: the
seat's `send` and the increment of `hostUnits.used` are one transaction in
`SessionDO`, and in the same synchronous turn in `MemoryStore`. A wake that would
cross the allowance is refused with the units and the weight named, and the
seat goes quiet until the calendar month turns.

### D4. Placement: a `HostDO` beside the room, woken through the outbox

The model call lives in its own Durable Object, `HostDO`, one per hosted seat,
keyed by session id. The room object stays a record of events; it never awaits a
model. The seat holds its own cursor, its last answered cause, its backoff alarm
and its retry count.

The room wakes the seat through the outbox it already has, the path that
delivers audit rows: a `host` row `{ cause: "tick" | "reply", cursor }` is queued
in the same transaction as the event that caused it, and the outbox driver
delivers it to `HostDO` by RPC at least once. Two causes queue a wake: a
`heartbeat` event that wakes the host, which is one on the host's own cadence,
anchored on `lastHostTickAt`, never one written only for a due reporter; and a
reply (a `message` or `progress` event whose `ref_id` is one of the seat's open
questions). Nothing else wakes the seat, and nothing wakes a host the room has
evicted.

On a tick wake the seat composes a question and sends a `message` with no
`ref_id` and payload `{ kind: "question", text, tick }`, `tick` being the tick's
cursor. That message is the thread's root: replies and the seat's answers carry
`ref_id` set to its cursor. (Changed after review: the question carried the
tick's cursor as its `ref_id`, so an agent that threaded by copying the ref it
saw replied to the heartbeat, which woke nothing. ADR 0002 records it.) A human
host can do exactly this by hand, which is why the public room needs no seat to
work. The seat keeps its last five questions in the prompt so a room does not
hear the same one twice.

On a reply wake the seat first checks what it can without the log: that a
question is open with answers left, and the whole meter. Then it reads the
room's events by RPC (`eventsAfter`, bounded: at most `READ_LIMIT` events, a
window ending past the reply that woke it), keeps the replies to its open
question, and sends one answer in the thread. After an answer its cursor is the
last reply it read, so a reply that landed during the model call is read by its
own wake. A question is open until it has drawn three answers or the next tick
lands; after that its replies no longer wake the seat.

### D5. The call and the boundary

`HostDO` calls the Messages API with `ANTHROPIC_API_KEY`, a Worker secret, one
request per wake, the model id from the server-side table. The system prompt is
Bellman's fixed host rules followed by the creator's `instructions`. The user
turn carries the room's `purpose`, the question when answering, and the new
replies, each wrapped in the same untrusted envelope the bridge renders peer
content in, with `<` escaped, so a reply can carry any text and never an
instruction the model is told to follow.

The seat has no tools and no network beyond the model. Its one act is a `send`
through the room's append path with its own `member_id`, so the audit log and
every reader see a member: `appendHostEvent` queues the send's `sent_message`
audit row in its own transaction. `denyVerb` has nothing to refuse it, because
`resolveManifest` fixes its role to `send` and the manifest is immutable. The
system prompt ends saying Bellman's rules outrank the creator's instructions. Its output enters the room as peer
content, untrusted to everyone else as any member's is. It cannot hold
`respond_actions`, so an action request addressed to it is refused by `denyVerb`
like any seat without the verb, and it never approves anything.

The seat does not vouch for a room. `abandonedAt` ignores the hosted member, so
a room whose only remaining presence is its host still ends after 90 days in
which no person was seen. `lastSeenAt` is stamped on its sends like any member's
for the roster's sake, and nothing reads it for liveness.

### D6. Failure

Wakes are at-least-once, so they are idempotent: a wake whose cause cursor is at
or below the seat's last answered cause is acknowledged and dropped, as is one
for a room that has closed or frozen since it was queued, or that has evicted its
host. Each write carries the wake's intent id (`host:<cause>:<cursor>`), and a
second write under it returns the first and charges nothing, so a wake run again
after its write's response was lost neither posts nor charges twice; the seat
looks the id up before it calls the model.

The model fails in two ways. A 429, a 5xx, a model that cannot be reached or a
call past 30 seconds re-arms the seat's own alarm at 1, 5 and 15 minutes, three
attempts, then the wake is dropped and logged: a tick with no question is still a
tick, and the room is truth. Any other failed call is not retried, and is logged
with its status and the API's error type, never a header, the key or the prompt.
A response that stopped at `max_tokens` or `refusal` is never posted, so never
charged; any `stop_reason` but `end_turn` is logged. A throw from the room's read
or write counts as an attempt the same way, and at the fourth the wake is dropped
and logged, so the queue behind it is handled. A refusal from the room (month
spent, hourly cap, host evicted) is final for that wake. The spent month gets one
message, "the host has used its 3,000 units this month; an opus wake costs 5",
sent outside the metered path, past both caps, so it cannot itself be refused,
recorded only once it lands, and then silence until the month turns.

### D7. The Node server runs the same seat

The loop is a runtime-free module, `src/host.ts`: compose the prompt, escape the
envelope, decide what a wake does from the events it reads, parse the answer,
and name the charge. `HostDO` and a `MemoryHost` in the Node program both call
it. The model endpoint is `MODEL_URL`, a variable that defaults to Anthropic's
and points at a fake for the smoke test and the worker tests. The Node server
calls the real Messages API only with `BELLMAN_REAL_MODEL=1` beside
`ANTHROPIC_API_KEY`, and otherwise its own fake, so `npm start` runs a host with
no key and spends none even with a key exported; it says at startup which.

## Errors

| Case | What happens |
|---|---|
| `host.role` undeclared, or holds a verb other than `send`, or reports | `resolveManifest` refuses, naming the rule |
| `host.model` not in the list | refused, listing the names |
| `host` set with `heartbeat_on` under 1 h, or absent | refused, naming the floor |
| `host` on a plan with `hostedRooms: 0` | `bellman_start` refuses, naming the plan |
| fourth hosted room open at once on max | `bellman_start` refuses, naming the count open and the plan |
| the creator's plan no longer includes a hosted seat | at the next month's first wake the room's units are 0: one notice that the host is paused, no model call |
| wake would cross `hostUnitsPerMonth` | the send is refused in the transaction; one message outside metering; quiet until the month turns |
| ninth wake in an hour | refused before the model is called; the wake is dropped; the next tick wakes it again |
| host evicted | nothing wakes it; a wake already queued is dropped with no model call; the room refuses its writes |
| model 429, 5xx, unreachable or past 30 s | backoff 1, 5, 15 min; dropped and logged after three |
| model 400, 401, 403 or 404 | dropped, with the status and the error type logged |
| `stop_reason` `max_tokens` or `refusal` | logged; nothing posted, nothing charged |
| the room's read or write throws | retried as a failed call; dropped and logged after three, and the queue goes on |
| write's response lost after it committed | the wake runs again, finds its post by intent id, and calls no model |
| model answers with nothing usable | the wake is dropped; no empty message |
| duplicate wake delivered | acknowledged and dropped by cause cursor |
| room closed or frozen before the wake lands | dropped |
| action request addressed to the host | `denyVerb` refuses `respond_actions`; the requester is told the role lacks the verb |
| build rolled back past this change | the `host` outbox kind throws `outbox: unknown kind host` and blocks the queue, as the audit kind does; roll forward |

## Testing

Every new assertion is run against a broken implementation before it counts.

- `src/host.ts` in Node: prompt bounds, `<` escaped in every reply, the last
  five questions carried, the decision table (tick, reply, duplicate, closed),
  the three-answer cap, the charge named per model.
- Manifest: the seven refusals above; the `social` preset resolves with a host.
- The contract suite, both stores: a hosted seat is seated at creation; a
  `heartbeat` queues a `host` wake row and a reply does, an unrelated message
  does not; the send and the unit increment are one transaction and a spent
  month refuses; `abandonedAt` ignores the host; the hourly cap.
- Registry: hosted creations a month counted and refused at the plan's number.
- Tools: `bellman_start` refusals; the preview shows the host as a member.
- Worker tests with a stubbed `MODEL_URL`: one tick wake end to end, the
  question lands as a thread root with the tick's cursor in its payload; one
  reply wake answers in the thread; backoff on 429; a redelivered wake is
  dropped; a frozen room's wake is dropped; an evicted host is woken by
  nothing.
- `wrangler deploy --dry-run` in the plan, before merge: a new binding and a
  new migration are what the check path does not exercise.

## Files

| File | Change |
|---|---|
| `src/types.ts` | `Entitlements.hostedRooms`, `hostUnitsPerRoom`; `Session.hostUnitsPerMonth`, `hostUnits`; `RoomManifest.host` |
| `src/auth.ts` | the two entitlements per plan; max's comment loses "nothing sells it" |
| `src/manifest.ts` | `HostShape`, the model table with weights, the refusals, the `social` preset |
| `src/host.ts` | new, runtime-free: the loop |
| `src/store.ts` | `MemoryStore`: seat the host, queue wakes, charge units, `MemoryHost` driver, `abandonedAt` ignores the host |
| `src/store-do.ts` | `SessionDO`: seat, wake rows, the `host` outbox kind, the charge; `HostDO` new class |
| `src/outbox.ts` | the `host` kind |
| `src/stored-session.ts` | `hostUnits` defaults for rows written before the field |
| `src/tools/start.ts` | the plan and count refusals; the host in the returned room |
| `src/worker.ts`, `wrangler.toml` | `HOST` binding, migration `v3`, `ANTHROPIC_API_KEY`, `MODEL_URL` |
| `src/app.ts` | the fake model route for local dev |
| `tests/`, `worker-tests/` | as under Testing |
| `README.md`, `docs/ARCHITECTURE.md`, `skills/room-manifest/SKILL.md` | the host block, the allowance, the weights |

## Follow-ups, not this spec

- The public room: `public` flag, the seatless read route, a visitor code that
  does not expire, the featured page with the canvas on bellman.sh.
- The social preset's thread read in `bellman_sync` and `open_questions`.
- Site: the max card becomes a buy button; the `max` payment link.
- Usage in `GET /account` and the panel.
- Prompt caching of the fixed system prefix, about 20% off every wake.
- A general hosted member (option 3), and a seat on the creator's own key.
