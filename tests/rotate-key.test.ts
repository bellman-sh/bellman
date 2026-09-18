import { afterEach, describe, expect, it } from "vitest";
import { resolveIdentity } from "../src/auth.js";
import { buildKeyMap, keyFor, newKey, parseIdentities, type IdentitySpec } from "../scripts/rotate-key.js";

const ORIGINAL = process.env.BELLMAN_KEYS;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.BELLMAN_KEYS;
  else process.env.BELLMAN_KEYS = ORIGINAL;
});

const jesse: IdentitySpec = {
  userId: "u_jesse", orgId: "org_codenerd", plan: "team", role: "admin",
  label: "jesse@codenerd", claude_code: true,
};
const peer: IdentitySpec = {
  userId: "u_peer", orgId: "org_codenerd", plan: "free", role: "member", label: "peer@codenerd",
};

describe("key generation", () => {
  it("mints unguessable keys with the bk_ prefix", () => {
    expect(newKey()).toMatch(/^bk_[0-9a-f]{48}$/);
    expect(new Set(Array.from({ length: 50 }, newKey)).size).toBe(50);
  });
});

describe("identity validation", () => {
  it("rejects a file that would upload a broken key map", () => {
    expect(() => parseIdentities([])).toThrow(/non-empty/);
    expect(() => parseIdentities([{ ...jesse, userId: "" }])).toThrow(/userId/);
    expect(() => parseIdentities([{ ...jesse, plan: "enterprise" }])).toThrow(/plan/);
    expect(() => parseIdentities([{ ...jesse, role: "owner" }])).toThrow(/role/);
    const { orgId: _dropped, ...noOrg } = jesse;
    expect(() => parseIdentities([noOrg])).toThrow(/orgId/);
  });

  /** org_only scoping and the audit log both key off orgId — a team admin without one is inert. */
  it("rejects a team or admin identity with no org", () => {
    expect(() => parseIdentities([{ ...jesse, orgId: null }])).toThrow(/needs an orgId/);
  });

  it("keeps only the fields the server understands, plus the install marker", () => {
    const [parsed] = parseIdentities([{ ...jesse, nonsense: "dropped" }]);

    expect(parsed).toEqual(jesse);
    expect(parseIdentities([peer])[0]).not.toHaveProperty("claude_code");
  });
});

describe("key map", () => {
  it("mints one distinct key per identity and strips the install marker", () => {
    const map = buildKeyMap([jesse, peer]);
    const keys = Object.keys(map);

    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(map[keys[0]]).not.toHaveProperty("claude_code");
  });

  /**
   * The map this script uploads has to be exactly what the server parses, or a
   * rotation locks everyone out. Check it against the real resolver.
   */
  it("produces a map the server accepts, and retires the old keys", () => {
    const previous = buildKeyMap([jesse]);
    const current = buildKeyMap([jesse, peer]);
    process.env.BELLMAN_KEYS = JSON.stringify(current);

    for (const [key, identity] of Object.entries(current)) {
      expect(resolveIdentity(`Bearer ${key}`)).toEqual(identity);
    }
    expect(resolveIdentity(`Bearer ${Object.keys(previous)[0]}`)).toBeNull();
    expect(resolveIdentity("Bearer qk_dev_jesse")).toBeNull();
  });

  it("installs the identity marked for Claude Code, else the first", () => {
    const map = buildKeyMap([peer, jesse]);

    expect(map[keyFor(map, [peer, jesse])!].label).toBe("jesse@codenerd");
    expect(map[keyFor(map, [peer])!].label).toBe("peer@codenerd");
  });
});
