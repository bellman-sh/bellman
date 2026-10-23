/**
 * Approving a proposal through bellman_send (topic rooms spec, D2): a maintainer's human answers with approved: true,
 * and the card is written in the response's transaction. The store's cases are tests/helpers/store-contract.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { card, pairUp, propose, sync, topicRoom, joinWith, type TopicRoom } from "../helpers/flows.js";
import { DEV_KEY, Harness } from "../helpers/harness.js";
import { manifestFixture, member, session } from "../helpers/fixtures.js";
import { newBlobId } from "../../src/blobs.js";
import { resolveManifest } from "../../src/manifest.js";
import { sendKeyFor, sendLimitFor } from "../../src/send-limit.js";
import { MemoryStore } from "../../src/store.js";
import { MAX_SURFACE_ITEMS } from "../../src/surface.js";
import type { SurfaceItem } from "../../src/types.js";
import { text } from "../helpers/blob-bytes.js";

let h: Harness;
beforeEach(() => { h = new Harness(); });
afterEach(async () => { await h.close(); });

const answer = (r: TopicRoom, cursor: unknown, payload: Record<string, unknown> = { approved: true }, extra: Record<string, unknown> = {}) =>
  r.maintainer.call("bellman_send", {
    session_id: r.sessionId, member_id: r.maintainerId, type: "action_response", ref_id: String(cursor), payload, ...extra,
  });
const rowsOf = (r: TopicRoom) => h.store.surfaceOf(r.sessionId);
const eventsOf = (r: TopicRoom) => h.store.eventsAfter(r.sessionId, 0);
type Outstanding = { cursor: number }[];

/** A second maintainer, seated through a code that carries the role. */
const seatMaintainer = async (r: TopicRoom) => {
  const peer = await h.connect(DEV_KEY.peer);
  const door = await r.maintainer.call("bellman_invite", { session_id: r.sessionId, member_id: r.maintainerId, role: "maintainer" });
  const joined = await joinWith(peer, String(door.data.join_code), ["read_context", "receive_messages", "request_actions"]);
  expect(joined.isError, joined.text).toBe(false);
  return { peer, memberId: String(joined.data.member_id) };
};

/** The surface at its cap, written by the maintainer straight into the store. */
const fillSurface = async (r: TopicRoom) => {
  for (let i = 0; i < MAX_SURFACE_ITEMS; i++) {
    const item: SurfaceItem = { ...card({ key: `k${i}` }), kind: "text", ends: null, placement: null, blob: null, shape: null };
    await h.store.appendEvent(r.sessionId, {
      type: "surface", fromMemberId: r.maintainerId, fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: item, refId: null,
    }, { surface: { key: `k${i}`, item } });
  }
};

describe("approving a proposal", () => {
  it("writes the card: authored by the contributor, approved by the maintainer, after the response in the log, and every read names both", async () => {
    const r = await topicRoom(h);
    const asked = await propose(r);
    const out = await answer(r, asked.data.cursor);
    expect(out.isError, out.text).toBe(false);

    const log = await eventsOf(r);
    expect(log.slice(-3).map((e) => [e.type, e.fromMemberId])).toEqual([
      ["action_request", r.contributorId], ["action_response", r.maintainerId], ["surface", r.contributorId],
    ]);
    expect(out.data).toMatchObject({ cursor: log.at(-2)!.cursor, applied: { key: "tools", cursor: log.at(-1)!.cursor } });
    expect(await rowsOf(r)).toEqual([expect.objectContaining({
      key: "tools", byMemberId: r.contributorId, byLabel: r.contributor.identity.label,
      approvedBy: { memberId: r.maintainerId, label: r.maintainer.identity.label },
    })]);
    const read = await r.maintainer.call("bellman_surface", { session_id: r.sessionId });
    const items = (read.data.surface as { items: { origin: { label: string }; data: { approved_by: unknown } }[] }).items;
    expect(items[0].origin.label).toBe(r.contributor.identity.label);
    expect(items[0].data.approved_by).toEqual({ member_id: r.maintainerId, label: r.maintainer.identity.label });
  });

  // `decideApproval` checks the approver's seat and nothing about the proposer's, which is intended: the card is
  // the proposer's words and keeps their name whether or not they are still in the room.
  it.each(["leaves", "is evicted"])("writes the card under the proposer's name when the proposer %s before the approval", async (how) => {
    const r = await topicRoom(h);
    const asked = await propose(r);
    // Someone else stays, so the maintainer is not answering an empty room.
    const bystander = await h.connect(DEV_KEY.peer);
    expect((await joinWith(bystander, r.code)).isError).toBe(false);
    const gone = how === "leaves"
      ? await r.contributor.call("bellman_leave", { session_id: r.sessionId, member_id: r.contributorId })
      : await r.maintainer.call("bellman_evict", { session_id: r.sessionId, member_id: r.contributorId, ban: "room" });
    expect(gone.isError, gone.text).toBe(false);

    const out = await answer(r, asked.data.cursor);

    expect(out.isError, out.text).toBe(false);
    expect(out.data.applied).toMatchObject({ key: "tools" });
    expect(await rowsOf(r)).toEqual([expect.objectContaining({
      key: "tools", byMemberId: r.contributorId, byLabel: r.contributor.identity.label,
      approvedBy: { memberId: r.maintainerId, label: r.maintainer.identity.label },
    })]);
    expect((await eventsOf(r)).at(-1)).toMatchObject({ type: "surface", fromMemberId: r.contributorId });
  });

  it("files an audit row for the response and one for the card, the card's naming the proposal it came from", async () => {
    const r = await topicRoom(h);
    const asked = await propose(r);
    await answer(r, asked.data.cursor);
    const rows = await h.store.auditForOrg(r.maintainer.identity.orgId!, 50);
    expect(rows.slice(-2).map((a) => a.action)).toEqual(["sent_action_response", "sent_surface"]);
    expect(rows.at(-1)!.detail).toMatchObject({ key: "tools", kind: "text", approved: Number(asked.data.cursor) });
  });

  it("writes nothing when the human declines, and the proposal reads declined", async () => {
    const r = await topicRoom(h);
    const asked = await propose(r);
    expect((await answer(r, asked.data.cursor, { approved: false })).isError).toBe(false);
    expect(await rowsOf(r)).toEqual([]);
    expect((await eventsOf(r)).map((e) => e.type).filter((t) => t === "surface")).toEqual([]);
  });

  it("removes a card when a removal is approved", async () => {
    const r = await topicRoom(h);
    const first = await propose(r);
    await answer(r, first.data.cursor);
    expect(await rowsOf(r)).toHaveLength(1);
    const sf = await r.maintainer.call("bellman_sync", { session_id: r.sessionId, member_id: r.maintainerId, since_cursor: 0, surface: true });
    const base = (sf.data.surface as { cursor: number }).cursor;
    const removal = await propose(r, { item: { key: "tools", remove: true }, base });
    expect((await answer(r, removal.data.cursor)).isError).toBe(false);
    expect(await rowsOf(r)).toEqual([]);
  });

  // Review Focus 1.
  it("refuses a stale approval, naming the card's cursor, writes nothing, leaves the proposal open, and a decline then closes it", async () => {
    const r = await topicRoom(h);
    const first = await propose(r, { item: card({ body: "First. https://example.com/1" }) });
    const second = await propose(r, { item: card({ body: "Second. https://example.com/2" }) });
    const landed = await answer(r, first.data.cursor);
    expect(landed.isError, landed.text).toBe(false);
    const before = (await eventsOf(r)).length;

    const late = await answer(r, second.data.cursor);
    expect(late.isError).toBe(true);
    expect(late.data).toEqual({ error: "stale", cursor: (landed.data.applied as { cursor: number }).cursor });
    expect(late.text).toContain("stale");
    expect((await eventsOf(r)).length).toBe(before);
    expect((await rowsOf(r))[0].body).toBe("First. https://example.com/1");

    const open = await sync(r.contributor, r.sessionId, r.contributorId);
    expect((open.data.outstanding as Outstanding).map((o) => o.cursor)).toEqual([second.data.cursor]);
    expect((await answer(r, second.data.cursor, { approved: false })).isError).toBe(false);
    expect((await sync(r.contributor, r.sessionId, r.contributorId)).data.outstanding).toBeUndefined();
  });

  it("refuses a second approval of the same proposal: the first answer is the one that counts", async () => {
    const r = await topicRoom(h);
    const second = await seatMaintainer(r);
    const asked = await propose(r);
    expect((await answer(r, asked.data.cursor)).isError).toBe(false);
    const before = (await eventsOf(r)).length;

    const again = await second.peer.call("bellman_send", {
      session_id: r.sessionId, member_id: second.memberId, type: "action_response",
      ref_id: String(asked.data.cursor), payload: { approved: true },
    });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("was already answered");
    expect((await eventsOf(r)).length).toBe(before);
  });

  /**
   * A topic room whose maintainer role holds respond_actions without write_surface, and a proposal of `item` in it
   * from its contributor. The preset never makes such a room (R13), so it is built by hand; `approve` is the
   * maintainer's `approved: true`.
   */
  const roomWithoutWriter = async (item: Record<string, unknown>) => {
    const base = resolveManifest({ room: "mcp", preset: "topic", public: true });
    const manifest = {
      ...base,
      roles: { ...base.roles, maintainer: { ...base.roles.maintainer, can: base.roles.maintainer.can.filter((v) => v !== "write_surface") } },
    };
    const caps = ["read_context", "receive_messages", "request_actions"] as const;
    await h.store.createSession(session({
      id: "qs_nowrite", manifest,
      members: [
        member({ memberId: "m_maint", userId: "u_jesse", label: "jesse@codenerd", roomRole: "maintainer", capabilities: [...caps] }),
        member({ memberId: "m_ada", userId: "u_peer", label: "peer@codenerd", roomRole: "contributor" }),
      ],
    }));
    const maintainer = await h.connect(DEV_KEY.jesse);
    const contributor = await h.connect(DEV_KEY.peer);
    const asked = await contributor.call("bellman_send", {
      session_id: "qs_nowrite", member_id: "m_ada", type: "action_request", payload: { kind: "surface_proposal", item, base: 0 },
    });
    expect(asked.isError, asked.text).toBe(false);
    return {
      approve: (extra: Record<string, unknown> = {}) => maintainer.call("bellman_send", {
        session_id: "qs_nowrite", member_id: "m_maint", type: "action_response", ref_id: String(asked.data.cursor), payload: { approved: true },
        ...extra,
      }),
    };
  };

  // Review Focus 2: recorded, not applied.
  it("records an approval from a seat that holds respond_actions without write_surface, and applies nothing", async () => {
    const { approve } = await roomWithoutWriter(card());
    const out = await approve();
    expect(out.isError, out.text).toBe(false);
    expect(out.data.applied).toBeUndefined();
    expect(await h.store.surfaceOf("qs_nowrite")).toEqual([]);
  });

  // The retry of a response that wrote no card says so as the first call did: `applied` is absent, not borrowed from the next event.
  it("replays a seat's recorded response without an applied card: a retry names none", async () => {
    const { approve } = await roomWithoutWriter(card());
    const first = await approve({ idempotency_key: "approve-0001" });
    expect(first.isError, first.text).toBe(false);
    const retry = await approve({ idempotency_key: "approve-0001" });
    expect(retry.isError, retry.text).toBe(false);
    expect(retry.data).toMatchObject({ cursor: first.data.cursor, replayed: true });
    expect(retry.data.applied).toBeUndefined();
  });

  // Such a seat has no card to write, so there is none to settle and none to refuse: its answer is recorded whatever the card is.
  it("settles no card for such a seat: a proposal that could not be written is recorded all the same", async () => {
    const { approve } = await roomWithoutWriter({ key: "link", kind: "connector", ends: { from: "a", to: "b" } });
    const out = await approve();
    expect(out.isError, out.text).toBe(false);
    expect(out.data.applied).toBeUndefined();
  });

  it("applies nothing outside a topic room: an approval of a surface_proposal there is an ordinary answer", async () => {
    const p = await pairUp(h, { manifest: manifestFixture({ preset: "swarm" }) });
    const asked = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId, type: "action_request", payload: { kind: "surface_proposal", item: card(), base: 0 },
    });
    expect(asked.isError, asked.text).toBe(false);
    const out = await p.creator.call("bellman_send", {
      session_id: p.sessionId, member_id: p.creatorMemberId, type: "action_response", ref_id: String(asked.data.cursor), payload: { approved: true },
    });
    expect(out.isError, out.text).toBe(false);
    expect(out.data.applied).toBeUndefined();
    expect(await h.store.surfaceOf(p.sessionId)).toEqual([]);
  });

  // The store would apply nothing here either, so this is the case that tells the tool's own test of the room from the store's.
  it("is an ordinary answer there even to a proposal whose card could not be written: nothing is settled", async () => {
    const p = await pairUp(h, { manifest: manifestFixture({ preset: "swarm" }) });
    const asked = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId, type: "action_request",
      payload: { kind: "surface_proposal", item: { key: "link", kind: "connector", ends: { from: "a", to: "b" } }, base: 0 },
    });
    expect(asked.isError, asked.text).toBe(false);
    const out = await p.creator.call("bellman_send", {
      session_id: p.sessionId, member_id: p.creatorMemberId, type: "action_response", ref_id: String(asked.data.cursor), payload: { approved: true },
    });
    expect(out.isError, out.text).toBe(false);
    expect(out.data.applied).toBeUndefined();
  });

  // The hosted seat holds exactly send; a seat with that role is refused by its verb, as it would be for any answer.
  it("cannot be done by a seat that holds only send, as the hosted seat does", async () => {
    const manifest = {
      room: "quiet-room", mode: "swarm", default_role: "quiet", creator_role: "lead",
      roles: { lead: { can: ["send", "invite", "request_actions", "respond_actions", "write_surface"] }, quiet: { can: ["send"] } },
    };
    const p = await pairUp(h, { manifest });
    const asked = await p.creator.call("bellman_send", {
      session_id: p.sessionId, member_id: p.creatorMemberId, type: "action_request", payload: { ask: "run it" },
    });
    const out = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId, type: "action_response", ref_id: String(asked.data.cursor), payload: { approved: true },
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('does not hold the verb "respond_actions"');
  });
});

// Review Focus 5 and R14: the item is settled again at approval, and a refusal there appends nothing.
describe("a proposal whose card cannot be written when it is approved", () => {
  it("is refused when the surface is full, appends nothing, and stays open", async () => {
    const r = await topicRoom(h);
    const asked = await propose(r);
    await fillSurface(r);
    const before = (await eventsOf(r)).length;
    const out = await answer(r, asked.data.cursor);
    expect(out.isError).toBe(true);
    expect(out.text).toContain(`already holds ${MAX_SURFACE_ITEMS} items`);
    expect((await eventsOf(r)).length).toBe(before);
    expect(((await sync(r.contributor, r.sessionId, r.contributorId)).data.outstanding as Outstanding).map((o) => o.cursor)).toEqual([asked.data.cursor]);
  });

  it("is refused when a connector's end is not on the surface", async () => {
    const r = await topicRoom(h);
    const asked = await propose(r, { item: { key: "link", kind: "connector", ends: { from: "a", to: "b" } } });
    expect(asked.isError, asked.text).toBe(false);
    const out = await answer(r, asked.data.cursor);
    expect(out.isError).toBe(true);
    expect(out.text).toContain('connector "link" names "a", which is not on the surface');
  });

  // ADR 0022: the refusal comes before the minute's count, so the approver keeps the place the refused answer did not use.
  it("spends no place of the send limit when it is refused", async () => {
    const r = await topicRoom(h);
    const asked = await propose(r);
    await fillSurface(r);
    const me = (await h.store.getSession(r.sessionId))!.members.find((m) => m.memberId === r.maintainerId)!;
    for (let i = 1; i < sendLimitFor(me); i++) await h.store.admitSend(r.sessionId, sendKeyFor(me), sendLimitFor(me), Date.now());

    const refused = await answer(r, asked.data.cursor);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(`already holds ${MAX_SURFACE_ITEMS} items`);

    const next = await r.maintainer.call("bellman_send", {
      session_id: r.sessionId, member_id: r.maintainerId, type: "message", payload: { text: "the last place of the minute" },
    });
    expect(next.isError, next.text).toBe(false);
  });

  const stored = async (r: TopicRoom) => {
    const id = newBlobId();
    const bytes = text("notes");
    await h.blobs.put(r.sessionId, id, bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer, {
      bytes: bytes.byteLength, type: "text/markdown", name: "notes.md", by: r.maintainerId, at: 1_700_000_000_000,
    });
    return id;
  };

  it("takes a file card's size, type and name from the object at approval, and is refused when the object has gone", async () => {
    const r = await topicRoom(h);
    const id = await stored(r);
    const asked = await propose(r, { item: { key: "notes", kind: "file", blob: { id } } });
    expect(asked.isError, asked.text).toBe(false);
    expect((await answer(r, asked.data.cursor)).isError).toBe(false);
    expect((await rowsOf(r))[0].blob).toEqual({ id, bytes: 5, type: "text/markdown", name: "notes.md" });

    const gone = await stored(r);
    const next = await propose(r, { item: { key: "more", kind: "file", blob: { id: gone } } });
    await h.blobs.delete(r.sessionId, gone);
    const out = await answer(r, next.data.cursor);
    expect(out.isError).toBe(true);
    expect(out.text).toContain(`no blob ${gone} has been uploaded to this room`);
  });
});

describe("an idempotent retry of an approval", () => {
  it("replays the response after the room changed: no second write, and no stale", async () => {
    const r = await topicRoom(h);
    const asked = await propose(r);
    const first = await answer(r, asked.data.cursor, { approved: true }, { idempotency_key: "approve-0001" });
    expect(first.isError, first.text).toBe(false);
    const changed = await r.maintainer.call("bellman_send", {
      session_id: r.sessionId, member_id: r.maintainerId, type: "surface", payload: card({ body: "Edited. https://example.com/e" }),
    });
    expect(changed.isError, changed.text).toBe(false);
    const before = (await eventsOf(r)).length;

    const retry = await answer(r, asked.data.cursor, { approved: true }, { idempotency_key: "approve-0001" });

    expect(retry.isError, retry.text).toBe(false);
    expect(retry.data).toMatchObject({ cursor: first.data.cursor, replayed: true, applied: first.data.applied });
    expect(first.data.applied, "the premise: the first call wrote a card").toBeDefined();
    expect((await eventsOf(r)).length).toBe(before);
    expect((await rowsOf(r))[0].body).toBe("Edited. https://example.com/e");
  });

  // R21: a retry re-checks nothing. The same approval sent fresh would now be refused for a full surface.
  it("replays even when the card could no longer be written, since a retry settles nothing again", async () => {
    const r = await topicRoom(h);
    const asked = await propose(r);
    const first = await answer(r, asked.data.cursor, { approved: true }, { idempotency_key: "approve-0001" });
    expect(first.isError, first.text).toBe(false);
    const removed = await r.maintainer.call("bellman_send", {
      session_id: r.sessionId, member_id: r.maintainerId, type: "surface", payload: { key: "tools", remove: true },
    });
    expect(removed.isError, removed.text).toBe(false);
    await fillSurface(r);
    const before = (await eventsOf(r)).length;

    const retry = await answer(r, asked.data.cursor, { approved: true }, { idempotency_key: "approve-0001" });

    expect(retry.isError, retry.text).toBe(false);
    expect(retry.data).toMatchObject({ cursor: first.data.cursor, replayed: true, applied: first.data.applied });
    expect(first.data.applied, "the premise: the first call wrote a card").toBeDefined();
    expect((await eventsOf(r)).length).toBe(before);
  });

  it("refuses the same seat answering again under another key, or none: only the key's own retry replays", async () => {
    const r = await topicRoom(h);
    const asked = await propose(r);
    expect((await answer(r, asked.data.cursor, { approved: true }, { idempotency_key: "approve-0001" })).isError).toBe(false);
    const before = (await eventsOf(r)).length;

    for (const extra of [{ idempotency_key: "approve-0002" }, {}]) {
      const again = await answer(r, asked.data.cursor, { approved: true }, extra);
      expect(again.isError, JSON.stringify(extra)).toBe(true);
      expect(again.text).toContain(`was already answered by ${r.maintainer.identity.label}`);
    }
    expect((await eventsOf(r)).length).toBe(before);
  });

  // The check that keeps the first answer first is an ordinary answer's only one, so a key does not relax it.
  it("keeps the check for an answer that is not an approval: a second decline under another key is refused", async () => {
    const r = await topicRoom(h);
    const asked = await propose(r);
    expect((await answer(r, asked.data.cursor, { approved: false }, { idempotency_key: "decline-0001" })).isError).toBe(false);
    const before = (await eventsOf(r)).length;

    const again = await answer(r, asked.data.cursor, { approved: false }, { idempotency_key: "decline-0002" });

    expect(again.isError).toBe(true);
    expect(again.text).toContain("was already answered");
    expect((await eventsOf(r)).length).toBe(before);
  });

  // The key is read before the check for an earlier answer, so the decline's own record is what the retry meets.
  it("replays a keyed retry of a decline, not refusing it as already answered", async () => {
    const r = await topicRoom(h);
    const asked = await propose(r);
    const first = await answer(r, asked.data.cursor, { approved: false }, { idempotency_key: "decline-0001" });
    expect(first.isError, first.text).toBe(false);
    const before = (await eventsOf(r)).length;

    const retry = await answer(r, asked.data.cursor, { approved: false }, { idempotency_key: "decline-0001" });

    expect(retry.isError, retry.text).toBe(false);
    expect(retry.data).toMatchObject({ cursor: first.data.cursor, replayed: true });
    expect(retry.data.applied).toBeUndefined();
    expect((await eventsOf(r)).length).toBe(before);
  });

  it("replays a keyed retry of an answer outside a topic room", async () => {
    const p = await pairUp(h, { manifest: manifestFixture({ preset: "swarm" }) });
    const asked = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId, type: "action_request", payload: { ask: "run it" },
    });
    expect(asked.isError, asked.text).toBe(false);
    const respond = () => p.creator.call("bellman_send", {
      session_id: p.sessionId, member_id: p.creatorMemberId, type: "action_response", ref_id: String(asked.data.cursor),
      payload: { approved: true }, idempotency_key: "answer-0001",
    });
    const first = await respond();
    expect(first.isError, first.text).toBe(false);
    const before = (await h.store.eventsAfter(p.sessionId, 0)).length;

    const retry = await respond();

    expect(retry.isError, retry.text).toBe(false);
    expect(retry.data).toMatchObject({ cursor: first.data.cursor, replayed: true });
    expect((await h.store.eventsAfter(p.sessionId, 0)).length).toBe(before);
  });

  it("refuses a key already used for a different answer, and writes nothing for it", async () => {
    const r = await topicRoom(h);
    const first = await propose(r, { item: card({ key: "one" }) });
    const second = await propose(r, { item: card({ key: "two" }) });
    expect((await answer(r, first.data.cursor, { approved: true }, { idempotency_key: "approve-0001" })).isError).toBe(false);
    const before = (await eventsOf(r)).length;

    const out = await answer(r, second.data.cursor, { approved: true }, { idempotency_key: "approve-0001" });

    expect(out.isError).toBe(true);
    expect(out.text).toContain('idempotency_key "approve-0001" was already used for a different message');
    expect((await eventsOf(r)).length).toBe(before);
    expect(((await sync(r.contributor, r.sessionId, r.contributorId)).data.outstanding as Outstanding).map((o) => o.cursor)).toEqual([second.data.cursor]);
  });
});

/**
 * The tool reads the room, then asks the store to write, and the store decides again in its own transaction. These
 * cases make the tool's reads miss, as they do when two approvals or a freeze land in the gap, so the store's
 * outcomes are the ones that answer.
 */
describe("an approval the store refuses after the tool's reads let it through", () => {
  class GapStore extends MemoryStore {
    /** The tool's look for an earlier answer sees none. */
    blindToAnswers = false;
    /** The tool's read of the room sees it thawed. */
    blindToFreeze = false;
    override async eventsAfter(sessionId: string, cursor: number, limit?: number) {
      return this.blindToAnswers ? [] : super.eventsAfter(sessionId, cursor, limit);
    }
    override async getSession(id: string) {
      const room = await super.getSession(id);
      return this.blindToFreeze && room ? { ...room, frozenAt: null } : room;
    }
  }

  it("answers a second approval as already answered, naming who answered, and writes nothing for it", async () => {
    const store = new GapStore();
    h = new Harness(store);
    const r = await topicRoom(h);
    const second = await seatMaintainer(r);
    const asked = await propose(r);
    expect((await answer(r, asked.data.cursor)).isError).toBe(false);
    const before = (await eventsOf(r)).length;

    store.blindToAnswers = true;
    const again = await second.peer.call("bellman_send", {
      session_id: r.sessionId, member_id: second.memberId, type: "action_response",
      ref_id: String(asked.data.cursor), payload: { approved: true },
    });
    store.blindToAnswers = false;

    expect(again.isError).toBe(true);
    expect(again.text).toContain(`action_request ${asked.data.cursor} was already answered by ${r.maintainer.identity.label}`);
    expect((await eventsOf(r)).length).toBe(before);
    expect(await rowsOf(r)).toHaveLength(1);
  });

  it("answers a room that froze after the tool read it as frozen, and writes nothing", async () => {
    const store = new GapStore();
    h = new Harness(store);
    const r = await topicRoom(h);
    const asked = await propose(r);
    await store.freezeSession(r.sessionId, Date.now());
    store.blindToFreeze = true;
    const before = (await eventsOf(r)).length;

    const out = await answer(r, asked.data.cursor);

    expect(out.isError).toBe(true);
    expect(out.text).toContain("this session is frozen");
    expect((await eventsOf(r)).length).toBe(before);
    expect(await rowsOf(r)).toEqual([]);
  });
});
