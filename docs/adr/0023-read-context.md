# ADR 0023 — A brief reaches a peer only when its author grants read_context

**Date:** 2026-10-18 · **Status:** accepted · **Spec:** `docs/superpowers/specs/2026-10-16-read-context-design.md` · **Plan:** `docs/superpowers/plans/2026-10-16-read-context.md`

## Context

`bellman_start`, `bellman_confirm` and the MCP App's "Read my brief" checkbox all say that a
member's brief reaches peers only when the member grants `read_context`. Nothing checked the
grant. Sync, the room socket, the dash's Log, a join and a preview each handed every brief to
every peer, and the docs site's trust page said that no call is refused on it.

The change has three requirements. A member who does not grant `read_context` has their brief
seen by no one but themselves, on every path, including briefs logged before this shipped.
When a member's grant changes, the change covers their earlier briefs. A room where every
member grants it, as the default does, sees no change.

## Decision

Each entry names the spec's decision (D) or the plan's ruling (R) it records.

1. **The grant is checked when an event goes out, not when it is written (D1).** One
   function, `readableEvent` in `src/public-event.ts`, takes a stored event, its author's
   member row and the reader, and returns the event as that reader may see it. Briefs
   already in a room's log are covered, and a change of grant takes effect at once.
   Stripping the brief when the event is written was rejected: it leaves every logged
   brief readable from the start of the log.
2. **What the rule does (R10).** A `brief_update` whose author does not grant
   `read_context` is dropped, unless the reader is the author's own account. A
   `member_joined` still goes out, so peers know who joined, but its `payload.brief` is
   null unless the joiner grants `read_context` or the reader is the joiner. Every other
   event is unchanged. The joiner's `payload.member` keeps its `agent` and `capabilities`,
   which the roster already shows, and has never held the brief. `seesBrief` is the one
   test of "grants it, or is the author's account", and the two direct reads use it too.
3. **The author's current grant decides (D2, R11, R13).** It is the grant on the member row
   of the handle that wrote the event, as it stands at delivery. A member who left keeps
   their last grant, so the row is read by id (`getMember`, `getMembers`) and not from the
   room's record, which holds only the members in the room now (ADR 0019). An author whose
   row is not handed to the rule reads as not granting, except to the author's own account.
   No store method was added.
4. **The author is an account (D3, R1).** A reader whose user id matches the event's writer
   reads the brief on any of their handles and in the dash. One account's two handles can
   differ, and each event is judged by the row of the handle that wrote it. The handle that
   wrote an update never reads it back in `bellman_sync`, which leaves a caller's own events
   out by member id. Another handle of the account does, and so does the dash's Log.
5. **A private update is kept, and a path that cannot tell who reads sends it to no one
   (D4, D5).** The update is stored and its author reads it back. No other member is sent
   it, so it interrupts no one, and a reader's cursor still moves past it. The public page
   hides every brief already (`publicReadEvent`) and is unchanged.
6. **Events are read as the caller's account (R5, R14).** `eventsFor` in `src/rooms.ts`
   serves `bellman_sync`, `bellman_rooms` (its `last_event` names an update's type and
   time) and the dash's Log route, an org admin's included. It lists the rows of the briefs'
   authors in one `getMembers` call, and in none when no event carries a brief.
7. **The two direct reads follow the rule (R6, R7, R8).** `bellman_confirm` hands a joiner
   the briefs of peers who grant `read_context` and of the joiner's account's other
   handles. It leaves the rest out before it takes the 25 most recently heard, so a kept
   brief takes none of the places, and `briefs_omitted` counts it as it counts any brief not
   handed. The roster already shows each member's capabilities, so the count tells a joiner
   nothing new. `bellman_connect` previews the creator's brief by the creator's row, read
   as the previewer's account, so a creator previewing their own room reads their own. A
   kept creator brief arrives as `creator_brief` with `data: null`, the shape a creator with
   no brief row already gets, and `bellman_connect`'s description does not change.
8. **The room socket reads as no one, on both arms (R2).** `SessionDO.#wake` builds one
   frame and sends it to every socket in the room, so a frame carries a granted brief
   only. The replay `SessionDO.fetch` sends on connect follows the same rule, so a
   reconnect is shown what a live socket was. The replay sets the socket's cursor from the
   events read and not from the frames sent, so a live frame never resends what the replay
   passed over. The author's own socket does not carry their private brief, and their sync
   on another handle does. `#wake` takes the member rows its append read, and its other
   callers (removals, ticks, housekeeping, the host's writes) pass none, since none of
   their events carries a brief.
9. **The socket's replay lists every member row (R12).** The events read must stay the last
   await before the socket attaches (`tests/store-do-wiring.test.ts`), and the authors are
   not known before the events are, so `fetch` lists the room's `mb:` rows first: one list
   per upgrade, the cost `departedMembers` already pays. A `ponytail:` comment names it.
10. **The hosted seat's transcript needs no call (R3).** `decide` keeps message and
    progress replies to the open question, and `answerPrompt` holds only those, so no brief
    reaches the model, granted or not. `tests/host.test.ts` pins it, and `decide`'s type
    filter is the check its test is seen to fail without.
11. **A new hosted seat grants `read_context` (R4).** `hostMember` granted
    `receive_messages` only, so decision 3 would have hidden the seat's brief from every
    joiner. It grants both now, the owner's choice, and joiners keep reading the seat's
    brief. Nothing rewrites a stored member, so a seat already running keeps its old row.
12. **The MCP App says when there is no brief to show (R9).** `renderJoin` in
    `ui/src/join.ts` read `creator_brief.data.goal` and threw on null; it says `The creator
    keeps their brief private.` The bridge shows a `member_joined`'s and a `brief_update`'s
    payload in the channel, and the dash's Log shows the same in its Details, but both read
    the paths above, and the dash's `summarize` and `fieldsOf` already take a null brief.
    Neither changes.
13. **A report of a message is a read.** `fileRoomReport` applies `readableEvent` to the
    event at a reported cursor, as the reporter's account. A cursor that names a kept update
    is refused in the words for a cursor that names no event, so the refusal does not say
    an update is there, and the author's own account may still report it. A caller with no
    handle in a public room, and one whose every handle was removed from it, read the room
    as its public page does, and the page shows no `brief_update`: `publicReadEvent` decides
    for them, so a cursor that names any update is refused, granted or kept, and a report
    does not tell them which authors grant `read_context`.
14. **The tool text gains one sentence (R15).** The capabilities line of `bellman_start` and
    of `bellman_confirm` says `read_context lets peers read your brief; it is on by default,
    and without it only you see your brief.` No tool was added, so `extension/manifest.json`
    is unchanged.
15. **A test lists the paths (R14).** `tests/delivery-paths.test.ts` names every module that
    calls `publicEvent`, that reads a store's events (`eventsAfter`, `waitForEvents`,
    `recentEvents`, `eventAt`) or that calls `getBriefs`, each with what it serves, and
    fails when a module gains or loses such a call. The spec names the first predicate
    only. The hosted seat and `bellman_rooms` call no `publicEvent`, and a guard on that
    name alone would not see a path like them.

## Consequences

- A room where every member grants `read_context`, as the default does, sees no change.
- A grant changed later covers the briefs already sent, both ways, because nothing is
  stripped when an event is written. No tool changes a grant after a member joins; the
  store accepts a change and the rule follows it.
- A hosted seat started after this grants `read_context`, so joiners read its brief; a seat
  already running keeps its old row, and its brief stops reaching joiners (R4).
- A member reads their own private update back on another handle or in the dash's Log,
  never on the handle that wrote it, and never on their own room socket (R1, R2).
- A socket upgrade lists every member row of its room (R12).
- A new path that reads events or briefs is listed in `tests/delivery-paths.test.ts` before
  it ships.
- Nothing stored changed shape, so a rollback is a revert.
- The quotes work resolves a quote against events as the quoter may see them (R19). It lets a
  member quote a `brief_update` and copies the quoted characters onto the quoting event, so
  without that check a quote of a private update would carry the brief to every peer.
