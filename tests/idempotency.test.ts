/**
 * The key layout and the fingerprint rule, tested where store-do.ts cannot be
 * reached — it imports `cloudflare:workers`. Same reason grant-index.ts exists.
 */
import { describe, it, expect } from "vitest";
import { fingerprint, idempotencyKey } from "../src/idempotency.js";
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

  it("is stable for the same pair", () => {
    expect(idempotencyKey("m_aaaa1111", "send-1"))
      .toBe(idempotencyKey("m_aaaa1111", "send-1"));
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

  /** REVIEW FOCUS 3: array order is content, not layout. */
  it("does not ignore array order", () => {
    expect(fingerprint(draft({ payload: { steps: ["a", "b"] } })))
      .not.toBe(fingerprint(draft({ payload: { steps: ["b", "a"] } })));
  });

  it("sorts object keys inside arrays", () => {
    expect(fingerprint(draft({ payload: { rows: [{ a: 1, b: 2 }] } })))
      .toBe(fingerprint(draft({ payload: { rows: [{ b: 2, a: 1 }] } })));
  });

  /** REVIEW FOCUS 2: payload is `unknown`. A throw here breaks every send. */
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

  it("differs when type, refId or payload differ", () => {
    const base = fingerprint(draft());
    expect(fingerprint(draft({ type: "artifact" as SessionEvent["type"] }))).not.toBe(base);
    expect(fingerprint(draft({ refId: "7" }))).not.toBe(base);
    expect(fingerprint(draft({ payload: { text: "other" } }))).not.toBe(base);
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
