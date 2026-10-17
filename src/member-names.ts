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
import { HOST_LABEL, type BellmanStore } from "./store.js";

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
