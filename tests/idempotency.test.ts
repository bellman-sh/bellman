/**
 * The key layout and the fingerprint rule, tested where store-do.ts cannot be
 * reached — it imports `cloudflare:workers`. Same reason grant-index.ts exists.
 */
import { describe, it, expect } from "vitest";
import {
  fingerprint,
  idempotencyKey,
  MAX_PAYLOAD_DEPTH,
  PayloadTooDeepError,
} from "../src/idempotency.js";
import type { SessionEvent } from "../src/types.js";

const draft = (over: Partial<Omit<SessionEvent, "cursor" | "at">> = {}) => ({
  type: "message" as SessionEvent["type"],
  fromMemberId: "m_creator",
  fromUserId: "u_jesse",
  fromLabel: "jesse",
  payload: { text: "hello" } as unknown,
  refId: null as string | null,
  ...over,
});

/**
 * `levels` containers deep around `leaf`, each made by `wrap`. Built in a loop
 * because the tests must land exactly on the bound, which a literal cannot.
 */
const nest = (levels: number, wrap: (inner: unknown) => unknown, leaf: unknown = 1): unknown => {
  let value = leaf;
  for (let i = 0; i < levels; i++) value = wrap(value);
  return value;
};
const inObject = (inner: unknown) => ({ a: inner });
const inArray = (inner: unknown) => [inner];

/** What `fn` throws, or undefined if it returns normally. */
const thrownBy = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
};

describe("idempotencyKey", () => {
  it("namespaces by member, so two members can use the same key", () => {
    expect(idempotencyKey("m_aaaa1111", "send-1"))
      .not.toBe(idempotencyKey("m_bbbb2222", "send-1"));
  });

  /**
   * The client-supplied key may contain a colon; the member segment must not,
   * or the encoding is not injective and one member's retry resolves to
   * another member's event.
   */
  it("keeps a colon in the member id out of the encoding", () => {
    expect(idempotencyKey("m_a:b", "x")).not.toBe(idempotencyKey("m_a", "b:x"));
  });

  /** The separator, its escape, and look-alikes: every pair must map to its own key. */
  it("keeps distinct (member, key) pairs distinct, colons and percent signs included", () => {
    const members = ["m_a", "m_a:b", "m_a%3Ab", "m_a_b", ":", "%3A", ""];
    const keys = ["x", "b:x", ":", "%3A", "", "ik:x"];
    const seen = new Map<string, string>();
    for (const m of members) for (const k of keys) {
      const id = idempotencyKey(m, k);
      const pair = JSON.stringify([m, k]);
      expect(seen.get(id), `${pair} collides with ${seen.get(id)}`).toBeUndefined();
      seen.set(id, pair);
    }
  });

  it("is stable for the same pair", () => {
    expect(idempotencyKey("m_aaaa1111", "send-1"))
      .toBe(idempotencyKey("m_aaaa1111", "send-1"));
  });

  /**
   * The layout itself, not just its properties. Every key already in storage
   * spells this, so changing the format strands them: the rows stay, nothing
   * resolves to them, and every retry in flight reads as a fresh send. Same
   * hazard as the print's canonicalization, one level down.
   */
  it("spells the documented layout", () => {
    expect(idempotencyKey("m_1a2b3c4d", "send-1")).toBe("ik:m_1a2b3c4d:send-1");
  });

  /**
   * The client's key is the raw remainder of that layout, never encoded. It may
   * hold a colon, a percent sign or a space, and it must come back out exactly
   * as it went in: a stored key that held one stops resolving the day this
   * changes. The layout test's key has nothing that needs encoding, so it
   * cannot see this.
   */
  it("keeps the client's key verbatim, awkward characters included", () => {
    expect(idempotencyKey("m_1a2b3c4d", "a:b%3A c/D")).toBe("ik:m_1a2b3c4d:a:b%3A c/D");
  });
});

describe("fingerprint", () => {
  it("matches for the same content", () => {
    expect(fingerprint(draft())).toBe(fingerprint(draft()));
  });

  /**
   * A retrying client may rebuild its payload rather than hold the original.
   * Same content, different insertion order. Unsorted this reads as a
   * conflict, which is the one outcome telling a client to stop retrying.
   */
  it("ignores object key order, at every depth", () => {
    const a = draft({ payload: { a: 1, b: { x: 1, y: 2 } } });
    const b = draft({ payload: { b: { y: 2, x: 1 }, a: 1 } });
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  /** Array order is content, not layout. */
  it("does not ignore array order", () => {
    expect(fingerprint(draft({ payload: { steps: ["a", "b"] } })))
      .not.toBe(fingerprint(draft({ payload: { steps: ["b", "a"] } })));
  });

  it("sorts object keys inside arrays", () => {
    expect(fingerprint(draft({ payload: { rows: [{ a: 1, b: 2 }] } })))
      .toBe(fingerprint(draft({ payload: { rows: [{ b: 2, a: 1 }] } })));
  });

  /**
   * The other direction of the two sort tests. Those assert "same content in a
   * different order is equal", which a print that discarded nested content also
   * satisfies. A difference below the top level must change the print: a false
   * "replay" here silently drops a real message.
   */
  it("differs when content differs below the top level", () => {
    const at = (payload: unknown) => fingerprint(draft({ payload }));
    expect(at({ a: { b: { c: { d: 1 } } } })).not.toBe(at({ a: { b: { c: { d: 2 } } } }));
    expect(at({ rows: [{ id: 1 }] })).not.toBe(at({ rows: [{ id: 2 }] }));
    expect(at([[1]])).not.toBe(at([[2]]));
  });

  /** Payload is `unknown`. A throw here breaks every send. */
  it("handles a payload that is not a plain object", () => {
    for (const payload of [null, "text", 42, true, [1, 2]]) {
      expect(() => fingerprint(draft({ payload }))).not.toThrow();
    }
    expect(fingerprint(draft({ payload: null })))
      .not.toBe(fingerprint(draft({ payload: "text" })));
  });

  /**
   * A `__proto__` member is an own property when it arrives over JSON-RPC, and
   * it must reach the print like any other. Built with JSON.parse deliberately:
   * an object literal's `__proto__:` is a prototype assignment, not a member.
   */
  it("does not drop a __proto__ member from the print", () => {
    const one = draft({ payload: JSON.parse('{"__proto__":{"x":1},"a":1}') });
    const two = draft({ payload: JSON.parse('{"__proto__":{"x":2},"a":1}') });

    expect(fingerprint(one)).not.toBe(fingerprint(two));
  });

  /**
   * Past the bound the walk stops at the first container over it, with a typed
   * error rather than a stack overflow. 100,000 levels is far beyond where
   * unguarded recursion overflows, so that size also pins that the guard fires
   * on the way down, not after. Both container kinds, so a guard that counts
   * only one of them fails.
   */
  it("refuses a payload nested past the bound, with a typed error", () => {
    for (const wrap of [inObject, inArray]) {
      for (const levels of [MAX_PAYLOAD_DEPTH + 1, 100_000]) {
        const refused = thrownBy(() => fingerprint(draft({ payload: nest(levels, wrap) })));
        expect(refused).toBeInstanceOf(PayloadTooDeepError);
        expect(refused).toMatchObject({ name: "PayloadTooDeepError", depth: MAX_PAYLOAD_DEPTH + 1 });
      }
    }
  });

  /**
   * Exactly at the bound is still allowed, and the print still tells two
   * payloads apart at the deepest level: a guard that cut the walk short, or
   * truncated instead of throwing, would let them agree.
   */
  it("still fingerprints at exactly the bound, and still tells payloads apart there", () => {
    for (const wrap of [inObject, inArray]) {
      const at = (leaf: unknown) => fingerprint(draft({ payload: nest(MAX_PAYLOAD_DEPTH, wrap, leaf) }));
      expect(at(1)).toBe(at(1));
      expect(at(1)).not.toBe(at(2));
    }
  });

  it("differs when type, refId or payload differ", () => {
    const base = fingerprint(draft());
    expect(fingerprint(draft({ type: "artifact" as SessionEvent["type"] }))).not.toBe(base);
    expect(fingerprint(draft({ refId: "7" }))).not.toBe(base);
    expect(fingerprint(draft({ payload: { text: "other" } }))).not.toBe(base);
  });

  it("tells a null refId from an empty one", () => {
    expect(fingerprint(draft({ refId: "" }))).not.toBe(fingerprint(draft({ refId: null })));
  });

  /**
   * Redundant today — the storage key's member segment comes from this same
   * field — and kept as the second defence grant-index.ts argues for, against
   * a future caller that derives the key from something else.
   */
  it("differs when only fromMemberId differs", () => {
    expect(fingerprint(draft({ fromMemberId: "m_other" })))
      .not.toBe(fingerprint(draft()));
  });

  /**
   * fromUserId and fromLabel come from the authenticated identity, not the
   * caller's arguments. Including them would make a relabelled identity read
   * as a conflict on an otherwise identical retry.
   */
  it("ignores the fields the caller does not choose", () => {
    expect(fingerprint(draft({ fromUserId: "u_other", fromLabel: "other" })))
      .toBe(fingerprint(draft()));
  });
});
