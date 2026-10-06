/**
 * The pure rules of the working surface (#129): the key grammar, the monotonic
 * write rule both stores apply, and the accessor over the record's cursor. The
 * stores and the tools are tested elsewhere; this is the part that must agree
 * everywhere, so it is tested once, directly.
 */
import { describe, it, expect } from "vitest";
import {
  MAX_SURFACE_ITEMS, SurfaceKeyShape, applySurfaceWrite, surfaceCursor,
} from "../src/surface.js";
import type { SessionEvent, SurfaceItem, SurfaceRow } from "../src/types.js";
import { session } from "./helpers/fixtures.js";

const item = (over: Partial<SurfaceItem> = {}): SurfaceItem => ({
  key: "plan", kind: "text", title: "Plan", body: "1. read\n2. write", ends: null, placement: null, ...over,
});

const event = (cursor: number): SessionEvent => ({
  cursor, type: "surface", fromMemberId: "m_creator", fromUserId: "u_jesse",
  fromLabel: "jesse@codenerd", payload: {}, refId: null, at: 1_700_000_000_000 + cursor,
});

describe("surface keys", () => {
  it.each(["plan", "a", "open_questions", "pr_123", "x".repeat(31)])("accepts %s", (key) => {
    expect(SurfaceKeyShape.safeParse(key).success).toBe(true);
  });

  // Review Focus 3: case and whitespace. `Plan` must not shadow `plan`.
  it.each(["", "Plan", "plan ", " plan", "1st", "a-b", "x".repeat(32), "__proto__", "constructor", "prototype"])(
    "refuses %j", (key) => {
      expect(SurfaceKeyShape.safeParse(key).success).toBe(false);
    },
  );

  it("names surface keys in its message, not role keys", () => {
    const verdict = SurfaceKeyShape.safeParse("__proto__");
    expect(verdict.success).toBe(false);
    if (!verdict.success) expect(verdict.error.issues[0].message).toMatch(/^surface keys/);
  });
});

describe("applySurfaceWrite", () => {
  it("writes a row from the item and the event that carried it", () => {
    const row = applySurfaceWrite(undefined, event(5), { key: "plan", item: item() });
    expect(row).toEqual({
      ...item(), cursor: 5, at: event(5).at, byMemberId: "m_creator", byLabel: "jesse@codenerd",
    });
  });

  it("replaces a row with a newer write", () => {
    const first = applySurfaceWrite(undefined, event(5), { key: "plan", item: item() }) as SurfaceRow;
    const next = applySurfaceWrite(first, event(9), { key: "plan", item: item({ body: "revised" }) });
    expect(next).toMatchObject({ body: "revised", cursor: 9 });
  });

  // D6: a replay carries the ORIGINAL event, whose cursor is at or behind the row's.
  it("ignores a write whose cursor is not newer than the row's", () => {
    const row = applySurfaceWrite(undefined, event(9), { key: "plan", item: item() }) as SurfaceRow;
    expect(applySurfaceWrite(row, event(9), { key: "plan", item: item({ body: "same" }) })).toBeNull();
    expect(applySurfaceWrite(row, event(4), { key: "plan", item: item({ body: "older" }) })).toBeNull();
  });

  it("removes under the same rule", () => {
    const row = applySurfaceWrite(undefined, event(5), { key: "plan", item: item() }) as SurfaceRow;
    expect(applySurfaceWrite(row, event(6), { key: "plan", item: null })).toBe("remove");
    expect(applySurfaceWrite(row, event(4), { key: "plan", item: null })).toBeNull();
  });

  it("treats removing nothing as no change", () => {
    expect(applySurfaceWrite(undefined, event(6), { key: "plan", item: null })).toBeNull();
  });
});

describe("surfaceCursor", () => {
  it("reads 0 off a record that never had one, and the number off one that does", () => {
    const { events: _events, ...rest } = session();
    expect(surfaceCursor(rest)).toBe(0);
    expect(surfaceCursor({ ...rest, surfaceCursor: 12 })).toBe(12);
  });
});

describe("the bounds", () => {
  it("cap items at 64", () => {
    expect(MAX_SURFACE_ITEMS).toBe(64);
  });
});
