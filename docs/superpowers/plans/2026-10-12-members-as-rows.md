# Members as rows (ADR 0019) — implementation plan

**Goal.** A room's record stops carrying its members. Each member is a row of its own, so
the record no longer grows with every join, a member's activity writes one row, and the
2 MB record limit stops bounding a room. First of two PRs: this one moves the storage;
the next narrows what each call reads, which is what lifts the ceiling past 5,000.

## Decisions

- **D1 Rows.** `mb:<memberId>` holds a member, any status. `mu:<userId>:<memberId>` indexes a
  person's members. `lb:<label>` holds a label's public number. Briefs stay in `bf:` (ADR 0018).
- **D2 The record** keeps `present` (present member ids in join order), `memberSeq`, `labelSeq`,
  `creator` (`memberId`, `userId`, `label`, `joinedAt`) and `orgs` (every org that has sat in
  the room). It keeps no `members` array.
- **D3 `getSession().members` is the present members** (`leftAt === null`), in join order. Departed
  members are read by id (`getMember`, `getMembers`), by person (`membersOfUser`) or as a list
  (`departedMembers`). `Session` gains `creator` and `orgs`; `Member` gains `seq` and `publicNumber`.
- **D4 A write puts the record and the rows of the members it changed.** Member arrays are rebuilt
  by replacing the members that change, so identity says which rows to write (`memberRows`).
- **D5 Old rooms migrate in `SessionDO`'s constructor**, under `blockConcurrencyWhile`, in one
  transaction: every inline member to a row, numbered in join order, inline briefs to `bf:`.
- **D6 Public numbers are stored at seating.** A label's first seat takes `labelSeq + 1` and
  every later seat with that label reads it back. The hosted seat has none. Public reads ask the
  store for the numbers of the labels on the page (`publicNumbers`).
- **D7 Rosters.** The panel roster is the present members plus the 100 departed most recently,
  with `departed_omitted`. A removed member's view (`rosterAsOf`) adds the members who left after
  its cut (`departedMembers({ leftAfter })`).
- **D8 Ceiling 5,000.** Storage no longer bounds it; every call still loads the present roster,
  about 300 bytes a member, so 5,000 is about 1.5 MB a call. The second PR narrows that.

## Tasks

1. **Types.** `Member.seq`, `Member.publicNumber`; `Session.creator`, `Session.orgs`; `RoomCreator`;
   `NewSession` omits `creator` and `orgs`. Store interface: `getMember`, `getMembers`,
   `membersOfUser`, `departedMembers`, `publicNumbers`. Contract tests for each, both stores.
2. **MemoryStore.** Keeps every member internally; `getSession` hands back the present ones with
   `creator` and `orgs`. Seating assigns `seq` and `publicNumber` and grows `orgs`.
3. **SessionDO.** `memberKey`, `memberRows`, `loadPresent`, `seatRows`; `stored()` loads present rows;
   every write of `session` goes through `memberRows`; the new reads; the constructor migration.
4. **Consumers.** `findMember`/`gateSeat` read a departed caller by id; `handlesOf` reads
   `membersOfUser`; eviction reads its target by id; creator readers use `session.creator`;
   org checks and `orgsOnRoster` use `session.orgs`; `publicNames` uses `publicNumbers`; the panel
   roster and `rosterAsOf` per D7; `bellman_start` re-reads the room it made for its preview.
5. **Tests.** Update tests that read departed members off `getSession`. Workers tests: a legacy
   room migrates on its next instance; 5,000 present members seat and read back; the record stays
   small however many have left.
6. **Ceiling and docs.** `ROOM_MEMBER_CEILING = 5000`; ADR 0019; README; ARCHITECTURE.
