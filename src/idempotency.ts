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
 *
 * Equal prints mean equal JSON-serialised content, and `payload` is expected
 * to be `JSON.parse` output: a `Date` would print as `{}`, and `-0` shares a
 * print with `0` because JSON cannot tell them apart. A payload nested deeper
 * than `MAX_PAYLOAD_DEPTH` throws `PayloadTooDeepError`.
 *
 * The print is stored, and a change to canonicalization invalidates every one
 * already written, so retries in flight across that deploy would read as
 * conflicts — such a change needs a deliberate migration decision, not a
 * silent edit. There is deliberately no version prefix on the print: a tag
 * nothing branches on would describe the breakage without preventing it.
 */
export function fingerprint(e: Omit<SessionEvent, "cursor" | "at">): string {
  return JSON.stringify([e.type, e.fromMemberId, e.refId, canonical(e.payload)]);
}

/**
 * Deep enough that no brief, message or artifact reaches it, and far below the
 * stack floor of any runtime this runs on — an unguarded canonical() throws
 * from about depth 2,120 on Node 22, and Workers' V8 differs.
 */
export const MAX_PAYLOAD_DEPTH = 64;

/**
 * A payload nested deeper than `MAX_PAYLOAD_DEPTH`.
 *
 * Typed, rather than the `RangeError` an unguarded recursion would raise: the
 * tool layer has to tell this apart from a genuine bug to refuse the send with
 * a message that says what to change. Thrown, never truncated — a print that
 * silently dropped everything below some depth would make two different
 * payloads agree, which is the collision this whole module exists to avoid.
 */
export class PayloadTooDeepError extends Error {
  constructor(readonly depth: number) {
    super(`payload nests deeper than ${MAX_PAYLOAD_DEPTH} levels`);
    this.name = "PayloadTooDeepError";
  }
}

/**
 * Sorts object keys at every depth, including those of objects inside arrays;
 * primitives pass through.
 *
 * Sorting is not cosmetic. JSON.stringify preserves insertion order, and a
 * retrying client may rebuild its payload rather than hold the original — same
 * content, different order. Unsorted, an honest retry reads as a conflict,
 * which is the one outcome that tells a client to stop retrying.
 *
 * Array order survives, because there it is content rather than layout.
 *
 * `depth` is the nesting level of `value`, the payload's own container being
 * level 1. A container past MAX_PAYLOAD_DEPTH throws instead of recursing
 * until the stack gives out; PayloadTooDeepError says why it never truncates.
 */
function canonical(value: unknown, depth = 1): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_PAYLOAD_DEPTH) throw new PayloadTooDeepError(depth);
  if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1));
  const source = value as Record<string, unknown>;
  // Object.create(null), not {}: for k === "__proto__" a plain object's
  // `out[k] = …` invokes the prototype setter instead of creating an own
  // property, so JSON.stringify never sees the member and two payloads that
  // differ only inside it fingerprint identically — a conflict that reads as a
  // replay, telling the caller the wrong message was delivered. Payloads are
  // untrusted peer content, so this is not a theoretical shape.
  const out: Record<string, unknown> = Object.create(null);
  for (const k of Object.keys(source).sort()) out[k] = canonical(source[k], depth + 1);
  return out;
}
