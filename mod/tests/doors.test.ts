import { expect, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { DoorStatus } from "../types";
import { STATUS, tick, world } from "./harness";
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

test("a bridge that restarts is found again at the next prompt, not by a tick alone", async ($, on) => {
  const w = await world($, on);
  await tick(w);
  w.doorDown = true;
  await tick(w);
  expect(w.state.doors?.[0]).toMatchObject({ socketPath: null, status: null, error: expect.any(String) });
  w.doorDown = false;
  w.door = "/tmp/bellman-door-2.sock";
  for (let i = 0; i < 3; i++) await tick(w);
  // A tick asks nothing: Claude Code refuses the mod's own tool call from a timer.
  expect(asked(w)).toBe(1);
  expect(w.state.doors?.[0]).toMatchObject({ socketPath: null, status: null });
  await types($);
  expect(asked(w)).toBe(2);
  await tick(w);
  expect(w.state.doors).toEqual([{ server: "bellman", socketPath: "/tmp/bellman-door-2.sock", status: STATUS, error: null }]);
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
  expect(w.state.doors).toEqual([
    { server: "bellman", socketPath: w.door, status: { ...STATUS, has_sign_in: false }, error: null },
    { server: "plugin_bellman_bellman", socketPath: "/tmp/bellman-door-10.sock", status: null, error: null },
  ]);
});

test("a door found at a prompt while a tick is reading keeps the socket it was found at", async ($, on) => {
  const status: DoorStatus = { ...structuredClone(STATUS), seats: [{ session_id: "qs_room2", member_id: "m-me2", retrying: false }] };
  const w = await world($, on, { second: { server: "plugin_bellman_bellman", door: "/tmp/bellman-door-9.sock", status, rooms: [] } });
  await tick(w);
  // The second bridge restarts: the tick that finds its old socket refusing leaves the asking to the next hook.
  w.second!.door = "/tmp/bellman-door-10.sock";
  await tick(w);
  expect(w.state.doors?.[1]).toMatchObject({ socketPath: null, error: expect.any(String) });
  // A tick held reading the first door while the person's prompt finds the second's, then let go.
  let release = (): void => undefined;
  w.held = new Promise((resolve) => (release = resolve));
  await tick(w);
  await types($);
  w.held = null;
  release();
  await w.clock.settle();
  expect(w.state.doors?.[1]).toEqual({ server: "plugin_bellman_bellman", socketPath: "/tmp/bellman-door-10.sock", status: null, error: null });
  await tick(w);
  expect(w.state.doors?.[1]).toEqual({ server: "plugin_bellman_bellman", socketPath: "/tmp/bellman-door-10.sock", status, error: null });
});
