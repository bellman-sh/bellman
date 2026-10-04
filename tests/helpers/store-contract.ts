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
import type { BellmanStore } from "../../src/store.js";
import { JOIN_CODE_TTL, CONNECT_TOKEN_TTL } from "../../src/store.js";
import { MAX_PAYLOAD_DEPTH, PayloadTooDeepError } from "../../src/idempotency.js";
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
   * `instanceof` across a Durable Object RPC boundary. workerd reconstructs a
   * thrown error in the caller's realm: name, message and own properties
   * survive, the prototype does not.
   *
   * Tracked as #101, and a production bug rather than a test artefact —
   * src/server.ts:765 branches on exactly this `instanceof` and so never fires
   * under Durable Objects. Delete this entry when #101 closes.
   */
  errorIdentityAcrossRpc?: string;
}

export function describeStoreContract(
  name: string,
  makeStore: () => BellmanStore,
  divergences: StoreContractDivergences = {},
): void {
  describe(`BellmanStore contract: ${name}`, () => {
    let store: BellmanStore;

    /** `it`, unless this store has an argued reason it cannot pass the case. */
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

      expect(outcome).toEqual({ refused: null, reclaimed: [] });
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
      )).toEqual({ refused: "full", reclaimed: [] });
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
      )).toEqual({ refused: "frozen", reclaimed: [] });
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
      )).toEqual({ refused: "full", reclaimed: [] });
      expect((await store.getSession(s.id))!.members.filter((m) => m.leftAt !== null))
        .toEqual([]);
    });

    it("seatMember reports an unknown session rather than throwing", async () => {
      expect(await store.seatMember(
        "qs_nope", member({ memberId: "m_late", userId: "u_late" }), 0, 9_000_000
      )).toEqual({ refused: "not_found", reclaimed: [] });
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
     * A payload too deep to fingerprint must leave nothing behind.
     *
     * `fingerprint` throws, and `appendEventOnce` calls it before it mutates
     * anything, so the throw has to reach the caller with no event appended and
     * no key recorded. A store that wrote first and fingerprinted second would
     * satisfy every other case in this block.
     */
    caseFor(divergences.errorIdentityAcrossRpc)(
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
  });
}
