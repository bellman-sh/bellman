/**
 * The room.yaml the panel's Copy button writes (designer spec D8) loads through
 * the bridge's loader and starts the room it spells out. EXPORTED is the dash
 * repo's src/lib/presets.test.ts fixture byte for byte: change one, change both.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRoomManifest } from "../src/bridge.js";
import { resolveManifest } from "../src/manifest.js";

const EXPORTED = `room: "my_review"
purpose: "Review where the reviewer may ask too"
mode: "pair"
heartbeat_on: "5m"
housekeeping:
  quiet_after: "2h"
  answer_within: "30m"
  idle_after: "1d"
  repeat_after: "4h"
roles:
  "author":
    can: ["send", "invite", "revoke", "request_actions", "respond_actions", "write_surface"]
    description: "Brought the work."
    reports: true
  "reviewer":
    can: ["send", "request_actions", "respond_actions"]
    reports: false
default_role: "reviewer"
creator_role: "author"
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** `text` as a repository's .bellman/room.yaml, read by the bridge's loader. */
function load(text: string): Record<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), "bellman-export-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".bellman"));
  writeFileSync(join(dir, ".bellman", "room.yaml"), text);
  return loadRoomManifest(dir)!;
}

describe("the panel's room.yaml export", () => {
  it("loads through the bridge and starts the room it spells out", () => {
    const m = resolveManifest(load(EXPORTED));
    expect(m).toMatchObject({
      room: "my_review", purpose: "Review where the reviewer may ask too", mode: "pair", preset: null,
      defaultRole: "reviewer", creatorRole: "author", heartbeatOnMs: 300_000,
    });
    expect(m.roles).toEqual({
      author: { can: ["send", "invite", "revoke", "request_actions", "respond_actions", "write_surface"], description: "Brought the work.", reports: true },
      reviewer: { can: ["send", "request_actions", "respond_actions"], description: null, reports: false },
    });
  });

  // Housekeeping (#66), integration ruling M3: the block is carried as heartbeat_on is, by the
  // loader that hands the file over and by the resolver that reads it.
  it("hands over its housekeeping block as the file spells it, beside heartbeat_on", () => {
    const loaded = load(EXPORTED);
    expect(loaded.heartbeat_on).toBe("5m");
    expect(loaded.housekeeping).toEqual({ quiet_after: "2h", answer_within: "30m", idle_after: "1d", repeat_after: "4h" });
  });

  it("starts a room with the thresholds the block spells out", () => {
    expect(resolveManifest(load(EXPORTED)).housekeeping).toEqual({
      quietAfterMs: 7_200_000, answerWithinMs: 1_800_000, idleAfterMs: 86_400_000, repeatAfterMs: 14_400_000,
    });
  });

  // A preset that sets none exports without the key, as one that sets no cadence exports without
  // heartbeat_on, and so does every file exported before the field existed.
  it("starts a room with none from an export that carries no block", () => {
    const without = EXPORTED.replace(/housekeeping:\n(?:  .+\n)+/, "");
    expect(without).not.toBe(EXPORTED);
    expect(without).not.toContain("housekeeping");
    const m = resolveManifest(load(without));
    expect(m.housekeeping).toBeNull();
    expect(m.heartbeatOnMs).toBe(300_000);
  });
});
