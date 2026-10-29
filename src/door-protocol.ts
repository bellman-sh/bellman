import type { PeerEvent } from "./inbox.js";

/**
 * What the bridge's local door says, and the cleaning every peer string gets
 * before the Claude Code mod draws it. The bridge serves the door and the mod
 * reads it; both import this file, so the two cannot disagree about a shape.
 *
 * Runtime-free on purpose: the Node and Worker programs both type-check it, and
 * esbuild bundles it into the mod. Its one import is a type.
 */

/** The door's protocol version, reported as `DoorStatus.version`. */
export const DOOR_VERSION = 1;

/** An event as the door serves it: the bridge's own `PeerEvent`, unchanged. */
export type DoorEvent = PeerEvent;

/** A seat the bridge watches: one member in one room, and whether its sync is failing and being retried. */
export interface DoorSeat {
  session_id: string;
  member_id: string;
  retrying: boolean;
}

/** One room's events queued in the bridge's inbox, counted and not taken. */
export interface DoorWaiting {
  session_id: string;
  interrupting: number;
  ambient: number;
}

/**
 * Where this session's join from `BELLMAN_JOIN_CODE` stands (#435). `reason` is the bridge's own words, never the
 * server's, which can name a peer; `role` is the room's, written by its creator, and is cleaned before it is shown.
 */
export type DoorJoin =
  | { state: "joining" }
  | { state: "joined"; session_id: string; member_id: string; role: string; verbs: string[] }
  | { state: "refused"; reason: string };

/** `GET /status`. `waiting` is empty in channel delivery, which keeps no inbox. */
export interface DoorStatus {
  version: 1;
  delivery: "hook" | "channel" | "queue";
  /**
   * The bridge holds a sign-in: a cached one, or a BELLMAN_KEY. Not that the server accepts it, which only a call
   * would establish, and the door makes none to say this.
   */
  has_sign_in: boolean;
  seats: DoorSeat[];
  waiting: DoorWaiting[];
  /** The latest events the bridge delivered, newest last, ambient ones included. */
  recent: DoorEvent[];
  /** Present only when the bridge was started with a `BELLMAN_JOIN_CODE`. */
  join?: DoorJoin;
}

/** `GET /rooms/<session_id>/events`: a page of the room's log, and the cursor to pass as `?after=` for what is new. */
export interface DoorLog {
  events: DoorEvent[];
  cursor: number;
}

/**
 * `GET /rooms`: the rooms the bridge holds a seat in, each as `bellman_rooms` gave it (`roomSummary` in
 * src/projections.ts) and untouched, so a peer's text is still in the untrusted envelope the server put it in.
 */
export interface DoorRooms {
  rooms: Array<{ session_id: string } & Record<string, unknown>>;
}

/**
 * `GET /rooms/<session_id>/surface`: what `bellman_surface` returned for the room, untouched: the room's block and its
 * canvas, each item in an untrusted envelope.
 */
export interface DoorSurface {
  session_id: string;
  room: Record<string, unknown>;
  surface: { cursor: number; items: unknown[] };
}

/**
 * `POST /rooms/<session_id>/decline`, sent `{ "ref_id": "<decimal digits>" }` as application/json. The action request
 * `ref_id` names is answered `approved: false`, as the bridge's seat in that room, and this is the cursor of that
 * answer. The door sends that answer and nothing else.
 */
export interface DoorDeclined {
  cursor: number;
}

/**
 * `POST /seats/status`, sent `{ "status": "working" | "idle" | "needs_you" }` as application/json by the Claude Code
 * hooks (#432). Every seat the bridge holds whose status that changes is sent a `progress` carrying the status alone,
 * and `sent` counts them: 0 when nothing changed.
 */
export interface DoorStatusSet {
  sent: number;
}

/**
 * `PUT /rooms/<session_id>/surface/<key>`, sent the item as application/json, and `DELETE` of the same path (#465): the
 * item written or removed as the bridge's one seat in that room, and this is the cursor of that write.
 */
export interface DoorSurfaceWritten {
  cursor: number;
}

/** The statuses a seat can be set to: `SEAT_STATUSES` in src/types.ts, repeated here because this file imports no runtime. */
export const DOOR_SEAT_STATUSES = ["working", "idle", "needs_you"] as const;
export type DoorSeatStatus = (typeof DOOR_SEAT_STATUSES)[number];

// ---------------------------------------------------------------------------
// Cleaning — a peer controls every string below, and a terminal obeys escapes
// ---------------------------------------------------------------------------

/** CSI: ESC `[`, parameter bytes, intermediate bytes, one final byte. */
const CSI = /\u{1b}\[[0-?]*[ -/]*[@-~]/gu;
/** OSC: ESC `]`, then through BEL or ESC `\` (the string terminator). */
const OSC = /\u{1b}\][^\u{7}\u{1b}]*(?:\u{7}|\u{1b}\\)/gu;

// With the sequences gone, every C0 and C1 control and DEL goes too, each without a trace. The
// whitespace ones (tab through carriage return) are the exception in `cleanText`, which folds
// them to a space instead; `cleanBlock` keeps only the newline.
// So do the characters that draw nothing or turn the direction a line reads in, with which one
// peer's label passes for another's or a line reads other than it runs: the Arabic letter mark
// (U+061C), the zero-width space (U+200B), the left-to-right and right-to-left marks (U+200E,
// U+200F), the embeddings and overrides (U+202A to U+202E), the word joiner (U+2060), the
// isolates (U+2066 to U+2069) and the byte order mark (U+FEFF). The zero-width non-joiner and
// joiner (U+200C, U+200D) stay: emoji and some scripts need them.
// ponytail: those, by name. Other format characters (a soft hyphen, the invisible operators
// U+2061 to U+2064, the tag characters a flag emoji is spelled with) pass; strip one here the
// day a label is spoofed with it.
const TEXT_CONTROLS =
  /[\u{0}-\u{8}\u{e}-\u{1f}\u{7f}-\u{9f}\u{61c}\u{200b}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2060}\u{2066}-\u{2069}\u{feff}]/gu;
const BLOCK_CONTROLS =
  /[\u{0}-\u{9}\u{b}-\u{1f}\u{7f}-\u{9f}\u{61c}\u{200b}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2060}\u{2066}-\u{2069}\u{feff}]/gu;

function withoutSequences(text: string): string {
  return text.replace(CSI, "").replace(OSC, "");
}

/**
 * At most `max` characters, the last an ellipsis when something was cut.
 * ponytail: counts UTF-16 units, so a cut can leave half a surrogate pair before the ellipsis;
 * trim it here if that ever shows.
 */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  // `slice` counts a negative end from the string's end, so a max below one must not reach it.
  return max < 1 ? "" : text.slice(0, max - 1) + "…";
}

/** A peer's string as one line of at most `max` characters: for labels, toasts and titles. */
export function cleanText(text: string, max = 200): string {
  const plain = withoutSequences(text).replace(TEXT_CONTROLS, "");
  return cut(plain.replace(/\s+/g, " ").trim(), max);
}

/**
 * A peer's Markdown as at most `max` characters, line breaks kept and every other control gone.
 * A carriage return goes with the rest, so a `\r\n` comes out as the `\n` alone.
 */
export function cleanBlock(text: string, max = 8_000): string {
  return cut(withoutSequences(text).replace(BLOCK_CONTROLS, ""), max);
}

/** `of[key]` as one clean line, or "" when it is not a string. */
function field(of: unknown, key: string): string {
  const value = typeof of === "object" && of !== null ? (of as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" ? cleanText(value) : "";
}

/**
 * The one line an event reads as, after the label of the member it is from, cleaned: what the room's own events did
 * (L10); for any other, a string payload or a payload's `text`, else the event's type, never its JSON. Save for an
 * action request with no text: it is what the person is asked to approve, so it reads as its payload, whole.
 */
export function eventLine(e: Pick<DoorEvent, "type" | "payload"> & { ref_id?: string | null }): string {
  return cleanText(lineOf(e));
}

/** `eventLine`'s line before its last cleaning: every field in it a peer wrote is cleaned already. */
function lineOf(e: Pick<DoorEvent, "type" | "payload"> & { ref_id?: string | null }): string {
  const p = e.payload;
  switch (e.type) {
    case "member_joined": {
      const role = field((p as { member?: unknown } | null)?.member, "room_role");
      return role ? `joined as ${role}` : "joined";
    }
    case "member_left":
      return "left";
    case "member_evicted":
      // From the member who removed them, so the line names who was removed.
      return `removed ${field(p, "label") || "a member"}`;
    case "invite_issued": {
      const role = field(p, "role");
      return role ? `invited ${/^[aeiou]/i.test(role) ? "an" : "a"} ${role}` : "invited a member";
    }
    case "invite_revoked": {
      const listed = (p as { roles?: unknown } | null)?.roles;
      const roles = (Array.isArray(listed) ? listed : []).map((r: unknown) => (typeof r === "string" ? cleanText(r) : "")).filter(Boolean);
      return roles.length === 0 ? "retired a code" : `retired the ${roles.join(", ")} code${roles.length > 1 ? "s" : ""}`;
    }
    case "action_response": {
      // Read from `approved` alone: a peer's text cannot make a refusal read as an approval.
      const approved = (p as { approved?: unknown } | null)?.approved;
      const said = approved === true ? "approved" : approved === false ? "declined" : "answered";
      return e.ref_id ? `${said} request ${e.ref_id}` : said;
    }
    case "surface":
      return `✎ canvas: ${field(p, "title") || field(p, "key")}`;
    case "brief_update":
      return "updated their brief";
    case "progress":
      return field(p, "note") || "progress";
  }
  const text = typeof p === "string" ? cleanText(p) : field(p, "text");
  return text || (e.type === "action_request" && p != null ? JSON.stringify(p) : e.type);
}
