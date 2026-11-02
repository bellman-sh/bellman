/** `bellman_fs` (ADR 0046) through the in-memory MCP client: each op, and every content-bearing result wrapped untrusted. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Harness, type Envelope } from "../helpers/harness.js";
import { pairUp, type PairedSession } from "../helpers/flows.js";

let h: Harness;
let p: PairedSession;
beforeEach(async () => {
  h = new Harness();
  p = await pairUp(h, { joinAs: "peer_a", joinerCapabilities: ["read_context", "receive_messages"] });
});
afterEach(() => h.close());

const fsA = (args: Record<string, unknown>) => p.creator.call("bellman_fs", { session_id: p.sessionId, member_id: p.creatorMemberId, ...args });
const fsB = (args: Record<string, unknown>) => p.joiner.call("bellman_fs", { session_id: p.sessionId, member_id: p.joinerMemberId, ...args });

describe("bellman_fs", () => {
  it("writes, reads back in an untrusted envelope from the writing seat, lists, finds and diffs", async () => {
    const w = await fsA({ op: "write", path: "/plans/launch.md", content: "one\ntwo\n" });
    expect(w.isError, w.text).toBe(false);
    expect(w.data).toEqual({ path: "/plans/launch.md", rev: 1, replayed: false });

    const r = await fsB({ op: "read", path: "/plans/launch.md" });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("UNTRUSTED PEER CONTENT");
    const file = r.data.file as Envelope<{ content: string; rev: number; writer: { member_id: string } }>;
    expect(file.trust).toBe("untrusted");
    expect(file.origin.memberId).toBe(p.creatorMemberId);
    expect(file.data).toMatchObject({ content: "one\ntwo\n", rev: 1 });

    expect((await fsB({ op: "edit", path: "/plans/launch.md", old: "two", new: "TWO", base_rev: 1 })).data).toMatchObject({ rev: 2 });
    const list = await fsA({ op: "list", prefix: "/plans" });
    const entries = list.data.entries as Envelope<{ path: string; rev: number }>[];
    expect(entries.map((e) => [e.trust, e.data.path, e.data.rev, e.origin.memberId])).toEqual([["untrusted", "/plans/launch.md", 2, p.joinerMemberId]]);
    expect(JSON.stringify(list.data)).not.toContain("one\\n");

    const found = await fsA({ op: "find", query: "LAUNCH" });
    expect((found.data.entries as Envelope<{ path: string }>[]).map((e) => e.data.path)).toEqual(["/plans/launch.md"]);
    expect(((await fsA({ op: "find", query: "TWO" })).data.entries as unknown[])).toEqual([]);

    const hist = await fsA({ op: "history", path: "/plans/launch.md", from: 1, to: 2 });
    expect((hist.data.revisions as Envelope<{ rev: number }>[]).map((e) => e.data.rev)).toEqual([2, 1]);
    const diff = hist.data.diff as Envelope<{ diff: string }>;
    expect(diff.trust).toBe("untrusted");
    expect(diff.data.diff).toContain("-two\n+TWO");
  });

  it("refuses a stale write with the current revision and its content, wrapped from its writer", async () => {
    await fsA({ op: "write", path: "/a.md", content: "v1" });
    await fsB({ op: "write", path: "/a.md", content: "v2", base_rev: 1 });
    const stale = await fsA({ op: "append", path: "/a.md", content: "!", base_rev: 1 });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("stale");
    expect(stale.text).toContain("UNTRUSTED PEER CONTENT");
    expect(stale.data).toMatchObject({ error: "stale", current_rev: 2, current: { trust: "untrusted", origin: { memberId: p.joinerMemberId }, data: { content: "v2" } } });
  });

  it("appends, deletes, restores, and replays a retried key", async () => {
    await fsA({ op: "write", path: "/a.md", content: "a", idempotency_key: "k" });
    expect((await fsA({ op: "write", path: "/a.md", content: "a", idempotency_key: "k" })).data).toMatchObject({ rev: 1, replayed: true });
    expect((await fsA({ op: "write", path: "/a.md", content: "b", idempotency_key: "k" })).isError).toBe(true);
    expect((await fsA({ op: "append", path: "/a.md", content: "b", base_rev: 1 })).data).toMatchObject({ rev: 2 });
    expect((await fsA({ op: "restore", path: "/a.md", rev: 1, base_rev: 2 })).data).toMatchObject({ rev: 3 });
    expect(((await fsA({ op: "read", path: "/a.md" })).data.file as Envelope<{ content: string }>).data.content).toBe("a");
    expect((await fsA({ op: "delete", path: "/a.md", base_rev: 3 })).data).toMatchObject({ rev: 4 });
    expect((await fsA({ op: "read", path: "/a.md" })).isError).toBe(true);
  });

  it("keeps memory under /members/me/, readable by a peer while every seat grants read_context", async () => {
    const w = await fsB({ op: "write", path: "/members/me/notes.md", content: "mine" });
    expect(w.isError, w.text).toBe(false);
    const path = String(w.data.path);
    expect(path).toMatch(/^\/members\/[0-9a-f]{16}\/notes\.md$/);
    expect(path).not.toContain("u_");
    expect(((await fsA({ op: "read", path })).data.file as Envelope<{ content: string }>).data.content).toBe("mine");
    expect((await fsA({ op: "write", path, content: "x", base_rev: 1 })).isError).toBe(true);
  });

  it("refuses /.bellman/ writes and names the dash, and says what an op is missing", async () => {
    const bell = await fsA({ op: "write", path: "/.bellman/room.md", content: "x" });
    expect(bell.isError).toBe(true);
    expect(bell.text).toContain("dash");
    expect((await fsA({ op: "read", path: "/.bellman/room.md" })).isError).toBe(false);
    expect((await fsA({ op: "edit", path: "/a.md" })).text).toContain("edit needs old and new");
    expect((await fsA({ op: "history", path: "/a.md", from: 1 })).text).toContain("both from and to");
  });
});
