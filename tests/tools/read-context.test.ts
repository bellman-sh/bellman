/**
 * read_context, enforced (read_context spec): a member's brief reaches a peer only when the
 * member grants it. Each case seats a member who joined without the grant, through the tools.
 * The account the peer key names keeps its brief; jesse, who starts the room, and the outsider
 * grant theirs unless a case says otherwise.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { brief, manifestFixture } from "../helpers/fixtures.js";
import { DEV_KEY, Harness, envelopes, type Outcome, type Peer } from "../helpers/harness.js";
import { UNTRUSTED_PREAMBLE } from "../../src/projections.js";
import type { Capability } from "../../src/types.js";

let h: Harness;
beforeEach(() => {
  h = new Harness();
});
afterEach(async () => {
  await h.close();
});

const KEEPS: Capability[] = ["receive_messages"];
const GRANTS: Capability[] = ["read_context", "receive_messages"];

interface Shown { cursor: number; type: string; from: { member_id: string }; payload: Record<string, unknown> }
const shown = (read: Outcome): Shown[] => envelopes(read.data.events).map((e) => e.data as Shown);

/** A swarm room jesse starts, and a way to seat anyone through its code. */
async function room(opts: { creatorCapabilities?: Capability[] } = {}) {
  const creator = await h.connect(DEV_KEY.jesse);
  const started = await creator.call("bellman_start", {
    manifest: manifestFixture({ preset: "swarm" }),
    brief: brief({ goal: "the creator's" }),
    ...(opts.creatorCapabilities ? { capabilities: opts.creatorCapabilities } : {}),
  });
  expect(started.isError, started.text).toBe(false);
  const sessionId = String(started.data.session_id);
  const code = String(started.data.join_code);
  const join = async (key: string, capabilities: Capability[], goal = "kept to myself") => {
    const peer = await h.connect(key);
    const preview = await peer.call("bellman_connect", { join_code: code });
    expect(preview.isError, preview.text).toBe(false);
    const confirmed = await peer.call("bellman_confirm", {
      connect_token: String(preview.data.connect_token), brief: brief({ goal }), capabilities,
    });
    expect(confirmed.isError, confirmed.text).toBe(false);
    return { peer, memberId: String(confirmed.data.member_id), confirmed };
  };
  const sync = (peer: Peer, memberId: string) =>
    peer.call("bellman_sync", { session_id: sessionId, member_id: memberId, since_cursor: 0 });
  return { creator, creatorMemberId: String(started.data.member_id), sessionId, code, join, sync };
}

describe("the event paths a tool serves (read_context spec, section 3)", () => {
  it("shows peers a member who keeps their brief joining, without the brief", async () => {
    const r = await room();
    const quiet = await r.join(DEV_KEY.peer, KEEPS);
    const read = await r.sync(r.creator, r.creatorMemberId);
    const joins = shown(read).filter((e) => e.type === "member_joined");
    expect(joins.map((e) => e.from.member_id)).toEqual([quiet.memberId]);
    expect(joins[0].payload).toMatchObject({ member: { member_id: quiet.memberId }, brief: null });
    expect(read.text).not.toContain("kept to myself");
  });

  /** The sync path. The writing handle's own sync leaves out its own events, as every sync does (R1). */
  it("sends their brief_update to no peer, and to their own account's other handle", async () => {
    const r = await room();
    const laptop = await r.join(DEV_KEY.peer, KEEPS);
    const desktop = await r.join(DEV_KEY.peer, KEEPS);
    const other = await r.join(DEV_KEY.outsider, GRANTS, "the outsider's");
    const sent = await laptop.peer.call("bellman_send", {
      session_id: r.sessionId, member_id: laptop.memberId, type: "brief_update", payload: brief({ goal: "still to myself" }),
    });
    expect(sent.isError, sent.text).toBe(false);

    for (const [peer, memberId] of [[r.creator, r.creatorMemberId], [other.peer, other.memberId]] as const) {
      const read = await r.sync(peer, memberId);
      expect(shown(read).map((e) => e.type)).not.toContain("brief_update");
      expect(read.text).not.toContain("still to myself");
      expect(read.data.cursor, "the cursor moves past it").toBe(sent.data.cursor);
    }
    const mine = shown(await r.sync(desktop.peer, desktop.memberId)).find((e) => e.type === "brief_update");
    expect(mine?.payload).toMatchObject({ goal: "still to myself" });
  });

  /** A poll whose only news is a brief its author keeps: no event, the cursor past it, and no warning about peer content. */
  it("moves a peer's cursor past a brief it keeps, and warns of no peer content when that was all there was", async () => {
    const r = await room();
    const laptop = await r.join(DEV_KEY.peer, KEEPS);
    const behind = await r.join(DEV_KEY.outsider, GRANTS, "the outsider's");
    const sent = await laptop.peer.call("bellman_send", {
      session_id: r.sessionId, member_id: laptop.memberId, type: "brief_update", payload: brief({ goal: "still to myself" }),
    });
    expect(sent.isError, sent.text).toBe(false);

    const alone = await r.creator.call("bellman_sync", {
      session_id: r.sessionId, member_id: r.creatorMemberId, since_cursor: Number(behind.confirmed.data.cursor),
    });
    expect(alone.isError, alone.text).toBe(false);
    expect(shown(alone)).toEqual([]);
    expect(alone.data.cursor).toBe(sent.data.cursor);
    expect(alone.text).not.toContain(UNTRUSTED_PREAMBLE);
  });

  it("follows a grant changed in the store after the brief was sent, both ways (D1, D2)", async () => {
    const r = await room();
    const quiet = await r.join(DEV_KEY.peer, GRANTS);
    await r.join(DEV_KEY.outsider, GRANTS, "the outsider's");
    await quiet.peer.call("bellman_send", {
      session_id: r.sessionId, member_id: quiet.memberId, type: "brief_update", payload: brief({ goal: "shared, then not" }),
    });
    const theirs = async () => shown(await r.sync(r.creator, r.creatorMemberId)).filter((e) => e.from.member_id === quiet.memberId);
    expect((await theirs()).map((e) => e.type)).toEqual(["member_joined", "brief_update"]);

    await h.store.updateMember(r.sessionId, quiet.memberId, { capabilities: KEEPS });
    expect((await theirs()).map((e) => e.type)).toEqual(["member_joined"]);
    expect((await theirs())[0].payload.brief).toBeNull();

    await h.store.updateMember(r.sessionId, quiet.memberId, { capabilities: GRANTS });
    expect((await theirs()).map((e) => e.type)).toEqual(["member_joined", "brief_update"]);
  });

  it("keeps a member's last grant after they leave (D2)", async () => {
    const r = await room();
    const quiet = await r.join(DEV_KEY.peer, KEEPS);
    const open = await r.join(DEV_KEY.outsider, GRANTS, "the outsider's");
    for (const m of [quiet, open]) {
      const left = await m.peer.call("bellman_leave", { session_id: r.sessionId, member_id: m.memberId });
      expect(left.isError, left.text).toBe(false);
    }
    const joins = shown(await r.sync(r.creator, r.creatorMemberId)).filter((e) => e.type === "member_joined");
    expect(joins.map((e) => [e.from.member_id, (e.payload.brief as { goal?: string } | null)?.goal ?? null])).toEqual([
      [quiet.memberId, null],
      [open.memberId, "the outsider's"],
    ]);
  });

  it("does not make a private brief_update a peer's last_event in bellman_rooms, and makes it their own account's", async () => {
    const r = await room();
    const laptop = await r.join(DEV_KEY.peer, KEEPS);
    const desktop = await r.join(DEV_KEY.peer, KEEPS);
    await laptop.peer.call("bellman_send", {
      session_id: r.sessionId, member_id: laptop.memberId, type: "brief_update", payload: brief({ goal: "still to myself" }),
    });
    const lastFor = async (peer: Peer) => {
      const listed = await peer.call("bellman_rooms", {});
      expect(listed.isError, listed.text).toBe(false);
      return (listed.data.rooms as { session_id: string; last_event: { type: string } | null }[])
        .find((x) => x.session_id === r.sessionId)?.last_event?.type;
    };
    expect(await lastFor(r.creator)).toBe("member_joined");
    expect(await lastFor(desktop.peer)).toBe("brief_update");
  });

  /** The cost of the lookup: a poll pays for the rows only when it carries a brief, and once however many authors. */
  it("reads no member row for a poll with no brief in it, and one call for a poll with several", async () => {
    const r = await room();
    const quiet = await r.join(DEV_KEY.peer, KEEPS);
    const other = await r.join(DEV_KEY.outsider, GRANTS, "the outsider's");
    const sent = await quiet.peer.call("bellman_send", {
      session_id: r.sessionId, member_id: quiet.memberId, type: "message", payload: { text: "no brief in this" },
    });
    expect(sent.isError, sent.text).toBe(false);
    const reads = vi.spyOn(h.store, "getMembers");

    // From the cursor the last join returned, the one event ahead is the message.
    const ahead = await r.creator.call("bellman_sync", {
      session_id: r.sessionId, member_id: r.creatorMemberId, since_cursor: Number(other.confirmed.data.cursor),
    });
    expect(shown(ahead).map((e) => e.type)).toEqual(["message"]);
    expect(reads).not.toHaveBeenCalled();

    // From the start it carries both joins, and their two authors are one call.
    const whole = await r.sync(r.creator, r.creatorMemberId);
    expect(shown(whole).map((e) => e.type)).toEqual(["member_joined", "member_joined", "message"]);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(reads.mock.calls[0][1]).toEqual([quiet.memberId, other.memberId]);
  });
});
