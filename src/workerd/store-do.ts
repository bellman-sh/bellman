/// <reference types="@cloudflare/workers-types" />
import { OPERATOR_AUDIT_STREAM } from "../storage/grant-index.js";
import type { Ban, CreatorBan } from "../bans.js";
import type { Suspension } from "../suspension.js";
import { SWEEP_RPC_BUDGET, type ScimCreate, type ScimUpdate, type BlobCharge, type GrantDelete, type GrantWrite, type HostAppend, type HostedSlot, type PublicNameEntry, type PurgeSchedule, type SetJoinCode, type HomeAppend, type AppendExtras, type ApprovalWrite, type BellmanStore, type ConfigWrite, type ConfigWriteResult, type FsAppend, type FsPage, type FsWrite, type DepartedMembers, type EventBody, type EventWrite, type HostInstructionsSet, type MemberPatch, type AccountBanRequest, type ProposalApproval, type RemovalOutcome, type RemovalRequest, type SeatOutcome, type SurfaceAppend, type SurfaceAuthor, type SurfaceBatchAppend, type SurfaceFacts, type DecisionClose, type DecisionOpen, type VoteWrite, type RoomCounts, type RoomFilter, type RoomIndexRow, type RoomSummary, roomIndexRow } from "../storage/store.js";
import { codeIsLive } from "../room/codes.js";
import type { ArrivingMember, AuditEntry, Brief, Member, NewSession, PendingConnect, PlanGrant, PublicView, SavedPreset, UserRecord, SessionEvent, SurfaceRow, OutsideTask, ApprovedBy, Org, OrgIdp, OrgInvite, OrgPatch, ScimToken, ScimUser, ScimUserPatch, ConfigName, ConfigRow, FsRow, HomeSettings } from "../types.js";
import { isHomeRoomId } from "../files/home.js";
import type { ClosedState, DecisionPage, DecisionPageAsk, DecisionView, FailReason } from "../room/decision.js";
import type { HostDO } from "./host-do.js";
import type { IdempotencyRecord } from "../storage/idempotency.js";
import type { StoredSession } from "../storage/stored-session.js";
import type { AuditActor, AuditFacets, AuditPage, AuditQuery } from "../orgs/audit.js";
import type { AuditIntent } from "../orgs/grant-audit.js";
import type { AuditSettings, AuditSinkStatus, AuditVerification } from "../orgs/audit-sink.js";
import type { FiledReport, NewReport, Report } from "../reports.js";
import { orgsOnRoster } from "../room/retention.js";
import { NotReadyError, isNotImplemented, reviving } from "../rpc-error.js";
import type { SurfaceWrite } from "../surface/surface.js";
import type { Window, WindowPage } from "../surface/frames.js";
import type { AnswerRequest, AnswerResult, AskOutcome, AskRequest, CancelRequest, CancelResult } from "../outside.js";
import type { SendAdmission } from "../room/send-limit.js";
import type { SessionDO } from "./session-do.js";
import type { RegistryDO } from "./registry-do.js";
import type { AuditDO } from "./audit-do.js";

/**
 * Durable Objects implementation of BellmanStore.
 *
 * Topology — the three classes this facade routes to, of the five Durable Object
 * classes, each in its own file (session-do.ts, registry-do.ts, audit-do.ts; AuthDO
 * is in src/workerd/auth-do.ts, HostDO in src/workerd/host-do.ts), each matching a real scope
 * in the data:
 *
 *   SessionDO   one per room. Holds the session record, its events, its surface
 *               rows, bans and outbox, the live long-poll waiters, each member's
 *               send count and the room's sockets. Every request for a room
 *               routes to the same instance,
 *               which is what makes an in-memory waiter list correct here and
 *               what gives read-then-register its atomicity.
 *   RegistryDO  singleton. What resolves without a room in hand: join codes,
 *               pending connect tokens, plan grants, create counts, the creator,
 *               joined-rooms and org-rooms indexes, saved presets, hosted-room
 *               slots, creator-wide bans, suspensions and the report queue.
 *   AuditDO     one per org, so an org's audit stream is physically its own
 *               object. A cross-org room writes to each, and neither org's
 *               DO is reachable from the other.
 *
 * On sweep(): MemoryStore scans every session on a timer. There is no cheap
 * global iteration across a DO namespace, so abandonment is enforced by a
 * per-object alarm and connect tokens expire lazily on read. sweep() is
 * therefore a no-op — see the comment on the method. The registry's alarm
 * deletes a resolved report on a date it keeps (`report_purge`).
 */

export interface BellmanEnv {
  SESSION: DurableObjectNamespace<SessionDO>;
  REGISTRY: DurableObjectNamespace<RegistryDO>;
  AUDIT: DurableObjectNamespace<AuditDO>;
  /** One per hosted room, keyed by session id (hosted seat spec, D4). */
  HOST: DurableObjectNamespace<HostDO>;
  /** The room blob store (#183): a room's objects are deleted from it when the room is purged (#65). */
  BLOBS: R2Bucket;
  BELLMAN_KEYS?: string;
  /**
   * on | off, a var in wrangler.toml. The Worker reads it for `bellman_start` and `HostDO` for
   * its wakes (`hostedSeatOn`, src/host.ts); unset, empty or anything but "on" is off.
   */
  BELLMAN_HOSTED_SEAT?: string;
  /** User ids the hosted seat is on for while BELLMAN_HOSTED_SEAT is off (`hostedSeatUsers`, src/host.ts). */
  BELLMAN_HOSTED_SEAT_USERS?: string;
  /** A Worker secret. Absent, the seat's model calls go out unauthenticated and are refused. */
  ANTHROPIC_API_KEY?: string;
  /** Where the seat's model calls go. Unset means Anthropic's Messages API (spec D7). */
  MODEL_URL?: string;
}

/** A call to a method an object on older code does not have yet (#361's lag), rethrown as `NotReadyError`. */
async function notReady<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (err) {
    throw isNotImplemented(err) ? new NotReadyError() : err;
  }
}

export class DurableObjectStore implements BellmanStore {
  constructor(private env: BellmanEnv) {}

  /**
   * The three ways into a Durable Object, and every one of them `reviving`.
   *
   * This is the whole seam between the Worker's realm and the objects', so wrapping
   * it here covers every method on this facade — including ones added later, which a
   * per-method wrapper would not. workerd reconstructs a thrown error without its
   * prototype, so without this an `instanceof` outside an object never matches a
   * class thrown inside one (#101). `reviving` is a no-op on anything that does not
   * need it, so there is no call it is wrong for.
   */
  private session(id: string) {
    return reviving(this.env.SESSION.get(this.env.SESSION.idFromName(id)));
  }

  private get registry() {
    return reviving(this.env.REGISTRY.get(this.env.REGISTRY.idFromName("registry")));
  }

  private audit(orgId: string) {
    return reviving(this.env.AUDIT.get(this.env.AUDIT.idFromName(orgId)));
  }

  /**
   * Write into a derived index: attempted after the authoritative state is
   * committed, and a failure is logged rather than thrown.
   *
   * By the time an index is written, SessionDO has already committed the room
   * or the seat. A write that threw from here would abort the caller after its
   * effect had landed — a seat with no `member_joined` event and no audit row,
   * for a joiner who is told it failed. The index is derived and SessionDO is
   * authoritative, so swallowing costs a room missing from one listing. What
   * that costs depends on the listing: for `um:` a room missing from its
   * member's list, for `us:` a room a lapse cannot freeze, which outlives the
   * plan that pays for it.
   *
   * The row stays missing. Nothing rebuilds an index today: re-deriving `um:`
   * from SessionDO.members needs a list of sessions to walk, and the only list
   * of sessions the registry holds is `us:`, which has none of its own to be
   * rebuilt from. So the log line is the record of what to restore, and it
   * names both halves of the row's key — the user and the room.
   *
   * Only for indexes. The join code writes do not come through here: a join
   * code that does not resolve is a real failure, not a missing listing row.
   */
  private async writeIndex(
    index: string, userId: string, sessionId: string, write: () => Promise<unknown>
  ): Promise<void> {
    try {
      await write();
    } catch (err) {
      console.error(
        `${index} index write failed for ${userId} in ${sessionId}; ` +
          "that room is missing from their listing:",
        err,
      );
    }
  }

  async createSession(s: NewSession): Promise<void> {
    // Join codes register themselves from inside SessionDO, in the same
    // transaction as the session write. See #62.
    await this.session(s.id).createSession(s);
    // The join codes are already done: SessionDO enqueued a putJoinCode for each in
    // the same transaction as the session write, and delivered them. That is what #62
    // closed, so there is no putJoinCode call here any more — one would register every
    // code a second time.
    //
    // Every write below is an index, derived from what is committed above and attempted
    // after it, so a failure is logged rather than thrown (see writeIndex). Each is a
    // write into a second object with no transaction spanning it — the same gap #62
    // closed for the codes, still open here — and a lost one costs a row in one
    // listing, never the room.
    //
    // `us:` is how a lapsed plan finds this person's rooms, which bare create counts
    // cannot say. A missed entry means a room that is not frozen.
    // The operator's index of every room (#471) is written in the same put.
    await this.writeIndex("us", s.createdBy, s.id, () =>
      this.registry.indexSession(s.createdBy, s.id, roomIndexRow({ ...s, creator: s.members[0] })));
    // The members a session is created with are seated directly — bellman_start hands
    // over the creator in `members` and never calls addMember — so the joined index is
    // written here as well as in addMember. A missed entry leaves the room out of that
    // person's joined listing. Once a person, however many of the seats are theirs.
    for (const userId of new Set(s.members.map((m) => m.userId))) {
      await this.writeIndex("um", userId, s.id, () =>
        this.registry.indexMembership(userId, s.id));
    }
    // `uo:` is how an org's admin finds a closed room its people sat in (#65, D5): one row for each
    // org on the roster it starts with, the creator's included. A missed entry leaves the room out of
    // that one list, and the admin's read of it by id works all the same.
    for (const orgId of orgsOnRoster(s)) {
      await this.writeIndex("uo", orgId, s.id, () => this.registry.indexOrg(orgId, s.id));
    }
  }

  async getSession(id: string): Promise<StoredSession | undefined> {
    // A home room (ADR 0047) is not a room: no route, tool or socket reads it as one.
    if (isHomeRoomId(id)) return undefined;
    return this.session(id).getSession();
  }

  async getSessionByJoinCode(code: string): Promise<{ session: StoredSession; role: string } | undefined> {
    const id = await this.registry.lookupJoinCode(code);
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
    await this.session(sessionId).consumeJoinCode(role);
  }

  async clearJoinCodes(sessionId: string): Promise<void> {
    await this.session(sessionId).clearJoinCodes();
  }

  async setJoinCode(
    sessionId: string, role: string, code: string, expiresAt: number | null,
    guard: { replaceLive: boolean; now: number },
  ): Promise<SetJoinCode> {
    return this.session(sessionId).setJoinCode(role, code, expiresAt, guard);
  }

  async addMember(sessionId: string, member: ArrivingMember): Promise<boolean> {
    const added = await this.session(sessionId).addMember(member);
    // Gated on the result: addMember refuses an unknown, frozen or closed
    // session, and indexing regardless would put rooms into a person's joined
    // listing that they were turned away from.
    //
    // Attempted after the seat is committed, and a failure is logged rather than
    // thrown (see writeIndex): the caller still has the join event and the audit
    // row to write, and a joiner who was seated must not be told otherwise. A
    // second write into a second object with no transaction spanning it — the
    // same gap as the join code and the creator index, tracked on #62 — so a
    // lost write costs the room a row in one listing and nothing else.
    if (added) {
      await this.writeIndex("um", member.userId, sessionId, () =>
        this.registry.indexMembership(member.userId, sessionId));
      // The member's org, when it has one: a person from another org joining puts the room in that
      // org's list too (#65, D5).
      const orgId = member.orgId;
      if (orgId) await this.writeIndex("uo", orgId, sessionId, () => this.registry.indexOrg(orgId, sessionId));
    }
    return added;
  }

  async seatMember(
    sessionId: string,
    member: ArrivingMember,
    staleBefore: number,
    now: number,
  ): Promise<SeatOutcome> {
    const seated = await this.session(sessionId).seatMember(member, staleBefore, now);
    // The same membership index write addMember does, under the same rules:
    // gated on the result so a refused seating leaves no room in this person's
    // joined listing, attempted after the seat is committed, and a failure
    // logged rather than thrown. Reclaiming a seat does not retract the
    // reclaimed member's own row — their history is still theirs to list.
    if (seated.refused === null) {
      await this.writeIndex("um", member.userId, sessionId, () =>
        this.registry.indexMembership(member.userId, sessionId));
      const orgId = member.orgId;
      if (orgId) await this.writeIndex("uo", orgId, sessionId, () => this.registry.indexOrg(orgId, sessionId));
    }
    return seated;
  }

  async removeMember(
    sessionId: string,
    memberId: string,
    req: RemovalRequest,
  ): Promise<RemovalOutcome> {
    return this.session(sessionId).removeMember(memberId, req);
  }

  async banAccount(sessionId: string, req: AccountBanRequest): Promise<{ refused: RemovalOutcome["refused"] }> {
    return this.session(sessionId).banAccount(req);
  }

  async roomBans(sessionId: string): Promise<Ban[]> {
    return this.session(sessionId).roomBans();
  }

  async liftRoomBan(sessionId: string, banId: string): Promise<boolean> {
    return this.session(sessionId).liftRoomBan(banId);
  }

  async creatorBans(creatorId: string): Promise<CreatorBan[]> {
    return this.registry.creatorBans(creatorId);
  }

  async liftCreatorBan(creatorId: string, banId: string): Promise<boolean> {
    return this.registry.liftCreatorBan(creatorId, banId);
  }

  async isBannedByCreator(creatorId: string, userId: string): Promise<boolean> {
    return this.registry.isBannedByCreator(creatorId, userId);
  }

  async isBannedFromRoom(sessionId: string, userId: string): Promise<boolean> {
    return this.session(sessionId).isBanned(userId);
  }

  async suspend(userId: string, s: Suspension): Promise<void> {
    await this.registry.suspend(userId, s);
  }

  async unsuspend(userId: string): Promise<boolean> {
    return this.registry.unsuspend(userId);
  }

  async isSuspended(userId: string): Promise<boolean> {
    return this.registry.isSuspended(userId);
  }

  async fileReport(r: NewReport, now: number): Promise<FiledReport> {
    return this.registry.fileReport(r, now);
  }

  async roomReports(creatorId: string, sessionId: string): Promise<Report[]> {
    return this.registry.roomReports(creatorId, sessionId);
  }

  async listReports(limit: number): Promise<Report[]> {
    return this.registry.listReports(limit);
  }

  async resolveReport(id: string, resolution: { note: string; by: string }, now: number): Promise<Report | undefined> {
    return this.registry.resolveReport(id, resolution, now);
  }

  async connectedMembers(sessionId: string): Promise<ReadonlySet<string>> {
    return new Set(await this.session(sessionId).connectedMembers());
  }

  async updateMember(sessionId: string, memberId: string, patch: MemberPatch): Promise<void> {
    await this.session(sessionId).updateMember(memberId, patch);
  }

  async getBriefs(sessionId: string, memberIds: readonly string[]): Promise<Record<string, Brief>> {
    if (memberIds.length === 0) return {};
    return this.session(sessionId).getBriefs([...memberIds]);
  }

  async getMember(sessionId: string, memberId: string): Promise<Member | undefined> {
    return this.session(sessionId).getMember(memberId);
  }

  async getMembers(sessionId: string, memberIds: readonly string[]): Promise<Member[]> {
    if (memberIds.length === 0) return [];
    return this.session(sessionId).getMembers([...memberIds]);
  }

  async membersOfUser(sessionId: string, userId: string): Promise<Member[]> {
    return this.session(sessionId).membersOfUser(userId);
  }

  async departedMembers(sessionId: string, opts?: { limit?: number; leftAfter?: number }): Promise<DepartedMembers> {
    return this.session(sessionId).departedMembers(opts);
  }

  async publicNumbers(sessionId: string, labels: readonly string[]): Promise<Record<string, number>> {
    if (labels.length === 0) return {};
    return this.session(sessionId).publicNumbers([...labels]);
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.session(sessionId).closeSession();
    // The codes are retired in a call of their own: closeSession sets the flag, and
    // clearJoinCodes empties the map and queues each code's removal from the
    // registry, in one transaction.
    await this.clearJoinCodes(sessionId);
  }

  async closeSessionIfEmpty(sessionId: string): Promise<boolean> {
    // The decision is SessionDO's, made in one transaction. What follows it is
    // cleanup in a second object, with no transaction spanning the two (the gap
    // docs/ARCHITECTURE.md section 9 describes). A Worker that dies between them
    // leaves a stale registry row and not an open door: getSessionByJoinCode
    // refuses a closed session whatever the registry still holds.
    const closed = await this.session(sessionId).closeSessionIfEmpty();
    // Only a closed room gives up its codes, as closeSession does. A room left
    // open keeps them, because they are how its next member gets in. And a room
    // that was ALREADY closed gives them up too, not only one this call closed:
    // the retry of a close that died before the registry was reached finishes
    // the clear here, from the codes SessionDO left in the record.
    if (closed) await this.clearJoinCodes(sessionId);
    return closed;
  }

  async freezeSession(sessionId: string, frozenAt: number | null): Promise<void> {
    await this.session(sessionId).freezeSession(frozenAt);
  }

  async schedulePurge(sessionId: string, at: number, by: AuditActor | null): Promise<PurgeSchedule> {
    return this.session(sessionId).schedulePurge(at, by);
  }

  async unpublishSession(sessionId: string, at: number): Promise<void> {
    await this.session(sessionId).unpublishSession(at);
  }

  async publicNameEntry(name: string): Promise<PublicNameEntry | null> {
    return (await this.registry.lookupPublicName(name)) ?? null;
  }

  async publicNameEntries(limit: number): Promise<{ name: string; entry: PublicNameEntry }[]> {
    return this.registry.listPublicNames(limit);
  }

  async claimPublicName(name: string, entry: PublicNameEntry, expected: PublicNameEntry | null): Promise<boolean> {
    return this.registry.claimPublicName(name, entry, expected);
  }

  async releasePublicName(name: string, expected: PublicNameEntry): Promise<boolean> {
    return this.registry.releasePublicName(name, expected);
  }

  async setPublicName(sessionId: string, name: string): Promise<void> {
    await this.session(sessionId).setPublicName(name);
  }

  async setPublicView(sessionId: string, view: PublicView): Promise<void> {
    await this.session(sessionId).setPublicView(view);
  }

  async sweepBlobs(sessionId: string): Promise<{ removed: number; credited: number }> {
    return this.session(sessionId).sweepBlobs();
  }

  /**
   * Rooms this person created that a lapse could still freeze.
   *
   * The registry holds the index and cannot read a room's state; the room is in
   * another object. So the paging is here: ask for a window of ids, resolve
   * each, keep the live ones, and go back for more until `limit` is met or the
   * range runs out. `limit` therefore counts live rooms, which is what every
   * caller meant by it.
   *
   * Closed is the whole predicate, and `getSession` is what decides it: it runs
   * the abandonment check, so an abandoned room reads closed here even if no alarm
   * has fired yet. A room that is merely frozen stays — a lapse freezing an
   * already-frozen room is harmless, and leaving it out would hide it from the
   * one listing that can find it again.
   *
   * The drop is a second write into a second object with no transaction
   * spanning it, the gap docs/ARCHITECTURE.md section 9 describes — and the
   * cheapest instance of it in the codebase. A drop that dies leaves the row it
   * was going to remove, which is the state this call already tolerates and
   * repairs on the next walk.
   */
  async sessionsCreatedBy(userId: string, limit: number): Promise<string[]> {
    const live: string[] = [];
    let startAfter: string | undefined;
    // The budget bounds the SWEEPING, not the rooms the caller asked for, and
    // that distinction is the whole of it. Counting live rows against it made
    // the contract above false: with `limit` above the budget and every row
    // live, the walk stopped early having dropped nothing, and because
    // `startAfter` is local to one call the next call began at the beginning and
    // returned the same short page for ever. No progress, no error, no way to
    // tell.
    //
    // So a live row costs nothing here. It is what the caller asked for, it is
    // bounded by `limit`, and choosing a `limit` one request can resolve is the
    // caller's to do. What is unbounded without this is the DEAD tail — an
    // account with thousands of closed rooms — and spending a Workers request's
    // 1,000-subrequest cap on it throws, failing the walk outright rather than
    // returning a short list. Those rows are dropped as they are met, so the
    // next walk really does start further in.
    let swept = 0;

    while (live.length < limit && swept < SWEEP_RPC_BUDGET) {
      // A full window each time, not `limit - live.length`: the rows that fail
      // are the ones being skipped, so asking for only what is still wanted
      // turns a page of closed rooms into one id per round trip.
      const page = await this.registry.createdIndexPage(userId, limit, startAfter);
      if (page.length === 0) break;

      for (const id of page) {
        if (live.length >= limit || swept >= SWEEP_RPC_BUDGET) break;
        const session = await this.session(id).getSession();
        if (session && !session.closed) {
          live.push(id);
          continue;
        }
        await this.registry.dropCreatedIndex(userId, id);
        // The resolve that found it dead and the drop that removed it: the two
        // calls this row cost that the caller did not ask for.
        swept += 2;
      }
      // A short window means the range is exhausted; nothing follows to scan.
      if (page.length < limit) break;
      startAfter = page[page.length - 1];
    }
    return live;
  }

  async sessionsJoinedBy(userId: string, limit: number): Promise<string[]> {
    return this.registry.sessionsJoinedBy(userId, limit);
  }

  async sessionsForOrg(orgId: string, limit: number): Promise<string[]> {
    return this.registry.sessionsForOrg(orgId, limit);
  }

  async listRoomsPage(limit: number, startAfter?: Pick<RoomIndexRow, "createdAt" | "sessionId">): Promise<RoomIndexRow[]> {
    return this.registry.listRoomsPage(limit, startAfter);
  }

  async listRoomsFiltered(limit: number, startAfter: Pick<RoomIndexRow, "createdAt" | "sessionId"> | undefined, filter: RoomFilter): Promise<RoomIndexRow[]> {
    return notReady(this.registry.listRoomsFiltered(limit, startAfter, filter));
  }

  async roomCounts(by: "owner" | "org", limit: number, after?: { rooms: number; key: string }): Promise<RoomCounts> {
    return notReady(this.registry.roomCounts(by, limit, after));
  }

  async handlesOf(userIds: readonly string[]): Promise<Map<string, string>> {
    return notReady(this.registry.handlesOf(userIds));
  }

  async dropRoomIndex(sessionId: string): Promise<void> {
    return this.registry.dropRoomIndex(sessionId);
  }

  async roomSummary(sessionId: string): Promise<RoomSummary | undefined> {
    return this.session(sessionId).roomSummary();
  }

  /**
   * One window of the room index's backfill (#471): reads up to `limit` account index rows past `after`, and writes
   * a row for each room they name that has a record and no row. Idempotent, so a rerun writes nothing it has
   * written. Three subrequests a room at most (the walk, the record, the write), so a limit of 300 stays inside a
   * request's 1,000. `next` goes back in as `after`; null is the end.
   *
   * ponytail: a purge landing between the record's read and the write leaves a row naming no room; the list's
   * reader skips a row whose record is gone, and a sweep of such rows waits until one is seen.
   */
  async backfillRoomIndex(limit: number, after?: string): Promise<{ indexed: number; next: string | null }> {
    const { sessionIds, next } = await this.registry.unindexedRooms(limit, after);
    let indexed = 0;
    for (const id of sessionIds) {
      const s = await this.getSession(id);
      if (!s) continue;
      await this.registry.indexRoom(roomIndexRow(s));
      indexed++;
    }
    return { indexed, next };
  }

  async appendEvent(
    sessionId: string,
    e: Omit<SessionEvent, "cursor" | "at">,
    extras: AppendExtras = {}
  ): Promise<SessionEvent | null> {
    return this.session(sessionId).appendEvent(e, extras);
  }

  async appendEventOnce(
    sessionId: string,
    e: Omit<SessionEvent, "cursor" | "at">,
    key: string,
    extras: AppendExtras = {}
  ): Promise<EventWrite> {
    return this.session(sessionId).appendEventOnce(e, key, extras);
  }

  async idempotencyRecord(sessionId: string, memberId: string, key: string): Promise<IdempotencyRecord | null> {
    return this.session(sessionId).idempotencyRecord(memberId, key);
  }

  async approveProposal(sessionId: string, e: EventBody, key: string | null, approval: ProposalApproval): Promise<ApprovalWrite> {
    return this.session(sessionId).approveProposal(e, key, approval);
  }

  async openDecision(sessionId: string, e: EventBody, key: string | null, audit: readonly AuditEntry[] = []): Promise<DecisionOpen> {
    return this.session(sessionId).openDecision(e, key, audit);
  }

  async castVote(sessionId: string, e: EventBody, key: string | null, audit: readonly AuditEntry[] = []): Promise<VoteWrite> {
    return this.session(sessionId).castVote(e, key, audit);
  }

  async closeDecision(
    sessionId: string,
    decision: number,
    close: { state: ClosedState; reason?: FailReason },
    now: number,
    audit: readonly AuditEntry[] = [],
  ): Promise<DecisionClose> {
    return this.session(sessionId).closeDecision(decision, close, now, audit);
  }

  async decision(sessionId: string, cursor: number, now: number): Promise<DecisionView | null> {
    return this.session(sessionId).decision(cursor, now);
  }

  async decisions(sessionId: string, ask: DecisionPageAsk, now: number): Promise<DecisionPage> {
    return this.session(sessionId).decisions(ask, now);
  }

  async votedOn(sessionId: string, userId: string, decisions: number[]): Promise<number[]> {
    return this.session(sessionId).votedOn(userId, decisions);
  }

  async appendSurface(
    sessionId: string,
    e: EventBody,
    extras: { surface: SurfaceWrite; approvedBy?: ApprovedBy },
    key: string | null,
  ): Promise<SurfaceAppend> {
    return this.session(sessionId).appendSurface(e, extras, key);
  }

  async appendSurfaces(sessionId: string, author: SurfaceAuthor, writes: readonly SurfaceWrite[], key: string | null): Promise<SurfaceBatchAppend> {
    return this.session(sessionId).appendSurfaces(author, writes, key);
  }

  async admitSend(sessionId: string, key: string, limit: number, now: number): Promise<SendAdmission> {
    return this.session(sessionId).admitSend(key, limit, now);
  }

  async eventsAfter(sessionId: string, cursor: number, limit?: number): Promise<SessionEvent[]> {
    return this.session(sessionId).eventsAfter(cursor, limit);
  }

  async eventAt(sessionId: string, cursor: number): Promise<SessionEvent | undefined> {
    return this.session(sessionId).eventAt(cursor);
  }

  async recentEvents(sessionId: string, limit: number): Promise<SessionEvent[]> {
    return this.session(sessionId).recentEvents(limit);
  }

  async surfaceOf(sessionId: string): Promise<SurfaceRow[]> {
    return this.session(sessionId).surfaceOf();
  }

  async surfaceFacts(sessionId: string, keys: readonly string[]): Promise<SurfaceFacts> {
    return this.session(sessionId).surfaceFacts(keys);
  }

  async surfaceNamesBlob(sessionId: string, blobId: string): Promise<boolean> {
    return this.session(sessionId).surfaceNamesBlob(blobId);
  }

  async surfaceWindow(
    sessionId: string,
    asked: { window?: Window; next?: string },
    opts: { cut?: number },
  ): Promise<{ ok: true; page: WindowPage; cursor: number } | { ok: false; reason: string }> {
    return this.session(sessionId).surfaceWindow(asked, opts);
  }

  async outsideTask(sessionId: string, callerUserId: string, taskId: string): Promise<OutsideTask | undefined> {
    return this.session(sessionId).outsideTask(callerUserId, taskId);
  }

  async outsideTaskById(sessionId: string, taskId: string): Promise<OutsideTask | undefined> {
    return this.session(sessionId).outsideTaskById(taskId);
  }

  async outsideTasksOf(sessionId: string, callerUserId: string): Promise<OutsideTask[]> {
    return this.session(sessionId).outsideTasksOf(callerUserId);
  }

  async askOutside(sessionId: string, req: AskRequest): Promise<AskOutcome> {
    return this.session(sessionId).askOutside(req);
  }

  async answerOutside(sessionId: string, req: AnswerRequest): Promise<AnswerResult> {
    return this.session(sessionId).answerOutside(req);
  }

  async cancelOutside(sessionId: string, req: CancelRequest): Promise<CancelResult> {
    return this.session(sessionId).cancelOutside(req);
  }

  async seatSkipped(sessionId: string, taskId: string, reason: string): Promise<void> {
    return this.session(sessionId).seatSkipped(taskId, reason);
  }

  async chargeBlobBytes(sessionId: string, bytes: number): Promise<BlobCharge> {
    return this.session(sessionId).chargeBlobBytes(bytes);
  }

  async appendHostEvent(
    sessionId: string,
    e: Omit<SessionEvent, "cursor" | "at">,
    units: number,
    now: number,
    key: string,
  ): Promise<HostAppend> {
    return this.session(sessionId).appendHostEvent(e, units, now, key);
  }

  async hostEventFor(sessionId: string, key: string): Promise<SessionEvent | undefined> {
    return this.session(sessionId).hostEventFor(key);
  }

  async renewHostAllowance(sessionId: string, month: string, units: number): Promise<void> {
    await this.session(sessionId).renewHostAllowance(month, units);
  }

  async setHostInstructions(sessionId: string, instructions: string | null, audit: readonly AuditEntry[]): Promise<HostInstructionsSet> {
    return this.session(sessionId).setHostInstructions(instructions, audit);
  }

  async getConfigRow(sessionId: string, name: ConfigName): Promise<ConfigRow | null> {
    return this.session(sessionId).getConfigRow(name);
  }

  async configHistory(sessionId: string, name: ConfigName): Promise<ConfigRow[]> {
    return this.session(sessionId).configHistory(name);
  }

  async writeConfig(sessionId: string, w: ConfigWrite, audit: readonly AuditEntry[]): Promise<ConfigWriteResult> {
    return this.session(sessionId).writeConfig(w, audit);
  }

  async readFs(sessionId: string, path: string, rev?: number): Promise<FsRow | null> {
    return this.session(sessionId).readFs(path, rev);
  }

  async listFs(sessionId: string, prefix: string, opts?: { cursor?: string; hide?: readonly string[]; newest?: boolean }): Promise<FsPage> {
    return this.session(sessionId).listFs(prefix, opts);
  }

  async fsHistory(sessionId: string, path: string): Promise<FsRow[]> {
    return this.session(sessionId).fsHistory(path);
  }

  async findFs(sessionId: string, query: string, opts?: { cursor?: string; hide?: readonly string[] }): Promise<FsPage> {
    return this.session(sessionId).findFs(query, opts);
  }

  async appendFs(sessionId: string, w: FsWrite, audit: readonly AuditEntry[]): Promise<FsAppend> {
    return this.session(sessionId).appendFs(w, audit);
  }

  async writeHome(id: string, home: NewSession, w: FsWrite, ceiling: number): Promise<HomeAppend> {
    return this.session(id).writeHome(home, w, ceiling);
  }

  async readHomeSettings(id: string): Promise<HomeSettings> {
    return this.session(id).readHomeSettings();
  }

  async writeHomeSettings(id: string, settings: HomeSettings): Promise<void> {
    return this.session(id).writeHomeSettings(settings);
  }

  async memoryIdOf(sessionId: string, userId: string): Promise<string | null> {
    return this.session(sessionId).memoryIdOf(userId);
  }

  async memoryIdOwner(sessionId: string, memoryId: string): Promise<string | null> {
    return this.session(sessionId).memoryIdOwner(memoryId);
  }

  async memoryIds(sessionId: string): Promise<Array<{ userId: string; memoryId: string }>> {
    return this.session(sessionId).memoryIds();
  }

  async notesSharers(sessionId: string): Promise<string[]> {
    return this.session(sessionId).notesSharers();
  }

  async setNotesSharing(sessionId: string, userId: string, shared: boolean): Promise<void> {
    return this.session(sessionId).setNotesSharing(userId, shared);
  }

  async waitForEvents(
    sessionId: string,
    cursor: number,
    waitMs: number,
    limit?: number
  ): Promise<SessionEvent[]> {
    return this.session(sessionId).waitForEvents(cursor, waitMs, limit);
  }

  async putPendingConnect(p: PendingConnect): Promise<void> {
    await this.registry.putPendingConnect(p);
  }

  async takePendingConnect(token: string): Promise<PendingConnect | undefined> {
    return this.registry.takePendingConnect(token);
  }

  async countCreatesThisMonth(userId: string): Promise<number> {
    return this.registry.countCreatesThisMonth(userId);
  }

  async recordCreate(userId: string): Promise<void> {
    await this.registry.recordCreate(userId);
  }

  async reserveHostedRoom(userId: string, sessionId: string, limit: number): Promise<HostedSlot> {
    return this.registry.reserveHostedRoom(userId, sessionId, limit);
  }

  async releaseHostedRoom(userId: string, sessionId: string): Promise<void> {
    await this.registry.releaseHostedRoom(userId, sessionId);
  }

  async listPresets(userId: string): Promise<SavedPreset[]> {
    return this.registry.listPresets(userId);
  }

  async getPreset(userId: string, name: string): Promise<SavedPreset | undefined> {
    return this.registry.getPreset(userId, name);
  }

  async putPreset(userId: string, preset: SavedPreset, cap: number): Promise<"saved" | "full"> {
    return this.registry.putPreset(userId, preset, cap);
  }

  async deletePreset(userId: string, name: string): Promise<boolean> {
    return this.registry.deletePreset(userId, name);
  }

  async handleOf(userId: string): Promise<string | undefined> {
    return this.registry.handleOf(userId);
  }

  async userOfHandle(handle: string): Promise<string | undefined> {
    return this.registry.userOfHandle(handle);
  }

  async handleHolders(): Promise<{ userId: string; handle: string }[]> {
    return this.registry.handleHolders();
  }

  async claimHandle(userId: string, handle: string): Promise<"claimed" | "taken"> {
    return this.registry.claimHandle(userId, handle);
  }

  async releaseHandle(userId: string): Promise<void> {
    await this.registry.releaseHandle(userId);
  }

  async releaseHandleNamed(handle: string): Promise<string | undefined> {
    return this.registry.releaseHandleNamed(handle);
  }

  async signRoom(userId: string, sessionId: string, at: number): Promise<string | undefined> {
    return this.registry.signRoom(userId, sessionId, at);
  }

  async unsignRoom(userId: string, sessionId: string): Promise<void> {
    await this.registry.unsignRoom(userId, sessionId);
  }

  async signedRooms(userId: string): Promise<{ sessionId: string; signedAt: number }[]> {
    return this.registry.signedRooms(userId);
  }

  async bylineFor(userId: string, sessionId: string): Promise<string | undefined> {
    return this.registry.bylineFor(userId, sessionId);
  }

  async recordSignIn(userId: string, now: number, githubLogin?: string, googleEmail?: string, ref?: string): Promise<void> {
    await this.registry.recordSignIn(userId, now, githubLogin, googleEmail, ref);
  }

  async countUsers(): Promise<number> {
    return this.registry.countUsers();
  }

  async listUsers(limit: number): Promise<UserRecord[]> {
    return this.registry.listUsers(limit);
  }

  async getGrant(key: string): Promise<PlanGrant | undefined> {
    return this.registry.getGrant(key);
  }

  async putGrant(grant: PlanGrant): Promise<void> {
    await this.registry.putGrant(grant);
  }

  async deleteGrant(key: string): Promise<void> {
    await this.registry.deleteGrant(key);
  }

  async putGrantIfOwned(
    grant: PlanGrant,
    expectedOrgId: string | null,
    audit: AuditIntent
  ): Promise<"written" | "conflict" | "full"> {
    return this.registry.putGrantIfOwned(grant, expectedOrgId, audit);
  }

  async deleteGrantIfOwned(
    key: string,
    expectedOrgId: string | null,
    audit: AuditIntent
  ): Promise<"deleted" | "missing" | "conflict"> {
    return this.registry.deleteGrantIfOwned(key, expectedOrgId, audit);
  }

  async putGrantIfSource(
    grant: PlanGrant,
    expectedSource: string,
    audit: AuditIntent
  ): Promise<GrantWrite> {
    return this.registry.putGrantIfSource(grant, expectedSource, audit);
  }

  async deleteGrantIfSource(
    key: string,
    expectedSource: string,
    audit: AuditIntent
  ): Promise<GrantDelete> {
    return this.registry.deleteGrantIfSource(key, expectedSource, audit);
  }

  async moveGrant(fromKey: string, toKey: string): Promise<void> {
    await this.registry.moveGrant(fromKey, toKey);
  }

  async listGrants(limit: number, orgId?: string | null): Promise<PlanGrant[]> {
    return this.registry.listGrants(limit, orgId);
  }

  async getOrg(orgId: string): Promise<Org | undefined> {
    return this.registry.getOrg(orgId);
  }

  async createOrg(org: Org, ownerGrant: PlanGrant, audit: AuditIntent): Promise<"created" | "exists" | "conflict"> {
    return this.registry.createOrg(org, ownerGrant, audit);
  }

  async updateOrg(orgId: string, patch: OrgPatch, audit: AuditIntent): Promise<Org | undefined> {
    return this.registry.updateOrg(orgId, patch, audit);
  }

  async countOrgMembers(orgId: string): Promise<number> {
    return this.registry.countOrgMembers(orgId);
  }

  async activatePurchasedOrg(
    orgId: string, ownerUserId: string, seats: number, audit: AuditIntent,
  ): Promise<"created" | "updated" | "unchanged" | "not_purchased"> {
    return this.registry.activatePurchasedOrg(orgId, ownerUserId, seats, audit);
  }

  async deactivateOrg(orgId: string, audit: AuditIntent): Promise<"updated" | "unchanged" | "missing" | "not_purchased"> {
    return this.registry.deactivateOrg(orgId, audit);
  }

  async putOrgIdp(orgId: string, idp: OrgIdp, audit: AuditIntent): Promise<"written" | "missing"> {
    return this.registry.putOrgIdp(orgId, idp, audit);
  }

  async getOrgIdp(orgId: string): Promise<OrgIdp | undefined> {
    return this.registry.getOrgIdp(orgId);
  }

  async deleteOrgIdp(orgId: string, audit: AuditIntent): Promise<"deleted" | "missing"> {
    return this.registry.deleteOrgIdp(orgId, audit);
  }

  async claimDomain(orgId: string, domain: string, token: string, now: number, audit: AuditIntent): Promise<"claimed" | "exists" | "missing"> {
    return this.registry.claimDomain(orgId, domain, token, now, audit);
  }

  async verifyDomain(orgId: string, domain: string, now: number, audit: AuditIntent): Promise<"verified" | "taken" | "unknown"> {
    return this.registry.verifyDomain(orgId, domain, now, audit);
  }

  async releaseDomain(orgId: string, domain: string, audit: AuditIntent): Promise<"released" | "unknown"> {
    return this.registry.releaseDomain(orgId, domain, audit);
  }

  async orgForDomain(domain: string): Promise<string | undefined> {
    return this.registry.orgForDomain(domain);
  }

  async provisionSsoMember(
    orgId: string, key: string, now: number, audit: AuditIntent, address?: string,
  ): Promise<"written" | "exists" | "full" | "no_org" | "deprovisioned"> {
    return this.registry.provisionSsoMember(orgId, key, now, audit, address);
  }

  async issueScimToken(orgId: string, token: ScimToken, audit: AuditIntent): Promise<"issued" | "replaced" | "missing"> {
    return this.registry.issueScimToken(orgId, token, audit);
  }

  async revokeScimToken(orgId: string, audit: AuditIntent): Promise<"revoked" | "missing"> {
    return this.registry.revokeScimToken(orgId, audit);
  }

  async scimTokenOf(orgId: string): Promise<ScimToken | undefined> {
    return this.registry.scimTokenOf(orgId);
  }

  async orgForScimToken(tokenHash: string): Promise<string | undefined> {
    return this.registry.orgForScimToken(tokenHash);
  }

  async createScimUser(user: ScimUser, audit: AuditIntent): Promise<ScimCreate> {
    return this.registry.createScimUser(user, audit);
  }

  async getScimUser(orgId: string, id: string): Promise<ScimUser | undefined> {
    return this.registry.getScimUser(orgId, id);
  }

  async scimUserByName(orgId: string, userName: string): Promise<ScimUser | undefined> {
    return this.registry.scimUserByName(orgId, userName);
  }

  async scimUserByKey(key: string): Promise<ScimUser | undefined> {
    return this.registry.scimUserByKey(key);
  }

  async listScimUsers(orgId: string, limit: number): Promise<ScimUser[]> {
    return this.registry.listScimUsers(orgId, limit);
  }

  async updateScimUser(orgId: string, id: string, patch: ScimUserPatch, now: number, audit: AuditIntent): Promise<ScimUpdate> {
    return this.registry.updateScimUser(orgId, id, patch, now, audit);
  }

  async deleteScimUser(orgId: string, id: string, now: number, audit: AuditIntent): Promise<ScimUser | undefined> {
    return this.registry.deleteScimUser(orgId, id, now, audit);
  }

  async putOrgInvite(invite: OrgInvite, audit: AuditIntent): Promise<"invited" | "exists" | "limit" | "no_org"> {
    return this.registry.putOrgInvite(invite, audit);
  }

  async listOrgInvites(orgId: string, limit: number): Promise<OrgInvite[]> {
    return this.registry.listOrgInvites(orgId, limit);
  }

  async invitesFor(keys: string[]): Promise<OrgInvite[]> {
    return this.registry.invitesFor(keys);
  }

  async deleteOrgInvite(orgId: string, key: string, audit: AuditIntent): Promise<"deleted" | "missing"> {
    return this.registry.deleteOrgInvite(orgId, key, audit);
  }

  async renewOrgInvite(orgId: string, key: string, invitedBy: string, now: number, audit: AuditIntent): Promise<OrgInvite | "missing"> {
    return this.registry.renewOrgInvite(orgId, key, invitedBy, now, audit);
  }

  async spendInviteMail(orgId: string, budget: number, now: number): Promise<boolean> {
    return this.registry.spendInviteMail(orgId, budget, now);
  }

  async acceptOrgInvite(
    orgId: string, keys: string[], subjectKey: string, now: number, audit: AuditIntent, link?: { key: string; at: number },
  ): Promise<"joined" | "member" | "taken" | "full" | "sso" | "gone"> {
    return this.registry.acceptOrgInvite(orgId, keys, subjectKey, now, audit, link);
  }

  async declineOrg(subjectKey: string, orgId: string, now: number): Promise<void> {
    await this.registry.declineOrg(subjectKey, orgId, now);
  }

  async declinedOrgs(subjectKey: string): Promise<{ orgId: string; at: number }[]> {
    return this.registry.declinedOrgs(subjectKey);
  }

  async appendAudit(a: AuditEntry): Promise<void> {
    if (!a.orgId) return; // no org, no audit stream to write to
    await this.audit(a.orgId).append(a);
  }

  async auditForOrg(orgId: string, limit: number): Promise<AuditEntry[]> {
    return this.audit(orgId).recent(limit);
  }

  async appendOperatorAudit(a: AuditEntry): Promise<void> {
    await this.audit(OPERATOR_AUDIT_STREAM).append(a);
  }

  async operatorAudit(limit: number): Promise<AuditEntry[]> {
    return this.audit(OPERATOR_AUDIT_STREAM).recent(limit);
  }

  async queryAudit(orgId: string, query: AuditQuery): Promise<AuditPage> {
    return this.audit(orgId).query(query);
  }

  async auditFacets(orgId: string): Promise<AuditFacets> {
    return this.audit(orgId).facets();
  }

  async verifyAudit(orgId: string, from?: number): Promise<AuditVerification> {
    return this.audit(orgId).verify(from);
  }

  async auditSettings(orgId: string): Promise<AuditSettings> {
    return this.audit(orgId).settings();
  }

  async setAuditRetention(orgId: string, days: number | null, audit: AuditIntent): Promise<AuditSettings> {
    return this.audit(orgId).setRetention(orgId, days, audit, Date.now());
  }

  async sweepAudit(orgId: string, now: number): Promise<number> {
    return this.audit(orgId).sweep(now);
  }

  async setAuditSink(orgId: string, url: string, audit: AuditIntent): Promise<{ sink: AuditSinkStatus; secret: string }> {
    return this.audit(orgId).setSink(orgId, url, audit, Date.now());
  }

  async removeAuditSink(orgId: string, audit: AuditIntent): Promise<boolean> {
    return this.audit(orgId).removeSink(orgId, audit, Date.now());
  }

  async resumeAuditSink(orgId: string, audit: AuditIntent): Promise<AuditSinkStatus | undefined> {
    return this.audit(orgId).resumeSink(orgId, audit, Date.now());
  }

  async pumpAuditSink(orgId: string, now: number): Promise<AuditSinkStatus | undefined> {
    return this.audit(orgId).pump(now);
  }

  /**
   * No-op by design. MemoryStore sweeps on a timer because it can iterate every
   * session cheaply; a DO namespace cannot. Abandonment is enforced by the
   * per-object alarm set in SessionDO.createSession, the sweep and the purge of a
   * closed room (#65) by the same alarm, a resolved report by the registry's
   * (`report_purge`), and connect tokens are checked for expiry when taken.
   * Nothing is left for a sweep to do.
   */
  async sweep(_now: number): Promise<void> {}
}
