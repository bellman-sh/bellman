#!/usr/bin/env node
/**
 * Every package the staged server imports must be installed beside it.
 *
 * Walks the ESM import graph from the entry point — static imports, re-exports
 * and string-literal dynamic imports — collects the bare package names, and
 * fails if any is missing from <stage>/node_modules. The bundle's package.json
 * used to list the SDK alone while server/bridge.js imported yaml; the v0.3.0
 * bundle died at import and Claude Desktop said "Server disconnected". Nothing
 * before the packed artifact can show that, so this runs on the artifact.
 *
 *   node extension/check-deps.mjs <stage-dir> [entry, default server/channel.js]
 */
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

const stage = resolve(process.argv[2] ?? ".");
const entry = resolve(stage, process.argv[3] ?? "server/channel.js");
const builtins = new Set(builtinModules);

const SPECIFIER =
  /(?:^|\n)\s*(?:import|export)\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

/** "zod/v4" → "zod", "@scope/pkg/sub" → "@scope/pkg". */
function packageOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const seen = new Set();
const imported = new Map(); // package → files that import it

function visit(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const specifiers = [...readFileSync(file, "utf8").matchAll(SPECIFIER)].map((m) => m[1] ?? m[2]);
  for (const specifier of specifiers) {
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      const target = resolve(dirname(file), specifier);
      if (existsSync(target)) visit(target);
    } else if (!specifier.includes(":")) {
      // node:fs and cloudflare:workers are runtimes, not packages.
      const pkg = packageOf(specifier);
      if (builtins.has(pkg)) continue;
      if (!imported.has(pkg)) imported.set(pkg, new Set());
      imported.get(pkg).add(relative(stage, file));
    }
  }
}

visit(entry);

const missing = [...imported].filter(([pkg]) => !existsSync(join(stage, "node_modules", pkg)));
for (const [pkg, files] of missing) {
  console.error(`missing: ${pkg} (imported by ${[...files].join(", ")})`);
}
if (missing.length > 0) {
  console.error(`${missing.length} package(s) the server imports are not installed under ${stage}`);
  process.exit(1);
}
console.log(`imports ${[...imported.keys()].join(", ")}: all installed under ${relative(".", stage) || "."}`);
