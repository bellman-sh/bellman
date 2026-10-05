/**
 * `bellman_sync`'s `session_status` is the room as it is when the poll answers (#74).
 *
 * The handler reads the session to find the member, then holds a long poll for up to
 * `wait_seconds`. A status taken from that first read is as old as the wait, and a long
 * poll is the normal case for a connected agent, so a room that closed or froze while the
 * poll sat there kept reporting `active`. For a freeze, the first the agent learned of it
 * was a refused `bellman_send` with no prior signal. For an expiry, the poll came back
 * holding the `session_expired` event beside a status that called the room open.
 *
 * The room has to change while the poll is parked, and a test can only arrange that by
 * knowing when that is. ParkingStore says so, where a sleep to find the moment would be a
 * guess.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryStore } from "../../src/store.js";
import { Harness, envelopes } from "../helpers/harness.js";
import { pairUp, type PairedSession } from "../helpers/flows.js";

/**
 * A MemoryStore that reports when a long poll has parked, and counts reads of the
 * session. `waitForEvents` stays un-async, for the reason the base class gives: the read
 * and the waiter's registration must have no await between them.
 */
class ParkingStore extends MemoryStore {
  reads = 0;
  onPark: (() => void) | null = null;

  override async getSession(id: string) {
    this.reads++;
    return super.getSession(id);
  }

  override waitForEvents(sessionId: string, cursor: number, waitMs: number) {
    const poll = super.waitForEvents(sessionId, cursor, waitMs);
    this.onPark?.();
    return poll;
  }
}

let store: ParkingStore;
let h: Harness;
let p: PairedSession;

beforeEach(async () => {
  store = new ParkingStore();
  h = new Harness(store);
  p = await pairUp(h);
});
afterEach(async () => { await h.close(); });

/**
 * The joiner's poll from where it left off, so nothing is pending and a wait really waits.
 * A refused call is a failure here and not an empty answer: `wait_seconds` past the tool's
 * cap of 25 is refused by the schema, and reads like a quiet room.
 */
const poll = async (waitSeconds: number) => {
  const out = await p.joiner.call("bellman_sync", {
    session_id: p.sessionId, member_id: p.joinerMemberId,
    since_cursor: p.joinerCursor, wait_seconds: waitSeconds,
  });
  expect(out.isError, out.text).toBe(false);
  return out;
};

/** Long enough that only an event can end it inside a test, and inside the tool's cap. */
const LONG = 20;

const types = (events: unknown) =>
  envelopes(events).map((e) => (e.data as { type: string }).type);

/**
 * Wake a parked poll with a message from the creator, written to the store directly. Sent
 * through `bellman_send` it would work as well, and would put that handler's own read of
 * the session into the counts below, which are about the sync's.
 */
const wakeWithMessage = () => {
  void store.appendEvent(p.sessionId, {
    type: "message", fromMemberId: p.creatorMemberId, fromUserId: "u_jesse",
    fromLabel: "jesse@codenerd", payload: { text: "wake" }, refId: null,
  });
};

describe("session_status after a long poll", () => {
  /**
   * The room lapses while the poll waits, and the lapse is what wakes it: the answer
   * carries the event that announces the closing, so a status that says `active` beside
   * it contradicts itself inside one response.
   */
  it("reports a room that expired while the poll waited as closed, beside the event that says so", async () => {
    const expiresAt = (await store.getSession(p.sessionId))!.expiresAt;
    store.onPark = () => { void store.sweep(expiresAt + 1); };

    const out = await poll(LONG);

    expect(types(out.data.events), "control: the lapse is what woke the poll").toContain("session_expired");
    expect(out.data.session_status).toBe("closed");
  });

  /**
   * A freeze appends nothing, so it wakes nobody: the poll sits to the end of its wait
   * and answers from whatever it knew when it started. This is the case the issue names.
   */
  it("reports a room that was frozen while the poll waited as frozen", async () => {
    store.onPark = () => { void store.freezeSession(p.sessionId, Date.now()); };

    const out = await poll(1);

    expect((await store.getSession(p.sessionId))!.frozenAt, "control: the room did freeze").not.toBeNull();
    expect(out.data.events, "control: nothing woke the poll early").toEqual([]);
    expect(out.data.session_status).toBe("frozen");
  });

  /** Nothing happened to the room, so the second read must not invent something. */
  it("still reports active when nothing happened to the room", async () => {
    store.onPark = wakeWithMessage;

    const out = await poll(LONG);

    expect(types(out.data.events), "control: the poll was woken by the message").toEqual(["message"]);
    expect(out.data.session_status).toBe("active");
  });
});

/**
 * Where the second read belongs. The staleness comes from the wait, so a poll that did
 * not wait has none to repair, and the extra read is not paid there: one round trip per
 * sync on a hot path, for a window of milliseconds. A removed member's poll is the
 * other arm of the handler. It reads its history and returns, and `wait_seconds` does
 * not hold it, so it reads once.
 *
 * Counted against a baseline rather than as absolute numbers, so a later read the handler
 * needs for another reason moves all three together and none of them alone.
 */
describe("what a sync reads", () => {
  const readsDuring = async (answer: () => Promise<unknown>) => {
    store.reads = 0;
    await answer();
    return store.reads;
  };

  it("reads the session once more only when it waited", async () => {
    const withoutWaiting = await readsDuring(() => poll(0));

    store.onPark = wakeWithMessage;
    const afterWaiting = await readsDuring(() => poll(LONG));

    expect(afterWaiting).toBe(withoutWaiting + 1);
  });

  it("does not read it again for a member the creator removed, whose poll does not wait", async () => {
    const withoutWaiting = await readsDuring(() => poll(0));
    const evicted = await p.creator.call("bellman_evict", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
    });
    expect(evicted.isError, evicted.text).toBe(false);

    const removed = await readsDuring(async () => {
      const out = await p.joiner.call("bellman_sync", {
        session_id: p.sessionId, member_id: p.joinerMemberId, since_cursor: 0, wait_seconds: LONG,
      });
      expect(out.isError, out.text).toBe(false);
      expect(out.data.removed, "control: this is the removed member's arm").toBe(true);
    });

    expect(removed).toBe(withoutWaiting);
  });
});
