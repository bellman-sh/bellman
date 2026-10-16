/**
 * The audit trail's rules (audit trail spec). First the one every row comes through (D1 to
 * D3): the parties to an action, the streams a row reaches, and from each stream's side
 * whether it crossed and which way.
 */
import { describe, expect, it } from "vitest";
import { AUDIT_COLUMNS, SYSTEM_ACTOR, auditRow, auditRows, entryOf, partiesOf, recordOf, type AuditRecord } from "../src/audit.js";
import type { AuditEntry } from "../src/types.js";

const facts = { at: 7, sessionId: "qs_q3", action: "sent_message", roomName: "q3-plan", detail: { chars: 5 } };
const ana = { userId: "u_ana", label: "Ana", orgId: "org_a" };
const bo = { userId: "u_bo", label: "Bo", orgId: "org_b" };

describe("partiesOf", () => {
  it("names each org once, sorted, with a person who has no org last", () => {
    expect(partiesOf(["org_b", null, "org_a", "org_b", ""])).toEqual(["org_a", "org_b", null]);
  });

  it("has no null when everyone has an org", () => {
    expect(partiesOf(["org_a", "org_a"])).toEqual(["org_a"]);
  });
});

describe("auditRows", () => {
  it("writes Ana's send in A's room with Bo present to both orgs: outbound for A, inbound for B", () => {
    const rows = auditRows(["org_a", "org_b"], facts, ana);
    expect(rows.map((r) => [r.orgId, r.crossing, r.direction])).toEqual([
      ["org_a", "cross_org", "outbound"],
      ["org_b", "cross_org", "inbound"],
    ]);
    expect(rows[1]).toEqual({
      at: 7, orgId: "org_b", sessionId: "qs_q3", actorUserId: "u_ana", action: "sent_message", detail: { chars: 5 },
      actorLabel: "Ana", actorOrgId: "org_a", roomName: "q3-plan", parties: ["org_a", "org_b"],
      crossing: "cross_org", direction: "inbound",
    });
  });

  it("is internal, with no direction, when every party is the stream's own org", () => {
    expect(auditRows(["org_a"], facts, ana).map((r) => [r.crossing, r.direction])).toEqual([["internal", null]]);
  });

  it("gives a person with no org no row, and makes the room cross-org for everyone else", () => {
    const rows = auditRows(["org_a", null], facts, { userId: "u_solo", label: "solo", orgId: null });
    expect(rows.map((r) => [r.orgId, r.crossing, r.direction])).toEqual([["org_a", "cross_org", "inbound"]]);
  });

  it("gives the system no direction, even across orgs", () => {
    expect(auditRows(["org_a", "org_b"], facts, SYSTEM_ACTOR).map((r) => r.direction)).toEqual([null, null]);
  });
});

describe("auditRow", () => {
  it("addresses one stream, reading the parties from that stream's side", () => {
    expect(auditRow("org_b", ["org_a", "org_b"], facts, bo).direction).toBe("outbound");
  });
});

describe("the entries table's rows", () => {
  const record = (e: AuditEntry, seq: number): AuditRecord =>
    Object.fromEntries([["seq", seq], ...AUDIT_COLUMNS.map((c, i) => [c, recordOf(e)[i]])]) as AuditRecord;

  it("hands back a recorded row whole, with its seq", () => {
    const row = auditRows(["org_a", "org_b"], facts, ana)[0]!;
    expect(entryOf(record(row, 4))).toEqual({ ...row, seq: 4 });
  });

  it("hands back a row from before the six fields without them", () => {
    const old: AuditEntry = { at: 1, orgId: "org_a", sessionId: "qs_old", actorUserId: "u_old", action: "member_left", detail: {} };
    expect(entryOf(record(old, 1))).toEqual({ ...old, seq: 1 });
  });

  it("keeps an actor with no org apart from a row that never said", () => {
    const row = auditRows(["org_a", null], facts, { userId: "u_solo", label: null, orgId: null })[0]!;
    expect(entryOf(record(row, 2))).toMatchObject({ actorOrgId: null, actorLabel: null, crossing: "cross_org" });
  });
});
