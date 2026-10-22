import { describe, expect, it } from "vitest";
import { MAX_ORG_NAME_CHARS, MAX_SEATS, orgView, parseOrgName, parseSeats, userIdForKey } from "../src/orgs.js";
import type { Org } from "../src/types.js";

/** The runtime-free rules the org routes share (orgs spec, D6, D7). */

describe("an org's name", () => {
  it("is trimmed, and 1 to 80 characters", () => {
    expect(MAX_ORG_NAME_CHARS).toBe(80);
    expect(parseOrgName("  Acme ")).toBe("Acme");
    expect(parseOrgName("a".repeat(MAX_ORG_NAME_CHARS))).toHaveLength(MAX_ORG_NAME_CHARS);
    for (const bad of ["", "   ", "a".repeat(MAX_ORG_NAME_CHARS + 1), ` ${"a".repeat(MAX_ORG_NAME_CHARS + 1)} `, 42, null, undefined, ["Acme"]]) {
      expect(parseOrgName(bad), String(bad)).toBeUndefined();
    }
  });
});

describe("seats", () => {
  it("is a whole number from 1 to the ceiling", () => {
    expect(parseSeats(1)).toBe(1);
    expect(parseSeats(MAX_SEATS)).toBe(MAX_SEATS);
    for (const bad of [0, -1, 1.5, "3", MAX_SEATS + 1, NaN, Infinity, null, undefined]) {
      expect(parseSeats(bad), String(bad)).toBeUndefined();
    }
  });
});

describe("the user id a key names", () => {
  it("derives it from a provider subject, and from nothing else", () => {
    expect(userIdForKey("github:4242")).toBe("u_github_4242");
    expect(userIdForKey("google:109876543210987654321")).toBe("u_google_109876543210987654321");
    for (const key of ["email:a@b.test", "github:mcfearsome", "slack:1", "github:", ""]) {
      expect(userIdForKey(key), key).toBeNull();
    }
  });
});

describe("the org as the routes show it", () => {
  const org: Org = {
    orgId: "org_acme", name: "Acme", ownerUserId: "u_github_1", seats: 3, source: "purchase", active: true,
    createdAt: Date.parse("2026-10-21T00:00:00Z"), requireSso: false,
    domains: [
      { domain: "acme.com", token: "the-secret-token", verifiedAt: Date.parse("2026-10-22T00:00:00Z") },
      { domain: "acme.dev", token: "another", verifiedAt: null },
    ],
  };

  it("formats the dates, carries the seats used and the caller's role, and never a domain's token", () => {
    expect(orgView(org, 2, "admin")).toEqual({
      org_id: "org_acme", name: "Acme", owner_user_id: "u_github_1", seats: 3, seats_used: 2, active: true,
      source: "purchase", created_at: "2026-10-21T00:00:00.000Z", require_sso: false,
      domains: [
        { domain: "acme.com", verified_at: "2026-10-22T00:00:00.000Z" },
        { domain: "acme.dev", verified_at: null },
      ],
      your_role: "admin",
    });
    expect(JSON.stringify(orgView(org, 2, null))).not.toContain("secret");
    expect(orgView(org, 0, null).your_role).toBeNull();
  });
});
