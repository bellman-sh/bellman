/**
 * The HTTP room routes (#183; #49 is where the rest go): the two doors a
 * room's bytes pass through — `POST /rooms/:id/blobs` and
 * `GET /rooms/:id/blobs/:blobId` — and where piece 3's room routes go next.
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
import { findMember, gateSeat, type RoomFailure } from "../rooms.js";
import { isRemovedMember, type BellmanStore } from "../store.js";
import type { Identity } from "../types.js";

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
 * The room routes. `undefined` for a path outside `/rooms/`, so the Worker
 * carries on to the next module; everything under the prefix is answered here,
 * a path this module does not know included.
 */
export async function roomRoutes(request: Request, deps: RoomRouteDeps): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (!path.startsWith("/rooms/")) return undefined;
  const origin = allowedOrigin(request, deps.panelOrigins);
  // The panel's upload sets a Content-Type that is not a simple one, so the
  // browser asks first. 204 either way: a stranger's preflight carries no grant.
  if (request.method === "OPTIONS") return preflightResponse(origin);

  const upload = UPLOAD.exec(path);
  if (upload) {
    if (request.method !== "POST") return methodNotAllowed("POST", origin);
    return uploadBlob(request, url, upload[1], origin, deps);
  }
  const download = DOWNLOAD.exec(path);
  if (download) {
    if (request.method !== "GET") return methodNotAllowed("GET", origin);
    return downloadBlob(request, download[1], download[2], origin, deps);
  }
  return problem(404, "not_found", "no such route", origin);
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
      `name is required: 1 to ${MAX_BLOB_NAME_CHARS} characters once path separators and control characters are stripped`,
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
  const charge = await deps.store.chargeBlobBytes(sessionId, bytes);
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
