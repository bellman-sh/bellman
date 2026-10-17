/**
 * Writes the docs site's tool reference (scripts/docs-reference.ts) under docs-site/src/content/docs/.
 * A tool that was removed or renamed leaves its old page behind, so every .md in reference/tools/ that
 * this run did not write is deleted: otherwise the old page would keep its URL and its sidebar entry.
 * `npm run docs:gen` is the only writer; tests/docs-reference.test.ts fails until it has been run.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONTENT_DIR, TOOLS_DIR, referencePages } from "./docs-reference.js";

const pages = await referencePages();

const toolsDir = join(CONTENT_DIR, TOOLS_DIR);
mkdirSync(toolsDir, { recursive: true });

let removed = 0;
for (const name of readdirSync(toolsDir)) {
  if (name.endsWith(".md") && !pages.has(`${TOOLS_DIR}/${name}`)) {
    rmSync(join(toolsDir, name));
    removed++;
  }
}

for (const [path, text] of pages) {
  const file = join(CONTENT_DIR, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

console.error(`docs:gen: wrote ${pages.size} pages, removed ${removed}`);
