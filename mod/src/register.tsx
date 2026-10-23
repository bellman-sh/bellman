/**
 * bellman-mod's hooks module: built by scripts/build-mod.ts into hooks/register.mjs, the file the plugin runs.
 *
 * `register` is a function declaration on purpose: `claude plugin validate` refuses the bundle when the name is
 * exported from a `const` (esbuild writes that as `var register = ...`).
 */
import type { On } from "claude-code";
import { isOwnCall } from "../../src/mod/calls.js";
import { findDoors, onTick, readShownLog, startDoors } from "./doors";
import { registerGate } from "./gate";
import { startView, viewTick } from "./view";
import { promptSubmitted, registerWake, turnEnded, turnStarted, wakeTick } from "./waking";

// For the kit tests, which tick the mocked clock by the bundle's own intervals, hold what the mod opens to its
// own widths and what it keeps to its own bounds, and compare what the gate says to the words it is meant to say
// (mod/tests/harness.ts).
export { CANVAS_MAX, DOOR_POLL_MS, LOGS_MAX, PANE_COLUMNS, PANE_ID, ROOMS_POLL_MS, SIDEBAR_COLUMNS } from "../../src/mod/view.js";
export { GATE_REASON, approvalKey } from "../../src/mod/gate.js";
export { APPROVALS_SECTION } from "./gate";
export { approvedText, declinedText } from "./pane";
export { WAKE_TEXT } from "../../src/mod/wake.js";

export function register(on: On): void {
  // The one Claude Code tool the mod calls is `bellman_whoami`, which names a bridge's door, and these four hooks are
  // the only places it calls it (`findDoors`, doors.ts): Claude Code allows a mod's own tool call inside one of its
  // hooks and refuses it from its timers and presses (R15). Each hook hands `findDoors` its own `$`, the one its
  // dispatch answers to. Everything else the mod reads or sends goes over a door's socket.
  //
  // The module's one `session.start`, as `claude plugin validate` refuses a second without a matcher. Whatever runs
  // with each door tick subscribes here, in a closure over this hook's `$`, before the first tick.
  on("session.start", async ($, e, next) => {
    onTick((list) => readShownLog($, list));
    onTick((list) => viewTick($, list));
    onTick((list) => wakeTick($, list));
    await startDoors($);
    return next(e);
  });
  // A bridge listed that the mod has not asked, or one whose door a tick found failing, is asked at the next of these.
  on("turn.start", async ($, e, next) => {
    turnStarted(e);
    await findDoors($);
    return next(e);
  });
  on("turn.complete", async ($, e, next) => {
    turnEnded(e);
    await findDoors($);
    return next(e);
  });
  on("prompt.submit", async ($, e, next) => {
    promptSubmitted(e);
    await findDoors($);
    return next(e);
  });
  // The engine checks the mod's own `$.mcp.call` as it checks the model's call, and in auto mode refuses it unasked.
  // This allows the mod's own call of `bellman_whoami` and nothing else: the model's own call of it, and another
  // plugin's, go on to the verdict beneath and keep their prompt. No `.catch`: a guard that fails is skipped and
  // leaves the verdict beneath, the engine's own, so a failure here costs only the mod's own call its allow.
  on("tool.check", ($, e, next) => (isOwnCall(e.tool, next.origin) ? { decision: "allow", reason: "bellman-mod's own call" } : next(e)));
  startView(on);
  registerGate(on);
  registerWake();
}
