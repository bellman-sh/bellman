/**
 * Proposals in a topic room (topic rooms spec, D2 to D4): a contributor's action_request whose payload is
 * { kind: "surface_proposal", item, base }. This file holds how long one lives (Task 2) and what bellman_send
 * checks before one is sent (Task 4).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { joinWith, pairUp, topicRoom, type TopicRoom } from "../helpers/flows.js";
import { DEV_KEY, Harness, type Peer } from "../helpers/harness.js";
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

const eventCount = async (r: TopicRoom) => (await h.store.eventsAfter(r.sessionId, 0)).length;
const say = (r: TopicRoom, text: string) =>
  r.contributor.call("bellman_send", { session_id: r.sessionId, member_id: r.contributorId, type: "message", payload: { text } });
const decline = (r: TopicRoom, cursor: unknown) =>
  r.maintainer.call("bellman_send", {
    session_id: r.sessionId, member_id: r.maintainerId, type: "action_response", ref_id: String(cursor), payload: { approved: false },
  });

describe("sending a proposal (D2 to D4)", () => {
  it("reaches the maintainers from a contributor who granted nothing, and writes nothing to the surface", async () => {
    const r = await topicRoom(h);
    const out = await propose(r);
    expect(out.isError, out.text).toBe(false);
    expect(String(out.data.note)).toContain("HUMAN must approve");
    expect(await h.store.surfaceOf(r.sessionId)).toEqual([]);
    expect((await h.store.eventsAfter(r.sessionId, 0)).at(-1)).toMatchObject({
      type: "action_request", fromMemberId: r.contributorId, payload: { kind: "surface_proposal", base: 0, item: card() },
    });
  });

  // R6: the grant is asked of the seats that can answer, and a contributor who granted nothing blocks nobody.
  it("is refused naming a maintainer who did not grant request_actions", async () => {
    const r = await topicRoom(h, { maintainerCapabilities: ["read_context", "receive_messages"] });
    const before = await eventCount(r);
    const out = await propose(r);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("did not grant request_actions");
    expect(out.text).toContain("jesse@codenerd");
    expect(await eventCount(r)).toBe(before);
  });

  it("is refused when no active seat can answer it", async () => {
    const r = await topicRoom(h);
    const second = await h.connect(DEV_KEY.peer);
    expect((await joinWith(second, r.code)).isError).toBe(false);
    expect((await r.maintainer.call("bellman_leave", { session_id: r.sessionId, member_id: r.maintainerId })).isError).toBe(false);
    const out = await propose(r);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("no active member can answer a proposal");
  });

  // R6, directly: a contributor's default grants are read_context and receive_messages. Asked of every other
  // member, the missing request_actions grant of one contributor would refuse every proposal in the room.
  it("is not blocked by another contributor who granted nothing", async () => {
    const r = await topicRoom(h);
    const second = await h.connect(DEV_KEY.peer);
    expect((await joinWith(second, r.code)).isError).toBe(false);
    const out = await propose(r);
    expect(out.isError, out.text).toBe(false);
  });

  it.each([
    ["no base", { base: undefined }, "base"],
    ["a negative base", { base: -1 }, "base"],
    ["a key the payload does not name", { note: "why" }, "note"],
    ["a base ahead of the room's surface cursor", { base: 5 }, "ahead of the room's surface cursor"],
    ["an item the surface refuses", { item: card({ kind: "link", body: "not a url" }) }, "http or https URL"],
    ["a text card with no source", { item: card({ body: "no link here" }) }, "a card needs a source"],
    ["a diagram with no source", { item: card({ kind: "diagram", body: "flowchart LR\n  A --> B" }) }, "a card needs a source"],
  ])("refuses %s, and appends nothing", async (_why, over, words) => {
    const r = await topicRoom(h);
    const before = await eventCount(r);
    const out = await propose(r, over);
    expect(out.isError, out.text).toBe(true);
    expect(out.text).toContain(words);
    expect(await eventCount(r)).toBe(before);
  });

  it("takes a link card, which is its own source, and a removal", async () => {
    const r = await topicRoom(h);
    expect((await propose(r, { item: { key: "spec", kind: "link", title: "The spec", body: "https://modelcontextprotocol.io/specification" } })).isError).toBe(false);
    expect((await propose(r, { item: { key: "old", remove: true } })).isError).toBe(false);
  });

  it("refuses a file card whose blob is not in the room (R15), naming it", async () => {
    const r = await topicRoom(h);
    const out = await propose(r, { item: { key: "pic", kind: "file", blob: { id: "a".repeat(32) } } });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(`no blob ${"a".repeat(32)} has been uploaded to this room`);
  });

  it("words each refusal as the plan gives it", async () => {
    const r = await topicRoom(h);
    expect((await propose(r, { item: card({ kind: "link", body: "not a url" }) })).text)
      .toContain('surface_proposal item: surface link "tools": body must be an absolute http or https URL');
    expect((await propose(r, { item: card({ body: "no link here" }) })).text)
      .toContain('surface_proposal "tools": a card needs a source: put at least one http:// or https:// link in its body');
    expect((await propose(r, { base: 5 })).text)
      .toContain("surface_proposal base 5 is ahead of the room's surface cursor 0: base is the surface_cursor you read");
    for (const key of ["a", "b", "c"]) expect((await propose(r, { item: card({ key }) })).isError, key).toBe(false);
    expect((await propose(r, { item: card({ key: "d" }) })).text).toContain(
      "you already hold 3 open proposals, the most a member may hold in a topic room. " +
      "A maintainer answering one, or its seven days passing, makes room for another.",
    );
  });
});

describe("the limit on open proposals (D3)", () => {
  it("holds a member to three: the fourth is refused naming three, another member's places are their own, and an answer frees one", async () => {
    const r = await topicRoom(h);
    const second = await h.connect(DEV_KEY.peer);
    const joined = await joinWith(second, r.code);
    const asked: number[] = [];
    for (const key of ["a", "b", "c"]) asked.push(Number((await propose(r, { item: card({ key }) })).data.cursor));

    const fourth = await propose(r, { item: card({ key: "d" }) });
    expect(fourth.isError).toBe(true);
    expect(fourth.text).toContain("3 open proposals");

    const theirs = await second.call("bellman_send", {
      session_id: r.sessionId, member_id: String(joined.data.member_id), type: "action_request",
      payload: { kind: "surface_proposal", item: card({ key: "e" }), base: 0 },
    });
    expect(theirs.isError, theirs.text).toBe(false);

    expect((await decline(r, asked[0])).isError).toBe(false);
    expect((await propose(r, { item: card({ key: "d" }) })).isError).toBe(false);
  });

  // A proposal lives a week, so the count reads back a week and not the half hour a plain request lives.
  it("counts proposals sent hours ago, which are still open", async () => {
    const r = await topicRoom(h);
    vi.setSystemTime(Date.now() - 2 * 60 * 60_000);
    for (const key of ["a", "b", "c"]) expect((await propose(r, { item: card({ key }) })).isError, key).toBe(false);
    vi.useRealTimers();
    const fourth = await propose(r, { item: card({ key: "d" }) });
    expect(fourth.isError).toBe(true);
    expect(fourth.text).toContain("3 open proposals");
  });

  // The contributor came through the permanent code: a stranger, six sends a minute (abuse protections D5).
  it("counts a proposal under the send limit, and a refused one spends no place", async () => {
    const r = await topicRoom(h);
    for (const key of ["a", "b", "c"]) expect((await propose(r, { item: card({ key }) })).isError, key).toBe(false);
    expect((await propose(r, { item: card({ key: "d" }) })).text).toContain("3 open proposals");
    for (const i of [1, 2, 3]) expect((await say(r, `m${i}`)).isError, `message ${i}`).toBe(false);
    const over = await say(r, "one too many");
    expect(over.isError).toBe(true);
    expect(over.data).toMatchObject({ error: "rate_limited" });
  });

  it("cannot be sent by an account the creator evicted: the handle has left, which needs no check of its own", async () => {
    const r = await topicRoom(h);
    const gone = await r.maintainer.call("bellman_evict", { session_id: r.sessionId, member_id: r.contributorId, ban: "room" });
    expect(gone.isError, gone.text).toBe(false);
    const out = await propose(r);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("has left the session");
  });
});

describe("outside a topic room, and a seat that holds only send", () => {
  // Spec section 1: elsewhere a surface_proposal is an ordinary action request. Nothing is checked or applied.
  it("is an ordinary action request in a swarm room: not checked, nothing written to the surface", async () => {
    const p = await pairUp(h, { manifest: manifestFixture({ preset: "swarm" }) });
    const odd = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId, type: "action_request",
      payload: { kind: "surface_proposal", item: 5, base: "x" },
    });
    expect(odd.isError, odd.text).toBe(false);
    expect(await h.store.surfaceOf(p.sessionId)).toEqual([]);
  });

  // The hosted seat holds exactly send (checkHost) and never calls bellman_send; a seat with that role is refused by its verb.
  it("is refused to a seat that holds only send, as the hosted seat does: the verb check names request_actions", async () => {
    const manifest = {
      room: "quiet-room", mode: "swarm", default_role: "quiet", creator_role: "lead",
      roles: { lead: { can: ["send", "invite", "request_actions", "respond_actions", "write_surface"] }, quiet: { can: ["send"] } },
    };
    const p = await pairUp(h, { manifest });
    const out = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId, type: "action_request",
      payload: { kind: "surface_proposal", item: card(), base: 0 },
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('does not hold the verb "request_actions"');
  });
});
