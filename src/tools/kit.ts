import { z } from "zod";
import type { SessionEvent, Verb } from "../types.js";
import { FROZEN } from "../rooms.js";
import type { AppendExtras, BellmanStore } from "../store.js";

// What every tool file shares: the MCP result shape, the zod shapes a tool's
// inputSchema is built from, and the two send-side tables. Split out of
// server.ts in #92 — not because these are large, but because a file per tool
// needs somewhere for them to live that is not the file the tools came from.

export const MAX_WAIT_SECONDS = 25; // stay under the strictest client tool-call timeouts

/** The kinds bellman_send accepts. The tool's `type` enum is built from this list. */
export const SEND_KINDS = [
  "message", "artifact", "action_request", "action_response", "brief_update", "progress", "surface",
] as const;
export type SendKind = (typeof SEND_KINDS)[number];

/**
 * Which verb each send kind needs. A Record rather than a ternary with a default
 * arm: a new kind must declare its verb here or this stops compiling. A default
 * would hand it `send` silently, and a closed enum exists so that every guard is
 * one somebody chose.
 *
 * Verbs do not compose: each kind maps to exactly one verb and no other, so a role
 * holding `request_actions` but not `send` may ask a peer to act but not talk.
 */
export const SEND_VERB = {
  message: "send",
  artifact: "send",
  // A brief_update appends an event that puts this member's prose into every
  // peer's context. A seat that may not speak may not restate itself either —
  // which is exactly what `observer` promises its readers.
  brief_update: "send",
  /**
   * A reply to the room's heartbeat tick. `send` and not a new verb: manifest.ts
   * is explicit that a verb lands only in the PR that adds its operation, and a
   * seat that may not speak may not report either — brief_update's reasoning.
   * `RoleDef.reports` already answers who is asked.
   */
  progress: "send",
  /**
   * A write to the room's working surface (#129). Its own verb, because the
   * surface is state every member reads and the presets give it to one seat.
   */
  surface: "write_surface",
  action_request: "request_actions",
  action_response: "respond_actions",
} as const satisfies Record<SendKind, Verb>;

// ---------------------------------------------------------------------------
// Zod shapes (raw shapes — broadest client compatibility via the SDK)
// ---------------------------------------------------------------------------

export const AgentShape = z.object({
  provider: z.string().min(1).max(50)
    .describe('Model provider, e.g. "anthropic", "openai", "google"'),
  model: z.string().min(1).max(80)
    .describe('Model identifier, e.g. "claude-fable-5", "gpt-5"'),
  client: z.string().min(1).max(80)
    .describe('Client surface, e.g. "claude-code", "claude-chat", "cursor", "chatgpt", "gemini-cli"'),
}).describe("Provider-neutral description of the agent on this side");

export const BriefShape = z.object({
  goal: z.string().min(1).max(500).describe("One sentence: what this session is trying to accomplish"),
  state: z.string().min(1).max(2000).describe("Where things currently stand"),
  constraints: z.array(z.string().max(300)).max(20).default([])
    .describe("Stack, deadlines, don'ts"),
  open_questions: z.array(z.string().max(300)).max(20).default([])
    .describe("What this session is stuck on or wants from a peer"),
  agent: AgentShape,
}).describe("Structured context handshake — keep it token-cheap, no transcript dumps");

export const CapabilitiesShape = z
  .array(z.enum(["read_context", "receive_messages", "request_actions"]))
  .default(["read_context", "receive_messages"])
  .describe(
    "What you ALLOW peers to do to you. request_actions must be explicitly granted."
  );

/**
 * A heartbeat reply. `strictObject`, so every key the shape does not name is
 * refused — which is how `status`, `alive`, `present` and `healthy` are kept out
 * without a denylist that falls behind the first name somebody forgets. The
 * payload is a claim about when it was sent, never about now (invariant 7).
 */
/**
 * An answer to an `action_request`. `approved` is a REQUIRED boolean, and that
 * is the whole point of the shape: the field was unvalidated, so a client could
 * send `{ approved: "false" }` and have a human's refusal read as an approval
 * on the way back out (see `verdictOf` in src/action-state.ts). `result` is the
 * sentence the requester is shown.
 *
 * Not strict, unlike the shapes above: an `action_response` payload is also
 * carried to the peer as content, and a build that adds a field to it should
 * not have the whole answer refused.
 */
export const ActionResponseShape = z.object({
  approved: z.boolean(),
  result: z.string().max(2_000).optional(),
});

export const ProgressShape = z.strictObject({
  note: z.string().min(1).max(500),
  step: z.string().max(40).optional(),
  eta_seconds: z.number().int().nonnegative().max(86_400).optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

export function ok(output: Record<string, unknown>, preamble?: string): ToolResult {
  const text = (preamble ? preamble + "\n\n" : "") + JSON.stringify(output, null, 2);
  return { content: [{ type: "text", text }], structuredContent: output };
}

export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}


export class FrozenError extends Error {
  constructor() { super(FROZEN); }
}

/**
 * An event the caller can rely on, or a throw.
 *
 * `appendEvent` returns null when the session froze, and both callers are past
 * the point where returning a value is convenient — the member is already
 * added, or the code already issued. Throwing keeps the null out of the happy
 * path.
 *
 * **Nothing catches `FrozenError`.** It is thrown here and caught nowhere in
 * `src/`, so it leaves the handler as an exception rather than as the `fail()`
 * refusal the frozen guards produce — a caller that races a freeze gets a
 * different shape from one that arrives after it. Worth knowing before relying
 * on the two reading alike. (This docblock was stranded in `projections.ts` by
 * the #92 split, above no declaration, and claimed "the tool's catch turns it
 * into the same refusal as the guards"; there is no such catch.)
 */
export async function appendOrFrozen(
  s: BellmanStore,
  sessionId: string,
  e: Parameters<BellmanStore["appendEvent"]>[1],
  extras?: AppendExtras
): Promise<SessionEvent> {
  const event = await s.appendEvent(sessionId, e, extras);
  if (!event) throw new FrozenError();
  return event;
}

