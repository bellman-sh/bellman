# ADR 0033 — Room search

**Date:** 2026-10-23 · **Status:** accepted · **Spec:** `docs/superpowers/specs/2026-10-23-room-search-design.md` · **Plan:** `docs/superpowers/plans/2026-10-23-room-search.md`

## Context

A topic room or a long-lived hub becomes a knowledge base of sixty cards and thousands of messages. An agent asked "what did we decide about X" had to read the whole surface, and a reader of a public page had to scroll it. Nothing let either ask the room a question and cite the answer.

## Decision

1. **A search is one room's read** (spec D1). It names a room and a query, reads that room's rows or log, writes nothing, and is answered by the reads a caller already has: `bellman_surface` with `query` and `in`, and `?query=` on `GET /rooms/:id/surface|events` and `GET /public/rooms/:id/surface|events`. No tool, store method or limit is added (D4, D8).
2. **Keyword matching, ranked, in one module** (D5). `src/search.ts` lower-cases, splits on whitespace and trims punctuation at a word's edges; every word must appear, as a substring, in a card's title, body or key (a connector's title; a file's or image's title and name) or a message's text. A title match ranks first; then newest; then key. Ten results and the count of all. The tool and the four reads call it through `src/rooms.ts`, so nothing ranks twice.
3. **Results are pointers in the surface read's envelope** (D6, D7): a card's key, kind, title, snippet, `created_at`, approver and page URL in a public room; a message's cursor, snippet and time; the author or sender as the envelope's origin, named as each read names members.
4. **Who may search is who may read** (D3). A member searches through the member reads to its cut; the public through the public reads, named by number; a caller with no seat gets what it gets today.
5. **Bounds** (D8): a member's message search reads the last 2,000 events through `recentEvents`, or through `eventsAfter` the 2,000 up to its cut when the creator removed it; the public's the newest 200, what one public events read serves. `searched: { events, from_cursor }` says how far back a message search read.
6. **A card search's ETag carries its query and the room's link**, so a stored poll's ETag never answers a search, nor a search's another. A message search has no ETag, as the events read has none.

## Consequences

- A match older than the bound is not found, and `searched` says so; past the bound a room gets an index in its object (D8), and semantic ranking is the named upgrade (D9).
- The 2,000 events a member's message search reads cross RPC from the room's object; at 20,000 characters each that can pass the RPC message limit. Matching inside the object is the upgrade, and it is where an index would go.
- A message's text is `payload.text`; a message sent with another shape is not found.
- `bellman_surface` keeps its MCP Apps `_meta`; a search answer has no `surface` key, so the App draws no canvas for it.
- A rollback is a revert: a client that never sends `query` sees nothing change.
