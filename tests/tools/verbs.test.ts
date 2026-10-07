/**
 * The verb guards. #1 declared a room's verbs and enforced none of them; this is
 * the file that turns bellman_connect's preview from stated intent into a fact —
 * for all six verbs: send, request_actions, respond_actions and write_surface in
 * bellman_send, invite and revoke in bellman_invite.
 *
 * Every KIND of send is denied with the missing verb named, and the room does not
 * move: one row per kind in "a seat that lacks the verb", against bellman_send's
 * guard — and, for a surface write, writeSurface's own. An error that still
 * appended an event would be worse than no guard at all. The other tests here
 * pin what the caller hears; they do not each re-assert that the room stood still.
 *
 * Seats are authored rather than taken from a preset because a joiner always gets
 * `default_role` until #3, so a verbless or oddly-shaped joiner seat has to be
 * declared as the default.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Harness, DEV_KEY, envelopes } from "../helpers/harness.js";
import { pairUp } from "../helpers/flows.js";
import { brief, member, roomManifest, session } from "../helpers/fixtures.js";

let h: Harness;

beforeEach(() => { h = new Harness(); });
afterEach(async () => { await h.close(); });

const ALL_VERBS = ["send", "invite", "revoke", "request_actions", "respond_actions", "write_surface"];

/**
 * A manifest whose joiner seat holds exactly `can`. A pair unless `mode` says
 * otherwise; the tests that need a free seat and a live join code ask for a swarm,
 * because a pair is full once the joiner arrives, with its code consumed.
 */
function seat(can: string[], room = "verb-guards", mode: "pair" | "swarm" = "pair") {
  return {
    room,
    mode,
    roles: { lead: { can: ALL_VERBS }, guest: { can } },
    default_role: "guest",
    creator_role: "lead",
  };
}

async function eventCount(sessionId: string): Promise<number> {
  return (await h.store.eventsAfter(sessionId, 0)).length;
}

// ---------------------------------------------------------------------------
describe("bellman_send — a seat that holds the verb", () => {
  it.each([
    ["message", "send", { text: "hello" }],
    ["artifact", "send", { name: "patch.diff", content: "--- a\n+++ b\n" }],
    ["action_request", "request_actions", { action: "run the test suite" }],
    ["surface", "write_surface", { key: "plan", kind: "text", body: "the plan" }],
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
    ["progress", "send", { note: "ran migration 0042" }],
    ["surface", "write_surface", { key: "plan", kind: "text", body: "the plan" }],
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
    for (const type of ["message", "artifact", "action_request", "action_response", "brief_update", "progress", "surface"]) {
      const res = await p.joiner.call("bellman_send", {
        session_id: p.sessionId, member_id: p.joinerMemberId,
        type, payload: { text: "x" }, ref_id: "1",
      });
      expect(res.isError, type).toBe(true);
      expect(res.text, type).toContain("(it holds: none)");
    }
    expect(await eventCount(p.sessionId)).toBe(before);
  });

  // README.md promises that a denial leaves "nothing... delivered or recorded".
  // Every other test here checks "delivered"; nothing checked "recorded" until
  // now. A denied call must not write an audit entry: hoisting bellman_send's
  // audit() call above its verb guard passes the entire suite without this test.
  it("a denied send records nothing in the audit log", async () => {
    const p = await pairUp(h, { manifest: seat([]) });
    const org = p.joiner.identity.orgId!;
    // audit() skips entirely when both org ids are null, so without this the
    // test would go vacuously green if the fixture identities ever lost their org.
    expect(org, "the joiner must be in an org for auditing to run").toBeTruthy();
    const before = (await h.store.auditForOrg(org, 500)).length;

    const res = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "x" },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('does not hold the verb "send"');

    expect((await h.store.auditForOrg(org, 500)).length,
      "a denial must not record an action that never happened").toBe(before);
  });

  // The same argument as the audit test above, for #79's idempotency keys: a
  // refused send must not consume the caller's key. The guard sits above the
  // store call, so a denied seat never reaches appendEventOnce and its key
  // stays free.
  //
  // What this does NOT claim: moving the guard below the append turns 13 tests
  // in this file red, the "appends nothing" rows among them, so this is not the
  // sentinel for that drift. What nothing else covers is the KEY — every other
  // denial test here measures events or audit rows. If key-recording were ever
  // separated from appending, or a refusing guard added after the store call,
  // this is the only test that would notice.
  it("a denied send does not consume an idempotency key", async () => {
    const KEY = "retry-0001";
    // A seat that may ask but not talk: `message` needs `send`, `action_request`
    // needs `request_actions`. That is what makes this provable at all — keys
    // are namespaced per member, so a second member reusing the key would show
    // nothing. The same member has to be refused once and allowed once.
    const p = await pairUp(h, { manifest: seat(["request_actions"]) });

    const denied = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "refused" }, idempotency_key: KEY,
    });
    expect(denied.isError, denied.text).toBe(true);

    // Same member, same key, and it must APPEND. "replayed" or a conflict would
    // mean the refused call had recorded the key, so a caller denied once could
    // never use that key again — its retries would answer for a send that never
    // happened.
    const allowed = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "action_request", payload: { action: "run the suite" },
      idempotency_key: KEY,
    });
    expect(allowed.isError, allowed.text).toBe(false);
    expect(allowed.data.replayed).toBeUndefined();
    expect(typeof allowed.data.cursor).toBe("number");
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
// Review Focus. The verb guard sits ahead of every check about the message
// (payload, occupancy, recipients, ref_id), so a seat with no authority always
// hears about its own role. Each "prefers ..." test is pinned by the one check
// its name gives: move the guard below that check and the test fails, because the
// OTHER error appears instead and the assertions here name the verb error. Below
// only the payload check just the payload test fails; each further check the guard
// passes fails one more, five in all. `does not compose verbs` is about
// composition, not ordering, and stays green however far down the guard sits.
//
// The checks about who is calling — session, closed, frozen, member, left — still
// come first. Of those, only the left-member case is pinned here, by the last
// test, which keeps that check ahead of the guard. Nothing in this file pins the
// frozen ordering.
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

  it("prefers the missing request_actions verb over the recipient's request_actions capability", async () => {
    // request_actions is the one name a verb and a capability share, so on this
    // path only the error text tells the two layers apart. The sender's seat lacks
    // the VERB; the recipient withheld the CAPABILITY. Both refuse, and the sender
    // must hear about its own role rather than be sent to ask a peer to change a
    // setting that was never the obstacle.
    const p = await pairUp(h, {
      manifest: seat(ALL_VERBS.filter((v) => v !== "request_actions")),
      creatorCapabilities: ["read_context", "receive_messages"], // no request_actions
    });
    const res = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "action_request", payload: { action: "rerun CI" },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('does not hold the verb "request_actions"');
    expect(res.text).not.toContain("did not grant");
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

// ---------------------------------------------------------------------------
// bellman_invite gated on two separate verbs. #1's enum made `invite` and
// `revoke` distinct, so a seat may hold one without the other and the guard
// respects that rather than treating revoke as a weaker invite.
describe("bellman_invite — invite and revoke are separate verbs", () => {
  /**
   * A swarm room (capacity for a third member, so a code is usable) whose
   * joiner seat holds `invite` without `revoke`. bellman_start mints for the
   * DEFAULT seat, so `guest` has a live code and `lead` has none — which is
   * what separates the two cases #90 created.
   */
  const guestWhoCanInvite = async (guestVerbs: string[] = ["send", "invite"]) => {
    const creator = await h.connect(DEV_KEY.jesse);
    const started = await creator.call("bellman_start", {
      manifest: {
        room: "guest-can-invite", mode: "swarm",
        roles: { lead: { can: ALL_VERBS }, guest: { can: guestVerbs } },
        default_role: "guest", creator_role: "lead",
      },
      brief: brief(),
    });
    expect(started.isError, started.text).toBe(false);

    const joiner = await h.connect(DEV_KEY.peer);
    const preview = await joiner.call("bellman_connect", { join_code: started.data.join_code });
    const confirmed = await joiner.call("bellman_confirm", {
      connect_token: preview.data.connect_token, brief: brief(),
    });
    expect(confirmed.isError, confirmed.text).toBe(false);
    return {
      joiner,
      sessionId: String(started.data.session_id),
      memberId: String(confirmed.data.member_id),
    };
  };

  it("lets a seat holding invite open a door that is shut", async () => {
    const { joiner, sessionId, memberId } = await guestWhoCanInvite();
    // `lead` has no live code, so this mints without retiring anything. That is
    // what `invite` alone buys after #90.
    const issued = await joiner.call("bellman_invite", {
      session_id: sessionId, member_id: memberId, role: "lead",
    });
    expect(issued.isError, issued.text).toBe(false);
    expect(String(issued.data.join_code)).toMatch(/^BELL-/);
    expect(issued.data.replaced_previous).toBe(false);
  });

  it("refuses a seat holding invite alone the replacement of a live code", async () => {
    const { joiner, sessionId, memberId } = await guestWhoCanInvite();
    // No role named, so this is the default seat — whose code from bellman_start
    // is still live. Minting would retire a code someone may be holding, which
    // is the `revoke` authority and not the `invite` one (#90). Before that, this
    // call succeeded and silently cut the holder off.
    const res = await joiner.call("bellman_invite", {
      session_id: sessionId, member_id: memberId,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("already has a live join code");
    expect(res.text).toContain('"revoke"');
  });

  it("lets a seat holding both replace a live code", async () => {
    // The control for the refusal above: the same call against the same live
    // code, from a seat that holds revoke too. Without this, the refusal could
    // be passing on something other than the verb.
    const { joiner, sessionId, memberId } = await guestWhoCanInvite(ALL_VERBS);
    const res = await joiner.call("bellman_invite", {
      session_id: sessionId, member_id: memberId,
    });
    expect(res.isError, res.text).toBe(false);
    expect(String(res.data.join_code)).toMatch(/^BELL-/);
    expect(res.data.replaced_previous).toBe(true);
  });

  it("refuses invite to a seat that lacks it, naming the verb", async () => {
    const p = await pairUp(h, { manifest: seat(["send", "revoke"]) });
    const res = await p.joiner.call("bellman_invite", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('does not hold the verb "invite"');
    expect(res.text).toContain("(it holds: send, revoke)");
  });

  it("refuses revoke to a seat that holds invite but not revoke", async () => {
    const p = await pairUp(h, { manifest: seat(["send", "invite"]) });
    const res = await p.joiner.call("bellman_invite", {
      session_id: p.sessionId, member_id: p.joinerMemberId, revoke: true,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('does not hold the verb "revoke"');
  });

  it("a denied invite neither mints a code nor appends an event", async () => {
    // A swarm room with spare capacity, deliberately not a full pair. In a full
    // pair the capacity check refuses before the mint, so this test would stay
    // green with the guard moved below the mint and prove nothing about it. Here
    // the joiner may speak but not invite, and only the verb guard stands between
    // it and a fresh code.
    const p = await pairUp(h, { manifest: seat(["send"], "verb-guards", "swarm") });
    const before = (await h.store.getSession(p.sessionId))!;
    const eventsBefore = await eventCount(p.sessionId);
    // Keeps the setup honest: if the room is ever reshaped until it is full, this
    // fails loudly instead of going quietly vacuous.
    expect(before.members.length, "the room must have spare capacity").toBeLessThan(before.maxMembers);

    const res = await p.joiner.call("bellman_invite", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
    });
    expect(res.isError).toBe(true);
    // The verb guard refused it, not something else that also returns an error.
    expect(res.text).toContain('does not hold the verb "invite"');

    const after = (await h.store.getSession(p.sessionId))!;
    expect(after.joinCodes).toEqual(before.joinCodes);
    expect(await eventCount(p.sessionId)).toBe(eventsBefore);
  });

  it("a denied revoke neither retires the live code nor appends an event", async () => {
    // The room must hold a LIVE join code. Without one, a denied revoke and a
    // no-op revoke look identical (no event either way), and this test would
    // prove nothing about where the guard sits relative to the revoke's work.
    // A room that has filled has consumed its code (a pair fills at two), so
    // this is a swarm with room to spare. The seat holds `invite` but not
    // `revoke`, so the refusal can only be about revoke.
    const p = await pairUp(h, { manifest: seat(["send", "invite"], "verb-guards", "swarm") });
    const before = (await h.store.getSession(p.sessionId))!;
    const eventsBefore = await eventCount(p.sessionId);
    // Keeps the setup honest: with no code, "unchanged" below holds of any outcome.
    expect(Object.keys(before.joinCodes).length, "the room must have a live join code").toBeGreaterThan(0);

    const res = await p.joiner.call("bellman_invite", {
      session_id: p.sessionId, member_id: p.joinerMemberId, revoke: true,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('does not hold the verb "revoke"');

    const after = (await h.store.getSession(p.sessionId))!;
    expect(after.joinCodes, "a denied revoke must leave the code live").toEqual(before.joinCodes);
    expect(await eventCount(p.sessionId)).toBe(eventsBefore);
  });

  it("refuses a creator whose own role holds neither verb — a sealed room stays sealed", async () => {
    // tests/manifest.test.ts already declares this manifest legal. It means the
    // room cannot be reopened by anyone, creator included. That is the declared
    // behaviour arriving, not a regression.
    const creator = await h.connect(DEV_KEY.jesse);
    const started = await creator.call("bellman_start", {
      manifest: {
        room: "sealed", mode: "pair",
        roles: { lead: { can: ["send"] }, guest: { can: ["send"] } },
        default_role: "guest", creator_role: "lead",
      },
      brief: brief(),
    });
    expect(started.isError, started.text).toBe(false);

    const res = await creator.call("bellman_invite", {
      session_id: String(started.data.session_id),
      member_id: String(started.data.member_id),
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('does not hold the verb "invite"');
    // Before roles, `session.createdBy` was the only authority to reopen a room, so
    // this creator would have been let through, and `isError` above is the
    // assertion that fails if that rule ever comes back.
  });

  // Same "or recorded" promise as bellman_send's audit test, for both of this
  // handler's branches: a denied issue and a denied revoke must each leave the
  // audit log alone. Both seats are swarms with spare capacity and (for revoke)
  // a live code, for the same reason the mint/retire tests above need them: so
  // a check other than the verb guard cannot be the one answering.
  it("a denied issue records nothing in the audit log", async () => {
    const p = await pairUp(h, { manifest: seat([], "verb-guards", "swarm") });
    const org = p.joiner.identity.orgId!;
    expect(org, "the joiner must be in an org for auditing to run").toBeTruthy();
    const before = (await h.store.auditForOrg(org, 500)).length;

    const res = await p.joiner.call("bellman_invite", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('does not hold the verb "invite"');

    expect((await h.store.auditForOrg(org, 500)).length,
      "a denial must not record an action that never happened").toBe(before);
  });

  it("a denied revoke records nothing in the audit log", async () => {
    const p = await pairUp(h, { manifest: seat(["invite"], "verb-guards", "swarm") });
    const org = p.joiner.identity.orgId!;
    expect(org, "the joiner must be in an org for auditing to run").toBeTruthy();
    const before = (await h.store.auditForOrg(org, 500)).length;

    const res = await p.joiner.call("bellman_invite", {
      session_id: p.sessionId, member_id: p.joinerMemberId, revoke: true,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('does not hold the verb "revoke"');

    expect((await h.store.auditForOrg(org, 500)).length,
      "a denial must not record an action that never happened").toBe(before);
  });
});

// ---------------------------------------------------------------------------
// D2. There are two things called "role" and they are not the same thing.
// Identity.role ("member" | "admin") is platform authority over an org. A room
// role says what you may do inside one session. An org admin is not
// automatically anything in a room.
describe("platform role and room role are different things", () => {
  /**
   * A pair created by `peer` and joined by `jesse`, the org admin, who lands in
   * `manifest`'s default role. The admin has to be the JOINER: the creator takes
   * `creator_role`, and it is the default seat that these tests declare short of a
   * verb. `peer` is on the free plan, so the room is a pair (a swarm needs pro or
   * team). Two facts make these tests about ADMINS, and both are asserted rather
   * than assumed: if jesse stopped being an admin they would prove nothing about
   * admins, and if peer moved to another org they would prove something about a
   * FOREIGN admin, which an org-scoped exemption would never touch.
   */
  async function adminJoins(manifest: Record<string, unknown>) {
    const p = await pairUp(h, { creatorKey: DEV_KEY.peer, joinerKey: DEV_KEY.jesse, manifest });
    expect(p.joiner.identity.role, "the joiner must be an org admin").toBe("admin");
    expect(p.creator.identity.orgId, "the creator must belong to an org").not.toBeNull();
    expect(p.joiner.identity.orgId, "the admin must share the creator's org").toBe(p.creator.identity.orgId);
    return p;
  }

  // Every KIND of send, not just `message`. The scan below cannot see every way to
  // write an exemption, and these behavioural tests are what backs it: an exemption
  // for one kind ("admins may approve") would otherwise slip past all the others.
  // The scan reads src/server.ts and src/tools/, and a surface write's guard lives
  // in src/rooms.ts, so for that kind this row is the only thing that backs it.
  it.each([
    ["message", "send", { text: "I administer this org" }],
    ["artifact", "send", { name: "admin.diff", content: "x" }],
    ["brief_update", "send", brief({ goal: "Restated with administrative authority" })],
    ["action_request", "request_actions", { action: "rerun CI as the org admin" }],
    ["action_response", "respond_actions", { approved: true }],
    ["progress", "send", { note: "ran migration 0042 as the org admin" }],
    ["surface", "write_surface", { key: "plan", kind: "text", body: "the plan, as the org admin" }],
  ] as const)("refuses an org admin's %s in a seat holding nothing", async (type, verb, payload) => {
    const p = await adminJoins(seat([], "admin-holds-nothing"));
    // Each row is built so that a bypassed guard would genuinely SUCCEED and flip
    // isError, rather than be refused by something else: the creator has granted
    // receive_messages and request_actions (pairUp's default), the brief is a valid
    // one, and there is a real request for the response to answer.
    const asked = await p.creator.call("bellman_send", {
      session_id: p.sessionId, member_id: p.creatorMemberId,
      type: "action_request", payload: { action: "rerun CI" },
    });
    expect(asked.isError, asked.text).toBe(false);

    const res = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type, payload, ...(type === "action_response" ? { ref_id: String(asked.data.cursor) } : {}),
    });

    expect(res.isError, res.text).toBe(true);
    expect(res.text).toContain(`your role "guest" does not hold the verb "${verb}"`);
    expect(res.text).toContain("(it holds: none)");
  });

  it("refuses an org admin's invite in a room whose seat lacks it", async () => {
    const p = await adminJoins(seat(["send"], "admin-cannot-invite"));
    // The creator leaves, which frees a seat in the pair. In a full pair a bypassed
    // guard would be refused by the capacity check instead, isError would stay true
    // on its own, and only the text assertion below could tell the two refusals
    // apart. With a seat free, a bypass would really mint. (seat()'s swarm is not
    // available here: peer is on the free plan, and a free plan cannot start one.)
    const left = await p.creator.call("bellman_leave", {
      session_id: p.sessionId, member_id: p.creatorMemberId,
    });
    expect(left.isError, left.text).toBe(false);
    const before = (await h.store.getSession(p.sessionId))!;
    expect(before.members.filter((m) => m.leftAt === null).length, "the room must have a free seat")
      .toBeLessThan(before.maxMembers);

    const res = await p.joiner.call("bellman_invite", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('does not hold the verb "invite"');
  });

  it("refuses an org admin's revoke in a room whose seat lacks it", async () => {
    // The seat holds `invite` but not `revoke`, so only the revoke guard can be
    // what refuses. Revoke is its own verb; an org admin does not get it for free.
    // Without this, a revoke-only exemption for admins would be caught by nothing
    // but the ghost-seat test below, and only because that seat happens to belong
    // to the admin.
    const p = await adminJoins(seat(["send", "invite"], "admin-cannot-revoke"));
    const res = await p.joiner.call("bellman_invite", {
      session_id: p.sessionId, member_id: p.joinerMemberId, revoke: true,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('does not hold the verb "revoke"');
  });

  // The invariant behind all three: no room guard consults identity.role. This is
  // a grep, because that is the property — not any one call's outcome. It reads
  // both spellings, `identity.role` and `identity["role"]`, whitespace tolerated.
  // It is a tripwire for the easy regression, not a proof: destructuring, optional
  // chaining and a helper handed the identity all slip past it, so the behavioural
  // tests above are the real guard.
  it("leaves identity.role used only by bellman_audit", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    // The whole tool layer, not one path. #92 split the tools out of
    // server.ts, and an invariant pinned to a single file stops holding the
    // moment the code it guards moves to another — which is exactly what
    // happened to this assertion. Reading the directory also means a tool
    // added later is covered by existing, rather than by someone remembering
    // to add it here.
    const tools = new URL("../../src/tools/", import.meta.url);
    const files = [
      new URL("../../src/server.ts", import.meta.url),
      ...readdirSync(tools).filter((f) => f.endsWith(".ts")).map((f) => new URL(f, tools)),
    ];
    const readsRole = /identity\s*(?:\.\s*role\b|\[\s*(['"])role\1\s*\])/;
    const hits = files.flatMap((url) =>
      readFileSync(url, "utf8").split("\n")
        .map((line, i) => [`${url.pathname.split("/").pop()}:${i + 1}`, line] as const)
        .filter(([, line]) => readsRole.test(line))
    );
    expect(hits.length, `identity.role at ${hits.map(([where]) => where).join(", ")}`).toBe(1);
    expect(hits[0][1]).toContain("the audit log requires the admin role");
    // Where the one hit is, is the positive control. A scan that never reached
    // src/tools/ would report zero and fail above; naming the file proves the
    // read got there rather than passing on an empty list.
    expect(hits[0][0]).toMatch(/^audit\.ts:/);
  });

  it("never names Identity in src/roles.ts's code", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../src/roles.ts", import.meta.url), "utf8");
    // Comments are stripped first, and must be: the docblock deliberately says
    // "takes a Session and a Member and NOT an Identity" and "DO NOT add an
    // Identity parameter". That warning belongs where an editor sees it, so the
    // assertion is about the code — no import of Identity, no annotation using
    // it — not about the prose explaining why.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(code).not.toContain("Identity");
    // A positive control: stripping must not have eaten the whole file, or this
    // assertion would pass against an empty string.
    expect(code).toContain("export function denyVerb");
  });
});

// ---------------------------------------------------------------------------
// D5 at the tool layer. No tool path produces a seat whose roomRole names no
// role, so this session is written straight into the store.
describe("a seat naming no role holds nothing", () => {
  it("refuses every gated operation", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    await h.store.createSession(session({
      id: "qs_ghost_seat",
      createdBy: jesse.identity.userId,
      orgId: jesse.identity.orgId,
      manifest: roomManifest(),
      members: [
        member({
          memberId: "m_ghost",
          userId: jesse.identity.userId,
          label: jesse.identity.label,
          orgId: jesse.identity.orgId,
          roomRole: "no_such_role",
        }),
      ],
    }));

    for (const [tool, args] of [
      // In this one-member room a bypassed send would still be refused ("no other
      // active members yet"), so for this row the role text below is what tells the
      // guard from that check; isError alone cannot.
      ["bellman_send", { type: "message", payload: { text: "x" } }],
      ["bellman_invite", {}],
      ["bellman_invite", { revoke: true }],
    ] as const) {
      // Two rows share a tool, so the tool alone cannot say which one broke.
      const label = `${tool} ${JSON.stringify(args)}`;
      const res = await jesse.call(tool, {
        session_id: "qs_ghost_seat", member_id: "m_ghost", ...args,
      });
      expect(res.isError, label).toBe(true);
      expect(res.text, label).toContain('your role "no_such_role" does not hold the verb');
      expect(res.text, label).toContain("(it holds: none)");
    }
  });
});

// ---------------------------------------------------------------------------
// Reading is implied by membership and a member must always be able to leave, so
// no verb gates either. A verbless seat is the case that proves it.
describe("sync and leave are never gated", () => {
  it("lets a wholly verbless seat read the room and leave it", async () => {
    const p = await pairUp(h, { manifest: seat([]) });

    // Something to read. A fresh pair holds only the joiner's own member_joined, and
    // sync leaves out the caller's own events, so without this a gate that answered
    // "nothing new" instead of refusing would still pass a test about reading.
    const said = await p.creator.call("bellman_send", {
      session_id: p.sessionId, member_id: p.creatorMemberId,
      type: "message", payload: { text: "the first word in this room" },
    });
    expect(said.isError, said.text).toBe(false);

    const synced = await p.joiner.call("bellman_sync", {
      session_id: p.sessionId, member_id: p.joinerMemberId, since_cursor: 0,
    });
    expect(synced.isError, synced.text).toBe(false);
    expect(envelopes(synced.data.events).map((e) => e.data)).toContainEqual(
      expect.objectContaining({ type: "message", payload: { text: "the first word in this room" } }),
    );

    // Not refused is not the same as left: a gate that answered "left" without
    // leaving would pass an isError check on its own. So read the seat itself in
    // the store, before and after; the "before" keeps the "after" from being vacuous.
    const joinerSeat = async () =>
      (await h.store.getSession(p.sessionId))!.members.find((m) => m.memberId === p.joinerMemberId)!;
    expect((await joinerSeat()).leftAt, "the seat is present before it leaves").toBeNull();

    const left = await p.joiner.call("bellman_leave", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
    });
    expect(left.isError, left.text).toBe(false);
    expect((await joinerSeat()).leftAt, "the seat must actually have left").not.toBeNull();
  });
});
