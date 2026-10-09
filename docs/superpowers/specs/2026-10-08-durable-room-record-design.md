# The Durable Room Record: an Admin's Read, and Retention — Design

Issue: [#65](https://github.com/bellman-sh/bellman/issues/65)
Status: implemented on `mcfearsome/durable-room-record`; plan: [the durable room record](../plans/2026-10-08-durable-room-record.md)
Depends on: [the working surface](2026-10-06-working-surface-design.md) (D5: the room object is not deleted at close; D11: what that settled here), [blobs](2026-10-06-surface-blobs-design.md) (the R2 prefix, the charge rule), [the room routes](../plans/2026-10-07-room-routes.md) (#184) (the panel's reads this extends)
Related: #49 (the panel's HTTP API, which the admin list belongs to), #158 (a room anyone can read: the share link stays there), #18 (rooms persist: a room closes when its last member leaves or after 90 days with nobody in it, and this design starts its clock at that close)
Repos: `bellman-sh/bellman` only; the panel reads what the routes answer

## Problem

A room's record outlives the room already: `SessionDO` keeps its events and
its surface after `closed` is set, and a member reads them through
`bellman_sync` and the panel for as long as the object exists. Two things are
missing. Nothing ever removes a closed room, its rows or its bytes in R2, so
every room costs storage forever and an orphaned object (a charge that threw,
a 201 that was lost) is never found. And nobody who was not a member can read
a room: an org whose people sat in a room has no way to see what was decided
after they left, though the same org can already read its audit log.

## Scope

In: retention after close as a plan entitlement; the purge, on the room's own
alarm; the orphan sweep at close with its credit; an org admin's read of a
closed room, by id and by org; delete on demand by the creator or such an
admin; the audit entries that record a purge.

Out: a share link or any read by a person who is neither a member nor an
admin of an involved org (#158); a copy of the record anywhere but the room
object; a change to the room's lifetime before close (#18); the panel's pages
for any of this (the routes answer, the panel is #49's follow-on).

## Decisions

### D1 — Retention is an entitlement, stamped at creation.

`Entitlements` gains `retainAfterCloseMs: number | null`: free 7 days, pro 365
days, max and team `null`, kept until deleted. The value is stamped on the
room at creation as `retainAfterCloseMs`, the way `blobBytesCeiling` is, so a
plan change after the fact never shortens a room that was already promised a
window. A room closed on the free plan is gone a week later; a team's room
stays until someone with the right to delete it does.

### D2 — The purge is the room's own derived alarm.

`SessionDO` has one alarm shared by name, pointed at the soonest of `outbox`,
`abandoned` and `heartbeat`. `purge` is the fourth: due at `closedAt + retainAfterCloseMs`
when `closed` is set and the window is finite, derived from the record like
`abandoned` is, so rooms closed before this shipped get their alarm the first time
their object wakes. `derivedDue` answers nothing for a closed room today; the
purge is the one thing a closed room still owes. `closedAt` is recorded wherever `closed` is set. A record
closed before this shipped has neither a window nor a `closedAt`, and is kept:
deletion is the one irreversible act here, and no plan promised those rooms a
clock. Delete on demand (D6) reaches them.

When it fires: list and delete the room's R2 prefix in batches; drop the room
from the registry's indexes and file `room_purged` on the audit log of every
org on the roster, by direct calls rather than the outbox, since `deleteAll()`
would take the outbox's rows with it; then `deleteAll()` the object's storage. The
order is the atomicity rule this codebase keeps: the side the prefix can find
loses nothing it cannot recover, so the bytes go first and the record last,
and a crash between leaves a record whose next wake purges again. A purged
room is a room that never was, to every reader: the registry drops it from
both listings, the routes answer 404, `bellman_connect` on its codes answers
as it does for an unknown room.

### D3 — The orphan sweep runs once, at close.

When `closed` is set, the room lists its own prefix once and deletes every
object no surface row names, crediting `blobBytes` by each object's size.
That is the lost-201 and the thrown-charge case from #183, found where they
can be found: a refused charge deleted its object already; a charge that threw
kept it on purpose; a put whose 201 never reached the bridge charged the room
for an id nobody holds. One list per room per close bounds the work; no
scan over all rooms exists, and none is needed, because the purge deletes the
whole prefix anyway.

### D4 — An org admin reads a closed room on the audit precedent.

`bellman_audit` already lets a caller with the team plan, the admin role and
an org read that org's log, and `AuditDO` writes one entry per org a room
involved. The same three conditions, plus one, admit a reader to a room they
never sat in: the room's roster carries at least one member whose `org_id` is
the caller's. `GET /rooms/:id`, `GET /rooms/:id/surface` and
`GET /rooms/:id/blobs/:blobId` try membership first and fall back to this; the
answer carries `viewer: "admin"`, an empty `my_handles`, a preview with no
`your_role` and no `your_verbs`, and the roster and surface as a member would
read them after close. The surface writes stay refused: an admin holds no seat,
and seats are the only thing that writes. The fallback also applies to a viewer
every handle of whom was removed, once the room is closed, and `my_handles` then
lists the removed handles so the page can say so: the cut protects a running room
from a removed member, and an org admin's read of the closed room is the audit
precedent.

The read is of a closed room only. An open room is its members' and the
audit log is the admin's window into it while it runs; a 404 for an open room
says to an admin exactly what it says to a stranger.

### D5 — A registry index of rooms per org, so the read is findable.

`RegistryDO` keeps `sessionsForOrg(orgId)` beside `sessionsCreatedBy` and
`sessionsJoinedBy`, written where `sessionsJoinedBy` is written: at creation
for every org on the roster, at each seating for the member's org when it has
one, and dropped at purge by a direct call (`dropOrgIndex`). `GET /rooms?as=admin` lists them for a caller
D4 admits, closed rooms only, with the same `{ rooms, truncated }` shape. The
list holds the newest 50 closes, as the member list holds 50, but the index is
read wider than that (`JOINED_SCAN`, the bound the monitor's joined history is
read with), because it holds the org's open rooms among its closed ones in no
promised order; `truncated` says either bound was hit. The identity's own org
is the only one it can ask for; the query names no org.

### D6 — Delete on demand purges a closed room now.

`DELETE /rooms/:id` by the room's creator, or by an admin D4 admits, sets the
purge due now and answers 202 with `{ id, purge_at }`, the time the room is
stored with, which a retry is told again; the alarm does the work, so the route
and the alarm are one code path. An open room answers 409 "a room is deleted after it
closes"; closing stays what it is, the last member leaving or 90 days with
nobody in the room. A
`room_deleted` audit entry names who asked, where `room_purged` names only
that the window ran out.

### D7 — The tools need nothing new.

No tool is added, so `extension/manifest.json` is untouched. `bellman_sync`
on a purged room answers as it does for an unknown one. `bellman_rooms`
(#28's list) drops purged rooms because the registry has forgotten them.

## Schema

```ts
// src/auth.ts
retainAfterCloseMs: number | null;     // free 7 d, pro 365 d, max null, team null

// src/types.ts, StoredSession
closedAt: number | null;               // set with `closed`
retainAfterCloseMs: number | null;     // stamped at creation from the plan
purgeAt: number | null;                // set on demand (D6); otherwise derived
blobsSwept: boolean;                   // the close-time sweep has run (D3)

// src/store.ts, BellmanStore
sessionsForOrg(orgId: string, limit: number): Promise<string[]>;
schedulePurge(sessionId: string, at: number, by: string | null): Promise<PurgeSchedule>;  // D6; the alarm does the purge
sweepBlobs(sessionId: string): Promise<{ removed: number; credited: number }>;
type PurgeSchedule = { ok: true; purgeAt: number } | { ok: false; reason: "open" | "missing" };

// src/blobs.ts, BlobStore
list(sessionId: string): Promise<{ id: string; bytes: number }[]>;
deleteAll(sessionId: string): Promise<number>;

// src/types.ts, AuditEntry
action: string;                         // "room_purged" | "room_deleted"
detail: Record<string, unknown>;        // { session_id, room }; actorUserId is the asker, or "system"
```

The wire: `GET /rooms/:id` gains `viewer: "member" | "admin"`, and `closed_at` and
`purge_at` as ISO times, null where the record has none; the list gains
`viewer` too. `roomListEntry` is unchanged.

## Security

An admin's read is bounded three ways: the plan that pays for audit, the
role, and the org tie on the roster, each already enforced for the audit log.
Membership is still the tenant boundary for an open room. A purge deletes
bytes before the record, so there are never bytes that no record can find: a
purge that dies leaves a record whose next wake does it all again. The converse
is not promised. Between the bucket's delete and the wipe, and after a crash
between them until the next wake, the record exists and may name bytes that are
gone, and a download of one answers 404, as the dangling-reference rule already
allows. Delete on demand is the creator's or
the admin's and is a 202 that the alarm fulfils, so no route holds the
object open for the time a prefix takes to delete. The audit entries carry
identifiers, never prose.

## Testing

`tests/helpers/store-contract.ts` (both stores): a closed room with a finite
window is purged at the window and gone from both listings and the org index;
an infinite window is never purged; `schedulePurge` on an open room is
refused; `sweepBlobs` removes exactly the unnamed objects and credits their
bytes; `closedAt` is set with `closed`. `worker-tests`: the derived `purge`
alarm fires once and the object's storage is empty; a record closed before
this shipped has no window and is kept; the purge drops the registry's rows
and files `room_purged` for every org on the roster by direct calls. `tests/http-rooms.test.ts`: the admin read admits only the
four conditions together (each one missing is 404), reads a closed room and
not an open one, `my_handles` empty, PUT refused 403; `?as=admin` lists only
that org's closed rooms; `DELETE` by the creator and by an admin answers 202
and the room is gone after the alarm, by a member 403, on an open room 409.
Every test is run once against the broken implementation before it counts.

## Files

`src/auth.ts` (the entitlement), `src/types.ts` (`closedAt`,
`retainAfterCloseMs`, `purgeAt`, the audit kinds), `src/store.ts` and
`src/store-do.ts` (the purge handler, the sweep, `sessionsForOrg`,
`schedulePurge`, the registry's org index and its drops),
`src/blobs.ts` and `src/blobs-r2.ts` (`list`, `deleteAll`), `src/http/rooms.ts`
(the admin fallback, `?as=admin`, `DELETE`), `src/projections.ts` (`viewer`,
the preview with no seat), `docs/ARCHITECTURE.md` (§4 the fourth alarm, §8
the roadmap's B2), `README.md` (retention per plan), the tests above.

## Out of scope

A share link (#158); the panel's pages; a record kept past the window on
request; export of a room as a file; a change to the lifetime before close
(#18); the MCP Apps monitor showing purge dates.
