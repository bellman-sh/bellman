/**
 * D7 of the durable room record (#65, review M7 ii): a purged room is a room that never was, to a tool as to the
 * store. tests/store.test.ts and the store contract assert it at the store (`eventsAfter` empty, `appendEvent`
 * throws); this drives `bellman_sync` and `bellman_rooms` through MCP over the same store, which is where an
 * agent meets it. The purge is reached the way the DELETE route reaches it: a delete is asked for, and `sweep`
 * carries it out.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryStore } from "../../src/store.js";
import { Harness } from "../helpers/harness.js";
import { pairUp } from "../helpers/flows.js";

let store: MemoryStore;
let h: Harness;
beforeEach(() => { store = new MemoryStore(); h = new Harness(store); });
afterEach(async () => { await h.close(); });

describe("a purged room, through the tools", () => {
  it("answers bellman_sync as it answers a room that never was, and bellman_rooms leaves it out", async () => {
    const p = await pairUp(h);
    const poll = (sessionId: string) =>
      p.creator.call("bellman_sync", { session_id: sessionId, member_id: p.creatorMemberId });
    expect((await poll(p.sessionId)).isError, "the room answers while it is there").toBe(false);
    expect((await p.creator.call("bellman_rooms")).data.rooms, "and is listed").toHaveLength(1);

    await store.closeSession(p.sessionId);
    expect(await store.schedulePurge(p.sessionId, Date.now(), "u_jesse")).toMatchObject({ ok: true });
    await store.sweep(Date.now());

    const gone = await poll(p.sessionId);
    const never = await poll("qs_never_was");
    expect(gone.isError, "the purged room is gone: bellman_sync no longer answers for it").toBe(true);
    // The same words, the room's id aside: nothing in the answer says there was a room here.
    expect(gone.text.split(p.sessionId).join("<room>")).toBe(never.text.split("qs_never_was").join("<room>"));

    for (const peer of [p.creator, p.joiner]) {
      const rooms = await peer.call("bellman_rooms");
      expect(rooms.isError, rooms.text).toBe(false);
      expect(rooms.data.rooms).toEqual([]);
    }
  });
});
