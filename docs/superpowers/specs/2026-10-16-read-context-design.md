# Enforcing read_context: design

**Date:** 2026-10-16 · **Status:** for review

## Goal

A member's brief reaches peers only when the member grants `read_context`, as `bellman_start`, `bellman_confirm` and the MCP App's "Read my brief" checkbox already promise. Today nothing checks the grant: every peer reads every brief.

Success means:

- A member who doesn't grant `read_context` has their brief seen by no one but themselves, on every path, including briefs logged before this ships.
- When a member's grant changes, the change covers their earlier briefs too.
- Rooms where every member grants it, as the default does, see no change.

## Decisions

- **D1. The grant is checked when an event goes out, not when it is written.** Every path that hands events to a reader applies one function. Briefs already in a room's log are covered, and a change of grant takes effect at once. (Rejected: stripping the brief when the event is written, which leaves every logged brief readable from the start of the log.)
- **D2. The author's current grant decides:** the grant on the member row of the handle that wrote the event, as it stands at delivery. A member who left keeps their last grant.
- **D3. The author is an account.** A reader whose user id matches the event's writer sees the brief, on any of their handles and in the dash.
- **D4. A private brief update is kept and sent to no one else.** The brief is stored and its author reads it back. No peer is sent the event, so it interrupts no one.
- **D5. A path that can't tell who is reading sends a private brief to no one.**

## 1. The rule and where it applies

- One function, in a runtime-free module beside `publicEvent`, takes an event, the room's member rows and the reader: a user id, or none for a shared path. It returns the event as that reader may see it:
  - A `brief_update` whose author doesn't grant `read_context` is dropped, unless the reader is the author.
  - A `member_joined` still goes out, so peers know who joined, but its `brief` is null unless the joiner grants `read_context` or the reader is the joiner.
  - Every other event is unchanged.
- It runs on every path that hands events to a reader: sync, the room socket and the pushes, the dash's event route, and the hosted seat's transcript. The predicate that finds them is every caller of `publicEvent`, and of the store's event reads (`eventsAfter`, `waitForEvents`, `recentEvents`), that serves someone other than the author.
- Two direct reads follow the same rule:
  - `bellman_confirm` leaves out a peer's brief when the peer doesn't grant `read_context`.
  - `bellman_connect`'s preview leaves out the creator's brief when the creator doesn't grant it.
- A reader's cursor still moves past a dropped event.
- The public page already hides every brief, and stays as it is.

## 2. Details

- **Shared paths.** A room-socket frame goes to every member subscribed to the room, so it carries no private brief. The author's sync still has it.
- **What readers notice.** A dropped update interrupts no one. A joiner who doesn't grant `read_context` still appears in the roster and in the join event, without a brief. The preview still shows the room's purpose, which is the manifest's and not a brief.
- **The hosted seat** is a peer. Its transcript leaves out private briefs like any other reader's.
- **Tool text.** The capabilities line in `bellman_start` and `bellman_confirm` gains one sentence: `read_context` lets peers read your brief, it is on by default, and without it only you see your brief. The tool listing is measured before and after.

## 3. Tests, docs and rollout

- **The function:** each event kind, with the grant on and off, for a reader who is the author, a peer, or none.
- **Tools,** for a member who joined without `read_context`:
  - peers' sync shows their join without a brief;
  - their `brief_update` reaches their own sync and no peer's;
  - `bellman_confirm` leaves out their brief;
  - `bellman_connect`'s preview leaves out a creator's brief when the creator doesn't grant it;
  - a grant changed in the store after a brief was sent hides or shows that brief.
- **Every path:** one test each for sync, the room socket frame (a worker test), the pushes, the dash's event route and the hosted seat's transcript. Each is seen to fail with the check removed.
- **A guard for new paths:** a test lists the modules that call `publicEvent` and fails when a new one appears, so a new delivery path gets the check before it ships.
- **Docs:**
  - an ADR, numbered at merge;
  - the README's line on capability grants says `read_context` is enforced;
  - `bellman.sh/trust` and the docs site's trust page say so too. The docs site's page currently says no call checks it, so whichever of the two branches lands second updates it.
- **Rollout:** one server PR. The server does the filtering, so the bridge and the dash don't change. It follows the abuse-protections server work, whose send limit edits the same `connect.ts` and `confirm.ts`, and it goes ahead of quotes, which adds a field on the same delivery paths.

## Out of scope

- A new way to change a member's grants after joining. The store accepts a change; no tool offers one.
- Grants per peer: the grant stays all or nothing.
- Treating the room's creator differently from any other peer.

## Risks

- **A missed path leaks briefs again.** The per-path tests and the `publicEvent` caller guard are the defence.
- **The hosted seat knows less.** A host answering a room reads fewer briefs when members keep theirs private. That is the grant doing its job.
