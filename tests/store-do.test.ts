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

  it("treats undefined and null as gone", () => {
    expect(hydrateStoredSession(undefined)).toBeUndefined();
    expect(hydrateStoredSession(null)).toBeUndefined();
  });
});
