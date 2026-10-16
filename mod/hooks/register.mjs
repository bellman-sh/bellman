// mod/src/doors.ts
import { read, update } from "claude-code";

// src/action-state.ts
var ACTION_REQUEST_TTL_MS = 30 * 6e4;

// src/mod/view.ts
var DOOR_POLL_MS = 2e3;
var ROOMS_POLL_MS = 15e3;

// mod/src/state.ts
import { atom } from "claude-code";
var doors = atom({ plugin: "bellman-mod", key: "doors" }, []);

// mod/src/doors.ts
var WHOAMI = /^mcp__(.+)__bellman_whoami$/;
var message = (error) => error instanceof Error ? error.message : String(error);
async function ask($, server) {
  try {
    const result = await $.mcp.call(server, "bellman_whoami");
    if (result.isError) throw new Error(result.content.map((c) => c.text ?? "").join(" ") || "bellman_whoami failed");
    const door = result.structuredContent?.door;
    return { server, socketPath: typeof door === "string" ? door : null, status: null, error: null };
  } catch (error) {
    return { server, socketPath: null, status: null, error: message(error) };
  }
}
async function discover($, known = []) {
  const servers = (await $.tool.list()).flatMap((tool) => WHOAMI.exec(tool.name)?.[1] ?? []);
  return Promise.all(servers.map((server) => known.find((d) => d.server === server && d.socketPath !== null) ?? ask($, server)));
}
async function pollDoors($, list) {
  return Promise.all(
    list.map(async (door) => {
      if (door.socketPath === null) return door;
      try {
        const res = await $.http.fetch("http://door/status", { socketPath: door.socketPath });
        if (!res.ok) throw new Error(`the door answered ${res.status}`);
        return { ...door, status: JSON.parse(res.text), error: null };
      } catch (error) {
        return { ...door, socketPath: null, status: null, error: message(error) };
      }
    })
  );
}
var subscribers = [];
var ticking = false;
async function tick($) {
  if (ticking) return;
  ticking = true;
  try {
    const list = await pollDoors($, await discover($, await read($, doors)));
    await update($, doors, () => list);
    for (const fn of subscribers) {
      try {
        await fn(list);
      } catch (error) {
        $.ui.log(`bellman-mod: ${message(error)}`, { to: "debug" });
      }
    }
  } finally {
    ticking = false;
  }
}
function startDoors(on) {
  on("session.start", async ($, e, next) => {
    const found = await discover($);
    await update($, doors, () => found);
    $.clock.every(DOOR_POLL_MS, () => void tick($));
    return next(e);
  });
}

// mod/src/register.tsx
function register(on) {
  startDoors(on);
}
export {
  DOOR_POLL_MS,
  ROOMS_POLL_MS,
  register
};
