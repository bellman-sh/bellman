/**
 * Room files (ADR 0046): the pure planning of each write op, the byte charge, and the history diff. Runtime-free, and
 * called by both stores inside the write's own transaction, so the stale check and the charge read the row they
 * write (as `decideConfigWrite` is shared).
 */
import { createPatch } from "diff";
import type { FsRow, Session } from "./types.js";

/** One file's cap, and the cap on any content a refusal or diff carries back. */
export const FS_FILE_MAX_BYTES = 64 * 1024;
/** Revisions kept per path; older ones are pruned on write. */
export const FS_HISTORY = 20;
/** `listFs` page size, and `findFs`'s result cap. */
export const FS_LIST_PAGE = 100;
export const FS_FIND_MAX = 20;

export const utf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength;

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
  if (input.baseRev === undefined ? live : (current?.rev ?? 0) !== input.baseRev || current === null) return stale;
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

/** A unified diff of two revisions, three lines of context, cut at 64 KiB. */
export function diffText(a: string, b: string): { diff: string; truncated: boolean } {
  const full = createPatch("file", a, b, "", "", { context: 3 });
  const diff = cutBytes(full, FS_FILE_MAX_BYTES);
  return { diff, truncated: diff.length < full.length };
}
