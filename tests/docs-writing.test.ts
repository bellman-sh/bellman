/**
 * A room holds many members (CLAUDE.md, "Writing"). Every page on docs.bellman.sh, the generated
 * reference included, is held to it here: a page that says "two sessions" or "the other session"
 * fails npm test. Matched across a line break, since Markdown wraps prose anywhere.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BRIDGE_PAGE, CONTENT_DIR } from "../scripts/docs-reference.js";

const BANNED = /\b(?:two\s+sessions|the\s+other\s+session)\b/gi;
const offences = (text: string): string[] => [...text.matchAll(BANNED)].map((m) => m[0].replace(/\s+/g, " "));

describe("the docs' writing", () => {
  it("catches both phrasings, in any case and across a line break, and nothing else", () => {
    expect(offences("Pair two sessions.\nThe Other\nSession replies.\nA pair room holds two seats; the other sessions wait."))
      .toEqual(["two sessions", "The Other Session"]);
  });

  it("finds neither on any page", () => {
    const pages = readdirSync(CONTENT_DIR, { recursive: true, encoding: "utf8" }).filter((path) => /\.mdx?$/.test(path));
    const found = Object.fromEntries(
      pages
        .map((path) => [path, offences(readFileSync(join(CONTENT_DIR, path), "utf8"))] as const)
        .filter(([, hits]) => hits.length > 0),
    );
    expect(pages, "the sweep reached the pages").toContain(BRIDGE_PAGE);
    expect(found).toEqual({});
  });
});
