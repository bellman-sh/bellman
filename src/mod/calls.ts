/**
 * The permission checks the mod answers itself. The engine checks a plugin's own `$.mcp.call` as it checks the
 * model's, and in auto mode refuses it unasked, so the mod allows its own call of `bellman_whoami`, the one tool it
 * calls, and nothing else. How that call's result reads is `resultData` (src/result-data.ts).
 *
 * Runtime-free on purpose, like `door-protocol.ts`: esbuild bundles it into the mod.
 */

/**
 * The one tool the mod calls, under any server's name: `bellman_whoami`, from inside its own hooks (`findDoors` in
 * mod/src/doors.ts). Claude Code refuses a plugin's own call from its timers and presses whatever this allows, so the
 * rooms, the canvas and Deny go through the bridge's door instead, and none of them is the mod's to allow here.
 */
const OWN_TOOL = /^mcp__.+__bellman_whoami$/;

/**
 * Whether a permission check is of the mod's own call of `bellman_whoami`, raised by the mod (`next.origin`). The
 * model's own call of it reads the engine as its origin and another plugin's its own name, and both keep their check.
 */
export const isOwnCall = (tool: string, origin: { plugin: string; tier: string } | undefined): boolean =>
  OWN_TOOL.test(tool) && origin?.plugin === "bellman-mod";
