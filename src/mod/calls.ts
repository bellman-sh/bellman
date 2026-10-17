/**
 * The mod's own `$.mcp.call`s: how their results read, and which permission checks the mod answers itself.
 *
 * Claude Code hands a plugin's call back with `content` and `isError` alone. It passes `structuredContent` on only
 * for a tool that declares an output schema, and no Bellman tool does, so the JSON is in the first text block: the
 * bridge's `bellman_whoami` compact, a server tool's as `ok` writes it (src/tools/kit.ts), an optional preamble, a
 * blank line, then the JSON. The engine also checks a plugin's call as it checks the model's, and in auto mode
 * refuses it unasked, so the mod allows its own call of `bellman_whoami`, the one tool it calls, and nothing else.
 *
 * Runtime-free on purpose, like `door-protocol.ts`: esbuild bundles it into the mod.
 */

/** A `$.mcp.call` result, as far as the reader looks. The engine's `McpToolResult` passes for it. */
export interface CallResult {
  content: readonly { type: string; text?: string }[];
  isError?: boolean;
  structuredContent?: unknown;
}

/**
 * The result's data: its `structuredContent` when it has one, else the JSON object in its first text block, read
 * past a preamble. Null for an error, and for a result that holds no JSON object.
 */
export function resultData(result: CallResult): Record<string, unknown> | null {
  if (result.isError) return null;
  const data = result.structuredContent ?? parsed(result.content.find((block) => block.type === "text")?.text);
  return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
}

/** The JSON a text ends with: past its last blank line, the preamble's, since JSON.stringify never writes one. */
function parsed(text: string | undefined): unknown {
  if (text === undefined) return null;
  const blank = text.lastIndexOf("\n\n");
  try {
    return JSON.parse(blank === -1 ? text : text.slice(blank + 2));
  } catch {
    return null;
  }
}

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
