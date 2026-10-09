/**
 * `bellman_surface`: the room's working surface, read-only, for the canvas
 * (canvas spec D1, D2). The block is `readSurface`'s, the seat rule is the HTTP
 * route's, and nothing here is a liveness signal.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Harness, DEV_KEY, type Peer } from "../helpers/harness.js";
import { pairUp, type PairedSession } from "../helpers/flows.js";
import { UNTRUSTED_PREAMBLE } from "../../src/projections.js";
import { APP_RESOURCE_URI } from "../../src/ui/resource.js";

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
});
