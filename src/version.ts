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
 */
export const VERSION = readVersion(new URL("../package.json", import.meta.url));
