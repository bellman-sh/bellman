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
import type { BellmanStore, EventBody, ProposalApproval, RemovalRequest } from "../../src/store.js";
import { JOIN_CODE_TTL, CONNECT_TOKEN_TTL, ROOM_MEMBER_CEILING } from "../../src/store.js";
import { actionStates } from "../../src/action-state.js";
import { resolveManifest } from "../../src/manifest.js";
import { MAX_PAYLOAD_DEPTH, PayloadTooDeepError } from "../../src/payload.js";
import { lastReport } from "../../src/heartbeat.js";
import { ABANDONED_AFTER_MS } from "../../src/presence.js";
import { MAX_SURFACE_ITEMS, gridSlot, surfaceCursor } from "../../src/surface.js";
import { blobBytesUsed, type BlobStore } from "../../src/blobs.js";
import type { AuditFacets, AuditPage, AuditQuery, SeqEntry } from "../../src/audit.js";
import { chainHash, NO_ANCHOR } from "../../src/audit-sink.js";
import type { AuditEntry, Org, OrgIdp, OrgInvite, PlanGrant, SavedPreset, ScimUser, Session, SessionEvent, SurfaceItem } from "../../src/types.js";
import { INVITE_TTL_MS, MAX_PENDING_INVITES, isUnownedSeat } from "../../src/orgs.js";
import { DEFAULT_POLICY } from "../../src/types.js";
import { scimIntent } from "../../src/grant-audit.js";
import { HOST_MEMBER_ID, HOST_USER_ID, WAKES_PER_HOUR, hostMember } from "../../src/host.js";
import { monthKey } from "../../src/stored-session.js";
import { sendKeyFor } from "../../src/send-limit.js";
import type { NewReport, Report } from "../../src/reports.js";
import { brief, jesseActor, member, oneCode, openaiAgent, peerActor, roomManifest, session, swarmSession } from "./fixtures.js";

/** A swarm room with a hosted seat (hosted seat spec, D1): a lead role, and the host's role holding `send` alone. */
const hostedManifest = () => roomManifest({ mode: "swarm", preset: null, heartbeatOnMs: 3_600_000,
  roles: { lead: { can: ["send", "invite"], description: null, reports: false }, host: { can: ["send"], description: null, reports: false } },
  defaultRole: "lead", creatorRole: "lead", host: { role: "host", model: "haiku", instructions: null } });

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

/**
 * What a store's caller supplies beside the store, for the cases that reach outside it (#65): a
 * purge deletes from a blob store, and a store whose retention runs on a room's own alarm has to be
 * told when the alarm comes.
 */
export interface StoreContractHarness {
  /**
   * The blob store the store under test deletes from, read after each `makeStore()`. The cases put
   * objects in it and read them back, so a purge that missed the bucket the store was built over is seen.
   */
  blobsFor: () => BlobStore;
  /**
   * Called after a case's `sweep`, for the room it names. MemoryStore sweeps every room itself and
   * passes nothing. `DurableObjectStore.sweep` is a no-op, because a room is purged by that room's own
   * alarm, so its caller runs the alarm here.
   */
  advance?: (sessionId: string) => Promise<void>;
  /**
   * Called after a case's `sweep`, for the registry. `MemoryStore` deletes a resolved report in `sweep` and
   * passes nothing. `DurableObjectStore.sweep` is a no-op, because the registry deletes a report on its own
   * alarm (`report_purge`), so its caller runs the alarm here.
   */
  advanceRegistry?: () => Promise<void>;
  /**
   * The accounts whose filing times the store still holds: what `fileReport` counts the day's limit from. The
   * harness reads it because `BellmanStore` cannot show it, since a row whose times have all left the day counts
   * as no row. The purge deletes such a row, which only serves the limit, because the privacy page promises a
   * reporter's account is kept 180 days after resolution and not for good.
   */
  reporterRows: () => Promise<string[]>;
  /**
   * The SCIM key index rows the store holds, `sk:<key>` (ADR 0029), which `BellmanStore` cannot show: every read
   * of one goes on to the user it names, so a row left on a key no user names any longer shows only here.
   */
  scimIndexRows: () => Promise<string[]>;
  /**
   * Drops what the store's room objects hold in memory and keeps what they have stored: an idle Durable
   * Object is evicted after about 30 seconds, and a count kept only in memory is gone with it. A store with
   * nothing that can leave memory passes none, and the case that calls it then pins the count alone.
   */
  forgetMemory?: () => Promise<void>;
}

export function describeStoreContract(
  name: string,
  makeStore: () => BellmanStore,
  harness: StoreContractHarness,
  divergences: StoreContractDivergences = {},
): void {
  describe(`BellmanStore contract: ${name}`, () => {
    let store: BellmanStore;
    let blobs: BlobStore;

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
      blobs = harness.blobsFor();
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

    // ------------------------------------------------------------- public rooms
    it("makes a room private once, open or closed: the first time stands, and a room that is not there stays not there", async () => {
      const open = session({ id: "qs_pub_open", manifest: roomManifest({ public: true }) });
      const closed = session({ id: "qs_pub_closed", manifest: roomManifest({ public: true }), closed: true, closedAt: Date.now(), joinCodes: {} });
      for (const s of [open, closed]) await store.createSession(s);
      expect((await store.getSession(open.id))?.unpublishedAt).toBeNull();

      const first = Date.now();
      for (const s of [open, closed]) {
        await store.unpublishSession(s.id, first);
        await store.unpublishSession(s.id, first + 60_000);
        expect((await store.getSession(s.id))?.unpublishedAt, s.id).toBe(first);
      }
      await store.unpublishSession("qs_nope", first);
      expect(await store.getSession("qs_nope")).toBeUndefined();
    });

    describe("the public name index (public names spec, D5)", () => {
      it("holds no entry for a name never claimed", async () => {
        expect(await store.publicNameEntry("bellman-dev")).toBeNull();
      });

      it("claims a name only while its entry is still what the claimer read, compared whole", async () => {
        const a = { id: "qs_a", at: 1 };
        const b = { id: "qs_b", at: 2 };
        expect(await store.claimPublicName("bellman-dev", a, null)).toBe(true);
        expect(await store.publicNameEntry("bellman-dev")).toEqual(a);
        expect(await store.claimPublicName("bellman-dev", b, null)).toBe(false);
        // The same room's id from another claim is another entry: the claim it read has been replaced.
        expect(await store.claimPublicName("bellman-dev", b, { id: "qs_a", at: 9 })).toBe(false);
        expect(await store.claimPublicName("bellman-dev", b, a)).toBe(true);
        expect(await store.publicNameEntry("bellman-dev")).toEqual(b);
      });

      it("lets exactly one of two claims on one name win", async () => {
        const won = await Promise.all([
          store.claimPublicName("race", { id: "qs_a", at: 1 }, null),
          store.claimPublicName("race", { id: "qs_b", at: 1 }, null),
        ]);
        expect(won.filter(Boolean)).toHaveLength(1);
        expect((await store.publicNameEntry("race"))?.id).toBe(won[0] ? "qs_a" : "qs_b");
      });

      it("gives a claim back only while its entry is still the one given", async () => {
        const a = { id: "qs_a", at: 1 };
        await store.claimPublicName("given-back", a, null);
        expect(await store.releasePublicName("given-back", { id: "qs_a", at: 2 })).toBe(false);
        expect(await store.publicNameEntry("given-back")).toEqual(a);
        expect(await store.releasePublicName("given-back", a)).toBe(true);
        expect(await store.publicNameEntry("given-back")).toBeNull();
        expect(await store.releasePublicName("given-back", a)).toBe(false);
      });

      it("writes the name on the room's record, keeps one a room is created with, and leaves a room that is not there not there", async () => {
        const s = session({ id: "qs_named", manifest: roomManifest({ public: true }) });
        await store.createSession(s);
        expect((await store.getSession(s.id))?.publicName).toBeNull();
        await store.setPublicName(s.id, "bellman-dev");
        expect((await store.getSession(s.id))?.publicName).toBe("bellman-dev");
        const born = session({ id: "qs_born_named", manifest: roomManifest({ public: true }), publicName: "born-named" });
        await store.createSession(born);
        expect((await store.getSession(born.id))?.publicName).toBe("born-named");
        await store.setPublicName("qs_nope", "bellman-dev");
        expect(await store.getSession("qs_nope")).toBeUndefined();
      });
    });

    // Room pages spec, D3: how a public room opens, on its record beside its name.
    it("writes how a public room opens on its record and nothing else, reads the canvas for one never set, and leaves a room that is not there not there", async () => {
      // Named, so a write that touches `publicName` shows in the whole-record comparison below.
      const s = session({ id: "qs_viewed", manifest: roomManifest({ public: true }), publicName: "viewed-room" });
      await store.createSession(s);
      const before = (await store.getSession(s.id))!;
      expect(before.publicView).toBe("canvas");
      await store.setPublicView(s.id, "page");
      expect(await store.getSession(s.id)).toEqual({ ...before, publicView: "page" });
      await store.setPublicView(s.id, "canvas");
      expect((await store.getSession(s.id))?.publicView).toBe("canvas");
      await store.setPublicView("qs_nope", "page");
      expect(await store.getSession("qs_nope")).toBeUndefined();
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
      read.members[0].agent.model = "mutated";
      read.orgOnly = true;
      (await store.getBriefs(s.id, ["m_creator"])).m_creator.goal = "mutated";

      const fresh = (await store.getSession(s.id))!;
      expect(fresh.closed).toBe(false);
      expect(fresh.members).toHaveLength(1);
      expect(fresh.members[0].agent.model).not.toBe("mutated");
      expect(fresh.orgOnly).toBe(false);
      expect((await store.getBriefs(s.id, ["m_creator"])).m_creator.goal).not.toBe("mutated");
    });

    /**
     * Briefs live beside the room, one row per member (ADR 0018), so the record a room is
     * stored as stays small however many join. A member keeps its brief's `agent`, which the
     * roster shows, and the brief comes back by member id.
     */
    it("keeps each member's brief beside the room, and hands it back by member id", async () => {
      const s = swarmSession({ members: [member({ brief: brief({ goal: "the creator's" }) })] });
      await store.createSession(s);
      expect(await store.addMember(s.id, member({ memberId: "m_added", userId: "u_added", brief: brief({ goal: "added", agent: openaiAgent }) }))).toBe(true);
      const seat = await store.seatMember(s.id, member({ memberId: "m_seated", userId: "u_seated", brief: brief({ goal: "seated" }) }), 0, Date.now());
      expect(seat.refused).toBeNull();

      const read = (await store.getSession(s.id))!;
      for (const m of read.members) expect(m, m.memberId).not.toHaveProperty("brief");
      expect(read.members.find((m) => m.memberId === "m_added")!.agent).toEqual(openaiAgent);
      expect(await store.getBriefs(s.id, ["m_creator", "m_added", "m_seated", "m_nobody"])).toEqual({
        m_creator: brief({ goal: "the creator's" }),
        m_added: brief({ goal: "added", agent: openaiAgent }),
        m_seated: brief({ goal: "seated" }),
      });
      expect(await store.getBriefs(s.id, [])).toEqual({});
      expect(await store.getBriefs("qs_nowhere", ["m_creator"])).toEqual({});
    });

    it("replaces a member's brief on updateMember, and the agent the record keeps with it", async () => {
      const s = session();
      await store.createSession(s);
      const newer = brief({ goal: "newer", agent: openaiAgent });
      await store.updateMember(s.id, "m_creator", { brief: newer });

      expect((await store.getBriefs(s.id, ["m_creator"])).m_creator).toEqual(newer);
      expect((await store.getSession(s.id))!.members[0].agent).toEqual(openaiAgent);
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

    /**
     * INVARIANT 2: a consumed join code resolves nothing, and consuming it twice is
     * harmless. Redeeming a code does not consume it: a swarm code seats joiner after
     * joiner until it expires or the room fills (ADR 0010).
     */
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

    /**
     * The `revoke` authority, decided where the write happens (#90).
     *
     * `issueInvite` used to read the roster, see no live code, and then call
     * this — so two callers holding `invite` and not `revoke` could both observe
     * no live code and the second would retire the first's. The check and the
     * write have to be one operation, and this is the only place that can make
     * them one. Both stores answer alike or the race is closed in memory and
     * open in production.
     */
    describe("replacing a live code", () => {
      const live = () => Date.now() + JOIN_CODE_TTL;

      it("refuses, and writes nothing, when the caller may not replace", async () => {
        const s = session({ joinCodes: oneCode("BELL-AAAA-01", "peer_b") });
        (await store.createSession(s));

        const out = await store.setJoinCode(
          s.id, "peer_b", "BELL-NEWW-02", live(), { replaceLive: false, now: Date.now() },
        );

        expect(out).toEqual({ ok: false, reason: "live_code_exists" });
        // The old code still resolves and the new one never existed: a refusal
        // that half-applied would be worse than one that let the mint through.
        expect((await store.getSessionByJoinCode("BELL-AAAA-01"))?.role).toBe("peer_b");
        expect(await store.getSessionByJoinCode("BELL-NEWW-02")).toBeUndefined();
      });

      it("replaces, and says so, when the caller may", async () => {
        const s = session({ joinCodes: oneCode("BELL-AAAA-01", "peer_b") });
        (await store.createSession(s));

        const out = await store.setJoinCode(
          s.id, "peer_b", "BELL-NEWW-02", live(), { replaceLive: true, now: Date.now() },
        );

        expect(out).toEqual({ ok: true, replacedLive: true });
        expect(await store.getSessionByJoinCode("BELL-AAAA-01")).toBeUndefined();
        expect((await store.getSessionByJoinCode("BELL-NEWW-02"))?.role).toBe("peer_b");
      });

      it("lets a seat that may not replace mint over an EXPIRED code", async () => {
        // An expired record shuts no door, so minting over it is opening one.
        // Without this the guard would read as "one code per role, ever".
        const s = session({ joinCodes: { peer_b: { code: "BELL-OLDD-01", expiresAt: 1 } } });
        (await store.createSession(s));

        const out = await store.setJoinCode(
          s.id, "peer_b", "BELL-NEWW-02", live(), { replaceLive: false, now: Date.now() },
        );

        expect(out).toEqual({ ok: true, replacedLive: false });
        expect((await store.getSessionByJoinCode("BELL-NEWW-02"))?.role).toBe("peer_b");
      });

      it("opens a role that has no code at all", async () => {
        const s = session({ joinCodes: oneCode("BELL-AAAA-01", "peer_b") });
        (await store.createSession(s));

        const out = await store.setJoinCode(
          s.id, "peer_a", "BELL-NEWW-02", live(), { replaceLive: false, now: Date.now() },
        );

        expect(out).toEqual({ ok: true, replacedLive: false });
        expect((await store.getSessionByJoinCode("BELL-NEWW-02"))?.role).toBe("peer_a");
      });
    });

    it("holds a live code for two roles at once, each resolving to its own role", async () => {
      const s = session({ joinCodes: oneCode("BELL-AAAA-01", "peer_b") });
      (await store.createSession(s));
      (await store.setJoinCode(s.id, "peer_a", "BELL-CCCC-03", Date.now() + JOIN_CODE_TTL, { replaceLive: true, now: Date.now() }));

      expect((await store.getSessionByJoinCode("BELL-AAAA-01"))?.role).toBe("peer_b");
      expect((await store.getSessionByJoinCode("BELL-CCCC-03"))?.role).toBe("peer_a");
    });

    /** The invariant the whole issue turns on. */
    it("issuing for one role leaves another role's code resolving", async () => {
      const s = session({ joinCodes: oneCode("BELL-AAAA-01", "peer_b") });
      (await store.createSession(s));
      (await store.setJoinCode(s.id, "peer_a", "BELL-CCCC-03", Date.now() + JOIN_CODE_TTL, { replaceLive: true, now: Date.now() }));

      (await store.setJoinCode(s.id, "peer_a", "BELL-DDDD-04", Date.now() + JOIN_CODE_TTL, { replaceLive: true, now: Date.now() }));

      expect(await store.getSessionByJoinCode("BELL-CCCC-03")).toBeUndefined();
      expect((await store.getSessionByJoinCode("BELL-DDDD-04"))?.role).toBe("peer_a");
      expect((await store.getSessionByJoinCode("BELL-AAAA-01"))?.role).toBe("peer_b");
    });

    it("consuming one role's code leaves the other resolving", async () => {
      const s = session({ joinCodes: oneCode("BELL-AAAA-01", "peer_b") });
      (await store.createSession(s));
      (await store.setJoinCode(s.id, "peer_a", "BELL-CCCC-03", Date.now() + JOIN_CODE_TTL, { replaceLive: true, now: Date.now() }));

      (await store.consumeJoinCode(s.id, "peer_b"));

      expect(await store.getSessionByJoinCode("BELL-AAAA-01")).toBeUndefined();
      expect((await store.getSessionByJoinCode("BELL-CCCC-03"))?.role).toBe("peer_a");
    });

    it("clearJoinCodes retires every code, idempotently", async () => {
      const s = session({ joinCodes: oneCode("BELL-AAAA-01", "peer_b") });
      (await store.createSession(s));
      (await store.setJoinCode(s.id, "peer_a", "BELL-CCCC-03", Date.now() + JOIN_CODE_TTL, { replaceLive: true, now: Date.now() }));

      (await store.clearJoinCodes(s.id));

      expect(await store.getSessionByJoinCode("BELL-AAAA-01")).toBeUndefined();
      expect(await store.getSessionByJoinCode("BELL-CCCC-03")).toBeUndefined();
      expect((await store.getSession(s.id))?.joinCodes).toEqual({});
      await expect(store.clearJoinCodes(s.id)).resolves.not.toThrow();
    });

    it("closing a session clears every code, not just the default role's", async () => {
      const s = session({ joinCodes: oneCode("BELL-AAAA-01", "peer_b") });
      (await store.createSession(s));
      (await store.setJoinCode(s.id, "peer_a", "BELL-CCCC-03", Date.now() + JOIN_CODE_TTL, { replaceLive: true, now: Date.now() }));

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

    // ------------------------------------------------- members as rows (ADR 0019)
    /**
     * A member is a row of its own beside the room, so the record holds who is in it now and
     * not everyone who ever was. These are the reads that reach the rest: by id, by person, as
     * a list of those who left, and the public numbers their labels were given at seating.
     */
    describe("members as rows (ADR 0019)", () => {
      const joiner = (memberId: string, over: Partial<Parameters<typeof member>[0]> = {}) =>
        member({ memberId, userId: `u_${memberId}`, label: `${memberId}@codenerd`, roomRole: "peer_b", ...over });

      it("reads the members in the room now, in join order, and keeps the creator and every org that sat in it", async () => {
        const s = swarmSession({ members: [member(), joiner("m_a", { orgId: "org_a" })] });
        await store.createSession(s);
        expect(await store.addMember(s.id, joiner("m_b", { orgId: null }))).toBe(true);
        expect((await store.seatMember(s.id, joiner("m_c", { orgId: "org_c" }), 0, Date.now())).refused).toBeNull();
        await store.updateMember(s.id, "m_a", { leftAt: Date.now() });
        await store.updateMember(s.id, "m_creator", { leftAt: Date.now() });

        const read = (await store.getSession(s.id))!;
        expect(read.members.map((m) => m.memberId)).toEqual(["m_b", "m_c"]);
        expect(read.creator).toEqual({ memberId: "m_creator", userId: "u_jesse", label: "jesse@codenerd", joinedAt: s.members[0].joinedAt });
        expect(read.orgs).toEqual(["org_codenerd", "org_a", "org_c"]);
      });

      it("numbers each member in join order, across the room's creation and every seat after it", async () => {
        const s = swarmSession({ members: [member(), joiner("m_a")] });
        await store.createSession(s);
        await store.addMember(s.id, joiner("m_b"));
        await store.updateMember(s.id, "m_a", { leftAt: Date.now() });
        await store.seatMember(s.id, joiner("m_c"), 0, Date.now());

        expect((await store.getSession(s.id))!.members.map((m) => [m.memberId, m.seq]))
          .toEqual([["m_creator", 1], ["m_b", 3], ["m_c", 4]]);
        expect((await store.getMember(s.id, "m_a"))?.seq).toBe(2);
      });

      it("reads a member who has left by id, as a copy, and nothing for an id or a room it never held", async () => {
        const s = session({ members: [member(), joiner("m_peer")] });
        await store.createSession(s);
        await store.updateMember(s.id, "m_peer", { leftAt: 9_000_000 });

        expect((await store.getSession(s.id))!.members.map((m) => m.memberId)).toEqual(["m_creator"]);
        const gone = (await store.getMember(s.id, "m_peer"))!;
        expect(gone).toMatchObject({ memberId: "m_peer", userId: "u_m_peer", roomRole: "peer_b", leftAt: 9_000_000, seq: 2 });
        expect(gone).not.toHaveProperty("brief");
        expect(await store.getMember(s.id, "m_creator")).toMatchObject({ memberId: "m_creator", leftAt: null });
        expect(await store.getMember(s.id, "m_nobody")).toBeUndefined();
        expect(await store.getMember("qs_nowhere", "m_peer")).toBeUndefined();

        gone.label = "mutated";
        expect((await store.getMember(s.id, "m_peer"))!.label).toBe("m_peer@codenerd");
      });

      it("reads members by id in join order, leaving out an id the room never seated", async () => {
        const s = session({ members: [member(), joiner("m_peer")] });
        await store.createSession(s);
        await store.updateMember(s.id, "m_peer", { leftAt: 9_000_000 });

        expect((await store.getMembers(s.id, ["m_peer", "m_nobody", "m_creator"])).map((m) => m.memberId))
          .toEqual(["m_creator", "m_peer"]);
        expect(await store.getMembers(s.id, [])).toEqual([]);
        expect(await store.getMembers("qs_nowhere", ["m_creator"])).toEqual([]);
      });

      it("reads every handle a person has held, those gone included, and keeps a user apart from one whose id it begins", async () => {
        const s = swarmSession({ members: [member()] });
        await store.createSession(s);
        await store.addMember(s.id, joiner("m_a1", { userId: "u_a" }));
        await store.addMember(s.id, joiner("m_ab", { userId: "u_a:b" }));
        await store.addMember(s.id, joiner("m_a2", { userId: "u_a" }));
        await store.updateMember(s.id, "m_a1", { leftAt: Date.now() });

        expect((await store.membersOfUser(s.id, "u_a")).map((m) => m.memberId)).toEqual(["m_a1", "m_a2"]);
        expect((await store.membersOfUser(s.id, "u_a:b")).map((m) => m.memberId)).toEqual(["m_ab"]);
        expect(await store.membersOfUser(s.id, "u_nobody")).toEqual([]);
        expect(await store.membersOfUser("qs_nowhere", "u_a")).toEqual([]);
      });

      it("lists the members who left, in join order: the most recent when asked for a few, those after a time when asked", async () => {
        const s = swarmSession({ members: [member()] });
        await store.createSession(s);
        for (const id of ["m_1", "m_2", "m_3", "m_4"]) await store.addMember(s.id, joiner(id));
        // Out of join order, and m_2 stays.
        await store.updateMember(s.id, "m_3", { leftAt: 1_000 });
        await store.updateMember(s.id, "m_1", { leftAt: 2_000 });
        await store.updateMember(s.id, "m_4", { leftAt: 3_000 });
        const ids = async (opts?: { limit?: number; leftAfter?: number }) => {
          const { members, omitted } = await store.departedMembers(s.id, opts);
          return { ids: members.map((m) => m.memberId), omitted };
        };

        expect(await ids()).toEqual({ ids: ["m_1", "m_3", "m_4"], omitted: 0 });
        expect(await ids({ limit: 2 })).toEqual({ ids: ["m_1", "m_4"], omitted: 1 });
        expect(await ids({ leftAfter: 1_000 })).toEqual({ ids: ["m_1", "m_4"], omitted: 0 });
        expect(await ids({ leftAfter: 1_000, limit: 1 })).toEqual({ ids: ["m_4"], omitted: 1 });
        expect(await store.departedMembers("qs_nowhere")).toEqual({ members: [], omitted: 0 });
      });

      it("numbers labels for a public room in the order they first sat, once each, and never the hosted seat's", async () => {
        const m = hostedManifest();
        const s = session({ manifest: m, members: [member({ roomRole: "lead" }), hostMember(m, Date.now())] });
        await store.createSession(s);
        await store.addMember(s.id, joiner("m_a", { roomRole: "lead" }));
        // The same person on a second machine: one label, so one number.
        await store.addMember(s.id, joiner("m_a2", { userId: "u_m_a", label: "m_a@codenerd", roomRole: "lead" }));
        await store.updateMember(s.id, "m_a", { leftAt: Date.now() });
        await store.updateMember(s.id, "m_a2", { leftAt: Date.now() });
        // Numbered after the labels that left, not in their place.
        await store.seatMember(s.id, joiner("m_b", { roomRole: "lead" }), 0, Date.now());

        expect(await store.publicNumbers(s.id, ["jesse@codenerd", "m_a@codenerd", "m_b@codenerd", "host@bellman", "nobody"]))
          .toEqual({ "jesse@codenerd": 1, "m_a@codenerd": 2, "m_b@codenerd": 3 });
        expect((await store.getMember(s.id, "m_a2"))?.publicNumber).toBe(2);
        expect((await store.getSession(s.id))!.members.find((x) => x.memberId === HOST_MEMBER_ID)?.publicNumber).toBeNull();
        expect(await store.publicNumbers(s.id, [])).toEqual({});
        expect(await store.publicNumbers("qs_nowhere", ["jesse@codenerd"])).toEqual({});
      });

      it("refuses to create a room with nobody to seat as its creator", async () => {
        await expect(store.createSession(session({ id: "qs_empty", members: [] }))).rejects.toThrow(/creator/);
        expect(await store.getSession("qs_empty")).toBeUndefined();
      });
    });

    // ------------------------------------------- permanent codes (ADR 0020)
    //
    // A public room may hold a code with no expiry for its default seat, so a link put on
    // a page keeps seating people until it is revoked, the room goes private, or the room
    // closes. Each case reads the door back before the call it is about: a store that
    // never resolved a permanent code would pass every case that asks for one to be gone.
    describe("a permanent code", () => {
      const PERMANENT = "BELL-PERM-01-PEER-B";
      /** The default seat's door, with no expiry. `session()`'s default role is peer_b. */
      const door = () => ({ peer_b: { code: PERMANENT, expiresAt: null } });
      const publicRoom = (over: Parameters<typeof session>[0] = {}) =>
        session({ manifest: roomManifest({ public: true }), joinCodes: door(), ...over });
      const isOpen = async (what = "the permanent door resolves") =>
        expect(await store.getSessionByJoinCode(PERMANENT), what).toMatchObject({ role: "peer_b" });
      const joiner = (memberId: string) =>
        member({ memberId, userId: `u_${memberId}`, roomRole: "peer_b" });
      const body = (type: EventBody["type"], memberId: string): EventBody => ({
        type, fromMemberId: memberId, fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: {}, refId: null,
      });

      it("still resolves a week on, when a temporary code beside it has long expired", async () => {
        const s = publicRoom({ joinCodes: { ...door(), ...oneCode("BELL-TEMP-01", "peer_a") } });
        await store.createSession(s);
        await isOpen("control: the permanent door resolves at once");

        vi.setSystemTime(Date.now() + 7 * 24 * 3_600_000);

        // The control that the clock moved far enough to matter: the temporary code is gone.
        expect(await store.getSessionByJoinCode("BELL-TEMP-01")).toBeUndefined();
        expect(await store.getSessionByJoinCode(PERMANENT)).toMatchObject({ session: { id: s.id }, role: "peer_b" });
      });

      it("stays when a seating fills the room, while every temporary code goes", async () => {
        const doors = { ...door(), ...oneCode("BELL-TEMP-01", "peer_a") };
        const s = publicRoom({ joinCodes: doors, members: [member({ memberId: "m_creator" })] });
        await store.createSession(s);
        await isOpen("control: the permanent door resolves before the call");
        expect(await store.getSessionByJoinCode("BELL-TEMP-01"), "control: the temporary door resolves before the call")
          .toMatchObject({ role: "peer_a" });

        const outcome = await store.seatMember(s.id, joiner("m_late"), 1, 9_000_000);

        // It cleared the temporary code, so it says so.
        expect(outcome).toEqual({ refused: null, reclaimed: [], codesCleared: true });
        expect((await store.getSession(s.id))!.joinCodes).toEqual(door());
        expect(await store.getSessionByJoinCode("BELL-TEMP-01")).toBeUndefined();
        await isOpen();
      });

      it("refuses joiners while the room is full and seats one again once a seat frees", async () => {
        const s = publicRoom({ members: [member({ memberId: "m_creator" })] });
        await store.createSession(s);
        await isOpen("control: the permanent door resolves before the call");

        const filled = await store.seatMember(s.id, joiner("m_late"), 1, 9_000_000);

        // The room filled holding only the permanent code, which stays, so nothing was cleared.
        expect(filled).toEqual({ refused: null, reclaimed: [], codesCleared: false });
        expect((await store.getSession(s.id))!.joinCodes).toEqual(door());
        expect((await store.seatMember(s.id, joiner("m_later"), 1, 9_000_000)).refused, "the premise: the room is full")
          .toBe("full");

        await store.removeMember(s.id, "m_late", {
          now: 9_000_001, frozen: "allow", cut: false, event: body("member_left", "m_late"), audit: [],
        });

        await isOpen("the door is still open after the seat frees");
        expect((await store.seatMember(s.id, joiner("m_later"), 1, 9_000_002)).refused).toBeNull();
      });

      it("is retired by a revoke of its role, and by a revoke of every role", async () => {
        const one = publicRoom();
        const all = publicRoom({ id: "qs_perm_all", joinCodes: { peer_b: { code: "BELL-PERM-02-PEER-B", expiresAt: null } } });
        await store.createSession(one);
        await store.createSession(all);
        await isOpen("control: the first door resolves");
        expect(await store.getSessionByJoinCode("BELL-PERM-02-PEER-B"), "control: the second door resolves")
          .toMatchObject({ role: "peer_b" });

        await store.consumeJoinCode(one.id, "peer_b");
        await store.clearJoinCodes(all.id);

        expect(await store.getSessionByJoinCode(PERMANENT)).toBeUndefined();
        expect(await store.getSessionByJoinCode("BELL-PERM-02-PEER-B")).toBeUndefined();
        expect((await store.getSession(one.id))!.joinCodes).toEqual({});
        expect((await store.getSession(all.id))!.joinCodes).toEqual({});
      });

      it("is retired when the room is made private, and a temporary code is left to run out", async () => {
        const temporary = oneCode("BELL-TEMP-01", "peer_a");
        const s = publicRoom({ joinCodes: { ...door(), ...temporary } });
        await store.createSession(s);
        await isOpen("control: the permanent door resolves before the call");

        await store.unpublishSession(s.id, Date.now());

        expect(await store.getSessionByJoinCode(PERMANENT)).toBeUndefined();
        // The record, and not only what resolves: a store that stopped resolving the code
        // and kept it listed would show a private room a door it does not have.
        expect((await store.getSession(s.id))!.joinCodes).toEqual(temporary);
        expect(await store.getSessionByJoinCode("BELL-TEMP-01")).toMatchObject({ role: "peer_a" });
      });

      it("is a live code, so replacing it takes replaceLive", async () => {
        const s = publicRoom();
        await store.createSession(s);
        await isOpen("control: the permanent door resolves before the call");

        expect(await store.setJoinCode(s.id, "peer_b", "BELL-NEWW-02", null, { replaceLive: false, now: Date.now() }))
          .toEqual({ ok: false, reason: "live_code_exists" });
        await isOpen("a refusal leaves the door as it was");
        expect(await store.getSessionByJoinCode("BELL-NEWW-02")).toBeUndefined();

        expect(await store.setJoinCode(s.id, "peer_b", "BELL-NEWW-02", null, { replaceLive: true, now: Date.now() }))
          .toEqual({ ok: true, replacedLive: true });
        expect(await store.getSessionByJoinCode(PERMANENT)).toBeUndefined();
        expect((await store.getSession(s.id))!.joinCodes).toEqual({ peer_b: { code: "BELL-NEWW-02", expiresAt: null } });
        expect(await store.getSessionByJoinCode("BELL-NEWW-02")).toMatchObject({ role: "peer_b" });
      });

      it("is refused to a room that is not public, and nothing is written", async () => {
        // Decided where the write happens, as replaceLive is (#90): a room made private
        // between a caller's read and this write would otherwise keep a permanent code
        // that unpublishing had already run past.
        const rooms = [
          session({ id: "qs_private", joinCodes: {} }),
          session({ id: "qs_unpublished", manifest: roomManifest({ public: true }), unpublishedAt: Date.now(), joinCodes: {} }),
        ];
        for (const r of rooms) {
          await store.createSession(r);
          expect(await store.setJoinCode(r.id, "peer_b", "BELL-PERM-03-PEER-B", null, { replaceLive: true, now: Date.now() }), r.id)
            .toEqual({ ok: false, reason: "not_public" });
          expect((await store.getSession(r.id))!.joinCodes, r.id).toEqual({});
          expect(await store.getSessionByJoinCode("BELL-PERM-03-PEER-B"), r.id).toBeUndefined();
        }
      });

      it("is retired by removing a member of its seat, as any live code is", async () => {
        // The member removed may hold the link, so a removal that names the seat's door
        // shuts it, permanent or not.
        const s = publicRoom({
          members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b" })],
        });
        await store.createSession(s);
        await isOpen("control: the permanent door resolves before the call");

        const outcome = await store.removeMember(s.id, "m_peer", {
          now: Date.now(),
          frozen: "refuse",
          cut: true,
          byUserId: "u_jesse",
          event: body("member_evicted", "m_peer"),
          retire: { role: "peer_b", event: body("invite_revoked", "m_peer") },
          audit: [],
        });

        expect(outcome).toEqual({ refused: null, removed: true, codeRetired: "peer_b" });
        expect((await store.getSession(s.id))!.joinCodes).toEqual({});
        expect(await store.getSessionByJoinCode(PERMANENT)).toBeUndefined();
      });
    });

    // --------------------------------------------------------------- members
    it("recentEvents returns the tail in cursor order, shorter when the log is, and nothing for a bad limit", async () => {
      const s = session();
      await store.createSession(s);
      for (const n of [1, 2, 3]) {
        await store.appendEvent(s.id, {
          type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse",
          fromLabel: "jesse", payload: { n }, refId: null,
        });
      }
      expect((await store.recentEvents(s.id, 2)).map((e) => e.cursor)).toEqual([2, 3]);
      expect((await store.recentEvents(s.id, 10)).map((e) => e.cursor)).toEqual([1, 2, 3]);
      // Review Focus 3: slice(-0) is the whole array; the contract says nothing.
      expect(await store.recentEvents(s.id, 0)).toEqual([]);
      expect(await store.recentEvents(s.id, -1)).toEqual([]);
      expect(await store.recentEvents("qs_missing", 5)).toEqual([]);
    });

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
      // Gone from the room's record, and read by id (ADR 0019).
      expect((await store.getSession(s.id))!.members).toEqual([]);
      const fresh = (await store.getMember(s.id, "m_creator"))!;
      expect(fresh.capabilities).toEqual(["read_context"]);
      expect(fresh.leftAt).toBe(Date.now());
      // untouched fields survive the patch
      expect(fresh.label).toBe("jesse@codenerd");
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

    /**
     * The seatMember cases' clock. `at(n)` is n ms past a base 9,000,000 ms before the
     * suite's clock, so the rosters keep their arithmetic (stale before 1,000,000,
     * seated at 9,000,000) and sit inside the 90-day window. Dated from the epoch they
     * read as abandoned (#18), and a Durable Object's alarm closes an abandoned room as
     * soon as it is created, before the seat is asked for.
     */
    const at = (n: number) => Date.now() - 9_000_000 + n;

    it("seatMember seats the joiner, reclaiming the stale seat in one operation", async () => {
      // The production join path. Read-then-write capacity was the bug: two
      // confirms agreeing on one seat overfill the room, and a sync landing in
      // the gap makes a member live again after it was chosen as the victim. So
      // every store has to decide and write without yielding.
      const s = session({
        members: [
          member({ memberId: "m_creator", lastSeenAt: at(2_000_000) }),
          member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b", lastSeenAt: at(1) }),
        ],
      });
      (await store.createSession(s));

      const outcome = await store.seatMember(
        s.id,
        member({ memberId: "m_late", userId: "u_late", roomRole: "peer_b" }),
        at(1_000_000),
        at(9_000_000),
      );

      expect(outcome.refused).toBeNull();
      expect(outcome.reclaimed.map((m) => m.memberId)).toEqual(["m_peer"]);
      // Reported with leftAt already set, so the caller announces a removal
      // that happened rather than one it predicted.
      expect(outcome.reclaimed[0].leftAt).toBe(at(9_000_000));

      const fresh = (await store.getSession(s.id))!;
      expect(fresh.members.map((m) => m.memberId)).toEqual(["m_creator", "m_late"]);
      expect((await store.getMember(s.id, "m_peer"))?.leftAt).toBe(at(9_000_000));
      expect(fresh.members.find((m) => m.memberId === "m_creator")?.leftAt).toBeNull();
    });

    it("seatMember seats into a room with a spare seat, reclaiming nobody", async () => {
      const s = session({
        members: [member({ memberId: "m_quiet", lastSeenAt: at(1) })],
      });
      (await store.createSession(s));

      const outcome = await store.seatMember(
        s.id, member({ memberId: "m_late", userId: "u_late" }), at(1_000_000), at(9_000_000)
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
          member({ memberId: "m_creator", lastSeenAt: at(2_000_000) }),
          member({ memberId: "m_peer", userId: "u_peer", lastSeenAt: at(2_000_000) }),
        ],
      });
      (await store.createSession(s));

      expect(await store.seatMember(
        s.id, member({ memberId: "m_late", userId: "u_late" }), at(1_000_000), at(9_000_000)
      )).toEqual({ refused: "full", reclaimed: [], codesCleared: false });
      expect((await store.getSession(s.id))!.members).toHaveLength(2);
    });

    it("seatMember refuses a frozen room, and a closed one, reclaiming nobody", async () => {
      const stale = () => session({
        members: [
          member({ memberId: "m_creator", lastSeenAt: at(2_000_000) }),
          member({ memberId: "m_peer", userId: "u_peer", lastSeenAt: at(1) }),
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
        frozen.id, member({ memberId: "m_late", userId: "u_late" }), at(1_000_000), at(9_000_000)
      )).toEqual({ refused: "frozen", reclaimed: [], codesCleared: false });
      expect((await store.getSession(frozen.id))!.members
        .find((m) => m.memberId === "m_peer")?.leftAt).toBeNull();

      (await store.freezeSession(frozen.id, null));
      (await store.closeSession(frozen.id));
      expect((await store.seatMember(
        frozen.id, member({ memberId: "m_late", userId: "u_late" }), at(1_000_000), at(9_000_000)
      )).refused).toBe("closed");
    });

    it("seatMember refuses rather than freeing some of the seats a joiner needs", async () => {
      const s = session({
        members: [
          member({ memberId: "m_a", lastSeenAt: at(2_000_000) }),
          member({ memberId: "m_b", userId: "u_b", lastSeenAt: at(2_000_000) }),
          member({ memberId: "m_c", userId: "u_c", lastSeenAt: at(1) }),
        ],
      });
      (await store.createSession(s));

      // Three undeparted members in a two-seat room needs two seats freed and
      // only one is reclaimable. A partial reap would remove a member for
      // somebody who never got in.
      expect(await store.seatMember(
        s.id, member({ memberId: "m_late", userId: "u_late" }), at(1_000_000), at(9_000_000)
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
        joinCodes: doors,
        members: [
          // Fresh on the store's clock as well as the call's: a room whose members
          // were all last seen before the window is abandoned at the first read (#18).
          member({ memberId: "m_creator", lastSeenAt: Date.now() }),
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
      // Quiet by the call's reckoning and inside the 90 days a room is kept: a room
      // whose members are all older than that is abandoned at the first read (#18).
      const quiet = Date.now() - 60_000;
      const s = session({
        joinCodes: doors,
        members: [
          member({ memberId: "m_quiet_a", lastSeenAt: quiet }),
          member({ memberId: "m_quiet_b", userId: "u_b", roomRole: "peer_b", lastSeenAt: quiet + 1 }),
        ],
      });
      await store.createSession(s);
      await doorsAreLive(s.id, doors);

      // Both seats are stale, so this joiner reclaims ONE, the longest quiet, and the
      // other stays occupied but reclaimable. Had both members been fresh after the
      // seating, that would be the other case, and it DOES retire the code.
      const outcome = await store.seatMember(s.id, late(), Date.now() - 1_000, 9_000_000);

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
      const s = swarmSession({
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
      // A creator, one member already gone, and the joiner: three rows and two
      // undeparted members, in a room that holds the ceiling, so a seat is spare and
      // the door stays open.
      const doors = oneCode("BELL-LIVE-01");
      const s = swarmSession({
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
      expect(after.members.map((m) => m.memberId), "the premise: two in the room").toEqual(["m_creator", "m_late"]);
      expect((await store.getMember(s.id, "m_gone"))?.leftAt, "and one gone").toBe(5_000);
      expect(after.joinCodes, "the door is untouched").toEqual(doors);
    });

    it("seatMember reports no codes cleared when the room fills holding none", async () => {
      // The flag says what the call did. A room that fills with no code left in it had
      // nothing to retire: no registry write is owed, and a caller reading
      // `codesCleared` must not conclude that a door was shut.
      const s = session({
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
      {
        refusal: "full",
        over: () => ({
          members: [
            member({ memberId: "m_creator", lastSeenAt: Date.now() }),
            member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b", lastSeenAt: Date.now() }),
          ],
        }),
      },
    ])("seatMember clears no codes when it refuses a $refusal room", async ({ refusal, over }) => {
      const doors = oneCode("BELL-LIVE-01");
      const s = session({
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
      expect(after.members.map((m) => m.memberId), "nobody was seated").not.toContain("m_late");
    });

    // One person on every machine: a seat is a member and not a person, so the room fills all the
    // same, and a store that indexes each person a room is created with does it once, not once a seat.
    it("seatMember seats a swarm room's last member and refuses one more", async () => {
      const present = (i: number) =>
        member({ memberId: `m_${i}`, userId: "u_crowd", roomRole: "peer_b", lastSeenAt: Date.now() });
      const s = swarmSession({ members: Array.from({ length: ROOM_MEMBER_CEILING - 1 }, (_, i) => present(i)) });
      (await store.createSession(s));

      // Ids the room has not seated: a member id is the member's row (ADR 0019).
      const last = await store.seatMember(s.id, present(ROOM_MEMBER_CEILING - 1), 1, Date.now());
      const beyond = await store.seatMember(s.id, present(ROOM_MEMBER_CEILING), 1, Date.now());

      expect(last).toEqual({ refused: null, reclaimed: [], codesCleared: true });
      expect(beyond).toEqual({ refused: "full", reclaimed: [], codesCleared: false });
      expect((await store.getSession(s.id))!.members.filter((m) => m.leftAt === null)).toHaveLength(ROOM_MEMBER_CEILING);
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

    it("stamps closedAt when a room closes, once, by every close path", async () => {
      const a = session({ id: "qs_close_a" });
      await store.createSession(a);
      await store.closeSession(a.id);
      const closedAt = (await store.getSession(a.id))!.closedAt;
      expect(closedAt).toBe(Date.now());
      vi.advanceTimersByTime(60_000);
      await store.closeSession(a.id);
      expect((await store.getSession(a.id))!.closedAt).toBe(closedAt);

      const b = session({ id: "qs_close_b", members: [member({ leftAt: Date.now() })] });
      await store.createSession(b);
      expect(await store.closeSessionIfEmpty(b.id)).toBe(true);
      expect((await store.getSession(b.id))!.closedAt).toBe(Date.now());
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
      (await store.setJoinCode(s.id, "peer_a", "BELL-CCCC-03", Date.now() + JOIN_CODE_TTL, { replaceLive: true, now: Date.now() }));

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
      const s = session({ members: [member({ leftAt: Date.now() })] });
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
     * **A thaw restarts housekeeping's clocks (#66, R9).** While a room is frozen nobody can
     * send and no request can be answered, so a finding computed across the freeze would name
     * a condition the room imposed. Heartbeat refuses the same for the tick, and pays the
     * credit at the thaw; housekeeping records the moment instead, `thawedAt`, and the rules
     * floor every base time at it. The member's last send stays the member's last send.
     *
     * Interface behaviour and not the alarm's, for `clearSilence`'s reason: the field is read
     * back through `getSession`, so a store that left it alone would name a room's members
     * quiet for the length of the outage.
     */
    describe("thawedAt, the moment housekeeping's clocks restart", () => {
      it("is null for a room that was never frozen", async () => {
        const s = session();
        await store.createSession(s);
        expect((await store.getSession(s.id))!.thawedAt).toBeNull();
      });

      it("is the moment of the thaw, and the freeze does not move it", async () => {
        const s = session();
        await store.createSession(s);

        await store.freezeSession(s.id, Date.now());
        expect((await store.getSession(s.id))!.thawedAt, "a freeze is not a thaw").toBeNull();

        vi.advanceTimersByTime(3_600_000);
        await store.freezeSession(s.id, null);

        expect((await store.getSession(s.id))!.thawedAt).toBe(Date.now());
      });

      // The transition and not the argument, as the report credit is: `freezeSession(null)` is
      // idempotent and the obvious thing to retry, and a retry that moved the floor forward
      // would keep every clock restarting for good.
      it("is set by a real thaw only, so a retried thaw leaves it where it was", async () => {
        const s = session();
        await store.createSession(s);

        await store.freezeSession(s.id, null);
        expect((await store.getSession(s.id))!.thawedAt, "nothing was frozen").toBeNull();

        await store.freezeSession(s.id, Date.now());
        await store.freezeSession(s.id, null);
        const thawed = Date.now();
        expect((await store.getSession(s.id))!.thawedAt).toBe(thawed);

        vi.advanceTimersByTime(60_000);
        await store.freezeSession(s.id, null);
        expect((await store.getSession(s.id))!.thawedAt, "nothing was frozen the second time").toBe(thawed);
      });

      it("moves forward to the latest thaw, and a freeze in between leaves it", async () => {
        const s = session();
        await store.createSession(s);
        await store.freezeSession(s.id, Date.now());
        await store.freezeSession(s.id, null);
        const first = Date.now();

        vi.advanceTimersByTime(3_600_000);
        await store.freezeSession(s.id, Date.now());
        expect((await store.getSession(s.id))!.thawedAt, "frozen again, the last thaw stands").toBe(first);

        vi.advanceTimersByTime(3_600_000);
        await store.freezeSession(s.id, null);
        expect((await store.getSession(s.id))!.thawedAt).toBe(Date.now());
      });
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
      expect((await store.setJoinCode(s.id, "peer_b", "BELL-NEW-01", Date.now() + 60_000, { replaceLive: true, now: Date.now() })).ok).toBe(false);
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

    it("keeps a person's rooms apart from someone whose id extends theirs past a colon, and drops none of theirs", async () => {
      // An operator-issued user id may hold a colon, so `u_x:a` extends `u_x` (#295). The walk
      // resolves each row it lists and drops the closed ones, so a row it listed that is not this
      // person's would be dropped from the other person's index.
      await store.createSession(session({ id: "qs_b_own", createdBy: "u_x" }));
      await store.createSession(session({ id: "qs_a_other", createdBy: "u_x:a" }));

      expect(await store.sessionsCreatedBy("u_x", 1)).toEqual(["qs_b_own"]);
      expect(await store.sessionsCreatedBy("u_x", 10)).toEqual(["qs_b_own"]);
      expect(await store.sessionsCreatedBy("u_x:a", 10)).toEqual(["qs_a_other"]);
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
    /**
     * A room seated with its creator alone, who is nobody the case below asks about: a room is
     * created with its creator (ADR 0019), and these cases are about who joins it afterwards.
     */
    const ownedBy = (id: string, createdBy = "u_owner") =>
      session({ id, createdBy, members: [member({ memberId: "m_owner", userId: createdBy, label: "owner@elsewhere" })] });

    it("lists the rooms a person joined, and nobody else's", async () => {
      await store.createSession(ownedBy("qs_hers", "u_peer"));
      await store.createSession(ownedBy("qs_his", "u_peer"));
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
      await store.createSession(ownedBy("qs_of_a", "u_a"));
      await store.createSession(ownedBy("qs_of_ab", "u_ab"));
      await store.addMember("qs_of_a", member({ memberId: "m_a", userId: "u_a" }));
      await store.addMember("qs_of_ab", member({ memberId: "m_ab", userId: "u_ab" }));

      expect(await store.sessionsJoinedBy("u_a", 10)).toEqual(["qs_of_a"]);
      expect(await store.sessionsJoinedBy("u_ab", 10)).toEqual(["qs_of_ab"]);
    });

    it("keeps a person apart from someone whose id extends theirs past a colon", async () => {
      // An operator-issued user id may hold a colon, so `u_x:a` extends `u_x` (#295), and its rows
      // must cost `u_x` no place in a short listing either.
      await store.createSession(ownedBy("qs_b_own", "u_x"));
      await store.createSession(ownedBy("qs_a_other", "u_x:a"));

      expect(await store.sessionsJoinedBy("u_x", 1)).toEqual(["qs_b_own"]);
      expect(await store.sessionsJoinedBy("u_x", 10)).toEqual(["qs_b_own"]);
      expect(await store.sessionsJoinedBy("u_x:a", 10)).toEqual(["qs_a_other"]);
    });

    it("lists a room once for a person who joined it from two machines", async () => {
      await store.createSession(ownedBy("qs_twice"));
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
      await store.createSession(ownedBy("qs_past"));
      await store.addMember("qs_past", member({ memberId: "m_gone", userId: "u_jesse" }));
      await store.updateMember("qs_past", "m_gone", { leftAt: Date.now() });

      expect(await store.sessionsJoinedBy("u_jesse", 10)).toEqual(["qs_past"]);
    });

    /** REVIEW FOCUS 5 — status is the caller's filter, not the store's. */
    it("keeps listing a room after it closed", async () => {
      await store.createSession(ownedBy("qs_over"));
      await store.addMember("qs_over", member({ memberId: "m_was", userId: "u_jesse" }));
      await store.closeSession("qs_over");

      expect(await store.sessionsJoinedBy("u_jesse", 10)).toEqual(["qs_over"]);
    });

    it("honours the limit on the joined listing", async () => {
      for (const id of ["qs_j1", "qs_j2", "qs_j3"]) {
        await store.createSession(ownedBy(id));
        await store.addMember(id, member({ memberId: `m_${id}`, userId: "u_jesse" }));
      }

      expect(await store.sessionsJoinedBy("u_jesse", 2)).toHaveLength(2);
    });

    it("indexes nothing when addMember refuses a frozen session", async () => {
      await store.createSession(ownedBy("qs_cold"));
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
      await store.createSession(ownedBy("qs_shut"));
      await store.closeSession("qs_shut");

      expect(await store.addMember("qs_shut", member({ memberId: "m_no", userId: "u_jesse" })))
        .toBe(false);
      expect((await store.getSession("qs_shut"))?.members.map((m) => m.memberId)).toEqual(["m_owner"]);
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

    // The hosted seat's read is bounded (I4): a room busy for weeks must not hand it its whole tail.
    it("eventsAfter reads at most `limit` events when given one, the earliest after the cursor", async () => {
      const s = session();
      await store.createSession(s);
      for (const text of ["one", "two", "three", "four"]) {
        await store.appendEvent(s.id, {
          type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse", payload: { text }, refId: null,
        });
      }
      expect((await store.eventsAfter(s.id, 1, 2)).map((e) => e.cursor)).toEqual([2, 3]);
      expect((await store.eventsAfter(s.id, 3, 2)).map((e) => e.cursor)).toEqual([4]);
      expect((await store.eventsAfter(s.id, 0)).map((e) => e.cursor)).toEqual([1, 2, 3, 4]);
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

    /** The tool reads the key before the checks that depend on the room, so it has to be readable without appending. */
    it("reads the record a keyed append left: present after it, null before it, and null under another member's name", async () => {
      const s = session();
      (await store.createSession(s));
      expect(await store.idempotencyRecord(s.id, "m_creator", "send-0001")).toBeNull();

      const first = await store.appendEventOnce(s.id, keyed(), "send-0001");
      if (first.outcome !== "appended") throw new Error(`first send said ${first.outcome}`);

      expect(await store.idempotencyRecord(s.id, "m_creator", "send-0001")).toMatchObject({ cursor: first.event.cursor });
      expect(await store.idempotencyRecord(s.id, "m_joiner", "send-0001")).toBeNull();
      expect(await store.idempotencyRecord(s.id, "m_creator", "send-0002")).toBeNull();
      expect((await store.eventsAfter(s.id, 0)), "reading the record appends nothing").toHaveLength(1);
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

    /**
     * What housekeeping reads (#66): each member's last send, the room's last member
     * event, and the requests still waiting. Kept at the write, in the event's own
     * transaction, so that no scan of the log has to find them later.
     *
     * Applied wherever an event joins the log, and only for a room whose manifest
     * declared housekeeping: a room that did not writes the rows it always did. Like
     * the report stamp above, these cases pin what a caller can see, which is what has
     * to be identical across implementations. The single put is pinned where the fake
     * storage can count puts (tests/store-do-wiring.test.ts).
     */
    describe("housekeeping's books (#66)", () => {
      const HK = {
        quietAfterMs: 7_200_000, answerWithinMs: 1_800_000, idleAfterMs: 86_400_000, repeatAfterMs: null,
      };
      /** A creator and one peer, in a room that declared housekeeping: the only kind that keeps books. */
      const kept = (over: Partial<Session> = {}) =>
        session({
          manifest: roomManifest({ housekeeping: HK }),
          members: [member(), member({ memberId: "m_peer", userId: "u_peer", label: "peer@elsewhere" })],
          ...over,
        });
      const sent = (type: EventBody["type"], by: string, over: Partial<EventBody> = {}): EventBody => ({
        type, fromMemberId: by, fromUserId: by === "m_creator" ? "u_jesse" : "u_peer", fromLabel: by,
        payload: {}, refId: null, ...over,
      });
      const asked = (by = "m_creator") => sent("action_request", by, { payload: { ask: "deploy" } });
      const answered = (cursor: number | string, by = "m_peer") =>
        sent("action_response", by, { refId: String(cursor), payload: { approved: true } });
      /** A tick as the room writes it: no member handle, so nothing a member did. */
      const tick = () => sent("heartbeat", "system", { fromUserId: "system", fromLabel: "bellman" });
      /** The two departures the server authors itself, with the member they are about in the payload. */
      const evicted = (id: string) =>
        sent("member_evicted", "system", { fromUserId: "u_jesse", fromLabel: "jesse", payload: { member_id: id } });
      const timedOut = (id: string) =>
        sent("member_timed_out", "system", { fromUserId: "u_peer", fromLabel: "peer", payload: { member_id: id } });

      const books = async (id: string) => {
        const row = (await store.getSession(id))!;
        const everyone = [...row.members, ...(await store.departedMembers(id)).members];
        return {
          lastSent: Object.fromEntries(everyone.map((m) => [m.memberId, m.lastSentAt])),
          openRequests: row.openRequests,
          lastMemberEventAt: row.lastMemberEventAt,
        };
      };
      const leaving = (id: string, over: Partial<RemovalRequest> = {}): RemovalRequest => ({
        now: 9_000_000, frozen: "allow", cut: false, event: sent("member_left", id, { payload: { label: id } }),
        audit: [], ...over,
      });

      it("stamps the sender and the room at a member event's own time", async () => {
        const s = kept();
        await store.createSession(s);

        const event = (await store.appendEvent(s.id, sent("message", "m_creator", { payload: { text: "hi" } })))!;

        expect(await books(s.id)).toEqual({
          lastSent: { m_creator: event.at, m_peer: undefined },
          openRequests: {},
          lastMemberEventAt: event.at,
        });
      });

      // The design's promise that `lastSentAt` is set at an append and not by a read. A poll stamps `lastSeenAt`
      // through `updateMember` and a tool reads the room with `getSession`; neither is a send, and a member who
      // only watches is quiet (D1). The case would pass for a store that kept no such field at all, so it first
      // shows that the read did stamp what a read stamps.
      it("leaves the sender's last send where the append put it, however the member is seen or the room is read", async () => {
        const s = kept();
        await store.createSession(s);
        const event = (await store.appendEvent(s.id, sent("message", "m_creator", { payload: { text: "hi" } })))!;

        vi.advanceTimersByTime(60_000);
        await store.updateMember(s.id, "m_creator", { lastSeenAt: Date.now() });
        await store.updateMember(s.id, "m_peer", { lastSeenAt: Date.now() });
        await store.getSession(s.id);

        const row = (await store.getSession(s.id))!;
        expect(row.members.map((m) => m.lastSeenAt), "setup: the reads did stamp the members as seen")
          .toEqual([Date.now(), Date.now()]);
        expect(await books(s.id)).toEqual({
          lastSent: { m_creator: event.at, m_peer: undefined },
          openRequests: {},
          lastMemberEventAt: event.at,
        });
      });

      it("keeps the books on the first append of a key, as on a plain append", async () => {
        const s = kept();
        await store.createSession(s);

        const write = await store.appendEventOnce(s.id, sent("message", "m_peer", { payload: { text: "hi" } }), "k-1");
        if (write.outcome !== "appended") throw new Error(`send said ${write.outcome}`);

        expect(await books(s.id)).toEqual({
          lastSent: { m_creator: undefined, m_peer: write.event.at },
          openRequests: {},
          lastMemberEventAt: write.event.at,
        });
      });

      it("moves nothing for an event the server wrote", async () => {
        const s = kept();
        await store.createSession(s);

        await store.appendEvent(s.id, tick());

        expect(await books(s.id)).toEqual({
          lastSent: { m_creator: undefined, m_peer: undefined }, openRequests: {}, lastMemberEventAt: null,
        });
      });

      it("opens a request at its cursor, and closes it on the response that names it", async () => {
        const s = kept();
        await store.createSession(s);

        const request = (await store.appendEvent(s.id, asked()))!;
        const open = { [String(request.cursor)]: { at: request.at, fromMemberId: "m_creator" } };
        expect((await books(s.id)).openRequests).toEqual(open);

        // A response that names no request closes nothing.
        await store.appendEvent(s.id, answered(request.cursor + 50));
        expect((await books(s.id)).openRequests).toEqual(open);

        await store.appendEvent(s.id, answered(request.cursor));
        expect((await books(s.id)).openRequests).toEqual({});
      });

      // Review Focus 5. The record holds the request, so no read of the log, bounded or
      // not, has to find it: a thousand events later it is still waiting.
      it("holds a request through more later events than any bounded read of the log would reach", async () => {
        const s = kept();
        await store.createSession(s);
        const request = (await store.appendEvent(s.id, asked()))!;

        for (let i = 0; i < 1_100; i++) {
          await store.appendEvent(s.id, sent("message", "m_peer", { payload: { text: `m${i}` } }));
        }

        expect((await books(s.id)).openRequests)
          .toEqual({ [String(request.cursor)]: { at: request.at, fromMemberId: "m_creator" } });
      });

      // A replay is a retry of an append that already landed. Re-applying it would put a
      // request back after its answer, and move the last send back behind a later one.
      it("does not apply the books a second time on a replayed key", async () => {
        const s = kept();
        await store.createSession(s);
        const first = await store.appendEventOnce(s.id, asked(), "k-ask");
        if (first.outcome !== "appended") throw new Error(`send said ${first.outcome}`);
        vi.advanceTimersByTime(5_000);
        const response = (await store.appendEvent(s.id, answered(first.event.cursor)))!;
        expect(response.at, "the response is later, or this case proves nothing").toBeGreaterThan(first.event.at);

        const retry = await store.appendEventOnce(s.id, asked(), "k-ask");

        expect(retry.outcome).toBe("replayed");
        expect(await books(s.id)).toEqual({
          lastSent: { m_creator: first.event.at, m_peer: response.at },
          openRequests: {},
          lastMemberEventAt: response.at,
        });
      });

      describe("closing the requests of a member who is gone", () => {
        /** The peer asked, and so did the creator: only the leaver's request may close. */
        const bothAsked = async () => {
          const s = kept();
          await store.createSession(s);
          const theirs = (await store.appendEvent(s.id, asked("m_peer")))!;
          const mine = (await store.appendEvent(s.id, asked("m_creator")))!;
          return { s, theirs, mine };
        };
        const mineOnly = (mine: { cursor: number; at: number }) =>
          ({ [String(mine.cursor)]: { at: mine.at, fromMemberId: "m_creator" } });

        it("on a leave, which the leaver authors, and still records the leave", async () => {
          const { s, mine } = await bothAsked();

          const outcome = await store.removeMember(s.id, "m_peer", leaving("m_peer"));

          expect(outcome.removed).toBe(true);
          const row = (await store.getSession(s.id))!;
          // The books replace the roster's member objects, and the leave must land on the
          // roster that is stored, not on one the append just replaced.
          expect((await store.getMember(s.id, "m_peer"))!.leftAt).toBe(9_000_000);
          expect(row.openRequests).toEqual(mineOnly(mine));
          const departure = (await store.eventsAfter(s.id, 0)).at(-1)!;
          expect(row.lastMemberEventAt, "a member's own leaving is that member's last act").toBe(departure.at);
        });

        it("on an eviction, which the server authors and names the member in its payload", async () => {
          const { s, mine } = await bothAsked();
          const before = (await books(s.id)).lastMemberEventAt;

          const outcome = await store.removeMember(s.id, "m_peer", {
            ...leaving("m_peer"), frozen: "refuse", cut: true, byUserId: "u_jesse", event: evicted("m_peer"),
          });

          expect(outcome.removed).toBe(true);
          const row = (await store.getSession(s.id))!;
          expect(row.openRequests).toEqual(mineOnly(mine));
          expect((await store.getMember(s.id, "m_peer"))!.removedAtCursor).toBeDefined();
          expect(row.lastMemberEventAt, "an eviction is the server's word, not a member's").toBe(before);
        });

        it("on a timeout, which the server authors and names the member in its payload", async () => {
          const { s, mine } = await bothAsked();
          const before = (await books(s.id)).lastMemberEventAt;

          await store.appendEvent(s.id, timedOut("m_peer"));

          const row = (await store.getSession(s.id))!;
          expect(row.openRequests).toEqual(mineOnly(mine));
          expect(row.lastMemberEventAt).toBe(before);
        });
      });

      describe("in a room that declared no housekeeping", () => {
        it("keeps no books on a send, a request or a response", async () => {
          const s = session({
            members: [member(), member({ memberId: "m_peer", userId: "u_peer", label: "peer@elsewhere" })],
          });
          await store.createSession(s);

          await store.appendEvent(s.id, sent("message", "m_creator", { payload: { text: "hi" } }));
          const request = (await store.appendEvent(s.id, asked()))!;
          await store.appendEvent(s.id, asked("m_peer"));
          await store.appendEvent(s.id, answered(request.cursor));

          expect(await books(s.id)).toEqual({
            lastSent: { m_creator: undefined, m_peer: undefined }, openRequests: {}, lastMemberEventAt: null,
          });
        });

        it("keeps none on a removal either, and still records it", async () => {
          const s = session({
            members: [member(), member({ memberId: "m_peer", userId: "u_peer", label: "peer@elsewhere" })],
          });
          await store.createSession(s);

          await store.removeMember(s.id, "m_peer", leaving("m_peer"));

          expect(await books(s.id)).toEqual({
            lastSent: { m_creator: undefined, m_peer: undefined }, openRequests: {}, lastMemberEventAt: null,
          });
          expect((await store.getMember(s.id, "m_peer"))!.leftAt).toBe(9_000_000);
        });
      });
    });

    /**
     * The working surface's rows (#129). The store writes the row it is handed
     * in the event's own transaction, under the monotonic rule in surface.ts,
     * and never asks what a `surface` event means.
     */
    describe("the surface rows", () => {
      const plan = (body = "1. read\n2. write"): SurfaceItem => ({
        key: "plan", kind: "text", title: "Plan", body, ends: null, placement: null, blob: null, shape: null,
      });
      const wrote = (item: SurfaceItem | null = plan()): EventBody => ({
        type: "surface",
        fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd",
        payload: item ?? { key: "plan", remove: true }, refId: null,
      });
      const cursorOf = async (id: string) => surfaceCursor((await store.getSession(id))!);

      it("answers nothing for a room with no surface, and for no room at all", async () => {
        const s = session({});
        await store.createSession(s);
        expect(await store.surfaceOf(s.id)).toEqual([]);
        expect(await store.surfaceOf("qs_nobody")).toEqual([]);
        expect(await cursorOf(s.id)).toBe(0);
      });

      it("writes the row with the event's cursor and moves surfaceCursor, in one append", async () => {
        const s = session({});
        await store.createSession(s);

        const event = (await store.appendEvent(s.id, wrote(), { surface: { key: "plan", item: plan() } }))!;

        expect(await store.surfaceOf(s.id)).toEqual([
          {
            ...plan(), placement: { x: 0, y: 0 }, cursor: event.cursor, at: event.at, createdAt: event.at,
            byMemberId: "m_creator", byLabel: "jesse@codenerd",
          },
        ]);
        expect(await cursorOf(s.id)).toBe(event.cursor);
      });

      // #197: a shape's own field rides the row as a placement does, and the row of any other kind holds null.
      // Both stores keep what they are handed, so the field is read back from each.
      it("keeps a shape item's own field on its row, and the row of any other kind holds null", async () => {
        const s = session({});
        await store.createSession(s);
        const box: SurfaceItem = {
          ...plan(), key: "box", kind: "shape", title: "Group A", body: null,
          placement: { x: 10, y: 20, w: 200, h: 120 }, shape: { form: "arrow", color: "violet", flip: true },
        };

        const event = (await store.appendEvent(s.id, wrote(box), { surface: { key: "box", item: box } }))!;
        await store.appendEvent(s.id, wrote(plan()), { surface: { key: "plan", item: plan() } });

        expect(await store.surfaceOf(s.id)).toEqual([
          { ...box, cursor: event.cursor, at: event.at, createdAt: event.at, byMemberId: "m_creator", byLabel: "jesse@codenerd" },
          expect.objectContaining({ key: "plan", shape: null }),
        ]);
      });

      /** Type-agnostic: a `surface` event with no extra writes no row. */
      it("writes no row when the append does not ask for one", async () => {
        const s = session({});
        await store.createSession(s);
        await store.appendEvent(s.id, wrote());
        expect(await store.surfaceOf(s.id)).toEqual([]);
        expect(await cursorOf(s.id)).toBe(0);
      });

      it("replaces the row on a later write to the same key", async () => {
        const s = session({});
        await store.createSession(s);
        await store.appendEvent(s.id, wrote(), { surface: { key: "plan", item: plan() } });

        const second = (await store.appendEvent(
          s.id, wrote(plan("revised")), { surface: { key: "plan", item: plan("revised") } },
        ))!;

        const rows = await store.surfaceOf(s.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ body: "revised", cursor: second.cursor });
        expect(await cursorOf(s.id)).toBe(second.cursor);
      });

      // Topic rooms spec, D2, in both stores: the approver rides the append beside the write.
      it("keeps who approved a row beside who wrote it, and a later write without an approver drops it", async () => {
        const s = session({});
        await store.createSession(s);
        const approver = { memberId: "m_maint", label: "maint@codenerd" };

        const approved = (await store.appendEvent(s.id, wrote(), { surface: { key: "plan", item: plan() }, approvedBy: approver }))!;
        expect((await store.surfaceOf(s.id))[0]).toMatchObject({ cursor: approved.cursor, byMemberId: "m_creator", approvedBy: approver });

        await store.appendEvent(s.id, wrote(plan("revised")), { surface: { key: "plan", item: plan("revised") } });
        expect("approvedBy" in (await store.surfaceOf(s.id))[0]).toBe(false);
      });

      // `approvedBy` rides with `surface`, and a replay applies no surface write (see the replay cases below), so in
      // both stores the row keeps what the first append stamped and a key removed since stays removed.
      it("keeps the first approver when a keyed write is replayed with another, and puts nothing back once the key is removed", async () => {
        const s = session({});
        await store.createSession(s);
        const first = { memberId: "m_maint", label: "maint@codenerd" };
        const other = { memberId: "m_other", label: "other@codenerd" };
        const send = (approvedBy: typeof first) =>
          store.appendEventOnce(s.id, wrote(), "sf-approve-1", { surface: { key: "plan", item: plan() }, approvedBy });

        const sent = await send(first);
        if (sent.outcome !== "appended") throw new Error(`first write said ${sent.outcome}`);

        const retry = await send(other);
        expect(retry.outcome).toBe("replayed");
        expect((await store.surfaceOf(s.id))[0]).toMatchObject({ cursor: sent.event.cursor, approvedBy: first });

        const gone = (await store.appendEvent(s.id, wrote(null), { surface: { key: "plan", item: null } }))!;
        const again = await send(other);
        expect(again.outcome).toBe("replayed");
        expect(await store.surfaceOf(s.id)).toEqual([]);
        expect(await cursorOf(s.id), "the replay moved nothing").toBe(gone.cursor);
        expect(await store.eventsAfter(s.id, 0)).toHaveLength(2);
      });

      // Room pages spec, D4, in both stores: the time the page orders and dates a post by.
      it("stamps when a key was first written, keeps it across edits, and starts over when the key is removed and written again", async () => {
        const s = session({});
        await store.createSession(s);
        const first = (await store.appendEvent(s.id, wrote(), { surface: { key: "plan", item: plan() } }))!;
        vi.advanceTimersByTime(60_000);
        const edit = (await store.appendEvent(s.id, wrote(plan("revised")), { surface: { key: "plan", item: plan("revised") } }))!;
        expect(edit.at).toBeGreaterThan(first.at);
        expect(await store.surfaceOf(s.id)).toEqual([expect.objectContaining({ createdAt: first.at, at: edit.at })]);

        // A second edit reads the row the first edit left, whose `at` has moved on.
        vi.advanceTimersByTime(60_000);
        const second = (await store.appendEvent(s.id, wrote(plan("revised again")), { surface: { key: "plan", item: plan("revised again") } }))!;
        expect(await store.surfaceOf(s.id)).toEqual([expect.objectContaining({ createdAt: first.at, at: second.at })]);

        vi.advanceTimersByTime(60_000);
        await store.appendEvent(s.id, wrote(null), { surface: { key: "plan", item: null } });
        vi.advanceTimersByTime(60_000);
        const again = (await store.appendEvent(s.id, wrote(), { surface: { key: "plan", item: plan() } }))!;
        expect(again.at).toBeGreaterThan(edit.at);
        expect(await store.surfaceOf(s.id)).toEqual([expect.objectContaining({ createdAt: again.at, at: again.at })]);
      });

      it("sorts rows by key", async () => {
        const s = session({});
        await store.createSession(s);
        for (const key of ["zeta", "alpha", "mid"]) {
          const item = { ...plan(), key };
          await store.appendEvent(s.id, wrote(item), { surface: { key, item } });
        }
        expect((await store.surfaceOf(s.id)).map((r) => r.key)).toEqual(["alpha", "mid", "zeta"]);
      });

      // A surface key may carry a hyphen. "-" is 0x2D, the digits 0x30-0x39, "_" 0x5F and the letters after, and both
      // stores sort that way (`<` on the keys; the storage's `list` by the bytes of `sf:<key>`). `localeCompare` puts
      // "_" before "-", so a store that used it would lay the canvas out differently for the same room.
      it("sorts rows by key in code-unit order, a hyphen before a digit and a digit before an underscore", async () => {
        const s = session({});
        await store.createSession(s);
        for (const key of ["ab", "a_b", "a1", "a-b", "a-"]) {
          const item = { ...plan(), key };
          await store.appendEvent(s.id, wrote(item), { surface: { key, item } });
        }
        expect((await store.surfaceOf(s.id)).map((r) => r.key)).toEqual(["a-", "a-b", "a1", "a_b", "ab"]);
      });

      it("removes the row and moves the cursor; removing nothing moves neither", async () => {
        const s = session({});
        await store.createSession(s);
        await store.appendEvent(s.id, wrote(), { surface: { key: "plan", item: plan() } });

        const gone = (await store.appendEvent(s.id, wrote(null), { surface: { key: "plan", item: null } }))!;
        expect(await store.surfaceOf(s.id)).toEqual([]);
        expect(await cursorOf(s.id)).toBe(gone.cursor);

        const again = (await store.appendEvent(s.id, wrote(null), { surface: { key: "plan", item: null } }))!;
        expect(again.cursor).toBeGreaterThan(gone.cursor);
        expect(await cursorOf(s.id), "a removal of nothing is not a change").toBe(gone.cursor);
      });

      /**
       * A replay applies no surface write (the row went in with the event), so it
       * neither duplicates the event nor moves the row: one event per key, and the
       * newest write stands.
       */
      it("replays through appendEventOnce without duplicating or regressing", async () => {
        const s = session({});
        await store.createSession(s);
        const first = await store.appendEventOnce(
          s.id, wrote(), "sf-0001", { surface: { key: "plan", item: plan() } },
        );
        if (first.outcome !== "appended") throw new Error(`first write said ${first.outcome}`);

        const newer = (await store.appendEvent(
          s.id, wrote(plan("newer")), { surface: { key: "plan", item: plan("newer") } },
        ))!;

        const retry = await store.appendEventOnce(
          s.id, wrote(), "sf-0001", { surface: { key: "plan", item: plan() } },
        );
        expect(retry.outcome).toBe("replayed");

        const rows = await store.surfaceOf(s.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ body: "newer", cursor: newer.cursor });
        expect(await cursorOf(s.id)).toBe(newer.cursor);
        expect(await store.eventsAfter(s.id, 0)).toHaveLength(2);
      });

      /**
       * A removal leaves no tombstone, so a replay that applied the original write
       * would see no row, accept the older cursor, and put back what was removed.
       * The row went in with the event, so a replay has nothing to repair and
       * applies no surface write at all.
       */
      it("a replay after a removal does not resurrect the row", async () => {
        const s = session({});
        await store.createSession(s);
        const first = await store.appendEventOnce(
          s.id, wrote(), "sf-0001", { surface: { key: "plan", item: plan() } },
        );
        if (first.outcome !== "appended") throw new Error(`first write said ${first.outcome}`);

        const gone = (await store.appendEvent(s.id, wrote(null), { surface: { key: "plan", item: null } }))!;
        expect(await store.surfaceOf(s.id)).toEqual([]);

        const retry = await store.appendEventOnce(
          s.id, wrote(), "sf-0001", { surface: { key: "plan", item: plan() } },
        );

        expect(retry.outcome).toBe("replayed");
        expect(await store.surfaceOf(s.id)).toEqual([]);
        expect(await cursorOf(s.id), "the replay moved nothing").toBe(gone.cursor);
        expect(await store.eventsAfter(s.id, 0)).toHaveLength(2);
      });

      it("hands back detached rows", async () => {
        const s = session({});
        await store.createSession(s);
        await store.appendEvent(s.id, wrote(), { surface: { key: "plan", item: plan() } });

        const [row] = await store.surfaceOf(s.id);
        row.body = "scribbled on";

        expect((await store.surfaceOf(s.id))[0].body).toBe("1. read\n2. write");
      });

      /**
       * The write side of "hands back detached rows". The item an append is given
       * holds objects of its own (`placement`, `ends`), and a caller that keeps a
       * reference to them must not be able to reach into the stored row. The
       * Durable Object store gets that from the RPC boundary; MemoryStore has to
       * copy on the way in, as it does for the event.
       */
      it("stores a copy of what it is handed, not the caller's own objects", async () => {
        const s = session({});
        await store.createSession(s);
        const placement = { x: 1, y: 2, w: 3, h: 4 };
        const ends = { from: "plan", to: "risks" };
        const item: SurfaceItem = { ...plan(), key: "edge", kind: "connector", ends, placement };
        await store.appendEvent(s.id, wrote(item), { surface: { key: "edge", item } });

        placement.x = 999;
        ends.to = "scribbled on";

        const [row] = await store.surfaceOf(s.id);
        expect(row.placement).toEqual({ x: 1, y: 2, w: 3, h: 4 });
        expect(row.ends).toEqual({ from: "plan", to: "risks" });
      });

      it("writes neither event nor row into a frozen room", async () => {
        const s = session({ frozenAt: 1 });
        await store.createSession(s);
        expect(await store.appendEvent(s.id, wrote(), { surface: { key: "plan", item: plan() } })).toBeNull();
        expect(await store.surfaceOf(s.id)).toEqual([]);
        expect(await cursorOf(s.id)).toBe(0);
      });

      /**
       * A card that arrives with no placement is placed in the append's own transaction, from the rows the
       * room holds (surface placement spec D3), and the event carries the placement the row does. `withPlacement`
       * in surface.ts is the rule and tests/working-surface.test.ts its cases; these hold both stores to
       * applying it, and to doing so inside the append, where a retry and a second writer are decided.
       */
      describe("placing what arrives with no placement", () => {
        const SHAPE = { form: "rect", color: "slate", flip: false } as const;
        const card = (key: string, over: Partial<SurfaceItem> = {}): SurfaceItem => ({ ...plan(), key, ...over });
        const put = (id: string, item: SurfaceItem) =>
          store.appendEvent(id, wrote(item), { surface: { key: item.key, item } });
        const placements = async (id: string) =>
          Object.fromEntries((await store.surfaceOf(id)).map((r) => [r.key, r.placement]));
        const room = async () => {
          const s = session({});
          await store.createSession(s);
          return s.id;
        };

        it("places a card at slot 0 and the next at slot 1, in the row and in the event", async () => {
          const id = await room();
          await put(id, card("a"));
          await put(id, card("b"));

          expect(await placements(id)).toEqual({ a: { x: 0, y: 0 }, b: { x: 360, y: 0 } });
          expect((await store.eventsAfter(id, 0)).map((e) => e.payload)).toEqual([
            expect.objectContaining({ key: "a", placement: { x: 0, y: 0 } }),
            expect.objectContaining({ key: "b", placement: { x: 360, y: 0 } }),
          ]);
        });

        /** Review Focus 3: a card of w 720 covers two cells. */
        it("skips the two slots a card of w 720 covers", async () => {
          const id = await room();
          await put(id, card("wide", { placement: { x: 0, y: 0, w: 720 } }));
          await put(id, card("a"));
          expect((await placements(id)).a).toEqual({ x: 720, y: 0 });
        });

        /** Review Focus 3: a shape's box covers the cells under it. */
        it("skips the slots under a shape's box", async () => {
          const id = await room();
          await put(id, card("group", { kind: "shape", body: null, title: "Phase 1", shape: SHAPE, placement: { x: 0, y: 0, w: 360, h: 680 } }));
          await put(id, card("a"));
          await put(id, card("b"));
          expect(await placements(id)).toMatchObject({ a: { x: 360, y: 0 }, b: { x: 720, y: 0 } });
        });

        it("gives a connector no slot, and it takes none", async () => {
          const id = await room();
          await put(id, card("a"));
          await put(id, card("link", { kind: "connector", body: null, ends: { from: "a", to: "b" } }));
          await put(id, card("b"));
          expect(await placements(id)).toEqual({ a: { x: 0, y: 0 }, b: { x: 360, y: 0 }, link: null });
        });

        /** Review Focus 3: a placement the writer gives is stored as given, over a box that is there (R5). */
        it("stores a placement as given, over a box that is there, and the next card avoids both", async () => {
          const id = await room();
          await put(id, card("a", { placement: { x: 0, y: 0 } }));
          await put(id, card("b", { placement: { x: 0, y: 0 } }));
          await put(id, card("c"));
          expect(await placements(id)).toEqual({ a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, c: { x: 360, y: 0 } });
        });

        /** Review Focus 2: replacing a card moves nothing, in the row or in the log, though a lower slot has freed since. */
        it("keeps the stored placement when a write replaces a card and leaves it out", async () => {
          const id = await room();
          await put(id, card("x"));
          await put(id, card("a"));
          await store.appendEvent(id, { ...wrote(), payload: { key: "x", remove: true } }, { surface: { key: "x", item: null } });

          const replaced = (await put(id, card("a", { body: "revised" })))!;

          expect(await placements(id)).toEqual({ a: { x: 360, y: 0 } });
          expect((await store.surfaceOf(id))[0]).toMatchObject({ body: "revised", cursor: replaced.cursor });
          expect(replaced.payload).toMatchObject({ key: "a", body: "revised", placement: { x: 360, y: 0 } });
        });

        /**
         * Review Focus 1. A shape is stored as it is handed, so shapes with no placement stand in for rows from
         * before the server placed anything. The viewers draw old_a and old_c on slots 0 and 1, counting only the
         * rows with none, and old_b sits on slot 2: a new card must not land on any of the three.
         */
        it("keeps clear of the rows stored with no placement, which the viewers draw on the grid", async () => {
          const id = await room();
          const old = (key: string, placement: SurfaceItem["placement"]) =>
            card(key, { kind: "shape", body: null, shape: SHAPE, placement });
          await put(id, old("old_a", null));
          await put(id, old("old_b", { x: 720, y: 0, w: 320, h: 200 }));
          await put(id, old("old_c", null));
          await put(id, card("z"));
          expect((await placements(id)).z).toEqual({ x: 1080, y: 0 });
        });

        /** Review Focus 5. */
        it("places a card after 64 occupied slots at slot 64", async () => {
          const id = await room();
          for (let i = 0; i < MAX_SURFACE_ITEMS; i++) await put(id, card(`c${i}`));
          await put(id, card("last"));
          const placed = await placements(id);
          expect(placed.c63).toEqual(gridSlot(63));
          expect(placed.last).toEqual(gridSlot(MAX_SURFACE_ITEMS));
        });

        /** Review Focus 5: a box with no upper bound covers every slot, and the append still returns. */
        it("leaves a card unplaced, and returns, when one box covers every slot the search tries", async () => {
          const id = await room();
          await put(id, card("sky", { kind: "shape", body: null, shape: SHAPE, placement: { x: 0, y: 0, w: 1e300, h: 1e300 } }));
          const out = (await put(id, card("a")))!;
          expect((await placements(id)).a).toBeNull();
          expect(out.payload).toMatchObject({ key: "a", placement: null });
        });

        it("gives two writes that land together two slots", async () => {
          const id = await room();
          await Promise.all([put(id, card("a")), put(id, card("b"))]);
          const placed = await placements(id);
          expect([placed.a, placed.b]).toEqual(expect.arrayContaining([{ x: 0, y: 0 }, { x: 360, y: 0 }]));
        });

        /**
         * Review Focus 4. The retry's fingerprint is its draft's, which carries no placement, so a retry
         * reads as a retry however the room has filled or emptied since, and the replay takes no slot.
         */
        it("places once: a retry of the same write replays whatever has landed since", async () => {
          const id = await room();
          const first = await store.appendEventOnce(id, wrote(), "sf-0001", { surface: { key: "plan", item: plan() } });
          if (first.outcome !== "appended") throw new Error(`first write said ${first.outcome}`);
          expect(first.event.payload).toMatchObject({ key: "plan", placement: { x: 0, y: 0 } });
          // The card is removed and another takes its slot, so a retry that placed itself again would pick slot 1.
          await store.appendEvent(id, wrote(null), { surface: { key: "plan", item: null } });
          await put(id, card("c"));

          const retry = await store.appendEventOnce(id, wrote(), "sf-0001", { surface: { key: "plan", item: plan() } });

          if (retry.outcome !== "replayed") throw new Error(`the retry said ${retry.outcome}`);
          expect(retry.event).toEqual(first.event);
          expect(await placements(id), "the removed card stays removed, and c keeps slot 0").toEqual({ c: { x: 0, y: 0 } });
        });
      });
    });

    /**
     * Approving a proposal (topic rooms spec, D2): the response and the card are one transaction.
     * `decideApproval` in proposal.ts is the rule; these hold both stores to applying it inside the response's
     * append, where a second approval and a retry are decided.
     */
    describe("approving a proposal (topic rooms spec, D2)", () => {
      const MAINT = member({ memberId: "m_maint", userId: "u_jesse", label: "jesse@codenerd", roomRole: "maintainer" });
      const MAINT2 = member({ memberId: "m_maint2", userId: "u_second", label: "second@codenerd", roomRole: "maintainer" });
      const ADA = member({ memberId: "m_ada", userId: "u_ada", label: "ada@lovelace", roomRole: "contributor" });
      const topic = () => resolveManifest({ room: "mcp", preset: "topic", public: true });
      const room = async (over: NonNullable<Parameters<typeof session>[0]> = {}) => {
        const s = session({ manifest: topic(), members: [MAINT, MAINT2, ADA], ...over });
        await store.createSession(s);
        return s.id;
      };
      const card = (body = "See https://modelcontextprotocol.io/specification"): SurfaceItem => ({
        key: "tools", kind: "text", title: "Tools", body, ends: null, placement: { x: 0, y: 0 }, blob: null, shape: null,
      });
      const writeOf = (item: SurfaceItem | null = card()) => ({ key: "tools", item });
      const proposed = (id: string, item: SurfaceItem | { key: string; remove: true } = card(), base = 0) =>
        store.appendEvent(id, {
          type: "action_request", fromMemberId: "m_ada", fromUserId: "u_ada", fromLabel: "ada@lovelace",
          payload: { kind: "surface_proposal", item, base }, refId: null,
        }, { stampActionRequest: true });
      const answer = (cursor: number, by = MAINT): EventBody => ({
        type: "action_response", fromMemberId: by.memberId, fromUserId: by.userId, fromLabel: by.label,
        payload: { approved: true }, refId: String(cursor),
      });
      const approve = (id: string, request: SessionEvent, over: Partial<ProposalApproval> = {}, key: string | null = null, by = MAINT) =>
        store.approveProposal(id, answer(request.cursor, by), key, { requestCursor: request.cursor, base: 0, write: writeOf(), ...over });
      const direct = (id: string, item: SurfaceItem | null, by = MAINT) =>
        store.appendEvent(id, {
          type: "surface", fromMemberId: by.memberId, fromUserId: by.userId, fromLabel: by.label,
          payload: item ?? { key: "tools", remove: true }, refId: null,
        }, { surface: { key: "tools", item } });
      const events = (id: string) => store.eventsAfter(id, 0);
      const landed = (out: Awaited<ReturnType<typeof approve>>) => {
        if (out.outcome !== "appended") throw new Error(`the approval said ${out.outcome}`);
        return out;
      };

      it("writes the response and the card together: the card authored by the proposer and approved by the approver, at the next cursor", async () => {
        const id = await room();
        const request = (await proposed(id))!;
        const out = landed(await approve(id, request));
        expect(out.event.cursor).toBe(request.cursor + 1);
        expect(out.written).toMatchObject({ type: "surface", cursor: request.cursor + 2, fromMemberId: "m_ada", fromLabel: "ada@lovelace", payload: card() });
        expect(out.written!.refId, "the card carries no refId (R30)").toBeNull();
        expect(await store.surfaceOf(id)).toEqual([expect.objectContaining({
          ...card(), cursor: out.written!.cursor, at: out.written!.at,
          byMemberId: "m_ada", byLabel: "ada@lovelace", approvedBy: { memberId: "m_maint", label: "jesse@codenerd" },
        })]);
        expect(surfaceCursor((await store.getSession(id))!)).toBe(out.written!.cursor);
        const next = (await direct(id, card("later")))!;
        expect(next.cursor, "the next append takes the cursor after the card's").toBe(out.written!.cursor + 1);
      });

      it("removes a card when a removal is approved, and the card's event says so", async () => {
        const id = await room();
        const added = (await direct(id, card()))!;
        const request = (await proposed(id, { key: "tools", remove: true }, added.cursor))!;
        const out = landed(await approve(id, request, { base: added.cursor, write: writeOf(null) }));
        expect(out.written!.payload).toEqual({ key: "tools", remove: true });
        expect(await store.surfaceOf(id)).toEqual([]);
      });

      // Review Focus 1: another approval landed first, so the key's cursor is past base.
      it("refuses an approval whose base is behind the card, naming the card's cursor, and writes nothing", async () => {
        const id = await room();
        const first = (await proposed(id, card("First. https://example.com/1")))!;
        const second = (await proposed(id, card("Second. https://example.com/2")))!;
        const done = landed(await approve(id, first, { write: writeOf(card("First. https://example.com/1")) }));
        const before = await events(id);

        const out = await approve(id, second, { write: writeOf(card("Second. https://example.com/2")) });

        expect(out).toEqual({ outcome: "stale", cursor: done.written!.cursor });
        expect(await events(id)).toEqual(before);
        expect((await store.surfaceOf(id))[0].body).toBe("First. https://example.com/1");
        expect(actionStates(await events(id), Date.now(), true).get(second.cursor), "the proposal is still open").toBe("outstanding");
      });

      // Review Focus 5 (R16): a removal leaves no tombstone, so the log is what says the key moved.
      it("refuses an approval for a key that was removed after base, naming the removal", async () => {
        const id = await room();
        const added = (await direct(id, card()))!;
        const request = (await proposed(id, card("An edit. https://example.com/e"), added.cursor))!;
        const gone = (await direct(id, null))!;

        const out = await approve(id, request, { base: added.cursor, write: writeOf(card("An edit. https://example.com/e")) });

        expect(out).toEqual({ outcome: "stale", cursor: gone.cursor });
        expect(await store.surfaceOf(id)).toEqual([]);
      });

      it("does not call a new card stale because another key moved", async () => {
        const id = await room();
        const request = (await proposed(id))!;
        const other: SurfaceItem = { ...card(), key: "other" };
        await store.appendEvent(id, {
          type: "surface", fromMemberId: "m_maint", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: other, refId: null,
        }, { surface: { key: "other", item: other } });
        expect((await approve(id, request)).outcome).toBe("appended");
      });

      // Review Focus 1: two approvals that meet. The tool's own check for an earlier answer reads before it appends and cannot stop this.
      it("applies one of two approvals that meet, and refuses the other as answered, with one card and one response", async () => {
        const id = await room();
        const request = (await proposed(id))!;
        const outs = await Promise.all([approve(id, request), approve(id, request, {}, null, MAINT2)]);
        expect(outs.map((o) => o.outcome).sort()).toEqual(["answered", "appended"]);
        const won = landed(outs.find((o) => o.outcome === "appended")!);
        expect(outs.find((o) => o.outcome === "answered")).toEqual({ outcome: "answered", by: won.event.fromLabel });
        const log = await events(id);
        expect(log.filter((e) => e.type === "action_response")).toHaveLength(1);
        expect(log.filter((e) => e.type === "surface")).toHaveLength(1);
        expect(await store.surfaceOf(id)).toHaveLength(1);
      });

      // Review Focus 2 (R13): the preset gives both verbs to the maintainer, so the room is built with one taken away.
      it("records the response of a seat that holds respond_actions without write_surface, and applies nothing", async () => {
        const base = topic();
        const manifest = {
          ...base,
          roles: { ...base.roles, maintainer: { ...base.roles.maintainer, can: base.roles.maintainer.can.filter((v) => v !== "write_surface") } },
        };
        const id = await room({ manifest });
        const request = (await proposed(id))!;
        const out = landed(await approve(id, request));
        expect(out.written).toBeNull();
        expect((await events(id)).map((e) => e.type)).toEqual(["action_request", "action_response"]);
        expect(await store.surfaceOf(id)).toEqual([]);
        expect(surfaceCursor((await store.getSession(id))!)).toBe(0);
        expect(actionStates(await events(id), Date.now(), true).get(request.cursor), "the derivation reads the response alone").toBe("answered");
      });

      it("records the response alone in a room that is not a topic room, though the approver holds write_surface", async () => {
        const lead = { ...MAINT, roomRole: "lead" };
        const id = await room({ manifest: resolveManifest({ room: "s", preset: "swarm" }), members: [lead, { ...ADA, roomRole: "helper" }] });
        const request = (await proposed(id))!;
        const out = landed(await approve(id, request, {}, null, lead));
        expect(out.written).toBeNull();
        expect(await store.surfaceOf(id)).toEqual([]);
      });

      // Review Focus 1, R21: the key names the response, so a retry replays it however the room has changed.
      it("replays a keyed approval after the room changed: the same response, no second write, and no stale", async () => {
        const id = await room();
        const request = (await proposed(id))!;
        const first = landed(await approve(id, request, {}, "ap-0001"));
        await direct(id, card("changed after"));
        const log = await events(id);

        const retry = await approve(id, request, {}, "ap-0001");

        expect(retry).toEqual({ outcome: "replayed", event: first.event, written: first.written });
        expect(await events(id)).toEqual(log);
        expect((await store.surfaceOf(id))[0].body).toBe("changed after");
      });

      // The record names the card by its own cursor: the event after the response can be anyone's when no card was written.
      it("a replayed approval returns the card it wrote, and null when it wrote none", async () => {
        const id = await room();
        const request = (await proposed(id))!;
        const first = landed(await approve(id, request, {}, "ap-0001"));
        expect(first.written, "the premise: the approval wrote a card").not.toBeNull();
        const retry = await approve(id, request, {}, "ap-0001");
        expect(retry).toEqual({ outcome: "replayed", event: first.event, written: first.written });

        const lead = { ...MAINT, roomRole: "lead" };
        const bare = await room({ id: "qs_bare", manifest: resolveManifest({ room: "s", preset: "swarm" }), members: [lead, { ...ADA, roomRole: "helper" }] });
        const ask = (await proposed(bare))!;
        const alone = landed(await approve(bare, ask, {}, "ap-0002", lead));
        expect(alone.written).toBeNull();
        // Someone else's event lands right after the response, where a read of `cursor + 1` would find it.
        await store.appendEvent(bare, {
          type: "message", fromMemberId: "m_ada", fromUserId: "u_ada", fromLabel: "ada@lovelace", payload: { text: "after" }, refId: null,
        });
        expect(await approve(bare, ask, {}, "ap-0002", lead)).toEqual({ outcome: "replayed", event: alone.event, written: null });
      });

      it("reports a conflict for a key reused with a different response, and writes nothing", async () => {
        const id = await room();
        const request = (await proposed(id))!;
        landed(await approve(id, request, {}, "ap-0001"));
        const log = await events(id);
        const other = { ...answer(request.cursor), payload: { approved: true, result: "a different note" } };
        const out = await store.approveProposal(id, other, "ap-0001", { requestCursor: request.cursor, base: 0, write: writeOf() });
        expect(out).toEqual({ outcome: "conflict" });
        expect(await events(id)).toEqual(log);
      });

      it("writes neither response nor card into a room that froze after the proposal", async () => {
        const id = await room();
        const request = (await proposed(id))!;
        await store.freezeSession(id, 1);
        expect(await approve(id, request)).toEqual({ outcome: "frozen" });
        expect(await events(id)).toHaveLength(1);
        expect(await store.surfaceOf(id)).toEqual([]);
      });

      // Surface placement: the approved item goes through the same step as any write, so an unplaced one takes a slot.
      it("places an item the proposer left unplaced, in the row and in the card's event", async () => {
        const id = await room();
        const unplaced = { ...card(), placement: null };
        const request = (await proposed(id, unplaced))!;
        const out = landed(await approve(id, request, { write: writeOf(unplaced) }));
        expect((await store.surfaceOf(id))[0].placement).toEqual({ x: 0, y: 0 });
        expect(out.written!.payload).toMatchObject({ key: "tools", placement: { x: 0, y: 0 } });
      });

      // What the store's docs promise beyond the cases above.

      // The Durable Objects store reads the members present and MemoryStore keeps those who left on the roster with
      // `leftAt` set, so only a case that makes a member leave holds the two to reading "on the roster" the same way.
      it("records the response of an approver who has left the room, and applies nothing", async () => {
        const id = await room();
        const request = (await proposed(id))!;
        await store.removeMember(id, "m_maint2", {
          now: Date.now(), frozen: "allow", cut: false, audit: [],
          event: { type: "member_left", fromMemberId: "m_maint2", fromUserId: "u_second", fromLabel: "second@codenerd", payload: { label: "second@codenerd" }, refId: null },
        });
        const out = landed(await approve(id, request, {}, null, MAINT2));
        expect(out.written).toBeNull();
        expect(await store.surfaceOf(id)).toEqual([]);
      });

      it("replays a keyed approval that was recorded alone", async () => {
        const lead = { ...MAINT, roomRole: "lead" };
        const id = await room({ manifest: resolveManifest({ room: "s", preset: "swarm" }), members: [lead, { ...ADA, roomRole: "helper" }] });
        const request = (await proposed(id))!;
        const first = landed(await approve(id, request, {}, "ap-0001", lead));
        const log = await events(id);
        expect(await approve(id, request, {}, "ap-0001", lead)).toEqual({ outcome: "replayed", event: first.event, written: null });
        expect(await events(id)).toEqual(log);
      });

      // The response and the card are one write: a reader that lands beside it sees both events or neither.
      it("shows a reader the response and the card together or not at all", async () => {
        const id = await room();
        const request = (await proposed(id))!;
        const [, seen] = await Promise.all([approve(id, request), events(id)]);
        expect(seen.filter((e) => e.type === "action_response")).toHaveLength(seen.filter((e) => e.type === "surface").length);
      });

      // A topic room may still declare housekeeping (plan R2), and a response closes the request it answers in the
      // books (#66). Both stores run the books over each event the approval writes, and a case that never declared
      // housekeeping would not see the Durable Objects store skip them.
      const HK = { quietAfterMs: 7_200_000, answerWithinMs: 1_800_000, idleAfterMs: 86_400_000, repeatAfterMs: null };
      const closesTheRequest = async (id: string, out: Extract<Awaited<ReturnType<typeof approve>>, { outcome: "appended" }>) => {
        const after = (await store.getSession(id))!;
        expect(after.openRequests).toEqual({});
        expect(after.members.find((m) => m.memberId === out.event.fromMemberId)!.lastSentAt).toBe(out.event.at);
      };
      const onTheBooks = async (id: string, request: SessionEvent) =>
        expect((await store.getSession(id))!.openRequests, "the premise: the proposal is on the books").toHaveProperty(String(request.cursor));

      it("runs the room's books over the approval: the request leaves the open requests and the approver is stamped", async () => {
        const id = await room({ manifest: { ...topic(), housekeeping: HK } });
        const request = (await proposed(id))!;
        await onTheBooks(id, request);
        await closesTheRequest(id, landed(await approve(id, request)));
      });

      it("runs the room's books over a response recorded alone", async () => {
        const lead = { ...MAINT, roomRole: "lead" };
        const manifest = { ...resolveManifest({ room: "s", preset: "swarm" }), housekeeping: HK };
        const id = await room({ manifest, members: [lead, { ...ADA, roomRole: "helper" }] });
        const request = (await proposed(id))!;
        await onTheBooks(id, request);
        const out = landed(await approve(id, request, {}, null, lead));
        expect(out.written).toBeNull();
        await closesTheRequest(id, out);
      });

      it("leaves no record of the key when it refuses as answered, so the retry runs again", async () => {
        const id = await room();
        const request = (await proposed(id))!;
        landed(await approve(id, request));
        const log = await events(id);
        const refused = { outcome: "answered", by: MAINT.label };
        expect(await approve(id, request, {}, "ap-0002", MAINT2)).toEqual(refused);
        expect(await approve(id, request, {}, "ap-0002", MAINT2)).toEqual(refused);
        expect(await events(id)).toEqual(log);
      });

      it("throws for a request cursor that holds no action_request, and writes nothing", async () => {
        const id = await room();
        const said = (await store.appendEvent(id, {
          type: "message", fromMemberId: "m_ada", fromUserId: "u_ada", fromLabel: "ada@lovelace", payload: { text: "hi" }, refId: null,
        }))!;
        const log = await events(id);
        for (const cursor of [99, said.cursor]) {
          await expect(
            store.approveProposal(id, answer(cursor), null, { requestCursor: cursor, base: 0, write: writeOf() }),
          ).rejects.toThrow(/action_request/);
        }
        expect(await events(id)).toEqual(log);
      });
    });

    /**
     * The quota's bound (#183, D3). The read of the total and the write that
     * raises it are one operation, decided in the room object; the route's
     * pre-check is a courtesy. The store charges bytes it is handed and never
     * asks what they are for.
     */
    describe("charging a room for its blobs", () => {
      const used = async (id: string) => blobBytesUsed((await store.getSession(id))!);

      it("reads 0 off a room never charged, and charges to the room's own ceiling", async () => {
        const s = session({ blobBytesCeiling: 100 });
        await store.createSession(s);
        expect(await used(s.id)).toBe(0);
        expect(await store.chargeBlobBytes(s.id, 60)).toEqual({ ok: true, used: 60 });
        expect(await store.chargeBlobBytes(s.id, 40)).toEqual({ ok: true, used: 100 });
        expect(await used(s.id)).toBe(100);
      });

      it("refuses past the ceiling, reports the total, and charges nothing for a refusal", async () => {
        const s = session({ blobBytesCeiling: 100 });
        await store.createSession(s);
        await store.chargeBlobBytes(s.id, 90);
        expect(await store.chargeBlobBytes(s.id, 11)).toEqual({ ok: false, reason: "over_quota", used: 90 });
        expect(await used(s.id)).toBe(90);
        // The controls: the ten that fit exactly land, and the ceiling is this
        // room's own — a roomier record takes what this one refused.
        expect(await store.chargeBlobBytes(s.id, 10)).toEqual({ ok: true, used: 100 });
        const roomy = session({ id: "qs_roomy", blobBytesCeiling: 1_000 });
        await store.createSession(roomy);
        expect(await store.chargeBlobBytes(roomy.id, 101)).toEqual({ ok: true, used: 101 });
      });

      it("refuses a frozen room and a closed one, with the total", async () => {
        const s = session({ blobBytesCeiling: 100 });
        await store.createSession(s);
        await store.chargeBlobBytes(s.id, 5);
        await store.freezeSession(s.id, Date.now());
        expect(await store.chargeBlobBytes(s.id, 1)).toEqual({ ok: false, reason: "frozen", used: 5 });
        await store.freezeSession(s.id, null);
        await store.closeSession(s.id);
        expect(await store.chargeBlobBytes(s.id, 1)).toEqual({ ok: false, reason: "closed", used: 5 });
        expect(await used(s.id)).toBe(5);
      });

      // Closed wins over frozen, as in closeIfEmpty (src/rooms.ts): "frozen" tells the caller to restore the plan, which cannot reopen a room that is over.
      it("reads a room that is both frozen and closed as closed", async () => {
        const s = session({ blobBytesCeiling: 100 });
        await store.createSession(s);
        await store.chargeBlobBytes(s.id, 5);
        await store.freezeSession(s.id, Date.now());
        await store.closeSession(s.id);
        expect(await store.chargeBlobBytes(s.id, 1)).toEqual({ ok: false, reason: "closed", used: 5 });
      });

      it("answers not_found for a room that does not exist", async () => {
        expect(await store.chargeBlobBytes("qs_nobody", 1)).toEqual({ ok: false, reason: "not_found", used: 0 });
      });

      // Against MemoryStore this reaches `closeIfAbandoned`. Against the Durable Object it
      // reaches `s.closed` and not the abandonment read: the alarm has closed a room created
      // already abandoned before the charge arrives. The abandoned room with the alarm still to
      // come, which is what `readsClosed` answers for, is pinned in worker-tests/blob-charge.test.ts.
      it("reads an abandoned room as closed", async () => {
        const s = session({ members: [member({ lastSeenAt: Date.now() - ABANDONED_AFTER_MS - 1 })] });
        await store.createSession(s);
        expect(await store.chargeBlobBytes(s.id, 1)).toMatchObject({ ok: false, reason: "closed" });
      });
    });

    // ------------------------------------------------ the hosted seat's meter
    /**
     * The seat's send and the charge are one write (hosted seat spec, D3): a
     * refused wake appends nothing and charges nothing, and a month that turns
     * starts the count again.
     */
    describe("appendHostEvent", () => {
      const NOW = () => Date.now();
      const hostedRoom = (over: Partial<Session> = {}) => {
        const m = hostedManifest();
        // As if its host had just asked: a host that has never asked is due the moment its room
        // starts, and the Durable Object's alarm would fire that question into these cases.
        return session({ manifest: m, members: [member(), hostMember(m, NOW())], hostUnitsPerMonth: 10,
          hostUnits: { month: monthKey(NOW()), used: 0, wakes: [] }, lastTickAt: NOW(), lastHostTickAt: NOW(), ...over });
      };
      /** What the host writes on a tick: a thread root, the tick's cursor in its payload (I1). */
      const question = (): Omit<SessionEvent, "cursor" | "at"> => ({
        type: "message", fromMemberId: HOST_MEMBER_ID, fromUserId: HOST_USER_ID, fromLabel: "host@bellman",
        payload: { kind: "question", text: "What shipped?", tick: 1 }, refId: null,
      });

      it("appends the event and charges the units in one write", async () => {
        const s = hostedRoom();
        await store.createSession(s);
        const r = await store.appendHostEvent(s.id, question(), 3, NOW(), "host:tick:1");
        expect(r).toMatchObject({ ok: true, event: { fromMemberId: HOST_MEMBER_ID, refId: null } });
        const after = (await store.getSession(s.id))!;
        expect(after.hostUnits.used).toBe(3);
        expect(after.hostUnits.wakes).toHaveLength(1);
        expect((await store.eventsAfter(s.id, 0)).map((e) => e.fromMemberId)).toEqual([HOST_MEMBER_ID]);
      });

      it("refuses a wake that would cross the month's units, appending nothing", async () => {
        const s = hostedRoom({ hostUnits: { month: monthKey(NOW()), used: 8, wakes: [] } });
        await store.createSession(s);
        expect(await store.appendHostEvent(s.id, question(), 3, NOW(), "host:tick:1")).toEqual({ ok: false, reason: "units", used: 8, allowed: 10 });
        expect(await store.eventsAfter(s.id, 0)).toEqual([]);
        expect((await store.getSession(s.id))!.hostUnits.used).toBe(8);
      });

      it("a new month starts the count again", async () => {
        const s = hostedRoom({ hostUnits: { month: "2026-09", used: 10, wakes: [] } });
        await store.createSession(s);
        const r = await store.appendHostEvent(s.id, question(), 1, NOW(), "host:tick:1");
        expect(r.ok).toBe(true);
        expect((await store.getSession(s.id))!.hostUnits).toMatchObject({ month: monthKey(NOW()), used: 1 });
      });

      it("refuses the ninth wake in an hour, and forgets wakes older than an hour", async () => {
        const recent = Array.from({ length: WAKES_PER_HOUR }, (_, i) => NOW() - i * 60_000);
        const s = hostedRoom({ hostUnits: { month: monthKey(NOW()), used: 0, wakes: recent } });
        await store.createSession(s);
        expect(await store.appendHostEvent(s.id, question(), 1, NOW(), "host:tick:1")).toMatchObject({ ok: false, reason: "hourly" });
        const old = recent.map((t) => t - 3_600_000 - 1);
        const s2 = hostedRoom({ id: "qs_host_2", hostUnits: { month: monthKey(NOW()), used: 0, wakes: old } });
        await store.createSession(s2);
        expect((await store.appendHostEvent(s2.id, question(), 1, NOW(), "host:tick:1")).ok).toBe(true);
        expect((await store.getSession(s2.id))!.hostUnits.wakes).toHaveLength(1);
      });

      it("refuses a closed, a frozen and a missing room", async () => {
        const closed = hostedRoom({ id: "qs_host_c" });
        await store.createSession(closed);
        await store.closeSession(closed.id);
        expect(await store.appendHostEvent(closed.id, question(), 1, NOW(), "host:tick:1")).toMatchObject({ ok: false, reason: "closed" });
        const frozen = hostedRoom({ id: "qs_host_f" });
        await store.createSession(frozen);
        await store.freezeSession(frozen.id, NOW());
        expect(await store.appendHostEvent(frozen.id, question(), 1, NOW(), "host:tick:1")).toMatchObject({ ok: false, reason: "frozen" });
        expect(await store.appendHostEvent("qs_nobody", question(), 1, NOW(), "host:tick:1")).toMatchObject({ ok: false, reason: "not_found" });
      });

      it("stamps the host as seen on its send, and the roster shows it", async () => {
        const s = hostedRoom();
        await store.createSession(s);
        const before = (await store.getSession(s.id))!.members.find((m) => m.memberId === HOST_MEMBER_ID)!.lastSeenAt!;
        await store.appendHostEvent(s.id, question(), 1, before + 5_000, "host:tick:1");
        const after = (await store.getSession(s.id))!.members.find((m) => m.memberId === HOST_MEMBER_ID)!;
        expect(after.lastSeenAt).toBe(before + 5_000);
      });

      /**
       * Evicting the host is the creator's one control over it (C1). Whatever wakes a
       * departed host, the room refuses its write, so it posts nothing and spends nothing.
       */
      it("refuses the write of a host the room has evicted, appending and charging nothing", async () => {
        const s = hostedRoom({ id: "qs_host_gone" });
        await store.createSession(s);
        await store.removeMember(s.id, HOST_MEMBER_ID, {
          now: NOW(), frozen: "refuse", cut: true, byUserId: "u_jesse", audit: [],
          event: { type: "member_evicted", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd",
            payload: { member_id: HOST_MEMBER_ID }, refId: null },
        });
        const before = await store.eventsAfter(s.id, 0);
        expect(await store.appendHostEvent(s.id, question(), 1, NOW(), "host:tick:1")).toEqual({ ok: false, reason: "removed", used: 0, allowed: 10 });
        expect(await store.eventsAfter(s.id, 0)).toEqual(before);
        expect((await store.getSession(s.id))!.hostUnits.used).toBe(0);
      });

      /**
       * A lost RPC response must not double-post or double-charge (M6). The seat runs a wake
       * again when it never heard back from its write, so the write is keyed by the wake's
       * intent id, and a second write under that key returns the first event and charges
       * nothing. `hostEventFor` is how the seat finds it before calling the model.
       */
      it("returns the first write under a key with no second post or charge, and finds it by that key", async () => {
        const s = hostedRoom({ id: "qs_host_once" });
        await store.createSession(s);
        const first = await store.appendHostEvent(s.id, question(), 3, NOW(), "host:tick:7");
        const again = await store.appendHostEvent(s.id, { ...question(), payload: { kind: "question", text: "Another?", tick: 7 } }, 3, NOW(), "host:tick:7");
        if (!first.ok) throw new Error("the first write was refused");
        expect(again).toEqual({ ok: true, event: first.event });
        expect((await store.eventsAfter(s.id, 0)).filter((e) => e.fromMemberId === HOST_MEMBER_ID)).toEqual([first.event]);
        expect((await store.getSession(s.id))!.hostUnits.used).toBe(3);
        expect(await store.hostEventFor(s.id, "host:tick:7")).toEqual(first.event);
        expect(await store.hostEventFor(s.id, "host:tick:8")).toBeUndefined();
        expect(await store.hostEventFor("qs_nobody", "host:tick:7")).toBeUndefined();
      });

      /**
       * A hosted room's allowance renews at the month turn from its creator's plan as it is then
       * (I7): the seat reads the plan and writes the month's units here, the meter starting
       * empty. A renewal for a month the meter has reached already changes nothing, so a second
       * one cannot hand back what the month has spent.
       */
      it("renews the allowance for a new month, once, with the meter emptied", async () => {
        const s = hostedRoom({ id: "qs_host_renew", hostUnits: { month: "2026-02", used: 9, wakes: [NOW() - 1_000] } });
        await store.createSession(s);
        await store.renewHostAllowance(s.id, "2026-03", 0);
        expect(await store.getSession(s.id)).toMatchObject({ hostUnitsPerMonth: 0, hostUnits: { month: "2026-03", used: 0, wakes: [] } });
        await store.renewHostAllowance(s.id, "2026-03", 3_000);
        expect((await store.getSession(s.id))!.hostUnitsPerMonth).toBe(0);
        await store.renewHostAllowance(s.id, "2026-02", 3_000);
        expect((await store.getSession(s.id))!.hostUnits.month).toBe("2026-03");
        await store.renewHostAllowance("qs_nobody", "2026-03", 1);
      });

      /** The month's notice is outside the meter (spec D6, I9): a write of no units passes both caps and counts in neither. */
      it("writes a zero-unit notice whatever the month and the hour have spent, and counts it in neither", async () => {
        const recent = Array.from({ length: WAKES_PER_HOUR }, (_, i) => NOW() - i * 60_000);
        const s = hostedRoom({ id: "qs_host_notice", hostUnits: { month: monthKey(NOW()), used: 10, wakes: recent } });
        await store.createSession(s);
        const notice = { ...question(), payload: { kind: "notice", text: "The host has used its units." } };
        expect((await store.appendHostEvent(s.id, notice, 0, NOW(), "host:notice:1")).ok).toBe(true);
        expect((await store.getSession(s.id))!.hostUnits).toMatchObject({ used: 10, wakes: recent });
      });

      /** A team org's audit stream records the host's sends as it records every member's (`bellman_send`'s `sent_message` row). */
      it("records the host's send in the room's audit stream, as a member's send is recorded", async () => {
        const s = hostedRoom({ id: "qs_host_audit" });
        await store.createSession(s);
        const answer = { ...question(), payload: { kind: "answer", text: "Nice." }, refId: "1" };
        expect((await store.appendHostEvent(s.id, answer, 1, NOW(), "host:reply:2")).ok).toBe(true);
        expect((await store.auditForOrg("org_codenerd", 10)).filter((a) => a.sessionId === s.id)).toEqual([
          expect.objectContaining({ orgId: "org_codenerd", actorUserId: HOST_USER_ID, action: "sent_message",
            detail: { chars: JSON.stringify(answer.payload).length, ref_id: "1" } }),
        ]);
      });

      // Spec section 2: the hosted seat is exempt. Its writes go through this method alone, which never reads the count.
      it("writes past a full send count: the hosted seat is exempt from the limit", async () => {
        const s = hostedRoom();
        await store.createSession(s);
        for (let i = 0; i < 2; i++) await store.admitSend(s.id, HOST_MEMBER_ID, 2, NOW());
        expect(await store.admitSend(s.id, HOST_MEMBER_ID, 2, NOW()), "the premise: the count is full").toMatchObject({ ok: false });
        expect(await store.appendHostEvent(s.id, question(), 1, NOW(), "host:tick:1")).toMatchObject({ ok: true });
      });
    });

    // ------------------------------------------------ a live room's host instructions
    /**
     * A room's creator can change what its hosted seat is told to ask after the room has started
     * (`PUT /rooms/:id/host`). The store's part is one write: the instructions on the manifest's
     * `host`, and the audit rows the change owes, together or not at all. The seat reads the room's
     * manifest on every wake, so what this stores is what the next question is built from.
     */
    describe("setHostInstructions", () => {
      const NOW = () => Date.now();
      const hostedRoom = (over: Partial<Session> = {}) => {
        const m = hostedManifest();
        return session({ manifest: m, members: [member(), hostMember(m, NOW())], hostUnitsPerMonth: 10,
          hostUnits: { month: monthKey(NOW()), used: 0, wakes: [] }, lastTickAt: NOW(), lastHostTickAt: NOW(), ...over });
      };
      const hostRow = (sessionId: string, chars: number): AuditEntry => ({
        at: NOW(), orgId: "org_codenerd", sessionId, actorUserId: "u_jesse", action: "host_instructions_changed", detail: { chars },
      });
      const instructionsOf = async (id: string) => (await store.getSession(id))!.manifest.host?.instructions;

      it("sets the instructions, changes them and clears them, answering with what is stored", async () => {
        const s = hostedRoom({ id: "qs_hi_set" });
        await store.createSession(s);
        expect(await store.setHostInstructions(s.id, "Ask how agents have grown.", [])).toEqual({ ok: true, instructions: "Ask how agents have grown." });
        expect(await instructionsOf(s.id)).toBe("Ask how agents have grown.");
        expect(await store.setHostInstructions(s.id, "Ask what they have learned.", [])).toEqual({ ok: true, instructions: "Ask what they have learned." });
        expect(await instructionsOf(s.id)).toBe("Ask what they have learned.");
        expect(await store.setHostInstructions(s.id, null, [])).toEqual({ ok: true, instructions: null });
        expect(await instructionsOf(s.id)).toBeNull();
      });

      it("changes the instructions and nothing else in the room", async () => {
        const s = hostedRoom({ id: "qs_hi_only" });
        await store.createSession(s);
        const before = (await store.getSession(s.id))!;
        await store.setHostInstructions(s.id, "Ask how agents have grown.", []);
        const after = (await store.getSession(s.id))!;
        expect(after.manifest).toEqual({ ...before.manifest, host: { ...before.manifest.host!, instructions: "Ask how agents have grown." } });
        expect({ ...after, manifest: before.manifest }).toEqual(before);
        expect(await store.eventsAfter(s.id, 0)).toEqual([]);
      });

      it("refuses a room whose manifest has no host, and leaves the room as it was", async () => {
        const s = session({ id: "qs_hi_nohost" });
        await store.createSession(s);
        const before = (await store.getSession(s.id))!;
        expect(before.manifest.host).toBeNull();
        expect(await store.setHostInstructions(s.id, "Ask how agents have grown.", [hostRow(s.id, 26)])).toEqual({ ok: false, reason: "no_host" });
        expect(await store.getSession(s.id)).toEqual(before);
        expect((await store.auditForOrg("org_codenerd", 10)).filter((a) => a.sessionId === s.id)).toEqual([]);
      });

      it("refuses a closed room and a missing one, and leaves the closed room as it was", async () => {
        const s = hostedRoom({ id: "qs_hi_closed" });
        await store.createSession(s);
        await store.closeSession(s.id);
        const before = (await store.getSession(s.id))!;
        expect(await store.setHostInstructions(s.id, "Ask how agents have grown.", [hostRow(s.id, 26)])).toEqual({ ok: false, reason: "closed" });
        expect(await store.getSession(s.id)).toEqual(before);
        expect(await store.setHostInstructions("qs_nobody", "Ask how agents have grown.", [])).toEqual({ ok: false, reason: "not_found" });
        expect(await store.getSession("qs_nobody")).toBeUndefined();
        expect((await store.auditForOrg("org_codenerd", 10)).filter((a) => a.sessionId === s.id)).toEqual([]);
      });

      it("files the audit rows it was given with the change, and files none for a repeat of the value it already holds", async () => {
        const s = hostedRoom({ id: "qs_hi_audit" });
        await store.createSession(s);
        await store.setHostInstructions(s.id, "Ask how agents have grown.", [hostRow(s.id, 26)]);
        expect((await store.auditForOrg("org_codenerd", 10)).filter((a) => a.sessionId === s.id))
          .toEqual([expect.objectContaining({ orgId: "org_codenerd", actorUserId: "u_jesse", action: "host_instructions_changed", detail: { chars: 26 } })]);
        expect(await store.setHostInstructions(s.id, "Ask how agents have grown.", [hostRow(s.id, 26)]))
          .toEqual({ ok: true, instructions: "Ask how agents have grown." });
        expect((await store.auditForOrg("org_codenerd", 10)).filter((a) => a.sessionId === s.id), "a repeat is no change").toHaveLength(1);
        await store.setHostInstructions(s.id, null, [hostRow(s.id, 0)]);
        expect((await store.auditForOrg("org_codenerd", 10)).filter((a) => a.sessionId === s.id).map((a) => a.detail)).toEqual([{ chars: 26 }, { chars: 0 }]);
        expect(await store.setHostInstructions(s.id, null, [hostRow(s.id, 0)]), "clearing what is already clear").toEqual({ ok: true, instructions: null });
        expect((await store.auditForOrg("org_codenerd", 10)).filter((a) => a.sessionId === s.id)).toHaveLength(2);
      });

      // A falsy org names a stream nobody reads (ARCHITECTURE.md section 9, runtime fact 4); both stores drop such a row.
      it("drops an audit row addressed to no org, as every audit write does", async () => {
        const s = hostedRoom({ id: "qs_hi_noorg" });
        await store.createSession(s);
        await store.setHostInstructions(s.id, "Ask how agents have grown.", [{ ...hostRow(s.id, 26), orgId: "" }]);
        expect(await instructionsOf(s.id)).toBe("Ask how agents have grown.");
        expect((await store.auditForOrg("org_codenerd", 10)).filter((a) => a.sessionId === s.id)).toEqual([]);
      });

      it("takes a frozen room's change, as the creator's setting is not a send", async () => {
        const s = hostedRoom({ id: "qs_hi_frozen" });
        await store.createSession(s);
        await store.freezeSession(s.id, NOW());
        expect(await store.setHostInstructions(s.id, "Ask how agents have grown.", [])).toEqual({ ok: true, instructions: "Ask how agents have grown." });
        expect(await instructionsOf(s.id)).toBe("Ask how agents have grown.");
      });
    });

    describe("the send count (abuse protections spec D5)", () => {
      // A stranger's key is kept apart from a member's by a store that has storage to keep it in, so the same
      // count is asked of both kinds of key.
      const strangerKey = (userId: string) => sendKeyFor({ via: "permanent", userId, memberId: `m_${userId}` });
      for (const [whose, one, another] of [
        ["a member's", "m_creator", "m_peer"],
        ["a stranger's", strangerKey("u_creator"), strangerKey("u_peer")],
      ] as const) {
        it(`admits sends under ${whose} key up to the limit in a minute, per key and per room`, async () => {
          await store.createSession(session());
          await store.createSession(session({ id: "qs_other" }));
          for (let i = 0; i < 3; i++) expect(await store.admitSend("qs_test", one, 3, 1_000 + i)).toEqual({ ok: true });
          expect(await store.admitSend("qs_test", one, 3, 2_000)).toEqual({ ok: false, retryAfterMs: 59_000 });
          expect(await store.admitSend("qs_test", another, 3, 2_000), "another key").toEqual({ ok: true });
          expect(await store.admitSend("qs_other", one, 3, 2_000), "another room").toEqual({ ok: true });
          expect(await store.admitSend("qs_test", one, 3, 61_000), "a minute on").toEqual({ ok: true });
        });
      }

      // Spec D5, amended for strangers: their count is stored, so a script cannot send 6, pause until the idle
      // room object is evicted, and send 6 more.
      it("keeps a stranger's count when the room object loses its memory", async () => {
        await store.createSession(session());
        const stranger = strangerKey("u_peer");
        for (let i = 0; i < 3; i++) expect(await store.admitSend("qs_test", stranger, 3, 1_000 + i)).toEqual({ ok: true });
        await harness.forgetMemory?.();
        expect(await store.admitSend("qs_test", stranger, 3, 2_000), "the count outlived the memory").toEqual({ ok: false, retryAfterMs: 59_000 });
        expect(await store.admitSend("qs_test", stranger, 3, 61_000), "a minute on").toEqual({ ok: true });
      });

      // The count's limit is read from this field, so a store that dropped it would limit nobody as a stranger.
      it("keeps how a seat was taken, on the pending connect and on the member it seats", async () => {
        const s = session();
        await store.createSession(s);
        await store.putPendingConnect({
          token: "qct_via", sessionId: s.id, userId: "u_peer", roomRole: "peer_b", via: "permanent",
          createdAt: Date.now(), expiresAt: Date.now() + CONNECT_TOKEN_TTL,
        });
        expect((await store.takePendingConnect("qct_via"))?.via).toBe("permanent");
        const arriving = member({ memberId: "m_stranger", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b", via: "permanent" });
        expect((await store.seatMember(s.id, arriving, 0, Date.now())).refused).toBeNull();
        expect((await store.getMember(s.id, "m_stranger"))?.via).toBe("permanent");
        expect((await store.getMember(s.id, "m_creator"))?.via, "the creator").toBeUndefined();
      });
    });

    /**
     * The host is not a person (#188): when the last member who is one leaves, the
     * room closes as a room without a host does. `abandonedAt` already ignores the
     * seat; without this the two paths that end a room both missed one whose only
     * remaining member was its host, and it stayed open for good.
     */
    describe("a hosted room whose people have left", () => {
      it("closes when the last person has left, with its host still seated", async () => {
        const m = hostedManifest();
        const s = session({ manifest: m, members: [member(), hostMember(m, Date.now())] });
        await store.createSession(s);
        // The control: a person is in it, so it stays open.
        expect(await store.closeSessionIfEmpty(s.id)).toBe(false);
        await store.updateMember(s.id, "m_creator", { leftAt: Date.now() });
        expect(await store.closeSessionIfEmpty(s.id)).toBe(true);
        expect((await store.getSession(s.id))!.closed).toBe(true);
      });
    });

    /**
     * Housekeeping counts people (#66, ruling H3), and every event write runs its books (H2).
     * The seat's send and a person's reply to it both reach the books through a store's own
     * appends, so these are the two stores agreeing on what each owes them: a reply is a
     * person's event, and the seat's word is nobody's activity.
     */
    describe("a hosted room's housekeeping books", () => {
      const watched = () => {
        const m = { ...hostedManifest(), housekeeping: { quietAfterMs: 7_200_000, answerWithinMs: 1_800_000, idleAfterMs: 86_400_000, repeatAfterMs: null } };
        const now = Date.now();
        return session({ manifest: m, members: [member({ lastSeenAt: now }), hostMember(m, now)], hostUnitsPerMonth: 10,
          hostUnits: { month: monthKey(now), used: 0, wakes: [] } });
      };
      const asks = (): Omit<SessionEvent, "cursor" | "at"> => ({
        type: "message", fromMemberId: HOST_MEMBER_ID, fromUserId: HOST_USER_ID, fromLabel: "host@bellman",
        payload: { kind: "question", text: "What shipped?", tick: 1 }, refId: null,
      });
      const replyTo = (cursor: number): Omit<SessionEvent, "cursor" | "at"> => ({
        type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd",
        payload: { text: "a parser" }, refId: String(cursor),
      });
      /** The three books, as they stand. */
      const booksOf = async (id: string) => {
        const s = (await store.getSession(id))!;
        return { room: s.lastMemberEventAt, sent: Object.fromEntries(s.members.map((m) => [m.memberId, m.lastSentAt])), open: s.openRequests };
      };

      it("keeps no book for the seat's own send: no clock of its own, and none for the room", async () => {
        const s = watched();
        await store.createSession(s);
        expect((await store.appendHostEvent(s.id, asks(), 1, Date.now(), "host:tick:1")).ok).toBe(true);
        expect(await booksOf(s.id)).toEqual({ room: null, sent: { m_creator: undefined, m_host: undefined }, open: {} });
      });

      it("keeps a person's reply to the seat in the books, through appendEvent", async () => {
        const s = watched();
        await store.createSession(s);
        const q = await store.appendHostEvent(s.id, asks(), 1, Date.now(), "host:tick:1");
        const reply = (await store.appendEvent(s.id, replyTo(q.ok ? q.event.cursor : 0)))!;
        expect(await booksOf(s.id)).toEqual({ room: reply.at, sent: { m_creator: reply.at, m_host: undefined }, open: {} });
      });

      it("keeps a person's reply to the seat in the books, through appendEventOnce", async () => {
        const s = watched();
        await store.createSession(s);
        const q = await store.appendHostEvent(s.id, asks(), 1, Date.now(), "host:tick:1");
        const r = await store.appendEventOnce(s.id, replyTo(q.ok ? q.event.cursor : 0), "reply-1");
        if (r.outcome !== "appended") throw new Error(`expected an append, got ${r.outcome}`);
        expect(await booksOf(s.id)).toEqual({ room: r.event.at, sent: { m_creator: r.event.at, m_host: undefined }, open: {} });
      });

      it("leaves the room's last member event with the person when the seat speaks again", async () => {
        const s = watched();
        await store.createSession(s);
        const q = await store.appendHostEvent(s.id, asks(), 1, Date.now(), "host:tick:1");
        const reply = (await store.appendEvent(s.id, replyTo(q.ok ? q.event.cursor : 0)))!;
        // The suite's clock is held, so move it: an answer at the reply's own moment could not tell.
        vi.setSystemTime(reply.at + 60_000);
        const answer = { ...asks(), payload: { kind: "answer", text: "Nice." }, refId: String(reply.cursor) };
        expect((await store.appendHostEvent(s.id, answer, 1, Date.now(), "host:reply:2")).ok).toBe(true);
        expect((await booksOf(s.id)).room).toBe(reply.at);
      });
    });

    /**
     * A plan's hosted rooms are the most a creator holds open at once (I7), not a count of
     * creations a month: each hosted room open past the first month renews its allowance,
     * so a monthly count let a creator's spend grow every month. A slot is taken by one
     * count-and-record call and given back when the room closes.
     */
    describe("hosted room slots", () => {
      it("admits a creator's hosted rooms up to the limit, then refuses with the count open", async () => {
        expect(await store.reserveHostedRoom("u_slots", "qs_s1", 2)).toEqual({ ok: true });
        expect(await store.reserveHostedRoom("u_slots", "qs_s2", 2)).toEqual({ ok: true });
        expect(await store.reserveHostedRoom("u_slots", "qs_s3", 2)).toEqual({ ok: false, open: 2 });
        // A retry for a room that holds a slot is not a second room.
        expect(await store.reserveHostedRoom("u_slots", "qs_s1", 2)).toEqual({ ok: true });
        // Another creator's slots are their own.
        expect(await store.reserveHostedRoom("u_other", "qs_s4", 2)).toEqual({ ok: true });
        // A slot given back is free again, and giving one back twice is harmless.
        await store.releaseHostedRoom("u_slots", "qs_s2");
        await store.releaseHostedRoom("u_slots", "qs_s2");
        expect(await store.reserveHostedRoom("u_slots", "qs_s3", 2)).toEqual({ ok: true });
        expect(await store.reserveHostedRoom("u_slots", "qs_s5", 2)).toEqual({ ok: false, open: 2 });
      });

      it("counts only a person's own slots, not those of someone whose id extends theirs past a colon", async () => {
        // `u_x:a` extends `u_x` (#226, #295): its open hosted room is not one of u_x's.
        expect(await store.reserveHostedRoom("u_x:a", "qs_a_other", 1)).toEqual({ ok: true });
        expect(await store.reserveHostedRoom("u_x", "qs_b_own", 1)).toEqual({ ok: true });
        expect(await store.reserveHostedRoom("u_x:a", "qs_a_again", 1)).toEqual({ ok: false, open: 1 });
      });

      it("admits one of two reservations made at once at the limit", async () => {
        const both = await Promise.all([
          store.reserveHostedRoom("u_race", "qs_r1", 1),
          store.reserveHostedRoom("u_race", "qs_r2", 1),
        ]);
        expect(both.filter((r) => r.ok)).toHaveLength(1);
        expect(both.filter((r) => !r.ok)).toEqual([{ ok: false, open: 1 }]);
      });

      it("frees a hosted room's slot when the room closes, however it closes", async () => {
        const m = hostedManifest();
        const room = (id: string, seenAt = Date.now()) => session({
          id, manifest: m, createdBy: "u_closer", members: [member({ lastSeenAt: seenAt }), hostMember(m, Date.now())],
        });
        const full = { ok: false, open: 1 };

        await store.createSession(room("qs_close_a"));
        expect(await store.reserveHostedRoom("u_closer", "qs_close_a", 1)).toEqual({ ok: true });
        expect(await store.reserveHostedRoom("u_closer", "qs_close_b", 1)).toEqual(full);
        await store.closeSession("qs_close_a");
        expect(await store.reserveHostedRoom("u_closer", "qs_close_b", 1)).toEqual({ ok: true });

        // The last person leaves: the host does not keep the room, or its slot.
        await store.createSession(room("qs_close_b"));
        expect(await store.reserveHostedRoom("u_closer", "qs_close_c", 1)).toEqual(full);
        await store.updateMember("qs_close_b", "m_creator", { leftAt: Date.now() });
        expect(await store.closeSessionIfEmpty("qs_close_b")).toBe(true);
        expect(await store.reserveHostedRoom("u_closer", "qs_close_c", 1)).toEqual({ ok: true });

        // Nobody seen for the abandonment window: the room is closed by a read, or sooner by
        // the Durable Objects store's own alarm, so the slot is checked as held before the room
        // exists and as free once a read has seen it closed.
        expect(await store.reserveHostedRoom("u_closer", "qs_close_d", 1)).toEqual(full);
        await store.createSession(room("qs_close_c", Date.now() - ABANDONED_AFTER_MS - 1));
        expect((await store.getSession("qs_close_c"))!.closed).toBe(true);
        expect(await store.reserveHostedRoom("u_closer", "qs_close_d", 1)).toEqual({ ok: true });
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

        const m = (await store.getMember(s.id, target))!;
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

        const m = (await store.getMember(s.id, target))!;
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
        const m = (await store.getMember(s.id, target))!;
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
        const m = (await store.getMember(s.id, target))!;
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
        const m = (await store.getMember(s.id, target))!;
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
        const m = (await store.getMember(s.id, target))!;
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

        const sender = (await store.getMember(s.id, "m_creator"))!;
        const removed = (await store.getMember(s.id, target))!;
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

    // bellman_sync's page (#208): a poll from far behind reads the earliest `limit`, the next poll the rest.
    it("waitForEvents returns at most `limit` events when given one, the earliest after the cursor", async () => {
      const s = session();
      await store.createSession(s);
      for (const text of ["one", "two", "three"]) {
        await store.appendEvent(s.id, {
          type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse", payload: { text }, refId: null,
        });
      }
      expect((await store.waitForEvents(s.id, 0, 10_000, 2)).map((e) => e.cursor)).toEqual([1, 2]);
      expect((await store.waitForEvents(s.id, 2, 10_000, 2)).map((e) => e.cursor)).toEqual([3]);
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

      (await store.setJoinCode(a.id, "peer_b", "BELL-BBBB-02", Date.now() + JOIN_CODE_TTL, { replaceLive: true, now: Date.now() }));

      expect(await store.getSessionByJoinCode("BELL-AAAA-01")).toBeUndefined();
      expect((await store.getSessionByJoinCode("BELL-BBBB-02"))?.session.id).toBe(a.id);
      expect((await store.getSession(a.id))?.joinCodes["peer_b"].code).toBe("BELL-BBBB-02");
    });

    it("issues a code after the previous one was consumed", async () => {
      const a = session({ joinCodes: oneCode("BELL-AAAA-01") });
      (await store.createSession(a));
      (await store.consumeJoinCode(a.id, "peer_b"));

      (await store.setJoinCode(a.id, "peer_b", "BELL-CCCC-03", Date.now() + JOIN_CODE_TTL, { replaceLive: true, now: Date.now() }));

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

    // --------------------------------------------- saved presets (designer)
    describe("orgs (#53)", () => {
      const acme = (over: Partial<Org> = {}): Org => ({
        orgId: "org_acme", name: "Acme", ownerUserId: "u_github_1", seats: 2, source: "operator",
        active: true, createdAt: 1, requireSso: false, domains: [], policy: DEFAULT_POLICY, ...over,
      });
      const owner = (over: Partial<PlanGrant> = {}): PlanGrant => ({
        key: "github:1", plan: "team", role: "admin", orgId: "org_acme", source: "operator",
        grantedAt: 1, grantedBy: "u_op", expiresAt: null, ...over,
      });
      const member = (key: string, over: Partial<PlanGrant> = {}): PlanGrant =>
        owner({ key, role: "member", source: "org", ...over });
      const by = { actorUserId: "u_op" };
      const actions = async (orgId = "org_acme") => (await store.auditForOrg(orgId, 20)).map((e) => e.action);

      it("creates the record and seats its owner in one operation, and refuses the id a second time", async () => {
        expect(await store.createOrg(acme(), owner(), by)).toBe("created");
        expect(await store.getOrg("org_acme")).toEqual(acme());
        expect(await store.getGrant("github:1")).toEqual(owner());
        expect(await store.countOrgMembers("org_acme")).toBe(1);
        expect(await actions()).toEqual(["org_created", "plan_granted"]);

        expect(await store.createOrg(acme({ name: "Again" }), owner(), by)).toBe("exists");
        expect((await store.getOrg("org_acme"))?.name).toBe("Acme");
      });

      it("refuses an owner key granted in another org, and writes neither record nor grant", async () => {
        await store.putGrant(owner({ orgId: "org_other" }));
        expect(await store.createOrg(acme(), owner(), by)).toBe("conflict");
        expect(await store.getOrg("org_acme")).toBeUndefined();
        expect(await store.getGrant("github:1")).toMatchObject({ orgId: "org_other" });
        expect(await actions()).toEqual([]);
      });

      /** An org that lived as a string in grants gets its record later: the owner's old member grant becomes the admin one. */
      it("replaces a grant the owner's key already holds in this org", async () => {
        await store.putGrant(owner({ role: "member" }));
        expect(await store.createOrg(acme(), owner(), by)).toBe("created");
        expect(await store.getGrant("github:1")).toMatchObject({ role: "admin" });
        expect(await store.countOrgMembers("org_acme")).toBe(1);
      });

      it("answers undefined for an org nobody created, and a detached copy otherwise", async () => {
        expect(await store.getOrg("org_nobody")).toBeUndefined();
        await store.createOrg(acme(), owner(), by);
        const read = (await store.getOrg("org_acme"))!;
        read.name = "Mutated";
        read.domains.push({ domain: "x.test", token: "t", verifiedAt: null });
        expect(await store.getOrg("org_acme")).toEqual(acme());
      });

      it("updates the name, the seats and the SSO switch, recording only what changed", async () => {
        await store.createOrg(acme(), owner(), by);
        expect(await store.updateOrg("org_acme", { name: "Acme Ltd", seats: 5 }, by)).toEqual(acme({ name: "Acme Ltd", seats: 5 }));
        expect(await store.updateOrg("org_acme", { requireSso: true }, by)).toMatchObject({ requireSso: true });
        expect(await store.updateOrg("org_acme", { seats: 5 }, by)).toMatchObject({ seats: 5 });
        expect(await store.updateOrg("org_nobody", { name: "x" }, by)).toBeUndefined();
        const rows = (await store.auditForOrg("org_acme", 20)).filter((e) => e.action === "org_updated");
        expect(rows.map((e) => e.detail)).toEqual([{ name: "Acme Ltd", seats: 5 }, { require_sso: true }]);
      });

      it("updates the policy field by field, recording only the fields that changed, under policy", async () => {
        await store.createOrg(acme(), owner(), by);
        const tight = { requireOrgOnly: true, allowedCounterpartyOrgs: ["org_b"] };
        expect(await store.updateOrg("org_acme", { policy: tight }, by)).toEqual(acme({ policy: { ...DEFAULT_POLICY, ...tight } }));
        expect(await store.updateOrg("org_acme", { policy: { requireOrgOnly: true } }, by)).toMatchObject({ policy: { ...DEFAULT_POLICY, ...tight } });
        expect(await store.updateOrg("org_acme", { name: "Acme Ltd", policy: { whoMayCreate: "admins_only" } }, by))
          .toMatchObject({ name: "Acme Ltd", policy: { whoMayCreate: "admins_only", requireOrgOnly: true } });
        const rows = (await store.auditForOrg("org_acme", 20)).filter((e) => e.action === "org_updated");
        expect(rows.map((e) => e.detail)).toEqual([
          { policy: { require_org_only: true, allowed_counterparty_orgs: ["org_b"] } },
          { name: "Acme Ltd", policy: { who_may_create: "admins_only" } },
        ]);
      });

      it("refuses a member past the seats, writing nothing and recording nothing", async () => {
        await store.createOrg(acme(), owner(), by);
        expect(await store.putGrantIfOwned(member("github:2"), "org_acme", by)).toBe("written");
        expect(await store.putGrantIfOwned(member("github:3"), "org_acme", by)).toBe("full");
        expect(await store.getGrant("github:3")).toBeUndefined();
        expect(await store.countOrgMembers("org_acme")).toBe(2);
        expect((await actions()).filter((a) => a === "plan_granted")).toHaveLength(2);
      });

      it("takes no seat for a role change at the cap", async () => {
        await store.createOrg(acme(), owner(), by);
        await store.putGrantIfOwned(member("github:2"), "org_acme", by);
        expect(await store.putGrantIfOwned(member("github:2", { role: "admin" }), "org_acme", by)).toBe("written");
        expect(await store.getGrant("github:2")).toMatchObject({ role: "admin" });
      });

      it("caps nothing in an org that has no record", async () => {
        for (const n of [1, 2, 3, 4, 5]) {
          expect(await store.putGrantIfOwned(member(`github:${n}`, { orgId: "org_free" }), "org_free", by)).toBe("written");
        }
        expect(await store.countOrgMembers("org_free")).toBe(5);
      });

      /** Claiming an address grant onto its subject at sign-in adds nobody, so it must cost no seat. */
      it("keeps the seat count across a move of a member's key", async () => {
        await store.createOrg(acme(), owner(), by);
        await store.putGrantIfOwned(member("email:a@acme.test"), "org_acme", by);
        await store.moveGrant("email:a@acme.test", "github:9");
        expect(await store.countOrgMembers("org_acme")).toBe(2);
        expect(await store.putGrantIfOwned(member("github:9", { role: "admin" }), "org_acme", by)).toBe("written");
        expect(await store.putGrantIfOwned(member("github:10"), "org_acme", by)).toBe("full");
      });

      it("keeps every member when the seats fall below them, and refuses the next", async () => {
        await store.createOrg(acme({ seats: 3 }), owner(), by);
        await store.putGrantIfOwned(member("github:2"), "org_acme", by);
        await store.putGrantIfOwned(member("github:3"), "org_acme", by);
        await store.updateOrg("org_acme", { seats: 1 }, by);
        expect((await store.listGrants(10, "org_acme")).map((g) => g.key).sort()).toEqual(["github:1", "github:2", "github:3"]);
        expect(await store.putGrantIfOwned(member("github:4"), "org_acme", by)).toBe("full");
      });

      it("does not count a lapsed grant toward the seats", async () => {
        await store.createOrg(acme(), owner(), by);
        await store.putGrant(member("github:2", { expiresAt: Date.now() - 1 }));
        expect(await store.countOrgMembers("org_acme")).toBe(1);
        expect(await store.putGrantIfOwned(member("github:3"), "org_acme", by)).toBe("written");
      });

      /**
       * Every org that existed before the policy field is a row without one. The Stripe writers rebuild the
       * record from that row, and the audit diff reads its policy: a row written before the field must lift
       * through both, or the first seat change or cancellation after the deploy throws and rolls back.
       */
      it("activates, deactivates and updates a purchased org whose row was written before the policy field", async () => {
        const stripe = { actorUserId: "stripe" };
        const old = acme({ orgId: "org_u_github_7", ownerUserId: "u_github_7", source: "purchase" });
        delete (old as Partial<Org>).policy;
        await store.createOrg(old, owner({ key: "github:7", orgId: "org_u_github_7" }), by);
        expect(await store.activatePurchasedOrg("org_u_github_7", "u_github_7", 5, stripe)).toBe("updated");
        expect(await store.deactivateOrg("org_u_github_7", stripe)).toBe("updated");
        expect(await store.updateOrg("org_u_github_7", { name: "Seven" }, by)).toMatchObject({ name: "Seven", seats: 5, active: false, policy: DEFAULT_POLICY });
        expect(await store.getOrg("org_u_github_7")).toMatchObject({ policy: DEFAULT_POLICY });
        expect((await store.auditForOrg("org_u_github_7", 20)).map((e) => e.action))
          .toEqual(["org_created", "plan_granted", "org_updated", "org_updated", "org_updated"]);
      });

      it("activates a purchased org: created named by its id, then updated, then unchanged", async () => {
        const stripe = { actorUserId: "stripe" };
        expect(await store.activatePurchasedOrg("org_u_github_4242", "u_github_4242", 3, stripe)).toBe("created");
        expect(await store.getOrg("org_u_github_4242")).toEqual({
          orgId: "org_u_github_4242", name: "org_u_github_4242", ownerUserId: "u_github_4242", seats: 3,
          source: "purchase", active: true, createdAt: Date.now(), requireSso: false, domains: [], policy: DEFAULT_POLICY,
        });
        expect(await store.activatePurchasedOrg("org_u_github_4242", "u_github_4242", 3, stripe)).toBe("unchanged");
        expect(await store.activatePurchasedOrg("org_u_github_4242", "u_github_4242", 5, stripe)).toBe("updated");
        const rows = await store.auditForOrg("org_u_github_4242", 20);
        expect(rows.map((e) => [e.action, e.actorUserId])).toEqual([["org_created", "stripe"], ["org_updated", "stripe"]]);
        expect(rows[1].detail).toEqual({ seats: 5 });
      });

      it("keeps the name its owner gave it across a later activation", async () => {
        const stripe = { actorUserId: "stripe" };
        await store.activatePurchasedOrg("org_u_github_4242", "u_github_4242", 3, stripe);
        await store.updateOrg("org_u_github_4242", { name: "Acme" }, { actorUserId: "u_github_4242" });
        await store.activatePurchasedOrg("org_u_github_4242", "u_github_4242", 4, stripe);
        expect(await store.getOrg("org_u_github_4242")).toMatchObject({ name: "Acme", seats: 4 });
      });

      /**
       * Billing touches only what billing created (ADR 0014, decision 3, carried to the org): an org the
       * operator made, under whatever id, keeps its seats and stays active whatever a subscription does.
       */
      it("leaves an operator org alone: a purchase neither resizes nor deactivates it", async () => {
        const stripe = { actorUserId: "stripe" };
        await store.createOrg(acme({ orgId: "org_u_github_1", seats: 10 }), owner({ orgId: "org_u_github_1" }), by);
        expect(await store.activatePurchasedOrg("org_u_github_1", "u_github_1", 3, stripe)).toBe("not_purchased");
        expect(await store.deactivateOrg("org_u_github_1", stripe)).toBe("not_purchased");
        expect(await store.getOrg("org_u_github_1")).toMatchObject({ seats: 10, active: true, source: "operator" });
        expect((await store.auditForOrg("org_u_github_1", 20)).map((e) => e.action)).toEqual(["org_created", "plan_granted"]);
      });

      it("deactivates an org once, and a later activation brings it back", async () => {
        const stripe = { actorUserId: "stripe" };
        expect(await store.deactivateOrg("org_nobody", stripe)).toBe("missing");
        await store.activatePurchasedOrg("org_u_github_4242", "u_github_4242", 3, stripe);
        expect(await store.deactivateOrg("org_u_github_4242", stripe)).toBe("updated");
        expect(await store.getOrg("org_u_github_4242")).toMatchObject({ active: false, seats: 3 });
        expect(await store.deactivateOrg("org_u_github_4242", stripe)).toBe("unchanged");
        expect(await store.activatePurchasedOrg("org_u_github_4242", "u_github_4242", 3, stripe)).toBe("updated");
        expect(await store.getOrg("org_u_github_4242")).toMatchObject({ active: true });
        const rows = (await store.auditForOrg("org_u_github_4242", 20)).filter((e) => e.action === "org_updated");
        expect(rows.map((e) => e.detail)).toEqual([{ active: false }, { active: true }]);
      });
    });

    describe("SSO (#55)", () => {
      const acme = (over: Partial<Org> = {}): Org => ({
        orgId: "org_acme", name: "Acme", ownerUserId: "u_github_1", seats: 2, source: "operator",
        active: true, createdAt: 1, requireSso: false, domains: [], policy: DEFAULT_POLICY, ...over,
      });
      const owner = (over: Partial<PlanGrant> = {}): PlanGrant => ({
        key: "github:1", plan: "team", role: "admin", orgId: "org_acme", source: "operator",
        grantedAt: 1, grantedBy: "u_op", expiresAt: null, ...over,
      });
      const idp: OrgIdp = {
        protocol: "oidc", issuer: "https://idp.test", clientId: "0oa", clientSecret: "v1.sealed.value", tokenAuth: "client_secret_basic",
        authorizationEndpoint: "https://idp.test/authorize", tokenEndpoint: "https://idp.test/token", userinfoEndpoint: null,
        configuredAt: 5, configuredBy: "u_github_1",
      };
      const by = { actorUserId: "u_github_1", actorLabel: "Ana", actorOrgId: "org_acme" };
      const actions = async (orgId = "org_acme") => (await store.auditForOrg(orgId, 20)).map((e) => e.action);
      const seated = async () => { await store.createOrg(acme(), owner(), { actorUserId: "u_op" }); };

      it("keeps an org's IdP apart from its record, untouched, and drops it once", async () => {
        expect(await store.putOrgIdp("org_acme", idp, by)).toBe("missing");
        await seated();
        expect(await store.putOrgIdp("org_acme", idp, by)).toBe("written");
        expect(await store.getOrgIdp("org_acme")).toEqual(idp);
        expect(await store.getOrg("org_acme")).toEqual(acme());
        expect(await store.deleteOrgIdp("org_acme", by)).toBe("deleted");
        expect(await store.getOrgIdp("org_acme")).toBeUndefined();
        expect(await store.deleteOrgIdp("org_acme", by)).toBe("missing");
        expect(await actions()).toEqual(["org_created", "plan_granted", "idp_configured", "idp_removed"]);
        expect((await store.auditForOrg("org_acme", 20))[2].detail).toEqual({ issuer: "https://idp.test" });
      });

      it("claims a domain on the record without routing it, once", async () => {
        await seated();
        expect(await store.claimDomain("org_acme", "acme.test", "tok", 9, by)).toBe("claimed");
        expect((await store.getOrg("org_acme"))?.domains).toEqual([{ domain: "acme.test", token: "tok", verifiedAt: null }]);
        expect(await store.orgForDomain("acme.test")).toBeUndefined();
        expect(await store.claimDomain("org_acme", "acme.test", "other", 10, by)).toBe("exists");
        expect((await store.getOrg("org_acme"))?.domains[0].token).toBe("tok");
        expect(await store.claimDomain("org_nobody", "acme.test", "tok", 9, by)).toBe("missing");
        expect(await actions()).toEqual(["org_created", "plan_granted", "domain_claimed"]);
      });

      it("verifies a claim, writes the index, and records the first verification only", async () => {
        await seated();
        await store.claimDomain("org_acme", "acme.test", "tok", 9, by);
        expect(await store.verifyDomain("org_acme", "acme.test", 11, by)).toBe("verified");
        expect((await store.getOrg("org_acme"))?.domains).toEqual([{ domain: "acme.test", token: "tok", verifiedAt: 11 }]);
        expect(await store.orgForDomain("acme.test")).toBe("org_acme");
        expect(await store.verifyDomain("org_acme", "acme.test", 12, by)).toBe("verified");
        expect((await store.getOrg("org_acme"))?.domains[0].verifiedAt).toBe(11);
        expect(await store.verifyDomain("org_acme", "nobody.test", 12, by)).toBe("unknown");
        expect((await actions()).filter((a) => a === "domain_verified")).toHaveLength(1);
      });

      it("lets one org verify a domain: the second is taken, and its claim stays unverified", async () => {
        await seated();
        await store.createOrg(acme({ orgId: "org_b", ownerUserId: "u_github_2" }), owner({ key: "github:2", orgId: "org_b" }), { actorUserId: "u_op" });
        await store.claimDomain("org_acme", "acme.test", "tok", 9, by);
        await store.claimDomain("org_b", "acme.test", "tok2", 9, { actorUserId: "u_github_2" });
        expect(await store.verifyDomain("org_acme", "acme.test", 11, by)).toBe("verified");
        expect(await store.verifyDomain("org_b", "acme.test", 12, { actorUserId: "u_github_2" })).toBe("taken");
        expect((await store.getOrg("org_b"))?.domains[0].verifiedAt).toBeNull();
        expect(await store.orgForDomain("acme.test")).toBe("org_acme");
      });

      it("releases a claim and its index, and answers unknown after", async () => {
        await seated();
        await store.claimDomain("org_acme", "acme.test", "tok", 9, by);
        await store.verifyDomain("org_acme", "acme.test", 11, by);
        expect(await store.releaseDomain("org_acme", "acme.test", by)).toBe("released");
        expect((await store.getOrg("org_acme"))?.domains).toEqual([]);
        expect(await store.orgForDomain("acme.test")).toBeUndefined();
        expect(await store.releaseDomain("org_acme", "acme.test", by)).toBe("unknown");
        expect((await actions()).at(-1)).toBe("domain_released");
      });

      it("does not release another org's index for a domain this org only claimed", async () => {
        await seated();
        await store.createOrg(acme({ orgId: "org_b", ownerUserId: "u_github_2" }), owner({ key: "github:2", orgId: "org_b" }), { actorUserId: "u_op" });
        await store.claimDomain("org_acme", "acme.test", "tok", 9, by);
        await store.verifyDomain("org_acme", "acme.test", 11, by);
        await store.claimDomain("org_b", "acme.test", "tok2", 9, { actorUserId: "u_github_2" });
        expect(await store.releaseDomain("org_b", "acme.test", { actorUserId: "u_github_2" })).toBe("released");
        expect(await store.orgForDomain("acme.test")).toBe("org_acme");
      });

      it("seats an SSO sign-in once, as a team member from sso, within the seats", async () => {
        await seated();
        const sso = { actorUserId: "sso", detail: { org_id: "org_acme" } };
        expect(await store.provisionSsoMember("org_acme", "sso:org_acme:00u1", 13, sso)).toBe("written");
        expect(await store.getGrant("sso:org_acme:00u1")).toEqual({
          key: "sso:org_acme:00u1", plan: "team", role: "member", orgId: "org_acme", source: "sso", grantedAt: 13, grantedBy: "sso", expiresAt: null,
        });
        await store.putGrantIfOwned({ ...owner({ key: "sso:org_acme:00u1", role: "admin", source: "sso" }) }, "org_acme", by);
        expect(await store.provisionSsoMember("org_acme", "sso:org_acme:00u1", 14, sso)).toBe("exists");
        expect(await store.getGrant("sso:org_acme:00u1")).toMatchObject({ role: "admin" });
        expect(await store.provisionSsoMember("org_acme", "sso:org_acme:00u2", 15, sso)).toBe("full");
        expect(await store.getGrant("sso:org_acme:00u2")).toBeUndefined();
        expect(await store.countOrgMembers("org_acme")).toBe(2);
        expect(await store.provisionSsoMember("org_nobody", "sso:org_nobody:00u1", 15, sso)).toBe("no_org");
        expect((await store.auditForOrg("org_acme", 20)).filter((e) => e.action === "plan_granted").map((e) => e.actorUserId)).toEqual(["u_op", "sso", "u_github_1"]);
      });
    });

    /**
     * An invite is an offer of a seat, kept apart from the grants (ADR 0027): nothing that reads a grant
     * (a plan, an org, a seat count, the roster of members) can find one, and it becomes a grant only
     * through the grant write the person's own Join makes.
     */
    describe("invites (ADR 0027)", () => {
      const acme = (over: Partial<Org> = {}): Org => ({
        orgId: "org_acme", name: "Acme", ownerUserId: "u_github_1", seats: 2, source: "operator",
        active: true, createdAt: 1, requireSso: false, domains: [], policy: DEFAULT_POLICY, ...over,
      });
      const owner = (over: Partial<PlanGrant> = {}): PlanGrant => ({
        key: "github:1", plan: "team", role: "admin", orgId: "org_acme", source: "operator",
        grantedAt: 1, grantedBy: "u_op", expiresAt: null, ...over,
      });
      const invite = (key: string, over: Partial<OrgInvite> = {}): OrgInvite => ({
        orgId: "org_acme", key, role: "member", invitedBy: "u_github_1", invitedAt: 7, expiresAt: 7 + INVITE_TTL_MS, ...over,
      });
      const by = { actorUserId: "u_github_1", actorLabel: "Ana", actorOrgId: "org_acme" };
      const orgEvents = async (orgId = "org_acme") =>
        (await store.auditForOrg(orgId, 500)).map((e) => e.action).filter((a) => a !== "org_created" && a !== "plan_granted");
      const seated = async () => { await store.createOrg(acme(), owner(), { actorUserId: "u_op" }); };

      it("lists an invite with its expiry, and reads one stored without the field as fourteen days after it was made (ADR 0036, D3)", async () => {
        await seated();
        await store.putOrgInvite(invite("github:9"), by);
        expect((await store.listOrgInvites("org_acme", 10))[0].expiresAt).toBe(7 + INVITE_TTL_MS);
        const legacy: Partial<OrgInvite> = invite("github:8");
        delete legacy.expiresAt;
        await store.putOrgInvite(legacy as OrgInvite, by);
        expect((await store.invitesFor(["github:8"]))[0].expiresAt).toBe(7 + INVITE_TTL_MS);
        expect((await store.listOrgInvites("org_acme", 10)).map((i) => i.expiresAt)).toEqual([7 + INVITE_TTL_MS, 7 + INVITE_TTL_MS]);
      });

      it("seats nobody for an expired invite and keeps its row for the roster (ADR 0036, D3)", async () => {
        await seated();
        await store.putOrgInvite(invite("github:9", { expiresAt: 100 }), by);
        expect(await store.acceptOrgInvite("org_acme", ["github:9"], "github:9", 100, by)).toBe("gone");
        expect(await store.getGrant("github:9")).toBeUndefined();
        expect((await store.listOrgInvites("org_acme", 10)).map((i) => i.key)).toEqual(["github:9"]);
        expect(await store.acceptOrgInvite("org_acme", ["github:9"], "github:9", 99, by)).toBe("joined");
      });

      it("keeps an invite out of every grant read: no grant, no seat, no member", async () => {
        await seated();
        expect(await store.putOrgInvite(invite("github:9"), by)).toBe("invited");
        expect(await store.getGrant("github:9")).toBeUndefined();
        expect(await store.countOrgMembers("org_acme")).toBe(1);
        expect((await store.listGrants(10, "org_acme")).map((g) => g.key)).toEqual(["github:1"]);
        expect((await store.listGrants(10)).map((g) => g.key)).toEqual(["github:1"]);
        expect(await store.listOrgInvites("org_acme", 10)).toEqual([invite("github:9")]);
        expect(await store.invitesFor(["github:9"])).toEqual([invite("github:9")]);
        const rows = (await store.auditForOrg("org_acme", 20)).filter((e) => e.action === "member_invited");
        expect(rows.map((e) => [e.actorUserId, e.sessionId, e.detail])).toEqual([["u_github_1", "org:org_acme", { key: "github:9", role: "member" }]]);
      });

      it("refuses an org with no record, and a key this org already invited, keeping the first offer", async () => {
        expect(await store.putOrgInvite(invite("github:9"), by)).toBe("no_org");
        await seated();
        await store.putOrgInvite(invite("github:9"), by);
        expect(await store.putOrgInvite(invite("github:9", { role: "admin", invitedAt: 8 }), by)).toBe("exists");
        expect(await store.listOrgInvites("org_acme", 10)).toEqual([invite("github:9")]);
        expect(await orgEvents()).toEqual(["member_invited"]);
      });

      it("finds a key's invites from every org, in the keys' order and then by org, and none of a key it is a prefix of", async () => {
        await seated();
        await store.createOrg(acme({ orgId: "org_b", ownerUserId: "u_github_2" }), owner({ key: "github:2", orgId: "org_b" }), { actorUserId: "u_op" });
        await store.putOrgInvite(invite("email:bo@x.test", { orgId: "org_b" }), by);
        await store.putOrgInvite(invite("email:bo@x.test"), by);
        await store.putOrgInvite(invite("github:9"), by);
        await store.putOrgInvite(invite("github:99"), by);
        expect((await store.invitesFor(["github:9", "email:bo@x.test", "github:9"])).map((i) => [i.key, i.orgId])).toEqual([
          ["github:9", "org_acme"], ["email:bo@x.test", "org_acme"], ["email:bo@x.test", "org_b"],
        ]);
        expect(await store.invitesFor(["github:8", "email:bo@x"])).toEqual([]);
        expect((await store.listOrgInvites("org_acme", 10)).map((i) => i.key)).toEqual(["email:bo@x.test", "github:9", "github:99"]);
        expect((await store.listOrgInvites("org_acme", 2)).map((i) => i.key)).toEqual(["email:bo@x.test", "github:9"]);
        expect((await store.listOrgInvites("org_b", 10)).map((i) => i.key)).toEqual(["email:bo@x.test"]);
      });

      it("drops an invite once, both rows, with the admin's withdrawal recorded", async () => {
        await seated();
        await store.putOrgInvite(invite("github:9"), by);
        await store.putOrgInvite(invite("github:10"), by);
        expect(await store.deleteOrgInvite("org_acme", "github:9", by)).toBe("deleted");
        expect(await store.deleteOrgInvite("org_acme", "github:9", by)).toBe("missing");
        expect(await store.listOrgInvites("org_acme", 10)).toEqual([invite("github:10")]);
        expect(await store.invitesFor(["github:9", "github:10"])).toEqual([invite("github:10")]);
        expect(await orgEvents()).toEqual(["member_invited", "member_invited", "invite_withdrawn"]);
        expect(await store.putOrgInvite(invite("github:9"), by)).toBe("invited");
      });

      const person = { actorUserId: "u_github_9", actorLabel: "nine@x.test", actorOrgId: null };
      const keys = ["github:9", "github:nine@x.test", "email:nine@x.test"];

      it("joins in one operation: the invite's role, from the admin who invited, under the subject, and every key's invite gone", async () => {
        await seated();
        await store.putOrgInvite(invite("email:nine@x.test", { role: "admin", invitedBy: "u_github_7" }), by);
        await store.putOrgInvite(invite("github:9"), by);
        expect(await store.acceptOrgInvite("org_acme", keys, "github:9", 40, person)).toBe("joined");
        expect(await store.getGrant("github:9")).toEqual({
          key: "github:9", plan: "team", role: "member", orgId: "org_acme", source: "invite", grantedAt: 40, grantedBy: "u_github_1", expiresAt: null,
        });
        expect(await store.listOrgInvites("org_acme", 10)).toEqual([]);
        expect(await store.invitesFor(keys)).toEqual([]);
        expect(await store.countOrgMembers("org_acme")).toBe(2);
        const granted = (await store.auditForOrg("org_acme", 20)).at(-1);
        expect([granted?.action, granted?.actorUserId, granted?.detail.key]).toEqual(["plan_granted", "u_github_9", "github:9"]);
      });

      it("seats nobody for an offer that is not there: no record, no invite, or one withdrawn first", async () => {
        expect(await store.acceptOrgInvite("org_acme", keys, "github:9", 40, person)).toBe("gone");
        await seated();
        expect(await store.acceptOrgInvite("org_acme", keys, "github:9", 40, person)).toBe("gone");
        await store.putOrgInvite(invite("github:9"), by);
        await store.deleteOrgInvite("org_acme", "github:9", by);
        expect(await store.acceptOrgInvite("org_acme", keys, "github:9", 40, person)).toBe("gone");
        await store.createOrg(acme({ orgId: "org_b", ownerUserId: "u_github_2" }), owner({ key: "github:2", orgId: "org_b" }), { actorUserId: "u_op" });
        await store.putOrgInvite(invite("github:9", { orgId: "org_b" }), by);
        expect(await store.acceptOrgInvite("org_acme", keys, "github:9", 40, person)).toBe("gone");
        expect(await store.getGrant("github:9")).toBeUndefined();
      });

      it("refuses an org that requires SSO, a key holding any grant, and a full org, keeping the invite", async () => {
        await seated();
        await store.putOrgInvite(invite("github:9"), by);
        await store.updateOrg("org_acme", { requireSso: true }, by);
        expect(await store.acceptOrgInvite("org_acme", keys, "github:9", 40, person)).toBe("sso");
        await store.updateOrg("org_acme", { requireSso: false }, by);
        await store.putGrant(owner({ key: "email:nine@x.test", role: "member", orgId: null, plan: "pro", source: "operator" }));
        expect(await store.acceptOrgInvite("org_acme", keys, "github:9", 40, person)).toBe("taken");
        await store.deleteGrant("email:nine@x.test");
        await store.putGrantIfOwned(owner({ key: "github:3", role: "member", source: "org" }), "org_acme", by);
        expect(await store.acceptOrgInvite("org_acme", keys, "github:9", 40, person)).toBe("full");
        expect(await store.getGrant("github:9")).toBeUndefined();
        expect(await store.listOrgInvites("org_acme", 10)).toEqual([invite("github:9")]);
      });

      it("answers member for a key that already holds this org's grant, and drops the invites", async () => {
        await seated();
        await store.putOrgInvite(invite("email:nine@x.test"), by);
        await store.putGrantIfOwned(owner({ key: "github:9", role: "admin", source: "org" }), "org_acme", by);
        expect(await store.acceptOrgInvite("org_acme", keys, "github:9", 40, person)).toBe("member");
        expect(await store.getGrant("github:9")).toMatchObject({ role: "admin", source: "org" });
        expect(await store.listOrgInvites("org_acme", 10)).toEqual([]);
      });

      /** A seat on an address the org no longer owns by its form is an offer too, and the Join moves it onto the subject. */
      it("moves an unowned address seat onto the subject, even at the seats, and leaves an owned one alone", async () => {
        await seated();
        await store.putGrantIfOwned(owner({ key: "email:nine@x.test", role: "admin", source: "org", grantedBy: "u_github_7", grantedAt: 5 }), "org_acme", by);
        expect(await store.countOrgMembers("org_acme")).toBe(2);
        expect(await store.acceptOrgInvite("org_acme", keys, "github:9", 40, person)).toBe("joined");
        expect(await store.getGrant("email:nine@x.test")).toBeUndefined();
        expect(await store.getGrant("github:9")).toMatchObject({ role: "admin", source: "invite", grantedBy: "u_github_7", grantedAt: 40 });
        expect(await store.countOrgMembers("org_acme")).toBe(2);

        await store.claimDomain("org_acme", "y.test", "tok", 1, by);
        await store.verifyDomain("org_acme", "y.test", 2, by);
        await store.putGrantIfOwned(owner({ key: "email:ten@y.test", role: "member", source: "org" }), "org_acme", by);
        expect(await store.acceptOrgInvite("org_acme", ["github:10", "email:ten@y.test"], "github:10", 41, person)).toBe("gone");
      });

      /** An unowned seat holds nothing, in this org or another (ADR 0027): none of them makes the Join `taken` or `member`. */
      it("leaves another org's unowned seat out, and moves every unowned seat of this org's", async () => {
        await seated();
        await store.createOrg(acme({ orgId: "org_b", ownerUserId: "u_github_2" }), owner({ key: "github:2", orgId: "org_b" }), { actorUserId: "u_op" });
        await store.putGrantIfOwned(owner({ key: "email:nine@x.test", role: "member", source: "org", orgId: "org_b" }), "org_b", by);
        await store.putGrantIfOwned(owner({ key: "github:nine@x.test", role: "admin", source: "org", grantedBy: "u_github_7" }), "org_acme", by);
        expect(await store.acceptOrgInvite("org_acme", keys, "github:9", 40, person)).toBe("joined");
        expect(await store.getGrant("github:9")).toMatchObject({ orgId: "org_acme", role: "admin", grantedBy: "u_github_7", source: "invite" });
        expect(await store.getGrant("github:nine@x.test")).toBeUndefined();
        expect(await store.getGrant("email:nine@x.test")).toMatchObject({ orgId: "org_b" });

        await store.updateOrg("org_acme", { seats: 4 }, by);
        await store.putGrantIfOwned(owner({ key: "email:ten@x.test", role: "member", source: "org" }), "org_acme", by);
        await store.putGrantIfOwned(owner({ key: "github:ten@x.test", role: "member", source: "org" }), "org_acme", by);
        await store.updateOrg("org_acme", { seats: 2 }, by);
        expect(await store.acceptOrgInvite("org_acme", ["github:10", "github:ten@x.test", "email:ten@x.test"], "github:10", 41, person)).toBe("joined");
        expect([await store.getGrant("email:ten@x.test"), await store.getGrant("github:ten@x.test")]).toEqual([undefined, undefined]);
        expect(await store.countOrgMembers("org_acme")).toBe(3);
      });

      /** An address another org seated and never owned is the domain's owner's to seat (ADR 0027): the seat is replaced, naming no org to the one that held it. */
      it("lets the org that owns an address by its form take it from another org's unowned seat, and only that org", async () => {
        await seated();
        await store.createOrg(acme({ orgId: "org_b", ownerUserId: "u_github_2", seats: 3 }), owner({ key: "github:2", orgId: "org_b" }), { actorUserId: "u_op" });
        await store.putGrantIfOwned(owner({ key: "email:nine@x.test", role: "admin", source: "org", orgId: "org_b" }), "org_b", by);
        await store.putGrantIfOwned(owner({ key: "email:ten@y.test", role: "member", source: "org", orgId: "org_b" }), "org_b", by);
        await store.claimDomain("org_acme", "x.test", "tok", 1, by);
        await store.verifyDomain("org_acme", "x.test", 2, by);
        expect(await store.putGrantIfOwned(owner({ key: "email:nine@x.test", role: "member", source: "org" }), "org_acme", by)).toBe("written");
        expect(await store.getGrant("email:nine@x.test")).toMatchObject({ orgId: "org_acme", role: "member" });
        expect((await store.listGrants(10, "org_b")).map((g) => g.key).sort()).toEqual(["email:ten@y.test", "github:2"]);
        const revoked = (await store.auditForOrg("org_b", 20)).at(-1);
        expect([revoked?.action, revoked?.actorUserId, revoked?.actorOrgId, revoked?.detail.key]).toEqual(["plan_revoked", "system", null, "email:nine@x.test"]);
        expect(JSON.stringify(revoked)).not.toContain("org_acme");
        expect((await store.auditForOrg("org_acme", 20)).at(-1)).toMatchObject({ action: "plan_granted", detail: { key: "email:nine@x.test", org_id: "org_acme" } });
        expect(await store.putGrantIfOwned(owner({ key: "email:ten@y.test", role: "member", source: "org" }), "org_acme", by)).toBe("conflict");
        expect(await store.getGrant("email:ten@y.test")).toMatchObject({ orgId: "org_b" });
      });

      /** A seat the org's IdP pushed for an address it does not own is an unowned seat too (ADR 0027, ADR 0029). */
      const pushedUser = (over: Partial<ScimUser> = {}): ScimUser => ({
        id: "x1", orgId: "org_acme", userName: "nine@x.test", externalId: null, active: true, key: "email:nine@x.test",
        createdAt: 10, updatedAt: 10, deletedAt: null, ...over,
      });

      it("moves a pushed seat onto the subject at a Join, its SCIM rows with it, so the IdP still ends it", async () => {
        await seated();
        expect((await store.createScimUser(pushedUser(), scimIntent("org_acme"))).outcome).toBe("written");
        expect(await store.acceptOrgInvite("org_acme", keys, "github:9", 40, person)).toBe("joined");
        expect(await store.getGrant("email:nine@x.test")).toBeUndefined();
        expect(await store.scimUserByKey("github:9")).toMatchObject({ id: "x1", key: "github:9" });
        expect(await store.scimUserByName("org_acme", "nine@x.test")).toMatchObject({ id: "x1", key: "github:9" });
        expect(await store.scimUserByKey("email:nine@x.test")).toBeUndefined();
        expect((await store.updateScimUser("org_acme", "x1", { active: false }, 50, scimIntent("org_acme"))).outcome).toBe("updated");
        expect(await store.getGrant("github:9")).toBeUndefined();
      });

      /** A push alone never re-seats the account a person joined with (ADR 0027): a re-seat of a Join-linked user lands on the address. */
      const linkedByJoin = async () => {
        await seated();
        await store.createScimUser(pushedUser(), scimIntent("org_acme"));
        expect(await store.acceptOrgInvite("org_acme", keys, "github:9", 40, person)).toBe("joined");
        expect(await store.scimUserByKey("github:9")).toMatchObject({ id: "x1" });
      };

      it("restores a Join-linked person's seat on the address at a reactivation, never on their own account", async () => {
        await linkedByJoin();
        await store.updateScimUser("org_acme", "x1", { active: false }, 50, scimIntent("org_acme"));
        expect(await store.getGrant("github:9")).toBeUndefined();
        expect((await store.updateScimUser("org_acme", "x1", { active: true }, 60, scimIntent("org_acme"))).outcome).toBe("updated");
        expect(await store.getGrant("github:9")).toBeUndefined();
        expect(await store.getGrant("email:nine@x.test")).toMatchObject({ orgId: "org_acme", source: "scim" });
        expect(await store.scimUserByKey("email:nine@x.test")).toMatchObject({ id: "x1", key: "email:nine@x.test", active: true });
        expect(await store.scimUserByName("org_acme", "nine@x.test")).toMatchObject({ key: "email:nine@x.test" });
        expect(await store.scimUserByKey("github:9")).toBeUndefined();
      });

      it("seats a re-push after a delete on the address, never on the account the person joined with", async () => {
        await linkedByJoin();
        await store.deleteScimUser("org_acme", "x1", 50, scimIntent("org_acme"));
        expect((await store.createScimUser(pushedUser({ id: "x2", createdAt: 60, updatedAt: 60 }), scimIntent("org_acme"))).outcome).toBe("written");
        expect(await store.getGrant("github:9")).toBeUndefined();
        expect(await store.getGrant("email:nine@x.test")).toMatchObject({ orgId: "org_acme", source: "scim" });
        expect(await store.scimUserByKey("email:nine@x.test")).toMatchObject({ id: "x2" });
        expect(await store.scimUserByKey("github:9")).toBeUndefined();
      });

      it("restores the seat on the address with single sign-on required too, where it holds nothing until answered", async () => {
        await linkedByJoin();
        await store.updateScimUser("org_acme", "x1", { active: false }, 50, scimIntent("org_acme"));
        await store.updateOrg("org_acme", { requireSso: true }, by);
        await store.updateScimUser("org_acme", "x1", { active: true }, 60, scimIntent("org_acme"));
        expect(await store.getGrant("github:9")).toBeUndefined();
        expect(isUnownedSeat((await store.getGrant("email:nine@x.test"))!, await store.getOrg("org_acme"))).toBe(true);
      });

      /** Owned by its form, the address is re-seated, and the person's own sign-in claims it back onto their account. */
      it("re-seats an owned address's person on the address, which their next sign-in claims back by its form", async () => {
        await seated();
        await store.claimDomain("org_acme", "x.test", "tok", 1, by);
        await store.verifyDomain("org_acme", "x.test", 2, by);
        await store.createScimUser(pushedUser(), scimIntent("org_acme"));
        await store.moveGrant("email:nine@x.test", "github:9");
        await store.updateScimUser("org_acme", "x1", { active: false }, 50, scimIntent("org_acme"));
        await store.updateScimUser("org_acme", "x1", { active: true }, 60, scimIntent("org_acme"));
        expect(await store.getGrant("github:9")).toBeUndefined();
        expect(await store.getGrant("email:nine@x.test")).toMatchObject({ orgId: "org_acme", source: "scim" });
        await store.moveGrant("email:nine@x.test", "github:9");
        expect(await store.getGrant("github:9")).toMatchObject({ orgId: "org_acme", source: "scim" });
        expect(await store.scimUserByKey("github:9")).toMatchObject({ id: "x1" });
      });

      /** The IdP names the user, so no name it gives makes a personal account its to seat (ADR 0027). */
      const ownedDomain = async () => {
        await store.claimDomain("org_acme", "acme.test", "tok", 1, by);
        await store.verifyDomain("org_acme", "acme.test", 2, by);
      };

      it("re-seats the address, not the person's account, when the IdP renames them onto an owned domain and then reactivates", async () => {
        await linkedByJoin();
        await store.updateScimUser("org_acme", "x1", { active: false }, 50, scimIntent("org_acme"));
        await ownedDomain();
        expect((await store.updateScimUser("org_acme", "x1", { userName: "nine@acme.test" }, 51, scimIntent("org_acme"))).outcome).toBe("updated");
        expect((await store.updateScimUser("org_acme", "x1", { active: true }, 52, scimIntent("org_acme"))).outcome).toBe("updated");
        expect(await store.getGrant("github:9")).toBeUndefined();
        expect(await store.getGrant("email:nine@acme.test")).toMatchObject({ orgId: "org_acme", source: "scim" });
        expect(await store.scimUserByKey("github:9")).toBeUndefined();
      });

      it("re-seats the address for a rename onto an owned domain and a reactivation in one update", async () => {
        await linkedByJoin();
        await store.updateScimUser("org_acme", "x1", { active: false }, 50, scimIntent("org_acme"));
        await ownedDomain();
        expect((await store.updateScimUser("org_acme", "x1", { userName: "nine@acme.test", active: true }, 51, scimIntent("org_acme"))).outcome).toBe("updated");
        expect(await store.getGrant("github:9")).toBeUndefined();
        expect(await store.getGrant("email:nine@acme.test")).toMatchObject({ orgId: "org_acme", source: "scim" });
      });

      it("seats a re-push of a user renamed onto an owned domain and deleted on the address, not the account", async () => {
        await linkedByJoin();
        await ownedDomain();
        await store.updateScimUser("org_acme", "x1", { userName: "nine@acme.test" }, 50, scimIntent("org_acme"));
        await store.deleteScimUser("org_acme", "x1", 51, scimIntent("org_acme"));
        expect(await store.getGrant("github:9")).toBeUndefined();
        const repushed = pushedUser({ id: "x2", userName: "nine@acme.test", key: "email:nine@acme.test", createdAt: 60, updatedAt: 60 });
        expect((await store.createScimUser(repushed, scimIntent("org_acme"))).outcome).toBe("written");
        expect(await store.getGrant("github:9")).toBeUndefined();
        expect(await store.getGrant("email:nine@acme.test")).toMatchObject({ orgId: "org_acme", source: "scim" });
      });

      it("leaves no index row on the account a re-pushed user no longer names", async () => {
        await linkedByJoin();
        await store.deleteScimUser("org_acme", "x1", 50, scimIntent("org_acme"));
        expect(await harness.scimIndexRows()).toContain("sk:github:9");
        await store.createScimUser(pushedUser({ id: "x2", createdAt: 60, updatedAt: 60 }), scimIntent("org_acme"));
        expect(await harness.scimIndexRows()).toEqual(["sk:email:nine@x.test"]);
      });

      it("lets the domain's owner take a key another org's IdP pushed, and leaves that org's IdP no index on it", async () => {
        await seated();
        await store.createOrg(acme({ orgId: "org_b", ownerUserId: "u_github_2", seats: 3 }), owner({ key: "github:2", orgId: "org_b" }), { actorUserId: "u_op" });
        await store.createScimUser(pushedUser({ orgId: "org_b" }), scimIntent("org_b"));
        await store.claimDomain("org_acme", "x.test", "tok", 1, by);
        await store.verifyDomain("org_acme", "x.test", 2, by);
        expect(await store.putGrantIfOwned(owner({ key: "email:nine@x.test", role: "member", source: "org" }), "org_acme", by)).toBe("written");
        expect(await store.scimUserByKey("email:nine@x.test")).toBeUndefined();
        await store.moveGrant("email:nine@x.test", "github:9");
        expect(await store.scimUserByKey("github:9")).toBeUndefined();
        await store.updateScimUser("org_b", "x1", { active: false }, 50, scimIntent("org_b"));
        expect(await store.getGrant("github:9")).toMatchObject({ orgId: "org_acme" });
      });

      it("keeps a decline on the person's side: the org's invites stay, and the decline is listed once, at its latest", async () => {
        await seated();
        await store.putOrgInvite(invite("github:9"), by);
        await store.putOrgInvite(invite("email:nine@x.test"), by);
        expect(await store.declinedOrgs("github:9")).toEqual([]);
        await store.declineOrg("github:9", "org_acme", 40);
        await store.declineOrg("github:9", "org_acme", 41);
        await store.declineOrg("github:9", "org_acme", 30);
        await store.declineOrg("github:9", "org_b", 42);
        expect(await store.declinedOrgs("github:9")).toEqual([{ orgId: "org_acme", at: 41 }, { orgId: "org_b", at: 42 }]);
        expect(await store.declinedOrgs("github:99")).toEqual([]);
        expect((await store.listOrgInvites("org_acme", 10)).map((i) => i.key)).toEqual(["email:nine@x.test", "github:9"]);
        expect(await orgEvents()).toEqual(["member_invited", "member_invited"]);
      });

      it("holds MAX_PENDING_INVITES at once, takes no seat for any of them, and refuses the next", async () => {
        await seated();
        for (let n = 0; n < MAX_PENDING_INVITES; n++) {
          expect(await store.putOrgInvite(invite(`github:${1000 + n}`), by)).toBe("invited");
        }
        expect(await store.putOrgInvite(invite("github:5000"), by)).toBe("limit");
        expect(await store.invitesFor(["github:5000"])).toEqual([]);
        expect(await store.countOrgMembers("org_acme")).toBe(1);
        await store.deleteOrgInvite("org_acme", "github:1000", by);
        expect(await store.putOrgInvite(invite("github:5000"), by)).toBe("invited");
      });
    });

    describe("SCIM (#56)", () => {
      const acme = (over: Partial<Org> = {}): Org => ({
        orgId: "org_acme", name: "Acme", ownerUserId: "u_github_1", seats: 2, source: "operator",
        active: true, createdAt: 1, requireSso: false, domains: [], policy: DEFAULT_POLICY, ...over,
      });
      const owner = (over: Partial<PlanGrant> = {}): PlanGrant => ({
        key: "github:1", plan: "team", role: "admin", orgId: "org_acme", source: "operator",
        grantedAt: 1, grantedBy: "u_op", expiresAt: null, ...over,
      });
      const by = { actorUserId: "u_github_1", actorLabel: "Ana", actorOrgId: "org_acme" };
      const actions = async (orgId = "org_acme") => (await store.auditForOrg(orgId, 30)).map((e) => e.action);
      const seated = async () => { await store.createOrg(acme(), owner(), { actorUserId: "u_op" }); };
      const user = (over: Partial<ScimUser> = {}): ScimUser => ({
        id: "x1", orgId: "org_acme", userName: "bo@acme.test", externalId: "00u-bo", active: true, key: "email:bo@acme.test", createdAt: 10, updatedAt: 10,
        deletedAt: null, ...over,
      });
      const scim = scimIntent("org_acme");

      it("issues one token per org, replaces it, and revokes it, so only the newest hash resolves", async () => {
        expect(await store.issueScimToken("org_acme", { tokenHash: "h1", issuedAt: 5, issuedBy: "u_github_1" }, by)).toBe("missing");
        await seated();
        expect(await store.issueScimToken("org_acme", { tokenHash: "h1", issuedAt: 5, issuedBy: "u_github_1" }, by)).toBe("issued");
        expect(await store.orgForScimToken("h1")).toBe("org_acme");
        expect(await store.scimTokenOf("org_acme")).toEqual({ tokenHash: "h1", issuedAt: 5, issuedBy: "u_github_1" });
        expect(await store.issueScimToken("org_acme", { tokenHash: "h2", issuedAt: 6, issuedBy: "u_github_1" }, by)).toBe("replaced");
        expect(await store.orgForScimToken("h1")).toBeUndefined();
        expect(await store.orgForScimToken("h2")).toBe("org_acme");
        expect(await store.revokeScimToken("org_acme", by)).toBe("revoked");
        expect(await store.orgForScimToken("h2")).toBeUndefined();
        expect(await store.scimTokenOf("org_acme")).toBeUndefined();
        expect(await store.revokeScimToken("org_acme", by)).toBe("missing");
        expect(await actions()).toEqual(["org_created", "plan_granted", "scim_token_issued", "scim_token_issued", "scim_token_revoked"]);
        expect((await store.auditForOrg("org_acme", 20)).map((e) => e.detail.replaced)).toEqual([undefined, undefined, false, true, undefined]);
      });

      it("creates a SCIM user as a member grant from scim, and finds it by id, name and key", async () => {
        expect(await store.createScimUser(user(), scim)).toEqual({ outcome: "no_org" });
        await seated();
        expect(await store.createScimUser(user(), scim)).toEqual({ outcome: "written", user: user() });
        expect(await store.getGrant("email:bo@acme.test")).toEqual({
          key: "email:bo@acme.test", plan: "team", role: "member", orgId: "org_acme", source: "scim", grantedAt: 10, grantedBy: "scim", expiresAt: null,
        });
        expect(await store.getScimUser("org_acme", "x1")).toEqual(user());
        expect(await store.getScimUser("org_b", "x1")).toBeUndefined();
        expect(await store.scimUserByName("org_acme", "bo@acme.test")).toEqual(user());
        expect(await store.scimUserByKey("email:bo@acme.test")).toEqual(user());
        expect(await store.createScimUser(user({ id: "x2" }), scim)).toEqual({ outcome: "exists" });
        expect(await store.countOrgMembers("org_acme")).toBe(2);
        expect(await store.createScimUser(user({ id: "x3", userName: "cy@acme.test", key: "email:cy@acme.test" }), scim)).toEqual({ outcome: "full" });
        expect(await store.getScimUser("org_acme", "x3")).toBeUndefined();
        expect((await actions()).slice(2)).toEqual(["plan_granted", "scim_user_created"]);
        expect((await store.auditForOrg("org_acme", 20)).at(-1)).toMatchObject({
          sessionId: "scim:x1", actorUserId: "scim", detail: { user_name: "bo@acme.test", external_id: "00u-bo", key: "email:bo@acme.test", linked: false },
        });
      });

      it("links a push to an address an admin seated, keeping the role, and refuses one another org holds", async () => {
        await seated();
        await store.putGrantIfOwned(owner({ key: "email:bo@acme.test", role: "admin", source: "org" }), "org_acme", by);
        const made = await store.createScimUser(user(), scim);
        expect(made).toEqual({ outcome: "linked", user: user() });
        expect(await store.getGrant("email:bo@acme.test")).toMatchObject({ role: "admin", source: "org" });
        expect(await store.countOrgMembers("org_acme")).toBe(2);
        expect((await store.auditForOrg("org_acme", 20)).at(-1)).toMatchObject({ action: "scim_user_created", detail: { linked: true } });
        await store.createOrg(acme({ orgId: "org_b", ownerUserId: "u_github_2" }), owner({ key: "github:2", orgId: "org_b" }), { actorUserId: "u_op" });
        await store.putGrantIfOwned(owner({ key: "email:di@acme.test", role: "member", orgId: "org_b", source: "org" }), "org_b", { actorUserId: "u_github_2" });
        expect(await store.createScimUser(user({ id: "x4", userName: "di@acme.test", key: "email:di@acme.test" }), scim)).toEqual({ outcome: "conflict" });
        expect(await store.getScimUser("org_acme", "x4")).toBeUndefined();
      });

      it("creates an inactive user with no grant and no seat", async () => {
        await seated();
        expect(await store.createScimUser(user({ active: false }), scim)).toEqual({ outcome: "written", user: user({ active: false }) });
        expect(await store.getGrant("email:bo@acme.test")).toBeUndefined();
        expect(await store.countOrgMembers("org_acme")).toBe(1);
        expect(await store.scimUserByKey("email:bo@acme.test")).toEqual(user({ active: false }));
      });

      it("lists an org's users in id order, within the limit, and only its own", async () => {
        await seated();
        await store.createScimUser(user({ id: "b", active: false }), scim);
        await store.createScimUser(user({ id: "a", userName: "al@acme.test", key: "email:al@acme.test", active: false }), scim);
        expect((await store.listScimUsers("org_acme", 10)).map((u) => u.id)).toEqual(["a", "b"]);
        expect((await store.listScimUsers("org_acme", 1)).map((u) => u.id)).toEqual(["a"]);
        expect(await store.listScimUsers("org_b", 10)).toEqual([]);
      });

      it("deactivates by deleting the grant and keeping the row, reactivates within the seats, and is idempotent", async () => {
        await seated();
        await store.createScimUser(user(), scim);
        const off = await store.updateScimUser("org_acme", "x1", { active: false }, 20, scim);
        expect(off).toEqual({ outcome: "updated", user: user({ active: false, updatedAt: 20 }), was: user() });
        expect(await store.getGrant("email:bo@acme.test")).toBeUndefined();
        expect(await store.countOrgMembers("org_acme")).toBe(1);
        expect(await store.updateScimUser("org_acme", "x1", { active: false }, 21, scim)).toMatchObject({ outcome: "updated", user: { active: false, updatedAt: 20 } });
        await store.createScimUser(user({ id: "x2", userName: "cy@acme.test", key: "email:cy@acme.test" }), scim);
        expect(await store.updateScimUser("org_acme", "x1", { active: true }, 22, scim)).toEqual({ outcome: "full" });
        await store.updateScimUser("org_acme", "x2", { active: false }, 23, scim);
        expect(await store.updateScimUser("org_acme", "x1", { active: true }, 24, scim)).toMatchObject({ outcome: "updated", user: { active: true, updatedAt: 24 } });
        expect(await store.getGrant("email:bo@acme.test")).toMatchObject({ role: "member", source: "scim", grantedAt: 24 });
        expect(await store.updateScimUser("org_acme", "nobody", { active: false }, 25, scim)).toEqual({ outcome: "missing" });
        expect(await store.updateScimUser("org_b", "x1", { active: false }, 25, scim)).toEqual({ outcome: "missing" });
        expect((await actions()).filter((a) => a.startsWith("scim_user") || a.startsWith("plan"))).toEqual([
          "plan_granted", "plan_granted", "scim_user_created", "plan_revoked", "scim_user_deactivated",
          "plan_granted", "scim_user_created", "plan_revoked", "scim_user_deactivated", "plan_granted", "scim_user_reactivated",
        ]);
      });

      it("renames by moving an address grant and the directory entry, leaves a claimed key, and refuses a taken name", async () => {
        await seated();
        await store.createScimUser(user(), scim);
        await store.createScimUser(user({ id: "x2", userName: "cy@acme.test", key: "email:cy@acme.test", active: false }), scim);
        expect(await store.updateScimUser("org_acme", "x1", { userName: "cy@acme.test" }, 30, scim)).toEqual({ outcome: "exists" });
        expect(await store.updateScimUser("org_acme", "x1", { userName: "robert@acme.test", externalId: null }, 31, scim)).toMatchObject({
          outcome: "updated", user: { userName: "robert@acme.test", key: "email:robert@acme.test", externalId: null },
        });
        expect(await store.getGrant("email:bo@acme.test")).toBeUndefined();
        expect(await store.getGrant("email:robert@acme.test")).toMatchObject({ source: "scim" });
        expect(await store.scimUserByName("org_acme", "bo@acme.test")).toBeUndefined();
        expect(await store.scimUserByName("org_acme", "robert@acme.test")).toMatchObject({ id: "x1" });
        expect(await store.scimUserByKey("email:robert@acme.test")).toMatchObject({ id: "x1" });
        expect(await store.scimUserByKey("email:bo@acme.test")).toBeUndefined();
        await store.moveGrant("email:robert@acme.test", "github:77");
        expect(await store.scimUserByKey("github:77")).toMatchObject({ id: "x1", key: "github:77" });
        expect(await store.scimUserByKey("email:robert@acme.test")).toBeUndefined();
        expect(await store.scimUserByName("org_acme", "robert@acme.test")).toMatchObject({ key: "github:77" });
        expect(await store.updateScimUser("org_acme", "x1", { userName: "rob@acme.test" }, 32, scim)).toMatchObject({
          outcome: "updated", user: { userName: "rob@acme.test", key: "github:77" },
        });
        expect(await store.getGrant("github:77")).toMatchObject({ source: "scim" });
        expect(await store.scimUserByName("org_acme", "rob@acme.test")).toMatchObject({ id: "x1" });
        expect((await actions()).at(-1)).toBe("scim_user_updated");
        expect((await store.auditForOrg("org_acme", 20)).at(-1)?.detail).toEqual({ user_name: "rob@acme.test", key: "github:77", from: "robert@acme.test" });
      });

      it("seats an SSO sign-in and writes the directory for its address, then links a later push", async () => {
        await seated();
        const sso = { actorUserId: "sso", detail: { org_id: "org_acme" } };
        expect(await store.provisionSsoMember("org_acme", "sso:org_acme:00u1", 13, sso, "bo@acme.test")).toBe("written");
        expect(await store.scimUserByName("org_acme", "bo@acme.test")).toBeUndefined();
        const made = await store.createScimUser(user({ key: "email:bo@acme.test" }), scim);
        expect(made).toMatchObject({ outcome: "linked", user: { key: "sso:org_acme:00u1" } });
        expect(await store.scimUserByKey("sso:org_acme:00u1")).toMatchObject({ id: "x1" });
        expect(await store.scimUserByName("org_acme", "bo@acme.test")).toMatchObject({ id: "x1", key: "sso:org_acme:00u1" });
        expect(await store.getGrant("email:bo@acme.test")).toBeUndefined();
        expect(await store.countOrgMembers("org_acme")).toBe(2);
      });

      it("claims a SCIM user's address grant onto the subject inside the seat, keeping the role, and refuses a deprovisioned one", async () => {
        await seated();
        await store.createScimUser(user(), scim);
        await store.putGrantIfOwned({ ...(await store.getGrant("email:bo@acme.test"))!, role: "admin" }, "org_acme", by);
        const sso = { actorUserId: "sso", detail: { org_id: "org_acme" } };
        expect(await store.provisionSsoMember("org_acme", "sso:org_acme:00u1", 14, sso, "bo@acme.test")).toBe("written");
        expect(await store.getGrant("email:bo@acme.test")).toBeUndefined();
        expect(await store.getGrant("sso:org_acme:00u1")).toMatchObject({ role: "admin", source: "scim" });
        expect(await store.scimUserByKey("sso:org_acme:00u1")).toMatchObject({ id: "x1", key: "sso:org_acme:00u1" });
        expect(await store.scimUserByKey("email:bo@acme.test")).toBeUndefined();
        expect(await store.countOrgMembers("org_acme")).toBe(2);
        // The owner's, the push's, and the role change's: the move onto the subject files none.
        expect((await actions()).filter((a) => a === "plan_granted")).toHaveLength(3);
        await store.updateScimUser("org_acme", "x1", { active: false }, 15, scim);
        expect(await store.provisionSsoMember("org_acme", "sso:org_acme:00u1", 16, sso, "bo@acme.test")).toBe("deprovisioned");
        expect(await store.provisionSsoMember("org_acme", "sso:org_acme:00u1", 16, sso)).toBe("deprovisioned");
        expect(await store.provisionSsoMember("org_acme", "sso:org_acme:00u9", 16, sso, "bo@acme.test")).toBe("deprovisioned");
        expect(await store.countOrgMembers("org_acme")).toBe(1);
      });

      it("claims an admin's address grant inside the seat, as the callback did in two calls", async () => {
        await seated();
        await store.putGrantIfOwned(owner({ key: "email:bo@acme.test", role: "admin", source: "org" }), "org_acme", by);
        const sso = { actorUserId: "sso", detail: { org_id: "org_acme" } };
        expect(await store.provisionSsoMember("org_acme", "sso:org_acme:00u1", 14, sso, "bo@acme.test")).toBe("written");
        expect(await store.getGrant("sso:org_acme:00u1")).toMatchObject({ role: "admin", source: "org" });
        expect(await store.getGrant("email:bo@acme.test")).toBeUndefined();
        expect(await store.countOrgMembers("org_acme")).toBe(2);
        // An address another org seated is not this org's to move: the person takes a seat of their own.
        await store.createOrg(acme({ orgId: "org_b", ownerUserId: "u_github_2" }), owner({ key: "github:2", orgId: "org_b" }), { actorUserId: "u_op" });
        await store.putGrantIfOwned(owner({ key: "email:cy@acme.test", role: "member", orgId: "org_b", source: "org" }), "org_b", { actorUserId: "u_github_2" });
        expect(await store.provisionSsoMember("org_acme", "sso:org_acme:00u2", 15, sso, "cy@acme.test")).toBe("full");
        await store.updateOrg("org_acme", { seats: 3 }, by);
        expect(await store.provisionSsoMember("org_acme", "sso:org_acme:00u2", 15, sso, "cy@acme.test")).toBe("written");
        expect(await store.getGrant("email:cy@acme.test")).toMatchObject({ orgId: "org_b" });
      });

      it("refuses a rename or a reactivation onto an address another org holds, and keeps a seat this org gave meanwhile", async () => {
        await seated();
        await store.createOrg(acme({ orgId: "org_b", ownerUserId: "u_github_2", seats: 5 }), owner({ key: "github:2", orgId: "org_b" }), { actorUserId: "u_github_2" });
        const byB = { actorUserId: "u_github_2" };
        await store.createScimUser(user(), scim);
        await store.putGrantIfOwned(owner({ key: "email:di@acme.test", role: "member", orgId: "org_b", source: "org" }), "org_b", byB);
        expect(await store.updateScimUser("org_acme", "x1", { userName: "di@acme.test" }, 50, scim)).toEqual({ outcome: "conflict" });
        expect(await store.getGrant("email:di@acme.test")).toMatchObject({ orgId: "org_b" });
        expect(await store.getScimUser("org_acme", "x1")).toMatchObject({ userName: "bo@acme.test", key: "email:bo@acme.test", updatedAt: 10 });
        // This org seated the new address by hand: the rename would merge two members.
        await store.updateOrg("org_acme", { seats: 3 }, by);
        await store.putGrantIfOwned(owner({ key: "email:ed@acme.test", role: "member", source: "org" }), "org_acme", by);
        expect(await store.updateScimUser("org_acme", "x1", { userName: "ed@acme.test" }, 51, scim)).toEqual({ outcome: "exists" });
        // Deactivated, then another org seats the address: reactivating would hand that org's seat to this one.
        await store.updateScimUser("org_acme", "x1", { active: false }, 52, scim);
        await store.putGrantIfOwned(owner({ key: "email:bo@acme.test", role: "member", orgId: "org_b", source: "org" }), "org_b", byB);
        expect(await store.updateScimUser("org_acme", "x1", { active: true }, 53, scim)).toEqual({ outcome: "conflict" });
        expect(await store.getGrant("email:bo@acme.test")).toMatchObject({ orgId: "org_b" });
        expect(await store.getScimUser("org_acme", "x1")).toMatchObject({ active: false });
        // This org re-seated the address by hand while the user was inactive: reactivation keeps that grant, its role included.
        await store.deleteGrantIfOwned("email:bo@acme.test", "org_b", byB);
        await store.putGrantIfOwned(owner({ key: "email:bo@acme.test", role: "admin", source: "org" }), "org_acme", by);
        expect(await store.updateScimUser("org_acme", "x1", { active: true }, 54, scim)).toMatchObject({ outcome: "updated", user: { active: true, updatedAt: 54 } });
        expect(await store.getGrant("email:bo@acme.test")).toMatchObject({ role: "admin", source: "org" });
        expect(await store.countOrgMembers("org_acme")).toBe(3);
        expect((await actions()).at(-1)).toBe("scim_user_reactivated");
      });

      it("deletes a user into a tombstone that keeps refusing the key, and a push after it starts over", async () => {
        await seated();
        await store.createScimUser(user(), scim);
        expect(await store.deleteScimUser("org_acme", "x1", 40, scim)).toEqual(user());
        expect(await store.getGrant("email:bo@acme.test")).toBeUndefined();
        expect(await store.getScimUser("org_acme", "x1")).toBeUndefined();
        expect(await store.scimUserByName("org_acme", "bo@acme.test")).toBeUndefined();
        expect(await store.listScimUsers("org_acme", 10)).toEqual([]);
        // The key index outlives the row: a deleted subject is refused as a deactivated one is (SCIM spec, D4).
        expect(await store.scimUserByKey("email:bo@acme.test")).toEqual(user({ active: false, updatedAt: 40, deletedAt: 40 }));
        // A repeat answers the tombstone, so a walk cut short can be finished.
        expect(await store.deleteScimUser("org_acme", "x1", 41, scim)).toEqual(user({ active: false, updatedAt: 40, deletedAt: 40 }));
        expect(await store.updateScimUser("org_acme", "x1", { active: true }, 42, scim)).toEqual({ outcome: "missing" });
        expect((await actions()).slice(-2)).toEqual(["plan_revoked", "scim_user_deleted"]);
        // The IdP assigns them again: a new row, the old tombstone gone, a seat taken.
        expect(await store.createScimUser(user({ id: "x9", createdAt: 43, updatedAt: 43 }), scim)).toEqual({ outcome: "written", user: user({ id: "x9", createdAt: 43, updatedAt: 43 }) });
        expect(await store.scimUserByKey("email:bo@acme.test")).toMatchObject({ id: "x9", active: true });
        expect(await store.scimUserByName("org_acme", "bo@acme.test")).toMatchObject({ id: "x9" });
        expect(await store.getGrant("email:bo@acme.test")).toMatchObject({ source: "scim", grantedAt: 43 });
        expect(await store.countOrgMembers("org_acme")).toBe(2);
      });

      it("finds a person by their address however the IdP spells it", async () => {
        await seated();
        const sso = { actorUserId: "sso", detail: { org_id: "org_acme" } };
        expect(await store.provisionSsoMember("org_acme", "sso:org_acme:00u1", 13, sso, "Bo.Smith@Acme.test")).toBe("written");
        const pushed = await store.createScimUser(user({ userName: "bo.smith@acme.test", key: "email:bo.smith@acme.test" }), scim);
        expect(pushed).toMatchObject({ outcome: "linked", user: { key: "sso:org_acme:00u1" } });
        expect(await store.countOrgMembers("org_acme")).toBe(2);
        // And the other way round: a push first, then a sign-in that spells the address in capitals.
        await store.updateOrg("org_acme", { seats: 4 }, by);
        await store.createScimUser(user({ id: "x2", userName: "cy@acme.test", key: "email:cy@acme.test" }), scim);
        expect(await store.provisionSsoMember("org_acme", "sso:org_acme:00u2", 14, sso, "CY@ACME.TEST")).toBe("written");
        expect(await store.getGrant("email:cy@acme.test")).toBeUndefined();
        expect(await store.getGrant("sso:org_acme:00u2")).toMatchObject({ source: "scim" });
        expect(await store.scimUserByKey("sso:org_acme:00u2")).toMatchObject({ id: "x2" });
        expect(await store.countOrgMembers("org_acme")).toBe(3);
      });

      it("takes the seat of a person it pushes as inactive, as a deactivation would", async () => {
        await seated();
        const sso = { actorUserId: "sso", detail: { org_id: "org_acme" } };
        await store.provisionSsoMember("org_acme", "sso:org_acme:00u1", 13, sso, "bo@acme.test");
        const pushed = await store.createScimUser(user({ active: false }), scim);
        expect(pushed).toMatchObject({ outcome: "linked", user: { key: "sso:org_acme:00u1", active: false } });
        expect(await store.getGrant("sso:org_acme:00u1")).toBeUndefined();
        expect(await store.countOrgMembers("org_acme")).toBe(1);
        expect((await actions()).slice(-2)).toEqual(["plan_revoked", "scim_user_created"]);
        expect(await store.provisionSsoMember("org_acme", "sso:org_acme:00u1", 14, sso, "bo@acme.test")).toBe("deprovisioned");
      });

      it("moves the seat to the door the person last came through: a claimed GitHub key, and a reissued subject", async () => {
        await seated();
        await store.createScimUser(user(), scim);
        await store.moveGrant("email:bo@acme.test", "github:77");
        const sso = { actorUserId: "sso", detail: { org_id: "org_acme" } };
        expect(await store.provisionSsoMember("org_acme", "sso:org_acme:00u1", 14, sso, "bo@acme.test")).toBe("written");
        expect(await store.getGrant("github:77")).toBeUndefined();
        expect(await store.getGrant("sso:org_acme:00u1")).toMatchObject({ source: "scim" });
        expect(await store.scimUserByKey("sso:org_acme:00u1")).toMatchObject({ id: "x1", key: "sso:org_acme:00u1" });
        expect(await store.provisionSsoMember("org_acme", "sso:org_acme:00u9", 15, sso, "bo@acme.test")).toBe("written");
        expect(await store.getGrant("sso:org_acme:00u1")).toBeUndefined();
        expect(await store.getGrant("sso:org_acme:00u9")).toMatchObject({ source: "scim" });
        expect(await store.scimUserByKey("sso:org_acme:00u9")).toMatchObject({ id: "x1" });
        expect(await store.countOrgMembers("org_acme")).toBe(2);
      });
    });

    describe("saved presets", () => {
      const preset = (name: string, over: Partial<SavedPreset> = {}): SavedPreset => ({
        name,
        description: null,
        mode: "pair",
        heartbeat: null,
        housekeeping: null,
        roles: { lead: { can: ["send"], description: null, heartbeat_on: false } },
        default_role: "lead",
        creator_role: "lead",
        updated_at: "2026-03-15T12:00:00.000Z",
        ...over,
      });

      // Review Focus 2: a row saved before the vocabulary changed is read in its new words.
      it("reads a preset saved in the heartbeat's old words back in its new ones", async () => {
        const old = {
          name: "old_words", description: null, mode: "pair", heartbeat_on: "5m", housekeeping: null,
          roles: { lead: { can: ["send"], description: null, reports: true, report: "What shipped" }, quiet: { can: [], description: null, reports: false } },
          default_role: "quiet", creator_role: "lead", host: null, updated_at: "2026-03-15T12:00:00.000Z",
        };
        expect(await store.putPreset("u_jesse", old as unknown as SavedPreset, 20)).toBe("saved");
        const { heartbeat_on: _old, ...rest } = old;
        const now = {
          ...rest, heartbeat: "5m",
          roles: { lead: { can: ["send"], description: null, heartbeat_on: "What shipped" }, quiet: { can: [], description: null, heartbeat_on: false } },
        };
        expect(await store.getPreset("u_jesse", "old_words")).toEqual(now);
        expect((await store.listPresets("u_jesse")).find((p) => p.name === "old_words")).toEqual(now);
      });

      it("lists a person's presets in name order, and none for a person with none", async () => {
        expect(await store.listPresets("u_jesse")).toEqual([]);
        for (const name of ["b", "a_x", "a"]) expect(await store.putPreset("u_jesse", preset(name), 20)).toBe("saved");
        expect((await store.listPresets("u_jesse")).map((p) => p.name)).toEqual(["a", "a_x", "b"]);
      });

      it("gets one by name as a copy the caller cannot change in the store, and none for a name not saved", async () => {
        await store.putPreset("u_jesse", preset("a", { description: "first" }), 20);
        const got = (await store.getPreset("u_jesse", "a"))!;
        expect(got).toEqual(preset("a", { description: "first" }));
        got.roles.lead.can.push("invite");
        expect((await store.getPreset("u_jesse", "a"))!.roles.lead.can).toEqual(["send"]);
        expect(await store.getPreset("u_jesse", "b")).toBeUndefined();
      });

      // Housekeeping (#66), integration ruling M1: the block is part of what a preset is, so a
      // store keeps it whole through get and list, and hands out a copy of it like the roles.
      it("keeps a preset's housekeeping through get and list, as a copy the caller cannot change in the store", async () => {
        const block = { quiet_after: "2h", idle_after: "1d" };
        await store.putPreset("u_jesse", preset("a", { housekeeping: block }), 20);
        const got = (await store.getPreset("u_jesse", "a"))!;
        expect(got.housekeeping).toEqual(block);
        got.housekeeping!.quiet_after = "5m";
        expect((await store.getPreset("u_jesse", "a"))!.housekeeping).toEqual(block);
        expect((await store.listPresets("u_jesse")).map((p) => p.housekeeping)).toEqual([block]);
      });

      // A saved preset carries the author arm's host block (#188 beneath the designer); a store
      // that dropped it would turn a hosted preset into a room with nobody in its host role.
      it("keeps a preset's host block, and gives back one saved without the key as it was saved", async () => {
        const hosted = preset("h", {
          mode: "swarm", heartbeat: "1h",
          roles: { lead: { can: ["send"], description: null, heartbeat_on: false }, emcee: { can: ["send"], description: null, heartbeat_on: false } },
          host: { role: "emcee", model: "sonnet", instructions: "Ask one thing." },
        });
        await store.putPreset("u_jesse", hosted, 20);
        await store.putPreset("u_jesse", preset("legacy"), 20);
        expect(await store.getPreset("u_jesse", "h")).toEqual(hosted);
        expect((await store.listPresets("u_jesse")).map((p) => [p.name, p.host])).toEqual([["h", hosted.host], ["legacy", undefined]]);
      });

      it("replaces by name", async () => {
        await store.putPreset("u_jesse", preset("a", { description: "first" }), 20);
        await store.putPreset("u_jesse", preset("a", { description: "second" }), 20);
        expect((await store.listPresets("u_jesse")).map((p) => p.description)).toEqual(["second"]);
      });

      it("refuses a new name at the cap, and still replaces one already saved", async () => {
        expect(await store.putPreset("u_jesse", preset("a"), 2)).toBe("saved");
        expect(await store.putPreset("u_jesse", preset("b"), 2)).toBe("saved");
        expect(await store.putPreset("u_jesse", preset("c"), 2)).toBe("full");
        expect(await store.putPreset("u_jesse", preset("a", { description: "again" }), 2)).toBe("saved");
        expect((await store.listPresets("u_jesse")).map((p) => p.name)).toEqual(["a", "b"]);
      });

      it("lets one of two new names racing for the last place land, never both", async () => {
        await store.putPreset("u_jesse", preset("a"), 2);
        const verdicts = await Promise.all([
          store.putPreset("u_jesse", preset("b"), 2),
          store.putPreset("u_jesse", preset("c"), 2),
        ]);
        expect([...verdicts].sort()).toEqual(["full", "saved"]);
        expect(await store.listPresets("u_jesse")).toHaveLength(2);
      });

      it("keeps each person's presets apart", async () => {
        await store.putPreset("u_jesse", preset("a"), 1);
        expect(await store.putPreset("u_peer", preset("a", { description: "theirs" }), 1)).toBe("saved");
        expect((await store.getPreset("u_jesse", "a"))!.description).toBeNull();
        expect(await store.deletePreset("u_peer", "a")).toBe(true);
        expect(await store.getPreset("u_jesse", "a")).toBeDefined();
      });

      // Operator-issued ids may hold a colon, so one person's id can extend another's past
      // the key's separator. Neither may reach the other's presets through it.
      it("never reaches another person's presets through an id that extends this one past a colon", async () => {
        await store.putPreset("u_x:y", preset("n"), 20);
        expect(await store.listPresets("u_x")).toEqual([]);
        expect(await store.getPreset("u_x", "y:n")).toBeUndefined();
        expect(await store.deletePreset("u_x", "y:n")).toBe(false);
        expect(await store.getPreset("u_x:y", "n")).toBeDefined();
        expect(await store.putPreset("u_x", preset("a"), 1)).toBe("saved");
      });

      it("deletes one, and says false for one it does not have", async () => {
        await store.putPreset("u_jesse", preset("a"), 20);
        expect(await store.deletePreset("u_jesse", "a")).toBe(true);
        expect(await store.getPreset("u_jesse", "a")).toBeUndefined();
        expect(await store.deletePreset("u_jesse", "a")).toBe(false);
      });
    });

    describe("suspensions (abuse protections spec \u{A7}1)", () => {
      it("suspends an account, says so for it alone, and lifts it once", async () => {
        expect(await store.isSuspended("u_peer")).toBe(false);
        await store.suspend("u_peer", { note: "spam in three rooms", by: "u_operator", at: 1_000 });
        expect(await store.isSuspended("u_peer")).toBe(true);
        expect(await store.isSuspended("u_pee")).toBe(false);
        expect(await store.unsuspend("u_peer")).toBe(true);
        expect(await store.unsuspend("u_peer")).toBe(false);
        expect(await store.isSuspended("u_peer")).toBe(false);
      });
    });

    describe("reports (abuse protections spec \u{A7}3)", () => {
      const filed = (over: Partial<NewReport> = {}): NewReport => ({
        sessionId: "qs_test", creatorId: "u_jesse",
        target: { kind: "member", memberId: "m_peer" },
        subject: { memberId: "m_peer", userId: "u_peer", label: "peer@codenerd" },
        reason: "harassment", note: "called names", reporterUserId: "u_reader", reporterLabel: "reader@x", ...over,
      });
      const file = async (over: Partial<NewReport> = {}) => (await store.fileReport(filed(over), Date.now())) as { outcome: string; report: Report };
      const sweepRegistry = async () => {
        await store.sweep(Date.now());
        await harness.advanceRegistry?.();
      };

      it("files a report, and lists the queue newest first", async () => {
        const first = await file();
        vi.advanceTimersByTime(1_000);
        const second = await file({ target: { kind: "room" }, subject: null });
        expect(first).toMatchObject({ outcome: "filed", report: { reason: "harassment", note: "called names", resolvedAt: null } });
        expect((await store.listReports(10)).map((r) => r.id)).toEqual([second.report.id, first.report.id]);
      });

      it("folds a second report of one target by one account into the open first", async () => {
        const first = await file();
        expect(await store.fileReport(filed({ reason: "spam", note: "again" }), Date.now())).toEqual({ outcome: "folded", report: first.report });
        expect(await store.listReports(10)).toHaveLength(1);
        expect((await file({ reporterUserId: "u_other" })).outcome, "another account").toBe("filed");
        expect((await file({ target: { kind: "message", cursor: 3 } })).outcome, "another target").toBe("filed");
      });

      /** Review Focus 5. */
      it("files anew once the first is resolved, rather than folding into a closed report", async () => {
        const first = await file();
        await store.resolveReport(first.report.id, { note: "warned", by: "u_operator" }, Date.now());
        expect((await file()).outcome).toBe("filed");
      });

      it("takes 10 reports from an account a day, counts no fold, and takes the next once a day has passed", async () => {
        for (let i = 0; i < 10; i++) expect((await file({ target: { kind: "message", cursor: i + 1 } })).outcome).toBe("filed");
        expect((await file({ target: { kind: "message", cursor: 1 } })).outcome, "a repeat still folds").toBe("folded");
        expect(await store.fileReport(filed({ target: { kind: "room" }, subject: null }), Date.now()))
          .toEqual({ outcome: "limited", retryAfterMs: 24 * 3_600_000 });
        vi.advanceTimersByTime(24 * 3_600_000);
        expect((await file({ target: { kind: "room" }, subject: null })).outcome).toBe("filed");
      });

      it("lists for a room's creator its reports about members and messages, and none about the room", async () => {
        await file();
        await file({ target: { kind: "message", cursor: 4 } });
        await file({ target: { kind: "room" }, subject: null });
        await file({ sessionId: "qs_elsewhere" });
        expect((await store.roomReports("u_jesse", "qs_test")).map((r) => r.target.kind).sort()).toEqual(["member", "message"]);
        expect(await store.roomReports("u_someone_else", "qs_test")).toEqual([]);
      });

      /**
       * Section 1C review, Critical 1. A creator who read a report about themself learned one had been filed, and in a small
       * room which of the others filed it. A report about the creator's own seats and messages reaches the operators alone.
       * It is told by the account, so every seat the creator holds and every message it sent is covered, a second handle
       * included.
       */
      it("leaves out of a creator's list every report about the creator's own seats and messages, and keeps it in the queue", async () => {
        const creator = { memberId: "m_creator", userId: "u_jesse", label: "jesse@codenerd" };
        const own = [
          (await file({ target: { kind: "member", memberId: "m_creator" }, subject: creator })).report,
          (await file({ target: { kind: "member", memberId: "m_creator_2" }, subject: { ...creator, memberId: "m_creator_2" } })).report,
          (await file({ target: { kind: "message", cursor: 5 }, subject: creator })).report,
        ];
        vi.advanceTimersByTime(1_000);
        const aboutPeer = (await file()).report;
        vi.advanceTimersByTime(1_000);
        const aboutPeersMessage = (await file({ target: { kind: "message", cursor: 6 } })).report;
        expect((await store.roomReports("u_jesse", "qs_test")).map((r) => r.id), "the creator reads the others' alone")
          .toEqual([aboutPeersMessage.id, aboutPeer.id]);
        expect((await store.listReports(10)).map((r) => r.id).sort(), "the operators read all five")
          .toEqual([...own, aboutPeer, aboutPeersMessage].map((r) => r.id).sort());
      });

      /**
       * The hosted seat is Bellman's account and not the creator's, and the creator is who sets its instructions, so a report
       * about what it said is the creator's to read. The rule above is the account's and covers it not at all.
       */
      it("lists for a creator a report about the hosted seat, which is not the creator's account", async () => {
        const host = { memberId: HOST_MEMBER_ID, userId: HOST_USER_ID, label: "host@bellman" };
        const seat = (await file({ target: { kind: "member", memberId: HOST_MEMBER_ID }, subject: host })).report;
        const said = (await file({ target: { kind: "message", cursor: 7 }, subject: host })).report;
        expect((await store.roomReports("u_jesse", "qs_test")).map((r) => r.id).sort()).toEqual([seat.id, said.id].sort());
      });

      it("resolves once with a note, keeps the first resolution, and answers nothing for an unknown id", async () => {
        const { report } = await file();
        const at = Date.now();
        const done = await store.resolveReport(report.id, { note: "warned", by: "u_operator" }, at);
        expect(done).toMatchObject({ id: report.id, resolvedAt: at, resolution: "warned", resolvedBy: "u_operator" });
        expect(await store.resolveReport(report.id, { note: "again", by: "u_x" }, at + 1_000)).toEqual(done);
        expect(await store.resolveReport("rpt_000000000000000_00000000", { note: "x", by: "u_x" }, at)).toBeUndefined();
      });

      /**
       * Section 1C review, Minor 3, re-graded Important: an open report an operator cannot find is a report never acted on.
       * Newest first alone cut the queue at its limit with the oldest open report past it, behind however many newer ones
       * had been resolved. Open reports come first, newest first, then resolved ones, newest first, `limit` in all.
       */
      it("lists the open reports first and the resolved after, newest first in each, so an old open one survives any number of newer resolved", async () => {
        const oldOpen = (await file({ reporterUserId: "u_a", target: { kind: "message", cursor: 1 } })).report;
        vi.advanceTimersByTime(1_000);
        const resolved: Report[] = [];
        for (let i = 0; i < 5; i++) {
          const r = (await file({ reporterUserId: `u_r${i}`, target: { kind: "message", cursor: 10 + i } })).report;
          await store.resolveReport(r.id, { note: "done", by: "u_operator" }, Date.now());
          resolved.push(r);
          vi.advanceTimersByTime(1_000);
        }
        const newOpen = (await file({ reporterUserId: "u_b", target: { kind: "message", cursor: 2 } })).report;
        const ids = async (limit: number) => (await store.listReports(limit)).map((r) => r.id);
        expect(await ids(10), "open first, then resolved, newest first in each")
          .toEqual([newOpen.id, oldOpen.id, ...resolved.map((r) => r.id).reverse()]);
        expect(await ids(3), "the old open report is inside a cut that five newer resolved ones would have filled")
          .toEqual([newOpen.id, oldOpen.id, resolved[4].id]);
        expect(await ids(2), "the open reports fill the cut before any resolved one").toEqual([newOpen.id, oldOpen.id]);
        expect(await ids(1), "and the newest open one comes first").toEqual([newOpen.id]);
        // Resolving the old one moves it among the resolved, by when it was filed: the oldest of them, last.
        await store.resolveReport(oldOpen.id, { note: "done", by: "u_operator" }, Date.now());
        expect(await ids(10)).toEqual([newOpen.id, ...resolved.map((r) => r.id).reverse(), oldOpen.id]);
      });

      it("deletes a report 180 days after it is resolved, from every list, and keeps an open one", async () => {
        const done = (await file()).report;
        const open = (await file({ target: { kind: "message", cursor: 2 } })).report;
        await store.resolveReport(done.id, { note: "warned", by: "u_operator" }, Date.now());
        vi.advanceTimersByTime(180 * 24 * 3_600_000 - 1);
        await sweepRegistry();
        expect((await store.listReports(10)).map((r) => r.id).sort(), "a millisecond before").toEqual([done.id, open.id].sort());
        vi.advanceTimersByTime(1);
        await sweepRegistry();
        expect((await store.listReports(10)).map((r) => r.id)).toEqual([open.id]);
        expect((await store.roomReports("u_jesse", "qs_test")).map((r) => r.id)).toEqual([open.id]);
      });

      // The cases below are not the plan's. Each closes a mutation the plan's cases left green, found in Task 9's controls.

      /** The count is per account. Filled by one, then asked by another: a count shared across accounts reads full to the second. */
      it("counts each account's filings apart: one at its limit leaves another's first admitted", async () => {
        for (let i = 0; i < 10; i++) await file({ target: { kind: "message", cursor: i + 1 } });
        expect((await file({ target: { kind: "message", cursor: 11 } })).outcome, "the account at its limit").toBe("limited");
        expect((await file({ reporterUserId: "u_other", target: { kind: "message", cursor: 11 } })).outcome, "another account's first").toBe("filed");
      });

      /** R9. The plan's case folds after the account is already full, which a fold that counted would not change. */
      it("keeps a fold out of the day's count: nine filed and five repeats leave a tenth admitted", async () => {
        for (let i = 0; i < 9; i++) await file({ target: { kind: "message", cursor: i + 1 } });
        for (let i = 0; i < 5; i++) expect((await file({ target: { kind: "message", cursor: 1 } })).outcome).toBe("folded");
        expect((await file({ target: { kind: "message", cursor: 10 } })).outcome, "the tenth new report").toBe("filed");
        expect((await file({ target: { kind: "message", cursor: 11 } })).outcome, "the eleventh").toBe("limited");
      });

      /** The retry_after a refusal gives must hold. A refusal that counted would push a client that waited it out into another. */
      it("counts no refusal, so a filing after the retry it was told is admitted", async () => {
        for (let i = 0; i < 10; i++) await file({ target: { kind: "message", cursor: i + 1 } });
        vi.advanceTimersByTime(12 * 3_600_000);
        for (let i = 0; i < 10; i++) {
          expect(await store.fileReport(filed({ target: { kind: "message", cursor: 100 + i } }), Date.now()))
            .toEqual({ outcome: "limited", retryAfterMs: 12 * 3_600_000 });
        }
        vi.advanceTimersByTime(12 * 3_600_000);
        expect((await file({ target: { kind: "message", cursor: 200 } })).outcome).toBe("filed");
      });

      /** A room's target is the string "room" in every room, so a fold that left the room out would fold across rooms. */
      it("keeps an account's open reports of two rooms apart", async () => {
        const room = { target: { kind: "room" }, subject: null } as const;
        expect((await file(room)).outcome).toBe("filed");
        expect((await file({ ...room, sessionId: "qs_elsewhere" })).outcome, "the same target in another room").toBe("filed");
        expect((await file(room)).outcome, "a repeat in the first room still folds").toBe("folded");
      });

      it("lists at most the limit, and gives a creator theirs, newest first", async () => {
        const ids: string[] = [];
        for (let i = 0; i < 3; i++) {
          ids.push((await file({ target: { kind: "message", cursor: i + 1 } })).report.id);
          vi.advanceTimersByTime(1_000);
        }
        expect((await store.listReports(2)).map((r) => r.id)).toEqual([ids[2], ids[1]]);
        expect((await store.roomReports("u_jesse", "qs_test")).map((r) => r.id)).toEqual([ids[2], ids[1], ids[0]]);
      });

      /** R15. Filed together and resolved ten days apart, so the date is told from the resolution and each report keeps its own. */
      it("deletes each report 180 days after its own resolution, not its filing and not another's", async () => {
        const day = 24 * 3_600_000;
        const first = (await file()).report;
        const second = (await file({ target: { kind: "message", cursor: 2 } })).report;
        await store.resolveReport(first.id, { note: "warned", by: "u_operator" }, Date.now());
        vi.advanceTimersByTime(10 * day);
        await store.resolveReport(second.id, { note: "warned", by: "u_operator" }, Date.now());
        vi.advanceTimersByTime(170 * day);
        await sweepRegistry();
        expect((await store.listReports(10)).map((r) => r.id), "the first is gone, the second has ten days left").toEqual([second.id]);
        vi.advanceTimersByTime(10 * day - 1);
        await sweepRegistry();
        expect((await store.listReports(10)).map((r) => r.id), "a millisecond before the second's day").toEqual([second.id]);
        vi.advanceTimersByTime(1);
        await sweepRegistry();
        expect(await store.listReports(10)).toEqual([]);
      });

      /**
       * R10's rows only serve the day's count. u_old filed long ago, u_edge a day before the purge to the millisecond, and
       * u_late twice, the first just over a day before it and the second an hour before: its row holds both times, so the
       * newest is the one that keeps it.
       */
      it("forgets a reporter's filing times at the purge once the newest is a day old, and keeps them while one is inside the day", async () => {
        const hour = 3_600_000;
        const day = 24 * hour;
        const old = (await file({ reporterUserId: "u_old" })).report;
        await store.resolveReport(old.id, { note: "warned", by: "u_operator" }, Date.now());
        const purgeAt = Date.now() + 180 * day;
        vi.advanceTimersByTime(179 * day - 10 * 60_000);
        await file({ reporterUserId: "u_late", target: { kind: "message", cursor: 3 } });
        vi.advanceTimersByTime(10 * 60_000);
        await file({ reporterUserId: "u_edge", target: { kind: "message", cursor: 2 } });
        vi.advanceTimersByTime(day - hour);
        await file({ reporterUserId: "u_late", target: { kind: "message", cursor: 4 } });
        expect((await harness.reporterRows()).sort(), "before the purge").toEqual(["u_edge", "u_late", "u_old"]);
        vi.advanceTimersByTime(hour);
        expect(Date.now()).toBe(purgeAt);
        await sweepRegistry();
        const left = (await store.listReports(10)).map((r) => r.id);
        expect(left, "the purge ran and deleted u_old's report").not.toContain(old.id);
        expect(left, "and left the three open ones").toHaveLength(3);
        expect((await harness.reporterRows()).sort(), "u_edge's time is a day old exactly, u_late's newest an hour").toEqual(["u_late"]);
      });
    });

    describe("handles and bylines", () => {
      it("claims a handle once, refuses it to a second user, and answers claimed on a repeat", async () => {
        expect(await store.claimHandle("u_a", "ada")).toBe("claimed");
        expect(await store.claimHandle("u_b", "ada")).toBe("taken");
        expect(await store.claimHandle("u_a", "ada")).toBe("claimed");
        expect(await store.handleOf("u_a")).toBe("ada");
        expect(await store.userOfHandle("ada")).toBe("u_a");
      });

      it("frees the old handle when one changes", async () => {
        await store.claimHandle("u_a", "ada");
        expect(await store.claimHandle("u_a", "lovelace")).toBe("claimed");
        expect(await store.userOfHandle("ada")).toBeUndefined();
        expect(await store.claimHandle("u_b", "ada")).toBe("claimed");
        expect(await store.handleOf("u_a")).toBe("lovelace");
      });

      it("signs and unsigns, lists newest first, and answers a byline only while handle and signature both hold", async () => {
        await store.claimHandle("u_a", "ada");
        expect(await store.signRoom("u_a", "qs_1", 1000)).toBe("ada");
        await store.signRoom("u_a", "qs_2", 2000);
        expect(await store.signedRooms("u_a")).toEqual([
          { sessionId: "qs_2", signedAt: 2000 },
          { sessionId: "qs_1", signedAt: 1000 },
        ]);
        expect(await store.bylineFor("u_a", "qs_1")).toBe("ada");
        await store.unsignRoom("u_a", "qs_1");
        expect(await store.bylineFor("u_a", "qs_1")).toBeUndefined();
        expect(await store.bylineFor("u_b", "qs_2")).toBeUndefined();
      });

      it("releases the handle and every signature at once, so a later handle revives none", async () => {
        await store.claimHandle("u_a", "ada");
        await store.signRoom("u_a", "qs_1", 1000);
        await store.releaseHandle("u_a");
        expect(await store.handleOf("u_a")).toBeUndefined();
        expect(await store.userOfHandle("ada")).toBeUndefined();
        expect(await store.signedRooms("u_a")).toEqual([]);
        await store.claimHandle("u_a", "ada2");
        expect(await store.bylineFor("u_a", "qs_1")).toBeUndefined();
      });

      // More keys than one storage delete takes (128), so the release must batch them.
      it("releases every signature of a handle, however many", async () => {
        await store.claimHandle("u_a", "ada");
        for (let i = 0; i < 130; i++) await store.signRoom("u_a", `qs_${i}`, i);
        await store.releaseHandle("u_a");
        expect(await store.signedRooms("u_a")).toEqual([]);
        expect(await store.handleOf("u_a")).toBeUndefined();
      });

      it("reads nothing for a user who never claimed one", async () => {
        expect(await store.handleOf("u_none")).toBeUndefined();
        expect(await store.signedRooms("u_none")).toEqual([]);
        await store.releaseHandle("u_none");
      });

      // The handle is read where the signature is written, so a release cannot land between the two and leave a
      // signature with no handle, which a handle claimed later would revive.
      it("signs nothing for a user who holds no handle, so a handle claimed later revives nothing", async () => {
        expect(await store.signRoom("u_none", "qs_1", 1000)).toBeUndefined();
        expect(await store.signedRooms("u_none")).toEqual([]);
        await store.claimHandle("u_none", "nora");
        expect(await store.bylineFor("u_none", "qs_1")).toBeUndefined();
      });

      // Operator-issued ids may hold a colon (`isIdentity` takes any non-empty string), so one person's id
      // can extend another's past the key's separator. Neither a read nor a release may reach the other's
      // signatures through it.
      it("lists no signature of an id that extends this one past a colon", async () => {
        await store.claimHandle("u_x:y", "yara");
        await store.signRoom("u_x:y", "qs_1", 1000);
        expect(await store.signedRooms("u_x")).toEqual([]);
        expect(await store.signedRooms("u_x:y")).toEqual([{ sessionId: "qs_1", signedAt: 1000 }]);
      });

      it("releases no signature of an id that extends this one past a colon", async () => {
        await store.claimHandle("u_x:y", "yara");
        await store.signRoom("u_x:y", "qs_1", 1000);
        await store.releaseHandle("u_x");
        expect(await store.bylineFor("u_x:y", "qs_1")).toBe("yara");
      });

      // The operator's release (ADR 0021): the handle names whose record goes.
      it("releases a handle by its name: answers its holder, and the handle and every signature go", async () => {
        await store.claimHandle("u_a", "ada");
        await store.signRoom("u_a", "qs_1", 1000);
        await store.signRoom("u_a", "qs_2", 2000);
        expect(await store.releaseHandleNamed("ada")).toBe("u_a");
        expect(await store.handleOf("u_a")).toBeUndefined();
        expect(await store.userOfHandle("ada")).toBeUndefined();
        expect(await store.signedRooms("u_a")).toEqual([]);
        await store.claimHandle("u_a", "ada2");
        expect(await store.bylineFor("u_a", "qs_1")).toBeUndefined();
        expect(await store.claimHandle("u_b", "ada")).toBe("claimed");
      });

      it("answers undefined for a handle nobody holds, and releases nothing", async () => {
        await store.claimHandle("u_a", "ada");
        await store.signRoom("u_a", "qs_1", 1000);
        expect(await store.releaseHandleNamed("bob")).toBeUndefined();
        expect(await store.handleOf("u_a")).toBe("ada");
        expect(await store.bylineFor("u_a", "qs_1")).toBe("ada");
      });

      it("releases by name no signature of an id that extends the holder's past a colon", async () => {
        await store.claimHandle("u_x", "xena");
        await store.signRoom("u_x", "qs_1", 1000);
        await store.claimHandle("u_x:y", "yara");
        await store.signRoom("u_x:y", "qs_1", 1000);
        expect(await store.releaseHandleNamed("xena")).toBe("u_x");
        expect(await store.signedRooms("u_x")).toEqual([]);
        expect(await store.bylineFor("u_x:y", "qs_1")).toBe("yara");
      });

      // The operator's list of holders, for the notice that goes out before members are named by handle (public rooms
      // on bellman.sh spec, D6). Claimed out of order, so the order it answers in is the list's and not the claims'.
      it("lists every account holding a handle, by user id, and none that released one", async () => {
        await store.claimHandle("u_b", "grace");
        await store.claimHandle("u_a", "ada");
        await store.claimHandle("u_c", "cleo");
        await store.releaseHandle("u_c");
        expect(await store.handleHolders()).toEqual([{ userId: "u_a", handle: "ada" }, { userId: "u_b", handle: "grace" }]);
      });

      it("lists nobody before a claim, a holder once under the handle it holds now, and none the operator released by name", async () => {
        expect(await store.handleHolders()).toEqual([]);
        await store.claimHandle("u_a", "ada");
        await store.claimHandle("u_a", "lovelace");
        await store.claimHandle("u_b", "grace");
        expect(await store.releaseHandleNamed("grace")).toBe("u_b");
        expect(await store.handleHolders()).toEqual([{ userId: "u_a", handle: "lovelace" }]);
      });

      // An operator-issued id may hold a colon. The id is all of the key past its prefix, so it is read whole, and the
      // id it extends is a holder of its own.
      it("lists an id that holds a colon whole, beside the id it extends", async () => {
        await store.claimHandle("u_x:y", "yara");
        await store.claimHandle("u_x", "xena");
        expect(await store.handleHolders()).toEqual([{ userId: "u_x", handle: "xena" }, { userId: "u_x:y", handle: "yara" }]);
      });
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

    // A falsy org is no org (ARCHITECTURE.md section 9, runtime fact 4): no stream named "" is written.
    it("writes no audit row for an entry whose org is empty", async () => {
      await store.appendAudit({ at: Date.now(), orgId: "", sessionId: "qs_1", actorUserId: "u_a", action: "session_created", detail: {} });
      expect(await store.auditForOrg("", 50)).toEqual([]);
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

    it("chains appended rows: hash over seq, prev_hash and the record, the first prev_hash empty", async () => {
      const row = (at: number): AuditEntry => ({ at, orgId: "org_a", sessionId: "qs_1", actorUserId: "u_a", action: "sent_message", detail: { at } });
      const stripSeq = ({ seq: _s, hash: _h, prevHash: _p, ...e }: SeqEntry): AuditEntry => e;
      await store.appendAudit(row(1));
      await store.appendAudit(row(2));
      const [a, b] = (await store.queryAudit("org_a", { limit: 10 })).entries.slice().reverse();
      expect(a.prevHash).toBe("");
      expect(a.hash).toBe(chainHash(a.seq, "", stripSeq(a)));
      expect(b.prevHash).toBe(a.hash);
      expect(b.hash).toBe(chainHash(b.seq, a.hash!, stripSeq(b)));
    });

    // ---------------------------------------------------------- verifying the chain (ADR 0035)
    const chainRow = (at: number): AuditEntry => ({ at, orgId: "org_a", sessionId: "qs_1", actorUserId: "u_a", action: "sent_message", detail: { at } });

    it("verifyAudit over an intact stream is ok and counts every hashed row", async () => {
      for (const at of [1, 2, 3]) await store.appendAudit(chainRow(at));
      expect(await store.verifyAudit("org_a")).toEqual({ ok: true, from_seq: 1, through_seq: 3, checked: 3, unhashed: 0, anchor: NO_ANCHOR });
    });

    it("verifyAudit resumes from a seq", async () => {
      for (const at of [1, 2, 3]) await store.appendAudit(chainRow(at));
      expect(await store.verifyAudit("org_a", 2)).toMatchObject({ ok: true, from_seq: 2, through_seq: 3, checked: 2 });
    });

    it("verifyAudit over an empty stream is ok with zero counts", async () => {
      expect(await store.verifyAudit("org_a")).toEqual({ ok: true, from_seq: 0, through_seq: 0, checked: 0, unhashed: 0, anchor: NO_ANCHOR });
    });

    // ---------------------------------------------------------- retention and the sweep (ADR 0035, D2)
    describe("retention", () => {
      const by = { actorUserId: "u_admin", actorOrgId: "org_a" };
      const day = (n: number) => Date.parse("2026-03-01T00:00:00Z") + n * 24 * 3_600_000;

      it("auditSettings defaults to no retention and no sink", async () => {
        expect(await store.auditSettings("org_a")).toEqual({ retentionDays: null, sink: null });
      });

      it("setAuditRetention stores the window and audits audit_retention_set by the caller", async () => {
        expect(await store.setAuditRetention("org_a", 90, by)).toEqual({ retentionDays: 90, sink: null });
        expect(await store.auditSettings("org_a")).toEqual({ retentionDays: 90, sink: null });
        expect((await store.auditForOrg("org_a", 1)).at(-1)).toMatchObject({ action: "audit_retention_set", detail: { days: 90 }, actorUserId: "u_admin" });
      });

      it("sweepAudit deletes rows older than the window in seq order, stops at the first young row, anchors the chain and appends audit_swept", async () => {
        for (const at of [day(1), day(2), day(40), day(3)]) await store.appendAudit(chainRow(at));
        const second = (await store.queryAudit("org_a", { limit: 10 })).entries.find((e) => e.seq === 2)!;
        await store.setAuditRetention("org_a", 30, by);
        expect(await store.sweepAudit("org_a", day(40) + 3_600_000)).toBe(2);
        const after = (await store.queryAudit("org_a", { limit: 10 })).entries;
        expect(after.map((e) => [e.seq, e.action, e.at])).toEqual([
          [6, "audit_swept", after[0]!.at], [5, "audit_retention_set", after[1]!.at], [4, "sent_message", day(3)], [3, "sent_message", day(40)],
        ]);
        expect(after[0]).toMatchObject({ actorUserId: "system", detail: { through_seq: 2, count: 2 } });
        expect(await store.verifyAudit("org_a")).toEqual({ ok: true, from_seq: 3, through_seq: 6, checked: 4, unhashed: 0, anchor: { seq: 2, hash: second.hash } });
      });

      it("sweepAudit with no window deletes nothing", async () => {
        await store.appendAudit(chainRow(day(1)));
        expect(await store.sweepAudit("org_a", day(400))).toBe(0);
        expect((await store.queryAudit("org_a", { limit: 10 })).total).toBe(1);
      });

      it("sweepAudit past the whole stream leaves an empty stream whose next row chains from the anchor", async () => {
        for (const at of [day(1), day(2)]) await store.appendAudit(chainRow(at));
        await store.setAuditRetention("org_a", 30, by);
        const third = (await store.queryAudit("org_a", { limit: 10 })).entries[0]!;
        expect(await store.sweepAudit("org_a", Date.now() + 40 * 24 * 3_600_000)).toBe(3);
        const [swept] = (await store.queryAudit("org_a", { limit: 10 })).entries;
        expect(swept).toMatchObject({ seq: 4, orgId: "org_a", action: "audit_swept", prevHash: third.hash, detail: { through_seq: 3, count: 3 } });
        expect(await store.verifyAudit("org_a")).toEqual({ ok: true, from_seq: 4, through_seq: 4, checked: 1, unhashed: 0, anchor: { seq: 3, hash: third.hash } });
      });
    });

    describe("the sink", () => {
      const by = { actorUserId: "u_admin", actorOrgId: "org_a" };
      const url = "https://collector.example/in";

      it("setAuditSink returns the secret once, status ok with pending = rows not yet delivered, and audits audit_sink_set", async () => {
        await store.appendAudit(chainRow(1));
        await store.appendAudit(chainRow(2));
        const set = await store.setAuditSink("org_a", url, by);
        expect(set.secret).toMatch(/^[A-Za-z0-9_-]{32,}$/);
        expect(set.sink).toMatchObject({ url, status: "ok", delivered_through: 0, pending: 3, attempts: 0, failing_since: null, last_error: null });
        expect((await store.auditSettings("org_a")).sink).toEqual(set.sink);
        expect((await store.auditForOrg("org_a", 1)).at(-1)).toMatchObject({ action: "audit_sink_set", detail: { url }, actorUserId: "u_admin" });
      });

      it("setAuditSink again issues a new secret and keeps delivered_through", async () => {
        const first = await store.setAuditSink("org_a", url, by);
        const second = await store.setAuditSink("org_a", "https://other.example/in", by);
        expect(second.secret).not.toBe(first.secret);
        expect(second.sink).toMatchObject({ url: "https://other.example/in", delivered_through: first.sink.delivered_through, status: "ok" });
      });

      it("setAuditSink stores the url as given", async () => {
        const odd = "https://collector.example/in?k=v#frag";
        expect((await store.setAuditSink("org_a", odd, by)).sink.url).toBe(odd);
        expect((await store.auditSettings("org_a")).sink?.url).toBe(odd);
      });

      it("removeAuditSink is false when none, true once, and audits audit_sink_removed", async () => {
        expect(await store.removeAuditSink("org_a", by)).toBe(false);
        await store.setAuditSink("org_a", url, by);
        expect(await store.removeAuditSink("org_a", by)).toBe(true);
        expect(await store.removeAuditSink("org_a", by)).toBe(false);
        expect((await store.auditSettings("org_a")).sink).toBeNull();
        expect((await store.auditForOrg("org_a", 1)).at(-1)).toMatchObject({ action: "audit_sink_removed", detail: { url }, actorUserId: "u_admin" });
      });

      it("resumeAuditSink is undefined when none and clears nothing on a healthy sink", async () => {
        expect(await store.resumeAuditSink("org_a", by)).toBeUndefined();
        const { sink } = await store.setAuditSink("org_a", url, by);
        const resumed = await store.resumeAuditSink("org_a", by);
        expect(resumed).toMatchObject({ url, status: "ok", attempts: 0, delivered_through: sink.delivered_through });
        expect((await store.auditForOrg("org_a", 1)).at(-1)).toMatchObject({ action: "audit_sink_resumed", detail: { url, delivered_through: 0 } });
      });

      it("pumpAuditSink is undefined when there is no sink", async () => {
        expect(await store.pumpAuditSink("org_a", Date.now())).toBeUndefined();
      });
    });

    // ------------------------------------------------------------- the audit query (audit trail spec, D6)
    describe("the audit query", () => {
      const day = (d: string) => Date.parse(`2026-03-${d}T00:00:00Z`);
      const row = (over: Partial<AuditEntry> = {}): AuditEntry => ({
        at: Date.now(), orgId: "org_a", sessionId: "qs_q3", actorUserId: "u_ana", action: "sent_message", detail: {},
        actorLabel: "Ana", actorOrgId: "org_a", roomName: "q3-plan", parties: ["org_a"], crossing: "internal", direction: null,
        ...over,
      });
      const legacy = (over: Partial<AuditEntry> = {}): AuditEntry => ({
        at: Date.now(), orgId: "org_a", sessionId: "qs_old", actorUserId: "u_old", action: "member_left", detail: {}, ...over,
      });
      const boInbound = { actorUserId: "u_bo", actorLabel: "Bo", actorOrgId: "org_b", parties: ["org_a", "org_b"], crossing: "cross_org", direction: "inbound" } satisfies Partial<AuditEntry>;
      /** Six rows in org A's stream, seq 1 to 6, and one in org B's that no read of A's may see. */
      const fill = async () => {
        await store.appendAudit(legacy({ at: day("10") }));                                              // 1
        await store.appendAudit(row({ at: day("11") }));                                                 // 2
        await store.appendAudit(row({ at: day("12"), ...boInbound }));                                   // 3
        await store.appendAudit(row({ at: day("13"), sessionId: "qs_other", roomName: "other",
          parties: ["org_a", "org_c", null], crossing: "cross_org", direction: "outbound" }));           // 4
        await store.appendAudit(row({ at: day("14"), action: "invite_issued" }));                        // 5
        await store.appendAudit(row({ at: day("15"), sessionId: "grant:github:1", roomName: null,
          action: "plan_granted", actorUserId: "stripe", actorLabel: null, actorOrgId: null }));         // 6
        await store.appendAudit(row({ orgId: "org_b", parties: ["org_a", "org_b"], crossing: "cross_org", direction: "outbound" }));
      };
      const q = (over: Partial<AuditQuery> = {}): AuditQuery => ({ limit: 100, ...over });
      const seqs = (page: AuditPage) => page.entries.map((e) => e.seq);
      const read = async (over: Partial<AuditQuery>) => seqs(await store.queryAudit("org_a", q(over)));

      it("reads one org's stream newest first, covering it up to its newest row", async () => {
        await fill();
        const page = await store.queryAudit("org_a", q());
        expect(seqs(page)).toEqual([6, 5, 4, 3, 2, 1]);
        expect(page).toMatchObject({ next: null, through: 6, total: 6, unrecorded: 0 });
      });

      it("answers an empty stream with nothing, and no seq to pin", async () => {
        expect(await store.queryAudit("org_none", q())).toEqual({ entries: [], next: null, through: null, total: 0, unrecorded: 0 });
      });

      it("filters by each field, and combines filters with AND", async () => {
        await fill();
        expect(await read({ from: day("12"), to: day("14") })).toEqual([4, 3]);
        expect(await read({ actor: "u_bo" })).toEqual([3]);
        expect(await read({ room: "qs_other" })).toEqual([4]);
        expect(await read({ action: "invite_issued" })).toEqual([5]);
        expect(await read({ org: "org_c" })).toEqual([4]);
        expect(await read({ scope: "cross_org" })).toEqual([4, 3]);
        expect(await read({ scope: "internal" })).toEqual([6, 5, 2]);
        expect(await read({ scope: "cross_org", room: "qs_q3" })).toEqual([3]);
        expect(await read({ scope: "internal", from: day("14") })).toEqual([6, 5]);
      });

      it("counts the rows a scope filter left out because they record no crossing", async () => {
        await fill();
        expect((await store.queryAudit("org_a", q({ scope: "cross_org" }))).unrecorded).toBe(1);
        expect((await store.queryAudit("org_a", q({ scope: "cross_org", from: day("11") }))).unrecorded).toBe(0);
        expect((await store.queryAudit("org_a", q())).unrecorded).toBe(0);
      });

      // A row from before D2 names no parties either, so an org filter cannot judge it any more than a scope can.
      it("counts the rows an org filter left out because they record no crossing", async () => {
        await fill();
        expect((await store.queryAudit("org_a", q({ org: "org_c" }))).unrecorded).toBe(1);
      });

      it("pages with before and through: no row twice, none skipped, and none written after through", async () => {
        await fill();
        const first = await store.queryAudit("org_a", q({ limit: 4 }));
        expect(seqs(first)).toEqual([6, 5, 4, 3]);
        expect(first).toMatchObject({ next: 3, through: 6, total: 6 });
        await store.appendAudit(row()); // 7, written after the first page
        const second = await store.queryAudit("org_a", q({ limit: 4, before: first.next!, through: first.through! }));
        expect(seqs(second)).toEqual([2, 1]);
        expect(second).toMatchObject({ next: null, through: 6, total: 6 });
        expect(await read({ through: 6 })).not.toContain(7);
      });

      it("hands back a recorded row with its fields, and a row from before them without", async () => {
        await fill();
        const entries = (await store.queryAudit("org_a", q())).entries;
        const hex64 = expect.stringMatching(/^[0-9a-f]{64}$/);
        expect(entries[3]).toEqual({ seq: 3, hash: hex64, prevHash: hex64, ...row({ at: day("12"), ...boInbound }) });
        expect(entries[5]).toEqual({ seq: 1, hash: hex64, prevHash: "", ...legacy({ at: day("10") }) });
      });

      it("offers the stream's actors, rooms, other orgs and actions, newest first", async () => {
        await fill();
        expect(await store.auditFacets("org_a")).toEqual({
          actors: [{ id: "stripe", label: null }, { id: "u_ana", label: "Ana" }, { id: "u_bo", label: "Bo" }, { id: "u_old", label: null }],
          rooms: [{ id: "qs_q3", name: "q3-plan" }, { id: "qs_other", name: "other" }, { id: "qs_old", name: null }],
          orgs: ["org_c", "org_b"],
          actions: ["plan_granted", "invite_issued", "sent_message", "member_left"],
        } satisfies AuditFacets);
      });

      // Review Focus 1: a value is bound, never spliced, so SQL in it is only text.
      it("matches a filter value literally, whatever SQL it spells", async () => {
        await fill();
        for (const actor of ["' OR 1=1 --", "%", "_", "u_%"]) expect(await read({ actor }), actor).toEqual([]);
      });

      // Review Focus 2.
      it("answers a range that holds nothing, or ends before it starts, with an empty page", async () => {
        await fill();
        expect(await store.queryAudit("org_a", q({ from: day("14"), to: day("12") })))
          .toEqual({ entries: [], next: null, through: 6, total: 0, unrecorded: 0 });
      });

      // Review Focus 3: the outbox can land a row after newer ones.
      it("filters by when a row happened and pages by when it landed, when the two disagree", async () => {
        await fill();
        await store.appendAudit(row({ at: Date.parse("2026-03-11T12:00:00Z"), action: "late" })); // 7
        const range = { from: day("11"), to: day("12") };
        expect(await read(range)).toEqual([7, 2]);
        const first = await store.queryAudit("org_a", q({ ...range, limit: 1 }));
        expect(seqs(first)).toEqual([7]);
        expect(await read({ ...range, limit: 1, before: first.next!, through: first.through! })).toEqual([2]);
      });
    });

    // ------------------------------------------------------- abandonment (#18)
    /** Last heard from a millisecond past the window: nobody has been in for 90 days. */
    const AGED = () => Date.now() - ABANDONED_AFTER_MS - 1;
    const abandonedRoom = (over: Partial<Session> = {}) =>
      session({ members: [member({ lastSeenAt: AGED() })], ...over });

    it("sweep closes a room nobody has been in for 90 days, retires its codes and says since when", async () => {
      const s = abandonedRoom();
      (await store.createSession(s));

      (await store.sweep(Date.now()));

      const fresh = (await store.getSession(s.id))!;
      expect(fresh.closed).toBe(true);
      expect(fresh.joinCodes).toEqual({});
      // Read after getSession, not before it: DurableObjectStore.sweep is a
      // no-op, so there it is the read above that closes the room and writes
      // this event. getSession no longer carries history (#25).
      const last = (await store.eventsAfter(s.id, 0)).at(-1)!;
      expect(last.type).toBe("session_expired");
      // The fact the decision was made on, so a client can say "closed, nobody
      // since <date>" rather than "closed".
      expect(last.payload).toEqual({ reason: "abandoned", last_seen_at: new Date(AGED()).toISOString() });
      expect((await store.getSessionByJoinCode("BELL-TEST-01"))).toBeUndefined();
    });

    it("sweep is idempotent — one closing event, not one per sweep", async () => {
      const s = abandonedRoom();
      (await store.createSession(s));

      (await store.sweep(Date.now()));
      (await store.sweep(Date.now()));
      (await store.sweep(Date.now()));

      // The read comes first and is not incidental: DurableObjectStore.sweep is a
      // no-op, so there this read is what closes the room, and the events below
      // would be empty without it.
      await store.getSession(s.id);
      const expired = (await store.eventsAfter(s.id, 0)).filter((e) => e.type === "session_expired");
      expect(expired).toHaveLength(1);
    });

    it("closes an abandoned room lazily on read, without waiting for a sweep", async () => {
      const s = abandonedRoom();
      (await store.createSession(s));
      expect((await store.getSession(s.id))?.closed).toBe(true);
    });

    // The third close path, beside closeSession and closeSessionIfEmpty (#65).
    it("stamps closedAt when abandonment closes the room, and a later read keeps it", async () => {
      const s = abandonedRoom();
      (await store.createSession(s));
      const closedAt = Date.now();
      expect((await store.getSession(s.id))!.closedAt).toBe(closedAt);
      vi.advanceTimersByTime(60_000);
      expect((await store.getSession(s.id))!.closedAt).toBe(closedAt);
    });

    it("keeps a room open while one active member was seen inside the window", async () => {
      const s = session({ members: [
        member({ lastSeenAt: AGED() }),
        member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b", lastSeenAt: Date.now() - 1_000 }),
      ] });
      (await store.createSession(s));
      (await store.sweep(Date.now()));
      expect((await store.getSession(s.id))?.closed).toBe(false);
    });

    it("keeps a room open at exactly 90 days, and closes it a millisecond later", async () => {
      const s = session({ members: [member({ lastSeenAt: Date.now() - ABANDONED_AFTER_MS })] });
      (await store.createSession(s));
      expect((await store.getSession(s.id))?.closed, "at the boundary").toBe(false);

      vi.advanceTimersByTime(1);
      expect((await store.getSession(s.id))?.closed).toBe(true);
    });

    it("never sweeps a frozen room, however long it has been frozen", async () => {
      const s = abandonedRoom({ frozenAt: Date.now() - ABANDONED_AFTER_MS });
      (await store.createSession(s));
      (await store.sweep(Date.now()));
      const fresh = (await store.getSession(s.id))!;
      expect(fresh.closed).toBe(false);
      expect(fresh.frozenAt).not.toBeNull();
      expect(await store.eventsAfter(s.id, 0)).toEqual([]);
    });

    it("a thaw stamps every active member as seen now, so the room gets a full window back", async () => {
      // Frozen past the window, with one member who left before the freeze: the
      // thaw credits the active member and leaves the departed one alone.
      const s = session({
        frozenAt: Date.now() - 1_000,
        members: [
          member({ lastSeenAt: AGED() }),
          member({ memberId: "m_gone", userId: "u_gone", roomRole: "peer_b", lastSeenAt: AGED(), leftAt: AGED() }),
        ],
      });
      (await store.createSession(s));

      (await store.freezeSession(s.id, null));

      const fresh = (await store.getSession(s.id))!;
      expect(fresh.closed).toBe(false);
      expect(fresh.members.map((m) => [m.memberId, m.lastSeenAt])).toEqual([["m_creator", Date.now()]]);
      expect((await store.getMember(s.id, "m_gone"))?.lastSeenAt).toBe(AGED());
      // And the sweep agrees: the window restarted at the thaw.
      (await store.sweep(Date.now()));
      expect((await store.getSession(s.id))?.closed).toBe(false);
    });

    it("a thaw of a room that was not frozen stamps nobody", async () => {
      // The credit is paid on the transition, as clearSilence's is: a retried
      // freezeSession(null) must not keep a quiet room alive for good.
      const s = abandonedRoom();
      (await store.createSession(s));

      (await store.freezeSession(s.id, null));

      expect((await store.getSession(s.id))?.closed, "the sweep still sees it as abandoned").toBe(true);
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

    // ----------------------------------------------------------- the purge (#65)
    /**
     * `sweep`, then the harness's hook for the room. MemoryStore's sweep reaches every room and the hook
     * is nothing; the Durable Object store's is a no-op, because a room is purged by that room's own
     * alarm, and its caller runs the alarm here. Either way, when this returns the purge a case is
     * waiting for has had its chance, and a case reads the result.
     */
    const sweepRoom = async (id: string) => {
      await store.sweep(Date.now());
      await harness.advance?.(id);
    };
    const putBlob = (roomId: string, id: string, bytes: number) =>
      blobs.put(roomId, id, new Uint8Array(bytes).buffer as ArrayBuffer, {
        bytes, type: "text/plain", name: `${id}.txt`, by: "m_creator", at: Date.now(),
      });
    /**
     * The `appendEvent` a surface write makes for a `file` item naming `blobId` (#183): the event, and the
     * row the store is asked to commit with it. A `surface` event without the row names nothing. An object
     * a case wants to survive the close-time sweep is one an item names.
     */
    const nameBlob = (roomId: string, blobId: string, bytes: number) => {
      const item: SurfaceItem = {
        key: `file_${blobId}`, kind: "file", title: null, body: null, ends: null, placement: null,
        blob: { id: blobId, bytes, type: "text/plain", name: `${blobId}.txt` }, shape: null,
      };
      return store.appendEvent(
        roomId,
        { type: "surface", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: item, refId: null },
        { surface: { key: item.key, item } },
      );
    };
    const blobIds = async (roomId: string) => (await blobs.list(roomId)).map((o) => o.id).sort();
    const bytesUsed = async (roomId: string) => blobBytesUsed((await store.getSession(roomId))!);
    const peer =(over: Partial<Session["members"][number]> = {}) =>
      member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b", orgId: "org_other", ...over });

    describe("the purge (#65)", () => {
      it("purges a closed room at its window: record, listings and objects gone", async () => {
        const s = session({ id: "qs_purge", retainAfterCloseMs: 60_000 });
        await store.createSession(s);
        await putBlob(s.id, "b_one", 3);
        await nameBlob(s.id, "b_one", 3); // named, so the close-time sweep leaves it for the purge to find
        await store.closeSession(s.id);
        await sweepRoom(s.id);
        expect(await store.getSession(s.id), "inside the window").toBeDefined();
        expect(await blobs.list(s.id), "and its bytes with it").toHaveLength(1);

        vi.advanceTimersByTime(60_001);
        await sweepRoom(s.id);
        expect(await store.getSession(s.id)).toBeUndefined();
        expect(await store.sessionsCreatedBy("u_jesse", 10)).not.toContain(s.id);
        expect(await store.sessionsJoinedBy("u_jesse", 10)).not.toContain(s.id);
        expect(await blobs.list(s.id)).toEqual([]);
        const audit = await store.auditForOrg("org_codenerd", 50);
        expect(audit.at(-1)).toMatchObject({ sessionId: s.id, action: "room_purged" });
        expect(await store.schedulePurge(s.id, Date.now(), jesseActor), "a purged room is a room that never was")
          .toEqual({ ok: false, reason: "missing" });
      });

      it("purges at the window's end exactly, and not a millisecond before", async () => {
        const s = session({ id: "qs_edge", retainAfterCloseMs: 60_000 });
        await store.createSession(s);
        await store.closeSession(s.id);

        vi.advanceTimersByTime(59_999);
        await sweepRoom(s.id);
        expect(await store.getSession(s.id), "a millisecond before the end").toBeDefined();

        vi.advanceTimersByTime(1);
        await sweepRoom(s.id);
        expect(await store.getSession(s.id), "at the end").toBeUndefined();
      });

      it("keeps a closed room with no window, and a legacy row, until a delete asks", async () => {
        const kept = session({ id: "qs_kept", retainAfterCloseMs: null, joinCodes: {} });
        // Closed before the window existed: the record names a window and no date for the close to start it from.
        const legacy = session({ id: "qs_legacy", closed: true, closedAt: null, retainAfterCloseMs: 60_000, joinCodes: {} });
        for (const s of [kept, legacy]) await store.createSession(s);
        await store.closeSession(kept.id);

        vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000);
        for (const s of [kept, legacy]) await sweepRoom(s.id);
        for (const s of [kept, legacy]) expect(await store.getSession(s.id), s.id).toBeDefined();

        const asked = Date.now();
        for (const s of [kept, legacy]) {
          expect(await store.schedulePurge(s.id, asked, jesseActor), s.id).toEqual({ ok: true, purgeAt: asked });
        }
        for (const s of [kept, legacy]) await sweepRoom(s.id);
        for (const s of [kept, legacy]) expect(await store.getSession(s.id), s.id).toBeUndefined();
      });

      it("refuses to schedule a purge of an open room, and says so for a missing one", async () => {
        const open = session({ id: "qs_open" });
        await store.createSession(open);
        expect(await store.schedulePurge(open.id, Date.now(), jesseActor)).toEqual({ ok: false, reason: "open" });
        expect(await store.schedulePurge("qs_nope", Date.now(), jesseActor)).toEqual({ ok: false, reason: "missing" });
        // The refusal wrote nothing: the room is still open, and a sweep leaves it alone.
        await sweepRoom(open.id);
        expect((await store.getSession(open.id))?.closed).toBe(false);
        expect((await store.auditForOrg("org_codenerd", 50)).filter((a) => a.sessionId === open.id)).toEqual([]);
      });

      it("files one room_purged for each org on the roster, and none for a member with no org", async () => {
        const s = session({
          id: "qs_orgs", retainAfterCloseMs: 60_000, joinCodes: {},
          members: [member(), peer(), peer({ memberId: "m_solo", userId: "u_solo", orgId: null })],
        });
        await store.createSession(s);
        await store.closeSession(s.id);

        vi.advanceTimersByTime(60_001);
        await sweepRoom(s.id);
        await sweepRoom(s.id); // a second pass over a purged room files nothing more

        for (const org of ["org_codenerd", "org_other"]) {
          const filed = (await store.auditForOrg(org, 50)).filter((a) => a.sessionId === s.id);
          expect(filed, org).toEqual([{
            at: expect.any(Number), orgId: org, sessionId: s.id, actorUserId: "system",
            action: "room_purged", detail: { session_id: s.id, room: s.manifest.room },
            actorLabel: null, actorOrgId: null, roomName: s.manifest.room,
            parties: ["org_codenerd", "org_other", null], crossing: "cross_org", direction: null,
          }]);
        }
      });

      it("files one room_deleted for each org however many times a delete is asked", async () => {
        const s = session({ id: "qs_twice", joinCodes: {}, members: [member(), peer()] });
        await store.createSession(s);
        await store.closeSession(s.id);

        // A minute out, so the room is still there for the second ask: this is about the record of asking.
        expect(await store.schedulePurge(s.id, Date.now() + 60_000, jesseActor)).toMatchObject({ ok: true });
        expect(await store.schedulePurge(s.id, Date.now() + 60_000, peerActor)).toMatchObject({ ok: true });

        for (const org of ["org_codenerd", "org_other"]) {
          const asked = (await store.auditForOrg(org, 50)).filter((a) => a.sessionId === s.id);
          expect(asked, org).toEqual([expect.objectContaining({
            action: "room_deleted", actorUserId: "u_jesse", actorLabel: "jesse@codenerd", actorOrgId: "org_codenerd",
            parties: ["org_codenerd", "org_other"], crossing: "cross_org",
            direction: org === "org_codenerd" ? "outbound" : "inbound",
          })]);
        }
      });

      // The record holds only the members in the room (ADR 0019), and a delete's and a purge's parties are the
      // roster all the same: a member who left sat in the room, with an org or with none (audit trail spec, D2).
      it("names the members who left among a delete's and a purge's parties", async () => {
        const s = session({
          id: "qs_left", joinCodes: {},
          members: [member(), peer(), peer({ memberId: "m_solo", userId: "u_solo", orgId: null })],
        });
        await store.createSession(s);
        await store.updateMember(s.id, "m_peer", { leftAt: Date.now() });
        await store.updateMember(s.id, "m_solo", { leftAt: Date.now() });
        await store.closeSession(s.id);
        expect(await store.schedulePurge(s.id, Date.now(), jesseActor)).toMatchObject({ ok: true });
        await sweepRoom(s.id);

        expect(await store.getSession(s.id)).toBeUndefined();
        for (const org of ["org_codenerd", "org_other"]) {
          const filed = (await store.auditForOrg(org, 50)).filter((a) => a.sessionId === s.id);
          expect(filed.map((a) => [a.action, a.parties]), org).toEqual([
            ["room_deleted", ["org_codenerd", "org_other", null]],
            ["room_purged", ["org_codenerd", "org_other", null]],
          ]);
        }
      });

      // M2. The first request stands, and the answer says so: a client that asks again is told when the room goes,
      // which is the time the record holds, and not the time of the repeat.
      it("answers a repeated delete with the time the first one asked for", async () => {
        const s = session({ id: "qs_first_time", joinCodes: {} });
        await store.createSession(s);
        await store.closeSession(s.id);
        const first = Date.now() + 60_000;
        const second = Date.now() + 120_000;

        expect(await store.schedulePurge(s.id, first, jesseActor)).toEqual({ ok: true, purgeAt: first });
        expect(await store.schedulePurge(s.id, second, jesseActor), "the repeat is told the first's time").toEqual({ ok: true, purgeAt: first });
        expect((await store.getSession(s.id))!.purgeAt, "and the record holds it").toBe(first);
      });

      it("leaves nothing of a purged room for a reader to be handed", async () => {
        const s = session({ id: "qs_nothing", retainAfterCloseMs: 60_000, blobBytesCeiling: 100, joinCodes: {} });
        await store.createSession(s);
        const item: SurfaceItem = { key: "plan", kind: "text", title: "Plan", body: "1. read", ends: null, placement: null, blob: null, shape: null };
        const body = { fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", refId: null };
        await store.appendEvent(s.id, { ...body, type: "message", payload: { text: "kept for a week" } });
        await store.appendEvent(s.id, { ...body, type: "surface", payload: item }, { surface: { key: "plan", item } });
        await store.chargeBlobBytes(s.id, 5);
        await store.closeSession(s.id);
        expect(await store.eventsAfter(s.id, 0), "before the purge").not.toEqual([]);
        expect(await store.surfaceOf(s.id), "before the purge").toHaveLength(1);

        vi.advanceTimersByTime(60_001);
        await sweepRoom(s.id);

        expect(await store.eventsAfter(s.id, 0)).toEqual([]);
        expect(await store.recentEvents(s.id, 10)).toEqual([]);
        expect(await store.surfaceOf(s.id)).toEqual([]);
        expect(await store.chargeBlobBytes(s.id, 1)).toEqual({ ok: false, reason: "not_found", used: 0 });
        await expect(store.appendEvent(s.id, { ...body, type: "message", payload: { text: "late" } }))
          .rejects.toThrow(/Unknown session/);
      });
    });

    // ------------------------------------------------- the sweep at close (#65)
    describe("the sweep at close (#65, D3)", () => {
      it("removes the objects no item names, credits their bytes, and leaves named ones", async () => {
        const s = session({ id: "qs_sweep", blobBytesCeiling: 1_000, joinCodes: {} });
        await store.createSession(s);
        await putBlob(s.id, "b_named", 10);
        await putBlob(s.id, "b_orphan", 30);
        await putBlob(s.id, "b_other", 5);
        await store.chargeBlobBytes(s.id, 45);
        await nameBlob(s.id, "b_named", 10);
        await store.closeSession(s.id);
        await sweepRoom(s.id);

        expect(await blobIds(s.id)).toEqual(["b_named"]);
        expect(await bytesUsed(s.id)).toBe(10);
        expect((await store.getSession(s.id))!.blobsSwept).toBe(true);
      });

      // Review Focus 4: the item keeps its reference, and a download of it answers 404 as it does today.
      it("credits nothing for a named object that is already gone, and does not throw", async () => {
        const s = session({ id: "qs_gone", blobBytesCeiling: 1_000, joinCodes: {} });
        await store.createSession(s);
        await store.chargeBlobBytes(s.id, 7);
        await nameBlob(s.id, "b_gone", 7); // the item names it; no object was ever put
        await store.closeSession(s.id);

        await expect(sweepRoom(s.id)).resolves.toBeUndefined();

        expect(await bytesUsed(s.id)).toBe(7);
        expect((await store.getSession(s.id))!.blobsSwept).toBe(true);
        expect((await store.surfaceOf(s.id)).map((row) => row.blob?.id)).toEqual(["b_gone"]);
      });

      it("sweeps a room once: an object that turns up afterwards is left for the purge", async () => {
        const s = session({ id: "qs_once", joinCodes: {} });
        await store.createSession(s);
        await store.closeSession(s.id);
        await sweepRoom(s.id);
        expect((await store.getSession(s.id))!.blobsSwept).toBe(true);

        await putBlob(s.id, "b_late", 4);
        await sweepRoom(s.id);

        expect(await blobIds(s.id), "no second pass").toEqual(["b_late"]);
      });

      // An open room's unnamed object is an upload between its put and its charge or its item.
      it("does not touch an open room, and a sweep asked for one removes nothing", async () => {
        const s = session({ id: "qs_open_sweep", joinCodes: {} });
        await store.createSession(s);
        await putBlob(s.id, "b_inflight", 9);

        await sweepRoom(s.id);
        expect(await store.sweepBlobs(s.id)).toEqual({ removed: 0, credited: 0 });
        expect(await store.sweepBlobs("qs_nobody")).toEqual({ removed: 0, credited: 0 });

        expect(await blobIds(s.id)).toEqual(["b_inflight"]);
        expect((await store.getSession(s.id))!.blobsSwept).toBe(false);
      });

      // No close time, nothing to date the sweep from; the purge, or a delete, is what reaches it.
      it("leaves a room closed before the close was dated alone", async () => {
        const legacy = session({ id: "qs_legacy_sweep", closed: true, closedAt: null, retainAfterCloseMs: null, joinCodes: {} });
        await store.createSession(legacy);
        await putBlob(legacy.id, "b_old", 3);

        await sweepRoom(legacy.id);

        expect(await blobIds(legacy.id)).toEqual(["b_old"]);
        expect((await store.getSession(legacy.id))!.blobsSwept).toBe(false);
      });
    });

    // ------------------------------------------------------ the org index (#65)
    /**
     * Which rooms an org sat in (D5), for the admin's list: written when a room is created for the org of
     * everyone it starts with, and when a member joins for that member's org. It keeps a closed room, which
     * is what an admin lists it for, and a purge is what removes one.
     */
    describe("the org index (#65, D5)", () => {
      it("lists a room for the org of its creator, and for the org of each member who joins", async () => {
        const s = session({ id: "qs_org_join", joinCodes: {} });
        await store.createSession(s);
        expect(await store.sessionsForOrg("org_codenerd", 10)).toContain(s.id);
        expect(await store.sessionsForOrg("org_other", 10)).not.toContain(s.id);

        expect(await store.addMember(s.id, peer({ memberId: "m_o1", userId: "u_o1" }))).toBe(true);

        expect(await store.sessionsForOrg("org_other", 10)).toContain(s.id);
        expect(await store.sessionsForOrg("org_codenerd", 10)).toContain(s.id);
      });

      it("lists a room for the org of a member seated into it", async () => {
        const s = swarmSession({ id: "qs_org_seat", joinCodes: {} });
        await store.createSession(s);

        const out = await store.seatMember(s.id, peer({ memberId: "m_seated", userId: "u_seated" }), Date.now() - 600_000, Date.now());

        expect(out.refused).toBeNull();
        expect(await store.sessionsForOrg("org_other", 10)).toContain(s.id);
      });

      it("lists a room for the orgs of the members it is created with", async () => {
        const s = session({ id: "qs_org_both", joinCodes: {}, members: [member(), peer()] });
        await store.createSession(s);
        expect(await store.sessionsForOrg("org_codenerd", 10)).toContain(s.id);
        expect(await store.sessionsForOrg("org_other", 10)).toContain(s.id);
      });

      it("adds a room to no org's list for a member who has none or a blank one, and does not fail", async () => {
        const s = session({ id: "qs_org_none", joinCodes: {} });
        await store.createSession(s);
        expect(await store.addMember(s.id, peer({ memberId: "m_solo", userId: "u_solo", orgId: null }))).toBe(true);
        expect(await store.addMember(s.id, peer({ memberId: "m_blank", userId: "u_blank", orgId: "" }))).toBe(true);
        expect(await store.sessionsForOrg("org_other", 10)).not.toContain(s.id);
        expect(await store.sessionsForOrg("", 10), "a blank org is no org").toEqual([]);
      });

      // The prefix is `uo:<org>:` and ends at the separator: without it org_a would list org_ab's rooms.
      it("keeps one org's rooms out of another's, including an org whose id begins with the other's", async () => {
        const made = (id: string, org: string) =>
          store.createSession(session({ id, orgId: org, joinCodes: {}, members: [member({ orgId: org })] }));
        await made("qs_in_org_a", "org_a");
        await made("qs_in_org_ab", "org_ab");

        expect(await store.sessionsForOrg("org_a", 10)).toEqual(["qs_in_org_a"]);
        expect(await store.sessionsForOrg("org_ab", 10)).toEqual(["qs_in_org_ab"]);
        expect(await store.sessionsForOrg("org_nobody", 10)).toEqual([]);
      });

      // An identity's org can come from a key map nobody validated, so an id may spell the key's own separator:
      // `uo:org:x:<room>` would otherwise be a row of org "org" with a room named "x:<room>".
      it("keeps an org whose id spells the separator apart from the org it begins with", async () => {
        const made = (id: string, org: string) =>
          store.createSession(session({ id, orgId: org, joinCodes: {}, members: [member({ orgId: org })] }));
        await made("qs_in_org", "org");
        await made("qs_in_org_x", "org:x");

        expect(await store.sessionsForOrg("org", 10)).toEqual(["qs_in_org"]);
        expect(await store.sessionsForOrg("org:x", 10)).toEqual(["qs_in_org_x"]);
      });

      it("returns at most the limit it is handed", async () => {
        for (const n of [1, 2, 3]) await store.createSession(session({ id: `qs_org_many_${n}`, joinCodes: {} }));
        expect(await store.sessionsForOrg("org_codenerd", 2)).toHaveLength(2);
      });

      it("keeps listing a closed room until it is purged, and then drops it from every org that sat in it", async () => {
        const s = session({ id: "qs_org_purge", retainAfterCloseMs: 60_000, joinCodes: {}, members: [member(), peer()] });
        await store.createSession(s);
        await store.closeSession(s.id);
        await sweepRoom(s.id);
        expect(await store.sessionsForOrg("org_codenerd", 10), "closed, inside the window").toContain(s.id);
        expect(await store.sessionsForOrg("org_other", 10)).toContain(s.id);

        vi.advanceTimersByTime(60_001);
        await sweepRoom(s.id);

        expect(await store.sessionsForOrg("org_codenerd", 10)).not.toContain(s.id);
        expect(await store.sessionsForOrg("org_other", 10)).not.toContain(s.id);
      });
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
      expect((await store.getMember(s.id, "m_peer"))?.leftAt).toBe(9_000_000);
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
      const m = (await store.getMember(s.id, "m_peer"))!;
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
      const m = (await store.getMember(s.id, "m_peer"))!;
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
      const m = (await store.getMember(s.id, "m_peer"))!;
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
      expect((await store.getMember(s.id, "m_peer"))?.leftAt)
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
      expect((await store.getMember(s.id, "m_peer"))?.leftAt).toBeNull();
      expect((await store.getMember(s.id, "m_peer"))?.removedAtCursor).toBeUndefined();
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
      expect((await store.getMember(s.id, "m_peer"))?.leftAt, "the original stamp stands")
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
      // A falsy org names a stream nobody reads. A Durable Object namespace takes "" as
      // a name and would deliver into it, so the entry is dropped before it is queued.
      // Both defences sit behind this answer in the Durable Object store (the producer's
      // filter and the outbox's delivery guard), so what this pins there is the result.
      // MemoryStore's recordAudit drops such a row as well, behind the producer's filter.
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

    /**
     * Strings that are not ban ids: ones near enough to `banId` to be taken for it, and two past 2 KiB, the
     * limit on a Durable Object storage key. A ban id is `ban_` and 16 hex characters, so a store answers all
     * of these without reading storage. The local workerd enforces no key limit, so these cases cannot see a
     * lift read one: worker-tests/ban-id-guard.test.ts counts the storage a lift opens.
     */
    const notBanIds = (banId: string) => ["", "ban_", banId.slice(0, -1), `${banId}0`, "x".repeat(3_000), `ban_${"0".repeat(3_000)}`];

    describe("room bans (abuse protections spec \u{A7}1)", () => {
      const twoInRoom = () => session({
        members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd" })],
      });
      const back = (memberId = "m_peer_2", roomRole = "peer_b") =>
        member({ memberId, userId: "u_peer", label: "peer@codenerd", roomRole });

      it("records the account on an eviction that asks, and refuses its next seating in any seat", async () => {
        const s = twoInRoom();
        await store.createSession(s);
        expect(await store.removeMember(s.id, "m_peer", { ...eviction(), ban: "room" }))
          .toEqual({ refused: null, removed: true, codeRetired: "peer_b" });
        expect(await store.roomBans(s.id)).toEqual([
          { banId: expect.stringMatching(/^ban_[0-9a-f]{16}$/), userId: "u_peer", label: "peer@codenerd", at: 9_000_000 },
        ]);
        expect((await store.seatMember(s.id, back(), 1, 9_100_000)).refused).toBe("banned");
        expect((await store.seatMember(s.id, back("m_peer_3", "peer_a"), 1, 9_100_000)).refused).toBe("banned");
        expect((await store.seatMember(s.id, member({ memberId: "m_other", userId: "u_other", label: "other@x" }), 1, 9_100_000)).refused,
          "the control: another account seats").toBeNull();
      });

      it("refuses a banned account as banned and not as full, when the room has no seat free", async () => {
        const s = twoInRoom();
        await store.createSession(s);
        await store.removeMember(s.id, "m_peer", { ...eviction(), ban: "room" });
        const seat = (memberId: string, userId: string) =>
          store.seatMember(s.id, member({ memberId, userId, label: `${userId}@x` }), 1, 9_100_000);
        expect((await seat("m_other", "u_other")).refused, "the other account takes the free seat").toBeNull();
        expect((await seat("m_third", "u_third")).refused, "the control: the room is full").toBe("full");
        expect((await store.seatMember(s.id, back(), 1, 9_100_000)).refused).toBe("banned");
      });

      it("writes no ban for a removal that does not ask, and the account seats again", async () => {
        const s = twoInRoom();
        await store.createSession(s);
        await store.removeMember(s.id, "m_peer", eviction());
        expect(await store.roomBans(s.id)).toEqual([]);
        expect((await store.seatMember(s.id, back(), 1, 9_100_000)).refused).toBeNull();
      });

      /** Review Focus 1. */
      it("bans a member who already left, behind no live door, writing no event and moving no cursor", async () => {
        const s = session({
          joinCodes: {},
          members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", leftAt: 5_000 })],
        });
        await store.createSession(s);
        expect(await store.removeMember(s.id, "m_peer", { ...eviction(), ban: "room" }))
          .toEqual({ refused: null, removed: false, codeRetired: null });
        expect((await store.roomBans(s.id)).map((b) => b.userId)).toEqual(["u_peer"]);
        expect(await store.eventsAfter(s.id, 0)).toEqual([]);
        expect((await store.appendEvent(s.id, leaveEvent("m_creator")))?.cursor).toBe(1);
      });

      // The audit log is where an org reads every ban. One on someone who already left is the eviction's
      // row all the same, carrying the scope, and it is filed once: the call that wrote the ban files it,
      // and a repeat, which writes none, does not. "all" is the case that tells the stores apart on a
      // repeat, since the Durable Objects store queues the registry's write each time it is asked.
      for (const scope of ["room", "all"] as const) {
        it(`files the eviction's audit row for a ban on a member who already left, and only once (${scope})`, async () => {
          const s = session({
            joinCodes: {},
            members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", leftAt: 5_000 })],
          });
          await store.createSession(s);
          const asked = (now: number): RemovalRequest => ({
            ...eviction(now), ban: scope, audit: [{ ...auditRow("member_evicted"), detail: { ban: scope } }],
          });
          const filed = async () => (await store.auditForOrg("org_codenerd", 10)).map((a) => [a.action, a.detail]);

          expect(await store.removeMember(s.id, "m_peer", asked(9_000_000)))
            .toEqual({ refused: null, removed: false, codeRetired: null });
          expect(await filed()).toEqual([["member_evicted", { ban: scope }]]);

          await store.removeMember(s.id, "m_peer", asked(9_500_000));
          expect(await filed(), "a repeat files no second row").toEqual([["member_evicted", { ban: scope }]]);
        });
      }

      it("keeps one ban per account: a repeat records nothing new", async () => {
        const s = twoInRoom();
        await store.createSession(s);
        await store.removeMember(s.id, "m_peer", { ...eviction(), ban: "room" });
        const first = await store.roomBans(s.id);
        await store.removeMember(s.id, "m_peer", { ...eviction(9_500_000), ban: "room" });
        expect(await store.roomBans(s.id)).toEqual(first);
      });

      it("writes no ban when the removal is refused", async () => {
        const s = twoInRoom();
        await store.createSession(s);
        await store.removeMember(s.id, "m_peer", { ...eviction(), byUserId: "u_someone_else", ban: "room" });
        expect(await store.roomBans(s.id)).toEqual([]);
      });

      it("lifts a ban by its id, once, and the account seats again", async () => {
        const s = twoInRoom();
        await store.createSession(s);
        await store.removeMember(s.id, "m_peer", { ...eviction(), ban: "room" });
        const [ban] = await store.roomBans(s.id);
        expect(await store.liftRoomBan(s.id, "ban_0000000000000000")).toBe(false);
        expect(await store.liftRoomBan(s.id, ban.banId)).toBe(true);
        expect(await store.liftRoomBan(s.id, ban.banId)).toBe(false);
        expect(await store.roomBans(s.id)).toEqual([]);
        expect((await store.seatMember(s.id, back(), 1, 9_100_000)).refused).toBeNull();
      });

      // The preview's check: `bellman_connect` asks it before it describes the room.
      it("says whether the room bans an account, for that account and room alone, until the ban is lifted", async () => {
        const s = twoInRoom();
        await store.createSession(s);
        expect(await store.isBannedFromRoom(s.id, "u_peer"), "the control: not yet banned").toBe(false);
        await store.removeMember(s.id, "m_peer", { ...eviction(), ban: "room" });
        expect(await store.isBannedFromRoom(s.id, "u_peer")).toBe(true);
        expect(await store.isBannedFromRoom(s.id, "u_pee"), "another account").toBe(false);
        expect(await store.isBannedFromRoom("qs_nowhere", "u_peer"), "an unknown room").toBe(false);
        const [ban] = await store.roomBans(s.id);
        await store.liftRoomBan(s.id, ban.banId);
        expect(await store.isBannedFromRoom(s.id, "u_peer"), "lifted").toBe(false);
      });

      it("lists bans oldest first by when each was made, not in the order they were written", async () => {
        const s = swarmSession({
          members: [
            member({ memberId: "m_creator" }),
            ...["a", "b", "c", "d"].map((n) => member({ memberId: `m_${n}`, userId: `u_${n}`, label: `${n}@x` })),
          ],
        });
        await store.createSession(s);
        for (const [n, at] of [["a", 9_300_000], ["b", 9_100_000], ["c", 9_400_000], ["d", 9_200_000]] as const) {
          await store.removeMember(s.id, `m_${n}`, { ...eviction(at), ban: "room" });
        }
        expect((await store.roomBans(s.id)).map((b) => b.userId)).toEqual(["u_b", "u_d", "u_a", "u_c"]);
      });

      it("forgets a room's bans when the room is purged", async () => {
        const s = session({
          id: "qs_ban_purge",
          retainAfterCloseMs: 60_000,
          members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd" })],
        });
        await store.createSession(s);
        await store.removeMember(s.id, "m_peer", { ...eviction(), ban: "room" });
        expect((await store.roomBans(s.id)).map((b) => b.userId), "the control: the ban is there").toEqual(["u_peer"]);
        await store.closeSession(s.id);
        vi.advanceTimersByTime(60_001);
        await sweepRoom(s.id);
        expect(await store.getSession(s.id), "the room is purged").toBeUndefined();
        expect(await store.roomBans(s.id)).toEqual([]);
      });

      it("answers no bans for an unknown room", async () => {
        expect(await store.roomBans("qs_nowhere")).toEqual([]);
        expect(await store.liftRoomBan("qs_nowhere", "ban_0000000000000000")).toBe(false);
      });

      it("lifts nothing for an id that is not a ban id, and does not throw", async () => {
        const s = twoInRoom();
        await store.createSession(s);
        await store.removeMember(s.id, "m_peer", { ...eviction(), ban: "room" });
        const [ban] = await store.roomBans(s.id);
        for (const id of notBanIds(ban.banId)) expect(await store.liftRoomBan(s.id, id), id.slice(0, 24)).toBe(false);
        expect((await store.roomBans(s.id)).map((b) => b.banId), "the control: the ban is still there").toEqual([ban.banId]);
      });
    });

    describe("creator-wide bans (abuse protections spec \u{A7}1)", () => {
      const room = (id: string, createdBy = "u_jesse") => session({
        id, createdBy,
        members: [member({ memberId: "m_creator", userId: createdBy }), member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd" })],
      });

      it("bans the account from every room the creator owns and from no one else's, and from this room too", async () => {
        await store.createSession(room("qs_a"));
        await store.removeMember("qs_a", "m_peer", { ...eviction(), ban: "all" });
        expect(await store.isBannedByCreator("u_jesse", "u_peer")).toBe(true);
        expect(await store.isBannedByCreator("u_someone_else", "u_peer")).toBe(false);
        expect(await store.isBannedByCreator("u_jesse", "u_other")).toBe(false);
        expect((await store.roomBans("qs_a")).map((b) => b.userId)).toEqual(["u_peer"]);
        expect(await store.creatorBans("u_jesse")).toEqual([
          { banId: expect.stringMatching(/^ban_[0-9a-f]{16}$/), userId: "u_peer", label: "peer@codenerd", at: 9_000_000, sessionId: "qs_a" },
        ]);
      });

      it("writes nothing creator-wide for a room ban", async () => {
        await store.createSession(room("qs_a"));
        await store.removeMember("qs_a", "m_peer", { ...eviction(), ban: "room" });
        expect(await store.isBannedByCreator("u_jesse", "u_peer")).toBe(false);
        expect(await store.creatorBans("u_jesse")).toEqual([]);
      });

      it("bans creator-wide a member who already left, and keeps the first ban on a repeat", async () => {
        await store.createSession(session({
          id: "qs_a", joinCodes: {},
          members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", leftAt: 5_000 })],
        }));
        await store.removeMember("qs_a", "m_peer", { ...eviction(), ban: "all" });
        const first = await store.creatorBans("u_jesse");
        expect(first.map((b) => b.userId)).toEqual(["u_peer"]);
        await store.removeMember("qs_a", "m_peer", { ...eviction(9_500_000), ban: "all" });
        expect(await store.creatorBans("u_jesse")).toEqual(first);
      });

      it("widens a room ban to every room on a later eviction that asks for all", async () => {
        await store.createSession(room("qs_a"));
        await store.removeMember("qs_a", "m_peer", { ...eviction(), ban: "room" });
        await store.removeMember("qs_a", "m_peer", { ...eviction(9_500_000), ban: "all" });
        expect(await store.isBannedByCreator("u_jesse", "u_peer")).toBe(true);
      });

      it("lifts by id for its creator only, and leaves the room ban that came with it", async () => {
        await store.createSession(room("qs_a"));
        await store.removeMember("qs_a", "m_peer", { ...eviction(), ban: "all" });
        const [ban] = await store.creatorBans("u_jesse");
        expect(await store.liftCreatorBan("u_someone_else", ban.banId)).toBe(false);
        expect(await store.liftCreatorBan("u_jesse", ban.banId)).toBe(true);
        expect(await store.liftCreatorBan("u_jesse", ban.banId)).toBe(false);
        expect(await store.isBannedByCreator("u_jesse", "u_peer")).toBe(false);
        expect((await store.roomBans("qs_a")).map((b) => b.userId)).toEqual(["u_peer"]);
      });

      // Operator-issued user ids may hold a colon, so one creator's id can begin another's past the key's separator.
      it("keeps creators whose ids share a prefix apart", async () => {
        await store.createSession(room("qs_xy", "u_x:y"));
        await store.removeMember("qs_xy", "m_peer", { ...eviction(), byUserId: "u_x:y", ban: "all" });
        expect(await store.creatorBans("u_x")).toEqual([]);
        expect(await store.isBannedByCreator("u_x", "u_peer")).toBe(false);
        expect((await store.creatorBans("u_x:y")).map((b) => b.userId)).toEqual(["u_peer"]);
      });

      it("lists bans oldest first by when each was made, not in the order they were written", async () => {
        const s = swarmSession({
          members: [
            member({ memberId: "m_creator" }),
            ...["a", "b", "c", "d"].map((n) => member({ memberId: `m_${n}`, userId: `u_${n}`, label: `${n}@x` })),
          ],
        });
        await store.createSession(s);
        for (const [n, at] of [["a", 9_300_000], ["b", 9_100_000], ["c", 9_400_000], ["d", 9_200_000]] as const) {
          await store.removeMember(s.id, `m_${n}`, { ...eviction(at), ban: "all" });
        }
        expect((await store.creatorBans("u_jesse")).map((b) => b.userId)).toEqual(["u_b", "u_d", "u_a", "u_c"]);
      });

      it("lifts nothing for an id that is not a ban id, and does not throw", async () => {
        await store.createSession(room("qs_a"));
        await store.removeMember("qs_a", "m_peer", { ...eviction(), ban: "all" });
        const [ban] = await store.creatorBans("u_jesse");
        for (const id of notBanIds(ban.banId)) expect(await store.liftCreatorBan("u_jesse", id), id.slice(0, 24)).toBe(false);
        expect((await store.creatorBans("u_jesse")).map((b) => b.banId), "the control: the ban is still there").toEqual([ban.banId]);
      });
    });

    describe("signing in (#258)", () => {
        it("counts nobody on a fresh store", async () => {
          expect(await store.countUsers()).toBe(0);
        });

        it("counts a person once, however many times they sign in", async () => {
          await store.recordSignIn("u_github_1", 1_000);
          await store.recordSignIn("u_github_1", 2_000);
          await store.recordSignIn("u_github_1", 3_000);

          expect(await store.countUsers()).toBe(1);
        });

        it("counts each person once", async () => {
          await store.recordSignIn("u_github_1", 1_000);
          await store.recordSignIn("u_google_2", 1_000);
          await store.recordSignIn("u_github_3", 1_000);

          expect(await store.countUsers()).toBe(3);
        });

        /**
         * The off-by-one AuthDO's client count had (#122) was a counter seeded by
         * reading the keys back. This one starts at 0 and only increments on a
         * first insert, so the first person counts as one.
         */
        it("counts the first person as one, not two", async () => {
          await store.recordSignIn("u_github_1", 1_000);

          expect(await store.countUsers()).toBe(1);
        });
    });
  });
}
