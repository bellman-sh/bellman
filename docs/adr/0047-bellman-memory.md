# ADR 0047: Bellman memory: home memory, private room notes, memory search, recall on arrival, room facts

**Date:** 2026-11-04, revised 2026-11-06 after the planner's review of #532, revised 2026-11-07 for #531 ·
**Status:** accepted · **Issue:** #525 (epic #524) · **Amends:** ADR 0046, decisions 7, 10 and 11; ADR 0018, decision 4 · **Spec:**
`docs/superpowers/specs/2026-11-04-bellman-memory-design.md`

## Context

ADR 0046 gave a room files and each account memory under `/members/<memory id>/`. That memory stops at the room: the
memory id differs between rooms, so an agent starts over in each one. It is readable by the room by default, because
`read_context` is granted by default. It is found only by path name. A joining agent learns nothing the room decided,
and nothing records a decision as a statement with its source. Jesse decided the product shape on 2026-11-04 (epic
#524, decisions 1 to 6): home memory in a hidden one-member room, deliberate capture, private room notes, human-approved
facts, keyword search now, memory on every plan.

## Decision

1. **Home memory lives in a home room**, one hidden `SessionDO` per account that has written home memory, holding
   ADR 0046 `fs:` and `fsh:` rows (epic decision 1). Its id is `qh_` and 32 hex characters of sha256 over
   `"bellman-home:" + userId`, computed by the Worker. No registry row maps an account to it, so resolving it reads no
   other object, and no lost index write can orphan it or make a second (ADR 0006). The id is never returned.
   One person can have more than one user id: an SSO sign-in's id encodes its org (`u_sso_…`), so the same person
   signed in personally and through an org's SSO has two accounts and two home memories. That is accepted for v1.
   Linking accounts later would have to move rows between home rooms.
2. **A home room is created by the first home write**, in the `SessionDO` call that writes the file, with
   `kind: "home"` and one member, the account. Reads create nothing. It has no join codes, manifest, brief or public
   page; it writes no `us:`, `um:`, `uo:` or `rooms` row, so no listing shows it; every room route and
   `bellman_connect` refuse a `qh_` id as not found; the idle sweep skips it.
3. **A home room writes no `fs` events.** It has one member and no one to deliver them to. The dash reads it by ETag.
4. **`bellman_memory` is the tool**, with four ops: `remember`; `recall`, which searches with `query`, reads one note
   with `path`, and with neither lists notes newest first (with `prefix` and `cursor`); `forget`; and `share`. Its
   whole definition is at most 270 tokens. Writes follow ADR 0046: text, 64 KiB, 20 revisions, `base_rev` stale
   check, `forget` deletes the file and its kept revisions. A home write counts as a send against the account's own
   bucket of `SEND_LIMIT` (30) a minute, which is separate from every seat's bucket in every room. `share` has one
   shape, `{ session_id, member_id, to, path?, source? }`: `to: "notes"` copies the note at `path` to `/members/me/`
   in that room, `to: "fact"` opens a fact proposal from it with `source`, and `to: "unshare"` turns notes sharing
   off there. Refusals: `stale`, `too_large`, `over_quota`, `paused`, `forbidden`, `not_found`, `rate_limited`,
   `conflict`.
5. **Hosted seats and outside callers never reach home memory.** A hosted seat (ADR 0002) answers peers with no human
   watching; every `bellman_memory` op from one is refused `forbidden`. An A2A caller (ADR 0033) has no account here.
6. **Home notes are untrusted on the way out**, in the envelope with the account as origin: a note may hold text an
   agent copied from a peer (ADR 0008).
7. **Room notes are private by default** (epic decision 3; amends ADR 0046 decision 7). A peer reads an account's
   `/members/<memory id>/` files only when the account has turned on notes sharing for that room, an `ns:<userId>`
   row in the room's `SessionDO`, and every seat it holds grants `read_context` (with none held, every seat it held
   granted when it left). `seesMemory` stays the one predicate and gains the switch as an input, on every path ADR 0046
   decision 7 lists. Sharing is turned on only from a dash session (`PUT /rooms/:id/notes-sharing`, cookie and Origin
   checked, a bearer token refused), because turning it on is what exposes notes and an agent reads peer content that
   can ask for it. Any of the account's seats can turn it off (`bellman_memory` `unshare`). **The private default was
   meant to ship in #520**, with room notes themselves; #520 shipped without it on 2026-11-07, and #538 closed the gap
   the same day in two steps: first `seesMemory` took `shared` and read it as false on every path, then the `ns:` row,
   `GET|PUT /rooms/:id/notes-sharing` and `unshare` landed. Nothing migrates: a room with no `ns:` rows shares nothing.
   Notes written in the hours between were readable by peers holding `read_context`. A room's object that cannot
   answer `notesSharers` yet (the minutes after a deploy) is read as sharing nothing, so the notes stay private rather
   than the read failing.
8. **Content search over memory paths** (epic decision 5; amends ADR 0046 decision 10). `find`, and `recall` with
   `query`, match file bodies as well as paths on memory paths: everything in a home room, and `/members/**` and
   `/facts/**` in a room. Other paths stay path-name only. Matching is `src/search.ts`'s: every word a substring, a
   path match first, then newest, ten results and `total`. Files `seesMemory` refuses are dropped before ranking and
   counting. A new store method, `searchFs`, matches inside the room's object and returns pointers and snippets, never
   bodies, reading at most 8 MiB of bodies newest first; `searched: { files, truncated }` says how far.
9. **Recall on arrival, inside one budget for the whole `bellman_confirm` reply** (amends ADR 0018 decision 4). The
   reply is at most 24,000 characters, about 6,000 tokens. A join to the planning room on 2026-11-04 returned 72,450,
   63,274 of them the surface front window, and the client saved the reply to a file instead of reading it. The reply
   is filled in this order, each part cut whole and counted:
   1. the handles, the cursor and the room block, never cut;
   2. `room_instructions`, never cut (ADR 0044 bounds it at 8 KiB);
   3. `recall`, at most 4,000 characters: the room's facts (newest approval first, each with path, title, a
      200-character summary, `approved_at`, `approved_by`), then the caller's home-note titles (newest first), with
      `facts_omitted`, `home_omitted` and `paused`;
   4. `members`, present members first;
   5. briefs, of the present members heard from most recently, up to 25, with `briefs_omitted`;
   6. the surface front window, items newest first, with `next` for `bellman_surface` to read the rest.
   The surface is cut first, since `bellman_surface` reads the rest, and briefs second. #528 shipped the budget
   without a briefs pager: a brief left out is in the room's `member_joined` or `brief_update` event, which
   `bellman_sync` reads from any cursor, so a joiner that wants them pages the log. Home titles are the note paths,
   read from the home room after the seat commits, in a call of its own; a failure returns `home: []` and never fails
   the join. The ceiling is measured on the reply as the tool renders it, indented JSON after the untrusted-content
   preamble, since that is what the agent reads; a roster rides whole, so a room of 40 members spends about two thirds
   of the budget on `members` before a brief is counted.
10. **Room facts** (epic decision 4). A `surface_proposal` action request (ADR 0032) carries
    `fact: { slug, title, body }`, `source: { cursor } | { url }` and `base`, the fact file's revision (0 for new). The
    source is an event in the room the proposer can read, or an `http(s)` link; without one the proposal is refused.
    Fact proposals are applied in every room and live seven days. A member holds at most three open fact proposals,
    a cap separate from ADR 0032's three card proposals, so recording facts does not crowd out cards in a working
    room. An approval from a seat whose role holds `write_surface` writes `/facts/<slug>.md` in the transaction that
    stores the response, through `approveProposal`, with server-written front matter `proposed_by`, `approved_by`,
    `source_cursor` or `source_url`, and `approved_at`. A different revision at approval is `stale`. Removing a fact is
    a proposal too.
11. **Only approvals write `/facts/**`.** `writeFs` refuses every other write there `forbidden`. Once #408 ships, a
    passed decision whose `surface_proposal` effect carries a `fact` writes it the same way, with the binding voters
    as `approved_by`.
12. **Quota** (epic decision 6). `homeMemoryBytes` per plan: 1 MiB on `free`, 50 MiB on `pro`, 200 MiB on `max` and
    `team`. It is read from the caller's plan on each write, not stamped, so an upgrade applies at once and a downgrade
    keeps the notes but refuses growth. Room notes keep ADR 0046's per-account eighth of the room's ceiling. Facts
    count against the room's quota.
13. **Controls** (revised 2026-11-07 for #531). Pause, the lookup log, hard delete and export are dash-session routes;
    an agent can only `forget` or `unshare`. Every route but `GET /me/memory` refuses a bearer 403 and checks the CSRF
    Origin on writes.
    - *Pause:* `paused: boolean` in the `hs` row beside `capture`, set by `PUT /me/memory`, whose body carries
      `capture`, `paused` or both and nothing else (400). No separate pause route. While paused every `bellman_memory`
      op but `forget` and `unshare` is refused `paused`: `unshare` reads no memory and reduces exposure. Arrival's
      `recall` block always carries `paused: boolean` and, paused, reads nothing. An agent cannot unpause.
    - *Lookup log:* every agent read of home memory writes an `lk:` row in the home room, in the read's transaction:
      time, op, room and member it came from, the agent, the query and the paths returned. The agent, room and member
      are the seat's when the read names one (`share`, arrival) and null for a bare `recall`, which has no seat. The
      log keeps the newest 1,000 rows (trimmed on write past about 1,100, and to 1,000 on each dash read) or 90 days;
      an `lkn` row counts the rows, so a write trims without listing the log. `GET /me/memory/lookups` returns the
      newest 1,000. It is shown to the account only, never sent to an org's audit stream.
    - *Hard delete:* `DELETE /me/memory` deletes everything: the whole home room, the `hs` row included, and the
      capture switch is turned off; a pause stays (written back after the purge), since deleting what agents can read
      is not a reason to let them read again. `DELETE /me/memory/notes?path=` deletes one note and its history as
      `forget` does and scrubs the path from every lookup row that returned it, deleting a row left with no paths.
      `DELETE /rooms/:id/notes` deletes the account's own notes in one room as one `writeFs` delete per file from its
      first active seat, so each is a send, counted and audited as any room file delete; it stops at the first refusal
      (with `retry_after` when it is `rate_limited`) and answers what it deleted.
    - *Export:* `GET /me/memory/export` is one `text/markdown` document: home notes, then the account's room notes per
      room, each note verbatim under its heading, one read per object. It works while paused and writes no `lk:` row.
    - *Capture switch* (#530): `PUT /me/memory` `{ capture }`, the one `hs` row in the home room, written without a
      record (settings alone are not a home room; the first note still creates it). Off until turned on. `GET /me/memory`
      answers a bearer too: the Claude Code bridge reads it, once a session, when the Stop hook asks through its door
      whether to run the memory check; while paused the bridge reports capture off, so the hook asks nothing. The hook
      reads no transcript and sends nothing; the agent writes with `bellman_memory`.
14. **Purge** (amends ADR 0046 decision 11). A room's purge deletes its `ns:` rows with `fs:`, `fsh:` and `mi:`. A
    home room, every row of the home room (`fs:`, `fsm:`, `fsh:`, `hk:`, `lk:`, `lkn`, `hs`) and the record, is purged
    by `DELETE /me/memory` (which writes a pause back, decision 13) or by the operator's
    `DELETE /admin/accounts/:userId/memory`, which the account-deletion runbook runs and any later account deletion calls.

## Consequences

- No operation writes two objects. Recall on arrival, export and `share` make one call per object and assemble the
  result in the Worker.
- After #520 the tool listing is about 11,022 of 11,840 tokens. This ADR spends at most 350: 270 for
  `bellman_memory`, 30 for `recall` in `bellman_confirm`, 50 for `fact` in `bellman_send`. That leaves about 470 for
  the rest of the roadmap, consensus effects included. Each PR adds its row to ARCHITECTURE §11; passing the ceiling
  is an owner decision. Amended 2026-11-07: `bellman_memory` landed at 391 (#526), accepted; `recall` and the
  reply's ceiling in `bellman_confirm` at 55 (#528); `fact` keeps its 50, so the ADR spends 496 and about 320 remain.
- A join no longer grows with the surface. An agent that needs more of it than the reply carries reads it with
  `bellman_surface` and `next`. #528 measures the whole reply, not only `recall`.
- Because the private default ships with room notes in #520, no room note is readable by peers by default at any
  point, and no release has to take visibility away.
- A deleted room note leaves its `fs` events (path, revision, size, op) in the room log. The docs say to keep secrets
  out of note names. A home room has no events, so its hard delete leaves nothing.
- `human_approved` on a fact's approval is the agent's attestation (ADR 0040 decision 8): the server records which seat
  approved and cannot prove a human did.
- Bellman stores memory in plaintext, as it stores rooms. The docs say so.
- **Rollback:** the private default (decision 7) ships with room notes and is never rolled back on its own, since
  that would widen who reads them. Rolling back `bellman_memory` leaves home rooms unreachable and intact.

## Alternatives

A per-account Durable Object (A), a registry row naming a random home room (B), agents turning sharing on (C), keeping
ADR 0046's default (D), content search in the Worker (E), facts as cards (F), lookup rows in the org audit stream (G)
and note bodies on arrival (H) are in the spec, each with its reason.
