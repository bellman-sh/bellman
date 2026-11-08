import { type ApprovedBy, type ArrivingMember, type AuditEntry, type Brief, type Member, type NewSession, type PendingConnect, type PlanGrant, type PublicView, type Session, type SessionEvent, type EventType, type SavedPreset, type SurfaceRow, type UserRecord, type OutsideCaller, type OutsideTask, type Org, type OrgIdp, type OrgInvite, type OrgPatch, type ScimToken, type ScimUser, type ScimUserPatch, type DirectoryEntry, type ConfigName, type ConfigRow, type FsRow, type HomeSettings, type RepoRoom, type LookupRow, type LookupSource, DEFAULT_HOME_SETTINGS, LOOKUP_KEEP, LOOKUP_KEEP_MS, LOOKUP_SLACK } from "../types.js";
import { CONFIG_HISTORY, configEvent, decideConfigWrite } from "../files/config.js";
import { FS_FIND_MAX, FS_LIST_PAGE, newMemoryId, type HomeKeyRecord, decideFsWrite, fsPrint, hiddenMemory, homeKey, newestKey, pageFs, pathMatches, resolveFsPath, underPrefix } from "../files/fs.js";
import { namespaceOf } from "../files/fs-path.js";
import { HOME_MEMBER_ID, isHomeRoomId } from "../files/home.js";
import { INVITE_TTL_MS, MAX_PENDING_INVITES, inviteLive, isUnownedSeat, liftInvite, liftOrg, scimSeatKey, takesUnownedSeat, inviteMailDay, patchedOrg, purchasedOrg, scimGrant } from "../orgs/orgs.js";
import { MemoryBlobStore, type BlobStore, decideBlobCharge } from "../files/blobs.js";
import { isBanId, newBanId, oldestFirst, type Ban, type CreatorBan } from "../bans.js";
import { fingerprint, idempotencyKey, type IdempotencyRecord } from "./idempotency.js";
import { creditedBlobBytes, orgsOnRoster, purgeDueAt, roomDeletedEntry, roomPurgedEntry, sweepDueAt, unnamedObjects } from "../room/retention.js";
import type { StoredSession } from "./stored-session.js";
// The host charge rules live in host.ts and are imported here. heartbeat.ts and housekeeping.ts are
// imported for their types only: `MemoryStore.tick` and `MemoryStore.housekeep` are handed their rules.
import { type HostWake, decideHostCharge, hostSentEntries } from "../host.js";
import type { TickStep } from "../room/heartbeat.js";
import type { Finding } from "../room/housekeeping.js";
import { grantAuditEntries, orgAuditEntries, orgEventEntry, revokeAuditEntries, scimUserEntry, takenSeatAuditEntries, type AuditIntent } from "../orgs/grant-audit.js";
import { SINK_BATCH, SINK_DELAY_MS, SWEEP_EVERY_MS, SYSTEM_INTENT, chainHash, chainWalk, deadDetail, deliverBatch, NO_ANCHOR, newSink, nextSinkState, sinkStatus, sweepPlan, type AuditSettings, type AuditSink, type AuditSinkStatus, type AuditVerification, type ChainAnchor } from "../orgs/audit-sink.js";
import { entryView, SYSTEM_ACTOR, auditRows, facetsOf, pageOf, type AuditActor, type AuditFacets, type AuditPage, type AuditQuery, type SeqEntry } from "../orgs/audit.js";
import { randomId } from "../oauth/tokens.js";
import { NO_ORG, scimKeyIndex, scimNameKey, scimUserKey } from "./grant-index.js";
import { presetInNewWords } from "../room/presets.js";
import { applySurfaceWrite, needsPlacement, withPlacement, type SurfaceWrite, asRowWriter, batchEvent, carriedEvent, surfaceBatchPrint, surfaceFactsOf, surfacePrint } from "../surface/surface.js";
import { FRAME_WRITE_PATH, isFrameWrite, placeSurfaceWrite, type Placed, type Window, type WindowPage, placeSurfaceBatch, placedEvent, placesAmongRows, windowUnderCut } from "../surface/frames.js";
import { decideApproval } from "../surface/proposal.js";
import { applyVote, capacityOfVote, closingEvent, decideClose, decideOpenQuota, decideSupersede, decisionAudit, decisionsOf, dueToExpire, isSecret, noteDecisions, openedPayload, decisionPageOf, removalEvents, type BallotBook, type Choice, type DecisionOpened, type SecretVote, type ClosedState, type DecisionPage, type DecisionPageAsk, type DecisionDraft, type DecisionView, type DecisionVote, type FailReason, type VoteInput, electorateOf, voteRefusal, withoutBook } from "../room/decision.js";
import { isTopicRoom, capacityOf, isPublic } from "../room/manifest.js";
import { decideAnswer, decideAsk, decideCancel, endings, handedOverNotice, type AnswerRequest, type AnswerResult, type AskOutcome, type AskRequest, type CancelRequest, type CancelResult, type EndReason, type SeatDay, handOff, newestTaskFirst, taskWithEvent } from "../outside.js";
import { admitAt, type SendAdmission } from "../room/send-limit.js";
import type { Suspension } from "../suspension.js";
import { REPORT_RETENTION_MS, REPORT_WINDOW_MS, REPORTS_PER_DAY, reachesCreator, reportId, targetKey, withinWindow, type FiledReport, type NewReport, type Report } from "../reports.js";
import { ABANDONED_AFTER_MS, abandonedAt, connectedAmong, isAbandoned, stampSeen } from "../room/presence.js";
import { type AccountBanRequest, type AppendExtras, type ApprovalWrite, type BellmanStore, type BlobCharge, type ConfigWrite, type ConfigWriteResult, type DecisionClose, type DecisionOpen, type DepartedMembers, type EventBody, type EventWrite, type FsAppend, type FsPage, type FsWrite, type GrantDelete, type GrantWrite, type HomeAppend, type HostAppend, type HostInstructionsSet, type HostedSlot, type MemberPatch, type ProposalApproval, type PublicNameEntry, type PurgeSchedule, type RemovalOutcome, type RemovalRequest, type RoomCounts, type RoomFilter, type RoomIndexRow, type RoomSummary, type ScimCreate, type ScimUpdate, type SeatOutcome, type SetJoinCode, type SurfaceAppend, type SurfaceAuthor, type SurfaceBatchAppend, type SurfaceFacts, type VoteWrite, firstSignInFirst, roomIndexKey, roomIndexRow, roomSummaryOf } from "./store.js";
import { HOST_MEMBER_ID, NO_SOCKETS, clearSilence, creatorOf, creditReport, departures, hostSeated, isActiveMember, isActivePerson, isReplyToHost, markRemoved, noteAppend, rosterParties, seatInOrder, seatVictims } from "../room/members.js";
import { codeIsLive } from "../room/codes.js";
import { sameEntry } from "../room/public-names.js";

type Waiter = { after: number; resolve: (events: SessionEvent[]) => void };

function detach<T>(value: T): T {
  return structuredClone(value);
}

/** What makes two reports the same to a fold (R9): one account, one room, one target. JSON, so no field runs into the next. */
const foldKeyOf = (r: Pick<NewReport, "reporterUserId" | "sessionId" | "target">): string =>
  JSON.stringify([r.reporterUserId, r.sessionId, targetKey(r.target)]);

/** By id, which is the time filed and then a random suffix: the order the Durable Objects store's key listing gives. */
const newestFirst = (a: Report, b: Report): number => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

export class MemoryStore implements BellmanStore {
  /**
   * The rooms, each with every member it has seated, those who have left included: one array
   * where the Durable Objects store keeps a row per member (ADR 0019). `getSession` hands back
   * the members in the room now, and the member reads reach the rest.
   */
  private sessions = new Map<string, Session>();
  /**
   * Each room's open secret ballots (secret ballot spec): decision → account → its current choice, how many votes it
   * has cast, and the idempotency keys they used. The only place a secret choice is kept; every close deletes it.
   */
  private ballots = new Map<string, Map<number, Map<string, { choice: Choice; n: number; iks: string[] }>>>();
  /** Governed config (#414): room → name → revisions, newest first, at most CONFIG_HISTORY. */
  private configs = new Map<string, Map<ConfigName, ConfigRow[]>>();
  /** Room files (ADR 0046): per room, per path, the current row (a tombstone included) and the kept revisions, newest first. */
  private files = new Map<string, Map<string, { current: FsRow; history: FsRow[] }>>();
  /** Memory ids per room, by account. */
  private memoryIdRows = new Map<string, Map<string, string>>();
  /** Room id to the accounts sharing their room notes there (ADR 0047 decision 7). */
  private notesSharing = new Map<string, Set<string>>();
  /** Keyed home writes (ADR 0047), per home room: no event to point at, so the path and revision are kept. */
  private homeKeys = new Map<string, Map<string, HomeKeyRecord>>();
  /** Home settings rows (#530), by home room; a room record is not needed for one. */
  private homeSettings = new Map<string, HomeSettings>();
  /** `rr` rows; `purgeHome` leaves them, as SessionDO's does. */
  private repoRooms = new Map<string, RepoRoom[]>();
  /** The lookup log (ADR 0047 decision 13), by home room, newest first. */
  private lookups = new Map<string, LookupRow[]>();
  private byJoinCode = new Map<string, string>();
  private byPublicName = new Map<string, PublicNameEntry>(); // public name -> its claim, a hint (public names spec, D5)
  private byCreator = new Map<string, Set<string>>();
  private byMember = new Map<string, Set<string>>();
  /** Rooms by the orgs that sat in them (#65, D5): written where `byMember` is, cleared by the purge. */
  private byOrg = new Map<string, Set<string>>();
  /** The operator's index of every room (#471), by id: written at the create, cleared by the purge. */
  private roomIndex = new Map<string, RoomIndexRow>();
  private pending = new Map<string, PendingConnect>();
  private creates = new Map<string, number[]>(); // userId -> timestamps
  private hostedOpen = new Map<string, Set<string>>(); // userId -> the hosted rooms holding a slot (I7)
  private presets = new Map<string, Map<string, SavedPreset>>(); // userId -> name -> preset
  private handles = new Map<string, string>(); // handle -> userId
  private handleByUser = new Map<string, string>(); // userId -> handle
  private signatures = new Map<string, Map<string, number>>(); // userId -> sessionId -> signedAt
  private grants = new Map<string, PlanGrant>();
  /** The org records (orgs spec, D1), by id. Members are the grants above that name one. */
  private orgs = new Map<string, Org>();
  /** Each org's IdP (SSO spec, D9), apart from its record. */
  private idps = new Map<string, OrgIdp>();
  /** The one index a verified domain writes (D11): domain to org. */
  private domainIndex = new Map<string, string>();
  /** Each org's pending invites (ADR 0027), org to key to invite: apart from `grants`, which no invite enters. */
  private invites = new Map<string, Map<string, OrgInvite>>();
  private inviteMail = new Map<string, { day: number; spent: number }>();
  /** The orgs each person declined (ADR 0027), subject key to org to when: the person's side, not the org's. */
  private declines = new Map<string, Map<string, number>>();
  /** Each org's SCIM token (SCIM spec, D1), and the lookup from a hash to its org. */
  private scimTokens = new Map<string, ScimToken>();
  private scimTokenIndex = new Map<string, string>();
  /** The SCIM users (SCIM spec, D2), the directory by address (D3) and the index by key, under the keys the registry uses. */
  private scimUsers = new Map<string, ScimUser>();
  private directory = new Map<string, DirectoryEntry>();
  private scimByKey = new Map<string, { orgId: string; scimId: string }>();
  private users = new Map<string, UserRecord>();
  /** Each org's stream, with each row's seq and chain link: one counter per org, as each AuditDO keeps its own. */
  private audit: { seq: number; entry: AuditEntry; prevHash: string; hash: string }[] = [];
  private auditSeq = new Map<string, number>();
  /** The operator's stream (#472): apart from `audit`, which is filed by org, as its own AuditDO is in production. */
  private operatorStream: AuditEntry[] = [];
  private auditState = new Map<string, { retentionDays: number | null; anchor: ChainAnchor; sweepAt: number | null; sink: AuditSink | null; sinkAt: number | null }>();
  private waiters = new Map<string, Waiter[]>();
  /**
   * Idempotency keys, by session. Beside `waiters` rather than on the Session
   * record: that type is the one SessionDO persists and hydrateStoredSession
   * validates, and a field there would need a hydration rule it does not need.
   * Same lifetime either way — a session leaves this store only by the purge,
   * and its keys go with it.
   */
  private keys = new Map<string, Map<string, IdempotencyRecord>>();
  /**
   * Surface rows, by session then by key. Beside `keys` for the same reason it
   * is: the Session record is what SessionDO persists, and the rows live under
   * their own storage keys there too.
   */
  private surfaces = new Map<string, Map<string, SurfaceRow>>();
  /** Outside tasks by session then task id, callers by session then user, and the last visitor number: rows beside the record, as SessionDO keeps them. */
  private outsideTasks = new Map<string, Map<string, OutsideTask>>();
  private outsideCallerRows = new Map<string, Map<string, OutsideCaller>>();
  private outsideVisitors = new Map<string, number>();
  /** The seat's outside questions per UTC day, by session: `seatDay` on SessionDO's record. */
  private seatDays = new Map<string, SeatDay>();
  /** Briefs, by session then by member (ADR 0018): beside the record, as SessionDO keeps them in rows. */
  private briefs = new Map<string, Map<string, Brief>>();
  /** Room bans, by session (spec section 1): beside the record for `briefs`' reason, and gone with the room at the purge. */
  private roomBanned = new Map<string, Ban[]>();
  /** Creator-wide bans, by creator (spec section 1): about a creator and not a room, so the purge leaves them. */
  private creatorBanned = new Map<string, CreatorBan[]>();
  /** Suspended accounts, by user id (spec section 1): about an account and not a room, so the purge leaves them. */
  private suspensions = new Map<string, Suspension>();
  /** Reports, by id (spec section 3): about the platform and not a room, so a room's purge leaves them. */
  private reports = new Map<string, Report>();
  /** The open report each account has filed about a target, by `foldKeyOf` (R9). Resolving a report drops its entry. */
  private folds = new Map<string, string>();
  /** When each account filed its reports, oldest first, by user id: what the day's count reads (R10). */
  private filings = new Map<string, number[]>();
  /** Recent sends, by session then by count key (`sendKeyFor`, spec D5): beside the record for `roomBanned`'s reason, and gone with the room at the purge. */
  private sends = new Map<string, Map<string, number[]>>();
  /**
   * Where the purge deletes a room's objects from (#65). Hand it the store the routes and the
   * tools serve, as `src/index.ts` does, or the purge empties a bucket nobody reads. Absent, the
   * store holds one of its own, which has nothing in it unless the caller put it there.
   */
  private readonly blobs: BlobStore;

  /** `host` is what a wake of a hosted seat does here: the Node server hands in `MemoryHost.wake`; `post` is the sink's `fetch`. */
  constructor(private readonly options: { blobs?: BlobStore; host?: (wake: HostWake) => void; post?: typeof fetch } = {}) {
    this.blobs = options.blobs ?? new MemoryBlobStore();
  }

  async createSession(s: NewSession): Promise<void> {
    const { members, briefs } = seatInOrder(s.members, { memberSeq: 0, labelSeq: 0 });
    const stored: Session = detach({ ...s, members, creator: creatorOf(members[0]), orgs: orgsOnRoster({ members }) });
    this.keepBriefs(stored.id, briefs);
    this.sessions.set(stored.id, stored);
    for (const rec of Object.values(stored.joinCodes)) this.byJoinCode.set(rec.code, stored.id);
    const mine = this.byCreator.get(stored.createdBy) ?? new Set<string>();
    mine.add(stored.id);
    this.byCreator.set(stored.createdBy, mine);
    // The members a session is created with are seated directly — bellman_start
    // hands over the creator in `members` and never calls addMember — so they
    // are indexed here. addMember indexes everyone who joins afterwards.
    for (const m of stored.members) this.indexMember(m.userId, stored.id);
    for (const orgId of stored.orgs) this.indexOrg(orgId, stored.id);
    this.roomIndex.set(stored.id, roomIndexRow(stored));
  }

  async listRoomsPage(limit: number, startAfter?: Pick<RoomIndexRow, "createdAt" | "sessionId">): Promise<RoomIndexRow[]> {
    return this.listRoomsFiltered(limit, startAfter, {});
  }

  async listRoomsFiltered(limit: number, startAfter: Pick<RoomIndexRow, "createdAt" | "sessionId"> | undefined, f: RoomFilter): Promise<RoomIndexRow[]> {
    const before = startAfter && roomIndexKey(startAfter);
    return [...this.roomIndex.values()]
      .filter((r) => (f.createdBy === undefined || r.createdBy === f.createdBy) && (f.org === undefined || r.orgId === f.org) &&
        (f.hosted === undefined || r.hosted === f.hosted) && (f.publicTrue === undefined || r.public))
      .map((r) => ({ key: roomIndexKey(r), r }))
      .filter(({ key }) => before === undefined || key < before)
      .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0))
      .slice(0, limit)
      .map(({ r }) => ({ ...r }));
  }

  async roomCounts(by: "owner" | "org", limit: number, after?: { rooms: number; key: string }): Promise<RoomCounts> {
    const keyOf = (r: RoomIndexRow) => (by === "owner" ? r.createdBy : r.orgId ?? NO_ORG);
    const counts = new Map<string, number>();
    for (const r of this.roomIndex.values()) counts.set(keyOf(r), (counts.get(keyOf(r)) ?? 0) + 1);
    const sorted = [...counts]
      .map(([key, rooms]) => ({ key, rooms }))
      .filter((g) => after === undefined || g.rooms < after.rooms || (g.rooms === after.rooms && g.key > after.key))
      .sort((a, b) => b.rooms - a.rooms || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const page = sorted.slice(0, limit);
    const keys = new Set(page.map((g) => g.key));
    const orgs = by === "org"
      ? page.map((g) => (g.key === NO_ORG ? null : g.key))
      : [...new Set([...this.roomIndex.values()].filter((r) => keys.has(r.createdBy)).map((r) => r.orgId))];
    const groups = page.map((g) => ({
      key: g.key,
      label: (by === "owner" ? this.handleByUser.get(g.key) : g.key === NO_ORG ? undefined : this.orgs.get(g.key)?.name) ?? null,
      rooms: g.rooms,
    }));
    const last = page.at(-1);
    return { total: this.roomIndex.size, groups, next: sorted.length > limit && last ? `${last.rooms}:${last.key}` : null, orgs };
  }

  async handlesOf(userIds: readonly string[]): Promise<Map<string, string>> {
    return new Map(userIds.flatMap((id) => {
      const handle = this.handleByUser.get(id);
      return handle === undefined ? [] : [[id, handle] as const];
    }));
  }

  async dropRoomIndex(sessionId: string): Promise<void> {
    this.roomIndex.delete(sessionId);
  }

  async backfillRoomIndex(): Promise<{ indexed: number; next: string | null }> {
    return { indexed: 0, next: null };
  }

  async roomSummary(sessionId: string): Promise<RoomSummary | undefined> {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    return detach(roomSummaryOf(s, s.events.at(-1), this.surfaces.get(sessionId)?.size ?? 0, Date.now()));
  }

  /**
   * The one place the joined index is written, so the two ways of seating a
   * member cannot drift apart. Keyed by user, so a second handle for the same
   * person in the same room is the same entry.
   */
  private keepBriefs(sessionId: string, briefs: Record<string, Brief>): void {
    const kept = this.briefs.get(sessionId) ?? new Map<string, Brief>();
    for (const [memberId, brief] of Object.entries(briefs)) kept.set(memberId, detach(brief));
    this.briefs.set(sessionId, kept);
  }

  private indexMember(userId: string, sessionId: string): void {
    const joined = this.byMember.get(userId) ?? new Set<string>();
    joined.add(sessionId);
    this.byMember.set(userId, joined);
  }

  /** The org index's one writer (#65, D5), for the same reason: a member with no org writes nothing. */
  private indexOrg(orgId: string | null, sessionId: string): void {
    if (!orgId) return;
    const rooms = this.byOrg.get(orgId) ?? new Set<string>();
    rooms.add(sessionId);
    this.byOrg.set(orgId, rooms);
  }

  async getSession(id: string): Promise<StoredSession | undefined> {
    const s = this.sessions.get(id);
    // A home room (ADR 0047) is not a room: no route, tool or socket reads it as one.
    if (!s || isHomeRoomId(id)) return undefined;
    this.closeIfAbandoned(s, Date.now());
    // The events come off before the copy, not after it (#134): detach is a deep clone,
    // so cloning first paid for the room's whole history on every call and then threw it
    // away. closeIfAbandoned has already run on `s`, so nothing it did is skipped by cloning later.
    // The members who have left come off the same way (ADR 0019): the record holds who is in
    // the room now, and the member reads reach the others.
    const { events: _events, members, ...rest } = s;
    return detach({ ...rest, members: members.filter(isActiveMember) });
  }

  async getSessionByJoinCode(code: string): Promise<{ session: StoredSession; role: string } | undefined> {
    const id = this.byJoinCode.get(code);
    if (!id) return undefined;
    const session = await this.getSession(id);
    if (!session || session.closed) return undefined;
    const hit = Object.entries(session.joinCodes).find(([, rec]) => rec.code === code);
    if (!hit) return undefined; // consumed or rotated
    const [role, rec] = hit;
    if (!codeIsLive(rec, Date.now())) return undefined;
    return { session, role };
  }

  async consumeJoinCode(sessionId: string, role: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    const rec = s?.joinCodes[role];
    if (!s || !rec) return;
    this.byJoinCode.delete(rec.code);
    delete s.joinCodes[role];
  }

  async clearJoinCodes(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    for (const rec of Object.values(s.joinCodes)) this.byJoinCode.delete(rec.code);
    s.joinCodes = {};
  }

  async setJoinCode(
    sessionId: string, role: string, code: string, expiresAt: number | null,
    guard: { replaceLive: boolean; now: number },
  ): Promise<SetJoinCode> {
    const s = this.sessions.get(sessionId);
    if (!s) return { ok: false, reason: "frozen" };
    if (s.frozenAt !== null) return { ok: false, reason: "frozen" };
    if (expiresAt === null && !isPublic(s)) return { ok: false, reason: "not_public" };
    const previous = s.joinCodes[role];
    // Live, not merely present: an expired record shuts no door.
    const live = previous !== undefined && codeIsLive(previous, guard.now);
    if (live && !guard.replaceLive) return { ok: false, reason: "live_code_exists" };
    // No awaits between the test above and the writes below, which is what makes
    // this atomic here — the same arrangement appendEvent and addMember use. The
    // Durable Object gets it from a transaction instead.
    if (previous) this.byJoinCode.delete(previous.code); // only THIS role's old code
    s.joinCodes[role] = { code, expiresAt };
    this.byJoinCode.set(code, sessionId);
    return { ok: true, replacedLive: live };
  }

  async addMember(sessionId: string, member: ArrivingMember): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    if (s.frozenAt !== null) return false;
    // Closed is refused for the reason frozen is: the caller read the room before
    // this write, and a close in the gap would otherwise seat a member in a room
    // that is over. closeSessionIfEmpty is the other half.
    if (s.closed) return false;
    // After the guards, so a refused add leaves no trace in the listing.
    this.seat(s, member);
    return true;
  }

  /**
   * Seat one member, the rule both joins share (ADR 0019): the next `seq`, its label's public
   * number or the next one (`seatInOrder`), its brief beside the room, its org on the record,
   * and the listings. No awaits, for the reason the callers give.
   */
  private seat(s: Session, member: ArrivingMember): void {
    const labelSeq = s.members.reduce((n, m) => Math.max(n, m.publicNumber ?? 0), 0);
    const known = (label: string) => s.members.find((m) => m.label === label && m.publicNumber !== null)?.publicNumber ?? undefined;
    const { members: [arrived], briefs } = seatInOrder([member], { memberSeq: s.members.length, labelSeq }, known);
    s.members.push(detach(arrived));
    this.keepBriefs(s.id, briefs);
    if (arrived.orgId && !s.orgs.includes(arrived.orgId)) s.orgs.push(arrived.orgId);
    this.indexMember(member.userId, s.id);
    this.indexOrg(member.orgId, s.id);
  }

  async seatMember(
    sessionId: string,
    member: ArrivingMember,
    staleBefore: number,
    now: number,
  ): Promise<SeatOutcome> {
    // No await from here to the write, deliberately — the same rule, and the
    // same reason, as closeSessionIfEmpty. The Durable Objects store gets it
    // from a transaction instead.
    const s = this.sessions.get(sessionId);
    if (!s) return { refused: "not_found", reclaimed: [], codesCleared: false };
    if (s.closed) return { refused: "closed", reclaimed: [], codesCleared: false };
    if (s.frozenAt !== null) return { refused: "frozen", reclaimed: [], codesCleared: false };
    // Before capacity is asked, so a banned account is never told the room is full.
    if (this.isBanned(sessionId, member.userId)) return { refused: "banned", reclaimed: [], codesCleared: false };

    const connected = connectedAmong(s.members, this.attachedTo(sessionId));
    const victims = seatVictims(s.members, capacityOf(s.manifest), staleBefore, connected);
    if (victims === null) return { refused: "full", reclaimed: [], codesCleared: false };

    const reclaimed: Member[] = [];
    for (const v of victims) {
      const row = s.members.find((m) => m.memberId === v.memberId)!;
      row.leftAt = now;
      reclaimed.push(detach(row));
    }
    // After the guards, so a refused seating leaves no trace in the listing.
    this.seat(s, member);

    // A full room has no seat for ANY role, so every temporary code goes — decided and
    // written here rather than by the caller afterwards. As a second call made
    // once the seat had committed it had nothing spanning it: a failure left the
    // joiner seated with the codes still redeemable (#116).
    //
    // "Full" is asked the only way that preserves what the caller used to
    // compute: whether a FURTHER joiner would be refused. Counting members with
    // a null leftAt is not the same question — a stale seat is occupied but
    // reclaimable, so a room with one still has a door worth leaving open, and
    // counting would have retired its code.
    //
    // Cleared by presence, where removeMember retires only a code that is still live
    // (`codeIsLive(rec, req.now)`). The two ask different questions. A removal
    // announces a door shutting, so it must not announce one that had already shut,
    // and an expired record is not a door. A seating announces nothing: it tidies
    // rows, and a full room needs no code at all, so an expired record goes with the
    // rest. A room that fills while holding only one therefore reports
    // `codesCleared: true`, which answers this question and does not contradict the
    // other. The contract suite pins this side, and its expired-code cases for
    // removeMember pin the other.
    //
    // A permanent code stays (ADR 0020). It is a public room's link, put where people
    // find it, and the room refuses joiners while it is full: when a seat frees, the
    // link works again, where a cleared one would have to be found and replaced.
    const full = seatVictims(s.members, capacityOf(s.manifest), staleBefore, connected) === null;
    const codes = full ? Object.entries(s.joinCodes).filter(([, rec]) => rec.expiresAt !== null) : [];
    for (const [role, rec] of codes) {
      this.byJoinCode.delete(rec.code);
      delete s.joinCodes[role];
    }
    // What the call did, and not only whether the room filled: a room that fills
    // with no code left in it had nothing to retire.
    return { refused: null, reclaimed, codesCleared: codes.length > 0 };
  }

  async removeMember(
    sessionId: string,
    memberId: string,
    req: RemovalRequest,
  ): Promise<RemovalOutcome> {
    // No await from here to the last write, deliberately — the same rule, and
    // the same reason, as seatMember and closeSessionIfEmpty. The Durable
    // Objects store gets it from a transaction instead.
    const none = { removed: false, codeRetired: null };
    const s = this.sessions.get(sessionId);
    if (!s) return { refused: "not_found", ...none };
    if (s.closed) return { refused: "closed", ...none };
    if (req.frozen === "refuse" && s.frozenAt !== null) return { refused: "frozen", ...none };
    if (req.byUserId !== undefined && s.createdBy !== req.byUserId) {
      return { refused: "forbidden", ...none };
    }
    const m = s.members.find((mm) => mm.memberId === memberId);
    if (!m) return { refused: "not_found", ...none };

    // One value for "there is a live door to shut", so nothing downstream has to
    // re-derive it. Nothing prunes an expired record, so a code's presence in
    // joinCodes is not the same as a door being open. Decided before the member's
    // state is looked at, because a live door is owed to one who is already out as
    // much as to one who is not.
    const rec = req.retire ? s.joinCodes[req.retire.role] : undefined;
    const retiring = req.retire && rec && codeIsLive(rec, req.now)
      ? { role: req.retire.role, code: rec.code, event: req.retire.event, audit: req.retire.audit ?? [] }
      : null;

    // The ban this call owes: asked for, and not yet on the room. One ban per account, so a repeat
    // keeps the first and owes nothing. Decided before the member's state is looked at, for the
    // door's reason: a ban is owed to one who is already out as much as to one who is not.
    const banning = req.ban !== undefined && !this.isBanned(s.id, m.userId)
      ? { banId: newBanId(), userId: m.userId, label: m.label, at: req.now }
      : null;
    // The creator-wide ban that "all" also asks for, owed on its own account: a room ban made earlier
    // does not stand in for it, so a later eviction widens one. Not owed to an account this creator
    // already bans, whose first ban stands.
    const widening = req.ban === "all" && !this.bansCreatorWide(s.createdBy, m.userId)
      ? { banId: newBanId(), userId: m.userId, label: m.label, at: req.now, sessionId: s.id }
      : null;

    // Already out: the idempotent path. The departure is not said again, which is
    // the point of it. A live door behind them, or a ban not yet on the room, is a
    // different matter: it was never done, so doing it is a write that has not
    // happened yet and not a duplicate. With none owed, nothing is written.
    const leaving = isActiveMember(m);
    if (!leaving && !retiring && !banning && !widening) return { refused: null, ...none };

    if (leaving) {
      // The event first, then the member write, because a cut names the
      // departure's OWN cursor and the departure has none until it is written.
      const departure = this.appendNow(s, req.event);
      // `markRemoved` and not a `leftAt` of this method's own, so the cut an
      // eviction records here is the write `appendEvent`'s `markRemoved` extra
      // makes — one rule, applied inside both stores (#113). It replaces the
      // array rather than mutating `m`, which is why nothing below reads `m`.
      //
      // `req.now` for the stamp and not `departure.at`: within a removal the
      // caller's clock is the operation's, and the contract pins `leftAt` to the
      // `now` it was handed. A room where the two disagree is a room whose
      // members left at a time nobody asked for.
      //
      // Null is unreachable from here — `leaving` already read `leftAt` as null,
      // in this same synchronous stretch, and the roster names `m`. It falls back
      // to the roster unchanged rather than asserting, because the alternative to
      // a cut is not a stamp of this method's own: that is the half-write the
      // transaction exists to prevent.
      if (req.cut) {
        s.members = markRemoved(s.members, memberId, departure.cursor, req.now) ?? s.members;
      } else {
        // The roster as it stands now, and not `m`: the departure just written may have
        // replaced the roster's member objects (housekeeping's books stamp the leaver's
        // last send), and a `leftAt` set on `m` would land on a member nobody holds.
        s.members = s.members.map((mm) => (mm.memberId === memberId ? { ...mm, leftAt: req.now } : mm));
      }
    }
    if (retiring) {
      this.byJoinCode.delete(retiring.code);
      delete s.joinCodes[retiring.role];
      this.appendNow(s, retiring.event);
    }
    // The seat's votes on every decision still unclosed, voided after the member and the door (ADR 0040, decision 12).
    const voided = leaving
      ? removalEvents(decisionsOf(s.events, req.now, this.book(s)).values(), memberId, req.event).map((b) => this.appendNow(s, b))
      : [];
    // Last, so a call that throws above leaves no ban behind.
    if (banning) this.roomBanned.set(s.id, [...(this.roomBanned.get(s.id) ?? []), banning]);
    if (widening) this.creatorBanned.set(s.createdBy, [...(this.creatorBanned.get(s.createdBy) ?? []), widening]);
    // A falsy org names a stream nobody reads, and the Durable Objects store
    // drops such an entry rather than file it, so this one does too. The member's
    // rows, then the door's: the order the events were written in. The member's rows
    // are filed for a call that removed them or wrote this room's ban: a ban on someone
    // who already left is the eviction's row all the same, and a repeat writes none.
    this.recordAudit([
      ...(leaving || banning ? req.audit : []), ...(retiring ? retiring.audit : []),
      ...decisionAudit(req.audit, voided, decisionsOf(s.events, req.now, this.book(s)), this.secretTemplate(s, req.now)),
    ].filter((e) => e.orgId));
    this.eraseClosed(s, voided);

    return { refused: null, removed: leaving, codeRetired: retiring?.role ?? null };
  }

  /** Whether this room holds a ban for the account (spec section 1). */
  private isBanned(sessionId: string, userId: string): boolean {
    return (this.roomBanned.get(sessionId) ?? []).some((b) => b.userId === userId);
  }

  async roomBans(sessionId: string): Promise<Ban[]> {
    return detach([...(this.roomBanned.get(sessionId) ?? [])].sort(oldestFirst));
  }

  async liftRoomBan(sessionId: string, banId: string): Promise<boolean> {
    // The Durable Objects store answers this before it reads storage, so this one does too, though
    // nothing here can throw on a long id: both stores say false for the same strings.
    if (!isBanId(banId)) return false;
    // No await from the read to the write, the rule `seatMember` follows. The Durable Objects
    // store gets it from a transaction instead.
    const held = this.roomBanned.get(sessionId) ?? [];
    const kept = held.filter((b) => b.banId !== banId);
    if (kept.length === held.length) return false;
    this.roomBanned.set(sessionId, kept);
    return true;
  }

  /** Whether this creator bans the account from every room they own (spec section 1). */
  private bansCreatorWide(creatorId: string, userId: string): boolean {
    return (this.creatorBanned.get(creatorId) ?? []).some((b) => b.userId === userId);
  }

  async creatorBans(creatorId: string): Promise<CreatorBan[]> {
    return detach([...(this.creatorBanned.get(creatorId) ?? [])].sort(oldestFirst));
  }

  async liftCreatorBan(creatorId: string, banId: string): Promise<boolean> {
    if (!isBanId(banId)) return false;
    // No await from the read to the write, as `liftRoomBan` has none.
    const held = this.creatorBanned.get(creatorId) ?? [];
    const kept = held.filter((b) => b.banId !== banId);
    if (kept.length === held.length) return false;
    this.creatorBanned.set(creatorId, kept);
    return true;
  }

  async isBannedByCreator(creatorId: string, userId: string): Promise<boolean> {
    return this.bansCreatorWide(creatorId, userId);
  }

  async isBannedFromRoom(sessionId: string, userId: string): Promise<boolean> {
    return this.isBanned(sessionId, userId);
  }

  async suspend(userId: string, s: Suspension): Promise<void> {
    this.suspensions.set(userId, detach(s));
  }

  async unsuspend(userId: string): Promise<boolean> {
    return this.suspensions.delete(userId);
  }

  async isSuspended(userId: string): Promise<boolean> {
    return this.suspensions.has(userId);
  }

  async fileReport(r: NewReport, now: number): Promise<FiledReport> {
    // No await from the fold's read to the write, as `admitSend` has none: two filings cannot both pass the count.
    const fold = foldKeyOf(r);
    const openId = this.folds.get(fold);
    const open = openId === undefined ? undefined : this.reports.get(openId);
    if (open?.resolvedAt === null) return { outcome: "folded", report: detach(open) };
    const kept = withinWindow(this.filings.get(r.reporterUserId) ?? [], now);
    if (kept.length >= REPORTS_PER_DAY) return { outcome: "limited", retryAfterMs: kept[0] + REPORT_WINDOW_MS - now };
    const report: Report = { ...detach(r), id: reportId(now), at: now, resolvedAt: null, resolution: null, resolvedBy: null };
    this.reports.set(report.id, report);
    this.folds.set(fold, report.id);
    this.filings.set(r.reporterUserId, [...kept, now]);
    return { outcome: "filed", report: detach(report) };
  }

  async roomReports(creatorId: string, sessionId: string): Promise<Report[]> {
    const mine = [...this.reports.values()]
      .filter((r) => r.creatorId === creatorId && r.sessionId === sessionId && reachesCreator(r));
    return detach(mine.sort(newestFirst));
  }

  async listReports(limit: number): Promise<Report[]> {
    const newest = [...this.reports.values()].sort(newestFirst);
    return detach([...newest.filter((r) => r.resolvedAt === null), ...newest.filter((r) => r.resolvedAt !== null)].slice(0, limit));
  }

  async resolveReport(id: string, resolution: { note: string; by: string }, now: number): Promise<Report | undefined> {
    const report = this.reports.get(id);
    if (!report) return undefined;
    if (report.resolvedAt !== null) return detach(report);
    report.resolvedAt = now;
    report.resolution = resolution.note;
    report.resolvedBy = resolution.by;
    this.folds.delete(foldKeyOf(report));
    return detach(report);
  }

  /**
   * The member ids the sockets open to this room carry. None: the Node server
   * holds no socket to a room, so nobody is connected through this store. A
   * subclass standing in for SessionDO says otherwise by overriding this, and
   * `connectedMembers` and `seatMember` both read it, so the two cannot answer
   * from different sources the way a store with a separate cache could.
   */
  protected attachedTo(_sessionId: string): Iterable<string> {
    return [];
  }

  async connectedMembers(sessionId: string): Promise<ReadonlySet<string>> {
    const s = this.sessions.get(sessionId);
    if (!s) return NO_SOCKETS;
    return connectedAmong(s.members, this.attachedTo(sessionId));
  }

  async updateMember(
    sessionId: string,
    memberId: string,
    patch: MemberPatch
  ): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const m = s.members.find((mm) => mm.memberId === memberId);
    if (!m) return;
    if (patch.brief !== undefined) {
      this.keepBriefs(sessionId, { [memberId]: patch.brief });
      m.agent = detach(patch.brief.agent);
    }
    if (patch.capabilities !== undefined) m.capabilities = detach(patch.capabilities);
    if (patch.leftAt !== undefined) m.leftAt = patch.leftAt;
    if (patch.lastSeenAt !== undefined) m.lastSeenAt = patch.lastSeenAt;
    if (patch.lastReportAt !== undefined) m.lastReportAt = patch.lastReportAt;
  }

  async getBriefs(sessionId: string, memberIds: readonly string[]): Promise<Record<string, Brief>> {
    const kept = this.briefs.get(sessionId);
    const out: Record<string, Brief> = {};
    for (const memberId of memberIds) {
      const brief = kept?.get(memberId);
      if (brief) out[memberId] = detach(brief);
    }
    return out;
  }

  /** Every member this room has seated, in join order, or none for an unknown room. */
  private everyMember(sessionId: string): Member[] {
    return this.sessions.get(sessionId)?.members ?? [];
  }

  async getMember(sessionId: string, memberId: string): Promise<Member | undefined> {
    const m = this.everyMember(sessionId).find((mm) => mm.memberId === memberId);
    return m && detach(m);
  }

  async getMembers(sessionId: string, memberIds: readonly string[]): Promise<Member[]> {
    const wanted = new Set(memberIds);
    return detach(this.everyMember(sessionId).filter((m) => wanted.has(m.memberId)));
  }

  async membersOfUser(sessionId: string, userId: string): Promise<Member[]> {
    return detach(this.everyMember(sessionId).filter((m) => m.userId === userId));
  }

  async departedMembers(sessionId: string, opts?: { limit?: number; leftAfter?: number }): Promise<DepartedMembers> {
    return detach(departures(this.everyMember(sessionId), opts));
  }

  async publicNumbers(sessionId: string, labels: readonly string[]): Promise<Record<string, number>> {
    const members = this.everyMember(sessionId);
    return Object.fromEntries(labels.flatMap((label) => {
      const n = members.find((m) => m.label === label && m.publicNumber !== null)?.publicNumber;
      return n == null ? [] : [[label, n]];
    }));
  }

  async closeSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.closeNow(s);
    await this.sweepAfterClose(sessionId);
  }

  async closeSessionIfEmpty(sessionId: string): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    // No await from here to the write, deliberately. The check and the close are
    // one operation, and a yield between them is the window a join lands in: the
    // same rule, and the same reason, as waitForEvents and the guarded grant
    // writes. The Durable Objects store gets it from a transaction instead. The
    // sweep that follows is after the close, so it is outside that rule.
    if (s.closed) return true;
    if (s.members.some(isActivePerson)) return false;
    this.closeNow(s);
    await this.sweepAfterClose(sessionId);
    return true;
  }

  /**
   * The sweep as a room closes (#65, D3), for the store that has no alarm to run it. A bucket that
   * refuses must not turn a close that happened into a failure: the room is closed either way,
   * `blobsSwept` stays false, and `sweep` finds the room and tries again.
   */
  private async sweepAfterClose(sessionId: string): Promise<void> {
    // Only a sweep that is owed: a second close of a room already swept looks at nothing.
    const s = this.sessions.get(sessionId);
    if (!s || sweepDueAt(s) === null) return;
    try {
      await this.sweepBlobs(sessionId);
    } catch (err) {
      console.error(`sweep of ${sessionId} failed; the next sweep tries again:`, err);
    }
  }

  async sweepBlobs(sessionId: string): Promise<{ removed: number; credited: number }> {
    const room = this.sessions.get(sessionId);
    if (!room || !room.closed) return { removed: 0, credited: 0 };
    // The objects are listed before the rows are read, so an object an item names is listed first
    // and named after, never the reverse.
    const listed = await this.blobs.list(sessionId);
    const orphans = unnamedObjects(listed, await this.surfaceOf(sessionId));
    let credited = 0;
    for (const object of orphans) {
      await this.blobs.delete(sessionId, object.id);
      credited += object.bytes;
    }
    // Read again, because the awaits above are where a purge or another sweep could get in. Only the
    // sweep that finds `blobsSwept` still false credits the room, so two that listed the same
    // objects do not free the same bytes twice.
    const s = this.sessions.get(sessionId);
    if (s && !s.blobsSwept) {
      const charged = (s as { blobBytes?: number }).blobBytes ?? 0;
      (s as { blobBytes?: number }).blobBytes = creditedBlobBytes(charged, credited);
      s.blobsSwept = true;
    }
    return { removed: orphans.length, credited };
  }

  /**
   * The close itself, with no awaits in it, so both public closers can call it
   * without yielding between their guard and their write. The same arrangement,
   * and the same reason, as appendNow.
   *
   * Agrees with closeIfAbandoned: a closed room's codes stop resolving AND stop
   * occupying the index, rather than relying on the `closed` guard alone.
   *
   * Dates the close once (#65): `closedAt` is where the retention window starts, so a
   * second close, or a read that finds the room closed again, must not move it. `at` is
   * the clock of the caller that has one, so an abandonment is dated as its
   * `session_expired` event is.
   */
  private closeNow(s: Session, at = Date.now()): void {
    s.closed = true;
    s.closedAt ??= at;
    for (const rec of Object.values(s.joinCodes)) this.byJoinCode.delete(rec.code);
    s.joinCodes = {};
    // A hosted room gives its creator's slot back as it closes (I7), however it closes.
    if (s.manifest.host !== null) this.hostedOpen.get(s.createdBy)?.delete(s.id);
    // Whatever a stranger is waiting on is told it will not come, in the turn the room closes (A2A).
    this.endOutside(s, "closed", at);
  }

  /**
   * Freeze the room, or thaw it with null.
   *
   * The thaw credits every reporting seat with a report: spec D10, and
   * `clearSilence` carries the argument. Here as well as in `SessionDO` because it
   * is what a thaw MEANS rather than anything the alarm does — `lastReportAt` is
   * read back through `getSession`, so a store that left it alone would report
   * every member silent for the length of the outage. The contract suite has the
   * case, and that is what keeps the two implementations saying the same thing.
   *
   * **The credit is paid on the TRANSITION, not on the argument.** A `null` on a
   * room that is already thawed thaws nothing, and crediting on it stamps every
   * reporting seat with a report nobody made — so a caller retrying this
   * idempotent call keeps resetting every member's clock and nobody is ever due
   * again. `wasFrozen` is read before the assignment below, because that
   * assignment is what destroys the answer.
   *
   * The thaw also stamps every active member as seen now (#18). `touchMember`
   * refuses a frozen room, so the window was not moving while it was frozen;
   * without this stamp a room thawed after 90 days frozen would be swept on the
   * next read.
   *
   * And it records the moment, `thawedAt` (#66, R9), which housekeeping floors its
   * clocks at: a finding computed across the freeze would name a condition the room
   * imposed. Paid on the same transition, for the same reason.
   */
  async freezeSession(sessionId: string, frozenAt: number | null): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const wasFrozen = s.frozenAt !== null;
    s.frozenAt = frozenAt;
    if (frozenAt === null && wasFrozen) {
      const now = Date.now();
      // The report credit (#111 D10) and the presence stamp (#18) ride the same
      // transition: a room coming back from a freeze gets a full window, not the
      // one the freeze spent.
      s.members = stampSeen(clearSilence(s, now), now);
      s.thawedAt = now;
    }
  }

  async schedulePurge(sessionId: string, at: number, by: AuditActor | null): Promise<PurgeSchedule> {
    const s = this.sessions.get(sessionId);
    if (!s) return { ok: false, reason: "missing" };
    if (!s.closed) return { ok: false, reason: "open" };
    // Asked already: the first request stands, is on the record once, and is the time the answer gives.
    if (s.purgeAt !== null) return { ok: true, purgeAt: s.purgeAt };
    s.purgeAt = at;
    this.recordAudit(s.orgs.map((orgId) => roomDeletedEntry(s, orgId, rosterParties(s), by, Date.now())));
    return { ok: true, purgeAt: at };
  }

  async unpublishSession(sessionId: string, at: number): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s || s.unpublishedAt != null) return;
    s.unpublishedAt = at;
    for (const [role, rec] of Object.entries(s.joinCodes)) {
      if (rec.expiresAt !== null) continue;
      this.byJoinCode.delete(rec.code);
      delete s.joinCodes[role];
    }
    this.endOutside(s, "unpublished", at);
  }

  async publicNameEntry(name: string): Promise<PublicNameEntry | null> {
    const entry = this.byPublicName.get(name);
    return entry ? { ...entry } : null;
  }

  async publicNameEntries(limit: number): Promise<{ name: string; entry: PublicNameEntry }[]> {
    return [...this.byPublicName].sort(([a], [b]) => (a < b ? -1 : 1)).slice(0, limit).map(([name, entry]) => ({ name, entry: { ...entry } }));
  }

  async claimPublicName(name: string, entry: PublicNameEntry, expected: PublicNameEntry | null): Promise<boolean> {
    if (!sameEntry(this.byPublicName.get(name) ?? null, expected)) return false;
    this.byPublicName.set(name, { ...entry });
    return true;
  }

  async releasePublicName(name: string, expected: PublicNameEntry): Promise<boolean> {
    if (!sameEntry(this.byPublicName.get(name) ?? null, expected)) return false;
    this.byPublicName.delete(name);
    return true;
  }

  async setPublicName(sessionId: string, name: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) s.publicName = name;
  }

  async setPublicView(sessionId: string, view: PublicView): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) s.publicView = view;
  }

  async sessionsCreatedBy(userId: string, limit: number): Promise<string[]> {
    const mine = this.byCreator.get(userId);
    if (!mine) return [];
    const live: string[] = [];
    for (const id of mine) {
      if (live.length >= limit) break;
      const s = this.sessions.get(id);
      // `closeIfAbandoned` first, for the same reason getSession calls it: an
      // abandoned room is closed whether or not anything has written that down
      // yet, and a sweep that read the flag alone would keep every abandoned room
      // in the window until something else happened to touch it.
      if (s) this.closeIfAbandoned(s, Date.now());
      if (s && !s.closed) {
        live.push(id);
        continue;
      }
      // Self-healing, and the reason `limit` can now be trusted: the row goes as
      // it is encountered, so a walk pays for a dead room once rather than on
      // every listing forever (#75).
      mine.delete(id);
    }
    return live;
  }

  async sessionsJoinedBy(userId: string, limit: number): Promise<string[]> {
    return [...(this.byMember.get(userId) ?? [])].slice(0, limit);
  }

  async sessionsForOrg(orgId: string, limit: number): Promise<string[]> {
    return [...(this.byOrg.get(orgId) ?? [])].slice(0, limit);
  }

  async appendEvent(
    sessionId: string,
    e: Omit<SessionEvent, "cursor" | "at">,
    extras: AppendExtras = {}
  ): Promise<SessionEvent | null> {
    if (extras.surface !== undefined && isFrameWrite(extras.surface)) throw new Error(FRAME_WRITE_PATH);
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session ${sessionId}`);
    if (s.frozenAt !== null) return null;
    // Synchronous from here, so the event and its extras land together. The
    // Durable Objects store gets that from a transaction; here it is the absence
    // of an await, the same arrangement closeSessionIfEmpty and appendNow use.
    const placed = this.placed(s, e, extras);
    const event = this.appendNow(s, placed.e);
    this.applyExtras(s, event, placed.extras);
    this.wakeHost(s, event);
    return detach(event);
  }

  /**
   * The step `placedAppend` takes in session-do.ts, over the map (surface placement spec D3): an item that arrives
   * with no placement is placed from the rows the room holds, and the event goes in with the placement the row
   * takes, so the log and the row agree. Everything else comes back untouched. A replay never gets here:
   * `appendEventOnce` returns the original event first.
   *
   * No awaits, for appendEvent's reason: the read of the rows and the write that fills the slot are one turn,
   * so two writes that land together cannot take one slot.
   */
  private placed(s: Session, e: Omit<SessionEvent, "cursor" | "at">, extras: AppendExtras): { e: Omit<SessionEvent, "cursor" | "at">; extras: AppendExtras } {
    if (extras.surface === undefined || !needsPlacement(extras.surface)) return { e, extras };
    const surface = withPlacement([...(this.surfaces.get(s.id)?.values() ?? [])], extras.surface);
    return surface === extras.surface ? { e, extras } : { e: { ...e, payload: surface.item }, extras: { ...extras, surface } };
  }

  /**
   * Called synchronously once an append has landed that wakes the hosted seat
   * (hosted seat spec, D4): hands the wake to `options.host`, the Node server's
   * `MemoryHost`, or to nothing when none was given. `SessionDO` queues the same
   * wakes as outbox rows, in the event's own transaction.
   */
  protected hostWoken(wake: HostWake): void {
    this.options.host?.(wake);
  }

  /**
   * Wake the hosted seat if `event` is one of the two causes (spec D4): a
   * `heartbeat`, or a reply to one of the host's events, in a room whose
   * manifest has a host and which has not evicted it (`hostSeated`, C1).
   *
   * Called by the two public appends once the event and its extras have landed,
   * which are `SessionDO`'s places too, and not from `appendNow`: the host's own
   * answer names its question as `refId`, so it reads as a reply, and
   * `appendHostEvent` queues no wake in either store. No awaits, for
   * appendEvent's reason.
   *
   * The two causes stay two (ruling H1). A housekeeping proposal (#66) is a server event
   * with no `refId`, so it falls through here, and it must: waking spends the room's
   * host units on the server's initiative, which a proposal's design rules out.
   */
  private wakeHost(s: Session, event: SessionEvent): void {
    if (s.manifest.host === null || !hostSeated(s)) return;
    if (event.type === "heartbeat") this.hostWoken({ sessionId: s.id, cause: "tick", cursor: event.cursor });
    else if (event.refId !== null) {
      const referenced = s.events.find((x) => x.cursor === Number(event.refId));
      if (isReplyToHost(event, referenced)) this.hostWoken({ sessionId: s.id, cause: "reply", cursor: event.cursor });
    }
  }

  async appendHostEvent(sessionId: string, e: Omit<SessionEvent, "cursor" | "at">, units: number, now: number, key: string): Promise<HostAppend> {
    const s = this.sessions.get(sessionId);
    if (!s) return { ok: false, reason: "not_found", used: 0, allowed: 0 };
    // Synchronous from here, for appendEventOnce's reason: the key check, the event, the
    // meter, the stamp and the audit row land together.
    const storageKey = idempotencyKey(e.fromMemberId, key);
    const done = this.keys.get(sessionId)?.get(storageKey);
    if (done) {
      const original = s.events.find((ev) => ev.cursor === done.cursor);
      if (!original) throw new Error(`Idempotency record names missing cursor ${done.cursor}`);
      return { ok: true, event: detach(original) };
    }
    const charge = decideHostCharge(s, units, now);
    if (!charge.ok) return charge;
    const event = this.appendNow(s, e);
    const keys = this.keys.get(sessionId) ?? new Map<string, IdempotencyRecord>();
    keys.set(storageKey, { cursor: event.cursor, print: fingerprint(e) });
    this.keys.set(sessionId, keys);
    s.hostUnits = charge.next;
    s.members = s.members.map((m) => m.memberId === e.fromMemberId ? { ...m, lastSeenAt: now } : m);
    this.recordAudit(hostSentEntries(s, e, now));
    return { ok: true, event: detach(event) };
  }

  async renewHostAllowance(sessionId: string, month: string, units: number): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s || s.hostUnits.month >= month) return;
    s.hostUnitsPerMonth = units;
    s.hostUnits = { month, used: 0, wakes: [] };
  }

  async setHostInstructions(sessionId: string, instructions: string | null, audit: readonly AuditEntry[]): Promise<HostInstructionsSet> {
    const s = this.sessions.get(sessionId);
    if (!s) return { ok: false, reason: "not_found" };
    const host = s.manifest.host;
    if (host === null) return { ok: false, reason: "no_host" };
    if (s.closed) return { ok: false, reason: "closed" };
    // No await from the read to the write, as `renewHostAllowance` has none. A new manifest rather than a write
    // into the old one: a manifest object can be shared.
    if (host.instructions !== instructions) {
      s.manifest = { ...s.manifest, host: { ...host, instructions } };
      this.recordAudit([...audit]);
    }
    return { ok: true, instructions };
  }

  async getConfigRow(sessionId: string, name: ConfigName): Promise<ConfigRow | null> {
    const row = this.configs.get(sessionId)?.get(name)?.[0];
    return row === undefined ? null : detach(row);
  }

  async configHistory(sessionId: string, name: ConfigName): Promise<ConfigRow[]> {
    return detach(this.configs.get(sessionId)?.get(name) ?? []);
  }

  async writeConfig(sessionId: string, w: ConfigWrite, audit: readonly AuditEntry[]): Promise<ConfigWriteResult> {
    const s = this.sessions.get(sessionId);
    if (!s) return { ok: false, reason: "not_found" };
    if (s.closed) return { ok: false, reason: "closed" };
    // No await from the read to the write, as setHostInstructions.
    const room = this.configs.get(sessionId) ?? new Map<ConfigName, ConfigRow[]>();
    const kept = room.get(w.name) ?? [];
    const decided = decideConfigWrite(s, kept[0] ?? null, detach(w), new Date().toISOString());
    if (!decided.ok) return decided.result;
    room.set(w.name, [decided.row, ...kept].slice(0, CONFIG_HISTORY));
    this.configs.set(sessionId, room);
    s.configRevs = decided.configRevs;
    s.configBytes = decided.configBytes;
    this.appendNow(s, configEvent(decided.row));
    this.recordAudit([...audit]);
    return { ok: true, rev: decided.row.rev };
  }

  async readFs(sessionId: string, path: string, rev?: number): Promise<FsRow | null> {
    const f = this.files.get(sessionId)?.get(path);
    if (!f) return null;
    const row = rev === undefined ? (f.current.deleted ? undefined : f.current) : f.history.find((r) => r.rev === rev);
    return row === undefined ? null : detach(row);
  }

  async listFs(sessionId: string, prefix: string, opts: { cursor?: string; hide?: readonly string[]; newest?: boolean } = {}): Promise<FsPage> {
    return detach(pageFs(this.sortedFiles(sessionId), (r) => underPrefix(r.path, prefix) && !hiddenMemory(r, opts.hide), FS_LIST_PAGE, opts.cursor, opts.newest ? newestKey : undefined));
  }

  async readHomeSettings(id: string): Promise<HomeSettings> {
    return detach({ ...DEFAULT_HOME_SETTINGS, ...this.homeSettings.get(id) });
  }

  async writeHomeSettings(id: string, settings: HomeSettings): Promise<void> {
    this.homeSettings.set(id, detach(settings));
  }

  async readRepoRooms(id: string): Promise<RepoRoom[]> {
    return detach(this.repoRooms.get(id) ?? []);
  }

  async writeRepoRooms(id: string, rows: RepoRoom[]): Promise<void> {
    this.repoRooms.set(id, detach(rows));
  }

  async readHomeLogged(id: string, path: string, source: LookupSource): Promise<{ paused: true } | { paused: false; file: FsRow | null }> {
    if (this.homeSettings.get(id)?.paused) return { paused: true };
    const file = await this.readFs(id, path);
    this.logLookup(id, source, file ? [file.path] : []);
    return { paused: false, file };
  }

  async listHomeLogged(id: string, prefix: string, cursor: string | undefined, source: LookupSource): Promise<{ paused: true } | { paused: false; page: FsPage }> {
    if (this.homeSettings.get(id)?.paused) return { paused: true };
    const page = await this.listFs(id, prefix, { newest: true, cursor });
    this.logLookup(id, source, page.entries.map((e) => e.path));
    return { paused: false, page };
  }

  private logLookup(id: string, source: LookupSource, paths: string[]): void {
    const at = Date.now();
    const rows = [detach({ ...source, at, paths }), ...(this.lookups.get(id) ?? [])].filter((r) => r.at >= at - LOOKUP_KEEP_MS);
    // As SessionDO's #logLookup: past LOOKUP_KEEP + LOOKUP_SLACK rows, trimmed back to LOOKUP_KEEP.
    this.lookups.set(id, rows.length > LOOKUP_KEEP + LOOKUP_SLACK ? rows.slice(0, LOOKUP_KEEP) : rows);
  }

  async homeLookups(id: string): Promise<LookupRow[]> {
    const kept = (this.lookups.get(id) ?? []).slice(0, LOOKUP_KEEP);
    if (this.lookups.has(id)) this.lookups.set(id, kept);
    return detach(kept);
  }

  async purgeHome(id: string): Promise<void> {
    // The home room's rows, as SessionDO's deleteAll() takes them; a waiter is answered with nothing, as purgeNow does.
    if (!isHomeRoomId(id)) throw new Error(`purgeHome: ${id} is not a home room`);
    for (const w of this.waiters.get(id) ?? []) w.resolve([]);
    for (const map of [this.waiters, this.sessions, this.files, this.homeKeys, this.homeSettings, this.lookups, this.sends, this.briefs]) map.delete(id);
  }

  async forgetHomeNote(id: string, path: string): Promise<boolean> {
    const s = this.sessions.get(id);
    const current = this.files.get(id)?.get(path)?.current;
    if (!s || !current || current.deleted) return false;
    // `forget` at the current revision, as the account: a delete is never paused and frees bytes, so the ceiling is moot.
    const w: FsWrite = { path, write: { op: "delete", baseRev: current.rev }, memberId: HOME_MEMBER_ID, userId: s.creator.userId, label: s.creator.label, key: null };
    if (this.writeHomeIn(id, null, w, 0).outcome !== "ok") return false;
    // Only the rows that returned the note change; one left with no paths goes.
    const rows = this.lookups.get(id) ?? [];
    this.lookups.set(id, rows.flatMap((r) => {
      if (!r.paths.includes(path)) return [r];
      const paths = r.paths.filter((p) => p !== path);
      return paths.length > 0 ? [{ ...r, paths }] : [];
    }));
    return true;
  }

  async writeHome(id: string, home: NewSession, w: FsWrite, ceiling: number): Promise<HomeAppend> {
    return this.writeHomeIn(id, home, w, ceiling);
  }

  /** `writeHome`, synchronous from the key check to the last row, as appendFs. `home` null: the record must exist, or `not_found`. */
  private writeHomeIn(id: string, home: NewSession | null, w: FsWrite, ceiling: number): HomeAppend {
    const storageKey = w.key === null ? null : homeKey(w.memberId, w.key);
    const print = fsPrint(w);
    const record = storageKey === null ? undefined : this.homeKeys.get(id)?.get(storageKey);
    if (record) return record.print === print ? { outcome: "replayed", path: record.path, rev: record.rev } : { outcome: "conflict" };
    if (w.write.op === "write" && this.homeSettings.get(id)?.paused) return { outcome: "paused" };
    if (namespaceOf(w.path).ns === "app") return { outcome: "forbidden" };
    let s = this.sessions.get(id);
    if (!s) {
      if (home === null) return { outcome: "not_found" };
      // Created by the first write, and indexed nowhere: not by creator, member, org or the operator's room table.
      const { members, briefs } = seatInOrder(home.members, { memberSeq: 0, labelSeq: 0 });
      s = detach({ ...home, members, creator: creatorOf(members[0]), orgs: orgsOnRoster({ members }) });
      this.keepBriefs(id, briefs);
      this.sessions.set(id, s);
    }
    const files = this.files.get(id) ?? new Map<string, { current: FsRow; history: FsRow[] }>();
    const f = files.get(w.path);
    const decided = decideFsWrite({ ...s, fsBytesCeiling: ceiling }, detach(w), w.path, f?.current ?? null, f?.history ?? [], Date.now(), true);
    if (!decided.ok) return decided.result;
    const kept = f?.history ?? [];
    files.set(w.path, { current: decided.row, history: decided.row.deleted ? [] : [decided.row, ...kept.filter((r) => !decided.dropRevs.includes(r.rev))] });
    this.files.set(id, files);
    (s as { fsBytes?: number }).fsBytes = decided.fsBytes;
    if (storageKey !== null) {
      const map = this.homeKeys.get(id) ?? new Map<string, HomeKeyRecord>();
      map.set(storageKey, { print, path: w.path, rev: decided.row.rev });
      this.homeKeys.set(id, map);
    }
    return { outcome: "ok", path: w.path, rev: decided.row.rev };
  }

  async fsHistory(sessionId: string, path: string): Promise<FsRow[]> {
    return detach(this.files.get(sessionId)?.get(path)?.history ?? []);
  }

  async findFs(sessionId: string, query: string, opts: { cursor?: string; hide?: readonly string[] } = {}): Promise<FsPage> {
    return detach(pageFs(this.sortedFiles(sessionId), (r) => pathMatches(r.path, query) && !hiddenMemory(r, opts.hide), FS_FIND_MAX, opts.cursor));
  }

  private sortedFiles(sessionId: string): FsRow[] {
    return [...(this.files.get(sessionId)?.values() ?? [])].map((f) => f.current).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async appendFs(sessionId: string, w: FsWrite, audit: readonly AuditEntry[]): Promise<FsAppend> {
    const s = this.sessions.get(sessionId);
    if (!s) return { outcome: "not_found" };
    // Synchronous from the key check to the last row, as appendSurface.
    const storageKey = w.key === null ? null : idempotencyKey(w.memberId, w.key);
    const print = fsPrint(w);
    const record = storageKey === null ? undefined : this.keys.get(sessionId)?.get(storageKey);
    if (record) {
      if (record.print !== print) return { outcome: "conflict" };
      const original = s.events.find((ev) => ev.cursor === record.cursor);
      if (!original) throw new Error(`Idempotency record for ${sessionId} names missing cursor ${record.cursor}`);
      return { outcome: "replayed", event: detach(original) };
    }
    if (s.closed) return { outcome: "closed" };
    if (s.frozenAt !== null) return { outcome: "frozen" };
    const ids = this.memoryIdRows.get(sessionId) ?? new Map<string, string>();
    const named = namespaceOf(w.path);
    const namedOwner = named.ns === "memory" && named.memoryId !== null
      ? [...ids].find(([, id]) => id === named.memoryId)?.[0] ?? null
      : null;
    const resolved = resolveFsPath(w, ids.get(w.userId) ?? null, namedOwner, newMemoryId);
    if (!resolved.ok) return { outcome: "forbidden" };
    const files = this.files.get(sessionId) ?? new Map<string, { current: FsRow; history: FsRow[] }>();
    const f = files.get(resolved.path);
    const at = Date.now();
    const decided = decideFsWrite(s as Session & { fsBytes?: number }, detach(w), resolved.path, f?.current ?? null, f?.history ?? [], at);
    if (!decided.ok) return decided.result;
    const kept = f?.history ?? [];
    const history = decided.row.deleted ? [] : [decided.row, ...kept.filter((r) => !decided.dropRevs.includes(r.rev))];
    files.set(resolved.path, { current: decided.row, history });
    this.files.set(sessionId, files);
    if (resolved.assign !== null) {
      ids.set(w.userId, resolved.assign);
      this.memoryIdRows.set(sessionId, ids);
    }
    (s as { fsBytes?: number }).fsBytes = decided.fsBytes;
    s.fsMemoryBytes = decided.fsMemoryBytes;
    const event = this.appendNow(s, decided.event, at);
    if (storageKey !== null) {
      const map = this.keys.get(sessionId) ?? new Map<string, IdempotencyRecord>();
      map.set(storageKey, { cursor: event.cursor, print });
      this.keys.set(sessionId, map);
    }
    this.recordAudit(audit.map((e) => ({ ...e, detail: { ...e.detail, ...decided.stamp } })));
    return { outcome: "ok", path: resolved.path, rev: decided.row.rev, event: detach(event) };
  }

  async memoryIdOf(sessionId: string, userId: string): Promise<string | null> {
    return this.memoryIdRows.get(sessionId)?.get(userId) ?? null;
  }

  async memoryIdOwner(sessionId: string, memoryId: string): Promise<string | null> {
    return [...(this.memoryIdRows.get(sessionId) ?? [])].find(([, id]) => id === memoryId)?.[0] ?? null;
  }

  async memoryIds(sessionId: string): Promise<Array<{ userId: string; memoryId: string }>> {
    return [...(this.memoryIdRows.get(sessionId) ?? [])].map(([userId, memoryId]) => ({ userId, memoryId }));
  }

  async notesSharers(sessionId: string): Promise<string[]> {
    return [...(this.notesSharing.get(sessionId) ?? [])];
  }

  async setNotesSharing(sessionId: string, userId: string, shared: boolean): Promise<void> {
    const sharers = this.notesSharing.get(sessionId) ?? new Set<string>();
    if (shared) sharers.add(userId); else sharers.delete(userId);
    this.notesSharing.set(sessionId, sharers);
  }

  async hostEventFor(sessionId: string, key: string): Promise<SessionEvent | undefined> {
    const done = this.keys.get(sessionId)?.get(idempotencyKey(HOST_MEMBER_ID, key));
    const s = this.sessions.get(sessionId);
    const event = done && s?.events.find((ev) => ev.cursor === done.cursor);
    return event ? detach(event) : undefined;
  }

  /**
   * Apply an append's `extras`, if it asked for any. The roster rules,
   * `creditReport` and `markRemoved`, live in members.ts and the surface rule,
   * `applySurfaceWrite`, in surface.ts; `SessionDO`'s `extraRows` applies the
   * same functions, so the two stores cannot disagree about when an extra rides
   * an append. The action-request stamp is the one extra with no function to
   * share: it is a line in each store.
   *
   * One method rather than one per extra, because the two roster rules rewrite
   * the same member array: applied separately, the second would read `s.members`
   * from before the first and discard it.
   *
   * No awaits, for appendEvent's reason above.
   */
  private applyExtras(s: Session, event: SessionEvent, extras: AppendExtras): void {
    let members = s.members;
    if (extras.creditReport) {
      members = creditReport(members, event.fromMemberId, event.at) ?? members;
    }
    if (extras.markRemoved !== undefined) {
      members = markRemoved(members, extras.markRemoved, event.cursor, event.at) ?? members;
    }
    if (members !== s.members) s.members = members;
    // Monotonic, so a replay of an older append cannot pull the stamp back and
    // make a live request invisible to the poll.
    if (extras.stampActionRequest) {
      const stored = s as { lastActionRequestAt?: number };
      stored.lastActionRequestAt = Math.max(stored.lastActionRequestAt ?? 0, event.at);
    }
    if (extras.outsideTask !== undefined) {
      const task = extras.outsideTask;
      if (task.sessionId !== s.id) throw new Error(`Outside task ${task.id} belongs to ${task.sessionId}, not ${s.id}`);
      const tasks = this.outsideTasks.get(s.id) ?? new Map<string, OutsideTask>();
      tasks.set(task.id, detach(taskWithEvent(task, event)));
      this.outsideTasks.set(s.id, tasks);
    }
    if (extras.outsideCaller !== undefined) {
      const callers = this.outsideCallerRows.get(s.id) ?? new Map<string, OutsideCaller>();
      callers.set(extras.outsideCaller.userId, detach(extras.outsideCaller));
      this.outsideCallerRows.set(s.id, callers);
    }
    if (extras.surface !== undefined) {
      const rows = this.surfaces.get(s.id) ?? new Map<string, SurfaceRow>();
      const verdict = applySurfaceWrite(rows.get(extras.surface.key), event, extras.surface, extras.approvedBy);
      if (verdict !== null) {
        // Copied in, as the event is in `appendNow`: the item holds objects of its
        // own (`placement`, `ends`), and storing the caller's would let a caller
        // that kept them rewrite the row. The Durable Object store gets the copy
        // from the RPC boundary.
        if (verdict === "remove") rows.delete(extras.surface.key);
        else rows.set(extras.surface.key, detach(verdict));
        this.surfaces.set(s.id, rows);
        // Monotonic, as the action-request stamp is: a change moves it forward
        // and nothing moves it back.
        const stored = s as { surfaceCursor?: number };
        stored.surfaceCursor = Math.max(stored.surfaceCursor ?? 0, event.cursor);
      }
    }
  }

  async appendEventOnce(
    sessionId: string,
    e: Omit<SessionEvent, "cursor" | "at">,
    key: string,
    extras: AppendExtras = {}
  ): Promise<EventWrite> {
    if (extras.surface !== undefined && isFrameWrite(extras.surface)) throw new Error(FRAME_WRITE_PATH);
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session ${sessionId}`);

    // Everything from here to appendNow is synchronous, deliberately. An await
    // in this stretch yields, and this method's own retry can read the same
    // empty slot in the gap and append a second event.
    const storageKey = idempotencyKey(e.fromMemberId, key);
    const seen = this.keys.get(sessionId);
    const record = seen?.get(storageKey);
    const print = fingerprint(e);

    if (record) {
      if (record.print !== print) return { outcome: "conflict" };
      const original = s.events.find((ev) => ev.cursor === record.cursor);
      // A record naming a cursor with no event is a store bug, not a replay.
      // Returning "replayed" without one would crash the caller a frame later,
      // where nothing says why.
      if (!original) {
        throw new Error(
          `Idempotency record for ${sessionId} names missing cursor ${record.cursor}`
        );
      }
      // The replay re-asserts the member extras (`creditReport`, `markRemoved`
      // and `stampActionRequest`) and applies no surface write.
      //
      // A retry cannot know whether the first attempt landed a member write, and
      // each of the three is monotonic or answers `null` once it is recorded, so
      // re-asserting one is either a repair or a no-op and never a regression.
      // `original` and not `e`, so `markRemoved` sees the cursor the key names: a
      // replay re-asserts the same cut.
      //
      // The surface write is the exception, so it is taken out of the extras. The
      // row went in with the event in one transaction, so there is nothing to
      // repair, and whatever has happened to the key since carries a higher
      // cursor. A removal leaves no tombstone, so re-applying the original write
      // would find no row to compare against and could only put back what was
      // removed.
      this.applyExtras(s, original, { ...extras, surface: undefined });
      return { outcome: "replayed", event: detach(original) };
    }

    if (s.frozenAt !== null) return { outcome: "frozen" };

    // After the replay branch and the frozen check, so neither reads the surface, and with `print` already
    // taken from the draft as the caller sent it: a retry reads as a retry however the room has changed.
    const placed = this.placed(s, e, extras);
    const event = this.appendNow(s, placed.e);
    const map = seen ?? new Map<string, IdempotencyRecord>();
    map.set(storageKey, { cursor: event.cursor, print });
    this.keys.set(sessionId, map);
    this.applyExtras(s, event, placed.extras);
    this.wakeHost(s, event);
    return { outcome: "appended", event: detach(event) };
  }

  async idempotencyRecord(sessionId: string, memberId: string, key: string): Promise<IdempotencyRecord | null> {
    const record = this.keys.get(sessionId)?.get(idempotencyKey(memberId, key));
    return record ? { ...record } : null;
  }

  async appendSurface(
    sessionId: string,
    e: EventBody,
    extras: { surface: SurfaceWrite; approvedBy?: ApprovedBy },
    key: string | null,
  ): Promise<SurfaceAppend> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session ${sessionId}`);

    // Synchronous from the key check to the last row, for appendEventOnce's reason, and so the rows placement
    // reads are the rows the write lands among: of two frames that meet, the second reads the first.
    const storageKey = key === null ? null : idempotencyKey(e.fromMemberId, key);
    const print = surfacePrint(e, extras.surface);
    const seen = this.keys.get(sessionId);
    const record = storageKey === null ? undefined : seen?.get(storageKey);
    if (record) {
      if (record.print !== print) return { outcome: "conflict" };
      const original = s.events.find((ev) => ev.cursor === record.cursor);
      if (!original) throw new Error(`Idempotency record for ${sessionId} names missing cursor ${record.cursor}`);
      return { outcome: "replayed", event: detach(original) };
    }
    if (s.frozenAt !== null) return { outcome: "frozen" };

    const placed = this.placedAmongRows(sessionId, extras.surface);
    if (!placed.ok) return { outcome: "refused", kind: placed.kind, reason: placed.reason };
    const { event, carried } = this.surfaceNow(s, placedEvent(e, extras.surface, placed), placed, extras.approvedBy, Date.now());
    if (storageKey !== null) {
      const map = seen ?? new Map<string, IdempotencyRecord>();
      map.set(storageKey, { cursor: event.cursor, print });
      this.keys.set(sessionId, map);
    }
    return { outcome: "appended", event: detach(event), carried: carried.map(detach) };
  }

  async appendSurfaces(
    sessionId: string,
    author: SurfaceAuthor,
    writes: readonly SurfaceWrite[],
    key: string | null,
  ): Promise<SurfaceBatchAppend> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session ${sessionId}`);

    // Synchronous from the key check to the last row, for appendSurface's reason.
    const storageKey = key === null ? null : idempotencyKey(author.fromMemberId, key);
    const print = surfaceBatchPrint(author, writes);
    const seen = this.keys.get(sessionId);
    const record = storageKey === null ? undefined : seen?.get(storageKey);
    if (record) {
      if (record.print !== print) return { outcome: "conflict" };
      const original = s.events.find((ev) => ev.cursor === record.cursor);
      if (!original) throw new Error(`Idempotency record for ${sessionId} names missing cursor ${record.cursor}`);
      return { outcome: "replayed", event: detach(original) };
    }
    if (s.frozenAt !== null) return { outcome: "frozen" };

    const at = Date.now();
    const rows = writes.some(placesAmongRows) ? [...(this.surfaces.get(sessionId)?.values() ?? [])] : [];
    const placed = placeSurfaceBatch(rows, writes, author, s.events.length + 1, at);
    if (!placed.ok) return { outcome: "refused", index: placed.index, kind: placed.kind, reason: placed.reason };
    // The waiters are held for the batch and woken once after it, as SessionDO's one wake after its commit: a poll
    // waiting on the room is handed the whole batch, not its first event. Nothing can register in between, since
    // this stretch is synchronous.
    const held = this.waiters.get(sessionId) ?? [];
    this.waiters.set(sessionId, []);
    const events: SessionEvent[] = [];
    for (const [i, { placed: one }] of placed.entries.entries()) {
      const { event, carried } = this.surfaceNow(s, placedEvent(batchEvent(author, writes[i]), writes[i], one), one, undefined, at);
      events.push(event, ...carried);
    }
    this.waiters.set(sessionId, held);
    this.wake(s);
    if (storageKey !== null) {
      const map = seen ?? new Map<string, IdempotencyRecord>();
      map.set(storageKey, { cursor: events[events.length - 1].cursor, print });
      this.keys.set(sessionId, map);
    }
    return { outcome: "appended", events: events.map(detach) };
  }

  /** `placeSurfaceWrite` over the room's rows, listed only when the write is placed among them (`placesAmongRows`). */
  private placedAmongRows(sessionId: string, write: SurfaceWrite): Placed {
    if (!placesAmongRows(write)) return { ok: true, write, carried: [] };
    return placeSurfaceWrite([...(this.surfaces.get(sessionId)?.values() ?? [])], write);
  }

  /**
   * A placed surface write appended: its event and row, then each carried card's event at the next cursor and
   * its row, which keeps its writer and approver (L2). No awaits, for appendEvent's reason.
   */
  private surfaceNow(
    s: Session,
    e: EventBody,
    placed: Extract<Placed, { ok: true }>,
    approvedBy: ApprovedBy | undefined,
    at: number,
  ): { event: SessionEvent; carried: SessionEvent[] } {
    const event = this.appendNow(s, e, at);
    this.applyExtras(s, event, { surface: placed.write, approvedBy });
    const carried = placed.carried.map((write) => {
      const row = this.surfaces.get(s.id)!.get(write.key)!;
      const ev = this.appendNow(s, carriedEvent(e, write), at);
      this.applyExtras(s, asRowWriter(ev, row), { surface: write, approvedBy: row.approvedBy });
      return ev;
    });
    return { event, carried };
  }

  async approveProposal(
    sessionId: string,
    e: EventBody,
    key: string | null,
    approval: ProposalApproval,
  ): Promise<ApprovalWrite> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session ${sessionId}`);

    // Synchronous from the first read to the last write, as `appendEventOnce`'s stretch is. A second approval of
    // the same proposal then reads the log with this one's response already in it, so of two that meet one
    // applies and the other is answered. An await anywhere in here would let both read a log with no answer.
    const keyed = key === null ? null : { storageKey: idempotencyKey(e.fromMemberId, key), print: fingerprint(e) };
    const seen = this.keys.get(sessionId);

    // The key first, and it re-checks nothing (R21): a retry returns its response however the room has changed.
    const record = keyed === null ? undefined : seen?.get(keyed.storageKey);
    if (keyed !== null && record) {
      if (record.print !== keyed.print) return { outcome: "conflict" };
      const original = s.events.find((ev) => ev.cursor === record.cursor);
      if (!original) {
        throw new Error(`Idempotency record for ${sessionId} names missing cursor ${record.cursor}`);
      }
      // The card by the cursor the record names; a record without one wrote none.
      const card = record.applied === undefined ? null : s.events.find((ev) => ev.cursor === record.applied);
      if (card === undefined) {
        throw new Error(`Idempotency record for ${sessionId} names missing card cursor ${record.applied}`);
      }
      return { outcome: "replayed", event: detach(original), written: card === null ? null : detach(card) };
    }
    if (s.frozenAt !== null) return { outcome: "frozen" };

    const request = s.events.find((ev) => ev.cursor === approval.requestCursor);
    if (request === undefined || request.type !== "action_request") {
      throw new Error(`Approval in ${sessionId} names cursor ${approval.requestCursor}, which holds no action_request`);
    }
    const write = approval.write;
    const decided = decideApproval({
      room: s as Session & { surfaceCursor?: number },
      approverId: e.fromMemberId,
      requestCursor: approval.requestCursor,
      base: approval.base,
      write,
      row: write === null ? undefined : this.surfaces.get(sessionId)?.get(write.key),
      after: s.events.filter((ev) => ev.cursor > approval.base),
    });
    if (decided.kind === "answered") return { outcome: "answered", by: decided.by };
    if (decided.kind === "stale") return { outcome: "stale", cursor: decided.cursor };

    // The card is placed among the frames before anything is appended, so a refusal writes neither event.
    const placed = decided.kind === "apply" && write !== null ? this.placedAmongRows(sessionId, write) : null;
    if (placed !== null && !placed.ok) return { outcome: "refused", kind: placed.kind, reason: placed.reason };

    // One clock for every event, as the Durable Objects store stamps them. An `action_response` is never a reply
    // to the host (`isReplyToHost` reads a message or a progress event), so no event here wakes it.
    const at = Date.now();
    const response = this.appendNow(s, e, at);
    // Written once the card's cursor is known, so a retry finds both.
    const remember = (applied?: number) => {
      if (keyed === null) return;
      const map = seen ?? new Map<string, IdempotencyRecord>();
      map.set(keyed.storageKey, { cursor: response.cursor, print: keyed.print, ...(applied === undefined ? {} : { applied }) });
      this.keys.set(sessionId, map);
    };
    if (placed === null || write === null || decided.kind !== "apply") {
      remember();
      return { outcome: "appended", event: detach(response), written: null, carried: [] };
    }

    // The card is the proposer's, as a surface event's author is its row's author everywhere (R18). It carries no
    // `refId`: nothing reads one off a `surface` event, and the response and the card are adjacent (R30).
    const draft: EventBody = {
      type: "surface", fromMemberId: request.fromMemberId, fromUserId: request.fromUserId, fromLabel: request.fromLabel,
      payload: write.item ?? { key: write.key, remove: true }, refId: null,
    };
    // Placed among the frames above, before the response was numbered: an item the proposer left unplaced takes
    // the next free slot, and the card's event carries the placement the row will (R19), then the cards a locked
    // move carried.
    const { event: card, carried } = this.surfaceNow(s, placedEvent(draft, write, placed), placed, decided.approvedBy, at);
    remember(card.cursor);
    return { outcome: "appended", event: detach(response), written: detach(card), carried: carried.map(detach) };
  }

  /**
   * A decision write's key (ADR 0040): the replay or the conflict when `key` was used, else what records it once the
   * event has its cursor. Read in the caller's synchronous stretch, as `approveProposal` reads its key.
   */
  private decisionKey(s: Session, e: EventBody, key: string | null):
    | { done: { outcome: "replayed"; event: SessionEvent } | { outcome: "conflict" }; recorded: SessionEvent | undefined }
    | { done: null; remember: (cursor: number) => void; storageKey: string | null } {
    if (key === null) return { done: null, remember: () => {}, storageKey: null };
    const storageKey = idempotencyKey(e.fromMemberId, key);
    const print = fingerprint(e);
    const record = this.keys.get(s.id)?.get(storageKey);
    if (record) {
      const original = s.events.find((ev) => ev.cursor === record.cursor);
      if (record.print !== print) return { done: { outcome: "conflict" }, recorded: original };
      if (!original) throw new Error(`Idempotency record for ${s.id} names missing cursor ${record.cursor}`);
      return { done: { outcome: "replayed", event: detach(original) }, recorded: original };
    }
    return {
      done: null,
      remember: (cursor) => this.keys.set(s.id, (this.keys.get(s.id) ?? new Map()).set(storageKey, { cursor, print })),
      storageKey,
    };
  }

  /** The room's open secret ballots as a fold reads them: decision → account → choice. */
  private book(s: Session): BallotBook {
    return new Map([...(this.ballots.get(s.id) ?? [])].map(([d, rows]) => [d, new Map([...rows].map(([a, r]) => [a, r.choice]))]));
  }

  /** The rows a secret ballot's close is filed under: the system, for the room's parties, never the closing call's actor. */
  private secretTemplate(s: Session, at: number): AuditEntry[] {
    return auditRows(rosterParties(s), { at, sessionId: s.id, action: "decision_closed", roomName: s.manifest.room, detail: {} }, SYSTEM_ACTOR);
  }

  /** Last in every write that closes: each closed secret ballot's rows and the idempotency records its votes used. */
  private eraseClosed(s: Session, events: readonly SessionEvent[]): void {
    const rooms = this.ballots.get(s.id);
    if (!rooms) return;
    for (const e of events) {
      if (e.type !== "decision_closed") continue;
      const decision = (e.payload as { decision: number }).decision;
      for (const row of rooms.get(decision)?.values() ?? []) for (const ik of row.iks) this.keys.get(s.id)?.delete(ik);
      rooms.delete(decision);
    }
  }

  /** The decision opened at `cursor` in `s`, read from its own cursor on. */
  private decisionIn(s: Session, cursor: number, now: number): DecisionView | undefined {
    return decisionsOf(s.events.filter((ev) => ev.cursor >= cursor), now, this.book(s)).get(cursor);
  }

  // Each decision write below is synchronous from its first read to its last write, as approveProposal's is.

  /**
   * Append `bodies` at `at`, and file their rows (`decisionAudit`) with the decisions as they read after them.
   * The Durable Objects store keeps the open decisions as a book on the record; this one reads them off its log.
   */
  private decisionWrites(s: Session, bodies: readonly EventBody[], at: number, audit: readonly AuditEntry[]): SessionEvent[] {
    const written = bodies.map((b) => this.appendNow(s, b, at));
    if (written.length > 0) {
      this.recordAudit(decisionAudit(audit, written, decisionsOf(s.events, at, this.book(s)), this.secretTemplate(s, at)).filter((r) => r.orgId));
    }
    this.eraseClosed(s, written);
    return written;
  }

  async openDecision(sessionId: string, e: EventBody, key: string | null, audit: readonly AuditEntry[] = []): Promise<DecisionOpen> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session ${sessionId}`);
    const k = this.decisionKey(s, e, key);
    if (k.done !== null) return k.done;
    if (s.frozenAt !== null) return { outcome: "frozen" };
    const draft = e.payload as DecisionDraft;
    const at = Date.now();
    const book = noteDecisions({}, s.events);
    const quota = decideOpenQuota(book, e.fromMemberId, at, draft.supersedes);
    if (quota.kind === "quota") return { outcome: "quota", scope: quota.scope, limit: quota.limit };
    const old = draft.supersedes === undefined ? undefined : this.decisionIn(s, draft.supersedes, at);
    if (draft.supersedes !== undefined) {
      const d = decideSupersede(old);
      if (d.kind === "not_open") return { outcome: "not_open", state: d.state };
    }
    const payload = openedPayload(draft, at, isTopicRoom(s.manifest), electorateOf(s.manifest, s.members, draft.effect.kind));
    const due = dueToExpire(book, at).map((c) => closingEvent(this.decisionIn(s, c, at)!, { state: "expired" }));
    const [event, superseded = null] = this.decisionWrites(s, [
      { ...e, payload }, ...(old === undefined ? [] : [closingEvent(old, { state: "failed", reason: "superseded" })]),
    ], at, audit);
    this.decisionWrites(s, due, at, audit);
    k.remember(event.cursor);
    return { outcome: "appended", event: detach(event), superseded: superseded === null ? null : detach(superseded) };
  }

  async castVote(sessionId: string, e: EventBody, key: string | null, audit: readonly AuditEntry[] = []): Promise<VoteWrite> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session ${sessionId}`);
    const input = e.payload as VoteInput;
    const opening = s.events.find((ev) => ev.cursor === input.decision && ev.type === "decision_opened");
    const secret = opening !== undefined && isSecret(opening.payload as DecisionOpened);
    const k = this.decisionKey(s, e, key);
    if (k.done !== null) {
      // A secret ballot gives one answer to any retry of a key its own vote used, so the retry tells nothing apart.
      const named = (k.recorded?.payload as { decision?: number } | undefined)?.decision;
      if (secret && named === input.decision) return { outcome: "recorded" };
      return k.done;
    }
    if (s.frozenAt !== null) return { outcome: "frozen" };
    const at = Date.now();
    const view = this.decisionIn(s, input.decision, at);
    if (view === undefined) return { outcome: "unknown" };
    const vote: DecisionVote = { ...input, capacity: capacityOfVote(input) };
    const account = view.payload.accounts[e.fromMemberId];
    const row = account === undefined ? undefined : this.ballots.get(s.id)?.get(view.cursor)?.get(account);
    const d = applyVote(view, { memberId: e.fromMemberId, userId: e.fromUserId }, vote, row?.n ?? 0);
    if (d.kind !== "record") return voteRefusal(d);
    // A secret vote is logged as the system with no choice; the choice goes into the account's ballot row.
    const event = secret
      ? this.appendNow(s, {
        ...e, fromMemberId: "system", fromUserId: "system", fromLabel: "bellman",
        payload: {
          decision: input.decision, hash: input.hash, via: input.via, human_approved: input.human_approved, capacity: vote.capacity, ballot: "secret",
        } satisfies SecretVote,
      }, at)
      : this.appendNow(s, { ...e, payload: vote }, at);
    if (secret) {
      const room = this.ballots.get(s.id) ?? new Map<number, Map<string, { choice: Choice; n: number; iks: string[] }>>();
      const rows = room.get(view.cursor) ?? new Map<string, { choice: Choice; n: number; iks: string[] }>();
      const iks = k.storageKey === null ? row?.iks ?? [] : [...(row?.iks ?? []), k.storageKey];
      rows.set(account!, { choice: vote.choice, n: (row?.n ?? 0) + 1, iks });
      this.ballots.set(s.id, room.set(view.cursor, rows));
    }
    k.remember(event.cursor);
    const [closed = null] = d.close === null ? [] : this.decisionWrites(s, [closingEvent(this.decisionIn(s, view.cursor, at)!, d.close)], at, audit);
    return { outcome: "appended", event: detach(event), closed: closed === null ? null : detach(closed) };
  }

  async closeDecision(
    sessionId: string,
    decision: number,
    close: { state: ClosedState; reason?: FailReason },
    now: number,
    audit: readonly AuditEntry[] = [],
  ): Promise<DecisionClose> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session ${sessionId}`);
    if (s.frozenAt !== null && close.state !== "expired") return { outcome: "frozen" };
    const view = this.decisionIn(s, decision, now);
    if (view === undefined) return { outcome: "unknown" };
    const d = decideClose(view, close.state, now);
    if (d.kind === "closed") return { outcome: "closed", state: d.state };
    if (d.kind === "not_due") return { outcome: "not_due" };
    return { outcome: "appended", event: detach(this.decisionWrites(s, [closingEvent(view, close)], Date.now(), audit)[0]) };
  }

  async decision(sessionId: string, cursor: number, now: number): Promise<DecisionView | null> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session ${sessionId}`);
    const view = this.decisionIn(s, cursor, now);
    return view === undefined ? null : withoutBook(detach(view));
  }

  async votedOn(sessionId: string, userId: string, decisions: number[]): Promise<number[]> {
    const rooms = this.ballots.get(sessionId);
    return decisions.filter((d) => rooms?.get(d)?.has(userId) === true);
  }

  async decisions(sessionId: string, ask: DecisionPageAsk, now: number): Promise<DecisionPage> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session ${sessionId}`);
    const views = decisionsOf(s.events.filter((e) => ask.upTo === undefined || e.cursor <= ask.upTo), now, this.book(s));
    const { page, next } = decisionPageOf([...views.keys()].reverse(), ask);
    const open = ask.upTo === undefined ? [...views.values()].filter((v) => v.state === "open").reverse() : [];
    const read = detach({ open, decisions: page.map((c) => views.get(c)!), next });
    return { ...read, open: read.open.map(withoutBook), decisions: read.decisions.map(withoutBook) };
  }

  async admitSend(sessionId: string, key: string, limit: number, now: number): Promise<SendAdmission> {
    const room = this.sends.get(sessionId) ?? new Map<string, number[]>();
    const counted = admitAt(room.get(key) ?? [], limit, now);
    room.set(key, counted.times);
    this.sends.set(sessionId, room);
    return counted.retryAfterMs === null ? { ok: true } : { ok: false, retryAfterMs: counted.retryAfterMs };
  }

  /**
   * The append itself, with no awaits in it, so both public appenders can call
   * it without yielding between their guard and their write. Same rule, and
   * the same reason, as liveGrant and waitForEvents.
   */
  private appendNow(s: Session, e: Omit<SessionEvent, "cursor" | "at">, at = Date.now()): SessionEvent {
    const event: SessionEvent = {
      ...detach(e), cursor: s.events.length + 1, at,
    };
    s.events.push(event);
    // Housekeeping's books (#66), in the same synchronous stretch as the push so the event
    // and what it owes land together. Here, where every event joins a room's log, because
    // a departure is written by `removeMember` and not by a send. The roster is replaced,
    // not edited, so a caller holding a member object across this call holds a stale one.
    const books = noteAppend(s, event);
    if (books !== s) Object.assign(s, books);
    this.wake(s);
    return event;
  }

  async eventsAfter(sessionId: string, cursor: number, limit?: number): Promise<SessionEvent[]> {
    const s = this.sessions.get(sessionId);
    if (!s) return [];
    return detach(s.events.filter((e) => e.cursor > cursor).slice(0, limit));
  }

  async eventAt(sessionId: string, cursor: number): Promise<SessionEvent | undefined> {
    const e = this.sessions.get(sessionId)?.events.find((ev) => ev.cursor === cursor);
    return e ? detach(e) : undefined;
  }

  async recentEvents(sessionId: string, limit: number): Promise<SessionEvent[]> {
    const s = this.sessions.get(sessionId);
    if (!s || limit <= 0) return [];
    return detach(s.events.slice(-limit));
  }

  async surfaceOf(sessionId: string): Promise<SurfaceRow[]> {
    const rows = this.surfaces.get(sessionId);
    if (!rows) return [];
    const sorted = [...rows.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return detach(sorted);
  }

  async surfaceFacts(sessionId: string, keys: readonly string[]): Promise<SurfaceFacts> {
    return detach(surfaceFactsOf(this.surfaces.get(sessionId)?.values() ?? [], keys));
  }

  async surfaceNamesBlob(sessionId: string, blobId: string): Promise<boolean> {
    for (const r of this.surfaces.get(sessionId)?.values() ?? []) if (r.blob?.id === blobId) return true;
    return false;
  }

  async surfaceWindow(
    sessionId: string,
    asked: { window?: Window; next?: string },
    opts: { cut?: number },
  ): Promise<{ ok: true; page: WindowPage; cursor: number } | { ok: false; reason: string }> {
    const s = this.sessions.get(sessionId) as { surfaceCursor?: number } | undefined;
    const rows = [...(this.surfaces.get(sessionId)?.values() ?? [])];
    return detach(windowUnderCut(rows, s?.surfaceCursor ?? 0, asked, opts.cut));
  }

  async outsideTask(sessionId: string, callerUserId: string, taskId: string): Promise<OutsideTask | undefined> {
    const task = this.outsideTasks.get(sessionId)?.get(taskId);
    return task?.callerUserId === callerUserId ? detach(task) : undefined;
  }

  async outsideTaskById(sessionId: string, taskId: string): Promise<OutsideTask | undefined> {
    return detach(this.outsideTasks.get(sessionId)?.get(taskId));
  }

  async banAccount(sessionId: string, req: AccountBanRequest): Promise<{ refused: RemovalOutcome["refused"] }> {
    // No await from the reads to the writes, as removeMember has none.
    const s = this.sessions.get(sessionId);
    if (!s) return { refused: "not_found" };
    if (s.closed) return { refused: "closed" };
    if (s.frozenAt !== null) return { refused: "frozen" };
    if (s.createdBy !== req.byUserId) return { refused: "forbidden" };
    const banning = !this.isBanned(s.id, req.userId) ? { banId: newBanId(), userId: req.userId, label: req.label, at: req.now } : null;
    const widening = req.ban === "all" && !this.bansCreatorWide(s.createdBy, req.userId)
      ? { banId: newBanId(), userId: req.userId, label: req.label, at: req.now, sessionId: s.id }
      : null;
    if (banning) this.roomBanned.set(s.id, [...(this.roomBanned.get(s.id) ?? []), banning]);
    if (widening) this.creatorBanned.set(s.createdBy, [...(this.creatorBanned.get(s.createdBy) ?? []), widening]);
    if (banning) this.recordAudit(req.audit.filter((e) => e.orgId));
    return { refused: null };
  }

  async outsideTasksOf(sessionId: string, callerUserId: string): Promise<OutsideTask[]> {
    const mine = [...(this.outsideTasks.get(sessionId)?.values() ?? [])].filter((t) => t.callerUserId === callerUserId);
    return detach(mine.sort(newestTaskFirst));
  }

  async askOutside(sessionId: string, req: AskRequest): Promise<AskOutcome> {
    // No await from the reads to the writes, the rule and the reason chargeBlobBytes and seatMember give.
    const s = this.sessions.get(sessionId);
    if (!s || s.frozenAt !== null) return { ok: false, error: "not_found" };
    const mine = [...(this.outsideTasks.get(sessionId)?.values() ?? [])].filter((t) => t.callerUserId === req.callerUserId);
    const known = this.outsideCallerRows.get(sessionId)?.get(req.callerUserId);
    const issued = this.outsideVisitors.get(sessionId) ?? 0;
    const d = decideAsk(s, req, { mine, known, issued, seatDay: this.seatDays.get(sessionId) });
    if (!d.ok) return d;
    const event = this.appendNow(s, d.event);
    this.applyExtras(s, event, { outsideTask: d.task, ...(d.standing === null ? {} : { outsideCaller: d.standing }) });
    this.outsideVisitors.set(sessionId, d.issued);
    if (d.seatDay !== null) this.seatDays.set(sessionId, d.seatDay);
    this.wakeHost(s, event);
    // The seat's own wake for the question (REPLIES_PER_QUESTION does not count it), as SessionDO queues it.
    if (d.seatDay !== null) this.hostWoken({ sessionId, cause: "outside", cursor: event.cursor });
    return { ok: true, task: detach(taskWithEvent(d.task, event)) };
  }

  async answerOutside(sessionId: string, req: AnswerRequest): Promise<AnswerResult> {
    // No await from the reads to the writes, as in askOutside.
    const s = this.sessions.get(sessionId);
    if (!s || s.frozenAt !== null || s.closed) return { ok: false, error: "task_closed" };
    const d = decideAnswer(s, this.outsideTasks.get(sessionId)?.get(req.taskId), req);
    if (!d.ok) return d;
    // The seat pays for its answer in the same turn. A meter that refuses leaves the seat no voice to answer with.
    const charge = req.units === undefined ? null : decideHostCharge(s, req.units, req.now);
    if (charge !== null && !charge.ok) return { ok: false, error: "not_the_voice" };
    const event = this.appendNow(s, d.event);
    this.applyExtras(s, event, { outsideTask: d.task });
    if (charge !== null) {
      s.hostUnits = charge.next;
      s.members = s.members.map((m) => m.memberId === d.event.fromMemberId ? { ...m, lastSeenAt: req.now } : m);
      this.recordAudit(hostSentEntries(s, d.event, req.now));
    }
    this.wakeHost(s, event);
    return { ok: true, task: detach(taskWithEvent(d.task, event)) };
  }

  async cancelOutside(sessionId: string, req: CancelRequest): Promise<CancelResult> {
    // No await from the read to the write, as in askOutside.
    const s = this.sessions.get(sessionId);
    if (!s || s.frozenAt !== null) return { ok: false, error: "task_not_found" };
    const d = decideCancel(this.outsideTasks.get(sessionId)?.get(req.taskId), req);
    if (!d.ok) return d;
    const event = this.appendNow(s, d.event, req.now);
    this.applyExtras(s, event, { outsideTask: d.task });
    return { ok: true, task: detach(taskWithEvent(d.task, event)) };
  }

  /**
   * End every open outside task of a room for `reason`, each with its notice, in the caller's turn. Walked from a
   * copy because `applyExtras` writes the map. Ending a task twice cannot happen: an ended task is no longer open.
   */
  private endOutside(s: Session, reason: EndReason, now: number): void {
    const tasks = this.outsideTasks.get(s.id);
    if (tasks === undefined) return;
    for (const { task, event } of endings([...tasks.values()], reason, now)) {
      this.applyExtras(s, this.appendNow(s, event, now), { outsideTask: task });
    }
  }

  async seatSkipped(sessionId: string, taskId: string, _reason: string): Promise<void> {
    const task = this.outsideTasks.get(sessionId)?.get(taskId);
    if (task) this.handOver(sessionId, task, Date.now());
  }

  /** `handOff`, and the notice that tells the members (`handedOverNotice`) when the room takes events (SessionDO: the same). */
  private handOver(sessionId: string, task: OutsideTask, now: number): void {
    if (!handOff(task, now)) return;
    const s = this.sessions.get(sessionId);
    if (s && !s.closed && s.frozenAt === null) this.appendNow(s, handedOverNotice(task), now);
  }

  async chargeBlobBytes(sessionId: string, bytes: number): Promise<BlobCharge> {
    // No await from the read to the write — the rule, and the reason, seatMember
    // gives. `closeIfAbandoned` first, as getSession does: an abandoned room is
    // closed whether or not anything has written that down yet.
    const s = this.sessions.get(sessionId);
    if (!s) return { ok: false, reason: "not_found", used: 0 };
    this.closeIfAbandoned(s, Date.now());
    const charge = decideBlobCharge(s, s.closed, bytes);
    if (charge.ok) (s as { blobBytes?: number }).blobBytes = charge.used;
    return charge;
  }

  /**
   * Deliberately NOT declared `async`. The read and the waiter registration
   * must happen in the same synchronous turn: an `await` between them yields,
   * and an event appended in that gap calls wake() against an empty waiter
   * list, so this poll hangs until its own timeout — a lost wakeup. Callers
   * still get a Promise, so the interface is unchanged.
   *
   * A Durable Objects port gets this atomicity from the DO's single-threaded
   * execution, but the same rule applies: read and register without yielding.
   */
  waitForEvents(
    sessionId: string,
    cursor: number,
    waitMs: number,
    limit?: number
  ): Promise<SessionEvent[]> {
    const s = this.sessions.get(sessionId);
    const immediate = s ? detach(s.events.filter((e) => e.cursor > cursor).slice(0, limit)) : [];
    if (immediate.length > 0 || waitMs <= 0) return Promise.resolve(immediate);
    return new Promise((resolve) => {
      const w: Waiter = { after: cursor, resolve };
      const list = this.waiters.get(sessionId) ?? [];
      list.push(w);
      this.waiters.set(sessionId, list);
      setTimeout(() => {
        const cur = this.waiters.get(sessionId) ?? [];
        const idx = cur.indexOf(w);
        if (idx >= 0) {
          cur.splice(idx, 1);
          resolve([]);
        }
      }, waitMs).unref?.();
    });
  }

  async putPendingConnect(p: PendingConnect): Promise<void> {
    this.pending.set(p.token, detach(p));
  }

  async takePendingConnect(token: string): Promise<PendingConnect | undefined> {
    const p = this.pending.get(token);
    if (!p) return undefined;
    this.pending.delete(token); // single use
    if (Date.now() > p.expiresAt) return undefined;
    return p;
  }

  async countCreatesThisMonth(userId: string): Promise<number> {
    return this.countMonth(this.creates, userId);
  }

  async recordCreate(userId: string): Promise<void> {
    this.recordMonth(this.creates, userId);
  }

  async recordSignIn(userId: string, now: number, githubLogin?: string, googleEmail?: string, ref?: string): Promise<void> {
    const seen = this.users.get(userId);
    const login = githubLogin ?? seen?.githubLogin;
    const email = googleEmail ?? seen?.googleEmail;
    const tag = seen ? seen.ref : ref;
    this.users.set(userId, {
      userId, firstSeenAt: seen?.firstSeenAt ?? now, lastSeenAt: now,
      ...(login === undefined ? {} : { githubLogin: login }),
      ...(email === undefined ? {} : { googleEmail: email }),
      ...(tag === undefined ? {} : { ref: tag }),
    });
  }

  async countUsers(): Promise<number> {
    return this.users.size;
  }

  async listUsers(limit: number): Promise<UserRecord[]> {
    return firstSignInFirst([...this.users.values()]).slice(0, limit);
  }

  async reserveHostedRoom(userId: string, sessionId: string, limit: number): Promise<HostedSlot> {
    // No await: the count and the record are one step, for seatMember's reason.
    const held = this.hostedOpen.get(userId) ?? new Set<string>();
    if (held.has(sessionId)) return { ok: true };
    if (held.size >= limit) return { ok: false, open: held.size };
    held.add(sessionId);
    this.hostedOpen.set(userId, held);
    return { ok: true };
  }

  async releaseHostedRoom(userId: string, sessionId: string): Promise<void> {
    this.hostedOpen.get(userId)?.delete(sessionId);
  }

  /** The monthly create count's rule, as `RegistryDO`'s `#countMonth` is, so the two cannot drift. */
  private countMonth(counts: Map<string, number[]>, userId: string): number {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    return (counts.get(userId) ?? []).filter((t) => t >= monthStart).length;
  }

  private recordMonth(counts: Map<string, number[]>, userId: string): void {
    const list = counts.get(userId) ?? [];
    list.push(Date.now());
    counts.set(userId, list);
  }

  async listPresets(userId: string): Promise<SavedPreset[]> {
    const mine = this.presets.get(userId);
    if (!mine) return [];
    // Code-unit order, which is the registry's key order.
    return detach([...mine.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))).map(presetInNewWords);
  }

  async getPreset(userId: string, name: string): Promise<SavedPreset | undefined> {
    const p = this.presets.get(userId)?.get(name);
    return p && presetInNewWords(detach(p));
  }

  async putPreset(userId: string, preset: SavedPreset, cap: number): Promise<"saved" | "full"> {
    const mine = this.presets.get(userId) ?? new Map<string, SavedPreset>();
    if (!mine.has(preset.name) && mine.size >= cap) return "full";
    mine.set(preset.name, detach(preset));
    this.presets.set(userId, mine);
    return "saved";
  }

  async deletePreset(userId: string, name: string): Promise<boolean> {
    return this.presets.get(userId)?.delete(name) ?? false;
  }

  async handleOf(userId: string): Promise<string | undefined> {
    return this.handleByUser.get(userId);
  }

  async userOfHandle(handle: string): Promise<string | undefined> {
    return this.handles.get(handle);
  }

  async handleHolders(): Promise<{ userId: string; handle: string }[]> {
    return [...this.handleByUser]
      .map(([userId, handle]) => ({ userId, handle }))
      .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  }

  async claimHandle(userId: string, handle: string): Promise<"claimed" | "taken"> {
    const holder = this.handles.get(handle);
    if (holder !== undefined) return holder === userId ? "claimed" : "taken";
    const old = this.handleByUser.get(userId);
    if (old !== undefined) this.handles.delete(old);
    this.handles.set(handle, userId);
    this.handleByUser.set(userId, handle);
    return "claimed";
  }

  async releaseHandle(userId: string): Promise<void> {
    const handle = this.handleByUser.get(userId);
    if (handle !== undefined) this.handles.delete(handle);
    this.handleByUser.delete(userId);
    this.signatures.delete(userId);
  }

  async releaseHandleNamed(handle: string): Promise<string | undefined> {
    const userId = this.handles.get(handle);
    // releaseHandle awaits nothing, so it runs to its end before this yields: nothing lands between the read and it.
    if (userId !== undefined) await this.releaseHandle(userId);
    return userId;
  }

  async signRoom(userId: string, sessionId: string, at: number): Promise<string | undefined> {
    const handle = this.handleByUser.get(userId);
    if (handle === undefined) return undefined;
    const mine = this.signatures.get(userId) ?? new Map<string, number>();
    mine.set(sessionId, at);
    this.signatures.set(userId, mine);
    return handle;
  }

  async unsignRoom(userId: string, sessionId: string): Promise<void> {
    this.signatures.get(userId)?.delete(sessionId);
  }

  async signedRooms(userId: string): Promise<{ sessionId: string; signedAt: number }[]> {
    return [...(this.signatures.get(userId) ?? [])]
      .map(([sessionId, signedAt]) => ({ sessionId, signedAt }))
      .sort((a, b) => b.signedAt - a.signedAt || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  }

  async bylineFor(userId: string, sessionId: string): Promise<string | undefined> {
    const handle = this.handleByUser.get(userId);
    return handle !== undefined && this.signatures.get(userId)?.has(sessionId) ? handle : undefined;
  }

  async getGrant(key: string): Promise<PlanGrant | undefined> {
    const grant = this.liveGrant(key);
    return grant && detach(grant);
  }

  /**
   * Deliberately synchronous, and the reason every guarded write below calls
   * it instead of `await this.getGrant(...)`.
   *
   * Those methods promise that the check and the mutation are one operation.
   * An `await` between them yields, and a second guarded writer can read the
   * same record, act on it, and have its write undone or its grant deleted by
   * the first one finishing against a value that is no longer there. The
   * Durable Object gets this from `storage.transaction`; here it comes from
   * not yielding, which only works if the read never awaits.
   *
   * Same rule, and the same reason, as `waitForEvents` above.
   */
  private liveGrant(key: string): PlanGrant | undefined {
    const grant = this.grants.get(key);
    if (!grant) return undefined;
    // A lapsed grant is not a grant. Deleting here keeps reads self-healing.
    if (grant.expiresAt !== null && Date.now() > grant.expiresAt) {
      this.grants.delete(key);
      return undefined;
    }
    return grant;
  }

  async putGrant(grant: PlanGrant): Promise<void> {
    this.grants.set(grant.key, detach(grant));
  }

  async deleteGrant(key: string): Promise<void> {
    this.grants.delete(key);
  }

  /**
   * No outbox here. There is one process and one array, so the audit write
   * cannot fail independently of the grant write and there is no gap to
   * protect. The Durable Object store needs one because its audit lives in a
   * different object; both owe the same observable result, which is what the
   * contract suite checks.
   */
  private recordAudit(entries: AuditEntry[]): void {
    for (const entry of entries) {
      // No org, no stream: DurableObjectStore drops it too (ARCHITECTURE.md section 9, runtime fact 4).
      if (!entry.orgId) continue;
      const seq = (this.auditSeq.get(entry.orgId) ?? 0) + 1;
      this.auditSeq.set(entry.orgId, seq);
      const state = this.auditStateOf(entry.orgId);
      const prevHash = this.audit.filter((r) => r.entry.orgId === entry.orgId).at(-1)?.hash ?? state.anchor.hash;
      this.audit.push({ seq, entry: detach(entry), prevHash, hash: chainHash(seq, prevHash, entry) });
      // A live sink with no delivery dated gets one: as AuditDO's append arms its alarm (D3).
      if (state.sink && !state.sink.dead && state.sinkAt === null) state.sinkAt = Date.now() + SINK_DELAY_MS;
    }
  }

  async putGrantIfOwned(
    grant: PlanGrant,
    expectedOrgId: string | null,
    audit: AuditIntent
  ): Promise<"written" | "conflict" | "full"> {
    // liveGrant, not the raw map: a lapsed grant is defined as absent
    // everywhere else, and reading past that here would let a dead record from
    // another org hold a key hostage until some unrelated read swept it.
    const existing = this.liveGrant(grant.key);
    const orgOf = (orgId: string | null) => (orgId === null ? undefined : this.orgs.get(orgId));
    // An unowned seat elsewhere holds nothing (ADR 0027): the org that owns the address by its form takes the key.
    const taken = existing !== undefined && existing.orgId !== expectedOrgId
      && takesUnownedSeat(existing, orgOf(existing.orgId), grant, orgOf(grant.orgId));
    if (existing && existing.orgId !== expectedOrgId && !taken) return "conflict";
    // The org whose IdP pushed the seat it took keeps no hold on the key: a claim does not carry its user along.
    if (taken && this.scimByKey.get(scimKeyIndex(grant.key))?.orgId === existing.orgId) this.scimByKey.delete(scimKeyIndex(grant.key));
    // The seat cap (D3), decided in the same synchronous span as the write: a key that is
    // already a member of this org changes role for no seat; an org with no record has no cap.
    if (grant.orgId !== null && !(existing && existing.orgId === grant.orgId)) {
      const org = this.orgs.get(grant.orgId);
      if (org && this.liveMembers(grant.orgId) >= org.seats) return "full";
    }
    this.grants.set(grant.key, detach(grant));
    this.recordAudit(taken ? takenSeatAuditEntries(existing, grant, audit, Date.now()) : grantAuditEntries(existing, grant, audit, Date.now()));
    return "written";
  }

  async deleteGrantIfOwned(
    key: string,
    expectedOrgId: string | null,
    audit: AuditIntent
  ): Promise<"deleted" | "missing" | "conflict"> {
    const existing = this.liveGrant(key);
    if (!existing) return "missing";
    if (existing.orgId !== expectedOrgId) return "conflict";
    this.grants.delete(key);
    this.recordAudit(revokeAuditEntries(existing, audit, Date.now()));
    return "deleted";
  }

  async putGrantIfSource(
    grant: PlanGrant, expectedSource: string, audit: AuditIntent
  ): Promise<GrantWrite> {
    const previous = this.liveGrant(grant.key);
    if (previous && previous.source !== expectedSource) return { outcome: "conflict" };
    this.grants.set(grant.key, detach(grant));
    this.recordAudit(grantAuditEntries(previous, grant, audit, Date.now()));
    // Detached after the write, because the caller is handed this and the
    // stored object must not be reachable through it.
    return { outcome: "written", previous: previous && detach(previous) };
  }

  async deleteGrantIfSource(
    key: string, expectedSource: string, audit: AuditIntent
  ): Promise<GrantDelete> {
    const removed = this.liveGrant(key);
    if (!removed) return { outcome: "missing" };
    if (removed.source !== expectedSource) return { outcome: "conflict" };
    this.grants.delete(key);
    this.recordAudit(revokeAuditEntries(removed, audit, Date.now()));
    return { outcome: "deleted", removed: detach(removed) };
  }

  async moveGrant(fromKey: string, toKey: string): Promise<void> {
    // Synchronous for the same reason as the guarded writes: a move that
    // yielded between reading and re-filing could re-file a record another
    // writer had already replaced.
    const grant = this.liveGrant(fromKey);
    if (!grant) return;
    this.grants.delete(fromKey);
    this.grants.set(toKey, { ...grant, key: toKey });
    this.repointScim(grant, toKey);
  }

  /**
   * The SCIM rows follow a moved key (SCIM spec, D3): the user the key is managed by, its key index, and the
   * directory entry for its address; and a directory entry an SSO sign-in alone wrote follows an address key.
   */
  private repointScim(moved: PlanGrant, toKey: string): void {
    const managed = this.scimByKey.get(scimKeyIndex(moved.key));
    if (managed) {
      const user = this.scimUsers.get(scimUserKey(managed.orgId, managed.scimId));
      if (user) {
        this.scimUsers.set(scimUserKey(managed.orgId, managed.scimId), { ...user, key: toKey });
        this.directory.set(scimNameKey(managed.orgId, user.userName), { key: toKey, scimId: managed.scimId });
      }
      this.scimByKey.delete(scimKeyIndex(moved.key));
      this.scimByKey.set(scimKeyIndex(toKey), managed);
      return;
    }
    if (moved.orgId && moved.key.startsWith("email:")) {
      const name = scimNameKey(moved.orgId, moved.key.slice("email:".length));
      const entry = this.directory.get(name);
      if (entry && entry.key === moved.key) this.directory.set(name, { ...entry, key: toKey });
    }
  }

  async listGrants(limit: number, orgId?: string | null): Promise<PlanGrant[]> {
    // Same rule as getGrant: an expired grant is not a grant. Returning them
    // would let stale records fill the caller's window and hide live ones.
    const now = Date.now();
    const live: PlanGrant[] = [];
    for (const [key, grant] of this.grants) {
      if (grant.expiresAt !== null && now > grant.expiresAt) {
        this.grants.delete(key);
        continue;
      }
      if (orgId === undefined || grant.orgId === orgId) live.push(grant);
    }
    return detach(live.slice(0, limit));
  }

  /** Synchronous, for the reason `liveGrant` is: `putGrantIfOwned` decides a seat on it without yielding. */
  private liveMembers(orgId: string): number {
    let count = 0;
    for (const key of [...this.grants.keys()]) {
      const grant = this.liveGrant(key);
      if (grant && grant.orgId === orgId) count++;
    }
    return count;
  }

  async getOrg(orgId: string): Promise<Org | undefined> {
    const org = this.orgs.get(orgId);
    return org && liftOrg(detach(org));
  }

  async createOrg(org: Org, ownerGrant: PlanGrant, audit: AuditIntent): Promise<"created" | "exists" | "conflict"> {
    if (this.orgs.has(org.orgId)) return "exists";
    const existing = this.liveGrant(ownerGrant.key);
    if (existing && existing.orgId !== org.orgId) return "conflict";
    this.orgs.set(org.orgId, detach(org));
    this.grants.set(ownerGrant.key, detach(ownerGrant));
    const now = Date.now();
    this.recordAudit([...orgAuditEntries(undefined, org, audit, now), ...grantAuditEntries(existing, ownerGrant, audit, now)]);
    return "created";
  }

  async updateOrg(orgId: string, patch: OrgPatch, audit: AuditIntent): Promise<Org | undefined> {
    const previous = this.orgs.get(orgId);
    if (!previous) return undefined;
    const next = patchedOrg(previous, patch);
    this.orgs.set(orgId, detach(next));
    this.recordAudit(orgAuditEntries(previous, next, audit, Date.now()));
    return detach(next);
  }

  async countOrgMembers(orgId: string): Promise<number> {
    return this.liveMembers(orgId);
  }

  async activatePurchasedOrg(orgId: string, ownerUserId: string, seats: number, audit: AuditIntent): Promise<"created" | "updated" | "unchanged" | "not_purchased"> {
    const previous = this.orgs.get(orgId);
    const now = Date.now();
    if (!previous) {
      const org = purchasedOrg(orgId, ownerUserId, seats, now);
      this.orgs.set(orgId, detach(org));
      this.recordAudit(orgAuditEntries(undefined, org, audit, now));
      return "created";
    }
    if (previous.source !== "purchase") return "not_purchased";
    if (previous.seats === seats && previous.active) return "unchanged";
    const next: Org = { ...previous, seats, active: true };
    this.orgs.set(orgId, detach(next));
    this.recordAudit(orgAuditEntries(previous, next, audit, now));
    return "updated";
  }

  async deactivateOrg(orgId: string, audit: AuditIntent): Promise<"updated" | "unchanged" | "missing" | "not_purchased"> {
    const previous = this.orgs.get(orgId);
    if (!previous) return "missing";
    if (previous.source !== "purchase") return "not_purchased";
    if (!previous.active) return "unchanged";
    const next: Org = { ...previous, active: false };
    this.orgs.set(orgId, detach(next));
    this.recordAudit(orgAuditEntries(previous, next, audit, Date.now()));
    return "updated";
  }

  async putOrgIdp(orgId: string, idp: OrgIdp, audit: AuditIntent): Promise<"written" | "missing"> {
    if (!this.orgs.has(orgId)) return "missing";
    this.idps.set(orgId, detach(idp));
    this.recordAudit([orgEventEntry(orgId, "idp_configured", { issuer: idp.issuer }, audit, Date.now())]);
    return "written";
  }

  async getOrgIdp(orgId: string): Promise<OrgIdp | undefined> {
    const idp = this.idps.get(orgId);
    return idp && detach(idp);
  }

  async deleteOrgIdp(orgId: string, audit: AuditIntent): Promise<"deleted" | "missing"> {
    if (!this.idps.delete(orgId)) return "missing";
    this.recordAudit([orgEventEntry(orgId, "idp_removed", {}, audit, Date.now())]);
    return "deleted";
  }

  async claimDomain(orgId: string, domain: string, token: string, now: number, audit: AuditIntent): Promise<"claimed" | "exists" | "missing"> {
    const org = this.orgs.get(orgId);
    if (!org) return "missing";
    if (org.domains.some((d) => d.domain === domain)) return "exists";
    this.orgs.set(orgId, { ...org, domains: [...org.domains, { domain, token, verifiedAt: null }] });
    this.recordAudit([orgEventEntry(orgId, "domain_claimed", { domain }, audit, now)]);
    return "claimed";
  }

  /** Synchronous throughout, as the guarded grant writes are: the index read and the claim's write must not be split. */
  async verifyDomain(orgId: string, domain: string, now: number, audit: AuditIntent): Promise<"verified" | "taken" | "unknown"> {
    const org = this.orgs.get(orgId);
    const claim = org?.domains.find((d) => d.domain === domain);
    if (!org || !claim) return "unknown";
    const holder = this.domainIndex.get(domain);
    if (holder !== undefined && holder !== orgId) return "taken";
    this.domainIndex.set(domain, orgId);
    if (claim.verifiedAt !== null) return "verified";
    this.orgs.set(orgId, { ...org, domains: org.domains.map((d) => (d.domain === domain ? { ...d, verifiedAt: now } : d)) });
    this.recordAudit([orgEventEntry(orgId, "domain_verified", { domain }, audit, now)]);
    return "verified";
  }

  async releaseDomain(orgId: string, domain: string, audit: AuditIntent): Promise<"released" | "unknown"> {
    const org = this.orgs.get(orgId);
    if (!org || !org.domains.some((d) => d.domain === domain)) return "unknown";
    this.orgs.set(orgId, { ...org, domains: org.domains.filter((d) => d.domain !== domain) });
    if (this.domainIndex.get(domain) === orgId) this.domainIndex.delete(domain);
    this.recordAudit([orgEventEntry(orgId, "domain_released", { domain }, audit, Date.now())]);
    return "released";
  }

  async orgForDomain(domain: string): Promise<string | undefined> {
    return this.domainIndex.get(domain);
  }

  async provisionSsoMember(
    orgId: string, key: string, now: number, audit: AuditIntent, address?: string,
  ): Promise<"written" | "exists" | "full" | "no_org" | "deprovisioned"> {
    const org = this.orgs.get(orgId);
    if (!org) return "no_org";
    if (this.scimInactive(this.scimByKey.get(scimKeyIndex(key)))) return "deprovisioned";
    if (this.liveGrant(key)) return "exists";
    const name = address === undefined ? undefined : scimNameKey(orgId, address);
    const entry = name === undefined ? undefined : this.directory.get(name);
    if (entry?.scimId && this.scimInactive({ orgId, scimId: entry.scimId })) return "deprovisioned";
    // The grant the address is seated under, this org's: at the directory's key, else at the address as given or
    // lowercased (a push seats the lowercased address). It moves onto the subject with its role and source, as
    // `claimGrant` moves an admin's address grant: the seat follows the door the person last came through.
    const candidates = address === undefined ? [entry?.key] : [entry?.key, `email:${address}`, `email:${address.toLowerCase()}`];
    for (const from of candidates) {
      const held = from === undefined || from === key ? undefined : this.liveGrant(from);
      if (!held || held.orgId !== orgId) continue;
      this.grants.delete(from!);
      this.grants.set(key, { ...held, key });
      this.repointScim(held, key);
      this.directory.set(name!, { key, scimId: entry?.scimId ?? null });
      return "written";
    }
    if (this.liveMembers(orgId) >= org.seats) return "full";
    const grant: PlanGrant = { key, plan: "team", role: "member", orgId, source: "sso", grantedAt: now, grantedBy: "sso", expiresAt: null };
    this.grants.set(key, detach(grant));
    if (name !== undefined) {
      this.directory.set(name, { key, scimId: entry?.scimId ?? null });
      // A SCIM user whose grant is gone follows the subject that just signed in.
      const user = entry?.scimId ? this.scimUsers.get(scimUserKey(orgId, entry.scimId)) : undefined;
      if (user) {
        this.scimByKey.delete(scimKeyIndex(user.key));
        this.writeScimRows({ ...user, key });
      }
    }
    this.recordAudit(grantAuditEntries(undefined, grant, audit, now));
    return "written";
  }

  async putOrgInvite(invite: OrgInvite, audit: AuditIntent): Promise<"invited" | "exists" | "limit" | "no_org"> {
    if (!this.orgs.has(invite.orgId)) return "no_org";
    const pending = this.invites.get(invite.orgId) ?? new Map<string, OrgInvite>();
    if (pending.has(invite.key)) return "exists";
    if (pending.size >= MAX_PENDING_INVITES) return "limit";
    pending.set(invite.key, detach(liftInvite(invite)));
    this.invites.set(invite.orgId, pending);
    this.recordAudit([orgEventEntry(invite.orgId, "member_invited", { key: invite.key, role: invite.role }, audit, invite.invitedAt)]);
    return "invited";
  }

  async listOrgInvites(orgId: string, limit: number): Promise<OrgInvite[]> {
    // By key, as the Durable Objects store's listing of `io:<org>:` comes back.
    return detach([...(this.invites.get(orgId)?.values() ?? [])].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).slice(0, limit));
  }

  async invitesFor(keys: string[]): Promise<OrgInvite[]> {
    const orgIds = [...this.invites.keys()].sort();
    return detach([...new Set(keys)].flatMap((key) => orgIds.flatMap((orgId) => this.invites.get(orgId)?.get(key) ?? [])));
  }

  async renewOrgInvite(orgId: string, key: string, invitedBy: string, now: number, audit: AuditIntent): Promise<OrgInvite | "missing"> {
    const pending = this.invites.get(orgId);
    const found = pending?.get(key);
    if (!pending || !found) return "missing";
    const renewed: OrgInvite = { ...found, invitedBy, invitedAt: now, expiresAt: now + INVITE_TTL_MS };
    pending.set(key, renewed);
    this.recordAudit([orgEventEntry(orgId, "invite_resent", { key }, audit, now)]);
    return detach(renewed);
  }

  async spendInviteMail(orgId: string, budget: number, now: number): Promise<boolean> {
    const day = inviteMailDay(now);
    const row = this.inviteMail.get(orgId);
    const spent = row?.day === day ? row.spent : 0;
    if (spent >= budget) return false;
    this.inviteMail.set(orgId, { day, spent: spent + 1 });
    return true;
  }

  async deleteOrgInvite(orgId: string, key: string, audit: AuditIntent): Promise<"deleted" | "missing"> {
    if (!this.invites.get(orgId)?.delete(key)) return "missing";
    this.recordAudit([orgEventEntry(orgId, "invite_withdrawn", { key }, audit, Date.now())]);
    return "deleted";
  }

  /** Synchronous throughout, as the guarded grant writes are: the offer's read and the grant's write must not be split. */
  async acceptOrgInvite(
    orgId: string, keys: string[], subjectKey: string, now: number, audit: AuditIntent, link?: { key: string; at: number },
  ): Promise<"joined" | "member" | "taken" | "full" | "sso" | "gone"> {
    const org = this.orgs.get(orgId);
    if (!org) return "gone";
    const pending = this.invites.get(orgId);
    const linked = link && pending?.get(link.key)?.invitedAt === link.at ? [link.key] : [];
    const unique = [...new Set([subjectKey, ...keys, ...linked])];
    const invite = unique.map((key) => pending?.get(key)).find((i) => i !== undefined && inviteLive(i, now));
    const grants = unique.map((key) => this.liveGrant(key)).filter((g): g is PlanGrant => g !== undefined);
    // An unowned seat, in this org or any other, holds nothing: this org's are the offer and move, and another's is no grant.
    const unowned = grants.filter((g) => isUnownedSeat(g, g.orgId === null ? undefined : this.orgs.get(g.orgId)));
    const seats = unowned.filter((g) => g.orgId === orgId);
    const offer = invite ? { role: invite.role, by: invite.invitedBy } : seats[0] ? { role: seats[0].role, by: seats[0].grantedBy } : undefined;
    if (!offer) return "gone";
    if (org.requireSso) return "sso";
    const others = grants.filter((g) => !unowned.includes(g));
    const dropInvites = () => { for (const key of unique) pending?.delete(key); };
    if (others.some((g) => g.orgId === orgId)) {
      dropInvites();
      return "member";
    }
    if (others.length > 0) return "taken";
    if (seats.length === 0 && this.liveMembers(orgId) >= org.seats) return "full";
    const grant: PlanGrant = { key: subjectKey, plan: "team", role: offer.role, orgId, source: "invite", grantedAt: now, grantedBy: offer.by, expiresAt: null };
    // A seat the IdP pushed stays the IdP's to end (ADR 0029): its rows follow it onto the subject, as a claim's do.
    for (const seat of seats) {
      this.grants.delete(seat.key);
      this.repointScim(seat, subjectKey);
    }
    dropInvites();
    this.grants.set(subjectKey, detach(grant));
    this.recordAudit(grantAuditEntries(undefined, grant, audit, now));
    return "joined";
  }

  async declineOrg(subjectKey: string, orgId: string, now: number): Promise<void> {
    const declined = this.declines.get(subjectKey) ?? new Map<string, number>();
    declined.set(orgId, Math.max(now, declined.get(orgId) ?? now));
    this.declines.set(subjectKey, declined);
  }

  async declinedOrgs(subjectKey: string): Promise<{ orgId: string; at: number }[]> {
    return [...(this.declines.get(subjectKey) ?? [])].map(([orgId, at]) => ({ orgId, at })).sort((a, b) => (a.orgId < b.orgId ? -1 : 1));
  }

  /** Whether a key index row names a SCIM user the IdP deactivated (SCIM spec, D4). */
  private scimInactive(managed: { orgId: string; scimId: string } | undefined): boolean {
    const user = managed && this.scimUsers.get(scimUserKey(managed.orgId, managed.scimId));
    return user !== undefined && !user.active;
  }

  // ------------------------------------------------- SCIM users (SCIM spec, D2 to D8)
  // Synchronous throughout, as the guarded grant writes are: every check runs before any write, so a refusal
  // leaves nothing half done, which is what the registry's transaction gives the Durable Objects store.

  private writeScimRows(user: ScimUser): void {
    this.scimUsers.set(scimUserKey(user.orgId, user.id), detach(user));
    this.directory.set(scimNameKey(user.orgId, user.userName), { key: user.key, scimId: user.id });
    this.scimByKey.set(scimKeyIndex(user.key), { orgId: user.orgId, scimId: user.id });
  }

  async createScimUser(user: ScimUser, audit: AuditIntent): Promise<ScimCreate> {
    const org = this.orgs.get(user.orgId);
    if (!org) return { outcome: "no_org" };
    const entry = this.directory.get(scimNameKey(user.orgId, user.userName));
    // A tombstone (a user the IdP deleted) is no user: the push starts them over under the key it kept.
    const prior = entry?.scimId ? this.scimUsers.get(scimUserKey(user.orgId, entry.scimId)) : undefined;
    if (prior && prior.deletedAt === null) return { outcome: "exists" };
    const kept = entry?.key ?? user.key;
    let key = kept;
    let held = this.liveGrant(key);
    if (held && held.orgId !== user.orgId) return { outcome: "conflict" };
    // A seat this push creates or restores never lands on a personal account the org does not own by its form (ADR 0027).
    if (!held) {
      key = scimSeatKey(org, user.userName, kept);
      held = key === kept ? undefined : this.liveGrant(key);
      if (held && held.orgId !== user.orgId) return { outcome: "conflict" };
    }
    const linked = held !== undefined;
    const entries: AuditEntry[] = [];
    if (key !== kept && this.scimByKey.get(scimKeyIndex(kept))?.scimId === entry?.scimId) this.scimByKey.delete(scimKeyIndex(kept));
    if (!linked && user.active) {
      if (this.liveMembers(user.orgId) >= org.seats) return { outcome: "full" };
      const grant = scimGrant(key, user.orgId, user.createdAt);
      this.grants.set(key, grant);
      entries.push(...grantAuditEntries(undefined, grant, audit, user.createdAt));
    } else if (held && !user.active) {
      // Pushed as inactive onto a seat a sign-in or an admin gave: the push is the deactivation (review finding 5).
      this.grants.delete(key);
      entries.push(...revokeAuditEntries(held, audit, user.createdAt));
    }
    if (prior) this.scimUsers.delete(scimUserKey(user.orgId, prior.id));
    const stored: ScimUser = { ...user, key, deletedAt: null };
    this.writeScimRows(stored);
    entries.push(scimUserEntry(user.orgId, user.id, "scim_user_created", {
      user_name: user.userName, external_id: user.externalId, key, linked,
    }, audit, user.createdAt));
    this.recordAudit(entries);
    return { outcome: linked ? "linked" : "written", user: detach(stored) };
  }

  /** A tombstone is hidden from every read but `scimUserByKey`, which the sign-in refusal reads. */
  async getScimUser(orgId: string, id: string): Promise<ScimUser | undefined> {
    const user = this.scimUsers.get(scimUserKey(orgId, id));
    return user && user.deletedAt === null ? detach(user) : undefined;
  }

  async scimUserByName(orgId: string, userName: string): Promise<ScimUser | undefined> {
    const entry = this.directory.get(scimNameKey(orgId, userName));
    return entry?.scimId ? this.getScimUser(orgId, entry.scimId) : undefined;
  }

  async scimUserByKey(key: string): Promise<ScimUser | undefined> {
    const managed = this.scimByKey.get(scimKeyIndex(key));
    const user = managed && this.scimUsers.get(scimUserKey(managed.orgId, managed.scimId));
    return user && detach(user);
  }

  async listScimUsers(orgId: string, limit: number): Promise<ScimUser[]> {
    const mine = [...this.scimUsers.values()]
      .filter((u) => u.orgId === orgId && u.deletedAt === null)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return detach(mine.slice(0, limit));
  }

  async updateScimUser(orgId: string, id: string, patch: ScimUserPatch, now: number, audit: AuditIntent): Promise<ScimUpdate> {
    const was = this.scimUsers.get(scimUserKey(orgId, id));
    if (!was || was.deletedAt !== null) return { outcome: "missing" };
    const rename = patch.userName !== undefined && patch.userName !== was.userName ? patch.userName : undefined;
    const externalId = patch.externalId !== undefined && patch.externalId !== was.externalId ? patch.externalId : undefined;
    const active = patch.active !== undefined && patch.active !== was.active ? patch.active : undefined;
    if (rename === undefined && externalId === undefined && active === undefined) return { outcome: "updated", user: detach(was), was: detach(was) };
    // Every refusal before any write.
    const moves = rename !== undefined && was.key === `email:${was.userName}`;
    const toKey = moves ? `email:${rename}` : was.key;
    if (rename !== undefined) {
      const taken = this.directory.get(scimNameKey(orgId, rename));
      if (taken?.scimId && taken.scimId !== id) return { outcome: "exists" };
      const target = moves ? this.liveGrant(toKey) : undefined;
      if (target && target.orgId !== orgId) return { outcome: "conflict" };
      if (target) return { outcome: "exists" };
    }
    let reuse: PlanGrant | undefined;
    // A reactivation never re-seats a personal account the org does not own by its form (ADR 0027): on the address instead.
    const org = this.orgs.get(orgId);
    const seatAt = active === true && org ? scimSeatKey(org, rename ?? was.userName, toKey) : toKey;
    if (active === true) {
      const held = moves && seatAt === toKey ? undefined : this.liveGrant(seatAt);
      if (held && held.orgId !== orgId) return { outcome: "conflict" };
      reuse = held;
      if (!reuse && this.liveMembers(orgId) >= (org?.seats ?? Infinity)) return { outcome: "full" };
    }

    const entries: AuditEntry[] = [];
    const detail: Record<string, unknown> = {};
    let next: ScimUser = { ...was, updatedAt: now };
    if (rename !== undefined) {
      // An address key names the address, so it moves with it; a key a sign-in claimed names the person and stays.
      if (moves) {
        const grant = this.liveGrant(was.key);
        if (grant) {
          this.grants.delete(was.key);
          this.grants.set(toKey, { ...grant, key: toKey });
        }
        this.scimByKey.delete(scimKeyIndex(was.key));
        next = { ...next, key: toKey };
      }
      this.directory.delete(scimNameKey(orgId, was.userName));
      next = { ...next, userName: rename };
      detail.from = was.userName;
    }
    if (externalId !== undefined) {
      next = { ...next, externalId };
      detail.external_id = externalId;
    }
    let action: "scim_user_updated" | "scim_user_deactivated" | "scim_user_reactivated" = "scim_user_updated";
    if (active === true) {
      if (seatAt !== next.key) {
        this.scimByKey.delete(scimKeyIndex(next.key));
        next = { ...next, key: seatAt };
      }
      if (!reuse) {
        const grant = scimGrant(next.key, orgId, now);
        this.grants.set(next.key, grant);
        entries.push(...grantAuditEntries(undefined, grant, audit, now));
      }
      action = "scim_user_reactivated";
    } else if (active === false) {
      const grant = this.liveGrant(next.key);
      if (grant && grant.orgId === orgId) {
        this.grants.delete(next.key);
        entries.push(...revokeAuditEntries(grant, audit, now));
      }
      action = "scim_user_deactivated";
    }
    if (active !== undefined) next = { ...next, active };
    this.writeScimRows(next);
    entries.push(scimUserEntry(orgId, id, action, { user_name: next.userName, key: next.key, ...detail }, audit, now));
    this.recordAudit(entries);
    return { outcome: "updated", user: detach(next), was: detach(was) };
  }

  /**
   * A delete is a deactivation that also hides the row (review finding 3): the grant goes, the row stays as a
   * tombstone with its directory entry and key index, so the subject is refused as a deactivated one is, and a
   * repeat answers the tombstone so a room walk cut short can be finished. A push for the address starts over.
   */
  async deleteScimUser(orgId: string, id: string, now: number, audit: AuditIntent): Promise<ScimUser | undefined> {
    const was = this.scimUsers.get(scimUserKey(orgId, id));
    if (!was) return undefined;
    if (was.deletedAt !== null) return detach(was);
    const entries: AuditEntry[] = [];
    const grant = was.active ? this.liveGrant(was.key) : undefined;
    if (grant && grant.orgId === orgId) {
      this.grants.delete(was.key);
      entries.push(...revokeAuditEntries(grant, audit, now));
    }
    this.scimUsers.set(scimUserKey(orgId, id), { ...was, active: false, updatedAt: now, deletedAt: now });
    entries.push(scimUserEntry(orgId, id, "scim_user_deleted", { user_name: was.userName, key: was.key }, audit, now));
    this.recordAudit(entries);
    return detach(was);
  }

  async issueScimToken(orgId: string, token: ScimToken, audit: AuditIntent): Promise<"issued" | "replaced" | "missing"> {
    if (!this.orgs.has(orgId)) return "missing";
    const previous = this.scimTokens.get(orgId);
    if (previous) this.scimTokenIndex.delete(previous.tokenHash);
    this.scimTokens.set(orgId, detach(token));
    this.scimTokenIndex.set(token.tokenHash, orgId);
    this.recordAudit([orgEventEntry(orgId, "scim_token_issued", { replaced: previous !== undefined }, audit, token.issuedAt)]);
    return previous ? "replaced" : "issued";
  }

  async revokeScimToken(orgId: string, audit: AuditIntent): Promise<"revoked" | "missing"> {
    const token = this.scimTokens.get(orgId);
    if (!token) return "missing";
    this.scimTokens.delete(orgId);
    this.scimTokenIndex.delete(token.tokenHash);
    this.recordAudit([orgEventEntry(orgId, "scim_token_revoked", {}, audit, Date.now())]);
    return "revoked";
  }

  async scimTokenOf(orgId: string): Promise<ScimToken | undefined> {
    const token = this.scimTokens.get(orgId);
    return token && detach(token);
  }

  async orgForScimToken(tokenHash: string): Promise<string | undefined> {
    return this.scimTokenIndex.get(tokenHash);
  }

  async appendAudit(a: AuditEntry): Promise<void> {
    this.recordAudit([a]);
  }

  async auditForOrg(orgId: string, limit: number): Promise<AuditEntry[]> {
    return detach(this.audit.filter((r) => r.entry.orgId === orgId).slice(-limit).map((r) => r.entry));
  }

  async appendOperatorAudit(a: AuditEntry): Promise<void> {
    this.operatorStream.push(detach(a));
  }

  async operatorAudit(limit: number): Promise<AuditEntry[]> {
    return detach(this.operatorStream.slice(-limit));
  }

  async queryAudit(orgId: string, query: AuditQuery): Promise<AuditPage> {
    return detach(pageOf(this.streamOf(orgId), query));
  }

  async auditFacets(orgId: string): Promise<AuditFacets> {
    return detach(facetsOf(this.streamOf(orgId), orgId));
  }

  async verifyAudit(orgId: string, from?: number): Promise<AuditVerification> {
    // ponytail: one feed over the whole stream; a memory store never holds a stream worth paging.
    const walk = chainWalk(this.auditStateOf(orgId).anchor, from);
    walk.feed(this.audit.filter((r) => r.entry.orgId === orgId && (from === undefined || r.seq >= from)).map((r) => ({ seq: r.seq, prevHash: r.prevHash, hash: r.hash, entry: r.entry })));
    return detach(walk.result());
  }

  private auditStateOf(orgId: string) {
    let state = this.auditState.get(orgId);
    if (!state) this.auditState.set(orgId, (state = { retentionDays: null, anchor: NO_ANCHOR, sweepAt: null, sink: null, sinkAt: null }));
    return state;
  }

  async auditSettings(orgId: string): Promise<AuditSettings> {
    const { retentionDays, sink } = this.auditStateOf(orgId);
    return { retentionDays, sink: sink && sinkStatus(sink, this.auditSeq.get(orgId) ?? 0) };
  }

  async setAuditRetention(orgId: string, days: number | null, audit: AuditIntent): Promise<AuditSettings> {
    const now = Date.now();
    const state = this.auditStateOf(orgId);
    state.retentionDays = days;
    state.sweepAt = days === null ? null : now;
    this.recordAudit([orgEventEntry(orgId, "audit_retention_set", { days }, audit, now)]);
    return this.auditSettings(orgId);
  }

  async sweepAudit(orgId: string, now: number): Promise<number> {
    const state = this.auditStateOf(orgId);
    if (state.retentionDays === null) return 0;
    // ponytail: one plan over the whole stream, where the DO goes a batch at a time.
    const plan = sweepPlan(this.audit.filter((r) => r.entry.orgId === orgId).map((r) => ({ seq: r.seq, at: r.entry.at, hash: r.hash })), now - state.retentionDays * 86_400_000);
    if (state.sweepAt !== null) state.sweepAt = now + SWEEP_EVERY_MS;
    if (!plan) return 0;
    this.audit = this.audit.filter((r) => r.entry.orgId !== orgId || r.seq > plan.through);
    state.anchor = plan.anchor;
    this.recordAudit([orgEventEntry(orgId, "audit_swept", { through_seq: plan.through, count: plan.count }, SYSTEM_INTENT, now)]);
    return plan.count;
  }

  async setAuditSink(orgId: string, url: string, audit: AuditIntent): Promise<{ sink: AuditSinkStatus; secret: string }> {
    const now = Date.now();
    const state = this.auditStateOf(orgId);
    const secret = randomId(32);
    state.sink = newSink(url, now, secret, state.sink?.deliveredThrough ?? 0);
    this.recordAudit([orgEventEntry(orgId, "audit_sink_set", { url }, audit, now)]);
    return { sink: (await this.auditSettings(orgId)).sink!, secret };
  }

  async removeAuditSink(orgId: string, audit: AuditIntent): Promise<boolean> {
    const state = this.auditStateOf(orgId);
    if (!state.sink) return false;
    const { url } = state.sink;
    state.sink = null; state.sinkAt = null;
    this.recordAudit([orgEventEntry(orgId, "audit_sink_removed", { url }, audit, Date.now())]);
    return true;
  }

  async resumeAuditSink(orgId: string, audit: AuditIntent): Promise<AuditSinkStatus | undefined> {
    const now = Date.now();
    const state = this.auditStateOf(orgId);
    if (!state.sink) return undefined;
    state.sink = { ...state.sink, attempts: 0, failingSince: null, lastError: null, dead: false };
    state.sinkAt = now;
    this.recordAudit([orgEventEntry(orgId, "audit_sink_resumed", { url: state.sink.url, delivered_through: state.sink.deliveredThrough }, audit, now)]);
    return (await this.auditSettings(orgId)).sink!;
  }

  async pumpAuditSink(orgId: string, now: number): Promise<AuditSinkStatus | undefined> {
    const state = this.auditStateOf(orgId);
    const sink = state.sink;
    if (!sink) return undefined;
    state.sinkAt = null;
    const newest = () => this.auditSeq.get(orgId) ?? 0;
    const rows = sink.dead ? [] : this.streamOf(orgId).filter((r) => r.seq > sink.deliveredThrough).slice(0, SINK_BATCH);
    if (rows.length === 0) return sinkStatus(sink, newest());
    const outcome = await deliverBatch(this.options.post ?? fetch, sink, orgId, rows.map(entryView), now);
    // Removed or replaced while the post was in flight: the outcome belongs to a sink that is gone.
    if (state.sink?.secret !== sink.secret) return state.sink ? sinkStatus(state.sink, newest()) : undefined;
    // Rows appended while the post was in flight are pending too: one more pass, not a wait for the next append.
    const next = nextSinkState(sink, outcome, now, rows.length === SINK_BATCH || newest() > rows.at(-1)!.seq);
    state.sink = next.sink; state.sinkAt = next.armAt;
    if (next.died) this.recordAudit([orgEventEntry(orgId, "audit_sink_dead", deadDetail(next.sink), SYSTEM_INTENT, now)]);
    return sinkStatus(next.sink, newest());
  }

  private streamOf(orgId: string): SeqEntry[] {
    return this.audit.filter((r) => r.entry.orgId === orgId).map((r) => ({ ...r.entry, seq: r.seq, hash: r.hash, prevHash: r.prevHash }));
  }

  async sweep(now: number): Promise<void> {
    for (const s of this.sessions.values()) this.closeIfAbandoned(s, now);
    // After the abandonment pass, so a room it has just closed is judged on the same clock. Walked
    // from a copy, because a purge deletes from the map.
    for (const s of [...this.sessions.values()]) {
      const purge = purgeDueAt(s);
      if (purge !== null && now >= purge) {
        // The purge wins when the sweep is due as well: it deletes every object and the room, so a
        // sweep first is work thrown away.
        await this.purgeNow(s, now);
        continue;
      }
      const sweep = sweepDueAt(s);
      if (sweep !== null && now >= sweep) await this.sweepBlobs(s.id);
    }
    // The seat's silence on an outside question: past its deadline the members answer (SessionDO: the room's alarm).
    for (const [sessionId, tasks] of this.outsideTasks) {
      for (const t of tasks.values()) if (t.seatDeadline !== null && now >= t.seatDeadline) this.handOver(sessionId, t, now);
    }
    // A question nobody answered in OUTSIDE_TASK_TTL_MS fails (SessionDO: the same alarm). After the hand-off, so a task
    // whose seat deadline and lifetime fall due together ends once, as expired.
    for (const s of this.sessions.values()) if (s.frozenAt === null) this.endOutside(s, "expired", now);
    for (const [token, p] of this.pending) {
      if (now > p.expiresAt) this.pending.delete(token);
    }
    // A resolved report goes 180 days on (R15); the Durable Objects store does this on the registry's alarm.
    for (const [id, r] of this.reports) {
      if (r.resolvedAt !== null && r.resolvedAt + REPORT_RETENTION_MS <= now) this.reports.delete(id);
    }
    // A reporter's filing times only serve the day's limit, so a row whose times have all left the day goes too, and
    // an account is not kept for good.
    for (const [reporter, times] of this.filings) {
      if (withinWindow(times, now).length === 0) this.filings.delete(reporter);
    }
    // Every sink whose delivery is due, and every retention window whose sweep is: what AuditDO's own alarm does per org.
    for (const [orgId, st] of this.auditState) if (st.sinkAt !== null && st.sinkAt <= now) await this.pumpAuditSink(orgId, now);
    for (const [orgId, st] of this.auditState) if (st.sweepAt !== null && st.sweepAt <= now) await this.sweepAudit(orgId, now);
  }

  /**
   * The Node server's heartbeat (#111, #188): for every room, what SessionDO's alarm
   * does for one. `step` is `tickStep` from heartbeat.ts, handed in because that module
   * imports this one; it decides, and this writes. Not on `BellmanStore`: the Workers
   * store ticks by alarm.
   *
   * A room whose tick is not due is left alone, clock included. The caller runs this
   * far more often than any cadence, and moving `lastTickAt` on every call would push
   * every room's next tick back for good. A due room either gets its heartbeat, written
   * as `#tickIfDue` writes it, or only its clock moved; the seat is woken after the
   * write when the step says so. No awaits, for appendEvent's reason.
   */
  tick(now: number, step: (s: StoredSession, now: number) => TickStep): void {
    for (const s of this.sessions.values()) {
      if (s.closed || s.frozenAt !== null || s.manifest.heartbeatOnMs === null) continue;
      if (isAbandoned(s, now, connectedAmong(s.members, this.attachedTo(s.id)))) continue;
      const r = step(s, now);
      if (!r.due) continue;
      (s as { lastTickAt?: number }).lastTickAt = now;
      if (!r.write) continue;
      const tick = this.appendNow(s, {
        type: "heartbeat", fromMemberId: "system", fromUserId: "system", fromLabel: "bellman",
        payload: r.payload, refId: null,
      }, now);
      if (!r.wakeHost) continue;
      // The host's own clock moves only on a tick that wakes it (I3), in the same step as the tick.
      (s as { lastHostTickAt?: number | null }).lastHostTickAt = now;
      this.hostWoken({ sessionId: s.id, cause: "tick", cursor: tick.cursor });
    }
  }

  /**
   * The Node server's housekeeping (#231): for every room, what SessionDO's `#housekeepIfDue`
   * does for one, run by the loop that runs `tick`. `rules` are `dueFindings` and `clearedKeys`
   * from housekeeping.ts, handed in because that module imports this one; they decide, and this
   * writes as the handler writes. A raised key that no longer holds is forgotten, and each due
   * finding is one `housekeeping` event from the room itself, its key recorded at `now`. The
   * rules' own gate keeps out a room with no housekeeping, a closed, a frozen or an empty one,
   * and an abandoned room is refused here as `tick` refuses it. `appendNow` runs the books and
   * wakes no hosted seat (ruling H1). Not on `BellmanStore`: the Workers store runs this by
   * alarm. No awaits, for appendEvent's reason.
   */
  housekeep(now: number, rules: { dueFindings: (s: StoredSession, now: number) => Finding[]; clearedKeys: (s: StoredSession, now: number) => string[] }): void {
    for (const s of this.sessions.values()) {
      // Before the skips: an overdue decision is closed in any room, an abandoned or frozen one included, as
      // SessionDO's `decision` alarm closes it. The clock's close ignores a freeze.
      for (const cursor of dueToExpire(noteDecisions({}, s.events), now)) {
        const audit = auditRows(
          rosterParties(s), { at: now, sessionId: s.id, action: "decision_closed", roomName: s.manifest.room, detail: {} }, SYSTEM_ACTOR,
        );
        this.decisionWrites(s, [closingEvent(this.decisionIn(s, cursor, now)!, { state: "expired" })], now, audit);
      }
      if (isAbandoned(s, now, connectedAmong(s.members, this.attachedTo(s.id)))) continue;
      const cleared = rules.clearedKeys(s, now);
      const due = rules.dueFindings(s, now);
      if (cleared.length === 0 && due.length === 0) continue;
      const raised = { ...s.raised };
      for (const key of cleared) delete raised[key];
      for (const f of due) raised[f.key] = { at: now, repeat: f.payload.repeat, since: f.payload.since };
      Object.assign(s, { raised });
      for (const f of due) {
        this.appendNow(s, {
          type: "housekeeping", fromMemberId: "system", fromUserId: "system", fromLabel: "bellman",
          payload: f.payload, refId: null,
        }, now);
      }
    }
  }

  /**
   * The purge (#65, D2), in the order the Durable Objects store keeps: the bytes first, then what
   * the rest of the store holds about the room, then the room. The first step is the only one that
   * can fail, and it fails before anything is forgotten, so a failed purge leaves a room the next
   * sweep tries again. What the order guarantees is never bytes that no record can find. It does not
   * keep a room from naming bytes that are gone: from the bucket's delete to the forgetting the room
   * is there and its objects are not, and a download of one answers 404, as it does for any
   * reference that dangles.
   *
   * A poll still waiting on the room is answered with nothing rather than dropped: it registered a
   * promise, and its own timer would find no waiter to settle.
   */
  private async purgeNow(s: Session, now: number): Promise<void> {
    await this.blobs.deleteAll(s.id);
    this.byCreator.get(s.createdBy)?.delete(s.id);
    this.hostedOpen.get(s.createdBy)?.delete(s.id);
    for (const m of s.members) this.byMember.get(m.userId)?.delete(s.id);
    for (const orgId of s.orgs) this.byOrg.get(orgId)?.delete(s.id);
    await this.dropRoomIndex(s.id);
    for (const rec of Object.values(s.joinCodes)) this.byJoinCode.delete(rec.code);
    this.recordAudit(s.orgs.map((orgId) => roomPurgedEntry(s, orgId, rosterParties(s), now)));
    for (const w of this.waiters.get(s.id) ?? []) w.resolve([]);
    this.waiters.delete(s.id);
    this.keys.delete(s.id);
    this.ballots.delete(s.id);
    this.roomBanned.delete(s.id);
    this.sends.delete(s.id);
    this.surfaces.delete(s.id);
    this.configs.delete(s.id);
    this.files.delete(s.id);
    this.memoryIdRows.delete(s.id);
    this.notesSharing.delete(s.id);
    this.outsideTasks.delete(s.id);
    this.outsideCallerRows.delete(s.id);
    this.outsideVisitors.delete(s.id);
    this.sessions.delete(s.id);
  }

  /** Resolve every waiter on a session from its own cursor. */
  private wake(s: Session): void {
    const ws = this.waiters.get(s.id);
    if (!ws || ws.length === 0) return;
    this.waiters.set(s.id, []);
    for (const w of ws) w.resolve(detach(s.events.filter((ev) => ev.cursor > w.after)));
  }

  /**
   * Operates on the canonical session; callers hold detached copies.
   *
   * The abandonment rule is `isAbandoned`'s, shared with SessionDO's alarm and
   * readers. A socket vouching for an active member is the one way a room past
   * the window stays open, and it is recorded: those members are stamped as seen
   * now, which is what `webSocketClose` does on a drop (#152), so the next sweep
   * finds a fresh window rather than the same question.
   */
  private closeIfAbandoned(s: Session, now: number): void {
    const due = abandonedAt(s);
    if (due === null || now <= due) return;
    const connected = connectedAmong(s.members, this.attachedTo(s.id));
    if (!isAbandoned(s, now, connected)) {
      s.members = stampSeen(s.members, now, connected);
      return;
    }
    this.closeNow(s, now);
    const event: SessionEvent = {
      cursor: s.events.length + 1,
      type: "session_expired" as EventType,
      fromMemberId: "system",
      fromUserId: "system",
      fromLabel: "bellman",
      payload: { reason: "abandoned", last_seen_at: new Date(due - ABANDONED_AFTER_MS).toISOString() },
      refId: null,
      at: now,
    };
    s.events.push(event);
    this.wake(s);
  }
}
