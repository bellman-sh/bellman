/**
 * The doors: each local bridge's, found through its `bellman_whoami` and read over its Unix socket.
 *
 * A bridge is any MCP server that lists `bellman_whoami`, whatever it is registered as (the plugin's, or one
 * the person added); the claude.ai connector lists none, so its rooms are not the mod's (spec D1). The tool's
 * result names the bridge's door (`describeSelf` in src/bridge.ts), and the door serves the rest (src/door.ts).
 *
 * `bellman_whoami` is the one Claude Code tool the mod calls, and only from inside its own hooks: Claude Code
 * refuses a mod's own tool call from its timers and presses, and allows it inside one of the mod's hooks (R15). So
 * the bridges are asked at `session.start`, and at each `turn.start`, `turn.complete` and `prompt.submit` after it
 * when one is listed that the mod has not asked or a tick found its door failed (`findDoors`, called from
 * register.tsx): a bridge that restarted has a new pid, so a new socket, found at the person's next prompt or the
 * turn's next start or end. Everything else goes over a door's socket, which asks no permission.
 *
 * Every tick reads every door, and lists the bridges, since one may connect after the session starts. A door that
 * cannot be read keeps its socket and the last status it gave, its rooms with it, so the gate stays shut on them, and
 * every tick reads it again; a bridge that answers again naming no door is one older than the door, and its rooms go.
 * The rooms the seats are in come from each door's `/rooms`, every `ROOMS_POLL_MS` and on any tick whose seats
 * changed, so a room Claude just joined shows within a tick: the door asks the server for them, so no tick waits on
 * that read, and one never starts while another runs. Each room's log comes through its door at the same moments, what
 * is new past the newest event held (the newest page while none is), and on every tick while the room pane shows that
 * room's Log; its canvas through the door as well, only while the pane shows the Canvas.
 * Nothing here calls `bellman_sync` or takes from an inbox: those belong to Claude.
 */
import { read, update } from "claude-code";
import type { EngineInterface, HttpInit, Timer } from "claude-code";
import { DOOR_POLL_MS, ROOMS_POLL_MS, pendingRequests } from "../../src/mod/view.js";
import { resultData } from "../../src/result-data.js";
import type { DoorEvent, DoorLog, DoorSeat, DoorStatus, DoorView, PendingRequest, RoomView } from "../types";
import { shownTab } from "./drawn";
import { canvas, doors, logs, openedThrough, pending, room, rooms } from "./state";

/** `bellman_whoami` under any server's name: `mcp__<server>__bellman_whoami`. */
const WHOAMI = /^mcp__(.+)__bellman_whoami$/;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** One bridge's door, as its `bellman_whoami` names it. A bridge older than the door names none. */
async function ask($: EngineInterface, server: string): Promise<DoorView> {
  try {
    const result = await $.mcp.call(server, "bellman_whoami");
    if (result.isError) throw new Error(result.content.map((c) => c.text ?? "").join(" ") || "bellman_whoami failed");
    const door = resultData(result)?.door;
    return { server, socketPath: typeof door === "string" ? door : null, status: null, error: null };
  } catch (error) {
    return { server, socketPath: null, status: null, error: message(error) };
  }
}

/** The servers listing `bellman_whoami` now: the session's local bridges. */
async function bridges($: EngineInterface): Promise<string[]> {
  return (await $.tool.list()).flatMap((tool) => WHOAMI.exec(tool.name)?.[1] ?? []);
}

/** How long one of the mod's hooks waits for the bridges to name their doors before it lets its event go on. */
const FIND_WAIT_MS = 1_500;

/**
 * From inside one of the mod's own hooks, where Claude Code allows the mod's call (register.tsx: `session.start`, and
 * `turn.start`, `turn.complete` and `prompt.submit`): each bridge listed now that the mod has not asked, or whose door
 * failed, is asked for its door. A tick cannot ask, so a door it finds failing is read again at every tick, through the
 * socket it had, until a read answers or one of these names it a new socket.
 *
 * The asking starts inside the hook, where the call is allowed, and the hook waits for it `FIND_WAIT_MS` at most: a
 * bridge that never answers must not hold the person's prompt or the turn. An answer slower than that still lands in
 * `doors`, for the next tick.
 * ponytail: a bridge older than the door is asked once, so one updated mid-session shows at the next session's start.
 * ponytail: a hung bridge is asked again at each of these hooks, its calls left pending; one asking at a time, the day that shows.
 */
export async function findDoors($: EngineInterface): Promise<void> {
  const asking = askBridges($).catch((error: unknown) => $.ui.log(`bellman-mod: finding the doors: ${message(error)}`, { to: "debug" }));
  let timer: Timer | undefined;
  await Promise.race([asking, new Promise<void>((resolve) => (timer = $.clock.after(FIND_WAIT_MS, resolve)))]);
  timer?.cancel();
}

async function askBridges($: EngineInterface): Promise<void> {
  const known = await read($, doors);
  const unasked = (await bridges($)).filter((server) => !known.some((d) => d.server === server && d.error === null));
  if (unasked.length === 0) return;
  const asked = await Promise.all(unasked.map((server) => ask($, server)));
  // Over the doors as they are by now, since a tick may have written while the bridges answered: only a door that
  // still has no socket, or still fails, takes its bridge's answer, and an answer that is itself a failure changes
  // nothing. A door that has given a status takes only the socket named, keeping that status and its error until a
  // read of the new socket replaces them: a bridge that restarted keeps its rooms, and the gate shut on them, meanwhile.
  // A bridge that answers naming no door has come back older than the door, and is one: its last status goes, and its
  // seats with it, out of the view and the gate.
  await update($, doors, (current) => [
    ...current.map((d) => {
      const answer = asked.find((a) => a.server === d.server);
      if (answer === undefined || answer.error !== null || (d.socketPath !== null && d.error === null)) return d;
      return d.status === null || answer.socketPath === null ? answer : { ...d, socketPath: answer.socketPath };
    }),
    ...asked.filter((a) => !current.some((d) => d.server === a.server)),
  ]);
}

/** A door's JSON answer to `path`, or a throw: the socket refused, is gone, or answered anything but a 2xx. */
async function fromDoor($: EngineInterface, socketPath: string, path: string, init: Omit<HttpInit, "socketPath"> = {}): Promise<unknown> {
  const res = await $.http.fetch(`http://door${path}`, { ...init, socketPath });
  if (!res.ok) throw new Error(`the door answered ${res.status} for ${path}`);
  return JSON.parse(res.text);
}

/**
 * Each door's status, read over its socket, in the order given. A door that cannot be read keeps its socket and the
 * last status it gave, and gets the error: the next tick reads the same socket again, the first read that answers
 * clears it, and the mod's next hook asks the bridge for its door, in case it restarted on a new one. A door with no
 * socket is not read.
 */
async function pollDoors($: EngineInterface, list: readonly DoorView[]): Promise<DoorView[]> {
  return Promise.all(
    list.map(async (door): Promise<DoorView> => {
      if (door.socketPath === null) return door;
      try {
        // ponytail: read as DoorStatus version 1 unchecked; check `version` the day the door has a second.
        return { ...door, status: (await fromDoor($, door.socketPath, "/status")) as DoorStatus, error: null };
      } catch (error) {
        return { ...door, error: message(error) };
      }
    }),
  );
}

/**
 * The rooms the doors' seats are in, each from its own door's `/rooms`: `bellman_rooms`' rooms, cut by the bridge to
 * its own seats, a read that moves nobody's `lastSeenAt`. Only a door that lists a seat is asked; a door that cannot
 * answer keeps the rooms it had.
 */
async function readRooms($: EngineInterface, list: readonly DoorView[], known: readonly RoomView[]): Promise<RoomView[]> {
  const each = await Promise.all(
    list.map(async (door): Promise<RoomView[]> => {
      const seated = new Set(door.status?.seats.map((s) => s.session_id));
      if (seated.size === 0 || door.socketPath === null) return [];
      try {
        // ponytail: read as roomSummary's shape unchecked; it is our own bridge's answer.
        const listed = ((await fromDoor($, door.socketPath, "/rooms")) as { rooms: Omit<RoomView, "server">[] }).rooms;
        return listed.filter((r) => seated.has(r.session_id)).map((r) => ({ ...r, server: door.server }));
      } catch (error) {
        $.ui.log(`bellman-mod: the rooms through ${door.server}'s door: ${message(error)}`, { to: "debug" });
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
/** True while a rooms read runs: one the server is slow to answer is not stacked on, by the poll or by a tick. */
let refreshing = false;

/**
 * The rooms, their logs and the canvas shown, read through the doors. Each is the server's to answer, so a tick does
 * not wait for this, and while one runs another is not started: a tick whose seats changed asks again at the next.
 */
async function refreshRooms($: EngineInterface, list: readonly DoorView[]): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    roomsFor = seatsKey(list);
    const fresh = await readRooms($, list, await read($, rooms));
    await update($, rooms, () => fresh);
    await readLogs($, list, [...seatedRooms(list).keys()]);
    if ((await shownTab($)) === "canvas") await readCanvas($);
  } finally {
    refreshing = false;
  }
}

/** A seat and the door that lists it. */
export type SeatAt = { door: DoorView; seat: DoorSeat };

/**
 * Each room the doors list a seat in, once, with the door its log and answers go through: the first that lists it and
 * answers, else the first that lists it. A door that cannot be read keeps the seats it last listed, through a socket
 * that may be gone.
 */
function seatedRooms(list: readonly DoorView[]): Map<string, SeatAt> {
  const seated = new Map<string, SeatAt>();
  for (const door of [...list].sort((a, b) => Number(a.error !== null) - Number(b.error !== null))) {
    for (const seat of door.status?.seats ?? []) if (!seated.has(seat.session_id)) seated.set(seat.session_id, { door, seat });
  }
  return seated;
}

/** The session's seat in `sessionId`, as the doors list it now. */
export const seatIn = (list: readonly DoorView[], sessionId: string): SeatAt | undefined => seatedRooms(list).get(sessionId);

/**
 * What the seat `memberId` may do in the room `view`: its entry in `your_seats`. `room.your_verbs` speaks for no seat
 * when the account holds several there (it is empty, L9), so it is read only from a server older than `your_seats`.
 */
function verbsOf(view: RoomView | undefined, memberId: string): readonly string[] {
  if (view?.your_seats) return view.your_seats.find((s) => s.member_id === memberId)?.verbs ?? [];
  return view?.room.your_verbs ?? [];
}

/** How many of a room's events `logs` keeps: the newest. */
const LOG_KEPT = 500;

/** A page of a room's log through a door: the page past `after`, or the newest page with none. */
async function fetchLog($: EngineInterface, socketPath: string, sessionId: string, after: number | undefined): Promise<DoorEvent[]> {
  const page = after === undefined ? "" : `?after=${after}`;
  // ponytail: read as DoorLog unchecked, as the status is; it is our own bridge's answer.
  return ((await fromDoor($, socketPath, `/rooms/${encodeURIComponent(sessionId)}/events${page}`)) as DoorLog).events;
}

/** `was` and `fresh` as one log, each cursor once, oldest first, the newest `LOG_KEPT` kept. */
function merged(was: readonly DoorEvent[], fresh: readonly DoorEvent[]): DoorEvent[] {
  const byCursor = new Map(was.map((e) => [e.cursor, e]));
  for (const e of fresh) byCursor.set(e.cursor, e);
  return [...byCursor.values()].sort((a, b) => a.cursor - b.cursor).slice(-LOG_KEPT);
}

/**
 * Reads the logs of the rooms `ids` through their doors: what is new past the newest cursor kept, or the newest page
 * while none is kept. Then every seated room's requests waiting on the person are counted again from its log. A room
 * no door lists a seat in any more is dropped; a log that cannot be read keeps what it had.
 */
async function readLogs($: EngineInterface, list: readonly DoorView[], ids: readonly string[]): Promise<void> {
  const seated = seatedRooms(list);
  const known = await read($, logs);
  const fresh = new Map<string, DoorEvent[]>();
  await Promise.all(
    ids.map(async (id) => {
      const socketPath = seated.get(id)?.door.socketPath;
      if (!socketPath) return;
      try {
        fresh.set(id, await fetchLog($, socketPath, id, known[id]?.at(-1)?.cursor));
      } catch (error) {
        $.ui.log(`bellman-mod: a room's log: ${message(error)}`, { to: "debug" });
      }
    }),
  );
  const kept = await update($, logs, (current) =>
    Object.fromEntries([...seated.keys()].map((id) => [id, merged(current[id] ?? [], fresh.get(id) ?? [])])),
  );
  const views = await read($, rooms);
  const now = await $.clock.now();
  await update($, pending, () =>
    Object.fromEntries(
      [...seated].map(([id, { seat }]): [string, PendingRequest[]] => [
        id,
        pendingRequests(kept[id] ?? [], {
          sessionId: id,
          seatMemberId: seat.member_id,
          canRespond: verbsOf(views.find((r) => r.session_id === id), seat.member_id).includes("respond_actions"),
          now,
        }),
      ]),
    ),
  );
}

/** True while a read of the shown Log runs: one slower than `DOOR_POLL_MS` (the door asks the server) is not stacked on. */
let readingLog = false;

/**
 * After each door tick (register.tsx subscribes it), while the room pane shows a room's Log: what is new in it, and
 * the person has seen it. The tick does not wait for it: the door reads the log from the server, and a slow answer
 * must not hold up the next tick's toasts and wake.
 */
export async function readShownLog($: EngineInterface, list: readonly DoorView[]): Promise<void> {
  if (readingLog || (await shownTab($)) !== "log") return;
  const id = await read($, room);
  if (id === null) return;
  readingLog = true;
  void (async () => {
    try {
      await readLogs($, list, [id]);
      const newest = (await read($, logs))[id]?.at(-1)?.cursor;
      if (newest !== undefined) await update($, openedThrough, (was) => ({ ...was, [id]: Math.max(was[id] ?? -1, newest) }));
    } catch (error) {
      $.ui.log(`bellman-mod: the shown Log: ${message(error)}`, { to: "debug" });
    } finally {
      readingLog = false;
    }
  })();
}

/**
 * The canvas of the room the pane shows, through the door that lists its seat: `/rooms/<id>/surface`, which is
 * `bellman_surface`'s answer, a read that keeps no seat alive. Called while the pane shows the Canvas, and when the
 * person turns to it.
 */
export async function readCanvas($: EngineInterface): Promise<void> {
  const id = await read($, room);
  const socketPath = id === null ? null : (seatIn(await read($, doors), id)?.door.socketPath ?? null);
  if (id === null || socketPath === null) return;
  try {
    const surface = await fromDoor($, socketPath, `/rooms/${encodeURIComponent(id)}/surface`);
    await update($, canvas, (was) => ({ ...was, [id]: surface }));
  } catch (error) {
    $.ui.log(`bellman-mod: the canvas through the door: ${message(error)}`, { to: "debug" });
  }
}

/**
 * The person's Deny of the action request at `cursor`, through the door at `socketPath`: its one write, which answers
 * the request `approved: false` as the bridge's seat in the room and sends nothing else (`decline` in src/door.ts).
 * Resolves once the door says the room was answered, and throws otherwise.
 */
export async function decline($: EngineInterface, socketPath: string, sessionId: string, cursor: number): Promise<void> {
  await fromDoor($, socketPath, `/rooms/${encodeURIComponent(sessionId)}/decline`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref_id: String(cursor) }),
  });
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
    const listed = await bridges($);
    const before = (await read($, doors)).filter((d) => listed.includes(d.server));
    const after = await pollDoors($, before);
    const bySocket = new Map(before.map((d, i) => [d.socketPath, after[i]!]));
    // Over the doors as they are by now, each by the socket this tick read: a door `findDoors` named a socket for
    // while this tick read keeps the one it named.
    const list = await update($, doors, (current) =>
      current.filter((d) => listed.includes(d.server)).map((d) => (d.socketPath === null ? d : (bySocket.get(d.socketPath) ?? d))),
    );
    if (seatsKey(list) !== roomsFor) {
      refreshRooms($, list).catch((error: unknown) => $.ui.log(`bellman-mod: ${message(error)}`, { to: "debug" }));
    }
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
  await findDoors($);
  $.clock.every(DOOR_POLL_MS, () => void tick($));
  $.clock.every(ROOMS_POLL_MS, () => {
    read($, doors)
      .then((list) => refreshRooms($, list))
      .catch((error: unknown) => $.ui.log(`bellman-mod: ${message(error)}`, { to: "debug" }));
  });
}
