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
 * `src/http/rooms.ts` is the fifth (#183): the routes the Worker dispatches to
 * and the root program drives directly, which only holds while they import no
 * runtime.
 *
 * The property is transitive. A clean module that imports a clean module that
 * imports the SDK is not clean, so the walk follows local edges rather than
 * reading one file's import list.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { retentionOf, roomPreview } from "../src/projections.js";
import { roomManifest, session } from "./helpers/fixtures.js";

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
    ["http/rooms.ts", resolve(SRC, "http/rooms.ts")],
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
    reachable(resolve(SRC, "http/rooms.ts"));
    expect(unresolved).toEqual([]);
  });

  it("finds the SDK from src/server.ts, so the detector detects", () => {
    // The positive control for the real assertion. server.ts imports McpServer
    // at top level and always will — if this comes back clean, the check above
    // is proving nothing about projections.ts.
    expect(offenders(resolve(SRC, "server.ts"))).not.toEqual([]);
  });
});

/**
 * The preview for a viewer who holds no seat (#65, D4): an org admin reading a closed room their org sat in.
 * It is the preview a seat sees with the three fields that are about the viewer's own seat emptied, so the
 * page that renders one renders the other.
 */
describe("roomPreview for a viewer with no seat", () => {
  const room = session();

  it("names no role, grants no verb, and asks nothing of the viewer", () => {
    expect(roomPreview(room, null)).toMatchObject({ your_role: null, your_verbs: [], you_report: false });
  });

  it("is otherwise the preview a seat sees", () => {
    const { your_role: _a, your_verbs: _b, you_report: _c, ...seated } = roomPreview(room, "peer_a");
    const { your_role: _d, your_verbs: _e, you_report: _f, ...seatless } = roomPreview(room, null);
    expect(seatless).toEqual(seated);
    // Control: the three fields really are the ones a seat fills in.
    expect(roomPreview(room, "peer_a")).toMatchObject({ your_role: "peer_a" });
    expect(roomPreview(room, "peer_a").your_verbs.length).toBeGreaterThan(0);
  });
});

/**
 * What the room will name its members for (#66, review m2). The preview is the consent point: a joiner's human decides
 * on a seat before taking it, and a seat in a room with `quiet_after: 2h` will be named quiet every two hours while it
 * sends nothing. It is carried as the cadence is, in seconds the server computed, and null where the room names nothing.
 */
describe("roomPreview and housekeeping", () => {
  const declaring = (housekeeping: NonNullable<ReturnType<typeof roomManifest>["housekeeping"]> | null) =>
    session({ manifest: roomManifest({ housekeeping }) });

  it("is null for a room that declared none", () => {
    expect(roomPreview(declaring(null), "peer_a").housekeeping).toBeNull();
  });

  it("carries each threshold in seconds, and null for each one the room leaves off", () => {
    const room = declaring({ quietAfterMs: 7_200_000, answerWithinMs: 1_800_000, idleAfterMs: null, repeatAfterMs: 14_400_000 });
    expect(roomPreview(room, "peer_a").housekeeping).toEqual({
      quiet_after_seconds: 7_200, answer_within_seconds: 1_800, idle_after_seconds: null, repeat_after_seconds: 14_400,
    });
  });

  it("carries the whole block for a room with no seat's viewer too: it is the room's, not the seat's", () => {
    const room = declaring({ quietAfterMs: null, answerWithinMs: null, idleAfterMs: 86_400_000, repeatAfterMs: null });
    expect(roomPreview(room, null).housekeeping).toEqual(roomPreview(room, "peer_a").housekeeping);
    expect(roomPreview(room, null).housekeeping).toMatchObject({ idle_after_seconds: 86_400 });
  });
});

/**
 * The two times the detail carries (#65, review M8): when the room closed and when it goes. ISO, as the envelope's
 * others are spelled, and null where the record has none, so the page can tell "kept until deleted" from "in six days".
 */
describe("retentionOf", () => {
  const closedAt = Date.parse("2026-10-01T12:00:00.000Z");
  const week = 7 * 24 * 60 * 60 * 1000;

  it("spells the close and the end of the window as ISO times", () => {
    expect(retentionOf(session({ closed: true, closedAt, retainAfterCloseMs: week })))
      .toEqual({ closed_at: "2026-10-01T12:00:00.000Z", purge_at: "2026-10-08T12:00:00.000Z" });
  });

  it("gives a delete's time in place of the window's end", () => {
    expect(retentionOf(session({ closed: true, closedAt, retainAfterCloseMs: week, purgeAt: closedAt + 1_000 })))
      .toEqual({ closed_at: "2026-10-01T12:00:00.000Z", purge_at: "2026-10-01T12:00:01.000Z" });
  });

  it("has no purge time for a room kept until deleted, and neither time for a row closed before the close was dated", () => {
    expect(retentionOf(session({ closed: true, closedAt, retainAfterCloseMs: null })))
      .toEqual({ closed_at: "2026-10-01T12:00:00.000Z", purge_at: null });
    expect(retentionOf(session({ closed: true, closedAt: null, retainAfterCloseMs: null })))
      .toEqual({ closed_at: null, purge_at: null });
  });

  it("has no purge time for an open room, whatever window it carries", () => {
    expect(retentionOf(session({ closed: false, closedAt: null, retainAfterCloseMs: week })))
      .toEqual({ closed_at: null, purge_at: null });
  });
});
