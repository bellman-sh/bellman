import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { serverCard } from "../src/server-card.js";

// The registry listing (server.json) and the server card describe one server: they say the same about it.
describe("the MCP server card", () => {
  it("names, titles, describes and versions Bellman as server.json does", () => {
    const listing = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
    const card = serverCard("https://mcp.bellman.sh") as Record<string, unknown>;
    for (const field of ["name", "title", "description", "version", "websiteUrl", "repository"]) {
      expect(card[field], field).toEqual(listing[field]);
    }
  });
});
