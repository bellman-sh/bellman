/**
 * `bellman_surface`: the room's working surface, read-only, for the canvas
 * (canvas spec D1, D2). The block is `readSurface`'s, the seat rule is the HTTP
 * route's, and nothing here is a liveness signal.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Harness, DEV_KEY, type Peer } from "../helpers/harness.js";
import { brief, pairVerbs } from "../helpers/fixtures.js";
import { pairUp, seatAgain, startRoom, type PairedSession } from "../helpers/flows.js";
import { UNTRUSTED_PREAMBLE, roomPreview } from "../../src/projections.js";
import { APP_RESOURCE_URI } from "../../src/ui/resource.js";
import { NEXT_ALONE, NEXT_REFUSAL, QUERY_WITH_WINDOW, WINDOW_REFUSAL_TOOL } from "../../src/frames.js";

let h: Harness;
beforeEach(() => { h = new Harness(); });
afterEach(async () => { await h.close(); });

const write = (p: PairedSession, payload: Record<string, unknown>) =>
  p.creator.call("bellman_send", { session_id: p.sessionId, member_id: p.creatorMemberId, type: "surface", payload });

const read = (peer: Peer, sessionId: string) => peer.call("bellman_surface", { session_id: sessionId });

interface Block { cursor: number; items: { data: { key: string } }[] }

describe("bellman_surface", () => {
  it("returns the block bellman_sync surface: true returns, to the creator and to a joined member", async () => {
    const p = await pairUp(h);
    expect((await write(p, { key: "plan", kind: "text", title: "Plan", body: "Port v2 to v3", placement: { x: 10, y: 20 } })).isError).toBe(false);
    expect((await write(p, { key: "spec", kind: "link", body: "https://example.com/spec" })).isError).toBe(false);
    const synced = await p.creator.call("bellman_sync", { session_id: p.sessionId, member_id: p.creatorMemberId, since_cursor: 0, surface: true });
    const mine = await read(p.creator, p.sessionId);
    expect(mine.isError, mine.text).toBe(false);
    expect(mine.data.session_id).toBe(p.sessionId);
    expect(mine.data.surface).toEqual(synced.data.surface);
    expect((mine.data.room as { your_role: string }).your_role).toBe("peer_a");
    const theirs = await read(p.joiner, p.sessionId);
    expect(theirs.data.surface).toEqual(synced.data.surface);
    expect((theirs.data.room as { your_role: string }).your_role).toBe("peer_b");
    expect((theirs.data.surface as Block).items.map((e) => e.data.key).sort()).toEqual(["plan", "spec"]);

    // One seat: the block speaks for it as it always has, and your_seats holds just that seat.
    expect((mine.data.room as { your_verbs: string[] }).your_verbs).toEqual(pairVerbs("peer_a"));
    expect(mine.data.your_seats).toEqual([{ member_id: p.creatorMemberId, role: "peer_a", verbs: pairVerbs("peer_a") }]);
    expect((theirs.data.room as { your_verbs: string[] }).your_verbs).toEqual(pairVerbs("peer_b"));
    expect(theirs.data.your_seats).toEqual([{ member_id: p.joinerMemberId, role: "peer_b", verbs: pairVerbs("peer_b") }]);
  });

  // One person, two machines, one room. A tool is called by the account, and nothing in the call says which seat is
  // asking, so the answer lists every seat the account holds and names none as the asker. It used to name the first
  // live one: a Claude Code session as peer_b beside a claude.ai session as peer_a was shown the canvas as peer_a.
  it("lists every seat one account holds in the room, oldest first", async () => {
    const creator = await h.connect(DEV_KEY.jesse);
    const { sessionId, memberId } = await startRoom(creator);
    await seatAgain(h, creator, sessionId, "peer_b");

    const out = await read(creator, sessionId);
    expect(out.isError, out.text).toBe(false);
    expect(out.data.your_seats).toEqual([
      { member_id: memberId, role: "peer_a", verbs: pairVerbs("peer_a") },
      { member_id: "m_second", role: "peer_b", verbs: pairVerbs("peer_b") },
    ]);
  });

  it("gives the room block no seat when the account holds several: the block it gives a reader with none", async () => {
    const creator = await h.connect(DEV_KEY.jesse);
    const { sessionId } = await startRoom(creator);
    await seatAgain(h, creator, sessionId, "peer_b");

    const room = (await read(creator, sessionId)).data.room;
    expect(room).toMatchObject({ your_role: null, your_verbs: [], your_heartbeat_on: false });
    const stored = (await h.store.getSession(sessionId))!;
    expect(room).toEqual(JSON.parse(JSON.stringify(roomPreview(stored, null))));
  });

  it("does not count a seat that left", async () => {
    const creator = await h.connect(DEV_KEY.jesse);
    const { sessionId, memberId } = await startRoom(creator);
    await seatAgain(h, creator, sessionId, "peer_b");
    const gone = await creator.call("bellman_leave", { session_id: sessionId, member_id: "m_second" });
    expect(gone.isError, gone.text).toBe(false);

    const out = await read(creator, sessionId);
    expect(out.data.your_seats).toEqual([{ member_id: memberId, role: "peer_a", verbs: pairVerbs("peer_a") }]);
    expect((out.data.room as { your_role: string }).your_role).toBe("peer_a");
  });

  it("refuses a stranger and an unknown room with the same words", async () => {
    const p = await pairUp(h);
    const outsider = await h.connect(DEV_KEY.outsider);
    const stranger = await read(outsider, p.sessionId);
    expect(stranger.isError).toBe(true);
    expect(stranger.text).toContain("no such room, or no member of yours in it");
    const nowhere = await read(p.creator, "qs_nowhere");
    expect(nowhere.isError).toBe(true);
    expect(nowhere.text).toContain("no such room, or no member of yours in it");
  });

  it("shows a removed member the surface as it stood at its cut", async () => {
    const p = await pairUp(h);
    expect((await write(p, { key: "before", kind: "text", body: "seen" })).isError).toBe(false);
    const out = await p.creator.call("bellman_evict", { session_id: p.sessionId, member_id: p.joinerMemberId });
    expect(out.isError, out.text).toBe(false);
    expect((await write(p, { key: "after", kind: "text", body: "unseen" })).isError).toBe(false);
    const theirs = (await read(p.joiner, p.sessionId)).data.surface as Block;
    expect(theirs.items.map((e) => e.data.key)).toEqual(["before"]);
    const mine = (await read(p.creator, p.sessionId)).data.surface as Block;
    expect(mine.items.map((e) => e.data.key).sort()).toEqual(["after", "before"]);
    expect(theirs.cursor).toBeLessThan(mine.cursor);

    // Removed, the joiner holds no seat now: the block still reads as of its cut, from the handle it held.
    const removed = (await read(p.joiner, p.sessionId)).data;
    expect(removed.your_seats).toEqual([]);
    expect((removed.room as { your_role: string }).your_role).toBe("peer_b");
  });

  it("still reads a frozen room and a closed one", async () => {
    const p = await pairUp(h);
    expect((await write(p, { key: "note", kind: "text", body: "kept" })).isError).toBe(false);
    await h.store.freezeSession(p.sessionId, Date.now());
    expect((await read(p.creator, p.sessionId)).isError).toBe(false);
    await h.store.closeSession(p.sessionId);
    const closed = await read(p.creator, p.sessionId);
    expect(closed.isError, closed.text).toBe(false);
    expect((closed.data.surface as Block).items).toHaveLength(1);
  });

  it("does not move the caller's lastSeenAt: a polling page holds no seat alive", async () => {
    const p = await pairUp(h);
    const old = Date.now() - 60 * 60_000;
    await h.store.updateMember(p.sessionId, p.creatorMemberId, { lastSeenAt: old });
    await read(p.creator, p.sessionId);
    const me = (await h.store.getSession(p.sessionId))!.members.find((m) => m.memberId === p.creatorMemberId)!;
    expect(me.lastSeenAt).toBe(old);
  });

  it("is a read that renders as the canvas, and warns about peer text", async () => {
    const p = await pairUp(h);
    const { tools } = await p.creator.listTools();
    const tool = tools.find((t) => t.name === "bellman_surface")!;
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect((tool._meta as { ui: { resourceUri: string } }).ui.resourceUri).toBe(APP_RESOURCE_URI);
    expect(tool.description).toMatch(/not a liveness signal/i);
    expect(tool.description).not.toMatch(/verbs/i);
    expect((await read(p.creator, p.sessionId)).text.startsWith(UNTRUSTED_PREAMBLE)).toBe(true);
  });

  it("tells a caller in its description where its seats are, and what several mean", async () => {
    const { tools } = await (await h.connect(DEV_KEY.jesse)).listTools();
    const doc = tools.find((t) => t.name === "bellman_surface")!.description!.replace(/\s+/g, " ");

    expect(doc).toContain("your_seats[]");
    expect(doc).toContain("null when you hold several");
  });
});

/** `n` text cards appended through the store with placements far from any frame (R23): only the read is under test. */
const seed = async (p: PairedSession, n: number) => {
  for (let i = 0; i < n; i++) {
    const item = {
      key: `s${String(i).padStart(3, "0")}`, kind: "text" as const, title: null, body: "x", ends: null,
      placement: { x: 100_000 + (i % 10) * 400, y: 100_000 + Math.floor(i / 10) * 300 }, blob: null, shape: null,
    };
    await h.store.appendEvent(p.sessionId, {
      type: "surface", fromMemberId: p.creatorMemberId, fromUserId: p.creator.identity.userId, fromLabel: p.creator.identity.label,
      payload: item, refId: null,
    }, { surface: { key: item.key, item } });
  }
};

describe("bellman_surface reads a window (surface frames spec, D5)", () => {
  const read = (p: PairedSession, args: Record<string, unknown> = {}) => p.joiner.call("bellman_surface", { session_id: p.sessionId, ...args });
  const surfaceOf = (out: { data: Record<string, unknown> }) => out.data.surface as {
    items: { data: { key: string } }[];
    frames: { trust: string; origin: { memberId: string; label: string }; data: { number: number; key: string; title: string; count: number } }[];
    window: string;
    next: string | null;
  };

  // Review Focus 5.
  it("answers a small room with no frames whole, as today, with frames [], window newest and next null", async () => {
    const p = await pairUp(h);
    await write(p, { key: "a", kind: "text", body: "x" });
    await write(p, { key: "b", kind: "text", body: "y" });
    await write(p, { key: "line", kind: "connector", ends: { from: "a", to: "b" } });
    const s = surfaceOf(await read(p));
    expect(s.items.map((i) => i.data.key).sort()).toEqual(["a", "b", "line"]);
    expect([s.frames, s.window, s.next]).toEqual([[], "newest", null]);
  });

  it("answers frame 1 with no window once the room has a frame, and every frame with its count", async () => {
    const p = await pairUp(h);
    await write(p, { key: "intro", kind: "frame", title: "Start here", placement: { x: 0, y: 0, w: 1480, h: 520 } });
    await write(p, { key: "a", kind: "text", body: "x", frame: 1 });
    await write(p, { key: "loose", kind: "text", body: "y" });
    const s = surfaceOf(await read(p));
    expect([s.window, s.items.map((i) => i.data.key)]).toEqual(["frame:1", ["a"]]);
    expect(s.frames).toEqual([{
      trust: "untrusted", origin: { memberId: p.creatorMemberId, label: expect.any(String) },
      data: { number: 1, key: "intro", title: "Start here", placement: { x: 0, y: 0, w: 1480, h: 520 }, locked: true, count: 1 },
    }]);
    expect(surfaceOf(await read(p, { window: "unframed" })).items.map((i) => i.data.key)).toEqual(["loose"]);
  });

  it("pages newest at 64 and reads the rest with next alone", async () => {
    const p = await pairUp(h);
    await seed(p, 70);
    const first = surfaceOf(await read(p, { window: "newest" }));
    const second = surfaceOf(await read(p, { next: first.next }));
    expect([first.items.length, second.items.length, second.next]).toEqual([64, 6, null]);
    expect(new Set([...first.items, ...second.items].map((i) => i.data.key)).size).toBe(70);
  });

  it("refuses region, a bad window, next beside a window, a token it did not write, query beside a window, and a frame that does not exist", async () => {
    const p = await pairUp(h);
    const refused = async (args: Record<string, unknown>, text: string) => {
      const out = await read(p, args);
      expect([out.isError, out.text]).toEqual([true, `Error: ${text}`]);
    };
    await refused({ window: "region:0,0,10,10" }, WINDOW_REFUSAL_TOOL);
    await refused({ window: "frame:0" }, WINDOW_REFUSAL_TOOL);
    await refused({ window: "newest", next: "abc" }, NEXT_ALONE);
    await refused({ next: "abc" }, NEXT_REFUSAL);
    await refused({ query: "retry", window: "newest" }, QUERY_WITH_WINDOW);
    await refused({ window: "frame:1" }, "frame 1 does not exist: this room has no frames");
  });

  // R17: the cut.
  it("ranks the frames a removed member may see, so an edit after its cut moves the next frame up for it", async () => {
    const p = await pairUp(h);
    await write(p, { key: "a", kind: "frame", title: "A", placement: { x: 0, y: 0, w: 1000, h: 1000 } });
    await write(p, { key: "b", kind: "frame", title: "B", placement: { x: 2000, y: 0, w: 1000, h: 1000 } });
    expect((await p.creator.call("bellman_evict", { session_id: p.sessionId, member_id: p.joinerMemberId })).isError).toBe(false);
    await write(p, { key: "a", kind: "frame", title: "A, renamed", placement: { x: 0, y: 0, w: 1000, h: 1000 } });
    const s = surfaceOf(await read(p));
    expect([s.window, s.frames.map((f) => [f.data.number, f.data.key])]).toEqual(["frame:1", [[1, "b"]]]);
  });

  it("gives bellman_sync surface: true the front window, frames and all", async () => {
    const p = await pairUp(h);
    await write(p, { key: "intro", kind: "frame", title: "Start here", placement: { x: 0, y: 0, w: 1480, h: 520 } });
    const out = await p.joiner.call("bellman_sync", { session_id: p.sessionId, member_id: p.joinerMemberId, since_cursor: 0, surface: true });
    expect(out.isError, out.text).toBe(false);
    const s = surfaceOf(out);
    expect([s.window, s.frames.length]).toEqual(["frame:1", 1]);
  });

  it("gives bellman_confirm's surface its frames, window and next", async () => {
    const creator = await h.connect(DEV_KEY.jesse);
    const { started, sessionId, memberId } = await startRoom(creator);
    await creator.call("bellman_send", {
      session_id: sessionId, member_id: memberId, type: "surface",
      payload: { key: "intro", kind: "frame", title: "Start here", placement: { x: 0, y: 0, w: 1480, h: 520 } },
    });
    const joiner = await h.connect(DEV_KEY.peer);
    const preview = await joiner.call("bellman_connect", { join_code: String(started.data.join_code) });
    const confirmed = await joiner.call("bellman_confirm", { connect_token: String(preview.data.connect_token), brief: brief() });
    expect(confirmed.isError, confirmed.text).toBe(false);
    const s = surfaceOf(confirmed);
    expect([s.window, s.frames.map((f) => f.data.key), s.next]).toEqual(["frame:1", ["intro"], null]);
  });

  it("refuses a card written into a frame under that frame's own key, and the frame stays", async () => {
    const p = await pairUp(h);
    await write(p, { key: "f1", kind: "frame", title: "Start here", placement: { x: 0, y: 0, w: 1480, h: 520 } });
    const out = await write(p, { key: "f1", kind: "text", body: "x", frame: 1 });
    expect([out.isError, out.text]).toEqual([
      true, 'Error: surface text "f1": a frame cannot be written into a frame: write it with its own placement',
    ]);
    expect(surfaceOf(await read(p)).frames.map((f) => [f.data.key, f.data.title])).toEqual([["f1", "Start here"]]);
  });
});
