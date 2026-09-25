export type Plan = "free" | "pro" | "team";
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
}

export type EventType =
  | "member_joined"
  | "member_left"
  | "message"
  | "artifact"
  | "action_request"
  | "action_response"
  | "brief_update"
  | "invite_issued"
  | "invite_revoked"
  | "session_expired";

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

export interface Session {
  id: string;
  // There is no `mode` here: read session.manifest.mode. Two fields for one fact
  // could disagree.
  manifest: RoomManifest; // immutable after createSession — the store has no way to change it
  createdBy: string;
  orgId: string | null;
  orgOnly: boolean;
  joinCode: string | null;      // null once consumed (pair) or session closed
  joinCodeExpiresAt: number;    // unused-code TTL
  expiresAt: number;            // whole-session TTL
  maxMembers: number;
  members: Member[];
  events: SessionEvent[];
  closed: boolean;
  /**
   * Set when the plan behind this session lapsed. Frozen is not closed:
   * members stay, history stays readable, and only writes are refused, until
   * the plan is restored. Losing the room would be the wrong punishment for a
   * failed card.
   */
  frozenAt: number | null;
}

export interface PendingConnect {
  token: string;
  sessionId: string;
  userId: string;
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
  maxMembers: number;
  sessionTtlMs: number;
  monthlyCreates: number;
  orgScoping: boolean;
  audit: boolean;
}

// The closed set, and why `audit` and `close_room` are not in it, is written up on VERBS in manifest.ts.
export type Verb =
  | "send"
  | "invite"
  | "revoke"
  | "request_actions"
  | "respond_actions";

export type PresetName = "pair" | "swarm" | "review";

export interface RoleDef {
  can: Verb[];
  description: string | null;
}

export interface RoomManifest {
  room: string;
  purpose: string | null;
  mode: SessionMode;
  roles: Record<string, RoleDef>;
  defaultRole: string;
  creatorRole: string;
  preset: PresetName | null;
}
