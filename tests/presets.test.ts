/**
 * What a person may save as a preset (designer spec D2, D3), and a saved preset
 * as the manifest bellman_start resolves (D6). Pure: no store.
 */
import { describe, expect, it } from "vitest";
import { asManifest, checkPreset } from "../src/presets.js";
import { builtinPresets, resolveManifest } from "../src/manifest.js";
import type { SavedPreset } from "../src/types.js";

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
        heartbeat: "5m",
        housekeeping: null,
        roles: {
          author: { can: ["send", "invite", "revoke", "request_actions", "respond_actions", "write_surface"], description: "Brought the work.", heartbeat_on: true },
          reviewer: { can: ["send", "request_actions", "respond_actions"], description: null, heartbeat_on: false },
        },
        default_role: "reviewer",
        creator_role: "author",
        host: null,
        public: false,
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

// Housekeeping (#66), integration ruling M1: a saved preset admits exactly what an
// authored manifest admits. The same block is stored, refused and resolved the same
// way through either door, and what is stored is what the room is started from.
describe("checkPreset and housekeeping", () => {
  const authoredWith = (block: unknown) => ({
    room: "r", purpose: null, mode: "pair", heartbeat_on: "5m",
    roles: body().roles, default_role: "reviewer", creator_role: "author",
    ...(block === undefined ? {} : { housekeeping: block }),
  });
  const savedWith = (block: unknown) => checkPreset("p", body(block === undefined ? {} : { housekeeping: block }), NOW);
  const ALL_FOUR = { quiet_after: "2h", answer_within: "30m", idle_after: "1d", repeat_after: "4h" };

  // [what the body says, what is stored]. One representation of "none" (null), and a
  // key the body leaves valueless is not kept, as heartbeat_on's null is not.
  it.each([
    ["no housekeeping key", undefined, null],
    ["a null block", null, null],
    ["an empty block", {}, null],
    ["one threshold", { quiet_after: "2h" }, { quiet_after: "2h" }],
    ["all four keys", ALL_FOUR, ALL_FOUR],
    ["a valueless key, as YAML reads one", { quiet_after: "2h", idle_after: null }, { quiet_after: "2h" }],
    ["repeat_after alone, which has nothing to repeat yet", { repeat_after: "1h" }, { repeat_after: "1h" }],
  ])("saves %s, and the room cited from it is the room the authored manifest starts", (_what, written, stored) => {
    const check = savedWith(written);
    if (!check.ok) throw new Error(check.description);
    expect(check.preset.housekeeping).toEqual(stored);
    expect(resolveManifest(asManifest(check.preset, "r", null)).housekeeping)
      .toEqual(resolveManifest(authoredWith(written)).housekeeping);
  });

  // asManifest is where a cite meets a preset. A cite's block replaces the preset's whole, and an absent or
  // null one leaves the preset's own, as a cite's heartbeat_on is read: one meaning for null on a cite.
  it("lets a cite's block replace the preset's whole, and reads an absent or null one as the preset's own", () => {
    const check = savedWith({ quiet_after: "2h", answer_within: "30m" });
    if (!check.ok) throw new Error(check.description);
    const cited = (cite: Parameters<typeof asManifest>[4]) =>
      resolveManifest(asManifest(check.preset, "r", null, undefined, cite)).housekeeping;
    const own = { quietAfterMs: 7_200_000, answerWithinMs: 1_800_000, idleAfterMs: null, repeatAfterMs: null };

    expect(cited(undefined)).toEqual(own);
    expect(cited(null)).toEqual(own);
    expect(cited({})).toBeNull();
    expect(cited({ idle_after: "1d" })).toEqual({ quietAfterMs: null, answerWithinMs: null, idleAfterMs: 86_400_000, repeatAfterMs: null });
  });

  it("gives a cited preset's thresholds in milliseconds, the repeat window with them", () => {
    const check = savedWith({ quiet_after: "2h", answer_within: "30m", repeat_after: "4h" });
    if (!check.ok) throw new Error(check.description);
    expect(resolveManifest(asManifest(check.preset, "Q3 review", null)).housekeeping).toEqual({
      quietAfterMs: 7_200_000, answerWithinMs: 1_800_000, idleAfterMs: null, repeatAfterMs: 14_400_000,
    });
  });

  it.each([
    ["a threshold below the floor", { quiet_after: "1m" }],
    ["a threshold above the ceiling", { idle_after: "8d" }],
    ["a bad repeat_after standing alone", { repeat_after: "10s" }],
    ["an empty string", { quiet_after: "" }],
    ["something that is not a duration", { answer_within: "soon" }],
    ["a key the block does not have", { quiet_after: "2h", color: "red" }],
    ["something that is not an object", "2h"],
  ])("refuses %s in the words the authored manifest is refused in", (_what, written) => {
    let said = "";
    try {
      resolveManifest(authoredWith(written));
    } catch (e) {
      said = (e as Error).message;
    }
    expect(said, "the authored manifest must be refused for this to compare anything").not.toBe("");
    expect(savedWith(written)).toMatchObject({ ok: false, status: 400, description: said });
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

  // Typed as a SavedPreset with the key left out: it compiles only while `housekeeping` is optional, as `host` is.
  it("reads a preset saved before housekeeping, with no housekeeping key, as setting none", () => {
    const check = checkPreset("my_review", body(), NOW);
    if (!check.ok) throw new Error(check.description);
    const { housekeeping: _gone, ...legacy } = check.preset;
    const stored: SavedPreset = legacy;
    expect(resolveManifest(asManifest(stored, "Q3 review", null)).housekeeping).toBeNull();
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
      const clone = { description: p.description, mode: p.mode, heartbeat: p.heartbeat, housekeeping: p.housekeeping, roles: p.roles, default_role: p.default_role, creator_role: p.creator_role, host: p.host };
      expect(checkPreset(`my_${p.name}`, clone, NOW), p.name).toMatchObject({ ok: true, preset: { housekeeping: null } });
    }
  });

  it("shows social with its host and its hour, so a clone of it saves a hosted preset", () => {
    const social = builtinPresets().find((p) => p.name === "social")!;
    expect(social).toMatchObject({ mode: "swarm", heartbeat: "1h", host: { role: "host", model: "haiku", instructions: null } });
    const { name: _name, updated_at: _at, ...shape } = social;
    const check = checkPreset("my_social", shape, NOW);
    if (!check.ok) throw new Error(check.description);
    expect(resolveManifest(asManifest(check.preset, "the square", null))).toMatchObject({
      host: { role: "host", model: "haiku", instructions: null }, heartbeatOnMs: 3_600_000, defaultRole: "guest",
    });
    for (const p of builtinPresets().filter((b) => b.name !== "social")) {
      expect({ name: p.name, heartbeat: p.heartbeat, host: p.host }).toEqual({ name: p.name, heartbeat: null, host: null });
    }
  });

  it("hands out fresh copies: changing one leaves the next call alone", () => {
    builtinPresets()[0].roles.peer_a.can.push("send");
    expect(builtinPresets()[0].roles.peer_a.can.filter((v) => v === "send")).toHaveLength(1);
  });
});

describe("a preset in the heartbeat's words", () => {
  it("saves the new words as the old ones, and refuses each in its own words", () => {
    const now = checkPreset("my_review", body({ heartbeat_on: undefined, heartbeat: "5m", roles: {
      author: { can: ["send"], heartbeat_on: "What changed" }, reviewer: { can: ["send"] },
    } }), NOW);
    expect(now.ok && now.preset).toMatchObject({ heartbeat: "5m", roles: { author: { heartbeat_on: "What changed" }, reviewer: { heartbeat_on: false } } });
    expect(checkPreset("my_review", body({ heartbeat_on: undefined, heartbeat: "10s" }), NOW))
      .toMatchObject({ ok: false, description: expect.stringContaining("heartbeat must be between") });
    expect(checkPreset("my_review", body({ heartbeat_on: "10s" }), NOW))
      .toMatchObject({ ok: false, description: expect.stringContaining("heartbeat_on must be between") });
  });
});
