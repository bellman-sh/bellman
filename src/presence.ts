/**
 * Whether a member is still there, as opposed to whether it said goodbye.
 *
 * `leftAt` records a deliberate removal — a `bellman_leave`, an eviction, or a
 * seat reclaimed below. What it cannot record is a session that simply stopped:
 * a crash, a closed laptop, a killed bridge, a dropped network, a cloud session
 * torn down all leave `leftAt` null forever, and a `pair` room whose peer's
 * laptop closed stayed full and unjoinable for good (#103). So
 * presence needs a second signal, and it is already on the wire:
 * `bellman_sync` long-polls every ~25 seconds, so a watching member announces
 * itself continuously. `lastSeenAt` just stops throwing that away.
 *
 * Not a heartbeat. Liveness carries nothing and arrives on a timer, so a row
 * per beat in the durable, replayable event log is the worst possible home for
 * it — that is the cost curve #99 and #25 exist to flatten. It is a field on
 * the member, written as a side effect of calls the member already makes.
 *
 * A `heartbeat` EVENT is a different thing and does exist (#111): the server
 * appends one on the room's declared cadence, carrying a snapshot of who has
 * reported, and members answer it with `progress`. That is content with a
 * recipient. This is liveness with neither. The two never share a field.
 *
 * Presence is DERIVED, never stored:
 *
 *   present   not departed, and heard from inside the window or on a live socket
 *   stale     not departed, and neither
 *   departed  `leftAt` set — by a leave, an eviction, or a reaped seat
 *
 * Abandonment is the same reading over the whole room (#18). A room has no
 * clock; it is abandoned when no active member has been seen, by window or by
 * socket, for `ABANDONED_AFTER_MS`, and `abandonedAt`/`isAbandoned` say when.
 * They are defined in store.ts beside `lastSeen` for the reason given there and
 * re-exported here, which is where everything outside the stores reads them.
 *
 * "On a live socket" is the second way to be present, and the reason is who
 * does not poll. A member fed by the local bus or by the room's hibernating
 * WebSocket never calls `bellman_sync`, so nothing writes its `lastSeenAt`, and
 * a listen-only member — an agent waiting for a peer's reply — sends nothing
 * either. Left to the window alone it would read stale after ten minutes with
 * its connection open, and the next contested join would take its seat (#146).
 * The object holds a better fact than the window: which sockets it has accepted
 * right now. That is a set of member ids, and this module is handed it rather
 * than looking it up, because it cannot call a Durable Object.
 *
 * Stale is reversible on purpose. A reopened laptop calls `bellman_sync`, its
 * `lastSeenAt` moves, and it is present again with the same `memberId` and the
 * same history. Nothing about going quiet is written down, so there is nothing
 * to undo. The one moment staleness becomes a write is when somebody actually
 * needs the seat: `reclaimStaleSeats` in rooms.ts turns stale into departed,
 * and only then, because that is the only moment the question is forced.
 *
 * This module must stay importable by both builds: no `cloudflare:workers`,
 * directly or transitively (see src/oauth/storage.ts for the same rule).
 */
import type { Member } from "./types.js";
// `lastSeen` and the socket derivation live in store.ts beside `isActiveMember`,
// because `seatMember` reads them inside the store and this module imports that
// one.
import {
  ABANDONED_AFTER_MS, NO_SOCKETS, abandonedAt, connectedAmong, isAbandoned, isActiveMember, lastSeen,
} from "./store.js";
export { ABANDONED_AFTER_MS, NO_SOCKETS, abandonedAt, connectedAmong, isAbandoned, lastSeen };
export type { RoomRoster } from "./store.js";

/**
 * How long a member may go unheard from before its seat is reclaimable.
 *
 * Ten minutes is 24 long-polls at `bellman_sync`'s 25-second cadence, and that
 * ratio is the whole choice. The window has to be several multiples of the poll
 * interval or a member thinking hard between calls gets reaped out of its own
 * room; it has to be short enough that a bricked `pair` room heals in minutes
 * rather than never: rooms have no clock (#18).
 *
 * It is generous deliberately. The cost of reaping too late is a seat held a
 * few minutes longer than necessary. The cost of reaping too early is removing
 * a live member mid-conversation, and only one of those is recoverable by
 * waiting.
 *
 * The window is for a member that polls. A member on a live socket does not
 * depend on it: `presenceOf` is handed the members a socket vouches for, which
 * is what closed the gap #140 and #146 describe. What the window cannot cover
 * for a socket-fed member is the time after its socket drops. The object stops
 * listing the socket at once, `lastSeenAt` is whatever it last was (a member
 * that only listens may never have written it since joining), and the member
 * would read stale until its client reconnected, which `room-socket.ts` does
 * after a wait of up to a second at first, doubling to a cap of thirty seconds
 * while the socket keeps failing — and a contested join landing in that gap took
 * the seat, with no window at all where a polling member has ten minutes.
 *
 * **#152 closed that**: `SessionDO.webSocketClose` stamps `lastSeenAt` for the
 * members the closing socket was vouching for, so a drop leaves a full window
 * behind it instead of nothing. A DROP reaches that handler too, as 1006 with
 * wasClean false, so it is not only polite closes; the handler already ran and
 * already woke the object to answer the close, so the cost is one session-record
 * write per teardown. The stamp records that the member WAS there, which is a
 * fact; only a listed socket says it is there now.
 *
 * What remains uncovered is a socket the runtime never reports at all, where the
 * member falls back to a `lastSeenAt` that may be as old as its join. Stamping on
 * the upgrade as well would give it one window from connect and is not done — it
 * expires on a socket held for hours, which is the case this hook covers instead.
 */
export const STALE_AFTER_MS = 10 * 60 * 1000;

export type Presence = "present" | "stale" | "departed";

/**
 * `connected` is the members a live socket vouches for (`connectedAmong`),
 * which the caller gets from `BellmanStore.connectedMembers`. A member in it is
 * present whatever `lastSeenAt` says, unless it has left: `leftAt` is the one
 * fact a socket cannot undo, and a departed member's identity can still be
 * holding a socket for another of its sessions.
 */
export function presenceOf(
  m: Member,
  now: number = Date.now(),
  connected: ReadonlySet<string> = NO_SOCKETS,
): Presence {
  if (!isActiveMember(m)) return "departed";
  if (connected.has(m.memberId)) return "present";
  return now - lastSeen(m) >= STALE_AFTER_MS ? "stale" : "present";
}

/**
 * Members holding a seat that is really theirs.
 *
 * This is the roster a capacity check should count, and the reason it is not
 * `activeMembers`: that one is built on `isActiveMember`, which the stores also
 * use to decide a room has emptied. Folding staleness into that predicate would
 * make a room whose members all went quiet close itself — destroying the
 * history the returning laptop came back for. Departure is permanent and may
 * close a room; staleness is reversible and must never. Two readings, because
 * they answer two questions.
 */
export const presentMembers = (
  members: Member[],
  now: number = Date.now(),
  connected: ReadonlySet<string> = NO_SOCKETS,
): Member[] => members.filter((m) => presenceOf(m, now, connected) === "present");

export const staleMembers = (
  members: Member[],
  now: number = Date.now(),
  connected: ReadonlySet<string> = NO_SOCKETS,
): Member[] => members.filter((m) => presenceOf(m, now, connected) === "stale");
