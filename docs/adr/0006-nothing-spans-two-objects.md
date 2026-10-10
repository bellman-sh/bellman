# ADR 0006 — Nothing spans two objects

**Date:** 2026-10-02 · **Status:** accepted · **Recorded:** 2026-10-09 · **Closes:** #59, #62, #69, #73, #117, #118, #124 · **Spec:** `docs/superpowers/specs/2026-09-29-cross-object-atomicity-design.md`, `docs/superpowers/specs/2026-10-04-atomicity-sweep-design.md`

## Context

A Durable Object's input gate covers one invocation, and Bellman's state is
split across five object types (ADR 0003), so an operation that touches two has
a window in the middle. Three bugs came from it, and they were two problems. A
lost write: a grant change committed and its audit row never reached `AuditDO`
(#59), or a room committed with a join code `RegistryDO` never indexed, so
nobody could join (#62). A misordered write: two purchase reconciles read the
ledger and wrote the grant in separate calls, and an older `active` landed after
a cancellation (#69). A later sweep found the same window inside one room: a
handler read the room, decided who was in it, and wrote in a later call (#73,
#116, #117, #118).

## Decision

1. **A write another object is owed is queued in the mutation's transaction.**
   `OutboxDriver.enqueue` (`src/outbox.ts`) returns `ob:` rows for the caller's
   `ctx.storage.transaction()` and arms the alarm inside it. `deliverNow()`
   delivers after the commit, and the alarm, `OUTBOX_GRACE_MS` (5 s) behind,
   retries the rest in order, a failing head holding the rows behind it, backing
   off from 1 s to 5 minutes and dropping nothing. `RegistryDO` queues for
   `AuditDO`; `SessionDO` for `RegistryDO`, `AuditDO` and `HostDO` (ADR 0002).
2. **Delivery is at least once, and each consumer absorbs a repeat.**
   `AuditDO.append` dedupes on the intent id with a `d:` row written beside the
   entry, a join code's put and drop are idempotent, and `HostDO.wake` drops a
   cause it has handled.
3. **A decision that must not be overtaken runs whole in the object that
   serialises it.** `AuthDO.reconcile` runs `reconcilePurchase` inside
   `BillingLedger.serializeUser` and calls the registry itself. That holds while
   there is one `AuthDO` and nothing in `RegistryDO` calls back.
4. **Nothing that awaits another object runs inside a transaction closure.**
   On workerd an await in a closure holds every other call to the object until
   it commits, so the closure queues and the wrapper delivers.
5. **An operation that decides who is in a room is one store call and one
   transaction.** `seatMember` reclaims, decides capacity, seats and retires a
   filled room's codes; `removeMember` checks its guard, stamps `leftAt`,
   retires the seat's code when the caller asks (an eviction does, a leave does
   not), writes the event bodies it is handed and queues the audit rows
   (PR #168). An append carries its cursor, idempotency record and a
   `progress` sender's `lastReportAt`, and the abandonment close its `session_expired`.

## Consequences

- `MemoryStore` has no outbox and delivers inline, so the store contract reaches
  the drain only in `worker-tests/`, against real Durable Objects;
  `tests/outbox.test.ts` drives `drain` and `OutboxDriver` over fake storage.
- Not covered: `DurableObjectStore` writes the `us:`, `um:` and `uo:` index rows
  after the commit through `writeIndex`, which logs a failure, so a lost write
  costs a listing row. `audit()` in `src/rooms.ts` writes with no queue, and
  after `seatMember` commits, `bellman_confirm` appends `member_joined` and
  audits through it: a throw there leaves a member seated with no `member_id`
  returned (#116, open).
- A blob upload spans an object and R2, which no outbox reaches: the route puts
  the object, then charges the room, and deletes the object if the charge is
  refused, so a loss is an uncharged object the close sweep finds.
- A build rolled back past an outbox kind throws `outbox: unknown kind`, and the
  queue holds every row behind it; deployments roll forward.
- A writing method nothing outside its class calls is `#private`, because a
  Durable Object answers RPC for every method on its class.
