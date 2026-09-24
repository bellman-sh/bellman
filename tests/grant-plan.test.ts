import { describe, expect, it } from "vitest";
import { identityFor, parseOverrides, type ProviderProfile } from "../src/oauth/providers.js";
import {
  mergeGrant,
  parseGrant,
  parseUsers,
  removeGrant,
  resolveKey,
  type Grant,
} from "../scripts/grant-plan.js";
import type { Identity } from "../src/types.js";

const team = ["--github", "mcfearsome", "--plan", "team", "--role", "admin", "--org", "org_codenerd"];

const stubFetch = (body: unknown, ok = true): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 404 })) as unknown as typeof fetch;

const foundHandle = stubFetch({ id: 4308278, login: "mcfearsome" });

describe("argument parsing", () => {
  it("reads a provider handle, a plan, a role and an org", () => {
    expect(parseGrant(team)).toMatchObject({
      provider: "github",
      handle: "mcfearsome",
      plan: "team",
      role: "admin",
      orgId: "org_codenerd",
    });
  });

  it("treats --org none as no org", () => {
    const grant = parseGrant(["--email", "me@x.com", "--plan", "pro", "--role", "member", "--org", "none"]);

    expect(grant.orgId).toBeNull();
  });

  it("rejects a grant the server would refuse to honour", () => {
    const swap = (flag: string, value: string) =>
      team.map((arg, i) => (team[i - 1] === flag ? value : arg));

    expect(() => parseGrant(["--plan", "pro", "--role", "member", "--org", "none"])).toThrow(/--github/);
    expect(() => parseGrant(swap("--plan", "enterprise"))).toThrow(/plan/);
    expect(() => parseGrant(swap("--role", "owner"))).toThrow(/role/);
    expect(() => parseGrant(["--github", "x", "--plan", "pro", "--role", "member"])).toThrow(/--org/);
  });

  /** org_only scoping and the audit log both key off orgId — the rule rotate-key enforces. */
  it("rejects a team or admin grant with no org", () => {
    const orphan = ["--github", "x", "--plan", "team", "--role", "member", "--org", "none"];

    expect(() => parseGrant(orphan)).toThrow(/needs an orgId/);
  });
});

describe("key resolution", () => {
  /**
   * A login can be renamed and the old one re-registered by someone else. The
   * numeric id cannot, so that is what gets written.
   */
  it("resolves a GitHub handle to its stable numeric id", async () => {
    await expect(resolveKey(parseGrant(team), foundHandle)).resolves.toEqual({
      key: "github:4308278",
      identity: {
        userId: "u_github_4308278",
        orgId: "org_codenerd",
        plan: "team",
        role: "admin",
        label: "mcfearsome@github",
      },
    });
  });

  /**
   * The granted userId has to be byte-identical to the one identityFor mints on
   * the default path, or the grant orphans every session made before it.
   */
  it("keeps the userId the default path would have produced", async () => {
    const { identity } = await resolveKey(parseGrant(team), foundHandle);
    const defaulted = identityFor({ provider: "github", subject: "4308278", label: "mcfearsome" });

    expect(identity.userId).toBe(defaulted.userId);
  });

  it("says so when the handle does not exist", async () => {
    await expect(resolveKey(parseGrant(team), stubFetch({}, false))).rejects.toThrow(/mcfearsome/);
  });

  it("writes a literal key verbatim, since Google has no public handle lookup", async () => {
    const grant = parseGrant(["--key", "google:107812", "--plan", "pro", "--role", "member", "--org", "none"]);

    await expect(resolveKey(grant)).resolves.toMatchObject({
      key: "google:107812",
      identity: { userId: "u_google_107812", label: "google:107812" },
    });
  });

  it("writes an email grant under the provider-neutral email: prefix", async () => {
    const grant = parseGrant(["--email", "me@x.com", "--plan", "pro", "--role", "member", "--org", "none"]);

    await expect(resolveKey(grant)).resolves.toMatchObject({ key: "email:me@x.com" });
  });

  /**
   * The CLI and the server have to agree on what a key is. They drifted once:
   * labels stopped resolving server-side while this script still accepted them,
   * so `--key github:mcfearsome` wrote an override that could never apply — the
   * silent failure this whole area exists to prevent. Same validator now.
   */
  it("refuses a literal key the server could never resolve", async () => {
    const literal = (key: string) =>
      parseGrant(["--key", key, "--plan", "pro", "--role", "member", "--org", "none"]);

    for (const key of ["github:mcfearsome", "google:Jesse", "email:not-an-address"]) {
      await expect(resolveKey(literal(key)), key).rejects.toThrow(/numeric id/);
    }
  });

  it("rejects a literal key that names no known prefix", async () => {
    const grant = parseGrant(["--key", "slack:U123", "--plan", "pro", "--role", "member", "--org", "none"]);

    await expect(resolveKey(grant)).rejects.toThrow(/github:|google:|email:/);
  });

  it("lets --label and --user-id override the defaults", async () => {
    const argv = [...team, "--label", "jesse@codenerd", "--user-id", "u_jesse"];
    const { identity } = await resolveKey(parseGrant(argv), foundHandle);

    expect(identity).toMatchObject({ userId: "u_jesse", label: "jesse@codenerd" });
  });
});

describe("the users map", () => {
  const existing: Record<string, Identity> = {
    "email:a@b.com": { userId: "u_a", orgId: null, plan: "pro", role: "member", label: "a@b.com" },
  };
  const granted: Identity = {
    userId: "u_github_4308278", orgId: "org_codenerd", plan: "team", role: "admin", label: "mcfearsome@github",
  };

  it("adds a grant without disturbing the others", () => {
    const merged = mergeGrant(existing, "github:4308278", granted);

    expect(merged).toEqual({ ...existing, "github:4308278": granted });
    expect(existing).not.toHaveProperty("github:4308278");
  });

  it("replaces a grant for a key that is already there", () => {
    const merged = mergeGrant({ "github:4308278": granted }, "github:4308278", { ...granted, plan: "pro" });

    expect(merged["github:4308278"].plan).toBe("pro");
  });

  it("removes a grant, and says so when there was none", () => {
    expect(removeGrant({ ...existing, "github:4308278": granted }, "github:4308278")).toEqual(existing);
    expect(() => removeGrant(existing, "github:4308278")).toThrow(/github:4308278/);
  });

  /**
   * parseOverrides swallows malformed JSON and silently drops everyone to free,
   * so a bad file has to be caught here rather than on the server.
   */
  it("rejects a users file the server would silently ignore", () => {
    expect(() => parseUsers("not json")).toThrow(/JSON/);
    expect(() => parseUsers(JSON.stringify(["a"]))).toThrow(/object/);
    expect(() => parseUsers(JSON.stringify({ "github:1": { plan: "team" } }))).toThrow(/userId/);
    expect(() => parseUsers(JSON.stringify({ "slack:1": granted }))).toThrow(/slack:1/);
    expect(parseUsers(JSON.stringify(existing))).toEqual(existing);
    expect(parseUsers(undefined)).toEqual({});
  });
});

/**
 * The map this script uploads has to be exactly what the server parses. Check
 * it against the real resolver, the way the rotate-key suite does.
 */
describe("what the server does with the uploaded map", () => {
  const profile: ProviderProfile = {
    provider: "github", subject: "4308278", label: "mcfearsome", email: "me@x.com",
  };

  it("promotes the granted profile and leaves everyone else free", async () => {
    const grant: Grant = parseGrant(team);
    const { key, identity } = await resolveKey(grant, foundHandle);
    const overrides = parseOverrides(JSON.stringify(mergeGrant({}, key, identity)));

    expect(identityFor(profile, overrides)).toEqual(identity);
    expect(identityFor({ provider: "github", subject: "99", label: "someone" }, overrides).plan).toBe("free");
  });

  it("still promotes after a rename, which is the point of the numeric id", async () => {
    const { key, identity } = await resolveKey(parseGrant(team), foundHandle);
    const overrides = parseOverrides(JSON.stringify(mergeGrant({}, key, identity)));

    expect(identityFor({ ...profile, label: "renamed" }, overrides).plan).toBe("team");
  });
});
