/** The shapes a connector reads (SCIM spec, D9): a User, a list, an error, and the three discovery documents. */
import { describe, expect, it } from "vitest";
import { SCIM_JSON, listResponse, resourceTypes, schemas, scimError, serviceProviderConfig, userResource } from "../src/scim/resource.js";
import type { ScimUser } from "../src/types.js";

const BASE = "https://mcp.test/scim/v2";
const user: ScimUser = {
  id: "x1", orgId: "org_acme", userName: "bo@acme.test", externalId: null, active: true, key: "email:bo@acme.test",
  createdAt: Date.parse("2026-10-22T10:00:00Z"), updatedAt: Date.parse("2026-10-22T11:00:00Z"), deletedAt: null,
};

describe("userResource", () => {
  it("answers the User schema with its location, and no externalId key when there is none", () => {
    expect(userResource(user, BASE)).toEqual({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      id: "x1", userName: "bo@acme.test", active: true, emails: [{ value: "bo@acme.test", primary: true }],
      meta: { resourceType: "User", created: "2026-10-22T10:00:00.000Z", lastModified: "2026-10-22T11:00:00.000Z", location: `${BASE}/Users/x1` },
    });
    expect(userResource({ ...user, externalId: "00u" }, BASE)).toMatchObject({ externalId: "00u" });
  });
});

describe("listResponse and scimError", () => {
  it("shapes a page", () => {
    expect(listResponse([], 0, 1)).toEqual({ schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"], totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] });
    expect(listResponse([{ id: "a" }], 7, 3)).toMatchObject({ totalResults: 7, startIndex: 3, itemsPerPage: 1 });
  });

  it("shapes an error with the status as a string and the scimType when one applies", async () => {
    const res = scimError(409, "taken", "uniqueness");
    expect([res.status, res.headers.get("content-type")]).toEqual([409, SCIM_JSON]);
    expect(await res.json()).toEqual({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "409", scimType: "uniqueness", detail: "taken" });
    expect(await scimError(404, "no such user").json()).toEqual({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "404", detail: "no such user" });
  });
});

describe("the discovery documents", () => {
  it("say what is supported: patch and filtering, not bulk, sort, etag or passwords, over one bearer scheme", () => {
    const spc = serviceProviderConfig(BASE);
    expect(spc).toMatchObject({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      patch: { supported: true }, bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 }, filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false }, sort: { supported: false }, etag: { supported: false },
      meta: { resourceType: "ServiceProviderConfig", location: `${BASE}/ServiceProviderConfig` },
    });
    expect((spc.authenticationSchemes as { type: string }[]).map((s) => s.type)).toEqual(["oauthbearertoken"]);
  });

  it("list User as the one resource type, and its schema with the attributes held", () => {
    expect(resourceTypes(BASE)).toMatchObject({ totalResults: 1, Resources: [{ id: "User", endpoint: "/Users", schema: "urn:ietf:params:scim:schemas:core:2.0:User", meta: { location: `${BASE}/ResourceTypes/User` } }] });
    const user = (schemas(BASE).Resources as { id: string; attributes: { name: string }[] }[])[0];
    expect(user.id).toBe("urn:ietf:params:scim:schemas:core:2.0:User");
    expect(user.attributes.map((a) => a.name)).toEqual(["userName", "externalId", "active", "emails"]);
  });
});
