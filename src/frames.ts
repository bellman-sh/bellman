/**
 * Frames on the surface (docs/superpowers/specs/2026-10-23-surface-frames-design.md): the one place frames are
 * ranked into a path, a card is assigned to the frame holding it, and every window of the surface is paged.
 *
 * Runtime-free, like `surface.ts`: it takes rows and returns pages, never a store, so the in-memory store and
 * the room's Durable Object call the same functions from inside the store, and the HTTP routes can import the
 * grammar. Nothing here is stored. A frame's number is its rank among the frames on every call, and a card's
 * frame is decided by where its centre sits on every call.
 */
import { GRID, SurfaceKeyShape, coveredBoxes, createdAtOf, overlaps, withPlacement, type Box, type SurfaceWrite } from "./surface.js";
import type { SurfaceItem, SurfaceRow } from "./types.js";

/** At most this many frames on one surface (D2). */
export const MAX_FRAMES = 100;
/** Items on one page of a window (D5): a read is at most this many ranked items, then the connectors joining them. */
export const SURFACE_PAGE = 64;

export interface FrameEntry {
  number: number;
  key: string;
  title: string;
  placement: { x: number; y: number; w: number; h: number };
  locked: boolean;
  count: number;
}

export type Window =
  | { kind: "newest" }
  | { kind: "unframed" }
  | { kind: "frame"; frame: number }
  | { kind: "key"; key: string }
  | { kind: "region"; x: number; y: number; w: number; h: number };

export const WINDOW_REFUSAL_TOOL = "window must be newest, unframed or frame:<n>, n a whole number from 1";
export const WINDOW_REFUSAL_HTTP =
  "window must be newest, unframed, frame:<n> (n a whole number from 1), key:<key> or region:<x>,<y>,<w>,<h> (w and h above 0)";
export const NEXT_ALONE = "next carries its window: send next without window";
export const NEXT_REFUSAL = "next is not a continuation this server wrote: read the window again without it";
export const NEXT_FRAME_GONE = "the frame next was reading is no longer on the surface: read frames[] and choose again";
export const QUERY_WITH_WINDOW = "query searches the whole surface: send it without window or next";

export const noSuchFrame = (n: number, count: number): string =>
  `frame ${n} does not exist: this room has ${count === 0 ? "no frames" : count === 1 ? "1 frame" : `${count} frames`}`;

const WHOLE_FROM_ONE = /^[1-9][0-9]*$/;
const NUMBER = /^-?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:e[+-]?[0-9]+)?$/i;

/** `raw` as a window. The tool offers newest, unframed and frame:<n>; the HTTP reads add key: and region:. */
export function parseWindow(raw: string, offered: "tool" | "http"): { ok: true; window: Window } | { ok: false; reason: string } {
  const refuse = { ok: false, reason: offered === "tool" ? WINDOW_REFUSAL_TOOL : WINDOW_REFUSAL_HTTP } as const;
  if (raw === "newest") return { ok: true, window: { kind: "newest" } };
  if (raw === "unframed") return { ok: true, window: { kind: "unframed" } };
  if (raw.startsWith("frame:")) {
    const n = raw.slice("frame:".length);
    return WHOLE_FROM_ONE.test(n) && Number.isSafeInteger(Number(n)) ? { ok: true, window: { kind: "frame", frame: Number(n) } } : refuse;
  }
  if (offered === "http" && raw.startsWith("key:")) {
    const key = raw.slice("key:".length);
    return SurfaceKeyShape.safeParse(key).success ? { ok: true, window: { kind: "key", key } } : refuse;
  }
  if (offered === "http" && raw.startsWith("region:")) {
    const parts = raw.slice("region:".length).split(",");
    if (parts.length !== 4 || !parts.every((p) => NUMBER.test(p))) return refuse;
    const [x, y, w, h] = parts.map(Number);
    return [x, y, w, h].every(Number.isFinite) && w > 0 && h > 0 ? { ok: true, window: { kind: "region", x, y, w, h } } : refuse;
  }
  return refuse;
}

/** The canonical name of a window: what `parseWindow` reads back, and what a page says it answers. */
export function windowName(w: Window): string {
  switch (w.kind) {
    case "newest": case "unframed": return w.kind;
    case "frame": return `frame:${w.frame}`;
    case "key": return `key:${w.key}`;
    case "region": return `region:${w.x},${w.y},${w.w},${w.h}`;
  }
}

/** Code-unit order, which is `<` on strings and not a locale's. */
const cmp = (a: string | number, b: string | number): number => (a < b ? -1 : a > b ? 1 : 0);

/** The frames in path order (R6): by when each key was first written, ties by key. */
export function rankFrames(rows: readonly SurfaceRow[]): SurfaceRow[] {
  return rows.filter((r) => r.kind === "frame").sort((a, b) => cmp(createdAtOf(a), createdAtOf(b)) || cmp(a.key, b.key));
}

interface Rect { x: number; y: number; w: number; h: number }

const boxOf = (r: SurfaceRow, at: { x: number; y: number }): Rect => ({
  x: at.x, y: at.y, w: r.placement?.w ?? GRID.w, h: r.placement?.h ?? GRID.h,
});

/** Half-open, so a centre on an edge two touching rectangles share belongs to the right or lower one only. */
const holds = (rect: Rect, cx: number, cy: number): boolean =>
  rect.x <= cx && cx < rect.x + rect.w && rect.y <= cy && cy < rect.y + rect.h;

const frameRect = (f: SurfaceRow): Rect => ({
  x: f.placement?.x ?? 0, y: f.placement?.y ?? 0, w: f.placement?.w ?? GRID.w, h: f.placement?.h ?? GRID.h,
});

/** The frame number each row sits in: frames ranked, a placed card matched by its centre, the rest null. */
function membership(rows: readonly SurfaceRow[]): { frames: SurfaceRow[]; of: Map<string, number | null> } {
  const frames = rankFrames(rows);
  const rects = frames.map(frameRect);
  const of = new Map<string, number | null>();
  for (const r of rows) {
    let found: number | null = null;
    if (r.kind === "frame") found = frames.indexOf(r) + 1;
    else if (r.kind !== "connector" && r.placement !== null) {
      const b = boxOf(r, r.placement);
      const i = rects.findIndex((rect) => holds(rect, b.x + b.w / 2, b.y + b.h / 2));
      if (i >= 0) found = i + 1;
    }
    of.set(r.key, found);
  }
  return { frames, of };
}

export function frameEntries(rows: readonly SurfaceRow[]): FrameEntry[] {
  const { frames, of } = membership(rows);
  const counts = new Map<number, number>();
  for (const r of rows) {
    const n = of.get(r.key);
    if (r.kind !== "frame" && n != null) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return frames.map((f, i) => ({
    number: i + 1, key: f.key, title: f.title ?? "", placement: frameRect(f), locked: f.locked ?? true, count: counts.get(i + 1) ?? 0,
  }));
}

/**
 * A frame entry as every read carries it: inside the untrusted envelope of the member who wrote the frame row,
 * the shape `untrusted` in projections.ts builds and `surfaceItem` wraps an item in. A title is a peer's prose.
 */
export interface FrameEnvelope {
  trust: "untrusted";
  origin: { memberId: string; label: string };
  data: FrameEntry;
}

/** `frameEntries`, each in its frame row's writer's envelope. */
export function frameEnvelopes(rows: readonly SurfaceRow[]): FrameEnvelope[] {
  const frames = rankFrames(rows);
  return frameEntries(rows).map((data, i) => ({
    trust: "untrusted", origin: { memberId: frames[i].byMemberId, label: frames[i].byLabel }, data,
  }));
}

/** Every key's frame number; a frame is its own number (R18), a row in no frame null. */
export function frameNumbers(rows: readonly SurfaceRow[]): Map<string, number | null> {
  return membership(rows).of;
}

/**
 * Where the viewers draw each row that has no placement: `toFlow`'s grid, one slot per such row in key order,
 * connectors not counted (R13).
 */
export function unplacedSlots(rows: readonly SurfaceRow[]): Map<string, { x: number; y: number }> {
  const bare = rows.filter((r) => r.kind !== "connector" && r.placement === null).map((r) => r.key).sort(cmp);
  return new Map(bare.map((key, i) => [key, { x: (i % GRID.cols) * (GRID.w + GRID.gap), y: Math.floor(i / GRID.cols) * (GRID.h + GRID.gap) }]));
}

export interface WindowPage {
  window: string;
  items: SurfaceRow[];
  next: string | null;
  frames: FrameEnvelope[];
  /** A region's alone: the slot of each row on the page that has no placement. */
  slots?: Record<string, { x: number; y: number }>;
}

type Pos = (string | number)[];

const b64 = (s: string): string => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s: string): string => {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  return atob(std + "=".repeat((4 - (std.length % 4)) % 4));
};

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";

type Token =
  | { kind: "newest" | "unframed"; pos: Pos }
  | { kind: "frame"; frameKey: string; pos: Pos }
  | { kind: "region"; rect: Rect; pos: Pos };

/** A decoded token is checked element by element; anything that is not one of the four shapes this module writes is null. */
function readToken(raw: string): Token | null {
  let v: unknown;
  try { v = JSON.parse(unb64(raw)); } catch { return null; }
  if (!Array.isArray(v)) return null;
  if ((v[0] === "newest" || v[0] === "unframed") && v.length === 3 && isNum(v[1]) && isStr(v[2])) {
    return { kind: v[0], pos: [-v[1], v[2]] };
  }
  if (v[0] === "frame" && v.length === 5 && isStr(v[1]) && isNum(v[2]) && isNum(v[3]) && isStr(v[4])) {
    return { kind: "frame", frameKey: v[1], pos: [v[2], v[3], v[4]] };
  }
  if (v[0] === "region" && v.length === 8 && v.slice(1, 7).every(isNum) && isStr(v[7]) && v[3] > 0 && v[4] > 0) {
    return { kind: "region", rect: { x: v[1], y: v[2], w: v[3], h: v[4] }, pos: [v[5], v[6], v[7]] };
  }
  return null;
}

const after = (a: Pos, b: Pos): boolean => {
  for (let i = 0; i < a.length; i++) {
    const c = cmp(a[i], b[i]);
    if (c !== 0) return c > 0;
  }
  return false;
};

interface Ranked { row: SurfaceRow; pos: Pos }

/** The newest-first order: newest created, ties by key. The position negates the date so one comparison serves every window. */
const byAge = (rows: SurfaceRow[]): Ranked[] => rows.map((row) => ({ row, pos: [-createdAtOf(row), row.key] }));
/** The canvas order: top edge, left edge, key. */
const byCanvas = (rows: SurfaceRow[], at: (r: SurfaceRow) => { x: number; y: number }): Ranked[] =>
  rows.map((row) => ({ row, pos: [at(row).y, at(row).x, row.key] }));
const sorted = (all: Ranked[]): Ranked[] => all.sort((a, b) => (after(a.pos, b.pos) ? 1 : after(b.pos, a.pos) ? -1 : 0));

/** The token for the last item of a page: what `readToken` takes back. */
const tokenOf = (kind: "newest" | "unframed" | "frame" | "region", last: Ranked, extra: { frameKey?: string; rect?: Rect }): string => {
  switch (kind) {
    case "newest": case "unframed": return b64(JSON.stringify([kind, -(last.pos[0] as number), last.pos[1]]));
    case "frame": return b64(JSON.stringify(["frame", extra.frameKey, ...last.pos]));
    case "region": { const r = extra.rect!; return b64(JSON.stringify(["region", r.x, r.y, r.w, r.h, ...last.pos])); }
  }
};

/**
 * One page of a window over the rows a member may see, in any order. With neither `window` nor `next` it is the
 * front: frame 1 when the room has a frame, else the newest. `next` carries its window, so both is refused.
 * The page holds at most `SURFACE_PAGE` ranked items, then every connector with an end among them.
 */
// ponytail: ranks every row on every read, O(n log n) over the 1,000 the surface can hold, which the room's
// object does in well under a millisecond; a read that took more would want an index kept beside the rows.
export function readWindow(
  rows: readonly SurfaceRow[],
  asked: { window?: Window; next?: string },
): { ok: true; page: WindowPage } | { ok: false; reason: string } {
  if (asked.window !== undefined && asked.next !== undefined) return { ok: false, reason: NEXT_ALONE };
  const { frames, of } = membership(rows);
  const entries = frameEnvelopes(rows);

  let window: Window;
  let from: Pos | null = null;
  let frameKey: string | undefined;
  if (asked.next !== undefined) {
    const t = readToken(asked.next);
    if (t === null) return { ok: false, reason: NEXT_REFUSAL };
    from = t.pos;
    if (t.kind === "frame") {
      const i = frames.findIndex((f) => f.key === t.frameKey);
      if (i < 0) return { ok: false, reason: NEXT_FRAME_GONE };
      frameKey = t.frameKey;
      window = { kind: "frame", frame: i + 1 };
    } else if (t.kind === "region") window = { kind: "region", ...t.rect };
    else window = { kind: t.kind };
  } else window = asked.window ?? (frames.length > 0 ? { kind: "frame", frame: 1 } : { kind: "newest" });

  const ranked = (r: SurfaceRow) => r.kind !== "frame" && r.kind !== "connector";
  let all: Ranked[];
  let slots: Record<string, { x: number; y: number }> | undefined;
  switch (window.kind) {
    case "key": {
      const one = rows.find((r) => r.key === window.key);
      return { ok: true, page: { window: windowName(window), items: one ? [one] : [], next: null, frames: entries } };
    }
    case "frame": {
      if (window.frame > frames.length) return { ok: false, reason: noSuchFrame(window.frame, frames.length) };
      const corner = frameRect(frames[window.frame - 1]);
      frameKey = frames[window.frame - 1].key;
      // From the frame's corner, so a locked move between two pages leaves the token's position where it was.
      all = byCanvas(rows.filter((r) => ranked(r) && of.get(r.key) === window.frame), (r) => ({
        x: r.placement!.x - corner.x, y: r.placement!.y - corner.y,
      }));
      break;
    }
    case "unframed": all = byAge(rows.filter((r) => ranked(r) && of.get(r.key) === null)); break;
    case "newest": all = byAge(rows.filter(ranked)); break;
    case "region": {
      const bare = unplacedSlots(rows);
      const at = (r: SurfaceRow) => r.placement ?? bare.get(r.key)!;
      const rect = window;
      all = byCanvas(rows.filter((r) => {
        if (!ranked(r)) return false;
        const b = boxOf(r, at(r));
        return holds(rect, b.x + b.w / 2, b.y + b.h / 2);
      }), at);
      slots = {};
      for (const { row } of all) if (row.placement === null) slots[row.key] = bare.get(row.key)!;
      break;
    }
  }
  sorted(all);
  const start = from === null ? 0 : all.findIndex((c) => after(c.pos, from));
  const rest = start < 0 ? [] : all.slice(start);
  const taken = rest.slice(0, SURFACE_PAGE);
  const more = rest.length > taken.length;

  const onPage = new Set(taken.map((c) => c.row.key));
  const joins = rows
    .filter((r) => r.kind === "connector" && r.ends !== null && (onPage.has(r.ends.from) || onPage.has(r.ends.to)))
    .sort((a, b) => cmp(a.key, b.key));
  if (slots !== undefined) for (const k of Object.keys(slots)) if (!onPage.has(k)) delete slots[k];

  return {
    ok: true,
    page: {
      window: windowName(window),
      items: [...taken.map((c) => c.row), ...joins],
      next: more ? tokenOf(window.kind, taken[taken.length - 1], { frameKey, rect: window.kind === "region" ? window : undefined }) : null,
      frames: entries,
      ...(slots === undefined ? {} : { slots }),
    },
  };
}

/** What a store says when a frame-shaped write reaches a path that cannot place it among frames. */
export const FRAME_WRITE_PATH = "a frame write, or a write into a frame, goes through appendSurface";

/** A write the room must place among frames: a frame itself, or a card that names the frame it goes in. */
export const isFrameWrite = (write: SurfaceWrite): boolean => write.item?.kind === "frame" || write.frame !== undefined;

/**
 * Slot `index` inside `frame` (R5): left to right and then down, the grid's cells inset by its gap on every
 * side. Null past the last slot, and for a frame too small to hold one card.
 */
export function frameSlot(frame: Box, index: number): { x: number; y: number } | null {
  const cols = Math.floor((frame.w - GRID.gap) / (GRID.w + GRID.gap));
  const rows = Math.floor((frame.h - GRID.gap) / (GRID.h + GRID.gap));
  if (index < 0 || index >= cols * rows) return null;
  return {
    x: frame.x + GRID.gap + (index % cols) * (GRID.w + GRID.gap),
    y: frame.y + GRID.gap + Math.floor(index / cols) * (GRID.h + GRID.gap),
  };
}

/**
 * A refusal carries its kind: `invalid` for a frame that does not exist, which is the writer's mistake; `conflict`
 * for an overlap, a full frame and a frame written into a frame, which are the room's state meeting the write.
 */
export type Placed =
  | { ok: true; write: SurfaceWrite; carried: SurfaceWrite[] }
  | { ok: false; kind: "conflict" | "invalid"; reason: string };

/** The row as the item that wrote it: the authorship the store stamps stays off, so the store keeps the row's own. */
function itemOf(r: SurfaceRow, placement: NonNullable<SurfaceRow["placement"]>): SurfaceItem {
  const { cursor: _c, at: _a, createdAt: _t, byMemberId: _m, byLabel: _l, approvedBy: _p, ...item } = r;
  return { ...item, placement };
}

/**
 * The write as the room stores it, with the writes it carries (R4, R7, R8). A frame may not overlap another
 * (edges may touch); a locked frame that moves carries the cards whose centre it held by the corner's change;
 * a card naming frame N goes in that frame's first free slot, or stays where it already sits inside it. Any
 * other write is `withPlacement`'s. The answer's write never carries `frame`.
 */
export function placeSurfaceWrite(rows: readonly SurfaceRow[], write: SurfaceWrite): Placed {
  const { item } = write;
  if (!isFrameWrite(write) || item === null) return { ok: true, write: withPlacement(rows, { key: write.key, item }), carried: [] };
  const frames = rankFrames(rows);

  if (item.kind === "frame") {
    const to = item.placement;
    if (to === null) return { ok: true, write: { key: write.key, item }, carried: [] };
    const mine: Box = { x: to.x, y: to.y, w: to.w ?? GRID.w, h: to.h ?? GRID.h };
    const hit = frames.findIndex((f) => f.key !== write.key && overlaps(mine, frameRect(f)));
    if (hit >= 0) {
      return {
        ok: false, kind: "conflict",
        reason: `surface frame "${write.key}" would overlap frame ${hit + 1} ("${frames[hit].key}"): frames may touch but not overlap`,
      };
    }
    const was = frames.find((f) => f.key === write.key);
    const dx = to.x - (was?.placement?.x ?? to.x);
    const dy = to.y - (was?.placement?.y ?? to.y);
    const carried: SurfaceWrite[] = [];
    if (was !== undefined && item.locked !== false && (dx !== 0 || dy !== 0)) {
      const number = frames.indexOf(was) + 1;
      const { of } = membership(rows);
      for (const r of rows) {
        if (r.kind === "frame" || r.placement === null || of.get(r.key) !== number) continue;
        carried.push({ key: r.key, item: itemOf(r, { ...r.placement, x: r.placement.x + dx, y: r.placement.y + dy }) });
      }
      carried.sort((a, b) => cmp(a.key, b.key));
    }
    return { ok: true, write: { key: write.key, item }, carried };
  }

  const n = write.frame!;
  const label = `surface ${item.kind} "${write.key}": `;
  if (n > frames.length) return { ok: false, kind: "invalid", reason: label + noSuchFrame(n, frames.length) };
  const stored = rows.find((r) => r.key === write.key);
  // A frame is its own frame (R18), so the branch below would keep its rectangle on a card and the frame would go.
  if (stored?.kind === "frame") {
    return { ok: false, kind: "conflict", reason: `${label}a frame cannot be written into a frame: write it with its own placement` };
  }
  if (stored?.placement && membership(rows).of.get(write.key) === n) {
    return { ok: true, write: { key: write.key, item: { ...item, placement: { ...stored.placement } } }, carried: [] };
  }
  const target = frames[n - 1];
  const covered = coveredBoxes(rows.filter((r) => r.kind !== "frame"), write.key);
  const box = frameRect(target);
  for (let i = 0; ; i++) {
    const at = frameSlot(box, i);
    if (at === null) {
      return {
        ok: false, kind: "conflict",
        reason: `${label}frame ${n} ("${target.key}") has no free slot for a ${GRID.w} by ${GRID.h} card: place it with placement { x, y }, or make the frame larger`,
      };
    }
    if (!covered.some((b) => overlaps(b, { ...at, w: GRID.w, h: GRID.h }))) {
      return { ok: true, write: { key: write.key, item: { ...item, placement: at } }, carried: [] };
    }
  }
}
