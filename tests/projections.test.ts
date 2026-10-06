/**
 * `src/projections.ts` is the wire shaping both transports agree on: the MCP
 * tools call it today, and the control panel's read routes will call it next
 * (#114). That only holds while the module stays importable from both sides —
 * no MCP SDK, which would otherwise land in the route bundle, and no
 * `cloudflare:workers`, which the Node program cannot import at all.
 *
 * `src/public-event.ts` has carried the same property since it was split out,
 * stated in its docblock and asserted nowhere. A comment does not survive
 * someone adding an import, so this walks the graph instead. Both modules are
 * checked, because the rule is about the projection layer and not about the
 * file that happened to need it first.
 *
 * The property is transitive. A clean module that imports a clean module that
 * imports the SDK is not clean, so the walk follows local edges rather than
 * reading one file's import list.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

// Type-only imports are erased and would cost a bundle nothing, but they are
// banned here too: needing one is a sign the boundary is being crossed in
// thought, which is where it gets crossed in code next.
const BANNED = ["@modelcontextprotocol/sdk", "cloudflare:workers"];

const importsOf = (file: string): string[] =>
  [...readFileSync(file, "utf8").matchAll(/(?:^|\n)\s*import\s[^;]*?from\s*["']([^"']+)["']/g)]
    .map((m) => m[1]);

/** Every module reachable from `entry` by local imports, entry included. */
function reachable(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    const specs = importsOf(file);
    seen.set(file, specs);
    for (const spec of specs) {
      if (spec.startsWith(".")) queue.push(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
    }
  }
  return seen;
}

const offenders = (entry: string) =>
  [...reachable(entry)].flatMap(([file, specs]) =>
    specs.filter((spec) => BANNED.some((b) => spec === b || spec.startsWith(b + "/")))
      .map((spec) => `${relative(SRC, file)} imports ${spec}`)
  );

describe("the projection layer stays importable from both transports", () => {
  it.each([
    ["projections.ts", resolve(SRC, "projections.ts")],
    ["public-event.ts", resolve(SRC, "public-event.ts")],
  ])("%s pulls in no runtime, transitively", (_name, entry) => {
    expect(offenders(entry)).toEqual([]);
  });

  it("reaches past the entry file, so an empty result means clean and not unread", () => {
    // Without this the assertions above would pass on a walk that read one
    // file and stopped — or read nothing at all.
    const graph = reachable(resolve(SRC, "projections.ts"));
    expect(graph.size).toBeGreaterThan(1);
    expect([...graph.keys()].map((f) => relative(SRC, f))).toContain("roles.ts");
  });

  it("finds the SDK from src/server.ts, so the detector detects", () => {
    // The positive control for the real assertion. server.ts imports McpServer
    // at top level and always will — if this comes back clean, the check above
    // is proving nothing about projections.ts.
    expect(offenders(resolve(SRC, "server.ts"))).not.toEqual([]);
  });
});
