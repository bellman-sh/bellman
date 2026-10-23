/**
 * Proposals in a topic room (topic rooms spec, D2 to D4): a contributor's action_request whose payload is
 * { kind: "surface_proposal", item, base }. This file holds how long one lives (Task 2) and what bellman_send
 * checks before one is sent (Task 4).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pairUp, topicRoom, type TopicRoom } from "../helpers/flows.js";
import { Harness, type Peer } from "../helpers/harness.js";
import { manifestFixture } from "../helpers/fixtures.js";

let h: Harness;
beforeEach(() => { h = new Harness(); });
afterEach(async () => { vi.useRealTimers(); await h.close(); });

/** A text card with the source D4 asks for. */
const card = (over: Record<string, unknown> = {}) => ({
  key: "tools", kind: "text", title: "Tools",
  body: "A server exposes tools by name. See https://modelcontextprotocol.io/specification/server/tools", ...over,
});
const propose = (r: TopicRoom, over: Record<string, unknown> = {}) =>
  r.contributor.call("bellman_send", {
    session_id: r.sessionId, member_id: r.contributorId, type: "action_request",
    payload: { kind: "surface_proposal", item: card(), base: 0, ...over },
  });
const sync = (peer: Peer, sessionId: string, memberId: string) =>
  peer.call("bellman_sync", { session_id: sessionId, member_id: memberId, since_cursor: 0 });
type Outstanding = { cursor: number; mine: boolean }[];

describe("how long a proposal stays open (D3)", () => {
  it("keeps one outstanding in bellman_sync for a week in a topic room, in both directions, while a plain request lapses in half an hour", async () => {
    const r = await topicRoom(h);
    vi.setSystemTime(Date.now() - 2 * 60 * 60_000);
    const asked = await propose(r);
    const plain = await r.contributor.call("bellman_send", {
      session_id: r.sessionId, member_id: r.contributorId, type: "action_request", payload: { ask: "run it" },
    });
    vi.useRealTimers();
    expect(asked.isError, asked.text).toBe(false);
    expect(plain.isError, plain.text).toBe(false);

    const theirs = await sync(r.maintainer, r.sessionId, r.maintainerId);
    const mine = await sync(r.contributor, r.sessionId, r.contributorId);
    expect(theirs.data.outstanding as Outstanding).toEqual([expect.objectContaining({ cursor: asked.data.cursor, mine: false })]);
    expect(mine.data.outstanding as Outstanding).toEqual([expect.objectContaining({ cursor: asked.data.cursor, mine: true })]);
  });

  it("expires it after seven days", async () => {
    const r = await topicRoom(h);
    vi.setSystemTime(Date.now() - 8 * 24 * 60 * 60_000);
    expect((await propose(r)).isError).toBe(false);
    vi.useRealTimers();
    expect((await sync(r.maintainer, r.sessionId, r.maintainerId)).data.outstanding).toBeUndefined();
  });

  it("still holds it open six days on, so the week is not shorter than the week", async () => {
    const r = await topicRoom(h);
    vi.setSystemTime(Date.now() - 6 * 24 * 60 * 60_000);
    const asked = await propose(r);
    vi.useRealTimers();
    expect(asked.isError, asked.text).toBe(false);
    const theirs = await sync(r.maintainer, r.sessionId, r.maintainerId);
    expect(theirs.data.outstanding as Outstanding).toEqual([expect.objectContaining({ cursor: asked.data.cursor, mine: false })]);
  });

  // The steady state is a watcher polling from the room's head. Its slice holds nothing, so only the
  // stamp on the record can tell it that a proposal is still open.
  it("keeps it outstanding for a poll that starts past it, in both directions", async () => {
    const r = await topicRoom(h);
    vi.setSystemTime(Date.now() - 2 * 60 * 60_000);
    const asked = await propose(r);
    vi.useRealTimers();
    expect(asked.isError, asked.text).toBe(false);
    const past = (peer: Peer, memberId: string) =>
      peer.call("bellman_sync", { session_id: r.sessionId, member_id: memberId, since_cursor: Number(asked.data.cursor) });
    expect((await past(r.maintainer, r.maintainerId)).data.outstanding as Outstanding)
      .toEqual([expect.objectContaining({ cursor: asked.data.cursor, mine: false })]);
    expect((await past(r.contributor, r.contributorId)).data.outstanding as Outstanding)
      .toEqual([expect.objectContaining({ cursor: asked.data.cursor, mine: true })]);
  });

  // A record written before the stamp existed has none (src/stored-session.ts), so the slice has to say it.
  it("finds it in the slice when the record holds no stamp", async () => {
    const r = await topicRoom(h);
    vi.setSystemTime(Date.now() - 2 * 60 * 60_000);
    const asked = await h.store.appendEvent(r.sessionId, {
      type: "action_request", fromMemberId: r.contributorId, fromUserId: "u_outsider", fromLabel: "outsider",
      payload: { kind: "surface_proposal", item: card(), base: 0 }, refId: null,
    });
    vi.useRealTimers();
    const theirs = await sync(r.maintainer, r.sessionId, r.maintainerId);
    expect(theirs.data.outstanding as Outstanding).toEqual([expect.objectContaining({ cursor: asked!.cursor, mine: false })]);
  });

  // R9: a payload that only says surface_proposal is an ordinary request anywhere else.
  it("keeps thirty minutes for the same payload in a room that is not a topic room", async () => {
    const p = await pairUp(h, { manifest: manifestFixture({ preset: "swarm" }) });
    vi.setSystemTime(Date.now() - 2 * 60 * 60_000);
    const asked = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId, type: "action_request",
      payload: { kind: "surface_proposal", item: card(), base: 0 },
    });
    vi.useRealTimers();
    expect(asked.isError, asked.text).toBe(false);
    expect((await sync(p.creator, p.sessionId, p.creatorMemberId)).data.outstanding).toBeUndefined();
  });
});
