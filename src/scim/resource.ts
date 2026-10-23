/**
 * The shapes a provisioning connector reads (SCIM spec, D9, RFC 7643 and 7644): a User, a list page, an error,
 * and the three discovery documents Okta and Entra fetch before they will talk to a server.
 */
import type { ScimUser } from "../types.js";

export const SCIM_JSON = "application/scim+json";

export const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
export const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const SPC_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig";
const RESOURCE_TYPE_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:ResourceType";
const SCHEMA_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Schema";

const iso = (at: number): string => new Date(at).toISOString();

/** A User as the connector reads it: what is held, and where it lives. */
export function userResource(user: ScimUser, base: string): Record<string, unknown> {
  return {
    schemas: [USER_SCHEMA],
    id: user.id,
    ...(user.externalId === null ? {} : { externalId: user.externalId }),
    userName: user.userName,
    active: user.active,
    emails: [{ value: user.userName, primary: true }],
    meta: { resourceType: "User", created: iso(user.createdAt), lastModified: iso(user.updatedAt), location: `${base}/Users/${user.id}` },
  };
}

export function listResponse(resources: Record<string, unknown>[], total: number, startIndex: number): Record<string, unknown> {
  return { schemas: [LIST_SCHEMA], totalResults: total, startIndex, itemsPerPage: resources.length, Resources: resources };
}

export const scimJson = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": SCIM_JSON, "cache-control": "no-store", ...headers } });

/** The error schema: the status as a string, the detail, and a scimType when one applies. */
export function scimError(status: number, detail: string, scimType?: string): Response {
  return scimJson(status, { schemas: [ERROR_SCHEMA], status: String(status), ...(scimType ? { scimType } : {}), detail });
}

export function serviceProviderConfig(base: string): Record<string, unknown> {
  return {
    schemas: [SPC_SCHEMA],
    documentationUri: "https://docs.bellman.sh/guides/teams/",
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{
      type: "oauthbearertoken", name: "Bearer token", description: "The org's SCIM token, issued by its admin, as a bearer token", primary: true,
    }],
    meta: { resourceType: "ServiceProviderConfig", location: `${base}/ServiceProviderConfig` },
  };
}

export function resourceTypes(base: string): Record<string, unknown> {
  return listResponse([{
    schemas: [RESOURCE_TYPE_SCHEMA], id: "User", name: "User", endpoint: "/Users", description: "A member of the org", schema: USER_SCHEMA,
    meta: { resourceType: "ResourceType", location: `${base}/ResourceTypes/User` },
  }], 1, 1);
}

const attribute = (name: string, type: string, description: string, extra: Record<string, unknown> = {}) => ({
  name, type, multiValued: false, description, required: false, caseExact: false, mutability: "readWrite", returned: "default", uniqueness: "none", ...extra,
});

export function schemas(base: string): Record<string, unknown> {
  return listResponse([{
    schemas: [SCHEMA_SCHEMA], id: USER_SCHEMA, name: "User", description: "A member of the org, as the identity provider pushed them",
    attributes: [
      attribute("userName", "string", "The email address, lowercased", { required: true, uniqueness: "server" }),
      attribute("externalId", "string", "The identity provider's id for the person", { caseExact: true }),
      attribute("active", "boolean", "Whether the person holds a seat; false removes it and ends their sign-in"),
      attribute("emails", "complex", "The address, once more, as a connector expects it", { multiValued: true, mutability: "readOnly" }),
    ],
    meta: { resourceType: "Schema", location: `${base}/Schemas/${USER_SCHEMA}` },
  }], 1, 1);
}
