import { expect } from "vitest";
import type { Brief } from "../../src/types.js";
import { brief, manifestFixture, member, openaiAgent } from "./fixtures.js";
import { DEV_KEY, type Harness, type Outcome, type Peer } from "./harness.js";

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
    joinAs?: string;
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

  let joinCode = String(started.data.join_code);
  if (opts.joinAs) {
    const invited = await creator.call("bellman_invite", {
      session_id: String(started.data.session_id),
      member_id: String(started.data.member_id),
      role: opts.joinAs,
    });
    expect(invited.isError, invited.text).toBe(false);
    joinCode = String(invited.data.join_code);
  }
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

/** A public swarm room started by jesse, with a permanent code for its default seat (ADR 0020). */
export async function publicRoom(
  h: Harness,
): Promise<{ creator: Peer; sessionId: string; memberId: string; code: string }> {
  const creator = await h.connect(DEV_KEY.jesse);
  const started = await creator.call("bellman_start", { manifest: manifestFixture({ preset: "swarm", public: true }), brief: brief() });
  expect(started.isError, started.text).toBe(false);
  const sessionId = String(started.data.session_id);
  const memberId = String(started.data.member_id);
  const door = await creator.call("bellman_invite", { session_id: sessionId, member_id: memberId, permanent: true });
  expect(door.isError, door.text).toBe(false);
  return { creator, sessionId, memberId, code: String(door.data.join_code) };
}

/**
 * Both phases of joining: the preview's refusal if it refused, else the confirm's outcome. The joiner grants
 * `read_context` unless `capabilities` says otherwise.
 */
export async function joinWith(peer: Peer, code: string, capabilities: string[] = ["read_context", "receive_messages"]): Promise<Outcome> {
  const preview = await peer.call("bellman_connect", { join_code: code });
  if (preview.isError) return preview;
  return peer.call("bellman_confirm", {
    connect_token: String(preview.data.connect_token), brief: brief(), capabilities,
  });
}

/** A room its creator just started, with nobody else in it: the creator holds its one seat. */
export async function startRoom(peer: Peer, manifest: Record<string, unknown> = manifestFixture()) {
  const started = await peer.call("bellman_start", { manifest, brief: brief() });
  expect(started.isError, started.text).toBe(false);
  return { started, sessionId: String(started.data.session_id), memberId: String(started.data.member_id) };
}

/**
 * Another seat for the same account in a room, newer than every seat the room holds: a Claude Code
 * session beside the claude.ai one. A tool is called by the account, so nothing in a call says which.
 */
export async function seatAgain(h: Harness, peer: Peer, sessionId: string, roomRole: string, memberId = "m_second") {
  const at = Date.now() + 1;
  const seat = member({ memberId, userId: peer.identity.userId, label: peer.identity.label, roomRole, joinedAt: at, lastSeenAt: at });
  expect(await h.store.addMember(sessionId, seat)).toBe(true);
}
