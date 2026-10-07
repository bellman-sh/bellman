/**
 * The working surface's pure rules (#129): the key grammar, the bounds, the
 * monotonic write rule both stores apply, the accessor over the record's
 * cursor, and the payload a write arrives in with the rules that normalise it.
 * Runtime-free — no MCP SDK, no `cloudflare:workers` — because both
 * stores, both test programs and the projection layer import it.
 *
 * It imports manifest.ts for the slug grammar and nothing that imports store.ts,
 * so store.ts can import it without the cycle that keeps `asked` and
 * `clearSilence` in store.ts rather than heartbeat.ts.
 */
import { z } from "zod";
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

const PlacementShape = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().positive().optional(),
  h: z.number().finite().positive().optional(),
});

const EndsShape = z.strictObject({ from: SurfaceKeyShape, to: SurfaceKeyShape });

/**
 * Non-empty text of at most `max` UTF-16 code units: `.length`, which is what
 * the index reports as `chars`, so the bound and the number read against it
 * are one count. Not zod's `.max()`, which measures a string in code points
 * once it is past the bound: an astral body would pass at twice the ceiling,
 * 8,000 astral characters being 16,000 units.
 */
const boundedText = (max: number) =>
  z.string().min(1).refine((s) => s.length <= max, `must be at most ${max} characters`);

/**
 * An item as the wire carries it. Strict, so an unknown field is refused rather
 * than dropped: `cursor` and `at` are the server's to set, and an item sent back
 * as it was read is refused for them until the sender takes them off.
 *
 * `null` is absence, for the four fields a read spells that way: an item as a
 * member reads it carries `null` for each it left out, and read, edit, send back
 * is the natural replace. `normalizeSurfaceWrite` reads null as absent in every
 * rule below and stores absence as null either way.
 */
export const SurfaceItemShape = z.strictObject({
  key: SurfaceKeyShape,
  kind: z.enum(SURFACE_KINDS),
  title: boundedText(MAX_SURFACE_TITLE_CHARS).nullish(),
  body: boundedText(MAX_SURFACE_BODY_CHARS).nullish(),
  ends: EndsShape.nullish(),
  placement: PlacementShape.nullish(),
});

/** A removal. `remove: true` and nothing else, so it cannot be mistaken for an item. */
export const SurfaceRemoveShape = z.strictObject({
  key: SurfaceKeyShape,
  remove: z.literal(true),
});

/** One issue as "path: message", the manifest resolver's wording. */
const describeIssue = (i: { path: PropertyKey[]; message: string }): string => {
  const path = i.path.map(String).join(".");
  return path ? `${path}: ${i.message}` : i.message;
};

/**
 * Validate a `surface` payload and normalise it to a write (spec D2, D3):
 * the shape, then each kind's cross-field rule. The arm is chosen by the
 * presence of `remove`, as the manifest resolver chooses by `preset`, so the
 * error names the field rather than reporting an opaque union failure.
 *
 * What is NOT checked here: that a connector's ends exist. That needs the
 * rows, and it is `writeSurface`'s read.
 */
export function normalizeSurfaceWrite(
  payload: unknown,
): { ok: true; write: SurfaceWrite } | { ok: false; reason: string } {
  const removing = typeof payload === "object" && payload !== null && "remove" in payload;
  if (removing) {
    const parsed = SurfaceRemoveShape.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, reason: `surface removal must be { key, remove: true }: ${describeIssue(parsed.error.issues[0])}` };
    }
    return { ok: true, write: { key: parsed.data.key, item: null } };
  }

  const parsed = SurfaceItemShape.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `surface payload must be { key, kind, title?, body?, ends?, placement? } or { key, remove: true }: ${describeIssue(parsed.error.issues[0])}`,
    };
  }
  const v = parsed.data;
  const refuse = (reason: string) => ({ ok: false as const, reason: `surface ${v.kind} "${v.key}": ${reason}` });

  if (v.kind === "connector") {
    if (!v.ends) return refuse("a connector needs ends { from, to } naming two items");
    if (v.ends.from === v.ends.to) return refuse("a connector's ends must differ");
    if (v.placement) return refuse("a connector has no placement; it is drawn between its ends");
  } else {
    if (v.ends) return refuse("only a connector has ends");
    if (!v.body) return refuse("needs a body");
  }

  if (v.kind === "link") {
    if (v.body!.length > MAX_SURFACE_LINK_CHARS) {
      // "2,048", written out: the test pins the wording and a locale must not move it.
      return refuse("a link's body is at most 2,048 characters");
    }
    let url: URL;
    try {
      url = new URL(v.body!);
    } catch {
      return refuse("body must be an absolute http or https URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return refuse("body must be an http or https URL");
    }
  }

  return {
    ok: true,
    write: {
      key: v.key,
      item: {
        key: v.key,
        kind: v.kind,
        title: v.title ?? null,
        body: v.body ?? null,
        ends: v.ends ?? null,
        placement: v.placement ?? null,
      },
    },
  };
}
