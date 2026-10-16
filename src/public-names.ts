/**
 * Public names (public names spec): the rule a name keeps (D2) and whether a room holds one (D5).
 * Runtime-free, like projections.ts, so the routes, the tools and both test programs import it.
 */
import { isPublic } from "./store.js";
import type { BellmanStore, PublicNameEntry } from "./store.js";
import type { StoredSession } from "./stored-session.js";

/** D2. No `_`, so a name can never be read as a session id, which always has one. */
export const PUBLIC_NAME = /^(?=.{3,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The refusal for a name outside D2's rule, in its words, or null. Never rewritten: the name checked is the name set. */
export function publicNameRefusal(name: string): string | null {
  return PUBLIC_NAME.test(name)
    ? null
    : `public name ${JSON.stringify(name)}: use 3 to 40 lowercase letters, digits and single hyphens, starting and ending with a letter or digit`;
}

type Holder = Pick<StoredSession, "publicName" | "manifest" | "unpublishedAt" | "closed">;

/** Whether `session` holds `name` (D5): its record names it, and it is public and open. The index is only a hint. */
export const holdsName = (session: Holder | undefined, name: string): boolean =>
  session !== undefined && session.publicName === name && isPublic(session) && !session.closed;

/** The name `session` holds, or null: one its record still names after a close or unpublish holds nothing. */
export const heldName = (session: Holder): string | null =>
  session.publicName !== null && holdsName(session, session.publicName) ? session.publicName : null;

/**
 * How long a claim holds its name before its room's record names it (D5 as amended, the final
 * review's I1): a claim still in flight must not read as free. ponytail: one fixed lease, longer than
 * any request; a claim whose record never lands and that nothing gives back holds its name this long.
 */
export const PUBLIC_NAME_LEASE_MS = 5 * 60_000;

/** The room that holds `name`, if one does (D5, D6): the index's entry, checked against that room's record. */
export async function roomNamed(store: BellmanStore, name: string): Promise<StoredSession | undefined> {
  const entry = await store.publicNameEntry(name);
  if (entry === null) return undefined;
  const session = await store.getSession(entry.id);
  return holdsName(session, name) ? session : undefined;
}

/**
 * Whether `entry` keeps its name from another claim (D5 as amended). A room whose record names it holds
 * it while public and open, and nothing after. An entry whose room's record does not name it may be a
 * claim still in flight, so it holds while younger than the lease.
 */
async function entryHolds(store: BellmanStore, name: string, entry: PublicNameEntry, now: number): Promise<boolean> {
  const session = await store.getSession(entry.id);
  if (session?.publicName === name) return holdsName(session, name);
  return now - entry.at < PUBLIC_NAME_LEASE_MS;
}

/** Whether `name` can be claimed now (D3's check): no entry, or one that keeps it from nobody. */
export async function nameFree(store: BellmanStore, name: string, now = Date.now()): Promise<boolean> {
  const entry = await store.publicNameEntry(name);
  return entry === null || !(await entryHolds(store, name, entry, now));
}

/**
 * Claim `name` for `sessionId` (D5): the entry this claim wrote, or null when another room's entry keeps
 * it. A room's own entry is claimed again too, so the write fences a claimer that read it before (a
 * rename back to a name the room held). The caller writes the room's record after, and gives the claim
 * back (`releasePublicName`) when a later step refuses.
 */
export async function claimName(store: BellmanStore, name: string, sessionId: string, now = Date.now()): Promise<PublicNameEntry | null> {
  const current = await store.publicNameEntry(name);
  if (current !== null && current.id !== sessionId && (await entryHolds(store, name, current, now))) return null;
  const mine = { id: sessionId, at: now };
  return (await store.claimPublicName(name, mine, current)) ? mine : null;
}
