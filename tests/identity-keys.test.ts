import { describe, it, expect } from "vitest";
import {
  identityKeys, immutableKeys, isStableIdentityKey, grantKeys,
} from "../src/oauth/providers.js";
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
