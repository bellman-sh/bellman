# ADR 0030 — The server places an item written without a placement

**Date:** 2026-10-23 · **Status:** accepted · **Amends:** ADR 0015, decision 1 · **Spec:** `docs/superpowers/specs/2026-10-22-surface-placement-design.md` · **Plan:** `docs/superpowers/plans/2026-10-22-surface-placement.md`

## Context

Agents lay out a room's surface so a person can read it: cards in columns by topic, nothing
overlapping, relations drawn as connectors, groups marked by shapes, structures drawn as
diagrams. And every item a viewer sees is placed, so the next agent can place against it.

That second part did not hold. An item written with no `placement` was stored with none, and
each viewer worked a position out for it alone: the MCP App and the dash both draw it in the
next slot of a four-column grid, counting the rows that have none in key order, and neither
wrote that slot back. An agent that read the surface saw `placement: null` and could not tell
where the item was drawn, so it could not keep clear of it.

The change has three requirements. The canvas skill gives a layout method with numbers, three
rules for connectors, shapes and diagrams, and a checklist before each write. An item written
with no placement is placed by the server, in the next free slot of the grid viewers already
use, and stored, so every viewer sees one layout. Both stores agree, through the contract.

## Decision

Each entry names the spec's decision (D) or the plan's ruling (R) it records.

1. **The rule is pure and runs inside each store's append (R1, R2).** `withPlacement` in
   `src/surface.ts` takes the room's rows and a write and returns the write as the room
   stores it. `placedAppend` in `SessionDO` lists the `sf:` rows once, in the append's own
   transaction, for a write that needs a slot; `MemoryStore.placed` reads its map. Placing in
   `writeSurface` was rejected: it reads its rows before the append and outside its
   transaction, so two writers read the same rows and take one slot, and the slot would sit in
   the draft the idempotency fingerprint is taken from.
2. **The slot (D3).** The lowest slot of the viewers' grid (`GRID` and `gridSlot`: four
   columns of cells 320 by 200, 40 apart, left to right and then down) whose cell no row's
   box covers. A box covers every cell it overlaps, however many, and a cell it only touches
   at an edge is free. The kinds placed are `text`, `link`, `diagram`, `file`, `image` and
   `html`. A connector takes none, and a shape is refused without a placement, as before.
3. **A placement given is stored as given; a replace that omits one keeps the stored one
   (R5, R6).** Keeping clear of a box that is there is the skill's rule, and the server places
   only what it was not told. A write that replaces an item and leaves out `placement` takes
   the stored one rather than a new slot, even when a lower slot has freed since. That amends
   ADR 0015's decision 1, "Writing a key replaces its item": a replace takes every field from
   the write except a placement it leaves out, which stays. A stored `null` is not kept: that
   write is placed. On the wire `null` is absence, so nothing can clear a placement
   afterwards.
4. **The event carries the row's placement, and a retry is judged by the caller's draft
   (R3).** The store appends the draft with its payload set to the placed item, so the log and
   the row agree and a viewer's replay lays the item out where the row is. The idempotency
   fingerprint is taken from the draft as the caller sent it, and `appendEventOnce` returns the
   original event before any search, so a retry of an unplaced write replays the first event
   with its placement, takes no second slot and reports no conflict, however the room has
   filled since.
5. **A row with no placement covers the cell the viewers draw it in (R4, D4).** The MCP App
   and the dash draw a row with none at the next slot, counting only the rows with none, in key
   order, and ignoring every placed box. A search that read stored boxes alone, as the spec's
   text has it, would put the first new card on the first old card in every room that predates
   this. `coveredBoxes` gives each of those rows one full cell, so k of them cover slots 0 to
   k - 1 whatever order a viewer draws them in, and it sorts nothing. It leaves out the key
   being written, because that row leaves the unplaced rows and the others close up behind
   it. Old rows keep the viewers' grid; the server keeps clear of it.
6. **The search ends at `MAX_SLOT_SEARCH` slots, 256 (R7).** That is a row of four slots for
   each of the surface's 64 items. The spec's 64 cells past the last holds only while each box
   covers one cell, and a placement's `w` and `h` have no upper bound: a box of 1e300 covers
   every slot there is, and a search with no end would hang the room's object inside its
   transaction. Past the bound the item is stored unplaced, as it was before, and the write
   succeeds.
7. **The grid lives in three places (R8):** `src/surface.ts`, `ui/src/canvas-layout.ts` and
   dash's `src/lib/canvas.ts`. `tests/working-surface.test.ts` imports the MCP App's `GRID` and
   `gridSlot` and fails when they differ from the server's. Dash's cannot be tested from here;
   a comment in each of this repo's two names the other copies.
8. **The skill carries the method (D1, D2); the tool text is unchanged (R9, R14).** The canvas
   skill teaches the grid, three rules for what to draw and a checklist. `bellman_send`'s
   `surface` kind gains nothing, and its result does not name the slot: a writer reads the
   placement with `bellman_sync` and `surface: true`, which the skill says to do before
   placing. `extension/manifest.json`, the generated reference pages and ARCHITECTURE
   section 11's measurements stay as they are.

## Consequences

- Every new item except a connector is stored with a placement, so a person and the next agent
  read one layout. The exception is a surface whose first 256 slots are all covered, where the
  item is stored unplaced (R7). A row from before this keeps `placement: null` until it is
  written again or dragged.
- A replace that omits `placement` used to send the item back to the viewers' grid; it now
  stays put (R6). That holds for a placed item too.
- A write that needs a slot costs one list of the room's `sf:` rows; a write that carries its
  placement costs none, so the dash's drag writes cost what they did.
- If a viewer's card size or column count changes, `GRID` changes in three places.
- Nothing stored changed shape, so a rollback is a revert; items already placed keep their
  placement.
- The skill reaches Claude Code at the next release. This change neither moves the plugin's
  version nor rebuilds its bundles.
