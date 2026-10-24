/**
 * The org routes (orgs spec, D6), driven as the Worker drives them: a Request in, a Response out,
 * over a MemoryStore, with the org created the way the operator's route creates it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_ORG_WRITE_BYTES, orgRoutes, type OrgRouteDeps } from "../src/http/orgs.js";
import type { RoomCaller } from "../src/http/rooms.js";
import { DNS_JSON } from "../src/oauth/dns.js";
import { scimIntent } from "../src/grant-audit.js";
import { ssoUserId } from "../src/oauth/providers.js";
import { INVITE_TTL_MS, RESEND_COOLDOWN_MS, policyView } from "../src/orgs.js";
import { verifyInviteLink, type InviteMailer } from "../src/invite-mail.js";
import { isSealed, unseal } from "../src/oauth/sealed.js";
import { sha256Base64url } from "../src/oauth/tokens.js";
import { MemoryStore } from "../src/store.js";
import { DEFAULT_POLICY, type Identity, type Org, type PlanGrant } from "../src/types.js";

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
  createdAt: Date.parse("2026-10-21T00:00:00Z"), requireSso: false, domains: [], policy: DEFAULT_POLICY,
};
const ownerGrant: PlanGrant = {
  key: "github:1", plan: "team", role: "admin", orgId: "org_acme", source: "operator",
  grantedAt: 1, grantedBy: "u_op", expiresAt: null,
};

const SEAL = "test-seal-secret";
const IDP = "https://idp.test";

/** The fake IdP's discovery document and the fake resolver, at the fetch boundary (SSO spec, D9, D11). */
let dns: { answers: string[]; status: number };
const fakeFetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url === `${IDP}/.well-known/openid-configuration`) {
    return Response.json({ issuer: IDP, authorization_endpoint: `${IDP}/authorize`, token_endpoint: `${IDP}/token`, userinfo_endpoint: `${IDP}/userinfo` });
  }
  if (url === "https://bad.test/.well-known/openid-configuration") return Response.json({ issuer: "https://other.test", authorization_endpoint: `${IDP}/a`, token_endpoint: `${IDP}/t` });
  if (url.startsWith(DNS_JSON)) {
    if (dns.status !== 200) return new Response("down", { status: dns.status });
    return Response.json({ Status: 0, Answer: dns.answers.map((data) => ({ name: "_bellman.acme.test", type: 16, data })) });
  }
  return new Response("unexpected", { status: 500 });
}) as typeof fetch;

let store: MemoryStore;
let deps: OrgRouteDeps;
let mail: ReturnType<typeof vi.fn<InviteMailer>>;
beforeEach(async () => {
  store = new MemoryStore();
  dns = { answers: [], status: 200 };
  mail = vi.fn<InviteMailer>(async () => true);
  deps = { store, caller, panelOrigins: [PANEL], sealSecret: SEAL, fetchImpl: fakeFetch, issuer: ISSUER, linkSecret: "link-secret", mail };
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
      source: "purchase", created_at: "2026-10-21T00:00:00.000Z", require_sso: false, domains: [], your_role: "admin", policy: policyView(DEFAULT_POLICY),
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
    for (const body of [{ name: "" }, { name: "a".repeat(81) }, { name: "Ac\u202eme" }, { name: "Acme\u200b" }, {}, { seats: 9 }, "null", "[]"]) {
      expect((await call("owner", "/org", "PATCH", body))!.status, JSON.stringify(body)).toBe(400);
    }
    expect((await call("member", "/org", "PATCH", { name: "X" }))!.status).toBe(403);
    expect((await store.getOrg("org_acme"))?.name).toBe("Acme");
  });
  it("sets policy fields for an admin, merging over the rest, and shows them to a member on GET", async () => {
    const res = (await call("owner", "/org", "PATCH", { policy: { require_org_only: true, forbidden_capabilities: ["request_actions"] } }))!;
    expect([res.status, (await json(res)).policy]).toEqual([200, { require_org_only: true, forbidden_capabilities: ["request_actions"], allowed_counterparty_orgs: null, who_may_create: "any_member", allow_operator_impersonation: true }]);
    await call("owner", "/org", "PATCH", { policy: { allowed_counterparty_orgs: ["org_b"] }, name: "Acme Ltd" });
    expect((await json(await call("member", "/org"))).policy).toMatchObject({ require_org_only: true, allowed_counterparty_orgs: ["org_b"] });
    expect((await store.auditForOrg("org_acme", 10)).at(-1)).toMatchObject({ action: "org_updated", detail: { name: "Acme Ltd", policy: { allowed_counterparty_orgs: ["org_b"] } } });
  });

  it("refuses a policy that is empty, names a stray field, or gives a field the wrong shape, and a member", async () => {
    for (const [body, error] of [
      [{ policy: {} }, "policy names no field"],
      [{ policy: { who_may_create: "owner" } }, "who_may_create must be any_member or admins_only"],
      [{ policy: { allowed_counterparty_orgs: ["not an org"] } }, "allowed_counterparty_orgs must be null or a list of at most 50 distinct org ids"],
      [{ policy: null }, "policy must be an object"],
    ] as [unknown, string][]) {
      const res = (await call("owner", "/org", "PATCH", body))!;
      expect([res.status, await said(res)], JSON.stringify(body)).toEqual([400, error]);
    }
    expect((await call("member", "/org", "PATCH", { policy: { require_org_only: true } }))!.status).toBe(403);
    expect((await store.getOrg("org_acme"))?.policy).toEqual(DEFAULT_POLICY);
  });
});

describe("GET /org/members", () => {
  it("lists the org's grants as members, the owner marked, and its invites after them, for an admin", async () => {
    await store.claimDomain("org_acme", "acme.test", "tok", 1, { actorUserId: "u_op" });
    await store.verifyDomain("org_acme", "acme.test", 2, { actorUserId: "u_op" });
    await store.putGrantIfOwned({ ...ownerGrant, key: "email:bo@acme.test", role: "member", source: "org" }, "org_acme", { actorUserId: "u_github_1" });
    await store.putOrgInvite({ orgId: "org_acme", key: "github:9", role: "admin", invitedBy: "u_github_1", invitedAt: 2, expiresAt: Date.now() + INVITE_TTL_MS }, { actorUserId: "u_github_1" });
    const res = (await call("admin-2", "/org/members"))!;
    expect([res.status, await res.json()]).toEqual([200, { members: [
      { key: "github:1", user_id: "u_github_1", role: "admin", plan: "team", source: "operator", granted_at: "1970-01-01T00:00:00.001Z", expires_at: null, owner: true, status: "member" },
      { key: "email:bo@acme.test", user_id: null, role: "member", plan: "team", source: "org", granted_at: "1970-01-01T00:00:00.001Z", expires_at: null, owner: false, status: "member" },
      { key: "github:9", user_id: "u_github_9", role: "admin", status: "invited", invited_at: "1970-01-01T00:00:00.002Z", invited_by: "u_github_1", expires_at: expect.any(String) },
    ] }]);
  });

  it("lists an expired invite as expired, with its expiry, so the admin can resend or withdraw it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(1_000_000);
    await call("owner", "/org/members", "POST", { key: "github:9", role: "member" });
    vi.setSystemTime(1_000_000 + INVITE_TTL_MS + 1);
    const { members } = await json(await call("owner", "/org/members")) as { members: { key: string; status: string; expires_at: string }[] };
    const row = members.find((m) => m.key === "github:9")!;
    expect([row.status, row.expires_at]).toEqual(["expired", new Date(1_000_000 + INVITE_TTL_MS).toISOString()]);
    vi.useRealTimers();
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
  /** acme.test proven, so an address under it is the org's by its form (ADR 0027). */
  const verified = async () => {
    await store.claimDomain("org_acme", "acme.test", "tok", 1, { actorUserId: "u_op" });
    await store.verifyDomain("org_acme", "acme.test", 2, { actorUserId: "u_op" });
  };

  it("seats an address on a verified domain as a team grant from this org, until the seats run out", async () => {
    await verified();
    const res = (await add("owner", { key: "email:bo@acme.test", role: "member" }))!;
    expect([res.status, await res.json()]).toEqual([201, { member: {
      key: "email:bo@acme.test", user_id: null, role: "member", plan: "team", source: "org", granted_at: expect.any(String), expires_at: null, owner: false, status: "member",
    } }]);
    expect(await store.getGrant("email:bo@acme.test")).toMatchObject({ plan: "team", orgId: "org_acme", source: "org", grantedBy: "u_github_1" });
    expect((await add("owner", { key: "email:Cy@ACME.test", role: "admin" }))!.status).toBe(201);
    const full = (await add("owner", { key: "email:di@acme.test", role: "member" }))!;
    expect([full.status, await full.json()]).toEqual([409, { error: "full", error_description: "this org holds 3 of 3 seats", seats: 3, seats_used: 3 }]);
    expect(await store.getGrant("email:di@acme.test")).toBeUndefined();
  });

  /**
   * Any other key names a person the org does not own (ADR 0027): the admin offers a seat, and nothing
   * of the org reaches them until they accept it. A provider subject, an address under no domain the org
   * proved, one under a domain it only claimed, a provider-scoped address, and a key another org holds.
   */
  it("invites every key the org does not own by its form: no grant, no seat, a 202 the roster lists", async () => {
    await store.claimDomain("org_acme", "claimed.test", "tok", 1, { actorUserId: "u_op" });
    const keys = ["github:9", "google:118", "email:bo@elsewhere.test", "email:bo@claimed.test", "github:bo@acme.test", "github:2"];
    for (const key of keys) {
      const res = (await add("owner", { key, role: "member" }))!;
      expect([res.status, await res.json()], key).toEqual([202, { member: {
        key, user_id: /^(github|google):\d+$/.test(key) ? `u_${key.replace(":", "_")}` : null, role: "member", status: "invited",
        invited_at: expect.any(String), invited_by: "u_github_1", expires_at: expect.any(String),
      }, link: expect.stringMatching(`^${ISSUER}/invite/`), mailed: key.startsWith("email:") }]);
    }
    for (const key of keys.slice(0, -1)) expect(await store.getGrant(key), key).toBeUndefined();
    expect(await store.getGrant("github:2")).toMatchObject({ orgId: "org_b" });
    expect(await store.countOrgMembers("org_acme")).toBe(1);
    const roster = (await json(await call("owner", "/org/members"))).members as { key: string; status: string }[];
    expect(roster.map((m) => [m.key, m.status])).toEqual([["github:1", "member"], ...[...keys].sort().map((k) => [k, "invited"])]);
    expect((await store.auditForOrg("org_acme", 50)).filter((e) => e.action === "member_invited")).toHaveLength(keys.length);
    expect((await store.auditForOrg("org_acme", 50)).filter((e) => e.action === "plan_granted" && e.actorUserId === "u_github_1")).toEqual([]);
  });

  it("refuses a second invite of one key, keeping the first offer's role", async () => {
    expect((await add("owner", { key: "github:9", role: "admin" }))!.status).toBe(202);
    const again = (await add("admin-2", { key: "github:9", role: "member" }))!;
    expect([again.status, (await json(again)).error]).toEqual([409, "exists"]);
    expect(await store.listOrgInvites("org_acme", 10)).toEqual([expect.objectContaining({ key: "github:9", role: "admin", invitedBy: "u_github_1" })]);
  });

  /** An sso key names its org: seated elsewhere, the person would sign in through their own IdP and land in the wrong org. */
  it("seats an IdP subject of this org, and refuses one of another org's", async () => {
    const foreign = (await add("owner", { key: "sso:org_b:00u9", role: "member" }))!;
    expect([foreign.status, await said(foreign)]).toEqual([400, expect.stringContaining("another org")]);
    expect(await store.getGrant("sso:org_b:00u9")).toBeUndefined();
    const own = (await add("owner", { key: "sso:org_acme:00u9", role: "admin" }))!;
    expect([own.status, ((await json(own)).member as { user_id: string }).user_id]).toEqual([201, ssoUserId("org_acme", "00u9")]);
  });

  it("writes a grant that is this org's, whatever the body says of plan, org or source", async () => {
    await verified();
    const res = (await add("owner", { key: "email:bo@acme.test", role: "member", plan: "max", orgId: "org_b", source: "purchase", expiresAt: 5 }))!;
    expect(res.status).toBe(201);
    expect(await store.getGrant("email:bo@acme.test")).toMatchObject({ plan: "team", orgId: "org_acme", source: "org", expiresAt: null });
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

  it("refuses an owned key granted in another org, and a cookie without the panel's Origin", async () => {
    await verified();
    await store.putGrantIfOwned({ ...ownerGrant, key: "email:bo@acme.test", role: "member", orgId: "org_b" }, "org_b", { actorUserId: "u_github_2" });
    const taken = (await add("owner", { key: "email:bo@acme.test", role: "member" }))!;
    expect([taken.status, (await json(taken)).error]).toEqual([409, "conflict"]);
    expect((await add("cookie-owner", { key: "github:9", role: "member" }, null))!.status).toBe(403);
    expect((await add("cookie-owner", { key: "github:9", role: "member" }))!.status).toBe(202);
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
    expect(await store.invitesFor(["github:9"])).toEqual([]);
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

  it("withdraws an invite, once, recording the admin who did", async () => {
    await store.putOrgInvite({ orgId: "org_acme", key: "google:118", role: "member", invitedBy: "u_github_1", invitedAt: 3, expiresAt: Date.now() + INVITE_TTL_MS }, { actorUserId: "u_github_1" });
    await store.putOrgInvite({ orgId: "org_b", key: "google:118", role: "member", invitedBy: "u_github_2", invitedAt: 3, expiresAt: Date.now() + INVITE_TTL_MS }, { actorUserId: "u_github_2" });
    expect((await call("admin-2", "/org/members/google%3A118", "DELETE"))!.status).toBe(204);
    expect(await store.listOrgInvites("org_acme", 10)).toEqual([]);
    expect(await store.listOrgInvites("org_b", 10)).toEqual([expect.objectContaining({ key: "google:118" })]);
    expect((await store.auditForOrg("org_acme", 20)).at(-1)).toMatchObject({ action: "invite_withdrawn", actorUserId: "u_github_9", detail: { key: "google:118" } });
    expect((await call("admin-2", "/org/members/google%3A118", "DELETE"))!.status).toBe(404);
    expect((await call("member", "/org/members/google%3A118", "DELETE"))!.status).toBe(403);
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

describe("invitations by link and email (ADR 0036)", () => {
  const invite = (key = "email:ana@example.com") => call("owner", "/org/members", "POST", { key, role: "member" });
  const resend = (who: string, key = "email%3Aana%40example.com", origin: string | null = PANEL) =>
    call(who, `/org/members/${key}/resend`, "POST", undefined, origin);
  const fill = async () => {
    await store.putGrantIfOwned({ ...ownerGrant, key: "github:9", role: "member", source: "org" }, "org_acme", { actorUserId: "u_github_1" });
    await store.putGrantIfOwned({ ...ownerGrant, key: "github:8", role: "member", source: "org" }, "org_acme", { actorUserId: "u_github_1" });
  };

  it("mails an address its link, and answers the link and that it was mailed", async () => {
    const res = (await invite())!;
    expect(res.status).toBe(202);
    const body = await json(res) as { member: { status: string }; link: string; mailed: boolean };
    expect([body.member.status, body.mailed]).toEqual(["invited", true]);
    expect(await verifyInviteLink(body.link.slice(`${ISSUER}/invite/`.length), ISSUER, "link-secret"))
      .toEqual({ orgId: "org_acme", key: "email:ana@example.com", at: expect.any(Number) });
    expect(mail).toHaveBeenCalledWith("ana@example.com", expect.objectContaining({ orgId: "org_acme" }),
      expect.objectContaining({ key: "email:ana@example.com" }), body.link);
  });

  it("refuses an address that is not one plain address, before any invite or mail", async () => {
    for (const key of ["email:ana@example.com, eve@evil.test", "email:Ana <ana@example.com>", "email:ana@example.com\nBcc: eve@evil.test"]) {
      const res = (await invite(key))!;
      expect([key, res.status, (await json(res)).error]).toEqual([key, 400, "invalid_request"]);
    }
    expect(mail).not.toHaveBeenCalled();
    expect(await store.listOrgInvites("org_acme", 10)).toEqual([]);
  });

  it("answers mailed false, and still the link and the invite, when nothing could send", async () => {
    mail.mockResolvedValueOnce(false);
    const body = await json(await invite());
    expect([body.mailed, typeof body.link]).toEqual([false, "string"]);
    expect((await store.listOrgInvites("org_acme", 10)).map((i) => i.key)).toEqual(["email:ana@example.com"]);
  });

  it("mails nothing for a subject key, and answers its link for the admin to hand on", async () => {
    const body = await json(await invite("github:77"));
    expect([body.mailed, typeof body.link]).toEqual([false, "string"]);
    expect(mail).not.toHaveBeenCalled();
  });

  it("answers link null, and mails nothing, on a server with no token secret", async () => {
    deps = { ...deps, linkSecret: undefined };
    const body = await json(await invite());
    expect([body.link, body.mailed]).toEqual([null, false]);
    expect(mail).not.toHaveBeenCalled();
  });

  it("refuses to invite into a full org, before any mail", async () => {
    await fill();
    const res = (await invite())!;
    expect([res.status, (await json(res)).error]).toEqual([409, "full"]);
    expect(mail).not.toHaveBeenCalled();
    expect(await store.listOrgInvites("org_acme", 10)).toEqual([]);
  });

  it("resends: a fresh link mailed, the roster's time moved, 200 with the same body as the 202", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1_000_000);
      const first = await json(await invite());
      vi.setSystemTime(1_000_000 + RESEND_COOLDOWN_MS + 1);
      const res = (await resend("admin-2"))!;
      expect(res.status).toBe(200);
      const body = await json(res) as { member: Record<string, string>; link: string; mailed: boolean };
      expect(Object.keys(body).sort()).toEqual(Object.keys(first).sort());
      expect(body.member).toMatchObject({ status: "invited", invited_by: "u_github_9",
        invited_at: new Date(1_000_000 + RESEND_COOLDOWN_MS + 1).toISOString(),
        expires_at: new Date(1_000_000 + RESEND_COOLDOWN_MS + 1 + INVITE_TTL_MS).toISOString() });
      expect(body.mailed).toBe(true);
      expect(body.link).not.toBe(first.link);
      expect(mail).toHaveBeenCalledTimes(2);
      expect(mail).toHaveBeenLastCalledWith("ana@example.com", expect.anything(), expect.anything(), body.link);
      const listed = (await json(await call("owner", "/org/members"))).members as { key: string; invited_at?: string }[];
      expect(listed.find((m) => m.key === "email:ana@example.com")!.invited_at).toBe(body.member.invited_at);
      expect((await store.auditForOrg("org_acme", 20)).at(-1)).toMatchObject({ action: "invite_resent", actorUserId: "u_github_9", detail: { key: "email:ana@example.com" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a resend within ten minutes of the last, and one for a key not invited", async () => {
    await invite();
    const soon = (await resend("owner"))!;
    expect([soon.status, (await json(soon)).error]).toEqual([429, "cooldown"]);
    expect(Number(soon.headers.get("retry-after"))).toBeGreaterThan(RESEND_COOLDOWN_MS / 1000 - 5);
    expect(Number(soon.headers.get("retry-after"))).toBeLessThanOrEqual(RESEND_COOLDOWN_MS / 1000);
    const missing = (await resend("owner", "github%3A77"))!;
    expect([missing.status, (await json(missing)).error]).toEqual([404, "missing"]);
    expect(mail).toHaveBeenCalledTimes(1);
  });

  it("resends an expired invite, which is then open again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1_000_000);
      await invite();
      vi.setSystemTime(1_000_000 + INVITE_TTL_MS + 1);
      const status = async () => ((await json(await call("owner", "/org/members"))).members as { key: string; status: string }[])
        .find((m) => m.key === "email:ana@example.com")!.status;
      expect(await status()).toBe("expired");
      expect((await resend("owner"))!.status).toBe(200);
      expect(await status()).toBe("invited");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a resend into a full org, before any mail", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1_000_000);
      await invite();
      await fill();
      vi.setSystemTime(1_000_000 + RESEND_COOLDOWN_MS + 1);
      const res = (await resend("owner"))!;
      expect([res.status, (await json(res)).error]).toEqual([409, "full"]);
      expect(mail).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gates a resend as the other writes: a member, a cookie with no Origin, another org's admin", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1_000_000);
      await invite();
      vi.setSystemTime(1_000_000 + RESEND_COOLDOWN_MS + 1);
      expect((await resend("member"))!.status).toBe(403);
      expect((await resend("cookie-owner", undefined, null))!.status).toBe(403);
      expect((await resend("admin-b"))!.status).toBe(404);
      expect((await call("owner", "/org/members/email%3Aana%40example.com/resend", "GET"))!.status).toBe(405);
      expect(mail).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the IdP (SSO spec, D9, D14)", () => {
  const put = (who: string, body: unknown) => call(who, "/org/idp", "PUT", body);
  const config = { issuer: IDP, client_id: "0oa", client_secret: "shh" };

  it("discovers, seals and stores an IdP, and shows it back without the secret", async () => {
    expect(await json(await call("owner", "/org/idp"))).toEqual({ idp: null });
    const res = (await put("owner", config))!;
    expect([res.status, await res.json()]).toEqual([200, { idp: {
      protocol: "oidc", issuer: IDP, client_id: "0oa", client_secret_set: true, token_auth: "client_secret_basic",
      authorization_endpoint: `${IDP}/authorize`, token_endpoint: `${IDP}/token`, userinfo_endpoint: `${IDP}/userinfo`,
      configured_at: expect.any(String), configured_by: "u_github_1",
    } }]);
    const stored = (await store.getOrgIdp("org_acme"))!;
    expect(isSealed(stored.clientSecret)).toBe(true);
    expect(await unseal(SEAL, stored.clientSecret)).toBe("shh");
    expect(JSON.stringify(await json(await call("owner", "/org/idp")))).not.toContain("shh");
    expect((await store.auditForOrg("org_acme", 20)).at(-1)).toMatchObject({ action: "idp_configured", actorUserId: "u_github_1", detail: { issuer: IDP } });
  });

  it("refuses an issuer discovery cannot use, a missing field, an oversized secret, and a non-admin", async () => {
    const bad = (await put("owner", { ...config, issuer: "https://bad.test" }))!;
    expect([bad.status, (await json(bad)).error]).toEqual([400, "discovery"]);
    for (const body of [{ client_id: "0oa", client_secret: "shh" }, { ...config, client_secret: "" }, { ...config, client_secret: "x".repeat(1025) }, { ...config, client_id: 5 }]) {
      expect((await put("owner", body))!.status, JSON.stringify(body)).toBe(400);
    }
    expect((await put("member", config))!.status).toBe(403);
    expect((await call("cookie-owner", "/org/idp", "PUT", config, null))!.status).toBe(403);
    expect(await store.getOrgIdp("org_acme")).toBeUndefined();
  });

  it("removes the IdP, unless single sign-on is required", async () => {
    await put("owner", config);
    await store.claimDomain("org_acme", "acme.test", "tok", 1, { actorUserId: "u_op" });
    await store.verifyDomain("org_acme", "acme.test", 2, { actorUserId: "u_op" });
    await store.updateOrg("org_acme", { requireSso: true }, { actorUserId: "u_op" });
    const held = (await call("owner", "/org/idp", "DELETE"))!;
    expect([held.status, (await json(held)).error]).toEqual([409, "require_sso"]);
    await store.updateOrg("org_acme", { requireSso: false }, { actorUserId: "u_op" });
    expect((await call("owner", "/org/idp", "DELETE"))!.status).toBe(204);
    expect((await call("owner", "/org/idp", "DELETE"))!.status).toBe(404);
    expect(await store.getOrgIdp("org_acme")).toBeUndefined();
  });
});

describe("domains (SSO spec, D11)", () => {
  const claim = (who: string, domain: unknown) => call(who, "/org/domains", "POST", { domain });

  it("claims a domain and hands back the record to publish, once", async () => {
    const res = (await claim("owner", "ACME.test"))!;
    const body = await res.json() as { domain: string; verified_at: null; record: { name: string; type: string; value: string } };
    expect([res.status, body.domain, body.verified_at, body.record.name, body.record.type]).toEqual([201, "acme.test", null, "_bellman.acme.test", "TXT"]);
    expect(body.record.value).toMatch(/^bellman-verify=[A-Za-z0-9_-]{22}$/);
    expect((await json(await call("owner", "/org"))).domains).toEqual([{ domain: "acme.test", verified_at: null }]);
    const again = (await claim("owner", "acme.test"))!;
    expect([again.status, (await json(again)).error]).toEqual([409, "exists"]);
    for (const bad of ["acme", "-acme.com", 5, ""]) expect((await claim("owner", bad))!.status, String(bad)).toBe(400);
    expect((await claim("member", "acme.test"))!.status).toBe(403);
  });

  it("verifies a claim against the record, saying what it found when it is not there", async () => {
    const value = ((await (await claim("owner", "acme.test"))!.json()) as { record: { value: string } }).record.value;
    dns.answers = ['"v=spf1 -all"'];
    const not = (await call("owner", "/org/domains/acme.test/verify", "POST"))!;
    expect([not.status, await not.json()]).toEqual([409, { error: "unverified", error_description: expect.stringContaining("_bellman.acme.test"), found: ["v=spf1 -all"] }]);
    dns.answers = ['"v=spf1 -all"', `"${value}"`];
    const yes = (await call("owner", "/org/domains/acme.test/verify", "POST"))!;
    expect([yes.status, await yes.json()]).toEqual([200, { domain: "acme.test", verified_at: expect.any(String) }]);
    expect(await store.orgForDomain("acme.test")).toBe("org_acme");
    expect((await call("owner", "/org/domains/nobody.test/verify", "POST"))!.status).toBe(404);
    dns.status = 503;
    const down = (await call("owner", "/org/domains/acme.test/verify", "POST"))!;
    expect([down.status, (await json(down)).error]).toEqual([502, "dns"]);
  });

  it("answers taken when another org verified the domain first", async () => {
    await store.claimDomain("org_b", "acme.test", "theirs", 1, { actorUserId: "u_op" });
    await store.verifyDomain("org_b", "acme.test", 2, { actorUserId: "u_op" });
    const value = ((await (await claim("owner", "acme.test"))!.json()) as { record: { value: string } }).record.value;
    dns.answers = [`"${value}"`];
    const taken = (await call("owner", "/org/domains/acme.test/verify", "POST"))!;
    expect([taken.status, (await json(taken)).error]).toEqual([409, "taken"]);
  });

  it("releases a claim, unless it is the last verified domain while single sign-on is required", async () => {
    await claim("owner", "acme.test");
    await store.verifyDomain("org_acme", "acme.test", 2, { actorUserId: "u_op" });
    await store.putOrgIdp("org_acme", { protocol: "oidc", issuer: IDP, clientId: "0oa", clientSecret: "v1.x.y", tokenAuth: "client_secret_basic", authorizationEndpoint: `${IDP}/a`, tokenEndpoint: `${IDP}/t`, userinfoEndpoint: null, configuredAt: 1, configuredBy: "u_op" }, { actorUserId: "u_op" });
    await store.updateOrg("org_acme", { requireSso: true }, { actorUserId: "u_op" });
    const held = (await call("owner", "/org/domains/acme.test", "DELETE"))!;
    expect([held.status, (await json(held)).error]).toEqual([409, "require_sso"]);
    await claim("owner", "acme.dev");
    await store.verifyDomain("org_acme", "acme.dev", 3, { actorUserId: "u_op" });
    expect((await call("owner", "/org/domains/acme.test", "DELETE"))!.status).toBe(204);
    expect(await store.orgForDomain("acme.test")).toBeUndefined();
    expect((await call("owner", "/org/domains/acme.test", "DELETE"))!.status).toBe(404);
    expect((await call("cookie-owner", "/org/domains/acme.dev", "DELETE", undefined, null))!.status).toBe(403);
  });
});

describe("PATCH /org { require_sso } (SSO spec, D13)", () => {
  it("turns single sign-on on only with an IdP and a verified domain, and off at any time", async () => {
    const on = { require_sso: true };
    const bare = (await call("owner", "/org", "PATCH", on))!;
    expect([bare.status, (await json(bare)).error]).toEqual([409, "require_sso"]);
    await store.putOrgIdp("org_acme", { protocol: "oidc", issuer: IDP, clientId: "0oa", clientSecret: "v1.x.y", tokenAuth: "client_secret_basic", authorizationEndpoint: `${IDP}/a`, tokenEndpoint: `${IDP}/t`, userinfoEndpoint: null, configuredAt: 1, configuredBy: "u_op" }, { actorUserId: "u_op" });
    expect((await call("owner", "/org", "PATCH", on))!.status).toBe(409);
    await store.claimDomain("org_acme", "acme.test", "tok", 1, { actorUserId: "u_op" });
    expect((await call("owner", "/org", "PATCH", on))!.status).toBe(409);
    await store.verifyDomain("org_acme", "acme.test", 2, { actorUserId: "u_op" });
    const res = (await call("owner", "/org", "PATCH", { ...on, name: "Acme SSO" }))!;
    expect([res.status, await json(res)]).toEqual([200, expect.objectContaining({ require_sso: true, name: "Acme SSO" })]);
    expect((await call("owner", "/org", "PATCH", { require_sso: "yes" }))!.status).toBe(400);
    expect((await call("owner", "/org", "PATCH", { require_sso: false }))!.status).toBe(200);
    expect((await store.getOrg("org_acme"))?.requireSso).toBe(false);
  });
});

describe("SCIM (SCIM spec, D1, D10)", () => {
  it("tells an admin whether a token is set, and a member nothing", async () => {
    expect((await call("member", "/org/scim"))!.status).toBe(403);
    expect(await json(await call("owner", "/org/scim"))).toEqual({ base_url: `${ISSUER}/scim/v2`, token_set: false, issued_at: null, issued_by: null });
    const res = (await call("owner", "/org/scim", "DELETE"))!;
    expect([res.status, res.headers.get("allow")]).toEqual([405, "GET"]);
  });

  it("issues a token once, replaces it on a second issue, and revokes it", async () => {
    const first = (await call("owner", "/org/scim/token", "POST"))!;
    const issued = await json(first);
    expect(first.status).toBe(201);
    expect(issued).toMatchObject({ replaced: false, issued_by: "u_github_1", base_url: `${ISSUER}/scim/v2` });
    expect(issued.token).toMatch(/^bst_[A-Za-z0-9_-]{43}$/);
    expect(await store.orgForScimToken(await sha256Base64url(issued.token as string))).toBe("org_acme");
    expect(await json(await call("owner", "/org/scim"))).toMatchObject({ token_set: true, issued_by: "u_github_1" });
    const second = await json(await call("admin-2", "/org/scim/token", "POST"));
    expect(second).toMatchObject({ replaced: true, issued_by: "u_github_9" });
    expect(await store.orgForScimToken(await sha256Base64url(issued.token as string))).toBeUndefined();
    expect(await store.orgForScimToken(await sha256Base64url(second.token as string))).toBe("org_acme");
    expect((await store.auditForOrg("org_acme", 20)).filter((e) => e.action === "scim_token_issued").map((e) => e.detail.replaced)).toEqual([false, true]);
    expect((await call("owner", "/org/scim/token", "DELETE"))!.status).toBe(204);
    expect(await store.orgForScimToken(await sha256Base64url(second.token as string))).toBeUndefined();
    expect((await call("owner", "/org/scim/token", "DELETE"))!.status).toBe(404);
    expect((await store.auditForOrg("org_acme", 20)).at(-1)).toMatchObject({ action: "scim_token_revoked", actorUserId: "u_github_1" });
  });

  it("refuses a cookie without the panel's Origin, a member, and an org with no record", async () => {
    expect((await call("cookie-owner", "/org/scim/token", "POST", undefined, null))!.status).toBe(403);
    expect((await call("member", "/org/scim/token", "POST"))!.status).toBe(403);
    expect((await call("unrecorded", "/org/scim/token", "POST"))!.status).toBe(404);
    expect(await store.scimTokenOf("org_acme")).toBeUndefined();
  });

  it("leaves a member the IdP pushed to the IdP, and still removes one an admin seated", async () => {
    await store.createScimUser({
      id: "x1", orgId: "org_acme", userName: "bo@acme.test", externalId: null, active: true, key: "email:bo@acme.test", createdAt: 1, updatedAt: 1, deletedAt: null,
    }, scimIntent("org_acme"));
    const managed = (await call("owner", "/org/members/email%3Abo%40acme.test", "DELETE"))!;
    const refusal = await json(managed);
    expect([managed.status, refusal.error, refusal.error_description]).toEqual([409, "managed", "this member is provisioned by your identity provider; remove them there"]);
    expect(await store.getGrant("email:bo@acme.test")).toBeDefined();
    expect((await call("owner", "/org/members/email%3Abo%40acme.test", "PATCH", { role: "admin" }))!.status).toBe(200);
    await store.updateScimUser("org_acme", "x1", { active: false }, 2, scimIntent("org_acme"));
    // Seating a deactivated person by hand would make a member the IdP keeps refusing: they come back through the IdP.
    const dead = (await call("owner", "/org/members", "POST", { key: "email:bo@acme.test", role: "member" }))!;
    expect([dead.status, (await json(dead)).error]).toEqual([409, "managed"]);
    expect(await store.getGrant("email:bo@acme.test")).toBeUndefined();
    await store.putGrantIfOwned({ ...ownerGrant, key: "email:bo@acme.test", role: "member", source: "org" }, "org_acme", { actorUserId: "u_github_1" });
    expect((await call("owner", "/org/members/email%3Abo%40acme.test", "DELETE"))!.status).toBe(204);
  });
});
