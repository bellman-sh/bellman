/**
 * Home memory (ADR 0047, decisions 1 and 2): where an account's own notes live. Runtime-free, shared by both
 * stores, the Worker's routes and the tool.
 *
 * A home room is a hidden `SessionDO` per account, holding ADR 0046 `fs:` rows and nothing a room has: no join
 * codes, no events, no listing row. Its id is derived from the account, so resolving it reads no other object and no
 * lost index write can orphan one or make a second. The id never leaves the server.
 */
import { createHash } from "node:crypto";
import type { Identity, NewSession, RoomManifest } from "./types.js";
import { monthKey } from "./stored-session.js";

export const HOME_ID_PREFIX = "qh_";

/** `qh_` and 32 hex characters of sha256 over `"bellman-home:" + userId`. */
export const homeRoomId = (userId: string): string =>
  HOME_ID_PREFIX + createHash("sha256").update(`bellman-home:${userId}`).digest("hex").slice(0, 32);

/** Whether an id names a home room: every room route and `getSession` refuse one as not found. */
export const isHomeRoomId = (id: string): boolean => id.startsWith(HOME_ID_PREFIX);

/** The one seat a home room has, and the writer every home note names: the account, not a room seat. */
export const HOME_MEMBER_ID = "home";

const HOME_MANIFEST: RoomManifest = {
  room: "home",
  purpose: null,
  mode: "pair",
  roles: { owner: { can: [], description: null, reports: false } },
  defaultRole: "owner",
  creatorRole: "owner",
  preset: null,
  heartbeatOnMs: null,
  housekeeping: null,
  host: null,
  public: false,
};

/**
 * The record a home room is created with, by the store, in the write that first needs it. One member, no codes, a
 * `fsBytesCeiling` that is never read: the plan's `homeMemoryBytes` is read on each write instead (decision 12).
 */
export function homeSession(identity: Identity, now: number): NewSession {
  return {
    id: homeRoomId(identity.userId),
    kind: "home",
    manifest: HOME_MANIFEST,
    createdBy: identity.userId,
    orgId: null,
    orgOnly: false,
    joinCodes: {},
    blobBytesCeiling: 0,
    fsBytesCeiling: 0,
    hostUnitsPerMonth: 0,
    hostUnits: { month: monthKey(now), used: 0, wakes: [] },
    retainAfterCloseMs: null,
    closedAt: null,
    purgeAt: null,
    blobsSwept: false,
    raised: {},
    openRequests: {},
    lastMemberEventAt: null,
    thawedAt: null,
    unpublishedAt: null,
    publicName: null,
    publicView: "canvas",
    members: [{
      memberId: HOME_MEMBER_ID,
      userId: identity.userId,
      label: identity.label,
      orgId: null,
      capabilities: [],
      roomRole: "owner",
      brief: { goal: "home memory", state: "", constraints: [], open_questions: [], agent: { provider: "bellman", model: "none", client: "home" } },
      joinedAt: now,
      lastSeenAt: now,
      leftAt: null,
    }],
    events: [],
    closed: false,
    frozenAt: null,
  };
}
