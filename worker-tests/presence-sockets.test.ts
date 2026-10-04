/**
 * #146 in real workerd: a member whose socket is open keeps its seat.
 *
 * SessionDO reads the sockets it has accepted, through ctx.getWebSockets() and
 * each one's attachment, inside seatMember's transaction. tests/presence-sockets
 * .test.ts pins the rule without a runtime. What only this runtime can show is
 * that the attachment the /ws route really builds (membersOf, then the Worker's
 * own request) is what the reader sees, that a socket that closes stops
 * vouching, and that the answer survives the object being evicted and revived,
 * which is when it is hibernating and holding nothing in memory.
 *
 * Every room here is two or three seats with one present member and one or two
 * that have been quiet since 1 ms after the epoch. The identity behind the key
 * vitest.config.ts binds is u_jesse, which is the user a fixture member has by
 * default, so a default member is one this socket's identity owns.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  env, SELF, reset, abortAllDurableObjects, evictAllDurableObjects, runInDurableObject,
} from "cloudflare:test";
import { DurableObjectStore } from "../src/store-do.js";
import { STALE_AFTER_MS, presenceOf } from "../src/presence.js";
import type { Member } from "../src/types.js";
import { member, session } from "../tests/helpers/fixtures.js";

// See abortAllDurableObjects() in store-contract.test.ts for why both calls.
afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

const KEY = "qk_ws_test";

let rooms = 0;

/** A room in the real SessionDO holding these members. */
async function room(members: Member[], maxMembers: number) {
  const store = new DurableObjectStore(env as never);
  const s = session({ id: `qs_presence_${++rooms}`, members, maxMembers });
  await store.createSession(s);
  return { id: s.id, store, stub: env.SESSION.get(env.SESSION.idFromName(s.id)) };
}

/** Heard from just now, and not the socket's identity. */
const here = (memberId: string) =>
  member({ memberId, userId: "u_other", lastSeenAt: Date.now() });

/** Quiet for as long as a member can be, and the socket's identity. */
const quiet = (memberId: string) => member({ memberId, userId: "u_jesse", lastSeenAt: 1 });

/** The upgrade through the real route: auth, membersOf, then the object. */
async function open(id: string): Promise<WebSocket> {
  const res = await SELF.fetch(`https://bellman.test/ws?session=${id}&cursor=0`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${KEY}` },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  return ws;
}

/** What the object's accepted sockets carry, read from the object itself. */
const attachments = (stub: DurableObjectStub) =>
  runInDurableObject(stub, (_instance, state) =>
    state.getWebSockets().map((ws) => ws.deserializeAttachment()));

/**
 * A joiner who needs a seat, with the cutoff `bellman_confirm` passes.
 *
 * `staleBefore` is overridable so a case can stand past the window a close
 * stamps (#152) without waiting ten minutes: the store holds no presence policy
 * and takes the cutoff, which is what makes that possible.
 */
const seat = (store: DurableObjectStore, id: string, staleBefore = Date.now() - STALE_AFTER_MS) =>
  store.seatMember(
    id, member({ memberId: "m_late", userId: "u_late", roomRole: "peer_b" }),
    staleBefore, Date.now(),
  );

const roster = async (store: DurableObjectStore, id: string) =>
  (await store.getSession(id))!.members.map((m) => [m.memberId, m.leftAt]);

describe("an open socket is liveness", () => {
  it("keeps a quiet member present, and its seat out of a contested confirm's reach", async () => {
    const { id, store, stub } = await room([here("m_here"), quiet("m_quiet")], 2);
    await open(id);

    const connected = await store.connectedMembers(id);
    expect([...connected]).toEqual(["m_quiet"]);
    const m = (await store.getSession(id))!.members.find((x) => x.memberId === "m_quiet")!;
    // lastSeenAt alone says stale. The socket is the whole difference.
    expect(presenceOf(m)).toBe("stale");
    expect(presenceOf(m, Date.now(), connected)).toBe("present");

    expect(await seat(store, id)).toEqual({ refused: "full", reclaimed: [] });

    // Hibernation. Mark the instance that accepted the socket, because evicting
    // an object that is not running does nothing and a no-op would pass below.
    await runInDurableObject(stub, (instance) => { (instance as unknown as { warm: boolean }).warm = true; });
    await evictAllDurableObjects();

    // The rebuilt instance holds nothing from before: it has to find the socket
    // through ctx.getWebSockets(), as wake() does.
    expect(await seat(store, id)).toEqual({ refused: "full", reclaimed: [] });
    const warm = await runInDurableObject(stub, (instance) => (instance as unknown as { warm?: boolean }).warm);
    expect(warm).toBeUndefined();

    // Nobody was removed and nobody was told they were.
    expect(await roster(store, id)).toEqual([["m_here", null], ["m_quiet", null]]);
    expect(await store.eventsAfter(id, 0)).toEqual([]);
  });

  /**
   * #152. A socket that drops stops vouching instantly, and the member behind it
   * never called bellman_sync — so without a stamp it falls back to a
   * `lastSeenAt` that has not moved since it joined, reads stale the moment the
   * socket goes, and the next contested confirm takes its seat. The window the
   * polling member gets is already spent.
   *
   * `webSocketClose` is where the stamp belongs: it already runs, it already
   * wakes the object to answer the close, and a DROP arrives there too as 1006
   * with wasClean false (see the handler). So this records a fact — the member
   * was there a moment ago — rather than predicting one.
   */
  it("stamps the members of a socket that closes, so a drop does not cost the seat", async () => {
    const { id, store } = await room([here("m_here"), quiet("m_quiet")], 2);
    const ws = await open(id);
    const before = (await store.getSession(id))!.members
      .find((m) => m.memberId === "m_quiet")!.lastSeenAt;
    expect(before).toBe(1); // quiet since 1 ms after the epoch, and nothing has moved it

    ws.close(1000, "done");
    await vi.waitFor(async () => {
      expect(await store.connectedMembers(id)).toEqual(new Set());
    }, { timeout: 3000 });

    // The socket has stopped vouching, and the close wrote down that it was there.
    const m = (await store.getSession(id))!.members.find((x) => x.memberId === "m_quiet")!;
    expect(m.lastSeenAt).toBeGreaterThan(Date.now() - STALE_AFTER_MS);
    expect(presenceOf(m)).toBe("present");

    // So a confirm contesting the seat in the gap after the drop is refused,
    // where before the stamp it reclaimed it.
    expect(await seat(store, id)).toEqual({ refused: "full", reclaimed: [] });
  });

  it("still reaps a quiet member with no socket, and stops protecting one whose socket closes", async () => {
    const bare = await room([here("m_here"), quiet("m_quiet")], 2);
    expect(await bare.store.connectedMembers(bare.id)).toEqual(new Set());
    const reaped = await seat(bare.store, bare.id);
    expect(reaped.refused).toBeNull();
    expect(reaped.reclaimed.map((m) => m.memberId)).toEqual(["m_quiet"]);

    // The same member, vouched for while its socket is open and not after: the
    // object reads the sockets when it decides, and keeps no list of its own.
    const closing = await room([here("m_here"), quiet("m_quiet")], 2);
    const ws = await open(closing.id);
    expect(await seat(closing.store, closing.id)).toEqual({ refused: "full", reclaimed: [] });
    ws.close(1000, "done");
    await vi.waitFor(async () => {
      expect(await closing.store.connectedMembers(closing.id)).toEqual(new Set());
    }, { timeout: 3000 });

    // The socket has stopped vouching. The seat is not free the instant it does,
    // because the close stamped `lastSeenAt` (#152) — this case asserted the
    // reclaim here until that landed, which was the bug: a member that merely
    // dropped lost its seat with no window at all, where a polling member gets
    // ten minutes.
    expect(await seat(closing.store, closing.id)).toEqual({ refused: "full", reclaimed: [] });

    // And the stamp is a WINDOW, not permanent protection: stand past it and a
    // seat is reclaimable again, which is what separates "was here a moment ago"
    // from "is here now" — only an open socket says the second.
    //
    // The victim is `m_here`, and that IS the point rather than an accident of
    // the fixture. Longest-quiet goes first, and the stamp moved the dropped
    // member out of being the quietest member in the room by construction —
    // which is exactly what made it the first one reaped (#146, #152).
    const past = await seat(closing.store, closing.id, Date.now() + 1);
    expect(past.refused).toBeNull();
    expect(past.reclaimed.map((m) => m.memberId)).toEqual(["m_here"]);
  });

  it("keeps both members of a socket that serves two", async () => {
    // Two seats held by the socket's identity and one by somebody else, in a
    // three-seat room. The contested confirm needs one seat: if the socket
    // protected only one of the two, it would take the other.
    const { id, store, stub } = await room([here("m_here"), quiet("m_a"), quiet("m_b")], 3);
    await open(id);

    // What the route built: every member the identity owned when it connected.
    expect(await attachments(stub)).toEqual([expect.objectContaining({ memberIds: ["m_a", "m_b"] })]);
    expect([...await store.connectedMembers(id)].sort()).toEqual(["m_a", "m_b"]);
    expect(await seat(store, id)).toEqual({ refused: "full", reclaimed: [] });
    expect(await roster(store, id)).toEqual([["m_here", null], ["m_a", null], ["m_b", null]]);
  });

  it("keeps a member of the identity that joined after the socket did", async () => {
    // The attachment is a snapshot of who the identity owned at upgrade. A
    // member of the identity that joins later is served by the same socket
    // through the bus, and is not in the snapshot.
    const { id, store, stub } = await room([here("m_here"), quiet("m_a")], 3);
    await open(id);
    expect(await attachments(stub)).toEqual([expect.objectContaining({ memberIds: ["m_a"] })]);

    expect(await store.addMember(id, quiet("m_b"))).toBe(true);

    expect([...await store.connectedMembers(id)].sort()).toEqual(["m_a", "m_b"]);
    expect(await seat(store, id)).toEqual({ refused: "full", reclaimed: [] });
    expect(await roster(store, id)).toEqual([["m_here", null], ["m_a", null], ["m_b", null]]);
  });

  it("stamps the late joiner too, not just the ids the attachment names", async () => {
    // #152 with the snapshot problem above. The close stamps whom the socket was
    // vouching FOR, which `connectedAmong` answers — stamping the attachment's
    // ids directly would leave `m_b` on the `lastSeenAt` it joined with, and the
    // next contested confirm would take ITS seat instead.
    const { id, store } = await room([here("m_here"), quiet("m_a")], 3);
    const ws = await open(id);
    expect(await store.addMember(id, quiet("m_b"))).toBe(true);

    ws.close(1000, "done");
    await vi.waitFor(async () => {
      expect(await store.connectedMembers(id)).toEqual(new Set());
    }, { timeout: 3000 });

    const stamped = (await store.getSession(id))!.members
      .filter((m) => m.memberId !== "m_here")
      .map((m) => [m.memberId, presenceOf(m)]);
    expect(stamped).toEqual([["m_a", "present"], ["m_b", "present"]]);
  });

  it("writes nothing to a closed room when its socket closes", async () => {
    // `touchMember`'s rule (src/rooms.ts): a closed room's record is over, and a
    // liveness write must not reopen it. The socket outlives the close of the
    // room it watched, so this is reachable rather than defensive.
    const { id, store } = await room([here("m_here"), quiet("m_quiet")], 2);
    const ws = await open(id);
    await store.closeSession(id);

    ws.close(1000, "done");
    await vi.waitFor(async () => {
      expect(await store.connectedMembers(id)).toEqual(new Set());
    }, { timeout: 3000 });

    const m = (await store.getSession(id))!.members.find((x) => x.memberId === "m_quiet")!;
    expect(m.lastSeenAt).toBe(1); // untouched
  });
});
