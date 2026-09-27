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
    expect(verbsOfRole(swarm, "observer")).toEqual([]);
  });

  // THE load-bearing assertion in this describe: an unguarded
  // `manifest.roles[role].can` throws a TypeError here.
  it("fails closed for a role the manifest does not define", () => {
    expect(verbsOfRole(swarm, "ghost")).toEqual([]);
  });

  // A regression guard, NOT proof that Object.hasOwn is load-bearing: for every
  // name reachable on Object.prototype the value has no `can`, so `?.can ?? []`
  // would return [] too. It is here so that a future rewrite reaching for a bare
  // lookup still returns a list rather than an inherited function.
  it.each(["constructor", "prototype", "toString", "__proto__", "valueOf"])(
    "fails closed for %s rather than reaching an inherited property",
    (name) => {
      expect(verbsOfRole(swarm, name)).toEqual([]);
    },
  );
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
  // Session and a Member. If someone adds an Identity parameter this stops
  // compiling, and `npm run verify` typechecks before it tests.
  it("is callable with only a session and a member", () => {
    const fn: (s: ReturnType<typeof session>, m: ReturnType<typeof member>, v: "send") => string | null = denyVerb;
    expect(fn(session({ manifest: roomManifest() }), member(), "send")).toBeNull();
  });
});
