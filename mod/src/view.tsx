/**
 * What the person sees of the session's rooms in the terminal (spec D2 to D6): the band above the prompt with the
 * bell floating over it, or, while the terminal is fullscreen and the pane docks beside it, the sidebar instead;
 * the same pane at full width as the room pane, which pane.tsx draws; a toast for a peer's message; and, while the
 * session holds no seat, the status line alone.
 *
 * Every string a peer controls reaches the screen through src/mod/view.ts (`roomLabel`, `memberLine`, `toastFor`) or
 * `cleanText`. The render hooks draw on the terminal and answer `next(e)` on every other surface (spec D11).
 */
import { read, update } from "claude-code";
import type { Elements, EngineInterface, On } from "claude-code";
import { cleanText } from "../../src/door-protocol.js";
import {
  BELL_COLUMNS,
  BELL_ROWS,
  COMPACT_BELOW,
  NAME_MAX,
  PANE_COLUMNS,
  PANE_ID,
  SIDEBAR_COLUMNS,
  bellRows,
  chooseLayout,
  memberLine,
  roomLabel,
  sidebarMove,
  toastFor,
  unreadCount,
} from "../../src/mod/view.js";
import type { DoorSeat, DoorView, RoomView, Tab } from "../types";
import { readCanvas, seatIn } from "./doors";
import { markDrawn, markPaneWide, shownTab } from "./drawn";
import { awaitingPerson, drawPane, message } from "./pane";
import { personActed } from "./person";
import { approved, doors, layout, openedThrough, pending, room, rooms, seen, tab, wake } from "./state";

/** Whether the terminal docks a pane, as the band last drawn saw it (`RenderViewport.isFullscreen`). */
let isFullscreen: boolean | undefined;
/**
 * The person closed the pane by hand and has not opened it since, so no sidebar opens unasked (R4). Set by the engine's
 * close mark or key (the `ui.close` hook below) and by the `×` of the sidebar and of the inline room pane (`pieces`);
 * cleared by `openPane`.
 * ponytail: a module variable, so a reload forgets it and the sidebar may open once more; `$.state` if that shows.
 */
let refused = false;
/** The status line as last set: null before the first tick, so that tick sets it whatever it says. */
let statusShown: string | null | undefined = null;

const seatsOf = (list: readonly DoorView[]): DoorSeat[] => list.flatMap((d) => d.status?.seats ?? []);

/** A room's name in the picker, a toast or the pane, from its `bellman_rooms` entry when the poll has one. */
function labelOf(id: string, views: readonly RoomView[]): string {
  const view = views.find((r) => r.session_id === id);
  return roomLabel({ session_id: id, preset: view?.room.preset, public_name: view?.room.public_name });
}

/**
 * The status line while the session holds no seat (spec D4), said for the best bridge there is (L6): a door that
 * answers holding a sign-in says the session is in no room; one that answers holding none, that the bridge is not
 * signed in; then a door that could not be read; and a bridge older than the door only when no bridge has a door.
 * None with a seat, or with no Bellman bridge at all.
 */
function statusLine(list: readonly DoorView[]): string | undefined {
  if (seatsOf(list).length > 0) return undefined;
  const answering = list.filter((d) => d.socketPath !== null && d.error === null);
  if (answering.some((d) => d.status?.has_sign_in !== false)) return "Bellman: not in a room";
  if (answering.length > 0) return "Bellman: the bridge is not signed in";
  if (list.some((d) => d.error !== null)) return "Bellman: cannot reach the bridge";
  if (list.length > 0) return "Bellman: update the bridge to see your rooms here";
  return undefined;
}

/**
 * Opens the room pane on `to`, wide, showing the room `pick` when the press names one. The person's press is behind
 * every call, so it is placed at any width, but only while the engine reads the open as the press's: an `$.ui.open`
 * made after an await is unasked (L13), and a pane the person has docked then ignores it. So the open is called before
 * the first await, the tab and the room are written while it is under way (the pane's drawing reads them, so it
 * redraws when the writes land), and all are awaited together.
 */
export async function openPane($: EngineInterface, to: Tab, pick?: string): Promise<void> {
  refused = false;
  await Promise.all([
    $.ui.open({ id: PANE_ID, title: "Bellman", columns: PANE_COLUMNS }),
    update($, tab, () => to),
    ...(pick === undefined ? [] : [update($, room, () => pick)]),
  ]);
  if (to === "canvas") await readCanvas($);
}

/** After each door tick: the sidebar, the layout, the room shown, a toast, and the status line. */
export async function viewTick($: EngineInterface, list: DoorView[]): Promise<void> {
  let pane = (await $.ui.panes()).find((p) => p.id === PANE_ID);
  const move = sidebarMove({ isFullscreen, doors: list, open: pane !== undefined, refused });
  // Unasked: below 144 columns the engine holds it undrawn, and the band covers the gap.
  if (move === "open") await $.ui.open({ id: PANE_ID, title: "Bellman", columns: SIDEBAR_COLUMNS });
  if (move === "close") {
    await $.ui.close({ id: PANE_ID });
    pane = undefined;
  }
  await update($, layout, () =>
    chooseLayout({ isFullscreen, sidebarPlaced: pane?.isPlaced === true, sidebarShown: pane?.isShown === true }),
  );

  // The room shown stays while it is a seat's; otherwise the seat whose room spoke last, else the first.
  const seats = seatsOf(list);
  const ids = [...new Set(seats.map((s) => s.session_id))];
  const views = await read($, rooms);
  const latest = views
    .filter((r) => ids.includes(r.session_id) && r.last_event !== null)
    .sort((a, b) => Date.parse(b.last_event!.at) - Date.parse(a.last_event!.at))[0]?.session_id;
  const shown = await update($, room, (current) => (current !== null && ids.includes(current) ? current : (latest ?? ids[0] ?? null)));

  // A toast for the newest peer event worth one; then each room's events count as seen, toasted or not.
  const events = list.flatMap((d) => d.status?.recent ?? []);
  const logOpenFor = (await shownTab($)) === "log" ? shown : null;
  const labels = new Map(ids.map((id) => [id, labelOf(id, views)]));
  const toast = toastFor(events, { seats, seen: new Map(Object.entries(await read($, seen))), logOpenFor, labels });
  if (toast) $.ui.toast(toast.text);
  await update($, seen, (was) => {
    const now = { ...was };
    for (const e of events) now[e.session_id] = Math.max(now[e.session_id] ?? -1, e.cursor);
    return now;
  });

  const line = statusLine(list);
  if (line !== statusShown) {
    statusShown = line;
    $.ui.status(line);
  }
}

/** What the band, the sidebar and the room pane show of the room in view. Every string in it is cleaned. */
export type Shown = {
  retrying: boolean;
  options: { value: string; label: string }[];
  picked: string;
  label: string;
  /** The preset and the member count, as far as `bellman_rooms` has said. */
  about: string;
  peers: string[];
  unread: number;
  /** The action requests waiting on the person in every room of the session's seats: the pending ones not approved. */
  approve: number;
  /** The room of the oldest of those, which the Approve count opens; null while none waits. */
  approveIn: string | null;
  paused: boolean;
};

async function shownOf($: EngineInterface, list: readonly DoorView[], seats: readonly DoorSeat[]): Promise<Shown> {
  const views = await read($, rooms);
  const ids = [...new Set(seats.map((s) => s.session_id))];
  const current = await read($, room);
  const picked = current !== null && ids.includes(current) ? current : ids[0]!;
  const view = views.find((r) => r.session_id === picked);
  const mine = seats.filter((s) => s.session_id === picked);
  const preset = view?.room.preset ? cleanText(view.room.preset, NAME_MAX) : "";
  // Every room's requests that wait on the person, the oldest first: a request in a room not in view counts too.
  const held = await read($, pending);
  const given = await read($, approved);
  const waiting = ids.flatMap((id) => awaitingPerson(held[id] ?? [], given)).sort((a, b) => a.expires_at - b.expires_at);
  return {
    // A seat whose sync is being retried, or a room whose door cannot be read: either way the room is out of reach for now.
    retrying: seats.some((s) => s.retrying) || (seatIn(list, picked)?.door.error ?? null) !== null,
    options: ids.map((id) => ({ value: id, label: labelOf(id, views) })),
    picked,
    label: labelOf(picked, views),
    about: [preset, view ? `${view.active_members} of ${view.max_members}` : ""].filter(Boolean).join(" · "),
    // Peers: every member but the session's own seats.
    peers: (view?.members ?? []).filter((m) => !mine.some((s) => s.member_id === m.member_id)).map(memberLine),
    unread: unreadCount(
      list.flatMap((d) => d.status?.recent ?? []),
      { sessionId: picked, seatMemberId: mine[0]!.member_id, openedThrough: (await read($, openedThrough))[picked] ?? -1 },
    ),
    approve: waiting.length,
    approveIn: waiting[0]?.session_id ?? null,
    paused: (await read($, wake)).paused,
  };
}

/** What `pieces` hands the band, the sidebar and the room pane's header. */
export type Pieces = ReturnType<typeof pieces>;

/** The pieces the band, the sidebar and the room pane lay out differently. Every press is the person's, so each says so first. */
function pieces($: EngineInterface, ui: Elements["terminal"], s: Shown) {
  const { Button, Select, Text } = ui;
  const press = (to: Tab, pick?: string) => () => {
    personActed();
    void openPane($, to, pick);
  };
  const pick = (value: string) => {
    personActed();
    void update($, room, () => value);
  };
  // The `×` of the sidebar and of the room pane drawn inline (a docked one narrows to the sidebar instead). The mod's own
  // `$.ui.close` is raised with origin `plugin`, which the `ui.close` hook does not count as the person's, so the press
  // sets `refused` itself (R4). Like every press that opens or closes the pane, it calls the engine before any await.
  const close = () => {
    personActed();
    refused = true;
    $.ui.close({ id: PANE_ID }).catch((error: unknown) => $.ui.log(`bellman-mod: ${message(error)}`, { to: "debug" }));
  };
  return {
    connection: (
      <Text color={s.retrying ? "warning" : "success"} wrap="truncate-end">
        {s.retrying ? "◌ Reconnecting" : "● Connected"}
      </Text>
    ),
    close: <Button key="close" label="×" onPress={close} />,
    picker:
      s.options.length > 1 ? (
        <Select key="room" options={s.options} value={s.picked} onSelect={pick} />
      ) : (
        <Text wrap="truncate-end">{s.label}</Text>
      ),
    about: s.about !== "" && (
      <Text dimColor wrap="truncate-end">
        {s.about}
      </Text>
    ),
    buttons: [
      // `b` presses it while the band or the sidebar holds the keys. A bracketed Button draws no hotkey; on the bell's
      // first row, a plain one, it drew "b: " and pushed that row out of line with the other three (L7).
      <Button key="open-log" label="Log" hotkey="b" onPress={press("log")} />,
      <Button key="open-canvas" label="Canvas" onPress={press("canvas")} />,
      // Every room's count, and it opens the room that has waited longest.
      s.approve > 0 && <Button key="open-approve" label={`Approve ${s.approve}`} onPress={press("approve", s.approveIn ?? undefined)} />,
    ],
    peers: s.peers.map((peer) => <Text wrap="truncate-end">{peer}</Text>),
    unread: s.unread > 0 && <Text color="claude">{`${s.unread} new`}</Text>,
    waiting: s.approve > 0 && <Text color="warning">{`${s.approve} to approve`}</Text>,
    paused: s.paused && <Text color="warning">paused</Text>,
    // The bell: each row a Button of half-block cells, the upper pixel the color and the lower the ground.
    bell: bellRows().map((row, i) => (
      <Button key={`bell-${i}`} plain onPress={press("log")}>
        {row.map((cell) => (
          <Text color={cell.top} backgroundColor={cell.bottom}>
            ▀
          </Text>
        ))}
      </Button>
    )),
  };
}

/** Draws the band, the bell and the pane; `viewTick` keeps them in step with the doors. */
export function startView(on: On): void {
  on("ui.close", { id: PANE_ID }, ($, e, next) => {
    // The person's own close, from the engine's close mark or key. The kit cannot raise one, so the person's
    // look checks this line: closed by hand, the sidebar stays closed until the bell is pressed.
    if (e.origin.kind === "person") refused = true;
    return next(e);
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.surface !== "terminal") return next(e);
    isFullscreen = e.viewport?.isFullscreen;
    if (e.props.hasSurvey) return next(e);
    const list = await read($, doors);
    const seats = seatsOf(list);
    if (seats.length === 0 || (await read($, layout)) === "sidebar") return next(e);
    const ui = $.ui.resolve(e);
    const { Box } = ui;
    const s = await shownOf($, list, seats);
    const p = pieces($, ui, s);
    markDrawn();
    return (
      <Box flexDirection="column">
        <Box columnGap={1}>
          {p.connection}
          {p.picker}
          {p.about}
          {p.buttons}
        </Box>
        <Box columnGap={2}>
          {p.peers}
          {p.unread}
          {p.paused}
        </Box>
        <Box position="absolute" top={-(BELL_ROWS + 1)} left={e.props.bodyColumns - BELL_COLUMNS} flexDirection="column">
          {p.bell}
        </Box>
      </Box>
    );
  });

  on("ui.render", { component: "Pane", requestId: PANE_ID }, async ($, e, next) => {
    if (e.surface !== "terminal") return next(e);
    const wide = e.props.bodyColumns >= COMPACT_BELOW;
    markPaneWide(wide);
    const list = await read($, doors);
    const seats = seatsOf(list);
    const ui = $.ui.resolve(e);
    const { Box, Text } = ui;
    if (seats.length === 0) {
      markDrawn();
      return (
        <Text dimColor wrap="truncate-end">
          {statusLine(list) ?? "Bellman: cannot reach the bridge"}
        </Text>
      );
    }
    const s = await shownOf($, list, seats);
    markDrawn();
    const p = pieces($, ui, s);
    if (wide) return drawPane($, ui, { bodyRows: e.props.scroll.bodyRows, placement: e.props.placement }, s, p);
    return (
      <Box flexDirection="column">
        {p.bell}
        <Box columnGap={1}>
          {p.connection}
          {p.close}
        </Box>
        {p.picker}
        {p.about}
        {p.peers}
        {p.unread}
        {p.waiting}
        {p.paused}
        {p.buttons}
      </Box>
    );
  });
}
