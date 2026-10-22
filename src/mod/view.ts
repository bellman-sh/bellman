/**
 * What the Claude Code mod's view shows, as pure functions: which layout, which toast, how many
 * unread, which requests wait on the person, how a room is named, and the bell; and what the mod keeps
 * of the door's events and a room's canvas, within bounds. The mod draws and reads the door; this file
 * decides what the door's events come to.
 *
 * Every string a peer controls (label, room name, message) leaves here through `cleanText`, so a toast,
 * a picker entry or a title never carries an escape sequence or a line break; what an action request
 * asks leaves through `cleanBlock`, once `spelledOut` has written out as code points the characters it
 * names, which would hide text or act on the terminal (`drawingOf`).
 *
 * Runtime-free on purpose, like `door-protocol.ts`: esbuild bundles it into the mod. Its imports are
 * that file, one constant from `action-state.ts`, which itself imports only a type, and the payload
 * bounds from `payload.ts`, which imports nothing.
 */
import { ACTION_REQUEST_TTL_MS } from "../action-state.js";
import { cleanBlock, cleanText, eventLine, type DoorEvent, type DoorStatus } from "../door-protocol.js";
import { MAX_PAYLOAD_CHARS, MAX_PAYLOAD_DEPTH } from "../payload.js";

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

/**
 * An event as the mod keeps it (`logs`, and each door's `recent`): the door's envelope, and in place of its payload
 * `line`, the line the Log and a toast draw for it. Only an action request waiting on the person keeps its payload,
 * whole, for the Approve tab to draw, and has no `line`. A door's event, payload and all, passes for one.
 */
export type KeptEvent = Omit<DoorEvent, "payload"> & { payload?: unknown; line?: string };

/**
 * `e` trimmed to what the mod reads of it: its cursor, type, time, sender and the rest of the envelope, the sender's
 * label cleaned as every line draws it, and in place of its payload the line `eventLine` draws. Its `ref_id` stays on an
 * `action_response`, where the server checked it is a request's cursor and the mod reads it; on any other event it is a
 * peer's string of any length that nothing here reads, and goes. One already trimmed comes back as it was.
 */
export function kept(e: KeptEvent): KeptEvent {
  if (e.line !== undefined) return e;
  const { payload, ...envelope } = e;
  return {
    ...envelope,
    from_label: cleanText(e.from_label, NAME_MAX),
    ref_id: e.type === "action_response" ? e.ref_id : null,
    line: eventLine({ type: e.type, payload, ref_id: e.ref_id }),
  };
}

/** The line the Log and a toast draw for `e`: the one it was trimmed to, else its `eventLine`. */
export const lineOf = (e: KeptEvent): string => e.line ?? eventLine({ type: e.type, payload: e.payload, ref_id: e.ref_id });

/** The room's events once each, oldest first. A room seen through two bridges lists every event twice. */
function roomLog<E extends KeptEvent>(events: readonly E[], sessionId: string): E[] {
  const byCursor = new Map<number, E>();
  for (const e of events) if (e.session_id === sessionId) byCursor.set(e.cursor, e);
  return [...byCursor.values()].sort((a, b) => a.cursor - b.cursor);
}

/** `a` came after `b`: by time, which orders events across rooms, then by cursor, which orders one room's. */
function later(a: KeptEvent, b: KeptEvent): boolean {
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
  events: readonly KeptEvent[],
  p: { seats: readonly Seat[]; seen: ReadonlyMap<string, number>; logOpenFor: string | null; labels: ReadonlyMap<string, string> },
): { text: string; session_id: string; cursor: number } | undefined {
  let newest: KeptEvent | undefined;
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
    text: cleanText(`${who} in ${room}${verb}: ${lineOf(newest)}`, TOAST_MAX),
    session_id: newest.session_id,
    cursor: newest.cursor,
  };
}

/** The room's interrupting peer events after the cursor the person last opened its Log through. */
export function unreadCount(
  events: readonly KeptEvent[],
  p: { sessionId: string; seatMemberId: string; openedThrough: number },
): number {
  return roomLog(events, p.sessionId)
    .filter((e) => e.cursor > p.openedThrough && e.ambient !== true && e.from_member_id !== p.seatMemberId)
    .length;
}

/**
 * An action request waiting on the person. What it asks is not here: the Approve tab draws that from the request's own
 * event in `logs` (`drawingOf`), so the value that lists every room's requests stays small.
 */
export interface PendingRequest {
  session_id: string;
  /** The request's cursor: the `ref_id` an answer carries. */
  cursor: number;
  from_label: string;
  /** Epoch milliseconds. */
  expires_at: number;
}

/**
 * The longest a request's drawing runs, past what any payload `bellman_send` accepts comes to. A payload is at most
 * `MAX_PAYLOAD_CHARS` serialized and `MAX_PAYLOAD_DEPTH` deep. Printed two spaces to a level, each bracket and comma
 * of its compact JSON gains a line break and at most 2 × MAX_PAYLOAD_DEPTH spaces, and each colon a space, so it runs
 * to at most 2 × (MAX_PAYLOAD_DEPTH + 1) characters for each compact one; a character spelled out (`spelledOut`)
 * runs to eight at most for each it stood for. So `cleanBlock` cuts nothing the server accepts.
 */
export const REQUEST_DRAWN_MAX = MAX_PAYLOAD_CHARS * 2 * (MAX_PAYLOAD_DEPTH + 1);

/**
 * A peer's text as the person approving it reads it. These are written out as their code points, `\u{1b}`, where
 * `cleanBlock` would drop them, and with them the text a sequence carries or a run of tags spells, which Claude would
 * read and nobody would see: every control, format, private-use or unassigned character and every line or paragraph
 * separator, but the line break and the zero-width non-joiner and joiner, which join what is drawn on either side;
 * every variation selector of the supplement (U+E0100 to U+E01EF); and every one of the sixteen (U+FE00 to U+FE0F) but
 * one directly after a character that is not a selector, which picks how that character draws, so `❤️` draws as it is
 * and a run after it shows. A carriage return before a line break goes.
 * ponytail: by those categories and ranges. What else draws nothing passes: the one selector after each character, a
 * joiner included, and the marks, fillers and Mongolian selectors that draw nothing (U+034F, U+115F, U+1160, U+17B4,
 * U+17B5, U+180B to U+180D, U+180F, U+3164, U+FFA0); spell one out here the day it hides a request.
 */
const spelledOut = (text: string): string =>
  text
    .replace(/\r\n/g, "\n")
    .replace(
      /(?![\n\u{200c}\u{200d}])[\p{C}\p{Zl}\p{Zp}\u{e0100}-\u{e01ef}]|(?<![^\u{fe00}-\u{fe0f}\u{e0100}-\u{e01ef}])[\u{fe00}-\u{fe0f}]/gu,
      (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`,
    );

/**
 * What an action request asks, as the Approve tab draws it: its payload's `text` when that is the payload's one key
 * and a string, else the whole payload as JSON, two spaces to a level, since Claude reads every field of it and the
 * person approves what Claude reads. Spelled out, then cleaned with `cleanBlock` at `REQUEST_DRAWN_MAX`, which cuts
 * nothing the server accepts; `cut` says it was cut all the same.
 */
export function drawingOf(payload: unknown): { drawing: string; cut: boolean } {
  const keys = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? Object.keys(payload) : [];
  const text = keys.length === 1 && keys[0] === "text" ? (payload as { text: unknown }).text : undefined;
  const whole = spelledOut(typeof text === "string" ? text : JSON.stringify(payload ?? null, null, 2));
  return { drawing: cleanBlock(whole, REQUEST_DRAWN_MAX), cut: whole.length > REQUEST_DRAWN_MAX };
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
  log: readonly KeptEvent[],
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
    pending.push({ session_id: e.session_id, cursor: e.cursor, from_label: cleanText(e.from_label, NAME_MAX), expires_at: expiresAt });
  }
  return pending;
}

/**
 * The most `logs` holds, in characters of its JSON: a quarter of the 4,194,304 the engine allows one `$.state` value.
 * Every drawing of the Log reads it whole and every read of a log writes it whole, so it is kept well short of the
 * limit, and a quarter still holds the newest events of several rooms, a few hundred characters each once trimmed, or
 * some fifty requests waiting on the person whole at the largest payload the server accepts.
 */
export const LOGS_MAX = 1_000_000;

/**
 * `byRoom` within `max` characters of JSON, by letting go of the oldest first: first the events the Log draws only a
 * line for, but each room's newest, so that the room's next read still asks only for what is new; then the payloads of
 * the requests waiting on the person (`waiting`), each still listed, to be denied, though it can no longer be drawn; then
 * whatever is left. Every event in `byRoom` is trimmed (`kept`) but the waiting requests.
 */
export function fitLogs(byRoom: Record<string, KeptEvent[]>, waiting: (e: KeptEvent) => boolean, max = LOGS_MAX): Record<string, KeptEvent[]> {
  let total = JSON.stringify(byRoom).length;
  if (total <= max) return byRoom;
  const size = (e: KeptEvent): number => JSON.stringify(e).length;
  const newest = new Set(Object.values(byRoom).flatMap((list) => list.slice(-1)));
  const left = new Map(Object.entries(byRoom).map(([id, list]) => [id, list.length]));
  const oldestFirst = Object.entries(byRoom)
    .flatMap(([id, list]) => list.map((e) => [id, e] as const))
    .sort(([, a], [, b]) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0) || a.cursor - b.cursor);
  // What each event has become: itself trimmed, or null once it is let go.
  const now = new Map<KeptEvent, KeptEvent | null>();
  const pass = (change: (e: KeptEvent) => KeptEvent | null | undefined): void => {
    for (const [id, e] of oldestFirst) {
      if (total <= max) return;
      const was = now.has(e) ? now.get(e)! : e;
      const to = was === null ? undefined : change(was);
      if (to === undefined) continue;
      if (to !== null) total -= size(was!) - size(to);
      else {
        // Out of its list, an event takes its JSON with it, and a comma while another stays.
        const count = left.get(id)!;
        total -= size(was!) + (count > 1 ? 1 : 0);
        left.set(id, count - 1);
      }
      now.set(e, to);
    }
  };
  pass((e) => (waiting(e) || newest.has(e) ? undefined : null));
  pass((e) => (waiting(e) && e.line === undefined && size(kept(e)) < size(e) ? kept(e) : undefined));
  pass(() => null);
  return Object.fromEntries(
    Object.entries(byRoom).map(([id, list]) => [id, list.flatMap((e) => (now.has(e) ? (now.get(e) ?? []) : e))]),
  );
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

/** A member's latest progress note as one line: its payload's `note`, out of the untrusted envelope `bellman_rooms` puts it in. */
export function noteLine(note: unknown): string {
  const data = (note as { data?: unknown } | null)?.data;
  const said = (data as { note?: unknown } | null)?.note ?? data;
  return typeof said === "string" ? cleanText(said) : said == null ? "" : cleanText(JSON.stringify(said));
}

// ---------------------------------------------------------------------------
// The canvas
// ---------------------------------------------------------------------------

/** A canvas item as the mod keeps it: the fields the Canvas tab draws, each string a peer wrote cleaned as it is drawn. */
export interface CanvasItem {
  kind: string;
  title: string | null;
  body: string | null;
  blob: { name: string | null; bytes: number | null } | null;
}

/**
 * The most of a canvas the mod keeps, in characters of its JSON: two and a half times the 100,000 characters of a
 * tree's text the engine draws. An item past it could not be drawn even were every character before it one that JSON
 * writes as two, so nothing the Canvas tab could show is let go.
 */
export const CANVAS_MAX = 250_000;

/**
 * The items of a door's canvas answer (`bellman_surface`'s; `surfaceItem` in src/projections.ts), each out of its
 * envelope, as the mod keeps them: in the canvas's order while they fit in `CANVAS_MAX`, a body cleaned as a block and
 * a title and a file's name as a line, as the Canvas tab draws them. A body as the server takes it runs to 8,000
 * characters, and JSON writes a control character as six, so the answer itself can run to millions.
 */
export function canvasOf(answer: unknown): CanvasItem[] {
  const listed = (answer as { surface?: { items?: unknown } } | null)?.surface?.items;
  const items: CanvasItem[] = [];
  let left = CANVAS_MAX;
  for (const envelope of Array.isArray(listed) ? listed : []) {
    const data = (envelope as { data?: unknown } | null)?.data;
    if (typeof data !== "object" || data === null) continue;
    const { kind, title, body, blob } = data as Record<string, unknown>;
    const file = typeof blob === "object" && blob !== null ? (blob as { name?: unknown; bytes?: unknown }) : null;
    const item: CanvasItem = {
      kind: typeof kind === "string" ? kind : "",
      title: typeof title === "string" ? cleanText(title) : null,
      body: typeof body === "string" ? cleanBlock(body) : null,
      blob: file && { name: typeof file.name === "string" ? cleanText(file.name, NAME_MAX) : null, bytes: typeof file.bytes === "number" ? file.bytes : null },
    };
    left -= JSON.stringify(item).length + 1;
    if (left < 0) break;
    items.push(item);
  }
  return items;
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
