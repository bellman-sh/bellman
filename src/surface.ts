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
 * is a no-op otherwise. On a fresh append the cursor is always higher. On an
 * idempotent replay `appendEventOnce` re-applies the extra with the ORIGINAL
 * event, whose cursor is at or behind whatever the row holds, so a replay is a
 * repair or a no-op and never a regression — the shape `creditReport` and
 * `markRemoved` have.
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
