import { describe, it, expect } from "vitest";
import {
  NO_ORG, allKeysFor, grantKey, isOrgId, orgIndexKey, orgIndexPrefix, staleIndexKeys,
} from "../src/grant-index.js";
import type { PlanGrant } from "../src/types.js";

const grant = (over: Partial<PlanGrant> = {}): PlanGrant => ({
  key: "github:4242", plan: "team", role: "member", orgId: "org_mine",
  source: "purchase", grantedAt: 0, grantedBy: "stripe", expiresAt: null, ...over,
});

describe("the org-scoped grant index", () => {
  /**
   * The whole point of the index: a listing scans one org's range instead of
   * every grant on the platform. That only holds if one org's prefix cannot
   * match another org's records.
   */
  it("does not let one org's prefix match a longer org's grants", () => {
    const short = orgIndexPrefix("org_a");
    expect(orgIndexKey("org_ab", "github:1").startsWith(short)).toBe(false);
    expect(orgIndexKey("org_a", "github:1").startsWith(short)).toBe(true);
  });

  /** Grant keys carry colons themselves, so the separator must still work. */
  it("keeps keys containing colons inside their own org's range", () => {
    expect(orgIndexKey("org_mine", "github:4242"))
      .toBe("go:org_mine:github:4242");
    expect(orgIndexKey("org_mine", "email:a@b.test").startsWith(orgIndexPrefix("org_mine")))
      .toBe(true);
  });

  /** Org-less grants are a bucket of their own, not "every org". */
  it("files org-less grants under a bucket no org id can spell", () => {
    const noOrg = orgIndexPrefix(null);
    expect(noOrg).not.toBe(orgIndexPrefix("org_mine"));
    // Org ids are `org_<userId>`; nothing that shape can produce this prefix.
    expect(noOrg.includes("~")).toBe(true);
  });

  /**
   * The one write that can leave a stale entry: move a key to another org and
   * the copy under the old org must go, or that org keeps listing a customer
   * it no longer has.
   */
  it("retires the old org's entry when a grant is re-homed", () => {
    const before = grant({ orgId: "org_before" });
    const after = grant({ orgId: "org_after" });

    expect(staleIndexKeys(before, after)).toEqual([orgIndexKey("org_before", after.key)]);
  });

  it("leaves the index alone when the org does not change", () => {
    expect(staleIndexKeys(grant(), grant({ plan: "pro" }))).toEqual([]);
    expect(staleIndexKeys(undefined, grant())).toEqual([]);
  });

  it("counts a move to or from org-less as a move", () => {
    expect(staleIndexKeys(grant({ orgId: null }), grant({ orgId: "org_mine" })))
      .toEqual([orgIndexKey(null, "github:4242")]);
    expect(staleIndexKeys(grant({ orgId: "org_mine" }), grant({ orgId: null })))
      .toEqual([orgIndexKey("org_mine", "github:4242")]);
  });

  /**
   * The encoding has to be injective or it is a cross-org read: `:` is legal
   * in a grant key, so if it were also legal in an org id then
   * ("org_a", "github:google:y") and ("org_a:github", "google:y") would spell
   * the same storage key, and the second org could list and overwrite the
   * first one's grant.
   */
  it("gives two different (org, key) pairs two different storage keys", () => {
    expect(orgIndexKey("org_a", "github:google:y"))
      .not.toBe(orgIndexKey("org_a:github", "google:y"));
  });

  it("keeps a colon-bearing org id out of every other org's range", () => {
    const sneaky = orgIndexKey("org_a:github", "google:y");
    expect(sneaky.startsWith(orgIndexPrefix("org_a"))).toBe(false);
  });

  /** The grammar the encoding's soundness is argued from. */
  it("names the org ids the write path may accept", () => {
    for (const ok of ["org_a", "org_u_github_4242", "A-1", "x".repeat(64)]) {
      expect(isOrgId(ok), ok).toBe(true);
    }
    for (const bad of ["", "org:a", "org a", "org/a", "~none", "x".repeat(65)]) {
      expect(isOrgId(bad), bad).toBe(false);
    }
  });

  /**
   * The org-less bucket must not be spellable, and isOrgId alone does not
   * achieve that: putGrant is part of the store API and does not call it, so
   * the encoding has to hold on its own for any internal or future writer.
   */
  it("cannot be impersonated by an org named after the bucket", () => {
    expect(isOrgId(NO_ORG)).toBe(false);
    expect(orgIndexPrefix(NO_ORG)).not.toBe(orgIndexPrefix(null));
    expect(orgIndexKey(NO_ORG, "github:1")).not.toBe(orgIndexKey(null, "github:1"));
  });

  /** Every delete path clears both copies, or a deleted grant stays listed. */
  it("names both copies of a grant", () => {
    expect(allKeysFor(grant())).toEqual([
      grantKey("github:4242"),
      orgIndexKey("org_mine", "github:4242"),
    ]);
  });
});
