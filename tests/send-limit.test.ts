import { describe, expect, it } from "vitest";
import {
  SEND_LIMIT, SEND_WINDOW_MS, STRANGER_KEY_PREFIX, STRANGER_SEND_LIMIT, admitAt, sendKeyFor, sendLimitFor,
} from "../src/send-limit.js";

describe("the send limit (spec D5)", () => {
  it("is 30 a minute for a member and 6 for one who joined through a permanent code", () => {
    expect([SEND_LIMIT, STRANGER_SEND_LIMIT, SEND_WINDOW_MS]).toEqual([30, 6, 60_000]);
    expect(sendLimitFor({})).toBe(30);
    expect(sendLimitFor({ via: "permanent" })).toBe(6);
  });

  it("counts a stranger under their account and anyone else under their seat", () => {
    const seat = { memberId: "m_ab12cd34", userId: "u_peer" };
    expect(sendKeyFor({ ...seat, via: "permanent" })).toBe("user:u_peer");
    expect(sendKeyFor(seat)).toBe("m_ab12cd34");
    // An account's key and a seat's cannot be mistaken for each other: a member id is `m_` and eight characters.
    expect(sendKeyFor(seat).startsWith(STRANGER_KEY_PREFIX)).toBe(false);
    expect(STRANGER_KEY_PREFIX.startsWith("m_")).toBe(false);
  });

  it("admits up to the limit in a rolling minute, then says when the oldest send leaves it", () => {
    let times: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = admitAt(times, 6, 1_000 + i);
      expect(r.retryAfterMs, `send ${i + 1}`).toBeNull();
      times = r.times;
    }
    expect(admitAt(times, 6, 30_000)).toEqual({ times, retryAfterMs: 31_000 });
    expect(admitAt(times, 6, 61_000).retryAfterMs, "a minute after the first").toBeNull();
  });
});
