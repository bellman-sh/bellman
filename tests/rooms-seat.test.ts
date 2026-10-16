/**
 * The seat rule a reader of a room shares between the HTTP routes and
 * bellman_surface (canvas spec D2): which handles are the caller's, and where a
 * person whose every handle was removed stops reading (#113).
 */
import { describe, it, expect } from "vitest";
import { cutAtFor, cutFor, handlesOf } from "../src/rooms.js";
import { MemoryStore } from "../src/store.js";
import { member, session } from "./helpers/fixtures.js";

const me = { userId: "u_me" };

describe("handlesOf", () => {
  it("returns every handle the identity has held, in join order, one that left included, and none for a stranger", async () => {
    const store = new MemoryStore();
    const s = session({ members: [
      member({ memberId: "m_a", userId: "u_me" }),
      member({ memberId: "m_b", userId: "u_other" }),
      member({ memberId: "m_c", userId: "u_me" }),
    ] });
    await store.createSession(s);
    // Gone from the session's roster (ADR 0019), and still this person's handle.
    await store.updateMember(s.id, "m_a", { leftAt: 50 });
    expect((await handlesOf(store, s, me)).map((m) => m.memberId)).toEqual(["m_a", "m_c"]);
    expect(await handlesOf(store, s, { userId: "u_nobody" })).toEqual([]);
  });
});

describe("cutFor and cutAtFor", () => {
  it("is undefined while any handle is still in the room or left on its own", () => {
    const active = member({ memberId: "m_a", userId: "u_me" });
    const removed = member({ memberId: "m_b", userId: "u_me", leftAt: 50, removedAtCursor: 7 });
    expect(cutFor([active, removed])).toBeUndefined();
    expect(cutAtFor([active, removed])).toBeUndefined();
    const left = member({ memberId: "m_c", userId: "u_me", leftAt: 60 });
    expect(cutFor([left, removed])).toBeUndefined();
  });

  it("is the latest removal's cursor, and its moment, once every handle was removed", () => {
    const first = member({ memberId: "m_a", userId: "u_me", leftAt: 50, removedAtCursor: 7 });
    const later = member({ memberId: "m_b", userId: "u_me", leftAt: 90, removedAtCursor: 12 });
    expect(cutFor([first, later])).toBe(12);
    expect(cutAtFor([first, later])).toBe(90);
  });
});
