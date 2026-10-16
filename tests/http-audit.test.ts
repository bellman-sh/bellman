/**
 * The audit routes (audit trail spec, D7 and D8), driven as the Worker drives them: a Request
 * in, a Response out, over a MemoryStore, with rows written by the rooms' own audit rule.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { AUDIT_PAGE, auditRoutes, type AuditEntryView, type AuditRouteDeps } from "../src/http/audit.js";
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
    const [grant, old] = (await list("/audit")).entries;
    expect(grant).toMatchObject({ room: null, crossing: "internal" });
    expect(old).toEqual({
      seq: 1, at: "1970-01-01T00:00:01.000Z", action: "member_left", room: { id: "qs_old", name: null },
      actor: { id: "u_old" }, parties: null, crossing: null, direction: null, detail: {},
    });
  });
});
