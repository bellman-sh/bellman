# Idempotent Event Append — Design

Status: approved design, pending implementation plan
Closes: #79, for the `bellman_send` half
Related: #59 (audit outbox) — wants this marker as half of its machinery
Defers: the billing `putGrant` half of #79, see **Out of scope**

## Problem

`bellman_send` has no way to tell a retry from a new message.

A client whose connection drops, or whose tool call is replayed after a timeout,
calls `bellman_send` again with the same content. The store appends a second
event with a new cursor, `bellman_sync` hands it to the peer, and the peer's
human reads the same message twice. Nothing anywhere detects it.

We have already paid for the absence of this once. Stripe redelivers events, and
#68 shipped a round where a redelivered `customer.subscription.updated` appended
a second `plan_granted` audit line for a change that had not happened. The fix
there was specific to that call site: compare the previous grant, skip the audit
when nothing moved. `bellman_send` has the same hole and no such fix.

An idempotency key generalises it: the caller names the write, and a repeat is a
no-op that returns the original result.

## Scope

**In scope:** `bellman_send`, `BellmanStore`, and both store implementations.

**Out of scope, deliberately:**

1. **`putGrant` on the billing path.** #79 observes that `RegistryDO` "would
   want the same," with the Stripe event id as the key we already have and
   currently throw away, and that `reconcilePurchase`'s `samePlan` check becomes
   redundant once it does. True, and a separate change: it touches `RegistryDO`,
   the webhook, and the grant audit rules, and billing already has a working
   guard where sends have none. Filed as a follow-up.
2. **The #59 outbox marker.** An idempotency marker is half of what the audit
   outbox needs — it is what lets a retry finish an audit it cannot tell has
   already happened. This spec builds the marker for events; generalising it to
   a standalone primitive is #59's decision to make, once it knows its own
   shape.

## Decisions

### D1 — A new method, not an optional parameter on `appendEvent`.

#79 writes the signature as `appendEvent(sessionId, e, idempotencyKey?)` with
the existing `Promise<SessionEvent | null>` return. That return cannot carry the
answer: `null` already means *frozen*, and the caller now has to distinguish
four outcomes — appended, replayed, frozen, and a key reused for different
content. Widening the return reaches all five existing call sites and every
`appendEvent` assertion in the contract suite, to serve one of them.

```ts
export interface EventWrite {
  outcome: "appended" | "replayed" | "frozen" | "conflict";
  /** Set for "appended" and "replayed". Absent otherwise. */
  event?: SessionEvent;
}

appendEventOnce(
  sessionId: string,
  e: Omit<SessionEvent, "cursor" | "at">,
  idempotencyKey: string
): Promise<EventWrite>;
```

`appendEvent` keeps its signature and its five callers. This is the shape the
grant methods already use: `putGrant` has four guarded siblings, each naming its
guarantee in its name and arguing for it in its doc comment, rather than one
method with a widening parameter list. The key is required here, not optional —
a caller that does not want the guarantee calls the other method.

### D2 — The key namespace is per-member, not per-session.

Scoped to `(sessionId, fromMemberId)`. Clients generate keys locally with no
coordination between them. Under a session-wide namespace, two peers that both
number their sends from 1 collide on their first message: B's send returns A's
event, B believes it was delivered, and the failure presents as a lost message
rather than as an error. The store scopes internally — the event already carries
`fromMemberId`, so nothing is added to the signature.

### D3 — A reused key with a different payload is an error.

`conflict`, surfaced as a tool failure naming the key. This is Stripe's own
semantics and the honest reading: a key reused for different content is a client
bug, and returning the stored event silently tells the caller that message B was
delivered when A was. The cost is that the store must remember enough to
compare, which D4 answers.

### D4 — The fingerprint sorts object keys recursively.

`fingerprint(e)` covers the parts of an event a retry must reproduce: `type`,
`refId`, `fromMemberId`, and `payload`. Object keys are sorted at every depth
before serialization.

Sorting is not cosmetic. `JSON.stringify` preserves insertion order, and a
retrying client may rebuild its payload object rather than hold the original —
same content, different key order. Unsorted, an honest retry reads as a
`conflict`, which is the one outcome that tells the caller to stop retrying.

### D5 — The key check precedes the frozen check.

Order inside `appendEventOnce`:

1. unknown session → throw, as `appendEvent` does
2. key hit, fingerprint matches → `replayed`, with the stored event
3. key hit, fingerprint differs → `conflict`
4. session frozen → `frozen`
5. otherwise → append, record `key → cursor`, wake waiters → `appended`

A write that already succeeded keeps reporting its result even if the room froze
afterwards. A replay appends nothing, so nothing new enters a frozen room, and
the freeze invariant is untouched. Frozen-first would make a retry across a
freeze look like a failure the client has no way to resolve — it cannot tell
whether its first attempt landed, which is the entire reason it is retrying.

`conflict` outranks `frozen` for the same reason: a reused key is a client bug
and should say so rather than be masked by room state.

### D6 — Keys live and die with the session.

No independent expiry and no `sweep()` entry. Events are already scoped to a
session and sessions expire, so the keys inherit both.

`MemoryStore` keeps a `Map<string, IdempotencyRecord>` on the session record,
dropped when the session is. `SessionDO` writes `ik:` rows into its own storage,
which go when the object does — the TTL alarm already governs that.

Both store the fingerprint beside the cursor rather than recomputing it from the
event that cursor names. Recomputing would save a field and cost a second read
on `SessionDO` for every keyed send, and it would couple the dedup check to the
stored event's serialization: a later change to how events are stored could make
honest retries read as `conflict`, which is the one outcome that tells a client
to stop retrying.

### D7 — The key is not written onto the `SessionEvent`.

It is an internal dedup index, not content. Putting it on the event would ship
one client's key across to the peer, where it means nothing and can only be
noise or a leak.

### D8 — The audit line is written only on `appended`.

`bellman_send` appends and then calls `audit(...)`. A replay that suppressed the
event but not the audit line would leave the audit log growing on retries — the
same bug #68 shipped, moved one layer down. Distinguishing `appended` from
`replayed` is what the outcome enum is for; this is the call site that needs it.

### D9 — `brief_update` moves its member write after the append.

`bellman_send` currently calls `s.updateMember(...)` for `brief_update` *before*
appending. That is already slightly wrong: a frozen room writes the brief and
then throws `FrozenError`. With a key it gets worse — a `conflict` would mutate
the member before failing, so a client bug would half-apply. Moving the call
after a successful append fixes both, and is in the code this change touches
anyway.

A `replayed` outcome skips the brief write as well, for D8's reason: the original
call already made it, and re-applying it on every retry is the same needless
write as a second audit line.

### D10 — `idempotentHint` stays `false`.

`bellman_send` is idempotent only when a key is supplied. The MCP annotation is
a static boolean and cannot say that, so the honest value is the one that does
not over-promise.

## Schema

### New module (`src/idempotency.ts`)

Runtime-free, beside the stores, the role `grant-index.ts` plays for grant keys:
anything importing `cloudflare:workers` cannot be imported by a vitest test, so
the shape lives in a module both stores and the test suite can reach.

```ts
/** Per-member storage key. D2. */
export const idempotencyKey = (memberId: string, key: string): string;

/** Canonical print of the parts a retry must reproduce. D4. */
export function fingerprint(e: Omit<SessionEvent, "cursor" | "at">): string;

/** What a remembered key resolves to, in both stores. D6. */
export interface IdempotencyRecord {
  cursor: number;
  print: string;
}
```

### Store (`src/store.ts`)

`EventWrite` as in D1, exported beside `GrantWrite` and `GrantDelete`.
`appendEventOnce` on `BellmanStore`.

Each implementation grows a private synchronous append primitive that both
`appendEvent` and `appendEventOnce` call. `MemoryStore` cannot
`await this.appendEvent(...)` between the key check and the write: the await
yields, and a second call for the same key can read the same empty slot in the
gap. That is the rule `liveGrant` exists to enforce and the one `waitForEvents`
is declared non-`async` for.

### `SessionDO` (`src/store-do.ts`)

`ik:<memberId>:<key>` → `IdempotencyRecord`. Reachable from the same invocation
as the append, which is where the atomicity comes from — the property #71
relied on for the frozen guard.

## The write path

`bellman_send` gains one optional argument:

```ts
idempotency_key: z.string().min(8).max(80).optional()
```

The floor of 8 matches `connect_token`. A one-character key is legal under D2's
namespace but invites a client colliding with its own earlier send, which is the
one collision per-member scoping does not prevent.

With no key, the handler calls `appendOrFrozen` and behaves exactly as today.
With a key, it calls `appendEventOnce` and maps the outcome:

| outcome    | response                                                        |
|------------|-----------------------------------------------------------------|
| `appended` | `{ delivered_to, cursor }`, audit line written                   |
| `replayed` | `{ delivered_to, cursor, replayed: true }`, no audit line        |
| `frozen`   | the existing `FROZEN` failure                                    |
| `conflict` | a failure naming the reused key and saying to pick a new one      |

`replayed: true` is on the response so the calling agent knows this is not a
fresh delivery and does not announce the message to its human a second time.

`delivered_to` on a replay lists the members active *now*, not the ones active
when the event was first appended. It is the same computation as the fresh path
and no history is kept to do better; the field answers who can read it, which is
the question the caller is asking either way.

## Testing

`tests/helpers/store-contract.ts` carries the weight, because it is what makes
the two implementations agree rather than merely both compile. New cases:

- a second call with the same key and content returns `replayed` and the same
  cursor, and the session holds one event
- the same key with different content returns `conflict`, and appends nothing
- two members using the same key each get their own event (D2)
- a key whose write succeeded still `replayed`s after the session is frozen (D5)
- a fresh key against a frozen session returns `frozen`
- an unknown session throws, matching `appendEvent`

`src/idempotency.ts` gets unit tests directly: the fingerprint is stable under
object key reordering at depth, and differs when `type`, `refId`, `fromMemberId`
or `payload` differ.

Tool level, through `tests/helpers/harness.ts`: two identical `bellman_send`
calls sharing a key produce one event in the peer's `bellman_sync`, one audit
line, and a second response carrying `replayed: true`. A third call reusing that
key with a different payload fails.

Every new assertion is run against a deliberately broken implementation before
it counts as verification — an assertion that has never been seen to fail is not
evidence.

## Out of scope

Two follow-ups, both named in #79 and neither blocked by this:

- **Idempotent `putGrant`** keyed by the Stripe event id, which retires the
  `samePlan` comparison in `src/billing/grants.ts`.
- **#59's outbox marker**, if it wants this generalised beyond events.
