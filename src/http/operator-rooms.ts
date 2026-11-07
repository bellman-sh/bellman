/**
 * The operator's rooms (#472, dash#94): `GET /operator/rooms`, every room newest first, `GET /operator/rooms/:id`, one
 * room, and `GET /operator/room-counts`, how many rooms each owner or org has. Behind `/operator/stats`'s gate, which
 * `statsRoutes` applies before it hands a request here, so this module answers an operator's GET and nothing else.
 *
 * Metadata, counts and states, and never what a member wrote: no brief, no message or other event body, no surface
 * item's content, no email. A private room shows its name and purpose (owner, 2026-10-29), so every read is audited,
 * and the audit fails closed: a read whose entry cannot be written answers 500 and no room. A `RegistryDO` still on
 * the code from before a deploy answers 503 `not_ready`, and nothing is audited.
 *
 * No cost yet. Cost this month and lifetime, and the detail's breakdown by driver and month, wait for the metering
 * (#473) and the price table (#475); the body leaves them out rather than answering them null.
 */
import { auditRows, partiesOf } from "../orgs/audit.js";
import { isOrgId, NO_ORG } from "../storage/grant-index.js";
import { NotReadyError } from "../rpc-error.js";
import { isPublic } from "../room/manifest.js";
import { roomIndexKey, roomIndexRow, type BellmanStore, type RoomFilter, type RoomIndexRow, type RoomStatus, type RoomSummary } from "../storage/store.js";
import type { AuditEntry } from "../types.js";
import { json, problem, type RoomCaller } from "./rooms.js";

export const ROOMS_PATH = "/operator/rooms";
export const ROOM_COUNTS_PATH = "/operator/room-counts";

export const MAX_ROOMS_PAGE = 50;
export const MAX_COUNT_GROUPS = 100;
export const DEFAULT_COUNT_GROUPS = 50;
const MAX_ACCOUNT_ID = 128;

const STATUSES: readonly RoomStatus[] = ["open", "closed", "frozen", "purge_scheduled"];
const PARAMS = new Set(["limit", "after", "public", "hosted", "org", "status", "created_by"]);
const COUNT_PARAMS = new Set(["by", "limit", "after"]);

interface ListQuery {
  limit: number;
  after?: Pick<RoomIndexRow, "createdAt" | "sessionId">;
  public?: boolean;
  hosted?: boolean;
  /** null: the rooms with no org (`org=~none`). */
  org?: string | null;
  status?: RoomStatus;
  created_by?: string;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** The row, the summary's fields null when it failed: a room whose object has not yet taken the deploy that added it. */
function rowOf(r: RoomIndexRow, s: RoomSummary | null, handle: string | null) {
  return {
    id: r.sessionId,
    name: s?.name ?? null,
    created_by: r.createdBy,
    created_by_handle: handle,
    org_id: r.orgId,
    preset: r.preset,
    mode: r.mode,
    public: s?.public ?? r.public,
    hosted: r.hosted,
    created_at: iso(r.createdAt),
    last_event_at: iso(s?.lastEventAt ?? null),
    status: s?.status ?? null,
    seats: s ? { active: s.activeSeats, capacity: s.capacity } : null,
    events: s?.events ?? null,
    surface_items: s?.surfaceItems ?? null,
    blob_bytes: s?.blobBytes ?? null,
  };
}

/** A `limit` from 1 to `max`, or the reason it is not one. */
function limitOf(params: URLSearchParams, max: number, fallback: number): number | { invalid: string } {
  const limit = params.get("limit");
  if (limit === null) return fallback;
  if (!/^[1-9]\d*$/.test(limit) || Number(limit) > max) return { invalid: `limit must be an integer from 1 to ${max}` };
  return Number(limit);
}

/** A parameter's value, or the name of the parameter that is wrong. */
function parseQuery(params: URLSearchParams): ListQuery | { invalid: string } {
  for (const key of params.keys()) if (!PARAMS.has(key)) return { invalid: `${key} is not a parameter here` };
  const limit = limitOf(params, MAX_ROOMS_PAGE, MAX_ROOMS_PAGE);
  if (typeof limit !== "number") return limit;
  const q: ListQuery = { limit };
  const after = params.get("after");
  if (after !== null) {
    const m = /^(\d{16}):(.+)$/.exec(after);
    if (!m) return { invalid: "after must be a page's next" };
    q.after = { createdAt: Number(m[1]), sessionId: m[2] };
  }
  for (const key of ["public", "hosted"] as const) {
    const v = params.get(key);
    if (v === null) continue;
    if (v !== "true" && v !== "false") return { invalid: `${key} must be true or false` };
    q[key] = v === "true";
  }
  const org = params.get("org");
  if (org !== null) {
    // `~none` by name: `isOrgId` itself is not loosened.
    if (org !== NO_ORG && !isOrgId(org)) return { invalid: `org must be an org id or ${NO_ORG}` };
    q.org = org === NO_ORG ? null : org;
  }
  const createdBy = params.get("created_by");
  if (createdBy !== null) {
    if (createdBy.length === 0 || createdBy.length > MAX_ACCOUNT_ID) return { invalid: `created_by must be an account id of 1 to ${MAX_ACCOUNT_ID} characters` };
    q.created_by = createdBy;
  }
  const status = params.get("status");
  if (status !== null) {
    if (!STATUSES.includes(status as RoomStatus)) return { invalid: `status must be one of ${STATUSES.join(", ")}` };
    q.status = status as RoomStatus;
  }
  return q;
}

/**
 * The index rows of one page, and the cursor past its last row, or null at the end. One read of `limit + 1` rows: the
 * extra one says whether there is a next page and is not returned. The filters the index holds (owner, org, hosted,
 * and public=true) are applied by the store, so such a page is full however few rooms match.
 */
async function pageOf(store: BellmanStore, q: ListQuery): Promise<{ rows: RoomIndexRow[]; next: string | null }> {
  // An index row says public as the room was created, and unpublishing is one way: a row that says false is never
  // public now, so only public=true can be read off the index. public=false is decided on the summary.
  const filter: RoomFilter = {
    ...(q.created_by === undefined ? {} : { createdBy: q.created_by }),
    ...(q.org === undefined ? {} : { org: q.org }),
    ...(q.hosted === undefined ? {} : { hosted: q.hosted }),
    ...(q.public === true ? { publicTrue: true as const } : {}),
  };
  const read = Object.keys(filter).length > 0
    ? await store.listRoomsFiltered(q.limit + 1, q.after, filter)
    : await store.listRoomsPage(q.limit + 1, q.after);
  const rows = read.slice(0, q.limit);
  return { rows, next: read.length > q.limit ? roomIndexKey(rows.at(-1)!) : null };
}

/**
 * Each row's summary, in parallel, as many at once as the page holds. Undefined is a room gone, its row one the
 * purge left (#485): skipped, and its id returned so the caller removes it from the index. A rejection is a room whose
 * object answers "does not implement" for the minutes after a deploy (#361): the row stays, its summary null, the page
 * is not failed for it, and the row is never removed.
 */
async function summarised(
  store: BellmanStore, rows: readonly RoomIndexRow[],
): Promise<{ page: { index: RoomIndexRow; summary: RoomSummary | null }[]; gone: string[] }> {
  const settled = await Promise.allSettled(rows.map((r) => store.roomSummary(r.sessionId)));
  const gone: string[] = [];
  const page = rows.flatMap((r, i): { index: RoomIndexRow; summary: RoomSummary | null }[] => {
    const s = settled[i];
    if (s.status === "rejected") {
      console.error(`roomSummary failed for ${r.sessionId}:`, s.reason);
      return [{ index: r, summary: null }];
    }
    if (s.value === undefined) {
      gone.push(r.sessionId);
      return [];
    }
    return [{ index: r, summary: s.value }];
  });
  return { page, gone };
}

/**
 * The operator's entry, in the platform stream: who read, what, when, and the orgs the read concerns, seen from the
 * operator's side. AuditDO keeps the label, the room and the parties only beside a `crossing`, so every entry has one.
 */
function operatorEntry(
  who: RoomCaller, sessionId: string, action: string, detail: Record<string, unknown>, roomName: string | null, parties: (string | null)[],
): AuditEntry {
  const crossing = parties.some((p) => p !== who.identity.orgId) ? "cross_org" : "internal";
  return {
    at: Date.now(), orgId: null, sessionId, actorUserId: who.identity.userId, action, detail,
    actorLabel: who.identity.label, actorOrgId: who.identity.orgId, roomName,
    parties, crossing, direction: crossing === "cross_org" ? "outbound" : null,
  };
}

const notReady = (origin: string | undefined) =>
  problem(503, "not_ready", "the server is still taking a deploy; try again in a few minutes", origin);

/** `GET /operator/room-counts?by=owner|org&limit=&after=`. The caller is an operator and the method GET. */
export async function operatorRoomCounts(url: URL, who: RoomCaller, store: BellmanStore, origin: string | undefined): Promise<Response> {
  const params = url.searchParams;
  for (const key of params.keys()) if (!COUNT_PARAMS.has(key)) return problem(400, "invalid_request", `${key} is not a parameter here`, origin);
  const by = params.get("by");
  if (by !== "owner" && by !== "org") return problem(400, "invalid_request", "by must be owner or org", origin);
  const limit = limitOf(params, MAX_COUNT_GROUPS, DEFAULT_COUNT_GROUPS);
  if (typeof limit !== "number") return problem(400, "invalid_request", limit.invalid, origin);
  const afterParam = params.get("after");
  let after: { rooms: number; key: string } | undefined;
  if (afterParam !== null) {
    const m = /^(\d+):(.+)$/.exec(afterParam);
    if (!m) return problem(400, "invalid_request", "after must be a page's next", origin);
    after = { rooms: Number(m[1]), key: m[2] };
  }
  let counts;
  try {
    counts = await store.roomCounts(by, limit, after);
  } catch (err) {
    if (err instanceof NotReadyError) return notReady(origin);
    throw err;
  }
  await store.appendOperatorAudit(operatorEntry(who, "operator:room-counts", "operator_room_counts_read", {
    by, keys: counts.groups.map((g) => g.key), after: afterParam,
  }, null, partiesOf([who.identity.orgId, ...counts.orgs])));
  return json(200, { by, total_rooms: counts.total, groups: counts.groups, next: counts.next }, origin);
}

/** `path` is normalised and under `ROOMS_PATH`; the caller is an operator and the method GET. */
export async function operatorRooms(
  url: URL, path: string, who: RoomCaller, store: BellmanStore, origin: string | undefined,
): Promise<Response> {
  if (path === ROOMS_PATH) {
    const q = parseQuery(url.searchParams);
    if ("invalid" in q) return problem(400, "invalid_request", q.invalid, origin);
    let rows: RoomIndexRow[], next: string | null, handles: Map<string, string>;
    try {
      ({ rows, next } = await pageOf(store, q));
      handles = await store.handlesOf([...new Set(rows.map((r) => r.createdBy))]);
    } catch (err) {
      if (err instanceof NotReadyError) return notReady(origin);
      throw err;
    }
    const { page: all, gone } = await summarised(store, rows);
    // `status` is the summary's, and so is `public` as the room is now, so both filter the page after the summaries:
    // a page they filter may be short too. A row with no summary falls back to its index flag.
    const page = all.filter((p) =>
      (q.status === undefined || p.summary?.status === q.status) &&
      (q.public === undefined || (p.summary?.public ?? p.index.public) === q.public));
    // A row whose room is gone is a stale one a purge left: take it out of the index, so counts stop including it. In
    // the registry, never in a room, so the read still changes nothing a member sees. A failed drop costs only a retry.
    for (const [i, r] of (await Promise.allSettled(gone.map((id) => store.dropRoomIndex(id)))).entries()) {
      if (r.status === "rejected") console.error(`dropRoomIndex failed for ${gone[i]}:`, r.reason);
    }
    const { limit: _limit, after: _after, ...filters } = q;
    const asked = { ...(url.searchParams.has("limit") ? { limit: q.limit } : {}), ...filters };
    await store.appendOperatorAudit(operatorEntry(who, "operator:rooms", "operator_rooms_listed", {
      room_ids: page.map((p) => p.index.sessionId), filters: asked,
    }, null, partiesOf([who.identity.orgId, ...page.map((p) => p.index.orgId)])));
    return json(200, { rooms: page.map((p) => rowOf(p.index, p.summary, handles.get(p.index.createdBy) ?? null)), next }, origin);
  }

  let id: string;
  try {
    id = decodeURIComponent(path.slice(ROOMS_PATH.length + 1));
  } catch {
    return problem(404, "not_found", "no such room", origin);
  }
  const session = await store.getSession(id);
  if (!session) return problem(404, "not_found", "no such room", origin);
  const [summary, handle] = await Promise.allSettled([store.roomSummary(id), store.handleOf(session.createdBy)]);
  if (summary.status === "rejected") console.error(`roomSummary failed for ${id}:`, summary.reason);
  if (handle.status === "rejected") throw handle.reason;
  const s = summary.status === "fulfilled" ? summary.value ?? null : null;
  // The read is the platform's record and, as #61 decided, each customer's whose org sat in the room. The parties
  // are the operator's org and the room's, as `auditEntries` counts them, so a customer's row reads as an inbound
  // crossing; the operator's own org is written no row unless it sat in the room.
  const detail = { room_id: id };
  const facts = { at: Date.now(), sessionId: id, action: "operator_room_read", roomName: session.manifest.room, detail };
  const actor = { userId: who.identity.userId, label: who.identity.label, orgId: who.identity.orgId };
  const parties = partiesOf([who.identity.orgId, ...session.orgs]);
  await Promise.all([
    store.appendOperatorAudit(operatorEntry(who, id, "operator_room_read", detail, session.manifest.room, parties)),
    ...auditRows(parties, facts, actor).filter((e) => session.orgs.includes(e.orgId!)).map((e) => store.appendAudit(e)),
  ]);
  return json(200, {
    ...rowOf({ ...roomIndexRow(session), public: isPublic(session) }, s, handle.value ?? null),
    purpose: session.manifest.purpose,
    roles: Object.keys(session.manifest.roles),
  }, origin);
}
