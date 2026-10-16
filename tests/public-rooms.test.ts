/**
 * Public rooms (public rooms spec): readable by anyone with the room's link, chosen
 * when the room starts. Tasks 1, 2 and 4 of the plan add to this file; the routes
 * are tests/http-public.test.ts.
 */
import { describe, expect, it } from "vitest";
import { builtinPresets, resolveManifest } from "../src/manifest.js";
import { asManifest, checkPreset } from "../src/presets.js";
import { roomPreview } from "../src/projections.js";
import { isPublic } from "../src/rooms.js";
import { hydrateStoredSession } from "../src/stored-session.js";
import type { SavedPreset, Session } from "../src/types.js";
import { brief, roomManifest, session } from "./helpers/fixtures.js";
import { DEV_KEY, Harness } from "./helpers/harness.js";

const roles = { a: { can: ["send"] }, b: { can: ["send"] } };
const authored = { room: "r", mode: "pair", roles, default_role: "b", creator_role: "a" };

describe("a manifest's public flag", () => {
  it("is taken on both arms", () => {
    expect(resolveManifest({ room: "r", preset: "pair", public: true }).public).toBe(true);
    expect(resolveManifest({ ...authored, public: true }).public).toBe(true);
  });

  it("is false unless given, and the built-ins are private", () => {
    expect(resolveManifest({ room: "r", preset: "pair" }).public).toBe(false);
    expect(resolveManifest(authored).public).toBe(false);
    expect(builtinPresets().map((p) => p.public)).toEqual([false, false, false, false]);
  });

  it("is refused when it is not a boolean", () => {
    // As a boolean the shape refuses, not as a key it does not know: that refusal would pass here too.
    expect(() => resolveManifest({ ...authored, public: "yes" })).toThrow(/public: .*expected boolean/);
  });

  it("reads false on a room stored before it", () => {
    const old = structuredClone(session()) as unknown as { manifest: Record<string, unknown> };
    delete old.manifest.public;
    expect(hydrateStoredSession(old)!.manifest.public).toBe(false);
  });
});

describe("a saved preset's public flag", () => {
  const saved = (pub?: boolean): SavedPreset => ({
    name: "open_review", description: null, mode: "pair", heartbeat: null,
    roles: { a: { can: ["send"], description: null, heartbeat_on: false }, b: { can: ["send"], description: null, heartbeat_on: false } },
    default_role: "b", creator_role: "a", updated_at: null,
    ...(pub === undefined ? {} : { public: pub }),
  });
  const body = { mode: "pair", roles, default_role: "b", creator_role: "a" };

  it("is saved, and false when the body leaves it out", () => {
    const open = checkPreset("open_review", { ...body, public: true }, 0);
    const shut = checkPreset("open_review", body, 0);
    expect([open.ok && open.preset.public, shut.ok && shut.preset.public]).toEqual([true, false]);
  });

  it("is the default for a room started from it, and the cite's own wins", () => {
    expect(resolveManifest(asManifest(saved(true), "r", null)).public).toBe(true);
    expect(resolveManifest(asManifest(saved(true), "r", null, undefined, undefined, false)).public).toBe(false);
    expect(resolveManifest(asManifest(saved(false), "r", null, undefined, undefined, true)).public).toBe(true);
    expect(resolveManifest(asManifest(saved(), "r", null)).public).toBe(false);
  });
});

describe("whether a room is publicly readable", () => {
  it("is public when marked so at the start and not made private since", () => {
    expect(isPublic(session({ manifest: roomManifest({ public: true }) }))).toBe(true);
    expect(isPublic(session({ manifest: roomManifest({ public: true }), unpublishedAt: 1 }))).toBe(false);
    expect(isPublic(session())).toBe(false);
  });

  it("reads a room stored before unpublishing existed as never made private", () => {
    const old = structuredClone(session({ manifest: roomManifest({ public: true }) })) as unknown as Record<string, unknown>;
    delete old.unpublishedAt;
    const hydrated = hydrateStoredSession(old)!;
    expect(hydrated.unpublishedAt).toBeNull();
    expect(isPublic(hydrated)).toBe(true);
  });
});

describe("the preview", () => {
  it("says whether the room is public, in its trusted part, as the room stands", () => {
    const view = (over: Partial<Session>) => roomPreview(session(over), "peer_b");
    expect(view({ manifest: roomManifest({ public: true }) }).public).toBe(true);
    expect(view({ manifest: roomManifest({ public: true }), unpublishedAt: 1 }).public).toBe(false);
    expect(view({}).public).toBe(false);
    expect(view({ manifest: roomManifest({ public: true }) }).text.data).not.toHaveProperty("public");
  });
});

// Plan B's final review, Important: asked for "the link", an agent holding only join_url shares a seat.
describe("the creator's public link", () => {
  it("comes back for a public room as a page to read, apart from the code to join, and not for a private one", async () => {
    const h = new Harness();
    try {
      const jesse = await h.connect(DEV_KEY.jesse);
      const open = await jesse.call("bellman_start", { manifest: { room: "Open", preset: "pair", public: true }, brief: brief() });
      expect(open.isError, open.text).toBe(false);
      expect(open.data.public_url).toBe(`https://dash.bellman.sh/r/${String(open.data.session_id)}`);
      expect(open.data.public_url).not.toBe(open.data.join_url);
      const shut = await jesse.call("bellman_start", { manifest: { room: "Shut", preset: "pair" }, brief: brief() });
      expect("public_url" in shut.data).toBe(false);
    } finally {
      await h.close();
    }
  });
});

// Public rooms are a paid plan's (public rooms spec, D10). One check on the resolved manifest covers
// every way of asking for one, and a refusal creates nothing and counts nothing.
describe("a public room's plan", () => {
  const refusal = 'a public room requires the pro, max or team plan (you are on "free"). Start it with public: false, or upgrade.';
  const preset: SavedPreset = {
    name: "open_review", description: null, mode: "pair", heartbeat: null, public: true,
    roles: { a: { can: ["send"], description: null, heartbeat_on: false }, b: { can: ["send"], description: null, heartbeat_on: false } },
    default_role: "b", creator_role: "a", updated_at: null,
  };

  it("refuses a free account by every way of asking, before anything is created or counted", async () => {
    const h = new Harness();
    try {
      const peer = await h.connect(DEV_KEY.peer);
      await h.store.putPreset(peer.identity.userId, preset, 20);
      for (const manifest of [
        { room: "Open", preset: "pair", public: true },
        { ...authored, public: true },
        { room: "Open", preset: "open_review" },
      ]) {
        const res = await peer.call("bellman_start", { manifest, brief: brief() });
        expect(res.isError, JSON.stringify(manifest)).toBe(true);
        expect(res.text).toContain(refusal);
      }
      expect(await h.store.countCreatesThisMonth(peer.identity.userId)).toBe(0);
      const shut = await peer.call("bellman_start", { manifest: { room: "Shut", preset: "open_review", public: false }, brief: brief() });
      expect(shut.isError, shut.text).toBe(false);
      expect((shut.data.room as { public: boolean }).public).toBe(false);
    } finally {
      await h.close();
    }
  });

  it("starts one on pro", async () => {
    const h = new Harness();
    try {
      const pro = await h.connectAs({ userId: "u_pro", orgId: null, plan: "pro", role: "member", label: "pro" });
      const open = await pro.call("bellman_start", { manifest: { room: "Open", preset: "pair", public: true }, brief: brief() });
      expect(open.isError, open.text).toBe(false);
      expect(open.data.public_url).toBe(`https://dash.bellman.sh/r/${String(open.data.session_id)}`);
    } finally {
      await h.close();
    }
  });
});
