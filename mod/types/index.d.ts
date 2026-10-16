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

/**
 * Everything bellman-mod keeps in `$.state`, one key each. The keys are written here, inside the interface:
 * `claude plugin validate` reads them from it and follows no alias, so a key named only in a type this
 * interface refers to is "not declared". The tests read the whole as `PluginState["bellman-mod"]`.
 */
declare module "claude-code" {
  interface PluginState {
    "bellman-mod": {
      doors: DoorView[];
    };
  }
}
