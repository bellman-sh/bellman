# Shapes on the Surface: the Kind (bellman) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `shape` surface item (rect, ellipse, diamond, arrow, line; six named colours; size on the placement) that `bellman_send type: "surface"` and `PUT /rooms/:id/surface/:key` accept, store and read back, with every other kind reading `shape: null`.

**Architecture:** The rules live where every kind's do, in `normalizeSurfaceWrite` (`src/surface.ts`): a new `ShapeShape` field on the item, one arm for the kind, one refusal for any other kind carrying the field. The stores keep the row as the write hands it, so they need no change beyond the type. `surfaceItem` (`src/projections.ts`) carries the field for every item, `null` for a row written before it. The panel's half (the node, the dialog, the resizer's bounds) is a separate plan in dash, after dash #28.

**Tech Stack:** TypeScript, zod 4, vitest (the root program and `worker-tests`).

**Spec:** `docs/superpowers/specs/2026-10-07-surface-shapes-design.md` (D1 to D5, D8, Schema, Testing). Issue #197.

## Global Constraints

- Forms, exactly: `rect`, `ellipse`, `diamond`, `arrow`, `line`. Colours, exactly: `slate`, `blue`, `green`, `amber`, `red`, `violet`. Defaults: `color: "slate"`, `flip: false`, applied by the shape, so a stored shape spells both.
- The refusals, verbatim, each after the prefix `surface <kind> "<key>": `: `a shape needs shape { form, color?, flip? }`; `a shape has no body; its label is the title`; `a shape needs placement { x, y, w, h }`; `only a shape has shape`; `flip is for an arrow or a line`.
- `flip: true` on a rect, an ellipse or a diamond is refused; `flip: false` is accepted on every form, because every stored shape carries it and an item read back must go back. (The spec's D4 says "flip on any other form is refused"; read with D1's normalisation, it means a flip that would draw nothing. Task 2 amends the sentence.)
- No size bound beyond the placement's positive-finite rule (D2).
- No new tool and no new route; `extension/manifest.json` is untouched. The label is `title`, under `MAX_SURFACE_TITLE_CHARS`.
- Writing: a room holds many members; never "two sessions", "the other session", "counterpart", "the other side"; never "load-bearing" or "worth saying plainly". Commits signed (`git -c commit.gpgsign=true commit -S`), files staged by name, never `CLAUDE.md`, subjects in sentence case. `npm run verify` green before every commit.

## Review Focus

1. Every kind as a member reads it now carries `shape: null`; sent back unchanged (less `cursor` and `at`), each is accepted. (Task 1, the round-trip test.)
2. A rectangle as read carries `flip: false`; sent back, it is accepted. (Task 1.)
3. A row stored before this has no `shape` key; it reads back `shape: null`. (Task 1, projection test.)
4. A shape 0.5 wide, or 1e9 tall, is accepted; 0 wide is refused by the placement's rule. (Task 1.)
5. A shape written through `PUT /rooms/:id/surface/:key` is accepted and stored as the tool stores it, defaults applied. (Task 1, route test.)

---

### Task 1: The kind, its rules and its projection

**Files:**
- Modify: `src/types.ts` (`SurfaceKind`, `Shape`, `SurfaceItem.shape`), `src/surface.ts` (`SURFACE_KINDS`, `SHAPE_FORMS`, `SHAPE_COLORS`, `ShapeShape`, `SurfaceItemShape`, `normalizeSurfaceWrite`), `src/projections.ts` (`surfaceItem`), every other literal `SurfaceItem` or `SurfaceRow` the typecheck flags (fixtures, the bridge, tests), and `ui/src/types.ts` if it mirrors `SurfaceKind` under a test
- Test: `tests/tools/working-surface.test.ts`, `tests/projections.test.ts`, `tests/http-rooms.test.ts`, `tests/helpers/store-contract.ts`

**Interfaces:**
- Produces: `interface Shape { form: "rect" | "ellipse" | "diamond" | "arrow" | "line"; color: "slate" | "blue" | "green" | "amber" | "red" | "violet"; flip: boolean }`; `SurfaceItem.shape: Shape | null`; `SHAPE_FORMS`, `SHAPE_COLORS` exported from `src/surface.ts`; the wire's item gains `shape` (null for every kind but `shape`).

- [ ] **Step 1: Tests first.** In `tests/tools/working-surface.test.ts`, a new `describe("shape items (#197)")`:

```ts
describe("shape items (#197)", () => {
  const box = (over: Record<string, unknown> = {}) => ({
    key: "box", kind: "shape", title: "Group A", shape: { form: "rect" },
    placement: { x: 10, y: 20, w: 200, h: 120 }, ...over,
  });
  const read = async (p: PairedSession) => {
    const out = await p.creator.call("bellman_sync", {
      session_id: p.sessionId, member_id: p.creatorMemberId, since_cursor: 0, surface: true,
    });
    expect(out.isError, out.text).toBe(false);
    return (out.data.surface as { items: { data: Record<string, unknown> }[] }).items.map((i) => i.data);
  };

  it("places a shape with its defaults applied, and reads every other kind back with shape: null", async () => {
    const p = await pairUp(h);
    const out = await write(p, box());
    expect(out.isError, out.text).toBe(false);
    expect((await rows(p))[0]).toMatchObject({
      key: "box", kind: "shape", title: "Group A", body: null,
      shape: { form: "rect", color: "slate", flip: false }, placement: { x: 10, y: 20, w: 200, h: 120 },
    });
    await write(p, plan());
    const items = await read(p);
    expect(items.find((i) => i.key === "box")!.shape).toEqual({ form: "rect", color: "slate", flip: false });
    expect(items.find((i) => i.key === "plan")!.shape).toBeNull();
  });

  it("draws an arrow or a line either way, refuses a flip on any other form, and takes back the default", async () => {
    const p = await pairUp(h);
    for (const form of ["arrow", "line"]) {
      const out = await write(p, box({ key: form, shape: { form, color: "violet", flip: true } }));
      expect(out.isError, out.text).toBe(false);
    }
    await refusedWith(p, box({ key: "r", shape: { form: "rect", flip: true } }), 'surface shape "r": flip is for an arrow or a line');
    const back = await write(p, box({ key: "r2", shape: { form: "rect", color: "slate", flip: false } }));
    expect(back.isError, back.text).toBe(false);
  });

  it("holds a shape to its rules, each in its own words", async () => {
    const p = await pairUp(h);
    await refusedWith(p, box({ shape: undefined }), 'surface shape "box": a shape needs shape { form, color?, flip? }');
    await refusedWith(p, box({ shape: null }), "a shape needs shape { form, color?, flip? }");
    await refusedWith(p, box({ body: "words" }), "a shape has no body; its label is the title");
    await refusedWith(p, box({ placement: { x: 0, y: 0 } }), "a shape needs placement { x, y, w, h }");
    await refusedWith(p, box({ placement: { x: 0, y: 0, w: 10 } }), "a shape needs placement { x, y, w, h }");
    await refusedWith(p, box({ placement: null }), "a shape needs placement { x, y, w, h }");
    await refusedWith(p, { ...plan(), shape: { form: "rect" } }, 'surface text "plan": only a shape has shape');
    await refusedWith(p, box({ shape: { form: "star" } }), "shape.form");
    await refusedWith(p, box({ shape: { form: "rect", color: "#ff0000" } }), "shape.color");
    await refusedWith(p, box({ shape: { form: "rect", stroke: 2 } }), "shape");
  });

  it("takes any positive finite size, as every placement does", async () => {
    const p = await pairUp(h);
    for (const [key, w, hh] of [["thin", 0.5, 40], ["tall", 40, 1e9]] as const) {
      const out = await write(p, box({ key, placement: { x: 0, y: 0, w, h: hh } }));
      expect(out.isError, out.text).toBe(false);
    }
    await refusedWith(p, box({ key: "flat", placement: { x: 0, y: 0, w: 0, h: 10 } }), "placement.w");
  });

  it("shows a shape in the joiner's index as a shape with no characters", async () => {
    // As the index tests under "joining a room with a surface" read it: kind "shape", chars 0.
  });
});
```

Write the last case's body the way the existing index tests read the index (`describe("joining a room with a surface")`). In the existing round-trip test ("accepts an item as it was read, null fields and all…"), add a shape to the items written, `shape: null` to the positive control on `item("plan")`, and the shape to the items sent back. In `tests/projections.test.ts`: `surfaceItem` of a row with no `shape` key reads `shape: null`, beside the blob case it already has. In `tests/http-rooms.test.ts`: a `PUT` of `box()`'s item (less `key`, per the route's body shape) is accepted and the stored row carries the defaults. In `tests/helpers/store-contract.ts`: a surface event carrying a shape item leaves a row with its `shape`, on both stores.

Run them: red (the kind is refused by the enum).

- [ ] **Step 2: The type.** In `src/types.ts`, `SurfaceKind` gains `"shape"`, and:

```ts
/** A shape (#197, D1): its form, its colour by name, and for an arrow or a line which diagonal it spans. */
export interface Shape {
  form: "rect" | "ellipse" | "diamond" | "arrow" | "line";
  color: "slate" | "blue" | "green" | "amber" | "red" | "violet";
  flip: boolean;
}
```

`SurfaceItem` gains, after `blob`: `/** A shape's own field (#197); null for every other kind. */ shape: Shape | null;`. Then fix every literal the typecheck flags (`npm run typecheck && npm run typecheck:worker`), each with `shape: null`.

- [ ] **Step 3: The rules.** In `src/surface.ts`: `SURFACE_KINDS` gains `"shape"`. After `BlobShape`:

```ts
/** A shape's forms and colours (#197, D1, D3): names, resolved by the panel to its own classes, never a value a stylesheet reads. */
export const SHAPE_FORMS = ["rect", "ellipse", "diamond", "arrow", "line"] as const satisfies readonly Shape["form"][];
export const SHAPE_COLORS = ["slate", "blue", "green", "amber", "red", "violet"] as const satisfies readonly Shape["color"][];
const LINE_FORMS: ReadonlySet<string> = new Set(["arrow", "line"]);

/** What a shape is (D1). The defaults apply here, so a stored shape spells both and a reader never branches on absence. */
const ShapeShape = z.strictObject({
  form: z.enum(SHAPE_FORMS),
  color: z.enum(SHAPE_COLORS).default("slate"),
  flip: z.boolean().default(false),
});
```

(`Shape` joins the `import type` from `./types.js`.) `SurfaceItemShape` gains `shape: ShapeShape.nullish(),`, and the malformed-payload message lists `shape?` after `blob?`. In `normalizeSurfaceWrite`, inside the `else` arm, a new branch before the generic `else if (!v.body)`:

```ts
    } else if (v.kind === "shape") {
      // A shape is a few numbers the canvas draws (#197, D1, D2, D4): its own field, its size on the placement, no body.
      if (!v.shape) return refuse("a shape needs shape { form, color?, flip? }");
      if (v.body) return refuse("a shape has no body; its label is the title");
      if (!v.placement || v.placement.w === undefined || v.placement.h === undefined) {
        return refuse("a shape needs placement { x, y, w, h }");
      }
      // `flip: false` is the default every stored shape carries, so a shape read back and sent back is
      // accepted; only a flip that would draw nothing is refused.
      if (v.shape.flip && !LINE_FORMS.has(v.shape.form)) return refuse("flip is for an arrow or a line");
    } else if (!v.body) {
```

After the blob line that follows the arms: `if (v.shape && v.kind !== "shape") return refuse("only a shape has shape");`. The normalised item gains `shape: v.kind === "shape" ? v.shape! : null,` after `blob`.

- [ ] **Step 4: The projection.** In `surfaceItem`, after `blob`: `shape: r.shape ?? null,` with the blob line's comment extended to it ("rows written before shapes, #197").

Run: green. If `ui/src/types.ts` mirrors `SurfaceKind` and a test compares the two, add `"shape"` there; the in-chat canvas draws a shape through its `default` case ("shape item"), which needs nothing.

- [ ] **Step 5: Controls, quoted.** One at a time, each restored exactly: drop the `.default("slate")` (the defaults test goes red); refuse `flip` whatever its value (the take-back-the-default test goes red); drop the `only a shape has shape` line (its refusal test goes red); drop `?? null` in the projection (the legacy-row test goes red); require `w` only, not `h` (the half-placement refusal goes red).

- [ ] **Step 6: Verify and commit.**

```bash
npm run verify
git add src/types.ts src/surface.ts src/projections.ts tests/tools/working-surface.test.ts tests/projections.test.ts tests/http-rooms.test.ts tests/helpers/store-contract.ts <each file the typecheck made you touch>
git -c commit.gpgsign=true commit -S -m "Let a surface item be a shape: five forms, six named colours, its size on the placement, and no body"
```

---

### Task 2: The tool's text and the docs

**Files:**
- Modify: `src/tools/send.ts` (the `surface` line's `Kinds:` sentence), `README.md` (the kinds list), `docs/ARCHITECTURE.md` (the kinds list; §11's tool-definition figure; the front matter), `docs/superpowers/specs/2026-10-07-surface-shapes-design.md` (status line; D4's flip sentence)
- Test: `npm run verify`, the writing sweep

- [ ] **Step 1: The tool's text.** In `src/tools/send.ts`, the `Kinds:` sentence gains, after the html clause: `shape (shape: { form: rect, ellipse, diamond, arrow or line, color?: slate, blue, green, amber, red or violet, flip?: true draws an arrow or a line from the bottom-left to the top-right }; placement { x, y, w, h } required; the label is title; no body)`. If a test pins the description's text, update it.

- [ ] **Step 2: The docs.** README and ARCHITECTURE name the kind beside the others, with its field and its rules in one sentence each. §11: re-measure the tool definitions by the method §11 describes and record the figure and the delta with one sentence of attribution. The front matter's `last-verified-against-source` is Task 1's commit. The spec: status "implemented on the server; the panel follows (dash #15)"; D4's "`flip` on any other form is refused" becomes "`flip: true` on any other form is refused; `flip: false`, the default every stored shape carries, is accepted".

- [ ] **Step 3: Verify and commit.**

```bash
npm run verify
git diff origin/main..HEAD | grep -E '^\+' | grep -niE 'load-bearing|worth saying plainly|two sessions|other session|counterpart|other side' || echo clean
git add src/tools/send.ts README.md docs/ARCHITECTURE.md docs/superpowers/specs/2026-10-07-surface-shapes-design.md
git -c commit.gpgsign=true commit -S -m "Name the shape kind in the tool's text and the docs, and re-measure the tool definitions"
```
