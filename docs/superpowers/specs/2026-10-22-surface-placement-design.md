# Surface placement: design

**Date:** 2026-10-22 · **Status:** for review

Amends `2026-10-06-working-surface-design.md` (placement is optional) and `2026-10-08-mcp-apps-canvas-design.md` (D5, D6: the per-viewer grid for unplaced items). The skill it changes is `plugin/skills/canvas/SKILL.md`.

## Goal

Agents lay out a room's surface so a person can read it: cards in columns by topic, nothing overlapping, relations drawn as connectors, groups marked by shapes, structures drawn as diagrams. And every item a viewer sees is placed, so the next agent can place against it.

Success means:

- The canvas skill gives a layout method with numbers, three rules for connectors, shapes and diagrams, and a checklist before each write.
- An item written with no placement is placed by the server, in the next free slot of the grid viewers already use, and stored, so every viewer sees one layout.
- Both stores agree, through the contract.

## Decisions

- **D1. The skill teaches a method, not a preference.** Card width 320, height about 200 unless `h` is set, gap 40: columns at `x = 0, 360, 720, …`, rows at `y = 0, 240, 480, …`. Read the surface first; a new card takes the next free slot of its topic's column; a new topic starts the next column; nothing is written over an existing box; a diagram card takes `w: 720`.
- **D2. Three rules for what to draw.** Connect what relates (a connector with a one-word `title`, both ends first; a plan's steps in order; a decision to the item it changed). Group what belongs together (a `rect` shape behind a column, titled and coloured; a `line` or `arrow` where a connector has no second item). Draw, don't connect, past about six relations (one `diagram` item, connected to the cards it explains).
- **D3. The server places what arrives unplaced.** A `text`, `link`, `diagram`, `file`, `image` or `html` item written with no `placement` gets one, stored with the row: the lowest slot of the viewers' grid (four columns, cells 320 by 200, 40 apart, slot order left to right then down) whose cell no existing item's box covers. A connector still takes none; a shape is still refused without one. An item written with a placement keeps it.
- **D4. Nothing stored changes shape, and no old row moves.** Items placed by a viewer's grid before this keep that until someone writes or drags them. The MCP App's and the dash's per-viewer grids stay for those rows.
- **D5. One PR.** The rule, the contract cases, and the skill, which ships to Claude Code with the next release.

## 1. The skill

- **The method** (D1), with a worked example: a plan of three steps in one column, a decision in the next, a connector from the decision to the step it changed, a `rect` behind the plan titled "Phase 1".
- **The rules** (D2), replacing today's "Columns by topic" and "Connectors for relations" lines.
- **Sizes:** a card 320 wide; `h` set only when a card's height matters; a shape's `w` and `h` always; a diagram `w: 720`.
- **The checklist,** at the end: read first; one topic, one column; nothing overlaps; a relation is a connector, a group is a shape, a structure is a diagram; remove what is finished; place every item, and say that the server places one you leave unplaced in the next free slot, so leaving it out is never a gap, only a worse layout.
- **The tool text** of `bellman_send`'s `surface` kind gains nothing; the skill carries the method.

## 2. The server rule

- **Where:** in the room's surface write, inside the transaction that stores the row, from the rows the room holds, in both stores.
- **The slot:** `index` from 0; `x = (index mod 4) × 360`, `y = floor(index / 4) × 240`; a cell is covered when an existing item's box (`x, y, w ?? 320, h ?? 200`) overlaps it; the first uncovered slot wins. Connectors and shapes without a box take no cell; a shape with one does.
- **The kinds placed:** `text`, `link`, `diagram`, `file`, `image`, `html`. A connector: none, as today. A shape: refused without `{ x, y, w, h }`, as today.
- **A write with a placement** stores it as given. A write that replaces an item and omits `placement` keeps the stored one rather than taking a new slot.
- **The `surface` event** carries the placement the server chose, so the log and the row agree, and a viewer's replay lays the item out where the row is.

## 3. Tests and rollout

- **The contract, both stores:** an unplaced card lands at slot 0; the next at slot 1; a slot an existing placed item covers is skipped, including one covered by a card wider than a cell; a connector gets none; a shape without a placement is still refused; a card written with a placement keeps it; a replacing write without a placement keeps the stored one; the event carries the chosen placement.
- **The skill:** no test. The branch review reads it against the method and the rules.
- **Rollout:** one server PR, after the public rooms 2a PR (which also edits `src/store-do.ts`). The skill reaches Claude Code at the next release.

## Out of scope

- Moving items the server once placed.
- A layout the room's creator chooses, or placing by content.
- Changing the dash's or the MCP App's per-viewer grid for old rows.

## Risks

- **The grid is the viewers' grid.** If the dash's card width changes, the server's slots and the viewers' grid must change together; the constants live in one place on each side and the spec names them.
- **A crowded surface.** With 64 items the search covers at most 64 cells past the last; cheap.
