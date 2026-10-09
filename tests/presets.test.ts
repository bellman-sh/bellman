/**
 * What a person may save as a preset (designer spec D2, D3), and a saved preset
 * as the manifest bellman_start resolves (D6). Pure: no store.
 */
import { describe, expect, it } from "vitest";
import { asManifest, checkPreset } from "../src/presets.js";
import { builtinPresets, resolveManifest } from "../src/manifest.js";

const NOW = Date.parse("2026-10-09T12:00:00Z");

const body = (over: Record<string, unknown> = {}) => ({
  description: "Review where the reviewer may ask too",
  mode: "pair",
  heartbeat_on: "5m",
  roles: {
    author: { can: ["send", "invite", "revoke", "request_actions", "respond_actions", "write_surface"], description: "Brought the work.", reports: true },
    reviewer: { can: ["send", "request_actions", "respond_actions"] },
  },
  default_role: "reviewer",
  creator_role: "author",
  ...over,
});

describe("checkPreset", () => {
  it("saves a legal body under the path's name, every optional field filled in", () => {
    expect(checkPreset("my_review", body(), NOW)).toEqual({
      ok: true,
      preset: {
        name: "my_review",
        description: "Review where the reviewer may ask too",
        mode: "pair",
        heartbeat_on: "5m",
        roles: {
          author: { can: ["send", "invite", "revoke", "request_actions", "respond_actions", "write_surface"], description: "Brought the work.", reports: true },
          reviewer: { can: ["send", "request_actions", "respond_actions"], description: null, reports: false },
        },
        default_role: "reviewer",
        creator_role: "author",
        updated_at: "2026-10-09T12:00:00.000Z",
      },
    });
  });

  it("refuses a name outside the grammar, in the grammar's words", () => {
    expect(checkPreset("My-Review", body(), NOW)).toMatchObject({
      ok: false, status: 400, error: "invalid_request", description: expect.stringContaining("preset names must match"),
    });
  });

  it.each(["pair", "swarm", "review"])("refuses the built-in name %s with its own error", (name) => {
    expect(checkPreset(name, body(), NOW)).toMatchObject({ ok: false, status: 409, error: "builtin" });
  });

  it("refuses a body that names another preset, and takes one that names this one", () => {
    expect(checkPreset("my_review", body({ name: "other" }), NOW)).toMatchObject({ ok: false, status: 400 });
    expect(checkPreset("my_review", body({ name: "my_review" }), NOW)).toMatchObject({ ok: true });
  });

  it("refuses room and purpose, which stay per room, and any key the author arm does not have", () => {
    for (const extra of [{ room: "r" }, { purpose: "p" }, { preset: "pair" }, { color: "red" }]) {
      expect(checkPreset("my_review", body(extra), NOW), JSON.stringify(extra)).toMatchObject({ ok: false, status: 400, error: "invalid_request" });
    }
  });

  it("refuses what the room validator refuses, in the validator's words", () => {
    expect(checkPreset("my_review", body({ creator_role: "boss" }), NOW)).toEqual({
      ok: false, status: 400, error: "invalid_manifest",
      description: 'creator_role "boss" is not defined in roles (defined: author, reviewer)',
    });
    const mute = body({ roles: { lead: { can: [], reports: true } }, default_role: "lead", creator_role: "lead" });
    expect(checkPreset("my_review", mute, NOW)).toMatchObject({
      ok: false, error: "invalid_manifest", description: expect.stringContaining('role "lead" sets reports: true but does not hold the verb "send"'),
    });
    expect(checkPreset("my_review", body({ heartbeat_on: "10s" }), NOW)).toMatchObject({
      ok: false, error: "invalid_manifest", description: expect.stringContaining("heartbeat_on must be between"),
    });
  });

  it("gives a saved preset that resolves to the room it describes", () => {
    const check = checkPreset("my_review", body(), NOW);
    if (!check.ok) throw new Error(check.description);
    const m = resolveManifest(asManifest(check.preset, "Q3 review", null));
    expect(m).toMatchObject({
      room: "Q3 review", purpose: null, mode: "pair", preset: null, defaultRole: "reviewer", creatorRole: "author", heartbeatOnMs: 300_000,
    });
    expect(m.roles.reviewer.can).toEqual(["send", "request_actions", "respond_actions"]);
  });
});

describe("builtinPresets", () => {
  it("lists the three built-ins in a saved preset's form, each of which saves under a new name", () => {
    const all = builtinPresets();
    expect(all.map((p) => p.name)).toEqual(["pair", "swarm", "review"]);
    for (const p of all) {
      expect(p.updated_at).toBeNull();
      expect(typeof p.description).toBe("string");
      const clone = { description: p.description, mode: p.mode, heartbeat_on: p.heartbeat_on, roles: p.roles, default_role: p.default_role, creator_role: p.creator_role };
      expect(checkPreset(`my_${p.name}`, clone, NOW), p.name).toMatchObject({ ok: true });
    }
  });

  it("hands out fresh copies: changing one leaves the next call alone", () => {
    builtinPresets()[0].roles.peer_a.can.push("send");
    expect(builtinPresets()[0].roles.peer_a.can.filter((v) => v === "send")).toHaveLength(1);
  });
});
