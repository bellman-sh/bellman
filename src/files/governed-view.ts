/**
 * `/.bellman/` (ADR 0046, decision 8): governed config (ADR 0044) shown as read-only files, rendered from the rows
 * through `getGovernedConfig` on every read and never stored. `room.md` is the room instructions.
 */
import { getGovernedConfig } from "./config.js";
import type { BellmanStore } from "../storage/store.js";
import type { FsRow } from "../types.js";
import { utf8Bytes } from "./fs.js";

export const GOVERNED_VIEW_ROOT = "/.bellman";
const ROOM_MD = `${GOVERNED_VIEW_ROOT}/room.md`;

/** Every file the view holds, rendered now. An unset or unapproved config reads as an empty file at revision 0. */
export async function governedView(store: BellmanStore, sessionId: string): Promise<FsRow[]> {
  const g = await getGovernedConfig(store, sessionId, "room_instructions");
  const content = g.value?.markdown ?? "";
  return [{
    path: ROOM_MD, rev: g.rev, content, size: utf8Bytes(content),
    writerMemberId: g.approver?.memberId ?? "system", writerLabel: g.approver?.label ?? "bellman", at: 0, deleted: false,
  }];
}

/** One file of the view, or null. */
export async function governedFile(store: BellmanStore, sessionId: string, path: string): Promise<FsRow | null> {
  return (await governedView(store, sessionId)).find((r) => r.path === path) ?? null;
}
