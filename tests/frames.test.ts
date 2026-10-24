import { describe, expect, it } from "vitest";
import {
  NEXT_ALONE, NEXT_FRAME_GONE, NEXT_REFUSAL, SURFACE_PAGE, WINDOW_REFUSAL_HTTP, WINDOW_REFUSAL_TOOL,
  frameEntries, frameNumbers, noSuchFrame, parseWindow, readWindow, windowName,
} from "../src/frames.js";
import type { SurfaceRow } from "../src/types.js";

const row = (key: string, over: Partial<SurfaceRow> = {}): SurfaceRow => ({
  key, kind: "text", title: null, body: "b", ends: null, placement: null, blob: null, shape: null,
  cursor: 1, at: 1_000, createdAt: 1_000, byMemberId: "m_a", byLabel: "a@x", ...over,
});
const frame = (key: string, placement: { x: number; y: number; w: number; h: number }, createdAt: number): SurfaceRow =>
  row(key, { kind: "frame", title: key.toUpperCase(), body: null, placement, createdAt, locked: true });
const at = (x: number, y: number) => ({ placement: { x, y } });
const page = (rows: SurfaceRow[], asked: Parameters<typeof readWindow>[1] = {}) => {
  const out = readWindow(rows, asked);
  if (!out.ok) throw new Error(out.reason);
  return out.page;
};
const keys = (p: { items: SurfaceRow[] }) => p.items.map((r) => r.key);

describe("the path (D3) and membership (D2)", () => {
  it("numbers frames by when their key was first written, ties by key, and counts the cards whose centre each holds", () => {
    const rows = [
      frame("b", { x: 0, y: 0, w: 1000, h: 600 }, 2_000),
      frame("a", { x: 2000, y: 0, w: 1000, h: 600 }, 2_000),
      frame("c", { x: 4000, y: 0, w: 1000, h: 600 }, 1_000),
      row("in-b", at(100, 100)),        // centre (260, 200)
      row("past-b", at(900, 100)),      // centre (1060, 200), right of b's edge at 1000
      row("unplaced"),
      row("line", { kind: "connector", body: null, ends: { from: "in-b", to: "unplaced" } }),
    ];
    expect(frameEntries(rows)).toEqual([
      { number: 1, key: "c", title: "C", placement: { x: 4000, y: 0, w: 1000, h: 600 }, locked: true, count: 0 },
      { number: 2, key: "a", title: "A", placement: { x: 2000, y: 0, w: 1000, h: 600 }, locked: true, count: 0 },
      { number: 3, key: "b", title: "B", placement: { x: 0, y: 0, w: 1000, h: 600 }, locked: true, count: 1 },
    ]);
    expect(Object.fromEntries(frameNumbers(rows))).toEqual({ a: 2, b: 3, c: 1, "in-b": 3, "past-b": null, unplaced: null, line: null });
  });

  // Review Focus 1.
  it("puts a card whose centre is on the edge two frames share in the right-hand frame only", () => {
    const rows = [frame("left", { x: 0, y: 0, w: 1000, h: 600 }, 1), frame("right", { x: 1000, y: 0, w: 1000, h: 600 }, 2), row("edge", at(840, 100))];
    expect(frameEntries(rows).map((f) => f.count)).toEqual([0, 1]);
    expect(keys(page(rows, { window: { kind: "frame", frame: 2 } }))).toEqual(["edge"]);
    expect(keys(page(rows, { window: { kind: "frame", frame: 1 } }))).toEqual([]);
  });

  it("closes the gap when a frame goes, and keeps a frame's number when it is edited", () => {
    const rows = [frame("a", { x: 0, y: 0, w: 500, h: 500 }, 1), frame("b", { x: 600, y: 0, w: 500, h: 500 }, 2), frame("c", { x: 1200, y: 0, w: 500, h: 500 }, 3)];
    expect(frameEntries(rows.filter((r) => r.key !== "b")).map((f) => [f.number, f.key])).toEqual([[1, "a"], [2, "c"]]);
    const edited = rows.map((r) => (r.key === "a" ? { ...r, title: "Renamed", cursor: 9, at: 9_000 } : r));
    expect(frameEntries(edited)[0]).toMatchObject({ number: 1, key: "a", title: "Renamed" });
  });
});

describe("the windows (D5)", () => {
  it("parses the tool's three windows and the HTTP's five, and refuses the rest", () => {
    expect(parseWindow("frame:12", "tool")).toEqual({ ok: true, window: { kind: "frame", frame: 12 } });
    expect(parseWindow("region:-10,0,800.5,600", "http")).toEqual({ ok: true, window: { kind: "region", x: -10, y: 0, w: 800.5, h: 600 } });
    expect(parseWindow("key:intro", "http")).toEqual({ ok: true, window: { kind: "key", key: "intro" } });
    for (const raw of ["frame:0", "frame:01", "frame:1.5", "frames", "region:0,0,800,600", "key:intro"]) {
      expect(parseWindow(raw, "tool")).toEqual({ ok: false, reason: WINDOW_REFUSAL_TOOL });
    }
    for (const raw of ["region:0,0,0,600", "region:0,0,800", "region:a,0,1,1", "key:Intro"]) {
      expect(parseWindow(raw, "http")).toEqual({ ok: false, reason: WINDOW_REFUSAL_HTTP });
    }
    expect(windowName({ kind: "region", x: -10, y: 0, w: 800.5, h: 600 })).toBe("region:-10,0,800.5,600");
  });

  // Review Focus 5.
  it("answers a frameless room of 64 items or fewer whole, newest first, its connectors after, with nothing to continue", () => {
    const rows = [row("old", { createdAt: 1 }), row("new", { createdAt: 3 }), row("mid", { createdAt: 2 }),
      row("line", { kind: "connector", body: null, ends: { from: "old", to: "new" } })];
    expect(page(rows)).toEqual({ window: "newest", items: [rows[1], rows[2], rows[0], rows[3]], next: null, frames: [] });
  });

  it("answers frame 1 as the front once the room has a frame, its items top to bottom, then left to right, then by key", () => {
    const rows = [frame("f", { x: 0, y: 0, w: 2000, h: 2000 }, 1),
      row("low", at(0, 600)), row("right", at(400, 40)), row("b-left", at(40, 40)), row("a-left", at(40, 40)), row("out", at(5000, 0))];
    expect(page(rows)).toMatchObject({ window: "frame:1", next: null });
    expect(keys(page(rows))).toEqual(["a-left", "b-left", "right", "low"]);
  });

  it("reads the unframed items newest first and every item but frames as newest, frames on frames[] alone", () => {
    const rows = [frame("f", { x: 0, y: 0, w: 1000, h: 1000 }, 1), row("in", { ...at(40, 40), createdAt: 5 }),
      row("out", { ...at(4000, 0), createdAt: 4 }), row("none", { createdAt: 6 })];
    expect(keys(page(rows, { window: { kind: "unframed" } }))).toEqual(["none", "out"]);
    expect(keys(page(rows, { window: { kind: "newest" } }))).toEqual(["none", "in", "out"]);
    expect(page(rows, { window: { kind: "newest" } }).frames.map((f) => f.key)).toEqual(["f"]);
  });

  it("pages at 64 and continues from the position, though a newer item lands between the reads", () => {
    const rows = Array.from({ length: 70 }, (_, i) => row(`c${String(i).padStart(2, "0")}`, { createdAt: i }));
    const first = page(rows, { window: { kind: "newest" } });
    expect([first.items.length, first.next === null]).toEqual([SURFACE_PAGE, false]);
    const later = [...rows, row("newer", { createdAt: 999 })];
    const second = page(later, { next: first.next! });
    expect([second.window, keys(second)]).toEqual(["newest", ["c05", "c04", "c03", "c02", "c01", "c00"]]);
    expect(second.next).toBeNull();
  });

  // Review Focus 2.
  it("keeps reading the same frame by its key when a frame ahead of it goes, and refuses once that frame is gone", () => {
    const members = Array.from({ length: 70 }, (_, i) => row(`m${String(i).padStart(2, "0")}`, at(40, 40 + i * 10)));
    const rows = [frame("a", { x: -5000, y: 0, w: 1000, h: 1000 }, 1), frame("b", { x: 0, y: 0, w: 4000, h: 4000 }, 2), ...members];
    const first = page(rows, { window: { kind: "frame", frame: 2 } });
    const second = page(rows.filter((r) => r.key !== "a"), { next: first.next! });
    expect([second.window, second.items.length]).toEqual(["frame:1", 6]);
    expect(readWindow(rows.filter((r) => r.key !== "b"), { next: first.next! })).toEqual({ ok: false, reason: NEXT_FRAME_GONE });
  });

  it("carries a connector with any item it joins on the page, outside the 64", () => {
    const rows = [...Array.from({ length: 64 }, (_, i) => row(`c${String(i).padStart(2, "0")}`, { createdAt: 100 + i })),
      row("line", { kind: "connector", body: null, ends: { from: "c63", to: "elsewhere" } })];
    const p = page(rows, { window: { kind: "newest" } });
    expect([p.items.length, p.items.at(-1)!.key, p.next]).toEqual([65, "line", null]);
  });

  it("reads a region by centres, placing a row with none at the slot viewers draw it in, and names those slots", () => {
    const rows = [row("b"), row("a"), row("far", at(5000, 5000)), row("near", at(400, 0)), frame("f", { x: 0, y: 0, w: 100, h: 100 }, 1)];
    // a and b have no placement: by key order, a is slot 0 (0,0) and b slot 1 (360,0).
    const p = page(rows, { window: { kind: "region", x: 0, y: 0, w: 800, h: 300 } });
    expect(keys(p)).toEqual(["a", "b", "near"]);
    expect(p.slots).toEqual({ a: { x: 0, y: 0 }, b: { x: 360, y: 0 } });
  });

  it("reads one key, a frame included, and refuses a frame that does not exist, a token it did not write, and next beside a window", () => {
    const rows = [frame("f", { x: 0, y: 0, w: 100, h: 100 }, 1), row("a")];
    expect(keys(page(rows, { window: { kind: "key", key: "f" } }))).toEqual(["f"]);
    expect(keys(page(rows, { window: { kind: "key", key: "zz" } }))).toEqual([]);
    expect(readWindow(rows, { window: { kind: "frame", frame: 3 } })).toEqual({ ok: false, reason: "frame 3 does not exist: this room has 1 frame" });
    expect(noSuchFrame(1, 0)).toBe("frame 1 does not exist: this room has no frames");
    expect(readWindow(rows, { next: "not-a-token" })).toEqual({ ok: false, reason: NEXT_REFUSAL });
    expect(readWindow(rows, { next: btoa(JSON.stringify(["frame", 5])) })).toEqual({ ok: false, reason: NEXT_REFUSAL });
    expect(readWindow(rows, { window: { kind: "newest" }, next: "x" })).toEqual({ ok: false, reason: NEXT_ALONE });
  });
});
