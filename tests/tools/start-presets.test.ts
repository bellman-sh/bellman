/**
 * bellman_start citing a preset its caller saved (designer spec D6): looked up
 * before resolving, expanded at start like every room, and refused by name when
 * it is nobody's the caller can cite.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Harness, DEV_KEY, type Peer } from "../helpers/harness.js";
import { brief } from "../helpers/fixtures.js";
import { HOST_MEMBER_ID } from "../../src/host.js";
import type { Identity, SavedPreset } from "../../src/types.js";

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
  roles: {
    author: { can: ["send", "invite", "revoke", "write_surface"], description: "Brought the work.", reports: false },
    reviewer: { can: ["send", "request_actions"], description: null, reports: false },
  },
  default_role: "reviewer",
  creator_role: "author",
  updated_at: "2026-10-09T12:00:00.000Z",
  ...over,
});

const start = (preset: string) => jesse.call("bellman_start", { manifest: { room: "Q3 review", preset }, brief: brief() });

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

  it("starts a room whose roles carry the preset's heartbeat instructions", async () => {
    await h.store.putPreset("u_jesse", saved("my_review", {
      heartbeat_on: "5m",
      roles: {
        author: { can: ["send", "invite", "revoke", "write_surface"], description: "Brought the work.", reports: true, report: "What changed" },
        reviewer: { can: ["send", "request_actions"], description: null, reports: false },
      },
    }), 20);
    const out = await start("my_review");
    expect(out.isError, out.text).toBe(false);
    expect((await h.store.getSession(String(out.data.session_id)))!.manifest.roles.author.report).toBe("What changed");
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
    expect(out.text).toContain('invalid manifest — unknown preset "gamma" (built-in: pair, swarm, review, social; yours: alpha, beta)');
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

  /**
   * A person may hold a preset saved as `social` from before it was a built-in. The
   * built-in wins the cite, as every built-in's name does: the saved one is listed
   * and deletable (tests/http-presets.test.ts), but no longer reachable by name.
   */
  it("starts the built-in social for a cite of social, though the caller saved a preset under that name", async () => {
    await h.store.putPreset("u_jesse", saved("social"), 20);
    const out = await start("social");
    expect(out.isError, out.text).toBe(false);
    const room = out.data.room as { preset: string | null; host: unknown };
    expect(room.preset).toBe("social");
    expect(room.host).toEqual({ role: "host", model: "haiku" });
  });
});

/**
 * A saved preset may carry the author arm's `host` block, so it must not be a way
 * around what an inline block meets (#188 beneath the designer): the plan refusal,
 * and the slot a plan's hosted rooms are counted in, one count for both.
 */
describe("bellman_start citing a saved preset with a host", () => {
  const max: Identity = { userId: "u_max", orgId: null, plan: "max", role: "member", label: "max" };
  const pro: Identity = { userId: "u_pro", orgId: null, plan: "pro", role: "member", label: "pro" };
  const hosted = (name: string, over: Partial<SavedPreset> = {}): SavedPreset => saved(name, {
    mode: "swarm",
    heartbeat_on: "2h",
    roles: {
      lead: { can: ["send", "invite"], description: null, reports: false },
      guest: { can: ["send"], description: null, reports: false },
      emcee: { can: ["send"], description: null, reports: false },
    },
    default_role: "guest",
    creator_role: "lead",
    host: { role: "emcee", model: "haiku", instructions: null },
    ...over,
  });
  const cite = (preset: string, extra: Record<string, unknown> = {}) =>
    ({ manifest: { room: "mornings", preset, ...extra }, brief: brief() });
  const inline = { manifest: { room: "the square", preset: "social" }, brief: brief() };

  it("is refused on a plan with no hosted seat, as an inline host block is, and takes no slot", async () => {
    for (const who of [pro, { ...pro, userId: "u_free", plan: "free" as const, label: "free" }]) {
      await h.store.putPreset(who.userId, hosted("mornings"), 20);
      const out = await (await h.connectAs(who)).call("bellman_start", cite("mornings"));
      expect(out.isError, who.plan).toBe(true);
      expect(out.text).toContain(`a hosted seat requires the max or team plan (you are on "${who.plan}")`);
      expect(await h.store.countCreatesThisMonth(who.userId)).toBe(0);
      expect(await h.store.reserveHostedRoom(who.userId, "qs_probe", 1)).toEqual({ ok: true });
    }
  });

  it("seats the host and takes a slot from the count an inline host block takes from, so the limit holds across both", async () => {
    await h.store.putPreset(max.userId, hosted("mornings"), 20);
    const creator = await h.connectAs(max);
    expect((await creator.call("bellman_start", inline)).isError).toBe(false);
    expect((await creator.call("bellman_start", inline)).isError).toBe(false);
    const fromSaved = await creator.call("bellman_start", cite("mornings"));
    expect(fromSaved.isError, fromSaved.text).toBe(false);
    const s = (await h.store.getSession(String(fromSaved.data.session_id)))!;
    expect(s.manifest.host).toEqual({ role: "emcee", model: "haiku", instructions: null });
    expect(s.members.find((m) => m.memberId === HOST_MEMBER_ID)?.roomRole).toBe("emcee");
    expect(s.hostUnitsPerMonth).toBe(3000);

    for (const fourth of [cite("mornings"), inline]) {
      const out = await creator.call("bellman_start", fourth);
      expect(out.isError).toBe(true);
      expect(out.text).toContain('hosted room limit reached: 3 hosted rooms open, the most the "max" plan allows');
    }
    expect(await h.store.countCreatesThisMonth(max.userId)).toBe(3);
  });

  it("lets a cite set its beat, as a cite of social may; refuses one for a saved preset with no host, as for a built-in", async () => {
    await h.store.putPreset(max.userId, hosted("mornings"), 20);
    await h.store.putPreset(max.userId, saved("plain"), 20);
    const creator = await h.connectAs(max);
    const slower = await creator.call("bellman_start", cite("mornings", { heartbeat_on: "6h" }));
    expect(slower.isError, slower.text).toBe(false);
    expect((slower.data.room as { heartbeat_on_seconds: number }).heartbeat_on_seconds).toBe(21_600);
    const own = await creator.call("bellman_start", cite("mornings", { heartbeat_on: null }));
    expect((own.data.room as { heartbeat_on_seconds: number }).heartbeat_on_seconds).toBe(7_200);

    const refused = await creator.call("bellman_start", cite("plain", { heartbeat_on: "6h" }));
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('invalid manifest — heartbeat_on: the "plain" preset has no host, so a cite of it cannot set a cadence');
    // Faster than a host's floor is the validator's refusal, in its words, whatever path the cite took.
    const tooFast = await creator.call("bellman_start", cite("mornings", { heartbeat_on: "30m" }));
    expect(tooFast.text).toContain('a room with a host must tick no faster than 1h (got "30m")');
    expect(await h.store.countCreatesThisMonth(max.userId)).toBe(2);
  });
});
