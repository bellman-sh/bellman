/**
 * Durable Objects hold sessions written before Session.manifest existed.
 * A row without a manifest is treated as gone rather than crashing a read.
 */
import { describe, it, expect } from "vitest";
import { hydrateStoredSession } from "../src/stored-session.js";
import { session } from "./helpers/fixtures.js";

describe("legacy Durable Object rows", () => {
  it("passes through a session that has a manifest", () => {
    const s = session();
    expect(hydrateStoredSession(s)?.id).toBe(s.id);
  });

  it("treats a pre-manifest row as gone", () => {
    const { manifest, ...legacy } = session();
    expect(hydrateStoredSession(legacy)).toBeUndefined();
  });

  it("treats a row whose manifest lost its roles as gone", () => {
    const s = session();
    expect(hydrateStoredSession({ ...s, manifest: { room: "r", mode: "pair" } }))
      .toBeUndefined();
  });

  it("treats a row whose roles is an array as gone", () => {
    // An array is an object too, so `typeof roles === "object"` alone lets it through.
    // The rest of the manifest is valid, so only the array-ness can trigger the rejection.
    const s = session();
    expect(hydrateStoredSession({ ...s, manifest: { ...s.manifest, roles: [] } }))
      .toBeUndefined();
    expect(hydrateStoredSession({ ...s, manifest: { ...s.manifest, roles: [{ can: [] }] } }))
      .toBeUndefined();
  });

  it("treats undefined and null as gone", () => {
    expect(hydrateStoredSession(undefined)).toBeUndefined();
    expect(hydrateStoredSession(null)).toBeUndefined();
  });
});
