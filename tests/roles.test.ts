/**
 * verbsOfRole and denyVerb are pure — no store, no identity, no clock. The tool
 * tests drive them through real handlers; this file pins the accessor itself,
 * including the unknown-role case that no tool path can produce (design D5).
 */
import { describe, it, expect } from "vitest";
import { denyVerb, verbsOfRole } from "../src/roles.js";
import { resolveManifest } from "../src/manifest.js";
import { member, roomManifest, session } from "./helpers/fixtures.js";

const swarm = resolveManifest({ room: "r", preset: "swarm" });

describe("verbsOfRole", () => {
  it("returns the verbs a defined role holds", () => {
    expect(verbsOfRole(swarm, "lead")).toEqual([
      "send", "invite", "revoke", "request_actions", "respond_actions",
    ]);
  });

  it("returns an empty list for a role defined with no verbs", () => {
    // Without this, a preset that dropped `observer` would return the same []
    // through the fail-closed branch and this test would pass for the wrong reason.
    expect(swarm.roles).toHaveProperty("observer");
    expect(verbsOfRole(swarm, "observer")).toEqual([]);
  });

  // An unguarded `manifest.roles[role].can` throws a TypeError here. It is one of
  // several tests that catch a bare lookup, not the only one: the cases below it
  // and the ghost `denyVerb` test fail under it too.
  it("fails closed for a role the manifest does not define", () => {
    expect(verbsOfRole(swarm, "ghost")).toEqual([]);
  });

  // This block kills the truthiness rewrite `roles[r] ? roles[r].can : []`. That
  // returns [] for an undefined role, so the unknown-role case above cannot see
  // it; but "constructor", "toString", "__proto__" and "valueOf" all resolve to
  // something truthy that has no `can`, so it returns undefined for them.
  // ("prototype" resolves to undefined on a plain object and slips past that
  // rewrite. A bare `roles[r].can` gives undefined for the other four and throws a
  // TypeError on "prototype" — undefined, never an inherited function.)
  //
  // It does NOT pin Object.hasOwn: none of these values has a `can`, so
  // `roles[r]?.can ?? []` returns [] for every one. The inherited-role test below
  // is what separates them.
  it.each(["constructor", "prototype", "toString", "__proto__", "valueOf"])(
    "fails closed for %s rather than reaching an inherited property",
    (name) => {
      expect(verbsOfRole(swarm, name)).toEqual([]);
    },
  );

  // Object.hasOwn is what makes this an OWN-property lookup, and nothing else in
  // this file pins it: every name on Object.prototype happens to have no `can`,
  // so a `?.can ?? []` variant returns [] for all of them too. An inherited role
  // that DOES have a `can` separates the two — hasOwn returns [], the optional
  // chain returns ["send"].
  it("ignores a role inherited from the prototype chain", () => {
    const inherited = { ...swarm, roles: Object.create({ inherited: { can: ["send"] } }) };
    expect(verbsOfRole(inherited, "inherited")).toEqual([]);
  });
});

describe("denyVerb", () => {
  const swarmSession = session({ manifest: swarm });

  it("returns null when the seat holds the verb", () => {
    const lead = member({ roomRole: "lead" });
    expect(denyVerb(swarmSession, lead, "invite")).toBeNull();
  });

  it("names the seat, the verb, and what the seat does hold", () => {
    const reviewSession = session({ manifest: resolveManifest({ room: "r", preset: "review" }) });
    const reviewer = member({ roomRole: "reviewer" });
    expect(denyVerb(reviewSession, reviewer, "request_actions")).toBe(
      'your role "reviewer" does not hold the verb "request_actions" '
      + "(it holds: send, respond_actions).",
    );
  });

  it('says "none" rather than an empty list for a verbless seat', () => {
    // The unknown-role branch produces the same "(it holds: none)", so pin that
    // this is the defined-but-verbless seat and not that branch.
    expect(swarm.roles).toHaveProperty("observer");
    const observer = member({ roomRole: "observer" });
    expect(denyVerb(swarmSession, observer, "send")).toBe(
      'your role "observer" does not hold the verb "send" (it holds: none).',
    );
  });

  it("refuses every verb to a seat whose role the manifest does not define", () => {
    const ghost = member({ roomRole: "ghost" });
    for (const verb of ["send", "invite", "revoke", "request_actions", "respond_actions"] as const) {
      expect(denyVerb(swarmSession, ghost, verb), verb).toBe(
        `your role "ghost" does not hold the verb "${verb}" (it holds: none).`,
      );
    }
  });

  // D2, as a type-level fact rather than a runtime one: the signature takes a
  // Session and a Member. Adding a REQUIRED Identity parameter stops this
  // compiling, and `npm run verify` typechecks before it tests. An OPTIONAL
  // trailing `id?: Identity` does not: a function with extra optional parameters
  // is still assignable to the shorter type below. The comment-stripped source
  // scan in tests/tools/verbs.test.ts (added by a later task) is the only
  // backstop for that case.
  it("is callable with only a session and a member", () => {
    const fn: (s: ReturnType<typeof session>, m: ReturnType<typeof member>, v: "send") => string | null = denyVerb;
    expect(fn(session({ manifest: roomManifest() }), member(), "send")).toBeNull();
  });
});
