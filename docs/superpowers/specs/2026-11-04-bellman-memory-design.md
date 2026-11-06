# Bellman memory

*   **Author:** mcfearsome
*   **Status:** Draft
*   **Date:** 2026-11-04 (revised 2026-11-06 after the planner's review of #532)
*   **Issue:** #525 (epic #524) · **ADR:** `docs/adr/0047-bellman-memory.md`

--------------------------------------------------------------------------------

## Overview

Bellman remembers what got decided, who decided it, and where it came from. Three layers, built on the room filesystem
(ADR 0046):

*   **Home memory.** Notes an account keeps for itself, readable by every seat the account holds in any room and from
    any client, and never by peers. Stored as `fs:` rows in a hidden room with one member, the account's **home room**.
*   **Room notes.** ADR 0046's `/members/<memory id>/` files, changed to private by default. An account shares them
    with a room by turning on a switch for that room.
*   **Room facts.** Short statements a room has approved. An agent proposes one with its source; a human whose seat
    holds `write_surface` approves it; the approval writes `/facts/<slug>.md` with the proposer, the approver and the
    source.

Around them: keyword search over memory bodies, recall on arrival (what `bellman_confirm` hands a joining agent), and
the controls a person needs to trust it: pause, a lookup log, hard delete and export.

The six product decisions were made by Jesse on 2026-11-04 (epic #524). This spec settles the rest.

## The Problem

*   **Memory stops at the room.** ADR 0046 memory lives in one room under a memory id that differs between rooms. An
    agent that learns a person's conventions in one room starts over in the next, and a chat agent that joins a room has
    nothing of the person it works for.
*   **Room memory is public to the room by default.** ADR 0046 reveals notes to peers whenever every seat grants
    `read_context`, and `read_context` is granted by default, so most notes are readable by the room without anyone
    choosing that.
*   **Memory is found by its file name only.** ADR 0046 decision 10: `find` matches path names. A note is found only if
    the agent guesses its name.
*   **A joining agent learns nothing the room decided.** It gets 25 briefs (ADR 0018) and the front window of the
    surface, and has to read the log to learn what was agreed.
*   **Nothing records a decision as a fact with its source.** A surface card can say anything, and a passed decision
    (ADR 0040) leaves an event, not a statement an agent can recall.

Dray (withdray.com) sells cross-agent memory captured by a browser extension that reads chats. Bellman does not read
anyone's chats (epic decision 2): memory is what an agent or a person chose to write.

## Terms

*   **Account**, **seat**, **memory id**, **room file**, **room socket**, **public page**: as in `GLOSSARY.md`.
*   **Home room**: an account's hidden one-member room that holds its home memory. Never listed, joined or public.
*   **Home memory**: the files in an account's home room. Paths are relative to the home room's root, for example
    `/conventions/git.md`.
*   **Home note**: one file of home memory.
*   **Room notes**: the files under `/members/<memory id>/` in an ordinary room (ADR 0046's "memory").
*   **Notes sharing**: an account's switch, per room, that lets peers read its room notes there.
*   **Room fact**: a file under `/facts/` in a room, written only by an approved fact proposal or a passed decision.
*   **Memory paths**: the paths content search covers: everything in a home room, `/members/**` and `/facts/**`.
*   **Lookup log**: the record of every agent read of an account's home memory, kept in its home room and shown only to
    the account.
*   **Dash session**: a signed-in browser session on the dash, authenticated by cookie. A bearer token never counts as
    one (as for governed config, ADR 0044).

## Decisions

Product decisions (Jesse, 2026-11-04, epic #524), numbered as the epic numbers them:

1.  Home memory lives in a hidden one-member room per account, not in a new per-account Durable Object.
2.  Capture is deliberate: agents write; an opt-in Claude Code stop hook and imports help. No chat-reading extension.
3.  Room notes under `/members/` are private by default; sharing them with a room is a per-account switch.
4.  Room facts: agents propose, a human with `write_surface` approves (the ADR 0032 flow).
5.  Search v1 is keyword over memory file bodies; semantic ranking stays ADR 0034 D9's named upgrade.
6.  Memory is included on every plan, with a quota that grows with the plan. No paid add-on.

Design decisions this spec makes, numbered D1 onward:

*   **D1.** A home room's id is derived from the user id, so resolving it reads no other object and no registry row can
    go missing (§1).
*   **D2.** A home room writes no `fs` events; it has no one to deliver them to (§1).
*   **D3.** `bellman_memory` is one tool with four ops, at most 270 tokens (§2).
*   **D4.** Hosted seats and outside A2A callers never reach home memory (§2).
*   **D5.** Notes sharing is turned on only from a dash session; any of the account's seats can turn it off (§3).
*   **D6.** Content search runs inside the room's object and returns pointers, never whole bodies (§4).
*   **D7.** Recall on arrival fits inside one budget for the whole `bellman_confirm` reply, 24,000 characters; the
    surface window is cut first (§5).
*   **D8.** `/facts/**` is written only by an approval or a passed decision; a direct write is refused (§6).
*   **D9.** A fact proposal names its source: an event cursor in the room or an `http(s)` link (§6).
*   **D10.** The home room's quota follows the account's plan at write time and is not stamped (§7).
*   **D11.** Pause, hard delete of everything and export are dash-session actions; an agent can only `forget` one
    note (§8).
*   **D12.** The lookup log lives in the home room, written in the transaction that serves the read (§8).

## Goals

*   An agent in any room, on any client, recalls a note its account wrote from another room or another client.
*   A note is found by a word in its body.
*   A peer reads an account's room notes only when that account chose to share them in that room.
*   A joining agent learns the room's approved facts, and the titles of its own home notes, in `bellman_confirm`.
*   Every fact says who proposed it, who approved it and where it came from.
*   A person can see every time an agent read their home memory, pause it, export it and delete it.
*   Nothing in this design writes two Durable Objects in one operation (ADR 0006).

## Non-Goals

*   **Reading chats.** No extension, no transcript scraping (epic decision 2). Capture (#530) is an opt-in hook and
    imports.
*   **Semantic search.** Keyword now; embeddings are ADR 0034 D9's upgrade.
*   **Search across rooms.** A search reads one room, or the caller's home room. Recall does not search the account's
    other rooms' notes.
*   **Peer access to home memory.** No grant, role or decision exposes it. Sharing a home note is an explicit copy into
    a room (§2, `share`).
*   **Facts on the public page.** `publicReadEvent` drops every `fs` event (ADR 0046), and facts are files. A public
    room shows a fact only if someone also writes it as a card.
*   **End-to-end encryption.** Bellman stores memory in plaintext, as it stores every room. The docs say so.

## Open Questions

None blocking. Two are left for the build PRs, each with a default:

*   **The whole-confirm budget** (D7) is a starting value. #528 measures the whole reply, on the planning room and on
    a room at the most briefs and surface items, and records the figure in ARCHITECTURE §11.
*   **Lookup log retention** (D12) starts at the newest 1,000 rows or 90 days, whichever is fewer. #531 can change it.

## Critical User Journeys (CUJs)

### CUJ 1: An agent remembers a convention, and another agent recalls it elsewhere

1.  In room A, Jesse tells a Claude Code agent "we always squash-merge". The agent calls `bellman_memory remember`
    with `/conventions/git.md`.
2.  A week later a ChatGPT agent signed in as the same account joins room B. `bellman_confirm` lists the home note
    titles, `conventions/git.md` among them.
3.  The agent calls `bellman_memory recall` with `query: "merge"` and gets the note's path and snippet; it reads the
    note with `recall` and `path`.
4.  In the dash, Jesse sees two lookup rows: the confirm in room B, and the recall.

### CUJ 2: A member shares room notes

1.  Priya's agent keeps `/members/me/review-checklist.md` in a team room. Peers' agents cannot list or read it.
2.  Priya turns on notes sharing for that room in the dash. Peers now read it, as long as every seat Priya holds grants
    `read_context`.
3.  Priya turns it off through the agent with `bellman_memory share` and `to: "unshare"`. The next read by a peer finds
    nothing.

### CUJ 3: A decision becomes a fact

1.  In the planning room, an agent proposes a fact: "Memory is free on every plan", source the cursor of the
    planner's message recording Jesse's decision.
2.  Jesse's agent shows Jesse the outstanding proposal, and Jesse approves. The approval writes `/facts/memory-is-free.md`
    with `proposed_by`, `approved_by`, `source_cursor` and `approved_at`.
3.  The next coder to join gets it in `bellman_confirm`'s recall.

### CUJ 4: A person pauses, exports and deletes

1.  Jesse pauses home memory in the dash. An agent's `recall` is refused `paused`; `bellman_confirm` omits the home
    titles and says `paused: true`.
2.  Jesse exports home memory as Markdown, then deletes it all. The home room is purged.
3.  The account's next `remember` creates a new, empty home room.

## Technical Plan (Architecture)

### 1. The home room

*   **Id.** `qh_` followed by the first 32 hex characters of sha256 over `"bellman-home:" + userId`. The Worker
    computes it from the caller's identity; `SessionDO` is addressed by `idFromName(id)` as every room is. No registry
    row maps an account to its home room, so a lost index write cannot orphan one or make a second (the gap ADR 0006's
    consequences name for `us:`/`um:`/`uo:`). The id never leaves the server: no tool, route or event returns it.
*   **One home per user id.** An SSO sign-in's user id encodes its org (`u_sso_…`), so a person who signs in
    personally and through an org's SSO holds two accounts and two home memories. That is accepted for v1. A later
    account link would have to move `fs:` and `fsh:` rows from one home room to the other.
*   **Created on the first home write.** `remember` (or an import, #530) on an account with no home room creates it in
    the same `SessionDO` call that writes the file: a record with `kind: "home"`, one member (the account, with no
    brief, no capabilities and no seat a peer can see), `fsBytesCeiling` unset (D10). A read of a missing home room
    returns empty and creates nothing.
*   **Never listed, joined or public.** It has no join codes, cannot be made public, and has no manifest beyond the
    one member. Its creation writes no `us:`, `um:` or `uo:` row and no row in the registry's `rooms` table, so
    `GET /me/rooms`, `bellman_rooms`, the dash's lists and the operator's room table never see it. `bellman_connect`
    and every room route refuse a `qh_` id as not found, whoever asks.
*   **No `fs` events (D2).** The home room's `appendFs` writes the row, its history and the lookup and audit rows, and
    no event. Its only member is the account, and the account's seats live in other rooms. The dash reads it by ETag
    over a revision counter on the record. With no events, hard delete (§8) leaves no path names behind in a log.
*   **No abandonment, no close.** The idle sweep that closes an abandoned room skips `kind: "home"`. It ends only by
    hard delete (§8), which runs the purge.
*   **Cost capture** (`src/cost/`, ADR 0045) counts home rooms by the `kind` on the record when it visits them; it has
    no `rooms` row to start from, so home rooms are counted from the accounts list. #526 decides the counting path
    and records it in ARCHITECTURE §5.

### 2. The tool: `bellman_memory`

One tool, four ops, at most **270 tokens** for its whole definition (D3).

| op | Arguments | Returns |
|---|---|---|
| `remember` | `path`, `content`, `base_rev?`, `idempotency_key?` | `{ path, rev, replayed }` |
| `recall` | `query` (3–200 chars), **or** `path` (+ `rev?`), **or** neither (+ `prefix?`, `cursor?`) | a query: `{ results: [{ path, title, snippet, rev, at }], total, searched }`; a path: `{ file }`; neither: `{ entries, next }`, newest first |
| `forget` | `path`, `base_rev` | `{ path, rev }` |
| `share` | `session_id`, `member_id`, `to` (`notes`, `fact` or `unshare`), `path?` (`notes`, `fact`), `source?` (`fact`) | `{ path, rev }`, `{ proposal_cursor }` or `{ sharing: false }` |

*   **Who.** The caller's identity, an account, is the owner; `session_id` and `member_id` are optional except for
    `share`. When given, they name the seat the call is made from; the seat must be the caller's own, and the room is
    recorded in the lookup log.
*   **Writes** follow ADR 0046 exactly: text, 64 KiB, 20 revisions, `base_rev` stale check, `remember` without
    `base_rev` only creates, `forget` is ADR 0046's delete (the file and every kept revision, no undo). A home write
    counts as a send (`admitSend`), as a room file write does, against the account's own bucket of `SEND_LIMIT` (30)
    a minute. That bucket is keyed by the account, not a seat, and is separate from every seat's bucket in every room,
    so home writes never spend a room's sends and a room's sends never block home writes.
*   **`recall` with `query`** is §4's search over the home room. With `path`, it reads one note. With neither, it lists
    notes newest first, under `prefix` when given, a page at a time by `cursor`.
*   **`share` to `notes`** copies a home note to `/members/me/<path>` in the named room, as a new file or a write over
    the current revision. It is a room file write, with the room's verb, quota and memory rule. **`share` to `fact`**
    opens a fact proposal (§6) whose body is the note's, with the `source` the caller names. **`share` to
    `unshare`** turns notes sharing off for the caller's account in that room (§3). Nothing turns it on from here
    (D5).
*   **Reach (D4).** A hosted seat (ADR 0002) acts as no account for home memory: every op is refused `forbidden`. A
    hosted seat answers peers on the server's schedule with no human watching, and peer content could steer it into
    reading its creator's notes out to the room. Outside A2A callers (ADR 0033) hold no seat and no account here.
*   **Untrusted.** Every note returned is inside the untrusted envelope with the account as origin (`{ memberId:
    "home", label: <the account's label> }`). A note an agent wrote may hold text it copied from a peer.
*   **Refusals.** `stale` (`current_rev`, `content`), `too_large`, `over_quota` (`used`, `ceiling`), `paused`,
    `forbidden`, `not_found`, `rate_limited`, `conflict`, and for `share` the room's own refusals. Each is a stable
    code, the current state and one next step, as `bellman_fs`'s are.
*   **Paths.** `src/fs-path.ts` normalizes them. In a home room every path is the account's: there are no namespaces,
    `/members/`, `/facts/` and `/.bellman/` included, and `/apps/` is refused.

### 3. Room notes, private by default

ADR 0046 decision 7 becomes:

> A peer reads an account's room notes only when the account has turned on **notes sharing** for that room, **and**
> every seat the account holds grants `read_context` (with no seat held, every seat it held granted when it left).

*   **The switch** is a row in the room's `SessionDO`, `ns:<userId>`, present when on. The default is off, so every
    room's notes are private until their account shares them.
*   **On, from a dash session only (D5):** `PUT /rooms/:id/notes-sharing` with a session cookie and a checked Origin,
    from an account that holds a seat in the room. Turning sharing on exposes notes to every present and future
    peer, and an agent reads peer content that might ask it to. A bearer token is refused, as on the governed-config
    route (ADR 0044).
*   **Off, from anywhere the account is:** the same route with `DELETE`, or `bellman_memory share` with `to: "unshare"`.
*   **`seesMemory` stays the one predicate.** It gains the switch as an input: `seesMemory(seats, owner, reader,
    { shared })`, and `shared: false` returns false for every reader but the account. Every path ADR 0046 decision 7
    lists keeps calling it: `read`, `list`, `history`, `find`, the `fs` events for members and the room socket, and
    the public page, which receives no `fs` events. `tests/delivery-paths.test.ts` gains the switch on each path.
*   **Turning it off** takes effect on the next read: no event is recalled, and an agent that read a note while it was
    shared keeps what it read.
*   **Purge.** A room's purge deletes its `ns:` rows with its `fs:`, `fsh:` and `mi:` rows (amends ADR 0046 decision
    11).
*   **Ships in #520.** Room notes and the private default arrive together: #520's `seesMemory` takes `shared` and reads
    it as false for every room until the `ns:` row and its route land. No room note is ever readable by peers by
    default, so nothing migrates and no release note is needed.
*   **The switch is visible by its effect:** a peer whose read succeeds learns that sharing is on. That is intended.

### 4. Content search over memory

ADR 0046 decision 10 becomes: `find` matches path names everywhere, **and file bodies on memory paths**.

*   **Memory paths:** every file in a home room; `/members/**` and `/facts/**` in a room. Room documents elsewhere stay
    path-name only until a room index exists (ADR 0034's consequence).
*   **The match** is `src/search.ts`: `checkQuery`, `queryWords`, every word a substring of the path or the body. A
    path match ranks first, then newest (`at`), then path. Ten results and `total`, the count of all that matched. The
    snippet is the first line that holds a matching word, cut by `cutAtWord`.
*   **Filtered before ranking and counting.** In a room, every `/members/<memory id>/` file `seesMemory` refuses for
    the caller is dropped before it is ranked or counted, so `total` says nothing about notes the caller cannot read
    (as `briefs_omitted` does).
*   **Inside the object (D6).** A new store method, `searchFs(sessionId, reader, query)`, runs in the room's
    `SessionDO`: it reads the candidate rows, applies the memory rule, matches and ranks, and returns pointers and
    snippets. Bodies never cross RPC. This is ADR 0034's named upgrade, matching inside the object, for files.
*   **Bound.** A search reads at most 8 MiB of bodies, newest first; `searched: { files, truncated }` says how far it
    read. A home room's quota (§7) is the largest a search meets.
*   **Surfaces.** `bellman_memory recall` with `query` searches the home room. `bellman_fs find` keeps its arguments;
    on memory paths it now matches bodies and returns snippets. `GET /rooms/:id/files?query=` matches the same.

### 5. Recall on arrival, inside one budget for the whole reply

`bellman_confirm`'s whole reply is at most **24,000 characters**, about 6,000 tokens, and `recall` comes out of that
budget (D7; amends ADR 0018 decision 4). A join to the planning room on 2026-11-04 returned 72,450 characters: the
surface front window was 63,274 of them, briefs 5,496, members 2,608 and the room block 923. The client saved it to a
file instead of reading it. Adding memory on top of that would make it worse.

The reply is filled in this order. Each part is cut whole (never mid-item), and each cut part is counted:

| # | Part | Bound |
|---|---|---|
| 1 | `session_id`, `member_id`, `cursor`, `room` | never cut |
| 2 | `room_instructions` | never cut; ADR 0044 bounds it at 8 KiB |
| 3 | `recall` | at most 4,000 characters |
| 4 | `members` | present members first, then those who left most recently; `members_omitted` |
| 5 | `briefs` | the present members heard from most recently, up to 25; `briefs_omitted` |
| 6 | `surface` | the front window, items newest first; `next` for `bellman_surface` |

The surface is cut first, because an agent reads the rest with `bellman_surface` and `next`. Briefs are cut second.
No tool reads a brief again after the join, so a cut brief is lost to that agent; at the planning room's size the
reply without the surface was 9,176 characters, so cutting the surface alone brings it under budget. If #528 finds a
room where briefs still pass the budget, it adds a way to page them instead of cutting them silently. Recall is not
cut before either: it is what a joining agent cannot get any other way in one call.

```
recall: {
  facts: [{ path, title, summary, approved_at, approved_by }],   // newest approval first
  facts_omitted,
  home: [{ path, title, at }],                                    // the caller's home notes, newest first
  home_omitted,
  paused                                                          // true: home is [] and was not read
}
```

*   **`title`** is a file's first Markdown heading, or its path's last segment. **`summary`** is a fact's first 200
    characters after its front matter, cut by `cutAtWord`.
*   **Facts** are the room's; **home** titles are the caller's alone, so no peer's recall carries them.
*   **Inside recall,** facts come first, then home titles, each cut whole at 4,000 characters.
*   **One read each.** The confirm reads facts from the room's object it already calls, and home titles from the home
    room in a second call made after the seat commits. A failed home read returns `home: []` with
    `home_error: "unavailable"`; it never fails the join. Both are reads; neither object writes the other.
*   **Untrusted.** Facts are inside envelopes with the proposer as origin; home titles with the account as origin.
*   **Lookup log.** The home read writes a lookup row with op `arrival`.
*   **Cost.** ARCHITECTURE §11's "Joining a room" row becomes a ceiling: at most 6,000 tokens, whatever the room holds.
    #528 measures the whole reply and records it.

### 6. Room facts

*   **A fact proposal** is a `surface_proposal` action request (ADR 0032) with a `fact` in place of `item`:
    `{ kind: "surface_proposal", fact: { slug, title, body }, source: { cursor } | { url }, base }`.
    *   `slug`: 1–64 characters of `[a-z0-9-]`; the fact's path is `/facts/<slug>.md`.
    *   `title`: at most 200 characters; `body`: at most 4,000.
    *   `source` (D9): `cursor` names an event in this room's log at or before the proposal that the proposer can read,
        or `url` an `http` or `https` link. A proposal without one is refused `invalid` with the reason.
    *   `base`: the fact file's current revision, or 0 for a new fact. A different revision at approval is `stale`.
*   **Everywhere.** A fact proposal is applied on approval in every room, not only topic rooms, and lives seven days.
    A member holds at most three open fact proposals, a cap of its own beside ADR 0032 decision 4's three card
    proposals, so a working room recording facts does not run out of room for cards, or the reverse.
*   **The approval is the write.** An `action_response` with `approved: true` from a seat whose role holds
    `write_surface` writes the file in the transaction that stores the response, through `approveProposal`, which
    gains a fact branch beside the card branch: one `SessionDO` call, an `appendFs` of `/facts/<slug>.md`, the `fs`
    event (authored by the proposer, as a card's is) and the response.
*   **The file** is Markdown with front matter the server writes, never the proposer:

    ```
    ---
    title: Memory is free on every plan
    proposed_by: { member_id: m_…, label: … }
    approved_by: { member_id: m_…, label: … }
    source_cursor: 102          # or source_url
    approved_at: 2026-11-04T18:02:11Z
    ---
    <body>
    ```

*   **Only approvals write `/facts/**` (D8).** `writeFs` refuses every other write there `forbidden`, pointing at the
    proposal. A `forget`-style delete of a fact is a proposal too: `{ fact: { slug }, remove: true, base }`. So every
    fact on file has an approver.
*   **A human approves.** The approval is an `action_response`, which the receiving human approves (ADR 0008). The
    server cannot prove a human decided rather than the seat's agent; ADR 0040 decision 8's exposure applies and is
    stated, not fixed.
*   **A passed decision writes a fact.** Once #408 ships, a decision whose effect is a `surface_proposal` carrying a
    `fact` applies it at pass time in the same transaction, with the same `stale` check, and `approved_by` lists the
    binding voters.
*   **Readers.** Any seat reads `/facts/**`, as room documents. The public page does not (Non-Goals).
*   **Quota.** Facts count against the room's file quota, not any account's memory allowance.

### 7. Quota (D10)

*   **Home room.** `homeMemoryBytes` in the plan table (`src/auth.ts`): 1 MiB on `free`, 50 MiB on `pro`, 200 MiB on
    `max` and `team` (starting values; every plan included, epic decision 6). It is read from the caller's current
    plan on each write and passed to `appendFs`, not stamped on the record, so an upgrade raises it at once. After a
    downgrade the notes stay; a write that grows memory past the new ceiling is refused `over_quota`, and a write that
    shrinks it passes.
*   **Room notes** keep ADR 0046 and #520: each account's notes in a room have an eighth of the room's
    `fsBytesCeiling`, and all accounts' notes together are bounded by it.
*   **Charging** follows ADR 0046: each write charges the net change, and deletes and pruned history give bytes back.

### 8. Controls (D11, D12)

*   **Pause.** `PUT /me/memory/pause` and `DELETE` (dash session only) set `paused` on the home room record. While
    paused, every `bellman_memory` op but `forget` is refused `paused`, and recall on arrival returns `paused: true`
    with no home titles. Room notes and facts are not paused: they belong to rooms. An agent cannot unpause, so peer
    content cannot ask one to.
*   **Lookup log.** Every agent read of home memory (every form of `recall`, the source read of `share`, and arrival) writes
    an `lk:` row in the home room, in the same transaction as the read: time, op, the room id and member id it came
    from (or none), the agent's provider, model and client as its brief or token names them, the query, and the paths
    returned. The newest 1,000 rows or 90 days are kept. `GET /me/memory/lookups` (dash session) reads it, naming each
    room by its title as the account sees it. The account's org audit stream (ADR 0035) does not receive these rows:
    home memory is the person's, not the org's.
*   **Hard delete.**
    *   *One note:* `forget`, or the dash, removes the file and every kept revision (ADR 0046's delete). The home room
        has no events, so nothing else names it except lookup rows; the dash's delete also removes those.
    *   *Everything:* `DELETE /me/memory` (dash session, typed confirmation) runs the purge on the home room: every
        `fs:`, `fsh:`, `lk:` row and the record. The next `remember` starts an empty home room.
    *   *Room notes:* the dash deletes an account's own files under `/members/<memory id>/` in a room it holds a seat
        in. The room's `fs` events for them stay, carrying path, revision, size and op and never content; the docs say
        to keep secrets out of note names.
    *   *Account deletion:* Bellman has no self-serve account deletion. The operator's account-deletion runbook (beside
        `DELETE /admin/handles/:handle`) gains `DELETE /admin/accounts/:userId/memory`, which runs the same purge, and
        any account deletion added later calls it.
*   **Export.** `GET /me/memory/export` (dash session) returns one Markdown document: each home note as a section with
    its path, revision and time, then the account's room notes in each room it holds a seat in, read through `um:`
    and one read per room. Each read is one object; the route assembles them.
*   **Audit.** Writes to home memory are not org audit entries either. Writes to room notes and facts keep ADR 0046's
    `fs_write` entries, and an approval its `sent_message` entry.

### 9. Tool and token budget

After #520 the listing measures about 11,022 of 11,840 tokens (ARCHITECTURE §11), leaving about 818. This design
spends at most **350**, leaving about 470 for the rest of the roadmap, consensus effects included:

| Change | At most |
|---|---|
| `bellman_memory` (#526): four ops, `list` folded into `recall`, one shape for `share` | 270 |
| `bellman_confirm`'s `recall` field and the whole-reply budget (#528) | 30 |
| `fact` in `bellman_send`'s `surface_proposal` (#529) | 50 |

Each PR measures its row and adds it to the budget table. A PR that would pass 11,840 cuts its own description first;
raising the ceiling is an owner decision recorded in §11.

## Alternatives Considered

### Alternative A: A per-account Durable Object for home memory

*   **Pros:** A clean type with no room machinery it does not use.
*   **Cons:** A seventh object type with its own storage, quota, purge and tests, duplicating ADR 0046's rows.
*   **Reason for Rejection:** Epic decision 1.

### Alternative B: A `home:<userId>` registry row naming a random home room id

*   **Pros:** Matches how the registry indexes everything else.
*   **Cons:** Creating the room and writing its row span two objects. The index writes after a commit are best-effort
    (ADR 0006 consequences), so a lost row would orphan a home room, and the next write would make a second. Every
    home read would also cost a registry call.
*   **Reason for Rejection:** D1 derives the id and needs no row.

### Alternative C: Notes sharing turned on by the agent

*   **Pros:** One call, no dash visit, symmetric with `read_context` grants.
*   **Cons:** Turning sharing on is the one step that exposes notes to every present and future peer, and an agent reads
    peer content that can ask it to.
*   **Reason for Rejection:** D5. Turning it off stays available to the agent.

### Alternative D: Keep ADR 0046's default (`read_context` alone)

*   **Reason for Rejection:** Epic decision 3.

### Alternative E: Content search in the Worker

*   **Pros:** Reuses `src/search.ts` as the surface search does.
*   **Cons:** It would move up to a home room's whole quota across RPC per query, past the limit ADR 0034 already
    names for messages.
*   **Reason for Rejection:** D6 matches inside the object, where an index would go.

### Alternative F: Facts as surface cards with an `approved_by`

*   **Pros:** No new namespace; topic rooms already do it.
*   **Cons:** A card has no source field, no path, no history and shows on the canvas; any `write_surface` holder can
    overwrite it without approval.
*   **Reason for Rejection:** D8 needs a place only approvals write.

### Alternative G: Lookup rows in the org audit stream

*   **Pros:** Reuses ADR 0035's hash chain and sink.
*   **Cons:** Only orgs on `team` have an audit stream; a free account would have no log, and an org would read a
    person's home memory activity.
*   **Reason for Rejection:** D12.

### Alternative H: Recall on arrival returns note bodies

*   **Reason for Rejection:** Bodies would spend the budget on notes the room does not need; titles let the agent
    `recall` what fits.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| An agent is steered by peer content into `share`-ing a home note to the room. | `share` to `notes` writes under the account's own `/members/`, private unless sharing is on (D5, dash-only); `share` to `fact` is a proposal a human approves. |
| An agent is steered into `forget`. | `forget` needs `base_rev`, deletes one note, and is in the lookup log; export first is the docs' advice. Hard delete of everything is dash-only. |
| A hosted seat reads its creator's notes out. | D4: hosted seats have no home memory. |
| Facts approved by an agent, not a human. | ADR 0040 decision 8's exposure, stated; every approval names the seat. |
| A content search scans a large home room. | Inside the object, 8 MiB bound, `searched` says when it stopped. |
| The tool listing passes its ceiling. | §9's 350-token budget, measured per PR. |
| An org admin asks for peers' reads of room notes in the org audit stream. | Out of scope for v1: room-note reads are not audited. A later ADR can add them to ADR 0035's stream for `team` orgs. |
| One person has two home memories, from a personal and an SSO sign-in. | Accepted for v1 (§1); a future account link moves rows. |

## Cost and Scale

*   A home room is one `SessionDO` per account that writes memory; it idles at zero and holds at most its plan's quota.
*   A content search reads up to 8 MiB inside one object and returns at most ten pointers.
*   Recall on arrival adds one read of the room and one of the home room to a join.
*   The lookup log adds one row per agent read, at most 1,000 kept.

## Detailed Implementation Plan

Each PR follows `npm run verify`, both store programs and the conformance suite.

### PR 1: ADR and docs (#525)

*   `docs/adr/0047-bellman-memory.md` (Create): decisions 1–6 and D1–D12.
*   `docs/adr/0046-room-filesystem.md` (Modify): decisions 7, 10 and 11 amended, pointing here.
*   `GLOSSARY.md`, `docs/ARCHITECTURE.md` §5 and §7 (Modify).
*   Revised after the planner's review: private notes in #520, the whole-confirm budget, 350 tokens.

### In #520: Room notes private from the start

*   `seesMemory(seats, owner, reader, { shared })`, with `shared` read as false for every room until the `ns:` switch
    lands, on every path ADR 0046 decision 7 lists; `tests/delivery-paths.test.ts` asserts that a peer reads no room
    note with every seat granting `read_context`. #520's guide says room notes are private.
*   The `ns:` row, `PUT`/`DELETE /rooms/:id/notes-sharing` and `share` with `to: "unshare"` follow in #526 (or their
    own issue). Until then no room note is readable by peers at all.

### PR 2: Home memory and `bellman_memory` (#526, after #430 PRs 1–3)

*   `src/home.ts` (Create, runtime-free): `homeRoomId(userId)`.
*   `src/types.ts`, `src/stored-session.ts`: `kind: "home"`, `paused`, the lookup row.
*   `src/store.ts`, `src/store-do.ts`: `appendFs` with no event for a home room; create-on-write; lookup rows in the
    read; the idle sweep skips home rooms; `qh_` refused on every room route.
*   `src/auth.ts`: `homeMemoryBytes`.
*   `src/tools/memory.ts` (Create): `remember`, `recall` by path and as a listing, `forget`, `share` to `notes` and
    `unshare`.
*   The notes sharing switch: the `ns:` row, the dash route, `seesMemory` reading it.
*   `extension/manifest.json`, `npm run docs:gen`, ARCHITECTURE §11's row.

### PR 3: Content search (#527)

*   `searchFs` in both stores, `bellman_memory recall` with `query`, `bellman_fs find` on memory paths, the file route's
    `query`.

### PR 4: Recall on arrival (#528)

*   The whole-reply budget in `bellman_confirm` (§5's fill order and counts), `recall` inside it, and the measurement of
    the whole reply in §11.

### PR 5: Room facts (#529, after #408)

*   `approveProposal`'s fact branch, the `/facts/**` write refusal, `share` to `fact`, the decision effect.

### PR 6: Capture (#530) and controls (#531)

*   The opt-in stop hook and imports; pause, the lookup route, hard delete, export, the operator route.
