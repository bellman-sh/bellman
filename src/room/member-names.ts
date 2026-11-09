/**
 * The name a reader outside a room is shown for each of its members (ADR 0011, decision 5):
 * "member 1", "member 2" and on, from the room's own numbering, and "host" for the hosted seat.
 * One function builds the map from a room's labels to those names, and each place that puts
 * members in front of such a reader names them through it: the public routes (`byNumber`,
 * src/http/public.ts) and the hosted seat's prompt (`answerPrompt`, src/host.ts), whose answer
 * lands in a public room's log. So the two cannot name a member differently.
 *
 * Runtime-free, like public-names.ts: the routes, the host and both test programs import it.
 */
import { HOST_LABEL, isActiveMember } from "./members.js";
import type { BellmanStore } from "../storage/store.js";
import type { Member } from "../types.js";
import type { RoomResult } from "./rooms.js";

/**
 * The name for each of these labels in a room: "member N" for a label the room numbered, and
 * "host" for the hosted seat's. The store numbers a label when it first seats it, and every later
 * seat with that label reads the number back (ADR 0019, D6), so a number never changes, a member
 * who has left keeps theirs, and one person's handles share a label and so share a number. The
 * store gives the seat no number, and its label, `host@bellman`, reads as an email address on a
 * public page, so the seat is named here instead. Its stored label does not change. A label the
 * room has not numbered has no entry, and each caller decides what it shows for one.
 */
export async function publicNames(
  store: Pick<BellmanStore, "publicNumbers">,
  sessionId: string,
  labels: Iterable<string>,
): Promise<Map<string, string>> {
  const numbers = await store.publicNumbers(sessionId, [...new Set(labels)]);
  const names = new Map(Object.entries(numbers).map(([label, n]) => [label, `member ${n}`]));
  // Set after the numbers, so the seat keeps its name even if the store were to number that label.
  names.set(HOST_LABEL, "host");
  return names;
}

/** The most seats one `bellman_send` may address (seat names spec). */
export const MAX_ADDRESSEES = 20;

/**
 * A seat's name in its room (seat names spec): `<role>-<seq>`. Both fields are fixed when the seat is taken and `seq` is
 * never reused, so a name means one seat for the life of the room. A role key's last hyphen is followed by digits only,
 * so no two seats share a name. Derived, never stored.
 */
export const seatName = (m: Pick<Member, "roomRole" | "seq">): string => `${m.roomRole}-${m.seq}`;

/** Every member's seat name, by member id. */
export const seatNames = (members: readonly Member[]): ReadonlyMap<string, string> =>
  new Map(members.map((m) => [m.memberId, seatName(m)]));

const invalid = (reason: string): RoomResult<never> => ({ ok: false, code: "invalid", reason });

/**
 * The active members `names` address, matched case-insensitively, once each, in the order given. Refused, naming the
 * name: one that is no active seat (a departed seat included), the sender's own, and a seat without `receive_messages`;
 * and more than `MAX_ADDRESSEES` names.
 */
export function resolveAddressees(
  session: { members: readonly Member[] },
  me: Pick<Member, "memberId">,
  names: readonly string[],
): RoomResult<Member[]> {
  if (names.length > MAX_ADDRESSEES) return invalid(`at most ${MAX_ADDRESSEES} addressees.`);
  const byName = new Map(session.members.filter(isActiveMember).map((m) => [seatName(m), m]));
  const out: Member[] = [];
  for (const raw of names) {
    const name = raw.toLowerCase();
    const seat = byName.get(name);
    if (!seat) return invalid(`no active seat named ${raw} in this room.`);
    if (seat.memberId === me.memberId) return invalid(`you cannot address yourself (${name}).`);
    if (!seat.capabilities.includes("receive_messages")) return invalid(`${name} does not allow receive_messages.`);
    if (!out.includes(seat)) out.push(seat);
  }
  return { ok: true, value: out };
}
