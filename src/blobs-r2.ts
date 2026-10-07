/// <reference types="@cloudflare/workers-types" />
import {
  BlobLengthError, OCTET_STREAM, blobKey, exactLength,
  type BlobMeta, type BlobPut, type BlobRead, type BlobStore,
} from "./blobs.js";

/**
 * The R2 half of the blob seam (#183, spec D1): one bucket, keyed
 * `rooms/<sessionId>/<id>`, the object's own metadata as the metadata —
 * `httpMetadata.contentType` as decided at upload, `customMetadata` carrying
 * the name, the uploading member and the time. No row anywhere describes a
 * blob: the one that holds the bytes is the one that cannot lie about them.
 *
 * Workers-only, and excluded from the Node build as store-do.ts is:
 * `FixedLengthStream` and the R2 types exist only in workerd. The root test
 * program runs the same contract over MemoryBlobStore; worker-tests runs it here.
 */
export class R2BlobStore implements BlobStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(sessionId: string, id: string, body: ReadableStream<Uint8Array> | ArrayBuffer, meta: BlobPut): Promise<void> {
    const key = blobKey(sessionId, id);
    const options: R2PutOptions = {
      httpMetadata: { contentType: meta.type },
      // Strings only: that is what customMetadata holds.
      customMetadata: { name: meta.name, by: meta.by, at: String(meta.at) },
    };
    if (body instanceof ArrayBuffer) {
      // R2 would store a buffer of any length happily; an object is exactly as long as its metadata says.
      if (body.byteLength !== meta.bytes) throw new BlobLengthError(meta.bytes, body.byteLength);
      await this.bucket.put(key, body, options);
      return;
    }
    // R2 streams a body in only when it knows the length — "Provided readable
    // stream must have a known length" otherwise. A request body qualifies; the
    // stream the route rebuilt after reading its first bytes (readHead) does
    // not, so the body goes through a FixedLengthStream, which gives R2 its
    // length. The length RULE is not the FixedLengthStream's: it errors with its
    // own TypeError, which cannot be told from any other failure of the put.
    // `exactLength` runs ahead of it and errors with BlobLengthError first, and
    // the two halves are settled together so that error is the one thrown — the
    // class the route maps to 400 — and neither rejection is left unhandled.
    const fixed = new FixedLengthStream(meta.bytes);
    const [stored, piped] = await Promise.allSettled([
      this.bucket.put(key, fixed.readable, options),
      exactLength(body, meta.bytes).pipeTo(fixed.writable),
    ]);
    if (piped.status === "rejected" && piped.reason instanceof BlobLengthError) throw piped.reason;
    if (stored.status === "rejected") throw stored.reason;
    if (piped.status === "rejected") throw piped.reason;
  }

  async head(sessionId: string, id: string): Promise<BlobMeta | null> {
    const object = await this.bucket.head(blobKey(sessionId, id));
    return object ? metaOf(object) : null;
  }

  async get(sessionId: string, id: string, ifNoneMatch?: string): Promise<BlobRead> {
    const key = blobKey(sessionId, id);
    // The request's header as sent: R2 evaluates If-None-Match itself, weak
    // tags and lists included, which is why the store takes the raw value.
    // Asserted, not inferred: the conditional's branches are subtype-reduced to
    // `R2Object`, and `"body" in object` would then leave `body` as `unknown`.
    const object = (ifNoneMatch === undefined
      ? await this.bucket.get(key)
      : await this.bucket.get(key, { onlyIf: new Headers({ "if-none-match": ifNoneMatch }) })
    ) as R2ObjectBody | R2Object | null;
    if (!object) return null;
    // A precondition that held comes back as the object without a body.
    if (!("body" in object)) return { unchanged: true, etag: object.httpEtag };
    return { ...metaOf(object), body: object.body };
  }

  async delete(sessionId: string, id: string): Promise<void> {
    await this.bucket.delete(blobKey(sessionId, id));
  }
}

function metaOf(object: R2Object): BlobMeta {
  return {
    bytes: object.size,
    type: object.httpMetadata?.contentType ?? OCTET_STREAM,
    name: object.customMetadata?.name ?? "",
    by: object.customMetadata?.by ?? "",
    at: Number(object.customMetadata?.at ?? 0),
    etag: object.httpEtag,
  };
}
