/**
 * A tool call's result as data: how the bridge's door reads what its own connection's calls return (`callLive` in
 * src/bridge.ts), and how the Claude Code mod reads its `$.mcp.call` of `bellman_whoami`.
 *
 * Claude Code hands a plugin's call back with `content` and `isError` alone. It passes `structuredContent` on only
 * for a tool that declares an output schema, and no Bellman tool does, so the JSON is in the first text block: the
 * bridge's `bellman_whoami` compact, a server tool's as `ok` writes it (src/tools/kit.ts), an optional preamble, a
 * blank line, then the JSON.
 *
 * Runtime-free on purpose, like `door-protocol.ts`: the bridge imports it, and esbuild bundles it into the mod.
 */

/** A tool call's result, as far as the reader looks. The SDK's `CallToolResult` and the engine's `McpToolResult` pass for it. */
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
