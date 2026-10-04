/**
 * An open socket holds its member's seat — in real workerd, across a real
 * eviction, against the real /ws route (worker-tests/wrangler.toml sets
 * main = "../src/worker.ts").
 *
 * #140 and #146. Presence is otherwise inferred from `lastSeenAt`, which is
 * written as a side effect of traffic a socket-fed client no longer sends: a
 * member watching over the room's hibernating WebSocket never calls
 * `bellman_sync`, so it is the quietest member in the room by construction and
 * the first one a contested `bellman_confirm` reaps. `SessionDO.seatMember`
 * reads `ctx.getWebSockets()` instead, and this is where that is proven rather
 * than asserted against a fake.
 *
 * THE EVICTION IS THE POINT, and it is why this cannot be a unit test or live
 * in the store contract. `SocketAttachment` is what carries `memberIds`, and
 * the only reason the seat rule may trust it after the instance has gone is
 * that the runtime hands the attachment back on the revived object. The
 * contract suite pins the seam's shape against both stores; nothing but workerd
 * can pin this.
 *
 * evictAllDurableObjects(), not abortAllDurableObjects(): abort is a crash that
 * closes every accepted socket, evict is the graceful teardown that leaves the
 * socket open while the instance goes, which is what idle eviction does to a
 * real object. ws-delivery.test.ts measured both and carries the detail.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  env, SELF, reset, abortAllDurableObjects, evictAllDurableObjects, runInDurableObject,
} from "cloudflare:test";
import { DurableObjectStore } from "../src/store-do.js";
import { member, session } from "../tests/helpers/fixtures.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

/** The key vitest.config.ts binds. Its identity is the creator fixtures.ts seats. */
const KEY = "qk_ws_test";

/**
 * A one-seat room whose only member went quiet long ago, so the next joiner
 * contests its seat. `m_creator` is the member the /ws route will authorize,
 * so it is the one an upgrade puts in the attachment.
 */
async function quietOneSeatRoom() {
  const store = new DurableObjectStore(env as never);
  const s = session({
    maxMembers: 1,
    members: [member({ memberId: "m_creator", lastSeenAt: 1 })],
  });
  await store.createSession(s);
  return { id: s.id, store, stub: env.SESSION.get(env.SESSION.idFromName(s.id)) };
}

/** The upgrade, through the real route: auth, membersOf, then the object. */
async function upgrade(id: string): Promise<Response> {
  const res = await SELF.fetch(`https://bellman.test/ws?session=${id}&cursor=0`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${KEY}` },
  });
  expect(res.status).toBe(101);
  // Accept the client end, or the socket is never established.
  res.webSocket!.accept();
  return res;
}

/** A joiner contesting the room's only seat, as `bellman_confirm` would. */
const contest = (store: DurableObjectStore, id: string) =>
  store.seatMember(
    id,
    member({ memberId: "m_late", userId: "u_late", lastSeenAt: Date.now() }),
    Date.now() - 10 * 60 * 1000,
    Date.now(),
  );

describe("an open socket holds the seat across eviction", () => {
  it("refuses the contested seat of a member whose socket survived the eviction", async () => {
    const { id, store, stub } = await quietOneSeatRoom();
    await upgrade(id);

    // Mark the instance that accepted the socket. Evict skips an object that is
    // not running, so without this a no-op eviction would pass the case.
    await runInDurableObject(stub, (i) => { (i as unknown as { warm: boolean }).warm = true; });
    await evictAllDurableObjects();

    // Revives the object. The seat rule has to find the socket on the REBUILT
    // instance, through ctx.getWebSockets(), not through instance state.
    const outcome = await contest(store, id);

    expect(outcome).toEqual({ refused: "full", reclaimed: [] });
    // The member is still there, still active, and still quiet: nothing was
    // written to make it look alive. Presence stays derived.
    const fresh = (await store.getSession(id))!;
    expect(fresh.members.map((m) => m.memberId)).toEqual(["m_creator"]);
    expect(fresh.members[0].leftAt).toBeNull();
    expect(fresh.members[0].lastSeenAt).toBe(1);

    // The instance that refused is not the one that was marked.
    const stillWarm = await runInDurableObject(
      stub, (i) => (i as unknown as { warm?: boolean }).warm);
    expect(stillWarm).toBeUndefined();
  });

  it("reaps the same quiet member when no socket is open", async () => {
    // The positive control. Without it the case above would pass for a room
    // that simply refuses every joiner, and would say nothing about the socket.
    const { id, store } = await quietOneSeatRoom();

    const outcome = await contest(store, id);

    expect(outcome.refused).toBeNull();
    expect(outcome.reclaimed.map((m) => m.memberId)).toEqual(["m_creator"]);
  });

  it("reports the member ids its live sockets carry, after a revival", async () => {
    // The seam itself, read straight off the object: membersOf answered these
    // ids and the Worker put them in a request it built, so this is the reader
    // SocketAttachment.memberIds was kept for.
    const { id, store, stub } = await quietOneSeatRoom();
    expect(await store.connectedMemberIds(id)).toEqual([]);

    await upgrade(id);
    await runInDurableObject(stub, (i) => { (i as unknown as { warm: boolean }).warm = true; });
    await evictAllDurableObjects();

    expect(await store.connectedMemberIds(id)).toEqual(["m_creator"]);
  });

  it("reports nothing for a room that has never existed", async () => {
    const store = new DurableObjectStore(env as never);
    expect(await store.connectedMemberIds("qs_never")).toEqual([]);
  });
});
