import { describe, expect, it } from "vitest";
import { UNTRUSTED_PREAMBLE } from "../src/projections.js";
import { fail, ok } from "../src/tools/kit.js";
import { isOwnCall, resultData, type CallResult } from "../src/mod/calls.js";

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

describe("isOwnCall", () => {
  const MINE = { plugin: "bellman-mod", tier: "user" };

  it("allows the mod's own call of bellman_whoami, under any server's name", () => {
    for (const server of ["bellman", "plugin_bellman_bellman", "bellman-look"])
      expect(isOwnCall(`mcp__${server}__bellman_whoami`, MINE), server).toBe(true);
  });

  it("leaves the mod's own call of every other Bellman tool to the engine: the rooms, the canvas and Deny go through the door", () => {
    for (const tool of ["bellman_rooms", "bellman_surface", "bellman_send", "bellman_sync", "bellman_upload"])
      expect(isOwnCall(`mcp__bellman__${tool}`, MINE), tool).toBe(false);
  });

  it("leaves the model's own call of it to the engine", () => {
    expect(isOwnCall("mcp__bellman__bellman_whoami", { plugin: "engine", tier: "core" })).toBe(false);
  });

  it("leaves another plugin's call of it alone", () => {
    for (const plugin of ["other", "bellman", "bellman-mod-x"])
      expect(isOwnCall("mcp__bellman__bellman_whoami", { plugin, tier: "user" }), plugin).toBe(false);
    expect(isOwnCall("mcp__bellman__bellman_whoami", undefined)).toBe(false);
  });

  it("leaves every other tool alone, the mod's own call of it too", () => {
    for (const tool of ["Bash", "Read", "mcp__bellman__bellman_leave", "mcp__claude_ai_Gmail__create_draft"])
      expect(isOwnCall(tool, MINE), tool).toBe(false);
  });

  it("leaves a lookalike alone", () => {
    for (const tool of ["bellman_whoami", "mcp____bellman_whoami", "mcp__x__bellman_whoamix", "mcp__x__xbellman_whoami", "x_mcp__x__bellman_whoami"])
      expect(isOwnCall(tool, MINE), tool).toBe(false);
  });
});
