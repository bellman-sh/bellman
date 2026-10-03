import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brief, manifestFixture } from "../helpers/fixtures.js";
import { pairUp } from "../helpers/flows.js";
import { DEV_KEY, Harness, envelopes } from "../helpers/harness.js";

/**
 * A join code is a short-lived invitation, not a room address. That only works
 * if a fresh one can be minted at any point in the session's life — otherwise a
 * long-running swarm room has to gather every member inside the first 15
 * minutes of its existence.
 */

let h: Harness;

beforeEach(() => {
  h = new Harness();
});

afterEach(async () => {
  await h.close();
});

async function eventCount(sessionId: string): Promise<number> {
  return (await h.store.eventsAfter(sessionId, 0)).length;
}

describe("bellman_invite", () => {
  // The description once said reopening the door is "never silent". A room that
  // freezes between the code being set and the event being appended keeps the
  // code and loses the event, so the promise was stronger than the code. The
  // behaviour is pinned in rooms.test.ts; this keeps the sentence from drifting
  // back.
  it("does not promise an event that a freeze can drop", async () => {
    const { tools } = await (await h.connect(DEV_KEY.jesse)).listTools();
    const doc = tools.find((t) => t.name === "bellman_invite")!.description!.replace(/\s+/g, " ");

    expect(doc).not.toContain("never silent");
    expect(doc).toContain("unless the room freezes at that instant");
  });

  it("issues a working code long after the original was consumed", async () => {
    const s = await pairUp(h);
    const stale = await h.connect(DEV_KEY.outsider);

    // The pair filled, so the original code is gone.
    expect((await stale.call("bellman_connect", { join_code: s.joinCode })).isError).toBe(true);

    await s.joiner.call("bellman_leave", { session_id: s.sessionId, member_id: s.joinerMemberId });
    const issued = await s.creator.call("bellman_invite", {
      session_id: s.sessionId,
      member_id: s.creatorMemberId,
    });
    expect(issued.isError, issued.text).toBe(false);
    expect(String(issued.data.join_code)).toMatch(/^BELL-[A-Z2-9]{4}-[A-Z2-9]{2}-PEER-B$/);
    expect(issued.data.replaced_previous).toBe(false);

    const preview = await stale.call("bellman_connect", { join_code: issued.data.join_code });
    expect(preview.isError, preview.text).toBe(false);
  });

  it("retires the previous code the moment a new one is issued", async () => {
    const creator = await h.connect(DEV_KEY.jesse);
    const started = await creator.call("bellman_start", { manifest: manifestFixture({ preset: "swarm" }), brief: brief() });
    const first = String(started.data.join_code);

    const reissued = await creator.call("bellman_invite", {
      session_id: started.data.session_id,
      member_id: started.data.member_id,
    });
    expect(reissued.data.replaced_previous).toBe(true);

    const joiner = await h.connect(DEV_KEY.peer);
    const withOld = await joiner.call("bellman_connect", { join_code: first });
    expect(withOld.isError).toBe(true);
    expect(withOld.text).toContain("not found or expired");

    const withNew = await joiner.call("bellman_connect", { join_code: reissued.data.join_code });
    expect(withNew.isError, withNew.text).toBe(false);
  });

  it("revokes without minting a replacement", async () => {
    const creator = await h.connect(DEV_KEY.jesse);
    const started = await creator.call("bellman_start", { manifest: manifestFixture({ preset: "swarm" }), brief: brief() });

    const revoked = await creator.call("bellman_invite", {
      session_id: started.data.session_id,
      member_id: started.data.member_id,
      revoke: true,
    });
    expect(revoked.isError, revoked.text).toBe(false);
    expect(revoked.data).toMatchObject({ revoked: true, join_code: null });

    const joiner = await h.connect(DEV_KEY.peer);
    expect((await joiner.call("bellman_connect", { join_code: started.data.join_code })).isError).toBe(true);
  });

  /** Reopening the door is a trust event: members should not have to discover it. */
  it("tells the other members the door was reopened, and closed again", async () => {
    const s = await pairUp(h);
    await s.joiner.call("bellman_leave", { session_id: s.sessionId, member_id: s.joinerMemberId });

    await s.creator.call("bellman_invite", { session_id: s.sessionId, member_id: s.creatorMemberId });
    await s.creator.call("bellman_invite", {
      session_id: s.sessionId, member_id: s.creatorMemberId, revoke: true,
    });

    const seen = await s.joiner.call("bellman_sync", {
      session_id: s.sessionId, member_id: s.joinerMemberId, since_cursor: 0,
    });
    const types = envelopes(seen.data.events).map((e) => (e.data as { type: string }).type);
    expect(types).toContain("invite_issued");
    expect(types).toContain("invite_revoked");
  });

  it("is the lead's to give — a joiner seated without `invite` cannot reopen the room", async () => {
    // The default `pair` preset seats the joiner as peer_b, which holds send,
    // request_actions and respond_actions — and neither invite nor revoke.
    const s = await pairUp(h);

    const attempt = await s.joiner.call("bellman_invite", {
      session_id: s.sessionId, member_id: s.joinerMemberId,
    });

    expect(attempt.isError).toBe(true);
    expect(attempt.text).toContain('your role "peer_b" does not hold the verb "invite"');
  });

  it("refuses a code nobody could use, rather than handing out a dead one", async () => {
    const s = await pairUp(h); // pair, now full

    const attempt = await s.creator.call("bellman_invite", {
      session_id: s.sessionId, member_id: s.creatorMemberId,
    });

    expect(attempt.isError).toBe(true);
    expect(attempt.text).toContain("full");
  });

  it("rejects a member handle that is not yours and an unknown session", async () => {
    const s = await pairUp(h);

    const notMine = await s.creator.call("bellman_invite", {
      session_id: s.sessionId, member_id: s.joinerMemberId,
    });
    expect(notMine.isError).toBe(true);

    const nowhere = await s.creator.call("bellman_invite", {
      session_id: "qs_nope", member_id: s.creatorMemberId,
    });
    expect(nowhere.isError).toBe(true);
  });

  it("records issuing and revoking in the org audit log", async () => {
    const s = await pairUp(h);
    await s.joiner.call("bellman_leave", { session_id: s.sessionId, member_id: s.joinerMemberId });
    await s.creator.call("bellman_invite", { session_id: s.sessionId, member_id: s.creatorMemberId });
    await s.creator.call("bellman_invite", {
      session_id: s.sessionId, member_id: s.creatorMemberId, revoke: true,
    });

    const audit = await s.creator.call("bellman_audit", { limit: 100 });
    const actions = (audit.data.entries as { action: string }[]).map((e) => e.action);

    expect(actions).toContain("invite_issued");
    expect(actions).toContain("invite_revoked");
  });

  it("lets a swarm room gather members one at a time", async () => {
    const creator = await h.connect(DEV_KEY.jesse);
    const started = await creator.call("bellman_start", { manifest: manifestFixture({ preset: "swarm" }), brief: brief() });
    const sessionId = String(started.data.session_id);

    const first = await h.connect(DEV_KEY.peer);
    const firstPreview = await first.call("bellman_connect", { join_code: started.data.join_code });
    await first.call("bellman_confirm", {
      connect_token: firstPreview.data.connect_token, brief: brief(),
    });

    // Later: a second project wants in, and the original code is long gone.
    const reissued = await creator.call("bellman_invite", {
      session_id: sessionId, member_id: started.data.member_id,
    });
    const second = await h.connect(DEV_KEY.outsider);
    const secondPreview = await second.call("bellman_connect", { join_code: reissued.data.join_code });
    expect(secondPreview.isError, secondPreview.text).toBe(false);
    const joined = await second.call("bellman_confirm", {
      connect_token: secondPreview.data.connect_token, brief: brief(),
    });

    expect(joined.isError, joined.text).toBe(false);
    expect((joined.data.members as unknown[]).length).toBe(3);
  });

  it("mints a code per role, each resolving to its own seat", async () => {
    const { creator, sessionId, creatorMemberId } = await pairUp(h, { manifest: manifestFixture({ preset: "swarm" }) });

    const a = await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, role: "helper" });
    expect(a.isError, a.text).toBe(false);
    expect(a.data.role).toBe("helper");
    expect(String(a.data.join_code)).toMatch(/-HELPER$/);

    const b = await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, role: "lead" });
    expect(b.data.role).toBe("lead");

    const outsider = await h.connect(DEV_KEY.outsider);
    const preview = await outsider.call("bellman_connect", { join_code: String(a.data.join_code) });
    expect((preview.data.room as { your_role: string }).your_role).toBe("helper");
  });

  it("issuing for one role leaves another role's code live", async () => {
    const { creator, sessionId, creatorMemberId } = await pairUp(h, { manifest: manifestFixture({ preset: "swarm" }) });
    const helper = await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, role: "helper" });
    const lead1 = await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, role: "lead" });

    const lead2 = await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, role: "lead" });
    expect(lead2.data.replaced_previous).toBe(true);

    const outsider = await h.connect(DEV_KEY.outsider);
    expect((await outsider.call("bellman_connect", { join_code: String(lead1.data.join_code) })).isError).toBe(true);
    expect((await outsider.call("bellman_connect", { join_code: String(helper.data.join_code) })).isError).toBe(false);
  });

  it("revoking one role leaves the others live", async () => {
    const { creator, sessionId, creatorMemberId } = await pairUp(h, { manifest: manifestFixture({ preset: "swarm" }) });
    const helper = await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, role: "helper" });
    const lead = await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, role: "lead" });

    await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, role: "lead", revoke: true });

    const outsider = await h.connect(DEV_KEY.outsider);
    expect((await outsider.call("bellman_connect", { join_code: String(lead.data.join_code) })).isError).toBe(true);
    expect((await outsider.call("bellman_connect", { join_code: String(helper.data.join_code) })).isError).toBe(false);
  });

  it("a bare revoke retires every code", async () => {
    const { creator, sessionId, creatorMemberId } = await pairUp(h, { manifest: manifestFixture({ preset: "swarm" }) });
    const helper = await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, role: "helper" });
    const lead = await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, role: "lead" });
    const before = await eventCount(sessionId);

    const revoked = await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, revoke: true });
    expect(revoked.data.revoked).toBe(true);
    // Pins the payload a genuine multi-role revoke reports: both live roles,
    // named — not just the boolean flag the rest of this test checks.
    expect(revoked.data.roles).toEqual(["helper", "lead"]);

    // One invite_revoked event for the whole revoke, not one per role retired.
    expect(await eventCount(sessionId)).toBe(before + 1);

    const outsider = await h.connect(DEV_KEY.outsider);
    expect((await outsider.call("bellman_connect", { join_code: String(helper.data.join_code) })).isError).toBe(true);
    expect((await outsider.call("bellman_connect", { join_code: String(lead.data.join_code) })).isError).toBe(true);
  });

  /**
   * Review Minor 5 / known-issue #8: an expired-but-still-present code is not a
   * live code, so it must not be reported as retired or fire invite_revoked —
   * doing so announces the closing of a door that had already shut by itself.
   * Sets expiresAt directly through the store rather than waiting out the real
   * 15-minute TTL: the bug is in the revoke predicate's `Boolean(...)` check,
   * which never consults expiresAt regardless of how the code got old.
   */
  it("does not report an already-expired code as retired, and stays silent when it is the only one", async () => {
    const creator = await h.connect(DEV_KEY.jesse);
    const started = await creator.call("bellman_start", { manifest: manifestFixture({ preset: "swarm" }), brief: brief() });
    const sessionId = String(started.data.session_id);
    const creatorMemberId = String(started.data.member_id);
    await h.store.setJoinCode(sessionId, "helper", "BELL-EXPIRED-01-HELPER", Date.now() - 1);
    const before = await eventCount(sessionId);

    const revoked = await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, revoke: true });
    expect(revoked.isError, revoked.text).toBe(false);
    expect(revoked.data.roles).toEqual([]);

    expect(await eventCount(sessionId)).toBe(before);
  });

  /** Review Focus 4. */
  it("a bare revoke against a room with no live codes succeeds", async () => {
    const { creator, sessionId, creatorMemberId } = await pairUp(h, { manifest: manifestFixture({ preset: "swarm" }) });
    await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, revoke: true });

    const again = await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, revoke: true });
    expect(again.isError, again.text).toBe(false);
    expect(again.data.revoked).toBe(true);
  });

  it("a real per-role revoke reports the retired role and appends one event; revoking it again is a silent no-op", async () => {
    const { creator, sessionId, creatorMemberId } = await pairUp(h, { manifest: manifestFixture({ preset: "swarm" }) });
    const before = await eventCount(sessionId);

    const revoked = await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, role: "helper", revoke: true });
    expect(revoked.isError, revoked.text).toBe(false);
    expect(revoked.data.roles).toEqual(["helper"]);

    const afterFirst = await eventCount(sessionId);
    expect(afterFirst).toBe(before + 1);

    const again = await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, role: "helper", revoke: true });
    expect(again.isError, again.text).toBe(false);
    expect(again.data.roles).toEqual([]);

    expect(await eventCount(sessionId)).toBe(afterFirst);
  });

  it("refuses a role the manifest does not declare, naming the ones it does", async () => {
    const { creator, sessionId, creatorMemberId } = await pairUp(h, { manifest: manifestFixture({ preset: "swarm" }) });
    const bad = await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, role: "admin" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("lead");
    expect(bad.text).toContain("helper");
  });

  /**
   * Covers the handler's own frozen guard (src/server.ts, returns before
   * setJoinCode is ever reached) — a different guard from the store-level one
   * exercised by tests/store.test.ts's "refuses the writes themselves while
   * frozen, not only the reads", which is the one that actually holds under a
   * concurrent request. This test would still pass if that store-level guard
   * were deleted; it is not meant to cover it.
   */
  it("a frozen room refuses a per-role issue and leaves other codes untouched", async () => {
    const { creator, sessionId, creatorMemberId } = await pairUp(h, { manifest: manifestFixture({ preset: "swarm" }) });
    const helper = await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, role: "helper" });
    await h.store.freezeSession(sessionId, Date.now());

    const denied = await creator.call("bellman_invite", { session_id: sessionId, member_id: creatorMemberId, role: "lead" });
    expect(denied.isError).toBe(true);

    await h.store.freezeSession(sessionId, null);
    const outsider = await h.connect(DEV_KEY.outsider);
    expect((await outsider.call("bellman_connect", { join_code: String(helper.data.join_code) })).isError).toBe(false);
  });
});
