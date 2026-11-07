/**
 * Room files (ADR 0046): the pure planning of each write op, the byte charge, and the history diff. Runtime-free, and
 * called by both stores inside the write's own transaction, so the stale check and the charge read the row they
 * write (as `decideConfigWrite` is shared).
 */
import { createHash } from "node:crypto";
import { createPatch } from "diff";
import { newBlobId } from "./blobs.js";
import type { FsRow, Session } from "../types.js";
import { OWN_MEMORY, namespaceOf } from "./fs-path.js";
import { fingerprint } from "../storage/idempotency.js";
import type { EventBody, FsAppend, FsEntry, FsPage, FsWrite } from "../storage/store.js";

/** One file's cap, and the cap on any content a refusal or diff carries back. */
export const FS_FILE_MAX_BYTES = 64 * 1024;
/** Revisions kept per path; older ones are pruned on write. */
export const FS_HISTORY = 20;
/** `listFs` page size, and `findFs`'s result cap. */
export const FS_LIST_PAGE = 100;
export const FS_FIND_MAX = 20;

export const utf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength;

/** A memory id (ADR 0046): 16 random hex characters, from the generator `newBlobId` uses. */
export const newMemoryId = (): string => newBlobId().slice(0, 16);

/** The SHA-256 of a revision's content, as hex, for its audit entry. */
export const contentHash = (s: string): string => createHash("sha256").update(s).digest("hex");

/** `s` cut to at most `max` UTF-8 bytes on a character boundary. */
export function cutBytes(s: string, max: number): string {
  const bytes = new TextEncoder().encode(s);
  if (bytes.byteLength <= max) return s;
  const cut = new TextDecoder().decode(bytes.slice(0, max));
  return cut.endsWith("�") ? cut.slice(0, -1) : cut;
}

export type FsOp = "write" | "edit" | "append" | "delete" | "restore";

/** What a write asks for. `restore`'s content is the old revision's, which the store reads from history. */
export type FsPlanInput =
  | { op: "write" | "append"; content: string; baseRev?: number }
  | { op: "edit"; old: string; new: string; baseRev?: number }
  | { op: "delete"; baseRev?: number }
  | { op: "restore"; content: string; baseRev?: number };

export type FsPlan =
  | { ok: true; rev: number; content: string; deleted: boolean }
  | { ok: false; reason: "stale"; currentRev: number; content: string }
  | { ok: false; reason: "too_large" }
  | { ok: false; reason: "invalid"; detail: string };

/** How many times `needle` occurs in `hay`, overlaps included, stopping at two. */
function matches(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1 && n < 2; i = hay.indexOf(needle, i + 1)) n++;
  return n;
}

/**
 * The next revision of a path, or the refusal. `current` is the `fs:` row (a tombstone included) or null. Without
 * `baseRev` a write creates, and is stale on a live file; with one it must name the current revision.
 */
export function planWrite(current: FsRow | null, input: FsPlanInput): FsPlan {
  const live = current !== null && !current.deleted;
  const stale = { ok: false as const, reason: "stale" as const, currentRev: current?.rev ?? 0, content: live ? current.content : "" };
  // A base_rev of 0 on a path never written is a create: a refusal saying "at revision 0" must not loop.
  const baseRev = input.baseRev === 0 && current === null ? undefined : input.baseRev;
  if (baseRev === undefined ? live : (current?.rev ?? 0) !== baseRev || current === null) return stale;
  const rev = (current?.rev ?? 0) + 1;
  const base = live ? current.content : "";
  let content: string;
  switch (input.op) {
    case "write":
    case "restore":
      content = input.content;
      break;
    case "append":
      content = base + input.content;
      break;
    case "edit": {
      if (!live) return { ok: false, reason: "invalid", detail: "no such file to edit" };
      if (input.old === "") return { ok: false, reason: "invalid", detail: "old is empty" };
      const n = matches(base, input.old);
      if (n !== 1) return { ok: false, reason: "invalid", detail: n === 0 ? "old not found" : "old matches more than once" };
      const at = base.indexOf(input.old);
      content = base.slice(0, at) + input.new + base.slice(at + input.old.length);
      break;
    }
    case "delete":
      if (!live) return { ok: false, reason: "invalid", detail: "no such file to delete" };
      return { ok: true, rev, content: "", deleted: true };
  }
  if (utf8Bytes(content) > FS_FILE_MAX_BYTES) return { ok: false, reason: "too_large" };
  return { ok: true, rev, content, deleted: false };
}

/**
 * Each account's memory allowance: an eighth of the room's file ceiling (128 KiB free, 6.25 MiB pro, 62.5 MiB max
 * and team). Memory is charged here and never to the room's total, so no account can fill the room with files nobody
 * else may delete, and a peer's quota refusal says nothing of memory it may not see.
 */
// ponytail: an eighth, not tuned; a per-plan figure in the plan table if rooms ask for more.
export const memoryCeilingOf = (fsBytesCeiling: number): number => Math.floor(fsBytesCeiling / 8);

export type FsCharge =
  | { ok: true; next: number }
  | { ok: false; reason: "closed" | "frozen" | "over_quota"; used: number; ceiling: number };

/**
 * The file byte charge, beside `decideBlobCharge`: the net change of one write (new revision minus pruned history; a
 * delete gives its bytes back). A negative delta always passes an open room, and the total never goes below zero.
 */
export function decideFsCharge(
  s: Pick<Session, "frozenAt" | "fsBytesCeiling"> & { fsBytes?: number },
  closed: boolean,
  delta: number,
): FsCharge {
  const used = s.fsBytes ?? 0;
  const ceiling = s.fsBytesCeiling;
  if (closed) return { ok: false, reason: "closed", used, ceiling };
  if (s.frozenAt !== null) return { ok: false, reason: "frozen", used, ceiling };
  if (delta > 0 && used + delta > ceiling) return { ok: false, reason: "over_quota", used, ceiling };
  return { ok: true, next: Math.max(0, used + delta) };
}

// ponytail: Myers diff is O(N·D); two unrelated 64 KiB revisions ran past two minutes. These bounds give up instead.
const DIFF_MAX_EDIT_LINES = 2000;
const DIFF_TIMEOUT_MS = 250;

/**
 * A unified diff of two revisions, three lines of context, cut at 64 KiB; or null when the revisions are too
 * different to diff within `DIFF_MAX_EDIT_LINES` changed lines or `DIFF_TIMEOUT_MS`, so the caller returns both instead.
 */
export function diffText(a: string, b: string): { diff: string; truncated: boolean } | null {
  const full = createPatch("file", a, b, "", "", { context: 3, maxEditLength: DIFF_MAX_EDIT_LINES, timeout: DIFF_TIMEOUT_MS });
  if (full === undefined) return null;
  const diff = cutBytes(full, FS_FILE_MAX_BYTES);
  return { diff, truncated: diff.length < full.length };
}

/** A row as an entry, content dropped. */
export const fsEntryOf = ({ content: _content, ...entry }: FsRow | FsEntry & { content?: string }): FsEntry => entry;

/**
 * The path a file write lands at (ADR 0046): a room path as given, and a memory path with its id resolved. `me`
 * names the writing account's id, minted by `fresh` on its first write (`assign`); a named id must be the writing
 * account's, and a memory path needs a file under its id. Shared by both stores, read before the rows it names.
 */
export function resolveFsPath(
  w: Pick<FsWrite, "path" | "userId">,
  writerMemoryId: string | null,
  namedOwner: string | null,
  fresh: () => string,
): { ok: true; path: string; assign: string | null } | { ok: false } {
  const ns = namespaceOf(w.path);
  if (ns.ns !== "memory") return { ok: true, path: w.path, assign: null };
  const rest = w.path.split("/").slice(3);
  if (ns.memoryId === null || rest.length === 0) return { ok: false };
  if (ns.memoryId === OWN_MEMORY) {
    const id = writerMemoryId ?? fresh();
    return { ok: true, path: `/members/${id}/${rest.join("/")}`, assign: writerMemoryId === null ? id : null };
  }
  return namedOwner === w.userId ? { ok: true, path: w.path, assign: null } : { ok: false };
}

/** What `decideFsWrite` hands a store to write: the row, the history revisions to delete, the new total, the event. */
/** A refused write: every `FsAppend` but the two that wrote something. */
export type FsRefusal = Exclude<FsAppend, { outcome: "ok" | "replayed" }>;

export type FsDecision =
  | { ok: false; result: FsRefusal }
  | {
    ok: true; row: FsRow; dropRevs: number[]; event: EventBody; stamp: Record<string, unknown>;
    /** The record's totals after the write: the room's files, and each account's memory by id. */
    fsBytes: number; fsMemoryBytes: Record<string, number> | undefined;
  };

/**
 * The shared rules of a file write, after the key and the room checks and on the rows read in the transaction:
 * the restore's source, `planWrite`, the history kept (a delete drops all of it), and the net charge. `history` is
 * the path's kept revisions, newest first; the live row is its first.
 */
export function decideFsWrite(
  s: Pick<Session, "frozenAt" | "fsBytesCeiling" | "fsMemoryBytes"> & { fsBytes?: number },
  w: FsWrite,
  path: string,
  current: FsRow | null,
  history: readonly FsRow[],
  at: number,
  plain = false,
): FsDecision {
  let input: FsPlanInput;
  if (w.write.op === "restore") {
    const want = w.write.rev;
    const from = history.find((r) => r.rev === want);
    if (!from) return { ok: false, result: { outcome: "invalid", detail: `revision ${want} is not kept` } };
    input = { op: "restore", content: from.content, baseRev: w.write.baseRev };
  } else {
    input = w.write;
  }
  const plan = planWrite(current, input);
  if (!plan.ok) {
    if (plan.reason === "stale") {
      const writer = current === null ? null : { memberId: current.writerMemberId, label: current.writerLabel };
      return { ok: false, result: { outcome: "stale", currentRev: plan.currentRev, content: plan.content, writer } };
    }
    if (plan.reason === "too_large") return { ok: false, result: { outcome: "too_large" } };
    return { ok: false, result: { outcome: "invalid", detail: plan.detail } };
  }
  const size = utf8Bytes(plan.content);
  const row: FsRow = {
    path, rev: plan.rev, content: plan.content, size, writerMemberId: w.memberId, writerLabel: w.label, at, deleted: plan.deleted,
  };
  const dropped = plan.deleted ? history : history.slice(FS_HISTORY - 1);
  const delta = (plan.deleted ? 0 : size) - dropped.reduce((n, r) => n + r.size, 0);
  // In a home room (ADR 0047) every path is the account's, so `/members/` is a plain directory there: `plain` says so.
  const ns = namespaceOf(path);
  const memoryId = !plain && ns.ns === "memory" ? ns.memoryId : null;
  const charge = memoryId === null
    ? decideFsCharge(s, false, delta)
    : decideFsCharge({ frozenAt: s.frozenAt, fsBytes: s.fsMemoryBytes?.[memoryId] ?? 0, fsBytesCeiling: memoryCeilingOf(s.fsBytesCeiling) }, false, delta);
  // Every account's memory together is bounded by the room's ceiling too, as accounts come and go over a room's life.
  // Refused with the writer's own figures, so the refusal says nothing of other accounts' memory.
  if (charge.ok && memoryId !== null && delta > 0) {
    const total = Object.values(s.fsMemoryBytes ?? {}).reduce((n, b) => n + b, 0);
    if (total + delta > s.fsBytesCeiling) {
      return { ok: false, result: { outcome: "over_quota", used: s.fsMemoryBytes?.[memoryId] ?? 0, ceiling: memoryCeilingOf(s.fsBytesCeiling) } };
    }
  }
  if (!charge.ok) {
    if (charge.reason === "over_quota") return { ok: false, result: { outcome: "over_quota", used: charge.used, ceiling: charge.ceiling } };
    return { ok: false, result: { outcome: charge.reason } };
  }
  const event: EventBody = {
    type: "fs", fromMemberId: w.memberId, fromUserId: w.userId, fromLabel: w.label, refId: null,
    payload: { path, rev: row.rev, size, op: w.write.op === "restore" ? "restore" : plan.deleted ? "delete" : "write" },
  };
  return {
    ok: true, row, dropRevs: dropped.map((r) => r.rev), event,
    fsBytes: memoryId === null ? charge.next : s.fsBytes ?? 0,
    fsMemoryBytes: memoryId === null ? s.fsMemoryBytes : { ...s.fsMemoryBytes, [memoryId]: charge.next },
    stamp: { path, rev: row.rev, size, sha256: contentHash(plan.content) },
  };
}

/** The print a keyed file write is remembered by: the path as sent and the op, never the resolved path. */
export const fsPrint = (w: FsWrite): string =>
  fingerprint({ type: "fs", fromMemberId: w.memberId, fromUserId: w.userId, fromLabel: w.label, refId: null, payload: { path: w.path, write: w.write } });

/**
 * Live rows at `prefix` as a directory, minus hidden memory ids, `FS_LIST_PAGE` after `cursor`. Shared paging rule.
 * `keyOf` is the order and the cursor: the path by default; `newestKey` for a listing newest first (ADR 0047).
 */
export function pageFs(rows: readonly FsEntry[], keep: (r: FsEntry) => boolean, cap: number, cursor?: string, keyOf: (r: FsEntry) => string = (r) => r.path): FsPage {
  const entries: FsEntry[] = [];
  for (const r of [...rows].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0))) {
    if (cursor !== undefined && keyOf(r) <= cursor) continue;
    if (r.deleted || !keep(r)) continue;
    if (entries.length === cap) return { entries, next: keyOf(entries[cap - 1]) };
    entries.push(fsEntryOf(r));
  }
  return { entries, next: null };
}

/** The sort key that puts the newest row first: the time inverted and padded, then the path, so the order is total. */
export const newestKey = (r: Pick<FsEntry, "at" | "path">): string =>
  `${String(Number.MAX_SAFE_INTEGER - r.at).padStart(16, "0")}:${r.path}`;

/** What a keyed home write (ADR 0047) is remembered by: no event, so the path and revision are stored with the print. */
export interface HomeKeyRecord { print: string; path: string; rev: number }
export const homeKey = (memberId: string, key: string): string => `hk:${encodeURIComponent(memberId)}:${key}`;

/** Whether `path` is `prefix` or under it, as a directory; `/` holds everything. */
export const underPrefix = (path: string, prefix: string): boolean =>
  prefix === "/" || path === prefix || path.startsWith(prefix + "/");

/** Whether a row is a memory file of one of the `hide` ids. */
export const hiddenMemory = (r: FsEntry, hide: readonly string[] | undefined): boolean => {
  if (!hide || hide.length === 0) return false;
  const ns = namespaceOf(r.path);
  return ns.ns === "memory" && ns.memoryId !== null && hide.includes(ns.memoryId);
};

/** Whether a path holds every word of `query`, case-insensitive. An empty query matches nothing. */
export function pathMatches(path: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const p = path.toLowerCase();
  return words.length > 0 && words.every((w) => p.includes(w));
}
