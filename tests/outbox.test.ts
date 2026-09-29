import { describe, it, expect } from "vitest";
import { DUE_PREFIX, dueKey, dueNames, earliestDue, mergeDue } from "../src/outbox.js";

describe("named alarms", () => {
  it("names a due row under its own prefix", () => {
    expect(dueKey("outbox")).toBe(`${DUE_PREFIX}outbox`);
  });

  it("picks the earliest due time, and null when nothing is scheduled", () => {
    expect(earliestDue([500, 100, 900])).toBe(100);
    expect(earliestDue([])).toBeNull();
  });

  /**
   * The boundary is the case that bites: an alarm fires AT its due time, not
   * after it. `<` here would leave the handler scheduled and re-fire forever.
   */
  it("treats a handler due exactly now as due", () => {
    const due = new Map([["ttl", 1_000], ["outbox", 1_001]]);
    expect(dueNames(due, 1_000)).toEqual(["ttl"]);
    expect(dueNames(due, 1_001)).toEqual(["outbox", "ttl"]);
    expect(dueNames(due, 999)).toEqual([]);
  });

  /**
   * Derived entries are ones an object computes rather than stores — SessionDO's
   * TTL comes from the session record. A stored row of the same name wins, so a
   * handler can reschedule itself.
   */
  it("merges stored rows over derived ones, stripping the prefix", () => {
    const rows = new Map([[`${DUE_PREFIX}outbox`, 700], [`${DUE_PREFIX}ttl`, 50]]);
    const derived = new Map([["ttl", 999]]);
    expect(mergeDue(rows, derived)).toEqual(new Map([["ttl", 50], ["outbox", 700]]));
  });
});
