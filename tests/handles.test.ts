import { describe, expect, it } from "vitest";
import { checkHandle } from "../src/handles.js";

describe("checkHandle", () => {
  it("trims and lowercases what it is given", () => {
    expect(checkHandle("  Ada-Lovelace ")).toEqual({ ok: true, handle: "ada-lovelace" });
  });

  it("refuses a handle outside the grammar", () => {
    for (const raw of ["ab", "1ada", "-ada", "ada-", "has space", "ada_l", "a".repeat(31), "", 42, null]) {
      expect(checkHandle(raw), String(raw)).toMatchObject({ ok: false, error: "handle_invalid" });
    }
  });

  it("accepts the shortest and the longest", () => {
    expect(checkHandle("ab1")).toEqual({ ok: true, handle: "ab1" });
    expect(checkHandle("a".repeat(30))).toEqual({ ok: true, handle: "a".repeat(30) });
  });

  it("refuses a reserved handle in any case", () => {
    for (const raw of ["admin", "Bellman", "CLAUDE"]) {
      expect(checkHandle(raw), raw).toMatchObject({ ok: false, error: "handle_reserved" });
    }
  });
});
