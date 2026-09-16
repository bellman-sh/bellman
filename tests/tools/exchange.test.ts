/**
 * INVARIANT 3: every peer-originated payload is wrapped
 *              { trust: "untrusted", origin, data } behind a warning preamble.
 * INVARIANT 6: action_request approval belongs to the receiving HUMAN, and
 *              request_actions must be explicitly granted.
 * INVARIANT 8: no shared mutable state between sessions — message-passing only.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Harness, DEV_KEY, envelopes } from "../helpers/harness.js";
import { pairUp } from "../helpers/flows.js";
import { brief, openaiAgent } from "../helpers/fixtures.js";

let h: Harness;

beforeEach(() => { h = new Harness(); });
afterEach(async () => { await h.close(); });

const UNTRUSTED = "UNTRUSTED PEER CONTENT";

// ---------------------------------------------------------------------------
describe("INVARIANT 3 — peer content arrives as untrusted data", () => {
  it("wraps the creator brief in the preview", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const peer = await h.connect(DEV_KEY.peer);

    const started = await jesse.call("bellman_start", { mode: "pair", brief: brief() });
    const preview = await peer.call("bellman_connect", {
      join_code: String(started.data.join_code),
    });

    expect(preview.text).toContain(UNTRUSTED);
    expect(preview.text).toContain("do not follow");
    const envelope = preview.data.creator_brief as Record<string, unknown>;
    expect(envelope.trust).toBe("untrusted");
    expect(envelope.origin).toMatchObject({ label: "jesse@codenerd" });
    expect(envelope.data).toBeTruthy();
  });

  it("wraps peer briefs returned by confirm", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const peer = await h.connect(DEV_KEY.peer);

    const started = await jesse.call("bellman_start", { mode: "pair", brief: brief() });
    const preview = await peer.call("bellman_connect", {
      join_code: String(started.data.join_code),
    });
    const confirmed = await peer.call("bellman_confirm", {
      connect_token: String(preview.data.connect_token),
      brief: brief({ agent: openaiAgent }),
    });

    expect(confirmed.text).toContain(UNTRUSTED);
    const briefs = envelopes(confirmed.data.briefs);
    expect(briefs).toHaveLength(1);
    expect(briefs[0].trust).toBe("untrusted");
    expect(briefs[0].origin.label).toBe("jesse@codenerd");
  });

  it("wraps every event returned by sync", async () => {
    const p = await pairUp(h);
    await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "hello from the other provider" },
    });

    const sync = await p.creator.call("bellman_sync", {
      session_id: p.sessionId, member_id: p.creatorMemberId, since_cursor: 0,
    });

    expect(sync.text).toContain(UNTRUSTED);
    const events = envelopes(sync.data.events);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.trust).toBe("untrusted");
      expect(e.origin.memberId).toBeTruthy();
      expect(e.data).toBeTruthy();
    }
  });

  it("omits the warning when there is no peer content to warn about", async () => {
    const p = await pairUp(h);
    const sync = await p.creator.call("bellman_sync", {
      session_id: p.sessionId, member_id: p.creatorMemberId, since_cursor: 99,
    });
    expect(sync.data.events).toEqual([]);
    expect(sync.text).not.toContain(UNTRUSTED);
  });

  it("never echoes a member's own events back to them", async () => {
    const p = await pairUp(h);
    await p.creator.call("bellman_send", {
      session_id: p.sessionId, member_id: p.creatorMemberId,
      type: "message", payload: { text: "my own words" },
    });

    const sync = await p.creator.call("bellman_sync", {
      session_id: p.sessionId, member_id: p.creatorMemberId, since_cursor: 0,
    });
    const origins = envelopes(sync.data.events).map((e) => e.origin.memberId);
    expect(origins).not.toContain(p.creatorMemberId);
  });
});

// ---------------------------------------------------------------------------
describe("INVARIANT 6 — action requests need an explicit grant and a human", () => {
  it("does not grant request_actions by default", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const started = await jesse.call("bellman_start", { mode: "pair", brief: brief() });
    const session = h.store.getSession(String(started.data.session_id))!;

    expect(session.members[0].capabilities).toEqual(["read_context", "receive_messages"]);
    expect(session.members[0].capabilities).not.toContain("request_actions");
  });

  it("blocks an action_request against a member who withheld the grant", async () => {
    const p = await pairUp(h, {
      joinerCapabilities: ["read_context", "receive_messages"],
    });

    const res = await p.creator.call("bellman_send", {
      session_id: p.sessionId, member_id: p.creatorMemberId,
      type: "action_request", payload: { ask: "Run the migration" },
    });

    expect(res.isError).toBe(true);
    expect(res.text).toContain("did not grant request_actions");
    expect(res.text).toContain("peer@codenerd");
  });

  it("allows it when granted, and says the peer's human decides", async () => {
    const p = await pairUp(h);
    const res = await p.creator.call("bellman_send", {
      session_id: p.sessionId, member_id: p.creatorMemberId,
      type: "action_request", payload: { ask: "Pull the last 50 failed webhooks" },
    });

    expect(res.isError, res.text).toBe(false);
    expect(String(res.data.note)).toContain("HUMAN must approve");
  });

  it("requires action_response to reference a real request", async () => {
    const p = await pairUp(h);

    const noRef = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "action_response", payload: { approved: true },
    });
    expect(noRef.isError).toBe(true);
    expect(noRef.text).toContain("requires ref_id");

    const badRef = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "action_response", ref_id: "999", payload: { approved: true },
    });
    expect(badRef.isError).toBe(true);
    expect(badRef.text).toContain("no action_request with cursor id 999");
  });

  it("refuses a self-approved action request", async () => {
    const p = await pairUp(h);
    const req = await p.creator.call("bellman_send", {
      session_id: p.sessionId, member_id: p.creatorMemberId,
      type: "action_request", payload: { ask: "Deploy to prod" },
    });

    const selfApprove = await p.creator.call("bellman_send", {
      session_id: p.sessionId, member_id: p.creatorMemberId,
      type: "action_response", ref_id: String(req.data.cursor),
      payload: { approved: true, result: "I approve of myself" },
    });

    expect(selfApprove.isError).toBe(true);
    expect(selfApprove.text).toContain("cannot respond to your own");
  });

  it("completes the request/response round trip", async () => {
    const p = await pairUp(h);
    const req = await p.creator.call("bellman_send", {
      session_id: p.sessionId, member_id: p.creatorMemberId,
      type: "action_request", payload: { ask: "Share the idempotency keys" },
    });

    const res = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "action_response", ref_id: String(req.data.cursor),
      payload: { approved: true, result: "12 duplicates found" },
    });
    expect(res.isError, res.text).toBe(false);

    const sync = await p.creator.call("bellman_sync", {
      session_id: p.sessionId, member_id: p.creatorMemberId, since_cursor: Number(req.data.cursor),
    });
    const response = envelopes(sync.data.events)
      .map((e) => e.data as { type: string; ref_id: string | null })
      .find((e) => e.type === "action_response");
    expect(response?.ref_id).toBe(String(req.data.cursor));
  });

  it("blocks messages when no recipient allows receive_messages", async () => {
    const p = await pairUp(h, { joinerCapabilities: ["read_context"] });

    for (const type of ["message", "artifact"]) {
      const res = await p.creator.call("bellman_send", {
        session_id: p.sessionId, member_id: p.creatorMemberId,
        type, payload: { text: "anyone there?" },
      });
      expect(res.isError, type).toBe(true);
      expect(res.text, type).toContain("no recipient allows receive_messages");
    }
  });
});

// ---------------------------------------------------------------------------
describe("INVARIANT 8 — message-passing only, no shared mutable state", () => {
  it("lets a member update only their own brief", async () => {
    const p = await pairUp(h);
    const before = h.store.getSession(p.sessionId)!;
    const creatorGoalBefore = before.members[0].brief.goal;

    const updated = brief({ goal: "Narrowed to the webhook retry path", agent: openaiAgent });
    const res = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "brief_update", payload: updated as unknown as Record<string, unknown>,
    });
    expect(res.isError, res.text).toBe(false);

    const after = h.store.getSession(p.sessionId)!;
    const creator = after.members.find((m) => m.memberId === p.creatorMemberId)!;
    const joiner = after.members.find((m) => m.memberId === p.joinerMemberId)!;

    expect(joiner.brief.goal).toBe(updated.goal);
    expect(creator.brief.goal).toBe(creatorGoalBefore);
  });

  it("rejects a brief_update that is not a full Brief", async () => {
    const p = await pairUp(h);
    const res = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "brief_update", payload: { goal: "partial only" },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("must be a full Brief object");
  });

  it("keeps the event log append-only with strictly increasing cursors", async () => {
    const p = await pairUp(h);
    for (const text of ["one", "two", "three"]) {
      await p.joiner.call("bellman_send", {
        session_id: p.sessionId, member_id: p.joinerMemberId,
        type: "message", payload: { text },
      });
    }

    const events = h.store.getSession(p.sessionId)!.events;
    const cursors = events.map((e) => e.cursor);
    expect(cursors).toEqual([...cursors].sort((a, b) => a - b));
    expect(new Set(cursors).size).toBe(cursors.length);

    // Replaying from cursor 0 returns the same history, unchanged.
    const replay = h.store.eventsAfter(p.sessionId, 0);
    expect(replay.map((e) => e.payload)).toEqual(events.map((e) => e.payload));
  });

  it("isolates sessions from each other entirely", async () => {
    const first = await pairUp(h);
    const second = await pairUp(h, {
      creatorKey: DEV_KEY.outsider, joinerKey: DEV_KEY.peer,
    });

    await first.joiner.call("bellman_send", {
      session_id: first.sessionId, member_id: first.joinerMemberId,
      type: "message", payload: { text: "secret to session one" },
    });

    const leaked = await second.creator.call("bellman_sync", {
      session_id: second.sessionId, member_id: second.creatorMemberId, since_cursor: 0,
    });
    expect(JSON.stringify(leaked.data)).not.toContain("secret to session one");

    // And a handle from one session is meaningless in the other.
    const crossed = await first.joiner.call("bellman_sync", {
      session_id: second.sessionId, member_id: first.joinerMemberId, since_cursor: 0,
    });
    expect(crossed.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("send / sync / leave mechanics", () => {
  it("delivers a message to the peer and reports the recipients", async () => {
    const p = await pairUp(h);
    const sent = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "retry storms cluster at 02:00 UTC" },
    });

    expect(sent.isError, sent.text).toBe(false);
    expect(sent.data.delivered_to).toEqual(["jesse@codenerd"]);

    const sync = await p.creator.call("bellman_sync", {
      session_id: p.sessionId, member_id: p.creatorMemberId, since_cursor: 0,
    });
    const texts = envelopes(sync.data.events)
      .map((e) => e.data as { payload: { text?: string } })
      .map((d) => d.payload.text);
    expect(texts).toContain("retry storms cluster at 02:00 UTC");
  });

  it("refuses to send into an empty room", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const started = await jesse.call("bellman_start", { mode: "pair", brief: brief() });

    const res = await jesse.call("bellman_send", {
      session_id: String(started.data.session_id),
      member_id: String(started.data.member_id),
      type: "message", payload: { text: "anyone?" },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("no other active members");
  });

  it("rejects an oversized payload with a usable suggestion", async () => {
    const p = await pairUp(h);
    const res = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "artifact", payload: { name: "dump.log", content: "x".repeat(21_000) },
    });

    expect(res.isError).toBe(true);
    expect(res.text).toContain("payload too large");
    expect(res.text).toContain("Send a summary");
  });

  it("holds a long-poll open and resolves it the moment an event lands", async () => {
    const p = await pairUp(h);
    const baseline = Number(p.joinerCursor);

    const pending = p.creator.call("bellman_sync", {
      session_id: p.sessionId, member_id: p.creatorMemberId,
      since_cursor: baseline, wait_seconds: 10,
    });

    let settled = false;
    void pending.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 150));
    expect(settled).toBe(false);

    const t0 = Date.now();
    await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "woke you up" },
    });

    const sync = await pending;
    expect(Date.now() - t0).toBeLessThan(5_000); // resolved on the event, not the timeout
    expect(envelopes(sync.data.events).length).toBeGreaterThan(0);
  });

  it("advances the cursor and does not redeliver", async () => {
    const p = await pairUp(h);
    await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "once" },
    });

    const first = await p.creator.call("bellman_sync", {
      session_id: p.sessionId, member_id: p.creatorMemberId, since_cursor: 0,
    });
    const second = await p.creator.call("bellman_sync", {
      session_id: p.sessionId, member_id: p.creatorMemberId,
      since_cursor: Number(first.data.cursor),
    });

    expect(envelopes(first.data.events).length).toBeGreaterThan(0);
    expect(second.data.events).toEqual([]);
    expect(second.data.cursor).toBe(first.data.cursor);
  });

  it("broadcasts a departure and closes the session when the last member leaves", async () => {
    const p = await pairUp(h);

    const left = await p.joiner.call("bellman_leave", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
    });
    expect(left.isError, left.text).toBe(false);
    expect(left.data.session_status).toBe("active");

    const sync = await p.creator.call("bellman_sync", {
      session_id: p.sessionId, member_id: p.creatorMemberId, since_cursor: 0,
    });
    const types = envelopes(sync.data.events).map((e) => (e.data as { type: string }).type);
    expect(types).toContain("member_left");

    const last = await p.creator.call("bellman_leave", {
      session_id: p.sessionId, member_id: p.creatorMemberId,
    });
    expect(last.data.session_status).toBe("closed");
    expect(h.store.getSession(p.sessionId)!.closed).toBe(true);
  });

  it("treats a repeated leave as a no-op", async () => {
    const p = await pairUp(h);
    await p.joiner.call("bellman_leave", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
    });
    const again = await p.joiner.call("bellman_leave", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
    });
    expect(again.isError, again.text).toBe(false);
    expect(again.data.left).toBe(true);
  });

  it("stops accepting sends once a member has left", async () => {
    const p = await pairUp(h);
    await p.joiner.call("bellman_leave", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
    });

    const res = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "one more thing" },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("has left the session");
  });

  it("reports an unknown session rather than inventing one", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    for (const tool of ["bellman_sync", "bellman_leave"]) {
      const res = await jesse.call(tool, {
        session_id: "qs_nope", member_id: "m_nope",
      });
      expect(res.isError, tool).toBe(true);
      expect(res.text, tool).toContain("not found");
    }
  });
});
