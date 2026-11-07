/**
 * Home memory operations (ADR 0047): what `bellman_memory` does, over the store. The caller's account owns the
 * memory; a seat is named only to `share`. Peers never reach a home room: its id is derived from the account and
 * `getSession` refuses it, so nothing here consults a room.
 */
import { ENTITLEMENTS } from "./auth.js";
import { namespaceOf, normalizePath } from "./fs-path.js";
import { HOME_MEMBER_ID, homeRoomId, homeSession } from "./home.js";
import { renderExport, type ExportRoom } from "./memory-export.js";
import { findMember, gateFsRead, readFsFor, refuse, roomIdsOf, succeed, waitRefusal, writeFs, type RoomFailure, type RoomResult } from "./rooms.js";
import { SEND_LIMIT, STRANGER_KEY_PREFIX } from "./send-limit.js";
import type { BellmanStore, FsPage, FsWrite } from "./storage/store.js";
import { isActiveMember } from "./members.js";
import type { AgentInfo, FsRow, HomeSettings, Identity, LookupRow, LookupSource } from "./types.js";

const NO_NOTE = "no such note.";
const PAUSED = "paused: your human paused home memory in the dash; forget and unshare still work.";

/** A home path: normalized, and never under `/apps/`, which a home room cannot run. Every other path is the account's. */
function homePath(raw: string): RoomResult<string> {
  const norm = normalizePath(raw);
  if (!norm.ok) return refuse("invalid", `invalid path: ${norm.reason}.`);
  if (namespaceOf(norm.path).ns === "app") return refuse("forbidden", "/apps/ is reserved for room apps; a home room runs none.");
  return succeed(norm.path);
}

/**
 * One home write: `remember` (write, or over `baseRev`) or `forget` (delete at `baseRev`). Counted as a send against
 * the account's own bucket, apart from every seat's (decision 4); the ceiling is the caller's plan's `homeMemoryBytes`
 * read now (decision 12).
 */
export async function writeHome(
  store: BellmanStore,
  actor: Identity,
  input: { path: string; write: FsWrite["write"]; idempotencyKey?: string },
): Promise<RoomResult<{ path: string; rev: number; replayed: boolean }>> {
  const path = homePath(input.path);
  if (!path.ok) return path;
  const id = homeRoomId(actor.userId);
  const now = Date.now();
  const admission = await store.admitSend(id, `${STRANGER_KEY_PREFIX}${actor.userId}`, SEND_LIMIT, now);
  if (!admission.ok) return waitRefusal(`this account has used its ${SEND_LIMIT} home writes for the minute, and nothing was written`, admission.retryAfterMs);
  const w: FsWrite = { path: path.value, write: input.write, memberId: HOME_MEMBER_ID, userId: actor.userId, label: actor.label, key: input.idempotencyKey ?? null };
  const out = await store.writeHome(id, homeSession(actor, now), w, ENTITLEMENTS[actor.plan].homeMemoryBytes);
  switch (out.outcome) {
    case "ok": return succeed({ path: out.path, rev: out.rev, replayed: false });
    case "replayed": return succeed({ path: out.path, rev: out.rev, replayed: true });
    case "conflict":
      return refuse("conflict", `idempotency_key "${input.idempotencyKey}" was already used for a different write. Pick a new key for new content.`);
    case "stale":
      return refuse("stale", `stale: the note is at revision ${out.currentRev}. Re-read it and write again with base_rev ${out.currentRev}.`, {
        state: { current_rev: out.currentRev, content: out.content, writer: out.writer },
      });
    case "too_large": return refuse("too_large", "too_large: a note holds at most 64 KiB.");
    case "over_quota":
      return refuse("over_quota", `over_quota: your home memory uses ${out.used} of ${out.ceiling} bytes on the ${actor.plan} plan. Forget notes to free space.`, {
        state: { used: out.used, ceiling: out.ceiling },
      });
    case "forbidden": return refuse("forbidden", "/apps/ is reserved for room apps; a home room runs none.");
    case "invalid": return refuse("invalid", `invalid: ${out.detail}.`);
    // A home room is never frozen or closed, and the write creates it: these cannot be answered, and are refused all the same.
    case "paused": return refuse("paused", PAUSED);
    case "frozen": case "closed": case "not_found": return refuse("not_found", NO_NOTE);
  }
}

/** One home note, current, read and logged as `source` (decision 13); refused while paused. */
export async function readHome(store: BellmanStore, actor: Identity, raw: string, source: LookupSource): Promise<RoomResult<FsRow>> {
  const path = homePath(raw);
  if (!path.ok) return path;
  const out = await store.readHomeLogged(homeRoomId(actor.userId), path.value, source);
  if (out.paused) return refuse("paused", PAUSED);
  return out.file === null ? refuse("not_found", NO_NOTE) : succeed(out.file);
}

/** The account's notes under `prefix`, newest first, a page after `cursor`, logged as `source`; refused while paused. */
export async function listHome(
  store: BellmanStore, actor: Identity, prefix: string, cursor: string | undefined, source: LookupSource,
): Promise<RoomResult<FsPage>> {
  const path = homePath(prefix);
  if (!path.ok) return path.code === "forbidden" ? succeed({ entries: [], next: null }) : path;
  const out = await store.listHomeLogged(homeRoomId(actor.userId), path.value, cursor, source);
  return out.paused ? refuse("paused", PAUSED) : succeed(out.page);
}

/**
 * The account's home-note paths for arrival (decision 9, #528), newest first: the first page of its home room, in a
 * call of its own after the seat commits, logged as `source` (decision 13). `paused` says the account holds the notes
 * back (nothing read, nothing logged). A failed read is logged and hands back none; it never fails the join.
 */
export async function homeTitles(store: BellmanStore, actor: Identity, source: LookupSource): Promise<{ titles: string[]; paused: boolean }> {
  try {
    const out = await store.listHomeLogged(homeRoomId(actor.userId), "/", undefined, source);
    return out.paused ? { titles: [], paused: true } : { titles: out.page.entries.map((e) => e.path), paused: false };
  } catch (error) {
    console.error("recall on arrival: the home room could not be read:", error);
    return { titles: [], paused: false };
  }
}

/** The account's memory settings (#530): what `GET /me/memory` returns, and what the bridge reads for the Stop hook. */
export const readMemorySettings = (store: BellmanStore, actor: Identity): Promise<HomeSettings> =>
  store.readHomeSettings(homeRoomId(actor.userId));

/** Settings patched, from a dash session only (the route checks); the settings as they now are. */
// ponytail: read-merge-write in two RPCs, so two tabs racing can drop a field; a DO-side patch method if it bites.
export async function setMemorySettings(store: BellmanStore, actor: Identity, patch: Partial<HomeSettings>): Promise<HomeSettings> {
  const id = homeRoomId(actor.userId);
  const next = { ...(await store.readHomeSettings(id)), ...patch };
  await store.writeHomeSettings(id, next);
  return next;
}

/**
 * Hard delete (ADR 0047 decision 14): the account's home room emptied, settings and lookup log included. Never paused.
 * Capture ends off; a pause is written back, so deleting cannot let agents read again. An unpaused account keeps no `hs` row.
 */
export async function deleteMemory(store: BellmanStore, actor: Identity): Promise<void> {
  const id = homeRoomId(actor.userId);
  const { paused } = await store.readHomeSettings(id);
  await store.purgeHome(id);
  if (paused) await store.writeHomeSettings(id, { capture: false, paused: true });
}

/** One note deleted from the dash, as `forget` does, and scrubbed from the lookup log (decision 14). Never paused. */
export async function forgetNote(store: BellmanStore, actor: Identity, raw: string): Promise<RoomResult<null>> {
  const path = homePath(raw);
  if (!path.ok) return path;
  return (await store.forgetHomeNote(homeRoomId(actor.userId), path.value)) ? succeed(null) : refuse("not_found", NO_NOTE);
}

/** Every live file under `prefix` in `roomId`, paged to the end, each read whole. */
async function readAll(store: BellmanStore, roomId: string, prefix: string): Promise<FsRow[]> {
  const rows: FsRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listFs(roomId, prefix, { cursor });
    for (const e of page.entries) {
      const file = await store.readFs(roomId, e.path);
      if (file) rows.push(file);
    }
    cursor = page.next ?? undefined;
  } while (cursor !== undefined);
  return rows;
}

/**
 * The account's memory as one Markdown document (ADR 0047 decision 14): its home notes, and its own notes
 * (`/members/<memory id>/`) in each open room it holds an active seat in. Reads the store directly, so the lookup
 * log is untouched and a paused account can still take its notes out.
 */
// ponytail: every room from roomIdsOf (rooms past JOINED_SCAN are left out), about four RPCs per room plus one per
// note, unbatched; a heavy account can meet the Workers subrequest cap. Page the export if one does.
export async function exportMemory(store: BellmanStore, actor: Identity): Promise<string> {
  const home = await readAll(store, homeRoomId(actor.userId), "/");
  const rooms: ExportRoom[] = [];
  for (const id of await roomIdsOf(store, actor)) {
    const session = await store.getSession(id);
    if (!session || session.closed || !session.members.some((m) => m.userId === actor.userId && isActiveMember(m))) continue;
    const memoryId = await store.memoryIdOf(id, actor.userId);
    if (memoryId === null) continue;
    const notes = await readAll(store, id, `/members/${memoryId}`);
    if (notes.length > 0) rooms.push({ sessionId: id, room: session.manifest.room, notes });
  }
  return renderExport({ label: actor.label, at: Date.now(), home, rooms });
}

/**
 * Delete the account's own notes (`/members/<memory id>/`) in one room (ADR 0047 decision 14), one room file delete
 * per note through the seat's own write: its verb, send count and quota apply, and each leaves its `fs` event and
 * audit entry. Stops at the first refusal and reports it, with `retry_after` (seconds) when it is `rate_limited`; what
 * was deleted before it stays deleted.
 */
export async function deleteRoomNotes(
  store: BellmanStore, actor: Identity, sessionId: string,
): Promise<RoomResult<{ deleted: string[]; refused: { path: string; code: RoomFailure; retry_after?: number } | null }>> {
  const session = await store.getSession(sessionId);
  const seat = session?.members.find((m) => m.userId === actor.userId && isActiveMember(m));
  if (!session || !seat) return refuse("not_found", "no such room, or no seat of yours in it.");
  const memoryId = await store.memoryIdOf(sessionId, actor.userId);
  if (memoryId === null) return succeed({ deleted: [], refused: null });
  const rows: { path: string; rev: number }[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listFs(sessionId, `/members/${memoryId}`, { cursor });
    rows.push(...page.entries.filter((e) => !e.deleted));
    cursor = page.next ?? undefined;
  } while (cursor !== undefined);
  const deleted: string[] = [];
  for (const row of rows) {
    const out = await writeFs(store, actor, sessionId, seat.memberId, { path: row.path, write: { op: "delete", baseRev: row.rev } });
    if (!out.ok) {
      const wait = out.code === "rate_limited" && out.retryAfter !== undefined ? { retry_after: out.retryAfter } : {};
      return succeed({ deleted, refused: { path: row.path, code: out.code, ...wait } });
    }
    deleted.push(row.path);
  }
  return succeed({ deleted, refused: null });
}

/** One lookup as the dash shows it (ADR 0047 decision 13): the row, with its room named. */
export interface LookupShown {
  at: number;
  op: LookupRow["op"];
  /** The room as the account sees it; null for a bare recall, and `{ session_id, room: null }` for a room since purged. */
  room: { session_id: string; room: string | null } | null;
  member_id: string | null;
  agent: AgentInfo | null;
  query: string | null;
  paths: string[];
}

/** The account's lookup log, newest first, each row's room named by one `getSession` per distinct room in the page. */
export async function memoryLookups(store: BellmanStore, actor: Identity): Promise<LookupShown[]> {
  const rows = await store.homeLookups(homeRoomId(actor.userId));
  const ids = [...new Set(rows.flatMap((r) => (r.sessionId === null ? [] : [r.sessionId])))];
  const names = new Map(await Promise.all(ids.map(async (id) => [id, (await store.getSession(id))?.manifest.room ?? null] as const)));
  return rows.map((r) => ({
    at: r.at, op: r.op,
    room: r.sessionId === null ? null : { session_id: r.sessionId, room: names.get(r.sessionId) ?? null },
    member_id: r.memberId, agent: r.agent, query: r.query, paths: r.paths,
  }));
}

/**
 * `unshare`: turn off the caller's notes sharing in a room, from a seat of the caller's (ADR 0047 decision 7: any of
 * the account's seats can turn it off; only a dash session turns it on, through `PUT /rooms/:id/notes-sharing`).
 */
export async function unshareNotes(store: BellmanStore, actor: Identity, sessionId: string, memberId: string): Promise<RoomResult<{ shared: false }>> {
  const session = await store.getSession(sessionId);
  if (!session) return refuse("not_found", "session not found.");
  const me = await findMember(store, session, memberId, actor);
  if (!me) return refuse("forbidden", "member_id is not yours.");
  await store.setNotesSharing(sessionId, actor.userId, false);
  return succeed({ shared: false });
}

/**
 * `share` to notes: copy a home note to `/members/me/<path>` in a room, from a seat of the caller's, as a new file or
 * over its current revision. A room file write, with the room's verb, send count and memory quota.
 */
export async function shareHome(
  store: BellmanStore, actor: Identity, sessionId: string, memberId: string, raw: string,
): Promise<RoomResult<{ path: string; rev: number }>> {
  // The seat is gated before the read is logged under it, so no stranger's seat or agent lands in the log.
  const seat = await gateFsRead(store, actor, sessionId, memberId);
  if (!seat.ok) return seat;
  const agent = (await store.getBriefs(sessionId, [memberId]))[memberId]?.agent ?? null;
  const note = await readHome(store, actor, raw, { op: "share", sessionId, memberId, agent, query: raw });
  if (!note.ok) return note;
  const target = `/members/me${note.value.path}`;
  const current = await readFsFor(store, actor, sessionId, memberId, target);
  if (!current.ok && current.code !== "not_found") return current;
  const write = { op: "write" as const, content: note.value.content, baseRev: current.ok ? current.value.rev : undefined };
  const out = await writeFs(store, actor, sessionId, memberId, { path: target, write });
  return out.ok ? succeed({ path: out.value.path, rev: out.value.rev }) : out;
}
