/**
 * Whether a member is still there, as opposed to whether it said goodbye.
 *
 * `leftAt` records a deliberate removal — a `bellman_leave`, an eviction, or a
 * seat reclaimed below. What it cannot record is a session that simply stopped:
 * a crash, a closed laptop, a killed bridge, a dropped network, a cloud session
 * torn down all leave `leftAt` null forever, and a `pair` room whose peer's
 * laptop closed stayed full and unjoinable for the rest of its TTL (#103). So
 * presence needs a second signal, and it is already on the wire:
 * `bellman_sync` long-polls every ~25 seconds, so a watching member announces
 * itself continuously. `lastSeenAt` just stops throwing that away.
 *
 * There is now a THIRD signal, and it is the strongest of them: an open socket.
 * A member in `ctx.getWebSockets()` is connected by construction, where
 * `lastSeenAt` is an inference from traffic — and the moment a client prefers
 * the room's hibernating WebSocket it stops sending that traffic altogether
 * (#140, #146). The readings below take it as an optional `connected` set of
 * member ids, supplied by whoever can know: `SessionDO`, from its own socket
 * list. Nothing about the transport reaches this module, which is what keeps it
 * importable by both builds.
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
 *   present   not departed, heard from inside the window
 *   stale     not departed, not heard from inside the window
 *   departed  `leftAt` set — by a leave, an eviction, or a reaped seat
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
// `lastSeen` lives in store.ts beside `isActiveMember`, because `seatMember`
// reads it inside the store and this module imports that one.
import { isActiveMember, lastSeen } from "./store.js";
export { lastSeen };

/**
 * How long a member may go unheard from before its seat is reclaimable.
 *
 * Ten minutes is 24 long-polls at `bellman_sync`'s 25-second cadence, and that
 * ratio is the whole choice. The window has to be several multiples of the poll
 * interval or a member thinking hard between calls gets reaped out of its own
 * room; it has to be short enough that a bricked `pair` room heals in minutes
 * rather than at the room's TTL, which #18 made long.
 *
 * It is generous deliberately. The cost of reaping too late is a seat held a
 * few minutes longer than necessary. The cost of reaping too early is removing
 * a live member mid-conversation, and only one of those is recoverable by
 * waiting.
 *
 * **The window is no longer the only signal (#140, #146 closed it).** The
 * hibernating WebSocket of #99 carries member ids in `SocketAttachment`, so the
 * room object holds a hard fact about who is connected, and every reading here
 * takes it as `connected`. That matters most to the member the window serves
 * worst: one fed by the socket or the local bus never calls `bellman_sync` at
 * all, and a listen-only member waiting on a peer's reply sends nothing, so it
 * would be the quietest member in the room and the first reaped.
 *
 * `SessionDO.connectedMemberIds` is the source, read from `ctx.getWebSockets()`
 * synchronously inside `seatMember`'s own transaction — NOT from
 * `webSocketClose`, which `store-do.ts` records as the wrong hook because the
 * runtime drops a closed socket from `getWebSockets()` on its own, and which
 * would leak a member whose socket vanished without a close frame.
 *
 * Stamping `lastSeenAt` on the upgrade was the other half of #140's proposal
 * and was deliberately NOT taken. `fetch` is built around "the only await; from
 * here to the return nothing yields", a session write there would add one to
 * every upgrade, and it buys a single window where reading the live list is
 * permanent.
 */
export const STALE_AFTER_MS = 10 * 60 * 1000;

export type Presence = "present" | "stale" | "departed";

/**
 * `connected` is the members an open socket is carrying right now, and it beats
 * the window: the room object is being TOLD, where `lastSeenAt` is an inference
 * from traffic that a socket-fed client no longer sends (#140, #146).
 *
 * `leftAt` still wins over it. Departure is deliberate and permanent, and
 * nothing closes a reaped member's sockets — `memberIds` has no reader doing
 * that — so a departed id can be in the set and must not read as present.
 *
 * Optional, and third, so every existing caller keeps the reading it had. A
 * caller that CAN know who is connected should pass it; one that cannot is
 * saying "no socket evidence here", which is `MemoryStore` and every pure
 * roster computation.
 *
 * **Do not pass this function to `Array.map`.** `publicMember` (src/server.ts)
 * carries the full argument: `map` supplies the index as the second argument,
 * which an optional `now` silently read as `now = 0`, making every member
 * present. A third parameter is the same trap — `map` would pass the array as
 * `connected`. That one at least throws rather than lying, because an array has
 * no `.has`, but the fix is the same: map through an explicit arrow.
 */
export function presenceOf(
  m: Member,
  now: number = Date.now(),
  connected?: ReadonlySet<string>,
): Presence {
  if (!isActiveMember(m)) return "departed";
  if (connected?.has(m.memberId)) return "present";
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
  connected?: ReadonlySet<string>,
): Member[] => members.filter((m) => presenceOf(m, now, connected) === "present");

/**
 * Takes `connected` for the same reason `presentMembers` does, and it is not
 * decoration: the two are complements, and a member counted present by a
 * capacity gate while reading stale on a roster is the same seat described two
 * ways. Both readings consult the same evidence or neither does.
 */
export const staleMembers = (
  members: Member[],
  now: number = Date.now(),
  connected?: ReadonlySet<string>,
): Member[] => members.filter((m) => presenceOf(m, now, connected) === "stale");
