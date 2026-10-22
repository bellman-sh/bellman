import { expect, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import { GATE_REASON, WAKE_TEXT } from "../hooks/register.mjs";
import type { DoorStatus } from "../types";
import { ENGINE, STATUS, band, peerEvent, roomsTick, tick, world } from "./harness";
import type { World } from "./harness";

/** The person presses Enter in the composer: a `prompt.submit` of the mod's own hooks, where its call is allowed. */
const types = ($: Engine) => $.prompt.submit({ text: "hello", origin: { kind: "composer" }, wait: false });
const startTurn = ($: Engine, turnId: string) => $.turn.start({ text: "x", turnId });
const endTurn = ($: Engine, turnId: string) => $.turn.complete({ reason: "answer", answer: "", durationMs: 1, isAborted: false, turnId });

/** How many times the mod has asked a bridge for its door. */
const asked = (w: World, server = "bellman") => w.calls.filter((c) => c.server === server && c.tool === "bellman_whoami").length;

test("finds the door through bellman_whoami and keeps the bridge's status", async ($, on) => {
  const w = await world($, on);
  await tick(w);
  expect(w.state.doors).toEqual([{ server: "bellman", socketPath: w.door, status: STATUS, error: null }]);
});

test("a bridge that restarts keeps its rooms while its old socket refuses, and is read through the new one from the next prompt", async ($, on) => {
  const w = await world($, on);
  await tick(w);
  // The bridge restarts: the socket its door had refuses from now on, and its bellman_whoami names a new one.
  w.door = "/tmp/bellman-door-2.sock";
  for (let i = 0; i < 3; i++) await tick(w);
  // Each tick read the old socket again, and the door keeps it, and the last status it gave.
  expect(w.state.doors).toEqual([{ server: "bellman", socketPath: "/tmp/bellman-door-1.sock", status: STATUS, error: expect.any(String) }]);
  // A tick asks nothing: Claude Code refuses the mod's own tool call from a timer.
  expect(asked(w)).toBe(1);
  await types($);
  expect(asked(w)).toBe(2);
  // Named and not yet read: the last status stands, and the error, until the new socket answers.
  expect(w.state.doors).toEqual([{ server: "bellman", socketPath: "/tmp/bellman-door-2.sock", status: STATUS, error: expect.any(String) }]);
  await tick(w);
  expect(w.state.doors).toEqual([{ server: "bellman", socketPath: "/tmp/bellman-door-2.sock", status: STATUS, error: null }]);
});

test("a door read that fails once keeps the door, its rooms and the gate shut, and the next read that answers wakes the session", async ($, on) => {
  // The branch review's probe: one tick finds the socket refusing, and from the next it answers again.
  const w = await world($, on);
  await tick(w);
  await band($);
  const answer = () =>
    $.tool.call({ tool: "mcp__bellman__bellman_send", type: "action_response", session_id: "qs_room1", ref_id: "5", payload: { approved: true } });
  w.doorDown = true;
  await tick(w);
  expect(w.state.doors).toEqual([{ server: "bellman", socketPath: w.door, status: STATUS, error: expect.any(String) }]);
  expect(await answer()).toEqual({ deny: GATE_REASON });
  w.doorDown = false;
  w.status.waiting = [{ session_id: "qs_room1", interrupting: 1, ambient: 0 }];
  for (let i = 0; i < 30; i++) {
    await tick(w);
    expect(await answer()).toEqual({ deny: GATE_REASON });
  }
  expect(w.submitted).toEqual([WAKE_TEXT]);
  expect(w.state.doors).toEqual([{ server: "bellman", socketPath: w.door, status: w.status, error: null }]);
});

test("a turn's start or its end asks again too, and no hook asks while every door answers", async ($, on) => {
  const w = await world($, on);
  await tick(w);
  await startTurn($, "t1");
  await endTurn($, "t1");
  await types($);
  await tick(w);
  expect(asked(w)).toBe(1);
  const hooks = [() => startTurn($, "t2"), () => endTurn($, "t2")];
  for (const [i, hook] of hooks.entries()) {
    // The bridge restarts: the socket its door had refuses on the next tick.
    w.door = `/tmp/bellman-door-${i + 3}.sock`;
    await tick(w);
    await tick(w);
    expect(asked(w)).toBe(i + 1);
    await hook();
    await tick(w);
    expect(w.state.doors).toEqual([{ server: "bellman", socketPath: w.door, status: STATUS, error: null }]);
  }
  expect(asked(w)).toBe(3);
});

test("a bridge whose bellman_whoami never answers holds the person's prompt, and a turn's start and end, 1.5 s at most", async ($, on) => {
  const w = await world($, on);
  await tick(w);
  // The bridge restarts and hangs: the tick that finds its old socket refusing leaves the asking to the next hook.
  w.door = "/tmp/bellman-door-2.sock";
  await tick(w);
  w.asking = new Promise(() => undefined);
  const typed = types($);
  await w.clock.advance(1_499);
  expect(w.submitted).toEqual([]);
  await w.clock.advance(1);
  expect(w.submitted).toEqual(["hello"]);
  await typed;
  const passed: string[] = [];
  void startTurn($, "t1").then(() => passed.push("turn.start"));
  await w.clock.advance(1_500);
  void endTurn($, "t1").then(() => passed.push("turn.complete"));
  await w.clock.advance(1_500);
  expect(passed).toEqual(["turn.start", "turn.complete"]);
});

test("a bridge older than the door is kept with no socket, no door is read for it, and it is not asked again", async ($, on) => {
  const w = await world($, on, { door: null });
  await tick(w);
  expect(w.state.doors).toEqual([{ server: "bellman", socketPath: null, status: null, error: null }]);
  await types($);
  await startTurn($, "t1");
  await endTurn($, "t1");
  await tick(w);
  expect(asked(w)).toBe(1);
  expect(w.fetched).toEqual([]);
});

test("the model's own calls of the mod's tools keep their permission check", async ($, on) => {
  await world($, on);
  for (const tool of ["bellman_whoami", "bellman_rooms", "bellman_surface", "bellman_send"]) {
    const name = `mcp__bellman__${tool}`;
    // Asked from the test's `$`, the engine's own: the mod allows only the calls it makes, and leaves this to the verdict beneath.
    expect(await $.tool.check({ tool: name, input: {} })).toEqual({ decision: "ask", reason: `the person is asked about ${name}` });
  }
});

test("a bridge that connects later is found at the next prompt, and each door is read through its own socket", async ($, on) => {
  const w = await world($, on);
  await tick(w);
  const status: DoorStatus = { ...STATUS, delivery: "channel", seats: [{ session_id: "qs_room2", member_id: "m-me2", retrying: false }] };
  w.second = { server: "plugin_bellman_bellman", door: "/tmp/bellman-door-9.sock", status, rooms: [] };
  for (let i = 0; i < 3; i++) await tick(w);
  // Listed and not asked: a tick leaves the asking to the mod's next hook.
  expect(asked(w, "plugin_bellman_bellman")).toBe(0);
  expect(w.state.doors).toEqual([{ server: "bellman", socketPath: w.door, status: STATUS, error: null }]);
  await types($);
  await tick(w);
  expect(w.state.doors).toEqual([
    { server: "bellman", socketPath: w.door, status: STATUS, error: null },
    { server: "plugin_bellman_bellman", socketPath: "/tmp/bellman-door-9.sock", status, error: null },
  ]);
  w.second = undefined;
  await tick(w);
  expect(w.state.doors).toEqual([{ server: "bellman", socketPath: w.door, status: STATUS, error: null }]);
});

test("a tick that reads while a prompt is asking keeps what it read", async ($, on) => {
  const status: DoorStatus = { ...structuredClone(STATUS), seats: [{ session_id: "qs_room2", member_id: "m-me2", retrying: false }] };
  const w = await world($, on, { second: { server: "plugin_bellman_bellman", door: "/tmp/bellman-door-9.sock", status, rooms: [] } });
  await tick(w);
  w.second!.door = "/tmp/bellman-door-10.sock";
  await tick(w);
  // The person's prompt asks the second bridge, which is slow to answer; meanwhile a tick reads the first door afresh.
  let release = (): void => undefined;
  w.asking = new Promise((resolve) => (release = resolve));
  const typed = types($);
  await w.clock.settle();
  w.status.has_sign_in = false;
  await tick(w);
  w.asking = null;
  release();
  await typed;
  await w.clock.settle();
  // The second door takes the socket its bridge named, and keeps the last status it gave until that socket answers.
  expect(w.state.doors).toEqual([
    { server: "bellman", socketPath: w.door, status: { ...STATUS, has_sign_in: false }, error: null },
    { server: "plugin_bellman_bellman", socketPath: "/tmp/bellman-door-10.sock", status, error: expect.any(String) },
  ]);
});

test("a door found at a prompt while a tick is reading keeps the socket it was found at", async ($, on) => {
  const status: DoorStatus = { ...structuredClone(STATUS), seats: [{ session_id: "qs_room2", member_id: "m-me2", retrying: false }] };
  const w = await world($, on, { second: { server: "plugin_bellman_bellman", door: "/tmp/bellman-door-9.sock", status, rooms: [] } });
  await tick(w);
  // The second bridge restarts: the tick that finds its old socket refusing leaves the asking to the next hook.
  w.second!.door = "/tmp/bellman-door-10.sock";
  await tick(w);
  expect(w.state.doors?.[1]).toEqual({ server: "plugin_bellman_bellman", socketPath: "/tmp/bellman-door-9.sock", status, error: expect.any(String) });
  // A tick held reading the first door while the person's prompt finds the second's, then let go.
  let release = (): void => undefined;
  w.held = new Promise((resolve) => (release = resolve));
  await tick(w);
  await types($);
  w.held = null;
  release();
  await w.clock.settle();
  expect(w.state.doors?.[1]).toEqual({ server: "plugin_bellman_bellman", socketPath: "/tmp/bellman-door-10.sock", status, error: expect.any(String) });
  await tick(w);
  expect(w.state.doors?.[1]).toEqual({ server: "plugin_bellman_bellman", socketPath: "/tmp/bellman-door-10.sock", status, error: null });
});

test("a bridge whose bellman_whoami fails while its door cannot be read keeps the door, its rooms and the gate shut", async ($, on) => {
  const w = await world($, on);
  await tick(w);
  await band($);
  w.doorDown = true;
  await tick(w);
  w.whoamiFails = true;
  await types($);
  expect(asked(w)).toBe(2);
  // A failed answer names nothing: the socket stays the one to read again, and the last status stands.
  expect(w.state.doors).toEqual([{ server: "bellman", socketPath: w.door, status: STATUS, error: expect.any(String) }]);
  const answer = await $.tool.call({ tool: "mcp__bellman__bellman_send", type: "action_response", session_id: "qs_room1", ref_id: "5", payload: { approved: true } });
  expect(answer).toEqual({ deny: GATE_REASON });
  w.doorDown = false;
  await tick(w);
  expect(w.state.doors).toEqual([{ server: "bellman", socketPath: w.door, status: STATUS, error: null }]);
});

test("a bridge that comes back without a door drops its rooms, out of the view and the gate, and the status line says to update it", async ($, on) => {
  const w = await world($, on);
  await tick(w);
  await band($);
  const answer = () =>
    $.tool.call({ tool: "mcp__bellman__bellman_send", type: "action_response", session_id: "qs_room1", ref_id: "5", payload: { approved: true } });
  // The bridge restarts older than the door: its socket refuses, and its bellman_whoami answers naming none.
  w.door = null;
  await tick(w);
  // Unreachable, the door keeps its rooms and the gate shut on them, until the bridge says otherwise.
  expect(await answer()).toEqual({ deny: GATE_REASON });
  await types($);
  expect(w.state.doors).toEqual([{ server: "bellman", socketPath: null, status: null, error: null }]);
  await tick(w);
  expect(w.statuses.at(-1)).toBe("Bellman: update the bridge to see your rooms here");
  expect(await (await band($)).drawn()).toMatchObject(ENGINE);
  expect(await answer()).toMatchObject({ result: { structuredContent: { cursor: 99 } } });
  // Asked once more and no more: a bridge older than the door is asked once.
  await types($);
  expect(asked(w)).toBe(2);
});

test("each door's recent events are kept as the lines they draw: fifty of the longest messages keep doors small, and the toast reads the same", async ($, on) => {
  const w = await world($, on);
  await tick(w);
  w.status.recent = Array.from({ length: 50 }, (_, i) => peerEvent({ cursor: i + 2, payload: { text: `${i + 2} ${"y".repeat(19_980)}` } }));
  await tick(w);
  expect(JSON.stringify(w.state.doors).length).toBeLessThan(50_000);
  const recent = w.state.doors?.[0]?.status?.recent ?? [];
  expect(recent.map((e) => e.cursor)).toEqual(Array.from({ length: 50 }, (_, i) => i + 2));
  expect(recent.every((e) => e.payload === undefined && e.line?.startsWith(`${e.cursor} yyy`))).toBe(true);
  expect(w.toasts).toHaveLength(1);
  expect(w.toasts[0]).toMatch(/^ada in swarm _room1: 51 y+…$/);
});

test("a rooms read asks each room's log only for what is new past the newest event held", async ($, on) => {
  const w = await world($, on);
  w.log.qs_room1 = { events: [peerEvent({ cursor: 4 }), peerEvent({ cursor: 7, payload: { text: "later" } })], cursor: 7 };
  await tick(w);
  const reads = () => w.fetched.filter((f) => f.path === "/rooms/qs_room1/events");
  // None held yet: the newest page.
  expect(reads()).toEqual([{ socket: w.door, method: "GET", path: "/rooms/qs_room1/events" }]);
  w.log.qs_room1.events.push(peerEvent({ cursor: 9, payload: { text: "new" } }));
  await roomsTick(w);
  expect(reads().at(-1)).toEqual({ socket: w.door, method: "GET", path: "/rooms/qs_room1/events", after: "7" });
  expect(w.state.logs?.qs_room1?.map((e) => e.cursor)).toEqual([4, 7, 9]);
});

test("a rooms read that never answers holds up no tick: the next one still toasts, and no second read starts", async ($, on) => {
  const w = await world($, on);
  // The door asks the server for the rooms, and the server never answers.
  w.roomsHeld = new Promise(() => undefined);
  await tick(w);
  w.status.recent = [peerEvent({ cursor: 2 })];
  await tick(w);
  // No rooms read has finished, so the room is named by the end of its id.
  expect(w.toasts).toEqual(["ada in room _room1: hello"]);
  await roomsTick(w);
  expect(w.fetched.filter((f) => f.path === "/rooms")).toHaveLength(1);
});
