import { describe, it, expect } from "vitest";
import { hydrateStoredSession } from "../src/stored-session.js";
import { session } from "./helpers/fixtures.js";

/** Rows written before join codes carried a role. */
function legacyRow(over: Record<string, unknown> = {}) {
  const { joinCodes: _dropped, events: _events, ...rest } = session();
  return { ...rest, joinCode: "BELL-7F3K-92", joinCodeExpiresAt: 1_800_000, ...over };
}

describe("hydrateStoredSession — legacy join codes", () => {
  it("lifts a legacy code under the manifest's default role", () => {
    const row = hydrateStoredSession(legacyRow())!;
    expect(row.joinCodes).toEqual({
      peer_b: { code: "BELL-7F3K-92", expiresAt: 1_800_000 },
    });
  });

  /** The code has no role group, and needs none: the whole string is the key. */
  it("keeps the legacy string verbatim", () => {
    const row = hydrateStoredSession(legacyRow())!;
    expect(row.joinCodes["peer_b"].code).toBe("BELL-7F3K-92");
  });

  it("strips both legacy fields so no stale mirror survives", () => {
    const row = hydrateStoredSession(legacyRow())!;
    expect(row).not.toHaveProperty("joinCode");
    expect(row).not.toHaveProperty("joinCodeExpiresAt");
  });

  /** Review Focus 1: a consumed legacy code is an empty map, not a null record. */
  it("lifts an already-consumed legacy code to an empty map", () => {
    const row = hydrateStoredSession(legacyRow({ joinCode: null }))!;
    expect(row.joinCodes).toEqual({});
  });

  it("leaves a row that already has joinCodes alone", () => {
    const current = { ...session(), events: undefined };
    delete (current as Record<string, unknown>).events;
    const row = hydrateStoredSession(current)!;
    expect(row.joinCodes).toEqual(session().joinCodes);
  });

  it("still refuses a row with no manifest", () => {
    expect(hydrateStoredSession({ ...legacyRow(), manifest: undefined })).toBeUndefined();
  });
});
