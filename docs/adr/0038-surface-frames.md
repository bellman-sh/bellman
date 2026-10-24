# ADR 0038: Surface frames, and a surface of 1,000 items

**Date:** 2026-10-23 · **Status:** accepted · **Spec:** `docs/superpowers/specs/2026-10-23-surface-frames-design.md` · **Plan:** `docs/superpowers/plans/2026-10-23-surface-frames.md`

## Context

A surface held 64 items so one read fit one tool response. Topic rooms and the blog accumulate cards for months; 64 was too few, and 1,000 read at once is too much for an agent, a poll or a page.

## Decision

1. **A surface holds 1,000 items** (D1), a courtesy bound read before the append, as ADR 0015 made the 64.
2. **A frame is a surface kind** (D2): a titled rectangle, locked unless written otherwise. A card belongs to the frame holding its centre; frames never overlap, refused inside the write's transaction by `appendSurface`, the store operation every surface write goes through; at most 100.
3. **The path is creation order** (D3): a frame's number is its rank by `createdAt`, computed on every read and never stored.
4. **Every read is a window** (D5): `frame:<n>`, `unframed`, `newest`, and over HTTP `region` and `key`, at most 64 items, with `frames[]` and a keyset `next`. No argument reads the room's front: frame 1, or newest. Each `frames[]` entry crosses in the untrusted envelope of the member who wrote the frame, as an item does, since a title is a peer's prose.
5. **Windows are computed inside the room's object.** `BellmanStore.surfaceWindow` cuts, ranks and pages the rows in the Durable Object that holds them, and a read crosses RPC with one page and the frames, never the thousand rows. `src/frames.ts` holds the ranking, membership and paging, runtime-free, and both stores call it.
6. **A locked move is one write that changes many rows** (D2): one `surface` event per row, at consecutive cursors, in one transaction. A carried card keeps its writer, its `createdAt` and its approver; only its placement changes. The event for each carried card is authored by the member who moved the frame and carries the full item, so `restore` reads it as it reads any other version.
7. **One item is read by its key.** The item page and the Worker's item head read the `key:<key>` window, so an item older than the newest 64 still has its page.

## Consequences

- A client that reads only `surface.items` sees the front window. In a room with no frames and 64 items or fewer that is every item, as before.
- Until the dash read windows (Part 2), the HTTP surface reads asked for neither `window` nor `next` answered every row the reader may see as `window: "all"`, so the dash kept the whole canvas across the deploy. Once the dash sent a window on every read, that path was removed: those reads answer the front window, under the plain cursor ETag.
- A locked frame's move writes one `surface` event for each card it carries, authored by the mover, into every member's log. Moving a frame that holds 900 cards adds 901 events to every member's `bellman_sync`, and each member's poll pages through them at the usual 50. The cards' rows keep their writers and approvers, so the topic room page and the blog still credit who wrote and who approved each card.
- Windows are computed over every row in the room's object on each read, so the cost of a read grows with the surface's size in that object and not across RPC. A store method that keeps the ranking in an index is the upgrade, if a room ever makes the scan slow.
- The sitemap lists each room's newest 64 items until the sitemap pages, so a blog past 64 posts loses its older posts from the sitemap, though each post's own page still loads.
- A rollback is a revert while no room holds a frame or more than 64 items; after that, the rows are readable by the old code but a frame reads as an unknown kind.
