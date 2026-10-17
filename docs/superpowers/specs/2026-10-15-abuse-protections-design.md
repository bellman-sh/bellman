# Abuse protections: design

**Date:** 2026-10-15 · **Status:** for review

## Goal

Make it safe to publish a public room's permanent join code in a README or on a web page. Today three things stand in the way:

- Someone the creator evicted can rejoin through that code (`bellman_evict`: "Removal is not a ban").
- Nothing limits how fast a member sends.
- Nobody can report abuse.

Success means:

- A member evicted with a ban cannot rejoin through any code, permanent or not.
- A member who joined through a public room's permanent code sends at most 6 times a minute. Every other member sends at most 30.
- A member, or a signed-in reader of a public room, can report the room, a member or a message.
  - Every report reaches the operator's queue and inbox.
  - A report about a member or a message also reaches the room's creator.

## Decisions

- **D1. Three ban levels.**
  - A **room ban**, set by the room's creator.
  - A **creator-wide ban**, set by the creator, covering every room they own, now and later.
  - An **operator suspension**, covering all of Bellman.
- **D2. State is split by scope.** Room bans and send counts live in the room's own `SessionDO`. Creator-wide bans, suspensions and the report queue live in `RegistryDO`. Each check reads one object, so nothing spans two (ADR 0006).
- **D3. Platform-wide powers take a named operator.** That means suspension, the report queue, and releasing a handle (bylines). The caller's user id must be in `BELLMAN_OPERATORS`, a comma-separated secret. When it is unset or empty, nobody passes. Plan overrides in `BELLMAN_USERS` grant none of these powers.
- **D4. Suspension is read where identity resolves.** It is cached per isolate for 60 seconds, so a suspension takes effect within a minute and costs one registry read per active identity per isolate per minute.
- **D5. The send limit** is counted per member, per room, over a rolling minute, in the room object's memory. It is 30 sends for a member and 6 for a stranger. The hosted seat is exempt.
- **D6. Reports** come from members, through `bellman_report`, and from signed-in readers, through the dash.
  - Each account may file 10 a day, and a repeat of the same report folds into the first.
  - The registry queues them, and each one sends an email.
  - A report is kept for 180 days after it is resolved.

## 1. Bans

- **Room ban.**
  - `bellman_evict` gains `ban?: "room" | "all"`. With `"room"`, the room object records the account with the member's label and the time.
  - A join that resolves to a banned account is refused at the join step, `bellman_confirm`, whichever code it came through.
  - The dash's room page lists the room's bans by label and time. The creator lifts one there, through `GET /rooms/:id/bans` and `DELETE /rooms/:id/bans/:banId`. A `banId` is an opaque id, so a creator never sees an account's user id.
- **Creator-wide ban.**
  - `ban: "all"` also writes the account to the registry under the creator. The registry checks this in the same call that resolves a join code, so a code for any of that creator's rooms refuses the account.
  - The creator lists and lifts these in dash Settings, through `GET /account/bans` and `DELETE /account/bans/:banId`.
- **Suspension.**
  - Operators call `POST` and `DELETE /admin/suspensions/:userId`, with a note on `POST`. Both sit behind `BELLMAN_OPERATORS`.
  - A suspended account is refused on every authenticated call, with "This account is suspended.", so it can't join, send, start a room or act in a room where it holds a seat.
- **What a banned person sees.** "You can't join this room." It names neither who banned them nor the level.
- **Evidence stays.** A ban removes nothing from the room's log.
- **Bans work by account.** A fresh GitHub or Google account gets around one. The send limit and reports cover that gap.

## 2. The send limit

- **A stranger** is a member who joined a public room through its permanent code. The seat records how it joined, as `via: "permanent"` on the member row. The creator, and anyone who joined with a regular 15-minute code, is never a stranger.
- **What counts:** every `bellman_send`, whatever its type: message, artifact, action request or response, surface write, brief update, progress. Reads (`bellman_sync`, `bellman_surface`), joining and leaving don't count.
- **Over the limit:** the send is refused as `rate_limited`, with `retry_after` in seconds, and nothing is written to the log.
- **Memory only:** a room object that sleeps after a quiet spell forgets its counts, which is fine for a one-minute window.
- **Fixed for now:** the two numbers are constants in one module, documented in the trust model. A room can't set its own limit yet.

## 3. Reports

- **Filing.**
  - **Members** use `bellman_report`, a new tool, so `extension/manifest.json` gains it. Its arguments are the room, a target, a reason and an optional note.
    - The target is the room, a member id, or a message's cursor, so a report points at evidence in the log.
    - The reason is one of `spam`, `harassment`, `impersonation`, `illegal` or `other`.
    - The note is up to 500 characters.
  - **Signed-in readers** use a Report link on a public room's page in the dash, which posts the same fields to `POST /rooms/:id/reports` with the cookie and the CSRF check.
- **Limits on reporting.** Each account may file 10 reports a day. A second report of the same target by the same account folds into the first, with no new email.
- **Storage.** The registry holds the queue, with an index by room creator that holds only reports about members and messages.
- **Routing.**
  - **The creator** reads reports about members and messages in their rooms at `GET /rooms/:id/reports`, on the room's page beside a Ban button. They never see who filed a report.
  - **Operators** read every report at `GET /admin/reports`, including reports about a room itself, and close one with a note at `POST /admin/reports/:id/resolve`.
  - **Email.** Each report sends one message to support@ through Cloudflare's `send_email` binding, after the report is stored. A failed email never fails the report, because the queue is the record.
- **Trust.** The note is untrusted text. The dash renders it as text, and the email carries it as plain text.
- **No notice to the reported person.** Bans and suspensions are how they find out.
- **Retention.** A registry alarm deletes a report 180 days after it is resolved. Unresolved reports stay.

## 4. Tests, docs and rollout

- **Store:** contract cases in both stores for each ban level, lifting a ban, suspension, and the report queue: folding duplicates, the daily limit, and the creator's index skipping reports about a room.
- **Tools:** `bellman_evict` with `ban`, `bellman_report`, and the send limit.
  - Both limits, 30 and 6.
  - `retry_after` on a refusal.
  - Nothing logged on a refusal.
  - The hosted seat is exempt.
  - Only a permanent code makes a stranger.
- **Routes:** every admin route fails closed without `BELLMAN_OPERATORS`, and the report route checks the cookie and the CSRF origin.
- **Worker:** one test per new route over real objects, with the email binding stubbed.
- **The hole this closes:** a member is evicted with `ban: "room"`, then redeems the room's permanent code, and is refused.
- **Tool listing:** the extension test checks that `bellman_report` is in the manifest. Measure the tool listing before and after, and keep the new description short.
- **Docs:**
  - a new ADR, numbered at merge, after bylines' 0021;
  - the trust page and the docs site cover bans, limits and reports;
  - the privacy page says a report keeps the reporter's account and note for 180 days after it is resolved.
- **Rollout:** bans ship first, since they close the README hole, then the send limit, then reports.
  - **Before reports ship,** the owner sets up Email Routing on bellman.sh with support@ as a verified destination, and the `BELLMAN_OPERATORS` secret.
  - **Dash:** the ban lists, the creator's report view and the Report link go in a separate dash PR.

## Out of scope

- Limits by IP address.
- Signed-out reports, and a challenge to go with them.
- Hiding or deleting messages.
- Automated moderation.
- Appeals.
- A rate limit on public reads (public-rooms spec, D9).

## Risks

- **Ban evasion:** a fresh account gets around a ban. The send limit and reports are the backstop.
- **Suspension delay:** a suspension takes up to 60 seconds to reach a busy isolate (D4).
- **Registry load:** report writes are rare, and suspension reads are cached.
- **Email Routing:** `send_email` sends only to verified destinations. That suits operator mail, and it rules out email to creators.
