/**
 * Conformance suite for the BlobStore seam (#183). Every implementation passes
 * it identically: MemoryBlobStore under the root program (tests/blob-store.test.ts),
 * R2BlobStore inside workerd with a real R2 binding
 * (worker-tests/blob-store-contract.test.ts). A divergence between them shows up
 * here rather than in production.
 *
 * Every case uses a session id of its own, so isolation does not depend on the
 * worker pool's `reset()` emptying the bucket between cases.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { BlobLengthError, type BlobMeta, type BlobStore } from "../../src/blobs.js";
import { drain, stream, text } from "./blob-bytes.js";

const meta = (bytes: number, over: Partial<Omit<BlobMeta, "etag">> = {}) => ({
  bytes, type: "text/markdown", name: "notes.md", by: "m_creator", at: 1_700_000_000_000, ...over,
});

export function describeBlobStoreContract(name: string, makeStore: () => BlobStore): void {
  describe(`BlobStore contract: ${name}`, () => {
    let store: BlobStore;
    let sid: string;
    let n = 0;

    beforeEach(() => {
      store = makeStore();
      sid = `qs_blob_${Date.now().toString(36)}_${n++}`;
    });

    it("answers nothing for a blob never put", async () => {
      expect(await store.head(sid, "0123456789abcdef0123456789abcdef")).toBeNull();
      expect(await store.get(sid, "0123456789abcdef0123456789abcdef")).toBeNull();
    });

    it("put then head returns the metadata, with the store's own etag", async () => {
      await store.put(sid, "aa".repeat(16), stream(text("# notes\n")), meta(8));
      const head = await store.head(sid, "aa".repeat(16));
      expect(head).toMatchObject({ bytes: 8, type: "text/markdown", name: "notes.md", by: "m_creator", at: 1_700_000_000_000 });
      expect(head!.etag).toEqual(expect.any(String));
      expect(head!.etag.length).toBeGreaterThan(2);
    });

    it("get streams the bytes back with the same metadata", async () => {
      const data = text("0123456789abcdefghij");
      await store.put(sid, "bb".repeat(16), stream(data, 7), meta(20, { type: "application/pdf", name: "x.pdf" }));
      const head = (await store.head(sid, "bb".repeat(16)))!;
      const got = await store.get(sid, "bb".repeat(16));
      if (got === null || "unchanged" in got) throw new Error(`expected the object, got ${JSON.stringify(got)}`);
      expect(await drain(got.body)).toEqual(data);
      expect(got).toMatchObject({ bytes: 20, type: "application/pdf", name: "x.pdf", etag: head.etag });
    });

    it("stores an ArrayBuffer body like a stream", async () => {
      await store.put(sid, "cc".repeat(16), text("buffer").buffer as ArrayBuffer, meta(6));
      const got = await store.get(sid, "cc".repeat(16));
      if (got === null || "unchanged" in got) throw new Error("expected the object");
      expect(await drain(got.body)).toEqual(text("buffer"));
    });

    /** D1: the prefix is the ownership. */
    it("does not resolve a foreign room's id, for head, get or delete", async () => {
      await store.put(sid, "dd".repeat(16), stream(text("mine")), meta(4));
      expect(await store.head(`${sid}_other`, "dd".repeat(16))).toBeNull();
      expect(await store.get(`${sid}_other`, "dd".repeat(16))).toBeNull();
      await store.delete(`${sid}_other`, "dd".repeat(16));
      expect(await store.head(sid, "dd".repeat(16))).not.toBeNull();
    });

    it("delete then head is null, and deleting nothing is a no-op", async () => {
      await store.put(sid, "ee".repeat(16), stream(text("gone")), meta(4));
      await store.delete(sid, "ee".repeat(16));
      expect(await store.head(sid, "ee".repeat(16))).toBeNull();
      expect(await store.get(sid, "ee".repeat(16))).toBeNull();
      await store.delete(sid, "ee".repeat(16));
    });

    it("answers unchanged for the current etag, and the bytes for any other", async () => {
      await store.put(sid, "ff".repeat(16), stream(text("same")), meta(4));
      const { etag } = (await store.head(sid, "ff".repeat(16)))!;
      expect(await store.get(sid, "ff".repeat(16), etag)).toEqual({ unchanged: true, etag });
      const other = await store.get(sid, "ff".repeat(16), '"not-this-one"');
      if (other === null || "unchanged" in other) throw new Error("a non-matching tag must answer the object");
      expect(await drain(other.body)).toEqual(text("same"));
    });

    // Review Focus 1: an object that exists is exactly as long as its metadata says, and the
    // refusal is the one class the route maps to 400 — over R2 as over memory.
    it("refuses a body whose length is not the declared one, with BlobLengthError, and stores nothing", async () => {
      const refusal = async (id: string, body: ReadableStream<Uint8Array> | ArrayBuffer, declared: number) => {
        const error = await store.put(sid, id, body, meta(declared)).then(() => null, (e: unknown) => e);
        expect(error, "the put must be refused").toBeInstanceOf(BlobLengthError);
        expect(error).toMatchObject({ expected: declared });
        expect(await store.head(sid, id), "and store nothing").toBeNull();
      };
      await refusal("11".repeat(16), stream(text("short")), 10);
      await refusal("22".repeat(16), stream(text("too long")), 3);
      await refusal("33".repeat(16), text("buf").buffer as ArrayBuffer, 4);
    });

    it("replaces an object put again under the same id", async () => {
      await store.put(sid, "44".repeat(16), stream(text("one")), meta(3));
      await store.put(sid, "44".repeat(16), stream(text("two!")), meta(4, { name: "two.txt" }));
      expect(await store.head(sid, "44".repeat(16))).toMatchObject({ bytes: 4, name: "two.txt" });
    });
  });
}
