/**
 * `bellman_memory` (ADR 0047) through the in-memory MCP client: the CUJ "remember in room A, recall in room B from
 * another client", a peer that cannot reach it by any tool, and every content-bearing result wrapped untrusted.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEV_KEY, Harness, type Envelope } from "../helpers/harness.js";
import { pairUp, type PairedSession } from "../helpers/flows.js";

let h: Harness;
let p: PairedSession;
beforeEach(async () => {
  h = new Harness();
  p = await pairUp(h, { joinAs: "peer_a", joinerCapabilities: ["read_context", "receive_messages"] });
});
afterEach(() => h.close());

describe("bellman_memory", () => {
  it("remembers from one room's seat and recalls from another client with no room at all, wrapped from the account", async () => {
    const w = await p.creator.call("bellman_memory", { op: "remember", path: "/conventions/git.md", content: "squash merges" });
    expect(w.isError, w.text).toBe(false);
    expect(w.data).toEqual({ path: "/conventions/git.md", rev: 1, replayed: false });

    const other = await h.connect(DEV_KEY.jesse);
    const r = await other.call("bellman_memory", { op: "recall", path: "/conventions/git.md" });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("UNTRUSTED PEER CONTENT");
    const file = r.data.file as Envelope<{ content: string; rev: number }>;
    expect(file.trust).toBe("untrusted");
    expect(file.origin).toEqual({ memberId: "home", label: p.creator.identity.label });
    expect(file.data).toMatchObject({ content: "squash merges", rev: 1 });

    const list = await other.call("bellman_memory", { op: "recall" });
    const entries = list.data.entries as Envelope<{ path: string }>[];
    expect(entries.map((e) => e.data.path)).toEqual(["/conventions/git.md"]);
    expect(JSON.stringify(list.data)).not.toContain("squash");
    expect(list.data.next).toBeNull();
  });

  it("keeps a peer out: its own memory is empty, and the room's files hold nothing of the note", async () => {
    await p.creator.call("bellman_memory", { op: "remember", path: "/secret.md", content: "the plan" });
    const mine = await p.joiner.call("bellman_memory", { op: "recall" });
    expect(mine.data.entries).toEqual([]);
    expect((await p.joiner.call("bellman_memory", { op: "recall", path: "/secret.md" })).isError).toBe(true);
    const files = await p.joiner.call("bellman_fs", { session_id: p.sessionId, member_id: p.joinerMemberId, op: "list" });
    expect(files.data.entries).toEqual([]);
    expect((await p.joiner.call("bellman_fs", { session_id: p.sessionId, member_id: p.joinerMemberId, op: "find", query: "secret" })).data.entries).toEqual([]);
  });

  it("refuses a stale write with the note as it is, forgets at base_rev, and says what an op is missing", async () => {
    await p.creator.call("bellman_memory", { op: "remember", path: "/a.md", content: "v1" });
    const stale = await p.creator.call("bellman_memory", { op: "remember", path: "/a.md", content: "v2" });
    expect(stale.isError).toBe(true);
    expect(stale.data).toMatchObject({ error: "stale", current_rev: 1, current: { trust: "untrusted", origin: { memberId: "home" }, data: { content: "v1" } } });
    expect((await p.creator.call("bellman_memory", { op: "forget", path: "/a.md" })).text).toContain("forget needs base_rev");
    expect((await p.creator.call("bellman_memory", { op: "forget", path: "/a.md", base_rev: 1 })).data).toMatchObject({ path: "/a.md", rev: 2 });
    expect((await p.creator.call("bellman_memory", { op: "recall", path: "/a.md" })).isError).toBe(true);
    expect((await p.creator.call("bellman_memory", { op: "share", path: "/a.md" })).text).toContain("session_id is required");
  });

  it("shares a note into a room as the seat's own memory, which a peer granted read_context then reads", async () => {
    await p.creator.call("bellman_memory", { op: "remember", path: "/conventions/git.md", content: "squash merges" });
    const shared = await p.creator.call("bellman_memory", { op: "share", session_id: p.sessionId, member_id: p.creatorMemberId, path: "/conventions/git.md", to: "notes" });
    expect(shared.isError, shared.text).toBe(false);
    const path = String(shared.data.path);
    expect(path).toMatch(/^\/members\/[0-9a-f]{16}\/conventions\/git\.md$/);
    const read = await p.creator.call("bellman_fs", { session_id: p.sessionId, member_id: p.creatorMemberId, op: "read", path });
    expect((read.data.file as Envelope<{ content: string }>).data.content).toBe("squash merges");
  });
});
