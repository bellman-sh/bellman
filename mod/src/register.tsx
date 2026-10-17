/**
 * bellman-mod's hooks module: built by scripts/build-mod.ts into hooks/register.mjs, the file the plugin runs.
 *
 * `register` is a function declaration on purpose: `claude plugin validate` refuses the bundle when the name is
 * exported from a `const` (esbuild writes that as `var register = ...`).
 */
import type { On } from "claude-code";
import { isOwnCall } from "../../src/mod/calls.js";
import { onTick, readShownLog, startDoors } from "./doors";
import { registerGate } from "./gate";
import { startView, viewTick } from "./view";
import { registerWake, wakeTick } from "./waking";

// For the kit tests, which tick the mocked clock by the bundle's own intervals, hold what the mod opens to its
// own widths, and compare what the gate says to the words it is meant to say (mod/tests/harness.ts).
export { DOOR_POLL_MS, PANE_COLUMNS, PANE_ID, ROOMS_POLL_MS, SIDEBAR_COLUMNS } from "../../src/mod/view.js";
export { GATE_REASON, approvalKey } from "../../src/mod/gate.js";
export { APPROVALS_SECTION } from "./gate";
export { approvedText, declinedText } from "./pane";
export { WAKE_TEXT } from "../../src/mod/wake.js";

export function register(on: On): void {
  // The module's one `session.start`: `claude plugin validate` refuses a second without a matcher. Whatever
  // runs with each door tick subscribes here, in a closure over this hook's `$`, before the first tick.
  on("session.start", async ($, e, next) => {
    onTick((list) => readShownLog($, list));
    onTick((list) => viewTick($, list));
    onTick((list) => wakeTick($, list));
    await startDoors($);
    return next(e);
  });
  // The engine checks the mod's own `$.mcp.call` as it checks the model's call, and in auto mode refuses it unasked.
  // This allows the mod's own calls of its four tools and nothing else: the model's own call of them, and another
  // plugin's, go on to the verdict beneath and keep their prompt. No `.catch`: a guard that fails is skipped and
  // leaves the verdict beneath, the engine's own, so a failure here costs only the mod's own calls their allow.
  on("tool.check", ($, e, next) => (isOwnCall(e.tool, next.origin) ? { decision: "allow", reason: "bellman-mod's own call" } : next(e)));
  startView(on);
  registerGate(on);
  registerWake(on);
}
