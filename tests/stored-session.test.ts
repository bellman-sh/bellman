import { describe, it, expect } from "vitest";
import { hydrateStoredSession } from "../src/stored-session.js";
import { ENTITLEMENTS } from "../src/auth.js";
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
    // One fixture call, not two: session() stamps its join code's expiresAt from Date.now(), so
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

/**
 * A record written before the working surface (#129): it has no `surfaceCursor`.
 * The key is ABSENT, not undefined, which is what Durable Object storage hands
 * back for a row that never had it.
 */
describe("hydrateStoredSession — a record stored before the surface", () => {
  /** No row ever changed there, which is what 0 says; `undefined` is not a cursor anything can compare. */
  it("reads a missing surfaceCursor as 0", () => {
    const { events: _events, ...raw } = session();
    // Without this, a fixture that grew a cursor would pass for the wrong reason.
    expect("surfaceCursor" in raw).toBe(false);
    expect(hydrateStoredSession(raw)!.surfaceCursor).toBe(0);
  });

  /** A default that clobbered would report every room that has written to its surface as never having moved. */
  it("leaves a surfaceCursor the room has already moved alone", () => {
    const { events: _events, ...raw } = session();
    expect(hydrateStoredSession({ ...raw, surfaceCursor: 12 })!.surfaceCursor).toBe(12);
  });
});

/**
 * A record stored before rooms persisted (#18): it carries the clock, and from
 * the same change the plan cap. Both are stripped rather than defaulted,
 * because a missing clock IS the new state and a stored cap would be the stale
 * mirror of capacityOf(manifest).
 */
describe("hydrateStoredSession — a record stored with a clock", () => {
  it("strips expiresAt", () => {
    const { events: _events, ...raw } = session();
    const row = hydrateStoredSession({ ...raw, expiresAt: 1 })!;
    expect(row).not.toHaveProperty("expiresAt");
  });

  it("strips maxMembers, so capacity is the manifest's from the next read", () => {
    const { events: _events, ...raw } = session();
    const row = hydrateStoredSession({ ...raw, maxMembers: 8 })!;
    expect(row).not.toHaveProperty("maxMembers");
  });
});

/**
 * A record written before blobs (#183): it has no `blobBytes`. The key is
 * ABSENT, not undefined, which is what Durable Object storage hands back.
 */
describe("hydrateStoredSession — a record stored before blobs", () => {
  /** Nothing was ever charged there, which is what 0 says; a quota check cannot add to undefined. */
  it("reads a missing blobBytes as 0", () => {
    const { events: _events, ...raw } = session();
    expect("blobBytes" in raw).toBe(false);
    expect(hydrateStoredSession(raw)!.blobBytes).toBe(0);
  });

  /** A default that clobbered would hand every room its whole quota back on each read. */
  it("leaves a blobBytes the room has already charged alone", () => {
    const { events: _events, ...raw } = session();
    expect(hydrateStoredSession({ ...raw, blobBytes: 4096 })!.blobBytes).toBe(4096);
  });

  /** A room written before the ceiling existed reads the free plan's: conservative, and it ends with the room. */
  it("reads a missing blobBytesCeiling as the free ceiling, and leaves a stamped one alone", () => {
    const { events: _events, blobBytesCeiling: _ceiling, ...raw } = session();
    expect("blobBytesCeiling" in raw).toBe(false);
    expect(hydrateStoredSession(raw)!.blobBytesCeiling).toBe(ENTITLEMENTS.free.blobBytesPerRoom);
    expect(hydrateStoredSession({ ...raw, blobBytesCeiling: 7 })!.blobBytesCeiling).toBe(7);
  });
});

/**
 * A record closed before retention (#65): it carries `closed: true` and none of the four fields the
 * purge reads. The keys are ABSENT, not undefined, which is what Durable Object storage hands back.
 * Every default is the one that keeps the room: no known close time, no window, no delete asked for,
 * and a sweep that has not run (it never will, without a close time to date it from).
 */
describe("hydrateStoredSession — a record closed before retention", () => {
  const legacyClosed = () => {
    const { events: _events, closedAt: _c, retainAfterCloseMs: _r, purgeAt: _p, blobsSwept: _b, ...raw } =
      session({ closed: true });
    // Without this, a fixture that grew the fields would pass for the wrong reason.
    for (const key of ["closedAt", "retainAfterCloseMs", "purgeAt", "blobsSwept"]) {
      expect(key in raw, key).toBe(false);
    }
    return raw;
  };

  it("reads the four missing fields as the ones that keep the room", () => {
    expect(hydrateStoredSession(legacyClosed())).toMatchObject({
      closed: true, closedAt: null, retainAfterCloseMs: null, purgeAt: null, blobsSwept: false,
    });
  });

  /** A default that clobbered would erase every window a room was promised, and every delete asked for. */
  it("leaves fields the room already carries alone", () => {
    expect(hydrateStoredSession({
      ...legacyClosed(), closedAt: 1_000, retainAfterCloseMs: 500, purgeAt: 1_200, blobsSwept: true,
    })).toMatchObject({ closedAt: 1_000, retainAfterCloseMs: 500, purgeAt: 1_200, blobsSwept: true });
  });
});
