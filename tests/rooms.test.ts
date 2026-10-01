import { beforeEach, describe, expect, it, vi } from "vitest";
import { member, session } from "./helpers/fixtures.js";
import { MemoryStore } from "../src/store.js";
import { activeMembers, audit, evictMember, issueInvite, leaveRoom, revokeInvite } from "../src/rooms.js";
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

  // The gate's membership checks. Through MCP, neither is pinned: with the first
  // removed the call does not refuse, it throws on the missing member, and the
  // cases there assert only that an error came back; with the second removed a
  // member who has left mints codes freely, and nothing asks.
  it("refuses a handle that belongs to someone else", async () => {
    await store.createSession(session({ maxMembers: 4 }));

    const r = await issueInvite(store, peer, "qs_test", "m_creator");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("forbidden");
  });

  it("refuses a member who has left the room", async () => {
    await store.createSession(session({
      maxMembers: 4,
      members: [
        member({ leftAt: Date.now() }),
        member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b" }),
      ],
    }));

    const r = await issueInvite(store, jesse, "qs_test", "m_creator");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("forbidden");
  });

  // Frozen between the gate's read and the write: the store refuses the code, and
  // nothing may be announced or audited for a code that was never set.
  it("announces and audits nothing when the store refuses the code", async () => {
    await store.createSession(session({ maxMembers: 4 }));
    vi.spyOn(store, "setJoinCode").mockResolvedValueOnce(false);

    const r = await issueInvite(store, jesse, "qs_test", "m_creator");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("frozen");
    const events = await store.eventsAfter("qs_test", 0);
    expect(events.filter((e) => e.type === "invite_issued")).toHaveLength(0);
    const rows = await store.auditForOrg("org_codenerd", 50);
    expect(rows.filter((a) => a.action === "invite_issued")).toHaveLength(0);
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

  // Issuing is also refused by the store while frozen, so its case passes with the
  // gate's check removed. Retiring a code has no such backstop in either store:
  // only the gate keeps a frozen room's codes where they are.
  it("refuses a frozen room, and retires nothing", async () => {
    await store.createSession(session({ maxMembers: 4 }));
    await store.freezeSession("qs_test", Date.now());

    const r = await revokeInvite(store, jesse, "qs_test", "m_creator");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("frozen");
    expect((await store.getSessionByJoinCode("BELL-TEST-01"))?.role).toBe("peer_b");
  });
});

describe("evictMember", () => {
  /** A room with the creator and one peer, both active. */
  const peopled = () => session({
    maxMembers: 4,
    members: [member(), member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b" })],
  });

  it("removes the member, retires their seat's code, and says so", async () => {
    await store.createSession(peopled());

    const r = await evictMember(store, jesse, "qs_test", "m_peer");

    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.codeRetired).toBe("peer_b");
    expect(r.value.sessionStatus).toBe("active");

    const after = await store.getSession("qs_test");
    expect(after?.members.find((m) => m.memberId === "m_peer")?.leftAt).not.toBeNull();
    expect(await store.getSessionByJoinCode("BELL-TEST-01")).toBeUndefined();

    const types = (await store.eventsAfter("qs_test", 0)).map((e) => e.type);
    expect(types).toEqual(["member_evicted", "invite_revoked"]);
  });

  it("attributes the eviction to the creator, from the system handle", async () => {
    await store.createSession(peopled());

    await evictMember(store, jesse, "qs_test", "m_peer");

    const [evicted] = await store.eventsAfter("qs_test", 0);
    expect(evicted.fromMemberId).toBe("system");
    expect(evicted.fromUserId).toBe("u_jesse");
    expect(evicted.payload).toMatchObject({ member_id: "m_peer", room_role: "peer_b" });
  });

  it("refuses a member who is not the creator, whatever verbs their seat holds", async () => {
    await store.createSession(peopled());

    const r = await evictMember(store, peer, "qs_test", "m_creator");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("forbidden");
  });

  it("refuses an org admin who did not create the room", async () => {
    // jesse is role: "admin" on org_codenerd. The room is someone else's.
    await store.createSession(session({
      createdBy: "u_peer",
      members: [member({ memberId: "m_owner", userId: "u_peer" }),
                member({ memberId: "m_mine", userId: "u_jesse", roomRole: "peer_b" })],
    }));

    const r = await evictMember(store, jesse, "qs_test", "m_owner");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("forbidden");
  });

  /** REVIEW FOCUS 2 — memberId is per connection; the rule is on userId. */
  it("refuses a creator evicting their own second handle", async () => {
    await store.createSession(session({
      maxMembers: 4,
      members: [member(), member({ memberId: "m_laptop", userId: "u_jesse", roomRole: "peer_b" })],
    }));

    const r = await evictMember(store, jesse, "qs_test", "m_laptop");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("forbidden");
    expect(r.reason).toContain("bellman_leave");
  });

  /** REVIEW FOCUS 3 — authority is on createdBy, not on holding a live seat. */
  it("lets a creator who already left evict someone", async () => {
    await store.createSession(session({
      maxMembers: 4,
      members: [member({ leftAt: Date.now() }),
                member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b" })],
    }));

    const r = await evictMember(store, jesse, "qs_test", "m_peer");

    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  /** REVIEW FOCUS 4 — one handle out, the room stays in their listing. */
  it("leaves a member's other handle, and their joined listing, intact", async () => {
    await store.createSession(session({ maxMembers: 4, members: [member()] }));
    await store.addMember("qs_test", member({ memberId: "m_a", userId: "u_peer", roomRole: "peer_b" }));
    await store.addMember("qs_test", member({ memberId: "m_b", userId: "u_peer", roomRole: "peer_b" }));

    await evictMember(store, jesse, "qs_test", "m_a");

    const after = await store.getSession("qs_test");
    expect(after?.members.find((m) => m.memberId === "m_b")?.leftAt).toBeNull();
    expect(await store.sessionsJoinedBy("u_peer", 10)).toEqual(["qs_test"]);
  });

  // The early return heals, it does not merely return.
  it("closes a room an interrupted eviction left empty and open", async () => {
    // The state an eviction that died between updateMember and the close
    // leaves behind: the target is out, nobody is active, the room is open.
    await store.createSession(session({
      maxMembers: 4,
      members: [member({ leftAt: Date.now() }),
                member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b", leftAt: Date.now() })],
    }));

    const r = await evictMember(store, jesse, "qs_test", "m_peer");

    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.sessionStatus).toBe("closed");
    expect((await store.getSession("qs_test"))?.closed).toBe(true);
    // The heal restores the closing and nothing else.
    expect(await store.eventsAfter("qs_test", 0)).toEqual([]);
  });

  it("succeeds and writes nothing for a member who already left", async () => {
    await store.createSession(session({
      maxMembers: 4,
      members: [member(),
                member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b", leftAt: Date.now() })],
    }));

    const r = await evictMember(store, jesse, "qs_test", "m_peer");

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.codeRetired).toBeNull();
    expect(await store.eventsAfter("qs_test", 0)).toEqual([]);
  });

  it("retires nothing when the seat's code had already expired", async () => {
    await store.createSession(session({
      maxMembers: 4,
      joinCodes: { peer_b: { code: "BELL-OLD-01", expiresAt: Date.now() - 1000 } },
      members: [member(), member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b" })],
    }));

    const r = await evictMember(store, jesse, "qs_test", "m_peer");

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.codeRetired).toBeNull();
    expect((await store.eventsAfter("qs_test", 0)).map((e) => e.type)).toEqual(["member_evicted"]);
  });

  it("closes the room when the evicted member was the last active one", async () => {
    await store.createSession(session({
      maxMembers: 4,
      members: [member({ leftAt: Date.now() }),
                member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b" })],
    }));

    const r = await evictMember(store, jesse, "qs_test", "m_peer");

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sessionStatus).toBe("closed");
  });

  it("refuses a frozen room", async () => {
    await store.createSession(peopled());
    await store.freezeSession("qs_test", Date.now());

    const r = await evictMember(store, jesse, "qs_test", "m_peer");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("frozen");
  });

  /**
   * REVIEW FOCUS 1 — a freeze landing between the guard and the append.
   *
   * appendEvent returns null once frozen and the member is already out, so the
   * operation completes rather than throwing: an announced removal that did
   * not happen would be worse than a removal that was not announced.
   */
  it("completes when the room freezes after the member was removed", async () => {
    await store.createSession(peopled());
    const real = store.updateMember.bind(store);
    store.updateMember = async (sid, mid, patch) => {
      await real(sid, mid, patch);
      await store.freezeSession(sid, Date.now());
    };

    const r = await evictMember(store, jesse, "qs_test", "m_peer");

    expect(r.ok, JSON.stringify(r)).toBe(true);
    const after = await store.getSession("qs_test");
    expect(after?.members.find((m) => m.memberId === "m_peer")?.leftAt).not.toBeNull();
  });

  it("reports not_found for a member_id nobody in the room holds", async () => {
    await store.createSession(peopled());

    const r = await evictMember(store, jesse, "qs_test", "m_ghost");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("not_found");
  });

  // Without the guard a missing room does not refuse, it throws reading `closed`
  // off nothing, and a route would answer 500 for what is an ordinary outcome.
  it("reports not_found for a room that does not exist", async () => {
    const r = await evictMember(store, jesse, "qs_ghost", "m_peer");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("not_found");
  });

  // Every operation that refuses a closed room answers "closed", through the gate
  // or not, so a route can tell it from a room that never existed. With the guard
  // gone a closed room is edited anyway.
  it("answers a closed room with its own code, and removes nobody", async () => {
    await store.createSession({ ...peopled(), closed: true });

    const r = await evictMember(store, jesse, "qs_test", "m_peer");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("closed");
    const after = await store.getSession("qs_test");
    expect(after?.members.find((m) => m.memberId === "m_peer")?.leftAt).toBeNull();
  });

  // The join that fills a room clears every code, so a seat with no code at all
  // is the ordinary state for the member who filled it, not an edge. The cases
  // above never reach it: their room always holds a live code or an expired one.
  // Without the check on `rec`, reading its expiry throws before anything is
  // removed, and nobody who joined a full pair room could be evicted.
  it("evicts a member whose seat holds no code at all", async () => {
    await store.createSession(session({
      maxMembers: 4,
      joinCodes: {},
      members: [member(), member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b" })],
    }));

    const r = await evictMember(store, jesse, "qs_test", "m_peer");

    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ evicted: true, codeRetired: null, sessionStatus: "active" });
    expect((await store.eventsAfter("qs_test", 0)).map((e) => e.type)).toEqual(["member_evicted"]);
    const rows = await store.auditForOrg("org_codenerd", 50);
    expect(rows.map((a) => a.detail)).toEqual([
      { member_id: "m_peer", room_role: "peer_b", code_retired: false },
    ]);
  });

  // `leftAt` is the commit point: once it is set a retry takes the early return,
  // which retires nothing. So the door is shut first, and a failure to shut it
  // must leave the member in, where a retry starts from the beginning. The other
  // order leaves them out with the door open, and no retry can reach it.
  it("leaves the member in when the door could not be shut, so a retry can finish", async () => {
    await store.createSession(peopled());
    vi.spyOn(store, "consumeJoinCode").mockRejectedValueOnce(new Error("consume failed"));

    await expect(evictMember(store, jesse, "qs_test", "m_peer")).rejects.toThrow("consume failed");

    const mid = await store.getSession("qs_test");
    expect(mid?.members.find((m) => m.memberId === "m_peer")?.leftAt).toBeNull();

    const retry = await evictMember(store, jesse, "qs_test", "m_peer");

    expect(retry.ok, JSON.stringify(retry)).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.codeRetired).toBe("peer_b");
    const after = await store.getSession("qs_test");
    expect(after?.members.find((m) => m.memberId === "m_peer")?.leftAt).not.toBeNull();
    expect(await store.getSessionByJoinCode("BELL-TEST-01")).toBeUndefined();
  });

  // The other half of the same order: a removal that dies after the door shut
  // leaves the member in and the door closed, which over-revokes and is
  // recoverable. What the retry records of the retirement is not asserted: it
  // finds the code already gone, so the record is thin, and that is accepted.
  it("finishes the eviction on a retry when it died after shutting the door", async () => {
    await store.createSession(peopled());
    vi.spyOn(store, "updateMember").mockRejectedValueOnce(new Error("update failed"));

    await expect(evictMember(store, jesse, "qs_test", "m_peer")).rejects.toThrow("update failed");

    const mid = await store.getSession("qs_test");
    expect(mid?.members.find((m) => m.memberId === "m_peer")?.leftAt).toBeNull();
    expect(await store.getSessionByJoinCode("BELL-TEST-01"), "the door is already shut").toBeUndefined();

    const retry = await evictMember(store, jesse, "qs_test", "m_peer");

    expect(retry.ok, JSON.stringify(retry)).toBe(true);
    const after = await store.getSession("qs_test");
    expect(after?.members.find((m) => m.memberId === "m_peer")?.leftAt).not.toBeNull();
    expect(await store.getSessionByJoinCode("BELL-TEST-01")).toBeUndefined();
  });

  // Labels are distinct here, because the fixture gives everyone the creator's
  // and an event that named the wrong person would otherwise read as right.
  it("names the creator on the events and the evicted member in the payload", async () => {
    await store.createSession(session({
      maxMembers: 4,
      members: [member(),
                member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b" })],
    }));

    await evictMember(store, jesse, "qs_test", "m_peer");

    const [evicted, revoked] = await store.eventsAfter("qs_test", 0);
    expect(evicted.fromLabel).toBe("jesse@codenerd");
    expect(evicted.payload).toEqual({ member_id: "m_peer", label: "peer@codenerd", room_role: "peer_b" });
    expect(revoked.fromMemberId).toBe("system");
    expect(revoked.fromUserId).toBe("u_jesse");
    expect(revoked.fromLabel).toBe("jesse@codenerd");
    expect(revoked.payload).toEqual({ roles: ["peer_b"] });
  });

  it("audits the eviction, naming the member and whether a code was retired", async () => {
    await store.createSession(peopled());

    await evictMember(store, jesse, "qs_test", "m_peer");

    const rows = await store.auditForOrg("org_codenerd", 50);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "member_evicted",
      sessionId: "qs_test",
      actorUserId: "u_jesse",
      detail: { member_id: "m_peer", room_role: "peer_b", code_retired: true },
    });
  });

  // The eviction is a fact from updateMember on, so its audit row is written then
  // and not behind the closing: an eviction that dies at the close keeps its
  // record, which the retry has no way to write. This builds that state by
  // failing the real close.
  it("keeps the audit row of an eviction that failed at the close, and the retry finishes closing", async () => {
    await store.createSession(session({
      maxMembers: 4,
      members: [member({ leftAt: Date.now() }),
                member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b" })],
    }));
    vi.spyOn(store, "closeSession").mockRejectedValueOnce(new Error("close failed"));

    await expect(evictMember(store, jesse, "qs_test", "m_peer")).rejects.toThrow("close failed");

    const afterFailure = await store.auditForOrg("org_codenerd", 50);
    expect(afterFailure.filter((a) => a.action === "member_evicted")).toHaveLength(1);
    expect((await store.getSession("qs_test"))?.closed, "the failed close leaves the room open").toBe(false);

    const retry = await evictMember(store, jesse, "qs_test", "m_peer");

    expect(retry.ok, JSON.stringify(retry)).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.sessionStatus).toBe("closed");
    expect((await store.getSession("qs_test"))?.closed).toBe(true);
    const events = await store.eventsAfter("qs_test", 0);
    expect(events.filter((e) => e.type === "member_evicted")).toHaveLength(1);
    const rows = await store.auditForOrg("org_codenerd", 50);
    expect(rows.filter((a) => a.action === "member_evicted")).toHaveLength(1);
  });

  // The member is out whoever put them there, so a repeat answers "evicted" too,
  // and says nothing and records nothing more.
  it("announces and audits nothing more when a completed eviction is repeated", async () => {
    await store.createSession(peopled());

    const first = await evictMember(store, jesse, "qs_test", "m_peer");
    const again = await evictMember(store, jesse, "qs_test", "m_peer");

    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(again.ok, JSON.stringify(again)).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(first.value).toEqual({ evicted: true, codeRetired: "peer_b", sessionStatus: "active" });
    expect(again.value).toEqual({ evicted: true, codeRetired: null, sessionStatus: "active" });
    const events = await store.eventsAfter("qs_test", 0);
    expect(events.map((e) => e.type)).toEqual(["member_evicted", "invite_revoked"]);
    const rows = await store.auditForOrg("org_codenerd", 50);
    expect(rows.filter((a) => a.action === "member_evicted")).toHaveLength(1);
  });

  // An eviction touches the evicted member's org, which need be neither the room's
  // nor the creator's, so a log that wrote only those two would leave that org with
  // no record that one of its members lost access to a room. A leave never has the
  // gap: the actor there is the member, so their own org is already written.
  it("audits a cross-org eviction in the evicted member's org too", async () => {
    await store.createSession(session({
      maxMembers: 4,
      members: [member(),
                member({ memberId: "m_peer", userId: "u_peer", orgId: "org_other", roomRole: "peer_b" })],
    }));

    await evictMember(store, jesse, "qs_test", "m_peer");

    const theirs = await store.auditForOrg("org_other", 50);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]).toMatchObject({
      action: "member_evicted",
      sessionId: "qs_test",
      actorUserId: "u_jesse",
      detail: { member_id: "m_peer", room_role: "peer_b", code_retired: true },
    });
    const ours = await store.auditForOrg("org_codenerd", 50);
    expect(ours.filter((a) => a.action === "member_evicted")).toHaveLength(1);
  });

  // The extra org is a union, not an addition: an evicted member in the room's own
  // org still writes the one row it always did.
  it("writes one audit row, not two, when the evicted member is in the room's own org", async () => {
    await store.createSession(peopled());
    const written = vi.spyOn(store, "appendAudit");

    await evictMember(store, jesse, "qs_test", "m_peer");

    expect(written.mock.calls.map(([entry]) => entry.orgId)).toEqual(["org_codenerd"]);
  });

  // A member with no org has no audit stream to write to, so naming theirs adds
  // nothing; the room's row is still written.
  it("writes no extra audit row for an evicted member who belongs to no org", async () => {
    await store.createSession(session({
      maxMembers: 4,
      members: [member(),
                member({ memberId: "m_peer", userId: "u_peer", orgId: null, roomRole: "peer_b" })],
    }));
    const written = vi.spyOn(store, "appendAudit");

    await evictMember(store, jesse, "qs_test", "m_peer");

    expect(written.mock.calls.map(([entry]) => entry.orgId)).toEqual(["org_codenerd"]);
  });
});

// The helper's org set, driven directly: the room's, the actor's and any extras the
// caller names, one row per distinct org and none for an org-less one.
describe("audit", () => {
  it("writes one row per distinct org among the room's, the actor's and the extras", async () => {
    const room = session({ orgId: "org_room" });
    const written = vi.spyOn(store, "appendAudit");

    // org_other is new, org_room repeats the room's, and null has no stream.
    await audit(store, room, jesse, "probe", {}, ["org_other", "org_room", null]);

    expect(written.mock.calls.map(([entry]) => entry.orgId).sort())
      .toEqual(["org_codenerd", "org_other", "org_room"]);
  });

  // What every caller that names no extra org relies on: the room's and the actor's,
  // exactly as before the parameter existed.
  it("writes only the room's and the actor's rows when no extra org is named", async () => {
    const room = session({ orgId: "org_room" });
    const written = vi.spyOn(store, "appendAudit");

    await audit(store, room, jesse, "probe", {});

    expect(written.mock.calls.map(([entry]) => entry.orgId).sort()).toEqual(["org_codenerd", "org_room"]);
  });
});
