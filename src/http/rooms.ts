/**
 * The HTTP room routes (#183, #184; #49 is where the rest go): the list, the
 * detail, the surface read and its writes, and the two doors a room's bytes
 * pass through. What the control panel calls, and what any bearer caller may.
 * Since #65, also an org admin's read of a closed room its org sat in, the
 * list of those rooms, and the delete a creator or such an admin may ask for.
 *
 * Runtime-free, like rooms.ts: a web Request in, a Response out, so the Worker
 * dispatches here and the root test program drives the same code over
 * MemoryStore and MemoryBlobStore with no listener. Who is calling is handed in
 * (`deps.caller`): the Worker composes it from the bearer paths /mcp takes and
 * the authorization server's own `caller`, so what counts as a caller cannot
 * differ between a tool and a route (spec D2).
 *
 * A transport's job is translation. `gateSeat` decides and this maps its code
 * to a status, the way rooms.ts says a route should; `RoomFailure` is a closed
 * union, so a code the table below forgets is a compile error.
 */
import { entitlementsFor } from "../auth.js";
import {
  BlobLengthError, MAX_BLOB_BYTES, MAX_BLOB_NAME_CHARS, OCTET_STREAM, SNIFF_BYTES,
  attachmentDisposition, blobBytesUsed, blobKey, isBlobId, isImageType, newBlobId, readHead,
  sanitizeName, storedType, type BlobStore,
} from "../blobs.js";
import { allowedOrigin, corsHeaders, csrfRefusal, preflightResponse } from "../oauth/browser.js";
import { publicMember, retentionOf, roomPreview, roomListEntry, rosterAsOf, untrusted } from "../projections.js";
import { publicEvent } from "../public-event.js";
import { verbsOfRole } from "../roles.js";
import { cutAtFor, cutFor, findMember, gateSeat, handlesOf, readSurface, sessionStatus, writeSurface, type RoomFailure } from "../rooms.js";
import { JOINED_SCAN, isRemovedMember, type BellmanStore } from "../store.js";
import type { StoredSession } from "../stored-session.js";
import { surfaceCursor } from "../surface.js";
import type { Identity, Member, SessionEvent } from "../types.js";

/** Who is calling a room route, and how. `via` feeds the CSRF check and nothing else. */
export interface RoomCaller {
  identity: Identity;
  via: "bearer" | "cookie";
}

export interface RoomRouteDeps {
  store: BellmanStore;
  blobs: BlobStore;
  /** Bearer or cookie, or null. The Worker builds it from `resolveCaller` and the OAuth `caller`. */
  caller: (request: Request) => Promise<RoomCaller | null>;
  /** The panel's origins: CORS, the preflight, and the CSRF check. */
  panelOrigins: readonly string[];
}

// ponytail: fifty rooms, not paged. The first account past it wants #49's
// summary index, not a bigger number.
export const MAX_ROOMS_LISTED = 50;

// ponytail: 64 KB, not tuned. An item's largest field is 8,000 characters;
// this is the bound on the JSON around it, read off the header before parsing.
export const MAX_SURFACE_WRITE_BYTES = 64 * 1024;

// ponytail: two hundred events a read, not tuned, and no paging backwards. A first read is the newest
// two hundred; a room whose story is longer than that wants #49's paged read.
export const MAX_EVENTS_READ = 200;

const LIST = /^\/rooms$/;
const DETAIL = /^\/rooms\/([^/]+)$/;
const SURFACE = /^\/rooms\/([^/]+)\/surface$/;
const EVENTS = /^\/rooms\/([^/]+)\/events$/;
const SURFACE_ITEM = /^\/rooms\/([^/]+)\/surface\/([^/]+)$/;
const UPLOAD = /^\/rooms\/([^/]+)\/blobs$/;
const DOWNLOAD = /^\/rooms\/([^/]+)\/blobs\/([^/]+)$/;

/** A refusal's status from the code the operation answered with. Closed: a new code is a compile error here. */
const STATUS: Record<RoomFailure, number> = {
  not_found: 404, closed: 409, frozen: 409, forbidden: 403, conflict: 409, invalid: 400,
};

// ponytail: five minutes of private caching, not tuned. It is also how long a
// browser may go on serving bytes to a member removed in the meantime; the
// cut is enforced at the route, not in a cache.
/** The headers every download carries (D4), on a 200 and a 304 alike. */
const DOWNLOAD_HEADERS = {
  "cache-control": "private, max-age=300",
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox",
} as const;

const json = (status: number, body: unknown, origin: string | undefined) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...corsHeaders(origin) },
  });

/** The shape the OAuth routes answer errors in, so the panel reads one error form. */
const problem = (status: number, error: string, description: string, origin: string | undefined) =>
  json(status, { error, error_description: description }, origin);

const overQuota = (used: number, ceiling: number, bytes: number, origin: string | undefined) =>
  json(413, {
    error: "over_quota",
    error_description: `this room holds ${used} of ${ceiling} bytes, and ${bytes} more would pass its plan's ceiling`,
    used,
    ceiling,
  }, origin);

const methodNotAllowed = (allow: string, origin: string | undefined) =>
  new Response("Method not allowed", { status: 405, headers: { allow, ...corsHeaders(origin) } });

/**
 * The room routes. `undefined` for a path that is neither `/rooms` (the list)
 * nor under `/rooms/`, so the Worker carries on to the next module; everything
 * under the prefix is answered here, a path this module does not know and a
 * handler that throws included.
 */
export async function roomRoutes(request: Request, deps: RoomRouteDeps): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (path !== "/rooms" && !path.startsWith("/rooms/")) return undefined;
  const origin = allowedOrigin(request, deps.panelOrigins);
  // The panel's upload sets a Content-Type that is not a simple one, so the
  // browser asks first. 204 either way: a stranger's preflight carries no grant.
  if (request.method === "OPTIONS") return preflightResponse(origin);

  // What a client sees of an unexpected throw — a store, a bucket or the caller
  // lookup failing — is decided here, once, for both servers: this route's own
  // JSON, where the Worker would answer a 1101 page and Express its HTML one. The
  // handlers are awaited inside the try, or their rejections would pass it. A
  // body of the wrong length is not one of these: `uploadBlob` answers it 400.
  try {
    if (LIST.test(path)) {
      if (request.method !== "GET") return methodNotAllowed("GET", origin);
      return await listRooms(request, origin, deps);
    }
    const detail = DETAIL.exec(path);
    if (detail) {
      if (request.method === "GET") return await roomDetail(request, detail[1], origin, deps);
      if (request.method === "DELETE") return await deleteRoom(request, detail[1], origin, deps);
      return methodNotAllowed("GET, DELETE", origin);
    }
    const surface = SURFACE.exec(path);
    if (surface) {
      if (request.method !== "GET") return methodNotAllowed("GET", origin);
      return await readSurfaceRoute(request, surface[1], origin, deps);
    }
    const events = EVENTS.exec(path);
    if (events) {
      if (request.method !== "GET") return methodNotAllowed("GET", origin);
      return await readEventsRoute(request, url, events[1], origin, deps);
    }
    const item = SURFACE_ITEM.exec(path);
    if (item) {
      if (request.method !== "PUT" && request.method !== "DELETE") return methodNotAllowed("PUT, DELETE", origin);
      return await writeSurfaceRoute(request, url, item[1], item[2], origin, deps);
    }
    const upload = UPLOAD.exec(path);
    if (upload) {
      if (request.method !== "POST") return methodNotAllowed("POST", origin);
      return await uploadBlob(request, url, upload[1], origin, deps);
    }
    const download = DOWNLOAD.exec(path);
    if (download) {
      if (request.method !== "GET") return methodNotAllowed("GET", origin);
      return await downloadBlob(request, download[1], download[2], origin, deps);
    }
    return problem(404, "not_found", "no such route", origin);
  } catch (err) {
    console.error(`${request.method} ${path} failed:`, err);
    return problem(500, "internal", "the request failed on the server; nothing was placed", origin);
  }
}

/**
 * The upload door (D2, D3). Everything that can be refused from the headers is,
 * before a byte of the body is read: the caller, the CSRF check for a cookie,
 * the parameters, the length and the cap. Then the room's own guards through
 * `gateSeat` — the same gate the tool runs — the quota's courtesy check, and
 * only then the body: a head to decide the type (D6), the put, the charge, and
 * a delete if the charge refused.
 */
async function uploadBlob(
  request: Request,
  url: URL,
  sessionId: string,
  origin: string | undefined,
  deps: RoomRouteDeps,
): Promise<Response> {
  const who = await deps.caller(request);
  if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
  // Before anything that writes: gateSeat touches the caller's lastSeenAt, and a
  // forged request must not do even that. Bearer callers are exempt.
  const refusal = csrfRefusal(request, who.via, origin);
  if (refusal) return refusal;

  const memberId = url.searchParams.get("member_id") ?? "";
  if (!memberId) return problem(400, "invalid_request", "member_id is required", origin);
  const name = sanitizeName(url.searchParams.get("name"));
  if (name === null) {
    return problem(
      400, "invalid_request",
      `name is required: 1 to ${MAX_BLOB_NAME_CHARS} characters once path separators, control characters and format characters (joiners and the soft hyphen excepted) are stripped, and not made of joiners and soft hyphens alone`,
      origin,
    );
  }

  // From the header, before a byte is read: the cap is enforced here, and R2
  // streams a body in only against a declared length.
  const declared = request.headers.get("content-length");
  if (declared === null || !/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared))) {
    return problem(411, "length_required", "Content-Length is required, as a non-negative integer", origin);
  }
  const bytes = Number(declared);
  if (bytes > MAX_BLOB_BYTES) return problem(413, "too_large", `a blob is at most ${MAX_BLOB_BYTES} bytes`, origin);

  // A stranger's answer is the unknown room's answer: a handle that is not the
  // caller's is 404 here, before the gate, whose `forbidden` then means the seat
  // — it left, or lacks the verb — and is 403. An admin the room admits to read
  // (#65, D4) is told it holds no seat, as the surface write tells it: the same
  // fact is the same status at either door (review M1).
  const found = await deps.store.getSession(sessionId);
  if (!found || !findMember(found, memberId, who.identity)) {
    return adminWriteRefusal(found, who.identity, origin)
      ?? problem(404, "not_found", "no such room, or no member of yours in it", origin);
  }
  const gate = await gateSeat(deps.store, who.identity, sessionId, memberId, "write_surface");
  if (!gate.ok) return problem(STATUS[gate.code], gate.code, gate.reason, origin);
  const session = gate.value;

  // The courtesy check (D3), against the ceiling stamped on the room at creation
  // from the plan that made it (`blobBytesCeiling`, as `maxMembers` is): a
  // hopeless upload is refused before the bytes move. The charge below is the
  // bound, and reads the same record inside the room object.
  const ceiling = session.blobBytesCeiling;
  const used = blobBytesUsed(session);
  if (used + bytes > ceiling) return overQuota(used, ceiling, bytes, origin);

  // No body arrives as null; a zero-byte file is a file.
  const body = request.body ?? new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
  const { head, rest } = await readHead(body, SNIFF_BYTES);
  const type = storedType(request.headers.get("content-type"), head);
  const id = newBlobId();
  try {
    await deps.blobs.put(sessionId, id, rest, { bytes, type, name, by: memberId, at: Date.now() });
  } catch (err) {
    // The one class both stores throw for a body that is not its declared length (Task 1's
    // contract, run over R2 by Task 5): a client that died mid-body, or lied.
    if (err instanceof BlobLengthError) return problem(400, "invalid_request", err.message, origin);
    throw err;
  }

  // Put, then charge (D3). A refused charge — over quota, or a room that froze
  // or closed while the bytes were in flight — deletes the object; a delete that
  // fails leaves an orphan the prefix finds (#65). The other order was rejected
  // in the spec: a charge reserved for a body that never completes is a phantom
  // nothing can list, where an orphan costs storage and is findable.
  //
  // A charge that THROWS is not a refusal, and deletes nothing. It is ambiguous:
  // the room object may have committed the charge before the call failed, and
  // deleting the object then would leave a phantom charge nothing can list.
  // Keeping it leaves an orphan the prefix finds and #65 credits, and D3 puts an
  // ambiguous loss on the findable side. The log names the key for that sweep.
  const charge = await deps.store.chargeBlobBytes(sessionId, bytes).catch((err: unknown) => {
    console.error(`blob ${blobKey(sessionId, id)} kept after its charge threw:`, err);
    throw err;
  });
  if (!charge.ok) {
    await deps.blobs.delete(sessionId, id).catch((err: unknown) => {
      console.error(`orphaned blob ${blobKey(sessionId, id)} after a refused charge:`, err);
    });
    if (charge.reason === "over_quota") return overQuota(charge.used, ceiling, bytes, origin);
    if (charge.reason === "not_found") return problem(404, "not_found", "no such room", origin);
    return problem(409, charge.reason, `the room is ${charge.reason} and takes no upload`, origin);
  }
  return json(201, { blob_id: id, bytes, type, name }, origin);
}

/**
 * The download door (D4). Membership is the rule: an identity holding a handle
 * a `/ws` watch would admit — in the room, left of its own accord, or timed
 * out. A member a creator removed is refused, as `/ws` refuses it (#113): the
 * cut bounds what it reads, and a blob carries no cursor to compare with. A
 * closed room serves, as every read of a closed room does, and so does a
 * frozen one. An unknown room, a room the caller is no member of, an unknown
 * id and a malformed one are one answer, so a stranger learns nothing.
 *
 * The one other door is the org admin's (#65, D4), the one the detail and the
 * surface read open (`readsAsAdmin`): the admin of an org that sat in a *closed*
 * room, with no handle in it or none but removed ones, is served what a member
 * is, or the page would show a file item that it could not fetch. An open room
 * stays its members', and a removed member who is no such admin stays refused
 * after the close.
 */
async function downloadBlob(
  request: Request,
  sessionId: string,
  blobId: string,
  origin: string | undefined,
  deps: RoomRouteDeps,
): Promise<Response> {
  const who = await deps.caller(request);
  if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);

  const notFound = () => problem(404, "not_found", "no such blob", origin);
  const session = await deps.store.getSession(sessionId);
  const mine = session ? handlesOf(session, who.identity) : [];
  const asAdmin = session !== undefined && readsAsAdmin(session, who.identity, mine);
  if (!session || (mine.length === 0 && !asAdmin)) return notFound();
  if (mine.every(isRemovedMember) && !asAdmin) {
    return problem(403, "forbidden", "a member the room's creator removed cannot read its blobs", origin);
  }
  if (!isBlobId(blobId)) return notFound();

  const read = await deps.blobs.get(sessionId, blobId, request.headers.get("if-none-match") ?? undefined);
  if (read === null) return notFound();
  const headers: Record<string, string> = { ...DOWNLOAD_HEADERS, ...corsHeaders(origin), etag: read.etag };
  if ("unchanged" in read) return new Response(null, { status: 304, headers });

  // As stored only for an image on the allowlist, served inline. Everything
  // else — a PDF, markdown, an SVG, an HTML artifact (piece 4) — is an
  // octet-stream download under its label. Nothing from here is ever text/html.
  const image = isImageType(read.type);
  headers["content-type"] = image ? read.type : OCTET_STREAM;
  headers["content-length"] = String(read.bytes);
  if (!image) headers["content-disposition"] = attachmentDisposition(read.name);
  return new Response(read.body, { status: 200, headers });
}

/**
 * The list (D1): every room this person created or holds a handle in, from the
 * two registry listings, each resolved with one `getSession`. Membership is
 * checked on the record, not trusted from the index: a listing row names a room,
 * and only the roster says whether this person is in it.
 *
 * Newest first, by the creator's seat (a room has no creation stamp of its own),
 * among the rooms the indexes returned. Each listing is asked for
 * `MAX_ROOMS_LISTED` ids and neither orders by recency — the dev store walks
 * oldest first, the registry by session id — so for a person with more rooms
 * than that the page is shown a window the indexes chose, not their newest.
 * `truncated` says when that could be so: a listing came back full, which may
 * have been exactly full, or the rooms found exceeded the bound before the cut.
 * The newest 50 of a larger set is #49's summary index.
 *
 * A room this person was removed from (#113) is listed with its member count as
 * of the removal (`roomListEntry`), the number its detail would give.
 */
async function listRooms(request: Request, origin: string | undefined, deps: RoomRouteDeps): Promise<Response> {
  const who = await deps.caller(request);
  if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
  if (new URL(request.url).searchParams.get("as") === "admin") return listOrgRooms(who, origin, deps);
  const userId = who.identity.userId;
  const [created, joined] = await Promise.all([
    deps.store.sessionsCreatedBy(userId, MAX_ROOMS_LISTED),
    deps.store.sessionsJoinedBy(userId, MAX_ROOMS_LISTED),
  ]);
  const ids = [...new Set([...created, ...joined])];
  const found = await Promise.all(ids.map((id) => deps.store.getSession(id)));
  const mine = found
    .filter((s): s is StoredSession => s !== undefined && s.members.some((m) => m.userId === userId))
    .sort((a, b) => b.members[0].joinedAt - a.members[0].joinedAt);
  const truncated = created.length >= MAX_ROOMS_LISTED || joined.length >= MAX_ROOMS_LISTED || mine.length > MAX_ROOMS_LISTED;
  const rooms = mine
    .slice(0, MAX_ROOMS_LISTED)
    .map((s) => roomListEntry(s, userId, sessionStatus(s), cutAtFor(handlesOf(s, who.identity))));
  return json(200, { rooms, truncated, viewer: "member" }, origin);
}

/**
 * The closed rooms an org's admin may read (#65, D4, D5), for `GET /rooms?as=admin`. The caller is
 * checked for the audit log's three conditions before any room is looked at: an admin on another
 * plan, a member, or a caller with no org is told so with a 403, where the read of one room hides
 * itself with a 404, because this route has no room to hide. The identity's own org is the only one
 * it can ask for; the query names none.
 *
 * The org index names the rooms and the record decides, as the member list does: each is resolved
 * and kept only if it is closed and has a member in the org. The index holds the org's open rooms
 * and its closed ones in no promised order, so it is read for `JOINED_SCAN` ids, the bound the
 * monitor's joined history is read with, and not for the size of the answer, which would cut the
 * closed rooms of an org whose first rows are open ones (review I2). The list is the newest
 * `MAX_ROOMS_LISTED` closes of what that found, a room whose close was never dated last.
 * `truncated` is true when either bound was hit: the index came back full, which may have been
 * exactly full, or more were kept than the list holds. The price is the scan: up to `JOINED_SCAN`
 * `getSession` calls for one request, which is the cost #49's summary index removes.
 */
async function listOrgRooms(who: RoomCaller, origin: string | undefined, deps: RoomRouteDeps): Promise<Response> {
  const { identity } = who;
  if (!isOrgAdmin(identity)) {
    return problem(403, "forbidden", "the admin list requires the team plan, the admin role and an org", origin);
  }
  const ids = await deps.store.sessionsForOrg(identity.orgId, JOINED_SCAN);
  const found = await Promise.all(ids.map((id) => deps.store.getSession(id)));
  const kept = found
    .filter((s): s is StoredSession => s !== undefined && admitsAdmin(s, identity))
    .sort(closedAtDescending);
  const truncated = ids.length >= JOINED_SCAN || kept.length > MAX_ROOMS_LISTED;
  const rooms = kept
    .slice(0, MAX_ROOMS_LISTED)
    .map((s) => roomListEntry(s, identity.userId, sessionStatus(s)));
  return json(200, { rooms, truncated, viewer: "admin" }, origin);
}

/** Newest close first; a room closed before the close was dated has no time to sort by and goes last. */
const closedAtDescending = (a: StoredSession, b: StoredSession): number => {
  if (a.closedAt === b.closedAt) return 0;
  if (a.closedAt === null) return 1;
  if (b.closedAt === null) return -1;
  return b.closedAt - a.closedAt;
};

/**
 * The three conditions `bellman_audit` already asks of a reader of an org's log (#65, D4): the
 * team plan, which is what pays for the audit log, the admin role, and an org. A falsy org is no
 * org, as a falsy id names no stream anywhere else (ARCHITECTURE.md, runtime fact 4).
 */
const isOrgAdmin = (identity: Identity): identity is Identity & { orgId: string } =>
  identity.role === "admin" && entitlementsFor(identity).audit && Boolean(identity.orgId);

/**
 * Whether the room admits this caller as the admin of an org that sat in it (#65, D4): the audit
 * log's three conditions, plus the org tie on the roster. The roster keeps a member who left and
 * one a creator removed, so an org whose only member was removed still sat in the room, and its
 * admin reads all of it: the cut is a seat's, and an admin holds none. Whether the caller reads
 * the room as that admin or as a member is `readsAsAdmin`'s to say.
 *
 * Never an open room: that is its members', and the audit log is the admin's window into it
 * while it runs. A 404 for an open room says to an admin what it says to a stranger.
 */
const admitsAdmin = (session: StoredSession, identity: Identity): boolean =>
  session.closed &&
  isOrgAdmin(identity) &&
  session.members.some((m) => m.orgId === identity.orgId);

/**
 * Whether this person reads the room as an org admin and not as a member (#65, D4): the room admits
 * one (`admitsAdmin`), and the person holds no handle that is still a seat, which is to say they hold
 * none, or every one they hold was removed by the creator. A handle still in the room, or one that
 * left of its own accord, is a member's, and membership is tried first: a seat is the closer fact.
 *
 * A removal cuts what a seat reads, and the admin's read is not a seat's. Were it otherwise, one admin
 * of an org would read a closed room whole and another, whom the creator had removed, would read it to
 * a cut, though the org sat in the room and an admin is an admin. While the room runs `admitsAdmin` is
 * false, and the cut stands.
 *
 * The detail, the surface read and the download door all ask this one question, so a room cannot show
 * a person an item the same person cannot fetch.
 */
const readsAsAdmin = (session: StoredSession, identity: Identity, mine: readonly Member[]): boolean =>
  (mine.length === 0 || mine.every(isRemovedMember)) && admitsAdmin(session, identity);

/**
 * The refusal for a write from an admin the room admits to read (#65, D4, review M1): it knows the room is
 * there and holds no seat in it, which is a 403, where a stranger's answer is the 404 that hides the room.
 * One answer for every door that writes, the surface's and the upload's, so one fact is not two statuses.
 * Undefined for everyone else, who keeps the 404.
 */
const adminWriteRefusal = (
  found: StoredSession | undefined, identity: Identity, origin: string | undefined,
): Response | undefined =>
  found && handlesOf(found, identity).length === 0 && admitsAdmin(found, identity)
    ? problem(403, "forbidden", "an admin reads a closed room and holds no seat in it, so it cannot write to it", origin)
    : undefined;

/** What the page needs of each seat a person holds, to pick one to write with: the server refuses either way (D6). */
const myHandles = (session: StoredSession, mine: readonly Member[]) =>
  mine.map((m) => ({
    member_id: m.memberId,
    room_role: m.roomRole,
    verbs: verbsOfRole(session.manifest, m.roomRole),
    active: m.leftAt === null,
    removed: isRemovedMember(m),
  }));

/** The roster now: every member, with `presence` read off the clock and the sockets. */
const liveRoster = async (store: BellmanStore, session: StoredSession) => {
  const connected = await store.connectedMembers(session.id);
  return session.members.map((m) => publicMember(m, connected));
};

/**
 * The room as my seat sees it (D1). The preview is `roomPreview` for the role
 * of the handle still in the room — or, when none is, the first one held — so
 * what the page shows is what a joiner was shown. `my_handles` is what the
 * page needs to pick a seat for a write: the server refuses either way (D6).
 * A member who left and a closed room are served as any read is.
 *
 * A person every one of whose handles a creator removed (#113) is served too,
 * so the page can say so (`my_handles.removed`), but only the room as it stood
 * at the removal, as the surface route stops at the same cut: the roster is
 * `rosterAsOf` the latest of their removals, with no `presence`, and nothing
 * live is read for it. One handle still in the room, or one that left of its own
 * accord, keeps the live roster, as `bellman_sync` keeps the open feed.
 *
 * The exception is an admin of an org in a *closed* room (#65, D4): with nothing left in
 * the room but removed handles, or no handle at all, it is served the admin's read
 * (`readsAsAdmin`), the whole room with `viewer: "admin"`. `my_handles` still lists the
 * removed ones, so the page can say so, and an admin with no handle has none to list.
 *
 * Both envelopes carry `closed_at` and `purge_at` (`retentionOf`, review M8): when the room closed
 * and when it goes, so a member of a closed room can learn how long it has, and null where the
 * record has none.
 */
async function roomDetail(request: Request, sessionId: string, origin: string | undefined, deps: RoomRouteDeps): Promise<Response> {
  const who = await deps.caller(request);
  if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
  const session = await deps.store.getSession(sessionId);
  const mine = session ? handlesOf(session, who.identity) : [];
  // Membership first, then the admin's fallback (#65, D4): a seat is the closer fact, and a person
  // who sits in the room reads it as the member they are, cut and all. `readsAsAdmin` is false for
  // anyone with a handle that is still a seat.
  if (session && readsAsAdmin(session, who.identity, mine)) {
    return json(200, {
      id: session.id,
      session_status: sessionStatus(session),
      viewer: "admin",
      ...retentionOf(session),
      preview: roomPreview(session, null),
      members: await liveRoster(deps.store, session),
      my_handles: myHandles(session, mine),
    }, origin);
  }
  if (!session || mine.length === 0) {
    return problem(404, "not_found", "no such room, or no member of yours in it", origin);
  }
  const cutAt = cutAtFor(mine);
  const members = cutAt === undefined
    ? await liveRoster(deps.store, session)
    : rosterAsOf(session.members, cutAt);
  const viewer = mine.find((m) => m.leftAt === null) ?? mine[0];
  return json(200, {
    id: session.id,
    session_status: sessionStatus(session),
    viewer: "member",
    ...retentionOf(session),
    preview: roomPreview(session, viewer.roomRole),
    members,
    my_handles: myHandles(session, mine),
  }, origin);
}

/**
 * Delete on demand (#65, D6): the room's creator, or an admin the read above admits, asks for a
 * closed room to be purged now. 202, because this asks and the room's own alarm does it: the route
 * and a window that ran out are one code path, and no request holds a room open for as long as a
 * prefix takes to delete. Until the purge has run the room reads as the closed room it is.
 *
 * The CSRF check comes first for a cookie, as on every write. Then who may: a person with no part in
 * the room, and the same person against a room that is not there, get the one 404; a member who is
 * not the creator knows the room is there and gets a 403 that says who may. That comes before whether
 * the room has closed, so an open room tells a stranger nothing and a member nothing it does not know.
 * Closing stays what it is, the last member leaving or ninety days with nobody in the room, and a
 * delete never closes one: the store says "open" and this says 409.
 *
 * Asked again, it is answered again: the store keeps the first request and files who asked once, and
 * `purge_at` is the time the store holds, the first request's, and never the clock of the request that
 * is answering.
 */
async function deleteRoom(request: Request, sessionId: string, origin: string | undefined, deps: RoomRouteDeps): Promise<Response> {
  const who = await deps.caller(request);
  if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
  const refusal = csrfRefusal(request, who.via, origin);
  if (refusal) return refusal;

  const session = await deps.store.getSession(sessionId);
  const sits = session !== undefined && handlesOf(session, who.identity).length > 0;
  const admin = session !== undefined && admitsAdmin(session, who.identity);
  const notFound = () => problem(404, "not_found", "no such room, or no member of yours in it", origin);
  if (!session || (!sits && !admin)) return notFound();
  if (session.createdBy !== who.identity.userId && !admin) {
    return problem(403, "forbidden", "only the room's creator or an admin of an org in it may delete it", origin);
  }

  const scheduled = await deps.store.schedulePurge(sessionId, Date.now(), who.identity.userId);
  if (!scheduled.ok) {
    return scheduled.reason === "open"
      ? problem(409, "conflict", "a room is deleted after it closes", origin)
      : notFound();
  }
  return json(202, { id: sessionId, purge_at: new Date(scheduled.purgeAt).toISOString() }, origin);
}

/** The validator for a surface cursor: the number, quoted, as RFC 9110 wants a strong ETag. */
const surfaceTag = (cursor: number): string => `"${cursor}"`;

/**
 * Whether an If-None-Match header names `tag`. A list, a weak validator and `*`
 * all count; anything else is a miss, so a garbled header costs a body and
 * never a 500.
 */
const etagMatches = (header: string | null, tag: string): boolean =>
  header !== null && header.split(",").some((v) => {
    const t = v.trim().replace(/^W\//, "");
    return t === "*" || t === tag;
  });

/**
 * The surface read (D2): the same envelopes `bellman_sync surface: true`
 * returns, with the surface cursor as the ETag. A member still in the room is
 * answered from the record alone on a match — no row read, which is what makes
 * a four-second poll cheap. A removed member reads to its cut, and its cursor
 * is derived from the rows it is shown, as the tool derives it: the record's
 * number would claim a change the member never saw. The record and the rows are
 * two reads, so an eviction that commits between them leaves this one poll
 * uncut, and the next poll reads the committed cut; `bellman_sync` closes that
 * gap from the `member_evicted` event in its slice, and this route reads no events.
 *
 * An admin of an org in a *closed* room reads all of it (#65, D4), whether it holds no
 * handle or only removed ones (`readsAsAdmin`): the cut is a seat's, and it holds none.
 * Its ETag is the record's cursor, as a member still in the room has.
 */
/**
 * The room's log, for the panel's Log view: the envelopes `bellman_sync` returns, the caller's own
 * included, because a person reading the log reads the whole conversation. Without `?after`, the
 * newest MAX_EVENTS_READ; with it, the next MAX_EVENTS_READ past that cursor, so a poll that carries
 * the last cursor it saw reads only what is new. The caller rule is the surface read's: membership
 * first, a removed member to its cut, and #65's fallback for an org admin reading a closed room. A
 * read and nothing else: it moves no one's `lastSeenAt` and no bridge's cursor.
 */
async function readEventsRoute(request: Request, url: URL, sessionId: string, origin: string | undefined, deps: RoomRouteDeps): Promise<Response> {
  const who = await deps.caller(request);
  if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
  const session = await deps.store.getSession(sessionId);
  const mine = session ? handlesOf(session, who.identity) : [];
  const asAdmin = session !== undefined && readsAsAdmin(session, who.identity, mine);
  if (!session || (mine.length === 0 && !asAdmin)) {
    return problem(404, "not_found", "no such room, or no member of yours in it", origin);
  }
  const raw = url.searchParams.get("after");
  if (raw !== null && !/^\d{1,15}$/.test(raw)) {
    return problem(400, "invalid_request", "after is a cursor: a whole number, 0 or more", origin);
  }
  const after = raw === null ? undefined : Number(raw);
  const cut = asAdmin ? undefined : cutFor(mine);
  const within = (e: SessionEvent) => cut === undefined || e.cursor <= cut;
  let read: SessionEvent[];
  if (after !== undefined) {
    read = (await deps.store.eventsAfter(sessionId, after)).filter(within).slice(0, MAX_EVENTS_READ);
  } else if (cut === undefined) {
    read = await deps.store.recentEvents(sessionId, MAX_EVENTS_READ);
  } else {
    // A removed member's newest are the ones before its cut, which the room's tail may not reach.
    read = (await deps.store.eventsAfter(sessionId, Math.max(0, cut - MAX_EVENTS_READ))).filter(within).slice(-MAX_EVENTS_READ);
  }
  return json(200, {
    events: read.map((e) => untrusted({ memberId: e.fromMemberId, label: e.fromLabel }, publicEvent(e))),
    cursor: read.at(-1)?.cursor ?? after ?? 0,
  }, origin);
}

async function readSurfaceRoute(request: Request, sessionId: string, origin: string | undefined, deps: RoomRouteDeps): Promise<Response> {
  const who = await deps.caller(request);
  if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
  const session = await deps.store.getSession(sessionId);
  const mine = session ? handlesOf(session, who.identity) : [];
  // The admin's fallback (#65, D4): the whole surface of a closed room, with no cut. `cutFor` is not
  // asked of an empty list, which would read as every handle removed and cut the read to nothing, nor
  // of an admin whose every handle was removed: the cut is a seat's, and this read is not one.
  const asAdmin = session !== undefined && readsAsAdmin(session, who.identity, mine);
  if (!session || (mine.length === 0 && !asAdmin)) {
    return problem(404, "not_found", "no such room, or no member of yours in it", origin);
  }
  const ifNoneMatch = request.headers.get("if-none-match");
  // The page reads the ETag off a cross-origin response, which CORS hides
  // unless the header is exposed by name; on the 304 as on the 200.
  const exposed = { ...corsHeaders(origin), "access-control-expose-headers": "etag" };
  const notModified = (cursor: number) =>
    new Response(null, { status: 304, headers: { ...exposed, "cache-control": "no-store", etag: surfaceTag(cursor) } });

  const cut = asAdmin ? undefined : cutFor(mine);
  if (cut === undefined && etagMatches(ifNoneMatch, surfaceTag(surfaceCursor(session)))) {
    return notModified(surfaceCursor(session));
  }
  const block = await readSurface(deps.store, session, cut);
  if (cut !== undefined && etagMatches(ifNoneMatch, surfaceTag(block.cursor))) return notModified(block.cursor);
  const res = json(200, { surface_cursor: block.cursor, items: block.items }, origin);
  res.headers.set("etag", surfaceTag(block.cursor));
  res.headers.set("access-control-expose-headers", "etag");
  return res;
}

/**
 * The writes (D1, D6): a PUT whose body is the item, a DELETE that removes the
 * key. Both call `writeSurface`, the operation `bellman_send type: "surface"`
 * calls, so the verb guard, the blob head, the connector check, the audit row
 * and the event are one sequence for both transports; this maps the result to
 * a status and nothing else. The key is the path's; a body that names another
 * is refused rather than silently rekeyed, and a PUT body is the item, so one
 * that carries the removal marker is refused too: removing is the DELETE.
 */
async function writeSurfaceRoute(
  request: Request,
  url: URL,
  sessionId: string,
  rawKey: string,
  origin: string | undefined,
  deps: RoomRouteDeps,
): Promise<Response> {
  const who = await deps.caller(request);
  if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
  const refusal = csrfRefusal(request, who.via, origin);
  if (refusal) return refusal;

  // Decoded here and not where the path is matched, so a malformed escape is a
  // 400 to a caller who has signed in and the 401 every route gives to one who
  // has not.
  let key: string;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    return problem(400, "invalid_request", "the key is not valid percent-encoding", origin);
  }

  const memberId = url.searchParams.get("member_id") ?? "";
  if (!memberId) return problem(400, "invalid_request", "member_id is required", origin);

  let payload: unknown;
  if (request.method === "DELETE") {
    payload = { key, remove: true };
  } else {
    // A length that is present must be a digit string: `Number` would read
    // "garbage" as NaN and "1e3" as 1000 and pass both under the bound. An
    // absent one is a chunked body, which is allowed; the bound on those is a
    // follow-up, not this check.
    const length = request.headers.get("content-length");
    if (length !== null && !/^\d+$/.test(length)) {
      return problem(400, "invalid_request", "Content-Length must be a non-negative integer", origin);
    }
    if (Number(length ?? "0") > MAX_SURFACE_WRITE_BYTES) {
      return problem(413, "too_large", `a surface write is at most ${MAX_SURFACE_WRITE_BYTES} bytes of JSON`, origin);
    }
    const notObject = () => problem(400, "invalid_request", "the body must be a JSON object: the item, without its key or with the path's", origin);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return notObject();
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return notObject();
    if ("remove" in body) {
      return problem(400, "invalid_request", "a PUT body is the item; to remove an item, DELETE it", origin);
    }
    const given = (body as { key?: unknown }).key;
    if (given !== undefined && given !== key) {
      return problem(400, "invalid_request", `the body names key ${JSON.stringify(given)} but the path names "${key}"`, origin);
    }
    payload = { ...(body as Record<string, unknown>), key };
  }

  // A stranger's answer is the unknown room's answer, before the gate, as on
  // an upload: a handle that is not the caller's is 404, and the gate's
  // `forbidden` then means the seat itself.
  const found = await deps.store.getSession(sessionId);
  if (!found || !findMember(found, memberId, who.identity)) {
    // An admin admitted to read a closed room (#65, D4) knows it is there, and holds no seat in
    // it: that is a refusal, and not a room that is hidden. Everyone else keeps the 404.
    return adminWriteRefusal(found, who.identity, origin)
      ?? problem(404, "not_found", "no such room, or no member of yours in it", origin);
  }
  const out = await writeSurface(deps.store, deps.blobs, who.identity, sessionId, memberId, payload);
  if (!out.ok) return problem(STATUS[out.code], out.code, out.reason, origin);
  return json(200, { cursor: out.value.cursor, room_members: out.value.roomMembers }, origin);
}
