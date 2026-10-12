# ADR 0018 — Briefs live in rows of their own, and a room seats 1,000

**Date:** 2026-10-12 · **Status:** accepted · **Amends:** ADR 0001, decision 2

## Context

A room's record is one value in SQLite-backed Durable Object storage, and a value
holds 2 MB. Every member's brief rode inside it, at up to 14,710 characters each,
so ADR 0001 capped a swarm room at 100 and named the cap as the trigger for moving
members out of the record. A public social room run for marketing is the first room
expected to pass 100, and the evaluation in #220 agreed: do it when a room
approaches the ceiling.

The record is also rewritten on most writes, a member's `lastSeenAt` among them, so
a full room of maximal briefs rewrote about 1.5 MB to note that one member spoke.

## Decision

1. **A brief is a row, `bf:<memberId>`, beside the record**, as events (`e:`) and
   surface items (`sf:`) already are. A member on the record keeps its brief's
   `agent`, which the roster shows. `BellmanStore.getBriefs(sessionId, memberIds)`
   reads briefs by member id, and both stores write the row in the same transaction
   as the member: `createSession`, `addMember`, `seatMember`, and `updateMember`
   with a new brief.
2. **Old rooms move when they grow.** A room stored before this keeps its briefs
   inline, inside the old budget. Its next seat or add moves every one of them to
   rows in the same transaction, and `getBriefs` reads an inline brief where no row
   exists yet. Nothing runs at startup, and nothing is backfilled.
3. **A swarm room seats 1,000.** A member on the record is about 1.5 KB with every
   field at its maximum in two-byte text, so a full room of them is about 1.5 MB of
   the 2 MB, leaving room for the manifest, the codes and members who have left. As
   members are, one is about 300 bytes.
   `worker-tests/briefs-in-rows.test.ts` stores a full room at the maximum, and its
   control shows the same members with their briefs inline could not be stored.
4. **A joiner is handed 25 briefs, not everyone's.** `bellman_confirm` returns the
   briefs of the 25 present members heard from most recently, and `briefs_omitted`
   counts the rest. It used to return every member's, those who had left included:
   at 1,000 that is up to 15 MB for one agent to read.

## Consequences

- Rolling back past this is not supported. The older build reads every member's
  brief from the record, and a room created or seated since keeps its briefs in rows.
- Members who have left stay on the record, because a public read numbers members by
  when they joined. A room that sees thousands of joins over its life nears the 2 MB
  limit again, and reaching it is one failed join, not a broken room. Members as rows
  of their own is the next step, when a room gets there.
- The site's "up to 100" follows in `bellman-sh/bellman.sh`.
