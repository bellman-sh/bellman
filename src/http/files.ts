/**
 * Room file routes for the dash (ADR 0046). Reads take any seat of the caller's still in the room, bearer or
 * cookie; writes are a person's, from a signed-in dash session, and pass the Origin check, as the governed config
 * routes do. Every write runs `writeFs`, so the memory rule, the namespaces and the gates are the tool's.
 *
 *   GET    /rooms/:id/files?member_id=[&prefix=][&cursor=]     a page of live files at prefix (default /)
 *   GET    /rooms/:id/files?member_id=&query=[&cursor=]        files whose path matches every word
 *   GET    /rooms/:id/files/<path>?member_id=[&rev=]           one file
 *   GET    /rooms/:id/files/<path>?member_id=&history=1[&from=&to=]   kept revisions, newest first, no content;
 *                                                                     with from and to, their diff
 *   PUT    /rooms/:id/files/<path>?member_id=  { content, base_rev? }   a write; no base_rev creates
 *   DELETE /rooms/:id/files/<path>?member_id=&base_rev=        a delete
 *
 * Runtime-free, as rooms.ts: web Request in, Response out.
 */
import { csrfRefusal } from "../oauth/browser.js";
import { findFsFor, findMember, fsHistoryFor, listFsFor, readFsFor, writeFs, type RoomResult } from "../room/rooms.js";
import { fsEntryView, fsFileView } from "../projections.js";
import { STATUS, adminWriteRefusal, json, lengthRefusal, methodNotAllowed, problem, type RoomRouteDeps } from "./rooms.js";

export const FILES = /^\/rooms\/([^/]+)\/files(\/.*)?$/;

// ponytail: 70,000 bytes, not tuned: a 64 KiB file and the JSON around it, as MAX_CONFIG_WRITE_BYTES.
export const MAX_FILE_WRITE_BYTES = 70_000;

const NOT_FOUND = "no such room, or no member of yours in it";

/**
 * A refusal as a response: its status, its code, and a stale or quota refusal's state beside them. A stale
 * refusal's writer is the store's `{ memberId, label }`; the wire is snake_case, as `fsEntryView`'s.
 */
const refused = (r: Extract<RoomResult<unknown>, { ok: false }>, origin: string | undefined) => {
  const state = { ...r.state };
  const writer = state.writer as { memberId: string; label: string } | null | undefined;
  if (writer) state.writer = { member_id: writer.memberId, label: writer.label };
  return json(STATUS[r.code], { error: r.code, error_description: r.reason, ...state }, origin);
};

/** A revision number from the query string, undefined when absent, null when not one. */
function revision(url: URL, name: string): number | undefined | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** Dispatch one file route, or undefined when `path` is not one. */
export async function fileRoutes(request: Request, url: URL, path: string, origin: string | undefined, deps: RoomRouteDeps): Promise<Response | undefined> {
  const m = FILES.exec(path);
  if (!m) return undefined;
  const sessionId = m[1];
  let filePath: string | null = null;
  if (m[2] !== undefined && m[2] !== "/") {
    try { filePath = decodeURIComponent(m[2]); } catch { return problem(400, "invalid_request", "the file path is not valid percent-encoding", origin); }
  }
  if (filePath === null) {
    if (request.method !== "GET") return methodNotAllowed("GET", origin);
    return list(request, url, sessionId, origin, deps);
  }
  if (request.method === "GET") return read(request, url, sessionId, filePath, origin, deps);
  if (request.method === "PUT" || request.method === "DELETE") return write(request, url, sessionId, filePath, origin, deps);
  return methodNotAllowed("GET, PUT, DELETE", origin);
}

/** The caller and its `member_id`, or the refusal: shared by the reads. */
async function reader(request: Request, url: URL, origin: string | undefined, deps: RoomRouteDeps) {
  const who = await deps.caller(request);
  if (!who) return { error: problem(401, "unauthorized", "sign in, or send a bearer token", origin) };
  const memberId = url.searchParams.get("member_id") ?? "";
  if (!memberId) return { error: problem(400, "invalid_request", "member_id is required", origin) };
  return { who, memberId };
}

async function list(request: Request, url: URL, sessionId: string, origin: string | undefined, deps: RoomRouteDeps): Promise<Response> {
  const r = await reader(request, url, origin, deps);
  if ("error" in r) return r.error!;
  const query = url.searchParams.get("query"), cursor = url.searchParams.get("cursor") ?? undefined;
  const out = query === null
    ? await listFsFor(deps.store, r.who.identity, sessionId, r.memberId, url.searchParams.get("prefix") ?? "/", cursor)
    : await findFsFor(deps.store, r.who.identity, sessionId, r.memberId, query, cursor);
  if (!out.ok) return out.code === "forbidden" ? problem(404, "not_found", NOT_FOUND, origin) : refused(out, origin);
  return json(200, { entries: out.value.entries.map(fsEntryView), next: out.value.next }, origin);
}

async function read(request: Request, url: URL, sessionId: string, filePath: string, origin: string | undefined, deps: RoomRouteDeps): Promise<Response> {
  const r = await reader(request, url, origin, deps);
  if ("error" in r) return r.error!;
  if (url.searchParams.has("history")) return history(url, r, sessionId, filePath, origin, deps);
  const rev = revision(url, "rev");
  if (rev === null) return problem(400, "invalid_request", "rev is a revision number", origin);
  const out = await readFsFor(deps.store, r.who.identity, sessionId, r.memberId, filePath, rev);
  if (!out.ok) return out.code === "forbidden" ? problem(404, "not_found", NOT_FOUND, origin) : refused(out, origin);
  return json(200, fsFileView(out.value), origin);
}

/** The kept revisions without content, and with `from` and `to` the diff between two of them. */
async function history(
  url: URL, r: { who: { identity: Parameters<typeof fsHistoryFor>[1] }; memberId: string }, sessionId: string, filePath: string,
  origin: string | undefined, deps: RoomRouteDeps,
): Promise<Response> {
  const from = revision(url, "from"), to = revision(url, "to");
  if (from === null || to === null || (from === undefined) !== (to === undefined)) {
    return problem(400, "invalid_request", "from and to are revision numbers, both or neither", origin);
  }
  const diff = from === undefined ? undefined : { from, to: to! };
  const out = await fsHistoryFor(deps.store, r.who.identity, sessionId, r.memberId, filePath, diff);
  if (!out.ok) return out.code === "forbidden" ? problem(404, "not_found", NOT_FOUND, origin) : refused(out, origin);
  return json(200, {
    revisions: out.value.revisions.map(fsEntryView),
    ...(diff === undefined ? {} : { diff: out.value.diff ?? null }),
  }, origin);
}

/** A write or a delete: a dash session, the Origin check, the caller's own seat (404), `adminWriteRefusal`, then `writeFs`. */
async function write(request: Request, url: URL, sessionId: string, filePath: string, origin: string | undefined, deps: RoomRouteDeps): Promise<Response> {
  const who = await deps.caller(request);
  if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
  if (who.via !== "cookie") {
    return problem(403, "dash_session_required", "room files are written here by a person signed in to the dash; an agent writes with bellman_fs", origin);
  }
  const csrf = csrfRefusal(request, who.via, origin);
  if (csrf) return csrf;
  const memberId = url.searchParams.get("member_id") ?? "";
  if (!memberId) return problem(400, "invalid_request", "member_id is required", origin);
  const found = await deps.store.getSession(sessionId);
  const seat = found ? await findMember(deps.store, found, memberId, who.identity) : undefined;
  if (!found || !seat) {
    return await adminWriteRefusal(deps.store, found, who.identity, origin) ?? problem(404, "not_found", NOT_FOUND, origin);
  }

  let input: Parameters<typeof writeFs>[4];
  if (request.method === "DELETE") {
    const raw = url.searchParams.get("base_rev");
    const baseRev = raw === null ? NaN : Number(raw);
    if (!Number.isSafeInteger(baseRev) || baseRev < 1) return problem(400, "invalid_request", "base_rev is the revision you read", origin);
    input = { path: filePath, write: { op: "delete", baseRev } };
  } else {
    const tooLong = lengthRefusal(request, MAX_FILE_WRITE_BYTES, "a file write", origin);
    if (tooLong) return tooLong;
    const body: unknown = await request.json().catch(() => null);
    const keys = body !== null && typeof body === "object" && !Array.isArray(body) ? Object.keys(body).sort().join() : "";
    const req = body as { content?: unknown; base_rev?: unknown };
    if ((keys !== "content" && keys !== "base_rev,content") || typeof req.content !== "string") {
      return problem(400, "invalid_request", 'send {"content": "...", "base_rev": n}; leave base_rev out to create', origin);
    }
    if (req.base_rev !== undefined && (!Number.isSafeInteger(req.base_rev) || (req.base_rev as number) < 0)) {
      return problem(400, "invalid_request", "base_rev is the revision you read", origin);
    }
    input = { path: filePath, write: { op: "write", content: req.content, baseRev: req.base_rev as number | undefined } };
  }
  const out = await writeFs(deps.store, who.identity, sessionId, memberId, input);
  if (!out.ok) return refused(out, origin);
  return json(200, { path: out.value.path, rev: out.value.rev }, origin);
}
