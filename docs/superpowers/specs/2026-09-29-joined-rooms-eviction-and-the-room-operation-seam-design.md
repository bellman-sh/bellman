# Joined Rooms, Eviction, and the Room-Operation Seam — Design

Status: approved design, pending implementation plan
Advances: #49, for the store gaps and the shared authorization layer
Related: #48 (the panel's browser session), #28 (MCP Apps wants the same read layer),
#12 (the contract suite that keeps the two stores honest)
Defers: every HTTP route in #49, audit filtering to #58, the operator prefix to #61's
trigger, and `getSession`'s event loading to #25 — see **Out of scope**

## Problem

#49 asks for an HTTP API the control panel can read rooms through. Underneath
the routes it names three gaps, and two of them are in the store:
`sessionsJoinedBy` does not exist, and nothing removes a member. The third —
audit filtering — belongs to #58.

The routes are not the hard part. The hard part is the sentence #49 puts under
"Worth deciding": an HTTP layer that reaches `BellmanStore` directly "will drift
on exactly the checks that matter." Those checks live inside the MCP tool
handlers in `src/server.ts` — a 936-line file where each of eight tools opens
with its own `getSession`, its own frozen guard, its own `findMember`, its own
`denyVerb`, and closes with its own `appendEvent` and `audit`. A second
transport re-typing that sequence would be a second chance to get it wrong, on
the paths where being wrong means a member reading a room they were removed
from.

So this spec does the two store gaps and extracts the sequence, and stops short
of the routes. The routes then have one thing to call.

### What changed since #49 was filed

#49's "What already exists" table is out of date, and its own first comment says
so. Since then:

- **#44 merged.** `sessionsCreatedBy`, the grant methods, `resolvePlan`,
  `GET /account` and `/admin/grants` are on `main`.
- **`freezeSession` is on `main`** in `BellmanStore`, though #47 closed
  unmerged.
- **#12 closed.** The contract suite now runs against `DurableObjectStore`
  inside workerd as well as `MemoryStore`, so a new store method is proven on
  both implementations or on neither.
- **#61 closed as decided.** Operator authority is a separate credential under a
  separate prefix, never a role on a customer session. That constrains the
  routes, not this spec, but it is why no part of this one takes an `orgId`
  parameter.

## Scope

**In scope:** `sessionsJoinedBy` on both stores, eviction as an authorized
operation with a new `bellman_evict` tool, and `src/rooms.ts` — the operation
layer that `src/server.ts` and the future routes both call.

**Out of scope, deliberately:**

1. **Every HTTP route in #49.** `/api/rooms`, `/api/rooms/:id`, the events
   timeline, invite reissue and revoke over HTTP, close, and the audit views.
   They need #48's cookie session to have a credential at all, and they need a
   pagination convention that rooms, events and audit should agree on once
   rather than three times. Neither is decided; both are cheaper to decide with
   `src/rooms.ts` already sitting there.
2. **Audit filtering.** #49 lists no cursor, no date range and no filters on
   `auditForOrg`. All true. #58 owns query, export, streaming and retention
   together, and #61 made its tamper evidence a requirement of operator reads —
   a filter primitive designed here in isolation would be redesigned there.
   `auditForOrg` keeps its signature.
3. **A types-only package export.** #49 is right that the panel will otherwise
   hand-copy `src/types.ts`. It is also a packaging change to
   `@bellman-sh/mcp-server` with no consumer until the panel exists.
4. **A creator-facing close operation.** `POST /api/rooms/:id/close` is a route,
   and closing already happens when the last member leaves. Building a public
   `closeRoom` with no caller would be speculation; see D12.

## Decisions

### D1 — `sessionsJoinedBy(userId, limit)` returns ids, mirroring `sessionsCreatedBy`.

`Promise<string[]>`, not `Promise<Session[]>`, and no status parameter. The
existing creator listing already sets this shape and the panel already has to
call `getSession` per id to render anything. A store method that filtered by
status would be encoding one screen's idea of "active" into the storage
boundary, and the two callers that want the listing — the panel and the freeze
sweep — do not agree on what to exclude.

### D2 — The index is `um:<userId>:<sessionId>` on RegistryDO, written at the Worker boundary.

`DurableObjectStore.addMember` calls `SessionDO.addMember` and then
`registry.indexMembership(member.userId, sessionId)`, exactly as `createSession`
already calls `registry.indexSession`.

Injectivity holds for the reason the `us:` comment gives: two variable segments,
and neither can contain the separator. A user id is `u_[A-Za-z0-9_-]+` and a
session id is `qs_<uuid>`.

This is a second write into a second object with no transaction spanning it —
the gap ARCHITECTURE.md section 9 describes and #62 tracks. Two reasons to join
that class rather than solve it here:

- **The failure is a listing, not a membership.** `SessionDO.members` remains
  authoritative and is unaffected by a lost index write. A member whose index
  entry never landed is fully in the room; they are missing from one screen,
  and the entry is reconstructible from the session itself.
- **One pattern beats two.** ARCHITECTURE.md prescribes "the object that owns
  the serialisation performs the whole operation and calls the others itself,"
  and that is the right end state. Applying it to `addMember` alone would mean
  giving `SessionDO` a RegistryDO binding it does not have, while
  `createSession` kept the old shape — two mechanisms for one bug, and a harder
  #62. It also would not make the write atomic: a crash between the two puts
  loses the index either way.

Write the reasoning into the method's comment, next to the one `indexSession`
already carries.

### D3 — Index only when `addMember` returns true.

`addMember` returns false for an unknown session and for a frozen one. Indexing
regardless would put rooms into a person's joined listing that they were refused
entry to. The ordering follows from this: the SessionDO call happens first, and
its result gates the index write.

### D4 — Everyone is indexed, including the creator; members who left stay indexed.

Two things the store deliberately does not know:

- **The creator also holds a member handle** (`session.members[0]`), so they
  appear in both listings. The panel splits "created by me" from "joined"; it
  does that by subtracting on `session.createdBy`, which it already has. Making
  the store skip the creator would put a panel layout decision into an index.
- **Leaving does not unindex.** History stays readable after a member leaves,
  and a person wants the room in their list precisely so they can read it. The
  member record carries `leftAt`; callers filter on it. Deleting on leave would
  also add a second index-mutation path, and every path is another place the
  cross-object window opens.

The invariant, stated once: **`um:` holds the rooms in which this user has ever
held a member handle.**

### D5 — Members who joined before this deploy are not indexed, and are not backfilled.

Same position as `us:`, and for a weaker version of the same reason. A backfill
is technically possible here — `us:` can enumerate creators, and each session
lists its members — but it would walk every session in the registry to repair a
listing that fills itself in as sessions reach their TTL. The cost is a joined
room missing from one screen for at most a session lifetime. Say so in the
comment, as `indexSession` does.

### D6 — "No member removal" is an authorization gap, not a storage gap.

#49 reads the store and finds `addMember` and `updateMember` with nothing that
removes. But `bellman_leave` removes a member today, with
`updateMember(sessionId, memberId, { leftAt: Date.now() })`. The storage
primitive exists.

What does not exist is the authority to apply it to a handle that is not yours.
`findMember` refuses any `memberId` whose `userId` differs from the caller's,
which is correct for leave and is exactly what eviction has to step around.

So there is **no new store method**, and removal stays soft. A hard delete would
orphan the timeline — `SessionEvent` denormalizes `fromMemberId`, `fromUserId`
and `fromLabel` precisely so history survives a departure — and `publicMember`
already reports `active: false`. Removing the record would make a room's past
unrenderable to keep its present tidy.

### D7 — `member_evicted` is its own event type, not a reused `member_left`.

One line added to the `EventType` union. Nothing switches exhaustively over it
(`publicEvent` passes the type through), so the union grows cheaply.

Collapsing the two would be the expensive choice. The event stream is what the
panel renders and what a reader reconstructs a room's history from, and "left"
and "was removed by the creator" are different facts about the same person. An
audit row alone would not fix it: audit is per-org and gated, the timeline is
what members see, and a member removed from a room should be able to see that
this is what happened.

### D8 — Eviction is creator-only, and lives outside the verb set.

`session.createdBy === identity.userId`. Not a verb, and not an
`Identity.role === "admin"` check.

`VERBS` is a closed set of five, and `manifest.ts` writes down why `audit` and
`close_room` are not in it. Eviction belongs in that same category: authority
over the room as an object, rather than authority to act within it. Adding an
`evict` verb would also mean a manifest could grant it to a seat, and a room
whose preset handed eviction to a joiner is not a room anyone asked for.

The org-admin path is refused for the reason `src/roles.ts` states in its own
comment: `Identity.role` is platform authority over an org and buys nothing
inside a room. An org admin is not automatically anything in a room, and a
room's creator need not be an org admin.

**`src/roles.ts` is not touched.** `tests/tools/verbs.test.ts` greps that file
and fails if the string `Identity` appears in it. The creator check lives in
`src/rooms.ts`, which keeps the two authorities in two files — the structural
version of the distinction, rather than a comment asking readers to maintain it.

### D9 — Eviction retires the evicted seat's join code.

A room holds one live code per role. Removing a member while their seat's door
stays open is a removal that undoes itself the moment they reconnect, and the
person who evicted them has no reason to expect that.

So `evictMember` consumes the join code for the evicted member's `roomRole`,
when one is live, and emits `invite_revoked` beside `member_evicted`. Two
consequences to state rather than discover:

- It also retires that code for anyone else holding it for that seat. That is
  the correct direction — #49's own invite design argues over-revoking is
  recoverable by minting again, while under-revoking leaves a door open behind
  someone who believes they shut it.
- The tool's description says this happens. An operation with two effects has
  to name both.

A code that is merely expired is not retired, and emits no event — matching the
guard `bellman_invite` already applies on revoke.

### D10 — Self-eviction refused, re-eviction a no-op, last member out closes the room.

- **Evicting yourself is refused**, pointing at `bellman_leave`. The two
  operations write different events, and a creator who wants out should produce
  the honest one.
- **Evicting an already-departed member succeeds and changes nothing** — no
  second `leftAt`, no event, no audit row. `bellman_leave` is idempotent the
  same way, and a panel that retries a request should not double-write a
  timeline.
- **Evicting the last active member closes the room**, by the same re-read that
  `bellman_leave` performs. An empty room is over however it emptied.

### D11 — `src/rooms.ts` returns a discriminated result, not a `ToolResult` and not a throw.

```ts
type RoomFailure =
  | "not_found" | "closed" | "frozen" | "forbidden" | "conflict";

type RoomResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: RoomFailure; reason: string };
```

`reason` is the sentence the tools already hand back, unchanged. `code` is the
part that makes this a seam: an HTTP route picks 403 from `"forbidden"` rather
than pattern-matching English, and a route that forgot a case fails to compile
rather than returning 500.

Not a `ToolResult`, because that shape is MCP's and would make the routes
unwrap a `content` array they have no use for. Not a throw, because the failures
here are ordinary outcomes — a closed room is not exceptional — and `server.ts`
already has one exception type (`FrozenError`) for the genuinely awkward case.

### D12 — Four operations move. Closing stays internal.

Into `src/rooms.ts`: `evictMember`, `issueInvite`, `revokeInvite`, `leaveRoom`.
Each owns the whole sequence — resolve, authorize, mutate, append the event,
write the audit row — and returns a `RoomResult`.

Closing is called by `leaveRoom` and `evictMember` when the room empties, and
stays a private helper in the same module. #49 lists `POST /api/rooms/:id/close`
and that route will want it exported; exporting it now, with no caller and no
decided authority rule, would be a guess recorded as an interface.

Untouched: `bellman_start`, `bellman_connect`, `bellman_confirm`,
`bellman_send`, `bellman_sync`, `bellman_audit`. Those are the handshake and the
data plane. A panel does not start rooms, does not hold briefs, and does not
long-poll; moving them would be a refactor with no second caller to justify it.

### D13 — `audit()` moves into `src/rooms.ts`.

The helper that fans one action out to each involved org's stream is the thing
#49 most wants un-duplicated: a route that writes its own audit row is a route
that will one day write it for one org and not the other. Moving it means the
operations own it and nothing outside the module can skip it.

`src/server.ts` keeps its own `audit` call sites for the four tools that stay
and write one — `bellman_start` (`session_created`), `bellman_connect`
(`connect_previewed`), `bellman_confirm` (`brief_exchanged`) and `bellman_send`
(`sent_*`) — importing the helper from `rooms.ts`. One function, two importers.
The three that move with their operations are `invite_issued`,
`invite_revoked` and `member_left`.

### D14 — No `Principal` union.

Operations take `Identity`, plus a `memberId` where a seat is required.
`issueInvite` and `revokeInvite` and `leaveRoom` need one, because they are
verb-gated and a verb attaches to a seat. `evictMember` does not, because
creator authority attaches to the user.

A `Principal` type unifying "a member handle" and "a signed-in human" would have
to be destructured back into those two cases inside every operation. Introduce
it when a third principal appears — the operator credential of #61 is the
candidate — and let its shape be decided by three examples instead of two.

### D15 — The room primitives move down with the operations; the MCP-shaped ones stay.

Four helpers in `src/server.ts` are read by both the operations that move and
the tools that stay, so they go into `src/rooms.ts` and `server.ts` imports
them: `findMember`, `activeMembers`, `sessionStatus`, and the `FROZEN` sentence.
Each is a fact about a room rather than about MCP, and each has callers on both
sides of the split — `findMember` alone is called by `bellman_invite`,
`bellman_send`, `bellman_sync` and `bellman_leave`.

`appendOrFrozen` and `FrozenError` stay in `server.ts`. Their only callers are
`bellman_confirm` and `bellman_send`, both of which stay, and the throw exists
to keep a `null` out of a tool handler's happy path — a concern the operations
do not have, because they return a `RoomResult` instead.

The dependency runs one way: `server.ts` imports `rooms.ts`, never the reverse.
That is what makes `rooms.ts` callable from a route later without dragging the
MCP server in behind it.

## Schema

### `src/types.ts`

```ts
export type EventType =
  | "member_joined"
  | "member_left"
  | "member_evicted"   // new — D7
  | "message"
  | ...                // the remaining seven, unchanged
```

### `src/store.ts`

```ts
  /** Rooms in which this user has ever held a member handle. See D4. */
  sessionsJoinedBy(userId: string, limit: number): Promise<string[]>;
```

`MemoryStore` gains `private byMember = new Map<string, Set<string>>()`, written
in `addMember` beside the existing `byCreator` write in `createSession`, and read
by `sessionsJoinedBy` exactly as `byCreator` is read by `sessionsCreatedBy`.

### `src/store-do.ts`

`RegistryDO` gains `indexMembership(userId, sessionId)` and
`sessionsJoinedBy(userId, limit)`, both mirroring the `us:` pair.
`DurableObjectStore.addMember` gains the second call, gated on the first's
result (D3).

### `src/rooms.ts` (new)

```ts
export type RoomFailure = "not_found" | "closed" | "frozen" | "forbidden" | "conflict";
export type RoomResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: RoomFailure; reason: string };

export async function evictMember(
  store: BellmanStore, actor: Identity, sessionId: string, memberId: string
): Promise<RoomResult<{ evicted: boolean; codeRetired: string | null; sessionStatus: string }>>;

export async function issueInvite(
  store: BellmanStore, actor: Identity, sessionId: string, memberId: string, role?: string
): Promise<RoomResult<{ code: string; role: string; expiresAt: number; replacedPrevious: boolean }>>;

export async function revokeInvite(
  store: BellmanStore, actor: Identity, sessionId: string, memberId: string, role?: string
): Promise<RoomResult<{ roles: string[] }>>;

export async function leaveRoom(
  store: BellmanStore, actor: Identity, sessionId: string, memberId: string
): Promise<RoomResult<{ sessionStatus: string }>>;

export async function audit(
  store: BellmanStore, session: Session, actor: Identity,
  action: string, detail: Record<string, unknown>
): Promise<void>;
```

### `src/server.ts`

`bellman_evict` is added; `bellman_invite` and `bellman_leave` become adapters.
An adapter's whole body is the call plus a mapping:

```ts
const r = await evictMember(s, identity, session_id, member_id);
return r.ok ? ok(shape(r.value)) : fail(r.reason);
```

## The write path

`evictMember`, in order, because the order carries the decisions:

1. `getSession` — absent or closed returns `not_found` / `closed`.
2. Frozen returns `frozen` with the existing `FROZEN` sentence. Eviction is a
   write, and writes stop while a plan is lapsed.
3. `session.createdBy !== actor.userId` returns `forbidden` (D8).
4. The target handle is absent from `session.members` — `not_found`. This is a
   direct lookup, not `findMember`: `findMember` requires the handle to be the
   caller's, which is the thing eviction has to do differently (D6).
5. `target.userId === actor.userId` returns `forbidden`, naming `bellman_leave`
   (D10).
6. `target.leftAt !== null` returns `ok` having written nothing (D10).
7. `updateMember(sessionId, memberId, { leftAt: Date.now() })`.
8. `appendEvent` of `member_evicted`, carrying the evicted label and room role.
   A `null` return means the session froze in the gap; the member is already
   out, so this is tolerated rather than unwound — `bellman_leave` treats its
   own append the same way.
9. If a live code exists for `target.roomRole`: `consumeJoinCode`, then
   `invite_revoked` (D9). An expired code is not live and produces nothing.
10. Re-read the session; if `activeMembers` is empty, `closeSession`.
11. `audit(..., "member_evicted", { member_id, room_role, code_retired })`.

Steps 7 through 11 touch `SessionDO`, `RegistryDO` (through `consumeJoinCode`)
and `AuditDO`, with no transaction across them — the #59 and #62 class again.
Nothing here makes it worse than the paths that already exist, and the ordering
is chosen so the earliest write is the one that matters: a crash after step 7
leaves a removed member whose removal was not announced, which is recoverable,
rather than an announcement of a removal that did not happen.

## Testing

`tests/helpers/store-contract.ts` carries the index, because it is what makes
`MemoryStore` and `DurableObjectStore` agree rather than merely both compile.
New cases:

- a joined member appears in `sessionsJoinedBy`, and in nobody else's listing
- a user who joined the same room from two machines appears once (D2 — the key
  is per user, and a `put` is idempotent)
- the creator appears in both `sessionsCreatedBy` and `sessionsJoinedBy` (D4)
- a member who left is still listed (D4)
- `limit` is honoured, matching `sessionsCreatedBy`
- `addMember` refused for a frozen session writes no index entry (D3)
- `addMember` refused for an unknown session writes no index entry (D3)

`tests/rooms.test.ts` drives `src/rooms.ts` directly, which is where the
authority matrix belongs — no MCP framing in the way:

- a non-creator member with every verb the manifest offers cannot evict
- an org admin who is not the creator cannot evict
- the creator cannot evict themselves
- evicting a departed member writes no second event and no second audit row
- evicting the last active member closes the room
- eviction retires a live code for that seat and emits `invite_revoked`; an
  expired code produces neither (D9)

`tests/tools/` through the MCP harness:

- `bellman_evict` removes a peer, who then sees `member_evicted` in
  `bellman_sync` and is refused on their next write
- `bellman_invite` and `bellman_leave` behave identically after the refactor —
  these are regression tests over existing assertions, not new coverage, and
  the point is that the diff moves code without moving behaviour

Every new assertion is run against a deliberately broken implementation before
it counts as verification. An assertion that has never been seen to fail is not
evidence.

## Files

| File | Change |
|---|---|
| `src/types.ts` | `member_evicted` joins `EventType` |
| `src/store.ts` | `sessionsJoinedBy` on the interface; `byMember` on `MemoryStore` |
| `src/store-do.ts` | `RegistryDO.indexMembership` / `.sessionsJoinedBy`; the second write in `DurableObjectStore.addMember` |
| `src/rooms.ts` | new — the four operations, `RoomResult`, and `audit` |
| `src/rooms.ts` | also receives `findMember`, `activeMembers`, `sessionStatus` and `FROZEN` (D15) |
| `src/server.ts` | `bellman_evict` added; `bellman_invite` and `bellman_leave` reduced to adapters; `audit` and the four primitives imported rather than defined |
| `tests/helpers/store-contract.ts` | the index cases, run against both stores |
| `tests/rooms.test.ts` | new — the authority matrix |
| `tests/tools/evict.test.ts` | new — the tool through the harness |
| `tests/tools/invite.test.ts` | unchanged assertions, re-run against the adapter |
| `docs/ARCHITECTURE.md` | `um:` named beside `us:` in the cross-object table |

## Out of scope

Named again so a reader does not have to reconstruct them from the Scope
section:

- **The HTTP routes of #49.** Blocked on #48 for a credential, and on a
  pagination convention that rooms, events and audit should settle together.
- **Audit filtering and export.** #58.
- **A types-only subpath export** from `@bellman-sh/mcp-server`, for the panel
  repo. Packaging, no consumer yet.
- **A public `closeRoom`.** Arrives with the route that needs it.
- **#25.** `getSession` returns every event on every call, and a panel polling
  room detail is the access pattern it warns about. It should precede the
  routes; it does not block this spec, which adds no `getSession` call sites.
