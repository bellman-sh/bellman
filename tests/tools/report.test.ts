import { afterEach, describe, expect, it } from "vitest";
import { reportMail, type Report } from "../../src/reports.js";
import { fileRoomReport } from "../../src/rooms.js";
import { NEED_ROOM } from "../../src/tools/kit.js";
import { joinWith, pairUp, publicRoom, type PairedSession } from "../helpers/flows.js";
import { DEV_KEY, Harness } from "../helpers/harness.js";

let h: Harness;
let mailed: Report[];
const mail = async (r: Report): Promise<void> => {
  // A real mailer takes a turn of the event loop, so a call that does not await it returns before the mail lands.
  await new Promise((resolve) => setTimeout(resolve, 0));
  mailed.push(r);
};
const harness = () => {
  mailed = [];
  h = new Harness(undefined, undefined, { mailReport: mail });
  return h;
};
afterEach(async () => {
  await h.close();
});

/** A message the creator sends, and the cursor it got: what a report of a message names. */
async function say(s: PairedSession, text: string): Promise<number> {
  const sent = await s.creator.call("bellman_send", {
    session_id: s.sessionId, member_id: s.creatorMemberId, type: "message", payload: { text },
  });
  expect(sent.isError, sent.text).toBe(false);
  return Number(sent.data.cursor);
}

/**
 * A message from the creator's seat, appended through the store. `bellman_send` refuses a sender with no other
 * active member, so a room whose other members are gone, or that never had one, can only be written to this way.
 */
async function post(sessionId: string, creatorMemberId: string, text: string): Promise<number> {
  const event = await h.store.appendEvent(sessionId, {
    type: "message", fromMemberId: creatorMemberId, fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: { text }, refId: null,
  });
  expect(event).not.toBeNull();
  return event!.cursor;
}

describe("bellman_report (spec §3)", () => {
  it("files a report about a member, mails it once, and folds a repeat without mailing again", async () => {
    const s = await pairUp(harness());
    const out = await s.joiner.call("bellman_report", { session_id: s.sessionId, member_id: s.creatorMemberId, reason: "spam", note: " ads " });
    expect(out.isError, out.text).toBe(false);
    expect(out.data).toEqual({ report_id: expect.stringMatching(/^rpt_/), folded: false });
    const again = await s.joiner.call("bellman_report", { session_id: s.sessionId, member_id: s.creatorMemberId, reason: "spam" });
    expect(again.data).toEqual({ report_id: out.data.report_id, folded: true });
    expect(mailed.map((r) => r.id)).toEqual([out.data.report_id]);
    expect(await h.store.listReports(10)).toMatchObject([{
      sessionId: s.sessionId, target: { kind: "member", memberId: s.creatorMemberId }, reason: "spam", note: "ads",
      subject: { memberId: s.creatorMemberId, userId: "u_jesse", label: "jesse@codenerd" },
      reporterUserId: "u_peer", reporterLabel: "peer@codenerd", creatorId: "u_jesse",
    }]);
  });

  it("reports a message by its cursor, naming its sender, and the room with neither", async () => {
    const s = await pairUp(harness());
    const cursor = await say(s, "buy now");
    expect((await s.joiner.call("bellman_report", { session_id: s.sessionId, cursor, reason: "spam" })).isError).toBe(false);
    expect((await s.joiner.call("bellman_report", { session_id: s.sessionId, reason: "other", note: "the purpose" })).isError).toBe(false);
    const reports = await h.store.listReports(10);
    expect(reports).toHaveLength(2);
    expect(reports.map((r) => r.target)).toEqual(expect.arrayContaining([{ kind: "room" }, { kind: "message", cursor }]));
    expect(reports.find((r) => r.target.kind === "message")?.subject)
      .toEqual({ memberId: s.creatorMemberId, userId: "u_jesse", label: "jesse@codenerd" });
    expect(reports.find((r) => r.target.kind === "room")?.subject).toBeNull();
    expect(mailed.map((r) => r.id).sort()).toEqual(reports.map((r) => r.id).sort());
  });

  it("reports a member who has since left, and a message that member sent", async () => {
    const s = await pairUp(harness());
    const sent = await s.joiner.call("bellman_send", {
      session_id: s.sessionId, member_id: s.joinerMemberId, type: "message", payload: { text: "spam before leaving" },
    });
    expect(sent.isError, sent.text).toBe(false);
    const left = await s.joiner.call("bellman_leave", { session_id: s.sessionId, member_id: s.joinerMemberId });
    expect(left.isError, left.text).toBe(false);
    const byMember = await s.creator.call("bellman_report", { session_id: s.sessionId, member_id: s.joinerMemberId, reason: "spam" });
    const byMessage = await s.creator.call("bellman_report", { session_id: s.sessionId, cursor: sent.data.cursor, reason: "spam" });
    expect([byMember.isError, byMessage.isError], `${byMember.text} ${byMessage.text}`).toEqual([false, false]);
    const aboutJoiner = { memberId: s.joinerMemberId, userId: "u_peer", label: "peer@codenerd" };
    expect((await h.store.listReports(10)).map((r) => r.subject)).toEqual([aboutJoiner, aboutJoiner]);
  });

  it("refuses both member_id and cursor, a cursor with no event, a member the room never seated, and a stranger, filing nothing", async () => {
    const s = await pairUp(harness());
    const cursor = await say(s, "a real message");
    // Both are real here, so naming two targets is the only thing that can refuse the first. Each refusal is
    // read by its words: a handler that threw would also come back as an error result.
    const refusals: [Record<string, unknown>, string][] = [
      [{ member_id: s.creatorMemberId, cursor }, "name a member or a message, not both"],
      [{ cursor: 9_999 }, "no message at that cursor"],
      [{ member_id: "m_nobody" }, "no member with that member_id has been in this room"],
    ];
    for (const [args, words] of refusals) {
      const r = await s.joiner.call("bellman_report", { session_id: s.sessionId, reason: "spam", ...args });
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.text, JSON.stringify(args)).toContain(words);
    }
    const outsider = await h.connect(DEV_KEY.outsider);
    const stranger = await outsider.call("bellman_report", { session_id: s.sessionId, reason: "spam" });
    expect(stranger.isError).toBe(true);
    expect(stranger.text).toContain("no such room, or no member of yours in it");
    expect(await h.store.listReports(10)).toEqual([]);
    expect(mailed).toEqual([]);
    // Each target on its own files: the refusals above were for what they named, not a tool that refuses everything.
    for (const args of [{ member_id: s.creatorMemberId }, { cursor }]) {
      const r = await s.joiner.call("bellman_report", { session_id: s.sessionId, reason: "spam", ...args });
      expect(r.isError, JSON.stringify(args)).toBe(false);
    }
    expect(mailed).toHaveLength(2);
  });

  it("takes the room under either name, and says so when it is given neither", async () => {
    const s = await pairUp(harness());
    const out = await s.joiner.call("bellman_report", { room_id: s.sessionId, reason: "other" });
    expect(out.isError, out.text).toBe(false);
    const neither = await s.joiner.call("bellman_report", { reason: "other" });
    expect(neither.isError).toBe(true);
    expect(neither.text).toContain(NEED_ROOM);
    expect((await h.store.listReports(10)).map((r) => r.sessionId)).toEqual([s.sessionId]);
  });

  it("will not take an event the server wrote as a message, and takes a member's own beside it", async () => {
    const s = await pairUp(harness());
    const system = await h.store.appendEvent(s.sessionId, {
      type: "member_evicted", fromMemberId: "system", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: {}, refId: null,
    });
    expect(system).not.toBeNull();
    const said = await say(s, "from a member");
    const refused = await s.joiner.call("bellman_report", { session_id: s.sessionId, cursor: system!.cursor, reason: "other" });
    expect(refused.isError, refused.text).toBe(true);
    expect(refused.text).toContain("no message at that cursor");
    expect(await h.store.listReports(10)).toEqual([]);
    const taken = await s.joiner.call("bellman_report", { session_id: s.sessionId, cursor: said, reason: "other" });
    expect(taken.isError, taken.text).toBe(false);
    expect(mailed).toHaveLength(1);
  });

  it("turns a stranger away from a private room as it does from a room that is not there, and takes one to a public room", async () => {
    const s = await pairUp(harness());
    const cursor = await say(s, "a real message");
    const outsider = await h.connect(DEV_KEY.outsider);
    const refused = [
      await outsider.call("bellman_report", { session_id: s.sessionId, reason: "spam" }),
      // A target the room has and one it lacks must read alike, or the refusal tells a stranger what the room holds.
      await outsider.call("bellman_report", { session_id: s.sessionId, member_id: s.creatorMemberId, reason: "spam" }),
      await outsider.call("bellman_report", { session_id: s.sessionId, cursor, reason: "spam" }),
      await outsider.call("bellman_report", { session_id: s.sessionId, member_id: "m_nobody", reason: "spam" }),
      await outsider.call("bellman_report", { session_id: "qs_nowhere", reason: "spam" }),
    ];
    expect(refused.map((r) => r.isError)).toEqual([true, true, true, true, true]);
    expect(new Set(refused.map((r) => r.text)).size).toBe(1);
    expect(refused[0].text).toContain("no such room, or no member of yours in it");
    expect(await h.store.listReports(10)).toEqual([]);

    const room = await publicRoom(h);
    const posted = await post(room.sessionId, room.memberId, "buy now");
    expect((await outsider.call("bellman_report", { session_id: room.sessionId, reason: "spam" })).isError).toBe(false);
    expect((await outsider.call("bellman_report", { session_id: room.sessionId, cursor: posted, reason: "spam" })).isError).toBe(false);
    expect((await h.store.listReports(10)).map((r) => r.target.kind).sort()).toEqual(["message", "room"]);
  });

  it("lets a member removed from a public room report what was said past its cut, since the room's log is public", async () => {
    const room = await publicRoom(harness());
    const joiner = await h.connect(DEV_KEY.peer);
    const joined = await joinWith(joiner, room.code);
    expect(joined.isError, joined.text).toBe(false);
    const joinerMemberId = String(joined.data.member_id);
    const removed = await room.creator.call("bellman_evict", { session_id: room.sessionId, member_id: joinerMemberId });
    expect(removed.isError, removed.text).toBe(false);
    const past = await post(room.sessionId, room.memberId, "said about them once they were out");
    // The cut is real, so the report below is refused in a room that is not public (the test after this one).
    const cut = (await h.store.getMember(room.sessionId, joinerMemberId))?.removedAtCursor;
    expect(cut, "the eviction recorded a cut").toBeDefined();
    expect(past).toBeGreaterThan(cut!);
    const out = await joiner.call("bellman_report", { session_id: room.sessionId, cursor: past, reason: "harassment" });
    expect(out.isError, out.text).toBe(false);
    expect(mailed.map((r) => r.target)).toEqual([{ kind: "message", cursor: past }]);
  });

  it("lets a removed member report what it was shown and nothing past its cut, as if there were nothing there, in a room that is not public", async () => {
    const s = await pairUp(harness());
    const shown = await say(s, "before the removal");
    const removed = await s.creator.call("bellman_evict", { session_id: s.sessionId, member_id: s.joinerMemberId });
    expect(removed.isError, removed.text).toBe(false);
    const past = await post(s.sessionId, s.creatorMemberId, "after the removal");
    const report = (cursor: number) => s.joiner.call("bellman_report", { session_id: s.sessionId, cursor, reason: "spam" });
    const atShown = await report(shown);
    const atPast = await report(past);
    const atNothing = await report(9_999);
    expect([atShown.isError, atPast.isError, atNothing.isError]).toEqual([false, true, true]);
    expect(atPast.text).toBe(atNothing.text);
    expect(atPast.text).toContain("no message at that cursor");
    expect((await h.store.listReports(10)).map((r) => r.target)).toEqual([{ kind: "message", cursor: shown }]);
  });

  it("lets a member who left report what was said after it, since leaving cuts nothing", async () => {
    const s = await pairUp(harness());
    const left = await s.joiner.call("bellman_leave", { session_id: s.sessionId, member_id: s.joinerMemberId });
    expect(left.isError, left.text).toBe(false);
    const later = await post(s.sessionId, s.creatorMemberId, "said after the leave");
    const out = await s.joiner.call("bellman_report", { session_id: s.sessionId, cursor: later, reason: "spam" });
    expect(out.isError, out.text).toBe(false);
    expect((await h.store.listReports(10)).map((r) => r.target)).toEqual([{ kind: "message", cursor: later }]);
  });

  it("takes a report about a room that is frozen, and about one that has closed", async () => {
    const frozen = await pairUp(harness());
    const spoken = await say(frozen, "before the plan lapsed");
    await h.store.freezeSession(frozen.sessionId, Date.now());
    const f = await frozen.joiner.call("bellman_report", { session_id: frozen.sessionId, cursor: spoken, reason: "spam" });
    expect(f.isError, f.text).toBe(false);

    const gone = await pairUp(h);
    const heard = await say(gone, "before everyone left");
    for (const who of [gone.joiner, gone.creator]) {
      const memberId = who === gone.joiner ? gone.joinerMemberId : gone.creatorMemberId;
      expect((await who.call("bellman_leave", { session_id: gone.sessionId, member_id: memberId })).isError).toBe(false);
    }
    expect((await h.store.getSession(gone.sessionId))?.closed).toBe(true);
    const c = await gone.joiner.call("bellman_report", { session_id: gone.sessionId, cursor: heard, reason: "spam" });
    expect(c.isError, c.text).toBe(false);
    expect((await h.store.listReports(10)).map((r) => r.sessionId).sort()).toEqual([frozen.sessionId, gone.sessionId].sort());
  });

  /** Review Focus 4, through the tool: the note reaches the mailer as written, and the subject does not carry it. */
  it("stores and mails a note as written, header lookalikes and markup included, under a subject built from closed sets", async () => {
    const s = await pairUp(harness());
    const note = "line one\r\nSubject: forged\r\n<b>bold</b>";
    const out = await s.joiner.call("bellman_report", { session_id: s.sessionId, reason: "harassment", note });
    expect(out.isError, out.text).toBe(false);
    expect(mailed.map((r) => r.note)).toEqual([note]);
    const message = reportMail(mailed[0]);
    expect(message.subject).toBe(`Bellman report ${out.data.report_id}: harassment, the room`);
    expect(message.text).toContain(note);
  });

  it("refuses the eleventh report in a day as rate_limited with retry_after, and files and mails nothing for it", async () => {
    const s = await pairUp(harness());
    const cursors: number[] = [];
    for (let i = 0; i < 10; i++) cursors.push(await say(s, `m${i}`));
    const ids: unknown[] = [];
    for (const cursor of cursors) {
      const out = await s.joiner.call("bellman_report", { session_id: s.sessionId, cursor, reason: "spam" });
      expect(out.isError, out.text).toBe(false);
      ids.push(out.data.report_id);
    }
    const eleventh = await s.joiner.call("bellman_report", { session_id: s.sessionId, reason: "spam" });
    expect(eleventh.isError).toBe(true);
    expect(eleventh.data).toEqual({ error: "rate_limited", retry_after: expect.any(Number) });
    expect(Number(eleventh.data.retry_after)).toBeGreaterThan(86_000);
    expect(Number(eleventh.data.retry_after)).toBeLessThanOrEqual(86_400);
    expect(eleventh.text).toContain("rate_limited");
    expect(mailed.map((r) => r.id)).toEqual(ids);
    expect(await h.store.listReports(50)).toHaveLength(10);
  });
});

describe("fileRoomReport (R11)", () => {
  const file = (s: PairedSession, input: Parameters<typeof fileRoomReport>[3], now?: number) =>
    fileRoomReport(h.store, s.joiner.identity, s.sessionId, input, mail, now);

  it("refuses a reason outside the set, a note over 500 once trimmed, a target named twice and a cursor that is no position, filing and mailing nothing", async () => {
    const s = await pairUp(harness());
    const cursor = await say(s, "a real message");
    // Each refusal is read by its code and its words: a throw is neither, and an input refused for the wrong reason
    // (a cursor of 0 finds no event either) would read the same as one refused for its own.
    const shape = "cursor must be a positive whole number.";
    const refusals: [Parameters<typeof fileRoomReport>[3], string][] = [
      [{ reason: "rude" }, "reason must be one of spam, harassment, impersonation, illegal, other."],
      [{ reason: "spam", note: "x".repeat(501) }, "a note is at most 500 characters."],
      [{ reason: "spam", note: ` ${"x".repeat(501)} ` }, "a note is at most 500 characters."],
      [{ reason: "spam", memberId: s.creatorMemberId, cursor }, "name a member or a message, not both"],
      [{ reason: "spam", memberId: "m_nobody" }, "no member with that member_id has been in this room."],
      [{ reason: "spam", cursor: 9_999 }, "no message at that cursor."],
      [{ reason: "spam", cursor: 0 }, shape],
      [{ reason: "spam", cursor: -3 }, shape],
      [{ reason: "spam", cursor: 1.5 }, shape],
      [{ reason: "spam", cursor: Number.NaN }, shape],
    ];
    const outcomes = [];
    for (const [input] of refusals) outcomes.push(await file(s, input));
    expect(outcomes.map((r) => (r.ok ? "ok" : r.code))).toEqual(refusals.map(() => "invalid"));
    outcomes.forEach((r, i) => expect(r.ok ? "" : r.reason, JSON.stringify(refusals[i][0])).toContain(refusals[i][1]));
    expect(await h.store.listReports(10)).toEqual([]);
    expect(mailed).toEqual([]);
  });

  it("keeps a note trimmed, an empty one as none, and 500 characters exactly", async () => {
    const s = await pairUp(harness());
    const cursor = await say(s, "a real message");
    const made = [
      await file(s, { reason: "spam", note: "   " }),
      await file(s, { reason: "spam", memberId: s.creatorMemberId, note: ` ${"x".repeat(500)} ` }),
      await file(s, { reason: "spam", cursor, note: "  hello  " }),
    ];
    expect(made.map((r) => r.ok)).toEqual([true, true, true]);
    const notes = (await h.store.listReports(10)).map((r) => [r.target.kind, r.note]);
    expect(Object.fromEntries(notes)).toEqual({ room: null, member: "x".repeat(500), message: "hello" });
    expect((await file(s, { reason: "other", note: null })).ok).toBe(true);
  });

  it("rounds the wait up to whole seconds, as a send's does", async () => {
    const s = await pairUp(harness());
    const cursors: number[] = [];
    for (let i = 0; i < 10; i++) cursors.push(await say(s, `m${i}`));
    const t0 = Date.UTC(2026, 9, 15);
    for (const [i, cursor] of cursors.entries()) {
      expect((await file(s, { reason: "spam", cursor }, t0 + i * 1_000)).ok, `filing ${i}`).toBe(true);
    }
    // The oldest filing leaves the window at t0 + 86,400,000 ms: 86,389.1 s from here, which is 86,390 rounded up.
    const limited = await file(s, { reason: "spam" }, t0 + 10_900);
    expect(limited).toEqual({
      ok: false, code: "rate_limited", retryAfter: 86_390, reason: expect.stringMatching(/^rate_limited: .* Try again in 86390 seconds\.$/),
    });
    // Half a second from the window's end is one second, and says "second".
    const nearly = await file(s, { reason: "spam" }, t0 + 86_400_000 - 500);
    expect(nearly).toEqual({
      ok: false, code: "rate_limited", retryAfter: 1, reason: expect.stringMatching(/Try again in 1 second\.$/),
    });
    expect(mailed).toHaveLength(10);
  });
});
