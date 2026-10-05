import { beforeEach, describe, expect, it, vi } from "vitest";
import { manifestFixture, member, oneCode, session } from "./helpers/fixtures.js";
import { resolveManifest } from "../src/manifest.js";
import { MemoryStore } from "../src/store.js";
import { activeMembers, audit, evictMember, issueInvite, leaveRoom, revokeInvite } from "../src/rooms.js";
import type { Identity, Member } from "../src/types.js";

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

/**
 * Seat `joiner` at the last moment before the room is closed: after whatever
 * the operation read to decide it was empty, and before the write that closes
 * it. That is the window the read-then-close shape left open, and a test cannot
 * land a join in it any other way, because MemoryStore never yields in the
 * middle of one of its methods.
 *
 * Both close methods are wrapped, and that is deliberate. Which one an operation
 * calls is what these tests are about: wrap only the conditional close and an
 * operation that went back to reading the roster and calling closeSession would
 * never meet the join, and pass.
 */
function joinJustBeforeClose(joiner: Member): void {
  const closeSession = store.closeSession.bind(store);
  vi.spyOn(store, "closeSession").mockImplementation(async (id) => {
    await store.addMember(id, joiner);
    await closeSession(id);
  });
  const closeSessionIfEmpty = store.closeSessionIfEmpty.bind(store);
  vi.spyOn(store, "closeSessionIfEmpty").mockImplementation(async (id) => {
    await store.addMember(id, joiner);
    return closeSessionIfEmpty(id);
  });
}

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
  // without saying the departure a second time: that is what the store's
  // idempotent path is there to prevent.
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
    vi.spyOn(store, "closeSessionIfEmpty").mockRejectedValueOnce(new Error("close failed"));

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

  // The close is decided where it is written. A member who joins after the leave
  // has seen an empty room and before the close lands has to be left in an open
  // room: closing over them lists someone in a room that is over, and retires
  // the code they came in by. A leave that reads the room and then closes it
  // fails this test, because the join lands in the gap between the two.
  it("leaves the room open when a member joins at the last moment before the close", async () => {
    await store.createSession(session({ maxMembers: 3, members: [member()] }));
    joinJustBeforeClose(member({ memberId: "m_late", userId: "u_peer", roomRole: "peer_b" }));

    const r = await leaveRoom(store, jesse, "qs_test", "m_creator");

    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.sessionStatus).toBe("active");
    const after = (await store.getSession("qs_test"))!;
    expect(after.closed, "closed over the member who had just joined").toBe(false);
    expect(activeMembers(after).map((m) => m.memberId)).toEqual(["m_late"]);
    expect(await store.getSessionByJoinCode("BELL-TEST-01"), "the door they came in by").toBeDefined();
  });

  // The retry path reaches the same closing from a different place: a departed
  // member's repeated leave heals a room an interrupted leave left empty and
  // open. It is a second caller of the same function, and the one a copy of the
  // old shape could hide in, because nothing else on it looks like a race.
  it("leaves the room open when a member joins before the close a retried leave would make", async () => {
    await store.createSession(session({ maxMembers: 3, members: [member({ leftAt: Date.now() })] }));
    joinJustBeforeClose(member({ memberId: "m_late", userId: "u_peer", roomRole: "peer_b" }));

    const r = await leaveRoom(store, jesse, "qs_test", "m_creator");

    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.sessionStatus).toBe("active");
    const after = (await store.getSession("qs_test"))!;
    expect(after.closed, "closed over the member who had just joined").toBe(false);
    expect(activeMembers(after).map((m) => m.memberId)).toEqual(["m_late"]);
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
    // Not "not_found": the room was found, and it is the request that is wrong.
    // See unknownRole.
    expect(r.code).toBe("invalid");
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

  // The other side of that gap: the freeze lands after the code is set. The door
  // is open and stays open, and nobody is told, because a frozen room takes no
  // event. Tolerated rather than unwound, as an eviction's announcement is, and
  // the tool's description says the event can be absent for this reason.
  it("completes, unannounced, when the room freezes after the code was set", async () => {
    await store.createSession(session({ maxMembers: 4 }));
    const setJoinCode = store.setJoinCode.bind(store);
    store.setJoinCode = async (sessionId, role, code, expiresAt) => {
      const set = await setJoinCode(sessionId, role, code, expiresAt);
      await store.freezeSession(sessionId, Date.now());
      return set;
    };

    const r = await issueInvite(store, jesse, "qs_test", "m_creator");

    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect((await store.getSession("qs_test"))?.joinCodes[r.value.role]?.code).toBe(r.value.code);
    const events = await store.eventsAfter("qs_test", 0);
    expect(events.filter((e) => e.type === "invite_issued")).toHaveLength(0);
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
    // Not "not_found": the room was found, and it is the request that is wrong.
    // See unknownRole.
    expect(r.code).toBe("invalid");
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

  // The same gap from the other side: the freeze lands after the code is retired.
  // The door is shut and stays shut, and nobody is told.
  it("completes, unannounced, when the room freezes after the code was retired", async () => {
    await store.createSession(session({ maxMembers: 4 }));
    const consumeJoinCode = store.consumeJoinCode.bind(store);
    store.consumeJoinCode = async (sessionId, role) => {
      await consumeJoinCode(sessionId, role);
      await store.freezeSession(sessionId, Date.now());
    };

    const r = await revokeInvite(store, jesse, "qs_test", "m_creator", "peer_b");

    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.roles).toEqual(["peer_b"]);
    expect((await store.getSession("qs_test"))?.joinCodes).toEqual({});
    const events = await store.eventsAfter("qs_test", 0);
    expect(events.filter((e) => e.type === "invite_revoked")).toHaveLength(0);
  });
});

describe("evictMember", () => {
  /** A room with the creator and one peer, both active. */
  const peopled = () => session({
    maxMembers: 4,
    members: [member(), member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b" })],
  });

  /**
   * A swarm room: the creator, and a watcher in `observer`. The swarm's default
   * seat is `helper`, so here the target's own seat and the room's default one
   * are different, which the pair-preset rooms above cannot show. The caller
   * says which seats hold a live code.
   */
  const swarmRoom = (codes: ReturnType<typeof oneCode>, watcher: Partial<Member> = {}) => {
    const manifest = resolveManifest(manifestFixture({ preset: "swarm" }));
    return session({
      manifest,
      maxMembers: 4,
      joinCodes: codes,
      members: [member({ roomRole: manifest.creatorRole }),
                member({ memberId: "m_watcher", userId: "u_peer", label: "peer@codenerd", roomRole: "observer",
                        ...watcher })],
    });
  };

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
    expect(r.reason).toContain("cannot evict yourself");
    expect(r.reason).toContain("leave the room");
    // This module serves every transport, and a panel user cannot call an MCP
    // tool: a refusal that names one hands half its callers advice they cannot act on.
    expect(r.reason).not.toContain("bellman_");
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

  // The already-out path heals, it does not merely return.
  it("closes a room an interrupted eviction left empty and open", async () => {
    // The state an eviction that died between the removal and the close leaves
    // behind: the target is out, nobody is active, the room is open. Its door is
    // already shut, because the removal shuts it in the same transaction, so there
    // is no code here for the repeat to retire.
    await store.createSession(session({
      maxMembers: 4,
      joinCodes: {},
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
    expect(await store.auditForOrg("org_codenerd", 50)).toEqual([]);
  });

  // Nothing is owed here: the seat's door is already shut (an eviction shuts it
  // with the removal, and a room that has filled has cleared every code), so there
  // is nothing to retire, and the removal was already said once.
  it("succeeds and writes nothing for a member who already left, when their seat's door is already shut", async () => {
    await store.createSession(session({
      maxMembers: 4,
      joinCodes: {},
      members: [member(),
                member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b", leftAt: Date.now() })],
    }));

    const r = await evictMember(store, jesse, "qs_test", "m_peer");

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ evicted: true, codeRetired: null, sessionStatus: "active" });
    expect(await store.eventsAfter("qs_test", 0)).toEqual([]);
    expect(await store.auditForOrg("org_codenerd", 50)).toEqual([]);
  });

  // leaveRoom retires no code, so a member who left on their own leaves their seat's
  // code live and the seat free, and whoever holds the code walks back in. Evicting
  // them is how the creator shuts that door: an eviction that took "already out" to
  // mean nothing was owed would answer "evicted" and leave the removal to undo itself,
  // and nothing downstream could tell that from a code that had expired. The store
  // shuts the door on its already-out path, and this is the case that holds the
  // handler to asking it to. A room that has filled has cleared its codes, so this is
  // the case for rooms that are not full, swarm and hub rooms.
  it("shuts a seat's door that a leave left open, without announcing the removal again", async () => {
    await store.createSession(session({
      maxMembers: 4,
      members: [member(),
                member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b",
                        leftAt: Date.now() })],
    }));

    const r = await evictMember(store, jesse, "qs_test", "m_peer");

    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ evicted: true, codeRetired: "peer_b", sessionStatus: "active" });
    expect(await store.getSessionByJoinCode("BELL-TEST-01"), "the door is shut").toBeUndefined();
    const events = await store.eventsAfter("qs_test", 0);
    expect(events.map((e) => e.type), "the removal is not announced again").toEqual(["invite_revoked"]);
    expect(events[0]).toMatchObject({
      fromMemberId: "system", fromUserId: "u_jesse", fromLabel: "jesse@codenerd",
      payload: { roles: ["peer_b"] },
    });
    const rows = await store.auditForOrg("org_codenerd", 50);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "invite_revoked", sessionId: "qs_test", actorUserId: "u_jesse", detail: { roles: ["peer_b"] },
    });
  });

  // An invite_revoked row names a role and no person, so it goes to the room's org
  // and the creator's, as revokeInvite's does, and not to the departed member's:
  // that org could not tell whom it concerned, and a row it cannot resolve to
  // anyone is worse than none.
  it("audits the door's closing in the room's org and not the departed member's", async () => {
    await store.createSession(session({
      maxMembers: 4,
      members: [member(),
                member({ memberId: "m_peer", userId: "u_peer", orgId: "org_other", roomRole: "peer_b",
                        leftAt: Date.now() })],
    }));

    await evictMember(store, jesse, "qs_test", "m_peer");

    expect(await store.auditForOrg("org_other", 50)).toEqual([]);
    const ours = await store.auditForOrg("org_codenerd", 50);
    expect(ours.map((a) => a.action)).toEqual(["invite_revoked"]);
  });

  // The door's retirement, its announcement and its audit row are one operation, so
  // a failure leaves the door open and nothing said, which is where a retry starts.
  // An announced closing of a door that did not shut is worse than a silent one. The
  // old shape got there by ordering three calls, and the case here pinned that order;
  // with one store call what is left to hold is that the handler writes nothing of
  // its own around it.
  it("announces and audits nothing when a departed member's door could not be shut, and the retry shuts it", async () => {
    await store.createSession(session({
      maxMembers: 4,
      members: [member(),
                member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b", leftAt: Date.now() })],
    }));
    vi.spyOn(store, "removeMember").mockRejectedValueOnce(new Error("remove failed"));

    await expect(evictMember(store, jesse, "qs_test", "m_peer")).rejects.toThrow("remove failed");

    expect(await store.eventsAfter("qs_test", 0)).toEqual([]);
    expect(await store.auditForOrg("org_codenerd", 50)).toEqual([]);
    expect((await store.getSessionByJoinCode("BELL-TEST-01"))?.role, "the door is still open").toBe("peer_b");

    const retry = await evictMember(store, jesse, "qs_test", "m_peer");

    expect(retry.ok, JSON.stringify(retry)).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.codeRetired).toBe("peer_b");
    expect(await store.getSessionByJoinCode("BELL-TEST-01")).toBeUndefined();
    expect((await store.eventsAfter("qs_test", 0)).map((e) => e.type)).toEqual(["invite_revoked"]);
    expect(await store.auditForOrg("org_codenerd", 50)).toHaveLength(1);
  });

  // Retire, announce, audit, and only then close: whatever came after the close
  // would be lost, because every later call refuses on "closed". This fails the real
  // close in a room the departed member's eviction has emptied.
  it("shuts the door and keeps its record when the close fails, and the retry finishes closing", async () => {
    await store.createSession(session({
      maxMembers: 4,
      members: [member({ leftAt: Date.now() }),
                member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b", leftAt: Date.now() })],
    }));
    vi.spyOn(store, "closeSessionIfEmpty").mockRejectedValueOnce(new Error("close failed"));

    await expect(evictMember(store, jesse, "qs_test", "m_peer")).rejects.toThrow("close failed");

    expect(await store.getSessionByJoinCode("BELL-TEST-01"), "the door is shut").toBeUndefined();
    expect((await store.eventsAfter("qs_test", 0)).map((e) => e.type)).toEqual(["invite_revoked"]);
    expect(await store.auditForOrg("org_codenerd", 50)).toHaveLength(1);
    expect((await store.getSession("qs_test"))?.closed, "the failed close leaves the room open").toBe(false);

    const retry = await evictMember(store, jesse, "qs_test", "m_peer");

    expect(retry.ok, JSON.stringify(retry)).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.sessionStatus).toBe("closed");
    expect((await store.getSession("qs_test"))?.closed).toBe(true);
    expect((await store.eventsAfter("qs_test", 0)).map((e) => e.type)).toEqual(["invite_revoked"]);
    expect(await store.auditForOrg("org_codenerd", 50)).toHaveLength(1);
  });

  // The door's closing cannot repeat. It is guarded by the state, not by skipping the
  // work: once the code is gone a second eviction finds nothing to retire.
  it("writes nothing more when a departed member's door has already been shut", async () => {
    await store.createSession(session({
      maxMembers: 4,
      members: [member(),
                member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b", leftAt: Date.now() })],
    }));

    const first = await evictMember(store, jesse, "qs_test", "m_peer");
    const again = await evictMember(store, jesse, "qs_test", "m_peer");

    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(again.ok, JSON.stringify(again)).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(first.value).toEqual({ evicted: true, codeRetired: "peer_b", sessionStatus: "active" });
    expect(again.value).toEqual({ evicted: true, codeRetired: null, sessionStatus: "active" });
    expect((await store.eventsAfter("qs_test", 0)).map((e) => e.type)).toEqual(["invite_revoked"]);
    expect(await store.auditForOrg("org_codenerd", 50)).toHaveLength(1);
  });

  // An expired code is not an open door, so there is no closing to announce.
  it("retires nothing for a member who already left when the seat's code had expired", async () => {
    await store.createSession(session({
      maxMembers: 4,
      joinCodes: { peer_b: { code: "BELL-OLD-01", expiresAt: Date.now() - 1000 } },
      members: [member(),
                member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b", leftAt: Date.now() })],
    }));

    const r = await evictMember(store, jesse, "qs_test", "m_peer");

    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ evicted: true, codeRetired: null, sessionStatus: "active" });
    expect(await store.eventsAfter("qs_test", 0)).toEqual([]);
    expect(await store.auditForOrg("org_codenerd", 50)).toEqual([]);
  });

  // Every pair-preset case here seats its target in peer_b, which is also that
  // preset's default role, so none of them can tell the target's own seat from the
  // room's default one. With several seats the two differ, and an eviction that read
  // the wrong one would retire an innocent seat's code and leave the evicted member's
  // door open: the failure this operation exists to prevent, with collateral. Here
  // helper is the default seat and the watcher sits in observer.
  it("shuts only a departed member's own seat, in a room with several", async () => {
    await store.createSession(swarmRoom(
      { ...oneCode("BELL-HELPER-01", "helper"), ...oneCode("BELL-WATCH-01", "observer") },
      { leftAt: Date.now() },
    ));

    const r = await evictMember(store, jesse, "qs_test", "m_watcher");

    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ evicted: true, codeRetired: "observer", sessionStatus: "active" });
    expect(await store.getSessionByJoinCode("BELL-WATCH-01"), "the observer door is shut").toBeUndefined();
    expect((await store.getSessionByJoinCode("BELL-HELPER-01"))?.role, "the helper door is untouched").toBe("helper");
    const events = await store.eventsAfter("qs_test", 0);
    expect(events.map((e) => e.type)).toEqual(["invite_revoked"]);
    expect(events[0].payload).toEqual({ roles: ["observer"] });
    const rows = await store.auditForOrg("org_codenerd", 50);
    expect(rows.map((a) => a.detail)).toEqual([{ roles: ["observer"] }]);
  });

  // The same, for a member still in the room: every place the eviction names a seat
  // is the evicted member's, and the default seat's code is not touched.
  it("shuts only an evicted member's own seat, in a room with several", async () => {
    await store.createSession(swarmRoom(
      { ...oneCode("BELL-HELPER-01", "helper"), ...oneCode("BELL-WATCH-01", "observer") },
    ));

    const r = await evictMember(store, jesse, "qs_test", "m_watcher");

    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ evicted: true, codeRetired: "observer", sessionStatus: "active" });
    expect(await store.getSessionByJoinCode("BELL-WATCH-01"), "the observer door is shut").toBeUndefined();
    expect((await store.getSessionByJoinCode("BELL-HELPER-01"))?.role, "the helper door is untouched").toBe("helper");
    const [evicted, revoked] = await store.eventsAfter("qs_test", 0);
    expect(evicted.type).toBe("member_evicted");
    expect(evicted.payload).toEqual({ member_id: "m_watcher", label: "peer@codenerd", room_role: "observer" });
    expect(revoked.type).toBe("invite_revoked");
    expect(revoked.payload).toEqual({ roles: ["observer"] });
    // The member's row, then the door's, which names the observer seat and no other.
    const rows = await store.auditForOrg("org_codenerd", 50);
    expect(rows.map((a) => a.detail)).toEqual([
      { member_id: "m_watcher", user_id: "u_peer", room_role: "observer" },
      { roles: ["observer"] },
    ]);
  });

  // The default seat's door is open and the evicted member's seat holds no code, so
  // there is no door of theirs to shut: the default seat's must not be read as theirs,
  // announced, or retired. This is also the case that tells a lookup by the target's
  // seat from one by the room's default, which the cases above agree on.
  it("retires nothing when only another seat holds a live code", async () => {
    await store.createSession(swarmRoom(oneCode("BELL-HELPER-01", "helper")));

    const r = await evictMember(store, jesse, "qs_test", "m_watcher");

    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ evicted: true, codeRetired: null, sessionStatus: "active" });
    expect((await store.getSessionByJoinCode("BELL-HELPER-01"))?.role, "the helper door is untouched").toBe("helper");
    expect((await store.eventsAfter("qs_test", 0)).map((e) => e.type)).toEqual(["member_evicted"]);
    const rows = await store.auditForOrg("org_codenerd", 50);
    expect(rows.map((a) => a.detail)).toEqual([
      { member_id: "m_watcher", user_id: "u_peer", room_role: "observer" },
    ]);
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

  // The same window as the leave's, through the other operation that ends in the
  // closing. Both reach it through one function, so a second copy of the
  // read-then-close in either would pass the leave's test and fail this one.
  it("leaves the room open when a member joins at the last moment before the eviction would close it", async () => {
    await store.createSession(session({
      maxMembers: 4,
      members: [member({ leftAt: Date.now() }),
                member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b" })],
    }));
    joinJustBeforeClose(member({ memberId: "m_late", userId: "u_late", roomRole: "peer_b" }));

    const r = await evictMember(store, jesse, "qs_test", "m_peer");

    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.sessionStatus).toBe("active");
    const after = (await store.getSession("qs_test"))!;
    expect(after.closed, "closed over the member who had just joined").toBe(false);
    expect(activeMembers(after).map((m) => m.memberId)).toEqual(["m_late"]);
  });

  // And through the eviction's own retry path, for the reason the leave's is
  // tested above: the member is already out, so nothing is removed or announced,
  // and the only thing left to do is the closing.
  it("leaves the room open when a member joins before the close a retried eviction would make", async () => {
    await store.createSession(session({
      maxMembers: 4,
      members: [member({ leftAt: Date.now() }),
                member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b", leftAt: Date.now() })],
    }));
    joinJustBeforeClose(member({ memberId: "m_late", userId: "u_late", roomRole: "peer_b" }));

    const r = await evictMember(store, jesse, "qs_test", "m_peer");

    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.sessionStatus).toBe("active");
    const after = (await store.getSession("qs_test"))!;
    expect(after.closed, "closed over the member who had just joined").toBe(false);
    expect(activeMembers(after).map((m) => m.memberId)).toEqual(["m_late"]);
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
   * REVIEW FOCUS 1 — a freeze landing after the removal.
   *
   * The window between the guard and the write is closed: the guard and every
   * write are one store operation, and a freeze landing before it is refused (see
   * "removal as one store operation"). What is left is a freeze after it. The
   * member is out and announced by then, so nothing is unwound and the operation
   * completes: all that remains is the closing, which a frozen room allows.
   */
  it("completes when the room freezes after the member was removed", async () => {
    await store.createSession(peopled());
    const real = store.removeMember.bind(store);
    store.removeMember = async (sid, mid, req) => {
      const outcome = await real(sid, mid, req);
      await store.freezeSession(sid, Date.now());
      return outcome;
    };

    const r = await evictMember(store, jesse, "qs_test", "m_peer");

    expect(r.ok, JSON.stringify(r)).toBe(true);
    const after = await store.getSession("qs_test");
    expect(after?.frozenAt, "control: the freeze landed after the removal").not.toBeNull();
    expect(after?.members.find((m) => m.memberId === "m_peer")?.leftAt).not.toBeNull();
    expect((await store.eventsAfter("qs_test", 0)).map((e) => e.type))
      .toEqual(["member_evicted", "invite_revoked"]);
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
      { member_id: "m_peer", user_id: "u_peer", room_role: "peer_b" },
    ]);
  });

  // The member and the door are one operation, so a failure leaves both as they
  // were: never out with the door open, and never in with it shut. The old shape
  // shut the door first so that it could only fail one way, and the cases here
  // pinned that order. With one store call there is no order to pin. What is left
  // to hold is that the handler makes no write of its own around the call: a door
  // shut, or a member stamped out, ahead of a removal that then failed would
  // leave the state a retry has to pick up halfway.
  it("leaves the member in and the door open when the removal fails, so a retry can finish", async () => {
    await store.createSession(peopled());
    vi.spyOn(store, "removeMember").mockRejectedValueOnce(new Error("remove failed"));

    await expect(evictMember(store, jesse, "qs_test", "m_peer")).rejects.toThrow("remove failed");

    const mid = await store.getSession("qs_test");
    expect(mid?.members.find((m) => m.memberId === "m_peer")?.leftAt).toBeNull();
    expect((await store.getSessionByJoinCode("BELL-TEST-01"))?.role, "the door is still open").toBe("peer_b");
    expect(await store.eventsAfter("qs_test", 0)).toEqual([]);
    expect(await store.auditForOrg("org_codenerd", 50)).toEqual([]);

    const retry = await evictMember(store, jesse, "qs_test", "m_peer");

    expect(retry.ok, JSON.stringify(retry)).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.codeRetired).toBe("peer_b");
    const after = await store.getSession("qs_test");
    expect(after?.members.find((m) => m.memberId === "m_peer")?.leftAt).not.toBeNull();
    expect(await store.getSessionByJoinCode("BELL-TEST-01")).toBeUndefined();
    expect((await store.eventsAfter("qs_test", 0)).map((e) => e.type))
      .toEqual(["member_evicted", "invite_revoked"]);
    expect((await store.auditForOrg("org_codenerd", 50)).map((a) => a.action))
      .toEqual(["member_evicted", "invite_revoked"]);
  });

  // Labels are distinct here, because the fixture gives everyone the creator's
  // and an event that named the wrong person would otherwise read as right.
  it("names the creator on the eviction's event and the evicted member in its payload", async () => {
    await store.createSession(session({
      maxMembers: 4,
      members: [member(),
                member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b" })],
    }));

    await evictMember(store, jesse, "qs_test", "m_peer");

    const [evicted] = await store.eventsAfter("qs_test", 0);
    expect(evicted.fromLabel).toBe("jesse@codenerd");
    expect(evicted.payload).toEqual({ member_id: "m_peer", label: "peer@codenerd", room_role: "peer_b" });
    expect(evicted.refId, "an eviction is not a reply to anything").toBeNull();
  });

  it("announces the door's closing from the system, naming the creator and the seat", async () => {
    await store.createSession(session({
      maxMembers: 4,
      members: [member(),
                member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b" })],
    }));

    await evictMember(store, jesse, "qs_test", "m_peer");

    const [, revoked] = await store.eventsAfter("qs_test", 0);
    expect(revoked.type).toBe("invite_revoked");
    expect(revoked.fromMemberId).toBe("system");
    expect(revoked.fromUserId).toBe("u_jesse");
    expect(revoked.fromLabel).toBe("jesse@codenerd");
    expect(revoked.payload).toEqual({ roles: ["peer_b"] });
    expect(revoked.refId, "a door's closing is not a reply to anything").toBeNull();
  });

  it("audits the eviction, naming the seat and the person", async () => {
    await store.createSession(peopled());

    await evictMember(store, jesse, "qs_test", "m_peer");

    const rows = (await store.auditForOrg("org_codenerd", 50)).filter((a) => a.action === "member_evicted");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "member_evicted",
      sessionId: "qs_test",
      actorUserId: "u_jesse",
    });
    // Exactly these, and no `code_retired`. The row is built before the store says
    // whether a door shut, so a field for it would be a prediction from the read,
    // wrong whenever the door changed in between. The door has a row of its own, in
    // the next case, queued only if one shut. An exact match is what keeps the
    // prediction from coming back unnoticed.
    expect(rows[0].detail).toEqual({ member_id: "m_peer", user_id: "u_peer", room_role: "peer_b" });
  });

  // The door an eviction shuts is recorded the same way whether or not the member
  // was still in the room: an `invite_revoked` row, beside the member's when there
  // was one. So a query for the doors an eviction shut finds all of them, where a
  // field on the member's row could only describe the ones behind members this call
  // removed. The row goes to the room's org and the creator's, as revokeInvite's does.
  it("audits the door an eviction shut as a row of its own, beside the member's", async () => {
    await store.createSession(peopled());

    await evictMember(store, jesse, "qs_test", "m_peer");

    const rows = await store.auditForOrg("org_codenerd", 50);
    expect(rows.map((a) => a.action)).toEqual(["member_evicted", "invite_revoked"]);
    expect(rows[1]).toMatchObject({
      sessionId: "qs_test", actorUserId: "u_jesse", detail: { roles: ["peer_b"] },
    });
  });

  // member_id is per connection, so one person in the room twice holds two, and it
  // says which seat went. user_id says whose it was. Neither answers the other's
  // question, and an org reading its own log needs the second, because the handle
  // means nothing outside the room.
  it("audits which seat went and whose it was when one person holds two", async () => {
    await store.createSession(session({ maxMembers: 4, members: [member()] }));
    await store.addMember("qs_test", member({ memberId: "m_a", userId: "u_peer", roomRole: "peer_b" }));
    await store.addMember("qs_test", member({ memberId: "m_b", userId: "u_peer", roomRole: "peer_b" }));

    await evictMember(store, jesse, "qs_test", "m_a");

    const rows = (await store.auditForOrg("org_codenerd", 50)).filter((a) => a.action === "member_evicted");
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toMatchObject({ member_id: "m_a", user_id: "u_peer" });
  });

  // The eviction is a fact from the removal on, and its audit row is committed with
  // it rather than behind the closing: an eviction that dies at the close keeps its
  // record, which the retry has no way to write. This builds that state by failing
  // the real close.
  it("keeps the audit row of an eviction that failed at the close, and the retry finishes closing", async () => {
    await store.createSession(session({
      maxMembers: 4,
      members: [member({ leftAt: Date.now() }),
                member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b" })],
    }));
    vi.spyOn(store, "closeSessionIfEmpty").mockRejectedValueOnce(new Error("close failed"));

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

    // The detail names the person, not only the handle: member_id means nothing
    // outside the room, so without user_id this org could see that one of its
    // members was removed and not which one. Each org's row is held to the same
    // literal, because a comparison of the two rows with each other would pass for
    // any pair that agreed, and auditEntries() builds both from one object.
    const detail = { member_id: "m_peer", user_id: "u_peer", room_role: "peer_b" };
    const theirs = await store.auditForOrg("org_other", 50);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]).toMatchObject({ action: "member_evicted", sessionId: "qs_test", actorUserId: "u_jesse" });
    expect(theirs[0].detail).toEqual(detail);
    const ours = (await store.auditForOrg("org_codenerd", 50)).filter((a) => a.action === "member_evicted");
    expect(ours).toHaveLength(1);
    expect(ours[0].detail).toEqual(detail);
  });

  // The extra org is a union, not an addition: an evicted member in the room's own
  // org still writes the one row it always did.
  it("writes one audit row, not two, when the evicted member is in the room's own org", async () => {
    await store.createSession(peopled());
    // The rows reach the store as part of the removal and not through appendAudit,
    // so what is held to the rule is the list the handler hands over.
    const removal = vi.spyOn(store, "removeMember");

    await evictMember(store, jesse, "qs_test", "m_peer");

    expect(removal.mock.calls.flatMap(([, , req]) => req.audit.map((entry) => entry.orgId)))
      .toEqual(["org_codenerd"]);
  });

  // A member with no org has no audit stream to write to, so naming theirs adds
  // nothing; the room's row is still written.
  it("writes no extra audit row for an evicted member who belongs to no org", async () => {
    await store.createSession(session({
      maxMembers: 4,
      members: [member(),
                member({ memberId: "m_peer", userId: "u_peer", orgId: null, roomRole: "peer_b" })],
    }));
    // The list the handler hands over, not what the store kept: MemoryStore drops an
    // org-less row itself, so only the request shows whether the handler built one.
    const removal = vi.spyOn(store, "removeMember");

    await evictMember(store, jesse, "qs_test", "m_peer");

    expect(removal.mock.calls.flatMap(([, , req]) => req.audit.map((entry) => entry.orgId)))
      .toEqual(["org_codenerd"]);
  });
});

// A member's removal is one store operation, so each of these has a window the
// read-then-write shape left open. MemoryStore never yields inside a method, so the
// windows are opened the way joinJustBeforeClose opens the close's: by wrapping the
// read the handler makes first and landing the change straight after it.
//
// These run against MemoryStore, which records the audit rows inside removeMember.
// Under Durable Objects they ride the outbox, delivered inline after the commit or
// by the alarm, so `removed: true` does not mean "audited" there, and an audit
// assertion made at once is a MemoryStore fact. The store contract suite is where
// the two stores are held to one answer; here the rows are read as the record of
// what the handler handed over.
describe("removal as one store operation", () => {
  it("leaveRoom announces the departure from a frozen room", async () => {
    // #73. The event is how peers learn someone is gone; losing it leaves them
    // showing a member who left.
    const s = session({
      frozenAt: Date.now(),
      members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer" })],
    });
    await store.createSession(s);

    const result = await leaveRoom(store, peer, s.id, "m_peer");

    expect(result.ok).toBe(true);
    expect((await store.eventsAfter(s.id, 0)).map((e) => e.type)).toEqual(["member_left"]);
  });

  it("leaveRoom announces once when two first-time leaves race on one handle", async () => {
    // #117. Both calls read leftAt as null under the old shape, and both
    // announced and audited.
    const s = session({
      members: [member({ memberId: "m_creator" }), member({ memberId: "m_peer", userId: "u_peer" })],
    });
    await store.createSession(s);

    await Promise.all([
      leaveRoom(store, peer, s.id, "m_peer"),
      leaveRoom(store, peer, s.id, "m_peer"),
    ]);

    expect((await store.eventsAfter(s.id, 0)).filter((e) => e.type === "member_left")).toHaveLength(1);
    expect((await store.auditForOrg("org_codenerd", 10)).filter((a) => a.action === "member_left"))
      .toHaveLength(1);
  });

  // A leave from a room that has already closed has nothing left to record, and
  // answers what a repeat of the leave that closed it has always answered.
  // bellman_leave is declared idempotent, and a retry after the last member's leave
  // is how a client gets here.
  it("leaveRoom answers closed, and writes nothing, when the last member leaves twice", async () => {
    await store.createSession(session({ members: [member()] }));

    const first = await leaveRoom(store, jesse, "qs_test", "m_creator");
    const again = await leaveRoom(store, jesse, "qs_test", "m_creator");

    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(again.ok, JSON.stringify(again)).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(first.value.sessionStatus).toBe("closed");
    expect(again.value.sessionStatus).toBe("closed");
    expect((await store.eventsAfter("qs_test", 0)).filter((e) => e.type === "member_left")).toHaveLength(1);
    expect((await store.auditForOrg("org_codenerd", 10)).filter((a) => a.action === "member_left"))
      .toHaveLength(1);
  });

  it("evictMember refuses a room frozen under it, writing nothing", async () => {
    // #118. The room is open when evictMember reads it and frozen by the time it
    // writes. The guard and the write are one transaction, so the freeze cannot
    // land between them and have the removal go through against a room whose
    // writes were meant to have stopped. A room frozen from the start would not do
    // for this: the old shape refused that from its snapshot too, and the case
    // would pass on it.
    const s = session({
      joinCodes: oneCode("BELL-LIVE-01"),
      members: [
        member({ memberId: "m_creator" }),
        member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b" }),
      ],
    });
    await store.createSession(s);
    const read = store.getSession.bind(store);
    vi.spyOn(store, "getSession").mockImplementationOnce(async (id) => {
      const seen = await read(id);
      await store.freezeSession(id, Date.now());
      return seen;
    });

    const result = await evictMember(store, jesse, s.id, "m_peer");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("frozen");
    const after = (await store.getSession(s.id))!;
    expect(after.frozenAt, "control: the freeze landed after the read").not.toBeNull();
    expect(after.members.find((m) => m.memberId === "m_peer")?.leftAt).toBeNull();
    expect(after.joinCodes.peer_b, "the door is untouched").toBeDefined();
    expect(await store.eventsAfter(s.id, 0)).toEqual([]);
    expect(await store.auditForOrg("org_codenerd", 10)).toEqual([]);
  });

  it("evictMember announces the removal and the door in one operation", async () => {
    const s = session({
      joinCodes: oneCode("BELL-LIVE-01"),
      members: [
        member({ memberId: "m_creator" }),
        member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b" }),
      ],
    });
    await store.createSession(s);

    const result = await evictMember(store, jesse, s.id, "m_peer");

    expect(result.ok).toBe(true);
    expect((await store.eventsAfter(s.id, 0)).map((e) => e.type))
      .toEqual(["member_evicted", "invite_revoked"]);
  });

  // What is announced and audited follows the store's answer, and nothing the
  // handler predicted from its read. A door someone else shuts after that read is a
  // closing this call did not make: claiming it would announce a retirement twice and
  // audit one this call never made, and the member's row would have to carry a guess.
  it("evictMember claims no closing for a door that shut between its read and the removal", async () => {
    const s = session({
      joinCodes: oneCode("BELL-LIVE-01"),
      members: [
        member({ memberId: "m_creator" }),
        member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b" }),
      ],
    });
    await store.createSession(s);
    const read = store.getSession.bind(store);
    vi.spyOn(store, "getSession").mockImplementationOnce(async (id) => {
      const seen = await read(id);
      expect(seen?.joinCodes.peer_b, "control: the read saw a live door").toBeDefined();
      await store.consumeJoinCode(id, "peer_b");
      return seen;
    });

    const result = await evictMember(store, jesse, s.id, "m_peer");

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.codeRetired).toBeNull();
    expect((await store.eventsAfter(s.id, 0)).map((e) => e.type)).toEqual(["member_evicted"]);
    expect((await store.auditForOrg("org_codenerd", 10)).map((a) => a.detail))
      .toEqual([{ member_id: "m_peer", user_id: "u_peer", room_role: "peer_b" }]);
  });

  // The eviction side of #117. Both calls see the member in and the door open; the
  // store lets one of them remove, and the other lands on its idempotent path, where
  // the door is already gone. Neither the departure nor the closing is said twice,
  // and the loser does not claim a retirement it did not make.
  it("evictMember announces once when two evictions race on one member", async () => {
    const s = session({
      joinCodes: oneCode("BELL-LIVE-01"),
      members: [
        member({ memberId: "m_creator" }),
        member({ memberId: "m_peer", userId: "u_peer", roomRole: "peer_b" }),
      ],
    });
    await store.createSession(s);

    const results = await Promise.all([
      evictMember(store, jesse, s.id, "m_peer"),
      evictMember(store, jesse, s.id, "m_peer"),
    ]);

    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect((await store.eventsAfter(s.id, 0)).map((e) => e.type))
      .toEqual(["member_evicted", "invite_revoked"]);
    expect((await store.auditForOrg("org_codenerd", 10)).map((a) => a.action))
      .toEqual(["member_evicted", "invite_revoked"]);
    const retiring = results.filter((r) => r.ok && r.value.codeRetired !== null);
    expect(retiring, "exactly one call retired the door").toHaveLength(1);
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
