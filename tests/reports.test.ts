import { describe, expect, it, vi } from "vitest";
import {
  creatorReportView, operatorReportView, reportId, reportMail, reportMailer, targetKey, type Report, type ReportTarget,
} from "../src/reports.js";

describe("report ids and targets", () => {
  it("orders ids by the time they were filed, and keys each target once", () => {
    expect(reportId(2_000) > reportId(1_000)).toBe(true);
    expect(reportId(10_000) > reportId(9_999)).toBe(true);
    const targets: ReportTarget[] = [{ kind: "room" }, { kind: "member", memberId: "m_a" }, { kind: "message", cursor: 7 }];
    expect(targets.map(targetKey)).toEqual(["room", "member:m_a", "message:7"]);
  });
});

describe("the report's email (spec §3)", () => {
  const report: Report = {
    id: "rpt_000001792108523622_ab12cd34", sessionId: "qs_1", creatorId: "u_jesse",
    target: { kind: "message", cursor: 12 }, subject: { memberId: "m_peer", userId: "u_peer", label: "peer@codenerd" },
    reason: "harassment", note: "line one\r\nSubject: forged\r\n<b>bold</b>",
    reporterUserId: "u_reader", reporterLabel: "reader@example.dev",
    at: Date.UTC(2026, 9, 15), resolvedAt: null, resolution: null, resolvedBy: null,
  };

  /**
   * Review Focus 4, and the owner's decision of 2026-10-17: the email is a notice, and the queue holds the rest. A note with
   * CR/LF, a `Subject:` line or markup reaches neither the subject nor the body, and neither does anything else the queue
   * keeps: who filed the report, whom it is about, the room's creator, the message's cursor.
   */
  it("builds the subject from closed sets, and carries no note, no reporter, no one's label or id and no creator", () => {
    const mail = reportMail(report);
    expect(mail.subject).toBe("Bellman report rpt_000001792108523622_ab12cd34: harassment, a message");
    expect(mail.text).toContain("Room: qs_1");
    const everything = `${mail.subject}\n${mail.text}`;
    for (const absent of [
      "line one", "forged", "Subject: forged", "<b>bold</b>", "\r", "Note", "Filed by",
      "reader@example.dev", "u_reader", "peer@codenerd", "m_peer", "u_peer", "u_jesse", "creator", "cursor",
    ]) expect(everything, absent).not.toContain(absent);
  });

  it("sends one message from reports@ to support@, and logs a failure or a missing binding without throwing", async () => {
    const sent: unknown[] = [];
    await reportMailer({ send: async (m) => sent.push(m) })(report);
    expect(sent).toEqual([{ from: "reports@bellman.sh", to: "support@bellman.sh", ...reportMail(report) }]);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(reportMailer({ send: async () => { throw new Error("not verified"); } })(report)).resolves.toBeUndefined();
    await expect(reportMailer(undefined)(report)).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledTimes(2);
    logged.mockRestore();
  });

  // A failed send is diagnosed from the log alone: the binding's own code (E_SENDER_DOMAIN_NOT_AVAILABLE, E_SENDER_NOT_VERIFIED)
  // and its message sit in the line beside the report's id, and the note, which is untrusted text, does not.
  it("logs a failed send with the report's id and the binding's code and message, and never the note", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const refused = Object.assign(new Error("Domain not onboarded to Email Service"), { code: "E_SENDER_DOMAIN_NOT_AVAILABLE" });
      await reportMailer({ send: async () => { throw refused; } })(report);
      const line = logged.mock.calls.flat().join(" ");
      expect(line).toContain(report.id);
      expect(line).toContain("E_SENDER_DOMAIN_NOT_AVAILABLE");
      expect(line).toContain("Domain not onboarded to Email Service");
      for (const fromTheNote of ["line one", "forged", "<b>bold</b>"]) expect(line, fromTheNote).not.toContain(fromTheNote);
    } finally {
      logged.mockRestore();
    }
  });

  it("logs a binding's failure whatever it threw, and still never rejects", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const thrown = ["quota exceeded", null, undefined, { code: "E_RATE_LIMIT_EXCEEDED" }, new Error("only a message")];
      for (const t of thrown) await expect(reportMailer({ send: async () => { throw t; } })(report)).resolves.toBeUndefined();
      const lines = logged.mock.calls.map((call) => call.join(" "));
      expect(lines).toHaveLength(thrown.length);
      for (const line of lines) expect(line).toContain(report.id);
      expect(lines[0]).toContain("quota exceeded");
      expect(lines[3]).toContain("E_RATE_LIMIT_EXCEEDED");
      expect(lines[4]).toContain("only a message");
    } finally {
      logged.mockRestore();
    }
  });

  it("writes the body in the order the support inbox is read, for each kind of target", () => {
    const lines = (r: Report) => reportMail(r).text.split("\n");
    const member: Report = { ...report, target: { kind: "member", memberId: "m_peer" }, reason: "spam" };
    const room: Report = { ...report, target: { kind: "room" }, subject: null, reason: "other", note: null };
    expect(reportMail(member).subject).toBe("Bellman report rpt_000001792108523622_ab12cd34: spam, a member");
    expect(reportMail(room).subject).toBe("Bellman report rpt_000001792108523622_ab12cd34: other, the room");
    expect(lines(room)).toEqual([
      "Report rpt_000001792108523622_ab12cd34, filed 2026-10-15T00:00:00.000Z.",
      "Room: qs_1",
      "About: the room",
      "Reason: other",
      "",
      "Read the queue at GET /admin/reports, and close this report at POST /admin/reports/rpt_000001792108523622_ab12cd34/resolve.",
    ]);
    // The same words for a note and for none, and for every kind of target but the one line that names it.
    expect(lines({ ...room, note: "a note" })).toEqual(lines(room));
    expect(lines(member)[2]).toBe("About: a member");
    expect(lines(report)[2]).toBe("About: a message");
    expect(lines(member).filter((_, i) => i !== 2)).toEqual(lines(room).filter((_, i) => i !== 2).map((l) => l === "Reason: other" ? "Reason: spam" : l));
  });
});

describe("the two views of a report (spec §3)", () => {
  const filed: Report = {
    id: "rpt_000001792108523622_ab12cd34", sessionId: "qs_1", creatorId: "u_jesse",
    target: { kind: "member", memberId: "m_peer" }, subject: { memberId: "m_peer", userId: "u_peer", label: "peer@codenerd" },
    reason: "harassment", note: "<b>not markup</b>", reporterUserId: "u_reader", reporterLabel: "reader@example.dev",
    at: Date.UTC(2026, 9, 15, 12, 30), resolvedAt: null, resolution: null, resolvedBy: null,
  };
  const closed: Report = { ...filed, resolvedAt: Date.UTC(2026, 9, 16), resolution: "warned them", resolvedBy: "u_operator" };
  const message: Report = { ...filed, target: { kind: "message", cursor: 12 } };
  const room: Report = { ...filed, target: { kind: "room" }, subject: null };

  it("shows a creator what a report is about and never who filed it", () => {
    expect(creatorReportView(filed)).toEqual({
      id: filed.id, target: { kind: "member", member_id: "m_peer" }, about: { member_id: "m_peer", label: "peer@codenerd" },
      reason: "harassment", note: "<b>not markup</b>", at: "2026-10-15T12:00:00.000Z", resolved: false,
    });
    expect(creatorReportView(closed).resolved).toBe(true);
    expect(creatorReportView(message)).toMatchObject({ target: { kind: "message", cursor: 12 }, about: { member_id: "m_peer", label: "peer@codenerd" } });
    expect(creatorReportView(room)).toMatchObject({ target: { kind: "room" }, about: null });
    // The exact match above would fail on an added key; this fails on the same value reaching the creator under another name.
    const seen = JSON.stringify([filed, closed, message, room].map(creatorReportView));
    for (const hidden of ["u_reader", "reader@example.dev", "u_peer", "u_operator", "warned them", "qs_1", "u_jesse"]) {
      expect(seen, hidden).not.toContain(hidden);
    }
  });

  /**
   * Section 1C review, declined 5, ruled into the pass. A creator who could read when a report was filed to the millisecond
   * could match it to one member's activity in the room. The creator's view gives the hour, as ISO 8601 with the minutes,
   * seconds and milliseconds zeroed; the operator's view keeps the exact time.
   */
  it("gives a creator the hour a report was filed and an operator the exact time", () => {
    const at = (ms: number): Report => ({ ...filed, at: ms });
    const times: [number, string, string][] = [
      [Date.UTC(2026, 9, 15, 12, 59, 59, 999), "2026-10-15T12:00:00.000Z", "2026-10-15T12:59:59.999Z"],
      [Date.UTC(2026, 9, 15, 13, 0, 0, 0), "2026-10-15T13:00:00.000Z", "2026-10-15T13:00:00.000Z"],
      [Date.UTC(2026, 9, 15, 13, 0, 0, 1), "2026-10-15T13:00:00.000Z", "2026-10-15T13:00:00.001Z"],
      [Date.UTC(2026, 11, 31, 23, 30, 5, 7), "2026-12-31T23:00:00.000Z", "2026-12-31T23:30:05.007Z"],
    ];
    for (const [ms, forCreator, forOperator] of times) {
      expect(creatorReportView(at(ms)).at, `creator, ${forOperator}`).toBe(forCreator);
      expect(operatorReportView(at(ms)).at, `operator, ${forOperator}`).toBe(forOperator);
    }
    // Only `at` is coarsened: a report that was resolved still says so, and the operator's resolved_at is exact.
    expect(operatorReportView({ ...closed, resolvedAt: Date.UTC(2026, 9, 16, 1, 2, 3, 4) }).resolved_at).toBe("2026-10-16T01:02:03.004Z");
  });

  it("shows an operator everything, with times as ISO 8601 or null", () => {
    expect(operatorReportView(filed)).toEqual({
      id: filed.id, session_id: "qs_1", creator_id: "u_jesse", target: { kind: "member", member_id: "m_peer" },
      about: { member_id: "m_peer", user_id: "u_peer", label: "peer@codenerd" },
      reason: "harassment", note: "<b>not markup</b>", filed_by: { user_id: "u_reader", label: "reader@example.dev" },
      at: "2026-10-15T12:30:00.000Z", resolved_at: null, resolution: null, resolved_by: null,
    });
    expect(operatorReportView(closed)).toMatchObject({
      resolved_at: "2026-10-16T00:00:00.000Z", resolution: "warned them", resolved_by: "u_operator",
    });
    expect(operatorReportView(message)).toMatchObject({ target: { kind: "message", cursor: 12 } });
    expect(operatorReportView(room)).toMatchObject({ target: { kind: "room" }, about: null });
  });
});
