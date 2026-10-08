# ADR 0001 — Rooms persist

**Date:** 2026-10-07 · **Status:** accepted · **Closes:** #18 · **Spec:** `docs/superpowers/specs/2026-10-07-rooms-persist-design.md`

## Context

Every room died on a clock: `sessionTtlMs` per plan (4 hours to 30 days), stamped
into `Session.expiresAt` at creation and enforced by `SessionDO`'s alarm. A hub room
accumulates members over weeks, and a clock ended it in the middle of being useful.
Watching a room costs nothing now (the sockets hibernate and the object sleeps with
them), so the clock paid for nothing. `maxMembers` (2/8/25/25) was a plan fact
stamped into the room, and a persistent room capped at eight is a room somebody
has to recreate.

## Decision

1. **Rooms persist on every plan.** A room ends when its last member leaves
   (`closeSessionIfEmpty`), or after 90 days in which no active member was seen,
   by `lastSeenAt` or by a live socket. The rule is one pure predicate pair,
   `abandonedAt` / `isAbandoned`, shared by both stores' sweeps, the Durable
   Object's derived alarm and every "does this room read closed" check. The alarm
   stamps a socket's members instead of closing, so a room held open on one
   socket is never swept and the alarm never fires back to back. Frozen rooms are
   not swept; a thaw restarts the window. The `session_expired` event stays, with
   `{ reason: "abandoned", last_seen_at }`.
2. **A swarm room's size is a ceiling, not a plan.** `capacityOf(manifest)` is 2
   for `pair` and `ROOM_MEMBER_CEILING = 100` for `swarm`, on every plan that can
   start one. 100 because a room is one 2 MB stored value: 100 maximal briefs are
   1.47 MB, 250 would be 3.7 MB. `maxMembers` left `Session` rather than becoming
   `null`, for the rule on that type: two fields for one fact can disagree.
3. **Max is coming soon.** It differs from pro by `monthlyCreates` alone, stays in
   `ENTITLEMENTS` for hand grants and as the shape hosted agents (#188, #189)
   attach to, and is not sold.

## Consequences

- Rooms alive at deploy persist: `hydrateStoredSession` strips `expiresAt` and
  `maxMembers` on read, and nothing is backfilled.
- A rollback finds `now > undefined` false and `seatVictims` given `undefined`
  seats everyone: rooms neither expire nor cap, which is the direction of travel.
- Reaching the ceiling is the trigger for moving members to rows of their own.
- The site's plan copy follows in `bellman-sh/bellman.sh` (room size, FAQ, compare pages).
