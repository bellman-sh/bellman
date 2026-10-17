/**
 * bellman-mod's contract: the values it keeps in `$.state`, and the shapes they hold.
 *
 * Self-contained on purpose: no import, so the copy `npm run test:mod` validates, which holds
 * mod/'s files and nothing of src/, reads it whole. The door's shapes are written out again
 * here and must match src/door-protocol.ts (`DoorEvent`, `DoorSeat`, `DoorWaiting`,
 * `DoorStatus`, `DoorLog`), which the bridge serves; the kit tests read them back through
 * the door.
 */

/** An event as the door serves it: the bridge's `PeerEvent` (src/inbox.ts). */
export type DoorEvent = {
  session_id: string;
  /** The member this event was delivered to: the seat's own. */
  member_id: string;
  cursor: number;
  type: string;
  from_member_id: string;
  from_label: string;
  ref_id: string | null;
  /** ISO-8601. */
  at: string;
  payload: unknown;
  /** The server said it should not interrupt. */
  ambient?: boolean;
};

/** A seat the bridge watches: one member in one room, and whether its sync is failing and being retried. */
export type DoorSeat = { session_id: string; member_id: string; retrying: boolean };

/** One room's events queued in the bridge's inbox, counted and not taken. */
export type DoorWaiting = { session_id: string; interrupting: number; ambient: number };

/** `GET /status`. `waiting` is empty in channel delivery, which keeps no inbox. */
export type DoorStatus = {
  version: 1;
  delivery: "hook" | "channel";
  signed_in: boolean;
  seats: DoorSeat[];
  waiting: DoorWaiting[];
  /** The latest events the bridge delivered, newest last, ambient ones included. */
  recent: DoorEvent[];
};

/** `GET /rooms/<session_id>/events`: a page of the room's log, and the cursor to pass as `?after=`. */
export type DoorLog = { events: DoorEvent[]; cursor: number };

/**
 * One local bridge, by the MCP server that lists its `bellman_whoami`, and what its door said.
 *
 * `socketPath` is null for a bridge older than the door (its `bellman_whoami` names none) and
 * for one whose door failed, until a tick finds it again. `status` is the door's answer on
 * the latest tick, null when it was not read; `error` says why it could not be.
 */
export type DoorView = { server: string; socketPath: string | null; status: DoorStatus | null; error: string | null };

/** A member of a room as the door's `/rooms` lists it (`bellman_rooms`', `roomSummary` in src/projections.ts): the fields the mod reads. */
export type RoomMember = {
  member_id: string;
  label: string;
  room_role: string;
  presence: "present" | "stale" | "departed";
  /** `note` is peer prose in an untrusted envelope. */
  beat: { asked: boolean; last_report_at: string | null; silent_for_seconds: number | null; silent: boolean; note: unknown };
};

/** One of the account's seats in a room, as `bellman_rooms` lists them in `your_seats`, oldest first. */
export type YourSeat = { member_id: string; role: string; verbs: string[] };

/**
 * A room the session holds a seat in, as the door's `/rooms` lists it (`bellman_rooms`', `roomSummary` in
 * src/projections.ts), with the fields the mod reads, and `server`: the bridge whose door lists the seat and served it.
 *
 * An account holding several seats in the room gets `your_member_id` null and `room` from no seat (`your_role` null,
 * `your_verbs` empty): each seat's verbs are in `your_seats`, which a server older than it does not send.
 */
export type RoomView = {
  server: string;
  session_id: string;
  status: string;
  max_members: number;
  active_members: number;
  your_seats?: YourSeat[];
  your_member_id: string | null;
  room: { preset: string | null; public_name: string | null; your_role: string | null; your_verbs: string[] };
  members: RoomMember[];
  last_event: { cursor: number; type: string; at: string } | null;
};

/** An action request waiting on the person: `PendingRequest` in src/mod/view.ts. */
export type PendingRequest = { session_id: string; cursor: number; from_label: string; text: string; expires_at: number };

/** Where the room shows: the docked sidebar, or the band above the prompt (`Layout` in src/mod/view.ts). */
export type Layout = "sidebar" | "band";

/** The room pane's tab. */
export type Tab = "log" | "canvas" | "members" | "approve";

/**
 * Everything bellman-mod keeps in `$.state`, one key each. The keys are written here, inside the interface:
 * `claude plugin validate` reads them from it and follows no alias, so a key named only in a type this
 * interface refers to is "not declared". The tests read the whole as `PluginState["bellman-mod"]`.
 */
declare module "claude-code" {
  interface PluginState {
    "bellman-mod": {
      doors: DoorView[];
      /** The rooms of the doors' seats, read by the rooms poll. */
      rooms: RoomView[];
      /** The room the band, the sidebar and the pane show: one of the seats' rooms, or null with none. */
      room: string | null;
      /** By room, the newest cursor a tick has looked at for a toast, toasted or not. */
      seen: Record<string, number>;
      /** By room, the newest cursor the person has seen in its Log: what unread counts from. */
      openedThrough: Record<string, number>;
      layout: Layout;
      tab: Tab;
      /** Whether waking is paused, waiting on the person (written by the wake). */
      wake: { paused: boolean };
      /** By room, the action requests waiting on the person (written by the room pane). */
      pending: Record<string, PendingRequest[]>;
      /** `approvalKey`s (src/mod/gate.ts) of the requests the person approved: the gate passes Claude's `approved: true` answer for these (written by the room pane). */
      approved: string[];
      /** By room, the newest events of its log as its door serves them, oldest first (written by the log reads). */
      logs: Record<string, DoorEvent[]>;
      /** By room, its door's `/rooms/<id>/surface` answer (`bellman_surface`'s) as last read, while the pane showed its Canvas: peer content, read with care. */
      canvas: Record<string, unknown>;
    };
  }
}
