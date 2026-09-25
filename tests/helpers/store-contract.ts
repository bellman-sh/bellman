/**
 * Conformance suite for the BellmanStore interface.
 *
 * Every implementation must pass this identically — that is what makes the
 * interface a real seam rather than a comment. M1 runs it against MemoryStore;
 * M3 runs the same suite against SqliteStore with no edits here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { BellmanStore } from "../../src/store.js";
import { JOIN_CODE_TTL, CONNECT_TOKEN_TTL } from "../../src/store.js";
import { member, session } from "./fixtures.js";

export function describeStoreContract(
  name: string,
  makeStore: () => BellmanStore,
): void {
  describe(`BellmanStore contract: ${name}`, () => {
    let store: BellmanStore;

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
      const s = session({ joinCode: "BELL-ABCD-12" });
      (await store.createSession(s));
      expect((await store.getSessionByJoinCode("BELL-ABCD-12"))?.id).toBe(s.id);
      expect((await store.getSessionByJoinCode("BELL-ZZZZ-99"))).toBeUndefined();
    });

    /** INVARIANT 2: unused join codes expire after 15 minutes. */
    it("stops resolving a join code once its TTL elapses", async () => {
      const s = session({ joinCodeExpiresAt: Date.now() + JOIN_CODE_TTL });
      (await store.createSession(s));
      expect((await store.getSessionByJoinCode(s.joinCode!))).toBeDefined();

      vi.advanceTimersByTime(JOIN_CODE_TTL + 1);
      expect((await store.getSessionByJoinCode(s.joinCode!))).toBeUndefined();
    });

    /** INVARIANT 2: join codes are single-use. */
    it("consumeJoinCode makes the code unusable and idempotent", async () => {
      const s = session({ joinCode: "BELL-ONCE-01" });
      (await store.createSession(s));

      (await store.consumeJoinCode(s.id));
      expect((await store.getSessionByJoinCode("BELL-ONCE-01"))).toBeUndefined();
      expect((await store.getSession(s.id))?.joinCode).toBeNull();

      await expect(store.consumeJoinCode(s.id)).resolves.not.toThrow();
    });

    it("never resolves a join code for a closed session", async () => {
      const s = session();
      (await store.createSession(s));
      (await store.closeSession(s.id));
      expect((await store.getSessionByJoinCode(s.joinCode!))).toBeUndefined();
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

      expect(a.cursor).toBe(1);
      expect(b.cursor).toBe(2);
      expect(a.at).toBe(Date.now());
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

    it("throws when appending to an unknown session", async () => {
      await expect(
        store.appendEvent("qs_nope", {
          type: "message", fromMemberId: "m", fromUserId: "u",
          fromLabel: "l", payload: {}, refId: null,
        }),
      ).rejects.toThrow();
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

    it("waitForEvents resolves empty after the wait elapses", async () => {
      const s = session();
      (await store.createSession(s));

      const pending = store.waitForEvents(s.id, 0, 5_000);
      await vi.advanceTimersByTimeAsync(5_001);
      await expect(pending).resolves.toEqual([]);
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
      const a = session({ joinCode: "BELL-AAAA-01" });
      (await store.createSession(a));

      (await store.setJoinCode(a.id, "BELL-BBBB-02", Date.now() + JOIN_CODE_TTL));

      expect(await store.getSessionByJoinCode("BELL-AAAA-01")).toBeUndefined();
      expect((await store.getSessionByJoinCode("BELL-BBBB-02"))?.id).toBe(a.id);
      expect((await store.getSession(a.id))?.joinCode).toBe("BELL-BBBB-02");
    });

    it("issues a code after the previous one was consumed", async () => {
      const a = session({ joinCode: "BELL-AAAA-01" });
      (await store.createSession(a));
      (await store.consumeJoinCode(a.id));

      (await store.setJoinCode(a.id, "BELL-CCCC-03", Date.now() + JOIN_CODE_TTL));

      expect((await store.getSessionByJoinCode("BELL-CCCC-03"))?.id).toBe(a.id);
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

      expect(await store.putGrantIfOwned({ ...base, orgId: "org_mine" }, "org_mine"))
        .toBe("conflict");
      expect(await store.getGrant("github:4242")).toMatchObject({ orgId: "org_theirs" });
    });

    it("writes when the key is unowned, or already the caller's", async () => {
      const base = {
        key: "github:4242", plan: "pro" as const, role: "member" as const, orgId: "org_mine",
        source: "purchase", grantedAt: Date.now(), grantedBy: "stripe", expiresAt: null,
      };

      expect(await store.putGrantIfOwned(base, "org_mine")).toBe("written");
      expect(await store.putGrantIfOwned({ ...base, plan: "team" }, "org_mine")).toBe("written");
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

      expect(await store.deleteGrantIfOwned("github:nobody", "org_mine")).toBe("missing");
      expect(await store.deleteGrantIfOwned("github:4242", "org_mine")).toBe("conflict");
      expect(await store.getGrant("github:4242")).toBeDefined();

      expect(await store.deleteGrantIfOwned("github:4242", "org_theirs")).toBe("deleted");
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
      }, "org_mine")).toBe("written");

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

      expect(await store.deleteGrantIfOwned("github:4242", "org_mine")).toBe("missing");
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

      expect((await store.putGrantIfSource({ ...base, plan: "team", source: "purchase" }, "purchase")).outcome)
        .toBe("conflict");
      expect((await store.deleteGrantIfSource("github:4242", "purchase")).outcome).toBe("conflict");
      expect(await store.getGrant("github:4242")).toMatchObject({ plan: "pro", source: "operator" });
    });

    it("lets billing write, update and remove its own grant", async () => {
      const purchase = {
        key: "github:4242", plan: "pro" as const, role: "member" as const, orgId: null,
        source: "purchase", grantedAt: Date.now(), grantedBy: "stripe", expiresAt: null,
      };

      expect(await store.putGrantIfSource(purchase, "purchase"))
        .toEqual({ outcome: "written", previous: undefined });

      // The write reports what it replaced, so billing can tell a real change
      // from a repeated delivery and see which org a plan moved out of.
      const updated = await store.putGrantIfSource({ ...purchase, plan: "team" }, "purchase");
      expect(updated.outcome).toBe("written");
      expect(updated.previous).toMatchObject({ plan: "pro" });
      expect(await store.getGrant("github:4242")).toMatchObject({ plan: "team" });

      const gone = await store.deleteGrantIfSource("github:4242", "purchase");
      expect(gone.outcome).toBe("deleted");
      expect(gone.removed).toMatchObject({ plan: "team" });
      expect((await store.deleteGrantIfSource("github:4242", "purchase")).outcome).toBe("missing");
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
        store.putGrantIfOwned({ ...base, plan: "team", source: "operator" }, "org_mine"),
        store.deleteGrantIfSource("github:4242", "purchase"),
      ]);

      // Either order of completion is fine. What must not happen is the delete
      // removing a hand grant whose source it never checked.
      if (put === "written") {
        expect(await store.getGrant("github:4242")).toMatchObject({ source: "operator" });
      }
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
        token: "qct_1", sessionId: "qs_test", userId: "u_peer",
        createdAt: Date.now(), expiresAt: Date.now() + CONNECT_TOKEN_TTL,
      }));
      expect((await store.takePendingConnect("qct_1"))?.userId).toBe("u_peer");
      expect((await store.takePendingConnect("qct_1"))).toBeUndefined();
    });

    it("takePendingConnect refuses an expired token", async () => {
      (await store.putPendingConnect({
        token: "qct_2", sessionId: "qs_test", userId: "u_peer",
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
      expect(fresh.joinCode).toBeNull();
      expect(fresh.events.at(-1)?.type).toBe("session_expired");
      expect((await store.getSessionByJoinCode("BELL-TEST-01"))).toBeUndefined();
    });

    it("sweep is idempotent — one expiry event, not one per sweep", async () => {
      const s = session({ expiresAt: Date.now() + 1_000 });
      (await store.createSession(s));

      vi.advanceTimersByTime(1_001);
      (await store.sweep(Date.now()));
      (await store.sweep(Date.now()));
      (await store.sweep(Date.now()));

      const expired = (await store.getSession(s.id))!.events.filter(
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
        token: "qct_sweep", sessionId: "qs_test", userId: "u_peer",
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
        token: "qct_live", sessionId: s.id, userId: "u_peer",
        createdAt: Date.now(), expiresAt: Date.now() + CONNECT_TOKEN_TTL,
      }));

      (await store.sweep(Date.now()));
      expect((await store.getSession(s.id))?.closed).toBe(false);
      expect((await store.takePendingConnect("qct_live"))).toBeDefined();
    });
  });
}
