import { beforeEach, describe, expect, it, vi } from "vitest";
import { member, session } from "./helpers/fixtures.js";
import { MemoryStore } from "../src/store.js";
import { activeMembers, audit, issueInvite, leaveRoom, revokeInvite } from "../src/rooms.js";
import type { Identity } from "../src/types.js";

/**
 * The operations in src/rooms.ts, driven directly. The authority rules are the
 * reason this file exists: through the MCP harness they are visible only as a
 * refusal sentence, and here they are the subject.
 */
const jesse: Identity = {
  userId: "u_jesse", orgId: "org_codenerd", plan: "team", role: "admin", label: "jesse@codenerd",
};
const peer: Identity = {
  userId: "u_peer", orgId: "org_codenerd", plan: "free", role: "member", label: "peer@codenerd",
};

let store: MemoryStore;

beforeEach(() => {
  store = new MemoryStore();
});

describe("leaveRoom", () => {
  it("marks the member gone and reports the room's status", async () => {
    await store.createSession(session({
      members: [member(), member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b" })],
    }));

    const r = await leaveRoom(store, peer, "qs_test", "m_peer");

    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.sessionStatus).toBe("active");
    const after = await store.getSession("qs_test");
    expect(after?.members.find((m) => m.memberId === "m_peer")?.leftAt).toEqual(expect.any(Number));
  });

  it("refuses a handle that belongs to someone else", async () => {
    await store.createSession(session({
      members: [member(), member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b" })],
    }));

    const r = await leaveRoom(store, jesse, "qs_test", "m_peer");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("forbidden");
  });

  it("closes the room when the last active member leaves", async () => {
    await store.createSession(session({ members: [member()] }));

    const r = await leaveRoom(store, jesse, "qs_test", "m_creator");

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sessionStatus).toBe("closed");
  });

  it("reports not_found for a room that does not exist", async () => {
    const r = await leaveRoom(store, jesse, "qs_ghost", "m_creator");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("not_found");
  });

  // Closed wins over frozen. With nobody left to thaw the room for, "frozen"
  // would point the leaver at paying to fix something payment will not fix.
  it("reports the room closed, not frozen, when the last member leaves a frozen room", async () => {
    await store.createSession(session({ members: [member()], frozenAt: Date.now() }));

    const r = await leaveRoom(store, jesse, "qs_test", "m_creator");

    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.sessionStatus).toBe("closed");
  });

  it("announces and audits nothing more when a completed leave is repeated", async () => {
    await store.createSession(session({
      members: [member(), member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b" })],
    }));

    await leaveRoom(store, peer, "qs_test", "m_peer");
    const again = await leaveRoom(store, peer, "qs_test", "m_peer");

    expect(again.ok, JSON.stringify(again)).toBe(true);
    const events = await store.eventsAfter("qs_test", 0);
    expect(events.filter((e) => e.type === "member_left")).toHaveLength(1);
    const rows = await store.auditForOrg("org_codenerd", 50);
    expect(rows.filter((a) => a.action === "member_left")).toHaveLength(1);
  });

  // A leave that died after announcing and auditing, and before closing, leaves
  // the room empty but open. The retry is how it heals, and it has to heal
  // without saying the departure a second time: that is what the early return
  // is there to prevent.
  it("closes a room a half-completed leave left empty, without announcing again", async () => {
    await store.createSession(session({ members: [member({ leftAt: Date.now() })] }));
    const before = (await store.getSession("qs_test"))!;
    await store.appendEvent("qs_test", {
      type: "member_left", fromMemberId: "m_creator", fromUserId: "u_jesse",
      fromLabel: "jesse@codenerd", payload: { label: "jesse@codenerd" }, refId: null,
    });
    await audit(store, before, jesse, "member_left", {});
    const eventsBefore = await store.eventsAfter("qs_test", 0);
    const auditBefore = await store.auditForOrg("org_codenerd", 50);
    expect(before.closed, "setup: the room should still be open").toBe(false);
    expect(activeMembers(before), "setup: nobody should be in it").toHaveLength(0);
    expect(eventsBefore, "setup: the departure should already be announced").toHaveLength(1);
    expect(auditBefore, "setup: the departure should already be audited").toHaveLength(1);

    const r = await leaveRoom(store, jesse, "qs_test", "m_creator");

    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.sessionStatus).toBe("closed");
    expect((await store.getSession("qs_test"))?.closed).toBe(true);
    expect(await store.eventsAfter("qs_test", 0)).toEqual(eventsBefore);
    expect(await store.auditForOrg("org_codenerd", 50)).toEqual(auditBefore);
  });

  // The departure is a fact from the moment it is recorded, so its audit row is
  // written then and not behind the room's closing. A leave that dies at the
  // close keeps its record, which the retry has no way to write; all the retry
  // has to do is finish the close. This builds that state by failing the real
  // close, where the case above builds it by hand.
  it("keeps the audit row of a leave that failed at the close, and the retry finishes closing", async () => {
    await store.createSession(session({ members: [member()] }));
    vi.spyOn(store, "closeSession").mockRejectedValueOnce(new Error("close failed"));

    await expect(leaveRoom(store, jesse, "qs_test", "m_creator")).rejects.toThrow("close failed");

    const afterFailure = await store.auditForOrg("org_codenerd", 50);
    expect(afterFailure.filter((a) => a.action === "member_left")).toHaveLength(1);
    expect((await store.getSession("qs_test"))?.closed, "the failed close leaves the room open").toBe(false);

    const retry = await leaveRoom(store, jesse, "qs_test", "m_creator");

    expect(retry.ok, JSON.stringify(retry)).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.sessionStatus).toBe("closed");
    expect((await store.getSession("qs_test"))?.closed).toBe(true);
    const events = await store.eventsAfter("qs_test", 0);
    expect(events.filter((e) => e.type === "member_left")).toHaveLength(1);
    const rows = await store.auditForOrg("org_codenerd", 50);
    expect(rows.filter((a) => a.action === "member_left")).toHaveLength(1);
  });

  // The other edge of the same repair: a departed member repeating the call must
  // never close a room that the members still in it are using.
  it("leaves the room open for the members still in it when a departed member leaves again", async () => {
    await store.createSession(session({
      members: [
        member(),
        member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b", leftAt: Date.now() }),
      ],
    }));

    const r = await leaveRoom(store, peer, "qs_test", "m_peer");

    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.sessionStatus).toBe("active");
    expect((await store.getSession("qs_test"))?.closed).toBe(false);
  });
});

describe("issueInvite", () => {
  it("mints a code for the room's default seat", async () => {
    // The default fixture already holds a live code for this seat, and issuing
    // would retire it. A room with none is what makes `replacedPrevious` false.
    await store.createSession(session({ maxMembers: 4, joinCodes: {} }));

    const r = await issueInvite(store, jesse, "qs_test", "m_creator");

    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.role).toBe("peer_b");
    expect(r.value.replacedPrevious).toBe(false);
    expect((await store.getSessionByJoinCode(r.value.code))?.role).toBe("peer_b");
  });

  it("refuses a role the manifest does not declare", async () => {
    await store.createSession(session({ maxMembers: 4 }));

    const r = await issueInvite(store, jesse, "qs_test", "m_creator", "scribe");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("not_found");
    expect(r.reason).toContain("declares no role");
  });

  it("refuses a full room, because the code could not be used", async () => {
    await store.createSession(session({
      maxMembers: 2,
      members: [member(), member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b" })],
    }));

    const r = await issueInvite(store, jesse, "qs_test", "m_creator");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("conflict");
  });

  it("refuses a frozen room", async () => {
    await store.createSession(session({ maxMembers: 4 }));
    await store.freezeSession("qs_test", Date.now());

    const r = await issueInvite(store, jesse, "qs_test", "m_creator");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("frozen");
  });

  // The gate answers a closed room with its own code and a missing room with
  // another, in one sentence. The sentence is the old handler's, so no MCP output
  // moves; the code is what a route switches on, and folding the closed branch
  // into "not_found" would map a closed room to the missing room's status.
  it("answers a closed room with its own code, in the missing room's sentence", async () => {
    await store.createSession(session({ closed: true }));

    const closed = await issueInvite(store, jesse, "qs_test", "m_creator");
    const missing = await issueInvite(store, jesse, "qs_ghost", "m_creator");

    expect(closed.ok).toBe(false);
    expect(missing.ok).toBe(false);
    if (closed.ok || missing.ok) return;
    expect(closed.code).toBe("closed");
    expect(missing.code).toBe("not_found");
    expect(closed.reason).toBe(missing.reason);
  });
});

describe("revokeInvite", () => {
  it("retires every live code when no role is named", async () => {
    await store.createSession(session({ maxMembers: 4 }));

    const r = await revokeInvite(store, jesse, "qs_test", "m_creator");

    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.roles).toEqual(["peer_b"]);
    expect(await store.getSessionByJoinCode("BELL-TEST-01")).toBeUndefined();
  });

  it("reports nothing retired when the only code had already expired", async () => {
    await store.createSession(session({
      maxMembers: 4,
      joinCodes: { peer_b: { code: "BELL-OLD-01", expiresAt: Date.now() - 1000 } },
    }));

    const r = await revokeInvite(store, jesse, "qs_test", "m_creator");

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.roles).toEqual([]);
  });

  // Without the guard a mistyped role retires nothing and answers { roles: [] },
  // which is also the honest answer for a role with no live code. The caller
  // cannot tell them apart, and believes a door is shut that is still open.
  it("refuses a role the manifest does not declare", async () => {
    await store.createSession(session({ maxMembers: 4 }));

    const r = await revokeInvite(store, jesse, "qs_test", "m_creator", "scribe");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("not_found");
    expect(r.reason).toContain("declares no role");
  });
});
