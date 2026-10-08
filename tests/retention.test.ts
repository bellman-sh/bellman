import { describe, expect, it } from "vitest";
import {
  orgsOnRoster, purgeDueAt, roomDeletedEntry, roomPurgedEntry, sweepDueAt,
} from "../src/retention.js";
import { member, session } from "./helpers/fixtures.js";

const base = { closed: true, closedAt: 1_000, retainAfterCloseMs: 500, purgeAt: null };
describe("purgeDueAt", () => {
  it("is the window's end for a closed room with a window", () => expect(purgeDueAt(base)).toBe(1_500));
  it("is null for an open room, whatever else it carries", () => expect(purgeDueAt({ ...base, closed: false, purgeAt: 1 })).toBeNull());
  it("is null for a closed room kept until deleted", () => expect(purgeDueAt({ ...base, retainAfterCloseMs: null })).toBeNull());
  it("is null for a row closed before the window existed", () => expect(purgeDueAt({ ...base, closedAt: null })).toBeNull());
  it("is the asked-for time when a delete set one, even sooner than the window", () => expect(purgeDueAt({ ...base, purgeAt: 1_200 })).toBe(1_200));
  it("is the asked-for time for a kept room and for a legacy row", () => {
    expect(purgeDueAt({ ...base, retainAfterCloseMs: null, purgeAt: 1_200 })).toBe(1_200);
    expect(purgeDueAt({ ...base, closedAt: null, retainAfterCloseMs: null, purgeAt: 1_200 })).toBe(1_200);
  });
});

// The sweep's own rule is Task 3's to wire, but it is defined beside the purge's and read the same way.
const unswept = { closed: true, closedAt: 1_000, blobsSwept: false };
describe("sweepDueAt", () => {
  it("is the close itself, for a closed room whose sweep has not run", () => expect(sweepDueAt(unswept)).toBe(1_000));
  it("is null once the sweep has run", () => expect(sweepDueAt({ ...unswept, blobsSwept: true })).toBeNull());
  it("is null for an open room", () => expect(sweepDueAt({ ...unswept, closed: false })).toBeNull());
  it("is null for a row closed before the close was dated", () => expect(sweepDueAt({ ...unswept, closedAt: null })).toBeNull());
});

describe("orgsOnRoster", () => {
  it("names each org once, in roster order, and none for a member with no org", () => {
    const s = session({ members: [
      member({ memberId: "m_1", orgId: "org_b" }),
      member({ memberId: "m_2", orgId: null }),
      member({ memberId: "m_3", orgId: "org_a" }),
      member({ memberId: "m_4", orgId: "org_b" }),
    ] });
    expect(orgsOnRoster(s)).toEqual(["org_b", "org_a"]);
  });

  /** A room involved the org of everyone who ever sat in it, and the roster keeps those who left. */
  it("counts a member who has left", () => {
    const s = session({ members: [member({ orgId: "org_gone", leftAt: 5 })] });
    expect(orgsOnRoster(s)).toEqual(["org_gone"]);
  });

  /** A falsy org names a stream nobody reads (ARCHITECTURE.md, runtime fact 4): no entry may be filed against one. */
  it("skips an empty org id as it skips a null one", () => {
    const s = session({ members: [member({ orgId: "" })] });
    expect(orgsOnRoster(s)).toEqual([]);
  });
});

describe("the entries a purge files", () => {
  const room = session({ id: "qs_entry" });
  const detail = { session_id: "qs_entry", room: room.manifest.room };

  it("room_purged says the window ran out, and names the system as the actor", () => {
    expect(roomPurgedEntry(room, "org_codenerd", 7)).toEqual({
      at: 7, orgId: "org_codenerd", sessionId: "qs_entry", actorUserId: "system", action: "room_purged", detail,
    });
  });

  it("room_deleted names who asked", () => {
    expect(roomDeletedEntry(room, "org_codenerd", "u_jesse", 7)).toEqual({
      at: 7, orgId: "org_codenerd", sessionId: "qs_entry", actorUserId: "u_jesse", action: "room_deleted", detail,
    });
  });

  it("room_deleted names the system when nobody did", () => {
    expect(roomDeletedEntry(room, "org_codenerd", null, 7).actorUserId).toBe("system");
  });
});
