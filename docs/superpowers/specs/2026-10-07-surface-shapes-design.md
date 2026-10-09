# Surface Shapes: Simple Vector Shapes on the Canvas — Design

Issue: [#129](https://github.com/bellman-sh/bellman/issues/129), piece 5 — added after piece 4 was specified. The kind is [#197](https://github.com/bellman-sh/bellman/issues/197); the canvas side is [bellman-sh/dash#15](https://github.com/bellman-sh/dash/issues/15)
Status: implemented on the server; the panel follows (dash #15)
Depends on: piece 1 — [the working surface](2026-10-06-working-surface-design.md), whose item model this extends; piece 3 — [the canvas UI](2026-10-06-surface-canvas-ui-design.md), whose page draws it. Piece 4 — [HTML artifacts](2026-10-06-surface-html-artifacts-design.md) — lands first by order, and nothing here needs its frame
Repos: `bellman-sh/bellman` (the kind) and `bellman-sh/dash` (the node, the resizer, the dialog)

## Problem

Members annotate. A box around three items that belong together, an arrow
that says this feeds that, a label on the box. Today the only geometry the
surface holds is a `connector`, a line between two items, and a `diagram` is
text that becomes a picture only inside piece 4's frame. A shape is not a
diagram: it is a few numbers, the canvas draws it directly, and any member
whose seat carries `write_surface` can drag it, resize it and remove it, the
same as every other item.

## Scope

In: one `shape` kind; five forms (rectangle, ellipse, diamond, arrow, line);
six named colors; an optional label; size on the placement; resize on the
canvas for a writer; a dialog on the toolbar.

Out: freeform paths, arbitrary colors, rotation, z-order, text styling,
grouping semantics (a rectangle drawn around items does not own them),
snapping, and shapes in the MCP Apps monitor. See "Out of scope".

## Decisions

### D1 — A `shape` kind with its own field.

Each kind that is more than text already carries its own field: a `connector`
has `ends`, a `file` or an `image` has `blob`. A `shape` has `shape`:

```ts
shape: { form: "rect" | "ellipse" | "diamond" | "arrow" | "line"; color?: ShapeColor; flip?: boolean }
```

Not JSON in `body`: the server validates every value with the item, the
projection stays typed, and a reader never parses peer text to draw. The
label is `title`, under `MAX_SURFACE_TITLE_CHARS`; `body` is refused ("a shape
has no body; its label is the title"). `ends` and `blob` are refused by the
rules that already refuse them for every kind that is not theirs.

The stored item is normalized: `color` defaults to `"slate"` and `flip` to
`false`, so a reader never branches on absence.

### D2 — Size lives on the placement.

`placement` already allows `w` and `h`; a shape requires them: "a shape
needs placement { x, y, w, h }". Position and size are one write, the one a
drag or a resize makes, and the server's existing positive-finite rule bounds
them as it bounds every placement. No maximum is added here: a placement has
none today for any kind, and a shape does not change that.

### D3 — Colors are names.

`color` is one of `slate`, `blue`, `green`, `amber`, `red`, `violet`. The
panel maps each name to a class in its own stylesheet; the name is never
written into a `style` attribute. A hex string would be the first
peer-controlled string to reach CSS, and the one way the canvas has of
rendering peer content — as text, never as markup or style — holds.

### D4 — An arrow or a line spans the box.

Its geometry is the placement box: from the top-left corner to the
bottom-right, or with `flip: true` from the bottom-left to the top-right. An
arrow's head is at the second end. `flip: true` on any other form is refused
("flip is for an arrow or a line"), so the stored item says only what the canvas
draws; `flip: false`, the default every stored shape carries, is accepted, so a
shape read back can be sent back.

### D5 — Inline SVG, with no peer string but the label.

The node draws `<rect>`, `<ellipse>`, a `<polygon>` for the diamond, and a
`<line>` with a marker for the arrow, sized to the node. Every attribute is a
number the server validated or a class the color map chose. The label is an
HTML element laid over the SVG, centered, clamped to three lines by CSS,
rendered as text (React escapes it). No `href`, no `<use>`, no `<script>`,
no `foreignObject`, no `dangerouslySetInnerHTML`: the `react/no-danger` rule
stays on and a test pins that the SVG holds only those elements.

### D6 — A resize is a write, under the drag's rule.

A writer sees React Flow's `NodeResizer` on a shape; a reader does not. On
resize end the page writes the whole item with the new `w` and `h` (a PUT
takes the item), keeping a local override until the poll agrees; a refused or
failed write drops the override, so the next poll snaps the node back to the
server's size, the rule a drag already follows. The resizer's minimum is
40 × 40 on the page; the server's rule stays positive-finite.

Piece 3's local override holds `x` and `y`; this piece widens it to carry `w`
and `h` for a shape.

### D7 — The dialog.

A "Shape" button on the toolbar opens a dialog: the form as five choices, the
color as six swatches, an optional label. The key is `shape_<suffix>` from
the suffix helper the other keys use. The item is placed at the viewport's
center at 200 × 120 (200 × 100 for an arrow or a line) and written through
`putItem`; the dialog closes on the 2xx, and a refusal shows beside the
button as the other dialogs show theirs.

### D8 — The tools need no new surface.

`bellman_send type: "surface"` already takes the item shape, so an agent
writes a shape the way it writes a text; the tool's text names the kind and
its field. `bellman_connect`'s index shows a shape as `kind: "shape"` with
`chars: 0`. No tool is added, so `extension/manifest.json` is untouched.

## Schema

```ts
// src/surface.ts
export const SHAPE_FORMS = ["rect", "ellipse", "diamond", "arrow", "line"] as const;
export const SHAPE_COLORS = ["slate", "blue", "green", "amber", "red", "violet"] as const;
const ShapeShape = z.strictObject({
  form: z.enum(SHAPE_FORMS),
  color: z.enum(SHAPE_COLORS).default("slate"),
  flip: z.boolean().default(false),
});
// SurfaceItemShape gains:  shape: ShapeShape.nullish(),
// SURFACE_KINDS gains:     "shape"
```

Refusals, in `normalizeSurfaceWrite`, each prefixed `surface shape "<key>":`
as the others are:

- `a shape needs shape { form, color?, flip? }`
- `a shape has no body; its label is the title`
- `a shape needs placement { x, y, w, h }`
- `only a shape has shape` (any other kind carrying the field)
- `flip is for an arrow or a line`

`SurfaceItem` and `SurfaceRow` gain `shape: Shape | null`; `surfaceItem` in
`src/projections.ts` carries it for every item, `null` for the other kinds,
as `ends` and `blob` are carried. The panel's `SurfaceItem` and `SurfaceWrite`
in `src/lib/api.ts` mirror it.

## Security

The only peer string in a shape is its `title`, rendered as text like every
title. The numbers are finite and positive by the server's rule. The color is
an enum name resolved to a class, never a style. The SVG carries no link, no
reference and no script, and a test asserts the element set. Shapes ship in
the untrusted envelope like every item, so an agent reading the surface sees
whose box this is before it sees the box.

## Testing

Server (`tests/tools/working-surface.test.ts`, `tests/helpers/store-contract.ts`):
a full shape is accepted and read back with its field; each of the five
refusals goes red on the exact wording; defaults are applied and visible in
the projection; a shape with a body is refused; a `text` carrying `shape` is
refused; the index shows `kind: "shape"`, `chars: 0`; the HTTP `PUT` through
`writeSurface` accepts the same item the tool accepts (the agreement test the
routes carry already covers the kinds it is given).

Panel (`src/lib/canvas.test.ts`, `src/components/canvas/shape-node.test.tsx`,
the page test): `toFlow` sizes a shape node from its placement; each form
renders its element; the label is escaped text; a color resolves to its
class and no `style` attribute carries it; `flip` swaps the line's ends; the
SVG holds no `href`, `use`, `script` or `foreignObject`; the resizer renders
for a writer only; a resize writes `w` and `h`; a refused resize snaps back on
the next poll; the dialog writes the expected item. Every test is run against
a broken implementation once before it counts.

Manual: a shape drawn in one browser appears in another within the poll, at
the same size and color.

## Files

bellman: `src/surface.ts` (the forms, the colors, `ShapeShape`, the rules),
`src/types.ts` (`Shape` on `SurfaceItem`), `src/store.ts` and `src/store-do.ts`
(the row carries `shape`), `src/projections.ts` (`surfaceItem`), `src/tools/send.ts`
(the kind named in the tool's text), `README.md` and `docs/ARCHITECTURE.md`
(the kinds list), the tests above.

dash: `src/lib/api.ts` (types), `src/lib/canvas.ts` (size from placement, the
override with `w`/`h`, `shapeKey`), `src/components/canvas/shape-node.tsx`
(and `nodeTypes`), `src/components/canvas/shape-dialog.tsx`, the room route
(the resize handler, the toolbar button), `src/index.css` (the six color
classes), the tests above.

## Out of scope

Freeform paths (a whiteboard's pen), hex or arbitrary colors, rotation,
z-order and layers, text styling, group membership, snapping and alignment
guides, a maximum size on the server, shapes in the MCP Apps monitor. Each is
its own decision when asked for.
