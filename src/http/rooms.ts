/**
 * The HTTP room routes (#183, #184; #49 is where the rest go): the list, the
 * detail, the surface read and its writes, and the two doors a room's bytes
 * pass through. What the control panel calls, and what any bearer caller may.
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
import {
  BlobLengthError, MAX_BLOB_BYTES, MAX_BLOB_NAME_CHARS, OCTET_STREAM, SNIFF_BYTES,
  attachmentDisposition, blobBytesUsed, blobKey, isBlobId, isImageType, newBlobId, readHead,
  sanitizeName, storedType, type BlobStore,
} from "../blobs.js";
import { allowedOrigin, corsHeaders, csrfRefusal, preflightResponse } from "../oauth/browser.js";
import { publicMember, roomPreview, roomListEntry, rosterAsOf } from "../projections.js";
import { verbsOfRole } from "../roles.js";
import { findMember, gateSeat, readSurface, sessionStatus, writeSurface, type RoomFailure } from "../rooms.js";
import { isRemovedMember, type BellmanStore } from "../store.js";
import type { StoredSession } from "../stored-session.js";
import { surfaceCursor } from "../surface.js";
import type { Identity, Member } from "../types.js";

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

const LIST = /^\/rooms$/;
const DETAIL = /^\/rooms\/([^/]+)$/;
const SURFACE = /^\/rooms\/([^/]+)\/surface$/;
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
      if (request.method !== "GET") return methodNotAllowed("GET", origin);
      return await roomDetail(request, detail[1], origin, deps);
    }
    const surface = SURFACE.exec(path);
    if (surface) {
      if (request.method !== "GET") return methodNotAllowed("GET", origin);
      return await readSurfaceRoute(request, surface[1], origin, deps);
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
  // — it left, or lacks the verb — and is 403.
  const found = await deps.store.getSession(sessionId);
  if (!found || !findMember(found, memberId, who.identity)) {
    return problem(404, "not_found", "no such room, or no member of yours in it", origin);
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
  const mine = session?.members.filter((m) => m.userId === who.identity.userId) ?? [];
  if (!session || mine.length === 0) return notFound();
  if (mine.every(isRemovedMember)) {
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
  return json(200, { rooms, truncated }, origin);
}

/** Every handle this person holds in the room, in roster order. Empty means a stranger. */
const handlesOf = (session: StoredSession, identity: Identity): Member[] =>
  session.members.filter((m) => m.userId === identity.userId);

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
 */
async function roomDetail(request: Request, sessionId: string, origin: string | undefined, deps: RoomRouteDeps): Promise<Response> {
  const who = await deps.caller(request);
  if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
  const session = await deps.store.getSession(sessionId);
  const mine = session ? handlesOf(session, who.identity) : [];
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
    expires_at: new Date(session.expiresAt).toISOString(),
    preview: roomPreview(session, viewer.roomRole),
    members,
    my_handles: mine.map((m) => ({
      member_id: m.memberId,
      room_role: m.roomRole,
      verbs: verbsOfRole(session.manifest, m.roomRole),
      active: m.leftAt === null,
      removed: isRemovedMember(m),
    })),
  }, origin);
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
 * Where a person's reading stops (#113), if anywhere. Only when every handle
 * they hold was removed: a handle still in the room, or one that left of its
 * own accord, keeps the open feed, as it does on `bellman_sync`. With several
 * removed handles, the latest cut: the most this person was ever shown.
 */
const cutFor = (handles: readonly Member[]): number | undefined =>
  handles.every(isRemovedMember)
    ? Math.max(...handles.map((m) => m.removedAtCursor ?? 0))
    : undefined;

/**
 * The same cut as a moment, for what a cursor cannot bound: the roster and the
 * member count carry times and no cursors. `markRemoved` sets `leftAt` in the
 * write that sets the cut, so the latest removal's `leftAt` is when this person's
 * reading stopped. Undefined exactly when `cutFor` is, since it asks `cutFor`.
 */
const cutAtFor = (handles: readonly Member[]): number | undefined =>
  cutFor(handles) === undefined ? undefined : Math.max(...handles.map((m) => m.leftAt ?? 0));

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
 */
async function readSurfaceRoute(request: Request, sessionId: string, origin: string | undefined, deps: RoomRouteDeps): Promise<Response> {
  const who = await deps.caller(request);
  if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
  const session = await deps.store.getSession(sessionId);
  const mine = session ? handlesOf(session, who.identity) : [];
  if (!session || mine.length === 0) {
    return problem(404, "not_found", "no such room, or no member of yours in it", origin);
  }
  const ifNoneMatch = request.headers.get("if-none-match");
  // The page reads the ETag off a cross-origin response, which CORS hides
  // unless the header is exposed by name; on the 304 as on the 200.
  const exposed = { ...corsHeaders(origin), "access-control-expose-headers": "etag" };
  const notModified = (cursor: number) =>
    new Response(null, { status: 304, headers: { ...exposed, "cache-control": "no-store", etag: surfaceTag(cursor) } });

  const cut = cutFor(mine);
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
    return problem(404, "not_found", "no such room, or no member of yours in it", origin);
  }
  const out = await writeSurface(deps.store, deps.blobs, who.identity, sessionId, memberId, payload);
  if (!out.ok) return problem(STATUS[out.code], out.code, out.reason, origin);
  return json(200, { cursor: out.value.cursor, room_members: out.value.roomMembers }, origin);
}
