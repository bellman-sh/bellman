import { describe, expect, it } from "vitest";
import { GATE_REASON, judgeSend, sendCallOf, type GateContext, type SendCall } from "../src/mod/gate.js";

const ctx = (over: Partial<GateContext> = {}): GateContext => ({
  shut: true, paneRooms: new Set(["qs_room1"]), approved: new Set(), denying: new Set(), ...over,
});
const answer = (over: Partial<SendCall> = {}): SendCall => ({
  type: "action_response", session_id: "qs_room1", ref_id: "41", approved: true, ...over,
});

describe("sendCallOf", () => {
  it("knows bellman_send by any server's name, and nothing else", () => {
    for (const tool of ["bellman_send", "mcp__bellman__bellman_send", "mcp__plugin_bellman_bellman__bellman_send", "mcp__claude_ai_Bellman_sh__bellman_send"]) {
      expect(sendCallOf(tool, { type: "message", session_id: "s" })).toBeDefined();
    }
    for (const tool of ["bellman_sync", "mcp__x__bellman_sendx", "mcp__x__bellman_send_y"]) {
      expect(sendCallOf(tool, {})).toBeUndefined();
    }
  });
  it("reads approved only when it is a boolean", () => {
    expect(sendCallOf("bellman_send", { type: "action_response", session_id: "s", ref_id: "4", payload: { approved: "yes" } })?.approved).toBeUndefined();
  });
});

describe("judgeSend", () => {
  it.each([
    ["a message passes", answer({ type: "message" }), ctx(), true],
    ["anything passes while the gate is open", answer(), ctx({ shut: false }), true],
    ["a room the pane does not show passes", answer({ session_id: "qs_other" }), ctx(), true],
    ["an approval the person pressed passes", answer(), ctx({ approved: new Set(["qs_room1#41"]) }), true],
    ["an approval the person did not press is refused", answer(), ctx(), false],
    ["the mod's own decline passes", answer({ approved: false }), ctx({ denying: new Set(["qs_room1#41"]) }), true],
    ["Claude's decline is refused", answer({ approved: false }), ctx(), false],
    ["an answer without approved is refused", answer({ approved: undefined }), ctx(), false],
    ["an answer without ref_id is refused", answer({ ref_id: null }), ctx(), false],
  ] as const)("%s", (_, call, context, allowed) => {
    const verdict = judgeSend(call, context);
    expect(verdict.allow).toBe(allowed);
    if (!verdict.allow) expect(verdict.reason).toBe(GATE_REASON);
  });

  // The person's answer is the one they pressed: each press lets through its own answer only.
  const pressed = new Set(["qs_room1#41"]);
  it.each([
    ["a pressed Deny does not let an approval through", answer(), ctx({ denying: pressed })],
    ["a pressed Approve does not let a decline through", answer({ approved: false }), ctx({ approved: pressed })],
    ["an answer without approved is refused whatever was pressed", answer({ approved: undefined }), ctx({ approved: pressed, denying: pressed })],
  ] as const)("%s", (_, call, context) => {
    expect(judgeSend(call, context)).toEqual({ allow: false, reason: GATE_REASON });
  });
});

describe("GATE_REASON", () => {
  // The other tests compare a refusal to the constant, so only this one sees its words change.
  it("tells Claude, in fixed words, where the person answers", () => {
    expect(GATE_REASON).toBe(
      "Only the person answers a Bellman action request in this room. They approve or decline it in the Bellman pane, and you are told when they approve.",
    );
  });
});

describe("the call as bellman_send reads it", () => {
  const args = { type: "action_response", ref_id: "41", payload: { approved: true } };
  const pressed = ctx({ approved: new Set(["qs_room1#41"]) });

  it("judges an answer that names the room by its alias room_id like any other", () => {
    const call = sendCallOf("bellman_send", { ...args, room_id: "qs_room1" })!;
    expect(judgeSend(call, ctx()).allow).toBe(false);
    expect(judgeSend(call, pressed).allow).toBe(true);
  });
  it("takes session_id over room_id when both are given, as the tool does", () => {
    // The tool answers qs_other here, a room the pane does not show.
    expect(judgeSend(sendCallOf("bellman_send", { ...args, session_id: "qs_other", room_id: "qs_room1" })!, ctx()).allow).toBe(true);
    expect(judgeSend(sendCallOf("bellman_send", { ...args, session_id: "qs_room1", room_id: "qs_other" })!, ctx()).allow).toBe(false);
  });
  it("does not take a tool that merely ends in the same letters", () => {
    for (const tool of ["xbellman_send", "mcp__x__not_bellman_send"]) expect(sendCallOf(tool, args)).toBeUndefined();
  });
});
