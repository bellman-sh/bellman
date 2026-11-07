import { describe, expect, it } from "vitest";
import { renderExport } from "../src/memory-export.js";
import type { FsRow } from "../src/types.js";

const row = (path: string, content: string, rev = 1): FsRow => ({ path, rev, content, size: content.length, writerMemberId: "home", writerLabel: "j", at: 1_700_000_000_000, deleted: false });

describe("renderExport", () => {
  it("renders home notes then room notes, verbatim, with the empty markers", () => {
    const md = renderExport({ label: "jesse@x", at: 1_700_000_000_000, home: [row("/b.md", "second"), row("/a.md", "# first\n\nbody", 3)], rooms: [{ sessionId: "qs_1", room: "swarm", notes: [row("/members/mid/n.md", "note")] }] });
    expect(md).toBe(`# Bellman memory export\n\nAccount: jesse@x\nExported: 2023-11-14T22:13:20.000Z\n\n## Home memory\n\n### /a.md\n\nRevision 3 · 2023-11-14T22:13:20.000Z\n\n# first\n\nbody\n\n---\n\n### /b.md\n\nRevision 1 · 2023-11-14T22:13:20.000Z\n\nsecond\n\n---\n\n## Room notes\n\n### swarm (qs_1)\n\n#### /members/mid/n.md\n\nRevision 1 · 2023-11-14T22:13:20.000Z\n\nnote\n\n---\n`);
    expect(renderExport({ label: "j", at: 0, home: [], rooms: [{ sessionId: "qs_x", room: "a\n## Home memory", notes: [row("/members/mid/n.md", "x")] }] })).toContain("\n### a ## Home memory (qs_x)\n");
    expect(renderExport({ label: "j", at: 0, home: [], rooms: [] })).toContain("_No home notes._\n\n## Room notes\n\n_No room notes._\n");
  });
});
