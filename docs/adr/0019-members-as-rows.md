# ADR 0019 — Members live in rows of their own, and a room seats 5,000

**Date:** 2026-10-12 · **Status:** accepted · **Amends:** ADR 0018, decisions 2 and 3

## Context

ADR 0018 moved briefs out of a room's record and seated 1,000, and named what came next. Members
who had left stayed on the record, because a public read numbered members by when they joined, so
a room that saw thousands of joins over its life neared the 2 MB a value holds again, and reaching
it was a failed join. A public social room run for marketing is the room expected to get there:
its members come and go.

The record was also rewritten whenever one member changed. A member's `lastSeenAt`, a report, a
leave: each rewrote every member the room had ever held.

## Decision

1. **A member is a row, `mb:<memberId>`**, in the room or gone from it, beside the record as
   events, surface items and briefs are. `mu:<userId>:<memberId>`, the user percent-encoded,
   indexes a person's handles, and `lb:<label>` holds a label's public number.
2. **The record names the members in the room, and holds no members.** It keeps `present`, their
   ids in join order; `memberSeq` and `labelSeq`, the counts the next seat numbers from; `creator`,
   the room's first seat, which no departure removes; and `orgs`, every org that has sat in the
   room, for the audit rows a delete and a purge owe and for an org admin's read of a closed room.
   A write puts the record when a field on it changed and the row of each member it changed, so a
   member's stamp writes one row.
3. **`getSession().members` is the members in the room.** One who has left is read by id
   (`getMember`, `getMembers`), by person (`membersOfUser`) or in a list (`departedMembers`).
   `Member` gains `seq`, its place in the join order, and `publicNumber`.
4. **A public number is given at seating.** A label's first seat takes the next number, every later
   seat with that label reads it back, and the hosted seat has none. A public read asks for the
   numbers of the labels on its page (`publicNumbers`), so a member who has left keeps its number.
5. **A roster shows the room.** The panel's is the members in the room and the 100 who left most
   recently, with `departed_omitted` counting the rest. A removed member's view adds to those in
   the room the members who left after its cut, and leaves out those who had left before it, who
   were not in the room as it stood. `bellman_confirm`'s roster is the members in the room.
6. **An older room moves when its object is constructed**, not at its next seat as ADR 0018 moved
   briefs. `SessionDO`'s constructor, under `blockConcurrencyWhile`, moves an older record's members
   to rows in one transaction, numbered in join order and each label by its first seat, and any
   brief still inline to its row. A record written since holds no members and costs one read. A
   record still holding its members is refused rather than read, since writing it back would drop
   those who had left, and `getBriefs` reads rows alone.
7. **A swarm room seats 5,000.** Storage no longer bounds it: the record keeps its size however
   many come and go. Every call still loads the members in the room, about 300 bytes each as
   members are, so 5,000 is about 1.5 MB a call, and about 7.5 MB with every field at its maximum
   in two-byte text. `worker-tests/members-as-rows.test.ts` seats a full room at that maximum and
   refuses one more, moves an older room on its next instance, and holds the record to its size
   through 3,000 departures.

## Consequences

- Rolling back past this is not supported. The older build reads members from the record, and a
  room created or constructed since keeps them in rows.
- Departures still cost reads. `departedMembers` lists every member row, so the panel's roster and
  a removed member's view read a room's whole history; an index of departures by time is the step
  when that matters.
- Narrowing what each call reads, so a call loads the members it needs and not the whole room, is
  the next step past 5,000.
- The site's "up to 1,000" follows in `bellman-sh/bellman.sh`.
