import { describe, it, expect } from "vitest";
import {
  SSO_SUB, defaultIdentity, identityKeys, immutableKeys, isStableIdentityKey, grantKeys,
  parseSsoKey, ssoKey, ssoKeyForUser, ssoUserId,
} from "../src/oauth/providers.js";
import { isLinkableUserId } from "../src/billing/stripe.js";
import type { ProviderProfile } from "../src/oauth/providers.js";

const profile = (over: Partial<ProviderProfile> = {}): ProviderProfile => ({
  provider: "github", subject: "4242", label: "mcfearsome", email: "jesse@example.dev", ...over,
});

describe("which keys an identity answers to", () => {
  it("lists the subject and both email forms, and no label", () => {
    expect(identityKeys(profile())).toEqual([
      "github:4242", "github:jesse@example.dev", "email:jesse@example.dev",
    ]);
  });

  /**
   * A login is renameable and reclaimable, and a Google display name is an
   * arbitrary string its owner picks. Keeping them for operator convenience
   * cost two security bugs — one on the grant path, one on refresh — so they
   * are not keys at all any more.
   */
  it("never files an identity under its label, whatever the label looks like", () => {
    for (const label of ["mcfearsome", "victim@example.dev", "4242", "Jesse"]) {
      expect(identityKeys(profile({ label })), label)
        .toEqual(["github:4242", "github:jesse@example.dev", "email:jesse@example.dev"]);
    }
  });

  it("copes with a profile that has no email at all", () => {
    expect(identityKeys(profile({ email: undefined }))).toEqual(["github:4242"]);
  });
});

describe("which keys survive being written down", () => {
  /**
   * A stored key list is a snapshot. A verified address is trustworthy at
   * sign-in, because the provider has just confirmed it — but by the time a
   * refresh replays that list the address may belong to someone else, so only
   * the subject may resolve a plan then.
   */
  it("keeps the subject and drops everything that can be reassigned", () => {
    expect(immutableKeys(identityKeys(profile()))).toEqual(["github:4242"]);
    expect(immutableKeys(["google:109876543210987654321", "email:a@b.test"]))
      .toEqual(["google:109876543210987654321"]);
    expect(immutableKeys(["github:mcfearsome", "email:a@b.test"])).toEqual([]);
  });
});

describe("which keys a grant may be filed against", () => {
  /**
   * The security boundary this PR needs: /admin/grants is reachable by every
   * team admin, so a grant keyed to a renameable login would hand this org's
   * plan — and at role "admin", this org — to whoever claims that login next.
   */
  it("accepts subjects and verified addresses, and nothing else", () => {
    for (const key of [
      "github:4242", "google:109876543210987654321",
      "github:jesse@example.dev", "google:jesse@example.dev", "email:jesse@example.dev",
    ]) {
      expect(isStableIdentityKey(key), key).toBe(true);
    }

    for (const key of [
      "github:mcfearsome",   // a login, renameable and reclaimable
      "google:Jesse",        // a display name, not an identifier at all
      "github:", "email:", "", "nonsense:1", "no-separator",
      "email:not-an-address",
    ]) {
      expect(isStableIdentityKey(key), key).toBe(false);
    }
  });

  it("filters a stored key list down to the ones a grant can use", () => {
    expect(grantKeys(identityKeys(profile())))
      .toEqual(["github:4242", "github:jesse@example.dev", "email:jesse@example.dev"]);
  });
});

describe("SSO keys (SSO spec, D10)", () => {
  const sso = (over: Partial<ProviderProfile> = {}): ProviderProfile => ({
    provider: "sso", subject: "org_acme:00u1abc", label: "Ana", email: "ana@acme.com", ...over,
  });

  it("names the org and the IdP's subject, and reads itself back", () => {
    expect(ssoKey("org_acme", "00u1abc")).toBe("sso:org_acme:00u1abc");
    expect(parseSsoKey("sso:org_acme:00u1abc")).toEqual({ orgId: "org_acme", sub: "00u1abc" });
    expect(parseSsoKey("sso:org_acme:a|b=c/d")).toEqual({ orgId: "org_acme", sub: "a|b=c/d" });
  });

  /** An org id holds no colon, so the first one after `sso:` is the split; the sub is printable ASCII, bounded. */
  it("refuses a key whose org or sub is outside the grammar", () => {
    for (const key of ["sso:org acme:x", "sso:org_acme:", "sso::x", `sso:org_acme:${"a".repeat(129)}`, "sso:org_acme:a b", "sso:org_acme", "github:4242"]) {
      expect(parseSsoKey(key), key).toBeNull();
    }
    expect(SSO_SUB.test("a".repeat(128))).toBe(true);
  });

  /** The user id grammar has no separator to spare, so the pair is encoded whole and decodes back. */
  it("mints a user id the rest of the program accepts, and recovers the key from it", () => {
    const userId = ssoUserId("org_acme", "00u1abc");
    expect(userId).toMatch(/^u_sso_[A-Za-z0-9_-]+$/);
    expect(isLinkableUserId(userId)).toBe(true);
    expect(ssoKeyForUser(userId)).toBe("sso:org_acme:00u1abc");
    expect(ssoKeyForUser(ssoUserId("org_acme", "a|b=c/d"))).toBe("sso:org_acme:a|b=c/d");
    for (const id of ["u_github_4242", "u_sso_!!", "u_sso_", "u_sso_" + "AAAA", "u_jesse"]) {
      expect(ssoKeyForUser(id), id).toBeNull();
    }
  });

  it("answers to the subject and a verified address, never a provider-prefixed address", () => {
    expect(identityKeys(sso())).toEqual(["sso:org_acme:00u1abc", "email:ana@acme.com"]);
    expect(identityKeys(sso({ email: undefined }))).toEqual(["sso:org_acme:00u1abc"]);
  });

  it("keeps the subject across a refresh and lets a grant be filed against it", () => {
    expect(immutableKeys(identityKeys(sso()))).toEqual(["sso:org_acme:00u1abc"]);
    expect(isStableIdentityKey("sso:org_acme:00u1abc")).toBe(true);
    expect(isStableIdentityKey("sso:org_acme:")).toBe(false);
    expect(grantKeys(identityKeys(sso()))).toEqual(["sso:org_acme:00u1abc", "email:ana@acme.com"]);
  });

  it("mints the default identity from the encoded id, labelled by the address", () => {
    expect(defaultIdentity(sso())).toEqual({
      userId: ssoUserId("org_acme", "00u1abc"), orgId: null, plan: "free", role: "member", label: "ana@acme.com",
    });
    expect(defaultIdentity(sso({ email: undefined })).label).toBe("Ana@sso");
  });
});
