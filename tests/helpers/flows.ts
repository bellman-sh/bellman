import { expect } from "vitest";
import type { Brief } from "../../src/types.js";
import { brief, manifestFixture, openaiAgent } from "./fixtures.js";
import { DEV_KEY, type Harness, type Peer } from "./harness.js";

export interface PairedSession {
  creator: Peer;
  joiner: Peer;
  sessionId: string;
  creatorMemberId: string;
  joinerMemberId: string;
  joinerCursor: number;
  joinCode: string;
}

/**
 * Drive the full two-phase handshake to a joined pair session.
 * Most exchange-level tests need a live session, not the handshake itself.
 */
export async function pairUp(
  h: Harness,
  opts: {
    creatorKey?: string;
    joinerKey?: string;
    creatorCapabilities?: string[];
    joinerCapabilities?: string[];
    creatorBrief?: Brief;
    joinerBrief?: Brief;
    orgOnly?: boolean;
    manifest?: Record<string, unknown>;
  } = {},
): Promise<PairedSession> {
  const creator = await h.connect(opts.creatorKey ?? DEV_KEY.jesse);
  const joiner = await h.connect(opts.joinerKey ?? DEV_KEY.peer);

  const started = await creator.call("bellman_start", {
    manifest: opts.manifest ?? manifestFixture(),
    brief: opts.creatorBrief ?? brief(),
    capabilities: opts.creatorCapabilities ?? ["read_context", "receive_messages", "request_actions"],
    org_only: opts.orgOnly ?? false,
  });
  expect(started.isError, started.text).toBe(false);

  const joinCode = String(started.data.join_code);
  const preview = await joiner.call("bellman_connect", { join_code: joinCode });
  expect(preview.isError, preview.text).toBe(false);

  const confirmed = await joiner.call("bellman_confirm", {
    connect_token: String(preview.data.connect_token),
    brief: opts.joinerBrief ?? brief({
      goal: "Pair from the consumer side",
      state: "Fresh session with dashboard access",
      agent: openaiAgent,
    }),
    capabilities: opts.joinerCapabilities ?? ["read_context", "receive_messages", "request_actions"],
  });
  expect(confirmed.isError, confirmed.text).toBe(false);

  return {
    creator,
    joiner,
    sessionId: String(started.data.session_id),
    creatorMemberId: String(started.data.member_id),
    joinerMemberId: String(confirmed.data.member_id),
    joinerCursor: Number(confirmed.data.cursor),
    joinCode,
  };
}
