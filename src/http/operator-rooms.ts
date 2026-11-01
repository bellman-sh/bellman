/**
 * The operator's rooms (#472): `GET /operator/rooms`, every room newest first, and `GET /operator/rooms/:id`, one
 * room. Behind `/operator/stats`'s gate, which `statsRoutes` applies before it hands a request here, so this module
 * answers an operator's GET and nothing else.
 *
 * Metadata, counts and states, and never what a member wrote: no brief, no message or other event body, no surface
 * item's content. A private room shows its name and purpose (owner, 2026-10-29), so every read is audited, and the
 * audit fails closed: a read whose entry cannot be written answers 500 and no room.
 *
 * No cost yet. Cost this month and lifetime, and the detail's breakdown by driver and month, wait for the metering
 * (#473) and the price table (#475); the body leaves them out rather than answering them null.
 */
import { auditRows, partiesOf } from "../audit.js";
import { isOrgId } from "../grant-index.js";
import { isPublic, roomIndexKey, roomIndexRow, type BellmanStore, type RoomIndexRow, type RoomStatus, type RoomSummary } from "../store.js";
import type { AuditEntry } from "../types.js";
import { json, problem, type RoomCaller } from "./rooms.js";

export const ROOMS_PATH = "/operator/rooms";

export const MAX_ROOMS_PAGE = 50;

// ponytail: a filtered page reads at most this many index rows and stops short, with `next` past the last one read.
// A filter that matches fewer than one room in ten answers mostly short pages; an index per filter is the upgrade.
export const MAX_ROOMS_SCANNED = 500;

const STATUSES: readonly RoomStatus[] = ["open", "closed", "frozen", "purge_scheduled"];
const PARAMS = new Set(["limit", "after", "public", "hosted", "org", "status"]);

interface ListQuery {
  limit: number;
  after?: Pick<RoomIndexRow, "createdAt" | "sessionId">;
  public?: boolean;
  hosted?: boolean;
  org?: string;
  status?: RoomStatus;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** The row, the summary's fields null when it failed: a room whose object has not yet taken the deploy that added it. */
function rowOf(r: RoomIndexRow, s: RoomSummary | null) {
  return {
    id: r.sessionId,
    name: s?.name ?? null,
    created_by: r.createdBy,
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

/** A parameter's value, or the name of the parameter that is wrong. */
function parseQuery(params: URLSearchParams): ListQuery | { invalid: string } {
  for (const key of params.keys()) if (!PARAMS.has(key)) return { invalid: `${key} is not a parameter here` };
  const q: ListQuery = { limit: MAX_ROOMS_PAGE };
  const limit = params.get("limit");
  if (limit !== null) {
    if (!/^[1-9]\d*$/.test(limit) || Number(limit) > MAX_ROOMS_PAGE) return { invalid: `limit must be an integer from 1 to ${MAX_ROOMS_PAGE}` };
    q.limit = Number(limit);
  }
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
    if (!isOrgId(org)) return { invalid: "org must be an org id" };
    q.org = org;
  }
  const status = params.get("status");
  if (status !== null) {
    if (!STATUSES.includes(status as RoomStatus)) return { invalid: `status must be one of ${STATUSES.join(", ")}` };
    q.status = status as RoomStatus;
  }
  return q;
}

/**
 * The index rows of one page, and the cursor past the last row read, or null at the index's end. The filters read
 * the index rows, so a scan runs in windows until the page is full or `MAX_ROOMS_SCANNED` rows are read. Each
 * window is a full page and one more, whatever the page still wants, so a sparse filter costs a read per 51 rows
 * and not one per row, and a page that ends at the index's end knows it.
 */
async function scanIndex(store: BellmanStore, q: ListQuery): Promise<{ rows: RoomIndexRow[]; next: string | null }> {
  // An index row says public as the room was created, and unpublishing is one way: a row that says false is never
  // public now, so only public=true can be read off the index. public=false is decided on the summary.
  const keeps = (r: RoomIndexRow) =>
    (q.public !== true || r.public) && (q.hosted === undefined || r.hosted === q.hosted) && (q.org === undefined || r.orgId === q.org);
  const rows: RoomIndexRow[] = [];
  let cursor = q.after;
  let scanned = 0;
  for (;;) {
    const want = Math.min(MAX_ROOMS_PAGE + 1, MAX_ROOMS_SCANNED - scanned);
    const window = await store.listRoomsPage(want, cursor);
    for (const r of window) {
      if (rows.length === q.limit) return { rows, next: roomIndexKey(cursor!) };
      scanned++;
      cursor = r;
      if (keeps(r)) rows.push(r);
    }
    if (window.length < want) return { rows, next: null };
    if (scanned >= MAX_ROOMS_SCANNED) return { rows, next: roomIndexKey(cursor!) };
  }
}

/**
 * Each row's summary, in parallel, as many at once as the page holds. Undefined is a room gone, its row one the
 * purge left (#485), and is skipped. A rejection is a room whose object answers "does not implement" for the
 * minutes after a deploy (#361): the row stays, its summary null, and the page is not failed for it.
 */
async function summarised(store: BellmanStore, rows: readonly RoomIndexRow[]): Promise<{ index: RoomIndexRow; summary: RoomSummary | null }[]> {
  const settled = await Promise.allSettled(rows.map((r) => store.roomSummary(r.sessionId)));
  return rows.flatMap((r, i): { index: RoomIndexRow; summary: RoomSummary | null }[] => {
    const s = settled[i];
    if (s.status === "rejected") {
      console.error(`roomSummary failed for ${r.sessionId}:`, s.reason);
      return [{ index: r, summary: null }];
    }
    return s.value === undefined ? [] : [{ index: r, summary: s.value }];
  });
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

/** `path` is normalised and under `ROOMS_PATH`; the caller is an operator and the method GET. */
export async function operatorRooms(
  url: URL, path: string, who: RoomCaller, store: BellmanStore, origin: string | undefined,
): Promise<Response> {
  if (path === ROOMS_PATH) {
    const q = parseQuery(url.searchParams);
    if ("invalid" in q) return problem(400, "invalid_request", q.invalid, origin);
    const { rows, next } = await scanIndex(store, q);
    // `status` is the summary's, and so is `public` as the room is now, so both filter the page after the summaries:
    // a page they filter may be short too. A row with no summary falls back to its index flag.
    const page = (await summarised(store, rows)).filter((p) =>
      (q.status === undefined || p.summary?.status === q.status) &&
      (q.public === undefined || (p.summary?.public ?? p.index.public) === q.public));
    const { limit: _limit, after: _after, ...filters } = q;
    const asked = { ...(url.searchParams.has("limit") ? { limit: q.limit } : {}), ...filters };
    await store.appendOperatorAudit(operatorEntry(who, "operator:rooms", "operator_rooms_listed", {
      room_ids: page.map((p) => p.index.sessionId), filters: asked,
    }, null, partiesOf([who.identity.orgId, ...page.map((p) => p.index.orgId)])));
    return json(200, { rooms: page.map((p) => rowOf(p.index, p.summary)), next }, origin);
  }

  let id: string;
  try {
    id = decodeURIComponent(path.slice(ROOMS_PATH.length + 1));
  } catch {
    return problem(404, "not_found", "no such room", origin);
  }
  const session = await store.getSession(id);
  if (!session) return problem(404, "not_found", "no such room", origin);
  const [summary] = await Promise.allSettled([store.roomSummary(id)]);
  if (summary.status === "rejected") console.error(`roomSummary failed for ${id}:`, summary.reason);
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
    ...rowOf({ ...roomIndexRow(session), public: isPublic(session) }, s),
    purpose: session.manifest.purpose,
    roles: Object.keys(session.manifest.roles),
  }, origin);
}
