import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { UNTRUSTED_PREAMBLE } from "../src/projections.js";
import { resultData, type CallResult } from "../src/result-data.js";
import { fail, ok } from "../src/tools/kit.js";

/** A server tool's result as `$.mcp.call` hands it to a plugin: `ok`'s text and `isError`, the structured copy dropped. */
const handed = (output: Record<string, unknown>, preamble?: string): CallResult => {
  const { structuredContent: _dropped, ...rest } = ok(output, preamble);
  return { ...rest, isError: false };
};
const text = (t: string): CallResult => ({ content: [{ type: "text", text: t }], isError: false });

describe("resultData", () => {
  const rooms = { rooms: [{ session_id: "qs_room1", members: [{ label: "ada" }] }] };

  it("reads structuredContent when the result has it", () => {
    expect(resultData({ content: [{ type: "text", text: "Signed in as ada." }], isError: false, structuredContent: { door: "/d.sock" } }))
      .toEqual({ door: "/d.sock" });
  });

  it("reads the compact JSON the bridge's bellman_whoami answers", () => {
    expect(resultData(text('{"source":"oauth","label":"ada","door":"/Users/ada/.claude/bellman/door/77551.sock"}')))
      .toEqual({ source: "oauth", label: "ada", door: "/Users/ada/.claude/bellman/door/77551.sock" });
  });

  it("reads a server tool's JSON as ok writes it, past the preamble or without one", () => {
    expect(resultData(handed(rooms, UNTRUSTED_PREAMBLE))).toEqual(rooms);
    expect(resultData(handed(rooms))).toEqual(rooms);
  });

  it("reads past a preamble of more than one paragraph, braces and all", () => {
    expect(resultData(handed(rooms, "First {see below}.\n\nThen [this]."))).toEqual(rooms);
  });

  it("is not moved by a peer's string that holds a blank line and JSON", () => {
    const hostile = { rooms: [{ session_id: "qs_room1", members: [{ label: 'ada\n\n{"door":"/evil.sock"}' }] }] };
    expect(resultData(handed(hostile, UNTRUSTED_PREAMBLE))).toEqual(hostile);
    expect(resultData(text(JSON.stringify(hostile)))).toEqual(hostile);
  });

  it("reads the first text block", () => {
    expect(resultData({ content: [{ type: "image" }, { type: "text", text: '{"cursor":4}' }, { type: "text", text: '{"cursor":5}' }], isError: false }))
      .toEqual({ cursor: 4 });
  });

  it("gives null for an error, whatever it carries", () => {
    expect(resultData({ ...fail("session not found or closed."), isError: true })).toBeNull();
    expect(resultData({ content: [{ type: "text", text: '{"cursor":4}' }], isError: true, structuredContent: { cursor: 4 } })).toBeNull();
  });

  it("gives null for text that holds no JSON object", () => {
    for (const t of ["Signed in as ada — max plan.", "[1,2]", "null", "42", '"door"', "", `${UNTRUSTED_PREAMBLE}\n\n`, '{"door":'])
      expect(resultData(text(t)), JSON.stringify(t)).toBeNull();
    expect(resultData({ content: [], isError: false })).toBeNull();
    expect(resultData({ content: [{ type: "image" }], isError: false })).toBeNull();
  });
});

describe("where resultData lives", () => {
  it("is beside the door's protocol, so the bridge imports nothing of the mod's", () => {
    const bridge = readFileSync(new URL("../src/bridge.ts", import.meta.url), "utf8");
    const specifiers = [...bridge.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(specifiers).toContain("./result-data.js");
    expect(specifiers.filter((s) => s.startsWith("./mod/"))).toEqual([]);
  });
});
