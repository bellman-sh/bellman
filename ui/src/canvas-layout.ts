/**
 * The canvas's rules (canvas spec D5, D6), pure: no DOM. The grid and the sort
 * are dash's (`src/lib/canvas.ts` there), so a room looks the same on both
 * surfaces; fit and zoom are the arithmetic the screen applies as a transform.
 */
import type { SurfaceItemWire, Untrusted } from "./types.js";

// ponytail: a four-column grid of fixed cells for items nobody has placed; dash
// writes a real placement on the first drag and the grid forgets the item.
export const GRID = { cols: 4, w: 320, h: 200, gap: 40 } as const;
export const ZOOM = { min: 0.1, max: 2 } as const;
export const FIT_MARGIN = 40;

export interface Box { key: string; x: number; y: number; w: number; h: number }
export interface Line { key: string; from: Box; to: Box; label: string | null }
export interface Transform { tx: number; ty: number; k: number }

export const gridSlot = (index: number): { x: number; y: number } => ({
  x: (index % GRID.cols) * (GRID.w + GRID.gap),
  y: Math.floor(index / GRID.cols) * (GRID.h + GRID.gap),
});

/** Code-unit order, not `localeCompare`: every viewer must derive the same grid (dash's rule). */
const keyOrder = (a: Untrusted<SurfaceItemWire>, b: Untrusted<SurfaceItemWire>): number =>
  a.data.key < b.data.key ? -1 : a.data.key > b.data.key ? 1 : 0;

/** A size the server would have accepted: a finite positive number; anything else is the default. */
const sizeOr = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

/**
 * Items to cards and lines. Sorted by key; a card at its placement, else the
 * next grid slot; a line only between two cards that exist and differ.
 */
export function layout(items: readonly Untrusted<SurfaceItemWire>[]): { boxes: Box[]; lines: Line[] } {
  const sorted = [...items].sort(keyOrder);
  const boxes: Box[] = [];
  let unplaced = 0;
  for (const e of sorted) {
    if (e.data.kind === "connector") continue;
    const p = e.data.placement;
    const at = p ?? gridSlot(unplaced++);
    boxes.push({ key: e.data.key, x: at.x, y: at.y, w: sizeOr(p?.w, GRID.w), h: sizeOr(p?.h, GRID.h) });
  }
  const byKey = new Map(boxes.map((b) => [b.key, b] as const));
  const lines: Line[] = [];
  for (const e of sorted) {
    if (e.data.kind !== "connector" || e.data.ends === null) continue;
    const from = byKey.get(e.data.ends.from);
    const to = byKey.get(e.data.ends.to);
    if (!from || !to || from === to) continue;
    lines.push({ key: e.data.key, from, to, label: e.data.title });
  }
  return { boxes, lines };
}

export const centerOf = (b: Box): { x: number; y: number } => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

export const clampZoom = (k: number): number => Math.min(ZOOM.max, Math.max(ZOOM.min, k));

/**
 * Every card with the margin, at the largest scale at or below 1, centred. A
 * viewport with no size (jsdom, or a frame not laid out yet) anchors the
 * content at the margin instead; an empty surface is the identity.
 */
export function fit(boxes: readonly Box[], viewport: { w: number; h: number }): Transform {
  if (boxes.length === 0) return { tx: 0, ty: 0, k: 1 };
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  if (viewport.w <= 0 || viewport.h <= 0) return { tx: FIT_MARGIN - x0, ty: FIT_MARGIN - y0, k: 1 };
  const k = clampZoom(Math.min(1, viewport.w / (x1 - x0 + 2 * FIT_MARGIN), viewport.h / (y1 - y0 + 2 * FIT_MARGIN)));
  return {
    k,
    tx: (viewport.w - (x1 - x0) * k) / 2 - x0 * k,
    ty: (viewport.h - (y1 - y0) * k) / 2 - y0 * k,
  };
}

/** A new scale with the layer point under `at` (viewport coordinates) staying under it. */
export function zoomAbout(t: Transform, k: number, at: { x: number; y: number }): Transform {
  const next = clampZoom(k);
  const lx = (at.x - t.tx) / t.k;
  const ly = (at.y - t.ty) / t.k;
  return { k: next, tx: at.x - lx * next, ty: at.y - ly * next };
}
