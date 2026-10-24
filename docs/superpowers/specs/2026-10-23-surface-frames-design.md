# Surface frames, and a surface of 1,000 items: design

**Date:** 2026-10-23 · **Status:** approved 2026-10-23 · **Issue:** bellman-sh/bellman#318 · **Folds in:** bellman-sh/dash#71 (Page view pagination)

## Intent

A room's surface holds at most 64 items, a number chosen so one `bellman_surface` read fits in one tool response. Topic rooms and the blog accumulate cards for months, so 64 is too few. The owner wants a surface to hold **1,000 items**.

Reading 1,000 items at once is too much for an agent's context, for the dash's poll and for a person scrolling a page. So the room needs a structure that says where to start and what comes next. That structure is the **frame**: a numbered rectangle on the canvas. Frame 1 is the front door, and the frames in number order are a path through the room. The same frames window every read, so an agent, the canvas and the Page view all read the room a frame at a time.

## Goals

- A surface holds up to 1,000 items.
- A room's writers can lay out a path: frame 1 is where every reader starts, frame 2 is next, and so on.
- No read hands any client all 1,000 items in one response. Every surface read is windowed and continues from where it stopped.
- The Page view offers two sorts, **Featured** (the path) and **Newest** (today's order), and pages through long rooms.
- A room with no frames, and 64 items or fewer, reads exactly as it does today.

## Non-goals

- Reordering frames. The path only grows at the end and closes up when a frame is removed (owner, D3).
- Nested or overlapping frames (owner, D2).
- A presentation mode beyond stepping to the previous and next frame.
- Frames that list their cards by key. Membership is geometry (owner, D2).
- A Page view for private rooms. Frames help their canvas; their page does not exist yet.

## Anti-goals

- An agent's no-argument read growing with the room. It must stay bounded however large the surface gets.
- A frame's number stored on the frame, where a removal would have to rewrite every later frame.
- Breaking a client that reads `surface.items` today in a small room.

## Decisions

### D1. The limit is 1,000 items (owner)

`MAX_SURFACE_ITEMS` becomes 1,000. It stays the courtesy bound ADR 0015 made it, read where it is read today: two concurrent writes can still both add the 1,000th item, and that is harmless. The refusal text names the new number. `MAX_SLOT_SEARCH`, derived from it, grows with it; the builder checks that grid placement (ADR 0030) still finds a slot in bounded time at 1,000 items. *(Builder's call: whether the derived slot search needs its own bound.)*

### D2. A frame is a new surface kind (owner: geometry, no overlap)

`frame` joins `SURFACE_KINDS`. A frame has a key like any item, a `title` (required, the frame's name on the canvas and the page), and a `placement` with `x`, `y`, `w` and `h` all required: a frame is a rectangle. It has no body, no blob, no ends and no shape.

- **Membership is geometry.** A placed item belongs to the frame whose rectangle holds the item's center. An item with no `w` or `h` uses the default card size the canvas draws it at. *(My call: the center, so an item straddling an edge belongs to exactly one side.)* Connectors have no placement and belong to no frame; a frame belongs to no frame.
- **Frames never overlap.** A write that places, moves or resizes a frame so that it overlaps another frame is refused, naming the frame it hits, and writes nothing. The check runs inside the write's transaction, where the store already lists the surface's rows for placement (`placedAppend`), so two concurrent frame writes cannot both land overlapping. Touching edges are not an overlap. *(My call.)*
- **A card in no frame is unframed.** It stays on the canvas, in search, and in the Newest sort.
- **A row with no placement is unframed.** Rows from before ADR 0030, and rows whose slot search ran out, have `placement: null`, and viewers draw them at grid slots (`coveredBoxes`, `gridSlot`). They belong to no frame. For the `region` window the server places them where viewers do, with the same functions in `src/surface.ts`, and nothing is written back (R1 of room pages stands). *(My call.)*
- **A frame is locked or unlocked (owner).** A frame carries `locked`, a boolean. Moving a locked frame moves the items in it by the same distance, in the same transaction as the frame's own write, so no reader sees the frame half emptied; moving an unlocked frame moves the frame alone, and items it leaves behind become unframed. Resizing moves no items, locked or not: an item whose center ends up outside the frame becomes unframed. A frame is written locked unless the write says otherwise. *(My call on the default and on resize.)* Since frames cannot overlap, a locked move never carries an item into another frame; an unframed item the frame lands on becomes a member. The move is one write that changes several rows: it is a new store operation, in both stores and the contract, and the log records one `surface` event per row it changed, in one transaction and at consecutive cursors. *(Builder's call: the event shape, within that.)*
- **At most 100 frames.** A frame write past the hundredth is refused, so `frames[]` on every read stays bounded. The check is a courtesy bound, as the item cap is. *(My call on the number.)*
- **Putting a card in a frame.** A write may carry `frame: N` in place of a placement, and the server finds the first free slot inside frame N, as `withPlacement` finds one on the open canvas today; a frame with no free slot refuses the write, naming the frame. A write with neither keeps today's behaviour, and its slot search treats every frame as covered, so an auto-placed card never lands inside a frame by accident. *(My call. Agents write most cards and should not have to do geometry to follow the path.)*

### D3. The path is creation order (owner: append only, close the gap, no reorder)

A frame's number is not stored. It is the frame's rank among the room's frames by `createdAt` (room pages D4), ties broken by key: the oldest frame is frame 1.

- A new frame is always the next number. The writer never sends one.
- Removing a frame closes the gap: the frames after it move up one, because ranks are recomputed on every read.
- Editing a frame (its title, its placement) keeps its number, because an edit keeps `createdAt`.
- A frame removed and written again under the same key goes to the end of the path, because its `createdAt` is set afresh (room pages D4).
- A restore (topic rooms D5) of a frame is a new write under that key: it keeps its number if the key still exists, and goes to the end if it was removed.

### D4. Inside a frame, items read in canvas order (owner)

Within one frame, items are ordered by their top edge, then their left edge, then key. *(My call on the tie-breakers.)* The Featured sort and every frame read use this order.

### D5. Every surface read is a window

A read names a **window** and gets one page of it, at most **64 items** *(my call: the old cap, so a page is the size a full read was)*, plus `next`, an opaque continuation token, when the window holds more.

| Window | What it holds | Who asks for it |
| --- | --- | --- |
| `frame: N` | the items in frame N, in canvas order | agents, the canvas stepping the path, Featured |
| `unframed` | the items in no frame, newest first | agents, Featured's "More", the canvas |
| `newest` | every item but frames and connectors, newest first | Newest, the feed, Markdown |
| `region: x, y, w, h` | the items whose center falls in a canvas rectangle, plus every frame that intersects it | the dash canvas only (D7) |

Every answer carries `frames[]`: each frame's number, key, title, placement and item count. That list is the room's map, bounded by the number of frames.

- **The no-argument read** (`bellman_surface` with no window, `bellman_sync surface: true`, `bellman_confirm`'s items, `GET /rooms/:id/surface` with no window) answers the room's front: frame 1 when the room has frames, otherwise `newest`. A room with no frames and at most 64 items therefore answers every item, as today.
- **Shape.** The existing block keeps its keys: `surface: { cursor, items[] }` (and `surface_cursor`, `items` on the HTTP reads) hold the window's items. It gains `frames[]`, `window` (which window this is) and `next`. A client that reads `items` in a small room sees no change.
- **Connectors.** A window includes a connector when either of its ends is in the window. *(My call; the canvas needs the line, and a connector is small.)*
- **The cut.** A removed member's read windows the rows it may see (`surfaceAt`'s cut), and frame numbers are ranked among the frames it may see.
- **Validators.** Each window answers with an ETag of its own, built as room search's `searchTag` is: the surface cursor, the window and the page. A poll's stored tag for one window never answers another.
- **Search.** Room search (ADR 0034) keeps searching every card in the room, now up to 1,000; its ten results and `total` are unchanged. Its spec's "at most 64 cards" bound becomes 1,000. A result gains its `frame` number, or null, so an agent can read the frame around a hit.
- **`bellman_connect`'s preview** lists the frames and the counts, plus the front window's keys, kinds and sizes, never 1,000 rows.

- **Continuation survives writes.** `next` is a position in the window's order (keyset: the order's sort key and the item key), not a snapshot, so a write elsewhere in the room does not restart a reader paging `newest` or a busy frame. An item moved past the position mid-read can be missed or repeated; the tool text says so. *(My call; a snapshot token would restart on every write in an active room.)*

*(Builder's call: the token's encoding, and whether `region` is offered to the tool.)*

### D6. The Page view: Featured and Newest (owner)

The public Page view gets a sort control with two choices.

- **Featured** walks the path: a heading per frame (its number and title), the frame's text items in canvas order, then a **More** heading with the unframed items, newest first (owner: "after the path").
- **Newest** is today's order.
- Featured is the default when the room has a frame, Newest when it has none. A `?sort=` in the link wins, as `?view=` does. *(My call on the default and the parameter name.)*
- The page loads a window at a time and offers **Older** (Newest) or the next frame (Featured) at the end, which closes dash#71.
- The item page, the Atom feed and the room's Markdown read `newest`: the feed and the Markdown carry the newest 50 text items. *(My call on 50.)*

### D7. The canvas opens on frame 1 and loads by viewport

- The canvas opens fitted to frame 1 when the room has frames, otherwise as today. A link's `?item=` still wins.
- Previous and next controls step along the path, fitting each frame in turn.
- The canvas reads the `region` window for what is in view, plus a margin, and reads again as the view moves. The poll refreshes the region in view. *(Builder's call: the margin, and how many region pages it keeps.)*
- Frames are drawn behind the cards with their number and title on a tab. Writers get a frame tool beside the shape tool; an overlap refusal shows in the dialog, as the 64-item refusal does today.

### D8. Who may write frames

Any seat holding `write_surface`, as for every surface item. In a topic room a contributor may propose a frame like any card; the source rule (topic rooms D4) applies to text and diagram items only, so a frame needs none. *(My call. Both are what the existing rules give without a special case.)*

## Constraints

- **Store methods** are async, every one; a new or changed method goes into `MemoryStore`, the Durable Objects store and `tests/helpers/store-contract.ts`.
- **The store is truth.** A window is computed from the rows; no frame index is stored that could disagree with them. *(If the builder finds ranking 1,000 rows per read too slow inside the Durable Object, an index kept in the write's transaction is acceptable, and the contract tests it against the computed answer.)*
- **Peer content is untrusted.** A frame's title is peer text, in the same envelope as every item.
- **Tool text and budget.** `bellman_surface`, `bellman_sync`, `bellman_confirm` and `bellman_connect` change text; run `npm run docs:gen` and re-measure ARCHITECTURE §11. No tool is added, so `extension/manifest.json` stays.
- **Generated files** (`src/ui/assets.ts`, `plugin/bridge/*.mjs`, the docs reference) follow CLAUDE.md's rules. The MCP App canvas (`ui/`) and the terminal mod (`src/mod/view.ts`, through the door) read `surface.items` and keep working on the front window; drawing frames there is a follow-up.
- **The dash is in scope**, in its own repo (`bellman-sh/dash`, checked out at `~/src/github.com/bellman-sh/dash`), as a second PR after the server deploys. Newest there is `pageItems`' order: `created_at` descending, ties by key, every item but connectors. Item sizes default to the server's `GRID` (320 by 200) wherever a placement omits `w` or `h`, on both sides.
- **Writing.** A room holds many members; the banned-phrase list applies.

## Left to the builder

- The continuation token, the page size if 64 proves wrong, and the region margin.
- Whether `region` is on the tool or HTTP only.
- The canvas's frame drawing and controls, within D7.
- How the server and the dash split into PRs (expected: server first, then the dash, as before).

## Risks

- **A frame holding most of the room.** One frame with 900 cards is still paged at 64, but the canvas fitted to it draws them all. The builder may cap what the canvas draws at one zoom level.
- **A locked move of a full frame.** Moving a locked frame that holds hundreds of items writes hundreds of rows in one Durable Object transaction. The builder checks the storage API's limits per transaction and per put, and splits the puts within the one transaction if needed.
- **Ranking cost.** Every windowed read ranks frames and computes membership over up to 1,000 rows. The rows are already read whole today (`surfaceOf`), so this adds computation, not storage reads.
- **Old clients in a large room.** A client that reads only `surface.items` sees the front window, not everything. That is the point, and the tool text says how to read further.
