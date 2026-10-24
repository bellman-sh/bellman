/**
 * `bellman_surface` with `query`: one room's cards or messages, matched by
 * `src/search.ts`, answered as pointers in untrusted envelopes (room search
 * spec, section 1). A search writes nothing and keeps no seat alive.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Harness, DEV_KEY, type Peer } from "../helpers/harness.js";
import { manifestFixture } from "../helpers/fixtures.js";
import { pairUp, startRoom, type PairedSession } from "../helpers/flows.js";
import { UNTRUSTED_PREAMBLE } from "../../src/projections.js";
import { searchLog } from "../../src/rooms.js";
import { surfaceCursor } from "../../src/surface.js";
import { IN_NEEDS_QUERY } from "../../src/tools/surface.js";

let h: Harness;
beforeEach(() => { h = new Harness(); });
afterEach(async () => { await h.close(); });

const write = (p: PairedSession, payload: Record<string, unknown>) =>
  p.creator.call("bellman_send", { session_id: p.sessionId, member_id: p.creatorMemberId, type: "surface", payload });
const say = (peer: Peer, sessionId: string, memberId: string, text: string) =>
  peer.call("bellman_send", { session_id: sessionId, member_id: memberId, type: "message", payload: { text } });
const search = (peer: Peer, sessionId: string, args: Record<string, unknown>) =>
  peer.call("bellman_surface", { session_id: sessionId, ...args });

describe("bellman_surface with query (room search spec, section 1)", () => {
  it("searches the cards by default and answers { query, in, total, results } with no surface", async () => {
    const p = await pairUp(h);
    expect((await write(p, { key: "plan", kind: "text", title: "Retry plan", body: "intro\nwe retry twice" })).isError).toBe(false);
    expect((await write(p, { key: "other", kind: "text", body: "nothing" })).isError).toBe(false);
    const out = await search(p.joiner, p.sessionId, { query: "Retry" });
    expect(out.isError, out.text).toBe(false);
    expect(Object.keys(out.data).sort()).toEqual(["in", "query", "results", "total"]);
    expect(out.data).toMatchObject({ query: "Retry", in: "cards", total: 1 });
    expect(out.data.results).toEqual([{
      trust: "untrusted", origin: { memberId: p.creatorMemberId, label: expect.any(String) },
      data: { key: "plan", kind: "text", title: "Retry plan", snippet: "we retry twice", created_at: expect.any(String), approved_by: null, url: null, frame: null },
    }]);
    expect(out.text.startsWith(UNTRUSTED_PREAMBLE)).toBe(true);
  });

  // R18: a card names its frame, a card in none names null, and a frame found by its title names its own number.
  it("names each card's frame number", async () => {
    const p = await pairUp(h);
    expect((await write(p, { key: "intro", kind: "frame", title: "Retry path", placement: { x: 0, y: 0, w: 1480, h: 520 } })).isError).toBe(false);
    expect((await write(p, { key: "inside", kind: "text", body: "retry inside", frame: 1 })).isError).toBe(false);
    expect((await write(p, { key: "outside", kind: "text", body: "retry outside" })).isError).toBe(false);
    const out = await search(p.joiner, p.sessionId, { query: "retry" });
    expect(out.isError, out.text).toBe(false);
    const frames = Object.fromEntries((out.data.results as { data: { key: string; frame: number | null } }[]).map((r) => [r.data.key, r.data.frame]));
    expect(frames).toEqual({ intro: 1, inside: 1, outside: null });
  });

  it("gives a public room's card its page's URL", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const { sessionId, memberId } = await startRoom(jesse, manifestFixture({ public: true }));
    await jesse.call("bellman_send", { session_id: sessionId, member_id: memberId, type: "surface", payload: { key: "plan", kind: "text", body: "retry" } });
    const out = await search(jesse, sessionId, { query: "retry" });
    expect((out.data.results as { data: { url: string } }[])[0].data.url).toBe(`https://bellman.sh/r/${sessionId}/plan`);
  });

  it("searches the log with in: messages, newest first, and says how far it looked", async () => {
    const p = await pairUp(h);
    await say(p.creator, p.sessionId, p.creatorMemberId, "first retry");
    const second = await say(p.joiner, p.sessionId, p.joinerMemberId, "line one\nsecond retry");
    const out = await search(p.creator, p.sessionId, { query: "retry", in: "messages" });
    expect(out.isError, out.text).toBe(false);
    expect(Object.keys(out.data).sort()).toEqual(["in", "query", "results", "searched", "total"]);
    const results = out.data.results as { origin: { memberId: string }; data: { cursor: number; snippet: string; at: string } }[];
    expect(results.map((r) => r.data.snippet)).toEqual(["second retry", "first retry"]);
    expect(results[0]).toMatchObject({ origin: { memberId: p.joinerMemberId }, data: { cursor: (second.data as { cursor: number }).cursor } });
    expect(out.data.searched).toEqual({ events: (second.data as { cursor: number }).cursor, from_cursor: 1 });
  });

  it("reads the last 2,000 events and no further back", async () => {
    const p = await pairUp(h);
    await say(p.creator, p.sessionId, p.creatorMemberId, "the needle");
    const from = { type: "message" as const, fromMemberId: p.creatorMemberId, fromUserId: "u_jesse", fromLabel: "jesse", refId: null };
    for (let i = 0; i < 2_000; i++) await h.store.appendEvent(p.sessionId, { ...from, payload: { text: `hay ${i}` } });
    const last = (await h.store.recentEvents(p.sessionId, 1))[0].cursor;
    const out = await search(p.creator, p.sessionId, { query: "needle", in: "messages" });
    expect(out.data).toMatchObject({ total: 0, results: [], searched: { events: 2_000, from_cursor: last - 1_999 } });
  });

  it("says it read nothing from an empty window", () => {
    expect(searchLog([], ["abc"])).toEqual({ total: 0, results: [], searched: { events: 0, from_cursor: null } });
  });

  // Review Focus 4.
  it("shows a removed member only what came before its cut, cards and messages alike", async () => {
    const p = await pairUp(h);
    await write(p, { key: "before", kind: "text", body: "retry seen" });
    await say(p.creator, p.sessionId, p.creatorMemberId, "retry seen");
    expect((await p.creator.call("bellman_evict", { session_id: p.sessionId, member_id: p.joinerMemberId })).isError).toBe(false);
    await write(p, { key: "after", kind: "text", body: "retry unseen" });
    await say(p.creator, p.sessionId, p.creatorMemberId, "retry unseen");
    const cardsOut = await search(p.joiner, p.sessionId, { query: "retry" });
    expect((cardsOut.data.results as { data: { key: string } }[]).map((r) => r.data.key)).toEqual(["before"]);
    const msgs = await search(p.joiner, p.sessionId, { query: "retry", in: "messages" });
    expect((msgs.data.results as { data: { snippet: string } }[]).map((r) => r.data.snippet)).toEqual(["retry seen"]);
    const cut = (await h.store.getMember(p.sessionId, p.joinerMemberId))!.removedAtCursor!;
    expect((msgs.data.searched as { events: number }).events).toBe(cut);
  });

  // Review Focus 1.
  it("refuses in without query, a query out of bounds and a query with no word, each naming query", async () => {
    const p = await pairUp(h);
    const refused = async (args: Record<string, unknown>) => {
      const out = await search(p.creator, p.sessionId, args);
      expect(out.isError).toBe(true);
      return out.text;
    };
    expect(await refused({ in: "messages" })).toContain(IN_NEEDS_QUERY);
    expect(await refused({ query: "ab" })).toContain("query must be 3 to 200 characters");
    expect(await refused({ query: "x".repeat(201) })).toContain("query must be 3 to 200 characters");
    expect(await refused({ query: "..." })).toContain("query must hold a word of letters or digits");
  });

  it("answers a caller with no seat as today, whatever it asks", async () => {
    const p = await pairUp(h);
    const outsider = await h.connect(DEV_KEY.outsider);
    for (const args of [{ query: "retry" }, { in: "messages" }, { query: "ab" }]) {
      const out = await search(outsider, p.sessionId, args);
      expect([out.isError, out.text]).toEqual([true, "Error: no such room, or no member of yours in it."]);
    }
  });

  it("writes nothing: no event, no surface change, no seat kept alive", async () => {
    const p = await pairUp(h);
    await write(p, { key: "plan", kind: "text", body: "retry" });
    const old = Date.now() - 60 * 60_000;
    await h.store.updateMember(p.sessionId, p.creatorMemberId, { lastSeenAt: old });
    const before = await h.store.getSession(p.sessionId);
    const tail = await h.store.recentEvents(p.sessionId, 1);
    const audit = await h.store.auditForOrg("org_codenerd", 500);
    await search(p.creator, p.sessionId, { query: "retry" });
    await search(p.creator, p.sessionId, { query: "retry", in: "messages" });
    expect(await h.store.recentEvents(p.sessionId, 1)).toEqual(tail);
    expect(await h.store.auditForOrg("org_codenerd", 500)).toEqual(audit);
    const after = (await h.store.getSession(p.sessionId))!;
    expect(surfaceCursor(after)).toBe(surfaceCursor(before!));
    expect(after.members.find((m) => m.memberId === p.creatorMemberId)!.lastSeenAt).toBe(old);
  });
});
