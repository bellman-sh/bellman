/**
 * The canvas's rules without a DOM (canvas spec D5, D6): dash's grid and sort,
 * so both surfaces draw the same picture; connectors only between cards that
 * exist; fit and zoom as arithmetic.
 */
import { describe, it, expect } from "vitest";
import { FIT_MARGIN, GRID, ZOOM, centerOf, clampZoom, fit, gridSlot, layout, zoomAbout, type Box } from "../src/canvas-layout.js";
import { surfaceFixture } from "./fixtures.js";
import type { SurfaceItemWire, Untrusted } from "../src/types.js";

const env = (key: string, over: Partial<SurfaceItemWire> = {}): Untrusted<SurfaceItemWire> => ({
  trust: "untrusted",
  origin: { memberId: "m", label: "m" },
  data: { key, kind: "text", title: null, body: null, ends: null, placement: null, blob: null, shape: null, cursor: 1, at: "2026-03-15T12:00:00Z", ...over },
});

describe("layout", () => {
  it("keeps a placed item's x, y, w and h, and gives the default size when w or h is absent", () => {
    const { boxes } = layout(surfaceFixture().surface.items);
    expect(boxes.find((b) => b.key === "deck")).toEqual({ key: "deck", x: 400, y: 20, w: 200, h: 120 });
    expect(boxes.find((b) => b.key === "plan")).toEqual({ key: "plan", x: 10, y: 20, w: GRID.w, h: GRID.h });
  });

  it("gives unplaced items grid slots in key order, four to a row, and a placed item takes no slot", () => {
    const { boxes } = layout([env("d"), env("b", { placement: { x: 5, y: 5 } }), env("c"), env("a"), env("e"), env("f")]);
    const at = (key: string) => { const b = boxes.find((x) => x.key === key)!; return { x: b.x, y: b.y }; };
    expect(at("a")).toEqual(gridSlot(0));
    expect(at("c")).toEqual(gridSlot(1));
    expect(at("d")).toEqual(gridSlot(2));
    expect(at("e")).toEqual(gridSlot(3));
    expect(at("f")).toEqual({ x: 0, y: GRID.h + GRID.gap });
    expect(at("b")).toEqual({ x: 5, y: 5 });
  });

  it("sorts keys in code-unit order, never by locale", () => {
    // "Z" < "a" in code units; a locale sort puts "a" first.
    const { boxes } = layout([env("a_note"), env("Z_note")]);
    expect(boxes.map((b) => b.key)).toEqual(["Z_note", "a_note"]);
  });

  it("draws a connector only between two cards that exist, from centre to centre, and never from a card to itself", () => {
    const { lines } = layout(surfaceFixture().surface.items);
    expect(lines).toHaveLength(1);
    expect(lines[0].key).toBe("plan_to_spec");
    expect(lines[0].label).toBe("argues");
    expect(centerOf(lines[0].from)).toEqual({ x: 10 + GRID.w / 2, y: 20 + GRID.h / 2 });
    const dangling = layout([env("a"), env("c1", { kind: "connector", ends: { from: "a", to: "gone" } })]);
    expect(dangling.lines).toEqual([]);
    const loop = layout([env("a"), env("c2", { kind: "connector", ends: { from: "a", to: "a" } })]);
    expect(loop.lines).toEqual([]);
  });

  it("takes the default size for a placement whose w or h is 0, negative or not a number", () => {
    const { boxes } = layout([
      env("zero", { placement: { x: 0, y: 0, w: 0, h: 0 } }),
      env("neg", { placement: { x: 0, y: 0, w: -5, h: -5 } }),
      env("nan", { placement: { x: 0, y: 0, w: Number.NaN, h: Number.NaN } }),
    ]);
    for (const b of boxes) expect([b.w, b.h]).toEqual([GRID.w, GRID.h]);
  });
});

describe("fit and zoom", () => {
  const boxes: Box[] = [{ key: "a", x: 100, y: 100, w: 200, h: 100 }, { key: "b", x: 500, y: 300, w: 200, h: 100 }];

  it("fits every card with the margin at the largest scale at or below 1, centred", () => {
    // Content spans 100..700 by 100..400: 600 by 300, plus 2 margins each way.
    const t = fit(boxes, { w: 340, h: 1000 });
    expect(t.k).toBeCloseTo(340 / 680);
    expect(t.tx).toBeCloseTo((340 - 600 * t.k) / 2 - 100 * t.k);
    expect(t.ty).toBeCloseTo((1000 - 300 * t.k) / 2 - 100 * t.k);
    expect(fit(boxes, { w: 5000, h: 5000 }).k).toBe(1);
  });

  it("clamps the fitted scale, and anchors an unknown viewport at the margin with scale 1", () => {
    expect(fit(boxes, { w: 10, h: 10 }).k).toBe(ZOOM.min);
    expect(fit(boxes, { w: 0, h: 0 })).toEqual({ tx: FIT_MARGIN - 100, ty: FIT_MARGIN - 100, k: 1 });
    expect(fit([], { w: 800, h: 600 })).toEqual({ tx: 0, ty: 0, k: 1 });
  });

  it("zooms about a point, keeping the layer point under it fixed, within the clamp", () => {
    const t = { tx: 20, ty: 30, k: 1 };
    const z = zoomAbout(t, 2, { x: 120, y: 130 });
    // The layer point under (120,130) was (100,100); after the zoom it is still at (120,130).
    expect(z.k).toBe(2);
    expect(z.tx + 100 * z.k).toBeCloseTo(120);
    expect(z.ty + 100 * z.k).toBeCloseTo(130);
    expect(zoomAbout(t, 50, { x: 0, y: 0 }).k).toBe(ZOOM.max);
    expect(clampZoom(0.001)).toBe(ZOOM.min);
  });
});
