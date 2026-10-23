/** What a pushed resource and a PATCH carry (SCIM spec, D2, D8): the three attributes Bellman keeps, in Okta's and Entra's shapes. */
import { describe, expect, it } from "vitest";
import { applyOperations, readUser } from "../src/scim/patch.js";

describe("readUser", () => {
  it("reads a pushed resource: the name lowercased, no externalId as null, active true when absent", () => {
    expect(readUser({ userName: "Bo@Acme.test", name: { givenName: "Bo" } })).toEqual({ userName: "bo@acme.test", externalId: null, active: true });
    expect(readUser({ userName: "bo@acme.test", externalId: "00u", active: false })).toEqual({ userName: "bo@acme.test", externalId: "00u", active: false });
    expect(readUser({ userName: "bo@acme.test", active: "False" })).toEqual({ userName: "bo@acme.test", externalId: null, active: false });
    expect(readUser({ userName: "bo@acme.test", active: "TRUE" })).toMatchObject({ active: true });
  });

  it("refuses a name that is not an address, no name, an externalId that is not a string, and an active that is neither", () => {
    expect(readUser({ userName: "nobody" })).toHaveProperty("error");
    expect(readUser({})).toHaveProperty("error");
    expect(readUser({ userName: "bo@acme.test", externalId: 7 })).toHaveProperty("error");
    expect(readUser({ userName: "bo@acme.test", active: "maybe" })).toHaveProperty("error");
  });
});

describe("applyOperations", () => {
  it("reads Okta's replace with a value object", () => {
    expect(applyOperations([{ op: "replace", value: { active: false } }])).toEqual({ active: false });
    expect(applyOperations([{ op: "replace", value: { userName: "Cy@acme.test", externalId: "00u", displayName: "Cy" } }])).toEqual({ userName: "cy@acme.test", externalId: "00u" });
  });

  it("reads Entra's capitalised ops with a path and string booleans", () => {
    expect(applyOperations([{ op: "Replace", path: "active", value: "False" }])).toEqual({ active: false });
    expect(applyOperations([{ op: "Add", path: "externalId", value: "00u" }, { op: "replace", path: "userName", value: "Cy@acme.test" }])).toEqual({ externalId: "00u", userName: "cy@acme.test" });
    expect(applyOperations([{ op: "remove", path: "externalId" }])).toEqual({ externalId: null });
  });

  it("accepts and ignores an op on an attribute Bellman does not keep", () => {
    expect(applyOperations([{ op: "replace", path: 'emails[type eq "work"].value', value: "x@y.test" }])).toEqual({});
    expect(applyOperations([{ op: "replace", path: "name.givenName", value: "Bo" }, { op: "add", value: { title: "Dev" } }])).toEqual({});
  });

  it("refuses a bad value, a removal of what cannot be removed, and anything that is not an op list", () => {
    expect(applyOperations([{ op: "replace", path: "userName", value: "nobody" }])).toMatchObject({ scimType: "invalidValue" });
    expect(applyOperations([{ op: "replace", path: "active", value: "maybe" }])).toMatchObject({ scimType: "invalidValue" });
    expect(applyOperations([{ op: "remove", path: "active" }])).toMatchObject({ scimType: "invalidValue" });
    expect(applyOperations([{ op: "move", path: "active", value: true }])).toMatchObject({ scimType: "invalidValue" });
    expect(applyOperations("nope")).toMatchObject({ scimType: "invalidSyntax" });
    expect(applyOperations([{ path: "active", value: true }])).toMatchObject({ scimType: "invalidSyntax" });
    expect(applyOperations([{ op: "replace", path: "userName" }])).toMatchObject({ scimType: "invalidValue" });
  });
});
