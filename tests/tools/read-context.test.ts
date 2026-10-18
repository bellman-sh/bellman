/**
 * read_context, enforced (read_context spec): a member's brief reaches a peer only when the
 * member grants it. Each case seats a member who joined without the grant, through the tools.
 * The account the peer key names keeps its brief; jesse, who starts the room, and the outsider
 * grant theirs unless a case says otherwise.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { brief, manifestFixture, member, swarmSession } from "../helpers/fixtures.js";
import { DEV_KEY, Harness, envelopes, type Outcome, type Peer } from "../helpers/harness.js";
import { HOST_MEMBER_ID } from "../../src/host.js";
import { UNTRUSTED_PREAMBLE } from "../../src/projections.js";
import { BRIEFS_ON_JOIN } from "../../src/tools/confirm.js";
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

describe("the briefs read directly (read_context spec, section 1)", () => {
  it("leaves a member's brief out of what bellman_confirm hands a later joiner, who is told one was left out", async () => {
    const r = await room();
    const quiet = await r.join(DEV_KEY.peer, KEEPS);
    const later = await r.join(DEV_KEY.outsider, GRANTS, "the outsider's");
    expect(envelopes(later.confirmed.data.briefs).map((b) => b.origin.memberId)).toEqual([r.creatorMemberId]);
    expect(later.confirmed.data.briefs_omitted).toBe(1);
    expect(later.confirmed.text).not.toContain("kept to myself");

    // Their own account's next handle is handed it (D3, R6).
    const again = await r.join(DEV_KEY.peer, KEEPS);
    expect(envelopes(again.confirmed.data.briefs).map((b) => b.origin.memberId)).toContain(quiet.memberId);
  });

  /** Plan ruling R7: a brief its author keeps is left out before the cut, so it takes none of the places. */
  it("fills the places with briefs it can hand, so a kept brief takes none of them, and counts the kept ones as omitted (R7)", async () => {
    const now = Date.now();
    // m_00 was heard from last, and each member after it a second earlier. The five heard from most recently keep their briefs.
    const members = Array.from({ length: 40 }, (_, i) => member({
      memberId: `m_${String(i).padStart(2, "0")}`,
      userId: `u_member_${i}`,
      roomRole: "peer_b",
      capabilities: i < 5 ? KEEPS : GRANTS,
      brief: brief({ goal: `member ${i}` }),
      joinedAt: now - 100_000,
      lastSeenAt: now - i * 1000,
    }));
    await h.store.createSession(swarmSession({ members }));

    const joiner = await h.connect(DEV_KEY.outsider);
    const preview = await joiner.call("bellman_connect", { join_code: "BELL-TEST-01" });
    expect(preview.isError, preview.text).toBe(false);
    const joined = await joiner.call("bellman_confirm", { connect_token: String(preview.data.connect_token), brief: brief() });
    expect(joined.isError, joined.text).toBe(false);

    expect(envelopes(joined.data.briefs).map((b) => b.origin.memberId))
      .toEqual(members.slice(5, 5 + BRIEFS_ON_JOIN).map((m) => m.memberId));
    expect(joined.data.briefs_omitted).toBe(members.length - BRIEFS_ON_JOIN);
  });

  it("leaves a creator's brief out of bellman_connect's preview, which their own account still reads", async () => {
    const r = await room({ creatorCapabilities: KEEPS });
    const preview = await (await h.connect(DEV_KEY.peer)).call("bellman_connect", { join_code: r.code });
    expect(preview.isError, preview.text).toBe(false);
    expect(preview.data.creator_brief).toMatchObject({ trust: "untrusted", origin: { memberId: r.creatorMemberId }, data: null });
    expect(preview.text).not.toContain("the creator's");

    const own = await (await h.connect(DEV_KEY.jesse)).call("bellman_connect", { join_code: r.code });
    expect((own.data.creator_brief as { data: { goal: string } }).data.goal).toBe("the creator's");
  });

  /** Review Focus 5: a creator who left is read by row (ADR 0019), not off the room's record. */
  it("keeps a creator's last grant after they leave, so a granted brief still shows (D2)", async () => {
    const r = await room();
    await r.join(DEV_KEY.outsider, GRANTS, "the outsider's");
    const left = await r.creator.call("bellman_leave", { session_id: r.sessionId, member_id: r.creatorMemberId });
    expect(left.isError, left.text).toBe(false);
    const preview = await (await h.connect(DEV_KEY.peer)).call("bellman_connect", { join_code: r.code });
    expect(preview.isError, preview.text).toBe(false);
    expect((preview.data.creator_brief as { data: { goal: string } | null }).data?.goal).toBe("the creator's");
  });
});

/** Review Focus 1, and ruling R4: a new hosted seat grants read_context (the owner's choice). */
describe("a hosted room", () => {
  it("hands a joiner the hosted seat's brief, because the seat grants read_context", async () => {
    const creator = await h.connectAs({ userId: "u_max", orgId: null, plan: "max", role: "member", label: "max" });
    const started = await creator.call("bellman_start", {
      manifest: { room: "the square", purpose: "what people build", preset: "social" }, brief: brief({ goal: "the creator's" }),
    });
    expect(started.isError, started.text).toBe(false);
    const sessionId = String(started.data.session_id);
    const joiner = await h.connect(DEV_KEY.peer);
    const preview = await joiner.call("bellman_connect", { join_code: String(started.data.join_code) });
    const joined = await joiner.call("bellman_confirm", { connect_token: String(preview.data.connect_token), brief: brief() });
    expect(joined.isError, joined.text).toBe(false);
    expect(envelopes(joined.data.briefs).map((b) => b.origin.memberId)).toContain(HOST_MEMBER_ID);
    expect((await h.store.getMember(sessionId, HOST_MEMBER_ID))?.capabilities).toEqual(["read_context", "receive_messages"]);
  });
});

describe("the tool text (read_context spec, section 2)", () => {
  it("says on bellman_start and bellman_confirm what read_context does", async () => {
    const { tools } = await (await h.connect(DEV_KEY.jesse)).listTools();
    for (const name of ["bellman_start", "bellman_confirm"]) {
      expect(tools.find((t) => t.name === name)!.description, name)
        .toContain("read_context lets peers read your brief; it is on by default, and without it only you see your brief.");
    }
  });

  /** The result text the creator reads and relays, not the listing: it must not promise joiners a brief that no joiner can read. */
  it("leaves bellman_start's instruction to review the creator's brief out of its result when the creator withholds read_context", async () => {
    const creator = await h.connect(DEV_KEY.jesse);
    const instructions = async (capabilities?: Capability[]) => {
      const started = await creator.call("bellman_start", {
        manifest: manifestFixture({ preset: "swarm" }), brief: brief(), ...(capabilities ? { capabilities } : {}),
      });
      expect(started.isError, started.text).toBe(false);
      return String(started.data.share_instructions);
    };
    const withheld = await instructions(KEEPS);
    expect(withheld).not.toContain("review your brief");
    expect(withheld, "the sentence still names both calls").toContain("they run bellman_connect with the code, then bellman_confirm with their own.");
    for (const text of [await instructions(GRANTS), await instructions()]) {
      expect(text, "granted, or by default").toContain("they run bellman_connect with the code, review your brief, then bellman_confirm with their own.");
    }
  });
});
