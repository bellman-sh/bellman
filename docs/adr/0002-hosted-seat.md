# ADR 0002 — A hosted seat

**Date:** 2026-10-09 · **Status:** accepted · **Closes:** #188, #189 · **Spec:** `docs/superpowers/specs/2026-10-08-hosted-seat-design.md`

## Context

A room speaks only when a member's agent does, and a room meant to gather people
needs a member that asks the room something on a schedule. #188 proposed members
Bellman would run in sandboxed containers, each running an agent CLI on its
owner's credentials and joining by code. #189 priced them by the active hour,
because the containers' compute was Bellman's only cost. The member the social
and hub rooms ask for first is smaller: a host that asks the room a question and
answers the replies. It needs no container, no repository and no tools, only one
model call at a time, and that call is then the whole cost. Max differed from pro
by creates and the blob ceiling alone, kept as the shape #188's members would
attach to (ADR 0001, decision 3), and nothing sold it.

## Decision

1. **One hosted seat per room, declared in the manifest and seated by Bellman.**
   A `host` block (`role`, `model`, `instructions`) names a role whose `can` is
   exactly `send` and which does not report, in a swarm room whose
   `heartbeat_on` is at least an hour. `bellman_start` seats it beside the
   creator as `m_host`, under the user `u_bellman_host`, labelled `host@bellman`
   whatever its role is called, and it never joins by code. The `social` preset
   declares one. The seat calls the model on Bellman's key; no member's
   credentials reach it. Evicting it stops it: nothing wakes it again and the
   room refuses its writes.
2. **The plan buys hosted rooms open at once, and an allowance each month for
   each, not a meter.** Max holds three hosted rooms open at once and team five.
   Free and pro hold none, and `bellman_start` refuses them naming the plan. A
   hosted room takes one of its creator's slots in `RegistryDO` when it is
   created, counted and recorded in one transaction, and gives it back when it
   closes or is purged. Each hosted room carries `hostUnitsPerMonth`, 3,000 on
   both plans: stamped from the creator's plan at creation, and read from the
   creator's plan again at the first wake of each later month, 0 once that plan
   includes no hosted seat, which pauses the host until a month begins on a plan
   that includes one.
3. **The unit is a wake, weighted by the model.** A wake is one Messages API call
   with a bounded prompt and a bounded answer, so its worst cost is known and the
   count is the meter. It costs `haiku` 1, `sonnet` 3 or `opus` 5 units. Those
   weights are a pricing choice, not the list-price ratios: at list the three
   models stand 1:2:4 (Haiku 4.5 at $1 and $5 per million input and output
   tokens, Sonnet 5.5 at $2 and $10, Opus 5.5 at $4 and $20), so a month of
   3,000 units buys a sonnet room about two-thirds of a haiku room's dollars at
   list, and an opus room about four-fifths. The send and the charge are one
   transaction in `SessionDO` (`appendHostEvent`, through `decideHostCharge`,
   which `MemoryStore` shares), and so is the send's audit row. The host sends
   eight times an hour at most, and a spent month gets one notice, outside the
   meter, and then quiet until the month turns.
4. **The seat is its own object, woken through the room's outbox.** `HostDO`, one
   per hosted seat, calls the model, so the room's object never waits on one. A
   `heartbeat` that wakes the host, or a reply naming one of the host's events,
   queues a `host` row in the event's own transaction. The outbox delivers it at
   least once, and the seat drops a cause it has already handled. `wake` only
   queues the wake and arms the alarm, and the alarm handles one wake at a time.
   Each write carries the wake's intent id, so a wake run again after its write's
   response was lost neither posts nor charges twice.
5. **The host asks on its own cadence, and only when a person is there.** A
   hosted room ticks whether or not any role reports. The host's cadence is
   anchored on `lastHostTickAt`, which only a tick that wakes it moves; a tick
   written for a due reporter never wakes it. The store decides presence once,
   before the tick's write moves either clock (`tickPlan`): the host is woken when
   its cadence has come round and a person was seen since it last asked or is on
   a socket, and otherwise the firing writes nothing for it.
6. **The host does not vouch for the room.** Closing and abandonment count
   persons (`isActivePerson`), and seat reclaim skips the host. A hosted room
   ends when its last person leaves, or after 90 days in which no person was
   seen, and the host's seat is never taken for a joiner.
7. **The loop is runtime-free.** `src/host.ts` decides what every wake does.
   `HostDO` drives it in Workers and `MemoryHost` on the Node server, which calls
   the real Messages API only with `BELLMAN_REAL_MODEL=1` beside
   `ANTHROPIC_API_KEY`, the URL in `MODEL_URL` when one is set, and otherwise a
   fake model at `POST /__fake-model`, and says at startup which.

## Consequences

- Deploying needs the `HOST` binding, migration `v3`, and the
  `ANTHROPIC_API_KEY` secret before the first hosted room. A build rolled back
  past this change throws `outbox: unknown kind host` on a queued wake, or
  `outbox: unknown kind hosted_release` on a hosted room's close, and the room's
  outbox, first in first out, holds every row behind it; the deployment rolls
  forward.
- Each hosted room reads its creator's plan once a month, at its first wake of
  the month: a registry read for a signed-in creator. The read is outside the
  room's transaction, so a plan that changes between it and the charge costs
  one wake at most.
- `MAX_HEARTBEAT_MS` is a day for every room, so a daily host exists. An Opus
  host at an hourly beat, in a room that replies to every question, is quiet
  after six days; at a daily beat it lasts the month.
- Max now has what sells it and is still not on sale: no Stripe price names it,
  and `STRIPE_PAYMENT_LINKS` carries no `max` entry. Adding both, and the site's
  buy button, is the follow-up. ADR 0001's third decision otherwise stands.
- A failed model call (a 429, a 5xx, a model that cannot be reached, or a call
  past 30 seconds) is retried 1, 5 and 15 minutes later, four calls at most, and
  then the wake is dropped and logged: a tick without a question is still a
  tick. A wake the room cannot serve (its read or write throws) is retried the
  same way and dropped, so it does not hold the queue behind it. Any other
  failed call is logged with its status and error type and not retried, and an
  answer cut off at the token cap or declined is never posted or charged.
- What the host writes is peer content, untrusted to every member. Replies reach
  its prompt escaped inside `<reply from="…">`. It cannot hold
  `respond_actions`, so it approves nothing.
- Not decided here: the public room, the thread read in `bellman_sync`, usage in
  `GET /account`, prompt caching, and a general member Bellman runs on its
  owner's key, the one #188 described.

## Changes after the branch's review (2026-10-09)

The whole-branch review found defects, and these decisions moved with their fixes.
Each is reflected above; what changed and why:

- **The question is its thread's root (spec D4 changed).** D4 had the question
  carry the tick's cursor as its `ref_id`. An agent that threads by copying the ref
  it sees then replied to the heartbeat, which wakes nothing, and nothing told it
  otherwise. The question now carries no `ref_id`, so the only ref an agent sees on
  it is its own cursor, and the tick it answers travels in its payload,
  `{ kind: "question", text, tick }`; the seat's record still drops a tick it has
  handled. `bellman_send`'s `ref_id` and the bridge's channel and Stop-hook text
  now say how to thread a reply.
- **The host asks on its own cadence (decision 5).** It was woken by every tick
  written while a person was there, and in an authored room with reporting roles
  each reporter's deadline forced one: a room that declared `1h` heard a new
  question every 20 to 40 minutes, each resetting its three answers, which broke
  the 744-wakes-a-month bound in decision 3. `lastHostTickAt` is the host's own
  anchor.
- **Evicting the host stops it.** `bellman_evict` on `m_host` reported success
  and the host went on asking and spending. `hostSeated` now gates the tick, both
  stores' reply wakes, the seat's own decision and the charge.
- **The weights are not the list-price ratios (decision 3 corrected).** The
  earlier text said 1:3:5 were the list-price ratios, so that every model's month
  had one dollar ceiling. At list they are 1:2:4; the weights stand as a pricing
  choice.
- **The label is `host@bellman` (decision 1).** It was `<role>@bellman`, and a
  creator names the role, so a room could seat `security@bellman`. The system
  prompt now also ends saying Bellman's rules outrank the creator's instructions.
- **The Node server spends no key unless told to (decision 7).** It called the
  real API whenever `ANTHROPIC_API_KEY` was set, and Claude Code users commonly
  export it.
- **The `social` preset departs from spec D1, and the departure stands.** D1 said
  the preset's other roles are the swarm preset's: a `helper` default seat holding
  `send`, `request_actions` and `respond_actions`, and an `observer` with no verb.
  The preset gives strangers a send-only `guest` seat and no `observer`. A social
  room's joiners are strangers to one another, and an action request asks another
  member's human to act on their own machine, which is no part of answering the
  room's question; a seat that can only read would be asked the host's questions
  every hour with no way to answer them.
- **Three at a time, quiet on lapse (decision 2, the owner's ruling on the
  review's I7).** Decision 2 first counted hosted creations a month and stamped
  each room's 3,000 units once, never read from a plan again, the blob ceiling's
  rule. That held D2's cost bound (three busy Haiku rooms at $25 at worst
  against max's $30, five at $42 against team's $60) for the first month only:
  every hosted room kept renewing its units for its whole life, a creator could
  add three more each month and keep them all, and kept them after cancelling.
  A plan's hosted rooms are now the most open at once, with a slot taken in one
  registry transaction so parallel starts cannot both pass, and each month's
  units come from the creator's plan as it is when the month begins. The
  entitlement is renamed from `hostedRoomsPerMonth` to `hostedRooms`, since it
  no longer counts a month. The blob ceiling keeps its rule: storage costs
  nothing to keep, and model calls cost every month.
