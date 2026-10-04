/**
 * A member's poll when a creator removes them (#113), on the Durable Object path.
 *
 * tests/tools/evict.test.ts pins the cut through the tool handlers over MemoryStore. What it
 * cannot show is the real object: whether a long poll already waiting when the removal lands
 * is resolved the way the design says, and whether the read after it is capped, with the
 * room's events coming from SessionDO's storage and its members from the stored roster. This
 * file drives the same tools, `bellman_sync` as the member and `bellman_evict` as the
 * creator, through the in-process MCP harness over DurableObjectStore.
 *
 * The in-flight poll is the case the design leaves to construction and nothing pinned.
 * `#wake` resolves a waiter with the single event that woke it. Here that event is the
 * `member_evicted` itself, and spec R4 says the member removed should receive it. There is
 * no read after the wake in the handler to carry the poll past the cut, and this is the
 * check that says so on the object that serves production.
 *
 * NO TEARDOWN IS USED HERE, which is what makes this practical in this pool. The header of
 * ws-delivery.test.ts records that a waiter is an in-flight request and holds
 * evictAllDurableObjects() until it resolves (measured there: a 4 s poll held it for 3.7 s).
 * That is a fact about tearing an object down with a poll registered. This case never does:
 * the poll is resolved by the removal, as the room would resolve it, and only then does the
 * file's afterEach abort the objects, as the other files do.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { env, reset, abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { DurableObjectStore } from "../src/store-do.js";
import type { Identity } from "../src/types.js";
import { Harness, envelopes } from "../tests/helpers/harness.js";
import { member, session } from "../tests/helpers/fixtures.js";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await reset();
  await abortAllDurableObjects();
});

/** The member who gets removed, and the room's creator who removes them. */
const jesse: Identity = {
  userId: "u_jesse", orgId: "org_codenerd", plan: "team", role: "admin", label: "jesse@codenerd",
};
const boss: Identity = {
  userId: "u_boss", orgId: "org_codenerd", plan: "team", role: "member", label: "boss@elsewhere",
};

/** A room in the real SessionDO: the creator and one other member, `m_target`, owned by `jesse`. */
async function room() {
  const store = new DurableObjectStore(env as never);
  const s = session({
    id: "qs_removed_sync", createdBy: "u_boss", joinCodes: {}, maxMembers: 4,
    members: [
      member({ memberId: "m_boss", userId: "u_boss", label: "boss@elsewhere", roomRole: "peer_a" }),
      member({ memberId: "m_target", userId: "u_jesse", label: "jesse@codenerd", roomRole: "peer_b" }),
    ],
  });
  await store.createSession(s);
  harness = new Harness(store);
  return {
    id: s.id,
    store,
    stub: env.SESSION.get(env.SESSION.idFromName(s.id)),
    asMember: await harness.connectAs(jesse),
    asCreator: await harness.connectAs(boss),
  };
}

describe("a removed member's bellman_sync on the real object", () => {
  it("resolves a poll already in flight with the removal and nothing past it", async () => {
    const { id, store, stub, asMember, asCreator } = await room();

    // The poll a watching member has open: from the start of the room, held for 20 s.
    const polling = asMember.call("bellman_sync", {
      session_id: id, member_id: "m_target", since_cursor: 0, wait_seconds: 20,
    });
    // Registered, and not merely sent: the waiter list is the object's own, so it is read
    // there. A fixed sleep would let the removal beat the poll to the object and answer it
    // from the stored events instead, which proves nothing about a poll in flight.
    await vi.waitFor(async () => {
      const waiting = await runInDurableObject(stub, (instance) =>
        (instance as unknown as { waiters: unknown[] }).waiters.length);
      expect(waiting).toBe(1);
    }, { timeout: 3000 });

    const removal = await asCreator.call("bellman_evict", { session_id: id, member_id: "m_target" });
    expect(removal.isError, removal.text).toBe(false);
    // Something past the cut, appended once the removal has returned. By then the poll has
    // been answered, so this only shows that the record holds an event past the cut; the
    // next case is the one that can tell how the poll was answered.
    await store.appendEvent(id, {
      type: "message", fromMemberId: "m_boss", fromUserId: "u_boss",
      fromLabel: "boss@elsewhere", payload: { text: "past the cut" }, refId: null,
    });

    const answer = await polling;

    expect(answer.isError, answer.text).toBe(false);
    const events = envelopes(answer.data.events).map((e) => e.data as { cursor: number; type: string });
    expect(events.map((e) => e.type)).toEqual(["member_evicted"]);
    // Inside the cut: the cursor the roster recorded is the cursor of the event delivered.
    const cut = (await store.getSession(id))!.members.find((m) => m.memberId === "m_target")!.removedAtCursor;
    expect(cut).toBeDefined();
    expect(events[0].cursor).toBe(cut);
    expect(answer.data.cursor).toBe(cut);
    // And the record does hold an event past it, so "nothing past the cut" is a fact about
    // what was returned and not about what existed.
    expect((await store.eventsAfter(id, cut!)).map((e) => e.type)).toEqual(["message"]);
  });

  it("does not carry a poll in flight past the cut when an event lands in the same turn", async () => {
    /**
     * The case above appends its later event after the removal has returned, by which time
     * the poll has been answered, so it cannot tell a poll answered by the event that woke it
     * from one that reads the room again after waking. This one can. The removal and a message
     * are appended in ONE turn of the object, and while that turn holds the object nothing
     * else is delivered to it, so a read the poll's caller makes after being woken can only
     * run once both are stored. A handler that re-read would return the message too. Today
     * none does: the poll is answered with the event that woke it, which is the removal.
     *
     * It matters because the cap is applied only to a member who is already cut when the call
     * starts. A poll begun before the removal has no cap, and what keeps it inside the cut is
     * that it never reads again.
     */
    const { id, store, stub, asMember } = await room();
    const polling = asMember.call("bellman_sync", {
      session_id: id, member_id: "m_target", since_cursor: 0, wait_seconds: 20,
    });
    await vi.waitFor(async () => {
      const waiting = await runInDurableObject(stub, (instance) =>
        (instance as unknown as { waiters: unknown[] }).waiters.length);
      expect(waiting).toBe(1);
    }, { timeout: 3000 });

    type Append = (e: object, extras: object) => Promise<unknown>;
    await runInDurableObject(stub, async (instance) => {
      const { appendEvent } = instance as unknown as { appendEvent: Append };
      const append = appendEvent.bind(instance);
      await append({
        type: "member_evicted", fromMemberId: "system", fromUserId: "u_boss", fromLabel: "boss@elsewhere",
        payload: { member_id: "m_target", label: "jesse@codenerd", room_role: "peer_b" }, refId: null,
      }, { markRemoved: "m_target" });
      await append({
        type: "message", fromMemberId: "m_boss", fromUserId: "u_boss",
        fromLabel: "boss@elsewhere", payload: { text: "past the cut" }, refId: null,
      }, {});
    });

    const answer = await polling;

    expect(answer.isError, answer.text).toBe(false);
    const types = envelopes(answer.data.events).map((e) => (e.data as { type: string }).type);
    expect(types).toEqual(["member_evicted"]);
    // Both are stored, so the message is past the cut and was there to be returned.
    expect((await store.eventsAfter(id, 0)).map((e) => e.type)).toEqual(["member_evicted", "message"]);
  });

  it("answers the next poll at once, and shows nothing past the cut", async () => {
    const { id, store, asMember, asCreator } = await room();
    const removal = await asCreator.call("bellman_evict", { session_id: id, member_id: "m_target" });
    expect(removal.isError, removal.text).toBe(false);
    const cut = (await store.getSession(id))!.members.find((m) => m.memberId === "m_target")!.removedAtCursor!;

    // From the cut, asking to be held. Nothing exists past it yet, which is the only state in
    // which waiting can be seen: with an event ahead of it a poll answers at once whatever the
    // handler does. A handler that honoured the wait would hold this for the full 4 s.
    expect(await store.eventsAfter(id, cut)).toEqual([]);
    const startedAt = Date.now();
    const quiet = await asMember.call("bellman_sync", {
      session_id: id, member_id: "m_target", since_cursor: cut, wait_seconds: 4,
    });
    expect(quiet.isError, quiet.text).toBe(false);
    expect(envelopes(quiet.data.events)).toEqual([]);
    expect(quiet.data.cursor).toBe(cut);
    expect(Date.now() - startedAt, "returned without waiting").toBeLessThan(2000);

    // Now something past the cut, and the same poll again. It is there to be returned, and
    // a handler that forgot to cap would return it.
    await store.appendEvent(id, {
      type: "message", fromMemberId: "m_boss", fromUserId: "u_boss",
      fromLabel: "boss@elsewhere", payload: { text: "past the cut" }, refId: null,
    });
    expect((await store.eventsAfter(id, cut)).map((e) => e.type)).toEqual(["message"]);
    const capped = await asMember.call("bellman_sync", {
      session_id: id, member_id: "m_target", since_cursor: cut, wait_seconds: 4,
    });
    expect(capped.isError, capped.text).toBe(false);
    expect(envelopes(capped.data.events)).toEqual([]);
    expect(capped.data.cursor).toBe(cut);

    // And the history is still theirs: from the start they read through the removal.
    const history = await asMember.call("bellman_sync", {
      session_id: id, member_id: "m_target", since_cursor: 0, wait_seconds: 0,
    });
    expect(envelopes(history.data.events).map((e) => (e.data as { type: string }).type)).toEqual(["member_evicted"]);
  });
});
