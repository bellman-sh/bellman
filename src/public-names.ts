/**
 * Public names (public names spec): the rule a name keeps (D2) and whether a room holds one (D5).
 * Runtime-free, like projections.ts, so the routes, the tools and both test programs import it.
 */
import { isPublic } from "./store.js";
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
