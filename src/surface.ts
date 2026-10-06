/**
 * The working surface's pure rules (#129): the key grammar, the bounds, the
 * monotonic write rule both stores apply, and the accessor over the record's
 * cursor. Runtime-free — no MCP SDK, no `cloudflare:workers` — because both
 * stores, both test programs and the projection layer import it.
 *
 * It imports manifest.ts for the slug grammar and nothing that imports store.ts,
 * so store.ts can import it without the cycle that keeps `asked` and
 * `clearSilence` in store.ts rather than heartbeat.ts.
 */
import type { SessionEvent, SurfaceItem, SurfaceKind, SurfaceRow } from "./types.js";
import type { StoredSession } from "./stored-session.js";
import { slugShape } from "./manifest.js";

export const SURFACE_KINDS = ["text", "link", "diagram", "connector"] as const satisfies readonly SurfaceKind[];

// ponytail: ceilings, not tuned. 64 keeps a full read inside one tool response;
// the first room past it wants pagination, not a bigger number. 8,000 is the
// scribe spec's 4,000 doubled, for a body read on demand rather than on every poll.
export const MAX_SURFACE_ITEMS = 64;
export const MAX_SURFACE_BODY_CHARS = 8_000;
export const MAX_SURFACE_TITLE_CHARS = 120;
export const MAX_SURFACE_LINK_CHARS = 2_048;

/** The same grammar as a role key, refused with its own noun. */
export const SurfaceKeyShape = slugShape("surface keys");

/** The record's cursor of the last change to a row, 0 for a room that never had one. */
export const surfaceCursor = (s: StoredSession): number => s.surfaceCursor ?? 0;

/** What an append asks the store to do to one key. `item: null` removes it. */
export type SurfaceWrite = { key: string; item: SurfaceItem | null };

/**
 * The monotonic rule (spec D6), shared by both stores.
 *
 * A write replaces the row if the event's cursor is higher than the row's, and
 * is a no-op otherwise. A fresh append's cursor is always higher, so on that
 * path the guard never refuses; it keeps the rule safe for an event that is not
 * the newest. An idempotent replay never reaches it: `appendEventOnce` applies
 * no surface write on a replay. The row went in with the event in one
 * transaction, so there is nothing to repair, and a removal leaves no
 * tombstone, so this rule handed the original event for a removed key would see
 * no row to compare against and put the item back.
 *
 * Returns the row to store, "remove" to delete the row, or null for no change.
 * Removing a key that holds nothing is null: the cursor records changes, not
 * attempts.
 */
export function applySurfaceWrite(
  existing: SurfaceRow | undefined,
  event: SessionEvent,
  write: SurfaceWrite,
): SurfaceRow | "remove" | null {
  if (existing !== undefined && existing.cursor >= event.cursor) return null;
  if (write.item === null) return existing === undefined ? null : "remove";
  return {
    ...write.item,
    cursor: event.cursor,
    at: event.at,
    byMemberId: event.fromMemberId,
    byLabel: event.fromLabel,
  };
}
