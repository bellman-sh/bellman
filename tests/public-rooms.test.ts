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
import { roomManifest, session } from "./helpers/fixtures.js";

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
    name: "open_review", description: null, mode: "pair", heartbeat_on: null,
    roles: { a: { can: ["send"], description: null, reports: false }, b: { can: ["send"], description: null, reports: false } },
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
