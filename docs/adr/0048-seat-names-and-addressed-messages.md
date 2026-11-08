# ADR 0048: Seat names and addressed messages

**Date:** 2026-11-08 · **Status:** accepted · **Spec:** `docs/superpowers/specs/2026-11-08-seat-names-design.md` ·
**Plan:** `docs/superpowers/plans/2026-11-08-seat-names.md`

## Context

A member's label is how its account signed in, so one account's seats share a label, and a room of many seats from one
account cannot tell them apart. Every `message` interrupts every member: nothing delivered an event to only some of a
room's members, so in a swarm a reply meant for one seat cost every agent a turn.

## Decision

1. **Every seat has a name, `<role>-<seq>`** (`seatName`, `src/room/member-names.ts`). Both fields are fixed when the
   seat is taken and `seq` is never reused, so a name means one seat for the room's life. It is derived, never stored:
   no migration, no row, and every live room has names on the deploy that ships it. It is not called a handle, which
   means an account's public name (ADR 0021) and, in code, a seat.
2. **Names appear beside labels**: on every member a tool lists (`storedMember`), as the caller's `name` from
   `bellman_start` and `bellman_confirm`, and as `from.name` on every event (`publicEvent`). Public pages show none and
   name members by number, as ADR 0011 says.
3. **`bellman_send` takes `to`**, 1 to 20 seat names, for `message` and `artifact` only. The server resolves the names to
   active members, case-insensitively, and refuses an unknown or departed seat, the sender's own, and a seat without
   `receive_messages`. A payload never sets it, and nothing parses `@name` out of text: labels are emails.
4. **The event stores `toMemberIds`.** The idempotency fingerprint includes it only when set, so every stored print stays
   valid. Projected as `to: [{ member_id, name }]`.
5. **Addressed is not private.** Every reader that reads the room's log reads an addressed message.
6. **An addressed event is ambient for every reader it does not name** (`addressedAway`, `src/room/attention.ts`), on
   every path: `bellman_sync` sets `ambient` per reader; the bridge's channel push, its Stop hook and `bellman_wait`
   do not wake for it (`wakes`, `drainWaking`, `src/client/inbox.ts`), and the mod's wake count leaves it out. A queued
   one is not dropped: it rides with the next event that wakes. Every other ambient type is unchanged.
7. **The long poll is reader-aware.** `waitForEvents` takes a `reader`. With one, an event addressed to other seats does
   not end the wait, and at the timeout it returns what it waited past, so the cursor moves on. Both stores read and
   register in the same turn, as before.

## Consequences

- An account's many seats are told apart by name, and a reply can be addressed to its sender's seat, which every event
  now names.
- A swarm stops paying a turn per member for each message meant for one.
- Seat-name numbers are not dense (`coder-2`, `coder-9`). A per-role count would need storage and a backfill.
- Names are not chosen. A chosen name, group addresses (`@coder`), and private messages are later decisions.
