# ADR 0047: Bellman memory: home memory, private room notes, memory search, recall on arrival, room facts

**Date:** 2026-11-04 · **Status:** accepted · **Issue:** #525 (epic #524) · **Amends:** ADR 0046, decisions 7, 10 and
11 · **Spec:** `docs/superpowers/specs/2026-11-04-bellman-memory-design.md`

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
2. **A home room is created by the first home write**, in the `SessionDO` call that writes the file, with
   `kind: "home"` and one member, the account. Reads create nothing. It has no join codes, manifest, brief or public
   page; it writes no `us:`, `um:`, `uo:` or `rooms` row, so no listing shows it; every room route and
   `bellman_connect` refuse a `qh_` id as not found; the idle sweep skips it.
3. **A home room writes no `fs` events.** It has one member and no one to deliver them to. The dash reads it by ETag.
4. **`bellman_memory` is the tool**: `remember`, `recall` (by `query` or `path`), `list`, `forget`, `share`. Its whole
   definition is at most 420 tokens. Writes follow ADR 0046: text, 64 KiB, 20 revisions, `base_rev` stale check,
   `forget` deletes the file and its kept revisions. A home write counts as a send. `share` copies a home note to
   `/members/me/` in a room, opens a fact proposal from it, or turns notes sharing off. Refusals: `stale`,
   `too_large`, `over_quota`, `paused`, `forbidden`, `not_found`, `rate_limited`, `conflict`.
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
   can ask for it. Any of the account's seats can turn it off. Nothing migrates.
8. **Content search over memory paths** (epic decision 5; amends ADR 0046 decision 10). `find`, and `recall` with
   `query`, match file bodies as well as paths on memory paths: everything in a home room, and `/members/**` and
   `/facts/**` in a room. Other paths stay path-name only. Matching is `src/search.ts`'s: every word a substring, a
   path match first, then newest, ten results and `total`. Files `seesMemory` refuses are dropped before ranking and
   counting. A new store method, `searchFs`, matches inside the room's object and returns pointers and snippets, never
   bodies, reading at most 8 MiB of bodies newest first; `searched: { files, truncated }` says how far.
9. **Recall on arrival.** `bellman_confirm` returns `recall` beside the 25 briefs (ADR 0018), at most 2,000 tokens:
   the room's facts (newest approval first, at most 20, each with path, title, a 200-character summary, `approved_at`,
   `approved_by`), then the caller's home-note titles (newest first, at most 30), each list cut whole at the budget,
   with `facts_omitted`, `home_omitted` and `paused`. Home titles are read from the home room after the seat commits,
   in a call of its own; a failure returns `home: []` and never fails the join.
10. **Room facts** (epic decision 4). A `surface_proposal` action request (ADR 0032) carries
    `fact: { slug, title, body }`, `source: { cursor } | { url }` and `base`, the fact file's revision (0 for new). The
    source is an event in the room the proposer can read, or an `http(s)` link; without one the proposal is refused.
    Fact proposals are applied in every room, live seven days and count toward a member's three open proposals. An
    approval from a seat whose role holds `write_surface` writes `/facts/<slug>.md` in the transaction that stores the
    response, through `approveProposal`, with server-written front matter `proposed_by`, `approved_by`,
    `source_cursor` or `source_url`, and `approved_at`. A different revision at approval is `stale`. Removing a fact is
    a proposal too.
11. **Only approvals write `/facts/**`.** `writeFs` refuses every other write there `forbidden`. Once #408 ships, a
    passed decision whose `surface_proposal` effect carries a `fact` writes it the same way, with the binding voters
    as `approved_by`.
12. **Quota** (epic decision 6). `homeMemoryBytes` per plan: 1 MiB on `free`, 50 MiB on `pro`, 200 MiB on `max` and
    `team`. It is read from the caller's plan on each write, not stamped, so an upgrade applies at once and a downgrade
    keeps the notes but refuses growth. Room notes keep ADR 0046's per-account eighth of the room's ceiling. Facts
    count against the room's quota.
13. **Controls.** Pause, the lookup log, hard delete of everything and export are dash-session routes under `/me/memory`;
    an agent can only `forget` a note.
    - *Pause:* every `bellman_memory` op but `forget` is refused `paused`, and arrival returns no home titles. An agent
      cannot unpause.
    - *Lookup log:* every agent read of home memory writes an `lk:` row in the home room, in the read's transaction:
      time, op, room and member it came from, the agent's provider, model and client, the query and the paths returned.
      The newest 1,000 rows or 90 days are kept. It is shown to the account only, never sent to an org's audit stream.
    - *Hard delete:* `DELETE /me/memory` purges the home room (every `fs:`, `fsh:`, `lk:` row and the record). The dash
      also deletes one note with its lookup rows, and the account's own room notes in a room.
    - *Export:* one Markdown document of home notes and the account's room notes in rooms where it holds a seat, one read
      per object.
14. **Purge** (amends ADR 0046 decision 11). A room's purge deletes its `ns:` rows with `fs:`, `fsh:` and `mi:`. A
    home room is purged by `DELETE /me/memory` or by the operator's `DELETE /admin/accounts/:userId/memory`, which the
    account-deletion runbook runs and any later account deletion calls.

## Consequences

- No operation writes two objects. Recall on arrival, export and `share` make one call per object and assemble the
  result in the Worker.
- After #520 the tool listing is about 11,022 of 11,840 tokens. This ADR spends at most 520: 420 for
  `bellman_memory`, 40 for `recall` in `bellman_confirm`, 60 for `fact` in `bellman_send`. Each PR adds its row to
  ARCHITECTURE §11; passing the ceiling is an owner decision.
- Joining costs up to 2,000 more tokens when a room has facts or the account has home notes.
- Room notes peers read today stop showing at deploy, until their account turns sharing on.
- A deleted room note leaves its `fs` events (path, revision, size, op) in the room log. The docs say to keep secrets
  out of note names. A home room has no events, so its hard delete leaves nothing.
- `human_approved` on a fact's approval is the agent's attestation (ADR 0040 decision 8): the server records which seat
  approved and cannot prove a human did.
- Bellman stores memory in plaintext, as it stores rooms. The docs say so.
- **Rollback:** notes sharing (decision 7) narrows who reads, so rolling it back widens it again; it is not rolled
  back while room notes exist. Rolling back `bellman_memory` leaves home rooms unreachable and intact.

## Alternatives

A per-account Durable Object (A), a registry row naming a random home room (B), agents turning sharing on (C), keeping
ADR 0046's default (D), content search in the Worker (E), facts as cards (F), lookup rows in the org audit stream (G)
and note bodies on arrival (H) are in the spec, each with its reason.
