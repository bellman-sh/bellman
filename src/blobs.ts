/**
 * Blobs on the working surface (#183): the storage seam a room's bytes go
 * through, and the pure rules both ends of it apply — the key, the id, the image
 * allowlist and the signatures behind it, the name a blob is labelled with, the
 * bounds, and the three stream helpers the upload route and the stores need.
 *
 * Runtime-free — no MCP SDK, no `cloudflare:workers` — because the routes, the
 * tool handlers and both test programs import it. `blobs-r2.ts` is the Workers
 * half, and the only file that touches a bucket.
 */
import type { StoredSession } from "./stored-session.js";

// ponytail: ceilings, not tuned. 25 MB is a quarter of the zone's 100 MB request
// bound; a cap raised past it is a different route (multipart), not a bigger
// number. 200 characters of name is a label, never a path.
export const MAX_BLOB_BYTES = 25 * 1024 * 1024;
export const MAX_BLOB_NAME_CHARS = 200;

/** What a blob is stored as when its claimed type is not one the server stands behind. */
export const OCTET_STREAM = "application/octet-stream";

/**
 * The image types a download is served as (spec D4) and an `image` item may
 * reference (D5). SVG is deliberately absent: it is scriptable, and a type on
 * this list is served inline.
 */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];
export const isImageType = (type: string): type is ImageType =>
  (IMAGE_TYPES as readonly string[]).includes(type);

/** How many leading bytes `sniffImageType` needs: WebP's marker ends at byte 12. */
export const SNIFF_BYTES = 12;

/**
 * The type the first bytes say, or null when they say none of the four (D6).
 * PNG and GIF are a fixed prefix; JPEG is the SOI marker; WebP is RIFF, a
 * length, then WEBP. A short head fails every comparison, which is a null.
 */
export function sniffImageType(head: Uint8Array): ImageType | null {
  const at = (i: number, ...expected: number[]) => expected.every((b, j) => head[i + j] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

// ponytail: 100 characters of media type; RFC 6838 allows 127 a side and nobody sends it.
const MAX_MEDIA_TYPE_CHARS = 100;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/** `type/subtype`, lower-cased, parameters dropped; an octet-stream for anything else. */
export function normalizeMediaType(claimed: string | null): string {
  const bare = (claimed ?? "").split(";")[0].trim().toLowerCase();
  return bare.length > 0 && bare.length <= MAX_MEDIA_TYPE_CHARS && MEDIA_TYPE.test(bare)
    ? bare
    : OCTET_STREAM;
}

/**
 * The type a blob is stored with (D6): the server's word, never the client's.
 *
 * An image claim is held to the bytes: kept only when it is on the allowlist
 * AND the signature agrees, and otherwise stored as an octet-stream — a body
 * that is not a PNG is not served as one, whatever its header said. Any other
 * claim is kept as a normalised label, because the download route never serves
 * it as a Content-Type anyway (D4): it is for a reader choosing an icon, and for
 * piece 4 to know an artifact is HTML.
 */
export function storedType(claimed: string | null, head: Uint8Array): string {
  const type = normalizeMediaType(claimed);
  if (!type.startsWith("image/")) return type;
  return isImageType(type) && sniffImageType(head) === type ? type : OCTET_STREAM;
}

/**
 * A name as it is stored and later sent back in Content-Disposition (D6): a
 * label, never a path. Path separators, control characters (C0, DEL and C1) and
 * format characters are stripped and the rest trimmed, bar three format
 * characters that spell names: the zero-width non-joiner and joiner, which words
 * in Persian and several Indic scripts are written with (the joiner also holds an
 * emoji sequence together), and the soft hyphen, a hyphenation hint in text
 * pasted from a typeset page. The rest go. The bidirectional controls rewrite
 * what a save dialog shows: `report<RLO>fdp.exe` is drawn `reportexe.pdf`. The tag
 * characters hide a string from a human reader that a program can still read.
 * What is left must be 1 to 200 code units (`.length`, the unit every surface
 * bound uses), or the name is refused — null, for the route to answer 400,
 * rather than truncated or invented.
 */
export function sanitizeName(raw: string | null): string | null {
  if (raw === null) return null;
  const name = raw.replace(/[\\/]|(?![\u{AD}\u{200C}\u{200D}])[\p{Cc}\p{Cf}]/gu, "").trim();
  return name.length >= 1 && name.length <= MAX_BLOB_NAME_CHARS ? name : null;
}

/**
 * RFC 8187 ext-value. `encodeURIComponent` leaves `!'()*` alone, and of those
 * only `!` is an attr-char, so the other four are encoded by hand.
 */
const extValue = (s: string): string =>
  encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The disposition every non-image download carries (D4). */
export const attachmentDisposition = (name: string): string =>
  `attachment; filename*=UTF-8''${extValue(name)}`;

// ponytail: 128 bits, not tuned. An id only has to be unguessable and fresh; the
// room's prefix, never the id, is what says whose a blob is.
/** Sixteen random bytes as hex (D1). */
export function newBlobId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const BLOB_ID = /^[a-f0-9]{32}$/;
export const isBlobId = (id: string): boolean => BLOB_ID.test(id);

/** The object key (D1). The prefix is the ownership: a room reads under its own and nothing else. */
export const blobKey = (sessionId: string, id: string): string => `rooms/${sessionId}/${id}`;

/**
 * The bytes charged to this room so far, 0 for a room never charged. The
 * Durable Objects store lifts the field to 0 in `hydrateStoredSession`; the
 * in-memory store does not hydrate, so this reads through `?? 0` as
 * `surfaceCursor` does.
 */
export const blobBytesUsed = (s: StoredSession): number => s.blobBytes ?? 0;

/** The object's metadata, as the store reports it. `etag` is the store's own. */
export interface BlobMeta {
  bytes: number;
  type: string;
  name: string;
  /** The uploading member's handle. */
  by: string;
  at: number;
  /** Quoted, as an HTTP ETag is. */
  etag: string;
}

export interface BlobObject extends BlobMeta {
  body: ReadableStream<Uint8Array>;
}

/** What a put supplies: everything but the etag, which the store sets. */
export type BlobPut = Omit<BlobMeta, "etag">;

/** What a read answers: the object, a precondition that held, or nothing. */
export type BlobRead = BlobObject | { unchanged: true; etag: string } | null;

/**
 * The storage boundary for bytes (spec D5), keyed by room and id so a foreign
 * room's id resolves nowhere. Two implementations: `MemoryBlobStore` below for
 * tests and `npm start`, `R2BlobStore` in blobs-r2.ts for production. The
 * contract suite in tests/helpers/blob-store-contract.ts runs against both.
 */
export interface BlobStore {
  /**
   * Store `body` under this room and id. `meta.bytes` is the length the body
   * must have: a body that ends short or runs long is refused with a
   * `BlobLengthError` and nothing is stored, so an object that exists is exactly
   * as long as its metadata says — and the route, which maps that one class to
   * 400, can say so over either store.
   */
  put(sessionId: string, id: string, body: ReadableStream<Uint8Array> | ArrayBuffer, meta: BlobPut): Promise<void>;
  head(sessionId: string, id: string): Promise<BlobMeta | null>;
  /** With `ifNoneMatch`, the request's If-None-Match as sent; a match answers `{ unchanged, etag }`. */
  get(sessionId: string, id: string, ifNoneMatch?: string): Promise<BlobRead>;
  /** Idempotent: deleting nothing is not an error. */
  delete(sessionId: string, id: string): Promise<void>;
}

/** A body whose length is not the one declared. The route answers 400 from it. */
export class BlobLengthError extends Error {
  constructor(readonly expected: number, readonly got: number) {
    super(`body did not match Content-Length: ${expected} bytes declared, ${got} received`);
  }
}

/**
 * Up to `n` leading bytes, and the body again with nothing missing. The route
 * reads a head to sniff an image claim (D6), then hands `rest` — every chunk
 * read so far, then the remainder — to the store, so nothing is buffered beyond
 * the first chunk the runtime delivered.
 */
export async function readHead(
  body: ReadableStream<Uint8Array>,
  n: number,
): Promise<{ head: Uint8Array; rest: ReadableStream<Uint8Array> }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let have = 0;
  while (have < n) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    have += value.byteLength;
  }
  const joined = new Uint8Array(have);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  let replayed = false;
  const rest = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!replayed) {
        replayed = true;
        if (joined.byteLength > 0) {
          controller.enqueue(joined);
          return;
        }
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return { head: joined.subarray(0, n), rest };
}

/**
 * The body again, erroring with `BlobLengthError` the moment it is known not to
 * be `expected` bytes: when a chunk takes it past, and when it ends short. The
 * one place the length rule lives. `readExactly` reads through it for the
 * in-memory store, and `R2BlobStore` pipes it into R2's `FixedLengthStream`
 * (which gives R2 the length it needs, and which this runs ahead of), so both
 * stores refuse the same bodies with the same class and the route needs one
 * line to answer 400 for either.
 */
export function exactLength(body: ReadableStream<Uint8Array>, expected: number): ReadableStream<Uint8Array> {
  let received = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > expected) throw new BlobLengthError(expected, received);
        controller.enqueue(chunk);
      },
      flush() {
        if (received !== expected) throw new BlobLengthError(expected, received);
      },
    }),
  );
}

/** The whole body, refusing one whose length is not `expected`. */
export async function readExactly(
  body: ReadableStream<Uint8Array> | ArrayBuffer,
  expected: number,
): Promise<Uint8Array> {
  if (body instanceof ArrayBuffer) {
    if (body.byteLength !== expected) throw new BlobLengthError(expected, body.byteLength);
    return new Uint8Array(body);
  }
  // `exactLength` guarantees the chunks add up to `expected`, so `out` never overflows
  // and a short body rejects here rather than coming back zero-padded.
  const out = new Uint8Array(expected);
  let filled = 0;
  const reader = exactLength(body, expected).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.set(value, filled);
    filled += value.byteLength;
  }
}

/** A quoted SHA-256 of the bytes: stable, comparable, and shaped like the ETag R2 reports. */
async function contentEtag(bytes: Uint8Array): Promise<string> {
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
  return `"${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
}

/** If-None-Match as HTTP reads it: `*`, or a list of tags, a weak one compared by value. */
function etagMatches(header: string, etag: string): boolean {
  if (header.trim() === "*") return true;
  const strip = (t: string) => t.trim().replace(/^W\//, "");
  return header.split(",").some((t) => strip(t) === strip(etag));
}

/**
 * The in-memory blob store. Bytes are copied on the way in and out, as
 * MemoryStore detaches what it hands back: a caller that kept its buffer must
 * not be able to rewrite what was stored.
 */
export class MemoryBlobStore implements BlobStore {
  private objects = new Map<string, { bytes: Uint8Array; meta: BlobMeta }>();

  async put(sessionId: string, id: string, body: ReadableStream<Uint8Array> | ArrayBuffer, meta: BlobPut): Promise<void> {
    const bytes = await readExactly(body, meta.bytes);
    const etag = await contentEtag(bytes);
    this.objects.set(blobKey(sessionId, id), { bytes: bytes.slice(), meta: { ...meta, etag } });
  }

  async head(sessionId: string, id: string): Promise<BlobMeta | null> {
    const object = this.objects.get(blobKey(sessionId, id));
    return object ? { ...object.meta } : null;
  }

  async get(sessionId: string, id: string, ifNoneMatch?: string): Promise<BlobRead> {
    const object = this.objects.get(blobKey(sessionId, id));
    if (!object) return null;
    if (ifNoneMatch !== undefined && etagMatches(ifNoneMatch, object.meta.etag)) {
      return { unchanged: true, etag: object.meta.etag };
    }
    const copy = object.bytes.slice();
    return {
      ...object.meta,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(copy);
          controller.close();
        },
      }),
    };
  }

  async delete(sessionId: string, id: string): Promise<void> {
    this.objects.delete(blobKey(sessionId, id));
  }
}
