# Surface Placement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan runs with subagents and **one whole-branch review at the end**: no per-task review steps, whatever a skill says.

**Goal:** A card written to a room's surface without a placement is placed by the server, in the next free slot of the grid the viewers already use, and stored with its row; and the canvas skill teaches agents a layout method with numbers, three rules for connectors, shapes and diagrams, and a checklist.

**Architecture:** One pure rule beside the surface's other rules (`withPlacement` in `src/surface.ts`) decides from the rows a room holds. Each store applies it inside the append that stores the row, before the event is built: `placedAppend` in `SessionDO` (one list of the `sf:` rows per write that needs a slot) and `MemoryStore.placed` (its map). The event is appended with the placement the row takes, and an idempotent retry is judged by the draft the caller sent. The skill's method replaces its "Columns by topic" and "Connectors for relations" lines. No stored shape changes.

**Tech Stack:** TypeScript, Cloudflare Workers and Durable Objects, vitest (root program) and `@cloudflare/vitest-pool-workers` (`worker-tests/`), Markdown for the skill and the docs.

**Spec:** `docs/superpowers/specs/2026-10-22-surface-placement-design.md`

## Global Constraints

- The slot (spec D3, section 2): `index` from 0; `x = (index mod 4) × 360`, `y = floor(index / 4) × 240`; cells 320 by 200, 40 apart (`GRID = { cols: 4, w: 320, h: 200, gap: 40 }`); a cell is covered when an existing item's box (`x, y, w ?? 320, h ?? 200`) overlaps it; the first uncovered slot wins.
- The kinds placed: `text`, `link`, `diagram`, `file`, `image`, `html`. A connector takes none. A shape is refused without `{ x, y, w, h }`, as today.
- A write with a placement stores it as given. A write that replaces an item and omits `placement` keeps the stored one rather than taking a new slot.
- The `surface` event carries the placement the server chose, so the log and the row agree.
- Nothing stored changes shape: `placement` is an existing field, and no old row is moved (D4).
- Every `BellmanStore` method stays async. A behaviour change in a write goes into both stores and the store contract (`tests/helpers/store-contract.ts`).
- The skill (D1, D2, section 1): a card is 320 wide and about 200 tall unless `h` is set, with 40 between cards; columns at `x = 0, 360, 720, …`, rows at `y = 0, 240, 480, …`; a diagram card takes `w: 720`. The tool text of `bellman_send`'s `surface` kind gains nothing.
- `src/ui/assets.ts` is generated: edit `ui/`, never that file. `plugin/bridge/*.mjs` are rebuilt only by release PRs, and this is not one: the skill's text alone reaches Claude Code at the next release.
- A non-ASCII character in TypeScript source or tests is written as a braced escape such as `\u{2026}`. None of the code below needs one. The Markdown keeps the `…` and `—` it shows.
- A room holds many members: never write "two sessions" or "the other session". Never write "load-bearing", any "worth …" phrase, or "structural".
- Edit with the Edit or Write tool, never `perl -i` or `sed -i`. Never call a `graph_*`, dual-graph or `bellman_*` tool. Never bypass commit signing.

## Review Focus

Five inputs the spec implies and its text does not name, most likely first. Each is pinned by a test in the task named.

1. **A room that predates this.** Its rows have no placement, and the viewers draw them on the grid in key order, counting only the rows with none and ignoring every placed box. Expect a new card never to land over an old one, and a rewrite of one of them to close the rest up behind it. Pinned in Task 1 and Task 2.
2. **A replacing write that leaves `placement` out.** Expect the card to stay where it is, in the row and in the logged event, even when a lower slot has freed since. Pinned in Task 1 and Task 2.
3. **A box that covers more than one cell, sits off the grid, or is written over another.** A card of `w` 720, a `rect` behind a column, a card half a cell off the grid: expect every cell it overlaps to be taken, and a cell it only touches at an edge to be free. A placement the writer gives over a box that is there is stored as given: keeping clear is the skill's rule, not the server's. Pinned in Task 1 and Task 2.
4. **A retry after the room changed.** Expect the retry of an unplaced write to replay the first event with its placement, take no second slot and report no conflict, and a card removed in between to stay removed. Pinned in Task 2.
5. **A box with no upper bound, and a full surface.** Expect the search to end: a box of `w` 1e300 leaves the next card stored unplaced, as today, with the write still succeeding; the 65th key lands at slot 64; and two writes landing together take two slots. Pinned in Task 1 and Task 2.

## Rulings

Where the spec was silent or the code disagreed with it. Each is a decision this plan carries out. R1, R4 and R7 were put to the lead and approved; R4 and R7 go beyond the spec's letter.

- **R1. The search runs in each store's append, inside its transaction, and not in `writeSurface`.** `writeSurface` (`src/rooms.ts`) already reads every row, with `store.surfaceOf`, for the 64-item cap and a connector's ends, but that read sits before the append and outside its transaction. A slot chosen there fails twice. (a) Two unplaced writes read the same rows and take one slot. (b) The idempotent-retry reason: the slot would sit in the draft the idempotency fingerprint is taken from (`fingerprint(e)` includes the payload), so a retry made after the room changed would pick another slot and read as a conflict instead of a replay. In the store, `appendEventOnce` returns the original event before any search, and the fingerprint stays the caller's draft. "places once: a retry of the same write replays whatever has landed since" pins (b), and a break in Task 2 Step 5 shows it red.
- **R2. One list of the `sf:` rows per write that needs a slot.** `SessionDO` lists the prefix inside the append's transaction (`placedAppend`, named with a `ponytail:` comment); `MemoryStore` reads its map. A write that carries a placement, a removal, a connector and a shape read nothing extra, so the dash's drag writes (one `PUT` per card) cost what they did.
- **R3. The event carries the placement the row takes.** The store appends the draft with `payload` set to the placed item. `writeSurface` builds that payload as the item (`payload: write.item ?? { key, remove: true }`), so the event reads as the row does. The draft that reaches the store is unchanged, and the fingerprint is taken from it. This is part of Task 2 and not a task of its own: the event and the row come from one step, and a task that placed the row alone would leave the log and the row disagreeing.
- **R4. A row with no placement covers the cell the viewers draw it in.** The MCP App's `layout` and the dash's `toFlow` draw a row with none at `gridSlot(n)`, `n` counting only the rows with none, in key order, and ignoring every placed box. A search that read stored boxes alone would put the first new card on the first old card in every room that predates this. `coveredBoxes` counts them as the viewers do, and leaves out the key being written, because that row leaves the unplaced rows and the others close up behind it. The spec's text names stored boxes; a row with none has no stored box, and this gives it the one the viewers draw. Pinned in Task 1 ("keeps clear of a row stored with no placement…", "places a row stored with none…") and in the contract ("keeps clear of the rows stored with no placement, which the viewers draw on the grid", where a placed row sits between two without, so a count that included it would fail).
- **R5. A placement the writer gives is stored as given,** over a box that is there or not. Keeping clear is the skill's rule; the server places only what it was not told. Pinned in Task 1 ("stores a placement the writer gives as given, even over a box that is there") and in the contract ("stores a placement as given, over a box that is there, and the next card avoids both").
- **R6. A replace that omits `placement` keeps the stored one (spec section 2).** Today such a replace stores none and sends the item back to the viewers' grid, so this is a change for placed items too. A stored `null` is not kept: the write is placed. On the wire `null` is absence, so nothing can clear a placement afterwards, and the dash never tries (`toWrite` drops nulls).
- **R7. The search stops at `MAX_SLOT_SEARCH`, a row of four slots for each of the surface's 64 items (256), and the item is stored unplaced past it.** The spec says 64 items make the search "at most 64 cells past the last", which holds while a box covers one cell. A placement's `w` and `h` have no upper bound, and a box of 1e300 covers every slot there is; a search with no end would hang the room's object inside its transaction. An unplaced item is what the viewers lay out today, so the fallback loses nothing, and the write still succeeds. Pinned in Task 1 ("leaves a card unplaced, and returns, when one box covers every slot", "searches MAX_SLOT_SEARCH slots and no more") and in the contract ("leaves a card unplaced, and returns, when one box covers every slot the search tries").
- **R8. The grid's constants live in `GRID` and `gridSlot` in `src/surface.ts`,** copies of the same two in `ui/src/canvas-layout.ts` and in dash's `src/lib/canvas.ts`. `tests/working-surface.test.ts` imports the MCP App's and fails when they differ. Dash's cannot be tested from here: a comment beside each of this repo's two names it, and "After this plan" asks for one in dash.
- **R9. `bellman_send`'s result does not name the slot.** The spec leaves the tool text alone. A writer reads the placement with `bellman_sync` and `surface: true`, which the skill says to do before placing.
- **R10. Four existing tests change an expectation,** all of an unplaced text or file item that read `placement: null` and now read `{ x: 0, y: 0 }`: the contract's "writes the row with the event's cursor and moves surfaceCursor, in one append", and in `tests/tools/working-surface.test.ts` "appends a surface event carrying the normalised item, and the row commits with it" (the event's payload and the row), "accepts an item as it was read, null fields and all, once cursor and at are removed" and "places a file carrying the object's metadata, which the payload never named". A prototype of this plan, run over the whole root suite and the whole workerd suite, showed these are the only tests that change. A shape without a placement is still refused by `normalizeSurfaceWrite`, and "holds a shape to its rules, each in its own words" pins it; it is unchanged.
- **R11. The ADR is numbered at merge.** 0023 is taken, and public rooms 2a and the room pages take numbers before this one. Write `docs/adr/00NN-surface-placement.md` and number it against `origin/main` when the PR opens.
- **R12. The skill has no test of its own (spec section 3).** Task 3 runs every JSON payload in it through `normalizeSurfaceWrite`, with a payload that must be refused as the control, so an example cannot drift from the server's rules. The branch review reads the rest against the method and the rules.
- **R13. This starts after public rooms 2a's PR,** which also edits `src/store-do.ts`. The places the two touch are the `./surface.js` import, the bodies of `SessionDO.appendEvent` and `SessionDO.appendEventOnce`, and the area above `readsClosed`.
- **R14. No tool text changes.** `extension/manifest.json`, the generated docs pages (`npm run docs:gen`) and ARCHITECTURE section 11's measurements stay as they are, and `plugin/bridge/*.mjs` are not rebuilt.

## The code, by predicate

Run at this plan's base (main `651f1fa`, PR #291), from the workspace. A JSDoc line starts with `*`, and several modules name these symbols in prose, so each grep drops comment lines.

```bash
grep -rn --include='*.ts' -E '\b(applySurfaceWrite|normalizeSurfaceWrite)\(' src | grep -v '^src/ui/assets.ts' | grep -vE '^[^:]+:[0-9]+:\s*(\*|//|/\*)'
grep -rn --include='*.ts' -E 'AppendExtras = \{ surface|type: "surface"' src | grep -v '^src/ui/assets.ts' | grep -vE '^[^:]+:[0-9]+:\s*(\*|//|/\*)'
grep -rn --include='*.ts' -E '\bsurfaceItem\b|\bsurfaceIndex\(|\.surfaceOf\(' src | grep -v '^src/ui/assets.ts' | grep -vE '^[^:]+:[0-9]+:\s*(\*|//|/\*)'
grep -rn -i -E 'never written back|by key order|slot in a grid|grid forgets' --include='*.md' --include='*.ts' . | grep -v -E 'node_modules|^(\./)?docs/superpowers'
git -C ~/src/github.com/bellman-sh/dash grep -n -E 'unplaced|GRID = |export const gridSlot' origin/main -- src/lib/canvas.ts
```

What they find, and what each fact decides:

| Predicate | Found | Decides |
|---|---|---|
| Callers of `applySurfaceWrite` | `MemoryStore.applyExtras` (`src/store.ts`) with `rows.get(key)`, and `extraRows` (`src/store-do.ts`) with `txn.get(sf:<key>)`. Each has the existing row for the one key and nothing else. | The monotonic rule cannot place: a slot needs every row's box. The search is a new step beside it, not a change to it. |
| Caller of `normalizeSurfaceWrite` | `writeSurface` (`src/rooms.ts`) alone. It then reads every row with `store.surfaceOf`, before and outside the append. | R1: the rows are in hand there, and it is the wrong place to choose a slot. |
| Builders of `AppendExtras.surface`, and of `type: "surface"` | `writeSurface` alone builds the extras and the draft. The bridge's `bellman_upload` sends a surface payload through `bellman_send`. | Every surface write reaches a store through `writeSurface`, so one rule in the stores covers the tool, the dash's `PUT` and an upload. |
| What each append holds | `SessionDO.appendEvent` and `appendEventOnce` hold `txn` and can `txn.list({ prefix: "sf:" })`; `MemoryStore` holds `this.surfaces.get(id)`. | R2: where the search runs, in both. |
| The `surface` event and the reads | The draft's `payload` is the normalised item. `surfaceItem` (via `readSurface`: `bellman_sync` with `surface`, `bellman_surface`, `bellman_confirm`, `GET /rooms/:id/surface`) carries `placement`; `surfaceIndex` (the join preview) does not. | R3: patch the event's payload, and the readers need no change. |
| The viewers' grid | MCP App: `GRID` and `gridSlot` in `ui/src/canvas-layout.ts`; `layout` draws a non-connector item at `placement ?? gridSlot(unplaced++)`, in key order, sized `placement.w ?? GRID.w` by `placement.h ?? GRID.h`. Dash at `origin/main` (`510d017`): `GRID` and `gridSlot` in `src/lib/canvas.ts`, and `toFlow` with the same `unplaced++`. Both count only unplaced rows. | R4 and R8: the server's `GRID` and `gridSlot` copy these; a row with no placement is drawn at the next index among the rows with none. |
| Text describing the old behaviour | `plugin/skills/canvas/SKILL.md` ("Placement"), `docs-site/src/content/docs/guides/surface.md` ("Placement and shapes"), and a `ponytail:` comment in `ui/src/canvas-layout.ts`. The earlier specs and plans are history and stay. | Tasks 1, 3 and 4. |

Tests that already hold the surface: `describe("the surface rows")` in `tests/helpers/store-contract.ts` (the contract, run by `tests/store.test.ts` for `MemoryStore` and `worker-tests/store-contract.test.ts` for `DurableObjectStore`), `tests/working-surface.test.ts` (the pure rules), `tests/tools/working-surface.test.ts` (`bellman_send`), `describe("PUT and DELETE /rooms/:id/surface/:key")` in `tests/http-rooms.test.ts` (the dash's route) and `tests/store-do-wiring.test.ts` (`SessionDO` over fake storage).

## File map

| File | Task | Change |
|---|---|---|
| `src/surface.ts` | 1 | `GRID`, `gridSlot`, `PLACED_KINDS`, `MAX_SLOT_SEARCH`, `needsPlacement`, `withPlacement` |
| `ui/src/canvas-layout.ts` | 1 | the `ponytail:` comment above `GRID` names the server's copy |
| `src/store.ts` | 2 | `MemoryStore.placed` and its two call sites; the `AppendExtras.surface` docblock |
| `src/store-do.ts` | 2 | `placedAppend`, and its two call sites in `SessionDO` |
| `plugin/skills/canvas/SKILL.md` | 3 | "Placement" and "Laying it out" rewritten; "What to draw", "Sizes" and "Before each write" added |
| `docs/adr/00NN-surface-placement.md`, `README.md`, `docs/ARCHITECTURE.md`, `docs-site/src/content/docs/guides/surface.md` | 4 | docs |

Tests: `tests/working-surface.test.ts` (1); `tests/helpers/store-contract.ts`, `tests/tools/working-surface.test.ts`, `tests/http-rooms.test.ts`, `tests/store-do-wiring.test.ts` (2).

---

## The server

**Workspace:** `/Users/mcfearsome/.worktrees/bellman-surface-placement`, a jj workspace whose working copy sits on this plan's change, on the spec's (bookmark `mcfearsome/surface-placement`). Git commands fail there; that is expected. Each task ends with `jj commit -m "…"`. Commits are signed: if one hangs or says "incorrect passphrase supplied", stop and tell the lead. Move the bookmark to the last change before opening the PR.

**Commands:** `npx vitest run <file> -t "<name>"` for the root program. For workerd, install its tree once with `npm --prefix worker-tests install --legacy-peer-deps --no-audit --no-fund --silent`, then `npm run build:ui && npm --prefix worker-tests run test -- <file>`. `npm run verify` ends the branch.

- [ ] **Setup 1: Rebase onto trunk.** `jj -R ~/src/github.com/bellman-sh/bellman git fetch`, then in the workspace `jj rebase -b @ -d 'trunk()'`.

- [ ] **Setup 2: Check public rooms 2a is in.** `gh pr list --repo bellman-sh/bellman --state merged --search "public rooms" --json number,title,mergedAt`. Expected: the 2a PR is listed. If it is not, stop and tell the lead: both branches edit `src/store-do.ts` (R13), and the order is the owner's call.

- [ ] **Setup 3: Install and verify.** `npm ci && npm run verify`. Expected: green.

### Task 1: The rule

**Files:**
- Modify: `src/surface.ts`, `ui/src/canvas-layout.ts` (a comment)
- Test: `tests/working-surface.test.ts`

**Interfaces:**
- Produces, in `src/surface.ts` (runtime-free, like the rest of the module):
  ```ts
  /** The viewers' grid: four columns of cells 320 by 200, 40 apart. Copies `GRID` in ui/src/canvas-layout.ts and dash's src/lib/canvas.ts. */
  export const GRID: { readonly cols: 4; readonly w: 320; readonly h: 200; readonly gap: 40 };
  /** Slot `index`, left to right and then down: `gridSlot` in both viewers. */
  export const gridSlot: (index: number) => { x: number; y: number };
  /** The kinds the server places when they arrive without a placement. */
  export const PLACED_KINDS: readonly SurfaceKind[];
  /** The ceiling on the slot search (R7): a row of four slots for each item the surface can hold, 256. */
  export const MAX_SLOT_SEARCH: number;
  /** Whether a write arrives without the placement the room gives it. */
  export const needsPlacement: (write: SurfaceWrite) => write is { key: string; item: SurfaceItem };
  /** The write as the room stores it. The same object when it needs no placement, or when every slot in the search is covered. */
  export function withPlacement(rows: readonly SurfaceRow[], write: SurfaceWrite): SurfaceWrite;
  ```

- [ ] **Step 1: Write the failing tests.** In `tests/working-surface.test.ts`, replace the `../src/surface.js` import and add the viewers' import beside it:

```ts
import {
  GRID, MAX_SLOT_SEARCH, MAX_SURFACE_ITEMS, SurfaceKeyShape, applySurfaceWrite, gridSlot, needsPlacement, withPlacement, surfaceCursor,
  type SurfaceWrite,
} from "../src/surface.js";
import { GRID as VIEWER_GRID, gridSlot as viewerSlot } from "../ui/src/canvas-layout.js";
```

After `describe("the bounds")`, add:

```ts
/**
 * The server places what arrives unplaced (surface placement spec D3): the lowest slot of the viewers'
 * grid whose cell no row covers. The rule is pure, over the rows a store hands it, so it is tested here
 * once, and the store contract holds both stores to applying it.
 */
describe("withPlacement", () => {
  const SHAPE = { form: "rect", color: "slate", flip: false } as const;
  const stored = (key: string, placement: SurfaceRow["placement"], over: Partial<SurfaceRow> = {}): SurfaceRow => ({
    ...item({ key, placement }), cursor: 1, at: 1_700_000_000_000, byMemberId: "m_creator", byLabel: "jesse@codenerd", ...over,
  });
  /** A shape row, the kind whose box is the placement's own size. */
  const box = (key: string, placement: SurfaceRow["placement"]) => stored(key, placement, { kind: "shape", shape: SHAPE });
  /** Where a card written with no placement lands among `rows`. */
  const landsAt = (rows: SurfaceRow[], key = "new") => withPlacement(rows, { key, item: item({ key }) }).item?.placement;
  /** Where the next `n` cards land, each written after the one before. */
  const fill = (rows: SurfaceRow[], n: number) => {
    const all = [...rows];
    for (let i = 0; i < n; i++) all.push(stored(`n${i}`, landsAt(all, `n${i}`) ?? null));
    return all.slice(rows.length).map((r) => r.placement);
  };

  it("puts the first card at slot 0, fills a row of four left to right and starts the next row below", () => {
    expect(landsAt([])).toEqual({ x: 0, y: 0 });
    expect(fill([], 6)).toEqual([
      { x: 0, y: 0 }, { x: 360, y: 0 }, { x: 720, y: 0 }, { x: 1080, y: 0 }, { x: 0, y: 240 }, { x: 360, y: 240 },
    ]);
  });

  /** Review Focus 3: a box covers every cell it touches, and a cell it only touches at an edge is free. */
  it("skips a slot a box covers: a card of w 720 covers two, one that only touches a cell covers none", () => {
    expect(landsAt([stored("wide", { x: 0, y: 0, w: 720 })])).toEqual({ x: 720, y: 0 });
    // In the 40-wide gap between slots 0 and 1, touching both cells: it covers neither.
    expect(landsAt([stored("gap", { x: 320, y: 0, w: 40, h: 200 })])).toEqual({ x: 0, y: 0 });
    // Half a cell off the grid, a 320 by 200 box at (160, 100) crosses slots 0, 1, 4 and 5.
    expect(fill([stored("off", { x: 160, y: 100 })], 3)).toEqual([{ x: 720, y: 0 }, { x: 1080, y: 0 }, { x: 720, y: 240 }]);
  });

  /** Review Focus 3, again: a shape is a box like a card's, and a group's rect lies over the cells it groups. */
  it("treats a shape's box as covering every cell under it", () => {
    // A rect 360 wide and 680 tall lies over slots 0, 4 and 8, and at x = 360 only touches slot 1.
    expect(fill([box("group", { x: 0, y: 0, w: 360, h: 680 })], 5)).toEqual([
      { x: 360, y: 0 }, { x: 720, y: 0 }, { x: 1080, y: 0 }, { x: 360, y: 240 }, { x: 720, y: 240 },
    ]);
  });

  it("gives a connector no slot, and a connector among the rows covers none", () => {
    const connector = { key: "link", item: item({ key: "link", kind: "connector", ends: { from: "a", to: "b" } }) };
    expect(withPlacement([], connector)).toBe(connector);
    expect(landsAt([stored("link", null, { kind: "connector", ends: { from: "a", to: "b" } })])).toEqual({ x: 0, y: 0 });
  });

  /** Review Focus 3: a placement the writer gives is stored as given, over a box that is there. Keeping clear is the skill's rule, not the server's (R5). */
  it("stores a placement the writer gives as given, even over a box that is there", () => {
    const rows = [stored("a", { x: 0, y: 0 })];
    const write = { key: "b", item: item({ key: "b", placement: { x: 0, y: 0 } }) };
    expect(withPlacement(rows, write)).toBe(write);
  });

  it("returns a shape and a removal as they came", () => {
    const writes: SurfaceWrite[] = [
      { key: "g", item: item({ key: "g", kind: "shape", shape: SHAPE, placement: { x: 0, y: 0, w: 10, h: 10 } }) },
      { key: "a", item: null },
    ];
    for (const w of writes) expect(withPlacement([stored("a", { x: 0, y: 0 })], w), w.key).toBe(w);
  });

  it("needs a placement only for a text, link, diagram, file, image or html item written with none", () => {
    for (const kind of ["text", "link", "diagram", "file", "image", "html"] as const) {
      expect(needsPlacement({ key: "k", item: item({ kind }) }), kind).toBe(true);
    }
    for (const kind of ["connector", "shape"] as const) expect(needsPlacement({ key: "k", item: item({ kind }) }), kind).toBe(false);
    expect(needsPlacement({ key: "k", item: item({ placement: { x: 1, y: 2 } }) })).toBe(false);
    expect(needsPlacement({ key: "k", item: null })).toBe(false);
  });

  /** Review Focus 2: replacing an item moves nothing. */
  it("keeps the placement a key holds when a write replaces the item and leaves it out", () => {
    const rows = [stored("a", { x: 360, y: 240, w: 720, h: 200 }), stored("b", { x: 0, y: 0 })];
    const out = withPlacement(rows, { key: "a", item: item({ key: "a", body: "revised" }) });
    expect(out.item).toMatchObject({ body: "revised", placement: { x: 360, y: 240, w: 720, h: 200 } });
    expect(out.item?.placement, "a copy, never the stored row's own object").not.toBe(rows[0].placement);
  });

  /** Review Focus 1: every room that predates this holds rows with no placement, which the viewers still lay out. */
  it("keeps clear of a row stored with no placement, which the viewers draw on the grid in key order", () => {
    // `a` and `c` have none, so the viewers draw them at slots 0 and 1; `b` sits at slot 2.
    expect(landsAt([stored("a", null), stored("c", null), stored("b", { x: 720, y: 0 })])).toEqual({ x: 1080, y: 0 });
  });

  it("places a row stored with none where it leaves the rest, which close up behind it", () => {
    // Written again, `a` is no longer among the unplaced rows, so the viewers draw `b` at slot 0.
    expect(landsAt([stored("a", null), stored("b", null)], "a")).toEqual({ x: 360, y: 0 });
  });

  it("places a card after 64 occupied slots at slot 64", () => {
    const full = fill([], MAX_SURFACE_ITEMS).map((p, i) => stored(`s${i}`, p));
    expect(landsAt(full)).toEqual(gridSlot(MAX_SURFACE_ITEMS));
  });

  /** Review Focus 5: a box has no upper bound, and a search with no end would hang the room's object. */
  it("leaves a card unplaced, and returns, when one box covers every slot", () => {
    const write = { key: "new", item: item({ key: "new" }) };
    expect(withPlacement([box("sky", { x: 0, y: 0, w: 1e300, h: 1e300 })], write)).toBe(write);
  });

  it("searches MAX_SLOT_SEARCH slots and no more", () => {
    const across = GRID.cols * (GRID.w + GRID.gap);
    const deep = (rows: number) => (rows - 1) * (GRID.h + GRID.gap) + GRID.h;
    const lastRow = MAX_SLOT_SEARCH / GRID.cols - 1;
    // Every row but the last of the search is covered: the card takes the last row's first slot.
    expect(landsAt([box("sky", { x: 0, y: 0, w: across, h: deep(lastRow) })])).toEqual(gridSlot(MAX_SLOT_SEARCH - GRID.cols));
    // Every row of it is covered: the slot after is free, past the search, and the card is left unplaced.
    const write = { key: "new", item: item({ key: "new" }) };
    expect(withPlacement([box("sky", { x: 0, y: 0, w: across, h: deep(lastRow + 1) })], write)).toBe(write);
  });
});

describe("the viewers' grid", () => {
  it("is the one the MCP App lays unplaced rows on; dash's src/lib/canvas.ts holds a third copy", () => {
    expect(GRID).toEqual(VIEWER_GRID);
    for (let i = 0; i < 3 * GRID.cols; i++) expect(gridSlot(i), `slot ${i}`).toEqual(viewerSlot(i));
  });
});
```

- [ ] **Step 2: Run to see them fail.** `npx vitest run tests/working-surface.test.ts`. Expected: `14 failed | 30 passed (44)`: eleven `TypeError: withPlacement is not a function`, one `TypeError: needsPlacement is not a function`, one `TypeError: Cannot read properties of undefined (reading 'cols')` ("searches MAX_SLOT_SEARCH slots and no more") and one `expected undefined to deeply equal { cols: 4, w: 320, h: 200, gap: 40 }` (the grid).

- [ ] **Step 3: Implement** the Interfaces in `src/surface.ts`, after `applySurfaceWrite` and before `PlacementShape`. `PLACED_KINDS` is `["text", "link", "diagram", "file", "image", "html"]`, `gridSlot(index)` is `x: (index % GRID.cols) * (GRID.w + GRID.gap)` and `y: Math.floor(index / GRID.cols) * (GRID.h + GRID.gap)`, and `needsPlacement` is `write.item !== null && write.item.placement === null && PLACED_KINDS.includes(write.item.kind)`, each with the docblock its Interfaces line gives. The slot search is an algorithm the tests alone do not fix: `overlaps` is strict, so edges that touch share no area; the rows with no placement are counted in code-unit key order, among themselves, leaving out the key being written; and the loop is bounded. `MAX_SLOT_SEARCH` comes after `GRID`, whose `cols` it reads, and `MAX_SURFACE_ITEMS` is defined above.

```ts
// ponytail: a ceiling on the search, not tuned: a row of four slots for every item the surface can hold. A
// rect behind a column covers more than one slot, and a box sized 1e300 covers every slot there is; a search
// with no end would hang the room's object inside its transaction. Past it the item is stored unplaced, as
// it was before this, and the write still succeeds; the upgrade is a search that skips a covered run in one step.
export const MAX_SLOT_SEARCH = MAX_SURFACE_ITEMS * GRID.cols;

interface Box { x: number; y: number; w: number; h: number }

/** Whether two boxes share area. Boxes that only touch do not. */
const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Code-unit order, not `localeCompare`: the viewers' sort, so every reader derives the same grid. */
const byKey = (a: { key: string }, b: { key: string }): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * What the rows cover as the viewers draw them (`layout` in `ui/src/canvas-layout.ts`, `toFlow` in dash): a
 * row with a placement at it, the grid's size where it has none; a row with none at the next slot of the
 * grid, counting in key order, as a viewer lays out a row nobody has placed. A connector has no box.
 * `skipKey` is the row being written, which the write is about to place or replace.
 */
function coveredBoxes(rows: readonly SurfaceRow[], skipKey: string): Box[] {
  let unplaced = 0;
  return rows
    .filter((r) => r.key !== skipKey && r.kind !== "connector")
    .sort(byKey)
    .map((r) => {
      const at = r.placement ?? gridSlot(unplaced++);
      return { x: at.x, y: at.y, w: r.placement?.w ?? GRID.w, h: r.placement?.h ?? GRID.h };
    });
}

export function withPlacement(rows: readonly SurfaceRow[], write: SurfaceWrite): SurfaceWrite {
  if (!needsPlacement(write)) return write;
  const stored = rows.find((r) => r.key === write.key)?.placement ?? null;
  if (stored !== null) return { key: write.key, item: { ...write.item, placement: { ...stored } } };
  const covered = coveredBoxes(rows, write.key);
  for (let i = 0; i < MAX_SLOT_SEARCH; i++) {
    const at = gridSlot(i);
    if (!covered.some((b) => overlaps(b, { ...at, w: GRID.w, h: GRID.h }))) {
      return { key: write.key, item: { ...write.item, placement: at } };
    }
  }
  return write;
}
```

  Give `withPlacement` a docblock: a write that needs a placement gets the one its key already holds, so replacing an item moves nothing, and otherwise the lowest slot of the grid whose cell no row covers; a write that has one, a removal, a connector and a shape come back as they are, and so does a write for which every slot in the search is covered.

- [ ] **Step 4: Run to see them pass.** `npx vitest run tests/working-surface.test.ts`. Expected: `44 passed`.

- [ ] **Step 5: See each rule fail without its code.** Run `jj st` first so jj has the working copy recorded, then for each row break the code with Edit, run `npx vitest run tests/working-surface.test.ts`, and put it back with Edit. The unbounded box's own case ("leaves a card unplaced, and returns, when one box covers every slot") has no break of its own: a loop with no end hangs the test instead of failing it. Row 7 breaks the other side of the ceiling, and that case goes red with it.

| # | Break | Expect these to fail |
|---|---|---|
| 1 | In `withPlacement`, delete the line that returns the stored placement (`if (stored !== null) return …`) | "keeps the placement a key holds when a write replaces the item and leaves it out" |
| 2 | In `coveredBoxes`, add `&& r.placement !== null` to the filter, so rows with none cover nothing | "keeps clear of a row stored with no placement…" and "places a row stored with none where it leaves the rest…" |
| 3 | In `coveredBoxes`, deal the slots by position among all the rows: `.map((r, i) => {` and `gridSlot(i)` in place of `gridSlot(unplaced++)` | "keeps clear of a row stored with no placement, which the viewers draw on the grid in key order" |
| 4 | In `overlaps`, change each `<` to `<=` | "skips a slot a box covers…" and "treats a shape's box as covering every cell under it" |
| 5 | In `coveredBoxes`, size every box `w: GRID.w, h: GRID.h` | "skips a slot a box covers…", "treats a shape's box…", "leaves a card unplaced, and returns…" and "searches MAX_SLOT_SEARCH slots and no more" |
| 6 | In `coveredBoxes`, add `&& r.kind !== "shape"` to the filter | "treats a shape's box…", "leaves a card unplaced, and returns…" and "searches MAX_SLOT_SEARCH slots and no more" |
| 7 | In `withPlacement`, end with `return { key: write.key, item: { ...write.item, placement: gridSlot(MAX_SLOT_SEARCH) } };` in place of `return write;` | "leaves a card unplaced, and returns…" and "searches MAX_SLOT_SEARCH slots and no more" |
| 8 | In `needsPlacement`, drop `write.item.placement === null &&`, so a write that has a placement is placed too | "stores a placement the writer gives as given, even over a box that is there" and "needs a placement only for a text, link, diagram, file, image or html item written with none" |

Then `jj diff --stat`. Expected: the same two files as before this step, `src/surface.ts` and `tests/working-surface.test.ts`.

- [ ] **Step 6: Name the server's copy beside the viewers' grid.** In `ui/src/canvas-layout.ts`, extend the `ponytail:` comment above `GRID` so it reads:

```ts
// ponytail: a four-column grid of fixed cells for items nobody has placed; dash
// writes a real placement on the first drag and the grid forgets the item. The
// server now places a new item on this same grid and stores the slot (`GRID` and
// `withPlacement` in src/surface.ts), so what lands here is a row from before; the
// two grids must stay equal, and tests/working-surface.test.ts holds them to it.
```

Then `npm run typecheck && npm run typecheck:ui`. Expected: no type errors. The new import of `ui/src/canvas-layout.js` in a root test is the first from `tests/` into `ui/src`; it pulls two files with no imports of their own into the root program.

- [ ] **Step 7: Commit.** `jj commit -m "The server has a rule for placing an item written without a placement: the lowest free slot of the viewers' grid, kept clear of boxes and of rows the viewers draw"`

### Task 2: The stores

**Files:**
- Modify: `src/store.ts` (`MemoryStore.appendEvent`, `MemoryStore.appendEventOnce`, a new `MemoryStore.placed`, the `AppendExtras.surface` docblock), `src/store-do.ts` (a new `placedAppend`, `SessionDO.appendEvent`, `SessionDO.appendEventOnce`)
- Test: `tests/helpers/store-contract.ts`, `tests/tools/working-surface.test.ts`, `tests/http-rooms.test.ts`, `tests/store-do-wiring.test.ts`

**Interfaces:**
- Consumes: `needsPlacement`, `withPlacement` (Task 1).
- Produces: an append whose `extras.surface.item` needs a placement stores the row, and appends the event, with the placement `withPlacement` chose from the rows the room holds. A replay returns the original event and searches nothing. No signature changes.

- [ ] **Step 1: Write the failing tests.**

  **The contract**, in `tests/helpers/store-contract.ts`. Replace the surface import with `import { MAX_SURFACE_ITEMS, gridSlot, surfaceCursor } from "../../src/surface.js";`. In "writes the row with the event's cursor and moves surfaceCursor, in one append", the expected row becomes `{ ...plan(), placement: { x: 0, y: 0 }, cursor: event.cursor, at: event.at, byMemberId: "m_creator", byLabel: "jesse@codenerd" }`. Then, inside `describe("the surface rows")`, after "writes neither event nor row into a frozen room", add:

```ts
      /**
       * A card that arrives with no placement is placed in the append's own transaction, from the rows the
       * room holds (surface placement spec D3), and the event carries the placement the row does. `withPlacement`
       * in surface.ts is the rule and tests/working-surface.test.ts its cases; these hold both stores to
       * applying it, and to doing so inside the append, where a retry and a second writer are decided.
       */
      describe("placing what arrives with no placement", () => {
        const SHAPE = { form: "rect", color: "slate", flip: false } as const;
        const card = (key: string, over: Partial<SurfaceItem> = {}): SurfaceItem => ({ ...plan(), key, ...over });
        const put = (id: string, item: SurfaceItem) =>
          store.appendEvent(id, wrote(item), { surface: { key: item.key, item } });
        const placements = async (id: string) =>
          Object.fromEntries((await store.surfaceOf(id)).map((r) => [r.key, r.placement]));
        const room = async () => {
          const s = session({});
          await store.createSession(s);
          return s.id;
        };

        it("places a card at slot 0 and the next at slot 1, in the row and in the event", async () => {
          const id = await room();
          await put(id, card("a"));
          await put(id, card("b"));

          expect(await placements(id)).toEqual({ a: { x: 0, y: 0 }, b: { x: 360, y: 0 } });
          expect((await store.eventsAfter(id, 0)).map((e) => e.payload)).toEqual([
            expect.objectContaining({ key: "a", placement: { x: 0, y: 0 } }),
            expect.objectContaining({ key: "b", placement: { x: 360, y: 0 } }),
          ]);
        });

        /** Review Focus 3: a card of w 720 covers two cells. */
        it("skips the two slots a card of w 720 covers", async () => {
          const id = await room();
          await put(id, card("wide", { placement: { x: 0, y: 0, w: 720 } }));
          await put(id, card("a"));
          expect((await placements(id)).a).toEqual({ x: 720, y: 0 });
        });

        /** Review Focus 3: a shape's box covers the cells under it. */
        it("skips the slots under a shape's box", async () => {
          const id = await room();
          await put(id, card("group", { kind: "shape", body: null, title: "Phase 1", shape: SHAPE, placement: { x: 0, y: 0, w: 360, h: 680 } }));
          await put(id, card("a"));
          await put(id, card("b"));
          expect(await placements(id)).toMatchObject({ a: { x: 360, y: 0 }, b: { x: 720, y: 0 } });
        });

        it("gives a connector no slot, and it takes none", async () => {
          const id = await room();
          await put(id, card("a"));
          await put(id, card("link", { kind: "connector", body: null, ends: { from: "a", to: "b" } }));
          await put(id, card("b"));
          expect(await placements(id)).toEqual({ a: { x: 0, y: 0 }, b: { x: 360, y: 0 }, link: null });
        });

        /** Review Focus 3: a placement the writer gives is stored as given, over a box that is there (R5). */
        it("stores a placement as given, over a box that is there, and the next card avoids both", async () => {
          const id = await room();
          await put(id, card("a", { placement: { x: 0, y: 0 } }));
          await put(id, card("b", { placement: { x: 0, y: 0 } }));
          await put(id, card("c"));
          expect(await placements(id)).toEqual({ a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, c: { x: 360, y: 0 } });
        });

        /** Review Focus 2: replacing a card moves nothing, in the row or in the log, though a lower slot has freed since. */
        it("keeps the stored placement when a write replaces a card and leaves it out", async () => {
          const id = await room();
          await put(id, card("x"));
          await put(id, card("a"));
          await store.appendEvent(id, { ...wrote(), payload: { key: "x", remove: true } }, { surface: { key: "x", item: null } });

          const replaced = (await put(id, card("a", { body: "revised" })))!;

          expect(await placements(id)).toEqual({ a: { x: 360, y: 0 } });
          expect((await store.surfaceOf(id))[0]).toMatchObject({ body: "revised", cursor: replaced.cursor });
          expect(replaced.payload).toMatchObject({ key: "a", body: "revised", placement: { x: 360, y: 0 } });
        });

        /**
         * Review Focus 1. A shape is stored as it is handed, so shapes with no placement stand in for rows from
         * before the server placed anything. The viewers draw old_a and old_c on slots 0 and 1, counting only the
         * rows with none, and old_b sits on slot 2: a new card must not land on any of the three.
         */
        it("keeps clear of the rows stored with no placement, which the viewers draw on the grid", async () => {
          const id = await room();
          const old = (key: string, placement: SurfaceItem["placement"]) =>
            card(key, { kind: "shape", body: null, shape: SHAPE, placement });
          await put(id, old("old_a", null));
          await put(id, old("old_b", { x: 720, y: 0, w: 320, h: 200 }));
          await put(id, old("old_c", null));
          await put(id, card("z"));
          expect((await placements(id)).z).toEqual({ x: 1080, y: 0 });
        });

        /** Review Focus 5. */
        it("places a card after 64 occupied slots at slot 64", async () => {
          const id = await room();
          for (let i = 0; i < MAX_SURFACE_ITEMS; i++) await put(id, card(`c${i}`));
          await put(id, card("last"));
          const placed = await placements(id);
          expect(placed.c63).toEqual(gridSlot(63));
          expect(placed.last).toEqual(gridSlot(MAX_SURFACE_ITEMS));
        });

        /** Review Focus 5: a box with no upper bound covers every slot, and the append still returns. */
        it("leaves a card unplaced, and returns, when one box covers every slot the search tries", async () => {
          const id = await room();
          await put(id, card("sky", { kind: "shape", body: null, shape: SHAPE, placement: { x: 0, y: 0, w: 1e300, h: 1e300 } }));
          const out = (await put(id, card("a")))!;
          expect((await placements(id)).a).toBeNull();
          expect(out.payload).toMatchObject({ key: "a", placement: null });
        });

        it("gives two writes that land together two slots", async () => {
          const id = await room();
          await Promise.all([put(id, card("a")), put(id, card("b"))]);
          const placed = await placements(id);
          expect([placed.a, placed.b]).toEqual(expect.arrayContaining([{ x: 0, y: 0 }, { x: 360, y: 0 }]));
        });

        /**
         * Review Focus 4. The retry's fingerprint is its draft's, which carries no placement, so a retry
         * reads as a retry however the room has filled or emptied since, and the replay takes no slot.
         */
        it("places once: a retry of the same write replays whatever has landed since", async () => {
          const id = await room();
          const first = await store.appendEventOnce(id, wrote(), "sf-0001", { surface: { key: "plan", item: plan() } });
          if (first.outcome !== "appended") throw new Error(`first write said ${first.outcome}`);
          expect(first.event.payload).toMatchObject({ key: "plan", placement: { x: 0, y: 0 } });
          // The card is removed and another takes its slot, so a retry that placed itself again would pick slot 1.
          await store.appendEvent(id, wrote(null), { surface: { key: "plan", item: null } });
          await put(id, card("c"));

          const retry = await store.appendEventOnce(id, wrote(), "sf-0001", { surface: { key: "plan", item: plan() } });

          if (retry.outcome !== "replayed") throw new Error(`the retry said ${retry.outcome}`);
          expect(retry.event).toEqual(first.event);
          expect(await placements(id), "the removed card stays removed, and c keeps slot 0").toEqual({ c: { x: 0, y: 0 } });
        });
      });
```

  **The tool**, in `tests/tools/working-surface.test.ts`. Three tests expect `placement: null` for an unplaced text or file item, and expect `{ x: 0, y: 0 }` now (R10): in "appends a surface event carrying the normalised item, and the row commits with it", the event's `payload` and the row; in "accepts an item as it was read, null fields and all, once cursor and at are removed", the `item("plan")` line (the connector's `item("c1")` line keeps `placement: null`); and in "places a file carrying the object's metadata, which the payload never named", the row. Then add, before `describe("file and image items (#183)")`:

```ts
describe("an item written with no placement (surface placement spec D3)", () => {
  it("is placed in the next free slot, and the log and every read say where", async () => {
    const p = await pairUp(h);
    for (const item of [
      plan(),
      plan({ key: "risks" }),
      { key: "arch", kind: "diagram", body: "flowchart LR\n  A --> B", placement: { x: 720, y: 0, w: 720 } },
      plan({ key: "notes" }),
    ]) {
      const out = await write(p, item);
      expect(out.isError, out.text).toBe(false);
    }

    const read = await p.creator.call("bellman_sync", {
      session_id: p.sessionId, member_id: p.creatorMemberId, since_cursor: 0, surface: true,
    });
    const items = (read.data.surface as { items: { data: { key: string; placement: unknown } }[] }).items.map((i) => i.data);
    // `arch` is 720 wide and covers slots 2 and 3, so `notes` takes slot 4, the first of the next row.
    expect(Object.fromEntries(items.map((i) => [i.key, i.placement]))).toEqual({
      arch: { x: 720, y: 0, w: 720 }, notes: { x: 0, y: 240 }, plan: { x: 0, y: 0 }, risks: { x: 360, y: 0 },
    });
    const logged = (await h.store.eventsAfter(p.sessionId, 0)).filter((e) => e.type === "surface");
    expect(logged.map((e) => (e.payload as { placement: unknown }).placement)).toEqual([
      { x: 0, y: 0 }, { x: 360, y: 0 }, { x: 720, y: 0, w: 720 }, { x: 0, y: 240 },
    ]);
  });
});
```

  **The route**, in `tests/http-rooms.test.ts`, inside `describe("PUT and DELETE /rooms/:id/surface/:key")`, before the comment "Both transports call writeSurface, so the route takes an html page because the tool does (#185).":

```ts
  // The route is the same write as the tool's (surface placement spec D3): an item it is handed with no
  // placement is placed, in the next free slot, and a member's read says where.
  it("places an item the route is handed with no placement, in the next free slot", async () => {
    for (const key of ["plan", "risks"]) {
      const res = (await put(DEV_KEY.jesse, key, { kind: "text", body: key }))!;
      expect(res.status, await res.clone().text()).toBe(200);
    }
    const body = await bodyOf(await call(DEV_KEY.peer, `/rooms/${ROOM}/surface`)) as { items: { data: { key: string; placement: unknown } }[] };
    expect(body.items.map((i) => [i.data.key, i.data.placement])).toEqual([["plan", { x: 0, y: 0 }], ["risks", { x: 360, y: 0 }]]);
  });
```

  **`SessionDO`**, in `tests/store-do-wiring.test.ts`, after `describe("SessionDO read cost")`:

```ts
/**
 * A surface write that arrives with no placement is placed from the room's rows, read in the append's own
 * transaction (surface placement spec D3): one list of the `sf:` prefix. A write that carries its placement,
 * which is every write the dash's drag makes, reads none.
 */
describe("SessionDO surface placement read cost", () => {
  it("lists the surface rows once for a write that needs a slot, and not at all for one that does not", async () => {
    const storage = fakeStorage({ session: currentRow(), cursor: 0 });
    const doi = new storeDo.SessionDO(fakeCtx(storage) as never, {} as never);
    const card = (key: string, placement: { x: number; y: number } | null) =>
      ({ key, kind: "text" as const, title: null, body: "x", ends: null, placement, blob: null, shape: null });
    const lists = async (item: ReturnType<typeof card>) => {
      const before = storage.lists;
      await doi.appendEvent(
        { type: "surface", fromMemberId: "m1", fromUserId: "u1", fromLabel: "jesse", payload: item, refId: null },
        { surface: { key: item.key, item } },
      );
      return storage.lists - before;
    };

    const placed = await lists(card("a", { x: 0, y: 0 }));
    const unplaced = await lists(card("b", null));

    expect(unplaced - placed, "one list more than a write that carries its placement").toBe(1);
    expect(await doi.surfaceOf()).toMatchObject([{ key: "a" }, { key: "b", placement: { x: 360, y: 0 } }]);
    expect((await doi.eventsAfter(0)).at(-1)?.payload, "the event says where the row went").toMatchObject({ key: "b", placement: { x: 360, y: 0 } });
  });
});
```

- [ ] **Step 2: Run to see them fail.** `npx vitest run tests/working-surface.test.ts tests/store.test.ts tests/tools/working-surface.test.ts tests/http-rooms.test.ts tests/store-do-wiring.test.ts`. Expected: `17 failed | 773 passed (790)`, in four files:
  - `tests/store.test.ts`, 11: the changed row case and ten of the eleven new contract cases, each a `null` where a slot was expected (`expected { a: null, b: null } to deeply equal { a: { x: +0, y: +0 }, …(1) }`); "places once…" fails on `first.event.payload`. The eleventh, "leaves a card unplaced, and returns, when one box covers every slot the search tries", passes before and after; Step 5 breaks it.
  - `tests/tools/working-surface.test.ts`, 4: the three changed tests and the new case.
  - `tests/http-rooms.test.ts`, 1: `expected [ [ 'plan', null ], [ 'risks', null ] ] to deeply equal …`.
  - `tests/store-do-wiring.test.ts`, 1: `one list more than a write that carries its placement: expected +0 to be 1`.

- [ ] **Step 3: Implement.**
  - **`placedAppend`** in `src/store-do.ts`, a free function beside `extraRows` (a Durable Object answers RPC for every method on its class, so a helper that reads storage stays off the class), and add `needsPlacement` and `withPlacement` to the `./surface.js` import:

```ts
/**
 * The append a surface write owes before its event is built (surface placement spec D3): a write that arrives
 * without a placement is placed from the room's rows, and the event carries the placement the row will, so the
 * log and the row agree. Everything else comes back untouched, and reads nothing.
 *
 * ponytail: one list of the room's `sf:` rows per write that needs a slot (a card written without a
 * placement), in the append's own transaction so two such writes cannot take one slot. A write with a
 * placement, a removal, a connector and a shape read nothing here; the dash's drag writes are all of those.
 * A room is held to 64 rows by `writeSurface`, so the list is small; the upgrade is a row of the taken
 * cells beside the surface cursor, if a room ever outgrows that.
 *
 * An idempotent replay never gets here: `appendEventOnce` returns the original event before it, and takes
 * its fingerprint from the draft as the caller sent it, so a retry reads as a retry however the room has
 * filled since.
 */
async function placedAppend(
  txn: DurableObjectTransaction,
  e: Omit<SessionEvent, "cursor" | "at">,
  extras: AppendExtras,
): Promise<{ e: Omit<SessionEvent, "cursor" | "at">; extras: AppendExtras }> {
  if (extras.surface === undefined || !needsPlacement(extras.surface)) return { e, extras };
  const rows = [...(await txn.list<SurfaceRow>({ prefix: SURFACE_PREFIX })).values()];
  const surface = withPlacement(rows, extras.surface);
  return surface === extras.surface ? { e, extras } : { e: { ...e, payload: surface.item }, extras: { ...extras, surface } };
}
```

  - **`SessionDO.appendEvent`:** after the frozen check, `const placed = await placedAppend(txn, e, extras);`, then the event is built from `placed.e` and `extraRows` takes `placed.extras`. **`SessionDO.appendEventOnce`:** the same, after the replay branch and the frozen check, so a replay and a frozen room read nothing; `print` is still `fingerprint(e)` of the caller's draft, taken before.
  - **`MemoryStore.placed`** in `src/store.ts`, the same step over the map, with no awaits (add `needsPlacement` and `withPlacement` to the `./surface.js` import):

```ts
  private placed(s: Session, e: Omit<SessionEvent, "cursor" | "at">, extras: AppendExtras): { e: Omit<SessionEvent, "cursor" | "at">; extras: AppendExtras } {
    if (extras.surface === undefined || !needsPlacement(extras.surface)) return { e, extras };
    const surface = withPlacement([...(this.surfaces.get(s.id)?.values() ?? [])], extras.surface);
    return surface === extras.surface ? { e, extras } : { e: { ...e, payload: surface.item }, extras: { ...extras, surface } };
  }
```

  With a docblock saying it is `placedAppend`'s step over the map, and that it takes no awaits for `appendEvent`'s reason. **`MemoryStore.appendEvent`:** `const placed = this.placed(s, e, extras);`, `appendNow(s, placed.e)`, `applyExtras(s, event, placed.extras)`. **`MemoryStore.appendEventOnce`:** the same after the replay branch and the frozen check, with `applyExtras(s, event, placed.extras)`; `print` stays the draft's.
  - **The `AppendExtras.surface` docblock** gains this paragraph, after the one that says "NOT applied on an idempotent replay": `An item that arrives with no placement is placed first, from the rows the room holds (withPlacement, surface.ts), and the event is appended with the placement the row takes. Both stores do it in the append, before the event is built, and neither does it on a replay.`

- [ ] **Step 4: Run to see them pass.** `npx vitest run tests/working-surface.test.ts tests/store.test.ts tests/tools/working-surface.test.ts tests/http-rooms.test.ts tests/store-do-wiring.test.ts`. Expected: `790 passed (790)` at the base this was written on. "holds a shape to its rules, each in its own words" is among them, unchanged: a shape with no placement is still refused. Then `npm run typecheck && npm run typecheck:worker`, expecting no type errors, and the contract in workerd: `npm run build:ui && npm --prefix worker-tests run test -- store-contract.test.ts`. Expected: PASS, with "placing what arrives with no placement" among the cases run against the real `SessionDO`.

- [ ] **Step 5: See each store check fail without its code.** `jj st` first, then break with Edit, run, and put back with Edit.

| # | Break | Run | Expect these to fail |
|---|---|---|---|
| 1 | In `MemoryStore.placed`, return `{ e, extras: { ...extras, surface } }` (leave the payload as the caller built it) | the five files of Step 4 | the contract's "places a card at slot 0 and the next at slot 1, in the row and in the event", "keeps the stored placement…" and "places once…", and the tool's "is placed in the next free slot, and the log and every read say where" and "appends a surface event carrying the normalised item…" |
| 2 | The same in `placedAppend` | `npx vitest run tests/store-do-wiring.test.ts` | "lists the surface rows once for a write that needs a slot…" (its last assertion) |
| 3 | In `MemoryStore.appendEventOnce`, take the fingerprint from the placed draft: `const print = fingerprint(this.placed(s, e, extras).e);` | `npx vitest run tests/store.test.ts` | "places once: a retry of the same write replays whatever has landed since" |
| 4 | In `placedAppend`, drop `\|\| !needsPlacement(extras.surface)` from its guard | `npx vitest run tests/store-do-wiring.test.ts` | "lists the surface rows once for a write that needs a slot…" (`expected +0 to be 1`) |

Then `jj diff --stat`. Expected: the files of this task and nothing else.

- [ ] **Step 6: Run the root suite.** `npm test`. Expected: green. Tasks 1 and 2 add 28 tests to the suite and change no other.

- [ ] **Step 7: Commit.** `jj commit -m "An item written without a placement is placed in the append that stores it, in both stores, and its event carries the placement"`

### Task 3: The skill

**Files:**
- Modify: `plugin/skills/canvas/SKILL.md`

**Interfaces:** none. No test of its own (R12); Step 2 is its check.

- [ ] **Step 1: Write the section.** In `plugin/skills/canvas/SKILL.md`, replace everything from the `## Placement` heading up to, and not including, `## Reading it back` with the text below. Quote the old region from the file as the Edit's `old_string`. The two sections it replaces say the viewers place an item with none "by key order … and never written back" and carry the "Columns by topic" and "Connectors for relations" bullets; the new text takes both over, and "The current state top-left" and "Remove what is finished" move into the method and the checklist.

````markdown
## Placement

`placement` is `{ x, y, w?, h? }`, all finite numbers: `x` and `y` unbounded,
`w` and `h` positive when given. A connector takes none. The control panel's
canvas uses the placement as the item's position, `x` growing to the right and
`y` downward.

Leave `placement` out and the server places the item. It takes the lowest slot
of the canvas's grid that no other item covers and stores it with the item, so
every viewer sees one layout. A placement you write is stored as you wrote it,
over a box that is already there or not, and writing an item again without a
`placement` leaves it where it is. A `shape` is the exception: it is refused
without `{ x, y, w, h }`. An item written before the server placed anything
reads back with `placement: null`; the canvas draws it in a grid slot by key
order, and writing it again places it.

So leaving `placement` out is never a gap, only a worse layout than one you
choose. The next section is how to choose.

## Laying it out

Lay the surface out for a person opening the canvas, and for the next member to
write, who places against what you left.

- **One idea per item.** The plan, the decisions, the status, the design
  diagram: each its own item. A reader finds an idea by its title, and a writer
  replaces it by its key without touching the rest.
- **One stable key per idea.** Choose the key once (`plan`, `decisions`,
  `status`, `api_design`) and write that key every time the idea changes. The
  write replaces the item and the log keeps the old version, so `plan_v2` and
  `plan_final` are never needed; every new key is one more of the surface's 64
  items.
- **Keep the plan current rather than appended to.** When step 2 is done,
  rewrite `plan` with step 2 marked done. Do not add a `step_2_done` item next
  to it.

**The grid.** A card is 320 wide and about 200 tall, with 40 between cards, so a
slot is 360 across and 240 down: columns sit at `x = 0, 360, 720, …` and rows at
`y = 0, 240, 480, …`. It is the canvas's own grid, the one the server places on.
Work to it:

1. **Read the surface first,** with `bellman_sync` and `surface: true`, so you
   place against what is there.
2. **One topic, one column.** Items about one topic share an `x`. The first
   column is the first topic: what a reader needs first, the status or the plan,
   at `{ x: 0, y: 0 }`, where someone opening the canvas starts.
3. **A new card takes the next free slot of its topic's column:** the first `y`
   in it that no existing item covers.
4. **A new topic starts the next column,** 360 to the right of the last.
5. **Write nothing over an existing box,** except a group's `rect` laid behind
   the cards it groups. An item covers `x` to `x + w` and `y` to `y + h`; a card
   with no `w` or `h` is 320 by 200.
6. **A `diagram` card takes `w: 720`,** two columns wide, so leave the next
   column's slot at that `y` empty.

**A worked example.** A plan of three steps in one column, a decision in the
next, a connector from the decision to the step it changed, and a `rect` behind
the plan titled "Phase 1". Each line is its own `bellman_send`, and the
connector goes last, because its ends must be on the surface:

```json
{ "key": "step_1", "kind": "text", "title": "Port the webhook handler", "body": "Move the handler to the new queue.", "placement": { "x": 0, "y": 0 } }
{ "key": "step_2", "kind": "text", "title": "Backfill idempotency keys", "body": "Run the backfill on staging first.", "placement": { "x": 0, "y": 240 } }
{ "key": "step_3", "kind": "text", "title": "Cut over", "body": "Switch traffic once the backfill is clean.", "placement": { "x": 0, "y": 480 } }
{ "key": "decision_1", "kind": "text", "title": "Keep the old endpoint for a week", "body": "Peers still call it until they update.", "placement": { "x": 360, "y": 0 } }
{ "key": "phase_1", "kind": "shape", "title": "Phase 1", "shape": { "form": "rect", "color": "blue" }, "placement": { "x": -20, "y": -20, "w": 360, "h": 720 } }
{ "key": "decision_to_step_3", "kind": "connector", "ends": { "from": "decision_1", "to": "step_3" }, "title": "changed" }
```

The `rect` lies 20 past the three cards on every side, so it covers the plan's
column and stops short of the decision's.

## What to draw

Three rules decide what goes on the surface beside the cards.

1. **Connect what relates.** When one item depends on, blocks, explains or
   follows another, draw a connector between them instead of saying so in
   prose, with a one-word `title` for the relation: `needs`, `blocks`,
   `changed`, `then`. A plan's steps connect in order, `step_1` to `step_2` to
   `step_3`, and a decision connects to the item it changed:
   `{ "key": "api_to_db", "kind": "connector", "ends": { "from": "api", "to": "db" }, "title": "writes" }`.
   Write both ends first: a connector naming a key that is not on the surface
   is refused. Removing an item leaves its connectors pointing at nothing, and
   the canvas stops drawing them, so remove those connectors too.
2. **Group what belongs together.** Put a `rect` shape behind a column or a
   cluster of cards, with a `title` and a `color`, 20 past the cards on every
   side, so a reader sees the group before the cards. Where a connector has no
   second item to reach, a `line` or an `arrow` shape marks a boundary or points
   at a place.
3. **Draw, don't connect, past about six relations.** Seven connectors on one
   surface read as a tangle. Write one `diagram` item that draws the structure,
   and connect it to the cards it explains:

```json
{ "key": "request_flow", "kind": "diagram", "title": "Request flow", "body": "flowchart LR\n  api --> queue\n  queue --> worker\n  worker --> db", "placement": { "x": 720, "y": 0, "w": 720 } }
```

## Sizes

| | Size |
|---|---|
| A card | 320 wide, so leave `w` out. About 200 tall, so set `h` only when its height matters; over 240 it covers the slot below, which then stays empty. |
| A shape | `w` and `h`, always: its box is its placement. |
| A diagram | `w: 720`. |

## Before each write

- [ ] **Read first.** You have read the surface since its last change.
- [ ] **One topic, one column.** The card's `x` is its topic's column.
- [ ] **Nothing overlaps,** except a `rect` behind the cards it groups.
- [ ] **A relation is a connector, a group is a shape, a structure is a
  diagram.**
- [ ] **Remove what is finished,** and the connectors that pointed at it. A
  surface holds at most 64 items; a write that would add a 65th key is refused
  until one is removed, and a write to a key already on the surface does not
  count against the limit.
- [ ] **Place every item.** The server places one you leave unplaced, in the
  next free slot, so leaving it out is never a gap, only a worse layout.

````

- [ ] **Step 2: Run every payload in the skill through the server's own check.** Write `node_modules/.cache/bellman-skill-check/check-skill.mts` (gitignored, so jj never records it) with Write:

```ts
// check-skill.mts: every JSON payload in the canvas skill goes through the server's own write check.
// usage: npx tsx check-skill.mts <repo root>
import { readFileSync } from "node:fs";

const root = process.argv[2];
const { normalizeSurfaceWrite } = await import(`${root}/src/surface.ts`);
const skill = readFileSync(`${root}/plugin/skills/canvas/SKILL.md`, "utf8");

const payloads: unknown[] = [];
// Every fenced json block: one payload, or one payload a line.
for (const [, block] of skill.matchAll(/```json\n([\s\S]*?)\n```/g)) {
  try {
    payloads.push(JSON.parse(block));
  } catch {
    for (const line of block.split("\n")) if (line.trim()) payloads.push(JSON.parse(line));
  }
}
// Every inline payload from Placement to Reading it back; the sections before it hold templates with an ellipsis in them.
const placed = skill.slice(skill.indexOf("## Placement"), skill.indexOf("## Reading it back"));
for (const [, span] of placed.matchAll(/`(\{ "key": [^`]*\})`/g)) payloads.push(JSON.parse(span));

let refused = 0;
for (const p of payloads) {
  const out = normalizeSurfaceWrite(p);
  if (!out.ok) {
    refused++;
    console.error("REFUSED", JSON.stringify(p).slice(0, 90), "->", out.reason);
  }
}
// The positive control: the same check refuses a payload that breaks a rule.
if (normalizeSurfaceWrite({ key: "Bad Key", kind: "text", body: "x" }).ok) {
  console.error("CONTROL: the check passed a bad payload");
  process.exit(2);
}
console.log(`${payloads.length} payloads read, ${refused} refused; the control was refused`);
process.exit(refused === 0 ? 0 : 1);
```

  Run `npx tsx node_modules/.cache/bellman-skill-check/check-skill.mts "$PWD"`. Expected: `9 payloads read, 0 refused; the control was refused`, exit 0. Then change `"key": "step_2"` in the worked example to `"key": "Step 2"` and run it again. Expected: a `REFUSED … key: surface keys must match [a-z][a-z0-9_]{0,30}` line, `9 payloads read, 1 refused`, exit 1. Put it back and run it once more for the 0.

- [ ] **Step 3: Check the words and the plugin.**
  - `grep -nE -i 'load-bearing|load bearing|worth (saying|stating|noting|knowing|recording)|structural|two sessions|the other session' plugin/skills/canvas/SKILL.md`. Expected: nothing; main has no hit in this file.
  - `grep -n 'never written back' plugin/skills/canvas/SKILL.md`. Expected: nothing; the old sentence is gone.
  - `npx vitest run tests/plugin.test.ts`. Expected: PASS. The skill's text is not bundled into `plugin/bridge/*.mjs`, so no bundle is rebuilt (R14).

- [ ] **Step 4: Commit.** `jj commit -m "The canvas skill teaches a layout method with numbers, three rules for connectors, shapes and diagrams, and a checklist"`

### Task 4: The docs, and the branch verified

**Files:**
- Create: `docs/adr/00NN-surface-placement.md` (R11)
- Modify: `README.md`, `docs/ARCHITECTURE.md`, `docs-site/src/content/docs/guides/surface.md`

No test of its own: its checks are the grep in Step 6, the docs site's build and `npm run verify`.

- [ ] **Step 1: Write the ADR** in the shape of ADR 0023: Date 2026-10-22, Status accepted, Spec, Plan, Context, Decision, Consequences. Title: `ADR 00NN — The server places an item written without a placement`. Context is the spec's Goal, and the fact that each viewer worked an unplaced item out for itself and never wrote it back, so an agent laying out a surface could not see where an old item was drawn. Decision, one entry each, with the spec decision (D) or ruling (R) it records:
  1. **The rule is pure and runs inside each store's append (R1, R2).** `withPlacement` in `src/surface.ts`; `placedAppend` in `SessionDO` lists the `sf:` rows once, for a write that needs a slot; `MemoryStore.placed` reads its map. Placing in `writeSurface` was rejected: two writers read the same rows, and the slot would sit in the draft the idempotency fingerprint is taken from.
  2. **The slot (D3).** The lowest slot of the viewers' grid (`GRID`, `gridSlot`) whose cell no row's box covers; the kinds placed are `text`, `link`, `diagram`, `file`, `image` and `html`; a connector takes none; a shape is refused without a placement, as before.
  3. **A placement given is stored as given; a replace that omits one keeps the stored one (R5, R6).**
  4. **The event carries the row's placement, and a retry is judged by the caller's draft (R3).**
  5. **A row with no placement covers the cell the viewers draw it in (R4, D4).** Old rows keep the viewers' grid; the server keeps clear of it.
  6. **The search ends at `MAX_SLOT_SEARCH` slots, 256 (R7).** Past it the item is stored unplaced and the write succeeds.
  7. **The grid lives in three places (R8)** and a test holds this repo's two together.
  8. **The skill carries the method (D1, D2); the tool text is unchanged (R9, R14).**

  Consequences:
  - A room's new items are all placed, so a person and the next agent read one layout. A row from before keeps `placement: null` until it is written again or dragged.
  - A replace that omits `placement` used to send the item back to the viewers' grid; it now stays put (R6).
  - A write that needs a slot costs one list of the room's `sf:` rows; a write that carries its placement costs none.
  - If a viewer's card size or column count changes, `GRID` changes in three places.
  - Nothing stored changed shape, so a rollback is a revert; items already placed keep their placement.
  - The skill reaches Claude Code at the next release.

- [ ] **Step 2: README.md.** In the first bullet of "The working surface", after `every version stays in the log at its cursor.`, add: `An item sent without a placement is placed by the server, in the next free slot of the canvas's grid (four columns of 320 by 200 cells, 40 apart), and keeps that slot until it is written with another or dragged.`

- [ ] **Step 3: ARCHITECTURE.md.** In the front matter's `siblings:` line, add `superpowers/specs/2026-10-22-surface-placement-design.md`. In "The working surface", after the paragraph that ends "because the record's could claim a change it never saw.", add:

```markdown
An item that arrives with no placement is placed in the append that stores it (ADR 00NN).
`withPlacement` (`src/surface.ts`) gives a `text`, `link`, `diagram`, `file`, `image` or `html`
item the placement its key already holds, so replacing an item moves nothing, and otherwise the
lowest slot of the viewers' grid (`GRID` and `gridSlot`: four columns of 320 by 200 cells, 40
apart, left to right and then down) that no row's box covers. A shape's box covers the cells
under it, and a row stored before this, with none, is covered where the viewers draw it.
`SessionDO`'s `placedAppend` lists the room's `sf:` rows once, for a write that needs a slot and
for no other, before the event is built; `MemoryStore.placed` reads its map. The event is
appended with the placement the row takes, and an idempotent retry is judged by the draft the
caller sent, so it replays however the room has filled since. The search ends at
`MAX_SLOT_SEARCH` slots (256, a row of four for each of the surface's 64 items), and an item
that finds none is stored unplaced, with the write still succeeding, and laid out by the
viewers. The grid lives in three places that must agree: `src/surface.ts`,
`ui/src/canvas-layout.ts` (held to it by `tests/working-surface.test.ts`) and dash's
`src/lib/canvas.ts`. A connector has no placement, and a shape is refused without one.
```

- [ ] **Step 4: The docs site's surface guide** (`docs-site/src/content/docs/guides/surface.md`). In "Placement and shapes", replace the first paragraph, the one that ends "so place any item whose position matters. A connector takes no placement.", with:

```markdown
`placement` is `{ x, y, w?, h? }`, all finite numbers: `x` and `y` unbounded, `w` and `h` positive when given. `x` grows to the right and `y` downward. A connector takes no placement.

Leave `placement` out and the server places the item, in the lowest slot of the canvas's grid that no other item covers: four columns of cells 320 wide and 200 tall, 40 apart, filled left to right and then down. The slot is stored with the item, so every viewer sees one layout. A placement you write is stored as written, and writing an item again without one leaves it where it is. A `shape` is the exception: it needs a full placement. An item written before the server placed anything reads back with `placement: null`, and the canvas draws it in a grid slot by key order until it is written again or dragged.
```

  Then replace "Laying items out" with:

```markdown
### Laying items out

- Give each idea one item under one stable key, such as `plan`, `decisions`, `status` or `api_design`, and write that key every time the idea changes. The write replaces the item and the log keeps the old version, so `plan_v2` and `plan_final` are never needed. Every new key is one more of the 64.
- Keep the plan current rather than appended to. When step 2 is done, rewrite `plan` with step 2 marked done; do not add a `step_2_done` item beside it.

A card is 320 wide and about 200 tall, with 40 between cards, so a slot is 360 across and 240 down: columns sit at `x = 0, 360, 720, …` and rows at `y = 0, 240, 480, …`. Agents lay the surface out on that grid, which is also the one the server places on:

- Read the surface first, so a new card goes against what is there.
- Items on one topic share an `x` and stack down by `y`. The first column is the first topic, with the status or the plan at `{ "x": 0, "y": 0 }`, and a new topic starts the next column.
- A new card takes the next free slot of its topic's column. Nothing is written over an existing box, except a group's `rect` laid behind the cards it groups.
- A `diagram` takes `w: 720`, two columns wide. A card needs no `w`, and sets `h` only when its height matters.

Three rules decide what else goes on the surface:

- **Connect what relates.** Draw a connector, with a one-word `title` for the relation, when one item depends on, blocks, explains or follows another: a plan's steps in order, a decision to the item it changed. Write both ends first: a connector naming a key that is not on the surface is refused. Removing an item leaves its connectors pointing at nothing, and the canvas stops drawing them, so remove those connectors too.
- **Group what belongs together.** A `rect` shape behind a column or a cluster of cards, titled and coloured, 20 past the cards on every side, marks the group. A `line` or an `arrow` shape marks a boundary where a connector has no second item to reach.
- **Draw, don't connect, past about six relations.** Write one `diagram` item that draws the structure, and connect it to the cards it explains.

Remove what is finished, and the connectors that pointed at it.
```

- [ ] **Step 5: The tool text did not move.** `npm run docs:gen`, then `jj diff --stat`. Expected: nothing under `docs-site/src/content/docs/reference/`, and the files of this plan only. (R14: `tests/docs-reference.test.ts` runs in `npm test` and fails with "run npm run docs:gen" if a page and a tool disagree.)

- [ ] **Step 6: Check the words, then verify.**
  - `grep -nE -i 'load-bearing|load bearing|worth (saying|stating|noting|knowing|recording)|structural|two sessions|the other session' docs/adr/00NN-surface-placement.md README.md docs/ARCHITECTURE.md docs-site/src/content/docs/guides/surface.md src/surface.ts src/store.ts src/store-do.ts ui/src/canvas-layout.ts tests/working-surface.test.ts tests/helpers/store-contract.ts tests/tools/working-surface.test.ts tests/http-rooms.test.ts tests/store-do-wiring.test.ts`. Expected: nothing; main has no hit in these files.
  - `npm --prefix docs-site ci && npm --prefix docs-site run build`. Expected: the site builds. It fails on a broken link, and this task adds none.
  - `npm run verify`. Expected: green.
  - `jj diff -r 'trunk()..@' --stat`. Expected: the spec, this plan, and the files of this plan's file map and tests; nothing in `plugin/bridge/`, `extension/`, `src/ui/assets.ts` or `node_modules/`.

- [ ] **Step 7: Commit.** `jj commit -m "ADR 00NN, and the docs, for surface placement"`

---

## After this plan

- **The ADR's number** (R11): rename `docs/adr/00NN-surface-placement.md` and the `ADR 00NN` mentions in `docs/ARCHITECTURE.md` against `origin/main` when the PR opens.
- **Dash**, a one-line comment above `GRID` in `src/lib/canvas.ts` naming `src/surface.ts` as the server's copy, so a change to dash's card size reads the other two places as well (R8). Not needed for this PR to merge.
- **The skill reaches Claude Code at the next release,** whose PR rebuilds `plugin/bridge/*.mjs` and moves the plugin's version. Nothing here does.
- **Out of scope, as the spec says:** moving items the server once placed; a layout the room's creator chooses, or placing by content; changing the dash's or the MCP App's per-viewer grid for old rows.
