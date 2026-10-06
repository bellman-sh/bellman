/**
 * `progress`: a member's answer to the room's heartbeat tick (#111).
 *
 * The sixth send kind, and it takes the `send` verb, so a seat that may not speak
 * may not report either. What it adds to a message is one stamp on the member,
 * `lastReportAt`, which is what a later tick reads to decide who has gone silent.
 * The payload shape is closed (ProgressShape in server.ts), so most of this file
 * is the ways a payload is refused, and what a refusal leaves behind: nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Harness, DEV_KEY } from "../helpers/harness.js";
import { brief } from "../helpers/fixtures.js";
import { pairUp, type PairedSession } from "../helpers/flows.js";
import { snapshotOf } from "../../src/heartbeat.js";

let h: Harness;

beforeEach(() => { h = new Harness(); });
afterEach(async () => { await h.close(); vi.useRealTimers(); });

/** The creator answering the tick, with whatever payload and extra args a case needs. */
const report = (p: PairedSession, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  p.creator.call("bellman_send", {
    session_id: p.sessionId, member_id: p.creatorMemberId, type: "progress", payload, ...extra,
  });

const creatorRow = async (p: PairedSession) =>
  (await h.store.getSession(p.sessionId))!.members.find((m) => m.memberId === p.creatorMemberId)!;

const eventCount = async (p: PairedSession) => (await h.store.eventsAfter(p.sessionId, 0)).length;

describe("bellman_send type=progress", () => {
  it("appends an event and stamps lastReportAt", async () => {
    const p = await pairUp(h);
    const out = await report(p, { note: "ran migration 0042", step: "3 of 7" });
    expect(out.isError, out.text).toBe(false);

    const events = await h.store.eventsAfter(p.sessionId, 0);
    expect(events.at(-1)).toMatchObject({
      type: "progress",
      fromMemberId: p.creatorMemberId,
      payload: { note: "ran migration 0042", step: "3 of 7" },
    });

    const me = await creatorRow(p);
    expect(me.lastReportAt).toBe(events.at(-1)!.at);
  });

  it("refuses a payload with any key the shape does not name", async () => {
    const p = await pairUp(h);
    const before = await eventCount(p);
    for (const bad of [
      { note: "x", status: "working" },
      { note: "x", alive: true },
      { note: "x", present: true },
      { note: "x", healthy: true },
      { note: "x", state: "busy" },
    ]) {
      const out = await report(p, bad);
      expect(out.isError, JSON.stringify(bad)).toBe(true);
      // Refused by the shape, and not by something else that would refuse any progress.
      expect(out.text).toContain("progress payload must be");
    }
    // A refusal leaves nothing behind: no event, and no stamp.
    expect(await eventCount(p)).toBe(before);
    expect((await creatorRow(p)).lastReportAt).toBeUndefined();
  });

  it("requires a note, and bounds it", async () => {
    const p = await pairUp(h);
    const before = await eventCount(p);
    for (const bad of [{}, { note: "" }, { note: "x".repeat(501) }, { note: 7 }]) {
      const out = await report(p, bad);
      expect(out.isError, JSON.stringify(bad).slice(0, 40)).toBe(true);
      expect(out.text).toContain("progress payload must be");
    }
    expect(await eventCount(p)).toBe(before);
    expect((await creatorRow(p)).lastReportAt).toBeUndefined();
  });

  /** The bounds ProgressShape states, at the edge: one past each is refused, the edge is not. */
  it.each([
    ["a note at the 500-character cap", { note: "n".repeat(500) }],
    ["a step at the 40-character cap", { note: "x", step: "s".repeat(40) }],
    ["an eta of zero", { note: "x", eta_seconds: 0 }],
    ["an eta at the one-day cap", { note: "x", eta_seconds: 86_400 }],
  ])("accepts %s", async (_label, payload) => {
    const out = await report(await pairUp(h), payload);
    expect(out.isError, out.text).toBe(false);
  });

  it.each([
    ["a step past 40 characters", { note: "x", step: "s".repeat(41) }],
    ["a negative eta", { note: "x", eta_seconds: -1 }],
    ["a fractional eta", { note: "x", eta_seconds: 1.5 }],
    ["an eta past one day", { note: "x", eta_seconds: 86_401 }],
  ])("refuses %s", async (_label, payload) => {
    const out = await report(await pairUp(h), payload);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("progress payload must be");
  });

  /** A seat that may not speak may not report either — brief_update's reasoning. */
  it("needs the send verb", async () => {
    // The swarm preset's observer holds no verbs at all.
    const p = await pairUp(h, { manifest: { room: "watchers", preset: "swarm" }, joinAs: "observer" });
    const out = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId, type: "progress",
      payload: { note: "watching" },
    });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/does not hold the verb "send"/);
  });

  /**
   * A retry of a send that already landed must not undo a later report. The stamp
   * is the event's own time, so applying it twice would move lastReportAt back to
   * the first send's — and a tick would then ask a member that had answered.
   *
   * What holds it is `creditReport`'s monotonicity, in src/store.ts, and NOT a
   * skipped patch: the replay credits, deliberately, because a caller retrying
   * cannot know whether the first attempt landed the stamp. Break the `was >= at`
   * guard and this case goes red, which is what pins the credit as reaching the
   * store on the replay path at all.
   */
  it("does not move lastReportAt backwards when an earlier send is replayed", async () => {
    const p = await pairUp(h);
    vi.useFakeTimers({ toFake: ["Date"] });
    const clock = (ms: number) => vi.setSystemTime(Date.now() + ms);

    clock(60_000);
    const first = await report(p, { note: "first" }, { idempotency_key: "progress-key-0001" });
    expect(first.isError, first.text).toBe(false);
    clock(60_000);
    const second = await report(p, { note: "second" }, { idempotency_key: "progress-key-0002" });
    expect(second.isError, second.text).toBe(false);
    const stamped = (await creatorRow(p)).lastReportAt!;

    clock(60_000);
    const replay = await report(p, { note: "first" }, { idempotency_key: "progress-key-0001" });
    expect(replay.data.replayed).toBe(true);
    expect((await creatorRow(p)).lastReportAt).toBe(stamped);
  });
});

/**
 * A room that ticks with one member in it. The shape is not exotic: a cadence and
 * a reporting `creator_role` is the ONE shape armed at creation, so it is the
 * first room any author of this feature builds, and it is alone for as long as it
 * takes somebody to use the join code.
 */
const lonelyTickingRoom = async (h: Harness) => {
  const creator = await h.connect(DEV_KEY.jesse);
  const started = await creator.call("bellman_start", {
    brief: brief(),
    manifest: {
      room: "migration-swarm",
      mode: "swarm",
      // Every verb, so a refusal below is the lone-member guard's and not the
      // verb check's — that check runs first, and two of these cases never
      // reached the guard at all while `lead` held only send and invite.
      roles: {
        lead: {
          can: ["send", "invite", "request_actions", "respond_actions"],
          reports: true,
        },
        helper: { can: ["send"] },
      },
      default_role: "helper",
      creator_role: "lead",
      heartbeat_on: "5m",
    },
  });
  expect(started.isError, started.text).toBe(false);
  return {
    creator,
    sessionId: String(started.data.session_id),
    memberId: String(started.data.member_id),
  };
};

describe("a member alone in a ticking room", () => {
  /**
   * The server asks, so the server must accept the answer.
   *
   * The tick interrupts this member with snapshotOf's ask every cadence whether or
   * not anyone else has joined — D7 makes the cadence observable rather than
   * conditional on an audience, because the startup window is exactly when a human
   * wants to know the lone agent is alive. bellman_send's lone-member guard sat
   * above every per-type branch and caught the reply, so the tick and the refusal
   * repeated every cadence, forever.
   */
  it("may answer the tick with no peer in the room", async () => {
    const { creator, sessionId, memberId } = await lonelyTickingRoom(h);
    const out = await creator.call("bellman_send", {
      session_id: sessionId, member_id: memberId, type: "progress",
      payload: { note: "still resolving the manifest" },
    });
    expect(out.isError, out.text).toBe(false);
    // An empty room, said plainly rather than by refusing the send.
    expect(out.data.room_members).toEqual([]);

    // And the stamp landed, so the next tick has something to read.
    const me = (await h.store.getSession(sessionId))!.members
      .find((m) => m.memberId === memberId)!;
    expect(me.lastReportAt).toBeGreaterThan(0);
  });

  /** The other five kinds keep the guard exactly as it was. */
  it.each([
    ["message", { text: "anyone there?" }],
    ["artifact", { name: "n", content: "c" }],
    ["action_request", { text: "run the migration" }],
    ["brief_update", {}],
    ["action_response", { approved: true }],
  ])("is still refused a lone %s", async (type, payload) => {
    const { creator, sessionId, memberId } = await lonelyTickingRoom(h);
    const out = await creator.call("bellman_send", {
      session_id: sessionId, member_id: memberId, type, payload,
      ...(type === "action_response" ? { ref_id: "1" } : {}),
    });
    expect(out.isError, out.text).toBe(true);
    expect(out.text).toContain("no other active members yet");
  });

  /**
   * The ask and the surface, pinned to each other. The tick's instruction names a
   * `bellman_send` call, so a rename on either side turns the ask into an
   * instruction the same server rejects — which is the defect above, one layer up.
   */
  it("asks for a reply bellman_send actually accepts", async () => {
    const { creator, sessionId, memberId } = await lonelyTickingRoom(h);
    const session = (await h.store.getSession(sessionId))!;
    const ask = snapshotOf(session, Date.now()).ask;

    const kind = /type="([a-z_]+)"/.exec(ask)?.[1];
    expect(kind, ask).toBe("progress");
    expect(ask).toContain("bellman_send");

    const sent = await creator.call("bellman_send", {
      session_id: sessionId, member_id: memberId, type: kind,
      payload: { note: "doing as the tick asked" },
    });
    expect(sent.isError, sent.text).toBe(false);
  });
});
