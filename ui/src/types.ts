/**
 * The wire shapes the UI reads, as the server returns them. Hand-typed copies:
 * the page is built apart from the server programs and only ever reads these,
 * so a field added on the server shows up here when a screen wants it.
 */
export interface Untrusted<T> {
  trust: "untrusted";
  origin: { memberId: string; label: string };
  data: T;
}

export interface RoomBlock {
  preset: string | null;
  mode: string;
  your_role: string;
  your_verbs: string[];
  heartbeat_on_seconds: number | null;
  you_report: boolean;
  creator_role: string;
  roles: Record<string, string[]>;
  reports: Record<string, boolean>;
  text: Untrusted<{ room: string; purpose: string | null; descriptions: Record<string, string | null>; report_instructions?: Record<string, string | null> }>;
}

export interface Brief {
  goal: string;
  state: string;
  constraints: string[];
  open_questions: string[];
  agent: { provider: string; model: string; client: string };
}

/** bellman_connect's structuredContent. */
export interface ConnectResult {
  connect_token: string;
  connect_token_expires_at: string;
  session: { mode: string; active_members: number; max_members: number; org_only: boolean };
  room: RoomBlock;
  creator_brief: Untrusted<Brief>;
}

export interface Beat {
  asked: boolean;
  last_report_at: string | null;
  silent_for_seconds: number;
  silent: boolean;
  note: Untrusted<{ note?: unknown; step?: unknown; eta_seconds?: unknown }> | null;
}

export interface MemberRow {
  member_id: string;
  label: string;
  room_role: string;
  presence: "present" | "stale" | "departed";
  active: boolean;
  beat: Beat;
}

export interface RoomSummary {
  session_id: string;
  status: string;
  expires_at: string;
  max_members: number;
  active_members: number;
  your_member_id: string;
  room: RoomBlock;
  members: MemberRow[];
  join_codes: { role: string; expires_at: string; code?: string; join_url?: string }[];
  last_event: { cursor: number; type: string; at: string } | null;
}

/** bellman_rooms's structuredContent. */
export interface RoomsResult {
  rooms: RoomSummary[];
}

/** The surface kinds the server knows today. A kind the page predates still renders, by name. */
export type SurfaceKind = "text" | "link" | "diagram" | "connector" | "file" | "image" | "html";

export interface Placement {
  x: number;
  y: number;
  w?: number;
  h?: number;
}

/** One item as `surfaceItem` (src/projections.ts) projects it, inside an envelope. */
export interface SurfaceItemWire {
  key: string;
  kind: SurfaceKind | string;
  title: string | null;
  body: string | null;
  ends: { from: string; to: string } | null;
  placement: Placement | null;
  blob: { id: string; bytes: number; type: string; name: string } | null;
  cursor: number;
  at: string;
}

export interface SurfaceBlock {
  cursor: number;
  items: Untrusted<SurfaceItemWire>[];
}

/** bellman_surface's structuredContent, and the part of bellman_confirm's the canvas reads. */
export interface SurfaceResult {
  session_id: string;
  room: RoomBlock;
  surface: SurfaceBlock;
}
