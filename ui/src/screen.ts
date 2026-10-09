import type { ConnectResult, RoomsResult, SurfaceResult } from "./types.js";

/** The part of a CallToolResult this page reads. */
export interface ToolOutcome {
  isError?: boolean;
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
}

export type Screen =
  | { kind: "join"; data: ConnectResult }
  | { kind: "monitor"; data: RoomsResult }
  | { kind: "canvas"; data: SurfaceResult }
  | { kind: "error"; text: string }
  | { kind: "none"; text: string };

const firstText = (r: ToolOutcome): string | undefined =>
  r.content?.find((c) => c.type === "text" && typeof c.text === "string")?.text;

/** Which screen a result is (spec D10, canvas spec D4): a connect preview, a rooms listing, a surface, or text. */
export function pickScreen(r: ToolOutcome): Screen {
  if (r.isError) return { kind: "error", text: firstText(r) ?? "The call failed." };
  const data = r.structuredContent;
  if (data && typeof data === "object") {
    if ("connect_token" in data) return { kind: "join", data: data as ConnectResult };
    if ("rooms" in data) return { kind: "monitor", data: data as RoomsResult };
    // After connect_token: bellman_connect's result carries a surface index under the same key (canvas spec D4).
    if ("surface" in data) return { kind: "canvas", data: data as SurfaceResult };
  }
  return { kind: "none", text: firstText(r) ?? "Nothing to show." };
}
