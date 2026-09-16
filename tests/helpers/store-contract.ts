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
    it("round-trips a created session", () => {
      const s = session();
      store.createSession(s);
      expect(store.getSession(s.id)?.id).toBe(s.id);
      expect(store.getSession(s.id)?.members).toHaveLength(1);
    });

    it("returns undefined for an unknown session", () => {
      expect(store.getSession("qs_nope")).toBeUndefined();
    });

    /**
     * INVARIANT 5: state lives behind the store. A caller that mutates the
     * object it read back must not affect stored state — otherwise handlers
     * silently depend on MemoryStore's shared references and break the moment
     * a real database is behind the interface.
     */
    it("hands back a detached copy, so caller mutation does not persist", () => {
      const s = session();
      store.createSession(s);

      const read = store.getSession(s.id)!;
      read.closed = true;
      read.members.push(member({ memberId: "m_smuggled" }));
      read.members[0].brief.goal = "mutated";
      read.maxMembers = 999;

      const fresh = store.getSession(s.id)!;
      expect(fresh.closed).toBe(false);
      expect(fresh.members).toHaveLength(1);
      expect(fresh.members[0].brief.goal).not.toBe("mutated");
      expect(fresh.maxMembers).toBe(2);
    });

    it("does not let the caller's original object mutate stored state either", () => {
      const s = session();
      store.createSession(s);
      s.members.push(member({ memberId: "m_smuggled" }));
      expect(store.getSession(s.id)?.members).toHaveLength(1);
    });

    // ------------------------------------------------------------ join codes
    it("finds a session by join code", () => {
      const s = session({ joinCode: "BELL-ABCD-12" });
      store.createSession(s);
      expect(store.getSessionByJoinCode("BELL-ABCD-12")?.id).toBe(s.id);
      expect(store.getSessionByJoinCode("BELL-ZZZZ-99")).toBeUndefined();
    });

    /** INVARIANT 2: unused join codes expire after 15 minutes. */
    it("stops resolving a join code once its TTL elapses", () => {
      const s = session({ joinCodeExpiresAt: Date.now() + JOIN_CODE_TTL });
      store.createSession(s);
      expect(store.getSessionByJoinCode(s.joinCode!)).toBeDefined();

      vi.advanceTimersByTime(JOIN_CODE_TTL + 1);
      expect(store.getSessionByJoinCode(s.joinCode!)).toBeUndefined();
    });

    /** INVARIANT 2: join codes are single-use. */
    it("consumeJoinCode makes the code unusable and idempotent", () => {
      const s = session({ joinCode: "BELL-ONCE-01" });
      store.createSession(s);

      store.consumeJoinCode(s.id);
      expect(store.getSessionByJoinCode("BELL-ONCE-01")).toBeUndefined();
      expect(store.getSession(s.id)?.joinCode).toBeNull();

      expect(() => store.consumeJoinCode(s.id)).not.toThrow();
    });

    it("never resolves a join code for a closed session", () => {
      const s = session();
      store.createSession(s);
      store.closeSession(s.id);
      expect(store.getSessionByJoinCode(s.joinCode!)).toBeUndefined();
    });

    // --------------------------------------------------------------- members
    it("addMember appends a member", () => {
      const s = session();
      store.createSession(s);
      store.addMember(s.id, member({ memberId: "m_joiner", userId: "u_peer" }));

      const fresh = store.getSession(s.id)!;
      expect(fresh.members.map((m) => m.memberId)).toEqual(["m_creator", "m_joiner"]);
    });

    it("updateMember patches brief, capabilities and leftAt", () => {
      const s = session();
      store.createSession(s);

      store.updateMember(s.id, "m_creator", {
        capabilities: ["read_context"],
        leftAt: Date.now(),
      });
      const fresh = store.getSession(s.id)!;
      expect(fresh.members[0].capabilities).toEqual(["read_context"]);
      expect(fresh.members[0].leftAt).toBe(Date.now());
      // untouched fields survive the patch
      expect(fresh.members[0].label).toBe("jesse@codenerd");
    });

    it("updateMember ignores unknown members and sessions", () => {
      const s = session();
      store.createSession(s);
      expect(() => store.updateMember(s.id, "m_nope", { leftAt: 1 })).not.toThrow();
      expect(() => store.updateMember("qs_nope", "m_creator", { leftAt: 1 })).not.toThrow();
    });

    it("closeSession marks the session closed", () => {
      const s = session();
      store.createSession(s);
      store.closeSession(s.id);
      expect(store.getSession(s.id)?.closed).toBe(true);
    });

    // ---------------------------------------------------------------- events
    it("assigns monotonic cursors starting at 1", () => {
      const s = session();
      store.createSession(s);

      const a = store.appendEvent(s.id, {
        type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse",
        fromLabel: "jesse", payload: { text: "one" }, refId: null,
      });
      const b = store.appendEvent(s.id, {
        type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse",
        fromLabel: "jesse", payload: { text: "two" }, refId: null,
      });

      expect(a.cursor).toBe(1);
      expect(b.cursor).toBe(2);
      expect(a.at).toBe(Date.now());
    });

    it("eventsAfter filters strictly by cursor", () => {
      const s = session();
      store.createSession(s);
      for (const text of ["one", "two", "three"]) {
        store.appendEvent(s.id, {
          type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse",
          fromLabel: "jesse", payload: { text }, refId: null,
        });
      }
      expect(store.eventsAfter(s.id, 0)).toHaveLength(3);
      expect(store.eventsAfter(s.id, 2).map((e) => e.cursor)).toEqual([3]);
      expect(store.eventsAfter(s.id, 3)).toHaveLength(0);
      expect(store.eventsAfter("qs_nope", 0)).toEqual([]);
    });

    it("throws when appending to an unknown session", () => {
      expect(() =>
        store.appendEvent("qs_nope", {
          type: "message", fromMemberId: "m", fromUserId: "u",
          fromLabel: "l", payload: {}, refId: null,
        }),
      ).toThrow();
    });

    // ------------------------------------------------------------- long-poll
    it("waitForEvents returns immediately when events already exist", async () => {
      const s = session();
      store.createSession(s);
      store.appendEvent(s.id, {
        type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse",
        fromLabel: "jesse", payload: { text: "hi" }, refId: null,
      });

      await expect(store.waitForEvents(s.id, 0, 10_000)).resolves.toHaveLength(1);
    });

    it("waitForEvents resolves early when an event arrives", async () => {
      const s = session();
      store.createSession(s);

      const pending = store.waitForEvents(s.id, 0, 20_000);
      let settled = false;
      void pending.then(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(500);
      expect(settled).toBe(false);

      store.appendEvent(s.id, {
        type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse",
        fromLabel: "jesse", payload: { text: "late" }, refId: null,
      });

      await expect(pending).resolves.toHaveLength(1);
    });

    it("waitForEvents resolves empty after the wait elapses", async () => {
      const s = session();
      store.createSession(s);

      const pending = store.waitForEvents(s.id, 0, 5_000);
      await vi.advanceTimersByTimeAsync(5_001);
      await expect(pending).resolves.toEqual([]);
    });

    it("waitForEvents returns synchronously for a zero wait", async () => {
      const s = session();
      store.createSession(s);
      await expect(store.waitForEvents(s.id, 0, 0)).resolves.toEqual([]);
    });

    it("wakes every waiter on a session, each from its own cursor", async () => {
      const s = session();
      store.createSession(s);
      store.appendEvent(s.id, {
        type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse",
        fromLabel: "jesse", payload: { text: "first" }, refId: null,
      });

      const fromZero = store.waitForEvents(s.id, 1, 20_000);
      const alsoFromZero = store.waitForEvents(s.id, 1, 20_000);

      store.appendEvent(s.id, {
        type: "message", fromMemberId: "m_creator", fromUserId: "u_jesse",
        fromLabel: "jesse", payload: { text: "second" }, refId: null,
      });

      expect((await fromZero).map((e) => e.cursor)).toEqual([2]);
      expect((await alsoFromZero).map((e) => e.cursor)).toEqual([2]);
    });

    // ------------------------------------------------------- pending connects
    /** INVARIANT 2: connect tokens are single-use with their own TTL. */
    it("takePendingConnect is single-use", () => {
      store.putPendingConnect({
        token: "qct_1", sessionId: "qs_test", userId: "u_peer",
        createdAt: Date.now(), expiresAt: Date.now() + CONNECT_TOKEN_TTL,
      });
      expect(store.takePendingConnect("qct_1")?.userId).toBe("u_peer");
      expect(store.takePendingConnect("qct_1")).toBeUndefined();
    });

    it("takePendingConnect refuses an expired token", () => {
      store.putPendingConnect({
        token: "qct_2", sessionId: "qs_test", userId: "u_peer",
        createdAt: Date.now(), expiresAt: Date.now() + CONNECT_TOKEN_TTL,
      });
      vi.advanceTimersByTime(CONNECT_TOKEN_TTL + 1);
      expect(store.takePendingConnect("qct_2")).toBeUndefined();
    });

    // ---------------------------------------------------------------- quotas
    it("counts creates within the current calendar month only", () => {
      store.recordCreate("u_jesse");
      store.recordCreate("u_jesse");
      store.recordCreate("u_peer");
      expect(store.countCreatesThisMonth("u_jesse")).toBe(2);
      expect(store.countCreatesThisMonth("u_peer")).toBe(1);
      expect(store.countCreatesThisMonth("u_nobody")).toBe(0);

      // Roll well into the next month (any timezone) — earlier creates stop counting.
      vi.setSystemTime(new Date("2026-04-15T12:00:00Z"));
      expect(store.countCreatesThisMonth("u_jesse")).toBe(0);
    });

    // ----------------------------------------------------------------- audit
    it("scopes audit reads to a single org", () => {
      store.appendAudit({
        at: Date.now(), orgId: "org_a", sessionId: "qs_1",
        actorUserId: "u_a", action: "session_created", detail: {},
      });
      store.appendAudit({
        at: Date.now(), orgId: "org_b", sessionId: "qs_2",
        actorUserId: "u_b", action: "session_created", detail: {},
      });

      expect(store.auditForOrg("org_a", 50)).toHaveLength(1);
      expect(store.auditForOrg("org_a", 50)[0].sessionId).toBe("qs_1");
      expect(store.auditForOrg("org_c", 50)).toHaveLength(0);
    });

    it("returns the most recent audit entries up to the limit", () => {
      for (let i = 0; i < 10; i++) {
        store.appendAudit({
          at: Date.now() + i, orgId: "org_a", sessionId: `qs_${i}`,
          actorUserId: "u_a", action: "sent_message", detail: { i },
        });
      }
      const recent = store.auditForOrg("org_a", 3);
      expect(recent).toHaveLength(3);
      expect(recent.map((a) => a.sessionId)).toEqual(["qs_7", "qs_8", "qs_9"]);
    });

    // ----------------------------------------------------------------- sweep
    it("sweep expires a session past its TTL and emits session_expired", () => {
      const s = session({ expiresAt: Date.now() + 1_000 });
      store.createSession(s);

      vi.advanceTimersByTime(1_001);
      store.sweep(Date.now());

      const fresh = store.getSession(s.id)!;
      expect(fresh.closed).toBe(true);
      expect(fresh.joinCode).toBeNull();
      expect(fresh.events.at(-1)?.type).toBe("session_expired");
      expect(store.getSessionByJoinCode("BELL-TEST-01")).toBeUndefined();
    });

    it("sweep is idempotent — one expiry event, not one per sweep", () => {
      const s = session({ expiresAt: Date.now() + 1_000 });
      store.createSession(s);

      vi.advanceTimersByTime(1_001);
      store.sweep(Date.now());
      store.sweep(Date.now());
      store.sweep(Date.now());

      const expired = store.getSession(s.id)!.events.filter(
        (e) => e.type === "session_expired",
      );
      expect(expired).toHaveLength(1);
    });

    it("expires a due session lazily on read, without waiting for a sweep", () => {
      const s = session({ expiresAt: Date.now() + 1_000 });
      store.createSession(s);
      vi.advanceTimersByTime(1_001);
      expect(store.getSession(s.id)?.closed).toBe(true);
    });

    it("sweep drops expired pending connects", () => {
      store.putPendingConnect({
        token: "qct_sweep", sessionId: "qs_test", userId: "u_peer",
        createdAt: Date.now(), expiresAt: Date.now() + 1_000,
      });
      vi.advanceTimersByTime(1_001);
      store.sweep(Date.now());
      expect(store.takePendingConnect("qct_sweep")).toBeUndefined();
    });

    it("sweep leaves live sessions and tokens alone", () => {
      const s = session();
      store.createSession(s);
      store.putPendingConnect({
        token: "qct_live", sessionId: s.id, userId: "u_peer",
        createdAt: Date.now(), expiresAt: Date.now() + CONNECT_TOKEN_TTL,
      });

      store.sweep(Date.now());
      expect(store.getSession(s.id)?.closed).toBe(false);
      expect(store.takePendingConnect("qct_live")).toBeDefined();
    });
  });
}
