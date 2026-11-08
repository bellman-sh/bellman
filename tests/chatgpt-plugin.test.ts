/**
 * chatgpt/ is the package OpenAI's plugin directory takes: plugin.json, mcp.json and two icons. The portal checks
 * the listing against limits and rules the upload itself does not enforce, so a listing can upload cleanly and
 * still be refused at submission. This holds the package to them: the field limits and required URLs
 * (developers.openai.com/plugins/deploy/submission, "Manifest fields"), the listing rules (no pricing, no
 * comparisons: /plugins/plugin-guidelines), five positive and three negative review cases naming tools the server
 * really lists, one remote MCP server at the production URL, and nothing the public directory rejects (hooks,
 * apps, server headers, credentials). It also holds the domain-verification route's response.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openaiChallengeResponse } from "../src/http/openai-challenge.js";
import { listServerTools } from "./helpers/tool-lists.js";

const read = (path: string) => JSON.parse(readFileSync(new URL(`../chatgpt/${path}`, import.meta.url), "utf8"));
const plugin = read("plugin.json");
const mcp = read("mcp.json");
const pkg: { version: string } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const openai = plugin.extensions["com.openai"];
const ui = openai.interface;

/** A PNG's width and height, from its IHDR chunk. */
function pngSize(path: string): [number, number] {
  const b = readFileSync(new URL(`../chatgpt/${path}`, import.meta.url));
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

describe("the ChatGPT plugin package", () => {
  it("is a portable Agent Plugins package named bellman, at the server's version", () => {
    expect(plugin.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    expect(plugin.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(plugin.version).toBe(pkg.version);
    expect(plugin.description.length).toBeLessThanOrEqual(4000);
  });

  it("keeps the listing inside the portal's limits", () => {
    expect(ui.displayName.length).toBeLessThanOrEqual(30);
    expect(ui.shortDescription.length).toBeLessThanOrEqual(30);
    expect(ui.longDescription.length).toBeLessThanOrEqual(4000);
    expect(ui.developerName.length).toBeLessThanOrEqual(80);
    expect(ui.capabilities.length).toBeLessThanOrEqual(20);
    for (const c of ui.capabilities) expect(c.length).toBeLessThanOrEqual(120);
    expect(ui.defaultPrompt.length).toBeLessThanOrEqual(3);
    expect(new Set(ui.defaultPrompt).size).toBe(ui.defaultPrompt.length);
    for (const p of ui.defaultPrompt) {
      expect(p.length).toBeLessThanOrEqual(128);
      expect(p).not.toContain("@");
    }
    for (const key of ["brandColor", "brandColorDark"]) expect(ui[key]).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it("names all four HTTPS listing URLs MCP review needs", () => {
    for (const key of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) {
      expect(ui[key], key).toMatch(/^https:\/\/bellman\.sh(\/|$)/);
    }
  });

  it("says nothing about price and compares Bellman with nothing", () => {
    const listing = [ui.displayName, ui.shortDescription, ui.longDescription, ...ui.capabilities, ...ui.defaultPrompt].join("\n");
    expect(listing).not.toMatch(/\$|\bfree\b|\bpric|\b(paid|free|pro|max|team) plans?\b|subscri|trial|discount|\bper (seat|month)\b/i);
    expect(listing).not.toMatch(/\bvs\.?\b|\bbetter than\b|\bunlike\b|\binstead of\b|\bbest\b|\bofficial\b/i);
    expect(ui.displayName).not.toMatch(/MCP|Plugin/i);
  });

  it("ships square icons of at least 48 pixels, at ./assets paths", () => {
    for (const key of ["logo", "composerIcon"]) {
      expect(ui[key]).toMatch(/^\.\/assets\/.+\.png$/);
      const path = ui[key].slice(2);
      expect(existsSync(new URL(`../chatgpt/${path}`, import.meta.url))).toBe(true);
      const [w, h] = pngSize(path);
      expect(w).toBe(h);
      expect(w).toBeGreaterThanOrEqual(48);
      expect(w).toBeLessThanOrEqual(4096);
    }
  });

  it("declares one remote MCP server, the production endpoint, signed in by OAuth with dynamic registration", () => {
    expect(mcp.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
    const servers = Object.values(mcp.mcpServers) as Record<string, any>[];
    expect(servers).toHaveLength(1);
    const [server] = servers;
    expect(server.type).toBe("streamable-http");
    expect(server.url).toBe("https://mcp.bellman.sh/mcp");
    expect(server.headers).toBeUndefined();
    expect(server.extensions["com.openai"].auth).toEqual({ type: "oauth", client: { mode: "dcr" } });
  });

  it("carries nothing the public directory rejects", () => {
    expect(openai.apps).toBeUndefined();
    expect(openai.hooks).toBeUndefined();
    const text = JSON.stringify({ plugin, mcp });
    for (const banned of ["clientSecret", "test_credentials", "reviewer_instructions"]) expect(text).not.toContain(banned);
  });

  it("has five positive and three negative review cases, naming tools the server lists", async () => {
    const { positive, negative } = openai.review.test_cases;
    expect(positive).toHaveLength(5);
    expect(negative).toHaveLength(3);
    const tools = new Set((await listServerTools()).map((t) => t.name));
    for (const c of positive) {
      expect(c.description && c.prompt && c.expected_behavior).toBeTruthy();
      for (const name of c.tools_triggered.split(",").map((s: string) => s.trim())) expect(tools, name).toContain(name);
    }
    for (const c of negative) expect(c.description && c.prompt).toBeTruthy();
  });

  it("gives every tool the three explicit hints OpenAI's review requires", async () => {
    for (const tool of await listServerTools()) {
      for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"] as const) {
        expect(typeof tool.annotations?.[hint], `${tool.name}.${hint}`).toBe("boolean");
      }
    }
  });
});

describe("the domain-verification route", () => {
  it("serves the token as plain text when one is set, and nothing otherwise", async () => {
    const res = openaiChallengeResponse("  tok_abc123\n")!;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await res.text()).toBe("tok_abc123");
    expect(openaiChallengeResponse("")).toBeNull();
    expect(openaiChallengeResponse(undefined)).toBeNull();
  });
});
