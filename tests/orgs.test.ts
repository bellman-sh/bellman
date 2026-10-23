import { describe, expect, it } from "vitest";
import { MAX_ORG_NAME_CHARS, MAX_SEATS, drawnOrgName, forbiddenCapabilityRefusal, joinRefusal, liftOrg, orgView, parseOrgName, parsePolicyPatch, parseSeats, policyView, userIdForKey } from "../src/orgs.js";
import { patchedOrg } from "../src/store.js";
import { ssoUserId } from "../src/oauth/providers.js";
import { DEFAULT_POLICY, type Capability, type Org } from "../src/types.js";

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

  /**
   * A name is shown to the people an org invites, so it holds nothing that draws nothing: the mod's rule
   * for a peer's text, controls, format, private-use and unassigned characters, line and paragraph
   * separators and every code point Unicode leaves undrawn, the Hangul fillers among them; but a selector
   * directly after a character that draws, and a joiner directly after one or after a selector so kept.
   */
  it("holds nothing that draws nothing, and any script's letters, joined or not", () => {
    const refused = [0x0, 0x7, 0x9, 0xa, 0x1b, 0x7f, 0x85, 0x9f, 0xad, 0x34f, 0x61c, 0x115f, 0x17b4, 0x180e, 0x200b, 0x200e,
      0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2060, 0x2066, 0x2069, 0x3164, 0xe000, 0xfeff, 0xffa0, 0xe0041, 0xe0100];
    for (const cp of refused) {
      expect(parseOrgName(`Ac${String.fromCodePoint(cp)}me`), cp.toString(16)).toBeUndefined();
    }
    for (const bad of ["\u3164\u3164\u3164", "\u200dAcme", "\u200cAcme", "\ufe0fAcme", "A\u200b\u200dB", "A\ufe0f\ufe0fB", "A\u200d\u200dB"]) {
      expect(parseOrgName(bad), JSON.stringify(bad)).toBeUndefined();
    }
    for (const good of ["Café Ünïcødé", "株式会社アクメ", "שלום Acme", "شركة", "Acme ❤\u{fe0f}", "<b>Bold</b> & Co",
      "\u2764\u{fe0f}\u200d\u{1f525} Team", "\u{1f469}\u{1f3fd}\u200d\u{1f4bb} Co", "\u0915\u094d\u200d\u0937", "\u0645\u06cc\u200c\u062e\u0648\u0627\u0645"]) {
      expect(parseOrgName(good), JSON.stringify(good)).toBe(good);
    }
  });

  it("is drawn without those characters when a name stored before the rule holds them, and as its id when nothing is left", () => {
    expect(drawnOrgName({ orgId: "org_x", name: "Ac\u202eme\u200b Co" })).toBe("Acme Co");
    expect(drawnOrgName({ orgId: "org_x", name: "\u202e\u2066" })).toBe("org_x");
    expect(drawnOrgName({ orgId: "org_x", name: "\u3164\u3164\u3164" })).toBe("org_x");
    expect(drawnOrgName({ orgId: "org_x", name: "\u200dAc\u3164me\u200d\u{1f525}" })).toBe("Acme\u200d\u{1f525}");
    expect(drawnOrgName({ orgId: "org_x", name: "Acme" })).toBe("Acme");
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

  it("derives it from an IdP subject too (SSO spec, D10)", () => {
    expect(userIdForKey("sso:org_acme:00u1abc")).toBe(ssoUserId("org_acme", "00u1abc"));
    expect(userIdForKey("sso:org_acme:")).toBeNull();
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
    policy: DEFAULT_POLICY,
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
      policy: policyView(DEFAULT_POLICY),
    });
    expect(JSON.stringify(orgView(org, 2, null))).not.toContain("secret");
    expect(orgView(org, 0, null).your_role).toBeNull();
  });
});

describe("liftOrg", () => {
  const org: Org = {
    orgId: "org_acme", name: "Acme", ownerUserId: "u_github_1", seats: 3, source: "purchase", active: true,
    createdAt: 1, requireSso: false, domains: [], policy: DEFAULT_POLICY,
  };

  it("gives a row written before the field the default policy, and leaves a policy it has", () => {
    const legacy = { ...org, policy: undefined } as unknown as Org;
    expect(liftOrg(legacy).policy).toEqual(DEFAULT_POLICY);
    expect(liftOrg(legacy).policy).not.toBe(DEFAULT_POLICY);
    expect(liftOrg({ ...org, policy: { ...DEFAULT_POLICY, requireOrgOnly: true } }).policy.requireOrgOnly).toBe(true);
  });

  it("is what patchedOrg starts from: a legacy previous takes a field over the default, untouched itself", () => {
    const legacy = { ...org, policy: undefined } as unknown as Org;
    expect(patchedOrg(legacy, { policy: { whoMayCreate: "admins_only" } }).policy).toEqual({ ...DEFAULT_POLICY, whoMayCreate: "admins_only" });
    expect(legacy.policy).toBeUndefined();
  });
});

describe("policyView", () => {
  it("is the policy in snake case", () => {
    expect(policyView({ ...DEFAULT_POLICY, forbiddenCapabilities: ["request_actions"], allowedCounterpartyOrgs: [] }))
      .toEqual({ require_org_only: false, forbidden_capabilities: ["request_actions"], allowed_counterparty_orgs: [], who_may_create: "any_member", allow_operator_impersonation: true });
  });
});

describe("parsePolicyPatch", () => {
  it("takes each field by its type and leaves the rest out", () => {
    expect(parsePolicyPatch({ require_org_only: true, allowed_counterparty_orgs: ["org_b", "org_c"] })).toEqual({ patch: { requireOrgOnly: true, allowedCounterpartyOrgs: ["org_b", "org_c"] } });
    expect(parsePolicyPatch({ allowed_counterparty_orgs: null, who_may_create: "admins_only", forbidden_capabilities: [] })).toEqual({ patch: { allowedCounterpartyOrgs: null, whoMayCreate: "admins_only", forbiddenCapabilities: [] } });
  });
  it("names the first fault", () => {
    const faults: [unknown, string][] = [
      [null, "policy must be an object"], [[], "policy must be an object"], [{}, "policy names no field"],
      [{ max_ttl: 1 }, "max_ttl is not a field of policy"],
      [{ require_org_only: "yes" }, "require_org_only must be true or false"],
      [{ allow_operator_impersonation: 1 }, "allow_operator_impersonation must be true or false"],
      [{ forbidden_capabilities: ["request_actions", "request_actions"] }, "forbidden_capabilities must list read_context, receive_messages or request_actions, each once"],
      [{ forbidden_capabilities: "request_actions" }, "forbidden_capabilities must list read_context, receive_messages or request_actions, each once"],
      [{ allowed_counterparty_orgs: ["not an org"] }, "allowed_counterparty_orgs must be null or a list of at most 50 distinct org ids"],
      [{ allowed_counterparty_orgs: ["org_b", "org_b"] }, "allowed_counterparty_orgs must be null or a list of at most 50 distinct org ids"],
      [{ allowed_counterparty_orgs: Array.from({ length: 51 }, (_, i) => `org_${i}`) }, "allowed_counterparty_orgs must be null or a list of at most 50 distinct org ids"],
      [{ who_may_create: "owner" }, "who_may_create must be any_member or admins_only"],
    ];
    for (const [value, error] of faults) expect(parsePolicyPatch(value), JSON.stringify(value)).toEqual({ error });
  });
});

describe("forbiddenCapabilityRefusal", () => {
  it("names the first forbidden capability the declaration holds", () => {
    const policy = { ...DEFAULT_POLICY, forbiddenCapabilities: ["request_actions", "read_context"] as Capability[] };
    expect(forbiddenCapabilityRefusal(policy, ["read_context", "request_actions"])).toBe("your org's policy forbids granting request_actions to peers; call again without it.");
    expect(forbiddenCapabilityRefusal(policy, ["receive_messages"])).toBeNull();
    expect(forbiddenCapabilityRefusal(DEFAULT_POLICY, ["request_actions"])).toBeNull();
  });
});

describe("joinRefusal", () => {
  const org: Org = {
    orgId: "org_x", name: "X", ownerUserId: "u_github_1", seats: 3, source: "operator", active: true,
    createdAt: 1, requireSso: false, domains: [], policy: DEFAULT_POLICY,
  };
  const orgs: Record<string, Org> = {
    org_open: { ...org, orgId: "org_open" },
    org_b_only: { ...org, orgId: "org_b_only", policy: { ...DEFAULT_POLICY, allowedCounterpartyOrgs: ["org_b"] } },
    org_none: { ...org, orgId: "org_none", policy: { ...DEFAULT_POLICY, allowedCounterpartyOrgs: [] } },
    org_b: { ...org, orgId: "org_b" },
  };
  const getOrg = async (id: string) => orgs[id];
  it("allows a room of open orgs, and one the joiner's org lists", async () => {
    expect(await joinRefusal(getOrg, "org_b", ["org_open"], false)).toBeNull();
    expect(await joinRefusal(getOrg, "org_b_only", ["org_b"], false)).toBeNull();
    expect(await joinRefusal(getOrg, null, ["org_open"], false)).toBeNull();
    expect(await joinRefusal(getOrg, "org_none", ["org_none"], false)).toBeNull();
  });
  it("refuses from the joiner's side, naming the room's org, a a member outside any org included", async () => {
    expect(await joinRefusal(getOrg, "org_b_only", ["org_open"], false)).toBe('your org\'s policy does not allow rooms with org "org_open".');
    expect(await joinRefusal(getOrg, "org_none", [], true)).toBe("your org's policy does not allow rooms with a member outside any org.");
  });
  it("refuses from the room's side, naming the org whose rule refused", async () => {
    expect(await joinRefusal(getOrg, "org_open", ["org_b_only"], false)).toBe('org "org_b_only"\'s policy does not allow members of your org in its rooms.');
    expect(await joinRefusal(getOrg, null, ["org_open", "org_none"], false)).toBe('org "org_none"\'s policy does not allow members of your org in its rooms.');
  });
  it("reads a room org that has no record as open", async () => {
    expect(await joinRefusal(getOrg, "org_open", ["org_string"], false)).toBeNull();
  });
});
