# ADR 0022 — Bans, a send limit and reports

**Date:** 2026-10-16 · **Status:** accepted · **Amends:** ADR 0020, decision 5 · **Spec:** `docs/superpowers/specs/2026-10-15-abuse-protections-design.md` · **Plan:** `docs/superpowers/plans/2026-10-15-abuse-protections.md`

## Context

ADR 0020 gave a public room a code that does not expire, so its creator can put the link
in a README or on a page. Three things stood in the way. Nothing kept an evicted person
out: `bellman_evict` said "Removal is not a ban", and what stopped them using the link
again was decision 5 of ADR 0020, an eviction retiring the permanent code. That shut the
link for every newcomer as well, and the next code the creator minted seated the same
person. Nothing limited how fast a member sends, and the link seats every stranger who
follows it. And nobody could report a room, a member or a message.

## Decision

Each entry names the spec's decision (D) or the plan's ruling (R) it records.

1. **Three levels of ban (D1).** A room ban, set by the room's creator. A creator-wide
   ban, set by the creator, which covers every room they own, now and later. An operator
   suspension, which covers all of Bellman. `src/bans.ts` holds the types of the first
   two and `src/suspension.ts` the third's.
2. **A banned account is told one thing (D1).** `You can't join this room.` (`BANNED`),
   the same for a room ban and a creator-wide one, from whichever code it redeems. It
   names neither who banned it nor how far the ban reaches. A suspended account is told
   `This account is suspended.` (`SUSPENDED`).
3. **`bellman_evict` takes `ban` (D1, R4).** `"room"` records the account in the room.
   `"all"` also records it as banned from every room the creator owns. The two are
   separate records, so lifting one leaves the other, and a later eviction asking for
   `"all"` widens a room ban made earlier. `evictMember` in `src/rooms.ts` runs it.
   `"all"` covers the rooms the account sits in now as well as its later joins: every
   other room the creator owns where it holds a handle, found through the joined-rooms
   index, loses each handle by the removal an eviction makes there. That removal follows
   the room's own code rules, files the eviction's audit row with `ban`, writes its
   `member_evicted` event and adds no room ban, since the creator-wide ban keeps the
   account out. A room it leaves with nobody in it closes. `also_removed_from` counts the
   rooms, and a refusal partway is finished by repeating the ban, as decision 6 has it.
4. **The dash bans through a route (R1).** `POST /rooms/:id/bans` takes `{ member_id,
   scope }` and runs the `evictMember` the tool runs. `GET /rooms/:id/bans` and
   `DELETE /rooms/:id/bans/:banId` list and lift a room's bans, for its creator alone,
   and `GET /account/bans` and `DELETE /account/bans/:banId` do the same for the caller's
   bans from every room they own. All are in `src/http/moderation.ts`. A `banId` is
   opaque, and the lists leave out the account's user id.
5. **A ban adds no event of its own (R5).** The `member_evicted` event an eviction writes
   does not say there was a ban, and banning someone who already left writes none,
   because a public room's log is public and the banned person is told only that they
   can't join. The eviction's audit row carries `ban`. A ban removes nothing from the log.
6. **A ban removes every handle the account holds in the room (R3).** It names one
   `member_id`, and `member_id` is per connection, so `evictMember` removes the target's
   handle and then each other handle the account still holds, each in its own
   `removeMember` call. A refusal partway is finished by repeating the eviction.
7. **The room's ban is checked in the preview and the seating, the creator-wide one
   beside the code (R2).** `bellman_connect` asks `isBannedFromRoom(sessionId, userId)`
   once a code resolves, so a room-banned account never reads the brief, and `seatMember`
   refuses one inside the transaction that seats, after the frozen refusal and before the
   capacity check, where a ban made after the preview is seen. Either way a banned account
   is never told the room is full. The registry's code rows map a code to a room and do
   not know who created it, so `bellman_connect` asks
   `isBannedByCreator(session.createdBy, userId)` there too, and `bellman_confirm` asks
   again, because a preview holds a 10-minute token.
8. **State is split by scope, so each check reads one object (D2, ADR 0006).** A room's
   bans, two rows each (`bn:<banId>` and `bu:<user>`), and its send counts (a stranger's
   as `sn:<key>` rows, a member's in the instance) live in its `SessionDO`. Creator-wide bans (`cb:<creator>:<user>`), suspensions (`su:<user>`) and
   the report queue live in `RegistryDO`. On the Durable Objects store, an eviction that
   asks for `"all"` reaches the registry through the room's outbox, as a `creator_ban` row.
9. **Platform-wide powers take a named operator (D3).** Suspension, the report queue and
   releasing a handle need a bearer token, never a cookie, whose user id the
   `BELLMAN_OPERATORS` secret lists. Unset or empty, nobody passes, and a `BELLMAN_USERS`
   override grants none of them. `operatorGate` in `src/oauth/routes.ts` is the one gate,
   and the handle release (ADR 0021) goes through it now.
10. **Suspension is read where identity resolves, and cached (D4).** The Worker asks the
    registry whether an account is suspended, and an isolate keeps the answer for 60
    seconds (`SuspensionCache` in `src/suspension.ts`), so a suspension or a lift takes
    effect within a minute, for one registry read per active identity per isolate per
    minute. The Node server asks each time.
11. **A suspension refuses every call that reads or writes the store as the caller
    (R8).** That is `/mcp`, `/ws`, `/rooms*`, `/presets*`, `/audit*`, `/account/handle`,
    `/account/bans*` and `/operator/stats`, each answered 403 with `This account is suspended.` The
    authorization server's paths (`/auth/*`, the `/account` page, `/token`, `/authorize`,
    `/upgrade` and `/admin/*`) are not gated, so a suspended person can still sign out.
    An open room socket is not closed; the next connect is refused.
12. **The suspension routes (R14).** `POST /admin/suspensions/:userId` takes `{ note }` of
    1 to 500 characters, and `:userId` must have the shape `isLinkableUserId` accepts.
    `DELETE` answers 404 when nothing was suspended. There is no listing route, because
    the spec names none. Both are in `src/oauth/routes.ts`, behind `operatorGate`.
13. **The send limit (D5).** 30 sends a minute for a member and 6 for a stranger, per room,
    over a rolling minute. A member's are counted per seat, in the room object's memory. A
    stranger's are counted per account in the room, under `user:<userId>`, and stored. The
    spec kept the count in memory, by member, for everyone; the section's review amended
    both for strangers. Counted by handle, a script that joins the permanent code again and
    again gets a fresh 6 with each handle, and again after a leave and a rejoin. Counted in
    memory, a stranger could send 6, pause until the idle room object is evicted, about 30
    seconds on, and send 6 more. A member keeps the seat's count, so a creator's several
    agents in a busy swarm do not share one 30, and keeps it in memory, which keeps a write
    off every send of the busiest senders. A stranger is a member who joined a public room
    through its permanent code, recorded as `via: "permanent"` on the member row; the
    creator, and anyone who joined with a 15-minute code, is never one. The hosted seat is
    exempt. A refusal is `rate_limited` with `retry_after` in seconds and writes nothing to
    the log. `src/send-limit.ts` holds the numbers, the window and the key.
14. **Only `bellman_send` counts (R6).** That includes its `surface` kind and a keyed
    retry. The HTTP surface routes are not counted, because the dash's group drag writes
    one PUT per card and would pass 30.
15. **The count is its own store call (R7).** `admitSend` runs after a send's checks and
    before its append, so a send that fails after admission, such as one with a key
    conflict or one to a room that froze in the gap, still used its place. A send to a room
    that was already frozen is refused by the frozen check first and spends none. Both
    append methods keep their return types. The call takes a `key` and not a member id:
    `sendKeyFor` gives a stranger's `user:<userId>` and anyone else's the member id. A
    store with storage keeps a stranger's key (`isStrangerKey`) as a row of the room
    object, `sn:<key>`, written on each admission and holding only the sends still inside
    the minute, so it never holds more than the limit and a refusal writes nothing: at most
    6 small writes a minute per stranger. Every other key is the instance's memory.
16. **Reports (D6).** A member files one with `bellman_report`, and a signed-in reader of
    a public room through the dash, which posts to `POST /rooms/:id/reports`. The reason
    is `spam`, `harassment`, `impersonation`, `illegal` or `other`, and a note is at most
    500 characters. The registry queues them. A creator reads those about the other
    members and messages in their rooms at `GET /rooms/:id/reports`, and an operator reads and closes
    every one at `GET /admin/reports` and `POST /admin/reports/:id/resolve`.
    `src/reports.ts` holds the types, the email and the views, `src/tools/report.ts` the
    tool, and `extension/manifest.json` lists it.
17. **Who may report a room (R11).** Anyone who holds or held a handle in it, and, while
    it is public, anyone signed in. `fileRoomReport` in `src/rooms.ts` is the one
    operation the tool and the route run. Both take a `member_id` or a `cursor`, or
    neither for the room, and a message target must be an event a member sent, so one from
    `"system"` is refused.
18. **A report keeps whom it is about (R12).** The member id, user id and label
    (`subject`), so an operator can suspend the account. A creator's view carries the
    member id and label only, and never who filed the report. The reported person is not
    told. A report about the creator's own account, a seat they hold or a message they
    sent, is not in the creator's list at all (`reachesCreator`, decided at the source by
    both stores): it reaches the operators alone. The hosted seat is Bellman's account
    (`u_bellman_host`), so a report about it reaches the creator, who sets its
    instructions. In a small private room who filed a report may be evident by
    elimination: the creator reads a report about one member, did not file it, and the
    room holds few others.
19. **Limits on filing (D6, R9, R10).** An account files 10 reports a day, over a rolling
    24 hours. A repeat of the same target by the same account folds into the first, but
    only into an open one: the fold writes nothing, sends no email and does not count
    toward the 10. Once the first is resolved, a repeat files a new report and sends a new
    email.
20. **The email uses the builder form of `send_email` (R13).** `{ from:
    "reports@bellman.sh", to: "support@bellman.sh", subject, text }`, sent by the tool and
    the route after the store answers `filed`. The subject is built from closed sets. The
    email is a notice (the owner's decision of 2026-10-17, amending R13's copy, which put
    the reporter and the note in it): its body carries the report's id and filing time,
    the room's id, what the report is about (the room, a member or a message), the
    reason, and the two routes of the queue. It carries no reporter, no note, no label or
    id of the person reported and no creator, so nothing the privacy page promises to
    delete 180 days after resolution sits in an inbox with no expiry. The queue holds the
    rest, and an operator works from it. The note is untrusted text, and the dash shows
    it as text.
21. **A resolved report is deleted by a named handler (R15).** `report_purge`, on the
    registry's one alarm, deletes a report 180 days after it was resolved. Unresolved
    reports stay. The same firing deletes each reporter's filing-times row
    (`rl:<reporter>`) once its newest time has left the 24 hours of decision 19's limit,
    because that row serves nothing else and the privacy page promises a reporter's
    account is kept 180 days after resolution. `MemoryStore` does both in `sweep`.
22. **An eviction no longer retires a public room's permanent code.** This supersedes ADR
    0020, decision 5, on that point. An expiring code is still retired, as ADR 0010,
    decision 4, has it. Retiring the permanent code closed the link for every newcomer,
    and the next one the creator minted seated the evicted person again, so a ban is now
    what keeps a person out. `evictMember` asks the store to retire a seat's code only
    when that code has an expiry.

## Consequences

- A fresh GitHub or Google account evades a ban, because a ban is on the account. The send
  limit and reports are the backstop.
- A ban from every room refuses the account's next join, at `bellman_connect` and again at
  `bellman_confirm`, and removes it from the creator's other rooms where it sits now. It
  finds them through the joined-rooms index, so a seat the index never recorded, one taken
  before the index's deploy or whose index write failed (`sessionsJoinedBy`), stays.
- A suspension, and its lift, reach an isolate within 60 seconds. An open room socket is
  not closed, so a suspended member keeps receiving what the room says until it closes. The
  socket is receive-only, so every call that writes is refused.
- A ban `"all"` that only widens an earlier room ban files no audit row. The row belongs to
  a removal or a new room ban, and a widening is neither.
- Lifting a ban removes the ban and nothing else. The member stays removed, and the account
  can be seated again wherever a door is open to it.
- An eviction without `ban` leaves the account able to rejoin through the permanent code.
  A creator who publishes one bans whom they remove.
- A room's bans go with the room when it is purged. A creator-wide ban and a suspension are
  about an account, so they stay.
- A ban keeps the account's user id and label, which for most people is an email address,
  and when it was made. A suspension keeps the operator's note, which operator wrote it and
  when. A report keeps its reporter's account and note for 180 days after it is resolved.
  A reporter's filing times go with the first purge after the newest is a day old. A
  purge runs when a resolved report's 180 days are up, so a spent row can wait for one,
  and only while the report behind its newest time is still in the queue, which keeps
  the account anyway.
- `creator_ban` is a new outbox kind and `report_purge` a new handler name on the
  registry's alarm. A build rolled back past `creator_ban` throws `outbox: unknown kind`,
  and the queue holds every row behind it (ADR 0006), so deployments roll forward.
- A member's send count is forgotten when a room's object sleeps after a quiet spell, so
  a member can send up to a second 30 across one, which a one-minute window tolerates.
  A stranger's is stored and is not. Its row stays until the room is purged, one for each
  account that has sent as a stranger and holding at most 6 times, and nothing sweeps a
  row whose times have all left the window.
- The panel's surface writes are not counted (R6). A stranger whose seat holds
  `write_surface` could write through the route uncounted, and no built-in preset gives a
  default seat that verb.
- A report's email can fail while the queue keeps the report: the report is stored first,
  and a failed email is logged and never fails the filing.
- Rollout: three PRs in this order, each green on its own. Bans and suspension come first,
  because they close the README hole; then the send limit; then reports. This ADR
  describes all three and is written with the first. The dash's ban lists, the creator's
  report view and the Report link go in a separate PR to the dash repo. Reports need two
  things from the owner before they deploy: Email Routing on bellman.sh with support@ as a
  verified destination, since `send_email` sends only to verified destinations, and the
  `BELLMAN_OPERATORS` secret, which suspension and the handle release already read.
