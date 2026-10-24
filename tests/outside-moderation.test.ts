/**
 * Moderating an outside asker (A2A, Task 6): a creator bans the account behind an outside_question by the question's
 * cursor, and reports one the same way. The asker is a stranger with no member_id, so the cursor is the only handle a
 * creator holds, and nothing that comes back may name the account or the label it signed in with.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { askRoom, type Caller } from "../src/outside.js";
import { creatorReportView, operatorReportView } from "../src/reports.js";
import { banAsker, evictMember } from "../src/rooms.js";
import type { Identity } from "../src/types.js";
import { publicRoom } from "./helpers/flows.js";
import { DEV_KEY, Harness, type Peer } from "./helpers/harness.js";

const jesse: Identity = { userId: "u_jesse", orgId: "org_codenerd", plan: "team", role: "admin", label: "jesse@codenerd" };
const peer: Identity = { userId: "u_peer", orgId: "org_codenerd", plan: "free", role: "member", label: "peer@codenerd" };
const asker: Caller = { userId: "u_out1", label: "out1@elsewhere" };

let h: Harness;
let room: { creator: Peer; sessionId: string; memberId: string; code: string };
let cursor: number;

const ask = (c: Caller = asker, into = room.sessionId) => askRoom(h.store, into, c, { text: "what is this room for?" });

beforeEach(async () => {
  h = new Harness();
  room = await publicRoom(h);
  const first = await ask();
  if (!first.ok) throw new Error(`the ask was refused: ${first.error}`);
  cursor = first.task.questionCursors[0];
});
afterEach(async () => {
  await h.close();
});

describe("banning an asker by question cursor", () => {
  it("creator bans an asker by question cursor; their next ask is banned", async () => {
    const r = await banAsker(h.store, jesse, room.sessionId, cursor, "room");

    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await ask()).toEqual({ ok: false, error: "banned" });
    expect(await ask({ userId: "u_out2", label: "out2@elsewhere" })).toMatchObject({ ok: true });
  });

  it("ban scope all blocks the asker in the creator's other public rooms", async () => {
    const other = await publicRoom(h);
    expect(await ask(asker, other.sessionId)).toMatchObject({ ok: true });

    await banAsker(h.store, jesse, room.sessionId, cursor, "all");

    expect(await ask(asker, other.sessionId)).toEqual({ ok: false, error: "banned" });
  });

  it("a non-creator can't ban an asker", async () => {
    const refused = await banAsker(h.store, peer, room.sessionId, cursor, "room");
    const evicting = await evictMember(h.store, peer, room.sessionId, room.memberId, "room");

    expect(refused).toEqual(evicting);
    expect(refused.ok).toBe(false);
    expect(await ask()).toMatchObject({ ok: true });
  });

  it("a cursor that is not an outside question in this room is refused, and bans no one", async () => {
    const other = await publicRoom(h);
    const elsewhere = await ask(asker, other.sessionId);
    if (!elsewhere.ok) throw new Error("ask refused");

    const notAQuestion = await banAsker(h.store, jesse, room.sessionId, cursor + 100, "room");
    const wrongRoom = await banAsker(h.store, jesse, room.sessionId, elsewhere.task.questionCursors[0] + 100, "room");

    expect(notAQuestion).toEqual({ ok: false, code: "invalid", reason: "no outside question at that cursor." });
    expect(wrongRoom).toEqual(notAQuestion);
    expect(await ask()).toMatchObject({ ok: true });
  });

  it("the ban response never contains the caller's label or userId", async () => {
    const r = await banAsker(h.store, jesse, room.sessionId, cursor, "all");

    expect(r).toEqual({ ok: true, value: { origin: "visitor 1", banned: "all" } });
    const text = JSON.stringify(r);
    expect(text).not.toContain("out1@elsewhere");
    expect(text).not.toContain("u_out1");
  });

  it("bellman_evict takes exactly one of member_id and question_cursor", async () => {
    const base = { session_id: room.sessionId };
    const both = await room.creator.call("bellman_evict", { ...base, member_id: room.memberId, question_cursor: cursor });
    const neither = await room.creator.call("bellman_evict", base);
    const unscoped = await room.creator.call("bellman_evict", { ...base, question_cursor: cursor });
    const banned = await room.creator.call("bellman_evict", { ...base, question_cursor: cursor, ban: "room" });

    expect(both.isError).toBe(true);
    expect(neither.isError).toBe(true);
    expect(unscoped.isError).toBe(true);
    expect(banned.isError, banned.text).toBe(false);
    expect(banned.data).toEqual({ origin: "visitor 1", banned: "room" });
    expect(await ask()).toEqual({ ok: false, error: "banned" });
  });
});

describe("reporting an outside question", () => {
  it("bellman_report on a question cursor files a report whose subject has origin and no memberId", async () => {
    const reporter = await h.connect(DEV_KEY.peer);

    const out = await reporter.call("bellman_report", { session_id: room.sessionId, cursor, reason: "spam" });

    expect(out.isError, out.text).toBe(false);
    const [report] = await h.store.listReports(10);
    expect(report.target).toEqual({ kind: "message", cursor });
    expect(report.subject).toEqual({ questionCursor: cursor, origin: "visitor 1", userId: "u_out1" });
    expect(report.subject).not.toHaveProperty("memberId");
    // What the creator reads has the origin and no account; staff read the account too.
    expect(creatorReportView(report).about).toEqual({ question_cursor: cursor, origin: "visitor 1" });
    expect(JSON.stringify(creatorReportView(report))).not.toMatch(/u_out1|out1@elsewhere/);
    expect(operatorReportView(report).about).toEqual({ question_cursor: cursor, origin: "visitor 1", user_id: "u_out1" });
  });
});
