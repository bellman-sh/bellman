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
public: true
mode: "pair"
heartbeat_on: "5m"
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

describe("the panel's room.yaml export", () => {
  it("loads through the bridge and starts the room it spells out", () => {
    const dir = mkdtempSync(join(tmpdir(), "bellman-export-"));
    dirs.push(dir);
    mkdirSync(join(dir, ".bellman"));
    writeFileSync(join(dir, ".bellman", "room.yaml"), EXPORTED);
    const m = resolveManifest(loadRoomManifest(dir));
    expect(m).toMatchObject({
      room: "my_review", purpose: "Review where the reviewer may ask too", mode: "pair", preset: null,
      defaultRole: "reviewer", creatorRole: "author", heartbeatOnMs: 300_000, public: true,
    });
    expect(m.roles).toEqual({
      author: { can: ["send", "invite", "revoke", "request_actions", "respond_actions", "write_surface"], description: "Brought the work.", reports: true },
      reviewer: { can: ["send", "request_actions", "respond_actions"], description: null, reports: false },
    });
  });
});
