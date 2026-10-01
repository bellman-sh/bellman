import { beforeEach, describe, expect, it } from "vitest";
import { member, session } from "./helpers/fixtures.js";
import { MemoryStore } from "../src/store.js";
import { leaveRoom } from "../src/rooms.js";
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
    expect(after?.members.find((m) => m.memberId === "m_peer")?.leftAt).not.toBeNull();
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

  it("announces and audits a departure once, however often the call is repeated", async () => {
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
});
