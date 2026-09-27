import type { SessionEvent } from "./types.js";

/**
 * Key layout and content fingerprint for idempotent event appends.
 *
 * Runtime-free and in its own module for the reason grant-index.ts gives:
 * store-do.ts imports `cloudflare:workers`, so no vitest test can reach inside
 * it. The parts worth testing are not the storage calls, they are this key
 * layout and the fingerprint rule — so those live here, where the suite can
 * hold them to account.
 */

/** What a remembered key resolves to. Both implementations store this. */
export interface IdempotencyRecord {
  cursor: number;
  print: string;
}

/**
 * `ik:<memberId>:<key>`, with the member segment encoded.
 *
 * The client supplies `key` and it may contain anything, a colon included.
 * That is harmless only while the member segment cannot contain one: otherwise
 * the encoding is not injective and two (member, key) pairs collide, letting
 * one member's retry resolve to another member's event — the cross-talk that
 * per-member scoping exists to prevent.
 *
 * Member ids are server-generated (`m_` plus 8 hex) or the literal "system",
 * so none of them contains a colon today. Encoded anyway, for the reason
 * grant-index.ts encodes its org segment: the alternative is a grammar every
 * future caller has to remember to honour.
 */
export const idempotencyKey = (memberId: string, key: string): string =>
  `ik:${encodeURIComponent(memberId)}:${key}`;

/**
 * A canonical print of the parts of an event a retry must reproduce.
 *
 * `fromUserId` and `fromLabel` are left out deliberately: they come from the
 * authenticated identity rather than the caller's arguments, so including them
 * would make a relabelled identity read as a conflict on an identical retry.
 */
export function fingerprint(e: Omit<SessionEvent, "cursor" | "at">): string {
  return JSON.stringify([e.type, e.fromMemberId, e.refId, canonical(e.payload)]);
}

/**
 * Sorts object keys at every depth; leaves arrays and primitives alone.
 *
 * Sorting is not cosmetic. JSON.stringify preserves insertion order, and a
 * retrying client may rebuild its payload rather than hold the original — same
 * content, different order. Unsorted, an honest retry reads as a conflict,
 * which is the one outcome that tells a client to stop retrying.
 *
 * Array order survives, because there it is content rather than layout.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  // Object.create(null), not {}: for k === "__proto__" a plain object's
  // `out[k] = …` invokes the prototype setter instead of creating an own
  // property, so JSON.stringify never sees the member and two payloads that
  // differ only inside it fingerprint identically — a conflict that reads as a
  // replay, telling the caller the wrong message was delivered. Payloads are
  // untrusted peer content, so this is not a theoretical shape.
  const out: Record<string, unknown> = Object.create(null);
  for (const k of Object.keys(source).sort()) out[k] = canonical(source[k]);
  return out;
}
