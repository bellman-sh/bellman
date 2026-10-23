import { describe, expect, it } from "vitest";
import { isOwnCall } from "../src/mod/calls.js";

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
