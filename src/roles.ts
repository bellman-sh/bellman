import type { Member, RoomManifest, Verb } from "./types.js";
import type { StoredSession } from "./stored-session.js";

/**
 * The verbs a role holds — one of the two places `manifest.roles` is indexed;
 * `mustReport` below is the other.
 *
 * Fails closed: a role the manifest does not define holds nothing. No tool path
 * produces that today, because both seats are assigned from `creatorRole` and
 * `defaultRole`, which resolveManifest checked against `roles`. But sessions
 * round-trip through JSON in Durable Objects and #3 is about to make join codes
 * carry a role, so an unrecognised seat holds no authority rather than throwing.
 *
 * `Object.hasOwn` rather than a bare lookup. Every name reachable on
 * Object.prototype happens to have no `can`, so this is not what stops
 * `roles["constructor"]` today — RoleKeyShape's ban is. It is here so the
 * accessor stays total under a rewrite.
 */
export function verbsOfRole(manifest: RoomManifest, role: string): readonly Verb[] {
  return Object.hasOwn(manifest.roles, role) ? manifest.roles[role].can : [];
}

/**
 * Whether this seat must answer the room's heartbeat tick — the other place
 * `manifest.roles` is indexed, and it fails closed for the same reason
 * `verbsOfRole` does: a role the manifest does not define is asked for nothing.
 *
 * `Object.hasOwn` rather than a bare lookup, so the accessor stays total under a
 * rewrite. `roles["constructor"]` on a plain object is the inherited Object
 * function, which has no `reports`, but relying on that is relying on the shape
 * of something else.
 */
export function mustReport(manifest: RoomManifest, role: string): boolean {
  return Object.hasOwn(manifest.roles, role) ? manifest.roles[role].reports : false;
}

/**
 * Whether this member's seat may perform `verb`: null when it may, otherwise the
 * sentence the tool hands back.
 *
 * Takes a Session and a Member and NOT an Identity, deliberately. `Identity.role`
 * ("member" | "admin") is platform authority over an org and buys nothing inside
 * a room; an org admin is not automatically anything in a room, and a room's
 * creator need not be an org admin. Keeping Identity out of this signature is
 * what makes that structural rather than a convention.
 *
 * DO NOT add an Identity parameter. See the design's D2, and the grep invariant
 * in tests/tools/verbs.test.ts.
 *
 * Everything interpolated is server-controlled: `roomRole` is assigned from a
 * manifest role name (RoleKeyShape: `[a-z][a-z0-9_]{0,30}`) and verbs come from
 * the closed enum, so nothing here needs bounding or escaping.
 */
export function denyVerb(session: StoredSession, me: Member, verb: Verb): string | null {
  const held = verbsOfRole(session.manifest, me.roomRole);
  if (held.includes(verb)) return null;
  const holds = held.length > 0 ? held.join(", ") : "none";
  return `your role "${me.roomRole}" does not hold the verb "${verb}" (it holds: ${holds}).`;
}
