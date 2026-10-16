/**
 * The gate's judgement: which `bellman_send` calls only the person may make.
 *
 * Claude can answer an action request with `bellman_send` itself, though the request says
 * the answering member's human approves it, not its agent. In the rooms the mod's pane
 * shows, an `action_response` passes only as the answer the person gave by pressing
 * Approve or Deny. This file is that decision and nothing else: the hooks that ask it, and
 * the state they pass in, belong to the mod.
 *
 * Runtime-free on purpose, like `door-protocol.ts`: esbuild bundles it into the mod, so it
 * imports nothing and cannot reach `claude-code`, Node or the network.
 */

/** The parts of a `bellman_send` call the gate reads. */
export interface SendCall {
  type: string;
  session_id: string;
  ref_id: string | null;
  /** `payload.approved` when that is a boolean; anything else, `undefined`. */
  approved: boolean | undefined;
}

/** `bellman_send` under any server's name: the bridge's own, a registered one, the connector's. */
const SEND_TOOL = /^(?:mcp__.+__)?bellman_send$/;

/**
 * The call, or `undefined` when `tool` is not `bellman_send`.
 *
 * The room is read as the tool resolves it (`roomIdOf` in `src/tools/kit.ts`): `session_id`,
 * else its alias `room_id`. Reading `session_id` alone would let an answer that names the room
 * by the alias walk past the gate. A value of another type reads as absent: the tool's schema
 * refuses such a call anyway, so the gate never has to judge one the server would accept.
 */
export function sendCallOf(tool: string, args: Record<string, unknown>): SendCall | undefined {
  if (!SEND_TOOL.test(tool)) return undefined;
  const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
  const approved = (args.payload as { approved?: unknown } | null | undefined)?.approved;
  return {
    type: text(args.type) ?? "",
    session_id: text(args.session_id) ?? text(args.room_id) ?? "",
    ref_id: text(args.ref_id) ?? null,
    approved: typeof approved === "boolean" ? approved : undefined,
  };
}

/**
 * The key a press is recorded under: the room, and the request's cursor as the `ref_id` string
 * (`String(cursor)`). The tool admits a response only when `ref_id` equals that string exactly,
 * so `"041"` never answers cursor 41 here either.
 */
export const approvalKey = (sessionId: string, refId: string): string => `${sessionId}#${refId}`;

/** What the gate knows when a call arrives. The mod keeps it; this file only reads it. */
export interface GateContext {
  /** A terminal is attached and the mod has drawn its Approve tab there. Otherwise nothing is gated. */
  shut: boolean;
  /** The rooms the pane shows. An answer in any other room is not the gate's business. */
  paneRooms: ReadonlySet<string>;
  /** `approvalKey`s of the requests the person approved. */
  approved: ReadonlySet<string>;
  /** `approvalKey`s of the requests the person declined, whose `approved: false` answer the mod sends itself. */
  denying: ReadonlySet<string>;
}

export type GateVerdict = { allow: true } | { allow: false; reason: string };

/** What Claude is told when the gate refuses. Fixed text: nothing a peer wrote reaches it. */
export const GATE_REASON =
  "Only the person answers a Bellman action request in this room. They approve or decline it in the Bellman pane, and you are told when they approve.";

export function judgeSend(call: SendCall, ctx: GateContext): GateVerdict {
  const gated = ctx.shut && call.type === "action_response" && ctx.paneRooms.has(call.session_id);
  if (!gated) return { allow: true };
  // Only the exact answer the person gave: an approval after Approve, a decline after Deny. The
  // keys live in separate sets, so a pressed Deny never lets an approval through, nor the reverse.
  if (call.ref_id !== null && call.approved !== undefined) {
    const given = call.approved ? ctx.approved : ctx.denying;
    if (given.has(approvalKey(call.session_id, call.ref_id))) return { allow: true };
  }
  return { allow: false, reason: GATE_REASON };
}
