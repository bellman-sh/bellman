/** A home room (ADR 0047) is never abandoned: the one rule both stores' sweeps share reads `kind`. */
import { describe, expect, it } from "vitest";
import { abandonedAt } from "../src/store.js";
import { member, session } from "./helpers/fixtures.js";

describe("abandonedAt", () => {
  it("is null for a home room however long ago its one member was seen, and a time for the same roster in a room", () => {
    const old = member({ memberId: "home", userId: "u_a", joinedAt: 1, lastSeenAt: 1 });
    expect(abandonedAt(session({ members: [old] }))).not.toBeNull();
    expect(abandonedAt({ ...session({ members: [old] }), kind: "home" })).toBeNull();
  });
});
