import { describe, it, expect } from "vitest";
import { ATTENTION, attentionOf, isAmbient } from "../src/attention.js";
import type { EventType } from "../src/types.js";

/**
 * The twelve types that existed before #111 all interrupt, which is what they
 * do today. This table introduces a classification, not a behaviour change.
 */
const PRE_EXISTING: EventType[] = [
  "member_joined", "member_left", "member_evicted", "member_timed_out",
  "message", "artifact", "action_request", "action_response", "brief_update",
  "invite_issued", "invite_revoked", "session_expired",
];

describe("attention", () => {
  it.each(PRE_EXISTING)("leaves %s interrupting", (type) => {
    expect(attentionOf(type)).toBe("interrupt");
  });

  it("makes a reply and a surface write ambient, and the tick an interrupt", () => {
    expect(attentionOf("progress")).toBe("ambient");
    expect(attentionOf("surface")).toBe("ambient");
    expect(attentionOf("heartbeat")).toBe("interrupt");
    expect(isAmbient({ type: "progress", payload: { note: "n" } })).toBe(true);
    expect(isAmbient({ type: "surface", payload: {} })).toBe(true);
    expect(isAmbient({ type: "heartbeat", payload: { members: [{ member_id: "m_a" }] } })).toBe(false);
  });

  // A tick that names nobody asks nobody (M4): in a hosted room it is the host's own, and
  // interrupting every member each cadence would spend a turn of theirs on nothing.
  it("makes a heartbeat that asks no member for a report ambient", () => {
    expect(isAmbient({ type: "heartbeat", payload: { cadence_seconds: 3600, ask: "...", members: [] } })).toBe(true);
    expect(isAmbient({ type: "message", payload: { members: [] } })).toBe(false);
  });

  /**
   * The compiler enforces this table in both directions: `satisfies` rejects a
   * type with no posture (TS2741) and a key that names no type (TS2353). This
   * is a runtime backstop for the second, a key left behind after a type is
   * removed, and not a gap in the compiler's check.
   */
  it("declares a posture for exactly the known types and no others", () => {
    expect(new Set(Object.keys(ATTENTION)))
      .toEqual(new Set([...PRE_EXISTING, "heartbeat", "progress", "surface"]));
  });
});
