/** Room file paths (ADR 0046): one normal form, refused before any authorization runs. */
import { describe, expect, it } from "vitest";
import { MAX_PATH_CHARS, MAX_PATH_SEGMENTS, namespaceOf, normalizePath } from "../src/fs-path.js";

const ok = (raw: string) => {
  const r = normalizePath(raw);
  if (!r.ok) throw new Error(`refused ${JSON.stringify(raw)}: ${r.reason}`);
  return r.path;
};
const refused = (raw: string) => normalizePath(raw).ok === false;

describe("normalizePath", () => {
  it("collapses slashes and drops a trailing one", () => {
    expect(ok("/a//b")).toBe("/a/b");
    expect(ok("///a///b///")).toBe("/a/b");
    expect(ok("/plans/launch.md")).toBe("/plans/launch.md");
    expect(ok("/")).toBe("/");
  });

  it("applies NFC, so an NFC/NFD pair is one path", () => {
    const nfd = "/café.md";
    const nfc = "/café.md";
    expect(ok(nfd)).toBe(nfc);
    expect(ok(nfc)).toBe(nfc);
  });

  it("refuses dot segments, a missing leading slash, control characters and NUL", () => {
    for (const raw of ["/a/../members/0123456789abcdef/x", "/a/./b", "/..", "/.", "a/b", "", "/a\u0000b", "/a\nb", "/a\u007fb", "/a\u0085b"]) {
      expect(refused(raw), JSON.stringify(raw)).toBe(true);
    }
  });

  it("keeps names that only start with a dot, and colons", () => {
    expect(ok("/.bellman/room.md")).toBe("/.bellman/room.md");
    expect(ok("/notes/a:b:c.md")).toBe("/notes/a:b:c.md");
  });

  it("bounds characters and segments", () => {
    expect(refused("/" + "a".repeat(MAX_PATH_CHARS))).toBe(true);
    expect(ok("/" + "a".repeat(MAX_PATH_CHARS - 1))).toHaveLength(MAX_PATH_CHARS);
    expect(refused("/a".repeat(MAX_PATH_SEGMENTS + 1))).toBe(true);
    expect(ok("/a".repeat(MAX_PATH_SEGMENTS))).toBe("/a".repeat(MAX_PATH_SEGMENTS));
  });

  it("never yields a path with a dot segment or without its root, over a seeded random loop", () => {
    let seed = 430;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
    const parts = ["a", "b", ".", "..", "", "/", "members", "́", "e", ":", "\u0000", " ", ".x"];
    for (let i = 0; i < 5000; i++) {
      let raw = rand(4) === 0 ? "" : "/";
      for (let j = rand(8); j >= 0; j--) raw += parts[rand(parts.length)] + (rand(2) ? "/" : "");
      const r = normalizePath(raw);
      if (!r.ok) continue;
      expect(r.path.startsWith("/"), raw).toBe(true);
      expect(r.path.split("/").slice(1).some((s) => s === "." || s === ".."), raw).toBe(false);
      expect(r.path.includes("//"), raw).toBe(false);
      expect(r.path, raw).toBe(r.path.normalize("NFC"));
      expect(normalizePath(r.path), raw).toEqual(r);
    }
  });
});

describe("namespaceOf", () => {
  it("names memory with its id, the governed view, apps with their key, and room files", () => {
    expect(namespaceOf("/members/0123456789abcdef/notes.md")).toEqual({ ns: "memory", memoryId: "0123456789abcdef" });
    expect(namespaceOf("/members/me/notes.md")).toEqual({ ns: "memory", memoryId: "me" });
    expect(namespaceOf("/members")).toEqual({ ns: "memory", memoryId: null });
    expect(namespaceOf("/.bellman/room.md")).toEqual({ ns: "bellman" });
    expect(namespaceOf("/.bellman")).toEqual({ ns: "bellman" });
    expect(namespaceOf("/apps/tracker/index.ts")).toEqual({ ns: "app", key: "tracker" });
    expect(namespaceOf("/plans/launch.md")).toEqual({ ns: "room" });
    expect(namespaceOf("/membersx/a")).toEqual({ ns: "room" });
  });
});
