/**
 * The audit routes (audit trail spec, D7 and D8), driven as the Worker drives them: a Request
 * in, a Response out, over a MemoryStore, with rows written by the rooms' own audit rule.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUDIT_EXPORT_PAGE, AUDIT_PAGE, CSV_COLUMNS, auditRoutes, csvCell, csvRow, entryView, exportFilename, parseAuditQuery,
  type AuditEntryView, type AuditRouteDeps,
} from "../src/http/audit.js";
import type { RoomCaller } from "../src/http/rooms.js";
import { audit } from "../src/rooms.js";
import { MemoryStore } from "../src/store.js";
import type { AuditEntry, Identity } from "../src/types.js";
import { member, session } from "./helpers/fixtures.js";

const ISSUER = "https://mcp.example.test";
const PANEL = "https://dash.example.test";

/** The callers, by bearer token: two org admins, and one of each reason to be refused. */
const people: Record<string, Identity> = {
  "admin-a": { userId: "u_ana", orgId: "org_a", plan: "team", role: "admin", label: "Ana" },
  "admin-b": { userId: "u_bo", orgId: "org_b", plan: "team", role: "admin", label: "Bo" },
  "member-a": { userId: "u_al", orgId: "org_a", plan: "team", role: "member", label: "Al" },
  "free-a": { userId: "u_fi", orgId: "org_a", plan: "free", role: "admin", label: "Fi" },
  "no-org": { userId: "u_nn", orgId: null, plan: "team", role: "admin", label: "Nn" },
};

const caller = async (request: Request): Promise<RoomCaller | null> => {
  const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  const identity = token === undefined ? undefined : people[token];
  return identity ? { identity, via: "bearer" } : null;
};

let store: MemoryStore;
let deps: AuditRouteDeps;
beforeEach(() => {
  vi.restoreAllMocks(); // the config does not, and a spy on console.error must not outlive its test
  store = new MemoryStore();
  deps = { store, caller, panelOrigins: [PANEL] };
});

const call = (who: string | null, path: string, method = "GET") =>
  auditRoutes(new Request(`${ISSUER}${path}`, {
    method,
    headers: { origin: PANEL, ...(who ? { authorization: `Bearer ${who}` } : {}) },
  }), deps);

interface ListBody {
  org_id: string;
  entries: AuditEntryView[];
  next: number | null;
  through: number | null;
  total: number;
  unrecorded: number;
  facets?: Record<string, unknown[]>;
}
const list = async (path: string, who = "admin-a") => (await (await call(who, path))!.json()) as ListBody;
const said = async (res: Response | undefined) => ((await res!.json()) as { error_description: string }).error_description;

/** A row in org A's stream as a builder writes one; override any field. */
const row = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  at: Date.parse("2026-10-01T00:00:00Z"), orgId: "org_a", sessionId: "qs_q3", actorUserId: "u_ana", action: "sent_message",
  detail: {}, actorLabel: "Ana", actorOrgId: "org_a", roomName: "q3-plan", parties: ["org_a"], crossing: "internal", direction: null,
  ...over,
});

describe("GET /audit", () => {
  it("leaves a path outside /audit to the next module", async () => {
    expect(await call("admin-a", "/rooms")).toBeUndefined();
    expect(await call("admin-a", "/auditing")).toBeUndefined();
  });

  it("refuses without a credential, with CORS on the refusal", async () => {
    const res = (await call(null, "/audit"))!;
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe(PANEL);
  });

  it("refuses a caller the log does not admit, naming the condition in bellman_audit's words", async () => {
    expect((await call("member-a", "/audit"))!.status).toBe(403);
    expect(await said(await call("free-a", "/audit"))).toBe('the audit log requires the team plan (you are on "free").');
    expect(await said(await call("member-a", "/audit"))).toBe("the audit log requires the admin role.");
    expect(await said(await call("no-org", "/audit"))).toBe("your identity has no org.");
  });

  it("answers GET only, and nothing under /audit but the export", async () => {
    const post = (await call("admin-a", "/audit", "POST"))!;
    expect([post.status, post.headers.get("allow")]).toEqual([405, "GET"]);
    expect((await call("admin-a", "/audit/everything"))!.status).toBe(404);
  });

  it.each([
    ["from=yesterday", "from must be an ISO 8601 instant"],
    ["to=2026-10-09", "to must be an ISO 8601 instant"],
    ["from=2026-02-30T00:00:00Z", "from must be an ISO 8601 instant"],
    ["to=2026-02-29T00:00:00Z", "to must be an ISO 8601 instant"],
    ["scope=both", "scope must be internal or cross_org"],
    ["before=-1", "before is a seq"],
    ["through=1.5", "through is a seq"],
    [`actor=${"x".repeat(201)}`, "actor must be 1 to 200 characters"],
    ["room=", "room must be 1 to 200 characters"],
    ["actr=u_ana", "actr is not a parameter of /audit"],
    ["format=csv", "format is not a parameter of /audit"],
    ["action=a&action=b", "action is given more than once"],
  ])("refuses %s, naming the parameter", async (query, words) => {
    const res = (await call("admin-a", `/audit?${query}`))!;
    expect(res.status).toBe(400);
    expect(await said(res)).toContain(words);
  });

  // The day is the string's own: an offset moves the UTC date, and a leap day exists.
  it.each(["2024-02-29T00:00:00Z", "2026-03-01T01:00:00+05:00", "2026-02-28T23:30:00-05:00"])("takes %s", (from) => {
    expect(parseAuditQuery(new URLSearchParams({ from }), false)).toEqual({ query: { from: Date.parse(from) } });
  });

  // dash#11's first acceptance check.
  it("shows a crossing to both orgs: outbound for the actor's, inbound for the other's", async () => {
    const room = session({
      id: "qs_q3", orgId: "org_a",
      members: [
        member({ memberId: "m_ana", userId: "u_ana", label: "Ana", orgId: "org_a" }),
        member({ memberId: "m_bo", userId: "u_bo", label: "Bo", orgId: "org_b", roomRole: "peer_b" }),
      ],
    });
    await audit(store, room, people["admin-a"]!, "sent_message", { chars: 5 });

    const seen = {
      seq: 1, at: expect.any(String), action: "sent_message", room: { id: "qs_q3", name: room.manifest.room },
      actor: { id: "u_ana", label: "Ana", org_id: "org_a" }, parties: ["org_a", "org_b"], crossing: "cross_org", detail: { chars: 5 },
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    };
    expect((await list("/audit", "admin-a")).entries).toEqual([{ ...seen, direction: "outbound" }]);
    expect((await list("/audit", "admin-b")).entries).toEqual([{ ...seen, direction: "inbound" }]);
  });

  it("reads newest first a page at a time, with the filters' options on the first page only", async () => {
    for (let i = 0; i < AUDIT_PAGE + 5; i++) await store.appendAudit(row({ detail: { i } }));
    const first = await list("/audit");
    expect(first).toMatchObject({ org_id: "org_a", next: 6, through: 105, total: 105, unrecorded: 0 });
    expect(first.entries.map((e) => e.seq)).toEqual(Array.from({ length: AUDIT_PAGE }, (_, k) => 105 - k));
    expect(first.facets).toEqual({ actors: [{ id: "u_ana", label: "Ana" }], rooms: [{ id: "qs_q3", name: "q3-plan" }], orgs: [], actions: ["sent_message"] });

    const second = await list(`/audit?before=${first.next}&through=${first.through}`);
    expect(second.entries.map((e) => e.seq)).toEqual([5, 4, 3, 2, 1]);
    expect(second).toMatchObject({ next: null, through: 105, total: 105 });
    expect(second.facets).toBeUndefined();
  });

  it("never shows another org's rows, whatever the org filter names", async () => {
    await store.appendAudit(row({ orgId: "org_b", actorUserId: "u_bo", parties: ["org_b"] }));
    await store.appendAudit(row({ parties: ["org_a", "org_b"], crossing: "cross_org", direction: "outbound" }));
    expect((await list("/audit?org=org_b")).entries.map((e) => e.parties)).toEqual([["org_a", "org_b"]]);
    expect((await list("/audit")).total).toBe(1);
  });

  it("says a row from before crossings were recorded recorded none, and gives a grant row no room", async () => {
    await store.appendAudit({ at: 1_000, orgId: "org_a", sessionId: "qs_old", actorUserId: "u_old", action: "member_left", detail: {} });
    await store.appendAudit(row({ sessionId: "grant:github:1", roomName: null, action: "plan_granted" }));
    await store.appendAudit(row({ sessionId: "org:org_a", roomName: null, action: "org_updated", detail: { seats: 5 } }));
    await store.appendAudit(row({ sessionId: "scim:x1", roomName: null, action: "scim_user_deactivated" }));
    const [scim, org, grant, old] = (await list("/audit")).entries;
    expect(scim).toMatchObject({ room: null, action: "scim_user_deactivated" });
    expect(org).toMatchObject({ room: null, action: "org_updated", detail: { seats: 5 } });
    expect(grant).toMatchObject({ room: null, crossing: "internal" });
    expect(old).toEqual({
      seq: 1, at: "1970-01-01T00:00:01.000Z", action: "member_left", room: { id: "qs_old", name: null },
      actor: { id: "u_old" }, parties: null, crossing: null, direction: null, detail: {}, hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
});

describe("the CSV", () => {
  it("quotes a cell that holds a comma, a quote or a line break, doubling its quotes", () => {
    expect(csvCell('Bo, "the" builder')).toBe('"Bo, ""the"" builder"');
    expect(csvCell("two\r\nlines")).toBe('"two\r\nlines"');
  });

  it("puts a ' before a string a spreadsheet would run as a formula", () => {
    expect(["=1+1", "+1", "-1", "@SUM(A1)", "\tx"].map(csvCell)).toEqual(["'=1+1", "'+1", "'-1", "'@SUM(A1)", "'\tx"]);
    expect(csvCell("\rx")).toBe("\"'\rx\"");
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
  });

  it("writes nothing for null, and a number as itself", () => {
    expect([csvCell(null), csvCell(undefined), csvCell(12)]).toEqual(["", "", "12"]);
  });

  it("writes a row in the columns' order, the parties joined with ; and a person with no org named so", () => {
    const view = entryView({ seq: 3, hash: "ab12", prevHash: "", ...row({ at: 7, parties: ["org_a", null], crossing: "cross_org", direction: "outbound", detail: { chars: 5 } }) });
    expect(csvRow(view)).toBe(`3,1970-01-01T00:00:00.007Z,sent_message,qs_q3,q3-plan,u_ana,Ana,org_a,org_a;(no org),cross_org,outbound,"{""chars"":5}",ab12\r\n`);
  });

  it("writes an org id that would break a header as a safe file name", () => {
    expect(exportFilename('org/a b"c', 7, "json")).toBe("bellman-audit-org_a_b_c-7.json");
    expect(exportFilename("org_a", null, "csv")).toBe("bellman-audit-org_a-0.csv");
  });
});

/** `n` rows an hour apart in org A's stream: every 2nd by Ana, every 4th internal, every 3rd in another room. */
async function rows(n: number) {
  for (let i = 1; i <= n; i++) {
    const internal = i % 4 === 0;
    await store.appendAudit(row({
      at: Date.parse("2026-10-01T00:00:00Z") + i * 3_600_000,
      sessionId: i % 3 === 0 ? "qs_other" : "qs_q3",
      actorUserId: i % 2 === 0 ? "u_ana" : "u_bo", actorLabel: i % 2 === 0 ? "Ana" : "Bo", actorOrgId: i % 2 === 0 ? "org_a" : "org_b",
      parties: internal ? ["org_a"] : ["org_a", "org_b"], crossing: internal ? "internal" : "cross_org",
      direction: internal ? null : i % 2 === 0 ? "outbound" : "inbound", detail: { i },
    }));
  }
}

describe("GET /audit/export", () => {
  // dash#11's second acceptance check: filters compose, and the export is what the screen pages through.
  it("exports exactly the rows the list pages through, as JSON and as CSV, under a filter of scope, member and dates", async () => {
    await rows(2_400);
    const filter = "scope=cross_org&actor=u_ana&from=2026-10-05T00:00:00Z&to=2027-01-10T00:00:00Z";
    const listed: AuditEntryView[] = [];
    let page = await list(`/audit?${filter}`);
    listed.push(...page.entries);
    while (page.next !== null) {
      page = await list(`/audit?${filter}&before=${page.next}&through=${page.through}`);
      listed.push(...page.entries);
    }
    expect(listed).toHaveLength(page.total);
    expect(listed.length).toBeGreaterThan(AUDIT_EXPORT_PAGE); // the export reads more than one page

    const json = (await (await call("admin-a", `/audit/export?${filter}&format=json&through=${page.through}`))!.json()) as {
      org_id: string; filter: Record<string, string>; through: number; entries: AuditEntryView[];
    };
    expect(json.entries).toEqual(listed);
    expect(json).toMatchObject({ org_id: "org_a", through: page.through, filter: { scope: "cross_org", actor: "u_ana" } });

    const csv = await (await call("admin-a", `/audit/export?${filter}&format=csv&through=${page.through}`))!.text();
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(CSV_COLUMNS.join(","));
    expect(lines[0].endsWith(",hash")).toBe(true);
    expect(lines[1].split(",").at(-1)).toBe(listed[0]!.hash);
    expect(lines.slice(1).map((l) => Number(l.split(",")[0]))).toEqual(listed.map((e) => e.seq));
  });

  it("pins an export to the seq it is given, so rows written since are not in it", async () => {
    await rows(3);
    await store.appendAudit(row());
    const json = (await (await call("admin-a", "/audit/export?format=json&through=3"))!.json()) as { through: number; entries: AuditEntryView[] };
    expect([json.through, json.entries.map((e) => e.seq)]).toEqual([3, [3, 2, 1]]);
    expect(json.entries.map((e) => e.hash)).toEqual([3, 2, 1].map(() => expect.stringMatching(/^[0-9a-f]{64}$/)));
  });

  it("writes a stream with no rows as the header alone, and as a list with none in it", async () => {
    expect(await (await call("admin-a", "/audit/export?format=csv"))!.text()).toBe(`${CSV_COLUMNS.join(",")}\r\n`);
    expect(await (await call("admin-a", "/audit/export?format=json&actor=u_nobody"))!.json()).toEqual({
      org_id: "org_a", filter: { actor: "u_nobody" }, through: null, entries: [],
    });
  });

  it("names the file for the org and its seq, sends it as a download, and lets the panel read the name", async () => {
    await rows(2);
    const res = (await call("admin-a", "/audit/export?format=csv"))!;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''bellman-audit-org_a-2.csv");
    expect(res.headers.get("access-control-expose-headers")).toBe("content-disposition");
    expect(res.headers.get("access-control-allow-origin")).toBe(PANEL);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["before=3&format=csv", "before is not a parameter of /audit/export"],
    ["", "format is required: csv or json"],
    ["format=xml", "format is required: csv or json"],
  ])("refuses %s", async (query, words) => {
    const res = (await call("admin-a", `/audit/export?${query}`))!;
    expect(res.status).toBe(400);
    expect(await said(res)).toBe(words);
  });

  it("refuses a caller the log does not admit, as the list does", async () => {
    expect((await call("member-a", "/audit/export?format=csv"))!.status).toBe(403);
  });

  it("errors the stream when a read fails partway, rather than ending a short file", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await rows(AUDIT_EXPORT_PAGE + 1);
    const real = store.queryAudit.bind(store);
    vi.spyOn(store, "queryAudit").mockImplementationOnce(real).mockRejectedValueOnce(new Error("the stream went away"));
    const res = (await call("admin-a", "/audit/export?format=csv"))!;
    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toThrow();
  });
});

describe("GET /audit/verify", () => {
  it("walks the org's chain, from a seq on request, and refuses a bad from", async () => {
    for (const at of [1, 2, 3]) await store.appendAudit(row({ at }));
    const res = (await call("admin-a", "/audit/verify"))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, from_seq: 1, through_seq: 3, checked: 3, unhashed: 0 });
    expect(await (await call("admin-a", "/audit/verify?from=2"))!.json()).toMatchObject({ ok: true, from_seq: 2, checked: 2 });
    expect((await call("admin-a", "/audit/verify?from=x"))!.status).toBe(400);
    expect(await said(await call("admin-a", "/audit/verify?from=0"))).toBe("from must be a positive integer");
    expect((await call("member-a", "/audit/verify"))!.status).toBe(403);
    expect((await call("free-a", "/audit/verify"))!.status).toBe(403);
  });
});
