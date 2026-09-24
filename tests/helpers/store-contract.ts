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
