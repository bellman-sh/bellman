/**
 * #146: an open socket is liveness.
 *
 * #139 reads presence off `lastSeenAt`, which a member writes by calling
 * `bellman_sync` every ~25 seconds. A member fed by the local bus or by the
 * room's hibernating WebSocket makes no such call, so it reads stale after ten
 * minutes and the next contested `bellman_confirm` takes its seat while it is
 * watching the room. The object already knows who is connected: each socket's
 * attachment names the members its identity owned when the socket was accepted.
 *
 * These tests pin the reader in the runtime-free half: the derivation, the seat
 * rule that uses it, `presenceOf`, and the four places a handler reads presence.
 * The object's half, with real sockets, is worker-tests/presence-sockets.test.ts.
 * tests/presence.test.ts is #139's and is not edited: every case there still
 * passes with no socket in the picture, which is the other half of this change.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  STALE_AFTER_MS, connectedAmong, presenceOf, presentMembers, staleMembers,
} from "../src/presence.js";
import { MemoryStore, seatVictims } from "../src/store.js";
import { member, session, swarmSession } from "./helpers/fixtures.js";
import { Harness, DEV_KEY } from "./helpers/harness.js";
import { brief } from "./helpers/fixtures.js";

const NOW = 1_800_000_000_000;
const AGES_AGO = NOW - STALE_AFTER_MS - 1;
const CUTOFF = NOW - STALE_AFTER_MS;

const ids = (set: ReadonlySet<string>) => [...set].sort();

describe("connectedAmong — the members a live socket vouches for", () => {
  // One identity that owns two members, and a stranger. A socket is
  // authenticated as an identity, and its attachment lists that identity's
  // members.
  const roster = [
    member({ memberId: "m_a", userId: "u_jesse" }),
    member({ memberId: "m_b", userId: "u_jesse" }),
    member({ memberId: "m_c", userId: "u_other" }),
  ];

  it("keeps both members present when one socket serves two", () => {
    expect(ids(connectedAmong(roster, ["m_a", "m_b"]))).toEqual(["m_a", "m_b"]);
  });

  it("vouches for a member that joined after the socket was accepted", () => {
    // The attachment is a snapshot: it names m_a and nothing newer. The bus
    // serves every session of an identity on a machine through one socket, so a
    // member that joins after the socket was accepted is carried by it and is not
    // named in it. Reading the ids literally would leave that member stale after
    // ten minutes.
    expect(ids(connectedAmong(roster, ["m_a"]))).toEqual(["m_a", "m_b"]);
  });

  it("does not vouch for another identity", () => {
    expect(connectedAmong(roster, ["m_a"]).has("m_c")).toBe(false);
  });

  it("reports nobody when no socket is open", () => {
    expect(ids(connectedAmong(roster, []))).toEqual([]);
  });

  it("ignores an id that is not on the roster", () => {
    expect(ids(connectedAmong(roster, ["m_gone"]))).toEqual([]);
  });

  it("leaves out a member that has left, whatever its identity is doing", () => {
    const left = [
      member({ memberId: "m_a", userId: "u_jesse" }),
      member({ memberId: "m_old", userId: "u_jesse", leftAt: NOW - 1 }),
    ];
    expect(ids(connectedAmong(left, ["m_a", "m_old"]))).toEqual(["m_a"]);
  });
});

describe("presenceOf, given who is connected", () => {
  it("reads a quiet member carried by an open socket as present", () => {
    const quiet = member({ memberId: "m_quiet", lastSeenAt: AGES_AGO });
    expect(presenceOf(quiet, NOW, new Set(["m_quiet"]))).toBe("present");
    // Nothing else changed: the same member, with no socket, is #139's stale.
    expect(presenceOf(quiet, NOW)).toBe("stale");
    expect(presenceOf(quiet, NOW, new Set(["m_someone_else"]))).toBe("stale");
  });

  it("keeps a member that has left departed, however it is connected", () => {
    const left = member({ memberId: "m_left", lastSeenAt: NOW, leftAt: NOW - 1 });
    expect(presenceOf(left, NOW, new Set(["m_left"]))).toBe("departed");
  });

  it("splits a roster by the same rule", () => {
    const roster = [
      member({ memberId: "m_poll", lastSeenAt: NOW }),
      member({ memberId: "m_socket", lastSeenAt: AGES_AGO }),
      member({ memberId: "m_neither", lastSeenAt: AGES_AGO }),
    ];
    const connected = new Set(["m_socket"]);
    expect(presentMembers(roster, NOW, connected).map((m) => m.memberId))
      .toEqual(["m_poll", "m_socket"]);
    expect(staleMembers(roster, NOW, connected).map((m) => m.memberId))
      .toEqual(["m_neither"]);
  });
});

describe("seatVictims, given who is connected", () => {
  const at = (ms: number, id: string) => member({ memberId: id, lastSeenAt: ms });

  it("never picks a connected member, however long it has been quiet", () => {
    const roster = [at(NOW, "m_here"), at(1, "m_socket")];
    // Without the set the quiet one is the victim; with it the room is full.
    expect(seatVictims(roster, 2, CUTOFF)?.map((m) => m.memberId)).toEqual(["m_socket"]);
    expect(seatVictims(roster, 2, CUTOFF, new Set(["m_socket"]))).toBeNull();
  });

  it("takes the quiet member that has no socket instead", () => {
    const roster = [at(NOW, "m_here"), at(1, "m_socket"), at(2, "m_neither")];
    const victims = seatVictims(roster, 3, CUTOFF, new Set(["m_socket"]));
    // m_socket has been quiet longest, and is skipped.
    expect(victims?.map((m) => m.memberId)).toEqual(["m_neither"]);
  });

  it("keeps both members of a two-member socket", () => {
    const roster = [at(NOW, "m_here"), at(1, "m_a"), at(2, "m_b")];
    expect(seatVictims(roster, 3, CUTOFF, new Set(["m_a", "m_b"]))).toBeNull();
  });
});

/**
 * MemoryStore holds no socket to a room, so a test that wants one says which
 * members it carries. `connectedMembers` and `seatMember` both read the same
 * hook, which is the arrangement SessionDO has with its own sockets.
 */
class SocketedStore extends MemoryStore {
  readonly attached = new Set<string>();
  protected override attachedTo(): Iterable<string> {
    return this.attached;
  }
}

describe("the four places a handler reads presence", () => {
  let store: SocketedStore;
  let h: Harness;
  beforeEach(() => {
    store = new SocketedStore();
    h = new Harness(store);
  });
  afterEach(async () => { await h.close(); });

  const creator = (over = {}) =>
    member({ memberId: "m_creator", userId: "u_jesse", lastSeenAt: Date.now(), ...over });
  const quiet = () =>
    member({ memberId: "m_quiet", userId: "u_quiet", roomRole: "peer_b", lastSeenAt: 1 });
  const read = async () => (await store.getSession("qs_test"))!;

  it("bellman_connect counts a connected member's seat as held", async () => {
    await store.createSession(session({ members: [creator(), quiet()] }));
    const peer = await h.connect(DEV_KEY.peer);

    store.attached.add("m_quiet");
    const held = await peer.call("bellman_connect", { join_code: "BELL-TEST-01" });
    expect(held.isError).toBe(true);
    expect(held.text).toMatch(/full/i);

    // The socket closes. Same room, same member, and the preview goes through:
    // the seat is the quiet member's only while its socket is open.
    store.attached.clear();
    const free = await peer.call("bellman_connect", { join_code: "BELL-TEST-01" });
    expect(free.isError, free.text).toBe(false);
  });

  it("bellman_confirm reports the member present and retires the codes of a full room", async () => {
    // Two seats: a quiet member on a socket, and the joiner.
    await store.createSession(session({ members: [quiet()] }));
    store.attached.add("m_quiet");
    const peer = await h.connect(DEV_KEY.peer);

    const preview = await peer.call("bellman_connect", { join_code: "BELL-TEST-01" });
    expect(preview.isError, preview.text).toBe(false);
    const confirmed = await peer.call("bellman_confirm", {
      connect_token: String(preview.data.connect_token),
      brief: brief(),
      capabilities: ["read_context", "receive_messages"],
    });
    expect(confirmed.isError, confirmed.text).toBe(false);

    const roster = confirmed.data.members as { member_id: string; presence: string }[];
    expect(roster.map((m) => [m.member_id, m.presence])).toEqual([
      ["m_quiet", "present"],
      [String(confirmed.data.member_id), "present"],
    ]);
    // Two present members in two seats: no code can be redeemed.
    expect((await read()).joinCodes).toEqual({});
  });

  it("bellman_confirm still reports a quiet member without a socket as stale", async () => {
    await store.createSession(swarmSession({ members: [creator(), quiet()] }));
    const peer = await h.connect(DEV_KEY.peer);

    const preview = await peer.call("bellman_connect", { join_code: "BELL-TEST-01" });
    const confirmed = await peer.call("bellman_confirm", {
      connect_token: String(preview.data.connect_token),
      brief: brief(),
      capabilities: ["read_context", "receive_messages"],
    });
    expect(confirmed.isError, confirmed.text).toBe(false);

    const roster = confirmed.data.members as { member_id: string; presence: string }[];
    expect(roster.find((m) => m.member_id === "m_quiet")?.presence).toBe("stale");
    // Two present members in a swarm room: the code stays.
    expect(Object.keys((await read()).joinCodes)).not.toEqual([]);
  });

  it("bellman_invite refuses a room whose seats are all held by present members", async () => {
    // Full only if the quiet member's socket counts: creator and quiet in two seats.
    await store.createSession(session({ members: [creator(), quiet()] }));
    const host = await h.connect(DEV_KEY.jesse);

    store.attached.add("m_quiet");
    const refused = await host.call("bellman_invite", { session_id: "qs_test", member_id: "m_creator" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/full/i);

    store.attached.clear();
    const minted = await host.call("bellman_invite", { session_id: "qs_test", member_id: "m_creator" });
    expect(minted.isError, minted.text).toBe(false);
  });

  it("bellman_confirm does not reap a connected member to make room", async () => {
    // Contested: a two-seat room, the creator present, the other seat held by a
    // member that has been quiet for hours but has a socket.
    await store.createSession(session({ members: [creator(), quiet()] }));
    store.attached.add("m_quiet");

    const outcome = await store.seatMember(
      "qs_test", member({ memberId: "m_late", userId: "u_late", roomRole: "peer_b" }),
      Date.now() - STALE_AFTER_MS, Date.now(),
    );

    expect(outcome).toEqual({ refused: "full", reclaimed: [], codesCleared: false });
    expect((await read()).members.map((m) => [m.memberId, m.leftAt]))
      .toEqual([["m_creator", null], ["m_quiet", null]]);

    // The same call with the socket gone is #139's reap.
    store.attached.clear();
    const reaped = await store.seatMember(
      "qs_test", member({ memberId: "m_late", userId: "u_late", roomRole: "peer_b" }),
      Date.now() - STALE_AFTER_MS, Date.now(),
    );
    expect(reaped.refused).toBeNull();
    expect(reaped.reclaimed.map((m) => m.memberId)).toEqual(["m_quiet"]);
  });

  it("a sweep stamps the members a socket vouches for instead of closing the room (#18)", async () => {
    await store.createSession(session({ members: [
      creator(), member({ memberId: "m_quiet", userId: "u_quiet", roomRole: "peer_b", lastSeenAt: 1 }),
    ] }));
    // Both quiet past any window (1 ms after the epoch); only m_quiet is on a socket.
    await store.updateMember("qs_test", "m_creator", { lastSeenAt: 1 });
    store.attached.add("m_quiet");
    const now = Date.now();

    await store.sweep(now);

    const after = await read();
    expect(after.closed).toBe(false);
    expect(after.members.map((m) => [m.memberId, m.lastSeenAt])).toEqual([["m_creator", 1], ["m_quiet", now]]);
    expect(await store.eventsAfter("qs_test", 0)).toEqual([]);

    // The same sweep with the socket gone closes it: the stamp was the socket's.
    store.attached.clear();
    await store.updateMember("qs_test", "m_quiet", { lastSeenAt: 1 });
    await store.sweep(now);
    expect((await read()).closed).toBe(true);
  });
});
