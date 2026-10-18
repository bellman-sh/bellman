import { expect, test } from "claude-code/testing";
import { PANE_COLUMNS, PANE_ID, SIDEBAR_COLUMNS, WAKE_TEXT } from "../hooks/register.mjs";
import { ENGINE, NOW, ROOMS, SHOWN, STATUS, band, pane, peerEvent, shown, tick, world } from "./harness";

/** A C0 or C1 control character, DEL included: what a cleaned string never holds. */
const CONTROL = /[\u{0}-\u{1f}\u{7f}-\u{9f}]/u;

test("draws the band on the main screen, and nothing above the prompt once the sidebar shows", async ($, on) => {
  const w = await world($, on);
  await tick(w);
  const main = await band($);
  expect(await main.find({ key: "open-log" })).toBeDefined();
  expect(await main.find({ key: "bell-0" })).toBeDefined();
  // A band drawn fullscreen tells the mod the terminal docks a pane; the next tick finds the sidebar shown.
  await band($, "terminal", true);
  w.panes = [SHOWN];
  await tick(w);
  expect(await (await band($, "terminal", true)).drawn()).toMatchObject(ENGINE);
});

test("draws nothing of its own on desktop", async ($, on) => {
  const w = await world($, on);
  await tick(w);
  expect(await (await band($, "desktop")).drawn()).toMatchObject(ENGINE);
  for (const columns of [22, PANE_COLUMNS]) {
    const drawing = await pane($, columns, "desktop");
    expect(await drawing.drawn()).toMatchObject(ENGINE);
    await drawing.unmount();
  }
});

test("the sidebar holds the connection, the room, its peers and the buttons", async ($, on) => {
  const w = await world($, on);
  await tick(w);
  const sidebar = await pane($, 22);
  for (const key of ["bell-0", "open-log", "open-canvas"]) expect(await sidebar.find({ key })).toBeDefined();
  const text = await shown(sidebar);
  for (const part of ["Connected", "swarm _room1", "4 of 8", "ada", "builder", "rook", "pip"]) expect(text).toContain(part);
  // Peers: the seat's own member, labelled "you" in ROOMS, is not one.
  expect(text).not.toContain("you");
});

test("the room, its members and their labels come from the door's /rooms", async ($, on) => {
  const w = await world($, on);
  w.rooms[0]!.room.preset = "pair";
  w.rooms[0]!.members[1]!.label = "grace";
  await tick(w);
  expect(w.fetched).toContainEqual({ socket: w.door, method: "GET", path: "/rooms" });
  const text = await shown(await band($));
  for (const part of ["pair _room1", "4 of 8", "grace", "rook"]) expect(text).toContain(part);
  expect(w.calls.filter((c) => c.tool !== "bellman_whoami")).toEqual([]);
});

test("pressing the bell opens the room pane at its full width", async ($, on) => {
  const w = await world($, on);
  await tick(w);
  await (await band($)).press({ key: "bell-0" });
  // toEqual passes no other defined field: no focus, no holdToasts.
  expect(w.opened.at(-1)).toEqual({ id: PANE_ID, title: "Bellman", columns: PANE_COLUMNS });
});

test("a press that opens the pane calls ui.open before it writes the tab, so the open answers the press", async ($, on) => {
  // L13: the engine reads an `$.ui.open` made inside the press as the person's, and one made after an await as unasked.
  // The kit cannot tell them apart, so this reads the order the calls reached the world in.
  const w = await world($, on);
  const twoMinutesAgo = new Date(NOW - 2 * 60_000).toISOString();
  w.log.qs_room1 = { events: [peerEvent({ cursor: 5, type: "action_request", at: twoMinutesAgo, payload: { text: "run the migration" } })], cursor: 5 };
  await tick(w);
  const top = await band($);
  // Each press turns the pane to another tab than the last, so each writes the tab.
  for (const key of ["open-canvas", "bell-0", "open-approve", "open-log"]) {
    w.trail.length = 0;
    await top.press({ key });
    expect(w.trail.filter((step) => step === "ui.open" || step === "state.set tab"), key).toEqual(["ui.open", "state.set tab"]);
  }
});

test("fullscreen with a seat opens the sidebar unasked, and closes it when the last seat goes", async ($, on) => {
  const w = await world($, on);
  await band($, "terminal", true);
  await tick(w);
  expect(w.opened).toEqual([{ id: PANE_ID, title: "Bellman", columns: SIDEBAR_COLUMNS }]);
  w.panes = [SHOWN];
  w.status.seats = [];
  await tick(w);
  expect(w.closed).toEqual([PANE_ID]);
  // Its own close was not the person's: a seat again, and the sidebar opens again.
  w.panes = [];
  w.status.seats = structuredClone(STATUS.seats);
  await tick(w);
  expect(w.opened).toHaveLength(2);
});

test("the sidebar's × closes the pane as the person's: no tick opens it unasked again until the bell does", async ($, on) => {
  // L12: the docked sidebar had no close. The mod's own `$.ui.close` is raised with origin `plugin`, which the `ui.close`
  // hook does not count as the person's, so the press itself has to keep the sidebar from opening again (R4).
  const w = await world($, on);
  await band($, "terminal", true);
  await tick(w);
  expect(w.opened).toEqual([{ id: PANE_ID, title: "Bellman", columns: SIDEBAR_COLUMNS }]);
  w.panes = [SHOWN];
  const sidebar = await pane($, SIDEBAR_COLUMNS);
  await sidebar.press({ key: "close" });
  expect(w.closed).toEqual([PANE_ID]);
  // The engine closed it. Ten ticks later none has opened it again.
  w.panes = [];
  for (let i = 0; i < 10; i++) await tick(w);
  expect(w.opened).toHaveLength(1);
  // The bell opens it, wide; and once it has, a pane that goes away is the sidebar's to open again.
  await (await band($, "terminal", true)).press({ key: "bell-0" });
  expect(w.opened.at(-1)).toEqual({ id: PANE_ID, title: "Bellman", columns: PANE_COLUMNS });
  expect(w.opened).toHaveLength(2);
  await tick(w);
  expect(w.opened.at(-1)).toEqual({ id: PANE_ID, title: "Bellman", columns: SIDEBAR_COLUMNS });
  expect(w.opened).toHaveLength(3);
});

test("a press on the sidebar's × counts as the person, so waking resumes", async ($, on) => {
  const w = await world($, on);
  await tick(w);
  const sidebar = await pane($, SIDEBAR_COLUMNS);
  const wakes = () => w.submitted.filter((text) => text === WAKE_TEXT).length;
  const batch = async () => {
    w.status.waiting = [{ session_id: "qs_room1", interrupting: 1, ambient: 0 }];
    await tick(w);
    w.status.waiting = [];
    await tick(w);
  };
  // Three wakes without the person, and waking pauses.
  for (let i = 0; i < 4; i++) await batch();
  const paused = wakes();
  await batch();
  expect(wakes()).toBe(paused);
  await sidebar.press({ key: "close" });
  await batch();
  expect(wakes()).toBe(paused + 1);
});

test("a peer's message raises one toast; one's own and an ambient one do not", async ($, on) => {
  const w = await world($, on);
  w.status.recent = [
    peerEvent({ cursor: 2 }),
    peerEvent({ cursor: 3, from_member_id: "m-me", from_label: "you", payload: { text: "mine" } }),
    peerEvent({ cursor: 4, type: "surface", ambient: true, payload: { text: "ambient" } }),
  ];
  await tick(w);
  await tick(w);
  expect(w.toasts).toEqual(["ada in swarm _room1: hello"]);
});

test("two bridges: the picker lists both doors' rooms, and an event seen through both toasts once", async ($, on) => {
  const twice = peerEvent({ cursor: 2 });
  const room2 = { ...structuredClone(ROOMS[0]!), session_id: "qs_room2", your_member_id: "m-me2" };
  room2.room.preset = "pair";
  const w = await world($, on, {
    second: {
      server: "plugin_bellman_bellman",
      door: "/tmp/bellman-door-9.sock",
      status: { ...structuredClone(STATUS), seats: [{ session_id: "qs_room2", member_id: "m-me2", retrying: false }], recent: [twice] },
      rooms: [room2],
    },
  });
  w.status.recent = [twice];
  await tick(w);
  await tick(w);
  expect(w.toasts).toEqual(["ada in swarm _room1: hello"]);
  const picker = await (await band($)).find({ type: "Select" });
  expect(picker?.props.options).toEqual([
    { value: "qs_room1", label: "swarm _room1" },
    { value: "qs_room2", label: "pair _room2" },
  ]);
});

test("a hostile label and message are cleaned in the band and the toast", async ($, on) => {
  const hostile = "\u{1b}[2Jevil\n";
  const w = await world($, on);
  w.rooms[0]!.members[1]!.label = hostile;
  w.status.recent = [peerEvent({ cursor: 2, from_label: hostile, payload: { text: "x".repeat(10_000) } })];
  await tick(w);
  for (const drawing of [await band($), await pane($, 22)]) {
    const text = await shown(drawing);
    expect(text).toContain("evil");
    expect(text).not.toMatch(CONTROL);
  }
  expect(w.toasts).toHaveLength(1);
  expect(w.toasts[0]).toContain("evil in swarm _room1: xxx");
  expect(w.toasts[0]).not.toMatch(CONTROL);
  expect(w.toasts[0]!.length).toBeLessThanOrEqual(120);
});

test("with no seat, only the status line speaks", async ($, on) => {
  const w = await world($, on);
  w.status.seats = [];
  await tick(w);
  expect(w.statuses.at(-1)).toBe("Bellman: not in a room");
  expect(await (await band($)).drawn()).toMatchObject(ENGINE);
  w.status.seats = structuredClone(STATUS.seats);
  await tick(w);
  expect(w.statuses.at(-1)).toBeUndefined();
});

test("the status line speaks for the best bridge: an older bridge beside a door that answers says not in a room", async ($, on) => {
  // L6: the `bellman` bridge is older than the door; the second's door answers and lists no seat.
  const w = await world($, on, {
    door: null,
    second: { server: "plugin_bellman_bellman", door: "/tmp/bellman-door-9.sock", status: { ...structuredClone(STATUS), seats: [] }, rooms: [] },
  });
  await tick(w);
  expect(w.statuses.at(-1)).toBe("Bellman: not in a room");
  // Down the ladder, as the better bridge fares worse; the older bridge speaks only once no other does.
  w.second!.status.has_sign_in = false;
  await tick(w);
  expect(w.statuses.at(-1)).toBe("Bellman: the bridge is not signed in");
  w.doorDown = true;
  await tick(w);
  expect(w.statuses.at(-1)).toBe("Bellman: cannot reach the bridge");
  w.second = undefined;
  await tick(w);
  expect(w.statuses.at(-1)).toBe("Bellman: update the bridge to see your rooms here");
});

test("a door that answers holding a sign-in speaks over one that answers holding none", async ($, on) => {
  const w = await world($, on, {
    second: { server: "plugin_bellman_bellman", door: "/tmp/bellman-door-9.sock", status: { ...structuredClone(STATUS), seats: [], has_sign_in: false }, rooms: [] },
  });
  w.status.seats = [];
  await tick(w);
  expect(w.statuses.at(-1)).toBe("Bellman: not in a room");
});

test("no row of the bell carries a hotkey, so its four rows line up; the Log button carries it", async ($, on) => {
  // L7: a plain Button with a hotkey is drawn "b: " before its row. The kit draws no hotkey, so this reads the tree.
  const w = await world($, on);
  await tick(w);
  for (const drawing of [await band($), await pane($, SIDEBAR_COLUMNS)]) {
    const bell = (await drawing.findAll({ type: "Button" })).filter((b) => b.key?.startsWith("bell-"));
    expect(bell.map((b) => b.key)).toEqual(["bell-0", "bell-1", "bell-2", "bell-3"]);
    for (const row of bell) expect(row.props.hotkey).toBeUndefined();
    expect((await drawing.find({ key: "open-log" }))?.props.hotkey).toBe("b");
  }
});

/** What a row drawn `wrap="truncate-end"` shows in `columns` cells. The kit draws no width, so the test cuts as the terminal does. */
const cut = (row: string, columns: number): string => (row.length <= columns ? row : `${row.slice(0, columns - 1)}…`);

test("two members of one account read apart in the sidebar: the role comes before the label", async ($, on) => {
  // L8: the label is the account's, so two of its seats share it, and a 22-column row cuts the end of the line.
  const w = await world($, on);
  for (const m of w.rooms[0]!.members.slice(1, 3)) m.label = "sam.rivera@example.com";
  await tick(w);
  const sidebar = await pane($, SIDEBAR_COLUMNS);
  const rows = (await sidebar.findAll({ type: "Text" })).map((t) => t.text).filter((t) => t.includes("sam.rivera"));
  expect(rows).toEqual(["● builder sam.rivera@example.com", "● reviewer sam.rivera@example.com"]);
  expect(new Set(rows.map((row) => cut(row, SIDEBAR_COLUMNS))).size).toBe(2);
});

test("no toast while the pane shows the room's Log, and none later for what it showed", async ($, on) => {
  const w = await world($, on);
  await tick(w);
  await (await band($)).press({ key: "bell-0" });
  w.panes = [SHOWN];
  await pane($, PANE_COLUMNS);
  w.status.recent = [peerEvent({ cursor: 2 })];
  await tick(w);
  expect(w.toasts).toEqual([]);
  // The pane goes; the event it showed is not news later.
  w.panes = [];
  await tick(w);
  expect(w.toasts).toEqual([]);
  w.status.recent.push(peerEvent({ cursor: 3, payload: { text: "later" } }));
  await tick(w);
  expect(w.toasts).toEqual(["ada in swarm _room1: later"]);
});

test("the sidebar on screen keeps no toast away: only the room pane's Log does", async ($, on) => {
  const w = await world($, on);
  await band($, "terminal", true);
  await tick(w);
  w.panes = [SHOWN];
  await pane($, 22);
  w.status.recent = [peerEvent({ cursor: 2 })];
  await tick(w);
  expect(w.toasts).toEqual(["ada in swarm _room1: hello"]);
});

test("a door that goes unreachable while the sidebar is open closes nothing", async ($, on) => {
  const w = await world($, on);
  await band($, "terminal", true);
  await tick(w);
  expect(w.opened).toHaveLength(1);
  w.panes = [SHOWN];
  w.doorDown = true;
  await tick(w);
  await tick(w);
  expect(w.closed).toEqual([]);
});

test(
  "another plugin's close of the pane does not stop the sidebar opening again",
  {
    plugins: [
      {
        name: "closer",
        register(on) {
          on("tool.call", { tool: "mcp__closer__close" }, async ($) => {
            await $.ui.close({ id: "bellman" });
            return { result: { content: [{ type: "text", text: "closed" }] } };
          });
        },
      },
    ],
  },
  async ($, on) => {
    const w = await world($, on);
    await band($, "terminal", true);
    await tick(w);
    w.panes = [SHOWN];
    await $.tool.call({ tool: "mcp__closer__close" });
    expect(w.closed).toEqual([PANE_ID]);
    w.panes = [];
    await tick(w);
    expect(w.opened).toHaveLength(2);
  },
);
