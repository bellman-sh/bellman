import { expect, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { McpToolName, On } from "claude-code";
import { APPROVALS_SECTION, GATE_REASON, approvalKey } from "../hooks/register.mjs";
import { ENGINE, ROOMS, STATUS, band, tick, world } from "./harness";
import type { World } from "./harness";

/** What a `bellman_send` that ran answers beneath the mod (the harness's own success). */
const RAN = { result: { structuredContent: { cursor: 99 } } };
const REFUSED = { deny: GATE_REASON };

/** A world in which the terminal has drawn the mod's band: the gate is shut for `qs_room1`, the room the pane shows. */
async function shut($: Engine, on: On): Promise<World> {
  const w = await world($, on);
  await tick(w);
  await band($);
  return w;
}

/** Claude's answer to the action request at cursor 5, approving it: what `over` changes is changed. */
const send = ($: Engine, over: Record<string, unknown> = {}, tool: McpToolName = "mcp__bellman__bellman_send") =>
  $.tool.call({ tool, type: "action_response", session_id: "qs_room1", ref_id: "5", payload: { approved: true }, ...over });

const compose = ($: Engine) =>
  $.prompt.compose({ model: "m", promptModel: "m", surfaces: ["terminal"], tools: [], outputStyle: null, traits: [] }).then((r) => r.sections);

test("refuses Claude's unapproved answer in a pane room while a terminal draws the band", async ($, on) => {
  await shut($, on);
  expect(await send($)).toEqual(REFUSED);
  // Claude's decline is the person's to give too, and a room named by its alias is the same room.
  expect(await send($, { payload: { approved: false } })).toEqual(REFUSED);
  expect(await send($, { session_id: undefined, room_id: "qs_room1" })).toEqual(REFUSED);
  // On any server: the connector's tool too, which the harness does not answer, so a call that got through would throw.
  expect(await send($, {}, "mcp__claude_ai_Bellman_sh__bellman_send")).toEqual(REFUSED);
});

test("passes a message, and an answer in a room the pane does not show", async ($, on) => {
  await shut($, on);
  expect(await send($, { type: "message", payload: { text: "hi" } })).toMatchObject(RAN);
  expect(await send($, { session_id: "qs_other" })).toMatchObject(RAN);
});

test("passes the approval the person gave, only that one, and no decline of Claude's", async ($, on) => {
  const w = await world($, on);
  // The person approved request 5: the key the press leaves.
  w.seed.approved = [approvalKey("qs_room1", "5")];
  await tick(w);
  await band($);
  expect(await send($)).toMatchObject(RAN);
  expect(await send($, { ref_id: "6" })).toEqual(REFUSED);
  // The person's Deny answers the room through the bridge's door, never through Claude, so no decline passes.
  expect(await send($, { payload: { approved: false } })).toEqual(REFUSED);
  expect(await send($, { ref_id: "7", payload: { approved: false } })).toEqual(REFUSED);
});

test("gates the rooms of every bridge's door", async ($, on) => {
  const room2 = { ...structuredClone(ROOMS[0]!), session_id: "qs_room2", your_member_id: "m-me2" };
  const w = await world($, on, {
    second: {
      server: "plugin_bellman_bellman",
      door: "/tmp/bellman-door-9.sock",
      status: { ...structuredClone(STATUS), seats: [{ session_id: "qs_room2", member_id: "m-me2", retrying: false }] },
      rooms: [room2],
    },
  });
  await tick(w);
  await band($);
  // Each room is the pane's, whichever bridge's door lists its seat and whichever server the answer goes through.
  expect(await send($, { session_id: "qs_room2" }, "mcp__plugin_bellman_bellman__bellman_send")).toEqual(REFUSED);
  expect(await send($, { session_id: "qs_room1" }, "mcp__plugin_bellman_bellman__bellman_send")).toEqual(REFUSED);
  expect(await send($, { session_id: "qs_room3" })).toMatchObject(RAN);
});

test("stays open where no terminal draws Approve", async ($, on) => {
  const w = await shut($, on);
  w.surfaces = ["desktop"];
  expect(await send($)).toMatchObject(RAN);
});

test("stays open until the mod has drawn", async ($, on) => {
  // The door has been read, so the pane's room is known; nothing has drawn.
  const w = await world($, on);
  await tick(w);
  expect(await send($)).toMatchObject(RAN);
});

test(
  "refuses another plugin's unapproved answer through mcp.call",
  {
    plugins: [
      {
        name: "other",
        register(on) {
          // A plugin that answers a Bellman request through the engine's MCP connection, not through a tool call of the model's.
          on("tool.call", { tool: "mcp__other__send" }, async ($, e) => {
            const { tool: _tool, tool_use_id: _id, ...args } = e;
            try {
              await $.mcp.call("bellman", "bellman_send", args);
              return { result: { ran: true, why: "" } };
            } catch (error) {
              // The engine prefixes a refusal with the plugin's name and the call it refused.
              return { result: { ran: false, why: error instanceof Error ? error.message : String(error) } };
            }
          });
        },
      },
    ],
  },
  async ($, on) => {
    const w = await shut($, on);
    const answer = { type: "action_response", session_id: "qs_room1", ref_id: "5", payload: { approved: true } };
    const asked = (over: Record<string, unknown> = {}) => $.tool.call({ tool: "mcp__other__send", ...answer, ...over });
    const why = (r: Awaited<ReturnType<typeof asked>>) => (r.result as { why: string }).why;

    const refused = await asked();
    expect(refused).toMatchObject({ result: { ran: false } });
    expect(why(refused)).toContain(GATE_REASON);
    expect(await asked({ type: "message" })).toEqual({ result: { ran: true, why: "" } });
    // Of the two, only the message reached the bridge.
    expect(w.calls.filter((c) => c.tool === "bellman_send").map((c) => c.args.type)).toEqual(["message"]);

    // A gate that fails here too shuts the action response alone.
    w.surfacesDown = true;
    const failed = await asked();
    expect(failed).toMatchObject({ result: { ran: false } });
    expect(why(failed)).toContain(GATE_REASON);
    expect(await asked({ type: "message" })).toEqual({ result: { ran: true, why: "" } });
  },
);

test("a failure inside the gate shuts action responses alone", async ($, on) => {
  const w = await shut($, on);
  w.surfacesDown = true;
  expect(await send($)).toEqual(REFUSED);
  // Nothing else is the gate's business: not a message, not another tool.
  expect(await send($, { type: "message", payload: { text: "hi" } })).toMatchObject(RAN);
  expect(await $.tool.call({ tool: "Bash", command: "true" })).toMatchObject({ result: { content: [{ text: "ran" }] } });
});

test("adds the approvals section only while shut", async ($, on) => {
  const w = await world($, on);
  await tick(w);
  expect((await compose($)).map((s) => s.id)).toEqual(["intro"]);
  await band($);
  // After the engine's own sections, which it leaves as they are.
  expect((await compose($)).map((s) => s.id)).toEqual(["intro", "bellman-mod:approvals"]);
  expect((await compose($)).at(-1)).toEqual({
    id: "bellman-mod:approvals",
    text: "Bellman action requests in the rooms shown in the Bellman pane are answered by the person there, not by you. Do not send an action_response for them yourself: you are told when the person approves one, and then you carry it out and answer it.",
    scope: "session",
  });
  expect(APPROVALS_SECTION).toBe((await compose($)).at(-1)?.text);
  w.surfaces = ["desktop"];
  expect((await compose($)).map((s) => s.id)).toEqual(["intro"]);
});

test("adds no approvals section when the pane shows no room", async ($, on) => {
  const w = await shut($, on);
  w.status.seats = [];
  await tick(w);
  expect((await compose($)).map((s) => s.id)).toEqual(["intro"]);
});

test("an older bridge: no rooms, a status line naming the update, and the gate open", async ($, on) => {
  // Review Focus 1: its bellman_whoami names no door.
  const w = await world($, on, { door: null });
  await tick(w);
  expect(w.statuses.at(-1)).toBe("Bellman: update the bridge to see your rooms here");
  expect(await (await band($)).drawn()).toMatchObject(ENGINE);
  expect(await send($)).toMatchObject(RAN);
});
