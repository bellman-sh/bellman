/**
 * The doors: each local bridge's, found through its `bellman_whoami` and read over its Unix socket.
 *
 * A bridge is any MCP server that lists `bellman_whoami`, whatever it is registered as (the plugin's, or one
 * the person added); the claude.ai connector lists none, so its rooms are not the mod's (spec D1). The tool's
 * result names the bridge's door (`describeSelf` in src/bridge.ts), and the door answers `GET /status`
 * (src/door.ts).
 *
 * Every tick reads every door. A door that fails loses its socket, and the next tick asks its bridge again:
 * a bridge that restarted has a new pid, so a new socket. The bridges are listed on every tick too, since one
 * may connect after the session starts.
 */
import { read, update } from "claude-code";
import type { EngineInterface, On } from "claude-code";
import { DOOR_POLL_MS } from "../../src/mod/view.js";
import type { DoorStatus, DoorView } from "../types";
import { doors } from "./state";

/** `bellman_whoami` under any server's name: `mcp__<server>__bellman_whoami`. */
const WHOAMI = /^mcp__(.+)__bellman_whoami$/;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** One bridge's door, as its `bellman_whoami` names it. A bridge older than the door names none. */
async function ask($: EngineInterface, server: string): Promise<DoorView> {
  try {
    const result = await $.mcp.call(server, "bellman_whoami");
    if (result.isError) throw new Error(result.content.map((c) => c.text ?? "").join(" ") || "bellman_whoami failed");
    const door = (result.structuredContent as { door?: unknown } | undefined)?.door;
    return { server, socketPath: typeof door === "string" ? door : null, status: null, error: null };
  } catch (error) {
    return { server, socketPath: null, status: null, error: message(error) };
  }
}

/**
 * Every local bridge in the session, by the servers listing `bellman_whoami` now, with its door. A door already
 * `known` with its socket is kept as it is; every other bridge is asked.
 */
export async function discover($: EngineInterface, known: readonly DoorView[] = []): Promise<DoorView[]> {
  const servers = (await $.tool.list()).flatMap((tool) => WHOAMI.exec(tool.name)?.[1] ?? []);
  return Promise.all(servers.map((server) => known.find((d) => d.server === server && d.socketPath !== null) ?? ask($, server)));
}

/**
 * Each door's status, read over its socket. A door that cannot be read (refused, gone, or answering anything
 * but a 2xx) gets the error and loses its socket and its status, so the next tick asks its bridge again. A
 * door with no socket is not read.
 */
export async function pollDoors($: EngineInterface, list: readonly DoorView[]): Promise<DoorView[]> {
  return Promise.all(
    list.map(async (door): Promise<DoorView> => {
      if (door.socketPath === null) return door;
      try {
        const res = await $.http.fetch("http://door/status", { socketPath: door.socketPath });
        if (!res.ok) throw new Error(`the door answered ${res.status}`);
        // ponytail: read as DoorStatus version 1 unchecked; check `version` the day the door has a second.
        return { ...door, status: JSON.parse(res.text) as DoorStatus, error: null };
      } catch (error) {
        return { ...door, socketPath: null, status: null, error: message(error) };
      }
    }),
  );
}

const subscribers: ((list: DoorView[]) => Promise<void>)[] = [];

/** Runs `fn` after every door tick, with the doors as that tick left them in `doors`. */
export function onTick(fn: (list: DoorView[]) => Promise<void>): void {
  subscribers.push(fn);
}

/** True while a tick runs: one that outlasts `DOOR_POLL_MS` (a door slow to answer) is not stacked on. */
let ticking = false;

async function tick($: EngineInterface): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const list = await pollDoors($, await discover($, await read($, doors)));
    await update($, doors, () => list);
    for (const fn of subscribers) {
      // Each on its own: one that throws stops none of the others.
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

/** On `session.start`: finds the doors, then reads them every `DOOR_POLL_MS` for the session's life. */
export function startDoors(on: On): void {
  on("session.start", async ($, e, next) => {
    const found = await discover($);
    await update($, doors, () => found);
    $.clock.every(DOOR_POLL_MS, () => void tick($));
    return next(e);
  });
}
