/**
 * What the Claude Code mod's view shows, as pure functions: which layout, which toast, how many
 * unread, which requests wait on the person, how a room is named, and the bell. The mod draws and
 * reads the door; this file decides what the door's events come to.
 *
 * Every string a peer controls (label, room name, message, request) leaves here through `cleanText`,
 * so a toast, a picker entry or a title never carries an escape sequence or a line break.
 *
 * Runtime-free on purpose, like `door-protocol.ts`: esbuild bundles it into the mod. Its imports are
 * that file and one constant from `action-state.ts`, which itself imports only a type.
 */
import { ACTION_REQUEST_TTL_MS } from "../action-state.js";
import { cleanText, eventLine, type DoorEvent, type DoorStatus } from "../door-protocol.js";

/** Columns the sidebar asks for when the pane docks. */
export const SIDEBAR_COLUMNS = 22;
/** Columns of the room pane when it opens wide. */
export const PANE_COLUMNS = 64;
/** Below this many body columns the pane draws its compact form, the sidebar's. */
export const COMPACT_BELOW = 40;
/** How long a request stays pending: the server's own deadline, so the pane never lists one the server calls expired. */
export const REQUEST_TTL_MS = ACTION_REQUEST_TTL_MS;
export const BELL_COLUMNS = 10;
export const BELL_ROWS = 4;
export const PANE_ID = "bellman";
/** How often the mod reads each bridge's door. Local, over a Unix socket. */
export const DOOR_POLL_MS = 2_000;
/** How often the mod reads `bellman_rooms`: the MCP Apps monitor's cadence, `POLL_MS` in `ui/src/page.ts`. */
export const ROOMS_POLL_MS = 15_000;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export type Layout = "sidebar" | "band";

/**
 * The band shows whenever the sidebar is not on screen. The sidebar is on screen only when the terminal
 * draws fullscreen, the engine has placed the pane (it waits undrawn below its width limits), and the pane
 * is the one shown rather than a tab behind another plugin's.
 */
export function chooseLayout(p: { isFullscreen: boolean | undefined; sidebarPlaced: boolean; sidebarShown: boolean }): Layout {
  return p.isFullscreen === true && p.sidebarPlaced && p.sidebarShown ? "sidebar" : "band";
}

/** One bridge's door as the sidebar's decision reads it: what its status said, or why it could not be read. */
export interface DoorRead {
  status: Pick<DoorStatus, "seats"> | null;
  error: string | null;
}

/**
 * What a door tick does with the sidebar, the pane the mod opens on its own: "open" it, "close" it, or leave it
 * (null).
 *
 * It opens while the terminal is fullscreen (an unasked pane docks there), some door lists a seat, and the pane
 * is not open, unless the person closed it by hand and has not opened it since (`refused`): reopening it every
 * tick would fight them. It closes only on a live answer that the session holds no seat: a door was read, none
 * failed, and none lists one. A door that could not be read says nothing about its seats, so a bridge that
 * restarts leaves a pane the person is reading where it is. A bridge older than the door (no door, no error)
 * says nothing either way.
 */
export function sidebarMove(p: { isFullscreen: boolean | undefined; doors: readonly DoorRead[]; open: boolean; refused: boolean }): "open" | "close" | null {
  const seated = p.doors.some((d) => (d.status?.seats.length ?? 0) > 0);
  if (!p.open) return p.isFullscreen === true && seated && !p.refused ? "open" : null;
  const seatless = !seated && p.doors.some((d) => d.status !== null) && p.doors.every((d) => d.error === null);
  return seatless ? "close" : null;
}

// ---------------------------------------------------------------------------
// Events: toasts, unread, pending requests
// ---------------------------------------------------------------------------

/** One member in one room. The door's `DoorSeat` has more fields and passes for it. */
export interface Seat {
  session_id: string;
  member_id: string;
}

/** The room's events once each, oldest first. A room seen through two bridges lists every event twice. */
function roomLog(events: readonly DoorEvent[], sessionId: string): DoorEvent[] {
  const byCursor = new Map<number, DoorEvent>();
  for (const e of events) if (e.session_id === sessionId) byCursor.set(e.cursor, e);
  return [...byCursor.values()].sort((a, b) => a.cursor - b.cursor);
}

/** `a` came after `b`: by time, which orders events across rooms, then by cursor, which orders one room's. */
function later(a: DoorEvent, b: DoorEvent): boolean {
  const apart = (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0);
  return apart !== 0 ? apart > 0 : a.cursor >= b.cursor;
}

/** Longest a sender's label or a room's name runs in a line: the server's limit on a public name (`PUBLIC_NAME` in `src/public-names.ts`). */
export const NAME_MAX = 40;
/** The toast's whole line. */
const TOAST_MAX = 120;

/**
 * The toast for the newest event worth one, or `undefined`. An event is worth one when it is a peer's (not
 * sent from any seat the session holds in its room), interrupting (the server did not mark it `ambient`),
 * newer than what `seen` says was already looked at in its room, and not in the room whose Log is open.
 * "Newest" is by time, then cursor (`later`), wherever the event sits in `events`.
 *
 * The line reads `<sender> in <room>: <event line>`, or `<sender> in <room> asks: <event line>` for an action
 * request, cut to 120 characters. `events` may list one event twice (two bridges watch one room); `seen` is
 * what keeps it to one toast.
 */
export function toastFor(
  events: readonly DoorEvent[],
  p: { seats: readonly Seat[]; seen: ReadonlyMap<string, number>; logOpenFor: string | null; labels: ReadonlyMap<string, string> },
): { text: string; session_id: string; cursor: number } | undefined {
  let newest: DoorEvent | undefined;
  for (const e of events) {
    if (e.ambient === true || e.session_id === p.logOpenFor) continue;
    if (e.cursor <= (p.seen.get(e.session_id) ?? -1)) continue;
    if (p.seats.some((s) => s.session_id === e.session_id && s.member_id === e.from_member_id)) continue;
    if (!newest || later(e, newest)) newest = e;
  }
  if (!newest) return undefined;
  const who = cleanText(newest.from_label, NAME_MAX);
  const room = cleanText(p.labels.get(newest.session_id) || newest.session_id.slice(-6), NAME_MAX);
  const verb = newest.type === "action_request" ? " asks" : "";
  return {
    text: cleanText(`${who} in ${room}${verb}: ${eventLine(newest)}`, TOAST_MAX),
    session_id: newest.session_id,
    cursor: newest.cursor,
  };
}

/** The room's interrupting peer events after the cursor the person last opened its Log through. */
export function unreadCount(
  events: readonly DoorEvent[],
  p: { sessionId: string; seatMemberId: string; openedThrough: number },
): number {
  return roomLog(events, p.sessionId)
    .filter((e) => e.cursor > p.openedThrough && e.ambient !== true && e.from_member_id !== p.seatMemberId)
    .length;
}

export interface PendingRequest {
  session_id: string;
  /** The request's cursor: the `ref_id` an answer carries. */
  cursor: number;
  from_label: string;
  text: string;
  /** Epoch milliseconds. */
  expires_at: number;
}

/**
 * The action requests waiting on this seat's person, oldest first: a peer's, unanswered by anyone, and
 * younger than `REQUEST_TTL_MS`. None when the seat may not respond (`canRespond` is whether it granted
 * `respond_actions`).
 *
 * An answer names its request by `ref_id`, the request's cursor as a string. The tool admits it only on an
 * exact match, so `"05"` never answers cursor 5, and any member's answer, approval or refusal, ends the wait.
 */
export function pendingRequests(
  log: readonly DoorEvent[],
  p: { sessionId: string; seatMemberId: string; canRespond: boolean; now: number },
): PendingRequest[] {
  if (!p.canRespond) return [];
  const room = roomLog(log, p.sessionId);
  const answered = new Set<string>();
  for (const e of room) if (e.type === "action_response" && e.ref_id !== null) answered.add(e.ref_id);
  const pending: PendingRequest[] = [];
  for (const e of room) {
    if (e.type !== "action_request" || e.from_member_id === p.seatMemberId || answered.has(String(e.cursor))) continue;
    const expiresAt = Date.parse(e.at) + REQUEST_TTL_MS;
    // Written so that a time that does not parse (NaN) lists nothing.
    if (!(p.now < expiresAt)) continue;
    pending.push({
      session_id: e.session_id,
      cursor: e.cursor,
      from_label: cleanText(e.from_label, NAME_MAX),
      text: eventLine(e),
      expires_at: expiresAt,
    });
  }
  return pending;
}

// ---------------------------------------------------------------------------
// Names and the bell
// ---------------------------------------------------------------------------

/**
 * A member as the band, the sidebar and the Members tab name them: presence (`●` present, `◌` not), role, label, each
 * cleaned. The role comes first: the label is the account's, so two seats of one account share it, and a narrow row
 * cuts the end of a line (L8).
 */
export const memberLine = (m: { label: string; room_role: string; presence: string }): string =>
  [m.presence === "present" ? "●" : "◌", cleanText(m.room_role, NAME_MAX), cleanText(m.label, NAME_MAX)].filter(Boolean).join(" ");

/** Longest a preset's name runs (`MAX_ROLE_KEY_LENGTH` in `src/manifest.ts`), so the id's end below always fits in `NAME_MAX`. */
const PRESET_MAX = 31;

/**
 * How a room is named in a picker or a title: its public name, else its preset and the end of its id. A
 * preset can be a name its creator saved, so it is cleaned like any peer string, and a name that cleans to
 * nothing falls through to the id.
 */
export function roomLabel(room: { session_id: string; preset?: string | null; public_name?: string | null }): string {
  const name = cleanText(room.public_name ?? "", NAME_MAX);
  if (name) return name;
  return cleanText(`${cleanText(room.preset ?? "", PRESET_MAX) || "room"} ${room.session_id.slice(-6)}`, NAME_MAX);
}

const GOLD = "#D9A521";
const GROUND = "#11161D";
// The bell as eight pixel rows of ten. A "▀" cell draws two of them, the upper as its color and the
// lower as its background, so four rows of cells make the square-looking bell.
const BELL = [
  "..........",
  "....##....",
  "...####...",
  "...####...",
  "..######..",
  ".########.",
  "....##....",
  "..........",
];
const pixel = (mark: string): string => (mark === "#" ? GOLD : GROUND);

/** `BELL_ROWS` rows of `BELL_COLUMNS` cells: the colors of each `▀` cell's upper and lower pixel. */
export function bellRows(): { top: string; bottom: string }[][] {
  return Array.from({ length: BELL_ROWS }, (_, row) =>
    Array.from({ length: BELL_COLUMNS }, (_, col) => ({
      top: pixel(BELL[row * 2][col]),
      bottom: pixel(BELL[row * 2 + 1][col]),
    })),
  );
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

const WEB = /^https?:/i;
/** What opens the parentheses of a link that may stay one: spaces, an optional "<", then http or https. */
const WEB_TARGET = /^\s*<?https?:/i;

/**
 * Markdown with every link that is not http or https turned into text, so a peer's canvas cannot hand the
 * person a `file:` or custom-scheme link to open. The callers clean the text first (`cleanBlock`).
 *
 * It covers CommonMark's own link syntax: `[label](target "title")` and the image form, a `<target>` autolink
 * (a URI, or an email address), and a `[ref]: target` definition, which makes every `[label][ref]` a link. A
 * link becomes its label and an autolink its bare target; a definition keeps its line with the colon escaped,
 * so it reads as text. A definition is one wherever a block may start: at the top, or inside a blockquote or a
 * list item, nested to any depth, and its label may hold escapes and line breaks. A `[^1]:` footnote is one too,
 * since the engine's Markdown draws no footnotes and reads it as a definition like any other.
 *
 * ponytail: regexes, not a Markdown parser. Raw HTML (`<a href>`) is not touched, and a code span or fence
 * is not told from prose, so a `[x](y)` inside one is rewritten too. A flood of unterminated links costs time
 * quadratic in the text, bounded by the 8,000 characters `cleanBlock` leaves. Swap in a parser the day a
 * renderer follows a link these miss.
 */
export function safeLinks(markdown: string): string {
  return markdown
    // [label](target "title"), and ![alt](target): the label stays, the "!" of an image with it.
    .replace(/\[([^[\]]*)\]\(([^)]*)\)/g, (whole: string, label: string, inner: string) => (WEB_TARGET.test(inner) ? whole : label))
    // A "](target)" the pairing missed because its label holds brackets: drop the target, keep the text.
    .replace(/\]\((?!\s*<?https?:)[^)]*\)/gi, "]")
    // <target>: an autolink, a URI with a scheme or an email address.
    .replace(/<([a-z][a-z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>]+)>/gi, (whole: string, target: string) => (WEB.test(target) ? whole : target))
    // [ref]: target, after any run of blockquote markers, list markers and indentation: escape the colon so the
    // line reads as text.
    .replace(/^((?:[ \t]*(?:>|[-+*](?=[ \t])|\d{1,9}[.)](?=[ \t])))*[ \t]*\[(?:\\[\s\S]|[^[\]\\])+\]):(?![ \t]*<?https?:)/gim, "$1\\:");
}
