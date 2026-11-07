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
 * They are defined below, and both stores and everything outside them read them
 * from here.
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
 * needs the seat: `seatMember` turns stale into departed, inside the
 * transaction that seats the joiner, and only then, because that is the only
 * moment the question is forced.
 *
 * This module must stay importable by both builds: no `cloudflare:workers`,
 * directly or transitively (see src/oauth/storage.ts for the same rule).
 */
import type { Member, Session } from "./types.js";
// `lastSeen` and `NO_SOCKETS` live in members.ts beside `isActiveMember`; they are re-exported here for this
// module's callers.
import { NO_SOCKETS, isActiveMember, lastSeen, isActivePerson } from "./members.js";
export { NO_SOCKETS, lastSeen };

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

/**
 * Which of these members a live socket vouches for, given the member ids that
 * the sockets open in this room carry (their attachments, #146).
 *
 * A socket is authenticated as one identity, and its attachment lists the
 * members that identity owned in the room when the socket was accepted. That is
 * a snapshot, and the identity is what the socket vouches for, so this widens
 * the ids to every undeparted member of the users they belong to. The bus is
 * why: it serves every session of an identity on a machine through one socket
 * per room, so a member that joins after the socket was accepted is carried by
 * that socket and cannot be named in it. Read literally, the ids would leave
 * that member stale after ten minutes, and it never calls `bellman_sync` to say
 * otherwise.
 *
 * The cost is in one direction. A member of the identity whose session died
 * stays present for as long as another of its members holds a socket here,
 * because the socket does not say which of them it is for. That holds a seat too
 * long, which #139 prefers to the opposite: reaping too early removes a live
 * member, and the removal is final.
 *
 * Both stores run it inside `seatMember` and import it from here. members.ts,
 * which this module imports, does not read it, so that is no cycle.
 */
export function connectedAmong(
  members: readonly Member[],
  attached: Iterable<string>,
): ReadonlySet<string> {
  const named = new Set(attached);
  if (named.size === 0) return NO_SOCKETS;
  const users = new Set<string>();
  for (const m of members) if (named.has(m.memberId)) users.add(m.userId);
  const connected = new Set<string>();
  for (const m of members) {
    if (isActiveMember(m) && users.has(m.userId)) connected.add(m.memberId);
  }
  return connected;
}

/**
 * How long a room may go with nobody in it before it is abandoned (#18).
 *
 * Rooms persist: there is no clock on a room, on any plan. What ends one is its
 * last member leaving (`closeSessionIfEmpty`) or this: 90 days in which no
 * active member was heard from or held a socket. An abandoned room costs
 * storage and nothing else, and the member a hub room would most regret losing
 * is its quietest one, so the window is long. It is not forever because a room
 * whose every member died with its laptop should not sit in a Durable Object
 * for good, and the sweep is also what retires its codes from the registry.
 *
 * Both stores read it inside their own methods, and import it from here.
 */
export const ABANDONED_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

/** What the abandonment rule reads: a session, or a stored one. */
export type RoomRoster = Pick<Session, "closed" | "frozenAt" | "members" | "kind">;

/**
 * When this room becomes abandoned, or null if the question does not apply: a
 * closed room is over, a frozen one is waiting on a payment and `touchMember`
 * cannot stamp it, and an empty one is `closeSessionIfEmpty`'s. Departed members
 * do not count: a goodbye yesterday does not keep open a room that nobody else
 * has been in for a season. Nor does the hosted seat (hosted seat spec, D5): its
 * sends stamp it as seen, and a room whose people have all gone quiet still ends
 * 90 days after one of them was last there, however recently its host spoke.
 */
export function abandonedAt(s: RoomRoster): number | null {
  // A home room (ADR 0047) has one member who never sits in it: it ends only by hard delete, never by abandonment.
  if (s.closed || s.frozenAt !== null || s.kind === "home") return null;
  const active = s.members.filter(isActivePerson);
  if (active.length === 0) return null;
  return Math.max(...active.map(lastSeen)) + ABANDONED_AFTER_MS;
}

/**
 * Whether this room is abandoned now. `connected` is the members a live socket
 * vouches for (`connectedAmong`): a member on a socket is there whatever its
 * `lastSeenAt` says, so a room with one is never abandoned. Strict `>`, so a
 * read landing exactly on `abandonedAt` still sees the room open.
 *
 * Shared by both stores' sweeps and lazy closes, SessionDO's derived alarm and
 * every reader that answers "closed" without writing (`readsClosed`), so the
 * four cannot drift the first time one of them is edited.
 */
export function isAbandoned(
  s: RoomRoster,
  now: number,
  connected: ReadonlySet<string> = NO_SOCKETS,
): boolean {
  const due = abandonedAt(s);
  if (due === null || now <= due) return false;
  return !s.members.some((m) => isActiveMember(m) && connected.has(m.memberId));
}

/**
 * The roster with `lastSeenAt` moved to `now` on every active member, or only
 * on those named. New objects, so a caller's copy is not written into.
 *
 * Two callers. A thaw stamps every active member, so a room coming back from a
 * freeze gets a full window rather than closing on the alarm the thaw re-arms.
 * The abandonment alarm stamps the members a socket vouches for, which is the
 * stamp `webSocketClose` makes on a drop (#152), made on a schedule: without it
 * a room held open on one socket for a season would fire its alarm back to back.
 */
export function stampSeen(members: Member[], now: number, only?: ReadonlySet<string>): Member[] {
  return members.map((m) =>
    isActiveMember(m) && (only === undefined || only.has(m.memberId)) ? { ...m, lastSeenAt: now } : m,
  );
}
