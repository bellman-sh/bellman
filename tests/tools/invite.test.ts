import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brief } from "../helpers/fixtures.js";
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

describe("bellman_invite", () => {
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
    expect(String(issued.data.join_code)).toMatch(/^BELL-[A-Z2-9]{4}-[A-Z2-9]{2}$/);
    expect(issued.data.replaced_previous).toBe(false);

    const preview = await stale.call("bellman_connect", { join_code: issued.data.join_code });
    expect(preview.isError, preview.text).toBe(false);
  });

  it("retires the previous code the moment a new one is issued", async () => {
    const creator = await h.connect(DEV_KEY.jesse);
    const started = await creator.call("bellman_start", { mode: "swarm", brief: brief() });
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
    const started = await creator.call("bellman_start", { mode: "swarm", brief: brief() });

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

  it("is the creator's to give — a joined member cannot reopen the room", async () => {
    const s = await pairUp(h);

    const attempt = await s.joiner.call("bellman_invite", {
      session_id: s.sessionId, member_id: s.joinerMemberId,
    });

    expect(attempt.isError).toBe(true);
    expect(attempt.text).toContain("only the session creator");
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
    const started = await creator.call("bellman_start", { mode: "swarm", brief: brief() });
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
});
