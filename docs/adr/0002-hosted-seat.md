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
   creator as `m_host`, under the user `u_bellman_host`, and it never joins by
   code. The `social` preset declares one. The seat calls the model on Bellman's
   key; no member's credentials reach it.
2. **The plan buys an allowance, not a meter.** Max creates three hosted rooms a
   month and team five. Free and pro create none, and `bellman_start` refuses
   them naming the plan. Each hosted room carries `hostUnitsPerMonth`, 3,000 on
   both plans, stamped from the creator's plan at creation and never read from a
   plan again, the blob ceiling's rule.
3. **The unit is a wake, weighted by the model.** A wake is one Messages API call
   with a bounded prompt and a bounded answer, so its worst cost is known and the
   count is the meter. It costs `haiku` 1, `sonnet` 3 or `opus` 5 units, the
   list-price ratios, so a room's month has the same dollar ceiling whichever
   model the creator picks. The send and the charge are one transaction in
   `SessionDO` (`appendHostEvent`, through `decideHostCharge`, which
   `MemoryStore` shares). The host sends eight times an hour at most, and a spent
   month gets one notice and then quiet until the month turns.
4. **The seat is its own object, woken through the room's outbox.** `HostDO`, one
   per hosted seat, calls the model, so the room's object never waits on one. A
   `heartbeat`, or a reply naming one of the host's events, queues a `host` row
   in the event's own transaction. The outbox delivers it at least once, and the
   seat drops a cause it has already handled. `wake` only queues the wake and
   arms the alarm, and the alarm handles one wake at a time.
5. **A tick asks only when a person is there.** A hosted room ticks on its own
   cadence and needs no reporting role. The store decides presence once, before
   the tick's write moves `lastTickAt` (`tickPlan`): the tick is written and the
   host woken when a person was seen since the previous tick or is on a socket,
   and otherwise the firing writes nothing.
6. **The host does not vouch for the room.** Closing and abandonment count
   persons (`isActivePerson`), and seat reclaim skips the host. A hosted room
   ends when its last person leaves, or after 90 days in which no person was
   seen, and the host's seat is never taken for a joiner.
7. **The loop is runtime-free.** `src/host.ts` decides what every wake does.
   `HostDO` drives it in Workers and `MemoryHost` on the Node server, which calls
   a fake model at `POST /__fake-model` when neither `ANTHROPIC_API_KEY` nor
   `MODEL_URL` is set.

## Consequences

- Deploying needs the `HOST` binding, migration `v3`, and the
  `ANTHROPIC_API_KEY` secret before the first hosted room. A build rolled back
  past this change throws `outbox: unknown kind host` on a queued wake, and the
  room's outbox, first in first out, holds every row behind it; the deployment
  rolls forward.
- `MAX_HEARTBEAT_MS` is a day for every room, so a daily host exists. An Opus
  host at an hourly beat, in a room that replies to every question, is quiet
  after six days; at a daily beat it lasts the month.
- Max now has what sells it and is still not on sale: no Stripe price names it,
  and `STRIPE_PAYMENT_LINKS` carries no `max` entry. Adding both, and the site's
  buy button, is the follow-up. ADR 0001's third decision otherwise stands.
- A failed model call (a 429, a 5xx, or a model that cannot be reached) is
  retried 1, 5 and 15 minutes later, four calls at most, and then the wake is
  dropped: a tick without a question is still a tick.
- What the host writes is peer content, untrusted to every member. Replies reach
  its prompt escaped inside `<reply from="…">`. It cannot hold
  `respond_actions`, so it approves nothing.
- Not decided here: the public room, the thread read in `bellman_sync`, usage in
  `GET /account`, prompt caching, and a general member Bellman runs on its
  owner's key, the one #188 described.
