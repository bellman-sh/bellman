/**
 * bellman-mod's hooks module: built by scripts/build-mod.ts into hooks/register.mjs, the file the plugin runs.
 *
 * `register` is a function declaration on purpose: `claude plugin validate` refuses the bundle when the name is
 * exported from a `const` (esbuild writes that as `var register = ...`).
 */
import type { On } from "claude-code";
import { onTick, startDoors } from "./doors";
import { startView, viewTick } from "./view";

// For the kit tests, which tick the mocked clock by the bundle's own intervals and hold what the mod opens
// to its own widths (mod/tests/harness.ts).
export { DOOR_POLL_MS, PANE_COLUMNS, PANE_ID, ROOMS_POLL_MS, SIDEBAR_COLUMNS } from "../../src/mod/view.js";

export function register(on: On): void {
  // The module's one `session.start`: `claude plugin validate` refuses a second without a matcher. Whatever
  // runs with each door tick subscribes here, in a closure over this hook's `$`, before the first tick.
  on("session.start", async ($, e, next) => {
    onTick((list) => viewTick($, list));
    await startDoors($);
    return next(e);
  });
  startView(on);
}
