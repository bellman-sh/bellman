import { describe, it, expect } from "vitest";
import { hydrateStoredSession } from "../src/stored-session.js";
import { mustReport } from "../src/roles.js";
import { roomManifest, session } from "./helpers/fixtures.js";

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
    // One fixture call, not two: session() stamps expiresAt from Date.now(), so
    // calling it twice lets expected and actual straddle a clock tick — measured
    // at 0.026% per run, rare enough to be a real CI flake rather than theoretical.
    const fixture = session();
    const current = { ...fixture, events: undefined };
    delete (current as Record<string, unknown>).events;
    const row = hydrateStoredSession(current)!;
    expect(row.joinCodes).toEqual(fixture.joinCodes);
  });

  it("still refuses a row with no manifest", () => {
    expect(hydrateStoredSession({ ...legacyRow(), manifest: undefined })).toBeUndefined();
  });
});

/**
 * A row written before the heartbeat (#111): its manifest has no `heartbeatOnMs`
 * and none of its roles has `reports`. The keys are ABSENT, not set to undefined,
 * which is what Durable Object storage hands back for a row that never had them.
 */
function preHeartbeatRow(fixture = session()) {
  const { events: _events, ...rest } = fixture;
  const { heartbeatOnMs: _cadence, roles, ...manifest } = rest.manifest;
  const bareRoles = Object.fromEntries(
    Object.entries(roles).map(([key, { reports: _reports, ...def }]) => [key, def]),
  );
  return { ...rest, manifest: { ...manifest, roles: bareRoles } };
}

describe("hydrateStoredSession — a manifest stored before the heartbeat", () => {
  /** `=== null` is how every guard downstream asks "no cadence", and undefined fails it. */
  it("reads a missing cadence as null", () => {
    const row = hydrateStoredSession(preHeartbeatRow())!;
    expect(row.manifest.heartbeatOnMs).toBeNull();
  });

  it("reads a missing `reports` as false on every role", () => {
    const row = hydrateStoredSession(preHeartbeatRow())!;
    const roles = Object.values(row.manifest.roles);
    // More than one, so "every" is not satisfied by a single lucky role.
    expect(roles.length).toBeGreaterThan(1);
    for (const def of roles) expect(def.reports).toBe(false);
    // Through the accessor the tick and the join preview both call, which types
    // its answer as a boolean and would otherwise hand out undefined.
    expect(mustReport(row.manifest, row.manifest.creatorRole)).toBe(false);
  });

  it("changes nothing else about the manifest", () => {
    const fixture = session();
    const row = hydrateStoredSession(preHeartbeatRow(fixture))!;
    expect(row.manifest).toEqual(fixture.manifest);
  });

  /** A default that clobbered would silence every room that did declare a cadence. */
  it("leaves a declared cadence and a role that reports alone", () => {
    const declared = roomManifest({
      roles: {
        lead: { can: ["send"], description: null, reports: true },
        observer: { can: [], description: null, reports: false },
      },
      defaultRole: "observer",
      creatorRole: "lead",
      heartbeatOnMs: 300_000,
    });
    const { events: _events, ...raw } = session({ manifest: declared });
    const row = hydrateStoredSession(raw)!;
    expect(row.manifest.heartbeatOnMs).toBe(300_000);
    expect(row.manifest.roles.lead.reports).toBe(true);
    expect(row.manifest.roles.observer.reports).toBe(false);
  });

  it("does not rewrite the row it was handed", () => {
    const raw = preHeartbeatRow();
    hydrateStoredSession(raw);
    expect("heartbeatOnMs" in raw.manifest).toBe(false);
    for (const def of Object.values(raw.manifest.roles)) {
      expect("reports" in def).toBe(false);
    }
  });
});
