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
 *
 * The rooms the seats are in come from each bridge's `bellman_rooms`, every `ROOMS_POLL_MS` and on any tick
 * whose seats changed, so a room Claude just joined shows within a tick.
 */
import { read, update } from "claude-code";
import type { EngineInterface } from "claude-code";
import { DOOR_POLL_MS, ROOMS_POLL_MS } from "../../src/mod/view.js";
import type { DoorStatus, DoorView, RoomView } from "../types";
import { doors, rooms } from "./state";

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

/**
 * The rooms the doors' seats are in, each from its own bridge's `bellman_rooms`: a read that moves nobody's
 * `lastSeenAt`. Only a door that lists a seat is asked; a bridge whose call fails keeps the rooms it had.
 */
export async function readRooms($: EngineInterface, list: readonly DoorView[], known: readonly RoomView[]): Promise<RoomView[]> {
  const each = await Promise.all(
    list.map(async (door): Promise<RoomView[]> => {
      const seated = new Set(door.status?.seats.map((s) => s.session_id));
      if (seated.size === 0) return [];
      try {
        const result = await $.mcp.call(door.server, "bellman_rooms");
        if (result.isError) throw new Error(result.content.map((c) => c.text ?? "").join(" ") || "bellman_rooms failed");
        // ponytail: read as roomSummary's shape unchecked; it is our own server's answer.
        const listed = (result.structuredContent as { rooms?: Omit<RoomView, "server">[] } | undefined)?.rooms ?? [];
        return listed.filter((r) => seated.has(r.session_id)).map((r) => ({ ...r, server: door.server }));
      } catch (error) {
        $.ui.log(`bellman-mod: bellman_rooms on ${door.server}: ${message(error)}`, { to: "debug" });
        return known.filter((r) => r.server === door.server && seated.has(r.session_id));
      }
    }),
  );
  return each.flat();
}

/** Which seats the doors list, as one string: what the last rooms read was for. */
const seatsKey = (list: readonly DoorView[]): string =>
  JSON.stringify(list.flatMap((d) => (d.status?.seats ?? []).map((s) => [d.server, s.session_id])).sort());
let roomsFor: string | null = null;

async function refreshRooms($: EngineInterface, list: readonly DoorView[]): Promise<void> {
  roomsFor = seatsKey(list);
  const fresh = await readRooms($, list, await read($, rooms));
  await update($, rooms, () => fresh);
}

const subscribers: ((list: DoorView[]) => Promise<void>)[] = [];

/**
 * Runs `fn` after every door tick, with the doors as that tick left them in `doors`. `claude plugin validate`
 * refuses a `$` handed to a function it cannot follow, as a subscriber is: one that needs `$` subscribes from
 * `session.start` (register.tsx), in a closure over that hook's `$`.
 */
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
    if (seatsKey(list) !== roomsFor) await refreshRooms($, list);
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

/**
 * From `session.start` (register.tsx): finds the doors, then reads them every `DOOR_POLL_MS` and their rooms every
 * `ROOMS_POLL_MS`, for the session's life.
 */
export async function startDoors($: EngineInterface): Promise<void> {
  const found = await discover($);
  await update($, doors, () => found);
  $.clock.every(DOOR_POLL_MS, () => void tick($));
  $.clock.every(ROOMS_POLL_MS, () => {
    read($, doors)
      .then((list) => refreshRooms($, list))
      .catch((error: unknown) => $.ui.log(`bellman-mod: ${message(error)}`, { to: "debug" }));
  });
}
