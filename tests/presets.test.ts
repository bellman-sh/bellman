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
        host: null,
        updated_at: "2026-10-09T12:00:00.000Z",
      },
    });
  });

  it("refuses a name outside the grammar, in the grammar's words", () => {
    expect(checkPreset("My-Review", body(), NOW)).toMatchObject({
      ok: false, status: 400, error: "invalid_request", description: expect.stringContaining("preset names must match"),
    });
  });

  it.each(["pair", "swarm", "review", "social"])("refuses the built-in name %s with its own error", (name) => {
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

describe("a saved preset with a host (#188 beneath the designer)", () => {
  const hosted = (over: Record<string, unknown> = {}) => body({
    description: "Ask the room something each morning",
    mode: "swarm",
    heartbeat_on: "24h",
    roles: {
      lead: { can: ["send", "invite"] },
      guest: { can: ["send"] },
      emcee: { can: ["send"] },
    },
    default_role: "guest",
    creator_role: "lead",
    host: { role: "emcee", instructions: "One question about what they shipped." },
    ...over,
  });

  it("keeps the host block, its model defaulted as the author arm defaults it", () => {
    const check = checkPreset("standup", hosted(), NOW);
    if (!check.ok) throw new Error(check.description);
    expect(check.preset.host).toEqual({ role: "emcee", model: "haiku", instructions: "One question about what they shipped." });
  });

  it("hands the host to resolveManifest, so the room it starts has one", () => {
    const check = checkPreset("standup", hosted(), NOW);
    if (!check.ok) throw new Error(check.description);
    const m = resolveManifest(asManifest(check.preset, "mornings", null));
    expect(m.host).toEqual({ role: "emcee", model: "haiku", instructions: "One question about what they shipped." });
    expect(m.heartbeatOnMs).toBe(86_400_000);
  });

  it("refuses a host block the room validator refuses, in its words", () => {
    expect(checkPreset("standup", hosted({ heartbeat_on: "30m" }), NOW)).toEqual({
      ok: false, status: 400, error: "invalid_manifest", description: 'a room with a host must tick no faster than 1h (got "30m")',
    });
    expect(checkPreset("standup", hosted({ host: { role: "lead" } }), NOW)).toMatchObject({
      ok: false, error: "invalid_manifest", description: 'host role "lead" must hold exactly the verb "send" (it holds: send, invite)',
    });
  });

  it("reads a preset saved before hosts reached the presets, with no host key, as having none", () => {
    const check = checkPreset("my_review", body(), NOW);
    if (!check.ok) throw new Error(check.description);
    const { host: _gone, ...legacy } = check.preset;
    expect(resolveManifest(asManifest(legacy, "Q3 review", null)).host).toBeNull();
  });
});

describe("builtinPresets", () => {
  it("lists the four built-ins in a saved preset's form, each of which saves under a new name", () => {
    const all = builtinPresets();
    expect(all.map((p) => p.name)).toEqual(["pair", "swarm", "review", "social"]);
    for (const p of all) {
      expect(p.updated_at).toBeNull();
      expect(typeof p.description).toBe("string");
      const clone = { description: p.description, mode: p.mode, heartbeat_on: p.heartbeat_on, roles: p.roles, default_role: p.default_role, creator_role: p.creator_role, host: p.host };
      expect(checkPreset(`my_${p.name}`, clone, NOW), p.name).toMatchObject({ ok: true });
    }
  });

  it("shows social with its host and its hour, so a clone of it saves a hosted preset", () => {
    const social = builtinPresets().find((p) => p.name === "social")!;
    expect(social).toMatchObject({ mode: "swarm", heartbeat_on: "1h", host: { role: "host", model: "haiku", instructions: null } });
    const { name: _name, updated_at: _at, ...shape } = social;
    const check = checkPreset("my_social", shape, NOW);
    if (!check.ok) throw new Error(check.description);
    expect(resolveManifest(asManifest(check.preset, "the square", null))).toMatchObject({
      host: { role: "host", model: "haiku", instructions: null }, heartbeatOnMs: 3_600_000, defaultRole: "guest",
    });
    for (const p of builtinPresets().filter((b) => b.name !== "social")) {
      expect({ name: p.name, heartbeat_on: p.heartbeat_on, host: p.host }).toEqual({ name: p.name, heartbeat_on: null, host: null });
    }
  });

  it("hands out fresh copies: changing one leaves the next call alone", () => {
    builtinPresets()[0].roles.peer_a.can.push("send");
    expect(builtinPresets()[0].roles.peer_a.can.filter((v) => v === "send")).toHaveLength(1);
  });
});
