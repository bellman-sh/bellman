/**
 * The heartbeat's vocabulary (vocabulary spec): the room's frequency is `heartbeat`, a role's
 * place on it is `heartbeat_on`, and the old words keep working. Presets are Task 2's.
 */
import { describe, expect, it } from "vitest";
import { resolveManifest } from "../src/manifest.js";

const roles = (lead: Record<string, unknown> = {}, observer: Record<string, unknown> = {}) => ({
  lead: { can: ["send"], ...lead }, observer: { can: [], ...observer },
});
const authored = (over: Record<string, unknown> = {}) => ({
  room: "r", mode: "swarm", roles: roles(), default_role: "observer", creator_role: "lead", ...over,
});
const lead = (over: Record<string, unknown>) => resolveManifest(authored({ heartbeat: "5m", roles: roles(over) })).roles.lead;
const hosted = (host: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  room: "r", mode: "swarm", default_role: "lead", creator_role: "lead", host: { role: "host" },
  roles: { lead: { can: ["send"], ...over }, host: { can: ["send"], ...host } },
});

describe("the new words", () => {
  it("read heartbeat as the room's frequency, on both arms", () => {
    expect(resolveManifest(authored({ heartbeat: "5m" })).heartbeatOnMs).toBe(300_000);
    expect(resolveManifest({ room: "r", preset: "social", heartbeat: "2h" }).heartbeatOnMs).toBe(7_200_000);
    expect(() => resolveManifest(authored({ heartbeat: "1s" }))).toThrow(/^heartbeat must be between/);
  });

  it("read a role's heartbeat_on as true, false, an instruction, absent or valueless", () => {
    expect(lead({ heartbeat_on: true })).toMatchObject({ reports: true, report: null });
    expect(lead({ heartbeat_on: false })).toMatchObject({ reports: false, report: null });
    expect(lead({ heartbeat_on: "  What shipped  " })).toMatchObject({ reports: true, report: "What shipped" });
    expect(lead({})).toMatchObject({ reports: false, report: null });
    expect(lead({ heartbeat_on: null })).toMatchObject({ reports: false, report: null });
    expect(resolveManifest(authored({ heartbeat: null })).heartbeatOnMs).toBeNull();
  });

  it("refuse a blank instruction and one over 300 characters", () => {
    expect(() => lead({ heartbeat_on: "   " })).toThrow('role "lead": heartbeat_on: give true, false, or what this seat reports');
    expect(() => lead({ heartbeat_on: "x".repeat(301) })).toThrow(/roles\.lead\.heartbeat_on/);
  });

  // YAML 1.2 reads off, no, on and yes as text, and a model can quote a boolean. As instructions,
  // each would put on the heartbeat a seat its author may have meant to keep off it.
  it("refuse an instruction that reads as a yes or no, and keep one that only mentions one", () => {
    for (const word of ["off", "No", "YES", " on ", "false", "True", "y", "N"]) {
      expect(() => lead({ heartbeat_on: word }), word).toThrow(
        `role "lead": heartbeat_on: ${JSON.stringify(word.trim())} is text, not a yes or no; give true, false, or what this seat reports`,
      );
    }
    expect(lead({ heartbeat_on: "Yes or no: did it ship?" })).toMatchObject({ reports: true, report: "Yes or no: did it ship?" });
  });

  it("name heartbeat_on when a seat on the heartbeat cannot send", () => {
    expect(() => resolveManifest(authored({ heartbeat: "5m", roles: roles({}, { heartbeat_on: true }) })))
      .toThrow('role "observer" sets heartbeat_on but does not hold the verb "send" (it holds: none)');
  });

  it("name heartbeat for the frequency a host needs, and heartbeat_on for a host role on it", () => {
    expect(() => resolveManifest(hosted({}, { heartbeat_on: true }))).toThrow("a room with a host must set heartbeat (at least 1h)");
    expect(() => resolveManifest({ ...hosted({ heartbeat_on: true }), heartbeat: "1h" })).toThrow('host role "host" must not be on the heartbeat');
  });

  it("name heartbeat when a cite of a preset with no host sets one", () => {
    expect(() => resolveManifest({ room: "r", preset: "pair", heartbeat: "5m" }))
      .toThrow('heartbeat: the "pair" preset has no host, so a cite of it cannot set a cadence; author the roles to set one');
  });
});

// Review Focus 1.
describe("the old words", () => {
  it("read the same room the new words do", () => {
    const old = resolveManifest(authored({ heartbeat_on: "5m", roles: roles({ reports: true, report: "What shipped" }) }));
    const now = resolveManifest(authored({ heartbeat: "5m", roles: roles({ heartbeat_on: "What shipped" }) }));
    expect(old).toEqual(now);
  });

  it("keep today's messages", () => {
    expect(() => resolveManifest(authored({ heartbeat_on: "5m", roles: roles({}, { reports: true }) })))
      .toThrow('role "observer" sets reports: true but does not hold the verb "send" (it holds: none)');
    expect(() => resolveManifest(authored({ roles: roles({ reports: false, report: "x" }) })))
      .toThrow('role "lead" sets a report instruction but does not answer the heartbeat (reports is false)');
    expect(() => resolveManifest({ room: "r", preset: "pair", heartbeat_on: "5m" })).toThrow(/^heartbeat_on: the "pair" preset has no host/);
    expect(() => resolveManifest(hosted({}, { reports: true }))).toThrow("a room with a host must set heartbeat_on (at least 1h)");
    expect(() => resolveManifest({ ...hosted({ reports: true }), heartbeat_on: "1h" })).toThrow('host role "host" must not report');
    expect(() => resolveManifest(authored({ heartbeat_on: "1s" }))).toThrow(/^heartbeat_on must be between/);
  });

  it("read an old blank report as no instruction", () => {
    expect(resolveManifest(authored({ heartbeat_on: "5m", roles: roles({ reports: true, report: "  " }) })).roles.lead.report).toBeNull();
  });
});

describe("one thing, one spelling", () => {
  it("refuses the frequency spelled both ways, naming the old one to drop", () => {
    expect(() => resolveManifest(authored({ heartbeat: "5m", heartbeat_on: "5m" })))
      .toThrow("heartbeat_on: drop it; it is the old name of heartbeat, which this manifest also sets");
    expect(() => resolveManifest({ room: "r", preset: "social", heartbeat: "2h", heartbeat_on: "2h" })).toThrow(/^heartbeat_on: drop it/);
  });

  it("refuses a role spelled both ways, naming the old field to drop", () => {
    expect(() => lead({ heartbeat_on: true, reports: true }))
      .toThrow('role "lead": drop reports; heartbeat_on says whether this seat is on the heartbeat and what it reports');
    expect(() => lead({ heartbeat_on: "x", report: "x" })).toThrow('role "lead": drop report;');
  });

  // Review Focus 3.
  it("accepts different things in different spellings", () => {
    const m = resolveManifest(authored({ heartbeat_on: "5m", roles: roles({ heartbeat_on: "What shipped" }) }));
    expect([m.heartbeatOnMs, m.roles.lead.report]).toEqual([300_000, "What shipped"]);
  });
});
