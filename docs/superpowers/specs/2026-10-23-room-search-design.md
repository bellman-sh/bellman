# Room search: design

**Date:** 2026-10-23 · **Status:** approved 2026-10-23

Builds on `2026-10-22-topic-rooms-design.md` (which ships first, so the first corpus is curated cards and `approved_by` is on every card read; until its PR merges the spec lives on the `mcfearsome/topic-rooms` branch), `2026-10-18-room-pages-design.md` (an item's URL, `created_at` on every read) and `2026-10-17-public-rooms-on-bellman-sh-design.md` (the public reads, members named by number).

## Goal

A room that has become a knowledge base can be searched by whoever may read it: an agent through `bellman_surface`, a person through a search box on the room's page and in the dash. A search is bound to one room and returns pointers to that room's own records, so an agent's answer cites them.

Success means:

- A room with sixty cards answers "what did we decide about X" in one `bellman_surface` call, with the card's key, title, snippet, date and URL.
- A reader on a public room's page finds a card by a word in its title or body without scrolling the canvas.
- Nobody sees a result they could not read by other means.

## Decisions

- **D1. A search is one room's read.** The caller names a room and a query; the answer comes from that room's rows and log alone. There is no cross-room index, no shared store, and nothing is written.
- **D2. Cards by default, messages when asked.** `query` searches the surface's cards: title, body and key. `in: "messages"` searches the log instead. Cards are the knowledge; the log is the working behind them.
- **D3. Who may search is who may read.** A public room answers anyone, through its public reads, with members named as those reads name them. A private room answers its members. Messages are what the room's log already shows the caller: a member's events read, or the public's. There is no reader gate on messages beyond the seat today, and a search adds none. `bellman_surface` keeps answering a caller with no seat as it does today, as if the room did not exist; the seatless way to search a public room is its HTTP read.
- **D4. No new tool.** `bellman_surface` gains `query` and `in`. `GET /rooms/:id/surface` and `GET /public/rooms/:id/surface` take `query` for cards; `GET /rooms/:id/events` and `GET /public/rooms/:id/events` take `query` for messages. The dash's boxes call the reads it already makes.
- **D5. Keyword matching, ranked.** Case-insensitive; every word of the query must appear. A card matches in its title, body or key; a message in its text. A title match ranks above a body or key match; within a rank, newest first (`created_at` for cards, cursor for messages). At most ten results, with the count of all that matched. A query is three to two hundred characters.
- **D6. Results are pointers.** A card: `key`, `kind`, `title`, `snippet`, `created_at`, its author and its `approved_by` as the read names them (null when nobody approved it), and `url` for a public room (`https://bellman.sh/r/<room>/<key>`), null otherwise. A message: `cursor`, its sender as the read names them, `snippet`, `at`. The agent reads the card or the thread with the tools it has.
- **D7. Snippets are text.** The line that holds the first matching word, cut to about two hundred characters at a word. Peer content stays untrusted: the tool returns it inside the envelope the surface read already uses, and the page renders it as text.
- **D8. Bounded cost, no new limit.** A surface holds at most 64 cards. A member's message search scans the last two thousand events of the log; the public's scans the 200 a public reader already gets in one events read, since public reads have no limiter by design and a free-text query defeats any cache. Past those bounds a room gets an index. A search is a read like the reads it extends and adds no limit of its own.
- **D9. Semantic ranking is the named upgrade, not the first version.** Embeddings per room, fed at append and queried in the same bound, when keyword search starts missing things.

## 1. The tool and the reads

- **`bellman_surface`** takes `query?: string` and `in?: "cards" | "messages"` (`cards` when `query` is given without it). With a `query` it answers `{ query, in, total, results }`, plus `searched: { events, from_cursor }` for messages so a `total` of zero says how far it looked, and no `surface` key, so the MCP App, which draws a canvas when it sees one, shows nothing for a search; without a `query` it answers as today. `in` without `query` is refused, naming `query`. A query outside its length is refused, naming the bound. The tool's description gains one sentence; ARCHITECTURE's section 11 is re-measured.
- **The HTTP reads** take `query` as a query parameter and answer `results` (and `searched` for messages) in place of `items` or `events`: the surface reads for cards, the events reads for messages; `after` and `query` together are refused. The validator the surface reads answer 304 from gains the query, so a poll's stored ETag never answers a search. A bad query is 400 with the field named. The public reads name members as they do today, and the public events read serves only what it serves today.
- **The seat decides,** as it does for every read: a member searches through the member reads, the public through the public reads, a removed member and a stranger get what those reads give them today.

## 2. Matching and ranking

- **Normalising:** lower-cased; the query split on whitespace; punctuation at a word's edges dropped; no stemming.
- **Matching:** every query word appears somewhere in the record's searched fields (a card's title, body and key; a message's text). A connector matches on its title alone; a `file` or `image` on its title and name; nothing is read inside a blob.
- **Ranking:** rank 1 when every word appears in the title, rank 2 otherwise; within a rank, newest first; ties by key, or by cursor.
- **Which events are messages:** events of type `message` from members and the hosted seat. `system`, `action_request`, `action_response` and `surface` events are not searched.
- **The snippet:** the first line of the body or text that holds the first query word, trimmed, cut to two hundred characters at a word with an ellipsis; the title when the match is in the title alone.

## 3. The dash

- **The public page** gains a search box above its cards, on the canvas and the Page view alike. A query lists the matching cards as the Page view lists items, each under its title with its snippet, linking to the item's URL; an empty result says so. The Log tab gains the same box for messages.
- **The dash's room view** (members) gains the two boxes, calling the panel's reads, with the same rendering.
- **Names** are the reads' names: `@handle`, `member N`, `host` on the public page; sign-in labels for members, as today.

## 4. Tests, docs and rollout

- **Pure:** the matcher and the ranker in a runtime-free module beside `src/surface.ts`, with the cases of section 2: each word required, title over body, newest first, the snippet's cut, a connector by title, a blob by name, the bounds.
- **Tools and routes:** `bellman_surface` with and without `query`; `in` without `query`; a caller with no seat answered as today; the four reads, `after` with `query` refused, a stored ETag not answering a search; the public events read naming members by number in `results` and bounded at 200; `searched` on a message search; nothing written.
- **The dash:** the boxes, the list, the empty state, the links.
- **Docs:** `bellman_surface`'s generated page, the surface guide, the public rooms guide, the canvas skill ("read first" can say "search first" for a full surface), `ARCHITECTURE`, and an ADR numbered at merge.
- **Rollout:** one server PR on main after topic rooms' server PR merges, so `approved_by` is there to carry; one dash PR after room pages' dash PR and topic rooms' dash PR, which give the page its Page view and the approver's name.

## Out of scope

- Search across rooms, and an index of public rooms.
- Semantic ranking or embeddings (D9).
- Reading inside files and images.
- Highlighting matches in a card's rendered body, saved searches, and search in the MCP App.

## Risks

- **A busy public room's log.** The public's bound is 200 events per query, what one public events read already costs, and a member's two thousand; neither is cached, and neither needs to be at today's sizes. A room that outgrows the bound gets an index in its object.
- **Keyword search misses meaning.** A card about "retries" does not answer "idempotency". The topic rooms' cards are written and titled by people who know the subject, which narrows the gap until D9.
- **Two readers, two shapes.** The tool and the HTTP reads must rank and cut identically, which the shared pure module gives them; the dash renders what it is handed and ranks nothing itself.
