import { describe, expect, it } from "vitest";
import type { DoorEvent } from "../src/door-protocol.js";
import { BELL_COLUMNS, BELL_ROWS, bellRows, chooseLayout, pendingRequests, roomLabel, safeLinks, sidebarMove, toastFor, unreadCount } from "../src/mod/view.js";

const seats = [{ session_id: "qs_room1", member_id: "m-me" }];
const ev = (over: Partial<DoorEvent>): DoorEvent => ({
  session_id: "qs_room1", member_id: "m-me", cursor: 1, type: "message", from_member_id: "m-ada",
  from_label: "ada", ref_id: null, at: "2026-10-16T12:00:00.000Z", payload: { text: "hello" }, ...over,
});
const p = { seats, seen: new Map([["qs_room1", 1]]), logOpenFor: null, labels: new Map([["qs_room1", "swarm room1"]]) };

describe("chooseLayout", () => {
  it("lays out a sidebar only when fullscreen and the sidebar is placed and shown", () => {
    expect(chooseLayout({ isFullscreen: true, sidebarPlaced: true, sidebarShown: true })).toBe("sidebar");
    for (const q of [
      { isFullscreen: false, sidebarPlaced: true, sidebarShown: true },
      { isFullscreen: undefined, sidebarPlaced: true, sidebarShown: true },
      { isFullscreen: true, sidebarPlaced: false, sidebarShown: false },
      { isFullscreen: true, sidebarPlaced: true, sidebarShown: false },
    ]) expect(chooseLayout(q)).toBe("band");
  });
});

describe("toastFor", () => {
  it("toasts the newest peer message, and nothing of one's own, ambient, seen or open-log events", () => {
    expect(toastFor([ev({ cursor: 2 }), ev({ cursor: 3, payload: { text: "newest" } })], p)?.text).toBe("ada in swarm room1: newest");
    expect(toastFor([ev({ cursor: 2, from_member_id: "m-me" })], p)).toBeUndefined();
    expect(toastFor([ev({ cursor: 2, type: "surface", ambient: true })], p)).toBeUndefined();
    expect(toastFor([ev({ cursor: 1 })], p)).toBeUndefined();
    expect(toastFor([ev({ cursor: 2 })], { ...p, logOpenFor: "qs_room1" })).toBeUndefined();
  });
  it("names an action request as an ask", () => {
    expect(toastFor([ev({ cursor: 2, type: "action_request", payload: { text: "run the smoke test" } })], p)?.text)
      .toBe("ada in swarm room1 asks: run the smoke test");
  });
  it("cleans a hostile label and cuts a long line", () => {
    const text = toastFor([ev({ cursor: 2, from_label: "\u{1b}[2Jada\n", payload: { text: "y".repeat(10_000) } })], p)!.text;
    expect(text.startsWith("ada in swarm room1: y")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text).not.toMatch(/[\u{0}-\u{1f}\u{7f}-\u{9f}]/u);
  });
  it("toasts an event seen through two bridges once", () => {
    const twice = [ev({ cursor: 2 }), ev({ cursor: 2 })];
    const first = toastFor(twice, p)!;
    expect(first).toMatchObject({ session_id: "qs_room1", cursor: 2 });
    expect(toastFor(twice, { ...p, seen: new Map([["qs_room1", first.cursor]]) })).toBeUndefined();
  });
});

describe("unreadCount", () => {
  it("counts the room's interrupting peer events after the last opening", () => {
    const events = [ev({ cursor: 2 }), ev({ cursor: 3, from_member_id: "m-me" }), ev({ cursor: 4, ambient: true }), ev({ cursor: 5 })];
    expect(unreadCount(events, { sessionId: "qs_room1", seatMemberId: "m-me", openedThrough: 2 })).toBe(1);
  });
});

describe("pendingRequests", () => {
  it("lists unanswered, unexpired requests the seat may answer, oldest first", () => {
    const now = Date.parse("2026-10-16T12:20:00.000Z");
    const log = [
      ev({ cursor: 5, type: "action_request", payload: { text: "run smoke" }, at: "2026-10-16T12:10:00.000Z" }),
      ev({ cursor: 6, type: "action_request", payload: { text: "answered" }, at: "2026-10-16T12:11:00.000Z" }),
      ev({ cursor: 7, type: "action_response", ref_id: "6", from_member_id: "m-rook" }),
      ev({ cursor: 2, type: "action_request", payload: { text: "too old" }, at: "2026-10-16T11:40:00.000Z" }),
      ev({ cursor: 8, type: "action_request", from_member_id: "m-me", payload: { text: "mine" } }),
    ];
    expect(pendingRequests(log, { sessionId: "qs_room1", seatMemberId: "m-me", canRespond: true, now })).toEqual([
      { session_id: "qs_room1", cursor: 5, from_label: "ada", text: "run smoke", expires_at: Date.parse("2026-10-16T12:40:00.000Z") },
    ]);
    expect(pendingRequests(log, { sessionId: "qs_room1", seatMemberId: "m-me", canRespond: false, now })).toEqual([]);
  });
});

describe("roomLabel, bellRows, safeLinks", () => {
  it("labels a room by its public name, else by its preset and the end of its id", () => {
    expect(roomLabel({ session_id: "qs_abcdef123456", public_name: "schema-sweep", preset: "swarm" })).toBe("schema-sweep");
    expect(roomLabel({ session_id: "qs_abcdef123456", preset: "swarm" })).toBe("swarm 123456");
  });
  it("draws the bell in four rows of ten half-block cells, gold on the dark ground", () => {
    const rows = bellRows();
    expect(rows).toHaveLength(BELL_ROWS);
    for (const row of rows) expect(row).toHaveLength(BELL_COLUMNS);
    expect(rows[0][0]).toEqual({ top: "#11161D", bottom: "#11161D" });
    expect(rows[0][4]).toEqual({ top: "#11161D", bottom: "#D9A521" });
    expect(rows[2][1]).toEqual({ top: "#11161D", bottom: "#D9A521" });
  });
  it("keeps http and https links, and turns any other link into its text", () => {
    expect(safeLinks("[a](https://x.dev) [b](file:///etc/passwd) <file:///x> <https://y.dev>"))
      .toBe("[a](https://x.dev) b file:///x <https://y.dev>");
  });
});

// ---------------------------------------------------------------------------
// Cases the ones above do not reach. Each was seen failing against code broken to match.
// ---------------------------------------------------------------------------

const NO_CONTROLS = /^[^\u{0}-\u{1f}\u{7f}-\u{9f}]*$/u;

describe("chooseLayout, the placed sidebar", () => {
  it("needs the sidebar placed even when it reports shown", () => {
    expect(chooseLayout({ isFullscreen: true, sidebarPlaced: false, sidebarShown: true })).toBe("band");
  });
});

describe("toastFor, more", () => {
  it("keeps a long sender label from crowding out the room and the message", () => {
    const text = toastFor([ev({ cursor: 2, from_label: "L".repeat(10_000) })], p)!.text;
    expect(text).toBe(`${"L".repeat(39)}… in swarm room1: hello`);
  });
  it("still names the room and the message when the label is nothing but controls", () => {
    expect(toastFor([ev({ cursor: 2, from_label: "\u{1b}[2J\u{7}\u{0}" })], p)!.text).toBe("in swarm room1: hello");
  });
  it("still names the room and the message when the label is nothing but characters that draw nothing", () => {
    expect(toastFor([ev({ cursor: 2, from_label: "\u{202e}\u{200b}\u{2066}\u{feff}\u{200f}" })], p)!.text).toBe("in swarm room1: hello");
  });
  it("names a room that has no label by the end of its id, and cuts a long label", () => {
    expect(toastFor([ev({ cursor: 2 })], { ...p, labels: new Map() })!.text).toBe("ada in _room1: hello");
    const long = toastFor([ev({ cursor: 2 })], { ...p, labels: new Map([["qs_room1", "R".repeat(10_000)]]) })!.text;
    expect(long).toBe(`ada in ${"R".repeat(39)}…: hello`);
  });
  it("tracks what was seen room by room", () => {
    const toast = toastFor([ev({ session_id: "qs_room2", cursor: 2 })], {
      ...p,
      seats: [...seats, { session_id: "qs_room2", member_id: "m-me" }],
      seen: new Map([["qs_room1", 9], ["qs_room2", 1]]),
    });
    expect(toast).toMatchObject({ session_id: "qs_room2", cursor: 2 });
  });
  it("toasts the latest event across rooms by time, wherever it sits in the list", () => {
    const early = ev({ cursor: 9, at: "2026-10-16T12:00:01.000Z", payload: { text: "early" } });
    const late = ev({ session_id: "qs_room2", cursor: 2, at: "2026-10-16T12:00:05.000Z", payload: { text: "late" } });
    for (const events of [[early, late], [late, early]]) {
      expect(toastFor(events, { ...p, seen: new Map() })).toMatchObject({ session_id: "qs_room2", cursor: 2 });
    }
  });
  it("takes the higher cursor among events of one time, wherever it sits in the list", () => {
    const events = [ev({ cursor: 3, payload: { text: "newest" } }), ev({ cursor: 2 })];
    expect(toastFor(events, p)).toMatchObject({ cursor: 3 });
  });
  it("counts every seat the session holds in a room as its own", () => {
    const both = [...seats, { session_id: "qs_room1", member_id: "m-me-too" }];
    expect(toastFor([ev({ cursor: 2, from_member_id: "m-me-too" })], { ...p, seats: both })).toBeUndefined();
  });
});

describe("unreadCount, more", () => {
  it("counts only its own room, and an event seen through two bridges once", () => {
    const events = [ev({ cursor: 2 }), ev({ cursor: 2 }), ev({ session_id: "qs_room2", cursor: 3 })];
    expect(unreadCount(events, { sessionId: "qs_room1", seatMemberId: "m-me", openedThrough: 1 })).toBe(1);
  });
});

describe("pendingRequests, more", () => {
  const seat = { sessionId: "qs_room1", seatMemberId: "m-me", canRespond: true };
  const now = Date.parse("2026-10-16T12:20:00.000Z");
  const asked = (cursor: number, at: string, over: Partial<DoorEvent> = {}) =>
    ev({ cursor, type: "action_request", at, payload: { text: "do it" }, ...over });
  const cursors = (log: DoorEvent[]) => pendingRequests(log, { ...seat, now }).map((r) => r.cursor);

  it("lists a request until the instant it turns thirty minutes old", () => {
    const log = [asked(5, "2026-10-16T12:00:00.000Z")];
    expect(pendingRequests(log, { ...seat, now: Date.parse("2026-10-16T12:29:59.999Z") })).toHaveLength(1);
    expect(pendingRequests(log, { ...seat, now: Date.parse("2026-10-16T12:30:00.000Z") })).toHaveLength(0);
  });
  it("lists oldest first, whatever order the log came in", () => {
    const log = [asked(9, "2026-10-16T12:05:00.000Z"), asked(4, "2026-10-16T12:01:00.000Z"), asked(6, "2026-10-16T12:03:00.000Z")];
    expect(cursors(log)).toEqual([4, 6, 9]);
  });
  it("ends a request's wait only on an answer whose ref_id is its cursor, exactly", () => {
    const log = [asked(5, "2026-10-16T12:10:00.000Z"), ev({ cursor: 6, type: "action_response", ref_id: "05", from_member_id: "m-rook" })];
    expect(cursors(log)).toEqual([5]);
  });
  it("counts an answer from the seat itself, approval or refusal, as the end of the wait", () => {
    const answer = (approved: boolean, cursor: number) =>
      ev({ cursor, type: "action_response", ref_id: "5", from_member_id: "m-me", payload: { approved } });
    for (const approved of [true, false]) expect(cursors([asked(5, "2026-10-16T12:10:00.000Z"), answer(approved, 6)])).toEqual([]);
  });
  it("reads only its own room: another room's request is not listed, and its answer ends nothing here", () => {
    const log = [
      asked(5, "2026-10-16T12:10:00.000Z"),
      asked(7, "2026-10-16T12:10:00.000Z", { session_id: "qs_room2" }),
      ev({ session_id: "qs_room2", cursor: 8, type: "action_response", ref_id: "5" }),
    ];
    expect(pendingRequests(log, { ...seat, now }).map((r) => [r.session_id, r.cursor])).toEqual([["qs_room1", 5]]);
  });
  it("lists a request seen through two bridges once", () => {
    expect(cursors([asked(5, "2026-10-16T12:10:00.000Z"), asked(5, "2026-10-16T12:10:00.000Z")])).toEqual([5]);
  });
  it("cleans and cuts a hostile sender label and request text", () => {
    const hostile = asked(5, "2026-10-16T12:10:00.000Z", {
      from_label: "\u{1b}[2Jada\n",
      payload: { text: "\u{1b}]0;title\u{7}run\nsmoke " + "z".repeat(10_000) },
    });
    const [request] = pendingRequests([hostile], { ...seat, now });
    expect(request.from_label).toBe("ada");
    expect(request.text.startsWith("run smoke z")).toBe(true);
    expect(request.text.length).toBeLessThanOrEqual(200);
    expect(request.text).toMatch(NO_CONTROLS);
  });
});

describe("roomLabel, hostile names", () => {
  const id = "qs_abcdef123456";
  it("cleans and cuts a public name, and falls to the preset when it cleans to nothing", () => {
    expect(roomLabel({ session_id: id, public_name: "\u{1b}[31mschema\u{1b}[0m\nsweep", preset: "swarm" })).toBe("schema sweep");
    expect(roomLabel({ session_id: id, public_name: "n".repeat(10_000), preset: "swarm" })).toBe(`${"n".repeat(39)}…`);
    expect(roomLabel({ session_id: id, public_name: "\u{1b}[2J\u{7}\u{0}", preset: "swarm" })).toBe("swarm 123456");
    // A name that would read backwards, or that is made of characters that draw nothing.
    expect(roomLabel({ session_id: id, public_name: "\u{202e}peews\u{202c}", preset: "swarm" })).toBe("peews");
    expect(roomLabel({ session_id: id, public_name: "\u{200b}\u{2060}\u{feff}\u{61c}", preset: "swarm" })).toBe("swarm 123456");
  });
  it("cleans a preset, keeps the end of the id when the preset is long, and names a room with neither", () => {
    expect(roomLabel({ session_id: id, preset: "\u{1b}[2Jswarm\n" })).toBe("swarm 123456");
    expect(roomLabel({ session_id: id, preset: "p".repeat(10_000) })).toBe(`${"p".repeat(30)}… 123456`);
    expect(roomLabel({ session_id: id, public_name: null, preset: null })).toBe("room 123456");
    expect(roomLabel({ session_id: id, preset: "\u{7}" })).toBe("room 123456");
  });
});

describe("bellRows, the whole map", () => {
  it("draws exactly the bell's pixels", () => {
    const art = bellRows().flatMap((row) => [
      row.map((cell) => (cell.top === "#D9A521" ? "#" : ".")).join(""),
      row.map((cell) => (cell.bottom === "#D9A521" ? "#" : ".")).join(""),
    ]);
    expect(art).toEqual([
      "..........",
      "....##....",
      "...####...",
      "...####...",
      "..######..",
      ".########.",
      "....##....",
      "..........",
    ]);
  });
});

describe("safeLinks, every shape of a link", () => {
  it("leaves an http or https link alone however it is written", () => {
    for (const keep of [
      "[a](HTTPS://x.dev)", '[a](https://x.dev "title")', "[a](<https://x.dev>)", "[a](  http://x.dev )",
      "![i](https://x.dev/a.png)", "<HTTP://x.dev>", '[ref]: https://x.dev "t"', "[ref]:   <https://x.dev>",
      "> [ref]: https://x.dev", "- [ref]: <https://x.dev>", "1. > [ref]: http://x.dev",
      "x <b>bold</b> y < 3 and a<b>c", "no links here",
    ]) expect(safeLinks(keep)).toBe(keep);
  });
  it.each([
    ["relative, fragment and protocol-relative targets", "[a](foo/bar) [b](#anchor) [c](//evil.example/x)", "a b c"],
    ["an angle-bracket target", "[a](<file:///x>)", "a"],
    ["an image", "![alt](file:///x)", "!alt"],
    ["a mailto autolink", "<mailto:a@b.example>", "mailto:a@b.example"],
    ["an email autolink", "<a@b.example>", "a@b.example"],
    ["a label that holds brackets", "[a [b]](file:///x)", "[a [b]]"],
    ["a label nested deeper", "[a [b [c]]](file:///x)", "[a [b [c]]]"],
    ["a link inside a label that stays a link", "[a [b](file:///x)](https://safe.dev)", "[a b](https://safe.dev)"],
    ["a link inside a label that does not", "[a [b](file:///x)](file:///y)", "[a b]"],
    ["a reference definition", "[ref]: file:///etc/passwd\n\n[a][ref]", "[ref]\\: file:///etc/passwd\n\n[a][ref]"],
    // A definition is one wherever a block may start, so inside a container it reads as text exactly as at the top.
    ["a definition in a blockquote", "> [r]: file:///etc/passwd\n\n[click][r]", "> [r]\\: file:///etc/passwd\n\n[click][r]"],
    ["a definition after a blockquote marker with no space", ">[r]: file:///etc/passwd", ">[r]\\: file:///etc/passwd"],
    ["a definition in a nested blockquote", "> > [r]: file:///etc/passwd\n\n[click][r]", "> > [r]\\: file:///etc/passwd\n\n[click][r]"],
    ["a definition in a list item", "- [r]: file:///etc/passwd\n\n[click][r]", "- [r]\\: file:///etc/passwd\n\n[click][r]"],
    ["a definition in a list item of either other marker", "* [r]: file:///x\n+ [s]: file:///y", "* [r]\\: file:///x\n+ [s]\\: file:///y"],
    ["a definition in a list item marked by a tab", "-\t[r]: file:///etc/passwd", "-\t[r]\\: file:///etc/passwd"],
    ["a definition in an ordered list item", "1. [r]: file:///etc/passwd\n\n[click][r]", "1. [r]\\: file:///etc/passwd\n\n[click][r]"],
    ["a definition in an ordered list item marked with a parenthesis", "12) [r]: file:///x", "12) [r]\\: file:///x"],
    ["a definition in a list inside a blockquote", "> - [r]: file:///etc/passwd", "> - [r]\\: file:///etc/passwd"],
    ["a definition in a list item's later paragraph", "10. item\n\n    [r]: file:///x", "10. item\n\n    [r]\\: file:///x"],
    // The engine's Markdown draws no footnotes: a [^1] label is a definition's like any other.
    ["a definition whose label starts with a caret", "[^x]: file:///etc/passwd\n\n[click][^x]", "[^x]\\: file:///etc/passwd\n\n[click][^x]"],
    ["a footnote with no link at all, which reads the same either way", "[^1]: a note", "[^1]\\: a note"],
    ["a definition whose label holds an escaped bracket", "[a\\]b]: file:///x", "[a\\]b]\\: file:///x"],
    ["a definition whose label runs over two lines", "[r\nx]: file:///x\n\n[click][r x]", "[r\nx]\\: file:///x\n\n[click][r x]"],
    ["a definition whose target is on the next line", "[r]:\nfile:///x", "[r]\\:\nfile:///x"],
  ])("turns %s into text", (_, markdown, text) => {
    expect(safeLinks(markdown)).toBe(text);
  });
  it("does not stall on a flood of unterminated links", () => {
    // Slow here means a regex that backtracks badly; the test's own timeout is what fails.
    for (const flood of ["[a](", "](", "[", "<a@", "[a]:", "[\n"]) expect(typeof safeLinks(flood.repeat(2_000))).toBe("string");
  });
});

describe("sidebarMove", () => {
  const seat = { session_id: "qs_room1", member_id: "m-me", retrying: false };
  const read = (seats = [seat]) => ({ status: { seats }, error: null });
  const unread = { status: null, error: "connect ECONNREFUSED" };
  const older = { status: null, error: null };
  const fullscreen = { isFullscreen: true, doors: [read()], open: false, refused: false };
  const open = { ...fullscreen, open: true };

  it("opens the sidebar unasked in fullscreen while a door lists a seat and the pane is not open", () => {
    expect(sidebarMove(fullscreen)).toBe("open");
    expect(sidebarMove({ ...fullscreen, doors: [unread, read()] })).toBe("open");
    for (const q of [{ isFullscreen: false }, { isFullscreen: undefined }, { doors: [read([])] }, { doors: [unread] }, { doors: [] }]) {
      expect(sidebarMove({ ...fullscreen, ...q })).toBeNull();
    }
    expect(sidebarMove({ ...open, doors: [read()] })).toBeNull();
  });

  it("opens nothing after the person's own close until they open the pane themselves (R4)", () => {
    expect(sidebarMove({ ...fullscreen, refused: true })).toBeNull();
    expect(sidebarMove({ ...fullscreen, refused: false })).toBe("open");
  });

  it("closes it only on a live answer that no door lists a seat, never while a door cannot be read (R4)", () => {
    expect(sidebarMove({ ...open, doors: [read([])] })).toBe("close");
    expect(sidebarMove({ ...open, isFullscreen: false, doors: [read([])] })).toBe("close");
    // A bridge older than the door has no door to read: it says nothing either way.
    expect(sidebarMove({ ...open, doors: [read([]), older] })).toBe("close");
    // A door that cannot be read may hold the seat the person is reading: a bridge restarting.
    for (const doors of [[unread], [read([]), unread], [unread, read([])], [older], []]) expect(sidebarMove({ ...open, doors })).toBeNull();
    expect(sidebarMove({ ...open, refused: true, doors: [read([])] })).toBe("close");
  });
});
