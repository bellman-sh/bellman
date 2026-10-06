/**
 * Conformance suite for the BellmanStore interface.
 *
 * The intent is that every implementation passes this identically: that is what
 * makes the interface a real seam rather than a comment. Two stores run it now:
 *
 *   - MemoryStore, under the root vitest program (tests/store.test.ts).
 *   - DurableObjectStore, the store that serves production, inside workerd
 *     (worker-tests/store-contract.test.ts). That is a SEPARATE vitest program
 *     with its own dependency tree; see worker-tests/README.md for why.
 *
 * So an assertion added below is proven for both, and a divergence between them
 * shows up here rather than in production. Where one genuinely cannot pass a
 * case, say so through `divergences` below — the reason is required, and the
 * case still runs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { BellmanStore, EventBody, RemovalRequest } from "../../src/store.js";
import { JOIN_CODE_TTL, CONNECT_TOKEN_TTL } from "../../src/store.js";
import { MAX_PAYLOAD_DEPTH, PayloadTooDeepError } from "../../src/payload.js";
import { lastReport } from "../../src/heartbeat.js";
import { member, oneCode, roomManifest, session } from "./fixtures.js";

/**
 * Cases an implementation cannot pass, each mapped to the reason it cannot.
 *
 * An entry here is a deliberate hole in "every implementation passes this
 * identically", so the reason is the whole value of it and is required. The
 * case is NOT skipped: it runs under `it.fails`, which is red unless the case
 * fails. Fix the underlying cause and this suite tells you to delete the entry,
 * rather than leaving a skip nobody revisits.
 *
 * The cost of `it.fails` over a skip, stated plainly: it is satisfied by the
 * case failing for ANY reason, so it would stay green if the case broke afresh
 * for an unrelated one. It buys "this still executes and still diverges", not
 * "it diverges for the reason named here".
 */
export interface StoreContractDivergences {
  /**
   * EMPTY, and that is the goal state: both stores pass every case identically.
   *
   * It held one entry, `errorIdentityAcrossRpc`, from #12's first run of this suite
   * inside workerd until #101 closed it — `instanceof` across a Durable Object RPC
   * boundary, where workerd reconstructs a thrown error with its name and own
   * properties but not its prototype. `DurableObjectStore` now revives at the seam
   * (src/rpc-error.ts), so the case is an ordinary `it` for both.
   *
   * The mechanism stays for the next one. Add a field here, named for the behaviour
   * rather than the store, with the reason as its type's doc — then pass it at the
   * call site. The case keeps running under `it.fails`, so it goes red the moment the
   * hole is fixed and tells you to delete the entry.
   */
  readonly __none__?: never;
}

export function describeStoreContract(
  name: string,
  makeStore: () => BellmanStore,
  divergences: StoreContractDivergences = {},
): void {
  describe(`BellmanStore contract: ${name}`, () => {
    let store: BellmanStore;

    /**
     * `it`, unless this store has an argued reason it cannot pass the case.
     *
     * Unused while `StoreContractDivergences` is empty, which is the goal state. Kept
     * because it IS the mechanism described there: a divergence is recorded by passing
     * a reason, and this is what turns that reason into a case that still runs.
     */
    const caseFor = (reason: string | undefined) => (reason ? it.fails : it);

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-15T12:00:00Z"));
      store = makeStore();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    // ------------------------------------------------------------- sessions
    it("round-trips a created session", async () => {
      const s = session();
      (await store.createSession(s));
      expect((await store.getSession(s.id))?.id).toBe(s.id);
      expect((await store.getSession(s.id))?.members).toHaveLength(1);
      // The manifest is the room's authority; a store that drops it breaks every
      // room, so every implementation must hand it back whole. Only MemoryStore
      // runs this line; DurableObjectStore's round trip is pinned separately, in
      // tests/store-do-wiring.test.ts.
      expect((await store.getSession(s.id))?.manifest).toEqual(s.manifest);
    });

    it("returns undefined for an unknown session", async () => {
      expect((await store.getSession("qs_nope"))).toBeUndefined();
    });

    /**
     * INVARIANT 5: state lives behind the store. A caller that mutates the
     * object it read back must not affect stored state — otherwise handlers
     * silently depend on MemoryStore's shared references and break the moment
     * a real database is behind the interface.
     */
    it("hands back a detached copy, so caller mutation does not persist", async () => {
      const s = session();
      (await store.createSession(s));

      const read = (await store.getSession(s.id))!;
      read.closed = true;
      read.members.push(member({ memberId: "m_smuggled" }));
      read.members[0].brief.goal = "mutated";
      read.maxMembers = 999;

      const fresh = (await store.getSession(s.id))!;
      expect(fresh.closed).toBe(false);
      expect(fresh.members).toHaveLength(1);
      expect(fresh.members[0].brief.goal).not.toBe("mutated");
      expect(fresh.maxMembers).toBe(2);
    });

    it("does not let the caller's original object mutate stored state either", async () => {
      const s = session();
      (await store.createSession(s));
      s.members.push(member({ memberId: "m_smuggled" }));
      expect((await store.getSession(s.id))?.members).toHaveLength(1);
    });

    // ------------------------------------------------------------ join codes
    it("finds a session by join code", async () => {
      const s = session({ joinCodes: oneCode("BELL-ABCD-12") });
      (await store.createSession(s));
      const hit = await store.getSessionByJoinCode("BELL-ABCD-12");
      expect(hit?.session.id).toBe(s.id);
      expect(hit?.role).toBe("peer_b");
      expect((await store.getSessionByJoinCode("BELL-ZZZZ-99"))).toBeUndefined();
    });

    /** INVARIANT 2: unused join codes expire after 15 minutes. */
    it("stops resolving a join code once its TTL elapses", async () => {
      const s = session({ joinCodes: oneCode("BELL-TTL0-01") });
      (await store.createSession(s));
      expect((await store.getSessionByJoinCode("BELL-TTL0-01"))).toBeDefined();

      vi.advanceTimersByTime(JOIN_CODE_TTL + 1);
      expect((await store.getSessionByJoinCode("BELL-TTL0-01"))).toBeUndefined();
    });

    /** INVARIANT 2: join codes are single-use. */
    it("consumeJoinCode makes the code unusable and idempotent", async () => {
      const s = session({ joinCodes: oneCode("BELL-ONCE-01") });
      (await store.createSession(s));

      (await store.consumeJoinCode(s.id, "peer_b"));
      expect((await store.getSessionByJoinCode("BELL-ONCE-01"))).toBeUndefined();
      expect((await store.getSession(s.id))?.joinCodes).toEqual({});

      await expect(store.consumeJoinCode(s.id, "peer_b")).resolves.not.toThrow();
    });

    it("never resolves a join code for a closed session", async () => {
      const s = session();
      (await store.createSession(s));
      (await store.closeSession(s.id));
      expect((await store.getSessionByJoinCode("BELL-TEST-01"))).toBeUndefined();
    });

    /**
     * The `closed` guard in its own right. The case above reaches `undefined` via
     * the emptied index, so it would pass even with the guard deleted; this one
     * gets past the index and can only be refused by the guard itself.
     */
    it("refuses a code that is still indexed for a session that is closed", async () => {
      const s = session({ closed: true, joinCodes: oneCode("BELL-SHUT-01") });
      (await store.createSession(s));

      expect(await store.getSessionByJoinCode("BELL-SHUT-01")).toBeUndefined();
    });

    it("holds a live code for two roles at once, each resolving to its own role", async () => {
      const s = session({ joinCodes: oneCode("BELL-AAAA-01", "peer_b") });
      (await store.createSession(s));
      (await store.setJoinCode(s.id, "peer_a", "BELL-CCCC-03", Date.now() + JOIN_CODE_TTL));

      expect((await store.getSessionByJoinCode("BELL-AAAA-01"))?.role).toBe("peer_b");
      expect((await store.getSessionByJoinCode("BELL-CCCC-03"))?.role).toBe("peer_a");
    });

    /** The invariant the whole issue turns on. */
    it("issuing for one role leaves another role's code resolving", async () => {
      const s = session({ joinCodes: oneCode("BELL-AAAA-01", "peer_b") });
      (await store.createSession(s));
      (await store.setJoinCode(s.id, "peer_a", "BELL-CCCC-03", Date.now() + JOIN_CODE_TTL));

      (await store.setJoinCode(s.id, "peer_a", "BELL-DDDD-04", Date.now() + JOIN_CODE_TTL));

      expect(await store.getSessionByJoinCode("BELL-CCCC-03")).toBeUndefined();
      expect((await store.getSessionByJoinCode("BELL-DDDD-04"))?.role).toBe("peer_a");
      expect((await store.getSessionByJoinCode("BELL-AAAA-01"))?.role).toBe("peer_b");
    });

    it("consuming one role's code leaves the other resolving", async () => {
      const s = session({ joinCodes: oneCode("BELL-AAAA-01", "peer_b") });
      (await store.createSession(s));
      (await store.setJoinCode(s.id, "peer_a", "BELL-CCCC-03", Date.now() + JOIN_CODE_TTL));

      (await store.consumeJoinCode(s.id, "peer_b"));

      expect(await store.getSessionByJoinCode("BELL-AAAA-01")).toBeUndefined();
      expect((await store.getSessionByJoinCode("BELL-CCCC-03"))?.role).toBe("peer_a");
    });

    it("clearJoinCodes retires every code, idempotently", async () => {
      const s = session({ joinCodes: oneCode("BELL-AAAA-01", "peer_b") });
      (await store.createSession(s));
      (await store.setJoinCode(s.id, "peer_a", "BELL-CCCC-03", Date.now() + JOIN_CODE_TTL));

      (await store.clearJoinCodes(s.id));

      expect(await store.getSessionByJoinCode("BELL-AAAA-01")).toBeUndefined();
      expect(await store.getSessionByJoinCode("BELL-CCCC-03")).toBeUndefined();
      expect((await store.getSession(s.id))?.joinCodes).toEqual({});
      await expect(store.clearJoinCodes(s.id)).resolves.not.toThrow();
    });

    it("closing a session clears every code, not just the default role's", async () => {
      const s = session({ joinCodes: oneCode("BELL-AAAA-01", "peer_b") });
      (await store.createSession(s));
      (await store.setJoinCode(s.id, "peer_a", "BELL-CCCC-03", Date.now() + JOIN_CODE_TTL));

      (await store.closeSession(s.id));

      expect((await store.getSession(s.id))?.joinCodes).toEqual({});
    });

    /** The whole string is the key, so a doctored suffix was never issued. */
    it("does not resolve a code whose role group was edited or stripped", async () => {
      const s = session({ joinCodes: oneCode("BELL-7F3K-92-PEER-B", "peer_b") });
      (await store.createSession(s));

      expect((await store.getSessionByJoinCode("BELL-7F3K-92-PEER-B"))?.role).toBe("peer_b");
      expect(await store.getSessionByJoinCode("BELL-7F3K-92-PEER-A")).toBeUndefined();
      expect(await store.getSessionByJoinCode("BELL-7F3K-92")).toBeUndefined();
    });

    // --------------------------------------------------------------- members
    it("addMember appends a member", async () => {
      const s = session();
      (await store.createSession(s));
      (await store.addMember(s.id, member({ memberId: "m_joiner", userId: "u_peer" })));

      const fresh = (await store.getSession(s.id))!;
      expect(fresh.members.map((m) => m.memberId)).toEqual(["m_creator", "m_joiner"]);
    });

    it("updateMember patches brief, capabilities and leftAt", async () => {
      const s = session();
      (await store.createSession(s));

      (await store.updateMember(s.id, "m_creator", {
        capabilities: ["read_context"],
        leftAt: Date.now(),
      }));
      const fresh = (await store.getSession(s.id))!;
      expect(fresh.members[0].capabilities).toEqual(["read_context"]);
      expect(fresh.members[0].leftAt).toBe(Date.now());
      // untouched fields survive the patch
      expect(fresh.members[0].label).toBe("jesse@codenerd");
    });

    /**
     * `connectedMembers` is on BellmanStore and had no case here, so the two
     * implementations could drift on it with nothing to catch them — and three
     * capacity gates plus the roster read it (#146, #140).
     *
     * What both can be held to is the shape and the safe defaults. The widening
     * rule itself (`connectedAmong`) needs a socket, which only one store has:
     * tests/presence-sockets.test.ts covers it as a pure function, and
     * worker-tests/presence-sockets.test.ts covers it through real sockets. This
     * suite covers what every implementation owes regardless of transport.
     *
     * These pin agreement that already holds rather than fixing a divergence, so
     * none of them was red first. Each was proven by breaking the store instead;
     * the commit says which mutation reddens which.
     */
    it("connectedMembers is empty for a room nobody has a socket on", async () => {
      const s = session({ members: [member({ memberId: "m_creator" })] });
      await store.createSession(s);

      expect([...(await store.connectedMembers(s.id))]).toEqual([]);
    });

    it("connectedMembers reports an unknown session as empty rather than throwing", async () => {
      // The gates call this on a room they have only just resolved, and
      // `issueInvite` calls it before its own guards. A throw here would turn a
      // missing room into a failure on three read-only paths.
      expect([...(await store.connectedMembers("qs_nope"))]).toEqual([]);
    });

    it("connectedMembers answers a set, which is what presence asks with", async () => {
      // `presenceOf` and `seatVictims` both call `.has`, and SessionDO answers
      // this over RPC as an array that the facade re-wraps. A store that handed
      // back the array instead would make every `.has` undefined, so every
      // socket-fed member would read stale again — silently, since an array is
      // truthy and iterable.
      const s = session({ members: [member({ memberId: "m_creator" })] });
      await store.createSession(s);

      const connected = await store.connectedMembers(s.id);
      expect(typeof connected.has).toBe("function");
      expect(connected.has("m_creator")).toBe(false);
      expect(connected.size).toBe(0);
    });

    it("seatMember seats the joiner, reclaiming the stale seat in one operation", async () => {
      // The production join path. Read-then-write capacity was the bug: two
      // confirms agreeing on one seat overfill the room, and a sync landing in
      // the gap makes a member live again after it was chosen as the victim. So
      // every store has to decide and write without yielding.
      const s = session({
        members: [
          member({ memberId: "m_creator", lastSeenAt: 2_000_000 }),
          member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b", lastSeenAt: 1 }),
        ],
      });
      (await store.createSession(s));

      const outcome = await store.seatMember(
        s.id,
        member({ memberId: "m_late", userId: "u_late", roomRole: "peer_b" }),
        1_000_000,
        9_000_000,
      );

      expect(outcome.refused).toBeNull();
      expect(outcome.reclaimed.map((m) => m.memberId)).toEqual(["m_peer"]);
      // Reported with leftAt already set, so the caller announces a removal
      // that happened rather than one it predicted.
      expect(outcome.reclaimed[0].leftAt).toBe(9_000_000);

      const fresh = (await store.getSession(s.id))!;
      expect(fresh.members.map((m) => m.memberId)).toEqual(["m_creator", "m_peer", "m_late"]);
      expect(fresh.members.find((m) => m.memberId === "m_peer")?.leftAt).toBe(9_000_000);
      expect(fresh.members.find((m) => m.memberId === "m_creator")?.leftAt).toBeNull();
    });

    it("seatMember seats into a room with a spare seat, reclaiming nobody", async () => {
      const s = session({
        maxMembers: 5,
        members: [member({ memberId: "m_quiet", lastSeenAt: 1 })],
      });
      (await store.createSession(s));

      const outcome = await store.seatMember(
        s.id, member({ memberId: "m_late", userId: "u_late" }), 1_000_000, 9_000_000
      );

      expect(outcome).toEqual({ refused: null, reclaimed: [], codesCleared: false });
      // Held for them, not taken: the joiner can have the free seat, so the
      // quiet member keeps its own.
      expect((await store.getSession(s.id))!.members.find((m) => m.memberId === "m_quiet")?.leftAt)
        .toBeNull();
    });

    it("seatMember refuses a full room of present members, reclaiming nobody", async () => {
      const s = session({
        members: [
          member({ memberId: "m_creator", lastSeenAt: 2_000_000 }),
          member({ memberId: "m_peer", userId: "u_peer", lastSeenAt: 2_000_000 }),
        ],
      });
      (await store.createSession(s));

      expect(await store.seatMember(
        s.id, member({ memberId: "m_late", userId: "u_late" }), 1_000_000, 9_000_000
      )).toEqual({ refused: "full", reclaimed: [], codesCleared: false });
      expect((await store.getSession(s.id))!.members).toHaveLength(2);
    });

    it("seatMember refuses a frozen room, and a closed one, reclaiming nobody", async () => {
      const stale = () => session({
        members: [
          member({ memberId: "m_creator", lastSeenAt: 2_000_000 }),
          member({ memberId: "m_peer", userId: "u_peer", lastSeenAt: 1 }),
        ],
      });
      const frozen = stale();
      (await store.createSession(frozen));
      (await store.freezeSession(frozen.id, 5));

      // The guards are inside the operation because the removal and its
      // announcement are separate writes: updateMember has no frozen guard and
      // appendEvent returns null, so reaping here would remove members
      // permanently AND silently from a state meant to be reversible.
      expect(await store.seatMember(
        frozen.id, member({ memberId: "m_late", userId: "u_late" }), 1_000_000, 9_000_000
      )).toEqual({ refused: "frozen", reclaimed: [], codesCleared: false });
      expect((await store.getSession(frozen.id))!.members
        .find((m) => m.memberId === "m_peer")?.leftAt).toBeNull();

      (await store.freezeSession(frozen.id, null));
      (await store.closeSession(frozen.id));
      expect((await store.seatMember(
        frozen.id, member({ memberId: "m_late", userId: "u_late" }), 1_000_000, 9_000_000
      )).refused).toBe("closed");
    });

    it("seatMember refuses rather than freeing some of the seats a joiner needs", async () => {
      const s = session({
        maxMembers: 2,
        members: [
          member({ memberId: "m_a", lastSeenAt: 2_000_000 }),
          member({ memberId: "m_b", userId: "u_b", lastSeenAt: 2_000_000 }),
          member({ memberId: "m_c", userId: "u_c", lastSeenAt: 1 }),
        ],
      });
      (await store.createSession(s));

      // Three undeparted members in a two-seat room needs two seats freed and
      // only one is reclaimable. A partial reap would remove a member for
      // somebody who never got in.
      expect(await store.seatMember(
        s.id, member({ memberId: "m_late", userId: "u_late" }), 1_000_000, 9_000_000
      )).toEqual({ refused: "full", reclaimed: [], codesCleared: false });
      expect((await store.getSession(s.id))!.members.filter((m) => m.leftAt !== null))
        .toEqual([]);
    });

    it("seatMember reports an unknown session rather than throwing", async () => {
      expect(await store.seatMember(
        "qs_nope", member({ memberId: "m_late", userId: "u_late" }), 0, 9_000_000
      )).toEqual({ refused: "not_found", reclaimed: [], codesCleared: false });
    });

    // ------------------------------------- the codes a seating retires (#116)
    //
    // bellman_confirm used to retire a filled room's codes in a second call, made once
    // the seat had committed, with nothing spanning the two. If that call threw, the
    // member was in the room with no event, no audit row and no member_id returned, and
    // the connect token that got them there is single use. The seating retires them
    // now, in the operation that decides the room is full.
    //
    // "Full" is whether a FURTHER joiner would be refused: no free seat and none
    // reclaimable. It is not a count of members whose `leftAt` is null. A stale seat is
    // occupied and reclaimable, so a room holding one still has a door worth leaving
    // open, and a count would retire its code.
    //
    // Each case plants the doors it means to test and starts by reading them back: a
    // room with no live door for the call to retire passes for any store. `oneCode`
    // plants for `peer_b` unless told otherwise. That is `session()`'s default role,
    // and not `member()`'s default seat, which is `peer_a`.

    /** The joiner every case below seats: fresh, and in the role `oneCode` plants for. */
    const late = () => member({ memberId: "m_late", userId: "u_late", roomRole: "peer_b" });

    /** The control each case starts from: its doors are in the record, and each resolves. */
    const doorsAreLive = async (sessionId: string, doors: ReturnType<typeof oneCode>) => {
      expect((await store.getSession(sessionId))!.joinCodes, "control: the doors are planted")
        .toEqual(doors);
      for (const [role, rec] of Object.entries(doors)) {
        expect(await store.getSessionByJoinCode(rec.code), `control: the ${role} door resolves before the call`)
          .toMatchObject({ role });
      }
    };

    it("seatMember retires every role's code when the seat it took filled the room", async () => {
      // Two doors, on two roles, and the joiner takes one of them: a store that
      // retired only the joiner's own role's code, or only the default role's, would
      // shut one and leave the other redeemable.
      const doors = { ...oneCode("BELL-LIVE-01", "peer_b"), ...oneCode("BELL-LIVE-02", "peer_a") };
      const s = session({
        maxMembers: 2,
        joinCodes: doors,
        members: [member({ memberId: "m_creator" })],
      });
      await store.createSession(s);
      await doorsAreLive(s.id, doors);

      const outcome = await store.seatMember(s.id, late(), 1, 9_000_000);

      expect(outcome).toEqual({ refused: null, reclaimed: [], codesCleared: true });
      const after = (await store.getSession(s.id))!;
      expect(after.members.map((m) => m.memberId)).toEqual(["m_creator", "m_late"]);
      // The record, and not only what resolves: a store that expired the codes instead
      // of removing them would stop resolving them and still list them.
      expect(after.joinCodes).toEqual({});
      expect(await store.getSessionByJoinCode("BELL-LIVE-01")).toBeUndefined();
      expect(await store.getSessionByJoinCode("BELL-LIVE-02")).toBeUndefined();
    });

    it("seatMember retires the codes when the seat it reclaimed is the one that filled the room", async () => {
      // The joiner takes a seat a stale member held, so the room is as full as it was
      // and no seat is left for anyone: the door shuts, as it did when the handler
      // asked after the seat.
      const doors = oneCode("BELL-LIVE-01");
      const s = session({
        maxMembers: 2,
        joinCodes: doors,
        members: [
          member({ memberId: "m_creator", lastSeenAt: 2_000_000 }),
          member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b", lastSeenAt: 1 }),
        ],
      });
      await store.createSession(s);
      await doorsAreLive(s.id, doors);

      const outcome = await store.seatMember(s.id, late(), 1_000_000, 9_000_000);

      expect(outcome.refused).toBeNull();
      expect(outcome.reclaimed.map((m) => m.memberId)).toEqual(["m_peer"]);
      expect(outcome.codesCleared).toBe(true);
      expect((await store.getSession(s.id))!.joinCodes).toEqual({});
      expect(await store.getSessionByJoinCode("BELL-LIVE-01")).toBeUndefined();
    });

    it("seatMember leaves the codes alone when a stale seat could still be reclaimed", async () => {
      // No FREE seat is left once this joiner is in, but one is reclaimable, so a
      // further joiner would get in and the door stays open. A count of members whose
      // leftAt is null reads this room as full and would retire the code, locking out
      // somebody who could have been seated.
      const doors = oneCode("BELL-LIVE-01");
      const s = session({
        maxMembers: 2,
        joinCodes: doors,
        members: [
          member({ memberId: "m_quiet_a", lastSeenAt: 1 }),
          member({ memberId: "m_quiet_b", userId: "u_b", roomRole: "peer_b", lastSeenAt: 2 }),
        ],
      });
      await store.createSession(s);
      await doorsAreLive(s.id, doors);

      // Both seats are stale, so this joiner reclaims ONE, the longest quiet, and the
      // other stays occupied but reclaimable. Had both members been fresh after the
      // seating, that would be the other case, and it DOES retire the code.
      const outcome = await store.seatMember(s.id, late(), 1_000_000, 9_000_000);

      expect(outcome.refused).toBeNull();
      expect(outcome.reclaimed.map((m) => m.memberId)).toEqual(["m_quiet_a"]);
      expect(outcome.codesCleared).toBe(false);
      const after = (await store.getSession(s.id))!;
      // The premise, read off the record: by a head count of undeparted members this
      // room is at capacity. That is what makes this a test of the question and not of
      // a room with space in it.
      expect(after.members.filter((m) => m.leftAt === null)).toHaveLength(2);
      expect(after.joinCodes, "the door is untouched").toEqual(doors);
      expect(await store.getSessionByJoinCode("BELL-LIVE-01")).toMatchObject({ role: "peer_b" });
    });

    it("seatMember leaves the codes alone when a seat is still spare", async () => {
      const doors = oneCode("BELL-LIVE-01");
      const s = session({
        maxMembers: 5,
        joinCodes: doors,
        members: [member({ memberId: "m_creator" })],
      });
      await store.createSession(s);
      await doorsAreLive(s.id, doors);

      const outcome = await store.seatMember(s.id, late(), 1, 9_000_000);

      expect(outcome).toEqual({ refused: null, reclaimed: [], codesCleared: false });
      expect((await store.getSession(s.id))!.joinCodes, "the door is untouched").toEqual(doors);
      expect(await store.getSessionByJoinCode("BELL-LIVE-01")).toMatchObject({ role: "peer_b" });
    });

    it("seatMember does not count a member who has left toward a full room", async () => {
      // Three seats, a creator, one member already gone, and the joiner: three rows
      // and two undeparted members, so a seat is spare. A store counting rows reads
      // this room as full.
      const doors = oneCode("BELL-LIVE-01");
      const s = session({
        maxMembers: 3,
        joinCodes: doors,
        members: [
          member({ memberId: "m_creator" }),
          member({ memberId: "m_gone", userId: "u_gone", roomRole: "peer_b", leftAt: 5_000 }),
        ],
      });
      await store.createSession(s);
      await doorsAreLive(s.id, doors);

      const outcome = await store.seatMember(s.id, late(), 1, 9_000_000);

      expect(outcome).toEqual({ refused: null, reclaimed: [], codesCleared: false });
      const after = (await store.getSession(s.id))!;
      expect(after.members, "the premise: three rows").toHaveLength(3);
      expect(after.joinCodes, "the door is untouched").toEqual(doors);
    });

    it("seatMember reports no codes cleared when the room fills holding none", async () => {
      // The flag says what the call did. A room that fills with no code left in it had
      // nothing to retire: no registry write is owed, and a caller reading
      // `codesCleared` must not conclude that a door was shut.
      const s = session({
        maxMembers: 2,
        joinCodes: {},
        members: [member({ memberId: "m_creator" })],
      });
      await store.createSession(s);
      expect((await store.getSession(s.id))!.joinCodes, "control: the room holds no code").toEqual({});

      const outcome = await store.seatMember(s.id, late(), 1, 9_000_000);

      expect(outcome).toEqual({ refused: null, reclaimed: [], codesCleared: false });
      expect((await store.getSession(s.id))!.joinCodes).toEqual({});
      // The premise: the room did fill. Otherwise false here would mean "not full",
      // which the spare-seat case already pins, and this case would say nothing new.
      const further = member({ memberId: "m_later", userId: "u_later", roomRole: "peer_b" });
      expect((await store.seatMember(s.id, further, 1, 9_000_000)).refused).toBe("full");
    });

    it("seatMember clears an expired record when the room fills, and reports that it did", async () => {
      // removeMember retires only a code that is still live, because it announces a door
      // shutting and must not announce one that had already shut: an expired record is
      // not a door. A seating announces nothing and is tidying rows, and a full room needs
      // no code at all, so an expired record goes with the rest and the call reports that
      // it cleared one. The two ask different questions, and this pins this side of the
      // difference; see removeMember's expired-code cases for the other.
      const stale = { peer_b: { code: "BELL-STALE-1", expiresAt: Date.now() - 1 } };
      const s = session({
        maxMembers: 2,
        joinCodes: stale,
        members: [member({ memberId: "m_creator" })],
      });
      await store.createSession(s);
      expect((await store.getSession(s.id))!.joinCodes, "control: the expired record is planted").toEqual(stale);
      expect(await store.getSessionByJoinCode("BELL-STALE-1"), "control: it does not resolve").toBeUndefined();

      const outcome = await store.seatMember(s.id, late(), 1, Date.now());

      expect(outcome).toEqual({ refused: null, reclaimed: [], codesCleared: true });
      // The record, and not only what resolves: it did not resolve before the call either.
      expect((await store.getSession(s.id))!.joinCodes).toEqual({});
    });

    // A refusal retires nothing. The clearing sits in the same closure as the guards,
    // and a store that decided the room was full before looking at them, or that
    // retired the codes of a room it then refused, would pass every case above. Each
    // room is one this joiner would have FILLED had the seating gone through, except
    // "full", which is at capacity already, so a clearing that ignored the guard has a
    // door to shut.
    it.each([
      { refusal: "frozen", over: () => ({ frozenAt: Date.now() }) },
      { refusal: "closed", over: () => ({ closed: true }) },
      { refusal: "full", over: () => ({ maxMembers: 1 }) },
    ])("seatMember clears no codes when it refuses a $refusal room", async ({ refusal, over }) => {
      const doors = oneCode("BELL-LIVE-01");
      const s = session({
        maxMembers: 2,
        joinCodes: doors,
        members: [member({ memberId: "m_creator", lastSeenAt: Date.now() })],
        ...over(),
      });
      await store.createSession(s);
      // The record, and not what resolves: a closed room resolves no code whatever it lists.
      expect((await store.getSession(s.id))!.joinCodes, "control: the door is planted").toEqual(doors);

      const outcome = await store.seatMember(s.id, late(), 1, 9_000_000);

      expect(outcome).toEqual({ refused: refusal, reclaimed: [], codesCleared: false });
      const after = (await store.getSession(s.id))!;
      expect(after.joinCodes, "the door is untouched").toEqual(doors);
      expect(after.members.map((m) => m.memberId), "nobody was seated").toEqual(["m_creator"]);
    });

    it("updateMember patches lastSeenAt on its own", async () => {
      // The liveness write, and the only one of these a store sees on every
      // bellman_sync. A store that dropped it would read every member as stale
      // and reap the room out from under itself (#103), so both must apply it.
      const s = session({ members: [member({ lastSeenAt: 1 })] });
      (await store.createSession(s));

      (await store.updateMember(s.id, "m_creator", { lastSeenAt: 1_700_000_000_000 }));

      const fresh = (await store.getSession(s.id))!;
      expect(fresh.members[0].lastSeenAt).toBe(1_700_000_000_000);
      // Going quiet and leaving are separate facts: a touch must not revive a
      // member that left, and must not mark a present one as gone.
      expect(fresh.members[0].leftAt).toBeNull();
    });

    it("patches lastReportAt, and reads a member stored without it as joinedAt", async () => {
      // The heartbeat's stamp (#111). A member stored before the field existed has
      // none, and `lastReport` lifts it to joinedAt rather than reading it as
      // "never reported", which would name every such member silent on the first
      // tick. Both stores have to apply the patch and both have to hand the lift
      // the same raw value.
      const joinedAt = Date.now();
      await store.createSession(session({ members: [member({ lastReportAt: undefined, joinedAt })] }));
      const before = await store.getSession("qs_test");
      expect(before!.members[0].lastReportAt).toBeUndefined();
      expect(lastReport(before!.members[0])).toBe(joinedAt);

      await store.updateMember("qs_test", "m_creator", { lastReportAt: joinedAt + 60_000 });
      const after = await store.getSession("qs_test");
      expect(after!.members[0].lastReportAt).toBe(joinedAt + 60_000);
      expect(lastReport(after!.members[0])).toBe(joinedAt + 60_000);
      // Reporting is not liveness, and not leaving: the other two stay where they were.
      expect(after!.members[0].lastSeenAt).toBe(before!.members[0].lastSeenAt);
      expect(after!.members[0].leftAt).toBeNull();
    });

    it("updateMember ignores unknown members and sessions", async () => {
      const s = session();
      (await store.createSession(s));
      await expect(store.updateMember(s.id, "m_nope", { leftAt: 1 })).resolves.not.toThrow();
      await expect(store.updateMember("qs_nope", "m_creator", { leftAt: 1 })).resolves.not.toThrow();
    });

    it("closeSession marks the session closed", async () => {
      const s = session();
      (await store.createSession(s));
      (await store.closeSession(s.id));
      expect((await store.getSession(s.id))?.closed).toBe(true);
    });

    // ------------------------------------------------- closing an empty room
    /**
     * A room closes when nobody is left in it, and that has to be one operation.
     * A caller that read the roster and then called closeSession would leave a
     * window for a member to join in, and the room would close over them with
     * its codes retired.
     *
     * The answer is whether the room is closed, not whether this call closed it:
     * a room that was already closed answers true. That is what lets a retry of
     * a close that died partway finish the work, instead of reading as a no-op.
     */
    it("closeSessionIfEmpty closes a room nobody is in, and reports that it did", async () => {
      const s = session({ members: [member({ leftAt: Date.now() })] });
      (await store.createSession(s));

      expect(await store.closeSessionIfEmpty(s.id)).toBe(true);

      expect((await store.getSession(s.id))?.closed).toBe(true);
    });

    it("closeSessionIfEmpty retires every code when it closes, not just the default role's", async () => {
      const s = session({
        members: [member({ leftAt: Date.now() })],
        joinCodes: oneCode("BELL-AAAA-01", "peer_b"),
      });
      (await store.createSession(s));
      (await store.setJoinCode(s.id, "peer_a", "BELL-CCCC-03", Date.now() + JOIN_CODE_TTL));

      (await store.closeSessionIfEmpty(s.id));

      expect((await store.getSession(s.id))?.joinCodes).toEqual({});
      expect(await store.getSessionByJoinCode("BELL-AAAA-01")).toBeUndefined();
      expect(await store.getSessionByJoinCode("BELL-CCCC-03")).toBeUndefined();
    });

    it("closeSessionIfEmpty leaves a room alone while a member is in it, and says so", async () => {
      const s = session();
      (await store.createSession(s));

      expect(await store.closeSessionIfEmpty(s.id)).toBe(false);

      const after = (await store.getSession(s.id))!;
      expect(after.closed).toBe(false);
      // A refusal must not retire the door: the codes are how the room's next
      // member gets in.
      expect(after.joinCodes).toEqual(s.joinCodes);
      expect((await store.getSessionByJoinCode("BELL-TEST-01"))?.session.id).toBe(s.id);
    });

    it("closeSessionIfEmpty counts a member as out only once they have left", async () => {
      // One gone and one still in is not an empty room, and the one who stays
      // leaving is what empties it.
      const s = session({
        maxMembers: 3,
        members: [
          member({ leftAt: Date.now() }),
          member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b" }),
        ],
      });
      (await store.createSession(s));

      expect(await store.closeSessionIfEmpty(s.id)).toBe(false);
      expect((await store.getSession(s.id))?.closed).toBe(false);

      (await store.updateMember(s.id, "m_peer", { leftAt: Date.now() }));

      expect(await store.closeSessionIfEmpty(s.id)).toBe(true);
      expect((await store.getSession(s.id))?.closed).toBe(true);
    });

    /**
     * Closed wins over frozen. Freezing refuses writes into a room someone is
     * in; it is no reason to keep a room open that has nobody left to thaw it
     * for. A guard copied from addMember's would get this wrong.
     */
    it("closeSessionIfEmpty closes an empty room even while it is frozen", async () => {
      const s = session({ members: [member({ leftAt: Date.now() })], frozenAt: Date.now() });
      (await store.createSession(s));

      expect(await store.closeSessionIfEmpty(s.id)).toBe(true);

      expect((await store.getSession(s.id))?.closed).toBe(true);
    });

    it("closeSessionIfEmpty is idempotent on a room that is already closed", async () => {
      const s = session({ members: [member({ leftAt: Date.now() })] });
      (await store.createSession(s));
      (await store.closeSession(s.id));

      expect(await store.closeSessionIfEmpty(s.id)).toBe(true);
      expect(await store.closeSessionIfEmpty(s.id)).toBe(true);
      expect((await store.getSession(s.id))?.closed).toBe(true);
    });

    /**
     * The idempotence above holds for an already-closed room that is also empty,
     * and would hold with no check for `closed` at all. This is the room that
     * check exists for: closed with a member still listed, which is what the
     * read-then-close race left behind in rooms written before it was fixed.
     * "Someone is in it" is a reason to refuse closing an open room. A room that
     * is closed has nothing left to refuse, and has to say so.
     */
    it("closeSessionIfEmpty reports a closed room closed even with a member listed in it", async () => {
      const s = session({ closed: true });
      (await store.createSession(s));

      expect(await store.closeSessionIfEmpty(s.id)).toBe(true);
    });

    it("closeSessionIfEmpty ignores a session that does not exist", async () => {
      await expect(store.closeSessionIfEmpty("qs_nope")).resolves.toBe(false);
    });

    /**
     * The two halves of one guarantee, and the case that says there is no gap
     * between them: closeSessionIfEmpty will not close an occupied room, and
     * seatMember will not seat anyone in a closed one. Neither is enough alone.
     * With only the first, a join landing after the close seats a member in a
     * room that is over. With only the second, a close that decided on an old
     * roster closes over a member who joined meanwhile.
     *
     * The join is seatMember because that is the production path, the one
     * bellman_confirm calls. addMember is the unconditional append and no tool
     * calls it, so racing that pair would guard a door nobody uses.
     *
     * Started together, each way round, so whichever lands first wins and the
     * other has to give way. Exactly one may succeed, and `refused` says which: it
     * is null exactly when the member is seated. Both is a closed room with a
     * member in it. Neither is a join refused by a room that never closed, so a
     * join that loses has to have lost to the close and not to some other refusal.
     *
     * Under vitest-pool-workers this case is reliable only because SessionDO makes
     * each half one transaction. Two plain reads and puts started together lose an
     * update there in about 1% of rounds (#120), which real workerd has not shown
     * (none in 24,000 rounds under `wrangler dev`, and its documentation says the
     * input gate prevents it). That is the pool failing to be workerd and not a bug
     * in production, and the transaction is what makes the case independent of it.
     * The case keeps its power where it matters: a facade that read the room and
     * then closed it, outside the object, fails every close-first round.
     * worker-tests/session-close-join-race.test.ts holds each half open to pin the
     * transaction itself.
     */
    it.each([
      { first: "close", second: "join" },
      { first: "join", second: "close" },
    ])("lets exactly one of a close and a join win when started together, $first first", async ({ first }) => {
      const s = session({ maxMembers: 3, members: [member({ leftAt: Date.now() })] });
      (await store.createSession(s));
      const joiner = member({ memberId: "m_late", userId: "u_peer", roomRole: "peer_b" });
      const close = () => store.closeSessionIfEmpty(s.id);
      // Nobody is stale and nobody is active, so nothing is reclaimed either way.
      const join = () => store.seatMember(s.id, joiner, 0, Date.now());

      // Property order is call order: whichever is named first is started first.
      const started = first === "close"
        ? { closing: close(), seating: join() }
        : { seating: join(), closing: close() };
      const [closed, outcome] = await Promise.all([started.closing, started.seating]);
      const seated = outcome.refused === null;

      const after = (await store.getSession(s.id))!;
      expect(closed, "a close and a join both succeeded, or neither did").not.toBe(seated);
      expect(after.closed).toBe(closed);
      expect(after.members.some((m) => m.memberId === "m_late")).toBe(seated);
      // A join that lost, lost to the close. "full" or "frozen" here would be another
      // bug, which the checks above could not tell from losing the race.
      if (!seated) expect(outcome.refused).toBe("closed");
      expect(outcome.reclaimed).toEqual([]);
    });

    // --------------------------------------------------------------- freezing
    /**
     * Frozen is not closed. A lapsed plan must be undoable without costing
     * anyone their room, so freezing sets a flag and nothing else: the members
     * are still members and the history is still there.
     */
    it("freezes and thaws without disturbing anything else", async () => {
      const s = session();
      (await store.createSession(s));
      (await store.appendEvent(s.id, {
        type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse",
        fromLabel: "jesse", payload: { text: "before" }, refId: null,
      }));

      const at = Date.now();
      (await store.freezeSession(s.id, at));
      const frozen = (await store.getSession(s.id))!;
      expect(frozen.frozenAt).toBe(at);
      expect(frozen.closed).toBe(false);
      expect(frozen.members).toHaveLength(1);
      expect((await store.eventsAfter(s.id, 0))).toHaveLength(1);

      (await store.freezeSession(s.id, null));
      expect((await store.getSession(s.id))?.frozenAt).toBeNull();
    });

    /**
     * Spec D10: "A member cannot report its way out of a frozen room, so none
     * may be named silent in one. A freeze must cost nobody their standing."
     *
     * Here rather than only in the store that serves production, because this is
     * what a THAW means and not what an alarm does: `lastReportAt` is read back
     * through `getSession`, so a store that left it alone would report a member
     * silent for the whole outage. The heartbeat tick is derived in one
     * implementation and absent in the other, but the stamp is interface
     * behaviour, and a divergence in it is exactly what this suite is for.
     */
    it("credits every reporting seat on a thaw, so a freeze costs nobody their standing", async () => {
      const manifest = roomManifest({
        roles: {
          lead: { can: ["send"], description: null, reports: true },
          observer: { can: [], description: null, reports: false },
        },
        defaultRole: "observer",
        creatorRole: "lead",
        heartbeatOnMs: 300_000,
      });
      const longAgo = Date.now() - 3_600_000;
      const s = session({
        manifest,
        members: [
          member({ memberId: "m_lead", roomRole: "lead", lastReportAt: longAgo }),
          member({ memberId: "m_obs", userId: "u_obs", roomRole: "observer", lastReportAt: longAgo }),
        ],
      });
      (await store.createSession(s));

      (await store.freezeSession(s.id, Date.now()));
      (await store.freezeSession(s.id, null));

      const after = (await store.getSession(s.id))!;
      const row = (id: string) => after.members.find((m) => m.memberId === id)!;
      // The hour nobody was allowed to report in is not held against the seat the
      // room asks: its clock starts again at the thaw.
      expect(lastReport(row("m_lead"))).toBeGreaterThan(Date.now() - 5_000);
      // And the seat the room does not ask is untouched. Nothing reads that stamp,
      // and a write that nothing reads is a field that later disagrees for no reason.
      expect(row("m_obs").lastReportAt).toBe(longAgo);
    });

    /**
     * **The credit belongs to the thaw, so only a real thaw may pay it.**
     *
     * `freezeSession(null)` on a room that is already thawed is not a thaw. It
     * clears `frozenAt`, which is already clear, and crediting on it hands every
     * reporting seat a fresh `lastReportAt` with nobody having reported — so
     * silence is measured from a moment no member had anything to do with.
     *
     * That is not a hypothetical call. `freezeSession(null)` is idempotent by
     * design and so the obvious thing to retry, and a caller that retries it on a
     * schedule keeps every member's clock reset for good: nobody is ever due, no
     * tick asks anybody, and `silent` never becomes true. The feature goes quiet in
     * exactly the room it exists for, and nothing in the log says why.
     *
     * The condition is the TRANSITION and not the argument, so it reads `frozenAt
     * !== null` off the record. A freeze-then-thaw pays once, however many thaws
     * follow it.
     */
    it("credits nobody when a thaw lands on a room that was not frozen", async () => {
      const manifest = roomManifest({
        roles: { lead: { can: ["send"], description: null, reports: true } },
        defaultRole: "lead",
        creatorRole: "lead",
        heartbeatOnMs: 300_000,
      });
      const longAgo = Date.now() - 3_600_000;
      const s = session({
        manifest,
        members: [member({ memberId: "m_lead", roomRole: "lead", lastReportAt: longAgo })],
      });
      (await store.createSession(s));

      // Never frozen, and the room says so.
      expect((await store.getSession(s.id))!.frozenAt).toBe(null);
      (await store.freezeSession(s.id, null));

      // The member's standing is its own: an hour of genuine silence, still an hour.
      expect((await store.getSession(s.id))!.members[0].lastReportAt).toBe(longAgo);

      // And the retry of a real thaw pays once, not once per attempt. The first
      // thaw credits; a second call finds nothing frozen and leaves that credit
      // where it is rather than moving it forward again.
      (await store.freezeSession(s.id, Date.now()));
      (await store.freezeSession(s.id, null));
      const credited = (await store.getSession(s.id))!.members[0].lastReportAt!;
      expect(credited).toBeGreaterThan(longAgo);

      (await store.freezeSession(s.id, null));
      expect((await store.getSession(s.id))!.members[0].lastReportAt).toBe(credited);
    });

    /**
     * The tool reads the session, then writes. A freeze landing in that gap
     * would let a frozen room grow, which is the one thing freezing is for —
     * so the refusal has to come from the write, not only from the read.
     */
    it("refuses the writes themselves while frozen, not only the reads", async () => {
      const s = session();
      (await store.createSession(s));
      (await store.freezeSession(s.id, Date.now()));

      expect(await store.addMember(s.id, member({ memberId: "m_late" }))).toBe(false);
      expect(await store.setJoinCode(s.id, "peer_b", "BELL-NEW-01", Date.now() + 60_000)).toBe(false);
      expect(await store.appendEvent(s.id, {
        type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse",
        fromLabel: "jesse", payload: { text: "nope" }, refId: null,
      })).toBeNull();

      const after = (await store.getSession(s.id))!;
      expect(after.members).toHaveLength(1);
      expect(after.joinCodes).toEqual(s.joinCodes);
      expect((await store.eventsAfter(s.id, 0))).toHaveLength(0);
    });

    it("accepts them again once thawed", async () => {
      const s = session();
      (await store.createSession(s));
      (await store.freezeSession(s.id, Date.now()));
      (await store.freezeSession(s.id, null));

      expect(await store.addMember(s.id, member({ memberId: "m_late" }))).toBe(true);
      expect((await store.getSession(s.id))?.members).toHaveLength(2);
    });

    it("ignores a freeze aimed at a session that does not exist", async () => {
      await expect(store.freezeSession("qs_nope", Date.now())).resolves.not.toThrow();
    });

    /**
     * A lapsed plan has to find the rooms it is about to freeze. The create
     * counts cannot answer that — they are timestamps for the monthly quota,
     * with no session id in them.
     */
    it("lists the sessions a person created, and nobody else's", async () => {
      (await store.createSession(session({ id: "qs_mine_1", createdBy: "u_jesse" })));
      (await store.createSession(session({ id: "qs_mine_2", createdBy: "u_jesse" })));
      (await store.createSession(session({ id: "qs_theirs", createdBy: "u_peer" })));

      expect((await store.sessionsCreatedBy("u_jesse", 10)).sort())
        .toEqual(["qs_mine_1", "qs_mine_2"]);
      expect(await store.sessionsCreatedBy("u_peer", 10)).toEqual(["qs_theirs"]);
      expect(await store.sessionsCreatedBy("u_nobody", 10)).toEqual([]);
    });

    it("honours the limit on that listing", async () => {
      for (const id of ["qs_a", "qs_b", "qs_c"]) {
        (await store.createSession(session({ id, createdBy: "u_jesse" })));
      }

      expect(await store.sessionsCreatedBy("u_jesse", 2)).toHaveLength(2);
    });

    /**
     * A lapse freezes the rooms this names, so a closed one is budget spent on
     * nothing. The index was never pruned and `limit` was applied to raw rows,
     * so a prolific account's walk filled its window with long-dead rooms and
     * never reached the live ones — the freeze then silently did nothing for
     * exactly the accounts that use Bellman most (#75, #115).
     */
    it("leaves closed rooms out of the created listing", async () => {
      (await store.createSession(session({ id: "qs_open", createdBy: "u_jesse" })));
      (await store.createSession(session({ id: "qs_shut", createdBy: "u_jesse" })));
      await store.closeSession("qs_shut");

      expect(await store.sessionsCreatedBy("u_jesse", 10)).toEqual(["qs_open"]);
    });

    it("counts live rooms against the limit, not index rows", async () => {
      // The closed rooms are created FIRST, so in both stores they sort and
      // insert ahead of the live ones. Applying the limit to rows returns a
      // window of nothing but tombstones; applying it to live rooms walks past
      // them. That ordering is the whole point of the test.
      for (const id of ["qs_dead_1", "qs_dead_2", "qs_dead_3"]) {
        (await store.createSession(session({ id, createdBy: "u_jesse" })));
        await store.closeSession(id);
      }
      (await store.createSession(session({ id: "qs_live_1", createdBy: "u_jesse" })));
      (await store.createSession(session({ id: "qs_live_2", createdBy: "u_jesse" })));

      expect((await store.sessionsCreatedBy("u_jesse", 2)).sort())
        .toEqual(["qs_live_1", "qs_live_2"]);
    });

    it("forgets a closed room's row, so the walk pays for it once", async () => {
      (await store.createSession(session({ id: "qs_gone", createdBy: "u_jesse" })));
      await store.closeSession("qs_gone");
      // The first call sweeps it. The second must not see it even though
      // nothing closed anything in between — that is what proves the row was
      // dropped rather than merely filtered out on the way past.
      expect(await store.sessionsCreatedBy("u_jesse", 10)).toEqual([]);
      (await store.createSession(session({ id: "qs_kept", createdBy: "u_jesse" })));
      expect(await store.sessionsCreatedBy("u_jesse", 10)).toEqual(["qs_kept"]);
    });

    /**
     * The other index keeps its closed rooms, deliberately and unlike the one
     * above: it answers which rooms a person HELD a handle in, so a closed room
     * is the history being asked for rather than a tombstone.
     */
    it("keeps closed rooms in the joined listing", async () => {
      (await store.createSession(session({
        id: "qs_was_mine", createdBy: "u_jesse",
        members: [member({ userId: "u_jesse" })],
      })));
      await store.closeSession("qs_was_mine");

      expect(await store.sessionsJoinedBy("u_jesse", 10)).toEqual(["qs_was_mine"]);
    });

    /**
     * The panel's main screen splits rooms a person created from rooms they
     * joined, and only the first had an index. `um:` is the second.
     *
     * The store returns ids for every room the user has ever held a handle in
     * — created, joined, left and closed alike. Filtering is the caller's, so
     * that one index can serve a panel screen and a freeze sweep that disagree
     * about what counts as current (D1, D4).
     */
    it("lists the rooms a person joined, and nobody else's", async () => {
      await store.createSession(session({ id: "qs_hers", createdBy: "u_peer", members: [] }));
      await store.createSession(session({ id: "qs_his", createdBy: "u_peer", members: [] }));
      await store.addMember("qs_hers", member({ memberId: "m_1", userId: "u_jesse" }));
      await store.addMember("qs_his", member({ memberId: "m_2", userId: "u_other" }));

      expect(await store.sessionsJoinedBy("u_jesse", 10)).toEqual(["qs_hers"]);
      expect(await store.sessionsJoinedBy("u_other", 10)).toEqual(["qs_his"]);
      expect(await store.sessionsJoinedBy("u_nobody", 10)).toEqual([]);
    });

    it("keeps two users whose ids share a prefix apart", async () => {
      // A user id that is a prefix of another's must not pull the other's rooms
      // into its listing, or the reverse. Whatever a store keys its index on,
      // u_a lists only u_a's rooms and u_ab only u_ab's.
      await store.createSession(session({ id: "qs_of_a", createdBy: "u_a", members: [] }));
      await store.createSession(session({ id: "qs_of_ab", createdBy: "u_ab", members: [] }));
      await store.addMember("qs_of_a", member({ memberId: "m_a", userId: "u_a" }));
      await store.addMember("qs_of_ab", member({ memberId: "m_ab", userId: "u_ab" }));

      expect(await store.sessionsJoinedBy("u_a", 10)).toEqual(["qs_of_a"]);
      expect(await store.sessionsJoinedBy("u_ab", 10)).toEqual(["qs_of_ab"]);
    });

    it("lists a room once for a person who joined it from two machines", async () => {
      await store.createSession(session({ id: "qs_twice", members: [] }));
      await store.addMember("qs_twice", member({ memberId: "m_laptop", userId: "u_jesse" }));
      await store.addMember("qs_twice", member({ memberId: "m_desktop", userId: "u_jesse" }));

      expect(await store.sessionsJoinedBy("u_jesse", 10)).toEqual(["qs_twice"]);
    });

    it("lists the creator's own room, because the creator holds a handle too", async () => {
      // The production path. bellman_start passes the creator in `members` and
      // never calls addMember, so createSession seats them directly and the
      // index has to be written there. addMember is the join path; the cases
      // around this one cover it.
      await store.createSession(
        session({ id: "qs_mine", createdBy: "u_jesse", members: [member({ userId: "u_jesse" })] }),
      );

      expect(await store.sessionsCreatedBy("u_jesse", 10)).toEqual(["qs_mine"]);
      expect(await store.sessionsJoinedBy("u_jesse", 10)).toEqual(["qs_mine"]);
    });

    it("indexes every member a session is created with, once each", async () => {
      // The field is an array, and the index reflects all of it, not just the
      // first seat. Two handles for one person are still one entry, as they are
      // on the addMember path.
      await store.createSession(session({
        id: "qs_seated",
        createdBy: "u_first",
        members: [
          member({ memberId: "m_a", userId: "u_first" }),
          member({ memberId: "m_b", userId: "u_second" }),
          member({ memberId: "m_c", userId: "u_second" }),
        ],
      }));

      expect(await store.sessionsJoinedBy("u_first", 10)).toEqual(["qs_seated"]);
      expect(await store.sessionsJoinedBy("u_second", 10)).toEqual(["qs_seated"]);
    });

    it("keeps listing a room after the member left it", async () => {
      await store.createSession(session({ id: "qs_past", members: [] }));
      await store.addMember("qs_past", member({ memberId: "m_gone", userId: "u_jesse" }));
      await store.updateMember("qs_past", "m_gone", { leftAt: Date.now() });

      expect(await store.sessionsJoinedBy("u_jesse", 10)).toEqual(["qs_past"]);
    });

    /** REVIEW FOCUS 5 — status is the caller's filter, not the store's. */
    it("keeps listing a room after it closed", async () => {
      await store.createSession(session({ id: "qs_over", members: [] }));
      await store.addMember("qs_over", member({ memberId: "m_was", userId: "u_jesse" }));
      await store.closeSession("qs_over");

      expect(await store.sessionsJoinedBy("u_jesse", 10)).toEqual(["qs_over"]);
    });

    it("honours the limit on the joined listing", async () => {
      for (const id of ["qs_j1", "qs_j2", "qs_j3"]) {
        await store.createSession(session({ id, members: [] }));
        await store.addMember(id, member({ memberId: `m_${id}`, userId: "u_jesse" }));
      }

      expect(await store.sessionsJoinedBy("u_jesse", 2)).toHaveLength(2);
    });

    it("indexes nothing when addMember refuses a frozen session", async () => {
      await store.createSession(session({ id: "qs_cold", members: [] }));
      await store.freezeSession("qs_cold", Date.now());

      expect(await store.addMember("qs_cold", member({ memberId: "m_no", userId: "u_jesse" })))
        .toBe(false);
      expect(await store.sessionsJoinedBy("u_jesse", 10)).toEqual([]);
    });

    it("indexes nothing when addMember refuses an unknown session", async () => {
      expect(await store.addMember("qs_ghost", member({ memberId: "m_no", userId: "u_jesse" })))
        .toBe(false);
      expect(await store.sessionsJoinedBy("u_jesse", 10)).toEqual([]);
    });

    /**
     * The other half of closeSessionIfEmpty. A join that read the room while it
     * was open and writes after it closed would seat a member in a room that is
     * over: the join reports success, and the roster lists someone in a closed
     * room, which is the state the close was written to rule out. So the refusal
     * is the write's own and not only the reader's.
     *
     * There are two ways to refuse in name only, and the assertions below are one
     * each: a seat written and then refused leaves a ghost in the roster, and an
     * index row written before the guard lists the room for a person who was
     * turned away.
     */
    it("indexes nothing when addMember refuses a closed session", async () => {
      await store.createSession(session({ id: "qs_shut", members: [] }));
      await store.closeSession("qs_shut");

      expect(await store.addMember("qs_shut", member({ memberId: "m_no", userId: "u_jesse" })))
        .toBe(false);
      expect((await store.getSession("qs_shut"))?.members).toEqual([]);
      expect(await store.sessionsJoinedBy("u_jesse", 10)).toEqual([]);
    });

    // ---------------------------------------------------------------- events
    it("assigns monotonic cursors starting at 1", async () => {
      const s = session();
      (await store.createSession(s));

      const a = (await store.appendEvent(s.id, {
        type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse",
        fromLabel: "jesse", payload: { text: "one" }, refId: null,
      }));
      const b = (await store.appendEvent(s.id, {
        type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse",
        fromLabel: "jesse", payload: { text: "two" }, refId: null,
      }));

      expect(a!.cursor).toBe(1);
      expect(b!.cursor).toBe(2);
      expect(a!.at).toBe(Date.now());
    });

    it("eventsAfter filters strictly by cursor", async () => {
      const s = session();
      (await store.createSession(s));
      for (const text of ["one", "two", "three"]) {
        (await store.appendEvent(s.id, {
          type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse",
          fromLabel: "jesse", payload: { text }, refId: null,
        }));
      }
      expect((await store.eventsAfter(s.id, 0))).toHaveLength(3);
      expect((await store.eventsAfter(s.id, 2)).map((e) => e.cursor)).toEqual([3]);
      expect((await store.eventsAfter(s.id, 3))).toHaveLength(0);
      expect((await store.eventsAfter("qs_nope", 0))).toEqual([]);
    });

    it("eventAt returns exactly the event at that cursor", async () => {
      const s = session();
      await store.createSession(s);
      const first = await store.appendEvent(s.id, {
        type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse",
        fromLabel: "jesse", payload: { n: 1 }, refId: null,
      });
      const second = await store.appendEvent(s.id, {
        type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse",
        fromLabel: "jesse", payload: { n: 2 }, refId: null,
      });

      expect(await store.eventAt(s.id, first!.cursor)).toEqual(first);
      expect(await store.eventAt(s.id, second!.cursor)).toEqual(second);
    });

    it("eventAt returns undefined for a cursor with no event", async () => {
      const s = session();
      await store.createSession(s);
      const only = await store.appendEvent(s.id, {
        type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse",
        fromLabel: "jesse", payload: { n: 1 }, refId: null,
      });

      expect(await store.eventAt(s.id, only!.cursor + 1)).toBeUndefined();
      expect(await store.eventAt(s.id, 0)).toBeUndefined();
      expect(await store.eventAt(s.id, -1)).toBeUndefined();
    });

    it("eventAt returns undefined for an unknown session", async () => {
      expect(await store.eventAt("qs_nope", 1)).toBeUndefined();
    });

    it("eventAt hands back a detached copy", async () => {
      const s = session();
      await store.createSession(s);
      const e = await store.appendEvent(s.id, {
        type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse",
        fromLabel: "jesse", payload: { n: 1 }, refId: null,
      });

      const got = await store.eventAt(s.id, e!.cursor);
      (got!.payload as Record<string, unknown>).n = 99;
      expect((await store.eventAt(s.id, e!.cursor))!.payload).toEqual({ n: 1 });
    });

    /**
     * bellman_send resolves an action_response's ref_id with eventAt, so this is
     * a room boundary: a lookup that searched every session would let a member
     * answer an action_request from a room they were never in.
     */
    it("eventAt never reaches into another room", async () => {
      const a = session({ id: "qs_a" });
      const b = session({ id: "qs_b" });
      await store.createSession(a);
      await store.createSession(b);
      const inA = await store.appendEvent(a.id, {
        type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse",
        fromLabel: "jesse", payload: { room: "a" }, refId: null,
      });
      const inB = await store.appendEvent(b.id, {
        type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse",
        fromLabel: "jesse", payload: { room: "b" }, refId: null,
      });
      // Same cursor in both rooms — a lookup that ignored the session id
      // would still find something, and would find the wrong thing.
      expect(inA!.cursor).toBe(inB!.cursor);
      expect((await store.eventAt(a.id, inA!.cursor))?.payload).toEqual({ room: "a" });
      expect((await store.eventAt(b.id, inB!.cursor))?.payload).toEqual({ room: "b" });
    });

    it("throws when appending to an unknown session", async () => {
      await expect(
        store.appendEvent("qs_nope", {
          type: "message", fromMemberId: "m", fromUserId: "u",
          fromLabel: "l", payload: {}, refId: null,
        }),
      ).rejects.toThrow();
    });

    // ------------------------------------------------- idempotent appends
    const keyed = (over: Record<string, unknown> = {}) => ({
      type: "message" as const, fromMemberId: "m_creator", fromUserId: "u_jesse",
      fromLabel: "jesse", payload: { text: "once" }, refId: null, ...over,
    });

    it("appends the first time it sees a key", async () => {
      const s = session();
      (await store.createSession(s));

      const write = await store.appendEventOnce(s.id, keyed(), "send-0001");

      expect(write.outcome).toBe("appended");
      expect(write.outcome === "appended" && write.event.cursor).toBe(1);
      expect((await store.eventsAfter(s.id, 0))).toHaveLength(1);
    });

    /** The whole point: a retry is a no-op that returns the original. */
    it("replays the original event for a repeated key, appending nothing", async () => {
      const s = session();
      (await store.createSession(s));

      const first = await store.appendEventOnce(s.id, keyed(), "send-0001");
      const again = await store.appendEventOnce(s.id, keyed(), "send-0001");

      if (first.outcome !== "appended") throw new Error(`first send said ${first.outcome}`);
      if (again.outcome !== "replayed") throw new Error(`retry said ${again.outcome}`);
      expect(again.event.cursor).toBe(first.event.cursor);
      expect(again.event).toEqual(first.event);
      expect((await store.eventsAfter(s.id, 0))).toHaveLength(1);
    });

    /**
     * A key reused for different content is a client bug. Returning the stored
     * event would tell the caller message B was delivered when A was.
     */
    it("refuses a key reused for different content, and appends nothing", async () => {
      const s = session();
      (await store.createSession(s));
      (await store.appendEventOnce(s.id, keyed(), "send-0001"));

      const clash = await store.appendEventOnce(
        s.id, keyed({ payload: { text: "different" } }), "send-0001",
      );

      expect(clash.outcome).toBe("conflict");
      expect((await store.eventsAfter(s.id, 0))).toHaveLength(1);
    });

    /** Object key order is not different content. */
    it("treats a reordered payload as the same send", async () => {
      const s = session();
      (await store.createSession(s));
      (await store.appendEventOnce(s.id, keyed({ payload: { a: 1, b: 2 } }), "send-0001"));

      const retry = await store.appendEventOnce(
        s.id, keyed({ payload: { b: 2, a: 1 } }), "send-0001",
      );

      expect(retry.outcome).toBe("replayed");
    });

    /**
     * Clients pick keys with no coordination between them. A shared namespace
     * makes two peers that both count from 1 collide on their first message,
     * and the failure presents as a lost message rather than as an error.
     */
    it("namespaces keys per member", async () => {
      const s = session();
      (await store.createSession(s));

      const mine = await store.appendEventOnce(s.id, keyed(), "send-0001");
      const theirs = await store.appendEventOnce(
        s.id, keyed({ fromMemberId: "m_joiner", payload: { text: "mine" } }), "send-0001",
      );

      expect(mine.outcome).toBe("appended");
      expect(theirs.outcome).toBe("appended");
      expect((await store.eventsAfter(s.id, 0))).toHaveLength(2);
    });

    /**
     * A write that already succeeded keeps reporting its result even if the
     * room froze afterwards. The replay appends nothing, so nothing new enters
     * a frozen room — and a retry across a freeze can otherwise never learn
     * that its first attempt landed, which is why it is retrying.
     */
    it("still replays a successful write after the session freezes", async () => {
      const s = session();
      (await store.createSession(s));
      (await store.appendEventOnce(s.id, keyed(), "send-0001"));
      (await store.freezeSession(s.id, Date.now()));

      const retry = await store.appendEventOnce(s.id, keyed(), "send-0001");

      expect(retry.outcome).toBe("replayed");
      expect(retry.outcome === "replayed" && retry.event.cursor).toBe(1);
      expect((await store.eventsAfter(s.id, 0))).toHaveLength(1);
    });

    it("refuses a fresh key while frozen", async () => {
      const s = session();
      (await store.createSession(s));
      (await store.freezeSession(s.id, Date.now()));

      expect((await store.appendEventOnce(s.id, keyed(), "send-0001")).outcome).toBe("frozen");
      expect((await store.eventsAfter(s.id, 0))).toHaveLength(0);
    });

    /** Conflict outranks frozen: a client bug should say so, not be masked. */
    it("reports a reused key as a conflict even while frozen", async () => {
      const s = session();
      (await store.createSession(s));
      (await store.appendEventOnce(s.id, keyed(), "send-0001"));
      (await store.freezeSession(s.id, Date.now()));

      const clash = await store.appendEventOnce(
        s.id, keyed({ payload: { text: "different" } }), "send-0001",
      );

      expect(clash.outcome).toBe("conflict");
    });

    it("throws when appending to an unknown session, as appendEvent does", async () => {
      await expect(
        store.appendEventOnce("qs_nope", keyed(), "send-0001"),
      ).rejects.toThrow();
    });

    /**
     * REVIEW FOCUS 1: the race the private append primitive exists to prevent.
     * Both calls are issued before either is awaited, so an implementation
     * that yields between reading the key and writing the event appends twice.
     * Every other test here awaits in between and would pass regardless.
     *
     * Under vitest-pool-workers this case is reliable only because SessionDO makes
     * the append one transaction, the read of the cursor included. Two plain reads
     * and puts started together took the same cursor there in about 1% of rounds
     * (#120), both reporting `appended`. worker-tests/session-append-race.test.ts
     * holds the first call between its read of the cursor and its write to pin the
     * transaction itself.
     */
    it("appends once when two calls with the same key race", async () => {
      const s = session();
      (await store.createSession(s));

      const [a, b] = await Promise.all([
        store.appendEventOnce(s.id, keyed(), "send-0001"),
        store.appendEventOnce(s.id, keyed(), "send-0001"),
      ]);

      const outcomes = [a.outcome, b.outcome].sort();
      expect(outcomes).toEqual(["appended", "replayed"]);
      expect((await store.eventsAfter(s.id, 0))).toHaveLength(1);
    });

    /** INVARIANT 5 again: the replayed event must not be stored state. */
    it("hands back a detached event on replay", async () => {
      const s = session();
      (await store.createSession(s));
      (await store.appendEventOnce(s.id, keyed(), "send-0001"));

      const retry = await store.appendEventOnce(s.id, keyed(), "send-0001");
      if (retry.outcome === "replayed") retry.event.cursor = 999;

      expect((await store.eventsAfter(s.id, 0))[0].cursor).toBe(1);
    });

    /** D7: the key is an index, not content. It must not reach the peer. */
    it("does not write the key onto the event", async () => {
      const s = session();
      (await store.createSession(s));
      (await store.appendEventOnce(s.id, keyed(), "send-0001"));

      const [event] = await store.eventsAfter(s.id, 0);
      expect(JSON.stringify(event)).not.toContain("send-0001");
    });

    /**
     * A payload too deep to fingerprint must leave nothing behind, and must say so
     * as the class it is.
     *
     * `fingerprint` throws, and `appendEventOnce` calls it before it mutates
     * anything, so the throw has to reach the caller with no event appended and
     * no key recorded. A store that wrote first and fingerprinted second would
     * satisfy every other case in this block.
     *
     * `toThrow(PayloadTooDeepError)` is an `instanceof`, and that is the second half
     * of the case rather than incidental to it. Under Durable Objects the throw
     * crosses an RPC boundary, where workerd rebuilds it without its prototype — so
     * this was the suite's one divergence until #101, and it is the assertion that
     * holds `src/rpc-error.ts` in place. A store that reported the right message with
     * the wrong class would pass a `toThrow(/nests deeper/)` written instead.
     */
    it(
      "throws on a payload too deep to fingerprint, and writes nothing",
      async () => {
        const s = session();
        (await store.createSession(s));

        let deep: unknown = { leaf: true };
        for (let i = 0; i <= MAX_PAYLOAD_DEPTH; i++) deep = { a: deep };

        await expect(
          store.appendEventOnce(s.id, keyed({ payload: deep }), "send-0001"),
        ).rejects.toThrow(PayloadTooDeepError);

        expect((await store.eventsAfter(s.id, 0))).toHaveLength(0);

        // The key must also be free afterwards. If the failed call had recorded
        // it, this would come back "replayed" or "conflict" rather than a fresh
        // append — a key burned by a write that never happened.
        const after = await store.appendEventOnce(s.id, keyed(), "send-0001");
        expect(after.outcome).toBe("appended");
      },
    );

    // --------------------------------------------- the sender's report stamp
    /**
     * A `progress` send leaves two facts behind — the event, and the sending
     * member's own `lastReportAt` — and losing the second leaves that member
     * named silent for having answered.
     *
     * `bellman_send` used to patch the stamp with a second `updateMember` call
     * after the append returned. Under Durable Objects those are two RPCs into
     * two transactions, and `appendEvent` wakes listeners BEFORE the second one
     * runs: a due alarm could read the committed progress event while the stale
     * stamp still marked that member silent. So the credit is an argument to the
     * append rather than a call after it, and the stamp rides in the event's own
     * transaction.
     *
     * **These cases do not claim to prove the atomicity**, which is not
     * observable from outside the store — MemoryStore has no gap to open and no
     * way to show one, and the two-write hazard lives inside `SessionDO`'s
     * transaction. What they pin is everything a caller CAN see, which is what
     * has to be identical across implementations: the stamp lands, a replay
     * lands it too, it never moves backwards, and an append not asked to credit
     * moves nothing.
     */
    describe("crediting the sender's report", () => {
      const reported = (over: Record<string, unknown> = {}) => ({
        type: "progress" as const, fromMemberId: "m_creator", fromUserId: "u_jesse",
        fromLabel: "jesse", payload: { note: "on the migration" }, refId: null, ...over,
      });
      const stampOf = async (id: string) =>
        (await store.getSession(id))!.members
          .find((m) => m.memberId === "m_creator")!.lastReportAt;
      const unstamped = () => session({ members: [member({ lastReportAt: undefined })] });

      /**
       * The room's most recent action_request, which is what lets bellman_sync
       * decide whether reading the log is worth it at all (#81). Both stores
       * have to agree, or the Durable Object answers "nothing outstanding" for
       * a room MemoryStore reports requests in.
       */
      describe("the action request stamp", () => {
        const asked = () => ({
          type: "action_request" as const,
          fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd",
          payload: { ask: "deploy" }, refId: null,
        });
        const stamped = async (id: string) =>
          (await store.getSession(id))! as { lastActionRequestAt?: number };

        it("is absent until an append asks for it", async () => {
          const s = session({});
          (await store.createSession(s));
          (await store.appendEvent(s.id, asked()));

          expect((await stamped(s.id)).lastActionRequestAt).toBeUndefined();
        });

        it("records the event's own time when asked", async () => {
          const s = session({});
          (await store.createSession(s));

          const event = (await store.appendEvent(s.id, asked(), { stampActionRequest: true }))!;

          expect((await stamped(s.id)).lastActionRequestAt).toBe(event.at);
        });

        it("only ever moves forward", async () => {
          // A replay re-asserts the stamp, as creditReport does, and must not be
          // able to pull it back — an older value would hide a live request from
          // the poll, which is the one failure this field can cause.
          const s = session({});
          (await store.createSession(s));
          const first = (await store.appendEvent(s.id, asked(), { stampActionRequest: true }))!;
          const second = (await store.appendEvent(s.id, asked(), { stampActionRequest: true }))!;

          expect(second.at).toBeGreaterThanOrEqual(first.at);
          expect((await stamped(s.id)).lastActionRequestAt).toBe(second.at);
        });
      });

      it("stamps the sender at the event's own time", async () => {
        const s = unstamped();
        (await store.createSession(s));

        const event = (await store.appendEvent(s.id, reported(), { creditReport: true }))!;

        expect(await stampOf(s.id)).toBe(event.at);
      });

      /** Type-agnostic: the store credits what it is ASKED to, never what it reads. */
      it("leaves the stamp alone when the append does not ask for it", async () => {
        const s = unstamped();
        (await store.createSession(s));

        (await store.appendEvent(s.id, reported()));

        expect(await stampOf(s.id)).toBeUndefined();
      });

      /**
       * A replay re-asserts the stamp; it is not a no-op for it. The old code
       * patched inside `if (!replayed)`, so a retry skipped the credit outright
       * and a stamp the first attempt never landed was lost for good rather than
       * merely late.
       *
       * The `updateMember` below stands in for however the stamp came to be
       * behind — a row written by a build that patched separately, or any
       * out-of-order write. What the case pins is the promise: after a credited
       * append, a credited replay of the same key says the same thing about the
       * sender as the append did.
       */
      it("credits a replayed key too, so a retry repairs a stamp left behind", async () => {
        const s = unstamped();
        (await store.createSession(s));

        const first = await store.appendEventOnce(
          s.id, reported(), "p-0001", { creditReport: true },
        );
        if (first.outcome !== "appended") throw new Error(`first send said ${first.outcome}`);
        expect(await stampOf(s.id)).toBe(first.event.at);

        (await store.updateMember(s.id, "m_creator", { lastReportAt: first.event.at - 60_000 }));

        const retry = await store.appendEventOnce(
          s.id, reported(), "p-0001", { creditReport: true },
        );

        expect(retry.outcome).toBe("replayed");
        expect(await stampOf(s.id)).toBe(first.event.at);
        // And still one event: the repair is a stamp, not a second append.
        expect((await store.eventsAfter(s.id, 0))).toHaveLength(1);
      });

      /**
       * Monotonic. A replayed or out-of-order credit must not un-credit a LATER
       * report: the member answered at the later time, and moving the stamp back
       * would make the next tick name it silent for a report it had made.
       */
      it("never moves the stamp backwards", async () => {
        const s = unstamped();
        (await store.createSession(s));

        const first = await store.appendEventOnce(
          s.id, reported(), "p-0001", { creditReport: true },
        );
        if (first.outcome !== "appended") throw new Error(`first send said ${first.outcome}`);

        const later = first.event.at + 120_000;
        (await store.updateMember(s.id, "m_creator", { lastReportAt: later }));

        (await store.appendEventOnce(s.id, reported(), "p-0001", { creditReport: true }));

        expect(await stampOf(s.id)).toBe(later);
      });
    });

    // ------------------------------------------ a removed member's cut cursor
    /**
     * An eviction leaves two facts behind — the `member_evicted` event, and the
     * target's own `removedAtCursor`, the cursor its feed is cut at (#113). The
     * second names the first, so they have to commit together: recorded
     * separately, a reader can be refused at a cursor no stored event carries, or
     * admitted past one that is already written.
     *
     * So the cut is an argument to the append, as `creditReport` is, and not a
     * call after it. **These cases do not claim to prove the atomicity**, which
     * is not observable from outside the store. What they pin is what a caller
     * CAN see, and what both stores have to say identically: the member lands out
     * at the event's own cursor, nobody else moves, an unknown member is a
     * no-op, a cut already recorded stays put, a member who already left is not
     * cut, and a refused append records nothing.
     */
    describe("recording a member out at an event's cursor", () => {
      /** A creator and one peer, created in the store. */
      const roomOfTwo = async () => {
        const s = session({
          members: [
            member(),
            member({ memberId: "m_peer", userId: "u_peer", label: "peer@elsewhere" }),
          ],
        });
        await store.createSession(s);
        return s;
      };
      const TARGET = "m_peer";

      /** The eviction announcement, as evictMember writes it. */
      const removal = (memberId: string) => ({
        type: "member_evicted" as const,
        fromMemberId: "system",
        fromUserId: "u_jesse",
        fromLabel: "jesse",
        payload: { member_id: memberId },
        refId: null,
      });

      it("sets leftAt and removedAtCursor together, at the event's own cursor", async () => {
        const s = await roomOfTwo();
        const target = TARGET;

        const event = (await store.appendEvent(s.id, removal(target), {
          markRemoved: target,
        }))!;

        const after = (await store.getSession(s.id))!;
        const m = after.members.find((mm) => mm.memberId === target)!;
        // One write, not two: a store that set only one of these is the bug
        // this rides in the transaction to prevent.
        expect(m.removedAtCursor).toBe(event.cursor);
        expect(m.leftAt).not.toBeNull();
      });

      it("leaves every other member untouched", async () => {
        const s = await roomOfTwo();
        const target = TARGET;
        const other = "m_creator";

        await store.appendEvent(s.id, removal(target), { markRemoved: target });

        const after = (await store.getSession(s.id))!;
        const m = after.members.find((mm) => mm.memberId === other)!;
        expect(m.removedAtCursor).toBeUndefined();
        expect(m.leftAt).toBeNull();
      });

      it("writes nothing for a member the roster does not name", async () => {
        const s = await roomOfTwo();
        const before = (await store.getSession(s.id))!;

        const event = await store.appendEvent(s.id, removal("m_nobody"), {
          markRemoved: "m_nobody",
        });

        // The event still lands. An unknown member is a no-op, not a throw —
        // updateMember's rule, and creditReport's.
        expect(event).not.toBeNull();
        const after = (await store.getSession(s.id))!;
        expect(after.members.map((m) => m.removedAtCursor))
          .toEqual(before.members.map((m) => m.removedAtCursor));
      });

      it("does not move a cut that is already recorded", async () => {
        const s = await roomOfTwo();
        const target = TARGET;
        const first = (await store.appendEvent(s.id, removal(target), {
          markRemoved: target,
        }))!;

        await store.appendEvent(s.id, removal(target), { markRemoved: target });

        const after = (await store.getSession(s.id))!;
        const m = after.members.find((mm) => mm.memberId === target)!;
        // Otherwise a second eviction widens the window the first one closed.
        expect(m.removedAtCursor).toBe(first.cursor);
      });

      /**
       * D6 at the store. `evictMember` returns early for a member who already
       * left, but it reads the roster once and appends later, and a voluntary
       * leave can land in between. `leaveRoom` writes `leftAt` through
       * `updateMember`, which is what stands in for it here, and `removedAtCursor`
       * is not patchable — so that member reaches `markRemoved` with neither of
       * its first two bail-outs clear. Without a third it would be handed a cut
       * and have its own leave time overwritten, and a member who chose to go is
       * the one R2 gives the open feed.
       *
       * `leftAt` is set far from the event's `at`, so a store that rewrote it
       * cannot land on the same value by coincidence.
       */
      it("does not cut a member who already left, and leaves their leftAt alone", async () => {
        const s = await roomOfTwo();
        const target = TARGET;
        const leftAt = 12_345;
        await store.updateMember(s.id, target, { leftAt });

        const event = await store.appendEvent(s.id, removal(target), {
          markRemoved: target,
        });

        // The announcement still lands, as it does for an unknown member: the
        // rule declines to write the member, and nothing about the append.
        expect(event).not.toBeNull();
        const after = (await store.getSession(s.id))!;
        const m = after.members.find((mm) => mm.memberId === target)!;
        expect(m.removedAtCursor).toBeUndefined();
        expect(m.leftAt).toBe(leftAt);
      });

      it("records nothing when the room is frozen and the append is refused", async () => {
        const s = await roomOfTwo();
        const target = TARGET;
        await store.freezeSession(s.id, Date.now());

        const event = await store.appendEvent(s.id, removal(target), {
          markRemoved: target,
        });

        // The two go together or the design's atomicity claim is false.
        expect(event).toBeNull();
        const after = (await store.getSession(s.id))!;
        const m = after.members.find((mm) => mm.memberId === target)!;
        expect(m.removedAtCursor).toBeUndefined();
        expect(m.leftAt).toBeNull();
      });

      it("records the member out on a keyed append too", async () => {
        const s = await roomOfTwo();
        const target = TARGET;

        const write = await store.appendEventOnce(
          s.id, removal(target), "evict-0001", { markRemoved: target },
        );

        expect(write.outcome).toBe("appended");
        const after = (await store.getSession(s.id))!;
        const m = after.members.find((mm) => mm.memberId === target)!;
        expect(m.removedAtCursor).toBe(write.outcome === "appended" ? write.event.cursor : -1);
      });

      /**
       * A replay re-asserts the cut, at the ORIGINAL event's cursor. The first
       * attempt below asks for no cut, which stands in for however the cut came
       * to be missing — an attempt interrupted before it landed, or a row written
       * by a build that did not have the field. What the case pins is where the
       * retry puts it: on the event the key names, and not on a cursor the retry
       * has no event at. A replay that dropped its extras would leave the member
       * in the room.
       */
      it("records the member out on a replay, at the original event's cursor", async () => {
        const s = await roomOfTwo();
        const target = TARGET;
        const first = await store.appendEventOnce(s.id, removal(target), "evict-0001");
        if (first.outcome !== "appended") throw new Error(`first append said ${first.outcome}`);

        const retry = await store.appendEventOnce(
          s.id, removal(target), "evict-0001", { markRemoved: target },
        );

        expect(retry.outcome).toBe("replayed");
        const after = (await store.getSession(s.id))!;
        const m = after.members.find((mm) => mm.memberId === target)!;
        expect(m.removedAtCursor).toBe(first.event.cursor);
        expect(m.leftAt).not.toBeNull();
        // And still one event: the repair is a cut, not a second append.
        expect((await store.eventsAfter(s.id, 0))).toHaveLength(1);
      });

      /**
       * Both rules rewrite the same member array, so an append that asks for both
       * is where applying them as two writes would lose one. No handler asks for
       * both today — a `progress` send credits its sender, and an eviction names
       * its target — which is why nothing else exercises the pair. The sender here
       * is a real member, so the credit has somewhere to land.
       */
      it("applies a report credit and a removal from one append", async () => {
        const s = await roomOfTwo();
        const target = TARGET;

        const event = (await store.appendEvent(
          s.id,
          { ...removal(target), fromMemberId: "m_creator" },
          { creditReport: true, markRemoved: target },
        ))!;

        const after = (await store.getSession(s.id))!;
        const sender = after.members.find((mm) => mm.memberId === "m_creator")!;
        const removed = after.members.find((mm) => mm.memberId === target)!;
        expect(sender.lastReportAt).toBe(event.at);
        expect(removed.removedAtCursor).toBe(event.cursor);
        expect(removed.leftAt).not.toBeNull();
      });
    });

    // ------------------------------------------------------------- long-poll
    it("waitForEvents returns immediately when events already exist", async () => {
      const s = session();
      (await store.createSession(s));
      (await store.appendEvent(s.id, {
        type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse",
        fromLabel: "jesse", payload: { text: "hi" }, refId: null,
      }));

      await expect(store.waitForEvents(s.id, 0, 10_000)).resolves.toHaveLength(1);
    });

    it("waitForEvents resolves early when an event arrives", async () => {
      const s = session();
      (await store.createSession(s));

      const pending = store.waitForEvents(s.id, 0, 20_000);
      let settled = false;
      void pending.then(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(500);
      expect(settled).toBe(false);

      (await store.appendEvent(s.id, {
        type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse",
        fromLabel: "jesse", payload: { text: "late" }, refId: null,
      }));

      await expect(pending).resolves.toHaveLength(1);
    });

    /**
     * The only case here that needs the store's OWN timer to fire rather than
     * just the clock to move: nothing appends, so elapsing the wait is the only
     * thing that can resolve it.
     *
     * That rules out a fake clock. vi's fake timers patch THIS realm's globals,
     * and SessionDO.waitForEvents schedules its setTimeout inside the Durable
     * Object, where they do not reach — a faked 5s advance leaves the long-poll
     * running for real until the test times out. (Note the split: fake timers
     * DO move `Date.now()` inside a Durable Object, which is why every TTL case
     * above works. It is the callback queue that is not shared.)
     *
     * So this one waits for real, briefly. Real timers cost this case its ~50ms
     * for both stores, which buys an assertion that holds for each of them
     * without an exclusion.
     */
    it("waitForEvents resolves empty after the wait elapses", async () => {
      vi.useRealTimers();
      const s = session();
      (await store.createSession(s));

      await expect(store.waitForEvents(s.id, 0, 50)).resolves.toEqual([]);
    });

    it("waitForEvents returns synchronously for a zero wait", async () => {
      const s = session();
      (await store.createSession(s));
      await expect(store.waitForEvents(s.id, 0, 0)).resolves.toEqual([]);
    });

    it("wakes every waiter on a session, each from its own cursor", async () => {
      const s = session();
      (await store.createSession(s));
      (await store.appendEvent(s.id, {
        type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse",
        fromLabel: "jesse", payload: { text: "first" }, refId: null,
      }));

      const fromZero = store.waitForEvents(s.id, 1, 20_000);
      const alsoFromZero = store.waitForEvents(s.id, 1, 20_000);

      (await store.appendEvent(s.id, {
        type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse",
        fromLabel: "jesse", payload: { text: "second" }, refId: null,
      }));

      expect((await fromZero).map((e) => e.cursor)).toEqual([2]);
      expect((await alsoFromZero).map((e) => e.cursor)).toEqual([2]);
    });

    // ------------------------------------------------------- pending connects
    /** INVARIANT 2: connect tokens are single-use with their own TTL. */
    it("issues a new join code and retires the old one", async () => {
      const a = session({ joinCodes: oneCode("BELL-AAAA-01") });
      (await store.createSession(a));

      (await store.setJoinCode(a.id, "peer_b", "BELL-BBBB-02", Date.now() + JOIN_CODE_TTL));

      expect(await store.getSessionByJoinCode("BELL-AAAA-01")).toBeUndefined();
      expect((await store.getSessionByJoinCode("BELL-BBBB-02"))?.session.id).toBe(a.id);
      expect((await store.getSession(a.id))?.joinCodes["peer_b"].code).toBe("BELL-BBBB-02");
    });

    it("issues a code after the previous one was consumed", async () => {
      const a = session({ joinCodes: oneCode("BELL-AAAA-01") });
      (await store.createSession(a));
      (await store.consumeJoinCode(a.id, "peer_b"));

      (await store.setJoinCode(a.id, "peer_b", "BELL-CCCC-03", Date.now() + JOIN_CODE_TTL));

      expect((await store.getSessionByJoinCode("BELL-CCCC-03"))?.session.id).toBe(a.id);
    });

    // ----------------------------------------------------------- plan grants
    it("round-trips a grant and deletes it", async () => {
      const grant = {
        key: "github:4242", plan: "team" as const, role: "admin" as const,
        orgId: "org_example", source: "purchase", grantedAt: Date.now(),
        grantedBy: "stripe", expiresAt: null,
      };
      (await store.putGrant(grant));

      expect(await store.getGrant("github:4242")).toMatchObject({ plan: "team", orgId: "org_example" });
      expect(await store.getGrant("github:nobody")).toBeUndefined();

      (await store.deleteGrant("github:4242"));
      expect(await store.getGrant("github:4242")).toBeUndefined();
    });

    /** A lapsed subscription must stop granting, without anyone sweeping it. */
    it("stops honouring a grant once it has expired", async () => {
      (await store.putGrant({
        key: "google:lapsed", plan: "pro" as const, role: "member" as const,
        orgId: null, source: "purchase", grantedAt: Date.now() - 1000,
        grantedBy: "stripe", expiresAt: Date.now() - 1,
      }));

      expect(await store.getGrant("google:lapsed")).toBeUndefined();
    });

    it("does not list a grant that has expired", async () => {
      (await store.putGrant({
        key: "github:lapsed", plan: "pro" as const, role: "member" as const, orgId: "org_mine",
        source: "purchase", grantedAt: Date.now() - 1000, grantedBy: "stripe", expiresAt: Date.now() - 1,
      }));
      (await store.putGrant({
        key: "github:live", plan: "pro" as const, role: "member" as const, orgId: "org_mine",
        source: "purchase", grantedAt: Date.now(), grantedBy: "stripe", expiresAt: null,
      }));

      expect((await store.listGrants(50, "org_mine")).map((g) => g.key)).toEqual(["github:live"]);
    });

    it("lists grants scoped to one org", async () => {
      (await store.putGrant({
        key: "github:mine", plan: "team" as const, role: "member" as const, orgId: "org_mine",
        source: "purchase", grantedAt: Date.now(), grantedBy: "stripe", expiresAt: null,
      }));
      (await store.putGrant({
        key: "github:theirs", plan: "team" as const, role: "member" as const, orgId: "org_theirs",
        source: "purchase", grantedAt: Date.now(), grantedBy: "stripe", expiresAt: null,
      }));

      expect((await store.listGrants(50, "org_mine")).map((g) => g.key)).toEqual(["github:mine"]);
      expect((await store.listGrants(50)).length).toBe(2);
    });

    /**
     * The invariant an org-scoped secondary index can break: move a key to
     * another org and the copy filed under the old one has to go with it, or
     * the previous org keeps listing a customer it no longer has. MemoryStore
     * passes this by construction; a store that indexes by org passes it only
     * if every write retires the old entry.
     */
    it("stops listing a grant under the org it was moved out of", async () => {
      const base = {
        key: "github:moved", plan: "team" as const, role: "member" as const,
        source: "purchase", grantedAt: Date.now(), grantedBy: "stripe", expiresAt: null,
      };
      (await store.putGrant({ ...base, orgId: "org_before" }));
      (await store.putGrant({ ...base, orgId: "org_after" }));

      expect((await store.listGrants(50, "org_before")).map((g) => g.key)).toEqual([]);
      expect((await store.listGrants(50, "org_after")).map((g) => g.key)).toEqual(["github:moved"]);
      expect(await store.getGrant("github:moved")).toMatchObject({ orgId: "org_after" });
    });

    /** Deleting has to clear every copy too, by the same argument. */
    it("stops listing a grant once it is deleted", async () => {
      (await store.putGrant({
        key: "github:gone", plan: "pro" as const, role: "member" as const, orgId: "org_mine",
        source: "purchase", grantedAt: Date.now(), grantedBy: "stripe", expiresAt: null,
      }));
      (await store.deleteGrant("github:gone"));

      expect((await store.listGrants(50, "org_mine")).map((g) => g.key)).toEqual([]);
      expect((await store.listGrants(50)).map((g) => g.key)).toEqual([]);
    });

    /**
     * A store that applies the limit before dropping expired records answers
     * "no grants" here, because the whole first window is lapsed — and the
     * endpoint offers no pagination, so the caller has no way to learn
     * otherwise. Scanning must continue past them.
     */
    it("finds a live grant hiding behind a window of expired ones", async () => {
      for (let i = 0; i < 5; i++) {
        (await store.putGrant({
          key: `github:${i}`, plan: "pro" as const, role: "member" as const, orgId: "org_mine",
          source: "purchase", grantedAt: Date.now() - 1000, grantedBy: "stripe",
          expiresAt: Date.now() - 1,
        }));
      }
      (await store.putGrant({
        key: "github:zlive", plan: "pro" as const, role: "member" as const, orgId: "org_mine",
        source: "purchase", grantedAt: Date.now(), grantedBy: "stripe", expiresAt: null,
      }));

      expect((await store.listGrants(2, "org_mine")).map((g) => g.key)).toEqual(["github:zlive"]);
    });

    /**
     * Claiming an address-keyed grant onto a subject. It has to be one
     * operation: a write followed by a failed delete would leave the address
     * key standing and claimable by whoever holds that address next.
     */
    it("moves a grant to a new key, leaving nothing behind", async () => {
      (await store.putGrant({
        key: "email:jesse@example.dev", plan: "pro" as const, role: "member" as const,
        orgId: "org_mine", source: "purchase", grantedAt: Date.now(), grantedBy: "stripe",
        expiresAt: null,
      }));

      (await store.moveGrant("email:jesse@example.dev", "github:4242"));

      expect(await store.getGrant("email:jesse@example.dev")).toBeUndefined();
      expect(await store.getGrant("github:4242")).toMatchObject({ key: "github:4242", plan: "pro" });
      expect((await store.listGrants(50, "org_mine")).map((g) => g.key)).toEqual(["github:4242"]);
    });

    it("moving a key that has no grant changes nothing", async () => {
      await expect(store.moveGrant("github:nobody", "github:4242")).resolves.not.toThrow();
      expect(await store.getGrant("github:4242")).toBeUndefined();
    });

    /** The destination's own index copy has to go, or it outlives its record. */
    it("does not leave the displaced grant listed when a move overwrites it", async () => {
      const base = {
        plan: "pro" as const, role: "member" as const, source: "purchase",
        grantedAt: Date.now(), grantedBy: "stripe", expiresAt: null,
      };
      (await store.putGrant({ ...base, key: "email:a@b.test", orgId: "org_mine" }));
      (await store.putGrant({ ...base, key: "github:4242", orgId: "org_other" }));

      (await store.moveGrant("email:a@b.test", "github:4242"));

      expect((await store.listGrants(50, "org_other")).map((g) => g.key)).toEqual([]);
      expect((await store.listGrants(50, "org_mine")).map((g) => g.key)).toEqual(["github:4242"]);
    });

    /**
     * Ownership and the write are one operation. Two calls give the store a
     * window to serve another org's write for the same key in between, and the
     * guard that is supposed to stop cross-org clobbering misses it.
     */
    it("refuses to write over a grant held by another org", async () => {
      const base = {
        key: "github:4242", plan: "pro" as const, role: "member" as const,
        source: "purchase", grantedAt: Date.now(), grantedBy: "stripe", expiresAt: null,
      };
      (await store.putGrant({ ...base, orgId: "org_theirs" }));

      expect(await store.putGrantIfOwned({ ...base, orgId: "org_mine" }, "org_mine", { actorUserId: "u_test" }))
        .toBe("conflict");
      expect(await store.getGrant("github:4242")).toMatchObject({ orgId: "org_theirs" });
    });

    it("writes when the key is unowned, or already the caller's", async () => {
      const base = {
        key: "github:4242", plan: "pro" as const, role: "member" as const, orgId: "org_mine",
        source: "purchase", grantedAt: Date.now(), grantedBy: "stripe", expiresAt: null,
      };

      expect(await store.putGrantIfOwned(base, "org_mine", { actorUserId: "u_test" })).toBe("written");
      expect(await store.putGrantIfOwned({ ...base, plan: "team" }, "org_mine", { actorUserId: "u_test" })).toBe("written");
      expect(await store.getGrant("github:4242")).toMatchObject({ plan: "team" });
    });

    /**
     * "missing" and "conflict" have to be distinguishable, or the caller
     * audits a revocation that did not happen and answers 200 for it.
     */
    it("says what a guarded delete actually did", async () => {
      (await store.putGrant({
        key: "github:4242", plan: "pro" as const, role: "member" as const, orgId: "org_theirs",
        source: "purchase", grantedAt: Date.now(), grantedBy: "stripe", expiresAt: null,
      }));

      expect(await store.deleteGrantIfOwned("github:nobody", "org_mine", { actorUserId: "u_test" })).toBe("missing");
      expect(await store.deleteGrantIfOwned("github:4242", "org_mine", { actorUserId: "u_test" })).toBe("conflict");
      expect(await store.getGrant("github:4242")).toBeDefined();

      expect(await store.deleteGrantIfOwned("github:4242", "org_theirs", { actorUserId: "u_test" })).toBe("deleted");
      expect(await store.getGrant("github:4242")).toBeUndefined();
      expect((await store.listGrants(50, "org_theirs")).map((g) => g.key)).toEqual([]);
    });

    /**
     * Every other read defines a lapsed grant as absent. If the ownership check
     * reads past that, a dead record from an org that has since churned holds
     * the key hostage: every attempt from the new org is a 403 until some
     * unrelated read happens to sweep it.
     */
    it("treats a lapsed grant as unowned when guarding a write", async () => {
      (await store.putGrant({
        key: "github:4242", plan: "team" as const, role: "member" as const, orgId: "org_theirs",
        source: "purchase", grantedAt: Date.now() - 1000, grantedBy: "stripe",
        expiresAt: Date.now() - 1,
      }));

      expect(await store.putGrantIfOwned({
        key: "github:4242", plan: "pro" as const, role: "member" as const, orgId: "org_mine",
        source: "purchase", grantedAt: Date.now(), grantedBy: "stripe", expiresAt: null,
      }, "org_mine", { actorUserId: "u_test" })).toBe("written");

      expect(await store.getGrant("github:4242")).toMatchObject({ orgId: "org_mine" });
      expect((await store.listGrants(50, "org_theirs")).map((g) => g.key)).toEqual([]);
      expect((await store.listGrants(50, "org_mine")).map((g) => g.key)).toEqual(["github:4242"]);
    });

    /** And a guarded delete reports it as gone, not as somebody else's. */
    it("reports a lapsed grant as missing rather than a conflict", async () => {
      (await store.putGrant({
        key: "github:4242", plan: "team" as const, role: "member" as const, orgId: "org_theirs",
        source: "purchase", grantedAt: Date.now() - 1000, grantedBy: "stripe",
        expiresAt: Date.now() - 1,
      }));

      expect(await store.deleteGrantIfOwned("github:4242", "org_mine", { actorUserId: "u_test" })).toBe("missing");
    });

    /**
     * The second writer. An admin claims a key by org; billing claims one by
     * having written it. A subscription lapsing must not revoke a plan an
     * operator granted by hand, and a hand grant must not be silently replaced
     * by a purchase either.
     */
    it("will not let billing overwrite a grant it did not write", async () => {
      const base = {
        key: "github:4242", plan: "pro" as const, role: "member" as const, orgId: null,
        grantedAt: Date.now(), grantedBy: "u_admin", expiresAt: null,
      };
      (await store.putGrant({ ...base, source: "operator" }));

      expect((await store.putGrantIfSource({ ...base, plan: "team", source: "purchase" }, "purchase", { actorUserId: "u_test" })).outcome)
        .toBe("conflict");
      expect((await store.deleteGrantIfSource("github:4242", "purchase", { actorUserId: "u_test" })).outcome).toBe("conflict");
      expect(await store.getGrant("github:4242")).toMatchObject({ plan: "pro", source: "operator" });
    });

    it("lets billing write, update and remove its own grant", async () => {
      const purchase = {
        key: "github:4242", plan: "pro" as const, role: "member" as const, orgId: null,
        source: "purchase", grantedAt: Date.now(), grantedBy: "stripe", expiresAt: null,
      };

      expect(await store.putGrantIfSource(purchase, "purchase", { actorUserId: "u_test" }))
        .toEqual({ outcome: "written", previous: undefined });

      // The write reports what it replaced. Nothing in production reads this
      // (see GrantWrite), so this is the only thing keeping the two stores
      // reporting the same thing.
      const updated = await store.putGrantIfSource({ ...purchase, plan: "team" }, "purchase", { actorUserId: "u_test" });
      expect(updated.outcome).toBe("written");
      expect(updated.previous).toMatchObject({ plan: "pro" });
      expect(await store.getGrant("github:4242")).toMatchObject({ plan: "team" });

      const gone = await store.deleteGrantIfSource("github:4242", "purchase", { actorUserId: "u_test" });
      expect(gone.outcome).toBe("deleted");
      expect(gone.removed).toMatchObject({ plan: "team" });
      expect((await store.deleteGrantIfSource("github:4242", "purchase", { actorUserId: "u_test" })).outcome).toBe("missing");
      expect((await store.listGrants(50, null)).map((g) => g.key)).toEqual([]);
    });

    /**
     * A guarded write is one operation, not a read followed by a write. Run two
     * of them at once and whichever goes second must see what the first did —
     * otherwise the second acts on a record that is no longer there, and the
     * guard it just passed was against the wrong value.
     *
     * The Durable Object gets this from `storage.transaction`. An in-memory
     * store gets it by not yielding between the check and the mutation, which
     * is easy to lose the moment someone awaits the read.
     */
    it("does not let two guarded writes interleave mid-check", async () => {
      const base = {
        key: "github:4242", plan: "pro" as const, role: "member" as const, orgId: "org_mine",
        grantedAt: Date.now(), grantedBy: "stripe", expiresAt: null,
      };
      (await store.putGrant({ ...base, source: "purchase" }));

      // An admin replaces the purchase by hand while billing tries to remove
      // it. In this order a store that reads before yielding will let the
      // delete run against the record the put already replaced.
      const [put] = await Promise.all([
        store.putGrantIfOwned({ ...base, plan: "team", source: "operator" }, "org_mine", { actorUserId: "u_test" }),
        store.deleteGrantIfSource("github:4242", "purchase", { actorUserId: "u_test" }),
      ]);

      // Either order of completion is fine. What must not happen is the delete
      // removing a hand grant whose source it never checked.
      if (put === "written") {
        expect(await store.getGrant("github:4242")).toMatchObject({ source: "operator" });
      }
    });

    /**
     * A grant change and the record of it are one operation. Every caller used
     * to write the grant and then audit it, and losing the second write lost the
     * record permanently — the retry returns "missing" and cannot tell that the
     * change already happened.
     */
    it("records a guarded grant write in the affected org", async () => {
      const grant = {
        key: "github:4242", plan: "team" as const, role: "admin" as const, orgId: "org_mine",
        source: "operator", grantedAt: Date.now(), grantedBy: "u_admin", expiresAt: null,
      };

      expect(await store.putGrantIfOwned(grant, "org_mine", { actorUserId: "u_admin" }))
        .toBe("written");

      expect((await store.auditForOrg("org_mine", 10)).map((e) => [e.action, e.actorUserId]))
        .toEqual([["plan_granted", "u_admin"]]);
    });

    it("records nothing when a guarded write changes nothing a reader sees", async () => {
      const grant = {
        key: "github:4242", plan: "team" as const, role: "admin" as const, orgId: "org_mine",
        source: "operator", grantedAt: Date.now(), grantedBy: "u_admin", expiresAt: null,
      };
      await store.putGrantIfOwned(grant, "org_mine", { actorUserId: "u_admin" });
      await store.putGrantIfOwned(
        { ...grant, grantedAt: Date.now() + 10 }, "org_mine", { actorUserId: "u_admin" }
      );

      // Exactly one, and it is the first: a length check alone would also pass
      // against a store that recorded nothing at all.
      expect((await store.auditForOrg("org_mine", 10)).map((e) => e.action))
        .toEqual(["plan_granted"]);
    });

    it("records a revocation against the org the grant was in", async () => {
      await store.putGrant({
        key: "github:4242", plan: "team" as const, role: "admin" as const, orgId: "org_mine",
        source: "operator", grantedAt: Date.now(), grantedBy: "u_admin", expiresAt: null,
      });

      expect(await store.deleteGrantIfOwned("github:4242", "org_mine",
        { actorUserId: "u_admin", detail: { reason: "left the team" } })).toBe("deleted");

      const [entry] = await store.auditForOrg("org_mine", 10);
      expect(entry).toMatchObject({
        action: "plan_revoked", actorUserId: "u_admin",
        detail: { key: "github:4242", plan: "team", reason: "left the team" },
      });
    });

    /**
     * The grant is re-homed rather than deleted, so without this the org it left
     * would never hear that it lost an admin. A team subscription ending while a
     * pro one continues does exactly this.
     */
    it("records both halves when a grant moves between orgs", async () => {
      const base = {
        key: "github:4242", plan: "team" as const, role: "admin" as const,
        source: "purchase", grantedAt: Date.now(), grantedBy: "stripe", expiresAt: null,
      };
      await store.putGrantIfSource({ ...base, orgId: "org_old" }, "purchase",
        { actorUserId: "stripe" });
      await store.putGrantIfSource({ ...base, orgId: "org_new" }, "purchase",
        { actorUserId: "stripe" });

      expect((await store.auditForOrg("org_old", 10)).map((e) => e.action))
        .toEqual(["plan_granted", "plan_revoked"]);
      expect((await store.auditForOrg("org_new", 10)).map((e) => e.action))
        .toEqual(["plan_granted"]);
    });

    it("records nothing for a refused guarded write, in either org", async () => {
      const base = {
        key: "github:4242", plan: "pro" as const, role: "member" as const,
        source: "purchase", grantedAt: Date.now(), grantedBy: "stripe", expiresAt: null,
      };
      await store.putGrant({ ...base, orgId: "org_theirs" });

      expect(await store.putGrantIfOwned({ ...base, orgId: "org_mine" }, "org_mine",
        { actorUserId: "u_admin" })).toBe("conflict");

      expect(await store.auditForOrg("org_mine", 10)).toEqual([]);
      expect(await store.auditForOrg("org_theirs", 10)).toEqual([]);
      // The grant is untouched, so the emptiness above is about the audit
      // rather than about the whole call having done nothing.
      expect(await store.getGrant("github:4242")).toMatchObject({ orgId: "org_theirs" });
    });

    /** The deletes record too, through the source guard billing uses as well as the org one. */
    it("records a revocation through the source guard, in the org the grant was in", async () => {
      await store.putGrant({
        key: "github:4242", plan: "team" as const, role: "admin" as const, orgId: "org_mine",
        source: "purchase", grantedAt: Date.now(), grantedBy: "stripe", expiresAt: null,
      });

      expect((await store.deleteGrantIfSource("github:4242", "purchase",
        { actorUserId: "stripe", detail: { reason: "subscription no longer paying" } })).outcome)
        .toBe("deleted");

      const [entry] = await store.auditForOrg("org_mine", 10);
      expect(entry).toMatchObject({
        action: "plan_revoked", actorUserId: "stripe",
        detail: { key: "github:4242", plan: "team", reason: "subscription no longer paying" },
      });
    });

    /** All four guarded writes, each refused: the first test of the kind covers one of them. */
    it("records nothing for any refused guarded write, in either org", async () => {
      const held = {
        key: "github:4242", plan: "team" as const, role: "admin" as const, orgId: "org_theirs",
        source: "operator", grantedAt: Date.now(), grantedBy: "u_admin", expiresAt: null,
      };
      await store.putGrant(held);
      const asAdmin = { actorUserId: "u_admin" };

      expect(await store.putGrantIfOwned({ ...held, orgId: "org_mine" }, "org_mine", asAdmin))
        .toBe("conflict");
      expect((await store.putGrantIfSource({ ...held, orgId: "org_mine" }, "purchase", asAdmin)).outcome)
        .toBe("conflict");
      expect(await store.deleteGrantIfOwned("github:4242", "org_mine", asAdmin)).toBe("conflict");
      expect((await store.deleteGrantIfSource("github:4242", "purchase", asAdmin)).outcome)
        .toBe("conflict");
      expect(await store.deleteGrantIfOwned("github:nobody", "org_mine", asAdmin)).toBe("missing");
      expect((await store.deleteGrantIfSource("github:nobody", "purchase", asAdmin)).outcome)
        .toBe("missing");

      expect(await store.auditForOrg("org_mine", 10)).toEqual([]);
      expect(await store.auditForOrg("org_theirs", 10)).toEqual([]);
      // Still there, so the emptiness above is the audit's and not a store that did nothing.
      expect(await store.getGrant("github:4242")).toMatchObject({ orgId: "org_theirs" });
    });

    /**
     * Who acted and why are part of the record, whichever guard the write went
     * through. Billing's reason for a change and the admin's identity are what an
     * auditor reads first, and a store that dropped either on one path would
     * still pass every case above.
     */
    it("records the actor and detail it was given, through either guard", async () => {
      const grant = {
        plan: "team" as const, role: "admin" as const,
        grantedAt: Date.now(), grantedBy: "u_admin", expiresAt: null,
      };
      await store.putGrantIfOwned(
        { ...grant, key: "github:owned", orgId: "org_a", source: "operator" }, "org_a",
        { actorUserId: "u_admin", detail: { via: "admin route" } }
      );
      await store.putGrantIfSource(
        { ...grant, key: "github:billed", orgId: "org_b", source: "purchase" }, "purchase",
        { actorUserId: "stripe", detail: { customer: "cus_1" } }
      );

      expect((await store.auditForOrg("org_a", 10))[0]).toMatchObject({
        actorUserId: "u_admin", detail: { key: "github:owned", via: "admin route" },
      });
      expect((await store.auditForOrg("org_b", 10))[0]).toMatchObject({
        actorUserId: "stripe", detail: { key: "github:billed", customer: "cus_1" },
      });
    });

    /**
     * The log is read in time order, so an entry carries the moment of the write
     * that made it. The clock moves between the four writes: with it frozen, an
     * entry stamped by a different call, or by none, would read the same.
     */
    it("stamps each entry with the time of the write that made it", async () => {
      const base = {
        plan: "team" as const, role: "admin" as const, orgId: "org_mine",
        grantedAt: Date.now(), grantedBy: "u_admin", expiresAt: null,
      };
      const asAdmin = { actorUserId: "u_admin" };
      const times: number[] = [];
      const tick = () => {
        vi.advanceTimersByTime(1_000);
        times.push(Date.now());
      };

      tick();
      await store.putGrantIfOwned({ ...base, key: "github:1", source: "operator" }, "org_mine", asAdmin);
      tick();
      await store.putGrantIfSource({ ...base, key: "github:2", source: "purchase" }, "purchase", asAdmin);
      tick();
      await store.deleteGrantIfOwned("github:1", "org_mine", asAdmin);
      tick();
      await store.deleteGrantIfSource("github:2", "purchase", asAdmin);

      expect((await store.auditForOrg("org_mine", 10)).map((e) => e.at)).toEqual(times);
    });

    /** What the caller passed is theirs afterwards: changing it must not rewrite the record. */
    it("keeps the detail it was given as it was when the write happened", async () => {
      await store.putGrant({
        key: "github:4242", plan: "team" as const, role: "admin" as const, orgId: "org_mine",
        source: "operator", grantedAt: Date.now(), grantedBy: "u_admin", expiresAt: null,
      });
      const detail = { reason: { why: "left the team" } };
      await store.deleteGrantIfOwned("github:4242", "org_mine", { actorUserId: "u_admin", detail });

      detail.reason.why = "changed afterwards";

      expect((await store.auditForOrg("org_mine", 10))[0]).toMatchObject({
        detail: { reason: { why: "left the team" } },
      });
    });

    /** null is a bucket, not "unscoped": org-less grants list as their own set. */
    it("lists org-less grants separately from an org's", async () => {
      (await store.putGrant({
        key: "github:solo", plan: "pro" as const, role: "member" as const, orgId: null,
        source: "purchase", grantedAt: Date.now(), grantedBy: "stripe", expiresAt: null,
      }));
      (await store.putGrant({
        key: "github:team", plan: "team" as const, role: "member" as const, orgId: "org_mine",
        source: "purchase", grantedAt: Date.now(), grantedBy: "stripe", expiresAt: null,
      }));

      expect((await store.listGrants(50, null)).map((g) => g.key)).toEqual(["github:solo"]);
      expect((await store.listGrants(50, "org_mine")).map((g) => g.key)).toEqual(["github:team"]);
    });

    it("lists grants", async () => {
      for (const key of ["github:1", "github:2"]) {
        (await store.putGrant({
          key, plan: "pro" as const, role: "member" as const, orgId: null,
          source: "purchase", grantedAt: Date.now(), grantedBy: "stripe", expiresAt: null,
        }));
      }

      expect((await store.listGrants(10)).map((g) => g.key).sort()).toEqual(["github:1", "github:2"]);
    });

    it("takePendingConnect is single-use", async () => {
      (await store.putPendingConnect({
        token: "qct_1", sessionId: "qs_test", userId: "u_peer", roomRole: "peer_b",
        createdAt: Date.now(), expiresAt: Date.now() + CONNECT_TOKEN_TTL,
      }));
      expect((await store.takePendingConnect("qct_1"))?.userId).toBe("u_peer");
      expect((await store.takePendingConnect("qct_1"))).toBeUndefined();
    });

    it("takePendingConnect refuses an expired token", async () => {
      (await store.putPendingConnect({
        token: "qct_2", sessionId: "qs_test", userId: "u_peer", roomRole: "peer_b",
        createdAt: Date.now(), expiresAt: Date.now() + CONNECT_TOKEN_TTL,
      }));
      vi.advanceTimersByTime(CONNECT_TOKEN_TTL + 1);
      expect((await store.takePendingConnect("qct_2"))).toBeUndefined();
    });

    // ---------------------------------------------------------------- quotas
    it("counts creates within the current calendar month only", async () => {
      (await store.recordCreate("u_jesse"));
      (await store.recordCreate("u_jesse"));
      (await store.recordCreate("u_peer"));
      expect((await store.countCreatesThisMonth("u_jesse"))).toBe(2);
      expect((await store.countCreatesThisMonth("u_peer"))).toBe(1);
      expect((await store.countCreatesThisMonth("u_nobody"))).toBe(0);

      // Roll well into the next month (any timezone) — earlier creates stop counting.
      vi.setSystemTime(new Date("2026-04-15T12:00:00Z"));
      expect((await store.countCreatesThisMonth("u_jesse"))).toBe(0);
    });

    // ----------------------------------------------------------------- audit
    it("scopes audit reads to a single org", async () => {
      (await store.appendAudit({
        at: Date.now(), orgId: "org_a", sessionId: "qs_1",
        actorUserId: "u_a", action: "session_created", detail: {},
      }));
      (await store.appendAudit({
        at: Date.now(), orgId: "org_b", sessionId: "qs_2",
        actorUserId: "u_b", action: "session_created", detail: {},
      }));

      expect((await store.auditForOrg("org_a", 50))).toHaveLength(1);
      expect((await store.auditForOrg("org_a", 50))[0].sessionId).toBe("qs_1");
      expect((await store.auditForOrg("org_c", 50))).toHaveLength(0);
    });

    it("returns the most recent audit entries up to the limit", async () => {
      for (let i = 0; i < 10; i++) {
        (await store.appendAudit({
          at: Date.now() + i, orgId: "org_a", sessionId: `qs_${i}`,
          actorUserId: "u_a", action: "sent_message", detail: { i },
        }));
      }
      const recent = (await store.auditForOrg("org_a", 3));
      expect(recent).toHaveLength(3);
      expect(recent.map((a) => a.sessionId)).toEqual(["qs_7", "qs_8", "qs_9"]);
    });

    // ----------------------------------------------------------------- sweep
    it("sweep expires a session past its TTL and emits session_expired", async () => {
      const s = session({ expiresAt: Date.now() + 1_000 });
      (await store.createSession(s));

      vi.advanceTimersByTime(1_001);
      (await store.sweep(Date.now()));

      const fresh = (await store.getSession(s.id))!;
      expect(fresh.closed).toBe(true);
      expect(fresh.joinCodes).toEqual({});
      // Read after getSession, not before it: DurableObjectStore.sweep is a
      // no-op, so there it is the read above that expires the session and
      // writes this event. getSession no longer carries history (#25).
      expect((await store.eventsAfter(s.id, 0)).at(-1)?.type).toBe("session_expired");
      expect((await store.getSessionByJoinCode("BELL-TEST-01"))).toBeUndefined();
    });

    it("sweep is idempotent — one expiry event, not one per sweep", async () => {
      const s = session({ expiresAt: Date.now() + 1_000 });
      (await store.createSession(s));

      vi.advanceTimersByTime(1_001);
      (await store.sweep(Date.now()));
      (await store.sweep(Date.now()));
      (await store.sweep(Date.now()));

      // The read comes first and is not incidental: DurableObjectStore.sweep is a
      // no-op, so there this read is what expires the session, and the events
      // below would be empty without it.
      await store.getSession(s.id);
      const expired = (await store.eventsAfter(s.id, 0)).filter(
        (e) => e.type === "session_expired",
      );
      expect(expired).toHaveLength(1);
    });

    it("expires a due session lazily on read, without waiting for a sweep", async () => {
      const s = session({ expiresAt: Date.now() + 1_000 });
      (await store.createSession(s));
      vi.advanceTimersByTime(1_001);
      expect((await store.getSession(s.id))?.closed).toBe(true);
    });

    it("sweep drops expired pending connects", async () => {
      (await store.putPendingConnect({
        token: "qct_sweep", sessionId: "qs_test", userId: "u_peer", roomRole: "peer_b",
        createdAt: Date.now(), expiresAt: Date.now() + 1_000,
      }));
      vi.advanceTimersByTime(1_001);
      (await store.sweep(Date.now()));
      expect((await store.takePendingConnect("qct_sweep"))).toBeUndefined();
    });

    it("sweep leaves live sessions and tokens alone", async () => {
      const s = session();
      (await store.createSession(s));
      (await store.putPendingConnect({
        token: "qct_live", sessionId: s.id, userId: "u_peer", roomRole: "peer_b",
        createdAt: Date.now(), expiresAt: Date.now() + CONNECT_TOKEN_TTL,
      }));

      (await store.sweep(Date.now()));
      expect((await store.getSession(s.id))?.closed).toBe(false);
      expect((await store.takePendingConnect("qct_live"))).toBeDefined();
    });

    // ----------------------------------------------------- removing a member
    const leaveEvent = (memberId: string): EventBody => ({
      type: "member_left",
      fromMemberId: memberId,
      fromUserId: "u_jesse",
      fromLabel: "jesse@codenerd",
      payload: { label: "jesse@codenerd" },
      refId: null,
    });

    const auditRow = (action: string) => ({
      at: Date.now(),
      orgId: "org_codenerd",
      sessionId: "qs_test",
      actorUserId: "u_jesse",
      action,
      detail: {},
    });

    // The audit reads in the cases below are timing-dependent in the Durable Objects
    // store. A row a refused call queued there reaches auditForOrg when the outbox
    // delivers it, and a refusal commits nothing that would deliver it inline, so that is
    // the alarm's doing and not the call's. The suite pins the clock to 2026-03-15 (see
    // the beforeEach), which makes the alarm overdue the moment it is set, so it usually
    // has delivered by the time these cases read. That is the clock and not a guarantee:
    // a read can get there first. The stamp, door and events reads do not depend on it.

    /**
     * An eviction of `m_peer`: the departure, and the door behind it with its own audit
     * row. The door is `peer_b`'s. That is the seat `oneCode` and `session()` plant a
     * live code for, and not `member()`'s default seat, `peer_a`: a room built from
     * those fixtures has a door for this request to shut only because the request names
     * the role instead of taking it from the member.
     */
    const eviction = (now = 9_000_000): RemovalRequest => ({
      now,
      frozen: "refuse",
      // An eviction cuts the feed; the leave-shaped requests below pass false. The
      // field has no default, so each case says which removal it is modelling.
      cut: true,
      byUserId: "u_jesse",
      event: { ...leaveEvent("m_peer"), type: "member_evicted" },
      retire: {
        role: "peer_b",
        event: { ...leaveEvent("m_peer"), type: "invite_revoked" },
        audit: [auditRow("invite_revoked")],
      },
      audit: [auditRow("member_evicted")],
    });

    it("removeMember records the member out, writes its event and queues its audit row", async () => {
      const s = session({
        members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer" })],
      });
      await store.createSession(s);

      const outcome = await store.removeMember(s.id, "m_peer", {
        now: 9_000_000,
        frozen: "allow",
        cut: false,
        event: leaveEvent("m_peer"),
        audit: [auditRow("member_left")],
      });

      expect(outcome).toEqual({ refused: null, removed: true, codeRetired: null });
      const fresh = (await store.getSession(s.id))!;
      expect(fresh.members.find((m) => m.memberId === "m_peer")?.leftAt).toBe(9_000_000);
      expect((await store.eventsAfter(s.id, 0)).map((e) => e.type)).toEqual(["member_left"]);
      expect((await store.auditForOrg("org_codenerd", 10)).map((a) => a.action)).toEqual(["member_left"]);
    });

    /**
     * The cut, asked for by the caller and applied inside the removal (#113).
     *
     * These sit here and not beside the append's own `markRemoved` cases because
     * they pin a different route to the same rule. `evictMember` removes through
     * `removeMember`, not through `appendEvent`, so a store that applied the cut
     * on an append and not on a removal would pass every case in "recording a
     * member out at an event's cursor" and still hand an evicted member an open
     * feed — #113 reopened in the operation written to close it.
     *
     * As there, these do not claim to prove the atomicity, which is not visible
     * from outside the store. What they pin is what a caller can see: the cursor
     * is the departure's own, a removal that did not ask records none, and the
     * cursor is the departure's and not the door's.
     */
    it("removeMember records the cut at the departure's own cursor when the caller asks", async () => {
      const s = session({
        members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer" })],
      });
      await store.createSession(s);

      const outcome = await store.removeMember(s.id, "m_peer", {
        now: 9_000_000,
        frozen: "refuse",
        cut: true,
        byUserId: "u_jesse",
        event: { ...leaveEvent("m_peer"), type: "member_evicted" },
        audit: [],
      });

      expect(outcome.removed).toBe(true);
      const departure = (await store.eventsAfter(s.id, 0))
        .filter((e) => e.type === "member_evicted").at(-1)!;
      const m = (await store.getSession(s.id))!.members.find((mm) => mm.memberId === "m_peer")!;
      // The cursor the removal's own event carries, read back from the log rather
      // than computed here: a store numbering its events differently would still
      // have to agree with itself.
      expect(m.removedAtCursor).toBe(departure.cursor);
      // One write, not two. `leftAt` is the `now` the caller handed in, not the
      // event's `at`: a removal's clock is its caller's.
      expect(m.leftAt).toBe(9_000_000);
    });

    it("removeMember records no cut when the caller does not ask", async () => {
      const s = session({
        members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer" })],
      });
      await store.createSession(s);

      const outcome = await store.removeMember(s.id, "m_peer", {
        now: 9_000_000,
        frozen: "allow",
        cut: false,
        event: leaveEvent("m_peer"),
        audit: [],
      });

      expect(outcome.removed).toBe(true);
      const m = (await store.getSession(s.id))!.members.find((mm) => mm.memberId === "m_peer")!;
      // Out, and still reading. R2: a member who chose to go keeps the open feed,
      // and a store that cut here would be the symmetry `announceReclaimed` warns
      // against. The departure is written either way — this is not a no-op path.
      expect(m.leftAt).toBe(9_000_000);
      expect(m.removedAtCursor).toBeUndefined();
      expect((await store.eventsAfter(s.id, 0)).map((e) => e.type)).toEqual(["member_left"]);
    });

    it("removeMember cuts at the departure's cursor, not the door's", async () => {
      const s = session({
        joinCodes: oneCode("BELL-LIVE-01"),
        members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer" })],
      });
      await store.createSession(s);

      const outcome = await store.removeMember(s.id, "m_peer", eviction());

      expect(outcome).toEqual({ refused: null, removed: true, codeRetired: "peer_b" });
      const events = await store.eventsAfter(s.id, 0);
      expect(events.map((e) => e.type), "arrangement: two events, so the cursors differ")
        .toEqual(["member_evicted", "invite_revoked"]);
      const m = (await store.getSession(s.id))!.members.find((mm) => mm.memberId === "m_peer")!;
      // The removal writes two events and the cut names the FIRST. Pinned because
      // the last one written is the easier thing to reach for, and a cut one cursor
      // too high admits the evicted member past the door's own announcement — an
      // event about the room they are no longer in.
      expect(m.removedAtCursor).toBe(events[0].cursor);
      expect(m.removedAtCursor).not.toBe(events[1].cursor);
    });

    it("removeMember announces a departure from a frozen room, where appendEvent would not", async () => {
      // #73. Freezing refuses sending, joining and inviting; it must never trap
      // a member inside a room they want to leave, and the departure peers see
      // is part of the leaving.
      const s = session({
        frozenAt: Date.now(),
        members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer" })],
      });
      await store.createSession(s);

      const outcome = await store.removeMember(s.id, "m_peer", {
        now: 9_000_000,
        frozen: "allow",
        cut: false,
        event: leaveEvent("m_peer"),
        audit: [],
      });

      expect(outcome.removed).toBe(true);
      expect((await store.eventsAfter(s.id, 0)).map((e) => e.type)).toEqual(["member_left"]);
      // The public append still refuses, because that is what stops a freeze
      // landing between a tool's read and its write and letting a room grow.
      expect(await store.appendEvent(s.id, leaveEvent("m_creator"))).toBeNull();
    });

    it("removeMember refuses a frozen room when the caller asked it to, and writes and queues nothing", async () => {
      // This is the guard #118 is about, and the answer is not the proof: a store that
      // stamped the member, wrote the events and queued the rows and only then looked at
      // the freeze would return this same answer. So the state is read after it, and in
      // every store, because the one production runs is the Durable Objects one. The
      // request carries a door and the room holds a live code for it, or a misplaced
      // guard would have nothing to shut.
      const door = oneCode("BELL-LIVE-01");
      const s = session({
        frozenAt: Date.now(),
        joinCodes: door,
        members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer" })],
      });
      await store.createSession(s);
      expect(await store.getSessionByJoinCode("BELL-LIVE-01"), "control: the door is live before the call")
        .toBeDefined();

      const outcome = await store.removeMember(s.id, "m_peer", eviction());

      expect(outcome).toEqual({ refused: "frozen", removed: false, codeRetired: null });
      const after = (await store.getSession(s.id))!;
      expect(after.members.find((m) => m.memberId === "m_peer")?.leftAt).toBeNull();
      // The record as planted, code and expiry, and not merely a record: a store that
      // kept the door's entry but expired it, or swapped the code, would still have one.
      expect(after.joinCodes["peer_b"], "the door is untouched").toEqual(door["peer_b"]);
      expect(await store.eventsAfter(s.id, 0)).toEqual([]);
      expect(await store.auditForOrg("org_codenerd", 10)).toEqual([]);
    });

    it("removeMember refuses a closed room even when frozen is allowed", async () => {
      // "allow" is about the freeze and nothing else. A closed room is over, and
      // writing a departure into it would reopen the question of what closed means.
      const s = session({
        closed: true,
        members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer" })],
      });
      await store.createSession(s);

      expect(await store.removeMember(s.id, "m_peer", {
        now: 9_000_000, frozen: "allow", cut: false, event: leaveEvent("m_peer"), audit: [],
      })).toEqual({ refused: "closed", removed: false, codeRetired: null });
    });

    it("removeMember refuses a caller who did not create the room, and writes and queues nothing", async () => {
      // The answer is not the proof. A store that stamped the member, wrote the events
      // and queued the rows, and only then checked who was asking, would return this
      // same answer, so the state is read as well. The request carries a door and the
      // room holds a live code for it, or a misplaced guard would have nothing to shut.
      const door = oneCode("BELL-LIVE-01");
      const s = session({
        createdBy: "u_jesse",
        joinCodes: door,
        members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer" })],
      });
      await store.createSession(s);
      expect(await store.getSessionByJoinCode("BELL-LIVE-01"), "control: the door is live before the call")
        .toBeDefined();

      expect(await store.removeMember(s.id, "m_peer", {
        ...eviction(),
        byUserId: "u_someone_else",
      })).toEqual({ refused: "forbidden", removed: false, codeRetired: null });

      const after = (await store.getSession(s.id))!;
      expect(after.members.find((m) => m.memberId === "m_peer")?.leftAt).toBeNull();
      // The record as planted, code and expiry, and not merely a record: a store that
      // kept the door's entry but expired it, or swapped the code, would still have one.
      expect(after.joinCodes["peer_b"], "the door is untouched").toEqual(door["peer_b"]);
      expect(await store.eventsAfter(s.id, 0)).toEqual([]);
      expect(await store.auditForOrg("org_codenerd", 10)).toEqual([]);
    });

    it("removeMember answers not_found for an unknown room and an unknown member, and writes and queues nothing", async () => {
      // One code, two refusals, and neither is proved by its answer. What a misplaced
      // guard could leave behind differs, and so does the read that sees it.
      //
      // A room that is not there has no record to stamp or retire from. It can still be
      // handed audit rows, which need no record to be queued: the audit reads catch those.
      // And in the Durable Objects store it can be handed an event, because a room's events
      // are keys in an object that exists for any name, so one written before the room
      // check would sit in a room that does not exist: the events read of that room
      // catches it there. MemoryStore has no record to append to, so it cannot.
      //
      // A member who is not there cannot be stamped, because the stamp needs the record.
      // The rest does not need it. The departure's event body is in the request, so a
      // store that wrote it before looking the member up would leave it behind: the
      // events read catches that. The door's retirement needs only the room: the door read
      // catches that. The rows need neither: the audit reads catch those.
      //
      // Each request carries a door and rows, and the room holds a live code for the door.
      const door = oneCode("BELL-LIVE-01");
      const s = session({
        joinCodes: door,
        members: [member({ memberId: "m_creator" })],
      });
      await store.createSession(s);
      expect(await store.getSessionByJoinCode("BELL-LIVE-01"), "control: the door is live before either call")
        .toBeDefined();

      expect(await store.removeMember("qs_nope", "m_peer", eviction()))
        .toEqual({ refused: "not_found", removed: false, codeRetired: null });
      // Vacuous in the Durable Objects store, in every run so far. This read follows the
      // call at once, and rows a misplaced guard queued there are delivered by the
      // outbox's alarm, which had not got that far. The final audit read below is what
      // catches them, and only because this suite pins the clock to 2026-03-15 (see its
      // beforeEach), which makes the outbox's five-second grace alarm overdue the moment
      // it is set. Pin a recent date, lengthen the grace or slow the alarm and the room
      // half goes green with no signal. A correct store queues nothing, so this cannot go
      // red by accident: it is caught today and not guarded against drift. A
      // deterministic pin reads the outbox's rows directly, as
      // worker-tests/session-audit-outbox.test.ts does, and belongs in the workers
      // program, not in this suite that MemoryStore shares.
      expect(await store.auditForOrg("org_codenerd", 10), "no row for a room that is not there").toEqual([]);
      expect(await store.eventsAfter("qs_nope", 0), "no event for a room that is not there").toEqual([]);

      expect(await store.removeMember(s.id, "m_ghost", eviction()))
        .toEqual({ refused: "not_found", removed: false, codeRetired: null });
      const after = (await store.getSession(s.id))!;
      // The record as planted, code and expiry, and not merely a record: a store that
      // kept the door's entry but expired it, or swapped the code, would still have one.
      expect(after.joinCodes["peer_b"], "the door is untouched").toEqual(door["peer_b"]);
      expect(await store.eventsAfter(s.id, 0)).toEqual([]);
      expect(await store.auditForOrg("org_codenerd", 10)).toEqual([]);
    });

    /** Review Focus 2. */
    it("removeMember writes and queues nothing for a member who is already out", async () => {
      const s = session({
        members: [
          member({ memberId: "m_creator" }),
          member({ memberId: "m_peer", userId: "u_peer", leftAt: 5_000 }),
        ],
      });
      await store.createSession(s);

      const outcome = await store.removeMember(s.id, "m_peer", {
        now: 9_000_000,
        frozen: "allow",
        cut: false,
        event: leaveEvent("m_peer"),
        audit: [auditRow("member_left")],
      });

      expect(outcome).toEqual({ refused: null, removed: false, codeRetired: null });
      // The original stamp stands: a retry must not restate when they went.
      expect((await store.getSession(s.id))!.members.find((m) => m.memberId === "m_peer")?.leftAt)
        .toBe(5_000);
      expect(await store.eventsAfter(s.id, 0)).toEqual([]);
      expect(await store.auditForOrg("org_codenerd", 10)).toEqual([]);
    });

    /** Review Focus 1. */
    it("removeMember writes and queues nothing when it refuses", async () => {
      const door = oneCode("BELL-LIVE-01");
      const s = session({
        closed: true,
        joinCodes: door,
        members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer" })],
      });
      await store.createSession(s);

      await store.removeMember(s.id, "m_peer", {
        now: 9_000_000,
        frozen: "allow",
        // `true`, so the refusal is asked to swallow a cut as well as a stamp: a
        // store that applied the cut before its guard would leave a cursor here.
        cut: true,
        event: leaveEvent("m_peer"),
        retire: { role: "peer_b", event: leaveEvent("m_peer") },
        audit: [auditRow("member_left")],
      });

      const fresh = (await store.getSession(s.id))!;
      expect(fresh.members.find((m) => m.memberId === "m_peer")?.leftAt).toBeNull();
      expect(fresh.members.find((m) => m.memberId === "m_peer")?.removedAtCursor).toBeUndefined();
      // The record as planted, code and expiry: pinning the code alone passes a store
      // that kept the entry and expired it.
      expect(fresh.joinCodes["peer_b"], "the door is untouched").toEqual(door["peer_b"]);
      expect(await store.eventsAfter(s.id, 0)).toEqual([]);
      expect(await store.auditForOrg("org_codenerd", 10)).toEqual([]);
    });

    it("removeMember retires a live code and writes its event, in the member's order", async () => {
      const s = session({
        joinCodes: oneCode("BELL-LIVE-01"),
        members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer" })],
      });
      await store.createSession(s);

      const outcome = await store.removeMember(s.id, "m_peer", {
        now: 9_000_000,
        frozen: "refuse",
        cut: true,
        byUserId: "u_jesse",
        event: { ...leaveEvent("m_peer"), type: "member_evicted" },
        retire: { role: "peer_b", event: { ...leaveEvent("m_peer"), type: "invite_revoked" } },
        audit: [auditRow("member_evicted")],
      });

      expect(outcome).toEqual({ refused: null, removed: true, codeRetired: "peer_b" });
      expect((await store.getSession(s.id))!.joinCodes["peer_b"]).toBeUndefined();
      expect(await store.getSessionByJoinCode("BELL-LIVE-01")).toBeUndefined();
      // The member went, then the door shut — the order a person would tell it.
      expect((await store.eventsAfter(s.id, 0)).map((e) => e.type))
        .toEqual(["member_evicted", "invite_revoked"]);

      // The cursor row ends at the LAST event, or the next append overwrites it (#120).
      await store.appendEvent(s.id, leaveEvent("m_creator"));
      expect((await store.eventsAfter(s.id, 0)).map((e) => e.type))
        .toEqual(["member_evicted", "invite_revoked", "member_left"]);
    });

    /** Review Focus 3. */
    it("removeMember does not retire a code that has already expired", async () => {
      // Nothing prunes an expired record, so presence in joinCodes is not the
      // same as a door being open. Retiring on presence alone announces a
      // closing that already happened.
      const s = session({
        joinCodes: { peer_b: { code: "BELL-STALE-1", expiresAt: Date.now() - 1 } },
        members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer" })],
      });
      await store.createSession(s);

      const outcome = await store.removeMember(s.id, "m_peer", {
        now: Date.now(),
        frozen: "refuse",
        cut: true,
        byUserId: "u_jesse",
        event: { ...leaveEvent("m_peer"), type: "member_evicted" },
        retire: { role: "peer_b", event: { ...leaveEvent("m_peer"), type: "invite_revoked" } },
        audit: [],
      });

      expect(outcome.removed).toBe(true);
      expect(outcome.codeRetired).toBeNull();
      expect((await store.eventsAfter(s.id, 0)).map((e) => e.type)).toEqual(["member_evicted"]);
    });

    // ------------------------------------- the door behind a member already out
    //
    // Not saying the departure twice is not licence to skip what is still owed. A live
    // code behind a member who left on their own was never shut, so shutting it is a
    // write that has not happened yet, and not a duplicate of one that has.

    /** The creator, and `m_peer`, who has already left, with whatever codes the caller names. */
    const roomWithDeparted = (joinCodes: ReturnType<typeof oneCode>) => session({
      joinCodes,
      members: [
        member({ memberId: "m_creator" }),
        member({ memberId: "m_peer", userId: "u_peer", leftAt: 5_000 }),
      ],
    });

    it("removeMember shuts a live code behind a member who is already out, and says only that", async () => {
      const s = roomWithDeparted(oneCode("BELL-LIVE-01"));
      await store.createSession(s);

      const outcome = await store.removeMember(s.id, "m_peer", eviction());

      // Two answers, not one: nobody was removed, and a code was retired.
      expect(outcome).toEqual({ refused: null, removed: false, codeRetired: "peer_b" });
      const fresh = (await store.getSession(s.id))!;
      expect(fresh.members.find((m) => m.memberId === "m_peer")?.leftAt, "the original stamp stands")
        .toBe(5_000);
      expect(fresh.joinCodes["peer_b"]).toBeUndefined();
      expect(await store.getSessionByJoinCode("BELL-LIVE-01")).toBeUndefined();
      // The door, and not the departure: member_evicted is not said a second time, by
      // event or by row.
      expect((await store.eventsAfter(s.id, 0)).map((e) => e.type)).toEqual(["invite_revoked"]);
      expect((await store.auditForOrg("org_codenerd", 10)).map((a) => a.action))
        .toEqual(["invite_revoked"]);

      // The cursor row ends at the one event written, or the next append overwrites it (#120).
      await store.appendEvent(s.id, leaveEvent("m_creator"));
      expect((await store.eventsAfter(s.id, 0)).map((e) => e.type))
        .toEqual(["invite_revoked", "member_left"]);
    });

    it("removeMember shuts that door once: a repeat finds it gone and writes nothing", async () => {
      const s = roomWithDeparted(oneCode("BELL-LIVE-01"));
      await store.createSession(s);
      await store.removeMember(s.id, "m_peer", eviction());

      const again = await store.removeMember(s.id, "m_peer", eviction());

      // It cannot repeat: the first call made the code no longer live.
      expect(again).toEqual({ refused: null, removed: false, codeRetired: null });
      expect((await store.eventsAfter(s.id, 0)).map((e) => e.type)).toEqual(["invite_revoked"]);
      expect((await store.auditForOrg("org_codenerd", 10)).map((a) => a.action))
        .toEqual(["invite_revoked"]);
    });

    it("removeMember writes and queues nothing for a member who is already out, when their seat has no code", async () => {
      // Passing `retire` does not make the call owe a write. With no door there is
      // nothing to shut, and the departure is not said again.
      const s = roomWithDeparted({});
      await store.createSession(s);

      const outcome = await store.removeMember(s.id, "m_peer", eviction());

      expect(outcome).toEqual({ refused: null, removed: false, codeRetired: null });
      expect(await store.eventsAfter(s.id, 0)).toEqual([]);
      expect(await store.auditForOrg("org_codenerd", 10)).toEqual([]);
    });

    it("removeMember writes and queues nothing for a member who is already out, when their seat's code has expired", async () => {
      // Review Focus 3 on this path too: nothing prunes an expired record, so its
      // presence is not an open door.
      const s = roomWithDeparted({ peer_b: { code: "BELL-STALE-1", expiresAt: Date.now() - 1 } });
      await store.createSession(s);

      const outcome = await store.removeMember(s.id, "m_peer", eviction(Date.now()));

      expect(outcome).toEqual({ refused: null, removed: false, codeRetired: null });
      expect(await store.eventsAfter(s.id, 0)).toEqual([]);
      expect(await store.auditForOrg("org_codenerd", 10)).toEqual([]);
    });

    it("removeMember queues the retirement's audit row after the member's, when it retires the code", async () => {
      const s = session({
        joinCodes: oneCode("BELL-LIVE-01"),
        members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer" })],
      });
      await store.createSession(s);

      const outcome = await store.removeMember(s.id, "m_peer", eviction());

      expect(outcome).toEqual({ refused: null, removed: true, codeRetired: "peer_b" });
      // The member went, then the door shut: the events and the rows both.
      expect((await store.eventsAfter(s.id, 0)).map((e) => e.type))
        .toEqual(["member_evicted", "invite_revoked"]);
      expect((await store.auditForOrg("org_codenerd", 10)).map((a) => a.action))
        .toEqual(["member_evicted", "invite_revoked"]);
    });

    it("removeMember queues no retirement audit row when there was no live code to retire", async () => {
      // A row for the door is a claim that this call shut it, so it is queued with the
      // retirement and not with the request. Otherwise a caller that asked for a
      // retirement that never happened would have audited one.
      const s = session({
        joinCodes: { peer_b: { code: "BELL-STALE-1", expiresAt: Date.now() - 1 } },
        members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer" })],
      });
      await store.createSession(s);

      const outcome = await store.removeMember(s.id, "m_peer", eviction(Date.now()));

      expect(outcome).toEqual({ refused: null, removed: true, codeRetired: null });
      expect((await store.auditForOrg("org_codenerd", 10)).map((a) => a.action)).toEqual(["member_evicted"]);
    });

    it("removeMember queues no retirement audit row when it refuses", async () => {
      const s = session({
        closed: true,
        joinCodes: oneCode("BELL-LIVE-01"),
        members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer" })],
      });
      await store.createSession(s);

      const outcome = await store.removeMember(s.id, "m_peer", eviction());

      expect(outcome).toEqual({ refused: "closed", removed: false, codeRetired: null });
      expect((await store.getSession(s.id))!.closed).toBe(true);
      expect(await store.eventsAfter(s.id, 0)).toEqual([]);
      expect(await store.auditForOrg("org_codenerd", 10)).toEqual([]);
    });

    it("removeMember files no row for an org-less entry, in audit or in retire.audit", async () => {
      // A falsy org names a stream nobody reads. MemoryStore would file the row there
      // all the same, and a Durable Object namespace takes "" as a name and would
      // deliver into it, so the entry is dropped before it is queued. Both defences
      // sit behind this answer in the Durable Object store (the producer's filter and
      // the outbox's delivery guard), so what this pins there is the result; the
      // producer's filter alone is what MemoryStore leaves to hold it.
      const s = session({
        joinCodes: oneCode("BELL-LIVE-01"),
        members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer" })],
      });
      await store.createSession(s);

      await store.removeMember(s.id, "m_peer", {
        ...eviction(),
        audit: [auditRow("member_evicted"), { ...auditRow("member_evicted"), orgId: "" }],
        retire: {
          role: "peer_b",
          event: { ...leaveEvent("m_peer"), type: "invite_revoked" },
          audit: [auditRow("invite_revoked"), { ...auditRow("invite_revoked"), orgId: "" }],
        },
      });

      expect(await store.auditForOrg("", 10)).toEqual([]);
      expect((await store.auditForOrg("org_codenerd", 10)).map((a) => a.action))
        .toEqual(["member_evicted", "invite_revoked"]);
    });
  });
}
