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
      // Strings only: that is what customMetadata holds, and they travel as HTTP header values. The local
      // simulator takes any string where the service may not, so what is stored is ASCII: the name is
      // percent-encoded here and decoded in `metaOf`. `by` and `at` are ASCII already.
      customMetadata: { name: encodeURIComponent(meta.name), by: meta.by, at: String(meta.at) },
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
    // length.
    //
    // The length RULE is neither the FixedLengthStream's nor R2's: a body of the
    // wrong length makes the put fail with a plain Error, the message without the
    // class, which cannot be told from any other failure of the put. So the class
    // comes from the pipe. `exactLength` runs ahead of the FixedLengthStream and
    // errors with BlobLengthError first; the put and the pipe are settled together,
    // so neither rejection is left unhandled; and the pipe's own BlobLengthError is
    // rethrown ahead of R2's rejection. That is the class the route maps to 400, so
    // its `instanceof` holds over R2 as it does over memory, and the route counts
    // nothing itself.
    //
    // A refused body stores nothing. R2 commits a put the moment it holds the
    // length it was told and reports the stream's failure only after, so a body that
    // delivers exactly `meta.bytes` and then runs on is stored while its put still
    // rejects. Whenever the pipe objected, then, the key is deleted before the error
    // is thrown, whatever the put said. (An id is fresh for every upload, so there
    // is no earlier object under it to lose.)
    const fixed = new FixedLengthStream(meta.bytes);
    const [stored, piped] = await Promise.allSettled([
      this.bucket.put(key, fixed.readable, options),
      exactLength(body, meta.bytes).pipeTo(fixed.writable),
    ]);
    if (piped.status === "rejected") {
      await this.bucket.delete(key).catch((err: unknown) => {
        console.error(`orphaned blob ${key} after a refused body:`, err);
      });
    }
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

  async list(sessionId: string): Promise<{ id: string; bytes: number }[]> {
    const prefix = blobKey(sessionId, "");
    const out: { id: string; bytes: number }[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix, cursor, limit: 1000 });
      for (const o of page.objects) out.push({ id: o.key.slice(prefix.length), bytes: o.size });
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return out;
  }

  async deleteAll(sessionId: string): Promise<number> {
    const prefix = blobKey(sessionId, "");
    let removed = 0;
    for (;;) {
      const page = await this.bucket.list({ prefix, limit: 1000 });
      if (page.objects.length === 0) return removed;
      await this.bucket.delete(page.objects.map((o) => o.key));
      removed += page.objects.length;
    }
  }
}

function metaOf(object: R2Object): BlobMeta {
  return {
    bytes: object.size,
    type: object.httpMetadata?.contentType ?? OCTET_STREAM,
    name: decodeURIComponent(object.customMetadata?.name ?? ""),
    by: object.customMetadata?.by ?? "",
    at: Number(object.customMetadata?.at ?? 0),
    etag: object.httpEtag,
  };
}
