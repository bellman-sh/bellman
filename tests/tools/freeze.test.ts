/**
 * Freezing is what a lapsed plan does to a room, and the whole point is that
 * it is reversible without costing anyone their work. So: writes refused,
 * everything else untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Harness, DEV_KEY } from "../helpers/harness.js";
import { pairUp } from "../helpers/flows.js";
import { brief } from "../helpers/fixtures.js";

let h: Harness;

beforeEach(() => { h = new Harness(); });
afterEach(async () => { await h.close(); });

const FROZEN = /frozen/i;

describe("a frozen session refuses writes", () => {
  it("refuses to send, and says why", async () => {
    const { creator, sessionId, creatorMemberId } = await pairUp(h);
    await h.store.freezeSession(sessionId, Date.now());

    const sent = await creator.call("bellman_send", {
      session_id: sessionId, member_id: creatorMemberId,
      type: "message", payload: { text: "hello?" },
    });

    expect(sent.isError).toBe(true);
    expect(sent.text).toMatch(FROZEN);
    // The reason matters: a client has to be able to tell a lapsed plan from
    // a closed room, because one of them is fixable by paying.
    expect(sent.text).toMatch(/plan/);
  });

  it("refuses a new join, so a frozen room cannot grow", async () => {
    const { creator, sessionId, creatorMemberId } = await pairUp(h);
    await h.store.freezeSession(sessionId, Date.now());

    const invited = await creator.call("bellman_invite", {
      session_id: sessionId, member_id: creatorMemberId,
    });

    expect(invited.isError).toBe(true);
    expect(invited.text).toMatch(FROZEN);
  });

  it("refuses to confirm a join that was already in flight", async () => {
    const creator = await h.connect(DEV_KEY.jesse);
    const peer = await h.connect(DEV_KEY.peer);
    const started = await creator.call("bellman_start", { mode: "pair", brief: brief() });
    const preview = await peer.call("bellman_connect", {
      join_code: String(started.data.join_code),
    });

    // The plan lapses between connecting and confirming.
    await h.store.freezeSession(String(started.data.session_id), Date.now());

    const confirmed = await peer.call("bellman_confirm", {
      connect_token: String(preview.data.connect_token), brief: brief(),
    });

    expect(confirmed.isError).toBe(true);
    expect(confirmed.text).toMatch(FROZEN);
  });
});

describe("a frozen session keeps everything else", () => {
  it("still lets members read the history they already have", async () => {
    const { creator, joiner, sessionId, creatorMemberId, joinerMemberId } = await pairUp(h);
    await creator.call("bellman_send", {
      session_id: sessionId, member_id: creatorMemberId,
      type: "message", payload: { text: "before the lapse" },
    });
    await h.store.freezeSession(sessionId, Date.now());

    const synced = await joiner.call("bellman_sync", {
      session_id: sessionId, member_id: joinerMemberId, after_cursor: 0, wait_ms: 0,
    });

    expect(synced.isError).toBeFalsy();
    expect(JSON.stringify(synced.data)).toContain("before the lapse");
  });

  it("reports the room as frozen rather than closed or active", async () => {
    const { joiner, sessionId, joinerMemberId } = await pairUp(h);
    await h.store.freezeSession(sessionId, Date.now());

    const left = await joiner.call("bellman_leave", {
      session_id: sessionId, member_id: joinerMemberId,
    });

    expect(left.data.session_status).toBe("frozen");
  });

  /** Paying again has to give the room back, not a copy of it. */
  it("works again once the plan is restored", async () => {
    const { creator, sessionId, creatorMemberId } = await pairUp(h);
    await h.store.freezeSession(sessionId, Date.now());
    await h.store.freezeSession(sessionId, null);

    const sent = await creator.call("bellman_send", {
      session_id: sessionId, member_id: creatorMemberId,
      type: "message", payload: { text: "back" },
    });

    expect(sent.isError).toBeFalsy();
  });
});
