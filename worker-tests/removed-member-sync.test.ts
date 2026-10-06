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
     * It matters because the record's cap is applied only to a member who is already cut when
     * the call starts. A poll begun before the removal has no cap from the record, and what
     * keeps a poll that waits inside the cut is that it never reads again. A poll that does
     * not wait has no such protection, and the case after this one is about it.
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

  it("caps a poll whose member record was read before the removal committed", async () => {
    /**
     * The two cases above are polls that wait. This one does not, and it is the half of the
     * boundary they cannot reach. The handler reads the member's record first and the room's
     * events after, with `touchMember` and the call that reads the events between them, and
     * on this path each of those is an RPC. A removal that commits in that gap leaves the
     * handler holding a record that shows the member still in, so the cap that record would
     * have applied is not applied. By the time the events are read the removal is stored:
     * `waitForEvents` finds events past the cursor, returns them at once and registers no
     * waiter. What the cases above lean on, that a woken poll never reads again, has nothing
     * to say about a poll that never slept.
     *
     * The race is a fixed order here, as it is for the socket in ws-delivery.test.ts: the
     * record is read before the removal and handed to the poll after it, which is what the
     * handler holds when the removal commits a moment after its read. The rest is the real
     * thing: the removal is the creator's bellman_evict, the events are the object's, and
     * the poll is bellman_sync as the member makes it.
     *
     * The event past the cut is a message because that is peer content, which is what the
     * cut exists to keep from the member. A seat with a live code would put something past
     * the cut with no sender at all: `evictMember` follows `member_evicted` with an
     * `invite_revoked`, so a poll in this window gets the door notice at the least.
     */
    const { id, store, asMember, asCreator } = await room();

    // The record as the poll would have read it an instant before the removal.
    const before = await store.getSession(id);
    expect(before!.members.find((m) => m.memberId === "m_target")!.removedAtCursor,
      "arrangement: the record the poll will hold shows no cut").toBeUndefined();

    const removal = await asCreator.call("bellman_evict", { session_id: id, member_id: "m_target" });
    expect(removal.isError, removal.text).toBe(false);
    await store.appendEvent(id, {
      type: "message", fromMemberId: "m_boss", fromUserId: "u_boss",
      fromLabel: "boss@elsewhere", payload: { text: "PAST THE CUT" }, refId: null,
    });

    // Both are committed before the poll starts, so its read finds events past its cursor
    // and returns them at once. No waiter is registered, which is the path this is for.
    const cut = (await store.getSession(id))!.members.find((m) => m.memberId === "m_target")!.removedAtCursor;
    expect(cut, "arrangement: the removal is committed").toBeDefined();
    expect((await store.eventsAfter(id, 0)).map((e) => e.type)).toEqual(["member_evicted", "message"]);

    // Handed to every read the poll makes of the record, and to nothing else: the removal and
    // the message above have already read theirs. Every read and not only the first, because a
    // poll that asked to wait reads again once it returns (#74), for the status, and that read
    // is of a record that shows the cut. Left fresh, a handler could take its cap from it and
    // this case would pass with the slice doing none of the work.
    const read = vi.spyOn(store, "getSession").mockResolvedValue(before);
    const answer = await asMember.call("bellman_sync", {
      session_id: id, member_id: "m_target", since_cursor: 0, wait_seconds: 20,
    });
    // The control this case stands on. If the handler stopped reading its record through the
    // object replaced above, it would be answering from a fresh one, the cut arm would
    // apply, and everything below would pass for nothing.
    expect(read, "the poll read its record through the interposed store").toHaveBeenCalled();

    expect(answer.isError, answer.text).toBe(false);
    const events = envelopes(answer.data.events).map((e) => e.data as { cursor: number; type: string });
    expect(events.map((e) => e.type)).toEqual(["member_evicted"]);
    expect(events[0].cursor).toBe(cut);
    // The cut, so the next poll, which reads a fresh record, starts from it.
    expect(answer.data.cursor).toBe(cut);
  });

  it("does not tell a leaver they were removed, even on a stale record", async () => {
    /**
     * The two hazards above, composed — and the one place the cap and the FLAG have
     * to part company.
     *
     * The cap may be read off the `member_evicted` in the slice, because a wrong cap
     * costs one poll and the next poll, reading a fresh record, reopens the feed.
     * The flag cannot: a client reads it as "stop asking" and marks the handle
     * departed for the life of the process (`markDeparted` in src/bridge.ts), so a
     * flag emitted wrongly ends a voluntary leaver's feed for good. Nothing
     * self-heals.
     *
     * This is the state where the two disagree: the record the poll holds was read
     * before the leave, so it shows the member active and the `isActiveMember` guard
     * passes; the leave then commits; the eviction appends and `markRemoved` declines
     * it (spec D3), so no cut is ever recorded. The slice therefore holds a
     * `member_evicted` naming a member R2 gives the open feed. The cap fires, which
     * is accepted and documented. The flag must not.
     */
    const { id, store, asMember } = await room();

    // The record as the poll would have read it an instant before the leave.
    const before = await store.getSession(id);
    expect(before!.members.find((m) => m.memberId === "m_target")!.leftAt,
      "arrangement: the record the poll will hold shows them still in").toBeNull();

    const left = await asMember.call("bellman_leave", { session_id: id, member_id: "m_target" });
    expect(left.isError, left.text).toBe(false);
    await store.appendEvent(id, {
      type: "member_evicted", fromMemberId: "system", fromUserId: "u_boss", fromLabel: "boss@elsewhere",
      payload: { member_id: "m_target", label: "jesse@codenerd", room_role: "peer_b" }, refId: null,
    }, { markRemoved: "m_target" });

    const record = (await store.getSession(id))!.members.find((m) => m.memberId === "m_target")!;
    expect(record.leftAt, "arrangement: they left").not.toBeNull();
    expect(record.removedAtCursor, "arrangement: the store declined the cut").toBeUndefined();

    const read = vi.spyOn(store, "getSession").mockResolvedValueOnce(before);
    const answer = await asMember.call("bellman_sync", {
      session_id: id, member_id: "m_target", since_cursor: 0, wait_seconds: 0,
    });
    expect(read, "the poll read its record through the interposed store").toHaveBeenCalledTimes(1);

    expect(answer.isError, answer.text).toBe(false);
    // The event IS in the slice, which is what makes this the hazard rather than a
    // trivially safe case: anything reading the flag off the event would emit it.
    expect(envelopes(answer.data.events).map((e) => (e.data as { type: string }).type))
      .toContain("member_evicted");
    expect(answer.data.removed, "a leaver is never told to stop asking").toBeUndefined();
  });

  it("does not cap a member who left, though a removal naming them is in the log", async () => {
    /**
     * The limit of the case above, which caps a poll on the removal it finds in the events.
     * That event alone does not prove a cut. `markRemoved` declines a member who has already
     * left, so a leave that lands between `evictMember` reading the roster and its append
     * leaves a `member_evicted` in the log naming someone with no `removedAtCursor`, and a
     * member who left of their own accord keeps the open feed (R2). Capping on the event
     * there would hand them a cut the store refused to record.
     *
     * This builds the end state of that race directly, through the append `evictMember`
     * makes: the member leaves, the removal is appended after, and the store declines to cut
     * them. The record is read fresh and shows the leave, which is what the handler holds
     * for such a member on every poll that follows.
     */
    const { id, store, asMember } = await room();
    const left = await asMember.call("bellman_leave", { session_id: id, member_id: "m_target" });
    expect(left.isError, left.text).toBe(false);

    await store.appendEvent(id, {
      type: "member_evicted", fromMemberId: "system", fromUserId: "u_boss", fromLabel: "boss@elsewhere",
      payload: { member_id: "m_target", label: "jesse@codenerd", room_role: "peer_b" }, refId: null,
    }, { markRemoved: "m_target" });
    await store.appendEvent(id, {
      type: "message", fromMemberId: "m_boss", fromUserId: "u_boss",
      fromLabel: "boss@elsewhere", payload: { text: "after the announcement" }, refId: null,
    });

    // The state this case is about, read from the record: they left, the store declined to
    // cut them, and the removal is in the log all the same.
    const record = (await store.getSession(id))!.members.find((m) => m.memberId === "m_target")!;
    expect(record.leftAt, "arrangement: they left").not.toBeNull();
    expect(record.removedAtCursor, "arrangement: the store declined the cut").toBeUndefined();
    const stored = await store.eventsAfter(id, 0);
    expect(stored.map((e) => e.type)).toEqual(["member_left", "member_evicted", "message"]);

    const answer = await asMember.call("bellman_sync", {
      session_id: id, member_id: "m_target", since_cursor: 0, wait_seconds: 0,
    });

    expect(answer.isError, answer.text).toBe(false);
    // Their own departure is dropped as theirs. The removal and the message after it are
    // both there: the feed is open, and the cursor is the end of it.
    expect(envelopes(answer.data.events).map((e) => (e.data as { type: string }).type))
      .toEqual(["member_evicted", "message"]);
    expect(answer.data.cursor).toBe(stored[stored.length - 1].cursor);
    // And they are NOT told they were removed. The flag is persistent in a way
    // the cap is not: a client reads it as "stop asking" and marks the handle
    // departed for the life of the process, so emitting it on the event alone
    // would end a voluntary leaver's feed for good — where the cap costs one
    // poll and self-heals. So the flag comes off the recorded `removedAtCursor`
    // only, which the store declined to write here.
    expect(answer.data.removed).toBeUndefined();
  });

  it("does not take a peer's message naming them for their own removal", async () => {
    /**
     * The other limit of the stale-record case, and the one a peer can reach. The handler
     * looks for the member's own `member_evicted` in what it read, and a message's payload is
     * whatever its sender wrote: every member's id is on the roster `bellman_confirm` returns,
     * so a peer can put this member's id in a message. Matched on the payload alone, that
     * message would stand in for a removal and cap the poll at itself, and a peer could hold
     * back what the room says to a member nobody removed. The kind is checked first because
     * only the server writes a `member_evicted`, and a peer cannot send one.
     */
    const { id, store, asMember } = await room();
    await store.appendEvent(id, {
      type: "message", fromMemberId: "m_boss", fromUserId: "u_boss", fromLabel: "boss@elsewhere",
      payload: { member_id: "m_target", text: "names them" }, refId: null,
    });
    await store.appendEvent(id, {
      type: "message", fromMemberId: "m_boss", fromUserId: "u_boss", fromLabel: "boss@elsewhere",
      payload: { text: "and then this" }, refId: null,
    });

    const answer = await asMember.call("bellman_sync", {
      session_id: id, member_id: "m_target", since_cursor: 0, wait_seconds: 0,
    });

    expect(answer.isError, answer.text).toBe(false);
    const texts = envelopes(answer.data.events)
      .map((e) => (e.data as { payload: { text?: string } }).payload.text);
    expect(texts).toEqual(["names them", "and then this"]);
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
