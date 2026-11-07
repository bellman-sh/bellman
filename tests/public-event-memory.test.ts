/**
 * The memory rule for `fs` events (ADR 0047, decision 7): a peer is handed an account's room-note events only when
 * the account has turned on notes sharing for the room (`shared`) and every seat the account holds grants
 * read_context, or, holding none, every seat it held granted when it left. Its own account always is; the room socket
 * (a null reader) and the public page never are. No path passes `shared` yet (#538 stopgap), so every path hides.
 */
import { describe, expect, it } from "vitest";
import {
  isMemoryEvent, isMemoryPath, memoryAuthors, publicReadEvent, readableEvent, readableEvents, seesMemory,
} from "../src/public-event.js";
import { eventsFor } from "../src/rooms.js";
import { MemoryStore } from "../src/store.js";
import type { Capability, Member, SessionEvent } from "../src/types.js";
import { member, session } from "./helpers/fixtures.js";

const GRANT: Capability[] = ["read_context", "receive_messages"];
const KEEP: Capability[] = ["receive_messages"];
const seat = (capabilities: Capability[], leftAt: number | null = null) => ({ capabilities, leftAt });

const fsEvent = (path: string, fromUserId = "u_owner", fromMemberId = "m_owner"): SessionEvent => ({
  cursor: 7, type: "fs", fromMemberId, fromUserId, fromLabel: "owner", refId: null, at: 1,
  payload: { path, rev: 1, size: 3, op: "write" },
});
const MEMORY = "/members/0123456789abcdef/notes.md";

describe("isMemoryPath and isMemoryEvent", () => {
  it("names /members/ and everything under it, and nothing else", () => {
    expect(isMemoryPath("/members/")).toBe(true);
    expect(isMemoryPath(MEMORY)).toBe(true);
    expect(isMemoryPath("/membersx/a")).toBe(false);
    expect(isMemoryPath("/plans/members/a")).toBe(false);
    expect(isMemoryEvent(fsEvent(MEMORY))).toBe(true);
    expect(isMemoryEvent(fsEvent("/plans/launch.md"))).toBe(false);
    expect(isMemoryEvent({ ...fsEvent(MEMORY), type: "message" })).toBe(false);
  });

  it("treats an fs event with no readable path as memory, so the filter fails closed", () => {
    expect(isMemoryEvent({ ...fsEvent(MEMORY), payload: { path: 7 } })).toBe(true);
    expect(isMemoryEvent({ ...fsEvent(MEMORY), payload: null })).toBe(true);
  });
});

describe("seesMemory", () => {
  it("shows the account its own memory, and never the room socket", () => {
    expect(seesMemory([seat(KEEP)], "u_owner", "u_owner")).toBe(true);
    expect(seesMemory([seat(GRANT)], "u_owner", null)).toBe(false);
  });

  it("shows a peer nothing until the account shares, whatever every seat grants", () => {
    expect(seesMemory([seat(GRANT)], "u_owner", "u_peer")).toBe(false);
    expect(seesMemory([seat(GRANT)], "u_owner", "u_peer", { shared: false })).toBe(false);
    expect(seesMemory([seat(GRANT), seat(GRANT, 5)], "u_owner", "u_peer", {}), "no switch read: hidden").toBe(false);
  });

  it("shows a peer, once shared, only when every held seat grants", () => {
    expect(seesMemory([seat(GRANT)], "u_owner", "u_peer", { shared: true })).toBe(true);
    expect(seesMemory([seat(GRANT), seat(KEEP)], "u_owner", "u_peer", { shared: true })).toBe(false);
  });

  it("judges a departed or evicted seat only when the account holds none", () => {
    expect(seesMemory([seat(GRANT), seat(KEEP, 5)], "u_owner", "u_peer", { shared: true }), "a held granting seat decides").toBe(true);
    expect(seesMemory([seat(GRANT, 5), seat(GRANT, 9)], "u_owner", "u_peer", { shared: true })).toBe(true);
    expect(seesMemory([seat(GRANT, 5), seat(KEEP, 9)], "u_owner", "u_peer", { shared: true })).toBe(false);
  });

  it("fails closed with no seats", () => {
    expect(seesMemory([], "u_owner", "u_peer", { shared: true })).toBe(false);
  });

  it("gives no own-account exemption when told not to", () => {
    expect(seesMemory([seat(GRANT), seat(KEEP)], "u_owner", "u_owner", { ownAccount: false, shared: true })).toBe(false);
    expect(seesMemory([seat(GRANT)], "u_owner", "u_owner", { ownAccount: false, shared: true })).toBe(true);
    expect(seesMemory([seat(GRANT)], "u_owner", "u_owner", { ownAccount: false }), "app code reads unshared notes as a peer would").toBe(false);
  });
});

describe("readableEvent and readableEvents on fs events", () => {
  const mixed = [member({ memberId: "m_owner", userId: "u_owner", capabilities: GRANT }), member({ memberId: "m_owner2", userId: "u_owner", capabilities: KEEP })];

  it("hands a memory event to its own account and drops it for every peer, since no path reads the sharing switch yet", () => {
    const e = fsEvent(MEMORY);
    expect(readableEvent(e, undefined, "u_owner")).toBe(e);
    expect(readableEvent(e, undefined, "u_peer", [mixed[0]]), "every seat grants, and still hidden").toBeNull();
    expect(readableEvent(e, undefined, "u_peer", mixed)).toBeNull();
    expect(readableEvent(e, undefined, "u_peer"), "no seats passed: fail closed").toBeNull();
    expect(readableEvent(e, undefined, null, [mixed[0]]), "the room socket").toBeNull();
  });

  it("hands every reader a room file's event", () => {
    const e = fsEvent("/plans/launch.md");
    expect(readableEvent(e, undefined, "u_peer")).toBe(e);
    expect(readableEvent(e, undefined, null)).toBe(e);
  });

  it("looks each memory event's account up in the map it is given", () => {
    const events = [fsEvent(MEMORY), fsEvent("/plans/a.md"), fsEvent(MEMORY, "u_other", "m_other")];
    const seats = new Map<string, Member[]>([["u_owner", mixed], ["u_other", [member({ memberId: "m_other", userId: "u_other", capabilities: GRANT })]]]);
    // Both accounts' memory is dropped, u_other's with every seat granting; the room file is not.
    expect(readableEvents(events, [], "u_peer", seats).map((e) => `${e.fromUserId}:${(e.payload as { path: string }).path}`))
      .toEqual(["u_owner:/plans/a.md"]);
    expect(memoryAuthors(events)).toEqual(["u_owner", "u_other"]);
  });
});

describe("the public page", () => {
  it("shows no fs event, memory or not", () => {
    expect(publicReadEvent(fsEvent(MEMORY))).toBeNull();
    expect(publicReadEvent(fsEvent("/plans/launch.md"))).toBeNull();
  });
});

describe("eventsFor (bellman_sync, the dash's Log, bellman_rooms)", () => {
  it("withholds every account's memory from a peer, granting seats or not, and hands each account its own", async () => {
    const store = new MemoryStore();
    await store.createSession(session({
      id: "qs_mem", members: [
        member(),
        member({ memberId: "m_a1", userId: "u_a", label: "a1", capabilities: GRANT }),
        member({ memberId: "m_a2", userId: "u_a", label: "a2", capabilities: KEEP }),
        member({ memberId: "m_b", userId: "u_b", label: "b", capabilities: GRANT }),
      ],
    }));
    const events = [fsEvent(MEMORY, "u_a", "m_a1"), fsEvent(MEMORY, "u_b", "m_b"), fsEvent("/plans/x.md", "u_a", "m_a1")];
    const shown = await eventsFor(store, "qs_mem", events, "u_jesse");
    expect(shown.map((e) => `${e.fromUserId}:${(e.payload as { path: string }).path}`)).toEqual(["u_a:/plans/x.md"]);
    expect((await eventsFor(store, "qs_mem", events, "u_a")).length, "u_a reads its own memory and the room file").toBe(2);
    expect((await eventsFor(store, "qs_mem", events, "u_b")).length, "u_b reads its own memory and the room file").toBe(2);
  });
});
