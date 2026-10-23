/**
 * A topic room's proposal (topic rooms spec, D2 and D4): the payload's shape, and the source a text or diagram
 * card must link. Pure; the room-level rules are tests/tools/proposals.test.ts.
 */
import { describe, expect, it } from "vitest";
import { hasSourceLink, readProposal, sourceRefusal } from "../src/proposal.js";
import type { SurfaceWrite } from "../src/surface.js";
import type { SurfaceItem } from "../src/types.js";

const item = { key: "tools", kind: "text", title: "Tools", body: "See https://modelcontextprotocol.io/specification" };

/** What every refusal starts with. It spells kind, item and base, so a field is looked for in the issue after it. */
const REFUSAL_PREFIX = 'surface_proposal must be { kind: "surface_proposal", item, base }: ';

/** What a text or diagram card is told when its body links no source, word for word. */
const NEEDS_A_SOURCE = "a card needs a source: put at least one http:// or https:// link in its body";

describe("readProposal", () => {
  it("reads { kind, item, base } and hands the item on unread", () => {
    expect(readProposal({ kind: "surface_proposal", item, base: 12 })).toEqual({ ok: true, item, base: 12 });
    expect(readProposal({ kind: "surface_proposal", item: { key: "tools", remove: true }, base: 0 })).toMatchObject({ ok: true, base: 0 });
  });

  it.each([
    ["another kind", { kind: "surface_write", item, base: 0 }, "kind"],
    ["no item", { kind: "surface_proposal", base: 0 }, "item"],
    ["an item that is not an object", { kind: "surface_proposal", item: "tools", base: 0 }, "item"],
    ["an item that is null", { kind: "surface_proposal", item: null, base: 0 }, "item"],
    ["an item that is a list", { kind: "surface_proposal", item: [item], base: 0 }, "item"],
    ["no base", { kind: "surface_proposal", item }, "base"],
    ["a negative base", { kind: "surface_proposal", item, base: -1 }, "base"],
    ["a fractional base", { kind: "surface_proposal", item, base: 1.5 }, "base"],
    ["a base that is text", { kind: "surface_proposal", item, base: "0" }, "base"],
    ["a key it does not name", { kind: "surface_proposal", item, base: 0, note: "why" }, "note"],
  ])("refuses %s, naming the field", (_why, payload, field) => {
    const out = readProposal(payload);
    expect(out.ok).toBe(false);
    const reason = out.ok ? "" : out.reason;
    expect(reason.startsWith(REFUSAL_PREFIX), reason).toBe(true);
    expect(reason.slice(REFUSAL_PREFIX.length), reason).toContain(field);
  });
});

describe("the source rule (D4, R8)", () => {
  const write = (body: string, kind: SurfaceItem["kind"] = "text"): SurfaceWrite => ({
    key: "k", item: { key: "k", kind, title: null, body, ends: null, placement: null, blob: null, shape: null },
  });

  it.each([
    "See https://modelcontextprotocol.io/specification/server/tools for the shape.",
    "[the spec](https://modelcontextprotocol.io/specification)",
    "Source: http://localhost:3900/docs.",
    "no markup at all, just https://example.com/a?b=c#d",
    'flowchart LR\n  A --> B\n  click A "https://example.com/a"',
    "<https://example.com>",
    "<p>Source: https://example.com</p>",
    "SEE HTTPS://EXAMPLE.COM/SPEC",
    "not http://. but https://example.com/spec",
  ])("accepts a card whose body carries a link, wherever it sits: %j", (body) => {
    expect(hasSourceLink(body)).toBe(true);
    expect(sourceRefusal(write(body))).toBeNull();
    expect(sourceRefusal(write(body, "diagram"))).toBeNull();
  });

  it.each([
    "",
    "no link here",
    "example.com/spec",
    "ftp://example.com/file",
    "https://",
    "see https:// and http://.",
    "mailto:a@b.c",
    'use "http://" or "https://" as the scheme',
    "use 'http://' as the scheme",
    "use `https://` as the scheme",
  ])(
    "refuses a text or diagram card with no http or https link: %j",
    (body) => {
      expect(hasSourceLink(body)).toBe(false);
      for (const kind of ["text", "diagram"] as const) expect(sourceRefusal(write(body, kind)), kind).toBe(NEEDS_A_SOURCE);
    },
  );

  it("asks nothing of a link, which is its own source, of a removal, or of a kind with no prose", () => {
    expect(sourceRefusal({ key: "k", item: null })).toBeNull();
    expect(sourceRefusal(write("not read", "link"))).toBeNull();
    for (const kind of ["file", "image", "html", "shape", "connector"] as const) expect(sourceRefusal(write("", kind)), kind).toBeNull();
  });
});
