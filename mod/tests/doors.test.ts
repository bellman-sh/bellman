import { expect, test } from "claude-code/testing";
import type { DoorStatus } from "../types";
import { STATUS, tick, world } from "./harness";

test("finds the door through bellman_whoami and keeps the bridge's status", async ($, on) => {
  const w = await world($, on);
  await tick(w);
  expect(w.state.doors).toEqual([{ server: "bellman", socketPath: w.door, status: STATUS, error: null }]);
});

test("a bridge that restarts is found again on a later tick", async ($, on) => {
  const w = await world($, on);
  await tick(w);
  w.doorDown = true;
  await tick(w);
  expect(w.state.doors?.[0]).toMatchObject({ socketPath: null, status: null, error: expect.any(String) });
  w.doorDown = false;
  w.door = "/tmp/bellman-door-2.sock";
  await tick(w);
  expect(w.state.doors?.[0]).toMatchObject({ socketPath: "/tmp/bellman-door-2.sock", status: STATUS, error: null });
});

test("a bridge older than the door is kept with no socket, and no door is read for it", async ($, on) => {
  const w = await world($, on, { door: null });
  await tick(w);
  expect(w.state.doors).toEqual([{ server: "bellman", socketPath: null, status: null, error: null }]);
});

test("the model's own calls of the mod's tools keep their permission check", async ($, on) => {
  await world($, on);
  for (const tool of ["bellman_whoami", "bellman_rooms", "bellman_surface", "bellman_send"]) {
    const name = `mcp__bellman__${tool}`;
    // Asked from the test's `$`, the engine's own: the mod allows only the calls it makes, and leaves this to the verdict beneath.
    expect(await $.tool.check({ tool: name, input: {} })).toEqual({ decision: "ask", reason: `the person is asked about ${name}` });
  }
});

test("a bridge that connects later is found on the next tick, and each door is read through its own socket", async ($, on) => {
  const w = await world($, on);
  await tick(w);
  const status: DoorStatus = { ...STATUS, delivery: "channel", seats: [{ session_id: "qs_room2", member_id: "m-me2", retrying: false }] };
  w.second = { server: "plugin_bellman_bellman", door: "/tmp/bellman-door-9.sock", status, rooms: [] };
  await tick(w);
  expect(w.state.doors).toEqual([
    { server: "bellman", socketPath: w.door, status: STATUS, error: null },
    { server: "plugin_bellman_bellman", socketPath: "/tmp/bellman-door-9.sock", status, error: null },
  ]);
  w.second = undefined;
  await tick(w);
  expect(w.state.doors).toEqual([{ server: "bellman", socketPath: w.door, status: STATUS, error: null }]);
});
