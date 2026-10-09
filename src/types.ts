export type Plan = "free" | "pro" | "max" | "team";
export type Role = "member" | "admin";
export type SessionMode = "pair" | "swarm";
export type Capability = "read_context" | "receive_messages" | "request_actions";

export interface Identity {
  userId: string;
  orgId: string | null;
  plan: Plan;
  role: Role;
  label: string; // display name, e.g. "jesse@codenerd"
}

/** Provider-neutral description of the agent on this side of the wire. */
export interface AgentInfo {
  provider: string; // "anthropic" | "openai" | "google" | ...
  model: string;    // "claude-fable-5", "gpt-5", ...
  client: string;   // "claude-code", "chatgpt", "gemini-cli", "cursor", ...
}

export interface Brief {
  goal: string;
  state: string;
  constraints: string[];
  open_questions: string[];
  agent: AgentInfo;
}

export interface Member {
  memberId: string; // unique per CONNECTION — same user can join from two machines
  userId: string;
  label: string;
  orgId: string | null;
  capabilities: Capability[];
  roomRole: string; // the manifest role this member holds — NOT Identity.role (admin/member)
  brief: Brief;
  joinedAt: number;
  leftAt: number | null;
  /**
   * When this member was last heard from — any call it made, not a heartbeat.
   * `src/presence.ts` reads it to tell a member that went quiet from one that
   * left, which is what keeps a dead session from holding its seat forever.
   * Absent on rows stored before the field existed; read it through
   * `lastSeen`, which lifts those to `joinedAt`.
   */
  lastSeenAt?: number;
  /**
   * When this member last answered a heartbeat tick with `progress` (#111).
   *
   * Distinct from `lastSeenAt`, which any call moves: this moves only on a
   * deliberate report, because the question it answers is "has this member said
   * where it is", not "is it there". Absent on rows stored before the field
   * existed; read it through `lastReport`, which lifts those to `joinedAt`.
   */
  lastReportAt?: number;
  /**
   * When this member last appended an event (#66), on the server's clock. Housekeeping
   * names a member quiet from this, so it is a SEND and not a sign of life: a call that
   * only reads, like a poll, does not move it, and neither does anything the server
   * wrote about the member. Absent on a member who has sent nothing since joining and on
   * rows stored before the field existed; housekeeping reads both as `joinedAt`.
   */
  lastSentAt?: number;
  /**
   * The cursor of the `member_evicted` event that removed this member, if a
   * creator removed them.
   *
   * Absent on a member still in the room, on one who left of their own accord,
   * on one whose seat timed out, and on every row stored before this field
   * existed — all of which keep the open feed (#113). Absence IS the answer
   * here, so there is no lifting accessor as `lastSeenAt` and `lastReportAt`
   * have: for those, reading `undefined` as "never" would have been actively
   * wrong, and every legacy row would have read as reclaimable.
   */
  removedAtCursor?: number;
}

export type EventType =
  | "member_joined"
  | "member_left"
  | "member_evicted"
  | "member_timed_out"
  | "message"
  | "artifact"
  | "action_request"
  | "action_response"
  | "brief_update"
  | "invite_issued"
  | "invite_revoked"
  | "session_expired"
  /** The server's tick, on the room's cadence. Never sent by a member (#111). */
  | "heartbeat"
  /** A member's answer to a tick. */
  | "progress"
  /** A write to the room's working surface: an item, or its removal (#129). */
  | "surface"
  /** A proposal the server raises from the room's own thresholds (#66). Never sent by a member. */
  | "housekeeping";

/** What a housekeeping proposal is about (#66). */
export type HousekeepingFinding = "member_quiet" | "request_unanswered" | "room_idle";

/**
 * The payload of a `housekeeping` event: identifiers and the server's numbers, never prose,
 * so a proposal carries nothing a reader has to distrust.
 */
export interface HousekeepingPayload {
  finding: HousekeepingFinding;
  /** Who or what: a member for a quiet one, a request's cursor for an unanswered one, absent for an idle room. */
  about?: { member_id: string } | { cursor: number };
  /** When the condition began, ms epoch, the server's clock. */
  since: number;
  /** 1 on the first raise of this key, counting up on each repeat. */
  repeat: number;
}

export interface SessionEvent {
  cursor: number;
  type: EventType;
  fromMemberId: string; // "system" for server-originated events
  fromUserId: string;
  fromLabel: string;
  payload: unknown;
  refId: string | null;
  at: number;
}

/** One live join code, and when it stops resolving. */
export interface JoinCodeRecord {
  code: string;
  expiresAt: number;
}

export interface Session {
  id: string;
  // There is no `mode` here: read session.manifest.mode. Two fields for one fact
  // could disagree.
  manifest: RoomManifest; // immutable after createSession — the store has no way to change it
  createdBy: string;
  orgId: string | null;
  orgOnly: boolean;
  /**
   * Live join codes, one per role. The map key IS the one-per-role invariant:
   * two live codes for the same seat are unrepresentable rather than prevented
   * by a check. Bounded by the manifest, which is immutable after createSession.
   *
   * There is no `joinCode` beside this, for the reason the `mode` comment above
   * gives: two fields for one fact could disagree.
   */
  joinCodes: Record<string, JoinCodeRecord>;
  // There is no `expiresAt`: rooms persist (#18). A room ends when its last
  // member leaves or when nobody has been in it for ABANDONED_AFTER_MS, and
  // that time is derived from the members (`abandonedAt`), never stored.
  // There is no `maxMembers` either: capacity is `capacityOf(manifest)`, two
  // for a pair room and the ceiling for a swarm.
  /**
   * The bytes this room's blob store may hold (#183, D3), stamped at creation
   * from the creator's plan and never consulted against a plan again: a free
   * member in a team room shares the team room's ceiling, which is what "a room
   * is what a plan rations" means. Rows written before the field read the free
   * plan's ceiling through `hydrateStoredSession`.
   */
  blobBytesCeiling: number;
  members: Member[];
  events: SessionEvent[];
  closed: boolean;
  /** When `closed` was set (#65). null while open, and on rows closed before #65. */
  closedAt: number | null;
  /** The window stamped at creation from the creator's plan (#65, D1); null keeps the room until deleted. */
  retainAfterCloseMs: number | null;
  /** A purge asked for by DELETE /rooms/:id (#65, D6): due at this time instead of the window's end. */
  purgeAt: number | null;
  /** Whether the close-time sweep of unnamed objects has run (#65, D3). */
  blobsSwept: boolean;
  /**
   * Set when the plan behind this session lapsed. Frozen is not closed:
   * members stay, history stays readable, and only writes are refused, until
   * the plan is restored. Losing the room would be the wrong punishment for a
   * failed card.
   */
  frozenAt: number | null;
  /**
   * The housekeeping findings raised and not yet cleared (#66), by key: when each was last
   * raised (`at`), how many times (`repeat`), and the `since` of the condition it was raised
   * for, so a condition that came back is told from one that never left. Written by the
   * housekeeping firing and nothing else. Empty on rows stored before this.
   */
  raised: Record<string, { at: number; repeat: number; since: number }>;
  /**
   * The action requests still waiting for an answer (#66), by the request's cursor as a
   * string, with when it was asked and who asked. Kept at the write by `noteAppend` and not
   * derived from the log: every read of the log is bounded, and a request older than the
   * bound must not be forgotten. Kept only for a room that declared housekeeping; `{}`
   * otherwise, and on rows stored before this.
   */
  openRequests: Record<string, { at: number; fromMemberId: string }>;
  /**
   * When a member last appended any event (#66), or null before one has. What the server
   * wrote is not a member event: a tick, a proposal, an eviction and a timeout leave it
   * alone. Kept like `openRequests`, for a room that declared housekeeping.
   */
  lastMemberEventAt: number | null;
  /**
   * When the room was last thawed (#66, R9), or null if it never was. Set by the thaw, in the
   * transition from frozen to not and only there, so a retried thaw leaves it where it was.
   *
   * While a room is frozen nobody can send and no request can be answered, so a finding
   * computed across the freeze would name a condition the room imposed. Heartbeat refuses the
   * same for the tick by crediting every seat at the thaw (`clearSilence`); housekeeping
   * records the moment and the rules floor every base time at it: a member's last send, a
   * request's `at`, the last member event. `Member.lastSentAt` keeps meaning the last send.
   * Null on rows stored before this.
   */
  thawedAt: number | null;
}

export interface PendingConnect {
  token: string;
  sessionId: string;
  userId: string;
  /**
   * The seat the code carried, captured here because bellman_confirm receives
   * only the token. A revoke landing in between therefore does not cancel an
   * in-flight confirm, bounded by the token's own 10-minute TTL. Re-resolving
   * at confirm would be worse: issuing retires the previous code for a role, so
   * a joiner who previewed legitimately would be bumped by an unrelated reissue.
   */
  roomRole: string;
  createdAt: number;
  expiresAt: number;
}

export interface AuditEntry {
  at: number;
  orgId: string | null;
  sessionId: string;
  actorUserId: string;
  action: string;
  detail: Record<string, unknown>;
}

/**
 * A plan granted to an upstream identity at runtime.
 *
 * It carries plan, role and org only — never a userId or label. Those are
 * derived from the provider profile at sign-in, so a grant can never orphan the
 * sessions a human already created under u_<provider>_<subject>.
 */
export interface PlanGrant {
  key: string; // upstream identity key, e.g. "github:4242"
  plan: Plan;
  role: Role;
  orgId: string | null;
  /** Where it came from: "purchase", "operator", ... */
  source: string;
  grantedAt: number;
  grantedBy: string;
  /** Epoch ms after which it stops applying. null means it does not lapse. */
  expiresAt: number | null;
}

export interface Entitlements {
  modes: SessionMode[];
  monthlyCreates: number;
  orgScoping: boolean;
  audit: boolean;
  /**
   * The bytes a room may hold in its blob store (#183, spec D3), charged per
   * room on `chargeBlobBytes` and never against a monthly figure: a room is what
   * a plan already rations.
   */
  blobBytesPerRoom: number;
  /**
   * How long a closed room's record and bytes are kept before the purge (#65,
   * D1): null keeps them until a creator or an org admin deletes the room.
   */
  retainAfterCloseMs: number | null;
}

// The closed set, and why `audit` and `close_room` are not in it, is written up on VERBS in manifest.ts.
export type Verb =
  | "send"
  | "invite"
  | "revoke"
  | "request_actions"
  | "respond_actions"
  | "write_surface";

export type PresetName = "pair" | "swarm" | "review";

export interface RoleDef {
  can: Verb[];
  description: string | null;
  /**
   * Whether a member in this seat must answer the room's heartbeat tick (#111).
   *
   * Separate from the cadence, which is one number for the whole room: the tick
   * is a single event, so per-role intervals would mean several schedules and a
   * partial snapshot. This is the per-role half, and it is what keeps the signal
   * clean — a seat that does no work, like `swarm`'s observer, must not be named
   * silent for behaving exactly as its role describes.
   */
  reports: boolean;
}

export interface RoomManifest {
  room: string;
  purpose: string | null;
  mode: SessionMode;
  roles: Record<string, RoleDef>;
  defaultRole: string;
  creatorRole: string;
  preset: PresetName | null;
  /**
   * How often the server appends a `heartbeat` tick, or null for a room that
   * expects no reports. Immutable with the rest of the manifest, so a peer
   * reading silence reads it against the same number every member was given.
   */
  heartbeatOnMs: number | null;
  /**
   * The thresholds past which the server proposes a housekeeping finding (#66), or
   * null for a room that asked for none. Each is a duration in ms, or null where its
   * finding is off; `repeatAfterMs` null means each finding repeats after its own
   * threshold. Never an object of three null thresholds: `resolveManifest` makes
   * that null, so "off" has one representation. Immutable with the rest of the
   * manifest, and absent on rows written before this, which `hydrateStoredSession`
   * reads as null.
   */
  housekeeping: {
    quietAfterMs: number | null;
    answerWithinMs: number | null;
    idleAfterMs: number | null;
    repeatAfterMs: number | null;
  } | null;
}

/**
 * A preset a person saved (designer spec D2, D4): a room shape without the room,
 * in the author arm's own field names, so citing it hands these fields to
 * `resolveManifest`. Stored and served in this one form (plan ruling R1), and a
 * built-in is shown in it too, with `updated_at` null.
 */
export interface SavedPreset {
  name: string;
  description: string | null;
  mode: SessionMode;
  heartbeat_on: string | null;
  roles: Record<string, { can: Verb[]; description: string | null; reports: boolean }>;
  default_role: string;
  creator_role: string;
  /** ISO 8601 when it was saved; null for a built-in, which never was. */
  updated_at: string | null;
}

/**
 * The kinds a surface item can be (#129). Closed, like SEND_KINDS: every kind a
 * client is shown maps to a shape the server validates, and a kind lands with
 * its validator. `file` and `image` (#183) reference a blob; `html` (#185) is
 * a page inline in body or a blob, never both.
 */
export type SurfaceKind = "text" | "link" | "diagram" | "connector" | "file" | "image" | "html";

/** Where an item sits on the canvas. Nothing bounds x or y: the canvas is infinite. */
export interface Placement {
  x: number;
  y: number;
  w?: number;
  h?: number;
}

/**
 * A blob an item references (#183, D5): the object's metadata as the server
 * stored it, never the writer's claim. The writer names only the id; the
 * server reads the rest off the object when the item is placed.
 */
export interface BlobRef {
  id: string;        // [a-f0-9]{32}
  bytes: number;
  type: string;      // as stored, after D6
  name: string;      // as stored, after D6
}

/**
 * An item as written, normalised: every optional field present as null, so a
 * reader never tells "absent" from "null". `ends` is a connector's two keys;
 * every other kind has none. `body` is markdown for `text`, a URL for `link`,
 * mermaid source for `diagram`, a label for `connector`, the page for `html`
 * unless it names a blob, and absent for `file` and `image`, whose bytes are the
 * blob's.
 */
export interface SurfaceItem {
  key: string;
  kind: SurfaceKind;
  title: string | null;
  body: string | null;
  ends: { from: string; to: string } | null;
  placement: Placement | null;
  /** The blob a `file`, an `image` or a blob-backed `html` item names; null for every other. */
  blob: BlobRef | null;
}

/** An item as stored: the item plus the write that put it there. */
export interface SurfaceRow extends SurfaceItem {
  cursor: number;
  at: number;
  byMemberId: string;
  byLabel: string;
}
