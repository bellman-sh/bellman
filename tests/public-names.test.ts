/**
 * Public names (public names spec): the rule a name keeps, whether a room holds one, claiming
 * one through the index, bellman_start's public_name and the tool that checks and sets one.
 * The route is tests/http-public.test.ts; the store methods are the store contract's.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PUBLIC_NAME, claimName, heldName, holdsName, publicNameRefusal, roomNamed } from "../src/public-names.js";
import { MemoryStore } from "../src/store.js";
import { roomPreview } from "../src/projections.js";
import { DEV_KEY, Harness, type Peer } from "./helpers/harness.js";
import { pairUp } from "./helpers/flows.js";
import { hydrateStoredSession } from "../src/stored-session.js";
import { brief, roomManifest, session } from "./helpers/fixtures.js";

describe("the name rule (D2)", () => {
  it("takes 3 to 40 lowercase letters, digits and single hyphens, a letter or digit at each end", () => {
    for (const good of ["bellman-dev", "abc", "a1b", "a-b", "room-2026-10", "x".repeat(40)]) {
      expect(PUBLIC_NAME.test(good), good).toBe(true);
    }
    // Review Focus 4: nothing here is lowercased or rewritten into a name that would pass.
    for (const bad of ["ab", "x".repeat(41), "Bellman-Dev", "bellman_dev", "-dev", "dev-", "bel--dev", "bellman dev", "dév", "qs_3f0c", ""]) {
      expect(PUBLIC_NAME.test(bad), bad).toBe(false);
    }
  });

  it("refuses a name outside it in the rule's words", () => {
    expect(publicNameRefusal("Bellman-Dev")).toBe(
      'public name "Bellman-Dev": use 3 to 40 lowercase letters, digits and single hyphens, starting and ending with a letter or digit',
    );
    expect(publicNameRefusal("bellman-dev")).toBeNull();
  });
});

describe("holding a name (D5)", () => {
  const room = (over: Parameters<typeof session>[0] = {}) =>
    session({ manifest: roomManifest({ public: true }), publicName: "bellman-dev", ...over });

  it("is the room whose record names it, while public and open", () => {
    expect(holdsName(room(), "bellman-dev")).toBe(true);
    expect(heldName(room())).toBe("bellman-dev");
  });

  it("ends with a rename, a close or being made private, and a room that is not there holds nothing", () => {
    expect(holdsName(room({ publicName: "other-name" }), "bellman-dev")).toBe(false);
    expect(holdsName(room({ closed: true, closedAt: 1 }), "bellman-dev")).toBe(false);
    expect(holdsName(room({ unpublishedAt: 1 }), "bellman-dev")).toBe(false);
    expect(holdsName(room({ manifest: roomManifest({ public: false }) }), "bellman-dev")).toBe(false);
    expect(holdsName(undefined, "bellman-dev")).toBe(false);
    expect(heldName(room({ closed: true, closedAt: 1 }))).toBeNull();
    expect(heldName(room({ publicName: null }))).toBeNull();
  });

  it("reads null on a room stored before names", () => {
    const old = structuredClone(session()) as unknown as { publicName?: string | null };
    delete old.publicName;
    expect(hydrateStoredSession(old)!.publicName).toBeNull();
  });
});

describe("claiming a name through the index (D5)", () => {
  const named = (id: string, name: string) => session({ id, manifest: roomManifest({ public: true }), publicName: name });

  it("finds the room that holds a name, and nothing once it holds another", async () => {
    const store = new MemoryStore();
    await store.createSession(named("qs_a", "bellman-dev"));
    await store.claimPublicName("bellman-dev", "qs_a", null);
    expect((await roomNamed(store, "bellman-dev"))?.id).toBe("qs_a");
    await store.setPublicName("qs_a", "renamed");
    expect(await roomNamed(store, "bellman-dev")).toBeUndefined();
  });

  it("takes a free name, refuses a held one, and takes over one its room no longer holds", async () => {
    const store = new MemoryStore();
    await store.createSession(named("qs_a", "bellman-dev"));
    expect(await claimName(store, "bellman-dev", "qs_a")).toBe(true);
    expect(await claimName(store, "bellman-dev", "qs_b")).toBe(false);
    await store.unpublishSession("qs_a", Date.now());
    expect(await claimName(store, "bellman-dev", "qs_b")).toBe(true);
    expect(await store.publicNameEntry("bellman-dev")).toBe("qs_b");
  });

  it("answers yes to the room the entry already points at, and frees a name whose room was never created", async () => {
    const store = new MemoryStore();
    await store.createSession(named("qs_a", "bellman-dev"));
    await store.claimPublicName("bellman-dev", "qs_a", null);
    expect(await claimName(store, "bellman-dev", "qs_a")).toBe(true);
    await store.claimPublicName("orphan", "qs_never", null);
    expect(await roomNamed(store, "orphan")).toBeUndefined();
    expect(await claimName(store, "orphan", "qs_b")).toBe(true);
  });
});

describe("bellman_start's public_name (D4)", () => {
  let h: Harness;
  beforeEach(() => { h = new Harness(); });
  afterEach(async () => { await h.close(); });
  const OPEN = { room: "Dev", preset: "pair", public: true };

  it("gives a public room the name, its link and its preview's public_name", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const out = await jesse.call("bellman_start", { manifest: OPEN, public_name: "bellman-dev", brief: brief() });
    expect(out.isError, out.text).toBe(false);
    expect(out.data.public_url).toBe("https://dash.bellman.sh/r/bellman-dev");
    expect((out.data.room as { public_name: string | null }).public_name).toBe("bellman-dev");
    expect((await roomNamed(h.store, "bellman-dev"))?.id).toBe(out.data.session_id);
  });

  it("keeps the session id's link for a public room with no name", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const out = await jesse.call("bellman_start", { manifest: OPEN, brief: brief() });
    expect(out.data.public_url).toBe(`https://dash.bellman.sh/r/${String(out.data.session_id)}`);
    expect((out.data.room as { public_name: string | null }).public_name).toBeNull();
  });

  it("refuses a taken name before anything is created or counted", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    await jesse.call("bellman_start", { manifest: OPEN, public_name: "bellman-dev", brief: brief() });
    const used = await h.store.countCreatesThisMonth("u_jesse");
    const again = await jesse.call("bellman_start", { manifest: { ...OPEN, room: "Dev 2" }, public_name: "bellman-dev", brief: brief() });
    expect(again.isError).toBe(true);
    expect(again.text).toContain('public name "bellman-dev" is taken: choose another, or start without one and set it later with bellman_public_name.');
    expect(await h.store.countCreatesThisMonth("u_jesse")).toBe(used);
    expect(await h.store.sessionsCreatedBy("u_jesse", 10)).toHaveLength(1);
  });

  it("refuses a name for a private room, and one outside the rule, creating nothing", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const shut = await jesse.call("bellman_start", { manifest: { room: "Dev", preset: "pair" }, public_name: "bellman-dev", brief: brief() });
    expect(shut.text).toContain("public_name needs a public room: add public: true, or leave public_name out.");
    const bad = await jesse.call("bellman_start", { manifest: OPEN, public_name: "Bellman_Dev", brief: brief() });
    expect(bad.text).toContain('public name "Bellman_Dev": use 3 to 40 lowercase letters');
    expect(await h.store.sessionsCreatedBy("u_jesse", 10)).toHaveLength(0);
  });

  // Review Focus 1: the claim comes before the hosted slot, so refusing it holds no slot.
  it("refuses a taken name for a hosted room without keeping one of its creator's hosted slots", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    await jesse.call("bellman_start", { manifest: OPEN, public_name: "social-hour", brief: brief() });
    const hosted = await jesse.call("bellman_start", { manifest: { room: "Social", preset: "social", public: true }, public_name: "social-hour", brief: brief() });
    expect(hosted.text).toContain('public name "social-hour" is taken');
    expect((await h.store.reserveHostedRoom("u_jesse", "qs_probe", 1)).ok).toBe(true);
  });

  it("shows no public_name in the preview of a room that no longer holds its name", () => {
    const closed = session({ manifest: roomManifest({ public: true }), publicName: "bellman-dev", closed: true, closedAt: 1 });
    expect(roomPreview(closed, null).public_name).toBeNull();
  });
});

describe("bellman_public_name (D3)", () => {
  let h: Harness;
  beforeEach(() => { h = new Harness(); });
  afterEach(async () => { await h.close(); });
  const OPEN = { room: "Dev", preset: "pair", public: true };
  const start = async (peer: Peer, over: Record<string, unknown> = {}) => {
    const out = await peer.call("bellman_start", { manifest: OPEN, brief: brief(), ...over });
    expect(out.isError, out.text).toBe(false);
    return { room: String(out.data.session_id), member: String(out.data.member_id) };
  };

  it("checks a name without a room, and says a held one is not free", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    expect((await jesse.call("bellman_public_name", { name: "bellman-dev" })).data).toEqual({ name: "bellman-dev", free: true });
    await start(jesse, { public_name: "bellman-dev" });
    expect((await jesse.call("bellman_public_name", { name: "bellman-dev" })).data).toEqual({ name: "bellman-dev", free: false });
  });

  it("refuses a name outside the rule", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const out = await jesse.call("bellman_public_name", { name: "Bellman-Dev" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('public name "Bellman-Dev": use 3 to 40 lowercase letters');
  });

  it("sets a name for the room's creator, frees the one it held at once, and takes it back by room_id", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const { room } = await start(jesse, { public_name: "first-name" });
    const set = await jesse.call("bellman_public_name", { name: "second-name", session_id: room });
    expect(set.data).toEqual({ name: "second-name", public_url: "https://dash.bellman.sh/r/second-name" });
    expect((await jesse.call("bellman_public_name", { name: "first-name" })).data.free).toBe(true);
    // Review Focus 2: back to the first name, whose entry still points at the room.
    expect((await jesse.call("bellman_public_name", { name: "first-name", room_id: room })).isError).toBe(false);
    expect((await roomNamed(h.store, "first-name"))?.id).toBe(room);
    expect((await jesse.call("bellman_public_name", { name: "second-name" })).data.free).toBe(true);
  });

  it("returns the name a room already holds unchanged, and refuses one another room holds", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const { room } = await start(jesse, { public_name: "bellman-dev" });
    expect((await jesse.call("bellman_public_name", { name: "bellman-dev", session_id: room })).data)
      .toEqual({ name: "bellman-dev", public_url: "https://dash.bellman.sh/r/bellman-dev" });
    const other = await start(jesse);
    expect((await jesse.call("bellman_public_name", { name: "bellman-dev", session_id: other.room })).text)
      .toContain('public name "bellman-dev" is taken: choose another');
  });

  it("names a room only for its creator, and only a public one", async () => {
    const p = await pairUp(h, { manifest: OPEN });
    expect((await p.joiner.call("bellman_public_name", { name: "bellman-dev", session_id: p.sessionId })).text)
      .toContain("only the room's creator may name it");
    const outsider = await h.connect(DEV_KEY.outsider);
    expect((await outsider.call("bellman_public_name", { name: "bellman-dev", session_id: p.sessionId })).text)
      .toContain("no such room, or no member of yours in it");
    const shut = await start(p.creator, { manifest: { room: "Shut", preset: "pair" } });
    expect((await p.creator.call("bellman_public_name", { name: "bellman-dev", session_id: shut.room })).text)
      .toContain("only a public room has a public name");
  });

  // Review Focus 3: closed, the name is free at once, and the room cannot be named again.
  it("frees a room's name once it closes or is made private, and refuses to name a closed room", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const closing = await start(jesse, { public_name: "closing-room" });
    await jesse.call("bellman_leave", { session_id: closing.room, member_id: closing.member });
    expect((await jesse.call("bellman_public_name", { name: "closing-room" })).data.free).toBe(true);
    expect((await jesse.call("bellman_public_name", { name: "closing-room", session_id: closing.room })).text)
      .toContain("the room is closed");
    const unpublished = await start(jesse, { public_name: "private-soon" });
    await h.store.unpublishSession(unpublished.room, Date.now());
    expect((await jesse.call("bellman_public_name", { name: "private-soon" })).data.free).toBe(true);
  });
});
