/**
 * Public names (public names spec): the rule a name keeps, whether a room holds one, claiming
 * one through the index, bellman_start's public_name and the tool that checks and sets one.
 * The route is tests/http-public.test.ts; the store methods are the store contract's.
 */
import { describe, expect, it } from "vitest";
import { PUBLIC_NAME, heldName, holdsName, publicNameRefusal } from "../src/public-names.js";
import { hydrateStoredSession } from "../src/stored-session.js";
import { roomManifest, session } from "./helpers/fixtures.js";

describe("the name rule (D2)", () => {
  it("takes 3 to 40 lowercase letters, digits and single hyphens, a letter or digit at each end", () => {
    for (const good of ["bellman-dev", "abc", "a1b", "a-b", "room-2026-10", "x".repeat(40)]) {
      expect(PUBLIC_NAME.test(good), good).toBe(true);
    }
    // Review Focus 4: nothing here is lowercased or rewritten into a name that would pass.
    for (const bad of ["ab", "x".repeat(41), "Bellman-Dev", "bellman_dev", "-dev", "dev-", "bel--dev", "bellman dev", "dév", "qs_3f0c", ""]) {
      expect(PUBLIC_NAME.test(bad), bad).toBe(false);
    }
  });

  it("refuses a name outside it in the rule's words", () => {
    expect(publicNameRefusal("Bellman-Dev")).toBe(
      'public name "Bellman-Dev": use 3 to 40 lowercase letters, digits and single hyphens, starting and ending with a letter or digit',
    );
    expect(publicNameRefusal("bellman-dev")).toBeNull();
  });
});

describe("holding a name (D5)", () => {
  const room = (over: Parameters<typeof session>[0] = {}) =>
    session({ manifest: roomManifest({ public: true }), publicName: "bellman-dev", ...over });

  it("is the room whose record names it, while public and open", () => {
    expect(holdsName(room(), "bellman-dev")).toBe(true);
    expect(heldName(room())).toBe("bellman-dev");
  });

  it("ends with a rename, a close or being made private, and a room that is not there holds nothing", () => {
    expect(holdsName(room({ publicName: "other-name" }), "bellman-dev")).toBe(false);
    expect(holdsName(room({ closed: true, closedAt: 1 }), "bellman-dev")).toBe(false);
    expect(holdsName(room({ unpublishedAt: 1 }), "bellman-dev")).toBe(false);
    expect(holdsName(room({ manifest: roomManifest({ public: false }) }), "bellman-dev")).toBe(false);
    expect(holdsName(undefined, "bellman-dev")).toBe(false);
    expect(heldName(room({ closed: true, closedAt: 1 }))).toBeNull();
    expect(heldName(room({ publicName: null }))).toBeNull();
  });

  it("reads null on a room stored before names", () => {
    const old = structuredClone(session()) as unknown as { publicName?: string | null };
    delete old.publicName;
    expect(hydrateStoredSession(old)!.publicName).toBeNull();
  });
});
