import { readFileSync } from "node:fs";

/**
 * The version in the package.json at `file`, or "unknown" when there is none to read.
 *
 * It never throws. This runs when the module loads, and the bridge imports the module: a package.json that
 * is missing, unreadable or malformed (a bundle that did not carry one, a file replaced mid-install) costs a
 * version string, not the bridge's start.
 */
export function readVersion(file: URL): string {
  try {
    const { version } = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown };
    return typeof version === "string" && version !== "" ? version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * The version of the package this file ships in: what the bridge tells every MCP host and what `bellman
 * version` prints. It is read from package.json at run time because a constant here is a number somebody has
 * to remember to bump, and src/bridge.ts still said 0.1.0 at 0.3.1.
 *
 * `../package.json` is the repository root from src/ (vitest, tsx) and the package root from dist/ (an npm
 * install). In the Claude Desktop bundle it is the package.json extension/build.sh stages beside server/,
 * which carries the version of the code packed inside. It is read as a file and not imported as JSON:
 * tsconfig.json's rootDir is src, and a JSON import from outside it fails the build.
 *
 * The Claude Code plugin runs a bundle from plugin/bridge/, and plugin/ holds no package.json (ADR 0018), so
 * `npm run build:plugin` writes the version in as BELLMAN_BUNDLE_VERSION. No other build defines that name,
 * and `typeof` reads an undefined name as "undefined" rather than throwing.
 */
declare const BELLMAN_BUNDLE_VERSION: string | undefined;

export const VERSION =
  typeof BELLMAN_BUNDLE_VERSION === "string"
    ? BELLMAN_BUNDLE_VERSION
    : readVersion(new URL("../package.json", import.meta.url));

/** "0.4.0-rc.1" is [0, 4, 0]: a prerelease or build suffix is dropped. Null for anything that is not dotted numbers. */
function numbers(version: string): number[] | null {
  const match = /^(\d+(?:\.\d+)*)(?:[-+].*)?$/.exec(version.trim());
  return match?.[1] ? match[1].split(".").map(Number) : null;
}

/**
 * Negative when `a` is older than `b`, positive when newer, 0 when equal. Number by number, so 0.10.0 is
 * newer than 0.9.9; where one has more numbers than the other and they agree as far as both go, the longer
 * is newer (0.3.1.1 over 0.3.1). Throws for text that is not a version: ordering it would be a guess.
 */
export function compareVersions(a: string, b: string): number {
  const left = numbers(a);
  const right = numbers(b);
  if (!left || !right) throw new Error(`not a version: ${JSON.stringify(left ? b : a)}`);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return Math.sign(left.length - right.length);
}
