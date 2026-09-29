import { describe, it, expect } from "vitest";
import { DUE_PREFIX, dueKey, dueNames, earliestDue, mergeDue } from "../src/outbox.js";

describe("named alarms", () => {
  /**
   * Storage keys outlive a deploy, so a changed prefix orphans every stored
   * `due:` row. The first expectation is built from DUE_PREFIX and cannot
   * notice a change; the literal can.
   */
  it("names a due row under its own prefix", () => {
    expect(dueKey("outbox")).toBe(`${DUE_PREFIX}outbox`);
    expect(dueKey("outbox")).toBe("due:outbox");
  });

  it("picks the earliest due time, and null when nothing is scheduled", () => {
    expect(earliestDue([500, 100, 900])).toBe(100);
    // A fake clock starts at 0. That is a due time, not "nothing scheduled".
    expect(earliestDue([5, 0, 9])).toBe(0);
    // Any iterable works, including `Map.values()`, which can only be read once.
    expect(earliestDue(new Map([["a", 500], ["b", 100]]).values())).toBe(100);
    expect(earliestDue([])).toBeNull();
  });

  /**
   * The boundary is the case that bites: an alarm fires AT its due time, not
   * after it. `<` here would skip the handler at that instant and re-arm the
   * alarm to the same instant, so it spins until the clock moves on.
   */
  it("treats a handler due exactly now as due", () => {
    const due = new Map([["ttl", 1_000], ["outbox", 1_001]]);
    expect(dueNames(due, 1_000)).toEqual(["ttl"]);
    expect(dueNames(due, 1_001)).toEqual(["outbox", "ttl"]);
    expect(dueNames(due, 999)).toEqual([]);
    // Name order, whatever order the map was built in.
    expect(dueNames(new Map([["b", 0], ["c", 0], ["a", 0]]), 0)).toEqual(["a", "b", "c"]);
  });

  /**
   * Derived entries are ones an object computes rather than stores — SessionDO's
   * TTL comes from the session record. A stored row of the same name wins,
   * earlier or later than the derived time, so a handler can reschedule itself
   * past its default. A derived entry with no stored row (`gc`) survives: a
   * session written before named alarms has a derived `ttl` and nothing stored
   * to shadow it. Neither input is changed.
   */
  it("merges stored rows over derived ones, stripping the prefix", () => {
    const rows = new Map([
      [`${DUE_PREFIX}outbox`, 700],
      [`${DUE_PREFIX}ttl`, 50],
      [`${DUE_PREFIX}retry`, 900],
    ]);
    const derived = new Map([["ttl", 999], ["retry", 100], ["gc", 5]]);
    const rowsBefore = [...rows];
    const derivedBefore = [...derived];

    expect(mergeDue(rows, derived)).toEqual(
      new Map([["outbox", 700], ["ttl", 50], ["retry", 900], ["gc", 5]])
    );
    expect([...rows]).toEqual(rowsBefore);
    expect([...derived]).toEqual(derivedBefore);
  });
});
