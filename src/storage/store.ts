import { type ApprovedBy, type ArrivingMember, type AuditEntry, type Brief, type Member, type NewSession, type PendingConnect, type PlanGrant, type RoomCreator, type PublicView, type Session, type SessionEvent, type SavedPreset, type SurfaceRow, type UserRecord, type OutsideCaller, type OutsideTask, type Org, type OrgIdp, type OrgInvite, type OrgPatch, type ScimToken, type ScimUser, type ScimUserPatch, type PresetName, type SessionMode, type ConfigGovernance, type ConfigName, type ConfigRow, type FsRow, type HomeSettings, type LookupRow, type LookupSource } from "../types.js";
import { type FsRefusal } from "../fs.js";
import { blobBytesUsed } from "../blobs.js";
import type { Ban, BanScope, CreatorBan } from "../bans.js";
import { type IdempotencyRecord } from "./idempotency.js";
import { type StoredSession } from "./stored-session.js";
import type { AuditIntent } from "../grant-audit.js";
import type { AuditSettings, AuditSinkStatus, AuditVerification } from "../audit-sink.js";
import { type SurfaceWrite } from "../surface.js";
import { type Window, type WindowPage } from "../frames.js";
import { type ClosedState, type DecisionPage, type DecisionPageAsk, type DecisionState, type DecisionView, type FailReason } from "../decision.js";
import { type AnswerRequest, type AnswerResult, type AskOutcome, type AskRequest, type CancelRequest, type CancelResult } from "../outside.js";
import type { SendAdmission } from "../send-limit.js";
import type { Suspension } from "../suspension.js";
import type { FiledReport, NewReport, Report } from "../reports.js";
import { type AuditActor, type AuditFacets, type AuditPage, type AuditQuery } from "../audit.js";
import { capacityOf, isPublic } from "../manifest.js";
import { NO_SOCKETS, isActiveMember } from "../members.js";
import { isAbandoned } from "../presence.js";
export type { AuditIntent } from "../grant-audit.js";

/** Fields of a Member that may change after it is created. */
export type MemberPatch = Partial<
  Pick<Member, "capabilities" | "leftAt" | "lastSeenAt" | "lastReportAt">
> & {
  /** A new brief: to the member's row, and its `agent` to the record (ADR 0018). */
  brief?: Brief;
};
// `removedAtCursor` is deliberately absent. It is the append's to write, inside
// the transaction that stores the event it names (#113), and a patch route
// would be a second way to write it — one that could set a cursor no event has.

/**
 * Whether anyone with the room's link may read it (public rooms spec D2): marked public when it
 * started, and not made private since. `=== true` and `== null` because the in-memory store does
 * not hydrate, so a record there may carry neither field.
 *
 * Here, and re-exported by rooms.ts, because the stores decide it too: `setJoinCode` refuses a
 * permanent code to a room that is not public, in the operation that writes the code (ADR 0020).
 */
/** An entry in the public name index (public names spec, D5 as amended): the room that claimed the name, and when. */
export interface PublicNameEntry {
  id: string;
  at: number;
}

/** `listUsers`' order, both stores': first sign-in first, then user id, so equal times still read in one order. */
export const firstSignInFirst = (users: UserRecord[]): UserRecord[] =>
  users.sort((a, b) => a.firstSeenAt - b.firstSeenAt || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));

/**
 * A row of the operator's index of every room (#471), fixed at the room's creation, so the list reads
 * without visiting a room. A close keeps it, and the purge (#65) removes it.
 */
export interface RoomIndexRow {
  sessionId: string;
  /** The creator's `joinedAt`: a room is created with its creator seated (ADR 0019). */
  createdAt: number;
  createdBy: string;
  orgId: string | null;
  preset: PresetName | null;
  mode: SessionMode;
  public: boolean;
  hosted: boolean;
}

export const roomIndexRow = (
  s: Pick<Session, "id" | "createdBy" | "orgId" | "manifest"> & { creator: Pick<RoomCreator, "joinedAt"> },
): RoomIndexRow => ({
  sessionId: s.id, createdAt: s.creator.joinedAt, createdBy: s.createdBy, orgId: s.orgId,
  preset: s.manifest.preset, mode: s.manifest.mode, public: s.manifest.public === true, hosted: s.manifest.host !== null,
});

/** `listRoomsFiltered`'s filters; each one given narrows the page. `org: null` is the rooms with no org. */
export interface RoomFilter {
  createdBy?: string;
  org?: string | null;
  hosted?: boolean;
  publicTrue?: true;
}

export interface RoomCounts {
  total: number;
  groups: { key: string; label: string | null; rooms: number }[];
  next: string | null;
  orgs: (string | null)[];
}

/** A row's place in both stores' order: the time zero-padded, then the id, so newest first is this, descending. */
export const roomIndexKey = (r: Pick<RoomIndexRow, "createdAt" | "sessionId">): string =>
  `${String(r.createdAt).padStart(16, "0")}:${r.sessionId}`;

/**
 * A room's state as the operator reads it (#472), one word by one precedence: a purge a delete asked for
 * (`purgeAt`) over a close, a close over a freeze, a freeze over open. A close is the record's, or abandonment
 * the alarm has not yet acted on (`isAbandoned`), as every read that refuses a closed room decides it. A closed
 * room whose window will purge it is `closed`: only a delete schedules a purge before the window does.
 */
export type RoomStatus = "open" | "closed" | "frozen" | "purge_scheduled";

/**
 * Counts and states, read where the room is (#472): the operator's row beside its index facts, and nothing a
 * member wrote. `events` is the last cursor, which is how many events the room has appended, since cursors run
 * from 1 without a gap. `activeSeats` is the members in the room now, the hosted seat among them.
 */
export interface RoomSummary {
  /** The public name the record holds, else the manifest's. */
  name: string | null;
  /** Whether the room is public now (`isPublic`): the index row keeps the flag it was created with, and unpublishing is one way. */
  public: boolean;
  status: RoomStatus;
  lastEventAt: number | null;
  activeSeats: number;
  capacity: number;
  events: number;
  surfaceItems: number;
  blobBytes: number;
}

/** Both stores' summary, from what each reads where the room is. `connected` is the members a socket vouches for. */
export function roomSummaryOf(
  s: StoredSession,
  last: Pick<SessionEvent, "cursor" | "at"> | undefined,
  surfaceItems: number,
  now: number,
  connected: ReadonlySet<string> = NO_SOCKETS,
): RoomSummary {
  const closed = s.closed || isAbandoned(s, now, connected);
  const status: RoomStatus = closed ? (s.purgeAt !== null ? "purge_scheduled" : "closed") : s.frozenAt !== null ? "frozen" : "open";
  return {
    name: s.publicName ?? (s.manifest.room || null),
    public: isPublic(s),
    status,
    lastEventAt: last?.at ?? null,
    activeSeats: s.members.filter(isActiveMember).length,
    capacity: capacityOf(s.manifest),
    events: last?.cursor ?? 0,
    surfaceItems,
    blobBytes: blobBytesUsed(s),
  };
}

/** What `departedMembers` found: the members it hands back, and how many more matched past its `limit`. */
export interface DepartedMembers {
  members: Member[];
  omitted: number;
}

/** What `appendEvent` already takes: an event without the fields the store fills. */
export type EventBody = Omit<SessionEvent, "cursor" | "at">;

/** What a removal did, reported from inside the transaction that did it. */
/** What `banAccount` is handed: the account and the label it was seen under, the scope, and who asks. */
export interface AccountBanRequest {
  userId: string;
  label: string;
  ban: BanScope;
  now: number;
  byUserId: string;
  audit: readonly AuditEntry[];
}

export interface RemovalOutcome {
  refused: "not_found" | "closed" | "frozen" | "forbidden" | null;
  /** True only when THIS call recorded the member out. */
  removed: boolean;
  /**
   * The role whose code this call retired, or null. Not tied to `removed`: a member
   * who was already out can still have a live code behind them, and shutting it is
   * a write this call makes.
   */
  codeRetired: string | null;
}

/** What a push did (SCIM spec, D5). */
export type ScimCreate = { outcome: "written" | "linked"; user: ScimUser } | { outcome: "exists" | "conflict" | "full" | "no_org" };
/** What an update did (SCIM spec, D6 to D8): the row after and before, or why nothing was written. */
export type ScimUpdate = { outcome: "updated"; user: ScimUser; was: ScimUser } | { outcome: "missing" | "full" | "exists" | "conflict" };

/** The guard and the writes a removal performs, handed in by its caller. */
export interface RemovalRequest {
  now: number;
  /** Leaving a frozen room is never refused; eviction from one is. */
  frozen: "allow" | "refuse";
  /**
   * Record the member out AT THE REMOVAL EVENT'S OWN CURSOR, capping what they
   * read after it (#113) — not only stamping `leftAt`.
   *
   * A property of the caller, not of removal. The two callers differ on it:
   * `evictMember` is a creator deciding someone should be out, and it cuts;
   * `leaveRoom` is the member deciding for themselves, and it does not, because
   * one who chose to go keeps the open feed (R2). `announceReclaimed` says the
   * same of a timeout and warns against adding a cut here for symmetry with the
   * eviction. Read that comment before changing this.
   *
   * No default, deliberately. A removal that did not say reads as one that did
   * not decide, and the one a new caller would forget is the eviction — which is
   * #113 back again, in the operation written to close it.
   *
   * Applied through `markRemoved`, the same rule `appendEvent` applies for its
   * `markRemoved` extra, so a cut recorded by a removal and a cut recorded by an
   * append are one piece of code and cannot drift.
   */
  cut: boolean;
  /** When set, the call is refused unless it matches `session.createdBy`. */
  byUserId?: string;
  /** Written only if this call did the removing. */
  event: EventBody;
  /**
   * Retire this role's code, and write this event and queue this audit, if the code
   * is still live. That holds whether or not this call removed the member: a live
   * code behind one who is already out was never shut. The rows are queued only
   * when a code was retired, so a row says what this call did and not what its
   * caller expected to happen.
   */
  retire?: { role: string; event: EventBody; audit?: readonly AuditEntry[] };
  /**
   * Ban the member's account from this room (spec section 1): its user id and label as the member
   * holds them, stamped `now`. One ban per account, so a room that already holds one keeps it as it
   * is and writes nothing new.
   *
   * Written whether or not this call removed the member, as the door is: someone who left an hour
   * ago can still be banned, and a retry finishes what a failed call began. Never written on a
   * refusal. A removal that only bans, the member already out and no live door behind them, writes
   * no event: a public room's log is public, and the person banned is told only that they can't join.
   *
   * Either scope writes this room's ban. `"all"` also writes the creator's ban from every room they
   * own (`creatorBans`), a separate record: lifting one leaves the other. That one is owed whether or
   * not this room already holds a ban for the account, so an eviction that asks for `"all"` widens a
   * room ban made earlier, and a repeat keeps the first creator-wide ban and writes nothing new. A
   * removal that only widens writes no event, as one that only bans writes none.
   */
  ban?: BanScope;
  /**
   * Queued in the same transaction and delivered by the outbox, only if this call did the removing or
   * wrote this room's ban (`ban`). A ban on someone who already left is an eviction in the audit log's
   * terms, and an org reading it expects every ban there. Not for a creator-wide ban alone: the Durable
   * Objects store cannot tell a first one from a repeat, so a retry would file the row again.
   */
  audit: readonly AuditEntry[];
}

/**
 * What `seatMember` did. `refused` is null exactly when the member is seated.
 *
 * `reclaimed` lists the stale members this call departed to make the room, and
 * it is non-empty only when the seating succeeded — so a caller announcing them
 * is announcing removals that actually happened. A call that cannot free enough
 * seats refuses "full" and removes nobody: a partial reap would remove a member
 * for a joiner that never got in.
 *
 * `codesCleared` says what the seating did: it filled the room and retired the codes
 * the room held, in the same operation that seated the member. A permanent code is
 * kept (ADR 0020): joins are refused while the room is full, and the link on a public
 * page works again when a seat frees. A room that fills with no temporary code left
 * in it reports false, because nothing was cleared, and so does every refusal, which
 * writes nothing. "Filled" means a further joiner would be refused,
 * with no free seat and none reclaimable, which is not the same as every seat being
 * occupied: a stale seat is occupied and still reclaimable, so a room holding one
 * keeps its codes.
 *
 * Nothing in `bellman_confirm` reads it, and nothing announces a retired code: a room
 * that fills has its codes cleared without a word, as `clearJoinCodes` did. The field
 * is here so the outcome says what the seating did. `SessionDO` reads it to decide
 * whether the seating queued registry drops that want delivering, and the contract
 * suite reads it to pin what a seating did.
 *
 * "banned" is an account the room's creator banned (spec section 1). It is refused after "frozen" and
 * before "full", so a banned account is told it cannot join whether or not a seat is free, and never
 * learns that the room is full. Like every refusal it writes nothing.
 */
export interface SeatOutcome {
  refused: "not_found" | "closed" | "frozen" | "full" | "banned" | null;
  reclaimed: Member[];
  /** The seating filled the room and retired the temporary codes it held. False when it held none. */
  codesCleared: boolean;
}

/**
 * What a source-guarded write replaced: `previous` here, `removed` on
 * GrantDelete.
 *
 * No production code reads either field. The store contract suite is their only
 * reader. Billing needed them while it audited for itself, to tell a change
 * from a repeat and to see which org a grant moved out of. The store decides
 * both now: all four guarded writes record their own audit entries in the same
 * operation that makes the change, from the same read they report here (see
 * grant-audit.ts). Nothing depends on the fields, so removing them breaks no
 * caller; it means deleting them from both stores and from the contract cases
 * that pin them.
 *
 * Only the source-guarded pair reports them, because only billing ever needed
 * them. The org-guarded pair answers with the outcome alone: the admin route
 * authored the write and knew what it sent.
 */
export interface GrantWrite {
  outcome: "written" | "conflict";
  previous?: PlanGrant;
}

export interface GrantDelete {
  outcome: "deleted" | "missing" | "conflict";
  removed?: PlanGrant;
}

/**
 * What an idempotent append did.
 *
 * A union rather than an optional `event` field, because the caller must tell
 * four cases apart and two of them have no event: letting the compiler carry
 * that removes a non-null assertion at the one call site that reads the cursor.
 */
export type EventWrite =
  | { outcome: "appended"; event: SessionEvent }
  | { outcome: "replayed"; event: SessionEvent }
  | { outcome: "frozen" }
  | { outcome: "conflict" };

/** What `bellman_send` hands the store to approve a proposal in the response's own transaction (topic rooms spec, D2, R12). */
export interface ProposalApproval {
  /** The cursor of the `action_request` being approved. */
  requestCursor: number;
  /** The surface cursor the proposer read: the proposal's `base`. */
  base: number;
  /** The proposal's write after `resolveSurfaceWrite` settled it (blob metadata filled), or null when the tool found none to apply. */
  write: SurfaceWrite | null;
}

/**
 * What `approveProposal` did. `appended` carries the response and the card's `surface` event, which is null when
 * the seat applied none (R13). `replayed` carries the response the key named and the card that call wrote, read by
 * the cursor the key's record holds, so it is null exactly when the first call wrote none. `stale`, `answered`,
 * `conflict` and `frozen` wrote nothing at all, not even a record. `carried` is the events of the cards an
 * approved locked frame move carried, after the card's (surface frames spec, D2); `refused` is a card the frame
 * rules refuse where the approval writes (an overlap, a missing or full frame), and it too writes nothing.
 */
export type ApprovalWrite =
  | { outcome: "appended"; event: SessionEvent; written: SessionEvent | null; carried: SessionEvent[] }
  | { outcome: "replayed"; event: SessionEvent; written: SessionEvent | null }
  | { outcome: "stale"; cursor: number }
  | { outcome: "answered"; by: string }
  | { outcome: "conflict" }
  | { outcome: "frozen" }
  | { outcome: "refused"; kind: "conflict" | "invalid"; reason: string };

/**
 * What `openDecision` did (ADR 0040). `superseded` is the `decision_closed` that closed the decision the draft
 * replaces, null when it names none. `not_open` refuses a draft whose `supersedes` names a decision that is not
 * open: `state` is that decision's, or null when there is none. `quota` refuses a room or a seat already holding as
 * many open decisions as `decideOpenQuota` allows. A refusal writes nothing, not even the key's record.
 */
export type DecisionOpen =
  | { outcome: "appended"; event: SessionEvent; superseded: SessionEvent | null }
  | { outcome: "replayed"; event: SessionEvent }
  | { outcome: "not_open"; state: DecisionState | null }
  | { outcome: "quota"; scope: "room" | "seat"; limit: number }
  | { outcome: "conflict" }
  | { outcome: "frozen" };

/**
 * What `castVote` did (ADR 0040, decision 3). `closed` on an append is the `decision_closed` the vote decided, null
 * while the rule leaves it open. The refusals write nothing: `stale` names the decision's hash, `closed` the state
 * a closing event already gave it, `not_electorate` a seat outside the snapshot, `quota` a seat past its revisions,
 * `unknown` a cursor with no decision.
 */
export type VoteWrite =
  | { outcome: "appended"; event: SessionEvent; closed: SessionEvent | null }
  | { outcome: "replayed"; event: SessionEvent }
  | { outcome: "stale"; hash: string }
  | { outcome: "closed"; state: DecisionState }
  | { outcome: "not_electorate" }
  | { outcome: "quota"; limit: number }
  | { outcome: "unknown" }
  | { outcome: "conflict" }
  | { outcome: "frozen" }
  // A secret ballot's retry of a key this decision's vote used, whatever its choice: one answer, so a retry cannot
  // tell the stored choice apart (secret ballot spec). An advisory vote on a secret ballot, which takes none.
  | { outcome: "recorded" }
  | { outcome: "advisory_secret" };

/** What `closeDecision` did. `closed` refuses a decision a closing event already ended; `not_due` an expiry before the deadline. */
export type DecisionClose =
  | { outcome: "appended"; event: SessionEvent }
  | { outcome: "closed"; state: DecisionState }
  | { outcome: "not_due" }
  | { outcome: "unknown" }
  | { outcome: "frozen" };

/**
 * What `appendSurface` did: `appendEventOnce`'s outcomes, the events a locked move carried, and a refusal, which
 * carries the kind `placeSurfaceWrite` gave it so a caller maps it without reading its words.
 */
export type SurfaceAppend =
  | { outcome: "appended"; event: SessionEvent; carried: SessionEvent[] }
  | { outcome: "replayed"; event: SessionEvent }
  | { outcome: "conflict" }
  | { outcome: "frozen" }
  | { outcome: "refused"; kind: "conflict" | "invalid"; reason: string };

/** The facts `resolveSurfaceWrite` checks a write against (`BellmanStore.surfaceFacts`). */
export interface SurfaceFacts {
  count: number;
  frames: number;
  rows: SurfaceRow[];
}

/** Who a batch's events are by (surface widget and batch spec, D1): the writing seat, the same on every write in it. */
export type SurfaceAuthor = Pick<EventBody, "fromMemberId" | "fromUserId" | "fromLabel">;

/**
 * What `appendSurfaces` did. `events` is every event the batch appended, in cursor order: each write's own, then the
 * cards a locked frame's move carried. A replay returns the last of them, as the original call's cursor is its last.
 */
export type SurfaceBatchAppend =
  | { outcome: "appended"; events: SessionEvent[] }
  | { outcome: "replayed"; event: SessionEvent }
  | { outcome: "conflict" }
  | { outcome: "frozen" }
  | { outcome: "refused"; index: number; kind: "conflict" | "invalid"; reason: string };

/**
 * What `setJoinCode` did, which a boolean could not say once the write became
 * conditional: `frozen` and `live_code_exists` are different refusals and the
 * caller answers them with different sentences.
 */
export type SetJoinCode =
  | { ok: true; replacedLive: boolean }
  | { ok: false; reason: "frozen" | "live_code_exists" | "not_public" };

/** What a blob charge did (#183, D3). `used` is the room's total after the call, or as it stood when refused. */
export type BlobCharge =
  | { ok: true; used: number }
  | { ok: false; reason: "over_quota" | "frozen" | "closed" | "not_found"; used: number };

/** Whether a hosted-room slot was taken (I7), and when refused, how many the person holds open. */
export type HostedSlot = { ok: true } | { ok: false; open: number };

/**
 * What the hosted seat's write did (hosted seat spec, D3). A refusal says what
 * the room's month has spent (`used`) and may spend (`allowed`), so the seat can
 * say so in its one notice.
 */
export type HostAppend =
  | { ok: true; event: SessionEvent }
  | { ok: false; reason: "not_found" | "closed" | "frozen" | "removed" | "units" | "hourly"; used: number; allowed: number };

/** What `setHostInstructions` answered: the instructions as the room now holds them, or why it took none. */
export type HostInstructionsSet =
  | { ok: true; instructions: string | null }
  | { ok: false; reason: "not_found" | "no_host" | "closed" };

/**
 * One room file write (ADR 0046). `path` is normalized; under `/members/` its id segment is the account's memory id
 * or `me` (`OWN_MEMORY`), which the store resolves to the account's id and assigns on the first write. `restore`
 * names the kept revision whose content becomes the new one.
 */
export interface FsWrite {
  path: string;
  write:
    | { op: "write" | "append"; content: string; baseRev?: number }
    | { op: "edit"; old: string; new: string; baseRev?: number }
    | { op: "delete"; baseRev?: number }
    | { op: "restore"; rev: number; baseRev?: number };
  memberId: string;
  userId: string;
  label: string;
  key: string | null;
}

/**
 * What `appendFs` answered. `forbidden` is a memory path whose id is not the writing account's; `invalid` is a plan
 * refusal (`planWrite`) or a restore of a revision not kept. On a refusal nothing is written.
 */
export type FsAppend =
  | { outcome: "ok"; path: string; rev: number; event: SessionEvent }
  | { outcome: "replayed"; event: SessionEvent }
  | { outcome: "conflict" | "too_large" | "frozen" | "closed" | "not_found" | "forbidden" }
  | { outcome: "invalid"; detail: string }
  | { outcome: "stale"; currentRev: number; content: string; writer: { memberId: string; label: string } | null }
  | { outcome: "over_quota"; used: number; ceiling: number };

/** A file without its content: what a listing or a find hands back. */
export type FsEntry = Omit<FsRow, "content">;
/** A page of `listFs` or `findFs`. `next` is the cursor of the following page, or null. */
export interface FsPage { entries: FsEntry[]; next: string | null }
/**
 * What `writeHome` answered: `appendFs`'s outcomes without an event. `forbidden` is a `/apps/` path, which a home
 * room cannot run. `paused` is a write while the account's human paused home memory (ADR 0047 decision 13); a delete
 * is never paused.
 */
export type HomeAppend = { outcome: "ok" | "replayed"; path: string; rev: number } | FsRefusal | { outcome: "paused" };

/** A governed config write (#414), validated and hashed by the caller; the store adds the revision. */
export interface ConfigWrite {
  name: ConfigName;
  body: unknown;
  sha256: string;
  bytes: number;
  /** The revision the writer read: 0 when creating. */
  baseRev: number;
  /** Narrowing writes are accepted past the room's config reserve. */
  narrowing: boolean;
  governance: Omit<ConfigGovernance, "atRev">;
}

/** What `writeConfig` answered. */
export type ConfigWriteResult =
  | { ok: true; rev: number }
  | { ok: false; reason: "not_found" | "closed" | "over_reserve" }
  | { ok: false; reason: "stale"; currentRev: number };

/**
 * What a delete on demand was told (#65, D6). `purgeAt` is the time the room is stored with: the first
 * request's, whatever time a repeated one asked for. A client that asks again is told when the room goes,
 * and that is the record's word and not the clock of the request that is answering.
 */
export type PurgeSchedule =
  | { ok: true; purgeAt: number }
  | { ok: false; reason: "open" | "missing" };

/**
 * How many ids an index is read for, per call, when its rows are resolved and filtered before the answer
 * is full. The joined index lists every room a person ever held a handle in, closed ones included, in no
 * promised order, and is never pruned (`BellmanStore.sessionsJoinedBy`), so a window the size of the
 * answer, taken before the closed filter, cut live rooms for anyone past 50 memberships, and the cut was
 * permanent. The org index is the same shape (`sessionsForOrg`): open and closed rooms together, in no
 * promised order, so the admin's list asks it for this many and keeps the closed rooms of what it finds,
 * and the monitor's listing asks the joined index for the same. The created index needs no such room:
 * `sessionsCreatedBy` drops closed rows as it meets them.
 *
 * Each id the filter drops costs one `getSession`, so this is also the bound on that spend.
 * ponytail: a person whose live rooms sit past 500 dead memberships loses them from the monitor's
 * listing, and an org whose closed rooms sit past 500 index rows loses them from the admin's list; the
 * upgrade is a status-aware or pruned index, or a summary of the org's closed rooms (#49).
 */
export const JOINED_SCAN = 500;

/**
 * What an append writes BESIDES the event, in the event's own transaction.
 *
 * An explicit argument rather than the store reading `e.type`: nothing in either
 * store branches on an event's kind, and these are the writes that would have
 * made it. The caller already knows it is handling a `progress` send — it checked
 * the verb and validated the payload to get there — so saying so costs it a flag
 * and leaves the store a log that does not interpret what it logs. An eviction is
 * the same: `evictMember` is the one writing the `member_evicted` event.
 *
 * One exception, and it is not a flag: housekeeping's books (#66). `noteAppend` reads
 * an event's type and sender, because the departures that close a member's requests
 * are written by paths no caller flags (`removeMember`, `announceReclaimed`), and a
 * flag every caller had to remember is how the books would go stale. Both stores
 * apply it at the write, for a room that declared housekeeping.
 *
 * It is not an optimisation. The stamp and the event have to commit together or
 * a due tick can read one without the other, and the cut and its event have to
 * commit together or a reader can be refused at a cursor no stored event
 * carries; see `creditReport`, `markRemoved` and `SessionDO.appendEvent`.
 */
export interface AppendExtras {
  /**
   * Credit `e.fromMemberId` with a report at the event's own `at`, monotonically.
   *
   * Applied on an append AND on an idempotent replay. A replay re-asserts the
   * stamp because a caller retrying has no way to know whether the first attempt
   * landed it, and skipping the credit there is what made a lost stamp permanent
   * rather than late.
   */
  creditReport?: boolean;
  /**
   * Record this member out at the event's own cursor, in the event's own
   * transaction. `evictMember` passes it on the `member_evicted` append; see
   * `markRemoved` for why the two writes cannot be separated (#113).
   */
  markRemoved?: string;
  /**
   * Record the event's own `at` as the room's most recent `action_request`.
   *
   * Passed by `bellman_send` on an `action_request` append. Monotonic, and
   * re-asserted on an idempotent replay for `creditReport`'s reason: a caller
   * retrying cannot know whether the first attempt landed it.
   */
  stampActionRequest?: boolean;
  /**
   * Write or remove one surface row in the event's own transaction (#129),
   * under the rule in `applySurfaceWrite`: a newer cursor replaces, an older
   * or equal one is a no-op, `item: null` removes. The row and `surfaceCursor`
   * on the record commit with the event or not at all — a poll reads the
   * cursor off the record and a reader reads the row, and the two must not be
   * allowed to disagree.
   *
   * NOT applied on an idempotent replay, unlike the extras above. The row went
   * in with the event in one transaction, so a replay has nothing to repair, and
   * whatever has happened to the key since carries a higher cursor. A removal
   * leaves no tombstone, so re-applying the original write would find no row to
   * compare against and could only put back what was removed.
   *
   * An item that arrives with no placement is placed first, from the rows the room holds (withPlacement,
   * surface.ts), and the event is appended with the placement the row takes. Both stores do it in the append,
   * before the event is built, and neither does it on a replay.
   *
   * A frame write, or a write into a frame (`isFrameWrite`, frames.ts), goes through `appendSurface`, which
   * places it among the frames; `appendEvent` and `appendEventOnce` throw `FRAME_WRITE_PATH` for one.
   */
  surface?: SurfaceWrite;
  /**
   * The seat whose approval put this version on the surface in a topic room, or that restored it in any room (topic rooms spec, D2 and
   * D5), stamped on the row the `surface` write stores. It is read with `surface` and so, like `surface`, NOT
   * applied on an idempotent replay: the row keeps what the first append stamped. A `surface` write without
   * one stores a row without one, whatever the key held before (R20).
   */
  approvedBy?: ApprovedBy;
  /**
   * An outside caller's task (A2A), written in the event's own transaction: the row and the event commit together or
   * not at all. For an `outside_question` the row is handed in WITHOUT this event's cursor, which the store assigns and
   * appends (`taskWithEvent`); any other event writes the row as given. A row for a task of another room throws, so the
   * append writes nothing. Used with `appendEvent`; not meaningful on `appendEventOnce`.
   */
  outsideTask?: OutsideTask;
  /** The caller's standing in the room (context and visitor number), stored with the task. A repeat replaces the row. */
  outsideCaller?: OutsideCaller;
}

/**
 * Storage boundary. Everything stateful goes through this interface so the
 * in-memory implementation can be replaced by Durable Objects / SQLite / Redis
 * without touching tool logic.
 *
 * EVERY METHOD IS ASYNC, including ones an in-memory store answers instantly.
 * That is not incidental. A Durable Objects port resolves a join code in one
 * DO and the session it names in another, and every cross-DO hop is RPC. A
 * synchronous signature here would be implementable only by MemoryStore, which
 * would make this interface a comment rather than a seam.
 *
 * Read methods return DETACHED copies. Callers must never mutate what they read
 * back and expect it to stick — every write has an explicit method here. That
 * rule is what makes the interface portable: a database-backed store cannot
 * hand out live references, so relying on them would silently break the port.
 */
export interface BellmanStore {
  createSession(s: NewSession): Promise<void>;
  /**
   * The session record and its members. NOT its events.
   *
   * Returning StoredSession rather than Session is what stops #25 coming
   * back: a handler that reaches for history no longer compiles, so it has
   * to call eventsAfter or eventAt and say which events it wants.
   */
  getSession(id: string): Promise<StoredSession | undefined>;
  /**
   * Resolve a code to its session and the role it carries.
   *
   * The whole rendered string is the key, role group included, so a code with a
   * hand-edited suffix was never issued and does not resolve. The role comes
   * from the record, never from reading the string — there is no code path that
   * parses a suffix, which is what makes the tamper case fail closed.
   */
  getSessionByJoinCode(code: string): Promise<{ session: StoredSession; role: string } | undefined>;

  /** Retire one role's code. Idempotent. */
  consumeJoinCode(sessionId: string, role: string): Promise<void>;

  /** Retire every live code — a pair session filling, a session closing. Idempotent. */
  clearJoinCodes(sessionId: string): Promise<void>;

  /**
   * Issue a code for one role, retiring only that role's previous code.
   *
   * `guard.replaceLive` is the `revoke` authority, and it is decided HERE rather
   * than by the caller because the two cannot be separated. `issueInvite` used
   * to read the roster, see no live code, and then call this — so two callers
   * holding `invite` and not `revoke` could both observe no live code, and the
   * second write would retire the first's code with neither of them allowed to
   * (#90, found in review). The check and the write are one operation now: this
   * is the only place that can make them one, because it is the only place that
   * holds the record and the write together.
   *
   * `now` is a parameter so that liveness is the caller's clock, as it is for
   * `seatMember`: an expired code is not a live one, and minting over it is
   * opening a shut door rather than replacing an open one.
   *
   * A null `expiresAt` is a permanent code (ADR 0020), refused `not_public` unless
   * the room is public, decided here for the reason `replaceLive` is: a room made
   * private between the caller's read and this write has already retired the
   * permanent codes it held, and would otherwise keep this one.
   */
  setJoinCode(
    sessionId: string,
    role: string,
    code: string,
    expiresAt: number | null,
    guard: { replaceLive: boolean; now: number },
  ): Promise<SetJoinCode>;
  /**
   * Append a member to a session, unless it is frozen or closed. False means
   * refused — frozen, closed, or no such session — and a caller that has to say
   * which reads the session again.
   *
   * No production path calls this today. The join is `seatMember`, which makes
   * these same refusals and also allocates the seat, and only tests use this
   * one. It stays as the unconditional append, for the contract suite and for a
   * caller that is not allocating a seat, the same relationship `closeSession`
   * has to `closeSessionIfEmpty`. Do not read its presence as behaviour anything
   * depends on.
   *
   * The refusals are here rather than only in a tool, because a tool reads the
   * session and then writes, and a freeze landing in that gap would let a
   * frozen room grow — which is the one thing freezing is for. A close landing in
   * it is the same gap with a worse result: a member seated in a room that is
   * over. Like `seatMember`'s, this is the other half of `closeSessionIfEmpty`,
   * which keeps a close from landing on an occupied room; the pair is sound only
   * together. Unlike the cross-object races on #59 and #62, both halves live in
   * the same object, so this one can simply be made not to have a gap.
   */
  addMember(sessionId: string, member: ArrivingMember): Promise<boolean>;
  /**
   * Seat a member, reclaiming stale seats if that is what it takes, as ONE
   * operation.
   *
   * This is the production join path; `addMember` is the unconditional append,
   * kept for the contract suite and for a caller that is not allocating a seat,
   * the same relationship `closeSession` has to `closeSessionIfEmpty`.
   *
   * It cannot be three calls, and it was. A tool that reclaimed, re-read, checked
   * capacity and then appended handed two concurrent confirms a window to agree
   * on the same free slot: both would reap the same victim, both announce it,
   * both pass the check, and the room would end with more members than it has
   * seats. Worse, a `bellman_sync` landing in the window makes a member live
   * again *after* the reclaim decision was taken against it, and a freeze
   * landing there removes a member from a room that is meant to cost nobody
   * their place. Deciding and writing inside the object closes all three: the
   * Durable Objects store is one transaction, and MemoryStore does not yield
   * between the read and the write — the rule `closeSessionIfEmpty` and the
   * guarded grant writes already follow.
   *
   * `staleBefore` is the cutoff, so the store holds no presence policy: a member
   * last heard from before it may lose its seat. Pass `Date.now()` for `now` so
   * the departure stamp and the joiner's `joinedAt` agree.
   *
   * Refuses rather than partially reaping. Reclaiming one of two seats a joiner
   * needs would remove a member for somebody who never got in.
   *
   * When the seat it took fills the room, it also retires every role's temporary join
   * code, keeping a permanent one (ADR 0020), and `codesCleared` says whether there was
   * one to retire. That was
   * `bellman_confirm`'s second call, made once the seat had committed with nothing
   * spanning the two, and a failure there left the member in the room with no event,
   * no audit row and no member_id returned, and a connect token that is single use
   * and so could not replay (#116). "Fills" means a further joiner would be refused,
   * which is `seatVictims` answering null once this member is in: not a count of
   * undeparted members, because a stale seat is occupied and still reclaimable.
   *
   * An account the room has banned (`RemovalRequest.ban`) is refused "banned" whatever seat it asks
   * for: after the frozen refusal and before any seat is counted, so a full room does not tell a
   * banned account it is full. The check is inside the operation for the reason the others are: a ban
   * landing between a caller's read and this write would otherwise seat the account it was made against.
   */
  seatMember(
    sessionId: string,
    member: ArrivingMember,
    staleBefore: number,
    now: number,
  ): Promise<SeatOutcome>;
  /**
   * Record a member out of a room, say so, and retire their seat's code — as ONE
   * operation.
   *
   * It cannot be four calls, and it was. `leaveRoom` read `leftAt` and wrote it
   * with an await between, so two calls on one handle both saw null and both
   * announced (#117). `evictMember` checked `closed` and `frozenAt` against a
   * snapshot and mutated afterwards, so a freeze landing in the window either
   * wrote to a room whose writes had stopped or swallowed the event the bridge
   * disarms its watcher on (#118). And a leave from a frozen room lost its event
   * outright, because the public append refuses while frozen (#73).
   *
   * The caller hands the event bodies in. The store writes the record it was
   * given and never asks what an event means — the constraint #147 set. The
   * frozen refusal stays on `appendEvent`, which is a different operation: this
   * one declares its own policy through `frozen`, so a leave records its
   * departure in a frozen room without the store learning that `member_left` is
   * special.
   *
   * `req.cut` says whether the removal also caps what the member reads after it,
   * at the departure event's own cursor (#113). The store applies `markRemoved`
   * for it, inside the same write — so the cut and the event it names commit
   * together, which is the whole of why it is not a call afterwards. Only the
   * caller knows: an eviction cuts and a leave does not. See `RemovalRequest.cut`.
   *
   * `removed: false` with `refused: null` is the idempotent path: the member was
   * already out. The departure is not written or queued again, so a retry
   * announces no second one. What is still owed is a live code behind them: a
   * leave retires none, so it was never shut, and shutting it is a write that has
   * not happened yet and not a duplicate of one that has. `codeRetired` says so.
   * A ban asked for (`req.ban`) that the room does not hold yet is owed the same
   * way: written whether or not this call removed the member, and with no event
   * when it did not. With no live code and no ban owed, nothing is written and
   * nothing is queued at all. Closing the room if it has emptied is NOT part of
   * this — `closeSessionIfEmpty` makes that decision atomically on its own, and
   * folding it in here would close over a member who joined in the gap. The
   * creator-wide ban that `"all"` asks for is owed the same way as a room ban.
   *
   * A removal that records the member out also writes, after the departure, what
   * `removalEvents` says into every decision no event has closed (ADR 0040,
   * decision 12): the seat's votes voided, and the close that leaves due. Each
   * with its rows, filed to the orgs `req.audit` names (`decisionAudit`).
   */
  removeMember(
    sessionId: string,
    memberId: string,
    req: RemovalRequest,
  ): Promise<RemovalOutcome>;
  /**
   * The accounts banned from this room, oldest first (spec section 1). An unknown room answers
   * none. Each carries the user id, because the store keeps it: what reaches a creator is
   * `banView`, which leaves it out.
   */
  roomBans(sessionId: string): Promise<Ban[]>;
  /**
   * Lift one ban by its id, as ONE operation, and say whether there was one. A second lift of
   * the same id, an id the room never issued and an unknown room all answer false, and so does a
   * string that is not shaped like a ban id (`isBanId`), without storage being read: the id is a
   * creator's input, and Durable Object storage limits a key to 2 KiB. It removes the
   * ban and nothing else: the member the ban came with stays out, and the account seats again
   * wherever a door is open to it.
   */
  liftRoomBan(sessionId: string, banId: string): Promise<boolean>;
  /**
   * The accounts this creator banned from every room they own (spec section 1), oldest first. Each
   * carries the user id and the room it was made in: what reaches a creator is `creatorBanView`, which
   * leaves the user id out. A room's ban and the creator-wide ban that came with it are separate records.
   */
  creatorBans(creatorId: string): Promise<CreatorBan[]>;
  /**
   * Lift one of this creator's bans by its id, as ONE operation, and say whether there was one. A
   * second lift, another creator's id and a string that is not shaped like a ban id (`isBanId`) all
   * answer false, the last without storage being read. It lifts that ban and nothing else: the room
   * ban that came with it stays.
   */
  liftCreatorBan(creatorId: string, banId: string): Promise<boolean>;
  /**
   * Whether this creator banned this account from every room they own. The join check, asked of the
   * room's creator once a code has resolved: the registry's code rows do not know who made the room.
   */
  isBannedByCreator(creatorId: string, userId: string): Promise<boolean>;
  /**
   * Whether this room bans this account, in one read. The preview's check, so a banned account is refused before the
   * room is described to it. The seating decides for itself (`seatMember`), where a ban landing after this read is seen.
   */
  isBannedFromRoom(sessionId: string, userId: string): Promise<boolean>;
  /**
   * Suspend an account (abuse protections spec, section 1): every authenticated call that reads or writes
   * the store as it is then refused (plan ruling R8). The registry keeps it, one row an account, and a
   * repeat replaces the note.
   */
  suspend(userId: string, s: Suspension): Promise<void>;
  /** Lift a suspension, and say whether there was one. */
  unsuspend(userId: string): Promise<boolean>;
  /** One read. The Worker keeps the answer a minute per isolate (`SuspensionCache`); the Node server asks each time. */
  isSuspended(userId: string): Promise<boolean>;
  /**
   * File a report (abuse protections spec, section 3), as ONE operation: the fold, the limit and the write are one
   * step, so two filings cannot both pass the limit's count or both miss each other's fold. A repeat of a target the
   * account already has open (R9) answers `folded` with that report, and writes nothing: no new row, and no place in
   * the limit's count. Once the first is resolved a repeat files anew. At 10 filings in the last rolling 24 hours
   * (R10) the answer is `limited`, with how long until the oldest leaves the window, and nothing is written.
   * Otherwise the report is stored and answered `filed`, which is the answer a caller sends its email on.
   *
   * The registry keeps reports. They are about the platform and not about a room, so a room's purge leaves them.
   */
  fileReport(r: NewReport, now: number): Promise<FiledReport>;
  /**
   * A room's reports about members and messages, for its creator (spec section 3), newest first. None about the
   * room itself, none from another room, and none for a creator who did not make it. None about the creator's own
   * seats or messages either (`reachesCreator`): a creator is not told that one was filed about them, and those reach the
   * operators alone. What reaches a creator is a view that leaves out who filed the report: the store keeps the reporter,
   * and this answers it whole.
   */
  roomReports(creatorId: string, sessionId: string): Promise<Report[]>;
  /**
   * The operator's queue, at most `limit` in all: the open reports first, newest first, then the resolved ones, newest
   * first. Open first because an open report an operator cannot find is a report never acted on, and a queue cut at
   * `limit` newest-first would leave the oldest open one behind however many newer ones had been resolved.
   */
  listReports(limit: number): Promise<Report[]>;
  /**
   * Close a report with a note, as ONE operation, and answer it as it now stands. The first resolution stands: a
   * resolved report is answered as it is, and the second note is not kept. An unknown id answers undefined. It also
   * ends the fold (R9) and schedules the report's deletion 180 days on (R15). `MemoryStore` deletes in `sweep` and
   * the Durable Objects store on the registry's alarm, under the handler `report_purge`.
   */
  resolveReport(id: string, resolution: { note: string; by: string }, now: number): Promise<Report | undefined>;
  /**
   * The members of this room that a live socket vouches for right now (#146).
   * Presence reads it beside `lastSeenAt`: a member fed by the local bus or by
   * the room's WebSocket never calls `bellman_sync`, so it never says anything
   * and would read stale after ten minutes with its connection open. See
   * `connectedAmong` for which members a socket vouches for, and what that
   * costs. An unknown session answers nobody.
   *
   * For reading: a preview, a roster, a capacity count. Nobody is removed from
   * this answer. `seatMember` decides that, and reads the sockets itself inside
   * the operation, because an answer fetched first is old by the time it is
   * used, and a member can connect or drop in the gap.
   *
   * MemoryStore has no socket to a room and answers nobody. SessionDO answers
   * from the sockets it holds.
   */
  connectedMembers(sessionId: string): Promise<ReadonlySet<string>>;
  /** Patch a member's mutable fields. Unknown session/member is a no-op. */
  updateMember(sessionId: string, memberId: string, patch: MemberPatch): Promise<void>;
  /**
   * The briefs of these members, by member id (ADR 0018). Each lives beside the room in a
   * row of its own, not on the record `getSession` returns. An id with no brief is left out,
   * and an unknown session answers none.
   */
  getBriefs(sessionId: string, memberIds: readonly string[]): Promise<Record<string, Brief>>;
  /**
   * A member of this room by id, in the room or gone from it (ADR 0019). `getSession` holds
   * only the members in the room now, so this is how a caller who has left is read. Undefined
   * for an id the room never seated, and for an unknown room.
   */
  getMember(sessionId: string, memberId: string): Promise<Member | undefined>;
  /** The members with these ids, in join order, gone or not. An id the room never seated is left out. */
  getMembers(sessionId: string, memberIds: readonly string[]): Promise<Member[]>;
  /** Every handle this person has held in the room, in join order, those that have left included. */
  membersOfUser(sessionId: string, userId: string): Promise<Member[]>;
  /**
   * The members who have left, in join order (ADR 0019, D7). With `leftAfter`, only those
   * who left after that time. With `limit`, only the `limit` who left most recently, and
   * `omitted` counts the others that matched.
   */
  departedMembers(sessionId: string, opts?: { limit?: number; leftAfter?: number }): Promise<DepartedMembers>;
  /**
   * The public number of each of these labels (ADR 0019, D6), which a public room shows as
   * "member N". A label the room has not numbered is left out: the hosted seat's, and any
   * label no member of the room holds.
   */
  publicNumbers(sessionId: string, labels: readonly string[]): Promise<Record<string, number>>;
  /**
   * Mark a session closed, whoever is in it. Idempotent. To close a room because
   * it has emptied, use `closeSessionIfEmpty`: deciding that from a read and then
   * calling this is the gap it exists to close.
   *
   * No production path calls this today. The room operations close through
   * `closeSessionIfEmpty`, and only tests use this one. It stays as the
   * unconditional close, which the close-a-room route #49 lists will need, and
   * for the contract suite to set a room up closed. Do not read its presence as
   * behaviour anything depends on.
   */
  closeSession(sessionId: string): Promise<void>;
  /**
   * Close a session if nobody is in it. Resolves to whether the session IS closed
   * when this returns, and not to whether this call closed it, which is how the
   * name reads: true for a room this call closed and for one that already was,
   * false for a room left open because a member is in it, and for one that does
   * not exist.
   *
   * The check and the write are one operation, and cannot be two. A caller that
   * read the roster, saw it empty and then called `closeSession` would leave a
   * window for a member to join in, and the room would close over them with its
   * codes retired. Here the Durable Objects store decides inside the one object
   * that owns the session, in one transaction, and MemoryStore does not yield
   * between the two. `seatMember`'s refusal of a closed session is the other half,
   * and `addMember`'s is the same refusal: this keeps a close from landing on an
   * occupied room, those keep a join from landing on a closed one, and neither is
   * enough alone.
   *
   * "Nobody" is no member for whom `isActivePerson` holds: `isActiveMember`, and
   * not the hosted seat (#188). The host is not a person, so a hosted room closes
   * when its last person leaves, as a room without one does, with the seat still on
   * the roster. A frozen room closes like any other: freezing refuses writes into a
   * room someone is in, and an empty one is over either way.
   *
   * The answer is a state and not an event, on purpose, and DurableObjectStore
   * depends on it. An already-closed room answers true whoever is listed in it.
   * A close can die after the room is marked closed and before the registry drops
   * its codes, and the retry has to read the room as closed to finish that: "did
   * this call close it" would answer false there, and leave the rows for good.
   */
  closeSessionIfEmpty(sessionId: string): Promise<boolean>;
  /** Freeze or thaw a session. null thaws. */
  freezeSession(sessionId: string, frozenAt: number | null): Promise<void>;
  /**
   * Ask for a closed room to be purged at `at` rather than at the end of its window (#65, D6):
   * the delete on demand. Resolves to `{ ok: true, purgeAt }` for a closed room, `reason: "open"`
   * for a room that has not closed, which a delete never closes, and `reason: "missing"` for a room
   * that is not there, a purged one included. The purge itself is the store's own to carry out, by
   * `sweep` for MemoryStore and by the room's alarm for the Durable Objects store, so `ok` means
   * asked, not done.
   *
   * Asking again changes nothing and files nothing: the first request stands. A client that
   * retries a delete it never heard the answer to is the case, and the audit log owes one
   * `room_deleted` for each org on the roster, naming who asked, however often it was asked.
   * `purgeAt` says the same of the time: it is the one the room is stored with, the first
   * request's, and a repeat is told that and not the `at` it asked for. `by` is who asked, named
   * as an audit row names an actor so each org's row can say whether the delete was its own or
   * another's, and null when the caller is not a person.
   */
  schedulePurge(sessionId: string, at: number, by: AuditActor | null): Promise<PurgeSchedule>;
  /**
   * Make a public room private for good (public rooms spec D2): set `unpublishedAt` to `at`, once.
   * The first time stands, so a retry changes nothing, and a room that is not there is left not
   * there: nothing is written for it. Who may ask is the route's to decide, as for `schedulePurge`.
   * An open room and a closed one alike: a closed public room is readable until its purge (D7).
   *
   * The same write retires the room's permanent codes (ADR 0020): a private room's door is a
   * code that runs out. Its temporary codes are left to run out as they would have.
   */
  unpublishSession(sessionId: string, at: number): Promise<void>;
  /**
   * The public name index's entry for `name`, or null (public names spec, D5): which room claimed it,
   * and when. A hint: whoever reads it checks the room's record (`holdsName`), which is the truth.
   */
  publicNameEntry(name: string): Promise<PublicNameEntry | null>;
  /**
   * The first `limit` entries of the public name index, by name: the rooms that may hold a name
   * (public names spec, D5). Hints, as `publicNameEntry` is: a reader checks each room's record.
   * The only listing of public rooms there is: a room public by its id alone is in no index.
   */
  publicNameEntries(limit: number): Promise<{ name: string; entry: PublicNameEntry }[]>;
  /**
   * Set `name`'s entry to `entry` if it is still `expected` (null for no entry), compared whole and in
   * one step, so of two claims that read the same entry exactly one wins. True when this one did.
   */
  claimPublicName(name: string, entry: PublicNameEntry, expected: PublicNameEntry | null): Promise<boolean>;
  /** Remove `name`'s entry if it is still `expected`, in one step: a claim given back. True when it was. */
  releasePublicName(name: string, expected: PublicNameEntry): Promise<boolean>;
  /** Write `name` on the room's record, which is what holds a name (D5). A room that is not there stays not there. */
  setPublicName(sessionId: string, name: string): Promise<void>;
  /** Write how the room's public page opens on its record (room pages spec, D3). A room that is not there stays not there. */
  setPublicView(sessionId: string, view: PublicView): Promise<void>;
  /**
   * The close-time sweep (#65, D3), run now: delete every object under this closed room's prefix
   * that no surface item names, and credit the room's `blobBytes` with their sizes. They are the
   * uploads that never reached an item: a put whose answer was lost, and a charge that threw and
   * was kept on purpose (#183). Resolves to how many objects it removed and how many bytes that
   * freed.
   *
   * Nothing happens to a room that is open, whose unnamed object is an upload between its put and
   * its charge or its item, or to one that is not there: `{ removed: 0, credited: 0 }`.
   *
   * The credit lands once. Two sweeps that overlap list the same objects and free the same bytes,
   * and the first to commit sets `blobsSwept`; the other changes the bucket and nothing else.
   *
   * MemoryStore calls this as a room closes, and from `sweep` for a room whose close it did not
   * see; the Durable Objects store calls it from the room's alarm, due the moment the room closes
   * and never again.
   */
  sweepBlobs(sessionId: string): Promise<{ removed: number; credited: number }>;
  /**
   * Sessions this user created that are not closed — newest first is not
   * promised, only that a lapsed plan can find the rooms it has to freeze. The
   * create *counts* used for quota cannot answer that: they are timestamps, not
   * identities.
   *
   * Closed rooms are left out, and `limit` counts the rooms returned rather than
   * the index rows read. Both halves are the same fix: the listing applied
   * `limit` to raw rows, so a prolific account's walk filled its window with
   * long-dead rooms and never reached the live ones — a freeze that silently did
   * nothing for exactly the accounts that use Bellman most (#75, #115). An
   * abandoned room counts as closed here whether or not its alarm has fired.
   *
   * A frozen room is still listed. Freezing one twice is harmless, and leaving it
   * out would hide it from the only listing that can find it again.
   *
   * The rows of the closed rooms it passes are deleted as it meets them, so the
   * index no longer grows for the life of an account and a dead room is paid for
   * once. `sessionsJoinedBy` keeps its rows deliberately; see there.
   *
   * **It may return fewer than `limit` when it meets a long run of closed
   * rooms.** The Durable Objects walk resolves each row in another object, and
   * the work it spends on rows the caller did not ask for — resolving a closed
   * one, then dropping it — is bounded by SWEEP_RPC_BUDGET, so a dead tail
   * cannot spend a Workers request's subrequest cap and throw. Live rows do not
   * count against that budget: they are what was asked for, `limit` bounds them,
   * and choosing a limit one request can resolve is the caller's part.
   *
   * A short list therefore always means progress was made — the rows it passed
   * are deleted, so the next call starts further in. A caller that needs the
   * whole set calls again rather than treating a short list as the end.
   *
   * That promise has two exceptions, both in the Durable Objects store, and a
   * miss costs more than a row missing from a list: a lapse freezes the rooms
   * this names, so a room it misses is not frozen and keeps working on a plan
   * that no longer pays for it. The index starts at its deploy, so a room
   * created before then is not listed (see `RegistryDO.indexSession`). And a
   * failed index write is logged rather than thrown, deliberately, so that a
   * registry failure cannot abort a create whose room had already committed;
   * nothing rebuilds the row it lost (see `DurableObjectStore.writeIndex`). A
   * creator's room takes two such writes, one per listing, and either can fail
   * alone, so a room can be in `sessionsJoinedBy` and absent from here.
   */
  sessionsCreatedBy(userId: string, limit: number): Promise<string[]>;
  /**
   * Rooms in which this user has held a member handle — created, joined, left
   * and closed alike — for as far back as the store's index goes. In MemoryStore
   * that is everything; in the Durable Objects store it starts at its deploy, so
   * a handle held before then is not listed (see `RegistryDO.indexMembership`).
   *
   * Nor is every handle held since that deploy. The Durable Objects store logs a
   * failed index write rather than throwing it, deliberately, so that a registry
   * failure cannot abort a join whose seat had already committed; nothing
   * rebuilds the row it lost (see `DurableObjectStore.writeIndex`). A creator's
   * room takes two such writes, one per listing, and either can fail alone, so
   * the room can be in `sessionsCreatedBy` and absent from here, or the reverse.
   * Absence from this list is not proof that the user never held a handle.
   *
   * Ids only, like `sessionsCreatedBy`, and no status parameter. The consumers
   * it is meant for do not agree on what counts as current: the control panel
   * hides closed rooms, a freeze sweep wants exactly the live ones. Encoding
   * either answer here would make one of them filter twice.
   *
   * **Closed rooms are listed, and this index is not pruned** — the two ways it
   * differs from `sessionsCreatedBy`, and both follow from the sentence above.
   * This answers which rooms a person HELD a handle in, so a closed one is the
   * history being asked for rather than a tombstone, and a row whose room has
   * closed is still a true answer. The growth is the cost of that promise.
   * The one thing that prunes it is the purge (#65): a room that has been deleted
   * is no room at all, and its rows go with it.
   *
   * Order is not promised, and it differs between the stores — insertion order
   * in MemoryStore, key order in the Durable Objects store — so which rooms
   * survive `limit` is unspecified too.
   */
  sessionsJoinedBy(userId: string, limit: number): Promise<string[]>;
  /**
   * Rooms an org sat in, closed ones included (#65, D5): the ids the admin's list resolves. A room
   * is listed for the org of everyone it is created with, and for the org of each member who joins
   * it afterwards, so a person from another org joining adds the room to their org's list as well.
   * A member with no org adds it to none. The one thing that removes a row is the purge.
   *
   * Ids only, as `sessionsJoinedBy` answers them, and for the same reasons: no status parameter,
   * because the admin's list wants the closed rooms and a freeze sweep would want others; the
   * caller resolves each id and checks the record, since an index row names a room and only the
   * roster says whether the org is in it; and no order is promised, so which rooms survive `limit`
   * is unspecified.
   *
   * The Durable Objects store starts at its deploy, as its other indexes do: a room created
   * before then is not listed, and the admin's read of it by id works all the same.
   */
  sessionsForOrg(orgId: string, limit: number): Promise<string[]>;
  /**
   * Every room, newest first (#471): the operator's list, read without walking every account. At most
   * `limit` rows, past `startAfter` when given, which is the last row of the page before; a short page
   * is the end. Open, closed and frozen rooms alike, until the purge (#65) removes a room's row.
   *
   * The Durable Objects store wrote no row before its deploy; `backfillRoomIndex` there writes one
   * for every room the account indexes can still name. A failed write is logged rather than thrown, as
   * the other indexes' are (`DurableObjectStore.writeIndex`), so a room can be missing from the list
   * and present for a read by id.
   */
  listRoomsPage(limit: number, startAfter?: Pick<RoomIndexRow, "createdAt" | "sessionId">): Promise<RoomIndexRow[]>;
  /**
   * `listRoomsPage` narrowed to the rows that match every filter given (dash#94): `createdBy` the creator, `org` the
   * creator's org at the create (null: rooms with no org), `hosted`, and `publicTrue` the rooms created public. A page
   * is full however few rooms match. A method of its own rather than an argument, so an object still on older code
   * after a deploy answers "does not implement" instead of ignoring the filter.
   */
  listRoomsFiltered(limit: number, startAfter: Pick<RoomIndexRow, "createdAt" | "sessionId"> | undefined, filter: RoomFilter): Promise<RoomIndexRow[]>;
  /**
   * How many indexed rooms each owner (`created_by`) or org has, largest first, ties by key ascending (dash#94). The
   * no-org group's key is `NO_ORG`. At most `limit` groups, past `after` (the last group of the page before);
   * `next` is `<rooms>:<key>` of the last group returned, null at the end. `total` counts every indexed room; `orgs`
   * is the distinct orgs of the rooms in the returned groups (null: no org), for the read's audit parties. Labels
   * are an owner's handle and an org's name, null without one.
   */
  roomCounts(by: "owner" | "org", limit: number, after?: { rooms: number; key: string }): Promise<RoomCounts>;
  /** The handle of each id that has one; ids without one are absent. */
  handlesOf(userIds: readonly string[]): Promise<Map<string, string>>;
  /** Take a room out of the operator's index, and nothing else. A room not indexed is a no-op. */
  dropRoomIndex(sessionId: string): Promise<void>;
  /**
   * One window of the walk that writes `listRoomsPage`'s missing rows (#471): `next` goes back in as `after`, and
   * null is the end. Idempotent. MemoryStore indexes every room at its create, so it has nothing to write.
   */
  backfillRoomIndex(limit: number, after?: string): Promise<{ indexed: number; next: string | null }>;
  /**
   * One room's counts and states for the operator's list (#472), read where the room is, in one hop: undefined for
   * a room that is not there, a purged one included, which is how a list skips an index row its purge left. A
   * read: an abandoned room reads closed without being closed by it.
   */
  roomSummary(sessionId: string): Promise<RoomSummary | undefined>;

  /**
   * Append an event. Null means the session is frozen, for the same reason.
   *
   * `extras` names what else the append writes, in the same operation; see
   * `AppendExtras`.
   */
  appendEvent(
    sessionId: string,
    e: Omit<SessionEvent, "cursor" | "at">,
    extras?: AppendExtras
  ): Promise<SessionEvent | null>;
  /**
   * Append an event unless this member has already used this key.
   *
   * A separate method rather than a parameter on appendEvent: `null` there
   * already means frozen, and a caller now has four outcomes to tell apart.
   * Same shape as the guarded grant writes — the guarantee is in the name, and
   * a caller that does not want it calls the other method.
   *
   * The key check and the append are one operation, and cannot be two: a
   * caller that read the key and then wrote would leave a window for its own
   * retry to read the same empty slot and append a second event, which is the
   * entire thing this prevents.
   *
   * The key check precedes the frozen check. A write that already succeeded
   * keeps reporting its result even after the room freezes — the replay
   * appends nothing, so nothing new enters a frozen room, and a retry across a
   * freeze can otherwise never learn whether its first attempt landed.
   */
  appendEventOnce(
    sessionId: string,
    e: Omit<SessionEvent, "cursor" | "at">,
    key: string,
    extras?: AppendExtras
  ): Promise<EventWrite>;
  /**
   * The record a keyed append left for `memberId` under `key`, or null when there is none (never used, or another
   * member's key). A plain read that appends and counts nothing. `bellman_send` reads it before the checks that
   * depend on the room's state, so a retry of a send that landed is let through to the append, which replays it
   * (or reports `conflict` for a key reused for other content), whatever the room has become since.
   */
  idempotencyRecord(sessionId: string, memberId: string, key: string): Promise<IdempotencyRecord | null>;
  /**
   * Append a surface write placed among the room's frames (surface frames spec, D2): the path of every surface
   * write. It is `appendEventOnce` when `key` is a string and `appendEvent` when it is null, with three
   * differences. The placement step is `placeSurfaceWrite` (frames.ts) over the rows listed in the same operation,
   * so two writes that meet are placed one after the other; the rows are listed only for a write placed among
   * them (`placesAmongRows`), and any other write is stored as written. A refusal (an overlap, a missing or full
   * frame, a frame written into a frame) answers `refused` with its kind and reason and writes nothing, not even
   * the key's record, so a retry runs again. The key's fingerprint is `surfacePrint`'s, which sees `frame`. And
   * the cards a locked frame's move carries are appended as `surface` events at the cursors after `e`'s, one per
   * row in key order, each authored by the mover; each row keeps its writer, `createdAt` and approver, and only
   * its placement changes (lead ruling L2).
   *
   * A replay returns the original event and applies nothing, as `appendEventOnce`'s does; the key check precedes
   * the frozen check. The key's record holds `e`'s cursor. `extras.approvedBy` is stamped on `e`'s row alone.
   */
  appendSurface(
    sessionId: string,
    e: EventBody,
    extras: { surface: SurfaceWrite; approvedBy?: ApprovedBy },
    key: string | null,
  ): Promise<SurfaceAppend>;
  /**
   * Append a batch of surface writes in one operation (surface widget and batch spec, D1): every write's `surface`
   * event, by `author`, and each carried card's after its frame's, at consecutive cursors, with their rows, or none
   * of them. The batch is placed in order by `placeSurfaceBatch` over the rows listed in the same operation, so a
   * refusal at any entry answers `refused` with its index and writes nothing, not even the key's record. A key names
   * the batch, fingerprinted by `surfaceBatchPrint`; a replay returns the last event the original call appended and
   * applies nothing, and the key check precedes the frozen check. One wake carries every event.
   */
  appendSurfaces(
    sessionId: string,
    author: SurfaceAuthor,
    writes: readonly SurfaceWrite[],
    key: string | null,
  ): Promise<SurfaceBatchAppend>;
  /**
   * Approve a proposal (topic rooms spec, D2; plan R12): append `e`, the maintainer's `action_response`, and, when
   * `decideApproval` says `apply`, the card's `surface` event and row after it, in the same operation. The card is
   * authored by the proposer (the request's sender), stamped with the approver, and goes through the same
   * placement step as any surface write, so a proposal written without a placement takes the next free slot at
   * approval and the event and the row agree.
   *
   * One method and not two appends, because the response, the card and the row cannot disagree, and because what
   * decides two approvals that meet is the operation that writes. The tool's own look for an earlier answer reads
   * before it appends and cannot stop them: of two that meet, one appends and the other reads `answered`.
   *
   * A `key` names the response, as `appendEventOnce`'s names its event, and `null` is unkeyed, as `appendEvent` is.
   * A retry returns the response, and the card that call wrote or null, as `replayed`: it appends and applies
   * nothing and re-checks nothing. The card is read by the cursor the key's record holds (`IdempotencyRecord.applied`),
   * never by the cursor after the response. The key check precedes the frozen check and the decision, so a retry
   * learns what its first attempt did however the room has changed since, and never reads `stale`.
   *
   * A refusal writes nothing, not even the key's record, so a retry after one runs again: `stale` (the key changed
   * since `approval.base`, a removal included; `cursor` names the change), `answered` (an earlier response to the
   * request exists; `by` is its sender's label), `conflict` (the key was used for a different response) and
   * `frozen`. A seat that cannot apply is not a refusal: its response is recorded alone, and `written` is null (R13).
   *
   * Throws when `approval.requestCursor` holds no `action_request`, as an idempotency record naming a missing
   * cursor does: the tool read it a moment before.
   */
  approveProposal(sessionId: string, e: EventBody, key: string | null, approval: ProposalApproval): Promise<ApprovalWrite>;
  /**
   * Open a decision (ADR 0040): `e` is a `decision_opened` whose payload is a `DecisionDraft`, and the store writes
   * it with the expiry, the electorate snapshot (`electorateOf`) and the hash (`openedPayload`), read and written in
   * one operation so nobody joins or leaves between the snapshot and the append. A draft naming `supersedes` closes
   * that decision `failed: superseded` in the same operation, after the new one; its votes do not carry.
   *
   * A `key` names the write as `appendEventOnce`'s does; a retry returns the opening event and re-checks nothing.
   * Throws on an expiry outside 5 minutes to 7 days, before anything is written. The quotas are checked after the
   * key (`decideOpenQuota`), and an open also writes the `expired` close of every decision past its deadline that no
   * event has closed (`dueToExpire`, decision 4), after its own events.
   *
   * `audit` is the rows `auditEntries` built for the caller, one per org: the store files one set for each decision
   * event the operation writes (`decisionAudit`), with it. Every decision write takes one, so each transition is
   * on the org's stream (decision 13).
   */
  openDecision(sessionId: string, e: EventBody, key: string | null, audit?: readonly AuditEntry[]): Promise<DecisionOpen>;
  /**
   * Cast a vote: `e` is a `decision_vote` whose payload is a `VoteInput`, and the store writes it with the capacity
   * `capacityOf` derives, never one the caller sent. `applyVote` decides from the decision as read in the operation
   * that writes, so a vote cannot land after a closing event. A vote that closes the decision writes the
   * `decision_closed` after it. A `key` and `audit` as `openDecision`'s.
   */
  castVote(sessionId: string, e: EventBody, key: string | null, audit?: readonly AuditEntry[]): Promise<VoteWrite>;
  /**
   * Close a decision with `close`, as the server: the closing event carries the tally of the votes read with it.
   * `now` is the clock `expired` is judged by, so an expiry is refused before the deadline; the first close wins.
   * An `expired` close ignores a freeze: the clock closes a decision whatever the members may write. `audit` as
   * `openDecision`'s.
   */
  closeDecision(
    sessionId: string, decision: number, close: { state: ClosedState; reason?: FailReason }, now: number, audit?: readonly AuditEntry[],
  ): Promise<DecisionClose>;
  /** The decision opened at `cursor`, read as of `now`, or null when that cursor opened none. */
  decision(sessionId: string, cursor: number, now: number): Promise<DecisionView | null>;
  /**
   * A page of the room's decisions, read as of `now` (#411): every one the room ever opened, closed ones included, for
   * as long as the room is kept, so a page reads them however far back the log they lie. `DecisionPage` says what each
   * part holds. Reads only the spans of the log the page's decisions cover, never the log between them.
   */
  decisions(sessionId: string, ask: DecisionPageAsk, now: number): Promise<DecisionPage>;
  /**
   * Which of `decisions` are open secret ballots `userId`'s account has voted in (secret ballot spec): a secret vote
   * names no seat, so this is the only way to ask. It answers for the one account it is given, and for no open ballot.
   */
  votedOn(sessionId: string, userId: string, decisions: number[]): Promise<number[]>;
  /**
   * Count one send under `key` in this room against `limit` over the rolling minute (abuse protections
   * spec D5), and say whether it is admitted. The caller passes `sendKeyFor(member)` and `sendLimitFor(member)`,
   * so a stranger's count is their account's and anyone else's is the seat's; the store counts under whatever key
   * it is given. The caller appends only when admitted; a refusal carries how long until the oldest send under
   * the key leaves the window, and writes nothing to the log.
   *
   * A call of its own, made after a send's checks and before its append (ADR 0022), so both append methods
   * keep their return types. A send that fails after it was admitted, such as one with a key conflict or one
   * to a room that froze in the gap, still used its place.
   *
   * A stranger's count (a key `isStrangerKey` names) is stored, so it survives the room object leaving memory:
   * an idle object is evicted after about 30 seconds, and a count kept only in memory would let a script send 6,
   * pause, and send 6 more. `SessionDO` writes one row per stranger on each admission, holding the times still
   * inside the minute, which is at most 6 small writes a minute per stranger and never more times than the
   * limit. Every other key is memory only: `SessionDO` keeps those in the instance, so a room object that sleeps
   * forgets them, which keeps a write off the busiest senders and costs a member at most a second 30 across an
   * eviction. `MemoryStore` keeps both beside the room and drops them with it at the purge. The hosted seat is
   * exempt by never being asked: its writes go through `appendHostEvent` alone.
   */
  admitSend(sessionId: string, key: string, limit: number, now: number): Promise<SendAdmission>;
  /**
   * The events after `cursor`, in cursor order: at most `limit` of them, the earliest,
   * when a limit is given. The hosted seat's read (I4) and a public room's events route
   * are the bounded ones; every other caller reads the tail whole.
   */
  eventsAfter(sessionId: string, cursor: number, limit?: number): Promise<SessionEvent[]>;
  /**
   * The event at exactly this cursor, or undefined.
   *
   * One key, not a scan. `bellman_send` resolves an action_response's ref_id
   * this way; reading the whole history to find one event is what #25 was.
   */
  eventAt(sessionId: string, cursor: number): Promise<SessionEvent | undefined>;
  /**
   * The last `limit` events, in cursor order. A bounded read for callers that
   * want the end of the log and nothing else: the monitor's poll (#28) reads it
   * for each member's latest `progress` note and the room's last event, every
   * 15 seconds, for every room a user is in. `eventsAfter(id, 0)` would read
   * the whole log each time, and nothing guards that read the way
   * `lastActionRequestAt` guards `bellman_sync`'s.
   *
   * `[]` for an unknown room, and for a limit of zero or less: `slice(-0)` is
   * the whole array, so the memory store has to say so itself.
   */
  recentEvents(sessionId: string, limit: number): Promise<SessionEvent[]>;
  /**
   * The events after `cursor`, or the first to arrive within `waitMs`: at most `limit`, the
   * earliest, when a limit is given. `bellman_sync` passes its page (#208), so a member far
   * behind reads a page per poll and never the whole log at once.
   */
  waitForEvents(sessionId: string, cursor: number, waitMs: number, limit?: number): Promise<SessionEvent[]>;
  /**
   * Every surface row of this room, sorted by key, as detached copies. An
   * unknown session answers none. One hop: the Durable Objects store reads the
   * rows inside the object and returns them together, which is why this is a
   * method and not N `eventAt` reads from a handler.
   */
  surfaceOf(sessionId: string): Promise<SurfaceRow[]>;
  /**
   * What a write is checked against before it counts as a send (`resolveSurfaceWrite`): how many rows and how many
   * frame rows the room holds, and the stored rows of `keys` alone (the write's key and a connector's ends), in key
   * order, a key with no row left out. Computed where the rows are, so a write never moves every row across RPC.
   * An unknown session answers zero and none.
   */
  surfaceFacts(sessionId: string, keys: readonly string[]): Promise<SurfaceFacts>;
  /**
   * Whether an item on the surface names blob `blobId`: the public blob route's rule (public rooms spec, D3), that
   * a blob uploaded and never placed, or one whose item went, stays the members'. Read where the rows are.
   */
  surfaceNamesBlob(sessionId: string, blobId: string): Promise<boolean>;
  /**
   * One page of a window of the surface (surface frames spec, D5; lead ruling L1): `readWindow` over the rows
   * a member may see, run where the rows are, so a read carries at most `SURFACE_PAGE` items across RPC and
   * not every row. `cut` is a removed member's (#113), applied before any rank or page; `cursor` is then the
   * last change among the rows it is shown, and without one the record's surface cursor, as `surfaceAt` says.
   */
  surfaceWindow(
    sessionId: string,
    asked: { window?: Window; next?: string },
    opts: { cut?: number },
  ): Promise<{ ok: true; page: WindowPage; cursor: number } | { ok: false; reason: string }>;
  /** One outside task of this room, if `callerUserId` opened it. Another caller's, or none, answers undefined. */
  outsideTask(sessionId: string, callerUserId: string, taskId: string): Promise<OutsideTask | undefined>;
  /** One outside task of this room by its id, whoever opened it: for the creator's moderation, which reads the account behind a question. */
  outsideTaskById(sessionId: string, taskId: string): Promise<OutsideTask | undefined>;
  /**
   * Ban an account that is not a member, as `removeMember`'s `ban` bans one that is: the same `bu:`/`bn:` rows and, for "all",
   * the creator-wide ban, in one operation, guarded as an eviction is (closed, frozen, `byUserId` the room's creator). One ban per
   * account, so a repeat writes nothing new and files no second audit row. No event: a public room's log is public.
   */
  banAccount(sessionId: string, req: AccountBanRequest): Promise<{ refused: RemovalOutcome["refused"] }>;
  /** This caller's tasks in this room, newest first. */
  outsideTasksOf(sessionId: string, callerUserId: string): Promise<OutsideTask[]>;
  /**
   * An outside caller asks the room (A2A): the follow-up rule, the open-task cap, the caller's context and visitor
   * number, the `outside_question` and the task row, decided and written as one unit (`decideAsk` decides). Two asks
   * therefore see each other: the cap and the numbers hold under concurrency. A room that is gone, frozen, or no longer
   * public and open answers "not_found".
   */
  askOutside(sessionId: string, req: AskRequest): Promise<AskOutcome>;
  /**
   * A member answers an outside question (A2A): who the voice is, whether the question is still open, the
   * `outside_answer` and the task row's new state, decided and written as one unit (`decideAnswer` decides). Of two
   * answers at once, one lands and the other finds the question answered. A room that is gone, frozen or closed
   * answers "task_closed".
   */
  answerOutside(sessionId: string, req: AnswerRequest): Promise<AnswerResult>;
  /**
   * The asker withdraws an outside question (A2A): ends the task `TASK_STATE_CANCELED` with an
   * `outside_notice`, in one unit with the decision (`decideCancel`). A racing answer therefore finds the task
   * closed, and a cancel of an answered task is "not_cancelable". Another caller's task, a room gone or frozen:
   * "task_not_found". Unpublishing, closing and the task's lifetime end open tasks in the same unit as their own
   * write, with no call of this one.
   */
  cancelOutside(sessionId: string, req: CancelRequest): Promise<CancelResult>;
  /**
   * The hosted seat will not answer this outside task (A2A): hand the voice to the members and clear the deadline.
   * Acts only while the task is still the seat's and WORKING, so a skip that arrives after the seat answered, or a
   * second skip, changes nothing; the seat's answer after a skip finds itself not the voice. `reason` is for the log.
   * The seat's silence past `seatDeadline` runs the same hand-off: the room's alarm in SessionDO, `sweep` here.
   */
  seatSkipped(sessionId: string, taskId: string, reason: string): Promise<void>;
  /**
   * Charge `bytes` to this room's blob total unless that would pass the
   * room's own `blobBytesCeiling` (#183, D3), stamped at creation from the
   * plan that made it. The read and the write are one operation, for
   * seatMember's reason: two uploads landing together must not both read the
   * same total and both fit the last megabyte. Refused for a closed or frozen
   * room as every write is, with the total it would have charged against, and
   * `not_found` for no room. The upload route pre-checks the ceiling as a
   * courtesy and this is the bound: a refusal here is what deletes the object
   * just put. Nothing credits the total; retention (#65) will.
   */
  chargeBlobBytes(sessionId: string, bytes: number): Promise<BlobCharge>;
  /**
   * The hosted seat's one write (hosted seat spec, D3): the event and the charge
   * of `units` against the room's month, in one transaction. Refused, nothing is
   * written. `now` is the caller's clock, as `seatMember`'s is.
   *
   * `key` is the wake's intent id (`host:<cause>:<cursor>`, M6). A write under a key
   * already used returns the event that key wrote and charges nothing, so a seat that
   * runs a wake again after losing the response to its write cannot post or charge
   * twice. The key alone decides: the rerun's text is a new model call's.
   */
  appendHostEvent(sessionId: string, e: Omit<SessionEvent, "cursor" | "at">, units: number, now: number, key: string): Promise<HostAppend>;
  /** The host's write under `key` (M6), or undefined: what the seat checks before it calls the model. */
  hostEventFor(sessionId: string, key: string): Promise<SessionEvent | undefined>;
  /**
   * The hosted seat's allowance for a new month (I7): `units`, its creator's plan's as the
   * seat read it at the month's first wake, 0 once that plan includes no hosted seat, with
   * the meter started empty in `month`. A renewal for a month the meter has reached already
   * changes nothing, so a second one cannot hand back what the month has spent. A missing
   * room is a no-op.
   */
  renewHostAllowance(sessionId: string, month: string, units: number): Promise<void>;
  /**
   * Set what the room's creator tells its hosted seat to ask (`PUT /rooms/:id/host`): the manifest's
   * `host.instructions`, which the seat reads on every wake, so its next question is built from what this
   * stores. `null` clears them, which leaves the host Bellman's rules alone. The caller trims and bounds the
   * text (`HostInstructionsShape`); the store writes what it is handed.
   *
   * Refused, nothing is written: a missing room (`not_found`), a room whose manifest has no host (`no_host`) and a
   * closed room (`closed`). The check and the write are one operation, so a room that closes after the route read
   * it is refused here. A frozen room takes the change: setting instructions is not a send, and a thaw finds the
   * host already told.
   *
   * `audit` is filed with the change and only with a change, as `removeMember` files its rows: the value the
   * room already holds writes nothing and files nothing, so a retried request leaves one row. A row with no org
   * names a stream nobody reads, and is dropped.
   */
  setHostInstructions(sessionId: string, instructions: string | null, audit: readonly AuditEntry[]): Promise<HostInstructionsSet>;

  /**
   * Governed config (#414). Read `getGovernedConfig` (src/config.ts), never these rows: it is the one reader, and it
   * reads a missing, invalid or unapproved row as the most restrictive value.
   */
  getConfigRow(sessionId: string, name: ConfigName): Promise<ConfigRow | null>;
  /** The kept revisions of `name`, newest first, at most `CONFIG_HISTORY`. */
  configHistory(sessionId: string, name: ConfigName): Promise<ConfigRow[]>;
  /**
   * Write one config revision: `decideConfigWrite`'s checks, the `cfg:` row, its `cfgh:` history row (history past
   * `CONFIG_HISTORY` deleted), `configRevs`/`configBytes` on the record, a `config_changed` event and `audit`, in one
   * transaction. Refused, nothing is written: a missing room, a closed room, a stale `baseRev`, a widening write
   * past the reserve. A frozen room is refused before the store by `gateSeat`.
   */
  writeConfig(sessionId: string, w: ConfigWrite, audit: readonly AuditEntry[]): Promise<ConfigWriteResult>;

  /**
   * Room files (ADR 0046). Reads apply no memory rule: `src/rooms.ts` does, and passes the memory ids a reader may
   * not see as `hide`, so listing and finding filter before they page or cap. `readFs` without `rev` returns null
   * for a deleted file.
   */
  readFs(sessionId: string, path: string, rev?: number): Promise<FsRow | null>;
  /**
   * Live files at `prefix` or under it, in path order, `FS_LIST_PAGE` a page after `cursor` (a path); with `newest`,
   * newest first and the cursor is `newestKey`'s.
   */
  listFs(sessionId: string, prefix: string, opts?: { cursor?: string; hide?: readonly string[]; newest?: boolean }): Promise<FsPage>;
  /** A path's kept revisions, newest first, at most `FS_HISTORY`. */
  fsHistory(sessionId: string, path: string): Promise<FsRow[]>;
  /** Live files whose path holds every word of `query`, case-insensitive, at most `FS_FIND_MAX`, in path order. */
  findFs(sessionId: string, query: string, opts?: { cursor?: string; hide?: readonly string[] }): Promise<FsPage>;
  /**
   * One file write in one transaction: the idempotency key, `planWrite` against the row read there, the net byte
   * charge (`decideFsCharge`), the memory id on an account's first `/members/` write, the `fs:` and `fsh:` rows
   * (history past `FS_HISTORY` pruned, a delete's history dropped), one `fs` event and `audit`, each entry's detail
   * stamped with the resolved path, revision, size and content hash.
   */
  appendFs(sessionId: string, w: FsWrite, audit: readonly AuditEntry[]): Promise<FsAppend>;
  /**
   * One home memory write (ADR 0047), in one transaction: the room `home` describes is created when `id` holds
   * none, the key is checked (`homeKey`), `planWrite` runs against the row read there with no memory rule and
   * `ceiling` as the room's, and the `fs:` and `fsh:` rows land. No event, no audit entry, no index row: a home room
   * has one member and is never listed. `getSession(id)` answers undefined for a home id, so every room path refuses
   * it; the reads (`readFs`, `listFs`, `fsHistory`) answer it as any room.
   */
  writeHome(id: string, home: NewSession, w: FsWrite, ceiling: number): Promise<HomeAppend>;
  /** The home room's settings row (#530), or `DEFAULT_HOME_SETTINGS` when it holds none. Creates nothing. */
  readHomeSettings(id: string): Promise<HomeSettings>;
  /** The home room's settings row, replaced. No record, event or index row: the first note still creates the room. */
  writeHomeSettings(id: string, settings: HomeSettings): Promise<void>;
  /**
   * `readFs` on a home room that also writes the lookup row, in one transaction; `paused` when the `hs` row says so,
   * with nothing read or written. Rows older than LOOKUP_KEEP_MS are deleted in the same transaction, and past
   * LOOKUP_KEEP + LOOKUP_SLACK rows the oldest are deleted down to LOOKUP_KEEP.
   */
  readHomeLogged(id: string, path: string, source: LookupSource): Promise<{ paused: true } | { paused: false; file: FsRow | null }>;
  /** `listFs` with `newest: true` on a home room, logged the same way. */
  listHomeLogged(id: string, prefix: string, cursor: string | undefined, source: LookupSource): Promise<{ paused: true } | { paused: false; page: FsPage }>;
  /** The lookup log, newest first, at most LOOKUP_KEEP rows; rows past that are deleted. */
  homeLookups(id: string): Promise<LookupRow[]>;
  /** Empties a home room (ADR 0047 decisions 13 and 14): every fs:, fsm:, fsh:, hk:, lk: row, the lkn count, the hs settings row and the record. Idempotent; a home id that was never written is a no-op. Never called on a room id. */
  purgeHome(id: string): Promise<void>;
  /** Deletes one home note as `forget` does, at its current revision, and scrubs `path` from every lookup row that returned it (a row left with no paths is deleted). `false` when there is no live note at `path`. */
  forgetHomeNote(id: string, path: string): Promise<boolean>;
  /** The account's memory id in this room, or null. Never assigns one. */
  memoryIdOf(sessionId: string, userId: string): Promise<string | null>;
  /** The account a memory id belongs to, or null. */
  memoryIdOwner(sessionId: string, memoryId: string): Promise<string | null>;
  /** Every account in the room with a memory id, for the readers that hide withheld memory. */
  memoryIds(sessionId: string): Promise<Array<{ userId: string; memoryId: string }>>;
  /** The accounts that have turned on notes sharing in this room (ADR 0047 decision 7): the `ns:` rows. */
  notesSharers(sessionId: string): Promise<string[]>;
  /** Turn an account's notes sharing in this room on or off. Purged with the room. */
  setNotesSharing(sessionId: string, userId: string, shared: boolean): Promise<void>;

  putPendingConnect(p: PendingConnect): Promise<void>;
  takePendingConnect(token: string): Promise<PendingConnect | undefined>;

  countCreatesThisMonth(userId: string): Promise<number>;
  recordCreate(userId: string): Promise<void>;

  /**
   * Note that someone signed in. First sign-in sets firstSeenAt; every one
   * moves lastSeenAt.
   *
   * The provider is not stored: userId is u_<provider>_<subject>, so it is
   * already in there.
   *
   * `githubLogin`, given on a sign-in through GitHub, replaces the one kept: a
   * login can be renamed, so the record holds the latest. Left out, the kept one
   * stays, so a sign-in through another provider does not erase it.
   * `googleEmail`, a Google sign-in's verified email, is kept the same way.
   * `ref`, the campaign tag the sign-in carried, is kept only by the call that creates the record: a later sign-in's
   * tag, or its absence, never changes it.
   */
  recordSignIn(userId: string, now: number, githubLogin?: string, googleEmail?: string, ref?: string): Promise<void>;
  /** How many people have ever signed in. */
  countUsers(): Promise<number>;
  /**
   * The people who have signed in, oldest first sign-in first (ties by user id), at most `limit`: the operator's
   * `GET /admin/accounts`. A record holds an id, two dates, and a GitHub login or Google email where kept, and nothing else, so neither does this.
   *
   * ponytail: every record is read and sorted to answer; page by first sign-in when there are tens of thousands.
   */
  listUsers(limit: number): Promise<UserRecord[]>;
  /**
   * Take one of this person's hosted-room slots for `sessionId`, unless `limit` are held
   * already (I7): the count and the record are one operation, so two starts at the limit
   * cannot both pass. A plan's hosted rooms are the most a person holds open at once; a
   * slot is given back when the room closes, which both stores do inside their closes,
   * or is purged. Taking a slot the room already holds is not a second room.
   */
  reserveHostedRoom(userId: string, sessionId: string, limit: number): Promise<HostedSlot>;
  /** Give the slot back. Idempotent. `bellman_start` calls it when the room it reserved for was not created. */
  releaseHostedRoom(userId: string, sessionId: string): Promise<void>;

  /** A person's saved presets (designer spec D4), in name order. Keyed by the person: nothing here reads another's. */
  listPresets(userId: string): Promise<SavedPreset[]>;
  getPreset(userId: string, name: string): Promise<SavedPreset | undefined>;
  /**
   * Save or replace by name. "full" when a new name would pass `cap`; replacing
   * one never counts against it. The count and the write are one operation, so
   * two saves racing for the last place cannot both land.
   */
  putPreset(userId: string, preset: SavedPreset, cap: number): Promise<"saved" | "full">;
  /** True when there was one to delete. */
  deletePreset(userId: string, name: string): Promise<boolean>;

  /**
   * A person's public handle (bylines spec D1, D2), and the public rooms they signed with it. The
   * registry holds both, so claiming, releasing, signing and unsigning are each one transaction
   * and nothing spans two objects (ADR 0006).
   */
  handleOf(userId: string): Promise<string | undefined>;
  userOfHandle(handle: string): Promise<string | undefined>;
  /**
   * Every account holding a handle, in user id order (public rooms on bellman.sh spec, D6). The notice that goes out
   * before members are named by handle is addressed from it: the operator's `GET /admin/handles` pairs each holder
   * with a sign-in label. An account that released its handle is not listed, and one that changed it is listed once,
   * under the handle it holds now.
   *
   * ponytail: the whole list in one answer; a page when holders reach thousands.
   */
  handleHolders(): Promise<{ userId: string; handle: string }[]>;
  /** "taken" when another user holds it. Claiming a new one frees the old; claiming your own is "claimed". */
  claimHandle(userId: string, handle: string): Promise<"claimed" | "taken">;
  /** The handle and every signature, in one transaction: a handle claimed later revives no byline. */
  releaseHandle(userId: string): Promise<void>;
  /**
   * The operator's release (ADR 0021): resolves the handle to its holder and releases as `releaseHandle`
   * does, in the same transaction. The holder's user id, or `undefined` when nobody holds the handle.
   */
  releaseHandleNamed(handle: string): Promise<string | undefined>;
  /**
   * Signs with the handle the user holds, read in the same operation as the write, so a release cannot
   * land between them. The handle it signed with, or `undefined`, writing nothing, when they hold none.
   */
  signRoom(userId: string, sessionId: string, at: number): Promise<string | undefined>;
  unsignRoom(userId: string, sessionId: string): Promise<void>;
  /** Newest signature first. */
  signedRooms(userId: string): Promise<{ sessionId: string; signedAt: number }[]>;
  /** The handle, when the user holds one and has signed the room: the public read's one registry call (D4). */
  bylineFor(userId: string, sessionId: string): Promise<string | undefined>;

  /** Plans granted at runtime. The operator's BELLMAN_USERS still outranks these. */
  getGrant(key: string): Promise<PlanGrant | undefined>;
  putGrant(grant: PlanGrant): Promise<void>;
  deleteGrant(key: string): Promise<void>;
  /**
   * Write a grant only if the key is unowned or already belongs to
   * `expectedOrgId`, and record what changed.
   *
   * The check, the write and the audit intent are one operation. A caller that
   * reads with getGrant and then writes has given the object a window to serve
   * another org's write in between; a caller that writes and then audits has
   * given it a window to lose the record of a change that already happened.
   * `audit` carries only what the store cannot see — who is acting, and any
   * detail to annotate the entry with. See grant-audit.ts for the rule.
   */
  putGrantIfOwned(
    grant: PlanGrant, expectedOrgId: string | null, audit: AuditIntent
  ): Promise<"written" | "conflict" | "full">;
  /** Delete a grant only if it belongs to `expectedOrgId`, and say what happened. */
  deleteGrantIfOwned(
    key: string, expectedOrgId: string | null, audit: AuditIntent
  ): Promise<"deleted" | "missing" | "conflict">;
  /**
   * Write a grant only if the key is unowned or already carries
   * `expectedSource`.
   *
   * The second writer. An admin claims a key by org, which is what
   * putGrantIfOwned checks; billing claims by having written it, because a
   * lapsing subscription must not revoke a plan an operator granted by hand.
   * Same atomicity argument either way.
   */
  putGrantIfSource(
    grant: PlanGrant, expectedSource: string, audit: AuditIntent
  ): Promise<GrantWrite>;
  /** Delete a grant only if it carries `expectedSource`, and say what happened. */
  deleteGrantIfSource(
    key: string, expectedSource: string, audit: AuditIntent
  ): Promise<GrantDelete>;
  /**
   * Re-file a grant under a new key, atomically. A no-op if `from` has none.
   *
   * Atomic because the caller is claiming an address-keyed grant onto the
   * subject that just proved it owns the address: write-then-delete would, on a
   * failed delete, leave the address key standing and claimable by whoever
   * holds that address next — the exact transfer claiming exists to stop.
   */
  moveGrant(fromKey: string, toKey: string): Promise<void>;
  /** Scoped to one org when given: grants are org-tenanted data. */
  listGrants(limit: number, orgId?: string | null): Promise<PlanGrant[]>;

  /**
   * The org record (orgs spec, D1), or undefined for an org that is only a string in grants
   * and overrides. Such an org is not refused anywhere: it has no seat cap and is always active.
   */
  getOrg(orgId: string): Promise<Org | undefined>;
  /**
   * The operator's creation (D7): the record and the owner's admin grant in ONE operation, with
   * `org_created` and the grant's rows. `exists` for an id that has a record; `conflict` when the
   * owner's key holds a live grant in another org, writing nothing. A grant the key holds in this
   * org is replaced: an org that lived as a string gets its record with its owner seated.
   */
  createOrg(org: Org, ownerGrant: PlanGrant, audit: AuditIntent): Promise<"created" | "exists" | "conflict">;
  /**
   * The record after the patch, or undefined when there is none. Records `org_updated` naming
   * only what changed, and nothing for a patch that changed nothing (D8). A field given as
   * undefined is left as it was.
   */
  updateOrg(orgId: string, patch: OrgPatch, audit: AuditIntent): Promise<Org | undefined>;
  /** How many live grants name the org: its members, the owner among them (D2, D3). */
  countOrgMembers(orgId: string): Promise<number>;
  /**
   * Billing's write (D4): a record for an org that has none, named by its id, `source: "purchase"`
   * and active; otherwise the seats and `active: true` and nothing else, so a name its owner gave
   * it survives every Stripe event. `unchanged` writes and records nothing. `not_purchased` is an
   * org the operator created: billing touches only what billing created (ADR 0014, decision 3),
   * so it is left as it is, whatever id it was given.
   */
  activatePurchasedOrg(orgId: string, ownerUserId: string, seats: number, audit: AuditIntent): Promise<"created" | "updated" | "unchanged" | "not_purchased">;
  /**
   * The lapse (D5): `active: false`, the members kept. `missing` for no record; `unchanged` when
   * already inactive; `not_purchased` for an operator org, which billing leaves active.
   */
  deactivateOrg(orgId: string, audit: AuditIntent): Promise<"updated" | "unchanged" | "missing" | "not_purchased">;

  /**
   * An org's identity provider (SSO spec, D9), kept apart from the record under its own key. The
   * secret arrives sealed and is stored as given. `missing` for an org with no record. Records
   * `idp_configured` with the issuer.
   */
  putOrgIdp(orgId: string, idp: OrgIdp, audit: AuditIntent): Promise<"written" | "missing">;
  getOrgIdp(orgId: string): Promise<OrgIdp | undefined>;
  /** Records `idp_removed`; `missing` when there was none. */
  deleteOrgIdp(orgId: string, audit: AuditIntent): Promise<"deleted" | "missing">;
  /**
   * A claim on the record (D11): `{ domain, token, verifiedAt: null }`, routing nothing until it is
   * verified. `exists` when this org already claims it, the token kept; `missing` for no record.
   */
  claimDomain(orgId: string, domain: string, token: string, now: number, audit: AuditIntent): Promise<"claimed" | "exists" | "missing">;
  /**
   * ONE operation (D11): `unknown` when the org has no such claim; `taken` when the index names
   * another org, the claim left unverified; otherwise the claim is marked (its first time kept)
   * and the index written. `domain_verified` is recorded on the first verification only.
   */
  verifyDomain(orgId: string, domain: string, now: number, audit: AuditIntent): Promise<"verified" | "taken" | "unknown">;
  /** Drops the claim, and the index row when it is this org's. `unknown` when there is no claim. */
  releaseDomain(orgId: string, domain: string, audit: AuditIntent): Promise<"released" | "unknown">;
  /** The org a verified domain routes a sign-in to (D12), and nothing for a claimed one. */
  orgForDomain(domain: string): Promise<string | undefined>;
  /**
   * The seat an SSO sign-in takes on first use (D13), ONE operation, in this order (SCIM spec, D4): a SCIM user
   * managing `key` that is inactive is `deprovisioned`; a live grant at `key` is `exists` (an sso key names its
   * org, so that grant is this org's); with `address`, the IdP's vouched address under a verified domain, a
   * directory entry naming an inactive SCIM user is `deprovisioned`, and a live grant of this org's at the
   * directory's key or at `email:<address>` is moved onto `key` with its role and source, the SCIM rows and the
   * directory following, and no seat taken: `written`; else `full` at the seats, `no_org` for no record, and
   * otherwise a team member grant from `sso` with its `plan_granted` row, and the directory entry for the
   * address, `written`.
   */
  provisionSsoMember(orgId: string, key: string, now: number, audit: AuditIntent, address?: string): Promise<"written" | "exists" | "full" | "no_org" | "deprovisioned">;

  /**
   * An org's SCIM token (SCIM spec, D1), ONE operation: the hash stored and indexed, and the previous token's
   * index row deleted, so the old token stops at the commit. `replaced` when one was; `missing` for no record.
   * Records `scim_token_issued` with `replaced`.
   */
  issueScimToken(orgId: string, token: ScimToken, audit: AuditIntent): Promise<"issued" | "replaced" | "missing">;
  /** Both rows gone; records `scim_token_revoked`. `missing` when there was none. */
  revokeScimToken(orgId: string, audit: AuditIntent): Promise<"revoked" | "missing">;
  /** The token's provenance, never the token: `GET /org/scim` says whether one is set and who issued it. */
  scimTokenOf(orgId: string): Promise<ScimToken | undefined>;
  /** The org a presented token's hash belongs to, which is the only identity a SCIM request has. */
  orgForScimToken(tokenHash: string): Promise<string | undefined>;

  /**
   * A push (SCIM spec, D5), ONE operation. `user.key` is what the caller proposes, `email:<userName>`; the stored
   * row's key is what the directory or an existing grant said. In order: a directory entry naming a SCIM user is
   * `exists`; a directory entry with none, or a live grant at the proposed key in this org, is `linked`, the row
   * written to point at that key and no seat taken (a grant the entry names that is gone is written again, since
   * the IdP owns whom it pushes); a grant in another org is `conflict`; else, when active, a `team` member grant
   * from `scim` within the seats (`full` otherwise), and with `active: false` the row alone: `written`. Records
   * `scim_user_created` with `linked`, after the grant's own row.
   */
  createScimUser(user: ScimUser, audit: AuditIntent): Promise<ScimCreate>;
  getScimUser(orgId: string, id: string): Promise<ScimUser | undefined>;
  /** By the directory: the address lowercased whole. Only a user the IdP pushed; an address the SSO sign-in alone wrote is not one. */
  scimUserByName(orgId: string, userName: string): Promise<ScimUser | undefined>;
  /** The SCIM user managing a grant key, active or not. */
  scimUserByKey(key: string): Promise<ScimUser | undefined>;
  /** In id order in both stores, so a page is stable between two reads. */
  listScimUsers(orgId: string, limit: number): Promise<ScimUser[]>;
  /**
   * ONE operation (SCIM spec, D6 to D8). Every check runs before any write. `was` is the row before. A deactivation
   * deletes the grant at the row's key when it is this org's (its `plan_revoked` row filed) and keeps the row; a
   * reactivation writes a `team` member grant from `scim` under the key again, `full` at the seats; a rename moves
   * an `email:` grant to the new address and the directory entry with it, and leaves a key a sign-in claimed; a
   * new name another SCIM user or a member of this org holds is `exists`. A key the rename or the reactivation
   * would write that another org holds a live grant under is `conflict`, nothing written: a tenant's seat is
   * never handed to another. A reactivation whose key this org seated by hand meanwhile keeps that grant, role
   * included, and takes no seat. A patch that changes nothing writes nothing and records nothing.
   * Records `scim_user_deactivated`, `scim_user_reactivated` or `scim_user_updated`, naming `user_name`, `key`,
   * and `from` for a rename and `external_id` for a change of it.
   */
  updateScimUser(orgId: string, id: string, patch: ScimUserPatch, now: number, audit: AuditIntent): Promise<ScimUpdate>;
  /** The grant (when active), the row, the directory entry and the key index gone; records `scim_user_deleted`. The row as it was, or undefined. */
  deleteScimUser(orgId: string, id: string, now: number, audit: AuditIntent): Promise<ScimUser | undefined>;

  /**
   * An org's offer of a seat (ADR 0027), kept apart from its grants, ONE operation: `no_org` for no
   * record, `exists` when this org already invited the key (the first offer kept), `limit` at
   * MAX_PENDING_INVITES, else both rows and `member_invited` in the org's stream. Takes no seat.
   */
  putOrgInvite(invite: OrgInvite, audit: AuditIntent): Promise<"invited" | "exists" | "limit" | "no_org">;
  /** The org's pending invites, by key, at most `limit`. */
  listOrgInvites(orgId: string, limit: number): Promise<OrgInvite[]>;
  /** Every pending invite that names one of these keys, from any org: what a sign-in shows. In the keys' order, then by org. */
  invitesFor(keys: string[]): Promise<OrgInvite[]>;
  /** An admin's withdrawal of one invite: both rows, and `invite_withdrawn` in the org's stream. */
  deleteOrgInvite(orgId: string, key: string, audit: AuditIntent): Promise<"deleted" | "missing">;
  /**
   * Resend (ADR 0036, D4): the row rewritten with `invitedAt: now`, `expiresAt: now + INVITE_TTL_MS`, `invitedBy`;
   * the role stands. One `invite_resent` row `{ key }`.
   */
  renewOrgInvite(orgId: string, key: string, invitedBy: string, now: number, audit: AuditIntent): Promise<OrgInvite | "missing">;
  /**
   * One invite mail against the org's budget for the UTC day `now` falls in (ADR 0036, D4): true, and counted, while
   * fewer than `budget` were spent that day; false, and nothing written, once they were. One row per org, its day's count.
   */
  spendInviteMail(orgId: string, budget: number, now: number): Promise<boolean>;
  /**
   * A Join (ADR 0027), ONE operation, so a withdrawal that lands first means no seat. The org's offer
   * to one of the sign-in's `keys`, an invite or an admin's seat on an address the org no longer owns
   * by its form (`isUnownedSeat`), becomes the grant of `subjectKey`: team, the offer's role, `source:
   * "invite"`, `grantedBy` whoever made the offer, with its `plan_granted` row; the org's invites of
   * those keys go, and every such seat of the org's, which the grant replaces. An unowned seat in any org
   * holds nothing, so none counts below. `gone` for no record or no such offer; `sso` when the org requires
   * single sign-on; `member` when a key holds this org's grant otherwise (its invites go); `taken` when a
   * key holds any other grant; `full` at the seats, unless a seat moves. `link` is an invite link's key and the
   * `invitedAt` it was signed for (ADR 0036, D2): its key joins `keys` only while this org's invite on it is that one,
   * read in the same operation, so a link whose invite was withdrawn and issued again seats nobody.
   */
  acceptOrgInvite(
    orgId: string, keys: string[], subjectKey: string, now: number, audit: AuditIntent, link?: { key: string; at: number },
  ): Promise<"joined" | "member" | "taken" | "full" | "sso" | "gone">;
  /**
   * That the person behind `subjectKey` declined this org's offers made by `now` (ADR 0027), kept on their
   * side: the org's invites stay as they were, so a decline tells its admins nothing. A later decline moves
   * the time on; an earlier one leaves it.
   */
  declineOrg(subjectKey: string, orgId: string, now: number): Promise<void>;
  /** The orgs the person behind `subjectKey` declined, by id, each with the time of its latest decline. */
  declinedOrgs(subjectKey: string): Promise<{ orgId: string; at: number }[]>;

  appendAudit(a: AuditEntry): Promise<void>;
  /** The newest `limit` rows of an org's stream, oldest first: `bellman_audit`'s read, and the tests'. */
  auditForOrg(orgId: string, limit: number): Promise<AuditEntry[]>;
  /**
   * Append to the platform operator's stream (#472), whatever `a.orgId` says: the operator's reads of rooms, kept
   * apart from every org's (`OPERATOR_AUDIT_STREAM`). An org a read concerns is written its own row by `appendAudit`.
   */
  appendOperatorAudit(a: AuditEntry): Promise<void>;
  /** The newest `limit` rows of the operator's stream, oldest first, as `auditForOrg` reads an org's. */
  operatorAudit(limit: number): Promise<AuditEntry[]>;
  /** One page of an org's stream under the filters, newest first (audit trail spec, D6). */
  queryAudit(orgId: string, query: AuditQuery): Promise<AuditPage>;
  /** What the panel's filters offer: the stream's actors, rooms, other orgs and actions, newest first (D6). */
  auditFacets(orgId: string): Promise<AuditFacets>;
  /** Walks the chain from the anchor, or from `from` taking that row's prev_hash on trust (ADR 0035, D1). */
  verifyAudit(orgId: string, from?: number): Promise<AuditVerification>;
  /** The org's retention window and sink (ADR 0035): both unset until an admin sets them. */
  auditSettings(orgId: string): Promise<AuditSettings>;
  /** Sets or clears the window (D2) and records `audit_retention_set` by the caller; the sweep is the store's own alarm. */
  setAuditRetention(orgId: string, days: number | null, audit: AuditIntent): Promise<AuditSettings>;
  /** One sweep at `now`: deletes the rows past the window in seq order and returns how many (D2). */
  sweepAudit(orgId: string, now: number): Promise<number>;
  /** Sets the org's one sink (D3): a fresh secret, returned this once; the cursor survives a re-set. Records `audit_sink_set`. */
  setAuditSink(orgId: string, url: string, audit: AuditIntent): Promise<{ sink: AuditSinkStatus; secret: string }>;
  /** Removes the sink and records `audit_sink_removed`; false when there was none. */
  removeAuditSink(orgId: string, audit: AuditIntent): Promise<boolean>;
  /** Clears a sink's failure state, dead or not, and delivers again from its cursor; undefined when none. */
  resumeAuditSink(orgId: string, audit: AuditIntent): Promise<AuditSinkStatus | undefined>;
  /** One delivery attempt at `now`: the next batch past the cursor, and the state it leaves; undefined when no sink. */
  pumpAuditSink(orgId: string, now: number): Promise<AuditSinkStatus | undefined>;

  /**
   * Housekeeping that cannot wait for a read: closes the rooms nobody has been in for 90 days
   * (#18), purges the closed rooms whose window has run out or whose delete was asked for (#65),
   * sweeps the unnamed objects of a closed room whose close it did not see (#65), drops
   * expired connect tokens, deletes the reports resolved 180 days ago (R15), and delivers and sweeps
   * each org's audit stream when due (ADR 0035). MemoryStore does all of it here; the Durable Objects
   * store does none, because each room's alarm does its room's, the registry's alarm does the
   * reports', and each org's AuditDO alarm does its stream's.
   */
  sweep(now: number): Promise<void>;
}

/**
 * How many cross-object RPCs one `sessionsCreatedBy` walk may spend.
 *
 * The walk resolves each index row in another object and drops the dead ones,
 * so its cost is in RPCs, and a Workers request is capped at 1,000 subrequests.
 * Spending the cap throws and the whole call fails; stopping early returns a
 * short list and leaves the rest for the next walk, which starts further in
 * because the rows this one dropped are gone. Well under the platform cap, so
 * the budget is reached long before anything is at risk of being refused.
 */
export const SWEEP_RPC_BUDGET = 300;
