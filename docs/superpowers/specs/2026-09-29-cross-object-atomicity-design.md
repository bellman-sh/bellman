# Cross-Object Atomicity — Design

Status: approved design, pending implementation plan
Closes: #59 (the audit outbox, its remaining half), #62, #69
Related: ARCHITECTURE.md §9, which names the pattern this implements
Citations: by symbol rather than line, and of the code as it stood when this was
written. This work has since changed `/admin/grants`, `reconcilePurchase`, the
join-code methods of `DurableObjectStore`, and `SessionDO.alarm()`.

## Problem

**A Durable Object's input gate covers one invocation. Nothing spans two.**

Bellman's state is split across four object types, and an operation touching two
of them has a window in the middle. That one fact has produced three separately
filed bugs. They are not one bug, and they do not have one fix — they split into
two halves that need different mechanisms.

### The ordering half — #69

`reconcilePurchase` runs in the Worker, between two objects:

```
AuthDO (ledger)            RegistryDO (grants)
  syncSubscription() ──┐
                       └─> paidPlan() ──┐
                                        └─> putGrantIfSource() / deleteGrantIfSource()
```

`BillingLedger` serializes per customer and per user, but that queue is released
when `syncSubscription` returns. Two webhook deliveries can then both call
`paidPlan` and race their separate grant writes, so an older `active` result
lands *after* a concurrent cancellation deleted the grant — leaving paid access
for a plan nobody is paying for.

It does not heal. Stripe sends `customer.subscription.deleted` once. If the
losing write lands after it, nothing corrects it unless that customer has another
subscription event.

A monotonic revision on the grant does not close it: the dangerous case is an
older write landing after a *delete*, and a delete leaves nothing to compare
against short of tombstones.

### The loss half — #59, #62

A durable mutation commits in one object, and the write that must accompany it
lands in another. Lose the second and nothing anywhere records that it was owed.

**#59 — `RegistryDO` → `AuditDO`.** Two instances:

- `/admin/grants` (its `POST` and `DELETE` branches in `src/oauth/routes.ts`)
  commits the grant change, then calls `appendAudit`. If that fails the caller
  gets a 500 with the grant already changed. Retrying `DELETE` returns `missing`
  → 403, and the `plan_revoked` record is gone permanently.
- `reconcilePurchase` (`src/billing/grants.ts`) deletes, then audits. Stripe
  retries the webhook; `deleteGrantIfSource` returns `missing` because the delete
  already succeeded, so the audit is skipped. Permanently, and silently — the
  org's audit trail is missing a billing revocation with nothing to indicate it.

Reordering does not help. Auditing first produces a `plan_revoked` line for a
revocation that may never happen, which is the bug #44 already fixed on the
admin path.

**#62 — `SessionDO` → `RegistryDO`.** Narrower than the issue states, and the
issue's own cheapest option turns out to be most of the answer. `lookupJoinCode`
has exactly one caller, `DurableObjectStore.getSessionByJoinCode` in
`src/store-do.ts`, and that re-reads the session and requires the code to still
match a live `joinCodes` entry. A **stale** `jc:` row is therefore already
inert, so the consume and rotate windows in #62's table are closed today.

What remains is the opposite direction. `DurableObjectStore.createSession` and
`DurableObjectStore.setJoinCode` (`src/store-do.ts`) commit the session first,
then call `putJoinCode`. Lose that second call and the session holds a code
nothing can resolve — nobody can join the room — with no scan that could find
it, because a DO namespace cannot be enumerated.

### Why one piece of work

ARCHITECTURE.md §9 already records the shape: *the object that owns the
serialisation performs the whole operation and calls the others itself. It has
the bindings; the Worker is the wrong place to hold a lock.*

Three ad-hoc patches would leave three retry schemes and three dedupe rules
drifting apart, with nothing able to hold them to one shape. #62 in particular
would get the weakest fix purely because it is the cheapest to write.

## Scope

**In scope:** `src/outbox.ts` (new), `RegistryDO`, `SessionDO`, `AuditDO`,
`AuthDO`, `BillingLedger`, `BellmanStore` and `MemoryStore`, the admin grant
routes, `src/billing/grants.ts`, `src/billing/stripe.ts`, the contract suite and
`worker-tests/`.

**Out of scope:**

1. **Pruning audit or dedupe rows.** Nothing prunes audit entries today; the
   `d:` rows added here grow at the same rate as the entries they guard. A
   retention policy is a separate decision about the audit log itself.
2. **A general distributed transaction.** The outbox gives at-least-once
   delivery with idempotent application. It does not give rollback, and nothing
   here needs it.
3. **`createSession`'s second cross-object write.** The comment in
   `DurableObjectStore.createSession` (`src/store-do.ts`) notes another registry
   write on the same path, `indexSession`. It is the same class and the outbox
   will serve it, but it is not one of the three filed bugs and is left for a
   follow-up so this diff stays reviewable.

## Design

### 1. Named alarms

A Durable Object has exactly one alarm. `SessionDO.alarm()` (`src/store-do.ts`)
is already the session TTL, armed to `s.expiresAt` in `createSession`. An outbox
drain calling `setAlarm(now + backoff)` would overwrite a TTL armed for tomorrow
and sessions would stop expiring — silently, because nothing reads an alarm back.

So the alarm is multiplexed over named due times:

```
due:<name> → timestamp
```

`alarm()` runs whichever handlers are due, then re-arms to the earliest
remaining. Each handler sets its own next due time rather than `alarm()` clearing
the row, so a handler that throws is retried instead of forgotten. Handlers must
therefore be idempotent, which both of ours are.

**`SessionDO`'s TTL is computed, not stored.** Its due set is
`{ ttl: s.expiresAt, ...storedDueRows }`. Sessions deployed before this change
have no `due:` rows; re-arming purely from stored rows would drop the TTL for
every live session on the first deploy, and it would surface weeks later as rooms
that never expire. Deriving TTL from the session record it already lives in means
there is no migration step to forget.

### 2. `src/outbox.ts`

Runtime-free, storage injected — the same split `BillingLedger` uses against
`AuthDO`, and `src/oauth/storage.ts` uses for shapes. The key layout, FIFO order,
backoff and re-arm rule live here where plain vitest reaches them; the Durable
Object supplies `get` / `put` / `delete` / `list` / `setAlarm`.

```
ob:<paddedSeq> → { id, kind, payload }
ob_seq         → counter
```

`ob_seq` sits outside the `ob:` prefix deliberately. A counter inside the prefix
it tracks is listed by its own drain and can be set to itself — the trap already
commented for the OAuth purge cursor, in `AuthDO.purge` (`src/oauth/store.ts`).

**Delivery is enqueue-in-transaction, attempt inline, alarm as backstop.**

1. The outbox row is written as one more `txn.put` inside the mutation's existing
   `ctx.storage.transaction()`. The mutation and the intent to follow it up
   commit together or neither does. This is the whole point.
2. Immediately after the transaction commits, delivery is attempted inline and
   the row deleted on success.
3. If that fails or never runs, the alarm drains it with backoff.

A pure outbox would be wrong for #62: `createSession` would return before the
join code was registered, so handing someone a code immediately after creating a
room would fail until the drain ran. The inline attempt keeps latency identical
and means the alarm almost never fires. The durable row is what closes the
window.

**Head-of-line blocking is intended.** Rows are delivered in key order and a
failing head blocks those behind it. An audit stream that reorders around a stuck
entry is worse than one that stalls.

Backoff doubles from 1s to a 5-minute cap, and the attempt count lives on the
row. From the 5th attempt on, every failure logs to `console.error` with the
intent id, target and attempt count — it keeps retrying rather than parking,
because a permanently failing downstream object is an outage, not a poison
message. Nothing is ever dropped.

### 3. #59 — `RegistryDO` → `AuditDO`

The four guarded grant writes take an audit intent and compute the entries
themselves:

```ts
putGrantIfOwned(grant, expectedOrgId, audit: AuditIntent): Promise<"written" | "conflict">
deleteGrantIfOwned(key, expectedOrgId, audit: AuditIntent): Promise<"deleted" | "missing" | "conflict">
putGrantIfSource(grant, expectedSource, audit: AuditIntent): Promise<GrantWrite>
deleteGrantIfSource(key, expectedSource, audit: AuditIntent): Promise<GrantDelete>

interface AuditIntent {
  actorUserId: string;
  detail?: Record<string, unknown>;
}
```

`RegistryDO` is the only thing that knows `previous` and `removed` at commit
time, so the rule both callers implement separately today moves next to the
mutation:

- emit nothing when `plan`, `role`, `orgId`, `source` and `expiresAt` all match
  the previous grant. Billing's own `samePlan` compares only the first three
  today, which is sufficient there because `purchaseGrant` fixes `source` and
  `expiresAt`. It is not sufficient for the admin route: a `source` change can
  take a grant out of billing's hands — after it, `putGrantIfSource(…,
  "purchase")` returns `conflict` and the subscription can never update or
  revoke that grant again — and an `expiresAt` change moves the day somebody
  loses access. `grantedAt` and `grantedBy` stay out: the first is `Date.now()`
  on every write, so comparing it would record every redelivered Stripe event,
  and the second is already carried as the entry's actor;
- emit `plan_revoked` to the old org when `orgId` moved;
- emit `plan_granted` to the new org.

`recordGrantAudit` (`routes.ts`) and `auditPurchase` (`grants.ts`) both collapse
into it, and neither caller audits on the grant path any more. What stays
caller-specific is exactly what differs today: `actorUserId` (`"stripe"` versus
the admin's user id) and detail extras (`stripe_customer`, `reason`).

**Who fills which detail fields.** The store fills the grant-derived ones it can
see — `key`, `plan`, `role`, `org_id`, `source`, and `replaced_plan` when there
was a previous grant. `AuditIntent.detail` is merged on top, into *every* entry
the operation emits, so a `reason` accompanies both halves of an org move. A
caller cannot overwrite `key`; everything else it names wins, which is what lets
billing say `reason: "subscription no longer paying"` on a revocation the store
would otherwise describe only in terms of the grant.

The cost of this is that the store learns the grant-audit policy. That is
accepted: the policy was already uniform, and keeping two copies of it in step
across the admin and billing paths is what produced the divergence #68 found.

**Intent ids are generated at enqueue, not supplied by callers.** A Stripe retry
never reaches the store twice: `deleteGrantIfSource` returns `missing` and
enqueues nothing, while the first row is still durable. The id exists to make the
*drain* idempotent, not the caller.

**Dedupe lands in `AuditDO`.** `append(entry, intentId)` writes a `d:<intentId>`
row in the *same* `ctx.storage.put({...})` as the entry and `seq` — the one-write
idiom `AuditDO.append` already uses (`src/store-do.ts`), and for the same reason.
If the row exists, the append is a no-op.

**`MemoryStore` delivers inline.** It is one process and there is no gap to
protect. The contract suite asserts the end state both implementations owe —
entries visible through `auditForOrg` — not the mechanism. The drain itself is
only reachable in `worker-tests/`. That seam is real and is named here rather
than papered over.

### 4. #62 — `SessionDO` → `RegistryDO`

`SessionDO` gains the `REGISTRY` binding (`extends DurableObject<BellmanEnv>`)
and owns join-code registration end to end. `createSession` and `setJoinCode`
enqueue `putJoinCode` inside the session write's transaction, closing the
missing-entry direction — the only half `getSessionByJoinCode`'s re-read does not
already cover.

`consumeJoinCode` and `clearJoinCodes` enqueue `dropJoinCode` through the same
path. Those are already inert if lost, so this is about not leaking `jc:` rows in
the singleton registry rather than about correctness.

The facade's join-code branches in `DurableObjectStore` (`createSession`,
`consumeJoinCode`, `clearJoinCodes` and `setJoinCode`, in `src/store-do.ts`) go
away.

### 5. #69 — `AuthDO.reconcile`

`BillingLedger.serial` becomes `serializeUser(userId, work)`. `AuthDO.reconcile`
runs the whole reconcile inside it, against a `PurchaseGrantStore` facade over
`this.env.REGISTRY` — the same three-method interface `grants.ts` already
declares, so `reconcilePurchase` itself is unchanged:

```ts
// AuthDO extends DurableObject<BellmanEnv>
private get grants(): PurchaseGrantStore {
  return this.env.REGISTRY.get(this.env.REGISTRY.idFromName("registry"));
}

reconcile(userId: string): ReturnType<typeof reconcilePurchase> {
  return this.ledger.serializeUser(userId, () =>
    reconcilePurchase(userId, this.ledger, this.grants)
  );
}
```

`PurchaseGrantStore` loses `appendAudit` as part of §3 — the store audits now —
so the facade is just the two guarded writes, which `RegistryDO` already exposes
over RPC.

`stripe.ts`'s `settle()` calls that instead of running `reconcilePurchase`
itself. `paidPlan` and the grant write now happen under one lock, so a
cancellation cannot be overtaken by an older `active` read.

Lock ordering stays acyclic: `linkCustomer` takes customer-then-user, `reconcile`
takes user only, and nothing in `RegistryDO` calls back into `AuthDO`. The
ledger's queue is in-memory and only serializes because there is exactly one
`AuthDO` — already true and already documented on `BillingLedger`'s `queues`
field (`src/billing/ledger.ts`). `reconcile` inherits that property rather than
changing it.

## Error handling

| Failure | Result |
|---|---|
| Inline delivery fails | Row stays; alarm retries with backoff. The caller still succeeds — the mutation is committed and the intent is durable. |
| Isolate dies after commit, before inline delivery | Alarm drains it. This is the bug being fixed. |
| Downstream keeps failing | Head-of-line blocking, backoff, `console.error` with intent id and target after N attempts. |
| Drain acks twice | `d:<intentId>` makes the second append a no-op. |
| Guarded write returns `conflict` | Nothing enqueued. A rejected write leaves no audit trace. |
| Two concurrent reconciles | Serialized by `serializeUser`; the later ledger state wins. |

## Compatibility

No persisted type gains a field. `PlanGrant`, `Session` and `AuditEntry` are
unchanged; outbox rows and `d:` dedupe rows are new keys. That is the check
ARCHITECTURE.md §9 asks for on its second class of bug — a persisted type that
gains a field is silently a union with `undefined` for as long as old records
live, and this change does not create one.

The TTL derivation in §1 is the only migration concern, and it is avoided by
construction rather than handled.

## Landing

One design, but not one pull request. #44 ran to five review rounds because it
was +888/−29 across OAuth, plan precedence, an admin API, a storage index, org
tenancy and audit — and almost every finding landed on a seam between two of
those. This spec covers four object types and a new module, which is the same
shape unless it is split.

Three PRs, in order, each independently mergeable:

1. **The mechanism.** `src/outbox.ts` and named alarms, with the plain-vitest
   suite and the `setAlarm` probe. No caller adopts it yet, so `SessionDO`'s TTL
   moving to a computed due set is the only behaviour change — and it ships
   alone, where the TTL regression test is the whole point of the diff.
2. **#59.** The four guarded writes take an `AuditIntent`, `AuditDO` dedupes,
   both callers stop auditing. The largest of the three, and the one that moves
   policy between layers.
3. **#62 and #69.** Both are adoptions of a mechanism already merged and
   reviewed: `SessionDO` gains a binding and enqueues, `AuthDO` gains
   `reconcile`. They touch disjoint files and can land together or apart.

## Open question, resolved by probe before implementation

Whether `ctx.storage.setAlarm()` inside `ctx.storage.transaction()` commits
atomically with it in SQLite-backed Durable Objects. If it does not, an isolate
dying between commit and arm leaves rows sitting until the next enqueue.

This is not assumed. The plan opens with a throwaway probe in `worker-tests/`
that arms an alarm inside a transaction, aborts the object, and asserts
`getAlarm()`. If it fails, the fallback is to re-arm opportunistically on the
next RPC into the object.

## Testing

**Plain vitest on `src/outbox.ts`** — FIFO order, delete-after-ack, re-arm only
while rows remain, backoff growth, head-of-line blocking, and named-alarm
arithmetic (earliest wins; clearing one re-arms to the other).

**Contract suite** (`tests/helpers/store-contract.ts`) — both stores owe the same
observable end state: entries present after a guarded write, nothing after a
conflict, two entries on an org move, none on a no-op.

**`worker-tests/`** — the only place the wiring is real:

- the `setAlarm`-in-transaction probe above;
- `abortAllDurableObjects()` between commit and inline delivery, then
  `runDurableObjectAlarm` to prove recovery;
- double-drain dedupe;
- #62: a join code resolving after an aborted registration;
- #69: two concurrent reconciles settling on the later ledger state;
- the TTL regression from §1 — enqueue an outbox row, drain it, assert the
  session still expires.

### On the assertions themselves

Four of these are absence assertions — "no entries on conflict", "not delivered
out of order", "one entry after draining twice" — and every one passes for free
if the audit path does nothing at all.

Each is therefore written as an exact match over `auditForOrg(org)`, so a
positive fact sits inside the same assertion as the absence and it fails in both
directions. And each is run against a deliberately broken implementation, with
the failure quoted, before it counts as verification.

This is not a general precaution. It is the specific failure that produced five
false greens across issue #36 and fifteen vacuous assertions on issue #1, and the
absence assertion satisfied by a no-op is the exact shape both times.
