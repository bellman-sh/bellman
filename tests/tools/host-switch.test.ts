/**
 * BELLMAN_HOSTED_SEAT off. `bellman_start` refuses every way of declaring a host (an inline
 * block, the social preset, a saved preset that carries one) before the plan's own host
 * refusal and before anything is written, and a room with no host starts as ever. This is
 * the server production runs until the owner switches the seat on.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Harness, DEV_KEY } from "../helpers/harness.js";
import { brief } from "../helpers/fixtures.js";
import type { Identity, SavedPreset } from "../../src/types.js";

const REFUSAL = "hosted seats are not available yet";
const max: Identity = { userId: "u_max", orgId: null, plan: "max", role: "member", label: "max" };

// The three ways to declare a host. Each resolves to a manifest with a `host` before the switch is read.
const inline = {
  room: "mornings", mode: "swarm", heartbeat_on: "2h",
  roles: { lead: { can: ["send", "invite"] }, guest: { can: ["send"] }, emcee: { can: ["send"] } },
  default_role: "guest", creator_role: "lead",
  host: { role: "emcee", model: "haiku" },
};
const social = { room: "the square", preset: "social" };
const citesSaved = { room: "mornings", preset: "mornings" };
const saved: SavedPreset = {
  name: "mornings",
  description: null,
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
  updated_at: "2026-10-09T12:00:00.000Z",
};
const declaring: [string, Record<string, unknown>][] = [
  ["an inline host block", inline],
  ["the social preset", social],
  ["a saved preset that carries a host", citesSaved],
];

describe("bellman_start with the hosted seat switched off", () => {
  let h: Harness;
  beforeEach(async () => {
    h = new Harness(undefined, undefined, { hostedSeat: false });
    await h.store.putPreset(max.userId, saved, 20);
  });
  afterEach(async () => { await h.close(); });

  it.each(declaring)("refuses %s, and creates nothing", async (_how, manifest) => {
    const out = await (await h.connectAs(max)).call("bellman_start", { manifest, brief: brief() });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(REFUSAL);
    expect(await h.store.sessionsCreatedBy(max.userId, 10)).toEqual([]);
    expect(await h.store.countCreatesThisMonth(max.userId)).toBe(0);
    // No hosted-room slot is held either.
    expect(await h.store.reserveHostedRoom(max.userId, "qs_probe", 1)).toEqual({ ok: true });
  });

  // Free has no hosted seat on any plan's terms, so without the order the plan's refusal would answer first.
  it("refuses before the plan's own host refusal: on free, a cite of social meets the switch", async () => {
    const out = await (await h.connect(DEV_KEY.outsider)).call("bellman_start", { manifest: social, brief: brief() });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(REFUSAL);
    expect(out.text).not.toContain("requires the max or team plan");
  });

  it("starts a room that declares no host, as ever", async () => {
    const out = await (await h.connectAs(max)).call("bellman_start", { manifest: { room: "r", preset: "swarm" }, brief: brief() });
    expect(out.isError, out.text).toBe(false);
    expect((out.data.room as Record<string, unknown>).host).toBeNull();
  });
});

// The control for the refusals above: with the switch on, the same three manifests start hosted
// rooms, so each was refused for the switch and not for a manifest the server cannot read.
describe("the same manifests with the hosted seat switched on", () => {
  let h: Harness;
  beforeEach(async () => {
    h = new Harness(undefined, undefined, { hostedSeat: true });
    await h.store.putPreset(max.userId, saved, 20);
  });
  afterEach(async () => { await h.close(); });

  it.each(declaring)("starts a hosted room from %s", async (_how, manifest) => {
    const out = await (await h.connectAs(max)).call("bellman_start", { manifest, brief: brief() });
    expect(out.isError, out.text).toBe(false);
    expect((out.data.room as Record<string, unknown>).host).not.toBeNull();
  });
});
