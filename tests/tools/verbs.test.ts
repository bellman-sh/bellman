/**
 * The verb guards. #1 declared a room's verbs and enforced none of them; this is
 * the file that turns bellman_connect's preview from stated intent into a fact.
 *
 * Every denial asserts two things: the caller is told which verb their seat
 * lacks, and the room did not move. An error that still appended an event would
 * be worse than no guard at all.
 *
 * Seats are authored rather than taken from a preset because a joiner always gets
 * `default_role` until #3, so a verbless or oddly-shaped joiner seat has to be
 * declared as the default.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Harness, DEV_KEY } from "../helpers/harness.js";
import { pairUp } from "../helpers/flows.js";
import { brief } from "../helpers/fixtures.js";

let h: Harness;

beforeEach(() => { h = new Harness(); });
afterEach(async () => { await h.close(); });

const ALL_VERBS = ["send", "invite", "revoke", "request_actions", "respond_actions"];

/** A pair manifest whose joiner seat holds exactly `can`. */
function seat(can: string[], room = "verb-guards") {
  return {
    room,
    mode: "pair",
    roles: { lead: { can: ALL_VERBS }, guest: { can } },
    default_role: "guest",
    creator_role: "lead",
  };
}

async function eventCount(sessionId: string): Promise<number> {
  return (await h.store.getSession(sessionId))!.events.length;
}

// ---------------------------------------------------------------------------
describe("bellman_send — a seat that holds the verb", () => {
  it.each([
    ["message", "send", { text: "hello" }],
    ["artifact", "send", { name: "patch.diff", content: "--- a\n+++ b\n" }],
    ["action_request", "request_actions", { action: "run the test suite" }],
  ] as const)("allows %s to a seat holding %s", async (type, verb, payload) => {
    const p = await pairUp(h, { manifest: seat([verb]) });
    const res = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId, type, payload,
    });
    expect(res.isError, res.text).toBe(false);
  });

  it("allows brief_update to a seat holding send", async () => {
    const p = await pairUp(h, { manifest: seat(["send"]) });
    const res = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "brief_update", payload: brief({ goal: "Now porting the webhook" }),
    });
    expect(res.isError, res.text).toBe(false);

    const stored = (await h.store.getSession(p.sessionId))!
      .members.find((m) => m.memberId === p.joinerMemberId)!;
    expect(stored.brief.goal).toBe("Now porting the webhook");
  });

  it("allows action_response to a seat holding respond_actions", async () => {
    const p = await pairUp(h, { manifest: seat(["respond_actions"]) });
    // The creator holds every verb, so the request it answers is real.
    const asked = await p.creator.call("bellman_send", {
      session_id: p.sessionId, member_id: p.creatorMemberId,
      type: "action_request", payload: { action: "rerun CI" },
    });
    expect(asked.isError, asked.text).toBe(false);

    const res = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "action_response", ref_id: String(asked.data.cursor),
      payload: { approved: true, result: "green" },
    });
    expect(res.isError, res.text).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("bellman_send — a seat that lacks the verb", () => {
  it.each([
    ["message", "send", { text: "hello" }],
    ["artifact", "send", { name: "patch.diff", content: "x" }],
    ["brief_update", "send", { goal: "g", state: "s", constraints: [], open_questions: [], agent: { provider: "openai", model: "gpt-5", client: "chatgpt" } }],
    ["action_request", "request_actions", { action: "do a thing" }],
    ["action_response", "respond_actions", { approved: true }],
  ] as const)("refuses %s, naming the missing verb %s, and appends nothing", async (type, verb, payload) => {
    // The seat holds every verb EXCEPT the one under test, so nothing else can
    // be doing the refusing.
    const p = await pairUp(h, { manifest: seat(ALL_VERBS.filter((v) => v !== verb)) });
    const before = await eventCount(p.sessionId);

    const res = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type, payload, ...(type === "action_response" ? { ref_id: "1" } : {}),
    });

    expect(res.isError, res.text).toBe(true);
    expect(res.text).toContain(`does not hold the verb "${verb}"`);
    expect(res.text).toContain('your role "guest"');
    expect(await eventCount(p.sessionId), "a denial must not append an event").toBe(before);
  });

  it("leaves the stored brief untouched when brief_update is refused", async () => {
    const p = await pairUp(h, {
      manifest: seat([]),
      joinerBrief: brief({ goal: "The brief I joined with" }),
    });

    const res = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "brief_update", payload: brief({ goal: "Rewritten without authority" }),
    });
    expect(res.isError).toBe(true);

    const stored = (await h.store.getSession(p.sessionId))!
      .members.find((m) => m.memberId === p.joinerMemberId)!;
    expect(stored.brief.goal).toBe("The brief I joined with");
  });

  it("refuses every kind to a wholly verbless seat", async () => {
    const p = await pairUp(h, { manifest: seat([]) });
    const before = await eventCount(p.sessionId);
    for (const type of ["message", "artifact", "action_request", "action_response", "brief_update"]) {
      const res = await p.joiner.call("bellman_send", {
        session_id: p.sessionId, member_id: p.joinerMemberId,
        type, payload: { text: "x" }, ref_id: "1",
      });
      expect(res.isError, type).toBe(true);
      expect(res.text, type).toContain("(it holds: none)");
    }
    expect(await eventCount(p.sessionId)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// A published preset, end to end. Every other test in this file authors its
// seats, which proves the guard reads a manifest but not that the presets a real
// caller cites mean anything. `review` exists to make the reviewer answer action
// requests without initiating them; this is the test that makes that true.
describe("the review preset's asymmetry is enforced", () => {
  it("lets the reviewer answer an action request but not start one", async () => {
    const p = await pairUp(h, { manifest: { room: "code-review", preset: "review" } });

    const started = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "action_request", payload: { action: "rebase onto main" },
    });
    expect(started.isError).toBe(true);
    expect(started.text).toContain('your role "reviewer" does not hold the verb "request_actions"');
    expect(started.text).toContain("(it holds: send, respond_actions)");

    // The author may ask, and the reviewer may answer.
    const asked = await p.creator.call("bellman_send", {
      session_id: p.sessionId, member_id: p.creatorMemberId,
      type: "action_request", payload: { action: "rerun the failing spec" },
    });
    expect(asked.isError, asked.text).toBe(false);

    const answered = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "action_response", ref_id: String(asked.data.cursor),
      payload: { approved: true, result: "passes locally" },
    });
    expect(answered.isError, answered.text).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Review Focus. The verb guard sits ahead of every other check in the handler,
// so a seat with no authority always hears about its own role. Each of these
// passes for the wrong reason if the guard is moved further down: the OTHER
// error appears instead, and the assertions here name it.
describe("bellman_send — the verb guard comes first", () => {
  it("prefers the sender's missing verb over the recipients' capabilities", async () => {
    const p = await pairUp(h, {
      manifest: seat([]),
      creatorCapabilities: ["read_context"], // nobody will accept a message
    });
    const res = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "x" },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('does not hold the verb "send"');
    expect(res.text).not.toContain("receive_messages");
  });

  it("prefers the missing verb over validating ref_id", async () => {
    const p = await pairUp(h, { manifest: seat(["send"]) });
    const res = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "action_response", ref_id: "9999", payload: { approved: true },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('does not hold the verb "respond_actions"');
    // Whether cursor 9999 is an action_request is not this member's business.
    expect(res.text).not.toContain("9999");
  });

  it("prefers the missing verb over the payload size limit", async () => {
    const p = await pairUp(h, { manifest: seat([]) });
    const res = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "x".repeat(25_000) }, // over MAX_PAYLOAD_CHARS
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('does not hold the verb "send"');
    expect(res.text).not.toContain("payload too large");
  });

  it("prefers the missing verb over reporting who is in the room", async () => {
    // A creator alone in a swarm room, seated in a role with no verbs.
    const creator = await h.connect(DEV_KEY.jesse);
    const started = await creator.call("bellman_start", {
      manifest: {
        room: "alone", mode: "swarm",
        roles: { watcher: { can: [] }, helper: { can: ["send"] } },
        default_role: "helper", creator_role: "watcher",
      },
      brief: brief(),
    });
    expect(started.isError, started.text).toBe(false);

    const res = await creator.call("bellman_send", {
      session_id: String(started.data.session_id),
      member_id: String(started.data.member_id),
      type: "message", payload: { text: "anyone there?" },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('does not hold the verb "send"');
    expect(res.text).not.toContain("no other active members");
  });

  it("does not compose verbs: request_actions alone sends a request but not a message", async () => {
    const p = await pairUp(h, { manifest: seat(["request_actions"]) });

    const asked = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "action_request", payload: { action: "rerun CI" },
    });
    expect(asked.isError, asked.text).toBe(false);

    const said = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "and also, hello" },
    });
    expect(said.isError).toBe(true);
    expect(said.text).toContain('does not hold the verb "send"');
  });

  it("still reports a left member as left, not as unauthorized", async () => {
    const p = await pairUp(h, { manifest: seat([]) });
    await p.joiner.call("bellman_leave", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
    });
    const res = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "x" },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("has left the session");
  });
});
