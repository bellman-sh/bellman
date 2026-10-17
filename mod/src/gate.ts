/**
 * The gate (spec D8): while a terminal draws the mod, only the person answers an action request in a room the pane
 * shows. Claude's `bellman_send` of an `action_response` there passes only as the approval the person gave by pressing
 * Approve (`judgeSend`, src/mod/gate.ts): their Deny goes through the bridge's door, never through here, so no decline
 * of Claude's passes. Every other `bellman_send` and every other tool is none of its business.
 *
 * Two hooks stand at the two doors a `bellman_send` can come through: `tool.call`, the model's own tool call on any
 * server (the bridge's, a registered one, the connector's), and `mcp.call`, another plugin calling through the engine's
 * MCP connection. Each is written with a `.catch`, so a gate that fails before it has answered refuses the action
 * response it was asked about and lets everything else through: a broken gate stays shut, and breaks nothing else.
 *
 * It shuts only where the person can see the mod: a terminal is attached and the mod has drawn there. Everywhere else
 * (the desktop app, VS Code, `claude -p`, an older bridge that shows no room) approval stays in chat, as it is today.
 */
import { read } from "claude-code";
import type { EngineInterface, On } from "claude-code";
import { GATE_REASON, judgeSend, sendCallOf } from "../../src/mod/gate.js";
import type { GateVerdict, SendCall } from "../../src/mod/gate.js";
import { hasDrawn } from "./drawn";
import { approved, doors } from "./state";

/**
 * What the model is told while the gate is shut, as a section of its system prompt, since the instructions the bridge
 * gives it say to ask the person in chat. Fixed text: nothing a peer wrote reaches it.
 */
export const APPROVALS_SECTION =
  "Bellman action requests in the rooms shown in the Bellman pane are answered by the person there, not by you. Do not send an action_response for them yourself: you are told when the person approves one, and then you carry it out and answer it.";

/**
 * Whether a terminal is attached and the mod has drawn there. Cheap first: `hasDrawn` is a variable, and a session
 * that has drawn nothing never asks the engine anything, so a failing `session.surfaces` cannot shut it.
 */
export async function gateShut($: EngineInterface): Promise<boolean> {
  return hasDrawn() && (await $.session.surfaces()).includes("terminal");
}

/** The rooms the pane shows: those of every door's seats, as the last door tick read them. */
async function paneRooms($: EngineInterface): Promise<Set<string>> {
  return new Set((await read($, doors)).flatMap((door) => door.status?.seats.map((seat) => seat.session_id) ?? []));
}

async function judge($: EngineInterface, call: SendCall): Promise<GateVerdict> {
  return judgeSend(call, {
    shut: await gateShut($),
    paneRooms: await paneRooms($),
    approved: new Set(await read($, approved)),
  });
}

/** The hooks: the two doors of `bellman_send`, and the section that tells the model where approval happens. */
export function registerGate(on: On): void {
  on("tool.call", async ($, e, next) => {
    const call = sendCallOf(String(e.tool), e);
    if (call === undefined) return next(e);
    const verdict = await judge($, call);
    return verdict.allow ? next(e) : { deny: verdict.reason };
  }).catch(($, e, next) =>
    next.called ? next(e) : sendCallOf(String(e.tool), e)?.type === "action_response" ? { deny: GATE_REASON } : next(e),
  );

  on("mcp.call", async ($, e, next) => {
    const call = sendCallOf(e.tool, e.args);
    if (call === undefined) return next(e);
    const verdict = await judge($, call);
    return verdict.allow ? next(e) : { deny: verdict.reason };
  }).catch(($, e, next) =>
    next.called ? next(e) : sendCallOf(e.tool, e.args)?.type === "action_response" ? { deny: GATE_REASON } : next(e),
  );

  on("prompt.compose", async ($, e, next) => {
    const composed = await next(e);
    if (!(await gateShut($)) || (await paneRooms($)).size === 0) return composed;
    return { sections: [...composed.sections, { id: "bellman-mod:approvals", text: APPROVALS_SECTION, scope: "session" }] };
  });
}
