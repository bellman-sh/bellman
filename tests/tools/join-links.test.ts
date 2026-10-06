/**
 * A join code is shared as a link, and the link must carry the code
 * unchanged: the page it opens is rendered from the URL alone, so a code the
 * server mints and the code a person reads on the page are the same string.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brief, manifestFixture } from "../helpers/fixtures.js";
import { pairUp } from "../helpers/flows.js";
import { DEV_KEY, Harness } from "../helpers/harness.js";
import { joinUrl } from "../../src/codes.js";

let h: Harness;

beforeEach(() => {
  h = new Harness();
});

afterEach(async () => {
  await h.close();
});

describe("bellman_start", () => {
  it("returns the link the code is shared as", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const started = await jesse.call("bellman_start", { manifest: manifestFixture(), brief: brief() });
    expect(started.isError, started.text).toBe(false);
    expect(started.data.join_url).toBe(joinUrl(String(started.data.join_code)));
    expect(String(started.data.join_url)).toMatch(/^https:\/\/bellman\.sh\/j\/BELL-/);
  });
});

describe("bellman_invite", () => {
  it("returns the link, and leads the sharing instructions with it", async () => {
    const { creator, sessionId, creatorMemberId } = await pairUp(h, {
      manifest: manifestFixture({ preset: "swarm" }),
    });
    const issued = await creator.call("bellman_invite", {
      session_id: sessionId, member_id: creatorMemberId, role: "helper",
    });
    expect(issued.isError, issued.text).toBe(false);

    const url = String(issued.data.join_url);
    expect(url).toBe(joinUrl(String(issued.data.join_code)));
    expect(String(issued.data.share_instructions)).toContain(url);
    expect(String(issued.data.share_instructions)).toContain(String(issued.data.join_code));
    expect(String(issued.data.share_instructions)).toContain('"helper"');
  });

  // Review Focus 3: a revoke returns join_code: null and must not invent a link for it.
  it("returns no link when revoking", async () => {
    const { creator, sessionId, creatorMemberId } = await pairUp(h, {
      manifest: manifestFixture({ preset: "swarm" }),
    });
    const revoked = await creator.call("bellman_invite", {
      session_id: sessionId, member_id: creatorMemberId, revoke: true,
    });
    expect(revoked.isError, revoked.text).toBe(false);
    expect(revoked.data.revoked).toBe(true);
    expect("join_url" in revoked.data).toBe(false);
    expect(JSON.stringify(revoked.data)).not.toContain("bellman.sh/j/");
  });
});
