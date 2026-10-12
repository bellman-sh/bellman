import type { Brief, JoinCodeRecord, Member, RoomManifest, Session } from "../../src/types.js";
import { ENTITLEMENTS } from "../../src/auth.js";
import { resolveManifest } from "../../src/manifest.js";
import { monthKey } from "../../src/stored-session.js";
import { JOIN_CODE_TTL } from "../../src/store.js";

export const anthropicAgent = {
  provider: "anthropic",
  model: "claude-fable-5",
  client: "claude-code",
};

export const openaiAgent = {
  provider: "openai",
  model: "gpt-5",
  client: "chatgpt",
};

export function brief(over: Partial<Brief> = {}): Brief {
  return {
    goal: "Debug flaky invoice reconciliation job",
    state: "Fails ~5% of runs; suspect a race in the webhook handler",
    constraints: ["Rails 7.1"],
    open_questions: ["Idempotency-key collisions under retry storms?"],
    agent: anthropicAgent,
    ...over,
  };
}

/** A manifest as it goes over the wire into bellman_start. */
export function manifestFixture(over: Record<string, unknown> = {}) {
  return { room: "test-room", preset: "pair", ...over };
}

/** The same manifest, already expanded — for building Session objects directly. */
export function roomManifest(over: Partial<RoomManifest> = {}): RoomManifest {
  return { ...resolveManifest(manifestFixture()), ...over };
}

/**
 * A member as the tests seat one: the fields the room's record keeps, `agent` among them, and
 * the brief that the store keeps beside the record (ADR 0018). It is both a `Member` and an
 * `ArrivingMember`, so one fixture both seeds a store and stands in for what it reads back.
 */
export type SeededMember = Member & { brief: Brief };

/** A session whose members are `SeededMember`s: a `Session`, and a `NewSession` to create. */
export type SeededSession = Omit<Session, "members"> & { members: SeededMember[] };

export function member(over: Partial<SeededMember> = {}): SeededMember {
  const b = over.brief ?? brief();
  return {
    memberId: "m_creator",
    userId: "u_jesse",
    label: "jesse@codenerd",
    orgId: "org_codenerd",
    capabilities: ["read_context", "receive_messages"],
    roomRole: "peer_a",
    brief: b,
    agent: b.agent,
    joinedAt: Date.now(),
    lastSeenAt: Date.now(),
    leftAt: null,
    ...over,
  };
}

/** One live code for `role`, expiring in the standard 15 minutes. */
export function oneCode(code: string, role = "peer_b"): Record<string, JoinCodeRecord> {
  return { [role]: { code, expiresAt: Date.now() + JOIN_CODE_TTL } };
}

/** Session fields to seed from, whose members may be read back from a store and so carry no brief. */
export type SessionSeed = Partial<Omit<SeededSession, "members">> & { members?: (Member & { brief?: Brief })[] };

/** A member read back from a store, given a brief again so a room built from it can be created. */
const seeded = (m: Member & { brief?: Brief }): SeededMember => ({ ...m, brief: m.brief ?? brief({ agent: m.agent }) });

export function session(seed: SessionSeed = {}): SeededSession {
  const { members: given, ...over } = seed;
  const now = Date.now();
  const manifest = over.manifest ?? roomManifest();
  return {
    id: "qs_test",
    manifest,
    frozenAt: null,
    createdBy: "u_jesse",
    orgId: "org_codenerd",
    orgOnly: false,
    joinCodes: { [manifest.defaultRole]: { code: "BELL-TEST-01", expiresAt: now + 15 * 60 * 1000 } },
    blobBytesCeiling: ENTITLEMENTS.team.blobBytesPerRoom,
    hostUnitsPerMonth: 0,
    hostUnits: { month: monthKey(now), used: 0, wakes: [] },
    closedAt: null,
    retainAfterCloseMs: null,
    purgeAt: null,
    blobsSwept: false,
    raised: {},
    openRequests: {},
    lastMemberEventAt: null,
    thawedAt: null,
    unpublishedAt: null,
    members: given ? given.map(seeded) : [member()],
    events: [],
    closed: false,
    ...over,
  };
}

/**
 * The pair fixture's roles in a room that holds the ceiling. `capacityOf` reads
 * the mode and nothing else, so this is how a test gets a spare seat beyond two
 * without changing the seats it already names.
 */
export function swarmSession(over: SessionSeed = {}): SeededSession {
  return session({ manifest: roomManifest({ mode: "swarm", preset: null }), ...over });
}
