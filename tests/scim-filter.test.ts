/** The one filter a provisioning connector sends (SCIM spec, D9): `<attribute> eq "<value>"`, on userName or externalId. */
import { describe, expect, it } from "vitest";
import { parseFilter } from "../src/scim/filter.js";

describe("parseFilter", () => {
  it("reads userName eq, lowercasing the address, whatever the case of the attribute or the operator", () => {
    expect(parseFilter('userName eq "Bo@Acme.test"')).toEqual({ attribute: "userName", value: "bo@acme.test" });
    expect(parseFilter('  USERNAME   EQ "bo@acme.test"  ')).toEqual({ attribute: "userName", value: "bo@acme.test" });
  });

  it("reads externalId eq as given", () => {
    expect(parseFilter('externalId eq "00u1Abc"')).toEqual({ attribute: "externalId", value: "00u1Abc" });
    expect(parseFilter('EXTERNALID EQ "00u"')).toEqual({ attribute: "externalId", value: "00u" });
  });

  it("unescapes a quoted value", () => {
    expect(parseFilter('userName eq "a \\"quoted\\" one"')).toEqual({ attribute: "userName", value: 'a "quoted" one' });
    expect(parseFilter('externalId eq "back\\\\slash"')).toEqual({ attribute: "externalId", value: "back\\slash" });
  });

  it("refuses every other filter", () => {
    for (const filter of ['userName co "x"', "active eq true", 'userName eq "x" and active eq true', "", 'userName eq x', 'emails.value eq "x"']) {
      expect(parseFilter(filter), filter).toHaveProperty("error");
    }
  });
});
