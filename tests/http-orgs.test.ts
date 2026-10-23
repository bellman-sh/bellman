/**
 * The org routes (orgs spec, D6), driven as the Worker drives them: a Request in, a Response out,
 * over a MemoryStore, with the org created the way the operator's route creates it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_ORG_WRITE_BYTES, orgRoutes, type OrgRouteDeps } from "../src/http/orgs.js";
import type { RoomCaller } from "../src/http/rooms.js";
import { MemoryStore } from "../src/store.js";
import type { Identity, Org, PlanGrant } from "../src/types.js";

const ISSUER = "https://mcp.example.test";
const PANEL = "https://dash.example.test";

/** The callers, by bearer token. `cookie-owner` is the owner over a panel cookie, for the CSRF cases. */
const people: Record<string, Identity> = {
  owner: { userId: "u_github_1", orgId: "org_acme", plan: "team", role: "admin", label: "Ana" },
  "cookie-owner": { userId: "u_github_1", orgId: "org_acme", plan: "team", role: "admin", label: "Ana" },
  "admin-2": { userId: "u_github_9", orgId: "org_acme", plan: "team", role: "admin", label: "Al" },
  member: { userId: "u_github_4242", orgId: "org_acme", plan: "team", role: "member", label: "Mo" },
  "free-admin": { userId: "u_github_7", orgId: "org_acme", plan: "free", role: "admin", label: "Fi" },
  "no-org": { userId: "u_github_5", orgId: null, plan: "team", role: "admin", label: "Nn" },
  "admin-b": { userId: "u_github_2", orgId: "org_b", plan: "team", role: "admin", label: "Bo" },
  unrecorded: { userId: "u_github_3", orgId: "org_string", plan: "team", role: "admin", label: "Un" },
};

const caller = async (request: Request): Promise<RoomCaller | null> => {
  const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  const identity = token === undefined ? undefined : people[token];
  return identity && token !== undefined ? { identity, via: token.startsWith("cookie-") ? "cookie" : "bearer" } : null;
};

/** A purchased org, so billing's deactivation applies to it; the routes read the same of either kind. */
const acme: Org = {
  orgId: "org_acme", name: "Acme", ownerUserId: "u_github_1", seats: 3, source: "purchase", active: true,
  createdAt: Date.parse("2026-10-21T00:00:00Z"), requireSso: false, domains: [],
};
const ownerGrant: PlanGrant = {
  key: "github:1", plan: "team", role: "admin", orgId: "org_acme", source: "operator",
  grantedAt: 1, grantedBy: "u_op", expiresAt: null,
};

let store: MemoryStore;
let deps: OrgRouteDeps;
beforeEach(async () => {
  store = new MemoryStore();
  deps = { store, caller, panelOrigins: [PANEL] };
  await store.createOrg(acme, ownerGrant, { actorUserId: "u_op" });
  await store.createOrg({ ...acme, orgId: "org_b", name: "B", ownerUserId: "u_github_2" }, { ...ownerGrant, key: "github:2", orgId: "org_b" }, { actorUserId: "u_op" });
});

/** A request as a browser or curl sends one: the body's length declared, since the bound reads the header. */
const call = (who: string | null, path: string, method = "GET", body?: unknown, origin: string | null = PANEL) => {
  const text = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  return orgRoutes(new Request(`${ISSUER}${path}`, {
    method,
    headers: {
      ...(origin ? { origin } : {}),
      ...(who ? { authorization: `Bearer ${who}` } : {}),
      ...(text === undefined ? {} : { "content-type": "application/json", "content-length": String(new TextEncoder().encode(text).length) }),
    },
    body: text,
  }), deps);
};
const json = async (res: Response | undefined) => (await res!.json()) as Record<string, unknown>;
const said = async (res: Response | undefined) => (await json(res)).error_description as string;

describe("the module's edge", () => {
  it("leaves a path outside /org to the next module, and answers the preflight", async () => {
    expect(await call("owner", "/orgs")).toBeUndefined();
    expect(await call("owner", "/organisation")).toBeUndefined();
    expect(await call("owner", "/audit")).toBeUndefined();
    const preflight = (await call(null, "/org", "OPTIONS"))!;
    expect([preflight.status, preflight.headers.get("access-control-allow-origin")]).toEqual([204, PANEL]);
  });

  it("asks for a caller, and tells an unknown path under /org from a method it does not take", async () => {
    expect((await call(null, "/org"))!.status).toBe(401);
    expect((await call("owner", "/org/nothing"))!.status).toBe(404);
    const res = (await call("owner", "/org", "DELETE"))!;
    expect([res.status, res.headers.get("allow")]).toEqual([405, "GET, PATCH"]);
  });
});

describe("GET /org", () => {
  it("answers the owner the record, the seats used and their role", async () => {
    const res = (await call("owner", "/org"))!;
    expect([res.status, res.headers.get("access-control-allow-origin")]).toEqual([200, PANEL]);
    expect(await res.json()).toEqual({
      org_id: "org_acme", name: "Acme", owner_user_id: "u_github_1", seats: 3, seats_used: 1, active: true,
      source: "purchase", created_at: "2026-10-21T00:00:00.000Z", require_sso: false, domains: [], your_role: "admin",
    });
  });

  it("answers a member their role, and a free member of an inactive org the standing", async () => {
    expect((await json(await call("member", "/org"))).your_role).toBe("member");
    await store.deactivateOrg("org_acme", { actorUserId: "stripe" });
    expect(await json(await call("free-admin", "/org"))).toMatchObject({ active: false, your_role: "admin" });
  });

  it("refuses a caller with no org, and names an org with no record", async () => {
    const none = (await call("no-org", "/org"))!;
    expect([none.status, await said(none)]).toEqual([403, "your identity has no org."]);
    const unrecorded = (await call("unrecorded", "/org"))!;
    expect([unrecorded.status, (await json(unrecorded)).error]).toEqual([404, "no_org"]);
  });
});

describe("PATCH /org", () => {
  it("renames, for an admin, with the panel's Origin on a cookie", async () => {
    const res = (await call("cookie-owner", "/org", "PATCH", { name: " Acme Ltd " }))!;
    expect([res.status, (await json(res)).name]).toEqual([200, "Acme Ltd"]);
    expect((await store.getOrg("org_acme"))?.name).toBe("Acme Ltd");
    expect((await store.auditForOrg("org_acme", 10)).at(-1)).toMatchObject({ action: "org_updated", actorUserId: "u_github_1", detail: { name: "Acme Ltd" } });
  });

  it("refuses a cookie write without the panel's Origin, a bad name, a stray field, and a member", async () => {
    expect((await call("cookie-owner", "/org", "PATCH", { name: "X" }, null))!.status).toBe(403);
    for (const body of [{ name: "" }, { name: "a".repeat(81) }, {}, { seats: 9 }, "null", "[]"]) {
      expect((await call("owner", "/org", "PATCH", body))!.status, JSON.stringify(body)).toBe(400);
    }
    expect((await call("member", "/org", "PATCH", { name: "X" }))!.status).toBe(403);
    expect((await store.getOrg("org_acme"))?.name).toBe("Acme");
  });
});

describe("GET /org/members", () => {
  it("lists the org's grants as members, the owner marked, for an admin", async () => {
    await store.putGrantIfOwned({ ...ownerGrant, key: "email:bo@acme.test", role: "member", source: "org" }, "org_acme", { actorUserId: "u_github_1" });
    const res = (await call("admin-2", "/org/members"))!;
    expect([res.status, await res.json()]).toEqual([200, { members: [
      { key: "github:1", user_id: "u_github_1", role: "admin", plan: "team", source: "operator", granted_at: "1970-01-01T00:00:00.001Z", expires_at: null, owner: true },
      { key: "email:bo@acme.test", user_id: null, role: "member", plan: "team", source: "org", granted_at: "1970-01-01T00:00:00.001Z", expires_at: null, owner: false },
    ] }]);
  });

  it("shows an admin their own org and never another, and refuses a member, a free admin and an org with no record", async () => {
    expect((await json(await call("admin-b", "/org/members"))).members).toEqual([expect.objectContaining({ key: "github:2" })]);
    expect([(await call("member", "/org/members"))!.status, await said(await call("member", "/org/members"))]).toEqual([403, "the audit log requires the admin role."]);
    expect(await said(await call("free-admin", "/org/members"))).toBe('the audit log requires the team plan (you are on "free").');
    expect((await call("unrecorded", "/org/members"))!.status).toBe(404);
  });
});

describe("POST /org/members", () => {
  const add = (who: string, body: unknown, origin: string | null = PANEL) => call(who, "/org/members", "POST", body, origin);

  it("seats a member by any stable key, as a team grant from this org, until the seats run out", async () => {
    const res = (await add("owner", { key: "email:bo@acme.test", role: "member" }))!;
    expect([res.status, await res.json()]).toEqual([201, { member: {
      key: "email:bo@acme.test", user_id: null, role: "member", plan: "team", source: "org", granted_at: expect.any(String), expires_at: null, owner: false,
    } }]);
    expect(await store.getGrant("email:bo@acme.test")).toMatchObject({ plan: "team", orgId: "org_acme", source: "org", grantedBy: "u_github_1" });
    expect((await add("owner", { key: "github:9", role: "admin" }))!.status).toBe(201);
    const full = (await add("owner", { key: "github:10", role: "member" }))!;
    expect([full.status, await full.json()]).toEqual([409, { error: "full", error_description: "this org holds 3 of 3 seats", seats: 3, seats_used: 3 }]);
    expect(await store.getGrant("github:10")).toBeUndefined();
  });

  it("writes a grant that is this org's, whatever the body says of plan, org or source", async () => {
    const res = (await add("owner", { key: "github:9", role: "member", plan: "max", orgId: "org_b", source: "purchase", expiresAt: 5 }))!;
    expect(res.status).toBe(201);
    expect(await store.getGrant("github:9")).toMatchObject({ plan: "team", orgId: "org_acme", source: "org", expiresAt: null });
  });

  /**
   * Seating is create-only. The owner's grant is not this route's to rewrite: a POST with their key
   * and `role: "member"` would demote them and turn a purchase grant into an org one, which billing
   * would then refuse to touch. A member already seated is changed through PATCH, which keeps the
   * grant's source and expiry as they were.
   */
  it("refuses the owner's key and a key already seated, leaving both grants as they were", async () => {
    const owner = (await add("admin-2", { key: "github:1", role: "member" }))!;
    expect([owner.status, (await json(owner)).error]).toEqual([409, "owner"]);
    expect(await store.getGrant("github:1")).toEqual(ownerGrant);

    await store.putGrantIfOwned({ ...ownerGrant, key: "github:9", role: "admin", source: "operator" }, "org_acme", { actorUserId: "u_op" });
    const seated = (await add("owner", { key: "github:9", role: "member" }))!;
    expect([seated.status, (await json(seated)).error]).toEqual([409, "exists"]);
    expect(await store.getGrant("github:9")).toMatchObject({ role: "admin", source: "operator" });
    expect((await store.auditForOrg("org_acme", 20)).filter((e) => e.actorUserId === "u_github_1")).toEqual([]);
  });

  it("refuses a key granted in another org, and a cookie without the panel's Origin", async () => {
    const taken = (await add("owner", { key: "github:2", role: "member" }))!;
    expect([taken.status, (await json(taken)).error]).toEqual([409, "conflict"]);
    expect((await add("cookie-owner", { key: "github:9", role: "member" }, null))!.status).toBe(403);
    expect((await add("cookie-owner", { key: "github:9", role: "member" }))!.status).toBe(201);
  });

  it("refuses a body that is not the shape named, and a body past the bound", async () => {
    for (const body of [undefined, "null", { key: "mcfearsome", role: "member" }, { key: "github:9", role: "owner" }, { key: "github:9" }, { role: "member" }]) {
      expect((await add("owner", body))!.status, JSON.stringify(body)).toBe(400);
    }
    expect((await add("owner", { key: "github:9", role: "member", pad: "x".repeat(MAX_ORG_WRITE_BYTES) }))!.status).toBe(413);
    expect(await store.countOrgMembers("org_acme")).toBe(1);
  });

  it("is an admin's: a member, a free admin and an admin of an org with no record are refused", async () => {
    expect((await add("member", { key: "github:9", role: "member" }))!.status).toBe(403);
    expect((await add("free-admin", { key: "github:9", role: "member" }))!.status).toBe(403);
    expect((await add("unrecorded", { key: "github:9", role: "member" }))!.status).toBe(404);
    expect(await store.getGrant("github:9")).toBeUndefined();
  });
});

describe("PATCH /org/members/:key", () => {
  beforeEach(async () => {
    await store.putGrantIfOwned({ ...ownerGrant, key: "github:9", role: "member", source: "org" }, "org_acme", { actorUserId: "u_github_1" });
    await store.putGrantIfOwned({ ...ownerGrant, key: "email:bo@acme.test", role: "member", source: "org" }, "org_acme", { actorUserId: "u_github_1" });
  });

  it("changes a member's role, by a percent-encoded key", async () => {
    const res = (await call("owner", "/org/members/github%3A9", "PATCH", { role: "admin" }))!;
    expect([res.status, (await json(res)).member]).toEqual([200, expect.objectContaining({ key: "github:9", role: "admin" })]);
    expect(await store.getGrant("github:9")).toMatchObject({ role: "admin", source: "org" });
    expect((await call("owner", "/org/members/email%3Abo%40acme.test", "PATCH", { role: "admin" }))!.status).toBe(200);
  });

  it("keeps the owner an admin, and knows no stranger's key", async () => {
    const owner = (await call("admin-2", "/org/members/github%3A1", "PATCH", { role: "member" }))!;
    expect([owner.status, (await json(owner)).error]).toEqual([409, "owner"]);
    expect(await store.getGrant("github:1")).toMatchObject({ role: "admin" });
    expect((await call("owner", "/org/members/github%3A2", "PATCH", { role: "admin" }))!.status).toBe(404);
    expect((await call("owner", "/org/members/github%3A404", "PATCH", { role: "admin" }))!.status).toBe(404);
    expect((await call("owner", "/org/members/github%3A9", "PATCH", { role: "boss" }))!.status).toBe(400);
    expect((await call("owner", "/org/members/u_%E0%A4%A", "PATCH", { role: "admin" }))!.status).toBe(400);
  });
});

describe("DELETE /org/members/:key", () => {
  beforeEach(async () => {
    await store.putGrantIfOwned({ ...ownerGrant, key: "github:9", role: "admin", source: "org" }, "org_acme", { actorUserId: "u_github_1" });
    await store.putGrantIfOwned({ ...ownerGrant, key: "email:bo@acme.test", role: "member", source: "org" }, "org_acme", { actorUserId: "u_github_1" });
  });

  it("removes a member and frees the seat, an admin removing themselves included", async () => {
    expect((await call("owner", "/org/members/email%3Abo%40acme.test", "DELETE"))!.status).toBe(204);
    expect((await json(await call("owner", "/org"))).seats_used).toBe(2);
    expect((await store.auditForOrg("org_acme", 20)).at(-1)).toMatchObject({ action: "plan_revoked", actorUserId: "u_github_1", detail: { key: "email:bo@acme.test" } });
    expect((await call("admin-2", "/org/members/github%3A9", "DELETE"))!.status).toBe(204);
    expect(await store.getGrant("github:9")).toBeUndefined();
  });

  it("keeps the owner, knows no other org's key, and refuses a cookie without the panel's Origin", async () => {
    const owner = (await call("admin-2", "/org/members/github%3A1", "DELETE"))!;
    expect([owner.status, (await json(owner)).error]).toEqual([409, "owner"]);
    expect((await call("owner", "/org/members/github%3A2", "DELETE"))!.status).toBe(404);
    expect(await store.getGrant("github:2")).toMatchObject({ orgId: "org_b" });
    expect((await call("cookie-owner", "/org/members/github%3A9", "DELETE", undefined, null))!.status).toBe(403);
    expect((await call("member", "/org/members/github%3A9", "DELETE"))!.status).toBe(403);
    expect(await store.getGrant("github:9")).toBeDefined();
  });
});
