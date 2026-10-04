/**
 * The payload limits bellman_send applies at the door, and their agreement
 * with the fingerprint's own guard.
 *
 * Two walkers enforce `MAX_PAYLOAD_DEPTH`: `assertPayloadDepth` at the send
 * door and `canonical` inside `fingerprint`. The door's exists because the
 * fingerprint's runs only for a KEYED send, so an unkeyed one could store a
 * payload no `JSON.stringify` of a projected event could ever serialize (#136).
 * Two enforcers can drift, and a drift either way is a bug: stricter at the
 * door refuses a send the store would have taken, looser lets the keyed path
 * throw where the door promised a refusal. The agreement is pinned here.
 */
import { describe, it, expect } from "vitest";
import {
  assertPayloadDepth,
  MAX_PAYLOAD_CHARS,
  MAX_PAYLOAD_DEPTH,
  PayloadTooDeepError,
} from "../src/payload.js";
import { fingerprint } from "../src/idempotency.js";
import type { SessionEvent } from "../src/types.js";

/** `levels` containers deep around a leaf, each made by `wrap`. */
const nest = (levels: number, wrap: (inner: unknown) => unknown, leaf: unknown = 1): unknown => {
  let value = leaf;
  for (let i = 0; i < levels; i++) value = wrap(value);
  return value;
};
const inObject = (inner: unknown) => ({ a: inner });
const inArray = (inner: unknown) => [inner];
const WRAPS = [inObject, inArray];

/** What `fn` throws, or undefined if it returns normally. */
const thrownBy = (fn: () => unknown): unknown => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e;
  }
};

const asDraft = (payload: unknown): Omit<SessionEvent, "cursor" | "at"> => ({
  type: "message" as SessionEvent["type"],
  fromMemberId: "m_creator",
  fromUserId: "u_jesse",
  fromLabel: "jesse",
  payload,
  refId: null,
});

describe("assertPayloadDepth", () => {
  it("passes a payload at exactly the bound", () => {
    for (const wrap of WRAPS) {
      expect(thrownBy(() => assertPayloadDepth(nest(MAX_PAYLOAD_DEPTH, wrap)))).toBeUndefined();
    }
  });

  /**
   * 100,000 levels is far beyond where unguarded recursion overflows, so that
   * size pins that the walk stops at the first container over the bound rather
   * than descending first and counting after. Both container kinds, so a guard
   * that counts only objects fails.
   */
  it("refuses a payload past the bound with a typed error, without overflowing", () => {
    for (const wrap of WRAPS) {
      for (const levels of [MAX_PAYLOAD_DEPTH + 1, 100_000]) {
        const refused = thrownBy(() => assertPayloadDepth(nest(levels, wrap)));
        expect(refused).toBeInstanceOf(PayloadTooDeepError);
        expect(refused).toMatchObject({ name: "PayloadTooDeepError", depth: MAX_PAYLOAD_DEPTH + 1 });
      }
    }
  });

  /**
   * Depth is the deepest branch, not the first one walked. A guard that
   * returned on the first leaf would pass this and miss every payload whose
   * deep nesting sits behind a shallow sibling — which is most of them.
   */
  it("finds the deepest branch when a shallow sibling comes first", () => {
    const payload = { shallow: 1, deep: nest(MAX_PAYLOAD_DEPTH, inObject) };
    expect(thrownBy(() => assertPayloadDepth(payload))).toBeInstanceOf(PayloadTooDeepError);
  });

  it("passes primitives, empty containers and a null", () => {
    for (const value of [1, "x", true, null, {}, [], { a: null }, [[], {}]]) {
      expect(thrownBy(() => assertPayloadDepth(value))).toBeUndefined();
    }
  });
});

describe("the door and the fingerprint agree on the bound", () => {
  /** Both refuse, or neither does, and when they refuse they name one depth. */
  const expectAgreement = (payload: unknown) => {
    const atDoor = thrownBy(() => assertPayloadDepth(payload));
    const atPrint = thrownBy(() => fingerprint(asDraft(payload)));

    expect(atDoor === undefined).toBe(atPrint === undefined);
    if (atDoor !== undefined) {
      expect(atDoor).toBeInstanceOf(PayloadTooDeepError);
      expect(atPrint).toBeInstanceOf(PayloadTooDeepError);
      expect((atDoor as PayloadTooDeepError).depth)
        .toBe((atPrint as PayloadTooDeepError).depth);
    }
  };

  it("accept and refuse the same payloads at the same depths", () => {
    for (const wrap of WRAPS) {
      for (const levels of [1, MAX_PAYLOAD_DEPTH - 1, MAX_PAYLOAD_DEPTH, MAX_PAYLOAD_DEPTH + 1]) {
        expectAgreement(nest(levels, wrap));
      }
    }
  });

  /**
   * Alternating containers, because an array costs a level in canonical's walk
   * exactly as an object does. A walk that charged for only one kind would
   * agree on the single-kind cases above and part company here.
   */
  it("agree when object and array levels alternate", () => {
    const alternating = (levels: number) =>
      nest(levels, (inner) => ({ a: [inner] }));
    // Each wrap is two levels, so this straddles the bound.
    for (const pairs of [MAX_PAYLOAD_DEPTH / 2, MAX_PAYLOAD_DEPTH / 2 + 1]) {
      expectAgreement(alternating(pairs));
    }
  });

  /**
   * Depth reached through an own `__proto__` key. JSON.parse makes that an
   * ordinary enumerable property, and canonical walks it deliberately — it
   * goes to the trouble of an Object.create(null) accumulator to keep it in
   * the print. A door walk that skipped the key would leave the one branch
   * canonical still descends unmeasured, which is a disagreement that only
   * untrusted peer content would ever produce.
   */
  it("agree when the depth is reached through an own __proto__ key", () => {
    const viaProto = (levels: number) =>
      JSON.parse(`${'{"__proto__":'.repeat(levels)}1${"}".repeat(levels)}`);
    expectAgreement(viaProto(MAX_PAYLOAD_DEPTH));
    expectAgreement(viaProto(MAX_PAYLOAD_DEPTH + 1));
  });
});

describe("the character bound", () => {
  /**
   * The depth bound has to be the binding one for a nested payload, or it
   * closes nothing: `{"a":` repeated costs about six characters a level, so
   * MAX_PAYLOAD_CHARS alone admits thousands of levels — past where a
   * projected event's own JSON.stringify overflows, which is #136 exactly.
   */
  it("admits a payload far deeper than the depth bound, which is why the depth bound exists", () => {
    const serialized = JSON.stringify(nest(MAX_PAYLOAD_DEPTH + 1, inObject));
    expect(serialized.length).toBeLessThan(MAX_PAYLOAD_CHARS);
  });
});
