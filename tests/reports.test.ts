import { describe, expect, it } from "vitest";
import { reportId, targetKey, type ReportTarget } from "../src/reports.js";

describe("report ids and targets", () => {
  it("orders ids by the time they were filed, and keys each target once", () => {
    expect(reportId(2_000) > reportId(1_000)).toBe(true);
    expect(reportId(10_000) > reportId(9_999)).toBe(true);
    const targets: ReportTarget[] = [{ kind: "room" }, { kind: "member", memberId: "m_a" }, { kind: "message", cursor: 7 }];
    expect(targets.map(targetKey)).toEqual(["room", "member:m_a", "message:7"]);
  });
});
