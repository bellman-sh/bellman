/**
 * A role's heartbeat instruction (heartbeat instructions spec): what the seat
 * reports when the tick arrives, in the creator's words, only on a seat that
 * answers it. Tasks 1 and 2 of the plan add to this file.
 */
import { describe, expect, it } from "vitest";
import { ManifestError, resolveManifest } from "../src/manifest.js";
import { checkPreset } from "../src/presets.js";
import { hydrateStoredSession } from "../src/stored-session.js";
import { session } from "./helpers/fixtures.js";

export const authored = (lead: Record<string, unknown> = {}) => ({
  room: "review",
  mode: "swarm",
  heartbeat_on: "5m",
  roles: { lead: { can: ["send"], reports: true, ...lead }, observer: { can: [] } },
  default_role: "observer",
  creator_role: "lead",
});

describe("a role's report instruction", () => {
  it("is kept on a role that answers the heartbeat", () => {
    expect(resolveManifest(authored({ report: "What you shipped and what blocks you" })).roles.lead.report)
      .toBe("What you shipped and what blocks you");
  });

  it("is null where none is given, the built-ins' roles included", () => {
    const m = resolveManifest(authored());
    expect([m.roles.lead.report, m.roles.observer.report]).toEqual([null, null]);
    expect(resolveManifest({ room: "r", preset: "review" }).roles.reviewer.report).toBeNull();
  });

  it("is refused on a role that does not answer the heartbeat, in the validator's words", () => {
    const quiet = authored({ reports: false, report: "anything" });
    expect(() => resolveManifest(quiet)).toThrow(ManifestError);
    expect(() => resolveManifest(quiet))
      .toThrow('role "lead" sets a report instruction but does not answer the heartbeat (reports is false)');
  });

  it("is at most 300 characters", () => {
    expect(() => resolveManifest(authored({ report: "x".repeat(301) }))).toThrow(/roles\.lead\.report/);
    expect(resolveManifest(authored({ report: "x".repeat(300) })).roles.lead.report).toHaveLength(300);
  });

  it("reads as null on a room stored before it", () => {
    const old = structuredClone(session()) as unknown as { manifest: { roles: Record<string, Record<string, unknown>> } };
    for (const def of Object.values(old.manifest.roles)) delete def.report;
    const hydrated = hydrateStoredSession(old)!;
    for (const def of Object.values(hydrated.manifest.roles)) expect(def.report).toBeNull();
  });

  it("is saved with a preset and given back", () => {
    const body = { mode: "swarm", heartbeat_on: "5m", roles: authored({ report: "What you shipped" }).roles, default_role: "observer", creator_role: "lead" };
    const check = checkPreset("my_review", body, 0);
    expect(check.ok && check.preset.roles.lead.report).toBe("What you shipped");
    expect(check.ok && check.preset.roles.observer.report).toBeNull();
  });
});
