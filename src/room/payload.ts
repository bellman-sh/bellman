/**
 * The bounds a send payload has to satisfy, and the walk that enforces the
 * depth one.
 *
 * Runtime-free and in its own module for the reason idempotency.ts gives: the
 * bounds are shared by the tool layer and by the fingerprint that store-do.ts
 * calls, and store-do.ts imports `cloudflare:workers`, so nothing that both
 * must agree on can live there.
 *
 * Both bounds in one place because bellman_send applies both at the same point,
 * and because neither is sufficient alone — see MAX_PAYLOAD_DEPTH.
 */

/**
 * Serialized length bound, escapes included.
 *
 * It is a bound on cost, not on shape: a payload can be well under it and
 * still be unservable, which is what MAX_PAYLOAD_DEPTH is for.
 */
export const MAX_PAYLOAD_CHARS = 20_000;

/**
 * Nesting bound. Deep enough that no brief, message or artifact reaches it,
 * and far below the stack floor of any runtime this runs on — an unguarded
 * walk throws from about depth 2,120 on Node 22, and Workers' V8 differs.
 *
 * Not implied by MAX_PAYLOAD_CHARS. `{"a":` costs about six characters a
 * level, so 20,000 characters admit thousands of levels — past that stack
 * floor. A payload in that range serializes at the tool boundary and then
 * cannot be serialized again inside `publicEvent`'s extra wrapper, one level
 * deeper. Stored, that row is permanent: every later socket connect from
 * before its cursor replays it and fails on it again, and the room is
 * unwatchable over /ws for good (#136).
 */
export const MAX_PAYLOAD_DEPTH = 64;

/**
 * A payload nested deeper than `MAX_PAYLOAD_DEPTH`.
 *
 * Typed, rather than the `RangeError` an unguarded recursion would raise: the
 * tool layer has to tell this apart from a genuine bug to refuse the send with
 * a message that says what to change. Thrown, never truncated — a print that
 * silently dropped everything below some depth would make two different
 * payloads agree, which is the collision idempotency.ts exists to avoid.
 */
export class PayloadTooDeepError extends Error {
  readonly depth: number;

  constructor(depth: number) {
    super(`payload nests deeper than ${MAX_PAYLOAD_DEPTH} levels`);
    this.name = "PayloadTooDeepError";
    this.depth = depth;
  }
}

/**
 * Throws `PayloadTooDeepError` if any branch of `payload` nests past
 * `MAX_PAYLOAD_DEPTH`; returns nothing otherwise.
 *
 * The second enforcer of this bound. `canonical` in idempotency.ts is the
 * first, but it runs only when a send carries an idempotency_key, so it left
 * every unkeyed send unguarded. This one runs at the door, on every send.
 *
 * It deliberately mirrors `canonical`'s walk — same levelling, same traversal,
 * same throw — because the two must refuse exactly the same payloads. Stricter
 * here and the door turns away a send the store would have taken; looser and
 * the keyed path throws where the door promised a refusal. `tests/payload.test.ts`
 * holds them to each other.
 *
 * A separate walk rather than calling `fingerprint`: the door needs the bound,
 * not the print, and canonicalizing a 20,000-character payload to throw it
 * away is work for nothing. The duplication is paid for by that test.
 */
export function assertPayloadDepth(payload: unknown): void {
  walk(payload, 1);
}

/**
 * `depth` is the nesting level of `value`, the payload's own container being
 * level 1 — `canonical`'s convention exactly.
 *
 * The bound is checked before descending, so a payload nested far past it
 * throws at level MAX_PAYLOAD_DEPTH + 1 instead of recursing until the stack
 * gives out. That is what makes this safe to run on untrusted peer content.
 */
function walk(value: unknown, depth: number): void {
  if (value === null || typeof value !== "object") return;
  if (depth > MAX_PAYLOAD_DEPTH) throw new PayloadTooDeepError(depth);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, depth + 1);
    return;
  }
  const source = value as Record<string, unknown>;
  // Object.keys, matching canonical: for JSON.parse output an own "__proto__"
  // is an ordinary enumerable key, and skipping it would leave a branch
  // unmeasured that canonical goes on to walk.
  for (const k of Object.keys(source)) walk(source[k], depth + 1);
}
