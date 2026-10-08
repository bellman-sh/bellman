/**
 * The monitor's refresh is called by a 15 s timer and by a Refresh button. Two
 * calls in flight would be two bellman_rooms reads, and the older answer could
 * land after the newer one; coalesce makes every caller wait on the one call.
 */
import { describe, it, expect } from "vitest";
import { coalesce } from "../src/shared.js";

describe("coalesce", () => {
  it("shares one in-flight call, and starts a new one once it settled", async () => {
    let calls = 0;
    let release!: () => void;
    const fn = coalesce(() => {
      calls++;
      return new Promise<number>((resolve) => { release = () => resolve(calls); });
    });
    const a = fn();
    const b = fn();
    expect(calls).toBe(1);
    release();
    expect(await a).toBe(1);
    expect(await b).toBe(1);
    void fn();
    expect(calls).toBe(2);
  });
});
