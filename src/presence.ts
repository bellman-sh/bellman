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
 * **A gap this leaves open: #140.** The hibernating WebSocket of #99 has
 * already landed, and `SocketAttachment` carries the member ids
 * (`store-do.ts`), so the object holds a hard fact about who is connected —
 * better than any timeout, because it is being told rather than inferring.
 * Nothing here consults it. That is latent only while every client still
 * long-polls `bellman_sync`: the first one that prefers the socket stops
 * touching `lastSeenAt` and looks stale with a live connection, and is then the
 * quietest member in the room by construction, so the next joiner takes its
 * seat. Closing it means stamping `lastSeenAt` when the socket is accepted and
 * excluding connected members from `seatVictims` inside the object — not
 * `webSocketClose`, which `store-do.ts` records as the wrong hook because the
 * runtime drops a closed socket from `getWebSockets()` on its own.
 */
export const STALE_AFTER_MS = 10 * 60 * 1000;

export type Presence = "present" | "stale" | "departed";

export function presenceOf(m: Member, now: number = Date.now()): Presence {
  if (!isActiveMember(m)) return "departed";
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
export const presentMembers = (members: Member[], now: number = Date.now()): Member[] =>
  members.filter((m) => presenceOf(m, now) === "present");

export const staleMembers = (members: Member[], now: number = Date.now()): Member[] =>
  members.filter((m) => presenceOf(m, now) === "stale");
