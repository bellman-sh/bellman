/**
 * Home memory operations (ADR 0047): what `bellman_memory` does, over the store. The caller's account owns the
 * memory; a seat is named only to `share`. Peers never reach a home room: its id is derived from the account and
 * `getSession` refuses it, so nothing here consults a room.
 */
import { ENTITLEMENTS } from "./auth.js";
import { namespaceOf, normalizePath } from "./fs-path.js";
import { HOME_MEMBER_ID, homeRoomId, homeSession } from "./home.js";
import { findMember, gateFsRead, readFsFor, refuse, succeed, waitRefusal, writeFs, type RoomResult } from "./rooms.js";
import { SEND_LIMIT, STRANGER_KEY_PREFIX } from "./send-limit.js";
import type { BellmanStore, FsPage, FsWrite } from "./store.js";
import type { AgentInfo, FsRow, HomeSettings, Identity, LookupRow, LookupSource } from "./types.js";

const NO_NOTE = "no such note.";
const PAUSED = "paused: your human paused home memory in the dash; forget still works.";

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
export async function setMemorySettings(store: BellmanStore, actor: Identity, patch: Partial<HomeSettings>): Promise<HomeSettings> {
  const id = homeRoomId(actor.userId);
  const next = { ...(await store.readHomeSettings(id)), ...patch };
  await store.writeHomeSettings(id, next);
  return next;
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
