/**
 * A retried bellman_send is a no-op that returns the original result.
 *
 * The store contract proves the append semantics. What is proved here is the
 * tool's part: that a replay writes no second audit line, applies no second
 * brief, and tells the caller it is not a fresh delivery.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Harness, DEV_KEY, envelopes } from "../helpers/harness.js";
import { pairUp } from "../helpers/flows.js";
import { brief } from "../helpers/fixtures.js";
import { MAX_PAYLOAD_DEPTH } from "../../src/idempotency.js";

let h: Harness;

beforeEach(() => { h = new Harness(); });
afterEach(async () => { await h.close(); });

const KEY = "send-0001";

/**
 * `levels` containers deep around a primitive leaf, built in a loop because
 * the test below must land exactly past `MAX_PAYLOAD_DEPTH`, which a literal
 * cannot do legibly.
 */
const deepPayload = (levels: number): Record<string, unknown> => {
  let inner: unknown = 1;
  for (let i = 0; i < levels; i++) inner = { a: inner };
  return inner as Record<string, unknown>;
};

describe("bellman_send with an idempotency_key", () => {
  it("delivers one event for two identical sends", async () => {
    const p = await pairUp(h);
    const send = () => p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "only once" }, idempotency_key: KEY,
    });

    const first = await send();
    const second = await send();

    expect(first.isError).toBe(false);
    expect(second.isError).toBe(false);
    expect(second.data.cursor).toBe(first.data.cursor);
    expect(first.data.replayed).toBeUndefined();
    expect(second.data.replayed).toBe(true);

    const sync = await p.creator.call("bellman_sync", {
      session_id: p.sessionId, member_id: p.creatorMemberId, since_cursor: 0,
    });
    // bellman_sync wraps each event as {trust, origin, data}: unwrap with
    // envelopes()/.data, the pattern exchange.test.ts uses. Reading `.type`
    // straight off the envelope reads `undefined` on every item, so the
    // filter always empties the array — this assertion could never pass,
    // correct delivery or not, until the unwrap matched the actual shape.
    const messages = envelopes(sync.data.events)
      .map((e) => e.data as { type: string })
      .filter((e) => e.type === "message");
    expect(messages).toHaveLength(1);
  });

  /**
   * D8. Auditing a replay is the bug #68 shipped, moved one layer down: a
   * redelivered write appending a line for something that did not happen.
   */
  it("writes one audit line, not two", async () => {
    const p = await pairUp(h);
    for (let i = 0; i < 3; i++) {
      await p.joiner.call("bellman_send", {
        session_id: p.sessionId, member_id: p.joinerMemberId,
        type: "message", payload: { text: "only once" }, idempotency_key: KEY,
      });
    }

    const entries = await h.store.auditForOrg("org_codenerd", 50);
    expect(entries.filter((e) => e.action === "sent_message")).toHaveLength(1);
  });

  it("fails when the key is reused for different content", async () => {
    const p = await pairUp(h);
    await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "first" }, idempotency_key: KEY,
    });

    const clash = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "second" }, idempotency_key: KEY,
    });

    expect(clash.isError).toBe(true);
    expect(clash.text).toContain(KEY);
    // Relative, not absolute: how many events the handshake leaves behind is
    // not this test's business, and hard-coding it makes the test fail for the
    // wrong reason the next time the handshake changes.
    const after = await h.store.eventsAfter(p.sessionId, 0);
    expect(after.filter((e) => e.type === "message")).toHaveLength(1);
  });

  it("still appends when no key is given", async () => {
    const p = await pairUp(h);
    const send = () => p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "twice" },
    });

    const first = await send();
    const second = await send();

    expect(second.data.cursor).not.toBe(first.data.cursor);
  });

  /**
   * D9. The brief write used to precede the append, so a frozen room wrote the
   * brief and then refused the event. A replay must not re-apply it either.
   */
  it("applies a replayed brief_update once", async () => {
    const p = await pairUp(h);
    const updated = brief({ goal: "the new goal" });
    const send = () => p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "brief_update", payload: updated, idempotency_key: KEY,
    });

    await send();
    const again = await send();

    expect(again.data.replayed).toBe(true);
    const s = await h.store.getSession(p.sessionId);
    const me = s!.members.find((m) => m.memberId === p.joinerMemberId)!;
    expect(me.brief.goal).toBe("the new goal");
    const events = await h.store.eventsAfter(p.sessionId, 0);
    expect(events.filter((e) => e.type === "brief_update")).toHaveLength(1);
  });

  /**
   * D9, and the one case that actually reaches the brief write.
   *
   * A frozen room is refused by the third guard in the handler, before the
   * brief write — so freezing proves nothing about this ordering. A reused key
   * is different: every guard passes, the brief is written under the old
   * ordering, and only then does the store report the conflict. This test is
   * red without the fix and green with it.
   */
  it("leaves the brief alone when the key is reused for different content", async () => {
    const p = await pairUp(h);
    await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "brief_update", payload: brief({ goal: "the first goal" }),
      idempotency_key: KEY,
    });

    const clash = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "brief_update", payload: brief({ goal: "should not land" }),
      idempotency_key: KEY,
    });

    expect(clash.isError).toBe(true);
    const me = (await h.store.getSession(p.sessionId))!
      .members.find((m) => m.memberId === p.joinerMemberId)!;
    expect(me.brief.goal).toBe("the first goal");
  });

  /** REVIEW FOCUS 4: the zod bounds, which no other test reaches. */
  it("enforces the key length bounds", async () => {
    const p = await pairUp(h);
    const withKey = (idempotency_key: string) => p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "bounds" }, idempotency_key,
    });

    expect((await withKey("a".repeat(7))).isError).toBe(true);
    expect((await withKey("a".repeat(8))).isError).toBe(false);
    expect((await withKey("b".repeat(80))).isError).toBe(false);
    expect((await withKey("c".repeat(81))).isError).toBe(true);
  });

  /**
   * The addition this task's brief does not contain. `fingerprint` (Task 1)
   * throws `PayloadTooDeepError` on a payload nested past `MAX_PAYLOAD_DEPTH`,
   * and `appendEventOnce` calls it before any write, so the throw would
   * otherwise surface raw from a keyed send. The handler turns it into a
   * refusal the caller can act on: flatten the payload, or drop the key.
   *
   * The asymmetry the next test pins is deliberate, not an oversight: WITH a
   * key the payload must be fingerprinted and this one cannot be, so it is
   * refused; WITHOUT a key there is nothing to fingerprint, so the identical
   * payload is accepted. That is a ruling, not something to smooth over.
   */
  it("refuses a too-deep payload sent WITH a key, naming the depth", async () => {
    const p = await pairUp(h);
    const res = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: deepPayload(MAX_PAYLOAD_DEPTH + 1),
      idempotency_key: KEY,
    });

    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/flatten|depth/i);
    expect(res.text).toContain(String(MAX_PAYLOAD_DEPTH));
  });

  /** The other half of the asymmetry: no key means nothing to fingerprint. */
  it("accepts the same too-deep payload sent WITHOUT a key", async () => {
    const p = await pairUp(h);
    const res = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: deepPayload(MAX_PAYLOAD_DEPTH + 1),
    });

    expect(res.isError).toBe(false);
  });

  /**
   * REVIEW FOCUS 5: the guards run before the append, so a retry into an empty
   * room is refused rather than replayed. Correct — a room with nobody in it
   * cannot take a send — and pinned here so it stays a decision.
   */
  it("refuses a retry once every peer has left", async () => {
    const p = await pairUp(h);
    const first = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "before they left" }, idempotency_key: KEY,
    });
    expect(first.isError).toBe(false);

    await p.creator.call("bellman_leave", {
      session_id: p.sessionId, member_id: p.creatorMemberId,
    });

    const retry = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "before they left" }, idempotency_key: KEY,
    });

    expect(retry.isError).toBe(true);
    expect(retry.text).toContain("no other active members");
  });

  /** Two members may use the same key without colliding. */
  it("keeps one member's key out of another's way", async () => {
    const p = await pairUp(h);

    const theirs = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "from the joiner" }, idempotency_key: KEY,
    });
    const mine = await p.creator.call("bellman_send", {
      session_id: p.sessionId, member_id: p.creatorMemberId,
      type: "message", payload: { text: "from the creator" }, idempotency_key: KEY,
    });

    // isError FIRST, and it is what makes this test able to fail. Under a
    // session-wide namespace the second send collides on the shared key with a
    // different payload and comes back a conflict — and on an error `data` is
    // {}, which makes `data.replayed` undefined and `data.cursor` undefined.
    // Without these two lines every assertion below passes against exactly the
    // namespace this test exists to rule out.
    expect(theirs.isError, theirs.text).toBe(false);
    expect(mine.isError, mine.text).toBe(false);

    expect(theirs.data.replayed).toBeUndefined();
    expect(mine.data.replayed).toBeUndefined();
    expect(typeof mine.data.cursor).toBe("number");
    expect(typeof theirs.data.cursor).toBe("number");
    expect(mine.data.cursor).not.toBe(theirs.data.cursor);
  });

  /** D10: only idempotent when a key is supplied, which the hint cannot say. */
  it("does not advertise itself as idempotent", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const tools = await jesse.listTools();
    const send = tools.tools.find((t) => t.name === "bellman_send")!;

    expect(send.annotations?.idempotentHint).toBe(false);
  });
});
