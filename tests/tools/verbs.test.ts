/**
 * The verb guards. #1 declared a room's verbs and enforced none of them; this is
 * the file that turns bellman_connect's preview from stated intent into a fact —
 * for all five verbs: send, request_actions and respond_actions in bellman_send,
 * invite and revoke in bellman_invite.
 *
 * Every KIND of send is denied with the missing verb named, and the room does not
 * move: one row per kind in "a seat that lacks the verb", against the single
 * guard site in bellman_send. An error that still appended an event would be
 * worse than no guard at all. The other tests here pin what the caller hears;
 * they do not each re-assert that the room stood still.
 *
 * Seats are authored rather than taken from a preset because a joiner always gets
 * `default_role` until #3, so a verbless or oddly-shaped joiner seat has to be
 * declared as the default.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Harness, DEV_KEY } from "../helpers/harness.js";
import { pairUp } from "../helpers/flows.js";
import { brief, member, roomManifest, session } from "../helpers/fixtures.js";

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
// Review Focus. The verb guard sits ahead of every check about the message
// (payload, occupancy, recipients, ref_id), so a seat with no authority always
// hears about its own role. The checks about who is calling — session, closed,
// frozen, member, left — still come first, and the last test here pins that.
// Each of the rest passes for the wrong reason if the guard is moved further
// down: the OTHER error appears instead, and the assertions here name it.
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
  it("lets a joiner who holds invite reopen the room", async () => {
    // A swarm room, so there is capacity for a third member and the code is usable.
    const creator = await h.connect(DEV_KEY.jesse);
    const started = await creator.call("bellman_start", {
      manifest: {
        room: "guest-can-invite", mode: "swarm",
        roles: { lead: { can: ALL_VERBS }, guest: { can: ["send", "invite"] } },
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

    const reissued = await joiner.call("bellman_invite", {
      session_id: String(started.data.session_id),
      member_id: String(confirmed.data.member_id),
    });
    expect(reissued.isError, reissued.text).toBe(false);
    expect(String(reissued.data.join_code)).toMatch(/^BELL-/);
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
    const p = await pairUp(h, { manifest: { ...seat(["send"]), mode: "swarm" } });
    const before = (await h.store.getSession(p.sessionId))!;
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
    expect(after.joinCode).toBe(before.joinCode);
    expect(after.events.length).toBe(before.events.length);
  });

  it("a denied revoke neither retires the live code nor appends an event", async () => {
    // The room must hold a LIVE join code. Without one the handler's
    // `if (!session.joinCode) return ok({ revoked: true, ... })` answers before a
    // late guard could matter, and this test would prove nothing about where the
    // guard sits relative to the revoke's work. A room that has filled has consumed
    // its code (a pair fills at two), so this is a swarm with room to spare. The
    // seat holds `invite` but not `revoke`, so the refusal can only be about revoke.
    const p = await pairUp(h, { manifest: { ...seat(["send", "invite"]), mode: "swarm" } });
    const before = (await h.store.getSession(p.sessionId))!;
    // Keeps the setup honest: with no code, "unchanged" below holds of any outcome.
    expect(before.joinCode, "the room must have a live join code").not.toBeNull();

    const res = await p.joiner.call("bellman_invite", {
      session_id: p.sessionId, member_id: p.joinerMemberId, revoke: true,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('does not hold the verb "revoke"');

    const after = (await h.store.getSession(p.sessionId))!;
    expect(after.joinCode, "a denied revoke must leave the code live").toBe(before.joinCode);
    expect(after.events.length).toBe(before.events.length);
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
    // And specifically NOT the old rule, which would have let the creator through.
    expect(res.text).not.toContain("only the session creator");
  });
});

// ---------------------------------------------------------------------------
// D2. There are two things called "role" and they are not the same thing.
// Identity.role ("member" | "admin") is platform authority over an org. A room
// role says what you may do inside one session. An org admin is not
// automatically anything in a room.
describe("platform role and room role are different things", () => {
  it("refuses an org admin seated in a verbless role", async () => {
    // DEV_KEY.jesse is a team-plan ADMIN in org_codenerd. DEV_KEY.peer is a
    // free-plan member, and free plans allow only `pair`, so peer creates.
    const p = await pairUp(h, {
      creatorKey: DEV_KEY.peer,
      joinerKey: DEV_KEY.jesse,
      manifest: seat([], "admin-holds-nothing"),
    });
    expect(p.joiner.identity.role).toBe("admin");

    const res = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "I administer this org" },
    });

    expect(res.isError).toBe(true);
    expect(res.text).toContain('your role "guest" does not hold the verb "send"');
  });

  it("refuses an org admin's invite in a room whose seat lacks it", async () => {
    const p = await pairUp(h, {
      creatorKey: DEV_KEY.peer,
      joinerKey: DEV_KEY.jesse,
      manifest: seat(["send"], "admin-cannot-invite"),
    });
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
    const p = await pairUp(h, {
      creatorKey: DEV_KEY.peer,
      joinerKey: DEV_KEY.jesse,
      manifest: seat(["send", "invite"], "admin-cannot-revoke"),
    });
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
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../src/server.ts", import.meta.url), "utf8");
    const readsRole = /identity\s*(?:\.\s*role\b|\[\s*(['"])role\1\s*\])/;
    const hits = src.split("\n")
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => readsRole.test(line));
    expect(hits.length, `identity.role at lines ${hits.map(([n]) => n).join(", ")}`).toBe(1);
    expect(hits[0][1]).toContain("the audit log requires the admin role");
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
      ["bellman_send", { type: "message", payload: { text: "x" } }],
      ["bellman_invite", {}],
      ["bellman_invite", { revoke: true }],
    ] as const) {
      const res = await jesse.call(tool, {
        session_id: "qs_ghost_seat", member_id: "m_ghost", ...args,
      });
      expect(res.isError, tool).toBe(true);
      expect(res.text, tool).toContain('your role "no_such_role" does not hold the verb');
      expect(res.text, tool).toContain("(it holds: none)");
    }
  });
});

// ---------------------------------------------------------------------------
// Reading is implied by membership and a member must always be able to leave, so
// no verb gates either. A verbless seat is the case that proves it.
describe("sync and leave are never gated", () => {
  it("lets a wholly verbless seat read the room and leave it", async () => {
    const p = await pairUp(h, { manifest: seat([]) });

    const synced = await p.joiner.call("bellman_sync", {
      session_id: p.sessionId, member_id: p.joinerMemberId, since_cursor: 0,
    });
    expect(synced.isError, synced.text).toBe(false);

    const left = await p.joiner.call("bellman_leave", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
    });
    expect(left.isError, left.text).toBe(false);
  });
});
