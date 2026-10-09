/**
 * bellman_start citing a preset its caller saved (designer spec D6): looked up
 * before resolving, expanded at start like every room, and refused by name when
 * it is nobody's the caller can cite.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Harness, DEV_KEY, type Peer } from "../helpers/harness.js";
import { brief } from "../helpers/fixtures.js";
import type { SavedPreset } from "../../src/types.js";

let h: Harness;
let jesse: Peer;
beforeEach(async () => {
  h = new Harness();
  jesse = await h.connect(DEV_KEY.jesse);
});
afterEach(async () => {
  await h.close();
});

const saved = (name: string, over: Partial<SavedPreset> = {}): SavedPreset => ({
  name,
  description: null,
  mode: "pair",
  heartbeat_on: null,
  housekeeping: null,
  roles: {
    author: { can: ["send", "invite", "revoke", "write_surface"], description: "Brought the work.", reports: false },
    reviewer: { can: ["send", "request_actions"], description: null, reports: false },
  },
  default_role: "reviewer",
  creator_role: "author",
  updated_at: "2026-10-09T12:00:00.000Z",
  ...over,
});

const start = (preset: string, extra: Record<string, unknown> = {}) =>
  jesse.call("bellman_start", { manifest: { room: "Q3 review", preset, ...extra }, brief: brief() });

describe("bellman_start citing a saved preset", () => {
  it("starts a room whose roles are the preset's, recorded as authored", async () => {
    await h.store.putPreset("u_jesse", saved("my_review"), 20);
    const out = await start("my_review");
    expect(out.isError, out.text).toBe(false);
    const room = out.data.room as { preset: string | null; your_role: string; roles: Record<string, string[]> };
    expect(room.preset).toBeNull();
    expect(room.your_role).toBe("author");
    expect(room.roles).toEqual({ author: ["send", "invite", "revoke", "write_surface"], reviewer: ["send", "request_actions"] });
  });

  it("leaves a started room alone when its preset is edited, then deleted", async () => {
    await h.store.putPreset("u_jesse", saved("my_review"), 20);
    const id = String((await start("my_review")).data.session_id);
    await h.store.putPreset("u_jesse", saved("my_review", {
      roles: { solo: { can: ["send"], description: null, reports: false } }, default_role: "solo", creator_role: "solo",
    }), 20);
    await h.store.deletePreset("u_jesse", "my_review");
    expect(Object.keys((await h.store.getSession(id))!.manifest.roles).sort()).toEqual(["author", "reviewer"]);
  });

  it("refuses a name it cannot find, naming the built-ins and the caller's own", async () => {
    await h.store.putPreset("u_jesse", saved("alpha"), 20);
    await h.store.putPreset("u_jesse", saved("beta"), 20);
    const out = await start("gamma");
    expect(out.isError).toBe(true);
    expect(out.text).toContain('invalid manifest — unknown preset "gamma" (built-in: pair, swarm, review; yours: alpha, beta)');
  });

  it("does not let one person cite another's preset", async () => {
    await h.store.putPreset("u_peer", saved("theirs"), 20);
    const out = await start("theirs");
    expect(out.isError).toBe(true);
    expect(out.text).toContain("yours: none");
  });

  // Passes before the change too: the guard that the built-ins still win.
  it("still resolves a built-in by name", async () => {
    const out = await start("review");
    expect(out.isError, out.text).toBe(false);
    expect((out.data.room as { preset: string }).preset).toBe("review");
  });

  it("refuses a saved preset the validator no longer accepts, in the validator's words", async () => {
    await h.store.putPreset("u_jesse", saved("stale", { creator_role: "gone" }), 20);
    const out = await start("stale");
    expect(out.isError).toBe(true);
    expect(out.text).toContain('invalid manifest — creator_role "gone" is not defined in roles');
  });

  it("tells the agent it may cite a saved preset, and where they are made", async () => {
    const { tools } = await jesse.listTools();
    expect(tools.find((t) => t.name === "bellman_start")!.description)
      .toContain("or the name of a preset you saved at dash.bellman.sh/presets");
  });
});

// Housekeeping (#66), integration ruling M1: a saved preset's block reaches the room it
// starts exactly as its heartbeat_on does, because it is expanded here like every other
// field. What the room recorded is read from the store, the truth the alarm derives from.
describe("bellman_start citing a saved preset that carries housekeeping", () => {
  const recorded = async (out: { data: Record<string, unknown> }) => {
    const m = (await h.store.getSession(String(out.data.session_id)))!.manifest;
    return { heartbeatOnMs: m.heartbeatOnMs, housekeeping: m.housekeeping };
  };
  const WATCHFUL = { heartbeat_on: "5m", housekeeping: { quiet_after: "2h", answer_within: "30m" } } satisfies Partial<SavedPreset>;

  it("starts a room with the preset's thresholds, as it starts one with the preset's cadence", async () => {
    await h.store.putPreset("u_jesse", saved("watchful", WATCHFUL), 20);
    const out = await start("watchful");
    expect(out.isError, out.text).toBe(false);
    expect(await recorded(out)).toEqual({
      heartbeatOnMs: 300_000,
      housekeeping: { quietAfterMs: 7_200_000, answerWithinMs: 1_800_000, idleAfterMs: null, repeatAfterMs: null },
    });
  });

  // The cite's own block is the caller's say for this room, so it replaces the preset's whole
  // rather than being merged into it, and it is never dropped without a word.
  it("starts the room with the cite's own block instead, when the cite carries one", async () => {
    await h.store.putPreset("u_jesse", saved("watchful", WATCHFUL), 20);
    const out = await start("watchful", { housekeeping: { idle_after: "1d" } });
    expect(out.isError, out.text).toBe(false);
    expect((await recorded(out)).housekeeping).toEqual({
      quietAfterMs: null, answerWithinMs: null, idleAfterMs: 86_400_000, repeatAfterMs: null,
    });
  });

  it("starts the room with none when the cite says none, as an authored manifest's null or empty block does", async () => {
    await h.store.putPreset("u_jesse", saved("watchful", WATCHFUL), 20);
    for (const none of [null, {}]) {
      const out = await start("watchful", { housekeeping: none });
      expect(out.isError, out.text).toBe(false);
      expect((await recorded(out)).housekeeping, JSON.stringify(none)).toBeNull();
    }
  });

  it("refuses a cite's block the validator refuses, in the validator's words", async () => {
    await h.store.putPreset("u_jesse", saved("watchful", WATCHFUL), 20);
    const out = await start("watchful", { housekeeping: { quiet_after: "1m" } });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('invalid manifest — housekeeping.quiet_after must be between 5m and 7d (got "1m")');
  });

  it("refuses a saved block the validator no longer accepts, as it refuses a stale role", async () => {
    await h.store.putPreset("u_jesse", saved("stale_block", { housekeeping: { idle_after: "8d" } }), 20);
    const out = await start("stale_block");
    expect(out.isError).toBe(true);
    expect(out.text).toContain('invalid manifest — housekeeping.idle_after must be between 5m and 7d (got "8d")');
  });

  // A preset saved before the field existed has no such key at all, in the registry's storage.
  it("starts a room with none from a preset saved before the field existed", async () => {
    const legacy: Partial<SavedPreset> = saved("old_review");
    delete legacy.housekeeping;
    await h.store.putPreset("u_jesse", legacy as SavedPreset, 20);
    const out = await start("old_review");
    expect(out.isError, out.text).toBe(false);
    expect((await recorded(out)).housekeeping).toBeNull();
  });
});
