/**
 * Home memory (ADR 0047) through `src/files/memory.ts` against a `MemoryStore`: the home room's id and record, each write
 * outcome, the plan ceiling read on each write, the account's own send bucket, and that nothing of a home room is a
 * room. The tool is tested over these in tests/tools/memory.test.ts.
 */
import { describe, expect, it } from "vitest";
import { ENTITLEMENTS } from "../src/auth.js";
import { HOME_MEMBER_ID, homeRoomId, homeSession, isHomeRoomId } from "../src/files/home.js";
import { listHome, readHome, shareHome, writeHome } from "../src/files/memory.js";
import { SEND_LIMIT } from "../src/room/send-limit.js";
import { MemoryStore } from "../src/storage/memory-store.js";
import type { Identity } from "../src/types.js";
import { member, session } from "./helpers/fixtures.js";

const who = (userId: string, plan: Identity["plan"] = "free"): Identity => ({ userId, label: `${userId}@x`, orgId: null, plan, role: "member" });
const A = who("u_a"), B = who("u_b");
const put = (store: MemoryStore, actor: Identity, path: string, content: string, baseRev?: number, idempotencyKey?: string) =>
  writeHome(store, actor, { path, write: { op: "write", content, baseRev }, idempotencyKey });

describe("the home room's id", () => {
  it("is qh_ and 32 hex characters, the same for one account every time and different for another", () => {
    const id = homeRoomId("u_a");
    expect(id).toMatch(/^qh_[0-9a-f]{32}$/);
    expect(homeRoomId("u_a")).toBe(id);
    expect(homeRoomId("u_b")).not.toBe(id);
    expect(isHomeRoomId(id)).toBe(true);
    expect(isHomeRoomId("qs_" + id.slice(3))).toBe(false);
  });

  it("describes a record with one seat, no codes and kind home", () => {
    const home = homeSession(A, 1);
    expect(home.kind).toBe("home");
    expect(home.joinCodes).toEqual({});
    expect(home.members.map((m) => [m.memberId, m.userId, m.capabilities])).toEqual([[HOME_MEMBER_ID, "u_a", []]]);
    expect(home.manifest.roles.owner.can).toEqual([]);
  });
});

describe("remember, recall and forget", () => {
  it("creates the home room on the first write, reads the note back and lists newest first", async () => {
    const store = new MemoryStore();
    expect(await listHome(store, A, "/")).toEqual({ ok: true, value: { entries: [], next: null } });
    expect(await put(store, A, "/conventions/git.md", "squash")).toEqual({ ok: true, value: { path: "/conventions/git.md", rev: 1, replayed: false } });
    await new Promise((r) => setTimeout(r, 2));
    expect(await put(store, A, "/people/b.md", "likes tea")).toMatchObject({ ok: true, value: { rev: 1 } });
    const read = await readHome(store, A, "/conventions/git.md");
    expect(read).toMatchObject({ ok: true, value: { content: "squash", rev: 1, writerMemberId: HOME_MEMBER_ID, writerLabel: "u_a@x" } });
    const all = await listHome(store, A, "/");
    expect(all.ok && all.value.entries.map((e) => e.path)).toEqual(["/people/b.md", "/conventions/git.md"]);
    const some = await listHome(store, A, "/conventions");
    expect(some.ok && some.value.entries.map((e) => e.path)).toEqual(["/conventions/git.md"]);
  });

  it("refuses a stale write with the current revision and content, and forgets at the right revision only", async () => {
    const store = new MemoryStore();
    await put(store, A, "/a.md", "v1");
    expect(await put(store, A, "/a.md", "v2")).toMatchObject({ ok: false, code: "stale", state: { current_rev: 1, content: "v1" } });
    expect(await put(store, A, "/a.md", "v2", 1)).toMatchObject({ ok: true, value: { rev: 2 } });
    expect(await writeHome(store, A, { path: "/a.md", write: { op: "delete", baseRev: 1 } })).toMatchObject({ ok: false, code: "stale" });
    expect(await writeHome(store, A, { path: "/a.md", write: { op: "delete", baseRev: 2 } })).toMatchObject({ ok: true, value: { rev: 3 } });
    expect(await readHome(store, A, "/a.md")).toMatchObject({ ok: false, code: "not_found" });
    expect(await listHome(store, A, "/")).toEqual({ ok: true, value: { entries: [], next: null } });
  });

  it("replays a retried key and refuses the same key with other content", async () => {
    const store = new MemoryStore();
    expect(await put(store, A, "/a.md", "x", undefined, "k")).toMatchObject({ ok: true, value: { rev: 1, replayed: false } });
    expect(await put(store, A, "/a.md", "x", undefined, "k")).toMatchObject({ ok: true, value: { rev: 1, replayed: true } });
    expect(await put(store, A, "/a.md", "y", undefined, "k")).toMatchObject({ ok: false, code: "conflict" });
  });

  it("refuses /apps/ and a bad path, and treats /members/ as a plain directory", async () => {
    const store = new MemoryStore();
    expect(await put(store, A, "/apps/x/index.html", "<p>")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await put(store, A, "../x", "y")).toMatchObject({ ok: false, code: "invalid" });
    expect(await put(store, A, "/members/me/notes.md", "n")).toMatchObject({ ok: true, value: { path: "/members/me/notes.md", rev: 1 } });
  });

  it("reads the ceiling from the caller's plan on each write, so an upgrade applies at once", async () => {
    const store = new MemoryStore();
    const free = ENTITLEMENTS.free.homeMemoryBytes;
    const big = "x".repeat(60 * 1024);
    let used = 0;
    while (used + big.length <= free) {
      expect(await put(store, A, `/n${used}.md`, big)).toMatchObject({ ok: true });
      used += big.length;
    }
    const over = await put(store, A, "/one-more.md", big);
    expect(over).toMatchObject({ ok: false, code: "over_quota", state: { used, ceiling: free } });
    expect(await put(store, who("u_a", "pro"), "/one-more.md", big)).toMatchObject({ ok: true });
    expect(ENTITLEMENTS.pro.homeMemoryBytes).toBe(50 * 1024 * 1024);
    expect(ENTITLEMENTS.max.homeMemoryBytes).toBe(200 * 1024 * 1024);
    expect(ENTITLEMENTS.team.homeMemoryBytes).toBe(200 * 1024 * 1024);
  });

  it("counts home writes against the account's own bucket, apart from its seats'", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < SEND_LIMIT; i++) expect(await put(store, A, `/n${i}.md`, "x")).toMatchObject({ ok: true });
    expect(await put(store, A, "/late.md", "x")).toMatchObject({ ok: false, code: "rate_limited" });
    expect(await put(store, B, "/fine.md", "x")).toMatchObject({ ok: true });
  });
});

describe("a home room is not a room", () => {
  it("is not read by getSession, listed for its account, or seen by another account", async () => {
    const store = new MemoryStore();
    await put(store, A, "/a.md", "mine");
    const id = homeRoomId("u_a");
    expect(await store.getSession(id)).toBeUndefined();
    expect(await store.sessionsCreatedBy("u_a", 10)).toEqual([]);
    expect(await store.sessionsJoinedBy("u_a", 10)).toEqual([]);
    expect(await store.eventsAfter(id, 0)).toEqual([]);
    expect(await readHome(store, B, "/a.md")).toMatchObject({ ok: false, code: "not_found" });
    expect(await listHome(store, B, "/")).toEqual({ ok: true, value: { entries: [], next: null } });
  });
});

describe("share to notes", () => {
  it("copies a home note to /members/me/ in a room from the caller's seat, over the current revision", async () => {
    const store = new MemoryStore();
    await store.createSession(session({ id: "qs_share", members: [member({ memberId: "m_a", userId: "u_a", label: "u_a@x", orgId: null })] }));
    await put(store, A, "/conventions/git.md", "squash");
    expect(await shareHome(store, A, "qs_share", "m_a", "/conventions/git.md")).toMatchObject({ ok: true, value: { rev: 1 } });
    const shared = await shareHome(store, A, "qs_share", "m_a", "/conventions/git.md");
    expect(shared).toMatchObject({ ok: true, value: { rev: 2 } });
    expect(shared.ok && shared.value.path).toMatch(/^\/members\/[0-9a-f]{16}\/conventions\/git\.md$/);
    expect(await shareHome(store, A, "qs_share", "m_a", "/missing.md")).toMatchObject({ ok: false, code: "not_found" });
    expect(await shareHome(store, A, "qs_share", "m_b", "/conventions/git.md")).toMatchObject({ ok: false, code: "forbidden" });
  });
});
