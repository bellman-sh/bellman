/**
 * `src/projections.ts` is the wire shaping both transports agree on: the MCP
 * tools call it today, and the control panel's read routes will call it next
 * (#114). That only holds while the module stays importable from both sides —
 * no MCP SDK, which would otherwise land in the route bundle, and no
 * `cloudflare:workers`, which the Node program cannot import at all.
 *
 * `src/public-event.ts` has carried the same property since it was split out,
 * stated in its docblock and asserted nowhere. A comment does not survive
 * someone adding an import, so this walks the graph instead. Each root is
 * checked, because the rule is about the projection layer and not about the
 * file that happened to need it first.
 *
 * `src/rooms.ts` is the third root. It holds the operations both transports
 * call, so its docblock makes the same promise, and neither of the other two
 * roots reaches it: a clean walk from them said nothing about it.
 *
 * `src/blobs.ts` is the fourth root (#183): the blob seam both the routes and
 * the tool handlers import, with `blobs-r2.ts` the Workers half it must never
 * reach.
 *
 * The property is transitive. A clean module that imports a clean module that
 * imports the SDK is not clean, so the walk follows local edges rather than
 * reading one file's import list.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

// Type-only imports are erased and would cost a bundle nothing, but they are
// banned here too: needing one is a sign the boundary is being crossed in
// thought, which is where it gets crossed in code next.
const BANNED = ["@modelcontextprotocol/sdk", "cloudflare:workers"];

/**
 * Every specifier a module pulls in, by any edge that runs.
 *
 * Four forms, not one. Matching only `import ... from "x"` left
 * `export { y } from "x"`, `export * from "x"`, a bare `import "x"` and a
 * dynamic `import("x")` neither flagged nor followed — so a clean-looking module
 * that merely re-exports an SDK-importing one made this return `[]` and the
 * suite green, which is the one outcome a boundary test must not get wrong.
 */
const importsOf = (file: string): string[] => {
  const text = readFileSync(file, "utf8");
  const forms = [
    /(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["']/g, // import/export ... from
    /(?:^|\n)\s*export\s*\*\s*from\s*["']([^"']+)["']/g,              // export * from
    /(?:^|\n)\s*import\s*["']([^"']+)["']/g,                            // bare side-effect
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,                          // dynamic
  ];
  return forms.flatMap((re) => [...text.matchAll(re)].map((m) => m[1]));
};

/** Local specifiers this walk could not turn into a file. Must stay empty. */
const unresolved: string[] = [];

const fileFor = (from: string, spec: string): string | undefined => {
  const base = resolve(dirname(from), spec.replace(/\.js$/, ""));
  for (const candidate of [`${base}.ts`, `${base}/index.ts`, base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  unresolved.push(`${relative(SRC, from)} -> ${spec}`);
  return undefined;
};

/** Every module reachable from `entry` by local edges, entry included. */
function reachable(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    const specs = importsOf(file);
    seen.set(file, specs);
    for (const spec of specs) {
      if (!spec.startsWith(".")) continue;
      // Resolved rather than assumed: a specifier naming a directory index or a
      // .json made `readFileSync` throw ENOENT and take the whole walk with it.
      const next = fileFor(file, spec);
      if (next !== undefined) queue.push(next);
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
    ["rooms.ts", resolve(SRC, "rooms.ts")],
    ["blobs.ts", resolve(SRC, "blobs.ts")],
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

  it("follows a re-export, not only a plain import", () => {
    // The gap that mattered: `export { x } from "./sdk-thing.js"` pulls the SDK
    // in just as surely, and the old regex saw neither the edge nor the module
    // behind it. src/worker.ts re-exports, so it is a real example rather than
    // a fixture.
    const specs = importsOf(resolve(SRC, "worker.ts"));
    expect(specs.length).toBeGreaterThan(0);
    expect(importsOf(resolve(SRC, "server.ts"))).toContain("@modelcontextprotocol/sdk/server/mcp.js");
  });

  it("resolves every local specifier it meets", () => {
    // An unresolvable specifier used to crash the walk with ENOENT; now it is
    // recorded, and a walk that silently skipped edges would be a boundary test
    // proving nothing.
    reachable(resolve(SRC, "projections.ts"));
    reachable(resolve(SRC, "public-event.ts"));
    reachable(resolve(SRC, "rooms.ts"));
    reachable(resolve(SRC, "blobs.ts"));
    expect(unresolved).toEqual([]);
  });

  it("finds the SDK from src/server.ts, so the detector detects", () => {
    // The positive control for the real assertion. server.ts imports McpServer
    // at top level and always will — if this comes back clean, the check above
    // is proving nothing about projections.ts.
    expect(offenders(resolve(SRC, "server.ts"))).not.toEqual([]);
  });
});
