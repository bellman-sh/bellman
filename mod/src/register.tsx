/**
 * bellman-mod's hooks module: built by scripts/build-mod.ts into hooks/register.mjs, the file the plugin runs.
 *
 * `register` is a function declaration on purpose: `claude plugin validate` refuses the bundle when the name is
 * exported from a `const` (esbuild writes that as `var register = ...`).
 */
import type { On } from "claude-code";
import { startDoors } from "./doors";

// For the kit tests, which tick the mocked clock by the bundle's own intervals (mod/tests/harness.ts).
export { DOOR_POLL_MS, ROOMS_POLL_MS } from "../../src/mod/view.js";

export function register(on: On): void {
  startDoors(on);
}
