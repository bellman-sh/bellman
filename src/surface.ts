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
import type { ApprovedBy, SessionEvent, Shape, ShapeColorName, SurfaceItem, SurfaceKind, SurfaceRow } from "./types.js";
import type { StoredSession } from "./stored-session.js";
import { slugShape } from "./manifest.js";
import { BLOB_ID } from "./blobs.js";

export const SURFACE_KINDS = ["text", "link", "diagram", "connector", "file", "image", "html", "shape"] as const satisfies readonly SurfaceKind[];

// ponytail: ceilings, not tuned. 64 keeps a full read inside one tool response;
// the first room past it wants pagination, not a bigger number. 8,000 is the
// scribe spec's 4,000 doubled, for a body read on demand rather than on every poll.
export const MAX_SURFACE_ITEMS = 64;
export const MAX_SURFACE_BODY_CHARS = 8_000;
export const MAX_SURFACE_TITLE_CHARS = 120;
export const MAX_SURFACE_LINK_CHARS = 2_048;

/**
 * The role-key grammar with `-` allowed after the first character, `[a-z][a-z0-9_-]{0,30}`, and the same
 * reserved names, refused with its own noun. A role key has no `-` (see `slugShape`); a surface key never goes
 * into a join code, so it may.
 */
export const SurfaceKeyShape = slugShape("surface keys", { hyphens: true });

/** The record's cursor of the last change to a row, 0 for a room that never had one. */
export const surfaceCursor = (s: StoredSession): number => s.surfaceCursor ?? 0;

/**
 * When a row's key was first written: its `createdAt`, or its `at` for a row written before `createdAt`
 * existed. Nothing rewrites such a row (R1), and its `at` is the oldest time the store knows for the key (R2),
 * so a reader asks here and never reads `createdAt` bare.
 */
export const createdAtOf = (row: Pick<SurfaceRow, "at" | "createdAt">): number => row.createdAt ?? row.at;

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
 *
 * `createdAt` is stamped from the event on a key's first write and carried over by `createdAtOf` on every
 * edit, so a row from before the field keeps its `at`; a removal leaves no row, so a key written again finds
 * none and is stamped afresh.
 *
 * `approvedBy` is stamped beside the author when the append carries one (topic rooms spec, D2). The row is
 * built from the item and the event and never from `existing`, so a write without an approver stores a row
 * without one: an edit does not keep the name of a member who approved the words it replaced (R20).
 */
export function applySurfaceWrite(
  existing: SurfaceRow | undefined,
  event: SessionEvent,
  write: SurfaceWrite,
  approvedBy?: ApprovedBy,
): SurfaceRow | "remove" | null {
  if (existing !== undefined && existing.cursor >= event.cursor) return null;
  if (write.item === null) return existing === undefined ? null : "remove";
  return {
    ...write.item,
    cursor: event.cursor,
    at: event.at,
    createdAt: existing === undefined ? event.at : createdAtOf(existing),
    byMemberId: event.fromMemberId,
    byLabel: event.fromLabel,
    ...(approvedBy === undefined ? {} : { approvedBy }),
  };
}

/** The viewers' grid: four columns of cells 320 by 200, 40 apart. Copies `GRID` in ui/src/canvas-layout.ts and dash's src/lib/canvas.ts. */
export const GRID = { cols: 4, w: 320, h: 200, gap: 40 } as const;

/** Slot `index`, left to right and then down: `gridSlot` in both viewers. */
export const gridSlot = (index: number): { x: number; y: number } => ({
  x: (index % GRID.cols) * (GRID.w + GRID.gap),
  y: Math.floor(index / GRID.cols) * (GRID.h + GRID.gap),
});

/** The kinds the server places when they arrive without a placement. */
export const PLACED_KINDS: readonly SurfaceKind[] = ["text", "link", "diagram", "file", "image", "html"];

/** The ceiling on the slot search (R7): a row of four slots for each item the surface can hold, 256. */
// ponytail: a ceiling on the search, not tuned: a row of four slots for every item the surface can hold. A
// rect behind a column covers more than one slot, and a box sized 1e300 covers every slot there is; a search
// with no end would hang the room's object inside its transaction. Past it the item is stored unplaced, as
// it was before this, and the write still succeeds; the upgrade is a search that skips a covered run in one step.
export const MAX_SLOT_SEARCH = MAX_SURFACE_ITEMS * GRID.cols;

/** Whether a write arrives without the placement the room gives it. */
export const needsPlacement = (write: SurfaceWrite): write is { key: string; item: SurfaceItem } =>
  write.item !== null && write.item.placement === null && PLACED_KINDS.includes(write.item.kind);

interface Box { x: number; y: number; w: number; h: number }

/** Whether two boxes share area. Boxes that only touch do not. */
const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * What the rows cover as the viewers draw them (`layout` in `ui/src/canvas-layout.ts`, `toFlow` in dash): a
 * row with a placement at it, the grid's size where it has none; a row with none at the next slot of the
 * grid, counting only the rows with none. A connector has no box. `skipKey` is the row being written, which
 * the write is about to place or replace.
 *
 * Order decides nothing. Each row with none covers one full cell, so k of them cover slots 0 to k - 1
 * whichever of them is drawn where, and the server keeps clear of the same cells the viewers draw them in,
 * whatever order each viewer sorts them in.
 */
function coveredBoxes(rows: readonly SurfaceRow[], skipKey: string): Box[] {
  let unplaced = 0;
  return rows
    .filter((r) => r.key !== skipKey && r.kind !== "connector")
    .map((r) => {
      const at = r.placement ?? gridSlot(unplaced++);
      return { x: at.x, y: at.y, w: r.placement?.w ?? GRID.w, h: r.placement?.h ?? GRID.h };
    });
}

/**
 * The write as the room stores it. A write that needs a placement gets the one its key already holds, so
 * replacing an item moves nothing, and otherwise the lowest slot of the grid whose cell no row covers. A
 * write that has one, a removal, a connector and a shape come back as they are, the same object, and so
 * does a write for which every slot in the search is covered.
 */
export function withPlacement(rows: readonly SurfaceRow[], write: SurfaceWrite): SurfaceWrite {
  if (!needsPlacement(write)) return write;
  const stored = rows.find((r) => r.key === write.key)?.placement ?? null;
  if (stored !== null) return { key: write.key, item: { ...write.item, placement: { ...stored } } };
  const covered = coveredBoxes(rows, write.key);
  for (let i = 0; i < MAX_SLOT_SEARCH; i++) {
    const at = gridSlot(i);
    if (!covered.some((b) => overlaps(b, { ...at, w: GRID.w, h: GRID.h }))) {
      return { key: write.key, item: { ...write.item, placement: at } };
    }
  }
  return write;
}

const PlacementShape = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().positive().optional(),
  h: z.number().finite().positive().optional(),
});

const EndsShape = z.strictObject({ from: SurfaceKeyShape, to: SurfaceKeyShape });

/**
 * The blob a `file`, an `image` or an `html` item names (#183, D5): the id and nothing else.
 * `bytes`, `type` and `name` are the server's to set from the object, so an item
 * sent back as it was read is refused for them until the sender takes them off,
 * as it is for `cursor`, `at`, `created_at`, `changed_at` and `approved_by`.
 */
const BlobShape = z.strictObject({
  id: z.string().regex(BLOB_ID, "must be the 32 hex characters an upload returned"),
});

/** A shape's forms and its six named colours (#197, D1, D3). A name resolves in the panel to its own class. */
export const SHAPE_FORMS = ["rect", "ellipse", "diamond", "arrow", "line"] as const satisfies readonly Shape["form"][];
export const SHAPE_COLORS = ["slate", "blue", "green", "amber", "red", "violet"] as const satisfies readonly ShapeColorName[];

/**
 * A shape's colour (D3): one of the six names, or a hex colour, `#rgb` or `#rrggbb`, stored as lowercase
 * `#rrggbb` so a reader checks one form. Nothing else passes, so the one peer string that reaches the
 * panel's CSS is six hex digits, which the panel checks again before it sets one.
 */
const ShapeColorShape = z.string().transform((c, ctx): Shape["color"] => {
  if ((SHAPE_COLORS as readonly string[]).includes(c)) return c as ShapeColorName;
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase() as Shape["color"];
  if (/^#[0-9a-f]{3}$/i.test(c)) return `#${[...c.slice(1).toLowerCase()].map((d) => d + d).join("")}` as Shape["color"];
  ctx.addIssue({ code: "custom", message: 'must be slate, blue, green, amber, red or violet, or a hex colour such as "#3b82f6"' });
  return z.NEVER;
});
const LINE_FORMS: ReadonlySet<string> = new Set(["arrow", "line"]);

/** What a shape is (D1). The defaults apply here, so a stored shape spells both and a reader never branches on absence. */
const ShapeShape = z.strictObject({
  form: z.enum(SHAPE_FORMS),
  color: ShapeColorShape.default("slate"),
  flip: z.boolean().default(false),
});

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
 * than dropped: `cursor`, `at`, `created_at`, `changed_at` and `approved_by` are the
 * server's to set, and an item sent back as it was read is refused for them until the
 * sender takes them off.
 *
 * `null` is absence, for the six fields a read spells that way: an item as a
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
  blob: BlobShape.nullish(),
  shape: ShapeShape.nullish(),
});

/** A removal. `remove: true` and nothing else, so it cannot be mistaken for an item. */
export const SurfaceRemoveShape = z.strictObject({
  key: SurfaceKeyShape,
  remove: z.literal(true),
});

/**
 * A restore (topic rooms spec, D5): `{ key, restore: <cursor> }` and nothing else. Strict, so a field beside the
 * cursor is refused by name. The cursor is a whole number from 1, the first cursor an event can hold.
 */
export const RestoreShape = z.strictObject({
  key: SurfaceKeyShape,
  restore: z.number().int().positive(),
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
 * What is NOT checked here: that a connector's ends exist, and that a blob
 * exists and is what its kind needs — both are `writeSurface`'s reads.
 */
export function normalizeSurfaceWrite(
  payload: unknown,
): { ok: true; write: SurfaceWrite; blobId: string | null } | { ok: false; reason: string } {
  const removing = typeof payload === "object" && payload !== null && "remove" in payload;
  if (removing) {
    const parsed = SurfaceRemoveShape.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, reason: `surface removal must be { key, remove: true }: ${describeIssue(parsed.error.issues[0])}` };
    }
    return { ok: true, write: { key: parsed.data.key, item: null }, blobId: null };
  }

  const parsed = SurfaceItemShape.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `surface payload must be { key, kind, title?, body?, ends?, placement?, blob?, shape? } or { key, remove: true }: ${describeIssue(parsed.error.issues[0])}`,
    };
  }
  const v = parsed.data;
  const refuse = (reason: string) => ({ ok: false as const, reason: `surface ${v.kind} "${v.key}": ${reason}` });

  // A file or an image is blob-backed (#183): its bytes are the object's, so it
  // names a blob and carries no body. Nothing else may name one but an html item,
  // which carries its page in body or names a blob, never both (#185).
  const blobBacked = v.kind === "file" || v.kind === "image";
  if (v.kind === "connector") {
    if (!v.ends) return refuse("a connector needs ends { from, to } naming two items");
    if (v.ends.from === v.ends.to) return refuse("a connector's ends must differ");
    if (v.placement) return refuse("a connector has no placement; it is drawn between its ends");
  } else {
    if (v.ends) return refuse("only a connector has ends");
    if (blobBacked) {
      if (!v.blob) return refuse("a file or an image needs blob { id } naming a blob uploaded to this room");
      if (v.body) return refuse("a file or an image has no body; its bytes are the blob's");
    } else if (v.kind === "html") {
      // An artifact is inline or a blob, never both (#185, D1): a hosted connector with no
      // bridge still has a way onto the surface, and anything larger is an upload.
      if (v.body && v.blob) return refuse("an html item is inline (body) or a blob (blob: { id }), not both");
      if (!v.body && !v.blob) return refuse("an html item needs a body (the page, inline) or blob { id } naming a blob stored as text/html");
    } else if (v.kind === "shape") {
      // A shape is a few numbers the canvas draws (#197, D1, D2, D4): its own field, its size on the placement, no body.
      if (!v.shape) return refuse("a shape needs shape { form, color?, flip? }");
      if (v.body) return refuse("a shape has no body; its label is the title");
      if (!v.placement || v.placement.w === undefined || v.placement.h === undefined) {
        return refuse("a shape needs placement { x, y, w, h }");
      }
      // `flip: false` is the default every stored shape carries, so a shape read back and sent back is
      // accepted; only a flip that would draw nothing is refused.
      if (v.shape.flip && !LINE_FORMS.has(v.shape.form)) return refuse("flip is for an arrow or a line");
    } else if (!v.body) {
      return refuse("needs a body");
    }
  }
  if (v.blob && !blobBacked && v.kind !== "html") return refuse("only a file, an image or an html item names a blob");
  if (v.shape && v.kind !== "shape") return refuse("only a shape has shape");

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
        // Filled from the object by writeSurface (D5): the writer's word is the id alone.
        blob: null,
        shape: v.kind === "shape" ? v.shape! : null,
      },
    },
    blobId: v.blob?.id ?? null,
  };
}

/**
 * Whether a `surface` payload asks for a restore: an object with a `restore` key, whatever else it holds. The
 * shape then names what is wrong with it, as `normalizeSurfaceWrite` does for a removal, so `{ key, kind, body,
 * restore }` is refused as a restore with a stray field and never read as an item.
 */
export const isRestorePayload = (payload: unknown): boolean =>
  typeof payload === "object" && payload !== null && "restore" in payload;

/**
 * Read a restore payload: the key and the cursor of the version it names. Which version that is, and whether the
 * log holds it, is `writeSurface`'s read (`restoreVersion`), as a connector's ends and a blob's presence are.
 */
export function normalizeRestore(
  payload: unknown,
): { ok: true; key: string; cursor: number } | { ok: false; reason: string } {
  const parsed = RestoreShape.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, reason: `surface restore must be { key, restore: <cursor> }: ${describeIssue(parsed.error.issues[0])}` };
  }
  return { ok: true, key: parsed.data.key, cursor: parsed.data.restore };
}
