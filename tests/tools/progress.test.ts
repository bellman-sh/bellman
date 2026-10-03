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
import { Harness } from "../helpers/harness.js";
import { pairUp, type PairedSession } from "../helpers/flows.js";

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
