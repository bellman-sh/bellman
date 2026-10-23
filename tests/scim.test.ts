/**
 * The SCIM routes (SCIM spec, D5 to D9), driven as the Worker drives them: a Request in, a Response out, over
 * a MemoryStore, with the org's token issued the way the org routes issue one. The deprovision walk over rooms
 * the person created and joined runs end to end here, over rooms the store holds.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { scimIntent } from "../src/grant-audit.js";
import { MAX_SCIM_BODY_BYTES, SCIM_PAGE_MAX, scimRoutes } from "../src/http/scim.js";
import { ssoUserId } from "../src/oauth/providers.js";
import { sha256Base64url } from "../src/oauth/tokens.js";
import { PATCH_SCHEMA, SCIM_JSON, USER_SCHEMA } from "../src/scim/resource.js";
import { MemoryStore } from "../src/store.js";
import type { Org, PlanGrant } from "../src/types.js";
import { DEFAULT_POLICY } from "../src/types.js";
import { member, session } from "./helpers/fixtures.js";

const ISSUER = "https://mcp.example.test";
const BASE = `${ISSUER}/scim/v2`;
const TOKEN_A = "bst_test-a";
const TOKEN_B = "bst_test-b";
const BO = ssoUserId("org_acme", "00u1");

const acme: Org = {
  orgId: "org_acme", name: "Acme", ownerUserId: "u_github_1", seats: 3, source: "operator", active: true,
  createdAt: 1, requireSso: false, domains: [], policy: DEFAULT_POLICY,
};
const ownerGrant: PlanGrant = { key: "github:1", plan: "team", role: "admin", orgId: "org_acme", source: "operator", grantedAt: 1, grantedBy: "u_op", expiresAt: null };

let store: MemoryStore;
beforeEach(async () => {
  store = new MemoryStore();
  await store.createOrg(acme, ownerGrant, { actorUserId: "u_op" });
  await store.createOrg({ ...acme, orgId: "org_b", name: "B", ownerUserId: "u_github_2" }, { ...ownerGrant, key: "github:2", orgId: "org_b" }, { actorUserId: "u_op" });
  await store.issueScimToken("org_acme", { tokenHash: await sha256Base64url(TOKEN_A), issuedAt: 2, issuedBy: "u_github_1" }, { actorUserId: "u_github_1" });
  await store.issueScimToken("org_b", { tokenHash: await sha256Base64url(TOKEN_B), issuedAt: 2, issuedBy: "u_github_2" }, { actorUserId: "u_github_2" });
});

const call = (token: string | null, path: string, method = "GET", body?: unknown, contentType = SCIM_JSON) => {
  const text = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  return scimRoutes(new Request(`${ISSUER}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(text === undefined ? {} : { "content-type": contentType, "content-length": String(new TextEncoder().encode(text).length) }),
    },
    body: text,
  }), { store });
};
const json = async (res: Response | undefined) => (await res!.json()) as Record<string, any>;
const push = async (userName: string, extra: Record<string, unknown> = {}, token = TOKEN_A) => {
  const res = (await call(token, "/scim/v2/Users", "POST", { schemas: [USER_SCHEMA], userName, ...extra }))!;
  return { res, body: await json(res) };
};
const patch = (id: string, operations: unknown[], token = TOKEN_A) => call(token, `/scim/v2/Users/${id}`, "PATCH", { schemas: [PATCH_SCHEMA], Operations: operations });
const actions = async (orgId = "org_acme") => (await store.auditForOrg(orgId, 100)).map((e) => e.action);

describe("the module's edge and discovery", () => {
  it("answers discovery to a token and nothing to none, and leaves other paths alone", async () => {
    expect(await call(TOKEN_A, "/scim/v1/Users")).toBeUndefined();
    expect(await call(TOKEN_A, "/org")).toBeUndefined();
    const spc = (await call(TOKEN_A, "/scim/v2/ServiceProviderConfig"))!;
    expect([spc.status, spc.headers.get("content-type")]).toEqual([200, SCIM_JSON]);
    expect(await spc.json()).toMatchObject({ patch: { supported: true }, filter: { maxResults: SCIM_PAGE_MAX } });
    expect((await json(await call(TOKEN_A, "/scim/v2/ResourceTypes"))).Resources.map((r: { id: string }) => r.id)).toEqual(["User"]);
    expect((await call(TOKEN_A, "/scim/v2/Schemas"))!.status).toBe(200);
    const none = (await call(null, "/scim/v2/Users"))!;
    expect([none.status, none.headers.get("content-type")]).toEqual([401, SCIM_JSON]);
    expect(await none.json()).toMatchObject({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "401" });
    expect((await call("bst_nobody", "/scim/v2/Users"))!.status).toBe(401);
    expect((await call(TOKEN_A, "/scim/v2/Nothing"))!.status).toBe(404);
    const method = (await call(TOKEN_A, "/scim/v2/ServiceProviderConfig", "POST", {}))!;
    expect([method.status, method.headers.get("allow")]).toEqual([405, "GET"]);
  });

  it("stops serving a token the org replaced", async () => {
    expect((await call(TOKEN_A, "/scim/v2/Users"))!.status).toBe(200);
    await store.issueScimToken("org_acme", { tokenHash: await sha256Base64url("bst_rotated"), issuedAt: 3, issuedBy: "u_github_1" }, { actorUserId: "u_github_1" });
    expect((await call(TOKEN_A, "/scim/v2/Users"))!.status).toBe(401);
    expect((await call("bst_rotated", "/scim/v2/Users"))!.status).toBe(200);
  });
});

describe("Users", () => {
  it("creates a user, answers it by id, and lists it with and without a filter", async () => {
    const { res, body } = await push("Bo@Acme.test", { externalId: "00u", name: { givenName: "Bo" } });
    expect(res.status).toBe(201);
    expect(res.headers.get("location")).toBe(`${BASE}/Users/${body.id}`);
    expect(body).toMatchObject({ schemas: [USER_SCHEMA], userName: "bo@acme.test", externalId: "00u", active: true, meta: { resourceType: "User", location: `${BASE}/Users/${body.id}` } });
    expect(await store.getGrant("email:bo@acme.test")).toMatchObject({ plan: "team", role: "member", orgId: "org_acme", source: "scim" });
    expect(await json(await call(TOKEN_A, `/scim/v2/Users/${body.id}`))).toEqual(body);
    expect(await json(await call(TOKEN_A, '/scim/v2/Users?filter=userName%20eq%20%22BO%40acme.test%22'))).toMatchObject({ totalResults: 1, startIndex: 1, itemsPerPage: 1, Resources: [{ id: body.id }] });
    expect(await json(await call(TOKEN_A, '/scim/v2/Users?filter=externalId%20eq%20%2200u%22'))).toMatchObject({ totalResults: 1, Resources: [{ id: body.id }] });
    expect(await json(await call(TOKEN_A, '/scim/v2/Users?filter=userName%20eq%20%22nobody%40acme.test%22'))).toMatchObject({ totalResults: 0, Resources: [] });
    const bad = (await call(TOKEN_A, "/scim/v2/Users?filter=active%20eq%20true"))!;
    expect([bad.status, (await bad.json()).scimType]).toEqual([400, "invalidFilter"]);
  });

  it("pages the list in id order and caps the page", async () => {
    const a = (await push("a@acme.test", { active: false })).body;
    const b = (await push("b@acme.test", { active: false })).body;
    const ids = [a.id, b.id].sort();
    expect((await json(await call(TOKEN_A, "/scim/v2/Users"))).Resources.map((r: { id: string }) => r.id)).toEqual(ids);
    expect(await json(await call(TOKEN_A, "/scim/v2/Users?startIndex=2&count=1"))).toMatchObject({ totalResults: 2, startIndex: 2, itemsPerPage: 1, Resources: [{ id: ids[1] }] });
    expect(await json(await call(TOKEN_A, "/scim/v2/Users?startIndex=3&count=1"))).toMatchObject({ totalResults: 2, startIndex: 3, itemsPerPage: 0 });
    expect(await json(await call(TOKEN_A, "/scim/v2/Users?count=500"))).toMatchObject({ itemsPerPage: 2 });
    expect(SCIM_PAGE_MAX).toBe(200);
  });

  it("refuses a second push of the same name, an address another org holds, and a full org", async () => {
    await push("bo@acme.test");
    const twice = await push("BO@acme.test");
    expect([twice.res.status, twice.body.scimType]).toEqual([409, "uniqueness"]);
    await store.putGrantIfOwned({ ...ownerGrant, key: "email:di@acme.test", role: "member", orgId: "org_b", source: "org" }, "org_b", { actorUserId: "u_github_2" });
    const theirs = await push("di@acme.test");
    expect([theirs.res.status, theirs.body.detail]).toEqual([409, "that address is a member of another org"]);
    await push("cy@acme.test");
    const full = await push("ed@acme.test");
    expect([full.res.status, full.body.detail]).toEqual([409, "this org holds 3 of 3 seats"]);
    expect(await store.scimUserByName("org_acme", "ed@acme.test")).toBeUndefined();
  });

  it("answers another org's id as a stranger", async () => {
    const { body } = await push("bo@acme.test");
    expect((await call(TOKEN_B, `/scim/v2/Users/${body.id}`))!.status).toBe(404);
    expect((await patch(body.id, [{ op: "replace", value: { active: false } }], TOKEN_B))!.status).toBe(404);
    expect((await call(TOKEN_B, `/scim/v2/Users/${body.id}`, "DELETE"))!.status).toBe(404);
    expect(await store.getGrant("email:bo@acme.test")).toMatchObject({ orgId: "org_acme" });
    expect((await json(await call(TOKEN_B, "/scim/v2/Users"))).totalResults).toBe(0);
  });

  it("deactivates by Okta's PATCH, by Entra's, by PUT, and a repeat is harmless", async () => {
    const { body } = await push("bo@acme.test", { externalId: "00u" });
    const okta = (await patch(body.id, [{ op: "replace", value: { active: false } }]))!;
    expect([okta.status, (await okta.json()).active]).toEqual([200, false]);
    expect(await store.getGrant("email:bo@acme.test")).toBeUndefined();
    const again = (await patch(body.id, [{ op: "Replace", path: "active", value: "False" }]))!;
    expect([again.status, (await again.json()).active]).toEqual([200, false]);
    expect((await actions()).filter((a) => a === "plan_revoked")).toHaveLength(1);
    const emails = (await patch(body.id, [{ op: "replace", path: 'emails[type eq "work"].value', value: "x@y.test" }]))!;
    expect([emails.status, (await emails.json()).userName]).toEqual([200, "bo@acme.test"]);
    const put = (await call(TOKEN_A, `/scim/v2/Users/${body.id}`, "PUT", { schemas: [USER_SCHEMA], id: body.id, userName: "bo@acme.test", externalId: "00u", active: true }))!;
    expect([put.status, (await put.json()).active]).toEqual([200, true]);
    expect(await store.getGrant("email:bo@acme.test")).toMatchObject({ source: "scim" });
    const entra = (await call(TOKEN_A, `/scim/v2/Users/${body.id}`, "PUT", { schemas: [USER_SCHEMA], userName: "bo@acme.test", active: "False" }))!;
    expect([entra.status, (await entra.json()).active]).toEqual([200, false]);
    const move = (await patch(body.id, [{ op: "move", path: "active", value: true }]))!;
    expect([move.status, (await move.json()).scimType]).toEqual([400, "invalidValue"]);
    const noOps = (await call(TOKEN_A, `/scim/v2/Users/${body.id}`, "PATCH", { schemas: [PATCH_SCHEMA] }))!;
    expect([noOps.status, (await noOps.json()).scimType]).toEqual([400, "invalidSyntax"]);
  });

  it("renames, and refuses a taken name", async () => {
    const { body } = await push("bo@acme.test");
    await push("cy@acme.test");
    const renamed = (await patch(body.id, [{ op: "replace", path: "userName", value: "Robert@acme.test" }]))!;
    expect([renamed.status, (await renamed.json()).userName]).toEqual([200, "robert@acme.test"]);
    expect(await store.getGrant("email:bo@acme.test")).toBeUndefined();
    expect(await store.getGrant("email:robert@acme.test")).toMatchObject({ source: "scim" });
    const taken = (await patch(body.id, [{ op: "replace", path: "userName", value: "cy@acme.test" }]))!;
    expect([taken.status, (await taken.json()).scimType]).toEqual([409, "uniqueness"]);
  });

  it("deletes a user, and a repeat is harmless", async () => {
    const { body } = await push("bo@acme.test");
    expect((await call(TOKEN_A, `/scim/v2/Users/${body.id}`, "DELETE"))!.status).toBe(204);
    expect((await call(TOKEN_A, `/scim/v2/Users/${body.id}`))!.status).toBe(404);
    expect((await call(TOKEN_A, `/scim/v2/Users/${body.id}`, "DELETE"))!.status).toBe(204);
    expect((await call(TOKEN_A, `/scim/v2/Users/nobody`, "DELETE"))!.status).toBe(404);
    expect(await store.getGrant("email:bo@acme.test")).toBeUndefined();
    expect((await json(await call(TOKEN_A, "/scim/v2/Users"))).totalResults).toBe(0);
    expect((await actions()).filter((a) => a === "plan_revoked" || a === "scim_user_deleted")).toEqual(["plan_revoked", "scim_user_deleted"]);
  });

  it("refuses a body over the bound, and one that is not an object", async () => {
    const big = (await call(TOKEN_A, "/scim/v2/Users", "POST", "x".repeat(MAX_SCIM_BODY_BYTES + 1)))!;
    expect(big.status).toBe(413);
    const list = (await call(TOKEN_A, "/scim/v2/Users", "POST", "[1]"))!;
    expect([list.status, (await list.json()).scimType]).toEqual([400, "invalidSyntax"]);
    const noName = (await call(TOKEN_A, "/scim/v2/Users", "POST", { schemas: [USER_SCHEMA], userName: "nobody" }))!;
    expect([noName.status, (await noName.json()).scimType]).toEqual([400, "invalidValue"]);
    const plain = (await call(TOKEN_A, "/scim/v2/Users", "POST", { schemas: [USER_SCHEMA], userName: "al@acme.test" }, "application/json"))!;
    expect(plain.status).toBe(201);
  });
});

describe("Groups", () => {
  it("lists none, and refuses to manage any", async () => {
    expect(await json(await call(TOKEN_A, "/scim/v2/Groups"))).toMatchObject({ totalResults: 0, Resources: [] });
    const pushed = (await call(TOKEN_A, "/scim/v2/Groups", "POST", { displayName: "Engineering" }))!;
    expect([pushed.status, (await pushed.json()).detail]).toEqual([501, "groups are not managed here; roles are set in Bellman"]);
  });
});

describe("a deprovision's rooms (SCIM spec, D6, D7)", () => {
  const bo = (roomRole: string) => member({ memberId: "m_bo", userId: BO, label: "bo@acme.test", orgId: "org_acme", roomRole });
  const al = (roomRole: string) => member({ memberId: "m_al", userId: "u_github_1", label: "al@acme.test", orgId: "org_acme", roomRole });

  beforeEach(async () => {
    await store.provisionSsoMember("org_acme", "sso:org_acme:00u1", 5, { actorUserId: "sso" }, "bo@acme.test");
    await store.createSession(session({ id: "qs_mine", createdBy: BO, orgId: "org_acme", members: [bo("peer_a"), al("peer_b")] }));
    await store.createSession(session({ id: "qs_joined", createdBy: "u_github_1", orgId: "org_acme", members: [al("peer_a"), bo("peer_b")] }));
    await store.createSession(session({ id: "qs_alone", createdBy: BO, orgId: "org_acme", members: [bo("peer_a")] }));
  });

  it("leaves every room and freezes the rooms they created, a repeat finds nothing to do, and a reactivation thaws", async () => {
    const { body } = await push("bo@acme.test");
    expect(body).toMatchObject({ active: true });
    expect(await store.scimUserByKey("sso:org_acme:00u1")).toMatchObject({ id: body.id });
    expect((await patch(body.id, [{ op: "replace", value: { active: false } }]))!.status).toBe(200);
    expect(await store.getGrant("sso:org_acme:00u1")).toBeUndefined();

    const joined = (await store.getSession("qs_joined"))!;
    expect(joined.members.map((m) => m.memberId)).toEqual(["m_al"]);
    expect((await store.membersOfUser("qs_joined", BO)).every((m) => m.leftAt !== null)).toBe(true);
    const evicted = (await store.recentEvents("qs_joined", 20)).filter((e) => e.type === "member_evicted");
    expect(evicted).toHaveLength(1);
    expect(evicted[0]).toMatchObject({ fromMemberId: "system", fromUserId: "scim", payload: { member_id: "m_bo", reason: "deprovisioned" } });
    expect(joined.frozenAt).toBeNull();

    const mine = (await store.getSession("qs_mine"))!;
    expect(mine.frozenAt).not.toBeNull();
    expect(mine.closed).toBe(false);
    expect(mine.members.map((m) => m.memberId)).toEqual(["m_al"]);
    const alone = (await store.getSession("qs_alone"))!;
    expect(alone.closed).toBe(true);

    const rows = await store.auditForOrg("org_acme", 100);
    const frozenRows = rows.filter((e) => e.action === "room_frozen");
    expect(frozenRows.map((e) => e.sessionId)).toEqual(["qs_mine"]);
    expect(frozenRows[0]).toMatchObject({ actorUserId: "scim", detail: { reason: "deprovisioned" } });
    const evictedRows = rows.filter((e) => e.action === "member_evicted");
    expect(evictedRows.map((e) => e.sessionId).sort()).toEqual(["qs_alone", "qs_joined", "qs_mine"]);
    expect(evictedRows.every((e) => e.detail.reason === "deprovisioned" && e.actorUserId === "scim")).toBe(true);

    expect((await patch(body.id, [{ op: "replace", value: { active: false } }]))!.status).toBe(200);
    expect((await actions()).filter((a) => a === "room_frozen" || a === "member_evicted")).toHaveLength(4);

    expect((await patch(body.id, [{ op: "replace", value: { active: true } }]))!.status).toBe(200);
    expect((await store.getSession("qs_mine"))!.frozenAt).toBeNull();
    expect((await actions()).filter((a) => a === "room_thawed")).toHaveLength(1);
    expect(await store.getGrant("sso:org_acme:00u1")).toMatchObject({ source: "scim", role: "member" });
  });

  it("walks out a person pushed as inactive, whom a sign-in had seated", async () => {
    const { res, body } = await push("bo@acme.test", { active: false });
    expect([res.status, body.active]).toEqual([201, false]);
    expect(await store.getGrant("sso:org_acme:00u1")).toBeUndefined();
    expect((await store.getSession("qs_joined"))!.members.map((m) => m.memberId)).toEqual(["m_al"]);
    expect((await store.getSession("qs_mine"))!.frozenAt).not.toBeNull();
  });

  it("runs the same walk for a delete", async () => {
    const { body } = await push("bo@acme.test");
    expect((await call(TOKEN_A, `/scim/v2/Users/${body.id}`, "DELETE"))!.status).toBe(204);
    expect((await store.getSession("qs_mine"))!.frozenAt).not.toBeNull();
    expect((await store.getSession("qs_joined"))!.members.map((m) => m.memberId)).toEqual(["m_al"]);
  });

  it("touches only the org's rooms for a personal account an address linked, and never its sign-in", async () => {
    const { body } = await push("cy@acme.test");
    await store.moveGrant("email:cy@acme.test", "github:555");
    const cy = (roomRole: string) => member({ memberId: "m_cy", userId: "u_github_555", label: "cy@acme.test", orgId: "org_acme", roomRole });
    await store.createSession(session({ id: "qs_org", createdBy: "u_github_1", orgId: "org_acme", members: [al("peer_a"), cy("peer_b")] }));
    await store.createSession(session({ id: "qs_org_mine", createdBy: "u_github_555", orgId: "org_acme", members: [cy("peer_a"), al("peer_b")] }));
    await store.createSession(session({ id: "qs_personal", createdBy: "u_github_555", orgId: null, members: [{ ...cy("peer_a"), orgId: null }, { ...al("peer_b"), orgId: null }] }));
    expect((await patch(body.id, [{ op: "replace", value: { active: false } }]))!.status).toBe(200);
    expect((await store.getSession("qs_org"))!.members.map((m) => m.memberId)).toEqual(["m_al"]);
    expect((await store.getSession("qs_org_mine"))!.frozenAt).not.toBeNull();
    const personal = (await store.getSession("qs_personal"))!;
    expect(personal.frozenAt).toBeNull();
    expect(personal.members.map((m) => m.memberId)).toEqual(["m_cy", "m_al"]);
  });

  it("an address nobody claimed has no rooms", async () => {
    const { body } = await push("cy@acme.test");
    expect((await patch(body.id, [{ op: "replace", value: { active: false } }]))!.status).toBe(200);
    expect((await actions()).filter((a) => a === "room_frozen" || a === "member_evicted")).toHaveLength(0);
    expect((await store.getSession("qs_mine"))!.frozenAt).toBeNull();
  });
});
