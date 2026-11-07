/**
 * The join reply inside one budget (ADR 0047 decision 9, #528): at most CONFIRM_REPLY_CHARS as rendered, the
 * surface cut first with `next` for the rest, briefs second, the room and its instructions never, and the joiner's
 * home-note paths in `recall`, read after the seat commits and never failing the join.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEV_KEY, Harness, type Peer } from "../helpers/harness.js";
import { brief, member, swarmSession } from "../helpers/fixtures.js";
import { BRIEFS_ON_JOIN, CONFIRM_REPLY_CHARS, RECALL_CHARS } from "../../src/tools/confirm.js";
import { HOME_MEMBER_ID, homeRoomId, homeSession } from "../../src/files/home.js";
import type { SeededMember } from "../helpers/fixtures.js";

let h: Harness;
beforeEach(() => { h = new Harness(); });
afterEach(async () => { await h.close(); });

interface Block { items: { data: { key: string } }[]; next: string | null }
interface Reply { surface: Block; briefs: unknown[]; briefs_omitted: number; recall: { home: string[]; home_omitted: number }; members: { member_id: string; presence: string }[]; room_instructions?: { data: { content: string } } }

/** A room seeded from `members`, with `n` cards of `body` on its surface, written by the first member. */
async function roomWith(members: SeededMember[], n: number, body: string): Promise<string> {
  const seeded = swarmSession({ members });
  await h.store.createSession(seeded);
  const by = members[0];
  for (let i = 0; i < n; i++) {
    const item = {
      key: `s${String(i).padStart(3, "0")}`, kind: "text" as const, title: null, body, ends: null,
      placement: { x: 100_000 + (i % 10) * 400, y: 100_000 + Math.floor(i / 10) * 300 }, blob: null, shape: null,
    };
    await h.store.appendEvent(seeded.id, {
      type: "surface", fromMemberId: by.memberId, fromUserId: by.userId, fromLabel: by.label, payload: item, refId: null,
    }, { surface: { key: item.key, item } });
  }
  return seeded.id;
}

async function join(joiner: Peer): Promise<{ text: string; data: Reply }> {
  const preview = await joiner.call("bellman_connect", { join_code: "BELL-TEST-01" });
  expect(preview.isError, preview.text).toBe(false);
  const joined = await joiner.call("bellman_confirm", { connect_token: String(preview.data.connect_token), brief: brief({ goal: "the joiner's" }) });
  expect(joined.isError, joined.text).toBe(false);
  return { text: joined.text, data: joined.data as unknown as Reply };
}

const peers = (n: number, state = "where things stand") => Array.from({ length: n }, (_, i) => member({
  memberId: `m_${String(i).padStart(2, "0")}`, userId: `u_member_${i}`, roomRole: "peer_b",
  brief: brief({ goal: `member ${i}`, state }), joinedAt: Date.now() - 100_000, lastSeenAt: Date.now() - i * 1000,
}));

describe("the join reply's budget", () => {
  it("cuts the surface first: a big surface comes back under the ceiling, and next pages the rest through bellman_surface", async () => {
    const id = await roomWith(peers(1), 60, "x".repeat(3_000));
    const joiner = await h.connect(DEV_KEY.outsider);
    const { text, data } = await join(joiner);
    expect(text.length).toBeLessThanOrEqual(CONFIRM_REPLY_CHARS);
    expect(data.surface.items.length).toBeGreaterThan(0);
    expect(data.surface.items.length).toBeLessThan(60);
    expect(data.briefs.length, "the surface is cut before any brief").toBe(1);

    const seen = new Set(data.surface.items.map((i) => i.data.key));
    let next = data.surface.next;
    while (next !== null) {
      const page = await joiner.call("bellman_surface", { session_id: id, next });
      expect(page.isError, page.text).toBe(false);
      const block = page.data.surface as Block;
      for (const i of block.items) seen.add(i.data.key);
      next = block.next;
    }
    expect(seen.size, "every card is read, between the join and the pages after it").toBe(60);
  });

  it("cuts briefs second, once the surface is down to nothing, and counts them in briefs_omitted", async () => {
    await roomWith(peers(BRIEFS_ON_JOIN + 5, "s".repeat(2_000)), 5, "y".repeat(3_000));
    const { text, data } = await join(await h.connect(DEV_KEY.outsider));
    expect(text.length).toBeLessThanOrEqual(CONFIRM_REPLY_CHARS);
    expect(data.surface.items, "nothing of the surface rides before a brief is cut").toEqual([]);
    expect(data.surface.next).toEqual(expect.any(String));
    expect(data.briefs.length).toBeGreaterThan(0);
    expect(data.briefs.length).toBeLessThan(BRIEFS_ON_JOIN);
    expect(data.briefs_omitted).toBe(BRIEFS_ON_JOIN + 5 - data.briefs.length);
  });

  it("never cuts the room's instructions, and still answers under the ceiling by cutting below them", async () => {
    const id = await roomWith(peers(BRIEFS_ON_JOIN, "s".repeat(2_000)), 5, "y".repeat(3_000));
    const markdown = "Be terse. ".repeat(300);
    await h.store.writeConfig(id, {
      name: "room_instructions", body: { markdown }, sha256: "h", bytes: markdown.length, baseRev: 0, narrowing: false,
      governance: { approvedBy: "u_member_0", approverMemberId: "m_00", approverLabel: "member 0", via: "dash_session", at: "2026-11-01T00:00:00.000Z" },
    }, []);
    const { text, data } = await join(await h.connect(DEV_KEY.outsider));
    expect(text.length).toBeLessThanOrEqual(CONFIRM_REPLY_CHARS);
    expect(data.room_instructions?.data.content).toBe(markdown);
  });

  it("lists present members first", async () => {
    const stale = member({ memberId: "m_stale", userId: "u_stale", roomRole: "peer_b", lastSeenAt: Date.now() - 20 * 60_000 });
    const live = member({ memberId: "m_live", userId: "u_live", roomRole: "peer_b", lastSeenAt: Date.now() });
    await roomWith([stale, live], 0, "");
    const { data } = await join(await h.connect(DEV_KEY.outsider));
    expect(data.members.map((m) => m.presence)).toEqual(["present", "present", "stale"]);
    expect(data.members[0].member_id).toBe("m_live");
  });
});

describe("recall on arrival", () => {
  it("hands the joiner its own home-note paths, newest first, and a joiner with none an empty list", async () => {
    await roomWith(peers(1), 0, "");
    const joiner = await h.connect(DEV_KEY.outsider);
    for (const [i, path] of ["/notes/a.md", "/notes/b.md", "/notes/c.md"].entries()) {
      await h.store.writeHome(homeRoomId(joiner.identity.userId), homeSession(joiner.identity, 1_000 + i), {
        path, write: { op: "write", content: `note ${i}` }, memberId: HOME_MEMBER_ID, userId: joiner.identity.userId, label: joiner.identity.label, key: null,
      }, 1 << 20);
    }
    const { data } = await join(joiner);
    expect(data.recall.home.sort()).toEqual(["/notes/a.md", "/notes/b.md", "/notes/c.md"]);
    expect(data.recall.home_omitted).toBe(0);

    const other = await h.connect(DEV_KEY.peer);
    const preview = await other.call("bellman_connect", { join_code: "BELL-TEST-01" });
    const joined = await other.call("bellman_confirm", { connect_token: String(preview.data.connect_token), brief: brief() });
    expect(joined.isError, joined.text).toBe(false);
    expect(joined.data.recall, "no home room yet, and no home room is created by a join").toEqual({ home: [], home_omitted: 0 });
    expect(await h.store.getSession(homeRoomId(other.identity.userId))).toBeUndefined();
  });

  it("keeps recall under its own ceiling and counts the paths left out", async () => {
    await roomWith(peers(1), 0, "");
    const joiner = await h.connect(DEV_KEY.outsider);
    const long = `/notes/${"p".repeat(190)}`;
    for (let i = 0; i < 40; i++) {
      await h.store.writeHome(homeRoomId(joiner.identity.userId), homeSession(joiner.identity, 1_000), {
        path: `${long}-${String(i).padStart(2, "0")}.md`, write: { op: "write", content: "x" }, memberId: HOME_MEMBER_ID,
        userId: joiner.identity.userId, label: joiner.identity.label, key: null,
      }, 1 << 20);
    }
    const { data } = await join(joiner);
    expect(JSON.stringify(data.recall, null, 2).length).toBeLessThanOrEqual(RECALL_CHARS);
    expect(data.recall.home.length).toBeGreaterThan(0);
    expect(data.recall.home.length + data.recall.home_omitted).toBe(40);
  });

  it("never fails the join when the home room cannot be read", async () => {
    await roomWith(peers(1), 0, "");
    const joiner = await h.connect(DEV_KEY.outsider);
    const errors: unknown[] = [];
    const quiet = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    h.store.listFs = async () => { throw new Error("home unreachable"); };
    try {
      const { data } = await join(joiner);
      expect(data.recall).toEqual({ home: [], home_omitted: 0 });
      expect(data.members.map((m) => m.member_id)).toContain("m_00");
    } finally {
      console.error = quiet;
    }
    expect(errors.length).toBe(1);
  });
});
