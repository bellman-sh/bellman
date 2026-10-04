# The Atomicity Class, Swept Once — Design

> Group A is specified here in full. PRs 2–4 are scoped at the end and get their
> own designs if they need one; most of them are small enough not to.

`CLAUDE.md` names the cross-object atomicity gap as the thing that keeps
producing bugs, and `docs/ARCHITECTURE.md` §9 is the section on it. The #59/#62/#69
branch built the two mechanisms that answer it — durable delivery for a lost
write, a lock for a misordered one — and closed those three issues with them.

Eleven issues are still open that were filed against the same question. They
have been handled one at a time, each fix answering its own report, and §9's
general remedy has been cited in three of their bodies without being applied.
This sweeps them in one pass against the question instead: **does this handler
read the room, decide something about who is in it, and then write in a later
call?**

## Problem

The eleven are one question with five answers. Grouping them is the first piece
of work, because fixing them in filed order would produce five special cases
where one operation was wanted.

| | Issues | What they share | Remedy |
|---|---|---|---|
| **A** | #73, #116, #117, #118 | A removal or a seating decides against a snapshot and writes afterwards | One transactional store operation that performs the whole thing |
| **B** | #124 | Two commits in **one** object | One `ctx.storage.transaction()` |
| **C** | #74 | A status derived from a record read before an `await` | Re-read after the wait |
| **D** | #122 | A counter seeded from the keys it has already been added to | Read the count before the `put` |
| **E** | #134, #123 | Not this class at all | A `MemoryStore` clone, and a lock's hold time |
| **F** | #125, #120 | Claims about atomicity that nothing has measured | Measurement, not an edit |

Group A is the sweep. The other four groups are named here so that "swept once"
means every open instance was looked at, not that every one needed the same fix.

### What Group A's four have in common

- **#73** — `bellman_leave` sets `leftAt` and then appends `member_left`. #71 made
  `appendEvent` refuse while frozen, so a leave from a frozen room now drops its
  event and peers keep showing someone who is gone.
- **#118** — `evictMember` reads the session once, checks `closed` and `frozenAt`
  against that snapshot, and mutates afterwards. A freeze landing in the window
  either writes to a room whose writes were meant to have stopped, or silently
  swallows the `member_evicted` event — and the bridge disarms a watcher on
  exactly that event, so the evicted member's watcher never stops.
- **#117** — `leaveRoom` reads `me.leftAt` and writes it with an `await` between.
  Two calls on one handle both see `null`, both announce, both audit.
- **#116** — `bellman_confirm` calls `clearJoinCodes` after `SessionDO` has
  committed the seat. That reaches a second object with no transaction spanning
  it; if it throws, the member is in the room with no `member_joined` event, no
  audit row, no `member_id` returned, and the codes still redeemable. The connect
  token was consumed and is single use, so the retry cannot replay, and in a pair
  room the ghost seat has filled it.

Each is the same sentence with different nouns. The first three are one
operation — a member leaving a room, by their own hand or someone else's — split
across three or four store calls. The fourth is a seating whose last step
escaped the transaction that made the decision.

## Scope

**In.** `removeMember` on `BellmanStore` and both implementations; an `audit`
outbox kind on `SessionDO`; folding the join-code clearing into `seatMember`;
`rooms.ts`'s `leaveRoom` and `evictMember` rewritten onto them; conformance cases
in `tests/helpers/store-contract.ts`; `worker-tests/` cases for what only
`workerd` shows.

**Out.** `issueInvite` and `revokeInvite`. #118 lists them as wanting the same
treatment, and they do, but `setJoinCode` already makes its frozen refusal inside
its own transaction and already queues the registry write there. What is left for
them is the event, which is the same change this design makes for removal and is
better made second, against an operation that has shipped. PRs 2–4 are scoped
below and not designed here.

## Design

### 1. `removeMember` — one primitive, two guards

Leaving and being evicted are the same mutation: record a member out, say so, and
possibly retire the code for their seat. They differ only in who is allowed to
ask and what a frozen room means. So they get one store method with the guard as
a parameter, rather than two methods that would drift apart.

```ts
// What appendEvent already takes. No new name is introduced for it.
type EventBody = Omit<SessionEvent, "cursor" | "at">;

export interface RemovalOutcome {
  refused: "not_found" | "closed" | "frozen" | "forbidden" | null;
  /** True only when THIS call recorded the member out. */
  removed: boolean;
  /** The role whose code this call retired, or null. */
  codeRetired: string | null;
}

removeMember(
  sessionId: string,
  memberId: string,
  opts: {
    now: number;
    /** Leave allows a frozen room; eviction refuses it. */
    frozen: "allow" | "refuse";
    /** When set, the call is refused unless it matches `session.createdBy`. */
    byUserId?: string;
    /** Written only if this call did the removing. */
    event: EventBody;
    /** Retire this role's code and write its event, if the code is still live. */
    retire?: { role: string; event: EventBody };
    /** Queued in the same transaction and delivered by the outbox. */
    audit: readonly AuditEntry[];
  },
): Promise<RemovalOutcome>;
```

`removed: false` with `refused: null` is the idempotent path — the member was
already out. A second concurrent call on one handle gets it, and announces
nothing. That is #117, closed by the transaction rather than by an idempotency
key: `appendEventOnce` would have deduped the event and left the audit row
duplicated, which is why #117's own body reaches for #59's marker.

### 2. The handler passes the events in

`seatMember` is the pattern §9 holds up, and this goes one step further than it
for a reason. `seatMember` leaves events to the handler, because the handler
knows which sentence the joiner reads and the store does not. Removal cannot do
that, because the event is the thing being lost — that is #73 and half of #118.

So the handler hands the event bodies **in**, and the store writes them
only if it did the removing. The store still never asks what an event means: it
writes the record it was given. That constraint came out of #147, where the
alternative — the store branching on `event.type` — was the thing to avoid, and
`AppendExtras.creditReport` is the shape that respects it.

Inside the transaction, removal uses `#writeEvent`, the private primitive, rather
than `appendEvent`. The frozen refusal lives on `appendEvent`, the public append,
and it stays there: it is what stops a freeze landing between a tool's read and
its write and letting a frozen room grow. `removeMember` is a different operation
with its own frozen policy, declared by its caller. A leave therefore records its
departure in a frozen room without the store learning that `member_left` is
special — which is option (1) in #73 rejected, and option (2) taken.

The wake stays after the commit, as `appendEvent` already does it. Nobody hears
of an event that did not land.

### 3. An `audit` outbox kind on `SessionDO`

`DurableObjectStore.appendAudit` calls `AuditDO.append` from the Worker, so a
removal's audit row is a second-object write after the first object committed —
the shape §9 exists to close, and the half of #117 that has no idempotent write
at all.

`RegistryDO` already solved this for grants: `#auditIntents` turns entries into
`OutboxIntent`s, the guarded write folds them into its own transaction, and
`AuditDO.append` dedupes on the intent id with a `d:<id>` row written in the
entry's transaction. `SessionDO` gains the same `audit` branch in its `#deliver`,
beside `join_code_put` and `join_code_drop`, and the `AUDIT` binding it does not
have yet.

The intent id is a fresh `crypto.randomUUID()` per queued row, as it is in
`RegistryDO`. The dedupe that matters for #117 is not the id — it is the
transaction, which lets only one of two concurrent calls record the member out,
so only one queues audit intents at all. The id covers the outbox's at-least-once
redelivery, which is the job it already does.

Delivery order follows the rule already in force: FIFO, a failing head blocks the
rows behind it, retries back off to the five-minute cap. A removal that emits a
`member_evicted` row and an `invite_revoked` row needs both, in that order.

### 4. #116 — nothing new, just inside the transaction

`seatMember` already decides capacity inside its transaction, and `clearJoinCodes`
already queues its registry drops through the outbox. So "clear the codes if this
seat filled the room" folds into `seatMember`'s existing closure: it is the same
`driver.enqueue` call `clearJoinCodes` makes, against the codes the same closure
can see.

`SeatOutcome` gains `codesCleared: boolean`, so the handler announces what the
store reports it did. `bellman_confirm` then makes no second-object call after the
seat commits, and the failure described in #116 — a member in the room with no
event, no audit row and no `member_id` returned — has no window left to happen in.

This needs no new mechanism and no new store method, which is why it belongs in
this PR rather than waiting for one.

### 5. What stays in the handler

`closeIfEmpty` stays a separate call after the removal, deliberately. Folding the
closing into the removal's transaction would close a room over a member who
joined in the gap — which is the bug its own comment records as already fixed
once, by moving the decision into `closeSessionIfEmpty`. The removal and the
closing are two decisions about two different questions, and the second one
already makes its own atomically.

The handler also keeps: choosing the sentence the caller reads, building the
event and audit bodies, and the early-return heal path, which still restores a
closing an interrupted removal left undone.

## Error handling

Four behaviors `rooms.ts` encodes on purpose survive this change. Each has a long
comment today explaining a trade-off; where the transaction removes the trade-off,
the comment gets rewritten to say so rather than deleted.

1. **The over-revoke bias.** Today the door shuts *before* the member is recorded
   out, so a failure leaves the member in with the door shut rather than out with
   it open — recoverable by minting again, where the other order leaves a door
   open behind someone who believes it shut. Inside one transaction both land or
   neither does, so the ordering stops carrying that weight. The reasoning is kept
   in the comment, because it is what the eviction's *retry* path still rests on.
2. **Leaving a frozen room is never refused.** Freezing refuses sending, joining
   and inviting; it must never trap a member inside. `frozen: "allow"` for leave,
   and now the departure is announced instead of swallowed.
3. **The retry heals the closing.** A removal that died before the close leaves
   the room empty and open; a retry landing on the idempotent path closes it. That
   path stays, and `removed: false` is what identifies it.
4. **Events read in the order a person would tell it** — the member went, then the
   door shut — even where the writes go the other way. One transaction writes both,
   in that order.

A refused call writes nothing and queues nothing. That is the rule the outbox
already states for `setJoinCode` and the guarded grant writes, and it is Review
Focus 2 and 4 of the #59/#62/#69 plan; it applies here unchanged.

## Compatibility

`removeMember` is a new method on `BellmanStore`, so both implementations and the
conformance suite move together — that is what makes the interface a seam.
`updateMember` and `appendEvent` keep their current behavior and their current
callers; nothing else is routed through the new method in this PR.

No stored key layout changes. The `audit` outbox kind is a new `kind` value on
rows in an existing `ob:` queue, read only by `SessionDO.#deliver`. Rolling back
past this change strands any queued `audit` row the same way §9 describes for
`due:outbox`: a build with no `audit` branch throws on the row rather than
skipping it, blocking the queue behind it. The rollback note in §9 gets a line.

## Landing

Four PRs on one branch. Group A is PR 1 and is what this spec designs.

| PR | Closes | Shape |
|---|---|---|
| 1 | #73, #116, #117, #118 | This design |
| 2 | #124, #122, #74, #134 | Four small independent fixes; #124 and #122 each get a contract case |
| 3 | #125, #120 | Measurement only. #120's first step is deciding whether the pool creates the window; if it does, it closes with a note on the stress test |
| 4 | #123 | Only if PR 3's measurement warrants it; its own body says measure the drain first |

PR 2's four do not interact, and none of them touches `rooms.ts`, so they carry no
review risk from each other. PR 3 writes no product code.

## Testing

**The seam.** `tests/helpers/store-contract.ts` gets `removeMember`'s cases, so
`MemoryStore` and `DurableObjectStore` answer identically: the refusals, the
idempotent `removed: false`, a leave succeeding on a frozen room, an eviction
refused on one, the code retired only when live, and nothing written by a refused
call. #122's fix gets a case there too, since the two auth stores disagree today
and the suite does not cover it.

**What only `workerd` shows.** `worker-tests/` gets: a freeze landing mid-removal
(the #118 window), two concurrent leaves on one handle (#117), an `AuditDO` that
refuses after the removal has committed, and a seating that fills the room with
its codes cleared in the same transaction (#116).

**On the assertions.** Every new assertion is run against a deliberately broken
implementation before it is believed — the frozen guard removed, the transaction
split back into two calls, the audit enqueue moved outside the closure. An
assertion that will not go red has not reached the code it names. This is the rule
the #59/#62/#69 plan applied at each step and it applies here.

`npm run verify` before every PR.
