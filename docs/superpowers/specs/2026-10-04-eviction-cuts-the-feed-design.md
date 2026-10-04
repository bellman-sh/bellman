# Eviction Cuts the Feed — Design

Issue: #113. Found during #112's review.

Related: #49 (whose framing names "a member reading a room they were removed
from" as what being wrong would mean), #112 (which documented the current
behaviour rather than changing it), #146 (socket presence),
`2026-09-29-cross-object-atomicity-design.md` (the write this design folds into
an append).

## Problem

An evicted member keeps receiving the room's **new** events for as long as the
room lives.

`bellman_sync` gates on `findMember`, which checks that the handle belongs to
the caller and never looks at `leftAt`:

```ts
// src/rooms.ts — findMember
const m = s.members.find((mm) => mm.memberId === memberId);
if (!m || m.userId !== identity.userId) return undefined;
return m;
```

Neither store filters either — `waitForEvents` takes no member. Reproduced
through the harness during #112's review: evict A, the creator sends a message,
A's `bellman_sync` returns it.

Eviction inherited this from leaving, where it is deliberate and right: you
chose to go, and the history is yours. For eviction it is not. You were removed,
and you keep listening.

**The room socket is the same bug, pushed.** `membersOf` returns every member
with that `userId` and applies no `leftAt` filter, so an evicted member passes
the `/ws` authorization. `SessionDO.fetch` then replays from any cursor they
name, and `#wake` fans every later event out to **every** socket in the room
with no per-socket membership test. On the poll an evictee has to ask; on the
socket the room delivers to them unasked. `store-do.ts` already names the
missing piece — "the use in view being to close the sockets of a member who has
left. Nothing does that yet."

**A second, smaller breakage, already wrong today.** `bellman_send` reports
`delivered_to` from the members active now, under a comment claiming "the field
answers who can read it". `bellman_sync` admits readers by a different
predicate, so the claim is false. This one needs no eviction: it reproduces for
a member who merely left.

## Rulings

These were product questions, not technical ones. Answered 2026-10-04.

### R1 — Eviction cuts the feed. It is not a ban, and not removal-only.

History stays theirs; the future does not. The two rejected answers:

- **Removal only** — reads stay open and the honest fix is to `delivered_to`.
  Rejected: it concedes the thing #49 already called wrong.
- **Ban** — `bellman_confirm` would also refuse a previously-evicted user.
  Rejected for now: a ban is per `userId` while membership is per connection,
  so it needs a scope decision and an undo, or a mis-eviction locks someone out
  for the life of the room. Out of scope, not rejected on the merits.

### R2 — Only a creator's eviction cuts it.

`member_left` and `member_timed_out` both keep the open feed.

A timeout is the server guessing a member is gone, not a decision that it should
be out. `rooms.ts` observes that a timed-out member is "in the same position an
evicted one is in", which is true of *writing* — both redeem a fresh code to
write again. It is not true of reading: cutting on a timeout means a member
thinking hard for ten minutes silently stops seeing the room it is still working
in, and the seat reclaim is already generous for exactly that reason.

The predicate is therefore **"a creator removed you"**, not "you are out" and
not "you left involuntarily".

### R3 — `delivered_to` keeps its value; its comment loses its claim.

After R1 and R2 the readable set is still not the active set: a voluntary leaver
reads and is not listed. So the field goes on reporting the members active now,
and the comment stops saying it answers who can read.

The rejected alternative was making the value match the claim — reporting
departed handles too. It keeps the sentence true at the cost of putting departed
names in a field senders read as the roster.

### R4 — The cut includes the member's own `member_evicted` event.

`bellman_evict`'s description promises "Members see a `member_evicted` event,
the person removed too". So the boundary is inclusive: an evictee reads up to
**and including** the cursor of the event that removed them. They learn why the
feed stopped from the feed itself.

## Decisions

### D1 — The cut point is a cursor on the member record, not a timestamp.

`Member` gains `removedAtCursor?: number`: the cursor of the `member_evicted`
event that removed this member. Absent means "not evicted", which is what every
stored row and every voluntary leaver reads as.

A cursor rather than an epoch because cursors are totally ordered and timestamps
tie. `at` is server-set, but two events in one millisecond are not ruled out, and
on a tie an `at`-based cut either hides the eviction notice R4 requires or admits
whatever else landed in that millisecond. A read boundary should not have a
documented one-millisecond leak.

### D2 — It is written inside the append's own transaction.

`AppendExtras` gains `markRemoved?: string` — the member id to record out at
this event's cursor. `evictMember` passes it on the `member_evicted` append, and
the store sets **both** `leftAt` and `removedAtCursor` in the same transaction
that stores the event.

This is the `creditReport` arrangement, added by #111 for the same reason, and
`store.ts` already states it:

> It is not an optimisation. The stamp and the event have to commit together or
> a due tick can read one without the other.

Substitute "the evictee's next poll" for "a due tick". The alternative —
`updateMember` after the append — is a third RPC that can drop, and a drop
leaves that member with the open feed. That is the bug, now intermittent, which
is worse than the bug.

**This changes the eviction's failure mode, deliberately.** Today `leftAt` is
written before the append, so a failure between them leaves the member out and
unannounced; `bellman_evict`'s description documents that ("the removal still
completes, unannounced"). Folding both writes into the append means a failure
there leaves the member **in**, consistently, and a retry performs the whole
eviction cleanly — the early return keys on `leftAt !== null`, which is still
null. The new failure mode is the more recoverable of the two, and it replaces a
documented line rather than a silent one.

The door still shuts first. `consumeJoinCode` stays ahead of the append, for the
reason already written there: the ordering that fails the other way "leaves a
door open behind someone who believes it shut".

### D3 — The rule lives in `store.ts`, applied by both stores.

A `markRemoved(members, memberId, cursor): Member[] | null` beside
`creditReport`, for its reason: the rule is shared with `MemoryStore` and
belongs to neither store. `null` means "nothing to write" — an unknown member,
or one already carrying a cursor, so a replay or a repeat touches no storage.

Idempotent on the cursor it already holds, not merely on presence: a second
eviction of the same member must not move the cut forward, or a creator could
widen an evictee's window by evicting them again.

### D4 — `bellman_sync` caps, and does not wait.

For a member with a `removedAtCursor`:

1. the returned events are those with `cursor <= removedAtCursor`, and
2. `wait_seconds` is ignored — the slice returns immediately.

The comparison is `<=` and not `<`, which is R4: the cursor held is the
`member_evicted` event's own, and that event is the one thing the evictee most
needs to receive.

Part 2 is not an optimisation either. A cut member whose long-poll still waited
would wake on every append it then hides, turning its 25-second poll into a busy
loop against a room it cannot read. There is nothing for it to wait for: its
feed has a last event, and that event is already in the past.

The returned `cursor` is the capped one, so a client that round-trips it stays
put rather than skipping ahead to events it will never be shown.

### D5 — An evictee gets no socket, and loses the one it has.

The poll is history; the socket is the future. An evictee keeps the first and
loses the second.

**New sockets** — `membersOf` filters members carrying a `removedAtCursor` out
of `memberIds`. An evictee with no other handle in the room then gets
`memberIds.length === 0`, which the Worker already answers 403 Forbidden. No
Worker change, and no new refusal path to get right.

It filters on `removedAtCursor`, **not** on `isActiveMember`: R2 gives a
voluntary leaver and a timed-out seat the open feed, and both have `leftAt` set.

An identity holding one evicted and one live handle keeps its socket, on the
live handle's entitlement. That falls out of the filter rather than needing a
rule.

**Existing sockets** — the same `markRemoved` append closes any socket whose
attachment names only cut members, after `#wake` has delivered the
`member_evicted` frame to it. So the evictee's last frame is the notice that it
was removed, and then the socket closes. `MemoryStore` holds no sockets, so this
half is `SessionDO`'s alone and is pinned in `worker-tests/`.

`connectedAmong` needs no change: it already counts only `isActiveMember`
handles, and an evictee's is not one.

### D6 — Evicting a member who already left does NOT cut their feed.

`evictMember` already early-returns for `leftAt !== null`, writing no
`member_evicted` event — deliberately, so the removal is not announced twice.
The cut rides that announcement (D2), so where there is no second announcement
there is no cut.

That is the right answer rather than merely the convenient one: such a member
left of their own accord, and R2 gives a voluntary leaver the open feed. What
the late eviction is *for* is the door — `leaveRoom` retires no code, so their
seat's code may still be live, and that is what the early return shuts. It
changes who may walk back in, not what the person who walked out may read.

The consequence to state plainly: a creator who wants a departed member's feed
cut cannot get it. They were never able to, and this design does not pretend
to give it to them. If that turns out to be wanted, it is the ban conversation
(R1) rather than an adjustment here.

### D7 — Nothing is filtered inside `waitForEvents`.

The store keeps taking no member. Pushing the cut into the event read would put
a per-member predicate in the one place whose atomicity note says to do nothing
between reading events and registering a waiter, and would owe every store the
same filter. The cap is the handler's, applied to what the store returned.

### D8 — The field does not leave the server.

`removedAtCursor` is not in `publicMember`. A roster already says a member is
departed; which cursor cut them is the server's bookkeeping, and adding it would
tell every member in the room the exact point another member stopped being able
to read — a detail no client needs and the evictee least of all.

## Schema

### `src/types.ts`

```ts
export interface Member {
  // ...
  /**
   * The cursor of the `member_evicted` event that removed this member, if a
   * creator removed them. Absent on a member still in the room, one who left
   * of their own accord, one whose seat timed out, and every row stored before
   * this field existed — all of which keep the open feed (#113, R2).
   */
  removedAtCursor?: number;
}
```

No lifting accessor, unlike `lastSeenAt` and `lastReportAt`. Those lift absence
to `joinedAt` because reading `undefined` as "never" would have been actively
wrong. Here absence *is* the answer: not cut.

### `src/store.ts`

```ts
export type MemberPatch = Partial<
  Pick<Member, "brief" | "capabilities" | "leftAt" | "lastSeenAt" | "lastReportAt">
>;
// removedAtCursor is deliberately NOT patchable: D2 makes it the append's to
// write, and a patch route would be the second way to write it.

export interface AppendExtras {
  creditReport?: boolean;
  /** Record this member out at the event's own cursor. See D2. */
  markRemoved?: string;
}

/**
 * Record `memberId` out at `cursor`: sets `leftAt` AND `removedAtCursor`
 * together, because D2 makes them one write. `null` when there is nothing to
 * write — an unknown member, or one already carrying a cursor.
 */
export function markRemoved(
  members: Member[],
  memberId: string,
  cursor: number,
  at: number,
): Member[] | null;

/** Whether a creator removed this member, so its feed is cut (#113). */
export const isRemovedMember = (m: Member): boolean =>
  m.removedAtCursor !== undefined;
```

### `src/store-do.ts`

`SessionDO.appendEvent` and `appendEventOnce` apply `markRemoved` in the same
transaction as the event, beside `reportRow`. `membersOf` filters on
`isRemovedMember`. A socket-closing step runs after `#wake`.

## The read path

```
bellman_sync(session_id, member_id, since_cursor, wait_seconds)
  |
  findMember  -> unchanged: the handle must belong to the caller
  |
  touchMember -> unchanged: refused for closed, frozen, and departed already
  |
  me.removedAtCursor === undefined ?
  |                        |
  | yes                    | no  (cut)
  |                        |
  waitForEvents(...)       events up to removedAtCursor, no wait   (D4)
  |                        |
  +--------- filter own events, wrap untrusted, return ------------+
```

## Testing

Tool level (`tests/tools/evict.test.ts`), through the real handlers:

- Evict A, creator sends a message, A's `bellman_sync` does not return it. This
  is #113 itself, and it is the test that must be red first.
- A's `bellman_sync` still returns the history, including its own
  `member_evicted` event (R4), and the returned cursor is the capped one.
- A's `bellman_sync` with `wait_seconds` set returns at once rather than holding
  the poll open (D4). Timed, so a cap that forgot the wait is red.
- A member who **left** still receives new events, and so does one whose seat
  **timed out** (R2). These are the tests that keep the fix from widening into
  the thing R2 rejects.
- A second eviction of the same member does not move the cut (D3).

Store contract (`tests/helpers/store-contract.ts`), so both implementations
answer identically:

- `markRemoved` sets `leftAt` and `removedAtCursor` together, at the appended
  event's own cursor.
- An unknown member id writes nothing; a repeat writes nothing.
- A frozen room appends nothing and records nothing out — the two go together,
  which is D2's whole claim.

Worker (`worker-tests/`), where sockets are real:

- An evicted member's `/ws` upgrade is refused 403 (D5).
- A departed-by-choice member's upgrade still succeeds (R2 on the socket arm).
- A socket open at the moment of eviction receives the `member_evicted` frame
  and is then closed (D5).
- An identity holding one evicted and one live handle keeps its socket.

Every test is to be run against a broken implementation before it is trusted.

## Out of scope

- **A ban.** R1. An evictee still rejoins on a live code with a new handle, and
  `bellman_evict`'s description says so.
- **Closing a departed member's sockets.** D5 closes an *evicted* member's. A
  voluntary leaver keeps its feed by R2, so it keeps its socket.
- **Making `delivered_to`'s value match its old claim.** R3.
- **Filtering in the store.** D7.

## Documentation owed

- `bellman_evict`'s description: the paragraph beginning "Reads stay open to the
  person removed" currently promises the behaviour this design removes. It must
  say that history stays readable and the feed stops, and that a socket is
  refused.
- `bellman_sync`'s description and its `readOnlyHint` comment, which lists who
  reads stay open to.
- `delivered_to`'s comment in `bellman_send` (R3).
- `docs/ARCHITECTURE.md` if it states the membership predicate.
