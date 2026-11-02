/** Room files (ADR 0046): the pure planning of each op, and the byte charge. */
import { describe, expect, it } from "vitest";
import { decideFsCharge, diffText, FS_FILE_MAX_BYTES, planWrite, utf8Bytes } from "../src/fs.js";
import type { FsRow } from "../src/types.js";

const row = (content: string, rev = 1, deleted = false): FsRow => ({
  path: "/plans/launch.md", rev, content, size: utf8Bytes(content), writerMemberId: "m_a", writerLabel: "a", at: 1, deleted,
});

describe("planWrite", () => {
  it("creates a file only without base_rev, and refuses that on an existing path as stale", () => {
    expect(planWrite(null, { op: "write", content: "x" })).toEqual({ ok: true, rev: 1, content: "x", deleted: false });
    expect(planWrite(row("old", 3), { op: "write", content: "x" })).toEqual({ ok: false, reason: "stale", currentRev: 3, content: "old" });
  });

  it("refuses a base_rev that is not the current revision, carrying the current content", () => {
    expect(planWrite(row("v2", 2), { op: "write", content: "x", baseRev: 1 })).toEqual({ ok: false, reason: "stale", currentRev: 2, content: "v2" });
    expect(planWrite(null, { op: "write", content: "x", baseRev: 1 })).toEqual({ ok: false, reason: "stale", currentRev: 0, content: "" });
    expect(planWrite(row("v2", 2), { op: "write", content: "x", baseRev: 2 })).toMatchObject({ ok: true, rev: 3, content: "x" });
  });

  it("edits exactly one match of old, and refuses none or several", () => {
    expect(planWrite(row("a b c"), { op: "edit", old: "b", new: "B", baseRev: 1 })).toMatchObject({ ok: true, content: "a B c", rev: 2 });
    expect(planWrite(row("a b c"), { op: "edit", old: "z", new: "B", baseRev: 1 })).toMatchObject({ ok: false, reason: "invalid" });
    expect(planWrite(row("b b"), { op: "edit", old: "b", new: "B", baseRev: 1 })).toMatchObject({ ok: false, reason: "invalid" });
    expect(planWrite(row("bbb"), { op: "edit", old: "bb", new: "B", baseRev: 1 }), "overlapping matches count").toMatchObject({ ok: false, reason: "invalid" });
    expect(planWrite(row("a"), { op: "edit", old: "", new: "B", baseRev: 1 })).toMatchObject({ ok: false, reason: "invalid" });
    expect(planWrite(null, { op: "edit", old: "a", new: "B" })).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("appends, and creates by appending to nothing", () => {
    expect(planWrite(row("a"), { op: "append", content: "b", baseRev: 1 })).toMatchObject({ ok: true, content: "ab", rev: 2 });
    expect(planWrite(null, { op: "append", content: "b" })).toMatchObject({ ok: true, content: "b", rev: 1 });
  });

  it("deletes to a tombstone that keeps the revision count, and writes again on top of it", () => {
    expect(planWrite(row("a", 4), { op: "delete", baseRev: 4 })).toEqual({ ok: true, rev: 5, content: "", deleted: true });
    expect(planWrite(row("", 5, true), { op: "delete", baseRev: 5 })).toMatchObject({ ok: false, reason: "invalid" });
    expect(planWrite(row("", 5, true), { op: "write", content: "x" }), "a deleted path is creatable").toMatchObject({ ok: true, rev: 6 });
    expect(planWrite(row("", 5, true), { op: "edit", old: "a", new: "b", baseRev: 5 })).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("restores an old revision's content as a new revision", () => {
    expect(planWrite(row("v3", 3), { op: "restore", content: "v1", baseRev: 3 })).toEqual({ ok: true, rev: 4, content: "v1", deleted: false });
  });

  it("refuses content past 64 KiB, counted in UTF-8 bytes", () => {
    expect(planWrite(null, { op: "write", content: "a".repeat(FS_FILE_MAX_BYTES) })).toMatchObject({ ok: true });
    expect(planWrite(null, { op: "write", content: "a".repeat(FS_FILE_MAX_BYTES + 1) })).toEqual({ ok: false, reason: "too_large" });
    expect(planWrite(null, { op: "write", content: "é".repeat(FS_FILE_MAX_BYTES / 2 + 1) })).toEqual({ ok: false, reason: "too_large" });
    expect(planWrite(row("a".repeat(FS_FILE_MAX_BYTES)), { op: "append", content: "b", baseRev: 1 })).toEqual({ ok: false, reason: "too_large" });
  });
});

describe("decideFsCharge", () => {
  const s = { frozenAt: null, fsBytes: 900, fsBytesCeiling: 1000 };
  it("charges up to the ceiling and refuses past it", () => {
    expect(decideFsCharge(s, false, 100)).toEqual({ ok: true, next: 1000 });
    expect(decideFsCharge(s, false, 101)).toEqual({ ok: false, reason: "over_quota", used: 900, ceiling: 1000 });
  });
  it("always passes a negative delta, never below zero", () => {
    expect(decideFsCharge({ ...s, fsBytes: 2000 }, false, -500)).toEqual({ ok: true, next: 1500 });
    expect(decideFsCharge(s, false, -5000)).toEqual({ ok: true, next: 0 });
  });
  it("refuses a closed or frozen room first", () => {
    expect(decideFsCharge(s, true, -1)).toMatchObject({ ok: false, reason: "closed" });
    expect(decideFsCharge({ ...s, frozenAt: 1 }, false, 1)).toMatchObject({ ok: false, reason: "frozen" });
  });
  it("reads an absent fsBytes as 0", () => {
    expect(decideFsCharge({ frozenAt: null, fsBytesCeiling: 10 }, false, 10)).toEqual({ ok: true, next: 10 });
  });
});

describe("diffText", () => {
  it("writes a unified diff with three lines of context", () => {
    const a = "1\n2\n3\n4\n5\n6\n7\n8\n9\n";
    const { diff, truncated } = diffText(a, a.replace("5", "five"))!;
    expect(truncated).toBe(false);
    expect(diff).toContain("-5\n+five");
    expect(diff).toContain(" 2\n 3\n 4\n");
    expect(diff).not.toContain(" 1\n");
  });
  it("gives up on two revisions too different to diff cheaply, rather than spend the CPU", () => {
    const a = Array.from({ length: 30_000 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 30_000 }, (_, i) => `b${i}`).join("\n");
    const started = Date.now();
    expect(diffText(a, b)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
  it("cuts at 64 KiB and says so", () => {
    // 1,200 changed lines, under the edit bound, and about 73 KB of output.
    const { diff, truncated } = diffText("a".repeat(60).concat("\n").repeat(600), "b".repeat(60).concat("\n").repeat(600))!;
    expect(truncated).toBe(true);
    expect(utf8Bytes(diff)).toBeLessThanOrEqual(FS_FILE_MAX_BYTES);
  });
});
